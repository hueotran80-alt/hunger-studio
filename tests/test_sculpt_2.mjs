/**
 * Sculpt Mode 2.0 (Rust WASM + BVH Sphere Query) Test Suite:
 * 1. All 10 WASM sculpt brushes (draw, grab, inflate, smooth, flatten, clay, pinch, crease, snake_hook, mask)
 * 2. > 30,000-triangle high-poly BVH Sphere Query + WASM stroke benchmark (< 25 ms)
 * 3. Coincident UV/corner seam welding across inflate & smooth strokes (zero seam tear)
 * 4. Sculpt Mask painting, locked attenuation, invertMask, clearMask & Undo/Redo
 * 5. Snake Hook, Clay Strips, Crease brushes + SculptCommand Undo/Redo exact round-trip
 * 6. Rust WASM Voxel Remesh (Ctrl+R engine) + SculptRemeshCommand Undo/Redo
 * 7. Clean SculptMode exit restoring material.vertexColors & transient attributes
 *
 * Run: node --import ./tests/three-resolve-hooks.mjs tests/test_sculpt_2.mjs
 */
import assert from 'node:assert/strict';
import * as THREE from 'three';

const eventBus = new EventTarget();
globalThis.window = Object.assign(eventBus, {
  addEventListener: eventBus.addEventListener.bind(eventBus),
  removeEventListener: eventBus.removeEventListener.bind(eventBus),
  dispatchEvent: eventBus.dispatchEvent.bind(eventBus),
  innerWidth: 1280,
  innerHeight: 720
});

const { SceneManager } = await import('../js/core/scene-manager.js');
const {
  initMeshKernel,
  isMeshKernelReady,
  SCULPT_BRUSH_IDS,
  sculptStrokeInWasm,
  voxelRemeshInWasm
} = await import('../js/core/mesh-kernel-bridge.js');
const { SculptMode, SCULPT_BRUSHES } = await import('../js/core/sculpt-mode.js');

const failures = [];
async function test(name, fn) {
  try {
    await fn();
    console.log(`PASS: ${name}`);
  } catch (err) {
    failures.push({ name, err });
    console.error(`FAIL: ${name}\n  ${err?.stack || err}`);
  }
}

await initMeshKernel();
assert.equal(isMeshKernelReady(), true, 'Rust mesh_kernel WASM should be ready in Node tests');

function createMockSceneManager() {
  const undoStack = [];
  const redoStack = [];
  return {
    undoStack,
    redoStack,
    executeCommand(cmd) {
      undoStack.push(cmd);
      redoStack.length = 0;
    },
    undo() {
      const cmd = undoStack.pop();
      if (!cmd) return false;
      cmd.undo();
      redoStack.push(cmd);
      return true;
    },
    redo() {
      const cmd = redoStack.pop();
      if (!cmd) return false;
      cmd.execute();
      undoStack.push(cmd);
      return true;
    }
  };
}

function createMockEngine() {
  return {
    scene: new THREE.Scene(),
    camera: new THREE.PerspectiveCamera(45, 1.5, 0.1, 100),
    controls: { enabled: true },
    transformControls: { detach() {} },
    requestRender() {}
  };
}

function assertAllFinite(arr, label) {
  for (let i = 0; i < arr.length; i++) {
    assert.ok(Number.isFinite(arr[i]), `${label}: non-finite value at index ${i}`);
  }
}

