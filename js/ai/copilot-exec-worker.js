import * as THREE from '../../vendor/three/three.module.js';
import { clone as cloneSkinned } from '../../vendor/three/addons/utils/SkeletonUtils.js';
import { sceneLoaderDocument, serializeScene, validateScenePayload } from './copilot-serialization.js';
import { scanGeneratedCode } from './copilot-guard.js';
import { buildPBRPresetMaterial } from '../core/pbr-preset-defs.js';
import {
  sample2DContour,
  applyTriplanarUV,
  applyCreaseNormals,
  computeVertexCavityAO,
  buildExtrudeGeometry,
  buildSweepGeometry,
  buildLatheGeometry,
  buildSurfaceShellGeometry,
  buildLoftGeometry,
  sampleCurve3D,
  buildCurveScatterInstances,
  mergePartGeometries,
  buildInstancedMesh,
  modifyGeometrySync,
} from '../core/geometry/parametric-cad.js';
import { inspectSceneBudget } from '../core/scene-budget.js';

const send = self.postMessage.bind(self);
const deny = () => {
  throw Object.assign(new Error('Browser, network and storage capabilities are unavailable in the Copilot worker.'), { code: 'E_PERMISSION' });
};
for (const key of [
  'fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'WebTransport', 'Worker', 'SharedWorker',
  'importScripts', 'indexedDB', 'caches', 'cookieStore', 'BroadcastChannel', 'MessageChannel',
  'MessagePort', 'navigator', 'location', 'ServiceWorker', 'FileReader', 'FileReaderSync',
  'showDirectoryPicker', 'showOpenFilePicker', 'showSaveFilePicker', 'postMessage', 'close'
]) {
  Object.defineProperty(self, key, { get: deny, configurable: false });
}

const assetRequests = new Map();
const pendingAssets = new Set();
let assetSequence = 0;
let pendingModifierSequence = 0;
let mirror;
let selection = [];
let commands = [];
let clearRequested = false;
let stopRequested = false;
let animationTimer = null;
let animationStartedAt = performance.now();
let animationLastTick = animationStartedAt;
const animationBaseline = new Map();
const animationCallbacks = [];
const assetIds = new Map();
const assetInitial = new Map();
const createdObjects = new Set();
const logEntries = [];
const MAX_LOGS = 1000;

const log = Object.freeze(Object.fromEntries(['log', 'info', 'warn', 'error', 'debug'].map((level) => [level, (...args) => {
  if (logEntries.length >= MAX_LOGS) return;
  const entry = {
    level,
    args: args.map((value) => {
      if (value?.isObject3D) return { name: value.name, type: value.type, uuid: value.uuid };
      if (typeof value === 'string') return value.slice(0, 2000);
      try { return JSON.parse(JSON.stringify(value)); } catch { return String(value); }
    }),
    ts: Date.now()
  };
  logEntries.push(entry);
  send({ kind: 'log', entry });
}])));

const MAX_ENCODE_DEPTH = 16;
const MAX_ENCODE_ARRAY = 10000;
const MAX_ENCODE_STRING = 65536;
const MAX_LIVE_COMMAND_BYTES = 2 * 1024 * 1024;
let queuedCommandBytes = 0;

function encodeValue(value, seen = new WeakSet(), depth = 0) {
  if (depth > MAX_ENCODE_DEPTH) throw Object.assign(new Error('Command argument nesting depth exceeded.'), { code: 'E_LIMIT' });
  if (value === undefined) return { __copilotUndefined: true };
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (value.length > MAX_ENCODE_STRING) throw Object.assign(new Error('Command string argument exceeds byte cap.'), { code: 'E_LIMIT' });
    return value;
  }
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (typeof value === 'function') throw Object.assign(new Error('Functions cannot be passed to live Studio commands.'), { code: 'E_INVALID_ARG' });
  if (value?.isObject3D) return { __copilotObject: value.uuid };
  if (value?.isColor) return { __copilotColor: value.getHexString() };
  if (value?.isVector3 || value?.isVector2) return { __copilotVector: value.toArray() };
  if (value?.isQuaternion) return { __copilotQuaternion: value.toArray() };
  if (Array.isArray(value)) {
    if (value.length > MAX_ENCODE_ARRAY) throw Object.assign(new Error('Command array argument exceeds item cap.'), { code: 'E_LIMIT' });
    return value.map((item) => encodeValue(item, seen, depth + 1));
  }
  if (typeof value === 'object') {
    if (seen.has(value)) throw Object.assign(new Error('Circular command arguments are not supported.'), { code: 'E_INVALID_ARG' });
    seen.add(value);
    const out = {};
    for (const [key, item] of Object.entries(value)) out[key] = encodeValue(item, seen, depth + 1);
    seen.delete(value);
    return out;
  }
  return String(value);
}

function queueLive(method, args = [], fallback = true, pendingToken = null) {
  if (commands.length >= 500) throw Object.assign(new Error('Live command limit exceeded.'), { code: 'E_LIMIT' });
  const encodedArgs = encodeValue(args);
  const estBytes = JSON.stringify(encodedArgs).length;
  if (queuedCommandBytes + estBytes > MAX_LIVE_COMMAND_BYTES) {
    throw Object.assign(new Error('Total live command payload bytes exceeded.'), { code: 'E_LIMIT' });
  }
  queuedCommandBytes += estBytes;
  commands.push({ method, args: encodedArgs, ...(pendingToken ? { pendingToken } : {}) });
  return fallback;
}

let asyncJobSequence = 0;
const pbrQueuedObjects = new WeakSet();
const pbrQueuedNames = new Set();

function queueLiveAsync(method, args = []) {
  const token = `__copilot_async_${++asyncJobSequence}`;
  queueLive(method, args, true, token);
  if (method === 'studio.applyProceduralPBR' && args.length > 0) {
    const tgt = args[0];
    if (tgt?.isObject3D) {
      pbrQueuedObjects.add(tgt);
      if (tgt.name) pbrQueuedNames.add(tgt.name);
      tgt.traverse?.((c) => { pbrQueuedObjects.add(c); if (c.name) pbrQueuedNames.add(c.name); });
    } else if (typeof tgt === 'string') {
      pbrQueuedNames.add(tgt);
    }
  }
  return Promise.resolve({ ok: true, deferred: true, jobId: token, __copilotAsyncToken: token });
}

function requestAsset(method, args = []) {
  const id = `asset_${++assetSequence}`;
  const promise = new Promise((resolve, reject) => {
    assetRequests.set(id, { resolve, reject });
    send({ kind: 'assetRequest', id, method, args: encodeValue(args) });
  });
  return promise;
}

function applyAnimations(payload) {
  const byUUID = new Map(payload.animations.map((entry) => [entry.objectUUID, entry.clips]));
  mirror.traverse((object) => {
    const clips = byUUID.get(object.uuid);
    object.animations = clips ? clips.map((json) => THREE.AnimationClip.parse(json)) : [];
  });
}

function workerLoaderDocument(payload) {
  const document = sceneLoaderDocument(payload);
  const placeholder = { data: [0, 0, 0, 255], width: 1, height: 1, type: 'Uint8Array' };
  document.images = (document.images || []).map((image) => ({
    uuid: image.uuid,
    url: Array.isArray(image.url) ? image.url.map(() => placeholder) : placeholder,
  }));
  return document;
}

function restoreAssetSkeletons(root, entries) {
  if (!Array.isArray(entries) || entries.length > 5000) return;
  for (const entry of entries) {
    if (!entry || typeof entry.objectUUID !== 'string' || !Array.isArray(entry.boneUUIDs) || entry.boneUUIDs.length > 5000) continue;
    const object = root.getObjectByProperty('uuid', entry.objectUUID);
    const bones = entry.boneUUIDs.map((uuid) => root.getObjectByProperty('uuid', uuid)).filter((bone) => bone?.isBone);
    if (!object || !bones.length) continue;
    const skeleton = new THREE.Skeleton(bones);
    skeleton.calculateInverses();
    if (object.isSkinnedMesh) object.skeleton = skeleton;
    else object.userData.skeleton = skeleton;
  }
}

async function adoptAsset(method, args) {
  const operation = (async () => {
    const response = await requestAsset(method, args);
    const payload = validateScenePayload(response.payload);
    const root = new THREE.ObjectLoader().parse(workerLoaderDocument(payload));
    restoreMirrorTypes(payload.scene, root);
    restoreAssetSkeletons(root, response.skeletons);
    mirror.add(root);
    applyAnimations(payload);
    assetIds.set(root.uuid, response.assetId);
    assetInitial.set(root.uuid, payload);
    createdObjects.add(root);
    return root;
  })();
  pendingAssets.add(operation);
  try { return await operation; }
  finally { pendingAssets.delete(operation); }
}

function isSystemOrHelper(object) {
  return !object
    || object.userData?.isSystemObject
    || object.userData?.isHelper
    || object.userData?.isGizmo
    || object.isTransformControls
    || /^(TransformControls|ViewHelper|GridHelper|AxesHelper|BoxHelper|DirectionalLightHelper|PointLightHelper|SpotLightHelper|SkeletonHelper)$/i.test(object.type || object.name || '');
}

function clearMirror() {
  clearRequested = true;
  studio.stopAnimations();
  for (const child of [...mirror.children]) {
    if (!isSystemOrHelper(child)) mirror.remove(child);
  }
  for (const uuid of [...assetIds.keys()]) {
    if (!mirror.getObjectByProperty('uuid', uuid)) {
      assetIds.delete(uuid);
      assetInitial.delete(uuid);
    }
  }
  createdObjects.clear();
}

