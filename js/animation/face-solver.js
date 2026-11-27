/**
 * Facial Expression (52 ARKit BlendShapes) & Head Pose Refinement Solver
 * File: js/animation/face-solver.js
 *
 * Maps MediaPipe FaceLandmarker outputs (`faceBlendshapes` + `facialTransformationMatrixes`)
 * onto Three.js SkinnedMesh `morphTargetInfluences`, optional `jaw` bone pitch, and
 * smoothed `Head` orientation refinement inside an AnimationClip.
 */

import * as THREE from 'three';

/** Canonical 52 ARKit blendshape keys emitted by MediaPipe FaceLandmarker. */
export const ARKIT_BLENDSHAPES = Object.freeze([
  '_neutral',
  'browDownLeft', 'browDownRight', 'browInnerUp', 'browOuterUpLeft', 'browOuterUpRight',
  'cheekPuff', 'cheekSquintLeft', 'cheekSquintRight',
  'eyeBlinkLeft', 'eyeBlinkRight',
  'eyeLookDownLeft', 'eyeLookDownRight', 'eyeLookInLeft', 'eyeLookInRight',
  'eyeLookOutLeft', 'eyeLookOutRight', 'eyeLookUpLeft', 'eyeLookUpRight',
  'eyeSquintLeft', 'eyeSquintRight', 'eyeWideLeft', 'eyeWideRight',
  'jawForward', 'jawLeft', 'jawOpen', 'jawRight',
  'mouthClose', 'mouthDimpleLeft', 'mouthDimpleRight', 'mouthFrownLeft', 'mouthFrownRight',
  'mouthFunnel', 'mouthLeft', 'mouthLowerDownLeft', 'mouthLowerDownRight',
  'mouthPressLeft', 'mouthPressRight', 'mouthPucker', 'mouthRight',
  'mouthRollLower', 'mouthRollUpper', 'mouthShrugLower', 'mouthShrugUpper',
  'mouthSmileLeft', 'mouthSmileRight', 'mouthStretchLeft', 'mouthStretchRight',
  'mouthUpperUpLeft', 'mouthUpperUpRight',
  'noseSneerLeft', 'noseSneerRight',
]);

