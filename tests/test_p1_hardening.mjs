import assert from 'node:assert/strict';
import * as THREE from '../vendor/three/three.module.js';
import { ProceduralTextureClient } from '../js/render/procedural-texture-client.js';
import { textureLeaseRegistry } from '../js/render/texture-lease-registry.js';
import { RapidStudio } from '../js/scripting/rapid-api.js';
import { SceneManager } from '../js/core/scene-manager.js';
import { MaterialStudio } from '../js/core/material-studio.js';
import { inspectSceneBudget } from '../js/core/scene-budget.js';
import { addModifier, scrubModifier, bakeModifiers, getStack, clearStackCache } from '../js/core/modifier-stack.js';
import { StudioExporter } from '../js/exporters/export-import.js';
import { validateExecNodes } from '../js/agent/agent-api.js';
import { __copilotRuntimeInternals } from '../js/ai/copilot-runtime.js';

let passed = 0;
async function test(name, fn) {
  await fn();
  console.log(`  PASS: ${name}`);
  passed++;
}

console.log('=== Round-4 P1 Hardening Verification Suite (Cache/PBR/Lease/Budget/Scrub/Export) ===');

await test('1. ProceduralTextureClient cache key distinguishes NaN vs null vs Infinity', () => {
  const client = new ProceduralTextureClient();
  const kNaN = client.getCacheKey('noise', 64, 64, { seed: NaN });
  const kNull = client.getCacheKey('noise', 64, 64, { seed: null });
  const kInf = client.getCacheKey('noise', 64, 64, { seed: Infinity });
  assert.notEqual(kNaN, kNull, 'NaN and null must never share a cache key');
  assert.notEqual(kNaN, kInf, 'NaN and Infinity must never share a cache key');
  client.dispose();
});

await test('2. RapidStudio applyProceduralPBR preserves aoMap/metalnessMap/physical state & rejects "NaN" params', async () => {
  const scene = new THREE.Scene();
  const rapid = new RapidStudio({ scene, camera: new THREE.PerspectiveCamera(), THREE });
  const aoTex = new THREE.DataTexture(new Uint8Array([200, 200, 200, 255]), 1, 1);
  const physMat = new THREE.MeshPhysicalMaterial({ color: 0xffffff, aoMap: aoTex, clearcoat: 0.7, thickness: 1.5, ior: 1.45 });
  const mesh = rapid.addCube({ name: 'PhysCube', material: physMat });

  await rapid.applyProceduralPBR(mesh, {
    pattern: 'ashlar_stone',
    resolution: 64,
    repeatX: 'NaN',
    normalScale: 'NaN',
    roughness: 'NaN',
  });
  assert.equal(mesh.material.isMeshPhysicalMaterial, true, 'kept MeshPhysicalMaterial');
  assert.strictEqual(mesh.material.aoMap, aoTex, 'preserved aoMap');
  assert.equal(mesh.material.clearcoat, 0.7, 'preserved clearcoat');
  assert.equal(mesh.material.thickness, 1.5, 'preserved thickness');
  assert.ok(Number.isFinite(mesh.material.roughness), 'roughness is finite despite "NaN" input');
  assert.ok(Number.isFinite(mesh.material.normalScale.x), 'normalScale is finite despite "NaN" input');
  assert.ok(Number.isFinite(mesh.material.map.repeat.x), 'repeat.x is finite despite "NaN" input');
});

