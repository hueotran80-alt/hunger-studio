import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Worker } from 'node:worker_threads';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import * as THREE from 'three';
import {
  serializeScene,
  sanitizeScenePayload,
  scenePayloadSize,
  validateScenePayload,
} from '../js/ai/copilot-serialization.js';
import { __copilotRuntimeInternals } from '../js/ai/copilot-runtime.js';
import { AICopilot } from '../js/ai/ai-copilot.js';

const workerSource = readFileSync(resolve('js/ai/copilot-exec-worker.js'), 'utf8');
const workerCode = [
  "import { parentPort } from 'node:worker_threads';",
  workerSource
    .replace("from '../../vendor/three/three.module.js'", `from '${pathToFileURL(resolve('vendor/three/three.module.js')).href}'`)
    .replace("from '../../vendor/three/addons/utils/SkeletonUtils.js'", `from '${pathToFileURL(resolve('vendor/three/addons/utils/SkeletonUtils.js')).href}'`)
    .replace("from './copilot-serialization.js'", `from '${pathToFileURL(resolve('js/ai/copilot-serialization.js')).href}'`)
    .replace("from './copilot-guard.js'", `from '${pathToFileURL(resolve('js/ai/copilot-guard.js')).href}'`)
    .replace("from '../core/pbr-preset-defs.js'", `from '${pathToFileURL(resolve('js/core/pbr-preset-defs.js')).href}'`)
    .replace("from '../core/geometry/parametric-cad.js'", `from '${pathToFileURL(resolve('js/core/geometry/parametric-cad.js')).href}'`)
    .replace("from '../core/scene-budget.js'", `from '${pathToFileURL(resolve('js/core/scene-budget.js')).href}'`)
    .replace(/\bself\b/g, 'globalThis')
    .replace('const send = globalThis.postMessage.bind(globalThis);', 'const send = message => parentPort.postMessage(message);'),
  "parentPort.on('message', data => globalThis.onmessage({ data }));",
].join('\n');

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`ok   ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL ${name}\n     ${error?.stack || error}`);
  }
}

function emptyRoot() {
  const root = new THREE.Group();
  root.name = 'Scene_Collection';
  root.userData.isSystemObject = true;
  return root;
}

function runWorker(code, { scene = serializeScene(emptyRoot()), selection = [], camera = null, assetResponder = null, waitForAnimation = false } = {}) {
  return new Promise((resolveRun, reject) => {
    const worker = new Worker(workerCode, { eval: true });
    const logs = [];
    const animations = [];
    let result = null;
    let settled = false;
    let timer;
    let animationResolve;
    const animationPromise = waitForAnimation
      ? new Promise((resolveAnimation) => { animationResolve = resolveAnimation; })
      : Promise.resolve();
    const finish = async (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        if (waitForAnimation && result?.kind === 'result') await animationPromise;
        await worker.terminate();
        fn(value);
      } catch (error) {
        reject(error);
      }
    };
    timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      worker.terminate();
      reject(new Error('Copilot test worker timed out'));
    }, 8000);
    worker.on('error', (error) => finish(reject, error));
    worker.on('message', async (message) => {
      if (message.kind === 'log') {
        logs.push(message.entry);
        return;
      }
      if (message.kind === 'animation') {
        animations.push(message);
        animationResolve?.();
        if (result) finish(resolveRun, { ...result, logs, animations });
        return;
      }
      if (message.kind === 'assetRequest') {
        try {
          if (!assetResponder) throw Object.assign(new Error('Unexpected asset request.'), { code: 'E_ASSET' });
          const response = await assetResponder(message);
          worker.postMessage({ kind: 'assetResult', id: message.id, ...response });
        } catch (error) {
          worker.postMessage({ kind: 'assetResult', id: message.id, error: { code: error.code || 'E_ASSET', message: error.message } });
        }
        return;
      }
      if (message.kind === 'error') {
        finish(reject, Object.assign(new Error(message.error?.message || 'Worker execution failed.'), { code: message.error?.code || 'E_EXECUTION' }));
        return;
      }
      if (message.kind === 'result') {
        result = message;
        if (!waitForAnimation || animations.length) finish(resolveRun, { ...result, logs, animations });
      }
    });
    worker.postMessage({ kind: 'execute', code, scene, selection, camera });
  });
}