await test('1. All 10 Sculpt 2.0 Rust WASM brushes execute and produce finite changes', () => {
  assert.equal(SCULPT_BRUSHES.length, 10);
  assert.equal(Object.keys(SCULPT_BRUSH_IDS).length, 10);

  for (const brush of SCULPT_BRUSHES) {
    const geom = new THREE.SphereGeometry(1, 24, 16);
    const pos = new Float32Array(geom.attributes.position.array);
    const basePos = new Float32Array(pos);
    geom.computeVertexNormals();
    const norm = new Float32Array(geom.attributes.normal.array);
    const mask = new Float32Array(geom.attributes.position.count);

    const beforePos = new Float32Array(pos);
    const modified = sculptStrokeInWasm({
      positions: pos,
      normals: norm,
      mask,
      basePositions: brush === 'grab' ? basePos : null,
      brush,
      center: [0, 1, 0],
      normal: [0, 1, 0],
      delta: [0.18, 0.15, 0.05],
      radius: 0.65,
      strength: 0.65,
      dir: 1.0
    });

    assert.ok(modified > 0, `${brush} should touch at least one vertex`);
    assertAllFinite(pos, `${brush} pos`);
    assertAllFinite(mask, `${brush} mask`);

    if (brush === 'mask') {
      const maxMask = Math.max(...mask);
      assert.ok(maxMask > 0.1, 'mask brush must paint mask > 0.1');
    } else {
      let maxDiff = 0;
      for (let i = 0; i < pos.length; i++) {
        maxDiff = Math.max(maxDiff, Math.abs(pos[i] - beforePos[i]));
      }
      assert.ok(maxDiff > 1e-4, `${brush} should displace geometry (maxDiff=${maxDiff})`);
    }
  }
});

await test('2. >30,000-triangle BVH Sphere Query + Rust WASM stroke finishes under 25 ms', () => {
  const geom = new THREE.SphereGeometry(1.5, 128, 128);
  const triCount = geom.index ? geom.index.count / 3 : geom.attributes.position.count / 3;
  assert.ok(triCount > 30000, `Expected > 30k triangles, got ${triCount}`);

  const mesh = new THREE.Mesh(geom, new THREE.MeshStandardMaterial());
  const sm = createMockSceneManager();
  const sculpt = new SculptMode(createMockEngine(), { sceneManager: sm });
  sculpt.enter(mesh);
  sculpt.setBrush('draw');
  sculpt.setRadius(0.35);
  sculpt.setStrength(0.6);
  sculpt.setSymmetry(false);

  // Warm up JIT/BVH paths, then measure the median of repeated localized strokes.
  for (let i = 0; i < 3; i += 1) {
    sculpt.applyStroke({
      point: new THREE.Vector3(0, i % 2 === 0 ? 1.5 : -1.5, 0),
      face: { normal: new THREE.Vector3(0, i % 2 === 0 ? 1 : -1, 0) },
      object: mesh
    });
  }

  const samples = [];
  let touched = 0;
  for (let i = 0; i < 7; i += 1) {
    const t0 = performance.now();
    touched = sculpt.applyStroke({
      point: new THREE.Vector3(0, i % 2 === 0 ? 1.5 : -1.5, 0),
      face: { normal: new THREE.Vector3(0, i % 2 === 0 ? 1 : -1, 0) },
      object: mesh
    });
    samples.push(performance.now() - t0);
  }
  samples.sort((a, b) => a - b);
  const dt = samples[Math.floor(samples.length / 2)];

  assert.ok(touched > 0 && touched < geom.attributes.position.count * 0.25, `BVH sphere query should target local subset (${touched})`);
  assert.ok(dt < 25, `Expected median stroke < 25 ms on ${triCount} tris, took ${dt.toFixed(2)} ms (max ${samples.at(-1).toFixed(2)} ms)`);
  assert.ok(mesh.geometry.boundsTree, 'BVH must remain attached after stroke');
  assertAllFinite(mesh.geometry.attributes.position.array, 'high-poly positions');
  console.log(`  Benchmark: ${triCount} tris stroke (${touched} touched verts) median ${dt.toFixed(2)} ms, max ${samples.at(-1).toFixed(2)} ms`);

  sculpt.exit();
});

