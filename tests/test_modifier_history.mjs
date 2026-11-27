import assert from 'node:assert/strict';
import * as THREE from 'three';
import { SceneManager } from '../js/core/scene-manager.js';
import { ModifierStackCommand, CompositeCommand, applyAuthoritativeNormals } from '../js/core/geometry-commands.js';

let passed = 0, failed = 0;
const test = (name, fn) => {
  try { fn(); passed++; console.log(`ok   ${name}`); }
  catch (e) { failed++; console.error(`FAIL ${name}\n${e.stack}`); }
};

const meshWithStack = () => {
  const m = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial());
  m.userData.baseGeometry = m.geometry;
  m.userData.modifierStack = [{ id: 'a', type: 'array', name: 'array', enabled: true, params: { count: 2 } }];
  return m;
};

test('ModifierStackCommand undo/redo restores descriptors + geometry + baseGeometry', () => {
  const sm = new SceneManager(new THREE.Scene());
  const mesh = meshWithStack();
  sm.addObject(mesh, null, false, false);
  const before = { descriptors: JSON.parse(JSON.stringify(mesh.userData.modifierStack)), baseGeometry: mesh.userData.baseGeometry, geometry: mesh.geometry };
  const newGeom = new THREE.BoxGeometry(2, 2, 2);
  mesh.userData.modifierStack = [{ id: 'a', type: 'array', enabled: true, params: { count: 5 } }];
  mesh.geometry = newGeom;
  const after = { descriptors: JSON.parse(JSON.stringify(mesh.userData.modifierStack)), baseGeometry: mesh.userData.baseGeometry, geometry: newGeom };
  sm.executeCommand(new ModifierStackCommand({ mesh, before, after, description: 'test' }));
  assert.equal(mesh.geometry, newGeom);
  sm.undo();
  assert.equal(mesh.geometry, before.geometry);
  assert.equal(mesh.userData.modifierStack[0].params.count, 2);
  sm.redo();
  assert.equal(mesh.geometry, newGeom);
  assert.equal(mesh.userData.modifierStack[0].params.count, 5);
});

test('CompositeCommand undo reverses order', () => {
  const order = [];
  const mk = (id) => ({ execute: () => order.push(`e${id}`), undo: () => order.push(`u${id}`) });
  const c = new CompositeCommand([mk(1), mk(2)], 'comp');
  c.execute(); c.undo();
  assert.deepEqual(order, ['e1', 'e2', 'u2', 'u1']);
});

test('applyAuthoritativeNormals preserves custom normals', () => {
  const g = new THREE.BoxGeometry(1, 1, 1);
  const custom = new THREE.Float32BufferAttribute(new Float32Array(g.attributes.position.count * 3).fill(0), 3);
  for (let i = 0; i < custom.count; i++) custom.setXYZ(i, 0, 1, 0);
  applyAuthoritativeNormals(g, custom);
  assert.equal(g.attributes.normal.getY(0), 1);
  const g2 = new THREE.BufferGeometry();
  g2.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3));
  applyAuthoritativeNormals(g2, null);
  assert.ok(g2.attributes.normal, 'fallback compute when no normals');
});

test('history byte-budget evicts oldest and disposes only non-live geometry', () => {
  const sm = new SceneManager(new THREE.Scene());
  sm.maxHistoryBytes = 1000;
  const mesh = meshWithStack();
  sm.addObject(mesh, null, false, false);
  const live = mesh.geometry;
  const dead = new THREE.BoxGeometry();
  let deadDisposed = false, liveDisposed = false;
  dead.dispose = () => { deadDisposed = true; };
  live.dispose = () => { liveDisposed = true; };
  const cmd = (geometry, bytes) => ({ description: 'x', bytes, before: { geometry }, after: { geometry }, mesh, execute() {}, undo() {} });
  sm.executeCommand(cmd(dead, 600));
  sm.executeCommand(cmd(live, 600));
  assert.ok(deadDisposed, 'evicted non-live geometry disposed');
  assert.ok(!liveDisposed, 'live geometry not disposed');
  assert.equal(sm.undoStack.length, 1);
});

test('duplicate keeps modifierStack + baseGeometry independent', () => {
  const sm = new SceneManager(new THREE.Scene());
  const mesh = meshWithStack();
  sm.addObject(mesh, null, false, false);
  const [clone] = sm.duplicateObjects([mesh], { x: 2, y: 0, z: 0 });
  assert.notEqual(clone.userData.modifierStack, mesh.userData.modifierStack);
  assert.notEqual(clone.userData.baseGeometry, mesh.userData.baseGeometry);
  clone.userData.modifierStack[0].params.count = 99;
  assert.equal(mesh.userData.modifierStack[0].params.count, 2);
});

console.log(`\n${passed + failed} MODIFIER HISTORY TESTS: ${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;