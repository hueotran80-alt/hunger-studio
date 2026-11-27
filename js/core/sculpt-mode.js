import * as THREE from 'three';
import { ensureBVH, refitBVH } from './bvh-accelerator.js';
import {
  initMeshKernel,
  isMeshKernelReady,
  sculptStrokeInWasm,
  voxelRemeshInWasm
} from './mesh-kernel-bridge.js';
import { refineDyntopoRegion } from './geometry/dyntopo.js';
import { remeshGeometry } from './geometry/pro-modifiers.js';
import { subdivideCatmullClark } from './geometry/catmull-clark.js';

export const SCULPT_BRUSHES = Object.freeze([
  'draw',
  'grab',
  'inflate',
  'smooth',
  'flatten',
  'clay',
  'pinch',
  'crease',
  'snake_hook',
  'mask'
]);

const WELD_QUANT_SCALE = 10000;

/**
 * Undo/Redo command for vertex displacement strokes in Sculpt Mode.
 */
export class SculptCommand {
  constructor(mesh, oldPositions, newPositions, onUpdate) {
    this.mesh = mesh;
    this.oldPositions = new Float32Array(oldPositions);
    this.newPositions = new Float32Array(newPositions);
    this.onUpdate = onUpdate;
    this.description = 'Sculpt Stroke';
    this.bytes = this.oldPositions.byteLength + this.newPositions.byteLength;
  }

  execute() {
    this._apply(this.newPositions);
  }

  undo() {
    this._apply(this.oldPositions);
  }

  _apply(data) {
    const geom = this.mesh?.geometry;
    if (!geom || !geom.attributes?.position) return;
    const posAttr = geom.attributes.position;
    if (posAttr.array.length !== data.length) return;
    posAttr.array.set(data);
    posAttr.needsUpdate = true;
    geom.computeVertexNormals();
    geom.computeBoundingBox();
    geom.computeBoundingSphere();
    refitBVH(this.mesh);
    if (this.onUpdate) this.onUpdate(this.mesh);
  }
}

/**
 * Undo/Redo command for Sculpt Mask changes (paint, invert, clear).
 */
export class SculptMaskCommand {
  constructor(mesh, oldMask, newMask, onUpdate, description = 'Sculpt Mask') {
    this.mesh = mesh;
    this.oldMask = new Float32Array(oldMask);
    this.newMask = new Float32Array(newMask);
    this.onUpdate = onUpdate;
    this.description = description;
    this.bytes = this.oldMask.byteLength + this.newMask.byteLength;
  }

  execute() {
    this._apply(this.newMask);
  }

  undo() {
    this._apply(this.oldMask);
  }

  _apply(data) {
    if (!this.mesh) return;
    if (!this.mesh.userData) this.mesh.userData = {};
    this.mesh.userData.sculptMask = new Float32Array(data);
    if (this.onUpdate) this.onUpdate(this.mesh);
  }
}

/**
 * Undo/Redo command for Voxel Remesh in Sculpt Mode.
 */
export class SculptRemeshCommand {
  constructor(mesh, oldGeometry, newGeometry, oldMask, newMask, onUpdate) {
    this.mesh = mesh;
    this.oldGeometry = oldGeometry;
    this.newGeometry = newGeometry;
    this.oldMask = oldMask ? new Float32Array(oldMask) : null;
    this.newMask = newMask ? new Float32Array(newMask) : null;
    this.onUpdate = onUpdate;
    this.description = 'Sculpt Voxel Remesh';
    const oldBytes = oldGeometry?.attributes?.position?.array?.byteLength || 0;
    const newBytes = newGeometry?.attributes?.position?.array?.byteLength || 0;
    this.bytes = oldBytes + newBytes + (this.oldMask?.byteLength || 0) + (this.newMask?.byteLength || 0);
  }

  execute() {
    this._apply(this.newGeometry, this.newMask);
  }

  undo() {
    this._apply(this.oldGeometry, this.oldMask);
  }

  _apply(geometry, mask) {
    if (!this.mesh || !geometry) return;
    this.mesh.geometry = geometry;
    if (!this.mesh.userData) this.mesh.userData = {};
    const vertCount = geometry.attributes?.position?.count || 0;
    this.mesh.userData.sculptMask = mask && mask.length === vertCount
      ? new Float32Array(mask)
      : new Float32Array(vertCount);
    ensureBVH(this.mesh);
    if (this.onUpdate) this.onUpdate(this.mesh);
  }
}

/**
 * Sculpt Mode 2.0: BVH Sphere Query + Rust WASM stroke & remesh + seam welding + vertex mask.
 */
export class SculptMode {
  constructor(engine, options = {}) {
    this.engine = engine || null;
    this.sceneManager = options.sceneManager || null;

    this.isActive = false;
    this.targetMesh = null;

    // Brush properties
    this.brushType = 'draw';
    this.radius = 0.4;
    this.strength = 0.5;
    this.symmetryX = true;
    this.voxelSize = 0.1;
    this.dyntopoEnabled = false;
    this.dyntopoDetailSize = 0.08;
    this._dyntopoTopologyChanged = false;
    this._strokeStartGeometry = null;

    // Stroke runtime state
    this.isSculpting = false;
    this._strokeStartPositions = null;
    this._strokeStartMask = null;
    this._grabBasePositions = null;
    this._grabStartPoint = null;
    this._grabMirrorStartPoint = null;
    this._grabPlane = new THREE.Plane();
    this._grabCandidates = null;
    this._grabMirrorCandidates = null;
    this._prevDragPointWorld = null;
    this._hasMovedDuringStroke = false;
    this._tempBrush = null;
    this._invertStroke = false;

    // Cached topology & scratch buffers (zero GC churn per stroke step)
    this._weldGroupOf = null;
    this._weldGroups = [];
    this._vertToTris = null;
    this._vertNeighbors = null;
    this._weldedNormals = null;
    this._lastDabPointWorld = null;
    this._radiusModal = null;
    this._candSeen = new Uint8Array(0);
    this._candList = [];
    this._normalTouchSeen = new Uint8Array(0);
    this._triTouchSeen = new Uint8Array(0);
    this._createdColorAttr = false;

    this.raycaster = new THREE.Raycaster();
    this.mouse = new THREE.Vector2();

    // 3D Brush Cursor Visualizer (Ring aligned to surface)
    this.brushCursor = null;
    this._initCursor();

    // Reusable math temporaries
    this._invMatrix = new THREE.Matrix4();
    this._normalMatrix = new THREE.Matrix3();
    this._tmpVecA = new THREE.Vector3();
    this._tmpVecB = new THREE.Vector3();
    this._tmpVecC = new THREE.Vector3();
    this._tmpWorldScale = new THREE.Vector3(1, 1, 1);
    this._tmpSphere = new THREE.Sphere();

    // Bound listeners
    this._onPointerDown = this._onPointerDown.bind(this);
    this._onPointerMove = this._onPointerMove.bind(this);
    this._onPointerUp = this._onPointerUp.bind(this);
    this._onKeyDown = this._onKeyDown.bind(this);
    this._onKeyUp = this._onKeyUp.bind(this);
  }

  _initCursor() {
    if (!this.engine?.scene) return;
    const ringGeo = new THREE.RingGeometry(0.92, 1.0, 48);
    const ringMat = new THREE.MeshBasicMaterial({
      color: 0xffa742,
      side: THREE.DoubleSide,
      depthTest: false,
      transparent: true,
      opacity: 0.85
    });
    this.brushCursor = new THREE.Mesh(ringGeo, ringMat);
    this.brushCursor.visible = false;
    this.brushCursor.renderOrder = 999;
    this.brushCursor.userData.isSystemHelper = true;
    this.engine.scene.add(this.brushCursor);
  }

  _updateCursorColor() {
    if (!this.brushCursor?.material) return;
    this.brushCursor.material.color.setHex(this.brushType === 'mask' ? 0x6b7280 : 0xffa742);
  }

  get isBrushing() {
    return Boolean(this.isSculpting);
  }

  /**
   * Enter Sculpt Mode on a specific mesh.
   */
  enter(mesh) {
    if (!mesh || !mesh.isMesh || !mesh.geometry?.attributes?.position) {
      console.warn('[SculptMode] Invalid target mesh for sculpting.');
      return false;
    }

    if (this.isActive) {
      this.exit();
    }
    if (typeof window !== 'undefined') {
      if (window.editMode?.isActive) window.editMode.exit();
      if (window.paintMode?.isActive) window.paintMode.exit();
      if (window.rigSystem?.isWeightPaintMode) window.rigSystem.disableWeightPaintMode();
      if (window.rigSystem?.isEditBoneMode) window.rigSystem.exitEditBoneMode();
      if (window.rigSystem?.isPoseMode) window.rigSystem.setPoseMode(false);
    }

    this.targetMesh = mesh;
    this.isActive = true;

    // Ensure Auto-LOD meshes switch cleanly to full-detail LOD0 before sculpting
    if (this.engine?.lodManager?.forceLOD0OnMesh) {
      this.engine.lodManager.forceLOD0OnMesh(mesh);
    } else if (mesh.userData?.lod?.levels?.[0] && mesh.userData.lod.activeLevel > 0) {
      const lod0 = mesh.userData.lod.levels[0];
      if (lod0 && lod0 !== mesh.geometry) {
        mesh.userData.__sculptPrevLodGeom = mesh.geometry;
        mesh.geometry = lod0;
        mesh.userData.lod.activeLevel = 0;
      }
    }

    // Warm up Rust WASM kernel asynchronously if not initialized yet
    if (!isMeshKernelReady()) {
      this._wasmInitPromise = initMeshKernel().catch(() => false);
    } else {
      this._wasmInitPromise = Promise.resolve(true);
    }

    // Build / verify BVH for O(log N) candidate vertex queries & fast raycasting
    ensureBVH(mesh);

    // Precompute coincident seam weld groups, triangle adjacency, and welded smooth normals
    this._buildSculptTopology(mesh.geometry);

    // Initialize or restore Sculpt Mask attribute + material vertex color shading
    this._attachMaskColors(mesh);

    // Detach transform gizmo if attached
    if (this.engine?.transformControls) {
      this.engine.transformControls.detach();
    }

    // Attach Canvas + Window listeners when running in a DOM environment
    const canvas = this.engine?.renderer?.domElement;
    if (canvas) {
      canvas.addEventListener('pointerdown', this._onPointerDown);
      canvas.addEventListener('pointermove', this._onPointerMove);
    }
    if (typeof window !== 'undefined') {
      window.addEventListener('pointerup', this._onPointerUp);
      window.addEventListener('keydown', this._onKeyDown);
      window.addEventListener('keyup', this._onKeyUp);
    }

    this._updateCursorColor();
    this._updateToolbarUI(true);
    this._syncSculptSliders();
    this._requestRender();

    console.log(`[SculptMode] Entered on mesh "${mesh.name || 'Mesh'}". Verts: ${mesh.geometry.attributes.position.count}`);
    return true;
  }

