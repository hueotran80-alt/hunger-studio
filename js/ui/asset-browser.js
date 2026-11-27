/**
 * Unified Asset Browser (Materials, Shader Presets, GLB Prefabs, Primitives, Scene Data-Blocks)
 * Features instant search, tag chips, offscreen thumbnail generation + BlobStore caching,
 * and BVH raycast drag-and-drop placement aligned to surface normals in the 3D Viewport.
 * File: js/ui/asset-browser.js
 */

import * as THREE from 'three';
import { raycastMeshAccelerated, ensureBVH } from '../core/bvh-accelerator.js';
import { prefabLibrary } from '../scripting/prefab-library.js';
import { ShaderGraph, evalFbmNoiseCPU } from '../core/shader-graph.js';
import { applyShaderGraphToMaterial } from '../core/shader-compiler-three.js';
import {
  FAB_CATALOG, FAB_LICENSE_NOTE, STUDIO_CATEGORIES, LOCAL_EXTENSIONS,
  loadOnlineCatalog, loadStudioCatalog, resolvePolyHavenAsset,
  scanLocalDirectory, createLocalItemsFromFiles, importAssetFile, recordCredit, formatCredits,
} from './asset-library-sources.js';

export const ASSET_KINDS = [
  'all', 'materials', 'shaders', 'prefabs', 'primitives', 'images',
  'online', 'studio', 'community', 'local', 'fab',
];

const PRIMITIVE_ASSETS = [
  { id: 'prim_cube', name: 'Cube', kind: 'primitives', studioCategory: 'props', prim: 'cube', tags: ['mesh', 'basic', 'blockout'] },
  { id: 'prim_sphere', name: 'UV Sphere', kind: 'primitives', studioCategory: 'props', prim: 'sphere', tags: ['mesh', 'organic', 'round'] },
  { id: 'prim_cylinder', name: 'Cylinder', kind: 'primitives', studioCategory: 'architecture', prim: 'cylinder', tags: ['mesh', 'architecture', 'pipe'] },
  { id: 'prim_cone', name: 'Cone', kind: 'primitives', studioCategory: 'props', prim: 'cone', tags: ['mesh', 'basic'] },
  { id: 'prim_torus', name: 'Torus', kind: 'primitives', studioCategory: 'props', prim: 'torus', tags: ['mesh', 'ring'] },
  { id: 'prim_plane', name: 'Plane', kind: 'primitives', studioCategory: 'environments', prim: 'plane', tags: ['mesh', 'ground', 'stage'] },
];

const SHADER_PRESET_ASSETS = [
  {
    id: 'sg_procedural_stone',
    name: 'Procedural Stone (Noise+Bump)',
    kind: 'shaders',
    studioCategory: 'materials',
    presetKey: 'procedural_stone',
    tags: ['procedural', 'rock', 'bump', 'shader'],
    swatch: 'radial-gradient(circle at 35% 30%, #d0d5dd, #6b7280 60%, #1f2937)',
  },
  {
    id: 'sg_fresnel_rim',
    name: 'Iridescent Voronoi Shell',
    kind: 'shaders',
    studioCategory: 'materials',
    presetKey: 'fresnel_rim',
    tags: ['procedural', 'fresnel', 'voronoi', 'shader'],
    swatch: 'radial-gradient(circle at 35% 30%, #f43f5e, #3b82f6 65%, #0f172a)',
  },
];

/**
 * Builds normalized searchable asset catalog combining MaterialStudio, PrefabLibrary,
 * Primitives, Shader Presets, Online CC0/BY, Studio Local, Community, and DataBlockRegistry entries.
 */
export function buildAssetCatalog({
  materialStudio = null,
  dataBlockRegistry = null,
  extraPrefabs = null,
  online = [],
  studio = [],
  community = [],
  local = [],
  fab = [],
} = {}) {
  const items = [];

  if (materialStudio && typeof materialStudio.getMaterialPresets === 'function') {
    const presets = materialStudio.getMaterialPresets();
    for (const [key, p] of Object.entries(presets)) {
      items.push({
        id: `mat_${key}`,
        key,
        name: p.name.split('(')[0].trim(),
        kind: 'materials',
        studioCategory: 'materials',
        category: p.category || 'PBR',
        tags: [String(p.category || 'pbr').toLowerCase(), 'material', 'pbr', key],
        swatch: p.swatch || null,
        color: p.color,
        roughness: p.roughness,
        metalness: p.metalness,
      });
    }
  }

  for (const sp of SHADER_PRESET_ASSETS) items.push({ ...sp });

  const prefabs = extraPrefabs || prefabLibrary.list();
  for (const pf of prefabs) {
    items.push({
      id: `pf_${pf.id}`,
      prefabId: pf.id,
      name: pf.name,
      kind: 'prefabs',
      studioCategory: pf.rigged ? 'characters' : 'props',
      tags: [...(pf.keywords || []), pf.rigged ? 'rigged' : 'scan', 'glb', 'prefab'],
      naturalHeight: pf.naturalHeight,
    });
  }

  for (const pr of PRIMITIVE_ASSETS) items.push({ ...pr });

  for (const cm of community) {
    items.push({
      ...cm,
      kind: 'community',
      studioCategory: cm.category || cm.studioCategory || 'scenes',
    });
  }
  for (const st of studio) {
    items.push({
      ...st,
      kind: 'studio',
      studioCategory: st.studioCategory || 'props',
    });
  }
  for (const on of online) {
    items.push({
      ...on,
      kind: on.kind || 'online',
      studioCategory: on.studioCategory || 'props',
    });
  }
  for (const lo of local) items.push({ ...lo, kind: 'local', studioCategory: lo.studioCategory || 'props' });
  for (const fb of fab) items.push({ ...fb, kind: 'fab', studioCategory: fb.studioCategory || 'props' });

  if (dataBlockRegistry && typeof dataBlockRegistry.list === 'function') {
    for (const img of dataBlockRegistry.list('images')) {
      items.push({
        id: `db_img_${img.id}`,
        blockId: img.id,
        imageUuid: img.imageUuid || null,
        textureUuid: img.textureUuid || null,
        name: img.name,
        kind: 'images',
        studioCategory: 'materials',
        tags: ['texture', 'image', img.slot || 'map', 'datablock'],
      });
    }
  }

  return items;
}

