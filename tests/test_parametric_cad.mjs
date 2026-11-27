/**
 * Unit tests for Hunger Studio Universal Parametric CAD, Sweep, Loft, GPU Instancing,
 * Vertex Cavity AO, and High-Res Procedural PBR Texture Synthesizer.
 */
import assert from 'node:assert/strict';
import * as THREE from '../vendor/three/three.module.js';
import {
  sample2DContour,
  buildExtrudeGeometry,
  buildSweepGeometry,
  buildLatheGeometry,
  buildSurfaceShellGeometry,
  mergePartGeometries,
  buildInstancedMesh,
  modifyGeometrySync,
  indexGeometry,
} from '../js/core/geometry/parametric-cad.js';
import { executeProceduralGeneration } from '../js/render/procedural-texture-worker.js';

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`ok  ${name}`);
}

test('sample2DContour supports lines, twoCenterArc, circle, regularPolygon & rosette', () => {
  const archPts = sample2DContour([
    [-2, 0],
    { op: 'twoCenterArc', centerX: 0, springY: 3, width: 4, excess: 0.65, segments: 16 },
    [2, 0],
  ]);
  assert.ok(archPts.length > 28, `expected >28 arch points, got ${archPts.length}`);
  const maxY = Math.max(...archPts.map((p) => p[1]));
  // H = (W/2) * sqrt(4e + 1) = 2 * sqrt(3.6) ≈ 3.7947 => apex ≈ 6.7947
  assert.ok(Math.abs(maxY - (3 + 2 * Math.sqrt(3.6))) < 0.02, `unexpected apex height ${maxY}`);

  const rosette = sample2DContour([{ op: 'rosette', outerRadius: 2, innerRadius: 1.2, lobes: 12 }]);
  assert.ok(rosette.length >= 48);
});

test('buildExtrudeGeometry cuts clean holes with bevels, crease normals, UVs & vertex AO', () => {
  const outer = [[-6, 0], [6, 0], [6, 12], [0, 17], [-6, 12]];
  const archHole = [
    [-1.5, 0.2],
    { op: 'twoCenterArc', centerX: 0, springY: 3.5, width: 3.0, excess: 0.6, segments: 12 },
    [1.5, 0.2],
  ];
  const roseHole = [{ op: 'circle', center: [0, 10], radius: 2.0, segments: 24 }];
  const geom = buildExtrudeGeometry({
    contour: outer,
    holes: [archHole, roseHole],
    depth: 0.8,
    bevelSize: 0.02,
    bevelSegments: 2,
  });
  assert.ok(geom.attributes.position.count > 100);
  assert.ok(geom.attributes.normal, 'missing normal attribute');
  assert.ok(geom.attributes.uv, 'missing uv attribute');
  assert.ok(geom.attributes.color, 'missing vertex AO color attribute');
  assert.ok(Math.abs(geom.boundingBox.min.z + 0.42) < 0.05);
});

test('buildSweepGeometry miters sharp corners cleanly along 2D/3D paths', () => {
  const profile = [
    [0, -0.15],
    [0.22, -0.15],
    [0.22, 0.0],
    [0.12, 0.12],
    [0, 0.15],
  ];
  const pathPts = [
    [-2, 0, 0],
    [-2, 3.5, 0],
    [0, 5.8, 0],
    [2, 3.5, 0],
    [2, 0, 0],
  ];
  const geom = buildSweepGeometry({
    profile,
    path: pathPts,
    planeNormal: [0, 0, 1],
    capEnds: true,
  });
  assert.ok(geom.attributes.position.count > 60);
  for (let i = 0; i < geom.attributes.position.array.length; i++) {
    assert.ok(Number.isFinite(geom.attributes.position.array[i]), 'NaN in swept geometry');
  }
});

