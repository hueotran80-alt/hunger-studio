/**
 * Automated Node regression + performance tests for Rust WASM Mocap Engine & Re-Apply fixes.
 * Run:
 *   node --import ./tests/three-resolve-hooks.mjs tests/test_mocap_kernel.mjs
 */
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
  initMocapKernel,
  isMocapKernelReady,
  processJointsWasm,
  applyFootLockWasm,
} from '../js/animation/mocap-kernel-bridge.js';
import { MocapRetargeter } from '../js/animation/mocap-retargeter.js';
import { TimelineEngine } from '../js/animation/timeline-engine.js';
import { CameraMotionEstimator } from '../js/animation/camera-motion.js';
import { exportClipToBVH } from '../js/animation/bvh-exporter.js';

let passed = 0;
const failures = [];
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`ok   ${name}`);
  } catch (err) {
    failures.push({ name, err });
    console.error(`FAIL ${name}\n     ${err?.stack || err?.message}`);
  }
}

/** Build an anatomically laid-out Mixamo-style 20-bone humanoid rig facing +Z (Y-up). */
function buildRealisticHumanoid(name = 'HumanA', scaleXZ = 1.0) {
  const root = new THREE.Group();
  root.name = name;

  const joints = [
    ['Hips', null, [0, 0.95, 0]],
    ['Spine', 'Hips', [0, 0.14, 0]],
    ['Spine1', 'Spine', [0, 0.15, 0]],
    ['Spine2', 'Spine1', [0, 0.16, 0]],
    ['Neck', 'Spine2', [0, 0.13, 0]],
    ['Head', 'Neck', [0, 0.16, 0]],
    ['LeftShoulder', 'Spine2', [0.06 * scaleXZ, 0.10, 0]],
    ['LeftArm', 'LeftShoulder', [0.12 * scaleXZ, 0.0, 0]],
    ['LeftForearm', 'LeftArm', [0.24 * scaleXZ, 0.0, 0]],
    ['LeftHand', 'LeftForearm', [0.22 * scaleXZ, 0.0, 0]],
    ['RightShoulder', 'Spine2', [-0.06 * scaleXZ, 0.10, 0]],
    ['RightArm', 'RightShoulder', [-0.12 * scaleXZ, 0.0, 0]],
    ['RightForearm', 'RightArm', [-0.24 * scaleXZ, 0.0, 0]],
    ['RightHand', 'RightForearm', [-0.22 * scaleXZ, 0.0, 0]],
    ['LeftUpLeg', 'Hips', [0.10 * scaleXZ, -0.05, 0]],
    ['LeftLeg', 'LeftUpLeg', [0, -0.43, 0]],
    ['LeftFoot', 'LeftLeg', [0, -0.42, 0]],
    ['RightUpLeg', 'Hips', [-0.10 * scaleXZ, -0.05, 0]],
    ['RightLeg', 'RightUpLeg', [0, -0.43, 0]],
    ['RightFoot', 'RightLeg', [0, -0.42, 0]],
  ];

  const bones = new Map();
  for (const [bName, parentName, [x, y, z]] of joints) {
    const b = new THREE.Bone();
    b.name = bName;
    b.position.set(x, y, z);
    const parent = parentName ? bones.get(parentName) : null;
    if (parent) parent.add(b);
    else root.add(b);
    bones.set(bName, b);
  }
  root.updateMatrixWorld(true);
  MocapRetargeter.captureBindPose(root);
  return { root, bones };
}

/** Synthesize raw MediaPipe-convention joints (+Y down: head < 0, ankle > 0) for walking + arm wave. */
function makeRawYDownJointSeries(nFrames = 90, { withGlitch = false, slideLeftFoot = false } = {}) {
  const series = [];
  const hip2d = [];
  for (let i = 0; i < nFrames; i++) {
    const t = i / (nFrames - 1);
    const phase = t * Math.PI * 4;
    const armLift = Math.sin(phase) * 0.15;
    const kneeSwing = Math.sin(phase) * 0.12;
    const leftAnkleX = slideLeftFoot ? -0.10 + 0.25 * t : 0.10;
    const glitch = (withGlitch && i === Math.floor(nFrames / 2)) ? 9.5 : 0;

    series.push({
      nose: [0, -0.58 + glitch, 0.05],
      leftShoulder: [0.18, -0.45, 0],
      rightShoulder: [-0.18, -0.45, 0],
      leftElbow: [0.35, -0.25 - armLift, 0.08],
      rightElbow: [-0.35, -0.25 + armLift, 0.08],
      leftWrist: [0.46, -0.05 - armLift * 1.4, 0.14 + glitch],
      rightWrist: [-0.46, -0.05 + armLift * 1.4, 0.14],
      leftHandIndex: [0.50, 0.02 - armLift * 1.4, 0.16],
      rightHandIndex: [-0.50, 0.02 + armLift * 1.4, 0.16],
      leftHip: [0.10, 0.0, 0],
      rightHip: [-0.10, 0.0, 0],
      leftKnee: [0.10, 0.43, 0.06],
      rightKnee: [-0.10, 0.43, 0.06 + kneeSwing * 0.5],
      leftAnkle: [leftAnkleX, 0.85, 0.0],
      rightAnkle: [-0.10, 0.80 - Math.max(0, Math.sin(phase)) * 0.12, -kneeSwing],
      leftFoot: [leftAnkleX, 0.90, 0.14],
      rightFoot: [-0.10, 0.85 - Math.max(0, Math.sin(phase)) * 0.12, -kneeSwing + 0.14],
    });
    // Subject walks subtly closer to camera (apparent torso scale increases smoothly)
    hip2d.push([0.5 + 0.05 * Math.sin(t * Math.PI), 0.52, 0.20 + 0.05 * t, 0.95]);
  }
  return { series, hip2d };
}

function buildMocapResult(nFrames = 90, { fps = 30, footLock = true, slideLeftFoot = false } = {}) {
  const { series, hip2d } = makeRawYDownJointSeries(nFrames, { slideLeftFoot });
  const rawWasm = processJointsWasm(series, { fps, hip2dSeries: hip2d, footLock: false });
  assert.ok(rawWasm && rawWasm.frames.length === nFrames, 'processJointsWasm should generate raw frames');
  let locked = null;
  if (footLock) {
    locked = applyFootLockWasm(rawWasm.frames, { fps });
  }
  return {
    success: true,
    engine: 'browser-wasm',
    kernelEngine: 'rust-wasm',
    fps,
    duration: (nFrames - 1) / fps,
    numFrames: nFrames,
    rawMocapFrames: rawWasm.frames,
    mocapFrames: locked ? locked.frames : rawWasm.frames,
    footLockFlags: locked ? locked.flags : null,
  };
}

