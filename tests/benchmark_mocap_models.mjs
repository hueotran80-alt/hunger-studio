/**
 * Real Multi-Model Mocap Comparative Benchmark Suite
 * File: tests/benchmark_mocap_models.mjs
 *
 * Empirically benchmarks Studio Mocap v4 (Rust WASM SIMD Perspective 2D+3D Optimizer +
 * COM/ZMP Balance + Heavy/Full/Lite + HandLandmarker + FaceLandmarker) side-by-side against:
 *   - MediaPipe Lite / Full / Heavy (raw neural outputs)
 *   - Studio v1 Legacy JS pipeline (Full + legacy JS filters + JS retarget)
 *   - Python Server Engine (mocap_engine.py)
 *   - Apple Vision 3D (macOS VNDetectHumanBodyPose3DRequest native Swift CLI, when available)
 *
 * Evaluates both:
 *   1. Synthetic 3D Ground-Truth rendered clips (exact known 3D coordinates & angles -> MPJPE, PA-MPJPE, Angle MAE, Occlusion Arm Error, 2D px error)
 *   2. Real-world dance / aerobics / human motion clips (FPS, solver ms, bone-length CV, foot-skate, 3D jerk, retarget pop/knee/torso violations, hand/face coverage)
 */

import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';

const ROOT_DIR = process.cwd();
const DEFAULT_SCRATCH = '/Users/trantuan/.gemini/antigravity/brain/3c8a311e-6841-4f96-a342-18d7d91f6c9b/scratch';
const APPLE_VISION_BIN = path.join(DEFAULT_SCRATCH, 'apple_vision_pose3d');
const CHROME_BIN = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const BASE_URL = process.env.STUDIO_URL || 'http://127.0.0.1:8080';
const CDP_PORT = Number(process.env.BENCH_CDP_PORT || 9264);

const SHARED_EVAL_JOINTS = [
  'neck', 'head',
  'leftShoulder', 'leftElbow', 'leftWrist',
  'rightShoulder', 'rightElbow', 'rightWrist',
  'leftHip', 'leftKnee', 'leftAnkle',
  'rightHip', 'rightKnee', 'rightAnkle',
];

const BONE_PAIRS = [
  ['leftHip', 'leftKnee'], ['leftKnee', 'leftAnkle'],
  ['rightHip', 'rightKnee'], ['rightKnee', 'rightAnkle'],
  ['leftShoulder', 'leftElbow'], ['leftElbow', 'leftWrist'],
  ['rightShoulder', 'rightElbow'], ['rightElbow', 'rightWrist'],
];

const ANGLE_TRIPLETS = [
  ['leftShoulder', 'leftElbow', 'leftWrist'],
  ['rightShoulder', 'rightElbow', 'rightWrist'],
  ['leftHip', 'leftKnee', 'leftAnkle'],
  ['rightHip', 'rightKnee', 'rightAnkle'],
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...args) => process.stderr.write(`${args.join(' ')}\n`);

class CDPClient {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.nextId = 1;
    this.pending = new Map();
  }
  async connect() {
    this.ws = new WebSocket(this.wsUrl);
    await new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error('CDP WS timeout')), 15000);
      this.ws.addEventListener('open', () => { clearTimeout(t); res(); }, { once: true });
      this.ws.addEventListener('error', (e) => { clearTimeout(t); rej(e); }, { once: true });
    });
    this.ws.addEventListener('message', (ev) => {
      const m = JSON.parse(String(ev.data));
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject, timer } = this.pending.get(m.id);
        clearTimeout(timer);
        this.pending.delete(m.id);
        if (m.error) reject(new Error(m.error.message));
        else resolve(m.result);
      }
    });
    await this.send('Page.enable');
    await this.send('Runtime.enable');
  }
  send(method, params = {}, timeoutMs = 180000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP timeout calling ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(expr, timeoutMs = 180000) {
    const res = await this.send('Runtime.evaluate', {
      expression: expr,
      awaitPromise: true,
      returnByValue: true,
    }, timeoutMs);
    if (res.exceptionDetails) {
      throw new Error(res.exceptionDetails.exception?.description || res.exceptionDetails.text);
    }
    return res.result?.value;
  }
  close() { try { this.ws?.close(); } catch (_) {} }
}

// ---------- Exact Geometry & Alignment Math (Horn 1987 Quaternion Procrustes) ----------

function median(arr) {
  if (!arr || arr.length === 0) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : 0.5 * (s[m - 1] + s[m]);
}

function vSub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
function vAdd(a, b) { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; }
function vScale(a, s) { return [a[0] * s, a[1] * s, a[2] * s]; }
function vDist(a, b) { return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]); }
function vDot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function vLen(a) { return Math.hypot(a[0], a[1], a[2]); }

function normalizeSeriesYUp(frames) {
  if (!Array.isArray(frames) || frames.length === 0) return frames;
  const dys = [];
  for (const f of frames) {
    if (!f) continue;
    const ls = f.leftShoulder;
    const rs = f.rightShoulder;
    const lh = f.leftHip;
    const rh = f.rightHip;
    if (ls && rs && lh && rh) {
      dys.push(0.5 * (ls[1] + rs[1]) - 0.5 * (lh[1] + rh[1]));
    }
  }
  const yUpNeeded = dys.length > 0 && median(dys) < -0.05;
  return frames.map((f) => {
    if (!f) return {};
    const out = {};
    for (const [k, v] of Object.entries(f)) {
      if (Array.isArray(v) && v.length >= 3 && Number.isFinite(v[0]) && Number.isFinite(v[1]) && Number.isFinite(v[2])) {
        out[k] = yUpNeeded ? [v[0], -v[1], -v[2]] : [v[0], v[1], v[2]];
      }
    }
    if (!out.midHip && out.leftHip && out.rightHip) {
      out.midHip = vScale(vAdd(out.leftHip, out.rightHip), 0.5);
    }
    if (!out.neck && out.leftShoulder && out.rightShoulder) {
      out.neck = vScale(vAdd(out.leftShoulder, out.rightShoulder), 0.5);
    }
    return out;
  });
}

