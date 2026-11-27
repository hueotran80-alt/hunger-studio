import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { LoadingManager } from 'three';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import { RapidStudio } from '../scripting/rapid-api.js';
import { prefabLibrary } from '../scripting/prefab-library.js';
import { RigSystem } from '../animation/rig-system.js';
import { createImageObject } from '../core/image-objects.js';
import { AddObjectCommand, RemoveObjectCommand, CompositeCommand } from '../core/scene-manager.js';
import {
  sceneLoaderDocument,
  serializeScene,
  scenePayloadSize,
  validateScenePayload,
  collectSceneObjects,
} from './copilot-serialization.js';

const MAX_CODE_BYTES = 200000;
const MAX_ASSET_BYTES = 50 * 1024 * 1024;
const WORKER_CSP_MARKERS = ["default-src 'none'", "connect-src 'none'", "worker-src 'none'"];

const LIVE_COMMANDS = new Set([
  'studio.addCamera', 'studio.takeScreenshot', 'studio.renderVideo', 'studio.recordDirectorWebM',
  'studio.setupProStudio', 'studio.setShadingMode', 'studio.setMatCap', 'studio.restoreMaterials',
  'studio.setStudioBackdrop', 'studio.setAtmosphericFog', 'studio.setSkyDome', 'studio.setTurntable',
  'studio.applyProceduralPBR', 'studio.exportModel', 'studio.setColor', 'studio.setEmissive', 'studio.setupSunLight', 'studio.setRenderQuality', 'studio.enterEditMode',
  'studio.exitEditMode', 'studio.setEditSelectionMode', 'studio.selectFace', 'studio.selectEdge',
  'studio.tutor.command', 'studio.extrude', 'studio.inset', 'studio.subdivide', 'studio.bevel',
  'studio.deleteSelection', 'studio.insertKeyframe', 'studio.deleteKeyframe', 'studio.playAnimation',
  'studio.pauseAnimation', 'studio.seekFrame', 'studio.insertBoneKeyframe', 'studio.insertAllBonesKeyframe',
  'studio.applyMotionPreset', 'studio.setFPS', 'studio.playCharacterAnimation', 'studio.showSkeletonHelper',
  'studio.autoSkin', 'studio.setPose', 'studio.savePose', 'studio.listPrefabs', 'studio.searchPrefabs', 'studio.resetPose', 'studio.mirrorPose', 'studio.setPoseMode',
  'studio.setIKEnabled', 'studio.toggleWeightPaint', 'studio.cleanWeights', 'studio.transferWeights',
  'studio.addBoneConstraint', 'studio.applyHumanoidLimits', 'studio.keyframePose', 'studio.bakeRig',
  'studio.setBoneDisplayMode', 'studio.applyMaterialPreset', 'studio.simplify', 'studio.enableAutoLOD',
  'studio.disableAutoLOD', 'studio.scatter', 'studio.batchToInstances', 'studio.modifiers.add',
  'studio.modifiers.update', 'studio.modifiers.remove', 'studio.modifiers.toggle', 'studio.modifiers.reorder',
  'studio.modifiers.bake', 'studio.modifiers.evaluate', 'editMode.enter', 'editMode.exit', 'editMode.setMode',
  'editMode.selectFace', 'editMode.selectEdge', 'editMode.extrude', 'editMode.inset', 'editMode.subdivide',
  'editMode.bevel', 'editMode.deleteSelection', 'Modifiers.applyModifier', 'Modifiers.applyBoolean',
  'Modifiers.updateModifier', 'Modifiers.removeModifier', 'simulationManager.setConfig',
  'simulationManager.ensureInit', 'studio.tutor.pointAt', 'studio.tutor.speak', 'studio.tutor.setRate',
  'studio.tutor.guideSteps', 'studio.tutor.stop', 'studio.tutor.ask', 'studio.tutor.startLesson',
  'studio.tutor.nextStep', 'studio.tutor.grade', 'studio.tutor.demo', 'setViewportMode',
  'setEditSelectionMode', 'sculptMode.enter', 'sculptMode.exit'
]);

const ASSET_METHODS = new Set([
  'studio.placePrefab', 'studio.loadGLTF', 'studio.addImage', 'studio.createRealisticHuman',
  'studio.loadHumanWithAnimation', 'studio.createHumanoidArmature', 'studio.createRiggedMannequin'
]);

function runtimeError(code, message) {
  return Object.assign(new Error(message), { code });
}

function hashText(text) {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

function payloadHash(payload) {
  return hashText(JSON.stringify(payload));
}

function flattenPayload(payload) {
  const nodes = new Map();
  const parents = new Map();
  const visit = (node, parentUUID) => {
    nodes.set(node.uuid, node);
    parents.set(node.uuid, parentUUID);
    for (const child of node.children) visit(child, node.uuid);
  };
  visit(payload.scene, null);
  return { nodes, parents };
}

function nodeSignature(node) {
  const {
    children, geometries, materials, textures, images, shapes, skeletons, animations,
    ...properties
  } = node;
  void children;
  void geometries;
  void materials;
  void textures;
  void images;
  void shapes;
  void skeletons;
  void animations;
  return JSON.stringify(properties);
}

function cloneData(value, seen = new WeakMap()) {
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((item) => cloneData(item, seen));
  if (ArrayBuffer.isView(value)) return value.slice();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return value;
  if (seen.has(value)) return seen.get(value);
  const out = Object.create(null);
  seen.set(value, out);
  for (const [key, item] of Object.entries(value)) out[key] = cloneData(item, seen);
  return out;
}

function dataSize(value, seen = new WeakSet(), depth = 0) {
  if (value === null || value === undefined || depth > 12) return 0;
  if (typeof value === 'string') return value.length * 2;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return 8;
  if (typeof value !== 'object') return 0;
  if (seen.has(value)) return 0;
  if (value.isObject3D || value.isTexture || value.isSkeleton || value.isCamera || value.isScene) return 64;
  seen.add(value);
  let size;
  if (value.isBufferGeometry) size = Object.keys(value.attributes || {}).length * 128;
  else if (value.isMaterial) size = Object.keys(value).length * 64;
  else if (ArrayBuffer.isView(value)) size = value.byteLength || 0;
  else if (Array.isArray(value)) size = value.reduce((sum, item) => sum + dataSize(item, seen, depth + 1), 0);
  else {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      seen.delete(value);
      return 64;
    }
    size = 0;
    for (const [key, item] of Object.entries(value)) size += key.length * 2 + dataSize(item, seen, depth + 1);
  }
  seen.delete(value);
  return size;
}

function resourceSignatures(payload, key) {
  const signatures = new Map();
  if (!Array.isArray(payload?.scene?.[key])) return signatures;
  for (const resource of payload.scene[key]) {
    if (resource?.uuid) signatures.set(resource.uuid, JSON.stringify(resource));
  }
  return signatures;
}

function changedResourceUUIDs(beforePayload, afterPayload, key) {
  const before = resourceSignatures(beforePayload, key);
  const after = resourceSignatures(afterPayload, key);
  const changed = new Set();
  for (const [uuid, signature] of after) {
    if (before.has(uuid) && before.get(uuid) !== signature) changed.add(uuid);
  }
  return changed;
}

function resourceReferences(reference) {
  if (reference === undefined || reference === null) return [];
  return Array.isArray(reference) ? reference : [reference];
}

function resourceChanged(reference, changedUUIDs) {
  return resourceReferences(reference).some((uuid) => changedUUIDs.has(uuid));
}

function animationSignatures(payload) {
  const signatures = new Map();
  for (const entry of payload?.animations || []) {
    if (entry?.objectUUID) signatures.set(entry.objectUUID, JSON.stringify(entry.clips || []));
  }
  return signatures;
}

function changedAnimationUUIDs(beforePayload, afterPayload) {
  const before = animationSignatures(beforePayload);
  const after = animationSignatures(afterPayload);
  const changed = new Set();
  for (const [uuid, signature] of after) {
    if (before.get(uuid) !== signature) changed.add(uuid);
  }
  for (const uuid of before.keys()) {
    if (!after.has(uuid)) changed.add(uuid);
  }
  return changed;
}

const TEXTURE_STATE_KEYS = [
  'name', 'mapping', 'wrapS', 'wrapT', 'magFilter', 'minFilter', 'format', 'type',
  'colorSpace', 'anisotropy', 'flipY', 'offset', 'repeat', 'rotation', 'center',
  'matrixAutoUpdate', 'unpackAlignment', 'premultiplyAlpha'
];

function cloneTextureValue(value) {
  if (value?.isVector2 || value?.isVector3 || value?.isMatrix3 || value?.isMatrix4) return value.clone();
  return value;
}

function captureTextureState(texture) {
  const state = {};
  for (const key of TEXTURE_STATE_KEYS) state[key] = cloneTextureValue(texture[key]);
  return state;
}