function register(object, name) {
  if (name) object.name = name;
  if (object.isMesh) {
    object.castShadow = true;
    object.receiveShadow = true;
  } else {
    object.traverse((child) => {
      if (child.isMesh) {
        child.castShadow = true;
        child.receiveShadow = true;
      }
    });
  }
  mirror.add(object);
  createdObjects.add(object);
  return object;
}

function parseColor(value, fallback = 0xd2d5da) {
  if (value === undefined || value === null) return new THREE.Color(fallback);
  if (value?.isColor) return value.clone();
  if (typeof value === 'number' || typeof value === 'string') return new THREE.Color(value);
  return new THREE.Color(fallback);
}

function createMaterial(options = {}) {
  const clay = options.color === undefined || options.color === null;
  const material = new THREE.MeshStandardMaterial({
    name: options.materialName || (clay ? 'Default Clay (Unassigned)' : 'Material'),
    color: parseColor(options.color, 0xd2d5da),
    emissive: options.emissive ? parseColor(options.emissive, 0x000000) : new THREE.Color(0x000000),
    emissiveIntensity: options.emissiveIntensity ?? (options.emissive ? 1 : 0),
    roughness: options.roughness ?? (clay ? 0.65 : 0.45),
    metalness: options.metalness ?? (clay ? 0 : 0.15),
    wireframe: !!options.wireframe,
    opacity: options.opacity ?? 1,
    transparent: (options.opacity ?? 1) < 1 || !!options.transparent,
    vertexColors: !!options.vertexColors,
    side: options.doubleSided ? THREE.DoubleSide : THREE.FrontSide,
    flatShading: options.flatShading ?? true
  });
  material.userData.isDefaultClay = clay;
  return material;
}

function addCadMesh(geometry, options = {}, defaultName = 'CAD_Mesh') {
  const hasVC = Boolean(geometry?.attributes?.color);
  let material = options.material || null;
  if (material) {
    if (hasVC && options.vertexColors !== false && !material.vertexColors) {
      material = material.clone();
      material.vertexColors = true;
      material.needsUpdate = true;
    }
  } else {
    material = createMaterial({
      ...options,
      flatShading: options.flatShading ?? false,
      vertexColors: options.vertexColors ?? hasVC,
    });
  }
  const mesh = transformOptions(new THREE.Mesh(geometry, material), options);
  if (options.parent?.isObject3D) {
    mesh.name = options.name || defaultName;
    mesh.castShadow = options.castShadow !== false;
    mesh.receiveShadow = options.receiveShadow !== false;
    options.parent.add(mesh);
    return mesh;
  }
  return register(mesh, options.name || defaultName);
}

function transformOptions(object, options = {}) {
  const position = options.position && typeof options.position === 'object' ? options.position : options;
  object.position.set(Number(position.x) || 0, Number(position.y) || 0, Number(position.z) || 0);
  if (Array.isArray(options.rotation)) object.rotation.set(...options.rotation);
  else if (options.rotation && typeof options.rotation === 'object') object.rotation.set(options.rotation.x || 0, options.rotation.y || 0, options.rotation.z || 0);
  else object.rotation.set(options.rotationX || 0, options.rotationY || 0, options.rotationZ || 0);
  if (typeof options.scale === 'number') object.scale.setScalar(options.scale);
  else if (Array.isArray(options.scale)) object.scale.set(...options.scale);
  else if (options.scale && typeof options.scale === 'object') object.scale.set(options.scale.x ?? 1, options.scale.y ?? 1, options.scale.z ?? 1);
  return object;
}

function addMesh(geometry, options = {}, name = 'Mesh', defaultFlat = true) {
  const material = options.material || createMaterial({ ...options, flatShading: options.flatShading ?? defaultFlat });
  const mesh = transformOptions(new THREE.Mesh(geometry, material), options);
  if (options.parent?.isObject3D) {
    mesh.name = options.name || name;
    mesh.castShadow = options.castShadow !== false;
    mesh.receiveShadow = options.receiveShadow !== false;
    options.parent.add(mesh);
    createdObjects.add(mesh);
    return mesh;
  }
  return register(mesh, options.name || name);
}

class WorkerStudio {
  constructor() {
    this._createdObjects = createdObjects;
    this._animationCallbacks = animationCallbacks;
    this.modifiers = this._createModifiers();
  }

  get THREE() { return THREE; }
  get scene() { return sceneFacade; }
  get camera() { return cameraMirror; }
  get engine() { return engineFacade; }
  get tutor() { return tutorFacade; }
  get bpy() { return this._createBpy(); }

  init() { return this; }
  log(message, type = 'info') { log[type === 'error' ? 'error' : 'info']?.(String(message)); }

  addPrimitive(typeOrOpts = 'cube', opts = {}) {
    const options = typeof typeOrOpts === 'object' && typeOrOpts !== null ? typeOrOpts : { ...opts, type: typeOrOpts };
    const type = String(options.type || options.primitive || 'cube').toLowerCase();
    if (['sphere', 'uvsphere', 'ball'].includes(type)) return this.addSphere(options);
    if (['cylinder', 'tube'].includes(type)) return this.addCylinder(options);
    if (['cone', 'pyramid'].includes(type)) return this.addCone(options);
    if (['torus', 'donut'].includes(type)) return this.addTorus(options);
    if (['plane', 'floor', 'ground'].includes(type)) return this.addPlane(options);
    if (['ico', 'icosphere'].includes(type)) return this.addIcoSphere(options);
    return this.addCube(options);
  }

  addCube(options = {}) {
    const o = options;
    const geometry = new THREE.BoxGeometry(o.width ?? 2, o.height ?? 2, o.depth ?? 2, o.widthSegments ?? 1, o.heightSegments ?? 1, o.depthSegments ?? 1);
    const mesh = addMesh(geometry, o, 'Cube');
    mesh.userData.primitiveType = 'cube';
    mesh.userData.primitiveParams = { width: o.width ?? 2, height: o.height ?? 2, depth: o.depth ?? 2, widthSegments: o.widthSegments ?? 1, heightSegments: o.heightSegments ?? 1, depthSegments: o.depthSegments ?? 1, flatShading: o.flatShading ?? true };
    return mesh;
  }

  addSphere(options = {}) {
    const o = options;
    const geometry = new THREE.SphereGeometry(o.radius ?? 1, o.widthSegments ?? 32, o.heightSegments ?? 16);
    const mesh = addMesh(geometry, o, 'Sphere', false);
    mesh.userData.primitiveType = 'uv_sphere';
    mesh.userData.primitiveParams = { radius: o.radius ?? 1, widthSegments: o.widthSegments ?? 32, heightSegments: o.heightSegments ?? 16, flatShading: o.flatShading ?? false };
    return mesh;
  }

  addIcoSphere(options = {}) {
    const o = options;
    const geometry = new THREE.IcosahedronGeometry(o.radius ?? 1, Math.max(0, Math.min(5, Math.round(o.subdivisions ?? 2))));
    const mesh = addMesh(geometry, o, 'Icosphere', true);
    mesh.userData.primitiveType = 'ico_sphere';
    mesh.userData.primitiveParams = { radius: o.radius ?? 1, subdivisions: o.subdivisions ?? 2, flatShading: o.flatShading ?? true };
    return mesh;
  }

  addCylinder(options = {}) {
    const o = options;
    const geometry = new THREE.CylinderGeometry(o.radiusTop ?? 1, o.radiusBottom ?? 1, o.height ?? 2, o.radialSegments ?? 32, o.heightSegments ?? 1, !!o.openEnded);
    const mesh = addMesh(geometry, { ...o, doubleSided: o.openEnded || o.doubleSided }, 'Cylinder', false);
    mesh.userData.primitiveType = 'cylinder';
    mesh.userData.primitiveParams = { radiusTop: o.radiusTop ?? 1, radiusBottom: o.radiusBottom ?? 1, height: o.height ?? 2, radialSegments: o.radialSegments ?? 32, heightSegments: o.heightSegments ?? 1, openEnded: !!o.openEnded, flatShading: o.flatShading ?? false };
    return mesh;
  }

  addCone(options = {}) {
    const o = options;
    const geometry = new THREE.ConeGeometry(o.radius ?? 1, o.height ?? 2, o.radialSegments ?? 32, o.heightSegments ?? 1, !!o.openEnded);
    const mesh = addMesh(geometry, { ...o, doubleSided: o.openEnded || o.doubleSided }, 'Cone', false);
    mesh.userData.primitiveType = 'cone';
    mesh.userData.primitiveParams = { radius: o.radius ?? 1, height: o.height ?? 2, radialSegments: o.radialSegments ?? 32, heightSegments: o.heightSegments ?? 1, openEnded: !!o.openEnded, flatShading: o.flatShading ?? false };
    return mesh;
  }

  addTorus(options = {}) {
    const o = options;
    const geometry = new THREE.TorusGeometry(o.radius ?? 1, o.tube ?? 0.25, o.radialSegments ?? 16, o.tubularSegments ?? 48);
    geometry.rotateX(Math.PI / 2);
    const mesh = addMesh(geometry, o, 'Torus', false);
    mesh.userData.primitiveType = 'torus';
    mesh.userData.primitiveParams = { radius: o.radius ?? 1, tube: o.tube ?? 0.25, radialSegments: o.radialSegments ?? 16, tubularSegments: o.tubularSegments ?? 48, flatShading: o.flatShading ?? false };
    return mesh;
  }

