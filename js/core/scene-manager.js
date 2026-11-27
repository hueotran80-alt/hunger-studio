/**
 * @file scene-manager.js
 * @description Manages 3D scene objects, hierarchy, selection state, and undo/redo history for Web Blender Studio.
 */

import * as THREE from 'three';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import { dataBlockRegistry } from './data-blocks.js';
import { CollectionManager } from './collection-manager.js';
import { textureLeaseRegistry } from '../render/texture-lease-registry.js';

/**
 * Base Command interface for Undo/Redo operations
 */
export class Command {
  constructor(description = 'Action') {
    this.description = description;
  }
  execute() {}
  undo() {}
}

/**
 * Command for Object Transformations (Translate, Rotate, Scale)
 */
export class TransformCommand extends Command {
  /**
   * @param {THREE.Object3D} object 
   * @param {Object} oldState { position: Vector3, rotation: Euler/Quaternion, scale: Vector3 }
   * @param {Object} newState { position: Vector3, rotation: Euler/Quaternion, scale: Vector3 }
   * @param {Function} [onUpdate] Callback after transform is restored
   */
  constructor(object, oldState, newState, onUpdate = null) {
    super(`Transform ${object.name || 'Object'}`);
    // nhận diện không dùng instanceof: module có thể bị nạp 2 bản qua query cache-bust
    this.isTransform = true;
    this.object = object;
    this.oldState = {
      position: oldState.position.clone(),
      quaternion: (oldState.quaternion || oldState.rotation).clone(),
      scale: oldState.scale.clone()
    };
    this.newState = {
      position: newState.position.clone(),
      quaternion: (newState.quaternion || newState.rotation).clone(),
      scale: newState.scale.clone()
    };
    this.onUpdate = onUpdate;
  }

  execute() {
    this.applyState(this.newState);
  }

  undo() {
    this.applyState(this.oldState);
  }

  applyState(state) {
    this.object.position.copy(state.position);
    if (state.quaternion) {
      this.object.quaternion.copy(state.quaternion);
    }
    this.object.scale.copy(state.scale);
    this.object.updateMatrixWorld(true);
    if (this.onUpdate) this.onUpdate(this.object);
  }
}

/**
 * Atomic Undo/Redo command for Multi-Object Transformations.
 */
export class MultiTransformCommand extends Command {
  constructor(entries = [], onUpdate = null, description = null) {
    const valid = (entries || []).filter((e) => e?.object && e.oldState && e.newState);
    super(description || `Transform ${valid.length} Object(s)`);
    this.isTransform = true;
    this.object = valid[0]?.object || null;
    this.objects = valid.map((e) => e.object);
    this.entries = valid.map((e) => ({
      object: e.object,
      oldState: {
        position: e.oldState.position.clone(),
        quaternion: (e.oldState.quaternion || e.oldState.rotation).clone(),
        scale: e.oldState.scale.clone()
      },
      newState: {
        position: e.newState.position.clone(),
        quaternion: (e.newState.quaternion || e.newState.rotation).clone(),
        scale: e.newState.scale.clone()
      }
    }));
    this.onUpdate = onUpdate;
  }

  execute() {
    this._apply('newState');
  }

  undo() {
    this._apply('oldState');
  }

  _apply(which) {
    for (const entry of this.entries) {
      const state = entry[which];
      entry.object.position.copy(state.position);
      if (state.quaternion) entry.object.quaternion.copy(state.quaternion);
      entry.object.scale.copy(state.scale);
      entry.object.updateMatrixWorld(true);
    }
    if (this.onUpdate) this.onUpdate(this.objects);
  }
}

/**
 * Command for Adding an Object
 */
export class AddObjectCommand extends Command {
  constructor(sceneManager, object, parent = null) {
    super(`Add ${object.name || 'Object'}`);
    this.sceneManager = sceneManager;
    this.object = object;
    this.parent = parent;
  }

  execute() {
    this.sceneManager.addObject(this.object, this.parent, false, false);
  }

  undo() {
    this.sceneManager.removeObject(this.object, false, false);
  }
}

/**
 * Command for Removing an Object
 */
export class RemoveObjectCommand extends Command {
  constructor(sceneManager, object) {
    super(`Delete ${object.name || 'Object'}`);
    this.sceneManager = sceneManager;
    this.object = object;
    this.parent = object.parent;
    this.childIndex = this.parent ? this.parent.children.indexOf(object) : -1;
    // Xoá object huỷ keyframe/bone track/clip của cả cây con; chụp lại trước
    // khi xoá để Ctrl+Z trả về đúng hoạt cảnh đang có.
    this.timelineTracks = typeof sceneManager.captureTimelineTracks === 'function'
      ? sceneManager.captureTimelineTracks(object)
      : [];
  }

  execute() {
    this.sceneManager.removeObject(this.object, false, false);
  }

  undo() {
    this.sceneManager.addObject(this.object, this.parent, false, false);
    if (this.parent && this.childIndex >= 0 && this.parent.children.length > 1) {
      // Restore position in children array if necessary
      const currIdx = this.parent.children.indexOf(this.object);
      if (currIdx !== -1 && currIdx !== this.childIndex) {
        this.parent.children.splice(currIdx, 1);
        this.parent.children.splice(this.childIndex, 0, this.object);
      }
    }
    if (this.timelineTracks.length) {
      this.sceneManager.restoreTimelineTracks(this.object, this.timelineTracks);
    }
  }
}

/**
 * Command for removing multiple objects as a single undo step without disposing GPU/CPU resources.
 */
export class RemoveObjectsCommand extends Command {
  constructor(sceneManager, objects = [], description = null) {
    const list = (objects || []).filter(Boolean);
    super(description || (list.length === 1 ? `Delete ${list[0].name || 'Object'}` : `Delete ${list.length} objects`));
    this.sceneManager = sceneManager;
    this.entries = list.map((object) => ({
      object,
      parent: object.parent,
      childIndex: object.parent ? object.parent.children.indexOf(object) : -1,
      timelineTracks: typeof sceneManager.captureTimelineTracks === 'function'
        ? sceneManager.captureTimelineTracks(object)
        : []
    }));
  }

  execute() {
    for (const { object } of this.entries) {
      this.sceneManager.removeObject(object, false, false);
    }
  }