function maxTrackDiff(clipA, clipB) {
  assert.equal(clipA.tracks.length, clipB.tracks.length, 'track count should match');
  let maxErr = 0;
  for (let t = 0; t < clipA.tracks.length; t++) {
    const a = clipA.tracks[t];
    const b = clipB.tracks[t];
    assert.equal(a.name, b.name, `track ${t} name should match`);
    assert.equal(a.values.length, b.values.length, `track ${a.name} value length should match`);
    for (let i = 0; i < a.values.length; i++) {
      maxErr = Math.max(maxErr, Math.abs(a.values[i] - b.values[i]));
    }
  }
  return maxErr;
}

await test('1. Pure-Rust mocap_kernel.wasm initializes in Node', async () => {
  const ready = await initMocapKernel();
  assert.equal(ready, true);
  assert.equal(isMocapKernelReady(), true);
});

await test('2. processJointsWasm despikes 1-frame outlier & preserves smooth 3D Z root motion', async () => {
  const { series, hip2d } = makeRawYDownJointSeries(60, { withGlitch: true });
  const res = processJointsWasm(series, { fps: 30, hip2dSeries: hip2d, footLock: false });
  assert.ok(res && res.frames.length === 60);

  // Mid-frame nose/leftWrist should NOT retain the +9.5m single-frame glitch
  const mid = res.frames[30];
  assert.ok(Math.abs(mid.nose[1]) < 1.2, `glitch nose Y leaked: ${mid.nose[1]}`);
  assert.ok(Math.abs(mid.leftWrist[2]) < 1.2, `glitch wrist Z leaked: ${mid.leftWrist[2]}`);

  // Apparent scale growth (0.20 -> 0.25) should yield forward +Z root motion > +0.05m
  const dz = res.frames[59].midHip[2] - res.frames[0].midHip[2];
  assert.ok(dz > 0.05, `expected forward +Z root motion from scale increase, got ${dz}`);
});

await test('3. Retargeter handles raw MediaPipe +Y down frames upright on Rust WASM AND JS fallback', async () => {
  const mocapResult = buildMocapResult(60);

  // 3a. Rust WASM path
  const charWasm = buildRealisticHumanoid('WasmHuman');
  const retWasm = new MocapRetargeter(null, null, null);
  const resWasm = retWasm.retarget(charWasm.root, mocapResult, { footLock: true });
  assert.equal(resWasm.success, true);
  assert.equal(resWasm.engine, 'rust-wasm');

  for (const t of [0, 0.5, 1.0, 1.8]) {
    retWasm.seek(t);
    const headY = charWasm.bones.get('Head').getWorldPosition(new THREE.Vector3()).y;
    const hipsY = charWasm.bones.get('Hips').getWorldPosition(new THREE.Vector3()).y;
    const footY = charWasm.bones.get('LeftFoot').getWorldPosition(new THREE.Vector3()).y;
    assert.ok(headY > hipsY + 0.35, `WASM head (${headY}) must stay above hips (${hipsY}) at t=${t}`);
    assert.ok(hipsY > footY + 0.45, `WASM hips (${hipsY}) must stay above leftFoot (${footY}) at t=${t}`);
  }

  // 3b. JS fallback path (forceJS: true)
  const charJS = buildRealisticHumanoid('JSHuman');
  const retJS = new MocapRetargeter(null, null, null);
  const resJS = retJS.retarget(charJS.root, mocapResult, { footLock: true, forceJS: true });
  assert.equal(resJS.success, true);
  assert.equal(resJS.engine, 'js');

  for (const t of [0, 0.5, 1.0, 1.8]) {
    retJS.seek(t);
    const headY = charJS.bones.get('Head').getWorldPosition(new THREE.Vector3()).y;
    const hipsY = charJS.bones.get('Hips').getWorldPosition(new THREE.Vector3()).y;
    const footY = charJS.bones.get('LeftFoot').getWorldPosition(new THREE.Vector3()).y;
    assert.ok(headY > hipsY + 0.35, `JS fallback head (${headY}) must stay above hips (${hipsY}) at t=${t}`);
    assert.ok(hipsY > footY + 0.45, `JS fallback hips (${hipsY}) must stay above leftFoot (${footY}) at t=${t}`);
  }
});

await test('4. Re-Apply 5x with changing options is deterministic & never corrupts bind pose', async () => {
  const { root, bones } = buildRealisticHumanoid('ReapplyChar');
  const origPos = new Map([...bones].map(([k, b]) => [k, b.position.clone()]));
  const origQuat = new Map([...bones].map(([k, b]) => [k, b.quaternion.clone()]));

  const mocapResult = buildMocapResult(60);
  const retargeter = new MocapRetargeter(null, null, null);

  const baseline = retargeter.retarget(root, mocapResult, {
    yawOffsetDeg: 0, smoothing: 0.35, rootMotion: true, footLock: true,
  });
  assert.equal(baseline.success, true);
  const baselineClip = retargeter.currentClip;

  // Apply mutated settings across multiple re-applies
  assert.equal(retargeter.retarget(root, mocapResult, { yawOffsetDeg: 90, smoothing: 0.75, rootMotion: false, footLock: false }).success, true);
  assert.equal(retargeter.retarget(root, mocapResult, { yawOffsetDeg: -90, smoothing: 0.1, rootMotion: true, footLock: true }).success, true);
  assert.equal(retargeter.retarget(root, mocapResult, { yawOffsetDeg: 180, smoothing: 0.5, rootMotion: false, footLock: true }).success, true);

  // Re-apply baseline options -> must match baseline clip within float tolerance
  const finalRes = retargeter.retarget(root, mocapResult, {
    yawOffsetDeg: 0, smoothing: 0.35, rootMotion: true, footLock: true,
  });
  assert.equal(finalRes.success, true);
  const err = maxTrackDiff(baselineClip, retargeter.currentClip);
  assert.ok(err < 1e-5, `Repeated re-apply drifted from baseline by ${err}`);

  // restoreBindPose returns every bone strictly back to its pristine bind pose
  retargeter.restoreBindPose(root);
  for (const [bName, b] of bones) {
    const pErr = b.position.distanceTo(origPos.get(bName));
    const qErr = 1 - Math.abs(b.quaternion.dot(origQuat.get(bName)));
    assert.ok(pErr < 1e-5, `Bone ${bName} position drifted by ${pErr}`);
    assert.ok(qErr < 1e-6, `Bone ${bName} quaternion drifted by ${qErr}`);
  }
});

