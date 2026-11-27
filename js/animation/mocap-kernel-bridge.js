/**
 * @file mocap-kernel-bridge.js
 * @description JavaScript -> Rust WASM bridge for `vendor/wasm/mocap_kernel.wasm`.
 * Accelerates signal post-processing (despike, 1-Euro, Z stabilization, bone lengths,
 * smooth Hermite ease-out Foot-Lock IK) and 20-bone FK + Pole-Vector humanoid retargeting.
 */

import { BONE_CHAINS } from './mocap-filters.js';
import { median as medianOf } from './mocap-math.js';

export const BONE_ORDER = Object.freeze([
  'hips', 'spine', 'spine1', 'spine2', 'neck', 'head',
  'leftShoulder', 'leftArm', 'leftForearm', 'leftHand',
  'rightShoulder', 'rightArm', 'rightForearm', 'rightHand',
  'leftUpLeg', 'leftLeg', 'leftFoot',
  'rightUpLeg', 'rightLeg', 'rightFoot',
  'leftToeBase', 'rightToeBase',
]);

export const BONE_SLOT_FLOATS = 18;

export const JOINT_ORDER = Object.freeze([
  'midHip', 'spine', 'neck', 'head', 'nose', 'leftEar', 'rightEar',
  'leftShoulder', 'leftElbow', 'leftWrist', 'leftHandIndex',
  'rightShoulder', 'rightElbow', 'rightWrist', 'rightHandIndex',
  'leftHip', 'leftKnee', 'leftAnkle', 'leftFoot',
  'rightHip', 'rightKnee', 'rightAnkle', 'rightFoot',
  'leftHeel', 'rightHeel',
]);

const JOINT_INDEX = Object.fromEntries(JOINT_ORDER.map((k, i) => [k, i]));

let wasmExports = null;
let loadPromise = null;

function resolveWasmUrl() {
  try {
    return new URL('../../vendor/wasm/mocap_kernel.wasm', import.meta.url);
  } catch {
    return '/vendor/wasm/mocap_kernel.wasm';
  }
}

export function isMocapKernelReady() {
  return wasmExports !== null;
}

export async function initMocapKernel() {
  if (wasmExports) return true;
  if (loadPromise) return loadPromise;

  loadPromise = (async () => {
    try {
      const wasmUrl = resolveWasmUrl();
      let bytes;

      const isNode = typeof process !== 'undefined' && Boolean(process.versions?.node);
      if (isNode) {
        const fsMod = await import(/* @vite-ignore */ 'node:fs/promises');
        const { fileURLToPath } = await import(/* @vite-ignore */ 'node:url');
        const filePath = wasmUrl instanceof URL ? fileURLToPath(wasmUrl) : wasmUrl;
        bytes = await fsMod.readFile(filePath);
      } else {
        const fetchTarget = typeof wasmUrl === 'string' ? wasmUrl : wasmUrl.href;
        const resp = await fetch(fetchTarget);
        if (!resp.ok) throw new Error(`HTTP ${resp.status} loading mocap_kernel.wasm`);
        bytes = await resp.arrayBuffer();
      }

      const { instance } = await WebAssembly.instantiate(bytes, {});
      wasmExports = instance.exports;
      return true;
    } catch (err) {
      console.warn('[MocapKernel] Failed to load Rust WASM kernel; JS fallback remains active:', err?.message || err);
      wasmExports = null;
      return false;
    }
  })();

  return loadPromise;
}

function allocWriteF32(arr) {
  const len = Math.max(1, arr.length);
  const bytes = len * 4;
  const ptr = wasmExports.mk_alloc(bytes);
  if (!ptr) throw new Error(`MocapKernel WASM OOM allocating ${bytes} bytes (f32)`);
  new Float32Array(wasmExports.memory.buffer, ptr, len).set(arr);
  return { ptr, bytes, len };
}

function allocWriteU8(arr) {
  const len = Math.max(1, arr.length);
  const ptr = wasmExports.mk_alloc(len);
  if (!ptr) throw new Error(`MocapKernel WASM OOM allocating ${len} bytes (u8)`);
  new Uint8Array(wasmExports.memory.buffer, ptr, len).set(arr);
  return { ptr, bytes: len, len };
}

function allocWriteI32(arr) {
  const len = Math.max(1, arr.length);
  const bytes = len * 4;
  const ptr = wasmExports.mk_alloc(bytes);
  if (!ptr) throw new Error(`MocapKernel WASM OOM allocating ${bytes} bytes (i32)`);
  new Int32Array(wasmExports.memory.buffer, ptr, len).set(arr);
  return { ptr, bytes, len };
}

function allocEmpty(bytes) {
  const safe = Math.max(16, bytes);
  const ptr = wasmExports.mk_alloc(safe);
  if (!ptr) throw new Error(`MocapKernel WASM OOM allocating ${safe} bytes`);
  new Uint8Array(wasmExports.memory.buffer, ptr, safe).fill(0);
  return { ptr, bytes: safe };
}

const DIRECT_MP_2D_INDEX = Object.freeze({
  nose: 0,
  leftEar: 7,
  rightEar: 8,
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
  leftHeel: 29,
  rightHeel: 30,
  leftFoot: 31,
  rightFoot: 32,
});

function readLm2d(lmFrame, idx) {
  const row = Array.isArray(lmFrame) ? lmFrame[idx] : null;
  if (!row || row.length < 2) return null;
  const x = Number(row[0]);
  const y = Number(row[1]);
  const v = row.length >= 3 ? Math.max(0, Math.min(1, Number(row[2]) || 0)) : 0.9;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return [x, y, v];
}

