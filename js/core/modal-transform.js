/**
 * Web Blender Studio - Modal Transform Manager (Blender Standard G / R / S)
 * File: js/core/modal-transform.js
 * 
 * Implements Blender 4.x/5.x Modal Transform System:
 * - G (Grab / Translate)
 * - R (Rotate)
 * - S (Scale)
 * - Axis Locking: X, Y, Z (Press 1x for Global, 2x for Local, 3x to Unlock)
 * - Plane Locking: Shift + X (YZ), Shift + Y (XZ), Shift + Z (XY)
 * - Precision Mode: Hold Shift (0.1x scale)
 * - Increment Snapping: Hold Ctrl (0.5m/1.0m, 5°/15°, 0.1 scale)
 * - Direct Numeric Input: Type numbers (e.g. "1.5", "-3", ".25") + Backspace
 * - Confirmation: Enter, Space, or Left-Click
 * - Cancellation: Esc or Right-Click (Restores original transform)
 * - Visual Guides: 3D colored infinite axis lines + Pivot-to-mouse dotted guide
 * - Viewport HUD: Real-time feedback status bar in the 3D viewport
 */

import * as THREE from 'three';
import { TransformCommand, MultiTransformCommand } from './scene-manager.js';

export class ModalTransformManager {
  constructor(options = {}) {
    this.engine = options.engine || null;
    this.sceneManager = options.sceneManager || null;
    this.editMode = options.editMode || null;

    this.isActive = false;
    this.mode = null; // 'translate' | 'rotate' | 'scale'
    this.targetObject = null;
    this.targetEntries = [];
    this.isEditModeProxy = false;

    // Initial transform snapshot
    this.initialState = {
      position: new THREE.Vector3(),
      quaternion: new THREE.Quaternion(),
      scale: new THREE.Vector3(),
      worldPivot: new THREE.Vector3(),
      worldQuat: null
    };

    // Coordinate constraint
    // null | 'X' | 'Y' | 'Z' | 'XY' | 'XZ' | 'YZ' | 'CUSTOM'
    this.axisLock = null;
    this.isLocalAxis = false;
    this.orientation = 'world'; // 'world' | 'local' | 'normal' | 'gimbal' | 'view' | 'cursor'
    this.customAxisDir = null;

    // Mouse coordinates tracking
    this.startMousePos = { x: 0, y: 0 };
    this.currentMousePos = { x: 0, y: 0 };
    this.pivotScreenPos = { x: 0, y: 0 };

    // 3D Raycasting reference planes
    this.viewPlane = new THREE.Plane();
    this.startHitPoint = new THREE.Vector3();
    this.currentHitPoint = new THREE.Vector3();
    this.raycaster = new THREE.Raycaster();

    // Numeric input buffer (e.g., "-1.5")
    this.numericInput = '';
    this.hasNumericInput = false;

    // Pro Blender modes: GG Edge/Vertex Slide + Cursor Pivot + Persistent Snap
    this.isSlideMode = false;
    this.slideClamp = true;
    this._pivotWorldOrigin = new THREE.Vector3();

    // Visual helpers in 3D Scene
    this.helperGroup = new THREE.Group();
    this.helperGroup.name = 'ModalTransform_Helpers';
    this.helperGroup.userData.isSystemObject = true;
    this.axisLine = null;
    this.mouseGuideLine = null;

    // Viewport HUD DOM elements
    this.hudElement = null;

    // Bound event handlers
    this._onPointerMove = this._onPointerMove.bind(this);
    this._onPointerDown = this._onPointerDown.bind(this);
    this._onKeyDown = this._onKeyDown.bind(this);
    this._onContextMenu = this._onContextMenu.bind(this);

    this._initVisualHelpers();
    this._initHUD();
  }

  /**
   * Bind Engine, SceneManager, and EditMode
   */
  bind(engine, sceneManager, editMode) {
    this.engine = engine;
    this.sceneManager = sceneManager;
    this.editMode = editMode;
    if (this.engine && this.engine.scene && !this.helperGroup.parent) {
      this.engine.scene.add(this.helperGroup);
    }
  }

  // =========================================================================
  // 1. MODAL ACTIVATION & LIFECYCLE
  // =========================================================================

