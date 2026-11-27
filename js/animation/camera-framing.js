/**
 * Canh camera theo khung hình video gốc (dùng cho render mocap).
 * File: js/animation/camera-framing.js
 *
 * Thuần toán, không phụ thuộc DOM/Three.js để test được bằng Node:
 * - `videoSubjectBox()`: đo khung chủ thể (0..1) từ landmark 2D của MediaPipe.
 * - `cameraFit()`: tính vị trí camera + điểm ngắm sao cho nhân vật chiếm đúng
 *   tỉ lệ và đúng vị trí như người trong video.
 */

import { clamp as clampNumber, median as medianOf } from './mocap-math.js';

/** MediaPipe Pose: mũi, tai, vai, hông, gối, cổ chân, mũi chân. */
export const FRAMING_LANDMARKS = Object.freeze([0, 7, 8, 11, 12, 23, 24, 25, 26, 27, 28, 31, 32]);

function median(values) {
  // Dùng chung median của mocap-math.js (trước đây bản copy này bỏ qua NaN khác bản filters).
  return medianOf(values);
}

/**
 * Đo khung chủ thể trong video (toạ độ chuẩn hoá 0..1, y hướng xuống).
 * Dùng trung vị trên toàn clip để vài frame nhiễu không kéo lệch.
 *
 * @param {Array<Array<[number, number, number?]>>} landmarks2D mỗi frame là 33 landmark [x, y, visibility]
 * @param {{minVisibility?: number, minFrames?: number, minPoints?: number}} [options]
 * @returns {{cx:number, cy:number, w:number, h:number, frames:number}|null}
 */
export function videoSubjectBox(landmarks2D, options = {}) {
  const rows = Array.isArray(landmarks2D) ? landmarks2D : [];
  if (rows.length === 0) return null;

  const minVisibility = Number.isFinite(options.minVisibility) ? options.minVisibility : 0.3;
  const minFrames = Number.isFinite(options.minFrames) ? options.minFrames : 3;
  const minPoints = Number.isFinite(options.minPoints) ? options.minPoints : 4;

  const boxes = [];
  for (const row of rows) {
    if (!Array.isArray(row)) continue;
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    let seen = 0;

    for (const index of FRAMING_LANDMARKS) {
      const point = row[index];
      if (!point) continue;
      const [x, y, visibility] = point;
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      if (Number.isFinite(visibility) && visibility < minVisibility) continue;
      if (x < 0 || x > 1 || y < 0 || y > 1) continue;
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
      seen += 1;
    }

    if (seen >= minPoints) {
      boxes.push({
        cx: (minX + maxX) / 2,
        cy: (minY + maxY) / 2,
        w: maxX - minX,
        h: maxY - minY,
      });
    }
  }

  if (boxes.length < minFrames) return null;
  return {
    cx: median(boxes.map((b) => b.cx)),
    cy: median(boxes.map((b) => b.cy)),
    w: median(boxes.map((b) => b.w)),
    h: median(boxes.map((b) => b.h)),
    frames: boxes.length,
  };
}

/**
 * Tính camera để nhân vật hiện ra giống người trong video.
 *
 * Hệ quy chiếu: trục +Z là phía camera (retargeter đã căn chuyển động vào hệ này).
 * Chiếu chiều cao thế giới lên khung hình: f = H / (2·d·tan(vfov/2)).
 *
 * @param {Object} params
 * @param {[number, number, number]} params.center Tâm bao hình nhân vật (world)
 * @param {number} params.height Chiều cao nhân vật (world)
 * @param {{cx:number, cy:number, h:number, w:number}|null} params.framing Khung chủ thể trong video
 * @param {number} params.fovDeg Góc nhìn dọc của camera
 * @param {number} params.aspect Tỉ lệ khung hình
 * @param {number} [params.defaultSubjectHeight=0.82] Tỉ lệ chiều cao khi không có landmark
 * @param {number} [params.minDistance=0.5]
 * @param {number} [params.maxDistance=250]
 * @returns {{position:[number,number,number], aim:[number,number,number], distance:number,
 *            subjectH:number, cx:number, cy:number, source:'video'|'default'}}
 */