function packLandmarks2DBuffer(landmarks2D, nFrames) {
  if (!Array.isArray(landmarks2D) || landmarks2D.length < nFrames) return null;
  const nJoints = JOINT_ORDER.length;
  const buf = new Float32Array(nFrames * nJoints * 3);
  for (let f = 0; f < nFrames; f++) {
    const lmFrame = landmarks2D[f];
    if (!Array.isArray(lmFrame) || lmFrame.length < 25) continue;
    const lh = readLm2d(lmFrame, 23);
    const rh = readLm2d(lmFrame, 24);
    const ls = readLm2d(lmFrame, 11);
    const rs = readLm2d(lmFrame, 12);
    const midHip2 = lh && rh ? [0.5 * (lh[0] + rh[0]), 0.5 * (lh[1] + rh[1]), Math.min(lh[2], rh[2])] : null;
    const midSh2 = ls && rs ? [0.5 * (ls[0] + rs[0]), 0.5 * (ls[1] + rs[1]), Math.min(ls[2], rs[2])] : null;

    for (let j = 0; j < nJoints; j++) {
      const key = JOINT_ORDER[j];
      let p = null;
      if (key in DIRECT_MP_2D_INDEX) {
        p = readLm2d(lmFrame, DIRECT_MP_2D_INDEX[key]);
      } else if (key === 'midHip') {
        p = midHip2;
      } else if (key === 'neck') {
        p = midSh2;
      } else if (key === 'spine' && midHip2 && midSh2) {
        p = [
          midHip2[0] + (midSh2[0] - midHip2[0]) * 0.65,
          midHip2[1] + (midSh2[1] - midHip2[1]) * 0.65,
          Math.min(midHip2[2], midSh2[2]),
        ];
      } else if (key === 'head') {
        p = readLm2d(lmFrame, 0) || midSh2;
      }
      if (p) {
        const b = (f * nJoints + j) * 3;
        buf[b] = p[0];
        buf[b + 1] = p[1];
        buf[b + 2] = p[2];
      }
    }
  }
  return buf;
}

function resolveJointVis(key, visObj, fr) {
  if (visObj && typeof visObj === 'object') {
    const direct = visObj[key];
    if (Number.isFinite(Number(direct))) {
      return Math.max(0, Math.min(1, Number(direct)));
    }
    if (key === 'midHip' && Number.isFinite(Number(visObj.leftHip)) && Number.isFinite(Number(visObj.rightHip))) {
      return Math.max(0, Math.min(1, Math.min(Number(visObj.leftHip), Number(visObj.rightHip))));
    }
    if ((key === 'neck' || key === 'spine') && Number.isFinite(Number(visObj.leftShoulder)) && Number.isFinite(Number(visObj.rightShoulder))) {
      return Math.max(0, Math.min(1, Math.min(Number(visObj.leftShoulder), Number(visObj.rightShoulder))));
    }
    if (key === 'head' && Number.isFinite(Number(visObj.nose))) {
      return Math.max(0, Math.min(1, Number(visObj.nose)));
    }
    if (Object.keys(visObj).length === 0) {
      return 0.0;
    }
  }
  if (fr && fr._undetected === true) return 0.0;
  return 0.95;
}

function packJointBuffer(frames, visSeries = null) {
  const nFrames = frames.length;
  const nJoints = JOINT_ORDER.length;
  const buf = new Float32Array(nFrames * nJoints * 4);

  for (let f = 0; f < nFrames; f++) {
    const fr = frames[f] || {};
    const visObj = (Array.isArray(visSeries) ? visSeries[f] : null) || fr.visibilities || null;
    const midHip = fr.midHip || (
      fr.leftHip && fr.rightHip
        ? [
          0.5 * (fr.leftHip[0] + fr.rightHip[0]),
          0.5 * (fr.leftHip[1] + fr.rightHip[1]),
          0.5 * (fr.leftHip[2] + fr.rightHip[2]),
        ]
        : null
    );
    const midSh = (fr.leftShoulder && fr.rightShoulder)
      ? [
        0.5 * (fr.leftShoulder[0] + fr.rightShoulder[0]),
        0.5 * (fr.leftShoulder[1] + fr.rightShoulder[1]),
        0.5 * (fr.leftShoulder[2] + fr.rightShoulder[2]),
      ]
      : null;

    for (let j = 0; j < nJoints; j++) {
      const key = JOINT_ORDER[j];
      let vec = fr[key];
      if (!vec && key === 'midHip') vec = midHip;
      if (!vec && key === 'neck') vec = midSh;
      if (!vec && key === 'spine' && midHip && midSh) {
        vec = [
          midHip[0] + (midSh[0] - midHip[0]) * 0.65,
          midHip[1] + (midSh[1] - midHip[1]) * 0.65,
          midHip[2] + (midSh[2] - midHip[2]) * 0.65,
        ];
      }
      if (!vec && key === 'head') vec = fr.nose || fr.neck || midSh;

      const base = (f * nJoints + j) * 4;
      if (Array.isArray(vec) || ArrayBuffer.isView(vec)) {
        const x = Number(vec[0]);
        const y = Number(vec[1]);
        const z = Number(vec[2]);
        if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)) {
          buf[base] = x;
          buf[base + 1] = y;
          buf[base + 2] = z;
          buf[base + 3] = resolveJointVis(key, visObj, fr);
          continue;
        }
      }
      buf[base + 3] = 0.0;
    }
  }
  return buf;
}