  /**
   * Start a modal transformation
   * @param {'translate'|'rotate'|'scale'} mode
   * @param {{axisLock?:string|null,customAxisDir?:THREE.Vector3|null,isLocalAxis?:boolean}} [options]
   * @returns {boolean} true if modal started successfully
   */
  start(mode, options = {}) {
    if (!['translate', 'rotate', 'scale'].includes(mode)) return false;
    if (!this.engine || !this.engine.camera || !this.engine.domElement) return false;

    // 1. Identify target object
    let target = null;
    this.isEditModeProxy = false;

    if (this.editMode && this.editMode.isActive) {
      if (this.editMode.gizmoProxy && this.editMode.getActiveVertexIndices().length > 0) {
        target = this.editMode.gizmoProxy;
        this.isEditModeProxy = true;
      }
    }

    if (!target && this.sceneManager) {
      target = this.sceneManager.getActiveObject();
    }

    if (!target) {
      // Nothing selected to transform
      return false;
    }

    // Build target entries: multi-select root objects (filtering ancestors to avoid
    // double-transforming children when parent + child are both selected).
    const rawTargets = (!this.isEditModeProxy && this.sceneManager?.getSelectedObjects)
      ? this.sceneManager.getSelectedObjects().filter((o) => o && !o.userData?.locked && !o.userData?.isSystemObject)
      : [target];
    if (!rawTargets.includes(target) && !target.userData?.locked) {
      rawTargets.unshift(target);
    }
    const rawSet = new Set(rawTargets);
    const rootTargets = this.isEditModeProxy
      ? [target]
      : rawTargets.filter((obj) => {
          let cur = obj.parent;
          while (cur) {
            if (rawSet.has(cur)) return false;
            cur = cur.parent;
          }
          return true;
        });

    this.targetObject = target;
    this.mode = mode;
    this.isActive = true;
    this.axisLock = options.axisLock || null;
    this.orientation = options.orientation || (typeof window !== 'undefined' && window.modelingSuite?.transformSpace) || 'world';
    this.isLocalAxis = options.isLocalAxis !== undefined ? Boolean(options.isLocalAxis) : (this.orientation !== 'world');
    this.customAxisDir = options.customAxisDir
      ? options.customAxisDir.clone().normalize()
      : null;
    if (this.customAxisDir && !this.axisLock) {
      this.axisLock = 'CUSTOM';
    }
    this.numericInput = '';
    this.hasNumericInput = false;
    this.isSlideMode = false;
    this.slideClamp = true;

    const captureEntry = (obj) => {
      obj.updateWorldMatrix(true, false);
      const worldPos = new THREE.Vector3();
      const worldQuat = new THREE.Quaternion();
      const worldScale = new THREE.Vector3();
      obj.matrixWorld.decompose(worldPos, worldQuat, worldScale);

      const parentInv = new THREE.Matrix4();
      const parentQuatInv = new THREE.Quaternion();
      if (obj.parent) {
        obj.parent.updateWorldMatrix(true, false);
        parentInv.copy(obj.parent.matrixWorld).invert();
        obj.parent.getWorldQuaternion(parentQuatInv).invert();
      }
      return {
        obj,
        position: obj.position.clone(),
        quaternion: obj.quaternion.clone(),
        scale: obj.scale.clone(),
        worldPos,
        worldQuat,
        worldScale,
        parentInv,
        parentQuatInv
      };
    };

    this.targetEntries = rootTargets.map(captureEntry);
    const activeEntry = this.targetEntries.find((e) => e.obj === target) || this.targetEntries[0];

    // 2. Snapshot initial state (for active object & compatibility)
    this.initialState.position.copy(target.position);
    this.initialState.quaternion.copy(target.quaternion);
    this.initialState.scale.copy(target.scale);
    if (activeEntry) {
      this.initialState.worldPivot.copy(activeEntry.worldPos);
      this.initialState.worldQuat = activeEntry.worldQuat.clone();
    } else {
      target.getWorldPosition(this.initialState.worldPivot);
      this.initialState.worldQuat = target.getWorldQuaternion(new THREE.Quaternion());
    }

    // Compute world pivot origin honoring pivotMode ('median' | 'active' | 'individual' | 'cursor')
    const pivotMode = this.engine?.pivotMode || 'median';
    const cursorPos = typeof window !== 'undefined' && window.modelingSuite?.cursorPos
      ? window.modelingSuite.cursorPos
      : null;
    if (pivotMode === 'cursor' && cursorPos) {
      this._pivotWorldOrigin.copy(cursorPos);
    } else if (pivotMode === 'active' || pivotMode === 'individual' || this.targetEntries.length <= 1) {
      this._pivotWorldOrigin.copy(this.initialState.worldPivot);
    } else {
      this._pivotWorldOrigin.set(0, 0, 0);
      for (const entry of this.targetEntries) {
        this._pivotWorldOrigin.add(entry.worldPos);
      }
      this._pivotWorldOrigin.divideScalar(this.targetEntries.length);
    }

    if (this.isEditModeProxy && this.editMode && typeof this.editMode.beginModalVertexSession === 'function') {
      this.editMode.beginModalVertexSession();
    }

    // 3. Compute screen pivot coordinates
    const camera = this.engine.camera;
    const dom = this.engine.domElement;
    const rect = dom.getBoundingClientRect();

    const projPivot = this._pivotWorldOrigin.clone().project(camera);
    this.pivotScreenPos = {
      x: rect.left + ((projPivot.x + 1) / 2) * rect.width,
      y: rect.top + ((-projPivot.y + 1) / 2) * rect.height
    };

    // 4. Capture current mouse position (live cursor first, falling back to last down pos)
    const ptr = this.engine.lastPointerClient ||
      ((this.engine.pointerDownPos?.x || this.engine.pointerDownPos?.y) ? this.engine.pointerDownPos : null);
    this.startMousePos = {
      x: ptr ? ptr.x : (this.pivotScreenPos.x + 30),
      y: ptr ? ptr.y : (this.pivotScreenPos.y + 30)
    };
    this.currentMousePos = { ...this.startMousePos };

    // 5. Setup View Plane passing through pivot facing camera
    const cameraDir = camera.getWorldDirection(new THREE.Vector3()).negate();
    this.viewPlane.setFromNormalAndCoplanarPoint(cameraDir, this._pivotWorldOrigin);

    // Initial raycast hit point on viewPlane
    const ndc = this._pixelToNDC(this.startMousePos.x, this.startMousePos.y, rect);
    this.raycaster.setFromCamera(ndc, camera);
    if (!this.raycaster.ray.intersectPlane(this.viewPlane, this.startHitPoint)) {
      this.startHitPoint.copy(this._pivotWorldOrigin);
    }
    this.currentHitPoint.copy(this.startHitPoint);

    // 6. Disable OrbitControls & Hide TransformControls Gizmo during modal
    if (this.engine.controls) {
      this.engine.controls.enabled = false;
    }
    if (this.engine.transformControls) {
      this.engine.transformControls.visible = false;
    }

    // 7. Attach event listeners
    window.addEventListener('pointermove', this._onPointerMove, { passive: false });
    window.addEventListener('pointerdown', this._onPointerDown, { capture: true });
    window.addEventListener('keydown', this._onKeyDown, { capture: true });
    window.addEventListener('contextmenu', this._onContextMenu, { capture: true });

    // 8. Show HUD and initial helpers
    this._showHUD();
    this._updateVisualHelpers();
    this._updateTransformation();

    console.log(`[ModalTransform] Started "${mode.toUpperCase()}" on "${target.name || 'Object'}"`);
    return true;
  }