export function cameraFit(params) {
  const center = Array.isArray(params.center) ? params.center : [0, 0, 0];
  const height = Math.max(1e-3, Number(params.height) || 0);
  const framing = params.framing || null;
  const fovDeg = Number.isFinite(params.fovDeg) && params.fovDeg > 0 ? params.fovDeg : 50;
  const aspect = Number.isFinite(params.aspect) && params.aspect > 0 ? params.aspect : 16 / 9;
  const minDistance = Number.isFinite(params.minDistance) ? params.minDistance : 0.5;
  const maxDistance = Number.isFinite(params.maxDistance) ? params.maxDistance : 250;

  const clamp = clampNumber;

  const subjectH = framing
    ? clamp(framing.h, 0.12, 0.98)
    : clamp(Number(params.defaultSubjectHeight) || 0.82, 0.12, 0.98);
  const cx = framing ? clamp(framing.cx, 0, 1) : 0.5;
  const cy = framing ? clamp(framing.cy, 0, 1) : 0.5;

  const vfov = (fovDeg * Math.PI) / 180;
  const distance = clamp(height / (2 * Math.tan(vfov / 2) * subjectH), minDistance, maxDistance);

  const halfH = Math.tan(vfov / 2) * distance;
  const halfW = halfH * aspect;

  const position = [center[0], center[1], center[2] + distance];
  // Điểm ngắm lệch theo vị trí chủ thể trong khung: chủ thể lệch trái → ngắm lệch phải.
  const aim = [
    center[0] + (0.5 - cx) * 2 * halfW,
    center[1] + (cy - 0.5) * 2 * halfH,
    center[2],
  ];

  return {
    position,
    aim,
    distance,
    subjectH,
    cx,
    cy,
    source: framing ? 'video' : 'default',
  };
}

function signedAngleXZRaw(ax, az, bx, bz) {
  const crossY = az * bx - ax * bz;
  const dot = ax * bx + az * bz;
  return Math.atan2(crossY, dot);
}

/**
 * Ước lượng hướng máy quay video gốc so với nhân vật sau căn chỉnh retargeting.
 * @param {Array<Object>} frames Mảng mocapFrames
 * @param {Array|null} landmarks2D Landmark 2D (tùy chọn)
 * @param {{charFwd?: [number,number,number], autoAlign?: boolean, yawOffsetDeg?: number, mirrorX?: boolean}} [options]
 */