  undo() {
    for (let i = this.entries.length - 1; i >= 0; i -= 1) {
      const { object, parent, childIndex, timelineTracks } = this.entries[i];
      this.sceneManager.addObject(object, parent, false, false);
      if (parent && childIndex >= 0 && parent.children.length > 1) {
        const currIdx = parent.children.indexOf(object);
        if (currIdx !== -1 && currIdx !== childIndex) {
          parent.children.splice(currIdx, 1);
          parent.children.splice(Math.min(childIndex, parent.children.length), 0, object);
        }
      }
      if (timelineTracks?.length) {
        this.sceneManager.restoreTimelineTracks(object, timelineTracks);
      }
    }
  }
}

/**
 * Command for removing several objects as one undo step (duplicate selection).
 */
export class AddObjectsCommand extends Command {
  constructor(sceneManager, entries, description = 'Duplicate objects') {
    super(description);
    this.sceneManager = sceneManager;
    this.entries = entries.map(({ object, parent }) => ({ object, parent }));
  }

  execute() {
    this.entries.forEach(({ object, parent }) => {
      this.sceneManager.addObject(object, parent, false, false);
    });
  }

  undo() {
    [...this.entries].reverse().forEach(({ object }) => {
      this.sceneManager.removeObject(object, false, false);
    });
  }
}

export class CompositeCommand extends Command {
  constructor(commands = [], description = 'Batch action') {
    super(description);
    this.commands = (commands || []).filter(Boolean);
    this.bytes = this.commands.reduce((sum, c) => sum + (Number(c?.bytes) || 0), 0);
  }

  execute() {
    for (const cmd of this.commands) {
      if (typeof cmd.execute === 'function') cmd.execute();
    }
  }

  undo() {
    for (let i = this.commands.length - 1; i >= 0; i -= 1) {
      const cmd = this.commands[i];
      if (typeof cmd.undo === 'function') cmd.undo();
    }
  }
}

/**
 * Group selected objects. Undo restores each child to its original parent
 * instead of removing the group together with its children.
 */
export class GroupObjectsCommand extends Command {
  constructor(sceneManager, group, objects, originalParents) {
    super(`Group ${objects.length} objects`);
    this.sceneManager = sceneManager;
    this.group = group;
    this.objects = [...objects];
    this.originalParents = new Map(originalParents);
  }

  execute() {
    if (!this.sceneManager.objects.has(this.group.userData.id)) {
      this.sceneManager.addObject(this.group, this.group.parent || this.sceneManager.rootContainer, false, false);
    }
    this.objects.forEach((object) => this.group.attach(object));
    this.sceneManager.select(this.group, false);
  }

  undo() {
    this.objects.forEach((object) => {
      const parent = this.originalParents.get(object) || this.sceneManager.rootContainer;
      parent.attach(object);
    });
    this.sceneManager.removeObject(this.group, false, false);
    this.sceneManager.setSelection(this.objects);
  }
}

/**
 * Ungroup one group. Undo re-creates the group and moves the exact children
 * back into it, preserving world transforms.
 */
export class UngroupCommand extends Command {
  constructor(sceneManager, group, parent, children) {
    super(`Ungroup ${group.name || 'Group'}`);
    this.sceneManager = sceneManager;
    this.group = group;
    this.parent = parent || sceneManager.rootContainer;
    this.children = [...children];
  }

  execute() {
    this.children.forEach((child) => {
      this.parent.attach(child);
      this.sceneManager.objects.set(child.userData.id, child);
    });
    this.sceneManager.removeObject(this.group, false, false);
    this.sceneManager.setSelection(this.children);
  }

  undo() {
    this.sceneManager.addObject(this.group, this.parent, false, false);
    this.children.forEach((child) => this.group.attach(child));
    this.sceneManager.select(this.group, false);
  }
}

/**
 * Command for Changing Object Properties
 */
export class PropertyChangeCommand extends Command {
  constructor(object, propertyPath, oldValue, newValue, onUpdate = null) {
    super(`Change ${propertyPath} of ${object.name || 'Object'}`);
    this.object = object;
    this.propertyPath = propertyPath;
    this.oldValue = oldValue;
    this.newValue = newValue;
    this.onUpdate = onUpdate;
  }

  execute() {
    this.setValue(this.newValue);
  }

  undo() {
    this.setValue(this.oldValue);
  }

  setValue(val) {
    const parts = this.propertyPath.split('.');
    let target = this.object;
    for (let i = 0; i < parts.length - 1; i++) {
      target = target[parts[i]];
    }
    const prop = parts[parts.length - 1];
    if (target[prop] && typeof target[prop].copy === 'function' && typeof val === 'object') {
      target[prop].copy(val);
    } else {
      target[prop] = val;
    }
    if (this.onUpdate) this.onUpdate(this.object, this.propertyPath, val);
  }
}

/**
 * Simple Event Emitter
 */
class EventEmitter {
  constructor() {
    this._listeners = new Map();
  }

  on(event, handler) {
    if (!this._listeners.has(event)) {
      this._listeners.set(event, new Set());
    }
    this._listeners.get(event).add(handler);
    return () => this.off(event, handler);
  }

  off(event, handler) {
    if (this._listeners.has(event)) {
      this._listeners.get(event).delete(handler);
    }
  }

  emit(event, data) {
    if (this._listeners.has(event)) {
      this._listeners.get(event).forEach(handler => {
        try {
          handler(data);
        } catch (err) {
          console.error(`Error in event listener for "${event}":`, err);
        }
      });
    }
  }
}

/**
 * SceneManager
 * Manages all 3D scene objects, hierarchical tracking, active selection, and history.
 */
export class SceneManager extends EventEmitter {
  /**
   * @param {THREE.Scene} threeScene Reference to Three.js scene
   */
  constructor(threeScene) {
    super();
    this.scene = threeScene;

    // Registry of user objects (excluding internal helpers, lights, grids)
    this.objects = new Map(); // id -> THREE.Object3D
    this.nameCounters = new Map(); // base name -> count

    // Selection state
    this.selectedObjects = new Set();
    this.activeObject = null; // Primary active object (Blender style active selection)

    // History stack
    this.undoStack = [];
    this.redoStack = [];
    this.maxHistory = 50;
    this.revision = 0;
    this._batchStack = [];

    // Nested Collections & View Layers
    this.collectionManager = new CollectionManager(this);

    // Default object container in scene if desired
    this.rootContainer = new THREE.Group();
    this.rootContainer.name = 'Scene_Collection';
    this.rootContainer.userData.isSystemObject = true;
    this.scene.add(this.rootContainer);
  }