function unpackJointBufferToMocapFrames(buf, rootTraj, times, nFrames, origFrames = null) {
  const nJoints = JOINT_ORDER.length;
  const out = new Array(nFrames);
  const r5 = (v) => Math.round(v * 100000) / 100000;

  // `rootTraj` is always emitted in 3D world space (+Y up, +Z toward viewer).
  // Normalize `buf` from MediaPipe (+Y down, +Z away) into (+Y up, +Z toward) BEFORE adding `rootTraj`
  // so `frames` is 100% consistent in (+Y up, +Z toward) across both joints and `midHip`.
  const hipAnkleDys = [];
  for (let f = 0; f < nFrames; f++) {
    const lHipB = (f * nJoints + JOINT_INDEX.leftHip) * 4;
    const lAnkB = (f * nJoints + JOINT_INDEX.leftAnkle) * 4;
    if (buf[lHipB + 3] > 0.1 && buf[lAnkB + 3] > 0.1) {
      hipAnkleDys.push(buf[lAnkB + 1] - buf[lHipB + 1]);
    }
  }
  const isYDown = (medianOf(hipAnkleDys) ?? -1) > 0.05;
  const yzSign = isYDown ? -1 : 1;

  for (let f = 0; f < nFrames; f++) {
    const baseAt = (key) => (f * nJoints + JOINT_INDEX[key]) * 4;
    const readVec = (key) => {
      const b = baseAt(key);
      return [r5(buf[b]), r5(buf[b + 1] * yzSign), r5(buf[b + 2] * yzSign)];
    };
    const rx = rootTraj ? (rootTraj[f * 3] || 0) : 0;
    const ry = rootTraj ? (rootTraj[f * 3 + 1] || 0) : 0;
    const rz = rootTraj ? (rootTraj[f * 3 + 2] || 0) : 0;
    const withRoot = (v) => rootTraj ? [r5(v[0] + rx), r5(v[1] + ry), r5(v[2] + rz)] : v;

    const lHip = readVec('leftHip');
    const rHip = readVec('rightHip');
    const lSh = readVec('leftShoulder');
    const rSh = readVec('rightShoulder');
    const midHip = [
      r5(0.5 * (lHip[0] + rHip[0])),
      r5(0.5 * (lHip[1] + rHip[1])),
      r5(0.5 * (lHip[2] + rHip[2])),
    ];
    const midSh = [
      r5(0.5 * (lSh[0] + rSh[0])),
      r5(0.5 * (lSh[1] + rSh[1])),
      r5(0.5 * (lSh[2] + rSh[2])),
    ];
    const spine = [
      r5(midHip[0] + (midSh[0] - midHip[0]) * 0.65),
      r5(midHip[1] + (midSh[1] - midHip[1]) * 0.65),
      r5(midHip[2] + (midSh[2] - midHip[2]) * 0.65),
    ];

    const orig = origFrames?.[f];
    out[f] = {
      time: times ? r5(times[f]) : (orig?.time ?? r5(f / 30)),
      midHip: withRoot(midHip),
      spine: withRoot(spine),
      neck: withRoot(midSh),
      nose: withRoot(readVec('nose')),
      leftShoulder: withRoot(lSh),
      leftElbow: withRoot(readVec('leftElbow')),
      leftWrist: withRoot(readVec('leftWrist')),
      leftHandIndex: withRoot(readVec('leftHandIndex')),
      rightShoulder: withRoot(rSh),
      rightElbow: withRoot(readVec('rightElbow')),
      rightWrist: withRoot(readVec('rightWrist')),
      rightHandIndex: withRoot(readVec('rightHandIndex')),
      leftHip: withRoot(lHip),
      leftKnee: withRoot(readVec('leftKnee')),
      leftAnkle: withRoot(readVec('leftAnkle')),
      leftFoot: withRoot(readVec('leftFoot')),
      rightHip: withRoot(rHip),
      rightKnee: withRoot(readVec('rightKnee')),
      rightAnkle: withRoot(readVec('rightAnkle')),
      rightFoot: withRoot(readVec('rightFoot')),
    };
    if (buf[baseAt('leftHeel') + 3] > 0.05) {
      Object.defineProperty(out[f], 'leftHeel', {
        value: withRoot(readVec('leftHeel')),
        enumerable: false,
        configurable: true,
        writable: true,
      });
    }
    if (buf[baseAt('rightHeel') + 3] > 0.05) {
      Object.defineProperty(out[f], 'rightHeel', {
        value: withRoot(readVec('rightHeel')),
        enumerable: false,
        configurable: true,
        writable: true,
      });
    }
  }
  return out;
}

/**
 * Rust WASM signal processing pipeline on raw `jointSeries`.
 * Returns `{ frames, footLockCounts, footLockFlags }` or `null` if kernel is not loaded.
 */