  /**
   * Exit Sculpt Mode and return to Object Mode.
   */
  exit() {
    if (!this.isActive) return;

    const canvas = this.engine?.renderer?.domElement;
    if (canvas) {
      canvas.removeEventListener('pointerdown', this._onPointerDown);
      canvas.removeEventListener('pointermove', this._onPointerMove);
    }
    if (typeof window !== 'undefined') {
      window.removeEventListener('pointerup', this._onPointerUp);
      window.removeEventListener('keydown', this._onKeyDown);
      window.removeEventListener('keyup', this._onKeyUp);
    }

    if (this.engine?.controls) {
      this.engine.controls.enabled = true;
    }

    if (this.brushCursor) {
      this.brushCursor.visible = false;
    }

    const previousMesh = this.targetMesh;
    if (this.targetMesh) {
      this._detachMaskColors(this.targetMesh);
      if (this.targetMesh.userData?.__sculptPrevLodGeom) {
        this.targetMesh.geometry = this.targetMesh.userData.__sculptPrevLodGeom;
        delete this.targetMesh.userData.__sculptPrevLodGeom;
        this.targetMesh.geometry?.computeBoundingBox?.();
        this.targetMesh.geometry?.computeBoundingSphere?.();
      }
    }

    this.isActive = false;
    this.isSculpting = false;
    this._strokeStartPositions = null;
    this._strokeStartMask = null;
    this._grabBasePositions = null;
    this._grabCandidates = null;
    this._grabMirrorCandidates = null;
    this._prevDragPointWorld = null;
    this._tempBrush = null;
    this._invertStroke = false;
    this.targetMesh = null;

    this._updateToolbarUI(false);
    const activeTarget = this.engine?.sceneManager?.getActiveObject?.() || previousMesh;
    this.engine?.updateActiveGizmo?.(activeTarget);
    this.engine?.updateSelectionHelper?.();
    this.engine?.syncViewportPaneControls?.();
    this._requestRender();
    console.log('[SculptMode] Exited.');
  }

  setBrush(type) {
    if (SCULPT_BRUSHES.includes(type)) {
      this.brushType = type;
      this._updateCursorColor();
      this._syncBrushButtons();
      console.log(`[SculptMode] Brush set to: ${type}`);
    }
  }

  setRadius(r) {
    this.radius = Math.max(0.05, Math.min(3.0, Number(r) || 0.4));
    this._updateCursorScale();
    this._syncSculptSliders();
  }

  setStrength(s) {
    this.strength = Math.max(0.01, Math.min(1.0, Number(s) || 0.5));
    this._syncSculptSliders();
  }

  setSymmetry(enabled) {
    this.symmetryX = !!enabled;
    if (typeof document !== 'undefined') {
      const btnSym = document.getElementById('btn-sculpt-symmetry');
      if (btnSym) {
        btnSym.classList.toggle('active', this.symmetryX);
        const span = btnSym.querySelector('span');
        if (span) span.textContent = `X-Symmetry (${this.symmetryX ? 'ON' : 'OFF'})`;
      }
    }
  }

  setVoxelSize(size) {
    const num = Number(size);
    if (!Number.isFinite(num)) return;
    this.voxelSize = Math.max(0.002, Math.min(50.0, num));
    if (typeof document !== 'undefined') {
      const input = document.getElementById('input-sculpt-voxel-size');
      if (input && document.activeElement !== input) {
        input.value = this.voxelSize < 0.05 ? this.voxelSize.toFixed(3) : this.voxelSize.toFixed(2);
      }
    }
  }

  getMask() {
    return this.targetMesh?.userData?.sculptMask || null;
  }

  /**
   * Clear all Sculpt Mask values to 0.0 (Alt+M).
   */
  clearMask() {
    const mesh = this.targetMesh;
    const geom = mesh?.geometry;
    if (!mesh || !geom?.attributes?.position) return false;

    const vertCount = geom.attributes.position.count;
    const mask = this._ensureMaskArray(mesh, vertCount);
    let anyNonZero = false;
    for (let i = 0; i < vertCount; i++) {
      if (mask[i] > 1e-6) {
        anyNonZero = true;
        break;
      }
    }
    if (!anyNonZero) return false;

    const oldMask = new Float32Array(mask);
    mask.fill(0);
    this._syncMaskColors(geom, mask);

    if (this.sceneManager) {
      const cmd = new SculptMaskCommand(
        mesh,
        oldMask,
        mask,
        (m) => this._onHistoryMaskUpdate(m),
        'Clear Sculpt Mask'
      );
      this.sceneManager.executeCommand(cmd);
    }

    this._requestRender();
    return true;
  }

  /**
   * Invert all Sculpt Mask values (1.0 - mask) (Ctrl+I).
   */
  invertMask() {
    const mesh = this.targetMesh;
    const geom = mesh?.geometry;
    if (!mesh || !geom?.attributes?.position) return false;

    const vertCount = geom.attributes.position.count;
    const mask = this._ensureMaskArray(mesh, vertCount);
    const oldMask = new Float32Array(mask);

    for (let i = 0; i < vertCount; i++) {
      mask[i] = Math.max(0, Math.min(1, 1.0 - mask[i]));
    }
    this._syncMaskColors(geom, mask);

    if (this.sceneManager) {
      const cmd = new SculptMaskCommand(
        mesh,
        oldMask,
        mask,
        (m) => this._onHistoryMaskUpdate(m),
        'Invert Sculpt Mask'
      );
      this.sceneManager.executeCommand(cmd);
    }

    this._requestRender();
    return true;
  }

  /**
   * Remesh the active sculpt geometry via Rust WASM uniform edge splitting + tangential relaxation (Ctrl+R).
   */
  setDyntopo(enabled, detailSize = null) {
    this.dyntopoEnabled = Boolean(enabled);
    if (detailSize != null && Number.isFinite(Number(detailSize))) {
      this.dyntopoDetailSize = Math.max(0.002, Number(detailSize));
    }
    if (typeof document !== 'undefined') {
      document.getElementById('btn-sculpt-dyntopo')?.classList.toggle('active', this.dyntopoEnabled);
      const detInp = document.getElementById('input-sculpt-dyntopo-detail');
      if (detInp && document.activeElement !== detInp) detInp.value = String(this.dyntopoDetailSize);
    }
    return this.dyntopoEnabled;
  }

  voxelRemesh(voxelSize = this.voxelSize) {
    const mesh = this.targetMesh;
    const oldGeometry = mesh?.geometry;
    if (!mesh || !oldGeometry?.attributes?.position) return false;

    if (!oldGeometry.boundingBox) oldGeometry.computeBoundingBox();
    const diag = oldGeometry.boundingBox ? oldGeometry.boundingBox.getSize(new THREE.Vector3()).length() : 2.0;
    const minVoxel = Math.max(0.002, diag * 0.003);
    const maxVoxel = Math.max(2.0, diag * 0.5);
    const clampedVoxel = Math.max(minVoxel, Math.min(maxVoxel, Number(voxelSize) || this.voxelSize));
    this.voxelSize = clampedVoxel;

    const oldMask = mesh.userData?.sculptMask ? new Float32Array(mesh.userData.sculptMask) : null;
    let newGeometry = null;

    if (isMeshKernelReady()) {
      const posAttr = oldGeometry.attributes.position;
      const posArr = posAttr.array instanceof Float32Array ? posAttr.array : new Float32Array(posAttr.array);
      const idxArr = oldGeometry.index ? oldGeometry.index.array : null;
      const remeshed = voxelRemeshInWasm(posArr, idxArr, clampedVoxel);
      if (remeshed && remeshed.vertices && remeshed.vertices.length >= 9) {
        newGeometry = new THREE.BufferGeometry();
        newGeometry.setAttribute('position', new THREE.Float32BufferAttribute(remeshed.vertices, 3));
        if (remeshed.normals && remeshed.normals.length === remeshed.vertices.length) {
          newGeometry.setAttribute('normal', new THREE.Float32BufferAttribute(remeshed.normals, 3));
        } else {
          newGeometry.computeVertexNormals();
        }
        newGeometry.setIndex(new THREE.BufferAttribute(remeshed.indices, 1));
      }
    }

    if (!newGeometry) {
      newGeometry = remeshGeometry(oldGeometry, { mode: 'voxel', voxelSize: clampedVoxel, smoothIterations: 1 });
    }
    if (!newGeometry?.attributes?.position || newGeometry.attributes.position.count < 3) {
      return false;
    }

    newGeometry.computeBoundingBox();
    newGeometry.computeBoundingSphere();

    // Detach previous mask colors cleanly before swapping geometry
    this._detachMaskColors(mesh);

    const newVertCount = newGeometry.attributes.position.count;
    const newMask = new Float32Array(newVertCount);
    mesh.geometry = newGeometry;
    if (!mesh.userData) mesh.userData = {};
    mesh.userData.sculptMask = newMask;

    ensureBVH(mesh);
    this._buildSculptTopology(newGeometry);
    this._attachMaskColors(mesh);

    if (this.sceneManager) {
      const cmd = new SculptRemeshCommand(
        mesh,
        oldGeometry,
        newGeometry,
        oldMask,
        newMask,
        (m) => this._onHistoryGeometryUpdate(m)
      );
      this.sceneManager.executeCommand(cmd);
    }

    this._syncSculptSliders();
    this._requestRender();
    return true;
  }

