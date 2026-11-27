/**
 * Web Blender Studio - Client-side Pose Tracking (MediaPipe WASM/WebGPU)
 * File: js/animation/browser-mocap.js
 *
 * Runs full-body motion capture entirely in the browser: no Python, no
 * GPU-server bill. The heavy post-processing (1-Euro filter, bone lengths,
 * metric root trajectory, foot-lock IK) lives in `mocap-filters.js` and is
 * shared with the server pipeline so both produce the same frame schema.
 *
 * The MediaPipe runtime is loaded lazily (only when tracking starts) so the
 * editor keeps working offline-on-localhost with the Python fallback.
 *
 * Config override:
 *   window.MEDIAPIPE_CONFIG = { cdnBase, wasmBase, modelUrl, delegate }
 */

import { processJointSeries, applyFootLock, SKELETON_JOINTS } from './mocap-filters.js';
import { CameraMotionEstimator } from './camera-motion.js';
import { openVideoFrameStream, isWebCodecsSupported } from './video-decoder.js';
import { resolveCdnAssetUrl } from '../core/asset-cdn.js';
import {
  initMocapKernel,
  isMocapKernelReady,
  processJointsWasm,
  applyFootLockWasm,
} from './mocap-kernel-bridge.js';

/** MediaPipe Pose landmark indices -> core 17 studio joint names. */
export const POSE_LANDMARK_INDEX = Object.freeze({
  nose: 0,
  leftShoulder: 11,
  rightShoulder: 12,
  leftElbow: 13,
  rightElbow: 14,
  leftWrist: 15,
  rightWrist: 16,
  leftHandIndex: 19,
  rightHandIndex: 20,
  leftHip: 23,
  rightHip: 24,
  leftKnee: 25,
  rightKnee: 26,
  leftAnkle: 27,
  rightAnkle: 28,
  leftFoot: 31,
  rightFoot: 32,
});

/** Extended Pose landmark indices used for anatomical heel-lift & ToeBase articulation. */
export const EXTRA_POSE_LANDMARK_INDEX = Object.freeze({
  leftHeel: 29,
  rightHeel: 30,
});

export const DEFAULT_MEDIAPIPE_CONFIG = Object.freeze({
  version: '0.10.14',
  // Vendored copy first (works offline / on locked-down school networks).
  localBundle: '/vendor/mediapipe/vision_bundle.mjs',
  localWasmBase: '/vendor/mediapipe/wasm',
  localModel: '/models/pose_landmarker_full.task',
  localModels: Object.freeze({
    heavy: '/models/pose_landmarker_heavy.task',
    full: '/models/pose_landmarker_full.task',
    lite: '/models/pose_landmarker_lite.task',
  }),
  localHandModel: '/models/hand_landmarker.task',
  localFaceModel: '/models/face_landmarker.task',
  // CDN fallback when the vendor directory is missing.
  cdnBase: 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14',
  wasmBase: 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm',
  modelUrl: 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/latest/pose_landmarker_full.task',
  modelUrls: Object.freeze({
    heavy: 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_heavy/float16/latest/pose_landmarker_heavy.task',
    full: 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/latest/pose_landmarker_full.task',
    lite: 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/latest/pose_landmarker_lite.task',
  }),
  handModelUrl: 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/latest/hand_landmarker.task',
  faceModelUrl: 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/latest/face_landmarker.task',
  modelTier: 'full',
  delegate: 'GPU',
  minCoreVisibility: 0.35,
  numPoses: 4,
  subjectMode: 'auto',
});

const CORE_LANDMARKS = [11, 12, 23, 24];

function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * MediaPipe returns one entry per detected pose (`[[33 landmarks]]`), while the
 * tests and some adapters pass a flat `[33 landmarks]` list. Normalise both.
 */
export function firstPose(landmarks) {
  if (!Array.isArray(landmarks) || landmarks.length === 0) return null;
  return Array.isArray(landmarks[0]) ? landmarks[0] : landmarks;
}

export function extractPoseLists(poseRes) {
  if (!poseRes || typeof poseRes !== 'object') return { worldList: [], imageList: [] };
  const rawW = poseRes.worldLandmarks;
  const rawI = poseRes.landmarks;
  const worldList = Array.isArray(rawW) && rawW.length > 0
    ? (Array.isArray(rawW[0]) ? rawW : [rawW])
    : [];
  const imageList = Array.isArray(rawI) && rawI.length > 0
    ? (Array.isArray(rawI[0]) ? rawI : [rawI])
    : [];
  return { worldList, imageList };
}

export function createSubjectTrackerState(options = {}) {
  return {
    mode: String(options.subjectMode || 'auto').toLowerCase(),
    anchor: null,
    homeProfile: null,
    distractors: [],
    pendingReacquire: null,
    lostFrames: 0,
    maxPeople: 0,
    multiPersonFrames: 0,
    subjectSwitches: 0,
    blockedIntruders: 0,
    lastIndex: 0,
  };
}

function bboxIoU(a, b) {
  if (!a || !b) return 0;
  const x0 = Math.max(a[0], b[0]);
  const y0 = Math.max(a[1], b[1]);
  const x1 = Math.min(a[2], b[2]);
  const y1 = Math.min(a[3], b[3]);
  const iw = Math.max(0, x1 - x0);
  const ih = Math.max(0, y1 - y0);
  const inter = iw * ih;
  if (inter <= 0) return 0;
  const areaA = Math.max(1e-5, (a[2] - a[0]) * (a[3] - a[1]));
  const areaB = Math.max(1e-5, (b[2] - b[0]) * (b[3] - b[1]));
  return inter / Math.max(1e-5, areaA + areaB - inter);
}