await test('3. Lease ownership survives shared material reapply & transfers cleanly on material.clone()', async () => {
  const scene = new THREE.Scene();
  const rapid = new RapidStudio({ scene, camera: new THREE.PerspectiveCamera(), THREE });
  const m1 = rapid.addCube({ name: 'ShareA' });
  const m2 = rapid.addCube({ name: 'ShareB' });
  await rapid.applyProceduralPBR([m1, m2], { pattern: 'ashlar_stone', resolution: 64 });
  const sharedMat = m1.material;
  m2.material = sharedMat;
  const entry = [...rapid._procTexClient.cache.values()][0];
  const initialLeases = entry.leases;
  assert.ok(initialLeases >= 1, 'active lease held');

  // Reapply ONLY on m1; m2 still uses sharedMat so sharedMat lease must NOT be prematurely dropped
  await rapid.applyProceduralPBR(m1, { pattern: 'wood_grain', resolution: 64 });
  assert.ok(entry.leases >= 1, 'old lease remains active while m2 still references sharedMat');

  // Cloning a leased material acquires its own lease and releases cleanly on dispose
  const cloned = m1.material.clone();
  const woodEntry = [...rapid._procTexClient.cache.values()].find((e) => e !== entry);
  assert.equal(woodEntry.leases, 2, 'clone acquires second lease');
  cloned.dispose();
  assert.equal(woodEntry.leases, 1, 'disposing clone releases only its own lease');
});

await test('4. inspectSceneBudget counts multi-material group draw calls & InstancedMesh matrix bytes', () => {
  const scene = new THREE.Scene();
  const g = new THREE.BoxGeometry(1, 1, 1);
  g.clearGroups();
  g.addGroup(0, 18, 0);
  g.addGroup(18, 18, 1);
  const m0 = new THREE.MeshStandardMaterial({ color: 0xff0000 });
  const m1 = new THREE.MeshStandardMaterial({ color: 0x00ff00 });
  scene.add(new THREE.Mesh(g, [m0, m1]));
  const inst = new THREE.InstancedMesh(new THREE.BoxGeometry(0.1, 0.1, 0.1), m0, 10000);
  scene.add(inst);
  const report = inspectSceneBudget(scene, { tier: 'architecture' });
  assert.equal(report.drawCalls, 3, '2 material groups + 1 InstancedMesh = 3 draw calls');
  assert.ok(report.estimatedGlbMB >= 0.65, `10k instance matrices (~0.64MB) reflected in estimatedGlbMB (${report.estimatedGlbMB}MB)`);
});

await test('5. scrubModifier & bakeModifiers roll back cleanly when aborted', async () => {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial());
  await addModifier(mesh, 'bevel', { amount: 0.08, segments: 1 });
  const prevGeom = mesh.geometry;
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(() => scrubModifier(mesh, 0, { amount: 0.2 }, { signal: ac.signal }), /abort/i);
  assert.equal(getStack(mesh)[0].params.amount, 0.08, 'scrub abort restored previous modifier param');
  assert.equal(mesh.geometry, prevGeom, 'scrub abort restored previous geometry');

  await assert.rejects(() => bakeModifiers(mesh, 0, { signal: ac.signal }), /abort/i);
  assert.equal(getStack(mesh).length, 1, 'bake abort preserved modifier stack');
});

await test('6. StudioExporter exportGLTF mutex blocks overlapping concurrent exports with E_BUSY', async () => {
  const scene = new THREE.Scene();
  scene.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial()));
  const exporter = new StudioExporter({ scene, THREE });
  exporter._exportInProgress = true;
  await assert.rejects(
    () => exporter.exportGLTF(scene, { binary: true, download: false }),
    (err) => err?.code === 'E_BUSY',
    'concurrent exportGLTF rejected with E_BUSY'
  );
  exporter._exportInProgress = false;
});