  addPlane(options = {}) {
    const o = options;
    const geometry = new THREE.PlaneGeometry(o.width ?? 2, o.height ?? 2, o.widthSegments ?? 1, o.heightSegments ?? 1);
    if ((o.rotationX ?? -Math.PI / 2) !== 0) geometry.rotateX(o.rotationX ?? -Math.PI / 2);
    const mesh = addMesh(geometry, { ...o, doubleSided: true }, 'Plane');
    mesh.userData.primitiveType = 'plane';
    mesh.userData.primitiveParams = { width: o.width ?? 2, height: o.height ?? 2, widthSegments: o.widthSegments ?? 1, heightSegments: o.heightSegments ?? 1, flatShading: o.flatShading ?? true };
    return mesh;
  }

  addGrid(options = {}) {
    const o = options;
    const geometry = new THREE.PlaneGeometry(o.width ?? 4, o.height ?? 4, o.subdivisionsX ?? 10, o.subdivisionsY ?? 10);
    geometry.rotateX(-Math.PI / 2);
    const mesh = addMesh(geometry, { ...o, doubleSided: true }, 'Grid');
    mesh.userData.primitiveType = 'grid';
    return mesh;
  }

  addCircle(options = {}) {
    const o = options;
    const geometry = new THREE.CircleGeometry(o.radius ?? 1, Math.max(3, Math.round(o.segments ?? 32)));
    if ((o.rotationX ?? -Math.PI / 2) !== 0) geometry.rotateX(o.rotationX ?? -Math.PI / 2);
    const mesh = addMesh(geometry, { ...o, doubleSided: true }, 'Circle');
    mesh.userData.primitiveType = 'circle';
    return mesh;
  }

  addCapsule(options = {}) {
    const o = options;
    const geometry = new THREE.CapsuleGeometry(o.radius ?? 0.6, o.length ?? 1.2, o.capSegments ?? 12, o.radialSegments ?? 24);
    const mesh = addMesh(geometry, o, 'Capsule', false);
    mesh.userData.primitiveType = 'capsule';
    return mesh;
  }

  addGroup(name = 'Group', options = {}) {
    const group = new THREE.Group();
    if (typeof name === 'object' && name !== null) {
      options = name;
      name = options.name || 'Group';
    }
    group.name = name;
    transformOptions(group, options);
    if (options.parent?.isObject3D) {
      options.parent.add(group);
      createdObjects.add(group);
      return group;
    }
    return register(group, name);
  }

  sampleContour(contour, segments = 20) { return sample2DContour(contour, segments); }
  addExtrude(options = {}) { return addCadMesh(buildExtrudeGeometry(options, THREE), options, 'Extrude'); }
  addSweep(options = {}) { return addCadMesh(buildSweepGeometry(options, THREE), options, 'Sweep'); }
  addLathe(options = {}) { return addCadMesh(buildLatheGeometry(options, THREE), options, 'Lathe'); }
  addSurfaceGrid(options = {}) { return addCadMesh(buildSurfaceShellGeometry(options, THREE), { doubleSided: true, ...options }, 'SurfaceShell'); }
  addLoft(options = {}) { return addCadMesh(buildLoftGeometry(options, THREE), { doubleSided: Boolean(options.grid), ...options }, 'Loft'); }
  sampleCurve3D(options = {}) { return sampleCurve3D(options, THREE); }
  createCurve3D(options = {}) { return sampleCurve3D(options, THREE); }
  scatterOnCurve(sourceOrOpts, curveOrOptions = {}, options = {}) {
    if (
      sourceOrOpts &&
      typeof sourceOrOpts === 'object' &&
      !sourceOrOpts.isObject3D &&
      !sourceOrOpts.isBufferGeometry &&
      ('curve' in sourceOrOpts || 'geometry' in sourceOrOpts || 'source' in sourceOrOpts)
    ) {
      const cfg = sourceOrOpts;
      const samples = Array.isArray(cfg.curve) ? cfg.curve : sampleCurve3D(cfg.curve || cfg, THREE);
      const instances = buildCurveScatterInstances(samples, cfg);
      const src = cfg.source || cfg.geometry || new THREE.BoxGeometry(0.2, 0.2, 0.2);
      return this.addInstancedMesh(src, instances, { name: cfg.name || 'CurveScatter', ...cfg });
    }
    const samples = Array.isArray(curveOrOptions) ? curveOrOptions : sampleCurve3D(curveOrOptions, THREE);
    const instances = buildCurveScatterInstances(samples, options);
    return this.addInstancedMesh(sourceOrOpts, instances, { name: options.name || 'CurveScatter', ...options });
  }
  boolean(arg0 = 'subtract', arg1 = null, arg2 = null, options = {}) {
    const opMap = { subtract: 'difference', difference: 'difference', union: 'union', intersect: 'intersect' };
    let operation, targetA, targetB;
    if (typeof arg0 === 'string' && opMap[arg0.toLowerCase()]) {
      operation = arg0; targetA = arg1; targetB = arg2;
    } else {
      targetA = arg0; targetB = arg1; operation = typeof arg2 === 'string' ? arg2 : 'subtract';
    }
    return queueLive('Modifiers.applyBoolean', [targetA, targetB, opMap[String(operation).toLowerCase()] || 'difference', options], null);
  }
  inspectSceneBudget(targetOrTier = null, options = {}) {
    const TIERS = new Set(['mobile', 'product', 'architecture']);
    if (typeof targetOrTier === 'string' && TIERS.has(targetOrTier.toLowerCase())) {
      return inspectSceneBudget(mirror, { tier: targetOrTier.toLowerCase(), ...options });
    }
    if (targetOrTier && typeof targetOrTier === 'object' && !targetOrTier.isObject3D) {
      return inspectSceneBudget(mirror, { ...targetOrTier, ...options });
    }
    const root = targetOrTier ? (typeof targetOrTier === 'string' ? this.getObject(targetOrTier) : targetOrTier) : mirror;
    return inspectSceneBudget(root, options);
  }
  exportModel(options = {}) {
    return queueLiveAsync('studio.exportModel', [options]);
  }

  mergeMeshes(parts = [], options = {}) {
    const geom = mergePartGeometries(parts, options, THREE);
    if (options.removeSources) {
      for (const item of parts) {
        if (item?.isObject3D) {
          item.parent?.remove(item);
          createdObjects.delete(item);
        }
      }
    }
    return addCadMesh(geom, options, 'MergedMesh');
  }

  addInstancedMesh(source, instances = [], options = {}) {
    const geom = source?.isBufferGeometry ? source : source?.geometry;
    const hasVC = Boolean(geom?.attributes?.color);
    let mat = options.material || source?.material || null;
    if (mat) {
      if (hasVC && options.vertexColors !== false && !mat.vertexColors) {
        mat = mat.clone();
        mat.vertexColors = true;
        mat.needsUpdate = true;
      }
    } else {
      mat = createMaterial({ ...options, flatShading: options.flatShading ?? false, vertexColors: options.vertexColors ?? hasVC });
    }
    const inst = buildInstancedMesh(geom, mat, instances, options, THREE);
    transformOptions(inst, options);
    if (options.removeSource && source?.isObject3D) {
      source.parent?.remove(source);
      createdObjects.delete(source);
    }
    if (options.parent?.isObject3D) {
      options.parent.add(inst);
      return inst;
    }
    return register(inst, options.name || 'InstancedMesh');
  }

  boxProjectUV(target, options = {}) {
    const obj = typeof target === 'string' ? this.getObject(target) : target;
    if (!obj) return null;
    if (obj.isBufferGeometry) return applyTriplanarUV(obj, options, THREE);
    obj.traverse?.((c) => {
      if (c.isMesh && c.geometry) {
        c.updateWorldMatrix?.(true, false);
        applyTriplanarUV(c.geometry, { metersPerTile: options.metersPerTile ?? options.scale ?? 2.0, matrix: options.worldSpace !== false ? c.matrixWorld : null }, THREE);
      }
    });
    return obj;
  }

  computeCreaseNormals(target, angleDeg = 32) {
    const obj = typeof target === 'string' ? this.getObject(target) : target;
    if (!obj) return null;
    if (obj.isBufferGeometry) return applyCreaseNormals(obj, angleDeg, THREE);
    obj.traverse?.((c) => {
      if (c.isMesh && c.geometry) {
        c.geometry = applyCreaseNormals(c.geometry, angleDeg, THREE);
        for (const m of Array.isArray(c.material) ? c.material : [c.material]) {
          if (m) m.flatShading = false;
        }
      }
    });
    return obj;
  }

  bakeVertexAO(target, options = {}) {
    const obj = typeof target === 'string' ? this.getObject(target) : target;
    if (!obj) return null;
    if (obj.isBufferGeometry) return computeVertexCavityAO(obj, options, THREE);
    obj.traverse?.((c) => {
      if (c.isMesh && c.geometry) {
        computeVertexCavityAO(c.geometry, options, THREE);
        for (const m of Array.isArray(c.material) ? c.material : [c.material]) {
          if (m) m.vertexColors = true;
        }
      }
    });
    return obj;
  }

  modifyGeometry(target, type, params = {}) {
    const obj = typeof target === 'string' ? this.getObject(target) : target;
    if (!obj) return null;
    if (obj.isBufferGeometry) return modifyGeometrySync(obj, type, params, THREE);
    if (obj.isMesh && obj.geometry) {
      obj.geometry = modifyGeometrySync(obj.geometry, type, params, THREE);
    }
    return obj;
  }