export function processJointsWasm(jointSeries, options = {}) {
  if (!wasmExports || !Array.isArray(jointSeries) || jointSeries.length === 0) {
    return null;
  }

  const nFrames = jointSeries.length;
  const nJoints = JOINT_ORDER.length;
  const fps = Math.max(1, Number(options.fps) || 30);
  const times = Array.isArray(options.times) ? options.times : null;
  const doFootLock = options.footLock === true ? 1 : 0;

  const visSeries = options.visibilities || options.rawJointVisibilities || null;
  const jointBuf = packJointBuffer(jointSeries, visSeries);
  const lm2dBuf = packLandmarks2DBuffer(options.landmarks2D, nFrames);
  const hip2dArr = new Float32Array(nFrames * 4);
  if (Array.isArray(options.hip2dSeries)) {
    for (let f = 0; f < nFrames; f++) {
      const h = options.hip2dSeries[f];
      if (h && h.length >= 4) {
        hip2dArr[f * 4] = Number(h[0]) || 0;
        hip2dArr[f * 4 + 1] = Number(h[1]) || 0;
        hip2dArr[f * 4 + 2] = Number(h[2]) || 0;
        hip2dArr[f * 4 + 3] = Number(h[3]) || 0;
      }
    }
  }

  const chainPairs = [];
  for (const [pKey, cKey] of BONE_CHAINS) {
    const pi = JOINT_INDEX[pKey];
    const ci = JOINT_INDEX[cKey];
    if (pi !== undefined && ci !== undefined) {
      chainPairs.push(pi, ci);
    }
  }
  const chainsArr = new Int32Array(chainPairs);

  const camSeries = Array.isArray(options.cameraMotionSeries) && options.cameraMotionSeries.length >= nFrames
    ? options.cameraMotionSeries
    : null;
  const camArr = camSeries ? new Float32Array(nFrames * 4) : null;
  if (camArr) {
    for (let f = 0; f < nFrames; f++) {
      const c = camSeries[f];
      if (!c) continue;
      camArr[f * 4] = Number(c.cumPanXNorm ?? c[0] ?? 0) || 0;
      camArr[f * 4 + 1] = Number(c.cumPanYNorm ?? c[1] ?? 0) || 0;
      camArr[f * 4 + 2] = Number(c.cumZoom ?? c[2] ?? 1) || 1;
      camArr[f * 4 + 3] = Number(c.confidence ?? c[3] ?? 0) || 0;
    }
  }

  const jMem = allocWriteF32(jointBuf);
  const hMem = allocWriteF32(hip2dArr);
  const lm2dMem = lm2dBuf ? allocWriteF32(lm2dBuf) : null;
  const camMem = camArr ? allocWriteF32(camArr) : null;
  const cMem = allocWriteI32(chainsArr);
  const rMem = allocEmpty(nFrames * 3 * 4);
  const fMem = allocEmpty(nFrames * 2);

  try {
    const minCutoff = Number(options.minCutoff ?? 1.2);
    const beta = Number(options.beta ?? 0.08);
    const dCutoff = Number(options.dCutoff ?? 1.0);
    const minVis = Number(options.minVis ?? 0.25);
    const maxGap = Math.max(1, Math.round(Number(options.maxGap ?? 24)));
    const velThresh = Number(options.speedTol ?? 1.25);
    const floorTol = Number(options.heightTol ?? 0.055);
    const occlusionStrength = Number(options.occlusionStrength ?? 0.92);
    const sgPasses = Math.max(0, Math.round(Number(options.sgPasses ?? 1)));
    const temporalLifting = options.temporalLifting === false ? 0 : 1;
    const vw = Number(options.videoWidth) || 0;
    const vh = Number(options.videoHeight) || 0;
    const aspectRatio = Number(options.aspectRatio) || (vw > 0 && vh > 0 ? vw / vh : 1.0);

    const lockedCount = typeof wasmExports.mk_process_joints_v4 === 'function'
      ? wasmExports.mk_process_joints_v4(
        jMem.ptr,
        hMem.ptr,
        lm2dMem ? lm2dMem.ptr : 0,
        camMem ? camMem.ptr : 0,
        cMem.ptr,
        rMem.ptr,
        fMem.ptr,
        nFrames,
        nJoints,
        Math.floor(chainPairs.length / 2),
        fps,
        minCutoff,
        beta,
        dCutoff,
        minVis,
        maxGap,
        1, // zero-phase bidirectional 1-Euro
        doFootLock,
        velThresh,
        floorTol,
        3, // 3-frame Hermite ease-in/ease-out blend
        occlusionStrength,
        sgPasses,
        temporalLifting,
        aspectRatio,
        JOINT_INDEX.midHip,
        JOINT_INDEX.spine,
        JOINT_INDEX.neck,
        JOINT_INDEX.nose,
        JOINT_INDEX.leftShoulder,
        JOINT_INDEX.rightShoulder,
        JOINT_INDEX.leftElbow,
        JOINT_INDEX.rightElbow,
        JOINT_INDEX.leftWrist,
        JOINT_INDEX.rightWrist,
        JOINT_INDEX.leftHandIndex,
        JOINT_INDEX.rightHandIndex,
        JOINT_INDEX.leftHip,
        JOINT_INDEX.leftKnee,
        JOINT_INDEX.leftAnkle,
        JOINT_INDEX.leftFoot,
        JOINT_INDEX.rightHip,
        JOINT_INDEX.rightKnee,
        JOINT_INDEX.rightAnkle,
        JOINT_INDEX.rightFoot,
      )
      : typeof wasmExports.mk_process_joints_v3 === 'function'
      ? wasmExports.mk_process_joints_v3(
        jMem.ptr,
        hMem.ptr,
        lm2dMem ? lm2dMem.ptr : 0,
        camMem ? camMem.ptr : 0,
        cMem.ptr,
        rMem.ptr,
        fMem.ptr,
        nFrames,
        nJoints,
        Math.floor(chainPairs.length / 2),
        fps,
        minCutoff,
        beta,
        dCutoff,
        minVis,
        maxGap,
        1, // zero-phase bidirectional 1-Euro
        doFootLock,
        velThresh,
        floorTol,
        3, // 3-frame Hermite ease-in/ease-out blend
        occlusionStrength,
        sgPasses,
        temporalLifting,
        JOINT_INDEX.midHip,
        JOINT_INDEX.spine,
        JOINT_INDEX.neck,
        JOINT_INDEX.nose,
        JOINT_INDEX.leftShoulder,
        JOINT_INDEX.rightShoulder,
        JOINT_INDEX.leftElbow,
        JOINT_INDEX.rightElbow,
        JOINT_INDEX.leftWrist,
        JOINT_INDEX.rightWrist,
        JOINT_INDEX.leftHandIndex,
        JOINT_INDEX.rightHandIndex,
        JOINT_INDEX.leftHip,
        JOINT_INDEX.leftKnee,
        JOINT_INDEX.leftAnkle,
        JOINT_INDEX.leftFoot,
        JOINT_INDEX.rightHip,
        JOINT_INDEX.rightKnee,
        JOINT_INDEX.rightAnkle,
        JOINT_INDEX.rightFoot,
      )
      : typeof wasmExports.mk_process_joints_v2 === 'function'
      ? wasmExports.mk_process_joints_v2(
        jMem.ptr,
        hMem.ptr,
        lm2dMem ? lm2dMem.ptr : 0,
        cMem.ptr,
        rMem.ptr,
        fMem.ptr,
        nFrames,
        nJoints,
        Math.floor(chainPairs.length / 2),
        fps,
        minCutoff,
        beta,
        dCutoff,
        minVis,
        maxGap,
        1, // zero-phase bidirectional 1-Euro
        doFootLock,
        velThresh,
        floorTol,
        3, // 3-frame Hermite ease-in/ease-out blend
        occlusionStrength,
        sgPasses,
        JOINT_INDEX.midHip,
        JOINT_INDEX.spine,
        JOINT_INDEX.neck,
        JOINT_INDEX.leftShoulder,
        JOINT_INDEX.rightShoulder,
        JOINT_INDEX.leftElbow,
        JOINT_INDEX.rightElbow,
        JOINT_INDEX.leftWrist,
        JOINT_INDEX.rightWrist,
        JOINT_INDEX.leftHandIndex,
        JOINT_INDEX.rightHandIndex,
        JOINT_INDEX.leftHip,
        JOINT_INDEX.leftKnee,
        JOINT_INDEX.leftAnkle,
        JOINT_INDEX.leftFoot,
        JOINT_INDEX.rightHip,
        JOINT_INDEX.rightKnee,
        JOINT_INDEX.rightAnkle,
        JOINT_INDEX.rightFoot,
      )
      : wasmExports.mk_process_joints(
        jMem.ptr,
        hMem.ptr,
        cMem.ptr,
        rMem.ptr,
        fMem.ptr,
        nFrames,
        nJoints,
        Math.floor(chainPairs.length / 2),
        fps,
        minCutoff,
        beta,
        dCutoff,
        minVis,
        maxGap,
        1, // zero-phase bidirectional 1-Euro
        doFootLock,
        velThresh,
        floorTol,
        3, // 3-frame Hermite ease-in/ease-out blend
        JOINT_INDEX.midHip,
        JOINT_INDEX.spine,
        JOINT_INDEX.leftHip,
        JOINT_INDEX.leftKnee,
        JOINT_INDEX.leftAnkle,
        JOINT_INDEX.leftFoot,
        JOINT_INDEX.rightHip,
        JOINT_INDEX.rightKnee,
        JOINT_INDEX.rightAnkle,
        JOINT_INDEX.rightFoot,
      );

    if (lockedCount < 0) return null;

    const outJoints = new Float32Array(wasmExports.memory.buffer, jMem.ptr, nFrames * nJoints * 4).slice();
    const outRoot = new Float32Array(wasmExports.memory.buffer, rMem.ptr, nFrames * 3).slice();
    const outFlags = new Uint8Array(wasmExports.memory.buffer, fMem.ptr, nFrames * 2).slice();

    let leftLocked = 0;
    let rightLocked = 0;
    for (let f = 0; f < nFrames; f++) {
      if (outFlags[f * 2]) leftLocked++;
      if (outFlags[f * 2 + 1]) rightLocked++;
    }

    const frames = unpackJointBufferToMocapFrames(outJoints, outRoot, times, nFrames);
    return {
      frames,
      footLockFlags: outFlags,
      footLockCounts: doFootLock ? { left: leftLocked, right: rightLocked } : null,
    };
  } finally {
    wasmExports.mk_free(jMem.ptr, jMem.bytes);
    wasmExports.mk_free(hMem.ptr, hMem.bytes);
    if (lm2dMem) wasmExports.mk_free(lm2dMem.ptr, lm2dMem.bytes);
    if (camMem) wasmExports.mk_free(camMem.ptr, camMem.bytes);
    wasmExports.mk_free(cMem.ptr, cMem.bytes);
    wasmExports.mk_free(rMem.ptr, rMem.bytes);
    wasmExports.mk_free(fMem.ptr, fMem.bytes);
  }
}