await test('7. TextureLeaseRegistry protects pooled textures across SceneManager.disposeMaterial & MaterialStudio.upgradeToPhysicalMaterial', async () => {
  const scene = new THREE.Scene();
  const sm = new SceneManager(scene);
  const rapid = new RapidStudio({ scene, sceneManager: sm, camera: new THREE.PerspectiveCamera(), THREE });
  const m1 = rapid.addCube({ name: 'LeaseMeshA' });
  const m2 = rapid.addCube({ name: 'LeaseMeshB' });
  await rapid.applyProceduralPBR([m1, m2], { pattern: 'ashlar_stone', resolution: 64 });
  const entry = [...rapid._procTexClient.cache.values()][0];
  let diffuseDisposed = false;
  const origDispose = entry.diffuseTexture.dispose.bind(entry.diffuseTexture);
  entry.diffuseTexture.dispose = () => { diffuseDisposed = true; origDispose(); };

  // Upgrade m1 material Standard -> Physical: lease must transfer cleanly without leaking or dropping to 0
  const ms = new MaterialStudio(THREE);
  const oldMat1 = m1.material;
  const upgraded = ms.upgradeToPhysicalMaterial(oldMat1, { clearcoat: 0.4 });
  m1.material = upgraded;
  assert.ok(entry.leases >= 1, 'lease survives Standard -> Physical upgrade');
  assert.ok(textureLeaseRegistry.getLease(upgraded), 'upgraded Physical material holds transferred lease');
  assert.equal(textureLeaseRegistry.getLease(oldMat1), null, 'source material lease released cleanly on transfer');

  // Disposing m1 via SceneManager must NEVER dispose the cache-owned diffuseTexture while cached/shared
  sm.disposeMaterial(m1.material, m1);
  assert.equal(diffuseDisposed, false, 'SceneManager.disposeMaterial must NOT prematurely dispose pooled procedural texture');

  // Even after disposing m2, texture remains owned by cache until clearCache/eviction
  sm.disposeMaterial(m2.material, m2);
  assert.equal(diffuseDisposed, false, 'cached entry textures stay alive until cache eviction/clear');
  assert.equal(entry.leases, 0, 'all material leases returned to 0 cleanly');
  rapid._procTexClient.clearCache({ force: true });
  assert.equal(diffuseDisposed, true, 'clearCache disposes textures once unregistered from registry');
});

await test('8. applyProceduralPBR preserves full material flags, supports multi-material slotIndex, and supports 1-step Undo/Redo', async () => {
  const scene = new THREE.Scene();
  const sm = new SceneManager(scene);
  const rapid = new RapidStudio({ scene, sceneManager: sm, camera: new THREE.PerspectiveCamera(), THREE });
  const slot0 = new THREE.MeshPhysicalMaterial({
    color: 0xffffff,
    clearcoat: 0.8,
    clearcoatNormalScale: new THREE.Vector2(0.35, 0.35),
    normalMapType: THREE.ObjectSpaceNormalMap,
    alphaHash: true,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: 2,
  });
  const slot1 = new THREE.MeshStandardMaterial({ color: 0x00ff00, name: 'UntouchedSlot1' });
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), [slot0, slot1]);
  mesh.name = 'MultiSlotBox';
  sm.addObject(mesh, null, false, false);

  await rapid.applyProceduralPBR(mesh, { pattern: 'wood_grain', resolution: 64, slotIndex: 0 });
  assert.strictEqual(mesh.material[1], slot1, 'slotIndex=0 must leave sibling slot 1 untouched');
  assert.notStrictEqual(mesh.material[0], slot0, 'slot 0 replaced with procedural material');
  assert.equal(mesh.material[0].clearcoat, 0.8, 'preserved clearcoat');
  assert.equal(mesh.material[0].clearcoatNormalScale.x, 0.35, 'preserved clearcoatNormalScale');
  assert.equal(mesh.material[0].normalMapType, THREE.ObjectSpaceNormalMap, 'preserved normalMapType');
  assert.equal(mesh.material[0].alphaHash, true, 'preserved alphaHash');
  assert.equal(mesh.material[0].depthWrite, false, 'preserved depthWrite');
  assert.equal(mesh.material[0].polygonOffset, true, 'preserved polygonOffset');

  // 1-step Undo restores slot 0 cleanly; Redo re-applies it
  sm.undo();
  assert.strictEqual(mesh.material[0], slot0, 'Undo restored exact original slot 0 material');
  assert.strictEqual(mesh.material[1], slot1, 'Undo kept slot 1 intact');
  sm.redo();
  assert.notStrictEqual(mesh.material[0], slot0, 'Redo re-applied procedural slot 0 material');
  rapid._procTexClient.dispose();
});