  addLight(options = {}) {
    const o = options;
    const type = String(o.type || 'point').toLowerCase();
    const color = parseColor(o.color, 0xffffff);
    const intensity = o.intensity ?? 1;
    let light;
    if (type === 'directional') light = new THREE.DirectionalLight(color, intensity);
    else if (type === 'spot') light = new THREE.SpotLight(color, intensity, o.distance ?? 0);
    else if (type === 'area' || type === 'rectarea') light = new THREE.RectAreaLight(color, intensity, 2.5, 2.5);
    else if (type === 'ambient') light = new THREE.AmbientLight(color, intensity);
    else light = new THREE.PointLight(color, intensity, o.distance ?? 0);
    if (type !== 'ambient' && type !== 'area' && type !== 'rectarea') light.castShadow = true;
    transformOptions(light, o);
    return register(light, o.name || `${type}Light`);
  }

  createStaircase(options = {}) {
    const o = options;
    const group = new THREE.Group();
    group.name = o.name || 'Staircase';
    group.position.set(o.x || 0, o.y || 0, o.z || 0);
    const steps = Math.max(1, Math.min(200, Math.round(o.steps ?? 16)));
    const width = o.width ?? 1.8;
    const stepHeight = o.stepHeight ?? 0.18;
    const stepDepth = o.stepDepth ?? 0.35;
    const stepMat = createMaterial({ color: o.color ?? 0xbdc3c7, roughness: 0.5, metalness: 0.1 });
    const railMat = createMaterial({ color: o.railingColor ?? 0x2c3e50, roughness: 0.3, metalness: 0.7 });
    if (o.spiral) {
      const totalHeight = steps * stepHeight;
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.25, totalHeight + 1, 32), railMat);
      pole.position.y = (totalHeight + 1) / 2;
      group.add(pole);
      const stepGeometry = new THREE.BoxGeometry(width, stepHeight * 0.9, stepDepth);
      stepGeometry.translate(width / 2 + 0.2, 0, 0);
      for (let i = 0; i < steps; i++) {
        const angle = i * (o.anglePerStep ?? 0.28);
        const step = new THREE.Mesh(stepGeometry, stepMat);
        step.position.y = (i + 0.5) * stepHeight;
        step.rotation.y = angle;
        group.add(step);
        if (o.withRailing !== false) {
          const post = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.9, 8), railMat);
          const radius = (o.radius ?? 2) + width * 0.45;
          post.position.set(Math.cos(angle) * radius, step.position.y + 0.45, -Math.sin(angle) * radius);
          group.add(post);
        }
      }
    } else {
      const stepGeometry = new THREE.BoxGeometry(width, stepHeight, stepDepth);
      for (let i = 0; i < steps; i++) {
        const step = new THREE.Mesh(stepGeometry, stepMat);
        step.position.set(0, (i + 0.5) * stepHeight, i * stepDepth);
        group.add(step);
      }
      if (o.withRailing !== false) {
        const railLength = Math.hypot(steps * stepDepth, steps * stepHeight);
        const railAngle = Math.atan2(steps * stepHeight, steps * stepDepth);
        const railGeometry = new THREE.CylinderGeometry(0.04, 0.04, railLength, 12);
        railGeometry.rotateX(Math.PI / 2);
        for (const sideX of [-width / 2 - 0.05, width / 2 + 0.05]) {
          const rail = new THREE.Mesh(railGeometry, railMat);
          rail.position.set(sideX, steps * stepHeight / 2 + 0.85, steps * stepDepth / 2 - stepDepth / 2);
          rail.rotation.x = -railAngle;
          group.add(rail);
          for (const index of [0, Math.floor(steps / 2), steps - 1]) {
            const post = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.9, 8), railMat);
            post.position.set(sideX, index * stepHeight + 0.45, index * stepDepth);
            group.add(post);
          }
        }
      }
    }
    return register(group, group.name);
  }

  createBuilding(options = {}) {
    const o = options;
    const floors = Math.max(1, Math.min(100, Math.round(o.floors ?? 6)));
    const width = o.width ?? 4;
    const depth = o.depth ?? 4;
    const floorHeight = o.floorHeight ?? 1.3;
    const group = new THREE.Group();
    group.name = o.name || 'Building';
    group.position.set(o.x || 0, o.y || 0, o.z || 0);
    const bodyMat = createMaterial({ color: o.color ?? 0x2c3e50, roughness: 0.6, metalness: 0.3 });
    const ledgeMat = createMaterial({ color: 0x1a252f, roughness: 0.7, metalness: 0.2 });
    const windowMat = createMaterial({ color: o.windowColor ?? 0x74b9ff, roughness: 0.1, metalness: 0.9, emissive: o.windowEmissive ?? 0x34495e, emissiveIntensity: 0.4 });
    const baseHeight = 0.4;
    const base = new THREE.Mesh(new THREE.BoxGeometry(width + 0.4, baseHeight, depth + 0.4), ledgeMat);
    base.position.y = baseHeight / 2;
    group.add(base);
    for (let floor = 0; floor < floors; floor++) {
      const floorY = baseHeight + floor * floorHeight;
      const core = new THREE.Mesh(new THREE.BoxGeometry(width, floorHeight, depth), bodyMat);
      core.position.y = floorY + floorHeight / 2;
      group.add(core);
      const ledge = new THREE.Mesh(new THREE.BoxGeometry(width + 0.15, 0.1, depth + 0.15), ledgeMat);
      ledge.position.y = floorY + floorHeight;
      group.add(ledge);
      const windowGeometry = new THREE.PlaneGeometry(0.6, floorHeight * 0.6);
      const countX = Math.max(1, Math.floor(width / 1));
      const countZ = Math.max(1, Math.floor(depth / 1));
      for (let i = 0; i < countX; i++) {
        const x = -(countX - 1) / 2 + i;
        for (const side of [-1, 1]) {
          const windowMesh = new THREE.Mesh(windowGeometry, windowMat);
          windowMesh.position.set(x, floorY + floorHeight / 2, side * (depth / 2 + 0.02));
          if (side < 0) windowMesh.rotation.y = Math.PI;
          group.add(windowMesh);
        }
      }
      for (let i = 0; i < countZ; i++) {
        const z = -(countZ - 1) / 2 + i;
        for (const side of [-1, 1]) {
          const windowMesh = new THREE.Mesh(windowGeometry, windowMat);
          windowMesh.position.set(side * (width / 2 + 0.02), floorY + floorHeight / 2, z);
          windowMesh.rotation.y = side * Math.PI / 2;
          group.add(windowMesh);
        }
      }
    }
    const totalHeight = baseHeight + floors * floorHeight;
    if ((o.roofType || 'terrace') === 'terrace') {
      const walls = [
        [width, 0.45, 0.2, 0, totalHeight + 0.225, depth / 2 - 0.1],
        [width, 0.45, 0.2, 0, totalHeight + 0.225, -depth / 2 + 0.1],
        [0.2, 0.45, depth - 0.4, width / 2 - 0.1, totalHeight + 0.225, 0],
        [0.2, 0.45, depth - 0.4, -width / 2 + 0.1, totalHeight + 0.225, 0]
      ];
      for (const [w, h, d, x, y, z] of walls) {
        const wall = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), ledgeMat);
        wall.position.set(x, y, z);
        group.add(wall);
      }
      const utility = new THREE.Mesh(new THREE.BoxGeometry(width * 0.4, 0.8, depth * 0.4), bodyMat);
      utility.position.y = totalHeight + 0.4;
      group.add(utility);
    }
    if (o.withAntenna !== false) {
      const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.1, 2.2, 8), createMaterial({ color: 0x95a5a6, roughness: 0.2, metalness: 0.9 }));
      mast.position.y = totalHeight + 1.9;
      group.add(mast);
      const beacon = new THREE.Mesh(new THREE.SphereGeometry(0.08, 12, 12), createMaterial({ color: 0xff0000, emissive: 0xff0000, emissiveIntensity: 2 }));
      beacon.position.y = mast.position.y + 1.1;
      group.add(beacon);
    }
    return register(group, group.name);
  }

  createTree(options = {}) {
    const o = options;
    const trunkHeight = o.trunkHeight ?? 2.4;
    const trunkRadius = o.trunkRadius ?? 0.22;
    const foliageRadius = o.foliageRadius ?? 1.3;
    const group = new THREE.Group();
    group.name = o.name || 'Tree';
    group.position.set(o.x || 0, o.y || 0, o.z || 0);
    const trunk = new THREE.Mesh(new THREE.CylinderGeometry(trunkRadius * 0.7, trunkRadius, trunkHeight, 8), createMaterial({ color: o.trunkColor ?? 0x795548, roughness: 0.85, metalness: 0.05 }));
    trunk.position.y = trunkHeight / 2;
    group.add(trunk);
    const foliageMat = createMaterial({ color: o.foliageColor ?? 0x27ae60, roughness: 0.6, metalness: 0, flatShading: o.style !== 'lush' });
    if (o.style === 'lush') {
      const centerY = trunkHeight + foliageRadius * 0.4;
      const main = new THREE.Mesh(new THREE.SphereGeometry(foliageRadius, 16, 16), foliageMat);
      main.position.y = centerY;
      group.add(main);
      for (const [x, y, z, scale] of [[0.5, 0.1, 0, 0.7], [-0.45, -0.15, 0.2, 0.65], [0, 0.3, 0.5, 0.6], [0.2, -0.1, -0.45, 0.7]]) {
        const puff = new THREE.Mesh(new THREE.SphereGeometry(foliageRadius * scale, 12, 12), foliageMat);
        puff.position.set(foliageRadius * x, centerY + y, foliageRadius * z);
        group.add(puff);
      }
    } else {
      for (let tier = 0; tier < 3; tier++) {
        const cone = new THREE.Mesh(new THREE.ConeGeometry(foliageRadius * (1 - tier * 0.22), trunkHeight * 0.7, 7), foliageMat);
        cone.position.y = trunkHeight * 0.65 + tier * trunkHeight * 0.38;
        group.add(cone);
      }
    }
    return register(group, group.name);
  }

  repeatRadial(target, count = 8, radius = 4, options = {}) {
    const total = Math.max(1, Math.min(500, Math.round(count)));
    const group = new THREE.Group();
    group.name = options.name || 'RadialArray';
    for (let i = 0; i < total; i++) {
      const angle = i * Math.PI * 2 / total;
      const clone = typeof target === 'function' ? target(i, total) : cloneSkinned(target);
      clone.position.x = Math.cos(angle) * radius;
      clone.position.z = Math.sin(angle) * radius;
      clone.position.y += i * (options.yOffset || 0);
      if (options.rotateWithRadius !== false) clone.rotation.y = -angle + Math.PI / 2;
      group.add(clone);
    }
    return register(group, group.name);
  }

  repeatGrid(target, countX = 4, countZ = 4, spacing = 2, options = {}) {
    const nx = Math.max(1, Math.min(100, Math.round(countX)));
    const nz = Math.max(1, Math.min(100, Math.round(countZ)));
    const group = new THREE.Group();
    group.name = options.name || 'GridArray';
    const sx = options.spacingX ?? spacing;
    const sz = options.spacingZ ?? spacing;
    const ox = options.center === false ? 0 : -(nx - 1) * sx / 2;
    const oz = options.center === false ? 0 : -(nz - 1) * sz / 2;
    for (let ix = 0; ix < nx; ix++) {
      for (let iz = 0; iz < nz; iz++) {
        const clone = typeof target === 'function' ? target(ix, iz, nx, nz) : cloneSkinned(target);
        clone.position.x += ox + ix * sx;
        clone.position.z += oz + iz * sz;
        group.add(clone);
      }
    }
    return register(group, group.name);
  }

  createArticulatedActor(options = {}) {
    const o = options;
    const root = this.addGroup(o.name || 'Actor');
    root.position.set(o.x || 0, o.y || 0, o.z || 0);
    root.rotation.y = o.rotY || 0;
    const skin = this.createPBRMaterial('skin_realistic', { color: o.skinColor ?? 0xf1c29d, roughness: 0.52 });
    const shirt = this.createPBRMaterial('cotton_shirt_sale', { color: o.shirtColor ?? 0x2563eb, roughness: 0.72 });
    const pants = this.createPBRMaterial('denim_jeans', { color: o.pantsColor ?? 0x1e3a5f, roughness: 0.82 });
    const hair = createMaterial({ color: o.hairColor ?? 0x18181b, roughness: 0.78 });
    const shoes = this.createPBRMaterial('leather_black', { color: 0x1f2937, roughness: 0.45 });
    const torsoPivot = new THREE.Group();
    torsoPivot.position.y = 0.78;
    root.add(torsoPivot);
    const torso = new THREE.Mesh(new THREE.CylinderGeometry(o.isFemale ? 0.18 : 0.21, o.isFemale ? 0.16 : 0.18, 0.56, 16), shirt);
    torso.position.y = 0.28;
    torso.scale.set(1.15, 1, 0.78);
    torsoPivot.add(torso);
    let jacketGroup = null;
    if (o.hasJacketLayer) {
      jacketGroup = new THREE.Group();
      jacketGroup.name = `${root.name}_Jacket`;
      const jacketMat = this.createPBRMaterial('cotton_shirt_sale', { color: o.jacketColor ?? 0xd93829, roughness: 0.65 });
      const jacketShell = new THREE.Mesh(new THREE.CylinderGeometry(0.228, 0.198, 0.58, 16), jacketMat);
      jacketShell.position.y = 0.28;
      jacketShell.scale.set(1.18, 1, 0.84);
      jacketGroup.add(jacketShell);
      const collar = new THREE.Mesh(new THREE.TorusGeometry(0.13, 0.032, 10, 20), jacketMat);
      collar.rotation.x = Math.PI / 2;
      collar.position.y = 0.57;
      jacketGroup.add(collar);
      jacketGroup.visible = false;
      torsoPivot.add(jacketGroup);
    }
    const neckPivot = new THREE.Group();
    neckPivot.position.y = 0.58;
    torsoPivot.add(neckPivot);
    const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.065, 0.072, 0.14, 12), skin);
    neck.position.y = 0.05;
    neckPivot.add(neck);
    const headGroup = new THREE.Group();
    headGroup.position.y = 0.21;
    neckPivot.add(headGroup);
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.165, 24, 20), skin);
    head.scale.set(0.95, 1.08, 0.98);
    headGroup.add(head);
    const hairCap = new THREE.Mesh(new THREE.SphereGeometry(0.172, 24, 18, 0, Math.PI * 2, 0, Math.PI * 0.56), hair);
    hairCap.position.set(0, 0.028, -0.012);
    hairCap.rotation.x = -0.26;
    headGroup.add(hairCap);
    const arms = {};
    for (const side of [-1, 1]) {
      const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.085, 0.07, 0.76, 14), pants);
      leg.position.set(side * 0.11, 0.42, 0);
      root.add(leg);
      const shoe = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.09, 0.24), shoes);
      shoe.position.set(side * 0.11, 0.045, 0.04);
      root.add(shoe);
      const shoulder = new THREE.Group();
      shoulder.position.set(side * (o.isFemale ? 0.22 : 0.26), 0.5, 0);
      torsoPivot.add(shoulder);
      const upperArm = new THREE.Mesh(new THREE.CylinderGeometry(0.052, 0.045, 0.28, 12), shirt);
      upperArm.position.y = -0.13;
      shoulder.add(upperArm);
      const elbow = new THREE.Group();
      elbow.position.y = -0.27;
      shoulder.add(elbow);
      const fore = new THREE.Mesh(new THREE.CylinderGeometry(0.043, 0.036, 0.26, 12), skin);
      fore.position.y = -0.12;
      elbow.add(fore);
      const hand = new THREE.Mesh(new THREE.SphereGeometry(0.042, 12, 10), skin);
      hand.position.y = -0.26;
      elbow.add(hand);
      arms[side < 0 ? 'leftArm' : 'rightArm'] = { shoulder, elbow, hand, upperArm };
    }
    root.traverse((child) => { if (child.isMesh) { child.castShadow = true; child.receiveShadow = true; } });
    return { root, torsoPivot, neckPivot, headGroup, leftArm: arms.leftArm, rightArm: arms.rightArm, jacketGroup };
  }

  setColor(target, color) {
    const obj = typeof target === 'string' ? this.getObject(target) : target;
    if (!obj) return null;
    const parsed = parseColor(color, 0x95a5a6);
    const applyMat = (m) => { m?.color?.copy(parsed); };
    if (obj.isObject3D) {
      obj.traverse((c) => {
        if (!c.material) return;
        for (const m of Array.isArray(c.material) ? c.material : [c.material]) applyMat(m);
      });
    } else if (obj.material) {
      for (const m of Array.isArray(obj.material) ? obj.material : [obj.material]) applyMat(m);
    }
    // Preserve execution order if applyProceduralPBR was queued earlier for this target
    if (pbrQueuedObjects.has(obj) || (obj.name && pbrQueuedNames.has(obj.name)) || (typeof target === 'string' && pbrQueuedNames.has(target))) {
      queueLive('studio.setColor', [obj, color], obj);
    }
    return obj;
  }

  setEmissive(target, color, intensity = 1) {
    const obj = typeof target === 'string' ? this.getObject(target) : target;
    if (!obj) return null;
    const parsed = parseColor(color, 0x000000);
    const applyMat = (m) => {
      if (m?.emissive) m.emissive.copy(parsed);
      if (m) m.emissiveIntensity = intensity;
    };
    if (obj.isObject3D) {
      obj.traverse((c) => {
        if (!c.material) return;
        for (const m of Array.isArray(c.material) ? c.material : [c.material]) applyMat(m);
      });
    } else if (obj.material) {
      for (const m of Array.isArray(obj.material) ? obj.material : [obj.material]) applyMat(m);
    }
    if (pbrQueuedObjects.has(obj) || (obj.name && pbrQueuedNames.has(obj.name)) || (typeof target === 'string' && pbrQueuedNames.has(target))) {
      queueLive('studio.setEmissive', [obj, color, intensity], obj);
    }
    return obj;
  }

  createPBRMaterial(presetId, overrides = {}) {
    return buildPBRPresetMaterial(THREE, presetId, overrides);
  }

  getCreatedObjects() { return [...createdObjects]; }
  getObject(nameOrUuid) {
    if (!nameOrUuid) return null;
    const byName = mirror.getObjectByName(nameOrUuid);
    if (byName) return byName;
    let byUuid = null;
    mirror.traverse((o) => { if (!byUuid && o.uuid === nameOrUuid) byUuid = o; });
    return byUuid;
  }

  clearScene() { clearMirror(); return this; }

  animate(mesh, callback) {
    if (typeof mesh === 'function' && !callback) { callback = mesh; mesh = null; }
    if (typeof callback !== 'function') throw new TypeError('studio.animate requires a callback.');
    const entry = { mesh, callback };
    animationCallbacks.push(entry);
    stopRequested = false;
    startAnimationTimer();
    return () => {
      const index = animationCallbacks.indexOf(entry);
      if (index >= 0) animationCallbacks.splice(index, 1);
      if (!animationCallbacks.length) stopAnimationTimer();
    };
  }

  stopAnimations() {
    stopRequested = true;
    stopAnimationTimer();
    animationCallbacks.length = 0;
  }

  async placePrefab(id, options = {}) { return adoptAsset('studio.placePrefab', [id, options]); }
  async loadGLTF(url, options = {}) { return adoptAsset('studio.loadGLTF', [url, options]); }
  async addImage(options = {}) { return adoptAsset('studio.addImage', [options]); }
  async createRealisticHuman(options = {}) { return adoptAsset('studio.createRealisticHuman', [options]); }
  async loadHumanWithAnimation(clipNameOrOpts = 'Walk', showSkeleton = true, options = {}) {
    let clipName = clipNameOrOpts;
    let showSkel = showSkeleton;
    let opts = options;
    if (clipNameOrOpts && typeof clipNameOrOpts === 'object') {
      opts = clipNameOrOpts;
      clipName = opts.animation || opts.clipName || 'Walk';
      showSkel = opts.showSkeleton ?? opts.showBones ?? true;
    }
    if (!opts.keepScene) clearMirror();
    const model = await adoptAsset('studio.loadHumanWithAnimation', [clipName, showSkel, opts]);
    queueLive('studio.playCharacterAnimation', [model, clipName]);
    return model;
  }
  async createHumanoidArmature(options = {}) {
    const root = await adoptAsset('studio.createHumanoidArmature', [options]);
    return { armatureGroup: root, skeleton: root.userData.skeleton || null };
  }
  async createRiggedMannequin(options = {}) { return adoptAsset('studio.createRiggedMannequin', [options]); }

  addCamera(options = {}) { queueLive('studio.addCamera', [options]); return new THREE.PerspectiveCamera(options.fov ?? 50, 1, 0.1, 1000); }
  takeScreenshot() { queueLive('studio.takeScreenshot', []); return null; }
  renderVideo(options = {}) { return queueLiveAsync('studio.renderVideo', [options]); }
  recordDirectorWebM(options = {}) { return queueLiveAsync('studio.recordDirectorWebM', [options]); }
  setupProStudio(options = {}) { return queueLive('studio.setupProStudio', [{ ...options, withTurntable: false }]); }
  setShadingMode(mode = 'solid') { return queueLive('studio.setShadingMode', [mode]); }
  setMatCap(style = 'red-wax') { return queueLive('studio.setMatCap', [style]); }
  restoreMaterials() { return queueLive('studio.restoreMaterials', []); }
  setStudioBackdrop(enabled = true, color = '#2b2d30') { return queueLive('studio.setStudioBackdrop', [enabled, color]); }
  setAtmosphericFog(enabled = true, preset = 'studio') { return queueLive('studio.setAtmosphericFog', [enabled, preset]); }
  setSkyDome(enabled = true, elevation = 35, azimuth = 180) { return queueLive('studio.setSkyDome', [enabled, elevation, azimuth]); }
  applyProceduralPBR(target, options = {}) { return queueLiveAsync('studio.applyProceduralPBR', [target, options]); }
  setupSunLight(options = {}) { return queueLive('studio.setupSunLight', [options], null); }
  setRenderQuality(preset = 'studio', options = {}) { return queueLive('studio.setRenderQuality', [preset, options], null); }
  setTurntable(active = true, target = null) { return queueLive('studio.setTurntable', [Boolean(active), target]); }
  enterEditMode(mesh = null) { queueLive('studio.enterEditMode', [mesh]); editModeFacade.isActive = true; return true; }
  exitEditMode() { queueLive('studio.exitEditMode', []); editModeFacade.isActive = false; return true; }
  setEditSelectionMode(mode) { queueLive('studio.setEditSelectionMode', [mode]); editModeFacade.mode = mode; return true; }
  selectFace(index = 0) { return queueLive('studio.selectFace', [index], false); }
  selectEdge(index = 0) { return queueLive('studio.selectEdge', [index], false); }
  executeCommand(command = {}) { return queueLive('studio.tutor.command', [command], false); }
  extrude(distance = 0.5) { return queueLive('studio.extrude', [distance]); }
  inset(offset = 0.25) { return queueLive('studio.inset', [offset]); }
  subdivide() { return queueLive('studio.subdivide', []); }
  bevel(width = 0.08, segments = 1) { return queueLive('studio.bevel', [width, segments]); }
  deleteSelection() { return queueLive('studio.deleteSelection', []); }
  insertKeyframe(object = null, frame = null, channels = ['position', 'rotation', 'scale'], interp = 'smooth') { return queueLive('studio.insertKeyframe', [object, frame, channels, interp], null); }
  deleteKeyframe(object = null, frame = null) { return queueLive('studio.deleteKeyframe', [object, frame], false); }
  playAnimation() { return queueLive('studio.playAnimation', []); }
  pauseAnimation() { return queueLive('studio.pauseAnimation', []); }
  seekFrame(frame) { return queueLive('studio.seekFrame', [frame]); }
  insertBoneKeyframe(armatureOrMesh = null, boneNameOrBone = null, frame = null, channels = ['rotation'], interp = 'smooth') { return queueLive('studio.insertBoneKeyframe', [armatureOrMesh, boneNameOrBone, frame, channels, interp], null); }
  insertAllBonesKeyframe(armatureOrMesh = null, frame = null, channels = ['rotation'], interp = 'smooth') { return queueLive('studio.insertAllBonesKeyframe', [armatureOrMesh, frame, channels, interp], []); }
  applyMotionPreset(armatureOrMesh = null, presetKey = 'walk_cycle') { return queueLive('studio.applyMotionPreset', [armatureOrMesh, presetKey], false); }
  setFPS(fps = 30) { return queueLive('studio.setFPS', [fps]); }
  playCharacterAnimation(model, clipName = 'Walk') { return queueLive('studio.playCharacterAnimation', [model, clipName], null); }
  showSkeletonHelper(model, visible = true) { return queueLive('studio.showSkeletonHelper', [model, visible]); }
  autoSkin(mesh, armatureOrSkeleton = null) { return queueLive('studio.autoSkin', [mesh, armatureOrSkeleton], null); }
  autoSkinMesh(mesh, armatureOrSkeleton = null) { return this.autoSkin(mesh, armatureOrSkeleton); }
  setPose(characterOrSkeleton, poseKey) { return queueLive('studio.setPose', [characterOrSkeleton, poseKey], false); }
  resetPose(characterOrSkeleton = null, boneName = null) { return queueLive('studio.resetPose', [characterOrSkeleton, boneName], false); }
  mirrorPose(characterOrSkeleton = null, direction = 'left_to_right') { return queueLive('studio.mirrorPose', [characterOrSkeleton, direction], false); }
  setPoseMode(enabled, character = null) { return queueLive('studio.setPoseMode', [enabled, character], false); }
  setIKEnabled(enabled, character = null) { return queueLive('studio.setIKEnabled', [enabled, character], false); }
  toggleWeightPaint(character = null) { return queueLive('studio.toggleWeightPaint', [character], false); }
  cleanWeights(mesh = null, threshold = 0.01, maxInfluences = 4) { return queueLive('studio.cleanWeights', [mesh, threshold, maxInfluences], { cleanedVertices: 0, removedSlots: 0 }); }
  transferWeights(sourceMesh, targetMesh, options = {}) { return queueLive('studio.transferWeights', [sourceMesh, targetMesh, options], null); }
  addBoneConstraint(boneOrName, config = {}) { return queueLive('studio.addBoneConstraint', [boneOrName, config], null); }
  applyHumanoidLimits(characterOrSkeleton = null) { return queueLive('studio.applyHumanoidLimits', [characterOrSkeleton], 0); }
  keyframePose(target = null, boneOrAll = 'all', options = {}) { return queueLive('studio.keyframePose', [target, boneOrAll, options], { frame: 0, count: 0, boneNames: [], tracks: 0 }); }
  bakeRig(options = {}) { return queueLive('studio.bakeRig', [options], null); }
  setBoneDisplayMode(mode = 'octahedral') { return queueLive('studio.setBoneDisplayMode', [mode], mode); }
  applyMaterialPreset(target, presetKey) { return queueLive('studio.applyMaterialPreset', [target, presetKey], null); }
  simplify(target = null, ratio = 0.35, opts = {}) { return queueLiveAsync('studio.simplify', [target, ratio, opts]); }
  enableAutoLOD(target = null, opts = {}) { return queueLiveAsync('studio.enableAutoLOD', [target, opts]); }
  disableAutoLOD(target = null) { return queueLive('studio.disableAutoLOD', [target]); }
  scatter(source = null, surface = null, options = {}) {
    if (surface && typeof surface === 'object' && !surface.isObject3D && typeof surface !== 'string' && Object.keys(options).length === 0) {
      return queueLiveAsync('studio.scatter', [source, surface]);
    }
    return queueLiveAsync('studio.scatter', [source, surface, options]);
  }
  savePose(characterOrSkeleton = null, name = 'Pose') { return queueLive('studio.savePose', [characterOrSkeleton, name], null); }
  listPrefabs() { return queueLive('studio.listPrefabs', [], []); }
  searchPrefabs(query = '') { return queueLive('studio.searchPrefabs', [query], []); }
  batchToInstances(targets = [], options = {}) { return queueLiveAsync('studio.batchToInstances', [targets, options]); }

  _createModifiers() {
    return Object.freeze({
      add: (type, params = {}, mesh = null) => {
        const token = `pending_${++pendingModifierSequence}`;
        queueLive('studio.modifiers.add', [type, params, mesh], { id: token, type }, token);
        return { id: token, type };
      },
      update: (index, params, mesh = null) => queueLive('studio.modifiers.update', [index, params, mesh]),
      remove: (index, mesh = null) => queueLive('studio.modifiers.remove', [index, mesh]),
      toggle: (index, mesh = null) => queueLive('studio.modifiers.toggle', [index, mesh]),
      reorder: (from, to, mesh = null) => queueLive('studio.modifiers.reorder', [from, to, mesh]),
      bake: (upTo, mesh = null) => queueLiveAsync('studio.modifiers.bake', [upTo, mesh]),
      list: (mesh = null) => mesh?.userData?.modifierStack || [],
      evaluate: (mesh = null, opts = {}) => queueLiveAsync('studio.modifiers.evaluate', [mesh, opts])
    });
  }

  _createBpy() {
    const self = this;
    return {
      version: '4.x',
      ops: {
        object: {
          mode_set({ mode = 'OBJECT' } = {}) { return String(mode).toUpperCase() === 'EDIT' ? self.enterEditMode() : self.exitEditMode(); },
          modifier_add({ type = 'SUBSURF', ...params } = {}) {
            const normalized = String(type).toLowerCase();
            return self.modifiers.add(['subsurf', 'subdivide'].includes(normalized) ? 'subdivision' : normalized, params);
          },
          shade_smooth() { return queueLive('studio.setShadingMode', ['smooth']); },
          shade_flat() { return queueLive('studio.setShadingMode', ['solid']); },
          shade_auto_smooth({ angle = 30 } = {}) { return queueLive('studio.setShadingMode', ['auto', angle]); }
        },
        anim: {
          keyframe_insert({ data_path = 'all', frame = null } = {}) { return self.insertKeyframe(null, frame, data_path === 'all' ? ['position', 'rotation', 'scale'] : [data_path]); },
          keyframe_delete({ frame = null } = {}) { return self.deleteKeyframe(null, frame); }
        },
        screen: {
          animation_play() { self.playAnimation(); },
          animation_cancel() { self.pauseAnimation(); }
        },
        render: {
          render(opts = {}) { return opts.animation ? self.renderVideo(opts) : (queueLive('studio.takeScreenshot', []), null); }
        },
        mesh: {
          primitive_cube_add({ size = 2, location = [0, 0, 0], scale = [1, 1, 1] } = {}) { return self.addCube({ width: size * scale[0], height: size * scale[1], depth: size * scale[2], x: location[0], y: location[1], z: location[2] }); },
          primitive_uv_sphere_add({ radius = 1, location = [0, 0, 0], segments = 32 } = {}) { return self.addSphere({ radius, widthSegments: segments, x: location[0], y: location[1], z: location[2] }); },
          primitive_cylinder_add({ radius = 1, depth = 2, location = [0, 0, 0] } = {}) { return self.addCylinder({ radiusTop: radius, radiusBottom: radius, height: depth, x: location[0], y: location[1], z: location[2] }); },
          primitive_cone_add({ radius1 = 1, depth = 2, location = [0, 0, 0] } = {}) { return self.addCone({ radius: radius1, height: depth, x: location[0], y: location[1], z: location[2] }); },
          primitive_torus_add({ radius = 1, ring_radius = 0.25, location = [0, 0, 0] } = {}) { return self.addTorus({ radius, tube: ring_radius, x: location[0], y: location[1], z: location[2] }); },
          primitive_plane_add({ size = 2, location = [0, 0, 0] } = {}) { return self.addPlane({ width: size, height: size, x: location[0], y: location[1], z: location[2] }); },
          extrude_region_move({ distance = 0.5 } = {}) { return self.extrude(distance); },
          inset({ thickness = 0.25 } = {}) { return self.inset(thickness); },
          subdivide() { return self.subdivide(); },
          bevel({ offset = 0.08 } = {}) { return self.bevel(offset); },
          delete() { return self.deleteSelection(); }
        }
      }
    };
  }
}