function describePoseCandidate(imagePose, worldPose, index) {
  const pts = Array.isArray(imagePose) && imagePose.length >= 25
    ? imagePose
    : (Array.isArray(worldPose) && worldPose.length >= 25 ? worldPose : null);
  if (!pts) {
    return {
      index,
      hx: 0.5,
      hy: 0.5,
      cx: 0.5,
      cy: 0.45,
      torso2d: 0.15,
      shoulderW: 0.08,
      legSpan2d: 0.18,
      box: [0.4, 0.25, 0.6, 0.75],
      area: 0.05,
      visScore: 0.25,
      lowerVis: 0.25,
    };
  }
  const lSh = pts[11], rSh = pts[12], lHip = pts[23], rHip = pts[24];
  const lAnk = pts[27], rAnk = pts[28];
  let minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9;
  for (let i = 0; i < Math.min(33, pts.length); i++) {
    const p = pts[i];
    if (!p) continue;
    const x = num(p.x, 0.5);
    const y = num(p.y, 0.5);
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  const hx = lHip && rHip ? 0.5 * (num(lHip.x) + num(rHip.x)) : 0.5 * (minX + maxX);
  const hy = lHip && rHip ? 0.5 * (num(lHip.y) + num(rHip.y)) : 0.5 * (minY + maxY);
  const sx = lSh && rSh ? 0.5 * (num(lSh.x) + num(rSh.x)) : hx;
  const sy = lSh && rSh ? 0.5 * (num(lSh.y) + num(rSh.y)) : hy - 0.15;
  const cx = 0.5 * (hx + sx);
  const cy = 0.5 * (hy + sy);
  const torso2d = Math.max(0.04, Math.hypot(sx - hx, sy - hy));
  const shoulderW = (lSh && rSh)
    ? Math.max(0.02, Math.hypot(num(lSh.x) - num(rSh.x), num(lSh.y) - num(rSh.y)))
    : torso2d * 0.55;
  const lLegSpan = lAnk ? Math.hypot(num(lAnk.x) - hx, num(lAnk.y) - hy) : torso2d * 1.1;
  const rLegSpan = rAnk ? Math.hypot(num(rAnk.x) - hx, num(rAnk.y) - hy) : torso2d * 1.1;
  const legSpan2d = Math.max(torso2d * 0.6, Math.max(lLegSpan, rLegSpan));
  const box = [minX, minY, maxX, maxY];
  const area = Math.max(0.001, (maxX - minX) * (maxY - minY));

  let visSum = 0;
  let visCnt = 0;
  for (const idx of CORE_LANDMARKS) {
    if (pts[idx]) {
      visSum += Math.max(0, Math.min(1, num(pts[idx].visibility, 0.75)));
      visCnt += 1;
    }
  }
  const visScore = visCnt > 0 ? visSum / visCnt : 0.5;

  let lowSum = 0;
  let lowCnt = 0;
  for (const idx of [25, 26, 27, 28]) {
    if (pts[idx]) {
      lowSum += Math.max(0, Math.min(1, num(pts[idx].visibility, 0.65)));
      lowCnt += 1;
    }
  }
  const lowerVis = lowCnt > 0 ? lowSum / lowCnt : visScore;

  return {
    index,
    hx,
    hy,
    cx,
    cy,
    torso2d,
    shoulderW,
    legSpan2d,
    box,
    area,
    visScore,
    lowerVis,
  };
}

function updateDistractorTracks(trackerState, viable, chosenCandidate) {
  if (!trackerState) return;
  const existing = Array.isArray(trackerState.distractors) ? trackerState.distractors : [];
  const next = [];
  const usedPrev = new Set();

  for (const c of viable) {
    if (chosenCandidate && c.index === chosenCandidate.index) continue;
    let bestIdx = -1;
    let bestD = 0.24;
    for (let j = 0; j < existing.length; j++) {
      if (usedPrev.has(j)) continue;
      const d = existing[j];
      const predCx = d.cx + (d.vx || 0);
      const predCy = d.cy + (d.vy || 0);
      const dist = Math.hypot(c.cx - predCx, c.cy - predCy)
        + 0.35 * (Math.abs(c.torso2d - d.torso2d) / Math.max(0.05, d.torso2d));
      if (dist < bestD) {
        bestD = dist;
        bestIdx = j;
      }
    }
    if (bestIdx >= 0) {
      usedPrev.add(bestIdx);
      const prev = existing[bestIdx];
      const stepVx = c.cx - prev.cx;
      const stepVy = c.cy - prev.cy;
      next.push({
        cx: prev.cx * 0.45 + c.cx * 0.55,
        cy: prev.cy * 0.45 + c.cy * 0.55,
        hx: c.hx,
        hy: c.hy,
        torso2d: prev.torso2d * 0.65 + c.torso2d * 0.35,
        shoulderW: (prev.shoulderW || c.shoulderW) * 0.65 + c.shoulderW * 0.35,
        box: c.box,
        vx: Math.max(-0.08, Math.min(0.08, (prev.vx || 0) * 0.5 + stepVx * 0.5)),
        vy: Math.max(-0.08, Math.min(0.08, (prev.vy || 0) * 0.5 + stepVy * 0.5)),
        age: 0,
        seenCount: (prev.seenCount || 1) + 1,
      });
    } else {
      next.push({
        cx: c.cx,
        cy: c.cy,
        hx: c.hx,
        hy: c.hy,
        torso2d: c.torso2d,
        shoulderW: c.shoulderW,
        box: c.box,
        vx: 0,
        vy: 0,
        age: 0,
        seenCount: 1,
      });
    }
  }

  for (let j = 0; j < existing.length; j++) {
    if (usedPrev.has(j)) continue;
    const d = existing[j];
    const nextAge = (d.age || 0) + 1;
    if (nextAge <= 14) {
      next.push({
        ...d,
        cx: d.cx + (d.vx || 0) * 0.7,
        cy: d.cy + (d.vy || 0) * 0.7,
        age: nextAge,
      });
    }
  }

  trackerState.distractors = next.slice(0, 6);
}

/**
 * Selects & temporally locks onto a SINGLE primary performer across multi-person detections (`numPoses > 1`).
 * Walks-ins, background passersby, or foreground intruders crossing directly in front of the subject are
 * tracked separately as distractors and blocked rather than overwriting `homeProfile` or hijacking the rig.
 */
export function selectTrackedPose(poseRes, trackerState = null, options = {}) {
  const { worldList, imageList } = extractPoseLists(poseRes);
  const count = Math.max(worldList.length, imageList.length);
  const tickLost = (skipDistractors = false) => {
    if (!trackerState) return;
    trackerState.lostFrames += 1;
    trackerState.pendingReacquire = null;
    // Propagate distractor positions during empty-frame occlusions so crossing intruders stay identifiable.
    if (!skipDistractors && Array.isArray(trackerState.distractors) && trackerState.distractors.length > 0) {
      trackerState.distractors = trackerState.distractors
        .map((d) => ({
          ...d,
          cx: d.cx + (d.vx || 0) * 0.7,
          cy: d.cy + (d.vy || 0) * 0.7,
          age: (d.age || 0) + 1,
        }))
        .filter((d) => d.age <= 14);
    }
  };

  if (count === 0) {
    tickLost();
    return { index: -1, worldPose: null, imagePose: null, count: 0, candidate: null };
  }

  const mode = String(options.subjectMode || trackerState?.mode || 'auto').toLowerCase();
  const candidates = [];
  for (let i = 0; i < count; i++) {
    candidates.push(describePoseCandidate(imageList[i], worldList[i], i));
  }

  // Filter out severe off-screen low-confidence ghosts emitted by multi-pose detectors
  // when a limb or passerby sits near the border (e.g. hx < -0.04 with vis < 0.38).
  const isOffscreenGhost = (c) => (
    (c.hx < -0.04 || c.hx > 1.04 || c.hy < -0.04 || c.hy > 1.06) && c.visScore < 0.38
  );
  const viable = candidates.filter((c) => !isOffscreenGhost(c));
  if (viable.length === 0) {
    if (trackerState) {
      trackerState.maxPeople = Math.max(trackerState.maxPeople || 0, count);
      if (count > 1) trackerState.multiPersonFrames += 1;
    }
    tickLost();
    return { index: -1, worldPose: null, imagePose: null, count, candidate: null };
  }

  const recordMulti = () => {
    if (!trackerState) return;
    trackerState.maxPeople = Math.max(trackerState.maxPeople || 0, count);
    if (count > 1) trackerState.multiPersonFrames += 1;
  };

  let chosen = viable[0];
  let matchedByContinuity = false;
  const allowContinuity = !mode.startsWith('index:');
  const hardLossCutoff = 18;

  if (allowContinuity && trackerState?.anchor) {
    const a = trackerState.anchor;
    const home = trackerState.homeProfile || a;
    const horizon = Math.min(4, trackerState.lostFrames || 0);
    const predCx = a.cx + (a.vx || 0) * (1 + horizon * 0.5);
    const predCy = a.cy + (a.vy || 0) * (1 + horizon * 0.5);
    const predHx = a.hx + (a.vx || 0) * (1 + horizon * 0.5);
    const predHy = a.hy + (a.vy || 0) * (1 + horizon * 0.5);
    const refTorso = home.torso2d;
    const refShoulder = home.shoulderW || a.shoulderW || refTorso * 0.55;

    const scoreCandidateCost = (c) => {
      const torsoDist = Math.hypot(c.cx - predCx, c.cy - predCy);
      const hipDist = Math.hypot(c.hx - predHx, c.hy - predHy);
      const scaleDiff = Math.abs(c.torso2d - refTorso) / Math.max(0.06, refTorso);
      const shDiff = Math.abs(c.shoulderW - refShoulder) / Math.max(0.04, refShoulder);
      const iouPenalty = 1 - bboxIoU(c.box, a.box);
      const scalePenalty = scaleDiff > 0.35 ? 0.65 * scaleDiff : 0.35 * scaleDiff;
      return 0.65 * torsoDist
        + 0.45 * hipDist
        + scalePenalty
        + 0.25 * shDiff
        + 0.16 * iouPenalty
        + 0.10 * (1 - c.visScore);
    };

    let best = viable[0];
    let bestCost = Infinity;
    for (const c of viable) {
      const cost = scoreCandidateCost(c);
      if (cost < bestCost) {
        bestCost = cost;
        best = c;
      }
    }

    // Check whether `best` actually belongs to a previously tracked intruder trajectory walking across `anchor`.
    let matchedDistractor = false;
    if (Array.isArray(trackerState.distractors) && trackerState.distractors.length > 0) {
      const primaryTorsoJump = Math.hypot(best.cx - predCx, best.cy - predCy);
      const primaryScaleDiff = Math.abs(best.torso2d - refTorso) / Math.max(0.06, refTorso);
      const primarySpeed = Math.hypot(a.vx || 0, a.vy || 0);
      const nmsMergeCandidate = viable.length === 1 && (trackerState.multiPersonFrames || 0) > 0;
      const suspiciousTakeover = trackerState.lostFrames > 0
        || primaryTorsoJump > 0.12
        || primaryScaleDiff > 0.22
        || nmsMergeCandidate;
      if (suspiciousTakeover) {
        for (const d of trackerState.distractors) {
          if ((d.seenCount || 0) < 2) continue;
          const dPredCx = d.cx + (d.vx || 0);
          const dPredCy = d.cy + (d.vy || 0);
          const dDist = Math.hypot(best.cx - dPredCx, best.cy - dPredCy);
          const dSpeed = Math.hypot(d.vx || 0, d.vy || 0);
          const dCost = dDist
            + 0.45 * (Math.abs(best.torso2d - d.torso2d) / Math.max(0.06, d.torso2d))
            + 0.14 * (1 - bboxIoU(best.box, d.box));
          const displacementMatch = (trackerState.lostFrames > 0 || primaryTorsoJump > 0.12 || primaryScaleDiff > 0.22)
            && dCost < Math.min(0.24, bestCost * 0.78);
          const collisionMatch = nmsMergeCandidate
            && dSpeed > Math.max(0.022, primarySpeed + 0.025)
            && dDist < 0.09
            && Math.abs(best.torso2d - d.torso2d) / Math.max(0.06, d.torso2d) < 0.35;
          if (displacementMatch || collisionMatch) {
            matchedDistractor = true;
            break;
          }
        }
      }
    }

    const stepRelax = Math.min(0.18, Math.max(0, (Math.sqrt(Math.max(1, num(options.frameStep, 1))) - 1) * 0.065));
    const activeGate = 0.30 + stepRelax + Math.min(0.14, (trackerState.lostFrames || 0) * 0.015);
    const hasIntruderHistory = (trackerState.multiPersonFrames || 0) > 0
      || (Array.isArray(trackerState.distractors) && trackerState.distractors.length > 0);
    const bestTorsoDist = Math.hypot(best.cx - predCx, best.cy - predCy);
    const bestBoxIou = bboxIoU(best.box, a.box);
    const soloInPlaceContinue = viable.length === 1
      && !hasIntruderHistory
      && !matchedDistractor
      && best.visScore >= 0.45
      && bestTorsoDist <= (0.15 + stepRelax * 0.5)
      && bestBoxIou >= 0.25;

    if (trackerState.lostFrames < hardLossCutoff) {
      // Strictly reject intruders, background passersby, or close-up occluders during temporary loss:
      // never drop the gate after just 2 frames and never corrupt `anchor` / `homeProfile`.
      const rejectBest = matchedDistractor
        || (!soloInPlaceContinue && (bestCost > activeGate || (best.visScore < 0.38 && bestCost > 0.18)));
      if (rejectBest) {
        recordMulti();
        if (matchedDistractor || viable.some((c) => c !== best) || bestCost > activeGate) {
          trackerState.blockedIntruders = (trackerState.blockedIntruders || 0) + 1;
        }
        updateDistractorTracks(trackerState, viable, null);
        tickLost(true);
        return { index: -1, worldPose: null, imagePose: null, count, candidate: null };
      }
      chosen = best;
      matchedByContinuity = true;
    } else {
      // Extended disappearance (>= 18 frames / ~0.6s, e.g. real scene cut): allow direct homeProfile resume,
      // otherwise require 2 consecutive consistent non-distractor frames (`pendingReacquire`) before switching.
      if (!matchedDistractor && bestCost <= 0.28 && best.visScore >= 0.45) {
        chosen = best;
        matchedByContinuity = true;
        trackerState.pendingReacquire = null;
      } else if (!matchedDistractor && best.visScore >= 0.48) {
        const prevPend = trackerState.pendingReacquire;
        const pendClose = prevPend
          && Math.hypot(best.cx - prevPend.cx, best.cy - prevPend.cy) < 0.16
          && Math.abs(best.torso2d - prevPend.torso2d) / Math.max(0.06, prevPend.torso2d) < 0.32;
        if (pendClose && (prevPend.frames || 1) >= 1) {
          chosen = best;
          matchedByContinuity = true;
          trackerState.pendingReacquire = null;
        } else {
          trackerState.pendingReacquire = { cx: best.cx, cy: best.cy, torso2d: best.torso2d, frames: 1 };
          recordMulti();
          updateDistractorTracks(trackerState, viable, null);
          tickLost(true);
          return { index: -1, worldPose: null, imagePose: null, count, candidate: null };
        }
      } else {
        recordMulti();
        trackerState.blockedIntruders = (trackerState.blockedIntruders || 0) + 1;
        updateDistractorTracks(trackerState, viable, null);
        tickLost(true);
        return { index: -1, worldPose: null, imagePose: null, count, candidate: null };
      }
    }
  }

  if (!matchedByContinuity && viable.length > 1) {
    if (mode.startsWith('index:')) {
      const targetSlot = Math.max(0, Math.min(viable.length - 1, parseInt(mode.slice(6), 10) || 0));
      const sorted = [...viable].sort((a, b) => a.hx - b.hx);
      chosen = sorted[targetSlot];
    } else if (mode === 'center') {
      chosen = [...viable].sort(
        (a, b) => (Math.hypot(a.cx - 0.5, a.cy - 0.48) - 0.14 * a.visScore - 0.08 * a.lowerVis)
          - (Math.hypot(b.cx - 0.5, b.cy - 0.48) - 0.14 * b.visScore - 0.08 * b.lowerVis),
      )[0];
    } else if (mode === 'largest') {
      chosen = [...viable].sort(
        (a, b) => (b.torso2d * 1.4 + b.area * 0.6 + 0.12 * b.visScore + 0.08 * b.lowerVis)
          - (a.torso2d * 1.4 + a.area * 0.6 + 0.12 * a.visScore + 0.08 * a.lowerVis),
      )[0];
    } else {
      const maxTorso = Math.max(0.08, ...viable.map((c) => c.torso2d));
      chosen = [...viable].sort((a, b) => {
        const score = (c) => {
          const centerScore = 1 - Math.min(1, Math.hypot(c.cx - 0.5, c.cy - 0.48) * 1.65);
          const sizeScore = Math.min(1, c.torso2d / maxTorso);
          return 0.44 * centerScore + 0.30 * sizeScore + 0.16 * c.visScore + 0.10 * c.lowerVis;
        };
        return score(b) - score(a);
      })[0];
    }
  }

  if (trackerState) {
    recordMulti();
    updateDistractorTracks(trackerState, viable, chosen);
    if (viable.length > 1) {
      trackerState.blockedIntruders = (trackerState.blockedIntruders || 0) + (viable.length - 1);
    }
    const prevAnchor = trackerState.anchor;
    if (prevAnchor) {
      const jump = Math.hypot(chosen.cx - prevAnchor.cx, chosen.cy - prevAnchor.cy);
      if (jump > 0.22) trackerState.subjectSwitches += 1;
      const stepVx = chosen.cx - prevAnchor.cx;
      const stepVy = chosen.cy - prevAnchor.cy;
      const newVx = jump > 0.28 ? 0 : Math.max(-0.08, Math.min(0.08, (prevAnchor.vx || 0) * 0.60 + stepVx * 0.40));
      const newVy = jump > 0.28 ? 0 : Math.max(-0.08, Math.min(0.08, (prevAnchor.vy || 0) * 0.60 + stepVy * 0.40));
      if (jump > 0.28) {
        trackerState.anchor = {
          hx: chosen.hx,
          hy: chosen.hy,
          cx: chosen.cx,
          cy: chosen.cy,
          torso2d: chosen.torso2d,
          shoulderW: chosen.shoulderW,
          box: chosen.box,
          vx: 0,
          vy: 0,
        };
      } else {
        trackerState.anchor = {
          hx: prevAnchor.hx * 0.60 + chosen.hx * 0.40,
          hy: prevAnchor.hy * 0.60 + chosen.hy * 0.40,
          cx: prevAnchor.cx * 0.60 + chosen.cx * 0.40,
          cy: prevAnchor.cy * 0.60 + chosen.cy * 0.40,
          torso2d: prevAnchor.torso2d * 0.72 + chosen.torso2d * 0.28,
          shoulderW: (prevAnchor.shoulderW || chosen.shoulderW) * 0.72 + chosen.shoulderW * 0.28,
          box: chosen.box,
          vx: newVx,
          vy: newVy,
        };
      }
      // Update slow homeProfile only on clean, uninterrupted, high-confidence tracking.
      if (!trackerState.homeProfile || (jump <= 0.14 && chosen.visScore >= 0.55 && trackerState.lostFrames === 0)) {
        const hp = trackerState.homeProfile;
        trackerState.homeProfile = hp
          ? {
              hx: hp.hx * 0.90 + chosen.hx * 0.10,
              hy: hp.hy * 0.90 + chosen.hy * 0.10,
              cx: hp.cx * 0.90 + chosen.cx * 0.10,
              cy: hp.cy * 0.90 + chosen.cy * 0.10,
              torso2d: hp.torso2d * 0.92 + chosen.torso2d * 0.08,
              shoulderW: hp.shoulderW * 0.92 + chosen.shoulderW * 0.08,
              box: chosen.box,
              framesConfirmed: (hp.framesConfirmed || 1) + 1,
            }
          : {
              hx: chosen.hx,
              hy: chosen.hy,
              cx: chosen.cx,
              cy: chosen.cy,
              torso2d: chosen.torso2d,
              shoulderW: chosen.shoulderW,
              box: chosen.box,
              framesConfirmed: 1,
            };
      }
    } else {
      trackerState.anchor = {
        hx: chosen.hx,
        hy: chosen.hy,
        cx: chosen.cx,
        cy: chosen.cy,
        torso2d: chosen.torso2d,
        shoulderW: chosen.shoulderW,
        box: chosen.box,
        vx: 0,
        vy: 0,
      };
      trackerState.homeProfile = {
        hx: chosen.hx,
        hy: chosen.hy,
        cx: chosen.cx,
        cy: chosen.cy,
        torso2d: chosen.torso2d,
        shoulderW: chosen.shoulderW,
        box: chosen.box,
        framesConfirmed: 1,
      };
    }
    trackerState.pendingReacquire = null;
    trackerState.lostFrames = 0;
    trackerState.lastIndex = chosen.index;
  }

  return {
    index: chosen.index,
    worldPose: worldList[chosen.index] || null,
    imagePose: imageList[chosen.index] || null,
    count,
    candidate: chosen,
  };
}

function abortError() {
  if (typeof DOMException === 'function') return new DOMException('Tracking aborted', 'AbortError');
  const err = new Error('Tracking aborted');
  err.name = 'AbortError';
  return err;
}

export class BrowserMocapEngine {
  constructor(options = {}) {
    const env = (typeof window !== 'undefined' && window.MEDIAPIPE_CONFIG) ? window.MEDIAPIPE_CONFIG : {};
    this.config = { ...DEFAULT_MEDIAPIPE_CONFIG, ...env, ...options };
    this.landmarker = null;
    this._activeModelTier = null;
    this._activeNumPoses = null;
    this._activeNumPoses = null;
    this.handLandmarker = null;
    this._handLandmarkerAttempted = false;
    this._handCropCanvas = null;
    this._handCropCtx = null;
    this.faceLandmarker = null;
    this._faceLandmarkerAttempted = false;
    this._faceCropCanvas = null;
    this._faceCropCtx = null;
    this.ready = false;
    this.disposed = false;
    this.detectedFrames = 0;
    this.sampledFrames = 0;
    this.lastDecodePath = null;
    this._lastDetectTsMs = -1;
    this._detectSessionBaseMs = 0;
  }

  _beginDetectSession() {
    // MediaPipe PoseLandmarker (runningMode: 'VIDEO') requires strictly increasing
    // millisecond timestamps across every call to detectForVideo() on a landmarker
    // instance, including across different videos or WebCodecs -> seek fallbacks.
    this._detectSessionBaseMs = this._lastDetectTsMs >= 0 ? this._lastDetectTsMs + 5000 : 0;
  }

  _detectForVideo(image, relativeTsMs) {
    const desired = this._detectSessionBaseMs + Math.max(0, Math.round(relativeTsMs));
    const ts = Math.max(desired, this._lastDetectTsMs + 1);
    this._lastDetectTsMs = ts;
    return this.landmarker.detectForVideo(image, ts);
  }

  async _ensureHandLandmarker(overrides = {}) {
    if (this.disposed) return null;
    if (this.handLandmarker) return this.handLandmarker;
    if (this._handLandmarkerAttempted || this._usedCustomFactory || typeof window === 'undefined') return null;
    this._handLandmarkerAttempted = true;
    const config = { ...this.config, ...overrides };
    try {
      this.handLandmarker = await BrowserMocapEngine.createHandLandmarker(config);
    } catch (err) {
      console.warn('[browser-mocap] HandLandmarker unavailable (continuing pose-only):', err?.message || err);
      this.handLandmarker = null;
    }
    return this.handLandmarker;
  }

  /**
   * Detect 21-pt hand landmarks via tight wrist ROI upsampling (`runningMode: 'IMAGE'`)
   * with full-frame geometric wrist-matching fallback. Returns `{ left, right }` or null.
   */
  _detectHandsOnCanvas(grabCanvas, poseRes, overrideImagePose = null) {
    if (!this.handLandmarker || !grabCanvas || grabCanvas.width < 16 || grabCanvas.height < 16) return null;
    const imagePose = overrideImagePose || (poseRes ? firstPose(poseRes.landmarks) : null);
    if (!imagePose || imagePose.length < 23) return null;

    const w = grabCanvas.width;
    const h = grabCanvas.height;
    const cropSize = 192;
    if (!this._handCropCanvas && typeof document !== 'undefined') {
      this._handCropCanvas = document.createElement('canvas');
      this._handCropCanvas.width = cropSize;
      this._handCropCanvas.height = cropSize;
      this._handCropCtx = this._handCropCanvas.getContext('2d', { willReadFrequently: false });
    }
    const cropCtx = this._handCropCtx;
    if (!cropCtx) return null;

    // Estimate rough apparent torso scale so wrist ROI tightly frames palm + outstretched fingers
    const lSh = imagePose[11];
    const rSh = imagePose[12];
    const lHip = imagePose[23];
    const rHip = imagePose[24];
    let torsoNorm = 0.25;
    if (lSh && rSh && lHip && rHip) {
      torsoNorm = Math.max(
        0.12,
        Math.hypot(0.5 * (lSh.x + rSh.x) - 0.5 * (lHip.x + rHip.x), 0.5 * (lSh.y + rSh.y) - 0.5 * (lHip.y + rHip.y)),
      );
    }
    const boxHalfPx = Math.max(44, Math.min(Math.max(w, h) * 0.28, torsoNorm * Math.max(w, h) * 0.42));

    const packSide = (worldLms, imgLms, conf, cropRect = null) => ({
      confidence: conf,
      worldLandmarks: worldLms.map((p) => [num(p.x), num(p.y), num(p.z)]),
      landmarks: imgLms.map((p) => {
        if (!cropRect) return [num(p.x), num(p.y), num(p.z)];
        return [
          (cropRect.sx + num(p.x) * cropRect.sw) / w,
          (cropRect.sy + num(p.y) * cropRect.sh) / h,
          num(p.z),
        ];
      }),
    });

    const out = { left: null, right: null };
    const detectWristRoi = (wristIdx, tipIdx, sideKey) => {
      const wr = imagePose[wristIdx];
      const idxTip = imagePose[tipIdx];
      if (!wr || num(wr.visibility, 0) < 0.25) return null;
      const cxN = idxTip && num(idxTip.visibility, 0) > 0.2 ? (0.4 * num(wr.x) + 0.6 * num(idxTip.x)) : num(wr.x);
      const cyN = idxTip && num(idxTip.visibility, 0) > 0.2 ? (0.4 * num(wr.y) + 0.6 * num(idxTip.y)) : num(wr.y);
      if (cxN < -0.05 || cxN > 1.05 || cyN < -0.05 || cyN > 1.05) return null;

      const cx = cxN * w;
      const cy = cyN * h;
      const sx = Math.max(0, Math.min(w - 16, Math.round(cx - boxHalfPx)));
      const sy = Math.max(0, Math.min(h - 16, Math.round(cy - boxHalfPx)));
      const sw = Math.max(16, Math.min(w - sx, Math.round(boxHalfPx * 2)));
      const sh = Math.max(16, Math.min(h - sy, Math.round(boxHalfPx * 2)));
      if (sw < 16 || sh < 16) return null;

      cropCtx.clearRect(0, 0, cropSize, cropSize);
      cropCtx.drawImage(grabCanvas, sx, sy, sw, sh, 0, 0, cropSize, cropSize);
      try {
        const res = this.handLandmarker.detect(this._handCropCanvas);
        const wLms = res?.worldLandmarks;
        const iLms = res?.landmarks;
        if (!Array.isArray(wLms) || wLms.length === 0) return null;
        // Pick hand whose wrist in crop maps closest to pose wrist
        let bestIdx = 0;
        let bestDist = Infinity;
        for (let hi = 0; hi < wLms.length; hi++) {
          const hw = iLms?.[hi]?.[0];
          if (!hw) continue;
          const fx = (sx + num(hw.x) * sw) / w;
          const fy = (sy + num(hw.y) * sh) / h;
          const d = Math.hypot(fx - num(wr.x), fy - num(wr.y));
          if (d < bestDist) {
            bestDist = d;
            bestIdx = hi;
          }
        }
        if (bestDist > 0.20) return null;
        const score = num(res?.handednesses?.[bestIdx]?.[0]?.score, 0.85);
        return packSide(wLms[bestIdx], iLms[bestIdx], score, { sx, sy, sw, sh });
      } catch {
        return null;
      }
    };

    out.left = detectWristRoi(15, 19, 'left');
    out.right = detectWristRoi(16, 20, 'right');

    // Full-frame fallback when either hand ROI missed (matches by nearest Pose wrist to prevent swapped labels)
    if (!out.left && !out.right) {
      try {
        const res = this.handLandmarker.detect(grabCanvas);
        const wLms = res?.worldLandmarks || [];
        const iLms = res?.landmarks || [];
        const lw = imagePose[15];
        const rw = imagePose[16];
        for (let hi = 0; hi < wLms.length; hi++) {
          const hw = iLms[hi]?.[0];
          if (!hw) continue;
          const dL = lw && num(lw.visibility, 0) > 0.2 ? Math.hypot(num(hw.x) - num(lw.x), num(hw.y) - num(lw.y)) : Infinity;
          const dR = rw && num(rw.visibility, 0) > 0.2 ? Math.hypot(num(hw.x) - num(rw.x), num(hw.y) - num(rw.y)) : Infinity;
          const score = num(res?.handednesses?.[hi]?.[0]?.score, 0.8);
          if (dL < dR && dL < 0.18 && !out.left) {
            out.left = packSide(wLms[hi], iLms[hi], score);
          } else if (dR <= dL && dR < 0.18 && !out.right) {
            out.right = packSide(wLms[hi], iLms[hi], score);
          }
        }
      } catch {
        // non-fatal
      }
    }

    return (out.left || out.right) ? out : null;
  }

  async _ensureFaceLandmarker(overrides = {}) {
    if (this.disposed) return null;
    if (this.faceLandmarker) return this.faceLandmarker;
    if (this._faceLandmarkerAttempted || this._usedCustomFactory || typeof window === 'undefined') return null;
    this._faceLandmarkerAttempted = true;
    const config = { ...this.config, ...overrides };
    try {
      this.faceLandmarker = await BrowserMocapEngine.createFaceLandmarker(config);
    } catch (err) {
      console.warn('[browser-mocap] FaceLandmarker unavailable (continuing without face blendshapes):', err?.message || err);
      this.faceLandmarker = null;
    }
    return this.faceLandmarker;
  }

  /**
   * Detect 478-pt face landmarks, 52 ARKit blendshapes, and 4x4 facial transformation matrix
   * via head ROI crop upsampling (`runningMode: 'IMAGE'`) with full-frame fallback.
   */
  _detectFaceOnCanvas(grabCanvas, poseRes, frameIndex = 0, overrideImagePose = null) {
    if (!this.faceLandmarker || !grabCanvas || grabCanvas.width < 16 || grabCanvas.height < 16) return null;
    const imagePose = overrideImagePose || (poseRes ? firstPose(poseRes.landmarks) : null);
    if (!imagePose || imagePose.length < 13) return null;

    const nose = imagePose[0];
    const lEar = imagePose[7];
    const rEar = imagePose[8];
    const lSh = imagePose[11];
    const rSh = imagePose[12];
    if (!nose || num(nose.visibility, 0) < 0.20) return null;

    const w = grabCanvas.width;
    const h = grabCanvas.height;
    const cropSize = 224;
    if (!this._faceCropCanvas && typeof document !== 'undefined') {
      this._faceCropCanvas = document.createElement('canvas');
      this._faceCropCanvas.width = cropSize;
      this._faceCropCanvas.height = cropSize;
      this._faceCropCtx = this._faceCropCanvas.getContext('2d', { willReadFrequently: false });
      if (this._faceCropCtx) this._faceCropCtx.imageSmoothingQuality = 'high';
    }
    const cropCtx = this._faceCropCtx;
    if (!cropCtx) return null;

    let headSpanPx = w * 0.11;
    if (lEar && rEar && num(lEar.visibility, 0) > 0.2 && num(rEar.visibility, 0) > 0.2) {
      headSpanPx = Math.max(16, Math.hypot((lEar.x - rEar.x) * w, (lEar.y - rEar.y) * h) * 1.45);
    } else if (lSh && rSh) {
      headSpanPx = Math.max(18, Math.hypot((lSh.x - rSh.x) * w, (lSh.y - rSh.y) * h) * 0.52);
    }
    const boxHalfPx = Math.max(20, Math.min(Math.max(w, h) * 0.28, headSpanPx));
    const cx = num(nose.x) * w;
    const cy = num(nose.y) * h;
    const sx = Math.max(0, Math.min(w - 16, Math.round(cx - boxHalfPx)));
    const sy = Math.max(0, Math.min(h - 16, Math.round(cy - boxHalfPx * 1.05)));
    const sw = Math.max(16, Math.min(w - sx, Math.round(boxHalfPx * 2)));
    const sh = Math.max(16, Math.min(h - sy, Math.round(boxHalfPx * 2)));

    const packFace = (res) => {
      const fms = res?.facialTransformationMatrixes;
      const fbs = res?.faceBlendshapes;
      const flm = res?.faceLandmarks;
      if (!Array.isArray(flm) || flm.length === 0) return null;
      const matData = fms?.[0]?.data;
      const matrix = matData && matData.length >= 16 ? Array.from(matData) : null;
      const cats = fbs?.[0]?.categories || [];
      const blendshapes = {};
      for (const c of cats) {
        if (c?.categoryName) blendshapes[c.categoryName] = Number(c.score) || 0;
      }
      return {
        confidence: 0.9,
        matrix,
        blendshapes,
      };
    };

    try {
      cropCtx.clearRect(0, 0, cropSize, cropSize);
      cropCtx.drawImage(grabCanvas, sx, sy, sw, sh, 0, 0, cropSize, cropSize);
      const packed = packFace(this.faceLandmarker.detect(this._faceCropCanvas));
      if (packed) return packed;
    } catch {
      // fall through
    }
    // Only invoke slow full-frame fallback every 12th frame to avoid 2x inference cost per miss
    if (frameIndex % 12 === 0) {
      try {
        return packFace(this.faceLandmarker.detect(grabCanvas));
      } catch {
        return null;
      }
    }
    return null;
  }

  _detectPoseAndExtras(grabCanvas, tsMs, camEst, trackHands, trackFace = false, frameIndex = 0, subjectTracker = null, subjectOptions = null) {
    const poseRes = this._detectForVideo(grabCanvas, tsMs);
    if (!poseRes || typeof poseRes !== 'object') return poseRes;
    const sel = subjectTracker
      ? selectTrackedPose(poseRes, subjectTracker, subjectOptions || {})
      : { index: 0, imagePose: firstPose(poseRes.landmarks), worldPose: firstPose(poseRes.worldLandmarks), count: 1 };
    poseRes._selectedPose = sel;
    const chosenImagePose = sel.imagePose || firstPose(poseRes.landmarks);
    if (camEst) {
      const mask = CameraMotionEstimator.maskFromLandmarks(chosenImagePose, 0.11);
      poseRes._cameraMotion = camEst.feedMediaSource(grabCanvas, mask);
    }
    if (trackHands && this.handLandmarker) {
      poseRes._hands = this._detectHandsOnCanvas(grabCanvas, poseRes, chosenImagePose);
    }
    if (trackFace && this.faceLandmarker) {
      poseRes._face = this._detectFaceOnCanvas(grabCanvas, poseRes, frameIndex, chosenImagePose);
    }
    return poseRes;
  }

  /** WebAssembly + Canvas are the only hard requirements (GPU delegate optional). */
  static isSupported() {
    if (typeof WebAssembly === 'undefined') return false;
    if (typeof document === 'undefined') return false;
    try {
      const canvas = document.createElement('canvas');
      return !!(canvas.getContext('2d') || canvas.getContext('webgl2'));
    } catch (_) {
      return false;
    }
  }

  /**
   * Converts MediaPipe world landmarks (meters, hip origin) into studio joints.
   * Frames with too little core visibility are rejected so the gap filler can
   * interpolate them instead of injecting garbage.
   * @param {Array<{x:number,y:number,z:number,visibility?:number}>} worldLandmarks
   * @returns {Object|null}
   */
  poseToJoints(worldLandmarks, imageLandmarks = null) {
    return BrowserMocapEngine.poseToJoints(worldLandmarks, this.config.minCoreVisibility, imageLandmarks);
  }

  static poseToJoints(
    worldLandmarks,
    minCoreVisibility = DEFAULT_MEDIAPIPE_CONFIG.minCoreVisibility,
    imageLandmarks = null,
  ) {
    if (!Array.isArray(worldLandmarks) || worldLandmarks.length < 29) return null;
    let coreVis = 0;
    for (const idx of CORE_LANDMARKS) {
      const lm = worldLandmarks[idx];
      coreVis += lm ? Math.max(0, Math.min(1, num(lm.visibility, 1))) : 0;
    }
    coreVis /= CORE_LANDMARKS.length;
    if (coreVis < minCoreVisibility) return null;

    const joints = {};
    const visibilities = {};
    const hasImg = Array.isArray(imageLandmarks) && imageLandmarks.length >= 29;
    for (const joint of SKELETON_JOINTS) {
      const lmIdx = POSE_LANDMARK_INDEX[joint];
      const lm = worldLandmarks[lmIdx];
      if (!lm) continue;
      joints[joint] = [num(lm.x), num(lm.y), num(lm.z)];
      const wVis = Math.max(0, Math.min(1, num(lm.visibility, 0.95)));
      if (hasImg && imageLandmarks[lmIdx]) {
        const iVis = Math.max(0, Math.min(1, num(imageLandmarks[lmIdx].visibility, wVis)));
        visibilities[joint] = Number((0.65 * wVis + 0.35 * iVis).toFixed(4));
      } else {
        visibilities[joint] = Number(wVis.toFixed(4));
      }
    }
    const heels = {};
    for (const [extraJoint, lmIdx] of Object.entries(EXTRA_POSE_LANDMARK_INDEX)) {
      const lm = worldLandmarks[lmIdx];
      if (!lm) continue;
      heels[extraJoint] = [num(lm.x), num(lm.y), num(lm.z)];
      const wVis = Math.max(0, Math.min(1, num(lm.visibility, 0.8)));
      if (hasImg && imageLandmarks[lmIdx]) {
        const iVis = Math.max(0, Math.min(1, num(imageLandmarks[lmIdx].visibility, wVis)));
        visibilities[extraJoint] = Number((0.65 * wVis + 0.35 * iVis).toFixed(4));
      } else {
        visibilities[extraJoint] = Number(wVis.toFixed(4));
      }
    }
    return { joints, heels, confidence: coreVis, visibilities };
  }

  /**
   * Builds the `landmarks2D` overlay rows: [x, y, visibility] per landmark
   * (normalized image coordinates), matching what the server engine returns.
   */
  static landmarks2DFrom(normalizedLandmarks) {
    if (!Array.isArray(normalizedLandmarks)) return [];
    return normalizedLandmarks.map((lm) => [
      num(lm && lm.x),
      num(lm && lm.y),
      Math.max(0, Math.min(1, num(lm && lm.visibility, 1))),
    ]);
  }

  /**
   * 2D hip descriptor used by the metric root trajectory: [cx, cy, torsoPx, conf].
   * Coordinates and torso length are expressed in milli-normalized units (x1000)
   * so the 3D-to-2D scale ratio stays meaningful without the video resolution.
   */
  static hip2DFrom(normalizedLandmarks, aspectRatio = 1.0) {
    if (!Array.isArray(normalizedLandmarks) || normalizedLandmarks.length < 25) return [0.5, 0.5, 0, 0];
    const aspect = Number.isFinite(aspectRatio) && aspectRatio > 0.25 && aspectRatio < 4.0 ? aspectRatio : 1.0;
    const lHip = normalizedLandmarks[23];
    const rHip = normalizedLandmarks[24];
    const lSh = normalizedLandmarks[11];
    const rSh = normalizedLandmarks[12];
    if (!lHip || !rHip || !lSh || !rSh) return [0.5 * aspect * 1000, 0.5 * 1000, 0, 0];
    // Keep hips and torso in the same isotropic unit (milli-normalized height)
    // so horizontal displacements and 3D-to-2D scale ratios stay true across 16:9, 4:3, and 9:16.
    const cx = ((num(lHip.x) + num(rHip.x)) / 2) * aspect * 1000;
    const cy = ((num(lHip.y) + num(rHip.y)) / 2) * 1000;
    const hipMidX = cx;
    const hipMidY = cy;
    // Shoulders must use the SAME milli-normalized unit as the hips, otherwise
    // the torso length is inflated ~1000x and the metric root trajectory dies.
    const shMidX = ((num(lSh.x) + num(rSh.x)) / 2) * aspect * 1000;
    const shMidY = ((num(lSh.y) + num(rSh.y)) / 2) * 1000;
    const torso = Math.hypot(shMidX - hipMidX, shMidY - hipMidY);
    const conf = Math.min(
      Math.max(0, Math.min(1, num(lHip.visibility, 1))),
      Math.max(0, Math.min(1, num(rHip.visibility, 1))),
    );
    return [cx, cy, torso, conf];
  }

  async init(overrides = {}) {
    if (this.disposed) throw new Error('BrowserMocapEngine has been disposed.');
    const kernelPromise = initMocapKernel().catch(() => false);
    const config = { ...this.config, ...overrides };
    const requestedTier = String(config.modelTier || 'full').toLowerCase();
    const defaultPoses = String(config.subjectMode || 'auto').toLowerCase() === 'single' ? 1 : 4;
    const requestedNumPoses = Math.max(1, Math.min(4, Math.round(num(config.numPoses, defaultPoses))));
    config.numPoses = requestedNumPoses;
    const usedCustom = typeof config.landmarkerFactory === 'function';

    const tierMatches = !this._activeModelTier || this._activeModelTier === requestedTier;
    const posesMatches = !this._activeNumPoses || this._activeNumPoses === requestedNumPoses;
    if (this.landmarker && (usedCustom || (tierMatches && posesMatches))) {
      await kernelPromise;
      return this.landmarker;
    }

    if (this.landmarker && typeof this.landmarker.close === 'function') {
      try { this.landmarker.close(); } catch (_) { /* ignore */ }
      this.landmarker = null;
      this._lastDetectTsMs = -1;
      this._detectSessionBaseMs = 0;
    }

    this._usedCustomFactory = usedCustom;
    const factory = config.landmarkerFactory || BrowserMocapEngine.createLandmarker;
    let [landmarker] = await Promise.all([factory(config), kernelPromise]);
    while (typeof landmarker === 'function') {
      landmarker = await landmarker(config);
    }
    this.landmarker = landmarker;
    this._activeModelTier = requestedTier;
    this._activeNumPoses = requestedNumPoses;
    this.ready = true;
    return this.landmarker;
  }

  /**
   * Lazily loads the MediaPipe Tasks runtime + pose model.
   * Order: requested modelTier (heavy/full/lite) -> default localModel -> CDN fallbacks.
   * GPU delegate falls back to CPU automatically on blocked WebGL/older laptops.
   */
  static async createLandmarker(config) {
    const tier = String(config.modelTier || 'full').toLowerCase();
    const localTierModel = config.localModels?.[tier];
    const cdnTierModel = config.modelUrls?.[tier];
    const hasExplicitSingleModel = config.localModel && config.localModel !== DEFAULT_MEDIAPIPE_CONFIG.localModel;
    const dedupe = (arr) => arr.filter((v, idx) => Boolean(v) && arr.indexOf(v) === idx);

    const coepIsolated = typeof globalThis !== 'undefined' && Boolean(globalThis.crossOriginIsolated);
    const r = (u) => (u ? resolveCdnAssetUrl(u) : null);
    const localCandidates = hasExplicitSingleModel
      ? dedupe([r(config.localModel), r(localTierModel), r(config.localModels?.full), r(config.localModels?.lite), !coepIsolated ? config.modelUrl : null, !coepIsolated ? cdnTierModel : null])
      : dedupe([r(localTierModel), r(config.localModel), r(config.localModels?.full), r(config.localModels?.lite), !coepIsolated ? cdnTierModel : null, !coepIsolated ? config.modelUrl : null]);
    const cdnCandidates = dedupe([cdnTierModel, config.modelUrl, config.modelUrls?.full]);

    const sources = [];
    if (config.localBundle) {
      sources.push({
        bundle: r(config.localBundle),
        wasmBase: r(config.localWasmBase),
        models: localCandidates,
      });
    }
    if (!coepIsolated) {
      sources.push({ bundle: `${config.cdnBase}/vision_bundle.mjs`, wasmBase: config.wasmBase, models: cdnCandidates });
    }

    let lastError = null;
    for (const source of sources) {
      let vision;
      try {
        vision = await import(/* webpackIgnore: true */ source.bundle);
      } catch (err) {
        lastError = err;
        continue;
      }

      let fileset;
      try {
        fileset = await vision.FilesetResolver.forVisionTasks(source.wasmBase);
      } catch (err) {
        lastError = err;
        continue;
      }

      for (const modelAssetPath of source.models) {
        for (const delegate of [config.delegate, 'CPU'].filter((d, i, all) => all.indexOf(d) === i)) {
          try {
            const numPoses = Math.max(1, Math.min(4, Math.round(num(config.numPoses, 4))));
            return await BrowserMocapEngine._withQuietTfliteInfo(() =>
              vision.PoseLandmarker.createFromOptions(fileset, {
                baseOptions: { modelAssetPath, delegate },
                runningMode: 'VIDEO',
                numPoses,
                minPoseDetectionConfidence: 0.5,
                minPosePresenceConfidence: 0.5,
                minTrackingConfidence: 0.5,
              })
            );
          } catch (err) {
            lastError = err;
          }
        }
      }
    }
    throw lastError || new Error('Unable to load MediaPipe Pose Landmarker.');
  }

  /** Redirect benign MediaPipe TFLite XNNPACK C++ stderr INFO lines away from console.error. */
  static async _withQuietTfliteInfo(fn) {
    if (typeof console === 'undefined' || typeof console.error !== 'function') return fn();
    const origError = console.error;
    console.error = (...args) => {
      const first = typeof args[0] === 'string' ? args[0] : '';
      if (first.startsWith('INFO: Created TensorFlow Lite XNNPACK delegate')) {
        if (typeof console.info === 'function') console.info(...args);
        return;
      }
      origError.apply(console, args);
    };
    try {
      return await fn();
    } finally {
      if (console.error !== origError) console.error = origError;
    }
  }

  static async createHandLandmarker(config) {
    const sources = [];
    if (config.localBundle) {
      sources.push({
        bundle: resolveCdnAssetUrl(config.localBundle),
        wasmBase: resolveCdnAssetUrl(config.localWasmBase),
        models: [resolveCdnAssetUrl(config.localHandModel), config.handModelUrl].filter(Boolean),
      });
    }
    if (config.cdnBase && config.handModelUrl) {
      sources.push({ bundle: `${config.cdnBase}/vision_bundle.mjs`, wasmBase: config.wasmBase, models: [config.handModelUrl] });
    }

    let lastError = null;
    for (const source of sources) {
      let vision;
      try {
        vision = await import(/* webpackIgnore: true */ source.bundle);
      } catch (err) {
        lastError = err;
        continue;
      }
      if (!vision?.HandLandmarker) continue;

      let fileset;
      try {
        fileset = await vision.FilesetResolver.forVisionTasks(source.wasmBase);
      } catch (err) {
        lastError = err;
        continue;
      }

      for (const modelAssetPath of source.models) {
        for (const delegate of [config.delegate, 'CPU'].filter((d, i, all) => all.indexOf(d) === i)) {
          try {
            return await BrowserMocapEngine._withQuietTfliteInfo(() =>
              vision.HandLandmarker.createFromOptions(fileset, {
                baseOptions: { modelAssetPath, delegate },
                runningMode: 'IMAGE',
                numHands: 2,
                minHandDetectionConfidence: 0.40,
                minHandPresenceConfidence: 0.40,
                minTrackingConfidence: 0.40,
              })
            );
          } catch (err) {
            lastError = err;
          }
        }
      }
    }
    if (lastError) throw lastError;
    return null;
  }

  static async createFaceLandmarker(config) {
    const sources = [];
    if (config.localBundle) {
      sources.push({
        bundle: resolveCdnAssetUrl(config.localBundle),
        wasmBase: resolveCdnAssetUrl(config.localWasmBase),
        models: [resolveCdnAssetUrl(config.localFaceModel), config.faceModelUrl].filter(Boolean),
      });
    }
    if (config.cdnBase && config.faceModelUrl) {
      sources.push({ bundle: `${config.cdnBase}/vision_bundle.mjs`, wasmBase: config.wasmBase, models: [config.faceModelUrl] });
    }

    let lastError = null;
    for (const source of sources) {
      let vision;
      try {
        vision = await import(/* webpackIgnore: true */ source.bundle);
      } catch (err) {
        lastError = err;
        continue;
      }
      if (!vision?.FaceLandmarker) continue;

      let fileset;
      try {
        fileset = await vision.FilesetResolver.forVisionTasks(source.wasmBase);
      } catch (err) {
        lastError = err;
        continue;
      }

      for (const modelAssetPath of source.models) {
        for (const delegate of [config.delegate, 'CPU'].filter((d, i, all) => all.indexOf(d) === i)) {
          try {
            return await BrowserMocapEngine._withQuietTfliteInfo(() =>
              vision.FaceLandmarker.createFromOptions(fileset, {
                baseOptions: { modelAssetPath, delegate },
                runningMode: 'IMAGE',
                numFaces: 1,
                outputFaceBlendshapes: true,
                outputFacialTransformationMatrixes: true,
                minFaceDetectionConfidence: 0.20,
                minFacePresenceConfidence: 0.20,
                minTrackingConfidence: 0.20,
              })
            );
          } catch (err) {
            lastError = err;
          }
        }
      }
    }
    if (lastError) throw lastError;
    return null;
  }

  /**
   * Core, framework-free loop: samples N frames through `sampler`, filters them
   * and returns a server-compatible payload. `sampler(index, timeSec)` must
   * return `{worldLandmarks, landmarks}` (or null when no pose was found).
   *
   * @param {{fps?:number, totalFrames?:number, maxFrames?:number, frameStep?:number,
   *          sampler:Function, onProgress?:Function, signal?:AbortSignal,
   *          footLock?:boolean, videoWidth?:number, videoHeight?:number}} options
   */
  async processFrames(options = {}) {
    const {
      sampler,
      onProgress,
      signal,
      footLock = true,
    } = options;
    if (typeof sampler !== 'function') throw new Error('processFrames requires a sampler function.');

    const fps = Math.max(1, num(options.fps, 30));
    const totalFrames = Math.max(1, Math.floor(num(options.totalFrames, 1)));
    const frameStep = Math.max(1, Math.floor(num(options.frameStep, 1)));
    const maxFrames = Math.max(0, Math.floor(num(options.maxFrames, 0)));

    const indices = [];
    for (let i = 0; i < totalFrames; i += frameStep) {
      if (maxFrames > 0 && indices.length >= maxFrames) break;
      indices.push(i);
    }

    const jointSeries = [];
    const jointVisSeries = [];
    const hip2dSeries = [];
    const landmarks2D = [];
    const handFrames = [];
    const faceFrames = [];
    const cameraMotionSeries = [];
    const actualTimes = [];
    let hasActualTimes = false;
    let hasAnyHands = false;
    let hasAnyFaces = false;
    let hasAnyCamMotion = false;
    let detected = 0;
    let last = null;

    const vw = num(options.videoWidth, 0);
    const vh = num(options.videoHeight, 0);
    const aspectRatio = vw > 0 && vh > 0 ? vw / vh : 1.0;
    const subjectTracker = options.subjectTracker || createSubjectTrackerState(options);
    const subjectOptions = {
      subjectMode: options.subjectMode ?? this.config.subjectMode,
      subjectIndex: options.subjectIndex,
      frameStep,
    };

    for (let k = 0; k < indices.length; k++) {
      if (signal && signal.aborted) throw abortError();
      const index = indices[k];
      const timeSec = index / fps;

      let pose = null;
      try {
        pose = await sampler(index, timeSec);
      } catch (err) {
        if (err && err.name === 'AbortError') throw err;
        console.warn(`[browser-mocap] Sampler error at frame ${index}:`, err);
        pose = null;
      }

      if (pose && Number.isFinite(pose._actualTimeSec)) {
        actualTimes.push(Number(pose._actualTimeSec.toFixed(5)));
        hasActualTimes = true;
      } else {
        actualTimes.push(Number(timeSec.toFixed(5)));
      }

      const sel = pose
        ? (pose._selectedPose || selectTrackedPose(pose, subjectTracker, subjectOptions))
        : { index: -1, worldPose: null, imagePose: null, count: 0 };
      const worldPose = sel.worldPose;
      const imagePose = sel.imagePose;
      const joints = worldPose
        ? BrowserMocapEngine.poseToJoints(worldPose, this.config.minCoreVisibility, imagePose)
        : null;

      if (joints) {
        const merged = joints.heels && Object.keys(joints.heels).length > 0
          ? { ...joints.joints, ...joints.heels }
          : joints.joints;
        jointSeries.push(merged);
        jointVisSeries.push(joints.visibilities || {});
        last = merged;
        detected += 1;
      } else {
        // Keep the timeline length stable; mark visibilities empty so Rust C1 gap-filler inpaints cleanly.
        jointSeries.push(last ? { ...last } : {});
        jointVisSeries.push({});
      }

      const hFrame = pose?._hands || pose?.hands || null;
      if (hFrame && (hFrame.left || hFrame.right)) hasAnyHands = true;
      handFrames.push(hFrame);

      const fFrame = pose?._face || pose?.face || null;
      if (fFrame && (fFrame.matrix || fFrame.blendshapes)) hasAnyFaces = true;
      faceFrames.push(fFrame);

      const camFrame = pose?._cameraMotion || pose?.cameraMotion || null;
      if (camFrame) hasAnyCamMotion = true;
      cameraMotionSeries.push(camFrame);

      hip2dSeries.push(BrowserMocapEngine.hip2DFrom(imagePose, aspectRatio));
      landmarks2D.push(BrowserMocapEngine.landmarks2DFrom(imagePose));

      if (typeof onProgress === 'function') {
        onProgress({
          processed: k + 1,
          total: indices.length,
          percent: ((k + 1) / Math.max(1, indices.length)) * 100,
          detected,
          fps,
        });
      }
    }

    if (detected === 0) {
      throw new Error('No human pose detected in the video (MediaPipe found no skeleton landmarks).');
    }

    // Filter out isolated 1-2 frame spatial teleport spikes (e.g. an intruder flashing into view
    // when running single-pose or brief detector jump) so C1 gap-fill smoothly inpaints across them.
    if (detected >= 5) {
      const validTorsos = [];
      for (let i = 0; i < jointVisSeries.length; i++) {
        if (Object.keys(jointVisSeries[i]).length > 0 && hip2dSeries[i]?.[2] > 5) {
          validTorsos.push(hip2dSeries[i][2]);
        }
      }
      if (validTorsos.length >= 4) {
        validTorsos.sort((a, b) => a - b);
        const medTorso = Math.max(40, validTorsos[Math.floor(validTorsos.length / 2)]);
        const isDetectedIdx = (idx) => idx >= 0 && idx < jointVisSeries.length && Object.keys(jointVisSeries[idx]).length > 0;
        const flagged = [];
        for (let i = 1; i < indices.length - 1; i++) {
          if (!isDetectedIdx(i)) continue;
          let prev = i - 1;
          while (prev >= 0 && !isDetectedIdx(prev)) prev--;
          if (prev < 0 || (i - prev) > 3) continue;
          // Check both 1-frame and 2-frame outlier islands
          for (const runLen of [1, 2]) {
            const endIdx = i + runLen - 1;
            if (endIdx >= indices.length - 1) continue;
            if (runLen === 2 && !isDetectedIdx(endIdx)) continue;
            let next = endIdx + 1;
            while (next < indices.length && !isDetectedIdx(next)) next++;
            if (next >= indices.length || (next - endIdx) > 3) continue;
            const hp = hip2dSeries[prev];
            const hn = hip2dSeries[next];
            const chordDist = Math.hypot(hn[0] - hp[0], hn[1] - hp[1]);
            if (chordDist > medTorso * 0.85) continue;
            let allSpiked = true;
            for (let m = i; m <= endIdx; m++) {
              const hm = hip2dSeries[m];
              const alpha = (m - prev) / Math.max(1, next - prev);
              const ix = hp[0] + (hn[0] - hp[0]) * alpha;
              const iy = hp[1] + (hn[1] - hp[1]) * alpha;
              const itorso = hp[2] + (hn[2] - hp[2]) * alpha;
              const dev = Math.hypot(hm[0] - ix, hm[1] - iy);
              const scaleDev = Math.abs(hm[2] - itorso) / Math.max(30, itorso);
              if (!(dev > medTorso * 1.20 || (dev > medTorso * 0.70 && scaleDev > 0.55))) {
                allSpiked = false;
                break;
              }
            }
            if (allSpiked) {
              for (let m = i; m <= endIdx; m++) flagged.push({ m, prev, next });
              break;
            }
          }
        }
        for (const { m, prev, next } of flagged) {
          const hp = hip2dSeries[prev];
          const hn = hip2dSeries[next];
          const alpha = (m - prev) / Math.max(1, next - prev);
          jointSeries[m] = {};
          jointVisSeries[m] = {};
          hip2dSeries[m] = [
            hp[0] + (hn[0] - hp[0]) * alpha,
            hp[1] + (hn[1] - hp[1]) * alpha,
            hp[2] + (hn[2] - hp[2]) * alpha,
            0,
          ];
          subjectTracker.blockedIntruders = (subjectTracker.blockedIntruders || 0) + 1;
        }
      }
    }

    // Frames are sampled every `frameStep` video frames: the timestamp spacing
    // preserves actual VFR frame times when provided (normalized monotonic).
    let sampleFps = Math.max(1, fps / frameStep);
    const useActualTimes = hasActualTimes && actualTimes.length === indices.length && !options.fixedUniformTimes;
    let prevT = -1;
    const times = useActualTimes
      ? actualTimes.map((t) => {
        const clamped = prevT < 0 ? Math.max(0, t) : Math.max(prevT + 1e-4, t);
        prevT = clamped;
        return Number(clamped.toFixed(5));
      })
      : indices.map((index) => Number((index / fps).toFixed(5)));
    if (useActualTimes && times.length >= 2) {
      const dts = [];
      for (let i = 1; i < times.length; i++) {
        const dt = times[i] - times[i - 1];
        if (dt > 1e-4 && dt < 1.0) dts.push(dt);
      }
      if (dts.length > 0) {
        const medDt = medianOf(dts);
        if (medDt > 1e-4) sampleFps = Math.max(1, Math.min(240, 1 / medDt));
      }
    }

    await initMocapKernel().catch(() => false);

    // Always produce immutable unlocked frames first so Re-Apply & Foot-Lock toggles
    // never double-mutate or permanently lose unlocked motion.
    let rawMocapFrames = null;
    let frames = null;
    let locked = { left: 0, right: 0 };
    let footLockFlags = null;

    const camSeriesResolved = Array.isArray(options.cameraMotionSeries)
      ? options.cameraMotionSeries
      : (hasAnyCamMotion ? cameraMotionSeries : null);

    if (isMocapKernelReady()) {
      const wasmRaw = processJointsWasm(jointSeries, {
        fps: sampleFps,
        times,
        hip2dSeries,
        visibilities: jointVisSeries,
        landmarks2D,
        cameraMotionSeries: camSeriesResolved,
        videoWidth: vw,
        videoHeight: vh,
        aspectRatio,
        temporalLifting: options.temporalLifting !== false,
        footLock: false,
        occlusionStrength: num(options.occlusionStrength, 0.92),
        sgPasses: Math.max(0, Math.round(num(options.sgPasses, 1))),
      });
      if (wasmRaw && Array.isArray(wasmRaw.frames)) {
        rawMocapFrames = wasmRaw.frames;
        frames = rawMocapFrames;
        if (footLock) {
          const wasmLock = applyFootLockWasm(rawMocapFrames, {
            fps: sampleFps,
            visSeries: jointVisSeries,
          });
          if (wasmLock) {
            frames = wasmLock.frames;
            locked = wasmLock.locked;
            footLockFlags = wasmLock.flags;
          }
        }
      }
    }

    if (!rawMocapFrames) {
      rawMocapFrames = processJointSeries(jointSeries, {
        fps: sampleFps,
        times,
        hip2dSeries,
      });
      frames = rawMocapFrames;
      if (footLock) {
        const result = applyFootLock(rawMocapFrames, { fps: sampleFps });
        frames = result.frames;
        locked = result.locked;
      }
    }

    const coveragePct = Math.min(100, ((indices.length * frameStep) / totalFrames) * 100);
    const lastTime = times.length ? times[times.length - 1] : 0;
    const duration = frames.length > 1 ? lastTime : 0;

    return {
      success: true,
      engine: 'browser-wasm',
      kernelEngine: isMocapKernelReady() ? 'rust-wasm' : 'js',
      modelTier: this._activeModelTier || String(options.modelTier || this.config.modelTier || 'full'),
      fps: Number(sampleFps.toFixed(3)),
      videoFps: fps,
      duration,
      totalVideoDuration: totalFrames / fps,
      numFrames: frames.length,
      totalVideoFrames: totalFrames,
      frameStep,
      isFullVideo: maxFrames <= 0 || coveragePct >= 98,
      coveragePct: Number(coveragePct.toFixed(1)),
      videoWidth: num(options.videoWidth, 0),
      videoHeight: num(options.videoHeight, 0),
      landmarks2D,
      rawJointSeries: jointSeries,
      rawJointVisibilities: jointVisSeries,
      hip2dSeries,
      handFrames: hasAnyHands ? handFrames : null,
      faceFrames: hasAnyFaces ? faceFrames : null,
      cameraMotionSeries: camSeriesResolved,
      rawMocapFrames,
      mocapFrames: frames,
      footLockFlags,
      detectedFrames: detected,
      detectionRate: Number((detected / Math.max(1, indices.length)).toFixed(3)),
      footLockFrames: locked,
      multiPersonStats: {
        numPoses: Math.max(1, Math.min(4, Math.round(num(options.numPoses ?? this._activeNumPoses ?? this.config.numPoses, 4)))),
        subjectMode: String(subjectOptions.subjectMode || 'auto'),
        maxPeopleDetected: subjectTracker.maxPeople || 0,
        multiPersonFrames: subjectTracker.multiPersonFrames || 0,
        subjectSwitches: subjectTracker.subjectSwitches || 0,
        blockedIntruders: subjectTracker.blockedIntruders || 0,
      },
    };
  }

  /**
   * Tracks a whole video file entirely client-side (no server round-trip, no
   * upload). Fast path: demux + sequential WebCodecs VideoDecoder when
   * available (see video-decoder.js); fallback: seeking the paused <video>
   * per frame. Both paths feed the same canvas + PoseLandmarker pipeline and
   * produce the identical output schema. `result.decodePath` (and
   * `engine.lastDecodePath`) report which path ran: 'webcodecs' | 'seek'.
   */
  async processVideo(video, options = {}) {
    if (!video) throw new Error('No video provided for analysis.');
    if (typeof video.duration !== 'number' || !Number.isFinite(video.duration) || video.duration <= 0) {
      throw new Error('Video is not ready (missing duration). Load the video and try again.');
    }
    await this.init(options);

    const explicitFps = Number.isFinite(Number(options.videoFps)) && Number(options.videoFps) > 0
      ? Math.max(1, Number(options.videoFps))
      : null;
    const fps = explicitFps ?? 30;
    const totalFrames = Math.max(1, Math.round(video.duration * fps));
    const wasPaused = video.paused;
    const startTime = video.currentTime;
    this.lastDecodePath = 'seek';

    // Frames are copied into a small canvas before inference: MediaPipe's WASM
    // path does not reliably read the decoded texture of a paused <video> that
    // was just seeked (Electron/Chromium), and 640px is plenty for pose.
    const grab = document.createElement('canvas');
    const grabCtx = grab.getContext('2d', { willReadFrequently: false });
    const maxDim = 640;

    const wantHands = options.trackHands !== false;
    if (wantHands) {
      await this._ensureHandLandmarker();
    }
    const wantFace = options.trackFace !== false;
    if (wantFace) {
      await this._ensureFaceLandmarker();
    }
    const camEst = options.compensateCamera !== false ? new CameraMotionEstimator() : null;
    const subjectOptions = {
      subjectMode: options.subjectMode ?? this.config.subjectMode,
      subjectIndex: options.subjectIndex,
      frameStep: Math.max(1, Math.floor(num(options.frameStep, 1))),
    };

    // Fast path: sequential WebCodecs decode (no per-frame seeking). Any
    // demux/codec/source failure falls back to the proven seek loop below.
    if (options.webCodecs !== false && isWebCodecsSupported()) {
      this._beginDetectSession();
      try {
        camEst?.reset();
        const subjectTracker = createSubjectTrackerState(subjectOptions);
        const result = await this._processVideoWebCodecs(video, options, {
          fps, explicitFps, totalFrames, grab, grabCtx, maxDim, camEst, trackHands: wantHands, trackFace: wantFace,
          subjectTracker, subjectOptions,
        });
        if (result) {
          if (!Number.isFinite(result.videoFps) || result.videoFps <= 0) result.videoFps = fps;
          result.decodePath = 'webcodecs';
          this.lastDecodePath = 'webcodecs';
          return result;
        }
      } catch (err) {
        if (err && err.name === 'AbortError') throw err;
        console.warn('[browser-mocap] WebCodecs decode failed — falling back to per-frame seek:', err);
      }
    }

    const seek = async (timeSec) => {
      // Chỉ bỏ qua seek khi đã đúng thời điểm VÀ đã có frame decoded; nếu chưa
      // (readyState<2, headless/video mới load) phải seek thật để kích hoạt decode.
      if (Math.abs(video.currentTime - timeSec) < 1 / (fps * 4) && video.readyState >= 2) return;
      await new Promise((resolve) => {
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          video.removeEventListener('seeked', finish);
          resolve();
        };
        video.addEventListener('seeked', finish, { once: true });
        try {
          video.currentTime = Math.min(timeSec, Math.max(0, video.duration - 0.001));
        } catch (_) {
          finish();
        }
        setTimeout(finish, 1500);
      });
    };

    try {
      if (!video.paused) video.pause();
      camEst?.reset();
      this._beginDetectSession();
      const subjectTracker = createSubjectTrackerState(subjectOptions);
      const result = await this.processFrames({
        ...options,
        fps,
        totalFrames,
        videoWidth: video.videoWidth,
        videoHeight: video.videoHeight,
        subjectTracker,
        sampler: async (index, timeSec) => {
          await seek(timeSec);
          await new Promise((resolve) => {
            if (typeof video.requestVideoFrameCallback === 'function') {
              video.requestVideoFrameCallback(() => resolve());
              setTimeout(resolve, 120);
            } else {
              setTimeout(resolve, 40);
            }
          });
          const vw = video.videoWidth || 1280;
          const vh = video.videoHeight || 720;
          const scale = Math.min(1, maxDim / Math.max(vw, vh));
          const w = Math.max(2, Math.round(vw * scale));
          const h = Math.max(2, Math.round(vh * scale));
          if (grab.width !== w || grab.height !== h) {
            grab.width = w;
            grab.height = h;
          }
          // Headless/seek sớm có thể chưa decode frame đầu (readyState<2) khiến
          // drawImage ném InvalidStateError; chờ frame sẵn sàng trước khi copy.
          if (video.readyState < 2) {
            await new Promise((resolve) => {
              const timer = setTimeout(resolve, 500);
              video.addEventListener('loadeddata', () => { clearTimeout(timer); resolve(); }, { once: true });
            });
          }
          grabCtx.drawImage(video, 0, 0, w, h);
          const ts = Math.round(index * (1000 / fps));
          return this._detectPoseAndExtras(
            grab, ts, camEst, wantHands, wantFace, index, subjectTracker, subjectOptions,
          );
        },
      });
      result.videoFps = fps;
      result.decodePath = 'seek';
      this.lastDecodePath = 'seek';
      return result;
    } finally {
      try {
        video.currentTime = startTime;
        if (!wasPaused) video.play().catch(() => {});
      } catch (_) {
        // Restoring playback state is best-effort only.
      }
    }
  }

  /**
   * WebCodecs fast path: fetch the video bytes (from `options.videoSource`
   * when given, else the element's src), demux MP4/WebM and decode frames
   * sequentially, mapping each requested sample index to the decoded frame
   * whose presentation timestamp is closest to index/fps. Returns null when
   * the byte source is unavailable (caller falls back to seeking); throws a
   * tagged error on mid-stream decode/demux failure so processVideo can
   * discard partial results and restart with the seek loop. AbortError is
   * always propagated untouched.
   * @private
   */
  async _processVideoWebCodecs(video, options, ctx) {
    const { fps, totalFrames, grab, grabCtx, maxDim } = ctx;
    const signal = options.signal;

    let source = options.videoSource;
    if (source && typeof source.arrayBuffer === 'function') {
      source = await source.arrayBuffer(); // Blob / File
    } else if (!source || typeof source === 'string') {
      const url = typeof source === 'string' ? source : (video.currentSrc || video.src);
      if (!url) return null; // srcObject / detached element -> seek fallback
      let response;
      try {
        response = await fetch(url, signal ? { signal } : undefined);
      } catch (err) {
        if (err && err.name === 'AbortError') throw err;
        return null; // unreadable src (cross-origin, revoked blob) -> fallback
      }
      if (!response.ok) return null;
      source = await response.arrayBuffer();
    }

    const stream = await openVideoFrameStream(source, {
      signal,
      mp4boxUrl: options.mp4boxUrl || this.config.mp4boxUrl,
    });

    const effFps = ctx.explicitFps
      ?? ((Number.isFinite(stream.fps) && stream.fps >= 5 && stream.fps <= 240) ? stream.fps : fps);
    const effTotalFrames = ctx.explicitFps
      ? totalFrames
      : (stream.frameCount > 0 ? stream.frameCount : Math.max(1, Math.round((stream.durationSec || video.duration || 1) * effFps)));
    const rotationDeg = ((Number(stream.rotationDeg || 0) % 360) + 360) % 360;
    const swapRot = rotationDeg === 90 || rotationDeg === 270;
    const orientedW = swapRot
      ? (stream.codedHeight || video.videoWidth || 0)
      : (video.videoWidth || stream.codedWidth || 0);
    const orientedH = swapRot
      ? (stream.codedWidth || video.videoHeight || 0)
      : (video.videoHeight || stream.codedHeight || 0);

    const fallbackError = (message) => {
      const err = new Error(message);
      err.name = 'WebCodecsFallbackError';
      return err;
    };
    let streamError = null;
    let pending = null;
    let hasDrawnFrame = false;
    let lastDrawnTimeSec = -1;
    let lastPose = null;
    const advance = async () => {
      pending = await stream.next();
    };
    const drawAndDetect = (frame, index, frameTimeSec) => {
      const rawW = frame.displayWidth || frame.codedWidth || 1280;
      const rawH = frame.displayHeight || frame.codedHeight || 720;
      const vw = swapRot ? rawH : rawW;
      const vh = swapRot ? rawW : rawH;
      const scale = Math.min(1, maxDim / Math.max(vw, vh));
      const w = Math.max(2, Math.round(vw * scale));
      const h = Math.max(2, Math.round(vh * scale));
      if (grab.width !== w || grab.height !== h) {
        grab.width = w;
        grab.height = h;
      }
      if (rotationDeg !== 0) {
        grabCtx.save();
        grabCtx.translate(w * 0.5, h * 0.5);
        grabCtx.rotate((rotationDeg * Math.PI) / 180);
        const dw = swapRot ? h : w;
        const dh = swapRot ? w : h;
        grabCtx.drawImage(frame, -dw * 0.5, -dh * 0.5, dw, dh);
        grabCtx.restore();
      } else {
        grabCtx.drawImage(frame, 0, 0, w, h);
      }
      hasDrawnFrame = true;
      lastDrawnTimeSec = frameTimeSec;
      // Monotonically increasing millisecond clock across videos and fallbacks.
      const ts = Math.round((ctx.explicitFps ? (index * (1000 / effFps)) : (frameTimeSec * 1000)));
      lastPose = this._detectPoseAndExtras(
        grab, ts, ctx.camEst, ctx.trackHands, ctx.trackFace, index, ctx.subjectTracker, ctx.subjectOptions,
      );
      if (lastPose && typeof lastPose === 'object' && !ctx.explicitFps) {
        lastPose._actualTimeSec = frameTimeSec;
      }
      return lastPose;
    };

    try {
      await advance();
      let result;
      try {
        result = await this.processFrames({
          ...options,
          fps: effFps,
          totalFrames: effTotalFrames,
          fixedUniformTimes: Boolean(ctx.explicitFps),
          videoWidth: orientedW,
          videoHeight: orientedH,
          subjectTracker: ctx.subjectTracker,
          sampler: async (index, timeSec) => {
            if (streamError) throw streamError;
            if (signal && signal.aborted) throw abortError();
            try {
              // Skip frames older than the requested sample window, tolerating VFR timing
              while (pending && pending.timeSec < timeSec - 0.5 / effFps) {
                pending.frame.close();
                await advance();
              }
              if (!pending) {
                if (hasDrawnFrame && (timeSec - lastDrawnTimeSec) <= Math.max(2.5 / effFps, 0.25)) {
                  // Reuse cached pose on trailing EOF frames so MediaPipe does not
                  // re-infer on frozen pixels and inject an end-frame jitter spike.
                  return lastPose && typeof lastPose === 'object' ? { ...lastPose } : lastPose;
                }
                throw fallbackError('WebCodecs: stream ended before the video duration.');
              }
              const maxDrift = ctx.explicitFps ? (1.5 / effFps) : Math.max(2.0, 4.0 / effFps);
              if (Math.abs(pending.timeSec - timeSec) > maxDrift) {
                throw fallbackError(`WebCodecs: timestamp drift (${pending.timeSec.toFixed(3)}s vs ${timeSec.toFixed(3)}s).`);
              }
              const frame = pending.frame;
              const frameTimeSec = pending.timeSec;
              pending = null;
              let pose;
              try {
                pose = drawAndDetect(frame, index, frameTimeSec);
              } finally {
                frame.close();
              }
              await advance();
              return pose;
            } catch (err) {
              if (err && err.name === 'AbortError') throw err;
              streamError = err;
              throw err;
            }
          },
        });
      } catch (err) {
        // processFrames swallows sampler errors into null poses; surface the
        // underlying decode failure so processVideo restarts with seeking.
        if (streamError) throw streamError;
        throw err;
      }
      if (streamError) throw streamError;
      if (result) result.videoFps = effFps;
      return result;
    } finally {
      if (pending && pending.frame) {
        try { pending.frame.close(); } catch (_) { /* already closed */ }
      }
      stream.cancel();
    }
  }

  dispose() {
    this.disposed = true;
    this.ready = false;
    try {
      if (this.landmarker && typeof this.landmarker.close === 'function') this.landmarker.close();
      if (this.handLandmarker && typeof this.handLandmarker.close === 'function') this.handLandmarker.close();
      if (this.faceLandmarker && typeof this.faceLandmarker.close === 'function') this.faceLandmarker.close();
    } catch (_) {
      // Closing a WASM landmarker must never break teardown.
    }
    this.landmarker = null;
    this._activeModelTier = null;
    this._activeNumPoses = null;
    this.handLandmarker = null;
    this._handLandmarkerAttempted = false;
    this._handCropCanvas = null;
    this._handCropCtx = null;
    this.faceLandmarker = null;
    this._faceLandmarkerAttempted = false;
    this._faceCropCanvas = null;
    this._faceCropCtx = null;
    this._lastDetectTsMs = -1;
    this._detectSessionBaseMs = 0;
  }
}