await test('5. Toggling Foot-Lock (true -> false -> true) uses immutable rawMocapFrames without drift', async () => {
  const { series, hip2d } = makeRawYDownJointSeries(60, { slideLeftFoot: true });
  const rawWasm = processJointsWasm(series, { fps: 30, hip2dSeries: hip2d, footLock: false });
  const locked = applyFootLockWasm(rawWasm.frames, { fps: 30 });
  assert.ok(locked.locked.left > 30, `expected left foot planted lock frames, got ${locked.locked.left}`);

  const mocapResult = {
    success: true,
    engine: 'browser-wasm',
    fps: 30,
    rawMocapFrames: rawWasm.frames,
    mocapFrames: locked.frames,
    footLockFlags: locked.flags,
  };
  const { root } = buildRealisticHumanoid('FootToggleChar');
  const retargeter = new MocapRetargeter(null, null, null);

  retargeter.retarget(root, mocapResult, { footLock: true });
  const clipLocked1 = retargeter.currentClip;

  retargeter.retarget(root, mocapResult, { footLock: false });
  const clipUnlocked = retargeter.currentClip;
  assert.ok(maxTrackDiff(clipLocked1, clipUnlocked) > 1e-3, 'toggling footLock=false should noticeably change tracks');

  retargeter.retarget(root, mocapResult, { footLock: true });
  const clipLocked2 = retargeter.currentClip;
  assert.ok(maxTrackDiff(clipLocked1, clipLocked2) < 1e-4, 'toggling footLock back to true must match initial locked clip');
});

await test('6. Character switch (A -> B -> A) + timelineEngine clip detach stay isolated', async () => {
  const scene = new THREE.Scene();
  const charA = buildRealisticHumanoid('CharA', 1.0);
  const charB = buildRealisticHumanoid('CharB', 1.3);
  scene.add(charA.root, charB.root);
  const timeline = new TimelineEngine();
  const retargeter = new MocapRetargeter(null, null, timeline);
  const mocapResult = buildMocapResult(45);

  retargeter.retarget(charA.root, mocapResult, {});
  const clipA1 = retargeter.currentClip;
  timeline.attachClip(charA.root, clipA1, { syncRange: false });
  timeline.seekToFrame(15);

  // Switch to B after detaching & restoring A
  retargeter.restoreBindPose(charA.root);
  assert.equal(timeline.getAttachedClip(charA.root), null, 'CharA timeline clip must be detached cleanly');
  const resB = retargeter.retarget(charB.root, mocapResult, {});
  assert.equal(resB.success, true);
  timeline.attachClip(charB.root, retargeter.currentClip, { syncRange: false });
  timeline.seekToFrame(20);

  // Switch back to A: must match initial clipA1 cleanly
  retargeter.restoreBindPose(charB.root);
  assert.equal(timeline.getAttachedClip(charB.root), null, 'CharB timeline clip must be detached cleanly');
  retargeter.retarget(charA.root, mocapResult, {});
  const clipA2 = retargeter.currentClip;
  assert.ok(maxTrackDiff(clipA1, clipA2) < 1e-5, 'switching A -> B -> A must produce identical tracks for A');
});

await test('7. Rust WASM performance: 900 frames (30s @ 30fps) processes + retargets rapidly (< 120ms)', async () => {
  const { series, hip2d } = makeRawYDownJointSeries(900);
  const t0 = performance.now();
  const proc = processJointsWasm(series, { fps: 30, hip2dSeries: hip2d, footLock: true });
  const t1 = performance.now();
  assert.ok(proc && proc.frames.length === 900);

  const mocapResult = {
    success: true,
    fps: 30,
    rawMocapFrames: proc.frames,
    mocapFrames: proc.frames,
    footLockFlags: proc.footLockFlags,
  };
  const { root } = buildRealisticHumanoid('BenchChar');
  const retargeter = new MocapRetargeter(null, null, null);
  const t2 = performance.now();
  const res = retargeter.retarget(root, mocapResult, { footLock: false });
  const t3 = performance.now();

  assert.equal(res.success, true);
  assert.equal(res.engine, 'rust-wasm');
  const procMs = t1 - t0;
  const retargetMs = t3 - t2;
  console.log(`     [perf 900f] processJointsWasm=${procMs.toFixed(2)}ms, retargetWasm=${retargetMs.toFixed(2)}ms`);
  assert.ok(procMs < 120, `processJointsWasm took too long for 900f: ${procMs.toFixed(2)}ms`);
  assert.ok(retargetMs < 120, `retargetWasm took too long for 900f: ${retargetMs.toFixed(2)}ms`);
});

await test('8. mk_process_joints_v2 recovers occluded far-side arm without torso clipping or T-pose freeze', async () => {
  const n = 36;
  const series = [];
  const visibilities = [];
  const hip2d = [];
  const landmarks2D = [];

  for (let i = 0; i < n; i++) {
    const phase = (i / (n - 1)) * Math.PI * 4;
    const kneeSw = Math.sin(phase) * 0.14;
    // Left arm visibly swings forward/back; Right arm occluded & collapsed directly inside chest!
    series.push({
      nose: [0, -0.58, 0.06],
      leftShoulder: [0.19, -0.45, 0],
      rightShoulder: [-0.19, -0.45, 0],
      leftElbow: [0.25, -0.22, -0.05 + 0.08 * Math.sin(phase)],
      rightElbow: [0.02, -0.22, 0.02], // Collapsed into sternum
      leftWrist: [0.28, -0.02, -0.10 + 0.12 * Math.sin(phase)],
      rightWrist: [0.02, -0.10, 0.02], // Collapsed inside chest
      leftHandIndex: [0.30, 0.04, -0.12 + 0.12 * Math.sin(phase)],
      rightHandIndex: [0.02, -0.06, 0.02],
      leftHip: [0.10, 0.0, 0],
      rightHip: [-0.10, 0.0, 0],
      leftKnee: [0.10, 0.43, 0.04 + kneeSw],
      rightKnee: [-0.10, 0.43, 0.04 - kneeSw],
      leftAnkle: [0.10, 0.85, kneeSw * 0.5],
      rightAnkle: [-0.10, 0.85, -kneeSw * 0.5],
      leftFoot: [0.10, 0.89, kneeSw * 0.5 + 0.12],
      rightFoot: [-0.10, 0.89, -kneeSw * 0.5 + 0.12],
    });
    visibilities.push({
      leftShoulder: 0.95, rightShoulder: 0.88,
      leftElbow: 0.92, rightElbow: 0.05,
      leftWrist: 0.90, rightWrist: 0.04,
      leftHandIndex: 0.85, rightHandIndex: 0.03,
      leftHip: 0.96, rightHip: 0.95,
      leftKnee: 0.92, rightKnee: 0.86,
      leftAnkle: 0.90, rightAnkle: 0.84,
      leftFoot: 0.88, rightFoot: 0.82,
      nose: 0.94,
    });
    hip2d.push([0.5, 0.52, 0.24, 0.95]);
    const lm = Array.from({ length: 33 }, () => [0.5, 0.5, 0.0]);
    lm[0] = [0.5, 0.28, 0.95];
    lm[11] = [0.56, 0.36, 0.95];
    lm[12] = [0.44, 0.36, 0.90];
    lm[13] = [0.58, 0.47, 0.92];
    lm[14] = [0.50, 0.47, 0.05];
    lm[15] = [0.59, 0.57, 0.90];
    lm[16] = [0.50, 0.52, 0.04];
    lm[23] = [0.53, 0.56, 0.96];
    lm[24] = [0.47, 0.56, 0.95];
    landmarks2D.push(lm);
  }

  const res = processJointsWasm(series, {
    fps: 30,
    hip2dSeries: hip2d,
    visibilities,
    landmarks2D,
    occlusionStrength: 0.95,
    footLock: false,
  });
  assert.ok(res && res.frames.length === n);

  let minRwTorsoDistXZ = Infinity;
  let maxRwY = -Infinity;
  for (let i = 4; i < n - 4; i++) {
    const fr = res.frames[i];
    const distXZ = Math.hypot(fr.rightWrist[0] - fr.midHip[0], fr.rightWrist[2] - fr.midHip[2]);
    minRwTorsoDistXZ = Math.min(minRwTorsoDistXZ, distXZ);
    maxRwY = Math.max(maxRwY, fr.rightWrist[1]);
  }
  assert.ok(minRwTorsoDistXZ >= 0.17, `occluded right wrist clipped torso (min distXZ=${minRwTorsoDistXZ.toFixed(3)}m)`);
  // Process outputs unified +Y up coords: natural relaxed wrist hangs comfortably below shoulder height (not frozen near T-pose shoulder!)
  const shoulderY = res.frames[10].rightShoulder[1];
  assert.ok(maxRwY < shoulderY - 0.12, `occluded right wrist hung near T-pose shoulder height (maxRwY=${maxRwY.toFixed(3)} vs shoulder=${shoulderY.toFixed(3)})`);
});