await test('3. Coincident seam welding keeps BoxGeometry & UV-seam corners watertight on inflate & smooth', () => {
  const geom = new THREE.BoxGeometry(2, 2, 2, 4, 4, 4);
  const mesh = new THREE.Mesh(geom, new THREE.MeshStandardMaterial());
  const sculpt = new SculptMode(createMockEngine(), { sceneManager: createMockSceneManager() });
  sculpt.enter(mesh);
  sculpt.setRadius(0.9);
  sculpt.setStrength(0.75);
  sculpt.setSymmetry(false);

  // Paint inflate and smooth directly on corner (1, 1, 1) shared by 3 UV seam faces
  sculpt.setBrush('inflate');
  for (let s = 0; s < 3; s++) {
    sculpt.applyStroke({
      point: new THREE.Vector3(1, 1, 1),
      face: { normal: new THREE.Vector3(1, 1, 1).normalize() },
      object: mesh
    });
  }

  sculpt.setBrush('smooth');
  sculpt.applyStroke({
    point: new THREE.Vector3(1, 1, 1),
    face: { normal: new THREE.Vector3(1, 1, 1).normalize() },
    object: mesh
  });

  // Verify every weld group remained tightly coincident (no seam tearing)
  const pos = geom.attributes.position.array;
  assert.ok(sculpt._weldGroups.length > 0, 'BoxGeometry should produce coincident seam weld groups');
  for (const members of sculpt._weldGroups) {
    const r = members[0] * 3;
    for (let j = 1; j < members.length; j++) {
      const m = members[j] * 3;
      const gap = Math.hypot(pos[m] - pos[r], pos[m + 1] - pos[r + 1], pos[m + 2] - pos[r + 2]);
      assert.ok(gap < 1e-5, `Seam gap detected (${gap}) after sculpt stroke`);
    }
  }

  sculpt.exit();
});

await test('4. Sculpt Mask painting, sculpt lock attenuation, invertMask, clearMask & Undo/Redo', () => {
  const geom = new THREE.SphereGeometry(1, 24, 16);
  const mesh = new THREE.Mesh(geom, new THREE.MeshStandardMaterial());
  const sm = createMockSceneManager();
  const sculpt = new SculptMode(createMockEngine(), { sceneManager: sm });
  sculpt.enter(mesh);
  sculpt.setSymmetry(false);
  sculpt.setRadius(0.5);
  sculpt.setStrength(0.9);

  // Paint mask at top pole until saturated (1.0)
  sculpt.setBrush('mask');
  for (let i = 0; i < 6; i++) {
    sculpt.applyStroke({
      point: new THREE.Vector3(0, 1, 0),
      face: { normal: new THREE.Vector3(0, 1, 0) },
      object: mesh
    }, { recordUndo: i === 0 });
  }

  const mask = sculpt.getMask();
  assert.ok(mask instanceof Float32Array);

  // Identify top pole vertex indices (y > 0.99) and bottom pole indices (y < -0.99)
  const pos = geom.attributes.position.array;
  const topVerts = [];
  const bottomVerts = [];
  for (let i = 0; i < geom.attributes.position.count; i++) {
    if (pos[i * 3 + 1] > 0.99) topVerts.push(i);
    if (pos[i * 3 + 1] < -0.99) bottomVerts.push(i);
  }
  assert.ok(topVerts.length > 0 && bottomVerts.length > 0);
  for (const vi of topVerts) {
    assert.ok(mask[vi] >= 0.999, `Top vertex ${vi} should be fully masked (${mask[vi]})`);
  }

  // Sculpt Draw on masked top pole: top vertices must NOT move!
  const beforeMaskedY = pos[topVerts[0] * 3 + 1];
  sculpt.setBrush('draw');
  sculpt.applyStroke({
    point: new THREE.Vector3(0, 1, 0),
    face: { normal: new THREE.Vector3(0, 1, 0) },
    object: mesh
  });
  assert.equal(pos[topVerts[0] * 3 + 1], beforeMaskedY, 'Fully masked vertices must not move');

  // Invert Mask -> top becomes 0.0, bottom becomes 1.0
  assert.equal(sculpt.invertMask(), true);
  assert.ok(mask[topVerts[0]] < 1e-5, 'Inverted mask should unlock top pole');
  assert.ok(mask[bottomVerts[0]] > 0.999, 'Inverted mask should lock bottom pole');

  // Undo invert -> back to top locked
  assert.equal(sm.undo(), true);
  assert.ok(sculpt.getMask()[topVerts[0]] >= 0.999);
  assert.equal(sm.redo(), true);
  assert.ok(sculpt.getMask()[topVerts[0]] < 1e-5);

  // Clear Mask -> all zeroes + Undo restores
  assert.equal(sculpt.clearMask(), true);
  assert.equal(Math.max(...sculpt.getMask()), 0);
  assert.equal(sm.undo(), true);
  assert.ok(sculpt.getMask()[bottomVerts[0]] > 0.999);

  sculpt.exit();
});