/**
 * Apply smooth Hermite ease-in/ease-out Foot-Lock IK directly on existing `mocapFrames`
 * (used when user toggles Foot-Lock on/off during Re-Apply without re-running MediaPipe).
 */
export function applyFootLockWasm(frames, options = {}) {
  if (!wasmExports || !Array.isArray(frames) || frames.length < 3) {
    return null;
  }
  const nFrames = frames.length;
  const nJoints = JOINT_ORDER.length;
  const fps = Math.max(1, Number(options.fps) || 30);

  const jointBuf = packJointBuffer(frames, options.visSeries || options.rawJointVisibilities || null);
  const zeroRoot = new Float32Array(nFrames * 3); // frames already contain baked midHip positions

  const jMem = allocWriteF32(jointBuf);
  const rMem = allocWriteF32(zeroRoot);
  const fMem = allocEmpty(nFrames * 2);

  try {
    const total = wasmExports.mk_apply_foot_lock(
      jMem.ptr,
      rMem.ptr,
      fMem.ptr,
      nFrames,
      nJoints,
      fps,
      Number(options.speedTol ?? 1.25),
      Number(options.heightTol ?? 0.055),
      3,
      JOINT_INDEX.leftHip,
      JOINT_INDEX.leftKnee,
      JOINT_INDEX.leftAnkle,
      JOINT_INDEX.leftFoot,
      JOINT_INDEX.rightHip,
      JOINT_INDEX.rightKnee,
      JOINT_INDEX.rightAnkle,
      JOINT_INDEX.rightFoot,
    );
    if (total < 0) return null;

    const outJoints = new Float32Array(wasmExports.memory.buffer, jMem.ptr, nFrames * nJoints * 4).slice();
    const outFlags = new Uint8Array(wasmExports.memory.buffer, fMem.ptr, nFrames * 2).slice();

    let left = 0;
    let right = 0;
    for (let f = 0; f < nFrames; f++) {
      if (outFlags[f * 2]) left++;
      if (outFlags[f * 2 + 1]) right++;
    }

    const times = frames.map((fr) => fr.time ?? 0);
    const outFrames = unpackJointBufferToMocapFrames(outJoints, null, times, nFrames, frames);
    return { frames: outFrames, flags: outFlags, locked: { left, right } };
  } finally {
    wasmExports.mk_free(jMem.ptr, jMem.bytes);
    wasmExports.mk_free(rMem.ptr, rMem.bytes);
    wasmExports.mk_free(fMem.ptr, fMem.bytes);
  }
}