function fixtureScene() {
  const root = emptyRoot();
  const existing = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), new THREE.MeshStandardMaterial({ color: 0x223344 }));
  existing.name = 'ExistingBox';
  existing.userData.id = 'existing-box';
  root.add(existing);
  return { root, existing, payload: serializeScene(root) };
}

console.log('\nCopilot Worker isolation suite');

await test('Worker builds primitives, accepts direct scene.add, edits and reparents existing objects', async () => {
  const { root, existing, payload } = fixtureScene();
  const result = await runWorker(`
    studio.addCube({ name: 'WorkerCube', width: 1, height: 2, depth: 3, position: { x: 1, y: 2, z: 3 } });
    const direct = new THREE.Mesh(new THREE.SphereGeometry(1), new THREE.MeshStandardMaterial({ color: 0x00ff88 }));
    direct.name = 'DirectSphere';
    scene.add(direct);
    const box = studio.getObject('ExistingBox');
    box.position.set(4, 5, 6);
    box.material.color.set('#123456');
    const group = studio.addGroup('WorkerGroup');
    group.add(direct);
    sceneManager.select(box);
    return { cube: studio.getObject('WorkerCube').name, directParent: direct.parent.name };
  `, { scene: payload });
  const clean = validateScenePayload(result.payload);
  const nodes = new Map();
  const visit = (node, parent = null) => {
    nodes.set(node.name, { node, parent });
    node.children.forEach((child) => visit(child, node.name));
  };
  visit(clean.scene);
  assert.equal(result.value.cube, 'WorkerCube');
  assert.equal(result.value.directParent, 'WorkerGroup');
  assert.deepEqual(nodes.get('WorkerCube').node.position, [1, 2, 3]);
  assert.deepEqual(nodes.get('ExistingBox').node.position, [4, 5, 6]);
  assert.equal(nodes.get('DirectSphere').parent, 'WorkerGroup');
  assert.deepEqual(result.selection, [existing.uuid]);
  const material = clean.scene.materials.find((entry) => entry.uuid === nodes.get('ExistingBox').node.material);
  assert.equal(material.color, 0x123456);
  assert.equal(nodes.get('Scene_Collection').node.children.some((child) => child.name === 'DirectSphere'), false);
  assert.ok(root.getObjectByName('ExistingBox'));
});

await test('scene.clear removes content but preserves helpers and the mirror root', async () => {
  const root = emptyRoot();
  root.add(new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial()));
  const helper = new THREE.AxesHelper(2);
  helper.userData.isHelper = true;
  root.add(helper);
  const result = await runWorker(`
    const helper = scene.children.find((child) => child.userData.isHelper);
    scene.clear();
    const group = new THREE.Group();
    group.name = 'AfterClear';
    scene.add(group);
    return { names: scene.children.map((child) => child.name), helperPreserved: scene.children.includes(helper) };
  `, { scene: serializeScene(root) });
  assert.equal(result.clearScene, true);
  assert.equal(result.value.helperPreserved, true);
  assert.ok(result.value.names.includes('AfterClear'));
  assert.equal(result.payload.scene.name, 'Scene_Collection');
  assert.equal(result.payload.scene.children.length, 2);
});

await test('Worker emits validated animation frames and reports animation state', async () => {
  const result = await runWorker(`
    const cube = studio.addCube({ name: 'AnimatedCube' });
    studio.animate((time, delta) => {
      cube.rotation.y = time;
      cube.position.x = Math.min(1, delta * 60);
    });
    return cube.name;
  `, { waitForAnimation: true });
  assert.equal(result.hasAnimations, true);
  assert.equal(result.value, 'AnimatedCube');
  assert.ok(result.animations.length > 0);
  const animated = result.animations.at(-1).nodes[0];
  assert.ok(animated);
  assert.equal(animated.position.length, 3);
  assert.equal(animated.quaternion.length, 4);
  assert.equal(animated.scale.length, 3);
  assert.equal(typeof animated.visible, 'boolean');
});