await test('5. Snake Hook, Clay Strips & Crease strokes + SculptCommand Undo/Redo round-trip', () => {
  const geom = new THREE.SphereGeometry(1, 24, 16);
  const mesh = new THREE.Mesh(geom, new THREE.MeshStandardMaterial());
  const sm = createMockSceneManager();
  const sculpt = new SculptMode(createMockEngine(), { sceneManager: sm });
  sculpt.enter(mesh);
  sculpt.setSymmetry(false);
  sculpt.setRadius(0.5);
  sculpt.setStrength(0.6);

  const initialPos = new Float32Array(geom.attributes.position.array);

  sculpt.setBrush('snake_hook');
  sculpt.applyStroke({
    point: new THREE.Vector3(0, 1, 0),
    face: { normal: new THREE.Vector3(0, 1, 0) },
    object: mesh
  }, { delta: new THREE.Vector3(0.4, 0.3, 0), recordUndo: true });

  const afterHookPos = new Float32Array(geom.attributes.position.array);
  let movedMax = 0;
  for (let i = 0; i < initialPos.length; i++) movedMax = Math.max(movedMax, Math.abs(afterHookPos[i] - initialPos[i]));
  assert.ok(movedMax > 0.1, `Snake Hook should pull vertices significantly (${movedMax})`);

  sculpt.setBrush('clay');
  sculpt.applyStroke({
    point: new THREE.Vector3(1, 0, 0),
    face: { normal: new THREE.Vector3(1, 0, 0) },
    object: mesh
  }, { recordUndo: true });

  sculpt.setBrush('crease');
  sculpt.applyStroke({
    point: new THREE.Vector3(0, 0, 1),
    face: { normal: new THREE.Vector3(0, 0, 1) },
    object: mesh
  }, { recordUndo: true });

  assert.equal(sm.undo(), true);
  assert.equal(sm.undo(), true);
  assert.equal(sm.undo(), true);

  const afterUndo = geom.attributes.position.array;
  for (let i = 0; i < initialPos.length; i++) {
    assert.ok(Math.abs(afterUndo[i] - initialPos[i]) < 1e-6, 'Undo must restore exact initial vertex positions');
  }

  assert.equal(sm.redo(), true);
  const afterRedoHook = geom.attributes.position.array;
  for (let i = 0; i < afterHookPos.length; i++) {
    assert.ok(Math.abs(afterRedoHook[i] - afterHookPos[i]) < 1e-6, 'Redo must restore exact Snake Hook vertex positions');
  }

  sculpt.exit();
});