  /**
   * Public stroke application helper (usable both by pointer events and automated tests).
   * Accepts a raycast hit or local-space `{ point, face: { normal }, object }` + options.
   */
  applyStroke(hit, options = {}) {
    if (!hit || !this.targetMesh || !this.targetMesh.geometry?.attributes?.position) {
      return 0;
    }

    const mesh = this.targetMesh;
    const geom = mesh.geometry;
    const effectiveBrush = options.brush || this._tempBrush || this.brushType;
    const radiusWorld = options.radius != null ? options.radius : this.radius;
    const strength = options.strength != null ? options.strength : this.strength;
    const useSymmetry = options.symmetryX != null ? options.symmetryX : this.symmetryX;
    const invert = options.invert != null ? options.invert : this._invertStroke;
    const isLocal = !!options.isLocal;

    mesh.updateMatrixWorld(true);
    let localCenter;
    let localNormal;
    let localDelta;
    let localRadius;

    if (isLocal) {
      localCenter = this._tmpVecA.copy(hit.point);
      localNormal = this._tmpVecB.copy(hit.face?.normal || new THREE.Vector3(0, 1, 0)).normalize();
      localDelta = this._tmpVecC.copy(options.delta || { x: 0, y: 0, z: 0 });
      localRadius = radiusWorld;
    } else {
      this._invMatrix.copy(mesh.matrixWorld).invert();
      localCenter = this._tmpVecA.copy(hit.point).applyMatrix4(this._invMatrix);
      // Raycaster hit.face.normal is ALREADY in local object space; never multiply by normalMatrix!
      localNormal = this._tmpVecB.copy(hit.face?.normal || new THREE.Vector3(0, 1, 0)).normalize();

      mesh.getWorldScale(this._tmpWorldScale);
      const maxScale = Math.max(
        1e-4,
        Math.abs(this._tmpWorldScale.x),
        Math.abs(this._tmpWorldScale.y),
        Math.abs(this._tmpWorldScale.z)
      );
      localRadius = radiusWorld / maxScale;

      if (options.delta) {
        const dx = options.delta.x || 0;
        const dy = options.delta.y || 0;
        const dz = options.delta.z || 0;
        const e = this._invMatrix.elements;
        localDelta = this._tmpVecC.set(
          e[0] * dx + e[4] * dy + e[8] * dz,
          e[1] * dx + e[5] * dy + e[9] * dz,
          e[2] * dx + e[6] * dy + e[10] * dz
        );
      } else {
        localDelta = this._tmpVecC.set(0, 0, 0);
      }
    }

    const dir = invert ? -1.0 : 1.0;

    let posBeforeUndo = null;
    let maskBeforeUndo = null;
    let geomBeforeDyntopo = null;
    let dyntopoChangedThisStroke = false;
    if (options.recordUndo && this.sceneManager) {
      if (effectiveBrush === 'mask') {
        maskBeforeUndo = new Float32Array(this._ensureMaskArray(mesh, geom.attributes.position.count));
      } else {
        posBeforeUndo = new Float32Array(geom.attributes.position.array);
        if (this.dyntopoEnabled && effectiveBrush !== 'grab') geomBeforeDyntopo = geom.clone();
      }
    }

    let activeGeom = geom;
    if (this.dyntopoEnabled && effectiveBrush !== 'mask' && effectiveBrush !== 'grab') {
      const detail = options.dyntopoDetailSize ?? this.dyntopoDetailSize;
      const refineCenters = [localCenter];
      if (useSymmetry) refineCenters.push(new THREE.Vector3(-localCenter.x, localCenter.y, localCenter.z));
      for (const rc of refineCenters) {
        const res = refineDyntopoRegion(activeGeom, rc, localRadius, detail, mesh.userData?.sculptMask);
        if (res.changed && res.geometry) {
          this._detachMaskColors(mesh);
          if (activeGeom !== geom && activeGeom !== this._strokeStartGeometry) activeGeom.dispose();
          mesh.geometry = res.geometry;
          activeGeom = res.geometry;
          if (!mesh.userData) mesh.userData = {};
          mesh.userData.sculptMask = res.mask;
          this._buildSculptTopology(activeGeom);
          ensureBVH(mesh);
          this._attachMaskColors(mesh);
          dyntopoChangedThisStroke = true;
          this._dyntopoTopologyChanged = true;
        }
      }
    }

    const modified = this._evalBrushLocal(
      activeGeom,
      effectiveBrush,
      [localCenter.x, localCenter.y, localCenter.z],
      [localNormal.x, localNormal.y, localNormal.z],
      [localDelta.x, localDelta.y, localDelta.z],
      localRadius,
      strength,
      dir,
      options.basePositions || null,
      options.candidates || null,
      useSymmetry,
      options.mirrorCandidates || null
    );

    if (modified > 0 && effectiveBrush !== 'mask') {
      activeGeom.computeBoundingBox();
      activeGeom.computeBoundingSphere();
      refitBVH(mesh);
      this._syncMultiresDeltas(mesh);
    }

    if (options.recordUndo && this.sceneManager && (modified > 0 || dyntopoChangedThisStroke)) {
      if (effectiveBrush === 'mask') {
        const afterMask = mesh.userData.sculptMask;
        this.sceneManager.executeCommand(
          new SculptMaskCommand(mesh, maskBeforeUndo, afterMask, (m) => this._onHistoryMaskUpdate(m))
        );
      } else if (dyntopoChangedThisStroke && geomBeforeDyntopo) {
        this.sceneManager.executeCommand(
          new SculptRemeshCommand(mesh, geomBeforeDyntopo, activeGeom, maskBeforeUndo, mesh.userData?.sculptMask, (m) => this._onHistoryGeometryUpdate(m))
        );
      } else {
        geomBeforeDyntopo?.dispose?.();
        this.sceneManager.executeCommand(
          new SculptCommand(mesh, posBeforeUndo, activeGeom.attributes.position.array, (m) => this._onHistoryMeshUpdate(m))
        );
      }
    } else {
      geomBeforeDyntopo?.dispose?.();
    }

    this._requestRender();
    return modified;
  }

  _evalBrushLocal(
    geom,
    brush,
    center,
    normal,
    delta,
    localRadius,
    strength,
    dir,
    basePositions = null,
    explicitCandidates = null,
    symmetryX = false,
    explicitMirrorCandidates = null
  ) {
    const posAttr = geom.attributes.position;
    const positions = posAttr.array;
    const vertCount = posAttr.count;
    const mask = this._ensureMaskArray(this.targetMesh, vertCount);

    if (!this._weldedNormals || this._weldedNormals.length !== positions.length) {
      this._buildSculptTopology(geom);
    }

    const rawCandidates = explicitCandidates || this._collectCandidateVertices(geom, center, localRadius);
    let candidates = rawCandidates;
    let symActive = Boolean(symmetryX);
    let symSign = 0;

    if (symActive) {
      if (Math.abs(center[0]) <= 1e-4) {
        // Stroke sits right on the X=0 mirror plane: symmetrize once and suppress duplicate mirror pass
        symActive = false;
        center = [0, center[1], center[2]];
        normal = [0, normal[1], normal[2]];
        const nLen = Math.hypot(normal[0], normal[1], normal[2]) || 1;
        normal = [normal[0] / nLen, normal[1] / nLen, normal[2] / nLen];
        delta = [0, delta[1], delta[2]];
      } else if (Math.abs(center[0]) < localRadius && candidates) {
        // Overlapping center plane: partition vertices cleanly into primary vs mirror half-spaces
        symSign = center[0] > 0 ? 1 : -1;
        const filt = [];
        for (let i = 0; i < candidates.length; i++) {
          const vi = candidates[i];
          if (positions[vi * 3] * symSign >= -1e-4) filt.push(vi);
        }
        candidates = filt;
      }
    }

    let modified = 0;

    if (brush === 'smooth' && this._vertNeighbors) {
      modified += this._evalSmoothLaplacianJS({
        positions,
        mask,
        candidates,
        center,
        radius: localRadius,
        strength,
      });
    } else if (isMeshKernelReady()) {
      const m = sculptStrokeInWasm({
        positions,
        normals: this._weldedNormals,
        mask,
        basePositions: brush === 'grab' ? basePositions : null,
        candidates,
        brush,
        center,
        normal,
        delta,
        radius: localRadius,
        strength,
        dir
      });
      if (m != null) modified += m;
    } else {
      modified += this._evalBrushJS({
        positions,
        normals: this._weldedNormals,
        mask,
        basePositions: brush === 'grab' ? basePositions : null,
        candidates,
        brush,
        center,
        normal,
        delta,
        radius: localRadius,
        strength,
        dir
      });
    }

    if (brush === 'mask') {
      if (modified > 0) {
        this._syncWeldedMask(mask, candidates);
        this._syncMaskColors(geom, mask, candidates);
      }
    } else if (modified > 0) {
      this._syncWeldedPositions(positions, candidates);
      posAttr.needsUpdate = true;
      this._updateLocalNormals(geom, candidates);
    }

    if (symActive) {
      const mCenter = [-center[0], center[1], center[2]];
      const mNormal = [-normal[0], normal[1], normal[2]];
      const mDelta = [-delta[0], delta[1], delta[2]];
      let mCandidates = explicitMirrorCandidates || this._collectCandidateVertices(geom, mCenter, localRadius);
      if (symSign !== 0 && mCandidates) {
        const filtM = [];
        for (let i = 0; i < mCandidates.length; i++) {
          const vi = mCandidates[i];
          if (positions[vi * 3] * symSign < -1e-4) filtM.push(vi);
        }
        mCandidates = filtM;
      }

      let symModified = 0;
      if (brush === 'smooth' && this._vertNeighbors) {
        symModified += this._evalSmoothLaplacianJS({
          positions,
          mask,
          candidates: mCandidates,
          center: mCenter,
          radius: localRadius,
          strength,
        });
      } else if (isMeshKernelReady()) {
        const m = sculptStrokeInWasm({
          positions,
          normals: this._weldedNormals,
          mask,
          basePositions: brush === 'grab' ? basePositions : null,
          candidates: mCandidates,
          brush,
          center: mCenter,
          normal: mNormal,
          delta: mDelta,
          radius: localRadius,
          strength,
          dir
        });
        if (m != null) symModified += m;
      } else {
        symModified += this._evalBrushJS({
          positions,
          normals: this._weldedNormals,
          mask,
          basePositions: brush === 'grab' ? basePositions : null,
          candidates: mCandidates,
          brush,
          center: mCenter,
          normal: mNormal,
          delta: mDelta,
          radius: localRadius,
          strength,
          dir
        });
      }

      if (symModified > 0) {
        modified += symModified;
        if (brush === 'mask') {
          this._syncWeldedMask(mask, mCandidates);
          this._syncMaskColors(geom, mask, mCandidates);
        } else {
          this._syncWeldedPositions(positions, mCandidates);
          posAttr.needsUpdate = true;
          this._updateLocalNormals(geom, mCandidates);
        }
      }
    }

    return modified;
  }