  /**
   * Generates a unique, Blender-style name (e.g. Cube, Cube.001, Cube.002)
   * @param {string} baseName 
   * @returns {string}
   */
  generateUniqueName(baseName = 'Object') {
    // Strip existing suffix like .001
    const cleanName = baseName.replace(/\.\d{3}$/, '');
    
    // Check if cleanName exists
    let existingNames = new Set();
    this.objects.forEach(obj => existingNames.add(obj.name));

    if (!existingNames.has(cleanName)) {
      return cleanName;
    }

    let counter = 1;
    while (true) {
      const suffix = String(counter).padStart(3, '0');
      const candidate = `${cleanName}.${suffix}`;
      if (!existingNames.has(candidate)) {
        return candidate;
      }
      counter++;
    }
  }

  /**
   * Adds an object to the scene
   * @param {THREE.Object3D} object 
   * @param {THREE.Object3D} [parent]
   * @param {boolean} [selectAfter=true]
   * @param {boolean} [recordHistory=true]
   * @returns {THREE.Object3D}
   */
  addObject(object, parent = null, selectAfter = true, recordHistory = true) {
    if (!object) return null;

    // Ensure unique ID & name
    if (!object.userData.id) {
      object.userData.id = THREE.MathUtils.generateUUID();
    }
    if (!object.name || object.name === '') {
      object.name = this.generateUniqueName('Object');
    } else {
      object.name = this.generateUniqueName(object.name);
    }

    // Default selectable and editable flags
    object.userData.selectable = object.userData.selectable !== false;
    object.userData.visible = object.visible !== false;
    object.userData.locked = object.userData.locked || false;

    // Parent resolution
    const targetParent = parent || this.rootContainer;
    targetParent.add(object);

    // Register in map (incremental O(subtree) instead of O(N²) full scene scan)
    this.objects.set(object.userData.id, object);
    if (typeof dataBlockRegistry.registerObject === 'function') {
      dataBlockRegistry.registerObject(object);
    } else {
      dataBlockRegistry.syncFromScene(this.rootContainer);
    }
    this.revision += 1;

    // Record history
    if (recordHistory) {
      this.executeCommand(new AddObjectCommand(this, object, targetParent));
    }

    this.collectionManager?.ensureObjectTracked(object);
    this.emit('objectAdded', { object, parent: targetParent });

    if (selectAfter && object.userData.selectable) {
      this.select(object, false);
    }

    return object;
  }

  /**
   * Timeline đang dùng: bản trong trình duyệt hoặc bản được tiêm vào
   * (test headless, engine không có window.timelineEngine).
   */
  _timelineEngine() {
    if (typeof window !== 'undefined' && window.timelineEngine) return window.timelineEngine;
    return this.timelineEngine || this.engine?.timelineEngine || null;
  }

  /**
   * Chụp keyframe + bone track + clip của một cây object để undo khôi phục.
   * @param {THREE.Object3D} object
   * @returns {Array}
   */
  captureTimelineTracks(object) {
    const timeline = this._timelineEngine();
    if (!object || !timeline || typeof timeline.captureTracks !== 'function') return [];
    try {
      return timeline.captureTracks(object);
    } catch (err) {
      console.warn('[SceneManager] Could not capture timeline for undo:', err);
      return [];
    }
  }

  /**
   * Restore captured snapshot from captureTimelineTracks() after object is re-added.
   * @param {THREE.Object3D} object
   * @param {Array} entries
   * @returns {number}
   */
  restoreTimelineTracks(object, entries) {
    const timeline = this._timelineEngine();
    if (!object || !timeline || typeof timeline.restoreCapturedTracks !== 'function') return 0;
    try {
      return timeline.restoreCapturedTracks(entries, object);
    } catch (err) {
      console.warn('[SceneManager] Could not restore timeline after undo:', err);
      return 0;
    }
  }

  /**
   * Removes an object from the scene
   * @param {THREE.Object3D|string} objectOrId 
   * @param {boolean} [recordHistory=true]
   * @param {boolean} [disposeResources=false]
   * @returns {boolean}
   */
  removeObject(objectOrId, recordHistory = true, disposeResources = false) {
    const object = this.resolveObject(objectOrId);
    if (!object) return false;

    // Cannot remove system root
    if (object.userData.isSystemObject) return false;

    // Ignore already-removed objects so repeated removeObject calls cannot push duplicate history
    const isTracked = object.userData?.id !== undefined && this.objects.has(object.userData.id);
    if (!object.parent && !isTracked) return false;

    // If currently selected, deselect first
    if (this.selectedObjects.has(object)) {
      this.deselect(object);
    }

    // Record history before detachment
    if (recordHistory) {
      this.executeCommand(new RemoveObjectCommand(this, object));
    }

    // Detach from parent
    if (object.parent) {
      object.parent.remove(object);
    }

    // Unregister object & clean up collection membership UUIDs
    this.objects.delete(object.userData.id);
    if (this.collectionManager?.removeObjectUuid) {
      if (typeof object.traverse === 'function') {
        object.traverse((n) => this.collectionManager.removeObjectUuid(n.uuid));
      } else {
        this.collectionManager.removeObjectUuid(object.uuid);
      }
    }

    // If permanently destroying resources
    if (disposeResources) {
      this.deepDisposeObject(object);
    } else {
      // Detach TransformControls if attached to object being removed
      const engine = (typeof window !== 'undefined' ? window.engine : null) || this.engine;
      if (engine && engine.transformControls && engine.transformControls.object === object) {
        engine.transformControls.detach();
      }
    }

    // Clean up timeline tracks — cả keyframe của con trong group, không chỉ object gốc.
    const timeline = this._timelineEngine();
    if (timeline) {
      if (typeof timeline.clearTracksUnder === 'function') {
        timeline.clearTracksUnder(object);
      } else if (typeof timeline.clearObjectKeyframes === 'function') {
        timeline.clearObjectKeyframes(object);
      }
    }

    this.emit('objectRemoved', { object });
    this.revision += 1;
    return true;
  }