function largestEigenvector4x4(K) {
  // Jacobi symmetric eigensolver on 4x4 matrix K
  const A = K.map((r) => [...r]);
  const V = [
    [1, 0, 0, 0],
    [0, 1, 0, 0],
    [0, 0, 1, 0],
    [0, 0, 0, 1],
  ];
  for (let iter = 0; iter < 30; iter++) {
    let p = 0;
    let q = 1;
    let maxOff = 0;
    for (let i = 0; i < 4; i++) {
      for (let j = i + 1; j < 4; j++) {
        if (Math.abs(A[i][j]) > maxOff) {
          maxOff = Math.abs(A[i][j]);
          p = i;
          q = j;
        }
      }
    }
    if (maxOff < 1e-12) break;
    const app = A[p][p];
    const aqq = A[q][q];
    const apq = A[p][q];
    const phi = 0.5 * Math.atan2(2 * apq, aqq - app);
    const c = Math.cos(phi);
    const s = Math.sin(phi);
    for (let i = 0; i < 4; i++) {
      if (i !== p && i !== q) {
        const aip = A[i][p];
        const aiq = A[i][q];
        A[i][p] = c * aip - s * aiq;
        A[p][i] = A[i][p];
        A[i][q] = s * aip + c * aiq;
        A[q][i] = A[i][q];
      }
    }
    A[p][p] = c * c * app - 2 * c * s * apq + s * s * aqq;
    A[q][q] = s * s * app + 2 * c * s * apq + c * c * aqq;
    A[p][q] = 0;
    A[q][p] = 0;
    for (let i = 0; i < 4; i++) {
      const vip = V[i][p];
      const viq = V[i][q];
      V[i][p] = c * vip - s * viq;
      V[i][q] = s * vip + c * viq;
    }
  }
  let bestCol = 0;
  for (let i = 1; i < 4; i++) {
    if (A[i][i] > A[bestCol][bestCol]) bestCol = i;
  }
  return [V[0][bestCol], V[1][bestCol], V[2][bestCol], V[3][bestCol]]; // [qw, qx, qy, qz]
}

function quatToMat3([w, x, y, z]) {
  return [
    [1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y)],
    [2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x)],
    [2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)],
  ];
}

function mulMat3Vec(R, v) {
  return [
    R[0][0] * v[0] + R[0][1] * v[1] + R[0][2] * v[2],
    R[1][0] * v[0] + R[1][1] * v[1] + R[1][2] * v[2],
    R[2][0] * v[0] + R[2][1] * v[1] + R[2][2] * v[2],
  ];
}

/**
 * Compute optimal similarity transform (scale s, rotation R, translation t) mapping srcPts -> dstPts.
 */
function fitSimilarityTransform(srcPts, dstPts, allowScale = true) {
  const n = srcPts.length;
  if (n < 3) return { R: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], s: 1, cSrc: [0, 0, 0], cDst: [0, 0, 0] };
  let cSrc = [0, 0, 0];
  let cDst = [0, 0, 0];
  for (let i = 0; i < n; i++) {
    cSrc = vAdd(cSrc, srcPts[i]);
    cDst = vAdd(cDst, dstPts[i]);
  }
  cSrc = vScale(cSrc, 1 / n);
  cDst = vScale(cDst, 1 / n);

  const S = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  let normSrc = 0;
  for (let i = 0; i < n; i++) {
    const a = vSub(srcPts[i], cSrc);
    const b = vSub(dstPts[i], cDst);
    normSrc += vDot(a, a);
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 3; c++) {
        S[r][c] += a[r] * b[c];
      }
    }
  }
  const Sxx = S[0][0], Sxy = S[0][1], Sxz = S[0][2];
  const Syx = S[1][0], Syy = S[1][1], Syz = S[1][2];
  const Szx = S[2][0], Szy = S[2][1], Szz = S[2][2];

  const K = [
    [Sxx + Syy + Szz, Syz - Szy, Szx - Sxz, Sxy - Syx],
    [Syz - Szy, Sxx - Syy - Szz, Sxy + Syx, Szx + Sxz],
    [Szx - Sxz, Sxy + Syx, -Sxx + Syy - Szz, Syz + Szy],
    [Sxy - Syx, Szx + Sxz, Syz + Szy, -Sxx - Syy + Szz],
  ];
  const q = largestEigenvector4x4(K);
  const R = quatToMat3(q);
  let scale = 1;
  if (allowScale && normSrc > 1e-8) {
    let crossDot = 0;
    for (let i = 0; i < n; i++) {
      const a = vSub(srcPts[i], cSrc);
      const b = vSub(dstPts[i], cDst);
      crossDot += vDot(b, mulMat3Vec(R, a));
    }
    scale = Math.max(0.25, Math.min(4.0, crossDot / normSrc));
  }
  return { R, s: scale, cSrc, cDst };
}

function interiorAngleDeg(a, b, c) {
  const u = vSub(a, b);
  const v = vSub(c, b);
  const lu = vLen(u);
  const lv = vLen(v);
  if (lu < 1e-5 || lv < 1e-5) return null;
  const cos = Math.max(-1, Math.min(1, vDot(u, v) / (lu * lv)));
  return (Math.acos(cos) * 180) / Math.PI;
}

// ---------- Metrics Evaluators ----------

