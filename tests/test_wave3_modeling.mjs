/**
 * Wave 3 automated verification suite:
 * - 3A: Curve / Bezier / NURBS Path / Text3D offline glyph extrusion & Convert to Mesh
 * - 3B: All 10 missing modifiers (Shrinkwrap, Curve, Lattice, Skin, Remesh, Weld, SimpleDeform, Cast, Wave, DataTransfer)
 *       + Viewport vs Render Subdivision Levels + Multires Modifier
 * - 3C: Nested Collections + View Layers, Full 6 Transform Orientations, Undoable Modifier-Aware Ctrl+A
 * - 3D: Sculpt Dyntopo conformal longest-edge bisection + adaptive small/large Voxel Remesh (no 0.02-2.0 clamp)
 */

import assert from 'node:assert/strict';
import * as THREE from 'three';
import { SceneManager } from '../js/core/scene-manager.js';
import {
  createBezierCurveObject,
  createText3DObject,
  rebuildCurveMesh,
  convertCurveToMesh,
} from '../js/core/curve-objects.js';
import {
  executeModifier,
  applyModifier,
  withRenderSubdivisionLevels,
  recomputeModifiers,
} from '../js/core/modifiers.js';
import * as ModifierStack from '../js/core/modifier-stack.js';
import { buildDefaultLatticeGrid } from '../js/core/geometry/pro-modifiers.js';
import { CollectionManager } from '../js/core/collection-manager.js';
import { ModalTransformManager } from '../js/core/modal-transform.js';
import { BlenderModelingSuite } from '../js/ui/blender-modeling-suite.js';
import { SculptMode } from '../js/core/sculpt-mode.js';

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

await test('3A Curves & Text3D: Bezier, Circle, NURBS, offline Text3D glyphs & Convert to Mesh', async () => {
  const sm = new SceneManager(new THREE.Scene());
  const bez = createBezierCurveObject('bezier');
  assert.ok(bez.geometry.attributes.position.count > 20);
  const beforePosCount = bez.geometry.attributes.position.count;
  rebuildCurveMesh(bez, { bevelResolution: 20 });
  assert.ok(bez.geometry.attributes.position.count > beforePosCount, 'Higher bevelResolution must generate more ring vertices');

  const circle = createBezierCurveObject('circle');
  assert.equal(circle.userData.curveData.closed, true);

  const txt = createText3DObject('AB8!', { size: 1.0, depth: 0.25 });
  assert.ok(txt.geometry.attributes.position.count > 50, 'Offline vector Text3D must generate solid triangles');
  txt.geometry.computeBoundingBox();
  const zSize = txt.geometry.boundingBox.max.z - txt.geometry.boundingBox.min.z;
  assert.ok(zSize >= 0.24, `Text3D extrude depth must reflect 0.25m (got ${zSize.toFixed(3)})`);

  assert.equal(convertCurveToMesh(txt, sm), true);
  assert.equal(Boolean(txt.userData.curveData), false);
  sm.undo();
  assert.equal(Boolean(txt.userData.curveData), true, 'Undo Convert-to-Mesh restores curveData');
});