await test('9. mergeMeshes({ removeSources: true }) restores unregistered child descendants at exact childIndex on Undo', () => {
  const scene = new THREE.Scene();
  const sm = new SceneManager(scene);
  const rapid = new RapidStudio({ scene, sceneManager: sm, camera: new THREE.PerspectiveCamera(), THREE });
  const parentGroup = new THREE.Group();
  parentGroup.name = 'ArchAssembly';
  const keepA = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial());
  keepA.name = 'KeepFirst';
  const childB = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial());
  childB.name = 'UnregChildB';
  const keepC = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial());
  keepC.name = 'KeepLast';
  parentGroup.add(keepA, childB, keepC);
  sm.addObject(parentGroup, null, false, false);

  const regSibling = rapid.addCube({ name: 'RegSibling', x: 2 });
  const merged = rapid.mergeMeshes([childB, regSibling], { removeSources: true, name: 'MergedResult' });
  assert.ok(merged.isMesh, 'merged mesh created');
  assert.equal(parentGroup.children.includes(childB), false, 'unregistered child removed during merge');

  sm.undo();
  assert.equal(parentGroup.children.includes(childB), true, 'Undo restored unregistered child into parentGroup');
  assert.equal(parentGroup.children.indexOf(childB), 1, 'Undo restored unregistered child at exact original childIndex 1');
});

await test('10. exportGLTF abort defers restoreAll & mutex unlock until GLTFExporter.parse actually settles', async () => {
  const scene = new THREE.Scene();
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ color: 0xdddddd }));
  scene.add(mesh);
  const exporter = new StudioExporter({ scene, THREE });
  let finishParse = null;
  let downloadTriggered = false;
  exporter.triggerDownload = () => { downloadTriggered = true; };
  exporter._loadAddon = async () => ({
    GLTFExporter: class FakeGLTFExporter {
      parse(_target, onDone) {
        finishParse = () => onDone(new ArrayBuffer(16));
      }
    }
  });

  const ac = new AbortController();
  const promise = exporter.exportGLTF(scene, { binary: true, download: true, quiet: true, signal: ac.signal });
  // Wait for _loadAddon + parse invocation
  await new Promise((r) => setTimeout(r, 15));
  assert.equal(typeof finishParse, 'function', 'GLTFExporter.parse started');
  assert.equal(exporter._exportInProgress, true, 'mutex held while parsing');

  ac.abort();
  await assert.rejects(() => promise, (err) => err?.name === 'AbortError', 'caller rejects immediately with AbortError');
  // CRITICAL: mutex must STILL be held until in-flight parse settles so no overlapping export or use-after-dispose occurs
  assert.equal(exporter._exportInProgress, true, 'mutex remains locked while background parse has not settled');
  await assert.rejects(
    () => exporter.exportGLTF(scene, { binary: true, download: false }),
    (err) => err?.code === 'E_BUSY',
    'overlapping export blocked with E_BUSY while aborted parse winds down'
  );

  finishParse();
  assert.equal(exporter._exportInProgress, false, 'mutex released cleanly once parse settles');
  assert.equal(downloadTriggered, false, 'aborted export never triggers download');
});

await test('11. bakeModifiers rolls back cleanly on suffix abort and clears stale stack cache', async () => {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial());
  await addModifier(mesh, 'bevel', { amount: 0.05, segments: 1 });
  await addModifier(mesh, 'solidify', { thickness: 0.1 });
  const prevBase = mesh.userData.baseGeometry;
  const prevGeom = mesh.geometry;
  assert.equal(getStack(mesh).length, 2);

  // Trigger failure during suffix evaluation by injecting an invalid/unsupported modifier or aborted signal on 2nd eval
  let evalCalls = 0;
  const ac = new AbortController();
  const origSignal = ac.signal;
  // Pass a getter signal that succeeds for prefix (call 1) and aborts on suffix evaluation (call 2)
  const dynamicSignal = {
    get aborted() {
      evalCalls++;
      return evalCalls >= 2;
    },
    addEventListener() {},
    removeEventListener() {},
  };
  await assert.rejects(() => bakeModifiers(mesh, 0, { signal: dynamicSignal }), /abort/i);
  assert.strictEqual(mesh.userData.baseGeometry, prevBase, 'bake suffix abort restored original baseGeometry');
  assert.strictEqual(mesh.geometry, prevGeom, 'bake suffix abort restored original evaluated geometry');
  assert.equal(getStack(mesh).length, 2, 'bake suffix abort restored full 2-modifier stack');
  clearStackCache(mesh);
});