await test('9. Pole-vector knee solver & despiker prevent 180-deg LeftUpLeg snap across straight leg', async () => {
  const n = 30;
  const series = [];
  const hip2d = [];
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    // Sweep left knee Z smoothly from slightly hyperextended (-0.018) through 0.0 straight to +0.16 bent
    const kneeZ = -0.018 + t * 0.18;
    series.push({
      nose: [0, -0.58, 0.05],
      leftShoulder: [0.18, -0.45, 0],
      rightShoulder: [-0.18, -0.45, 0],
      leftElbow: [0.30, -0.22, 0.04],
      rightElbow: [-0.30, -0.22, 0.04],
      leftWrist: [0.34, -0.02, 0.10],
      rightWrist: [-0.34, -0.02, 0.10],
      leftHandIndex: [0.36, 0.04, 0.12],
      rightHandIndex: [-0.36, 0.04, 0.12],
      leftHip: [0.10, 0.0, 0],
      rightHip: [-0.10, 0.0, 0],
      leftKnee: [0.10, 0.43, kneeZ],
      rightKnee: [-0.10, 0.43, 0.05],
      leftAnkle: [0.10, 0.85, 0.0],
      rightAnkle: [-0.10, 0.85, 0.0],
      leftFoot: [0.10, 0.89, 0.12],
      rightFoot: [-0.10, 0.89, 0.12],
    });
    hip2d.push([0.5, 0.52, 0.22, 0.95]);
  }
  const proc = processJointsWasm(series, { fps: 30, hip2dSeries: hip2d, footLock: false });
  const mocapResult = {
    success: true,
    fps: 30,
    rawMocapFrames: proc.frames,
    mocapFrames: proc.frames,
  };
  const { root } = buildRealisticHumanoid('KneePoleChar');
  const retargeter = new MocapRetargeter(null, null, null);
  const res = retargeter.retarget(root, mocapResult, { footLock: false });
  assert.equal(res.success, true);

  const legTrack = retargeter.currentClip.tracks.find((tr) => tr.name === 'LeftUpLeg.quaternion');
  assert.ok(legTrack, 'LeftUpLeg.quaternion track should exist');
  let maxJumpDeg = 0;
  for (let i = 1; i < n; i++) {
    const q0 = new THREE.Quaternion().fromArray(legTrack.values, (i - 1) * 4).normalize();
    const q1 = new THREE.Quaternion().fromArray(legTrack.values, i * 4).normalize();
    const dot = Math.min(1, Math.max(0, Math.abs(q0.dot(q1))));
    const deg = THREE.MathUtils.radToDeg(2 * Math.acos(dot));
    maxJumpDeg = Math.max(maxJumpDeg, deg);
  }
  assert.ok(maxJumpDeg < 22, `LeftUpLeg suffered pole-flip jump: ${maxJumpDeg.toFixed(1)} deg`);
});

await test('10. CameraMotionEstimator excludes subject & cancels camera pan drift in WASM root trajectory', async () => {
  const w = 128;
  const h = 72;
  const nFrames = 12;
  const est = new CameraMotionEstimator({ width: w, height: h, searchRadius: 8, blockRadius: 4 });
  const series = [];
  const hip2d = [];

  for (let f = 0; f < nFrames; f++) {
    const panPx = f * 2.0; // Camera pans right -> background shifts left (-2 px/frame)
    const luma = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        // Textured multi-frequency background moving left in image
        const wx = x + panPx;
        const wy = y;
        luma[y * w + x] = 0.5 + 0.25 * Math.sin(wx * 0.37) * Math.cos(wy * 0.41) + 0.15 * Math.sin(wx * 0.81 + wy * 0.23);
      }
    }
    // Inject moving dark foreground dancer rectangle inside mask (must be ignored by background tracker!)
    const subjX = 0.5 - panPx / w;
    for (let y = 18; y < 56; y++) {
      for (let x = Math.round((subjX - 0.08) * w); x <= Math.round((subjX + 0.08) * w); x++) {
        if (x >= 0 && x < w) luma[y * w + x] = 0.08;
      }
    }
    est.feedLuma(luma, { minX: subjX - 0.12, maxX: subjX + 0.12, minY: 0.20, maxY: 0.85 });

    series.push({
      nose: [0, -0.58, 0.05],
      leftShoulder: [0.18, -0.45, 0],
      rightShoulder: [-0.18, -0.45, 0],
      leftElbow: [0.32, -0.22, 0.04],
      rightElbow: [-0.32, -0.22, 0.04],
      leftWrist: [0.36, -0.02, 0.08],
      rightWrist: [-0.36, -0.02, 0.08],
      leftHandIndex: [0.38, 0.04, 0.10],
      rightHandIndex: [-0.38, 0.04, 0.10],
      leftHip: [0.10, 0.0, 0],
      rightHip: [-0.10, 0.0, 0],
      leftKnee: [0.10, 0.43, 0.05],
      rightKnee: [-0.10, 0.43, 0.05],
      leftAnkle: [0.10, 0.85, 0.0],
      rightAnkle: [-0.10, 0.85, 0.0],
      leftFoot: [0.10, 0.89, 0.14],
      rightFoot: [-0.10, 0.89, 0.14],
    });
    // Milli-normalized hip2d matching BrowserMocapEngine.hip2DFrom
    hip2d.push([subjX * 1000, 520, 220, 0.95]);
  }

  const camSeries = est.getSeries();
  const measuredTotalPan = camSeries[nFrames - 1].cumPanXNorm;
  const expectedTotalPan = ((nFrames - 1) * 2.0) / w; // +0.171875
  assert.ok(
    Math.abs(measuredTotalPan - expectedTotalPan) < 0.025,
    `camera pan estimate off: measured=${measuredTotalPan.toFixed(4)} vs expected=${expectedTotalPan.toFixed(4)}`,
  );

  const noComp = processJointsWasm(series, { fps: 30, hip2dSeries: hip2d, footLock: false });
  const comp = processJointsWasm(series, { fps: 30, hip2dSeries: hip2d, cameraMotionSeries: camSeries, footLock: false });
  const noCompDrift = Math.abs(noComp.frames[nFrames - 1].midHip[0] - noComp.frames[0].midHip[0]);
  const compDrift = Math.abs(comp.frames[nFrames - 1].midHip[0] - comp.frames[0].midHip[0]);
  assert.ok(noCompDrift > 0.20, `expected uncompensated camera pan drift >0.20m, got ${noCompDrift.toFixed(3)}m`);
  assert.ok(compDrift < 0.06, `expected compensated drift <0.06m, got ${compDrift.toFixed(3)}m`);
});