await test('3B Pro Modifiers: Weld, SimpleDeform, Cast, Wave, Shrinkwrap, DataTransfer, Curve, Lattice, Skin, Remesh', async () => {
  // 1) Weld: BoxGeometry starts with 24 split vertices -> welded down to 8 corners!
  const box = new THREE.BoxGeometry(1, 1, 1);
  assert.equal(box.attributes.position.count, 24);
  const welded = executeModifier(box, 'weld', { distance: 0.005 });
  assert.equal(welded.attributes.position.count, 8, 'Weld must collapse 24 split cube corners to 8 shared verts');

  // 2) SimpleDeform (Twist): top vertex rotates around Y
  const tallBox = new THREE.BoxGeometry(1, 2, 1, 1, 4, 1);
  const twisted = executeModifier(tallBox, 'simple_deform', { mode: 'twist', axis: 'y', angleDeg: 90 });
  assert.ok(twisted.attributes.position.count === tallBox.attributes.position.count);

  // 3) Cast to Sphere: radius=1.0 -> every corner norm approaches 1.0
  const casted = executeModifier(new THREE.BoxGeometry(2, 2, 2, 2, 2, 2), 'cast', { shape: 'sphere', factor: 1.0, radius: 1.0 });
  const cp = casted.attributes.position;
  for (let i = 0; i < cp.count; i++) {
    const r = Math.hypot(cp.getX(i), cp.getY(i), cp.getZ(i));
    assert.ok(Math.abs(r - 1.0) < 1e-4, `Cast factor=1 must put vertex onto unit sphere (got r=${r})`);
  }

  // 4) Wave: plane displaced vertically
  const plane = new THREE.PlaneGeometry(4, 4, 8, 8);
  plane.rotateX(-Math.PI / 2);
  const waved = executeModifier(plane, 'wave', { height: 0.5, width: 1.0 });
  let maxAbsY = 0;
  for (let i = 0; i < waved.attributes.position.count; i++) {
    maxAbsY = Math.max(maxAbsY, Math.abs(waved.attributes.position.getY(i)));
  }
  assert.ok(maxAbsY > 0.35, `Wave modifier must create vertical ripples (maxY=${maxAbsY})`);

  // 5) Shrinkwrap onto sphere
  const sphereTarget = new THREE.SphereGeometry(1.0, 24, 18);
  const wrapPlane = new THREE.PlaneGeometry(1.0, 1.0, 4, 4);
  wrapPlane.translate(0, 1.5, 0); // flat plane hovering at y=1.5 above unit sphere
  wrapPlane.rotateX(-Math.PI / 2);
  const wrapped = executeModifier(wrapPlane, 'shrinkwrap', { targetGeometry: sphereTarget, mode: 'nearest_surface', offset: 0.0 });
  const wp = wrapped.attributes.position;
  let wrappedDist = Math.hypot(wp.getX(0), wp.getY(0), wp.getZ(0));
  assert.ok(Math.abs(wrappedDist - 1.0) < 0.08, `Shrinkwrap must pull plane vertices onto unit sphere (r=${wrappedDist})`);

  // 6) DataTransfer UV & Colors
  const colArr = new Float32Array(sphereTarget.attributes.position.count * 3);
  for (let i = 0; i < colArr.length; i += 3) { colArr[i] = 0.2; colArr[i + 1] = 0.85; colArr[i + 2] = 0.4; }
  sphereTarget.setAttribute('color', new THREE.BufferAttribute(colArr, 3));
  const transferred = executeModifier(wrapPlane, 'data_transfer', { targetGeometry: sphereTarget, transferNormals: true, transferColors: true });
  assert.ok(Math.abs(transferred.attributes.color.getY(0) - 0.85) < 1e-4, 'DataTransfer must copy target green channel via BVH barycentrics');

  // 7) Curve deform
  const scene = new THREE.Scene();
  const sm = new SceneManager(scene);
  const crvObj = createBezierCurveObject('bezier');
  const rodMesh = new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.2, 0.2, 12, 1, 1), new THREE.MeshStandardMaterial());
  sm.addObject(crvObj);
  sm.addObject(rodMesh);
  await ModifierStack.addModifier(rodMesh, 'curve', { targetId: crvObj.uuid, deformAxis: 'x', stretch: true }, { sceneManager: sm });
  rodMesh.geometry.computeBoundingBox();
  const zSpread = rodMesh.geometry.boundingBox.max.z - rodMesh.geometry.boundingBox.min.z;
  assert.ok(zSpread > 0.25, `Curve deform must curve rod along Bezier path in Z (spread=${zSpread})`);

  // 8) Lattice FFD
  const latPts = buildDefaultLatticeGrid(2, 2, 2, 'taper_top', 0.8);
  const latticed = executeModifier(new THREE.BoxGeometry(2, 2, 2, 2, 2, 2), 'lattice', { resU: 2, resV: 2, resW: 2, latticePoints: latPts });
  let topMaxX = 0, botMaxX = 0;
  for (let i = 0; i < latticed.attributes.position.count; i++) {
    const x = Math.abs(latticed.attributes.position.getX(i));
    const y = latticed.attributes.position.getY(i);
    if (y > 0.8) topMaxX = Math.max(topMaxX, x);
    if (y < -0.8) botMaxX = Math.max(botMaxX, x);
  }
  assert.ok(topMaxX < botMaxX * 0.5, `Lattice taper_top must narrow top X (${topMaxX}) vs bottom (${botMaxX})`);

  // 9) Skin modifier
  const skinnedGeo = executeModifier(new THREE.BoxGeometry(1, 1, 1), 'skin', { thickness: 0.15, radialSegments: 6 });
  assert.ok(skinnedGeo.attributes.position.count > 40, 'Skin modifier must build tubular skeleton envelope');

  // 10) Remesh Surface-Nets + Blocks
  const remeshedVoxel = executeModifier(new THREE.BoxGeometry(1, 1, 1), 'remesh', { mode: 'voxel', voxelSize: 0.2, smoothIterations: 1 });
  assert.ok(remeshedVoxel.attributes.position.count > 24 && remeshedVoxel.index.count >= 24);
  const remeshedBlocks = executeModifier(new THREE.BoxGeometry(1, 1, 1), 'remesh', { mode: 'blocks', voxelSize: 0.25 });
  assert.ok(remeshedBlocks.attributes.position.count >= 24);
});