function textureStateFromJSON(json) {
  const state = {};
  for (const key of TEXTURE_STATE_KEYS) {
    if (!json || json[key] === undefined) continue;
    if (['offset', 'repeat', 'center'].includes(key) && Array.isArray(json[key])) {
      state[key] = new THREE.Vector2().fromArray(json[key]);
    } else {
      state[key] = json[key];
    }
  }
  return state;
}

function applyTextureState(texture, state) {
  for (const [key, value] of Object.entries(state || {})) {
    if (value?.isVector2 || value?.isVector3 || value?.isMatrix3 || value?.isMatrix4) texture[key].copy(value);
    else texture[key] = value;
  }
  texture.updateMatrix();
  texture.needsUpdate = true;
}

class CopilotTextureCommand {
  constructor(texture, before, after) {
    this.description = 'Copilot: change texture';
    this.texture = texture;
    this.before = before;
    this.after = after;
    this.bytes = dataSize(before) + dataSize(after);
  }

  execute() { applyTextureState(this.texture, this.after); }
  undo() { applyTextureState(this.texture, this.before); }
}

function detachPreexistingDescendants(object, existingUUIDs) {
  for (const child of [...object.children]) {
    if (existingUUIDs.has(child.uuid)) object.remove(child);
    else detachPreexistingDescendants(child, existingUUIDs);
  }
}

function registerObjectTree(sceneManager, object) {
  object.traverse((child) => {
    if (child === object) return;
    child.userData.id ||= sceneManager.THREE?.MathUtils?.generateUUID?.() || THREE.MathUtils.generateUUID();
    child.userData.selectable = child.userData.selectable !== false;
    child.userData.visible = child.visible !== false;
    child.userData.locked = child.userData.locked || false;
    sceneManager.objects.set(child.userData.id, child);
  });
}

function unregisterObjectTree(sceneManager, object) {
  object.traverse((child) => sceneManager.objects.delete(child.userData.id));
}

class CopilotAddObjectCommand extends AddObjectCommand {
  constructor(sceneManager, object, parent) {
    super(sceneManager, object, parent);
    this.initialResources = collectTreeResourceUUIDs(object);
    this.objectBefore = captureDescriptor(object);
    this.objectAfter = null;
  }

  execute() {
    if (!this.objectAfter) this.objectAfter = cloneDescriptor(captureDescriptor(this.object));
    else applyDescriptor(this.object, this.objectAfter);
    super.execute();
    registerObjectTree(this.sceneManager, this.object);
  }

  undo() {
    applyDescriptor(this.object, this.objectBefore);
    unregisterObjectTree(this.sceneManager, this.object);
    super.undo();
    disposeObjectTree(this.object, this.initialResources);
  }
}

class CopilotRemoveObjectCommand extends RemoveObjectCommand {
  constructor(sceneManager, object) {
    super(sceneManager, object);
    this.initialResources = collectTreeResourceUUIDs(object);
    this.objectBefore = cloneDescriptor(captureDescriptor(object));
  }

  execute() {
    super.execute();
    unregisterObjectTree(this.sceneManager, this.object);
  }

  undo() {
    super.undo();
    applyDescriptor(this.object, this.objectBefore);
    registerObjectTree(this.sceneManager, this.object);
  }
}

function parseClips(entries, objectUUID) {
  return (entries || []).find((entry) => entry.objectUUID === objectUUID)?.clips.map((clip) => THREE.AnimationClip.parse(clip)) || [];
}

function collectTreeResourceUUIDs(root) {
  const geometry = new Set();
  const material = new Set();
  root.traverse((object) => {
    if (object.geometry?.uuid) geometry.add(object.geometry.uuid);
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    for (const entry of materials) if (entry?.uuid) material.add(entry.uuid);
  });
  return { geometry, material };
}

function disposeObjectTree(object, resources) {
  const geometries = new Set();
  const materials = new Set();
  object.traverse((child) => {
    if (child.geometry?.isBufferGeometry && !resources?.geometry?.has(child.geometry.uuid)) geometries.add(child.geometry);
    const entries = Array.isArray(child.material) ? child.material : [child.material];
    for (const material of entries) {
      if (material?.isMaterial && !resources?.material?.has(material.uuid)) materials.add(material);
    }
  });
  geometries.forEach((geometry) => geometry.dispose?.());
  materials.forEach((material) => material.dispose?.());
}

function captureDescriptor(object) {
  return {
    name: object.name,
    position: object.position.clone(),
    quaternion: object.quaternion.clone(),
    scale: object.scale.clone(),
    visible: object.visible,
    castShadow: object.castShadow,
    receiveShadow: object.receiveShadow,
    renderOrder: object.renderOrder,
    frustumCulled: object.frustumCulled,
    userData: cloneData(object.userData),
    geometry: object.geometry || null,
    material: object.material || null,
    animations: (object.animations || []).map((clip) => clip.clone()),
  };
}

function cloneDescriptor(descriptor) {
  return {
    ...descriptor,
    position: descriptor.position.clone(),
    quaternion: descriptor.quaternion.clone(),
    scale: descriptor.scale.clone(),
    userData: cloneData(descriptor.userData),
    animations: descriptor.animations.map((clip) => clip.clone()),
  };
}

function applyDescriptor(object, descriptor) {
  object.name = descriptor.name;
  object.position.copy(descriptor.position);
  object.quaternion.copy(descriptor.quaternion);
  object.scale.copy(descriptor.scale);
  object.visible = descriptor.visible;
  object.castShadow = descriptor.castShadow;
  object.receiveShadow = descriptor.receiveShadow;
  object.renderOrder = descriptor.renderOrder;
  object.frustumCulled = descriptor.frustumCulled;
  object.userData = cloneData(descriptor.userData);
  if (object.geometry !== descriptor.geometry) object.geometry = descriptor.geometry;
  if (object.material !== descriptor.material) object.material = descriptor.material;
  object.animations = descriptor.animations.map((clip) => clip.clone());
  object.updateMatrix();
}

function descriptorResources(descriptor) {
  const geometry = descriptor?.geometry ? new Set([descriptor.geometry.uuid]) : new Set();
  const material = new Set();
  const entries = Array.isArray(descriptor?.material) ? descriptor.material : [descriptor?.material];
  for (const entry of entries) if (entry?.uuid) material.add(entry.uuid);
  return { geometry, material };
}

function CopilotObjectCommand(object, before, after, oldParent, newParent) {
  this.description = `Copilot: change ${after.name}`;
  this.object = object;
  this.before = cloneDescriptor(before);
  this.after = cloneDescriptor(after);
  this.oldParent = oldParent;
  this.newParent = newParent;
  this.bytes = dataSize(after.userData) + dataSize(before.userData);
  this.beforeResources = descriptorResources(before);
  this.afterResources = descriptorResources(after);
  this.initialResources = collectTreeResourceUUIDs(object);
  this.nextUndoResources = null;

  this.execute = () => {
    const previousResources = descriptorResources(captureDescriptor(this.object));
    if (this.object.parent !== this.newParent) this.newParent.add(this.object);
    applyDescriptor(this.object, this.after);
    disposeObjectResources(this.object, previousResources, this.initialResources);
    this.nextUndoResources = previousResources;
  };

  this.undo = () => {
    const previousResources = descriptorResources(captureDescriptor(this.object));
    if (this.object.parent !== this.oldParent) this.oldParent.add(this.object);
    applyDescriptor(this.object, this.before);
    disposeObjectResources(this.object, previousResources, this.nextUndoResources || this.beforeResources);
    this.nextUndoResources = previousResources;
  };
}

function disposeObjectResources(object, resources, preserved = { geometry: new Set(), material: new Set() }) {
  if (resources.geometry?.has(object.geometry?.uuid) && !preserved.geometry.has(object.geometry.uuid)) object.geometry.dispose?.();
  const materials = Array.isArray(object.material) ? object.material : [object.material];
  for (const material of materials) {
    if (resources.material?.has(material?.uuid) && !preserved.material.has(material.uuid)) material.dispose?.();
  }
}

function preserveMaterialTextures(previous, next) {
  if (!previous || !next || previous.type !== next.type) return next;
  const textureKeys = ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'emissiveMap', 'alphaMap', 'bumpMap', 'displacementMap', 'clearcoatMap', 'clearcoatNormalMap', 'clearcoatRoughnessMap', 'sheenColorMap', 'sheenRoughnessMap', 'transmissionMap', 'thicknessMap', 'iridescenceMap', 'iorMapLevels'];
  const hasTexture = textureKeys.some((key) => previous[key]?.isTexture);
  if (!hasTexture) return next;
  const material = previous.clone();
  const values = {};
  for (const [key, value] of Object.entries(next)) {
    if (textureKeys.includes(key) || key === 'userData' || key === 'uuid' || key === 'name') continue;
    if (value?.isColor) values[key] = value.clone();
    else if (value?.isVector2 || value?.isVector3 || value?.isMatrix3 || value?.isMatrix4) values[key] = value.clone();
    else if (value === null || ['number', 'string', 'boolean'].includes(typeof value)) values[key] = value;
  }
  material.setValues(values);
  material.name = next.name;
  material.needsUpdate = true;
  return material;
}