  /**
   * Duplicates an object (Blender Shift+D style)
   * Deep clones geometry, material and transforms
   * @param {THREE.Object3D|string} objectOrId 
   * @param {THREE.Vector3|{x:number, y:number, z:number}} [offset={x:1, y:0, z:1}]
   * @returns {THREE.Object3D}
   */
  duplicateObject(objectOrId, offset = { x: 1, y: 0, z: 1 }) {
    const source = this.resolveObject(objectOrId);
    if (!source) return null;
    const [clone] = this.duplicateObjects([source], offset);
    return clone || null;
  }

  /**
   * Duplicates every given object (excluding descendants of another selected
   * object) as a single undo step and selects the clones.
   */
  duplicateObjects(objects = [], offset = { x: 1, y: 0, z: 1 }) {
    const selected = new Set((objects || []).map((object) => this.resolveObject(object)).filter(Boolean));
    const sources = [...selected].filter((object) => {
      let parent = object.parent;
      while (parent) {
        if (selected.has(parent)) return false;
        parent = parent.parent;
      }
      return true;
    });
    if (sources.length === 0) return [];

    const entries = sources.map((source) => ({
      parent: source.parent || this.rootContainer,
      object: this._cloneForDuplicate(source, offset)
    }));

    // Map every copied hierarchy before remapping joints across selected roots.
    const clonedUuids = new Map();
    sources.forEach((source, index) => {
      const originalUuids = [];
      source.traverse((child) => originalUuids.push(child.uuid));
      let childIndex = 0;
      entries[index].object.traverse((child) => {
        clonedUuids.set(originalUuids[childIndex++], child.uuid);
      });
    });
    entries.forEach(({ object }) => {
      object.traverse((child) => {
        if (!Array.isArray(child.userData.joints)) return;
        // A duplicate must never keep a joint attached to an original object.
        child.userData.joints = child.userData.joints
          .filter((joint) => clonedUuids.has(joint?.targetUuid))
          .map((joint) => ({ ...joint, targetUuid: clonedUuids.get(joint.targetUuid) }));
      });
    });

    entries.forEach(({ object, parent }) => {
      this.addObject(object, parent, false, false);
    });
    this.executeCommand(new AddObjectsCommand(this, entries));
    this.setSelection(entries.map((entry) => entry.object));
    return entries.map((entry) => entry.object);
  }

  _cloneForDuplicate(source, offset = { x: 1, y: 0, z: 1 }) {
    // Object3D.clone() keeps SkinnedMesh bound to the ORIGINAL bones, so a
    // duplicated character would pose along with its source. SkeletonUtils
    // rebuilds an independent skeleton for skinned hierarchies.
    let hasSkin = !!source.isSkinnedMesh;
    const baseGeomMap = new Map();
    if (typeof source.traverse === 'function') {
      source.traverse(child => {
        if (child.isSkinnedMesh) hasSkin = true;
        if (child.userData?.baseGeometry) {
          baseGeomMap.set(child, child.userData.baseGeometry);
        }
      });
    }
    const clone = hasSkin ? cloneSkinned(source) : source.clone(true);

    // Map source nodes to clone nodes to restore uncorrupted baseGeometry clones
    // (Three.js Object3D.copy uses JSON.stringify which ruins BufferGeometry instances)
    const sourceNodes = [];
    const cloneNodes = [];
    if (typeof source.traverse === 'function') {
      source.traverse(c => sourceNodes.push(c));
      clone.traverse(c => cloneNodes.push(c));
    }
    for (let i = 0; i < sourceNodes.length; i++) {
      const sNode = sourceNodes[i];
      const cNode = cloneNodes[i];
      if (sNode && cNode && baseGeomMap.has(sNode)) {
        const origBg = baseGeomMap.get(sNode);
        cNode.userData.baseGeometry = typeof origBg.clone === 'function' ? origBg.clone() : origBg;
      }
    }

    // Ensure cloned materials and geometries are independent if requested
    clone.traverse(child => {
      child.userData = { ...child.userData };
      delete child.userData.id; // Generate fresh id
      // Modifier state phải độc lập giữa bản gốc và bản sao (Phase 1).
      if (Array.isArray(child.userData.modifierStack)) {
        child.userData.modifierStack = child.userData.modifierStack.map((d) => ({ ...d, params: { ...(d.params || {}) } }));
      }
      child.userData.stackRevision = 0;
      if (child.isMesh) {
        if (child.geometry) child.geometry = child.geometry.clone();
        if (Array.isArray(child.material)) {
          child.material = child.material.map(m => m.clone());
        } else if (child.material) {
          child.material = child.material.clone();
        }
      }
    });

    // Apply offset
    if (Array.isArray(offset)) {
      clone.position.x += offset[0] || 0;
      clone.position.y += offset[1] || 0;
      clone.position.z += offset[2] || 0;
    } else if (offset) {
      clone.position.x += (offset.x || 0);
      clone.position.y += (offset.y || 0);
      clone.position.z += (offset.z || 0);
    }

    clone.name = this.generateUniqueName(source.name);
    return clone;
  }

  /**
   * Creates and assigns a new PBR material to a mesh (or every mesh under a group).
   * @param {THREE.Object3D|string} objectOrId
   * @param {Object} [options]
   * @param {string|number} [options.color='#a0a0a0']
   * @param {number} [options.roughness=0.5]
   * @param {number} [options.metalness=0.0]
   * @param {string} [options.name]
   * @returns {THREE.Material|THREE.Material[]|null}
   */
  createMaterialForObject(objectOrId, options = {}) {
    const object = this.resolveObject(objectOrId);
    if (!object) return null;

    const meshes = [];
    if (object.isMesh) meshes.push(object);
    if (typeof object.traverse === 'function') {
      object.traverse((child) => {
        if (child !== object && child.isMesh) meshes.push(child);
      });
    }
    if (meshes.length === 0) return null;

    const makeMaterial = (slotIdx) => new THREE.MeshStandardMaterial({
      name: options.name || `${object.name || 'Object'} Material${slotIdx > 0 ? `.${String(slotIdx).padStart(3, '0')}` : ''}`,
      color: new THREE.Color(options.color ?? '#a0a0a0'),
      roughness: options.roughness ?? 0.5,
      metalness: options.metalness ?? 0.0
    });

    const oldMaterials = [];
    const newMaterials = [];
    let firstMaterial = null;

    for (const mesh of meshes) {
      oldMaterials.push(mesh.material);
      if (Array.isArray(mesh.material)) {
        const created = mesh.material.map((_, i) => makeMaterial(i));
        newMaterials.push(created);
        mesh.material = created;
        if (!firstMaterial) firstMaterial = created[0] || null;
      } else {
        const created = makeMaterial(0);
        newMaterials.push(created);
        mesh.material = created;
        if (!firstMaterial) firstMaterial = created;
      }
    }

    this.executeCommand({
      description: 'New Material',
      execute: () => meshes.forEach((mesh, i) => { mesh.material = newMaterials[i]; }),
      undo: () => meshes.forEach((mesh, i) => { mesh.material = oldMaterials[i]; })
    });

    this.requestRender();
    this.emit('materialChanged', { object, material: firstMaterial });
    return firstMaterial;
  }

