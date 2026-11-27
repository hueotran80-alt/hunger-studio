/**
 * Web Blender Studio - Mocap Signal Processing (pure math, no Three.js)
 * File: js/animation/mocap-filters.js
 *
 * This module is a JavaScript port of the post-processing pipeline that used to
 * live only in `mocap_engine.py` (Python + MediaPipe + NumPy). Keeping it
 * dependency-free means:
 *   1. it runs unchanged inside the browser (WebAssembly/WebGPU pose tracking,
 *      zero GPU-server cost), and
 *   2. it can be unit tested from plain Node and cross-checked against the
 *      Python implementation (see tests/test_mocap_parity.py).
 *
 * Pipeline order (matches the server engine):
 *   gap fill -> 1-Euro filter -> bone length enforcement -> root trajectory
 *   -> frame assembly -> optional foot-lock IK
 */

/** Joints emitted by the tracking engine (same keys as the server frames). */
export const SKELETON_JOINTS = Object.freeze([
  'nose',
  'leftShoulder', 'rightShoulder',
  'leftElbow', 'rightElbow',
  'leftWrist', 'rightWrist',
  'leftHandIndex', 'rightHandIndex',
  'leftHip', 'rightHip',
  'leftKnee', 'rightKnee',
  'leftAnkle', 'rightAnkle',
  'leftFoot', 'rightFoot',
]);

/** Parent -> child chains, in topological order (parents before children). */
export const BONE_CHAINS = Object.freeze([
  ['leftShoulder', 'leftElbow'],
  ['leftElbow', 'leftWrist'],
  ['leftWrist', 'leftHandIndex'],
  ['rightShoulder', 'rightElbow'],
  ['rightElbow', 'rightWrist'],
  ['rightWrist', 'rightHandIndex'],
  ['leftHip', 'leftKnee'],
  ['leftKnee', 'leftAnkle'],
  ['leftAnkle', 'leftFoot'],
  ['rightHip', 'rightKnee'],
  ['rightKnee', 'rightAnkle'],
  ['rightAnkle', 'rightFoot'],
]);

const DEFAULTS = Object.freeze({
  freq: 30,
  minCutoff: 1.2,
  beta: 0.05,
  dCutoff: 1.0,
});

function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function toVec(value, size = 3) {
  const out = new Array(size).fill(0);
  if (!value || typeof value.length !== 'number') return out;
  for (let i = 0; i < size; i++) out[i] = num(value[i], 0);
  return out;
}

function round5(n) {
  return Number(num(n, 0).toFixed(5));
}

import { clamp as clampNumber, median as medianOf } from './mocap-math.js';

function median(values) {
  return medianOf(values); // dùng chung mocap-math.js
}

function percentile(values, p) {
  const arr = values.filter((v) => Number.isFinite(v)).slice().sort((a, b) => a - b);
  if (arr.length === 0) return null;
  const idx = Math.min(arr.length - 1, Math.max(0, Math.round((arr.length - 1) * p)));
  return arr[idx];
}

function norm3(v) {
  return Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
}

