/**
 * Web Blender Studio - Unified Data-Block Registry (Wave 0)
 * File: js/core/data-blocks.js
 *
 * Decouples reusable data-blocks (`meshes`, `materials`, `images`, `actions`,
 * `curves`, `collections`) from Object3D wrappers, tracking multi-user
 * references for true Linked Duplicates (`Alt+D`), shared materials/textures,
 * future Shader Node graphs, and Action/NLA strips.
 */

export const DATA_BLOCK_KINDS = ['meshes', 'materials', 'images', 'actions', 'curves', 'collections'];

function genBlockId(prefix) {
  if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') {
    return `${prefix}_${globalThis.crypto.randomUUID().slice(0, 12)}`;
  }
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function isUserSceneObject(obj) {
  if (!obj) return false;
  if (obj.userData?.isHelper || obj.userData?.isSystemObject) return false;
  if (obj.isTransformControls || obj.isGridHelper || obj.isCameraHelper) return false;
  return true;
}

export class DataBlockRegistry {
  constructor() {
    this._stores = new Map();
    for (const kind of DATA_BLOCK_KINDS) {
      this._stores.set(kind, new Map());
    }
    // Maps runtime Three.js UUIDs -> stable data-block IDs
    this._geomUuidToId = new Map();
    this._matUuidToId = new Map();
    this._imgUuidToId = new Map();
  }

  _store(kind) {
    const map = this._stores.get(kind);
    if (!map) throw new Error(`[DataBlockRegistry] Unknown data-block kind: ${kind}`);
    return map;
  }

  clear() {
    for (const map of this._stores.values()) map.clear();
    this._geomUuidToId.clear();
    this._matUuidToId.clear();
    this._imgUuidToId.clear();
  }

  register(kind, id, entry = {}) {
    const store = this._store(kind);
    const key = id || genBlockId(kind.slice(0, 4));
    const existing = store.get(key);
    const users = new Set(existing?.users || []);
    if (entry.users) {
      for (const u of entry.users) users.add(String(u));
    }
    const record = {
      ...existing,
      ...entry,
      id: key,
      kind,
      name: entry.name || existing?.name || key,
      fakeUser: Boolean(entry.fakeUser ?? existing?.fakeUser ?? false),
      users,
    };
    store.set(key, record);
    if (kind === 'meshes' && record.geometryUuid) {
      this._geomUuidToId.set(record.geometryUuid, key);
    } else if (kind === 'materials' && record.materialUuid) {
      this._matUuidToId.set(record.materialUuid, key);
    } else if (kind === 'images' && record.imageUuid) {
      this._imgUuidToId.set(record.imageUuid, key);
    }
    return record;
  }

  get(kind, id) {
    if (!id) return null;
    return this._store(kind).get(id) || null;
  }

  list(kind) {
    return Array.from(this._store(kind).values());
  }

  getUsers(kind, id) {
    const rec = this.get(kind, id);
    return rec ? Array.from(rec.users) : [];
  }

  getUserCount(kind, id) {
    const rec = this.get(kind, id);
    return rec ? rec.users.size : 0;
  }

  ensureMeshBlock(mesh) {
    if (!mesh || !mesh.isMesh || !mesh.geometry) return null;
    const geom = mesh.geometry;
    let id = mesh.userData?.dataBlockIds?.mesh || this._geomUuidToId.get(geom.uuid);
    if (!id) {
      id = `mesh_${geom.uuid}`;
    }
    const record = this.register('meshes', id, {
      name: geom.name || `${mesh.name || 'Mesh'}_Data`,
      geometryUuid: geom.uuid,
    });
    record.users.add(mesh.uuid);
    this._geomUuidToId.set(geom.uuid, id);
    if (!mesh.userData) mesh.userData = {};
    mesh.userData.dataBlockIds = {
      ...(mesh.userData.dataBlockIds || {}),
      mesh: id,
    };
    return record;
  }

