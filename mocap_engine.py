"""
mocap_engine.py - High-Precision Python Video Motion Capture Engine for Web Blender Studio.

Upgraded Full-Video & Anti-Distortion Pipeline:
- Full-video support (max_frames <= 0 or None processes 100% of video frames).
- Automatic high-res downscaling (caps inference input to 640px max dimension)
  for 5x-8x faster processing on 1080p/4K videos while keeping 2D landmarks in
  native video resolution.
- Real-time progress tracking (get_progress()) for UI progress bars & ETA.
- 1:1 timeline continuity: frames with missing/low-confidence detections (such
  as dark fade-ins) are interpolated cleanly instead of dropping timestamps or
  anchoring to hallucinated poses.
- Metric 3D root displacement (midHip) reconstructed from 2D normalized hip
  trajectory scaled by the subject's metric-to-pixel torso/leg ratio.
- Direction-preserving bone-length normalization (computes unit limb directions
  before enforcing canonical median bone lengths so child angles are never skewed).
"""

import os
import sys
import time
import math
import threading
import cv2
import numpy as np

try:
    import mediapipe as mp
    from mediapipe.tasks import python as mp_python
    from mediapipe.tasks.python import vision
    MEDIAPIPE_AVAILABLE = True
except ImportError:
    MEDIAPIPE_AVAILABLE = False


MODEL_CANDIDATES = [
    'pose_landmarker_heavy.task',
    'pose_landmarker_full.task',
    'pose_landmarker_lite.task',
]


def normalize(v):
    norm = np.linalg.norm(v)
    if norm < 1e-6:
        return np.array([0.0, 1.0, 0.0], dtype=np.float32)
    return v / norm


class OneEuroFilter:
    """Adaptive low-pass filter (Casiez et al. 2012).
    Removes jitter on slow motion without lagging fast dance movements."""

    def __init__(self, freq=30.0, min_cutoff=1.2, beta=0.05, d_cutoff=1.0):
        self.freq = max(1.0, float(freq))
        self.min_cutoff = max(0.05, float(min_cutoff))
        self.beta = max(0.0, float(beta))
        self.d_cutoff = max(0.05, float(d_cutoff))
        self.x_prev = None
        self.dx_prev = None

    @staticmethod
    def _alpha(cutoff, freq):
        te = 1.0 / max(1.0, freq)
        tau = 1.0 / (2 * math.pi * np.maximum(1e-4, cutoff))
        return 1.0 / (1.0 + tau / te)

    def filter(self, x, freq=None):
        freq = max(1.0, float(freq or self.freq))
        if self.x_prev is None:
            self.x_prev = x.copy()
            self.dx_prev = np.zeros_like(x)
            return x.copy()
        dx = (x - self.x_prev) * freq
        a_d = self._alpha(self.d_cutoff, freq)
        dx_hat = a_d * dx + (1.0 - a_d) * self.dx_prev
        cutoff = self.min_cutoff + self.beta * np.abs(dx_hat)
        a = self._alpha(cutoff, freq)
        x_hat = a * x + (1.0 - a) * self.x_prev
        self.x_prev = x_hat
        self.dx_prev = dx_hat
        return x_hat