  /**
   * Requests a redraw of the viewport.
   */
  requestRender() {
    this.emit('renderRequested');
    if (typeof window !== 'undefined' && window.engine) {
      if (typeof window.engine.requestRender === 'function') {
        window.engine.requestRender();
      } else if (typeof window.engine.renderOnce === 'function') {
        window.engine.renderOnce();
      }
    }
  }

  /**
   * Groups selected objects under a new THREE.Group
   * Preserves world transforms of all grouped objects
   * @param {THREE.Object3D[]} objects 
   * @param {string} [groupName='Group']
   * @returns {THREE.Group}
   */
  groupObjects(objects = null, groupName = 'Group') {
    const rawTargets = (objects && objects.length > 0)
      ? objects.map(o => this.resolveObject(o)).filter(Boolean)
      : Array.from(this.selectedObjects);

    // Filter out descendants whose ancestor is already selected so grouping preserves hierarchy
    const selectedSet = new Set(rawTargets);
    const targetObjects = rawTargets.filter((obj) => {
      let parent = obj.parent;
      while (parent) {
        if (selectedSet.has(parent)) return false;
        parent = parent.parent;
      }
      return true;
    });

    if (targetObjects.length < 2) return null;

    const group = new THREE.Group();
    group.name = this.generateUniqueName(groupName);

    // Calculate center bounding center of all objects to position group pivot
    const box = new THREE.Box3();
    targetObjects.forEach(obj => {
      box.expandByObject(obj);
    });
    const center = new THREE.Vector3();
    box.getCenter(center);
    group.position.copy(center);

    const originalParents = new Map(targetObjects.map((obj) => [obj, obj.parent || this.rootContainer]));

    // Add group to scene root first (without its own history entry; the
    // GroupObjectsCommand below is the single undo step for the whole action).
    this.addObject(group, this.rootContainer, false, false);

    // Attach children while preserving world transformation
    targetObjects.forEach(obj => {
      group.attach(obj);
    });

    this.select(group, false);
    this.executeCommand(new GroupObjectsCommand(this, group, targetObjects, originalParents));
    this.emit('objectsGrouped', { group, children: targetObjects });
    return group;
  }

  /**
   * Ungroups a group object, restoring its children to the group's parent
   * @param {THREE.Group|string} groupOrId 
   * @returns {THREE.Object3D[]}
   */
  ungroup(groupOrId) {
    const group = this.resolveObject(groupOrId);
    if (!group || !(group instanceof THREE.Group)) return [];

    const parent = group.parent || this.rootContainer;
    const children = [...group.children];

    children.forEach(child => {
      parent.attach(child);
      this.objects.set(child.userData.id, child);
    });

    this.removeObject(group, false, false);
    this.setSelection(children);
    this.executeCommand(new UngroupCommand(this, group, parent, children));
    this.emit('objectsUngrouped', { children });
    return children;
  }

  /**
   * Renames an object
   * @param {THREE.Object3D|string} objectOrId 
   * @param {string} newName 
   * @returns {boolean}
   */
  renameObject(objectOrId, newName) {
    const object = this.resolveObject(objectOrId);
    const trimmed = typeof newName === 'string' ? newName.trim() : '';
    if (!object || !trimmed || object.name === trimmed) return false;

    const oldName = object.name;
    const uniqueName = this.generateUniqueName(trimmed);
    
    this.executeCommand(new PropertyChangeCommand(
      object, 
      'name', 
      oldName, 
      uniqueName, 
      (obj, prop, val) => this.emit('objectRenamed', { object: obj, oldName, newName: val })
    ));

    object.name = uniqueName;
    this.emit('objectRenamed', { object, oldName, newName: uniqueName });
    return true;
  }

  /**
   * Sets object visibility
   * @param {THREE.Object3D|string} objectOrId 
   * @param {boolean} visible 
   */
  setVisibility(objectOrId, visible) {
    const object = this.resolveObject(objectOrId);
    if (!object) return;

    const oldVal = object.visible;
    if (oldVal === visible) return;

    this.executeCommand(new PropertyChangeCommand(
      object,
      'visible',
      oldVal,
      visible,
      (obj, prop, val) => {
        obj.visible = val;
        obj.userData.visible = val;
        this.emit('visibilityChanged', { object: obj, visible: val });
      }
    ));

    object.visible = visible;
    object.userData.visible = visible;
    this.emit('visibilityChanged', { object, visible });
  }

  /**
   * Sets object lock state (cannot be transformed or picked)
   * @param {THREE.Object3D|string} objectOrId 
   * @param {boolean} locked 
   */
  setLocked(objectOrId, locked) {
    const object = this.resolveObject(objectOrId);
    if (!object) return;
    object.userData.locked = !!locked;
    this.emit('lockChanged', { object, locked: object.userData.locked });
  }

  // ==========================================
  // SELECTION SYSTEM
  // ==========================================

  /**
   * Selects an object
   * @param {THREE.Object3D|string} objectOrId 
   * @param {boolean} [multiSelect=false]
   */
  select(objectOrId, multiSelect = false) {
    const object = this.resolveObject(objectOrId);
    if (!object) return;

    if (object.userData.locked || object.userData.selectable === false) return;

    if (!multiSelect) {
      this.selectedObjects.clear();
    }

    this.selectedObjects.add(object);
    this.activeObject = object;

    this.emit('selectionChanged', {
      selected: Array.from(this.selectedObjects),
      active: this.activeObject
    });
  }