  /**
   * Collect candidate vertex indices within `localRadius` of `center` via MeshBVH shapecast,
   * expanded across coincident UV/corner seam weld siblings so seams never split.
   */
  _collectCandidateVertices(geom, center, localRadius) {
    const vertCount = geom.attributes?.position?.count || 0;
    if (vertCount === 0) return null;

    const bvh = geom.boundsTree;
    if (!bvh) return null;

    if (this._candSeen.length < vertCount) {
      this._candSeen = new Uint8Array(vertCount);
    } else {
      this._candSeen.fill(0, 0, vertCount);
    }

    const candList = this._candList;
    candList.length = 0;

    this._tmpSphere.set(
      this._tmpVecA.set(center[0], center[1], center[2]),
      localRadius
    );
    const sphere = this._tmpSphere;
    const indexAttr = geom.index;
    const indexArr = indexAttr ? indexAttr.array : null;
    const seen = this._candSeen;
    const weldGroupOf = this._weldGroupOf;
    const weldGroups = this._weldGroups;

    const addVert = (vi) => {
      if (vi >= vertCount || seen[vi]) return;
      seen[vi] = 1;
      candList.push(vi);
      if (weldGroupOf) {
        const gId = weldGroupOf[vi];
        if (gId >= 0) {
          const members = weldGroups[gId];
          for (let j = 0; j < members.length; j++) {
            const sib = members[j];
            if (!seen[sib]) {
              seen[sib] = 1;
              candList.push(sib);
            }
          }
        }
      }
    };

    bvh.shapecast({
      intersectsBounds: (box) => box.intersectsSphere(sphere),
      intersectsTriangle: (tri, triIndex) => {
        // `bvh.shapecast` (iterateOverTriangles_indirect) already resolves `triIndex`
        // to the geometry triangle index; double-resolving scrambles candidate vertices.
        const base = triIndex * 3;
        if (indexArr) {
          addVert(indexArr[base]);
          addVert(indexArr[base + 1]);
          addVert(indexArr[base + 2]);
        } else {
          addVert(base);
          addVert(base + 1);
          addVert(base + 2);
        }
        return false;
      }
    });

    return candList.length > 0 ? Uint32Array.from(candList) : new Uint32Array(0);
  }

  /**
   * Build O(N) coincident vertex weld table, vertex-to-triangle adjacency, and welded smooth normals.
   */
  _buildSculptTopology(geom) {
    const posAttr = geom?.attributes?.position;
    if (!posAttr) return;

    const vertCount = posAttr.count;
    const pos = posAttr.array;

    // 1. Coincident seam weld groups
    const coordMap = new Map();
    this._weldGroupOf = new Int32Array(vertCount).fill(-1);
    this._weldGroups = [];

    for (let i = 0; i < vertCount; i++) {
      const qx = Math.round(pos[i * 3] * WELD_QUANT_SCALE);
      const qy = Math.round(pos[i * 3 + 1] * WELD_QUANT_SCALE);
      const qz = Math.round(pos[i * 3 + 2] * WELD_QUANT_SCALE);
      const key = `${qx}_${qy}_${qz}`;
      const existing = coordMap.get(key);
      if (existing === undefined) {
        coordMap.set(key, i);
      } else if (existing >= 0) {
        const gId = this._weldGroups.length;
        this._weldGroups.push([existing, i]);
        this._weldGroupOf[existing] = gId;
        this._weldGroupOf[i] = gId;
        coordMap.set(key, -1 - gId);
      } else {
        const gId = -1 - existing;
        this._weldGroups[gId].push(i);
        this._weldGroupOf[i] = gId;
      }
    }

    // 2. Vertex -> Triangle adjacency for fast localized normal updates
    const idxArr = geom.index ? geom.index.array : null;
    const triCount = idxArr ? (idxArr.length / 3) | 0 : (vertCount / 3) | 0;
    const vertToTris = new Array(vertCount);
    for (let i = 0; i < vertCount; i++) vertToTris[i] = [];

    for (let t = 0; t < triCount; t++) {
      const a = idxArr ? idxArr[t * 3] : t * 3;
      const b = idxArr ? idxArr[t * 3 + 1] : t * 3 + 1;
      const c = idxArr ? idxArr[t * 3 + 2] : t * 3 + 2;
      if (a < vertCount) vertToTris[a].push(t);
      if (b < vertCount) vertToTris[b].push(t);
      if (c < vertCount) vertToTris[c].push(t);
    }
    this._vertToTris = vertToTris;

    // 2b. Welded 1-ring neighbor adjacency for true Laplacian smoothing across seams
    const canonicalOf = new Int32Array(vertCount);
    for (let i = 0; i < vertCount; i++) {
      const gId = this._weldGroupOf[i];
      canonicalOf[i] = gId >= 0 ? this._weldGroups[gId][0] : i;
    }
    const nbrSets = new Map();
    const addEdgePair = (u, v) => {
      const cu = canonicalOf[u];
      const cv = canonicalOf[v];
      if (cu === cv) return;
      let su = nbrSets.get(cu);
      if (!su) { su = new Set(); nbrSets.set(cu, su); }
      su.add(cv);
      let sv = nbrSets.get(cv);
      if (!sv) { sv = new Set(); nbrSets.set(cv, sv); }
      sv.add(cu);
    };
    for (let t = 0; t < triCount; t++) {
      const a = idxArr ? idxArr[t * 3] : t * 3;
      const b = idxArr ? idxArr[t * 3 + 1] : t * 3 + 1;
      const c = idxArr ? idxArr[t * 3 + 2] : t * 3 + 2;
      if (a >= vertCount || b >= vertCount || c >= vertCount) continue;
      addEdgePair(a, b);
      addEdgePair(b, c);
      addEdgePair(c, a);
    }
    const vertNeighbors = new Array(vertCount);
    for (let i = 0; i < vertCount; i++) {
      const set = nbrSets.get(canonicalOf[i]);
      vertNeighbors[i] = set ? Array.from(set) : [];
    }
    this._vertNeighbors = vertNeighbors;

    // 3. Area-weighted welded vertex normals
    this._recomputeAllWeldedNormals(geom);
  }

  /**
   * True simultaneous 1-ring Jacobi Laplacian smoothing inside the brush radius.
   */
  _evalSmoothLaplacianJS({ positions, mask, candidates, center, radius, strength }) {
    const vertCount = (positions.length / 3) | 0;
    if (radius <= 1e-6 || !this._vertNeighbors) return 0;
    const radiusSq = radius * radius;
    const invRadius = 1.0 / radius;
    const [cx, cy, cz] = center;
    const loopLen = candidates ? candidates.length : vertCount;

    const deltas = [];
    for (let k = 0; k < loopLen; k++) {
      const vi = candidates ? candidates[k] : k;
      if (vi >= vertCount) continue;
      const b = vi * 3;
      const px = positions[b], py = positions[b + 1], pz = positions[b + 2];
      const dSq = (px - cx) ** 2 + (py - cy) ** 2 + (pz - cz) ** 2;
      if (dSq >= radiusSq) continue;

      const maskVal = Math.max(0, Math.min(1, mask[vi]));
      if (maskVal >= 0.999) continue;

      const nbrs = this._vertNeighbors[vi];
      if (!nbrs || nbrs.length === 0) continue;

      let sx = 0, sy = 0, sz = 0;
      for (let n = 0; n < nbrs.length; n++) {
        const nb = nbrs[n] * 3;
        sx += positions[nb];
        sy += positions[nb + 1];
        sz += positions[nb + 2];
      }
      const invN = 1.0 / nbrs.length;
      const avgX = sx * invN;
      const avgY = sy * invN;
      const avgZ = sz * invN;

      const normDist = Math.sqrt(dSq) * invRadius;
      const oneMinusD2 = 1.0 - normDist * normDist;
      const falloff = oneMinusD2 * oneMinusD2;
      const t = Math.min(0.85, Math.max(0, falloff * (1.0 - maskVal) * strength * 0.55));
      deltas.push(vi, (avgX - px) * t, (avgY - py) * t, (avgZ - pz) * t);
    }

    let modified = 0;
    for (let i = 0; i < deltas.length; i += 4) {
      const b = deltas[i] * 3;
      positions[b] += deltas[i + 1];
      positions[b + 1] += deltas[i + 2];
      positions[b + 2] += deltas[i + 3];
      modified++;
    }
    return modified;
  }

