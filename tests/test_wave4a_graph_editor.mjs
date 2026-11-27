/**
 * Wave 4A Verification Suite:
 * - Analytical 1D cubic Bezier solver vs exact parametric Bernstein polynomial
 * - Handle types: auto_clamped, aligned, free, vector + X-monotonicity clamping
 * - Curve extrapolation: constant, linear, cycle, cycle_offset + angle unwrapping
 * - TimelineEngine per-axis sparse F-Curve evaluation (Object & Armature Bones)
 * - GraphEditorUI box select, key/handle editing, snap, Undo/Redo, & Project JSON/.wbs round-trip
 */

import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
  solveCubicBezierTimeY,
  enforceBezierMonotonicity,
  updateHandlePair,
  resolveFCurvePoints,
  evaluateFCurve,
} from '../js/core/fcurve-math.js';
import { TimelineEngine } from '../js/animation/timeline-engine.js';
import { SceneManager } from '../js/core/scene-manager.js';
import { StudioExporter } from '../js/exporters/export-import.js';
import { GraphEditorUI } from '../js/ui/graph-editor.js';

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`  FAIL  ${name}\n   `, err?.stack || err);
  }
}

await test('1D Cubic Bezier solver matches exact parametric Bernstein polynomial & clamps looping X handles', () => {
  const x0 = 0, y0 = 0;
  const hx1 = 6, hy1 = 4.5;
  const hx2 = 16, hy2 = 1.0;
  const x3 = 24, y3 = 3.0;

  const evalBernstein = (a, b, c, d, u) => {
    const v = 1 - u;
    return v * v * v * a + 3 * v * v * u * b + 3 * v * u * u * c + u * u * u * d;
  };

  for (const u of [0.05, 0.17, 0.35, 0.5, 0.73, 0.94]) {
    const xExact = evalBernstein(x0, hx1, hx2, x3, u);
    const yExact = evalBernstein(y0, hy1, hy2, y3, u);
    const ySolved = solveCubicBezierTimeY(x0, y0, hx1, hy1, hx2, hy2, x3, y3, xExact);
    assert.ok(Math.abs(ySolved - yExact) < 1e-6, `Mismatch at u=${u}: got ${ySolved}, expected ${yExact}`);
  }

  // Overshooting X handles (hx1 - x0 + x3 - hx2 > segLen) must scale down without changing handle slope
  const [px0, py0, cx1, cy1, cx2, cy2, px3, py3] = enforceBezierMonotonicity(0, 0, 18, 9, 4, -2, 20, 4);
  assert.ok((cx1 - px0) + (px3 - cx2) <= (px3 - px0) + 1e-6, 'Corrected handles must keep dx1 + dx2 <= segLen');
  assert.ok(Math.abs((cy1 - py0) / (cx1 - px0) - 0.5) < 1e-6, 'Monotonicity clamp must preserve handle tangent slope');

  // Monotone sampling returns strictly finite values
  let prev = solveCubicBezierTimeY(0, 0, 18, 9, 4, -2, 20, 4, 0);
  for (let f = 1; f <= 20; f++) {
    const cur = solveCubicBezierTimeY(0, 0, 18, 9, 4, -2, 20, 4, f);
    assert.ok(Number.isFinite(cur) && Math.abs(cur - prev) < 10);
    prev = cur;
  }
});

await test('All 4 Handle Types (auto_clamped, aligned, free, vector) produce expected tangents', () => {
  // Auto clamped suppresses overshoot at extrema & endpoints
  const peakPts = [
    { frame: 0, val: 0, interpolation: 'bezier', handleType: 'auto_clamped' },
    { frame: 10, val: 5, interpolation: 'bezier', handleType: 'auto_clamped' },
    { frame: 20, val: 2, interpolation: 'bezier', handleType: 'auto_clamped' },
  ];
  const resolved = resolveFCurvePoints(peakPts);
  assert.equal(resolved[1].hl[1], 0, 'Local extremum auto_clamped key must have flat horizontal handles');
  assert.equal(resolved[1].hr[1], 0);
  for (let f = 0; f <= 20; f += 0.5) {
    const v = evaluateFCurve(peakPts, f);
    assert.ok(v <= 5.0 + 1e-6 && v >= 0 - 1e-6, `auto_clamped overshoot detected: f=${f}, v=${v}`);
  }

  // Aligned handle mirrors opposite angle while preserving opposite handle length
  const startPair = { hl: [-5, 0], hr: [3, 0], type: 'aligned' };
  const aligned = updateHandlePair(startPair, 'right', 6, 8);
  const lenL = Math.hypot(aligned.hl[0], aligned.hl[1]);
  assert.ok(Math.abs(lenL - 5.0) < 1e-5, `Expected left handle length preserved at 5.0, got ${lenL}`);
  const dot = (aligned.hl[0] / lenL) * (6 / 10) + (aligned.hl[1] / lenL) * (8 / 10);
  assert.ok(Math.abs(dot + 1.0) < 1e-5, `Aligned handles must remain collinear opposite (dot=${dot})`);

  // Free handle edits right handle without moving left handle
  const freeEdit = updateHandlePair(aligned, 'right', 4, -7, 'free');
  assert.deepEqual(freeEdit.hl, aligned.hl, 'Free handle must not alter opposite handle');
  assert.deepEqual(freeEdit.hr, [4, -7]);

  // Vector handles follow straight line chord exactly
  const vecPts = [
    { frame: 0, val: 1, interpolation: 'bezier', handleType: 'vector' },
    { frame: 10, val: 6, interpolation: 'bezier', handleType: 'vector' },
    { frame: 20, val: 2, interpolation: 'bezier', handleType: 'vector' },
  ];
  assert.ok(Math.abs(evaluateFCurve(vecPts, 5) - 3.5) < 1e-5);
  assert.ok(Math.abs(evaluateFCurve(vecPts, 15) - 4.0) < 1e-5);
});