  /**
   * Deselects an object
   * @param {THREE.Object3D|string} objectOrId 
   */
  deselect(objectOrId) {
    const object = this.resolveObject(objectOrId);
    if (!object) return;

    this.selectedObjects.delete(object);
    if (this.activeObject === object) {
      this.activeObject = this.selectedObjects.size > 0 
        ? Array.from(this.selectedObjects)[this.selectedObjects.size - 1] 
        : null;
    }

    this.emit('selectionChanged', {
      selected: Array.from(this.selectedObjects),
      active: this.activeObject
    });
  }

  /**
   * Clears selection
   */
  clearSelection() {
    if (this.selectedObjects.size === 0 && !this.activeObject) return;

    this.selectedObjects.clear();
    this.activeObject = null;

    this.emit('selectionChanged', {
      selected: [],
      active: null
    });
  }

  /**
   * Sets the selection to an array of objects
   * @param {THREE.Object3D[]} objects 
   */
  setSelection(objects) {
    this.selectedObjects.clear();
    objects.forEach(obj => {
      const resolved = this.resolveObject(obj);
      if (resolved && !resolved.userData.locked && resolved.userData.selectable !== false) {
        this.selectedObjects.add(resolved);
      }
    });

    this.activeObject = this.selectedObjects.size > 0 
      ? Array.from(this.selectedObjects)[this.selectedObjects.size - 1] 
      : null;

    this.emit('selectionChanged', {
      selected: Array.from(this.selectedObjects),
      active: this.activeObject
    });
  }

  /**
   * Gets list of currently selected objects
   * @returns {THREE.Object3D[]}
   */
  getSelectedObjects() {
    return Array.from(this.selectedObjects);
  }

  /**
   * Gets primary active object
   * @returns {THREE.Object3D|null}
   */
  getActiveObject() {
    if (this.activeObject && !this.activeObject.parent) {
      this.activeObject = null;
    }
    return this.activeObject;
  }

  /**
   * Checks if an object is selected
   * @param {THREE.Object3D|string} objectOrId 
   * @returns {boolean}
   */
  isSelected(objectOrId) {
    const obj = this.resolveObject(objectOrId);
    return obj ? this.selectedObjects.has(obj) : false;
  }

  // ==========================================
  // UNDO / REDO HISTORY (COMMAND PATTERN)
  // ==========================================

  beginBatch(description = 'Batch action') {
    if (!Array.isArray(this._batchStack)) this._batchStack = [];
    const batch = { description, commands: [] };
    this._batchStack.push(batch);
    return batch;
  }