function materialFromJSON(json, previous) {
  if (!json) return null;
  if (Array.isArray(json)) return json.map((entry, index) => materialFromJSON(entry, Array.isArray(previous) ? previous[index] : previous));
  return preserveMaterialTextures(previous, new THREE.MaterialLoader().parse(json));
}

function payloadResource(table, reference) {
  if (typeof reference !== 'string' || !Array.isArray(table)) throw runtimeError('E_INVALID_RESULT', 'Scene object references a missing resource.');
  const resource = table.find((entry) => entry?.uuid === reference);
  if (!resource) throw runtimeError('E_INVALID_RESULT', `Scene resource is missing: ${reference}`);
  return resource;
}

function descriptorFromJSON(object, node, payload, previous, beforeNode = null, { forceGeometry = false, forceMaterial = false } = {}) {
  const descriptor = captureDescriptor(object);
  descriptor.name = node.name;
  descriptor.position.fromArray(node.position);
  descriptor.quaternion.fromArray(node.quaternion);
  descriptor.scale.fromArray(node.scale);
  descriptor.visible = node.visible;
  descriptor.castShadow = node.castShadow;
  descriptor.receiveShadow = node.receiveShadow;
  descriptor.renderOrder = node.renderOrder;
  descriptor.frustumCulled = node.frustumCulled;
  if (!beforeNode || JSON.stringify(node.userData || {}) !== JSON.stringify(beforeNode.userData || {})) {
    descriptor.userData = cloneData(node.userData || {});
    for (const key of ['skeleton', 'baseGeometry', 'cameraHelper', 'lightHelper', 'physicsBody']) {
      if (object.userData?.[key] !== undefined && descriptor.userData[key] === undefined) descriptor.userData[key] = object.userData[key];
    }
  }
  if (node.geometry !== undefined && (forceGeometry || !beforeNode || node.geometry !== beforeNode.geometry)) {
    descriptor.geometry = new THREE.BufferGeometryLoader().parse(payloadResource(payload.scene.geometries, node.geometry));
  }
  if (node.material !== undefined && (forceMaterial || !beforeNode || node.material !== beforeNode.material)) {
    const resolveMaterial = (reference, index = 0) => materialFromJSON(
      payloadResource(payload.scene.materials, reference),
      Array.isArray(previous?.material) ? previous.material[index] : previous?.material,
    );
    descriptor.material = Array.isArray(node.material)
      ? node.material.map((reference, index) => resolveMaterial(reference, index))
      : resolveMaterial(node.material);
  }
  descriptor.animations = parseClips(payload.animations, node.uuid);
  return descriptor;
}

function syncAssetTree(original, parsed, initialPayload, payload) {
  const originalNodes = collectSceneObjects(original);
  const initialNodes = flattenPayload(initialPayload).nodes;
  const afterNodes = flattenPayload(payload).nodes;
  const changedGeometry = changedResourceUUIDs(initialPayload, payload, 'geometries');
  const changedMaterial = changedResourceUUIDs(initialPayload, payload, 'materials');
  const changedAnimations = changedAnimationUUIDs(initialPayload, payload);
  for (const [uuid, source] of afterNodes) {
    const target = originalNodes.get(uuid);
    if (!target || target === original && uuid !== original.uuid) continue;
    const beforeNode = initialNodes.get(uuid);
    const geometryChanged = resourceChanged(source.geometry, changedGeometry);
    const materialChanged = resourceChanged(source.material, changedMaterial);
    if (!beforeNode || nodeSignature(source) !== nodeSignature(beforeNode) || geometryChanged || materialChanged || changedAnimations.has(uuid)) {
      const descriptor = descriptorFromJSON(target, source, payload, target, beforeNode, {
        forceGeometry: geometryChanged,
        forceMaterial: materialChanged,
      });
      applyDescriptor(target, descriptor);
    }
  }
  const syncChildren = (target, source) => {
    for (const child of [...target.children]) {
      const match = source.children.find((entry) => entry.uuid === child.uuid);
      if (match) syncChildren(child, match);
      else target.remove(child);
    }
    for (const child of source.children) {
      const existing = target.children.find((entry) => entry.uuid === child.uuid);
      if (!existing) target.add(child);
    }
  };
  syncChildren(original, parsed);
}

function replaceAssetRoots(parsedRoot, assets, payload) {
  for (const asset of assets.values()) {
    if (!asset.payload) continue;
    let parent = parsedRoot;
    let found = null;
    const visit = (object) => {
      for (const child of object.children) {
        if (child.uuid === asset.root.uuid) { parent = object; found = child; return true; }
        if (visit(child)) return true;
      }
      return false;
    };
    if (!visit(parsedRoot)) continue;
    syncAssetTree(asset.root, found, asset.payload, payload);
    const index = parent.children.indexOf(found);
    parent.children[index] = asset.root;
    asset.root.parent = parent;
    asset.adopted = true;
  }
}

function decodeCommandValue(value, objects, pendingModifierID, THREEAPI) {
  if (Array.isArray(value)) return value.map((item) => decodeCommandValue(item, objects, pendingModifierID, THREEAPI));
  const resolvePending = typeof pendingModifierID === 'function'
    ? pendingModifierID
    : (token) => token === 'pending' ? pendingModifierID : undefined;
  if (typeof value === 'string') return resolvePending(value) ?? value;
  if (!value || typeof value !== 'object') return value;
  if (value.__copilotUndefined) return undefined;
  if (value.__copilotObject) {
    const object = objects.get(value.__copilotObject);
    if (!object) throw runtimeError('E_INVALID_RESULT', `Live command references missing object ${value.__copilotObject}.`);
    return object;
  }
  if (value.__copilotColor) return new THREEAPI.Color(`#${value.__copilotColor}`);
  if (value.__copilotVector) {
    const Vector = value.__copilotVector.length === 2 ? THREEAPI.Vector2 : THREEAPI.Vector3;
    return new Vector().fromArray(value.__copilotVector);
  }
  if (value.__copilotQuaternion) return new THREEAPI.Quaternion().fromArray(value.__copilotQuaternion);
  return Object.fromEntries(Object.entries(value).map(([key, item]) => {
    if (key === 'id' && typeof item === 'string') {
      const resolved = resolvePending(item);
      if (resolved !== undefined) return [key, resolved];
    }
    return [key, decodeCommandValue(item, objects, pendingModifierID, THREEAPI)];
  }));
}

function rewritePendingTokens(value, pendingModifiers) {
  if (typeof value === 'string') return pendingModifiers.get(value) ?? value;
  if (Array.isArray(value)) return value.map((item) => rewritePendingTokens(item, pendingModifiers));
  if (!value || typeof value !== 'object') return value;
  if (value.__copilotAsyncToken && pendingModifiers.has(value.__copilotAsyncToken)) {
    return pendingModifiers.get(value.__copilotAsyncToken);
  }
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, rewritePendingTokens(item, pendingModifiers)]));
}

function resolveLiveCommand(method, context) {
  const roots = {
    studio: context.studio,
    editMode: context.editMode,
    Modifiers: context.modifiers,
    simulationManager: context.simulationManager,
    sculptMode: context.sculptMode,
  };
  if (method === 'setViewportMode') return context.setViewportMode;
  if (method === 'setEditSelectionMode') return context.setEditSelectionMode;
  const [root, ...path] = method.split('.');
  let parent = null;
  let target = roots[root];
  for (const key of path) {
    parent = target;
    target = target?.[key];
  }
  if (typeof target !== 'function') throw runtimeError('E_PERMISSION', `Live command is unavailable: ${method}`);
  return target.bind(parent || roots[root]);
}