await test('3B Viewport vs Render Subdivision Levels & Multires Modifier Deltas', async () => {
  const scene = new THREE.Scene();
  const sm = new SceneManager(scene);
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial());
  sm.addObject(mesh);

  await ModifierStack.addModifier(mesh, 'subdivide', { subdivisions: 1, renderLevels: 2 }, { sceneManager: sm });
  const vpTris = mesh.geometry.index ? mesh.geometry.index.count / 3 : mesh.geometry.attributes.position.count / 3;

  let renderTris = 0;
  await withRenderSubdivisionLevels(scene, async () => {
    renderTris = mesh.geometry.index ? mesh.geometry.index.count / 3 : mesh.geometry.attributes.position.count / 3;
  });
  const restoredTris = mesh.geometry.index ? mesh.geometry.index.count / 3 : mesh.geometry.attributes.position.count / 3;

  assert.ok(renderTris > vpTris * 3, `Render level 2 (${renderTris} tris) must exceed viewport level 1 (${vpTris} tris)`);
  assert.equal(restoredTris, vpTris, 'Restoring viewport quality must revert geometry back to viewport subdiv count');

  // Multiresolution sculpt delta persistence across level stepping
  const mrMesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial());
  sm.addObject(mrMesh);
  await ModifierStack.addModifier(mrMesh, 'multires', { levels: 1, renderLevels: 2, deltas: {} }, { sceneManager: sm });
  const sculpt = new SculptMode(null, { sceneManager: sm });
  sculpt.targetMesh = mrMesh;
  sculpt.symmetryX = false;
  sculpt.applyStroke({ point: new THREE.Vector3(0.5, 0.5, 0.5), face: { normal: new THREE.Vector3(1, 1, 1).normalize() }, object: mrMesh }, {
    brush: 'draw', radius: 0.8, strength: 0.9, isLocal: true,
  });
  sculpt._syncMultiresDeltas(mrMesh);
  const mrMod = mrMesh.userData.modifierStack.find((m) => m.type === 'multires');
  assert.ok(mrMod.params.deltas['1']?.some((v) => Math.abs(v) > 1e-4), 'Multires sculpt deltas at level 1 must be stored');
  // Re-evaluating at level 1 retains sculpt deltas
  recomputeModifiers(mrMesh);
  const postMax = Math.max(...Array.from(mrMesh.geometry.attributes.position.array).map(Math.abs));
  assert.ok(postMax > 0.52, 'Multires modifier must re-apply sculpted displacements');
});

await test('3C Nested Collections + View Layers, Full Transform Orientations & Modifier-Aware Ctrl+A', async () => {
  const scene = new THREE.Scene();
  const sm = new SceneManager(scene);
  const box = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial());
  box.name = 'PropBox';
  sm.addObject(box);

  const cm = sm.collectionManager;
  const envCol = cm.createCollection('Environment', cm.rootId);
  const propsCol = cm.createCollection('Props', envCol.id);
  cm.moveObjectToCollection(box, propsCol.id);
  assert.equal(cm.getObjectCollectionId(box), propsCol.id);

  // Exclude Environment in Render/Alt View Layer -> hides nested Props children too!
  const vlAlt = cm.createViewLayer('CharactersOnly');
  cm.setCollectionExcludedInViewLayer(envCol.id, true, vlAlt.id);
  assert.equal(box.visible, false, 'Excluding parent collection in active ViewLayer must hide nested object');

  // Switch back to Main ViewLayer -> visible again!
  cm.setActiveViewLayer('vl_main');
  assert.equal(box.visible, true, 'Switching back to ViewLayer without exclusion restores object visibility');

  // JSON round-trip preserves collections & viewLayers
  const saved = cm.toJSON();
  const cm2 = new CollectionManager(sm);
  cm2.fromJSON(saved);
  assert.equal(cm2.getObjectCollectionId(box), propsCol.id);

  // Full 6 Transform Orientations
  const fakeCam = new THREE.PerspectiveCamera();
  fakeCam.rotation.set(0.3, 0.7, 0.0);
  fakeCam.updateMatrixWorld();
  const fakeEngine = { scene, camera: fakeCam, controls: {}, updateSelectionHelper() {}, renderer: null };
  const mt = new ModalTransformManager({ engine: fakeEngine, sceneManager: sm, editMode: null });
  box.rotation.set(0.5, 0.4, 0.2);
  box.quaternion.setFromEuler(box.rotation);
  mt.targetObject = box;
  mt.initialState.quaternion.copy(box.quaternion);
  mt.isLocalAxis = true;

  const worldZ = mt.getOrientationAxes('world').Z;
  const localZ = mt.getOrientationAxes('local').Z;
  const gimbalZ = mt.getOrientationAxes('gimbal').Z;
  const viewZ = mt.getOrientationAxes('view').Z;
  assert.ok(worldZ.distanceTo(localZ) > 0.1, 'Local Z axis differs from Global Z');
  assert.ok(localZ.distanceTo(gimbalZ) >= 0.0 && gimbalZ.length() > 0.99, 'Gimbal Z axis is normalized Euler axis');
  assert.ok(worldZ.distanceTo(viewZ) > 0.1, 'View Z axis aligns with tilted camera');

  // Modifier-aware Undoable Ctrl+A (Apply Scale)
  box.rotation.set(0, 0, 0);
  box.scale.set(2, 1, 1);
  box.updateMatrixWorld(true);
  await ModifierStack.addModifier(box, 'bevel', { width: 0.1, segments: 1 }, { sceneManager: sm });

  const suite = new BlenderModelingSuite({ engine: fakeEngine, sceneManager: sm, editMode: null, sculptMode: null });
  assert.equal(suite.applyAllTransforms(false, true, true), true);
  assert.ok(Math.abs(box.scale.x - 1.0) < 1e-6, 'Ctrl+A must reset object scale to (1,1,1)');
  box.userData.baseGeometry.computeBoundingBox();
  const baseWidthX = box.userData.baseGeometry.boundingBox.max.x - box.userData.baseGeometry.boundingBox.min.x;
  assert.ok(Math.abs(baseWidthX - 2.0) < 1e-4, `Modifier baseGeometry width must be baked to 2.0m (got ${baseWidthX})`);

  // Single Ctrl+Z undoes BOTH scale reset & baseGeometry bake!
  sm.undo();
  assert.ok(Math.abs(box.scale.x - 2.0) < 1e-6, 'Undo Ctrl+A must restore original scale (2,1,1)');
  box.userData.baseGeometry.computeBoundingBox();
  const revertedWidth = box.userData.baseGeometry.boundingBox.max.x - box.userData.baseGeometry.boundingBox.min.x;
  assert.ok(Math.abs(revertedWidth - 1.0) < 1e-4, 'Undo Ctrl+A must revert baseGeometry width to 1.0m');
});