await test('Worker reconstructs skeleton metadata for generated rig code', async () => {
  const root = new THREE.Group();
  root.name = 'WorkerArmature';
  const hips = new THREE.Bone();
  hips.name = 'Hips';
  const spine = new THREE.Bone();
  spine.name = 'Spine';
  spine.position.y = 0.5;
  hips.add(spine);
  root.add(hips);
  const skeleton = new THREE.Skeleton([hips, spine]);
  root.userData.skeleton = skeleton;
  root.name = 'GeneratedRig';
  const result = await runWorker(`
    const rig = await studio.createHumanoidArmature({ name: 'GeneratedRig' });
    return {
      name: rig.armatureGroup?.name || null,
      isSkeleton: rig.skeleton instanceof THREE.Skeleton,
      bones: rig.skeleton?.bones?.length || 0,
      boneNames: (rig.skeleton?.bones || []).map((b) => b.name),
      hasInverses: Boolean(rig.skeleton?.boneInverses?.length === 2),
    };
  `, {
    assetResponder: () => ({
      assetId: 'test-armature',
      payload: serializeScene(root),
      skeletons: [{ objectUUID: root.uuid, boneUUIDs: [hips.uuid, spine.uuid] }],
    }),
  });
  assert.deepEqual(result.value, {
    name: 'GeneratedRig',
    isSkeleton: true,
    bones: 2,
    boneNames: ['Hips', 'Spine'],
    hasInverses: true,
  });
  assert.equal(result.assets.length, 1);
  const clean = validateScenePayload(result.payload);
  const rig = clean.scene.children.find((child) => child.name === 'GeneratedRig');
  assert.ok(rig);
  assert.ok(JSON.stringify(rig.children).includes('Hips'));
});

await test('Worker createPBRMaterial applies real presets/aliases and createArticulatedActor returns arm/jacket handles', async () => {
  const result = await runWorker(`
    const gold = studio.createPBRMaterial('gold_24k');
    const goldAlias = studio.createPBRMaterial('gold', { roughness: 0.22 });
    const glass = studio.createPBRMaterial('glass_crystal');
    const velvet = studio.createPBRMaterial('velvet');
    const actor = studio.createArticulatedActor({ name: 'WorkerHero', hasJacketLayer: true });
    actor.leftArm.shoulder.rotation.z = 0.5;
    actor.rightArm.elbow.rotation.x = -0.3;
    actor.jacketGroup.visible = true;
    return {
      goldHex: gold.color.getHex(),
      goldMetalness: gold.metalness,
      goldRoughness: gold.roughness,
      aliasHex: goldAlias.color.getHex(),
      aliasRoughness: goldAlias.roughness,
      glassType: glass.type,
      glassTransmission: glass.transmission,
      glassIor: glass.ior,
      velvetSheen: velvet.sheen,
      hasLeftArm: Boolean(actor.leftArm?.shoulder?.isObject3D && actor.leftArm?.elbow?.isObject3D && actor.leftArm?.hand?.isMesh),
      hasRightArm: Boolean(actor.rightArm?.shoulder?.isObject3D && actor.rightArm?.elbow?.isObject3D && actor.rightArm?.hand?.isMesh),
      jacketName: actor.jacketGroup?.name || null,
      jacketVisible: Boolean(actor.jacketGroup?.visible),
      leftRotZ: actor.leftArm.shoulder.rotation.z,
    };
  `);
  assert.equal(result.value.goldHex, 0xffd700);
  assert.equal(result.value.goldMetalness, 0.95);
  assert.equal(result.value.goldRoughness, 0.15);
  assert.equal(result.value.aliasHex, 0xffd700);
  assert.equal(result.value.aliasRoughness, 0.22);
  assert.equal(result.value.glassType, 'MeshPhysicalMaterial');
  assert.equal(result.value.glassTransmission, 0.98);
  assert.equal(result.value.glassIor, 1.52);
  assert.equal(result.value.velvetSheen, 1.0);
  assert.equal(result.value.hasLeftArm, true);
  assert.equal(result.value.hasRightArm, true);
  assert.equal(result.value.jacketName, 'WorkerHero_Jacket');
  assert.equal(result.value.jacketVisible, true);
  assert.equal(result.value.leftRotZ, 0.5);
});

await test('Worker waits for non-awaited textured asset adoption and preserves image UUID references', async () => {
  const root = new THREE.Group();
  root.name = 'TexturedAsset';
  const texture = new THREE.DataTexture(new Uint8Array([255, 0, 0, 255]), 1, 1);
  texture.needsUpdate = true;
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial({ map: texture }));
  root.add(mesh);
  const payload = serializeScene(root);
  const result = await runWorker("studio.loadGLTF('/models/textured.glb'); return 'scheduled';", {
    assetResponder: () => ({ assetId: 'textured-asset', payload, skeletons: [] }),
  });
  assert.equal(result.value, 'scheduled');
  assert.equal(result.assets.length, 1);
  const clean = validateScenePayload(result.payload);
  assert.ok(clean.scene.textures[0].image);
  assert.ok(clean.scene.images.some((image) => image.uuid === clean.scene.textures[0].image));
});

