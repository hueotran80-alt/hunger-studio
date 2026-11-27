/**
 * @file blender-pro-keymap.js
 * @description Blender Pro Keymap, Screen 2 (No-Bottom-Dock Workspace),
 * Box/Circle Selection, Pie Menus (Snap/View/Pivot/Apply/Delete),
 * MMB + Alt+LMB Navigation, Local View (/), Parent/Clear Transform Pro Tools,
 * and Searchable Shortcuts Reference Dialog.
 */

import * as THREE from 'three';
import { Command, TransformCommand, AddObjectsCommand } from './scene-manager.js';
import { shouldBlockViewportShortcut } from './interaction-guard.js';
import * as ModifierStack from './modifier-stack.js';
import { setCutterDisplayMode, syncBooleanCuttersInScene } from './modifiers.js';
import { dataBlockRegistry } from './data-blocks.js';

const KEYMAP_STORAGE_KEY = 'wbs_keymap_preset';
const DOCK_HIDDEN_STORAGE_KEY = 'wbs_no_bottom_dock';

class ReparentCommand extends Command {
  constructor(objects, newParent, description = 'Set Parent (Keep Transform)') {
    super(description);
    this.objects = Array.isArray(objects) ? [...objects] : [objects];
    this.newParent = newParent;
    this.snapshots = this.objects.map(obj => ({
      obj,
      oldParent: obj.parent,
      oldPos: obj.position.clone(),
      oldQuat: obj.quaternion.clone(),
      oldScale: obj.scale.clone()
    }));
  }

  execute() {
    if (!this.newParent) return;
    for (const { obj } of this.snapshots) {
      if (obj === this.newParent) continue;
      // Guard against parenting ancestor under descendant
      let p = this.newParent;
      let cycle = false;
      while (p) {
        if (p === obj) { cycle = true; break; }
        p = p.parent;
      }
      if (!cycle) {
        this.newParent.attach(obj);
      }
    }
  }

  undo() {
    for (const snap of this.snapshots) {
      if (snap.oldParent) {
        snap.oldParent.add(snap.obj);
      }
      snap.obj.position.copy(snap.oldPos);
      snap.obj.quaternion.copy(snap.oldQuat);
      snap.obj.scale.copy(snap.oldScale);
      snap.obj.updateMatrixWorld(true);
    }
  }
}

export class BlenderProTools {
  constructor(app) {
    this.app = app;
    this.engine = app.engine;
    this.sceneManager = app.sceneManager;
    this.editMode = app.editMode;
    this.modalTransform = app.modalTransform;
    this.modelingSuite = app.modelingSuite;

    // Keymap: 'blender-pro' | 'web'
    this.keymapPreset = this._loadStoredKeymap();
    this._lastDockWorkspace = 'layout';

    // Local View (/) state
    this.isLocalView = false;
    this._localViewHidden = [];

    // Box / Circle selection state
    this._boxState = null;
    this._circleState = null;
    this._activePieEl = null;
    this._activePieBackdrop = null;
    this._tempMouseOverride = false;
    this._lmbCandidate = null;
    this._shortcutsModal = null;

    this._onCapturePointerDown = this._onCapturePointerDown.bind(this);
    this._onWindowPointerMove = this._onWindowPointerMove.bind(this);
    this._onWindowPointerUp = this._onWindowPointerUp.bind(this);
    this._onWindowKeyDown = this._onWindowKeyDown.bind(this);
  }

  init() {
    this.modelingSuite = this.app.modelingSuite;
    if (this.engine) {
      this.engine.pivotMode = this.engine.pivotMode || 'median';
      this.engine.snapEnabled = Boolean(this.engine.snapEnabled);
    }

    this._bindUIControls();
    this._bindPointerNavigation();
    window.addEventListener('keydown', this._onWindowKeyDown, true);

    this.setKeymapPreset(this.keymapPreset, false);

    // Restore No-Bottom-Dock layout preference if stored
    try {
      if (localStorage.getItem(DOCK_HIDDEN_STORAGE_KEY) === '1') {
        this.toggleBottomDock(true);
      }
    } catch (_) { /* ignore storage restrictions */ }
  }

  _loadStoredKeymap() {
    try {
      const saved = localStorage.getItem(KEYMAP_STORAGE_KEY);
      if (saved === 'web' || saved === 'blender-pro') return saved;
    } catch (_) { /* ignore */ }
    return 'blender-pro';
  }

  // =========================================================================
  // 1. SCREEN 2 (NO BOTTOM DOCK) & PURE FULLSCREEN VIEWPORT
  // =========================================================================

  isBottomDockHidden() {
    return document.body.classList.contains('app-no-bottom-dock');
  }

  toggleBottomDock(forceHide = null) {
    const currentlyHidden = this.isBottomDockHidden();
    const shouldHide = forceHide === null ? !currentlyHidden : Boolean(forceHide);

    document.body.classList.toggle('app-no-bottom-dock', shouldHide);

    // Sync workspace tab active indicator cleanly
    const viewportTab = document.querySelector('.workspace-tab[data-workspace="viewport"]');
    const allTabs = document.querySelectorAll('.workspace-tab');
    if (shouldHide) {
      const activeNonVp = Array.from(allTabs).find(t => t.classList.contains('active') && t.dataset.workspace !== 'viewport');
      if (activeNonVp) this._lastDockWorkspace = activeNonVp.dataset.workspace || 'layout';
      if (viewportTab) {
        allTabs.forEach(t => t.classList.remove('active'));
        viewportTab.classList.add('active');
      }
    } else if (viewportTab && viewportTab.classList.contains('active')) {
      allTabs.forEach(t => t.classList.remove('active'));
      const restoreTab = document.querySelector(`.workspace-tab[data-workspace="${this._lastDockWorkspace || 'layout'}"]`);
      restoreTab?.classList.add('active');
    }

    const btn = document.getElementById('btn-toggle-bottom-dock');
    if (btn) {
      btn.classList.toggle('active', shouldHide);
      btn.textContent = shouldHide ? '⤡ Show Dock' : '⤢ No Dock';
      btn.title = shouldHide
        ? 'Show bottom dock / Layout (Alt+Space or Ctrl+\\)'
        : 'Second Screen: Hide bottom dock to maximize Viewport (Alt+Space or Ctrl+\\)';
    }

    try {
      localStorage.setItem(DOCK_HIDDEN_STORAGE_KEY, shouldHide ? '1' : '0');
    } catch (_) { /* ignore */ }

    this.engine?.onResize();
    requestAnimationFrame(() => this.engine?.onResize());
    return shouldHide;
  }

  toggleFullscreenViewport(forceFull = null) {
    const currentlyFull = document.body.classList.contains('app-fullscreen-viewport');
    const shouldFull = forceFull === null ? !currentlyFull : Boolean(forceFull);
    document.body.classList.toggle('app-fullscreen-viewport', shouldFull);

    const btn = document.getElementById('btn-fullscreen-viewport');
    if (btn) {
      btn.classList.toggle('active', shouldFull);
    }

    this.engine?.onResize();
    requestAnimationFrame(() => this.engine?.onResize());
    return shouldFull;
  }

  // =========================================================================
  // 2. KEYMAP PRESET (BLENDER PRO vs WEB ORBIT) & MMB / ALT+LMB NAVIGATION
  // =========================================================================

  setKeymapPreset(preset, persist = true) {
    const next = preset === 'web' ? 'web' : 'blender-pro';
    this.keymapPreset = next;

    if (this.engine) {
      this.engine.keymapPreset = next;
      const allCtrls = typeof this.engine.getAllViewportControls === 'function'
        ? this.engine.getAllViewportControls()
        : (this.engine.controls ? [this.engine.controls] : []);
      for (const ctrl of allCtrls) {
        if (!ctrl) continue;
        if (next === 'blender-pro') {
          ctrl.mouseButtons = {
            LEFT: null,
            MIDDLE: THREE.MOUSE.ROTATE,
            RIGHT: null
          };
        } else {
          ctrl.mouseButtons = {
            LEFT: THREE.MOUSE.ROTATE,
            MIDDLE: THREE.MOUSE.ROTATE,
            RIGHT: THREE.MOUSE.PAN
          };
        }
      }
    }

    const btn = document.getElementById('btn-keymap-preset');
    if (btn) {
      btn.classList.toggle('active', next === 'blender-pro');
      btn.textContent = next === 'blender-pro' ? '⌨ Pro' : '🖱 Web';
      btn.title = next === 'blender-pro'
        ? 'Keymap: Blender Pro (MMB or Alt+LMB Orbit · Shift+MMB Pan · Ctrl+MMB Zoom · LMB Box Select) — Click to switch to Web Orbit'
        : 'Keymap: Web Orbit (LMB/MMB Orbit · RMB Pan · B Box Select) — Click to switch to Blender Pro';
    }

    if (persist) {
      try {
        localStorage.setItem(KEYMAP_STORAGE_KEY, next);
      } catch (_) { /* ignore */ }
    }
    return next;
  }

  toggleKeymapPreset() {
    return this.setKeymapPreset(this.keymapPreset === 'blender-pro' ? 'web' : 'blender-pro');
  }