  /**
   * Confirm and commit transformation
   */
  confirm() {
    if (!this.isActive) return;

    if (this.isSlideMode && this.isEditModeProxy && this.editMode && typeof this.editMode.commitSlideTransform === 'function') {
      this.editMode.commitSlideTransform();
      this._cleanup();
      console.log('[ModalTransform] Slide confirmed.');
      return;
    }

    const target = this.targetObject;
    if (!target) {
      this._cleanup();
      return;
    }

    const entries = this.targetEntries.length > 0 ? this.targetEntries : [{
      obj: target,
      position: this.initialState.position,
      quaternion: this.initialState.quaternion,
      scale: this.initialState.scale
    }];

    const changedEntries = [];
    for (const entry of entries) {
      const o = entry.obj;
      const pre = {
        position: entry.position.clone(),
        quaternion: entry.quaternion.clone(),
        scale: entry.scale.clone()
      };
      const post = {
        position: o.position.clone(),
        quaternion: o.quaternion.clone(),
        scale: o.scale.clone()
      };
      if (!pre.position.equals(post.position) || !pre.quaternion.equals(post.quaternion) || !pre.scale.equals(post.scale)) {
        changedEntries.push({ object: o, oldState: pre, newState: post });
      }
    }

    const activePreState = {
      position: this.initialState.position.clone(),
      quaternion: this.initialState.quaternion.clone(),
      scale: this.initialState.scale.clone()
    };
    const activePostState = {
      position: target.position.clone(),
      quaternion: target.quaternion.clone(),
      scale: target.scale.clone()
    };

    if (changedEntries.length > 0 && this.sceneManager && !this.isEditModeProxy) {
      const onUpdate = () => {
        if (this.engine) this.engine.updateSelectionHelper();
      };
      const cmd = changedEntries.length === 1
        ? new TransformCommand(changedEntries[0].object, changedEntries[0].oldState, changedEntries[0].newState, onUpdate)
        : new MultiTransformCommand(changedEntries, onUpdate, `Modal ${this.mode} (${changedEntries.length} objects)`);
      this.sceneManager.executeCommand(cmd);
    } else if (target && !this.isEditModeProxy) {
      for (const entry of entries) {
        this._emitObjectTransformed(entry.obj, 'commit', true);
      }
    }

    if (this.isEditModeProxy && this.editMode) {
      // Edit Mode: the proxy only moved; the selected vertices must receive the
      // same delta (previously this branch just re-centred the proxy and threw
      // the transform away, so G/R/S + Enter did nothing).
      const committed = typeof this.editMode.commitModalProxyTransform === 'function'
        ? this.editMode.commitModalProxyTransform(activePreState, activePostState)
        : false;
      if (!committed) {
        this.editMode.updateGizmoProxy();
        this.editMode.updateVisuals();
      }
    }

    this._cleanup();
    console.log('[ModalTransform] Confirmed.');
  }

  /**
   * Cancel and revert transformation to initial state
   */
  cancel() {
    if (!this.isActive) return;

    const revertedTarget = this.targetObject;
    const entries = this.targetEntries.length > 0 ? this.targetEntries : (this.targetObject ? [{
      obj: this.targetObject,
      position: this.initialState.position,
      quaternion: this.initialState.quaternion,
      scale: this.initialState.scale
    }] : []);
    for (const entry of entries) {
      entry.obj.position.copy(entry.position);
      entry.obj.quaternion.copy(entry.quaternion);
      entry.obj.scale.copy(entry.scale);
      entry.obj.updateMatrixWorld(true);
    }

    if (this.isEditModeProxy && this.editMode) {
      if (typeof this.editMode.revertModalProxyPreview === 'function') {
        this.editMode.revertModalProxyPreview();
      } else {
        this.editMode.updateGizmoProxy();
        this.editMode.updateVisuals();
      }
    }

    if (!this.isEditModeProxy) {
      for (const entry of entries) {
        this._emitObjectTransformed(entry.obj, 'commit', true);
      }
      if (entries.length === 0 && revertedTarget) {
        this._emitObjectTransformed(revertedTarget, 'commit', true);
      }
    }

    this._cleanup();
    console.log('[ModalTransform] Cancelled (Reverted to original).');
  }

  /**
   * Clean up event listeners and visual elements
   */
  _cleanup() {
    this.isActive = false;
    this.mode = null;
    this.targetObject = null;
    this.targetEntries = [];
    if (this.initialState) this.initialState.worldQuat = null;
    this.axisLock = null;
    this.isLocalAxis = false;
    this.customAxisDir = null;
    this.numericInput = '';
    this.hasNumericInput = false;
    this.isSlideMode = false;
    this.slideClamp = true;

    // Restore OrbitControls & TransformControls Gizmo
    if (this.engine) {
      if (this.engine.controls) {
        this.engine.controls.enabled = true;
      }
      if (this.engine.transformControls) {
        this.engine.transformControls.visible = true;
      }
      this.engine.updateSelectionHelper();
    }

    // Remove window listeners
    window.removeEventListener('pointermove', this._onPointerMove);
    window.removeEventListener('pointerdown', this._onPointerDown, true);
    window.removeEventListener('keydown', this._onKeyDown, true);
    window.removeEventListener('contextmenu', this._onContextMenu, true);

    // Hide visual helpers & HUD
    this._hideVisualHelpers();
    this._hideHUD();
  }

  // =========================================================================
  // 2. POINTER & KEYBOARD INPUT HANDLING
  // =========================================================================

  _onPointerMove(e) {
    if (!this.isActive) return;
    this.currentMousePos.x = e.clientX;
    this.currentMousePos.y = e.clientY;

    this._updateTransformation(e.shiftKey, e.ctrlKey);
  }

  _onPointerDown(e) {
    if (!this.isActive) return;
    e.preventDefault();
    e.stopPropagation();

    if (e.button === 0) {
      // Left-Click -> Confirm
      this.confirm();
    } else if (e.button === 2) {
      // Right-Click -> Cancel
      this.cancel();
    }
  }

  _onContextMenu(e) {
    if (this.isActive) {
      e.preventDefault();
      e.stopPropagation();
      this.cancel();
    }
  }

  _onKeyDown(e) {
    if (!this.isActive) return;

    const key = e.key.toLowerCase();

    // 1. Cancel: Esc
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      this.cancel();
      return;
    }