  _recomputeAllWeldedNormals(geom) {
    const posAttr = geom?.attributes?.position;
    if (!posAttr) return;

    const vertCount = posAttr.count;
    const pos = posAttr.array;
    const idxArr = geom.index ? geom.index.array : null;
    const triCount = idxArr ? (idxArr.length / 3) | 0 : (vertCount / 3) | 0;

    if (!this._weldedNormals || this._weldedNormals.length !== vertCount * 3) {
      this._weldedNormals = new Float32Array(vertCount * 3);
    } else {
      this._weldedNormals.fill(0);
    }
    const wn = this._weldedNormals;

    for (let t = 0; t < triCount; t++) {
      const a = idxArr ? idxArr[t * 3] : t * 3;
      const b = idxArr ? idxArr[t * 3 + 1] : t * 3 + 1;
      const c = idxArr ? idxArr[t * 3 + 2] : t * 3 + 2;
      if (a >= vertCount || b >= vertCount || c >= vertCount) continue;

      const ax = pos[a * 3], ay = pos[a * 3 + 1], az = pos[a * 3 + 2];
      const abx = pos[b * 3] - ax, aby = pos[b * 3 + 1] - ay, abz = pos[b * 3 + 2] - az;
      const acx = pos[c * 3] - ax, acy = pos[c * 3 + 1] - ay, acz = pos[c * 3 + 2] - az;
      const fnx = aby * acz - abz * acy;
      const fny = abz * acx - abx * acz;
      const fnz = abx * acy - aby * acx;

      wn[a * 3] += fnx; wn[a * 3 + 1] += fny; wn[a * 3 + 2] += fnz;
      wn[b * 3] += fnx; wn[b * 3 + 1] += fny; wn[b * 3 + 2] += fnz;
      wn[c * 3] += fnx; wn[c * 3 + 1] += fny; wn[c * 3 + 2] += fnz;
    }

    // Average across coincident weld groups before normalizing
    for (let g = 0; g < this._weldGroups.length; g++) {
      const members = this._weldGroups[g];
      let sx = 0, sy = 0, sz = 0;
      for (let j = 0; j < members.length; j++) {
        const m = members[j] * 3;
        sx += wn[m]; sy += wn[m + 1]; sz += wn[m + 2];
      }
      for (let j = 0; j < members.length; j++) {
        const m = members[j] * 3;
        wn[m] = sx; wn[m + 1] = sy; wn[m + 2] = sz;
      }
    }

    for (let i = 0; i < vertCount; i++) {
      const idx = i * 3;
      const len = Math.hypot(wn[idx], wn[idx + 1], wn[idx + 2]);
      if (len > 1e-8) {
        wn[idx] /= len; wn[idx + 1] /= len; wn[idx + 2] /= len;
      } else {
        wn[idx] = 0; wn[idx + 1] = 1; wn[idx + 2] = 0;
      }
    }

    if (geom.attributes.normal) {
      geom.attributes.normal.array.set(wn);
      geom.attributes.normal.needsUpdate = true;
    } else {
      geom.setAttribute('normal', new THREE.Float32BufferAttribute(new Float32Array(wn), 3));
    }
  }

  /**
   * Recompute welded vertex normals strictly for triangles touching `candidates`.
   */
  _updateLocalNormals(geom, candidates) {
    if (!candidates || candidates.length === 0 || !this._vertToTris) {
      this._recomputeAllWeldedNormals(geom);
      return;
    }

    const pos = geom.attributes.position.array;
    const vertCount = geom.attributes.position.count;
    const idxArr = geom.index ? geom.index.array : null;
    const wn = this._weldedNormals;
    const normAttr = geom.attributes.normal;
    const normArr = normAttr ? normAttr.array : null;

    if (this._normalTouchSeen.length < vertCount) {
      this._normalTouchSeen = new Uint8Array(vertCount);
    } else {
      this._normalTouchSeen.fill(0, 0, vertCount);
    }
    const touchedSeen = this._normalTouchSeen;
    const touchedList = [];

    const markTouched = (vi) => {
      if (vi >= vertCount || touchedSeen[vi]) return;
      touchedSeen[vi] = 1;
      touchedList.push(vi);
      const gId = this._weldGroupOf ? this._weldGroupOf[vi] : -1;
      if (gId >= 0) {
        const members = this._weldGroups[gId];
        for (let j = 0; j < members.length; j++) {
          const sib = members[j];
          if (!touchedSeen[sib]) {
            touchedSeen[sib] = 1;
            touchedList.push(sib);
          }
        }
      }
    };

    for (let k = 0; k < candidates.length; k++) {
      markTouched(candidates[k]);
    }

    for (let k = 0; k < touchedList.length; k++) {
      const vi = touchedList[k];
      // If vi already got computed via its weld group representative, skip duplicate math
      const gId = this._weldGroupOf ? this._weldGroupOf[vi] : -1;
      const groupMembers = gId >= 0 ? this._weldGroups[gId] : null;
      if (groupMembers && groupMembers[0] !== vi) continue;

      let sx = 0, sy = 0, sz = 0;
      const targets = groupMembers || [vi];
      for (let m = 0; m < targets.length; m++) {
        const tris = this._vertToTris[targets[m]];
        for (let ti = 0; ti < tris.length; ti++) {
          const t = tris[ti];
          const a = idxArr ? idxArr[t * 3] : t * 3;
          const b = idxArr ? idxArr[t * 3 + 1] : t * 3 + 1;
          const c = idxArr ? idxArr[t * 3 + 2] : t * 3 + 2;
          const ax = pos[a * 3], ay = pos[a * 3 + 1], az = pos[a * 3 + 2];
          const abx = pos[b * 3] - ax, aby = pos[b * 3 + 1] - ay, abz = pos[b * 3 + 2] - az;
          const acx = pos[c * 3] - ax, acy = pos[c * 3 + 1] - ay, acz = pos[c * 3 + 2] - az;
          sx += aby * acz - abz * acy;
          sy += abz * acx - abx * acz;
          sz += abx * acy - aby * acx;
        }
      }

      const len = Math.hypot(sx, sy, sz);
      const nx = len > 1e-8 ? sx / len : 0;
      const ny = len > 1e-8 ? sy / len : 1;
      const nz = len > 1e-8 ? sz / len : 0;

      for (let m = 0; m < targets.length; m++) {
        const base = targets[m] * 3;
        wn[base] = nx;
        wn[base + 1] = ny;
        wn[base + 2] = nz;
        if (normArr) {
          normArr[base] = nx;
          normArr[base + 1] = ny;
          normArr[base + 2] = nz;
        }
      }
    }

    if (normAttr) normAttr.needsUpdate = true;
  }

  _syncWeldedPositions(positions, candidates) {
    if (!this._weldGroupOf || this._weldGroups.length === 0) return;
    if (candidates && candidates.length > 0) {
      for (let i = 0; i < candidates.length; i++) {
        const vi = candidates[i];
        const gId = this._weldGroupOf[vi];
        if (gId < 0) continue;
        const members = this._weldGroups[gId];
        if (members[0] !== vi) continue;
        let sx = 0, sy = 0, sz = 0;
        for (let j = 0; j < members.length; j++) {
          const b = members[j] * 3;
          sx += positions[b]; sy += positions[b + 1]; sz += positions[b + 2];
        }
        const inv = 1 / members.length;
        sx *= inv; sy *= inv; sz *= inv;
        for (let j = 0; j < members.length; j++) {
          const b = members[j] * 3;
          positions[b] = sx; positions[b + 1] = sy; positions[b + 2] = sz;
        }
      }
      return;
    }

    for (let g = 0; g < this._weldGroups.length; g++) {
      const members = this._weldGroups[g];
      let sx = 0, sy = 0, sz = 0;
      for (let j = 0; j < members.length; j++) {
        const b = members[j] * 3;
        sx += positions[b]; sy += positions[b + 1]; sz += positions[b + 2];
      }
      const inv = 1 / members.length;
      sx *= inv; sy *= inv; sz *= inv;
      for (let j = 0; j < members.length; j++) {
        const b = members[j] * 3;
        positions[b] = sx; positions[b + 1] = sy; positions[b + 2] = sz;
      }
    }
  }

  _syncWeldedMask(mask, candidates) {
    if (!this._weldGroupOf || this._weldGroups.length === 0) return;
    if (candidates && candidates.length > 0) {
      for (let i = 0; i < candidates.length; i++) {
        const gId = this._weldGroupOf[candidates[i]];
        if (gId < 0) continue;
        const members = this._weldGroups[gId];
        if (members[0] !== candidates[i]) continue;
        let sum = 0;
        for (let j = 0; j < members.length; j++) sum += mask[members[j]];
        const avg = sum / members.length;
        for (let j = 0; j < members.length; j++) mask[members[j]] = avg;
      }
      return;
    }

    for (let g = 0; g < this._weldGroups.length; g++) {
      const members = this._weldGroups[g];
      let sum = 0;
      for (let j = 0; j < members.length; j++) sum += mask[members[j]];
      const avg = sum / members.length;
      for (let j = 0; j < members.length; j++) mask[members[j]] = avg;
    }
  }

  _ensureMaskArray(mesh, vertCount) {
    if (!mesh.userData) mesh.userData = {};
    if (!(mesh.userData.sculptMask instanceof Float32Array) || mesh.userData.sculptMask.length !== vertCount) {
      mesh.userData.sculptMask = new Float32Array(vertCount);
    }
    return mesh.userData.sculptMask;
  }

