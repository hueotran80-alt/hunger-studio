/**
 * Scene history: object lifecycle, duplicate selection, group/ungroup,
 * transform/property undo. Run with:
 *   node --import ./tests/three-resolve-hooks.mjs tests/test_scene_history.mjs
 */
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { SceneManager, TransformCommand } from '../js/core/scene-manager.js';
import { TimelineEngine } from '../js/animation/timeline-engine.js';

let passed = 0;
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

function mesh(name) {
  const object = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
  object.name = name;
  return object;
}

function makeScene() {
  const scene = new THREE.Scene();
  const manager = new SceneManager(scene);
  return { scene, manager, root: manager.rootContainer };
}

await test('add + delete object round-trips through undo/redo', () => {
  const { manager, root } = makeScene();
  const cube = mesh('Cube');
  manager.addObject(cube);
  assert.equal(root.children.length, 1);
  manager.removeObject(cube);
  assert.equal(root.children.length, 0);
  manager.undo();
  assert.equal(root.children.length, 1);
  assert.equal(root.children[0], cube);
  manager.redo();
  assert.equal(root.children.length, 0);
});

await test('duplicate selection clones every selected object as one undo step', () => {
  const { manager, root } = makeScene();
  const a = mesh('A');
  const b = mesh('B');
  manager.addObject(a);
  manager.addObject(b);
  manager.setSelection([a, b]);
  const clones = manager.duplicateObjects([a, b]);
  assert.deepEqual(clones.map((o) => o.name), ['A.001', 'B.001']);
  assert.deepEqual(root.children.map((o) => o.name), ['A', 'B', 'A.001', 'B.001']);
  assert.deepEqual(manager.getSelectedObjects().map((o) => o.name), ['A.001', 'B.001']);
  manager.undo();
  assert.deepEqual(root.children.map((o) => o.name), ['A', 'B']);
  assert.equal(manager.objects.size, 2);
  manager.redo();
  assert.deepEqual(root.children.map((o) => o.name), ['A', 'B', 'A.001', 'B.001']);
  assert.equal(manager.objects.size, 4);
});

await test('duplicate ignores a selected child whose parent is also selected', () => {
  const { manager } = makeScene();
  const parent = new THREE.Group();
  parent.name = 'Parent';
  const child = mesh('Child');
  manager.addObject(parent);
  manager.addObject(child, parent);
  manager.setSelection([parent, child]);
  const clones = manager.duplicateObjects([parent, child]);
  assert.equal(clones.length, 1, `expected 1 clone, got ${clones.length}`);
  assert.equal(clones[0].children.length, 1, 'nested child must be cloned with parent');
});

await test('duplicate pair remaps joints before either clone is added', () => {
  const { manager } = makeScene();
  const a = mesh('A');
  const b = mesh('B');
  const external = mesh('External');
  manager.addObject(a);
  manager.addObject(b);
  manager.addObject(external);
  a.userData.joints = [
    { type: 'fixed', targetUuid: b.uuid },
    { type: 'fixed', targetUuid: external.uuid },
    { type: 'spherical', targetUuid: b.uuid }
  ];
  b.userData.joints = [{ type: 'fixed', targetUuid: a.uuid }];
  const addedSpecs = [];
  manager.on('objectAdded', ({ object }) => {
    addedSpecs.push(structuredClone(object.userData.joints));
  });

  const [copyA, copyB] = manager.duplicateObjects([a, b]);
  const expectedA = [
    { type: 'fixed', targetUuid: copyB.uuid },
    { type: 'spherical', targetUuid: copyB.uuid }
  ];
  const expectedB = [{ type: 'fixed', targetUuid: copyA.uuid }];
  assert.deepEqual(copyA.userData.joints, expectedA);
  assert.deepEqual(copyB.userData.joints, expectedB);
  assert.deepEqual(addedSpecs, [expectedA, expectedB]);
});