await test('12. agent.exec validateExecNodes rejects unsupported new node types (E_UNSUPPORTED) and allows valid primitives/lights', () => {
  assert.throws(
    () => validateExecNodes([{
      uuid: 'u-bad-area',
      type: 'RectAreaLight',
      name: 'BadAreaLight',
      position: [0, 0, 0],
      quaternion: [0, 0, 0, 1],
      scale: [1, 1, 1],
    }]),
    (err) => err?.code === 'E_UNSUPPORTED',
    'unsupported new node type RectAreaLight rejected with E_UNSUPPORTED'
  );
  const okSet = validateExecNodes([{
    uuid: 'u-ok-mesh',
    type: 'Mesh',
    name: 'OkMesh',
    position: [0, 0, 0],
    quaternion: [0, 0, 0, 1],
    scale: [1, 1, 1],
  }]);
  assert.equal(okSet.has('u-ok-mesh'), true, 'valid Mesh accepted');
});

await test('13. CopilotRuntime LIVE resolver targets EditMode.targetMesh (not active object) & metadata catches user selection conflict', async () => {
  const { resolveLiveCommandTargets, dispatchLiveCommands, LIVE_COMMAND_META } = __copilotRuntimeInternals;
  const scene = new THREE.Scene();
  const sm = new SceneManager(scene);
  const objA = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial());
  objA.name = 'ActiveA';
  const objB = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial());
  objB.name = 'EditTargetB';
  sm.addObject(objA, null, false, false);
  sm.addObject(objB, null, false, false);
  sm.setSelection([objA]);

  const editMode = { isActive: true, targetMesh: objB };
  const targets = resolveLiveCommandTargets('studio.extrude', [], { sceneManager: sm, editMode });
  assert.ok(targets.includes(objB), 'resolveLiveCommandTargets captures EditMode.targetMesh B even when active object is A');
  assert.equal(Boolean(LIVE_COMMAND_META['studio.setShadingMode']?.mutatesSelection), false, 'non-selection command metadata disables selection mutation');
  assert.equal(Boolean(LIVE_COMMAND_META['studio.addCamera']?.mutatesScene), true, 'addCamera metadata flags scene mutation');

  // Verify user selection change during a non-selection LIVE command triggers E_TX_CONFLICT
  const liveObjects = new Map([[objA.uuid, objA], [objB.uuid, objB]]);
  const ctx = {
    sceneManager: sm,
    THREE,
    studio: {
      setShadingMode() {
        // Simulate external user changing selection while non-selection LIVE command runs
        sm.setSelection([objB]);
        return true;
      },
      addCamera() {
        const cam = new THREE.Group();
        cam.name = 'AddedCam';
        sm.addObject(cam, null, false, false);
        throw new Error('simulated post-add failure');
      },
    },
  };
  await assert.rejects(
    () => dispatchLiveCommands([{ method: 'studio.setShadingMode', args: ['material'] }], ctx, liveObjects),
    (err) => err?.code === 'E_TX_CONFLICT',
    'selection change during non-selection LIVE command raises E_TX_CONFLICT'
  );

  // Verify newly added camera is recorded in batch & cleaned up on rollback when addCamera fails
  sm.beginBatch('TestAddCamRollback');
  let threw = false;
  try {
    await dispatchLiveCommands([{ method: 'studio.addCamera', args: [{}] }], ctx, liveObjects);
  } catch (_) {
    threw = true;
  }
  assert.equal(threw, true, 'failing addCamera throws');
  const batch = sm.endBatch();
  if (batch) batch.undo();
  assert.equal(sm.rootContainer.getObjectByName('AddedCam'), undefined, 'rolled back addCamera removes leaked camera cleanly');
});