const LIVE_COMMAND_META = Object.freeze({
  'studio.addCamera': { mutatesCamera: true, mutatesScene: true, mutatesSelection: true },
  'studio.setupProStudio': { mutatesCamera: true, mutatesScene: true },
  'studio.setupSunLight': { mutatesScene: true },
  'studio.setTurntable': { mutatesCamera: true },
  'studio.selectFace': { mutatesSelection: true, mutatesEditMode: true },
  'studio.selectEdge': { mutatesSelection: true, mutatesEditMode: true },
  'studio.enterEditMode': { mutatesSelection: true, mutatesEditMode: true },
  'studio.exitEditMode': { mutatesSelection: true, mutatesEditMode: true },
  'studio.setEditSelectionMode': { mutatesEditMode: true },
  'studio.extrude': { mutatesEditMode: true, mutatesScene: true },
  'studio.inset': { mutatesEditMode: true, mutatesScene: true },
  'studio.subdivide': { mutatesEditMode: true, mutatesScene: true },
  'studio.bevel': { mutatesEditMode: true, mutatesScene: true },
  'studio.deleteSelection': { mutatesSelection: true, mutatesEditMode: true, mutatesScene: true },
  'editMode.enter': { mutatesSelection: true, mutatesEditMode: true },
  'editMode.exit': { mutatesSelection: true, mutatesEditMode: true },
  'editMode.setMode': { mutatesEditMode: true },
  'editMode.selectFace': { mutatesSelection: true, mutatesEditMode: true },
  'editMode.selectEdge': { mutatesSelection: true, mutatesEditMode: true },
  'editMode.extrude': { mutatesEditMode: true, mutatesScene: true },
  'editMode.inset': { mutatesEditMode: true, mutatesScene: true },
  'editMode.subdivide': { mutatesEditMode: true, mutatesScene: true },
  'editMode.bevel': { mutatesEditMode: true, mutatesScene: true },
  'editMode.deleteSelection': { mutatesSelection: true, mutatesEditMode: true, mutatesScene: true },
  'studio.modifiers.add': { mutatesScene: true },
  'studio.modifiers.update': { mutatesScene: true },
  'studio.modifiers.remove': { mutatesScene: true },
  'studio.modifiers.toggle': { mutatesScene: true },
  'studio.modifiers.reorder': { mutatesScene: true },
  'studio.modifiers.bake': { mutatesScene: true },
  'studio.modifiers.evaluate': { mutatesScene: true },
  'Modifiers.applyModifier': { mutatesScene: true },
  'Modifiers.applyBoolean': { mutatesScene: true },
  'Modifiers.updateModifier': { mutatesScene: true },
  'Modifiers.removeModifier': { mutatesScene: true },
  'studio.applyProceduralPBR': { mutatesScene: true },
  'studio.setColor': { mutatesScene: true },
  'studio.setEmissive': { mutatesScene: true },
  'studio.applyMaterialPreset': { mutatesScene: true },
  'studio.batchToInstances': { mutatesScene: true, mutatesSelection: true },
  'studio.scatter': { mutatesScene: true },
  'studio.simplify': { mutatesScene: true },
  'sculptMode.enter': { mutatesEditMode: true },
  'sculptMode.exit': { mutatesEditMode: true },
  'simulationManager.setConfig': { mutatesScene: true },
  'simulationManager.ensureInit': { mutatesScene: true },
});

function resolveLiveCommandTargets(command, args, context) {
  if (command.startsWith('Modifiers.')) return args.filter((value) => value?.isMesh);
  if (command.startsWith('studio.modifiers.')) {
    const mesh = args[2] || context.sceneManager?.getActiveObject?.();
    return mesh?.isMesh ? [mesh] : [];
  }
  const IMPLICIT_EDIT_CMDS = new Set([
    'studio.extrude', 'studio.inset', 'studio.subdivide', 'studio.bevel',
    'studio.deleteSelection', 'studio.enterEditMode', 'studio.exitEditMode',
  ]);
  if (command.startsWith('editMode.') || IMPLICIT_EDIT_CMDS.has(command)) {
    const object = context.editMode?.targetMesh
      || context.editMode?.selectedObject
      || context.editMode?.mesh
      || args.find((v) => v?.isObject3D)
      || context.sceneManager?.getActiveObject?.();
    return object?.isObject3D ? [object] : [];
  }
  if (command.startsWith('sculptMode.')) {
    const object = context.sculptMode?.mesh
      || args.find((v) => v?.isObject3D)
      || context.sceneManager?.getActiveObject?.();
    return object?.isObject3D ? [object] : [];
  }
  const found = [];
  const collect = (obj) => {
    if (!obj?.isObject3D) return;
    if (obj.isMesh || obj.isInstancedMesh || context.sceneManager?.objects?.has(obj.userData?.id)) found.push(obj);
    if (obj.children?.length) {
      obj.traverse((child) => {
        if (child !== obj && (child.isMesh || child.isInstancedMesh)) found.push(child);
      });
    }
  };
  for (const value of args) {
    if (value?.isObject3D) collect(value);
    else if (typeof value === 'string' && value.trim()) {
      const resolved = context.studio?.getObject?.(value)
        || context.sceneManager?.rootContainer?.getObjectByName?.(value)
        || null;
      if (resolved) collect(resolved);
    }
  }
  return found;
}

function isAttachedToSceneRoot(obj, root) {
  if (!obj || !root) return false;
  let cur = obj;
  while (cur) {
    if (cur === root) return true;
    cur = cur.parent;
  }
  return false;
}

function sanitizeSelectionAndTransformControls(sm, engine, preferredFallback = null) {
  const root = sm?.rootContainer;
  if (!root) return;

  // 1. Prune any removed/parentless objects from SceneManager selection
  const currentSel = sm.getSelectedObjects?.() || [];
  const validSel = currentSel.filter((obj) => isAttachedToSceneRoot(obj, root));
  if (validSel.length !== currentSel.length) {
    const nextSel = validSel.length > 0
      ? validSel
      : (preferredFallback && isAttachedToSceneRoot(preferredFallback, root) ? [preferredFallback] : []);
    try { sm.setSelection?.(nextSel); } catch (_) {}
  } else if (validSel.length === 0 && preferredFallback && isAttachedToSceneRoot(preferredFallback, root)) {
    try { sm.setSelection?.([preferredFallback]); } catch (_) {}
  }

  // 2. Never leave TransformControls attached to a detached/removed object
  const tc = engine?.transformControls;
  if (tc && tc.object && !isAttachedToSceneRoot(tc.object, root)) {
    try { tc.detach?.(); } catch (_) {}
    const active = sm.getActiveObject?.();
    if (active && isAttachedToSceneRoot(active, root) && typeof tc.attach === 'function') {
      try { tc.attach(active); } catch (_) {}
    }
  }
}

async function dispatchLiveCommands(commands, context, objects) {
  const results = [];
  const pendingModifiers = new Map();
  let mutatedSelection = false;
  const signal = context.liveSignal || null;
  const sm = context.sceneManager;
  for (const command of commands) {
    if (signal?.aborted) {
      throw runtimeError('E_TIMEOUT', 'Copilot live commands exceeded execution deadline.');
    }
    if (!LIVE_COMMANDS.has(command?.method) || !Array.isArray(command.args) || command.args.length > 64) {
      throw runtimeError('E_PERMISSION', 'Worker returned a non-allowlisted live command.');
    }
    const meta = LIVE_COMMAND_META[command.method] || {};
    const method = resolveLiveCommand(command.method, context);
    const args = command.args.map((value) => decodeCommandValue(
      value,
      objects,
      (token) => pendingModifiers.get(token),
      context.THREE,
    ));
    if (signal && (command.method === 'studio.applyProceduralPBR' || command.method === 'studio.exportModel' || command.method === 'studio.renderVideo')) {
      const optIdx = command.method === 'studio.applyProceduralPBR' ? 1 : 0;
      args[optIdx] = { ...(args[optIdx] && typeof args[optIdx] === 'object' ? args[optIdx] : {}), signal };
    }
    if (command.method.startsWith('studio.modifiers.')) {
      const mesh = args[2] || sm?.getActiveObject?.();
      const stack = mesh?.userData?.modifierStack || [];
      const positions = command.method === 'studio.modifiers.reorder' ? [0, 1] : [0];
      if (['studio.modifiers.update', 'studio.modifiers.remove', 'studio.modifiers.toggle', 'studio.modifiers.reorder'].includes(command.method)) {
        for (const position of positions) {
          const index = stack.findIndex((modifier) => modifier.id === args[position]);
          if (index < 0) throw runtimeError('E_INVALID_RESULT', 'Live command references a missing modifier.');
          args[position] = index;
        }
      }
    }

    const targets = [...new Map(resolveLiveCommandTargets(command.method, args, context).map((object) => [object.uuid, {
      object,
      before: captureDescriptor(object),
    }])).values()];
    const beforeObjs = new Map(collectSceneObjects(sm.rootContainer));
    const cmdPreSelection = JSON.stringify(sm.getSelectedObjects?.().map((o) => o.uuid) || []);
    const cmdPreCamera = JSON.stringify(cameraSnapshot(context.camera, context.engine));

    let applied = false;
    const prevAllowCmd = Boolean(context._allowLiveExecuteCommand);
    context._allowLiveExecuteCommand = Boolean(meta.mutatesScene || meta.mutatesEditMode);
    try {
      const result = await method(...args);
      if (signal?.aborted) {
        throw runtimeError('E_TIMEOUT', 'Copilot live commands exceeded execution deadline.');
      }
      // Verify per-command selection/camera isolation strictly via explicit command metadata (no regex guessing)
      const cmdPostSelection = JSON.stringify(sm.getSelectedObjects?.().map((o) => o.uuid) || []);
      const cmdPostCamera = JSON.stringify(cameraSnapshot(context.camera, context.engine));
      if (!meta.mutatesSelection && cmdPostSelection !== cmdPreSelection) {
        throw runtimeError('E_TX_CONFLICT', `Selection changed externally during ${command.method}; rolling back cleanly.`);
      }
      if (!meta.mutatesCamera && cmdPostCamera !== cmdPreCamera) {
        throw runtimeError('E_TX_CONFLICT', `Camera changed externally during ${command.method}; rolling back cleanly.`);
      }
      applied = true;
      if (meta.mutatesSelection) mutatedSelection = true;
      if (command.method === 'studio.modifiers.add' || command.method === 'Modifiers.applyModifier') {
        const mesh = args[2] || sm?.getActiveObject?.();
        const stack = mesh?.userData?.modifierStack || [];
        const modifierID = result?.id || result?.modifier?.id || stack.at(-1)?.id;
        if (command.pendingToken && modifierID) pendingModifiers.set(command.pendingToken, modifierID);
      } else if (command.pendingToken && result !== undefined) {
        pendingModifiers.set(command.pendingToken, result);
      }
      results.push(result);
    } finally {
      context._allowLiveExecuteCommand = true;
      try {
        // Track any newly added top-level/child objects (e.g. addCamera, scatter, batchToInstances) so rollback removes them cleanly!
        let preferredAdded = null;
        const afterObjs = new Map(collectSceneObjects(sm.rootContainer));
        for (const [uuid, addedObj] of afterObjs) {
          if (beforeObjs.has(uuid) || addedObj === sm.rootContainer) continue;
          if (addedObj.parent && !beforeObjs.has(addedObj.parent.uuid)) continue; // covered by ancestor
          if (!preferredAdded) preferredAdded = addedObj;
          const addCmd = new CopilotAddObjectCommand(sm, addedObj, addedObj.parent || sm.rootContainer);
          if (!applied) {
            addCmd.undo();
          } else {
            // Only record if the live command itself didn't already push an add command for this object
            const curBatch = sm._batchStack?.at(-1)?.commands || [];
            const alreadyTracked = curBatch.some((c) => c?.object === addedObj || c?.scatterGroup === addedObj);
            if (!alreadyTracked) sm.recordExecutedCommand(addCmd);
          }
        }
        for (const { object, before } of targets) {
          const after = captureDescriptor(object);
          if (JSON.stringify(before) === JSON.stringify(after)) continue;
          const commandRecord = new CopilotObjectCommand(object, before, after, object.parent, object.parent);
          if (!applied) {
            commandRecord.undo();
          } else {
            try {
              sm.recordExecutedCommand(commandRecord);
            } catch (recErr) {
              commandRecord.undo();
              throw recErr;
            }
          }
        }
        // Detach TransformControls if pointing to a deleted source and keep selection bound to live scene objects
        sanitizeSelectionAndTransformControls(sm, context.engine, applied ? preferredAdded : null);
      } finally {
        context._allowLiveExecuteCommand = prevAllowCmd;
      }
    }
  }
  return { results, pendingModifiers, mutatedSelection };
}