function startAnimationTimer() {
  if (animationTimer !== null) return;
  animationStartedAt = performance.now();
  animationLastTick = animationStartedAt;
  animationTimer = setInterval(() => {
    const now = performance.now();
    const time = (now - animationStartedAt) / 1000;
    const delta = Math.min(0.1, (now - animationLastTick) / 1000);
    animationLastTick = now;
    const previous = new Map(animationBaseline);
    for (const entry of animationCallbacks) {
      try { entry.callback(time, delta, entry.mesh); } catch (error) { log.error('[Copilot Animation]', error?.message || String(error)); }
    }
    const nodes = [];
    const liveUUIDs = new Set();
    mirror.traverse((object) => {
      liveUUIDs.add(object.uuid);
      const signature = [
        object.position.x, object.position.y, object.position.z,
        object.quaternion.x, object.quaternion.y, object.quaternion.z, object.quaternion.w,
        object.scale.x, object.scale.y, object.scale.z, Number(object.visible),
      ];
      animationBaseline.set(object.uuid, signature);
      const before = previous.get(object.uuid);
      if (before && before.every((value, index) => value === signature[index])) return;
      nodes.push({ uuid: object.uuid, position: object.position.toArray(), quaternion: object.quaternion.toArray(), scale: object.scale.toArray(), visible: object.visible });
    });
    for (const uuid of animationBaseline.keys()) if (!liveUUIDs.has(uuid)) animationBaseline.delete(uuid);
    send({ kind: 'animation', nodes });
  }, 16);
}