await test('14. Copilot LIVE studio.addCamera succeeds with real CameraManager, preserves undoStack, and undoes/redoes cleanly', async () => {
  const { dispatchLiveCommands, LIVE_COMMAND_META, CopilotObjectCommand, captureDescriptor, dataSize } = __copilotRuntimeInternals;
  const { CameraManager } = await import('../js/core/camera-manager.js');
  assert.equal(Boolean(LIVE_COMMAND_META['studio.addCamera']?.mutatesSelection), true, 'addCamera metadata includes mutatesSelection');
  const prevWin = globalThis.window;
  globalThis.window = { dispatchEvent() {}, addEventListener() {}, removeEventListener() {} };
  try {
    const scene = new THREE.Scene();
    const engine = { scene, camera: new THREE.PerspectiveCamera(50, 1.6, 0.1, 1000), requestRender() {}, updateViewportCameraLabel() {} };
    const sm = new SceneManager(scene, engine);
    const cm = new CameraManager(engine, { sceneManager: sm });

    // Starter scene with a Cube + default Camera (whose userData.cameraHelper points into engine.scene)
    const cube = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial());
    cube.name = 'StarterCube';
    sm.addObject(cube, null, false, true);
    const defaultCam = cm.createCamera({ name: 'Camera', position: { x: 6, y: 4, z: 8 }, target: { x: 0, y: 1, z: 0 } });
    sm.setSelection([cube]);

    // Verify dataSize/CopilotObjectCommand on a camera with live cameraHelper never walks engine.scene (>64 MB eviction bug)
    const camDesc = captureDescriptor(defaultCam);
    const estBytes = dataSize(camDesc.userData);
    assert.ok(estBytes < 16384, `Camera userData dataSize stays bounded (got ${estBytes})`);
    const camUpdateCmd = new CopilotObjectCommand(defaultCam, camDesc, camDesc, sm.rootContainer, sm.rootContainer);
    assert.ok(camUpdateCmd.bytes < 32768, `CopilotObjectCommand bytes stays bounded (got ${camUpdateCmd.bytes})`);

    const liveObjects = new Map([[cube.uuid, cube], [defaultCam.uuid, defaultCam]]);
    const ctx = {
      sceneManager: sm,
      engine,
      THREE,
      studio: {
        addCamera(opts = {}) {
          return cm.createCamera({
            name: opts.name || 'HeroCamera',
            position: { x: opts.x ?? 5, y: opts.y ?? 3, z: opts.z ?? 7 },
            target: { x: opts.targetX ?? 0, y: opts.targetY ?? 1, z: opts.targetZ ?? 0 },
            fov: opts.fov ?? 50,
          });
        },
      },
    };

    const stackBefore = sm.undoStack.length;
    sm.beginBatch('AI Copilot Generation');
    sm.recordExecutedCommand(camUpdateCmd);
    const dispatched = await dispatchLiveCommands([{ method: 'studio.addCamera', args: [{ name: 'HeroCamera', x: 5, y: 3, z: 7 }] }], ctx, liveObjects);
    const tx = sm.endBatch();

    assert.equal(dispatched.mutatedSelection, true, 'dispatched records mutatedSelection');
    assert.ok(tx, 'batch transaction recorded');
    assert.equal(sm.undoStack.length, stackBefore + 1, 'undoStack kept prior history and pushed Copilot transaction');
    const addedCam = sm.rootContainer.getObjectByName('HeroCamera');
    assert.ok(addedCam, 'HeroCamera exists in scene after Copilot addCamera');
    assert.strictEqual(sm.getActiveObject(), addedCam, 'HeroCamera is actively selected');
    assert.ok(cm.cameras.some((c) => c.group === addedCam), 'HeroCamera registered in CameraManager');

    // Undo removes HeroCamera cleanly from scene and CameraManager
    sm.undo();
    assert.equal(sm.rootContainer.getObjectByName('HeroCamera'), undefined, 'Undo removes HeroCamera from scene');
    assert.equal(sm.findObjectByName('HeroCamera'), null, 'Undo removes HeroCamera from SceneManager objects');
    assert.equal(cm.cameras.some((c) => c.group === addedCam), false, 'Undo removes HeroCamera from CameraManager');

    // Redo restores HeroCamera cleanly
    sm.redo();
    assert.ok(sm.rootContainer.getObjectByName('HeroCamera'), 'Redo restores HeroCamera');
    assert.ok(cm.cameras.some((c) => c.group === addedCam), 'Redo re-adopts HeroCamera in CameraManager');
  } finally {
    globalThis.window = prevWin;
  }
});

