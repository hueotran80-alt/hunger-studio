/**
 * Wave 4B Verification Suite:
 * - Sandboxed Driver AST Parser & Evaluator (zero eval/new Function, blocks unsafe escapes)
 * - Live cross-object Scene Property Drivers (transform, light, material, morphs)
 * - Named Action Editor blocks, switching without clobbering, FakeUser + DataBlockRegistry
 * - NLA Tracks & Strips Mixer (Replace / Add / Multiply, Influence, Scale, Repeat, Mute, Solo, Extrap, Push Down)
 * - Complete TimelineEngine.toJSON/fromJSON & .wbs ZIP round-trip preservation
 */

import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
  compileDriverExpression,
  evaluateDriverExpression,
} from '../js/animation/nla-drivers.js';
import { TimelineEngine } from '../js/animation/timeline-engine.js';
import { SceneManager } from '../js/core/scene-manager.js';
import { dataBlockRegistry } from '../js/core/data-blocks.js';
import { StudioExporter } from '../js/exporters/export-import.js';

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

await test('Sandboxed driver parser evaluates complex math & rejects unsafe JS/prototype payloads', () => {
  const res = evaluateDriverExpression(
    'sin(pi / 2) + clamp(x * 2, -3, 5) + (frame > 10 ? smoothstep(10, 20, frame) * 4 : 0) + 2^3',
    { frame: 15, x: 2 }
  );
  // 1 + 4 + 2 + 8 = 15
  assert.ok(Math.abs(res - 15.0) < 1e-6, `Expected 15.0, got ${res}`);

  const unsafePayloads = [
    'window.alert(1)',
    'globalThis.process',
    'process.exit(1)',
    'eval("1+1")',
    'Function("return 1")()',
    'x.constructor.constructor("return 1")()',
    'obj.__proto__.polluted = 1',
    'import("node:fs")',
    'fetch("http://evil")',
    'a = 5; a + 1',
    'foo[0]',
    'unknownFunc(1)',
  ];
  for (const expr of unsafePayloads) {
    assert.throws(() => compileDriverExpression(expr), `Must reject unsafe expression: ${expr}`);
  }
});

await test('Cross-object Scene Property Drivers drive transform, light intensity & material opacity', () => {
  const scene = new THREE.Scene();
  const sm = new SceneManager(scene);
  const ctrl = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial());
  ctrl.name = 'ControlEmpty';
  ctrl.position.set(1.5, 0, 0);

  const wheel = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial());
  wheel.name = 'DrivenWheel';

  const light = new THREE.PointLight(0xffffff, 1);
  light.name = 'DrivenLight';

  sm.addObject(ctrl, null, false, false);
  sm.addObject(wheel, null, false, false);
  sm.addObject(light, null, false, false);

  const tl = new TimelineEngine({ sceneManager: sm, fps: 30 });
  tl.addDriver({
    targetObject: wheel,
    targetPath: 'rotation.y',
    expression: 'masterX * 2 + sin(frame * 0.5)',
    variables: [{ name: 'masterX', object: ctrl, propertyPath: 'position.x' }],
  });
  tl.addDriver({
    targetObject: light,
    targetPath: 'intensity',
    expression: 'clamp(frame / 10, 0, 2)',
  });
  tl.addDriver({
    targetObject: wheel,
    targetPath: 'material.opacity',
    expression: '0.45',
  });

  tl.evaluate(10);
  const expectedRot = 1.5 * 2 + Math.sin(5);
  assert.ok(Math.abs(wheel.rotation.y - expectedRot) < 1e-6, `Expected wheel.rotation.y=${expectedRot}, got ${wheel.rotation.y}`);
  assert.ok(Math.abs(light.intensity - 1.0) < 1e-6);
  assert.ok(Math.abs(wheel.material.opacity - 0.45) < 1e-6);
  assert.equal(wheel.material.transparent, true);

  // Move control object & advance frame -> driver updates automatically
  ctrl.position.x = -0.5;
  tl.evaluate(25);
  assert.ok(Math.abs(wheel.rotation.y - (-1.0 + Math.sin(12.5))) < 1e-6);
  assert.ok(Math.abs(light.intensity - 2.0) < 1e-6);
});

