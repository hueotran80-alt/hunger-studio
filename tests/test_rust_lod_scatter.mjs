/**
 * Quantitative Unit & Benchmark Suite: Rust WASM QEM Simplifier, 50k Surface Scatter,
 * Frustum/LOD Instance Culling, LODManager & ViewportGovernor
 * File: tests/test_rust_lod_scatter.mjs
 */

import assert from 'node:assert';
import { performance } from 'node:perf_hooks';
import * as THREE from 'three';
import {
  initMeshKernel,
  isMeshKernelReady,
  simplifyMeshQEMInWasm,
  scatterSurfaceInWasm,
  cullAndLodInstancesInWasm,
} from '../js/core/mesh-kernel-bridge.js';
import {
  LODManager,
  simplifyBufferGeometry,
  countGeometryTriangles,
} from '../js/core/lod-manager.js';
import { ViewportGovernor } from '../js/core/viewport-governor.js';
import { DecimateModifier } from '../js/core/modifiers.js';

let passed = 0;
async function test(name, fn) {
  const detail = await fn();
  passed += 1;
  console.log(`ok   ${name}${detail ? ` — ${detail}` : ''}`);
}

await test('Rust WASM MeshKernel v200 initializes cleanly', async () => {
  const ok = await initMeshKernel();
  assert.strictEqual(ok, true);
  assert.strictEqual(isMeshKernelReady(), true);
});

await test('Rust QEM Simplifier: 65,536-triangle high-poly sphere simplifies to 15% with intact UVs & normals', () => {
  // SphereGeometry(2, 256, 128) -> ~65,024 triangles
  const highSphere = new THREE.SphereGeometry(2.0, 256, 128);
  const inTris = countGeometryTriangles(highSphere);
  assert.ok(inTris > 60000, `Expected >60k tris, got ${inTris}`);

  const t0 = performance.now();
  const res = simplifyMeshQEMInWasm(
    highSphere.attributes.position.array,
    highSphere.index.array,
    {
      uvs: highSphere.attributes.uv.array,
      ratio: 0.15,
      lockBorders: true,
    }
  );
  const elapsedMs = performance.now() - t0;

  assert.ok(res && res.indices.length > 0, 'QEM result must be non-empty');
  const outTris = res.indices.length / 3;
  assert.ok(outTris < inTris * 0.25 && outTris > inTris * 0.08, `Unexpected outTris=${outTris} from ${inTris}`);
  assert.strictEqual(res.normals.length, res.vertices.length);
  assert.strictEqual(res.uvs.length, (res.vertices.length / 3) * 2);
  assert.ok(res.vertices.every((v) => Number.isFinite(v)), 'Vertices contain NaN/Inf');
  assert.ok(res.uvs.every((u) => Number.isFinite(u) && u >= -0.01 && u <= 1.01), 'UVs out of [0,1] bounds');
  highSphere.dispose();

  return `${inTris} -> ${outTris} tris in ${elapsedMs.toFixed(1)} ms`;
});

await test('Rust Surface Scatter: generates 50,000 grass instance Matrix4 transforms with slope filter', () => {
  // Rolling terrain mesh (64x64 grid) with a steep vertical cliff region
  const terrain = new THREE.PlaneGeometry(100, 100, 64, 64);
  terrain.rotateX(-Math.PI / 2);
  const pos = terrain.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const z = pos.getZ(i);
    // Gentle hills on x <= 20, near-vertical cliff on x > 20
    const y = x > 20 ? (x - 20) * 8.0 : Math.sin(x * 0.1) * Math.cos(z * 0.1) * 2.0;
    pos.setY(i, y);
  }
  terrain.computeVertexNormals();

  const t0 = performance.now();
  const res = scatterSurfaceInWasm(
    terrain.attributes.position.array,
    terrain.index.array,
    {
      count: 50000,
      seed: 20261124,
      minScale: 0.75,
      maxScale: 1.35,
      alignNormal: 0.8,
      minNormalY: 0.65, // Reject steep cliff (x > 20)
      minSpacing: 0.0,
    }
  );
  const elapsedMs = performance.now() - t0;

  assert.ok(res && res.count === 50000, `Expected 50,000 instances, got ${res?.count}`);
  assert.strictEqual(res.matrices.length, 50000 * 16);

  // Verify zero instances spawned on steep cliff (x > 22) and valid homogeneous w=1
  let cliffCount = 0;
  for (let i = 0; i < res.count; i++) {
    const tx = res.matrices[i * 16 + 12];
    const tw = res.matrices[i * 16 + 15];
    assert.strictEqual(tw, 1.0);
    if (tx > 22.0) cliffCount++;
  }
  assert.strictEqual(cliffCount, 0, `Slope filter leaked ${cliffCount} instances onto vertical cliff`);
  terrain.dispose();

  return `50,000 Matrix4s (800,000 floats) generated in ${elapsedMs.toFixed(2)} ms`;
});