    // 2. Confirm: Enter or Space
    if (e.key === 'Enter' || e.code === 'Space') {
      e.preventDefault();
      e.stopPropagation();
      this.confirm();
      return;
    }

    // Browser/app combos (Ctrl+Z, Cmd+R, …) must not become axis locks or
    // numeric input while a modal transform is running.
    if (e.ctrlKey || e.metaKey || e.altKey) return;

    // Double-tap G in Edit Mode -> Edge / Vertex Slide (Blender GG)
    if (key === 'g' && !e.shiftKey && this.mode === 'translate' && this.isEditModeProxy && this.editMode) {
      e.preventDefault();
      e.stopPropagation();
      this.isSlideMode = !this.isSlideMode;
      this.axisLock = null;
      this.numericInput = '';
      this.hasNumericInput = false;
      if (this.isSlideMode) {
        const prepared = this.editMode.prepareSlideTransform?.();
        if (!prepared) this.isSlideMode = false;
      } else {
        this.editMode.applySlideTransform?.(0, true);
      }
      this._updateVisualHelpers();
      this._updateTransformation(e.shiftKey, e.ctrlKey);
      return;
    }

    // Clamp toggle (C) during Edge/Vertex Slide
    if (key === 'c' && !e.shiftKey && this.isSlideMode) {
      e.preventDefault();
      e.stopPropagation();
      this.slideClamp = !this.slideClamp;
      this._updateTransformation(e.shiftKey, e.ctrlKey);
      return;
    }

    // 3. Axis Locking: X, Y, Z
    if (['x', 'y', 'z'].includes(key)) {
      e.preventDefault();
      e.stopPropagation();
      const axisName = key.toUpperCase();

      if (e.shiftKey) {
        // Plane lock (Shift+X => YZ plane, Shift+Y => XZ plane, Shift+Z => XY plane)
        const planeMap = { 'X': 'YZ', 'Y': 'XZ', 'Z': 'XY' };
        const planeTarget = planeMap[axisName];
        if (this.axisLock === planeTarget) {
          this.axisLock = null; // Toggle off
        } else {
          this.axisLock = planeTarget;
        }
      } else {
        // Single Axis lock: None -> Global -> Local -> None
        if (this.axisLock !== axisName) {
          this.axisLock = axisName;
          this.isLocalAxis = false; // Global
        } else if (!this.isLocalAxis) {
          this.isLocalAxis = true; // Local
        } else {
          this.axisLock = null; // Unlock
          this.isLocalAxis = false;
        }
      }

      this._updateVisualHelpers();
      this._updateTransformation(e.shiftKey, e.ctrlKey);
      return;
    }