await test('Action Editor library: create, switch, isolate, duplicate, fakeUser & DataBlockRegistry sync', () => {
  const scene = new THREE.Scene();
  const sm = new SceneManager(scene);
  const box = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial());
  box.name = 'HeroBox';
  sm.addObject(box, null, false, false);

  const tl = new TimelineEngine({ sceneManager: sm });

  // Author Action_Walk (x: 0 -> 10 on f0..f20)
  box.position.set(0, 0, 0);
  tl.insertKeyframe(box, 0, ['position'], 'linear');
  box.position.set(10, 0, 0);
  tl.insertKeyframe(box, 20, ['position'], 'linear');
  const actWalk = tl.createAction(box, 'Action_Walk', { cloneCurrent: true, fakeUser: true });

  // Author fresh empty Action_Jump (y: 0 -> 6 on f0..f10) without mutating Action_Walk
  const actJump = tl.createAction(box, 'Action_Jump', { cloneCurrent: false, fakeUser: false });
  box.position.set(0, 0, 0);
  tl.insertKeyframe(box, 0, ['position'], 'linear');
  box.position.set(0, 6, 0);
  tl.insertKeyframe(box, 10, ['position'], 'linear');

  tl.evaluate(5);
  assert.ok(Math.abs(box.position.y - 3.0) < 1e-4);
  assert.ok(Math.abs(box.position.x - 0.0) < 1e-4);

  // Switch back to Action_Walk -> restores X motion intact!
  tl.assignAction(box, actWalk.id);
  tl.evaluate(10);
  assert.ok(Math.abs(box.position.x - 5.0) < 1e-4, `Expected Action_Walk x=5 at f10, got ${box.position.x}`);
  assert.ok(Math.abs(box.position.y - 0.0) < 1e-4);

  // Duplicate & FakeUser + DataBlockRegistry sync
  const actRun = tl.duplicateAction(actWalk.id, 'Action_Run');
  assert.ok(actRun && actRun.id !== actWalk.id);
  tl.setActionFakeUser(actJump.id, true);
  assert.equal(tl.getAction(actJump.id).fakeUser, true);

  const stats = dataBlockRegistry.syncFromScene(scene, tl);
  assert.ok(stats.actions >= 3, `Expected >= 3 synced action blocks, got ${stats.actions}`);
});

await test('NLA Mixer layers Replace, Add & Multiply strips with Scale, Repeat, Mute & Solo', () => {
  const scene = new THREE.Scene();
  const sm = new SceneManager(scene);
  const rigBox = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial());
  rigBox.name = 'NLACube';
  sm.addObject(rigBox, null, false, false);

  const tl = new TimelineEngine({ sceneManager: sm });

  // Strip 1 action: position.x 0 -> 10 on 0..20, scale.y = 2
  rigBox.position.set(0, 0, 0);
  rigBox.scale.set(1, 2, 1);
  tl.insertKeyframe(rigBox, 0, ['position', 'scale'], 'linear');
  rigBox.position.set(10, 0, 0);
  rigBox.scale.set(1, 2, 1);
  tl.insertKeyframe(rigBox, 20, ['position', 'scale'], 'linear');
  const baseAct = tl.createAction(rigBox, 'BaseMove', { cloneCurrent: true });

  // Strip 2 action: additive position.y 0 -> 4 on 0..10
  const addAct = tl.createAction(rigBox, 'HopAdd', { cloneCurrent: false });
  rigBox.position.set(0, 0, 0);
  tl.insertKeyframe(rigBox, 0, ['position'], 'linear');
  rigBox.position.set(0, 4, 0);
  tl.insertKeyframe(rigBox, 10, ['position'], 'linear');

  // Strip 3 action: multiply scale.y = 3 across 0..20
  const mulAct = tl.createAction(rigBox, 'StretchMul', { cloneCurrent: false });
  rigBox.scale.set(1, 3, 1);
  tl.insertKeyframe(rigBox, 0, ['scale'], 'linear');
  rigBox.scale.set(1, 3, 1);
  tl.insertKeyframe(rigBox, 20, ['scale'], 'linear');

  // Push BaseMove down to Track 1
  tl.assignAction(rigBox, baseAct.id);
  const pushed = tl.pushActionToNLA(rigBox, 'BaseTrack');
  assert.ok(pushed && pushed.strip);
  assert.equal(tl.getActiveAction(rigBox), null, 'Push down should clear active action slot');

  // Track 2: Add HopAdd with scale=2 (duration 20 frames 0..20), influence=0.5, add blend
  const trAdd = tl.addNLATrack(rigBox, 'AdditiveTrack');
  const stAdd = tl.addNLAStrip(rigBox, trAdd.id, {
    actionId: addAct.id,
    startFrame: 0,
    scale: 2.0,
    repeat: 1,
    blendMode: 'add',
    influence: 0.5,
  });

  // Track 3: Multiply StretchMul with influence=0.5 (base scale.y=2 -> target 2*3=6 -> blended 4.0)
  const trMul = tl.addNLATrack(rigBox, 'MultiplyTrack');
  tl.addNLAStrip(rigBox, trMul.id, {
    actionId: mulAct.id,
    startFrame: 0,
    endFrame: 20,
    blendMode: 'multiply',
    influence: 0.5,
  });

  // Note BaseMove also set position.y=0 in base keyframes, and HopAdd adds 0.5 * 2.0 = 1.0 at frame 10!
  tl.evaluate(10);
  assert.ok(Math.abs(rigBox.position.x - 5.0) < 1e-4, `Expected BaseMove x=5.0, got ${rigBox.position.x}`);
  assert.ok(Math.abs(rigBox.position.y - 1.0) < 1e-4, `Expected Add y=1.0 (0.5 * 2), got ${rigBox.position.y}`);
  assert.ok(Math.abs(rigBox.scale.y - 4.0) < 1e-4, `Expected Multiply scale.y=4.0 (2 -> 6 at 50%), got ${rigBox.scale.y}`);

  // Solo AdditiveTrack -> disables BaseTrack and MultiplyTrack while evaluated
  rigBox.position.set(0, 0, 0);
  tl.setNLATrackState(rigBox, trAdd.id, { solo: true });
  tl.evaluate(10);
  assert.ok(Math.abs(rigBox.position.x - 0.0) < 1e-4, 'Solo AdditiveTrack must suppress BaseTrack x');
  assert.ok(Math.abs(rigBox.position.y - 1.0) < 1e-4);

  // Unsolo & Mute AdditiveTrack -> y drops back to 0 while x stays 5
  tl.setNLATrackState(rigBox, trAdd.id, { solo: false, muted: true });
  tl.evaluate(10);
  assert.ok(Math.abs(rigBox.position.x - 5.0) < 1e-4);
  assert.ok(Math.abs(rigBox.position.y - 0.0) < 1e-4);

  // Unmute & test Repeat=2 over 0..20 (action len 10 -> frame 5 and frame 15 both hit midpoint y=2 -> inf 0.5 gives y=1.0)
  tl.setNLATrackState(rigBox, trAdd.id, { muted: false });
  tl.updateNLAStrip(rigBox, trAdd.id, stAdd.id, { scale: 1.0, repeat: 2 });
  assert.equal(stAdd.endFrame, 20);
  tl.evaluate(15);
  assert.ok(Math.abs(rigBox.position.y - 1.0) < 1e-4, `Expected repeat=2 at f15 (half of 2nd cycle) y=1.0, got ${rigBox.position.y}`);
});