function stopAnimationTimer() {
  if (animationTimer !== null) clearInterval(animationTimer);
  animationTimer = null;
  animationBaseline.clear();
}

const cameraMirror = new THREE.PerspectiveCamera(50, 1, 0.1, 2000);
const controlsMirror = Object.freeze({ target: new THREE.Vector3(), enabled: true, update() {} });
const rendererFacade = Object.freeze({
  domElement: null,
  shadowMap: { enabled: true, type: 0 },
  toneMapping: 0,
  toneMappingExposure: 1,
  render() {}, setSize() {}, setPixelRatio() {}, setClearColor() {}
});
let sceneFacade;
let engineFacade;
let studio;
let sceneManagerFacade;
let editModeFacade;
let modifiersFacade;
let simulationManagerFacade;
let tutorFacade;
let windowFacade;
let documentFacade;
let printFacade;
let setViewportModeFacade;
let setEditSelectionModeFacade;

function describeObject(object) {
  return {
    uuid: object.uuid,
    name: object.name,
    type: object.type,
    position: object.position.toArray(),
    rotation: [object.rotation.x, object.rotation.y, object.rotation.z],
    scale: object.scale.toArray(),
    children: object.children.map(describeObject)
  };
}

function plainValue(value, seen = new WeakSet()) {
  if (value?.isObject3D) return describeObject(value);
  if (value?.isColor) return `#${value.getHexString()}`;
  if (value?.isVector3 || value?.isVector2 || value?.isQuaternion) return value.toArray();
  if (value === undefined || typeof value === 'function') return null;
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return '[Circular]';
  seen.add(value);
  const out = Array.isArray(value) ? value.map((item) => plainValue(item, seen)) : Object.fromEntries(Object.entries(value).map(([key, item]) => [key, plainValue(item, seen)]));
  seen.delete(value);
  return out;
}