await test('Rust Spatial Hash Spacing & Frustum + 3-Bucket LOD Culling on 50,000 instances', () => {
  const ground = new THREE.PlaneGeometry(200, 200, 4, 4);
  ground.rotateX(-Math.PI / 2);

  // 1. Test minSpacing (trees at least 2.0m apart)
  const spaced = scatterSurfaceInWasm(ground.attributes.position.array, ground.index.array, {
    count: 400,
    seed: 77,
    minSpacing: 2.0,
  });
  assert.ok(spaced.count > 200);
  for (let i = 0; i < Math.min(80, spaced.count); i++) {
    const ax = spaced.matrices[i * 16 + 12];
    const az = spaced.matrices[i * 16 + 14];
    for (let j = i + 1; j < Math.min(80, spaced.count); j++) {
      const bx = spaced.matrices[j * 16 + 12];
      const bz = spaced.matrices[j * 16 + 14];
      const d = Math.hypot(ax - bx, az - bz);
      assert.ok(d >= 1.999, `Spacing violated: ${d} < 2.0m`);
    }
  }

  // 2. Benchmark 50,000-instance Frustum + 3-LOD partition
  const field = scatterSurfaceInWasm(ground.attributes.position.array, ground.index.array, {
    count: 50000,
    seed: 99,
  });

  const cam = new THREE.PerspectiveCamera(60, 16 / 9, 0.5, 90);
  cam.position.set(0, 8, 40);
  cam.lookAt(0, 0, 0);
  cam.updateMatrixWorld(true);
  cam.updateProjectionMatrix();

  const projScreen = new THREE.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
  const frustum = new THREE.Frustum().setFromProjectionMatrix(projScreen);
  const planesArr = new Float32Array(24);
  for (let p = 0; p < 6; p++) {
    const pl = frustum.planes[p];
    planesArr[p * 4] = pl.normal.x;
    planesArr[p * 4 + 1] = pl.normal.y;
    planesArr[p * 4 + 2] = pl.normal.z;
    planesArr[p * 4 + 3] = pl.constant;
  }

  const t0 = performance.now();
  const idleCull = cullAndLodInstancesInWasm(field.matrices, {
    frustumPlanes: planesArr,
    cameraPosition: [0, 8, 40],
    boundingRadius: 0.6,
    lod1Distance: 18,
    lod2Distance: 42,
    maxDistance: 85,
    lodBias: 1.0,
  });
  const elapsedMs = performance.now() - t0;

  assert.strictEqual(
    idleCull.counts[0] + idleCull.counts[1] + idleCull.counts[2],
    idleCull.totalVisible
  );
  assert.strictEqual(idleCull.totalVisible + idleCull.counts[3], 50000);
  assert.ok(idleCull.counts[3] > 20000, 'Frustum + maxDistance should cull >40% of 200x200 field');

  // Orbiting mouse drops lodBias -> LOD0 count MUST decrease as mid-range shifts to LOD1/LOD2
  const orbitCull = cullAndLodInstancesInWasm(field.matrices, {
    frustumPlanes: planesArr,
    cameraPosition: [0, 8, 40],
    boundingRadius: 0.6,
    lod1Distance: 18,
    lod2Distance: 42,
    maxDistance: 85,
    lodBias: 0.42,
  });
  assert.ok(orbitCull.counts[0] < idleCull.counts[0], 'Orbit lodBias=0.42 must reduce expensive LOD0 count');
  ground.dispose();

  return `50k cull+LOD in ${elapsedMs.toFixed(2)} ms (Idle LOD0=${idleCull.counts[0]} -> Orbit LOD0=${orbitCull.counts[0]}, Culled=${idleCull.counts[3]})`;
});