function sub3(a, b) {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function add3(a, b) {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

function scale3(a, s) {
  return [a[0] * s, a[1] * s, a[2] * s];
}

/**
 * Adaptive low-pass filter (Casiez et al. 2012). Removes jitter on slow motion
 * without lagging fast dance movements. Vector valued: one instance filters all
 * three axes of a joint, exactly like the NumPy implementation.
 */
export class OneEuroFilter {
  constructor(options = {}) {
    this.freq = Math.max(1, num(options.freq, DEFAULTS.freq));
    this.minCutoff = Math.max(0.05, num(options.minCutoff, DEFAULTS.minCutoff));
    this.beta = Math.max(0, num(options.beta, DEFAULTS.beta));
    this.dCutoff = Math.max(0.05, num(options.dCutoff, DEFAULTS.dCutoff));
    this.xPrev = null;
    this.dxPrev = null;
  }

  static alpha(cutoff, freq) {
    const te = 1 / Math.max(1, freq);
    const tau = 1 / (2 * Math.PI * Math.max(1e-4, cutoff));
    return 1 / (1 + tau / te);
  }

  reset() {
    this.xPrev = null;
    this.dxPrev = null;
    return this;
  }

  /**
   * @param {ArrayLike<number>} value
   * @param {number} [freq]
   * @returns {number[]}
   */
  filter(value, freq) {
    const f = Math.max(1, num(freq, this.freq));
    const x = toVec(value);
    if (this.xPrev === null) {
      this.xPrev = x.slice();
      this.dxPrev = new Array(x.length).fill(0);
      return x.slice();
    }
    const aD = OneEuroFilter.alpha(this.dCutoff, f);
    const xHat = new Array(x.length);
    const dxHat = new Array(x.length);
    for (let i = 0; i < x.length; i++) {
      const dx = (x[i] - this.xPrev[i]) * f;
      dxHat[i] = aD * dx + (1 - aD) * this.dxPrev[i];
      const cutoff = this.minCutoff + this.beta * Math.abs(dxHat[i]);
      const a = OneEuroFilter.alpha(cutoff, f);
      xHat[i] = a * x[i] + (1 - a) * this.xPrev[i];
    }
    this.xPrev = xHat;
    this.dxPrev = dxHat;
    return xHat;
  }
}

/**
 * Fills missing joint samples (low detection confidence frames) by linear
 * interpolation between the nearest valid neighbours, clamping at both ends.
 * @param {Array<Object>} series
 * @returns {Array<Object>}
 */
export function gapFillSeries(series) {
  if (!Array.isArray(series) || series.length === 0) return [];
  return fillAll(series);
}

function fillAll(series) {
  const n = series.length;
  const filled = series.map((sample) => ({ ...(sample || {}) }));
  const isValidVec3 = (v) => Boolean(
    v &&
    Number.isFinite(num(v[0], NaN)) &&
    Number.isFinite(num(v[1], NaN)) &&
    Number.isFinite(num(v[2], NaN))
  );

  for (const joint of SKELETON_JOINTS) {
    const idx = [];
    for (let i = 0; i < n; i++) {
      const v = filled[i] && filled[i][joint];
      if (isValidVec3(v)) {
        idx.push(i);
      }
    }
    if (idx.length === 0) continue;

    for (let i = 0; i < n; i++) {
      if (isValidVec3(filled[i] && filled[i][joint])) continue;

      if (i < idx[0]) {
        filled[i][joint] = toVec(filled[idx[0]][joint]);
        continue;
      }
      if (i > idx[idx.length - 1]) {
        filled[i][joint] = toVec(filled[idx[idx.length - 1]][joint]);
        continue;
      }

      let next = 0;
      while (next < idx.length && idx[next] < i) next++;
      const lo = idx[next - 1];
      const hi = idx[next];
      const t = (i - lo) / Math.max(1, hi - lo);
      const a = toVec(filled[lo][joint]);
      const b = toVec(filled[hi][joint]);
      filled[i][joint] = [
        a[0] + (b[0] - a[0]) * t,
        a[1] + (b[1] - a[1]) * t,
        a[2] + (b[2] - a[2]) * t,
      ];
    }
  }
  return filled;
}

/**
 * Applies one independent 1-Euro filter per joint.
 * @param {Array<Object>} series
 * @param {{fps?: number, minCutoff?: number, beta?: number, dCutoff?: number}} [options]
 */
export function filterJointSeries(series, options = {}) {
  if (!Array.isArray(series) || series.length === 0) return [];
  const fps = Math.max(1, num(options.fps, DEFAULTS.freq));
  const filters = new Map();
  for (const joint of SKELETON_JOINTS) {
    filters.set(joint, new OneEuroFilter({
      freq: fps,
      minCutoff: options.minCutoff !== undefined ? options.minCutoff : DEFAULTS.minCutoff,
      beta: options.beta !== undefined ? options.beta : DEFAULTS.beta,
      dCutoff: options.dCutoff !== undefined ? options.dCutoff : DEFAULTS.dCutoff,
    }));
  }

  return series.map((sample) => {
    const out = {};
    for (const joint of SKELETON_JOINTS) {
      const filter = filters.get(joint);
      out[joint] = filter.filter(sample[joint] || [0, 0, 0], fps);
    }
    return out;
  });
}

/**
 * Keeps every limb segment at its median length while preserving the captured
 * parent->child unit directions (identical to `_enforce_bone_lengths`).
 * @param {Array<Object>} series
 * @param {Array<[string,string]>} [chains]
 */
export function enforceBoneLengths(series, chains = BONE_CHAINS) {
  if (!Array.isArray(series) || series.length === 0) return [];

  const lengths = new Map();
  for (const [p, c] of chains) {
    const samples = [];
    for (const fr of series) {
      if (fr && fr[p] && fr[c]) samples.push(norm3(sub3(toVec(fr[c]), toVec(fr[p]))));
    }
    const m = median(samples);
    if (m && m > 1e-6) lengths.set(`${p}->${c}`, m);
  }
  if (lengths.size === 0) return series.map((s) => ({ ...s }));

  return series.map((fr) => {
    const out = { ...(fr || {}) };
    // 1. Capture every unit direction BEFORE mutating any joint position.
    const unitDirs = new Map();
    for (const [p, c] of chains) {
      if (!out[p] || !out[c]) continue;
      const d = sub3(toVec(out[c]), toVec(out[p]));
      const dl = norm3(d);
      unitDirs.set(`${p}->${c}`, dl > 1e-6 ? scale3(d, 1 / dl) : [0, -1, 0]);
    }
    // 2. Rebuild joints down each chain in topological order.
    for (const [p, c] of chains) {
      const key = `${p}->${c}`;
      const len = lengths.get(key);
      if (!unitDirs.has(key) || !len) continue;
      out[c] = add3(toVec(out[p]), scale3(unitDirs.get(key), len));
    }
    return out;
  });
}

/**
 * Reconstructs metric root displacement from 2D hip motion scaled by the median
 * 3D-to-2D torso length ratio (port of `_compute_metric_root_trajectory`).
 * @param {Array<Object>} series filtered joint series
 * @param {Array<Array<number>>} hip2dSeries [cx, cy, torsoPx, confidence]
 * @param {number} fps
 * @returns {Array<[number,number,number]>}
 */
export function computeRootTrajectory(series, hip2dSeries, fps) {
  const n = series ? series.length : 0;
  if (n === 0) return [];
  const zeros = () => new Array(n).fill(0).map(() => [0, 0, 0]);
  const hip2d = Array.isArray(hip2dSeries) ? hip2dSeries : [];

  const torso3d = [];
  const torso2d = [];
  const hipsX = [];
  const hipsY = [];

  for (let i = 0; i < n; i++) {
    const h2d = toVec(hip2d[i], 4);
    const fr = series[i] || {};
    if (h2d[3] >= 0.45 && h2d[2] > 15 && fr.leftHip && fr.rightHip && fr.leftShoulder && fr.rightShoulder) {
      const midHip = scale3(add3(toVec(fr.leftHip), toVec(fr.rightHip)), 0.5);
      const midSh = scale3(add3(toVec(fr.leftShoulder), toVec(fr.rightShoulder)), 0.5);
      const t3d = norm3(sub3(midSh, midHip));
      if (t3d > 0.15) {
        torso3d.push(t3d);
        torso2d.push(h2d[2]);
      }
      hipsX.push(h2d[0]);
      hipsY.push(h2d[1]);
    }
  }

  if (torso2d.length === 0 || hipsX.length === 0) return zeros();

  const medT3d = median(torso3d) || 0.45;
  const medT2d = Math.max(20, median(torso2d) || 0);
  const metersPerPx = medT3d / medT2d;
  const refX = median(hipsX);
  const refY = median(hipsY);

  // Interpolate low-confidence 2D hip positions before filtering.
  const xs = new Array(n);
  const ys = new Array(n);
  const good = [];
  for (let i = 0; i < n; i++) {
    const h2d = toVec(hip2d[i], 4);
    xs[i] = h2d[0];
    ys[i] = h2d[1];
    if (h2d[3] >= 0.35) good.push(i);
  }
  if (good.length > 0) {
    for (let i = 0; i < n; i++) {
      if (good.includes(i)) continue;
      let prev = null;
      let next = null;
      for (const g of good) {
        if (g < i) prev = g;
        else { next = g; break; }
      }
      if (prev === null) { xs[i] = xs[good[0]]; ys[i] = ys[good[0]]; }
      else if (next === null) { xs[i] = xs[good[good.length - 1]]; ys[i] = ys[good[good.length - 1]]; }
      else {
        const t = (i - prev) / Math.max(1, next - prev);
        xs[i] = xs[prev] + (xs[next] - xs[prev]) * t;
        ys[i] = ys[prev] + (ys[next] - ys[prev]) * t;
      }
    }
  }

  const rootFilter = new OneEuroFilter({ freq: fps, minCutoff: 1.0, beta: 0.03 });
  const offsets = [];
  const clamp = clampNumber;
  for (let i = 0; i < n; i++) {
    const dx = clamp((xs[i] - refX) * metersPerPx, -2.5, 2.5);
    // Image +Y points down; 3D +Y points up.
    const dy = clamp(-(ys[i] - refY) * metersPerPx, -0.6, 0.8);
    offsets.push(rootFilter.filter([dx, dy, 0], fps));
  }
  return offsets;
}

/**
 * Assembles server-compatible mocap frames (derived torso joints + root offset).
 * `times` (seconds, real video timestamps) overrides the default `i / fps`
 * spacing so a clip sampled with a frame step keeps its true duration.
 * @param {Array<Object>} jointSeries
 * @param {{fps?: number, times?: number[], rootOffsets?: Array<number[]>}} [options]
 */
export function buildMocapFrames(jointSeries, options = {}) {
  const fps = Math.max(1, num(options.fps, 30));
  const rootOffsets = Array.isArray(options.rootOffsets) ? options.rootOffsets : null;
  const times = Array.isArray(options.times) ? options.times : null;

  return (jointSeries || []).map((sm, i) => {
    const off = toVec(rootOffsets ? rootOffsets[i] : [0, 0, 0]);
    const withRoot = (vec) => [round5(vec[0] + off[0]), round5(vec[1] + off[1]), round5(vec[2] + off[2])];

    const midHip = scale3(add3(toVec(sm.leftHip), toVec(sm.rightHip)), 0.5);
    const midSh = scale3(add3(toVec(sm.leftShoulder), toVec(sm.rightShoulder)), 0.5);
    const spine = add3(midHip, scale3(sub3(midSh, midHip), 0.65));

    return {
      time: round5(times && Number.isFinite(times[i]) ? times[i] : i / fps),
      midHip: withRoot(midHip),
      spine: withRoot(spine),
      neck: withRoot(midSh),
      nose: withRoot(toVec(sm.nose)),
      leftShoulder: withRoot(toVec(sm.leftShoulder)),
      leftElbow: withRoot(toVec(sm.leftElbow)),
      leftWrist: withRoot(toVec(sm.leftWrist)),
      leftHandIndex: withRoot(toVec(sm.leftHandIndex)),
      rightShoulder: withRoot(toVec(sm.rightShoulder)),
      rightElbow: withRoot(toVec(sm.rightElbow)),
      rightWrist: withRoot(toVec(sm.rightWrist)),
      rightHandIndex: withRoot(toVec(sm.rightHandIndex)),
      leftHip: withRoot(toVec(sm.leftHip)),
      leftKnee: withRoot(toVec(sm.leftKnee)),
      leftAnkle: withRoot(toVec(sm.leftAnkle)),
      leftFoot: withRoot(toVec(sm.leftFoot)),
      rightHip: withRoot(toVec(sm.rightHip)),
      rightKnee: withRoot(toVec(sm.rightKnee)),
      rightAnkle: withRoot(toVec(sm.rightAnkle)),
      rightFoot: withRoot(toVec(sm.rightFoot)),
    };
  });
}

/**
 * Detects which frames have a planted foot (Foot IK contact detection).
 *
 * Axis-agnostic: the "+Y down" convention (MediaPipe) and "+Y up" (Three.js) are
 * both handled by measuring the hip->ankle direction instead of assuming a sign.
 *
 * @param {Array<Object>} frames mocap frames containing ankle/foot joints
 * @param {{fps?: number, heightTol?: number, speedTol?: number, releaseFactor?: number}} [options]
 */
export function detectFootContacts(frames, options = {}) {
  const fps = Math.max(1, num(options.fps, 30));
  const heightTol = num(options.heightTol, 0.045);
  const speedTol = num(options.speedTol, 1.6);
  const releaseFactor = Math.max(1.2, num(options.releaseFactor, 2.2));
  const n = Array.isArray(frames) ? frames.length : 0;
  const sides = ['left', 'right'];
  const result = {
    left: new Array(n).fill(false),
    right: new Array(n).fill(false),
    groundDepth: 0,
    verticalSign: 1,
    fps,
  };
  if (n === 0) return result;

  const hipY = [];
  const ankleY = { left: [], right: [] };
  for (const f of frames) {
    const mid = f && f.midHip ? toVec(f.midHip) : null;
    const lh = f && f.leftHip ? toVec(f.leftHip) : null;
    const rh = f && f.rightHip ? toVec(f.rightHip) : null;
    const hip = mid || (lh && rh ? scale3(add3(lh, rh), 0.5) : null);
    if (hip) hipY.push(hip[1]);
    for (const side of sides) {
      const ankle = f && f[`${side}Ankle`] ? toVec(f[`${side}Ankle`]) : null;
      if (ankle) ankleY[side].push(ankle[1]);
    }
  }
  const mean = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0);
  const allAnkles = ankleY.left.concat(ankleY.right);
  if (allAnkles.length === 0 || hipY.length === 0) return result;

  const verticalSign = mean(allAnkles) >= mean(hipY) ? 1 : -1;
  result.verticalSign = verticalSign;

  // Depth grows away from the hip: the deepest point over the whole clip is the floor.
  const depthOf = (y) => (y - mean(hipY)) * verticalSign;
  const allDepths = allAnkles.map(depthOf);
  const groundDepth = percentile(allDepths, 0.97);
  result.groundDepth = groundDepth;

  for (const side of sides) {
    let planted = false;
    let prevXZ = null;
    for (let i = 0; i < n; i++) {
      const f = frames[i] || {};
      const ankle = f[`${side}Ankle`] ? toVec(f[`${side}Ankle`]) : null;
      if (!ankle) { prevXZ = null; planted = false; continue; }
      const height = Math.max(0, groundDepth - depthOf(ankle[1]));
      let speed = 0;
      if (prevXZ) {
        speed = Math.hypot(ankle[0] - prevXZ[0], ankle[2] - prevXZ[2]) * fps;
      }
      prevXZ = [ankle[0], ankle[2]];

      if (!planted) {
        planted = height <= heightTol && speed <= speedTol;
      } else {
        planted = !(height > heightTol * releaseFactor || speed > speedTol * releaseFactor);
      }
      result[side][i] = planted;
    }
  }
  return result;
}

/**
 * Foot-Lock IK: while a foot is planted, its ankle/toe positions are anchored to
 * the contact point so the character no longer slides on the floor. Shin length
 * is preserved by re-solving the ankle height against the knee.
 *
 * @param {Array<Object>} frames
 * @param {Object} [options] see detectFootContacts
 * @returns {{frames: Array<Object>, contacts: Object, locked: {left: number, right: number}}}
 */
export function applyFootLock(frames, options = {}) {
  if (!Array.isArray(frames) || frames.length === 0) {
    return { frames: frames || [], contacts: detectFootContacts([], options), locked: { left: 0, right: 0 } };
  }
  const contacts = detectFootContacts(frames, options);
  const out = frames.map((f) => ({ ...f }));
  const locked = { left: 0, right: 0 };

  for (const side of ['left', 'right']) {
    const hipKey = `${side}Hip`;
    const ankleKey = `${side}Ankle`;
    const footKey = `${side}Foot`;
    const kneeKey = `${side}Knee`;
    let anchor = null;
    let thighLen = null;
    let shinLen = null;

    for (let i = 0; i < out.length; i++) {
      const frame = out[i];
      if (!contacts[side][i] || !frame[ankleKey]) {
        anchor = null;
        thighLen = null;
        shinLen = null;
        continue;
      }

      const hip = frame[hipKey] ? toVec(frame[hipKey]) : null;
      const ankle = toVec(frame[ankleKey]);
      const knee = frame[kneeKey] ? toVec(frame[kneeKey]) : null;

      if (!anchor) {
        anchor = [ankle[0], ankle[2]];
        if (hip && knee) {
          thighLen = Math.max(0.05, Math.hypot(knee[0] - hip[0], knee[1] - hip[1], knee[2] - hip[2]));
        }
        shinLen = knee ? Math.max(0.05, Math.hypot(ankle[0] - knee[0], ankle[1] - knee[1], ankle[2] - knee[2])) : null;
      }

      const next = ankle.slice();
      next[0] = anchor[0];
      next[2] = anchor[1];

      if (hip && thighLen && shinLen) {
        const reachMax = (thighLen + shinLen) * 0.992;
        const reachMin = Math.max(Math.abs(thighLen - shinLen), 0.22 * (thighLen + shinLen));
        const dx = next[0] - hip[0];
        const dz = next[2] - hip[2];
        const horiz = Math.hypot(dx, dz);
        const horizLimit = reachMax * 0.96;
        if (horiz > horizLimit && horiz > 1e-6) {
          // Only pull the XZ anchor inward when horizontal offset alone exceeds straight-leg reach.
          const sc = horizLimit / horiz;
          next[0] = hip[0] + dx * sc;
          next[2] = hip[2] + dz * sc;
          anchor = [next[0], next[2]];
        }
        const dy = next[1] - hip[1];
        const dx2 = next[0] - hip[0];
        const dz2 = next[2] - hip[2];
        const dist = Math.hypot(dx2, dy, dz2);
        if (dist > reachMax && dist > 1e-6) {
          const maxDy = Math.sqrt(Math.max(0, reachMax * reachMax - (dx2 * dx2 + dz2 * dz2)));
          next[1] = hip[1] + (dy >= 0 ? 1 : -1) * maxDy;
        } else if (dist < reachMin && dist > 1e-6) {
          const minDy = Math.sqrt(Math.max(0, reachMin * reachMin - (dx2 * dx2 + dz2 * dz2)));
          next[1] = hip[1] + (dy >= 0 ? 1 : -1) * minDy;
        }
      }

      if (knee && shinLen) {
        const planar = Math.hypot(next[0] - knee[0], next[2] - knee[2]);
        const clampedPlanar = Math.min(planar, shinLen * 0.995);
        if (planar > shinLen * 0.995 && planar > 1e-6) {
          const sc = clampedPlanar / planar;
          next[0] = knee[0] + (next[0] - knee[0]) * sc;
          next[2] = knee[2] + (next[2] - knee[2]) * sc;
        }
        const residual = shinLen * shinLen - clampedPlanar * clampedPlanar;
        const sign = ankle[1] - knee[1] >= 0 ? 1 : -1;
        next[1] = knee[1] + sign * Math.sqrt(Math.max(0, residual));
      }

      const shiftedX = next[0] - ankle[0];
      const shiftedY = next[1] - ankle[1];
      const shiftedZ = next[2] - ankle[2];
      frame[ankleKey] = next;
      if (frame[footKey]) {
        const foot = toVec(frame[footKey]);
        frame[footKey] = [foot[0] + shiftedX, foot[1] + shiftedY, foot[2] + shiftedZ];
      }
      locked[side] += 1;
    }
  }

  return { frames: out, contacts, locked };
}

/**
 * Convenience wrapper: gap fill -> filter -> bone lengths -> frames.
 * `fps` is the *sample* rate of `rawSeries` (videoFps / frameStep when the
 * caller subsampled the video), while `times` carries the real video stamps.
 */
export function processJointSeries(rawSeries, options = {}) {
  const fps = Math.max(1, num(options.fps, 30));
  const filled = gapFillSeries(rawSeries);
  const filtered = filterJointSeries(filled, {
    fps,
    minCutoff: options.minCutoff,
    beta: options.beta,
  });
  let jointsForFrames = enforceBoneLengths(filtered);
  let rootOffsets = options.rootOffsets || null;
  if (!rootOffsets && options.hip2dSeries) {
    rootOffsets = computeRootTrajectory(jointsForFrames, options.hip2dSeries, fps);
    const hipAnkleDys = jointsForFrames
      .filter((fr) => fr?.leftAnkle && fr?.leftHip)
      .map((fr) => fr.leftAnkle[1] - fr.leftHip[1]);
    hipAnkleDys.sort((a, b) => a - b);
    const isYDown = hipAnkleDys.length > 0 && hipAnkleDys[Math.floor(hipAnkleDys.length / 2)] > 0.05;
    if (isYDown) {
      jointsForFrames = jointsForFrames.map((fr) => {
        if (!fr) return fr;
        const next = {};
        for (const [k, val] of Object.entries(fr)) {
          next[k] = Array.isArray(val) && val.length >= 3 ? [val[0], -val[1], -val[2]] : val;
        }
        return next;
      });
    }
  }
  const frames = buildMocapFrames(jointsForFrames, { fps, times: options.times, rootOffsets });
  return frames;
}