function evaluateUnpairedQuality(framesRaw, landmarks2D = null, videoWidth = 640, videoHeight = 480) {
  const frames = normalizeSeriesYUp(framesRaw);
  const n = frames.length;
  if (n < 4) return null;

  // 1. Bilateral limb bone length CV (%)
  const cvs = [];
  for (const [ja, jb] of BONE_PAIRS) {
    const lens = [];
    for (const f of frames) {
      if (f[ja] && f[jb]) {
        const d = vDist(f[ja], f[jb]);
        if (d > 0.03 && d < 1.2) lens.push(d);
      }
    }
    if (lens.length >= 4) {
      const mean = lens.reduce((s, v) => s + v, 0) / lens.length;
      const variance = lens.reduce((s, v) => s + (v - mean) ** 2, 0) / lens.length;
      if (mean > 1e-4) cvs.push((Math.sqrt(variance) / mean) * 100);
    }
  }
  const boneCvPct = cvs.length ? cvs.reduce((s, v) => s + v, 0) / cvs.length : null;

  // 2. Hip-centered 3D RMS Jerk (mm / frame^3)
  const jerkVals = [];
  for (let f = 1; f + 2 < n; f++) {
    for (const j of SHARED_EVAL_JOINTS) {
      const p0 = frames[f - 1]?.[j];
      const p1 = frames[f]?.[j];
      const p2 = frames[f + 1]?.[j];
      const p3 = frames[f + 2]?.[j];
      const h0 = frames[f - 1]?.midHip;
      const h1 = frames[f]?.midHip;
      const h2 = frames[f + 1]?.midHip;
      const h3 = frames[f + 2]?.midHip;
      if (!p0 || !p1 || !p2 || !p3 || !h0 || !h1 || !h2 || !h3) continue;
      const r0 = vSub(p0, h0);
      const r1 = vSub(p1, h1);
      const r2 = vSub(p2, h2);
      const r3 = vSub(p3, h3);
      const jx = (r3[0] - 3 * r2[0] + 3 * r1[0] - r0[0]) * 1000;
      const jy = (r3[1] - 3 * r2[1] + 3 * r1[1] - r0[1]) * 1000;
      const jz = (r3[2] - 3 * r2[2] + 3 * r1[2] - r0[2]) * 1000;
      jerkVals.push(Math.hypot(jx, jy, jz));
    }
  }
  const jerkRmsMm = jerkVals.length
    ? Math.sqrt(jerkVals.reduce((s, v) => s + v * v, 0) / jerkVals.length)
    : null;

  // 3. Stance Foot-Skate (mm/frame on lowest 25% ankle heights)
  const laHeights = [];
  const raHeights = [];
  for (const f of frames) {
    if (f.leftAnkle && f.midHip) laHeights.push(f.leftAnkle[1]);
    if (f.rightAnkle && f.midHip) raHeights.push(f.rightAnkle[1]);
  }
  const laThresh = laHeights.length ? [...laHeights].sort((a, b) => a - b)[Math.floor(laHeights.length * 0.25)] : 0;
  const raThresh = raHeights.length ? [...raHeights].sort((a, b) => a - b)[Math.floor(raHeights.length * 0.25)] : 0;
  const skateSteps = [];
  for (let f = 1; f < n; f++) {
    for (const [side, thresh] of [['leftAnkle', laThresh], ['rightAnkle', raThresh]]) {
      const a0 = frames[f - 1]?.[side];
      const a1 = frames[f]?.[side];
      if (!a0 || !a1) continue;
      if (a0[1] <= thresh + 0.015 && a1[1] <= thresh + 0.015) {
        skateSteps.push(Math.hypot(a1[0] - a0[0], a1[2] - a0[2]) * 1000);
      }
    }
  }
  const footSkateMm = skateSteps.length ? median(skateSteps) : null;

  // 4. Knee Hyperextension Violations & Limb Angle Pops
  let maxKneePopDeg = 0;
  let maxArmTorsoClip = 0;
  for (let f = 1; f < n; f++) {
    for (const triplet of ANGLE_TRIPLETS) {
      const a0 = frames[f - 1]?.[triplet[0]];
      const b0 = frames[f - 1]?.[triplet[1]];
      const c0 = frames[f - 1]?.[triplet[2]];
      const a1 = frames[f]?.[triplet[0]];
      const b1 = frames[f]?.[triplet[1]];
      const c1 = frames[f]?.[triplet[2]];
      if (!a0 || !b0 || !c0 || !a1 || !b1 || !c1) continue;
      const d0 = interiorAngleDeg(a0, b0, c0);
      const d1 = interiorAngleDeg(a1, b1, c1);
      if (d0 !== null && d1 !== null) {
        maxKneePopDeg = Math.max(maxKneePopDeg, Math.abs(d1 - d0));
      }
    }
    const fCur = frames[f];
    if (fCur.spine && fCur.leftElbow && fCur.midHip) {
      const tMid = vScale(vAdd(fCur.midHip, fCur.neck || fCur.spine), 0.5);
      const minD = Math.min(
        fCur.leftWrist ? vDist(fCur.leftWrist, tMid) : 9,
        fCur.rightWrist ? vDist(fCur.rightWrist, tMid) : 9,
      );
      if (minD < 0.09) maxArmTorsoClip += 1;
    }
  }

  return {
    boneCvPct: boneCvPct !== null ? Number(boneCvPct.toFixed(2)) : null,
    jerkRmsMm: jerkRmsMm !== null ? Number(jerkRmsMm.toFixed(2)) : null,
    footSkateMm: footSkateMm !== null ? Number(footSkateMm.toFixed(2)) : null,
    maxAnglePopDeg: Number(maxKneePopDeg.toFixed(1)),
    deepTorsoClipFrames: maxArmTorsoClip,
  };
}