await test('11. ToeBase, Twist bones, and 21-pt HandLandmarker fingers retarget cleanly without NaN', async () => {
  const { root, bones } = buildRealisticHumanoid('ExtChar');
  // Add Left/Right ToeBase + ForearmTwist + LeftHandIndex1..3
  const lToe = new THREE.Bone();
  lToe.name = 'LeftToeBase';
  lToe.position.set(0, 0, 0.14);
  bones.get('LeftFoot').add(lToe);
  const rToe = new THREE.Bone();
  rToe.name = 'RightToeBase';
  rToe.position.set(0, 0, 0.14);
  bones.get('RightFoot').add(rToe);

  const lTwist = new THREE.Bone();
  lTwist.name = 'LeftForearmTwist';
  lTwist.position.set(0.11, 0, 0);
  bones.get('LeftForearm').add(lTwist);

  let parent = bones.get('LeftHand');
  for (let s = 1; s <= 3; s++) {
    const f = new THREE.Bone();
    f.name = `LeftHandIndex${s}`;
    f.position.set(s === 1 ? 0.08 : 0.035, 0, 0.02);
    parent.add(f);
    parent = f;
  }
  root.updateMatrixWorld(true);

  const { series, hip2d } = makeRawYDownJointSeries(24);
  // Add heels with left heel lifting on last half
  for (let i = 0; i < series.length; i++) {
    const heelLift = i >= 10 ? 0.08 : 0.0;
    series[i].leftHeel = [0.10, 0.89 - heelLift, -0.04];
    series[i].rightHeel = [-0.10, 0.89, -0.04];
  }
  const proc = processJointsWasm(series, { fps: 30, hip2dSeries: hip2d, footLock: false });

  // Synthesize 21-pt Left Hand curling progressively from open (frame 0) to curled fist (frame 23)
  const handFrames = series.map((_, i) => {
    const curl = (i / 23) * 1.1; // radians
    const pts = Array.from({ length: 21 }, () => [0, 0, 0]);
    // Wrist=0, IndexMCP=5, MiddleMCP=9, PinkyMCP=17 (raw MediaPipe +Y down)
    pts[5] = [0.02, -0.08, 0.0];
    pts[9] = [0.0, -0.085, 0.0];
    pts[17] = [-0.03, -0.08, 0.0];
    // Progressive curl of Index 5->6->7->8 into palm (+Z away/forward bend)
    const segLen = 0.035;
    let p = [...pts[5]];
    for (let k = 0; k < 3; k++) {
      const a = curl * (k + 1) * 0.55;
      p = [p[0], p[1] - segLen * Math.cos(a), p[2] - segLen * Math.sin(a)];
      pts[6 + k] = p;
    }
    return {
      left: { worldLandmarks: pts, confidence: 0.92 },
      right: null,
    };
  });

  const retargeter = new MocapRetargeter(null, null, null);
  const res = retargeter.retarget(root, {
    success: true,
    fps: 30,
    rawMocapFrames: proc.frames,
    mocapFrames: proc.frames,
    handFrames,
  }, { footLock: false, trackHands: true, twistDistribution: true });

  assert.equal(res.success, true);
  const names = new Set(retargeter.currentClip.tracks.map((t) => t.name));
  assert.ok(names.has('LeftToeBase.quaternion'), 'missing LeftToeBase track');
  assert.ok(names.has('RightToeBase.quaternion'), 'missing RightToeBase track');
  assert.ok(names.has('LeftForearmTwist.quaternion'), 'missing LeftForearmTwist track');
  assert.ok(names.has('LeftHandIndex1.quaternion'), 'missing LeftHandIndex1 finger track');
  assert.ok(names.has('LeftHandIndex2.quaternion'), 'missing LeftHandIndex2 finger track');

  // Verify LeftHandIndex2 actually curled over the 24 frames (delta angle > 10 deg)
  const idx2Track = retargeter.currentClip.tracks.find((t) => t.name === 'LeftHandIndex2.quaternion');
  const qStart = new THREE.Quaternion().fromArray(idx2Track.values, 0);
  const qEnd = new THREE.Quaternion().fromArray(idx2Track.values, 23 * 4);
  const fingerCurlDeg = THREE.MathUtils.radToDeg(2 * Math.acos(Math.min(1, Math.abs(qStart.dot(qEnd)))));
  assert.ok(fingerCurlDeg > 10, `expected finger curl >10 deg, got ${fingerCurlDeg.toFixed(1)} deg`);
});