await test('All 4 Extrapolation modes (constant, linear, cycle, cycle_offset) + Euler shortest-arc unwrap', () => {
  const linearPts = [
    { frame: 10, val: 2.0, interpolation: 'linear' },
    { frame: 30, val: 6.0, interpolation: 'linear' },
  ];
  assert.ok(Math.abs(evaluateFCurve(linearPts, 0, { extrapolation: 'constant' }) - 2.0) < 1e-6);
  assert.ok(Math.abs(evaluateFCurve(linearPts, 45, { extrapolation: 'constant' }) - 6.0) < 1e-6);

  // Linear extrapolation slope = (6 - 2)/(30 - 10) = 0.2 per frame
  assert.ok(Math.abs(evaluateFCurve(linearPts, 0, { extrapolation: 'linear' }) - 0.0) < 1e-6);
  assert.ok(Math.abs(evaluateFCurve(linearPts, 40, { extrapolation: 'linear' }) - 8.0) < 1e-6);

  // Cycle repeats [10..30]
  assert.ok(Math.abs(evaluateFCurve(linearPts, 40, { extrapolation: 'cycle' }) - 4.0) < 1e-6);
  assert.ok(Math.abs(evaluateFCurve(linearPts, 5, { extrapolation: 'cycle' }) - 5.0) < 1e-6);

  // Cycle + Offset adds +4 per 20-frame cycle
  assert.ok(Math.abs(evaluateFCurve(linearPts, 40, { extrapolation: 'cycle_offset' }) - 8.0) < 1e-6);
  assert.ok(Math.abs(evaluateFCurve(linearPts, 0, { extrapolation: 'cycle_offset' }) - 0.0) < 1e-6);

  // Bezier endpoint aligned handle slope determines Linear extrapolation tangent
  const bezLinearPts = [
    { frame: 0, val: 0, interpolation: 'bezier', handleType: 'aligned', hl: [-4, 0], hr: [4, 2] },
    { frame: 10, val: 4, interpolation: 'bezier', handleType: 'aligned', hl: [-4, -2], hr: [4, 2] }, // outgoing slope = 0.5/f
  ];
  assert.ok(Math.abs(evaluateFCurve(bezLinearPts, 20, { extrapolation: 'linear' }) - 9.0) < 1e-5);

  // Unwrapping +/-PI crossing takes shortest 20deg arc instead of 340deg spin
  const rotPts = [
    { frame: 0, val: THREE.MathUtils.degToRad(170), interpolation: 'linear' },
    { frame: 10, val: THREE.MathUtils.degToRad(-170), interpolation: 'linear' },
  ];
  const midRad = evaluateFCurve(rotPts, 5, { unwrapAngles: true });
  const midDeg = THREE.MathUtils.radToDeg(midRad);
  assert.ok(Math.abs(Math.abs(midDeg) - 180) < 1e-4, `Expected +/-180 deg across boundary, got ${midDeg}`);
});

