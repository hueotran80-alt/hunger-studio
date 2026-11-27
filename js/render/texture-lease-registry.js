/**
 * Web Blender Studio - Central Procedural Texture Lease Registry
 * Tracks ownership of pooled procedural texture cache entries across materials,
 * material clones, upgrades (Standard -> Physical), Inspector edits, Undo/Redo,
 * and SceneManager.disposeMaterial so GPU textures are never prematurely disposed
 * while still owned by the cache or referenced by another active material.
 * File: js/render/texture-lease-registry.js
 */

export class TextureLeaseRegistry {
  constructor() {
    /** @type {WeakMap<object, { entry: object, client: object|null, textures: Set<object>, onDispose: Function }>} */
    this._materialLeases = new WeakMap();
    /** @type {WeakSet<object>} */
    this._wrappedClones = new WeakSet();
    /** @type {Map<object, Set<object>>} Texture -> Set<cacheEntry> */
    this._cachedTextures = new Map();
    /** @type {Map<object, number>} Texture -> active leased material count */
    this._activeLeasedTextures = new Map();
  }

  _collectEntryTextures(entry) {
    const list = [];
    if (!entry || typeof entry !== 'object') return list;
    if (entry.diffuseTexture) list.push(entry.diffuseTexture);
    if (entry.normalTexture) list.push(entry.normalTexture);
    if (entry.roughnessTexture) list.push(entry.roughnessTexture);
    return list;
  }

  /**
   * Registers a live cache entry so SceneManager.disposeMaterial never disposes
   * GPU textures still cached by ProceduralTextureClient.
   */
  registerCacheEntry(entry) {
    if (!entry || typeof entry !== 'object') return;
    for (const tex of this._collectEntryTextures(entry)) {
      let set = this._cachedTextures.get(tex);
      if (!set) {
        set = new Set();
        this._cachedTextures.set(tex, set);
      }
      set.add(entry);
    }
  }

  /**
   * Unregisters a cache entry right before ProceduralTextureClient evicts/disposes it.
   */
  unregisterCacheEntry(entry) {
    if (!entry || typeof entry !== 'object') return;
    for (const tex of this._collectEntryTextures(entry)) {
      const set = this._cachedTextures.get(tex);
      if (!set) continue;
      set.delete(entry);
      if (set.size === 0) this._cachedTextures.delete(tex);
    }
  }

  /**
   * Binds a material to a procedural cache entry (idempotent for same entry;
   * safely releases any prior entry on re-bind).
   */
  bind(material, entry, client = null, extraTextures = []) {
    if (!material || !entry) return false;
    const existing = this._materialLeases.get(material);
    if (existing && existing.entry === entry && existing.client === client) {
      return true;
    }
    if (existing) {
      this.release(material);
    }

    client?.acquireLease?.(entry);

    const texSet = new Set();
    for (const t of this._collectEntryTextures(entry)) {
      if (t) texSet.add(t);
    }
    if (Array.isArray(extraTextures)) {
      for (const t of extraTextures) {
        if (t && t.isTexture) texSet.add(t);
      }
    }
    for (const tex of texSet) {
      this._activeLeasedTextures.set(tex, (this._activeLeasedTextures.get(tex) || 0) + 1);
    }

    const onDispose = () => {
      this.release(material);
    };
    material.addEventListener?.('dispose', onDispose);

    if (!this._wrappedClones.has(material) && typeof material.clone === 'function') {
      this._wrappedClones.add(material);
      const origClone = material.clone.bind(material);
      material.clone = () => {
        const cloned = origClone();
        const held = this._materialLeases.get(material);
        if (held) {
          this.bind(cloned, held.entry, held.client, [cloned.map, cloned.normalMap, cloned.roughnessMap]);
        }
        return cloned;
      };
    }

    this._materialLeases.set(material, {
      entry,
      client,
      textures: texSet,
      onDispose,
    });
    return true;
  }

  /**
   * Transfers a lease from one material to another (e.g. Standard -> Physical upgrade).
   * Acquires on target BEFORE releasing source so refcount never dips to 0 mid-transfer.
   */
  transfer(fromMaterial, toMaterial, { releaseSource = true } = {}) {
    if (!fromMaterial || !toMaterial || fromMaterial === toMaterial) return false;
    const held = this._materialLeases.get(fromMaterial);
    if (!held) return false;
    this.bind(toMaterial, held.entry, held.client, [
      ...held.textures,
      toMaterial.map,
      toMaterial.normalMap,
      toMaterial.roughnessMap,
    ]);
    if (releaseSource) {
      this.release(fromMaterial);
    }
    return true;
  }

  /**
   * Releases the lease owned by a material (idempotent).
   */
  release(material) {
    if (!material) return false;
    const held = this._materialLeases.get(material);
    if (!held) return false;
    this._materialLeases.delete(material);
    try {
      material.removeEventListener?.('dispose', held.onDispose);
    } catch (_) {}
    for (const tex of held.textures) {
      const next = (this._activeLeasedTextures.get(tex) || 0) - 1;
      if (next <= 0) this._activeLeasedTextures.delete(tex);
      else this._activeLeasedTextures.set(tex, next);
    }
    try {
      held.client?.releaseLease?.(held.entry);
    } catch (_) {}
    return true;
  }

  /**
   * Releases leases for all materials across an Object3D subtree.
   */
  releaseObjectTree(root) {
    if (!root || typeof root.traverse !== 'function') return 0;
    let count = 0;
    root.traverse((obj) => {
      if (!obj.material) return;
      const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
      for (const m of mats) {
        if (this.release(m)) count++;
      }
    });
    return count;
  }

  getLease(material) {
    return material ? (this._materialLeases.get(material) || null) : null;
  }

  /**
   * Returns true if this texture is currently owned by a live cache entry or
   * any actively leased material (so callers like SceneManager.disposeMaterial
   * must NOT call texture.dispose()).
   */
  isTextureOwned(texture) {
    if (!texture) return false;
    const cacheHolders = this._cachedTextures.get(texture);
    if (cacheHolders && cacheHolders.size > 0) return true;
    return (this._activeLeasedTextures.get(texture) || 0) > 0;
  }
}

export const textureLeaseRegistry = new TextureLeaseRegistry();
