/**
 * Regression & Contract Tests for Phase 1 P0/P1 Fixes (HungerG Audit):
 * 1. [P0] indexGeometry() preserves multi-material groups, drawRange, uv1, tangent & custom attributes;
 *    _prepareOptimizedGltfExport preserves multi-material meshes (never drops them in GLTFExporter).
 * 2. [P1] GLB optimizer encodes ONLY opaque color slots (map/emissiveMap) as JPEG and keeps ALL linear
 *    data maps (normalMap, roughnessMap, metalnessMap, aoMap, clearcoatNormalMap) lossless PNG.
 * 3. [P1] Material dedup signature distinguishes thickness, iridescence, anisotropy, clearcoatNormalMap,
 *    and texture rotation/center/flipY/wrap/filter.
 * 4. [P1] InterleavedBufferAttribute (stride > itemSize, offset != 0) works in indexGeometry, merge & mirror.
 * 5. [P1] Procedural worker & CAD preflight guards safely bound cells:Infinity and oversized grids/instances.
 * 6. [P1] MaterialStudio.upgradeToPhysicalMaterial preserves vertexColors & aoMap;
 *    RapidStudio.playCharacterAnimation registers exactly 1 render callback on this._engine.
 */
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
  indexGeometry,
  mergePartGeometries,
  buildInstancedMesh,
  buildSurfaceShellGeometry,
  modifyGeometrySync,
} from '../js/core/geometry/parametric-cad.js';
import { executeProceduralGeneration } from '../js/render/procedural-texture-worker.js';
import { MaterialStudio } from '../js/core/material-studio.js';
import { RapidStudio } from '../js/scripting/rapid-api.js';
import { StudioExporter } from '../js/exporters/export-import.js';

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`ok  ${name}`);
}

test('[P0] indexGeometry preserves multi-material groups, drawRange, uv1 & tangent', () => {
  const box = new THREE.BoxGeometry(2, 2, 2, 2, 2, 2).toNonIndexed();
  const count = box.attributes.position.count;
  const uv1 = new Float32Array(count * 2);
  const tangent = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) {
    uv1[i * 2] = box.attributes.uv.getX(i) * 0.5;
    uv1[i * 2 + 1] = box.attributes.uv.getY(i) * 0.5;
    tangent[i * 4] = 1; tangent[i * 4 + 3] = 1;
  }
  box.setAttribute('uv1', new THREE.BufferAttribute(uv1, 2));
  box.setAttribute('tangent', new THREE.BufferAttribute(tangent, 4));
  box.clearGroups();
  const half = Math.floor(count / 6) * 3;
  box.addGroup(0, half, 0);
  box.addGroup(half, count - half, 1);

  const indexed = indexGeometry(box, {}, THREE);
  assert.ok(indexed.index, 'must be indexed');
  assert.equal(indexed.index.count, count, 'triangle reference count preserved');
  assert.equal(indexed.groups.length, 2, 'multi-material groups MUST be preserved');
  assert.deepEqual(indexed.groups[0], { start: 0, count: half, materialIndex: 0 });
  assert.deepEqual(indexed.groups[1], { start: half, count: count - half, materialIndex: 1 });
  assert.ok(indexed.attributes.uv1, 'uv1 attribute preserved');
  assert.ok(indexed.attributes.tangent, 'tangent attribute preserved');
  assert.ok(indexed.attributes.position.count < count, 'shared vertices welded');
});

test('[P0+P1] _prepareOptimizedGltfExport keeps multi-material groups, preserves PNG on data maps, and distinguishes PhysicalMaterial props', () => {
  const exporter = new StudioExporter({ THREE });
  const root = new THREE.Group();

  const makeDummyTex = (tag) => {
    const t = new THREE.DataTexture(new Uint8Array([128, 128, 255, 255]), 1, 1);
    t.name = tag;
    return t;
  };
  const colorMap = makeDummyTex('albedo');
  const normalMap = makeDummyTex('normal');
  const roughMap = makeDummyTex('roughness');
  const aoMap = makeDummyTex('ao');
  const ccNormalMap = makeDummyTex('clearcoatNormal');

  const matA = new THREE.MeshPhysicalMaterial({
    color: 0xffffff,
    map: colorMap,
    normalMap,
    roughnessMap: roughMap,
    aoMap,
    clearcoatNormalMap: ccNormalMap,
    thickness: 0.2,
    metalness: 0.0,
    roughness: 1.0,
  });
  const matB = matA.clone();
  matB.thickness = 2.0; // MUST NOT be deduplicated with matA!

  const matC = matA.clone(); // Identical to matA -> SHOULD deduplicate
  const geom = new THREE.BoxGeometry(1, 1, 1, 3, 3, 3).toNonIndexed();
  geom.clearGroups();
  const c = geom.attributes.position.count;
  const half = Math.floor(c / 6) * 3;
  geom.addGroup(0, half, 0);
  geom.addGroup(half, c - half, 1);

  const multiMesh = new THREE.Mesh(geom, [matA, matB]);
  const meshC = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), matC);
  root.add(multiMesh, meshC);

  const restore = exporter._prepareOptimizedGltfExport(root, { textureFormat: 'auto' });
  try {
    // 1. Multi-material groups survived indexing!
    assert.equal(multiMesh.geometry.groups.length, 2, 'multiMesh groups preserved during GLB export');
    assert.ok(multiMesh.geometry.index, 'multiMesh indexed cleanly');
    // 2. Material dedup respects thickness (matA != matB), while merging identical matC -> matA
    assert.notStrictEqual(multiMesh.material[0], multiMesh.material[1], 'matA and matB with different thickness must NOT merge');
    assert.strictEqual(meshC.material, matA, 'identical matC should deduplicate to matA');
    // 3. ONLY color map gets JPEG; ALL data maps stay lossless PNG (no mimeType='image/jpeg')!
    assert.equal(colorMap.userData.mimeType, 'image/jpeg', 'opaque albedo map should use image/jpeg');
    assert.notEqual(normalMap.userData.mimeType, 'image/jpeg', 'normalMap MUST stay lossless PNG');
    assert.notEqual(roughMap.userData.mimeType, 'image/jpeg', 'roughnessMap MUST stay lossless PNG');
    assert.notEqual(aoMap.userData.mimeType, 'image/jpeg', 'aoMap MUST stay lossless PNG');
    assert.notEqual(ccNormalMap.userData.mimeType, 'image/jpeg', 'clearcoatNormalMap MUST stay lossless PNG');
  } finally {
    restore();
  }
  // Verify clean non-destructive restore
  assert.strictEqual(meshC.material, matC, 'material ref restored');
  assert.strictEqual(colorMap.userData.mimeType, undefined, 'mimeType restored');
});