await test('TimelineEngine & GraphEditorUI support independent per-axis move, Bezier handles, bone rotation, Undo & JSON/.wbs round-trip', async () => {
  const scene = new THREE.Scene();
  const sm = new SceneManager(scene);
  const cube = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial());
  cube.name = 'AnimCube';
  sm.addObject(cube, null, false, false);
  sm.select(cube);

  const tl = new TimelineEngine({ sceneManager: sm, fps: 30, startFrame: 0, endFrame: 60 });
  const ge = new GraphEditorUI({ timelineEngine: tl, sceneManager: sm });

  cube.position.set(0, 1, 0);
  tl.insertKeyframe(cube, 10, ['position'], 'bezier');
  cube.position.set(6, 5, 0);
  tl.insertKeyframe(cube, 30, ['position'], 'bezier');

  // Edit ONLY position.x keyframe via GraphEditorUI -> position.y MUST stay at frame 10!
  ge.selectKeyframe('position.x', 10);
  ge.nudgeSelectedKeyframes(4, 1.0); // position.x key moves 10 -> 14, val 0 -> 1.0

  const posXData = tl.getFCurvePoints(cube, 'position.x');
  const posYData = tl.getFCurvePoints(cube, 'position.y');
  assert.ok(posXData.points.some((p) => Math.abs(p.frame - 14) < 1e-3 && Math.abs(p.val - 1.0) < 1e-4));
  assert.ok(posYData.points.some((p) => Math.abs(p.frame - 10) < 1e-3 && Math.abs(p.val - 1.0) < 1e-4));

  // Pull right handle up sharply -> undo/redo -> switch extrapolation -> undo/redo
  ge.moveSelectedHandle('position.x', 14, 'right', 6, 8);
  tl.evaluate(22);
  const editedMidX = cube.position.x;

  // Undo last handle edit cleanly restores previous handle
  sm.undo();
  const undonePt = tl.getFCurvePoints(cube, 'position.x').points.find((p) => Math.abs(p.frame - 14) < 1e-3);
  assert.ok(!undonePt.hr || Math.abs(undonePt.hr[1] - 8) > 1.0, 'Undo must revert handle drag');
  tl.evaluate(22);
  assert.ok(cube.position.x < editedMidX - 0.5, 'Undone Bezier curve midpoint must drop back');
  sm.redo();

  // Switch extrapolation via UI helper -> scene reacts -> undo/redo works cleanly
  ge.setActiveExtrapolation('cycle_offset');
  tl.evaluate(46); // 46 is 16 frames after 30; cycle span is 30-14 = 16 -> 1 full cycle!
  assert.ok(Math.abs(cube.position.x - 11.0) < 1e-3, `cycle_offset expected x=11.0 (6 + 5), got ${cube.position.x}`);
  sm.undo();
  assert.equal(tl.getFCurveExtrapolation(cube, 'position.x'), 'constant');
  sm.redo();
  assert.equal(tl.getFCurveExtrapolation(cube, 'position.x'), 'cycle_offset');

  // Box select & Set Handle Type Vector
  ge.boxSelectFrames(10, 35, -10, 20);
  assert.ok(ge.selectedKeys.size >= 2);
  ge.setSelectedHandleType('vector');
  const vecResolved = tl.getFCurvePoints(cube, 'position.x').resolved;
  assert.equal(vecResolved[0].handleType, 'vector');

  // Verify TimelineEngine.toJSON / fromJSON round-trip preserves handles & extrapolation
  const tlJson = tl.toJSON();
  const tl2 = new TimelineEngine({ sceneManager: sm });
  tl2.fromJSON(tlJson);
  assert.equal(tl2.getFCurveExtrapolation(cube, 'position.x'), 'cycle_offset');
  assert.equal(tl2.getFCurvePoints(cube, 'position.x').resolved[0].handleType, 'vector');

  // Verify StudioExporter.exportProjectPackage (.wbs) + importProjectJSON preserves handles & extrapolation
  const exporter = new StudioExporter({ scene, camera: new THREE.PerspectiveCamera(), sceneManager: sm, timelineEngine: tl });
  const pkg = await exporter.exportProjectPackage({ download: false });
  const sceneB = new THREE.Scene();
  const smB = new SceneManager(sceneB);
  const tlB = new TimelineEngine({ sceneManager: smB });
  const importer = new StudioExporter({ scene: sceneB, camera: new THREE.PerspectiveCamera(), sceneManager: smB, timelineEngine: tlB });
  const impRes = await importer.importProjectJSON(pkg.bytes);
  assert.equal(impRes.success, true);

  const importedCube = smB.findObjectByName('AnimCube');
  assert.ok(importedCube);
  assert.equal(tlB.getFCurveExtrapolation(importedCube, 'position.x'), 'cycle_offset');
  assert.equal(tlB.getFCurvePoints(importedCube, 'position.x').resolved[0].handleType, 'vector');
  tlB.evaluate(46);
  assert.ok(Math.abs(importedCube.position.x - 11.0) < 1e-3, 'Imported .wbs F-Curve must evaluate cycle_offset accurately');
});

await test('Bone F-Curve Euler handle edits drive SkinnedMesh/Armature bone evaluation', () => {
  const scene = new THREE.Scene();
  const sm = new SceneManager(scene);
  const arm = new THREE.Group();
  arm.name = 'TestArmature';
  arm.userData.isArmature = true;
  const bone = new THREE.Bone();
  bone.name = 'UpperArm';
  arm.add(bone);
  sm.addObject(arm, null, false, false);

  const tl = new TimelineEngine({ sceneManager: sm });
  bone.rotation.set(0, 0, 0);
  tl.insertBoneKeyframe(arm, 'UpperArm', 0, ['rotation'], 'bezier');
  bone.rotation.set(0, 1.0, 0);
  tl.insertBoneKeyframe(arm, 'UpperArm', 20, ['rotation'], 'bezier');

  // Push bone rotation.y handle strongly upward & verify midpoint exceeds linear 0.5 rad
  tl.updateFCurveKeyframe(arm, 'rotation.y', 0, { editedSide: 'right', handleOffset: [8, 0.9] }, 'UpperArm');
  tl.evaluate(10);
  assert.ok(bone.rotation.y > 0.6, `Edited Bezier handle should push bone rotation.y @f10 > 0.6, got ${bone.rotation.y}`);
});

console.log(`\nWave 4A Graph Editor Suite: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