await test('duplicate nested groups remaps descendants across all copied roots', () => {
  const { manager } = makeScene();
  const left = new THREE.Group();
  const nested = new THREE.Group();
  const right = new THREE.Group();
  const a = mesh('A');
  const b = mesh('B');
  const external = mesh('External');
  left.add(nested);
  nested.add(a);
  right.add(b);
  manager.addObject(left);
  manager.addObject(right);
  manager.addObject(external);
  left.userData.joints = [{ type: 'fixed', targetUuid: a.uuid }];
  a.userData.joints = [
    { type: 'fixed', targetUuid: left.uuid },
    { type: 'spherical', targetUuid: b.uuid },
    { type: 'fixed', targetUuid: external.uuid }
  ];
  b.userData.joints = [{ type: 'fixed', targetUuid: a.uuid }];

  const copies = manager.duplicateObjects([left, a, right]);
  assert.equal(copies.length, 2, 'selected descendants must not be duplicated twice');
  const [copyLeft, copyRight] = copies;
  const copyA = copyLeft.children[0].children[0];
  const copyB = copyRight.children[0];
  assert.deepEqual(copyLeft.userData.joints, [{ type: 'fixed', targetUuid: copyA.uuid }]);
  assert.deepEqual(copyA.userData.joints, [
    { type: 'fixed', targetUuid: copyLeft.uuid },
    { type: 'spherical', targetUuid: copyB.uuid }
  ]);
  assert.deepEqual(copyB.userData.joints, [{ type: 'fixed', targetUuid: copyA.uuid }]);
});

await test('duplicate single endpoint drops joints targeting uncopied objects', () => {
  const { manager } = makeScene();
  const a = mesh('A');
  const b = mesh('B');
  manager.addObject(a);
  manager.addObject(b);
  a.userData.joints = [{ type: 'fixed', targetUuid: b.uuid }];
  b.userData.joints = [{ type: 'fixed', targetUuid: a.uuid }];

  assert.deepEqual(manager.duplicateObject(a).userData.joints, []);
  assert.deepEqual(manager.duplicateObject(b).userData.joints, []);
  assert.deepEqual(a.userData.joints, [{ type: 'fixed', targetUuid: b.uuid }]);
  assert.deepEqual(b.userData.joints, [{ type: 'fixed', targetUuid: a.uuid }]);
});

await test('duplicate leaves original joint specs unchanged and independent', () => {
  const { manager } = makeScene();
  const group = new THREE.Group();
  const a = mesh('A');
  const b = mesh('B');
  const external = mesh('External');
  group.add(a, b);
  manager.addObject(group);
  manager.addObject(external);
  a.userData.joints = [
    { type: 'fixed', targetUuid: b.uuid, anchorA: { x: 1, y: 2, z: 3 } },
    { type: 'fixed', targetUuid: external.uuid }
  ];
  const originalSpecs = a.userData.joints;
  const snapshot = structuredClone(originalSpecs);

  const copy = manager.duplicateObject(group);
  const copiedSpecs = copy.children[0].userData.joints;
  assert.equal(a.userData.joints, originalSpecs);
  assert.deepEqual(originalSpecs, snapshot);
  assert.notEqual(copiedSpecs, originalSpecs);
  assert.notEqual(copiedSpecs[0], originalSpecs[0]);
  assert.deepEqual(copiedSpecs[0], { ...snapshot[0], targetUuid: copy.children[1].uuid });
  copiedSpecs[0].anchorA.x = 99;
  copiedSpecs[0].targetUuid = 'changed-copy-only';
  assert.deepEqual(originalSpecs, snapshot);
});