await test('Worker facades expose no live application or browser object graph', async () => {
  const result = await runWorker(`
    const read = (fn) => { try { return fn(); } catch (error) { return error.code || 'ERROR'; } };
    return {
      engineContainer: Boolean(engine.container),
      rendererDOM: Boolean(renderer.domElement),
      studioEngine: Boolean(studio._engine),
      editEngine: Boolean(editMode.engine),
      documentElement: document.createElement('div'),
      windowLocation: typeof window.location,
      computedFetch: read(() => ({}).constructor.constructor('return globalThis')().fetch),
      indexedDB: read(() => indexedDB),
      caches: read(() => caches),
      broadcast: read(() => BroadcastChannel),
      messageChannel: read(() => MessageChannel),
      cookieStore: read(() => cookieStore),
      webTransport: read(() => WebTransport),
      worker: read(() => Worker),
      navigation: read(() => location),
      websocket: read(() => WebSocket),
    };
  `);
  assert.deepEqual(result.value, {
    engineContainer: false,
    rendererDOM: false,
    studioEngine: false,
    editEngine: false,
    documentElement: null,
    windowLocation: 'undefined',
    computedFetch: 'E_PERMISSION',
    indexedDB: 'E_PERMISSION',
    caches: 'E_PERMISSION',
    broadcast: 'E_PERMISSION',
    messageChannel: 'E_PERMISSION',
    cookieStore: 'E_PERMISSION',
    webTransport: 'E_PERMISSION',
    worker: 'E_PERMISSION',
    navigation: 'E_PERMISSION',
    websocket: 'E_PERMISSION',
  });
});

await test('Worker rejects direct fetch, storage, DOM and dynamic import access', async () => {
  for (const expression of [
    "fetch('/api/cloud/projects')",
    'localStorage.clear()',
    'sessionStorage.clear()',
    "document.cookie = 'x=1'",
    'window.open("/")',
    'navigator.storage.getDirectory()',
    'import("./evil.js")',
  ]) {
    await assert.rejects(
      runWorker(`return ${expression};`),
      (error) => error?.code === 'E_PERMISSION' || error?.code === 'E_EXECUTION',
      `${expression} must be unavailable`,
    );
  }
});

await test('Live command payloads are allowlisted facades with serializable object markers', async () => {
  const { payload } = fixtureScene();
  const result = await runWorker(`
    const box = studio.getObject('ExistingBox');
    studio.enterEditMode(box);
    studio.setShadingMode('material');
    return box.name;
  `, { scene: payload });
  assert.deepEqual(result.commands.map((command) => command.method), ['studio.enterEditMode', 'studio.setShadingMode']);
  assert.equal(result.commands[0].args[0].__copilotObject, validateScenePayload(payload).scene.children[0].uuid);
  assert.equal(result.commands[1].args[0], 'material');
});

await test('Worker preserves parameterized geometry buffers and restores original resources', () => {
  const { root, existing } = fixtureScene();
  const originalGeometry = existing.geometry;
  originalGeometry.attributes.position.setX(0, 7);
  const first = serializeScene(root);
  const second = serializeScene(root);
  assert.equal(existing.geometry, originalGeometry);
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  const geometryJSON = first.scene.geometries.find((geometry) => geometry.uuid === originalGeometry.uuid);
  assert.ok(Array.isArray(geometryJSON.data?.attributes?.position?.array));
  assert.equal(geometryJSON.data.attributes.position.array[0], 7);
  assert.equal(geometryJSON.width, undefined);
  const workerPayload = validateScenePayload(first);
  const workerGeometryJSON = workerPayload.scene.geometries.find((geometry) => geometry.uuid === originalGeometry.uuid);
  assert.ok(Array.isArray(workerGeometryJSON.data?.attributes?.position?.array));
});

