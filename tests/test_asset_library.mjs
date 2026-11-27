/**
 * Asset Library sources suite (Node): license integrity of the redistributable
 * catalog, Fab link-only guarantee (no Epic bytes), local-folder scan, credit
 * dedup and import dispatch. Run with:
 *   node --import ./tests/three-resolve-hooks.mjs tests/test_asset_library.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as THREE from 'three';
import { SceneManager } from '../js/core/scene-manager.js';
import {
  FAB_CATALOG, FAB_LICENSE_NOTE, LOCAL_EXTENSIONS,
  scanLocalDirectory, importAssetFile, recordCredit, formatCredits,
  resolvePolyHavenTextureFiles,
} from '../js/ui/asset-library-sources.js';
import {
  buildAssetCatalog, filterAssetCatalog, ASSET_KINDS,
  pickDropTransformOnScene, normalizeAndPlaceAsset, ensureGeometryUVs,
} from '../js/ui/asset-browser.js';

let passed = 0;
const failures = [];
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`ok   ${name}`);
  } catch (error) {
    failures.push(name);
    console.error(`FAIL ${name}\n     ${error.stack || error.message}`);
  }
}

const catalog = JSON.parse(fs.readFileSync(new URL('../assets/library/online-catalog.json', import.meta.url), 'utf8'));

await test('online catalog only contains redistributable licenses with attribution metadata', () => {
  assert.ok(catalog.items.length >= 4, 'catalog cần đủ asset để dùng thật');
  for (const it of catalog.items) {
    assert.ok(['CC0-1.0', 'CC-BY-4.0'].includes(it.license), `${it.id}: license ${it.license} không được redistribute`);
    assert.ok(it.author && it.author.length > 3, `${it.id} thiếu author`);
    assert.ok(/^https:\/\//.test(it.url), `${it.id} url phải https`);
    assert.ok(/^https:\/\//.test(it.thumb), `${it.id} thumb phải https`);
    assert.ok(Array.isArray(it.tags) && it.tags.length, `${it.id} thiếu tags`);
    if (it.license === 'CC-BY-4.0') assert.ok(it.tags.includes('attribution'), `${it.id} CC-BY phải gắn tag attribution`);
  }
});

await test('online catalog never references Fab/Epic/Megascans bytes', () => {
  const raw = JSON.stringify(catalog.items).toLowerCase();
  for (const bad of [/(?:^|[^a-z0-9-])fab\.com/, /epicgames/, /megascans/, /quixel/, /unrealengine/]) {
    assert.ok(!bad.test(raw), `catalog online dính nguồn Epic/Fab: ${bad}`);
  }
});

await test('Fab catalog is link-only: productUrl present, no download url, license note explicit', () => {
  assert.ok(FAB_CATALOG.length >= 1);
  for (const fb of FAB_CATALOG) {
    assert.equal(fb.kind, 'fab');
    assert.ok(/^https:\/\//.test(fb.productUrl), 'Fab entry phải là link landing page');
    assert.equal(fb.url, undefined, 'Fab entry KHÔNG được có url tải byte');
    assert.equal(fb.thumb, undefined, 'Fab entry không host preview byte của Epic');
  }
  assert.ok(/redistribute/i.test(FAB_LICENSE_NOTE), 'ghi chú phải nêu cấm redistribute');
  assert.ok(/account|tự acquire/i.test(FAB_LICENSE_NOTE), 'ghi chú phải nêu user tự acquire');
});

await test('catalog builder and filter understand online/local/fab kinds', () => {
  for (const k of ['online', 'local', 'fab']) assert.ok(ASSET_KINDS.includes(k), `thiếu kind ${k}`);
  const items = buildAssetCatalog({
    online: [{ id: 'on1', name: 'BoomBox', tags: ['cc0'] }],
    local: [{ id: 'lo1', name: 'my.fbx', tags: ['local'] }],
    fab: FAB_CATALOG,
  });
  assert.equal(filterAssetCatalog(items, { kind: 'online' }).length, 1);
  assert.equal(filterAssetCatalog(items, { kind: 'local' }).length, 1);
  assert.equal(filterAssetCatalog(items, { kind: 'fab' }).length, FAB_CATALOG.length);
  assert.equal(filterAssetCatalog(items, { query: 'boombox' }).length, 1);
  assert.equal(filterAssetCatalog(items, { kind: 'online', query: 'megascans' }).length, 0);
});

await test('scanLocalDirectory keeps only importable files and skips folders', async () => {
  const entries = [
    { kind: 'file', name: 'a.glb' },
    { kind: 'file', name: 'b.FBX' },
    { kind: 'file', name: 'c.obj' },
    { kind: 'file', name: 'notes.txt' },
    { kind: 'file', name: 'scan.uasset' },
    { kind: 'directory', name: 'sub' },
  ];
  const handle = { values: async function* () { for (const e of entries) yield e; } };
  const out = await scanLocalDirectory(handle);
  assert.deepEqual(out.map((o) => o.name), ['a.glb', 'b.FBX', 'c.obj']);
  assert.ok(out.every((o) => o.kind === 'local' && LOCAL_EXTENSIONS.includes(o.ext)));
});

await test('recordCredit dedups by id and formatCredits lists author + license', () => {
  const root = { userData: {} };
  recordCredit(root, { id: 'x', name: 'Helmet', author: 'theblueturtle_', license: 'CC-BY-4.0', source: 'khronos', url: 'https://example.org' });
  recordCredit(root, { id: 'x', name: 'Helmet', author: 'theblueturtle_', license: 'CC-BY-4.0', source: 'khronos' });
  assert.equal(root.userData.credits.length, 1);
  recordCredit(root, { id: 'y', name: 'BoomBox', author: 'Khronos', license: 'CC0-1.0', source: 'khronos' });
  assert.equal(root.userData.credits.length, 2);
  const text = formatCredits(root);
  assert.ok(text.includes('theblueturtle_') && text.includes('CC-BY-4.0'));
  assert.ok(formatCredits({ userData: {} }).includes('Chưa dùng'));
});

await test('studio-catalog.json provides categorized CC0 materials, environments, vegetation, characters and zero Epic bytes', () => {
  const studio = JSON.parse(fs.readFileSync(new URL('../assets/library/studio-catalog.json', import.meta.url), 'utf8'));
  const raw = JSON.stringify(studio.items).toLowerCase();
  for (const bad of [/(?:^|[^a-z0-9-])fab\.com/, /epicgames/, /megascans/, /quixel/, /unrealengine/]) {
    assert.ok(!bad.test(raw), `studio-catalog dính nguồn Epic/Fab: ${bad}`);
  }
  assert.ok(studio.items.length >= 2000, `cần >= 2000 asset phân loại, nhận ${studio.items.length}`);
  const cats = new Set(studio.items.map((it) => it.studioCategory));
  for (const requiredCat of ['materials', 'environments', 'vegetation', 'architecture', 'characters', 'props']) {
    assert.ok(cats.has(requiredCat), `thiếu danh mục studioCategory=${requiredCat}`);
  }
});

await test('importAssetFile dispatches by extension and rejects unsupported formats', async () => {
  const calls = [];
  const exporter = {
    importGLTF: async (f) => { calls.push(['gltf', f.name]); return { ok: 1 }; },
    importFBX: async (f) => { calls.push(['fbx', f.name]); return { ok: 1 }; },
    importOBJ: async (f) => { calls.push(['obj', f.name]); return { ok: 1 }; },
  };
  await importAssetFile({ name: 'a.glb' }, { exporter });
  await importAssetFile({ name: 'av.vrm' }, { exporter });
  await importAssetFile({ name: 'b.fbx' }, { exporter });
  await importAssetFile({ name: 'c.obj' }, { exporter });
  assert.deepEqual(calls.map((c) => c[0]), ['gltf', 'gltf', 'fbx', 'obj']);
  await assert.rejects(() => importAssetFile({ name: 'd.uasset' }, { exporter }), /chưa hỗ trợ/);
});

await test('resolvePolyHavenTextureFiles maps variant diffuse (col_1/coll1), Metal, arm fallback & nor_dx flip', () => {
  const mk = (url) => ({ '1k': { jpg: { url } } });

  // fabric_pattern_07 style (col_1, col_2, col_03 — no Diffuse key)
  const fabric = resolvePolyHavenTextureFiles({
    col_2: mk('https://cdn.example/col2.jpg'),
    col_1: mk('https://cdn.example/col1.jpg'),
    nor_gl: mk('https://cdn.example/nor_gl.jpg'),
    Rough: mk('https://cdn.example/rough.jpg'),
    AO: mk('https://cdn.example/ao.jpg'),
  });
  assert.equal(fabric.diffuseUrl, 'https://cdn.example/col1.jpg');
  assert.equal(fabric.normalFlipY, false);
  assert.equal(fabric.metalnessUrl, null);

  // leather_red_02 style (coll1, coll2 — Poly Haven typo)
  const leather = resolvePolyHavenTextureFiles({
    coll2: mk('https://cdn.example/coll2.jpg'),
    coll1: mk('https://cdn.example/coll1.jpg'),
    nor_dx: mk('https://cdn.example/nor_dx.jpg'),
    arm: mk('https://cdn.example/arm.jpg'),
  });
  assert.equal(leather.diffuseUrl, 'https://cdn.example/coll1.jpg');
  assert.equal(leather.normalUrl, 'https://cdn.example/nor_dx.jpg');
  assert.equal(leather.normalFlipY, true);
  assert.equal(leather.roughnessUrl, 'https://cdn.example/arm.jpg');
  assert.equal(leather.aoUrl, 'https://cdn.example/arm.jpg');

  // metal_plate style (Metal channel must not be ignored)
  const metal = resolvePolyHavenTextureFiles({
    Diffuse: mk('https://cdn.example/diff.jpg'),
    Metal: mk('https://cdn.example/metal.jpg'),
    Rough: mk('https://cdn.example/rough.jpg'),
    nor_gl: mk('https://cdn.example/nor_gl.jpg'),
  });
  assert.equal(metal.metalnessUrl, 'https://cdn.example/metal.jpg');
  assert.equal(metal.diffuseUrl, 'https://cdn.example/diff.jpg');
});

await test('normalizeAndPlaceAsset normalizes extreme sizes, grounds minY=0, keeps characters upright & avoids overlap', () => {
  const scene = new THREE.Scene();
  const sm = new SceneManager(scene);
  const existing = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial());
  existing.position.set(0, 0.5, 0);
  sm.addObject(existing);

  // 1. Tiny 0.02m BoomBox prop -> scaled up to ~1.0m, grounded at Y=0, placed clear of existing Cube
  const tinyProp = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.02, 0.01), new THREE.MeshStandardMaterial());
  sm.addObject(tinyProp);
  const bTiny = normalizeAndPlaceAsset(tinyProp, { category: 'props', sceneManager: sm });
  assert.ok(Math.abs(Math.max(bTiny.size.x, bTiny.size.y, bTiny.size.z) - 1.0) < 1e-3, 'tiny prop scaled to 1m');
  assert.ok(Math.abs(bTiny.box.min.y) < 1e-4, 'tiny prop seated flush on Y=0');
  assert.ok(Math.hypot(bTiny.center.x, bTiny.center.z) >= 1.2, 'double-click spawns beside existing cube instead of inside it');

  // 2. Giant sunk 47m off-origin architecture (Church_Interior_Scan) -> normalized to 6m, centered, minY=0
  const giantGeo = new THREE.BoxGeometry(41.7, 47.7, 17.6);
  giantGeo.translate(12, -20.1 + 47.7 * 0.5, -8);
  const giantArch = new THREE.Mesh(giantGeo, new THREE.MeshStandardMaterial());
  sm.addObject(giantArch);
  const bArch = normalizeAndPlaceAsset(giantArch, { category: 'architecture', sceneManager: sm });
  assert.ok(Math.abs(Math.max(bArch.size.x, bArch.size.y, bArch.size.z) - 6.0) < 1e-2, 'giant arch scaled to 6m');
  assert.ok(Math.abs(bArch.box.min.y) < 1e-3, 'giant arch grounded at Y=0');
  assert.ok(Math.hypot(bArch.center.x, bArch.center.z) < 1e-3, 'large arch centered on origin');

  // 3. Normal 1.66m character keeps 1:1 scale & stays upright even if alignToNormal=true on wall drop
  const charMesh = new THREE.Mesh(new THREE.BoxGeometry(0.6, 1.66, 0.4), new THREE.MeshStandardMaterial());
  const wallQuat = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(1, 0, 0));
  const bChar = normalizeAndPlaceAsset(charMesh, {
    category: 'characters',
    alignToNormal: true,
    dropInfo: { position: new THREE.Vector3(2, 0, 0), normal: new THREE.Vector3(1, 0, 0), quaternion: wallQuat, hitGeometry: true },
  });
  assert.ok(Math.abs(bChar.size.y - 1.66) < 1e-3, 'normal-height character keeps 1:1 scale');
  assert.ok(charMesh.quaternion.angleTo(new THREE.Quaternion()) < 1e-5, 'character stays upright on drop');

  // 4. Prop dropped on vertical wall seats flush against wall (not half-buried)
  const wallBox = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial());
  const bWall = normalizeAndPlaceAsset(wallBox, {
    category: 'props',
    normalizeScale: false,
    dropInfo: { position: new THREE.Vector3(0.5, 1, 0), normal: new THREE.Vector3(1, 0, 0), quaternion: wallQuat, hitGeometry: true },
  });
  assert.ok(Math.abs(bWall.box.min.x - 0.5) < 1e-3, 'wall-dropped box rests against surface without sinking');

  // 5. Horizon ground drop clamped <= 12m & UV generator works on UV-less mesh
  const cam = new THREE.PerspectiveCamera(45, 1.6, 0.1, 1000);
  cam.position.set(0, 1.5, 5);
  cam.lookAt(0, 1.48, -100);
  cam.updateMatrixWorld(true);
  const horizonDrop = pickDropTransformOnScene(new THREE.Scene(), cam, 0, 0, false);
  assert.ok(Math.hypot(horizonDrop.position.x, horizonDrop.position.z) <= 12.01, 'horizon drop clamped <= 12m');

  const noUvGeo = new THREE.BoxGeometry(1, 1, 1);
  noUvGeo.deleteAttribute('uv');
  assert.equal(ensureGeometryUVs(noUvGeo), true);
  assert.ok(noUvGeo.attributes.uv && noUvGeo.attributes.uv.count === noUvGeo.attributes.position.count);
  assert.ok(Array.from(noUvGeo.attributes.uv.array).every(Number.isFinite));
});

console.log(`\nSummary: ${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.error('FAILED:', failures.join(' | '));
  process.exit(1);
}
console.log('ALL ASSET LIBRARY TESTS PASSED');