await test('6. Rust WASM Voxel Remesh densifies coarse BoxGeometry + SculptRemeshCommand Undo/Redo', () => {
  const box = new THREE.BoxGeometry(2, 2, 2);
  const origVertCount = box.attributes.position.count;
  const origTriCount = box.index.count / 3;
  assert.equal(origTriCount, 12);

  const mesh = new THREE.Mesh(box, new THREE.MeshStandardMaterial());
  const sm = createMockSceneManager();
  const sculpt = new SculptMode(createMockEngine(), { sceneManager: sm });
  sculpt.enter(mesh);

  const ok = sculpt.voxelRemesh(0.45);
  assert.equal(ok, true, 'voxelRemesh should succeed');

  const remeshedGeom = mesh.geometry;
  const remeshedTris = remeshedGeom.index.count / 3;
  assert.ok(remeshedTris > 100, `Expected remeshed cube > 100 tris, got ${remeshedTris}`);
  assertAllFinite(remeshedGeom.attributes.position.array, 'remesh vertices');
  assertAllFinite(remeshedGeom.attributes.normal.array, 'remesh normals');
  assert.ok(remeshedGeom.boundsTree, 'remeshed geometry must rebuild BVH');

  // Undo restores exact coarse BoxGeometry
  assert.equal(sm.undo(), true);
  assert.equal(mesh.geometry.attributes.position.count, origVertCount);
  assert.equal(mesh.geometry.index.count / 3, 12);

  // Redo restores remeshed geometry
  assert.equal(sm.redo(), true);
  assert.equal(mesh.geometry.index.count / 3, remeshedTris);

  sculpt.exit();
});

await test('7. Exit SculptMode restores material.vertexColors and cleans transient color attribute', () => {
  const mat = new THREE.MeshStandardMaterial({ color: 0xd2d5da });
  assert.equal(mat.vertexColors, false);

  const geom = new THREE.SphereGeometry(1, 16, 12);
  const mesh = new THREE.Mesh(geom, mat);
  const sculpt = new SculptMode(createMockEngine(), { sceneManager: createMockSceneManager() });

  assert.equal(sculpt.enter(mesh), true);
  assert.equal(mat.vertexColors, true, 'Sculpt mode activates vertexColors for mask display');
  assert.ok(geom.attributes.color, 'Transient vertex color attribute exists during Sculpt mode');

  sculpt.exit();
  assert.equal(sculpt.isActive, false);
  assert.equal(mat.vertexColors, false, 'Exit must restore original material.vertexColors');
  assert.equal(geom.attributes.color, undefined, 'Exit removes transient mask color attribute');
});

await test('8. Indirect BVH shapecast collects candidates accurately around sculpt hit point', () => {
  const geom = new THREE.SphereGeometry(1, 32, 24);
  const mesh = new THREE.Mesh(geom, new THREE.MeshStandardMaterial());
  const origPos = new Float32Array(geom.attributes.position.array);
  const sculpt = new SculptMode(createMockEngine(), { sceneManager: createMockSceneManager() });
  assert.equal(sculpt.enter(mesh), true);
  assert.equal(geom.boundsTree?.indirect, true, 'SculptMode BVH should keep indirect:true');

  sculpt.setBrush('draw');
  sculpt.setRadius(0.45);
  sculpt.setStrength(0.6);
  sculpt.setSymmetry(false);

  const hitPt = new THREE.Vector3(-0.25, 0.45, 0.7).normalize();
  const touched = sculpt.applyStroke({
    point: hitPt,
    face: { normal: hitPt.clone() },
    object: mesh,
  });
  assert.ok(touched > 5, `Expected > 5 touched vertices near sculpt hit, got ${touched}`);

  const pos = geom.attributes.position.array;
  let maxNearDisp = 0;
  for (let i = 0; i < pos.length; i += 3) {
    const distToHit = Math.hypot(origPos[i] - hitPt.x, origPos[i + 1] - hitPt.y, origPos[i + 2] - hitPt.z);
    if (distToHit < 0.15) {
      const disp = Math.hypot(pos[i] - origPos[i], pos[i + 1] - origPos[i + 1], pos[i + 2] - origPos[i + 2]);
      if (disp > maxNearDisp) maxNearDisp = disp;
    }
  }
  assert.ok(maxNearDisp > 0.02, `Expected displacement > 0.02 near hit point, got ${maxNearDisp}`);
  sculpt.exit();
});

if (failures.length > 0) {
  console.error(`\n${failures.length} Sculpt 2.0 test(s) FAILED.`);
  process.exit(1);
}
console.log('\nAll 8 Sculpt Mode 2.0 tests PASSED.');
