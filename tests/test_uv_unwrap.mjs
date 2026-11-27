/**
 * Blender-Standard UV Pipeline Tests:
 * - EditMode Mark Seam / Clear Seam persistence across geometry rebuild & Undo/Redo
 * - True LSCM conformal unwrapping with seam cuts and vertex pinning
 * - Smart UV Project (angle clustering + zero-overlap island packing)
 * - Cube / Cylinder / Sphere projections (+/-pi wraparound fix) & Reset UVs
 * - Average Islands Scale (texel density equalization) & 2D Shelf Pack Islands
 * - Per-triangle UV Stretch metrics (Angle & Area distortion)
 *
 * Run: node --import ./tests/three-resolve-hooks.mjs tests/test_uv_unwrap.mjs
 */
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { SceneManager } from '../js/core/scene-manager.js';
import { EditMode } from '../js/core/edit-mode.js';
import {
  pointSpatialKey,
  edgeSpatialKey,
  extractUVIslandsFromGeometry,
  averageIslandsScaleInPlace,
  packUVIslandsInPlace,
  unwrapMeshLSCM,
  smartUVProjectGeometry,
  cubeProjectGeometry,
  cylinderProjectGeometry,
  sphereProjectGeometry,
  resetUVsGeometry,
  computeUVStretch
} from '../js/core/geometry/uv-unwrap.js';

const failures = [];
async function test(name, fn) {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (err) {
    failures.push(name);
    console.error(`✗ ${name}\n  ${err.stack || err.message}`);
  }
}

function createHarness() {
  const scene = new THREE.Scene();
  const sm = new SceneManager(scene);
  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
  camera.position.set(0, 3, 6);
  camera.lookAt(0, 0, 0);
  const mockEngine = {
    scene,
    sceneManager: sm,
    camera,
    domElement: null,
    transformControls: null,
    snapEnabled: false,
    pivotMode: 'median',
    updateSelectionHelper() {},
    updateActiveGizmo() {}
  };
  const editMode = new EditMode(mockEngine, { sceneManager: sm });
  return { scene, sm, editMode };
}

function islandsOverlap(a, b, eps = 1e-4) {
  return (
    a.maxU > b.minU + eps &&
    b.maxU > a.minU + eps &&
    a.maxV > b.minV + eps &&
    b.maxV > a.minV + eps
  );
}

function combineNonIndexedPlanes(geoms) {
  const positions = [];
  const uvs = [];
  for (const g of geoms) {
    const nonIdx = g.index ? g.toNonIndexed() : g;
    const pos = nonIdx.attributes.position;
    const uv = nonIdx.attributes.uv;
    for (let i = 0; i < pos.count; i++) {
      positions.push(pos.getX(i), pos.getY(i), pos.getZ(i));
      uvs.push(uv ? uv.getX(i) : 0, uv ? uv.getY(i) : 0);
    }
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3));
  out.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(uvs), 2));
  out.computeVertexNormals();
  return out;
}

// ---------------------------------------------------------------------------
// 1. EDIT MODE MARK / CLEAR SEAM + REBUILD + UNDO / REDO
// ---------------------------------------------------------------------------
await test('EditMode Mark/Clear Seam persists across rebuildGeometry and Undo/Redo', async () => {
  const { sm, editMode } = createHarness();
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(1, 1, 1),
    new THREE.MeshStandardMaterial({ color: 0xcccccc })
  );
  sm.addObject(mesh);
  editMode.enter(mesh);

  assert.equal(editMode.faces.length, 6);
  editMode.setMode('edge');
  editMode.selectedEdges.clear();
  editMode.selectedEdges.add(0);
  editMode.selectedEdges.add(1);

  assert.equal(editMode.markSeam(false), true, 'markSeam should return true');
  assert.equal(editMode.uvSeams.size, 2, 'Two UV seams must be stored');
  assert.equal(mesh.geometry.userData._uvSeams?.length, 2, 'Seams must persist to geometry.userData._uvSeams');

  // Rebuild geometry preserves seams & selectSeams finds them
  editMode.rebuildGeometry();
  assert.equal(editMode.uvSeams.size, 2);
  assert.equal(editMode.selectSeams(), 2, 'selectSeams must select both marked seam edges');

  // Clear one seam
  editMode.selectedEdges.clear();
  editMode.selectedEdges.add(0);
  assert.equal(editMode.clearSeam(), true);
  assert.equal(editMode.uvSeams.size, 1, 'One seam should remain after clearing edge 0');

  // Undo restores 2 seams; Redo goes back to 1 seam
  sm.undo();
  assert.equal(editMode.uvSeams.size, 2, 'Undo should restore 2 seams');
  sm.redo();
  assert.equal(editMode.uvSeams.size, 1, 'Redo should return to 1 seam');
});