function buildFacades(initial) {
  studio = new WorkerStudio();
  sceneManagerFacade = Object.freeze({
    rootContainer: mirror,
    objects: new Map([...collectObjects().entries()].map(([uuid, object]) => [object.userData.id || uuid, object])),
    getActiveObject: () => selection[0] ? mirror.getObjectByProperty('uuid', selection[0]) || null : null,
    getSelectedObjects: () => selection.map((uuid) => mirror.getObjectByProperty('uuid', uuid)).filter(Boolean),
    select: (object, additive = false) => {
      const target = typeof object === 'string' ? mirror.getObjectByName(object) : object;
      if (!target) return false;
      if (!additive) selection.length = 0;
      if (!selection.includes(target.uuid)) selection.push(target.uuid);
      return true;
    },
    setSelection: (objects) => { selection = objects.filter(Boolean).map((object) => typeof object === 'string' ? mirror.getObjectByName(object)?.uuid : object.uuid).filter(Boolean); },
    resolveObject: (objectOrId) => typeof objectOrId === 'string' ? mirror.getObjectByName(objectOrId) || mirror.getObjectByProperty('uuid', objectOrId) : objectOrId,
    getObjectByName: (name) => mirror.getObjectByName(name),
    isSelected: (object) => selection.includes(object?.uuid)
  });
  editModeFacade = {
    isActive: !!initial.editMode?.active,
    mode: initial.editMode?.mode || 'vertex',
    faces: initial.editMode?.faces || [],
    edges: initial.editMode?.edges || [],
    vertices: initial.editMode?.vertices || [],
    enter(object) { queueLive('editMode.enter', [object]); this.isActive = true; return true; },
    exit() { queueLive('editMode.exit', []); this.isActive = false; return true; },
    setMode(mode) { queueLive('editMode.setMode', [mode]); this.mode = mode; },
    selectFace(index = 0) { queueLive('editMode.selectFace', [index]); if (!this.faces.includes(index)) this.faces.push(index); },
    selectEdge(index = 0) { queueLive('editMode.selectEdge', [index]); if (!this.edges.includes(index)) this.edges.push(index); },
    extrude(distance = 0.5) { return queueLive('editMode.extrude', [distance]); },
    inset(offset = 0.25) { return queueLive('editMode.inset', [offset]); },
    subdivide() { return queueLive('editMode.subdivide', []); },
    bevel(width = 0.08, segments = 1) { return queueLive('editMode.bevel', [width, segments]); },
    deleteSelection(mode = 'auto') { return queueLive('editMode.deleteSelection', [mode]); }
  };
  modifiersFacade = Object.freeze({
    applyModifier(mesh, type, params = {}) {
      const token = `pending_${++pendingModifierSequence}`;
      queueLive('Modifiers.applyModifier', [mesh, type, params], { id: token, type }, token);
      return { id: token, type };
    },
    applyBoolean(target, tool, operation = 'difference') { queueLive('Modifiers.applyBoolean', [target, tool, operation]); return target; },
    updateModifier(mesh, id, params = {}) { queueLive('Modifiers.updateModifier', [mesh, id, params]); },
    removeModifier(mesh, id) { queueLive('Modifiers.removeModifier', [mesh, id]); }
  });
  simulationManagerFacade = Object.freeze({
    bodies: new Map(),
    joints: new Map(),
    isPlaying: false,
    setConfig(object, partial = {}) { queueLive('simulationManager.setConfig', [object, partial]); return partial; },
    ensureInit() { return queueLiveAsync('simulationManager.ensureInit', []); }
  });
  tutorFacade = Object.freeze({
    pointAt(selector, speechText = '', opts = {}) { return queueLive('studio.tutor.pointAt', [selector, speechText, opts], null); },
    speak(text, opts = {}) { return queueLive('studio.tutor.speak', [text, opts], null); },
    setRate(rate = 1.2) { return queueLive('studio.tutor.setRate', [rate], rate); },
    command(cmd = {}) { return queueLiveAsync('studio.tutor.command', [cmd]); },
    guideSteps(steps = [], opts = {}) { return queueLiveAsync('studio.tutor.guideSteps', [steps, opts]); },
    stop() { return queueLive('studio.tutor.stop', [], false); },
    ask(question, opts = {}) { return queueLiveAsync('studio.tutor.ask', [question, opts]); },
    startLesson(lessonIdOrNumber, opts = {}) { return queueLiveAsync('studio.tutor.startLesson', [lessonIdOrNumber, opts]); },
    nextStep(opts = {}) { return queueLiveAsync('studio.tutor.nextStep', [opts]); },
    grade(opts = {}) { return queueLiveAsync('studio.tutor.grade', [opts]); },
    demo(opts = {}) { return queueLiveAsync('studio.tutor.demo', [opts]); },
    _switchModeSafely(mode) { return queueLive('setViewportMode', [mode], false); }
  });
  printFacade = (...args) => log.log(...args);
  setViewportModeFacade = (mode) => queueLive('setViewportMode', [mode], false);
  setEditSelectionModeFacade = (mode) => queueLive('setEditSelectionMode', [mode], false);
  documentFacade = Object.freeze({ createElement: () => null, getElementById: () => null, querySelector: () => null, querySelectorAll: () => [] });
  windowFacade = Object.freeze({
    THREE,
    scene: sceneFacade,
    studio,
    sceneManager: sceneManagerFacade,
    camera: cameraMirror,
    renderer: rendererFacade,
    engine: engineFacade,
    editMode: editModeFacade,
    modifiers: modifiersFacade,
    Modifiers: modifiersFacade,
    sculptMode: Object.freeze({ isActive: false, enter: () => queueLive('sculptMode.enter', []), exit: () => queueLive('sculptMode.exit', []) }),
    simulationManager: simulationManagerFacade,
    stemTutor: tutorFacade,
    bpy: studio.bpy,
    print: printFacade,
    setViewportMode: setViewportModeFacade,
    setEditSelectionMode: setEditSelectionModeFacade,
    requestAnimationFrame: (callback) => setTimeout(() => callback(performance.now()), 16),
    cancelAnimationFrame: (id) => clearTimeout(id)
  });
}