await test('Complete .wbs ZIP & TimelineEngine.toJSON/fromJSON round-trip preserves Actions, NLA Strips & Cross-Object Drivers', async () => {
  const sceneA = new THREE.Scene();
  const smA = new SceneManager(sceneA);
  const hero = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial());
  hero.name = 'RoundTripHero';
  const follower = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial());
  follower.name = 'RoundTripFollower';
  smA.addObject(hero, null, false, false);
  smA.addObject(follower, null, false, false);

  const tlA = new TimelineEngine({ sceneManager: smA });
  hero.position.set(0, 0, 0);
  tlA.insertKeyframe(hero, 0, ['position'], 'linear');
  hero.position.set(8, 0, 0);
  tlA.insertKeyframe(hero, 20, ['position'], 'linear');
  tlA.pushActionToNLA(hero, 'MainMove');

  // Driver reads hero.position.x -> moves follower.position.y to 2 * hero.position.x
  tlA.addDriver({
    targetObject: follower,
    targetPath: 'position.y',
    expression: 'hx * 2 + 1',
    variables: [{ name: 'hx', object: hero, propertyPath: 'position.x' }],
  });

  tlA.evaluate(10);
  assert.ok(Math.abs(hero.position.x - 4.0) < 1e-4);
  assert.ok(Math.abs(follower.position.y - 9.0) < 1e-4);

  // Export .wbs ZIP package & re-import into brand new Scene/TimelineEngine
  const exporter = new StudioExporter({ scene: sceneA, camera: new THREE.PerspectiveCamera(), sceneManager: smA, timelineEngine: tlA });
  const pkg = await exporter.exportProjectPackage({ download: false });

  const sceneB = new THREE.Scene();
  const smB = new SceneManager(sceneB);
  const tlB = new TimelineEngine({ sceneManager: smB });
  const importer = new StudioExporter({ scene: sceneB, camera: new THREE.PerspectiveCamera(), sceneManager: smB, timelineEngine: tlB });
  const res = await importer.importProjectJSON(pkg.bytes);
  assert.equal(res.success, true);

  const heroB = smB.findObjectByName('RoundTripHero');
  const followerB = smB.findObjectByName('RoundTripFollower');
  assert.ok(heroB && followerB);
  assert.equal(tlB.getActions().length, 1);
  assert.equal(tlB.getNLATracks(heroB).length, 1);
  assert.equal(tlB.getDrivers(followerB).length, 1);

  tlB.evaluate(15); // hero x = 6.0 -> follower y = 13.0
  assert.ok(Math.abs(heroB.position.x - 6.0) < 1e-4, `Imported NLA hero x=${heroB.position.x}`);
  assert.ok(Math.abs(followerB.position.y - 13.0) < 1e-4, `Imported Driver follower y=${followerB.position.y}`);
});

