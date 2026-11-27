/**
 * @file edit-mode.js
 * @description Blender-style Edit Mode and Mesh Modeling Engine for Web Blender Studio.
 * Provides complete topology-level mesh modeling on Three.js BufferGeometry:
 * - State management: Vertex, Edge, and Face selection modes.
 * - Real-time visual markers: Vertex points, Edge wireframes, Face glow highlights.
 * - 3D Raycasting with click, Shift-multiselect, and 'A' select/deselect all.
 * - TransformControls Gizmo integration acting directly on active mesh vertices in real time.
 * - Modeling operations: Extrude (E), Inset (I), Subdivide, Bevel/Chamfer, Delete (X/Del).
 * - Full Undo/Redo integration with SceneManager.
 */

import * as THREE from 'three';
import { Command, AddObjectCommand } from './scene-manager.js';
import { dataBlockRegistry } from './data-blocks.js';
import { ensureBVH, ensureBVHAsync, refitBVH, disposeBVH, raycastMeshAccelerated } from './bvh-accelerator.js';
import { initMeshKernel, isMeshKernelReady, weldAndExtractTopology, subdivideMesh } from './mesh-kernel-bridge.js';
import { bevelMesh, bevelEdgeCoordKey } from './geometry/bevel.js';
import { isDescendantOf, syncViewportModeOptions } from './mode-resolver.js';
import {
  edgeSpatialKeyFromVectors,
  unwrapMeshLSCM,
  smartUVProjectGeometry,
  cubeProjectGeometry,
  cylinderProjectGeometry,
  sphereProjectGeometry,
  resetUVsGeometry,
  packUVIslandsInPlace,
  averageIslandsScaleInPlace,
  applyUVGeometryUpdate,
  cloneGeometryUserData,
  cloneGeometrySnapshot
} from './geometry/uv-unwrap.js';

/**
 * Undoable command for Mesh Geometry changes in Edit Mode
 */
export class MeshEditCommand extends Command {
  /**
   * @param {THREE.Mesh} mesh
   * @param {THREE.BufferGeometry} oldGeometry
   * @param {THREE.BufferGeometry} newGeometry
   * @param {string} description
   * @param {Function} [onUpdate]
   * @param {Object} [options]
   */
  constructor(mesh, oldGeometry, newGeometry, description = 'Edit Mesh', onUpdate = null, options = {}) {
    super(description);
    this.mesh = mesh;
    this.oldGeometry = cloneGeometrySnapshot(oldGeometry);
    this.newGeometry = cloneGeometrySnapshot(newGeometry);
    this.onUpdate = onUpdate;
    this.options = options || {};
    this._executedOnce = false;
  }

  execute() {
    if (!this.mesh) return;
    this._executedOnce = true;
    this.mesh.geometry.dispose();
    this.mesh.geometry = cloneGeometrySnapshot(this.newGeometry);
    this.mesh.geometry.computeVertexNormals();
    if (this.mesh.geometry.attributes?.position) {
      this.mesh.geometry.attributes.position.needsUpdate = true;
    }
    if (this.options.newSnapshot && typeof this.options.onRestoreSnapshot === 'function') {
      this.options.onRestoreSnapshot(this.options.newSnapshot);
    } else if (this.onUpdate) {
      this.onUpdate(this.mesh);
    }
  }

  /**
   * Update post-edit snapshot in place (used by F9 Adjust Last Operation sliders
   * so dragging a parameter updates the single undo step instead of stacking).
   * @param {THREE.BufferGeometry} newGeometry
   * @param {Object|null} [newSnapshot=null]
   */
  updateNewState(newGeometry, newSnapshot = null) {
    if (!this.mesh || !newGeometry) return;
    if (this.newGeometry && typeof this.newGeometry.dispose === 'function') {
      this.newGeometry.dispose();
    }
    this.newGeometry = cloneGeometrySnapshot(newGeometry);
    if (newSnapshot) {
      this.options.newSnapshot = newSnapshot;
    }
  }

  undo() {
    if (!this.mesh) return;
    this.mesh.geometry.dispose();
    this.mesh.geometry = cloneGeometrySnapshot(this.oldGeometry);
    this.mesh.geometry.computeVertexNormals();
    if (this.mesh.geometry.attributes?.position) {
      this.mesh.geometry.attributes.position.needsUpdate = true;
    }
    if (this.options.oldSnapshot && typeof this.options.onRestoreSnapshot === 'function') {
      this.options.onRestoreSnapshot(this.options.oldSnapshot);
    } else if (this.onUpdate) {
      this.onUpdate(this.mesh);
    }
  }
}

/**
 * Creates a circular dot canvas texture for crisp vertex markers
 */
function createVertexMarkerTexture() {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 64;
  const ctx = canvas.getContext('2d');

  ctx.clearRect(0, 0, 64, 64);
  ctx.beginPath();
  ctx.arc(32, 32, 24, 0, Math.PI * 2);
  ctx.fillStyle = '#ffffff';
  ctx.fill();
  ctx.lineWidth = 4;
  ctx.strokeStyle = '#1a1a1a';
  ctx.stroke();

  const texture = new THREE.CanvasTexture(canvas);
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  return texture;
}

export class EditMode {
  /**
   * @param {Engine} engine
   * @param {Object} [options]
   */
  constructor(engine, options = {}) {
    this.engine = engine;
    this.scene = engine.scene;
    this.sceneManager = options.sceneManager || engine.sceneManager || null;

    // Rust WASM Mesh Kernel initializes lazily when entering Edit Mode (avoids boot WASM fetch).

    // State
    this.isActive = false;
    this.targetMesh = null;
    this.selectionMode = 'vertex'; // 'vertex' | 'edge' | 'face'
    this.proportional = false;
    this.proportionalRadius = 1.0;

    // Topology representation
    // vertices: Array<THREE.Vector3> (welded unique coordinates)
    this.vertices = [];
    // vertexUVs: Array<THREE.Vector2|null> parallel to vertices (preserved across edits)
    this.vertexUVs = [];
    // faces: Array<{ id: number, verts: number[], a: number, b: number, c: number, d?: number, normal: THREE.Vector3, centroid: THREE.Vector3 }>
    this.faces = [];
    // edges: Array<{ id: number, v0: number, v1: number, faces: number[], key: string }>
    this.edges = [];
    this.looseEdges = []; // Array<[v0, v1]> of standalone edges with no adjacent face yet
    this.edgeMap = new Map(); // key `${min}_${max}` -> edge
    this.triangleToFaceMap = []; // triangle index -> polygon face id
    this._outToLogical = null; // rebuilt buffer vertex index -> welded vertex index
    this._modalVertexSnapshot = null; // Snapshot of vertices during active modal G/R/S or GG Slide
    this._slideData = null; // Cached incident edge vectors for Edge/Vertex Slide (GG)
    this._knifeSession = null; // Active interactive Knife state
    this._loopCutSession = null; // Active interactive Ctrl+R Loop Cut state
    this._suppressUndo = false; // True while live-adjusting parameters via F9 panel

    // Selection sets (stores indices)
    this.selectedVertices = new Set();
    this.selectedEdges = new Set();
    this.selectedFaces = new Set();
    this.uvSeams = new Set();
    this.liveUnwrap = false;

    // Visual helpers
    this.helperGroup = new THREE.Group();
    this.helperGroup.name = 'Blender_EditMode_Helpers';
    this.helperGroup.userData.isSystemObject = true;
    this.helperGroup.userData.selectable = false;
    this.helperGroup.matrixAutoUpdate = false;

    this.vertexMarkerTexture = createVertexMarkerTexture();
    this.vertexPoints = null;
    this.edgeLines = null;
    this.faceHighlight = null;

    // Transform Gizmo Proxy
    this.gizmoProxy = new THREE.Object3D();
    this.gizmoProxy.name = 'EditMode_GizmoProxy';
    this.gizmoProxy.userData.isSystemObject = true;
    this.gizmoProxy.userData.selectable = false;
    this.scene.add(this.gizmoProxy);

    this.isGizmoDragging = false;
    this.dragStartPositions = new Map(); // vertex index -> THREE.Vector3
    this.dragStartGizmoPos = new THREE.Vector3();
    this.dragStartGizmoRot = new THREE.Quaternion();
    this.dragStartGizmoScale = new THREE.Vector3();
    this.preTransformGeometry = null;

    // Raycasting
    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2();

    // Bindings
    this._onGizmoMouseDown = this._handleGizmoMouseDown.bind(this);
    this._onGizmoChange = this._handleGizmoChange.bind(this);
    this._onGizmoMouseUp = this._handleGizmoMouseUp.bind(this);

    this._initGizmoListeners();

    // Undo/Redo and object removal can change or delete the mesh underneath us;
    // keep the topology overlay in sync or leave Edit Mode cleanly.
    if (this.sceneManager && typeof this.sceneManager.on === 'function') {
      this.sceneManager.on('historyChanged', (ev) => this._syncFromHistory(ev));
      this.sceneManager.on('objectRemoved', ({ object }) => {
        if (this.isActive && object === this.targetMesh) this.exit();
      });
    }
  }

  _targetStillAttached() {
    if (!this.targetMesh) return false;
    let node = this.targetMesh;
    while (node) {
      if (node === this.scene) return true;
      node = node.parent;
    }
    return false;
  }

  /**
   * Rebuild overlays only when an external (non-MeshEditCommand) undo/redo
   * mutates or removes the active mesh underneath Edit Mode. Never rebuild
   * after executeCommand() pushes our own lossless edit (doing so would weld
   * coincident duplicates on Shift+D and scramble selected edge/face indices).
   * @param {{action?:string, command?:Object}|null} [ev=null]
   */
  _syncFromHistory(ev = null) {
    if (!this.isActive || !this.targetMesh) return;
    if (!this._targetStillAttached()) {
      console.warn('[EditMode] Target removed by undo/redo — exiting Edit Mode.');
      this.exit();
      return;
    }
    if (ev && (ev.action === 'execute' || ev.action === 'clear')) {
      return;
    }
    if (ev?.command instanceof MeshEditCommand) {
      return;
    }
    this._buildTopology(this.targetMesh);
    this.updateVisuals();
    this.updateGizmoProxy();
    this._notifyStatsChanged();
  }

  // =========================================================================
  // INITIALIZATION & GIZMO HOOKS
  // =========================================================================

  _initGizmoListeners() {
    if (!this.engine.transformControls) return;

    this.engine.transformControls.addEventListener('mouseDown', this._onGizmoMouseDown);
    this.engine.transformControls.addEventListener('objectChange', this._onGizmoChange);
    this.engine.transformControls.addEventListener('mouseUp', this._onGizmoMouseUp);
  }

  _handleGizmoMouseDown() {
    if (!this.isActive || this.engine.transformControls.object !== this.gizmoProxy) return;

    this.isGizmoDragging = true;
    this.dragStartGizmoPos.copy(this.gizmoProxy.position);
    this.dragStartGizmoRot.copy(this.gizmoProxy.quaternion);
    this.dragStartGizmoScale.copy(this.gizmoProxy.scale);

    if (this.targetMesh && this.targetMesh.geometry) {
      this.preTransformGeometry = this.targetMesh.geometry.clone();
      this.preTransformSnapshot = this._captureTopologySnapshot();
    }

    // Cache initial local positions of all active vertices
    const activeIndices = this.getActiveVertexIndices();
    this.dragStartPositions.clear();
    for (const idx of activeIndices) {
      if (this.vertices[idx]) {
        this.dragStartPositions.set(idx, this.vertices[idx].clone());
      }
    }
    this.preTransformPositions = this.vertices.map(v => v.clone());
  }

  _handleGizmoChange() {
    if (!this.isActive || !this.isGizmoDragging || this.engine.transformControls.object !== this.gizmoProxy) return;
    if (!this.targetMesh) return;

    // Compute delta transformation of gizmo in world space
    this.gizmoProxy.updateMatrixWorld(true);
    this.targetMesh.updateMatrixWorld(true);
    const startMatrix = new THREE.Matrix4().compose(
      this.dragStartGizmoPos,
      this.dragStartGizmoRot,
      this.dragStartGizmoScale
    );
    const currentMatrix = this.gizmoProxy.matrixWorld.clone();
    const deltaMatrix = currentMatrix.clone().multiply(startMatrix.clone().invert());

    const meshWorldMatrix = this.targetMesh.matrixWorld;
    const invMeshWorld = meshWorldMatrix.clone().invert();

    // Transform each active vertex and compute average delta displacement
    const deltaLocal = new THREE.Vector3();
    let countActive = 0;

    for (const [idx, initPos] of this.dragStartPositions.entries()) {
      const vWorld = initPos.clone().applyMatrix4(meshWorldMatrix);
      vWorld.applyMatrix4(deltaMatrix);
      const vLocal = vWorld.applyMatrix4(invMeshWorld);
      deltaLocal.add(new THREE.Vector3().subVectors(vLocal, initPos));
      countActive++;
      this.vertices[idx].copy(vLocal);
    }

    if (countActive > 0) {
      deltaLocal.divideScalar(countActive);
    }

    // Proportional Editing (O): smooth falloff on neighboring unselected vertices
    if (this.proportional && this.proportionalRadius > 0 && countActive > 0 && this.preTransformPositions) {
      const radius = this.proportionalRadius;
      for (let i = 0; i < this.vertices.length; i++) {
        if (this.dragStartPositions.has(i)) continue;
        const initPos = this.preTransformPositions[i];
        if (!initPos) continue;

        let minD = Infinity;
        for (const [, selInitPos] of this.dragStartPositions.entries()) {
          const d = initPos.distanceTo(selInitPos);
          if (d < minD) minD = d;
        }

        if (minD < radius) {
          const t = minD / radius;
          const weight = 0.5 * (1 + Math.cos(Math.PI * t));
          this.vertices[i].copy(initPos).addScaledVector(deltaLocal, weight);
        } else {
          this.vertices[i].copy(initPos);
        }
      }
    }

    // Update geometry buffer in-place
    this._syncBufferPositions();
    this.targetMesh.geometry.computeVertexNormals();
    this.targetMesh.geometry.attributes.position.needsUpdate = true;
    if (this.targetMesh.geometry.attributes.normal) {
      this.targetMesh.geometry.attributes.normal.needsUpdate = true;
    }

    // Update helpers
    this._updateVisualMarkersPositionOnly();
  }

  _handleGizmoMouseUp() {
    if (!this.isActive || !this.isGizmoDragging) return;
    this.isGizmoDragging = false;

    this._recomputeFaceNormalsAndCentroids();
    if (this.targetMesh && this.preTransformGeometry) {
      this._commitMeshEdit(this.preTransformGeometry, 'Transform Vertices', false, this.preTransformSnapshot || null);
      this.preTransformGeometry = null;
      this.preTransformSnapshot = null;
    }

    // Re-center gizmo on new centroid
    this.updateGizmoProxy();
    this.updateVisuals();
    this._notifyStatsChanged();
  }

  /**
   * Commits a modal G/R/S transform (proxy moved by ModalTransformManager) onto
   * the selected vertices and records a single undo step.
   * @param {{position:THREE.Vector3, quaternion:THREE.Quaternion, scale:THREE.Vector3}} preState
   * @param {{position:THREE.Vector3, quaternion:THREE.Quaternion, scale:THREE.Vector3}} postState
   * @returns {boolean} true when vertices were actually moved
   */
  _computeProxyDeltaMatrix(preState, curState) {
    const preMatrix = new THREE.Matrix4().compose(preState.position, preState.quaternion, preState.scale);
    const curMatrix = new THREE.Matrix4().compose(curState.position, curState.quaternion, curState.scale);
    return new THREE.Matrix4().multiplyMatrices(curMatrix, preMatrix.clone().invert());
  }

  _applyDeltaMatrixToSelection(deltaMatrix, baseVerts, activeIndices) {
    const meshWorldMatrix = this.targetMesh.matrixWorld;
    const invMeshWorld = meshWorldMatrix.clone().invert();
    const origPositions = new Map();
    const deltaLocal = new THREE.Vector3();
    const world = new THREE.Vector3();
    const local = new THREE.Vector3();
    let movedCount = 0;

    for (const idx of activeIndices) {
      const orig = baseVerts[idx];
      if (!orig) continue;
      origPositions.set(idx, orig);

      world.copy(orig).applyMatrix4(meshWorldMatrix).applyMatrix4(deltaMatrix);
      local.copy(world).applyMatrix4(invMeshWorld);

      deltaLocal.add(local.clone().sub(orig));
      this.vertices[idx].copy(local);
      movedCount++;
    }

    if (movedCount === 0) return 0;
    deltaLocal.divideScalar(movedCount);

    // Proportional Editing (O): cosine falloff on unselected neighbors
    if (this.proportional && this.proportionalRadius > 0) {
      const radius = this.proportionalRadius;
      for (let i = 0; i < this.vertices.length; i++) {
        if (origPositions.has(i)) continue;
        const orig = baseVerts[i];
        if (!orig) continue;
        let minD = Infinity;
        for (const selOrig of origPositions.values()) {
          const d = orig.distanceTo(selOrig);
          if (d < minD) minD = d;
        }
        if (minD < radius) {
          const t = minD / radius;
          const weight = 0.5 * (1 + Math.cos(Math.PI * t));
          this.vertices[i].copy(orig).addScaledVector(deltaLocal, weight);
        } else {
          this.vertices[i].copy(orig);
        }
      }
    }
    return movedCount;
  }

  beginModalVertexSession() {
    if (!this.isActive || !this.targetMesh) return false;
    this._modalVertexSnapshot = this.vertices.map(v => v.clone());
    this._modalPreGeometry = this.targetMesh.geometry.clone();
    this._modalPreSnapshot = this._captureTopologySnapshot();
    return true;
  }

  previewModalProxyTransform(preState, curState) {
    if (!this.isActive || !this.targetMesh || !preState || !curState) return false;
    if (!this._modalVertexSnapshot) this.beginModalVertexSession();
    const activeIndices = this.getActiveVertexIndices();
    if (activeIndices.length === 0) return false;

    const deltaMatrix = this._computeProxyDeltaMatrix(preState, curState);
    this._applyDeltaMatrixToSelection(deltaMatrix, this._modalVertexSnapshot, activeIndices);
    this._syncBufferPositions();
    this.targetMesh.geometry.computeVertexNormals();
    if (this.targetMesh.geometry.attributes.normal) {
      this.targetMesh.geometry.attributes.normal.needsUpdate = true;
    }
    this._updateVisualMarkersPositionOnly();
    return true;
  }

  revertModalProxyPreview() {
    this._slideData = null;
    if (!this.isActive || !this.targetMesh || !this._modalVertexSnapshot) return false;
    for (let i = 0; i < this._modalVertexSnapshot.length && i < this.vertices.length; i++) {
      this.vertices[i].copy(this._modalVertexSnapshot[i]);
    }
    this._modalVertexSnapshot = null;
    this._modalPreGeometry = null;
    this._syncBufferPositions();
    this.targetMesh.geometry.computeVertexNormals();
    this._updateVisualMarkersPositionOnly();
    this.updateGizmoProxy();
    return true;
  }

  /**
   * Builds per-vertex slide directions along incident edges for Blender GG Slide.
   */
  prepareSlideTransform() {
    if (!this.isActive || !this.targetMesh) return null;
    if (!this._modalVertexSnapshot) this.beginModalVertexSession();
    // Restore base positions cleanly before switching from G -> GG
    for (let i = 0; i < this._modalVertexSnapshot.length && i < this.vertices.length; i++) {
      this.vertices[i].copy(this._modalVertexSnapshot[i]);
    }

    const activeIndices = this.getActiveVertexIndices();
    if (activeIndices.length === 0) return null;
    const activeSet = new Set(activeIndices);

    // Build adjacency map from welded edges
    const adj = new Map();
    for (const e of this.edges) {
      if (!adj.has(e.v0)) adj.set(e.v0, []);
      if (!adj.has(e.v1)) adj.set(e.v1, []);
      adj.get(e.v0).push(e.v1);
      adj.get(e.v1).push(e.v0);
    }

    // Determine coherent reference slide axis (first non-active incident edge)
    const refDir = new THREE.Vector3();
    for (const vi of activeIndices) {
      const nbrs = adj.get(vi) || [];
      for (const n of nbrs) {
        if (!activeSet.has(n)) {
          refDir.subVectors(this._modalVertexSnapshot[n], this._modalVertexSnapshot[vi]).normalize();
          break;
        }
      }
      if (refDir.lengthSq() > 0.001) break;
    }
    if (refDir.lengthSq() < 0.001) {
      // Fallback: pick first incident edge on first selected vertex
      for (const vi of activeIndices) {
        const nbrs = adj.get(vi) || [];
        if (nbrs.length > 0) {
          refDir.subVectors(this._modalVertexSnapshot[nbrs[0]], this._modalVertexSnapshot[vi]).normalize();
          break;
        }
      }
    }
    if (refDir.lengthSq() < 0.001) refDir.set(1, 0, 0);

    const perVertex = new Map();
    for (const vi of activeIndices) {
      const orig = this._modalVertexSnapshot[vi];
      const nbrs = adj.get(vi) || [];
      const nonSelected = nbrs.filter(n => !activeSet.has(n));
      const candidates = nonSelected.length > 0 ? nonSelected : nbrs;
      if (candidates.length === 0) continue;

      let bestPos = null;
      let bestPosDot = -Infinity;
      let bestNeg = null;
      let bestNegDot = Infinity;

      for (const n of candidates) {
        const diff = new THREE.Vector3().subVectors(this._modalVertexSnapshot[n], orig);
        const len = diff.length();
        if (len < 1e-6) continue;
        const unit = diff.clone().divideScalar(len);
        const d = unit.dot(refDir);
        if (d >= 0 && d > bestPosDot) {
          bestPosDot = d;
          bestPos = diff;
        }
        if (d < 0 && d < bestNegDot) {
          bestNegDot = d;
          bestNeg = diff;
        }
      }
      if (!bestPos && bestNeg) bestPos = bestNeg.clone();
      if (!bestNeg && bestPos) bestNeg = bestPos.clone().negate();
      if (bestPos || bestNeg) {
        perVertex.set(vi, { orig: orig.clone(), posVec: bestPos, negVec: bestNeg });
      }
    }

    if (perVertex.size === 0) return null;
    const worldRefDir = refDir.clone().transformDirection(this.targetMesh.matrixWorld).normalize();
    this._slideData = { refDir: refDir.clone(), worldRefDir, perVertex };
    return this._slideData;
  }

  applySlideTransform(factor = 0, clamp = true) {
    if (!this._slideData || !this.targetMesh) return false;
    const clamped = clamp ? Math.max(-1, Math.min(1, factor)) : Math.max(-5, Math.min(5, factor));
    for (const [vi, info] of this._slideData.perVertex.entries()) {
      const vec = clamped >= 0 ? info.posVec : info.negVec;
      const t = Math.abs(clamped);
      if (vec) {
        this.vertices[vi].copy(info.orig).addScaledVector(vec, t);
      }
    }
    this._syncBufferPositions();
    this.targetMesh.geometry.computeVertexNormals();
    if (this.targetMesh.geometry.attributes.normal) {
      this.targetMesh.geometry.attributes.normal.needsUpdate = true;
    }
    this._updateVisualMarkersPositionOnly();
    this.updateGizmoProxy();
    return true;
  }

  commitSlideTransform() {
    if (!this._slideData || !this.targetMesh) return false;
    const preGeom = this._modalPreGeometry || this.targetMesh.geometry.clone();
    const preSnap = this._modalPreSnapshot || null;
    this._slideData = null;
    this._modalVertexSnapshot = null;
    this._modalPreGeometry = null;
    this._modalPreSnapshot = null;
    this._recomputeFaceNormalsAndCentroids();
    this.rebuildGeometry();
    this._commitMeshEdit(preGeom, 'Edge/Vertex Slide', false, preSnap);
    return true;
  }

  commitModalProxyTransform(preState, postState) {
    if (!this.isActive || !this.targetMesh || !this.gizmoProxy || !preState || !postState) return false;

    const activeIndices = this.getActiveVertexIndices();
    if (activeIndices.length === 0) {
      this._modalVertexSnapshot = null;
      this._modalPreGeometry = null;
      this._modalPreSnapshot = null;
      this.updateGizmoProxy();
      return false;
    }

    const deltaMatrix = this._computeProxyDeltaMatrix(preState, postState);
    const hasSnapshot = Array.isArray(this._modalVertexSnapshot);
    if (deltaMatrix.equals(new THREE.Matrix4()) && !hasSnapshot) {
      this.updateGizmoProxy();
      return false;
    }

    const preGeometry = this._modalPreGeometry || this.targetMesh.geometry.clone();
    const preSnap = this._modalPreSnapshot || null;
    const baseVerts = hasSnapshot ? this._modalVertexSnapshot : this.vertices.map(v => v.clone());
    const movedCount = this._applyDeltaMatrixToSelection(deltaMatrix, baseVerts, activeIndices);
    this._modalVertexSnapshot = null;
    this._modalPreGeometry = null;
    this._modalPreSnapshot = null;

    if (movedCount === 0) {
      this.updateGizmoProxy();
      return false;
    }

    this._recomputeFaceNormalsAndCentroids();
    this.rebuildGeometry();
    this._commitMeshEdit(preGeometry, 'Transform Vertices', false, preSnap);
    return true;
  }

  // =========================================================================
  // ENTER / EXIT EDIT MODE
  // =========================================================================

