/**
 * Web Blender Studio - Exporters & Importers Module
 * File: js/exporters/export-import.js
 * 
 * Features:
 * - OBJ Exporter (.obj) with vertices, vertex normals, texture coordinates, and faces.
 * - STL Exporter (.stl) supporting Binary (3D printing slicer standard) and ASCII formats.
 * - Project JSON Exporter/Importer (.blend.json / .web3d) saving complete hierarchy, transforms, materials, and lighting.
 * - High-Res Viewport Screenshot & Render to PNG with resolution multipliers (1x, 2x, 4x) and transparent background options.
 */

import * as THREE from 'three';
import { zipSync, unzipSync, strToU8, strFromU8 } from 'three/addons/libs/fflate.module.js';
import { encodeGeometry, decodeGeometry } from '../core/geometry/geometry-codec.js';
import { createImageObject, IMAGE_FILE_EXTENSIONS } from '../core/image-objects.js';
import {
  CURRENT_PROJECT_SCHEMA,
  migrateProjectData,
  dehydrateProjectBlobs,
  hydrateProjectBlobs,
} from '../core/project-migrator.js';
import { computeBlobRef, blobStore } from '../core/blob-store.js';
import { dataBlockRegistry } from '../core/data-blocks.js';
import { serializeScenePaintStacksSync, restoreScenePaintStacksSync } from '../core/paint-layers.js';
import { hydrateMaterialShaderGraphs } from '../core/shader-compiler-three.js';
import { exportSceneToFBX } from '../animation/fbx-exporter.js';
import { ThreeMFExporter } from './threemf-exporter.js';
import { ensureBVH } from '../core/bvh-accelerator.js';
import { indexGeometry } from '../core/geometry/parametric-cad.js';

export class StudioExporter {
  constructor(engineOrOptions = {}) {
    this._engine = null;
    this._scene = null;
    this._camera = null;
    this._renderer = null;
    this._sceneManager = null;
    this._timelineEngine = null;

    if (engineOrOptions.controls && engineOrOptions.scene && engineOrOptions.renderer) {
      this.bindEngine(engineOrOptions);
    } else if (engineOrOptions.scene) {
      this.init(engineOrOptions);
    } else if (engineOrOptions.renderer || engineOrOptions.container) {
      this.bindEngine(engineOrOptions);
    }
  }

  /**
   * Bind directly to an Engine instance
   */
  bindEngine(engine) {
    this._engine = engine;
    this._scene = engine.scene;
    this._camera = engine.camera;
    this._renderer = engine.renderer;
    this._sceneManager = engine.sceneManager || (typeof window !== 'undefined' ? window.sceneManager : null);
    return this;
  }

  /**
   * Bind SceneManager instance
   */
  bindSceneManager(sceneManager) {
    this._sceneManager = sceneManager;
    return this;
  }

  attachSceneManager(sceneManager) {
    this._sceneManager = sceneManager;
    return this;
  }

  /**
   * Initialize or update references
   */
  init({ scene, camera, renderer, sceneManager, timelineEngine, engine } = {}) {
    if (scene) this._scene = scene;
    if (camera) this._camera = camera;
    if (renderer) this._renderer = renderer;
    if (sceneManager) this._sceneManager = sceneManager;
    if (timelineEngine) this._timelineEngine = timelineEngine;
    if (engine) this._engine = engine;
    return this;
  }

  get scene() {
    if (this._scene) return this._scene;
    if (typeof window !== 'undefined') {
      if (window.studioEngine && window.studioEngine.scene) return window.studioEngine.scene;
      if (window.sceneManager && window.sceneManager.scene) return window.sceneManager.scene;
      if (window.app && window.app.scene) return window.app.scene;
      if (window.studio && window.studio.scene) return window.studio.scene;
      if (window.scene) return window.scene;
    }
    throw new Error('No Three.js Scene found for exporter.');
  }

  get camera() {
    if (this._engine?.camera) return this._engine.camera;
    if (this._camera) return this._camera;
    if (typeof window !== 'undefined') {
      if (window.studioEngine && window.studioEngine.camera) return window.studioEngine.camera;
      if (window.app && window.app.camera) return window.app.camera;
      if (window.studio && window.studio._camera) return window.studio._camera;
      if (window.camera) return window.camera;
    }
    throw new Error('No Camera found for rendering/export.');
  }

  get renderer() {
    if (this._renderer) return this._renderer;
    if (typeof window !== 'undefined') {
      if (window.studioEngine && window.studioEngine.renderer) return window.studioEngine.renderer;
      if (window.app && window.app.renderer) return window.app.renderer;
      if (window.studio && window.studio._renderer) return window.studio._renderer;
      if (window.renderer) return window.renderer;
    }
    throw new Error('No WebGLRenderer found for rendering/export.');
  }

  get sceneManager() {
    if (this._sceneManager) return this._sceneManager;
    if (typeof window !== 'undefined' && window.sceneManager) {
      return window.sceneManager;
    }
    return null;
  }

  /**
   * Resolve the active TimelineEngine regardless of headless/Node vs browser context.
   */
  _resolveTimelineEngine() {
    return (
      this._timelineEngine ||
      this._engine?.timelineEngine ||
      this._sceneManager?.timelineEngine ||
      (typeof window !== 'undefined' ? window.timelineEngine : null)
    );
  }

  /**
   * Filter out system objects, grid helpers, gizmos, transform controls
   */
  _isExportableMesh(obj) {
    if (!obj || !obj.isMesh) return false;
    if (obj.userData && (obj.userData.isHelper || obj.userData.selectable === false)) {
      return false;
    }
    if (obj.userData && obj.userData.isSystemObject) {
      return false;
    }
    if (obj.isGridHelper || obj.isCameraHelper || obj.isPointLightHelper || obj.isDirectionalLightHelper) {
      return false;
    }
    // Check parents for system tags (excluding Scene_Collection root container)
    let p = obj.parent;
    while (p) {
      if (p.isTransformControls || (p.userData && p.userData.isHelper)) {
        return false;
      }
      if (p.userData && p.userData.isSystemObject && p.name !== 'Scene_Collection') {
        return false;
      }
      p = p.parent;
    }
    return true;
  }

  /**
   * True for user-authored objects (including lights and cameras), false for
   * studio gizmos/grid/studio-lighting/helpers.
   */
  _isProjectObject(obj) {
    if (!obj || obj === this.scene) return false;
    const root = this.sceneManager?.rootContainer;
    let node = obj;
    while (node) {
      if (node.isTransformControls || node.isGridHelper || node.isCameraHelper ||
          node.isPointLightHelper || node.isDirectionalLightHelper || node.isSpotLightHelper) {
        return false;
      }
      if (node.userData?.isHelper) return false;
      if (node.userData?.isSystemObject && node !== root && node.name !== 'Scene_Collection') {
        return false;
      }
      node = node.parent;
    }
    return true;
  }

  /**
   * Object3D.toJSON() copies userData verbatim. Camera helpers and other
   * Object3D references inside userData would create circular JSON, so swap in
   * a plain clone for the duration of serialization and restore it after.
   */
  _withPlainUserData(root, run) {
    const restored = [];
    const seen = new WeakSet();
    const plain = (value, depth = 0) => {
      if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) return value;
      if (typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') return undefined;
      if (depth > 6) return undefined;
      if (Array.isArray(value)) {
        const list = value.map((item) => plain(item, depth + 1)).filter((item) => item !== undefined);
        return list;
      }
      if (typeof value === 'object') {
        if (value.isQuaternion && Number.isFinite(value.x) && Number.isFinite(value.y) && Number.isFinite(value.z) && Number.isFinite(value.w)) {
          return { __wbsType: 'Quaternion', x: value.x, y: value.y, z: value.z, w: value.w };
        }
        if (value.isEuler && Number.isFinite(value.x) && Number.isFinite(value.y) && Number.isFinite(value.z)) {
          return { __wbsType: 'Euler', x: value.x, y: value.y, z: value.z, order: value.order || 'XYZ' };
        }
        if (value.isVector3 && Number.isFinite(value.x) && Number.isFinite(value.y) && Number.isFinite(value.z)) {
          return { __wbsType: 'Vector3', x: value.x, y: value.y, z: value.z };
        }
        if (value.isColor && Number.isFinite(value.r) && Number.isFinite(value.g) && Number.isFinite(value.b)) {
          return { __wbsType: 'Color', r: value.r, g: value.g, b: value.b };
        }
        if (value.isObject3D || value.isTexture || value.isMaterial || value.isBufferGeometry ||
            value.isSkeleton || value.isMatrix4 || value.isMatrix3 ||
            ArrayBuffer.isView(value) || value instanceof ArrayBuffer ||
            (typeof Element !== 'undefined' && value instanceof Element)) {
          return undefined;
        }
        if (seen.has(value)) return undefined;
        seen.add(value);
        const out = {};
        for (const [key, item] of Object.entries(value)) {
          if (key.startsWith('_')) continue;
          const copy = plain(item, depth + 1);
          if (copy !== undefined) out[key] = copy;
        }
        seen.delete(value);
        return out;
      }
      return undefined;
    };

    root.traverse((object) => {
      const userData = object.userData;
      if (!userData || typeof userData !== 'object' || Object.keys(userData).length === 0) return;
      restored.push([object, userData]);
      object.userData = plain(userData) || {};
    });

    try {
      return run();
    } finally {
      restored.forEach(([object, userData]) => { object.userData = userData; });
    }
  }

  _rehydrateUserDataTypes(root) {
    if (!root || typeof root.traverse !== 'function') return;
    const rehydrate = (val, depth = 0) => {
      if (!val || typeof val !== 'object' || depth > 6) return val;
      if (Array.isArray(val)) {
        for (let i = 0; i < val.length; i += 1) val[i] = rehydrate(val[i], depth + 1);
        return val;
      }
      if (val.__wbsType === 'Quaternion') {
        return new THREE.Quaternion(val.x || 0, val.y || 0, val.z || 0, val.w ?? 1);
      }
      if (val.__wbsType === 'Euler') {
        return new THREE.Euler(val.x || 0, val.y || 0, val.z || 0, val.order || 'XYZ');
      }
      if (val.__wbsType === 'Vector3') {
        return new THREE.Vector3(val.x || 0, val.y || 0, val.z || 0);
      }
      if (val.__wbsType === 'Color') {
        return new THREE.Color(val.r || 0, val.g || 0, val.b || 0);
      }
      for (const [k, v] of Object.entries(val)) {
        val[k] = rehydrate(v, depth + 1);
      }
      return val;
    };
    root.traverse((node) => {
      if (node.userData && typeof node.userData === 'object') {
        rehydrate(node.userData);
        if (node.isBone) {
          const rq = node.userData.restQuat;
          if (rq && !rq.isQuaternion) {
            if (Number.isFinite(rq.x) && Number.isFinite(rq.y) && Number.isFinite(rq.z) && Number.isFinite(rq.w)) {
              node.userData.restQuat = new THREE.Quaternion(rq.x, rq.y, rq.z, rq.w);
            } else {
              delete node.userData.restQuat;
            }
          }
          const re = node.userData.restEuler;
          if (re && !re.isEuler) {
            if (Number.isFinite(re.x) && Number.isFinite(re.y) && Number.isFinite(re.z)) {
              node.userData.restEuler = new THREE.Euler(re.x, re.y, re.z, re.order || 'XYZ');
            } else {
              delete node.userData.restEuler;
            }
          }
          if (!node.userData.restQuat) {
            node.userData.restQuat = node.userData.restEuler
              ? new THREE.Quaternion().setFromEuler(node.userData.restEuler)
              : node.quaternion.clone();
          }
          if (!node.userData.restEuler) {
            node.userData.restEuler = new THREE.Euler().setFromQuaternion(node.userData.restQuat);
          }
          const rcq = node.userData.restCharQuat;
          if (rcq && !rcq.isQuaternion) {
            if (Number.isFinite(rcq.x) && Number.isFinite(rcq.y) && Number.isFinite(rcq.z) && Number.isFinite(rcq.w)) {
              node.userData.restCharQuat = new THREE.Quaternion(rcq.x, rcq.y, rcq.z, rcq.w);
            } else {
              delete node.userData.restCharQuat;
            }
          }
        }
      }
    });
  }

  _prepareExportState(root, mode = 'generic', { hideHelpers = true } = {}) {
    const rigSys = (typeof window !== 'undefined' && window.rigSystem) ? window.rigSystem : null;
    let savedWeightPaint = null;
    if (rigSys?.isWeightPaintMode) {
      savedWeightPaint = { mesh: rigSys.weightPaintMesh, bone: rigSys.activeBone };
      try { rigSys.disableWeightPaintMode(); } catch (_) {}
    }

    if (typeof window !== 'undefined') {
      try {
        window.dispatchEvent(new CustomEvent('blender:beforeExport', { detail: { target: root, mode } }));
      } catch (_) {}
    }

    const hiddenItems = [];
    const swappedMatcapMeshes = [];
    const swappedBoolMeshes = [];
    const strippedPreMaps = [];
    const isMatcapMat = (m) => Array.isArray(m)
      ? m.some((entry) => entry?.isMeshMatcapMaterial)
      : Boolean(m?.isMeshMatcapMaterial);

    if (root && typeof root.traverse === 'function') {
      root.traverse((node) => {
        if (hideHelpers && node !== root && node.name !== 'Scene_Collection' &&
            (node.isTransformControls || node.isGridHelper ||
             (node.userData && (node.userData.isHelper || (node.userData.isSystemObject && !node.children.length))))) {
          if (node.visible) {
            node.visible = false;
            hiddenItems.push(node);
          }
        }
        if (node.isMesh && node.userData?.__originalMaterial && isMatcapMat(node.material)) {
          swappedMatcapMeshes.push([node, node.material]);
          node.material = node.userData.__originalMaterial;
        }
        if (node.isMesh && node.userData?.__boolOrigMaterial) {
          swappedBoolMeshes.push([node, node.material]);
          node.material = node.userData.__boolOrigMaterial;
        }
        const mats = node.material ? (Array.isArray(node.material) ? node.material : [node.material]) : [];
        for (const m of mats) {
          if (m?.userData && '__preProceduralMaps' in m.userData) {
            strippedPreMaps.push([m.userData, m.userData.__preProceduralMaps]);
            delete m.userData.__preProceduralMaps;
          }
        }
      });
    }

    const lodMgr = this._engine?.lodManager || (typeof window !== 'undefined' ? window.engine?.lodManager : null);
    const savedLods = lodMgr?.forceLOD0 ? lodMgr.forceLOD0(root) : [];
    const instSys = this._engine?.instancingSystem || (typeof window !== 'undefined' ? window.instancingSystem : null);
    instSys?.prepareForExport?.(root, mode);

    let restored = false;
    return () => {
      if (restored) return;
      restored = true;
      instSys?.restoreAfterExport?.();
      if (savedLods?.length && lodMgr?.restoreLODs) lodMgr.restoreLODs(savedLods);
      for (let i = strippedPreMaps.length - 1; i >= 0; i -= 1) {
        const [ud, prev] = strippedPreMaps[i];
        ud.__preProceduralMaps = prev;
      }
      for (let i = swappedBoolMeshes.length - 1; i >= 0; i -= 1) {
        const [mesh, prevMat] = swappedBoolMeshes[i];
        mesh.material = prevMat;
      }
      for (let i = swappedMatcapMeshes.length - 1; i >= 0; i -= 1) {
        const [mesh, matcapMat] = swappedMatcapMeshes[i];
        mesh.material = matcapMat;
      }
      for (const item of hiddenItems) item.visible = true;
      if (savedWeightPaint && rigSys?.enableWeightPaintMode) {
        try { rigSys.enableWeightPaintMode(savedWeightPaint.mesh, savedWeightPaint.bone); } catch (_) {}
      }
    };
  }

  _withExportableScene(root, mode, fn, options = {}) {
    const targetRoot = root || this.sceneManager?.rootContainer || this.scene;
    const restore = this._prepareExportState(targetRoot, mode, options);
    try {
      return fn(targetRoot);
    } finally {
      restore();
    }
  }

  async _withExportableSceneAsync(root, mode, asyncFn, options = {}) {
    const targetRoot = root || this.sceneManager?.rootContainer || this.scene;
    const restore = this._prepareExportState(targetRoot, mode, options);
    try {
      return await asyncFn(targetRoot);
    } finally {
      restore();
    }
  }

  /**
   * Temporary detach of viewport-only helpers (light gizmos, IK handles, …)
   * so they are not serialized into the project file.
   */
  _withoutSystemHelpers(root, run) {
    const removed = [];
    root.traverse((node) => {
      if (node !== root && node.userData && (node.userData.isLightHelper || node.userData.isSystemObject)) {
        removed.push([node.parent, node]);
      }
    });
    removed.forEach(([parent, node]) => parent && parent.remove(node));
    try {
      return run();
    } finally {
      removed.forEach(([parent, node]) => parent && parent.add(node));
    }
  }

  _encodeNumbers(values) {
    const float = values instanceof Float32Array ? values : Float32Array.from(values || []);
    const bytes = new Uint8Array(float.buffer, float.byteOffset, float.byteLength);
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return { __f32: true, count: float.length, data: btoa(binary) };
  }

  _decodeNumbers(field) {
    if (!field || !field.__f32 || typeof field.data !== 'string') return field;
    const binary = atob(field.data);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return Array.from(new Float32Array(bytes.buffer));
  }

  /**
   * Primitive geometries (BoxGeometry, SphereGeometry…) override toJSON() to
   * store only their constructor parameters. Any vertex-level edit (sculpt,
   * edit mode, direct BufferAttribute writes) would silently disappear on
   * reload, so swap those entries for a plain BufferGeometry snapshot.
   */
  _materializePrimitiveGeometries(graph, root) {
    if (!graph || !root || !graph.geometries) return graph;
    const byUuid = new Map();
    root.traverse((node) => {
      if (node.geometry && node.geometry.uuid) byUuid.set(node.geometry.uuid, node.geometry);
    });
    for (const [key, entry] of Object.entries(graph.geometries)) {
      if (!entry || entry.data) continue;
      const source = byUuid.get(entry.uuid || key);
      if (!source || typeof source.toJSON !== 'function') continue;
      const snapshot = new THREE.BufferGeometry();
      snapshot.copy(source);
      snapshot.uuid = entry.uuid || key;
      snapshot.name = source.name || '';
      const json = snapshot.toJSON();
      json.uuid = snapshot.uuid;
      if (!json.name) json.name = snapshot.name;
      graph.geometries[key] = json;
    }
    return graph;
  }

  /**
   * Geometry attributes and animation tracks are the bulk of a project JSON.
   * Store their float arrays as base64 instead of thousands of decimal tokens.
   */
  _encodeSceneGraphBinary(graph, root = null) {
    if (!graph) return graph;
    this._materializePrimitiveGeometries(graph, root);
    const encodeAttribute = (attribute) => {
      if (attribute && Array.isArray(attribute.array)) {
        attribute.array = this._encodeNumbers(attribute.array);
      }
    };
    for (const geometry of Object.values(graph.geometries || {})) {
      const data = geometry?.data;
      if (!data) continue;
      Object.values(data.attributes || {}).forEach(encodeAttribute);
      if (data.index) encodeAttribute(data.index);
      Object.values(data.morphAttributes || {}).forEach((list) => list.forEach(encodeAttribute));
    }
    for (const clip of graph.animations || []) {
      for (const track of clip.tracks || []) {
        if (Array.isArray(track.times)) track.times = this._encodeNumbers(track.times);
        if (Array.isArray(track.values)) track.values = this._encodeNumbers(track.values);
      }
    }
    for (const skeleton of graph.skeletons || []) {
      if (Array.isArray(skeleton.boneInverses)) {
        skeleton.boneInverses = skeleton.boneInverses.map((values) =>
          Array.isArray(values) ? this._encodeNumbers(values) : values);
      }
    }
    return graph;
  }