await test('Action <-> GraphEditor live sync, Object Delete/Undo for NLA & Drivers, and GLTF NLA/Bezier export', async () => {
  const scene = new THREE.Scene();
  const sm = new SceneManager(scene);
  const box = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial());
  box.name = 'NLASyncBox';
  const target = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial());
  target.name = 'DrivenBox';
  sm.addObject(box, null, false, false);
  sm.addObject(target, null, false, false);

  const tl = new TimelineEngine({ sceneManager: sm });
  box.position.set(0, 0, 0);
  tl.insertKeyframe(box, 0, ['position'], 'bezier');
  box.position.set(10, 0, 0);
  tl.insertKeyframe(box, 20, ['position'], 'bezier');

  const act = tl.createAction(box, 'WalkX', { cloneCurrent: true, fakeUser: true });
  tl.updateFCurveKeyframe(box, 'position.x', 20, { val: 12 });
  tl.setFCurveExtrapolation(box, 'position.x', 'cycle');
  const syncedPt = act.keyframes.find((k) => Math.abs(k.frame - 20) < 1e-3);
  assert.ok(syncedPt && Math.abs(syncedPt.position.x - 12) < 1e-4, 'Active Action must stay live-synced on FCurve edit');
  assert.equal(act.fcurveMeta['position.x']?.extrapolation, 'cycle', 'Active Action must keep updated extrapolation');

  // Push Action to NLA + add Driver on DrivenBox
  const pushed = tl.pushActionToNLA(box, 'WalkTrack');
  assert.ok(pushed?.strip);
  tl.addDriver({
    targetObject: target,
    targetPath: 'position.y',
    expression: 'bx * 0.5',
    variables: [{ name: 'bx', object: box, propertyPath: 'position.x' }],
  });

  // Export GLTF must sample NLA strip + Driver cleanly into animations
  const exp = new StudioExporter({ scene, camera: new THREE.PerspectiveCamera(), sceneManager: sm, timelineEngine: tl });
  const prevWin = globalThis.window;
  const prevFR = globalThis.FileReader;
  globalThis.window = { timelineEngine: tl };
  if (typeof globalThis.FileReader === 'undefined') {
    globalThis.FileReader = class {
      _done() { if (this.onload) this.onload(); if (this.onloadend) this.onloadend(); }
      readAsArrayBuffer(blob) { blob.arrayBuffer().then((b) => { this.result = b; this._done(); }); }
      readAsDataURL(blob) {
        blob.arrayBuffer().then((b) => {
          this.result = 'data:application/octet-stream;base64,' + Buffer.from(b).toString('base64');
          this._done();
        });
      }
    };
  }
  let gltfRes;
  try {
    gltfRes = await exp.exportGLTF(scene, { binary: false, download: false, quiet: true });
  } finally {
    if (prevWin === undefined) delete globalThis.window;
    else globalThis.window = prevWin;
    if (prevFR === undefined) delete globalThis.FileReader;
    else globalThis.FileReader = prevFR;
  }
  const gltf = JSON.parse(gltfRes.json);
  assert.ok(Array.isArray(gltf.animations) && gltf.animations.length >= 1, 'GLTF export must bake NLA/Driver tracks');
  assert.ok(gltf.animations[0].channels.length >= 2, 'GLTF baked clip must include NLA + Driver target channels');

  // Remove target & undo -> Drivers cleaned up on delete and restored on Ctrl+Z Undo
  sm.removeObject(target, true, false);
  assert.equal(tl.getDrivers(target).length, 0, 'Drivers must clean up when target deleted');
  sm.undo();
  assert.equal(tl.getDrivers(target).length, 1, 'Undo must restore Drivers on object');
  tl.evaluate(10);
  assert.ok(Math.abs(target.position.y - 3.0) < 0.5, `Restored Driver should evaluate from NLA box (~3.0), got ${target.position.y}`);
});

console.log(`\nWave 4B NLA, Actions & Drivers Suite: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