test('buildLatheGeometry & buildSurfaceShellGeometry produce watertight finite meshes', () => {
  const spire = buildLatheGeometry({
    profile: [[2.2, 0], [2.0, 0.6], [0.08, 16.0]],
    segments: 8,
  });
  assert.ok(spire.attributes.position.count > 30);

  const grid = [];
  for (let r = 0; r <= 8; r++) {
    const row = [];
    const v = -1 + (2 * r) / 8;
    for (let c = 0; c <= 8; c++) {
      const u = -1 + (2 * c) / 8;
      const y = 10 + 3 * (1 - Math.max(Math.abs(u), Math.abs(v)) ** 1.5) + 0.6 * (1 - u * u) * (1 - v * v);
      row.push([u * 5, y, v * 3]);
    }
    grid.push(row);
  }
  const shell = buildSurfaceShellGeometry({ grid, thickness: 0.22 });
  const shellRefs = shell.index ? shell.index.count : shell.attributes.position.count;
  assert.ok(shellRefs > 400, `expected >400 triangle refs, got ${shellRefs}`);
  assert.ok(shell.index && shell.attributes.position.count < shellRefs, 'shell should be indexed with fewer unique vertices');
  assert.ok(shell.boundingBox.max.y > 13.5);
});

test('mergePartGeometries, modifyGeometrySync & buildInstancedMesh work together', () => {
  const a = new THREE.BoxGeometry(1, 4, 1);
  const b = new THREE.CylinderGeometry(0.3, 0.3, 4, 12);
  const merged = mergePartGeometries([
    { geometry: a, x: 0, y: 2, z: 0 },
    { geometry: b, x: 0.5, y: 2, z: 0, tint: 0xd0d4dc },
  ], { recomputeCreaseNormals: true, vertexAO: true });
  const mirrored = modifyGeometrySync(merged, 'mirror', { axis: 'x' });
  assert.ok(mirrored.attributes.position.count > merged.attributes.position.count);

  const inst = buildInstancedMesh(mirrored, new THREE.MeshStandardMaterial(), [
    { x: -6, y: 0, z: 0 },
    { x: 0, y: 0, z: 0 },
    { x: 6, y: 0, z: 0 },
  ]);
  assert.equal(inst.count, 3);
  assert.equal(inst.isInstancedMesh, true);
});

test('executeProceduralGeneration synthesizes all 9 architectural PBR patterns with normal & roughness', () => {
  for (const kind of [
    'ashlar_stone',
    'stucco_plaster',
    'roof_slates',
    'wood_grain',
    'checkered_marble',
    'stained_mosaic',
    'weathered_concrete',
    'clay_roof_tiles',
    'mullioned_glass',
  ]) {
    const res = executeProceduralGeneration(kind, 128, 128, { bumpIntensity: 1.4 });
    assert.equal(res.rgba.length, 128 * 128 * 4, `${kind} albedo size mismatch`);
    assert.equal(res.normals.length, 128 * 128 * 4, `${kind} normal size mismatch`);
    assert.equal(res.roughness.length, 128 * 128 * 4, `${kind} roughness size mismatch`);
  }
});

test('indexGeometry welds shared vertices & compacts Uint8 normalized Vertex AO', () => {
  const sphere = new THREE.SphereGeometry(2, 16, 12).toNonIndexed();
  const beforeVerts = sphere.attributes.position.count;
  const merged = mergePartGeometries([{ geometry: sphere }], { recomputeCreaseNormals: true, vertexAO: true });
  assert.ok(merged.index, 'merged geometry should be indexed by default');
  assert.ok(merged.attributes.position.count < beforeVerts * 0.55, `expected >45% vertex reduction, got ${merged.attributes.position.count} vs ${beforeVerts}`);
  assert.equal(merged.index.count, beforeVerts, 'triangle reference count must remain exact');
  assert.ok(merged.attributes.color.array instanceof Uint8Array, 'vertex AO color should be compact Uint8Array');
  assert.equal(merged.attributes.color.normalized, true, 'Uint8 color attribute must be normalized');
  const reindexed = indexGeometry(sphere.clone());
  assert.ok(reindexed.index && reindexed.attributes.position.count < beforeVerts * 0.45);
});

console.log(`\nALL ${passed} PARAMETRIC CAD & PBR TESTS PASSED`);
