/**
 * @file uv-editor.js
 * @description Blender-Standard Interactive UV Editor & Texture Alignment Tool.
 * Supports LSCM / Smart UV / Cube / Cylinder / Sphere / Project-from-View unwrapping,
 * island packing, texel density equalization, vertex/edge/face/island selection,
 * UV Sync Selection, Pinning (P / Alt+P), Live Unwrap, Stretch overlay,
 * 3D Checkerboard preview, HiDPI ResizeObserver scaling (Bottom Dock + Corner-Split),
 * and interactive Modal G/R/S transforms with X/Y axis lock and numeric entry.
 */

import * as THREE from 'three';
import {
  pointSpatialKey,
  normalizeSeamSet,
  extractUVIslandsFromGeometry,
  averageIslandsScaleInPlace,
  packUVIslandsInPlace,
  unwrapMeshLSCM,
  smartUVProjectGeometry,
  cubeProjectGeometry,
  cylinderProjectGeometry,
  sphereProjectGeometry,
  resetUVsGeometry,
  computeUVStretch,
  countFlippedUVTriangles,
  renderUVCheckerToCanvas,
  applyUVGeometryUpdate,
  cloneGeometrySnapshot
} from '../core/geometry/uv-unwrap.js';
import { MeshEditCommand } from '../core/edit-mode.js';

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function pointToSegmentDistSq(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  if (lenSq < 1e-12) return (px - ax) * (px - ax) + (py - ay) * (py - ay);
  const t = clamp(((px - ax) * dx + (py - ay) * dy) / lenSq, 0, 1);
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  return (px - cx) * (px - cx) + (py - cy) * (py - cy);
}

function pointInTriangle(px, py, ax, ay, bx, by, cx, cy) {
  const v0x = cx - ax, v0y = cy - ay;
  const v1x = bx - ax, v1y = by - ay;
  const v2x = px - ax, v2y = py - ay;
  const dot00 = v0x * v0x + v0y * v0y;
  const dot01 = v0x * v1x + v0y * v1y;
  const dot02 = v0x * v2x + v0y * v2y;
  const dot11 = v1x * v1x + v1y * v1y;
  const dot12 = v1x * v2x + v1y * v2y;
  const denom = dot00 * dot11 - dot01 * dot01;
  if (Math.abs(denom) < 1e-12) return false;
  const inv = 1 / denom;
  const u = (dot11 * dot02 - dot01 * dot12) * inv;
  const v = (dot00 * dot12 - dot01 * dot02) * inv;
  return u >= -1e-4 && v >= -1e-4 && u + v <= 1.0002;
}

function stretchRatioToCss(t) {
  // 0 (blue) -> 0.25 (cyan) -> 0.5 (green) -> 0.75 (yellow) -> 1 (red)
  const v = clamp(t, 0, 1);
  let r = 0, g = 0, b = 0;
  if (v < 0.25) {
    const k = v / 0.25;
    r = 25; g = Math.round(90 + k * 140); b = 235;
  } else if (v < 0.5) {
    const k = (v - 0.25) / 0.25;
    r = 20; g = 220; b = Math.round(235 - k * 175);
  } else if (v < 0.75) {
    const k = (v - 0.5) / 0.25;
    r = Math.round(35 + k * 210); g = Math.round(220 - k * 20); b = 40;
  } else {
    const k = (v - 0.75) / 0.25;
    r = 245; g = Math.round(195 - k * 155); b = 45;
  }
  return `rgba(${r}, ${g}, ${b}, 0.42)`;
}

export class UVEditorUI {
  constructor(options = {}) {
    this.sceneManager = options.sceneManager;
    this.renderer = options.renderer || null;
    this.camera = options.camera || null;
    this.editMode = options.editMode || null;

    this.container = document.getElementById('uv-editor');
    this.canvas = document.getElementById('uv-editor-canvas');
    this.stageEl = document.getElementById('uv-canvas-stage') || this.canvas?.parentElement;
    this.ctx = this.canvas ? this.canvas.getContext('2d') : null;

    this.meshNameEl = document.getElementById('uv-mesh-name');
    this.uvCountEl = document.getElementById('uv-vertex-count');
    this.islandCountEl = document.getElementById('uv-island-count');
    this.noMapMsg = document.getElementById('uv-no-map-msg');
    this.texSlotSelect = document.getElementById('uv-tex-slot-select');
    this.stretchSelect = document.getElementById('uv-stretch-mode');
    this.stretchLegend = document.getElementById('uv-stretch-legend');
    this.hudBanner = document.getElementById('uv-hud-banner');

    // View camera in UV space (center of [0,1]x[0,1] = (0.5, 0.5))
    this.viewZoom = 1.0;
    this.viewCenterU = 0.5;
    this.viewCenterV = 0.5;
    this._cssWidth = 380;
    this._cssHeight = 380;
    this._dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;

    // Editor state
    this.selectionMode = 'vertex'; // 'vertex' | 'edge' | 'face' | 'island'
    this.uvSync = false;
    this.liveUnwrap = false;
    this.stretchMode = 'off'; // 'off' | 'angle' | 'area'
    this.checker3DEnabled = false;
    this.paint2DEnabled = false;
    this._checker3DMesh = null;
    this._checkerTextureCache = null;

    // Selection Sets (buffer vertex indices & triangle indices)
    this.selectedUVVertices = new Set();
    this.selectedUVEdges = new Set(); // "min_max"
    this.selectedUVFaces = new Set(); // tri indices

    // Offscreen procedural grids
    this._checkerCanvases = new Map();

    // Pointer / hover / modal transform state
    this._isPointerInside = false;
    this._lastCursorUV = { u: 0.5, v: 0.5 };
    this._pointerState = null; // pan | box | drag-fallback
    this._boxMarquee = null; // { x0, y0, x1, y1 } in CSS px
    this._modalState = null; // { mode, axis, numericInput, pivotU, pivotV, startScreenX, startScreenY, startUVMap, preGeom, targetSet }

    // Legacy snapshot backup for Reset
    this.originalUVs = new Map();

    this._resizeObserver = null;
    this._windowHandlers = [];

    this._initEvents();
    this._initResizeObserver();
    this.render();
  }

  // =========================================================================
  // Geometry / Mesh Helpers
  // =========================================================================

  _getEditMode() {
    return this.editMode || (typeof window !== 'undefined' ? window.editMode : null);
  }

  _getActiveMesh() {
    const em = this._getEditMode();
    if (em?.isActive && em.targetMesh?.isMesh) return em.targetMesh;
    const obj = this.sceneManager?.getActiveObject();
    if (!obj) return null;
    if (obj.isMesh) return obj;
    let firstMesh = null;
    obj.traverse?.((child) => {
      if (!firstMesh && child.isMesh && child.geometry?.attributes?.uv) {
        firstMesh = child;
      }
    });
    if (!firstMesh) {
      obj.traverse?.((child) => {
        if (!firstMesh && child.isMesh && child.geometry) firstMesh = child;
      });
    }
    return firstMesh;
  }

  _getRenderCamera() {
    if (this.camera) return this.camera;
    const app = typeof window !== 'undefined' ? window.app : null;
    return app?.engine?.camera || app?.camera || null;
  }

  _ensureWritableUV(mesh) {
    if (!mesh?.geometry) return null;
    if (!mesh.geometry.attributes.uv) {
      mesh.geometry = smartUVProjectGeometry(mesh.geometry, { seamKeys: mesh.geometry.userData?._uvSeams });
    }
    return mesh.geometry.attributes.uv || null;
  }

  _backupInitialUVs(mesh) {
    if (!mesh?.geometry?.attributes?.uv) return;
    if (!this.originalUVs.has(mesh.uuid)) {
      this.originalUVs.set(mesh.uuid, new Float32Array(mesh.geometry.attributes.uv.array));
    }
  }