  _decodeSceneGraphBinary(graph) {
    if (!graph) return graph;
    const decodeAttribute = (attribute) => {
      if (attribute && attribute.array && attribute.array.__f32) {
        attribute.array = this._decodeNumbers(attribute.array);
      }
    };
    for (const geometry of Object.values(graph.geometries || {})) {
      const data = geometry?.data;
      if (!data) continue;
      Object.values(data.attributes || {}).forEach(decodeAttribute);
      if (data.index) decodeAttribute(data.index);
      Object.values(data.morphAttributes || {}).forEach((list) => list.forEach(decodeAttribute));
    }
    for (const clip of graph.animations || []) {
      for (const track of clip.tracks || []) {
        track.times = this._decodeNumbers(track.times);
        track.values = this._decodeNumbers(track.values);
      }
    }
    for (const skeleton of graph.skeletons || []) {
      if (Array.isArray(skeleton.boneInverses)) {
        skeleton.boneInverses = skeleton.boneInverses.map((values) => this._decodeNumbers(values));
      }
    }
    return graph;
  }

  /**
   * Collect all exportable meshes from a scene or object
   */
  _collectMeshes(target) {
    const meshes = [];
    const root = target || this.scene;

    if (root.isMesh && this._isExportableMesh(root)) {
      meshes.push(root);
      return meshes;
    }

    root.traverse((child) => {
      if (this._isExportableMesh(child)) {
        meshes.push(child);
      }
    });

    return meshes;
  }

  // =========================================================================
  // 1. OBJ EXPORTER (.obj)
  // =========================================================================

  /**
   * Export the scene or selected object to Wavefront OBJ format
   * @param {THREE.Object3D|null} target - Target object or null for full scene
   * @param {Object} [options]
   * @param {string} [options.filename='scene.obj']
   * @param {boolean} [options.download=true]
   * @param {boolean} [options.worldTransform=true]
   * @returns {string} The OBJ formatted text
   */
  exportOBJ(target = null, options = {}) {
    const {
      filename = 'blender_scene.obj',
      download = true,
      worldTransform = true
    } = options;

    return this._withExportableScene(target || this.sceneManager?.rootContainer || this.scene, 'obj', (exportRoot) => {
      const meshes = this._collectMeshes(target || exportRoot);
      if (meshes.length === 0) {
        const msg = 'No exportable 3D meshes found in target.';
        console.warn('[StudioExporter]', msg);
        return '';
      }

      let output = '';
      output += `# Wavefront OBJ File\n`;
      output += `# Exported from Web Blender Studio\n`;
      output += `# Timestamp: ${new Date().toISOString()}\n`;
      output += `# Total Meshes: ${meshes.length}\n\n`;

      let vertexOffset = 0;
      let normalOffset = 0;
      let uvOffset = 0;

      const vWorld = new THREE.Vector3();
      const nWorld = new THREE.Vector3();
      const normalMatrix = new THREE.Matrix3();

      for (let m = 0; m < meshes.length; m++) {
        const mesh = meshes[m];
        const geom = mesh.geometry;
        if (!geom) continue;

        mesh.updateMatrixWorld(true);
        const meshName = (mesh.name || `Mesh_${m + 1}`).replace(/\s+/g, '_');
        output += `o ${meshName}\n`;

        const posAttr = geom.getAttribute('position');
        const normAttr = geom.getAttribute('normal');
        const uvAttr = geom.getAttribute('uv');
        const indexAttr = geom.getIndex();

        if (!posAttr) continue;

        // Calculate normal matrix if world transform enabled
        if (worldTransform) {
        normalMatrix.getNormalMatrix(mesh.matrixWorld);
      }

      // Write Vertices
      for (let i = 0; i < posAttr.count; i++) {
        vWorld.fromBufferAttribute(posAttr, i);
        if (worldTransform) {
          vWorld.applyMatrix4(mesh.matrixWorld);
        }
        output += `v ${vWorld.x.toFixed(6)} ${vWorld.y.toFixed(6)} ${vWorld.z.toFixed(6)}\n`;
      }

      // Write Texture Coordinates
      const hasUV = !!uvAttr;
      if (hasUV) {
        for (let i = 0; i < uvAttr.count; i++) {
          output += `vt ${uvAttr.getX(i).toFixed(6)} ${uvAttr.getY(i).toFixed(6)}\n`;
        }
      }

      // Write Vertex Normals
      const hasNormals = !!normAttr;
      if (hasNormals) {
        for (let i = 0; i < normAttr.count; i++) {
          nWorld.fromBufferAttribute(normAttr, i);
          if (worldTransform) {
            nWorld.applyMatrix3(normalMatrix).normalize();
          }
          output += `vn ${nWorld.x.toFixed(6)} ${nWorld.y.toFixed(6)} ${nWorld.z.toFixed(6)}\n`;
        }
      }

      // Smooth shading flag
      output += `s 1\n`;

      // Write Faces (1-indexed in OBJ standard)
      const buildFaceVertex = (idx) => {
        const v = idx + 1 + vertexOffset;
        const vt = hasUV ? idx + 1 + uvOffset : '';
        const vn = hasNormals ? idx + 1 + normalOffset : '';
        if (hasUV && hasNormals) {
          return `${v}/${vt}/${vn}`;
        } else if (hasNormals) {
          return `${v}//${vn}`;
        } else if (hasUV) {
          return `${v}/${vt}`;
        } else {
          return `${v}`;
        }
      };

      if (indexAttr) {
        // Indexed triangles
        for (let i = 0; i < indexAttr.count; i += 3) {
          const a = buildFaceVertex(indexAttr.getX(i));
          const b = buildFaceVertex(indexAttr.getX(i + 1));
          const c = buildFaceVertex(indexAttr.getX(i + 2));
          output += `f ${a} ${b} ${c}\n`;
        }
      } else {
        // Non-indexed triangles
        for (let i = 0; i < posAttr.count; i += 3) {
          const a = buildFaceVertex(i);
          const b = buildFaceVertex(i + 1);
          const c = buildFaceVertex(i + 2);
          output += `f ${a} ${b} ${c}\n`;
        }
      }

      vertexOffset += posAttr.count;
      if (hasNormals) normalOffset += normAttr.count;
      if (hasUV) uvOffset += uvAttr.count;
      output += `\n`;
    }

    if (download) {
      this.triggerDownload(new Blob([output], { type: 'text/plain;charset=utf-8' }), filename);
    }

    return output;
    });
  }

  /**
   * Helper / alias to generate OBJ string directly without downloading
   * @param {THREE.Object3D|null} target
   * @returns {string}
   */
  generateOBJString(target = null, options = {}) {
    return this.exportOBJ(target, { ...options, download: false });
  }

  /**
   * Helper / alias to generate STL buffer/string directly without downloading
   */
  generateSTL(target = null, binary = true) {
    return this.exportSTL(target, { binary, download: false });
  }

  /**
   * Helper / alias to generate binary STL ArrayBuffer directly
   */
  generateSTLBinary(target = null) {
    return this.exportSTL(target, { binary: true, download: false });
  }

  /**
   * Helper / alias to serialize project into JS object
   */
  serializeProject() {
    const jsonStr = this.exportProjectJSON({ download: false });
    return JSON.parse(jsonStr);
  }

  // =========================================================================
  // 2. STL EXPORTER (.stl) FOR 3D PRINTING
  // =========================================================================

  /**
   * Export the scene or selected object to STL format (Binary or ASCII)
   * @param {THREE.Object3D|null} target 
   * @param {Object} [options]
   * @param {boolean} [options.binary=true] Binary STL is standard for Cura/Prusa 3D printing
   * @param {string} [options.filename='model.stl']
   * @param {boolean} [options.download=true]
   * @returns {ArrayBuffer|string}
   */
  exportSTL(target = null, options = {}) {
    const {
      binary = true,
      filename = 'blender_print.stl',
      download = true
    } = options;

    return this._withExportableScene(target || this.sceneManager?.rootContainer || this.scene, 'stl', (exportRoot) => {
    const meshes = this._collectMeshes(target || exportRoot);
    if (meshes.length === 0) {
      const msg = 'No printable 3D meshes found to export as STL.';
      console.warn('[StudioExporter]', msg);
      return binary ? new ArrayBuffer(0) : '';
    }

    // Pre-calculate total triangle count across all meshes
    let totalTriangles = 0;
    for (const mesh of meshes) {
      const geom = mesh.geometry;
      if (!geom || !geom.getAttribute('position')) continue;
      if (geom.getIndex()) {
        totalTriangles += geom.getIndex().count / 3;
      } else {
        totalTriangles += geom.getAttribute('position').count / 3;
      }
    }

    totalTriangles = Math.floor(totalTriangles);

    if (binary) {
      // Binary STL format:
      // 80 bytes: Header
      // 4 bytes: uint32 triangle count
      // 50 bytes per triangle:
      //   - normal: 3x float32 (12 bytes)
      //   - v1: 3x float32 (12 bytes)
      //   - v2: 3x float32 (12 bytes)
      //   - v3: 3x float32 (12 bytes)
      //   - attribute byte count: uint16 (2 bytes) = 0
      const bufferSize = 84 + totalTriangles * 50;
      const buffer = new ArrayBuffer(bufferSize);
      const dataView = new DataView(buffer);

      // Write 80-byte header string
      const headerStr = 'Binary STL export from Web Blender Studio for 3D Printing';
      for (let i = 0; i < 80; i++) {
        if (i < headerStr.length) {
          dataView.setUint8(i, headerStr.charCodeAt(i));
        } else {
          dataView.setUint8(i, 0);
        }
      }

      // Write triangle count at byte 80
      dataView.setUint32(80, totalTriangles, true);

      let offset = 84;
      const vA = new THREE.Vector3();
      const vB = new THREE.Vector3();
      const vC = new THREE.Vector3();
      const edge1 = new THREE.Vector3();
      const edge2 = new THREE.Vector3();
      const normal = new THREE.Vector3();

      for (const mesh of meshes) {
        const geom = mesh.geometry;
        if (!geom) continue;
        const posAttr = geom.getAttribute('position');
        const indexAttr = geom.getIndex();
        if (!posAttr) continue;

        mesh.updateMatrixWorld(true);

        const writeTriangle = (idxA, idxB, idxC) => {
          vA.fromBufferAttribute(posAttr, idxA).applyMatrix4(mesh.matrixWorld);
          vB.fromBufferAttribute(posAttr, idxB).applyMatrix4(mesh.matrixWorld);
          vC.fromBufferAttribute(posAttr, idxC).applyMatrix4(mesh.matrixWorld);

          // Calculate facet normal
          edge1.subVectors(vB, vA);
          edge2.subVectors(vC, vA);
          normal.crossVectors(edge1, edge2).normalize();

          // Write normal
          dataView.setFloat32(offset, normal.x, true); offset += 4;
          dataView.setFloat32(offset, normal.y, true); offset += 4;
          dataView.setFloat32(offset, normal.z, true); offset += 4;

          // Write vertices vA, vB, vC
          dataView.setFloat32(offset, vA.x, true); offset += 4;
          dataView.setFloat32(offset, vA.y, true); offset += 4;
          dataView.setFloat32(offset, vA.z, true); offset += 4;

          dataView.setFloat32(offset, vB.x, true); offset += 4;
          dataView.setFloat32(offset, vB.y, true); offset += 4;
          dataView.setFloat32(offset, vB.z, true); offset += 4;

          dataView.setFloat32(offset, vC.x, true); offset += 4;
          dataView.setFloat32(offset, vC.y, true); offset += 4;
          dataView.setFloat32(offset, vC.z, true); offset += 4;

          // Attribute byte count = 0
          dataView.setUint16(offset, 0, true); offset += 2;
        };

        if (indexAttr) {
          for (let i = 0; i < indexAttr.count; i += 3) {
            writeTriangle(indexAttr.getX(i), indexAttr.getX(i + 1), indexAttr.getX(i + 2));
          }
        } else {
          for (let i = 0; i < posAttr.count; i += 3) {
            writeTriangle(i, i + 1, i + 2);
          }
        }
      }

      if (download) {
        this.triggerDownload(new Blob([buffer], { type: 'application/octet-stream' }), filename);
      }
      return buffer;
    } else {
      // ASCII STL format
      let output = `solid BlenderStudioModel\n`;
      const vA = new THREE.Vector3();
      const vB = new THREE.Vector3();
      const vC = new THREE.Vector3();
      const edge1 = new THREE.Vector3();
      const edge2 = new THREE.Vector3();
      const normal = new THREE.Vector3();

      for (const mesh of meshes) {
        const geom = mesh.geometry;
        if (!geom) continue;
        const posAttr = geom.getAttribute('position');
        const indexAttr = geom.getIndex();
        if (!posAttr) continue;

        mesh.updateMatrixWorld(true);

        const writeFacet = (idxA, idxB, idxC) => {
          vA.fromBufferAttribute(posAttr, idxA).applyMatrix4(mesh.matrixWorld);
          vB.fromBufferAttribute(posAttr, idxB).applyMatrix4(mesh.matrixWorld);
          vC.fromBufferAttribute(posAttr, idxC).applyMatrix4(mesh.matrixWorld);

          edge1.subVectors(vB, vA);
          edge2.subVectors(vC, vA);
          normal.crossVectors(edge1, edge2).normalize();

          output += `  facet normal ${normal.x.toExponential(6)} ${normal.y.toExponential(6)} ${normal.z.toExponential(6)}\n`;
          output += `    outer loop\n`;
          output += `      vertex ${vA.x.toExponential(6)} ${vA.y.toExponential(6)} ${vA.z.toExponential(6)}\n`;
          output += `      vertex ${vB.x.toExponential(6)} ${vB.y.toExponential(6)} ${vB.z.toExponential(6)}\n`;
          output += `      vertex ${vC.x.toExponential(6)} ${vC.y.toExponential(6)} ${vC.z.toExponential(6)}\n`;
          output += `    endloop\n`;
          output += `  endfacet\n`;
        };

        if (indexAttr) {
          for (let i = 0; i < indexAttr.count; i += 3) {
            writeFacet(indexAttr.getX(i), indexAttr.getX(i + 1), indexAttr.getX(i + 2));
          }
        } else {
          for (let i = 0; i < posAttr.count; i += 3) {
            writeFacet(i, i + 1, i + 2);
          }
        }
      }

      output += `endsolid BlenderStudioModel\n`;

      if (download) {
        this.triggerDownload(new Blob([output], { type: 'text/plain;charset=utf-8' }), filename);
      }
      return output;
    }
    });
  }

  // =========================================================================
  // 3. PROJECT JSON EXPORT & IMPORT (.blend.json / .web3d)
  // =========================================================================