// ---------------------------------------------------------------------------
// 2. TRUE LSCM UNWRAP: WARPED MESH, PINNING & SEAM SPLITTING
// ---------------------------------------------------------------------------
await test('unwrapMeshLSCM produces low-distortion conformal UVs, respects pins, and splits along seams', async () => {
  // Part A: Warped open surface with 2 pinned corners (pack: false to verify exact pin coordinates)
  const grid = new THREE.PlaneGeometry(4, 2, 4, 2);
  const pos = grid.attributes.position;
  let minIdx = 0;
  let maxIdx = 0;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = Math.sin(x * 0.7) * 0.35 + Math.cos(y * 0.8) * 0.25;
    pos.setZ(i, z);
    if (x < pos.getX(minIdx) || (x === pos.getX(minIdx) && y < pos.getY(minIdx))) minIdx = i;
    if (x > pos.getX(maxIdx) || (x === pos.getX(maxIdx) && y > pos.getY(maxIdx))) maxIdx = i;
  }

  const pStartKey = pointSpatialKey(pos.getX(minIdx), pos.getY(minIdx), pos.getZ(minIdx));
  const pEndKey = pointSpatialKey(pos.getX(maxIdx), pos.getY(maxIdx), pos.getZ(maxIdx));
  const pinnedMap = new Map([
    [pStartKey, [0.1, 0.2]],
    [pEndKey, [0.9, 0.8]]
  ]);

  const solvedPinned = unwrapMeshLSCM(grid, { pinnedMap, pack: false });
  const uvPinned = solvedPinned.attributes.uv;
  const posSolved = solvedPinned.attributes.position;

  let foundPinStart = false;
  let foundPinEnd = false;
  for (let i = 0; i < posSolved.count; i++) {
    const u = uvPinned.getX(i);
    const v = uvPinned.getY(i);
    assert.ok(Number.isFinite(u) && Number.isFinite(v), 'LSCM UVs must be finite');
    const pk = pointSpatialKey(posSolved.getX(i), posSolved.getY(i), posSolved.getZ(i));
    if (pk === pStartKey) {
      assert.ok(Math.hypot(u - 0.1, v - 0.2) < 1e-3, `Pinned start vertex drifted: (${u}, ${v})`);
      foundPinStart = true;
    }
    if (pk === pEndKey) {
      assert.ok(Math.hypot(u - 0.9, v - 0.8) < 1e-3, `Pinned end vertex drifted: (${u}, ${v})`);
      foundPinEnd = true;
    }
  }
  assert.ok(foundPinStart && foundPinEnd, 'Both pinned vertices must exist in output');

  const stretch = computeUVStretch(solvedPinned, 'angle');
  const avgStretch = stretch.reduce((a, b) => a + b, 0) / stretch.length;
  assert.ok(avgStretch < 0.25, `LSCM angle stretch should stay low, got ${avgStretch}`);

  // Part B: Splitting a flat 2x2 grid down x=0 creates 2 separate UV islands
  const splitGrid = new THREE.PlaneGeometry(2, 2, 2, 2);
  const seamKeys = new Set([
    edgeSpatialKey(0, -1, 0, 0, 0, 0),
    edgeSpatialKey(0, 0, 0, 0, 1, 0)
  ]);
  const splitOut = unwrapMeshLSCM(splitGrid, { seamKeys, margin: 0.02 });
  const islands = extractUVIslandsFromGeometry(splitOut);
  assert.equal(islands.length, 2, `Expected 2 UV islands across seam cut, got ${islands.length}`);
  assert.equal(islandsOverlap(islands[0], islands[1]), false, 'Split islands must be packed without overlap');
});