await test('12. exportClipToBVH generates valid BioVision HIERARCHY + continuous unwrapped MOTION', async () => {
  const { root } = buildRealisticHumanoid('BvhChar');
  const mocapResult = buildMocapResult(20);
  const retargeter = new MocapRetargeter(null, null, null);
  const res = retargeter.retarget(root, mocapResult, { footLock: false });
  assert.equal(res.success, true);

  const out = retargeter.exportBVH(root, { fps: 30, scale: 100 });
  assert.equal(out.frameCount, 20);
  assert.ok(out.boneCount >= 20);
  assert.ok(out.bvh.startsWith('HIERARCHY\nROOT Hips'));
  assert.ok(out.bvh.includes('CHANNELS 6 Xposition Yposition Zposition Zrotation Xrotation Yrotation'));
  assert.ok(out.bvh.includes('End Site'));
  assert.ok(out.bvh.includes(`\nMOTION\nFrames: 20\nFrame Time: 0.033333\n`));

  const motionIdx = out.bvh.indexOf('\nMOTION\n');
  const motionLines = out.bvh.slice(motionIdx + 1).trim().split('\n').slice(3);
  assert.equal(motionLines.length, 20);
  const expectedCols = 3 + out.boneCount * 3;
  for (const row of motionLines) {
    const nums = row.trim().split(/\s+/).map(Number);
    assert.equal(nums.length, expectedCols);
    assert.ok(nums.every((n) => Number.isFinite(n)));
  }
});

await test('13. UE5 & Rigify bone naming + Twist-Roll rig (upperarm/forearm/thigh twist + ball_l) map cleanly', async () => {
  // Build UE5 Manny-style skeleton with twist/roll bones + ball_l/r + jaw
  const mkBone = (name, x = 0, y = 0, z = 0) => {
    const b = new THREE.Bone();
    b.name = name;
    b.position.set(x, y, z);
    return b;
  };
  const root = new THREE.Group();
  root.name = 'UE5Char';
  const pelvis = mkBone('pelvis', 0, 0.95, 0);
  const s1 = mkBone('spine_01', 0, 0.14, 0);
  const s2 = mkBone('spine_02', 0, 0.14, 0);
  const s3 = mkBone('spine_03', 0, 0.14, 0);
  const neck = mkBone('neck_01', 0, 0.12, 0);
  const head = mkBone('head', 0, 0.10, 0);
  const jaw = mkBone('jaw', 0, 0.03, 0.04);

  const lClav = mkBone('clavicle_l', 0.05, 0.10, 0);
  const lUpper = mkBone('upperarm_l', 0.13, 0, 0);
  const lUpperTwist = mkBone('upperarm_twist_01_l', 0.12, 0, 0);
  const lLower = mkBone('lowerarm_l', 0.25, 0, 0);
  const lLowerTwist = mkBone('lowerarm_twist_01_l', 0.12, 0, 0);
  const lHand = mkBone('hand_l', 0.23, 0, 0);

  const rClav = mkBone('clavicle_r', -0.05, 0.10, 0);
  const rUpper = mkBone('upperarm_r', -0.13, 0, 0);
  const rLower = mkBone('lowerarm_r', -0.25, 0, 0);
  const rHand = mkBone('hand_r', -0.23, 0, 0);

  const lThigh = mkBone('thigh_l', 0.09, -0.05, 0);
  const lThighTwist = mkBone('thigh_twist_01_l', 0, -0.20, 0);
  const lCalf = mkBone('calf_l', 0, -0.42, 0);
  const lFoot = mkBone('foot_l', 0, -0.40, 0);
  const lBall = mkBone('ball_l', 0, -0.04, 0.14);

  const rThigh = mkBone('thigh_r', -0.09, -0.05, 0);
  const rCalf = mkBone('calf_r', 0, -0.42, 0);
  const rFoot = mkBone('foot_r', 0, -0.40, 0);
  const rBall = mkBone('ball_r', 0, -0.04, 0.14);

  root.add(pelvis);
  pelvis.add(s1, lThigh, rThigh);
  s1.add(s2); s2.add(s3); s3.add(neck, lClav, rClav);
  neck.add(head); head.add(jaw);
  lClav.add(lUpper); lUpper.add(lLower, lUpperTwist); lLower.add(lHand, lLowerTwist);
  rClav.add(rUpper); rUpper.add(rLower); rLower.add(rHand);
  lThigh.add(lCalf, lThighTwist); lCalf.add(lFoot); lFoot.add(lBall);
  rThigh.add(rCalf); rCalf.add(rFoot); rFoot.add(rBall);
  root.updateMatrixWorld(true);

  const { series, hip2d } = makeRawYDownJointSeries(24);
  // Rotate left wrist steadily around palm forward axis via handFrames to induce real palm/forearm twist
  const handFrames = series.map((_, f) => {
    const roll = (f / 23) * 0.9;
    const c = Math.cos(roll);
    const s = Math.sin(roll);
    const pts = Array.from({ length: 21 }, () => [0, 0, 0]);
    pts[5] = [0.02 * c, -0.08, 0.02 * s];
    pts[9] = [0, -0.085, 0];
    pts[17] = [-0.025 * c, -0.08, -0.025 * s];
    return { left: { worldLandmarks: pts, confidence: 0.9 }, right: null };
  });

  const proc = processJointsWasm(series, { fps: 30, hip2dSeries: hip2d, footLock: false });
  const retargeter = new MocapRetargeter(null, null, null);
  const res = retargeter.retarget(root, {
    success: true, fps: 30, rawMocapFrames: proc.frames, mocapFrames: proc.frames, handFrames,
  }, { footLock: false, trackHands: true, twistDistribution: true });

  assert.equal(res.success, true);
  assert.ok(res.twistTracks >= 2, `expected >= 2 twist tracks on UE5 twist rig, got ${res.twistTracks}`);
  const trackNames = new Set(retargeter.currentClip.tracks.map((t) => t.name));
  assert.ok(trackNames.has('pelvis.quaternion'));
  assert.ok(trackNames.has('ball_l.quaternion'), 'UE5 ball_l should map to ToeBase');
  assert.ok(trackNames.has('upperarm_twist_01_l.quaternion'));
  assert.ok(trackNames.has('lowerarm_twist_01_l.quaternion'));
  assert.ok(trackNames.has('thigh_twist_01_l.quaternion'));
});