  /**
   * Enters Edit Mode for the specified Mesh object
   * @param {THREE.Mesh} mesh
   * @returns {boolean}
   */
  enter(mesh) {
    if (!mesh || !mesh.isMesh || !mesh.geometry) {
      console.warn('[EditMode] Cannot enter Edit Mode: target is not a valid Mesh.');
      return false;
    }

    if (this.isActive) {
      this.exit();
    }
    if (typeof window !== 'undefined') {
      if (window.sculptMode?.isActive) window.sculptMode.exit();
      if (window.paintMode?.isActive) window.paintMode.exit();
      if (window.rigSystem?.isWeightPaintMode) window.rigSystem.disableWeightPaintMode();
      if (window.rigSystem?.isEditBoneMode) window.rigSystem.exitEditBoneMode();
      if (window.rigSystem?.isPoseMode) window.rigSystem.setPoseMode(false);
    }

    this.targetMesh = mesh;
    this.isActive = true;
    if (!isMeshKernelReady()) {
      initMeshKernel().catch(() => {});
    }

    // Detach standard object TransformControls
    if (this.engine.transformControls) {
      this.engine.transformControls.detach();
    }
    if (this.engine.selectionBox) {
      this.engine.selectionBox.visible = false;
    }

    // Build topology from current geometry
    this._buildTopology(this.targetMesh);
    // BVH tăng tốc raycast chọn mặt/đỉnh/cạnh trên mesh nhiều đa giác.
    // Mesh lớn build trong worker (không chặn UI); mesh nhỏ fallback đồng bộ ngay.
    ensureBVHAsync(this.targetMesh);

    // Attach helper group
    this._updateHelperTransform();
    if (!this.helperGroup.parent) {
      this.scene.add(this.helperGroup);
    }

    // Default select all vertices on first enter if none selected, or leave clean
    this.selectedVertices.clear();
    this.selectedEdges.clear();
    this.selectedFaces.clear();

    // Rebuild visual markers
    this.updateVisuals();
    this.updateGizmoProxy();

    // Synchronize UI dropdown & buttons
    this._syncUIState(true);
    syncViewportModeOptions(
      this.sceneManager?.getActiveObject?.() || mesh,
      this.sceneManager,
      typeof window !== 'undefined' ? window.rigSystem : null
    );
    this._notifyStatsChanged();
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('blender:mode-changed', { detail: { mode: 'edit' } }));
    }

    console.log(`[EditMode] Entered Edit Mode for "${mesh.name}" (Verts: ${this.vertices.length}, Faces: ${this.faces.length})`);
    return true;
  }

  /**
   * Exits Edit Mode and returns to Object Mode
   */
  exit() {
    if (!this.isActive) return;

    this.cancelKnifeMode?.();
    this.cancelLoopCutMode?.();

    // Detach Gizmo
    if (this.engine.transformControls) {
      this.engine.transformControls.detach();
    }

    // Remove helpers
    if (this.helperGroup.parent) {
      this.helperGroup.parent.remove(this.helperGroup);
    }
    this._disposeVisualHelpers();

    // Commit final mesh normals and bounds
    if (this.targetMesh && this.targetMesh.geometry) {
      this.targetMesh.geometry.computeVertexNormals();
      this.targetMesh.geometry.computeBoundingBox();
      this.targetMesh.geometry.computeBoundingSphere();
    }
    disposeBVH(this.targetMesh);

    const previousMesh = this.targetMesh;
    if (previousMesh) {
      const root = this.sceneManager?.rootContainer || this.engine?.scene || null;
      dataBlockRegistry.propagateMeshData(previousMesh, root);
    }
    this.isActive = false;
    this.targetMesh = null;
    this.selectedVertices.clear();
    this.selectedEdges.clear();
    this.selectedFaces.clear();

    // Re-attach object mode TransformControls if mesh or its parent Group is still selected in SceneManager
    const activeObj = this.sceneManager?.getActiveObject?.();
    if (
      previousMesh &&
      this.sceneManager &&
      (
        this.sceneManager.isSelected(previousMesh) ||
        (activeObj && isDescendantOf(previousMesh, activeObj))
      )
    ) {
      this.engine?.updateActiveGizmo?.(activeObj || previousMesh);
      this.engine?.updateSelectionHelper?.();
    }

    // Synchronize UI dropdown
    this._syncUIState(false);
    syncViewportModeOptions(
      activeObj || null,
      this.sceneManager,
      typeof window !== 'undefined' ? window.rigSystem : null
    );
    this._notifyStatsChanged();
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('blender:mode-changed', { detail: { mode: 'object' } }));
    }

    console.log('[EditMode] Exited Edit Mode.');
  }

  /**
   * Sets selection mode: 'vertex' | 'edge' | 'face'
   * @param {'vertex'|'edge'|'face'} mode
   */
  setMode(mode) {
    if (!['vertex', 'edge', 'face'].includes(mode)) return;
    this.selectionMode = mode;

    this.updateVisuals();
    this.updateGizmoProxy();
    this._syncUIButtons();
    console.log(`[EditMode] Selection mode: ${mode}`);
  }

  /**
   * Backwards-compatible alias: AI Copilot / STEM scripts sometimes call
   * setSelectionMode('face') instead of setMode('face').
   */
  setSelectionMode(mode) {
    return this.setMode(mode);
  }

  // =========================================================================
  // TOPOLOGY CONSTRUCTION & WELDING
  // =========================================================================

  _buildTopology(mesh) {
    const geom = mesh.geometry;
    if (!geom) return;

    this.vertices = [];
    this.vertexUVs = [];
    this.faces = [];
    this.edges = [];
    this.looseEdges = [];
    this.edgeMap.clear();
    this._outToLogical = null;
    this.uvSeams = new Set(Array.isArray(geom.userData?._uvSeams) ? geom.userData._uvSeams : []);

    const pos = geom.attributes.position;
    if (!pos) return;
    const uvAttr = geom.attributes.uv && geom.attributes.uv.count === pos.count ? geom.attributes.uv : null;

    const index = geom.index;
    const numTris = index ? index.count / 3 : Math.floor(pos.count / 3);

    // -----------------------------------------------------------------------
    // High-Performance Acceleration via Rust WASM Kernel (for dense sculpts > 12000 tris)
    // -----------------------------------------------------------------------
    if (isMeshKernelReady() && pos.count >= 3 && numTris > 12000) {
      const wasmRes = weldAndExtractTopology(
        pos.array,
        index ? index.array : null,
        0.0001
      );
      if (wasmRes) {
        const { vertices: wVerts, indices: wIndices, edges: wEdges, normals: wNormals, map: wMap } = wasmRes;
        const weldedCount = wVerts.length / 3;

        this.vertices = new Array(weldedCount);
        this.vertexUVs = new Array(weldedCount);
        for (let i = 0; i < weldedCount; i++) {
          this.vertices[i] = new THREE.Vector3(wVerts[i * 3], wVerts[i * 3 + 1], wVerts[i * 3 + 2]);
          this.vertexUVs[i] = null;
        }

        if (uvAttr) {
          for (let srcIdx = 0; srcIdx < wMap.length; srcIdx++) {
            const wIdx = wMap[srcIdx];
            if (!this.vertexUVs[wIdx]) {
              this.vertexUVs[wIdx] = new THREE.Vector2(uvAttr.getX(srcIdx), uvAttr.getY(srcIdx));
            }
          }
        }

        this._outToLogical = wMap;

        // Extract unique edges directly from Rust WASM
        const edgeCount = wEdges.length / 2;
        this.edges = new Array(edgeCount);
        for (let e = 0; e < edgeCount; e++) {
          const v0 = wEdges[e * 2];
          const v1 = wEdges[e * 2 + 1];
          const key = `${v0}_${v1}`;
          const edge = { id: e, v0, v1, faces: [], key };
          this.edges[e] = edge;
          this.edgeMap.set(key, edge);
        }

        // For ultra-dense meshes (> 12000 triangles), skip coplanar quad search and
        // construct faces directly in O(N) in milliseconds.
        if (numTris > 12000) {
          const triCount = wIndices.length / 3;
          this.faces = new Array(triCount);
          for (let t = 0; t < triCount; t++) {
            const a = wIndices[t * 3];
            const b = wIndices[t * 3 + 1];
            const c = wIndices[t * 3 + 2];
            const norm = new THREE.Vector3(wNormals[t * 3], wNormals[t * 3 + 1], wNormals[t * 3 + 2]);
            const centroid = new THREE.Vector3()
              .add(this.vertices[a])
              .add(this.vertices[b])
              .add(this.vertices[c])
              .multiplyScalar(1 / 3);

            const uvs = uvAttr ? [
              this.vertexUVs[a] ? this.vertexUVs[a].clone() : null,
              this.vertexUVs[b] ? this.vertexUVs[b].clone() : null,
              this.vertexUVs[c] ? this.vertexUVs[c].clone() : null
            ] : null;

            this.faces[t] = {
              id: t,
              verts: [a, b, c],
              a, b, c, d: null,
              normal: norm,
              centroid,
              uvs
            };

            const pairs = [[a, b], [b, c], [c, a]];
            for (const [u, v] of pairs) {
              const k = `${Math.min(u, v)}_${Math.max(u, v)}`;
              const ed = this.edgeMap.get(k);
              if (ed && !ed.faces.includes(t)) ed.faces.push(t);
            }
          }

          if (triCount === numTris) {
            this.triangleToFaceMap = new Array(numTris);
            for (let i = 0; i < numTris; i++) this.triangleToFaceMap[i] = i;
          } else {
            // Mirror mesh_kernel_weld's degenerate-triangle filtering so raycast
            // hit.faceIndex in the unmodified geometry stays 1:1 with faces.
            const triToFace = new Array(numTris).fill(-1);
            let activeFaceIdx = 0;
            for (let t = 0; t < numTris; t++) {
              const i0 = index ? index.getX(t * 3 + 0) : t * 3 + 0;
              const i1 = index ? index.getX(t * 3 + 1) : t * 3 + 1;
              const i2 = index ? index.getX(t * 3 + 2) : t * 3 + 2;
              const w0 = i0 < wMap.length ? wMap[i0] : i0;
              const w1 = i1 < wMap.length ? wMap[i1] : i1;
              const w2 = i2 < wMap.length ? wMap[i2] : i2;
              if (w0 !== w1 && w1 !== w2 && w2 !== w0 && activeFaceIdx < this.faces.length) {
                triToFace[t] = activeFaceIdx++;
              }
            }
            this.triangleToFaceMap = triToFace;
          }
          this._applySeamFlagsToEdges();
          this._notifyStatsChanged();
          return;
        }
      }
    }

    const outToLogical = new Int32Array(pos.count);
    outToLogical.fill(-1);

    // Spatial hash for vertex welding (tolerance 1e-4)
    const coordMap = new Map();
    const getWeldedIndex = (x, y, z, srcIdx) => {
      const kx = Math.round(x * 10000);
      const ky = Math.round(y * 10000);
      const kz = Math.round(z * 10000);
      const key = `${kx}_${ky}_${kz}`;

      if (coordMap.has(key)) {
        const existing = coordMap.get(key);
        if (srcIdx >= 0 && srcIdx < outToLogical.length) {
          outToLogical[srcIdx] = existing;
        }
        if (!this.vertexUVs[existing] && uvAttr) {
          this.vertexUVs[existing] = new THREE.Vector2(uvAttr.getX(srcIdx), uvAttr.getY(srcIdx));
        }
        return existing;
      }
      const newIdx = this.vertices.length;
      this.vertices.push(new THREE.Vector3(x, y, z));
      this.vertexUVs.push(uvAttr ? new THREE.Vector2(uvAttr.getX(srcIdx), uvAttr.getY(srcIdx)) : null);
      coordMap.set(key, newIdx);
      if (srcIdx >= 0 && srcIdx < outToLogical.length) {
        outToLogical[srcIdx] = newIdx;
      }
      return newIdx;
    };

    const pA = new THREE.Vector3();
    const pB = new THREE.Vector3();
    const pC = new THREE.Vector3();

    // 1. Build welded raw triangles
    const rawTris = [];
    for (let t = 0; t < numTris; t++) {
      let i0, i1, i2;
      if (index) {
        i0 = index.getX(t * 3 + 0);
        i1 = index.getX(t * 3 + 1);
        i2 = index.getX(t * 3 + 2);
      } else {
        i0 = t * 3 + 0;
        i1 = t * 3 + 1;
        i2 = t * 3 + 2;
      }

      pA.fromBufferAttribute(pos, i0);
      pB.fromBufferAttribute(pos, i1);
      pC.fromBufferAttribute(pos, i2);

      const w0 = getWeldedIndex(pA.x, pA.y, pA.z, i0);
      const w1 = getWeldedIndex(pB.x, pB.y, pB.z, i1);
      const w2 = getWeldedIndex(pC.x, pC.y, pC.z, i2);

      // Skip degenerate triangles
      if (w0 === w1 || w1 === w2 || w2 === w0) continue;

      const v0 = this.vertices[w0];
      const v1 = this.vertices[w1];
      const v2 = this.vertices[w2];

      const norm = new THREE.Vector3()
        .subVectors(v1, v0)
        .cross(new THREE.Vector3().subVectors(v2, v0))
        .normalize();

      rawTris.push({
        origTri: t,
        a: w0,
        b: w1,
        c: w2,
        normal: norm,
        // Per-loop UVs: a welded vertex may need different UVs per face, so
        // keep the original UV of this triangle corner alongside the index.
        uvs: uvAttr ? [
          new THREE.Vector2(uvAttr.getX(i0), uvAttr.getY(i0)),
          new THREE.Vector2(uvAttr.getX(i1), uvAttr.getY(i1)),
          new THREE.Vector2(uvAttr.getX(i2), uvAttr.getY(i2))
        ] : null
      });
    }

    const triCornerUV = (tri, weldedIdx) => {
      if (!tri.uvs) return null;
      if (tri.a === weldedIdx) return tri.uvs[0];
      if (tri.b === weldedIdx) return tri.uvs[1];
      if (tri.c === weldedIdx) return tri.uvs[2];
      return null;
    };

    // 2. Pair adjacent coplanar / grid-curved triangles into clean convex Quad faces
    // Scored pairing prefers rectangular diagonals & UV-diagonal matches over greedy zig-zag.
    const paired = new Set();
    const edgeToTris = new Map();
    rawTris.forEach((tri, tIdx) => {
      const edges = [[tri.a, tri.b], [tri.b, tri.c], [tri.c, tri.a]];
      edges.forEach(([u, v]) => {
        const k = `${Math.min(u, v)}_${Math.max(u, v)}`;
        if (!edgeToTris.has(k)) edgeToTris.set(k, []);
        edgeToTris.get(k).push({ tIdx, u, v });
      });
    });

    const triToFace = new Array(numTris).fill(-1);
    const quadCandidates = [];
    const eTmp1 = new THREE.Vector3();
    const eTmp2 = new THREE.Vector3();
    const cTmp = new THREE.Vector3();

    for (const [, sharing] of edgeToTris.entries()) {
      if (sharing.length !== 2) continue;
      const s1 = sharing[0];
      const s2 = sharing[1];
      if (s1.tIdx === s2.tIdx) continue;
      // Require opposite edge direction for manifold winding
      if (!(s1.u === s2.v && s1.v === s2.u)) continue;

      const t1 = s1.tIdx;
      const t2 = s2.tIdx;
      const tri1 = rawTris[t1];
      const tri2 = rawTris[t2];
      const u = s1.u;
      const v = s1.v;

      const dot = tri1.normal.dot(tri2.normal);
      if (dot <= 0.96) continue;

      const w1 = [tri1.a, tri1.b, tri1.c].find(x => x !== u && x !== v);
      const w2 = [tri2.a, tri2.b, tri2.c].find(x => x !== u && x !== v);
      if (w1 === undefined || w2 === undefined || w1 === w2) continue;

      const quadVerts = [w1, u, w2, v];

      // Convexity check around averaged normal
      const avgNorm = new THREE.Vector3().addVectors(tri1.normal, tri2.normal).normalize();
      let convex = true;
      for (let k = 0; k < 4; k++) {
        const p0 = this.vertices[quadVerts[k]];
        const p1 = this.vertices[quadVerts[(k + 1) % 4]];
        const p2 = this.vertices[quadVerts[(k + 2) % 4]];
        eTmp1.subVectors(p1, p0);
        eTmp2.subVectors(p2, p1);
        cTmp.crossVectors(eTmp1, eTmp2);
        if (cTmp.dot(avgNorm) <= 1e-6) { convex = false; break; }
      }
      if (!convex) continue;

      // Rectangularity & diagonal dominance scoring
      const pU = this.vertices[u], pV = this.vertices[v];
      const pW1 = this.vertices[w1], pW2 = this.vertices[w2];
      const diagSq = pU.distanceToSquared(pV);
      const sA = pW1.distanceToSquared(pU);
      const sB = pW1.distanceToSquared(pV);
      const sC = pW2.distanceToSquared(pU);
      const sD = pW2.distanceToSquared(pV);
      const maxSideSq = Math.max(sA, sB, sC, sD);
      const d1 = eTmp1.subVectors(pU, pW1).normalize();
      const d2 = eTmp2.subVectors(pV, pW1).normalize();
      const rectScore = 1.0 - Math.abs(d1.dot(d2)); // 1.0 near 90 deg

      // UV continuity & diagonal check
      let uvDiagBonus = 0;
      const uvU1 = triCornerUV(tri1, u), uvV1 = triCornerUV(tri1, v);
      const uvU2 = triCornerUV(tri2, u), uvV2 = triCornerUV(tri2, v);
      if (uvU1 && uvV1 && uvU2 && uvV2) {
        const uvSame = uvU1.distanceToSquared(uvU2) < 1e-6 && uvV1.distanceToSquared(uvV2) < 1e-6;
        if (uvSame && Math.abs(uvU1.x - uvV1.x) > 1e-4 && Math.abs(uvU1.y - uvV1.y) > 1e-4) {
          uvDiagBonus = 4.0;
        }
      }

      const isPlanar = dot > 0.999;
      const strongCurvedQuad = (uvDiagBonus > 0 || (diagSq > maxSideSq * 1.1 && rectScore > 0.72));
      if (!isPlanar && !strongCurvedQuad) continue;

      const diagBonus = diagSq > maxSideSq * 1.02 ? 2.0 : 0.0;
      const orderBonus = Math.abs(t1 - t2) === 1 ? 0.5 : 0.0;

      quadCandidates.push({
        t1,
        t2,
        quadVerts,
        normal: avgNorm,
        score: (isPlanar ? 3.0 : 0.0) + uvDiagBonus + diagBonus + rectScore + orderBonus
      });
    }

    quadCandidates.sort((a, b) => b.score - a.score);

    for (const cand of quadCandidates) {
      if (paired.has(cand.t1) || paired.has(cand.t2)) continue;
      const tri1 = rawTris[cand.t1];
      const tri2 = rawTris[cand.t2];
      const quadVerts = cand.quadVerts;

      const centroid = new THREE.Vector3()
        .add(this.vertices[quadVerts[0]])
        .add(this.vertices[quadVerts[1]])
        .add(this.vertices[quadVerts[2]])
        .add(this.vertices[quadVerts[3]])
        .multiplyScalar(0.25);

      const quadUVs = (tri1.uvs || tri2.uvs) ? quadVerts.map((vIdx) => {
        const uv = triCornerUV(tri1, vIdx) || triCornerUV(tri2, vIdx);
        return uv ? uv.clone() : null;
      }) : null;

      const fId = this.faces.length;
      this.faces.push({
        id: fId,
        verts: quadVerts,
        a: quadVerts[0],
        b: quadVerts[1],
        c: quadVerts[2],
        d: quadVerts[3],
        normal: cand.normal,
        centroid,
        uvs: quadUVs
      });
      if (tri1.origTri >= 0 && tri1.origTri < numTris) triToFace[tri1.origTri] = fId;
      if (tri2.origTri >= 0 && tri2.origTri < numTris) triToFace[tri2.origTri] = fId;

      paired.add(cand.t1);
      paired.add(cand.t2);
    }

    for (let i = 0; i < rawTris.length; i++) {
      if (paired.has(i)) continue;
      const tri1 = rawTris[i];
      const centroid = new THREE.Vector3()
        .add(this.vertices[tri1.a])
        .add(this.vertices[tri1.b])
        .add(this.vertices[tri1.c])
        .multiplyScalar(1 / 3);

      const fId = this.faces.length;
      this.faces.push({
        id: fId,
        verts: [tri1.a, tri1.b, tri1.c],
        a: tri1.a,
        b: tri1.b,
        c: tri1.c,
        d: null,
        normal: tri1.normal.clone(),
        centroid: centroid,
        uvs: tri1.uvs ? tri1.uvs.map(uv => uv.clone()) : null
      });
      if (tri1.origTri >= 0 && tri1.origTri < numTris) triToFace[tri1.origTri] = fId;
      paired.add(i);
    }

    // If mesh has loose vertices (no faces), load unique welded positions from attribute
    if (this.vertices.length === 0 && pos.count > 0) {
      const p = new THREE.Vector3();
      for (let i = 0; i < pos.count; i++) {
        p.fromBufferAttribute(pos, i);
        getWeldedIndex(p.x, p.y, p.z, i);
      }
    }

    // Restore serialized loose edges (stored by endpoint coordinates so indices survive rebuilds/undo)
    const rawLoose = geom.userData?._looseEdges;
    if (Array.isArray(rawLoose)) {
      const findOrAddVert = (x, y, z) => {
        const kx = Math.round(x * 10000);
        const ky = Math.round(y * 10000);
        const kz = Math.round(z * 10000);
        const key = `${kx}_${ky}_${kz}`;
        if (coordMap.has(key)) return coordMap.get(key);
        const idx = this.vertices.length;
        this.vertices.push(new THREE.Vector3(x, y, z));
        this.vertexUVs.push(null);
        coordMap.set(key, idx);
        return idx;
      };
      for (const seg of rawLoose) {
        if (!Array.isArray(seg) || seg.length < 6) continue;
        const i0 = findOrAddVert(seg[0], seg[1], seg[2]);
        const i1 = findOrAddVert(seg[3], seg[4], seg[5]);
        if (i0 !== i1) {
          this.looseEdges.push([Math.min(i0, i1), Math.max(i0, i1)]);
        }
      }
    }

    this._outToLogical = outToLogical;

    // Build unique boundary & loose edges
    this._rebuildEdges();

    // Triangle -> face lookup tracks each original geometry triangle `t` to its
    // paired face id so picking matches unmodified mesh.geometry before any rebuild.
    this.triangleToFaceMap = triToFace;

    this._notifyStatsChanged();
  }

  /**
   * Re-reads the weld topology (including per-corner loop UVs) from the live
   * geometry. Used when UVs are edited underneath an active Edit Mode session.
   */
  syncTopologyFromGeometry() {
    if (!this.isActive || !this.targetMesh?.geometry) return;
    this._buildTopology(this.targetMesh);
    ensureBVH(this.targetMesh);
    this.updateVisuals();
    this.updateGizmoProxy();
  }

  _rebuildEdges() {
    this.edges = [];
    this.edgeMap.clear();

    const addEdge = (u, v, faceId) => {
      const v0 = Math.min(u, v);
      const v1 = Math.max(u, v);
      const key = `${v0}_${v1}`;

      if (this.edgeMap.has(key)) {
        const edge = this.edgeMap.get(key);
        if (faceId !== null && faceId !== undefined && !edge.faces.includes(faceId)) {
          edge.faces.push(faceId);
        }
      } else {
        const edge = {
          id: this.edges.length,
          v0,
          v1,
          faces: faceId !== null && faceId !== undefined ? [faceId] : [],
          key
        };
        this.edges.push(edge);
        this.edgeMap.set(key, edge);
      }
    };

    for (const f of this.faces) {
      const vCount = f.verts.length;
      for (let k = 0; k < vCount; k++) {
        addEdge(f.verts[k], f.verts[(k + 1) % vCount], f.id);
      }
    }

    // Emit standalone loose edges (auto-prune any edge promoted into a face)
    if (Array.isArray(this.looseEdges) && this.looseEdges.length > 0) {
      const survivingLoose = [];
      for (const pair of this.looseEdges) {
        if (!Array.isArray(pair) || pair.length < 2) continue;
        const v0 = Math.min(pair[0], pair[1]);
        const v1 = Math.max(pair[0], pair[1]);
        if (v0 === v1 || !this.vertices[v0] || !this.vertices[v1]) continue;
        const key = `${v0}_${v1}`;
        if (!this.edgeMap.has(key)) {
          addEdge(v0, v1, null);
          survivingLoose.push([v0, v1]);
        }
      }
      this.looseEdges = survivingLoose;
    }
    this._applySeamFlagsToEdges();
  }

  /**
   * Computes normalized Newell polygon normal for an arbitrary vertex index loop.
   * @param {number[]} vertIndices
   * @returns {THREE.Vector3}
   */
  _computeNewellNormal(vertIndices) {
    const n = new THREE.Vector3();
    const len = vertIndices.length;
    for (let i = 0; i < len; i++) {
      const cur = this.vertices[vertIndices[i]];
      const next = this.vertices[vertIndices[(i + 1) % len]];
      if (!cur || !next) continue;
      n.x += (cur.y - next.y) * (cur.z + next.z);
      n.y += (cur.z - next.z) * (cur.x + next.x);
      n.z += (cur.x - next.x) * (cur.y + next.y);
    }
    if (n.lengthSq() < 1e-12) return new THREE.Vector3(0, 1, 0);
    return n.normalize();
  }

  /**
   * Creates a normalized face record from vertex indices and optional loop UVs.
   * @param {number} id
   * @param {number[]} vertIndices
   * @param {Array<THREE.Vector2|null>|null} [uvs=null]
   * @returns {Object}
   */
  _createFaceRecord(id, vertIndices, uvs = null) {
    const centroid = new THREE.Vector3();
    for (const vi of vertIndices) {
      if (this.vertices[vi]) centroid.add(this.vertices[vi]);
    }
    centroid.multiplyScalar(1 / Math.max(1, vertIndices.length));
    const normal = this._computeNewellNormal(vertIndices);
    return {
      id,
      verts: vertIndices,
      a: vertIndices[0],
      b: vertIndices[1],
      c: vertIndices[2],
      d: vertIndices.length > 3 ? vertIndices[3] : null,
      normal,
      centroid,
      uvs: uvs ? uvs.map(uv => uv ? uv.clone() : null) : vertIndices.map(vi => this.vertexUVs[vi] ? this.vertexUVs[vi].clone() : null)
    };
  }

  _recomputeFaceNormalsAndCentroids() {
    const e1 = new THREE.Vector3();
    const e2 = new THREE.Vector3();
    const nAcc = new THREE.Vector3();
    const cAcc = new THREE.Vector3();
    for (const f of this.faces) {
      if (!f || !f.verts || f.verts.length < 3) continue;
      cAcc.set(0, 0, 0);
      nAcc.set(0, 0, 0);
      const count = f.verts.length;
      const v0 = this.vertices[f.verts[0]];
      if (!v0) continue;
      for (let k = 0; k < count; k++) {
        const vk = this.vertices[f.verts[k]];
        if (vk) cAcc.add(vk);
      }
      cAcc.multiplyScalar(1 / count);
      for (let k = 1; k + 1 < count; k++) {
        const v1 = this.vertices[f.verts[k]];
        const v2 = this.vertices[f.verts[k + 1]];
        if (!v1 || !v2) continue;
        e1.subVectors(v1, v0);
        e2.subVectors(v2, v0);
        nAcc.add(new THREE.Vector3().crossVectors(e1, e2));
      }
      if (nAcc.lengthSq() > 1e-12) {
        nAcc.normalize();
        if (!f.normal) f.normal = nAcc.clone();
        else f.normal.copy(nAcc);
      }
      if (!f.centroid) f.centroid = cAcc.clone();
      else f.centroid.copy(cAcc);
    }
  }

  _captureTopologySnapshot() {
    if (!this.isActive) return null;
    return {
      vertices: this.vertices.map(v => v.clone()),
      vertexUVs: this.vertexUVs.map(uv => (uv ? uv.clone() : null)),
      faces: this.faces.map(f => ({
        id: f.id,
        verts: [...f.verts],
        a: f.a,
        b: f.b,
        c: f.c,
        d: f.d,
        normal: f.normal ? f.normal.clone() : new THREE.Vector3(0, 1, 0),
        centroid: f.centroid ? f.centroid.clone() : new THREE.Vector3(),
        uvs: f.uvs ? f.uvs.map(uv => (uv ? uv.clone() : null)) : null
      })),
      looseEdges: Array.isArray(this.looseEdges) ? this.looseEdges.map(([a, b]) => [a, b]) : [],
      uvSeams: Array.from(this.uvSeams || []),
      selectionMode: this.selectionMode,
      selectedVertices: Array.from(this.selectedVertices),
      selectedEdges: Array.from(this.selectedEdges),
      selectedFaces: Array.from(this.selectedFaces)
    };
  }

  _restoreTopologySnapshot(snap) {
    if (!snap || !this.isActive || !this.targetMesh) return;
    this.vertices = snap.vertices.map(v => v.clone());
    this.vertexUVs = snap.vertexUVs.map(uv => (uv ? uv.clone() : null));
    this.faces = snap.faces.map((f, idx) => ({
      id: idx,
      verts: [...f.verts],
      a: f.verts[0],
      b: f.verts[1],
      c: f.verts[2],
      d: f.verts.length > 3 ? f.verts[3] : null,
      normal: f.normal.clone(),
      centroid: f.centroid.clone(),
      uvs: f.uvs ? f.uvs.map(uv => (uv ? uv.clone() : null)) : null
    }));
    this.looseEdges = snap.looseEdges.map(([a, b]) => [a, b]);
    this.uvSeams = new Set(snap.uvSeams || []);
    this._rebuildEdges();
    this._applySeamFlagsToEdges();
    this.selectionMode = snap.selectionMode || this.selectionMode;
    this.selectedVertices = new Set(snap.selectedVertices.filter(v => v >= 0 && v < this.vertices.length));
    this.selectedEdges = new Set(snap.selectedEdges.filter(e => e >= 0 && e < this.edges.length));
    this.selectedFaces = new Set(snap.selectedFaces.filter(f => f >= 0 && f < this.faces.length));
    this.rebuildGeometry();
    ensureBVH(this.targetMesh);
    this.updateVisuals();
    this.updateGizmoProxy();
    this._syncUIState(true);
    this._notifyStatsChanged();
  }

  /**
   * Shared commit helper for Edit Mode topology mutations (rebuilds edges, geometry,
   * overlays, gizmo proxy, and pushes one Undo/Redo MeshEditCommand with lossless snapshot).
   */
  _commitMeshEdit(oldGeom, description = 'Edit Mesh', rebuild = true, oldSnap = null) {
    if (rebuild) {
      this._recomputeFaceNormalsAndCentroids();
      this._rebuildEdges();
      this.rebuildGeometry();
    }
    this.updateVisuals();
    this.updateGizmoProxy();
    this._notifyStatsChanged();

    if (this._suppressUndo) return;

    if (this.sceneManager && oldGeom) {
      const newGeom = cloneGeometrySnapshot(this.targetMesh.geometry);
      const newSnap = this._captureTopologySnapshot();
      const editCmd = new MeshEditCommand(
        this.targetMesh,
        oldGeom,
        newGeom,
        description,
        (mesh) => {
          if (!mesh || !this.isActive) return;
          this._buildTopology(mesh);
          this.updateVisuals();
          this.updateGizmoProxy();
          this._notifyStatsChanged();
        },
        {
          skipFirstUpdate: true,
          oldSnapshot: oldSnap,
          newSnapshot: newSnap,
          onRestoreSnapshot: (snap) => this._restoreTopologySnapshot(snap)
        }
      );
      try {
        this.sceneManager.executeCommand(editCmd);
      } catch (err) {
        try { editCmd.undo(); } catch (_) {}
        throw err;
      }
    }
  }

  _updateTopUndoCommand() {
    if (!this.sceneManager || !this.targetMesh || !Array.isArray(this.sceneManager.undoStack)) return false;
    const top = this.sceneManager.undoStack[this.sceneManager.undoStack.length - 1];
    if (top instanceof MeshEditCommand && top.mesh === this.targetMesh) {
      top.updateNewState(this.targetMesh.geometry, this._captureTopologySnapshot());
      return true;
    }
    return false;
  }

  /**
   * Returns the UV of corner `k` of a face (per-loop UV), falling back to the
   * welded vertex UV when the face carries no loop UV for that corner.
   * @param {Object} face
   * @param {number} k
   * @returns {THREE.Vector2|null}
   */
  _cornerUV(face, k) {
    if (!face) return null;
    const uv = face.uvs && face.uvs[k];
    if (uv) return uv;
    const vi = face.verts ? face.verts[k] : undefined;
    return (vi !== undefined && this.vertexUVs[vi]) ? this.vertexUVs[vi] : null;
  }

  /**
   * Returns the loop UV of `face` at the corner that references `vertIdx`.
   * @param {Object} face
   * @param {number} vertIdx
   * @returns {THREE.Vector2|null}
   */
  _cornerUVForVertex(face, vertIdx) {
    if (!face?.verts) return null;
    const k = face.verts.indexOf(vertIdx);
    return k >= 0 ? this._cornerUV(face, k) : null;
  }

  /**
   * Averages a list of UVs, ignoring null entries.
   * @param {Array<THREE.Vector2|null>} uvs
   * @returns {THREE.Vector2|null}
   */
  _averageUVs(uvs) {
    const acc = new THREE.Vector2();
    let count = 0;
    for (const uv of uvs) {
      if (!uv) continue;
      acc.x += uv.x;
      acc.y += uv.y;
      count++;
    }
    return count > 0 ? acc.multiplyScalar(1 / count) : null;
  }

  /** Average UV of two loop/corner UVs (for midpoints/loop cuts) */
  _avgTwoUV(a, b) {
    if (a && b) return new THREE.Vector2((a.x + b.x) / 2, (a.y + b.y) / 2);
    return a ? a.clone() : (b ? b.clone() : null);
  }

  /** Average UV of two vertices (for midpoint fallbacks) */
  _midUV(u, v) {
    const a = this.vertexUVs[u];
    const b = this.vertexUVs[v];
    if (a && b) return new THREE.Vector2((a.x + b.x) / 2, (a.y + b.y) / 2);
    return a ? a.clone() : (b ? b.clone() : null);
  }

  /** Average UV of a face's corners (for subdivision centres / bevel corners) */
  _faceUV(verts) {
    return this._averageUVs(verts.map(v => this.vertexUVs[v] || null));
  }

  // =========================================================================
  // BUFFERGEOMETRY REBUILD & SYNC
  // =========================================================================

  /**
   * Reconstructs the targetMesh.geometry from current topology (vertices & faces).
   * Output vertices are split per (welded vertex, loop UV) so UV seams are not
   * averaged away — matching Blender's per-loop UV model.
   */
  rebuildGeometry() {
    if (!this.targetMesh) return;

    const oldGeom = this.targetMesh.geometry;

    let hasUV = false;
    for (const f of this.faces) {
      if (f.uvs && f.uvs.some(uv => uv)) { hasUV = true; break; }
    }
    if (!hasUV) {
      for (let i = 0; i < this.vertexUVs.length; i++) {
        if (this.vertexUVs[i]) { hasUV = true; break; }
      }
    }

    const outPositions = [];
    const outUVs = [];
    const outToLogical = [];
    const lookup = new Map();
    const triIndices = [];
    const triangleToFaceMap = [];

    const resolveUV = (f, k) => {
      const uv = this._cornerUV(f, k);
      return uv || this._averageUVs(f.uvs || []) || new THREE.Vector2(0, 0);
    };

    // Fan-triangulate polygon faces; emit (vertex, UV) pairs as unique outputs.
    for (const f of this.faces) {
      const vCount = f.verts.length;
      for (let k = 1; k < vCount - 1; k++) {
        for (const c of [0, k, k + 1]) {
          const logical = f.verts[c];
          const v = this.vertices[logical];
          if (!v) continue;

          let key = `${logical}`;
          let u = 0, vv = 0;
          if (hasUV) {
            const uv = resolveUV(f, c);
            u = uv.x;
            vv = uv.y;
            key = `${logical}|${Math.round(u * 1e4)}|${Math.round(vv * 1e4)}`;
          }

          let outIdx = lookup.get(key);
          if (outIdx === undefined) {
            outIdx = outToLogical.length;
            lookup.set(key, outIdx);
            outPositions.push(v.x, v.y, v.z);
            if (hasUV) outUVs.push(u, vv);
            outToLogical.push(logical);
          }
          triIndices.push(outIdx);
        }
        triangleToFaceMap.push(f.id);
      }
    }

    // Also preserve vertices used only by standalone loose edges
    if (Array.isArray(this.looseEdges) && this.looseEdges.length > 0 && this.faces.length > 0) {
      for (const [u, v] of this.looseEdges) {
        for (const logical of [u, v]) {
          const vPos = this.vertices[logical];
          if (!vPos) continue;
          const k = `${logical}`;
          if (!lookup.has(k) && !outToLogical.includes(logical)) {
            lookup.set(k, outToLogical.length);
            outPositions.push(vPos.x, vPos.y, vPos.z);
            if (hasUV) {
              const uv = this.vertexUVs[logical] || new THREE.Vector2(0, 0);
              outUVs.push(uv.x, uv.y);
            }
            outToLogical.push(logical);
          }
        }
      }
    }

    // Keep loose vertices addressable when the mesh has no faces at all.
    if (outToLogical.length === 0 && this.faces.length === 0) {
      for (let i = 0; i < this.vertices.length; i++) {
        const v = this.vertices[i];
        outPositions.push(v.x, v.y, v.z);
        if (hasUV) {
          const uv = this.vertexUVs[i] || new THREE.Vector2(0, 0);
          outUVs.push(uv.x, uv.y);
        }
        outToLogical.push(i);
      }
    }

    const indexArray = new (outToLogical.length > 65535 ? Uint32Array : Uint16Array)(triIndices.length);
    for (let i = 0; i < triIndices.length; i++) {
      indexArray[i] = triIndices[i];
    }

    const newGeom = new THREE.BufferGeometry();
    newGeom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(outPositions), 3));
    if (hasUV) {
      newGeom.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(outUVs), 2));
    }
    newGeom.setIndex(new THREE.BufferAttribute(indexArray, 1));
    newGeom.computeVertexNormals();
    newGeom.computeBoundingBox();
    newGeom.computeBoundingSphere();

    // Preserve per-mesh metadata but drop stale UV snapshot caches
    const carried = cloneGeometryUserData(oldGeom?.userData);
    delete carried._origUVs;
    this._syncSeamKeysToGeometry(carried);
    if (Array.isArray(this.looseEdges) && this.looseEdges.length > 0) {
      carried._looseEdges = this.looseEdges.map(([u, v]) => {
        const a = this.vertices[u];
        const b = this.vertices[v];
        return (a && b) ? [a.x, a.y, a.z, b.x, b.y, b.z] : null;
      }).filter(Boolean);
    } else {
      delete carried._looseEdges;
    }
    newGeom.userData = carried;

    // Preserve original mesh groups only when they still span the rebuilt index count
    if (oldGeom && Array.isArray(oldGeom.groups) && oldGeom.groups.length > 0) {
      const oldGroupSum = oldGeom.groups.reduce((acc, g) => acc + (g?.count || 0), 0);
      if (oldGroupSum === triIndices.length) {
        newGeom.groups = oldGeom.groups.map((g) => ({ ...g }));
      } else if (Array.isArray(this.targetMesh?.material) && triIndices.length > 0) {
        newGeom.groups = [{ start: 0, count: triIndices.length, materialIndex: oldGeom.groups[0]?.materialIndex || 0 }];
      }
    }

    // Preserve Vertex Colors & Skin attributes across topological Edit Mode rebuilds (spatial nearest lookup)
    const oldPos = oldGeom?.attributes?.position;
    const oldColor = oldGeom?.attributes?.color;
    const oldSkinIdx = oldGeom?.attributes?.skinIndex;
    const oldSkinW = oldGeom?.attributes?.skinWeight;
    if (oldPos && outToLogical.length > 0 && (oldColor || (this.targetMesh?.isSkinnedMesh && oldSkinIdx && oldSkinW))) {
      const newCount = outToLogical.length;
      const oldCount = oldPos.count;
      const nearestOld = new Int32Array(newCount);
      const bucket = new Map();
      const q = (x, y, z) => `${Math.round(x * 1e4)}_${Math.round(y * 1e4)}_${Math.round(z * 1e4)}`;
      for (let oi = 0; oi < oldCount; oi++) {
        const k = q(oldPos.getX(oi), oldPos.getY(oi), oldPos.getZ(oi));
        if (!bucket.has(k)) bucket.set(k, oi);
      }
      for (let ni = 0; ni < newCount; ni++) {
        const nx = outPositions[ni * 3], ny = outPositions[ni * 3 + 1], nz = outPositions[ni * 3 + 2];
        const exact = bucket.get(q(nx, ny, nz));
        if (exact !== undefined) {
          nearestOld[ni] = exact;
        } else {
          let bestIdx = 0;
          let bestD2 = Infinity;
          for (let oi = 0; oi < oldCount; oi++) {
            const dx = oldPos.getX(oi) - nx;
            const dy = oldPos.getY(oi) - ny;
            const dz = oldPos.getZ(oi) - nz;
            const d2 = dx * dx + dy * dy + dz * dz;
            if (d2 < bestD2) {
              bestD2 = d2;
              bestIdx = oi;
            }
          }
          nearestOld[ni] = bestIdx;
        }
      }
      if (oldColor) {
        const nc = new Float32Array(newCount * 3);
        for (let ni = 0; ni < newCount; ni++) {
          const oi = nearestOld[ni];
          nc[ni * 3] = oldColor.getX(oi);
          nc[ni * 3 + 1] = oldColor.getY(oi);
          nc[ni * 3 + 2] = oldColor.getZ(oi);
        }
        newGeom.setAttribute('color', new THREE.BufferAttribute(nc, 3));
      }
      if (this.targetMesh?.isSkinnedMesh && oldSkinIdx && oldSkinW) {
        const si = new Uint16Array(newCount * 4);
        const sw = new Float32Array(newCount * 4);
        for (let ni = 0; ni < newCount; ni++) {
          const oi = nearestOld[ni];
          for (let s = 0; s < 4; s++) {
            si[ni * 4 + s] = oldSkinIdx.getComponent(oi, s);
            sw[ni * 4 + s] = oldSkinW.getComponent(oi, s);
          }
        }
        newGeom.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(si, 4));
        newGeom.setAttribute('skinWeight', new THREE.Float32BufferAttribute(sw, 4));
      }
    }

    this.targetMesh.geometry.dispose();
    this.targetMesh.geometry = newGeom;

    this._outToLogical = outToLogical;
    this.triangleToFaceMap = triangleToFaceMap;

    this._notifyStatsChanged();
  }

  /**
   * Fast position-only buffer sync without reallocating index
   */
  _syncBufferPositions() {
    if (!this.targetMesh || !this.targetMesh.geometry) return;
    const geom = this.targetMesh.geometry;
    const pos = geom.attributes.position;
    const map = this._outToLogical;
    if (!pos || !map || pos.count !== map.length) {
      this.rebuildGeometry();
      return;
    }

    const arr = pos.array;
    for (let i = 0; i < map.length; i++) {
      const v = this.vertices[map[i]];
      if (!v) continue;
      arr[i * 3 + 0] = v.x;
      arr[i * 3 + 1] = v.y;
      arr[i * 3 + 2] = v.z;
    }
    pos.needsUpdate = true;
    this._syncSeamKeysToGeometry();
    // Kéo đỉnh bằng Gizmo: topology không đổi -> chỉ refit BVH (rẻ hơn build lại)
    refitBVH(this.targetMesh);
  }

  // =========================================================================
  // SELECTION & QUERY HELPERS
  // =========================================================================

  /**
   * Returns all vertex indices affected by current selection
   * @returns {number[]}
   */
  getActiveVertexIndices() {
    if (this.selectionMode === 'vertex') {
      return Array.from(this.selectedVertices);
    }
    if (this.selectionMode === 'edge') {
      const set = new Set();
      for (const eIdx of this.selectedEdges) {
        const edge = this.edges[eIdx];
        if (edge) {
          set.add(edge.v0);
          set.add(edge.v1);
        }
      }
      return Array.from(set);
    }
    if (this.selectionMode === 'face') {
      const set = new Set();
      for (const fIdx of this.selectedFaces) {
        const f = this.faces[fIdx];
        if (f && f.verts) {
          for (const v of f.verts) set.add(v);
        }
      }
      return Array.from(set);
    }
    return [];
  }

  selectAll() {
    if (this.selectionMode === 'vertex') {
      for (let i = 0; i < this.vertices.length; i++) this.selectedVertices.add(i);
    } else if (this.selectionMode === 'edge') {
      for (let i = 0; i < this.edges.length; i++) this.selectedEdges.add(i);
    } else if (this.selectionMode === 'face') {
      for (let i = 0; i < this.faces.length; i++) this.selectedFaces.add(i);
    }
    this.updateVisuals();
    this.updateGizmoProxy();
  }

  deselectAll() {
    this.selectedVertices.clear();
    this.selectedEdges.clear();
    this.selectedFaces.clear();
    this.updateVisuals();
    this.updateGizmoProxy();
  }

  toggleSelectAll() {
    const hasSelection =
      (this.selectionMode === 'vertex' && this.selectedVertices.size > 0) ||
      (this.selectionMode === 'edge' && this.selectedEdges.size > 0) ||
      (this.selectionMode === 'face' && this.selectedFaces.size > 0);

    if (hasSelection) {
      this.deselectAll();
    } else {
      this.selectAll();
    }
  }

  // =========================================================================
  // 3D RAYCAST PICKING
  // =========================================================================

  /**
   * Handles raycast picking from pointer events
   * @param {PointerEvent|MouseEvent} event
   */
  handleRaycast(event) {
    if (!this.isActive || !this.targetMesh) return;

    const vpCtx = this.engine.getViewportContextAtPoint
      ? this.engine.getViewportContextAtPoint(event.clientX, event.clientY)
      : {
          rect: this.engine.getViewportRect ? this.engine.getViewportRect() : this.engine.domElement.getBoundingClientRect(),
          camera: this.engine.camera
        };
    const rect = vpCtx.rect;
    const camera = vpCtx.camera || this.engine.camera;
    this.pointer.x = ((event.clientX - rect.left) / (rect.width || 1)) * 2 - 1;
    this.pointer.y = -((event.clientY - rect.top) / (rect.height || 1)) * 2 + 1;

    this.raycaster.setFromCamera(this.pointer, camera);

    const isMultiSelect = event.shiftKey;
    const meshMatrix = this.targetMesh.matrixWorld;
    const camPos = camera.position;
    const orthographicThreshold = camera.isOrthographicCamera
      ? (camera.top - camera.bottom) / camera.zoom * 16 / (rect.height || 1) : null;

    // bufferIdx -> welded index (avoid raw buffer index vs logical vertex mismatch)
    const weldedOf = (bufferIdx) => {
      if (this._outToLogical && bufferIdx >= 0 && bufferIdx < this._outToLogical.length) {
        const w = this._outToLogical[bufferIdx];
        if (w >= 0) return w;
      }
      return bufferIdx;
    };

    // BVH: for dense meshes (> 2048 welded vertices), pre-filter to vertices/edges of
    // triangles near the click ray. For smaller meshes, scanning all elements directly
    // ensures foreground corner/silhouette vertices are never shadowed by adjacent faces.
    let candidateVerts = null; // Set<weldedIndex> | null
    if (this.selectionMode !== 'face' && this.vertices.length > 2048) {
      const bvh = ensureBVH(this.targetMesh);
      if (bvh) {
        const invMatrix = new THREE.Matrix4().copy(meshMatrix).invert();
        const localRay = this.raycaster.ray.clone().applyMatrix4(invMatrix);
        const hits = bvh.raycast(localRay, THREE.DoubleSide, 0, Infinity);
        if (hits.length > 0) {
          hits.sort((a, b) => a.distance - b.distance);
          candidateVerts = new Set();
          const idxAttr = this.targetMesh.geometry.index;
          const posCount = this.targetMesh.geometry.attributes.position.count;
          const limit = Math.min(hits.length, 64);
          for (let h = 0; h < limit; h++) {
            const tri = hits[h].faceIndex;
            if (tri === undefined || tri < 0) continue;
            for (let k = 0; k < 3; k++) {
              const bufferIdx = idxAttr ? idxAttr.getX(tri * 3 + k) : tri * 3 + k;
              if (bufferIdx < posCount) {
                const wIdx = weldedOf(bufferIdx);
                if (wIdx >= 0 && wIdx < this.vertices.length) {
                  candidateVerts.add(wIdx);
                }
              }
            }
          }
          if (candidateVerts.size === 0) candidateVerts = null;
        }
      }
    }

    if (this.selectionMode === 'vertex') {
      let closestIdx = -1;
      let closestCamDist = Infinity;
      const vWorld = new THREE.Vector3();

      const scanVertices = (filterSet) => {
        const count = this.vertices.length;
        for (let i = 0; i < count; i++) {
          if (filterSet && !filterSet.has(i)) continue;
          vWorld.copy(this.vertices[i]).applyMatrix4(meshMatrix);
          const distToRay = this.raycaster.ray.distanceToPoint(vWorld);
          const distToCam = camPos.distanceTo(vWorld);
          const threshold = orthographicThreshold ?? Math.max(0.08, distToCam * 0.025);
          if (distToRay < threshold && distToCam < closestCamDist) {
            closestCamDist = distToCam;
            closestIdx = i;
          }
        }
      };

      scanVertices(candidateVerts);
      if (candidateVerts && closestIdx === -1 && this.vertices.length <= 8192) {
        scanVertices(null);
      }

      if (closestIdx !== -1) {
        if (isMultiSelect) {
          if (this.selectedVertices.has(closestIdx)) {
            this.selectedVertices.delete(closestIdx);
          } else {
            this.selectedVertices.add(closestIdx);
          }
        } else {
          this.selectedVertices.clear();
          this.selectedVertices.add(closestIdx);
        }
      } else if (!isMultiSelect) {
        this.selectedVertices.clear();
      }
    } else if (this.selectionMode === 'edge') {
      let closestEdgeIdx = -1;
      let closestCamDist = Infinity;
      const p0 = new THREE.Vector3();
      const p1 = new THREE.Vector3();
      const mid = new THREE.Vector3();

      const scanEdges = (filterSet) => {
        for (let i = 0; i < this.edges.length; i++) {
          const edge = this.edges[i];
          if (filterSet && !filterSet.has(edge.v0) && !filterSet.has(edge.v1)) continue;
          p0.copy(this.vertices[edge.v0]).applyMatrix4(meshMatrix);
          p1.copy(this.vertices[edge.v1]).applyMatrix4(meshMatrix);
          mid.addVectors(p0, p1).multiplyScalar(0.5);

          const distSq = this.raycaster.ray.distanceSqToSegment(p0, p1);
          const distToCam = camPos.distanceTo(mid);
          const threshold = orthographicThreshold ?? Math.max(0.08, distToCam * 0.025);

          if (distSq < threshold * threshold && distToCam < closestCamDist) {
            closestCamDist = distToCam;
            closestEdgeIdx = i;
          }
        }
      };

      scanEdges(candidateVerts);
      if (candidateVerts && closestEdgeIdx === -1 && this.edges.length <= 16384) {
        scanEdges(null);
      }

      if (closestEdgeIdx !== -1) {
        if (event.altKey) {
          if (event.ctrlKey) {
            // Blender Ctrl+Alt+Click: Select Edge Ring (opposite edges across quads)
            this.selectRing(closestEdgeIdx, isMultiSelect);
          } else {
            // Blender Alt+Click: Select Edge Loop (fallback to quad loop/ring if non-manifold)
            this.selectEdgeLoop(closestEdgeIdx, isMultiSelect);
          }
          return;
        }
        if (isMultiSelect) {
          if (this.selectedEdges.has(closestEdgeIdx)) {
            this.selectedEdges.delete(closestEdgeIdx);
          } else {
            this.selectedEdges.add(closestEdgeIdx);
          }
        } else {
          this.selectedEdges.clear();
          this.selectedEdges.add(closestEdgeIdx);
        }
      } else if (!isMultiSelect) {
        this.selectedEdges.clear();
      }
    } else if (this.selectionMode === 'face') {
      const hits = raycastMeshAccelerated(this.targetMesh, this.raycaster);
      if (hits.length > 0) {
        const hit = hits[0];
        const triIdx = hit.faceIndex;
        const faceIndex = (triIdx !== undefined && this.triangleToFaceMap && this.triangleToFaceMap[triIdx] !== undefined)
          ? this.triangleToFaceMap[triIdx]
          : triIdx;

        if (faceIndex !== undefined && faceIndex >= 0 && faceIndex < this.faces.length) {
          if (isMultiSelect) {
            if (this.selectedFaces.has(faceIndex)) {
              this.selectedFaces.delete(faceIndex);
            } else {
              this.selectedFaces.add(faceIndex);
            }
          } else {
            this.selectedFaces.clear();
            this.selectedFaces.add(faceIndex);
          }
        }
      } else if (!isMultiSelect) {
        this.selectedFaces.clear();
      }
    }

    this.updateVisuals();
    this.updateGizmoProxy();
  }

  // =========================================================================
  // VISUAL HELPERS & OVERLAYS
  // =========================================================================

  _updateHelperTransform() {
    if (!this.targetMesh) return;
    this.targetMesh.updateMatrixWorld(true);
    this.helperGroup.matrix.copy(this.targetMesh.matrixWorld);
  }

  _disposeVisualHelpers() {
    if (this.vertexPoints) {
      this.helperGroup.remove(this.vertexPoints);
      this.vertexPoints.geometry.dispose();
      this.vertexPoints.material.dispose();
      this.vertexPoints = null;
    }
    if (this.edgeLines) {
      this.helperGroup.remove(this.edgeLines);
      this.edgeLines.geometry.dispose();
      this.edgeLines.material.dispose();
      this.edgeLines = null;
    }
    if (this.faceHighlight) {
      this.helperGroup.remove(this.faceHighlight);
      this.faceHighlight.geometry.dispose();
      this.faceHighlight.material.dispose();
      this.faceHighlight = null;
    }
  }

  updateVisuals() {
    if (!this.isActive || !this.targetMesh) return;
    this._updateHelperTransform();

    // 1. Vertex Points Overlay
    this._updateVertexMarkers();

    // 2. Edge Wireframe Overlay
    this._updateEdgeLines();

    // 3. Face Glow Highlight Overlay
    this._updateFaceHighlights();
  }

  _updateVertexMarkers() {
    const vertCount = this.vertices.length;
    if (vertCount === 0) {
      if (this.vertexPoints) this.vertexPoints.visible = false;
      return;
    }

    // High-poly viewport optimization (Blender standard):
    // For meshes with > 8,000 vertices, hide unselected vertex dots when in Edge/Face mode
    // to maintain 60 FPS and avoid viewport fill-rate lag.
    if (vertCount > 8000 && this.selectionMode !== 'vertex' && this.selectedVertices.size === 0) {
      if (this.vertexPoints) this.vertexPoints.visible = false;
      return;
    }

    let pointsGeom;
    if (!this.vertexPoints) {
      pointsGeom = new THREE.BufferGeometry();
      const pointsMat = new THREE.PointsMaterial({
        size: this.selectionMode === 'vertex' ? 9 : 5,
        map: this.vertexMarkerTexture,
        vertexColors: true,
        transparent: true,
        alphaTest: 0.1,
        depthTest: true,
        depthWrite: false,
        sizeAttenuation: false
      });
      this.vertexPoints = new THREE.Points(pointsGeom, pointsMat);
      this.vertexPoints.userData.isSystemObject = true;
      this.vertexPoints.userData.selectable = false;
      this.helperGroup.add(this.vertexPoints);
    } else {
      this.vertexPoints.visible = true;
      pointsGeom = this.vertexPoints.geometry;
      this.vertexPoints.material.size = this.selectionMode === 'vertex' ? (vertCount > 8000 ? 5 : 9) : 4;
    }

    const posAttr = pointsGeom.getAttribute('position');
    const colorAttr = pointsGeom.getAttribute('color');
    const canReuse = posAttr && colorAttr && posAttr.count === vertCount;

    const posArray = canReuse ? posAttr.array : new Float32Array(vertCount * 3);
    const colorArray = canReuse ? colorAttr.array : new Float32Array(vertCount * 3);

    const activeVerts = new Set(this.getActiveVertexIndices());

    for (let i = 0; i < vertCount; i++) {
      const v = this.vertices[i];
      posArray[i * 3 + 0] = v.x;
      posArray[i * 3 + 1] = v.y;
      posArray[i * 3 + 2] = v.z;

      if (activeVerts.has(i)) {
        // Blender Active Orange: #ff8c00 / rgb(255, 140, 0)
        colorArray[i * 3 + 0] = 1.0;
        colorArray[i * 3 + 1] = 0.55;
        colorArray[i * 3 + 2] = 0.0;
      } else {
        // Unselected off-white: #e0e0e0
        colorArray[i * 3 + 0] = 0.88;
        colorArray[i * 3 + 1] = 0.88;
        colorArray[i * 3 + 2] = 0.88;
      }
    }

    if (!canReuse) {
      pointsGeom.setAttribute('position', new THREE.BufferAttribute(posArray, 3));
      pointsGeom.setAttribute('color', new THREE.BufferAttribute(colorArray, 3));
    }
    pointsGeom.attributes.position.needsUpdate = true;
    pointsGeom.attributes.color.needsUpdate = true;
  }

  _updateEdgeLines() {
    const edgeCount = this.edges.length;
    if (edgeCount === 0) {
      if (this.edgeLines) this.edgeLines.visible = false;
      return;
    }

    let lineGeom;
    if (!this.edgeLines) {
      lineGeom = new THREE.BufferGeometry();
      const lineMat = new THREE.LineBasicMaterial({
        vertexColors: true,
        depthTest: true,
        transparent: true,
        opacity: 0.9,
        polygonOffset: true,
        polygonOffsetFactor: -1,
        polygonOffsetUnits: -1
      });
      this.edgeLines = new THREE.LineSegments(lineGeom, lineMat);
      this.edgeLines.userData.isSystemObject = true;
      this.edgeLines.userData.selectable = false;
      this.helperGroup.add(this.edgeLines);
    } else {
      this.edgeLines.visible = true;
      lineGeom = this.edgeLines.geometry;
    }

    const posAttr = lineGeom.getAttribute('position');
    const colorAttr = lineGeom.getAttribute('color');
    const canReuse = posAttr && colorAttr && posAttr.count === edgeCount * 2;

    const posArray = canReuse ? posAttr.array : new Float32Array(edgeCount * 2 * 3);
    const colorArray = canReuse ? colorAttr.array : new Float32Array(edgeCount * 2 * 3);

    for (let i = 0; i < edgeCount; i++) {
      const edge = this.edges[i];
      const v0 = this.vertices[edge.v0];
      const v1 = this.vertices[edge.v1];

      const isSelected =
        (this.selectionMode === 'edge' && this.selectedEdges.has(i)) ||
        (this.selectionMode === 'vertex' && this.selectedVertices.has(edge.v0) && this.selectedVertices.has(edge.v1)) ||
        (this.selectionMode === 'face' && edge.faces.some(f => this.selectedFaces.has(f)));
      const isSeam = Boolean(edge.isSeam);

      const r = isSeam ? (isSelected ? 1.0 : 0.92) : (isSelected ? 1.0 : 0.22);
      const g = isSeam ? (isSelected ? 0.42 : 0.18) : (isSelected ? 0.6 : 0.24);
      const b = isSeam ? (isSelected ? 0.16 : 0.14) : (isSelected ? 0.1 : 0.28);

      const pOffset = i * 6;
      posArray[pOffset + 0] = v0.x;
      posArray[pOffset + 1] = v0.y;
      posArray[pOffset + 2] = v0.z;
      posArray[pOffset + 3] = v1.x;
      posArray[pOffset + 4] = v1.y;
      posArray[pOffset + 5] = v1.z;

      colorArray[pOffset + 0] = r;
      colorArray[pOffset + 1] = g;
      colorArray[pOffset + 2] = b;
      colorArray[pOffset + 3] = r;
      colorArray[pOffset + 4] = g;
      colorArray[pOffset + 5] = b;
    }

    if (!canReuse) {
      lineGeom.setAttribute('position', new THREE.BufferAttribute(posArray, 3));
      lineGeom.setAttribute('color', new THREE.BufferAttribute(colorArray, 3));
    }
    lineGeom.attributes.position.needsUpdate = true;
    lineGeom.attributes.color.needsUpdate = true;
  }

  _updateFaceHighlights() {
    if (this.selectedFaces.size === 0) {
      if (this.faceHighlight) this.faceHighlight.visible = false;
      return;
    }

    let faceGeom;
    if (!this.faceHighlight) {
      faceGeom = new THREE.BufferGeometry();
      const faceMat = new THREE.MeshBasicMaterial({
        color: 0xff8800,
        transparent: true,
        opacity: 0.38,
        side: THREE.DoubleSide,
        depthTest: true,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -2
      });
      this.faceHighlight = new THREE.Mesh(faceGeom, faceMat);
      this.faceHighlight.userData.isSystemObject = true;
      this.faceHighlight.userData.selectable = false;
      this.helperGroup.add(this.faceHighlight);
    } else {
      faceGeom = this.faceHighlight.geometry;
      this.faceHighlight.visible = true;
    }

    const triPositions = [];
    for (const fIdx of this.selectedFaces) {
      const f = this.faces[fIdx];
      if (!f || !f.verts) continue;
      const vs = f.verts;
      const count = vs.length;
      for (let k = 1; k < count - 1; k++) {
        const v0 = this.vertices[vs[0]];
        const v1 = this.vertices[vs[k]];
        const v2 = this.vertices[vs[k + 1]];
        if (v0 && v1 && v2) {
          triPositions.push(v0.x, v0.y, v0.z, v1.x, v1.y, v1.z, v2.x, v2.y, v2.z);
        }
      }
    }

    faceGeom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(triPositions), 3));
    faceGeom.attributes.position.needsUpdate = true;
    faceGeom.computeVertexNormals();
  }

  _updateVisualMarkersPositionOnly() {
    if (this.vertexPoints && this.vertexPoints.geometry) {
      const pos = this.vertexPoints.geometry.attributes.position;
      const arr = pos.array;
      for (let i = 0; i < this.vertices.length; i++) {
        arr[i * 3 + 0] = this.vertices[i].x;
        arr[i * 3 + 1] = this.vertices[i].y;
        arr[i * 3 + 2] = this.vertices[i].z;
      }
      pos.needsUpdate = true;
    }
    if (this.edgeLines && this.edgeLines.geometry) {
      const pos = this.edgeLines.geometry.attributes.position;
      const arr = pos.array;
      for (let i = 0; i < this.edges.length; i++) {
        const edge = this.edges[i];
        const v0 = this.vertices[edge.v0];
        const v1 = this.vertices[edge.v1];
        const pOffset = i * 6;
        arr[pOffset + 0] = v0.x;
        arr[pOffset + 1] = v0.y;
        arr[pOffset + 2] = v0.z;
        arr[pOffset + 3] = v1.x;
        arr[pOffset + 4] = v1.y;
        arr[pOffset + 5] = v1.z;
      }
      pos.needsUpdate = true;
    }
    if (this.faceHighlight && this.faceHighlight.visible) {
      this._updateFaceHighlights();
    }
  }

  // =========================================================================
  // GIZMO PROXY & CENTROID MANAGEMENT
  // =========================================================================

  updateGizmoProxy() {
    if (!this.isActive || !this.targetMesh || !this.engine.transformControls) return;

    const activeIndices = this.getActiveVertexIndices();
    if (activeIndices.length === 0) {
      this.engine.transformControls.detach();
      return;
    }

    const meshMatrix = this.targetMesh.matrixWorld;
    const centroidWorld = new THREE.Vector3();
    const vWorld = new THREE.Vector3();

    for (const idx of activeIndices) {
      if (this.vertices[idx]) {
        vWorld.copy(this.vertices[idx]).applyMatrix4(meshMatrix);
        centroidWorld.add(vWorld);
      }
    }
    centroidWorld.divideScalar(activeIndices.length);

    this.gizmoProxy.position.copy(centroidWorld);
    this.gizmoProxy.rotation.set(0, 0, 0);
    this.gizmoProxy.scale.set(1, 1, 1);
    this.gizmoProxy.updateMatrixWorld(true);

    if (this.engine.transformControls.object !== this.gizmoProxy) {
      this.engine.transformControls.attach(this.gizmoProxy);
    }
  }

  // =========================================================================
  // MODELING OPERATIONS (EXTRUDE, INSET, SUBDIVIDE, BEVEL, DELETE, LOOPCUT, MERGE)
  // =========================================================================

  /**
   * Translates selected elements directly in local mesh coordinates
   * Supporting proportional editing falloff (Blender phím O & G)
   * @param {THREE.Vector3|number[]} delta
   */
  translateSelection(delta) {
    if (!this.isActive || !this.targetMesh) return;
    const dVec = Array.isArray(delta) ? new THREE.Vector3(...delta) : delta;

    const selVerts = this.selectedVertices.size > 0
      ? Array.from(this.selectedVertices)
      : Array.from(this.selectedFaces).flatMap(fIdx => this.faces[fIdx]?.verts || []);
    if (selVerts.length === 0) return;

    const centroid = new THREE.Vector3();
    selVerts.forEach(idx => centroid.add(this.vertices[idx]));
    centroid.multiplyScalar(1 / selVerts.length);

    const selSet = new Set(selVerts);

    if (this.proportional) {
      const radius = this.proportionalRadius || 2.0;
      for (let i = 0; i < this.vertices.length; i++) {
        if (selSet.has(i)) {
          this.vertices[i].add(dVec);
        } else {
          const dist = this.vertices[i].distanceTo(centroid);
          if (dist < radius) {
            const t = dist / radius;
            const factor = 0.5 * (1 + Math.cos(Math.PI * t));
            this.vertices[i].addScaledVector(dVec, factor);
          }
        }
      }
    } else {
      selVerts.forEach(idx => this.vertices[idx].add(dVec));
    }

    this.rebuildGeometry();
    this.updateVisuals();
    this.updateGizmoProxy();
  }

  /**
   * Interactive Extrude: duplicates faces/vertices and starts Modal Transform (Grab along normal)
   */
  extrudeInteractive() {
    if (!this.isActive || !this.targetMesh) return;
    const hasSel =
      (this.selectionMode === 'face' && this.selectedFaces.size > 0) ||
      (this.selectionMode === 'edge' && this.selectedEdges.size > 0) ||
      (this.selectionMode === 'vertex' && this.selectedVertices.size > 0);
    if (!hasSel) return;

    // Determine coherent normal lock before extruding so Blender 'E' immediately
    // locks movement along the extruded region's normal (X/Y/Z still overrides).
    let lockAxisDir = null;
    const rawNormal = new THREE.Vector3();
    if (this.selectionMode === 'face' && this.selectedFaces.size > 0) {
      let count = 0;
      for (const fIdx of this.selectedFaces) {
        const f = this.faces[fIdx];
        if (f?.normal) { rawNormal.add(f.normal); count++; }
      }
      if (count > 0 && rawNormal.length() / count >= 0.35) {
        lockAxisDir = rawNormal.normalize().transformDirection(this.targetMesh.matrixWorld).normalize();
      }
    } else if (this.selectionMode === 'edge' && this.selectedEdges.size > 0) {
      let count = 0;
      for (const eIdx of this.selectedEdges) {
        const e = this.edges[eIdx];
        if (!e) continue;
        for (const fId of e.faces) {
          if (this.faces[fId]?.normal) { rawNormal.add(this.faces[fId].normal); count++; }
        }
      }
      if (count > 0 && rawNormal.length() / count >= 0.35) {
        lockAxisDir = rawNormal.normalize().transformDirection(this.targetMesh.matrixWorld).normalize();
      }
    } else if (this.selectionMode === 'vertex' && this.selectedVertices.size > 0) {
      let count = 0;
      for (const vIdx of this.selectedVertices) {
        const vn = new THREE.Vector3();
        for (const f of this.faces) {
          if (f.verts.includes(vIdx)) vn.add(f.normal);
        }
        if (vn.lengthSq() > 1e-6) { rawNormal.add(vn.normalize()); count++; }
      }
      if (count > 0 && rawNormal.length() / count >= 0.35) {
        lockAxisDir = rawNormal.normalize().transformDirection(this.targetMesh.matrixWorld).normalize();
      }
    }

    // Extrude with near-zero initial offset, then engage modal Grab immediately
    this.extrude(0.001);
    if (typeof window !== 'undefined' && window.modalTransformManager) {
      if (lockAxisDir) {
        window.modalTransformManager.start('translate', {
          axisLock: 'CUSTOM',
          customAxisDir: lockAxisDir,
          isLocalAxis: true
        });
      } else {
        window.modalTransformManager.start('translate');
      }
    }
  }

  /**
   * Extrude selected elements along face normals
   * @param {number} [distance=0.5]
   */
  extrude(distance = 0.5) {
    if (!this.isActive || !this.targetMesh) return;

    const oldGeom = this.targetMesh.geometry.clone();
    const oldSnap = this._captureTopologySnapshot();

    // 1. Face Extrusion
    if (this.selectionMode === 'face' && this.selectedFaces.size > 0) {
      const selFaces = Array.from(this.selectedFaces).map(idx => this.faces[idx]).filter(Boolean);
      if (selFaces.length === 0) return;

      // Calculate average normal & coherence (low coherence = ring/band around sphere/cylinder)
      const rawSum = new THREE.Vector3();
      for (const f of selFaces) {
        rawSum.add(f.normal);
      }
      const coherence = rawSum.length() / Math.max(1, selFaces.length);
      const useVertexNormals = coherence < 0.35;
      const avgNormal = rawSum.clone().normalize();
      if (avgNormal.lengthSq() < 0.001) avgNormal.set(0, 1, 0);

      // Unique vertex map for selected faces + local outward direction when radial/ring
      const vertSet = new Set();
      const vertexNormalMap = new Map();
      for (const f of selFaces) {
        for (const v of f.verts) {
          vertSet.add(v);
          if (useVertexNormals) {
            if (!vertexNormalMap.has(v)) vertexNormalMap.set(v, new THREE.Vector3());
            vertexNormalMap.get(v).add(f.normal);
          }
        }
      }

      // Map original vertex -> new extruded vertex index
      const extrudeData = new Map();
      const newVertMap = new Map();
      for (const vIdx of vertSet) {
        const origV = this.vertices[vIdx];
        let dir = avgNormal.clone();
        if (useVertexNormals) {
          const vn = vertexNormalMap.get(vIdx);
          dir = vn && vn.lengthSq() > 1e-6 ? vn.clone().normalize() : origV.clone().normalize();
          if (dir.lengthSq() < 1e-6) dir.set(0, 1, 0);
        }
        const extrudedV = origV.clone().addScaledVector(dir, distance);
        const newIdx = this.vertices.length;
        this.vertices.push(extrudedV);
        this.vertexUVs.push(this.vertexUVs[vIdx] ? this.vertexUVs[vIdx].clone() : null);
        newVertMap.set(vIdx, newIdx);
        extrudeData.set(newIdx, { base: origV.clone(), dir: dir.clone() });
      }
      this._lastExtrudeData = extrudeData;

      // Find boundary directed edges among selected faces
      // A directed edge (u, v) is on the boundary if its reverse (v, u) is NOT in any selected face
      const directedEdgeCount = new Map();
      for (const f of selFaces) {
        const count = f.verts.length;
        for (let k = 0; k < count; k++) {
          const u = f.verts[k];
          const v = f.verts[(k + 1) % count];
          directedEdgeCount.set(`${u}_${v}`, { u, v, faceId: f.id });
        }
      }

      const boundaryEdges = [];
      for (const [, edgeData] of directedEdgeCount.entries()) {
        const reverseKey = `${edgeData.v}_${edgeData.u}`;
        if (!directedEdgeCount.has(reverseKey)) {
          boundaryEdges.push(edgeData);
        }
      }

      // Create side quad walls for each boundary edge
      for (const bEdge of boundaryEdges) {
        const u = bEdge.u;
        const v = bEdge.v;
        const uPrime = newVertMap.get(u);
        const vPrime = newVertMap.get(v);

        const v0 = this.vertices[u];
        const v1 = this.vertices[v];
        const v2 = this.vertices[vPrime];
        const sideNorm = new THREE.Vector3()
          .subVectors(v1, v0)
          .cross(new THREE.Vector3().subVectors(v2, v0))
          .normalize();

        const sideCentroid = new THREE.Vector3()
          .add(this.vertices[u]).add(this.vertices[v])
          .add(this.vertices[vPrime]).add(this.vertices[uPrime])
          .multiplyScalar(0.25);

        // Extend the source face's UV island outward along the extrusion so
        // the new side wall is not a zero-area UV strip.
        const srcFace = this.faces[bEdge.faceId];
        const uvU = (srcFace ? this._cornerUVForVertex(srcFace, u) : null) || this.vertexUVs[u] || null;
        const uvV = (srcFace ? this._cornerUVForVertex(srcFace, v) : null) || this.vertexUVs[v] || null;
        let sideUVs = null;
        if (uvU && uvV) {
          const dUV = new THREE.Vector2().subVectors(uvV, uvU);
          const uvLen = dUV.length();
          const edgeLen = this.vertices[u].distanceTo(this.vertices[v]) || 1;
          if (uvLen > 1e-6) {
            const dir = dUV.clone().multiplyScalar(1 / uvLen);
            const outPerp = new THREE.Vector2(-dir.y, dir.x);
            const midUV = new THREE.Vector2().addVectors(uvU, uvV).multiplyScalar(0.5);
            const faceUV = srcFace ? this._averageUVs(srcFace.uvs || []) : null;
            if (faceUV && outPerp.dot(new THREE.Vector2().subVectors(faceUV, midUV)) > 0) {
              outPerp.negate();
            }
            const ext = distance * (uvLen / edgeLen);
            sideUVs = [
              uvU.clone(),
              uvV.clone(),
              uvV.clone().addScaledVector(outPerp, ext),
              uvU.clone().addScaledVector(outPerp, ext)
            ];
          } else {
            sideUVs = [uvU.clone(), uvV.clone(), uvV.clone(), uvU.clone()];
          }
        }

        this.faces.push({
          id: this.faces.length,
          verts: [u, v, vPrime, uPrime],
          a: u,
          b: v,
          c: vPrime,
          d: uPrime,
          normal: sideNorm,
          centroid: sideCentroid,
          uvs: sideUVs
        });
      }

      // Update selected faces to point to the new extruded vertices
      for (const f of selFaces) {
        f.verts = f.verts.map(v => newVertMap.get(v));
        f.a = f.verts[0];
        f.b = f.verts[1];
        f.c = f.verts[2];
        f.d = f.verts.length > 3 ? f.verts[3] : null;
      }

      this._commitMeshEdit(oldGeom, 'Extrude Faces', true, oldSnap);
      console.log(`[EditMode] Extruded ${selFaces.length} face(s) by distance ${distance}`);
      return;
    }

    // 2. Edge Extrusion (Blender Edge Mode E -> quad strips along selected edges)
    if (this.selectionMode === 'edge' && this.selectedEdges.size > 0) {
      const selEdges = Array.from(this.selectedEdges).map(id => this.edges[id]).filter(Boolean);
      if (selEdges.length === 0) return;

      // Average normal of adjacent faces (fallback to mesh outward)
      const avgNormal = new THREE.Vector3();
      for (const e of selEdges) {
        for (const fId of e.faces) {
          if (this.faces[fId]) avgNormal.add(this.faces[fId].normal);
        }
      }
      if (avgNormal.lengthSq() < 1e-6) {
        for (const e of selEdges) {
          const mid = new THREE.Vector3().addVectors(this.vertices[e.v0], this.vertices[e.v1]).multiplyScalar(0.5);
          avgNormal.add(mid);
        }
      }
      if (avgNormal.lengthSq() < 1e-6) avgNormal.set(0, 1, 0);
      avgNormal.normalize();

      const extrudeData = new Map();
      const vertMap = new Map();
      const getOrCreateExtruded = (vi) => {
        if (vertMap.has(vi)) return vertMap.get(vi);
        const basePos = this.vertices[vi].clone();
        const newIdx = this.vertices.length;
        this.vertices.push(basePos.clone().addScaledVector(avgNormal, distance));
        this.vertexUVs.push(this.vertexUVs[vi] ? this.vertexUVs[vi].clone() : null);
        vertMap.set(vi, newIdx);
        extrudeData.set(newIdx, { base: basePos, dir: avgNormal.clone() });
        return newIdx;
      };
      this._lastExtrudeData = extrudeData;

      const newEdgePairs = [];
      for (const e of selEdges) {
        let u = e.v0;
        let v = e.v1;
        // Match first adjacent face winding so extruded quad continues outward orientation
        if (e.faces.length > 0 && this.faces[e.faces[0]]) {
          const fVerts = this.faces[e.faces[0]].verts;
          for (let k = 0; k < fVerts.length; k++) {
            const a = fVerts[k];
            const b = fVerts[(k + 1) % fVerts.length];
            if (a === u && b === v) {
              // Opposite winding across shared edge for consistent normal
              const tmp = u; u = v; v = tmp;
              break;
            }
          }
        }
        const eu = getOrCreateExtruded(u);
        const ev = getOrCreateExtruded(v);
        const quad = [u, v, ev, eu];
        this.faces.push(this._createFaceRecord(this.faces.length, quad));
        newEdgePairs.push(`${Math.min(eu, ev)}_${Math.max(eu, ev)}`);
      }

      this._recomputeFaceNormalsAndCentroids();
      this._rebuildEdges();
      this.selectedEdges.clear();
      for (const ek of newEdgePairs) {
        const found = this.edgeMap.get(ek);
        if (found) this.selectedEdges.add(found.id);
      }
      this.rebuildGeometry();
      this._commitMeshEdit(oldGeom, 'Extrude Edges', false, oldSnap);
      console.log(`[EditMode] Extruded ${selEdges.length} edge(s) into quads.`);
      return true;
    }

    // 3. Vertex Extrusion (Blender Vertex Mode E -> connected loose edges)
    if (this.selectionMode === 'vertex' && this.selectedVertices.size > 0) {
      const selVerts = Array.from(this.selectedVertices).filter(i => this.vertices[i]);
      if (selVerts.length === 0) return false;

      const extrudeData = new Map();
      const newVerts = [];
      for (const vi of selVerts) {
        // Compute vertex normal from incident faces
        const vNorm = new THREE.Vector3();
        for (const f of this.faces) {
          if (f.verts.includes(vi)) vNorm.add(f.normal);
        }
        if (vNorm.lengthSq() < 1e-6) vNorm.set(0, 1, 0);
        vNorm.normalize();

        const basePos = this.vertices[vi].clone();
        const newIdx = this.vertices.length;
        this.vertices.push(basePos.clone().addScaledVector(vNorm, distance));
        this.vertexUVs.push(this.vertexUVs[vi] ? this.vertexUVs[vi].clone() : null);
        this.looseEdges.push([Math.min(vi, newIdx), Math.max(vi, newIdx)]);
        newVerts.push(newIdx);
        extrudeData.set(newIdx, { base: basePos, dir: vNorm.clone() });
      }
      this._lastExtrudeData = extrudeData;

      this.selectedVertices.clear();
      for (const nv of newVerts) this.selectedVertices.add(nv);
      this._commitMeshEdit(oldGeom, 'Extrude Vertices', true, oldSnap);
      console.log(`[EditMode] Extruded ${selVerts.length} vertex/vertices.`);
      return true;
    }

    console.warn('[EditMode] Extrude requires a vertex, edge, or face selection.');
    return false;
  }

  /**
   * Inset selected faces towards their centroids
   * @param {number} [offsetRatio=0.25]
   */
  inset(offsetRatio = 0.25) {
    if (!this.isActive || !this.targetMesh) return;
    if (this.selectionMode !== 'face' || this.selectedFaces.size === 0) {
      console.warn('[EditMode] Inset requires at least one face selected in Face Mode (3).');
      return;
    }

    const oldGeom = this.targetMesh.geometry.clone();
    const oldSnap = this._captureTopologySnapshot();
    const ratio = Math.max(0.01, Math.min(0.95, Number(offsetRatio) || 0.25));
    const selFaceIndices = Array.from(this.selectedFaces).filter(idx => this.faces[idx]?.verts);
    if (selFaceIndices.length === 0) return;

    const selSet = new Set(selFaceIndices);

    // Group selected faces into connected components across shared undirected edges
    // so multi-face regions inset cleanly around their outer boundary (no duplicate interior loops).
    const visited = new Set();
    const components = [];
    for (const startId of selFaceIndices) {
      if (visited.has(startId)) continue;
      const comp = [];
      const stack = [startId];
      visited.add(startId);
      while (stack.length > 0) {
        const fid = stack.pop();
        const f = this.faces[fid];
        if (!f) continue;
        comp.push(f);
        for (let k = 0; k < f.verts.length; k++) {
          const u = f.verts[k];
          const v = f.verts[(k + 1) % f.verts.length];
          const e = this.edgeMap.get(`${Math.min(u, v)}_${Math.max(u, v)}`);
          if (!e) continue;
          for (const nbId of e.faces) {
            if (selSet.has(nbId) && !visited.has(nbId)) {
              visited.add(nbId);
              stack.push(nbId);
            }
          }
        }
      }
      components.push(comp);
    }

    const insetSingleFace = (f) => {
      const count = f.verts.length;
      const centroid = new THREE.Vector3();
      for (const v of f.verts) centroid.add(this.vertices[v]);
      centroid.multiplyScalar(1 / count);

      const cornerUVs = f.verts.map((_, k) => this._cornerUV(f, k));
      const centerUV = this._averageUVs(cornerUVs);
      const hasUV = cornerUVs.some(Boolean);
      const innerUVs = [];
      const innerIndices = [];

      for (let k = 0; k < count; k++) {
        const origV = this.vertices[f.verts[k]];
        const innerV = origV.clone().lerp(centroid, ratio);
        const idx = this.vertices.length;
        this.vertices.push(innerV);
        let innerUV = null;
        if (cornerUVs[k]) {
          innerUV = cornerUVs[k].clone();
          if (centerUV) innerUV.lerp(centerUV, ratio);
        } else if (centerUV) {
          innerUV = centerUV.clone();
        }
        innerUVs.push(innerUV);
        this.vertexUVs.push(innerUV ? innerUV.clone() : (this.vertexUVs[f.verts[k]] ? this.vertexUVs[f.verts[k]].clone() : null));
        innerIndices.push(idx);
      }

      for (let k = 0; k < count; k++) {
        const k2 = (k + 1) % count;
        const u = f.verts[k];
        const v = f.verts[k2];
        const uIn = innerIndices[k];
        const vIn = innerIndices[k2];
        const sideCentroid = new THREE.Vector3()
          .add(this.vertices[u]).add(this.vertices[v])
          .add(this.vertices[vIn]).add(this.vertices[uIn])
          .multiplyScalar(0.25);
        const ringUVs = hasUV ? [
          cornerUVs[k] ? cornerUVs[k].clone() : null,
          cornerUVs[k2] ? cornerUVs[k2].clone() : null,
          innerUVs[k2] ? innerUVs[k2].clone() : null,
          innerUVs[k] ? innerUVs[k].clone() : null
        ] : null;
        this.faces.push({
          id: this.faces.length,
          verts: [u, v, vIn, uIn],
          a: u, b: v, c: vIn, d: uIn,
          normal: f.normal.clone(),
          centroid: sideCentroid,
          uvs: ringUVs
        });
      }

      f.verts = innerIndices;
      f.a = innerIndices[0];
      f.b = innerIndices[1];
      f.c = innerIndices[2];
      f.d = innerIndices.length > 3 ? innerIndices[3] : null;
      f.centroid.copy(centroid);
      if (hasUV) f.uvs = innerUVs.map(uv => uv ? uv.clone() : null);
    };

    for (const comp of components) {
      if (comp.length === 1) {
        insetSingleFace(comp[0]);
        continue;
      }

      // Collect directed boundary edges of this connected region
      const directedMap = new Map();
      const compVerts = new Set();
      for (const f of comp) {
        const count = f.verts.length;
        for (let k = 0; k < count; k++) {
          const u = f.verts[k];
          const v = f.verts[(k + 1) % count];
          compVerts.add(u);
          directedMap.set(`${u}_${v}`, {
            u,
            v,
            face: f,
            uvU: this._cornerUV(f, k),
            uvV: this._cornerUV(f, (k + 1) % count)
          });
        }
      }

      const boundaryEdges = [];
      const inByVert = new Map();
      const outByVert = new Map();
      const boundaryVerts = new Set();

      for (const edge of directedMap.values()) {
        if (directedMap.has(`${edge.v}_${edge.u}`)) continue;
        boundaryEdges.push(edge);
        boundaryVerts.add(edge.u);
        boundaryVerts.add(edge.v);
        if (!outByVert.has(edge.u)) outByVert.set(edge.u, []);
        if (!inByVert.has(edge.v)) inByVert.set(edge.v, []);
        outByVert.get(edge.u).push(edge);
        inByVert.get(edge.v).push(edge);
      }

      if (boundaryEdges.length === 0) {
        // Closed surface (all faces of mesh selected): fall back to per-face inset
        for (const f of comp) insetSingleFace(f);
        continue;
      }

      // Measure half-span along each boundary edge's inward perpendicular to avoid crossing opposite sides
      const compVertList = Array.from(compVerts);
      let spanSum = 0;
      let spanCount = 0;
      let minEdgeLen = Infinity;
      const edgeInPerps = new Map();
      for (const b of boundaryEdges) {
        const pU = this.vertices[b.u];
        const pV = this.vertices[b.v];
        const eVec = new THREE.Vector3().subVectors(pV, pU);
        const eLen = eVec.length();
        if (eLen < 1e-6) continue;
        minEdgeLen = Math.min(minEdgeLen, eLen);
        const eDir = eVec.divideScalar(eLen);
        const inPerp = new THREE.Vector3().crossVectors(b.face.normal, eDir).normalize();
        edgeInPerps.set(b, inPerp);

        const mid = new THREE.Vector3().addVectors(pU, pV).multiplyScalar(0.5);
        let maxProj = 0;
        for (const vi of compVertList) {
          const proj = new THREE.Vector3().subVectors(this.vertices[vi], mid).dot(inPerp);
          if (proj > maxProj) maxProj = proj;
        }
        if (maxProj > 1e-5) {
          spanSum += maxProj;
          spanCount++;
        }
      }
      const avgHalfSpan = spanCount > 0 ? (spanSum / spanCount) * 0.5 : (Number.isFinite(minEdgeLen) ? minEdgeLen * 0.5 : 0.5);
      const insetDist = ratio * avgHalfSpan;

      // Create 1 inner boundary vertex per boundary vertex via mitered inward corner offset
      const innerBoundaryMap = new Map();
      const boundaryShiftVecs = new Map();
      for (const bv of boundaryVerts) {
        const ins = inByVert.get(bv) || [];
        const outs = outByVert.get(bv) || [];
        const acc = new THREE.Vector3();
        const dirs = [];
        for (const e of ins) {
          const n = edgeInPerps.get(e);
          if (n) { acc.add(n); dirs.push(n); }
        }
        for (const e of outs) {
          const n = edgeInPerps.get(e);
          if (n) { acc.add(n); dirs.push(n); }
        }
        let shift = new THREE.Vector3();
        if (acc.lengthSq() > 1e-8) {
          const bisector = acc.normalize();
          let miterScale = 1.0;
          if (dirs.length === 2) {
            const cosHalf = Math.sqrt(Math.max(0.18, (1 + dirs[0].dot(dirs[1])) * 0.5));
            miterScale = Math.min(2.2, 1.0 / cosHalf);
          }
          shift = bisector.multiplyScalar(insetDist * miterScale);
        }
        boundaryShiftVecs.set(bv, shift);

        const newIdx = this.vertices.length;
        this.vertices.push(this.vertices[bv].clone().add(shift));
        this.vertexUVs.push(this.vertexUVs[bv] ? this.vertexUVs[bv].clone() : null);
        innerBoundaryMap.set(bv, newIdx);
      }

      // Compute UV shift for boundary vertices (interpolated inside incident boundary face UVs)
      const boundaryInnerUV = new Map();
      for (const f of comp) {
        const cornerUVs = f.verts.map((_, k) => this._cornerUV(f, k));
        const faceCentroid = f.centroid ? f.centroid.clone() : new THREE.Vector3();
        const centerUV = this._averageUVs(cornerUVs);
        if (!centerUV) continue;
        for (let k = 0; k < f.verts.length; k++) {
          const vi = f.verts[k];
          if (!innerBoundaryMap.has(vi) || !cornerUVs[k]) continue;
          const vPos = this.vertices[vi];
          const vShift = boundaryShiftVecs.get(vi);
          const distCenter = vPos.distanceTo(faceCentroid);
          const localRatio = distCenter > 1e-5 ? Math.min(0.95, vShift.length() / distCenter) : ratio;
          const uv = cornerUVs[k].clone().lerp(centerUV, localRatio);
          if (!boundaryInnerUV.has(vi)) boundaryInnerUV.set(vi, new Map());
          boundaryInnerUV.get(vi).set(f.id, uv);
          const inIdx = innerBoundaryMap.get(vi);
          if (!this.vertexUVs[inIdx]) this.vertexUVs[inIdx] = uv.clone();
        }
      }

      // Emit border quads strictly along outer boundary edges (no interior border faces)
      for (const b of boundaryEdges) {
        const u = b.u;
        const v = b.v;
        const uIn = innerBoundaryMap.get(u);
        const vIn = innerBoundaryMap.get(v);
        const uvU = b.uvU;
        const uvV = b.uvV;
        const uvUIn = boundaryInnerUV.get(u)?.get(b.face.id) || uvU;
        const uvVIn = boundaryInnerUV.get(v)?.get(b.face.id) || uvV;
        const ringUVs = (uvU && uvV)
          ? [uvU.clone(), uvV.clone(), uvVIn ? uvVIn.clone() : null, uvUIn ? uvUIn.clone() : null]
          : null;
        this.faces.push(this._createFaceRecord(this.faces.length, [u, v, vIn, uIn], ringUVs));
      }

      // Rewire component faces onto the inset boundary vertices while keeping interior vertices shared
      for (const f of comp) {
        const nextVs = f.verts.map(v => innerBoundaryMap.get(v) ?? v);
        const nextUVs = f.uvs
          ? f.verts.map((v, k) => {
              if (!innerBoundaryMap.has(v)) return f.uvs[k] ? f.uvs[k].clone() : null;
              return boundaryInnerUV.get(v)?.get(f.id)?.clone() || (f.uvs[k] ? f.uvs[k].clone() : null);
            })
          : null;
        const updated = this._createFaceRecord(f.id, nextVs, nextUVs);
        f.verts = updated.verts;
        f.a = updated.a;
        f.b = updated.b;
        f.c = updated.c;
        f.d = updated.d;
        f.normal.copy(updated.normal);
        f.centroid.copy(updated.centroid);
        if (updated.uvs) f.uvs = updated.uvs;
      }
    }

    this._commitMeshEdit(oldGeom, 'Inset Faces', true, oldSnap);
    console.log(`[EditMode] Inset ${selFaceIndices.length} face(s) (${components.length} region(s))`);
  }

  /**
   * Subdivides selected faces (or all faces if none selected)
   */
  subdivide() {
    if (!this.isActive || !this.targetMesh) return;

    const oldGeom = this.targetMesh.geometry.clone();
    const oldSnap = this._captureTopologySnapshot();
    const hadUV = Boolean(this.targetMesh.geometry?.attributes?.uv) || this.faces.some(f => f.uvs?.some(Boolean));

    // High-performance Rust WASM subdivision for full non-UV high-poly triangular meshes
    if (
      isMeshKernelReady() &&
      !hadUV &&
      this.selectedFaces.size === 0 &&
      this.faces.length > 5000 &&
      this.faces.every(f => f.verts.length === 3)
    ) {
      const posArray = new Float32Array(this.vertices.length * 3);
      for (let i = 0; i < this.vertices.length; i++) {
        const v = this.vertices[i];
        posArray[i * 3 + 0] = v.x;
        posArray[i * 3 + 1] = v.y;
        posArray[i * 3 + 2] = v.z;
      }
      const idxArray = new Uint32Array(this.faces.length * 3);
      for (let i = 0; i < this.faces.length; i++) {
        const f = this.faces[i];
        idxArray[i * 3 + 0] = f.a;
        idxArray[i * 3 + 1] = f.b;
        idxArray[i * 3 + 2] = f.c;
      }

      const subRes = subdivideMesh(posArray, idxArray, false);
      if (subRes) {
        const newGeom = new THREE.BufferGeometry();
        newGeom.setAttribute('position', new THREE.BufferAttribute(subRes.vertices, 3));
        newGeom.setIndex(new THREE.BufferAttribute(subRes.indices, 1));
        newGeom.computeVertexNormals();

        this.targetMesh.geometry.dispose();
        this.targetMesh.geometry = newGeom;
        this._buildTopology(this.targetMesh);
        this._commitMeshEdit(oldGeom, 'Subdivide Faces (WASM)', false, oldSnap);
        return;
      }
    }

    const hadPartialSelection = this.selectedFaces.size > 0;
    const targetFaces = hadPartialSelection
      ? Array.from(this.selectedFaces).map(idx => this.faces[idx]).filter(Boolean)
      : [...this.faces];

    const midpointMap = new Map();
    const getMidpoint = (u, v) => {
      const k = `${Math.min(u, v)}_${Math.max(u, v)}`;
      if (midpointMap.has(k)) return midpointMap.get(k);

      const mid = new THREE.Vector3().addVectors(this.vertices[u], this.vertices[v]).multiplyScalar(0.5);
      const idx = this.vertices.length;
      this.vertices.push(mid);
      this.vertexUVs.push(this._midUV(u, v));
      midpointMap.set(k, idx);
      return idx;
    };

    const targetSet = new Set(targetFaces);
    const untouchedFaces = this.faces.filter(f => !targetSet.has(f));
    const newFaces = [];

    for (const f of targetFaces) {
      const count = f.verts.length;
      const cornerUVs = f.verts.map((_, k) => this._cornerUV(f, k));
      const hasUV = cornerUVs.some(Boolean);
      const uvc = (uv) => uv ? uv.clone() : null;

      if (count >= 4) {
        // Quad & N-gon subdivision into `count` quads meeting at face centroid
        const edgeMids = [];
        const edgeMidUVs = [];
        const center = new THREE.Vector3();
        for (let k = 0; k < count; k++) {
          const u = f.verts[k];
          const v = f.verts[(k + 1) % count];
          center.add(this.vertices[u]);
          edgeMids.push(getMidpoint(u, v));
          edgeMidUVs.push(this._avgTwoUV(cornerUVs[k], cornerUVs[(k + 1) % count]));
        }
        center.multiplyScalar(1 / count);
        const cIdx = this.vertices.length;
        this.vertices.push(center);
        const uvC = this._averageUVs(cornerUVs);
        this.vertexUVs.push(uvC ? uvC.clone() : this._faceUV(f.verts));

        for (let k = 0; k < count; k++) {
          const prev = (k - 1 + count) % count;
          const q = [f.verts[k], edgeMids[k], cIdx, edgeMids[prev]];
          const qUV = hasUV ? [
            uvc(cornerUVs[k]),
            uvc(edgeMidUVs[k]),
            uvc(uvC),
            uvc(edgeMidUVs[prev])
          ] : null;
          newFaces.push(this._createFaceRecord(0, q, qUV));
        }
      } else {
        // Triangle subdivision into 4 triangles
        const [v0, v1, v2] = f.verts;
        const m01 = getMidpoint(v0, v1);
        const m12 = getMidpoint(v1, v2);
        const m20 = getMidpoint(v2, v0);

        const uvM01 = this._avgTwoUV(cornerUVs[0], cornerUVs[1]);
        const uvM12 = this._avgTwoUV(cornerUVs[1], cornerUVs[2]);
        const uvM20 = this._avgTwoUV(cornerUVs[2], cornerUVs[0]);

        const tris = [
          { verts: [v0, m01, m20], uvs: [cornerUVs[0], uvM01, uvM20] },
          { verts: [m01, v1, m12], uvs: [uvM01, cornerUVs[1], uvM12] },
          { verts: [m20, m12, v2], uvs: [uvM20, uvM12, cornerUVs[2]] },
          { verts: [m01, m12, m20], uvs: [uvM01, uvM12, uvM20] }
        ];

        for (const { verts: t, uvs } of tris) {
          newFaces.push(this._createFaceRecord(0, t, hasUV ? uvs.map(uvc) : null));
        }
      }
    }

    // Splice split edge midpoints into adjacent un-selected faces so partial
    // subdivision never leaves open T-junction cracks.
    const remainingFaces = untouchedFaces.map((rf) => {
      const count = rf.verts.length;
      const nextVs = [];
      const nextUVs = [];
      let didSplit = false;
      let hasFaceUV = false;
      for (let k = 0; k < count; k++) {
        const u = rf.verts[k];
        const v = rf.verts[(k + 1) % count];
        const uvU = this._cornerUV(rf, k);
        const uvV = this._cornerUV(rf, (k + 1) % count);
        if (uvU) hasFaceUV = true;
        nextVs.push(u);
        nextUVs.push(uvU ? uvU.clone() : null);

        const midIdx = midpointMap.get(`${Math.min(u, v)}_${Math.max(u, v)}`);
        if (midIdx !== undefined) {
          didSplit = true;
          nextVs.push(midIdx);
          const midUV = this._avgTwoUV(uvU, uvV);
          nextUVs.push(midUV ? midUV.clone() : null);
          if (midUV) hasFaceUV = true;
        }
      }
      return didSplit ? this._createFaceRecord(0, nextVs, hasFaceUV ? nextUVs : null) : rf;
    });

    this.faces = [...remainingFaces, ...newFaces];
    for (let i = 0; i < this.faces.length; i++) {
      this.faces[i].id = i;
    }

    this.selectedFaces.clear();
    if (hadPartialSelection && this.selectionMode === 'face') {
      for (let i = remainingFaces.length; i < this.faces.length; i++) {
        this.selectedFaces.add(i);
      }
    }
    this._commitMeshEdit(oldGeom, 'Subdivide Faces', true, oldSnap);

    console.log(`[EditMode] Subdivided ${targetFaces.length} face(s) into ${newFaces.length} sub-faces`);
  }

  /**
   * Poke selected faces: fans each face into triangles around a new centre vertex.
   */
  pokeFaces() {
    if (!this.isActive || !this.targetMesh) return;
    if (this.selectionMode !== 'face' || this.selectedFaces.size === 0) {
      console.warn('[EditMode] Poke requires at least one face selected in Face Mode (3).');
      return;
    }

    const oldGeom = this.targetMesh.geometry.clone();
    const oldSnap = this._captureTopologySnapshot();
    const selFaces = new Set(Array.from(this.selectedFaces).map(i => this.faces[i]).filter(Boolean));
    if (selFaces.size === 0) return;

    const keptFaces = [];
    const newFaces = [];
    const pokedIds = [];

    for (const f of this.faces) {
      if (!selFaces.has(f)) {
        keptFaces.push(f);
        continue;
      }

      const count = f.verts.length;
      const cornerUVs = f.verts.map((_, k) => this._cornerUV(f, k));
      const hasUV = cornerUVs.some(Boolean);
      const centerUV = this._averageUVs(cornerUVs);
      const center = new THREE.Vector3();
      for (const v of f.verts) center.add(this.vertices[v]);
      center.multiplyScalar(1 / count);

      const cIdx = this.vertices.length;
      this.vertices.push(center);
      this.vertexUVs.push(centerUV ? centerUV.clone() : this._faceUV(f.verts));

      for (let k = 0; k < count; k++) {
        const a = f.verts[k];
        const b = f.verts[(k + 1) % count];
        const centroid = new THREE.Vector3()
          .add(this.vertices[a])
          .add(this.vertices[b])
          .add(center)
          .multiplyScalar(1 / 3);
        newFaces.push({
          id: -1,
          verts: [a, b, cIdx],
          a, b, c: cIdx, d: null,
          normal: f.normal.clone(),
          centroid,
          uvs: hasUV ? [
            cornerUVs[k] ? cornerUVs[k].clone() : null,
            cornerUVs[(k + 1) % count] ? cornerUVs[(k + 1) % count].clone() : null,
            centerUV ? centerUV.clone() : null
          ] : null
        });
        pokedIds.push(keptFaces.length + newFaces.length - 1);
      }
    }

    this.faces = [...keptFaces, ...newFaces];
    for (let i = 0; i < this.faces.length; i++) this.faces[i].id = i;

    this.selectedFaces = new Set(pokedIds);
    this.selectedEdges.clear();
    this.selectedVertices.clear();
    this._commitMeshEdit(oldGeom, 'Poke Faces', true, oldSnap);

    console.log(`[EditMode] Poked ${selFaces.size} face(s)`);
  }

  /**
   * Duplicate selected geometry in place (Blender Shift+D), then start a Grab.
   */
  duplicateSelection() {
    if (!this.isActive || !this.targetMesh) return;

    const srcVerts = new Set();
    const srcFaces = new Set();

    if (this.selectionMode === 'vertex') {
      this.selectedVertices.forEach(v => srcVerts.add(v));
    } else if (this.selectionMode === 'edge') {
      this.selectedEdges.forEach(ei => {
        const e = this.edges[ei];
        if (e) { srcVerts.add(e.v0); srcVerts.add(e.v1); }
      });
    } else {
      this.selectedFaces.forEach(fi => {
        const f = this.faces[fi];
        if (!f) return;
        srcFaces.add(fi);
        f.verts.forEach(v => srcVerts.add(v));
      });
    }

    if (srcVerts.size === 0) {
      console.warn('[EditMode] Nothing selected to duplicate.');
      return;
    }

    const oldGeom = this.targetMesh.geometry.clone();
    const oldSnap = this._captureTopologySnapshot();
    const vertMap = new Map();
    for (const vi of srcVerts) {
      const newIdx = this.vertices.length;
      this.vertices.push(this.vertices[vi].clone());
      this.vertexUVs.push(this.vertexUVs[vi] ? this.vertexUVs[vi].clone() : null);
      vertMap.set(vi, newIdx);
    }

    const newFaceIndices = [];
    for (const fi of srcFaces) {
      const f = this.faces[fi];
      if (!f) continue;
      const verts = f.verts.map(v => vertMap.get(v));
      newFaceIndices.push(this.faces.length);
      this.faces.push({
        id: this.faces.length,
        verts,
        a: verts[0], b: verts[1], c: verts[2],
        d: verts.length > 3 ? verts[3] : null,
        normal: f.normal.clone(),
        centroid: f.centroid.clone(),
        uvs: f.uvs ? f.uvs.map(uv => uv ? uv.clone() : null) : null
      });
    }

    this.selectedVertices = new Set(vertMap.values());
    this.selectedEdges.clear();
    this.selectedFaces.clear();
    this._rebuildEdges();

    if (this.selectionMode === 'face') {
      newFaceIndices.forEach(fi => this.selectedFaces.add(fi));
    } else if (this.selectionMode === 'edge') {
      for (const edge of this.edges) {
        if (this.selectedVertices.has(edge.v0) && this.selectedVertices.has(edge.v1)) {
          this.selectedEdges.add(edge.id);
        }
      }
    }

    this.rebuildGeometry();
    this._commitMeshEdit(oldGeom, 'Duplicate', false, oldSnap);

    if (typeof window !== 'undefined' && window.modalTransformManager) {
      window.modalTransformManager.start('translate');
    }

    console.log(`[EditMode] Duplicated ${srcVerts.size} vertex/vertices`);
  }

  /**
   * Select all geometry connected to the current selection (Ctrl+L).
   */
  selectLinked() {
    if (!this.isActive) return;

    const seed = new Set();
    if (this.selectionMode === 'vertex') {
      this.selectedVertices.forEach(v => seed.add(v));
    } else if (this.selectionMode === 'edge') {
      this.selectedEdges.forEach(ei => {
        const e = this.edges[ei];
        if (e) { seed.add(e.v0); seed.add(e.v1); }
      });
    } else {
      this.selectedFaces.forEach(fi => {
        const f = this.faces[fi];
        if (f) f.verts.forEach(v => seed.add(v));
      });
    }

    if (seed.size === 0) {
      console.warn('[EditMode] Select something first, then use Select Linked.');
      return;
    }

    const adjacency = new Map();
    const link = (a, b) => {
      if (!adjacency.has(a)) adjacency.set(a, []);
      adjacency.get(a).push(b);
    };
    for (const f of this.faces) {
      const count = f.verts.length;
      for (let k = 0; k < count; k++) {
        const a = f.verts[k];
        const b = f.verts[(k + 1) % count];
        link(a, b);
        link(b, a);
      }
    }

    const component = new Set(seed);
    const queue = Array.from(seed);
    while (queue.length > 0) {
      const cur = queue.pop();
      for (const nb of (adjacency.get(cur) || [])) {
        if (component.has(nb)) continue;
        component.add(nb);
        queue.push(nb);
      }
    }

    this.selectedVertices.clear();
    this.selectedEdges.clear();
    this.selectedFaces.clear();

    if (this.selectionMode === 'vertex') {
      component.forEach(v => this.selectedVertices.add(v));
    } else if (this.selectionMode === 'edge') {
      for (const edge of this.edges) {
        if (component.has(edge.v0) && component.has(edge.v1)) {
          this.selectedEdges.add(edge.id);
        }
      }
    } else {
      for (const f of this.faces) {
        if (f.verts.every(v => component.has(v))) {
          this.selectedFaces.add(f.id);
        }
      }
    }

    this.updateVisuals();
    this.updateGizmoProxy();
    console.log(`[EditMode] Select Linked: ${component.size} vertex/vertices`);
  }

  /**
   * Selection-scoped True Bevel (Blender Ctrl+B).
   * Bevels selected edges/faces/vertices (or all sharp edges when none selected)
   * with 1..8 segments and corner mitering via bevelMesh().
   * @param {number} [width=0.08]
   * @param {number} [segments=1]
   */
  bevel(width = 0.08, segments = 1) {
    if (!this.isActive || !this.targetMesh || this.faces.length === 0) return;

    const oldGeom = this.targetMesh.geometry.clone();
    const oldSnap = this._captureTopologySnapshot();

    let selectedEdgeKeys = null;
    if (this.selectionMode === 'edge' && this.selectedEdges.size > 0) {
      selectedEdgeKeys = new Set();
      for (const eIdx of this.selectedEdges) {
        const e = this.edges[eIdx];
        if (e && this.vertices[e.v0] && this.vertices[e.v1]) {
          selectedEdgeKeys.add(bevelEdgeCoordKey(this.vertices[e.v0], this.vertices[e.v1]));
        }
      }
    } else if (this.selectionMode === 'face' && this.selectedFaces.size > 0) {
      // Boundary edges of selected faces + interior sharp dihedral edges among selected faces
      selectedEdgeKeys = new Set();
      for (const fIdx of this.selectedFaces) {
        const f = this.faces[fIdx];
        if (!f) continue;
        for (let k = 0; k < f.verts.length; k++) {
          const u = f.verts[k];
          const v = f.verts[(k + 1) % f.verts.length];
          const edge = this.edgeMap.get(`${Math.min(u, v)}_${Math.max(u, v)}`);
          if (!edge) continue;
          const allSelected = edge.faces.every(fid => this.selectedFaces.has(fid));
          const isInteriorSharp = allSelected && edge.faces.length === 2 &&
            this.faces[edge.faces[0]] && this.faces[edge.faces[1]] &&
            this.faces[edge.faces[0]].normal.dot(this.faces[edge.faces[1]].normal) < 0.99;
          if (!allSelected || this.selectedFaces.size === 1 || isInteriorSharp) {
            selectedEdgeKeys.add(bevelEdgeCoordKey(this.vertices[edge.v0], this.vertices[edge.v1]));
          }
        }
      }
    } else if (this.selectionMode === 'vertex' && this.selectedVertices.size > 0) {
      selectedEdgeKeys = new Set();
      for (const e of this.edges) {
        if (this.selectedVertices.has(e.v0) && this.selectedVertices.has(e.v1)) {
          selectedEdgeKeys.add(bevelEdgeCoordKey(this.vertices[e.v0], this.vertices[e.v1]));
        }
      }
      if (selectedEdgeKeys.size === 0) {
        for (const e of this.edges) {
          if (this.selectedVertices.has(e.v0) || this.selectedVertices.has(e.v1)) {
            selectedEdgeKeys.add(bevelEdgeCoordKey(this.vertices[e.v0], this.vertices[e.v1]));
          }
        }
      }
    }

    const beveledGeom = bevelMesh(oldGeom, {
      width: Math.max(0.005, width),
      segments: Math.max(1, Math.min(8, Math.round(segments))),
      profile: 0.5,
      clampOverlap: true,
      limitMethod: 'none',
      selectedEdgeKeys: selectedEdgeKeys && selectedEdgeKeys.size > 0 ? selectedEdgeKeys : null
    });

    if (beveledGeom && beveledGeom !== oldGeom) {
      this.targetMesh.geometry.dispose();
      this.targetMesh.geometry = beveledGeom;
      this._buildTopology(this.targetMesh);
      this.selectedFaces.clear();
      this.selectedEdges.clear();
      this.selectedVertices.clear();
      this._commitMeshEdit(oldGeom, 'Bevel', false, oldSnap);
      console.log(`[EditMode] Bevel complete (width=${width}, segs=${segments}): ${this.vertices.length} verts, ${this.faces.length} faces`);
    }
  }

  /**
   * Selects an edge loop passing through edgeIndex (Blender Alt+Click)
   * @param {number} [edgeIndex]
   * @returns {number[]} Array of edge indices in loop
   */
  selectLoop(edgeIndex) {
    if (edgeIndex === undefined || edgeIndex === null) {
      edgeIndex = this.selectedEdges.size > 0 ? this.selectedEdges.values().next().value : 0;
    }
    const startEdge = this.edges[edgeIndex];
    if (!startEdge) return [];

    const loopEdges = new Set([edgeIndex]);

    for (const dir of [0, 1]) {
      let currentEdgeIdx = edgeIndex;
      let previousFaceId = -1;

      while (true) {
        const currentEdge = this.edges[currentEdgeIdx];
        if (!currentEdge) break;

        const nextFaceId = currentEdge.faces.find(fId => fId !== previousFaceId);
        if (nextFaceId === undefined) break;

        const face = this.faces[nextFaceId];
        if (!face || face.verts.length !== 4) break;

        const vs = face.verts;
        let oppU = -1, oppV = -1;
        for (let k = 0; k < 4; k++) {
          const u = vs[k];
          const v = vs[(k + 1) % 4];
          if ((u === currentEdge.v0 && v === currentEdge.v1) || (u === currentEdge.v1 && v === currentEdge.v0)) {
            oppU = vs[(k + 2) % 4];
            oppV = vs[(k + 3) % 4];
            break;
          }
        }
        if (oppU === -1) break;

        const oppKey = `${Math.min(oppU, oppV)}_${Math.max(oppU, oppV)}`;
        const oppEdge = this.edgeMap.get(oppKey);
        if (!oppEdge) break;

        if (loopEdges.has(oppEdge.id)) {
          break;
        }

        loopEdges.add(oppEdge.id);
        previousFaceId = nextFaceId;
        currentEdgeIdx = oppEdge.id;
      }
    }

    this.selectedEdges = loopEdges;
    this.selectionMode = 'edge';
    this.updateVisuals();
    this.updateGizmoProxy();
    return Array.from(loopEdges);
  }

  /**
   * Trace the connected quad face ring crossed perpendicularly by `edgeIndex`.
   * Walks forward and, if open-ended, backward so open quad strips cut end-to-end.
   * Each entry specifies consistent parameterization sides (leftA->rightA, leftB->rightB)
   * and `reverseWinding` so multi-cut sub-quads never twist or cross.
   */
  _traceQuadCutRing(edgeIndex) {
    const startEdge = this.edges[edgeIndex];
    if (!startEdge) return [];

    const visitedFaces = new Set();

    const stepAcrossFace = (face, enterLeft, enterRight) => {
      const vs = face.verts;
      for (let k = 0; k < 4; k++) {
        const a = vs[k];
        const b = vs[(k + 1) % 4];
        if (a === enterLeft && b === enterRight) {
          return {
            faceId: face.id,
            leftA: enterLeft,
            rightA: enterRight,
            leftB: vs[(k + 3) % 4],
            rightB: vs[(k + 2) % 4],
            reverseWinding: false
          };
        }
        if (a === enterRight && b === enterLeft) {
          return {
            faceId: face.id,
            leftA: enterLeft,
            rightA: enterRight,
            leftB: vs[(k + 2) % 4],
            rightB: vs[(k + 3) % 4],
            reverseWinding: true
          };
        }
      }
      return null;
    };

    const walkDirection = (initFaceId, seedLeft, seedRight, prevFace) => {
      const chain = [];
      let curFaceId = initFaceId;
      let left = seedLeft;
      let right = seedRight;
      let lastFaceId = prevFace;
      for (let step = 0; step < this.faces.length; step++) {
        if (curFaceId === undefined || curFaceId === null || visitedFaces.has(curFaceId)) break;
        const face = this.faces[curFaceId];
        if (!face || face.verts.length !== 4) break;
        const rec = stepAcrossFace(face, left, right);
        if (!rec) break;
        visitedFaces.add(face.id);
        chain.push(rec);

        const nextKey = `${Math.min(rec.leftB, rec.rightB)}_${Math.max(rec.leftB, rec.rightB)}`;
        const nextEdge = this.edgeMap.get(nextKey);
        if (!nextEdge) break;
        if (nextEdge.id === startEdge.id) {
          return { chain, closed: true };
        }
        left = rec.leftB;
        right = rec.rightB;
        lastFaceId = face.id;
        curFaceId = nextEdge.faces.find(fId => fId !== lastFaceId);
      }
      return { chain, closed: false };
    };

    if (startEdge.faces.length === 0) return [];

    const f0Id = startEdge.faces[0];
    const fwd = walkDirection(f0Id, startEdge.v0, startEdge.v1, -1);
    if (fwd.closed || startEdge.faces.length < 2) {
      return fwd.chain;
    }

    // Open ring: also walk backward from startEdge's second adjacent face and prepend
    const bwd = walkDirection(startEdge.faces[1], startEdge.v0, startEdge.v1, f0Id);
    if (bwd.chain.length === 0) return fwd.chain;

    const flippedPrefix = [];
    for (let i = bwd.chain.length - 1; i >= 0; i--) {
      const r = bwd.chain[i];
      flippedPrefix.push({
        faceId: r.faceId,
        leftA: r.leftB,
        rightA: r.rightB,
        leftB: r.leftA,
        rightB: r.rightA,
        reverseWinding: !r.reverseWinding
      });
    }
    return [...flippedPrefix, ...fwd.chain];
  }

  /**
   * Loop cut through a quad loop (Blender Ctrl+R)
   * @param {number} [edgeIndex]
   * @param {number} [cuts=1]
   * @param {number} [slideOffset=0] Relative slide in (-0.95..0.95)
   * @returns {boolean}
   */
  loopCut(edgeIndex, cuts = 1, slideOffset = 0) {
    if (!this.isActive || !this.targetMesh) return false;
    if (edgeIndex === undefined || edgeIndex === null) {
      if (this.selectedEdges.size > 0) {
        edgeIndex = this.selectedEdges.values().next().value;
      } else {
        let candidate = null;
        if (this.selectedFaces.size > 0) {
          const firstF = this.faces[this.selectedFaces.values().next().value];
          if (firstF && firstF.verts.length === 4) {
            candidate = this.edgeMap.get(`${Math.min(firstF.verts[0], firstF.verts[1])}_${Math.max(firstF.verts[0], firstF.verts[1])}`)?.id;
          }
        }
        if (candidate === null || candidate === undefined) {
          const quad = this.faces.find(f => f.verts.length === 4);
          if (quad) {
            candidate = this.edgeMap.get(`${Math.min(quad.verts[0], quad.verts[1])}_${Math.max(quad.verts[0], quad.verts[1])}`)?.id;
          }
        }
        edgeIndex = candidate ?? 0;
      }
    }

    const ring = this._traceQuadCutRing(edgeIndex);
    if (ring.length === 0) return false;

    const cutCount = Math.max(1, Math.min(16, Math.round(Number(cuts) || 1)));
    const slide = Math.max(-0.95, Math.min(0.95, Number(slideOffset) || 0));

    const baseTs = [];
    for (let c = 0; c < cutCount; c++) {
      baseTs.push((c + 1) / (cutCount + 1));
    }
    const maxShift = (1 / (cutCount + 1)) * 0.92;
    const tParams = baseTs.map(t => Math.max(0.02, Math.min(0.98, t + slide * maxShift)));

    const oldGeom = this.targetMesh.geometry.clone();
    const oldSnap = this._captureTopologySnapshot();

    const edgeSplits = new Map();
    const getSplits = (u, v) => {
      const k = `${Math.min(u, v)}_${Math.max(u, v)}`;
      if (edgeSplits.has(k)) {
        const entry = edgeSplits.get(k);
        return entry.u === u ? entry.verts : [...entry.verts].reverse();
      }
      const verts = [];
      for (const t of tParams) {
        const pos = new THREE.Vector3().lerpVectors(this.vertices[u], this.vertices[v], t);
        const idx = this.vertices.length;
        this.vertices.push(pos);
        const uvU = this.vertexUVs[u];
        const uvV = this.vertexUVs[v];
        this.vertexUVs.push(uvU && uvV ? new THREE.Vector2().lerpVectors(uvU, uvV, t) : (uvU || uvV ? (uvU || uvV).clone() : null));
        verts.push(idx);
      }
      edgeSplits.set(k, { u, v, verts });
      return verts;
    };

    const newFaces = [];
    const cutFaceSet = new Set(ring.map(r => r.faceId));
    const untouchedFaces = this.faces.filter(f => !cutFaceSet.has(f.id));
    const createdLoopEdgeKeys = [];

    for (const rec of ring) {
      const face = this.faces[rec.faceId];
      if (!face) continue;

      const sA = getSplits(rec.leftA, rec.rightA);
      const sB = getSplits(rec.leftB, rec.rightB);
      const cols = [[rec.leftA, rec.leftB]];
      for (let c = 0; c < cutCount; c++) {
        cols.push([sA[c], sB[c]]);
        createdLoopEdgeKeys.push(`${Math.min(sA[c], sB[c])}_${Math.max(sA[c], sB[c])}`);
      }
      cols.push([rec.rightA, rec.rightB]);

      const vs = face.verts;
      const cornerAt = (vertIdx) => {
        const idx = vs.indexOf(vertIdx);
        return idx >= 0 ? this._cornerUV(face, idx) : null;
      };
      const uvLA = cornerAt(rec.leftA);
      const uvRA = cornerAt(rec.rightA);
      const uvLB = cornerAt(rec.leftB);
      const uvRB = cornerAt(rec.rightB);
      const hasUV = Boolean(uvLA || uvRA || uvLB || uvRB);
      const lerpOptUV = (a, b, t) => (a && b ? new THREE.Vector2().lerpVectors(a, b, t) : (a || b ? (a || b).clone() : null));
      const uvCols = [[uvLA, uvLB]];
      for (let c = 0; c < cutCount; c++) {
        const t = tParams[c];
        uvCols.push([lerpOptUV(uvLA, uvRA, t), lerpOptUV(uvLB, uvRB, t)]);
      }
      uvCols.push([uvRA, uvRB]);

      for (let c = 0; c <= cutCount; c++) {
        const [a0, b0] = cols[c];
        const [a1, b1] = cols[c + 1];
        const qVerts = rec.reverseWinding ? [a1, a0, b0, b1] : [a0, a1, b1, b0];
        let qUVs = null;
        if (hasUV) {
          const [ua0, ub0] = uvCols[c];
          const [ua1, ub1] = uvCols[c + 1];
          const raw = rec.reverseWinding ? [ua1, ua0, ub0, ub1] : [ua0, ua1, ub1, ub0];
          qUVs = raw.map(uv => (uv ? uv.clone() : null));
        }
        newFaces.push(this._createFaceRecord(0, qVerts, qUVs));
      }
    }

    this.faces = [...untouchedFaces, ...newFaces];
    for (let i = 0; i < this.faces.length; i++) {
      this.faces[i].id = i;
    }

    this._rebuildEdges();
    this.selectionMode = 'edge';
    this.selectedFaces.clear();
    this.selectedVertices.clear();
    this.selectedEdges.clear();
    for (const ek of createdLoopEdgeKeys) {
      const edge = this.edgeMap.get(ek);
      if (edge) this.selectedEdges.add(edge.id);
    }

    this.rebuildGeometry();
    this._commitMeshEdit(oldGeom, 'Loop Cut', false, oldSnap);
    return true;
  }

  /**
   * Interactive Blender Ctrl+R Loop Cut mode: shows yellow preview cut ring under pointer,
   * mouse wheel / +/- adjusts cuts, LMB / Enter confirms, Esc / RMB cancels.
   */
  startLoopCutMode() {
    if (!this.isActive || !this.targetMesh || !this.engine?.domElement) return false;
    if (this._loopCutSession) return true;

    const host = document.getElementById('viewport-canvas-host') || this.engine.domElement.parentElement;
    if (!host) return false;

    const previewMat = new THREE.LineBasicMaterial({
      color: 0xfacc15,
      depthTest: false,
      transparent: true,
      opacity: 0.95
    });
    const previewLines = new THREE.LineSegments(new THREE.BufferGeometry(), previewMat);
    previewLines.renderOrder = 999;
    previewLines.matrixAutoUpdate = false;
    previewLines.matrix.copy(this.targetMesh.matrixWorld);
    previewLines.matrixWorld.copy(this.targetMesh.matrixWorld);
    this.scene.add(previewLines);

    let cuts = 1;
    let hoveredEdgeId = this.selectedEdges.size > 0
      ? this.selectedEdges.values().next().value
      : (this.edges.find(e => e.faces.some(fid => this.faces[fid]?.verts.length === 4))?.id ?? null);

    const hud = document.createElement('div');
    hud.className = 'blender-knife-hud';
    const updateHud = () => {
      hud.innerHTML = `<b>Loop Cut (Ctrl+R)</b> · Cuts: <span style="color:#facc15">${cuts}</span> · Wheel/± Cuts · <span style="color:#2ecc71">[LMB/Enter]</span> Cut · <span style="color:#e74c3c">[Esc/RMB]</span> Cancel`;
    };
    updateHud();
    host.appendChild(hud);

    const invMat = this.targetMesh.matrixWorld.clone().invert();
    const prevControlsEnabled = this.engine.controls ? this.engine.controls.enabled : true;

    const updatePreview = () => {
      previewLines.matrix.copy(this.targetMesh.matrixWorld);
      previewLines.matrixWorld.copy(this.targetMesh.matrixWorld);
      const pts = [];
      if (hoveredEdgeId !== null && hoveredEdgeId !== undefined) {
        const ring = this._traceQuadCutRing(hoveredEdgeId);
        if (ring.length > 0) {
          for (let c = 0; c < cuts; c++) {
            const t = (c + 1) / (cuts + 1);
            for (const rec of ring) {
              const p1 = new THREE.Vector3().lerpVectors(this.vertices[rec.leftA], this.vertices[rec.rightA], t);
              const p2 = new THREE.Vector3().lerpVectors(this.vertices[rec.leftB], this.vertices[rec.rightB], t);
              pts.push(p1.x, p1.y, p1.z, p2.x, p2.y, p2.z);
            }
          }
        }
      }
      previewLines.geometry.dispose();
      previewLines.geometry = new THREE.BufferGeometry();
      if (pts.length > 0) {
        previewLines.geometry.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
        previewLines.visible = true;
      } else {
        previewLines.visible = false;
      }
      this.engine.requestRender?.();
    };

    const pickEdgeAtPointer = (clientX, clientY) => {
      const vpCtx = this.engine.getViewportContextAtPoint
        ? this.engine.getViewportContextAtPoint(clientX, clientY)
        : {
            rect: this.engine.getViewportRect ? this.engine.getViewportRect() : this.engine.domElement.getBoundingClientRect(),
            camera: this.engine.camera
          };
      const rect = vpCtx.rect;
      const cam = vpCtx.camera || this.engine.camera;
      this.pointer.x = ((clientX - rect.left) / (rect.width || 1)) * 2 - 1;
      this.pointer.y = -((clientY - rect.top) / (rect.height || 1)) * 2 + 1;
      this.raycaster.setFromCamera(this.pointer, cam);
      ensureBVH(this.targetMesh);
      const hits = this.raycaster.intersectObject(this.targetMesh, false);
      if (hits.length === 0) return;

      const localHit = hits[0].point.clone().applyMatrix4(invMat);
      const fId = this.triangleToFaceMap?.[hits[0].faceIndex];
      const hitFace = this.faces[fId];
      if (!hitFace || hitFace.verts.length !== 4) return;

      let bestEdgeId = null;
      let bestDistSq = Infinity;
      const seg = new THREE.Line3();
      const closest = new THREE.Vector3();
      for (let k = 0; k < 4; k++) {
        const u = hitFace.verts[k];
        const v = hitFace.verts[(k + 1) % 4];
        const edge = this.edgeMap.get(`${Math.min(u, v)}_${Math.max(u, v)}`);
        if (!edge) continue;
        seg.set(this.vertices[u], this.vertices[v]);
        seg.closestPointToPoint(localHit, true, closest);
        const dSq = closest.distanceToSquared(localHit);
        if (dSq < bestDistSq) {
          bestDistSq = dSq;
          bestEdgeId = edge.id;
        }
      }
      if (bestEdgeId !== null) {
        hoveredEdgeId = bestEdgeId;
        updatePreview();
      }
    };

    const confirmLoopCut = () => {
      const targetEdge = hoveredEdgeId;
      const numCuts = cuts;
      this.cancelLoopCutMode();
      if (targetEdge !== null && targetEdge !== undefined) {
        if (typeof window !== 'undefined' && window.blenderModelingSuite?.runLoopCutWithAdjust) {
          window.blenderModelingSuite.runLoopCutWithAdjust(targetEdge, numCuts, 0);
        } else {
          this.loopCut(targetEdge, numCuts, 0);
        }
      }
    };

    const onMove = (e) => {
      if (!this._loopCutSession) return;
      pickEdgeAtPointer(e.clientX, e.clientY);
    };
    const onDown = (e) => {
      if (!this._loopCutSession) return;
      if (e.button === 0) {
        e.preventDefault();
        e.stopPropagation();
        pickEdgeAtPointer(e.clientX, e.clientY);
        confirmLoopCut();
      } else if (e.button === 2) {
        e.preventDefault();
        e.stopPropagation();
        this.cancelLoopCutMode();
      }
    };
    const onWheel = (e) => {
      if (!this._loopCutSession) return;
      e.preventDefault();
      e.stopPropagation();
      cuts = Math.max(1, Math.min(12, cuts + (e.deltaY < 0 ? 1 : -1)));
      updateHud();
      updatePreview();
    };
    const onKey = (e) => {
      if (!this._loopCutSession) return;
      if (e.key === 'Enter' || e.code === 'Space') {
        e.preventDefault();
        e.stopPropagation();
        confirmLoopCut();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        this.cancelLoopCutMode();
      } else if (e.key === '+' || e.key === '=' || e.key === 'ArrowUp') {
        e.preventDefault();
        e.stopPropagation();
        cuts = Math.min(12, cuts + 1);
        updateHud();
        updatePreview();
      } else if (e.key === '-' || e.key === '_' || e.key === 'ArrowDown') {
        e.preventDefault();
        e.stopPropagation();
        cuts = Math.max(1, cuts - 1);
        updateHud();
        updatePreview();
      } else if (/^[1-9]$/.test(e.key)) {
        e.preventDefault();
        e.stopPropagation();
        cuts = parseInt(e.key, 10);
        updateHud();
        updatePreview();
      }
    };

    const dom = this.engine.domElement;
    dom.addEventListener('pointermove', onMove, true);
    dom.addEventListener('pointerdown', onDown, true);
    dom.addEventListener('wheel', onWheel, { capture: true, passive: false });
    window.addEventListener('keydown', onKey, true);

    updatePreview();

    this._loopCutSession = {
      cleanup: () => {
        dom.removeEventListener('pointermove', onMove, true);
        dom.removeEventListener('pointerdown', onDown, true);
        dom.removeEventListener('wheel', onWheel, true);
        window.removeEventListener('keydown', onKey, true);
        previewLines.geometry?.dispose?.();
        previewMat.dispose();
        this.scene.remove(previewLines);
        hud.remove();
        if (this.engine.controls) this.engine.controls.enabled = prevControlsEnabled;
        this._loopCutSession = null;
        this.engine.requestRender?.();
      }
    };
    return true;
  }

  cancelLoopCutMode() {
    if (!this._loopCutSession) return false;
    this._loopCutSession.cleanup();
    return true;
  }

  /**
   * Merges selected vertices at center (Blender M -> At Center)
   * @param {'center'} [mode='center']
   */
  merge(mode = 'center') {
    if (!this.isActive || !this.targetMesh) return;

    const oldGeom = this.targetMesh.geometry.clone();
    const oldSnap = this._captureTopologySnapshot();
    const selVerts = Array.from(this.getActiveVertexIndices());
    if (selVerts.length < 2) {
      console.warn('[EditMode] Merge requires at least 2 vertices selected.');
      return;
    }

    const centroid = new THREE.Vector3();
    for (const vIdx of selVerts) {
      centroid.add(this.vertices[vIdx]);
    }
    centroid.divideScalar(selVerts.length);

    const targetIdx = selVerts[0];
    this.vertices[targetIdx].copy(centroid);

    const remap = new Map();
    for (let i = 1; i < selVerts.length; i++) {
      remap.set(selVerts[i], targetIdx);
    }

    const survivingFaces = [];
    for (const f of this.faces) {
      const newVs = f.verts.map(v => remap.has(v) ? remap.get(v) : v);
      const srcUVs = f.uvs || null;

      const filteredVs = [];
      const filteredUVs = [];
      for (let k = 0; k < newVs.length; k++) {
        const next = newVs[(k + 1) % newVs.length];
        if (newVs[k] !== next) {
          filteredVs.push(newVs[k]);
          filteredUVs.push(srcUVs && srcUVs[k] ? srcUVs[k].clone() : null);
        }
      }

      const uniqueVs = new Set(filteredVs);
      if (uniqueVs.size >= 3) {
        survivingFaces.push({
          id: survivingFaces.length,
          verts: filteredVs,
          a: filteredVs[0],
          b: filteredVs[1],
          c: filteredVs[2],
          d: filteredVs.length > 3 ? filteredVs[3] : null,
          normal: f.normal.clone(),
          centroid: new THREE.Vector3(),
          uvs: filteredUVs.some(Boolean) ? filteredUVs : null
        });
      }
    }

    const usedVerts = new Set();
    for (const f of survivingFaces) {
      for (const v of f.verts) usedVerts.add(v);
    }

    const newVerts = [];
    const newUVs = [];
    const compactMap = new Map();
    for (let i = 0; i < this.vertices.length; i++) {
      if (usedVerts.has(i)) {
        compactMap.set(i, newVerts.length);
        newVerts.push(this.vertices[i]);
        newUVs.push(this.vertexUVs[i] || null);
      }
    }

    this.vertices = newVerts;
    this.vertexUVs = newUVs;
    this.faces = survivingFaces.map((f, newId) => {
      const compactedVs = f.verts.map(v => compactMap.get(v));
      return {
        id: newId,
        verts: compactedVs,
        a: compactedVs[0],
        b: compactedVs[1],
        c: compactedVs[2],
        d: compactedVs.length > 3 ? compactedVs[3] : null,
        normal: f.normal,
        centroid: f.centroid,
        uvs: f.uvs ? f.uvs.map(uv => uv ? uv.clone() : null) : null
      };
    });

    this.selectedVertices.clear();
    this.selectedEdges.clear();
    this.selectedFaces.clear();
    if (compactMap.has(targetIdx)) {
      this.selectedVertices.add(compactMap.get(targetIdx));
    }

    this._commitMeshEdit(oldGeom, 'Merge Vertices', true, oldSnap);

    console.log(`[EditMode] Merged ${selVerts.length} vertices at center.`);
  }

  /**
   * Real Knife Cut operator (Blender K).
   * - If `points` has >= 2 local-space Vector3 / {x,y,z} points, slices intersecting
   *   faces along each cut segment cleanly across edges with shared split vertices & UV interpolation.
   * - If called with no points interactively in browser, starts interactive Knife Mode if available.
   * @param {Array} [points=[]]
   * @returns {boolean}
   */
  knife(points = []) {
    if (!this.isActive || !this.targetMesh) return false;
    if (!Array.isArray(points) || points.length < 2) {
      if (typeof document !== 'undefined' && this.engine?.domElement) {
        return this.startKnifeMode();
      }
      return true;
    }

    const pts = points.map(p => (p instanceof THREE.Vector3 ? p.clone() : new THREE.Vector3(p.x || 0, p.y || 0, p.z || 0)));
    const oldGeom = this.targetMesh.geometry.clone();
    const oldSnap = this._captureTopologySnapshot();
    let totalSplits = 0;

    for (let s = 0; s < pts.length - 1; s++) {
      const segA = pts[s];
      const segB = pts[s + 1];
      const segVec = new THREE.Vector3().subVectors(segB, segA);
      const segLen = segVec.length();
      if (segLen < 1e-5) continue;
      const segDir = segVec.clone().divideScalar(segLen);
      const segMid = new THREE.Vector3().addVectors(segA, segB).multiplyScalar(0.5);

      const newFaces = [];
      const edgeSplitVerts = new Map(); // edgeKey -> split vertex index
      const edgeSplitsByPair = new Map(); // "${minV}_${maxV}" -> [{ vi, tFromMin }]

      const recordEdgeSplit = (u, v, t, vi) => {
        const minV = Math.min(u, v);
        const maxV = Math.max(u, v);
        const pk = `${minV}_${maxV}`;
        const tFromMin = u === minV ? t : 1 - t;
        if (!edgeSplitsByPair.has(pk)) edgeSplitsByPair.set(pk, []);
        const list = edgeSplitsByPair.get(pk);
        if (!list.some(item => item.vi === vi)) {
          list.push({ vi, tFromMin });
        }
      };

      const getOrSplitEdge = (u, v, t, uvA, uvB) => {
        const clampedT = Math.max(0.0, Math.min(1.0, t));
        if (clampedT <= 1e-4) return { vi: u, uv: uvA ? uvA.clone() : null };
        if (clampedT >= 1.0 - 1e-4) return { vi: v, uv: uvB ? uvB.clone() : null };

        const minV = Math.min(u, v);
        const maxV = Math.max(u, v);
        const key = `${minV}_${maxV}_${Math.round((u === minV ? clampedT : 1 - clampedT) * 1000)}`;
        if (edgeSplitVerts.has(key)) {
          const idx = edgeSplitVerts.get(key);
          recordEdgeSplit(u, v, clampedT, idx);
          const uv = (uvA && uvB) ? new THREE.Vector2().lerpVectors(uvA, uvB, clampedT) : (uvA || uvB ? (uvA || uvB).clone() : null);
          return { vi: idx, uv };
        }
        const pos = new THREE.Vector3().lerpVectors(this.vertices[u], this.vertices[v], clampedT);
        const newIdx = this.vertices.length;
        this.vertices.push(pos);
        const vertUV = (this.vertexUVs[u] && this.vertexUVs[v])
          ? new THREE.Vector2().lerpVectors(this.vertexUVs[u], this.vertexUVs[v], clampedT)
          : (this.vertexUVs[u] || this.vertexUVs[v] || null);
        this.vertexUVs.push(vertUV ? vertUV.clone() : null);
        edgeSplitVerts.set(key, newIdx);
        recordEdgeSplit(u, v, clampedT, newIdx);
        const uv = (uvA && uvB) ? new THREE.Vector2().lerpVectors(uvA, uvB, clampedT) : (vertUV ? vertUV.clone() : null);
        return { vi: newIdx, uv };
      };

      for (const f of this.faces) {
        const vs = f.verts;
        if (!vs || vs.length < 3) continue;

        // Cutting plane perpendicular to (segDir x faceNormal) passing through segA
        const cutPlaneNormal = new THREE.Vector3().crossVectors(segDir, f.normal);
        if (cutPlaneNormal.lengthSq() < 1e-8) {
          newFaces.push(f);
          continue;
        }
        cutPlaneNormal.normalize();

        // Quick bounding/proximity reject: face must overlap segment span along segDir
        const distCentroid = Math.abs(f.centroid.clone().sub(segA).dot(f.normal));
        let minProj = Infinity, maxProj = -Infinity;
        let maxR = 0;
        for (const vi of vs) {
          const rel = this.vertices[vi].clone().sub(segA);
          const p = rel.dot(segDir);
          if (p < minProj) minProj = p;
          if (p > maxProj) maxProj = p;
          maxR = Math.max(maxR, this.vertices[vi].distanceTo(f.centroid));
        }
        if (distCentroid > maxR + 0.5 || maxProj < -0.05 || minProj > segLen + 0.05) {
          newFaces.push(f);
          continue;
        }

        // Signed distances of face corners to cut plane
        const signed = vs.map(vi => this.vertices[vi].clone().sub(segA).dot(cutPlaneNormal));
        const eps = 1e-5;
        const posCount = signed.filter(d => d > eps).length;
        const negCount = signed.filter(d => d < -eps).length;

        if (posCount === 0 || negCount === 0) {
          newFaces.push(f);
          continue;
        }

        // Check that the cut crosses near the finite segment [segA, segB]
        const hits = [];
        for (let k = 0; k < vs.length; k++) {
          const next = (k + 1) % vs.length;
          const d0 = signed[k];
          const d1 = signed[next];
          if ((d0 > eps && d1 < -eps) || (d0 < -eps && d1 > eps)) {
            const t = d0 / (d0 - d1);
            const pt = new THREE.Vector3().lerpVectors(this.vertices[vs[k]], this.vertices[vs[next]], t);
            const along = pt.clone().sub(segA).dot(segDir);
            hits.push({ edgeIdx: k, t, along });
          }
        }

        const withinSpan = hits.some(h => h.along >= -0.05 && h.along <= segLen + 0.05) ||
          segMid.distanceTo(f.centroid) <= maxR + segLen * 0.5;
        if (hits.length < 2 || !withinSpan) {
          newFaces.push(f);
          continue;
        }

        // Split polygon loop along signed plane into front (>=0) and back (<=0) faces
        const sideA = [];
        const uvA = [];
        const sideB = [];
        const uvB = [];

        for (let k = 0; k < vs.length; k++) {
          const next = (k + 1) % vs.length;
          const vCur = vs[k];
          const vNext = vs[next];
          const d0 = signed[k];
          const d1 = signed[next];
          const cUV = this._cornerUV(f, k);
          const nUV = this._cornerUV(f, next);

          if (d0 >= -eps) {
            sideA.push(vCur);
            uvA.push(cUV ? cUV.clone() : null);
          }
          if (d0 <= eps) {
            sideB.push(vCur);
            uvB.push(cUV ? cUV.clone() : null);
          }

          if ((d0 > eps && d1 < -eps) || (d0 < -eps && d1 > eps)) {
            const t = d0 / (d0 - d1);
            const split = getOrSplitEdge(vCur, vNext, t, cUV, nUV);
            sideA.push(split.vi);
            uvA.push(split.uv ? split.uv.clone() : null);
            sideB.push(split.vi);
            uvB.push(split.uv ? split.uv.clone() : null);
          }
        }

        const dedupeLoop = (arrV, arrUV) => {
          const outV = [], outUV = [];
          for (let i = 0; i < arrV.length; i++) {
            const prev = outV[outV.length - 1];
            if (arrV[i] !== prev) {
              outV.push(arrV[i]);
              outUV.push(arrUV[i]);
            }
          }
          if (outV.length > 1 && outV[0] === outV[outV.length - 1]) {
            outV.pop();
            outUV.pop();
          }
          return { outV, outUV };
        };

        const loopA = dedupeLoop(sideA, uvA);
        const loopB = dedupeLoop(sideB, uvB);

        if (loopA.outV.length >= 3 && loopB.outV.length >= 3) {
          newFaces.push(this._createFaceRecord(newFaces.length, loopA.outV, loopA.outUV.some(Boolean) ? loopA.outUV : null));
          newFaces.push(this._createFaceRecord(newFaces.length, loopB.outV, loopB.outUV.some(Boolean) ? loopB.outUV : null));
          totalSplits++;
        } else {
          newFaces.push(f);
        }
      }

      // Splice any split edge vertices into adjacent un-cut faces so the cut
      // never leaves T-junction cracks along shared edges.
      if (edgeSplitsByPair.size > 0 && newFaces.length > 0) {
        for (let fi = 0; fi < newFaces.length; fi++) {
          const nf = newFaces[fi];
          const nvs = nf.verts;
          if (!nvs || nvs.length < 3) continue;
          const present = new Set(nvs);
          let modified = false;
          const splicedVerts = [];
          const splicedUVs = [];
          for (let k = 0; k < nvs.length; k++) {
            const u = nvs[k];
            const v = nvs[(k + 1) % nvs.length];
            const cUV = this._cornerUV(nf, k);
            const nUV = this._cornerUV(nf, (k + 1) % nvs.length);
            splicedVerts.push(u);
            splicedUVs.push(cUV ? cUV.clone() : null);

            const pk = `${Math.min(u, v)}_${Math.max(u, v)}`;
            const splits = edgeSplitsByPair.get(pk);
            if (!splits || splits.length === 0) continue;

            const ordered = splits
              .filter(sp => !present.has(sp.vi))
              .map(sp => ({ vi: sp.vi, t: u < v ? sp.tFromMin : 1 - sp.tFromMin }))
              .sort((a, b) => a.t - b.t);

            for (const sp of ordered) {
              splicedVerts.push(sp.vi);
              present.add(sp.vi);
              if (cUV && nUV) {
                splicedUVs.push(new THREE.Vector2().lerpVectors(cUV, nUV, sp.t));
              } else {
                const fallbackUV = this.vertexUVs[sp.vi];
                splicedUVs.push(fallbackUV ? fallbackUV.clone() : null);
              }
              modified = true;
            }
          }
          if (modified && splicedVerts.length >= 3) {
            newFaces[fi] = this._createFaceRecord(fi, splicedVerts, splicedUVs.some(Boolean) ? splicedUVs : null);
          }
        }
      }

      if (newFaces.length > 0) {
        this.faces = newFaces.map((nf, idx) => ({ ...nf, id: idx }));
      }
    }

    if (totalSplits > 0) {
      this._commitMeshEdit(oldGeom, 'Knife Cut', true, oldSnap);
      console.log(`[EditMode] Knife cut split ${totalSplits} face(s).`);
      return true;
    }
    return false;
  }

  /**
   * Interactive viewport Knife Cut mode (K key).
   */
  startKnifeMode() {
    if (!this.isActive || !this.targetMesh || !this.engine?.domElement) return false;
    if (this._knifeSession) return true;

    const host = document.getElementById('viewport-canvas-host') || this.engine.domElement.parentElement;
    if (!host) return false;

    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'blender-knife-svg');
    const polyline = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
    polyline.setAttribute('fill', 'none');
    polyline.setAttribute('stroke', '#2ecc71');
    polyline.setAttribute('stroke-width', '2');
    const previewLine = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    previewLine.setAttribute('stroke', '#ff9f43');
    previewLine.setAttribute('stroke-width', '1.5');
    previewLine.setAttribute('stroke-dasharray', '4 3');
    previewLine.style.display = 'none';
    svg.appendChild(polyline);
    svg.appendChild(previewLine);

    const hud = document.createElement('div');
    hud.className = 'blender-knife-hud';
    hud.innerHTML = '<b>Knife Cut (K)</b> · Click cut points on mesh · <span style="color:#2ecc71">[Enter/Space]</span> Cut · <span style="color:#e74c3c">[Esc/RMB]</span> Cancel';

    host.appendChild(svg);
    host.appendChild(hud);

    const points = [];
    const screenPts = [];
    const invMat = this.targetMesh.matrixWorld.clone().invert();
    const prevControlsEnabled = this.engine.controls ? this.engine.controls.enabled : true;

    const vpCtxFor = (clientX, clientY) => this.engine.getViewportContextAtPoint
      ? this.engine.getViewportContextAtPoint(clientX, clientY)
      : {
          rect: this.engine.getViewportRect ? this.engine.getViewportRect() : this.engine.domElement.getBoundingClientRect(),
          camera: this.engine.camera
        };

    const projectLocal = (localPt) => {
      const last = screenPts.length > 0 ? screenPts[screenPts.length - 1] : null;
      const vpCtx = vpCtxFor(last?.x ?? NaN, last?.y ?? NaN);
      const vpRect = vpCtx.rect;
      const cam = vpCtx.camera || this.engine.camera;
      const hostRect = host.getBoundingClientRect();
      const worldPt = localPt.clone().applyMatrix4(this.targetMesh.matrixWorld);
      const ndc = worldPt.project(cam);
      return {
        x: (vpRect.left - hostRect.left) + ((ndc.x + 1) * 0.5) * vpRect.width,
        y: (vpRect.top - hostRect.top) + ((-ndc.y + 1) * 0.5) * vpRect.height
      };
    };

    const raycastLocal = (clientX, clientY) => {
      const vpCtx = vpCtxFor(clientX, clientY);
      const rect = vpCtx.rect;
      const cam = vpCtx.camera || this.engine.camera;
      this.pointer.x = ((clientX - rect.left) / (rect.width || 1)) * 2 - 1;
      this.pointer.y = -((clientY - rect.top) / (rect.height || 1)) * 2 + 1;
      this.raycaster.setFromCamera(this.pointer, cam);
      ensureBVH(this.targetMesh);
      const hits = this.raycaster.intersectObject(this.targetMesh, false);
      if (hits.length > 0) {
        return hits[0].point.clone().applyMatrix4(invMat);
      }
      return null;
    };

    const redraw = (hoverEvent = null) => {
      const coords = points.map(p => projectLocal(p));
      polyline.setAttribute('points', coords.map(c => `${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(' '));
      if (hoverEvent && coords.length > 0) {
        const rect = host.getBoundingClientRect();
        const last = coords[coords.length - 1];
        previewLine.setAttribute('x1', last.x.toFixed(1));
        previewLine.setAttribute('y1', last.y.toFixed(1));
        previewLine.setAttribute('x2', (hoverEvent.clientX - rect.left).toFixed(1));
        previewLine.setAttribute('y2', (hoverEvent.clientY - rect.top).toFixed(1));
        previewLine.style.display = 'block';
      } else {
        previewLine.style.display = 'none';
      }
    };

    const onDown = (e) => {
      if (!this._knifeSession) return;
      if (e.button === 0) {
        e.preventDefault();
        e.stopPropagation();
        const localPt = raycastLocal(e.clientX, e.clientY);
        if (localPt) {
          points.push(localPt);
          screenPts.push({ x: e.clientX, y: e.clientY });
          redraw(e);
        }
      } else if (e.button === 2) {
        e.preventDefault();
        e.stopPropagation();
        this.cancelKnifeMode();
      }
    };
    const onMove = (e) => {
      if (this._knifeSession) redraw(e);
    };
    const onKey = (e) => {
      if (!this._knifeSession) return;
      if (e.key === 'Enter' || e.code === 'Space') {
        e.preventDefault();
        e.stopPropagation();
        this.commitKnifeMode();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        this.cancelKnifeMode();
      }
    };

    const dom = this.engine.domElement;
    dom.addEventListener('pointerdown', onDown, true);
    window.addEventListener('pointermove', onMove, false);
    window.addEventListener('keydown', onKey, true);

    this._knifeSession = {
      points,
      cleanup: () => {
        dom.removeEventListener('pointerdown', onDown, true);
        window.removeEventListener('pointermove', onMove, false);
        window.removeEventListener('keydown', onKey, true);
        svg.remove();
        hud.remove();
        if (this.engine.controls) this.engine.controls.enabled = prevControlsEnabled;
        this._knifeSession = null;
      }
    };
    return true;
  }

  commitKnifeMode() {
    if (!this._knifeSession) return false;
    const pts = [...this._knifeSession.points];
    this._knifeSession.cleanup();
    if (pts.length >= 2) {
      return this.knife(pts);
    }
    return false;
  }

  cancelKnifeMode() {
    if (!this._knifeSession) return false;
    this._knifeSession.cleanup();
    return true;
  }

  /**
   * Blender F (Make Edge / Face) & J (Vertex Connect Path).
   * - 2 selected vertices: creates edge (or splits polygon face containing both vertices)
   * - 3+ selected vertices (or 2+ selected edges): fills a planar/boundary polygon face
   *   aligned with neighboring winding.
   * @returns {boolean}
   */
  fillOrMakeFace() {
    if (!this.isActive || !this.targetMesh) return false;

    const vertsSet = new Set();
    if (this.selectionMode === 'vertex') {
      for (const v of this.selectedVertices) vertsSet.add(v);
    } else if (this.selectionMode === 'edge') {
      for (const eIdx of this.selectedEdges) {
        const e = this.edges[eIdx];
        if (e) { vertsSet.add(e.v0); vertsSet.add(e.v1); }
      }
    } else if (this.selectionMode === 'face' && this.selectedFaces.size === 1) {
      this.pokeFaces();
      return true;
    } else if (this.selectionMode === 'face' && this.selectedFaces.size >= 2) {
      return this.dissolveSelection();
    } else {
      for (const v of this.getActiveVertexIndices()) vertsSet.add(v);
    }

    const selVerts = Array.from(vertsSet).filter(i => this.vertices[i]);
    if (selVerts.length < 2) {
      console.warn('[EditMode] Make Edge/Face (F) requires at least 2 vertices or edges selected.');
      return false;
    }

    const oldGeom = this.targetMesh.geometry.clone();
    const oldSnap = this._captureTopologySnapshot();

    // Case 1: 2 vertices -> Make Edge OR split shared polygon face
    if (selVerts.length === 2) {
      const [v0, v1] = selVerts;
      const key = `${Math.min(v0, v1)}_${Math.max(v0, v1)}`;
      if (!this.edgeMap.has(key)) {
        // Check if both vertices lie in the same N-gon/quad face as non-adjacent corners -> split face
        const hostFaceIdx = this.faces.findIndex(f => {
          const i0 = f.verts.indexOf(v0);
          const i1 = f.verts.indexOf(v1);
          if (i0 === -1 || i1 === -1) return false;
          const diff = Math.abs(i0 - i1);
          return diff > 1 && diff < f.verts.length - 1;
        });

        if (hostFaceIdx !== -1) {
          const f = this.faces[hostFaceIdx];
          let i0 = f.verts.indexOf(v0);
          let i1 = f.verts.indexOf(v1);
          if (i0 > i1) [i0, i1] = [i1, i0];
          const loop1 = f.verts.slice(i0, i1 + 1);
          const loop2 = [...f.verts.slice(i1), ...f.verts.slice(0, i0 + 1)];
          const uv1 = f.uvs ? loop1.map(vi => this._cornerUVForVertex(f, vi)) : null;
          const uv2 = f.uvs ? loop2.map(vi => this._cornerUVForVertex(f, vi)) : null;

          this.faces.splice(hostFaceIdx, 1,
            this._createFaceRecord(hostFaceIdx, loop1, uv1?.some(Boolean) ? uv1 : null),
            this._createFaceRecord(this.faces.length, loop2, uv2?.some(Boolean) ? uv2 : null)
          );
          this.faces = this.faces.map((face, idx) => ({ ...face, id: idx }));
          this._rebuildEdges();
          this.rebuildGeometry();
          this._commitMeshEdit(oldGeom, 'Connect Vertex Path', false, oldSnap);
          return true;
        }

        // Otherwise create standalone loose edge
        this.looseEdges.push([Math.min(v0, v1), Math.max(v0, v1)]);
        this._rebuildEdges();
        if (this.selectionMode === 'edge') {
          const created = this.edgeMap.get(key);
          this.selectedEdges.clear();
          if (created) this.selectedEdges.add(created.id);
        }
        this.rebuildGeometry();
        this._commitMeshEdit(oldGeom, 'Make Edge', false, oldSnap);
        return true;
      }
      return false;
    }

    // Case 2: 3+ vertices -> Order into a clean non-crossing closed polygon loop & build face
    const adj = new Map();
    for (const v of selVerts) adj.set(v, []);
    for (const e of this.edges) {
      if (vertsSet.has(e.v0) && vertsSet.has(e.v1)) {
        adj.get(e.v0).push(e.v1);
        adj.get(e.v1).push(e.v0);
      }
    }

    // Best-fit plane normal (Newell / PCA fallback) for non-self-intersecting angular ordering
    const centroid = new THREE.Vector3();
    for (const vi of selVerts) centroid.add(this.vertices[vi]);
    centroid.multiplyScalar(1 / selVerts.length);

    let ordered = [];
    // Walk chains along existing edges; if multiple chains (e.g. 2 opposite edges), bridge without bow-tie crossing
    const unvisited = new Set(selVerts);
    let cur = selVerts.find(v => adj.get(v).length === 1) ?? selVerts[0];
    while (unvisited.size > 0) {
      ordered.push(cur);
      unvisited.delete(cur);
      if (unvisited.size === 0) break;

      const nbrs = (adj.get(cur) || []).filter(n => unvisited.has(n));
      if (nbrs.length > 0) {
        cur = nbrs[0];
      } else {
        // Pick next endpoint preserving convex/non-crossing direction relative to mesh centroid & first vertex
        let bestNext = null;
        let bestDist = Infinity;
        for (const cand of unvisited) {
          const d = this.vertices[cur].distanceToSquared(this.vertices[cand]);
          if (d < bestDist) {
            bestDist = d;
            bestNext = cand;
          }
        }
        cur = bestNext;
      }
    }

    // Verify 4-vertex quad isn't a self-intersecting bowtie via triangle winding consistency
    if (ordered.length === 4) {
      const p = ordered.map(vi => this.vertices[vi]);
      const n012 = new THREE.Vector3().subVectors(p[1], p[0]).cross(new THREE.Vector3().subVectors(p[2], p[0]));
      const n023 = new THREE.Vector3().subVectors(p[2], p[0]).cross(new THREE.Vector3().subVectors(p[3], p[0]));
      if (n012.dot(n023) < 0) {
        // Swap last two vertices to untwist hourglass
        [ordered[2], ordered[3]] = [ordered[3], ordered[2]];
      }
    } else if (ordered.length >= 5 && adj.get(ordered[0]).length === 0) {
      // Pure loose points -> sort angularly around best plane normal
      const planeN = this._computeNewellNormal(ordered);
      const tU = new THREE.Vector3().subVectors(this.vertices[ordered[0]], centroid).normalize();
      if (tU.lengthSq() < 1e-6) tU.set(1, 0, 0);
      const tV = new THREE.Vector3().crossVectors(planeN, tU).normalize();
      ordered.sort((a, b) => {
        const da = new THREE.Vector3().subVectors(this.vertices[a], centroid);
        const db = new THREE.Vector3().subVectors(this.vertices[b], centroid);
        return Math.atan2(da.dot(tV), da.dot(tU)) - Math.atan2(db.dot(tV), db.dot(tU));
      });
    }

    // Check if an identical face already exists
    const sortedNewKey = [...ordered].sort((a, b) => a - b).join('_');
    if (this.faces.some(f => [...f.verts].sort((a, b) => a - b).join('_') === sortedNewKey)) {
      return false;
    }

    // Align face winding with adjacent existing faces (opposite direction across shared edge)
    let shouldReverse = false;
    let foundNeighborWinding = false;
    for (let k = 0; k < ordered.length && !foundNeighborWinding; k++) {
      const u = ordered[k];
      const v = ordered[(k + 1) % ordered.length];
      const edge = this.edgeMap.get(`${Math.min(u, v)}_${Math.max(u, v)}`);
      if (edge && edge.faces.length > 0) {
        const adjFace = this.faces[edge.faces[0]];
        if (adjFace) {
          for (let j = 0; j < adjFace.verts.length; j++) {
            const au = adjFace.verts[j];
            const av = adjFace.verts[(j + 1) % adjFace.verts.length];
            if (au === u && av === v) {
              shouldReverse = true;
              foundNeighborWinding = true;
              break;
            }
            if (au === v && av === u) {
              shouldReverse = false;
              foundNeighborWinding = true;
              break;
            }
          }
        }
      }
    }
    if (!foundNeighborWinding) {
      const n = this._computeNewellNormal(ordered);
      const meshCenter = new THREE.Vector3();
      for (const v of this.vertices) meshCenter.add(v);
      meshCenter.multiplyScalar(1 / Math.max(1, this.vertices.length));
      const outward = centroid.clone().sub(meshCenter);
      if (outward.lengthSq() > 1e-6 && n.dot(outward) < 0) shouldReverse = true;
    }
    if (shouldReverse) ordered.reverse();

    const newFace = this._createFaceRecord(this.faces.length, ordered);
    this.faces.push(newFace);
    this._rebuildEdges();
    if (this.selectionMode === 'face') {
      this.selectedFaces.clear();
      this.selectedFaces.add(newFace.id);
    }
    this.rebuildGeometry();
    this._commitMeshEdit(oldGeom, 'Make Face', false, oldSnap);
    console.log(`[EditMode] Make Face (F): created ${ordered.length}-gon face.`);
    return true;
  }

  /**
   * Shared manifold edge-dissolve helper: merges faceA and faceB along edge (u, v).
   */
  _mergeFacesAlongSharedEdge(faceA, faceB, u, v) {
    if (!faceA || !faceB || faceA === faceB) return null;
    const va = faceA.verts;
    const vb = [...faceB.verts];

    const idxAU = va.indexOf(u);
    const idxAV = va.indexOf(v);
    if (idxAU === -1 || idxAV === -1) return null;

    // Orient faceA order so u -> v is adjacent step in va
    const aForward = va[(idxAU + 1) % va.length] === v;
    const startA = aForward ? u : v;
    const endA = aForward ? v : u;

    const iStartA = va.indexOf(startA);
    // For manifold consistency, faceB should contain endA -> startA; if same direction, reverse vb
    const iEndB = vb.indexOf(endA);
    const iStartB = vb.indexOf(startA);
    if (iEndB === -1 || iStartB === -1) return null;
    if (vb[(iEndB + 1) % vb.length] !== startA) {
      if (vb[(iStartB + 1) % vb.length] === endA) {
        vb.reverse();
      } else {
        return null;
      }
    }

    const merged = [];
    const mergedUV = [];
    // Walk faceA starting at endA -> ... -> startA (skipping edge interior duplicate)
    let curA = (va.indexOf(startA) + 1) % va.length; // endA
    for (let step = 0; step < va.length - 1; step++) {
      const idx = (curA + step) % va.length;
      const vert = va[idx];
      merged.push(vert);
      mergedUV.push(this._cornerUV(faceA, idx));
    }
    // Walk faceB starting after startA up to before endA
    const bStartIdx = vb.indexOf(startA);
    for (let step = 0; step < vb.length - 1; step++) {
      const idx = (bStartIdx + step) % vb.length;
      const vert = vb[idx];
      merged.push(vert);
      mergedUV.push(this._cornerUVForVertex(faceB, vert));
    }

    // Deduplicate adjacent identical indices
    const cleanV = [];
    const cleanUV = [];
    for (let i = 0; i < merged.length; i++) {
      const prev = cleanV[cleanV.length - 1];
      if (merged[i] !== prev) {
        cleanV.push(merged[i]);
        cleanUV.push(mergedUV[i]);
      }
    }
    if (cleanV.length > 1 && cleanV[0] === cleanV[cleanV.length - 1]) {
      cleanV.pop();
      cleanUV.pop();
    }
    if (new Set(cleanV).size < 3) return null;

    return this._createFaceRecord(faceA.id, cleanV, cleanUV.some(Boolean) ? cleanUV : null);
  }

  /**
   * Dissolve selected edges, vertices, or faces without leaving holes (Blender Ctrl+X).
   * @returns {boolean}
   */
  dissolveSelection() {
    if (!this.isActive || !this.targetMesh) return false;
    const oldGeom = this.targetMesh.geometry.clone();
    const oldSnap = this._captureTopologySnapshot();
    let changed = false;
    const touchedVerts = new Set();

    const dissolveEdgePair = (u, v) => {
      const candidates = this.faces.filter(f => {
        const iu = f.verts.indexOf(u);
        const iv = f.verts.indexOf(v);
        if (iu === -1 || iv === -1) return false;
        const diff = Math.abs(iu - iv);
        return diff === 1 || diff === f.verts.length - 1;
      });
      if (candidates.length === 2) {
        const merged = this._mergeFacesAlongSharedEdge(candidates[0], candidates[1], u, v);
        if (merged) {
          const remaining = this.faces.filter(f => f !== candidates[0] && f !== candidates[1]);
          remaining.push(merged);
          this.faces = remaining.map((f, idx) => ({ ...f, id: idx }));
          touchedVerts.add(u);
          touchedVerts.add(v);
          changed = true;
          return true;
        }
      }
      return false;
    };

    if (this.selectionMode === 'edge' && this.selectedEdges.size > 0) {
      const edgeVertPairs = Array.from(this.selectedEdges)
        .map(id => this.edges[id])
        .filter(Boolean)
        .map(e => [e.v0, e.v1, e.faces.length]);

      for (const [u, v, faceCount] of edgeVertPairs) {
        if (faceCount === 0) {
          const prevLen = this.looseEdges.length;
          this.looseEdges = this.looseEdges.filter(([a, b]) => !(Math.min(a, b) === Math.min(u, v) && Math.max(a, b) === Math.max(u, v)));
          if (this.looseEdges.length !== prevLen) changed = true;
        } else {
          dissolveEdgePair(u, v);
        }
      }
    } else if (this.selectionMode === 'face' && this.selectedFaces.size >= 2) {
      const selFaceObjs = new Set(Array.from(this.selectedFaces).map(id => this.faces[id]).filter(Boolean));
      const internalEdges = [];
      for (const e of this.edges) {
        if (e.faces.length === 2 && selFaceObjs.has(this.faces[e.faces[0]]) && selFaceObjs.has(this.faces[e.faces[1]])) {
          internalEdges.push([e.v0, e.v1]);
        }
      }
      for (const [u, v] of internalEdges) {
        dissolveEdgePair(u, v);
      }
    } else if (this.selectionMode === 'vertex' && this.selectedVertices.size > 0) {
      for (const vi of Array.from(this.selectedVertices)) {
        // Merge incident faces around vertex vi until 1 face remains, then strip vi
        let guard = 0;
        while (guard++ < 32) {
          const incFaces = this.faces.filter(f => f.verts.includes(vi));
          if (incFaces.length < 2) break;
          let dissolvedOne = false;
          for (let i = 0; i < incFaces.length && !dissolvedOne; i++) {
            const f = incFaces[i];
            const pos = f.verts.indexOf(vi);
            const nbr = f.verts[(pos + 1) % f.verts.length];
            if (dissolveEdgePair(vi, nbr)) dissolvedOne = true;
          }
          if (!dissolvedOne) break;
        }
        for (let i = 0; i < this.faces.length; i++) {
          const f = this.faces[i];
          if (f.verts.includes(vi) && f.verts.length > 3) {
            const idx = f.verts.indexOf(vi);
            const newVs = f.verts.filter((_, k) => k !== idx);
            const newUVs = f.uvs ? f.uvs.filter((_, k) => k !== idx) : null;
            this.faces[i] = this._createFaceRecord(i, newVs, newUVs);
            changed = true;
          }
        }
        const looseInc = this.looseEdges.filter(([a, b]) => a === vi || b === vi);
        if (looseInc.length === 2) {
          const other0 = looseInc[0][0] === vi ? looseInc[0][1] : looseInc[0][0];
          const other1 = looseInc[1][0] === vi ? looseInc[1][1] : looseInc[1][0];
          this.looseEdges = this.looseEdges.filter(([a, b]) => a !== vi && b !== vi);
          if (other0 !== other1) this.looseEdges.push([Math.min(other0, other1), Math.max(other0, other1)]);
          changed = true;
        }
      }
    }

    // Post-pass: clean up degree-2 collinear loop vertices left across ALL surviving
    // incident faces (e.g., dissolving a full loop cut ring returns clean 4-corner quads).
    if (touchedVerts.size > 0) {
      let strippedAny = true;
      let pass = 0;
      while (strippedAny && pass++ < 16) {
        strippedAny = false;
        const vertNeighbors = new Map();
        for (const f of this.faces) {
          const vs = f.verts;
          for (let k = 0; k < vs.length; k++) {
            const a = vs[k];
            const b = vs[(k + 1) % vs.length];
            if (!vertNeighbors.has(a)) vertNeighbors.set(a, new Set());
            if (!vertNeighbors.has(b)) vertNeighbors.set(b, new Set());
            vertNeighbors.get(a).add(b);
            vertNeighbors.get(b).add(a);
          }
        }
        for (const vi of touchedVerts) {
          if (this.looseEdges.some(([a, b]) => a === vi || b === vi)) continue;
          const nbrSet = vertNeighbors.get(vi);
          if (!nbrSet || nbrSet.size !== 2) continue;
          const [nbA, nbB] = Array.from(nbrSet);
          const pV = this.vertices[vi];
          const pA = this.vertices[nbA];
          const pB = this.vertices[nbB];
          if (!pV || !pA || !pB) continue;
          const d0 = new THREE.Vector3().subVectors(pV, pA);
          const d1 = new THREE.Vector3().subVectors(pB, pV);
          if (d0.lengthSq() < 1e-10 || d1.lengthSq() < 1e-10) continue;
          if (d0.normalize().dot(d1.normalize()) <= 0.999) continue;

          const incFaces = this.faces.filter(f => f.verts.includes(vi));
          if (incFaces.length === 0 || incFaces.some(f => f.verts.length <= 3)) continue;

          for (let i = 0; i < this.faces.length; i++) {
            const f = this.faces[i];
            if (!f.verts.includes(vi)) continue;
            const pos = f.verts.indexOf(vi);
            const newVs = f.verts.filter((_, k) => k !== pos);
            const newUVs = f.uvs ? f.uvs.filter((_, k) => k !== pos) : null;
            this.faces[i] = this._createFaceRecord(i, newVs, newUVs);
          }
          touchedVerts.delete(vi);
          strippedAny = true;
          changed = true;
          break;
        }
      }
    }

    if (!changed) return false;

    this.selectedVertices.clear();
    this.selectedEdges.clear();
    this.selectedFaces.clear();
    this._pruneOrphanVertices();
    this._commitMeshEdit(oldGeom, 'Dissolve Selection', true, oldSnap);
    console.log('[EditMode] Dissolved selection cleanly.');
    return true;
  }

  /**
   * Bridge two selected edge chains / loops with quad strips.
   * @returns {boolean}
   */
  bridgeEdgeLoops() {
    if (!this.isActive || !this.targetMesh) return false;
    const selEdges = Array.from(this.selectedEdges).map(id => this.edges[id]).filter(Boolean);
    if (selEdges.length < 2) {
      console.warn('[EditMode] Bridge Edge Loops requires at least 2 selected edges.');
      return false;
    }

    // Connected components of selected edges
    const vertAdj = new Map();
    for (const e of selEdges) {
      if (!vertAdj.has(e.v0)) vertAdj.set(e.v0, []);
      if (!vertAdj.has(e.v1)) vertAdj.set(e.v1, []);
      vertAdj.get(e.v0).push(e.v1);
      vertAdj.get(e.v1).push(e.v0);
    }

    const visitedVerts = new Set();
    const chains = [];
    for (const e of selEdges) {
      for (const startSeed of [e.v0, e.v1]) {
        if (visitedVerts.has(startSeed)) continue;
        // Gather component vertices
        const comp = [];
        const stack = [startSeed];
        const compSet = new Set([startSeed]);
        while (stack.length > 0) {
          const v = stack.pop();
          if (visitedVerts.has(v)) continue;
          visitedVerts.add(v);
          comp.push(v);
          for (const n of vertAdj.get(v) || []) {
            if (!compSet.has(n)) { compSet.add(n); stack.push(n); }
          }
        }
        // Order chain from degree-1 start if open
        const endpoint = comp.find(v => (vertAdj.get(v) || []).length === 1) ?? comp[0];
        const ordered = [];
        const seen = new Set();
        let cur = endpoint;
        while (cur !== undefined) {
          ordered.push(cur);
          seen.add(cur);
          const next = (vertAdj.get(cur) || []).find(n => !seen.has(n));
          cur = next;
        }
        const isClosed = ordered.length >= 3 && (vertAdj.get(ordered[ordered.length - 1]) || []).includes(ordered[0]);
        chains.push({ verts: ordered, isClosed });
      }
    }

    if (chains.length !== 2) {
      console.warn(`[EditMode] Bridge requires exactly 2 separate edge chains/loops (found ${chains.length}).`);
      return false;
    }

    const [chainA, chainB] = chains;
    const oldGeom = this.targetMesh.geometry.clone();
    const oldSnap = this._captureTopologySnapshot();

    // Align chainB orientation to minimize total twist distance to chainA
    const bFwd = [...chainB.verts];
    const bRev = [...chainB.verts].reverse();
    const scoreOrder = (listB) => {
      const m = Math.min(chainA.verts.length, listB.length);
      let s = 0;
      for (let i = 0; i < m; i++) {
        s += this.vertices[chainA.verts[i]].distanceTo(this.vertices[listB[i]]);
      }
      return s;
    };
    const alignedB = scoreOrder(bRev) < scoreOrder(bFwd) ? bRev : bFwd;

    const segCountA = chainA.isClosed ? chainA.verts.length : chainA.verts.length - 1;
    const segCountB = chainB.isClosed ? alignedB.length : alignedB.length - 1;
    const steps = Math.min(segCountA, segCountB);
    if (steps < 1) return false;

    for (let i = 0; i < steps; i++) {
      const a0 = chainA.verts[i % chainA.verts.length];
      const a1 = chainA.verts[(i + 1) % chainA.verts.length];
      const b0 = alignedB[i % alignedB.length];
      const b1 = alignedB[(i + 1) % alignedB.length];
      if (new Set([a0, a1, b1, b0]).size < 3) continue;
      this.faces.push(this._createFaceRecord(this.faces.length, [a0, a1, b1, b0]));
    }

    this._commitMeshEdit(oldGeom, 'Bridge Edge Loops', true, oldSnap);
    console.log(`[EditMode] Bridged 2 edge loops with ${steps} quad(s).`);
    return true;
  }

  /**
   * Blender P: Separate selected faces (or faces spanned by selected verts/edges)
   * into a standalone new THREE.Mesh object in the scene.
   * @returns {THREE.Mesh|null}
   */
  separateSelection() {
    if (!this.isActive || !this.targetMesh || !this.sceneManager) return null;

    let targetFaces = new Set();
    if (this.selectionMode === 'face') {
      targetFaces = new Set(this.selectedFaces);
    } else {
      const activeSet = new Set(this.getActiveVertexIndices());
      for (const f of this.faces) {
        if (f.verts.every(v => activeSet.has(v))) targetFaces.add(f.id);
      }
    }

    if (targetFaces.size === 0 || targetFaces.size >= this.faces.length) {
      console.warn('[EditMode] Separate (P) needs a non-empty strict subset of faces selected.');
      return null;
    }

    const oldGeom = this.targetMesh.geometry.clone();
    const oldSnap = this._captureTopologySnapshot();
    const outPositions = [];
    const outUVs = [];
    let hasUV = false;

    for (const fIdx of targetFaces) {
      const f = this.faces[fIdx];
      if (!f) continue;
      if (f.uvs && f.uvs.some(Boolean)) hasUV = true;
    }

    for (const fIdx of targetFaces) {
      const f = this.faces[fIdx];
      if (!f) continue;
      const vs = f.verts;
      for (let k = 1; k < vs.length - 1; k++) {
        for (const c of [0, k, k + 1]) {
          const p = this.vertices[vs[c]];
          outPositions.push(p.x, p.y, p.z);
          if (hasUV) {
            const uv = this._cornerUV(f, c) || new THREE.Vector2(0, 0);
            outUVs.push(uv.x, uv.y);
          }
        }
      }
    }

    const sepGeom = new THREE.BufferGeometry();
    sepGeom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(outPositions), 3));
    if (hasUV) sepGeom.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(outUVs), 2));
    sepGeom.computeVertexNormals();
    sepGeom.computeBoundingBox();
    sepGeom.computeBoundingSphere();

    const mat = Array.isArray(this.targetMesh.material)
      ? this.targetMesh.material.map(m => m.clone())
      : (this.targetMesh.material ? this.targetMesh.material.clone() : new THREE.MeshStandardMaterial({ color: 0xcccccc }));
    const sepMesh = new THREE.Mesh(sepGeom, mat);
    sepMesh.name = `${this.targetMesh.name || 'Mesh'}_Part`;
    sepMesh.position.copy(this.targetMesh.position);
    sepMesh.quaternion.copy(this.targetMesh.quaternion);
    sepMesh.scale.copy(this.targetMesh.scale);
    sepMesh.castShadow = this.targetMesh.castShadow;
    sepMesh.receiveShadow = this.targetMesh.receiveShadow;

    // Remove separated faces from source mesh and commit Edit + Add commands
    this.faces = this.faces.filter(f => !targetFaces.has(f.id)).map((f, idx) => ({ ...f, id: idx }));
    this.selectedVertices.clear();
    this.selectedEdges.clear();
    this.selectedFaces.clear();
    this._pruneOrphanVertices();
    this._commitMeshEdit(oldGeom, 'Separate Source Mesh', true, oldSnap);

    this.sceneManager.addObject(sepMesh, null, false, true);
    console.log(`[EditMode] Separated ${targetFaces.size} face(s) into "${sepMesh.name}".`);
    return sepMesh;
  }

  // =========================================================================
  // UV SEAMS & BLENDER UNWRAPPING OPERATORS
  // =========================================================================

  _applySeamFlagsToEdges() {
    for (const edge of this.edges) {
      const v0 = this.vertices[edge.v0];
      const v1 = this.vertices[edge.v1];
      edge.isSeam = Boolean(v0 && v1 && this.uvSeams.has(edgeSpatialKeyFromVectors(v0, v1)));
    }
  }

  _syncSeamKeysToGeometry(targetUserData = null) {
    if (this.edges.length > 0 && this.vertices.length > 0) {
      const next = new Set();
      for (const edge of this.edges) {
        if (!edge.isSeam) continue;
        const v0 = this.vertices[edge.v0];
        const v1 = this.vertices[edge.v1];
        if (v0 && v1) next.add(edgeSpatialKeyFromVectors(v0, v1));
      }
      this.uvSeams = next;
    }
    const ud = targetUserData || this.targetMesh?.geometry?.userData;
    if (ud) {
      if (this.uvSeams.size > 0) ud._uvSeams = Array.from(this.uvSeams);
      else delete ud._uvSeams;
    }
  }

  _getSelectedEdgeIndices() {
    const out = new Set();
    if (this.selectionMode === 'edge') {
      for (const eid of this.selectedEdges) {
        if (this.edges[eid]) out.add(eid);
      }
      return out;
    }
    if (this.selectionMode === 'vertex') {
      for (const edge of this.edges) {
        if (this.selectedVertices.has(edge.v0) && this.selectedVertices.has(edge.v1)) {
          out.add(edge.id);
        }
      }
      return out;
    }
    if (this.selectionMode === 'face') {
      // Mark boundary edges around selected face region (Blender behavior)
      const countMap = new Map();
      for (const fid of this.selectedFaces) {
        const f = this.faces[fid];
        if (!f) continue;
        for (let k = 0; k < f.verts.length; k++) {
          const u = f.verts[k];
          const v = f.verts[(k + 1) % f.verts.length];
          const key = u < v ? `${u}_${v}` : `${v}_${u}`;
          countMap.set(key, (countMap.get(key) || 0) + 1);
        }
      }
      for (const [key, cnt] of countMap.entries()) {
        if (cnt === 1 && this.edgeMap.has(key)) {
          out.add(this.edgeMap.get(key).id);
        }
      }
      if (out.size === 0) {
        for (const [key] of countMap.entries()) {
          if (this.edgeMap.has(key)) out.add(this.edgeMap.get(key).id);
        }
      }
    }
    return out;
  }

  /**
   * Mark or clear UV Seams on selected edges (or selection boundary).
   */
  markSeam(clear = false) {
    if (!this.isActive || !this.targetMesh?.geometry) return false;
    const edgeIndices = this._getSelectedEdgeIndices();
    if (edgeIndices.size === 0) return false;

    const oldGeom = cloneGeometrySnapshot(this.targetMesh.geometry);
    for (const eid of edgeIndices) {
      const edge = this.edges[eid];
      if (!edge) continue;
      edge.isSeam = !clear;
    }
    this._syncSeamKeysToGeometry(this.targetMesh.geometry.userData);
    this._commitMeshEdit(oldGeom, clear ? 'Clear UV Seam' : 'Mark UV Seam', false);
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('blender:uvSeamsChanged', { detail: { mesh: this.targetMesh, count: this.uvSeams.size } }));
    }
    if (this.liveUnwrap) {
      this.unwrap('lscm');
    }
    return true;
  }

  clearSeam() {
    return this.markSeam(true);
  }

  selectSeams() {
    if (!this.isActive) return 0;
    this.setMode('edge');
    this.selectedEdges.clear();
    for (const edge of this.edges) {
      if (edge.isSeam) this.selectedEdges.add(edge.id);
    }
    this.updateVisuals();
    this.updateGizmoProxy();
    return this.selectedEdges.size;
  }

  _selectSingleIndex(mode, set, index, listLen) {
    if (!this.isActive) return false;
    this.setMode(mode);
    set.clear();
    if (Number.isInteger(index) && index >= 0 && index < listLen) {
      set.add(index);
    }
    this.updateVisuals();
    this.updateGizmoProxy();
    return set.size > 0;
  }

  selectVertex(index = 0) {
    return this._selectSingleIndex('vertex', this.selectedVertices, index, this.vertices.length);
  }

  selectEdge(index = 0) {
    return this._selectSingleIndex('edge', this.selectedEdges, index, this.edges.length);
  }

  selectFace(index = 0) {
    return this._selectSingleIndex('face', this.selectedFaces, index, this.faces.length);
  }

  /**
   * Executes Blender-standard UV Unwrap / Projection on the currently edited mesh.
   * @param {'lscm'|'smart'|'cube'|'cylinder'|'sphere'|'pack'|'average'|'reset'} method
   * @param {Object} [options]
   */
  unwrap(method = 'lscm', options = {}) {
    if (!this.isActive || !this.targetMesh?.geometry) return false;
    const oldGeom = cloneGeometrySnapshot(this.targetMesh.geometry);
    this._syncSeamKeysToGeometry(this.targetMesh.geometry.userData);
    const geom = this.targetMesh.geometry;
    const seamKeys = this.uvSeams;
    let pinnedMap = options.pinnedMap instanceof Map ? options.pinnedMap : null;
    if (!pinnedMap && geom.userData?._uvPinned && typeof geom.userData._uvPinned === 'object') {
      pinnedMap = new Map();
      for (const [k, uvPair] of Object.entries(geom.userData._uvPinned)) {
        if (Array.isArray(uvPair) && uvPair.length >= 2) {
          pinnedMap.set(k, [Number(uvPair[0]) || 0, Number(uvPair[1]) || 0]);
        }
      }
    }

    let rebuilt = null;
    if (method === 'pack') {
      if (!geom.attributes.uv) {
        rebuilt = unwrapMeshLSCM(geom, { seamKeys, pinnedMap, ...options });
      } else {
        packUVIslandsInPlace(geom, { margin: options.margin ?? 0.02, rotate: options.rotate !== false, averageScale: options.averageScale !== false });
        rebuilt = geom;
      }
    } else if (method === 'average') {
      if (geom.attributes.uv) averageIslandsScaleInPlace(geom);
      rebuilt = geom;
    } else if (method === 'smart') {
      rebuilt = smartUVProjectGeometry(geom, { seamKeys, ...options });
    } else if (method === 'cube') {
      rebuilt = cubeProjectGeometry(geom, { seamKeys, ...options });
    } else if (method === 'cylinder') {
      rebuilt = cylinderProjectGeometry(geom, { seamKeys, ...options });
    } else if (method === 'sphere') {
      rebuilt = sphereProjectGeometry(geom, { seamKeys, ...options });
    } else if (method === 'reset') {
      rebuilt = resetUVsGeometry(geom);
    } else {
      rebuilt = unwrapMeshLSCM(geom, { seamKeys, pinnedMap, ...options });
    }

    if (rebuilt && rebuilt !== geom) {
      applyUVGeometryUpdate(this.targetMesh, rebuilt);
    }
    this._syncSeamKeysToGeometry(this.targetMesh.geometry.userData);
    this._buildTopology(this.targetMesh);
    ensureBVH(this.targetMesh);
    this._commitMeshEdit(oldGeom, `UV ${method}`, false);
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('blender:uvProjected', { detail: { mesh: this.targetMesh, mode: method } }));
    }
    this.sceneManager?.requestRender?.();
    return true;
  }

  /**
   * Select More (Ctrl + Numpad+) / Select Less (Ctrl + Numpad-).
   */
  selectMore() {
    if (!this.isActive) return;
    if (this.selectionMode === 'vertex') {
      const next = new Set(this.selectedVertices);
      for (const e of this.edges) {
        if (this.selectedVertices.has(e.v0)) next.add(e.v1);
        if (this.selectedVertices.has(e.v1)) next.add(e.v0);
      }
      this.selectedVertices = next;
    } else if (this.selectionMode === 'edge') {
      const activeV = new Set();
      for (const eIdx of this.selectedEdges) {
        const e = this.edges[eIdx];
        if (e) { activeV.add(e.v0); activeV.add(e.v1); }
      }
      for (const e of this.edges) {
        if (activeV.has(e.v0) || activeV.has(e.v1)) this.selectedEdges.add(e.id);
      }
    } else if (this.selectionMode === 'face') {
      const activeV = new Set();
      for (const fIdx of this.selectedFaces) {
        const f = this.faces[fIdx];
        if (f) f.verts.forEach(v => activeV.add(v));
      }
      for (const f of this.faces) {
        if (f.verts.some(v => activeV.has(v))) this.selectedFaces.add(f.id);
      }
    }
    this.updateVisuals();
    this.updateGizmoProxy();
  }

  selectLess() {
    if (!this.isActive) return;
    if (this.selectionMode === 'vertex') {
      const drop = new Set();
      for (const e of this.edges) {
        if (this.selectedVertices.has(e.v0) && !this.selectedVertices.has(e.v1)) drop.add(e.v0);
        if (this.selectedVertices.has(e.v1) && !this.selectedVertices.has(e.v0)) drop.add(e.v1);
      }
      for (const v of drop) this.selectedVertices.delete(v);
    } else if (this.selectionMode === 'edge') {
      const dropVerts = new Set();
      for (const e of this.edges) {
        if (!this.selectedEdges.has(e.id)) { dropVerts.add(e.v0); dropVerts.add(e.v1); }
      }
      const next = new Set();
      for (const eIdx of this.selectedEdges) {
        const e = this.edges[eIdx];
        if (e && (!dropVerts.has(e.v0) || !dropVerts.has(e.v1))) next.add(eIdx);
      }
      this.selectedEdges = next;
    } else if (this.selectionMode === 'face') {
      const next = new Set(this.selectedFaces);
      for (const fIdx of this.selectedFaces) {
        const f = this.faces[fIdx];
        if (!f) continue;
        for (let k = 0; k < f.verts.length; k++) {
          const u = f.verts[k], v = f.verts[(k + 1) % f.verts.length];
          const edge = this.edgeMap.get(`${Math.min(u, v)}_${Math.max(u, v)}`);
          if (!edge || edge.faces.length < 2 || edge.faces.some(fid => !this.selectedFaces.has(fid))) {
            next.delete(fIdx);
            break;
          }
        }
      }
      this.selectedFaces = next;
    }
    this.updateVisuals();
    this.updateGizmoProxy();
  }

  /**
   * Blender Alt+Click Edge Loop (walks longitudinal quad chains through degree-4 vertices).
   */
  selectEdgeLoop(edgeIndex, extend = false) {
    if (edgeIndex === undefined || edgeIndex === null) {
      edgeIndex = this.selectedEdges.size > 0 ? this.selectedEdges.values().next().value : 0;
    }
    const startEdge = this.edges[edgeIndex];
    if (!startEdge) return [];

    const loopEdges = new Set(extend ? this.selectedEdges : []);
    loopEdges.add(edgeIndex);

    // Map vertex -> incident edges
    const vertToEdges = new Map();
    for (const e of this.edges) {
      if (!vertToEdges.has(e.v0)) vertToEdges.set(e.v0, []);
      if (!vertToEdges.has(e.v1)) vertToEdges.set(e.v1, []);
      vertToEdges.get(e.v0).push(e);
      vertToEdges.get(e.v1).push(e);
    }

    const walkFrom = (seedEdge, tipVert) => {
      let curEdge = seedEdge;
      let curVert = tipVert;
      let steps = 0;
      while (curEdge && steps++ < this.edges.length) {
        const incident = vertToEdges.get(curVert) || [];
        // In a clean quad vertex (valence 4), the opposite edge shares NO face with curEdge
        const curFaceSet = new Set(curEdge.faces);
        const opp = incident.filter(e => e.id !== curEdge.id && !e.faces.some(f => curFaceSet.has(f)));
        let nextEdge = opp.length === 1 ? opp[0] : null;
        if (!nextEdge && incident.length === 2) {
          nextEdge = incident.find(e => e.id !== curEdge.id) || null;
        }
        if (!nextEdge || loopEdges.has(nextEdge.id)) break;
        loopEdges.add(nextEdge.id);
        curVert = nextEdge.v0 === curVert ? nextEdge.v1 : nextEdge.v0;
        curEdge = nextEdge;
      }
    };

    walkFrom(startEdge, startEdge.v0);
    walkFrom(startEdge, startEdge.v1);

    this.selectedEdges = loopEdges;
    this.selectionMode = 'edge';
    this.updateVisuals();
    this.updateGizmoProxy();
    return Array.from(loopEdges);
  }

  /**
   * Blender Ctrl+Alt+Click Edge Ring (opposite parallel edges across quads).
   */
  selectRing(edgeIndex, extend = false) {
    const prev = extend ? new Set(this.selectedEdges) : new Set();
    const ring = this.selectLoop(edgeIndex);
    if (extend) {
      for (const eIdx of prev) this.selectedEdges.add(eIdx);
      this.updateVisuals();
      this.updateGizmoProxy();
    }
    return ring;
  }

  _pruneOrphanVertices() {
    const usedVerts = new Set();
    for (const f of this.faces) {
      if (f.verts) for (const v of f.verts) usedVerts.add(v);
      else { usedVerts.add(f.a); usedVerts.add(f.b); usedVerts.add(f.c); }
    }
    for (const [u, v] of this.looseEdges) {
      usedVerts.add(u);
      usedVerts.add(v);
    }

    const newVerts = [];
    const newUVs = [];
    const vertRemap = new Map();
    for (let i = 0; i < this.vertices.length; i++) {
      if (usedVerts.has(i)) {
        vertRemap.set(i, newVerts.length);
        newVerts.push(this.vertices[i]);
        newUVs.push(this.vertexUVs[i] || null);
      }
    }

    this.vertices = newVerts;
    this.vertexUVs = newUVs;
    this.faces = this.faces.map((f, newId) => {
      const remappedVs = f.verts ? f.verts.map(v => vertRemap.get(v)) : [vertRemap.get(f.a), vertRemap.get(f.b), vertRemap.get(f.c)];
      return {
        id: newId,
        verts: remappedVs,
        a: remappedVs[0],
        b: remappedVs[1],
        c: remappedVs[2],
        d: remappedVs.length > 3 ? remappedVs[3] : null,
        normal: f.normal,
        centroid: f.centroid,
        uvs: f.uvs ? f.uvs.map(uv => uv ? uv.clone() : null) : null
      };
    });
    this.looseEdges = this.looseEdges
      .map(([u, v]) => [vertRemap.get(u), vertRemap.get(v)])
      .filter(([u, v]) => u !== undefined && v !== undefined && u !== v);
  }

  /**
   * Deletes selected vertices, edges, or faces (or 'only_faces') and rebuilds geometry.
   * @param {'auto'|'only_faces'} [mode='auto']
   */
  deleteSelection(mode = 'auto') {
    if (!this.isActive || !this.targetMesh) return;

    const oldGeom = this.targetMesh.geometry.clone();
    const oldSnap = this._captureTopologySnapshot();
    let facesToRemove = new Set();
    let removedLoose = false;

    if (mode === 'only_faces') {
      if (this.selectionMode === 'face') {
        facesToRemove = new Set(this.selectedFaces);
      } else {
        const activeV = new Set(this.getActiveVertexIndices());
        for (const f of this.faces) {
          if (f.verts.every(v => activeV.has(v))) facesToRemove.add(f.id);
        }
      }
    } else if (this.selectionMode === 'face') {
      facesToRemove = new Set(this.selectedFaces);
    } else if (this.selectionMode === 'edge') {
      const selectedLooseKeys = new Set();
      for (const eIdx of this.selectedEdges) {
        const edge = this.edges[eIdx];
        if (!edge) continue;
        if (edge.faces.length === 0) selectedLooseKeys.add(edge.key);
        edge.faces.forEach(f => facesToRemove.add(f));
      }
      if (selectedLooseKeys.size > 0) {
        this.looseEdges = this.looseEdges.filter(([u, v]) => !selectedLooseKeys.has(`${Math.min(u, v)}_${Math.max(u, v)}`));
        removedLoose = true;
      }
    } else if (this.selectionMode === 'vertex') {
      const selVerts = this.selectedVertices;
      for (const f of this.faces) {
        if (f.verts && f.verts.some(v => selVerts.has(v))) {
          facesToRemove.add(f.id);
        } else if (selVerts.has(f.a) || selVerts.has(f.b) || selVerts.has(f.c)) {
          facesToRemove.add(f.id);
        }
      }
      const prevLoose = this.looseEdges.length;
      this.looseEdges = this.looseEdges.filter(([u, v]) => !selVerts.has(u) && !selVerts.has(v));
      if (this.looseEdges.length !== prevLoose) removedLoose = true;
    }

    if (facesToRemove.size === 0 && !removedLoose) return;

    const deletedFaces = [];
    if (mode === 'only_faces' && facesToRemove.size > 0) {
      for (const fId of facesToRemove) {
        if (this.faces[fId]) deletedFaces.push(this.faces[fId]);
      }
    }

    this.faces = this.faces.filter(f => !facesToRemove.has(f.id));

    // Preserve edges when deleting 'only_faces' by promoting non-surviving edges cleanly once
    if (mode === 'only_faces' && deletedFaces.length > 0) {
      const survivingEdgeKeys = new Set();
      for (const f of this.faces) {
        for (let k = 0; k < f.verts.length; k++) {
          const u = f.verts[k], v = f.verts[(k + 1) % f.verts.length];
          survivingEdgeKeys.add(`${Math.min(u, v)}_${Math.max(u, v)}`);
        }
      }
      const existingLooseKeys = new Set(this.looseEdges.map(([a, b]) => `${Math.min(a, b)}_${Math.max(a, b)}`));
      for (const f of deletedFaces) {
        for (let k = 0; k < f.verts.length; k++) {
          const u = f.verts[k], v = f.verts[(k + 1) % f.verts.length];
          const minV = Math.min(u, v), maxV = Math.max(u, v);
          const ek = `${minV}_${maxV}`;
          if (!survivingEdgeKeys.has(ek) && !existingLooseKeys.has(ek)) {
            this.looseEdges.push([minV, maxV]);
            existingLooseKeys.add(ek);
          }
        }
      }
    }

    this._pruneOrphanVertices();

    this.selectedVertices.clear();
    this.selectedEdges.clear();
    this.selectedFaces.clear();

    this._commitMeshEdit(oldGeom, 'Delete Geometry', true, oldSnap);
    console.log(`[EditMode] Deleted ${facesToRemove.size} face(s).`);
  }

  // =========================================================================
  // KEYBOARD SHORTCUTS IN EDIT MODE
  // =========================================================================

  /**
   * Dispatches keyboard events when Edit Mode is active
   * @param {KeyboardEvent} event
   * @returns {boolean} true if handled
   */
  handleKeyDown(event) {
    if (!this.isActive) return false;

    // Ignore if typing in text inputs
    const tag = document.activeElement ? document.activeElement.tagName.toLowerCase() : '';
    if (tag === 'input' || tag === 'textarea' || tag === 'select' || document.activeElement?.isContentEditable) {
      return false;
    }

    const key = event.key.toLowerCase();
    const isMod = event.ctrlKey || event.metaKey;
    const fromNumpad = typeof event.code === 'string' && event.code.startsWith('Numpad');

    // Edit Mode owns undo/redo so a scene-level undo can never delete the mesh
    // while the vertex/edge overlay stays on screen.
    if (isMod && key === 'z') {
      event.preventDefault();
      if (this.sceneManager) {
        if (event.shiftKey) this.sceneManager.redo();
        else this.sceneManager.undo();
      }
      return true;
    }
    if (isMod && key === 'y') {
      event.preventDefault();
      this.sceneManager?.redo();
      return true;
    }

    // Keep browser/OS combos working: only Ctrl+R/L/X and Ctrl+Numpad+/-
    // are Edit Mode shortcuts; Cmd+* and Ctrl+Shift+* are never swallowed.
    if (isMod) {
      const isCtrlPlusMinus = event.code === 'NumpadAdd' || event.code === 'NumpadSubtract' || key === '=' || key === '-';
      const allowedCtrl = event.ctrlKey && !event.metaKey && !event.shiftKey &&
        (key === 'r' || key === 'l' || key === 'x' || key === 'e' || isCtrlPlusMinus);
      if (!allowedCtrl) return false;
    }
    if (event.altKey) {
      // Blender Alt+P in Edit Mode -> Poke Faces
      if (!isMod && !event.shiftKey && key === 'p') {
        event.preventDefault();
        this.pokeFaces();
        return true;
      }
      return false;
    }
    // Plain Shift+<letter> is not an Edit Mode shortcut; Shift+D is duplicate.
    if (event.shiftKey && key !== 'd') return false;

    // Mode switching: 1, 2, 3 — number row only. Numpad 1/3/7 stays with the
    // camera presets in the engine (Blender behavior).
    if (key === '1' && !fromNumpad) {
      event.preventDefault();
      this.setMode('vertex');
      return true;
    }
    if (key === '2' && !fromNumpad) {
      event.preventDefault();
      this.setMode('edge');
      return true;
    }
    if (key === '3' && !fromNumpad) {
      event.preventDefault();
      this.setMode('face');
      return true;
    }

    // Select all / Deselect all: A (plain only — Shift+A is the Add menu)
    if (key === 'a' && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey) {
      event.preventDefault();
      this.toggleSelectAll();
      return true;
    }

    // Select More / Less: Ctrl+Numpad+ / Ctrl+Numpad- (and Ctrl+= / Ctrl+-)
    if (event.ctrlKey && (event.code === 'NumpadAdd' || key === '=')) {
      event.preventDefault();
      this.selectMore();
      return true;
    }
    if (event.ctrlKey && (event.code === 'NumpadSubtract' || key === '-')) {
      event.preventDefault();
      this.selectLess();
      return true;
    }

    // Dissolve Selection: Ctrl + X
    if (key === 'x' && event.ctrlKey) {
      event.preventDefault();
      this.dissolveSelection();
      return true;
    }

    // Loop Cut: Ctrl + R (interactive yellow ring preview when viewport present)
    if (key === 'r' && event.ctrlKey) {
      event.preventDefault();
      if (typeof document !== 'undefined' && this.engine?.domElement) {
        this.startLoopCutMode();
      } else {
        this.loopCut();
      }
      return true;
    }

    // Edge Menu: Ctrl + E
    if (key === 'e' && event.ctrlKey) {
      event.preventDefault();
      if (typeof window !== 'undefined' && window.blenderProTools?.openEditEdgeMenu) {
        window.blenderProTools.openEditEdgeMenu();
      } else {
        this.markSeam(false);
      }
      return true;
    }

    // UV Mapping Menu: U
    if (key === 'u' && !event.ctrlKey) {
      event.preventDefault();
      if (typeof window !== 'undefined' && window.blenderProTools?.openEditUVMenu) {
        window.blenderProTools.openEditUVMenu();
      } else {
        this.unwrap('lscm');
      }
      return true;
    }

    // Merge: M (At Center)
    if (key === 'm' && !event.ctrlKey) {
      event.preventDefault();
      this.merge('center');
      return true;
    }

    // Proportional Editing Toggle: O
    if (key === 'o' && !event.ctrlKey) {
      event.preventDefault();
      this.proportional = !this.proportional;
      console.log(`[EditMode] Proportional Editing: ${this.proportional ? 'ON' : 'OFF'}`);
      return true;
    }

    // Extrude: E (Interactive Modal across Vertex / Edge / Face)
    if (key === 'e' && !event.ctrlKey) {
      event.preventDefault();
      this.extrudeInteractive();
      return true;
    }

    // Inset: I
    if (key === 'i' && !event.ctrlKey) {
      event.preventDefault();
      this.inset();
      return true;
    }

    // Blender F (Make Edge / Face) and J (Vertex Connect Path)
    if ((key === 'f' || key === 'j') && !event.ctrlKey) {
      event.preventDefault();
      this.fillOrMakeFace();
      return true;
    }

    // Interactive Knife Cut: K
    if (key === 'k' && !event.ctrlKey) {
      event.preventDefault();
      this.knife();
      return true;
    }

    // Separate Selection: P
    if (key === 'p' && !event.ctrlKey) {
      event.preventDefault();
      this.separateSelection();
      return true;
    }

    // Duplicate: Shift + D
    if (key === 'd' && event.shiftKey) {
      event.preventDefault();
      this.duplicateSelection();
      return true;
    }

    // Select Linked: Ctrl + L
    if (key === 'l' && event.ctrlKey) {
      event.preventDefault();
      this.selectLinked();
      return true;
    }

    // X: Blender Delete Context Menu in UI (or direct delete fallback); Delete: quick delete
    if (key === 'x') {
      event.preventDefault();
      if (typeof window !== 'undefined' && window.blenderProTools) {
        window.blenderProTools.openEditDeleteMenu();
      } else {
        this.deleteSelection();
      }
      return true;
    }
    if (key === 'delete') {
      event.preventDefault();
      this.deleteSelection();
      return true;
    }

    // Escape: Clear selection
    if (key === 'escape') {
      event.preventDefault();
      this.deselectAll();
      return true;
    }

    return false;
  }

  // =========================================================================
  // UI SYNCHRONIZATION
  // =========================================================================

  _syncUIState(isEdit) {
    if (typeof document === 'undefined') return;
    const modeSelect = document.getElementById('viewport-mode');
    if (modeSelect) {
      modeSelect.value = isEdit ? 'edit' : 'object';
    }

    const group = document.getElementById('edit-mode-selector-group');
    if (group) {
      group.style.display = isEdit ? 'flex' : 'none';
    }

    this._syncUIButtons();
  }

  _syncUIButtons() {
    if (typeof document === 'undefined') return;
    const btnV = document.getElementById('btn-mode-vertex');
    const btnE = document.getElementById('btn-mode-edge');
    const btnF = document.getElementById('btn-mode-face');

    if (btnV) btnV.classList.toggle('active', this.selectionMode === 'vertex');
    if (btnE) btnE.classList.toggle('active', this.selectionMode === 'edge');
    if (btnF) btnF.classList.toggle('active', this.selectionMode === 'face');
  }

  _notifyStatsChanged() {
    if (typeof window !== 'undefined') {
      // Dispatch geometry changed for Inspector
      window.dispatchEvent(new CustomEvent('blender:geometryChanged', { detail: this.targetMesh }));

      // Update Header stats
      const statVerts = document.getElementById('stat-verts');
      const statFaces = document.getElementById('stat-faces');
      if (statVerts) {
        // The rebuilt buffer duplicates vertices along UV seams; report the
        // logical (welded) count like Blender does.
        const logicalCount = this.vertices ? this.vertices.length : 0;
        if (logicalCount > 0) {
          statVerts.innerText = logicalCount.toLocaleString();
        } else if (this.targetMesh?.geometry?.attributes?.position) {
          statVerts.innerText = this.targetMesh.geometry.attributes.position.count.toLocaleString();
        }
      }
      if (statFaces && this.faces) {
        statFaces.innerText = this.faces.length.toLocaleString();
      }
    }
  }

  /**
   * Commits all current modifications and rebuilds geometry
   * @param {boolean} [updateTopUndo=false]
   */
  commitChanges(updateTopUndo = false) {
    this._syncBufferPositions();
    this._recomputeFaceNormalsAndCentroids();
    if (this.targetMesh?.geometry) {
      this.targetMesh.geometry.computeVertexNormals();
      this.targetMesh.geometry.computeBoundingBox();
      this.targetMesh.geometry.computeBoundingSphere();
    }
    this.updateGizmoProxy();
    this._notifyStatsChanged();
    if (updateTopUndo) {
      this._updateTopUndoCommand();
    }
  }
}