// ---------------------------------------------------------------------------
// 3. SMART UV PROJECT: ANGLE ISLAND CLUSTERING + ZERO-OVERLAP PACKING
// ---------------------------------------------------------------------------
await test('smartUVProjectGeometry splits BoxGeometry into 6 non-overlapping islands in [0, 1]^2', async () => {
  const box = new THREE.BoxGeometry(2, 1.5, 1);
  const projected = smartUVProjectGeometry(box, { angleLimitDeg: 66, margin: 0.02 });
  const uv = projected.attributes.uv;
  assert.ok(uv && uv.count > 0);

  for (let i = 0; i < uv.count; i++) {
    const u = uv.getX(i);
    const v = uv.getY(i);
    assert.ok(u >= 0.015 && u <= 0.985 && v >= 0.015 && v <= 0.985, `UV (${u}, ${v}) outside padded [0,1]^2`);
  }

  const islands = extractUVIslandsFromGeometry(projected);
  assert.equal(islands.length, 6, `BoxGeometry should yield 6 islands, got ${islands.length}`);
  for (let i = 0; i < islands.length; i++) {
    for (let j = i + 1; j < islands.length; j++) {
      assert.equal(
        islandsOverlap(islands[i], islands[j]),
        false,
        `Islands ${i} and ${j} must not overlap`
      );
    }
  }
});

// ---------------------------------------------------------------------------
// 4. CUBE / CYLINDER / SPHERE PROJECTIONS (+/-pi WRAP FIX) & RESET
// ---------------------------------------------------------------------------
await test('Cube, Cylinder, Sphere (+/-pi wraparound fix) and Reset projections produce valid UVs', async () => {
  // Cylinder without seam overlap artifact across +/-pi meridian
  const cyl = new THREE.CylinderGeometry(1, 1, 2, 16, 1, true);
  const cylProj = cylinderProjectGeometry(cyl);
  const cylUv = cylProj.attributes.uv;
  const cylIdx = cylProj.index;
  const cylTriCount = Math.floor(cylIdx.count / 3);
  for (let t = 0; t < cylTriCount; t++) {
    const a = cylIdx.getX(t * 3);
    const b = cylIdx.getX(t * 3 + 1);
    const c = cylIdx.getX(t * 3 + 2);
    const us = [cylUv.getX(a), cylUv.getX(b), cylUv.getX(c)];
    const spanU = Math.max(...us) - Math.min(...us);
    assert.ok(spanU < 0.4, `Cylinder triangle ${t} crossed seam without wrap fix (spanU=${spanU})`);
  }

  // Sphere projection
  const sphere = new THREE.SphereGeometry(1, 16, 12);
  const sphProj = sphereProjectGeometry(sphere);
  const sphUv = sphProj.attributes.uv;
  for (let i = 0; i < sphUv.count; i++) {
    assert.ok(Number.isFinite(sphUv.getX(i)) && Number.isFinite(sphUv.getY(i)));
    assert.ok(sphUv.getY(i) >= -1e-4 && sphUv.getY(i) <= 1.0001);
  }

  // Cube projection
  const boxProj = cubeProjectGeometry(new THREE.BoxGeometry(1, 2, 3), { pack: true });
  assert.ok(extractUVIslandsFromGeometry(boxProj).length >= 6);

  // Reset UVs
  const reset = resetUVsGeometry(new THREE.PlaneGeometry(2, 2, 1, 1));
  const rUv = reset.attributes.uv;
  for (let i = 0; i < rUv.count; i++) {
    assert.ok((rUv.getX(i) === 0 || rUv.getX(i) === 1) && (rUv.getY(i) === 0 || rUv.getY(i) === 1));
  }
});