  endBatch() {
    if (!Array.isArray(this._batchStack) || this._batchStack.length === 0) return null;
    const batch = this._batchStack.pop();
    const cmds = batch.commands || [];
    if (cmds.length === 0) return null;

    if (this._batchStack.length > 0) {
      const parentBatch = this._batchStack[this._batchStack.length - 1];
      parentBatch.commands.push(...cmds);
      return parentBatch;
    }

    const combined = cmds.length === 1
      ? cmds[0]
      : new CompositeCommand(cmds, batch.description);
    this.executeCommand(combined);
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('blender:scene-updated'));
      try { window.outliner?.render?.(); } catch (_) {}
      try { window.inspector?.render?.(); } catch (_) {}
    }
    return combined;
  }

  /**
   * Executes a command and pushes to undo stack
   * @param {Command} command 
   */
  executeCommand(command) {
    if (!command) return;
    if (Array.isArray(this._batchStack) && this._batchStack.length > 0) {
      this._batchStack[this._batchStack.length - 1].commands.push(command);
      return;
    }
    this.undoStack.push(command);
    if (this.maxHistoryBytes == null) this.maxHistoryBytes = 64 * 1024 * 1024;
    const totalBytes = () => this.undoStack.reduce((s, c) => s + (c.bytes || 0), 0);
    const evicted = [];
    while (this.undoStack.length > this.maxHistory || (this.undoStack.length > 1 && totalBytes() > this.maxHistoryBytes)) {
      evicted.push(this.undoStack.shift());
    }
    const droppedRedo = this.redoStack.splice(0); // Clear redo stack on new action
    for (const cmd of evicted) this._disposeEvictedGeometry(cmd);
    for (const cmd of droppedRedo) this._disposeEvictedGeometry(cmd);
    this.revision += 1;
    this.emit('historyChanged', {
      action: 'execute',
      command,
      canUndo: this.canUndo(),
      canRedo: this.canRedo(),
      lastAction: command.description
    });
    if (command.isTransform) {
      if (Array.isArray(command.objects) && command.objects.length > 0) {
        for (const o of command.objects) this._emitTransformChanged(o);
      } else {
        this._emitTransformChanged(command.object);
      }
    }
  }

  /**
   * Record a command whose mutation was already applied immediately.
   * Identical bookkeeping/eviction to executeCommand without re-calling execute().
   */
  recordExecutedCommand(command) {
    if (command) this.executeCommand(command);
  }

  _commandReferencesGeometry(command, geometry) {
    if (!command || !geometry) return false;
    if (command.before?.geometry === geometry || command.after?.geometry === geometry ||
        command.oldGeometry === geometry || command.newGeometry === geometry ||
        command.mesh?.geometry === geometry || command.mesh?.userData?.baseGeometry === geometry) {
      return true;
    }
    if (Array.isArray(command.commands)) {
      for (const child of command.commands) {
        if (this._commandReferencesGeometry(child, geometry)) return true;
      }
    }
    return false;
  }

  _isGeometryLive(geometry) {
    if (!geometry) return false;
    if (dataBlockRegistry.isGeometryShared(geometry, this.rootContainer, null)) return true;
    for (const cmd of this.undoStack) {
      if (this._commandReferencesGeometry(cmd, geometry)) return true;
    }
    for (const cmd of this.redoStack) {
      if (this._commandReferencesGeometry(cmd, geometry)) return true;
    }
    return false;
  }

  /** Chỉ dispose snapshot geometry của command bị evict khi không còn live trong scene hoặc undo/redo stack. */
  _disposeEvictedGeometry(command) {
    if (!command) return;
    if (Array.isArray(command.commands)) {
      for (const child of command.commands) this._disposeEvictedGeometry(child);
    }
    const candidates = [
      command.before?.geometry,
      command.after?.geometry,
      command.oldGeometry,
      command.newGeometry,
    ];
    for (const g of candidates) {
      if (!g || typeof g.dispose !== 'function') continue;
      if (!this._isGeometryLive(g)) {
        g.dispose();
      }
    }
  }

  _emitTransformChanged(object) {
    this.emit('transformChanged', object);
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('blender:transformChanged', { detail: object }));
    }
  }

  /**
   * Undo last action
   */
  undo() {
    if (!this.canUndo()) return;
    const command = this.undoStack.pop();
    command.undo();
    this.redoStack.push(command);
    this.revision += 1;
    this.emit('historyChanged', {
      action: 'undo',
      command,
      canUndo: this.canUndo(),
      canRedo: this.canRedo(),
      lastAction: `Undo: ${command.description}`
    });
    if (command.isTransform) {
      if (Array.isArray(command.objects) && command.objects.length > 0) {
        for (const o of command.objects) this._emitTransformChanged(o);
      } else {
        this._emitTransformChanged(command.object);
      }
    }
  }

  /**
   * Redo previously undone action
   */
  redo() {
    if (!this.canRedo()) return;
    const command = this.redoStack.pop();
    command.execute();
    this.undoStack.push(command);
    this.revision += 1;
    this.emit('historyChanged', {
      action: 'redo',
      command,
      canUndo: this.canUndo(),
      canRedo: this.canRedo(),
      lastAction: `Redo: ${command.description}`
    });
    if (command.isTransform) {
      if (Array.isArray(command.objects) && command.objects.length > 0) {
        for (const o of command.objects) this._emitTransformChanged(o);
      } else {
        this._emitTransformChanged(command.object);
      }
    }
  }

  canUndo() {
    return this.undoStack.length > 0;
  }

  canRedo() {
    return this.redoStack.length > 0;
  }

  clearHistory() {
    const dropped = [...this.undoStack.splice(0), ...this.redoStack.splice(0)];
    for (const cmd of dropped) {
      this._disposeEvictedGeometry(cmd);
    }
    this.emit('historyChanged', { action: 'clear', command: null, canUndo: false, canRedo: false, lastAction: null });
  }

  // ==========================================
  // UTILITIES & LOOKUP
  // ==========================================

  /**
   * Resolves an Object3D from an object or id string
   * @param {THREE.Object3D|string} objectOrId 
   * @returns {THREE.Object3D|null}
   */
  resolveObject(objectOrId) {
    if (!objectOrId) return null;
    if (objectOrId instanceof THREE.Object3D) return objectOrId;
    if (typeof objectOrId === 'string') {
      return this.objects.get(objectOrId) || null;
    }
    return null;
  }

  /**
   * Finds an object by its user-facing name
   * @param {string} name 
   * @returns {THREE.Object3D|null}
   */
  findObjectByName(name) {
    for (const obj of this.objects.values()) {
      if (obj.name === name) return obj;
    }
    return null;
  }

  /**
   * Gets all tracked objects
   * @returns {THREE.Object3D[]}
   */
  getAllObjects() {
    return Array.from(this.objects.values());
  }

  /**
   * Gets all selectable objects for raycasting
   * @returns {THREE.Object3D[]}
   */
  getSelectableObjects() {
    const list = [];
    const seen = new Set();
    const collect = (child) => {
      if (!child || seen.has(child)) return;
      seen.add(child);
      if (!child.visible || child.userData?.locked) return;
      if (child.userData?.selectable !== false &&
          !child.userData?.isHelper &&
          !child.userData?.isSystemObject) {
        if (child.isMesh || child.isLight || child.isCamera || child.userData?.isCameraObject) {
          list.push(child);
        }
      }
      if (child.children) {
        child.children.forEach(collect);
      }
    };

    if (this.rootContainer) {
      this.rootContainer.children.forEach(collect);
    }
    this.objects.forEach(obj => {
      collect(obj);
    });
    return list;
  }

  /**
   * Traverses tracked scene objects
   * @param {Function} callback (object) => void
   */
  traverseObjects(callback) {
    const visited = new Set();
    if (this.rootContainer) {
      this.rootContainer.traverse(obj => {
        visited.add(obj);
        callback(obj);
      });
    }
    this.objects.forEach(obj => {
      if (!visited.has(obj)) {
        obj.traverse(callback);
      }
    });
  }

  /**
   * Recursively disposes geometries, materials, and textures to avoid memory leaks
   * @param {THREE.Object3D} object 
   */
  disposeObjectHierarchy(object) {
    this.deepDisposeObject(object);
  }

  disposeMaterial(material, excludeObject = null) {
    if (!material) return;
    if (excludeObject && dataBlockRegistry.isMaterialShared(material, this.rootContainer, excludeObject)) {
      return;
    }
    // Release any procedural texture lease BEFORE checking texture ownership so
    // pooled cache entries & sibling leased materials stay protected from premature dispose.
    textureLeaseRegistry.release(material);
    Object.keys(material).forEach(prop => {
      const val = material[prop];
      if (!val || !val.isTexture) return;
      if (textureLeaseRegistry.isTextureOwned(val)) return;
      if (!excludeObject || !dataBlockRegistry.isTextureShared(val, material, this.rootContainer, excludeObject)) {
        val.dispose();
      }
    });
    material.dispose();
  }

  /**
   * Deeply cleans up an object, its children, geometries, materials, textures,
   * detaches TransformControls, disposes skeletons/helpers, and removes from parent.
   * Prevents any memory leaks or orphaned references.
   * @param {THREE.Object3D} object 
   */
  deepDisposeObject(object) {
    if (!object) return;

    // 1. Detach TransformControls if attached to object or any descendant
    const engine = (typeof window !== 'undefined' ? window.engine : null) || this.engine;
    if (engine && engine.transformControls) {
      const tcTarget = engine.transformControls.object;
      if (tcTarget) {
        let isAttached = (tcTarget === object);
        if (!isAttached && object.traverse) {
          object.traverse(child => {
            if (child === tcTarget) isAttached = true;
          });
        }
        if (isAttached) {
          engine.transformControls.detach();
        }
      }
    }

    // 2. Clean up RigSystem active references and helpers if object is related
    const rigSystem = (typeof window !== 'undefined' ? window.rigSystem : null);
    if (rigSystem) {
      if (rigSystem.activeCharacter === object || rigSystem.activeBone === object) {
        rigSystem.activeBone = null;
        rigSystem.activeCharacter = null;
        rigSystem.activeSkeleton = null;
      }
      if (rigSystem.skeletonHelper) {
        let helperMatches = (rigSystem.skeletonHelper.root === object || rigSystem.skeletonHelper.parent === object);
        if (!helperMatches && object.traverse) {
          object.traverse(child => {
            if (child === rigSystem.skeletonHelper || child === rigSystem.skeletonHelper?.root) {
              helperMatches = true;
            }
          });
        }
        if (helperMatches) {
          if (rigSystem.skeletonHelper.parent) {
            rigSystem.skeletonHelper.parent.remove(rigSystem.skeletonHelper);
          }
          if (rigSystem.skeletonHelper.geometry) rigSystem.skeletonHelper.geometry.dispose();
          if (rigSystem.skeletonHelper.material) rigSystem.skeletonHelper.material.dispose();
          rigSystem.skeletonHelper = null;
        }
      }
    }

    // 3. Recursive disposal of geometries, materials, textures, skeletons
    if (object.traverse) {
      object.traverse(child => {
        // SkinnedMesh skeleton disposal
        if (child.isSkinnedMesh && child.skeleton) {
          if (typeof child.skeleton.dispose === 'function') {
            child.skeleton.dispose();
          }
        }
        if (child.userData?.skeleton && typeof child.userData.skeleton.dispose === 'function') {
          child.userData.skeleton.dispose();
        }

        // Geometries (skip disposal if still referenced by a linked Alt+D sibling)
        if (child.geometry && typeof child.geometry.dispose === 'function') {
          if (!dataBlockRegistry.isGeometryShared(child.geometry, this.rootContainer, child)) {
            child.geometry.dispose();
          }
        }

        // Materials & Textures (skip shared materials/textures on linked Alt+D siblings)
        if (child.material) {
          if (Array.isArray(child.material)) {
            child.material.forEach(m => this.disposeMaterial(m, child));
          } else {
            this.disposeMaterial(child.material, child);
          }
        }

        // Unhook joint handles
        if (child.userData?.isBoneJoint) {
          child.userData.targetBone = null;
        }
      });
    }

    // 4. Detach from parent
    if (object.parent) {
      object.parent.remove(object);
    }
  }

  /**
   * Cleans 100% of scene objects, meshes, lights, bones, helpers, and camera targets.
   * Resets activeSelection = null, ID counters, undo/redo history, Outliner, and Timeline tracks.
   */
  clearScene() {
    // 1. Clear selection
    this.clearSelection();

    // 2. Detach transform controls
    const engine = (typeof window !== 'undefined' ? window.engine : null) || this.engine;
    if (engine && engine.transformControls) {
      engine.transformControls.detach();
    }

    // 3. Reset RigSystem state
    const rigSystem = (typeof window !== 'undefined' ? window.rigSystem : null);
    if (rigSystem) {
      if (rigSystem.isWeightPaintMode && typeof rigSystem.disableWeightPaintMode === 'function') {
        try { rigSystem.disableWeightPaintMode(); } catch (_) {}
      }
      rigSystem.isEditBoneMode = false;
      rigSystem.isWeightPaintMode = false;
      rigSystem.isPoseMode = false;
      rigSystem.editArmature = null;
      rigSystem.editSkeleton = null;
      rigSystem.activeBone = null;
      rigSystem.activeCharacter = null;
      rigSystem.activeSkeleton = null;
      if (rigSystem.skeletonHelper) {
        if (rigSystem.skeletonHelper.parent) {
          rigSystem.skeletonHelper.parent.remove(rigSystem.skeletonHelper);
        }
        if (rigSystem.skeletonHelper.geometry) rigSystem.skeletonHelper.geometry.dispose();
        if (rigSystem.skeletonHelper.material) rigSystem.skeletonHelper.material.dispose();
        rigSystem.skeletonHelper = null;
      }
      const modeIndicator = document.getElementById('mode-indicator-text');
      if (modeIndicator) modeIndicator.textContent = 'Object Mode';
    }

    // 4. Deep dispose all objects registered in this.objects map
    const trackedList = Array.from(this.objects.values());
    trackedList.forEach(obj => {
      this.deepDisposeObject(obj);
    });
    this.objects.clear();
    this.collectionManager?.reset();

    // 5. Clean any children remaining in rootContainer
    if (this.rootContainer && this.rootContainer.children) {
      const rootChildren = [...this.rootContainer.children];
      rootChildren.forEach(child => {
        this.deepDisposeObject(child);
      });
    }

    // 6. Clean up any non-system user orphan objects directly in this.scene
    if (this.scene && this.scene.children) {
      const orphans = [];
      for (const child of this.scene.children) {
        if (child !== this.rootContainer &&
            !child.userData?.isSystemObject &&
            child !== this.scene) {
          orphans.push(child);
        }
      }
      orphans.forEach(child => {
        this.deepDisposeObject(child);
      });
    }

    // 7. Reset name counters, data-block registry, and undo history
    this.nameCounters.clear();
    dataBlockRegistry.clear();
    this.clearHistory();
    this.revision += 1;

    // 8. Clear Timeline tracks
    if (typeof window !== 'undefined' && window.timelineEngine) {
      window.timelineEngine.clearAllKeyframes();
      window.timelineEngine.stop();
      window.timelineEngine.seekToFrame(0);
    }

    // 9. Notify Outliner and UI
    this.emit('sceneCleared');
    this.emit('selectionChanged', { selected: [], active: null });

    if (typeof window !== 'undefined') {
      if (window.outliner && typeof window.outliner.render === 'function') {
        window.outliner.render();
      }
      window.dispatchEvent(new CustomEvent('blender:sceneUpdated'));
      window.dispatchEvent(new CustomEvent('blender:mode-changed', { detail: { mode: 'object' } }));
    }

    return true;
  }
}