  _bindUIControls() {
    document.getElementById('btn-toggle-bottom-dock')?.addEventListener('click', () => this.toggleBottomDock());
    document.getElementById('btn-collapse-bottom-dock')?.addEventListener('click', () => this.toggleBottomDock(true));
    document.getElementById('btn-fullscreen-viewport')?.addEventListener('click', () => this.toggleFullscreenViewport());
    document.getElementById('viewport-fullscreen-restore')?.addEventListener('click', () => this.toggleFullscreenViewport(false));
    document.getElementById('btn-keymap-preset')?.addEventListener('click', () => this.toggleKeymapPreset());

    // Edit Mode header action buttons
    document.getElementById('btn-edit-fill')?.addEventListener('click', () => this.editMode?.fillOrMakeFace());
    document.getElementById('btn-edit-knife')?.addEventListener('click', () => this.editMode?.knife());
    document.getElementById('btn-edit-bridge')?.addEventListener('click', () => this.editMode?.bridgeEdgeLoops());
    document.getElementById('btn-edit-dissolve')?.addEventListener('click', () => this.editMode?.dissolveSelection());
    document.getElementById('btn-edit-separate')?.addEventListener('click', () => this.editMode?.separateSelection());

    // Transform Pivot Point selector in header (inserted dynamically near Snap)
    const headerToolsBar = document.querySelector('.b-vp-tools-bar');
    if (headerToolsBar && !document.getElementById('viewport-pivot-select')) {
      const sel = document.createElement('select');
      sel.id = 'viewport-pivot-select';
      sel.className = 'b-vp-select';
      sel.title = 'Transform Pivot Point (.)';
      sel.innerHTML = `
        <option value="median" selected>Median</option>
        <option value="cursor">3D Cursor</option>
        <option value="active">Active</option>
        <option value="individual">Individual</option>
      `;
      sel.addEventListener('change', (e) => this.setPivotMode(e.target.value));
      headerToolsBar.insertBefore(sel, headerToolsBar.children[1] || null);
    }

    // Upgrade Help -> Keyboard Shortcuts button to open searchable modal instead of alert()
    const helpShortcutsBtn = document.getElementById('btn-help-shortcuts');
    if (helpShortcutsBtn) {
      helpShortcutsBtn.addEventListener('click', (e) => {
        e.stopImmediatePropagation();
        document.querySelectorAll('.menu-item.open').forEach(m => m.classList.remove('open'));
        this.openShortcutsHelp();
      }, true);
    }
  }

  _bindPointerNavigation() {
    const dom = this.engine?.domElement;
    if (!dom) return;
    dom.addEventListener('pointerdown', this._onCapturePointerDown, true);
    window.addEventListener('pointermove', this._onWindowPointerMove, false);
    window.addEventListener('pointerup', this._onWindowPointerUp, false);
  }

  _onCapturePointerDown(e) {
    const activePane = (this.engine?.areaManager && !this.engine.areaManager.isSingleFullViewport())
      ? this.engine.areaManager.getPaneAtClientPoint(e.clientX, e.clientY)
      : null;
    const controls = activePane?.controls || this.engine?.controls;
    if (!controls) return;

    // 1. Ctrl+MMB -> Zoom/Dolly dynamically in BOTH keymaps
    if (e.button === 1 && (e.ctrlKey || e.metaKey)) {
      controls.mouseButtons.MIDDLE = THREE.MOUSE.DOLLY;
      this._tempMouseOverride = true;
      return;
    }

    // 2. Shift+MMB -> OrbitControls treats ROTATE + shiftKey as STATE.PAN
    // (setting PAN + shiftKey would invert to ROTATE inside OrbitControls)
    if (e.button === 1 && e.shiftKey) {
      controls.mouseButtons.MIDDLE = THREE.MOUSE.ROTATE;
      this._tempMouseOverride = true;
      return;
    }

    // 3. Blender Pro Emulate 3-Button Mouse (Alt + LMB = Orbit, Alt+Shift = Pan, Alt+Ctrl = Zoom)
    if (this.keymapPreset === 'blender-pro' && e.button === 0 && e.altKey) {
      if (e.ctrlKey || e.metaKey) controls.mouseButtons.LEFT = THREE.MOUSE.DOLLY;
      else if (e.shiftKey) controls.mouseButtons.LEFT = THREE.MOUSE.ROTATE;
      else controls.mouseButtons.LEFT = THREE.MOUSE.ROTATE;
      this._tempMouseOverride = true;
      return;
    }

    // 4. Blender Pro LMB Drag -> Marquee Box Select (when not touching gizmo, sculpt, knife, modal, or area chrome)
    if (
      this.keymapPreset === 'blender-pro' &&
      e.button === 0 &&
      !e.altKey &&
      !e.ctrlKey &&
      !e.metaKey &&
      !this._boxState &&
      !this._circleState &&
      !this.modalTransform?.isActive &&
      !this.editMode?._knifeSession &&
      !(typeof window !== 'undefined' && window.sculptMode?.isActive) &&
      !this.engine?.areaManager?._dragState &&
      !this.engine?.areaManager?._splitterDrag &&
      !document.body.classList.contains('is-dragging-area-corner') &&
      !document.body.classList.contains('is-resizing-split') &&
      this.modelingSuite?.activeTool !== 'measure' &&
      this.modelingSuite?.activeTool !== 'cursor'
    ) {
      const tc = this.engine.transformControls;
      const touchingGizmo = tc && (tc.dragging || tc.hovered || Boolean(tc.axis));
      if (!touchingGizmo) {
        this._lmbCandidate = { startX: e.clientX, startY: e.clientY, event: e };
      }
    }
  }

  _onWindowPointerMove(e) {
    if (this._lmbCandidate && !this._boxState) {
      if (this.engine?.transformControls?.dragging) {
        this._lmbCandidate = null;
        return;
      }
      const dist = Math.hypot(e.clientX - this._lmbCandidate.startX, e.clientY - this._lmbCandidate.startY);
      if (dist > 5) {
        const start = this._lmbCandidate;
        this._lmbCandidate = null;
        this._beginMarqueeOverlay(start.startX, start.startY, e.clientX, e.clientY);
      }
    }
    if (this._boxState && this._boxState.isDragging) {
      this._updateMarqueeOverlay(e.clientX, e.clientY);
    }
    if (this._circleState) {
      this._updateCircleCursorPos(e.clientX, e.clientY);
      if (e.buttons & 1) {
        this._paintCircleSelection(e.clientX, e.clientY, e.shiftKey ? 'remove' : 'add');
      }
    }
  }

  _onWindowPointerUp(e) {
    this._lmbCandidate = null;

    if (this._tempMouseOverride && this.engine?.controls) {
      this._tempMouseOverride = false;
      this.setKeymapPreset(this.keymapPreset, false);
    }

    if (this._boxState && this._boxState.isDragging) {
      this._finishMarqueeOverlay(e);
    }
  }

  // =========================================================================
  // 3. BOX SELECT (B / LMB DRAG) & CIRCLE SELECT (C)
  // =========================================================================