    // 4. Numeric Input (support 0-9, ., -, comma, and Numpad)
    const isNumChar = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '.', ',', '-'].includes(e.key) ||
                      (e.code && e.code.startsWith('Numpad'));
    if (isNumChar && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      e.stopPropagation();

      let char = e.key;
      if (char === ',') char = '.';
      if (e.code === 'NumpadDecimal') char = '.';
      if (e.code && e.code.startsWith('Numpad') && e.code.length === 7) {
        char = e.code.replace('Numpad', '');
      }

      if (char === '-') {
        if (this.numericInput.startsWith('-')) {
          this.numericInput = this.numericInput.substring(1);
        } else {
          this.numericInput = '-' + this.numericInput;
        }
      } else if (char === '.') {
        if (!this.numericInput.includes('.')) {
          this.numericInput += '.';
        }
      } else if (['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'].includes(char)) {
        this.numericInput += char;
      }

      const parsedNum = parseFloat(this.numericInput);
      this.hasNumericInput = this.numericInput.length > 0 && Number.isFinite(parsedNum);
      this._updateTransformation(e.shiftKey, e.ctrlKey);
      return;
    }

    // Backspace: Delete numeric character
    if (e.key === 'Backspace') {
      e.preventDefault();
      e.stopPropagation();
      if (this.numericInput.length > 0) {
        this.numericInput = this.numericInput.slice(0, -1);
        const parsedNum = parseFloat(this.numericInput);
        this.hasNumericInput = this.numericInput.length > 0 && Number.isFinite(parsedNum);
        this._updateTransformation(e.shiftKey, e.ctrlKey);
      }
      return;
    }
  }

  // =========================================================================
  // 3. CORE TRANSFORMATION MATHEMATICS
  // =========================================================================

  /**
   * Recalculates and applies position, rotation, or scale to the target object
   */
  _updateTransformation(isShift = false, isCtrl = false) {
    if (!this.isActive || !this.targetObject) return;

    const camera = this.engine.camera;
    const dom = this.engine.domElement;
    const rect = this.engine.getViewportRect ? this.engine.getViewportRect() : dom.getBoundingClientRect();
    const target = this.targetObject;
    const snapActive = Boolean(this.engine?.snapEnabled) !== Boolean(isCtrl);
    const pivotMode = this.engine?.pivotMode || 'median';

    let hudValueText = '';

    // -----------------------------------------------------------------------
    // 0. EDIT MODE EDGE / VERTEX SLIDE (G G)
    // -----------------------------------------------------------------------
    if (this.isSlideMode && this.isEditModeProxy && this.editMode && this.editMode._slideData) {
      const slideData = this.editMode._slideData;
      let factor = 0;

      if (this.hasNumericInput) {
        factor = parseFloat(this.numericInput);
      } else {
        const p0 = this._pivotWorldOrigin.clone().project(camera);
        const p1 = this._pivotWorldOrigin.clone().add(slideData.worldRefDir).project(camera);
        const sx = ((p1.x - p0.x) * 0.5) * rect.width;
        const sy = (-(p1.y - p0.y) * 0.5) * rect.height;
        const axisLenPx = Math.hypot(sx, sy);
        const dx = this.currentMousePos.x - this.startMousePos.x;
        const dy = this.currentMousePos.y - this.startMousePos.y;
        if (axisLenPx > 4) {
          factor = (dx * sx + dy * sy) / (axisLenPx * axisLenPx);
        } else {
          factor = dx / 120;
        }
        if (isShift) factor *= 0.1;
        if (snapActive) factor = Math.round(factor * 10) / 10;
      }

      this.editMode.applySlideTransform(factor, this.slideClamp);
      const shown = this.slideClamp ? Math.max(-1, Math.min(1, factor)) : Math.max(-5, Math.min(5, factor));
      hudValueText = `Slide Factor: ${shown.toFixed(3)} (Clamp: ${this.slideClamp ? 'ON' : 'OFF'} · C to toggle)`;
      this._renderHUD(hudValueText);
      this._updateMouseGuideLine();
      return;
    }

    // -----------------------------------------------------------------------
    // A. TRANSLATE MODE (G)
    // -----------------------------------------------------------------------
    if (this.mode === 'translate') {
      // Raycast current mouse onto viewPlane
      const ndc = this._pixelToNDC(this.currentMousePos.x, this.currentMousePos.y, rect);
      this.raycaster.setFromCamera(ndc, camera);
      this.raycaster.ray.intersectPlane(this.viewPlane, this.currentHitPoint);

      let delta = this.currentHitPoint.clone().sub(this.startHitPoint);

      // Precision mode (Shift)
      if (isShift) delta.multiplyScalar(0.1);

      // Numeric input override
      if (this.hasNumericInput) {
        const val = parseFloat(this.numericInput);
        if (this.axisLock) {
          const dir = this._getAxisDirection(this.axisLock);
          delta = dir.clone().multiplyScalar(val);
        } else {
          const viewRight = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
          delta = viewRight.multiplyScalar(val);
        }
      }
      // Axis or Plane Constraints
      else if (this.axisLock) {
        if (['X', 'Y', 'Z', 'CUSTOM'].includes(this.axisLock)) {
          const dir = this._getAxisDirection(this.axisLock);
          const projScalar = delta.dot(dir);
          let val = projScalar;
          if (snapActive) val = Math.round(val / 0.5) * 0.5; // Snap 0.5m
          delta = dir.clone().multiplyScalar(val);
        } else {
          // Plane lock (XY, XZ, YZ)
          const normal = this._getPlaneNormal(this.axisLock);
          delta.sub(normal.clone().multiplyScalar(delta.dot(normal)));
          if (snapActive) {
            delta.x = Math.round(delta.x / 0.5) * 0.5;
            delta.y = Math.round(delta.y / 0.5) * 0.5;
            delta.z = Math.round(delta.z / 0.5) * 0.5;
          }
        }
      } else if (snapActive) {
        delta.x = Math.round(delta.x / 0.5) * 0.5;
        delta.y = Math.round(delta.y / 0.5) * 0.5;
        delta.z = Math.round(delta.z / 0.5) * 0.5;
      }

      const entries = this.targetEntries.length > 0 ? this.targetEntries : [{
        obj: target,
        position: this.initialState.position,
        quaternion: this.initialState.quaternion,
        scale: this.initialState.scale,
        worldPos: this.initialState.worldPivot,
        worldQuat: this.initialState.worldQuat || this.initialState.quaternion,
        parentInv: target.parent ? target.parent.matrixWorld.clone().invert() : new THREE.Matrix4(),
        parentQuatInv: target.parent ? target.parent.getWorldQuaternion(new THREE.Quaternion()).invert() : new THREE.Quaternion()
      }];

      // Apply world delta to each target in its parent's local coordinate space
      const tmpWorld = new THREE.Vector3();
      for (const entry of entries) {
        tmpWorld.copy(entry.worldPos).add(delta);
        if (entry.obj.parent) {
          tmpWorld.applyMatrix4(entry.parentInv);
        }
        entry.obj.position.copy(tmpWorld);
        entry.obj.updateMatrixWorld(true);
      }

      const dX = delta.x.toFixed(4);
      const dY = delta.y.toFixed(4);
      const dZ = delta.z.toFixed(4);
      const dist = delta.length().toFixed(4);
      hudValueText = `Dx: ${dX}m, Dy: ${dY}m, Dz: ${dZ}m (Distance: ${dist}m)`;
    }

    // -----------------------------------------------------------------------
    // B. ROTATE MODE (R)
    // -----------------------------------------------------------------------
    else if (this.mode === 'rotate') {
      const startAngle = Math.atan2(
        this.startMousePos.y - this.pivotScreenPos.y,
        this.startMousePos.x - this.pivotScreenPos.x
      );
      const currentAngle = Math.atan2(
        this.currentMousePos.y - this.pivotScreenPos.y,
        this.currentMousePos.x - this.pivotScreenPos.x
      );

      let deltaAngle = currentAngle - startAngle;

      // Precision mode (Shift)
      if (isShift) deltaAngle *= 0.1;

      // Numeric input (Degrees)
      if (this.hasNumericInput) {
        deltaAngle = THREE.MathUtils.degToRad(parseFloat(this.numericInput));
      }
      // Snap mode (Ctrl / Snap ON: 5 degrees)
      else if (snapActive) {
        const step = THREE.MathUtils.degToRad(5);
        deltaAngle = Math.round(deltaAngle / step) * step;
      }

      // Determine rotation axis
      let rotAxis = camera.getWorldDirection(new THREE.Vector3()).negate(); // View axis
      if (this.axisLock && ['X', 'Y', 'Z'].includes(this.axisLock)) {
        rotAxis = this._getAxisDirection(this.axisLock);
      }

      const entries = this.targetEntries.length > 0 ? this.targetEntries : [{
        obj: target,
        position: this.initialState.position,
        quaternion: this.initialState.quaternion,
        scale: this.initialState.scale,
        worldPos: this.initialState.worldPivot,
        worldQuat: this.initialState.worldQuat || this.initialState.quaternion,
        parentInv: target.parent ? target.parent.matrixWorld.clone().invert() : new THREE.Matrix4(),
        parentQuatInv: target.parent ? target.parent.getWorldQuaternion(new THREE.Quaternion()).invert() : new THREE.Quaternion()
      }];

      // Construct world rotation quaternion & rotate each target around chosen pivot
      const rotQuat = new THREE.Quaternion().setFromAxisAngle(rotAxis, -deltaAngle);
      const nextWorldQuat = new THREE.Quaternion();
      const nextWorldPos = new THREE.Vector3();
      for (const entry of entries) {
        nextWorldQuat.copy(rotQuat).multiply(entry.worldQuat);
        if (entry.obj.parent) {
          entry.obj.quaternion.copy(entry.parentQuatInv).multiply(nextWorldQuat);
        } else {
          entry.obj.quaternion.copy(nextWorldQuat);
        }

        if (pivotMode === 'individual' || (entries.length === 1 && pivotMode !== 'cursor')) {
          entry.obj.position.copy(entry.position);
        } else {
          const offset = entry.worldPos.clone().sub(this._pivotWorldOrigin).applyQuaternion(rotQuat);
          nextWorldPos.copy(this._pivotWorldOrigin).add(offset);
          if (entry.obj.parent) {
            nextWorldPos.applyMatrix4(entry.parentInv);
          }
          entry.obj.position.copy(nextWorldPos);
        }
        entry.obj.updateMatrixWorld(true);
      }

      const deg = THREE.MathUtils.radToDeg(-deltaAngle).toFixed(2);
      hudValueText = `Rotation: ${deg}°`;
    }

    // -----------------------------------------------------------------------
    // C. SCALE MODE (S)
    // -----------------------------------------------------------------------
    else if (this.mode === 'scale') {
      const startDist = Math.hypot(
        this.startMousePos.x - this.pivotScreenPos.x,
        this.startMousePos.y - this.pivotScreenPos.y
      );
      const currentDist = Math.hypot(
        this.currentMousePos.x - this.pivotScreenPos.x,
        this.currentMousePos.y - this.pivotScreenPos.y
      );

      let factor = currentDist / Math.max(startDist, 20);

      // Precision mode (Shift)
      if (isShift) factor = 1 + (factor - 1) * 0.1;

      // Numeric input (supports negative mirror values like -1, -2.5)
      if (this.hasNumericInput) {
        factor = parseFloat(this.numericInput);
      }
      // Snap mode (Ctrl / Snap ON: 0.1x)
      else if (snapActive) {
        factor = Math.round(factor * 10) / 10;
      }

      // Guard only near-zero degenerate scale (keep negative sign for mirror scale!)
      if (!Number.isFinite(factor)) factor = 1;
      if (Math.abs(factor) < 0.001) factor = factor < 0 ? -0.001 : 0.001;

      let rx = 1, ry = 1, rz = 1;
      if (!this.axisLock) {
        rx = ry = rz = factor;
      } else if (this.axisLock === 'X') {
        rx = factor;
      } else if (this.axisLock === 'Y') {
        ry = factor;
      } else if (this.axisLock === 'Z') {
        rz = factor;
      } else if (this.axisLock === 'XY') {
        rx = ry = factor;
      } else if (this.axisLock === 'XZ') {
        rx = rz = factor;
      } else if (this.axisLock === 'YZ') {
        ry = rz = factor;
      }

      const entries = this.targetEntries.length > 0 ? this.targetEntries : [{
        obj: target,
        position: this.initialState.position,
        quaternion: this.initialState.quaternion,
        scale: this.initialState.scale,
        worldPos: this.initialState.worldPivot,
        worldQuat: this.initialState.worldQuat || this.initialState.quaternion,
        parentInv: target.parent ? target.parent.matrixWorld.clone().invert() : new THREE.Matrix4(),
        parentQuatInv: target.parent ? target.parent.getWorldQuaternion(new THREE.Quaternion()).invert() : new THREE.Quaternion()
      }];

      const worldScaleDir = (this.axisLock && ['X', 'Y', 'Z'].includes(this.axisLock))
        ? this._getAxisDirection(this.axisLock)
        : null;
      const nextWorldPos = new THREE.Vector3();

      for (const entry of entries) {
        entry.obj.scale.set(entry.scale.x * rx, entry.scale.y * ry, entry.scale.z * rz);

        if (pivotMode === 'individual' || (entries.length === 1 && pivotMode !== 'cursor')) {
          entry.obj.position.copy(entry.position);
        } else {
          const offset = entry.worldPos.clone().sub(this._pivotWorldOrigin);
          if (worldScaleDir && this.isLocalAxis) {
            const proj = offset.dot(worldScaleDir);
            offset.addScaledVector(worldScaleDir, proj * (factor - 1));
          } else if (!this.axisLock) {
            offset.multiplyScalar(factor);
          } else {
            offset.set(offset.x * rx, offset.y * ry, offset.z * rz);
          }
          nextWorldPos.copy(this._pivotWorldOrigin).add(offset);
          if (entry.obj.parent) {
            nextWorldPos.applyMatrix4(entry.parentInv);
          }
          entry.obj.position.copy(nextWorldPos);
        }
        entry.obj.updateMatrixWorld(true);
      }

      hudValueText = `Scale: ${factor.toFixed(4)}x`;
    }

    // Live Edit Mode mesh preview during modal G / R / S
    if (this.isEditModeProxy && this.editMode && typeof this.editMode.previewModalProxyTransform === 'function') {
      this.editMode.previewModalProxyTransform(this.initialState, {
        position: target.position,
        quaternion: target.quaternion,
        scale: target.scale
      });
    }

    // Trigger IK / Bone solver & transform event per touched object
    if (!this.isEditModeProxy) {
      const list = this.targetEntries.length > 0 ? this.targetEntries : [{ obj: target }];
      if (typeof window !== 'undefined' && window.rigSystem && target.userData?.isIKHandle) {
        window.rigSystem.onIKHandleMoved(target);
      }
      for (let i = 0; i < list.length; i += 1) {
        this._emitObjectTransformed(list[i].obj, 'interactive', i === 0 ? false : true);
      }
    }

    // Update HUD text
    this._renderHUD(hudValueText);
    this._updateMouseGuideLine();
  }

  _emitObjectTransformed(object, phase = 'interactive', force = false) {
    if (!object || typeof window === 'undefined' || typeof CustomEvent === 'undefined') return;
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    if (!force && now - (this._lastTransformEventTime || 0) < 50) return;
    this._lastTransformEventTime = now;
    window.dispatchEvent(new CustomEvent('blender:objectTransformed', {
      detail: { object, source: 'modal', phase }
    }));
  }

  // =========================================================================
  // 4. COORDINATE & VECTOR HELPERS
  // =========================================================================

  _pixelToNDC(clientX, clientY, rect) {
    return new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1
    );
  }

  getOrientationAxes(orientationOverride = null) {
    const mode = orientationOverride || (this.isLocalAxis ? (this.orientation !== 'world' ? this.orientation : 'local') : 'world');
    const x = new THREE.Vector3(1, 0, 0);
    const y = new THREE.Vector3(0, 1, 0);
    const z = new THREE.Vector3(0, 0, 1);

    if (mode === 'local') {
      const q = this.targetObject ? (this.initialState.worldQuat || this.initialState.quaternion) : new THREE.Quaternion();
      x.applyQuaternion(q).normalize();
      y.applyQuaternion(q).normalize();
      z.applyQuaternion(q).normalize();
    } else if (mode === 'view') {
      const cam = this.engine?.camera;
      if (cam) {
        x.applyQuaternion(cam.quaternion).normalize();
        y.applyQuaternion(cam.quaternion).normalize();
        z.applyQuaternion(cam.quaternion).normalize();
      }
    } else if (mode === 'cursor') {
      const cq = (typeof window !== 'undefined' && window.modelingSuite?.cursorQuaternion) || new THREE.Quaternion();
      x.applyQuaternion(cq).normalize();
      y.applyQuaternion(cq).normalize();
      z.applyQuaternion(cq).normalize();
    } else if (mode === 'gimbal' && this.targetObject) {
      const q = this.initialState.worldQuat || this.initialState.quaternion;
      const e = new THREE.Euler().setFromQuaternion(q, this.targetObject.rotation?.order || 'XYZ');
      const rx = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), e.x);
      const ry = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), e.y);
      const qxy = rx.clone().multiply(ry);
      y.applyQuaternion(rx).normalize();
      z.applyQuaternion(qxy).normalize();
    } else if (mode === 'normal') {
      const nrm = this.editMode?.isActive && typeof this.editMode.getSelectionNormal === 'function'
        ? this.editMode.getSelectionNormal()
        : null;
      if (nrm && nrm.lengthSq() > 1e-6) {
        z.copy(nrm).normalize();
        const ref = Math.abs(z.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
        x.crossVectors(ref, z).normalize();
        y.crossVectors(z, x).normalize();
      } else if (this.targetObject) {
        const q = this.initialState.worldQuat || this.initialState.quaternion;
        x.applyQuaternion(q).normalize();
        y.applyQuaternion(q).normalize();
        z.applyQuaternion(q).normalize();
      }
    }
    return { X: x, Y: y, Z: z };
  }

  _getAxisDirection(axisKey) {
    if (axisKey === 'CUSTOM' && this.customAxisDir && this.customAxisDir.lengthSq() > 1e-8) {
      return this.customAxisDir.clone().normalize();
    }
    const axes = this.getOrientationAxes();
    return (axes[axisKey] || new THREE.Vector3(1, 0, 0)).clone();
  }

  _getPlaneNormal(planeKey) {
    const axes = this.getOrientationAxes();
    if (planeKey === 'YZ') return axes.X.clone();
    if (planeKey === 'XZ') return axes.Y.clone();
    if (planeKey === 'XY') return axes.Z.clone();
    return new THREE.Vector3(0, 1, 0);
  }

  // =========================================================================
  // 5. 3D VISUAL FEEDBACK (AXIS LINES & DOTTED GUIDES)
  // =========================================================================

  _initVisualHelpers() {
    // 1. Infinite Axis Constraint Line
    const lineGeo = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(0, 0, 0)
    ]);
    const lineMat = new THREE.LineBasicMaterial({
      color: 0xffffff,
      depthTest: false,
      transparent: true,
      opacity: 0.9,
      linewidth: 2
    });
    this.axisLine = new THREE.Line(lineGeo, lineMat);
    this.axisLine.visible = false;
    this.axisLine.userData.selectable = false;
    this.axisLine.userData.isSystemObject = true;
    this.helperGroup.add(this.axisLine);

    // 2. Pivot-to-Mouse guide line
    const guideGeo = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(0, 0, 0)
    ]);
    const guideMat = new THREE.LineDashedMaterial({
      color: 0xaaaaaa,
      dashSize: 0.2,
      gapSize: 0.1,
      depthTest: false,
      transparent: true,
      opacity: 0.65
    });
    this.mouseGuideLine = new THREE.Line(guideGeo, guideMat);
    this.mouseGuideLine.visible = false;
    this.mouseGuideLine.userData.selectable = false;
    this.mouseGuideLine.userData.isSystemObject = true;
    this.helperGroup.add(this.mouseGuideLine);
  }

  _updateVisualHelpers() {
    if (!this.isActive || !this.targetObject || !this.axisLock) {
      this.axisLine.visible = false;
      return;
    }

    // Determine line color by axis
    let color = 0xffffff;
    let dir = new THREE.Vector3();

    if (this.axisLock === 'CUSTOM') {
      color = 0x22d3ee; // Cyan Normal axis
      dir = this._getAxisDirection('CUSTOM');
    } else if (this.axisLock.includes('X')) {
      color = 0xe74c3c; // Red
      dir = this._getAxisDirection('X');
    } else if (this.axisLock.includes('Y')) {
      color = 0x2ecc71; // Green
      dir = this._getAxisDirection('Y');
    } else if (this.axisLock.includes('Z')) {
      color = 0x3498db; // Blue
      dir = this._getAxisDirection('Z');
    }

    this.axisLine.material.color.setHex(color);

    // Span line 1000 units in both directions through pivot
    const pivot = this._pivotWorldOrigin || this.initialState.worldPivot;
    const p1 = pivot.clone().addScaledVector(dir, -1000);
    const p2 = pivot.clone().addScaledVector(dir, 1000);

    const positions = new Float32Array([
      p1.x, p1.y, p1.z,
      p2.x, p2.y, p2.z
    ]);
    this.axisLine.geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    this.axisLine.geometry.attributes.position.needsUpdate = true;
    this.axisLine.visible = true;
  }

  _updateMouseGuideLine() {
    if (!this.isActive || !this.mouseGuideLine) return;
    const pivot = this._pivotWorldOrigin || this.initialState.worldPivot;
    const targetPos = new THREE.Vector3();
    if (this.targetObject) {
      this.targetObject.getWorldPosition(targetPos);
    } else {
      targetPos.copy(pivot);
    }

    const positions = new Float32Array([
      pivot.x, pivot.y, pivot.z,
      targetPos.x, targetPos.y, targetPos.z
    ]);
    this.mouseGuideLine.geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    this.mouseGuideLine.geometry.attributes.position.needsUpdate = true;
    this.mouseGuideLine.computeLineDistances();
    this.mouseGuideLine.visible = true;
  }

  _hideVisualHelpers() {
    if (this.axisLine) this.axisLine.visible = false;
    if (this.mouseGuideLine) this.mouseGuideLine.visible = false;
  }

  // =========================================================================
  // 6. VIEWPORT HUD STATUS BAR
  // =========================================================================

  _initHUD() {
    if (typeof document === 'undefined') return;

    this.hudElement = document.createElement('div');
    this.hudElement.id = 'blender-modal-hud';
    this.hudElement.className = 'blender-modal-hud';
    this.hudElement.style.display = 'none';

    // Inject styles
    const style = document.createElement('style');
    style.id = 'blender-modal-hud-styles';
    style.textContent = `
      .blender-modal-hud {
        position: absolute;
        top: 42px;
        left: 12px;
        z-index: 100;
        background: rgba(28, 28, 28, 0.92);
        border: 1px solid #444444;
        border-radius: 6px;
        padding: 6px 12px;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, monospace;
        font-size: 11.5px;
        color: #ffffff;
        box-shadow: 0 4px 16px rgba(0, 0, 0, 0.6);
        pointer-events: none;
        user-select: none;
        display: flex;
        align-items: center;
        gap: 12px;
        max-width: calc(100% - 24px);
        overflow-x: auto;
      }

      .modal-hud-badge {
        font-weight: 700;
        font-size: 11px;
        padding: 2px 7px;
        border-radius: 4px;
        letter-spacing: 0.5px;
        color: white;
      }

      .modal-hud-badge.translate {
        background: #e67e22;
      }

      .modal-hud-badge.rotate {
        background: #27ae60;
      }

      .modal-hud-badge.scale {
        background: #2980b9;
      }

      .modal-hud-values {
        color: #f1c40f;
        font-family: Consolas, monospace;
        font-weight: 600;
      }

      .modal-hud-axis {
        color: #3498db;
        font-weight: 600;
      }

      .modal-hud-numeric {
        background: #111;
        border: 1px solid #e67e22;
        color: #e67e22;
        padding: 1px 6px;
        border-radius: 3px;
        font-weight: 700;
        font-family: Consolas, monospace;
      }

      .modal-hud-hints {
        color: #888888;
        font-size: 10.5px;
        border-left: 1px solid #3c3c3c;
        padding-left: 10px;
      }

      .modal-hud-key {
        color: #ddd;
        font-weight: 600;
      }
    `;
    document.head.appendChild(style);

    const host = document.getElementById('viewport-canvas-host') || document.body;
    host.appendChild(this.hudElement);
  }

  _showHUD() {
    if (this.hudElement) {
      this.hudElement.style.display = 'flex';
    }
  }

  _hideHUD() {
    if (this.hudElement) {
      this.hudElement.style.display = 'none';
      this.hudElement.innerHTML = '';
    }
  }

  _renderHUD(valueString = '') {
    if (!this.hudElement) return;

    const modeLabels = {
      translate: this.isSlideMode ? 'EDGE / VERTEX SLIDE (GG)' : 'GRAB / TRANSLATE (G)',
      rotate: 'ROTATE (R)',
      scale: 'SCALE (S)'
    };

    let axisInfo = 'Free';
    if (this.isSlideMode) {
      axisInfo = 'Along Adjacent Edges';
    } else if (this.axisLock === 'CUSTOM') {
      axisInfo = 'Extrude Normal (X/Y/Z to unlock)';
    } else if (this.axisLock) {
      const type = this.isLocalAxis ? 'Local' : 'Global';
      axisInfo = `${type} ${this.axisLock}`;
    }

    const numericBadge = this.numericInput
      ? `<span class="modal-hud-numeric">Value: ${this.numericInput}</span>`
      : '';

    const extraHint = this.isEditModeProxy && this.mode === 'translate' && !this.isSlideMode
      ? '<span class="modal-hud-key">[G]</span> Slide | '
      : '';

    this.hudElement.innerHTML = `
      <span class="modal-hud-badge ${this.mode}">${modeLabels[this.mode] || this.mode}</span>
      <span class="modal-hud-axis">[${axisInfo}]</span>
      <span class="modal-hud-values">${valueString}</span>
      ${numericBadge}
      <span class="modal-hud-hints">
        ${extraHint}
        <span class="modal-hud-key">[X/Y/Z]</span> Axis | 
        <span class="modal-hud-key">[Shift+Axis]</span> Plane | 
        <span class="modal-hud-key">[Digits]</span> Numeric Input | 
        <span class="modal-hud-key">[Shift]</span> Precision | 
        <span class="modal-hud-key">[Ctrl]</span> Snap | 
        <span class="modal-hud-key" style="color:#2ecc71;">[Enter / LMB]</span> Confirm | 
        <span class="modal-hud-key" style="color:#e74c3c;">[Esc / RMB]</span> Cancel
      </span>
    `;
  }
}

// Global instance
export const modalTransformManager = new ModalTransformManager();

if (typeof window !== 'undefined') {
  window.ModalTransformManager = ModalTransformManager;
  window.modalTransformManager = modalTransformManager;
}

export default modalTransformManager;
