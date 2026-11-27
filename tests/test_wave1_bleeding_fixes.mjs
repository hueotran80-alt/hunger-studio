/**
 * Wave 1 ("Cầm máu") Regression Suite:
 * - Film module deletion verification
 * - escapeHtml & reversed codeEditor.log XSS safety
 * - Rig .blend.json/.wbs round-trip (restQuat/restEuler/restCharQuat preserved, Skeleton/TypedArrays stripped)
 * - Unified _prepareExportState across exporters (Boolean __boolOrigMaterial, __preProceduralMaps, LOD0 restore)
 * - geometry-codec drawRange.count: Infinity -> null decode fix
 * - render-subdiv 'subdivide' modifier matching
 * - AutosaveManager idempotent beginSession & loadDraft({ hydrate: false })
 * - BlobStore dedup skip redundant packing
 * - SceneManager Alt+D shared material/texture guard, undo/redo [A->B, B->C] eviction, RemoveObjectsCommand
 * - BVH installBVHRaycast() transparent Raycaster acceleration
 * - Embed badge=0 independent of ui=1
 * Run: node --import ./tests/three-resolve-hooks.mjs tests/test_wave1_bleeding_fixes.mjs
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';

import { escapeHtml } from '../js/core/escape-html.js';
import { encodeGeometry, decodeGeometry } from '../js/core/geometry/geometry-codec.js';
import { runWithRenderSubdiv } from '../js/core/render-subdiv.js';
import { BlobStore, MemoryBlobBackend } from '../js/core/blob-store.js';
import { AutosaveManager } from '../js/core/autosave.js';
import { SceneManager, RemoveObjectsCommand } from '../js/core/scene-manager.js';
import { dataBlockRegistry } from '../js/core/data-blocks.js';
import { LODManager } from '../js/core/lod-manager.js';
import { ModifierStackCommand } from '../js/core/geometry-commands.js';
import { StudioExporter } from '../js/exporters/export-import.js';
import { RigSystem } from '../js/animation/rig-system.js';
import { installBVHRaycast, ensureBVH } from '../js/core/bvh-accelerator.js';
import { readEmbedOptions } from '../js/embed/embed-core.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`ok   ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`FAIL ${name}\n     ${err?.stack || err}`);
  }
}

function makeMockIndexedDB() {
  const databases = new Map();
  function open(dbName, version = 1) {
    const req = { result: null, error: null, onupgradeneeded: null, onsuccess: null, onerror: null };
    queueMicrotask(() => {
      let dbEntry = databases.get(dbName);
      const oldVersion = dbEntry ? dbEntry.version : 0;
      if (!dbEntry) {
        dbEntry = { version, stores: new Map() };
        databases.set(dbName, dbEntry);
      }
      const dbApi = {
        objectStoreNames: { contains: (n) => dbEntry.stores.has(n) },
        createObjectStore: (n, opts = {}) => {
          const store = { keyPath: opts.keyPath || 'id', data: new Map() };
          dbEntry.stores.set(n, store);
          return store;
        },
        close: () => {},
        onversionchange: null,
        transaction: (storeName) => {
          const storeObj = dbEntry.stores.get(storeName);
          const tx = {
            oncomplete: null,
            onerror: null,
            onabort: null,
            error: null,
            objectStore: () => ({
              put: (val) => {
                const k = val[storeObj.keyPath];
                storeObj.data.set(k, structuredClone(val));
                return { result: k };
              },
              get: (k) => ({ result: storeObj.data.has(k) ? structuredClone(storeObj.data.get(k)) : undefined }),
              getKey: (k) => ({ result: storeObj.data.has(k) ? k : undefined }),
              getAll: () => ({ result: Array.from(storeObj.data.values()).map((v) => structuredClone(v)) }),
              getAllKeys: () => ({ result: Array.from(storeObj.data.keys()) }),
              delete: (k) => { storeObj.data.delete(k); return {}; },
              clear: () => { storeObj.data.clear(); return {}; },
            }),
          };
          queueMicrotask(() => tx.oncomplete?.());
          return tx;
        },
      };
      req.result = dbApi;
      if (oldVersion < version) {
        dbEntry.version = version;
        req.onupgradeneeded?.({ oldVersion, newVersion: version });
      }
      req.onsuccess?.();
    });
    return req;
  }
  return { open, _databases: databases };
}

function makeMockLocalStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
  };
}

await test('film module is removed and app.js does not reference it', () => {
  assert.equal(fs.existsSync(path.join(ROOT, 'js/film/film-project.js')), false);
  const appSrc = fs.readFileSync(path.join(ROOT, 'js/app.js'), 'utf8');
  assert.equal(appSrc.includes('film-project'), false);
  assert.equal(appSrc.includes('createFilmProject'), false);
});

await test('escapeHtml encodes all HTML attribute and body metacharacters', () => {
  const raw = `<img src="x" onerror='alert(1)'> & test`;
  const escaped = escapeHtml(raw);
  assert.equal(escaped.includes('<'), false);
  assert.equal(escaped.includes('>'), false);
  assert.equal(escaped.includes('"'), false);
  assert.equal(escaped.includes("'"), false);
  assert.ok(escaped.includes('&amp;'));
});

await test('geometry-codec preserves Infinity drawRange across JSON.stringify null coercion', () => {
  const geom = new THREE.BoxGeometry(1, 1, 1);
  geom.setDrawRange(0, Infinity);
  const encoded = encodeGeometry(geom);
  const jsonRoundTripped = JSON.parse(JSON.stringify(encoded));
  assert.equal(jsonRoundTripped.drawRange.count, null);
  const decoded = decodeGeometry(jsonRoundTripped);
  assert.equal(decoded.drawRange.start, 0);
  assert.equal(decoded.drawRange.count, Infinity);
  geom.dispose();
  decoded.dispose();
});

await test('render-subdiv recognizes both subdivision and subdivide modifier types', async () => {
  const prevWin = globalThis.window;
  let called = false;
  globalThis.window = {
    modifiers: {
      withRenderSubdivisionLevels: async (_scene, fn) => {
        called = true;
        return await fn();
      },
    },
  };
  try {
    const scene = new THREE.Scene();
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial());
    mesh.userData.modifierStack = [{ type: 'subdivide', enabled: true, params: { levels: 1, renderLevels: 2 } }];
    scene.add(mesh);
    const result = await runWithRenderSubdiv(scene, async () => 'ok');
    assert.equal(result, 'ok');
    assert.equal(called, true);
  } finally {
    globalThis.window = prevWin;
  }
});

await test('Rig userData restQuat/restEuler/restCharQuat + timelineConfig survive exportProjectData -> importProjectJSON', async () => {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 1000);
  const sm = new SceneManager(scene);
  const exporter = new StudioExporter({ scene, camera, sceneManager: sm });

  const rootBone = new THREE.Bone();
  rootBone.name = 'Hips';
  const childBone = new THREE.Bone();
  childBone.name = 'Spine';
  childBone.position.set(0, 0.5, 0);
  childBone.rotation.set(0.25, -0.4, 0.1);
  childBone.updateMatrix();
  rootBone.add(childBone);

  childBone.userData.restQuat = childBone.quaternion.clone();
  childBone.userData.restEuler = childBone.rotation.clone();
  childBone.userData.restCharQuat = childBone.quaternion.clone();
  childBone.userData.transientTyped = new Float32Array(64);
  childBone.userData.skeleton = { isSkeleton: true, bones: [rootBone, childBone] };

  const group = new THREE.Group();
  group.name = 'TestCharacter';
  group.userData.isArmature = true;
  group.add(rootBone);
  sm.addObject(group, null, false, false);

  const projectData = exporter.exportProjectData();
  projectData.timelineConfig = { fps: 60, startFrame: 5, endFrame: 120, currentFrame: 10, loop: false, defaultInterpolation: 'linear' };
  const jsonText = JSON.stringify(projectData);

  const fakeTimeline = { fps: 30, startFrame: 0, endFrame: 250, currentFrame: 0, loop: true, defaultInterpolation: 'smooth' };
  exporter._timelineEngine = fakeTimeline;

  sm.clearScene();
  await exporter.importProjectJSON(jsonText);

  assert.equal(fakeTimeline.fps, 60);
  assert.equal(fakeTimeline.startFrame, 5);
  assert.equal(fakeTimeline.endFrame, 120);
  assert.equal(fakeTimeline.loop, false);
  assert.equal(fakeTimeline.defaultInterpolation, 'linear');

  let restoredSpine = null;
  sm.rootContainer.traverse((n) => {
    if (n.isBone && n.name === 'Spine') restoredSpine = n;
  });
  assert.ok(restoredSpine, 'Spine bone must restore');
  assert.equal(restoredSpine.userData.restQuat.isQuaternion, true);
  assert.equal(restoredSpine.userData.restEuler.isEuler, true);
  assert.equal(restoredSpine.userData.restCharQuat.isQuaternion, true);
  assert.ok(Math.abs(restoredSpine.userData.restQuat.x - childBone.quaternion.x) < 1e-5);
  assert.equal(restoredSpine.userData.transientTyped, undefined);
  assert.equal(restoredSpine.userData.skeleton, undefined);

  const rigSys = new RigSystem({ scene, sceneManager: sm, THREE });
  assert.equal(rigSys.resetPose(sm.rootContainer), true);
  assert.ok(Number.isFinite(restoredSpine.quaternion.x));
});

await test('Exporter _withExportableScene swaps bool cutter helper material & forces LOD0, then restores cleanly', async () => {
  const scene = new THREE.Scene();
  const sm = new SceneManager(scene);
  const lodMgr = new LODManager();
  const exporter = new StudioExporter({ scene, sceneManager: sm });
  exporter._engine = { lodManager: lodMgr };

  const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial({ color: 0xff0000, wireframe: true }));
  mesh.name = 'BoolCutter';
  const origPbrMat = new THREE.MeshStandardMaterial({ color: 0x00ff00 });
  origPbrMat.userData.__preProceduralMaps = { map: new THREE.Texture() };
  mesh.userData.__boolOrigMaterial = origPbrMat;

  const g0 = mesh.geometry;
  const g1 = new THREE.BoxGeometry(0.5, 0.5, 0.5);
  mesh.userData._autoLodGeoms = [g0, g1, g1];
  mesh.userData._autoLodTier = 1;
  mesh.geometry = g1;
  mesh.userData.autoLOD = { enabled: true };
  lodMgr.managedRoots.add(mesh);

  sm.addObject(mesh, null, false, false);

  let seenMat = null;
  let seenGeom = null;
  let seenPreMap = 'not-checked';
  exporter._withExportableScene(sm.rootContainer, 'obj', () => {
    seenMat = mesh.material;
    seenGeom = mesh.geometry;
    seenPreMap = '__preProceduralMaps' in origPbrMat.userData;
  });

  assert.equal(seenMat, origPbrMat, 'Export must see real PBR __boolOrigMaterial');
  assert.equal(seenGeom, g0, 'Export must force LOD0 geometry');
  assert.equal(seenPreMap, false, '__preProceduralMaps must be stripped during export');
  assert.equal(mesh.geometry, g1, 'LOD1 must restore after export');
  assert.ok(origPbrMat.userData.__preProceduralMaps?.map, '__preProceduralMaps must restore after export');
});

await test('AutosaveManager beginSession is idempotent and loadDraft supports hydrate:false', async () => {
  const mockIdb = makeMockIndexedDB();
  const mockStorage = makeMockLocalStorage();
  const blobs = new BlobStore({ backend: new MemoryBlobBackend() });

  const prev = new AutosaveManager({ indexedDB: mockIdb, blobStore: blobs, localStorage: mockStorage });
  await prev.beginSession();

  const current = new AutosaveManager({ indexedDB: mockIdb, blobStore: blobs, localStorage: mockStorage, dehydrateThresholdBytes: 32 });
  const first = await current.beginSession();
  const second = await current.beginSession();
  assert.equal(first.crashDetected, true);
  assert.equal(second.crashDetected, true, 'double beginSession must preserve crashDetected');

  let getCount = 0;
  const origGet = blobs.get.bind(blobs);
  blobs.get = async (...args) => {
    getCount += 1;
    return origGet(...args);
  };

  await current.saveDraft({
    meta: { format: 'web-blender-studio-project', schemaVersion: 5 },
    sceneGraph: {
      geometries: { g: { uuid: 'g', data: { attributes: { position: { itemSize: 3, type: 'Float32Array', array: Array.from({ length: 240 }, (_, i) => i * 0.1) } } } } },
      object: { type: 'Group', name: 'Root' },
    },
  }, { minBlobBytes: 64 });

  const metaOnly = await current.loadDraft({ hydrate: false });
  assert.ok(metaOnly && metaOnly.dehydrated === true);
  assert.equal(getCount, 0, 'loadDraft({ hydrate: false }) must not read blobs');

  const full = await current.loadDraft({ hydrate: true });
  assert.ok(full && JSON.parse(full.json).sceneGraph?.geometries?.g?.data?.attributes?.position?.array?.length === 240);
  assert.ok(getCount > 0);
});

await test('BlobStore dedup put returns deduplicated:true without re-storing', async () => {
  const blobs = new BlobStore({ backend: new MemoryBlobBackend() });
  const data = new Uint8Array(4096).fill(42);
  const r1 = await blobs.put(data);
  const r2 = await blobs.put(data);
  assert.equal(r1.deduplicated, false);
  assert.equal(r2.deduplicated, true);
  assert.equal(r1.ref, r2.ref);
});

await test('SceneManager preserves Alt+D shared material/texture when deleting sibling, protects undo/redo chain [A->B, B->C], and groups multi-delete in 1 undo step', () => {
  const scene = new THREE.Scene();
  const sm = new SceneManager(scene);

  const tex = new THREE.Texture();
  let texDisposes = 0;
  tex.dispose = () => { texDisposes += 1; };
  const sharedMat = new THREE.MeshStandardMaterial({ map: tex });
  let matDisposes = 0;
  sharedMat.dispose = () => { matDisposes += 1; };
  const sharedGeom = new THREE.BoxGeometry();
  let geomDisposes = 0;
  sharedGeom.dispose = () => { geomDisposes += 1; };

  const meshA = new THREE.Mesh(sharedGeom, sharedMat);
  meshA.name = 'A';
  const meshB = new THREE.Mesh(sharedGeom, sharedMat);
  meshB.name = 'B';
  sm.addObject(meshA, null, false, false);
  sm.addObject(meshB, null, false, false);
  dataBlockRegistry.linkMeshData(meshB, meshA, { linkMaterials: true });

  sm.removeObject(meshA, false, true);
  assert.equal(matDisposes, 0, 'Shared material must not be disposed while sibling uses it');
  assert.equal(texDisposes, 0, 'Shared texture must not be disposed while sibling uses it');
  assert.equal(geomDisposes, 0, 'Shared geometry must not be disposed while sibling uses it');

  sm.removeObject(meshB, false, true);
  assert.equal(matDisposes, 1, 'Material must dispose after last user removed');
  assert.equal(texDisposes, 1, 'Texture must dispose after last user removed');
  assert.equal(geomDisposes, 1, 'Geometry must dispose after last user removed');

  // Undo/redo chain [A->B, B->C] with maxHistory=1: evicting A->B must dispose A but keep B alive for B->C
  sm.maxHistory = 1;
  const gA = new THREE.BoxGeometry();
  const gB = new THREE.BoxGeometry();
  const gC = new THREE.BoxGeometry();
  let dA = 0, dB = 0, dC = 0;
  gA.dispose = () => { dA += 1; };
  gB.dispose = () => { dB += 1; };
  gC.dispose = () => { dC += 1; };

  const target = new THREE.Mesh(gA, new THREE.MeshBasicMaterial());
  sm.addObject(target, null, false, false);

  const cmd0 = new ModifierStackCommand({ mesh: target, before: { descriptors: [], geometry: gA }, after: { descriptors: [], geometry: gB } });
  target.geometry = gB;
  sm.executeCommand(cmd0);

  const cmd1 = new ModifierStackCommand({ mesh: target, before: { descriptors: [], geometry: gB }, after: { descriptors: [], geometry: gC } });
  target.geometry = gC;
  sm.executeCommand(cmd1);

  assert.equal(dA, 1, 'Evicted old snapshot gA must be disposed');
  assert.equal(dB, 0, 'gB still referenced by cmd1.before must stay alive');
  assert.equal(dC, 0, 'Live gC must stay alive');

  // Single-step RemoveObjectsCommand
  const m1 = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
  const m2 = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
  sm.addObject(m1, null, false, false);
  sm.addObject(m2, null, false, false);
  const delCmd = new RemoveObjectsCommand(sm, [m1, m2]);
  delCmd.execute();
  sm.executeCommand(delCmd);
  assert.equal(sm.rootContainer.children.includes(m1), false);
  assert.equal(sm.rootContainer.children.includes(m2), false);
  sm.undo();
  assert.equal(sm.rootContainer.children.includes(m1), true);
  assert.equal(sm.rootContainer.children.includes(m2), true);
});

await test('installBVHRaycast transparently accelerates THREE.Mesh.prototype.raycast without breaking SkinnedMesh', () => {
  installBVHRaycast();
  assert.equal(THREE.Mesh.prototype.raycast._wbsBVHPatched, true);
  const sphere = new THREE.Mesh(new THREE.SphereGeometry(1, 24, 16), new THREE.MeshBasicMaterial());
  sphere.updateMatrixWorld(true);
  ensureBVH(sphere);
  assert.ok(sphere.geometry.boundsTree);
  const raycaster = new THREE.Raycaster(new THREE.Vector3(0, 0, 5), new THREE.Vector3(0, 0, -1));
  const hits = raycaster.intersectObject(sphere, false);
  assert.equal(hits.length > 0, true);
  assert.ok(Math.abs(hits[0].distance - 4) < 0.05);
});

await test('embed-core honors badge=0 independently of ui=1', () => {
  const opts = readEmbedOptions(new URLSearchParams('ui=1&badge=0'));
  assert.equal(opts.ui, true);
  assert.equal(opts.badge, false);
});

console.log(`\nWave 1 Regression Suite: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