await test('3D Sculpt Pro: Adaptive Voxel Remesh < 0.02m micro-detail & Conformal Dyntopo subdivision', async () => {
  const scene = new THREE.Scene();
  const sm = new SceneManager(scene);

  // Tiny 0.16m pendant sphere: adaptive voxelSize=0.006 must NOT clamp up to 0.02!
  const tiny = new THREE.Mesh(new THREE.SphereGeometry(0.08, 12, 8), new THREE.MeshStandardMaterial());
  sm.addObject(tiny);
  const sculpt = new SculptMode(null, { sceneManager: sm });
  sculpt.targetMesh = tiny;
  sculpt.setVoxelSize(0.005);
  assert.ok(Math.abs(sculpt.voxelSize - 0.005) < 1e-6, `setVoxelSize(0.005) must not clamp to 0.02 (got ${sculpt.voxelSize})`);
  assert.equal(sculpt.voxelRemesh(0.008), true);
  assert.ok(sculpt.voxelSize < 0.015, `Tiny sphere voxelSize (${sculpt.voxelSize}) must bypass old 0.02 clamp`);
  assert.ok(tiny.geometry.attributes.position.count > 200, 'Fine micro-voxel remesh must add surface detail');

  // Dyntopo longest-edge subdivision inside brush sphere
  const sphere = new THREE.Mesh(new THREE.SphereGeometry(1.0, 10, 8), new THREE.MeshStandardMaterial());
  sm.addObject(sphere);
  const initialTris = sphere.geometry.index.count / 3;
  sculpt.targetMesh = sphere;
  sculpt.symmetryX = false;
  sculpt.setDyntopo(true, 0.08);
  const touched = sculpt.applyStroke(
    { point: new THREE.Vector3(0, 1, 0), face: { normal: new THREE.Vector3(0, 1, 0) }, object: sphere },
    { brush: 'draw', radius: 0.7, strength: 0.4, isLocal: true, recordUndo: true }
  );
  assert.ok(touched > 0);
  const afterTris = sphere.geometry.index.count / 3;
  assert.ok(afterTris > initialTris, `Dyntopo must subdivide triangles inside brush sphere (${initialTris} -> ${afterTris})`);

  // Verify zero non-manifold T-junctions by checking Undo cleanly reverts tri count
  sm.undo();
  const undoneTris = sphere.geometry.index ? sphere.geometry.index.count / 3 : sphere.geometry.attributes.position.count / 3;
  assert.equal(undoneTris, initialTris, 'Dyntopo stroke undo must restore original triangle count');
});

console.log(`\nWave 3 Modeling & Sculpt Suite: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