await test('duplicate undo/redo preserves remapped and dropped joint specs', () => {
  const { manager, root } = makeScene();
  const group = new THREE.Group();
  const a = mesh('A');
  const b = mesh('B');
  const external = mesh('External');
  group.add(a);
  manager.addObject(group);
  manager.addObject(b);
  manager.addObject(external);
  a.userData.joints = [{ type: 'fixed', targetUuid: b.uuid }];
  b.userData.joints = [
    { type: 'fixed', targetUuid: a.uuid },
    { type: 'fixed', targetUuid: external.uuid }
  ];
  manager.clearHistory();

  const [copyGroup, copyB] = manager.duplicateObjects([group, b]);
  const copyA = copyGroup.children[0];
  const expectedA = [{ type: 'fixed', targetUuid: copyB.uuid }];
  const expectedB = [{ type: 'fixed', targetUuid: copyA.uuid }];
  for (let i = 0; i < 2; i++) {
    assert.equal(manager.undoStack.length, 1);
    manager.undo();
    assert.deepEqual(root.children, [group, b, external]);
    assert.deepEqual(copyA.userData.joints, expectedA);
    assert.deepEqual(copyB.userData.joints, expectedB);
    manager.redo();
    assert.deepEqual(root.children, [group, b, external, copyGroup, copyB]);
    assert.deepEqual(copyA.userData.joints, expectedA);
    assert.deepEqual(copyB.userData.joints, expectedB);
  }
  assert.deepEqual(a.userData.joints, [{ type: 'fixed', targetUuid: b.uuid }]);
  assert.deepEqual(b.userData.joints, [
    { type: 'fixed', targetUuid: a.uuid },
    { type: 'fixed', targetUuid: external.uuid }
  ]);
});

await test('group undo restores children to their original parent', () => {
  const { manager, root } = makeScene();
  const a = mesh('A');
  const b = mesh('B');
  manager.addObject(a);
  manager.addObject(b);
  manager.setSelection([a, b]);
  const group = manager.groupObjects([a, b], 'Pair');
  assert.equal(root.children.length, 1);
  assert.equal(group.children.length, 2);
  manager.undo();
  assert.deepEqual(root.children.map((o) => o.name), ['A', 'B']);
  assert.equal(a.parent, root);
  assert.equal(b.parent, root);
  assert.equal(manager.objects.size, 2);
  manager.redo();
  assert.deepEqual(root.children.map((o) => o.name), ['Pair']);
  assert.equal(group.children.length, 2);
});

await test('ungroup undo restores the group and its children', () => {
  const { manager, root } = makeScene();
  const a = mesh('A');
  const b = mesh('B');
  manager.addObject(a);
  manager.addObject(b);
  const group = manager.groupObjects([a, b], 'Pair');
  manager.setSelection([group]);
  const children = manager.ungroup(group);
  assert.deepEqual(children.map((o) => o.name), ['A', 'B']);
  assert.deepEqual(root.children.map((o) => o.name), ['A', 'B']);
  manager.undo();
  assert.deepEqual(root.children.map((o) => o.name), ['Pair']);
  assert.equal(group.children.length, 2);
  assert.equal(a.parent, group);
  manager.redo();
  assert.deepEqual(root.children.map((o) => o.name), ['A', 'B']);
  assert.equal(a.parent, root);
});

await test('world transforms survive group/ungroup undo round-trip', () => {
  const { manager } = makeScene();
  const a = mesh('A');
  a.position.set(3, 0, 0);
  const b = mesh('B');
  b.position.set(-1, 0, 0);
  manager.addObject(a);
  manager.addObject(b);
  const group = manager.groupObjects([a, b], 'Pair');
  const groupedWorld = a.getWorldPosition(new THREE.Vector3());
  manager.ungroup(group);
  const ungroupedWorld = a.getWorldPosition(new THREE.Vector3());
  assert.ok(groupedWorld.distanceTo(ungroupedWorld) < 1e-6, 'ungroup moved child in world space');
  manager.undo();
  const restoredWorld = a.getWorldPosition(new THREE.Vector3());
  assert.ok(restoredWorld.distanceTo(ungroupedWorld) < 1e-6, 'undo ungroup moved child in world space');
});