await test('15. Copilot LIVE studio.batchToInstances detaches stale TransformControls, selects scatter group, and undoes cleanly', async () => {
  const { dispatchLiveCommands, isAttachedToSceneRoot } = __copilotRuntimeInternals;
  const { InstancingSystem } = await import('../js/core/instancing-system.js');
  const scene = new THREE.Scene();
  const sm = new SceneManager(scene);
  const srcA = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ color: 0x3366ff }));
  srcA.name = 'Pillar_A';
  const srcB = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ color: 0x3366ff }));
  srcB.name = 'Pillar_B';
  srcB.position.set(2, 0, 0);
  sm.addObject(srcA, null, false, false);
  sm.addObject(srcB, null, false, false);
  sm.setSelection([srcA, srcB]);

  // Simulate TransformControls attached to srcA before batchToInstances removes srcA
  let detachCount = 0;
  const fakeTc = {
    object: srcA,
    visible: true,
    detach() {
      detachCount += 1;
      this.object = null;
      this.visible = false;
    },
    attach(obj) {
      this.object = obj;
      this.visible = true;
    },
  };
  const fakeEngine = { scene, sceneManager: sm, transformControls: fakeTc, markShadowDirty() {}, requestRender() {} };
  const instSys = new InstancingSystem(fakeEngine);

  const liveObjects = new Map([[srcA.uuid, srcA], [srcB.uuid, srcB]]);
  const ctx = {
    sceneManager: sm,
    engine: fakeEngine,
    THREE,
    studio: {
      batchToInstances(meshes) {
        return instSys.batchMeshesToInstanceGroupSync(meshes, { sceneManager: sm });
      },
    },
  };

  sm.beginBatch('CopilotBatchToInstances');
  const dispatched = await dispatchLiveCommands([{ method: 'studio.batchToInstances', args: [[{ __copilotObject: srcA.uuid }, { __copilotObject: srcB.uuid }]] }], ctx, liveObjects);
  sm.endBatch();

  const scatterGroup = dispatched.results[0];
  assert.ok(scatterGroup?.userData?.isScatterGroup, 'InstancedScatterGroup created');
  assert.equal(srcA.parent, null, 'source mesh A detached from scene');
  assert.equal(srcB.parent, null, 'source mesh B detached from scene');
  assert.ok(detachCount >= 1, 'TransformControls detached from removed source mesh');
  assert.ok(!fakeTc.object || isAttachedToSceneRoot(fakeTc.object, sm.rootContainer), 'TransformControls never points to detached source');
  assert.strictEqual(sm.getActiveObject(), scatterGroup, 'active selection switched to scatter group');

  // Undo restores sources cleanly
  sm.undo();
  assert.equal(scatterGroup.parent, null, 'Undo removes scatter group');
  assert.strictEqual(srcA.parent, sm.rootContainer, 'Undo restores source A');
  assert.strictEqual(srcB.parent, sm.rootContainer, 'Undo restores source B');
});

console.log(`ALL ${passed} ROUND-5 P1 HARDENING TESTS PASSED`);