/**
 * Full 20-bone FK + Pole-Vector retargeting inside Rust WASM.
 * Must be called when `character` is already restored to its canonical bind pose!
 */
export function retargetHumanoidWasm({
  THREE: ThreeNS = (typeof globalThis !== 'undefined' ? globalThis.THREE : null),
  character,
  bones,
  restQuats,
  restPositions,
  restWorldPositions,
  restWorldQuats,
  charBasis,
  restMinFootY,
  frames,
  footLockFlags = null,
  fps = 30,
  options = {},
  findToeBone = null,
}) {
  const THREE = ThreeNS;
  if (!THREE || !wasmExports || !character || !bones?.hips || !Array.isArray(frames) || frames.length === 0) {
    return null;
  }

  const nFrames = frames.length;
  const nJoints = JOINT_ORDER.length;

  // Map Bone instance -> canonical slot index (0..19)
  const boneToSlot = new Map();
  for (let i = 0; i < BONE_ORDER.length; i++) {
    const b = bones[BONE_ORDER[i]];
    if (b) boneToSlot.set(b, i);
  }

  const resolveParentSlot = (bone) => {
    let p = bone?.parent;
    while (p) {
      if (boneToSlot.has(p)) return boneToSlot.get(p);
      p = p.parent;
    }
    return -1;
  };

  // Child reference lookup for measuring exact bone aim direction in world rest space.
  const CHILD_HINT = {
    hips: 'spine',
    spine: 'spine1',
    spine1: 'spine2',
    spine2: 'neck',
    neck: 'head',
    leftShoulder: 'leftArm',
    leftArm: 'leftForearm',
    leftForearm: 'leftHand',
    rightShoulder: 'rightArm',
    rightArm: 'rightForearm',
    rightForearm: 'rightHand',
    leftUpLeg: 'leftLeg',
    leftLeg: 'leftFoot',
    leftFoot: 'leftToeBase',
    rightUpLeg: 'rightLeg',
    rightLeg: 'rightFoot',
    rightFoot: 'rightToeBase',
  };

  const boneSlotsArr = new Float32Array(BONE_ORDER.length * BONE_SLOT_FLOATS);
  const tmpV = new THREE.Vector3();

  for (let i = 0; i < BONE_ORDER.length; i++) {
    const key = BONE_ORDER[i];
    const bone = bones[key];
    if (!bone) continue;
    const base = i * BONE_SLOT_FLOATS;

    const restPos = restPositions.get(bone.name) || bone.position;
    const restQuat = restQuats.get(bone.name) || bone.quaternion;
    const scale = bone.scale || { x: 1, y: 1, z: 1 };

    let aim = new THREE.Vector3(0, 1, 0);
    let childBone = CHILD_HINT[key] ? bones[CHILD_HINT[key]] : null;
    if (key === 'spine' && !childBone) childBone = bones.spine2 || bones.neck;
    if (key === 'spine1' && !childBone) childBone = bones.neck;

    if (childBone) {
      const p1 = restWorldPositions.get(bone.name);
      const p2 = restWorldPositions.get(childBone.name);
      if (p1 && p2) {
        tmpV.copy(p2).sub(p1);
        if (tmpV.lengthSq() > 1e-8) aim.copy(tmpV).normalize();
      }
    } else if (key === 'leftHand' || key === 'rightHand') {
      const foreKey = key === 'leftHand' ? 'leftForearm' : 'rightForearm';
      const p1 = bones[foreKey] ? restWorldPositions.get(bones[foreKey].name) : null;
      const p2 = restWorldPositions.get(bone.name);
      if (p1 && p2) {
        tmpV.copy(p2).sub(p1);
        if (tmpV.lengthSq() > 1e-8) aim.copy(tmpV).normalize();
      }
    } else if (key === 'leftFoot' || key === 'rightFoot') {
      const toeBone = bones[key === 'leftFoot' ? 'leftToeBase' : 'rightToeBase']
        || (typeof findToeBone === 'function' ? findToeBone(bone) : null);
      const p1 = restWorldPositions.get(bone.name);
      const p2 = toeBone ? restWorldPositions.get(toeBone.name) : null;
      if (p1 && p2) {
        tmpV.copy(p2).sub(p1);
        if (tmpV.lengthSq() > 1e-8) aim.copy(tmpV).normalize();
      } else {
        aim.copy(charBasis.fwd).multiplyScalar(0.85).add(new THREE.Vector3(0, -0.5, 0)).normalize();
      }
    } else if (key === 'leftToeBase' || key === 'rightToeBase') {
      const footKey = key === 'leftToeBase' ? 'leftFoot' : 'rightFoot';
      const endBone = bone.children?.find((c) => c.isBone);
      const p1 = restWorldPositions.get(bone.name);
      const p2 = endBone ? restWorldPositions.get(endBone.name) : null;
      if (p1 && p2) {
        tmpV.copy(p2).sub(p1);
        if (tmpV.lengthSq() > 1e-8) aim.copy(tmpV).normalize();
      } else if (bones[footKey]) {
        const pf = restWorldPositions.get(bones[footKey].name);
        if (pf && p1) {
          tmpV.set(p1.x - pf.x, 0, p1.z - pf.z);
          if (tmpV.lengthSq() > 1e-8) aim.copy(tmpV).normalize();
          else aim.copy(charBasis.fwd).normalize();
        } else {
          aim.copy(charBasis.fwd).normalize();
        }
      } else {
        aim.copy(charBasis.fwd).normalize();
      }
    }

    // Anatomical pole vector hint: knees point forward (+charBasis.fwd), elbows point backward (-charBasis.fwd).
    const pole = (key.includes('Arm') || key.includes('Forearm'))
      ? charBasis.fwd.clone().negate()
      : (key.includes('Foot') ? new THREE.Vector3(0, 1, 0) : charBasis.fwd.clone());

    boneSlotsArr[base] = 1.0;
    boneSlotsArr[base + 1] = resolveParentSlot(bone);
    boneSlotsArr[base + 2] = restPos.x;
    boneSlotsArr[base + 3] = restPos.y;
    boneSlotsArr[base + 4] = restPos.z;
    boneSlotsArr[base + 5] = restQuat.x;
    boneSlotsArr[base + 6] = restQuat.y;
    boneSlotsArr[base + 7] = restQuat.z;
    boneSlotsArr[base + 8] = restQuat.w;
    boneSlotsArr[base + 9] = scale.x;
    boneSlotsArr[base + 10] = scale.y;
    boneSlotsArr[base + 11] = scale.z;
    boneSlotsArr[base + 12] = aim.x;
    boneSlotsArr[base + 13] = aim.y;
    boneSlotsArr[base + 14] = aim.z;
    boneSlotsArr[base + 15] = pole.x;
    boneSlotsArr[base + 16] = pole.y;
    boneSlotsArr[base + 17] = pole.z;
  }

  // Measure height scale vs rest pose for root translation mapping
  let heightScale = 1.0;
  if (bones.leftUpLeg && bones.leftLeg && bones.leftFoot) {
    const p1 = restWorldPositions.get(bones.leftUpLeg.name);
    const p2 = restWorldPositions.get(bones.leftLeg.name);
    const p3 = restWorldPositions.get(bones.leftFoot.name);
    const fMid = frames[Math.floor(nFrames / 2)];
    if (p1 && p2 && p3 && fMid?.leftHip && fMid?.leftKnee && fMid?.leftAnkle) {
      const charLeg = p1.distanceTo(p2) + p2.distanceTo(p3);
      const mocapLeg =
        Math.hypot(fMid.leftHip[0] - fMid.leftKnee[0], fMid.leftHip[1] - fMid.leftKnee[1], fMid.leftHip[2] - fMid.leftKnee[2]) +
        Math.hypot(fMid.leftKnee[0] - fMid.leftAnkle[0], fMid.leftKnee[1] - fMid.leftAnkle[1], fMid.leftKnee[2] - fMid.leftAnkle[2]);
      if (mocapLeg > 0.1 && charLeg > 0.1) {
        heightScale = charLeg / mocapLeg;
      }
    }
  }
  const effectiveHeight = 1.72 * heightScale;

  // Parent transform matrices for Mixamo 0.01 scale & rotated root rigs
  const hipsParent = bones.hips.parent;
  const hipsParentWorldMat = hipsParent ? hipsParent.matrixWorld.clone() : new THREE.Matrix4();
  const hipsParentWorldInv = hipsParentWorldMat.clone().invert();
  const hipsParentWorldQ = hipsParent
    ? hipsParent.getWorldQuaternion(new THREE.Quaternion())
    : new THREE.Quaternion();
  const restHipsWorldPos = restWorldPositions.get(bones.hips.name) || new THREE.Vector3(0, 0.95, 0);
  const restHipsWorldQ = restWorldQuats.get(bones.hips.name) || new THREE.Quaternion();

  const meta = new Float32Array(68);
  meta.set(hipsParentWorldMat.elements, 0);
  meta.set(hipsParentWorldInv.elements, 16);
  meta[32] = hipsParentWorldQ.x;
  meta[33] = hipsParentWorldQ.y;
  meta[34] = hipsParentWorldQ.z;
  meta[35] = hipsParentWorldQ.w;
  meta[36] = restHipsWorldPos.x;
  meta[37] = restHipsWorldPos.y;
  meta[38] = restHipsWorldPos.z;
  meta[39] = restHipsWorldQ.x;
  meta[40] = restHipsWorldQ.y;
  meta[41] = restHipsWorldQ.z;
  meta[42] = restHipsWorldQ.w;
  meta[43] = charBasis.side.x;
  meta[44] = charBasis.side.y;
  meta[45] = charBasis.side.z;
  meta[46] = charBasis.fwd.x;
  meta[47] = charBasis.fwd.y;
  meta[48] = charBasis.fwd.z;
  meta[49] = charBasis.up.x;
  meta[50] = charBasis.up.y;
  meta[51] = charBasis.up.z;
  meta[52] = charBasis.fwd.x;
  meta[53] = charBasis.fwd.y;
  meta[54] = charBasis.fwd.z;
  meta[55] = effectiveHeight;
  meta[56] = restMinFootY;
  meta[57] = fps;
  meta[58] = options.rootMotionScale ?? 0.85;
  const depthStability = Math.max(0, Math.min(1, Number(options.depthStability ?? 0.5)));
  meta[59] = options.depthScale !== undefined ? Number(options.depthScale) : (1.0 - depthStability * 0.35);
  meta[60] = options.rootRotationWeight ?? 0.9;
  meta[61] = options.smoothing ?? 0.35;
  meta[62] = options.yawOffsetDeg ?? 0;
  meta[63] = options.poleWeight ?? 0.78;
  const groundFeetEnabled = options.groundFeet !== false;
  const useFullbodyIK = groundFeetEnabled && options.fullbodyIK !== false;
  const flagBits =
    (options.rootMotion !== false ? 1 : 0) |
    (options.mirrorX ? 2 : 0) |
    (options.autoAlign !== false ? 4 : 0) |
    (useFullbodyIK ? 8 : 0) |
    (!groundFeetEnabled ? 16 : 0);
  meta[64] = flagBits;
  meta[65] = Number(options.torsoRadius ?? 0.145);
  meta[66] = Number(options.thighRadius ?? 0.085);
  meta[67] = useFullbodyIK ? 1.0 : 0.0;

  // Extract root delta trajectory relative to median midHip (matches JS MocapRetargeter reference origin).
  const refMidHip = [
    medianOf(frames.map((fr) => fr.midHip?.[0])) ?? 0,
    medianOf(frames.map((fr) => fr.midHip?.[1])) ?? 0,
    medianOf(frames.map((fr) => fr.midHip?.[2])) ?? 0,
  ];
  const rootTraj = new Float32Array(nFrames * 3);
  for (let f = 0; f < nFrames; f++) {
    const mh = frames[f].midHip || refMidHip;
    rootTraj[f * 3] = (Number(mh[0]) || 0) - refMidHip[0];
    rootTraj[f * 3 + 1] = (Number(mh[1]) || 0) - refMidHip[1];
    rootTraj[f * 3 + 2] = (Number(mh[2]) || 0) - refMidHip[2];
  }

  const jointBuf = packJointBuffer(frames, options.visSeries || options.rawJointVisibilities || null);
  const flagsArr = (footLockFlags && footLockFlags.length >= nFrames * 2)
    ? footLockFlags
    : new Uint8Array(nFrames * 2);

  const useV2 = typeof wasmExports.mk_retarget_humanoid_v2 === 'function';
  const outBonesCount = useV2 ? BONE_ORDER.length : 20;

  const sMem = allocWriteF32(boneSlotsArr);
  const mMem = allocWriteF32(meta);
  const jMem = allocWriteF32(jointBuf);
  const rMem = allocWriteF32(rootTraj);
  const flMem = allocWriteU8(flagsArr);
  const outQMem = allocEmpty(nFrames * outBonesCount * 4 * 4);
  const outPMem = allocEmpty(nFrames * 3 * 4);

  try {
    const rc = useV2
      ? wasmExports.mk_retarget_humanoid_v2(
        sMem.ptr,
        outBonesCount,
        mMem.ptr,
        meta.length,
        jMem.ptr,
        rMem.ptr,
        flMem.ptr,
        nFrames,
        nJoints,
        outQMem.ptr,
        outPMem.ptr,
      )
      : wasmExports.mk_retarget_humanoid(
        sMem.ptr,
        mMem.ptr,
        jMem.ptr,
        rMem.ptr,
        flMem.ptr,
        nFrames,
        nJoints,
        outQMem.ptr,
        outPMem.ptr,
      );
    if (rc < 0) return null;

    const flatQuats = new Float32Array(wasmExports.memory.buffer, outQMem.ptr, nFrames * outBonesCount * 4).slice();
    const flatHipsPos = new Float32Array(wasmExports.memory.buffer, outPMem.ptr, nFrames * 3).slice();

    const times = new Float32Array(nFrames);
    for (let f = 0; f < nFrames; f++) {
      times[f] = Number.isFinite(frames[f].time) ? frames[f].time : f / fps;
    }

    const tracks = [];
    const coreQuatBuffers = {};
    tracks.push(new THREE.VectorKeyframeTrack(`${bones.hips.name}.position`, times, flatHipsPos));

    for (let b = 0; b < outBonesCount; b++) {
      const boneKey = BONE_ORDER[b];
      const bone = bones[boneKey];
      if (!bone) continue;
      const boneVals = new Float32Array(nFrames * 4);
      for (let f = 0; f < nFrames; f++) {
        const src = (f * outBonesCount + b) * 4;
        const dst = f * 4;
        boneVals[dst] = flatQuats[src];
        boneVals[dst + 1] = flatQuats[src + 1];
        boneVals[dst + 2] = flatQuats[src + 2];
        boneVals[dst + 3] = flatQuats[src + 3];
      }
      coreQuatBuffers[boneKey] = boneVals;
      tracks.push(new THREE.QuaternionKeyframeTrack(`${bone.name}.quaternion`, times, boneVals));
    }

    return {
      tracks,
      coreQuatBuffers,
      times,
      duration: times[nFrames - 1] || 0,
      numFrames: nFrames,
      engine: 'rust-wasm',
    };
  } finally {
    wasmExports.mk_free(sMem.ptr, sMem.bytes);
    wasmExports.mk_free(mMem.ptr, mMem.bytes);
    wasmExports.mk_free(jMem.ptr, jMem.bytes);
    wasmExports.mk_free(rMem.ptr, rMem.bytes);
    wasmExports.mk_free(flMem.ptr, flMem.bytes);
    wasmExports.mk_free(outQMem.ptr, outQMem.bytes);
    wasmExports.mk_free(outPMem.ptr, outPMem.bytes);
  }
}