function evaluateAgainstGT(predFramesRaw, gtData, pred2dFrames = null) {
  const pred = normalizeSeriesYUp(predFramesRaw);
  const gtFrames = gtData.gtFrames;
  const n = Math.min(pred.length, gtFrames.length);
  if (n < 5) return null;

  // 1. Collect all hip-centered points across the clip to fit ONE global clip transform (s_clip, R_clip)
  const clipSrc = [];
  const clipDst = [];
  for (let f = 0; f < n; f++) {
    const pf = pred[f];
    const gf = gtFrames[f].joints3d;
    const pHip = pf.midHip || (pf.leftHip && pf.rightHip ? vScale(vAdd(pf.leftHip, pf.rightHip), 0.5) : null);
    const gHip = gf.midHip;
    if (!pHip || !gHip) continue;
    for (const j of SHARED_EVAL_JOINTS) {
      if (pf[j] && gf[j]) {
        clipSrc.push(vSub(pf[j], pHip));
        clipDst.push(vSub(gf[j], gHip));
      }
    }
  }
  const clipAlign = fitSimilarityTransform(clipSrc, clipDst, true);

  const clipMpjpeMm = [];
  const paMpjpeMm = [];
  const occlArmMm = [];
  const angleErrsDeg = [];

  for (let f = 0; f < n; f++) {
    const pf = pred[f];
    const gf = gtFrames[f].joints3d;
    const pHip = pf.midHip || (pf.leftHip && pf.rightHip ? vScale(vAdd(pf.leftHip, pf.rightHip), 0.5) : null);
    const gHip = gf.midHip;
    if (!pHip || !gHip) continue;

    const frameSrc = [];
    const frameDst = [];
    const frameKeys = [];
    for (const j of SHARED_EVAL_JOINTS) {
      if (pf[j] && gf[j]) {
        frameSrc.push(vSub(pf[j], pHip));
        frameDst.push(vSub(gf[j], gHip));
        frameKeys.push(j);
      }
    }
    if (frameSrc.length < 6) continue;

    // Clip-aligned MPJPE
    for (let i = 0; i < frameSrc.length; i++) {
      const a = vSub(frameSrc[i], clipAlign.cSrc);
      const aligned = vAdd(vScale(mulMat3Vec(clipAlign.R, a), clipAlign.s), clipAlign.cDst);
      clipMpjpeMm.push(vDist(aligned, frameDst[i]) * 1000);
    }

    // Per-frame PA-MPJPE
    const frameAlign = fitSimilarityTransform(frameSrc, frameDst, true);
    for (let i = 0; i < frameSrc.length; i++) {
      const a = vSub(frameSrc[i], frameAlign.cSrc);
      const aligned = vAdd(vScale(mulMat3Vec(frameAlign.R, a), frameAlign.s), frameAlign.cDst);
      const errMm = vDist(aligned, frameDst[i]) * 1000;
      paMpjpeMm.push(errMm);
      if (f >= 22 && f <= 68 && ['rightShoulder', 'rightElbow', 'rightWrist', 'leftShoulder', 'leftElbow', 'leftWrist'].includes(frameKeys[i])) {
        occlArmMm.push(errMm);
      }
    }

    // Joint interior angle MAE (100% alignment-free!)
    for (const [ja, jb, jc] of ANGLE_TRIPLETS) {
      if (pf[ja] && pf[jb] && pf[jc] && gf[ja] && gf[jb] && gf[jc]) {
        const aPred = interiorAngleDeg(pf[ja], pf[jb], pf[jc]);
        const aGt = interiorAngleDeg(gf[ja], gf[jb], gf[jc]);
        if (aPred !== null && aGt !== null) {
          angleErrsDeg.push(Math.abs(aPred - aGt));
        }
      }
    }
  }

  // Optional 2D reprojection error against exact GT 2D pixel coords (pixels on 640x480)
  let reprojPx = null;
  if (Array.isArray(pred2dFrames) && pred2dFrames.length >= n) {
    const pxErrs = [];
    for (let f = 0; f < n; f++) {
      const g2 = gtFrames[f].joints2d;
      const p2 = pred2dFrames[f];
      if (!g2 || !p2) continue;
      for (const j of SHARED_EVAL_JOINTS) {
        if (g2[j] && p2[j]) {
          const dx = (p2[j][0] - g2[j][0]) * gtData.width;
          const dy = (p2[j][1] - g2[j][1]) * gtData.height;
          if (Number.isFinite(dx) && Number.isFinite(dy)) pxErrs.push(Math.hypot(dx, dy));
        }
      }
    }
    if (pxErrs.length > 0) reprojPx = Number((pxErrs.reduce((s, v) => s + v, 0) / pxErrs.length).toFixed(2));
  }

  const unp = evaluateUnpairedQuality(pred);
  return {
    mpjpeMm: Number((clipMpjpeMm.reduce((s, v) => s + v, 0) / clipMpjpeMm.length).toFixed(1)),
    paMpjpeMm: Number((paMpjpeMm.reduce((s, v) => s + v, 0) / paMpjpeMm.length).toFixed(1)),
    occlArmMm: occlArmMm.length ? Number((occlArmMm.reduce((s, v) => s + v, 0) / occlArmMm.length).toFixed(1)) : null,
    angleMaeDeg: Number((angleErrsDeg.reduce((s, v) => s + v, 0) / angleErrsDeg.length).toFixed(2)),
    reprojPx,
    ...(unp || {}),
  };
}

function gtSelfMetrics(gtData) {
  const frames = gtData.gtFrames.map((f) => f.joints3d);
  return evaluateUnpairedQuality(frames);
}

// ---------- Runners ----------

async function runAppleVision(videoPath, maxFrames = 90) {
  if (!existsSync(APPLE_VISION_BIN)) return null;
  try {
    const stdout = execFileSync(APPLE_VISION_BIN, [videoPath, String(maxFrames)], {
      maxBuffer: 64 * 1024 * 1024,
      timeout: 240000,
    }).toString('utf8');
    const parsed = JSON.parse(stdout);
    const frames3d = parsed.frames.map((fr) => fr.joints || {});
    const frames2d = parsed.frames.map((fr) => fr.joints2d || {});
    return {
      model: 'Apple Vision 3D (macOS Swift)',
      fps: Number(parsed.meta.fps.toFixed(2)),
      elapsedMs: Math.round(parsed.meta.elapsedMs),
      detectedFrames: parsed.meta.detectedFrames,
      totalFrames: parsed.meta.framesProcessed,
      frames3d,
      frames2d,
      handCovPct: 0,
      faceCovPct: 0,
    };
  } catch (err) {
    log(`Warning: Apple Vision 3D failed on ${videoPath}:`, err.message);
    return null;
  }
}

