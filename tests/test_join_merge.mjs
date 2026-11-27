/**
 * Join + merge groups regression suite (Node, no browser).
 * Covers the multi-material / atomic-undo Join fixes and the useGroups path of
 * mergeBufferGeometries. Run with:
 *   node --import ./tests/three-resolve-hooks.mjs tests/test_join_merge.mjs
 */
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { mergeBufferGeometries } from '../js/core/modifiers.js';
import { SceneManager } from '../js/core/scene-manager.js';
import * as ModifierStack from '../js/core/modifier-stack.js';
import { BlenderModelingSuite } from '../js/ui/blender-modeling-suite.js';

// Join dispatches a viewport event; Node has no DOM.
if (typeof globalThis.window === 'undefined') {
  globalThis.window = { dispatchEvent() {}, addEventListener() {}, removeEventListener() {} };
}

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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function mat(color) {
  return new THREE.MeshStandardMaterial({ color });
}
function box(name, material, x = 0) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), material);
  m.name = name;
  m.position.x = x;
  return m;
}
function makeWorld() {
  const scene = new THREE.Scene();
  const manager = new SceneManager(scene);
  const suite = {
    sceneManager: manager,
    engine: { updateSelectionHelper() {} },
    wireframeOverlayEnabled: false
  };
  const join = () => BlenderModelingSuite.prototype.joinSelectedMeshes.call(suite);
  return { scene, manager, root: manager.rootContainer, join };
}
function meshesUnder(root) {
  const out = [];
  root.traverse((o) => { if (o.isMesh) out.push(o); });
  return out;
}

await test('mergeBufferGeometries default keeps legacy behaviour (no groups)', () => {
  const a = new THREE.BoxGeometry(1, 1, 1);
  const b = new THREE.BoxGeometry(1, 1, 1);
  const merged = mergeBufferGeometries([a, b]);
  assert.equal(merged.groups.length, 0);
  assert.equal(merged.attributes.position.count, 72);
});

await test('mergeBufferGeometries useGroups emits one group per source with vertex offsets', () => {
  const a = new THREE.BoxGeometry(1, 1, 1);
  const b = new THREE.SphereGeometry(0.5, 8, 6);
  const merged = mergeBufferGeometries([a, b], true);
  assert.equal(merged.groups.length, 2);
  assert.equal(merged.groups[0].start, 0);
  assert.equal(merged.groups[0].count, a.toNonIndexed().attributes.position.count);
  assert.equal(merged.groups[1].start, merged.groups[0].count);
  assert.equal(merged.groups[1].count, b.toNonIndexed().attributes.position.count);
  assert.deepEqual(merged.groups.map((g) => g.materialIndex), [0, 1]);
});

await test('mergeBufferGeometries single source + useGroups covers whole mesh', () => {
  const a = new THREE.BoxGeometry(1, 1, 1);
  const merged = mergeBufferGeometries([a], true);
  assert.equal(merged.groups.length, 1);
  assert.equal(merged.groups[0].start, 0);
  assert.equal(merged.groups[0].count, merged.attributes.position.count);
});

await test('Join keeps one material slot per source and maps groups to them', async () => {
  const { manager, root, join } = makeWorld();
  const wood = mat(0x8a5a2b);
  const metal = mat(0x40454c);
  const a = box('Body', wood, 0);
  const b = box('Band', metal, 2);
  manager.addObject(a);
  manager.addObject(b);
  manager.setSelection([a, b]);
  manager.select(a, true);
  join();
  await sleep(50);
  const alive = meshesUnder(root);
  assert.equal(alive.length, 1);
  const joined = alive[0];
  assert.ok(Array.isArray(joined.material), 'joined mesh must carry a material array');
  assert.equal(joined.material.length, 2);
  assert.deepEqual(joined.material.map((m) => m.color.getHexString()), ['8a5a2b', '40454c']);
  const mis = new Set(joined.geometry.groups.map((g) => g.materialIndex));
  assert.deepEqual([...mis].sort(), [0, 1]);
  // BoxGeometry carries 6 face groups per source; Join must preserve them all.
  assert.equal(joined.geometry.groups.length, 12);
  const woodVerts = joined.geometry.groups.filter((g) => g.materialIndex === 0).reduce((s, g) => s + g.count, 0);
  const metalVerts = joined.geometry.groups.filter((g) => g.materialIndex === 1).reduce((s, g) => s + g.count, 0);
  assert.equal(woodVerts, 36);
  assert.equal(metalVerts, 36);
});

await test('Join keeps active object name and its modifier stack', async () => {
  const { manager, root, join } = makeWorld();
  const a = box('Body', mat(0x8a5a2b), 0);
  const b = box('Band', mat(0x40454c), 2);
  manager.addObject(a);
  manager.addObject(b);
  ModifierStack.addModifier(a, 'bevel', { width: 0.02, segments: 1 }, { sceneManager: manager });
  await sleep(50);
  manager.setSelection([a, b]);
  manager.select(a, true);
  join();
  await sleep(50);
  const joined = meshesUnder(root)[0];
  assert.equal(joined, a, 'active object must survive the join');
  assert.equal(joined.name, 'Body');
  assert.equal(ModifierStack.getStack(joined).length, 1);
  assert.equal(ModifierStack.getStack(joined)[0].type, 'bevel');
});