function normalizeMorphKey(name) {
  let s = String(name || '');
  s = s.replace(/^(?:ctrl[_-]expressions[_-]|arkit[_-]|bs[_-])/i, '');
  s = s.replace(/(?:^|[_\-.\s])([lL])(?=$|[_\-.\s0-9])/g, '_left_');
  s = s.replace(/(?:^|[_\-.\s])([rR])(?=$|[_\-.\s0-9])/g, '_right_');
  s = s.replace(/([a-z0-9])([LR])$/g, (_, prev, side) => prev + (side === 'L' ? 'Left' : 'Right'));
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

const VRM_MORPH_ALIASES = Object.freeze({
  blink: ['eyeblinkleft', 'eyeblinkright'],
  blinkl: ['eyeblinkleft'],
  blinkleft: ['eyeblinkleft'],
  blinkr: ['eyeblinkright'],
  blinkright: ['eyeblinkright'],
  a: ['jawopen'],
  aa: ['jawopen'],
  o: ['mouthfunnel', 'jawopen'],
  oh: ['mouthfunnel', 'jawopen'],
  u: ['mouthpucker'],
  ou: ['mouthpucker'],
  joy: ['mouthsmileleft', 'mouthsmileright'],
  happy: ['mouthsmileleft', 'mouthsmileright'],
  fun: ['mouthsmileleft', 'mouthsmileright'],
  angry: ['browdownleft', 'browdownright'],
  sorrow: ['browinnerup', 'mouthfrownleft', 'mouthfrownright'],
  surprised: ['browinnerup', 'eyewideleft', 'eyewideright', 'jawopen'],
});

/**
 * Forward-backward zero-phase exponential smoothing for scalar `[0, 1]` curves with gap decay.
 */
function smoothScalarSeries(values, dt = 1 / 30, tau = 0.065) {
  const n = values.length;
  if (n < 3) return values;
  const alpha = Math.max(0.15, Math.min(0.92, 1 - Math.exp(-dt / Math.max(1e-3, tau))));
  const fwd = new Float32Array(n);
  const out = new Float32Array(n);
  fwd[0] = values[0];
  for (let i = 1; i < n; i++) {
    fwd[i] = fwd[i - 1] + (values[i] - fwd[i - 1]) * alpha;
  }
  out[n - 1] = fwd[n - 1];
  for (let i = n - 2; i >= 0; i--) {
    out[i] = out[i + 1] + (fwd[i] - out[i + 1]) * alpha;
  }
  return out;
}

/**
 * Extract euler head angles `[pitch, yaw, roll]` from MediaPipe 4x4 facial transformation matrix.
 */
export function extractHeadEulerFromMatrix(matData) {
  if (!matData || matData.length < 16) return null;
  const m = new THREE.Matrix4().fromArray(matData);
  const rotQ = new THREE.Quaternion().setFromRotationMatrix(m);
  const e = new THREE.Euler().setFromQuaternion(rotQ, 'YXZ');
  if (!Number.isFinite(e.x) || !Number.isFinite(e.y) || !Number.isFinite(e.z)) return null;
  return { pitch: e.x, yaw: e.y, roll: e.z };
}

/**
 * Find all target morph bindings across `character` meshes matching ARKit or VRM blendshapes.
 */
export function collectFaceMorphBindings(character) {
  const bindings = [];
  if (!character || typeof character.traverse !== 'function') return bindings;

  character.traverse((obj) => {
    if (!obj || !obj.morphTargetDictionary || !obj.morphTargetInfluences) return;
    const meshKey = obj.name || obj.uuid;
    const dict = obj.morphTargetDictionary;
    for (const [morphName, index] of Object.entries(dict)) {
      const norm = normalizeMorphKey(morphName);
      if (!norm || norm === 'neutral') continue;
      let arkitSources = null;
      const direct = ARKIT_BLENDSHAPES.find((k) => normalizeMorphKey(k) === norm);
      if (direct) {
        arkitSources = [direct];
      } else if (VRM_MORPH_ALIASES[norm]) {
        arkitSources = VRM_MORPH_ALIASES[norm]
          .map((alias) => ARKIT_BLENDSHAPES.find((k) => normalizeMorphKey(k) === alias))
          .filter(Boolean);
      }
      if (arkitSources && arkitSources.length > 0) {
        const safePropKey = /[\[\].]/.test(morphName) ? String(index) : morphName;
        bindings.push({
          mesh: obj,
          trackName: `${meshKey}.morphTargetInfluences[${safePropKey}]`,
          morphName,
          index,
          arkitSources,
        });
      }
    }
  });
  return bindings;
}

/**
 * Build MorphTarget (`NumberKeyframeTrack`), optional `Jaw` bone track, and optional
 * `Head` fine orientation blend when `faceFrames` contain detected faces.
 *
 * Returns `{ tracks, headTrackUpdated, morphTrackCount, jawAnimated, detectedFrames }`.
 */
export function solveFaceAndExpressionTracks({
  faceFrames,
  character,
  rig = {},
  times,
  fps = 30,
  mirrorX = false,
  coreQuatBuffers = null,
  blendHeadPose = true,
  headBlendWeight = 0.65,
}) {
  const nFrames = (times && typeof times.length === 'number') ? times.length : 0;
  if (nFrames === 0 || !Array.isArray(faceFrames) || faceFrames.length === 0 || !character) {
    return { tracks: [], headTrackUpdated: false, morphTrackCount: 0, jawAnimated: false, detectedFrames: 0 };
  }

  const dt = 1 / Math.max(1, fps);
  const maxGap = Math.max(4, Math.round(fps * 0.45));
  let detectedFrames = 0;

  // Build smoothed per-frame blendshape cache with gap interpolation
  const shapeSeries = new Map();
  const validIndices = [];
  for (let f = 0; f < nFrames; f++) {
    const ff = faceFrames[f];
    if (ff && ff.confidence > 0.25 && ff.blendshapes) {
      validIndices.push(f);
      detectedFrames += 1;
    }
  }

  if (detectedFrames === 0) {
    return { tracks: [], headTrackUpdated: false, morphTrackCount: 0, jawAnimated: false, detectedFrames: 0 };
  }

  const tracks = [];
  const morphBindings = collectFaceMorphBindings(character);
  const neededShapes = new Set();
  for (const b of morphBindings) {
    for (const s of b.arkitSources) neededShapes.add(s);
  }
  if (rig.jaw) neededShapes.add('jawOpen');

  for (const shapeKey of neededShapes) {
    const raw = new Float32Array(nFrames);
    // Fill detected samples
    for (const f of validIndices) {
      const bs = faceFrames[f].blendshapes;
      let val = Number(bs[shapeKey] ?? 0);
      if (mirrorX) {
        if (shapeKey.endsWith('Left')) val = Number(bs[shapeKey.replace(/Left$/, 'Right')] ?? val);
        else if (shapeKey.endsWith('Right')) val = Number(bs[shapeKey.replace(/Right$/, 'Left')] ?? val);
      }
      raw[f] = Math.max(0, Math.min(1, Number.isFinite(val) ? val : 0));
    }
    // Bridge short dropouts & decay edges smoothly
    for (let vi = 0; vi < validIndices.length - 1; vi++) {
      const a = validIndices[vi];
      const b = validIndices[vi + 1];
      const gap = b - a;
      if (gap > 1 && gap <= maxGap) {
        for (let k = a + 1; k < b; k++) {
          const t = (k - a) / gap;
          raw[k] = raw[a] * (1 - t) + raw[b] * t;
        }
      }
    }
    shapeSeries.set(shapeKey, smoothScalarSeries(raw, dt, 0.055));
  }

  let morphTrackCount = 0;
  for (const binding of morphBindings) {
    const vals = new Float32Array(nFrames);
    const nSrc = binding.arkitSources.length;
    let peak = 0;
    for (let f = 0; f < nFrames; f++) {
      let acc = 0;
      for (const s of binding.arkitSources) {
        acc += shapeSeries.get(s)?.[f] ?? 0;
      }
      const v = Math.max(0, Math.min(1, acc / nSrc));
      vals[f] = v;
      if (v > peak) peak = v;
    }
    if (peak < 1e-4) continue;
    tracks.push(new THREE.NumberKeyframeTrack(binding.trackName, times, vals));
    morphTrackCount += 1;
  }

  // Optional Jaw Bone Animation when character has a physical jaw bone
  let jawAnimated = false;
  if (rig.jaw && shapeSeries.has('jawOpen')) {
    const jawOpenSeries = shapeSeries.get('jawOpen');
    const restQ = rig.jaw.quaternion ? rig.jaw.quaternion.clone() : new THREE.Quaternion();
    const jawAxis = new THREE.Vector3(1, 0, 0);
    const jawVals = new Float32Array(nFrames * 4);
    const qDelta = new THREE.Quaternion();
    const qOut = new THREE.Quaternion();
    for (let f = 0; f < nFrames; f++) {
      const angle = THREE.MathUtils.clamp((jawOpenSeries[f] || 0) * 0.42, 0, 0.45);
      qDelta.setFromAxisAngle(jawAxis, angle);
      qOut.copy(restQ).multiply(qDelta).normalize();
      qOut.toArray(jawVals, f * 4);
    }
    tracks.push(new THREE.QuaternionKeyframeTrack(`${rig.jaw.name}.quaternion`, times, jawVals));
    jawAnimated = true;
  }

  // Fine Head orientation blend from FaceLandmarker 3D facial transformation matrix
  let headTrackUpdated = false;
  const headBuf = coreQuatBuffers?.head;
  const headBone = rig.head;
  if (blendHeadPose && headBone && headBuf && headBuf.length >= nFrames * 4) {
    const eulerFrames = new Array(nFrames).fill(null);
    let pitchSum = 0;
    let validMatCount = 0;
    for (let f = 0; f < nFrames; f++) {
      const ff = faceFrames[f];
      if (!ff || ff.confidence < 0.45 || !ff.matrix) continue;
      const e = extractHeadEulerFromMatrix(ff.matrix);
      if (e) {
        eulerFrames[f] = e;
        pitchSum += e.pitch;
        validMatCount += 1;
      }
    }

    if (validMatCount >= 3) {
      const neutralPitch = pitchSum / validMatCount;
      const qBody = new THREE.Quaternion();
      const qFaceDelta = new THREE.Quaternion();
      const qBlended = new THREE.Quaternion();
      const qPrev = new THREE.Quaternion();
      const eulerDelta = new THREE.Euler(0, 0, 0, 'YXZ');

      // Temporal weight ramp so transitions when person turns sideways away from camera stay seamless
      const weights = new Float32Array(nFrames);
      for (let f = 0; f < nFrames; f++) {
        weights[f] = eulerFrames[f] ? THREE.MathUtils.clamp(faceFrames[f].confidence, 0, 1) * headBlendWeight : 0;
      }
      const smoothWeights = smoothScalarSeries(weights, dt, 0.14);

      for (let f = 0; f < nFrames; f++) {
        const w = smoothWeights[f];
        if (w < 0.02 || !eulerFrames[f]) continue;
        const e = eulerFrames[f];
        const yawSign = mirrorX ? 1 : -1;
        const rollSign = mirrorX ? -1 : 1;
        eulerDelta.set(
          THREE.MathUtils.clamp((e.pitch - neutralPitch) * 0.72, -0.45, 0.45),
          THREE.MathUtils.clamp(e.yaw * yawSign * 0.55, -0.42, 0.42),
          THREE.MathUtils.clamp(e.roll * rollSign * 0.75, -0.40, 0.40),
          'YXZ',
        );
        qFaceDelta.setFromEuler(eulerDelta);
        qBody.fromArray(headBuf, f * 4);
        qBlended.copy(qBody).multiply(qFaceDelta).normalize();
        qBody.slerp(qBlended, w).normalize();

        if (f > 0) {
          qPrev.fromArray(headBuf, (f - 1) * 4);
          if (qPrev.dot(qBody) < 0) qBody.set(-qBody.x, -qBody.y, -qBody.z, -qBody.w);
        }
        qBody.toArray(headBuf, f * 4);
        headTrackUpdated = true;
      }
    }
  }

  return {
    tracks,
    headTrackUpdated,
    morphTrackCount,
    jawAnimated,
    detectedFrames,
  };
}