export function filterAssetCatalog(items, { query = '', kind = 'all', category = 'all', tag = '' } = {}) {
  const q = String(query || '').trim().toLowerCase();
  const t = String(tag || '').trim().toLowerCase();
  const cat = String(category || 'all').trim().toLowerCase();
  return items.filter((it) => {
    if (kind && kind !== 'all' && it.kind !== kind) return false;
    if (cat && cat !== 'all') {
      const itemCat = String(it.studioCategory || it.category || '').toLowerCase();
      if (itemCat !== cat) return false;
    }
    if (t && !(it.tags || []).some((x) => x.toLowerCase().includes(t))) return false;
    if (q) {
      const hay = `${it.name || ''} ${it.title || ''} ${it.id || ''} ${it.studioCategory || ''} ${(it.tags || []).join(' ')}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

function isSystemOrHelperObject(node) {
  let cur = node;
  while (cur) {
    if (cur.isScene || cur.name === 'Scene_Collection') return false;
    if (
      cur.userData?.isSystemObject ||
      cur.userData?.isSystemHelper ||
      cur.userData?.isHelper ||
      cur.userData?.isLightHelper ||
      cur.userData?.isCameraPart ||
      cur.userData?.selectable === false ||
      cur.isTransformControls ||
      cur.isTransformControlsGizmo ||
      cur.isTransformControlsPlane ||
      cur.name === 'Studio_Cyclorama_Backdrop'
    ) {
      return true;
    }
    cur = cur.parent;
  }
  return false;
}

function isInvisiblePickerMesh(node) {
  if (!node?.material) return false;
  if (Array.isArray(node.material)) {
    return node.material.length > 0 && node.material.every((m) => m && m.visible === false);
  }
  return node.material.visible === false;
}

/**
 * Performs raycast against visible scene meshes (falling back to Y=0 ground plane)
 * and computes world position + surface-normal-aligned quaternion.
 */
export function pickDropTransformOnScene(scene, camera, ndcX, ndcY, alignToNormal = true) {
  const raycaster = new THREE.Raycaster();
  raycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), camera);

  const meshes = [];
  scene?.traverseVisible?.((node) => {
    if (node.isMesh && !isSystemOrHelperObject(node) && !isInvisiblePickerMesh(node)) {
      meshes.push(node);
    }
  });

  let bestHit = null;
  for (const m of meshes) {
    ensureBVH(m);
    const hits = raycastMeshAccelerated(m, raycaster);
    if (hits && hits.length > 0 && (!bestHit || hits[0].distance < bestHit.distance)) {
      bestHit = hits[0];
    }
  }

  if (bestHit) {
    const position = bestHit.point.clone();
    const worldNormal = new THREE.Vector3(0, 1, 0);
    if (bestHit.face?.normal) {
      const nm = new THREE.Matrix3().getNormalMatrix(bestHit.object.matrixWorld);
      worldNormal.copy(bestHit.face.normal).applyMatrix3(nm).normalize();
    }
    const quaternion = new THREE.Quaternion();
    if (alignToNormal) {
      quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), worldNormal);
    }
    return {
      targetMesh: bestHit.object,
      position,
      normal: worldNormal,
      quaternion,
      hitGeometry: true,
    };
  }

  // Fallback: Y=0 plane intersection (clamped so horizon drops never fly hundreds of meters away)
  const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  const pt = new THREE.Vector3();
  const hitPlane = raycaster.ray.intersectPlane(plane, pt);
  const MAX_GROUND_DROP_RADIUS = 12;
  let pos;
  if (hitPlane && Number.isFinite(hitPlane.x) && Number.isFinite(hitPlane.z)) {
    const r = Math.hypot(hitPlane.x, hitPlane.z);
    if (r > MAX_GROUND_DROP_RADIUS) {
      const k = MAX_GROUND_DROP_RADIUS / r;
      pos = new THREE.Vector3(hitPlane.x * k, 0, hitPlane.z * k);
    } else {
      pos = new THREE.Vector3(hitPlane.x, 0, hitPlane.z);
    }
  } else {
    // Ray aimed above horizon: project 6m ahead of camera onto Y=0
    const dir = raycaster.ray.direction.clone();
    dir.y = 0;
    if (dir.lengthSq() < 1e-6) dir.set(0, 0, -1);
    dir.normalize();
    pos = new THREE.Vector3(
      camera.position.x + dir.x * 6,
      0,
      camera.position.z + dir.z * 6
    );
    const r = Math.hypot(pos.x, pos.z);
    if (r > MAX_GROUND_DROP_RADIUS) pos.multiplyScalar(MAX_GROUND_DROP_RADIUS / r);
  }
  return {
    targetMesh: null,
    position: pos,
    normal: new THREE.Vector3(0, 1, 0),
    quaternion: new THREE.Quaternion(),
    hitGeometry: false,
  };
}

/**
 * Generates clean box-projected UVs if a mesh geometry has no `uv` attribute,
 * so textured PBR materials render properly on raw STL/procedural meshes.
 */
export function ensureGeometryUVs(geometry) {
  if (!geometry || geometry.attributes?.uv || !geometry.attributes?.position) return false;
  const pos = geometry.attributes.position;
  if (!geometry.attributes.normal) geometry.computeVertexNormals();
  const norm = geometry.attributes.normal;
  if (!geometry.boundingBox) geometry.computeBoundingBox();
  const box = geometry.boundingBox;
  const size = new THREE.Vector3();
  box.getSize(size);
  const span = Math.max(size.x, size.y, size.z, 1e-4);
  const uv = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i += 1) {
    const x = (pos.getX(i) - box.min.x) / span;
    const y = (pos.getY(i) - box.min.y) / span;
    const z = (pos.getZ(i) - box.min.z) / span;
    const ax = norm ? Math.abs(norm.getX(i)) : 0;
    const ay = norm ? Math.abs(norm.getY(i)) : 1;
    const az = norm ? Math.abs(norm.getZ(i)) : 0;
    if (ay >= ax && ay >= az) {
      uv[i * 2] = x;
      uv[i * 2 + 1] = z;
    } else if (ax >= ay && ax >= az) {
      uv[i * 2] = z;
      uv[i * 2 + 1] = y;
    } else {
      uv[i * 2] = x;
      uv[i * 2 + 1] = y;
    }
  }
  geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return true;
}

const UPRIGHT_CATEGORIES = new Set(['characters', 'environments', 'architecture', 'vegetation']);

function _computeSafeWorldBounds(object) {
  object.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(object);
  if (box.isEmpty() || !Number.isFinite(box.min.x) || !Number.isFinite(box.max.y)) {
    return null;
  }
  const size = new THREE.Vector3();
  const center = new THREE.Vector3();
  box.getSize(size);
  box.getCenter(center);
  return { box, size, center };
}

/**
 * Finds a non-overlapping floor slot near the origin when spawning by double-click.
 */
export function findOpenSpawnPosition(sceneManager, size, ignoreObject = null) {
  const footprintRadius = Math.max(0.45, Math.hypot(size?.x || 1, size?.z || 1) * 0.5);
  const existing = [];
  const all = sceneManager?.getAllObjects?.() || [];
  for (const obj of all) {
    if (!obj || obj === ignoreObject || !obj.visible || isSystemOrHelperObject(obj)) continue;
    if (obj.isLight || obj.isCamera) continue;
    // Skip descendants whose ancestor is already in the list
    let skip = false;
    let p = obj.parent;
    while (p) {
      if (p === ignoreObject) { skip = true; break; }
      p = p.parent;
    }
    if (skip) continue;
    const b = _computeSafeWorldBounds(obj);
    if (!b) continue;
    const r = Math.max(0.35, Math.hypot(b.size.x, b.size.z) * 0.5);
    // Ignore huge environment shells enclosing the origin
    if (r > 5.0) continue;
    existing.push({ x: b.center.x, z: b.center.z, r });
  }

  const isFree = (cx, cz) => existing.every((o) => {
    const minDist = footprintRadius + o.r + 0.35;
    return Math.hypot(cx - o.x, cz - o.z) >= minDist;
  });

  if (isFree(0, 0)) return new THREE.Vector3(0, 0, 0);

  const step = Math.max(1.6, footprintRadius * 2 + 0.45);
  for (let ring = 1; ring <= 8; ring += 1) {
    const dist = step * ring;
    const slots = ring * 8;
    for (let i = 0; i < slots; i += 1) {
      const angle = (i / slots) * Math.PI * 2;
      const cx = Math.round(Math.cos(angle) * dist * 100) / 100;
      const cz = Math.round(Math.sin(angle) * dist * 100) / 100;
      if (isFree(cx, cz)) return new THREE.Vector3(cx, 0, cz);
    }
  }
  return new THREE.Vector3(step, 0, 0);
}

/**
 * Normalizes out-of-range model scales by category, centers X/Z on the target anchor,
 * and seats the object cleanly on the floor or hit surface without sinking or floating.
 */
export function normalizeAndPlaceAsset(object, {
  dropInfo = null,
  category = 'props',
  normalizeScale = true,
  alignToNormal = false,
  sceneManager = null,
} = {}) {
  if (!object) return null;
  const cat = String(category || 'props').toLowerCase();

  const initial = _computeSafeWorldBounds(object);
  if (!initial) return null;

  // 1. Category-aware scale normalization (only rescales absurdly tiny/huge models)
  if (normalizeScale && cat !== 'primitives') {
    const { size } = initial;
    const maxDim = Math.max(size.x, size.y, size.z);
    let factor = 1;
    if (cat === 'characters' && size.y > 1e-6) {
      if (size.y < 0.6 || size.y > 2.4) factor = 1.7 / size.y;
    } else if (cat === 'environments' && maxDim > 1e-6) {
      if (maxDim < 4.0) factor = 8.0 / maxDim;
      else if (maxDim > 14.0) factor = 12.0 / maxDim;
    } else if (cat === 'architecture' && maxDim > 1e-6) {
      if (maxDim < 1.2) factor = 2.5 / maxDim;
      else if (maxDim > 8.0) factor = 6.0 / maxDim;
    } else if (cat === 'vegetation' && maxDim > 1e-6) {
      if (maxDim < 0.35) factor = 0.75 / maxDim;
      else if (maxDim > 5.5) factor = 3.5 / maxDim;
    } else if (maxDim > 1e-6) {
      // props / general 3D objects
      if (maxDim < 0.45) factor = 1.0 / maxDim;
      else if (maxDim > 3.0) factor = 2.0 / maxDim;
    }
    if (Number.isFinite(factor) && factor > 0 && Math.abs(factor - 1) > 1e-4) {
      object.scale.multiplyScalar(factor);
    }
  }

  // 2. Surface orientation (keep upright categories upright; only align props/primitives if enabled)
  if (alignToNormal && dropInfo?.hitGeometry && dropInfo?.quaternion && !UPRIGHT_CATEGORIES.has(cat)) {
    object.quaternion.copy(dropInfo.quaternion);
  }

  // 3. Recompute bounds after scale/orientation, then center & ground / seat on surface
  const after = _computeSafeWorldBounds(object);
  if (!after) return null;
  const { box, size, center } = after;
  const maxDimAfter = Math.max(size.x, size.y, size.z);

  let targetPos;
  if (dropInfo?.position) {
    targetPos = dropInfo.position.clone();
  } else if (cat === 'environments' || maxDimAfter > 5.0) {
    targetPos = new THREE.Vector3(0, 0, 0);
  } else {
    targetPos = findOpenSpawnPosition(sceneManager, size, object);
  }

  const normal = dropInfo?.normal || new THREE.Vector3(0, 1, 0);
  const seatOnHorizontal = !dropInfo?.hitGeometry || normal.y > 0.7;
  if (seatOnHorizontal) {
    object.position.x += targetPos.x - center.x;
    object.position.z += targetPos.z - center.z;
    object.position.y += targetPos.y - box.min.y;
  } else {
    const n = normal.clone().normalize();
    const halfExtent = 0.5 * (Math.abs(n.x) * size.x + Math.abs(n.y) * size.y + Math.abs(n.z) * size.z);
    object.position.x += (targetPos.x + n.x * halfExtent) - center.x;
    object.position.y += (targetPos.y + n.y * halfExtent) - center.y;
    object.position.z += (targetPos.z + n.z * halfExtent) - center.z;
  }

  object.updateMatrixWorld(true);
  return _computeSafeWorldBounds(object);
}

export class AssetBrowserUI {
  constructor(container, options = {}) {
    this.container = typeof container === 'string' ? document.querySelector(container) : container;
    this.engine = options.engine || null;
    this.sceneManager = options.sceneManager || null;
    this.materialStudio = options.materialStudio || null;
    this.dataBlockRegistry = options.dataBlockRegistry || null;
    this.blobStore = options.blobStore || null;
    this.studio = options.studio || null;

    this.activeKind = 'all';
    this.activeCategory = 'all';
    this.searchQuery = '';
    this.activeTag = '';
    this.alignToNormal = false;
    this.pageSize = 60;
    this.visibleLimit = 60;
    this._thumbCache = new Map();
    this._localHandleMap = new Map();
    this._localFileMap = new Map();
    this._polyhavenMatCache = new Map();
    this.onlineItems = [];
    this.studioItems = [];
    this.communityItems = [];
    this.localItems = [];
    this.fabItems = FAB_CATALOG;
    this.onlineError = null;

    this._activated = false;
    this._onlineLoaded = false;
    this._catalogLoading = false;

    this._initUI();
    this._bindViewportDrop();
  }

  activate() {
    if (!this._activated) {
      this._activated = true;
      this.render();
    }
    if (!this._onlineLoaded && !this._catalogLoading) {
      this._catalogLoading = true;
      Promise.allSettled([
        this._loadOnline().then(() => { this._onlineLoaded = true; }),
        this._loadCommunity(),
      ]).finally(() => {
        this._catalogLoading = false;
      });
    }
  }

  async _loadOnline() {
    try {
      const [khronos, studioCatalog] = await Promise.all([
        loadOnlineCatalog().catch((e) => { throw e; }),
        loadStudioCatalog().catch(() => []),
      ]);
      const builtIn = [];
      const polyHaven = [];
      for (const item of studioCatalog) {
        if (item.kind === 'studio') builtIn.push(item);
        else polyHaven.push(item);
      }
      // Keep verified Khronos CC0 + CC-BY items first, followed by 2,390 Poly Haven CC0 studio assets
      this.studioItems = builtIn;
      this.onlineItems = [...khronos, ...polyHaven];
      this.onlineError = null;
    } catch (err) {
      this.onlineItems = [];
      this.onlineError = String(err && err.message || err);
    }
    this.render();
  }

  async _loadCommunity() {
    try {
      const cloud = (typeof window !== 'undefined' && window.app?.cloud) || null;
      if (cloud && typeof cloud.listCommunity === 'function') {
        const res = await cloud.listCommunity({ limit: 48 });
        this.communityItems = (res.items || []).map((it) => ({
          ...it,
          id: `comm_${it.id}`,
          name: it.title || it.name,
          thumb: it.thumbUrl ? cloud.absoluteUrl(it.thumbUrl) : '',
          url: it.url ? cloud.absoluteUrl(it.url) : '',
          license: 'Community CC',
          author: it.authorName || 'Community Creator',
          kind: 'community',
          studioCategory: it.category || 'scenes',
          tags: [...(it.tags || []), it.category || 'community', 'supabase'],
        }));
      } else if (typeof fetch === 'function') {
        const res = await fetch('/api/cloud/community?limit=48');
        if (res.ok) {
          const data = await res.json();
          this.communityItems = (data.items || []).map((it) => ({
            ...it,
            id: `comm_${it.id}`,
            name: it.title || it.name,
            thumb: it.thumbUrl || '',
            license: 'Community CC',
            author: it.authorName || 'Community Creator',
            kind: 'community',
            studioCategory: it.category || 'scenes',
            tags: [...(it.tags || []), it.category || 'community', 'supabase'],
          }));
        }
      }
    } catch (_) {
      this.communityItems = [];
    }
    this.render();
  }

  async _pickLocalDirectory() {
    const status = this.rootEl?.querySelector('#ab-status');
    if (typeof window === 'undefined' || typeof window.showDirectoryPicker !== 'function') {
      if (status) status.textContent = 'Trình duyệt không hỗ trợ File System Access — mở hộp chọn file để thêm vào Local.';
      this.rootEl?.querySelector('#ab-local-file-input')?.click();
      return;
    }
    try {
      const handle = await window.showDirectoryPicker({ mode: 'read' });
      this.localItems = await scanLocalDirectory(handle);
      this._localHandleMap.clear();
      for (const it of this.localItems) {
        if (it.handle) this._localHandleMap.set(it.id, it.handle);
      }
      if (status) status.textContent = `Thư mục cục bộ: ${this.localItems.length} file hợp lệ (.glb/.gltf/.vrm/.fbx/.obj). Double-click hoặc kéo thả để import.`;
    } catch (err) {
      if (status && err && err.name !== 'AbortError') status.textContent = `Không mở được thư mục: ${err.message}`;
    }
    this.render();
  }

  _showCredits() {
    const root = this.sceneManager?.rootContainer;
    let pop = this.rootEl?.querySelector('#ab-credits-pop');
    if (pop) { pop.remove(); return; }
    pop = document.createElement('div');
    pop.id = 'ab-credits-pop';
    pop.style.cssText = 'position:absolute;right:10px;top:34px;z-index:60;max-width:420px;max-height:260px;overflow:auto;'
      + 'background:#16181d;border:1px solid #3d424e;border-radius:6px;padding:10px;color:#ddd;font-size:11px;white-space:pre-wrap;';
    pop.textContent = `Attribution / Credits:\n${formatCredits(root)}\n\n${FAB_LICENSE_NOTE}`;
    this.rootEl.style.position = 'relative';
    this.rootEl.appendChild(pop);
  }

  async _importUserFile(file, item) {
    const exporter = (typeof window !== 'undefined' ? window.app?.exporter : null) || this.exporter;
    if (!exporter) throw new Error('Exporter chưa sẵn sàng');
    const placed = await importAssetFile(file, { exporter });
    recordCredit(this.sceneManager?.rootContainer, {
      id: item?.id || `file_${file.name}`,
      name: item?.name || file.name,
      author: item?.author || 'Người dùng tự acquire (Fab / tự tạo)',
      license: item?.license || 'User-owned',
      source: item?.kind === 'online' ? (item.source || 'online') : (item?.kind || 'local'),
      url: item?.url || null,
    });
    this.engine?.render?.();
    return placed;
  }

  _initUI() {
    if (!this.container) return;
    this.container.innerHTML = '';

    const root = document.createElement('div');
    root.id = 'asset-browser-root';
    root.style.cssText = 'display:flex;flex-direction:column;width:100%;height:100%;background:#1b1d22;color:#ddd;font-size:11px;';

    const catButtons = STUDIO_CATEGORIES.map(
      (c, i) => `<button type="button" class="uv-btn${i === 0 ? ' active' : ''}" data-cat="${c.id}" style="font-size:10px;padding:2px 7px;">${c.label}</button>`
    ).join('');

    root.innerHTML = `
      <div style="display:flex;align-items:center;gap:6px;padding:6px 10px;background:#242730;border-bottom:1px solid #353945;flex-wrap:wrap;">
        <span style="font-weight:600;color:#fff;">Asset Browser</span>
        <input id="ab-search-input" type="search" placeholder="Search materials, landscapes, trees, props…" style="width:190px;height:22px;background:#16181d;color:#eee;border:1px solid #3d424e;border-radius:3px;padding:0 6px;font-size:11px;">
        <div id="ab-kind-tabs" style="display:flex;gap:3px;flex-wrap:wrap;">
          <button type="button" class="uv-btn active" data-kind="all">All</button>
          <button type="button" class="uv-btn" data-kind="materials">Materials</button>
          <button type="button" class="uv-btn" data-kind="shaders">Shaders</button>
          <button type="button" class="uv-btn" data-kind="prefabs">Prefabs</button>
          <button type="button" class="uv-btn" data-kind="primitives">Primitives</button>
          <button type="button" class="uv-btn" data-kind="images">Images</button>
          <button type="button" class="uv-btn" data-kind="online">Online CC0/BY</button>
          <button type="button" class="uv-btn" data-kind="studio">Built-in</button>
          <button type="button" class="uv-btn" data-kind="community">Community 🌐</button>
          <button type="button" class="uv-btn" data-kind="local">Local</button>
          <button type="button" class="uv-btn" data-kind="fab">Fab ↗</button>
        </div>
        <label style="margin-left:auto;display:inline-flex;align-items:center;gap:4px;cursor:pointer;" title="Bật để xoay đồ vật/primitive nghiêng theo pháp tuyến bề mặt khi kéo thả">
          <input type="checkbox" id="ab-align-normal"> Align Drop to Normal
        </label>
        <button type="button" id="ab-local-btn" class="uv-btn" title="Trỏ vào thư mục chứa file bạn đã tải (Fab…) — import một click, không chuyển tab">📁 Thư mục cục bộ</button>
        <button type="button" id="ab-import-btn" class="uv-btn" title="Import trực tiếp nhiều file 3D từ máy (fallback cho Safari/Firefox)">📥 Import…</button>
        <button type="button" id="ab-credits-btn" class="uv-btn" title="Attribution bắt buộc cho asset CC-BY và điều khoản Fab">Credits</button>
        <button type="button" id="ab-refresh-btn" class="uv-btn">Refresh</button>
      </div>
      <div id="ab-cat-tabs" style="display:flex;align-items:center;gap:4px;padding:4px 10px;background:#1e2129;border-bottom:1px solid #2b2f3a;flex-wrap:wrap;">
        <span style="color:#8b9096;font-size:10px;margin-right:2px;">Danh mục:</span>
        ${catButtons}
        <span id="ab-count" style="margin-left:auto;color:#9ca3af;font-size:10px;"></span>
      </div>
      <div id="ab-status" style="padding:3px 10px;color:#9ca3af;font-size:10px;border-bottom:1px solid #2b2f3a;"></div>
      <input type="file" id="ab-user-file-input" accept="${LOCAL_EXTENSIONS.map((e) => `.${e}`).join(',')}" style="display:none;">
      <input type="file" id="ab-local-file-input" multiple accept="${LOCAL_EXTENSIONS.map((e) => `.${e}`).join(',')}" style="display:none;">
      <div id="ab-grid" style="flex:1;overflow-y:auto;padding:8px 10px;display:grid;grid-template-columns:repeat(auto-fill,minmax(112px,1fr));gap:8px;align-content:start;"></div>
    `;

    this.container.appendChild(root);
    this.rootEl = root;
    this.gridEl = root.querySelector('#ab-grid');

    root.querySelector('#ab-search-input')?.addEventListener('input', (e) => {
      this.searchQuery = e.target.value;
      this.visibleLimit = this.pageSize;
      this.render();
    });
    root.querySelectorAll('#ab-kind-tabs button').forEach((btn) => {
      btn.addEventListener('click', () => {
        root.querySelectorAll('#ab-kind-tabs button').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        this.activeKind = btn.dataset.kind;
        this.visibleLimit = this.pageSize;
        this.render();
      });
    });
    root.querySelectorAll('#ab-cat-tabs button').forEach((btn) => {
      btn.addEventListener('click', () => {
        root.querySelectorAll('#ab-cat-tabs button').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        this.activeCategory = btn.dataset.cat;
        this.visibleLimit = this.pageSize;
        this.render();
      });
    });
    root.querySelector('#ab-align-normal')?.addEventListener('change', (e) => {
      this.alignToNormal = e.target.checked;
    });
    root.querySelector('#ab-refresh-btn')?.addEventListener('click', () => {
      this._loadCommunity();
      this.render();
    });
    root.querySelector('#ab-local-btn')?.addEventListener('click', () => this._pickLocalDirectory());
    root.querySelector('#ab-import-btn')?.addEventListener('click', () => root.querySelector('#ab-local-file-input')?.click());
    root.querySelector('#ab-credits-btn')?.addEventListener('click', () => this._showCredits());
    const localFilesInput = root.querySelector('#ab-local-file-input');
    localFilesInput?.addEventListener('change', async () => {
      const files = Array.from(localFilesInput.files || []);
      localFilesInput.value = '';
      if (!files.length) return;
      const items = createLocalItemsFromFiles(files);
      for (const it of items) {
        if (it.file) this._localFileMap.set(it.id, it.file);
      }
      this.localItems = [...items, ...(this.localItems || []).filter((x) => !items.some((y) => y.id === x.id))];
      const status = root.querySelector('#ab-status');
      if (files.length === 1 && items[0]) {
        try {
          await this._importUserFile(files[0], items[0]);
          if (status) status.textContent = `Đã import ${files[0].name}.`;
        } catch (err) {
          if (status) status.textContent = `Import thất bại: ${err.message}`;
        }
      } else if (status) {
        status.textContent = `Đã thêm ${items.length} file vào mục Local.`;
      }
      this.render();
    });
    const userInput = root.querySelector('#ab-user-file-input');
    userInput?.addEventListener('change', async () => {
      const file = userInput.files && userInput.files[0];
      userInput.value = '';
      if (!file) return;
      const status = root.querySelector('#ab-status');
      try {
        await this._importUserFile(file, this._pendingFabItem || null);
        if (status) status.textContent = `Đã import ${file.name} (file của bạn).`;
      } catch (err) {
        if (status) status.textContent = `Import thất bại: ${err.message}`;
      }
      this._pendingFabItem = null;
    });

    if (typeof window !== 'undefined') {
      window.addEventListener('blender:textureUpdated', () => this.render());
      window.addEventListener('blender:communityUpdated', () => this._loadCommunity());
    }
  }

  _setStatus(msg) {
    const status = this.rootEl?.querySelector('#ab-status');
    if (status) status.textContent = msg;
  }

  _getThumbnailDataUrl(item) {
    if (this._thumbCache.has(item.id)) return this._thumbCache.get(item.id);
    if (typeof document === 'undefined') return null;

    const c = document.createElement('canvas');
    c.width = 72;
    c.height = 72;
    const ctx = c.getContext('2d');
    if (!ctx) return null;

    if (item.kind === 'materials') {
      const col = new THREE.Color(item.color ?? 0x8892a0);
      const hex = `#${col.getHexString()}`;
      const grad = ctx.createRadialGradient(24, 22, 4, 36, 36, 30);
      grad.addColorStop(0, '#ffffff');
      grad.addColorStop(0.45, hex);
      grad.addColorStop(1, '#111318');
      ctx.fillStyle = '#14161b';
      ctx.fillRect(0, 0, 72, 72);
      ctx.beginPath();
      ctx.arc(36, 36, 26, 0, Math.PI * 2);
      ctx.fillStyle = grad;
      ctx.fill();
    } else if (item.kind === 'shaders') {
      const img = ctx.createImageData(72, 72);
      for (let y = 0; y < 72; y++) {
        for (let x = 0; x < 72; x++) {
          const n = evalFbmNoiseCPU(x / 72, y / 72, 5, 4, 0.55, 42);
          const v = Math.round(n * 255);
          const idx = (y * 72 + x) * 4;
          img.data[idx] = item.presetKey === 'fresnel_rim' ? Math.min(255, v + 60) : v;
          img.data[idx + 1] = v;
          img.data[idx + 2] = item.presetKey === 'fresnel_rim' ? 230 : Math.max(0, v - 15);
          img.data[idx + 3] = 255;
        }
      }
      ctx.putImageData(img, 0, 0);
    } else {
      ctx.fillStyle = '#161922';
      ctx.fillRect(0, 0, 72, 72);
      ctx.strokeStyle = item.kind === 'prefabs' || item.kind === 'studio' ? '#f59e0b'
        : item.kind === 'community' ? '#10b981' : '#38bdf8';
      ctx.lineWidth = 2;
      ctx.strokeRect(16, 16, 40, 40);
      ctx.fillStyle = '#94a3b8';
      ctx.font = 'bold 10px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText((item.phType || item.kind || '3D').slice(0, 5).toUpperCase(), 36, 40);
    }

    const url = c.toDataURL('image/png');
    this._thumbCache.set(item.id, url);
    return url;
  }

  _createLightweightThumbElement(item) {
    const wrap = document.createElement('div');
    wrap.style.cssText = 'width:56px;height:56px;border-radius:4px;pointer-events:none;background:#161922;display:flex;align-items:center;justify-content:center;flex-shrink:0;';
    if (item.kind === 'materials') {
      const col = new THREE.Color(item.color ?? 0x8892a0);
      const hex = `#${col.getHexString()}`;
      const bg = item.swatch || `radial-gradient(circle at 32% 28%, #ffffff 0%, ${hex} 48%, #111318 100%)`;
      const sphere = document.createElement('div');
      sphere.style.cssText = `width:42px;height:42px;border-radius:50%;background:${bg};box-shadow:inset -2px -3px 6px rgba(0,0,0,0.45),0 2px 4px rgba(0,0,0,0.35);`;
      wrap.appendChild(sphere);
    } else if (item.kind === 'shaders') {
      wrap.style.background = item.presetKey === 'fresnel_rim'
        ? 'radial-gradient(circle at 35% 30%, #93c5fd, #3b82f6 52%, #172554 100%)'
        : 'radial-gradient(circle at 40% 40%, #cbd5e1, #64748b 55%, #1e293b 100%)';
    } else {
      const accent = item.kind === 'prefabs' || item.kind === 'studio'
        ? '#f59e0b'
        : (item.kind === 'community' ? '#10b981' : '#38bdf8');
      const box = document.createElement('div');
      box.style.cssText = `width:34px;height:34px;border:2px solid ${accent};display:flex;align-items:center;justify-content:center;color:#94a3b8;font:bold 9px/1 sans-serif;letter-spacing:0.3px;`;
      box.textContent = (item.phType || item.kind || '3D').slice(0, 5).toUpperCase();
      wrap.appendChild(box);
    }
    return wrap;
  }

  render() {
    if (!this.gridEl) return;
    if (!this._activated) {
      this.activate();
      return;
    }
    this._bindViewportDrop();
    const all = buildAssetCatalog({
      materialStudio: this.materialStudio,
      dataBlockRegistry: this.dataBlockRegistry,
      online: this.onlineItems,
      studio: this.studioItems,
      community: this.communityItems,
      local: this.localItems,
      fab: this.fabItems,
    });
    const list = filterAssetCatalog(all, {
      query: this.searchQuery,
      kind: this.activeKind,
      category: this.activeCategory,
      tag: this.activeTag,
    });

    const visible = list.slice(0, this.visibleLimit);
    const countEl = this.rootEl?.querySelector('#ab-count');
    if (countEl) {
      countEl.textContent = `${visible.length} / ${list.length} mục`;
    }

    const status = this.rootEl?.querySelector('#ab-status');
    if (status && !status.textContent) {
      status.textContent = this.onlineError
        ? `Catalog online offline: ${this.onlineError}. Mục Local/Fab vẫn dùng được.`
        : 'Click đúp hoặc kéo thả vào Viewport để dùng ngay (Chất liệu PBR, Cây cỏ, Phong cảnh HDRI, Cộng đồng). Fab ↗ mở trang Epic để bạn tự tải về.';
    }

    this.gridEl.innerHTML = '';
    for (const item of visible) {
      const card = document.createElement('div');
      card.className = 'ab-asset-card';
      card.draggable = item.kind !== 'fab';
      card.dataset.assetId = item.id;
      card.title = item.kind === 'fab'
        ? `${item.name} — ${FAB_LICENSE_NOTE}`
        : `${item.name} (${item.studioCategory || item.kind}) — Double-click or Drag onto 3D Viewport`;
      card.style.cssText = 'display:flex;flex-direction:column;align-items:center;padding:6px;background:#23262f;border:1px solid #343845;border-radius:5px;cursor:grab;text-align:center;gap:4px;';

      if (item.thumb) {
        const img = document.createElement('img');
        img.src = item.thumb;
        img.loading = 'lazy';
        img.style.cssText = 'width:56px;height:56px;border-radius:4px;pointer-events:none;object-fit:cover;background:#161922;';
        img.addEventListener('error', () => {
          img.replaceWith(this._createLightweightThumbElement(item));
        }, { once: true });
        card.appendChild(img);
      } else {
        card.appendChild(this._createLightweightThumbElement(item));
      }

      const title = document.createElement('div');
      title.textContent = item.name;
      title.style.cssText = 'font-size:10.5px;color:#eee;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;width:100%;';
      card.appendChild(title);

      const badge = document.createElement('div');
      badge.textContent = item.phType
        ? `${item.phType.toUpperCase()} · ${item.license || 'CC0'}`
        : (item.license || item.kind);
      badge.style.cssText = 'font-size:9px;color:#9ca3af;text-transform:uppercase;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;width:100%;';
      card.appendChild(badge);

      if (item.kind === 'fab') {
        const row = document.createElement('div');
        row.style.cssText = 'display:flex;gap:4px;width:100%;';
        const link = document.createElement('a');
        link.href = item.productUrl;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.textContent = 'Acquire ↗';
        link.className = 'uv-btn';
        link.style.cssText = 'flex:1;text-decoration:none;text-align:center;';
        const imp = document.createElement('button');
        imp.type = 'button';
        imp.className = 'uv-btn';
        imp.textContent = 'Import…';
        imp.style.cssText = 'flex:1;';
        imp.addEventListener('click', (e) => {
          e.stopPropagation();
          this._pendingFabItem = item;
          this.rootEl.querySelector('#ab-user-file-input')?.click();
        });
        row.appendChild(link);
        row.appendChild(imp);
        card.appendChild(row);
      }

      card.addEventListener('dragstart', (e) => {
        if (!this._dragItemMap) this._dragItemMap = new Map();
        this._dragItemMap.set(item.id, item);
        if (item.handle) this._localHandleMap?.set(item.id, item.handle);
        if (item.file) this._localFileMap?.set(item.id, item.file);
        e.dataTransfer?.setData('application/x-wbs-asset', JSON.stringify({ id: item.id, kind: item.kind, name: item.name }));
        e.dataTransfer?.setData('text/plain', String(item.id || ''));
      });

      card.addEventListener('dblclick', () => {
        this.applyOrSpawnAsset(item).catch((err) => {
          this._setStatus(`Lỗi nạp "${item.name}": ${err?.message || err}`);
        });
      });
      this.gridEl.appendChild(card);
    }

    if (list.length > visible.length) {
      const moreWrap = document.createElement('div');
      moreWrap.style.cssText = 'grid-column:1 / -1;display:flex;justify-content:center;padding:8px 0;';
      const moreBtn = document.createElement('button');
      moreBtn.type = 'button';
      moreBtn.className = 'uv-btn';
      moreBtn.textContent = `Xem thêm (+${Math.min(this.pageSize, list.length - visible.length)} / còn ${list.length - visible.length})`;
      moreBtn.addEventListener('click', () => {
        this.visibleLimit += this.pageSize;
        this.render();
      });
      moreWrap.appendChild(moreBtn);
      this.gridEl.appendChild(moreWrap);
    }
  }

  _resolveImageDataBlockTexture(block, root, item = null) {
    if (block?.texture?.isTexture) return block.texture;
    if (block?.data?.isTexture) return block.data;
    const targetTexUuid = block?.textureUuid || item?.textureUuid || null;
    const targetImgUuid = block?.imageUuid || item?.imageUuid || null;
    if (!targetTexUuid && !targetImgUuid) return null;
    const SLOTS = [
      'map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'emissiveMap', 'bumpMap',
      'alphaMap', 'displacementMap', 'envMap', 'clearcoatMap', 'clearcoatNormalMap',
      'clearcoatRoughnessMap', 'sheenColorMap', 'sheenRoughnessMap',
      'specularIntensityMap', 'specularColorMap', 'transmissionMap', 'thicknessMap',
    ];
    const roots = [root, this.sceneManager?.scene, this.engine?.scene].filter((r) => r && typeof r.traverse === 'function');
    let found = null;
    const matchTex = (t) => t && t.isTexture && (
      (targetTexUuid && t.uuid === targetTexUuid) ||
      (targetImgUuid && (t.image?.uuid === targetImgUuid || t.uuid === targetImgUuid))
    );
    for (const r of roots) {
      if (matchTex(r.environment)) return r.environment;
      if (matchTex(r.background)) return r.background;
      r.traverse((obj) => {
        if (found) return;
        const mats = obj.material ? (Array.isArray(obj.material) ? obj.material : [obj.material]) : [];
        for (const m of mats) {
          if (!m) continue;
          for (const s of SLOTS) {
            if (matchTex(m[s])) {
              found = m[s];
              return;
            }
          }
        }
      });
      if (found) break;
    }
    return found;
  }

  _ensureMaterialShadingVisible() {
    if (typeof window === 'undefined') return;
    if (window.matcapStudio?.isMatCapActive) {
      if (typeof window.app?.setShadingMode === 'function') {
        window.app.setShadingMode('material');
      } else {
        window.matcapStudio.toggleMatCapMode(false);
      }
    }
  }

  async applyOrSpawnAsset(item, dropInfo = null) {
    if (!item) return null;
    const sm = this.sceneManager || (typeof window !== 'undefined' ? window.sceneManager : null);
    const safeDropTarget = (dropInfo?.targetMesh && !isSystemOrHelperObject(dropInfo.targetMesh))
      ? dropInfo.targetMesh
      : null;

    if (item.kind === 'materials' && this.materialStudio) {
      const target = safeDropTarget || sm?.getActiveObject();
      if (!target || isSystemOrHelperObject(target)) return null;
      this._ensureMaterialShadingVisible();
      const targetMeshes = [];
      if (target.isMesh) targetMeshes.push(target);
      else target.traverse?.((c) => { if (c.isMesh && !isSystemOrHelperObject(c)) targetMeshes.push(c); });
      for (const m of targetMeshes) ensureGeometryUVs(m.geometry);
      const mat = this.materialStudio.applyPreset(target, item.key);
      if (typeof window !== 'undefined' && window.inspector) window.inspector.update(target);
      this.engine?.requestRender?.();
      this.engine?.render?.();
      this._setStatus(`Đã áp dụng chất liệu "${item.name}" lên "${target.name || 'Object'}".`);
      return mat;
    }

    if (item.kind === 'images' && this.dataBlockRegistry) {
      const block = this.dataBlockRegistry.get?.('images', item.blockId);
      const tex = this._resolveImageDataBlockTexture(block, sm?.rootContainer || sm?.scene || this.engine?.scene, item);
      if (!tex) return null;
      const target = safeDropTarget || sm?.getActiveObject();
      const meshes = [];
      if (target && !isSystemOrHelperObject(target)) {
        if (target.isMesh) meshes.push(target);
        else target.traverse?.((c) => { if (c.isMesh && !isSystemOrHelperObject(c)) meshes.push(c); });
      }
      this._ensureMaterialShadingVisible();
      const mat = new THREE.MeshStandardMaterial({
        name: item.name || 'Image_Material',
        map: tex,
        roughness: 0.6,
        metalness: 0.0,
      });
      if (meshes.length > 0) {
        for (const m of meshes) {
          ensureGeometryUVs(m.geometry);
          if (m.userData?.__originalMaterial) m.userData.__originalMaterial = mat;
          m.material = mat;
          m.material.needsUpdate = true;
        }
        if (typeof window !== 'undefined' && window.inspector) window.inspector.update(target);
      } else {
        const plane = new THREE.Mesh(new THREE.PlaneGeometry(1.6, 1.6), mat);
        plane.name = item.name || 'Image_Plane';
        sm?.addObject(plane);
        normalizeAndPlaceAsset(plane, {
          dropInfo,
          category: 'props',
          normalizeScale: false,
          alignToNormal: this.alignToNormal,
          sceneManager: sm,
        });
        sm?.select?.(plane);
        this.engine?.updateSelectionHelper?.();
      }
      this.engine?.requestRender?.();
      this.engine?.render?.();
      this._setStatus(`Đã áp dụng ảnh "${item.name}".`);
      return mat;
    }

    if (item.kind === 'shaders') {
      const target = safeDropTarget || sm?.getActiveObject();
      if (!target || isSystemOrHelperObject(target)) return null;
      let mesh = target?.isMesh ? target : null;
      if (!mesh && target?.traverse) target.traverse((c) => { if (!mesh && c.isMesh && !isSystemOrHelperObject(c)) mesh = c; });
      if (!mesh) return null;
      this._ensureMaterialShadingVisible();
      if (!mesh.material || (Array.isArray(mesh.material) && !mesh.material[0])) {
        mesh.material = new THREE.MeshPhysicalMaterial({ color: 0xffffff });
      }
      const mat = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
      const g = ShaderGraph.createDefault();
      if (item.presetKey === 'procedural_stone') {
        const bsdf = Array.from(g.nodes.values()).find((n) => n.type === 'PrincipledBSDF');
        const noise = g.addNode('NoiseTexture', 80, 60, { scale: 9, detail: 5 });
        const ramp = g.addNode('ColorRamp', 220, 40, { stops: [{ pos: 0.25, color: '#2b2d34' }, { pos: 0.9, color: '#d0d5dd' }] });
        const bump = g.addNode('Bump', 220, 200, { strength: 0.65, distance: 0.12 });
        g.connect(noise.id, 'fac', ramp.id, 'fac');
        g.connect(ramp.id, 'color', bsdf.id, 'baseColor');
        g.connect(noise.id, 'fac', bump.id, 'height');
        g.connect(bump.id, 'normal', bsdf.id, 'normal');
      } else if (item.presetKey === 'fresnel_rim') {
        const bsdf = Array.from(g.nodes.values()).find((n) => n.type === 'PrincipledBSDF');
        const vor = g.addNode('VoronoiTexture', 80, 60, { scale: 12 });
        const fres = g.addNode('Fresnel', 80, 200, { ior: 1.55 });
        const mix = g.addNode('Mix', 240, 80, { a: '#1d4ed8', b: '#f43f5e' });
        g.connect(fres.id, 'fac', mix.id, 'fac');
        g.connect(vor.id, 'color', mix.id, 'a');
        g.connect(mix.id, 'result', bsdf.id, 'baseColor');
      }
      applyShaderGraphToMaterial(mat, g, { forceRecompile: true });
      if (typeof window !== 'undefined' && window.shaderEditor) window.shaderEditor.syncFromSelection();
      this.engine?.requestRender?.();
      this.engine?.render?.();
      return g;
    }

    if (item.kind === 'primitives') {
      const geoMap = {
        cube: () => new THREE.BoxGeometry(1, 1, 1),
        sphere: () => new THREE.SphereGeometry(0.6, 32, 24),
        cylinder: () => new THREE.CylinderGeometry(0.5, 0.5, 1.2, 24),
        cone: () => new THREE.ConeGeometry(0.6, 1.2, 24),
        torus: () => new THREE.TorusGeometry(0.5, 0.2, 16, 36),
        plane: () => { const g = new THREE.PlaneGeometry(2, 2); g.rotateX(-Math.PI / 2); return g; },
      };
      const mk = geoMap[item.prim] || geoMap.cube;
      const mesh = new THREE.Mesh(mk(), new THREE.MeshStandardMaterial({ color: 0xcccccc, roughness: 0.55 }));
      mesh.name = item.name;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      sm?.addObject(mesh);
      normalizeAndPlaceAsset(mesh, {
        dropInfo,
        category: 'primitives',
        normalizeScale: false,
        alignToNormal: this.alignToNormal,
        sceneManager: sm,
      });
      sm?.select?.(mesh);
      this.engine?.updateSelectionHelper?.();
      this.engine?.requestRender?.();
      this.engine?.render?.();
      return mesh;
    }

    if (item.kind === 'prefabs' && item.prefabId) {
      const placed = await prefabLibrary.place(item.prefabId, { x: 0, y: 0, z: 0 });
      if (placed) {
        normalizeAndPlaceAsset(placed, {
          dropInfo,
          category: item.studioCategory || 'characters',
          normalizeScale: false,
          alignToNormal: this.alignToNormal,
          sceneManager: sm,
        });
        recordCredit(sm?.rootContainer, {
          id: item.id,
          name: item.name || item.prefabId,
          author: item.author || 'Hunger',
          license: item.license || 'Built-in / Rigged Prefab',
          source: 'prefabs',
          url: item.url || null,
        });
        sm?.select?.(placed);
        this.engine?.updateSelectionHelper?.();
      }
      this.engine?.requestRender?.();
      this.engine?.render?.();
      return placed;
    }

    // Dynamic Poly Haven CC0 resolution (Model GLTF, PBR Texture Material, or HDRI Environment)
    if (item.polyhavenId && item.phType) {
      this._setStatus(`Đang nạp "${item.name}" (${item.phType}, CC0)…`);
      const resolved = await resolvePolyHavenAsset(item.polyhavenId, item.phType);

      if (resolved.phType === 'hdri') {
        const envStudio = typeof window !== 'undefined' ? window.app?.environmentStudio : null;
        if (envStudio && typeof envStudio.loadHDRFile === 'function') {
          envStudio.showHdriBackground = true;
          await envStudio.loadHDRFile(resolved.hdrUrl);
        } else {
          const isExr = String(resolved.hdrUrl || '').split('?')[0].toLowerCase().endsWith('.exr');
          const { EXRLoader } = isExr ? await import('three/addons/loaders/EXRLoader.js') : {};
          const { RGBELoader } = isExr ? {} : await import('three/addons/loaders/RGBELoader.js');
          const loader = isExr ? new EXRLoader() : new RGBELoader();
          loader.setCrossOrigin('anonymous');
          const hdrTex = await loader.loadAsync(resolved.hdrUrl);
          hdrTex.mapping = THREE.EquirectangularReflectionMapping;
          const scene = sm?.scene || this.engine?.scene;
          if (scene) {
            scene.environment = hdrTex;
            scene.background = hdrTex;
            scene.userData = scene.userData || {};
            scene.userData.rawEnvironmentSource = hdrTex;
          }
        }
        recordCredit(sm?.rootContainer, {
          id: item.id, name: item.name, author: item.author || 'Poly Haven',
          license: item.license || 'CC0-1.0', source: 'polyhaven', url: resolved.hdrUrl,
        });
        this.engine?.render?.();
        this._setStatus(`Đã áp dụng HDRI "${item.name}" (CC0).`);
        return resolved.hdrUrl;
      }

      if (resolved.phType === 'texture') {
        let pbrMat = this._polyhavenMatCache?.get(item.polyhavenId)?.clone?.() || null;
        if (!pbrMat) {
          const texLoader = new THREE.TextureLoader();
          texLoader.setCrossOrigin('anonymous');
          const loadTexSafe = async (url, isColor) => {
            if (!url) return null;
            try {
              const tex = await texLoader.loadAsync(url);
              tex.wrapS = THREE.RepeatWrapping;
              tex.wrapT = THREE.RepeatWrapping;
              tex.repeat.set(2, 2);
              tex.colorSpace = isColor ? THREE.SRGBColorSpace : THREE.NoColorSpace;
              tex.needsUpdate = true;
              return tex;
            } catch (err) {
              console.warn(`[AssetBrowser] Optional texture failed (${url}):`, err?.message || err);
              return null;
            }
          };
          const [map, normalMap, roughnessMap, metalnessMap, aoMap, bumpMap] = await Promise.all([
            loadTexSafe(resolved.diffuseUrl, true),
            loadTexSafe(resolved.normalUrl, false),
            loadTexSafe(resolved.roughnessUrl, false),
            loadTexSafe(resolved.metalnessUrl, false),
            resolved.aoUrl && resolved.aoUrl !== resolved.roughnessUrl
              ? loadTexSafe(resolved.aoUrl, false)
              : Promise.resolve(null),
            loadTexSafe(resolved.bumpUrl, false),
          ]);
          const effectiveAoMap = aoMap || (resolved.aoUrl && resolved.aoUrl === resolved.roughnessUrl ? roughnessMap : null);
          if (effectiveAoMap && 'channel' in effectiveAoMap) effectiveAoMap.channel = 0;

          if (!map && !normalMap && !roughnessMap && !metalnessMap && !bumpMap) {
            throw new Error(`Không tải được map PBR nào cho "${item.name}".`);
          }

          const templateMat = new THREE.MeshStandardMaterial({
            name: item.name,
            color: 0xffffff,
            map: map || null,
            normalMap: normalMap || null,
            normalScale: resolved.normalFlipY ? new THREE.Vector2(1, -1) : new THREE.Vector2(1, 1),
            bumpMap: !normalMap ? (bumpMap || null) : null,
            bumpScale: 0.05,
            roughnessMap: roughnessMap || null,
            roughness: roughnessMap ? 1.0 : 0.75,
            metalnessMap: metalnessMap || null,
            metalness: metalnessMap ? 1.0 : 0.0,
            aoMap: effectiveAoMap || null,
            aoMapIntensity: effectiveAoMap ? 0.85 : 0.0,
          });
          this._polyhavenMatCache?.set(item.polyhavenId, templateMat);
          pbrMat = templateMat.clone();
        }

        let target = safeDropTarget || sm?.getActiveObject();
        if (target && isSystemOrHelperObject(target)) target = null;
        const targetMeshes = [];
        if (target) {
          if (target.isMesh) targetMeshes.push(target);
          else target.traverse?.((c) => { if (c.isMesh && !isSystemOrHelperObject(c)) targetMeshes.push(c); });
        }
        this._ensureMaterialShadingVisible();
        let inspectorTarget = target;
        if (targetMeshes.length === 0) {
          const sphere = new THREE.Mesh(new THREE.SphereGeometry(0.6, 36, 24), pbrMat);
          sphere.name = item.name;
          sphere.castShadow = true;
          sphere.receiveShadow = true;
          sm?.addObject(sphere);
          normalizeAndPlaceAsset(sphere, {
            dropInfo,
            category: 'props',
            normalizeScale: false,
            alignToNormal: this.alignToNormal,
            sceneManager: sm,
          });
          sm?.select?.(sphere);
          this.engine?.updateSelectionHelper?.();
          inspectorTarget = sphere;
        } else {
          for (const mesh of targetMeshes) {
            ensureGeometryUVs(mesh.geometry);
            if (mesh.userData?.__originalMaterial) {
              mesh.userData.__originalMaterial = pbrMat;
            }
            mesh.material = pbrMat;
            mesh.material.needsUpdate = true;
          }
        }
        if (typeof window !== 'undefined' && window.inspector) window.inspector.update(inspectorTarget);
        recordCredit(sm?.rootContainer, {
          id: item.id, name: item.name, author: item.author || 'Poly Haven',
          license: item.license || 'CC0-1.0', source: 'polyhaven', url: resolved.diffuseUrl || resolved.normalUrl,
        });
        this.engine?.requestRender?.();
        this.engine?.render?.();
        this._setStatus(`Đã áp dụng chất liệu PBR "${item.name}" (CC0).`);
        return pbrMat;
      }

      if (resolved.phType === 'model') {
        const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
        const manager = new THREE.LoadingManager();
        const include = resolved.gltfInclude || {};
        const entries = Object.entries(include);
        if (entries.length) {
          manager.setURLModifier((reqUrl) => {
            if (!reqUrl || /^data:|^blob:/i.test(reqUrl)) return reqUrl;
            const cleanReq = reqUrl.split('?')[0];
            for (const [relPath, meta] of entries) {
              if (meta?.url && (cleanReq === relPath || cleanReq.endsWith(`/${relPath}`) || cleanReq.endsWith(relPath))) {
                return meta.url;
              }
            }
            const base = cleanReq.split('/').pop();
            if (base) {
              for (const [relPath, meta] of entries) {
                if (meta?.url && relPath.split('/').pop() === base) return meta.url;
              }
            }
            return reqUrl;
          });
        }
        const loader = new GLTFLoader(manager);
        loader.setCrossOrigin('anonymous');
        const gltf = await loader.loadAsync(resolved.gltfUrl);
        const rootObj = gltf.scene || gltf.scenes[0];
        if (!rootObj) throw new Error('Mô hình GLTF rỗng.');
        rootObj.name = item.name || item.polyhavenId;
        let modelTris = 0;
        let hasSkinned = false;
        rootObj.traverse((c) => {
          if (c.isMesh) {
            c.castShadow = true;
            c.receiveShadow = true;
            if (c.isSkinnedMesh) hasSkinned = true;
            else ensureBVH(c);
            if (c.geometry?.attributes?.position) {
              const g = c.geometry;
              modelTris += g.index ? Math.floor(g.index.count / 3) : Math.floor(g.attributes.position.count / 3);
            }
            if (c.material && !c.userData?.__importedMaterial) {
              c.userData = c.userData || {};
              c.userData.__importedMaterial = Array.isArray(c.material)
                ? c.material.map((m) => m?.clone?.() || m)
                : (c.material.clone?.() || c.material);
            }
          }
        });
        sm?.addObject(rootObj);
        normalizeAndPlaceAsset(rootObj, {
          dropInfo,
          category: item.studioCategory || 'props',
          normalizeScale: true,
          alignToNormal: this.alignToNormal,
          sceneManager: sm,
        });
        if (modelTris >= 3500 && !hasSkinned && this.engine?.lodManager) {
          await this.engine.lodManager.enableAutoLOD(rootObj);
        }
        sm?.select?.(rootObj);
        this.engine?.updateSelectionHelper?.();
        recordCredit(sm?.rootContainer, {
          id: item.id, name: item.name, author: item.author || 'Poly Haven',
          license: item.license || 'CC0-1.0', source: 'polyhaven', url: resolved.gltfUrl,
        });
        this.engine?.requestRender?.();
        this.engine?.render?.();
        this._setStatus(`Đã thêm mô hình "${item.name}" vào Viewport (CC0).`);
        return rootObj;
      }
    }

    if ((item.kind === 'online' || item.kind === 'studio' || item.kind === 'community') && item.url) {
      this._setStatus(`Đang tải "${item.name}"…`);
      const res = await fetch(item.url);
      if (!res.ok) throw new Error(`Tải asset HTTP ${res.status}`);
      const blob = await res.blob();
      let name = item.url.split('/').pop()?.split('?')[0] || '';
      if (!/\.(glb|gltf|vrm|fbx|obj)$/i.test(name)) name = `${item.id || 'asset'}.${item.ext || 'glb'}`;
      const placed = await this._importUserFile(new File([blob], name, { type: 'model/gltf-binary' }), item);
      if (placed) {
        normalizeAndPlaceAsset(placed, {
          dropInfo,
          category: item.studioCategory || 'props',
          normalizeScale: true,
          alignToNormal: this.alignToNormal,
          sceneManager: sm,
        });
        this.engine?.updateSelectionHelper?.();
        this.engine?.requestRender?.();
        this.engine?.render?.();
      }
      this._setStatus(`Đã nạp "${item.name}".`);
      return placed;
    }

    if (item.kind === 'local') {
      const handle = item.handle || this._localHandleMap?.get(item.id);
      const localFile = item.file || this._localFileMap?.get(item.id) || (handle ? await handle.getFile() : null);
      if (!localFile) return null;
      const placed = await this._importUserFile(localFile, item);
      if (placed) {
        normalizeAndPlaceAsset(placed, {
          dropInfo,
          category: item.studioCategory || 'props',
          normalizeScale: true,
          alignToNormal: this.alignToNormal,
          sceneManager: sm,
        });
        this.engine?.updateSelectionHelper?.();
        this.engine?.requestRender?.();
        this.engine?.render?.();
      }
      return placed;
    }

    return null;
  }

  _bindViewportDrop() {
    const canvas = this.engine?.renderer?.domElement;
    if (!canvas) return;
    // Bind on the persistent host, not the canvas node: workspace splits can
    // replace the canvas element, which would silently detach these listeners.
    const host = canvas.parentElement || canvas;
    if (host._hasAssetDropBind) return;
    host._hasAssetDropBind = true;

    host.addEventListener('dragover', (e) => {
      if (e.dataTransfer?.types?.includes('application/x-wbs-asset')) {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
      }
    });

    host.addEventListener('drop', (e) => {
      const raw = e.dataTransfer?.getData('application/x-wbs-asset');
      if (!raw) return;
      e.preventDefault();
      e.stopPropagation();
      try {
        const parsed = JSON.parse(raw);
        const item = (parsed?.id && (
          this._dragItemMap?.get(parsed.id) ||
          this.localItems?.find((it) => it.id === parsed.id)
        )) || parsed;
        const ctx = this.engine.getViewportContextAtPoint(e.clientX, e.clientY);
        const rect = ctx.rect;
        const ndcX = ((e.clientX - rect.left) / rect.width) * 2 - 1;
        const ndcY = -((e.clientY - rect.top) / rect.height) * 2 + 1;
        const dropInfo = pickDropTransformOnScene(
          this.sceneManager?.scene || this.engine.scene,
          ctx.camera || this.engine.camera,
          ndcX,
          ndcY,
          this.alignToNormal
        );
        this.applyOrSpawnAsset(item, dropInfo).catch((err) => {
          console.warn('[AssetBrowser] Viewport drop apply failed:', err);
          this._setStatus(`Lỗi nạp "${item.name}": ${err?.message || err}`);
        });
      } catch (err) {
        console.warn('[AssetBrowser] Viewport drop failed:', err);
      }
    });
  }
}

export default AssetBrowserUI;