  startBoxSelect() {
    if (!this.engine?.domElement || this._boxState) return false;
    this.cancelCircleSelect();

    const host = document.getElementById('viewport-canvas-host') || this.engine.domElement.parentElement;
    if (!host) return false;

    const prevControls = this.engine.controls ? this.engine.controls.enabled : true;
    if (this.engine.controls) this.engine.controls.enabled = false;
    host.style.cursor = 'crosshair';

    const onDown = (e) => {
      if (e.button === 0) {
        e.preventDefault();
        e.stopPropagation();
        this._beginMarqueeOverlay(e.clientX, e.clientY, e.clientX, e.clientY, prevControls);
        dom.removeEventListener('pointerdown', onDown, true);
      } else if (e.button === 2 || e.button === 1) {
        e.preventDefault();
        this._cancelBoxSelect(prevControls);
      }
    };
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        this._cancelBoxSelect(prevControls);
      }
    };

    const dom = this.engine.domElement;
    dom.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey, true);

    this._boxState = {
      isDragging: false,
      armed: true,
      prevControls,
      cleanupArmed: () => {
        dom.removeEventListener('pointerdown', onDown, true);
        window.removeEventListener('keydown', onKey, true);
        host.style.cursor = '';
      }
    };
    return true;
  }

  _cancelBoxSelect(prevControls = true) {
    if (!this._boxState) return;
    this._boxState.cleanupArmed?.();
    this._boxState.boxEl?.remove();
    const host = document.getElementById('viewport-canvas-host');
    if (host) host.style.cursor = '';
    if (this.engine?.controls) this.engine.controls.enabled = prevControls;
    this._boxState = null;
  }

  _beginMarqueeOverlay(x0, y0, x1, y1, prevControls = null) {
    const host = document.getElementById('viewport-canvas-host') || this.engine?.domElement?.parentElement;
    if (!host) return;

    this._boxState?.cleanupArmed?.();
    const wasEnabled = prevControls !== null ? prevControls : (this.engine?.controls ? this.engine.controls.enabled : true);
    if (this.engine?.controls) this.engine.controls.enabled = false;

    const boxEl = document.createElement('div');
    boxEl.className = 'blender-marquee-box';
    host.appendChild(boxEl);

    this._boxState = {
      isDragging: true,
      armed: false,
      startX: x0,
      startY: y0,
      curX: x1,
      curY: y1,
      boxEl,
      prevControls: wasEnabled
    };
    this._updateMarqueeOverlay(x1, y1);
  }

  _updateMarqueeOverlay(cx, cy) {
    if (!this._boxState?.boxEl) return;
    const hostRect = (document.getElementById('viewport-canvas-host') || this.engine.domElement).getBoundingClientRect();
    this._boxState.curX = cx;
    this._boxState.curY = cy;

    const left = Math.min(this._boxState.startX, cx) - hostRect.left;
    const top = Math.min(this._boxState.startY, cy) - hostRect.top;
    const width = Math.abs(cx - this._boxState.startX);
    const height = Math.abs(cy - this._boxState.startY);

    const el = this._boxState.boxEl;
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
    el.style.width = `${width}px`;
    el.style.height = `${height}px`;
  }

  _finishMarqueeOverlay(e) {
    const st = this._boxState;
    if (!st) return;
    st.boxEl?.remove();
    if (this.engine?.controls) this.engine.controls.enabled = st.prevControls;
    this._boxState = null;

    const minX = Math.min(st.startX, st.curX);
    const maxX = Math.max(st.startX, st.curX);
    const minY = Math.min(st.startY, st.curY);
    const maxY = Math.max(st.startY, st.curY);
    if (maxX - minX < 3 && maxY - minY < 3) return;

    const mode = e.ctrlKey ? 'remove' : (e.shiftKey ? 'add' : 'replace');
    const anchorX = (st.startX + st.curX) * 0.5;
    const anchorY = (st.startY + st.curY) * 0.5;
    this.selectRegionBox(minX, minY, maxX, maxY, mode, anchorX, anchorY);
  }

  /**
   * Programmatic & Interactive screen-space Box Selection (Object Mode & Edit Mode).
   */
  selectRegionBox(minX, minY, maxX, maxY, mode = 'replace', anchorX = (minX + maxX) * 0.5, anchorY = (minY + maxY) * 0.5) {
    return this._applyScreenPredicate(
      (sx, sy) => sx >= minX && sx <= maxX && sy >= minY && sy <= maxY,
      mode,
      anchorX,
      anchorY
    );
  }

  startCircleSelect() {
    if (!this.engine?.domElement) return false;
    if (this._circleState) {
      this.cancelCircleSelect();
      return false;
    }

    const host = document.getElementById('viewport-canvas-host') || this.engine.domElement.parentElement;
    if (!host) return false;

    const circleEl = document.createElement('div');
    circleEl.className = 'blender-circle-cursor';
    host.appendChild(circleEl);

    const radius = 44;
    circleEl.style.width = `${radius * 2}px`;
    circleEl.style.height = `${radius * 2}px`;

    const prevControls = this.engine.controls ? this.engine.controls.enabled : true;
    if (this.engine.controls) this.engine.controls.enabled = false;

    const onWheel = (e) => {
      if (!this._circleState) return;
      e.preventDefault();
      e.stopPropagation();
      this._circleState.radius = Math.max(14, Math.min(180, this._circleState.radius + (e.deltaY < 0 ? 6 : -6)));
      const r = this._circleState.radius;
      circleEl.style.width = `${r * 2}px`;
      circleEl.style.height = `${r * 2}px`;
    };
    const onDown = (e) => {
      if (!this._circleState) return;
      if (e.button === 0) {
        e.preventDefault();
        e.stopPropagation();
        this._paintCircleSelection(e.clientX, e.clientY, e.shiftKey ? 'remove' : 'add');
      } else if (e.button === 2) {
        e.preventDefault();
        e.stopPropagation();
        this.cancelCircleSelect();
      }
    };
    const onKey = (e) => {
      if (!this._circleState) return;
      if (e.key === 'Escape' || e.key === 'Enter' || e.key.toLowerCase() === 'c') {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        this.cancelCircleSelect();
      }
    };

    const dom = this.engine.domElement;
    dom.addEventListener('wheel', onWheel, { capture: true, passive: false });
    dom.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey, true);

    this._circleState = {
      radius,
      circleEl,
      prevControls,
      cleanup: () => {
        dom.removeEventListener('wheel', onWheel, true);
        dom.removeEventListener('pointerdown', onDown, true);
        window.removeEventListener('keydown', onKey, true);
        circleEl.remove();
        if (this.engine?.controls) this.engine.controls.enabled = prevControls;
      }
    };
    return true;
  }

  cancelCircleSelect() {
    if (!this._circleState) return false;
    this._circleState.cleanup();
    this._circleState = null;
    return true;
  }

  _updateCircleCursorPos(clientX, clientY) {
    if (!this._circleState?.circleEl) return;
    const hostRect = (document.getElementById('viewport-canvas-host') || this.engine.domElement).getBoundingClientRect();
    const r = this._circleState.radius;
    this._circleState.circleEl.style.left = `${clientX - hostRect.left - r}px`;
    this._circleState.circleEl.style.top = `${clientY - hostRect.top - r}px`;
  }

  _paintCircleSelection(clientX, clientY, mode = 'add') {
    const r = this._circleState ? this._circleState.radius : 44;
    const rSq = r * r;
    return this._applyScreenPredicate((sx, sy) => ((sx - clientX) ** 2 + (sy - clientY) ** 2) <= rSq, mode, clientX, clientY);
  }

  _applyScreenPredicate(predicate, mode = 'replace', clientX = NaN, clientY = NaN) {
    if (!this.engine?.camera || !this.engine?.domElement) return 0;
    const vpCtx = this.engine.getViewportContextAtPoint
      ? this.engine.getViewportContextAtPoint(clientX, clientY)
      : {
          rect: this.engine.getViewportRect ? this.engine.getViewportRect() : this.engine.domElement.getBoundingClientRect(),
          camera: this.engine.camera
        };
    const rect = vpCtx.rect;
    const camera = vpCtx.camera || this.engine.camera;

    const projectToScreen = (worldVec) => {
      const p = worldVec.clone().project(camera);
      if (p.z < -1 || p.z > 1) return null;
      return {
        x: rect.left + ((p.x + 1) * 0.5) * rect.width,
        y: rect.top + ((-p.y + 1) * 0.5) * rect.height
      };
    };

    // Edit Mode region select (Vertex / Edge midpoint / Face centroid)
    if (this.editMode && this.editMode.isActive && this.editMode.targetMesh) {
      const em = this.editMode;
      const mat = em.targetMesh.matrixWorld;
      const tmp = new THREE.Vector3();
      let count = 0;

      if (em.selectionMode === 'vertex') {
        if (mode === 'replace') em.selectedVertices.clear();
        for (let i = 0; i < em.vertices.length; i++) {
          const sp = projectToScreen(tmp.copy(em.vertices[i]).applyMatrix4(mat));
          if (sp && predicate(sp.x, sp.y)) {
            if (mode === 'remove') em.selectedVertices.delete(i);
            else em.selectedVertices.add(i);
            count++;
          }
        }
      } else if (em.selectionMode === 'edge') {
        if (mode === 'replace') em.selectedEdges.clear();
        for (let i = 0; i < em.edges.length; i++) {
          const edge = em.edges[i];
          const mid = tmp.addVectors(em.vertices[edge.v0], em.vertices[edge.v1]).multiplyScalar(0.5).applyMatrix4(mat);
          const sp = projectToScreen(mid);
          if (sp && predicate(sp.x, sp.y)) {
            if (mode === 'remove') em.selectedEdges.delete(i);
            else em.selectedEdges.add(i);
            count++;
          }
        }
      } else if (em.selectionMode === 'face') {
        if (mode === 'replace') em.selectedFaces.clear();
        for (let i = 0; i < em.faces.length; i++) {
          const sp = projectToScreen(tmp.copy(em.faces[i].centroid).applyMatrix4(mat));
          if (sp && predicate(sp.x, sp.y)) {
            if (mode === 'remove') em.selectedFaces.delete(i);
            else em.selectedFaces.add(i);
            count++;
          }
        }
      }

      em.updateVisuals();
      em.updateGizmoProxy();
      return count;
    }

    // Object Mode region select
    if (!this.sceneManager) return 0;
    const selectable = this.sceneManager.getSelectableObjects().filter(o => o.visible);
    const matched = [];
    const box = new THREE.Box3();
    const center = new THREE.Vector3();

    for (const obj of selectable) {
      obj.getWorldPosition(center);
      let inside = false;
      const spCenter = projectToScreen(center);
      if (spCenter && predicate(spCenter.x, spCenter.y)) inside = true;
      if (!inside) {
        box.setFromObject(obj);
        if (!box.isEmpty()) {
          box.getCenter(center);
          const spBox = projectToScreen(center);
          if (spBox && predicate(spBox.x, spBox.y)) inside = true;
        }
      }
      if (inside) matched.push(obj);
    }

    if (mode === 'replace') {
      this.sceneManager.clearSelection();
      matched.forEach(o => this.sceneManager.select(o, true));
    } else if (mode === 'add') {
      matched.forEach(o => this.sceneManager.select(o, true));
    } else if (mode === 'remove') {
      matched.forEach(o => this.sceneManager.deselect(o));
    }
    return matched.length;
  }

  // =========================================================================
  // 4. LOCAL VIEW (/), PIVOT MODE, SNAP TOGGLE (Shift+Tab)
  // =========================================================================

  toggleLocalView() {
    if (!this.sceneManager) return false;
    if (this.editMode?.isActive) return false;

    if (!this.isLocalView) {
      this._localViewHidden = [];
      const selected = new Set(this.sceneManager.getSelectedObjects());
      if (selected.size === 0) return false;

      const isSelectedOrDescendant = (obj) => {
        let cur = obj;
        while (cur) {
          if (selected.has(cur)) return true;
          cur = cur.parent;
        }
        return false;
      };

      const allObjs = this.sceneManager.getSelectableObjects();
      for (const obj of allObjs) {
        if (!isSelectedOrDescendant(obj) && obj.visible) {
          this._localViewHidden.push(obj);
          obj.visible = false;
        }
      }
      this.isLocalView = true;
      this.engine?.focusSelection?.();
    } else {
      for (const obj of this._localViewHidden) {
        if (obj) obj.visible = true;
      }
      this._localViewHidden = [];
      this.isLocalView = false;
    }

    const badge = document.getElementById('viewport-local-view-badge');
    if (badge) badge.style.display = this.isLocalView ? 'inline-block' : 'none';
    this.app?.outliner?.render?.();
    return this.isLocalView;
  }

  setPivotMode(mode = 'median') {
    const valid = ['median', 'cursor', 'active', 'individual'];
    const clean = valid.includes(mode) ? mode : 'median';
    if (this.engine) this.engine.pivotMode = clean;
    const sel = document.getElementById('viewport-pivot-select');
    if (sel) sel.value = clean;
    return clean;
  }

  toggleSnap(force = null) {
    const suite = this.modelingSuite || this.app.modelingSuite;
    const cur = Boolean(suite ? suite.snapEnabled : this.engine?.snapEnabled);
    const next = force === null ? !cur : Boolean(force);
    if (suite) suite.snapEnabled = next;
    if (this.engine) {
      this.engine.snapEnabled = next;
      const tc = this.engine.transformControls;
      if (tc) {
        tc.setTranslationSnap(next ? 0.5 : null);
        tc.setRotationSnap(next ? THREE.MathUtils.degToRad(15) : null);
      }
    }
    const btn = document.getElementById('btn-vp-snap');
    if (btn) btn.classList.toggle('active', next);
    return next;
  }

  // =========================================================================
  // 5. SNAP MENU (Shift+S), VIEW PIE (`), PIVOT PIE (.), DELETE (X), APPLY (Ctrl+A)
  // =========================================================================

  _closePieMenu() {
    if (this._activePieKeyHandler && typeof window !== 'undefined') {
      window.removeEventListener('keydown', this._activePieKeyHandler, true);
      this._activePieKeyHandler = null;
    }
    this._activePieEl?.remove();
    this._activePieBackdrop?.remove();
    this._activePieEl = null;
    this._activePieBackdrop = null;
  }

  _openPieMenu({ title, items, clientX, clientY }) {
    this._closePieMenu();

    const backdrop = document.createElement('div');
    backdrop.className = 'blender-pie-backdrop ss-backdrop';
    backdrop.addEventListener('pointerdown', (e) => {
      if (e.target === backdrop) this._closePieMenu();
    });

    const menu = document.createElement('div');
    menu.className = 'blender-pie-menu';
    const x = Math.max(12, Math.min(window.innerWidth - 260, (clientX || window.innerWidth * 0.5) - 120));
    const y = Math.max(12, Math.min(window.innerHeight - 280, (clientY || window.innerHeight * 0.45) - 40));
    menu.style.left = `${x}px`;
    menu.style.top = `${y}px`;

    menu.innerHTML = `<div class="blender-pie-title">${title}</div><div class="blender-pie-list"></div>`;
    const list = menu.querySelector('.blender-pie-list');

    const cleanupAndRun = (item) => {
      this._closePieMenu();
      item.action?.();
    };

    items.forEach((item, idx) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `blender-pie-item${item.danger ? ' danger' : ''}`;
      const num = idx + 1;
      btn.innerHTML = `
        <span class="blender-pie-num">${item.hotkey || num}</span>
        <span class="blender-pie-label">${item.label}</span>
      `;
      btn.addEventListener('click', () => cleanupAndRun(item));
      list.appendChild(btn);
    });

    const onPieKey = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        this._closePieMenu();
        return;
      }
      const k = e.key.toLowerCase();
      const idx = parseInt(e.key, 10) - 1;
      if (!isNaN(idx) && items[idx]) {
        e.preventDefault();
        e.stopPropagation();
        cleanupAndRun(items[idx]);
        return;
      }
      const byHotkey = items.find(it => it.hotkey && it.hotkey.toLowerCase() === k);
      if (byHotkey) {
        e.preventDefault();
        e.stopPropagation();
        cleanupAndRun(byHotkey);
      }
    };
    this._activePieKeyHandler = onPieKey;
    window.addEventListener('keydown', onPieKey, true);

    document.body.appendChild(backdrop);
    document.body.appendChild(menu);
    this._activePieBackdrop = backdrop;
    this._activePieEl = menu;
    return menu;
  }

  openSnapMenu(clientX, clientY) {
    const suite = this.modelingSuite || this.app.modelingSuite;
    const getCursor = () => suite?.cursorPos?.clone() || new THREE.Vector3();

    return this._openPieMenu({
      title: 'Snap (Shift+S)',
      clientX,
      clientY,
      items: [
        { label: 'Selection to Cursor', action: () => this._snapSelectionToPoint(getCursor(), false) },
        { label: 'Selection to Cursor (Keep Offset)', action: () => this._snapSelectionToPoint(getCursor(), true) },
        { label: 'Selection to Grid (0.5m)', action: () => this._snapSelectionToGrid(0.5) },
        { label: 'Cursor to Selected', action: () => this._snapCursorToSelected() },
        { label: 'Cursor to World Origin (0,0,0)', action: () => suite?.setCursorPosition?.(0, 0, 0) },
        { label: 'Cursor to Active', action: () => {
          const active = this.sceneManager?.getActiveObject();
          if (active) {
            const p = new THREE.Vector3();
            active.getWorldPosition(p);
            suite?.setCursorPosition?.(p.x, p.y, p.z);
          }
        }}
      ]
    });
  }

  _snapSelectionToPoint(targetPos, keepOffset = false) {
    if (this.editMode?.isActive && this.editMode.targetMesh) {
      const em = this.editMode;
      const activeIdx = em.getActiveVertexIndices();
      if (activeIdx.length === 0) return false;
      const oldGeom = em.targetMesh.geometry.clone();
      const invMat = em.targetMesh.matrixWorld.clone().invert();
      const localTarget = targetPos.clone().applyMatrix4(invMat);

      if (keepOffset) {
        const center = new THREE.Vector3();
        activeIdx.forEach(i => center.add(em.vertices[i]));
        center.divideScalar(activeIdx.length);
        const delta = localTarget.sub(center);
        activeIdx.forEach(i => em.vertices[i].add(delta));
      } else {
        activeIdx.forEach(i => em.vertices[i].copy(localTarget));
      }
      em.rebuildGeometry();
      em._commitMeshEdit(oldGeom, 'Snap to Cursor', false);
      return true;
    }

    const sel = this.sceneManager?.getSelectedObjects() || [];
    if (sel.length === 0) return false;
    const center = new THREE.Vector3();
    sel.forEach(o => center.add(o.position));
    center.divideScalar(sel.length);
    const delta = targetPos.clone().sub(center);

    for (const obj of sel) {
      const pre = { position: obj.position.clone(), quaternion: obj.quaternion.clone(), scale: obj.scale.clone() };
      const post = {
        position: keepOffset ? obj.position.clone().add(delta) : targetPos.clone(),
        quaternion: obj.quaternion.clone(),
        scale: obj.scale.clone()
      };
      this._applyAndRecordCommand(new TransformCommand(obj, pre, post, () => this.engine?.updateSelectionHelper()));
    }
    return true;
  }

  _snapSelectionToGrid(step = 0.5) {
    const snapV = (v) => v.set(
      Math.round(v.x / step) * step,
      Math.round(v.y / step) * step,
      Math.round(v.z / step) * step
    );
    if (this.editMode?.isActive && this.editMode.targetMesh) {
      const em = this.editMode;
      const activeIdx = em.getActiveVertexIndices();
      if (activeIdx.length === 0) return false;
      const oldGeom = em.targetMesh.geometry.clone();
      activeIdx.forEach(i => snapV(em.vertices[i]));
      em.rebuildGeometry();
      em._commitMeshEdit(oldGeom, 'Snap to Grid', false);
      return true;
    }
    const sel = this.sceneManager?.getSelectedObjects() || [];
    for (const obj of sel) {
      const pre = { position: obj.position.clone(), quaternion: obj.quaternion.clone(), scale: obj.scale.clone() };
      const post = {
        position: snapV(obj.position.clone()),
        quaternion: obj.quaternion.clone(),
        scale: obj.scale.clone()
      };
      this._applyAndRecordCommand(new TransformCommand(obj, pre, post, () => this.engine?.updateSelectionHelper()));
    }
    return sel.length > 0;
  }

  _applyAndRecordCommand(cmd) {
    if (!cmd) return;
    cmd.execute();
    this.sceneManager?.executeCommand(cmd);
  }

  _snapCursorToSelected() {
    const suite = this.modelingSuite || this.app.modelingSuite;
    if (!suite) return false;
    if (this.editMode?.isActive && this.editMode.targetMesh) {
      const activeIdx = this.editMode.getActiveVertexIndices();
      if (activeIdx.length === 0) return false;
      const center = new THREE.Vector3();
      activeIdx.forEach(i => center.add(this.editMode.vertices[i]));
      center.divideScalar(activeIdx.length).applyMatrix4(this.editMode.targetMesh.matrixWorld);
      suite.setCursorPosition(center.x, center.y, center.z);
      return true;
    }
    const sel = this.sceneManager?.getSelectedObjects() || [];
    if (sel.length === 0) return false;
    const center = new THREE.Vector3();
    const wp = new THREE.Vector3();
    sel.forEach(o => { o.getWorldPosition(wp); center.add(wp); });
    center.divideScalar(sel.length);
    suite.setCursorPosition(center.x, center.y, center.z);
    return true;
  }

  openViewPieMenu(clientX, clientY) {
    return this._openPieMenu({
      title: 'View Pie (`)',
      clientX,
      clientY,
      items: [
        { label: 'Front View', hotkey: '1', action: () => this.engine?.setCameraPreset('front') },
        { label: 'Back View', action: () => this.engine?.setCameraPreset('back') },
        { label: 'Top View', hotkey: '7', action: () => this.engine?.setCameraPreset('top') },
        { label: 'Bottom View', action: () => this.engine?.setCameraPreset('bottom') },
        { label: 'Right View', hotkey: '3', action: () => this.engine?.setCameraPreset('right') },
        { label: 'Left View', action: () => this.engine?.setCameraPreset('left') },
        { label: 'Active Camera', hotkey: '0', action: () => window.cameraManager?.toggleViewCamera?.(this.sceneManager?.getActiveObject?.()) },
        { label: 'Frame Selected', action: () => this.engine?.focusSelection?.() }
      ]
    });
  }

  openPivotMenu(clientX, clientY) {
    return this._openPieMenu({
      title: 'Pivot Point (.)',
      clientX,
      clientY,
      items: [
        { label: 'Median Point', action: () => this.setPivotMode('median') },
        { label: '3D Cursor', action: () => this.setPivotMode('cursor') },
        { label: 'Active Element', action: () => this.setPivotMode('active') },
        { label: 'Individual Origins', action: () => this.setPivotMode('individual') }
      ]
    });
  }

  openEditDeleteMenu(clientX, clientY) {
    if (!this.editMode?.isActive) return null;
    const em = this.editMode;
    return this._openPieMenu({
      title: 'Delete (X)',
      clientX,
      clientY,
      items: [
        { label: 'Vertices / Auto Delete', hotkey: 'V', danger: true, action: () => { em.deleteSelection(); } },
        { label: 'Edges', hotkey: 'E', danger: true, action: () => { em.setMode('edge'); em.deleteSelection(); } },
        { label: 'Faces', hotkey: 'F', danger: true, action: () => { em.setMode('face'); em.deleteSelection(); } },
        { label: 'Only Faces (Keep Edges)', action: () => em.deleteSelection('only_faces') },
        { label: 'Dissolve Selection (Keep Boundary)', hotkey: 'D', action: () => em.dissolveSelection() }
      ]
    });
  }

  openEditUVMenu(clientX, clientY) {
    if (!this.editMode?.isActive) return null;
    const em = this.editMode;
    const refreshUV = () => {
      if (typeof window !== 'undefined' && window.uvEditor) {
        window.uvEditor.clearSelection?.();
        window.uvEditor.render?.();
      }
    };
    const run = (method, opts) => {
      const ok = em.unwrap(method, opts);
      if (ok) refreshUV();
    };
    return this._openPieMenu({
      title: 'UV Mapping (U)',
      clientX,
      clientY,
      items: [
        { label: 'Unwrap (LSCM)', hotkey: 'U', action: () => run('lscm') },
        { label: 'Smart UV Project', hotkey: 'S', action: () => run('smart') },
        { label: 'Cube Projection', hotkey: 'C', action: () => run('cube') },
        { label: 'Cylinder Projection', action: () => run('cylinder') },
        { label: 'Sphere Projection', action: () => run('sphere') },
        { label: 'Project from View', hotkey: 'V', action: () => {
          if (typeof window !== 'undefined' && window.uvEditor?.projectFromView) {
            window.uvEditor.projectFromView();
          } else {
            run('smart');
          }
        }},
        { label: 'Pack Islands', hotkey: 'P', action: () => run('pack') },
        { label: 'Average Islands Scale', hotkey: 'A', action: () => run('average') },
        { label: 'Mark Seam', hotkey: 'M', action: () => { em.markSeam(false); } },
        { label: 'Clear Seam', hotkey: 'L', action: () => { em.clearSeam(); } },
        { label: 'Select Seams', action: () => { em.selectSeams(); } },
        { label: 'Reset UVs', hotkey: 'R', danger: true, action: () => run('reset') }
      ]
    });
  }

  openEditEdgeMenu(clientX, clientY) {
    if (!this.editMode?.isActive) return null;
    const em = this.editMode;
    const suite = this.modelingSuite || this.app?.modelingSuite;
    return this._openPieMenu({
      title: 'Edge (Ctrl+E)',
      clientX,
      clientY,
      items: [
        { label: 'Mark Seam', hotkey: 'M', action: () => em.markSeam(false) },
        { label: 'Clear Seam', hotkey: 'C', action: () => em.clearSeam() },
        { label: 'Select Seams', action: () => em.selectSeams() },
        { label: 'Bevel Edges (Ctrl+B)', hotkey: 'B', action: () => suite?.runBevelWithAdjust ? suite.runBevelWithAdjust(0.08, 2) : em.bevel(0.08, 2) },
        { label: 'Bridge Edge Loops', hotkey: 'E', action: () => em.bridgeEdgeLoops() },
        { label: 'Subdivide', hotkey: 'S', action: () => em.subdivide() },
        { label: 'Loop Cut (Ctrl+R)', hotkey: 'R', action: () => em.loopCut() },
        { label: 'Edge Slide (GG)', hotkey: 'G', action: () => {
          const mt = this.modalTransform || this.app?.modalTransform;
          if (mt?.start?.('translate') && em.prepareSlideTransform?.()) {
            mt.isSlideMode = true;
            mt._renderHUD?.('Slide Factor: 0.000 (Clamp: ON · C to toggle)');
          }
        }},
        { label: 'Select Edge Loop (Alt+Click)', hotkey: 'L', action: () => em.selectEdgeLoop() }
      ]
    });
  }

  openApplyMenu(clientX, clientY) {
    const suite = this.modelingSuite || this.app.modelingSuite;
    if (!suite || this.editMode?.isActive) return null;
    return this._openPieMenu({
      title: 'Apply Transform (Ctrl+A)',
      clientX,
      clientY,
      items: [
        { label: 'Location', hotkey: 'L', action: () => suite.applyAllTransforms(true, false, false) },
        { label: 'Rotation', hotkey: 'R', action: () => suite.applyAllTransforms(false, true, false) },
        { label: 'Scale', hotkey: 'S', action: () => suite.applyAllTransforms(false, false, true) },
        { label: 'Rotation & Scale', hotkey: 'B', action: () => suite.applyAllTransforms(false, true, true) },
        { label: 'All Transforms', hotkey: 'A', action: () => suite.applyAllTransforms(true, true, true) }
      ]
    });
  }

  // =========================================================================
  // 6. OBJECT MODE PRO OPERATORS (Alt+G/R/S, Ctrl+P / Alt+P, Alt+D)
  // =========================================================================

  clearSelectedTransform(channel = 'position') {
    const sel = this.sceneManager?.getSelectedObjects() || [];
    if (sel.length === 0) return false;
    for (const obj of sel) {
      const pre = { position: obj.position.clone(), quaternion: obj.quaternion.clone(), scale: obj.scale.clone() };
      const post = {
        position: channel === 'position' ? new THREE.Vector3(0, 0, 0) : obj.position.clone(),
        quaternion: channel === 'rotation' ? new THREE.Quaternion() : obj.quaternion.clone(),
        scale: channel === 'scale' ? new THREE.Vector3(1, 1, 1) : obj.scale.clone()
      };
      this._applyAndRecordCommand(new TransformCommand(obj, pre, post, () => this.engine?.updateSelectionHelper()));
    }
    return true;
  }

  parentSelectedToActive() {
    if (!this.sceneManager || this.editMode?.isActive) return false;
    const selected = this.sceneManager.getSelectedObjects();
    const active = this.sceneManager.getActiveObject();
    if (selected.length < 2 || !active) return false;
    const children = selected.filter(o => o !== active);
    if (children.length === 0) return false;
    this._applyAndRecordCommand(new ReparentCommand(children, active, 'Set Parent (Ctrl+P)'));
    this.app?.outliner?.render?.();
    return true;
  }

  clearParentSelected() {
    if (!this.sceneManager || this.editMode?.isActive) return false;
    const selected = this.sceneManager.getSelectedObjects();
    const root = this.sceneManager.rootContainer || this.engine?.scene;
    if (selected.length === 0 || !root) return false;
    const withParent = selected.filter(o => o.parent && o.parent !== root);
    if (withParent.length === 0) return false;
    this._applyAndRecordCommand(new ReparentCommand(withParent, root, 'Clear Parent (Alt+P)'));
    this.app?.outliner?.render?.();
    return true;
  }

  _cleanLinkedBaseName(rawName, fallback = 'Object') {
    const cleaned = String(rawName || fallback)
      .replace(/(?:_Linked)+(?:_\d+|\.\d+)*$/i, '')
      .replace(/(?:_\d+)$/, '')
      .trim();
    return cleaned || fallback;
  }

  _getPrimaryGeometrySignature(obj) {
    if (!obj || obj.userData?.isScatterGroup || obj.userData?.isImageObject || obj.userData?.curveData) return null;
    if (obj.isMesh && !obj.isSkinnedMesh) {
      return (obj.userData?.baseGeometry || obj.geometry)?.uuid || null;
    }
    let sig = null;
    let hasSkinned = false;
    obj.traverse?.((n) => {
      if (n?.isSkinnedMesh) hasSkinned = true;
      if (!sig && n?.isMesh && !n.isSkinnedMesh && !n.userData?.isHelper && !n.userData?.isSystemObject) {
        sig = (n.userData?.baseGeometry || n.geometry)?.uuid || null;
      }
    });
    return hasSkinned ? null : sig;
  }

  _cloneLinkedNode(src, isRoot = true) {
    if (!src || src.userData?.isHelper || src.userData?.isSystemObject || src.userData?.isSelectionOutline) {
      return null;
    }
    if (src.isMesh && !src.isSkinnedMesh) {
      const baseGeom = src.userData?.baseGeometry || src.geometry;
      const clone = new THREE.Mesh(baseGeom, src.material);
      clone.name = isRoot ? `${this._cleanLinkedBaseName(src.name, 'Object')}_Linked` : (src.name || 'Part');
      clone.position.copy(src.position);
      clone.quaternion.copy(src.quaternion);
      clone.scale.copy(src.scale);
      clone.visible = src.visible;
      clone.castShadow = src.castShadow;
      clone.receiveShadow = src.receiveShadow;
      if (src.userData?.__importedMaterial) {
        clone.userData.__importedMaterial = src.userData.__importedMaterial;
      }
      dataBlockRegistry.linkMeshData(clone, src);
      for (const child of src.children || []) {
        const cClone = this._cloneLinkedNode(child, false);
        if (cClone) clone.add(cClone);
      }
      return clone;
    }
    if (src.isGroup || src.type === 'Object3D' || (src.children && src.children.length > 0)) {
      let hasMesh = false;
      let hasSkinned = false;
      src.traverse?.((n) => {
        if (n?.isMesh && !n.userData?.isHelper && !n.userData?.isSystemObject) {
          hasMesh = true;
          if (n.isSkinnedMesh) hasSkinned = true;
        }
      });
      if (!hasMesh) return null;
      const cleanRoot = `${this._cleanLinkedBaseName(src.name, 'Group')}_Linked`;
      if (hasSkinned) {
        const clonedGroup = src.clone(true);
        clonedGroup.name = isRoot ? cleanRoot : (src.name || 'Group');
        return clonedGroup;
      }
      const grp = src.isGroup ? new THREE.Group() : new THREE.Object3D();
      grp.name = isRoot ? cleanRoot : (src.name || 'Group');
      grp.position.copy(src.position);
      grp.quaternion.copy(src.quaternion);
      grp.scale.copy(src.scale);
      grp.visible = src.visible;
      for (const child of src.children || []) {
        const cClone = this._cloneLinkedNode(child, false);
        if (cClone) grp.add(cClone);
      }
      return grp;
    }
    return null;
  }

  duplicateLinkedSelection(offset = { x: 1, y: 0, z: 1 }, { autoInstanceThreshold = 6 } = {}) {
    if (!this.sceneManager || this.editMode?.isActive) return 0;
    const selected = this.sceneManager.getSelectedObjects();
    if (selected.length === 0) return 0;

    // If selection is ALREADY a GPU InstancedScatterGroup, append a new GPU instance inside the same group (0 extra draw calls!)
    const instSys = this.engine?.instancingSystem || (typeof window !== 'undefined' ? window.instancingSystem : null);
    if (selected.length === 1 && selected[0]?.userData?.isScatterGroup && instSys) {
      instSys.appendInstanceToGroup(selected[0]);
      return 1;
    }

    const entries = [];
    for (const src of selected) {
      const clone = this._cloneLinkedNode(src, true);
      if (!clone) continue;
      if (offset) {
        clone.position.x += Number(offset.x || 0);
        clone.position.y += Number(offset.y || 0);
        clone.position.z += Number(offset.z || 0);
      }
      const parent = src.parent || this.sceneManager.rootContainer;
      if (this.sceneManager.generateUniqueName && clone.name) {
        clone.name = this.sceneManager.generateUniqueName(clone.name);
      }
      this.sceneManager.addObject(clone, parent, false, false);
      entries.push({ object: clone, parent });
    }

    if (entries.length > 0) {
      this.sceneManager.executeCommand(new AddObjectsCommand(this.sceneManager, entries, 'Linked Duplicate (Alt/⌥+D)'));

      // Smart Web GPU Upgrade: once >= 6 linked copies of the same asset exist at scene root,
      // automatically pool them into 1 GPU InstancedScatterGroup (3-tier Rust QEM Auto-LOD + 1 draw call/mat = 60 FPS!)
      if (
        autoInstanceThreshold > 0 &&
        entries.length === 1 &&
        instSys &&
        typeof instSys.batchMeshesToInstanceGroupSync === 'function'
      ) {
        const created = entries[0].object;
        const sig = this._getPrimaryGeometrySignature(created);
        const rootChildren = this.sceneManager.rootContainer?.children || [];
        if (sig && rootChildren.length >= autoInstanceThreshold) {
          const siblings = rootChildren.filter((child) => (
            child &&
            child.visible &&
            !child.userData?.isSystemObject &&
            !child.userData?.isHelper &&
            !child.userData?.isScatterGroup &&
            ModifierStack.getStack(child).length === 0 &&
            this._getPrimaryGeometrySignature(child) === sig
          ));
          if (siblings.length >= autoInstanceThreshold) {
            const batched = instSys.batchMeshesToInstanceGroupSync(siblings, {
              sceneManager: this.sceneManager,
            });
            if (batched) {
              this.app?.outliner?.queueRender?.();
              this.app?.inspector?.setTargetObject?.(batched);
              this.app?.exporter?.showToast?.(
                `⚡ Tự động gộp ${siblings.length} bản sao sang GPU Instancing (60 FPS · 1 cụm duy nhất)`,
                'success'
              );
              return 1;
            }
          }
        }
      }

      this.sceneManager.setSelection(entries.map((entry) => entry.object));
      this.engine?.setTransformMode?.('translate');
      this.app?.outliner?.queueRender?.();
      this.engine?.requestRender?.();
    }
    return entries.length;
  }

  async batchSelectionToGpuInstances() {
    if (!this.sceneManager || this.editMode?.isActive) return null;
    const instSys = this.engine?.instancingSystem || (typeof window !== 'undefined' ? window.instancingSystem : null);
    if (!instSys) return null;
    const selected = (this.sceneManager.getSelectedObjects?.() || []).filter((o) => {
      if (!o || o.userData?.isSystemObject || o.userData?.isHelper || o.userData?.isScatterGroup) return false;
      if (o.isMesh) return true;
      let foundMesh = false;
      o.traverse?.((n) => {
        if (n?.isMesh && !n.userData?.isSystemObject && !n.userData?.isHelper) foundMesh = true;
      });
      return foundMesh;
    });
    if (selected.length === 0) return null;
    const grp = await instSys.batchMeshesToInstanceGroup(selected, { sceneManager: this.sceneManager });
    this.app?.outliner?.render?.();
    this.app?.inspector?.render?.();
    return grp;
  }

  // =========================================================================
  // 7. GLOBAL KEYBOARD SHORTCUT HANDLER
  // =========================================================================

  _onWindowKeyDown(event) {
    // Allow Screen 2 / Fullscreen toggle anywhere outside pure text typing (even during dialog/viewport)
    const tag = document.activeElement ? document.activeElement.tagName.toLowerCase() : '';
    const isTyping = tag === 'input' || tag === 'textarea' || tag === 'select' || document.activeElement?.isContentEditable;
    const key = event.key.toLowerCase();

    if (!isTyping && !event.metaKey && !shouldBlockViewportShortcut()) {
      if (event.code === 'Space' && event.ctrlKey && event.altKey && !event.shiftKey) {
        event.preventDefault();
        event.stopImmediatePropagation();
        this.toggleFullscreenViewport();
        return;
      }
      if ((event.code === 'Space' && event.altKey && !event.ctrlKey && !event.shiftKey) ||
          (event.code === 'Backslash' && event.ctrlKey && !event.altKey && !event.shiftKey)) {
        event.preventDefault();
        event.stopImmediatePropagation();
        this.toggleBottomDock();
        return;
      }
      if ((key === 'q' || event.code === 'KeyQ') && event.ctrlKey && event.altKey && !event.shiftKey) {
        event.preventDefault();
        event.stopImmediatePropagation();
        this.app?.areaManager?.toggleQuadView?.();
        return;
      }
    }

    if (shouldBlockViewportShortcut()) return;
    if (event.metaKey) return; // Never hijack Cmd+* OS/Browser shortcuts
    // Yield completely while an active modal G/R/S/Slide or interactive Knife session owns keys
    if (this.modalTransform?.isActive || this.editMode?._knifeSession) return;

    // Shift + Tab -> Persistent Snap Toggle (must run before Engine's Tab Edit Mode toggle)
    if (event.code === 'Tab' && event.shiftKey && !event.ctrlKey && !event.altKey) {
      event.preventDefault();
      event.stopImmediatePropagation();
      this.toggleSnap();
      return;
    }

    // Shift + S -> Snap Pie Menu
    if ((key === 's' || event.code === 'KeyS') && event.shiftKey && !event.ctrlKey && !event.altKey) {
      event.preventDefault();
      event.stopImmediatePropagation();
      this.openSnapMenu();
      return;
    }

    // Backquote (`) -> View Pie Menu
    if (event.code === 'Backquote' && !event.ctrlKey && !event.altKey && !event.shiftKey) {
      event.preventDefault();
      event.stopImmediatePropagation();
      this.openViewPieMenu();
      return;
    }

    // Period (.) in Blender Pro -> Pivot Pie Menu (NumpadDecimal remains Frame Selected)
    if (this.keymapPreset === 'blender-pro' && event.code === 'Period' && !event.ctrlKey && !event.altKey && !event.shiftKey) {
      event.preventDefault();
      event.stopImmediatePropagation();
      this.openPivotMenu();
      return;
    }

    // Box Select (B) & Circle Select (C)
    if ((key === 'b' || event.code === 'KeyB') && !event.ctrlKey && !event.altKey && !event.shiftKey) {
      event.preventDefault();
      event.stopImmediatePropagation();
      this.startBoxSelect();
      return;
    }
    if ((key === 'c' || event.code === 'KeyC') && !event.ctrlKey && !event.altKey && !event.shiftKey) {
      if (this.sculptMode?.isActive || this.app?.sculptMode?.isActive || this.paintMode?.isActive || this.app?.paintMode?.isActive || window.sculptMode?.isActive || window.paintMode?.isActive) {
        return;
      }
      event.preventDefault();
      event.stopImmediatePropagation();
      this.startCircleSelect();
      return;
    }

    // Local View (/)
    if ((event.code === 'Slash' || event.code === 'NumpadDivide') && !event.ctrlKey && !event.altKey && !event.shiftKey) {
      event.preventDefault();
      event.stopImmediatePropagation();
      this.toggleLocalView();
      return;
    }

    // Object Mode only Pro Shortcuts (match event.code + macOS Option characters + keyCode so macOS/VN IME Option+D always works)
    if (!this.editMode?.isActive && !(typeof window !== 'undefined' && window.sculptMode?.isActive)) {
      const isKeyD = event.code === 'KeyD' || key === 'd' || key === '∂' || key === 'đ' || event.keyCode === 68;
      if (event.altKey && !event.ctrlKey && !event.shiftKey) {
        if (event.code === 'KeyG' || key === 'g') { event.preventDefault(); event.stopImmediatePropagation(); this.clearSelectedTransform('position'); return; }
        if (event.code === 'KeyR' || key === 'r') { event.preventDefault(); event.stopImmediatePropagation(); this.clearSelectedTransform('rotation'); return; }
        if (event.code === 'KeyS' || key === 's') { event.preventDefault(); event.stopImmediatePropagation(); this.clearSelectedTransform('scale'); return; }
        if (event.code === 'KeyP' || key === 'p') { event.preventDefault(); event.stopImmediatePropagation(); this.clearParentSelected(); return; }
        if (isKeyD) { event.preventDefault(); event.stopImmediatePropagation(); this.duplicateLinkedSelection(); return; }
      }
      if (event.altKey && event.shiftKey && !event.ctrlKey && isKeyD) {
        event.preventDefault();
        event.stopImmediatePropagation();
        this.batchSelectionToGpuInstances();
        return;
      }
      if (event.ctrlKey && !event.altKey && !event.shiftKey && (event.code === 'KeyP' || key === 'p')) {
        event.preventDefault();
        event.stopImmediatePropagation();
        this.parentSelectedToActive();
        return;
      }
      if (event.ctrlKey && !event.altKey && !event.shiftKey && (event.code === 'KeyA' || key === 'a')) {
        event.preventDefault();
        event.stopImmediatePropagation();
        this.openApplyMenu();
        return;
      }

      // BoolTool / Hard-Surface Quick Shortcuts
      if (event.ctrlKey && !event.altKey && !event.shiftKey &&
          (event.code === 'NumpadSubtract' || event.code === 'Minus' || event.key === '-')) {
        event.preventDefault();
        event.stopImmediatePropagation();
        this.applyQuickBoolean('difference');
        return;
      }
      if (event.ctrlKey && !event.altKey &&
          (event.code === 'NumpadAdd' || event.code === 'Equal' || event.key === '+')) {
        event.preventDefault();
        event.stopImmediatePropagation();
        this.applyQuickBoolean('union');
        return;
      }
      if (event.ctrlKey && !event.altKey &&
          (event.code === 'NumpadMultiply' || (event.shiftKey && event.code === 'Digit8') || event.key === '*')) {
        event.preventDefault();
        event.stopImmediatePropagation();
        this.applyQuickBoolean('intersect');
        return;
      }
      if (event.ctrlKey && event.shiftKey && !event.altKey && (event.code === 'KeyB' || key === 'b')) {
        event.preventDefault();
        event.stopImmediatePropagation();
        this.openBooleanMenu(this._lastPointer?.x, this._lastPointer?.y);
        return;
      }
    }
  }

  openBooleanMenu(clientX, clientY) {
    const active = this.sceneManager?.getActiveObject?.() || this.sceneManager?.getSelectedObjects?.()?.[0];
    this._openPieMenu({
      title: 'Hard-Surface & Boolean (Ctrl+Shift+B)',
      clientX,
      clientY,
      items: [
        { hotkey: '1', label: 'BoolTool: Difference (Ctrl+-)', action: () => this.applyQuickBoolean('difference') },
        { hotkey: '2', label: 'BoolTool: Union (Ctrl++)', action: () => this.applyQuickBoolean('union') },
        { hotkey: '3', label: 'BoolTool: Intersect (Ctrl+*)', action: () => this.applyQuickBoolean('intersect') },
        { hotkey: '4', label: 'Spawn Live Box Cutter', action: () => this.spawnLiveBooleanCutter({ operation: 'difference', primitive: 'box' }) },
        { hotkey: '5', label: 'Hard-Surface Polish (Bevel + Weighted Normal)', action: () => this.applyHardSurfacePolish() },
        {
          hotkey: '6',
          label: 'Bake Modifier Stack',
          action: () => {
            if (active?.isMesh && ModifierStack.getStack(active).length > 0) {
              ModifierStack.bakeModifiers(active, undefined, { sceneManager: this.sceneManager }).then(() => {
                this.app?.inspector?.render?.();
                this.engine?.updateSelectionHelper?.();
                this.sceneManager?.requestRender?.();
              }).catch(() => {});
            }
          }
        }
      ]
    });
  }

  async applyQuickBoolean(operation = 'difference', { displayMode = 'wire' } = {}) {
    if (!this.sceneManager) return null;
    const selected = (this.sceneManager.getSelectedObjects?.() || [])
      .filter((o) => o && o.isMesh && !o.userData?.isSystemObject);
    if (selected.length === 0) return null;

    if (selected.length === 1) {
      const cutter = await this.spawnLiveBooleanCutter({
        host: selected[0],
        operation,
        displayMode
      });
      return cutter ? { host: selected[0], cutters: [cutter] } : null;
    }

    const rawActive = this.sceneManager.getActiveObject?.() || this.sceneManager.activeObject;
    const host = (rawActive && selected.includes(rawActive)) ? rawActive : selected[selected.length - 1];
    const cutters = selected.filter((o) => o !== host);
    if (!host || cutters.length === 0) return null;

    for (const cutter of cutters) {
      await ModifierStack.addModifier(
        host,
        'boolean',
        {
          operation,
          operandType: 'object',
          targetId: cutter.userData?.id || cutter.uuid,
          targetName: cutter.name || '',
          cutterDisplay: displayMode
        },
        { sceneManager: this.sceneManager, description: `BoolTool ${operation}` }
      );
      setCutterDisplayMode(cutter, displayMode);
    }

    syncBooleanCuttersInScene(this.sceneManager);
    this.app?.inspector?.render?.();
    this.app?.outliner?.render?.();
    this.engine?.updateSelectionHelper?.();
    this.sceneManager.requestRender?.();
    return { host, cutters };
  }

  async spawnLiveBooleanCutter({ host = null, operation = 'difference', primitive = 'box', displayMode = 'wire' } = {}) {
    if (!this.sceneManager) return null;
    const targetHost = host || this.sceneManager.getActiveObject?.() || this.sceneManager.getSelectedObjects?.()?.[0];
    if (!targetHost?.isMesh) return null;

    let geom;
    if (primitive === 'cylinder') {
      geom = new THREE.CylinderGeometry(0.55, 0.55, 1.3, 24);
    } else if (primitive === 'sphere') {
      geom = new THREE.SphereGeometry(0.65, 24, 16);
    } else {
      geom = new THREE.BoxGeometry(1.1, 1.1, 1.1);
    }

    const mat = new THREE.MeshStandardMaterial({ color: 0xff9f43, roughness: 0.45, metalness: 0.1 });
    const cutter = new THREE.Mesh(geom, mat);
    cutter.name = `${targetHost.name || 'Mesh'}_Cutter`;
    cutter.position.set(
      targetHost.position.x + 0.55,
      targetHost.position.y + 0.45,
      targetHost.position.z + 0.55
    );
    cutter.updateMatrixWorld(true);

    this.sceneManager.addObject(cutter, null, true, true);

    await ModifierStack.addModifier(
      targetHost,
      'boolean',
      {
        operation,
        operandType: 'object',
        targetId: cutter.userData?.id || cutter.uuid,
        targetName: cutter.name,
        cutterDisplay: displayMode
      },
      { sceneManager: this.sceneManager, description: `Add live ${operation} cutter` }
    );

    setCutterDisplayMode(cutter, displayMode);
    syncBooleanCuttersInScene(this.sceneManager);
    this.app?.inspector?.render?.();
    this.app?.outliner?.render?.();
    this.engine?.updateSelectionHelper?.();
    this.sceneManager.requestRender?.();
    return cutter;
  }

  async applyHardSurfacePolish(targetMesh = null, options = {}) {
    const mesh = targetMesh || this.sceneManager?.getActiveObject?.() || this.sceneManager?.getSelectedObjects?.()?.[0];
    if (!mesh?.isMesh) return null;

    const stack = ModifierStack.getStack(mesh);
    const hasBevel = stack.some((m) => String(m.type || '').toLowerCase() === 'bevel' && m.enabled !== false);
    if (!hasBevel) {
      await ModifierStack.addModifier(
        mesh,
        'bevel',
        {
          width: options.bevelWidth ?? 0.04,
          segments: options.bevelSegments ?? 2,
          limitMethod: 'angle',
          angleLimitDeg: options.angleLimitDeg ?? 30,
          clampOverlap: true
        },
        { sceneManager: this.sceneManager, description: 'Add Bevel (Hard-Surface Polish)' }
      );
    }

    const updated = ModifierStack.getStack(mesh);
    const hasWN = updated.some((m) => {
      const t = String(m.type || '').toLowerCase();
      return (t === 'weighted_normal' || t === 'weightednormal') && m.enabled !== false;
    });
    if (!hasWN) {
      await ModifierStack.addModifier(
        mesh,
        'weighted_normal',
        {
          mode: options.weightedMode ?? 'face_area_and_angle',
          weight: options.weight ?? 50,
          keepSharp: options.keepSharp !== false,
          thresholdDeg: options.thresholdDeg ?? 35
        },
        { sceneManager: this.sceneManager, description: 'Add Weighted Normal (Hard-Surface Polish)' }
      );
    }

    this.app?.inspector?.render?.();
    this.engine?.updateSelectionHelper?.();
    this.sceneManager?.requestRender?.();
    return mesh;
  }

  // =========================================================================
  // 8. SEARCHABLE BLENDER PRO SHORTCUTS REFERENCE MODAL
  // =========================================================================

  openShortcutsHelp() {
    if (!this._shortcutsModal) {
      this._shortcutsModal = this._buildShortcutsModal();
      document.body.appendChild(this._shortcutsModal);
    }
    this._shortcutsModal.removeAttribute('hidden');
    const search = this._shortcutsModal.querySelector('#b-shortcuts-search');
    if (search) {
      search.value = '';
      this._filterShortcutsList('');
      setTimeout(() => search.focus(), 30);
    }
  }

  closeShortcutsHelp() {
    this._shortcutsModal?.setAttribute('hidden', '');
  }

  _buildShortcutsModal() {
    const backdrop = document.createElement('div');
    backdrop.id = 'shortcuts-help-dialog';
    backdrop.className = 'ss-backdrop blender-shortcuts-backdrop';
    backdrop.setAttribute('hidden', '');
    backdrop.addEventListener('pointerdown', (e) => {
      if (e.target === backdrop) this.closeShortcutsHelp();
    });

    const categories = [
      {
        title: 'Workspaces & Areas (Multi-Screen)',
        items: [
          ['Drag 4 Area Corners', 'Split or Join 2+ editor areas just like Blender'],
          ['Ctrl + Alt + Q', 'Toggle Quad View (Top, Persp, Front, Right)'],
          ['Alt + Space / Ctrl + \\', 'Toggle Second Screen (Hide Bottom Dock)'],
          ['Ctrl + Alt + Space', 'Pure Fullscreen Viewport (Hide bottom, left & right panels)'],
          ['N / T', 'Toggle Right N-Panel / Left Toolbar'],
          ['` (Backquote)', 'View Pie Menu (Front, Top, Right, Camera...)'],
          ['/ (Slash)', 'Local View (Isolate selection / Exit Local View)'],
          ['Numpad 5 / Numpad .', 'Perspective ↔ Orthographic / Frame Selected'],
          ['Z / Alt + Z', 'Toggle Viewport Shading / X-Ray mode']
        ]
      },
      {
        title: 'Viewport Navigation (Blender Pro Keymap)',
        items: [
          ['MMB / Alt + LMB', 'Orbit Camera (Alt+LMB for Mac Trackpad)'],
          ['Shift + MMB / Alt+Shift+LMB', 'Pan Viewport'],
          ['Ctrl + MMB / Wheel', 'Zoom Viewport'],
          ['LMB Drag / B / C', 'Box Select / Border Select / Circle Select'],
          ['RMB', 'Open Context Menu (Object / Mesh)']
        ]
      },
      {
        title: 'Transform, Pivot & Snap (Object & Edit)',
        items: [
          ['G / R / S', 'Grab (Move) / Rotate / Scale'],
          ['X / Y / Z / Shift+Axis', 'Lock Single Axis (Global→Local) / Lock Plane'],
          ['Shift + S', 'Snap Pie Menu (Selection ↔ Cursor / Grid / Origin)'],
          ['Shift + Tab', 'Toggle Continuous Snapping (Hold Ctrl to invert temporarily)'],
          ['. (Period - Pro mode)', 'Pivot Point Pie Menu (Median, 3D Cursor, Active)'],
          ['Ctrl+G / Ctrl+Z / Ctrl+Shift+Z', 'Group Objects / Undo / Redo']
        ]
      },
      {
        title: 'Object Mode',
        items: [
          ['Tab / F3 / Ctrl+Space', 'Toggle Edit Mode / Open AI Copilot'],
          ['Shift+D / Alt+D', 'Duplicate / Duplicate Linked (Shared Geometry)'],
          ['Alt+G / Alt+R / Alt+S', 'Clear Location / Rotation / Scale'],
          ['Ctrl+A / Ctrl+J', 'Apply Transform Menu / Join Meshes'],
          ['Ctrl+P / Alt+P', 'Set Parent (Keep Transform) / Clear Parent'],
          ['H / Alt+H / Shift+F12', 'Hide Selected / Unhide All / Render PNG'],
          ['Ctrl+- / Ctrl++ / Ctrl+*', 'Quick Boolean: Difference / Union / Intersect'],
          ['Ctrl+Shift+B', 'Hard-Surface & Boolean Quick Menu']
        ]
      },
      {
        title: 'Edit Mode (Blender Modeling & UV)',
        items: [
          ['1 / 2 / 3', 'Vertex / Edge / Face Selection Mode'],
          ['E', 'Extrude Vertex / Edge / Face (Interactive Modal)'],
          ['G G (Double-tap G)', 'Edge / Vertex Slide along adjacent edges (C to Clamp)'],
          ['F / J', 'Make Edge / Face / Connect Vertex Path'],
          ['K (Enter / Esc)', 'Interactive Knife Cut'],
          ['I / Ctrl+B / Ctrl+R', 'Inset Faces / Bevel / Loop Cut'],
          ['U / Ctrl+E', 'UV Mapping Menu (LSCM/Smart/Pack/Seam) / Edge Menu'],
          ['Ctrl+X / P / Alt+P', 'Dissolve Selection / Separate / Poke Faces'],
          ['Alt+Click / Ctrl+Alt+Click', 'Select Edge Loop / Select Edge Ring'],
          ['Ctrl+Numpad+ / Ctrl+Numpad-', 'Select More / Select Less'],
          ['M / Ctrl+L / Shift+N', 'Merge Center / Select Linked / Recalculate Normals'],
          ['X / Delete', 'Blender Delete Menu (X) / Quick Delete']
        ]
      },
      {
        title: 'UV Editor',
        items: [
          ['1 / 2 / 3 / 4', 'UV Vertex / Edge / Face / Island Select Mode'],
          ['G / R / S (+ X / Y)', 'Modal Move / Rotate / Scale UVs (with axis lock & digits)'],
          ['P / Alt + P', 'Pin / Unpin Selected UV Vertices'],
          ['L / B / A / Alt+A', 'Select Island / Box Select / Select All / Deselect All'],
          ['Wheel / MMB / Alt+Drag', 'Zoom to Cursor / Pan UV Canvas']
        ]
      },
      {
        title: 'Sculpt Mode 2.0 (Rust WASM & BVH)',
        items: [
          ['X / 1, G / 2, I / 3, S / 4', 'Draw / Grab / Inflate / Smooth Brushes'],
          ['5 / Shift+T, C / 6, P / 7', 'Flatten / Clay Strips / Pinch Brushes'],
          ['Shift+C / 8, K / 9, M / 0', 'Crease / Snake Hook / Mask Brushes'],
          ['Shift (Hold) / Ctrl (Hold)', 'Temporary Smooth / Invert Brush Direction'],
          ['Ctrl+I / Alt+M / Ctrl+R', 'Invert Mask / Clear Mask / Voxel Remesh']
        ]
      }
    ];

    backdrop.innerHTML = `
      <div class="blender-shortcuts-modal" role="dialog" aria-label="Blender Pro Keyboard Shortcuts">
        <div class="b-shortcuts-header">
          <div>
            <h3>Blender Pro Keyboard Shortcuts</h3>
            <div style="font-size:11px; color:var(--b-text-secondary);">Blender Pro Keymap, Corner-Split Workspaces, Mesh Modeling &amp; UV Editor</div>
          </div>
          <button type="button" class="popover-close-btn" id="b-shortcuts-close">✕</button>
        </div>
        <div class="b-shortcuts-search-row">
          <input type="text" id="b-shortcuts-search" placeholder="Search shortcuts or commands (e.g. extrude, unwrap, seam, slide, knife, dock)...">
        </div>
        <div class="b-shortcuts-grid">
          ${categories.map(cat => `
            <div class="b-shortcuts-cat">
              <div class="b-shortcuts-cat-title">${cat.title}</div>
              ${cat.items.map(([k, desc]) => `
                <div class="b-shortcuts-row" data-search="${(k + ' ' + desc).toLowerCase()}">
                  <kbd>${k}</kbd>
                  <span>${desc}</span>
                </div>
              `).join('')}
            </div>
          `).join('')}
        </div>
      </div>
    `;

    backdrop.querySelector('#b-shortcuts-close').addEventListener('click', () => this.closeShortcutsHelp());
    backdrop.querySelector('#b-shortcuts-search').addEventListener('input', (e) => {
      this._filterShortcutsList(e.target.value);
    });
    return backdrop;
  }

  _filterShortcutsList(query) {
    if (!this._shortcutsModal) return;
    const q = String(query || '').trim().toLowerCase();
    const cats = this._shortcutsModal.querySelectorAll('.b-shortcuts-cat');
    cats.forEach(cat => {
      let visibleCount = 0;
      cat.querySelectorAll('.b-shortcuts-row').forEach(row => {
        const match = !q || (row.dataset.search || '').includes(q);
        row.style.display = match ? 'flex' : 'none';
        if (match) visibleCount++;
      });
      cat.style.display = visibleCount > 0 ? 'flex' : 'none';
    });
  }
}

export default BlenderProTools;