function validAssetURL(raw, { image = false } = {}) {
  if (typeof raw !== 'string' || !raw.trim() || raw.length > 4096) throw runtimeError('E_PERMISSION', 'Invalid asset URL.');
  if (/^data:image\/(?:png|jpe?g|webp|gif);base64,[A-Za-z0-9+/=]+$/i.test(raw)) {
    if (!image) throw runtimeError('E_PERMISSION', 'GLTF assets must use same-origin files.');
    return raw;
  }
  const rawPath = raw.split(/[?#]/, 1)[0];
  if (rawPath.includes('\\') || /(?:^|\/)\.{1,2}(?:\/|$)/.test(rawPath) || /%(?:2e|2f|5c)/i.test(rawPath)) {
    throw runtimeError('E_PERMISSION', 'Asset path traversal is not allowed.');
  }
  let url;
  try { url = new URL(raw, globalThis.location?.href || 'http://localhost/'); } catch { throw runtimeError('E_PERMISSION', 'Invalid asset URL.'); }
  const localOrigin = globalThis.location?.origin || 'http://localhost';
  if (url.protocol === 'blob:') {
    if (!globalThis.location?.origin || globalThis.location.origin === 'null') {
      throw runtimeError('E_PERMISSION', 'Blob asset URLs require a browser same-origin context.');
    }
    let blobInnerOrigin = '';
    try { blobInnerOrigin = new URL(url.pathname).origin; } catch { blobInnerOrigin = ''; }
    if (!blobInnerOrigin || blobInnerOrigin !== localOrigin) {
      throw runtimeError('E_PERMISSION', 'Copilot blob assets must use same-origin URLs.');
    }
    return url.href;
  }
  if (url.origin !== localOrigin) throw runtimeError('E_PERMISSION', 'Copilot assets must use same-origin URLs.');
  let pathname;
  try { pathname = decodeURIComponent(url.pathname); } catch { throw runtimeError('E_PERMISSION', 'Invalid asset path.'); }
  if (pathname.includes('\\') || pathname.split('/').includes('..') || /^\/api(?:\/|$)/i.test(pathname)) {
    throw runtimeError('E_PERMISSION', 'Asset path is not allowed.');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw runtimeError('E_PERMISSION', 'Unsupported asset protocol.');
  return url.href;
}

async function fetchLimitedAsset(url, { signal } = {}) {
  const response = await fetch(validAssetURL(url), { credentials: 'same-origin', signal });
  if (!response.ok) throw runtimeError('E_ASSET', `Asset request failed (${response.status}).`);
  const declaredSize = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredSize) && declaredSize > MAX_ASSET_BYTES) throw runtimeError('E_LIMIT', 'Asset exceeds the 50 MB safety limit.');
  if (!response.body) {
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > MAX_ASSET_BYTES) throw runtimeError('E_LIMIT', 'Asset exceeds the 50 MB safety limit.');
    return buffer;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_ASSET_BYTES) {
      await reader.cancel();
      throw runtimeError('E_LIMIT', 'Asset exceeds the 50 MB safety limit.');
    }
    chunks.push(value);
  }
  const buffer = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.byteLength; }
  return buffer.buffer;
}

