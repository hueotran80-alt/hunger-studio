import assert from 'node:assert/strict';
import * as THREE from '../vendor/three/three.module.js';
import { AgentUI } from '../js/agent/agent-ui.js';
import { buildToolCatalog } from '../js/ai/agent-tool-bridge.js';
import { ensureBVH, disposeBVH } from '../js/core/bvh-accelerator.js';
import { addModifier, updateModifier, getStack } from '../js/core/modifier-stack.js';
import { decimateMesh } from '../js/core/geometry/hard-surface-ops.js';
import { inspectSceneBudget } from '../js/core/scene-budget.js';
import { sampleCurve3D } from '../js/core/geometry/parametric-cad.js';

let passed = 0;
async function test(name, fn) {
  await fn();
  console.log(`  PASS: ${name}`);
  passed++;
}

console.log('=== Agent Shortcuts, Tool Catalog, BVH & Modifier Rollback Tests ===');

await test('1. Shift+X / Shift+Delete / X / Delete require confirmation in AgentUI.shortcut', async () => {
  const ui = new AgentUI({});
  for (const combo of ['x', 'X', 'Delete', 'del', 'Shift+X', 'Shift+Delete', 'shift+del']) {
    await assert.rejects(
      () => ui.shortcut(combo),
      (err) => err?.code === 'E_NEEDS_CONFIRM',
      `${combo} must reject with E_NEEDS_CONFIRM without confirm:true`
    );
  }
});

await test('2. buildToolCatalog groups tools by domain cleanly without mid-line corruption', () => {
  const defs = [
    { id: 'scene.list', description: 'List objects in scene' },
    { id: 'geom.loft', description: 'Build lofted mesh' },
    { id: 'mat.applyPbr', description: 'Apply procedural PBR' },
    { id: 'anim.play', description: 'Play animation clip' },
    { id: 'export.glb', description: 'Export GLB file' },
    { id: 'inspect.budget', description: 'Inspect scene budget' },
  ];
  const cat = buildToolCatalog(defs, { maxCatalogChars: 2000 });
  assert.ok(cat.text.includes('## scene'), 'has scene section');
  assert.ok(cat.text.includes('## geometry'), 'has geometry section');
  assert.ok(cat.text.includes('## material'), 'has material section');
  assert.ok(cat.text.includes('## animation'), 'has animation section');
  assert.ok(cat.text.includes('## export'), 'has export section');
  assert.ok(cat.text.includes('## observe'), 'has observe section');
});

await test('3. disposeBVH clears boundsTree safely on mesh or geometry', () => {
  const geom = new THREE.BoxGeometry(1, 1, 1);
  const mesh = new THREE.Mesh(geom, new THREE.MeshStandardMaterial());
  const bvh = ensureBVH(mesh);
  assert.ok(bvh && geom.boundsTree, 'BVH built');
  disposeBVH(mesh);
  assert.equal(geom.boundsTree, null, 'BVH disposed');
  disposeBVH(geom);
  assert.equal(geom.boundsTree, null, 'disposeBVH also accepts bare geometry');
});

await test('4. modifier-stack.mutate rolls back stack and preserves prior 1-modifier stack when aborted', async () => {
  const geom = new THREE.BoxGeometry(1, 1, 1);
  const mesh = new THREE.Mesh(geom, new THREE.MeshStandardMaterial());
  await addModifier(mesh, 'bevel', { amount: 0.08, segments: 1 });
  assert.equal(getStack(mesh).length, 1, 'initial 1-modifier stack present');
  const prevGeom = mesh.geometry;

  const ac = new AbortController();
  ac.abort();
  await assert.rejects(
    () => updateModifier(mesh, 0, { amount: 0.2 }, { signal: ac.signal }),
    /abort/i,
    'aborted modifier update rejects'
  );
  assert.equal(getStack(mesh).length, 1, '1-modifier stack restored intact after abort (before.descriptors)');
  assert.equal(getStack(mesh)[0].params.amount, 0.08, 'original modifier param preserved');
  assert.equal(mesh.geometry, prevGeom, 'evaluated geometry restored on abort');
});

await test('5. JS decimateMesh preserves vertex color attribute', () => {
  const geom = new THREE.SphereGeometry(1, 12, 10);
  const col = new Float32Array(geom.attributes.position.count * 3);
  for (let i = 0; i < col.length; i += 3) { col[i] = 0.25; col[i + 1] = 0.6; col[i + 2] = 0.9; }
  geom.setAttribute('color', new THREE.BufferAttribute(col, 3));
  const out = decimateMesh(geom, { ratio: 0.5 });
  assert.ok(out.attributes.color && out.attributes.color.count === out.attributes.position.count, 'decimateMesh preserved vertex colors');
  assert.ok(Math.abs(out.attributes.color.getX(0) - 0.25) < 0.05, 'vertex color values preserved');
});

await test('6. inspectSceneBudget flags drawCalls > maxDrawCalls as over & handles InterleavedBufferAttribute', () => {
  const scene = new THREE.Scene();
  const mat = new THREE.MeshStandardMaterial();
  const ib = new THREE.InterleavedBuffer(new Float32Array(18), 6);
  const interGeom = new THREE.BufferGeometry();
  interGeom.setAttribute('position', new THREE.InterleavedBufferAttribute(ib, 3, 0));
  interGeom.setAttribute('normal', new THREE.InterleavedBufferAttribute(ib, 3, 3));
  for (let i = 0; i < 41; i++) scene.add(new THREE.Mesh(interGeom, mat));
  const report = inspectSceneBudget(scene, { tier: 'mobile' }); // mobile limit = 40 draw calls
  assert.equal(report.status, 'over', '41 draw calls vs 40 limit must report status over');
  assert.ok(report.uniqueGeomMB >= 0 && Number.isFinite(report.uniqueGeomMB), 'interleaved bytes computed cleanly');
});

await test('7. sampleCurve3D catenary follows true hyperbolic cosh curvature (not sine wave)', () => {
  const pts = sampleCurve3D({ type: 'catenary', start: [0, 10, 0], end: [10, 10, 0], sag: 2.0, segments: 4 }, THREE);
  assert.ok(Math.abs(pts[0].point[1] - 10) < 1e-6 && Math.abs(pts[4].point[1] - 10) < 1e-6, 'endpoints match');
  assert.ok(Math.abs(pts[2].point[1] - 8.0) < 1e-6, 'midpoint hits exact sag');
  const sineQuarter = 10 - Math.sin(0.25 * Math.PI) * 2.0; // 8.5858
  assert.ok(Math.abs(pts[1].point[1] - sineQuarter) > 0.05, 'quarter-point uses hyperbolic cosh, not sine');
});

console.log(`ALL ${passed} AGENT SHORTCUT, CATALOG, BVH & ROLLBACK TESTS PASSED`);