  /**
   * Serialize the entire project scene to JSON
   * @param {Object} [options]
   * @param {string} [options.filename='project.blend.json']
   * @param {boolean} [options.download=true]
   * @returns {string} JSON string
   */
  /**
   * Build the structured v5 project payload without stringifying or downloading.
   * Shared by exportProjectJSON, exportProjectPackage (.wbs), and autosave.
   * @param {Object} [options]
   * @returns {Object}
   */
  exportProjectData(options = {}) {
    const scene = this.scene;
    const controls = this._engine?.controls;
    const cameraManager = this._engine && (this._engine.cameraManager ||
      (typeof window !== 'undefined' ? window.cameraManager : null));
    // Scene camera views render a child camera; persist the orbit viewport instead.
    const camera = cameraManager?.lookingThrough && controls?.object?.isCamera
      ? controls.object : this.camera;

    const envStudio = this._engine?.environmentStudio || (typeof window !== 'undefined' ? window.environmentStudio : null);
    const projectData = {
      meta: {
        format: 'web-blender-studio-project',
        version: '1.0.0',
        schemaVersion: CURRENT_PROJECT_SCHEMA,
        generator: 'Web Blender Studio Engine',
        createdAt: new Date().toISOString()
      },
      environment: {
        backgroundColor: scene.background && scene.background.isColor ? `#${scene.background.getHexString()}` : '#282828',
        fog: scene.fog ? {
          type: scene.fog.isFogExp2 ? 'exp2' : 'linear',
          color: `#${scene.fog.color.getHexString()}`,
          near: scene.fog.near || 1,
          far: scene.fog.far || 1000,
          density: scene.fog.density || 0.001
        } : null,
        studio: envStudio ? {
          hdriEnabled: Boolean(envStudio.hdriEnabled),
          currentHdriPreset: envStudio.currentHdriPreset || null,
          customHdrUrl: envStudio.customHdrUrl || null,
          showHdriBackground: Boolean(envStudio.showHdriBackground),
          environmentIntensity: Number.isFinite(envStudio.environmentIntensity) ? envStudio.environmentIntensity : 1.0,
          environmentRotation: Number.isFinite(envStudio.environmentRotation) ? envStudio.environmentRotation : 0,
          backgroundBlurriness: Number.isFinite(envStudio.backgroundBlurriness) ? envStudio.backgroundBlurriness : 0,
          backdropEnabled: Boolean(envStudio.backdropEnabled),
          backdropColor: envStudio.backdropColor || null,
          skyEnabled: Boolean(envStudio.skyEnabled),
          skyParams: envStudio.skyParams ? { ...envStudio.skyParams } : null,
          fogEnabled: Boolean(envStudio.fogEnabled),
          fogPreset: envStudio.currentFogPreset || null,
          fogParams: envStudio.fogParams ? { ...envStudio.fogParams } : null,
          shadowCatcherEnabled: Boolean(envStudio.shadowCatcherEnabled),
          shadowCatcherOpacity: Number.isFinite(envStudio.shadowCatcherOpacity) ? envStudio.shadowCatcherOpacity : 0.45,
          lookDevPreset: this._engine?.rasterRenderer?.preset || null,
        } : null,
      },
      camera: {
        type: camera.isOrthographicCamera ? 'OrthographicCamera' : 'PerspectiveCamera',
        ...(camera.isOrthographicCamera
          ? { left: camera.left, right: camera.right, top: camera.top, bottom: camera.bottom }
          : { fov: camera.fov }),
        near: camera.near,
        far: camera.far,
        position: camera.getWorldPosition(new THREE.Vector3()).toArray(),
        quaternion: camera.getWorldQuaternion(new THREE.Quaternion()).toArray(),
        up: camera.up.toArray(),
        zoom: camera.zoom,
        ...(controls?.object === camera ? { target: controls.target.toArray() } : {})
      },
      objects: [],
      lights: []
    };

    const sanitizeShallowUserData = (ud) => {
      if (!ud || typeof ud !== 'object') return {};
      const out = {};
      for (const [k, v] of Object.entries(ud)) {
        if (k.startsWith('_')) continue;
        if (v === null || ['string', 'number', 'boolean'].includes(typeof v)) {
          out[k] = v;
        }
      }
      return out;
    };

    // Serialize lightweight v2 header list (without duplicating heavy Material/Geometry backups in userData!)
    const serializeMesh = (mesh) => {
      const geom = mesh.geometry;
      const realMat = (mesh.userData?.__originalMaterial && (
        Array.isArray(mesh.material)
          ? mesh.material.some((m) => m?.isMeshMatcapMaterial)
          : mesh.material?.isMeshMatcapMaterial
      )) ? mesh.userData.__originalMaterial : mesh.material;

      let geomData = {
        type: geom ? geom.type : 'BufferGeometry',
        parameters: geom && geom.parameters ? geom.parameters : {}
      };

      // Material data
      let matData = {};
      if (realMat) {
        const primaryMat = Array.isArray(realMat) ? realMat[0] : realMat;
        matData = {
          type: primaryMat.type,
          color: primaryMat.color ? `#${primaryMat.color.getHexString()}` : '#cccccc',
          roughness: primaryMat.roughness !== undefined ? primaryMat.roughness : 0.5,
          metalness: primaryMat.metalness !== undefined ? primaryMat.metalness : 0.1,
          wireframe: !!primaryMat.wireframe,
          opacity: primaryMat.opacity !== undefined ? primaryMat.opacity : 1.0,
          transparent: !!primaryMat.transparent,
          emissive: primaryMat.emissive ? `#${primaryMat.emissive.getHexString()}` : '#000000',
          emissiveIntensity: primaryMat.emissiveIntensity !== undefined ? primaryMat.emissiveIntensity : 1.0
        };
      }

      return {
        uuid: mesh.uuid,
        name: mesh.name || 'Object',
        type: mesh.isMesh ? 'Mesh' : 'Group',
        visible: mesh.visible,
        position: [mesh.position.x, mesh.position.y, mesh.position.z],
        rotation: [mesh.rotation.x, mesh.rotation.y, mesh.rotation.z],
        scale: [mesh.scale.x, mesh.scale.y, mesh.scale.z],
        geometry: geomData,
        material: matData,
        userData: sanitizeShallowUserData(mesh.userData)
      };
    };

    scene.traverse((obj) => {
      if (obj.userData && (obj.userData.isHelper || obj.userData.isSystemObject)) {
        return;
      }
      if (obj.isLight) {
        if (!this._isProjectObject(obj)) return;
        projectData.lights.push({
          type: obj.type,
          name: obj.name || obj.type,
          color: `#${obj.color.getHexString()}`,
          intensity: obj.intensity,
          position: [obj.position.x, obj.position.y, obj.position.z],
          castShadow: !!obj.castShadow
        });
      } else if (this._isExportableMesh(obj)) {
        projectData.objects.push(serializeMesh(obj));
      }
    });

    const root = this.sceneManager?.rootContainer || this.sceneManager?.scene || scene;
    const timeline = this._resolveTimelineEngine();

    const restoreExportState = this._prepareExportState(root, 'project', { hideHelpers: false });

    // Smart Alpha-Preserving WebP Texture Serializer:
    //   1. Encodes color maps (map/emissiveMap) >128px as WebP with alpha while keeping ALL linear data maps
    //      (normalMap, roughnessMap, metalnessMap, aoMap, clearcoatNormalMap, bumpMap, displacementMap) lossless PNG!
    const dataMapImages = new WeakSet();
    if (root) {
      root.traverse((obj) => {
        if (!obj.material) return;
        const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
        for (const m of mats) {
          if (!m) continue;
          for (const slot of [
            'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap',
            'clearcoatNormalMap', 'clearcoatRoughnessMap', 'clearcoatMap',
            'bumpMap', 'displacementMap', 'thicknessMap', 'transmissionMap',
            'specularIntensityMap', 'iridescenceMap', 'iridescenceThicknessMap',
            'anisotropyMap', 'sheenRoughnessMap', 'alphaMap', 'lightMap'
          ]) {
            if (m[slot]?.image) dataMapImages.add(m[slot].image);
          }
        }
      });
    }
    const origGetDataURL = THREE.ImageUtils?.getDataURL;
    let scratchEncodeCanvas = null;
    if (THREE.ImageUtils && typeof origGetDataURL === 'function' && options.useWebpTextures !== false) {
      THREE.ImageUtils.getDataURL = (image) => {
        if (!image) return '';
        const encodeToCanvas = (img, mime, quality) => {
          if (typeof document === 'undefined') return origGetDataURL.call(THREE.ImageUtils, img);
          const w = Number(img.width || img.naturalWidth || 0);
          const h = Number(img.height || img.naturalHeight || 0);
          if (!w || !h) return origGetDataURL.call(THREE.ImageUtils, img);
          let canvas;
          if (typeof HTMLCanvasElement !== 'undefined' && img instanceof HTMLCanvasElement) {
            canvas = img;
          } else {
            if (!scratchEncodeCanvas) scratchEncodeCanvas = document.createElement('canvas');
            scratchEncodeCanvas.width = w;
            scratchEncodeCanvas.height = h;
            const ctx = scratchEncodeCanvas.getContext('2d');
            ctx.clearRect(0, 0, w, h);
            if (typeof ImageData !== 'undefined' && img instanceof ImageData) {
              ctx.putImageData(img, 0, 0);
            } else if (img.data && img.width && img.height) {
              const clamped = img.data instanceof Uint8ClampedArray
                ? img.data
                : new Uint8ClampedArray(img.data.buffer, img.data.byteOffset, img.data.byteLength);
              ctx.putImageData(new ImageData(clamped, w, h), 0, 0);
            } else {
              ctx.drawImage(img, 0, 0, w, h);
            }
            canvas = scratchEncodeCanvas;
          }
          const url = quality !== undefined ? canvas.toDataURL(mime, quality) : canvas.toDataURL(mime);
          return typeof url === 'string' && url.startsWith('data:') ? url : canvas.toDataURL('image/png');
        };
        // Linear data maps ALWAYS stay lossless PNG even when > 2048px (avoiding Three.js ImageUtils >2048 JPEG downgrade!)
        if (dataMapImages.has(image)) {
          try {
            return encodeToCanvas(image, 'image/png');
          } catch (_) {
            return origGetDataURL.call(THREE.ImageUtils, image);
          }
        }
        if (typeof image.src === 'string' && /^data:image\/(webp|jpeg)/i.test(image.src)) {
          return image.src;
        }
        if (typeof document === 'undefined') {
          return origGetDataURL.call(THREE.ImageUtils, image);
        }
        const w = Number(image.width || image.naturalWidth || 0);
        const h = Number(image.height || image.naturalHeight || 0);
        if (!w || !h || (w <= 128 && h <= 128)) {
          return origGetDataURL.call(THREE.ImageUtils, image);
        }
        try {
          return encodeToCanvas(image, 'image/webp', 0.88);
        } catch (_) {
          return origGetDataURL.call(THREE.ImageUtils, image);
        }
      };
    }

    try {
      // v5: keep DataBlockRegistry synchronized before sceneGraph serialization so
      // `userData.dataBlockIds` and shared refcounts persist in the project file.
      if (root) {
        dataBlockRegistry.syncFromScene(root, timeline);
        projectData.dataBlocks = dataBlockRegistry.toJSON();
        if (this.sceneManager?.collectionManager) {
          projectData.collectionsData = this.sceneManager.collectionManager.toJSON();
        }
      }

      // Full scene graph (Three.js Object3D JSON): hierarchy, groups, lights,
      // cameras, bones/skinning, geometry attributes, materials, textures and
      // per-object animation clips.
      const instSys = this._engine?.instancingSystem || (typeof window !== 'undefined' ? window.instancingSystem : null);
      if (root && typeof root.toJSON === 'function') {
        if (instSys) {
          const sg = instSys.serializeScatterGroups(root);
          if (Object.keys(sg).length > 0) projectData.scatterGroups = sg;
        }
        const rawGraph = this._withoutSystemHelpers(root, () => this._withPlainUserData(root, () => root.toJSON()));
        // Preserve sheenColorMap & sheenRoughnessMap on MeshPhysicalMaterial (dropped by older Three.Material.toJSON)
        if (rawGraph && Array.isArray(rawGraph.materials)) {
          const matByUuid = new Map();
          root.traverse((obj) => {
            const ms = Array.isArray(obj.material) ? obj.material : (obj.material ? [obj.material] : []);
            for (const m of ms) if (m?.uuid) matByUuid.set(m.uuid, m);
          });
          rawGraph.textures = rawGraph.textures || [];
          rawGraph.images = rawGraph.images || [];
          const texMap = new Map(rawGraph.textures.map((t) => [t.uuid, t]));
          const imgMap = new Map(rawGraph.images.map((im) => [im.uuid, im]));
          const ensureTexSerialized = (tex) => {
            if (!tex?.uuid) return null;
            if (!texMap.has(tex.uuid)) {
              const meta = { images: Object.fromEntries(imgMap), textures: Object.fromEntries(texMap) };
              const tJson = tex.toJSON(meta);
              rawGraph.textures.push(tJson);
              texMap.set(tex.uuid, tJson);
              for (const [iu, ij] of Object.entries(meta.images)) {
                if (!imgMap.has(iu)) {
                  rawGraph.images.push(ij);
                  imgMap.set(iu, ij);
                }
              }
            }
            return tex.uuid;
          };
          for (const mj of rawGraph.materials) {
            const liveMat = matByUuid.get(mj.uuid);
            if (!liveMat?.isMeshPhysicalMaterial) continue;
            if (liveMat.sheenColorMap && !mj.sheenColorMap) mj.sheenColorMap = ensureTexSerialized(liveMat.sheenColorMap);
            if (liveMat.sheenRoughnessMap && !mj.sheenRoughnessMap) mj.sheenRoughnessMap = ensureTexSerialized(liveMat.sheenRoughnessMap);
          }
        }
        projectData.sceneGraph = this._encodeSceneGraphBinary(rawGraph, root);
      }
    } finally {
      if (THREE.ImageUtils && origGetDataURL) {
        THREE.ImageUtils.getDataURL = origGetDataURL;
      }
      restoreExportState();
    }

    // v4+: source geometry của modifier stack (userData.baseGeometry bị strip
    // khi toJSON nên phải lưu riêng để restore lại stack editable).
    const modifierSources = {};
    if (root && typeof root.traverse === 'function') {
      root.traverse((obj) => {
        if (obj.isMesh && Array.isArray(obj.userData?.modifierStack) && obj.userData.modifierStack.length && obj.userData.baseGeometry) {
          modifierSources[obj.uuid] = encodeGeometry(obj.userData.baseGeometry);
        }
      });
    }
    if (Object.keys(modifierSources).length) projectData.modifierSources = modifierSources;

    if (root) {
      const paintStacks = serializeScenePaintStacksSync(root);
      if (Object.keys(paintStacks).length > 0) projectData.paintStacks = paintStacks;
    }

    // Manual timeline keyframes live outside the Three graph.
    if (timeline) {
      projectData.timelineConfig = {
        fps: timeline.fps,
        startFrame: timeline.startFrame,
        endFrame: timeline.endFrame,
        currentFrame: timeline.currentFrame,
        loop: Boolean(timeline.loop),
        defaultInterpolation: timeline.defaultInterpolation || 'smooth',
      };
      if (typeof timeline.exportTracks === 'function') {
        const tracks = timeline.exportTracks();
        if (tracks.length) projectData.timeline = tracks;
      }
      if (typeof timeline.exportAnimationData === 'function') {
        const animData = timeline.exportAnimationData();
        if (animData && (animData.actions?.length || animData.nlaTracks?.length || animData.drivers?.length)) {
          projectData.animationData = animData;
        }
      }
    }

    const sim = this._engine?.simulationManager || (typeof window !== 'undefined' ? window.simulationManager : null);
    if (sim && (sim.bodies?.size > 0 || !sim.groundEnabled || sim.groundY !== 0 || sim.gravity?.y !== -9.81)) {
      projectData.physicsWorld = {
        gravity: sim.gravity ? { x: sim.gravity.x, y: sim.gravity.y, z: sim.gravity.z } : { x: 0, y: -9.81, z: 0 },
        groundEnabled: Boolean(sim.groundEnabled),
        groundY: Number.isFinite(sim.groundY) ? sim.groundY : 0,
      };
    }

    return projectData;
  }

  exportProjectJSON(options = {}) {
    const {
      filename = 'blender_project.blend.json',
      download = true
    } = options;

    const projectData = this.exportProjectData(options);
    const jsonText = JSON.stringify(projectData);

    if (download) {
      this.triggerDownload(new Blob([jsonText], { type: 'application/json;charset=utf-8' }), filename);
    }

    return jsonText;
  }

  /**
   * Exports a self-contained `.wbs` ZIP project package (`manifest.json` +
   * deduplicated binary `blobs/<ref>` files via fflate) for large scenes.
   */
  async exportProjectPackage(options = {}) {
    const {
      filename = 'blender_project.wbs',
      download = true,
      minBlobBytes = 512,
    } = options;

    const projectData = this.exportProjectData(options);
    const packagedBlobs = new Map();
    const { manifest } = await dehydrateProjectBlobs(
      projectData,
      async (bytes) => {
        const ref = await computeBlobRef(bytes);
        if (!packagedBlobs.has(ref)) {
          packagedBlobs.set(ref, bytes);
        }
        return { ref };
      },
      { minBytes: minBlobBytes }
    );
    manifest.meta.packaging = 'wbs-zip-v1';

    const archive = {
      'manifest.json': strToU8(JSON.stringify(manifest)),
    };
    for (const [ref, bytes] of packagedBlobs.entries()) {
      archive[`blobs/${ref}`] = bytes;
    }

    const zipped = zipSync(archive, { level: 6 });
    const blob = new Blob([zipped], { type: 'application/octet-stream' });
    if (download) {
      this.triggerDownload(blob, filename);
    }

    return {
      blob,
      bytes: zipped,
      filename,
      blobCount: packagedBlobs.size,
      manifest,
    };
  }

  _restoreViewportCamera(saved) {
    if (!saved || typeof saved !== 'object') return;
    const engine = this._engine;
    // Projects predating viewport projection support always used perspective.
    const type = saved.type === undefined ? 'PerspectiveCamera' : saved.type;
    if ((type === 'PerspectiveCamera' || type === 'OrthographicCamera') &&
        this.camera.type !== type && typeof engine?.toggleProjection === 'function') {
      engine.toggleProjection();
    }
    const camera = this.camera;
    const controls = engine?.controls?.object === camera ? engine.controls : null;
    const finiteArray = (value, length) => Array.isArray(value) && value.length === length &&
      Array.from(value).every(Number.isFinite);

    if (camera.isPerspectiveCamera && Number.isFinite(saved.fov) && saved.fov > 0 && saved.fov < 180) {
      camera.fov = saved.fov;
    }
    const near = Number.isFinite(saved.near) && (camera.isOrthographicCamera ? saved.near >= 0 : saved.near > 0)
      ? saved.near : camera.near;
    const far = Number.isFinite(saved.far) ? saved.far : camera.far;
    if (far > near) {
      camera.near = near;
      camera.far = far;
    }
    if (Number.isFinite(saved.zoom) && saved.zoom > 0) camera.zoom = saved.zoom;
    if (camera.isOrthographicCamera &&
        [saved.left, saved.right, saved.top, saved.bottom].every(Number.isFinite) &&
        saved.right > saved.left && saved.top > saved.bottom &&
        Number.isFinite(saved.right - saved.left) && Number.isFinite(saved.top - saved.bottom)) {
      camera.left = saved.left;
      camera.right = saved.right;
      camera.top = saved.top;
      camera.bottom = saved.bottom;
    }
    if (finiteArray(saved.position, 3)) {
      camera.position.fromArray(saved.position);
      if (camera.parent) camera.parent.worldToLocal(camera.position);
    }
    if (finiteArray(saved.up, 3) && Math.hypot(...saved.up) > 0 && Number.isFinite(Math.hypot(...saved.up))) {
      camera.up.fromArray(saved.up);
    }
    if (controls && finiteArray(saved.target, 3)) controls.target.fromArray(saved.target);
    controls?.update();

    if (finiteArray(saved.quaternion, 4)) {
      const length = Math.hypot(...saved.quaternion);
      if (length > 0 && Number.isFinite(length)) {
        camera.quaternion.fromArray(saved.quaternion.map((value) => value / length));
        if (camera.parent) {
          const parentRotation = camera.parent.getWorldQuaternion(new THREE.Quaternion()).invert();
          camera.quaternion.premultiply(parentRotation).normalize();
        }
      }
    }
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld(true);
    // Refit horizontal extent/aspect to this window; retain saved vertical span.
    engine?.onResize?.();
  }

  _isZipBytes(bytes) {
    return bytes && bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b;
  }

  /**
   * Unpacks and imports a `.wbs` ZIP project package (`manifest.json` + `blobs/*`).
   */
  async importProjectPackage(input, options = {}) {
    let bytes;
    if (input instanceof Uint8Array) {
      bytes = input;
    } else if (input instanceof ArrayBuffer) {
      bytes = new Uint8Array(input);
    } else if (input instanceof Blob || (typeof File !== 'undefined' && input instanceof File)) {
      bytes = new Uint8Array(await input.arrayBuffer());
    } else {
      throw new TypeError('importProjectPackage requires a Blob, File, ArrayBuffer, or Uint8Array.');
    }

    const entries = unzipSync(bytes);
    const manifestBytes = entries['manifest.json'];
    if (!manifestBytes) {
      throw new Error('Invalid .wbs archive: missing manifest.json.');
    }

    const manifest = JSON.parse(strFromU8(manifestBytes));
    const { data: hydrated } = await hydrateProjectBlobs(
      manifest,
      async (ref) => entries[`blobs/${ref}`] || await blobStore.get(ref),
      { strict: true }
    );

    return await this.importProjectJSON(hydrated, options);
  }