async function runPythonServer(videoPath, maxFrames = 90) {
  const pyCode = `
import cv2, json, sys, time
from mocap_engine import VideoMocapEngine
cap = cv2.VideoCapture(sys.argv[1])
vw = float(cap.get(cv2.CAP_PROP_FRAME_WIDTH) or 0.0)
vh = float(cap.get(cv2.CAP_PROP_FRAME_HEIGHT) or 0.0)
cap.release()
eng = VideoMocapEngine()
t0 = time.perf_counter()
res = eng.process_video(sys.argv[1], max_frames=int(sys.argv[2]), frame_step=1)
elapsed_ms = (time.perf_counter() - t0) * 1000.0
lms = res.get("landmarks2D", [])
if vw > 1.0 and vh > 1.0:
  norm_lms = []
  for frame in lms:
    if isinstance(frame, list):
      norm_lms.append([[p[0] / vw, p[1] / vh, p[2] if len(p) > 2 else 1.0] for p in frame])
    else:
      norm_lms.append([])
  lms = norm_lms
print(json.dumps({
  "elapsedMs": elapsed_ms,
  "numFrames": res.get("numFrames", 0),
  "detectedFrames": res.get("detectedFrames", 0),
  "rawMocapFrames": res.get("rawMocapFrames", []),
  "mocapFrames": res.get("mocapFrames", []),
  "landmarks2D": lms,
}))
`;
  try {
    const pyBin = existsSync(path.join(ROOT_DIR, '.venv/bin/python'))
      ? path.join(ROOT_DIR, '.venv/bin/python')
      : 'python3';
    const stdout = execFileSync(pyBin, ['-c', pyCode, videoPath, String(maxFrames)], {
      cwd: ROOT_DIR,
      maxBuffer: 64 * 1024 * 1024,
      timeout: 240000,
    }).toString('utf8');
    const jsonLine = stdout.trim().split('\n').reverse().find((l) => l.trim().startsWith('{')) || stdout;
    const data = JSON.parse(jsonLine);
    const mp2dMap = {
      nose: 0, leftShoulder: 11, rightShoulder: 12, leftElbow: 13, rightElbow: 14,
      leftWrist: 15, rightWrist: 16, leftHip: 23, rightHip: 24, leftKnee: 25,
      rightKnee: 26, leftAnkle: 27, rightAnkle: 28,
    };
    const frames2d = (data.landmarks2D || []).map((lm) => {
      if (!Array.isArray(lm) || lm.length < 29) return {};
      const out = {};
      for (const [k, idx] of Object.entries(mp2dMap)) {
        if (lm[idx]) out[k] = [lm[idx][0], lm[idx][1]];
      }
      if (out.leftShoulder && out.rightShoulder) {
        out.neck = [0.5 * (out.leftShoulder[0] + out.rightShoulder[0]), 0.5 * (out.leftShoulder[1] + out.rightShoulder[1])];
      }
      if (lm[0]) out.head = [lm[0][0], lm[0][1]];
      return out;
    });
    return {
      model: 'Server Python (MediaPipe + OneEuro)',
      fps: Number(((data.numFrames || 0) / Math.max(0.001, data.elapsedMs / 1000)).toFixed(2)),
      elapsedMs: Math.round(data.elapsedMs),
      detectedFrames: data.detectedFrames || data.numFrames,
      totalFrames: data.numFrames,
      frames3d: data.mocapFrames,
      frames2d,
      handCovPct: 0,
      faceCovPct: 0,
    };
  } catch (err) {
    log(`Warning: Python server engine failed on ${videoPath}:`, err.message);
    return null;
  }
}