class VideoMocapEngine:
    SKELETON_JOINTS = (
        'nose',
        'leftShoulder', 'rightShoulder',
        'leftElbow', 'rightElbow',
        'leftWrist', 'rightWrist',
        'leftHandIndex', 'rightHandIndex',
        'leftHip', 'rightHip',
        'leftKnee', 'rightKnee',
        'leftAnkle', 'rightAnkle',
        'leftFoot', 'rightFoot',
    )

    BONE_CHAINS = [
        # Upper body chains (topological order: parent -> child)
        ('leftShoulder', 'leftElbow'),
        ('leftElbow', 'leftWrist'),
        ('leftWrist', 'leftHandIndex'),
        ('rightShoulder', 'rightElbow'),
        ('rightElbow', 'rightWrist'),
        ('rightWrist', 'rightHandIndex'),
        # Lower body chains (topological order: parent -> child)
        ('leftHip', 'leftKnee'),
        ('leftKnee', 'leftAnkle'),
        ('leftAnkle', 'leftFoot'),
        ('rightHip', 'rightKnee'),
        ('rightKnee', 'rightAnkle'),
        ('rightAnkle', 'rightFoot'),
    ]

    def __init__(self, model_path=None):
        base_dir = os.path.dirname(os.path.abspath(__file__))
        if model_path is None:
            for name in MODEL_CANDIDATES:
                cand = os.path.join(base_dir, 'models', name)
                if os.path.exists(cand):
                    model_path = cand
                    break
            if model_path is None:
                model_path = os.path.join(base_dir, 'models', 'pose_landmarker_lite.task')
        self.model_path = model_path
        self.detector = None
        self._lock = threading.Lock()
        self._run_lock = threading.Lock()
        self._progress = {
            "active": False,
            "stage": "idle",
            "processed": 0,
            "total": 0,
            "percent": 0.0,
            "fps": 0.0,
            "etaSec": 0.0,
            "videoPath": "",
        }

    def get_progress(self):
        with self._lock:
            return dict(self._progress)

    def _update_progress(self, **kwargs):
        with self._lock:
            self._progress.update(kwargs)

    def _create_detector(self):
        """Instantiate an isolated VIDEO PoseLandmarker per job (prevents C++ UAF & state leaks)."""
        if not MEDIAPIPE_AVAILABLE or not os.path.exists(self.model_path):
            return None
        base_options = mp_python.BaseOptions(model_asset_path=self.model_path)
        options = vision.PoseLandmarkerOptions(
            base_options=base_options,
            min_pose_detection_confidence=0.5,
            min_pose_presence_confidence=0.5,
            min_tracking_confidence=0.55,
            output_segmentation_masks=False,
            running_mode=vision.RunningMode.VIDEO,
        )
        return vision.PoseLandmarker.create_from_options(options)

    def _init_detector(self):
        """Backwards-compatible helper if caller inspects engine.detector."""
        self.detector = self._create_detector()
        if self.detector is not None:
            print(f"[MocapEngine] Detector ready (VIDEO mode, model={os.path.basename(self.model_path)})", file=sys.stderr, flush=True)

    # ------------------------------------------------------------------ #
    def process_video(self, video_path, max_frames=0, frame_step=1,
                      min_cutoff=1.35, beta=0.04, max_infer_dim=640):
        """
        Processes video and extracts high-precision 3D skeletal motion keyframes.
        Serialized with a per-instance lock and per-job local PoseLandmarker so concurrent
        or aborted runs cannot race or reuse stale MediaPipe state.
        """
        with self._run_lock:
            return self._process_video_locked(
                video_path,
                max_frames=max_frames,
                frame_step=frame_step,
                min_cutoff=min_cutoff,
                beta=beta,
                max_infer_dim=max_infer_dim,
            )

    def _process_video_locked(self, video_path, max_frames=0, frame_step=1,
                              min_cutoff=1.35, beta=0.04, max_infer_dim=640):
        cap = cv2.VideoCapture(video_path)
        if not cap.isOpened():
            return {"success": False, "error": f"Cannot open video: {video_path}"}
        detector = self.detector if self.detector is not None else self._create_detector()
        owns_detector = (detector is not None) and (detector is not self.detector)

        video_fps = float(cap.get(cv2.CAP_PROP_FPS) or 30.0)
        if video_fps <= 1.0 or video_fps > 240.0 or math.isnan(video_fps):
            video_fps = 30.0
        total_video_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
        w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH) or 1280)
        h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT) or 720)
        frame_step = max(1, int(frame_step or 1))
        eff_fps = video_fps / frame_step

        is_full_video = (max_frames is None) or (int(max_frames) <= 0)
        expected_sampled = (
            max(1, (total_video_frames + frame_step - 1) // frame_step)
            if total_video_frames > 0 else 300
        )
        target_frames = expected_sampled if is_full_video else min(int(max_frames), expected_sampled)

        # Downscale factor for fast inference on high-res (1080p / 4K) videos
        max_dim = max(w, h)
        infer_scale = (max_infer_dim / float(max_dim)) if max_dim > max_infer_dim else 1.0
        infer_w = max(64, int(round(w * infer_scale)))
        infer_h = max(64, int(round(h * infer_scale)))

        self._update_progress(
            active=True,
            stage="tracking",
            processed=0,
            total=target_frames,
            percent=0.0,
            fps=0.0,
            etaSec=0.0,
            videoPath=os.path.basename(video_path),
        )
        t_start = time.monotonic()

        times = []
        raw_series = []          # per-frame dict of joint -> np.array (or None if not detected)
        vis_series = []          # per-frame dict of joint -> visibility 0..1
        hip2d_series = []        # per-frame np.array([cx_norm, cy_norm, torso_px_norm, conf])
        landmarks_2d_series = []

        frame_idx = 0
        processed_count = 0
        valid_detections = 0
        last_ts_ms = -1
        eof_reached = False

        try:
            while cap.isOpened() and (is_full_video or processed_count < int(max_frames)):
                if frame_idx % frame_step != 0:
                    if not cap.grab():
                        eof_reached = True
                        break
                    frame_idx += 1
                    continue

                ret, frame = cap.read()
                if not ret:
                    eof_reached = True
                    break

                pos_ms = float(cap.get(cv2.CAP_PROP_POS_MSEC) or 0.0)
                calc_ms = (frame_idx * 1000.0) / video_fps
                # Use container PTS if plausible, otherwise frame_idx / fps
                raw_ms = pos_ms if (pos_ms > 0.0 and abs(pos_ms - calc_ms) < 2500.0) else calc_ms
                ts_ms = int(round(raw_ms))
                if ts_ms <= last_ts_ms:
                    ts_ms = last_ts_ms + max(1, int(round(1000.0 / video_fps)))
                last_ts_ms = ts_ms

                if infer_scale < 0.999:
                    small = cv2.resize(frame, (infer_w, infer_h), interpolation=cv2.INTER_AREA)
                    rgb = cv2.cvtColor(small, cv2.COLOR_BGR2RGB)
                else:
                    rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)

                mp_img = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb)
                res = None
                if detector:
                    try:
                        res = detector.detect_for_video(mp_img, ts_ms)
                    except Exception as e:
                        print(f"[MocapEngine] detect error @frame {frame_idx}: {e}", file=sys.stderr, flush=True)

                frame_time = float(round(ts_ms / 1000.0, 4)) if frame_idx > 0 else 0.0
                times.append(frame_time)

                has_valid_pose = False
                if res and res.pose_world_landmarks and len(res.pose_world_landmarks) > 0:
                    wlm = res.pose_world_landmarks[0]
                    slm = res.pose_landmarks[0] if (res.pose_landmarks and len(res.pose_landmarks) > 0) else None

                    def gp(idx):
                        p = wlm[idx]
                        return np.array([float(p.x), float(-p.y), float(-p.z)], dtype=np.float32)

                    def vis(idx):
                        v_w = float(getattr(wlm[idx], 'visibility', 1.0))
                        if slm is not None:
                            v_s = float(getattr(slm[idx], 'visibility', v_w))
                            return min(v_w, v_s)
                        return v_w

                    # Gate out dark fade-in / garbage frames where core torso is invisible
                    core_vis = 0.25 * (vis(11) + vis(12) + vis(23) + vis(24))
                    if core_vis >= 0.35:
                        has_valid_pose = True
                        valid_detections += 1
                        joints = {
                            'nose': gp(0),
                            'leftShoulder': gp(11), 'rightShoulder': gp(12),
                            'leftElbow': gp(13), 'rightElbow': gp(14),
                            'leftWrist': gp(15), 'rightWrist': gp(16),
                            'leftHandIndex': gp(19), 'rightHandIndex': gp(20),
                            'leftHip': gp(23), 'rightHip': gp(24),
                            'leftKnee': gp(25), 'rightKnee': gp(26),
                            'leftAnkle': gp(27), 'rightAnkle': gp(28),
                            'leftFoot': gp(31), 'rightFoot': gp(32),
                        }
                        visibs = {
                            'nose': vis(0),
                            'leftShoulder': vis(11), 'rightShoulder': vis(12),
                            'leftElbow': vis(13), 'rightElbow': vis(14),
                            'leftWrist': vis(15), 'rightWrist': vis(16),
                            'leftHandIndex': vis(19), 'rightHandIndex': vis(20),
                            'leftHip': vis(23), 'rightHip': vis(24),
                            'leftKnee': vis(25), 'rightKnee': vis(26),
                            'leftAnkle': vis(27), 'rightAnkle': vis(28),
                            'leftFoot': vis(31), 'rightFoot': vis(32),
                        }
                        raw_series.append(joints)
                        vis_series.append(visibs)

                        frame_2d = []
                        if slm:
                            for i in range(len(slm)):
                                frame_2d.append([
                                    round(slm[i].x * w, 1),
                                    round(slm[i].y * h, 1),
                                    round(float(getattr(slm[i], 'visibility', 1.0)), 2)
                                ])
                            hx = 0.5 * (slm[23].x + slm[24].x)
                            hy = 0.5 * (slm[23].y + slm[24].y)
                            sx = 0.5 * (slm[11].x + slm[12].x)
                            sy = 0.5 * (slm[11].y + slm[12].y)
                            torso_px = math.hypot((sx - hx) * w, (sy - hy) * h)
                            hip2d_series.append(np.array([hx * w, hy * h, torso_px, core_vis], dtype=np.float32))
                        else:
                            hip2d_series.append(np.array([w * 0.5, h * 0.5, 0.0, 0.0], dtype=np.float32))
                        landmarks_2d_series.append(frame_2d)

                if not has_valid_pose:
                    raw_series.append(None)
                    vis_series.append({k: 0.0 for k in self.SKELETON_JOINTS})
                    hip2d_series.append(np.array([w * 0.5, h * 0.5, 0.0, 0.0], dtype=np.float32))
                    landmarks_2d_series.append([])

                processed_count += 1
                frame_idx += 1

                if processed_count % 5 == 0 or processed_count == target_frames:
                    elapsed = max(1e-3, time.monotonic() - t_start)
                    proc_fps = processed_count / elapsed
                    total_est = max(processed_count, target_frames)
                    rem = max(0, total_est - processed_count)
                    pct = min(99.0, (processed_count / max(1, total_est)) * 100.0)
                    self._update_progress(
                        processed=processed_count,
                        total=total_est,
                        percent=round(pct, 1),
                        fps=round(proc_fps, 1),
                        etaSec=round(rem / max(0.1, proc_fps), 1),
                    )
        finally:
            cap.release()
            if detector:
                try:
                    detector.close()
                except Exception:
                    pass
                if not owns_detector:
                    self.detector = None

        if valid_detections == 0:
            self._update_progress(active=False, stage="error", percent=0.0)
            return {"success": False, "error": "No human pose detected in video"}

        self._update_progress(stage="filtering", percent=99.0)

        # -------- 1. Fill missing frames & low-visibility joints by interpolation
        raw_series = self._interpolate_gaps(raw_series, vis_series, vis_threshold=0.42)
        landmarks_2d_series = self._interpolate_2d_landmarks(landmarks_2d_series)

        # -------- 2. Reconstruct metric 3D root trajectory from 2D hip center
        root_offsets = self._compute_metric_root_trajectory(raw_series, hip2d_series, eff_fps)

        # -------- 3. Re-center raw joints around local midHip = (0,0,0), filter,
        #             and enforce constant bone lengths without corrupting directions.
        for fr in raw_series:
            hip_center = 0.5 * (fr['leftHip'] + fr['rightHip'])
            for k in list(fr.keys()):
                fr[k] = fr[k] - hip_center

        filters = {
            k: OneEuroFilter(freq=eff_fps, min_cutoff=min_cutoff, beta=beta)
            for k in self.SKELETON_JOINTS
        }
        smoothed_series = []
        for fr in raw_series:
            sm = {}
            for k in self.SKELETON_JOINTS:
                sm[k] = filters[k].filter(fr[k], freq=eff_fps)
            smoothed_series.append(sm)

        # Enforce constant bone lengths while strictly preserving limb directions
        smoothed_series = self._enforce_bone_lengths(smoothed_series)

        # Recompute derived torso joints & add metric root offset
        mocap_frames = []
        for sm, root_off, t in zip(smoothed_series, root_offsets, times):
            mid_hip_local = 0.5 * (sm['leftHip'] + sm['rightHip'])
            mid_sh_local = 0.5 * (sm['leftShoulder'] + sm['rightShoulder'])
            spine_local = mid_hip_local + (mid_sh_local - mid_hip_local) * 0.65
            neck_local = mid_sh_local

            def with_root(vec):
                return [float(round(float(vec[j] + root_off[j]), 5)) for j in range(3)]

            mocap_frames.append({
                'time': t,
                'midHip': with_root(mid_hip_local),
                'spine': with_root(spine_local),
                'neck': with_root(neck_local),
                'nose': with_root(sm['nose']),
                'leftShoulder': with_root(sm['leftShoulder']),
                'leftElbow': with_root(sm['leftElbow']),
                'leftWrist': with_root(sm['leftWrist']),
                'leftHandIndex': with_root(sm['leftHandIndex']),
                'rightShoulder': with_root(sm['rightShoulder']),
                'rightElbow': with_root(sm['rightElbow']),
                'rightWrist': with_root(sm['rightWrist']),
                'rightHandIndex': with_root(sm['rightHandIndex']),
                'leftHip': with_root(sm['leftHip']),
                'leftKnee': with_root(sm['leftKnee']),
                'leftAnkle': with_root(sm['leftAnkle']),
                'leftFoot': with_root(sm['leftFoot']),
                'rightHip': with_root(sm['rightHip']),
                'rightKnee': with_root(sm['rightKnee']),
                'rightAnkle': with_root(sm['rightAnkle']),
                'rightFoot': with_root(sm['rightFoot']),
            })

        duration = times[-1] if times else 0.0
        if eof_reached or is_full_video or total_video_frames <= 0:
            total_video_frames = frame_idx
            total_video_duration = duration
            coverage_pct = 100.0
        else:
            total_video_duration = max(duration, total_video_frames / video_fps)
            coverage_pct = min(100.0, round(((processed_count * frame_step) / max(1, total_video_frames)) * 100.0, 1))

        self._update_progress(
            active=False,
            stage="done",
            processed=processed_count,
            total=processed_count,
            percent=100.0,
            etaSec=0.0,
        )

        return {
            "success": True,
            "fps": float(round(eff_fps, 3)),
            "videoFps": float(round(video_fps, 3)),
            "duration": float(round(duration, 4)),
            "totalVideoDuration": float(round(total_video_duration, 4)),
            "numFrames": len(times),
            "totalVideoFrames": total_video_frames,
            "frameStep": frame_step,
            "isFullVideo": bool(is_full_video or eof_reached or coverage_pct >= 98.0),
            "coveragePct": coverage_pct,
            "videoWidth": w,
            "videoHeight": h,
            "landmarks2D": landmarks_2d_series,
            "mocapFrames": mocap_frames,
        }

    # ------------------------------------------------------------------ #
    def _interpolate_gaps(self, raw_series, vis_series, vis_threshold=0.42):
        """Fill None frames and replace joints whose visibility < threshold by
        linear interpolation between neighbouring confident frames."""
        n = len(raw_series)
        first_valid = next((fr for fr in raw_series if fr is not None), None)
        if first_valid is None:
            return raw_series

        # Ensure every frame has a dict
        for i in range(n):
            if raw_series[i] is None:
                raw_series[i] = {k: v.copy() for k, v in first_valid.items()}

        for key in self.SKELETON_JOINTS:
            bad = [i for i in range(n) if vis_series[i].get(key, 0.0) < vis_threshold]
            if not bad or len(bad) == n:
                continue
            runs = []
            start = prev = bad[0]
            for i in bad[1:]:
                if i == prev + 1:
                    prev = i
                else:
                    runs.append((start, prev))
                    start = prev = i
            runs.append((start, prev))

            for (a, b) in runs:
                left = a - 1
                right = b + 1
                va = raw_series[left][key] if left >= 0 else None
                vb = raw_series[right][key] if right < n else None
                if va is None and vb is None:
                    continue
                if va is None:
                    va = vb
                if vb is None:
                    vb = va
                span = (right - left) if (right < n and left >= 0) else max(1, b - a + 1)
                for i in range(a, b + 1):
                    t = ((i - left) / max(1, span)) if (left >= 0 and right < n) else 0.0
                    raw_series[i][key] = va * (1.0 - t) + vb * t
        return raw_series

    def _interpolate_2d_landmarks(self, landmarks_2d_series):
        """Fill empty 2D landmark frames from nearest valid frames so the 2D
        canvas overlay never flickers or desyncs."""
        n = len(landmarks_2d_series)
        first_valid_idx = next((i for i, lm in enumerate(landmarks_2d_series) if lm), None)
        if first_valid_idx is None:
            return landmarks_2d_series
        last_valid = landmarks_2d_series[first_valid_idx]
        for i in range(n):
            if landmarks_2d_series[i]:
                last_valid = landmarks_2d_series[i]
            else:
                landmarks_2d_series[i] = last_valid
        return landmarks_2d_series

    def _compute_metric_root_trajectory(self, raw_series, hip2d_series, eff_fps):
        """Reconstruct 3D metric root displacement (meters) from 2D hip motion in
        image space scaled by the median 3D-to-2D torso length ratio."""
        n = len(raw_series)
        if n == 0:
            return []

        torso_3d_list = []
        torso_2d_list = []
        valid_hx = []
        valid_hy = []

        for fr, h2d in zip(raw_series, hip2d_series):
            if h2d[3] >= 0.45 and h2d[2] > 15.0:
                mid_hip = 0.5 * (fr['leftHip'] + fr['rightHip'])
                mid_sh = 0.5 * (fr['leftShoulder'] + fr['rightShoulder'])
                t3d = float(np.linalg.norm(mid_sh - mid_hip))
                if t3d > 0.15:
                    torso_3d_list.append(t3d)
                    torso_2d_list.append(float(h2d[2]))
                valid_hx.append(float(h2d[0]))
                valid_hy.append(float(h2d[1]))

        if not torso_2d_list or not valid_hx:
            return [np.zeros(3, dtype=np.float32) for _ in range(n)]

        med_t3d = float(np.median(torso_3d_list)) if torso_3d_list else 0.45
        med_t2d = max(20.0, float(np.median(torso_2d_list)))
        meters_per_px = med_t3d / med_t2d

        ref_hx = float(np.median(valid_hx))
        ref_hy = float(np.median(valid_hy))

        # Interpolate low-confidence 2D hip positions before filtering
        hx_arr = np.array([h[0] for h in hip2d_series], dtype=np.float32)
        hy_arr = np.array([h[1] for h in hip2d_series], dtype=np.float32)
        conf_arr = np.array([h[3] for h in hip2d_series], dtype=np.float32)

        good_idx = np.where(conf_arr >= 0.35)[0]
        if len(good_idx) > 0:
            all_idx = np.arange(n)
            hx_arr = np.interp(all_idx, good_idx, hx_arr[good_idx])
            hy_arr = np.interp(all_idx, good_idx, hy_arr[good_idx])

        root_filter = OneEuroFilter(freq=eff_fps, min_cutoff=1.0, beta=0.03)
        offsets = []
        for i in range(n):
            dx = (float(hx_arr[i]) - ref_hx) * meters_per_px
            # Image +Y is downward; 3D +Y is upward
            dy = -(float(hy_arr[i]) - ref_hy) * meters_per_px
            # Clamp extreme excursions so camera pans don't throw character off stage
            dx = max(-2.5, min(2.5, dx))
            dy = max(-0.6, min(0.8, dy))
            raw_off = np.array([dx, dy, 0.0], dtype=np.float32)
            offsets.append(root_filter.filter(raw_off, freq=eff_fps))

        return offsets

    # ------------------------------------------------------------------ #
    def _enforce_bone_lengths(self, series):
        """Keep limb bone lengths constant across frames (= median length)
        WHILE strictly preserving the captured parent->child unit direction
        vectors of every segment."""
        chains = self.BONE_CHAINS
        lengths = {}
        for (p, c) in chains:
            ls = [
                float(np.linalg.norm(fr[c] - fr[p]))
                for fr in series if (p in fr and c in fr)
            ]
            if ls:
                lengths[(p, c)] = float(np.median(ls))

        if not lengths:
            return series

        for fr in series:
            # 1. Capture ALL unit directions BEFORE mutating any joint position!
            unit_dirs = {}
            for (p, c) in chains:
                if p in fr and c in fr:
                    d = fr[c] - fr[p]
                    dl = float(np.linalg.norm(d))
                    unit_dirs[(p, c)] = (d / dl) if dl > 1e-6 else np.array([0.0, -1.0, 0.0], dtype=np.float32)
            # 2. Reconstruct joint positions down each chain in topological order
            for (p, c) in chains:
                if (p, c) in unit_dirs and (p, c) in lengths:
                    fr[c] = fr[p] + unit_dirs[(p, c)] * lengths[(p, c)]

        return series


# Global singleton instance
mocap_engine = VideoMocapEngine()
