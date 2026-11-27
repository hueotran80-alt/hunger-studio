/**
 * Character pipeline suite (Node, no browser): reference-free blockout mesh ->
 * humanoid armature -> auto-skin -> pose keyframes -> timeline evaluation ->
 * bake -> glTF export (including regression checks for D1, D2, D4).
 * Run with:
 *   node --import ./tests/three-resolve-hooks.mjs tests/test_character_pipeline.mjs
 */
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { SceneManager } from '../js/core/scene-manager.js';
import { TimelineEngine } from '../js/animation/timeline-engine.js';
import { RigSystem } from '../js/animation/rig-system.js';
import { StudioExporter } from '../js/exporters/export-import.js';
import { parseGLB } from './glb-inspect.mjs';

if (typeof globalThis.window === 'undefined') {
  globalThis.window = { dispatchEvent() {}, addEventListener() {}, removeEventListener() {} };
}
// GLTFExporter's binary path reads Blobs through FileReader (browser API).
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

let passed = 0;
let xfailed = 0;
const failures = [];
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`ok   ${name}`);
  } catch (error) {
    failures.push(name);
    console.error(`FAIL ${name}\n     ${error.stack || error.message}`);
  }
}
async function knownDefect(id, name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`XPASS ${id} ${name} — defect không còn tái hiện, hãy gỡ nhãn xfail`);
  } catch (error) {
    xfailed += 1;
    console.log(`xfail ${id} ${name} (known defect, chưa sửa): ${String(error.message).split('\n')[0]}`);
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeWorld() {
  const scene = new THREE.Scene();
  const manager = new SceneManager(scene);
  const timeline = new TimelineEngine({ fps: 30, startFrame: 0, endFrame: 60 });
  const rig = new RigSystem({ sceneManager: manager, scene, timeline });
  // The browser app exposes the timeline globally; exportGLTF reads it there.
  globalThis.window.timelineEngine = timeline;
  return { scene, manager, timeline, rig, root: manager.rootContainer };
}
function blockoutMesh() {
  const torso = new THREE.BoxGeometry(0.34, 0.5, 0.2);
  torso.translate(0, 1.2, 0);
  const head = new THREE.SphereGeometry(0.11, 12, 8);
  head.translate(0, 1.62, 0);
  const merged = new THREE.BufferGeometry();
  const geoms = [torso, head].map((g) => g.toNonIndexed());
  const total = geoms.reduce((s, g) => s + g.attributes.position.count, 0);
  const pos = new Float32Array(total * 3);
  const nrm = new Float32Array(total * 3);
  let off = 0;
  for (const g of geoms) {
    pos.set(g.attributes.position.array, off * 3);
    nrm.set(g.attributes.normal.array, off * 3);
    off += g.attributes.position.count;
  }
  merged.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  merged.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  const mesh = new THREE.Mesh(merged, new THREE.MeshStandardMaterial({ color: 0xc98d6b }));
  mesh.name = 'Character';
  return mesh;
}
function weightSum(geometry, i) {
  const w = geometry.attributes.skinWeight;
  return w.getX(i) + w.getY(i) + w.getZ(i) + w.getW(i);
}

await test('auto-skin binds every vertex with normalized weights to the humanoid skeleton', async () => {
  const { manager, rig } = makeWorld();
  const mesh = blockoutMesh();
  manager.addObject(mesh);
  const { armatureGroup, skeleton } = rig.createHumanoidArmature(1.8);
  const skinned = rig.autoSkinMesh(mesh, armatureGroup);
  await sleep(50);
  assert.ok(skinned && skinned.isSkinnedMesh, 'autoSkinMesh must return a SkinnedMesh');
  assert.equal(skinned.skeleton.bones.length, skeleton.bones.length);
  assert.ok(skeleton.bones.length >= 20, 'humanoid rig must have a full bone chain');
  const count = skinned.geometry.attributes.skinIndex.count;
  assert.equal(count, skinned.geometry.attributes.position.count);
  let bad = 0;
  for (let i = 0; i < count; i++) {
    const s = weightSum(skinned.geometry, i);
    if (Math.abs(s - 1) > 1e-3) bad++;
  }
  assert.equal(bad, 0, 'no vertex may lack normalized skin weights');
});

await test('D2: armature root is parented into the scene graph', async () => {
  const { scene, manager, rig } = makeWorld();
  const mesh = blockoutMesh();
  manager.addObject(mesh);
  const { armatureGroup } = rig.createHumanoidArmature(1.8);
  rig.autoSkinMesh(mesh, armatureGroup);
  await sleep(30);
  let p = armatureGroup;
  let hops = 0;
  while (p.parent && hops < 100) { p = p.parent; hops++; }
  assert.ok(p === scene, 'Humanoid_Armature must hang under the scene, not float parentless');
});

await test('pose keyframes land on the timeline and scrubbing evaluates them onto bones', async () => {
  const { manager, rig, timeline } = makeWorld();
  const mesh = blockoutMesh();
  manager.addObject(mesh);
  const { armatureGroup } = rig.createHumanoidArmature(1.8);
  const skinned = rig.autoSkinMesh(mesh, armatureGroup);
  await sleep(30);
  const seq = [[0, 'idle_natural'], [15, 'military_salute'], [30, 'idle_natural']];
  for (const [frame, pose] of seq) {
    assert.ok(rig.applyPose(skinned, pose), `pose ${pose} must apply`);
    assert.ok(rig.keyframePoseToTimeline(skinned, 'all', { frame, timeline }), `keyframe at ${frame}`);
  }
  const bone = skinned.skeleton.bones.find((b) => b.name === 'RightArm');
  timeline.seekToFrame(0);
  const q0 = bone.quaternion.clone();
  timeline.seekToFrame(15);
  const q15 = bone.quaternion.clone();
  assert.ok(q0.angleTo(q15) > 0.05, 'salute frame must rotate the upper arm');
  timeline.seekToFrame(30);
  const q30 = bone.quaternion.clone();
  assert.ok(q30.angleTo(q15) > 0.05, 'return-to-idle frame must differ from salute');
});

await test('bakeRigToClip samples the keyed range into a full-skeleton clip', async () => {
  const { manager, rig, timeline } = makeWorld();
  const mesh = blockoutMesh();
  manager.addObject(mesh);
  const { armatureGroup, skeleton } = rig.createHumanoidArmature(1.8);
  const skinned = rig.autoSkinMesh(mesh, armatureGroup);
  await sleep(30);
  for (const [frame, pose] of [[0, 'idle_natural'], [15, 'military_salute'], [30, 'idle_natural']]) {
    rig.applyPose(skinned, pose);
    rig.keyframePoseToTimeline(skinned, 'all', { frame, timeline });
  }
  const clip = rig.bakeRigToClip({ startFrame: 0, endFrame: 30, timeline, attachToTimeline: false });
  assert.ok(clip, 'bake must return a clip');
  assert.ok(Math.abs(clip.duration - 1) < 1e-6, '30 frames @30fps = 1s');
  assert.ok(clip.tracks.length >= skeleton.bones.length, 'every bone gets a quaternion track');
  assert.ok(clip.tracks.some((t) => t.name === 'Hips.position'), 'root bone gets a position track');
});

await test('D4: bake samples actual timeline motion across frames', async () => {
  const { manager, rig, timeline } = makeWorld();
  const mesh = blockoutMesh();
  manager.addObject(mesh);
  const { armatureGroup } = rig.createHumanoidArmature(1.8);
  const skinned = rig.autoSkinMesh(mesh, armatureGroup);
  await sleep(30);
  for (const [frame, pose] of [[0, 'idle_natural'], [15, 'military_salute'], [30, 'idle_natural']]) {
    rig.applyPose(skinned, pose);
    rig.keyframePoseToTimeline(skinned, 'all', { frame, timeline });
  }
  const clip = rig.bakeRigToClip({ startFrame: 0, endFrame: 30, timeline, attachToTimeline: false });
  const track = clip.tracks.find((t) => t.name === 'RightArm.quaternion');
  assert.ok(track, 'baked clip must contain the upper-arm track');
  const values = track.values;
  let varies = false;
  for (let i = 4; i < values.length; i += 4) {
    if (Math.abs(values[i] - values[0]) > 1e-4 || Math.abs(values[i + 1] - values[1]) > 1e-4
      || Math.abs(values[i + 2] - values[2]) > 1e-4 || Math.abs(values[i + 3] - values[3]) > 1e-4) {
      varies = true;
      break;
    }
  }
  assert.ok(varies, 'baked quaternion track must vary over time, not repeat one static pose');
});

await test('D1: bakeRigToClip attaches its clip to the timeline', async () => {
  const { manager, rig, timeline } = makeWorld();
  const mesh = blockoutMesh();
  manager.addObject(mesh);
  const { armatureGroup } = rig.createHumanoidArmature(1.8);
  const skinned = rig.autoSkinMesh(mesh, armatureGroup);
  await sleep(30);
  rig.applyPose(skinned, 'idle_natural');
  rig.keyframePoseToTimeline(skinned, 'all', { frame: 0, timeline });
  rig.bakeRigToClip({ startFrame: 0, endFrame: 30, timeline });
  assert.ok(timeline.clips.size > 0, 'baked clip must be attached to the timeline');
});

await test('attachClip with the documented (object, clip) order accepts the baked clip', async () => {
  const { manager, rig, timeline } = makeWorld();
  const mesh = blockoutMesh();
  manager.addObject(mesh);
  const { armatureGroup } = rig.createHumanoidArmature(1.8);
  const skinned = rig.autoSkinMesh(mesh, armatureGroup);
  await sleep(30);
  rig.applyPose(skinned, 'idle_natural');
  rig.keyframePoseToTimeline(skinned, 'all', { frame: 0, timeline });
  const clip = rig.bakeRigToClip({ startFrame: 0, endFrame: 30, timeline, attachToTimeline: false });
  const entry = timeline.attachClip(armatureGroup, clip);
  assert.ok(entry, 'correct argument order must attach');
  assert.ok(timeline.clips.has(armatureGroup.uuid));
});

await test('glTF export carries the skin (joints + weights) for the skinned character', async () => {
  const { scene, manager, rig, timeline } = makeWorld();
  const mesh = blockoutMesh();
  manager.addObject(mesh);
  const { armatureGroup, skeleton } = rig.createHumanoidArmature(1.8);
  rig.autoSkinMesh(mesh, armatureGroup);
  await sleep(30);
  const clip = rig.bakeRigToClip({ startFrame: 0, endFrame: 30, timeline, attachToTimeline: false });
  const exporter = new StudioExporter();
  exporter.attachSceneManager(manager);
  exporter.bindEngine({ scene });
  const res = await exporter.exportGLTF(scene, { binary: true, download: false, animations: [clip] });
  const { json: gltf } = parseGLB(res.buffer || await res.blob.arrayBuffer());
  assert.equal((gltf.skins || []).length, 1);
  assert.equal(gltf.skins[0].joints.length, skeleton.bones.length);
  const skinnedMeshes = (gltf.meshes || []).filter((m) => m.primitives.some((p) => p.attributes.JOINTS_0 !== undefined));
  assert.equal(skinnedMeshes.length, 1);
});

await test('D2: glTF export carries bone animation after createHumanoidArmature + autoSkinMesh', async () => {
  const { scene, manager, rig, timeline } = makeWorld();
  const mesh = blockoutMesh();
  manager.addObject(mesh);
  const { armatureGroup } = rig.createHumanoidArmature(1.8);
  rig.autoSkinMesh(mesh, armatureGroup);
  await sleep(30);
  const clip = rig.bakeRigToClip({ startFrame: 0, endFrame: 30, timeline, attachToTimeline: false });
  const exporter = new StudioExporter();
  exporter.attachSceneManager(manager);
  exporter.bindEngine({ scene });
  const res = await exporter.exportGLTF(scene, { binary: true, download: false, animations: [clip] });
  const { json: gltf } = parseGLB(res.buffer || await res.blob.arrayBuffer());
  assert.ok((gltf.animations || []).length >= 1, 'exported GLB must contain the baked action');
});

await test('export carries the timeline clip once the armature is inside export scope (D2 workaround)', async () => {
  const { scene, manager, rig, timeline, root } = makeWorld();
  const mesh = blockoutMesh();
  manager.addObject(mesh);
  const { armatureGroup } = rig.createHumanoidArmature(1.8);
  const skinned = rig.autoSkinMesh(mesh, armatureGroup);
  root.add(armatureGroup); // test-side workaround for D2; product code untouched
  await sleep(30);
  for (const [frame, pose] of [[0, 'idle_natural'], [15, 'military_salute'], [30, 'idle_natural']]) {
    rig.applyPose(skinned, pose);
    rig.keyframePoseToTimeline(skinned, 'all', { frame, timeline });
  }
  const clip = rig.bakeRigToClip({ startFrame: 0, endFrame: 30, timeline, attachToTimeline: false });
  timeline.attachClip(armatureGroup, clip);
  const exporter = new StudioExporter();
  exporter.attachSceneManager(manager);
  exporter.bindEngine({ scene });
  const res = await exporter.exportGLTF(scene, { binary: true, download: false });
  const { json: gltf } = parseGLB(res.buffer || await res.blob.arrayBuffer());
  assert.ok((gltf.animations || []).length >= 1, 'timeline-attached clip must reach the GLB');
  const anim = gltf.animations[0];
  assert.ok(anim.channels.length >= 20, 'action must drive the skeleton, not a single node');
});

console.log(`\nSummary: ${passed} passed, ${failures.length} failed, ${xfailed} xfail (known defects D1/D2/D4)`);
if (failures.length) {
  console.error('FAILED:', failures.join(' | '));
  process.exit(1);
}
console.log('CHARACTER PIPELINE SUITE DONE (xfail = defect đã ghi nhận, chưa sửa)');