await test('14. FaceLandmarker ARKit BlendShapes + Jaw bone + Head micro-pose animate continuously', async () => {
  const { root } = buildRealisticHumanoid('FaceChar');
  const head = root.getObjectByName('Head');
  const jaw = new THREE.Bone();
  jaw.name = 'Jaw';
  jaw.position.set(0, 0.03, 0.04);
  head.add(jaw);

  // Add morph target mesh simulating head skin with ARKit blendshapes
  const geo = new THREE.BoxGeometry(0.1, 0.1, 0.1);
  const faceMesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial());
  faceMesh.name = 'HeadMesh';
  faceMesh.morphTargetDictionary = { jawOpen: 0, eyeBlinkLeft: 1, mouthSmileLeft: 2, browInnerUp: 3 };
  faceMesh.morphTargetInfluences = [0, 0, 0, 0];
  root.add(faceMesh);
  root.updateMatrixWorld(true);

  const mocapResult = buildMocapResult(24);
  mocapResult.faceFrames = mocapResult.mocapFrames.map((_, f) => {
    const t = f / 23;
    const e = new THREE.Euler(0.18 * Math.sin(t * Math.PI), 0.25 * Math.cos(t * Math.PI), 0.05 * Math.sin(t * Math.PI * 2), 'YXZ');
    const m = new THREE.Matrix4().makeRotationFromEuler(e);
    return {
      confidence: 0.92,
      matrix: Array.from(m.elements),
      blendshapes: {
        jawOpen: 0.05 + 0.65 * Math.sin(t * Math.PI),
        eyeBlinkLeft: f >= 8 && f <= 11 ? 0.9 : 0.02,
        mouthSmileLeft: 0.45 * t,
        browInnerUp: 0.30 * Math.sin(t * Math.PI),
      },
    };
  });

  const retargeter = new MocapRetargeter(null, null, null);
  const res = retargeter.retarget(root, mocapResult, { footLock: false, trackFace: true });
  assert.equal(res.success, true);
  assert.ok(res.faceTracks >= 5, `expected 4 morph tracks + 1 Jaw bone track, got ${res.faceTracks}`);

  const jawOpenTr = retargeter.currentClip.tracks.find((t) =>
    t.name === 'HeadMesh.morphTargetInfluences[jawOpen]' || t.name === 'HeadMesh.morphTargetInfluences[0]');
  const jawBoneTr = retargeter.currentClip.tracks.find((t) => t.name === 'Jaw.quaternion');
  assert.ok(jawOpenTr && jawOpenTr.values.every(Number.isFinite));
  assert.ok(Math.max(...jawOpenTr.values) > 0.45, 'expected smoothed jawOpen peak > 0.45');
  assert.ok(jawBoneTr && jawBoneTr.values.every(Number.isFinite));
});

await test('15. Coupled biomechanical grounding sticks stance feet cleanly without floating, floor clipping, or knee/hip contortion', async () => {
  // Build 22-bone Mixamo rig INCLUDING ToeBase + Foot geometry so full sole & knee biomechanics are verified
  const { root, bones } = buildRealisticHumanoid('BioGroundedHuman');
  const lFoot = bones.get('LeftFoot');
  const rFoot = bones.get('RightFoot');
  const lToe = new THREE.Bone();
  lToe.name = 'LeftToeBase';
  lToe.position.set(0, -0.05, 0.14);
  const rToe = new THREE.Bone();
  rToe.name = 'RightToeBase';
  rToe.position.set(0, -0.05, 0.14);
  lFoot.add(lToe);
  rFoot.add(rToe);
  bones.set('LeftToeBase', lToe);
  bones.set('RightToeBase', rToe);
  root.updateMatrixWorld(true);
  MocapRetargeter.captureBindPose(root);

  // At bind pose: LeftFoot.y = 0.05, LeftToeBase.y = 0.00 -> restMinFootY = 0.00
  const nFrames = 120;
  const series = [];
  const hip2d = [];
  for (let f = 0; f < nFrames; f++) {
    let squat = 0;
    let jump = 0;
    let lStanceOffset = [0, 0, 0];
    let rKickUp = 0;
    let lHeelLift = 0;
    let bodyShiftX = 0;

    if (f < 25) {
      // Phase 1: Stance slightly hovering (+0.10m noisy root drift) -> must ground solidly to y=0
      jump = 0.10;
      bodyShiftX = Math.sin((f / 24) * Math.PI * 2) * 0.04;
    } else if (f < 50) {
      // Phase 2: Wide lunge lateral hip travel (+0.52m) pushing planted foot near max reach
      const u = (f - 25) / 24;
      bodyShiftX = 0.52 * Math.sin(u * Math.PI);
      squat = 0.10 * Math.sin(u * Math.PI);
    } else if (f < 70) {
      // Phase 3: Left heel lift tiptoe (0.075m heel lift while ToeBase grounded on floor)
      lHeelLift = 0.075 * Math.sin(((f - 50) / 19) * Math.PI);
    } else if (f < 95) {
      // Phase 4: High right swing kick (+0.48m) while left leg stands firmly planted
      rKickUp = 0.48 * Math.sin(((f - 70) / 24) * Math.PI);
    } else {
      // Phase 5: True vertical jump (+0.34m off ground) & landing
      jump = 0.34 * Math.sin(((f - 95) / 24) * Math.PI);
    }

    const hipY = 0.0 + squat - jump; // Raw MediaPipe +Y down
    const ankY = 0.85 - jump;
    const kickY = ankY - rKickUp;
    series.push({
      nose: [bodyShiftX, hipY - 0.58, 0.05],
      leftShoulder: [bodyShiftX + 0.18, hipY - 0.45, 0],
      rightShoulder: [bodyShiftX - 0.18, hipY - 0.45, 0],
      leftElbow: [bodyShiftX + 0.32, hipY - 0.22, 0.06],
      rightElbow: [bodyShiftX - 0.32, hipY - 0.22, 0.06],
      leftWrist: [bodyShiftX + 0.40, hipY - 0.02, 0.12],
      rightWrist: [bodyShiftX - 0.40, hipY - 0.02, 0.12],
      leftHandIndex: [bodyShiftX + 0.43, hipY + 0.04, 0.14],
      rightHandIndex: [bodyShiftX - 0.43, hipY + 0.04, 0.14],
      leftHip: [bodyShiftX + 0.10, hipY, 0],
      rightHip: [bodyShiftX - 0.10, hipY, 0],
      leftKnee: [bodyShiftX + 0.10, 0.5 * (hipY + ankY), 0.10],
      rightKnee: [bodyShiftX - 0.10, 0.5 * (hipY + kickY), 0.10 + rKickUp * 0.45],
      leftAnkle: [0.10 + lStanceOffset[0], ankY - lHeelLift, 0.0],
      rightAnkle: [bodyShiftX * (f >= 70 && f < 95 ? 1 : 0.2) - 0.10, kickY, rKickUp * 0.40],
      leftHeel: [0.10, ankY + 0.04 - lHeelLift, -0.04],
      rightHeel: [-0.10, kickY + 0.04, -0.04 + rKickUp * 0.40],
      leftFoot: [0.10, ankY + 0.05, 0.14],
      rightFoot: [-0.10, kickY + 0.05, 0.14 + rKickUp * 0.40],
    });
    hip2d.push([0.5 + bodyShiftX * 0.3, 0.52 - jump * 0.2, 0.22, 0.95]);
  }

  const rawWasm = processJointsWasm(series, { fps: 30, hip2dSeries: hip2d, footLock: false });
  const locked = applyFootLockWasm(rawWasm.frames, { fps: 30 });
  const mocapResult = {
    success: true,
    engine: 'browser-wasm',
    fps: 30,
    duration: (nFrames - 1) / 30,
    numFrames: nFrames,
    rawMocapFrames: rawWasm.frames,
    mocapFrames: locked.frames,
    footLockFlags: locked.flags,
  };

  const retargeter = new MocapRetargeter(null, null, null);
  const res = retargeter.retarget(root, mocapResult, { footLock: true, groundFeet: true, rootMotion: true, smoothing: 0.35 });
  assert.equal(res.success, true);

  let maxStanceFloat = 0;
  let minOverallSoleY = Infinity;
  let maxJumpSoleY = -Infinity;
  const vU = new THREE.Vector3();
  const vL = new THREE.Vector3();
  const qHips = new THREE.Quaternion();
  const fwdHips = new THREE.Vector3();

  for (let f = 0; f < nFrames; f++) {
    retargeter.seek(f / 30);
    root.updateMatrixWorld(true);
    const lHip = bones.get('LeftUpLeg').getWorldPosition(new THREE.Vector3());
    const lKnee = bones.get('LeftLeg').getWorldPosition(new THREE.Vector3());
    const lAnkle = bones.get('LeftFoot').getWorldPosition(new THREE.Vector3());
    const lToeW = bones.get('LeftToeBase').getWorldPosition(new THREE.Vector3());
    const rHip = bones.get('RightUpLeg').getWorldPosition(new THREE.Vector3());
    const rKnee = bones.get('RightLeg').getWorldPosition(new THREE.Vector3());
    const rAnkle = bones.get('RightFoot').getWorldPosition(new THREE.Vector3());
    const rToeW = bones.get('RightToeBase').getWorldPosition(new THREE.Vector3());
    bones.get('Hips').getWorldQuaternion(qHips);
    fwdHips.set(0, 0, 1).applyQuaternion(qHips).setY(0).normalize();

    const soleY = Math.min(lAnkle.y, lToeW.y, rAnkle.y, rToeW.y);
    minOverallSoleY = Math.min(minOverallSoleY, soleY);
    if (f < 22) maxStanceFloat = Math.max(maxStanceFloat, soleY);
    if (f >= 104 && f <= 111) maxJumpSoleY = Math.max(maxJumpSoleY, soleY);

    // Check anatomical integrity across ALL 120 frames: no backward knee flip, no collinear stretch!
    for (const [side, hP, kP, aP] of [['L', lHip, lKnee, lAnkle], ['R', rHip, rKnee, rAnkle]]) {
      const chord = aP.clone().sub(hP);
      const chordDir = chord.clone().normalize();
      const kOff = kP.clone().sub(hP);
      const perp = kOff.sub(chordDir.clone().multiplyScalar(kOff.dot(chordDir)));
      const fwdDot = perp.dot(fwdHips);
      assert.ok(
        fwdDot >= -0.035,
        `Frame ${f} ${side} knee flipped backward (contortion): perp.dot(hipsFwd)=${fwdDot.toFixed(4)}`,
      );
      vU.subVectors(kP, hP);
      vL.subVectors(aP, kP);
      const maxReach = (vU.length() + vL.length()) * 0.999;
      assert.ok(chord.length() <= maxReach + 0.002, `Frame ${f} ${side} leg overstretched beyond max reach`);
    }
  }

  assert.ok(minOverallSoleY >= -0.006, `Feet pierced floor! minOverallSoleY=${minOverallSoleY.toFixed(4)}`);
  assert.ok(maxStanceFloat < 0.015, `Stance feet hovered off floor! maxStanceFloat=${maxStanceFloat.toFixed(4)}`);
  assert.ok(maxJumpSoleY > 0.16, `Jump failed to leave floor! maxJumpSoleY=${maxJumpSoleY.toFixed(4)}`);
});