export function estimateVideoCameraPose(frames, landmarks2D = null, options = {}) {
  const rows = Array.isArray(frames) ? frames : [];
  const charFwdRaw = Array.isArray(options.charFwd) ? options.charFwd : [0, 0, 1];
  const cfLen = Math.hypot(charFwdRaw[0] || 0, charFwdRaw[2] || 0);
  const cfx = cfLen > 1e-5 ? (charFwdRaw[0] || 0) / cfLen : 0;
  const cfz = cfLen > 1e-5 ? (charFwdRaw[2] || 0) / cfLen : 1;

  const autoAlign = options.autoAlign !== false;
  const yawOffsetDeg = Number(options.yawOffsetDeg) || 0;
  const mirrorX = Boolean(options.mirrorX);

  let sumSin = 0;
  let sumCos = 0;
  let sumFx = 0;
  let sumFz = 0;
  let count = 0;

  const startIdx = rows.length > 20 ? Math.floor(rows.length * 0.08) : 0;
  const endIdx = rows.length > 20 ? Math.ceil(rows.length * 0.92) : rows.length;

  for (let i = startIdx; i < endIdx; i++) {
    const f = rows[i];
    if (!f?.leftHip || !f?.rightHip || !f?.leftShoulder || !f?.rightShoulder) continue;
    const signX = mirrorX ? -1 : 1;
    const hdx = signX * (f.leftHip[0] - f.rightHip[0]);
    const hdz = f.leftHip[2] - f.rightHip[2];
    const hLen = Math.hypot(hdx, f.leftHip[1] - f.rightHip[1], hdz);

    const sdx = signX * (f.leftShoulder[0] - f.rightShoulder[0]);
    const sdz = f.leftShoulder[2] - f.rightShoulder[2];
    const sLen = Math.hypot(sdx, f.leftShoulder[1] - f.rightShoulder[1], sdz);

    const nhx = hLen > 1e-5 ? hdx / hLen : 0;
    const nhz = hLen > 1e-5 ? hdz / hLen : 0;
    const nsx = sLen > 1e-5 ? sdx / sLen : 0;
    const nsz = sLen > 1e-5 ? sdz / sLen : 0;

    const sideX = 0.55 * nhx + 0.45 * nsx;
    const sideZ = 0.55 * nhz + 0.45 * nsz;
    const sideLen = Math.hypot(sideX, sideZ);
    if (sideLen <= 1e-5) continue;

    // fwdXZ = cross(sideXZ, +Y) = (-sideZ, 0, sideX)
    const fx = -sideZ / sideLen;
    const fz = sideX / sideLen;
    const yaw = signedAngleXZRaw(fx, fz, cfx, cfz);
    sumSin += Math.sin(yaw);
    sumCos += Math.cos(yaw);
    sumFx += fx;
    sumFz += fz;
    count++;
  }

  const avgYaw = count > 0 ? Math.atan2(sumSin / count, sumCos / count) : 0;
  const inferredYawDeg = (avgYaw * 180) / Math.PI;
  const avgLen = Math.hypot(sumFx, sumFz);
  const avgFx = avgLen > 1e-5 ? sumFx / avgLen : cfx;
  const avgFz = avgLen > 1e-5 ? sumFz / avgLen : cfz;

  const applyYawRad = (((autoAlign ? inferredYawDeg : 0) + yawOffsetDeg) * Math.PI) / 180;
  const videoMatchAzimuthDeg = (applyYawRad * 180) / Math.PI;

  const baseFx = autoAlign ? cfx : avgFx;
  const baseFz = autoAlign ? cfz : avgFz;
  const yawOffRad = (yawOffsetDeg * Math.PI) / 180;
  const worldCharFwdX = baseFx * Math.cos(yawOffRad) + baseFz * Math.sin(yawOffRad);
  const worldCharFwdZ = -baseFx * Math.sin(yawOffRad) + baseFz * Math.cos(yawOffRad);
  const frontAzimuthDeg = (Math.atan2(worldCharFwdX, worldCharFwdZ) * 180) / Math.PI;

  // Estimate subtle pitch elevation from 2D ankle-hip vertical spread when available
  let elevationDeg = 10;
  if (Array.isArray(landmarks2D) && landmarks2D.length >= 3) {
    const heights2d = [];
    for (let i = 0; i < landmarks2D.length; i++) {
      const lm = landmarks2D[i];
      if (!Array.isArray(lm) || lm.length < 29) continue;
      const sh = lm[11];
      const an = lm[27];
      if (sh && an && Number.isFinite(sh[1]) && Number.isFinite(an[1]) && (an[2] ?? 1) > 0.3) {
        heights2d.push(an[1] - sh[1]);
      }
    }
    if (heights2d.length >= 3) {
      const mh = medianOf(heights2d);
      if (mh > 0.05 && mh < 0.35) elevationDeg = 12;
      else elevationDeg = 9;
    }
  }

  return {
    videoMatchAzimuthDeg,
    frontAzimuthDeg,
    inferredYawDeg,
    elevationDeg,
    avgFz: clampNumber(count > 0 ? sumFz / count : 1, -1, 1),
  };
}

/**
 * Tính vị trí camera quỹ đạo 3D xung quanh nhân vật theo preset góc máy,
 * góc ngẩng (pitch), FOV và hệ số zoom, tránh mất khung hình hay chui xuống sàn.
 */