  _attachMaskColors(mesh) {
    const geom = mesh?.geometry;
    if (!geom?.attributes?.position) return;

    const vertCount = geom.attributes.position.count;
    const mask = this._ensureMaskArray(mesh, vertCount);

    if (!mesh.userData) mesh.userData = {};
    // Clone shared MatCap singleton if needed so mask vertexColors never pollute other meshes
    if (mesh.material?.userData?.isMatCapMaterial && !mesh.userData.__sculptOrigMat) {
      mesh.userData.__sculptOrigMat = mesh.material;
      const matClone = mesh.material.clone();
      matClone.userData = { ...(matClone.userData || {}), isSculptMaskMatClone: true };
      mesh.material = matClone;
    }

    if (mesh.material && mesh.userData.__sculptOrigVertexColors === undefined) {
      mesh.userData.__sculptOrigVertexColors = !!mesh.material.vertexColors;
    }

    this._createdColorAttr = false;
    if (geom.attributes.color && geom.attributes.color.count === vertCount) {
      if (!mesh.userData.__sculptOrigColorArray) {
        mesh.userData.__sculptOrigColorArray = geom.attributes.color.array.slice();
      }
    } else {
      const colors = new Float32Array(vertCount * 3);
      colors.fill(1.0);
      geom.setAttribute('color', new THREE.BufferAttribute(colors, 3));
      this._createdColorAttr = true;
    }

    if (mesh.material && !mesh.material.vertexColors) {
      mesh.material.vertexColors = true;
      mesh.material.needsUpdate = true;
    }

    this._syncMaskColors(geom, mask, null, mesh.userData.__sculptOrigColorArray);
  }

  _detachMaskColors(mesh) {
    const geom = mesh?.geometry;
    if (geom && this._createdColorAttr && geom.attributes.color) {
      geom.deleteAttribute('color');
      delete mesh.userData?.__sculptOrigColorArray;
    } else if (geom?.attributes?.color && mesh?.userData?.__sculptOrigColorArray) {
      const orig = mesh.userData.__sculptOrigColorArray;
      if (geom.attributes.color.array.length === orig.length) {
        geom.attributes.color.array.set(orig);
        geom.attributes.color.needsUpdate = true;
      }
      delete mesh.userData.__sculptOrigColorArray;
    }
    this._createdColorAttr = false;

    if (mesh?.userData?.__sculptOrigMat) {
      const clone = mesh.material;
      mesh.material = mesh.userData.__sculptOrigMat;
      delete mesh.userData.__sculptOrigMat;
      delete mesh.userData.__sculptOrigVertexColors;
      if (clone?.userData?.isSculptMaskMatClone) {
        try { clone.dispose(); } catch (_) {}
      }
    } else if (mesh?.material && mesh.userData?.__sculptOrigVertexColors !== undefined) {
      const origVC = !!mesh.userData.__sculptOrigVertexColors;
      delete mesh.userData.__sculptOrigVertexColors;
      if (mesh.material.vertexColors !== origVC) {
        mesh.material.vertexColors = origVC;
        mesh.material.needsUpdate = true;
      }
    }
  }

  _syncMaskColors(geom, mask, candidates = null, baseColors = null) {
    const colorAttr = geom?.attributes?.color;
    if (!colorAttr) return;
    const arr = colorAttr.array;
    const stride = colorAttr.itemSize || 3;
    const saved = baseColors || this.targetMesh?.userData?.__sculptOrigColorArray || null;

    if (candidates && candidates.length > 0) {
      for (let k = 0; k < candidates.length; k++) {
        const vi = candidates[k];
        if (vi >= mask.length) continue;
        const shade = 1.0 - 0.68 * Math.max(0, Math.min(1, mask[vi]));
        const base = vi * stride;
        arr[base] = (saved ? saved[base] : 1.0) * shade;
        arr[base + 1] = (saved ? saved[base + 1] : 1.0) * shade;
        arr[base + 2] = (saved ? saved[base + 2] : 1.0) * shade;
      }
    } else {
      for (let i = 0; i < mask.length; i++) {
        const shade = 1.0 - 0.68 * Math.max(0, Math.min(1, mask[i]));
        const base = i * stride;
        arr[base] = (saved ? saved[base] : 1.0) * shade;
        arr[base + 1] = (saved ? saved[base + 1] : 1.0) * shade;
        arr[base + 2] = (saved ? saved[base + 2] : 1.0) * shade;
      }
    }
    colorAttr.needsUpdate = true;
  }

  _onHistoryMeshUpdate(mesh) {
    if (this.isActive && this.targetMesh === mesh) {
      this._buildSculptTopology(mesh.geometry);
      this._attachMaskColors(mesh);
    }
    this._requestRender();
  }

  _onHistoryMaskUpdate(mesh) {
    if (this.isActive && this.targetMesh === mesh && mesh?.geometry) {
      this._syncMaskColors(mesh.geometry, this._ensureMaskArray(mesh, mesh.geometry.attributes.position.count));
    }
    this._requestRender();
  }

  _onHistoryGeometryUpdate(mesh) {
    if (this.isActive && this.targetMesh === mesh) {
      this._buildSculptTopology(mesh.geometry);
      this._attachMaskColors(mesh);
    }
    this._requestRender();
  }

  /**
   * Pure JS fallback evaluating the exact same 10 Sculpt 2.0 brushes when WASM isn't loaded yet.
   */
  _evalBrushJS({
    positions,
    normals,
    mask,
    basePositions,
    candidates,
    brush,
    center,
    normal,
    delta,
    radius,
    strength,
    dir
  }) {
    if (radius <= 1e-6) return 0;
    const vertCount = (positions.length / 3) | 0;
    const radiusSq = radius * radius;
    const invRadius = 1.0 / radius;
    const strengthFactor = strength * 0.15 * radius;

    let [nx, ny, nz] = normal;
    const nLen = Math.hypot(nx, ny, nz);
    if (nLen > 1e-6) {
      nx /= nLen; ny /= nLen; nz /= nLen;
    } else {
      nx = 0; ny = 1; nz = 0;
    }
    const [cx, cy, cz] = center;
    const [dx, dy, dz] = delta;
    const loopLen = candidates ? candidates.length : vertCount;

    let avgX = cx, avgY = cy, avgZ = cz;
    if (brush === 'smooth' || brush === 'flatten') {
      let sx = 0, sy = 0, sz = 0, count = 0;
      for (let k = 0; k < loopLen; k++) {
        const vi = candidates ? candidates[k] : k;
        if (vi >= vertCount) continue;
        const b = vi * 3;
        const px = positions[b], py = positions[b + 1], pz = positions[b + 2];
        const dSq = (px - cx) ** 2 + (py - cy) ** 2 + (pz - cz) ** 2;
        if (dSq < radiusSq) {
          sx += px; sy += py; sz += pz;
          count++;
        }
      }
      if (count > 0) {
        avgX = sx / count;
        avgY = sy / count;
        avgZ = sz / count;
      }
    }

    let modified = 0;
    for (let k = 0; k < loopLen; k++) {
      const vi = candidates ? candidates[k] : k;
      if (vi >= vertCount) continue;
      const b = vi * 3;

      const rx = brush === 'grab' && basePositions ? basePositions[b] : positions[b];
      const ry = brush === 'grab' && basePositions ? basePositions[b + 1] : positions[b + 1];
      const rz = brush === 'grab' && basePositions ? basePositions[b + 2] : positions[b + 2];

      const ox = rx - cx, oy = ry - cy, oz = rz - cz;
      const dSq = ox * ox + oy * oy + oz * oz;
      if (dSq >= radiusSq) continue;

      const normDist = Math.sqrt(dSq) * invRadius;
      const oneMinusD2 = 1.0 - normDist * normDist;
      const falloff = oneMinusD2 * oneMinusD2;

      if (brush === 'mask') {
        mask[vi] = Math.max(0, Math.min(1, mask[vi] + dir * falloff * strength * 0.5));
        modified++;
        continue;
      }

      const maskVal = Math.max(0, Math.min(1, mask[vi]));
      if (maskVal >= 0.999) continue;
      const maskAtt = 1.0 - maskVal;
      const w = falloff * maskAtt;

      switch (brush) {
        case 'draw': {
          const s = dir * w * strengthFactor;
          positions[b] += nx * s;
          positions[b + 1] += ny * s;
          positions[b + 2] += nz * s;
          modified++;
          break;
        }
        case 'grab': {
          if (basePositions) {
            positions[b] = basePositions[b] + dx * w;
            positions[b + 1] = basePositions[b + 1] + dy * w;
            positions[b + 2] = basePositions[b + 2] + dz * w;
          } else {
            positions[b] += dx * w;
            positions[b + 1] += dy * w;
            positions[b + 2] += dz * w;
          }
          modified++;
          break;
        }
        case 'inflate': {
          const vnx = normals ? normals[b] : nx;
          const vny = normals ? normals[b + 1] : ny;
          const vnz = normals ? normals[b + 2] : nz;
          const s = dir * w * strengthFactor;
          positions[b] += vnx * s;
          positions[b + 1] += vny * s;
          positions[b + 2] += vnz * s;
          modified++;
          break;
        }
        case 'smooth': {
          const t = Math.min(1, Math.max(0, w * strength * 0.4));
          positions[b] += (avgX - rx) * t;
          positions[b + 1] += (avgY - ry) * t;
          positions[b + 2] += (avgZ - rz) * t;
          modified++;
          break;
        }
        case 'flatten': {
          const dPlane = (rx - avgX) * nx + (ry - avgY) * ny + (rz - avgZ) * nz;
          const t = Math.min(1, Math.max(0, w * strength * 0.5));
          positions[b] -= nx * dPlane * t;
          positions[b + 1] -= ny * dPlane * t;
          positions[b + 2] -= nz * dPlane * t;
          modified++;
          break;
        }
        case 'clay': {
          const stripFalloff = Math.max(0, 1.0 - normDist * normDist * normDist) * maskAtt;
          const planeOffset = dir * radius * 0.15;
          const dPlane = ((rx - cx) * nx + (ry - cy) * ny + (rz - cz) * nz) - planeOffset;
          const t = Math.min(1, Math.max(0, stripFalloff * strength * 0.6));
          positions[b] -= nx * dPlane * t;
          positions[b + 1] -= ny * dPlane * t;
          positions[b + 2] -= nz * dPlane * t;
          modified++;
          break;
        }
        case 'pinch': {
          const tx = cx - rx, ty = cy - ry, tz = cz - rz;
          const dotN = tx * nx + ty * ny + tz * nz;
          const t = dir * w * strength * 0.35;
          positions[b] += (tx - nx * dotN) * t;
          positions[b + 1] += (ty - ny * dotN) * t;
          positions[b + 2] += (tz - nz * dotN) * t;
          modified++;
          break;
        }
        case 'crease': {
          const tx = cx - rx, ty = cy - ry, tz = cz - rz;
          const dotN = tx * nx + ty * ny + tz * nz;
          const pw = w * strength * 0.25;
          const fw = dir * w * falloff * strengthFactor * 0.95;
          positions[b] += (tx - nx * dotN) * pw + nx * fw;
          positions[b + 1] += (ty - ny * dotN) * pw + ny * fw;
          positions[b + 2] += (tz - nz * dotN) * pw + nz * fw;
          modified++;
          break;
        }
        case 'snake_hook': {
          const hookGain = w * (0.85 + 0.35 * strength);
          const lift = dir * w * strength * 0.04 * radius;
          positions[b] += dx * hookGain + nx * lift;
          positions[b + 1] += dy * hookGain + ny * lift;
          positions[b + 2] += dz * hookGain + nz * lift;
          modified++;
          break;
        }
        default:
          break;
      }
    }

    return modified;
  }