await test('transform command undo/redo restores position, rotation and scale', () => {
  const { manager } = makeScene();
  const a = mesh('A');
  manager.addObject(a);
  const before = {
    position: a.position.clone(),
    quaternion: a.quaternion.clone(),
    scale: a.scale.clone(),
  };
  a.position.set(2, 3, 4);
  a.rotation.set(0.1, 0.2, 0.3);
  a.scale.set(2, 2, 2);
  const after = {
    position: a.position.clone(),
    quaternion: a.quaternion.clone(),
    scale: a.scale.clone(),
  };
  manager.executeCommand(new TransformCommand(a, before, after));
  manager.undo();
  assert.ok(a.position.equals(before.position));
  assert.ok(a.quaternion.equals(before.quaternion));
  assert.ok(a.scale.equals(before.scale));
  manager.redo();
  assert.ok(a.position.equals(after.position));
});

await test('rename and visibility undo restore the previous values', () => {
  const { manager } = makeScene();
  const a = mesh('A');
  manager.addObject(a);
  manager.renameObject(a, 'Renamed');
  manager.setVisibility(a, false);
  assert.equal(a.name, 'Renamed');
  assert.equal(a.visible, false);
  manager.undo();
  assert.equal(a.visible, true);
  manager.undo();
  assert.equal(a.name, 'A');
  manager.redo();
  manager.redo();
  assert.equal(a.name, 'Renamed');
  assert.equal(a.visible, false);
});

await test('clearHistory prevents undoing the previous scene', () => {
  const { manager } = makeScene();
  manager.addObject(mesh('A'));
  assert.equal(manager.canUndo(), true);
  manager.clearHistory();
  assert.equal(manager.canUndo(), false);
  manager.undo();
  assert.equal(manager.getAllObjects().length, 1);
});

// ---------------------------------------------------------------------------
// Timeline data (keyframes / bone tracks / clips) must survive undo
// ---------------------------------------------------------------------------
function makeRig(name = 'Rig') {
  const rig = new THREE.Group();
  rig.name = name;
  const bone = new THREE.Bone();
  bone.name = 'Hips';
  rig.add(bone);
  return rig;
}

await test('delete object restores keyframes + bone tracks through undo/redo', () => {
  const { manager } = makeScene();
  const timeline = new TimelineEngine({ fps: 30 });
  manager.engine = { timelineEngine: timeline };

  const rig = makeRig();
  manager.addObject(rig);
  timeline.insertKeyframe(rig, 5, ['position', 'rotation', 'scale']);
  timeline.insertBoneKeyframe(rig, 'Hips', 7, ['rotation', 'position']);
  assert.equal(timeline.getKeyframes(rig).length, 1);
  assert.equal(timeline.getBoneTracks(rig).size, 1);

  manager.removeObject(rig);
  assert.equal(timeline.getKeyframes(rig).length, 0);
  assert.equal(timeline.getBoneTracks(rig).size, 0);

  manager.undo();
  assert.equal(rig.parent, manager.rootContainer);
  const keyframes = timeline.getKeyframes(rig);
  assert.equal(keyframes.length, 1, 'keyframe phải được khôi phục cùng object');
  assert.equal(keyframes[0].frame, 5);
  const bones = timeline.getBoneTracks(rig);
  assert.equal(bones.size, 1, 'bone track phải được khôi phục');
  assert.equal(bones.get('Hips').rotationTrack[0].frame, 7);
  assert.equal(bones.get('Hips').positionTrack[0].frame, 7);

  manager.redo();
  assert.equal(timeline.getKeyframes(rig).length, 0);
  assert.equal(timeline.getBoneTracks(rig).size, 0);
});