export function computeCameraOrbitPose(params = {}) {
  const center = Array.isArray(params.center) ? params.center : [0, 0.9, 0];
  const height = Math.max(1e-3, Number(params.height) || 1.7);
  const framing = params.framing || null;
  const hint = params.cameraHint || null;
  const mode = params.mode || 'video-match';

  const fovDeg = clampNumber(
    Number.isFinite(Number(params.fovDeg)) && Number(params.fovDeg) > 0 ? Number(params.fovDeg) : 48,
    20,
    85
  );
  const aspect = Number.isFinite(Number(params.aspect)) && Number(params.aspect) > 0
    ? Number(params.aspect)
    : 16 / 9;
  const zoomScale = clampNumber(
    Number.isFinite(Number(params.zoomScale)) && Number(params.zoomScale) > 0 ? Number(params.zoomScale) : 1.0,
    0.45,
    2.5
  );
  const minDistance = Number.isFinite(Number(params.minDistance)) ? Number(params.minDistance) : 0.7;
  const maxDistance = Number.isFinite(Number(params.maxDistance)) ? Number(params.maxDistance) : 250;

  const frontAz = Number.isFinite(Number(hint?.frontAzimuthDeg)) ? Number(hint.frontAzimuthDeg) : 0;
  let azimuthDeg = frontAz;
  if (mode === 'video-match') {
    azimuthDeg = Number.isFinite(Number(hint?.videoMatchAzimuthDeg))
      ? Number(hint.videoMatchAzimuthDeg)
      : frontAz;
  } else if (mode === 'three-quarter') {
    azimuthDeg = frontAz + 35;
  } else if (mode === 'side') {
    azimuthDeg = frontAz + 88;
  } else if (mode === 'front') {
    azimuthDeg = frontAz;
  }

  const defaultPitch = Number.isFinite(Number(hint?.elevationDeg))
    ? Number(hint.elevationDeg)
    : (mode === 'three-quarter' ? 12 : 9);
  const elevationDeg = clampNumber(
    Number.isFinite(Number(params.pitchDeg)) ? Number(params.pitchDeg) : defaultPitch,
    -35,
    65
  );

  const subjectH = (mode === 'video-match' && framing)
    ? clampNumber(framing.h, 0.58, 0.78)
    : clampNumber(Number(params.defaultSubjectHeight) || 0.72, 0.25, 0.85);
  const vfov = (fovDeg * Math.PI) / 180;
  const baseDistance = height / (2 * Math.tan(vfov / 2) * subjectH);
  const distance = clampNumber(baseDistance * zoomScale, minDistance, maxDistance);

  const azRad = (azimuthDeg * Math.PI) / 180;
  const elRad = (elevationDeg * Math.PI) / 180;
  const dirX = Math.cos(elRad) * Math.sin(azRad);
  const dirY = Math.sin(elRad);
  const dirZ = Math.cos(elRad) * Math.cos(azRad);

  const cx = (mode === 'video-match' && framing) ? clampNumber(framing.cx, 0.44, 0.56) : 0.5;
  const cy = (mode === 'video-match' && framing) ? clampNumber(framing.cy, 0.44, 0.56) : 0.5;
  const halfH = Math.tan(vfov / 2) * distance;
  const halfW = halfH * aspect;

  // camRight = normalize(cross(-dirXZ, +Y)) = (cosAz, 0, -sinAz)
  const rightX = Math.cos(azRad);
  const rightZ = -Math.sin(azRad);
  const lateralShift = (0.5 - cx) * 2 * halfW;
  const verticalShift = (cy - 0.5) * 2 * halfH;

  const aim = [
    center[0] + rightX * lateralShift,
    center[1] + verticalShift,
    center[2] + rightZ * lateralShift,
  ];
  const position = [
    aim[0] + dirX * distance,
    Math.max(0.15, aim[1] + dirY * distance),
    aim[2] + dirZ * distance,
  ];

  return {
    position,
    aim,
    distance,
    azimuthDeg,
    elevationDeg,
    fovDeg,
    subjectH,
    cx,
    cy,
    mode,
    source: (mode === 'video-match' && framing) ? 'video' : mode,
  };
}