  /**
   * Import project from JSON text, `.wbs` package, File/Blob, or Object
   * @param {string|File|Blob|Uint8Array|ArrayBuffer|Object} input 
   * @param {Object} [options]
   * @param {boolean} [options.clearExisting=true]
   * @returns {Promise<Object>}
   */
  async importProjectJSON(input, options = {}) {
    const { clearExisting = true } = options;
    let rawData;

    if (input instanceof Uint8Array || input instanceof ArrayBuffer) {
      const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
      if (this._isZipBytes(bytes)) {
        return await this.importProjectPackage(bytes, options);
      }
      rawData = JSON.parse(strFromU8(bytes));
    } else if (typeof input === 'string') {
      try {
        rawData = JSON.parse(input);
      } catch (err) {
        throw new Error('Invalid JSON string format: ' + err.message);
      }
    } else if (input instanceof Blob || (typeof File !== 'undefined' && input instanceof File)) {
      const head = new Uint8Array(await input.slice(0, 4).arrayBuffer());
      const fileName = String(input.name || '').toLowerCase();
      if (this._isZipBytes(head) || fileName.endsWith('.wbs')) {
        return await this.importProjectPackage(input, options);
      }
      const text = await input.text();
      rawData = JSON.parse(text);
    } else if (typeof input === 'object' && input !== null) {
      rawData = input;
    } else {
      throw new Error('Unsupported input type for project import.');
    }

    if (!rawData.meta || rawData.meta.format !== 'web-blender-studio-project') {
      console.warn('[StudioExporter] Project file does not match expected format metadata. Attempting best-effort recovery.');
    }

    const migration = migrateProjectData(rawData);
    for (const warning of migration.warnings) {
      console.warn(`[StudioExporter] ${warning}`);
    }

    let data = migration.data;
    if (Array.isArray(data?.meta?.blobRefs) && data.meta.blobRefs.length > 0) {
      const getBlob = options.getBlob || ((ref) => blobStore.get(ref));
      const hydrated = await hydrateProjectBlobs(data, getBlob, { strict: true });
      data = hydrated.data;
    }

    const scene = this.scene;
    const sm = this.sceneManager;
    if (this._engine) {
      const cameraManager = this._engine.cameraManager ||
        (typeof window !== 'undefined' ? window.cameraManager : null);
      cameraManager?.exitCameraView?.();
    }

    // Parse the saved scene graph BEFORE touching the live scene: a truncated or
    // corrupt project file must never destroy the work currently on screen.
    let preloadedGraph = null;
    if (data.sceneGraph) {
      try {
        const loader = new THREE.ObjectLoader();
        const graph = this._decodeSceneGraphBinary(data.sceneGraph);
        preloadedGraph = await loader.parseAsync(graph);
        // Restore sheenColorMap & sheenRoughnessMap if Three ObjectLoader did not attach them automatically
        if (preloadedGraph && Array.isArray(graph?.materials) && Array.isArray(graph?.textures)) {
          const matJsonByUuid = new Map(graph.materials.filter((m) => m.sheenColorMap || m.sheenRoughnessMap).map((m) => [m.uuid, m]));
          if (matJsonByUuid.size > 0) {
            const parsedImages = await new Promise((res) => {
              const imgs = loader.parseImages(graph.images || [], () => res(imgs));
              if (!graph.images?.length) res(imgs);
            });
            const parsedTextures = loader.parseTextures(graph.textures || [], parsedImages);
            preloadedGraph.traverse((obj) => {
              const ms = Array.isArray(obj.material) ? obj.material : (obj.material ? [obj.material] : []);
              for (const m of ms) {
                const mj = m?.uuid ? matJsonByUuid.get(m.uuid) : null;
                if (!mj) continue;
                if (mj.sheenColorMap && !m.sheenColorMap && parsedTextures[mj.sheenColorMap]) {
                  m.sheenColorMap = parsedTextures[mj.sheenColorMap];
                  m.needsUpdate = true;
                }
                if (mj.sheenRoughnessMap && !m.sheenRoughnessMap && parsedTextures[mj.sheenRoughnessMap]) {
                  m.sheenRoughnessMap = parsedTextures[mj.sheenRoughnessMap];
                  m.needsUpdate = true;
                }
              }
            });
          }
        }
      } catch (err) {
        throw new Error(
          'Unable to read scene from project file (the file may be corrupted or truncated). ' +
          'The current scene has been preserved. Details: ' + (err && err.message ? err.message : err)
        );
      }
    }

    // Clear existing objects if requested
    if (clearExisting) {
      if (typeof window !== 'undefined' && window.studio && typeof window.studio.clearScene === 'function') {
        window.studio.clearScene();
      } else if (sm && typeof sm.clearScene === 'function') {
        sm.clearScene();
      } else {
        // Fallback traverse & remove
        const toRemove = [];
        scene.traverse((child) => {
          if (this._isExportableMesh(child)) toRemove.push(child);
        });
        toRemove.forEach((obj) => {
          if (obj.parent) obj.parent.remove(obj);
          if (obj.geometry) obj.geometry.dispose();
          if (obj.material) {
            if (Array.isArray(obj.material)) obj.material.forEach((m) => m.dispose());
            else obj.material.dispose();
          }
        });
      }
    }

    // Restore Environment & HDRI Studio State
    if (data.environment && data.environment.backgroundColor) {
      scene.background = new THREE.Color(data.environment.backgroundColor);
    }
    if (data.environment && data.environment.fog) {
      const fog = data.environment.fog;
      scene.fog = fog.type === 'exp2'
        ? new THREE.FogExp2(fog.color || '#282828', fog.density || 0.001)
        : new THREE.Fog(fog.color || '#282828', fog.near || 1, fog.far || 1000);
    } else {
      scene.fog = null;
    }
    const envStudioRestore = this._engine?.environmentStudio || (typeof window !== 'undefined' ? window.environmentStudio : null);
    if (envStudioRestore && data.environment?.studio) {
      const st = data.environment.studio;
      try {
        envStudioRestore.showHdriBackground = Boolean(st.showHdriBackground);
        if (Number.isFinite(st.environmentIntensity)) envStudioRestore.setEnvironmentIntensity?.(st.environmentIntensity);
        if (Number.isFinite(st.environmentRotation)) envStudioRestore.setEnvironmentRotation?.(st.environmentRotation);
        if (Number.isFinite(st.backgroundBlurriness)) envStudioRestore.setBackgroundBlurriness?.(st.backgroundBlurriness);
        if (st.hdriEnabled) {
          if (st.customHdrUrl && typeof envStudioRestore.loadHDRFile === 'function') {
            envStudioRestore.loadHDRFile(st.customHdrUrl).catch(() => {});
          } else if (st.currentHdriPreset && typeof envStudioRestore.setHdriPreset === 'function') {
            envStudioRestore.setHdriPreset(st.currentHdriPreset);
          } else {
            envStudioRestore.enableHdri?.(true);
          }
        } else if (st.hdriEnabled === false) {
          envStudioRestore.enableHdri?.(false);
        }
        envStudioRestore.enableBackdrop?.(Boolean(st.backdropEnabled), st.backdropColor || undefined);
        envStudioRestore.enableSky?.(Boolean(st.skyEnabled), st.skyParams || {});
        if (typeof st.fogEnabled === 'boolean') {
          envStudioRestore.enableFog?.(st.fogEnabled, st.fogParams || {});
        }
        if (typeof st.shadowCatcherEnabled === 'boolean') {
          envStudioRestore.enableShadowCatcher?.(st.shadowCatcherEnabled, { opacity: st.shadowCatcherOpacity });
        }
        if (st.lookDevPreset && this._engine?.rasterRenderer?.setPreset) {
          this._engine.rasterRenderer.setPreset(st.lookDevPreset);
        }
        if (typeof window !== 'undefined') {
          window.app?.shadingPopover?._updateActiveStates?.();
        }
      } catch (envErr) {
        console.warn('[StudioExporter] Environment restore warning:', envErr?.message || envErr);
      }
    } else if (envStudioRestore && !data.environment?.studio) {
      try {
        envStudioRestore.enableBackdrop?.(false);
        envStudioRestore.enableSky?.(false);
        envStudioRestore.enableShadowCatcher?.(false);
        if (typeof window !== 'undefined') window.app?.shadingPopover?._updateActiveStates?.();
      } catch (_) {}
    }

    // v3: full Three.js scene graph (hierarchy, skins, materials, textures,
    // lights, cameras, per-object animation clips).
    if (data.sceneGraph) {
      const loaded = preloadedGraph;
      if (loaded) {
        this._rehydrateUserDataTypes(loaded);
        // Older files may contain viewport light gizmos; the live scene
        // regenerates them on selection.
        const stray = [];
        loaded.traverse((node) => {
          if (node.userData && node.userData.isLightHelper) stray.push(node);
        });
        stray.forEach((node) => node.parent && node.parent.remove(node));
      }
      const children = loaded ? [...loaded.children] : [];
      let count = 0;
      let hasRestoredPbrTextures = false;
      const TEX_SLOTS = ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'alphaMap', 'emissiveMap', 'bumpMap'];
      children.forEach((child) => {
        child.traverse((node) => {
          if (!node.isMesh) return;
          count += 1;
          if (!node.isSkinnedMesh) ensureBVH(node);
          if (node.material) {
            const mats = Array.isArray(node.material) ? node.material : [node.material];
            for (const m of mats) {
              if (!m) continue;
              for (const slot of TEX_SLOTS) {
                if (m[slot]) {
                  m[slot].needsUpdate = true;
                  hasRestoredPbrTextures = true;
                }
              }
              if (!m.userData?.isDefaultClay && !m.isMeshMatcapMaterial) {
                hasRestoredPbrTextures = true;
              }
              m.needsUpdate = true;
            }
            node.userData = node.userData || {};
            if (!node.userData.__importedMaterial && mats.some((m) => m && !m.userData?.isDefaultClay && !m.isMeshMatcapMaterial)) {
              node.userData.__importedMaterial = Array.isArray(node.material)
                ? node.material.map((m) => m?.clone?.() || m)
                : (node.material.clone?.() || node.material);
            }
          }
        });
        if (sm && typeof sm.addObject === 'function') {
          sm.addObject(child, null, false, false);
        } else {
          scene.add(child);
        }
      });

      // If project contains real PBR/textured assets and MatCap Solid mode was active on screen,
      // switch off MatCap so restored materials immediately display instead of looking gray!
      if (hasRestoredPbrTextures && typeof window !== 'undefined' && window.matcapStudio?.isMatCapActive) {
        window.matcapStudio.toggleMatCapMode(false);
      }

      // v4: khôi phục source geometry của modifier stack để stack còn editable.
      if (data.modifierSources && loaded) {
        const restoreRoot = (sm && sm.rootContainer) || scene;
        restoreRoot.traverse((node) => {
          const encoded = data.modifierSources[node.uuid];
          if (node.isMesh && encoded) {
            // A single unreadable source must not abort the whole import.
            try {
              node.userData.baseGeometry = decodeGeometry(encoded);
              node.userData.stackRevision = 0;
            } catch (err) {
              console.warn('[StudioExporter] Skipped corrupted modifier source:', err.message);
            }
          }
        });
      }

      if (loaded) this._restoreViewportCamera(data.camera);

        const timeline = this._resolveTimelineEngine();
        if (loaded && timeline) {
          if (data.timelineConfig && typeof data.timelineConfig === 'object') {
            const tc = data.timelineConfig;
            if (Number.isFinite(tc.fps)) timeline.fps = tc.fps;
            if (Number.isFinite(tc.startFrame)) timeline.startFrame = tc.startFrame;
            if (Number.isFinite(tc.endFrame)) timeline.endFrame = tc.endFrame;
            if (typeof tc.loop === 'boolean') timeline.loop = tc.loop;
            if (typeof tc.defaultInterpolation === 'string') timeline.defaultInterpolation = tc.defaultInterpolation;
            if (Number.isFinite(tc.currentFrame)) timeline.currentFrame = tc.currentFrame;
            timeline.emit?.('rangeChanged', { startFrame: timeline.startFrame, endFrame: timeline.endFrame, fps: timeline.fps });
          }
          // Children were re-parented into rootContainer, so `loaded` is empty
          // by now. Resolve ids against the live scene instead.
          const restoreRoot = (sm && sm.rootContainer) || scene;
          const byUserId = new Map();
          restoreRoot.traverse((node) => {
            const id = node.userData?.id;
            if (id) byUserId.set(id, node);
          });
          if (Array.isArray(data.timeline) && typeof timeline.restoreTracks === 'function') {
            // Corrupt timeline data degrades to "no animation", not a failed import.
            try {
              timeline.restoreTracks(data.timeline, (id) => byUserId.get(id) || null);
            } catch (err) {
              console.warn('[StudioExporter] Skipped corrupted timeline:', err.message);
            }
          }
          if (data.animationData && typeof timeline.restoreAnimationData === 'function') {
            try {
              timeline.restoreAnimationData(data.animationData, (id, fallbackName) => {
                if (byUserId.has(id)) return byUserId.get(id);
                let byName = null;
                if (fallbackName) {
                  restoreRoot.traverse((n) => { if (!byName && n.name === fallbackName) byName = n; });
                }
                return byName;
              });
            } catch (err) {
              console.warn('[StudioExporter] Skipped corrupted animationData:', err.message);
            }
          }
          if (typeof timeline.attachClip === 'function') {
            restoreRoot.traverse((node) => {
              if (Array.isArray(node.animations)) {
                node.animations.forEach((clip) => {
                  try { timeline.attachClip(node, clip); } catch (_) { /* orphan track */ }
                });
              }
            });
          }
        }

      const restoreRoot = (sm && sm.rootContainer) || scene;
      dataBlockRegistry.fromJSON(data.dataBlocks || null, restoreRoot);
      if (data.collectionsData && sm?.collectionManager) {
        sm.collectionManager.fromJSON(data.collectionsData);
      }
      if (data.paintStacks) {
        restoreScenePaintStacksSync(restoreRoot, data.paintStacks, { dataBlockRegistry });
      }
      hydrateMaterialShaderGraphs(restoreRoot);

      const instSys = this._engine?.instancingSystem || (typeof window !== 'undefined' ? window.instancingSystem : null);
      if (instSys) {
        instSys.rehydrateScene(restoreRoot, data.scatterGroups || null);
      }

      const simRestore = this._engine?.simulationManager || (typeof window !== 'undefined' ? window.simulationManager : null);
      if (simRestore) {
        let hasImportedPhysics = Boolean(data.physicsWorld);
        if (!hasImportedPhysics && restoreRoot?.traverse) {
          restoreRoot.traverse((n) => {
            if (n.userData?.physics) hasImportedPhysics = true;
          });
        }
        if (data.physicsWorld) {
          try {
            const pw = data.physicsWorld;
            if (pw.gravity) simRestore.setGravity?.(pw.gravity.x, pw.gravity.y, pw.gravity.z);
            if (typeof pw.groundEnabled === 'boolean') simRestore.setGroundEnabled?.(pw.groundEnabled, pw.groundY);
          } catch (_) {}
        }
        if (hasImportedPhysics && typeof simRestore.ensureInit === 'function') {
          simRestore.ensureInit().catch(() => {});
        }
      }

      sm?.clearHistory?.();
      if (typeof window !== 'undefined') {
        window.outliner?.render?.();
        window.dispatchEvent(new CustomEvent('blender:sceneUpdated'));
        window.dispatchEvent(new CustomEvent('blender:project-imported', {
          detail: {
            count,
            schema: data.meta?.schemaVersion || CURRENT_PROJECT_SCHEMA,
            migratedFrom: migration.migrated ? migration.sourceVersion : null,
          }
        }));
      }
      console.log(`[StudioExporter] Restored v${data.meta?.schemaVersion || CURRENT_PROJECT_SCHEMA} scene graph with ${count} meshes.`);
      return {
        success: true,
        count,
        schema: data.meta?.schemaVersion || CURRENT_PROJECT_SCHEMA,
        sourceSchema: migration.sourceVersion,
        migratedFrom: migration.migrated ? migration.sourceVersion : null,
        warnings: migration.warnings,
      };
    }

    // Legacy v2 path: flat mesh/lights arrays.
    let importedCount = 0;
    if (Array.isArray(data.objects)) {
      for (const item of data.objects) {
        let geom;
        const geomParams = item.geometry ? item.geometry.parameters || {} : {};
        const geomType = item.geometry ? item.geometry.type : 'BoxGeometry';

        switch (geomType) {
          case 'BoxGeometry':
            geom = new THREE.BoxGeometry(geomParams.width || 1, geomParams.height || 1, geomParams.depth || 1);
            break;
          case 'SphereGeometry':
            geom = new THREE.SphereGeometry(geomParams.radius || 0.5, geomParams.widthSegments || 32, geomParams.heightSegments || 24);
            break;
          case 'CylinderGeometry':
            geom = new THREE.CylinderGeometry(geomParams.radiusTop || 0.5, geomParams.radiusBottom || 0.5, geomParams.height || 1, geomParams.radialSegments || 32);
            break;
          case 'ConeGeometry':
            geom = new THREE.ConeGeometry(geomParams.radius || 0.5, geomParams.height || 1, geomParams.radialSegments || 32);
            break;
          case 'TorusGeometry':
            geom = new THREE.TorusGeometry(geomParams.radius || 0.7, geomParams.tube || 0.2, geomParams.radialSegments || 24, geomParams.tubularSegments || 48);
            break;
          case 'PlaneGeometry':
            geom = new THREE.PlaneGeometry(geomParams.width || 2, geomParams.height || 2);
            break;
          default:
            geom = new THREE.BoxGeometry(1, 1, 1);
            break;
        }

        // Material reconstruction
        const matInfo = item.material || {};
        const mat = new THREE.MeshStandardMaterial({
          color: matInfo.color ? new THREE.Color(matInfo.color) : 0x3498db,
          roughness: matInfo.roughness !== undefined ? matInfo.roughness : 0.45,
          metalness: matInfo.metalness !== undefined ? matInfo.metalness : 0.15,
          wireframe: !!matInfo.wireframe,
          opacity: matInfo.opacity !== undefined ? matInfo.opacity : 1.0,
          transparent: !!matInfo.transparent,
          emissive: matInfo.emissive ? new THREE.Color(matInfo.emissive) : 0x000000,
          emissiveIntensity: matInfo.emissiveIntensity !== undefined ? matInfo.emissiveIntensity : 1.0
        });

        const mesh = new THREE.Mesh(geom, mat);
        mesh.name = item.name || 'ImportedMesh';
        mesh.castShadow = true;
        mesh.receiveShadow = true;

        if (Array.isArray(item.position)) mesh.position.set(item.position[0], item.position[1], item.position[2]);
        if (Array.isArray(item.rotation)) mesh.rotation.set(item.rotation[0], item.rotation[1], item.rotation[2]);
        if (Array.isArray(item.scale)) mesh.scale.set(item.scale[0], item.scale[1], item.scale[2]);

        if (sm && typeof sm.addObject === 'function') {
          sm.addObject(mesh, null, false, true);
        } else {
          scene.add(mesh);
        }
        importedCount++;
      }
    }
    this._restoreViewportCamera(data.camera);
    dataBlockRegistry.syncFromScene((sm && sm.rootContainer) || scene);