  ensureMaterialBlocks(mesh) {
    if (!mesh || !mesh.material) return [];
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const matIds = [];
    for (const mat of mats) {
      if (!mat) continue;
      let id = this._matUuidToId.get(mat.uuid) || `mat_${mat.uuid}`;
      const record = this.register('materials', id, {
        name: mat.name || mat.type || 'Material',
        materialUuid: mat.uuid,
        type: mat.type,
      });
      record.users.add(mesh.uuid);
      this._matUuidToId.set(mat.uuid, id);
      matIds.push(id);

      // Track textures/images attached to material slots
      for (const slot of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'emissiveMap', 'bumpMap']) {
        const tex = mat[slot];
        if (tex && tex.isTexture) {
          const imgUuid = tex.image?.uuid || tex.uuid;
          const imgId = this._imgUuidToId.get(imgUuid) || `img_${imgUuid}`;
          const imgRec = this.register('images', imgId, {
            name: tex.name || tex.image?.name || `${mat.name || 'Tex'}_${slot}`,
            imageUuid: imgUuid,
            textureUuid: tex.uuid,
          });
          imgRec.users.add(id);
          this._imgUuidToId.set(imgUuid, imgId);
        }
      }
    }
    if (!mesh.userData) mesh.userData = {};
    mesh.userData.dataBlockIds = {
      ...(mesh.userData.dataBlockIds || {}),
      materials: matIds,
    };
    return matIds;
  }

  /**
   * Links `targetMesh` to share the exact mesh (and optionally material) data-block
   * of `sourceMesh` (`Alt+D` Linked Duplicate).
   */
  linkMeshData(targetMesh, sourceMesh, { linkMaterials = true } = {}) {
    if (!targetMesh?.isMesh || !sourceMesh?.isMesh || !sourceMesh.geometry) return null;
    const srcBlock = this.ensureMeshBlock(sourceMesh);
    targetMesh.geometry = sourceMesh.geometry;
    if (linkMaterials && sourceMesh.material) {
      targetMesh.material = sourceMesh.material;
    }
    if (!targetMesh.userData) targetMesh.userData = {};
    targetMesh.userData.dataBlockIds = {
      ...(targetMesh.userData.dataBlockIds || {}),
      mesh: srcBlock.id,
    };
    srcBlock.users.add(targetMesh.uuid);
    if (linkMaterials) {
      this.ensureMaterialBlocks(targetMesh);
    }
    return { meshDataId: srcBlock.id, usersCount: srcBlock.users.size };
  }

  /**
   * Breaks multi-user sharing for `mesh` by cloning its geometry into a unique data-block.
   */
  makeSingleUser(mesh) {
    if (!mesh?.isMesh || !mesh.geometry) return null;
    const oldId = mesh.userData?.dataBlockIds?.mesh;
    if (oldId) {
      const oldRec = this.get('meshes', oldId);
      oldRec?.users?.delete(mesh.uuid);
    }
    const clonedGeom = mesh.geometry.clone();
    mesh.geometry = clonedGeom;
    if (mesh.userData?.baseGeometry) {
      mesh.userData.baseGeometry = mesh.userData.baseGeometry.clone();
    }
    if (mesh.userData?.dataBlockIds) {
      delete mesh.userData.dataBlockIds.mesh;
    }
    return this.ensureMeshBlock(mesh);
  }

  /**
   * Propagates geometry edits on `sourceMesh` (e.g., on Edit Mode exit) to every
   * linked sibling mesh sharing the same `dataBlockIds.mesh`.
   * @returns {number} number of linked siblings updated
   */
  propagateMeshData(sourceMesh, sceneRoot = null) {
    if (!sourceMesh?.isMesh || !sourceMesh.geometry) return 0;
    const meshDataId = sourceMesh.userData?.dataBlockIds?.mesh;
    if (!meshDataId || !sceneRoot || typeof sceneRoot.traverse !== 'function') return 0;

    const block = this.ensureMeshBlock(sourceMesh);
    block.geometryUuid = sourceMesh.geometry.uuid;
    this._geomUuidToId.set(sourceMesh.geometry.uuid, block.id);

    let updated = 0;
    sceneRoot.traverse((node) => {
      if (!node?.isMesh || node === sourceMesh) return;
      if (node.userData?.dataBlockIds?.mesh !== meshDataId) return;
      const hasStack = Array.isArray(node.userData?.modifierStack) && node.userData.modifierStack.length > 0;
      if (hasStack) {
        node.userData.baseGeometry = sourceMesh.geometry;
      } else {
        node.geometry = sourceMesh.geometry;
      }
      block.users.add(node.uuid);
      updated += 1;
    });
    return updated;
  }

  _isNodeExcludedByRoot(node, excludeRoot) {
    if (!excludeRoot) return false;
    let cur = node;
    while (cur) {
      if (cur === excludeRoot) return true;
      cur = cur.parent;
    }
    return false;
  }

  _collectSubtreeUuids(root) {
    const uuids = new Set();
    if (!root) return uuids;
    if (typeof root.traverse === 'function') {
      root.traverse((n) => {
        if (n?.uuid) uuids.add(n.uuid);
      });
    } else if (root.uuid) {
      uuids.add(root.uuid);
    }
    return uuids;
  }

  /**
   * Returns true if any object in `sceneRoot` (outside `excludeObject`'s subtree) references `geometry`.
   */
  isGeometryShared(geometry, sceneRoot = null, excludeObject = null) {
    if (!geometry) return false;
    let refs = 0;
    if (sceneRoot && typeof sceneRoot.traverse === 'function') {
      sceneRoot.traverse((node) => {
        if (!node || this._isNodeExcludedByRoot(node, excludeObject) || !isUserSceneObject(node)) return;
        if (node.geometry === geometry || node.userData?.baseGeometry === geometry) {
          refs += 1;
        }
      });
      return refs > 0;
    }
    const id = this._geomUuidToId.get(geometry.uuid);
    const rec = id ? this.get('meshes', id) : null;
    if (!rec) return false;
    const excludedUuids = this._collectSubtreeUuids(excludeObject);
    for (const u of rec.users) {
      if (!excludedUuids.has(u)) return true;
    }
    return false;
  }

  /**
   * Returns true if any object in `sceneRoot` (outside `excludeObject`'s subtree) still references `material`.
   */
  isMaterialShared(material, sceneRoot = null, excludeObject = null) {
    if (!material) return false;
    const matMatches = (entry) => Array.isArray(entry)
      ? entry.includes(material)
      : entry === material;
    let refs = 0;
    if (sceneRoot && typeof sceneRoot.traverse === 'function') {
      sceneRoot.traverse((node) => {
        if (!node || this._isNodeExcludedByRoot(node, excludeObject) || !isUserSceneObject(node)) return;
        const ud = node.userData || {};
        if (matMatches(node.material) ||
            matMatches(ud.__originalMaterial) ||
            matMatches(ud.__importedMaterial) ||
            matMatches(ud.__boolOrigMaterial)) {
          refs += 1;
        }
      });
      return refs > 0;
    }
    const id = this._matUuidToId.get(material.uuid);
    const rec = id ? this.get('materials', id) : null;
    if (!rec) return false;
    const excludedUuids = this._collectSubtreeUuids(excludeObject);
    for (const u of rec.users) {
      if (!excludedUuids.has(u)) return true;
    }
    return false;
  }

  /**
   * Returns true if any remaining material in `sceneRoot` (besides `excludeMaterial` on `excludeObject`'s subtree)
   * still references `texture`.
   */
  isTextureShared(texture, excludeMaterial = null, sceneRoot = null, excludeObject = null) {
    if (!texture || !texture.isTexture) return false;
    const SLOTS = [
      'map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap',
      'alphaMap', 'emissiveMap', 'bumpMap', 'specularMap', 'envMap', 'lightMap',
    ];
    let shared = false;
    const checkMat = (m) => {
      if (!m || m === excludeMaterial || shared) return;
      for (const s of SLOTS) {
        if (m[s] === texture) {
          shared = true;
          return;
        }
      }
    };
    if (sceneRoot && typeof sceneRoot.traverse === 'function') {
      sceneRoot.traverse((node) => {
        if (shared || !node || this._isNodeExcludedByRoot(node, excludeObject) || !isUserSceneObject(node)) return;
        const ud = node.userData || {};
        for (const holder of [node.material, ud.__originalMaterial, ud.__importedMaterial, ud.__boolOrigMaterial]) {
          if (!holder) continue;
          if (Array.isArray(holder)) holder.forEach(checkMat);
          else checkMat(holder);
        }
      });
    }
    return shared;
  }

  /**
   * Incrementally registers meshes, materials, curves, and actions on a newly
   * added subtree without re-traversing the whole scene (O(subtree) vs O(N²)).
   */
  registerObject(rootObject) {
    if (!rootObject || typeof rootObject.traverse !== 'function') return;
    rootObject.traverse((obj) => {
      if (!isUserSceneObject(obj)) return;
      if (obj.isMesh && obj.geometry) {
        this.ensureMeshBlock(obj);
        this.ensureMaterialBlocks(obj);
      }
      if (obj.userData?.objectType === 'curve' && obj.userData?.curveDataId) {
        const rec = this.register('curves', obj.userData.curveDataId, {
          name: obj.name || 'CurveData',
        });
        rec.users.add(obj.uuid);
      }
      if (Array.isArray(obj.animations)) {
        for (const clip of obj.animations) {
          if (!clip) continue;
          const actId = `act_${clip.uuid || clip.name || 'clip'}`;
          const rec = this.register('actions', actId, {
            name: clip.name || 'Action',
            clipUuid: clip.uuid || null,
            duration: clip.duration || 0,
          });
          rec.users.add(obj.uuid);
        }
      }
    });
  }

  /**
   * Rebuilds/refreshes data-block entries and user refcounts from live scene state.
   */
  syncFromScene(sceneRoot, timelineEngine = null) {
    // Clear live user sets while preserving fakeUser / custom metadata entries
    for (const map of this._stores.values()) {
      for (const rec of map.values()) {
        rec.users.clear();
      }
    }

    if (sceneRoot && typeof sceneRoot.traverse === 'function') {
      sceneRoot.traverse((obj) => {
        if (!isUserSceneObject(obj)) return;
        if (obj.isMesh && obj.geometry) {
          this.ensureMeshBlock(obj);
          this.ensureMaterialBlocks(obj);
        }
        if (obj.userData?.objectType === 'curve' && obj.userData?.curveDataId) {
          const rec = this.register('curves', obj.userData.curveDataId, {
            name: obj.name || 'CurveData',
          });
          rec.users.add(obj.uuid);
        }
        if (Array.isArray(obj.animations)) {
          for (const clip of obj.animations) {
            if (!clip) continue;
            const actId = `act_${clip.uuid || clip.name || 'clip'}`;
            const rec = this.register('actions', actId, {
              name: clip.name || 'Action',
              clipUuid: clip.uuid || null,
              duration: clip.duration || 0,
            });
            rec.users.add(obj.uuid);
          }
        }
      });
    }

    if (timelineEngine && typeof timelineEngine.getActions === 'function') {
      for (const action of timelineEngine.getActions() || []) {
        if (!action?.name) continue;
        this.register('actions', `act_${action.name}`, {
          name: action.name,
          fakeUser: true,
        });
      }
    }

    // Prune unused blocks unless marked fakeUser or collections
    for (const [kind, map] of this._stores.entries()) {
      if (kind === 'collections') continue;
      for (const [id, rec] of map.entries()) {
        if (rec.users.size === 0 && !rec.fakeUser) {
          map.delete(id);
        }
      }
    }

    return this.getStats();
  }

  getStats() {
    const counts = {};
    for (const kind of DATA_BLOCK_KINDS) {
      counts[kind] = this._store(kind).size;
    }
    return counts;
  }

  toJSON() {
    const out = { version: 1 };
    for (const kind of DATA_BLOCK_KINDS) {
      const entries = {};
      for (const [id, rec] of this._store(kind).entries()) {
        entries[id] = {
          ...rec,
          users: Array.from(rec.users),
        };
      }
      out[kind] = entries;
    }
    return out;
  }

  /**
   * Restores data-block metadata from serialized JSON and enforces shared geometry
   * references across live meshes that share the same `meshDataId`.
   */
  fromJSON(snapshot, sceneRoot = null) {
    this.clear();
    if (!snapshot || typeof snapshot !== 'object') {
      if (sceneRoot) this.syncFromScene(sceneRoot);
      return;
    }

    for (const kind of DATA_BLOCK_KINDS) {
      const entries = snapshot[kind];
      if (!entries || typeof entries !== 'object') continue;
      for (const [id, raw] of Object.entries(entries)) {
        if (!raw || typeof raw !== 'object') continue;
        this.register(kind, id, {
          ...raw,
          users: Array.isArray(raw.users) ? raw.users : [],
        });
      }
    }

    if (sceneRoot && typeof sceneRoot.traverse === 'function') {
      const firstGeomByBlockId = new Map();
      sceneRoot.traverse((node) => {
        if (!node?.isMesh || !node.geometry) return;
        const meshDataId = node.userData?.dataBlockIds?.mesh;
        if (!meshDataId) return;
        if (!firstGeomByBlockId.has(meshDataId)) {
          firstGeomByBlockId.set(meshDataId, node.geometry);
        } else {
          const sharedGeom = firstGeomByBlockId.get(meshDataId);
          if (node.geometry !== sharedGeom && !node.userData?.modifierStack?.length) {
            node.geometry = sharedGeom;
          }
        }
      });
      this.syncFromScene(sceneRoot);
    }
  }
}

export const dataBlockRegistry = new DataBlockRegistry();

export default dataBlockRegistry;