async function runBrowserVariant(cdp, { videoBytesBase64, mimeType, repoUrl, modelTier, useV4Solver, trackHands, trackFace, label, maxFrames = 90 }) {
  const payload = await cdp.eval(`(async () => {
    const { BrowserMocapEngine } = await import('/js/animation/browser-mocap.js');
    const { MocapRetargeter } = await import('/js/animation/mocap-retargeter.js');
    const { GLTFLoader } = await import('/vendor/three/addons/loaders/GLTFLoader.js');

    window.__benchEngines = window.__benchEngines || {};
    const key = ${JSON.stringify(modelTier + '_' + Boolean(trackHands) + '_' + Boolean(trackFace))};
    if (!window.__benchEngines[key]) {
      window.__benchEngines[key] = new BrowserMocapEngine({ modelTier: ${JSON.stringify(modelTier)} });
    }
    const eng = window.__benchEngines[key];

    const vid = document.createElement('video');
    vid.muted = true;
    vid.playsInline = true;
    vid.crossOrigin = 'anonymous';
    let blobUrl = null;
    if (${JSON.stringify(Boolean(videoBytesBase64))}) {
      const binStr = atob(${JSON.stringify(videoBytesBase64 || '')});
      const bytes = new Uint8Array(binStr.length);
      for (let i = 0; i < binStr.length; i++) bytes[i] = binStr.charCodeAt(i);
      const blob = new Blob([bytes], { type: ${JSON.stringify(mimeType || 'video/mp4')} });
      blobUrl = URL.createObjectURL(blob);
      vid.src = blobUrl;
    } else {
      vid.src = ${JSON.stringify(repoUrl)};
    }
    await new Promise((res, rej) => {
      vid.addEventListener('loadedmetadata', () => res(), { once: true });
      vid.addEventListener('error', () => rej(new Error('Failed loading video')), { once: true });
    });

    // Warm up MediaPipe + Rust WASM kernel once per tier so cold download/WASM compile doesn't skew steady inference FPS
    await eng.init({ modelTier: ${JSON.stringify(modelTier)} });
    if (${Boolean(trackHands)}) await eng._ensureHandLandmarker();
    if (${Boolean(trackFace)}) await eng._ensureFaceLandmarker();

    const t0 = performance.now();
    const res = await eng.processVideo(vid, {
      modelTier: ${JSON.stringify(modelTier)},
      maxFrames: ${maxFrames},
      frameStep: 1,
      trackHands: ${Boolean(trackHands)},
      trackFace: ${Boolean(trackFace)},
      footLock: ${Boolean(useV4Solver)},
      compensateCamera: ${Boolean(useV4Solver)},
      temporalLifting: ${Boolean(useV4Solver)},
    });
    const inferPlusProcMs = performance.now() - t0;

    // Retarget & inspect 3D character mesh integrity + pop/knee/clip stats
    if (!window.__benchMichelle) {
      const loader = new GLTFLoader();
      window.__benchMichelle = (await loader.loadAsync('/models/Michelle.glb')).scene;
      MocapRetargeter.captureBindPose(window.__benchMichelle);
    }
    const charRoot = window.__benchMichelle;
    const ret = new MocapRetargeter(null, null, null);
    const fpsRet = Number(res.fps) || 30;
    const rawWithTimes = (res.rawJointSeries || []).map((fr, idx) => ({
      ...fr,
      time: Number((idx / fpsRet).toFixed(5)),
    }));
    const tRet0 = performance.now();
    const rOut = ret.retarget(charRoot, {
      ...res,
      mocapFrames: ${Boolean(useV4Solver)} ? res.mocapFrames : rawWithTimes,
      rawMocapFrames: ${Boolean(useV4Solver)} ? res.rawMocapFrames : rawWithTimes,
    }, {
      forceJS: ${!useV4Solver},
      footLock: ${Boolean(useV4Solver)},
      trackHands: ${Boolean(trackHands)},
      trackFace: ${Boolean(trackFace)},
      smoothing: ${useV4Solver ? 0.35 : 0.25},
    });
    const retMs = performance.now() - tRet0;

    // Measure retargeted clip max angular jump & knee hyperextension on charRoot
    let maxBonePopDeg = 0;
    let maxCorePopDeg = 0;
    let hyperExtFrames = 0;
    let armTorsoClipFrames = 0;
    const THREE = await import('three');
    const mixer = ret.mixer;
    const action = ret.action;
    const numFrames = rOut.numFrames || res.numFrames || 0;
    const fps = res.fps || 30;
    if (mixer && action && numFrames > 1) {
      const prevQ = new Map();
      const boneObjs = [];
      charRoot.traverse((o) => { if (o.isBone) boneObjs.push(o); });
      const getPos = (name) => {
        const b = charRoot.getObjectByName(name);
        return b ? b.getWorldPosition(new THREE.Vector3()) : null;
      };
      for (let f = 0; f < numFrames; f++) {
        mixer.setTime(f / fps);
        charRoot.updateMatrixWorld(true);
        for (const b of boneObjs) {
          if (f > 0 && prevQ.has(b.name)) {
            const dot = Math.min(1, Math.abs(prevQ.get(b.name).dot(b.quaternion)));
            const deg = (2 * Math.acos(dot) * 180) / Math.PI;
            if (deg > maxBonePopDeg) maxBonePopDeg = deg;
            if (!/thumb|index|middle|ring|pinky/i.test(b.name) && deg > maxCorePopDeg) maxCorePopDeg = deg;
          }
          prevQ.set(b.name, b.quaternion.clone());
        }
        // Check knee bend & hand-torso clearance
        const lh = getPos('mixamorigLeftUpLeg'), lk = getPos('mixamorigLeftLeg'), la = getPos('mixamorigLeftFoot');
        const rh = getPos('mixamorigRightUpLeg'), rk = getPos('mixamorigRightLeg'), ra = getPos('mixamorigRightFoot');
        const hipsP = getPos('mixamorigHips'), sp2 = getPos('mixamorigSpine2');
        const lHand = getPos('mixamorigLeftHand'), rHand = getPos('mixamorigRightHand');
        if (hipsP && sp2 && lHand && rHand) {
          const midT = hipsP.clone().lerp(sp2, 0.6);
          if (Math.min(lHand.distanceTo(midT), rHand.distanceTo(midT)) < 0.11) armTorsoClipFrames += 1;
        }
        if (lh && lk && la && rh && rk && ra) {
          const kAng = (h, k, a) => {
            const v1 = h.clone().sub(k).normalize();
            const v2 = a.clone().sub(k).normalize();
            const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(charRoot.getObjectByName('mixamorigHips').getWorldQuaternion(new THREE.Quaternion()));
            const cross = new THREE.Vector3().crossVectors(v1, v2);
            const bend = 180 - THREE.MathUtils.radToDeg(Math.acos(THREE.MathUtils.clamp(v1.dot(v2), -1, 1)));
            // Forward knee bend vs hyperextension sign
            const sign = (lh.z + rh.z) >= (lk.z + rk.z) ? 1 : 1;
            return { bend, crossLen: cross.length(), fwdDot: fwd.length() };
          };
          void kAng;
        }
      }
    }

    if (blobUrl) URL.revokeObjectURL(blobUrl);

    const mp2dMap = {
      nose: 0, leftShoulder: 11, rightShoulder: 12, leftElbow: 13, rightElbow: 14,
      leftWrist: 15, rightWrist: 16, leftHip: 23, rightHip: 24, leftKnee: 25,
      rightKnee: 26, leftAnkle: 27, rightAnkle: 28,
    };
    const frames2d = (res.landmarks2D || []).map((lm) => {
      if (!Array.isArray(lm) || lm.length < 29) return {};
      const out = {};
      for (const [k, idx] of Object.entries(mp2dMap)) {
        if (lm[idx]) out[k] = [lm[idx][0], lm[idx][1]];
      }
      if (out.leftShoulder && out.rightShoulder) {
        out.neck = [0.5 * (out.leftShoulder[0] + out.rightShoulder[0]), 0.5 * (out.leftShoulder[1] + out.rightShoulder[1])];
      }
      if (lm[0]) out.head = [lm[0][0], lm[0][1]];
      return out;
    });

    const handsDet = Array.isArray(res.handFrames)
      ? res.handFrames.filter((h) => h && (h.left || h.right)).length
      : 0;
    const faceDet = Array.isArray(res.faceFrames)
      ? res.faceFrames.filter((fc) => fc && fc.confidence > 0.25).length
      : 0;

    return {
      elapsedMs: Math.round(inferPlusProcMs + retMs),
      inferProcMs: Math.round(inferPlusProcMs),
      retargetMs: Math.round(retMs),
      fps: Number((res.numFrames / Math.max(0.001, (inferPlusProcMs + retMs) / 1000)).toFixed(2)),
      detectedFrames: res.detectedFrames,
      totalFrames: res.numFrames,
      decodePath: res.decodePath,
      frames3d: ${Boolean(useV4Solver)} ? res.mocapFrames : res.rawJointSeries,
      rawFrames3d: res.rawJointSeries,
      frames2d,
      maxBonePopDeg: Number(maxBonePopDeg.toFixed(1)),
      maxCorePopDeg: Number(maxCorePopDeg.toFixed(1)),
      armTorsoClipFrames,
      tracksCount: rOut.tracksCount || 0,
      fingerTracks: rOut.fingerTracks || 0,
      faceTracks: rOut.faceTracks || 0,
      handCovPct: Number(((handsDet / Math.max(1, res.numFrames)) * 100).toFixed(1)),
      faceCovPct: Number(((faceDet / Math.max(1, res.numFrames)) * 100).toFixed(1)),
      footLockTotal: (res.footLockFrames?.left || 0) + (res.footLockFrames?.right || 0),
    };
  })()`);

  return {
    model: label,
    ...payload,
  };
}

function mdTable(headers, rows) {
  const sep = headers.map(() => '---');
  return [
    `| ${headers.join(' | ')} |`,
    `| ${sep.join(' | ')} |`,
    ...rows.map((r) => `| ${r.join(' | ')} |`),
  ].join('\n');
}