await test('16. groundFeet: false cleanly disables floor grounding so hovering capture stays elevated', async () => {
  const { root, bones } = buildRealisticHumanoid('NoGroundHuman');
  const nFrames = 16;
  const series = [];
  const hip2d = [];
  for (let f = 0; f < nFrames; f++) {
    series.push({
      nose: [0, -0.58, 0.05],
      leftShoulder: [0.18, -0.45, 0],
      rightShoulder: [-0.18, -0.45, 0],
      leftElbow: [0.35, -0.25, 0.08],
      rightElbow: [-0.35, -0.25, 0.08],
      leftWrist: [0.46, -0.05, 0.14],
      rightWrist: [-0.46, -0.05, 0.14],
      leftHandIndex: [0.50, 0.02, 0.16],
      rightHandIndex: [-0.50, 0.02, 0.16],
      leftHip: [0.10, 0.0, 0],
      rightHip: [-0.10, 0.0, 0],
      leftKnee: [0.10, 0.43, 0.06],
      rightKnee: [-0.10, 0.43, 0.06],
      leftAnkle: [0.10, 0.85, 0.0],
      rightAnkle: [-0.10, 0.85, 0.0],
      leftFoot: [0.10, 0.90, 0.14],
      rightFoot: [-0.10, 0.90, 0.14],
    });
    // First 10 frames stand at 0.68 so median baseline equals grounded stance; remaining frames drift upward in 2D
    hip2d.push([0.5, f < 10 ? 0.68 : 0.44, 0.22, 0.95]);
  }
  const proc = processJointsWasm(series, { fps: 30, hip2dSeries: hip2d, footLock: false });
  const locked = applyFootLockWasm(proc.frames, { fps: 30 });
  const mocapRes = {
    success: true, fps: 30, duration: (nFrames - 1) / 30, numFrames: nFrames,
    rawMocapFrames: proc.frames, mocapFrames: locked.frames, footLockFlags: locked.flags,
  };

  const stanceFlags = new Uint8Array(mocapRes.mocapFrames.length * 2).fill(1);
  const ret = new MocapRetargeter(null, null, null);
  ret.retarget(root, mocapRes, { footLock: false, groundFeet: true, rootMotion: true, footLockFlags: stanceFlags });
  ret.seek(12 / 30);
  const footGroundedY = bones.get('LeftFoot').getWorldPosition(new THREE.Vector3()).y;

  ret.retarget(root, mocapRes, { footLock: false, groundFeet: false, rootMotion: true, footLockFlags: stanceFlags });
  ret.seek(12 / 30);
  const footUngroundedY = bones.get('LeftFoot').getWorldPosition(new THREE.Vector3()).y;

  assert.ok(footGroundedY < 0.09, `Expected groundFeet=true near floor (~0.05), got ${footGroundedY.toFixed(4)}`);
  assert.ok(footUngroundedY > footGroundedY + 0.12, `Expected groundFeet=false to remain elevated: grounded=${footGroundedY.toFixed(4)}, ungrounded=${footUngroundedY.toFixed(4)}`);
});

console.log(`\nSummary: ${passed} passed, ${failures.length} failed`);
if (failures.length > 0) process.exit(1);