// ---------------------------------------------------------------------------
// 5. AVERAGE ISLANDS SCALE & 2D PACK ISLANDS
// ---------------------------------------------------------------------------
await test('averageIslandsScaleInPlace equalizes texel density and packUVIslandsInPlace eliminates overlap', async () => {
  const smallPlane = new THREE.PlaneGeometry(1, 1);
  const largePlane = new THREE.PlaneGeometry(4, 4);
  largePlane.translate(10, 0, 0);

  // Both planes initially occupy identical [0,1]^2 UV (16x texel density difference, completely overlapping!)
  const combined = combineNonIndexedPlanes([smallPlane, largePlane]);
  assert.equal(averageIslandsScaleInPlace(combined), true);

  const afterAvg = extractUVIslandsFromGeometry(combined);
  assert.equal(afterAvg.length, 2);
  const ratio0 = afterAvg[0].uvArea / afterAvg[0].area3D;
  const ratio1 = afterAvg[1].uvArea / afterAvg[1].area3D;
  const relDiff = Math.abs(ratio0 - ratio1) / Math.max(ratio0, ratio1);
  assert.ok(relDiff < 1e-3, `Texel densities should equalize cleanly, got diff=${relDiff}`);

  assert.equal(packUVIslandsInPlace(combined, { margin: 0.03, rotate: true, averageScale: true }), true);
  const packed = extractUVIslandsFromGeometry(combined);
  assert.equal(packed.length, 2);
  assert.equal(islandsOverlap(packed[0], packed[1]), false, 'Packed islands must not overlap');
  for (const isl of packed) {
    assert.ok(isl.minU >= 0.029 && isl.maxU <= 0.971 && isl.minV >= 0.029 && isl.maxV <= 0.971);
  }
});

// ---------------------------------------------------------------------------
// 6. COMPUTE UV STRETCH (ANGLE & AREA)
// ---------------------------------------------------------------------------
await test('computeUVStretch distinguishes undistorted quad from sheared triangle', async () => {
  const unitQuad = new THREE.PlaneGeometry(1, 1);
  const angleZero = computeUVStretch(unitQuad, 'angle');
  const areaZero = computeUVStretch(unitQuad, 'area');
  assert.ok(angleZero[0] < 0.02 && areaZero[0] < 0.02, 'Unit plane should have ~0 stretch');

  const sheared = new THREE.PlaneGeometry(1, 1);
  const uv = sheared.attributes.uv;
  // Squash U dramatically while stretching V at vertex 1
  uv.setXY(1, 0.02, 4.0);
  uv.needsUpdate = true;
  const angleHigh = computeUVStretch(sheared, 'angle');
  const areaHigh = computeUVStretch(sheared, 'area');
  assert.ok(angleHigh[0] > 0.35, `Expected high angle stretch, got ${angleHigh[0]}`);
  assert.ok(areaHigh[0] > 0.35, `Expected high area stretch, got ${areaHigh[0]}`);
});

// ---------------------------------------------------------------------------
// 7. EDITMODE UNWRAP INTEGRATION + UNDO / REDO
// ---------------------------------------------------------------------------
await test('EditMode.unwrap integrates with SceneManager Undo/Redo cleanly', async () => {
  const { sm, editMode } = createHarness();
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(1, 2, 1),
    new THREE.MeshStandardMaterial({ color: 0xdddddd })
  );
  sm.addObject(mesh);
  editMode.enter(mesh);

  // Start with reset UVs so Smart UV clearly changes UV islands
  editMode.unwrap('reset');
  assert.ok(mesh.geometry.attributes.uv.count > 0);
  const preSmartCount = extractUVIslandsFromGeometry(mesh.geometry).length;

  assert.equal(editMode.unwrap('smart', { angleLimitDeg: 66 }), true);
  assert.equal(extractUVIslandsFromGeometry(mesh.geometry).length, 6, 'Smart UV inside EditMode should produce 6 islands');

  sm.undo();
  assert.equal(
    extractUVIslandsFromGeometry(mesh.geometry).length,
    preSmartCount,
    'Undo must restore previous UV islands'
  );
  sm.redo();
  assert.equal(extractUVIslandsFromGeometry(mesh.geometry).length, 6, 'Redo must restore 6 UV islands');
  editMode.exit();
});

if (failures.length > 0) {
  console.error(`\nFAILED ${failures.length} test(s): ${failures.join(', ')}`);
  process.exit(1);
} else {
  console.log('\nALL UV UNWRAP & SEAM TESTS PASSED');
}