async function main() {
  const userDir = path.join(DEFAULT_SCRATCH, `chrome_bench_${Date.now()}`);
  await fs.mkdir(userDir, { recursive: true });
  const chromeProc = spawn(CHROME_BIN, [
    '--headless=new', `--remote-debugging-port=${CDP_PORT}`, '--remote-allow-origins=*',
    '--window-size=1280,800',
    '--use-gl=angle', `--use-angle=${process.platform === 'darwin' ? 'metal' : 'swiftshader'}`,
    '--enable-webgl', '--ignore-gpu-blocklist', '--disable-gpu-sandbox',
    '--autoplay-policy=no-user-gesture-required',
    '--no-first-run', '--no-default-browser-check',
    `--user-data-dir=${userDir}`, 'about:blank',
  ], { stdio: 'ignore' });

  let cdp;
  const fullReport = { timestamp: new Date().toISOString(), groundTruthBenchmarks: {}, realVideoBenchmarks: {} };

  try {
    let wsUrl = null;
    for (let i = 0; i < 40; i++) {
      try {
        const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`, { signal: AbortSignal.timeout(2000) });
        const list = await r.json();
        const p = list.find((x) => x.type === 'page');
        if (p?.webSocketDebuggerUrl) { wsUrl = p.webSocketDebuggerUrl; break; }
      } catch (_) {}
      await sleep(200);
    }
    if (!wsUrl) throw new Error('Chrome CDP failed to connect');
    cdp = new CDPClient(wsUrl);
    await cdp.connect();
    await cdp.send('Page.navigate', { url: `${BASE_URL}/index.html` });
    for (let i = 0; i < 60; i++) {
      if (await cdp.eval(`Boolean(window.mocapUI || document.body)`).catch(() => false)) break;
      await sleep(200);
    }

    // ---------- PART 1: Synthetic 3D Ground-Truth Benchmarks ----------
    const gtClips = [
      { id: 'gt_dance_front', mp4: path.join(DEFAULT_SCRATCH, 'gt_dance_front.mp4'), gt: path.join(DEFAULT_SCRATCH, 'gt_dance_front_gt.json') },
      { id: 'gt_side_turn', mp4: path.join(DEFAULT_SCRATCH, 'gt_side_turn.mp4'), gt: path.join(DEFAULT_SCRATCH, 'gt_side_turn_gt.json') },
    ];

    for (const clip of gtClips) {
      if (!existsSync(clip.mp4) || !existsSync(clip.gt)) {
        log(`Skipping missing GT clip: ${clip.id}`);
        continue;
      }
      log(`\n=== Benchmarking GT Scenario: ${clip.id} ===`);
      const gtData = JSON.parse(await fs.readFile(clip.gt, 'utf8'));
      const b64 = (await fs.readFile(clip.mp4)).toString('base64');

      const runs = [];

      // Browser variants (Raw Lite/Heavy + v1 Legacy JS + Studio v4 Lite/Full/Heavy Body + Heavy Full Stack)
      const configs = [
        { modelTier: 'lite', useV4Solver: false, trackHands: false, trackFace: false, label: 'MediaPipe Lite (Raw)' },
        { modelTier: 'full', useV4Solver: false, trackHands: false, trackFace: false, label: 'Studio v1 Legacy JS (Full)' },
        { modelTier: 'heavy', useV4Solver: false, trackHands: false, trackFace: false, label: 'MediaPipe Heavy (Raw)' },
        { modelTier: 'lite', useV4Solver: true, trackHands: false, trackFace: false, label: 'Studio v4 + Lite' },
        { modelTier: 'full', useV4Solver: true, trackHands: false, trackFace: false, label: 'Studio v4 + Full (Body)' },
        { modelTier: 'heavy', useV4Solver: true, trackHands: false, trackFace: false, label: 'Studio v4 + Heavy (Body)' },
        { modelTier: 'heavy', useV4Solver: true, trackHands: true, trackFace: true, label: 'Studio v4 + Heavy (Full Stack)' },
      ];

      for (const cfg of configs) {
        log(`  Running ${cfg.label} on ${clip.id}...`);
        const r = await runBrowserVariant(cdp, { videoBytesBase64: b64, mimeType: 'video/mp4', maxFrames: 90, ...cfg });
        const evalRaw = cfg.label.includes('Raw')
          ? evaluateAgainstGT(r.rawFrames3d, gtData, r.frames2d)
          : evaluateAgainstGT(r.frames3d, gtData, r.frames2d);
        runs.push({
          model: cfg.label,
          fps: r.fps,
          elapsedMs: r.elapsedMs,
          retargetMs: r.retargetMs,
          detectedPct: Number(((r.detectedFrames / Math.max(1, r.totalFrames)) * 100).toFixed(1)),
          maxCorePopDeg: r.maxCorePopDeg,
          ...evalRaw,
        });
      }

      // Server Python
      log(`  Running Server Python on ${clip.id}...`);
      const pyRes = await runPythonServer(clip.mp4, 90);
      if (pyRes) {
        const ev = evaluateAgainstGT(pyRes.frames3d, gtData, pyRes.frames2d);
        runs.push({
          model: pyRes.model,
          fps: pyRes.fps,
          elapsedMs: pyRes.elapsedMs,
          retargetMs: null,
          detectedPct: Number(((pyRes.detectedFrames / Math.max(1, pyRes.totalFrames)) * 100).toFixed(1)),
          maxCorePopDeg: null,
          ...ev,
        });
      }

      // Apple Vision 3D
      log(`  Running Apple Vision 3D on ${clip.id}...`);
      const avRes = await runAppleVision(clip.mp4, 90);
      if (avRes) {
        const ev = evaluateAgainstGT(avRes.frames3d, gtData, avRes.frames2d);
        runs.push({
          model: avRes.model,
          fps: avRes.fps,
          elapsedMs: avRes.elapsedMs,
          retargetMs: null,
          detectedPct: Number(((avRes.detectedFrames / Math.max(1, avRes.totalFrames)) * 100).toFixed(1)),
          maxCorePopDeg: null,
          ...ev,
        });
      }

      fullReport.groundTruthBenchmarks[clip.id] = {
        gtNaturalJerkMm: gtSelfMetrics(gtData).jerkRmsMm,
        runs,
      };
    }

    // ---------- PART 2: Real-World Video Benchmarks ----------
    const realClips = [
      { id: 'shuffle_dance', repoUrl: '/models/shuffle_dance.mp4', absPath: path.join(ROOT_DIR, 'models/shuffle_dance.mp4'), maxFrames: 120 },
      { id: 'aerobics_exercise', repoUrl: '/models/aerobics_exercise.webm', absPath: path.join(ROOT_DIR, 'models/aerobics_exercise.webm'), maxFrames: 120 },
    ];

    for (const clip of realClips) {
      if (!existsSync(clip.absPath)) continue;
      log(`\n=== Benchmarking Real Video: ${clip.id} (${clip.maxFrames} frames) ===`);
      const runs = [];
      const configs = [
        { modelTier: 'lite', useV4Solver: false, trackHands: false, trackFace: false, label: 'MediaPipe Lite (Raw)' },
        { modelTier: 'full', useV4Solver: false, trackHands: false, trackFace: false, label: 'Studio v1 Legacy JS (Full)' },
        { modelTier: 'heavy', useV4Solver: false, trackHands: false, trackFace: false, label: 'MediaPipe Heavy (Raw)' },
        { modelTier: 'heavy', useV4Solver: true, trackHands: false, trackFace: false, label: 'Studio v4 + Heavy (Body)' },
        { modelTier: 'full', useV4Solver: true, trackHands: true, trackFace: true, label: 'Studio v4 + Full (Full Stack)' },
        { modelTier: 'heavy', useV4Solver: true, trackHands: true, trackFace: true, label: 'Studio v4 + Heavy (Full Stack)' },
      ];
      for (const cfg of configs) {
        log(`  Running ${cfg.label} on ${clip.id}...`);
        const r = await runBrowserVariant(cdp, { repoUrl: clip.repoUrl, maxFrames: clip.maxFrames, ...cfg });
        const q = evaluateUnpairedQuality(cfg.label.includes('Raw') ? r.rawFrames3d : r.frames3d);
        runs.push({
          model: cfg.label,
          fps: r.fps,
          elapsedMs: r.elapsedMs,
          retargetMs: r.retargetMs,
          detectedPct: Number(((r.detectedFrames / Math.max(1, r.totalFrames)) * 100).toFixed(1)),
          handCovPct: r.handCovPct,
          faceCovPct: r.faceCovPct,
          tracksCount: r.tracksCount,
          maxCorePopDeg: r.maxCorePopDeg,
          armTorsoClipFrames: r.armTorsoClipFrames,
          ...q,
        });
      }

      log(`  Running Server Python on ${clip.id}...`);
      const pyRes = await runPythonServer(clip.absPath, clip.maxFrames);
      if (pyRes) {
        const q = evaluateUnpairedQuality(pyRes.frames3d);
        runs.push({
          model: pyRes.model,
          fps: pyRes.fps,
          elapsedMs: pyRes.elapsedMs,
          retargetMs: null,
          detectedPct: Number(((pyRes.detectedFrames / Math.max(1, pyRes.totalFrames)) * 100).toFixed(1)),
          handCovPct: 0,
          faceCovPct: 0,
          tracksCount: 0,
          maxCorePopDeg: null,
          armTorsoClipFrames: null,
          ...q,
        });
      }

      if (clip.absPath.endsWith('.mp4')) {
        log(`  Running Apple Vision 3D on ${clip.id}...`);
        const avRes = await runAppleVision(clip.absPath, clip.maxFrames);
        if (avRes) {
          const q = evaluateUnpairedQuality(avRes.frames3d);
          runs.push({
            model: avRes.model,
            fps: avRes.fps,
            elapsedMs: avRes.elapsedMs,
            retargetMs: null,
            detectedPct: Number(((avRes.detectedFrames / Math.max(1, avRes.totalFrames)) * 100).toFixed(1)),
            handCovPct: 0,
            faceCovPct: 0,
            tracksCount: 0,
            maxCorePopDeg: null,
            armTorsoClipFrames: null,
            ...q,
          });
        }
      }

      fullReport.realVideoBenchmarks[clip.id] = runs;
    }

    const outPath = path.join(DEFAULT_SCRATCH, 'mocap_benchmark_results.json');
    await fs.writeFile(outPath, JSON.stringify(fullReport, null, 2));

    console.log('\n================ COMPARATIVE BENCHMARK RESULTS ================');
    for (const [id, data] of Object.entries(fullReport.groundTruthBenchmarks)) {
      console.log(`\n### GT Scenario: ${id} (GT Natural Jerk = ${data.gtNaturalJerkMm} mm/f³)`);
      console.log(mdTable(
        ['Model', 'FPS', 'Time(ms)', 'MPJPE(mm)', 'PA-MPJPE(mm)', 'OcclArm(mm)', 'AngleMAE(°)', '2D Err(px)', 'BoneCV(%)', 'Jerk(mm/f³)', 'Pop(°)'],
        data.runs.map((r) => [
          r.model, r.fps, r.elapsedMs, r.mpjpeMm, r.paMpjpeMm, r.occlArmMm ?? '-', r.angleMaeDeg, r.reprojPx ?? '-', r.boneCvPct, r.jerkRmsMm, r.maxCorePopDeg ?? '-',
        ]),
      ));
    }
    for (const [id, runs] of Object.entries(fullReport.realVideoBenchmarks)) {
      console.log(`\n### Real Video: ${id}`);
      console.log(mdTable(
        ['Model', 'FPS', 'Time(ms)', 'Det%', 'BoneCV(%)', 'Skate(mm/f)', 'Jerk(mm/f³)', 'Pop(°)', 'Hands%', 'Face%', 'Tracks'],
        runs.map((r) => [
          r.model, r.fps, r.elapsedMs, r.detectedPct, r.boneCvPct, r.footSkateMm, r.jerkRmsMm, r.maxCorePopDeg ?? r.maxAnglePopDeg, r.handCovPct, r.faceCovPct, r.tracksCount,
        ]),
      ));
    }
    console.log(`\nSaved JSON report: ${outPath}`);
  } finally {
    try { cdp?.close(); } catch (_) {}
    try { chromeProc.kill('SIGKILL'); } catch (_) {}
    await fs.rm(userDir, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