  // -------------------------------------------------------------------------
  // Pointer Raycasting & Interactive Canvas Handlers
  // -------------------------------------------------------------------------

  _updateMouse(e) {
    const canvas = this.engine?.renderer?.domElement;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    this.mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    this.mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
  }

  _raycastTarget() {
    if (!this.targetMesh || !this.engine?.camera) return null;
    this.raycaster.setFromCamera(this.mouse, this.engine.camera);
    this.raycaster.firstHitOnly = true;
    const intersects = this.raycaster.intersectObject(this.targetMesh, false);
    this.raycaster.firstHitOnly = false;
    return intersects.length > 0 ? intersects[0] : null;
  }

  _updateCursor(hit) {
    if (!this.brushCursor) return;
    if (!hit) {
      this.brushCursor.visible = false;
      return;
    }

    this.brushCursor.visible = true;
    this.brushCursor.position.copy(hit.point);

    const normal = hit.face.normal.clone();
    normal.transformDirection(this.targetMesh.matrixWorld).normalize();
    this.brushCursor.position.addScaledVector(normal, 0.005);
    this.brushCursor.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), normal);
    this._updateCursorScale();
  }

  _updateCursorScale() {
    if (this.brushCursor) {
      this.brushCursor.scale.setScalar(this.radius);
    }
  }

  _onPointerDown(e) {
    if (!this.isActive) return;

    if (this._radiusModal) {
      if (e.button === 0) {
        this._radiusModal = null;
      } else if (e.button === 2) {
        this.setRadius(this._radiusModal.startRadius);
        this._radiusModal = null;
      }
      return;
    }

    if (e.button !== 0 || e.altKey) return;

    this._updateMouse(e);
    const hit = this._raycastTarget();
    if (!hit) return;

    if (this.engine?.controls) {
      this.engine.controls.enabled = false;
    }

    this.isSculpting = true;
    this._hasMovedDuringStroke = false;
    this._invertStroke = e.ctrlKey || e.metaKey;
    if (e.shiftKey && !this._invertStroke && !e.altKey && this.brushType !== 'smooth') {
      this._tempBrush = 'smooth';
    } else if (!e.shiftKey && this._tempBrush === 'smooth') {
      this._tempBrush = null;
    }

    const pressure = (e.pointerType === 'pen' && Number.isFinite(e.pressure) && e.pressure > 0)
      ? Math.max(0.15, Math.min(1.5, e.pressure))
      : 1.0;

    const geom = this.targetMesh.geometry;
    const effectiveBrush = this._tempBrush || this.brushType;

    this._strokeStartPositions = new Float32Array(geom.attributes.position.array);
    this._strokeStartMask = new Float32Array(
      this._ensureMaskArray(this.targetMesh, geom.attributes.position.count)
    );
    this._dyntopoTopologyChanged = false;
    this._strokeStartGeometry = this.dyntopoEnabled ? geom.clone() : null;

    const camDir = new THREE.Vector3();
    this.engine.camera.getWorldDirection(camDir);
    this._grabStartPoint = hit.point.clone();
    this._prevDragPointWorld = hit.point.clone();
    this._lastDabPointWorld = hit.point.clone();
    this._grabPlane.setFromNormalAndCoplanarPoint(camDir, hit.point);

    if (effectiveBrush === 'grab') {
      this._grabBasePositions = new Float32Array(geom.attributes.position.array);

      this.targetMesh.updateMatrixWorld(true);
      this._invMatrix.copy(this.targetMesh.matrixWorld).invert();
      const localPt = hit.point.clone().applyMatrix4(this._invMatrix);
      this.targetMesh.getWorldScale(this._tmpWorldScale);
      const maxScale = Math.max(
        1e-4,
        Math.abs(this._tmpWorldScale.x),
        Math.abs(this._tmpWorldScale.y),
        Math.abs(this._tmpWorldScale.z)
      );
      const localRad = this.radius / maxScale;
      this._grabCandidates = this._collectCandidateVertices(geom, [localPt.x, localPt.y, localPt.z], localRad);
      this._grabMirrorCandidates = this.symmetryX
        ? this._collectCandidateVertices(geom, [-localPt.x, localPt.y, localPt.z], localRad)
        : null;
    } else {
      this._applyBrush(hit, pressure);
    }
  }

  _onPointerMove(e) {
    if (!this.isActive) return;

    this._updateMouse(e);

    if (this._radiusModal) {
      const dx = (e.clientX || 0) - this._radiusModal.startX;
      this.setRadius(this._radiusModal.startRadius * Math.exp(dx * 0.008));
      this._requestRender();
      return;
    }

    const hit = this._raycastTarget();
    this._updateCursor(hit);

    if (!this.isSculpting) return;

    const pressure = (e.pointerType === 'pen' && Number.isFinite(e.pressure) && e.pressure > 0)
      ? Math.max(0.15, Math.min(1.5, e.pressure))
      : 1.0;

    const effectiveBrush = this._tempBrush || this.brushType;
    if (effectiveBrush === 'grab' || effectiveBrush === 'snake_hook') {
      this.raycaster.setFromCamera(this.mouse, this.engine.camera);
      const dragPt = new THREE.Vector3();
      if (this.raycaster.ray.intersectPlane(this._grabPlane, dragPt)) {
        if (effectiveBrush === 'grab') {
          this._applyBrush({
            point: this._grabStartPoint,
            face: { normal: new THREE.Vector3(0, 1, 0) },
            object: this.targetMesh,
            dragDeltaWorld: dragPt.clone().sub(this._grabStartPoint)
          }, pressure);
        } else {
          const stepDelta = dragPt.clone().sub(this._prevDragPointWorld || this._grabStartPoint);
          this._prevDragPointWorld = dragPt.clone();
          const strokeHit = hit || {
            point: dragPt,
            face: { normal: new THREE.Vector3(0, 1, 0) },
            object: this.targetMesh
          };
          this._applyBrush({
            ...strokeHit,
            dragDeltaWorld: stepDelta
          }, pressure);
        }
      }
    } else if (hit) {
      // Dab spacing + smooth sub-stepping along fast drags
      const spacing = Math.max(0.015, this.radius * 0.25);
      if (!this._lastDabPointWorld) {
        this._lastDabPointWorld = hit.point.clone();
        this._applyBrush(hit, pressure);
        return;
      }
      const dist = hit.point.distanceTo(this._lastDabPointWorld);
      if (dist < spacing * 0.45) return;

      const steps = Math.min(6, Math.max(1, Math.floor(dist / spacing)));
      const fromPt = this._lastDabPointWorld.clone();
      for (let s = 1; s <= steps; s++) {
        const pt = fromPt.clone().lerp(hit.point, s / steps);
        this._applyBrush({ point: pt, face: hit.face, object: hit.object }, pressure);
      }
      this._lastDabPointWorld.copy(hit.point);
    }
  }

  _onPointerUp(e) {
    if (!this.isActive) return;

    if (this.isSculpting && this._hasMovedDuringStroke && this.targetMesh) {
      const effectiveBrush = this._tempBrush || this.brushType;
      if (effectiveBrush === 'mask') {
        const endMask = this.targetMesh.userData?.sculptMask;
        if (this.sceneManager && this._strokeStartMask && endMask) {
          this.sceneManager.executeCommand(
            new SculptMaskCommand(
              this.targetMesh,
              this._strokeStartMask,
              endMask,
              (m) => this._onHistoryMaskUpdate(m)
            )
          );
        }
      } else if (this._dyntopoTopologyChanged && this._strokeStartGeometry && this.sceneManager) {
        this.sceneManager.executeCommand(
          new SculptRemeshCommand(
            this.targetMesh,
            this._strokeStartGeometry,
            this.targetMesh.geometry,
            this._strokeStartMask,
            this.targetMesh.userData?.sculptMask,
            (m) => this._onHistoryGeometryUpdate(m)
          )
        );
      } else {
        this._strokeStartGeometry?.dispose?.();
        const endPositions = this.targetMesh.geometry.attributes.position.array;
        if (this.sceneManager && this._strokeStartPositions) {
          this.sceneManager.executeCommand(
            new SculptCommand(
              this.targetMesh,
              this._strokeStartPositions,
              endPositions,
              (m) => this._onHistoryMeshUpdate(m)
            )
          );
        }
      }
      this._syncMultiresDeltas(this.targetMesh);
    }

    this.isSculpting = false;
    if (this.engine?.syncViewportPaneControls) {
      this.engine.syncViewportPaneControls();
    } else if (this.engine?.controls) {
      this.engine.controls.enabled = true;
    }
    this._dyntopoTopologyChanged = false;
    this._strokeStartGeometry = null;
    this._strokeStartPositions = null;
    this._strokeStartMask = null;
    this._grabBasePositions = null;
    this._grabStartPoint = null;
    this._grabCandidates = null;
    this._grabMirrorCandidates = null;
    this._prevDragPointWorld = null;
    this._lastDabPointWorld = null;
    this._hasMovedDuringStroke = false;
    this._invertStroke = false;
    if ((!e || !e.shiftKey) && this._tempBrush === 'smooth') {
      this._tempBrush = null;
    }
  }

  _applyBrush(hit, pressure = 1.0) {
    if (!this.targetMesh) return;
    const effectiveBrush = this._tempBrush || this.brushType;

    const modified = this.applyStroke(hit, {
      brush: effectiveBrush,
      delta: hit.dragDeltaWorld || null,
      strength: this.strength * pressure,
      basePositions: effectiveBrush === 'grab' ? this._grabBasePositions : null,
      candidates: effectiveBrush === 'grab' ? this._grabCandidates : null,
      mirrorCandidates: effectiveBrush === 'grab' ? this._grabMirrorCandidates : null,
      recordUndo: false
    });

    if (modified > 0) {
      this._hasMovedDuringStroke = true;
    }
  }

  // -------------------------------------------------------------------------
  // Blender-Standard Sculpt Mode Keyboard Shortcuts
  // -------------------------------------------------------------------------

  _onKeyDown(e) {
    if (!this.isActive) return;

    const tag = e.target?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || e.target?.isContentEditable) {
      return;
    }

    const isCtrl = e.ctrlKey || e.metaKey;
    const lower = e.key.toLowerCase();

    if (e.key === 'Control') {
      this._invertStroke = true;
      return;
    }
    if (e.key === 'Shift' && !isCtrl && !e.altKey) {
      if (this.brushType !== 'smooth' && !this._tempBrush) {
        this._tempBrush = 'smooth';
      }
      return;
    }

    // Undo / Redo while in Sculpt Mode (engine.js passes key ownership here)
    if (isCtrl && lower === 'z') {
      e.preventDefault();
      if (this.sceneManager) {
        if (e.shiftKey) this.sceneManager.redo();
        else this.sceneManager.undo();
      }
      return;
    }
    if (isCtrl && lower === 'y') {
      e.preventDefault();
      if (this.sceneManager) this.sceneManager.redo();
      return;
    }

    // Voxel Remesh (Ctrl+R) & Mask operations (Ctrl+I, Alt+M)
    if (isCtrl && lower === 'r') {
      e.preventDefault();
      this.voxelRemesh(this.voxelSize);
      return;
    }
    if (isCtrl && lower === 'i') {
      e.preventDefault();
      this.invertMask();
      return;
    }
    if (e.altKey && !isCtrl && lower === 'm') {
      e.preventDefault();
      this.clearMask();
      return;
    }

    // Radius & Strength adjustments ([ / ] and Shift+[ / Shift+])
    const isSizeDown = e.key === '[' && !e.shiftKey;
    const isSizeUp = e.key === ']' && !e.shiftKey;
    const isStrengthDown = e.key === '{' || (e.key === '[' && e.shiftKey);
    const isStrengthUp = e.key === '}' || (e.key === ']' && e.shiftKey);

    if (isSizeDown) {
      this.setRadius(this.radius - 0.05);
      return;
    }
    if (isSizeUp) {
      this.setRadius(this.radius + 0.05);
      return;
    }
    if (isStrengthDown) {
      this.setStrength(this.strength - 0.05);
      return;
    }
    if (isStrengthUp) {
      this.setStrength(this.strength + 0.05);
      return;
    }

    if (isCtrl || e.altKey) return;

    // Single-key Blender Sculpt brush shortcuts
    if (e.shiftKey && lower === 'c') {
      this.setBrush('crease');
    } else if (e.shiftKey && lower === 't') {
      this.setBrush('flatten');
    } else if (lower === 'x' || e.key === '1') {
      this.setBrush('draw');
    } else if (lower === 'g' || e.key === '2') {
      this.setBrush('grab');
    } else if (lower === 'i' || e.key === '3') {
      this.setBrush('inflate');
    } else if (lower === 's' || e.key === '4') {
      this.setBrush('smooth');
    } else if (e.key === '5') {
      this.setBrush('flatten');
    } else if (lower === 'c' || e.key === '6') {
      this.setBrush('clay');
    } else if (lower === 'p' || e.key === '7') {
      this.setBrush('pinch');
    } else if (e.key === '8') {
      this.setBrush('crease');
    } else if (lower === 'k' || e.key === '9') {
      this.setBrush('snake_hook');
    } else if (lower === 'm' || e.key === '0') {
      this.setBrush('mask');
    } else if (lower === 'f' && !e.shiftKey) {
      if (this._radiusModal) {
        this._radiusModal = null;
      } else {
        const rect = this.engine?.renderer?.domElement?.getBoundingClientRect?.();
        const cx = rect ? rect.left + (this.mouse.x * 0.5 + 0.5) * rect.width : 0;
        this._radiusModal = { startX: cx, startRadius: this.radius };
      }
      this._requestRender();
    } else if (e.key === 'Escape' && this._radiusModal) {
      this.setRadius(this._radiusModal.startRadius);
      this._radiusModal = null;
      this._requestRender();
    } else if (e.key === 'Enter' && this._radiusModal) {
      this._radiusModal = null;
    }
  }

  _onKeyUp(e) {
    if (!this.isActive) return;
    if (e.key === 'Control') {
      this._invertStroke = false;
    }
    if (e.key === 'Shift' && this._tempBrush) {
      this._tempBrush = null;
    }
  }

  // -------------------------------------------------------------------------
  // DOM Toolbar Sync Helpers (guarded for headless Node tests)
  // -------------------------------------------------------------------------

  _syncBrushButtons() {
    if (typeof document === 'undefined') return;
    const btns = document.querySelectorAll('.sculpt-brush-btn');
    btns.forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.brush === this.brushType);
    });
  }

  _syncSculptSliders() {
    if (typeof document === 'undefined') return;
    const radiusSlider = document.getElementById('slider-sculpt-radius');
    const radiusVal = document.getElementById('val-sculpt-radius');
    if (radiusSlider) radiusSlider.value = this.radius.toFixed(2);
    if (radiusVal) radiusVal.textContent = this.radius.toFixed(2);

    const strengthSlider = document.getElementById('slider-sculpt-strength');
    const strengthVal = document.getElementById('val-sculpt-strength');
    if (strengthSlider) strengthSlider.value = this.strength.toFixed(2);
    if (strengthVal) strengthVal.textContent = this.strength.toFixed(2);

    const voxelInput = document.getElementById('input-sculpt-voxel-size');
    if (voxelInput && document.activeElement !== voxelInput) {
      voxelInput.value = this.voxelSize < 0.05 ? this.voxelSize.toFixed(3) : this.voxelSize.toFixed(2);
    }
  }

  _updateToolbarUI(visible) {
    if (typeof document === 'undefined') return;
    document.body.classList.toggle('sculpt-mode-active', !!visible);
    const sculptGroup = document.getElementById('sculpt-mode-selector-group');
    if (sculptGroup) {
      sculptGroup.style.display = visible ? 'flex' : 'none';
    }
    const modeSelect = document.getElementById('viewport-mode');
    if (modeSelect) {
      if (visible) modeSelect.value = 'sculpt';
      else if (modeSelect.value === 'sculpt') modeSelect.value = 'object';
    }
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('blender:mode-changed', {
        detail: { mode: visible ? 'sculpt' : 'object' }
      }));
    }
    this._syncBrushButtons();
    this.setSymmetry(this.symmetryX);
  }

  _syncMultiresDeltas(mesh) {
    const stack = mesh?.userData?.modifierStack;
    if (!Array.isArray(stack) || !mesh.userData?.baseGeometry) return false;
    const mrMod = stack.find((m) => m.enabled !== false && m.type === 'multires');
    if (!mrMod) return false;
    const lvl = Math.max(1, Math.min(4, Math.floor(mrMod.params?.levels ?? 1)));
    const baseAtLvl = subdivideCatmullClark(mesh.userData.baseGeometry, { levels: lvl, subdivisionType: 'catmull-clark', uvSmooth: true });
    try {
      const bp = baseAtLvl.attributes?.position;
      const cp = mesh.geometry?.attributes?.position;
      if (!bp || !cp || bp.count !== cp.count) return false;
      const deltas = new Array(cp.count * 3);
      for (let i = 0; i < cp.count; i++) {
        deltas[i * 3] = cp.getX(i) - bp.getX(i);
        deltas[i * 3 + 1] = cp.getY(i) - bp.getY(i);
        deltas[i * 3 + 2] = cp.getZ(i) - bp.getZ(i);
      }
      if (!mrMod.params.deltas) mrMod.params.deltas = {};
      mrMod.params.deltas[String(lvl)] = deltas;
      return true;
    } finally {
      baseAtLvl.dispose();
    }
  }

  _requestRender() {
    if (this.engine?.requestRender) {
      this.engine.requestRender();
    }
  }
}
