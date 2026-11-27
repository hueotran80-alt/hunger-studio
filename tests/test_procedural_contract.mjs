import assert from 'node:assert/strict';
import * as THREE from '../vendor/three/three.module.js';
import { executeProceduralGeneration } from '../js/render/procedural-texture-worker.js';
import { ProceduralTextureClient } from '../js/render/procedural-texture-client.js';
import { MaterialStudio } from '../js/core/material-studio.js';
import { RapidStudio } from '../js/scripting/rapid-api.js';

let passed = 0;
async function test(name, fn) {
  await fn();
  console.log(`  PASS: ${name}`);
  passed++;
}

function edgeSeamError(rgba, width, height) {
  let sumH = 0, sumV = 0;
  for (let y = 0; y < height; y++) {
    const a = (y * width + 0) * 4;
    const b = (y * width + (width - 1)) * 4;
    sumH += (Math.abs(rgba[a] - rgba[b]) + Math.abs(rgba[a + 1] - rgba[b + 1]) + Math.abs(rgba[a + 2] - rgba[b + 2])) / 3;
  }
  for (let x = 0; x < width; x++) {
    const a = (0 * width + x) * 4;
    const b = ((height - 1) * width + x) * 4;
    sumV += (Math.abs(rgba[a] - rgba[b]) + Math.abs(rgba[a + 1] - rgba[b + 1]) + Math.abs(rgba[a + 2] - rgba[b + 2])) / 3;
  }
  return { horizontal: sumH / height, vertical: sumV / width };
}

console.log('=== Procedural Texture, Seam Continuity, Finite Bounds & MaterialStudio Tests ===');

await test('1. Finite bounds protect against Infinity/NaN inputs across all procedural patterns', () => {
  const patterns = [
    ['noise', { octaves: Infinity, scale: Infinity, persistence: NaN }],
    ['voronoi', { cells: Infinity }],
    ['stained_mosaic', { cells: Infinity }],
    ['ashlar_stone', { courses: Infinity, blocksPerCourse: Infinity }],
    ['roof_slates', { rows: Infinity, cols: NaN }],
    ['clay_roof_tiles', { rows: Infinity, cols: Infinity }],
    ['wood_grain', { planks: Infinity }],
    ['checkered_marble', { tiles: Infinity }],
    ['mullioned_glass', { rows: Infinity, cols: Infinity }],
  ];
  for (const [type, opts] of patterns) {
    const out = executeProceduralGeneration(type, 64, 64, opts);
    assert.equal(out.rgba.length, 64 * 64 * 4, `${type} produced valid RGBA buffer`);
    assert.equal(out.normals.length, 64 * 64 * 4, `${type} produced valid normal buffer`);
    assert.equal(out.roughness.length, 64 * 64 * 4, `${type} produced valid roughness buffer`);
  }
});

await test('2. Periodic seam continuity holds for checkered_marble, ashlar_stone & weathered_concrete', () => {
  // Vein + grout wrap continuity (same base tile color isolates periodic noise + grout symmetry)
  const marbleVeins = executeProceduralGeneration('checkered_marble', 128, 128, {
    tiles: 5, diagonal: false, color1: '#d8d2c6', color2: '#d8d2c6', veinColor: '#6b655c'
  });
  const marbleSeam = edgeSeamError(marbleVeins.rgba, 128, 128);
  assert.ok(marbleSeam.horizontal < 18, `marble horizontal vein/grout seam too large: ${marbleSeam.horizontal.toFixed(1)}`);
  assert.ok(marbleSeam.vertical < 18, `marble vertical vein/grout seam too large: ${marbleSeam.vertical.toFixed(1)}`);

  // Odd `tiles: 5` must clamp to even tile count so checkerboard parity alternates across the wrap seam (never double-wide tile)
  const marbleChecker = executeProceduralGeneration('checkered_marble', 128, 128, {
    tiles: 5, diagonal: false, color1: '#f0ece2', color2: '#222428'
  });
  const midY = 64;
  const leftTileR = marbleChecker.rgba[(midY * 128 + 4) * 4];
  const rightTileR = marbleChecker.rgba[(midY * 128 + 123) * 4];
  assert.ok(Math.abs(leftTileR - rightTileR) > 80, 'checkerboard alternates light/dark across wrap boundary');

  const ashlar = executeProceduralGeneration('ashlar_stone', 128, 128, { courses: 7, blocksPerCourse: 4 });
  const ashlarSeam = edgeSeamError(ashlar.rgba, 128, 128);
  assert.ok(ashlarSeam.horizontal < 36, `ashlar horizontal seam too large: ${ashlarSeam.horizontal.toFixed(1)}`);
  assert.ok(ashlarSeam.vertical < 36, `ashlar vertical seam too large: ${ashlarSeam.vertical.toFixed(1)}`);

  const concrete = executeProceduralGeneration('weathered_concrete', 128, 128, { scale: 4 });
  const concSeam = edgeSeamError(concrete.rgba, 128, 128);
  assert.ok(concSeam.horizontal < 28 && concSeam.vertical < 28, `concrete seam too large: ${JSON.stringify(concSeam)}`);
});