await test('LODManager: multi-material Tree Auto-LOD & lossless non-destructive Detail Slider', async () => {
  const lodMgr = new LODManager();

  // Multi-material geometry (group 0 = bark, group 1 = canopy)
  const trunk = new THREE.CylinderGeometry(0.3, 0.5, 4, 24, 12);
  const canopy = new THREE.SphereGeometry(2.5, 48, 32);
  const p0 = trunk.toNonIndexed();
  const p1 = canopy.toNonIndexed();
  const totalVerts = p0.attributes.position.count + p1.attributes.position.count;
  const mergedPos = new Float32Array(totalVerts * 3);
  mergedPos.set(p0.attributes.position.array, 0);
  mergedPos.set(p1.attributes.position.array, p0.attributes.position.array.length);
  const multiGeom = new THREE.BufferGeometry();
  multiGeom.setAttribute('position', new THREE.BufferAttribute(mergedPos, 3));
  multiGeom.addGroup(0, p0.attributes.position.count, 0);
  multiGeom.addGroup(p0.attributes.position.count, p1.attributes.position.count, 1);

  const simpMulti = simplifyBufferGeometry(multiGeom, 0.25);
  assert.strictEqual(simpMulti.groups.length, 2, 'Multi-material groups must be preserved');
  assert.strictEqual(simpMulti.groups[0].materialIndex, 0);
  assert.strictEqual(simpMulti.groups[1].materialIndex, 1);

  // Non-destructive slider: 100% -> 20% -> 100% lossless restore
  const treeGroup = new THREE.Group();
  const leafMesh = new THREE.Mesh(new THREE.SphereGeometry(2, 48, 32), new THREE.MeshStandardMaterial());
  leafMesh.castShadow = true;
  treeGroup.add(leafMesh);
  const origTris = countGeometryTriangles(leafMesh.geometry);

  const reduced = await lodMgr.setMeshDetailLevel(leafMesh, 0.2);
  assert.ok(reduced.currentTriangles < origTris * 0.3);
  const restored = await lodMgr.setMeshDetailLevel(leafMesh, 1.0);
  assert.strictEqual(restored.currentTriangles, origTris, 'Restoring detail=1.0 must recover exact original triangle count');

  // Auto-LOD distance tier switching + shadow drop at LOD2
  const autoInfo = await lodMgr.enableAutoLOD(treeGroup, { distances: [0, 12, 30] });
  assert.ok(autoInfo.stats.lod2Tris < autoInfo.stats.lod1Tris && autoInfo.stats.lod1Tris < autoInfo.stats.lod0Tris);

  const scene = new THREE.Scene();
  scene.add(treeGroup);
  const cam = new THREE.PerspectiveCamera(50, 1, 0.1, 200);

  cam.position.set(0, 0, 5);
  cam.updateMatrixWorld(true);
  lodMgr.update(cam, 1.0);
  assert.strictEqual(leafMesh.userData._autoLodTier, 0);
  assert.strictEqual(leafMesh.castShadow, true);

  // At 20m: LOD1 when idle (bias=1.0), but jumps to LOD2 while orbiting mouse (bias=0.42 -> d2=12.6m)!
  cam.position.set(0, 0, 20);
  cam.updateMatrixWorld(true);
  lodMgr.update(cam, 1.0);
  assert.strictEqual(leafMesh.userData._autoLodTier, 1);

  lodMgr.update(cam, 0.42);
  assert.strictEqual(leafMesh.userData._autoLodTier, 2);
  assert.strictEqual(leafMesh.castShadow, false, 'Distant LOD2 foliage must skip shadow map pass');

  // DecimateModifier uses Rust WASM fast path seamlessly
  const decOut = DecimateModifier.execute(new THREE.SphereGeometry(1, 32, 24), { mode: 'collapse', ratio: 0.3 });
  assert.ok(countGeometryTriangles(decOut) < 500);

  lodMgr.disableAutoLOD(treeGroup);
  assert.strictEqual(leafMesh.castShadow, true);
  return `LOD0=${autoInfo.stats.lod0Tris} -> LOD1=${autoInfo.stats.lod1Tris} -> LOD2=${autoInfo.stats.lod2Tris} tris`;
});

await test('ViewportGovernor: drops Retina DPR & suspends GTAO/Bokeh while orbiting, restores crisply on settle', async () => {
  let dpr = 2.0;
  let renderRequests = 0;
  const gtaoPass = { enabled: true };
  const bokehPass = { enabled: true };
  const outputPass = { enabled: true };
  const listeners = {};

  const mockEngine = {
    controls: {
      addEventListener(ev, fn) { listeners[ev] = fn; },
      removeEventListener(ev) { delete listeners[ev]; },
    },
    renderer: {
      getPixelRatio: () => dpr,
      setPixelRatio: (v) => { dpr = v; },
    },
    _getViewportPixelRatio: () => 2.0,
    rasterRenderer: {
      postProcessing: {
        enabled: true,
        composer: { setPixelRatio() {} },
        gtaoPass,
        bokehPass,
        outputPass,
      },
    },
    requestRender() { renderRequests++; },
  };

  const gov = new ViewportGovernor({
    engine: mockEngine,
    interactiveDprCap: 0.9,
    interactiveLodBias: 0.42,
    settleDelayMs: 50,
  });

  assert.strictEqual(gov.getEffectiveLodBias(), 1.0);
  listeners.start();
  assert.strictEqual(gov.isNavigating, true);
  assert.strictEqual(dpr, 0.9, 'Retina DPR=2.0 must drop to 0.9 during active orbit');
  assert.strictEqual(gtaoPass.enabled, false, 'GTAO must suspend during active orbit');
  assert.strictEqual(bokehPass.enabled, false, 'Bokeh DOF must suspend during active orbit');
  assert.strictEqual(outputPass.enabled, true, 'OutputPass tone mapping must remain enabled (no brightness flicker)');
  assert.strictEqual(gov.getEffectiveLodBias(), 0.42);

  listeners.end();
  await new Promise((r) => setTimeout(r, 80));

  assert.strictEqual(gov.isNavigating, false);
  assert.strictEqual(dpr, 2.0, 'Full Retina DPR=2.0 must restore after pointer settles');
  assert.strictEqual(gtaoPass.enabled, true, 'GTAO must re-enable after settle');
  assert.strictEqual(bokehPass.enabled, true, 'Bokeh DOF must re-enable after settle');
  assert.strictEqual(gov.getEffectiveLodBias(), 1.0);
  assert.ok(renderRequests >= 1, 'Settle must request a crisp final frame');
  gov.dispose();
});

console.log(`\nALL ${passed}/6 RUST WASM QEM, 50K SCATTER & VIEWPORT GOVERNOR TESTS PASSED`);