async function loadGLTFAsset(url, name = 'Imported_Model', { signal } = {}) {
  const manager = new LoadingManager();
  manager.setURLModifier((resourceURL) => /^data:image\//i.test(resourceURL) ? resourceURL : validAssetURL(resourceURL));
  const loader = new GLTFLoader(manager);
  const buffer = await fetchLimitedAsset(url, { signal });
  const resolved = validAssetURL(url);
  const basePath = resolved.slice(0, resolved.lastIndexOf('/') + 1);
  const gltf = await loader.parseAsync(buffer, basePath);
  const root = gltf.scene || gltf.scenes?.[0];
  if (!root) throw runtimeError('E_ASSET', 'GLTF file contains no scene.');
  root.name = name;
  root.animations = gltf.animations || [];
  return root;
}

function createStaging(sceneManager) {
  const scene = new THREE.Scene();
  const rootContainer = new THREE.Group();
  rootContainer.name = 'Copilot_Asset_Staging';
  scene.add(rootContainer);
  const objects = new Map();
  const stagingManager = {
    scene,
    rootContainer,
    objects,
    addObject(object, parent = null, selectAfter = false, recordHistory = false) {
      void selectAfter; void recordHistory;
      object.userData.id ||= THREE.MathUtils.generateUUID();
      (parent || rootContainer).add(object);
      objects.set(object.userData.id, object);
      return object;
    },
    getSelectedObjects: () => [],
    getActiveObject: () => null,
  };
  const studio = new RapidStudio({ scene, camera: new THREE.PerspectiveCamera(), renderer: null, sceneManager: stagingManager, engine: null, THREE });
  return { scene, rootContainer, objects, studio };
}

function applyGLTFOptions(root, options = {}) {
  root.position.set(Number(options.x) || 0, Number(options.y) || 0, Number(options.z) || 0);
  if (Array.isArray(options.scale)) root.scale.fromArray(options.scale.map(Number));
  else root.scale.setScalar(Number(options.scale) || 1);
  root.rotation.set(Number(options.rotationX) || 0, Number(options.rotationY) || 0, Number(options.rotationZ) || 0);
  root.traverse((child) => {
    if (!child.isMesh) return;
    child.castShadow = options.castShadow !== false;
    child.receiveShadow = options.receiveShadow !== false;
    if (child.material) child.material.side = THREE.DoubleSide;
  });
}

async function loadPrefabAsset(id, options, signal) {
  const entry = prefabLibrary.get(id);
  if (!entry) throw runtimeError('E_ASSET', `Prefab does not exist: ${id}`);
  const template = await loadGLTFAsset(entry.url, entry.name, { signal });
  if (entry.naturalHeight > 0) {
    const size = new THREE.Box3().setFromObject(template).getSize(new THREE.Vector3());
    if (size.y > 1e-6) template.scale.setScalar(entry.naturalHeight / size.y);
  }
  let skinned = false;
  template.traverse((child) => { if (child.isSkinnedMesh) skinned = true; });
  const root = skinned ? cloneSkinned(template) : template.clone(true);
  root.name = options.name || entry.id;
  root.position.set(Number(options.x) || 0, Number(options.y) || 0, Number(options.z) || 0);
  root.rotation.set(Number(options.rotationX) || 0, Number(options.rotationY) || 0, Number(options.rotationZ) || 0);
  let scale = 1;
  if (options.scale !== undefined) scale = Number(options.scale) || 1;
  else if (options.height !== undefined && entry.naturalHeight > 0) scale = (Number(options.height) || entry.naturalHeight) / entry.naturalHeight;
  root.scale.multiplyScalar(scale);
  if (/soldier/i.test(entry.url)) root.rotation.y += Math.PI;
  root.traverse((child) => {
    if (!child.isMesh) return;
    child.castShadow = true;
    child.receiveShadow = true;
  });
  return root;
}

async function stageImageAsset(options, staging, context) {
  const source = options.src || options.source || null;
  let resolvedSource = source;
  let objectURL = null;
  try {
    if (source) {
      validAssetURL(source, { image: true });
      if (!source.startsWith('data:')) {
        const buffer = await fetchLimitedAsset(source, { signal: context.assetSignal });
        objectURL = URL.createObjectURL(new Blob([buffer]));
        resolvedSource = objectURL;
      }
    }
    const root = await createImageObject({
      ...options,
      src: resolvedSource,
      sceneManager: staging,
      scene: null,
      camera: context.camera,
      recordHistory: false,
      selectAfter: false,
    });
    if (source) root.userData.imageSrc = source;
    return root;
  } finally {
    if (objectURL) URL.revokeObjectURL(objectURL);
  }
}

function assetSkeletons(root) {
  const skeletons = [];
  const seen = new Set();
  const add = (objectUUID, skeleton) => {
    if (!skeleton?.bones?.length || seen.has(skeleton)) return;
    seen.add(skeleton);
    skeletons.push({ objectUUID, boneUUIDs: skeleton.bones.map((bone) => bone.uuid) });
  };
  if (root.userData?.skeleton) add(root.uuid, root.userData.skeleton);
  root.traverse((object) => { if (object.isSkinnedMesh && object.skeleton) add(object.uuid, object.skeleton); });
  return skeletons;
}

async function stageAsset(method, args, context) {
  const staging = createStaging(context.sceneManager);
  let root;
  try {
    if (method === 'studio.placePrefab') {
      const [id, options = {}] = args;
      root = await loadPrefabAsset(id, options, context.assetSignal);
    } else if (method === 'studio.loadGLTF') {
      const [url, options = {}] = args;
      root = await loadGLTFAsset(url, options.name || 'Imported_Model', { signal: context.assetSignal });
      applyGLTFOptions(root, options);
    } else if (method === 'studio.addImage') {
      root = await stageImageAsset(args[0] || {}, staging, context);
    } else if (method === 'studio.createRealisticHuman') {
      const options = args[0] || {};
      const type = String(options.type || 'female').toLowerCase();
      let url;
      let name = options.name || 'Realistic_Human';
      let scale = Number(options.scale) || 1;
      let y = Number(options.y) || 0;
      if (type === 'female' || type === 'mannequin') url = '/models/Mannequin_CC0.glb';
      else if (type === 'bot' || type === 'male' || type === 'soldier') url = '/models/Bot_CC0.glb';
      else if (type === 'head_scan') {
        url = '/models/LeePerrySmith.glb';
        name = 'Realistic_Human_Head_Scan';
        scale *= 0.12;
        y += 1.2;
      } else throw runtimeError('E_ASSET', `Unsupported human type: ${type}`);
      root = await loadGLTFAsset(url, name, { signal: context.assetSignal });
      applyGLTFOptions(root, { ...options, name, scale, y });
    } else if (method === 'studio.loadHumanWithAnimation') {
      const [clipName, showSkeleton, options = {}] = args;
      const normalized = String(clipName || 'Walk').toLowerCase();
      const candidates = options.url ? [options.url] : normalized.includes('idle') ? ['/models/Mannequin_CC0.glb', '/models/Bot_CC0.glb'] : ['/models/Bot_CC0.glb', '/models/Mannequin_CC0.glb'];
      let lastError;
      for (const url of candidates) {
        try { root = await loadGLTFAsset(url, options.name || 'Loaded_Human', { signal: context.assetSignal }); break; } catch (error) { lastError = error; }
      }
      if (!root) throw lastError;
      root.traverse((child) => { if (child.isMesh) { child.castShadow = true; child.receiveShadow = true; } });
      void showSkeleton;
    } else if (method === 'studio.createHumanoidArmature' || method === 'studio.createRiggedMannequin') {
      const options = args[0] || {};
      const rig = new RigSystem({ THREE, scene: staging.scene, sceneManager: staging, engine: null });
      rig.createSkeletonVisualizer = () => {};
      if (method === 'studio.createHumanoidArmature') {
        const result = rig.createHumanoidArmature(Number(options.height) || 1.8, { addToScene: false });
        root = result.armatureGroup;
      } else {
        root = rig.createRiggedMannequin(Number(options.height) || 1.8, { skinned: options.skinned !== false });
      }
      root.position.set(Number(options.x) || 0, Number(options.y) || 0, Number(options.z) || 0);
      root.name = options.name || root.name;
    } else {
      throw runtimeError('E_PERMISSION', `Asset method is not allowed: ${method}`);
    }
    if (!root) throw runtimeError('E_ASSET', 'Asset loader returned no object.');
    if (!root.parent) staging.rootContainer.add(root);
    staging.objects.set(root.userData.id ||= THREE.MathUtils.generateUUID(), root);
    const payload = serializeScene(root);
    return { root, payload, skeletons: assetSkeletons(root), adopted: false };
  } catch (error) {
    staging.scene.traverse((object) => {
      object.geometry?.dispose?.();
      if (Array.isArray(object.material)) object.material.forEach((material) => material.dispose?.());
      else object.material?.dispose?.();
    });
    throw error;
  }
}

function validateAnimationMessage(message, objects) {
  if (!Array.isArray(message.nodes) || message.nodes.length > 5000) throw runtimeError('E_INVALID_RESULT', 'Invalid animation frame.');
  const updates = [];
  const seen = new Set();
  for (const node of message.nodes) {
    if (!node || seen.has(node.uuid) || !objects.has(node.uuid)) continue;
    seen.add(node.uuid);
    for (const [key, length] of [['position', 3], ['quaternion', 4], ['scale', 3]]) {
      if (!Array.isArray(node[key]) || node[key].length !== length || !node[key].every(Number.isFinite)) throw runtimeError('E_INVALID_RESULT', `Invalid animation ${key}.`);
    }
    if (typeof node.visible !== 'boolean') throw runtimeError('E_INVALID_RESULT', 'Invalid animation visibility.');
    updates.push(node);
  }
  return updates;
}

function collectSceneTextures(root) {
  const textures = new Map();
  root.traverse((object) => {
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of materials) {
      for (const value of Object.values(material || {})) {
        if (value?.isTexture) textures.set(value.uuid, value);
      }
    }
  });
  return textures;
}

function cameraSnapshot(camera, engine) {
  if (!camera) return null;
  return {
    uuid: camera.uuid,
    activeUUID: engine?.camera?.uuid || null,
    type: camera.type,
    position: camera.position.toArray(),
    quaternion: camera.quaternion.toArray(),
    zoom: camera.zoom,
    fov: camera.fov,
    aspect: camera.aspect,
    near: camera.near,
    far: camera.far,
    target: engine?.controls?.target?.toArray?.() || null,
  };
}

export class CopilotRuntime {
  constructor(options = {}) {
    this.sceneManager = options.sceneManager;
    this.studio = options.studio;
    this.THREE = options.THREE || THREE;
    this.camera = options.camera;
    this.engine = options.engine;
    this.editMode = options.editMode;
    this.modifiers = options.modifiers;
    this.simulationManager = options.simulationManager;
    this.sculptMode = options.sculptMode;
    this.stemTutor = options.stemTutor;
    this.setViewportMode = options.setViewportMode;
    this.setEditSelectionMode = options.setEditSelectionMode;
    this.activeSession = null;
  }

  stop() {
    const session = this.activeSession;
    this.activeSession = null;
    if (!session) return;
    session.stopped = true;
    session.abort?.abort();
    session.worker?.terminate();
    session.cancel?.(runtimeError('E_CANCELLED', 'Copilot execution was stopped.'));
  }

  async execute(code, { timeout = 30000, onLog } = {}) {
    if (!this.sceneManager?.rootContainer) throw runtimeError('E_INVALID_ARG', 'SceneManager is not available.');
    if (typeof code !== 'string' || !code.trim()) throw runtimeError('E_INVALID_ARG', 'Copilot code must be a non-empty string.');
    if (code.length > MAX_CODE_BYTES) throw runtimeError('E_LIMIT', 'Copilot code exceeds the 200 KB safety limit.');
    if (!Number.isInteger(timeout) || timeout < 1 || timeout > 120000) throw runtimeError('E_INVALID_ARG', 'timeout must be 1–120000 ms.');
    // Start absolute monotonic deadline at entry BEFORE CSP fetch / scene serialization
    const nowMs = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());
    const deadlineAt = nowMs() + timeout;
    this.stop();

