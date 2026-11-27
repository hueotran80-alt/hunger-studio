/**
 * Nested Collections & View Layers Manager (Wave 3C)
 * Replaces flat single "Scene Collection" with hierarchical Collections,
 * visibility/render/holdout flags, View Layers, and DataBlockRegistry sync.
 * File: js/core/collection-manager.js
 */

import { dataBlockRegistry } from './data-blocks.js';

export class CollectionManager {
  constructor(sceneManager = null) {
    this.sceneManager = sceneManager;
    this.collections = new Map(); // id -> { id, name, parentId, childIds: [], objectUuids: Set, visible, renderable, holdout, color }
    this.viewLayers = new Map();  // id -> { id, name, excludedCollectionIds: Set, holdoutCollectionIds: Set }
    this.rootId = 'col_scene_root';
    this.activeCollectionId = this.rootId;
    this.activeViewLayerId = 'vl_main';

    this.reset();
  }

  reset() {
    this.collections.clear();
    this.viewLayers.clear();
    this.collections.set(this.rootId, {
      id: this.rootId,
      name: 'Scene Collection',
      parentId: null,
      childIds: [],
      objectUuids: new Set(),
      visible: true,
      renderable: true,
      holdout: false,
      color: null,
    });
    this.viewLayers.set('vl_main', {
      id: 'vl_main',
      name: 'ViewLayer',
      excludedCollectionIds: new Set(),
      holdoutCollectionIds: new Set(),
    });
    this.activeCollectionId = this.rootId;
    this.activeViewLayerId = 'vl_main';
    this._syncDataBlocks();
  }