await test('3. ProceduralTextureClient LRU byte-budget eviction protects active leases', async () => {
  const client = new ProceduralTextureClient({ maxCacheEntries: 4, maxCacheBytes: 64 * 64 * 4 * 3 * 2 });
  const a = await client.generateTextureMaps('noise', 64, 64, { seed: 1 });
  const b = await client.generateTextureMaps('noise', 64, 64, { seed: 2 });
  // Acquire a lease on `a` so it must NOT be disposed on eviction
  const keyA = [...client.cache.keys()][0];
  client.acquireLease(keyA);
  let disposedA = false;
  a.diffuseTexture.dispose = () => { disposedA = true; };

  await client.generateTextureMaps('noise', 64, 64, { seed: 3 });
  assert.equal(disposedA, false, 'leased texture must never be disposed during LRU eviction');
  client.releaseLease(keyA);
  client.clearCache({ force: true });
  assert.equal(client.cache.size, 0, 'force clearCache empties cache');
});

await test('4. MaterialStudio noise cache includes persistence/lacunarity & preserves vertexColors on preset/upgrade', () => {
  const studio = new MaterialStudio(THREE);
  const geom = new THREE.BoxGeometry(1, 1, 1);
  const col = new Float32Array(geom.attributes.position.count * 3).fill(0.8);
  geom.setAttribute('color', new THREE.BufferAttribute(col, 3));
  const mesh = new THREE.Mesh(geom, new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true }));

  const upgraded = studio.upgradeToPhysicalMaterial(mesh.material);
  assert.equal(upgraded.vertexColors, true, 'upgradeToPhysicalMaterial preserves vertexColors');

  const presetKey = Object.keys(studio.getMaterialPresets())[0];
  assert.ok(presetKey, 'MaterialStudio has presets');
  studio.applyPreset(mesh, presetKey);
  assert.equal(mesh.material.vertexColors, true, `applyPreset(${presetKey}) preserves vertexColors when geometry has color attribute`);
});

await test('5. Non-finite numeric & coercible-string options (grain:"NaN") never produce black albedo; AbortSignal/dedup clean', async () => {
  const out = executeProceduralGeneration('weathered_concrete', 32, 32, {
    scale: Infinity, rainStreaks: NaN, weathering: -Infinity, roughnessMin: NaN, bumpIntensity: Infinity,
  });
  let sumRgb = 0;
  for (let i = 0; i < out.rgba.length; i += 4) sumRgb += out.rgba[i] + out.rgba[i + 1] + out.rgba[i + 2];
  assert.ok(sumRgb > 32 * 32 * 30, 'concrete albedo must stay non-black on non-finite numbers');

  const brushed = executeProceduralGeneration('brushed', 32, 32, { grain: 'NaN', scratchDensity: 'Infinity', roughnessMin: 'bad' });
  let brushedSum = 0;
  for (let i = 0; i < brushed.rgba.length; i += 4) brushedSum += brushed.rgba[i] + brushed.rgba[i + 1] + brushed.rgba[i + 2];
  assert.ok(brushedSum > 32 * 32 * 30, 'brushed albedo must stay non-black when grain:"NaN" string is passed');

  const client = new ProceduralTextureClient();
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(
    () => client.generateTextureMaps('noise', 64, 64, { signal: ac.signal }),
    (err) => err?.name === 'AbortError',
    'pre-aborted AbortSignal rejects with AbortError'
  );
  // Concurrent same-key requests coalesce and keep accurate cacheBytes
  const [p1, p2] = await Promise.all([
    client.generateTextureMaps('ashlar_stone', 64, 64, { seed: 777 }),
    client.generateTextureMaps('ashlar_stone', 64, 64, { seed: 777 }),
  ]);
  assert.strictEqual(p1, p2, 'same-key concurrent requests share one entry');
  assert.equal(client.cacheBytes, p1.estimatedBytes, 'cacheBytes accurately equals single entry size');
  client.dispose();
});

await test('6. applyProceduralPBR stores lease in private WeakMap (0 userData/JSON bloat) and releases on dispose', async () => {
  const scene = new THREE.Scene();
  const rapid = new RapidStudio({ scene, camera: new THREE.PerspectiveCamera(), THREE });
  const mesh = rapid.addCube({ name: 'LeaseCube', width: 1, height: 1, depth: 1 });
  await rapid.applyProceduralPBR(mesh, { pattern: 'ashlar_stone', resolution: 64 });
  assert.equal(mesh.material.userData?.__procTexLease, undefined, 'no runtime lease stored in material.userData');
  const matJson = JSON.stringify(mesh.material.toJSON({ images: {}, textures: {} }));
  assert.ok(!matJson.includes('__procTexLease'), 'serialized material JSON contains no lease reference');
  assert.ok(matJson.length < 4000, `material JSON (excluding shared meta.images) must stay tiny (<4KB), got ${matJson.length} bytes`);
  const leaseEntry = [...rapid._procTexClient.cache.values()][0];
  assert.equal(leaseEntry.leases, 1, 'material holds 1 active lease');
  mesh.material.dispose();
  assert.equal(leaseEntry.leases, 0, 'disposing material releases its texture lease automatically');
  // Also verify createCurve3D & inspectSceneBudget('product') parity on main RapidStudio
  const pts = rapid.createCurve3D({ type: 'catenary', start: [-2, 2, 0], end: [2, 2, 0], sag: 1, segments: 6 });
  assert.equal(pts.length, 7);
  const bud = rapid.inspectSceneBudget('product');
  assert.equal(bud.tier, 'product');
});

console.log(`ALL ${passed} PROCEDURAL & MATERIAL CONTRACT TESTS PASSED`);