await test('Serializer omits invalid null materials without mutating source objects', () => {
  const root = emptyRoot();
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(), null);
  const grouped = new THREE.Mesh(new THREE.BoxGeometry(), [new THREE.MeshStandardMaterial(), null]);
  root.add(mesh, grouped);
  const payload = serializeScene(root);
  assert.equal(mesh.material, null);
  assert.equal(grouped.material[0].isMaterial, true);
  assert.equal(grouped.material[1], null);
  assert.equal(payload.scene.children[0].material, undefined);
  assert.equal(payload.scene.children[1].material, undefined);
});

await test('Serializer restores original shared geometry and material userData', () => {
  const root = emptyRoot();
  const geometry = new THREE.BoxGeometry();
  const material = new THREE.MeshStandardMaterial();
  const metadata = { keep: true, url: '/models/local.png', nested: { value: 7 } };
  geometry.userData = metadata;
  material.userData = metadata;
  const first = new THREE.Mesh(geometry, material);
  const second = new THREE.Mesh(geometry, material);
  root.add(first, second);
  const payload = serializeScene(root);
  assert.equal(geometry.userData, metadata);
  assert.equal(material.userData, metadata);
  assert.equal(payload.scene.geometries[0].userData.keep, true);
  assert.equal(payload.scene.geometries[0].userData.url, undefined);
  assert.equal(payload.scene.materials[0].userData.url, undefined);
});

await test('Serializer removes circular metadata and external texture resource URLs', () => {
  const payload = {
    scene: {
      uuid: 'root', type: 'Group', name: 'Root', visible: true,
      position: [0, 0, 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1], children: [],
      userData: {},
      materials: [{ uuid: 'mat', type: 'MeshStandardMaterial', userData: { url: 'https://evil.example/mat', nested: { images: ['evil'] } } }],
      textures: [
        { uuid: 'tex', image: { url: 'https://evil.example/texture.png', width: 1, height: 1 } },
        { uuid: 'tex-ref', image: 'source' },
      ],
      images: [{ uuid: 'source', url: 'https://evil.example/source.png' }],
    },
    animations: [],
  };
  const clean = sanitizeScenePayload(payload);
  assert.equal(clean.scene.materials[0].userData.url, undefined);
  assert.equal(clean.scene.materials[0].userData.nested.images, undefined);
  assert.equal(clean.scene.textures[0].image.url, undefined);
  assert.equal(clean.scene.textures[0].image.width, 1);
  assert.equal(clean.scene.textures[1].image, 'source');
  assert.deepEqual(clean.scene.images[0].url, { data: [0, 0, 0, 255], width: 1, height: 1, type: 'Uint8Array' });

  const root = emptyRoot();
  root.userData.self = root.userData;
  root.userData.keep = 'yes';
  const serialized = serializeScene(root);
  assert.equal(serialized.scene.userData.keep, 'yes');
  assert.equal(serialized.scene.userData.self, undefined);
});

await test('Serializer rejects duplicate UUIDs, unsupported types and non-finite transforms', () => {
  const base = validateScenePayload(serializeScene(emptyRoot())).scene;
  assert.throws(() => validateScenePayload({ scene: { ...base, children: [{ ...base, uuid: base.uuid }] }, animations: [] }), /duplicated object UUID/);
  assert.throws(() => validateScenePayload({ scene: { ...base, type: 'Audio' }, animations: [] }), /Unsupported object type/);
  assert.throws(() => validateScenePayload({ scene: { ...base, position: [0, Number.NaN, 0] }, animations: [] }), /Invalid object position/);
});

await test('Serializer enforces the 24 MB payload limit', () => {
  const base = validateScenePayload(serializeScene(emptyRoot())).scene;
  const oversized = { scene: { ...base, userData: { value: 'x'.repeat(24 * 1024 * 1024 + 1) } }, animations: [] };
  assert.ok(scenePayloadSize(oversized) > 24 * 1024 * 1024);
  assert.throws(() => validateScenePayload(oversized), /24 MB safety limit/);
});