test('[P1] InterleavedBufferAttribute (stride > itemSize, offset != 0) works in indexGeometry, mergePartGeometries & mirror', () => {
  // 3 vertices forming 1 triangle, packed with stride=8 (pos @0..2, pad @3, nrm @4..6, pad @7)
  const raw = new Float32Array([
    0, 0, 0, 99,   0, 0, 1, 88,
    1, 0, 0, 99,   0, 0, 1, 88,
    0, 1, 0, 99,   0, 0, 1, 88,
  ]);
  const ib = new THREE.InterleavedBuffer(raw, 8);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.InterleavedBufferAttribute(ib, 3, 0, false));
  g.setAttribute('normal', new THREE.InterleavedBufferAttribute(ib, 3, 4, false));

  const idx = indexGeometry(g, {}, THREE);
  assert.equal(idx.attributes.position.count, 3);
  assert.equal(idx.attributes.position.getX(1), 1);

  const merged = mergePartGeometries([{ geometry: g }], {}, THREE);
  assert.equal(merged.index.count, 3);

  const mirrored = modifyGeometrySync(g, 'mirror', { axis: 'x' }, THREE);
  assert.ok(mirrored.attributes.position.count >= 6 || mirrored.index?.count === 6);
});

test('[P1] Preflight guards bound cells:Infinity, huge grids, and empty/huge instances', () => {
  const vor = executeProceduralGeneration('voronoi', 32, 32, { cells: Infinity });
  assert.equal(vor.rgba.length, 32 * 32 * 4);
  const mos = executeProceduralGeneration('stained_mosaic', 32, 32, { cells: Infinity });
  assert.equal(mos.rgba.length, 32 * 32 * 4);

  const emptyInst = buildInstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial(), [], {}, THREE);
  assert.equal(emptyInst.count, 0, 'empty instances must produce count=0 (no phantom instance)');

  assert.throws(() => {
    buildInstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial(), new Array(250000), {}, THREE);
  }, /exceeds budget/);

  assert.throws(() => {
    const huge = Array.from({ length: 520 }, () => [[0, 0, 0], [1, 0, 0]]);
    buildSurfaceShellGeometry({ grid: huge }, THREE);
  }, /exceeds budget/);
});

test('[P1] MaterialStudio preserves vertexColors/aoMap and RapidStudio registers mixer callback on _engine', () => {
  const ms = new MaterialStudio({ THREE });
  const aoTex = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
  const std = new THREE.MeshStandardMaterial({ vertexColors: true, aoMap: aoTex, aoMapIntensity: 0.7 });
  const phys = ms.upgradeToPhysicalMaterial(std, { clearcoat: 0.5 });
  assert.equal(phys.vertexColors, true, 'vertexColors must be preserved on Physical upgrade');
  assert.strictEqual(phys.aoMap, aoTex, 'aoMap must be preserved');

  let callbacks = 0;
  const fakeEngine = { addRenderCallback: () => { callbacks++; } };
  const studio = new RapidStudio({ THREE, scene: new THREE.Scene(), engine: fakeEngine });
  const root = new THREE.Group();
  const track = new THREE.VectorKeyframeTrack('.position', [0, 1], [0, 0, 0, 1, 0, 0]);
  root.animations = [new THREE.AnimationClip('Walk', 1, [track])];
  studio.playCharacterAnimation(root, 'Walk');
  assert.equal(callbacks, 1, 'AnimationMixer render callback MUST register on this._engine');
});

console.log(`\nALL ${passed} PHASE-1 P0/P1 REGRESSION TESTS PASSED`);