await test('Join is a single atomic undo step restoring every source exactly', async () => {
  const { manager, root, join } = makeWorld();
  const wood = mat(0x8a5a2b);
  const metal = mat(0x40454c);
  const a = box('Body', wood, 0);
  const b = box('Band', metal, 2);
  const c = box('Foot', metal, 4);
  manager.addObject(a);
  manager.addObject(b);
  manager.addObject(c);
  ModifierStack.addModifier(a, 'bevel', { width: 0.02, segments: 1 }, { sceneManager: manager });
  await sleep(50);
  const before = new Map([a, b, c].map((m) => [m, {
    geometry: m.geometry, material: m.material, parent: m.parent,
    stack: ModifierStack.getStack(m).length
  }]));
  const historyBefore = manager.undoStack.length;
  manager.setSelection([a, b, c]);
  manager.select(c, true);
  join();
  await sleep(50);
  assert.equal(manager.undoStack.length, historyBefore + 1, 'join must push exactly one command');
  assert.equal(meshesUnder(root).length, 1);
  manager.undo();
  await sleep(50);
  assert.equal(meshesUnder(root).length, 3, 'one undo must restore all sources');
  for (const m of [a, b, c]) {
    const snap = before.get(m);
    assert.equal(m.geometry, snap.geometry, `${m.name} geometry reference restored`);
    assert.equal(m.material, snap.material, `${m.name} material restored`);
    assert.equal(m.parent, snap.parent, `${m.name} parent restored`);
    assert.equal(ModifierStack.getStack(m).length, snap.stack, `${m.name} stack restored`);
  }
  assert.equal(a.geometry.attributes.position.count, before.get(a).geometry.attributes.position.count);
});

await test('Join redo re-applies the merge and a second undo restores again', async () => {
  const { manager, root, join } = makeWorld();
  const a = box('Body', mat(0x8a5a2b), 0);
  const b = box('Band', mat(0x40454c), 2);
  manager.addObject(a);
  manager.addObject(b);
  manager.setSelection([a, b]);
  manager.select(a, true);
  join();
  await sleep(30);
  manager.undo();
  await sleep(30);
  assert.equal(meshesUnder(root).length, 2);
  manager.redo();
  await sleep(30);
  assert.equal(meshesUnder(root).length, 1);
  assert.ok(Array.isArray(meshesUnder(root)[0].material));
  manager.undo();
  await sleep(30);
  assert.equal(meshesUnder(root).length, 2);
  assert.equal(a.geometry.attributes.position.count, 24);
  assert.equal(b.geometry.attributes.position.count, 24);
});

await test('Join maps per-group materials of an already multi-material source', async () => {
  const { manager, root, join } = makeWorld();
  const m0 = mat(0xff0000);
  const m1 = mat(0x00ff00);
  const m2 = mat(0x0000ff);
  const multi = box('Multi', [m0, m1], 0);
  multi.geometry.clearGroups();
  multi.geometry.addGroup(0, 18, 0);
  multi.geometry.addGroup(18, 18, 1);
  const single = box('Single', m2, 2);
  manager.addObject(multi);
  manager.addObject(single);
  manager.setSelection([multi, single]);
  manager.select(multi, true);
  join();
  await sleep(50);
  const joined = meshesUnder(root)[0];
  assert.equal(joined.material.length, 3);
  const byMat = joined.geometry.groups.map((g) => joined.material[g.materialIndex].color.getHexString());
  assert.ok(byMat.includes('ff0000'));
  assert.ok(byMat.includes('00ff00'));
  assert.ok(byMat.includes('0000ff'));
  const redCount = joined.geometry.groups.filter((g) => joined.material[g.materialIndex] === m0).reduce((s, g) => s + g.count, 0);
  const greenCount = joined.geometry.groups.filter((g) => joined.material[g.materialIndex] === m1).reduce((s, g) => s + g.count, 0);
  assert.equal(redCount, 18);
  assert.equal(greenCount, 18);
});

await test('Join undo/redo cycle keeps source geometry attributes readable (no premature dispose)', async () => {
  const { manager, root, join } = makeWorld();
  const a = box('Body', mat(0x8a5a2b), 0);
  const b = box('Band', mat(0x40454c), 2);
  manager.addObject(a);
  manager.addObject(b);
  manager.setSelection([a, b]);
  manager.select(a, true);
  join();
  await sleep(30);
  manager.undo();
  await sleep(30);
  manager.redo();
  await sleep(30);
  manager.undo();
  await sleep(30);
  assert.equal(a.geometry.attributes.position.array.length, 72);
  assert.equal(b.geometry.attributes.position.array.length, 72);
  assert.equal(meshesUnder(root).length, 2);
});

console.log(`\nSummary: ${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.error('FAILED:', failures.join(' | '));
  process.exit(1);
}
console.log('ALL JOIN/MERGE TESTS PASSED');