await test('Asset URL policy blocks cross-origin, API, traversal, cross-origin blob and unsupported protocols', () => {
  const { validAssetURL } = __copilotRuntimeInternals;
  assert.equal(validAssetURL('http://localhost/models/cube.glb'), 'http://localhost/models/cube.glb');
  assert.equal(validAssetURL('data:image/png;base64,AAAA', { image: true }), 'data:image/png;base64,AAAA');
  for (const url of [
    'https://evil.example/model.glb',
    'blob:https://evil.example/1234',
    '/api/cloud/projects',
    '/models/../api/cloud/projects',
    '/models/%2e%2e/api/cloud/projects',
    '/models/%2Fsecret',
    'file:///etc/passwd',
    'data:text/html,<script>alert(1)</script>',
  ]) assert.throws(() => validAssetURL(url), /not allowed|same-origin|traversal|protocol|GLTF|Blob/i, url);
  assert.throws(() => validAssetURL('data:image/png;base64,AAAA'), /GLTF/);

  const prevLoc = globalThis.location;
  globalThis.location = { href: 'https://studio.example.com/', origin: 'https://studio.example.com' };
  try {
    assert.equal(
      validAssetURL('blob:https://studio.example.com/abc-123'),
      'blob:https://studio.example.com/abc-123',
    );
    assert.throws(
      () => validAssetURL('blob:https://evil.example/abc-123'),
      /same-origin/i,
    );
  } finally {
    if (prevLoc === undefined) delete globalThis.location;
    else globalThis.location = prevLoc;
  }
});

await test('resolveLiveCommand binds `this` to direct parent object for nested commands', () => {
  const { resolveLiveCommand } = __copilotRuntimeInternals;
  const modifiersObj = {
    tag: 'MOD_OWNER',
    add(type) { return `${this.tag}:${type}`; },
  };
  const tutorObj = {
    tag: 'TUTOR_OWNER',
    pointAt(sel) { return `${this.tag}:${sel}`; },
  };
  const studioObj = {
    tag: 'STUDIO_ROOT',
    modifiers: modifiersObj,
    tutor: tutorObj,
    setShadingMode(mode) { return `${this.tag}:${mode}`; },
  };
  const ctx = { studio: studioObj };
  assert.equal(resolveLiveCommand('studio.modifiers.add', ctx)('bevel'), 'MOD_OWNER:bevel');
  assert.equal(resolveLiveCommand('studio.tutor.pointAt', ctx)('#btn'), 'TUTOR_OWNER:#btn');
  assert.equal(resolveLiveCommand('studio.setShadingMode', ctx)('solid'), 'STUDIO_ROOT:solid');
});

await test('Animation and command decoders reject malformed values and resolve safe markers', () => {
  const { validateAnimationMessage, decodeCommandValue } = __copilotRuntimeInternals;
  const object = new THREE.Object3D();
  const objects = new Map([[object.uuid, object]]);
  const node = { uuid: object.uuid, position: [0, 0, 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1], visible: true };
  assert.deepEqual(validateAnimationMessage({ nodes: [node] }, objects), [node]);
  assert.throws(() => validateAnimationMessage({ nodes: [{ ...node, position: [0, Infinity, 0] }] }, objects), /Invalid animation position/);
  assert.throws(() => decodeCommandValue({ __copilotObject: 'missing' }, objects, undefined, THREE), /missing object/);
  assert.equal(decodeCommandValue({ id: 'pending' }, objects, 42, THREE).id, 42);
  assert.equal(decodeCommandValue('pending_7', objects, (token) => token === 'pending_7' ? 'mod_7' : undefined, THREE), 'mod_7');
  assert.equal(decodeCommandValue({ __copilotColor: 'ff0000' }, objects, undefined, THREE).getHex(), 0xff0000);
});

await test('AICopilot đánh dấu lỗi Worker CSP là không thể auto-repair', async () => {
  const previousWindow = globalThis.window;
  const previousFetch = globalThis.fetch;
  globalThis.window = {
    sceneManager: { rootContainer: new THREE.Group() },
    scene: new THREE.Scene(),
    studio: {},
    THREE,
  };
  globalThis.fetch = async () => ({ ok: true, headers: { get: () => '' } });
  try {
    const copilot = new AICopilot({ studio: {} });
    copilot._addBotMessage = () => {};
    const ok = await copilot.executeGeneratedCode('studio.addCube({ name: "Noop" });');
    assert.equal(ok, false);
    assert.equal(copilot._lastExecutionError.code, 'E_PERMISSION');
    assert.equal(copilot._lastExecutionError.blocked, true);
  } finally {
    globalThis.window = previousWindow;
    globalThis.fetch = previousFetch;
  }
});

console.log(`\nCopilot Worker isolation: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