function collectObjects() {
  const objects = new Map();
  mirror.traverse((object) => objects.set(object.uuid, object));
  return objects;
}

function restoreMirrorTypes(node, object) {
  if (object && typeof node?.type === 'string') object.type = node.type;
  const children = Array.isArray(node?.children) ? node.children : [];
  children.forEach((child, index) => restoreMirrorTypes(child, object?.children?.[index]));
}

function initializeMirror(initial) {
  mirror = new THREE.ObjectLoader().parse(workerLoaderDocument(initial));
  restoreMirrorTypes(initial.scene, mirror);
  applyAnimations(initial);
  sceneFacade = new Proxy(mirror, {
    get(target, property) {
      if (property === 'clear') return clearMirror;
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
    set(target, property, value) { return Reflect.set(target, property, value, target); }
  });
  engineFacade = Object.freeze({ scene: sceneFacade, camera: cameraMirror, controls: controlsMirror, renderer: rendererFacade, isRunning: true });
}

self.onmessage = async (event) => {
  const message = event.data;
  if (message.kind === 'assetResult') {
    const pending = assetRequests.get(message.id);
    if (!pending) return;
    assetRequests.delete(message.id);
    if (message.error) pending.reject(Object.assign(new Error(message.error.message || 'Asset request failed.'), { code: message.error.code || 'E_ASSET' }));
    else pending.resolve({ assetId: message.assetId, payload: message.payload, skeletons: message.skeletons });
    return;
  }
  if (message.kind !== 'execute') return;

  try {
    if (typeof message.code !== 'string' || message.code.length > 200000) throw Object.assign(new Error('Copilot code must be a string under 200 KB.'), { code: 'E_INVALID_ARG' });
    if (scanGeneratedCode(message.code).violations.some((violation) => violation.id === 'code.import')) deny();
    const initial = validateScenePayload(message.scene);
    initializeMirror(initial);
    selection = Array.isArray(message.selection) ? [...message.selection] : [];
    commands = [];
    queuedCommandBytes = 0;
    clearRequested = false;
    stopRequested = false;
    animationCallbacks.length = 0;
    pendingAssets.clear();
    assetIds.clear();
    assetInitial.clear();
    createdObjects.clear();
    logEntries.length = 0;
    cameraMirror.position.fromArray(message.camera?.position || [6, 4, 8]);
    cameraMirror.quaternion.fromArray(message.camera?.quaternion || [0, 0, 0, 1]);
    if (message.camera?.target) controlsMirror.target.fromArray(message.camera.target);
    for (const key of ['zoom', 'fov', 'aspect', 'near', 'far']) {
      if (Number.isFinite(message.camera?.[key])) cameraMirror[key] = message.camera[key];
    }
    cameraMirror.updateProjectionMatrix();
    buildFacades(message);

    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    const parameters = [
      'THREE', 'scene', 'studio', 'sceneManager', 'camera', 'renderer', 'OrbitControls',
      'window', 'document', 'engine', 'editMode', 'modifiers', 'Modifiers', 'sculptMode',
      'simulationManager', 'stemTutor', 'bpy', 'print', 'setViewportMode', 'setEditSelectionMode',
      'extrude', 'inset', 'subdivide', 'bevel', 'deleteSelection'
    ];
    const values = [
      THREE, sceneFacade, studio, sceneManagerFacade, cameraMirror, rendererFacade,
      function OrbitControls() { return controlsMirror; }, windowFacade, documentFacade,
      engineFacade, editModeFacade, modifiersFacade, modifiersFacade,
      windowFacade.sculptMode, simulationManagerFacade, tutorFacade, studio.bpy,
      printFacade, setViewportModeFacade, setEditSelectionModeFacade,
      studio.extrude.bind(studio), studio.inset.bind(studio), studio.subdivide.bind(studio),
      studio.bevel.bind(studio), studio.deleteSelection.bind(studio)
    ];
    const run = new AsyncFunction(...parameters, `"use strict";\n${message.code}`);
    const value = await run(...values);
    if (pendingAssets.size) await Promise.all([...pendingAssets]);
    pendingAssets.clear();
    const payload = serializeScene(mirror);
    const activeAssets = [...assetIds.entries()].filter(([uuid]) => mirror.getObjectByProperty('uuid', uuid)).map(([uuid, assetId]) => ({ uuid, assetId }));
    send({
      kind: 'result',
      payload,
      selection: selection.filter((uuid) => mirror.getObjectByProperty('uuid', uuid)),
      commands,
      assets: activeAssets,
      value: plainValue(value),
      hasAnimations: animationCallbacks.length > 0,
      clearScene: clearRequested,
      stopAnimations: stopRequested
    });
  } catch (error) {
    pendingAssets.clear();
    send({ kind: 'error', error: { code: error?.code || 'E_EXECUTION', message: error?.message || String(error), stack: error?.stack }, logs: logEntries });
  }
};