await test('deleting an object keyframe keeps bone tracks alive', () => {
  const { manager } = makeScene();
  const timeline = new TimelineEngine({ fps: 30 });
  manager.engine = { timelineEngine: timeline };
  const rig = makeRig('Rig2');
  manager.addObject(rig);
  timeline.insertKeyframe(rig, 3, ['position']);
  timeline.insertBoneKeyframe(rig, 'Hips', 4, ['rotation']);

  assert.equal(timeline.deleteKeyframe(rig, 3), true);
  assert.equal(timeline.getKeyframes(rig).length, 0);
  assert.equal(timeline.getBoneTracks(rig).size, 1, 'xoá keyframe object không được xoá bone track');
  assert.ok(timeline.getAllKeyframedObjects().includes(rig), 'object còn bone track phải ở lại timeline');
});

await test('deleting a group clears and restores descendant timeline tracks', () => {
  const { manager } = makeScene();
  const timeline = new TimelineEngine({ fps: 30 });
  manager.engine = { timelineEngine: timeline };
  const group = new THREE.Group();
  group.name = 'Group';
  const child = mesh('Child');
  group.add(child);
  manager.addObject(group);
  timeline.insertKeyframe(child, 2, ['position']);

  manager.removeObject(group);
  assert.equal(timeline.getKeyframes(child).length, 0, 'xoá group phải dọn track của con');

  manager.undo();
  assert.equal(timeline.getKeyframes(child).length, 1, 'undo phải trả lại track của con');
  assert.equal(timeline.getKeyframes(child)[0].frame, 2);
});

await test('group + undo keeps child keyframes', () => {
  const { manager } = makeScene();
  const timeline = new TimelineEngine({ fps: 30 });
  manager.engine = { timelineEngine: timeline };
  const a = mesh('A');
  const b = mesh('B');
  manager.addObject(a);
  manager.addObject(b);
  timeline.insertKeyframe(a, 9, ['position']);

  manager.setSelection([a, b]);
  manager.groupObjects([a, b], 'Pair');
  manager.undo();
  assert.equal(a.parent, manager.rootContainer);
  assert.equal(timeline.getKeyframes(a).length, 1, 'undo group không được xoá keyframe của con');
});

await test('biên an toàn: double removeObject, groupObjects kèm cha+con, rename rỗng/trùng, redo stack bị xoá', () => {
  const { manager, root } = makeScene();
  const a = mesh('Cube');
  manager.addObject(a);
  manager.setSelection([a]);
  manager.clearHistory();

  // Double removeObject must be a no-op on 2nd call and clear selection
  assert.equal(manager.removeObject(a), true);
  assert.equal(manager.getSelectedObjects().length, 0);
  assert.equal(manager.removeObject(a), false, 'gọi removeObject lần 2 phải trả false');
  assert.equal(manager.undoStack.length, 1, 'gọi removeObject lần 2 không được thêm bước undo');

  // New command after undo clears redo stack
  manager.undo();
  const b = mesh('B');
  manager.addObject(b);
  manager.undo();
  const c = mesh('C');
  manager.addObject(c);
  assert.equal(manager.canRedo(), false, 'redo stack phải bị xoá sau lệnh mới');
  manager.redo();
  assert.deepEqual(root.children.map((o) => o.name), ['Cube', 'C']);

  // groupObjects with parent+child+other must keep child inside parent
  const parent = new THREE.Group(); parent.name = 'Parent';
  const child = mesh('Child');
  manager.addObject(parent);
  manager.addObject(child, parent);
  const grouped = manager.groupObjects([parent, child, c], 'Combined');
  assert.ok(grouped);
  assert.equal(parent.parent, grouped);
  assert.equal(c.parent, grouped);
  assert.equal(child.parent, parent, 'groupObjects không được xé con ra khỏi cha');

  // renameObject with identical or whitespace-only name must be rejected
  manager.clearHistory();
  assert.equal(manager.renameObject(c, 'C'), false);
  assert.equal(manager.renameObject(c, '   '), false);
  assert.equal(c.name, 'C');
  assert.equal(manager.undoStack.length, 0);
});

if (failures.length) {
  console.error(`\n${failures.length} FAILED: ${failures.join(', ')}`);
  process.exit(1);
}
console.log(`\nALL ${passed} SCENE HISTORY TESTS PASSED`);