    // Trigger Outliner & Inspector UI refresh events if available
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('blender:project-imported', {
        detail: { count: importedCount, schema: data.meta?.schemaVersion || 2, migratedFrom: migration.migrated ? migration.sourceVersion : null }
      }));
    }

    console.log(`[StudioExporter] Successfully imported ${importedCount} objects from project file.`);
    return {
      success: true,
      count: importedCount,
      schema: data.meta?.schemaVersion || 2,
      sourceSchema: migration.sourceVersion,
      migratedFrom: migration.migrated ? migration.sourceVersion : null,
      warnings: migration.warnings,
    };
  }

  // =========================================================================
  // 4. HIGH-RES RENDER / SCREENSHOT TO PNG
  // =========================================================================

  /**
   * Capture a high-resolution screenshot/render of the 3D viewport
   * @param {Object} [options]
   * @param {number} [options.scale=2] Multiplier (1 = viewport size, 2 = 2K/Retina, 4 = 4K)
   * @param {boolean} [options.transparent=false] Transparent alpha background
   * @param {string} [options.filename] Auto-generated if omitted
   * @param {boolean} [options.download=true]
   * @returns {Promise<{ dataUrl: string, blob: Blob, width: number, height: number }>}
   */
  async captureRenderPNG(options = {}) {
    const {
      scale = 2,
      transparent = false,
      filename = null,
      download = true,
      camera: overrideCamera = null
    } = options;

    const renderer = this.renderer;
    const scene = this.scene;
    const camera = overrideCamera || this.camera;
    const origCameraAspect = camera.aspect;

    const domCanvas = renderer.domElement;
    const origWidth = domCanvas.clientWidth || window.innerWidth;
    const origHeight = domCanvas.clientHeight || window.innerHeight;
    const origPixelRatio = renderer.getPixelRatio();
    const origBg = scene.background;

    const targetWidth = Math.round(origWidth * scale);
    const targetHeight = Math.round(origHeight * scale);

    try {
      // Temporarily hide helpers/gizmos if active (excluding Scene_Collection root)
      const hiddenHelpers = [];
      const helperRoots = new Set([
        'Selection_Helpers', 'ModalTransform_Helpers', 'Blender_3D_Cursor',
        'Blender_Measure_Helper', 'EditMode_GizmoProxy', 'Floor_Grid', 'Camera.Frustum'
      ]);
      scene.traverse((child) => {
        const isHelperRoot = helperRoots.has(child.name)
          || child.type === 'TransformControlsGizmo'
          || child.type === 'TransformControlsPlane';
        if (isHelperRoot || (child.name !== 'Scene_Collection' && child.userData && (child.userData.isHelper || (child.userData.isSystemObject && !child.children.length)))) {
          if (child.visible) {
            child.visible = false;
            hiddenHelpers.push(child);
          }
        }
      });

      // Handle transparent background
      if (transparent) {
        scene.background = null;
        renderer.setClearAlpha(0);
      }

      // Update camera aspect & projection
      camera.aspect = targetWidth / targetHeight;
      camera.updateProjectionMatrix();

      // Set target render size
      renderer.setPixelRatio(1);
      renderer.setSize(targetWidth, targetHeight, false);
      if (renderer.shadowMap) {
        renderer.shadowMap.needsUpdate = true;
      }

      const eng = this.engine || (typeof window !== 'undefined' ? (window.engine || window.studioEngine) : null);
      const usePost = Boolean(
        !transparent &&
        eng?.rasterRenderer &&
        eng.rasterRenderer.preset !== 'fast' &&
        eng.rasterRenderer.postProcessing?.enabled
      );

      // Force render frame. The engine loop runs with autoClear=false and a
      // separate orthographic gizmo pass, so clear explicitly and freeze the
      // pixels synchronously before any await can let the loop overwrite them.
      renderer.setRenderTarget(null);
      if (usePost) {
        eng.rasterRenderer.setSize(targetWidth, targetHeight, 1);
        eng.rasterRenderer.renderFrame({ scene, camera, delta: 0.016 });
      } else {
        renderer.clear();
        renderer.render(scene, camera);
      }
      const snapshot = document.createElement('canvas');
      snapshot.width = domCanvas.width;
      snapshot.height = domCanvas.height;
      snapshot.getContext('2d').drawImage(domCanvas, 0, 0);

      // Extract image data
      const dataUrl = snapshot.toDataURL('image/png');
      let blob = null;

      // Generate filename if needed
      const now = new Date();
      const pad = (n) => String(n).padStart(2, '0');
      const dateStr = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
      const actualFilename = filename || `render_${targetWidth}x${targetHeight}_${dateStr}.png`;

      if (download) {
        // Download the exact bitmap captured above. Re-snapshotting the live
        // canvas via toBlob races the render loop (resize/clear between frames)
        // and previously produced empty PNGs.
        blob = await (await fetch(dataUrl)).blob();
        if (blob) this.triggerDownload(blob, actualFilename);
      }

      // Restore original state
      scene.background = origBg;
      renderer.setClearAlpha(1.0);
      renderer.setPixelRatio(origPixelRatio);
      renderer.setSize(origWidth, origHeight, false);
      if (usePost) {
        eng.rasterRenderer.setSize(origWidth, origHeight, origPixelRatio);
      }
      camera.aspect = origCameraAspect;
      camera.updateProjectionMatrix();

      // Restore helpers
      hiddenHelpers.forEach((h) => { h.visible = true; });

      // Trigger one more normal render to sync viewport
      if (usePost) {
        eng.rasterRenderer.renderFrame({ scene, camera, delta: 0.016 });
      } else {
        renderer.render(scene, camera);
      }

      return {
        dataUrl,
        blob,
        width: targetWidth,
        height: targetHeight,
        filename: actualFilename
      };
    } catch (err) {
      // Always restore original settings on error
      scene.background = origBg;
      renderer.setPixelRatio(origPixelRatio);
      renderer.setSize(origWidth, origHeight, false);
      camera.aspect = origCameraAspect;
      camera.updateProjectionMatrix();
      console.error('[StudioExporter] Failed to capture render:', err);
      throw err;
    }
  }

  captureViewport(options = {}) {
    return this.captureRenderPNG(options);
  }

  // Helper to load Three.js addons with CDN fallback (unpkg -> jsdelivr -> esm.sh)
  async _loadAddon(subpath) {
    try {
      return await import(`three/addons/${subpath}`);
    } catch (e1) {
      console.warn(`[StudioExporter] Failed to load addon from three/addons/${subpath}, trying jsdelivr CDN...`, e1);
      try {
        return await import(`https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/${subpath}`);
      } catch (e2) {
        console.warn(`[StudioExporter] jsdelivr failed, trying esm.sh...`, e2);
        return await import(`https://esm.sh/three@0.160.0/examples/jsm/${subpath}`);
      }
    }
  }

  // =========================================================================
  // 5. glTF 2.0 EXPORTER (.glb / .gltf) - Full Scene / PBR / Rig / Anim
  // =========================================================================

  /**
   * Export the scene or selected object to glTF 2.0 (Binary .glb or JSON .gltf)
   * Supports PBR materials, SkinnedMesh / Skeleton / Bones, and Animations.
   * @param {THREE.Object3D|null} target - Target object or null for full scene
   * @param {Object} [options]
   * @param {boolean} [options.binary=true] - true for .glb, false for .gltf
   * @param {string} [options.filename] - Custom output filename
   * @param {boolean} [options.download=true] - Trigger browser download
   * @param {Array<THREE.AnimationClip>} [options.animations] - Explicit animations
   * @param {boolean} [options.embedImages=true] - Embed textures
   * @param {boolean} [options.onlyVisible=true] - Export only visible objects
   * @returns {Promise<{blob: Blob, buffer?: ArrayBuffer, json?: string, filename: string}>}
   */
  async exportGLTF(target = null, options = {}) {
    const binary = options.binary !== false;
    const defaultExt = binary ? 'glb' : 'gltf';
    const filename = options.filename || `blender_export.${defaultExt}`;
    const download = options.download !== false;
    const embedImages = options.embedImages !== false;
    const onlyVisible = options.onlyVisible !== false;
    const quiet = options.quiet === true;

    // Load Three.js GLTFExporter
    const { GLTFExporter } = await this._loadAddon('exporters/GLTFExporter.js');
    const exporter = new GLTFExporter();

    if (this._exportInProgress) {
      throw Object.assign(new Error('Another glTF/GLB export is already in progress.'), { code: 'E_BUSY' });
    }
    const signal = options.signal || null;
    if (signal?.aborted) {
      throw Object.assign(new Error('glTF/GLB export aborted'), { name: 'AbortError' });
    }
    this._exportInProgress = true;

    let exportTarget = target;
    if (!exportTarget) {
      exportTarget = this.sceneManager && this.sceneManager.rootContainer ? this.sceneManager.rootContainer : this.scene;
    }

    const restoreExportState = this._prepareExportState(exportTarget, 'gltf', { hideHelpers: true });
    let restoreGltfOpt = () => {};
    let restored = false;
    const restoreAll = () => {
      if (restored) return;
      restored = true;
      try { restoreGltfOpt(); } catch (_) {}
      try { restoreExportState(); } catch (_) {}
      this._exportInProgress = false;
      if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
        try { window.dispatchEvent(new CustomEvent('studio:exportSettled')); } catch (_) {}
      }
    };

    let exportableClips = [];
    try {
      if (options.optimize !== false) {
        restoreGltfOpt = this._prepareOptimizedGltfExport(exportTarget, options);
      }

      // Gather animation clips
      let clips = [];
      if (options.animations && Array.isArray(options.animations)) {
        clips = options.animations;
      } else if (exportTarget.animations && exportTarget.animations.length > 0) {
        clips = exportTarget.animations;
      } else {
        const timeline = this._resolveTimelineEngine();
        if (timeline) {
          const extractedClip = this._extractTimelineClip(timeline, exportTarget);
          if (extractedClip) clips.push(extractedClip);
        }
      }

      const knownClips = new Set(clips);
      exportTarget.traverse((node) => {
        if (!node.animations || node.animations.length === 0) return;
        node.animations.forEach((clip) => {
          if (!clip || knownClips.has(clip) || !clip.tracks || clip.tracks.length === 0) return;
          knownClips.add(clip);
          clips.push(clip);
        });
      });

      exportableClips = clips
        .map((clip) => {
          const tracks = (clip.tracks || []).filter((track) => {
            if (!track?.times || track.times.length === 0 || !track?.values || track.values.length === 0) {
              return false;
            }
            try {
              const { nodeName } = THREE.PropertyBinding.parseTrackName(track.name);
              return !!THREE.PropertyBinding.findNode(exportTarget, nodeName);
            } catch (e) {
              return false;
            }
          });
          if (tracks.length === 0) {
            console.warn(`[StudioExporter] Skipped empty clip "${clip.name}" during glTF export`);
            return null;
          }
          if (tracks.length !== clip.tracks.length) {
            console.warn(
              `[StudioExporter] Clip "${clip.name}": skipped ${clip.tracks.length - tracks.length} orphaned track(s) outside export scope`
            );
            return new THREE.AnimationClip(clip.name, clip.duration, tracks, clip.blendMode);
          }
          return clip;
        })
        .filter(Boolean);
    } catch (prepErr) {
      restoreAll();
      throw prepErr;
    }

    const exporterOptions = {
      binary: binary,
      embedImages: embedImages,
      animations: exportableClips,
      onlyVisible: onlyVisible,
      truncateDrawRange: true,
      maxTextureSize: Math.max(64, Math.min(4096, Number(options.maxTextureSize) || 1024)),
    };

    return new Promise((resolve, reject) => {
      let aborted = false;
      const onAbort = () => {
        aborted = true;
        // Defer restoreAll() & mutex unlock until GLTFExporter.parse() actually settles,
        // preventing use-after-dispose of temp geometries/textures and overlapping export jobs.
        reject(Object.assign(new Error('glTF/GLB export aborted'), { name: 'AbortError' }));
      };
      if (signal?.aborted) {
        restoreAll();
        return reject(Object.assign(new Error('glTF/GLB export aborted'), { name: 'AbortError' }));
      }
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
      const clearAbort = () => { if (signal) signal.removeEventListener('abort', onAbort); };
      try {
        exporter.parse(
          exportTarget,
          (result) => {
            clearAbort();
            restoreAll();
            if (aborted || signal?.aborted) return;

            if (binary) {
              const blob = new Blob([result], { type: 'model/gltf-binary' });
              if (download) this.triggerDownload(blob, filename);
              if (!quiet) this.showToast(`Exported ${filename} (${(blob.size / 1024).toFixed(1)} KB)`, 'success');
              resolve({ blob, buffer: result, filename });
            } else {
              const jsonStr = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
              const blob = new Blob([jsonStr], { type: 'model/gltf+json' });
              if (download) this.triggerDownload(blob, filename);
              if (!quiet) this.showToast(`Exported ${filename} (${(blob.size / 1024).toFixed(1)} KB)`, 'success');
              resolve({ blob, json: jsonStr, filename });
            }
          },
          (error) => {
            clearAbort();
            restoreAll();
            if (aborted || signal?.aborted) return;
            console.error('[StudioExporter] glTF export failed:', error);
            this.showToast(`glTF export failed: ${error.message || error}`, 'error');
            reject(error);
          },
          exporterOptions
        );
      } catch (syncErr) {
        clearAbort();
        restoreAll();
        if (!aborted) reject(syncErr);
      }
    });
  }

  /**
   * Non-destructive general-purpose glTF/GLB export optimizer:
   * 1. Deduplicates identical Standard/Physical materials so GLTFExporter doesn't duplicate textures.
   * 2. Reuses opaque roughnessMaps as metalnessMap when metalness===0 (avoids per-material PNG re-baking in Three GLTFExporter).
   * 3. Encodes opaque Canvas/Data textures as JPEG (10x smaller than PNG) while keeping PNG for alpha/transparent materials.
   * 4. Welds & indexes large static non-indexed BufferGeometries for ~60-70% smaller geometry chunks.
   */
  _prepareOptimizedGltfExport(exportTarget, options = {}) {
    const restoreMatRefs = [];
    const restoreMatProps = [];
    const restoreTexMimes = new Map();
    const restoreGeoms = [];
    const tempGeoms = [];
    const tempTextures = [];

    const imgIds = new WeakMap();
    let nextImgId = 1;
    const getImgId = (tex) => {
      if (!tex) return '0';
      const src = tex.image || tex;
      let id = imgIds.get(src);
      if (!id) {
        id = String(nextImgId++);
        imgIds.set(src, id);
      }
      const rx = tex.repeat ? tex.repeat.x.toFixed(4) : '1';
      const ry = tex.repeat ? tex.repeat.y.toFixed(4) : '1';
      const ox = tex.offset ? tex.offset.x.toFixed(4) : '0';
      const oy = tex.offset ? tex.offset.y.toFixed(4) : '0';
      const rot = Number(tex.rotation ?? 0).toFixed(4);
      const cx = tex.center ? tex.center.x.toFixed(4) : '0';
      const cy = tex.center ? tex.center.y.toFixed(4) : '0';
      return `${id}@${rx},${ry},${ox},${oy},${rot},${cx},${cy},${tex.flipY ? 1 : 0},${tex.channel ?? 0},${tex.wrapS},${tex.wrapT},${tex.magFilter},${tex.minFilter},${tex.colorSpace || ''}`;
    };

    const colorHex = (c) => (c?.getHexString ? c.getHexString() : '');
    const vec2Str = (v) => (v ? `${Number(v.x).toFixed(3)},${Number(v.y).toFixed(3)}` : '');

    const materialSignature = (m) => {
      if (!m || (!m.isMeshStandardMaterial && !m.isMeshPhysicalMaterial)) return null;
      const base = [
        m.type,
        colorHex(m.color),
        Number(m.roughness ?? 0.5).toFixed(4),
        Number(m.metalness ?? 0).toFixed(4),
        colorHex(m.emissive),
        Number(m.emissiveIntensity ?? 0).toFixed(4),
        m.side,
        m.transparent ? 1 : 0,
        Number(m.opacity ?? 1).toFixed(4),
        Number(m.alphaTest ?? 0).toFixed(4),
        m.vertexColors ? 1 : 0,
        m.flatShading ? 1 : 0,
        m.depthWrite ? 1 : 0,
        m.depthTest ? 1 : 0,
        Number(m.aoMapIntensity ?? 1).toFixed(3),
        Number(m.bumpScale ?? 1).toFixed(3),
        Number(m.displacementScale ?? 1).toFixed(3),
        vec2Str(m.normalScale),
        getImgId(m.map),
        getImgId(m.normalMap),
        getImgId(m.roughnessMap),
        getImgId(m.metalnessMap),
        getImgId(m.emissiveMap),
        getImgId(m.aoMap),
        getImgId(m.alphaMap),
        getImgId(m.bumpMap),
        getImgId(m.displacementMap),
      ];
      if (m.isMeshPhysicalMaterial) {
        base.push(
          Number(m.clearcoat ?? 0).toFixed(4),
          Number(m.clearcoatRoughness ?? 0).toFixed(4),
          vec2Str(m.clearcoatNormalScale),
          Number(m.sheen ?? 0).toFixed(4),
          Number(m.sheenRoughness ?? 1).toFixed(4),
          colorHex(m.sheenColor),
          Number(m.transmission ?? 0).toFixed(4),
          Number(m.thickness ?? 0).toFixed(4),
          Number(m.ior ?? 1.5).toFixed(4),
          Number(m.attenuationDistance ?? Infinity).toFixed(4),
          colorHex(m.attenuationColor),
          Number(m.iridescence ?? 0).toFixed(4),
          Number(m.iridescenceIOR ?? 1.3).toFixed(4),
          Array.isArray(m.iridescenceThicknessRange) ? m.iridescenceThicknessRange.join(',') : '',
          Number(m.anisotropy ?? 0).toFixed(4),
          Number(m.anisotropyRotation ?? 0).toFixed(4),
          Number(m.specularIntensity ?? 1).toFixed(4),
          colorHex(m.specularColor),
          getImgId(m.clearcoatMap),
          getImgId(m.clearcoatRoughnessMap),
          getImgId(m.clearcoatNormalMap),
          getImgId(m.sheenColorMap),
          getImgId(m.sheenRoughnessMap),
          getImgId(m.transmissionMap),
          getImgId(m.thicknessMap),
          getImgId(m.iridescenceMap),
          getImgId(m.iridescenceThicknessMap),
          getImgId(m.anisotropyMap),
          getImgId(m.specularIntensityMap),
          getImgId(m.specularColorMap),
        );
      }
      return base.join('|');
    };

    const canonicalMats = new Map();
    const indexedGeomCache = new Map();
    const useJpegForColor = options.textureFormat !== 'png';
    const allowLossyDataMaps = options.lossyDataMaps === true;
    const deduplicateMaterials = options.deduplicateMaterials !== false;
    const packedMetalRoughCache = new Map();

    const getPackedMetalRough = (roughTex) => {
      if (!roughTex?.image || typeof document === 'undefined') return roughTex;
      const cacheKey = getImgId(roughTex);
      if (packedMetalRoughCache.has(cacheKey)) return packedMetalRoughCache.get(cacheKey);
      try {
        const w = roughTex.image.width || 0;
        const h = roughTex.image.height || 0;
        if (!w || !h) return roughTex;
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(roughTex.image, 0, 0, w, h);
        const imgData = ctx.getImageData(0, 0, w, h);
        const d = imgData.data;
        // glTF metallicRoughness: G = roughness, B = 255 (1.0 * metallicFactor)
        for (let i = 0; i < d.length; i += 4) {
          d[i + 2] = 255;
          d[i + 3] = 255;
        }
        ctx.putImageData(imgData, 0, 0);
        const packed = new THREE.CanvasTexture(canvas);
        packed.wrapS = roughTex.wrapS;
        packed.wrapT = roughTex.wrapT;
        packed.magFilter = roughTex.magFilter;
        packed.minFilter = roughTex.minFilter;
        packed.anisotropy = roughTex.anisotropy;
        packed.repeat.copy(roughTex.repeat);
        packed.offset.copy(roughTex.offset);
        packed.center.copy(roughTex.center);
        packed.rotation = roughTex.rotation;
        packed.flipY = roughTex.flipY;
        packed.channel = roughTex.channel;
        // Data maps (roughness/metalness) ALWAYS stay lossless PNG unless explicitly overridden
        packed.userData = { mimeType: allowLossyDataMaps ? 'image/jpeg' : 'image/png' };
        packedMetalRoughCache.set(cacheKey, packed);
        tempTextures.push(packed);
        return packed;
      } catch (_) {
        return roughTex;
      }
    };

    const restoreMatSlotOverrides = [];
    const maxTexSize = Math.max(64, Math.min(4096, Number(options.maxTextureSize) || 1024));
    const resizedDataTexCache = new WeakMap();
    const downscaleOversizedDataTex = (tex, isDataSlot) => {
      if (!tex || !tex.isDataTexture || !tex.image?.data || typeof document === 'undefined') return tex;
      const w = Number(tex.image.width || 0);
      const h = Number(tex.image.height || 0);
      if (w <= maxTexSize && h <= maxTexSize) return tex;
      if (resizedDataTexCache.has(tex)) return resizedDataTexCache.get(tex);
      try {
        const scale = Math.min(maxTexSize / w, maxTexSize / h);
        const dw = Math.max(1, Math.round(w * scale));
        const dh = Math.max(1, Math.round(h * scale));
        const srcC = document.createElement('canvas');
        srcC.width = w; srcC.height = h;
        const sCtx = srcC.getContext('2d');
        const clamped = tex.image.data instanceof Uint8ClampedArray
          ? tex.image.data
          : new Uint8ClampedArray(tex.image.data.buffer, tex.image.data.byteOffset, tex.image.data.byteLength);
        sCtx.putImageData(new ImageData(clamped, w, h), 0, 0);
        const dstC = document.createElement('canvas');
        dstC.width = dw; dstC.height = dh;
        const dCtx = dstC.getContext('2d');
        dCtx.imageSmoothingEnabled = true;
        dCtx.imageSmoothingQuality = 'high';
        dCtx.drawImage(srcC, 0, 0, dw, dh);
        const resized = new THREE.CanvasTexture(dstC);
        resized.wrapS = tex.wrapS; resized.wrapT = tex.wrapT;
        resized.repeat.copy(tex.repeat); resized.offset.copy(tex.offset);
        resized.rotation = tex.rotation; resized.center.copy(tex.center);
        resized.flipY = tex.flipY; resized.colorSpace = tex.colorSpace;
        resized.userData = { mimeType: isDataSlot ? 'image/png' : (tex.userData?.mimeType || 'image/jpeg') };
        resizedDataTexCache.set(tex, resized);
        tempTextures.push(resized);
        return resized;
      } catch (_) {
        return tex;
      }
    };

    const restoreFn = () => {
      for (const item of restoreMatSlotOverrides) item.mat[item.slot] = item.prev;
      for (const item of restoreMatRefs) item.obj.material = item.material;
      for (const item of restoreMatProps) {
        item.mat.metalnessMap = item.metalnessMap;
        item.mat.roughnessMap = item.roughnessMap;
      }
      for (const [tex, prevMime] of restoreTexMimes.entries()) {
        if (prevMime === undefined) delete tex.userData.mimeType;
        else tex.userData.mimeType = prevMime;
      }
      for (const item of restoreGeoms) item.obj.geometry = item.geometry;
      for (const g of tempGeoms) g.dispose();
      for (const t of tempTextures) t.dispose();
    };

    // Pre-scan all materials so any texture shared with a linear data-map slot is NEVER forced to lossy JPEG
    const DATA_SLOTS = [
      'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap',
      'clearcoatNormalMap', 'clearcoatRoughnessMap', 'clearcoatMap',
      'bumpMap', 'displacementMap', 'thicknessMap', 'transmissionMap',
      'specularIntensityMap', 'iridescenceMap', 'iridescenceThicknessMap',
      'anisotropyMap', 'sheenRoughnessMap', 'alphaMap'
    ];
    const dataMapTextures = new Set();
    exportTarget.traverse((obj) => {
      if (!(obj.isMesh || obj.isInstancedMesh) || !obj.material) return;
      const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
      for (const m of mats) {
        if (!m) continue;
        for (const slot of DATA_SLOTS) {
          if (m[slot]) dataMapTextures.add(m[slot]);
        }
      }
    });

    const touchMaterial = (m) => {
      if (!m) return m;
      const sig = deduplicateMaterials ? materialSignature(m) : null;
      let targetMat = m;
      if (sig) {
        if (canonicalMats.has(sig)) {
          targetMat = canonicalMats.get(sig);
        } else {
          canonicalMats.set(sig, m);
        }
      }
      if (!restoreMatProps.some((e) => e.mat === targetMat)) {
        const prevMetalMap = targetMat.metalnessMap;
        const prevRoughMap = targetMat.roughnessMap;
        let touched = false;
        if (targetMat.roughnessMap && !targetMat.metalnessMap) {
          if ((targetMat.metalness ?? 0) <= 0.001) {
            targetMat.metalnessMap = targetMat.roughnessMap;
            touched = true;
          } else {
            const packed = getPackedMetalRough(targetMat.roughnessMap);
            targetMat.roughnessMap = packed;
            targetMat.metalnessMap = packed;
            touched = true;
          }
        }
        if (touched) {
          restoreMatProps.push({ mat: targetMat, metalnessMap: prevMetalMap, roughnessMap: prevRoughMap });
        }

        // Resize oversized DataTextures cleanly via bilinear 2D canvas instead of letting GLTFExporter crop pixels
        for (const slot of ['map', 'emissiveMap', ...DATA_SLOTS]) {
          const curTex = targetMat[slot];
          if (curTex?.isDataTexture) {
            const resized = downscaleOversizedDataTex(curTex, DATA_SLOTS.includes(slot));
            if (resized !== curTex) {
              restoreMatSlotOverrides.push({ mat: targetMat, slot, prev: curTex });
              targetMat[slot] = resized;
            }
          }
        }

        const isOpaque = !targetMat.transparent && !targetMat.alphaMap && !(targetMat.alphaTest > 0) && (targetMat.opacity ?? 1) >= 0.999;
        // Color slots (map, emissiveMap, sheenColorMap, specularColorMap) use JPEG when opaque;
        // Data slots (normalMap, roughnessMap, metalnessMap, aoMap, clearcoatNormalMap, etc.) ALWAYS stay lossless PNG,
        // including when the same texture instance is shared across both color and data slots!
        const jpegSlots = allowLossyDataMaps
          ? ['map', 'emissiveMap', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap']
          : ['map', 'emissiveMap', 'sheenColorMap', 'specularColorMap'];
        if (useJpegForColor && isOpaque) {
          for (const slot of jpegSlots) {
            const tex = targetMat[slot];
            if (tex && tex.image && !restoreTexMimes.has(tex)) {
              if (!allowLossyDataMaps && dataMapTextures.has(tex)) continue;
              if (!tex.userData) tex.userData = {};
              restoreTexMimes.set(tex, tex.userData.mimeType);
              if (!tex.userData.mimeType) {
                tex.userData.mimeType = 'image/jpeg';
              }
            }
          }
        }
      }
      return targetMat;
    };

    const signal = options.signal || null;
    try {
      exportTarget.traverse((obj) => {
        if (signal?.aborted) {
          throw Object.assign(new Error('glTF/GLB export aborted'), { name: 'AbortError' });
        }
        if (!(obj.isMesh || obj.isInstancedMesh)) return;
        if (obj.material) {
          if (Array.isArray(obj.material)) {
            const orig = obj.material;
            const next = orig.map(touchMaterial);
            if (next.some((m, i) => m !== orig[i])) {
              restoreMatRefs.push({ obj, material: orig });
              obj.material = next;
            }
          } else {
            const orig = obj.material;
            const next = touchMaterial(orig);
            if (next !== orig) {
              restoreMatRefs.push({ obj, material: orig });
              obj.material = next;
            }
          }
        }

        const g = obj.geometry;
        if (
          options.indexGeometries !== false &&
          !obj.isSkinnedMesh &&
          g?.isBufferGeometry &&
          !g.index &&
          (!g.morphAttributes || Object.keys(g.morphAttributes).length === 0) &&
          (g.attributes?.position?.count || 0) >= 300
        ) {
          let indexed = indexedGeomCache.get(g.uuid);
          if (!indexed) {
            indexed = indexGeometry(g, {}, THREE);
            indexedGeomCache.set(g.uuid, indexed);
            if (indexed !== g) tempGeoms.push(indexed);
          }
          if (indexed !== g) {
            restoreGeoms.push({ obj, geometry: g });
            obj.geometry = indexed;
          }
        }
      });
    } catch (err) {
      restoreFn();
      throw err;
    }

    return restoreFn;
  }

  // =========================================================================
  // 6. STANFORD PLY EXPORTER (.ply)
  // =========================================================================

  /**
   * Export scene or active object to Stanford PLY format
   */
  async exportPLY(target = null, options = {}) {
    const {
      filename = 'model.ply',
      binary = true,
      download = true
    } = options;

    const { PLYExporter } = await this._loadAddon('exporters/PLYExporter.js');
    const exporter = new PLYExporter();
    const exportTarget = target || (this.sceneManager && this.sceneManager.rootContainer ? this.sceneManager.rootContainer : this.scene);
    const restoreExportState = this._prepareExportState(exportTarget, 'ply', { hideHelpers: true });

    return new Promise((resolve, reject) => {
      try {
        exporter.parse(
          exportTarget,
          (result) => {
            restoreExportState();
            const type = binary ? 'application/octet-stream' : 'text/plain;charset=utf-8';
            const blob = new Blob([result], { type });
            if (download) this.triggerDownload(blob, filename);
            this.showToast(`Exported ${filename} (${(blob.size / 1024).toFixed(1)} KB)`, 'success');
            resolve({ blob, result, filename });
          },
          (err) => {
            restoreExportState();
            this.showToast(`PLY export failed: ${err.message || err}`, 'error');
            reject(err);
          },
          { binary }
        );
      } catch (err) {
        restoreExportState();
        reject(err);
      }
    });
  }

  // =========================================================================
  // 6B. FULL FBX 7.4, APPLE AR USDZ, 3MF & GAME/MARKETPLACE PACK EXPORTERS
  // =========================================================================

  /**
   * Export scene or target object (meshes, materials, skins, blendshapes & clips) as Binary FBX 7.4 (or ASCII with format:'ascii').
   */
  exportFBX(target = null, options = {}) {
    const filename = options.filename || 'blender_export.fbx';
    const download = options.download !== false;
    const exportTarget = target || (this.sceneManager?.rootContainer || this.scene);

    return this._withExportableScene(exportTarget, 'fbx', () => {
      const timeline = this._resolveTimelineEngine();
      let animations = Array.isArray(options.animations) ? [...options.animations] : [];
      if (animations.length === 0 && timeline) {
        const extracted = this._extractTimelineClip(timeline, exportTarget);
        if (extracted) animations.push(extracted);
      }

      const res = exportSceneToFBX(exportTarget, { ...options, animations });
      const payload = res.format === 'ascii' && res.fbx != null ? res.fbx : res.bytes;
      const mime = res.format === 'ascii' ? 'text/plain;charset=utf-8' : 'application/octet-stream';
      const blob = new Blob([payload], { type: mime });
      if (download) this.triggerDownload(blob, filename);
      if (!options.quiet) {
        this.showToast(`Exported ${filename} (${res.meshCount} meshes · ${res.boneCount} bones · ${res.blendShapeCount} shapes)`, 'success');
      }
      return { ...res, blob, filename };
    });
  }

  async _loadDccBundle() {
    if (!this._dccBundlePromise) {
      this._dccBundlePromise = import('./dcc-bundle-importer.js');
    }
    return await this._dccBundlePromise;
  }

  /**
   * Export scene or target object to Apple AR Quick Look `.usdz` (64-byte aligned ZIP + USDA).
   */
  async exportUSDZ(target = null, options = {}) {
    const filename = options.filename || 'blender_export.usdz';
    const download = options.download !== false;
    const exportTarget = target || (this.sceneManager?.rootContainer || this.scene);

    const { USDZExporter } = await import('./usdz-exporter.js');
    return await this._withExportableSceneAsync(exportTarget, 'usdz', async () => {
      const exporter = new USDZExporter();
      const res = await exporter.parseAsync(exportTarget, options);
      const blob = new Blob([res.bytes], { type: 'model/vnd.usdz+zip' });
      if (download) this.triggerDownload(blob, filename);
      if (!options.quiet) {
        this.showToast(`Exported ${filename} (${(blob.size / 1024).toFixed(1)} KB · ${res.meshCount} meshes)`, 'success');
      }
      return { ...res, blob, filename };
    });
  }

  /**
   * Export scene or target object to 3MF (`.3mf`) for 3D printing slicers.
   */
  export3MF(target = null, options = {}) {
    const filename = options.filename || 'blender_export.3mf';
    const download = options.download !== false;
    const exportTarget = target || (this.sceneManager?.rootContainer || this.scene);

    return this._withExportableScene(exportTarget, '3mf', () => {
      const exporter = new ThreeMFExporter();
      const res = exporter.parse(exportTarget, options);
      const blob = new Blob([res.bytes], { type: 'model/3mf' });
      if (download) this.triggerDownload(blob, filename);
      if (!options.quiet) {
        this.showToast(`Exported ${filename} (${(blob.size / 1024).toFixed(1)} KB · ${res.triangleCount} tris)`, 'success');
      }
      return { ...res, blob, filename };
    });
  }

  /**
   * Export non-destructive Game/Marketplace `.glb` containing Auto-LODs,
   * `UCX_` convex collision hulls, and non-overlapping Lightmap `uv1` (`TEXCOORD_1`).
   */
  async exportGamePackGLB(target = null, options = {}) {
    const filename = options.filename || 'game_asset_pack.glb';
    const download = options.download !== false;
    const sourceRoot = target || (this.sceneManager?.rootContainer || this.scene);
    const { buildGamePackScene } = await import('./game-pack-exporter.js');
    const { group, report } = buildGamePackScene(sourceRoot, options);

    try {
      const gltfRes = await this.exportGLTF(group, {
        ...options,
        filename,
        download,
        binary: true,
        quiet: true,
      });
      if (!options.quiet) {
        this.showToast(
          `Game Pack ${filename}: ${report.lodMeshes} LODs · ${report.collisionMeshes} UCX hulls · ${report.lightmapUVCount} lightmap UV2`,
          'success'
        );
      }
      return { ...gltfRes, report };
    } finally {
      group.traverse((child) => {
        if (child.isMesh && child.geometry) child.geometry.dispose();
        if (child.userData?.isCollisionMesh && child.material) child.material.dispose();
      });
    }
  }

  // =========================================================================
  // 7. MULTI-FORMAT IMPORTERS (glTF/GLB, FBX, OBJ, STL, PLY, Collada DAE, .blend)
  // =========================================================================

  /**
   * Import glTF / GLB model (.glb, .gltf) with local Draco decoder support
   * @param {File|Blob|ArrayBuffer|string} input - File object, ArrayBuffer or URL
   * @param {Object} [options]
   */
  async importGLTF(input, options = {}) {
    const { GLTFLoader } = await this._loadAddon('loaders/GLTFLoader.js');
    const loader = new GLTFLoader();
    let dracoLoader = null;
    try {
      const { DRACOLoader } = await this._loadAddon('loaders/DRACOLoader.js');
      dracoLoader = new DRACOLoader();
      dracoLoader.setDecoderPath(options.dracoDecoderPath || './vendor/three/addons/libs/draco/gltf/');
      loader.setDRACOLoader(dracoLoader);
    } catch (_) {
      // Headless / minimal environment fallback without Draco worker
    }

    let url = null;
    let name = options.name || 'Imported_GLTF';

    if (input instanceof File || input instanceof Blob) {
      name = input.name || name;
      url = URL.createObjectURL(input);
    } else if (typeof input === 'string') {
      url = input;
      name = input.split('/').pop() || name;
    } else if (input instanceof ArrayBuffer || input instanceof Uint8Array) {
      const ab = input instanceof Uint8Array
        ? input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength)
        : input;
      return new Promise((resolve, reject) => {
        loader.parse(
          ab,
          '',
          (gltf) => {
            dracoLoader?.dispose();
            const loadedScene = gltf.scene || gltf.scenes[0];
            const vrmExt = gltf.parser?.json?.extensions?.VRM || gltf.parser?.json?.extensions?.VRMC_vrm || null;
            if (loadedScene && vrmExt) {
              loadedScene.userData = loadedScene.userData || {};
              loadedScene.userData.isVRM = true;
              loadedScene.userData.vrmMetadata = vrmExt.meta || null;
            }
            const root = this._integrateImportedObject(loadedScene, name, gltf.animations);
            resolve(root);
          },
          (err) => {
            dracoLoader?.dispose();
            reject(err);
          }
        );
      });
    }

    return new Promise((resolve, reject) => {
      loader.load(
        url,
        (gltf) => {
          dracoLoader?.dispose();
          if (input instanceof File || input instanceof Blob) {
            URL.revokeObjectURL(url);
          }
          const loadedScene = gltf.scene || gltf.scenes[0];
          const vrmExt = gltf.parser?.json?.extensions?.VRM || gltf.parser?.json?.extensions?.VRMC_vrm || null;
          if (loadedScene && vrmExt) {
            loadedScene.userData = loadedScene.userData || {};
            loadedScene.userData.isVRM = true;
            loadedScene.userData.vrmMetadata = vrmExt.meta || null;
          }
          const root = this._integrateImportedObject(loadedScene, name, gltf.animations);
          resolve(root);
        },
        undefined,
        (err) => {
          dracoLoader?.dispose();
          if (input instanceof File || input instanceof Blob) {
            URL.revokeObjectURL(url);
          }
          console.error('[StudioExporter] Failed to load GLTF:', err);
          this.showToast(`Failed to load GLTF: ${err.message || err}`, 'error');
          reject(err);
        }
      );
    });
  }

  /**
   * Import `.blend` file by converting via server.py headless Blender bridge -> GLB.
   */
  async importBlend(file, options = {}) {
    if (!file) throw new Error('importBlend requires a .blend File or Blob.');
    const buf = new Uint8Array(await file.arrayBuffer());
    let bin = '';
    const chunk = 0x8000;
    for (let i = 0; i < buf.length; i += chunk) {
      bin += String.fromCharCode.apply(null, buf.subarray(i, i + chunk));
    }
    const resp = await fetch(options.endpoint || '/api/import/blend', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fileName: file.name || 'scene.blend',
        fileData: btoa(bin),
        applyModifiers: Boolean(options.applyModifiers),
      }),
    });
    const payload = await resp.json().catch(() => ({}));
    if (!resp.ok || !payload.success || !payload.glbBase64) {
      const msg = payload.error || `HTTP ${resp.status}`;
      const hint = payload.hint ? ` (${payload.hint})` : '';
      this.showToast(`.blend import failed: ${msg}`, 'error');
      throw new Error(`${msg}${hint}`);
    }
    const glbBin = atob(payload.glbBase64);
    const glbBytes = new Uint8Array(glbBin.length);
    for (let i = 0; i < glbBin.length; i += 1) glbBytes[i] = glbBin.charCodeAt(i);
    const imported = await this.importGLTF(glbBytes.buffer, {
      ...options,
      name: payload.fileName || (file.name || 'scene').replace(/\.blend$/i, '.glb'),
    });
    if (payload.report?.warnings?.length) {
      console.warn('[BlendImport] Warnings:', payload.report.warnings);
    }
    return imported;
  }

  /**
   * Import FBX model (.fbx)
   * @param {File|Blob|ArrayBuffer|string} input
   */
  async importFBX(input, options = {}) {
    const { FBXLoader } = await this._loadAddon('loaders/FBXLoader.js');
    const loader = new FBXLoader();

    let url = null;
    let name = 'Imported_FBX';

    if (input instanceof File || input instanceof Blob) {
      name = input.name || name;
      url = URL.createObjectURL(input);
    } else if (typeof input === 'string') {
      url = input;
      name = input.split('/').pop() || name;
    } else if (input instanceof ArrayBuffer) {
      try {
        const fbxGroup = loader.parse(input, '');
        return this._integrateImportedObject(fbxGroup, name, fbxGroup.animations);
      } catch (err) {
        this.showToast(`Failed to parse FBX: ${err.message}`, 'error');
        throw err;
      }
    }

    return new Promise((resolve, reject) => {
      loader.load(
        url,
        (fbxGroup) => {
          if (input instanceof File || input instanceof Blob) URL.revokeObjectURL(url);
          const root = this._integrateImportedObject(fbxGroup, name, fbxGroup.animations);
          resolve(root);
        },
        undefined,
        (err) => {
          if (input instanceof File || input instanceof Blob) URL.revokeObjectURL(url);
          console.error('[StudioExporter] Failed to load FBX:', err);
          this.showToast(`Failed to load FBX: ${err.message || err}`, 'error');
          reject(err);
        }
      );
    });
  }

  /**
   * Import Wavefront OBJ (.obj) via high-speed Rust WASM parser (with optional `.mtl`,
   * ZBrush `#MRGB` polypaint, vertex colors, and VFS PBR texture resolution).
   * @param {File|Blob|Uint8Array|string} input
   * @param {Object} [options]
   */
  async importOBJ(input, options = {}) {
    const { VirtualAssetVFS, importDccWithRustWasm } = await this._loadDccBundle();
    const ownsVfs = !options.vfs;
    const vfs = options.vfs || new VirtualAssetVFS();
    let name = options.name || 'Imported_OBJ';

    try {
      if (options.mtl) {
        const mtlBytes = typeof options.mtl === 'string'
          ? strToU8(options.mtl)
          : (options.mtl instanceof Uint8Array ? options.mtl : new Uint8Array(await options.mtl.arrayBuffer()));
        vfs.addBytes('companion.mtl', mtlBytes);
      }

      if (input instanceof File || input instanceof Blob) {
        name = input.name || name;
        const bytes = new Uint8Array(await input.arrayBuffer());
        vfs.addBytes(name, bytes);
        const entry = vfs.resolve(name, { allowTextureStemFallback: false }) || vfs.entries[vfs.entries.length - 1];
        const obj3d = await importDccWithRustWasm(entry, vfs, name.replace(/\.[^/.]+$/, ''));
        return this._integrateImportedObject(obj3d, name);
      } else if (input instanceof Uint8Array || input instanceof ArrayBuffer) {
        const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
        vfs.addBytes(`${name}.obj`, bytes);
        const entry = vfs.entries[vfs.entries.length - 1];
        const obj3d = await importDccWithRustWasm(entry, vfs, name.replace(/\.[^/.]+$/, ''));
        return this._integrateImportedObject(obj3d, name);
      } else if (typeof input === 'string') {
        if (input.includes('v ') || input.includes('f ')) {
          vfs.addBytes(`${name}.obj`, strToU8(input));
          const entry = vfs.entries[vfs.entries.length - 1];
          const obj3d = await importDccWithRustWasm(entry, vfs, name.replace(/\.[^/.]+$/, ''));
          return this._integrateImportedObject(obj3d, name);
        }
        name = input.split('/').pop() || name;
        const resp = await fetch(input);
        if (!resp.ok) throw new Error(`Failed to fetch OBJ (${resp.status}): ${input}`);
        const bytes = new Uint8Array(await resp.arrayBuffer());
        vfs.addBytes(name, bytes);
        const entry = vfs.entries[vfs.entries.length - 1];
        const obj3d = await importDccWithRustWasm(entry, vfs, name.replace(/\.[^/.]+$/, ''));
        return this._integrateImportedObject(obj3d, name);
      }
      throw new Error('Unsupported OBJ input');
    } finally {
      if (ownsVfs) vfs.disposeBlobUrls();
    }
  }

  /**
   * Generic Rust WASM DCC / Studio / CAD single-file importer (`.3ds`, `.vox`, `.usda`, `.usdz`, `.dxf`, `.3mf`, `.off`, `.dae`).
   */
  async importDccFormat(input, extOverride = null, options = {}) {
    const { VirtualAssetVFS, importDccWithRustWasm } = await this._loadDccBundle();
    const ownsVfs = !options.vfs;
    const vfs = options.vfs || new VirtualAssetVFS();
    let name = options.name || `Imported_${String(extOverride || 'Model').toUpperCase()}`;

    try {
      if (input instanceof File || input instanceof Blob) {
        name = input.name || name;
        const fileName = name.includes('.') ? name : `${name}.${extOverride || 'obj'}`;
        const bytes = new Uint8Array(await input.arrayBuffer());
        vfs.addBytes(fileName, bytes);
      } else if (input instanceof Uint8Array || input instanceof ArrayBuffer) {
        const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
        const fileName = name.includes('.') ? name : `${name}.${extOverride || 'obj'}`;
        vfs.addBytes(fileName, bytes);
      } else if (typeof input === 'string') {
        if (input.startsWith('http://') || input.startsWith('https://') || input.startsWith('/') || input.startsWith('./')) {
          name = input.split('/').pop() || name;
          const resp = await fetch(input);
          if (!resp.ok) throw new Error(`HTTP ${resp.status} loading ${input}`);
          vfs.addBytes(name, new Uint8Array(await resp.arrayBuffer()));
        } else {
          const fileName = name.includes('.') ? name : `${name}.${extOverride || 'usda'}`;
          vfs.addBytes(fileName, strToU8(input));
        }
      } else {
        throw new Error('Unsupported DCC input type');
      }

      const entry = vfs.entries[vfs.entries.length - 1];
      const cleanRootName = (entry.path.split('/').pop() || name).replace(/\.[^/.]+$/, '');
      const obj3d = await importDccWithRustWasm(entry, vfs, cleanRootName);
      return this._integrateImportedObject(obj3d, cleanRootName);
    } finally {
      if (ownsVfs) vfs.disposeBlobUrls();
    }
  }

  async import3DS(input, options = {}) { return await this.importDccFormat(input, '3ds', options); }
  async importVOX(input, options = {}) { return await this.importDccFormat(input, 'vox', options); }
  async importUSD(input, options = {}) {
    const fname = String(input?.name || options.name || '').toLowerCase();
    const ext = fname.endsWith('.usdz') ? 'usdz' : 'usda';
    return await this.importDccFormat(input, ext, options);
  }
  async importDXF(input, options = {}) { return await this.importDccFormat(input, 'dxf', options); }
  async import3MF(input, options = {}) { return await this.importDccFormat(input, '3mf', options); }
  async importOFF(input, options = {}) { return await this.importDccFormat(input, 'off', options); }

  /**
   * Import STL (.stl) 3D printing format
   * @param {File|Blob|ArrayBuffer|string} input
   */
  async importSTL(input, options = {}) {
    const { STLLoader } = await this._loadAddon('loaders/STLLoader.js');
    const loader = new STLLoader();

    let name = 'Imported_STL';

    const createMeshFromGeom = (geometry, modelName) => {
      geometry.computeVertexNormals();
      const material = new THREE.MeshStandardMaterial({
        color: 0x8899aa,
        roughness: 0.5,
        metalness: 0.2
      });
      const mesh = new THREE.Mesh(geometry, material);
      return this._integrateImportedObject(mesh, modelName);
    };

    if (input instanceof File || input instanceof Blob) {
      name = input.name || name;
      const buffer = await input.arrayBuffer();
      const geometry = loader.parse(buffer);
      return createMeshFromGeom(geometry, name);
    } else if (input instanceof ArrayBuffer) {
      const geometry = loader.parse(input);
      return createMeshFromGeom(geometry, name);
    } else if (typeof input === 'string') {
      name = input.split('/').pop() || name;
      return new Promise((resolve, reject) => {
        loader.load(
          input,
          (geometry) => resolve(createMeshFromGeom(geometry, name)),
          undefined,
          reject
        );
      });
    }
  }

  /**
   * Import Stanford PLY (.ply)
   * @param {File|Blob|ArrayBuffer|string} input
   */
  async importPLY(input, options = {}) {
    const { PLYLoader } = await this._loadAddon('loaders/PLYLoader.js');
    const loader = new PLYLoader();
    let name = 'Imported_PLY';

    const createObjectFromGeom = (geometry, modelName) => {
      geometry.computeVertexNormals();
      let object;
      if (geometry.index || (geometry.attributes.position && geometry.attributes.position.count > 0 && geometry.hasAttribute('normal'))) {
        const material = new THREE.MeshStandardMaterial({
          color: 0x90a4ae,
          roughness: 0.5,
          vertexColors: geometry.hasAttribute('color')
        });
        object = new THREE.Mesh(geometry, material);
      } else {
        const material = new THREE.PointsMaterial({
          size: 0.05,
          vertexColors: geometry.hasAttribute('color'),
          color: 0x4fc3f7
        });
        object = new THREE.Points(geometry, material);
      }
      return this._integrateImportedObject(object, modelName);
    };

    if (input instanceof File || input instanceof Blob) {
      name = input.name || name;
      const buffer = await input.arrayBuffer();
      const geometry = loader.parse(buffer);
      return createObjectFromGeom(geometry, name);
    } else if (input instanceof ArrayBuffer) {
      const geometry = loader.parse(input);
      return createObjectFromGeom(geometry, name);
    } else if (typeof input === 'string') {
      name = input.split('/').pop() || name;
      return new Promise((resolve, reject) => {
        loader.load(
          input,
          (geometry) => resolve(createObjectFromGeom(geometry, name)),
          undefined,
          reject
        );
      });
    }
  }

  /**
   * Import Collada DAE (.dae) via Rust WASM XML parser (supports geometry, polylists, materials & companion textures)
   * @param {File|Blob|Uint8Array|string} input
   */
  async importDAE(input, options = {}) {
    return await this.importDccFormat(input, 'dae', options);
  }

  /**
   * Imports a `.zip` 3D asset pack OR a multi-file selection / dropped folder
   * (e.g. `plant.obj` + `plant.mtl` + `textures/*.jpg`, `scene.gltf` + `scene.bin` + `textures/*`,
   * `model.fbx` + `textures/*`, `model.3ds` + `*.jpg`), resolving all companion textures automatically.
   */
  async importBundle(filesOrArchive, options = {}) {
    const { VirtualAssetVFS, importDccWithRustWasm, RUST_DCC_EXTENSIONS, TEXTURE_EXTENSIONS } = await this._loadDccBundle();
    const vfs = new VirtualAssetVFS();
    let archiveName = options.name || 'Asset_Bundle';

    // Case 1: Single `.zip` / `.wbs` / `.usdz` / `.3mf` binary archive
    const isBinaryArchive = (filesOrArchive instanceof Uint8Array)
      || (filesOrArchive instanceof ArrayBuffer)
      || (filesOrArchive instanceof Blob && !(Array.isArray(filesOrArchive)));

    if (isBinaryArchive) {
      if (filesOrArchive.name) archiveName = filesOrArchive.name;
      const lowerName = archiveName.toLowerCase();
      if (lowerName.endsWith('.usdz')) return await this.importUSD(filesOrArchive, options);
      if (lowerName.endsWith('.3mf')) return await this.import3MF(filesOrArchive, options);
      if (lowerName.endsWith('.wbs')) return await this.importProjectPackage(filesOrArchive, options);

      const rawBytes = filesOrArchive instanceof Uint8Array
        ? filesOrArchive
        : (filesOrArchive instanceof ArrayBuffer
            ? new Uint8Array(filesOrArchive)
            : new Uint8Array(await filesOrArchive.arrayBuffer()));

      if (this._isZipBytes(rawBytes)) {
        const unzipped = unzipSync(rawBytes);
        // Check if this ZIP is actually a `.wbs` project archive
        if (unzipped['manifest.json']) {
          try {
            const mf = JSON.parse(strFromU8(unzipped['manifest.json']));
            if (mf?.meta?.format === 'web-blender-studio-project' || mf?.sceneGraph) {
              return await this.importProjectPackage(rawBytes, options);
            }
          } catch (_) {}
        }
        for (const [entryPath, entryBytes] of Object.entries(unzipped)) {
          vfs.addBytes(entryPath, entryBytes);
        }
      } else {
        return await this.importUniversal(filesOrArchive, options);
      }
    } else {
      // Case 2: Array of `File` or `{ file, path }` items from `<input multiple>` or folder Drag & Drop
      const rawList = Array.from(filesOrArchive || []);
      if (rawList.length === 0) return null;
      if (rawList.length === 1) {
        const single = rawList[0]?.file || rawList[0];
        return await this.importUniversal(single, options);
      }

      // Check if user selected multiple independent standalone models with NO companion `.mtl`/`.bin`/textures
      const normalizedItems = rawList.map((it) => (it?.file ? it : { file: it, path: it.webkitRelativePath || it.name }));
      const hasCompanionAssets = normalizedItems.some(({ path }) => {
        const ext = path.split('.').pop()?.toLowerCase() || '';
        return ext === 'mtl' || ext === 'bin' || TEXTURE_EXTENSIONS.has(ext);
      });
      if (!hasCompanionAssets) {
        let last = null;
        for (const { file } of normalizedItems) {
          last = await this.importUniversal(file, options);
        }
        return last;
      }

      for (const { file, path } of normalizedItems) {
        if (file.name.toLowerCase().endsWith('.zip')) {
          const zBytes = new Uint8Array(await file.arrayBuffer());
          const unzipped = unzipSync(zBytes);
          for (const [ep, eb] of Object.entries(unzipped)) vfs.addBytes(ep, eb);
        } else {
          vfs.addFile(file, path);
        }
      }
    }

    const primary = vfs.findPrimaryModel();
    if (!primary) {
      throw new Error('No supported 3D model file (.glb, .gltf, .fbx, .obj, .3ds, .dae, .usda, .vox, .dxf, .stl, .ply, .off) found inside bundle.');
    }

    const modelBaseName = (primary.path.split('/').pop() || archiveName).replace(/\.[^/.]+$/, '');

    try {
      // Route Rust-supported DCC / CAD / Studio formats directly through WASM + VFS texture builder
      if (RUST_DCC_EXTENSIONS.has(primary.ext)) {
        const obj3d = await importDccWithRustWasm(primary, vfs, modelBaseName);
        return this._integrateImportedObject(obj3d, modelBaseName);
      }

      // Route `.gltf` / `.glb` / `.vrm` with external `.bin` & texture map VFS URL modifier
      if (primary.ext === 'gltf' || primary.ext === 'glb' || primary.ext === 'vrm') {
        const { GLTFLoader } = await this._loadAddon('loaders/GLTFLoader.js');
        for (const e of vfs.entries) {
          if (e !== primary) await vfs.getBlobUrl(e);
        }
        const manager = new THREE.LoadingManager();
        manager.setURLModifier((reqUrl) => {
          if (!reqUrl || /^(data:|blob:)/i.test(reqUrl)) return reqUrl;
          const hit = vfs.resolve(reqUrl);
          if (hit && vfs._blobUrls.has(hit.lowerPath)) {
            return vfs._blobUrls.get(hit.lowerPath);
          }
          return reqUrl;
        });
        const loader = new GLTFLoader(manager);
        let draco = null;
        try {
          const { DRACOLoader } = await this._loadAddon('loaders/DRACOLoader.js');
          draco = new DRACOLoader();
          draco.setDecoderPath('./vendor/three/addons/libs/draco/gltf/');
          loader.setDRACOLoader(draco);
        } catch (_) {}
        try {
          const mainUrl = await vfs.getBlobUrl(primary);
          const gltf = await loader.loadAsync(mainUrl);
          const loadedScene = gltf.scene || gltf.scenes?.[0];
          return this._integrateImportedObject(loadedScene, modelBaseName, gltf.animations);
        } finally {
          draco?.dispose?.();
        }
      }

      // Route `.fbx` with external texture map VFS URL modifier (strips stale `C:\...\textures\` paths!)
      if (primary.ext === 'fbx') {
        const { FBXLoader } = await this._loadAddon('loaders/FBXLoader.js');
        for (const e of vfs.entries) {
          if (e !== primary && TEXTURE_EXTENSIONS.has(e.ext)) await vfs.getBlobUrl(e);
        }
        const manager = new THREE.LoadingManager();
        manager.setURLModifier((reqUrl) => {
          if (!reqUrl || /^(data:|blob:)/i.test(reqUrl)) return reqUrl;
          const hit = vfs.resolve(reqUrl);
          if (hit && vfs._blobUrls.has(hit.lowerPath)) {
            return vfs._blobUrls.get(hit.lowerPath);
          }
          return reqUrl;
        });
        const loader = new FBXLoader(manager);
        const mainUrl = await vfs.getBlobUrl(primary);
        const fbxGroup = await loader.loadAsync(mainUrl);
        return this._integrateImportedObject(fbxGroup, modelBaseName, fbxGroup.animations);
      }

      // Fallback for `.stl`, `.ply`, `.blend` inside ZIP
      const primaryBytes = await vfs.getBytes(primary);
      const asFile = new File([primaryBytes], primary.base, { type: 'application/octet-stream' });
      return await this.importUniversal(asFile, options);
    } finally {
      vfs.disposeBlobUrls();
    }
  }

  /**
   * Universal Model Importer: routes automatically by file extension
   * @param {File} file
   */
  async importUniversal(file, options = {}) {
    if (!file || !file.name) {
      throw new Error('Invalid file provided to importUniversal');
    }

    const ext = file.name.split('.').pop().toLowerCase();
    console.log(`[StudioExporter] Universal Import detected extension: .${ext} for file: ${file.name}`);

    switch (ext) {
      case 'glb':
      case 'gltf':
      case 'vrm':
        return await this.importGLTF(file, options);
      case 'fbx':
        return await this.importFBX(file, options);
      case 'obj':
        return await this.importOBJ(file, options);
      case '3ds':
        return await this.import3DS(file, options);
      case 'vox':
        return await this.importVOX(file, options);
      case 'usda':
      case 'usd':
      case 'usdz':
        return await this.importUSD(file, options);
      case 'dxf':
        return await this.importDXF(file, options);
      case '3mf':
        return await this.import3MF(file, options);
      case 'off':
      case 'coff':
        return await this.importOFF(file, options);
      case 'zip':
        return await this.importBundle(file, options);
      case 'stl':
        return await this.importSTL(file, options);
      case 'ply':
        return await this.importPLY(file, options);
      case 'dae':
        return await this.importDAE(file, options);
      case 'blend':
        return await this.importBlend(file, options);
      case 'json':
      case 'web3d':
      case 'wbs':
        return await this.importProjectJSON(file, options);
      case 'hdr':
      case 'exr':
        if (typeof window !== 'undefined' && window.app?.environmentStudio?.loadHDRFile) {
          await window.app.environmentStudio.loadHDRFile(file);
          this.showToast(`Loaded HDRI environment: ${file.name}`, 'success');
          return true;
        }
        break;
      default:
        if (IMAGE_FILE_EXTENSIONS.has(ext)) {
          const camera = this._camera || (typeof window !== 'undefined' ? window.engine?.camera : null);
          const sm = this._sceneManager || (typeof window !== 'undefined' ? window.sceneManager : null);
          const sc = this._scene || (typeof window !== 'undefined' ? (window.scene || window.engine?.scene) : null);
          const mesh = await createImageObject({
            file,
            mode: options.imageMode || 'reference',
            align: options.align || 'view',
            width: options.width || 4,
            opacity: options.opacity,
            camera,
            sceneManager: sm,
            scene: sc,
          });
          this.showToast(`Added image: ${file.name}`, 'success');
          return mesh;
        }
        throw new Error(`Unsupported file extension: .${ext}. Supported: .glb, .gltf, .vrm, .fbx, .obj, .stl, .ply, .dae, .blend, .wbs, .blend.json, .hdr, .png, .jpg, .webp`);
    }
  }

  /**
   * Universal Viewport Drag & Drop Setup
   */
  setupUniversalDragAndDrop(domContainer = null) {
    if (typeof document === 'undefined') return;
    const container = domContainer || document.getElementById('viewport-container') || document.getElementById('viewport') || document.body;
    if (!container || container._hasDndSetup) return;
    container._hasDndSetup = true;

    // Create or find overlay
    let overlay = document.getElementById('viewport-drop-overlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'viewport-drop-overlay';
      overlay.className = 'viewport-drop-overlay';
      overlay.innerHTML = `
        <div class="drop-icon">📥</div>
        <div class="drop-title">Drop 3D Asset, Folder or .ZIP Pack</div>
        <div class="drop-subtitle">Supports .zip, .glb, .gltf, .fbx, .obj+.mtl, .3ds, .vox, .usda/.usdz, .dae, .dxf, .3mf, .stl, .ply, .off, .blend, .wbs</div>
      `;
      container.appendChild(overlay);
    }

    let dragCounter = 0;

    container.addEventListener('dragenter', (e) => {
      e.preventDefault();
      e.stopPropagation();
      dragCounter++;
      overlay.classList.add('active');
    });

    container.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = 'copy';
      overlay.classList.add('active');
    });

    container.addEventListener('dragleave', (e) => {
      e.preventDefault();
      e.stopPropagation();
      dragCounter--;
      if (dragCounter <= 0) {
        dragCounter = 0;
        overlay.classList.remove('active');
      }
    });

    container.addEventListener('drop', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      dragCounter = 0;
      overlay.classList.remove('active');

      const { extractDroppedItems } = await this._loadDccBundle();
      const droppedItems = await extractDroppedItems(e.dataTransfer);
      if (!droppedItems || droppedItems.length === 0) return;

      try {
        if (droppedItems.length > 1 || droppedItems[0].file.name.toLowerCase().endsWith('.zip')) {
          this.showToast(`Importing asset bundle (${droppedItems.length} file${droppedItems.length > 1 ? 's' : ''})...`, 'info');
          await this.importBundle(droppedItems);
        } else {
          const file = droppedItems[0].file;
          this.showToast(`Importing ${file.name}...`, 'info');
          await this.importUniversal(file);
        }
      } catch (err) {
        console.error('[StudioExporter] Drop import error:', err);
        this.showToast(`Import failed: ${err.message}`, 'error');
      }
    });
  }

  // =========================================================================
  // HELPER METHODS: Animation extraction, Toast, Object integration
  // =========================================================================

  _extractTimelineClip(timelineEngine, target) {
    if (!timelineEngine) return null;

    const inScope = (obj) => Boolean(obj) && (!target || target === this.scene || target === obj || this._isDescendantOf(obj, target));
    const hasTracks = timelineEngine.tracks && timelineEngine.tracks.size > 0;
    const hasNla = timelineEngine.nlaTracks && timelineEngine.nlaTracks.size > 0;
    const hasDrivers = timelineEngine.driverManager && Array.isArray(timelineEngine.driverManager.drivers) && timelineEngine.driverManager.drivers.length > 0;
    if (!hasTracks && !hasNla && !hasDrivers) {
      return null;
    }

    const fps = timelineEngine.fps || 30;
    const startF = Number.isFinite(timelineEngine.startFrame) ? timelineEngine.startFrame : 0;
    const endF = Number.isFinite(timelineEngine.endFrame) ? timelineEngine.endFrame : 60;

    // Detect if any scoped object uses non-linear Bezier F-Curves, extrapolation, NLA strips, or Drivers
    let needsSampledBake = false;
    const scopedEntries = [];
    const collectBonesForObj = (obj) => {
      const bones = [];
      const pushUnique = (b) => { if (b?.isBone && b.name && !bones.includes(b)) bones.push(b); };
      obj.skeleton?.bones?.forEach(pushUnique);
      obj.userData?.skeleton?.bones?.forEach(pushUnique);
      obj.traverse?.((c) => pushUnique(c));
      return bones;
    };

    if (hasTracks) {
      for (const [uuid, trackData] of timelineEngine.tracks.entries()) {
        const obj = trackData.object;
        if (!inScope(obj)) continue;
        if (trackData.fcurveMeta && Object.values(trackData.fcurveMeta).some((m) => m?.extrapolation && m.extrapolation !== 'constant')) {
          needsSampledBake = true;
        }
        if (trackData.keyframes?.some((k) => k.handles && Object.keys(k.handles).length > 0)) {
          needsSampledBake = true;
        }
        if (trackData.boneTracks) {
          for (const bt of trackData.boneTracks.values()) {
            if (bt.rotationTrack?.some((k) => k.handles || k.eulerModified) || bt.positionTrack?.some((k) => k.handles)) {
              needsSampledBake = true;
            }
          }
        }
        scopedEntries.push(obj);
      }
    }

    if (hasNla) {
      for (const [uuid, nlaList] of timelineEngine.nlaTracks.entries()) {
        if (!Array.isArray(nlaList) || nlaList.length === 0) continue;
        let obj = timelineEngine._nlaObjectRefs?.get(uuid) || timelineEngine.tracks?.get(uuid)?.object || null;
        if (!obj && target?.traverse) {
          target.traverse((o) => { if (!obj && o.uuid === uuid) obj = o; });
        }
        if (inScope(obj)) {
          needsSampledBake = true;
          if (!scopedEntries.includes(obj)) scopedEntries.push(obj);
        }
      }
    }

    if (hasDrivers) {
      for (const drv of timelineEngine.driverManager.drivers) {
        if (!drv.enabled) continue;
        const obj = timelineEngine.driverManager._resolveObject?.(drv.targetUuid, drv.targetName) || null;
        if (inScope(obj)) {
          needsSampledBake = true;
          if (!scopedEntries.includes(obj)) scopedEntries.push(obj);
        }
      }
    }

    if (needsSampledBake && scopedEntries.length > 0 && endF >= startF) {
      const span = Math.max(1, endF - startF);
      const step = Math.max(1, Math.ceil(span / 240));
      const origFrame = timelineEngine.currentFrame;

      // Save current object + bone transforms for non-destructive bake
      const saved = scopedEntries.map((obj) => ({
        obj,
        pos: obj.position.clone(),
        quat: obj.quaternion.clone(),
        scale: obj.scale.clone(),
        bones: collectBonesForObj(obj).map((b) => ({ b, pos: b.position.clone(), quat: b.quaternion.clone() })),
      }));

      const times = [];
      const buffers = saved.map((entry) => ({
        obj: entry.obj,
        targetPath: entry.obj.name || `Object_${entry.obj.uuid.slice(0, 8)}`,
        pos: [],
        quat: [],
        scale: [],
        bones: entry.bones.map((be) => ({ b: be.b, pos: [], quat: [] })),
      }));

      for (let f = startF; f <= endF; f += step) {
        times.push((f - startF) / fps);
        timelineEngine.evaluate(f);
        for (const buf of buffers) {
          buf.pos.push(buf.obj.position.x, buf.obj.position.y, buf.obj.position.z);
          buf.quat.push(buf.obj.quaternion.x, buf.obj.quaternion.y, buf.obj.quaternion.z, buf.obj.quaternion.w);
          buf.scale.push(buf.obj.scale.x, buf.obj.scale.y, buf.obj.scale.z);
          for (const bb of buf.bones) {
            bb.pos.push(bb.b.position.x, bb.b.position.y, bb.b.position.z);
            bb.quat.push(bb.b.quaternion.x, bb.b.quaternion.y, bb.b.quaternion.z, bb.b.quaternion.w);
          }
        }
      }

      // Restore non-destructively
      for (const s of saved) {
        s.obj.position.copy(s.pos);
        s.obj.quaternion.copy(s.quat);
        s.obj.scale.copy(s.scale);
        for (const be of s.bones) {
          be.b.position.copy(be.pos);
          be.b.quaternion.copy(be.quat);
          be.b.updateMatrixWorld(true);
        }
        s.obj.updateMatrixWorld(true);
      }
      timelineEngine.currentFrame = origFrame;

      const tracks = [];
      if (times.length > 0) {
        for (const buf of buffers) {
          tracks.push(new THREE.VectorKeyframeTrack(`${buf.targetPath}.position`, times, buf.pos));
          tracks.push(new THREE.QuaternionKeyframeTrack(`${buf.targetPath}.quaternion`, times, buf.quat));
          tracks.push(new THREE.VectorKeyframeTrack(`${buf.targetPath}.scale`, times, buf.scale));
          for (const bb of buf.bones) {
            tracks.push(new THREE.QuaternionKeyframeTrack(`${bb.b.name}.quaternion`, times, bb.quat));
            tracks.push(new THREE.VectorKeyframeTrack(`${bb.b.name}.position`, times, bb.pos));
          }
        }
      }
      if (tracks.length === 0) return null;
      return new THREE.AnimationClip('WebBlenderAction', Math.max(times[times.length - 1] || 0, 0.033), tracks);
    }

    if (!hasTracks) return null;

    const tracks = [];
    let maxTime = 0;

    for (const [uuid, trackData] of timelineEngine.tracks.entries()) {
      const obj = trackData.object;
      if (!inScope(obj)) continue;

      const targetPath = obj.name || `Object_${uuid.slice(0, 8)}`;

      if (trackData.keyframes && trackData.keyframes.length > 0) {
        const sorted = [...trackData.keyframes].sort((a, b) => a.frame - b.frame);
        const times = [];
        const posValues = [];
        const rotValues = [];
        const scaleValues = [];

        let hasPos = false, hasRot = false, hasScale = false;

        for (const kf of sorted) {
          const t = kf.frame / fps;
          times.push(t);
          if (t > maxTime) maxTime = t;

          if (kf.position) {
            hasPos = true;
            posValues.push(kf.position.x || 0, kf.position.y || 0, kf.position.z || 0);
          }
          if (kf.quaternion) {
            hasRot = true;
            rotValues.push(kf.quaternion.x || 0, kf.quaternion.y || 0, kf.quaternion.z || 0, kf.quaternion.w !== undefined ? kf.quaternion.w : 1);
          } else if (kf.rotation) {
            hasRot = true;
            const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(kf.rotation.x || 0, kf.rotation.y || 0, kf.rotation.z || 0));
            rotValues.push(q.x, q.y, q.z, q.w);
          }
          if (kf.scale) {
            hasScale = true;
            scaleValues.push(kf.scale.x !== undefined ? kf.scale.x : 1, kf.scale.y !== undefined ? kf.scale.y : 1, kf.scale.z !== undefined ? kf.scale.z : 1);
          }
        }

        if (hasPos && posValues.length === times.length * 3) {
          tracks.push(new THREE.VectorKeyframeTrack(`${targetPath}.position`, times, posValues));
        }
        if (hasRot && rotValues.length === times.length * 4) {
          tracks.push(new THREE.QuaternionKeyframeTrack(`${targetPath}.quaternion`, times, rotValues));
        }
        if (hasScale && scaleValues.length === times.length * 3) {
          tracks.push(new THREE.VectorKeyframeTrack(`${targetPath}.scale`, times, scaleValues));
        }
      }

      if (trackData.boneTracks && trackData.boneTracks.size > 0) {
        for (const [boneName, bData] of trackData.boneTracks.entries()) {
          const bPath = `${boneName}.quaternion`;
          if (bData.rotationTrack && bData.rotationTrack.length > 0) {
            const sortedB = [...bData.rotationTrack].sort((a, b) => a.frame - b.frame);
            const bTimes = [];
            const bQuatVals = [];
            for (const bkf of sortedB) {
              const t = bkf.frame / fps;
              bTimes.push(t);
              if (t > maxTime) maxTime = t;
              if (bkf.quaternion) {
                bQuatVals.push(bkf.quaternion.x, bkf.quaternion.y, bkf.quaternion.z, bkf.quaternion.w);
              } else if (bkf.rotation) {
                const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(bkf.rotation.x, bkf.rotation.y, bkf.rotation.z));
                bQuatVals.push(q.x, q.y, q.z, q.w);
              }
            }
            if (bQuatVals.length === bTimes.length * 4) {
              tracks.push(new THREE.QuaternionKeyframeTrack(bPath, bTimes, bQuatVals));
            }
          }
          if (bData.positionTrack && bData.positionTrack.length > 0) {
            const sortedP = [...bData.positionTrack].sort((a, b) => a.frame - b.frame);
            const pTimes = [];
            const pVals = [];
            for (const pkf of sortedP) {
              const t = pkf.frame / fps;
              pTimes.push(t);
              if (t > maxTime) maxTime = t;
              if (pkf.position) {
                pVals.push(pkf.position.x || 0, pkf.position.y || 0, pkf.position.z || 0);
              }
            }
            if (pVals.length === pTimes.length * 3) {
              tracks.push(new THREE.VectorKeyframeTrack(`${boneName}.position`, pTimes, pVals));
            }
          }
        }
      }
    }

    if (tracks.length === 0) return null;
    return new THREE.AnimationClip('WebBlenderAction', Math.max(maxTime, 0.033), tracks);
  }

  /**
   * GLTFLoader phải đổi tên node khi tên bị trùng (import lần 2, nhân bản):
   * `mixamorigHips` → `mixamorigHips_001`. Track của clip vẫn mang tên cũ nên
   * AnimationMixer không tìm thấy node → hoạt cảnh im lặng không chạy. Hàm này
   * ánh xạ lại tên track, chỉ khi có **đúng một** node khớp tiền tố.
   * @param {THREE.Object3D} root
   * @param {THREE.AnimationClip} clip
   * @returns {THREE.AnimationClip} clip gốc hoặc clip đã đổi tên track
   */
  _remapClipTrackNames(root, clip) {
    if (!root || !clip || !Array.isArray(clip.tracks) || clip.tracks.length === 0) return clip;

    const names = [];
    root.traverse((node) => { if (node.name) names.push(node.name); });

    let changed = false;
    const tracks = clip.tracks.map((track) => {
      let nodeName;
      try {
        ({ nodeName } = THREE.PropertyBinding.parseTrackName(track.name));
      } catch (err) {
        return track;
      }
      if (!nodeName || THREE.PropertyBinding.findNode(root, nodeName)) return track;

      const matches = names.filter((name) => name.startsWith(`${nodeName}_`) && /^_\d+$/.test(name.slice(nodeName.length)));
      if (matches.length !== 1) return track;

      changed = true;
      const renamed = track.clone();
      renamed.name = `${matches[0]}${track.name.slice(nodeName.length)}`;
      return renamed;
    });

    if (!changed) return clip;
    return new THREE.AnimationClip(clip.name, clip.duration, tracks, clip.blendMode);
  }

  _isDescendantOf(child, parent) {
    let cur = child.parent;
    while (cur) {
      if (cur === parent) return true;
      cur = cur.parent;
    }
    return false;
  }

  _integrateImportedObject(loadedObject, name = 'Imported_Model', animations = []) {
    const sm = this.sceneManager;
    if (!loadedObject) return null;

    if (!loadedObject.name || loadedObject.name === 'Scene' || loadedObject.name === '') {
      loadedObject.name = sm ? sm.generateUniqueName(name.replace(/\.[^/.]+$/, '')) : name;
    } else if (sm) {
      loadedObject.name = sm.generateUniqueName(loadedObject.name);
    }

    let hasImportedTextureOrColor = false;
    loadedObject.traverse((child) => {
      if (child.isMesh) {
        child.castShadow = true;
        child.receiveShadow = true;
        if (child.material) {
          child.material.needsUpdate = true;
          if (!child.userData.__importedMaterial) {
            child.userData.__importedMaterial = Array.isArray(child.material)
              ? child.material.map((m) => m?.clone?.() || m)
              : (child.material.clone?.() || child.material);
          }
          const mats = Array.isArray(child.material) ? child.material : [child.material];
          if (mats.some((m) => m && (m.map || m.vertexColors || !m.userData?.isDefaultClay))) {
            hasImportedTextureOrColor = true;
          }
        }
      }
    });

    // If MatCap viewport override was active, switch off MatCap so imported PBR textures display immediately
    if (hasImportedTextureOrColor && typeof window !== 'undefined' && window.matcapStudio?.isMatCapActive) {
      window.matcapStudio.toggleMatCapMode(false);
    }

    if (animations && animations.length > 0) {
      // Import lần thứ hai cùng tên model khiến GLTFLoader thêm hậu tố vào tên
      // xương; đổi tên track cho khớp để mixer vẫn bind được.
      const usableAnimations = animations.map((clip) => this._remapClipTrackNames(loadedObject, clip));
      loadedObject.animations = usableAnimations;
      const timeline = this._resolveTimelineEngine();
      if (timeline) {
        // Gắn clip đầu tiên để nút Play của timeline phát được ngay sau khi import.
        if (typeof timeline.attachClip === 'function') {
          timeline.attachClip(loadedObject, usableAnimations[0]);
        }
        timeline.emit('animationsImported', { object: loadedObject, animations: usableAnimations });
      }
    }

    if (sm) {
      sm.addObject(loadedObject, null, true, true);
      if (typeof sm.select === 'function') {
        sm.select(loadedObject);
      }
    } else {
      this.scene.add(loadedObject);
    }

    this.showToast(`Imported "${loadedObject.name}" successfully!`, 'success');

    // Auto-build BVH for O(log V) raycasting & enable Rust WASM Auto-LOD on medium/high-poly static imports
    let totalTris = 0;
    let hasSkinned = false;
    loadedObject.traverse((child) => {
      if (child.isMesh && child.geometry?.attributes?.position) {
        if (child.isSkinnedMesh) hasSkinned = true;
        else ensureBVH(child);
        const g = child.geometry;
        totalTris += g.index ? Math.floor(g.index.count / 3) : Math.floor(g.attributes.position.count / 3);
      }
    });
    if (totalTris >= 4500 && totalTris <= 150000 && !hasSkinned) {
      const lodMgr = this._engine?.lodManager || (typeof window !== 'undefined' ? window.lodManager : null);
      if (lodMgr) {
        lodMgr.enableAutoLOD(loadedObject).catch(() => {});
      }
    } else if (totalTris > 150000 && typeof document !== 'undefined') {
      this._offerHeavyAssetAutoLOD(loadedObject, totalTris);
    }

    return loadedObject;
  }

  _offerHeavyAssetAutoLOD(targetObject, totalTris) {
    if (typeof document === 'undefined') return;
    document.getElementById('wbs-autolod-offer-banner')?.remove();
    const banner = document.createElement('div');
    banner.id = 'wbs-autolod-offer-banner';
    banner.style.cssText = 'position:fixed;bottom:34px;right:18px;z-index:9500;background:#1e242b;color:#e6edf3;border:1px solid #00b894;border-radius:6px;padding:10px 12px;font-size:12px;box-shadow:0 8px 24px rgba(0,0,0,0.45);display:flex;align-items:center;gap:10px;max-width:420px;';
    const label = document.createElement('span');
    label.textContent = `⚡ Heavy mesh (${totalTris.toLocaleString()} tris). Enable 3-tier Rust Auto-LOD?`;
    const btnEnable = document.createElement('button');
    btnEnable.textContent = 'Enable Auto-LOD';
    btnEnable.style.cssText = 'background:#00b894;color:#0b1416;border:none;border-radius:4px;padding:4px 9px;font-size:11px;font-weight:600;cursor:pointer;white-space:nowrap;';
    const btnClose = document.createElement('button');
    btnClose.textContent = '✕';
    btnClose.style.cssText = 'background:transparent;color:#999;border:none;cursor:pointer;font-size:12px;padding:2px 4px;';
    btnEnable.onclick = async () => {
      banner.remove();
      const lodMgr = this._engine?.lodManager || (typeof window !== 'undefined' ? window.lodManager : null);
      if (lodMgr) {
        const res = await lodMgr.enableAutoLOD(targetObject);
        if (res) {
          this.showToast(`Auto-LOD enabled: ${res.lod0Tris.toLocaleString()} → ${res.lod1Tris.toLocaleString()} → ${res.lod2Tris.toLocaleString()} tris`, 'success');
          window.inspector?.render?.();
        }
      }
    };
    btnClose.onclick = () => banner.remove();
    banner.append(label, btnEnable, btnClose);
    document.body.appendChild(banner);
    setTimeout(() => { if (banner.parentNode) banner.remove(); }, 12000);
  }

  showToast(message, type = 'info') {
    if (typeof document === 'undefined') return;
    let container = document.getElementById('blender-toast-container');
    if (!container) {
      container = document.createElement('div');
      container.id = 'blender-toast-container';
      container.className = 'blender-toast-container';
      document.body.appendChild(container);
    }

    const toast = document.createElement('div');
    toast.className = `blender-toast blender-toast-${type}`;
    const icon = type === 'success' ? '✓' : (type === 'error' || type === 'warning' || type === 'warn') ? '⚠' : 'ℹ';
    const iconSpan = document.createElement('span');
    iconSpan.className = 'toast-icon';
    iconSpan.textContent = icon;
    const textSpan = document.createElement('span');
    textSpan.className = 'toast-text';
    textSpan.textContent = String(message ?? '');
    toast.append(iconSpan, textSpan);
    container.appendChild(toast);

    setTimeout(() => {
      toast.classList.add('visible');
    }, 10);

    setTimeout(() => {
      toast.classList.remove('visible');
      setTimeout(() => {
        if (toast.parentNode) toast.parentNode.removeChild(toast);
      }, 300);
    }, 4000);
  }

  // =========================================================================
  // UTILITIES & DOWNLOAD TRIGGER
  // =========================================================================

  /**
   * Programmatically triggers a browser file download
   */
  triggerDownload(blob, filename) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  /**
   * Open file dialog to load .blend.json or .web3d project file
   */
  promptImportFile() {
    return new Promise((resolve, reject) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.json,.blend.json,.web3d,.wbs';
      input.onchange = async (e) => {
        const file = e.target.files && e.target.files[0];
        if (!file) return resolve(null);
        try {
          const res = await this.importProjectJSON(file);
          resolve(res);
        } catch (err) {
          reject(err);
        }
      };
      input.click();
    });
  }
}

// Global Singleton Instance
export const studioExporter = new StudioExporter();

// Expose globally for UI menus & console commands
if (typeof window !== 'undefined') {
  window.StudioExporter = StudioExporter;
  window.studioExporter = studioExporter;
}

export default studioExporter;