  createCollection(name = 'Collection', parentId = this.rootId, options = {}) {
    const parent = this.collections.get(parentId) || this.collections.get(this.rootId);
    const id = options.id || `col_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    const col = {
      id,
      name: String(name || 'Collection'),
      parentId: parent.id,
      childIds: [],
      objectUuids: new Set(),
      visible: options.visible !== false,
      renderable: options.renderable !== false,
      holdout: Boolean(options.holdout),
      color: options.color || null,
    };
    this.collections.set(id, col);
    if (!parent.childIds.includes(id)) parent.childIds.push(id);
    this.activeCollectionId = id;
    this._syncDataBlocks();
    this.applyEffectiveVisibility();
    return col;
  }

  removeCollection(collectionId) {
    if (!collectionId || collectionId === this.rootId) return false;
    const col = this.collections.get(collectionId);
    if (!col) return false;
    const parent = this.collections.get(col.parentId) || this.collections.get(this.rootId);

    // Reparent objects & child collections cleanly to parent so nothing is orphaned
    for (const uuid of col.objectUuids) parent.objectUuids.add(uuid);
    for (const cid of col.childIds) {
      const child = this.collections.get(cid);
      if (child) {
        child.parentId = parent.id;
        parent.childIds.push(cid);
      }
    }
    parent.childIds = parent.childIds.filter((x) => x !== collectionId);
    this.collections.delete(collectionId);
    for (const vl of this.viewLayers.values()) {
      vl.excludedCollectionIds.delete(collectionId);
      vl.holdoutCollectionIds.delete(collectionId);
    }
    if (this.activeCollectionId === collectionId) this.activeCollectionId = parent.id;
    this._syncDataBlocks();
    this.applyEffectiveVisibility();
    return true;
  }

  addObjectToCollection(obj, collectionId = this.activeCollectionId) {
    if (!obj) return false;
    const col = this.collections.get(collectionId) || this.collections.get(this.rootId);
    col.objectUuids.add(obj.uuid);
    obj.userData = obj.userData || {};
    obj.userData.collectionId = col.id;
    this._syncDataBlocks();
    this.applyEffectiveVisibility();
    return true;
  }

  moveObjectToCollection(obj, targetCollectionId) {
    if (!obj) return false;
    const target = this.collections.get(targetCollectionId) || this.collections.get(this.rootId);
    for (const col of this.collections.values()) {
      col.objectUuids.delete(obj.uuid);
    }
    target.objectUuids.add(obj.uuid);
    obj.userData = obj.userData || {};
    obj.userData.collectionId = target.id;
    this._syncDataBlocks();
    this.applyEffectiveVisibility();
    return true;
  }

  getObjectCollectionId(obj) {
    if (!obj) return this.rootId;
    for (const col of this.collections.values()) {
      if (col.objectUuids.has(obj.uuid)) return col.id;
    }
    const hint = obj.userData?.collectionId;
    if (hint && this.collections.has(hint)) return hint;
    return this.rootId;
  }

  ensureObjectTracked(obj) {
    if (!obj || obj.userData?.isHelper || obj.userData?.isSystemObject) return;
    for (const col of this.collections.values()) {
      if (col.objectUuids.has(obj.uuid)) return;
    }
    const hint = obj.userData?.collectionId;
    const col = (hint && this.collections.get(hint)) || this.collections.get(this.rootId);
    col.objectUuids.add(obj.uuid);
  }

  setCollectionVisibility(collectionId, visible) {
    const col = this.collections.get(collectionId);
    if (!col) return false;
    col.visible = Boolean(visible);
    this.applyEffectiveVisibility();
    return true;
  }

  renameCollection(collectionId, newName) {
    const col = this.collections.get(collectionId);
    const trimmed = String(newName || '').trim();
    if (!col || !trimmed) return false;
    col.name = trimmed;
    this._syncDataBlocks();
    return true;
  }

  setCollectionRenderable(collectionId, renderable) {
    const col = this.collections.get(collectionId);
    if (!col) return false;
    col.renderable = Boolean(renderable);
    this._syncDataBlocks();
    this.applyEffectiveVisibility();
    return true;
  }

  setCollectionHoldout(collectionId, holdout) {
    const col = this.collections.get(collectionId);
    if (!col) return false;
    col.holdout = Boolean(holdout);
    const vl = this.viewLayers.get(this.activeViewLayerId);
    if (vl) {
      if (col.holdout) vl.holdoutCollectionIds.add(collectionId);
      else vl.holdoutCollectionIds.delete(collectionId);
    }
    this._syncDataBlocks();
    this.applyEffectiveVisibility();
    return true;
  }

  removeObjectUuid(uuid) {
    if (!uuid) return false;
    let removed = false;
    for (const col of this.collections.values()) {
      if (col.objectUuids.delete(uuid)) removed = true;
    }
    if (removed) this._syncDataBlocks();
    return removed;
  }

  // -------------------------------------------------------------------------
  // View Layers
  // -------------------------------------------------------------------------

  createViewLayer(name = 'ViewLayer') {
    const id = `vl_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 5)}`;
    const vl = {
      id,
      name: String(name || 'ViewLayer'),
      excludedCollectionIds: new Set(),
      holdoutCollectionIds: new Set(),
    };
    this.viewLayers.set(id, vl);
    this.activeViewLayerId = id;
    this.applyEffectiveVisibility();
    return vl;
  }

  setActiveViewLayer(viewLayerId) {
    if (!this.viewLayers.has(viewLayerId)) return false;
    this.activeViewLayerId = viewLayerId;
    this.applyEffectiveVisibility();
    return true;
  }

  setCollectionExcludedInViewLayer(collectionId, excluded, viewLayerId = this.activeViewLayerId) {
    const vl = this.viewLayers.get(viewLayerId);
    if (!vl || collectionId === this.rootId) return false;
    if (excluded) vl.excludedCollectionIds.add(collectionId);
    else vl.excludedCollectionIds.delete(collectionId);
    if (viewLayerId === this.activeViewLayerId) this.applyEffectiveVisibility();
    return true;
  }

  isCollectionEffectivelyVisible(collectionId, viewLayerId = this.activeViewLayerId) {
    const vl = this.viewLayers.get(viewLayerId);
    let curId = collectionId;
    while (curId) {
      const col = this.collections.get(curId);
      if (!col) break;
      if (!col.visible) return false;
      if (vl && vl.excludedCollectionIds.has(curId)) return false;
      curId = col.parentId;
    }
    return true;
  }

  applyEffectiveVisibility() {
    const sm = this.sceneManager;
    if (!sm) return;
    const allObjs = typeof sm.getAllObjects === 'function' ? sm.getAllObjects() : [];
    for (const obj of allObjs) {
      if (!obj || obj.userData?.isHelper || obj.userData?.isSystemObject) continue;
      if (obj.userData?.__localViewHidden) continue; // Local View (/) overrides
      const cid = this.getObjectCollectionId(obj);
      const colVisible = this.isCollectionEffectivelyVisible(cid);
      const selfHidden = obj.userData?.visible === false;
      obj.visible = colVisible && !selfHidden;

      // Sync collection renderable & holdout flags down onto object metadata
      let renderable = true;
      let holdout = false;
      let curId = cid;
      while (curId) {
        const c = this.collections.get(curId);
        if (!c) break;
        if (c.renderable === false) renderable = false;
        if (c.holdout) holdout = true;
        curId = c.parentId;
      }
      if (!obj.userData) obj.userData = {};
      obj.userData.collectionRenderable = renderable;
      obj.userData.collectionHoldout = holdout;
    }
    sm.requestRender?.();
  }

  _syncDataBlocks() {
    for (const col of this.collections.values()) {
      dataBlockRegistry.register('collections', col.id, {
        name: col.name,
        parentId: col.parentId,
        users: new Set(col.objectUuids),
      });
    }
  }

  toJSON() {
    return {
      activeCollectionId: this.activeCollectionId,
      activeViewLayerId: this.activeViewLayerId,
      collections: Array.from(this.collections.values()).map((c) => ({
        id: c.id,
        name: c.name,
        parentId: c.parentId,
        childIds: [...c.childIds],
        objectUuids: Array.from(c.objectUuids),
        visible: c.visible,
        renderable: c.renderable,
        holdout: c.holdout,
        color: c.color,
      })),
      viewLayers: Array.from(this.viewLayers.values()).map((v) => ({
        id: v.id,
        name: v.name,
        excludedCollectionIds: Array.from(v.excludedCollectionIds),
        holdoutCollectionIds: Array.from(v.holdoutCollectionIds),
      })),
    };
  }

  fromJSON(data) {
    if (!data || !Array.isArray(data.collections)) return;
    this.collections.clear();
    for (const c of data.collections) {
      this.collections.set(c.id, {
        id: c.id,
        name: c.name,
        parentId: c.parentId ?? null,
        childIds: Array.isArray(c.childIds) ? [...c.childIds] : [],
        objectUuids: new Set(c.objectUuids || []),
        visible: c.visible !== false,
        renderable: c.renderable !== false,
        holdout: Boolean(c.holdout),
        color: c.color || null,
      });
    }
    if (!this.collections.has(this.rootId)) this.reset();
    this.viewLayers.clear();
    for (const v of (data.viewLayers || [])) {
      this.viewLayers.set(v.id, {
        id: v.id,
        name: v.name,
        excludedCollectionIds: new Set(v.excludedCollectionIds || []),
        holdoutCollectionIds: new Set(v.holdoutCollectionIds || []),
      });
    }
    if (!this.viewLayers.size) {
      this.viewLayers.set('vl_main', { id: 'vl_main', name: 'ViewLayer', excludedCollectionIds: new Set(), holdoutCollectionIds: new Set() });
    }
    this.activeCollectionId = data.activeCollectionId || this.rootId;
    this.activeViewLayerId = data.activeViewLayerId || Array.from(this.viewLayers.keys())[0];
    this._syncDataBlocks();
    this.applyEffectiveVisibility();
  }
}
