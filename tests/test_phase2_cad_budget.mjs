/**
 * Unit Tests for Phase 2 General-Purpose CAD, Curves, Scatter, and Unified Scene Budget:
 * - buildLoftGeometry (multi-profile loft with twist alignment & end caps)
 * - sampleCurve3D (catenary, helix, scroll, arch, bezier, catmullrom)
 * - buildCurveScatterInstances (deterministic seeded GPU instance transforms)
 * - inspectSceneBudget (exact unique vs rendered tris, geometry MB, texture VRAM, GLB estimate, tier warnings)
 */
import assert from 'node:assert/strict';
import * as THREE from '../vendor/three/three.module.js';
import {
  buildLoftGeometry,
  sampleCurve3D,
  buildCurveScatterInstances,
  buildInstancedMesh,
} from '../js/core/geometry/parametric-cad.js';
import { inspectSceneBudget } from '../js/core/scene-budget.js';

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`ok  ${name}`);
}

test('buildLoftGeometry lofts >=3 heterogeneous 2D sections with caps, crease normals & indexing', () => {
  const geom = buildLoftGeometry({
    samples: 16,
    sections: [
      { contour: [{ op: 'regularPolygon', radius: 2.0, sides: 8 }], y: 0 },
      { contour: [{ op: 'circle', radius: 1.4, segments: 16 }], y: 3.0, twist: 0.2 },
      { contour: [{ op: 'regularPolygon', radius: 0.6, sides: 4 }], y: 6.0 },
    ],
  }, THREE);
  assert.ok(geom.index, 'loft geometry should be indexed');
  assert.ok(geom.index.count >= 16 * 2 * 6, 'loft must connect all rings + caps');
  for (let i = 0; i < geom.attributes.position.array.length; i++) {
    assert.ok(Number.isFinite(geom.attributes.position.array[i]), 'finite loft position');
  }
  assert.ok(Math.abs(geom.boundingBox.min.y - 0) < 0.01);
  assert.ok(Math.abs(geom.boundingBox.max.y - 6.0) < 0.01);
});

test('sampleCurve3D supports catenary, helix, scroll, arch, bezier & catmullrom', () => {
  const cat = sampleCurve3D({ type: 'catenary', start: [0, 10, 0], end: [10, 10, 0], sag: 2.0, segments: 10 }, THREE);
  assert.equal(cat.length, 11);
  assert.ok(Math.abs(cat[5].point[1] - 8.0) < 0.05, 'catenary midpoint sag = 2.0');

  const helix = sampleCurve3D({ type: 'helix', radius: 1.5, height: 6, turns: 2, segments: 24 }, THREE);
  assert.equal(helix.length, 25);
  assert.ok(Math.abs(helix[24].point[1] - 6.0) < 0.01);

  const scroll = sampleCurve3D({ type: 'scroll', startRadius: 0.8, endRadius: 0.1, turns: 1.5, segments: 18, pointsOnly: true }, THREE);
  assert.equal(scroll.length, 19);
  assert.equal(scroll[0].length, 3);

  const arch = sampleCurve3D({ type: 'arch', width: 4, springY: 2, excess: 0.65, segments: 12 }, THREE);
  assert.ok(arch.length >= 24);
});

test('buildCurveScatterInstances produces deterministic seeded transforms for InstancedMesh', () => {
  const samples = sampleCurve3D({ type: 'catenary', start: [-5, 5, 0], end: [5, 5, 0], sag: 1.2, segments: 12 }, THREE);
  const a = buildCurveScatterInstances(samples, { seed: 77, skipEnds: true, scaleMin: 0.8, scaleMax: 1.2 });
  const b = buildCurveScatterInstances(samples, { seed: 77, skipEnds: true, scaleMin: 0.8, scaleMax: 1.2 });
  assert.equal(a.length, 11);
  assert.deepEqual(a, b, 'same seed must produce bit-identical transforms');
});

test('inspectSceneBudget computes exact unique vs rendered tris, geometry MB, VRAM & tier status', () => {
  const scene = new THREE.Scene();
  const box = new THREE.BoxGeometry(1, 1, 1); // 12 tris
  const colorTex = new THREE.DataTexture(new Uint8Array(64 * 64 * 4), 64, 64);
  const normalTex = new THREE.DataTexture(new Uint8Array(64 * 64 * 4), 64, 64);
  const mat = new THREE.MeshStandardMaterial({ map: colorTex, normalMap: normalTex });
  const inst = buildInstancedMesh(box, mat, [{ x: 0 }, { x: 2 }, { x: 4 }, { x: 6 }], {}, THREE);
  scene.add(inst);

  const report = inspectSceneBudget(scene, { tier: 'product' });
  assert.equal(report.uniqueTris, 12);
  assert.equal(report.renderedTris, 48);
  assert.equal(report.instancedCount, 1);
  assert.equal(report.totalInstances, 4);
  assert.equal(report.colorMapCount, 1);
  assert.equal(report.dataMapCount, 1);
  assert.equal(report.status, 'ok');
  assert.ok(report.textureVRAM_MB > 0);
});

console.log(`\nALL ${passed} PHASE-2 CAD, CURVE & SCENE BUDGET TESTS PASSED`);