  _pushUVCommand(mesh, oldGeom, description = 'Edit UVs') {
    if (!mesh || !this.sceneManager) return;
    this._syncEditModeTopology(mesh, true);
    const newGeom = cloneGeometrySnapshot(mesh.geometry);
    const byteSize = (oldGeom?.attributes?.position?.array?.byteLength || 0) * 3;
    const cmd = new MeshEditCommand(mesh, oldGeom, newGeom, description, (m) => {
      this._syncEditModeTopology(m, true);
      this.render();
      this.sceneManager?.requestRender?.();
    });
    cmd.bytes = byteSize;
    this.sceneManager.executeCommand(cmd);
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('blender:geometryChanged', { detail: mesh }));
    }
    this.sceneManager?.requestRender?.();
  }

  _syncEditModeTopology(mesh, preserveSelection = false) {
    const em = this._getEditMode();
    if (!em || !em.isActive || em.targetMesh !== mesh) return;

    if (preserveSelection && typeof em._buildTopology === 'function') {
      const prevMode = em.selectionMode;
      const prevVerts = new Set(em.selectedVertices);
      const prevEdges = new Set(em.selectedEdges);
      const prevFaces = new Set(em.selectedFaces);
      em._buildTopology(mesh);
      em.selectionMode = prevMode;
      for (const v of prevVerts) if (v < em.vertices.length) em.selectedVertices.add(v);
      for (const e of prevEdges) if (e < em.edges.length) em.selectedEdges.add(e);
      for (const f of prevFaces) if (f < em.faces.length) em.selectedFaces.add(f);
      em.updateVisuals?.();
      em.updateGizmoProxy?.();
      return;
    }

    const uvAttr = mesh.geometry?.attributes?.uv;
    const posAttr = mesh.geometry?.attributes?.position;
    if (!uvAttr || !posAttr) return;

    const spatialToEditVert = new Map();
    for (let i = 0; i < em.vertices.length; i++) {
      const v = em.vertices[i];
      spatialToEditVert.set(pointSpatialKey(v.x, v.y, v.z), i);
    }

    const editVertToRaw = new Int32Array(em.vertices.length).fill(-1);
    for (let ri = 0; ri < posAttr.count; ri++) {
      const ev = spatialToEditVert.get(pointSpatialKey(posAttr.getX(ri), posAttr.getY(ri), posAttr.getZ(ri)));
      if (ev !== undefined && editVertToRaw[ev] === -1) {
        editVertToRaw[ev] = ri;
      }
    }

    if (em.vertexUVs && em.vertices.length > 0) {
      for (let ev = 0; ev < em.vertices.length; ev++) {
        const ri = editVertToRaw[ev];
        if (ri >= 0 && ri < uvAttr.count) {
          const prev = em.vertexUVs[ev];
          if (prev && prev.isVector2) prev.set(uvAttr.getX(ri), uvAttr.getY(ri));
          else em.vertexUVs[ev] = new THREE.Vector2(uvAttr.getX(ri), uvAttr.getY(ri));
        }
      }
    }

    // Update per-loop face UVs using THREE.Vector2 (never raw [u, v] arrays!)
    const index = mesh.geometry.index;
    const triCount = index ? Math.floor(index.count / 3) : Math.floor(uvAttr.count / 3);
    const triCornersByVertKey = new Map();
    for (let t = 0; t < triCount; t++) {
      const r0 = index ? index.getX(t * 3 + 0) : t * 3 + 0;
      const r1 = index ? index.getX(t * 3 + 1) : t * 3 + 1;
      const r2 = index ? index.getX(t * 3 + 2) : t * 3 + 2;
      for (const ri of [r0, r1, r2]) {
        const ev = spatialToEditVert.get(pointSpatialKey(posAttr.getX(ri), posAttr.getY(ri), posAttr.getZ(ri)));
        if (ev !== undefined && !triCornersByVertKey.has(`${t}_${ev}`)) {
          triCornersByVertKey.set(`${t}_${ev}`, ri);
        }
      }
    }
    for (let f = 0; f < em.faces.length; f++) {
      const face = em.faces[f];
      if (!face || !Array.isArray(face.verts)) continue;
      if (!Array.isArray(face.uvs) || face.uvs.length !== face.verts.length) {
        face.uvs = new Array(face.verts.length);
      }
      for (let k = 0; k < face.verts.length; k++) {
        const ev = face.verts[k];
        const ri = (triCornersByVertKey.get(`${f}_${ev}`) ?? editVertToRaw[ev]);
        if (ri >= 0 && ri < uvAttr.count) {
          const cur = face.uvs[k];
          if (cur && cur.isVector2) cur.set(uvAttr.getX(ri), uvAttr.getY(ri));
          else face.uvs[k] = new THREE.Vector2(uvAttr.getX(ri), uvAttr.getY(ri));
        }
      }
    }
  }

  /**
   * Clusters buffer vertex indices sharing the same 3D position AND UV (within 1e-4),
   * matching Blender's Sticky "Shared Vertex" selection while keeping UV seams split.
   */
  _buildVertexClusters(geometry) {
    const pos = geometry?.attributes?.position;
    const uv = geometry?.attributes?.uv;
    if (!pos || !uv) return { vertToGroup: [], groups: new Map() };
    const count = uv.count;
    const groups = new Map();
    const vertToGroup = new Array(count);
    for (let i = 0; i < count; i++) {
      const pk = pointSpatialKey(pos.getX(i), pos.getY(i), pos.getZ(i));
      const uk = `${Math.round(uv.getX(i) * 1e4)}_${Math.round(uv.getY(i) * 1e4)}`;
      const gKey = `${pk}|${uk}`;
      let list = groups.get(gKey);
      if (!list) {
        list = [];
        groups.set(gKey, list);
      }
      list.push(i);
      vertToGroup[i] = gKey;
    }
    return { vertToGroup, groups };
  }

  _expandVertexSetByClusters(geometry, vertSet) {
    const { vertToGroup, groups } = this._buildVertexClusters(geometry);
    const out = new Set();
    for (const vi of vertSet) {
      const gKey = vertToGroup[vi];
      const peers = gKey ? groups.get(gKey) : null;
      if (peers) {
        for (const p of peers) out.add(p);
      } else {
        out.add(vi);
      }
    }
    return out;
  }

  _getVisibleTriangleList(mesh) {
    const geom = mesh?.geometry;
    const pos = geom?.attributes?.position;
    const uv = geom?.attributes?.uv;
    if (!pos || !uv) return [];
    const index = geom.index;
    const triCount = index ? Math.floor(index.count / 3) : Math.floor(pos.count / 3);
    const all = [];

    const em = this._getEditMode();
    if (!this.uvSync && em?.isActive && em.targetMesh === mesh && em.selectedFaces.size > 0 && em.faces.length > 0) {
      // Collect spatial keys belonging to selected 3D faces so only those faces show in UV Editor
      const selectedFaceTriKeys = new Set();
      for (const fid of em.selectedFaces) {
        const f = em.faces[fid];
        if (!f || !f.verts || f.verts.length < 3) continue;
        const pts = f.verts.map((vi) => {
          const v = em.vertices[vi];
          return v ? pointSpatialKey(v.x, v.y, v.z) : '';
        });
        for (let k = 1; k + 1 < pts.length; k++) {
          const triKey = [pts[0], pts[k], pts[k + 1]].sort().join('|');
          selectedFaceTriKeys.add(triKey);
        }
      }
      for (let t = 0; t < triCount; t++) {
        const i0 = index ? index.getX(t * 3 + 0) : t * 3 + 0;
        const i1 = index ? index.getX(t * 3 + 1) : t * 3 + 1;
        const i2 = index ? index.getX(t * 3 + 2) : t * 3 + 2;
        const triKey = [
          pointSpatialKey(pos.getX(i0), pos.getY(i0), pos.getZ(i0)),
          pointSpatialKey(pos.getX(i1), pos.getY(i1), pos.getZ(i1)),
          pointSpatialKey(pos.getX(i2), pos.getY(i2), pos.getZ(i2))
        ].sort().join('|');
        if (selectedFaceTriKeys.has(triKey)) {
          all.push(t);
        }
      }
      if (all.length > 0) return all;
    }

    for (let t = 0; t < triCount; t++) all.push(t);
    return all;
  }

  _syncSelectionTo3D(mesh) {
    if (!this.uvSync) return;
    const em = this._getEditMode();
    if (!em?.isActive || em.targetMesh !== mesh) return;
    const pos = mesh.geometry?.attributes?.position;
    if (!pos) return;

    const spatialToEditVert = new Map();
    for (let i = 0; i < em.vertices.length; i++) {
      const v = em.vertices[i];
      spatialToEditVert.set(pointSpatialKey(v.x, v.y, v.z), i);
    }

    em.selectedVertices.clear();
    em.selectedEdges.clear();
    em.selectedFaces.clear();

    for (const vi of this.selectedUVVertices) {
      if (vi >= pos.count) continue;
      const pk = pointSpatialKey(pos.getX(vi), pos.getY(vi), pos.getZ(vi));
      const ev = spatialToEditVert.get(pk);
      if (ev !== undefined) em.selectedVertices.add(ev);
    }

    for (const edgeKey of this.selectedUVEdges) {
      const [a, b] = edgeKey.split('_').map(Number);
      if (a >= pos.count || b >= pos.count) continue;
      const ea = spatialToEditVert.get(pointSpatialKey(pos.getX(a), pos.getY(a), pos.getZ(a)));
      const eb = spatialToEditVert.get(pointSpatialKey(pos.getX(b), pos.getY(b), pos.getZ(b)));
      if (ea !== undefined && eb !== undefined) {
        const edge = em.edgeMap?.get(`${Math.min(ea, eb)}_${Math.max(ea, eb)}`);
        if (edge) em.selectedEdges.add(edge.id);
      }
    }

    // Highlight faces whose all vertices are selected in Edit Mode
    if (em.selectionMode === 'face' || this.selectedUVFaces.size > 0) {
      for (const f of em.faces) {
        if (f.verts.every((v) => em.selectedVertices.has(v))) {
          em.selectedFaces.add(f.id);
        }
      }
    }

    em.updateVisuals?.();
    em.updateGizmoProxy?.();
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('blender:editSelectionChanged', {
        detail: { source: 'uv-editor', mesh, count: em.selectedVertices.size }
      }));
    }
    this.sceneManager?.requestRender?.();
  }

  // =========================================================================
  // Canvas Metrics & UV <-> Screen Coordinate Transform
  // =========================================================================

  _updateCanvasSize() {
    if (!this.canvas || !this.stageEl) return;
    const rect = this.stageEl.getBoundingClientRect();
    const w = Math.max(200, Math.floor(rect.width || 380));
    const h = Math.max(150, Math.floor(rect.height || 300));
    const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
    const targetW = Math.floor(w * dpr);
    const targetH = Math.floor(h * dpr);

    this._cssWidth = w;
    this._cssHeight = h;
    this._dpr = dpr;

    if (this.canvas.width !== targetW || this.canvas.height !== targetH) {
      this.canvas.width = targetW;
      this.canvas.height = targetH;
    }
  }

  _getBasePixelScale() {
    return Math.min(this._cssWidth, this._cssHeight) * 0.78 * this.viewZoom;
  }

  uvToScreen(u, v) {
    const scale = this._getBasePixelScale();
    const cx = this._cssWidth * 0.5;
    const cy = this._cssHeight * 0.5;
    return [
      cx + (u - this.viewCenterU) * scale,
      cy - (v - this.viewCenterV) * scale
    ];
  }

  screenToUv(px, py) {
    const scale = Math.max(1e-6, this._getBasePixelScale());
    const cx = this._cssWidth * 0.5;
    const cy = this._cssHeight * 0.5;
    return [
      this.viewCenterU + (px - cx) / scale,
      this.viewCenterV - (py - cy) / scale
    ];
  }

  // =========================================================================
  // Procedural Texture / 3D Checker Management
  // =========================================================================

  _getProceduralCanvas(kind) {
    if (!this._checkerCanvases.has(kind)) {
      const c = typeof document !== 'undefined' ? document.createElement('canvas') : null;
      if (c) {
        renderUVCheckerToCanvas(c, kind, 512);
        this._checkerCanvases.set(kind, c);
      }
    }
    return this._checkerCanvases.get(kind) || null;
  }

  _getActiveTextureImage(mesh) {
    if (!mesh || !mesh.material) return null;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const mat = mats.find((m) => m) || mats[0];
    if (!mat) return null;

    const slot = this.texSlotSelect ? this.texSlotSelect.value : 'diffuse';
    if (slot === 'none') return null;
    if (slot === 'color_grid') return { image: this._getProceduralCanvas('color_grid'), flipY: true };
    if (slot === 'uv_grid') return { image: this._getProceduralCanvas('uv_grid'), flipY: true };

    let tex = null;
    if (slot === 'diffuse') {
      const saved = mesh.userData?._savedPreCheckerMaps;
      if (saved && saved[0] !== undefined) tex = saved[0];
      else tex = mat.map;
    } else if (slot === 'alpha') tex = mat.alphaMap;
    else if (slot === 'normal') tex = mat.normalMap;
    else if (slot === 'roughness') tex = mat.roughnessMap;
    else if (slot === 'metalness') tex = mat.metalnessMap;
    else if (slot === 'bump') tex = mat.bumpMap;
    else if (slot === 'ao') tex = mat.aoMap;

    const img = tex?.image || null;
    if (!img) return null;
    const flipY = tex ? tex.flipY !== false : true;
    if (img.data && img.width && img.height && typeof document !== 'undefined') {
      const key = `${tex.uuid}:${tex.version}:${img.width}x${img.height}`;
      if (this._dataTexKey !== key || !this._dataTexScratch) {
        if (!this._dataTexScratch || this._dataTexScratch.width !== img.width || this._dataTexScratch.height !== img.height) {
          this._dataTexScratch = document.createElement('canvas');
          this._dataTexScratch.width = img.width;
          this._dataTexScratch.height = img.height;
        }
        const sctx = this._dataTexScratch.getContext('2d');
        if (sctx) {
          const idata = sctx.createImageData(img.width, img.height);
          idata.data.set(img.data);
          sctx.putImageData(idata, 0, 0);
          this._dataTexKey = key;
        }
      }
      return { image: this._dataTexScratch, flipY };
    }
    return { image: img, flipY };
  }

  togglePaint2D(forceState = null) {
    const next = forceState === null ? !this.paint2DEnabled : Boolean(forceState);
    this.paint2DEnabled = next;
    if (typeof document !== 'undefined') {
      document.getElementById('btn-uv-paint-mode')?.classList.toggle('active', next);
    }
    if (next) {
      const mesh = this._getActiveMesh();
      if (mesh && typeof window !== 'undefined' && window.paintMode) {
        window.paintMode.ensureMaterialAndSlot(mesh, window.paintMode.activeSlot || 'baseColor');
      }
    }
    this.render();
    return next;
  }

  toggleChecker3D(forceState = null) {
    const next = forceState === null ? !this.checker3DEnabled : Boolean(forceState);
    if (next === this.checker3DEnabled && (!next || this._checker3DMesh === this._getActiveMesh())) {
      return this.checker3DEnabled;
    }

    // First restore any previous mesh cleanly
    this.restoreChecker3DMaterial();

    this.checker3DEnabled = next;
    const btn = document.getElementById('btn-uv-checker-3d');
    btn?.classList.toggle('active', next);

    if (next) {
      const mesh = this._getActiveMesh();
      if (mesh && mesh.material) {
        if (!this._checkerTextureCache) {
          const c = document.createElement('canvas');
          renderUVCheckerToCanvas(c, 'color_grid', 1024);
          const tex = new THREE.CanvasTexture(c);
          tex.colorSpace = THREE.SRGBColorSpace;
          tex.wrapS = THREE.RepeatWrapping;
          tex.wrapT = THREE.RepeatWrapping;
          tex.anisotropy = 4;
          tex.needsUpdate = true;
          this._checkerTextureCache = tex;
        }
        const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        mesh.userData._savedPreCheckerMaps = mats.map((m) => m?.map || null);
        for (const m of mats) {
          if (!m) continue;
          m.map = this._checkerTextureCache;
          m.needsUpdate = true;
        }
        this._checker3DMesh = mesh;
      }
    }

    this.render();
    this.sceneManager?.requestRender?.();
    return this.checker3DEnabled;
  }

  restoreChecker3DMaterial() {
    const mesh = this._checker3DMesh;
    if (mesh && mesh.material && mesh.userData?._savedPreCheckerMaps) {
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      const saved = mesh.userData._savedPreCheckerMaps;
      for (let i = 0; i < mats.length; i++) {
        if (mats[i] && i < saved.length) {
          mats[i].map = saved[i];
          mats[i].needsUpdate = true;
        }
      }
      delete mesh.userData._savedPreCheckerMaps;
    }
    this._checker3DMesh = null;
  }

  // =========================================================================
  // Selection & Pinning
  // =========================================================================

  setSelectionMode(mode) {
    if (!['vertex', 'edge', 'face', 'island'].includes(mode)) return;
    this.selectionMode = mode;
    document.querySelectorAll('.uv-mode-btn[data-uv-mode]').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.uvMode === mode);
    });
    this.render();
  }

  toggleSyncSelection(force = null) {
    this.uvSync = force === null ? !this.uvSync : Boolean(force);
    document.getElementById('btn-uv-sync')?.classList.toggle('active', this.uvSync);
    this.render();
    return this.uvSync;
  }

  toggleLiveUnwrap(force = null) {
    this.liveUnwrap = force === null ? !this.liveUnwrap : Boolean(force);
    const em = this._getEditMode();
    if (em) em.liveUnwrap = this.liveUnwrap;
    document.getElementById('btn-uv-live-unwrap')?.classList.toggle('active', this.liveUnwrap);
    return this.liveUnwrap;
  }

  setStretchMode(mode) {
    this.stretchMode = ['angle', 'area'].includes(mode) ? mode : 'off';
    if (this.stretchSelect) this.stretchSelect.value = this.stretchMode;
    if (this.stretchLegend) this.stretchLegend.hidden = this.stretchMode === 'off';
    this.render();
  }

  clearSelection() {
    this.selectedUVVertices.clear();
    this.selectedUVEdges.clear();
    this.selectedUVFaces.clear();
  }

  selectAll() {
    const mesh = this._getActiveMesh();
    const uvAttr = mesh?.geometry?.attributes?.uv;
    if (!uvAttr) return;
    const tris = this._getVisibleTriangleList(mesh);
    const index = mesh.geometry.index;
    this.clearSelection();
    for (const t of tris) {
      this.selectedUVFaces.add(t);
      const i0 = index ? index.getX(t * 3 + 0) : t * 3 + 0;
      const i1 = index ? index.getX(t * 3 + 1) : t * 3 + 1;
      const i2 = index ? index.getX(t * 3 + 2) : t * 3 + 2;
      this.selectedUVVertices.add(i0);
      this.selectedUVVertices.add(i1);
      this.selectedUVVertices.add(i2);
      this.selectedUVEdges.add(`${Math.min(i0, i1)}_${Math.max(i0, i1)}`);
      this.selectedUVEdges.add(`${Math.min(i1, i2)}_${Math.max(i1, i2)}`);
      this.selectedUVEdges.add(`${Math.min(i2, i0)}_${Math.max(i2, i0)}`);
    }
    this._syncSelectionTo3D(mesh);
    this.render();
  }

  deselectAll() {
    const mesh = this._getActiveMesh();
    this.clearSelection();
    if (mesh) this._syncSelectionTo3D(mesh);
    this.render();
  }

  invertSelection() {
    const mesh = this._getActiveMesh();
    const uvAttr = mesh?.geometry?.attributes?.uv;
    if (!uvAttr) return;
    const tris = this._getVisibleTriangleList(mesh);
    const index = mesh.geometry.index;
    const allVerts = new Set();
    for (const t of tris) {
      for (let k = 0; k < 3; k++) {
        allVerts.add(index ? index.getX(t * 3 + k) : t * 3 + k);
      }
    }
    const next = new Set();
    for (const vi of allVerts) {
      if (!this.selectedUVVertices.has(vi)) next.add(vi);
    }
    this.selectedUVVertices = this._expandVertexSetByClusters(mesh.geometry, next);
    this.selectedUVEdges.clear();
    this.selectedUVFaces.clear();
    this._syncSelectionTo3D(mesh);
    this.render();
  }

  selectIslandAtUV(u, v, additive = false) {
    const mesh = this._getActiveMesh();
    if (!mesh?.geometry?.attributes?.uv) return false;
    const geom = mesh.geometry;
    const uvAttr = geom.attributes.uv;
    const index = geom.index;
    const islands = extractUVIslandsFromGeometry(geom);
    if (islands.length === 0) return false;

    // 1. Check face hit first
    let targetIsland = null;
    for (const isl of islands) {
      for (const t of isl.tris) {
        const i0 = index ? index.getX(t * 3 + 0) : t * 3 + 0;
        const i1 = index ? index.getX(t * 3 + 1) : t * 3 + 1;
        const i2 = index ? index.getX(t * 3 + 2) : t * 3 + 2;
        if (pointInTriangle(
          u, v,
          uvAttr.getX(i0), uvAttr.getY(i0),
          uvAttr.getX(i1), uvAttr.getY(i1),
          uvAttr.getX(i2), uvAttr.getY(i2)
        )) {
          targetIsland = isl;
          break;
        }
      }
      if (targetIsland) break;
    }

    // 2. Nearest vertex fallback
    if (!targetIsland) {
      let bestDistSq = Infinity;
      for (const isl of islands) {
        for (const vi of isl.verts) {
          const du = uvAttr.getX(vi) - u;
          const dv = uvAttr.getY(vi) - v;
          const d2 = du * du + dv * dv;
          if (d2 < bestDistSq) {
            bestDistSq = d2;
            targetIsland = isl;
          }
        }
      }
      if (bestDistSq > 0.08 * 0.08) targetIsland = null;
    }

    if (!targetIsland) return false;
    if (!additive) this.clearSelection();
    for (const vi of targetIsland.verts) this.selectedUVVertices.add(vi);
    for (const t of targetIsland.tris) this.selectedUVFaces.add(t);
    this._syncSelectionTo3D(mesh);
    this.render();
    return true;
  }

  _getPinnedMap(geometry) {
    const obj = geometry?.userData?._uvPinned;
    const map = new Map();
    if (obj && typeof obj === 'object') {
      for (const [k, coords] of Object.entries(obj)) {
        if (Array.isArray(coords) && coords.length >= 2) {
          map.set(k, [Number(coords[0]) || 0, Number(coords[1]) || 0]);
        }
      }
    }
    return map;
  }

  pinSelected(unpin = false) {
    const mesh = this._getActiveMesh();
    const geom = mesh?.geometry;
    const pos = geom?.attributes?.position;
    const uv = geom?.attributes?.uv;
    if (!pos || !uv) return false;

    const targetVerts = this.selectedUVVertices.size > 0
      ? this._expandVertexSetByClusters(geom, this.selectedUVVertices)
      : new Set();
    if (targetVerts.size === 0) return false;

    geom.userData = geom.userData || {};
    geom.userData._uvPinned = geom.userData._uvPinned || {};
    const store = geom.userData._uvPinned;

    // Detect spatial keys split across a UV seam (multiple distinct UV coordinates at same 3D pos)
    const spatialUvCounts = new Map();
    for (let i = 0; i < pos.count; i++) {
      const sk = pointSpatialKey(pos.getX(i), pos.getY(i), pos.getZ(i));
      const cTag = `${Math.round(uv.getX(i) * 1000)}_${Math.round(uv.getY(i) * 1000)}`;
      let set = spatialUvCounts.get(sk);
      if (!set) {
        set = new Set();
        spatialUvCounts.set(sk, set);
      }
      set.add(cTag);
    }

    for (const vi of targetVerts) {
      const key = pointSpatialKey(pos.getX(vi), pos.getY(vi), pos.getZ(vi));
      const u = uv.getX(vi);
      const v = uv.getY(vi);
      const cTag = `${Math.round(u * 1000)}_${Math.round(v * 1000)}`;
      const clusterKey = `${key}@${cTag}`;
      const isSplitSeam = (spatialUvCounts.get(key)?.size || 1) > 1;
      if (unpin) {
        delete store[clusterKey];
        if (!isSplitSeam) delete store[key];
      } else {
        if (isSplitSeam) {
          delete store[key];
          store[clusterKey] = [u, v];
        } else {
          store[key] = [u, v];
        }
      }
    }
    this.render();
    return true;
  }

  _updatePinnedPositionsFromUVs(mesh, vertSet) {
    const geom = mesh?.geometry;
    const pos = geom?.attributes?.position;
    const uv = geom?.attributes?.uv;
    const store = geom?.userData?._uvPinned;
    if (!pos || !uv || !store) return;

    const prevMap = this._modalState?.startUVMap;
    for (const vi of vertSet) {
      const key = pointSpatialKey(pos.getX(vi), pos.getY(vi), pos.getZ(vi));
      const nu = uv.getX(vi);
      const nv = uv.getY(vi);
      if (store[key]) {
        store[key] = [nu, nv];
      }
      const prev = prevMap?.get(vi);
      if (prev) {
        const oldTag = `${key}@${Math.round(prev[0] * 1000)}_${Math.round(prev[1] * 1000)}`;
        if (store[oldTag]) {
          delete store[oldTag];
          store[`${key}@${Math.round(nu * 1000)}_${Math.round(nv * 1000)}`] = [nu, nv];
        }
      }
    }
  }

  // =========================================================================
  // UV Operators (Blender Unwrap, Pack, Average Scale, Seams, Fit, Reset)
  // =========================================================================

  _getTargetUVIndicesForTransform(uvAttr) {
    if (this.selectedUVVertices.size > 0) {
      const mesh = this._getActiveMesh();
      if (mesh?.geometry) {
        return Array.from(this._expandVertexSetByClusters(mesh.geometry, this.selectedUVVertices));
      }
      return Array.from(this.selectedUVVertices);
    }
    const all = [];
    for (let i = 0; i < uvAttr.count; i++) all.push(i);
    return all;
  }

  panUV(du, dv, saveUndo = true) {
    const mesh = this._getActiveMesh();
    const uvAttr = this._ensureWritableUV(mesh);
    if (!uvAttr) return false;
    this._backupInitialUVs(mesh);
    const oldGeom = saveUndo ? cloneGeometrySnapshot(mesh.geometry) : null;

    const indices = this._getTargetUVIndicesForTransform(uvAttr);
    for (const i of indices) {
      uvAttr.setXY(i, uvAttr.getX(i) + du, uvAttr.getY(i) + dv);
    }
    uvAttr.needsUpdate = true;
    this._updatePinnedPositionsFromUVs(mesh, indices);

    if (saveUndo) this._pushUVCommand(mesh, oldGeom, 'Move UV');
    else this._syncEditModeTopology(mesh, false);
    this.render();
    this.sceneManager?.requestRender?.();
    return true;
  }

  scaleUV(factor, saveUndo = true) {
    const mesh = this._getActiveMesh();
    const uvAttr = this._ensureWritableUV(mesh);
    if (!uvAttr) return false;
    this._backupInitialUVs(mesh);
    const oldGeom = saveUndo ? cloneGeometrySnapshot(mesh.geometry) : null;

    const indices = this._getTargetUVIndicesForTransform(uvAttr);
    if (indices.length === 0) return false;
    let cx = 0, cy = 0;
    for (const i of indices) {
      cx += uvAttr.getX(i);
      cy += uvAttr.getY(i);
    }
    cx /= indices.length;
    cy /= indices.length;

    for (const i of indices) {
      uvAttr.setXY(i, cx + (uvAttr.getX(i) - cx) * factor, cy + (uvAttr.getY(i) - cy) * factor);
    }
    uvAttr.needsUpdate = true;
    this._updatePinnedPositionsFromUVs(mesh, indices);

    if (saveUndo) this._pushUVCommand(mesh, oldGeom, 'Scale UV');
    else this._syncEditModeTopology(mesh, false);
    this.render();
    this.sceneManager?.requestRender?.();
    return true;
  }

  rotateUV(angleRad, saveUndo = true) {
    const mesh = this._getActiveMesh();
    const uvAttr = this._ensureWritableUV(mesh);
    if (!uvAttr) return false;
    this._backupInitialUVs(mesh);
    const oldGeom = saveUndo ? cloneGeometrySnapshot(mesh.geometry) : null;

    const indices = this._getTargetUVIndicesForTransform(uvAttr);
    if (indices.length === 0) return false;
    let cx = 0, cy = 0;
    for (const i of indices) {
      cx += uvAttr.getX(i);
      cy += uvAttr.getY(i);
    }
    cx /= indices.length;
    cy /= indices.length;

    const cos = Math.cos(angleRad);
    const sin = Math.sin(angleRad);
    for (const i of indices) {
      const dx = uvAttr.getX(i) - cx;
      const dy = uvAttr.getY(i) - cy;
      uvAttr.setXY(i, cx + dx * cos - dy * sin, cy + dx * sin + dy * cos);
    }
    uvAttr.needsUpdate = true;
    this._updatePinnedPositionsFromUVs(mesh, indices);

    if (saveUndo) this._pushUVCommand(mesh, oldGeom, 'Rotate UV');
    else this._syncEditModeTopology(mesh, false);
    this.render();
    this.sceneManager?.requestRender?.();
    return true;
  }

  flipU() {
    const mesh = this._getActiveMesh();
    const uvAttr = this._ensureWritableUV(mesh);
    if (!uvAttr) return false;
    this._backupInitialUVs(mesh);
    const oldGeom = cloneGeometrySnapshot(mesh.geometry);

    const indices = this._getTargetUVIndicesForTransform(uvAttr);
    let minU = Infinity, maxU = -Infinity;
    for (const i of indices) {
      const u = uvAttr.getX(i);
      if (u < minU) minU = u;
      if (u > maxU) maxU = u;
    }
    const mid = this.selectedUVVertices.size > 0 ? (minU + maxU) * 0.5 : 0.5;
    for (const i of indices) {
      uvAttr.setX(i, mid * 2 - uvAttr.getX(i));
    }
    uvAttr.needsUpdate = true;
    this._updatePinnedPositionsFromUVs(mesh, indices);
    this._pushUVCommand(mesh, oldGeom, 'Flip U');
    this.render();
    return true;
  }

  flipV() {
    const mesh = this._getActiveMesh();
    const uvAttr = this._ensureWritableUV(mesh);
    if (!uvAttr) return false;
    this._backupInitialUVs(mesh);
    const oldGeom = cloneGeometrySnapshot(mesh.geometry);

    const indices = this._getTargetUVIndicesForTransform(uvAttr);
    let minV = Infinity, maxV = -Infinity;
    for (const i of indices) {
      const v = uvAttr.getY(i);
      if (v < minV) minV = v;
      if (v > maxV) maxV = v;
    }
    const mid = this.selectedUVVertices.size > 0 ? (minV + maxV) * 0.5 : 0.5;
    for (const i of indices) {
      uvAttr.setY(i, mid * 2 - uvAttr.getY(i));
    }
    uvAttr.needsUpdate = true;
    this._updatePinnedPositionsFromUVs(mesh, indices);
    this._pushUVCommand(mesh, oldGeom, 'Flip V');
    this.render();
    return true;
  }

  fitUV() {
    const mesh = this._getActiveMesh();
    const uvAttr = this._ensureWritableUV(mesh);
    if (!uvAttr) return false;
    this._backupInitialUVs(mesh);
    const oldGeom = cloneGeometrySnapshot(mesh.geometry);

    const indices = this._getTargetUVIndicesForTransform(uvAttr);
    if (indices.length === 0) return false;
    let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
    for (const i of indices) {
      const u = uvAttr.getX(i);
      const v = uvAttr.getY(i);
      if (u < minU) minU = u;
      if (u > maxU) maxU = u;
      if (v < minV) minV = v;
      if (v > maxV) maxV = v;
    }
    const spanU = maxU - minU;
    const spanV = maxV - minV;
    if (spanU < 1e-6 || spanV < 1e-6) return false;
    const maxSpan = Math.max(spanU, spanV);
    const scale = 0.96 / maxSpan;
    const offU = (1.0 - spanU * scale) * 0.5;
    const offV = (1.0 - spanV * scale) * 0.5;

    for (const i of indices) {
      uvAttr.setXY(i, offU + (uvAttr.getX(i) - minU) * scale, offV + (uvAttr.getY(i) - minV) * scale);
    }
    uvAttr.needsUpdate = true;
    this._updatePinnedPositionsFromUVs(mesh, indices);
    this._pushUVCommand(mesh, oldGeom, 'Fit UV to 0-1');
    this.render();
    return true;
  }

  mapMeshUVToRect(mesh, rect, saveUndo = true) {
    if (!mesh || !rect) return false;
    const uvAttr = this._ensureWritableUV(mesh);
    if (!uvAttr) return false;
    this._backupInitialUVs(mesh);
    const oldGeom = saveUndo ? cloneGeometrySnapshot(mesh.geometry) : null;

    let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
    for (let i = 0; i < uvAttr.count; i++) {
      const u = uvAttr.getX(i);
      const v = uvAttr.getY(i);
      if (u < minU) minU = u;
      if (u > maxU) maxU = u;
      if (v < minV) minV = v;
      if (v > maxV) maxV = v;
    }
    const spanU = Math.max(1e-6, maxU - minU);
    const spanV = Math.max(1e-6, maxV - minV);
    const rx = Number(rect.x) || 0;
    const ry = Number(rect.y) || 0;
    const rw = Number(rect.w) || 1;
    const rh = Number(rect.h) || 1;

    for (let i = 0; i < uvAttr.count; i++) {
      const nu = (uvAttr.getX(i) - minU) / spanU;
      const nv = (uvAttr.getY(i) - minV) / spanV;
      uvAttr.setXY(i, rx + nu * rw, ry + nv * rh);
    }
    uvAttr.needsUpdate = true;
    if (saveUndo) this._pushUVCommand(mesh, oldGeom, 'Map UV to Rect');
    else this._syncEditModeTopology(mesh, false);
    this.render();
    return true;
  }

  resetUV() {
    const mesh = this._getActiveMesh();
    if (!mesh?.geometry) return false;
    const oldGeom = cloneGeometrySnapshot(mesh.geometry);
    const rebuilt = resetUVsGeometry(mesh.geometry);
    applyUVGeometryUpdate(mesh, rebuilt);
    this.clearSelection();
    this._pushUVCommand(mesh, oldGeom, 'Reset UVs');
    this.render();
    return true;
  }

  packIslands(margin = null) {
    const mesh = this._getActiveMesh();
    if (!mesh?.geometry?.attributes?.uv) return false;
    const oldGeom = cloneGeometrySnapshot(mesh.geometry);
    const m = margin !== null
      ? Number(margin)
      : Number(document.getElementById('uv-pack-margin')?.value ?? 0.02);
    const ok = packUVIslandsInPlace(mesh.geometry, { margin: m, rotate: true, averageScale: true });
    if (!ok) return false;
    this.clearSelection();
    this._pushUVCommand(mesh, oldGeom, 'Pack UV Islands');
    this.render();
    return true;
  }

  averageIslandsScale() {
    const mesh = this._getActiveMesh();
    if (!mesh?.geometry?.attributes?.uv) return false;
    const oldGeom = cloneGeometrySnapshot(mesh.geometry);
    const ok = averageIslandsScaleInPlace(mesh.geometry);
    if (!ok) return false;
    this._pushUVCommand(mesh, oldGeom, 'Average Islands Scale');
    this.render();
    return true;
  }

  markSeamFrom3D(clear = false) {
    const em = this._getEditMode();
    if (!em?.isActive) return false;
    const ok = clear ? em.clearSeam?.() : em.markSeam?.(false);
    this.render();
    return Boolean(ok);
  }

  projectFromView(meshOverride = null, opts = {}) {
    const mesh = meshOverride || this._getActiveMesh();
    if (!mesh || !mesh.geometry) return false;
    const camera = this._getRenderCamera();
    if (!camera) return false;

    const geom = mesh.geometry;
    const posAttr = geom.attributes.position;
    if (!posAttr) return false;

    this._backupInitialUVs(mesh);
    const oldGeom = opts.skipUndo ? null : cloneGeometrySnapshot(geom);
    const uvAttr = this._ensureWritableUV(mesh);
    if (!uvAttr) return false;

    mesh.updateMatrixWorld(true);
    camera.updateMatrixWorld(true);
    camera.updateProjectionMatrix();

    const aspect = Number(camera.aspect) ||
      ((this.renderer?.domElement?.clientWidth || 1) / Math.max(1, this.renderer?.domElement?.clientHeight || 1));

    const ndcCoords = new Float32Array(posAttr.count * 2);
    const v = new THREE.Vector3();
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;

    for (let i = 0; i < posAttr.count; i++) {
      v.fromBufferAttribute(posAttr, i).applyMatrix4(mesh.matrixWorld).project(camera);
      const sx = v.x * 0.5 * aspect + 0.5;
      const sy = v.y * 0.5 + 0.5;
      ndcCoords[i * 2] = sx;
      ndcCoords[i * 2 + 1] = sy;
      if (sx < minX) minX = sx;
      if (sx > maxX) maxX = sx;
      if (sy < minY) minY = sy;
      if (sy > maxY) maxY = sy;
    }

    const spanX = Math.max(1e-6, maxX - minX);
    const spanY = Math.max(1e-6, maxY - minY);
    const scale = 0.98 / Math.max(spanX, spanY);
    const offU = (1.0 - spanX * scale) * 0.5;
    const offV = (1.0 - spanY * scale) * 0.5;

    for (let i = 0; i < posAttr.count; i++) {
      uvAttr.setXY(
        i,
        offU + (ndcCoords[i * 2] - minX) * scale,
        offV + (ndcCoords[i * 2 + 1] - minY) * scale
      );
    }
    uvAttr.needsUpdate = true;

    if (!opts.skipUndo) this._pushUVCommand(mesh, oldGeom, 'Project UV from View');
    else this._syncEditModeTopology(mesh, false);
    this.render();
    return true;
  }

  alignFrontAndProject(meshOverride = null) {
    const mesh = meshOverride || this._getActiveMesh();
    if (!mesh || !mesh.geometry) return false;

    const app = typeof window !== 'undefined' ? window.app : null;
    const camera = this._getRenderCamera();
    const controls = app?.engine?.controls || null;

    if (camera) {
      mesh.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(mesh);
      const center = new THREE.Vector3();
      const size = new THREE.Vector3();
      if (!box.isEmpty()) {
        box.getCenter(center);
        box.getSize(size);
      } else {
        mesh.getWorldPosition(center);
        size.set(2, 2, 2);
      }
      const maxDim = Math.max(size.x, size.y, size.z, 1.0);
      const dist = maxDim * 2.1;

      const worldForward = new THREE.Vector3(0, 0, 1).transformDirection(mesh.matrixWorld).normalize();
      camera.position.copy(center).addScaledVector(worldForward, dist);
      camera.lookAt(center);
      camera.updateMatrixWorld(true);
      if (controls) {
        controls.target.copy(center);
        controls.update();
      }
    }

    const ok = this.projectFromView(mesh);
    if (typeof window !== 'undefined') {
      const uvTab = document.querySelector('.dock-tab[data-pane="dock-uv-editor"]');
      if (uvTab && !uvTab.classList.contains('active')) {
        uvTab.click();
      }
    }
    return ok;
  }

  unwrap(mode = 'lscm', options = {}) {
    const mesh = this._getActiveMesh();
    if (!mesh || !mesh.geometry) return false;

    const em = this._getEditMode();
    if (em?.isActive && em.targetMesh === mesh && ['lscm', 'smart', 'cube', 'cylinder', 'sphere', 'pack', 'average', 'reset'].includes(mode)) {
      const ok = em.unwrap(mode, {
        pinnedMap: this._getPinnedMap(mesh.geometry),
        margin: Number(document.getElementById('uv-pack-margin')?.value ?? 0.02),
        ...options
      });
      this.clearSelection();
      this.render();
      return ok;
    }

    const geom = mesh.geometry;
    const pos = geom.attributes.position;
    if (!pos) return false;
    this._backupInitialUVs(mesh);
    const oldGeom = cloneGeometrySnapshot(geom);

    const seamKeys = normalizeSeamSet(geom.userData?._uvSeams);
    const pinnedMap = this._getPinnedMap(geom);
    const margin = Number(options.margin ?? document.getElementById('uv-pack-margin')?.value ?? 0.02);

    let rebuilt = null;
    if (mode === 'lscm') {
      rebuilt = unwrapMeshLSCM(geom, { seamKeys, pinnedMap, margin, ...options });
    } else if (mode === 'smart') {
      rebuilt = smartUVProjectGeometry(geom, { seamKeys, margin, angleLimitDeg: 66, ...options });
    } else if (mode === 'cube') {
      rebuilt = cubeProjectGeometry(geom, { seamKeys, margin, ...options });
    } else if (mode === 'cylinder') {
      rebuilt = cylinderProjectGeometry(geom, { seamKeys, ...options });
    } else if (mode === 'sphere') {
      rebuilt = sphereProjectGeometry(geom, { seamKeys, ...options });
    } else if (mode === 'reset') {
      rebuilt = resetUVsGeometry(geom);
    } else {
      // Planar top
      const box = new THREE.Box3().setFromBufferAttribute(pos);
      const size = new THREE.Vector3();
      box.getSize(size);
      const scale = Math.max(size.x, size.z, 1e-5);
      const uvAttr = this._ensureWritableUV(mesh);
      for (let i = 0; i < pos.count; i++) {
        const u = (pos.getX(i) - box.min.x) / scale;
        const v = (pos.getZ(i) - box.min.z) / scale;
        uvAttr.setXY(i, u, v);
      }
      uvAttr.needsUpdate = true;
    }

    if (rebuilt && rebuilt !== geom) {
      applyUVGeometryUpdate(mesh, rebuilt);
    }
    this.clearSelection();
    this._pushUVCommand(mesh, oldGeom, `UV Unwrap (${mode})`);
    this.render();
    return true;
  }

  frameAll() {
    const mesh = this._getActiveMesh();
    const uv = mesh?.geometry?.attributes?.uv;
    let minU = 0, maxU = 1, minV = 0, maxV = 1;
    if (uv && uv.count > 0) {
      minU = Infinity; maxU = -Infinity; minV = Infinity; maxV = -Infinity;
      for (let i = 0; i < uv.count; i++) {
        const u = uv.getX(i), v = uv.getY(i);
        if (Number.isFinite(u) && Number.isFinite(v)) {
          if (u < minU) minU = u;
          if (u > maxU) maxU = u;
          if (v < minV) minV = v;
          if (v > maxV) maxV = v;
        }
      }
      minU = Math.min(0, minU);
      maxU = Math.max(1, maxU);
      minV = Math.min(0, minV);
      maxV = Math.max(1, maxV);
    }
    const span = Math.max(1, maxU - minU, maxV - minV);
    this.viewCenterU = (minU + maxU) * 0.5;
    this.viewCenterV = (minV + maxV) * 0.5;
    this.viewZoom = clamp(1 / span, 0.2, 16);
    this.render();
  }

  exportUVLayoutPNG(size = 1024, triggerDownload = true) {
    const mesh = this._getActiveMesh();
    const geom = mesh?.geometry;
    const uvAttr = geom?.attributes?.uv;
    if (!uvAttr || typeof document === 'undefined') return null;

    const c = document.createElement('canvas');
    c.width = size;
    c.height = size;
    const ctx = c.getContext('2d');
    if (!ctx) return null;

    ctx.clearRect(0, 0, size, size);
    const index = geom.index;
    const triCount = index ? Math.floor(index.count / 3) : Math.floor(uvAttr.count / 3);

    ctx.fillStyle = 'rgba(130, 175, 240, 0.16)';
    ctx.strokeStyle = 'rgba(235, 242, 255, 0.92)';
    ctx.lineWidth = Math.max(1, size / 768);

    ctx.beginPath();
    for (let t = 0; t < triCount; t++) {
      const i0 = index ? index.getX(t * 3 + 0) : t * 3 + 0;
      const i1 = index ? index.getX(t * 3 + 1) : t * 3 + 1;
      const i2 = index ? index.getX(t * 3 + 2) : t * 3 + 2;
      const x0 = uvAttr.getX(i0) * size, y0 = (1 - uvAttr.getY(i0)) * size;
      const x1 = uvAttr.getX(i1) * size, y1 = (1 - uvAttr.getY(i1)) * size;
      const x2 = uvAttr.getX(i2) * size, y2 = (1 - uvAttr.getY(i2)) * size;
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.closePath();
    }
    ctx.fill();
    ctx.stroke();

    const dataUrl = c.toDataURL('image/png');
    if (triggerDownload) {
      const a = document.createElement('a');
      a.href = dataUrl;
      a.download = `${(mesh.name || 'mesh').replace(/[^a-z0-9_-]/gi, '_')}_uv_layout.png`;
      document.body.appendChild(a);
      a.click();
      a.remove();
    }
    return dataUrl;
  }

  // =========================================================================
  // Modal UV Transform (G / R / S + X / Y Axis Lock + Digits)
  // =========================================================================

  startModalTransform(mode) {
    if (!['translate', 'rotate', 'scale'].includes(mode)) return false;
    const mesh = this._getActiveMesh();
    const uvAttr = this._ensureWritableUV(mesh);
    if (!uvAttr || uvAttr.count === 0) return false;
    this._backupInitialUVs(mesh);

    const targetSet = new Set(this._getTargetUVIndicesForTransform(uvAttr));
    if (targetSet.size === 0) return false;

    let sumU = 0, sumV = 0;
    const startUVMap = new Map();
    for (const vi of targetSet) {
      const u = uvAttr.getX(vi);
      const v = uvAttr.getY(vi);
      startUVMap.set(vi, [u, v]);
      sumU += u;
      sumV += v;
    }

    this._modalState = {
      mode,
      axis: null, // null | 'x' | 'y'
      numericInput: '',
      pivotU: sumU / targetSet.size,
      pivotV: sumV / targetSet.size,
      startCursorU: this._lastCursorUV.u,
      startCursorV: this._lastCursorUV.v,
      preGeom: cloneGeometrySnapshot(mesh.geometry),
      mesh,
      targetSet,
      startUVMap,
      lastHUD: ''
    };

    this._updateModalHUD();
    return true;
  }

  _applyModalPreview(cursorU, cursorV, precision = false) {
    const st = this._modalState;
    if (!st) return;
    const uvAttr = st.mesh?.geometry?.attributes?.uv;
    if (!uvAttr) return;

    const parsedNum = st.numericInput !== '' && !Number.isNaN(Number(st.numericInput)) && st.numericInput !== '-' && st.numericInput !== '.'
      ? Number(st.numericInput)
      : null;

    let hudText = '';
    const scaleMult = precision ? 0.2 : 1.0;

    if (st.mode === 'translate') {
      let du = parsedNum !== null ? parsedNum : (cursorU - st.startCursorU) * scaleMult;
      let dv = parsedNum !== null ? parsedNum : (cursorV - st.startCursorV) * scaleMult;
      if (st.axis === 'x') dv = 0;
      else if (st.axis === 'y') du = 0;

      for (const [vi, [u0, v0]] of st.startUVMap.entries()) {
        uvAttr.setXY(vi, u0 + du, v0 + dv);
      }
      hudText = `UV Grab (G)${st.axis ? ` [${st.axis.toUpperCase()}]` : ''}: dU ${du.toFixed(3)}, dV ${dv.toFixed(3)} · LMB/Enter Confirm · Esc/RMB Cancel`;
    } else if (st.mode === 'rotate') {
      let rad = 0;
      if (parsedNum !== null) {
        rad = (-parsedNum * Math.PI) / 180;
      } else {
        const a0 = Math.atan2(st.startCursorV - st.pivotV, st.startCursorU - st.pivotU);
        const a1 = Math.atan2(cursorV - st.pivotV, cursorU - st.pivotU);
        rad = (a1 - a0) * scaleMult;
      }
      const cos = Math.cos(rad);
      const sin = Math.sin(rad);
      for (const [vi, [u0, v0]] of st.startUVMap.entries()) {
        const dx = u0 - st.pivotU;
        const dy = v0 - st.pivotV;
        uvAttr.setXY(vi, st.pivotU + dx * cos - dy * sin, st.pivotV + dx * sin + dy * cos);
      }
      hudText = `UV Rotate (R): ${((-rad * 180) / Math.PI).toFixed(1)}° · Type angle · LMB/Enter Confirm`;
    } else if (st.mode === 'scale') {
      let factor = 1;
      if (parsedNum !== null) {
        factor = parsedNum;
      } else {
        const d0 = Math.max(0.03, Math.hypot(st.startCursorU - st.pivotU, st.startCursorV - st.pivotV));
        const d1 = Math.hypot(cursorU - st.pivotU, cursorV - st.pivotV);
        factor = 1 + (d1 / d0 - 1) * scaleMult;
      }
      const sx = st.axis === 'y' ? 1 : factor;
      const sy = st.axis === 'x' ? 1 : factor;
      for (const [vi, [u0, v0]] of st.startUVMap.entries()) {
        uvAttr.setXY(vi, st.pivotU + (u0 - st.pivotU) * sx, st.pivotV + (v0 - st.pivotV) * sy);
      }
      hudText = `UV Scale (S)${st.axis ? ` [${st.axis.toUpperCase()}]` : ''}: ${sx.toFixed(3)}×${sy.toFixed(3)} · X/Y Axis · LMB/Enter Confirm`;
    }

    uvAttr.needsUpdate = true;
    this._updatePinnedPositionsFromUVs(st.mesh, st.targetSet);
    st.lastHUD = hudText;
    this._updateModalHUD();
    this.render();
    this.sceneManager?.requestRender?.();
  }

  confirmModalTransform() {
    const st = this._modalState;
    if (!st) return false;
    this._modalState = null;
    this._updatePinnedPositionsFromUVs(st.mesh, st.targetSet);
    this._pushUVCommand(st.mesh, st.preGeom, `UV ${st.mode}`);
    if (this.liveUnwrap && st.mesh.geometry?.userData?._uvPinned && Object.keys(st.mesh.geometry.userData._uvPinned).length >= 2) {
      this.unwrap('lscm');
    }
    this._updateModalHUD();
    this.render();
    return true;
  }

  cancelModalTransform() {
    const st = this._modalState;
    if (!st) return false;
    this._modalState = null;
    const uvAttr = st.mesh?.geometry?.attributes?.uv;
    if (uvAttr) {
      for (const [vi, [u0, v0]] of st.startUVMap.entries()) {
        uvAttr.setXY(vi, u0, v0);
      }
      uvAttr.needsUpdate = true;
      this._updatePinnedPositionsFromUVs(st.mesh, st.targetSet);
      this._syncEditModeTopology(st.mesh, false);
    }
    this._updateModalHUD();
    this.render();
    this.sceneManager?.requestRender?.();
    return true;
  }

  _updateModalHUD() {
    if (!this.hudBanner) return;
    if (this._modalState) {
      this.hudBanner.classList.add('is-modal');
      this.hudBanner.textContent = this._modalState.lastHUD || `UV ${this._modalState.mode.toUpperCase()} · Move mouse or type value · X/Y Lock · Enter Confirm · Esc Cancel`;
    } else {
      this.hudBanner.classList.remove('is-modal');
      this.hudBanner.textContent = 'LMB: Select · B: Box · L: Island · P/Alt+P: Pin · G/R/S (+X/Y): Transform · Wheel: Zoom · MMB/Alt+Drag: Pan';
    }
  }

  // =========================================================================
  // Canvas Picking & Mouse Interaction
  // =========================================================================

  _hitTestUV(mesh, px, py) {
    const geom = mesh?.geometry;
    const uvAttr = geom?.attributes?.uv;
    if (!uvAttr) return null;

    if (this.selectionMode === 'vertex') {
      let bestVi = -1;
      let bestD2 = 11 * 11;
      const tris = this._getVisibleTriangleList(mesh);
      const index = geom.index;
      const tested = new Set();
      for (const t of tris) {
        for (let k = 0; k < 3; k++) {
          const vi = index ? index.getX(t * 3 + k) : t * 3 + k;
          if (tested.has(vi)) continue;
          tested.add(vi);
          const [sx, sy] = this.uvToScreen(uvAttr.getX(vi), uvAttr.getY(vi));
          const d2 = (sx - px) * (sx - px) + (sy - py) * (sy - py);
          if (d2 < bestD2) {
            bestD2 = d2;
            bestVi = vi;
          }
        }
      }
      return bestVi >= 0 ? { kind: 'vertex', index: bestVi } : null;
    }

    if (this.selectionMode === 'edge') {
      let bestEdge = null;
      let bestD2 = 9 * 9;
      const tris = this._getVisibleTriangleList(mesh);
      const index = geom.index;
      for (const t of tris) {
        const i0 = index ? index.getX(t * 3 + 0) : t * 3 + 0;
        const i1 = index ? index.getX(t * 3 + 1) : t * 3 + 1;
        const i2 = index ? index.getX(t * 3 + 2) : t * 3 + 2;
        const pairs = [[i0, i1], [i1, i2], [i2, i0]];
        for (const [a, b] of pairs) {
          const [ax, ay] = this.uvToScreen(uvAttr.getX(a), uvAttr.getY(a));
          const [bx, by] = this.uvToScreen(uvAttr.getX(b), uvAttr.getY(b));
          const d2 = pointToSegmentDistSq(px, py, ax, ay, bx, by);
          if (d2 < bestD2) {
            bestD2 = d2;
            bestEdge = [Math.min(a, b), Math.max(a, b)];
          }
        }
      }
      return bestEdge ? { kind: 'edge', edge: bestEdge } : null;
    }

    const [u, v] = this.screenToUv(px, py);
    if (this.selectionMode === 'face') {
      const tris = this._getVisibleTriangleList(mesh);
      const index = geom.index;
      for (const t of tris) {
        const i0 = index ? index.getX(t * 3 + 0) : t * 3 + 0;
        const i1 = index ? index.getX(t * 3 + 1) : t * 3 + 1;
        const i2 = index ? index.getX(t * 3 + 2) : t * 3 + 2;
        if (pointInTriangle(
          u, v,
          uvAttr.getX(i0), uvAttr.getY(i0),
          uvAttr.getX(i1), uvAttr.getY(i1),
          uvAttr.getX(i2), uvAttr.getY(i2)
        )) {
          return { kind: 'face', tri: t, verts: [i0, i1, i2] };
        }
      }
      return null;
    }

    if (this.selectionMode === 'island') {
      return { kind: 'island', u, v };
    }
    return null;
  }

  _applyPickHit(mesh, hit, additive) {
    if (!additive) this.clearSelection();
    if (!hit) {
      this._syncSelectionTo3D(mesh);
      this.render();
      return false;
    }

    if (hit.kind === 'vertex') {
      const cluster = this._expandVertexSetByClusters(mesh.geometry, [hit.index]);
      const allSelected = Array.from(cluster).every((i) => this.selectedUVVertices.has(i));
      for (const i of cluster) {
        if (additive && allSelected) this.selectedUVVertices.delete(i);
        else this.selectedUVVertices.add(i);
      }
    } else if (hit.kind === 'edge') {
      const [a, b] = hit.edge;
      const eKey = `${a}_${b}`;
      const cluster = this._expandVertexSetByClusters(mesh.geometry, [a, b]);
      if (additive && this.selectedUVEdges.has(eKey)) {
        this.selectedUVEdges.delete(eKey);
        for (const i of cluster) this.selectedUVVertices.delete(i);
      } else {
        this.selectedUVEdges.add(eKey);
        for (const i of cluster) this.selectedUVVertices.add(i);
      }
    } else if (hit.kind === 'face') {
      const [i0, i1, i2] = hit.verts;
      const cluster = this._expandVertexSetByClusters(mesh.geometry, hit.verts);
      if (additive && this.selectedUVFaces.has(hit.tri)) {
        this.selectedUVFaces.delete(hit.tri);
      } else {
        this.selectedUVFaces.add(hit.tri);
        for (const i of cluster) this.selectedUVVertices.add(i);
        this.selectedUVEdges.add(`${Math.min(i0, i1)}_${Math.max(i0, i1)}`);
        this.selectedUVEdges.add(`${Math.min(i1, i2)}_${Math.max(i1, i2)}`);
        this.selectedUVEdges.add(`${Math.min(i2, i0)}_${Math.max(i2, i0)}`);
      }
    } else if (hit.kind === 'island') {
      return this.selectIslandAtUV(hit.u, hit.v, additive);
    }

    this._syncSelectionTo3D(mesh);
    this.render();
    return true;
  }

  _finishBoxMarquee(mesh, box, additive) {
    if (!mesh?.geometry?.attributes?.uv || !box) return;
    const minX = Math.min(box.x0, box.x1);
    const maxX = Math.max(box.x0, box.x1);
    const minY = Math.min(box.y0, box.y1);
    const maxY = Math.max(box.y0, box.y1);
    const [uA, vA] = this.screenToUv(minX, maxY);
    const [uB, vB] = this.screenToUv(maxX, minY);
    const minU = Math.min(uA, uB), maxU = Math.max(uA, uB);
    const minV = Math.min(vA, vB), maxV = Math.max(vA, vB);

    if (!additive) this.clearSelection();
    const uvAttr = mesh.geometry.attributes.uv;
    const tris = this._getVisibleTriangleList(mesh);
    const index = mesh.geometry.index;
    const hits = new Set();

    for (const t of tris) {
      const i0 = index ? index.getX(t * 3 + 0) : t * 3 + 0;
      const i1 = index ? index.getX(t * 3 + 1) : t * 3 + 1;
      const i2 = index ? index.getX(t * 3 + 2) : t * 3 + 2;
      let faceAllIn = true;
      for (const vi of [i0, i1, i2]) {
        const u = uvAttr.getX(vi), v = uvAttr.getY(vi);
        if (u >= minU && u <= maxU && v >= minV && v <= maxV) {
          hits.add(vi);
        } else {
          faceAllIn = false;
        }
      }
      if (faceAllIn) this.selectedUVFaces.add(t);
    }
    const expanded = this._expandVertexSetByClusters(mesh.geometry, hits);
    for (const vi of expanded) this.selectedUVVertices.add(vi);
    this._syncSelectionTo3D(mesh);
    this.render();
  }

  // =========================================================================
  // Event Binding & ResizeObserver
  // =========================================================================

  _initResizeObserver() {
    if (typeof ResizeObserver === 'undefined' || !this.stageEl) return;
    this._resizeObserver = new ResizeObserver(() => {
      this._updateCanvasSize();
      this.render();
    });
    this._resizeObserver.observe(this.stageEl);
  }

  _initEvents() {
    const bindBtn = (id, fn) => document.getElementById(id)?.addEventListener('click', fn);

    // Dock tab activation
    document.querySelectorAll('.dock-tab').forEach((tab) => {
      tab.addEventListener('click', () => {
        if (tab.dataset.pane === 'dock-uv-editor') {
          this._updateCanvasSize();
          this.render();
        }
      });
    });

    // Toolbar row 1
    bindBtn('btn-refresh-uv', () => this.render());
    bindBtn('btn-uv-sync', () => this.toggleSyncSelection());
    bindBtn('btn-uv-checker-3d', () => this.toggleChecker3D());
    bindBtn('btn-uv-paint-mode', () => this.togglePaint2D());
    bindBtn('btn-uv-live-unwrap', () => this.toggleLiveUnwrap());
    bindBtn('btn-uv-home', () => this.frameAll());
    bindBtn('btn-uv-export-png', () => this.exportUVLayoutPNG(1024, true));

    document.querySelectorAll('.uv-mode-btn[data-uv-mode]').forEach((btn) => {
      btn.addEventListener('click', () => this.setSelectionMode(btn.dataset.uvMode));
    });

    this.texSlotSelect?.addEventListener('change', () => this.render());
    this.stretchSelect?.addEventListener('change', (e) => this.setStretchMode(e.target.value));

    // Toolbar row 2
    bindBtn('btn-uv-unwrap', () => {
      const mode = document.getElementById('uv-unwrap-mode')?.value || 'lscm';
      this.unwrap(mode);
    });
    bindBtn('btn-uv-project-view', () => this.projectFromView());
    bindBtn('btn-uv-align-project', () => this.alignFrontAndProject());
    bindBtn('btn-uv-mark-seam', () => this.markSeamFrom3D(false));
    bindBtn('btn-uv-clear-seam', () => this.markSeamFrom3D(true));
    bindBtn('btn-uv-pack', () => this.packIslands());
    bindBtn('btn-uv-average-scale', () => this.averageIslandsScale());
    bindBtn('btn-uv-pin', () => this.pinSelected(false));
    bindBtn('btn-uv-unpin', () => this.pinSelected(true));
    bindBtn('btn-uv-fit', () => this.fitUV());
    bindBtn('btn-uv-flip-u', () => this.flipU());
    bindBtn('btn-uv-flip-v', () => this.flipV());
    bindBtn('btn-uv-reset', () => this.resetUV());

    // Selection / Scene hooks
    const addWin = (type, fn, opts) => {
      if (typeof window === 'undefined') return;
      window.addEventListener(type, fn, opts);
      this._windowHandlers.push([type, fn, opts]);
    };

    if (this.sceneManager?.on) {
      this.sceneManager.on('selectionChanged', () => {
        if (this.checker3DEnabled && this._checker3DMesh !== this._getActiveMesh()) {
          this.toggleChecker3D(false);
        }
        this.clearSelection();
        this.render();
      });
    }
    addWin('blender:textureUpdated', () => this.render());
    addWin('blender:geometryChanged', () => this.render());
    addWin('blender:uvSeamsChanged', () => this.render());
    addWin('blender:beforeExport', () => {
      if (this.checker3DEnabled) this.toggleChecker3D(false);
    });

    // Pointer hover tracking for Blender cursor-over-area focus
    const stageTarget = this.stageEl || this.canvas;
    stageTarget?.addEventListener('pointerenter', () => { this._isPointerInside = true; });
    stageTarget?.addEventListener('pointerleave', () => { this._isPointerInside = false; });

    if (this.canvas) {
      this.canvas.addEventListener('contextmenu', (e) => {
        if (this._modalState) {
          e.preventDefault();
          e.stopPropagation();
          this.cancelModalTransform();
        }
      });

      this.canvas.addEventListener('wheel', (e) => {
        e.preventDefault();
        const rect = this.canvas.getBoundingClientRect();
        const px = e.clientX - rect.left;
        const py = e.clientY - rect.top;
        const [uBefore, vBefore] = this.screenToUv(px, py);
        const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
        this.viewZoom = clamp(this.viewZoom * factor, 0.15, 24);
        const [uAfter, vAfter] = this.screenToUv(px, py);
        this.viewCenterU += uBefore - uAfter;
        this.viewCenterV += vBefore - vAfter;
        this.render();
      }, { passive: false });

      this.canvas.addEventListener('pointerdown', (e) => {
        this.container?.focus?.({ preventScroll: true });
        this._isPointerInside = true;
        const rect = this.canvas.getBoundingClientRect();
        const px = e.clientX - rect.left;
        const py = e.clientY - rect.top;
        const [u, v] = this.screenToUv(px, py);
        this._lastCursorUV = { u, v };

        // Confirm / Cancel active modal G/R/S
        if (this._modalState) {
          e.preventDefault();
          e.stopPropagation();
          if (e.button === 0) this.confirmModalTransform();
          else this.cancelModalTransform();
          return;
        }

        // MMB or Alt+LMB -> Pan UV canvas (trackpad-friendly!)
        if (e.button === 1 || (e.button === 0 && e.altKey)) {
          e.preventDefault();
          this._pointerState = {
            kind: 'pan',
            startX: px,
            startY: py,
            origCenterU: this.viewCenterU,
            origCenterV: this.viewCenterV
          };
          this.canvas.style.cursor = 'grabbing';
          this.canvas.setPointerCapture?.(e.pointerId);
          return;
        }

        if (e.button === 0) {
          const mesh = this._getActiveMesh();
          if (this.paint2DEnabled && mesh && typeof window !== 'undefined' && window.paintMode) {
            this._pointerState = { kind: 'paint2d' };
            this.canvas.setPointerCapture?.(e.pointerId);
            window.paintMode.paint2DAtUV(u, v, { mesh, beginStroke: true });
            this.render();
            return;
          }
          if (!mesh?.geometry?.attributes?.uv) return;

          if (this._pointerState?.kind === 'box-armed') {
            this._pointerState = {
              kind: 'box-drag',
              startX: px,
              startY: py,
              additive: e.shiftKey
            };
            this._boxMarquee = { x0: px, y0: py, x1: px, y1: py };
            this.canvas.setPointerCapture?.(e.pointerId);
            this.render();
            return;
          }

          this._pointerState = {
            kind: 'pick-or-box',
            startX: px,
            startY: py,
            additive: e.shiftKey,
            moved: false
          };
          this.canvas.setPointerCapture?.(e.pointerId);
        }
      });

      this.canvas.addEventListener('pointermove', (e) => {
        const rect = this.canvas.getBoundingClientRect();
        const px = e.clientX - rect.left;
        const py = e.clientY - rect.top;
        const [u, v] = this.screenToUv(px, py);
        this._lastCursorUV = { u, v };

        if (this._modalState) {
          this._applyModalPreview(u, v, e.shiftKey);
          return;
        }

        if (!this._pointerState) return;
        const dx = px - this._pointerState.startX;
        const dy = py - this._pointerState.startY;

        if (this._pointerState.kind === 'paint2d') {
          const mesh = this._getActiveMesh();
          if (mesh && typeof window !== 'undefined' && window.paintMode) {
            window.paintMode.paint2DAtUV(u, v, { mesh, beginStroke: false });
          }
          this.render();
          return;
        }

        if (this._pointerState.kind === 'pan') {
          const scale = Math.max(1e-6, this._getBasePixelScale());
          this.viewCenterU = this._pointerState.origCenterU - dx / scale;
          this.viewCenterV = this._pointerState.origCenterV + dy / scale;
          this.render();
          return;
        }

        if (this._pointerState.kind === 'pick-or-box' && Math.hypot(dx, dy) > 4) {
          this._pointerState.moved = true;
          this._pointerState.kind = 'box-drag';
        }

        if (this._pointerState.kind === 'box-drag') {
          this._boxMarquee = {
            x0: this._pointerState.startX,
            y0: this._pointerState.startY,
            x1: px,
            y1: py
          };
          this.render();
        }
      });

      const finishPointer = (e) => {
        if (!this._pointerState) return;
        const st = this._pointerState;
        this._pointerState = null;
        this.canvas.style.cursor = 'crosshair';
        try { this.canvas.releasePointerCapture?.(e.pointerId); } catch (_) { /* ignore */ }

        const rect = this.canvas.getBoundingClientRect();
        const px = e.clientX - rect.left;
        const py = e.clientY - rect.top;
        const mesh = this._getActiveMesh();

        if (st.kind === 'paint2d') {
          if (mesh && typeof window !== 'undefined' && window.paintMode) {
            window.paintMode.commitTextureStroke(mesh, 'UV 2D Texture Paint');
          }
          return;
        }

        if (st.kind === 'box-drag' && this._boxMarquee) {
          const box = this._boxMarquee;
          this._boxMarquee = null;
          this._finishBoxMarquee(mesh, box, st.additive);
          return;
        }

        if (st.kind === 'pick-or-box' && !st.moved && mesh) {
          const hit = this._hitTestUV(mesh, px, py);
          this._applyPickHit(mesh, hit, st.additive);
        }
      };

      this.canvas.addEventListener('pointerup', finishPointer);
      this.canvas.addEventListener('pointercancel', () => {
        this._pointerState = null;
        this._boxMarquee = null;
        this.canvas.style.cursor = 'crosshair';
        this.render();
      });
    }

    // Scoped capture keyboard handler: owns keys when hovering UV stage, focusing #uv-editor, or in UV modal
    const onKeyDown = (e) => {
      if (e.metaKey) return;
      const activeEl = typeof document !== 'undefined' ? document.activeElement : null;
      const inInput = activeEl && (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA' || activeEl.tagName === 'SELECT');
      if (inInput) return;

      const isVisible = this.container && this.container.offsetParent !== null;
      if (!isVisible) return;

      const isUVFocused = Boolean(
        this._modalState ||
        this._isPointerInside ||
        (activeEl && this.container.contains(activeEl))
      );
      if (!isUVFocused) return;

      const key = (e.key || '').toLowerCase();

      // Modal UV Transform owns keys exclusively
      if (this._modalState) {
        e.preventDefault();
        e.stopImmediatePropagation();
        if (key === 'escape') {
          this.cancelModalTransform();
          return;
        }
        if (key === 'enter') {
          this.confirmModalTransform();
          return;
        }
        if (key === 'x' || key === 'y') {
          if (this._modalState.mode !== 'rotate') {
            this._modalState.axis = this._modalState.axis === key ? null : key;
            this._applyModalPreview(this._lastCursorUV.u, this._lastCursorUV.v, e.shiftKey);
          }
          return;
        }
        if (/^[0-9.\-]$/.test(key) || e.key === 'Backspace') {
          if (e.key === 'Backspace') {
            this._modalState.numericInput = this._modalState.numericInput.slice(0, -1);
          } else {
            this._modalState.numericInput += key;
          }
          this._applyModalPreview(this._lastCursorUV.u, this._lastCursorUV.v, e.shiftKey);
          return;
        }
        return;
      }

      // UV Selection & Navigation shortcuts (intercept before 3D Viewport handlers!)
      if (!e.ctrlKey && !e.altKey && !e.shiftKey) {
        if (key === '1') { e.preventDefault(); e.stopImmediatePropagation(); this.setSelectionMode('vertex'); return; }
        if (key === '2') { e.preventDefault(); e.stopImmediatePropagation(); this.setSelectionMode('edge'); return; }
        if (key === '3') { e.preventDefault(); e.stopImmediatePropagation(); this.setSelectionMode('face'); return; }
        if (key === '4') { e.preventDefault(); e.stopImmediatePropagation(); this.setSelectionMode('island'); return; }
        if (key === 'g') { e.preventDefault(); e.stopImmediatePropagation(); this.startModalTransform('translate'); return; }
        if (key === 'r') { e.preventDefault(); e.stopImmediatePropagation(); this.startModalTransform('rotate'); return; }
        if (key === 's') { e.preventDefault(); e.stopImmediatePropagation(); this.startModalTransform('scale'); return; }
        if (key === 'p') { e.preventDefault(); e.stopImmediatePropagation(); this.pinSelected(false); return; }
        if (key === 'l') { e.preventDefault(); e.stopImmediatePropagation(); this.selectIslandAtUV(this._lastCursorUV.u, this._lastCursorUV.v, true); return; }
        if (key === 'b') {
          e.preventDefault();
          e.stopImmediatePropagation();
          this._pointerState = { kind: 'box-armed' };
          if (this.canvas) this.canvas.style.cursor = 'cell';
          return;
        }
        if (key === 'a') { e.preventDefault(); e.stopImmediatePropagation(); this.selectAll(); return; }
        if (e.code === 'Home') { e.preventDefault(); e.stopImmediatePropagation(); this.frameAll(); return; }
      }

      if ((key === 'p' || e.code === 'KeyP') && e.altKey && !e.ctrlKey) {
        e.preventDefault(); e.stopImmediatePropagation();
        this.pinSelected(true);
        return;
      }
      if ((key === 'a' || e.code === 'KeyA') && e.altKey && !e.ctrlKey) {
        e.preventDefault(); e.stopImmediatePropagation();
        this.deselectAll();
        return;
      }
      if ((key === 'l' || e.code === 'KeyL') && e.shiftKey) {
        e.preventDefault(); e.stopImmediatePropagation();
        this.selectIslandAtUV(this._lastCursorUV.u, this._lastCursorUV.v, true);
        return;
      }
      if (key === 'i' && e.ctrlKey && !e.altKey) {
        e.preventDefault(); e.stopImmediatePropagation();
        this.invertSelection();
      }
    };

    addWin('keydown', onKeyDown, true);
  }

  // =========================================================================
  // HiDPI 2D Rendering
  // =========================================================================

  render() {
    if (!this.canvas || !this.ctx) return;
    // Skip expensive UV island extraction & 2D software triangle rasterization when UV Editor tab is hidden
    if (this.canvas.offsetParent === null && this.canvas.clientWidth === 0) return;
    this._updateCanvasSize();

    const ctx = this.ctx;
    const W = this._cssWidth;
    const H = this._cssHeight;
    const dpr = this._dpr;

    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // 1. Blender UV Editor dark workspace backdrop
    ctx.fillStyle = '#18191d';
    ctx.fillRect(0, 0, W, H);

    // Draw background grid over whole stage + [0,1] tile
    const [tx0, ty1] = this.uvToScreen(0, 1); // Top-left of [0,1] square
    const [tx1, ty0] = this.uvToScreen(1, 0); // Bottom-right of [0,1] square
    const tileW = tx1 - tx0;
    const tileH = ty0 - ty1;

    // Subtle global UV grid lines
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.04)';
    ctx.lineWidth = 1;
    const [uMin, vMax] = this.screenToUv(0, 0);
    const [uMax, vMin] = this.screenToUv(W, H);
    const startU = Math.floor(uMin);
    const endU = Math.ceil(uMax);
    const startV = Math.floor(vMin);
    const endV = Math.ceil(vMax);
    ctx.beginPath();
    for (let u = startU; u <= endU; u++) {
      const [sx] = this.uvToScreen(u, 0);
      ctx.moveTo(sx, 0);
      ctx.lineTo(sx, H);
    }
    for (let v = startV; v <= endV; v++) {
      const [, sy] = this.uvToScreen(0, v);
      ctx.moveTo(0, sy);
      ctx.lineTo(W, sy);
    }
    ctx.stroke();

    // [0, 1] UV Tile checkerboard + optional image
    const mesh = this._getActiveMesh();
    const texEntry = this._getActiveTextureImage(mesh);
    ctx.save();
    ctx.beginPath();
    ctx.rect(tx0, ty1, tileW, tileH);
    ctx.clip();

    const sqs = 8;
    const sw = tileW / sqs;
    const sh = tileH / sqs;
    ctx.fillStyle = '#272930';
    ctx.fillRect(tx0, ty1, tileW, tileH);
    ctx.fillStyle = '#1f2127';
    ctx.beginPath();
    for (let y = 0; y < sqs; y++) {
      for (let x = 0; x < sqs; x++) {
        if ((x + y) % 2 !== 0) {
          ctx.rect(tx0 + x * sw, ty1 + y * sh, sw + 0.6, sh + 0.6);
        }
      }
    }
    ctx.fill();
    if (texEntry && texEntry.image) {
      if (texEntry.flipY === false) {
        // glTF textures have flipY=false: row 0 sits at v=0 (bottom = ty0)
        ctx.save();
        ctx.translate(0, ty1 + ty0);
        ctx.scale(1, -1);
        ctx.drawImage(texEntry.image, tx0, ty1, tileW, tileH);
        ctx.restore();
      } else {
        ctx.drawImage(texEntry.image, tx0, ty1, tileW, tileH);
      }
    }
    ctx.restore();

    // Crisp [0, 1] tile border
    ctx.strokeStyle = '#525766';
    ctx.lineWidth = 1.2;
    ctx.strokeRect(tx0, ty1, tileW, tileH);

    // Axis markers inside tile origin (Red U, Green V)
    ctx.strokeStyle = 'rgba(239, 68, 68, 0.75)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(tx0, ty0);
    ctx.lineTo(tx1, ty0);
    ctx.stroke();

    ctx.strokeStyle = 'rgba(34, 197, 94, 0.75)';
    ctx.beginPath();
    ctx.moveTo(tx0, ty0);
    ctx.lineTo(tx0, ty1);
    ctx.stroke();

    if (!mesh || !mesh.geometry) {
      if (this.meshNameEl) this.meshNameEl.textContent = 'No Mesh Selected';
      if (this.uvCountEl) this.uvCountEl.textContent = 'UVs: 0';
      if (this.islandCountEl) this.islandCountEl.textContent = 'Islands: 0';
      if (this.noMapMsg) this.noMapMsg.style.display = 'block';
      ctx.restore();
      return;
    }

    if (this.meshNameEl) this.meshNameEl.textContent = mesh.name || 'Selected Mesh';
    const uvAttr = mesh.geometry.attributes.uv;
    if (!uvAttr) {
      if (this.uvCountEl) this.uvCountEl.textContent = 'UVs: None';
      if (this.islandCountEl) this.islandCountEl.textContent = 'Islands: 0';
      if (this.noMapMsg) this.noMapMsg.style.display = 'block';
      ctx.restore();
      return;
    }

    if (this.noMapMsg) this.noMapMsg.style.display = 'none';
    const geom = mesh.geometry;
    const posAttr = geom.attributes.position;
    const index = geom.index;
    const seamKeys = normalizeSeamSet(geom.userData?._uvSeams);
    const cacheKey = `${geom.uuid}:${uvAttr.version}:${posAttr?.version || 0}:${index?.version || 0}:${seamKeys.size}:${this.stretchMode}`;
    if (!this._geomCache || this._geomCache.key !== cacheKey) {
      const islands = extractUVIslandsFromGeometry(geom);
      const stretchScores = this.stretchMode !== 'off' ? computeUVStretch(geom, this.stretchMode) : null;
      const flippedCount = countFlippedUVTriangles(geom);
      const triCountAll = index ? Math.floor(index.count / 3) : Math.floor(uvAttr.count / 3);
      const seamEdgePairSet = new Set();
      if (seamKeys.size > 0 && posAttr) {
        for (let t = 0; t < triCountAll; t++) {
          const i0 = index ? index.getX(t * 3 + 0) : t * 3 + 0;
          const i1 = index ? index.getX(t * 3 + 1) : t * 3 + 1;
          const i2 = index ? index.getX(t * 3 + 2) : t * 3 + 2;
          for (const [a, b] of [[i0, i1], [i1, i2], [i2, i0]]) {
            const pk = `${Math.min(a, b)}_${Math.max(a, b)}`;
            if (!seamEdgePairSet.has(pk) && a < posAttr.count && b < posAttr.count) {
              if (seamKeys.has(edgeSpatialKeyFromVectorsLocal(posAttr, a, b))) {
                seamEdgePairSet.add(pk);
              }
            }
          }
        }
      }
      this._geomCache = { key: cacheKey, islands, stretchScores, flippedCount, seamEdgePairSet };
    }

    const { islands, stretchScores, flippedCount, seamEdgePairSet } = this._geomCache;
    if (this.uvCountEl) this.uvCountEl.textContent = `UVs: ${uvAttr.count}${flippedCount > 0 ? ` · ⚠ ${flippedCount} flipped` : ''}`;
    if (this.islandCountEl) this.islandCountEl.textContent = `Islands: ${islands.length}`;

    const visibleTris = this._getVisibleTriangleList(mesh);
    const pinnedObj = geom.userData?._uvPinned || {};

    // Project visible vertices ONCE per frame
    const scale = this._getBasePixelScale();
    const cx = this._cssWidth * 0.5;
    const cy = this._cssHeight * 0.5;
    const vCount = uvAttr.count;
    const screenX = new Float32Array(vCount);
    const screenY = new Float32Array(vCount);
    const projectedFlag = new Uint8Array(vCount);

    for (let idxPos = 0; idxPos < visibleTris.length; idxPos++) {
      const t = visibleTris[idxPos];
      const i0 = index ? index.getX(t * 3 + 0) : t * 3 + 0;
      const i1 = index ? index.getX(t * 3 + 1) : t * 3 + 1;
      const i2 = index ? index.getX(t * 3 + 2) : t * 3 + 2;
      for (const vi of [i0, i1, i2]) {
        if (!projectedFlag[vi]) {
          projectedFlag[vi] = 1;
          screenX[vi] = cx + (uvAttr.getX(vi) - this.viewCenterU) * scale;
          screenY[vi] = cy - (uvAttr.getY(vi) - this.viewCenterV) * scale;
        }
      }
    }

    // 2. Batched Face Fills (2 batches normal, or 16 quantized color buckets in stretch mode)
    if (stretchScores) {
      const BUCKETS = 16;
      const buckets = Array.from({ length: BUCKETS }, () => []);
      for (let idxPos = 0; idxPos < visibleTris.length; idxPos++) {
        const t = visibleTris[idxPos];
        const b = Math.min(BUCKETS - 1, Math.max(0, Math.floor((stretchScores[t] || 0) * BUCKETS)));
        buckets[b].push(t);
      }
      for (let b = 0; b < BUCKETS; b++) {
        const list = buckets[b];
        if (list.length === 0) continue;
        ctx.beginPath();
        for (let k = 0; k < list.length; k++) {
          const t = list[k];
          const i0 = index ? index.getX(t * 3 + 0) : t * 3 + 0;
          const i1 = index ? index.getX(t * 3 + 1) : t * 3 + 1;
          const i2 = index ? index.getX(t * 3 + 2) : t * 3 + 2;
          ctx.moveTo(screenX[i0], screenY[i0]);
          ctx.lineTo(screenX[i1], screenY[i1]);
          ctx.lineTo(screenX[i2], screenY[i2]);
          ctx.closePath();
        }
        ctx.fillStyle = stretchRatioToCss((b + 0.5) / BUCKETS);
        ctx.fill();
      }
    } else {
      const selTris = [];
      ctx.beginPath();
      for (let idxPos = 0; idxPos < visibleTris.length; idxPos++) {
        const t = visibleTris[idxPos];
        const i0 = index ? index.getX(t * 3 + 0) : t * 3 + 0;
        const i1 = index ? index.getX(t * 3 + 1) : t * 3 + 1;
        const i2 = index ? index.getX(t * 3 + 2) : t * 3 + 2;
        const isFaceSel = this.selectedUVFaces.has(t) ||
          (this.selectedUVVertices.has(i0) && this.selectedUVVertices.has(i1) && this.selectedUVVertices.has(i2));
        if (isFaceSel) {
          selTris.push(i0, i1, i2);
        } else {
          ctx.moveTo(screenX[i0], screenY[i0]);
          ctx.lineTo(screenX[i1], screenY[i1]);
          ctx.lineTo(screenX[i2], screenY[i2]);
          ctx.closePath();
        }
      }
      ctx.fillStyle = 'rgba(255, 255, 255, 0.045)';
      ctx.fill();

      if (selTris.length > 0) {
        ctx.beginPath();
        for (let k = 0; k < selTris.length; k += 3) {
          const i0 = selTris[k], i1 = selTris[k + 1], i2 = selTris[k + 2];
          ctx.moveTo(screenX[i0], screenY[i0]);
          ctx.lineTo(screenX[i1], screenY[i1]);
          ctx.lineTo(screenX[i2], screenY[i2]);
          ctx.closePath();
        }
        ctx.fillStyle = 'rgba(255, 160, 40, 0.24)';
        ctx.fill();
      }
    }

    // 3. UV Wireframe Edges + Seam Highlight + Selected Edges
    const drawnNormalEdges = new Set();
    const drawnSeamEdges = [];
    const drawnSelEdges = [];

    ctx.beginPath();
    for (let idxPos = 0; idxPos < visibleTris.length; idxPos++) {
      const t = visibleTris[idxPos];
      const i0 = index ? index.getX(t * 3 + 0) : t * 3 + 0;
      const i1 = index ? index.getX(t * 3 + 1) : t * 3 + 1;
      const i2 = index ? index.getX(t * 3 + 2) : t * 3 + 2;

      const pairs = [[i0, i1], [i1, i2], [i2, i0]];
      for (const [a, b] of pairs) {
        const key = `${Math.min(a, b)}_${Math.max(a, b)}`;
        const isSeam = seamEdgePairSet.has(key);
        const isEdgeSel = this.selectedUVEdges.has(key) ||
          (this.selectedUVVertices.has(a) && this.selectedUVVertices.has(b));

        if (isEdgeSel) {
          drawnSelEdges.push(a, b);
        } else if (isSeam) {
          drawnSeamEdges.push(a, b);
        } else if (!drawnNormalEdges.has(key)) {
          drawnNormalEdges.add(key);
          ctx.moveTo(screenX[a], screenY[a]);
          ctx.lineTo(screenX[b], screenY[b]);
        }
      }
    }
    ctx.strokeStyle = 'rgba(225, 232, 245, 0.65)';
    ctx.lineWidth = 1;
    ctx.stroke();

    if (drawnSeamEdges.length > 0) {
      ctx.beginPath();
      for (let k = 0; k < drawnSeamEdges.length; k += 2) {
        const a = drawnSeamEdges[k], b = drawnSeamEdges[k + 1];
        ctx.moveTo(screenX[a], screenY[a]);
        ctx.lineTo(screenX[b], screenY[b]);
      }
      ctx.strokeStyle = '#eb3324';
      ctx.lineWidth = 1.8;
      ctx.stroke();
    }

    if (drawnSelEdges.length > 0) {
      ctx.beginPath();
      for (let k = 0; k < drawnSelEdges.length; k += 2) {
        const a = drawnSelEdges[k], b = drawnSelEdges[k + 1];
        ctx.moveTo(screenX[a], screenY[a]);
        ctx.lineTo(screenX[b], screenY[b]);
      }
      ctx.strokeStyle = '#ff9800';
      ctx.lineWidth = 1.9;
      ctx.stroke();
    }

    // 4. UV Vertices & Red Pins (ALWAYS render selected vertices and pins regardless of mesh size)
    let visibleVertCount = 0;
    for (let vi = 0; vi < vCount; vi++) if (projectedFlag[vi]) visibleVertCount++;
    const drawAllUnselected = visibleVertCount <= 3500;
    const hasPins = Object.keys(pinnedObj).length > 0;

    if (this.selectionMode === 'vertex' && drawAllUnselected) {
      ctx.fillStyle = '#cbd5e1';
      ctx.beginPath();
      for (let vi = 0; vi < vCount; vi++) {
        if (!projectedFlag[vi] || this.selectedUVVertices.has(vi)) continue;
        ctx.rect(screenX[vi] - 1.75, screenY[vi] - 1.75, 3.5, 3.5);
      }
      ctx.fill();
    }

    if (this.selectedUVVertices.size > 0) {
      ctx.fillStyle = '#ff9800';
      ctx.beginPath();
      for (const vi of this.selectedUVVertices) {
        if (vi >= 0 && vi < vCount && projectedFlag[vi]) {
          ctx.rect(screenX[vi] - 3, screenY[vi] - 3, 6, 6);
        }
      }
      ctx.fill();
    }

    if (hasPins && posAttr) {
      ctx.fillStyle = '#ef4444';
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1.2;
      for (let vi = 0; vi < vCount; vi++) {
        if (!projectedFlag[vi] || vi >= posAttr.count) continue;
        const pk = pointSpatialKey(posAttr.getX(vi), posAttr.getY(vi), posAttr.getZ(vi));
        const cu = Math.round(uvAttr.getX(vi) * 1000);
        const cv = Math.round(uvAttr.getY(vi) * 1000);
        if (pinnedObj[`${pk}@${cu}_${cv}`] || pinnedObj[pk]) {
          ctx.beginPath();
          ctx.arc(screenX[vi], screenY[vi], 4.4, 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();
        }
      }
    }

    // 5. Box Select Marquee
    if (this._boxMarquee) {
      const bx = Math.min(this._boxMarquee.x0, this._boxMarquee.x1);
      const by = Math.min(this._boxMarquee.y0, this._boxMarquee.y1);
      const bw = Math.abs(this._boxMarquee.x1 - this._boxMarquee.x0);
      const bh = Math.abs(this._boxMarquee.y1 - this._boxMarquee.y0);
      ctx.fillStyle = 'rgba(71, 114, 179, 0.18)';
      ctx.strokeStyle = '#7bb0ff';
      ctx.lineWidth = 1.2;
      ctx.setLineDash([4, 3]);
      ctx.fillRect(bx, by, bw, bh);
      ctx.strokeRect(bx, by, bw, bh);
      ctx.setLineDash([]);
    }

    ctx.restore();
  }

  dispose() {
    this.restoreChecker3DMaterial();
    this._checkerTextureCache?.dispose?.();
    this._checkerTextureCache = null;
    this._resizeObserver?.disconnect?.();
    this._resizeObserver = null;
    if (typeof window !== 'undefined') {
      for (const [type, fn, opts] of this._windowHandlers) {
        window.removeEventListener(type, fn, opts);
      }
    }
    this._windowHandlers = [];
  }
}

function edgeSpatialKeyFromVectorsLocal(posAttr, a, b) {
  const ka = pointSpatialKey(posAttr.getX(a), posAttr.getY(a), posAttr.getZ(a));
  const kb = pointSpatialKey(posAttr.getX(b), posAttr.getY(b), posAttr.getZ(b));
  return ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
}