    const workerURL = new URL('./copilot-exec-worker.js', import.meta.url);
    const policyResponse = await fetch(workerURL.href, { credentials: 'same-origin' });
    if (nowMs() >= deadlineAt) throw runtimeError('E_TIMEOUT', `Copilot exceeded ${timeout} ms absolute deadline.`);
    if (!policyResponse.ok) {
      if (policyResponse.status === 404) {
        if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
          try { window.dispatchEvent(new CustomEvent('studio:staleBundle', { detail: { url: workerURL.href, status: 404 } })); } catch (_) {}
        }
        throw runtimeError('E_STALE_BUNDLE', 'Studio vừa cập nhật phiên bản mới trên máy chủ. Hãy tải lại trang (Reload) để dùng AI Copilot.');
      }
      throw runtimeError('E_PERMISSION', 'Copilot Worker is unavailable.');
    }
    const policy = policyResponse.headers.get('content-security-policy') || '';
    if (!WORKER_CSP_MARKERS.every((marker) => policy.includes(marker))) {
      throw runtimeError('E_PERMISSION', 'Copilot requires the isolated Worker CSP. Restart the updated server.py.');
    }

    const sm = this.sceneManager;
    const beforePayload = serializeScene(sm.rootContainer);
    if (scenePayloadSize(beforePayload) > 24 * 1024 * 1024) throw runtimeError('E_LIMIT', 'Scene snapshot exceeds 24 MB.');
    const beforeHash = payloadHash(beforePayload);
    const beforeSelection = sm.getSelectedObjects?.().map((object) => object.uuid) || [];
    const beforeSelectedObjs = sm.getSelectedObjects?.() ? [...sm.getSelectedObjects()] : [];
    const beforeCamera = cameraSnapshot(this.camera, this.engine);
    const beforeObjects = new Set(collectSceneObjects(sm.rootContainer).values());
    const assets = new Map();
    const logs = [];
    let assetSequence = 0;
    let worker;
    let timer;
    let latestAnimation = null;
    let animationReady = false;
    let transaction = null;
    let session;
    const assetAbort = new AbortController();
    const liveAbort = new AbortController();

    const context = {
      studio: this.studio,
      sceneManager: sm,
      camera: this.camera,
      engine: this.engine,
      editMode: this.editMode,
      modifiers: this.modifiers,
      simulationManager: this.simulationManager,
      sculptMode: this.sculptMode,
      stemTutor: this.stemTutor,
      setViewportMode: this.setViewportMode,
      setEditSelectionMode: this.setEditSelectionMode,
      THREE: this.THREE,
      assetSignal: assetAbort.signal,
      liveSignal: liveAbort.signal,
    };

    try {
      const response = await new Promise((resolve, reject) => {
        worker = new Worker(new URL('./copilot-exec-worker.js', import.meta.url), { type: 'module' });
        session = { worker, stopped: false, abort: assetAbort, cancel: null };
        this.activeSession = session;
        session.cancel = () => reject(runtimeError('E_CANCELLED', 'Copilot execution was stopped.'));
        const workerBudgetMs = Math.max(1, Math.round(deadlineAt - nowMs()));
        timer = setTimeout(() => {
          assetAbort.abort();
          liveAbort.abort();
          worker.terminate();
          reject(runtimeError('E_TIMEOUT', `Copilot exceeded ${timeout} ms; the live scene was not changed.`));
        }, workerBudgetMs);
        worker.onerror = (event) => reject(runtimeError('E_EXECUTION', event.message || 'Copilot Worker failed.'));
        worker.onmessage = async (event) => {
          const message = event.data;
          try {
            if (message.kind === 'log') {
              if (logs.length < 1000) logs.push(message.entry);
              onLog?.(message.entry);
            } else if (message.kind === 'animation') {
              latestAnimation = validateAnimationMessage(message, collectSceneObjects(sm.rootContainer));
            } else if (message.kind === 'assetRequest') {
              if (!ASSET_METHODS.has(message.method) || assets.size >= 32) throw runtimeError('E_PERMISSION', 'Invalid asset request.');
              const assetId = `copilot_asset_${++assetSequence}`;
              try {
                const args = message.args.map((value) => decodeCommandValue(value, new Map(), undefined, this.THREE));
                const asset = await stageAsset(message.method, args, context);
                assets.set(assetId, asset);
                worker.postMessage({ kind: 'assetResult', id: message.id, assetId, payload: asset.payload, skeletons: asset.skeletons });
              } catch (error) {
                worker.postMessage({ kind: 'assetResult', id: message.id, error: { code: error.code || 'E_ASSET', message: error.message } });
              }
            } else if (message.kind === 'error') {
              const failure = runtimeError(message.error?.code || 'E_EXECUTION', message.error?.message || 'Copilot execution failed.');
              if (typeof message.error?.stack === 'string') failure.stack = message.error.stack;
              reject(failure);
            } else if (message.kind === 'result') {
              resolve(message);
            }
          } catch (error) {
            reject(error);
          }
        };
        worker.postMessage({
          kind: 'execute',
          code,
          scene: beforePayload,
          selection: beforeSelection,
          camera: beforeCamera,
          editMode: { active: !!this.editMode?.isActive, mode: this.editMode?.mode || 'vertex', faces: this.editMode?.faces || [], edges: this.editMode?.edges || [], vertices: this.editMode?.vertices || [] },
        });
      });
      clearTimeout(timer);
      timer = null;
      session.cancel = null;
      worker.onmessage = null;
      const payload = validateScenePayload(response.payload);
      const beforeFlat = flattenPayload(beforePayload);
      const afterFlat = flattenPayload(payload);
      for (const [uuid, node] of afterFlat.nodes) {
        const previous = beforeFlat.nodes.get(uuid);
        if (previous && previous.type !== node.type) throw runtimeError('E_INVALID_RESULT', 'Worker cannot change an existing object type.');
      }
      const currentPayload = serializeScene(sm.rootContainer);
      const currentSelection = sm.getSelectedObjects?.().map((object) => object.uuid) || [];
      const currentCamera = cameraSnapshot(this.camera, this.engine);
      if (payloadHash(currentPayload) !== beforeHash || JSON.stringify(currentSelection) !== JSON.stringify(beforeSelection) || JSON.stringify(currentCamera) !== JSON.stringify(beforeCamera)) {
        throw runtimeError('E_TX_CONFLICT', 'The scene or camera changed during Copilot execution. Retry against the current scene.');
      }

      const parsedRoot = new this.THREE.ObjectLoader().parse(sceneLoaderDocument(payload));
      const activeAssetIDs = new Set((response.assets || []).map((entry) => entry.assetId));
      for (const [assetId, asset] of assets) if (!activeAssetIDs.has(assetId)) asset.payload = null;
      replaceAssetRoots(parsedRoot, assets, payload);
      const parsedObjects = collectSceneObjects(parsedRoot);
      const liveObjects = new Map(collectSceneObjects(sm.rootContainer));
      for (const [uuid, object] of parsedObjects) if (!liveObjects.has(uuid)) liveObjects.set(uuid, object);
      for (const asset of assets.values()) {
        if (!asset.adopted) continue;
        for (const [uuid, object] of collectSceneObjects(asset.root)) liveObjects.set(uuid, object);
      }

      const changedGeometry = changedResourceUUIDs(beforePayload, payload, 'geometries');
      const changedMaterial = changedResourceUUIDs(beforePayload, payload, 'materials');
      const changedTexture = changedResourceUUIDs(beforePayload, payload, 'textures');
      const changedAnimations = changedAnimationUUIDs(beforePayload, payload);
      const afterTextures = new Map((payload.scene.textures || []).map((texture) => [texture.uuid, texture]));
      const liveTextures = collectSceneTextures(sm.rootContainer);
      let commandResults = [];
      let responseValue = response.value;

      sm.beginBatch('AI Copilot Generation');
      let batchOpen = true;
      try {
        for (const uuid of changedTexture) {
          const texture = liveTextures.get(uuid);
          const json = afterTextures.get(uuid);
          if (!texture || !json) continue;
          const command = new CopilotTextureCommand(texture, captureTextureState(texture), textureStateFromJSON(json));
          command.execute();
          sm.recordExecutedCommand(command);
        }

        const removed = [...beforeFlat.nodes.keys()].filter((uuid) => uuid !== beforePayload.scene.uuid && !afterFlat.nodes.has(uuid));
        for (const uuid of removed) {
          const parentUUID = beforeFlat.parents.get(uuid);
          if (parentUUID && removed.includes(parentUUID)) continue;
          const object = liveObjects.get(uuid);
          if (!object) continue;
          const command = new CopilotRemoveObjectCommand(sm, object);
          sm.removeObject(object, false, false);
          sm.recordExecutedCommand(command);
        }

        const added = [...afterFlat.nodes.keys()].filter((uuid) => uuid !== payload.scene.uuid && !beforeFlat.nodes.has(uuid));
        for (const uuid of added) {
          const parentUUID = afterFlat.parents.get(uuid);
          if (parentUUID && !beforeFlat.nodes.has(parentUUID)) continue;
          const object = liveObjects.get(uuid);
          if (!object) continue;
          const parent = parentUUID === payload.scene.uuid ? sm.rootContainer : liveObjects.get(parentUUID);
          if (!parent) throw runtimeError('E_INVALID_RESULT', 'Added object has no valid parent.');
          detachPreexistingDescendants(object, beforeFlat.nodes);
          object.animations = parseClips(payload.animations, uuid);
          sm.addObject(object, parent, false, false);
          registerObjectTree(sm, object);
          sm.recordExecutedCommand(new CopilotAddObjectCommand(sm, object, parent));
        }

        for (const [uuid, node] of afterFlat.nodes) {
          if (uuid === payload.scene.uuid || !beforeFlat.nodes.has(uuid)) continue;
          if (removed.includes(uuid)) continue;
          const object = liveObjects.get(uuid);
          if (!object) continue;
          const beforeNode = beforeFlat.nodes.get(uuid);
          const parentUUID = afterFlat.parents.get(uuid);
          const parentChanged = beforeFlat.parents.get(uuid) !== parentUUID;
          const geometryChanged = resourceChanged(node.geometry, changedGeometry);
          const materialChanged = resourceChanged(node.material, changedMaterial);
          if (!parentChanged && nodeSignature(node) === nodeSignature(beforeNode) && !geometryChanged && !materialChanged && !changedAnimations.has(uuid)) continue;
          const newParent = parentUUID === payload.scene.uuid ? sm.rootContainer : liveObjects.get(parentUUID);
          if (!newParent) throw runtimeError('E_INVALID_RESULT', 'Modified object has no valid parent.');
          const command = new CopilotObjectCommand(
            object,
            captureDescriptor(object),
            descriptorFromJSON(object, node, payload, object, beforeNode, { forceGeometry: geometryChanged, forceMaterial: materialChanged }),
            object.parent,
            newParent,
          );
          command.execute();
          // Keep previous geometry intact for atomic transaction rollback & Undo/Redo (never use-after-dispose)
          sm.recordExecutedCommand(command);
        }

        const remainingMs = Math.round(deadlineAt - nowMs());
        if (remainingMs <= 0 || liveAbort.signal.aborted) {
          liveAbort.abort();
          throw runtimeError('E_TIMEOUT', `Copilot exceeded ${timeout} ms absolute deadline before live dispatch.`);
        }
        let liveConflict = false;
        const origExecuteCommand = typeof sm.executeCommand === 'function' ? sm.executeCommand : null;
        if (origExecuteCommand) {
          sm.executeCommand = (...args) => {
            if (context._allowLiveExecuteCommand) {
              return origExecuteCommand.apply(sm, args);
            }
            liveConflict = true;
            throw runtimeError('E_TX_CONFLICT', 'External scene mutation detected during AI transaction.');
          };
        }
        let liveTimer = null;
        let dispatched;
        try {
          const livePromise = dispatchLiveCommands(response.commands || [], context, liveObjects);
          const timeoutPromise = new Promise((_, reject) => {
            liveTimer = setTimeout(() => {
              liveAbort.abort();
              reject(runtimeError('E_TIMEOUT', `Copilot live commands exceeded ${timeout} ms absolute deadline.`));
            }, remainingMs);
          });
          dispatched = await Promise.race([livePromise, timeoutPromise]);
        } finally {
          if (liveTimer) clearTimeout(liveTimer);
          if (origExecuteCommand) sm.executeCommand = origExecuteCommand;
        }
        if (liveConflict || liveAbort.signal.aborted) {
          throw runtimeError(liveAbort.signal.aborted ? 'E_TIMEOUT' : 'E_TX_CONFLICT', 'Transaction conflicted or timed out during Copilot live commands; rolled back cleanly.');
        }
        commandResults = dispatched.results;
        responseValue = rewritePendingTokens(response.value, dispatched.pendingModifiers);
        var liveMutatedSelection = Boolean(dispatched.mutatedSelection);
        transaction = sm.endBatch();
        batchOpen = false;
      } catch (error) {
        if (batchOpen) {
          const batch = sm._batchStack?.pop();
          const commands = batch?.commands || [];
          if (commands.length) {
            const rollback = commands.length === 1 ? commands[0] : new CompositeCommand(commands, 'AI Copilot Generation');
            rollback.undo();
          }
          // Restore user selection & camera cleanly when transaction rolls back (unless user caused conflict)
          if (error?.code !== 'E_TX_CONFLICT') {
            try { sm.setSelection?.(beforeSelectedObjs.filter((o) => o && o.parent)); } catch (_) {}
            try {
              if (this.camera && beforeCamera?.position) {
                this.camera.position.fromArray(beforeCamera.position);
                if (this.engine?.controls?.target && beforeCamera.target) {
                  this.engine.controls.target.fromArray(beforeCamera.target);
                  this.engine.controls.update?.();
                }
                this.camera.updateMatrixWorld?.(true);
              }
            } catch (_) {}
          }
        }
        throw error;
      }

      if (!liveMutatedSelection) {
        const nextSelection = response.selection
          .map((uuid) => liveObjects.get(uuid))
          .filter((obj) => obj && isAttachedToSceneRoot(obj, sm.rootContainer));
        sm.setSelection?.(nextSelection);
      }
      sanitizeSelectionAndTransformControls(sm, this.engine);
      this.engine?.markShadowDirty?.();
      this.engine?.requestRender?.();
      const newObjects = Array.from(collectSceneObjects(sm.rootContainer).values()).filter((object) => !beforeObjects.has(object) && object !== sm.rootContainer && !object.userData?.isSystemObject && !object.userData?.isHelper);
      const hasAnimations = !!response.hasAnimations && !response.stopAnimations;
      if (hasAnimations) {
        worker.onmessage = (event) => {
          if (session.stopped || event.data?.kind !== 'animation') return;
          try {
            const updates = validateAnimationMessage(event.data, collectSceneObjects(sm.rootContainer));
            if (!animationReady) { latestAnimation = updates; return; }
            for (const node of updates) {
              const object = sm.rootContainer.getObjectByProperty('uuid', node.uuid);
              if (!object) continue;
              object.position.fromArray(node.position);
              object.quaternion.fromArray(node.quaternion);
              object.scale.fromArray(node.scale);
              object.visible = node.visible;
            }
            sm.requestRender?.();
          } catch (error) {
            console.error('[Copilot Runtime] Invalid animation frame:', error);
            this.stop();
          }
        };
        this.activeSession = session;
      } else {
        worker.terminate();
        if (this.activeSession === session) this.activeSession = null;
      }

      const api = {
        value: responseValue,
        logs,
        newObjects,
        commandResults,
        hasAnimations,
        resume() {
          animationReady = true;
          if (latestAnimation && !session.stopped) worker.onmessage?.({ data: { kind: 'animation', nodes: latestAnimation } });
          latestAnimation = null;
        },
        stop: () => { if (this.activeSession === session) this.stop(); },
      };
      for (const [assetId, asset] of assets) {
        if (asset.adopted) assets.delete(assetId);
        else {
          asset.root.traverse((object) => {
            object.geometry?.dispose?.();
            if (Array.isArray(object.material)) object.material.forEach((material) => material.dispose?.());
            else object.material?.dispose?.();
          });
        }
      }
      return api;
    } catch (error) {
      if (transaction) {
        const index = sm.undoStack?.indexOf(transaction) ?? -1;
        if (index >= 0) sm.undoStack.splice(index, 1);
        transaction.undo();
        if (error?.code !== 'E_TX_CONFLICT') {
          sm.setSelection?.(beforeSelection.map((uuid) => sm.rootContainer.getObjectByProperty('uuid', uuid)).filter(Boolean));
        }
      }
      clearTimeout(timer);
      assetAbort.abort();
      worker?.terminate();
      if (this.activeSession?.worker === worker) this.activeSession = null;
      for (const asset of assets.values()) {
        asset.root.traverse((object) => {
          object.geometry?.dispose?.();
          if (Array.isArray(object.material)) object.material.forEach((material) => material.dispose?.());
          else object.material?.dispose?.();
        });
      }
      throw error;
    }
  }
}

export const __copilotRuntimeInternals = {
  flattenPayload,
  nodeSignature,
  dataSize,
  CopilotObjectCommand,
  captureDescriptor,
  validAssetURL,
  validateAnimationMessage,
  decodeCommandValue,
  resolveLiveCommand,
  resolveLiveCommandTargets,
  LIVE_COMMAND_META,
  dispatchLiveCommands,
  isAttachedToSceneRoot,
  sanitizeSelectionAndTransformControls,
};
