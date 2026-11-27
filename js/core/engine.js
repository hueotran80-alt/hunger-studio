/**
 * @file engine.js
 * @description Core 3D WebGL rendering engine for Web Blender Studio using Three.js.
 * Provides Scene setup, PBR/ToneMapped Renderer, OrbitControls with Damping,
 * TransformControls (Gizmos: G/R/S), Selection Raycaster, Studio Lighting,
 * Blender-style Floor Grid, and Viewport Navigation Gizmo.
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { ViewHelper } from 'three/addons/helpers/ViewHelper.js';
import { TransformCommand, MultiTransformCommand, RemoveObjectsCommand } from './scene-manager.js';
import { dataBlockRegistry } from './data-blocks.js';
import { PoseChangeCommand, EditArmatureCommand } from '../animation/rig-system.js';
import { isInteractiveTarget, shouldBlockViewportShortcut } from './interaction-guard.js';
import { RasterRenderer } from '../render/raster-renderer.js';
import { resolveEditableMesh, resolveRigTarget, syncViewportModeOptions } from './mode-resolver.js';
import { initMeshKernel } from './mesh-kernel-bridge.js';
import { LODManager } from './lod-manager.js';
import { ViewportGovernor } from './viewport-governor.js';
import { InstancingSystem } from './instancing-system.js';
import { installBVHRaycast } from './bvh-accelerator.js';
installBVHRaycast();

export class Engine {
  /**
   * @param {Object} [options]
   * @param {HTMLElement} [options.container] DOM container element
   * @param {number} [options.clearColor=0x282828] Background color (Blender default dark gray)
   * @param {number} [options.fov=50] Field of view
   * @param {number} [options.near=0.1]
   * @param {number} [options.far=2000]
   */
  constructor(options = {}) {
    this.options = {
      container: options.container || document.body,
      clearColor: options.clearColor !== undefined ? options.clearColor : 0x282828,
      fov: options.fov || 50,
      near: options.near || 0.1,
      far: options.far || 2000,
      ...options
    };

    this.container = this.options.container;
    this.domElement = null;

    // Core Three.js instances
    this.scene = null;
    this.camera = null;
    this.renderer = null;
    this.clock = new THREE.Clock();

    // Controls
    this.controls = null;
    this.transformControls = null;
    this.viewHelper = null;
    this._viewHelperOrthoCam = new THREE.OrthographicCamera(-2, 2, 2, -2, 0, 4);
    this._viewHelperOrthoCam.position.set(0, 0, 2);
    this._viewHelperOrthoCam.updateMatrixWorld();

    // Multi-area workspace support
    this.areaManager = null;
    this.activeViewportPane = null;

    // Helpers
    this.grid = null;
    this.selectionBox = null;
    this.selectionHelperGroup = null;

    // Lighting group
    this.lights = {
      ambient: null,
      keyLight: null,
      fillLight: null,
      rimLight: null,
      group: null
    };

    // Raycaster & Picking
    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2();
    this.pointerDownPos = new THREE.Vector2();
    this.lastPointerClient = null;
    this.isPointerDown = false;
    this.maxClickDelta = 5; // Pixels threshold for click vs drag

    // State & Transform tracking for Undo/Redo
    this.sceneManager = null;
    this.editMode = null;
    this.activeTransformObject = null;
    this.preTransformState = null;
    this.isTransforming = false;
    this._tcDragPane = null;
    this._pointerDownOnGizmo = false;
    this.currentTransformMode = 'translate'; // 'translate' | 'rotate' | 'scale'
    this.currentTransformSpace = 'world'; // 'world' | 'local'
    this.snapEnabled = false;
    this.snapTranslation = 0.5;
    this.snapRotation = THREE.MathUtils.degToRad(15);
    this.snapScale = 0.1;

    // Animation / Render loop (smart on-demand + capped 60 FPS active budget)
    this.isRunning = false;
    this.maxFPS = Number.isFinite(options.maxFPS) ? Math.max(0, options.maxFPS) : 60;
    this._lastRenderTime = 0;
    this.animationFrameId = null;
    this.renderCallbacks = new Set();
    this._renderCallbackMeta = new Map();
    this._afterRenderCallbacks = new Set();
    this._needsRender = true;
    this._dampingGrace = 0;
    this._controlMotionState = new WeakMap();
    this._boundTick = this._tick.bind(this);
    this._boundOnVisibilityChange = () => {
      if (typeof document !== 'undefined' && !document.hidden && this.isRunning) {
        this._lastRenderTime = 0;
        this.requestRender();
      }
    };

    // Event listeners references for cleanup
    this._boundOnPointerDown = this._onPointerDown.bind(this);
    this._boundOnPointerUp = this._onPointerUp.bind(this);
    this._boundOnPointerMove = this._onPointerMove.bind(this);
    this._boundOnKeyDown = this._onKeyDown.bind(this);
    this._boundOnResize = this.onResize.bind(this);
    this._boundOnWindowBlur = this._onWindowBlur.bind(this);
    this.resizeObserver = null;

    // Initialize engine
    this.init();
  }

  /**
   * Initializes Scene, Camera, Renderer, Controls, Lighting, and Gizmos
   */
  init() {
    this._initScene();
    this._initCamera();
    this._initRenderer();
    this._initControls();
    this._initTransformControls();
    this._initLighting();
    this._initGrid();
    this._initSelectionHelper();
    this._initViewHelper();
    this._initEventListeners();

    // Rust WASM Auto-LOD, Fast Orbit Governor & GPU Instancing / Foliage Scatter
    this.lodManager = new LODManager({ engine: this });
    this.viewportGovernor = new ViewportGovernor({ engine: this });
    this.viewportGovernor.attach();
    this.instancingSystem = new InstancingSystem({ engine: this, lodManager: this.lodManager });
    initMeshKernel().catch(() => {});

    this.start();
  }

  // ==========================================
  // INITIALIZATION HELPERS
  // ==========================================

  _initScene() {
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(this.options.clearColor);
  }

  _initCamera() {
    const width = this.container.clientWidth || window.innerWidth;
    const height = this.container.clientHeight || window.innerHeight;
    const aspect = width / height;

    this.camera = new THREE.PerspectiveCamera(this.options.fov, aspect, this.options.near, this.options.far);
    // Blender-like default isometric-style perspective angle
    this.camera.position.set(7, 5, 8);
    this.camera.lookAt(0, 0, 0);
    this.perspectiveCamera = this.camera;
    const orthoNear = -Math.max(200, (this.options.far || 2000) * 0.5);
    this.orthographicCamera = new THREE.OrthographicCamera(-aspect, aspect, 1, -1, orthoNear, this.options.far);
  }

  _exitActivePaneCameraView() {
    const isSingle = !this.areaManager || this.areaManager.isSingleFullViewport();
    if (isSingle || this.activeViewportPane?.isPrimary) {
      window.cameraManager?.exitCameraView();
    } else if (this.activeViewportPane) {
      this.activeViewportPane.sceneCameraObj = null;
    }
  }

  toggleProjection(options = {}) {
    const force = Boolean(options && options.force);
    if (this.transformControls.dragging || this.isTransforming) return this.camera;
    if (typeof window !== 'undefined' && window.modalTransformManager?.isActive) return this.camera;
    const isSingle = !this.areaManager || this.areaManager.isSingleFullViewport();
    this._exitActivePaneCameraView();
    if (!force && isSingle && this.controls && !this.controls.enabled) return this.camera;
    const source = this.camera;
    const target = this.controls.target;
    const perspective = this.perspectiveCamera;
    const orthographic = this.orthographicCamera;
    const paneAspect = isSingle
      ? (this.container?.clientWidth && this.container?.clientHeight
          ? this.container.clientWidth / this.container.clientHeight
          : (perspective.aspect || 1))
      : (() => {
          const paneRect = this.getViewportRect(this.activeViewportPane);
          return Math.max(0.1, (paneRect.width || 1) / Math.max(1, paneRect.height || 1));
        })();
    perspective.aspect = paneAspect;
    const tangent = Math.tan(THREE.MathUtils.degToRad(perspective.getEffectiveFOV()) / 2);
    const distance = source.position.distanceTo(target);
    const next = source.isPerspectiveCamera ? orthographic : perspective;
    next.position.copy(source.position);
    next.quaternion.copy(source.quaternion);
    next.up.copy(source.up);
    if (next.isOrthographicCamera) {
      next.near = -Math.max(200, (this.options.far || 2000) * 0.5);
      next.far = Math.max(source.far || 2000, this.options.far || 2000);
    } else {
      next.near = Math.max(0.01, this.options.near || 0.1);
      next.far = Math.max(source.far || 2000, this.options.far || 2000);
    }
    next.layers.mask = source.layers.mask;

    if (next.isOrthographicCamera) {
      const halfHeight = distance * tangent;
      next.top = halfHeight;
      next.bottom = -halfHeight;
      next.left = -halfHeight * paneAspect;
      next.right = halfHeight * paneAspect;
      next.zoom = 1;
    } else {
      const nextDistance = (orthographic.top - orthographic.bottom) / (2 * orthographic.zoom * tangent);
      const direction = source.position.clone().sub(target).normalize();
      next.position.copy(target).addScaledVector(direction, nextDistance);
    }
    next.updateProjectionMatrix();
    next.updateMatrixWorld(true);
    this.camera = next;
    window.camera = next;
    if (this.controls) {
      this.controls.object = next;
      this.controls.update();
    }
    if (this.transformControls) {
      this.transformControls.camera = next;
    }
    this.viewHelper?.dispose();
    this._initViewHelper();
    if (this.activeViewportPane) {
      this.activeViewportPane.camera = next;
      this.activeViewportPane.viewHelper = this.viewHelper;
    }
    this.updateViewportCameraLabel();
    if (this.rasterRenderer) {
      this.rasterRenderer.updateCameraAndScene(this.camera, this.scene);
    }
    window.dispatchEvent(new CustomEvent('blender:viewportCameraChanged'));
    return next;
  }

  attachAreaManager(areaManager) {
    this.areaManager = areaManager || null;
    if (areaManager) {
      this.activeViewportPane = areaManager.getActivePane?.() || null;
    }
    this.viewportGovernor?.syncControls?.();
  }

  getPaneRenderCamera(pane = null) {
    if (!pane) return this.camera;
    if (pane.sceneCameraObj && typeof window !== 'undefined' && window.cameraManager?.getCameraEntry) {
      const camEntry = window.cameraManager.getCameraEntry(pane.sceneCameraObj);
      if (camEntry?.camera) return camEntry.camera;
    }
    return pane.camera || this.camera;
  }

  getPaneAtPoint(clientX, clientY) {
    if (!this.areaManager || this.areaManager.isSingleFullViewport()) {
      return this.activeViewportPane || null;
    }
    if (Number.isFinite(clientX) && Number.isFinite(clientY)) {
      const hit = this.areaManager.getPaneAtClientPoint?.(clientX, clientY);
      if (hit) return hit;
    }
    return this.activeViewportPane || this.areaManager.getActivePane?.() || null;
  }

  getViewportContextAtPoint(clientX = NaN, clientY = NaN, explicitPane = null) {
    const pane = explicitPane || this.getPaneAtPoint(clientX, clientY);
    const rect = this.getViewportRect(pane);
    const isSingle = !this.areaManager || this.areaManager.isSingleFullViewport();
    const camera = isSingle ? this.camera : this.getPaneRenderCamera(pane);
    if (camera && rect && rect.width > 0 && rect.height > 0) {
      this._syncCameraAspect(camera, Math.max(0.1, rect.width / Math.max(1, rect.height)));
      camera.updateMatrixWorld?.(true);
    }
    return {
      pane,
      rect,
      camera,
      controls: pane?.controls || this.controls,
    };
  }

  syncViewportPaneControls(targetPane = this.activeViewportPane) {
    const modalActive = typeof window !== 'undefined' && Boolean(window.modalTransformManager?.isActive);
    const sculptActive = typeof window !== 'undefined' && Boolean(window.sculptMode?.isBrushing || window.sculptMode?.isSculpting || window.paintMode?.isBrushing);
    const areaBusy = Boolean(this.areaManager?._dragState || this.areaManager?._splitterDrag);
    const tcDragging = Boolean(this.transformControls?.dragging || this.isTransforming);
    const globalBlock = tcDragging || modalActive || sculptActive || areaBusy;
    const lookingThroughGlobal = typeof window !== 'undefined' && Boolean(window.cameraManager?.lookingThrough);

    const isSingle = !this.areaManager || this.areaManager.isSingleFullViewport();
    const activePane = targetPane || this.activeViewportPane || this.areaManager?.getActivePane?.() || null;

    if (isSingle) {
      const lockedByCam = Boolean(activePane?.sceneCameraObj || lookingThroughGlobal);
      if (this.controls) {
        this.controls.enabled = !globalBlock && !lockedByCam;
      }
      if (this.areaManager?.panes) {
        for (const p of this.areaManager.panes.values()) {
          if (!p.controls) continue;
          const isTarget = activePane ? p === activePane : p.controls === this.controls;
          p.controls.enabled = isTarget && !globalBlock && !lockedByCam;
        }
      }
      return;
    }

    for (const p of this.areaManager.panes.values()) {
      if (!p.controls) continue;
      const lockedByCam = Boolean(p.sceneCameraObj || (p.isPrimary && lookingThroughGlobal));
      p.controls.enabled = Boolean(p === activePane && !globalBlock && !lockedByCam);
    }
  }

  setActiveViewportPane(pane) {
    if (!pane) return;
    this.activeViewportPane = pane;
    if (pane.camera) {
      this.camera = pane.camera;
      window.camera = pane.camera;
    }
    if (pane.perspectiveCamera) this.perspectiveCamera = pane.perspectiveCamera;
    if (pane.orthographicCamera) this.orthographicCamera = pane.orthographicCamera;
    if (pane.controls) this.controls = pane.controls;
    if (pane.viewHelper) this.viewHelper = pane.viewHelper;
    const renderCam = this.getPaneRenderCamera(pane);
    if (this.transformControls && renderCam) {
      this.transformControls.camera = renderCam;
      this.transformControls.updateMatrixWorld?.();
    }
    this.syncViewportPaneControls(pane);
    if (this.rasterRenderer && renderCam) {
      this.rasterRenderer.updateCameraAndScene(renderCam, this.scene);
    }
    this.updateViewportCameraLabel();
  }

  getAllViewportControls() {
    if (this.areaManager) {
      return this.areaManager.getAllViewportControls();
    }
    return this.controls ? [this.controls] : [];
  }

  getViewportRect(pane = null) {
    const fallback = this.domElement
      ? this.domElement.getBoundingClientRect()
      : { left: 0, top: 0, right: 1, bottom: 1, width: 1, height: 1 };
    if (!this.areaManager || this.areaManager.isSingleFullViewport()) {
      return fallback;
    }
    const targetPane = pane || this.activeViewportPane || this.areaManager.getActivePane();
    const el = targetPane?.viewportEl;
    if (el) {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) return r;
    }
    return fallback;
  }

  getViewportNDC(clientX, clientY, targetVec2 = null, pane = null) {
    const resolvedPane = pane ?? this.getPaneAtPoint(clientX, clientY);
    const rect = this.getViewportRect(resolvedPane);
    const w = rect.width || 1;
    const h = rect.height || 1;
    const x = ((clientX - rect.left) / w) * 2 - 1;
    const y = -((clientY - rect.top) / h) * 2 + 1;
    if (targetVec2) {
      targetVec2.set(x, y);
      return targetVec2;
    }
    return new THREE.Vector2(x, y);
  }

  updateViewportCameraLabel() {
    const label = document.getElementById('vp-camera-name');
    if (label) label.textContent = this.camera.isOrthographicCamera ? 'User Orthographic' : 'User Perspective';
  }

  _getViewportPixelRatio() {
    const dpr = (typeof window !== 'undefined' && Number(window.devicePixelRatio)) || 1;
    // Cap at 1.5x to cut Retina GPU fill load by ~44% while staying sharp at 60 FPS
    return Math.max(1, Math.min(dpr, 1.5));
  }

  markShadowDirty() {
    if (this.renderer?.shadowMap) {
      this.renderer.shadowMap.needsUpdate = true;
    }
  }

  /**
   * Fits the directional KeyLight position, shadow frustum, bias, and shadow-map resolution
   * tightly to the active scene's non-helper world bounds so buildings of any scale (1m to 150m+)
   * cast crisp, unclipped shadows without shadow acne.
   */
  fitShadowFrustumToScene(options = {}) {
    const keyLight = this.lights?.keyLight;
    if (!keyLight || !this.scene) return null;

    const elevationDeg = Number(options.elevation ?? 42);
    const azimuthDeg = Number(options.azimuth ?? 138);
    const padding = Math.max(1.02, Number(options.padding ?? 1.12));

    const bounds = new THREE.Box3();
    const root = this.sceneManager?.rootContainer || this.scene;
    root.updateMatrixWorld?.(true);
    root.traverse((obj) => {
      if (!obj || !obj.visible) return;
      if (
        obj.userData?.isSystemObject ||
        obj.userData?.isHelper ||
        obj.userData?.isGizmo ||
        obj.isTransformControls ||
        obj.name === 'Floor_Grid' ||
        obj.name === 'Procedural_Sky_Dome' ||
        obj.name === 'Studio_Cyclorama_Backdrop'
      ) {
        return;
      }
      if ((obj.isMesh || obj.isInstancedMesh) && obj.castShadow !== false) {
        bounds.expandByObject(obj);
      }
    });

    if (bounds.isEmpty()) {
      bounds.setFromCenterAndSize(new THREE.Vector3(0, 2, 0), new THREE.Vector3(16, 12, 16));
    }

    const center = bounds.getCenter(new THREE.Vector3());
    const size = bounds.getSize(new THREE.Vector3());
    const radius = Math.max(6, 0.5 * size.length() * padding);

    const elev = THREE.MathUtils.degToRad(THREE.MathUtils.clamp(elevationDeg, 5, 88));
    const azim = THREE.MathUtils.degToRad(azimuthDeg);
    const sunDir = new THREE.Vector3(
      Math.cos(elev) * Math.sin(azim),
      Math.sin(elev),
      Math.cos(elev) * Math.cos(azim)
    ).normalize();

    const dist = radius * 2.1;
    keyLight.position.copy(center).addScaledVector(sunDir, dist);
    keyLight.target.position.copy(center);
    if (!keyLight.target.parent) {
      this.scene.add(keyLight.target);
    }
    keyLight.target.updateMatrixWorld(true);
    keyLight.updateMatrixWorld(true);

    const maxGpuTex = this.renderer?.capabilities?.maxTextureSize || 4096;
    const desiredMapSize = Math.min(
      maxGpuTex,
      Math.max(1024, Number(options.shadowMapSize) || (radius > 18 ? 4096 : 2048))
    );
    if (keyLight.shadow.mapSize.width !== desiredMapSize || keyLight.shadow.mapSize.height !== desiredMapSize) {
      keyLight.shadow.mapSize.set(desiredMapSize, desiredMapSize);
      if (keyLight.shadow.map) {
        keyLight.shadow.map.dispose();
        keyLight.shadow.map = null;
      }
    }

    const cam = keyLight.shadow.camera;
    cam.left = -radius;
    cam.right = radius;
    cam.top = radius;
    cam.bottom = -radius;
    cam.near = Math.max(0.5, dist - radius * 1.65);
    cam.far = dist + radius * 1.65;
    cam.updateProjectionMatrix();

    const texelWorldSize = (2 * radius) / desiredMapSize;
    keyLight.shadow.bias = options.bias ?? -Math.min(0.0012, Math.max(0.00008, texelWorldSize * 0.006));
    keyLight.shadow.normalBias = options.normalBias ?? Math.max(0.015, texelWorldSize * 0.85);

    if (options.color !== undefined) keyLight.color.set(options.color);
    if (Number.isFinite(options.intensity)) keyLight.intensity = Number(options.intensity);
    if (this.lights.ambient && Number.isFinite(options.ambientIntensity)) {
      this.lights.ambient.intensity = Number(options.ambientIntensity);
    }
    if (this.lights.fillLight) {
      if (options.fillColor !== undefined) this.lights.fillLight.color.set(options.fillColor);
      if (Number.isFinite(options.fillIntensity)) this.lights.fillLight.intensity = Number(options.fillIntensity);
      this.lights.fillLight.position.copy(center).addScaledVector(new THREE.Vector3(-sunDir.x, 0.55, -sunDir.z).normalize(), dist * 0.8);
    }
    if (this.lights.rimLight && Number.isFinite(options.rimIntensity)) {
      this.lights.rimLight.intensity = Number(options.rimIntensity);
      this.lights.rimLight.position.copy(center).addScaledVector(new THREE.Vector3(-sunDir.x * 0.5, 0.7, -sunDir.z).normalize(), dist * 0.9);
    }

    this.markShadowDirty();
    this.requestRender();
    return {
      center: center.toArray(),
      radius: Number(radius.toFixed(2)),
      shadowMapSize: desiredMapSize,
      texelWorldSize: Number(texelWorldSize.toFixed(4)),
    };
  }

  /**
   * Switches viewport raster quality ('fast' | 'studio' | 'cinematic') and tunes GTAO / Bloom / Exposure.
   */
  setRenderQuality(preset = 'studio', options = {}) {
    const resolved = ['fast', 'studio', 'cinematic'].includes(String(preset).toLowerCase())
      ? String(preset).toLowerCase()
      : 'studio';
    if (this.rasterRenderer) {
      this.rasterRenderer.setPreset(resolved);
      if (this.rasterRenderer.postProcessing && (options.ao || options.bloom || options.dof)) {
        this.rasterRenderer.postProcessing.configurePasses({
          ao: options.ao,
          bloom: options.bloom,
          dof: options.dof,
        });
      }
    }
    if (this.renderer && Number.isFinite(options.exposure)) {
      this.renderer.toneMappingExposure = Number(options.exposure);
    }
    this.markShadowDirty();
    this.requestRender();
    return { preset: resolved, postProcessing: Boolean(this.rasterRenderer?.postProcessing?.enabled) };
  }

  setMaxFPS(fps = 60) {
    this.maxFPS = Number.isFinite(fps) ? Math.max(0, Number(fps)) : 60;
    return this.maxFPS;
  }

  _initRenderer() {
    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: true,
      preserveDrawingBuffer: false,
      powerPreference: 'high-performance'
    });

    const width = this.container.clientWidth || window.innerWidth;
    const height = this.container.clientHeight || window.innerHeight;
    const pixelRatio = this._getViewportPixelRatio();

    this.renderer.setSize(width, height);
    this.renderer.setPixelRatio(pixelRatio);

    // Shadow setup (on-demand shadow map updates — skips expensive shadow pass while orbiting)
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.shadowMap.autoUpdate = false;
    this.renderer.shadowMap.needsUpdate = true;

    // Tone mapping (ACESFilmic for realistic render quality)
    // Tone mapping: AgX (Blender 4.0+ modern standard for high dynamic range without color clipping)
    this.renderer.toneMapping = THREE.AgXToneMapping !== undefined ? THREE.AgXToneMapping : THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;

    // Canvas element
    this.domElement = this.renderer.domElement;
    this.domElement.style.outline = 'none';
    this.domElement.style.display = 'block';
    this.domElement.style.width = '100%';
    this.domElement.style.height = '100%';
    this.domElement.tabIndex = 1; // Allows receiving focus for hotkeys

    this.container.appendChild(this.domElement);

    // High-fidelity raster renderer pipeline
    try {
      this.rasterRenderer = new RasterRenderer({
        renderer: this.renderer,
        scene: this.scene,
        camera: this.camera,
        preset: 'fast',
      });
    } catch (err) {
      console.warn('[Engine] RasterRenderer fallback:', err);
      this.rasterRenderer = null;
    }
  }

  _initControls() {
    this.controls = new OrbitControls(this.camera, this.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.085;
    this.controls.screenSpacePanning = true;
    this.controls.minDistance = 0.5;
    this.controls.maxDistance = 1500;
    this.controls.target.set(0, 0, 0);
    this.controls.addEventListener('start', () => this.requestRender());
    this.controls.addEventListener('change', () => this.requestRender());
  }

  _initTransformControls() {
    this.transformControls = new TransformControls(this.camera, this.domElement);
    this.transformControls._getPointer = (event) => {
      if (this.domElement?.ownerDocument?.pointerLockElement) {
        return { x: 0, y: 0, button: event.button };
      }
      const ctx = this.getViewportContextAtPoint(event.clientX, event.clientY, this._tcDragPane || null);
      if (!this.transformControls.dragging && ctx.camera && this.transformControls.camera !== ctx.camera) {
        this.transformControls.camera = ctx.camera;
        this.transformControls.updateMatrixWorld?.();
      }
      const rect = ctx.rect;
      const w = rect.width || 1;
      const h = rect.height || 1;
      return {
        x: ((event.clientX - rect.left) / w) * 2 - 1,
        y: -((event.clientY - rect.top) / h) * 2 + 1,
        button: event.button
      };
    };
    this.transformControls.size = 0.85;
    this.transformControls.setSpace(this.currentTransformSpace);
    this.transformControls.setMode(this.currentTransformMode);

    // Disable OrbitControls while dragging gizmo (respecting Camera View / multi-pane lock)
    this.transformControls.addEventListener('dragging-changed', (event) => {
      this.isTransforming = event.value;
      if (event.value) {
        const pt = this.lastPointerClient;
        this._tcDragPane = pt ? this.getPaneAtPoint(pt.x, pt.y) : this.activeViewportPane;
        if (this.controls) this.controls.enabled = false;
      } else {
        this._tcDragPane = null;
        this.syncViewportPaneControls();
      }
    });

    // Record transform start for Undo/Redo (including multi-selected sibling root objects)
    this.transformControls.addEventListener('mouseDown', () => {
      const obj = this.transformControls.object;
      this._prePoseSnap = null;
      this._preEditArmatureSnap = null;
      this._preEditArmatureSkeleton = null;
      this._preMultiTransformEntries = null;
      if (obj) {
        this.preTransformState = {
          position: obj.position.clone(),
          quaternion: obj.quaternion.clone(),
          scale: obj.scale.clone()
        };
        obj.updateWorldMatrix(true, false);
        this._preActiveWorld = {
          pos: obj.getWorldPosition(new THREE.Vector3()),
          quat: obj.getWorldQuaternion(new THREE.Quaternion()),
          scale: obj.getWorldScale(new THREE.Vector3()),
          localScale: obj.scale.clone()
        };
        const rs = typeof window !== 'undefined' ? window.rigSystem : null;
        if (rs && (obj.isBone || obj.userData?.isIKHandle)) {
          const skel = rs.editSkeleton || rs.activeSkeleton || obj.userData?.skeleton;
          if (rs.isEditBoneMode && obj.isBone && skel) {
            this._preEditArmatureSnap = rs._snapshotArmature(skel);
            this._preEditArmatureSkeleton = skel;
          } else if (skel?.bones) {
            this._prePoseSnap = {
              skeleton: skel,
              quats: skel.bones.map(b => b.quaternion.clone()),
              positions: skel.bones.map(b => b.position.clone()),
            };
          }
        } else if (this.sceneManager?.getSelectedObjects && !obj.userData?.isSystemObject) {
          const raw = this.sceneManager.getSelectedObjects().filter((o) => o && !o.userData?.locked && !o.userData?.isSystemObject);
          if (raw.length > 1 && raw.includes(obj)) {
            const rawSet = new Set(raw);
            this._preMultiTransformEntries = raw
              .filter((o) => {
                let p = o.parent;
                while (p) { if (rawSet.has(p)) return false; p = p.parent; }
                return true;
              })
              .map((o) => {
                o.updateWorldMatrix(true, false);
                const parentInv = new THREE.Matrix4();
                const parentQuatInv = new THREE.Quaternion();
                if (o.parent) {
                  o.parent.updateWorldMatrix(true, false);
                  parentInv.copy(o.parent.matrixWorld).invert();
                  o.parent.getWorldQuaternion(parentQuatInv).invert();
                }
                return {
                  obj: o,
                  isPrimary: o === obj,
                  position: o.position.clone(),
                  quaternion: o.quaternion.clone(),
                  scale: o.scale.clone(),
                  worldPos: o.getWorldPosition(new THREE.Vector3()),
                  worldQuat: o.getWorldQuaternion(new THREE.Quaternion()),
                  parentInv,
                  parentQuatInv
                };
              });
          }
        }
      }
    });

    // Transform finished: push command to sceneManager if changed
    this.transformControls.addEventListener('mouseUp', () => {
      const obj = this.transformControls.object;
      const rs = typeof window !== 'undefined' ? window.rigSystem : null;
      if (this._preEditArmatureSnap && this._preEditArmatureSkeleton && rs && this.sceneManager) {
        const skel = this._preEditArmatureSkeleton;
        const moved = this._preEditArmatureSnap.entries.some(
          (e) => e.bone.position.distanceToSquared(e.position) > 1e-10 || Math.abs(1 - Math.abs(e.bone.quaternion.dot(e.quaternion))) > 1e-7
        );
        if (moved) {
          rs._refreshVisualizerAndInverses(skel);
          const afterSnap = rs._snapshotArmature(skel);
          const cmd = new EditArmatureCommand(rs, skel, this._preEditArmatureSnap, afterSnap, 'Move Edit Bone');
          this.sceneManager.executeCommand(cmd);
        }
        this._preEditArmatureSnap = null;
        this._preEditArmatureSkeleton = null;
        this._prePoseSnap = null;
        this.preTransformState = null;
        if (!this.editMode || !this.editMode.isActive) this.updateSelectionHelper();
        return;
      }

      if (this._prePoseSnap && rs && this.sceneManager) {
        const skel = this._prePoseSnap.skeleton;
        const afterQuats = skel.bones.map(b => b.quaternion.clone());
        const afterPositions = skel.bones.map(b => b.position.clone());
        let changed = false;
        for (let i = 0; i < skel.bones.length; i++) {
          if (Math.abs(1 - Math.abs(afterQuats[i].dot(this._prePoseSnap.quats[i]))) > 1e-7 ||
              afterPositions[i].distanceToSquared(this._prePoseSnap.positions[i]) > 1e-10) {
            changed = true;
            break;
          }
        }
        if (changed) {
          const cmd = new PoseChangeCommand(
            skel,
            this._prePoseSnap.quats,
            afterQuats,
            this._prePoseSnap.positions,
            afterPositions,
            () => rs.updateSkeletonHelper(),
            obj?.userData?.isIKHandle ? 'IK Pose' : 'Bone Pose'
          );
          this.sceneManager.executeCommand(cmd);
        }
        this._prePoseSnap = null;
        this.preTransformState = null;
        if (!this.editMode || !this.editMode.isActive) this.updateSelectionHelper();
        return;
      }

      if (obj && !obj.userData?.isSystemObject && this.preTransformState && this.sceneManager) {
        if (Array.isArray(this._preMultiTransformEntries) && this._preMultiTransformEntries.length > 1) {
          const changed = [];
          for (const entry of this._preMultiTransformEntries) {
            const o = entry.obj;
            const post = { position: o.position.clone(), quaternion: o.quaternion.clone(), scale: o.scale.clone() };
            if (!entry.position.equals(post.position) || !entry.quaternion.equals(post.quaternion) || !entry.scale.equals(post.scale)) {
              changed.push({
                object: o,
                oldState: { position: entry.position.clone(), quaternion: entry.quaternion.clone(), scale: entry.scale.clone() },
                newState: post
              });
            }
          }
          if (changed.length > 0) {
            const cmd = changed.length === 1
              ? new TransformCommand(changed[0].object, changed[0].oldState, changed[0].newState, () => this.updateSelectionHelper())
              : new MultiTransformCommand(changed, () => this.updateSelectionHelper());
            this.sceneManager.executeCommand(cmd);
          }
        } else {
          const postState = {
            position: obj.position.clone(),
            quaternion: obj.quaternion.clone(),
            scale: obj.scale.clone()
          };

          const posChanged = !this.preTransformState.position.equals(postState.position);
          const rotChanged = !this.preTransformState.quaternion.equals(postState.quaternion);
          const scaleChanged = !this.preTransformState.scale.equals(postState.scale);

          if (posChanged || rotChanged || scaleChanged) {
            const cmd = new TransformCommand(
              obj,
              this.preTransformState,
              postState,
              () => this.updateSelectionHelper()
            );
            this.sceneManager.executeCommand(cmd);
          }
        }
      }
      this._preMultiTransformEntries = null;
      this._preActiveWorld = null;
      this.preTransformState = null;
      this.markShadowDirty();
      if (!this.editMode || !this.editMode.isActive) {
        this.updateSelectionHelper();
      }
    });

    this.transformControls.addEventListener('change', () => this.requestRender());

    this.transformControls.addEventListener('objectChange', () => {
      if ((this.sceneManager?.objects?.size || 0) <= 30) {
        this.markShadowDirty();
      }
      const obj = this.transformControls.object;
      if (obj && Array.isArray(this._preMultiTransformEntries) && this._preActiveWorld && this._preMultiTransformEntries.length > 1) {
        obj.updateWorldMatrix(true, false);
        const curWorldPos = obj.getWorldPosition(new THREE.Vector3());
        const curWorldQuat = obj.getWorldQuaternion(new THREE.Quaternion());
        const worldDeltaPos = curWorldPos.clone().sub(this._preActiveWorld.pos);
        const worldDeltaQuat = curWorldQuat.clone().multiply(this._preActiveWorld.quat.clone().invert());
        const scaleRatio = new THREE.Vector3(
          Math.abs(this._preActiveWorld.localScale.x) > 1e-6 ? obj.scale.x / this._preActiveWorld.localScale.x : 1,
          Math.abs(this._preActiveWorld.localScale.y) > 1e-6 ? obj.scale.y / this._preActiveWorld.localScale.y : 1,
          Math.abs(this._preActiveWorld.localScale.z) > 1e-6 ? obj.scale.z / this._preActiveWorld.localScale.z : 1
        );
        const pivot = this._preActiveWorld.pos;
        for (const entry of this._preMultiTransformEntries) {
          if (entry.isPrimary || entry.obj === obj) continue;
          const offset = entry.worldPos.clone().sub(pivot);
          offset.multiply(scaleRatio).applyQuaternion(worldDeltaQuat);
          const nextWorldPos = pivot.clone().add(offset).add(worldDeltaPos);
          if (entry.obj.parent) nextWorldPos.applyMatrix4(entry.parentInv);
          entry.obj.position.copy(nextWorldPos);
          const nextWorldQuat = worldDeltaQuat.clone().multiply(entry.worldQuat);
          if (entry.obj.parent) entry.obj.quaternion.copy(entry.parentQuatInv).multiply(nextWorldQuat);
          else entry.obj.quaternion.copy(nextWorldQuat);
          entry.obj.scale.set(
            entry.scale.x * scaleRatio.x,
            entry.scale.y * scaleRatio.y,
            entry.scale.z * scaleRatio.z
          );
          entry.obj.updateMatrixWorld(true);
        }
      }
      this.requestRender();
      this.updateSelectionHelper();
      if (obj && typeof window !== 'undefined' && window.rigSystem) {
        if (obj.userData?.isIKHandle) {
          window.rigSystem.onIKHandleMoved(obj);
        } else if (obj.isBone) {
          if (window.rigSystem.isEditBoneMode) {
            window.rigSystem.onEditBoneMoved(obj);
          } else {
            window.rigSystem.onBoneRotated(obj);
          }
        }
      }
      if (obj && !obj.userData?.isSystemObject && typeof window !== 'undefined' && typeof CustomEvent !== 'undefined') {
        const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
        if (now - (this._lastTransformEventTime || 0) >= 50) {
          this._lastTransformEventTime = now;
          window.dispatchEvent(new CustomEvent('blender:objectTransformed', {
            detail: { object: obj, source: 'gizmo', phase: 'interactive' }
          }));
        }
      }
    });

    // Internal gizmo object and all its internal helper/picker/plane meshes
    // shouldn't be picked, saved, or mutated by MatCap/wireframe/asset drops.
    this.transformControls.traverse((node) => {
      node.userData.isSystemObject = true;
      node.userData.selectable = false;
    });
    this.scene.add(this.transformControls);
  }

  _initLighting() {
    const lightGroup = new THREE.Group();
    lightGroup.name = 'Studio_Lighting';
    lightGroup.userData.isSystemObject = true;

    // 1. Ambient Light (Soft base fill)
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.45);
    ambientLight.name = 'AmbientLight';
    lightGroup.add(ambientLight);

    // 2. Key Light (Main directional light with soft shadows)
    const keyLight = new THREE.DirectionalLight(0xfff8ee, 1.8);
    keyLight.name = 'KeyLight';
    keyLight.position.set(8, 12, 8);
    keyLight.castShadow = true;
    keyLight.shadow.mapSize.width = 2048;
    keyLight.shadow.mapSize.height = 2048;
    keyLight.shadow.camera.near = 0.5;
    keyLight.shadow.camera.far = 50;
    keyLight.shadow.camera.left = -12;
    keyLight.shadow.camera.right = 12;
    keyLight.shadow.camera.top = 12;
    keyLight.shadow.camera.bottom = -12;
    keyLight.shadow.bias = -0.0001;
    keyLight.shadow.normalBias = 0.02;
    lightGroup.add(keyLight);

    // 3. Fill Light (Cooler softer side light)
    const fillLight = new THREE.DirectionalLight(0xd6e8ff, 0.85);
    fillLight.name = 'FillLight';
    fillLight.position.set(-8, 6, -6);
    fillLight.castShadow = false;
    lightGroup.add(fillLight);

    // 4. Rim / Back Light (Accentuates silhouettes)
    const rimLight = new THREE.DirectionalLight(0xffffff, 1.2);
    rimLight.name = 'RimLight';
    rimLight.position.set(0, 8, -10);
    rimLight.castShadow = false;
    lightGroup.add(rimLight);

    this.scene.add(lightGroup);

    this.lights = {
      ambient: ambientLight,
      keyLight,
      fillLight,
      rimLight,
      group: lightGroup
    };
  }

  _initGrid() {
    const gridGroup = new THREE.Group();
    gridGroup.name = 'Floor_Grid';
    gridGroup.userData.isSystemObject = true;
    gridGroup.userData.selectable = false;

    const size = 50;
    const divisions = 50;
    const colorCenterLine = 0x4f4f4f;
    const colorGrid = 0x383838;

    // Main floor grid
    const gridHelper = new THREE.GridHelper(size, divisions, colorCenterLine, colorGrid);
    gridHelper.position.y = -0.001; // Avoid z-fighting with flat ground objects
    gridHelper.userData.selectable = false;
    gridHelper.userData.isSystemObject = true;
    gridGroup.add(gridHelper);

    // Blender-style colored principal axes on ground plane
    // X-Axis (Red: +X and -X)
    const xGeometry = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(-size / 2, 0, 0),
      new THREE.Vector3(size / 2, 0, 0)
    ]);
    const xMaterial = new THREE.LineBasicMaterial({ color: 0xcc3333, depthWrite: false });
    const xAxisLine = new THREE.Line(xGeometry, xMaterial);
    xAxisLine.userData.selectable = false;
    gridGroup.add(xAxisLine);

    // Z-Axis (Green in Blender floor grid)
    const zGeometry = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(0, 0, -size / 2),
      new THREE.Vector3(0, 0, size / 2)
    ]);
    const zMaterial = new THREE.LineBasicMaterial({ color: 0x33aa33, depthWrite: false });
    const zAxisLine = new THREE.Line(zGeometry, zMaterial);
    zAxisLine.userData.selectable = false;
    gridGroup.add(zAxisLine);

    gridGroup.traverse((node) => {
      node.userData.isSystemObject = true;
      node.userData.selectable = false;
    });

    this.scene.add(gridGroup);
    this.grid = gridGroup;
  }

  _initSelectionHelper() {
    this.selectionHelperGroup = new THREE.Group();
    this.selectionHelperGroup.name = 'Selection_Helpers';

    // Blender active selection orange color: #e58c2c (O(1) Box3Helper, zero per-vertex scans)
    this._selectionBoxBounds = new THREE.Box3(
      new THREE.Vector3(-0.5, -0.5, -0.5),
      new THREE.Vector3(0.5, 0.5, 0.5)
    );
    this.selectionBox = new THREE.Box3Helper(this._selectionBoxBounds, 0xe58c2c);
    this.selectionBox.material.depthTest = false;
    this.selectionBox.material.transparent = true;
    this.selectionBox.material.opacity = 0.9;
    this.selectionBox.frustumCulled = false;
    this.selectionBox.visible = false;

    this.selectionHelperGroup.add(this.selectionBox);
    this.selectionHelperGroup.traverse((node) => {
      node.userData.isSystemObject = true;
      node.userData.selectable = false;
    });
    this.scene.add(this.selectionHelperGroup);
  }

  _getViewHelperDim(rectWidth, rectHeight, isMulti = false) {
    if (!Number.isFinite(rectWidth) || !Number.isFinite(rectHeight) || rectWidth < 200 || rectHeight < 150) {
      return 0;
    }
    const minSide = Math.min(rectWidth, rectHeight);
    const cap = isMulti ? 112 : 128;
    return Math.min(cap, Math.max(48, Math.floor(minSide * 0.24)));
  }

  _hitTestViewHelper(vh, nx, ny, ctxCamera = null) {
    if (!vh) return false;
    this._viewHelperOrthoCam.updateMatrixWorld();
    vh.updateMatrixWorld(true);
    const ray = new THREE.Raycaster();
    const cam = this._viewHelperOrthoCam || vh.orthoCamera || ctxCamera || this.camera;
    ray.setFromCamera(new THREE.Vector2(nx, ny), cam);
    const taggedSprites = (vh.children || []).filter((c) => Boolean(c.userData?.type));
    const interactive = vh.interactiveObjects || (taggedSprites.length > 0 ? taggedSprites : vh.children) || [];
    const hits = ray.intersectObjects(interactive, true);
    if (hits.length === 0) return false;

    const hitName = (hits[0].object.name || '').toLowerCase();
    const hitUserData = hits[0].object.userData || {};
    const tag = (hitUserData.type || hitName).toLowerCase();

    if (tag.includes('posx') || tag === 'x') this.setCameraPreset('right');
    else if (tag.includes('negx')) this.setCameraPreset('left');
    else if (tag.includes('posy') || tag === 'y') this.setCameraPreset('top');
    else if (tag.includes('negy')) this.setCameraPreset('bottom');
    else if (tag.includes('posz') || tag === 'z') this.setCameraPreset('front');
    else if (tag.includes('negz')) this.setCameraPreset('back');
    else this.setCameraPreset('isometric');
    return true;
  }

  createViewHelper(camera = this.camera, controls = this.controls) {
    if (!camera || !this.domElement) return null;
    try {
      const vh = new ViewHelper(camera, this.domElement);
      if (controls) {
        vh.center = controls.target;
        controls.addEventListener('start', () => {
          vh.animating = false;
        });
      }

      const origHandleClick = typeof vh.handleClick === 'function' ? vh.handleClick.bind(vh) : null;

      // Single-pane ViewHelper click: match the scaled rendered dim x dim box
      // at the bottom-right corner and never intercept clicks on tiny canvases.
      vh.handleClick = (event) => {
        if (!vh || vh.animating || (event.button ?? 0) !== 0) return false;
        const ctx = this.getViewportContextAtPoint(event.clientX, event.clientY);
        if (ctx.pane?.sceneCameraObj || (typeof window !== 'undefined' && window.cameraManager?.lookingThrough)) {
          return false;
        }
        const rect = ctx.rect;
        const dim = this._getViewHelperDim(rect.width, rect.height, false);
        if (dim <= 0) return false;

        const x = event.clientX - rect.left;
        const y = event.clientY - rect.top;
        const offsetX = rect.width - dim;
        const offsetY = rect.height - dim;
        if (x < offsetX || x > rect.width || y < offsetY || y > rect.height) {
          return false;
        }

        if (dim === 128 && origHandleClick) {
          return origHandleClick(event);
        }
        const nx = ((x - offsetX) / dim) * 2 - 1;
        const ny = -((y - offsetY) / dim) * 2 + 1;
        return this._hitTestViewHelper(vh, nx, ny, ctx.camera);
      };

      // Multi-pane ViewHelper click handler in bottom-right of hovered pane.
      vh.handleClickTopRight = (event) => {
        if (!vh || (event.button ?? 0) !== 0) return false;
        const isMulti = Boolean(this.areaManager && !this.areaManager.isSingleFullViewport());
        if (!isMulti) return false;
        const ctx = this.getViewportContextAtPoint(event.clientX, event.clientY);
        if (ctx.pane?.sceneCameraObj) return false;
        const rect = ctx.rect;
        const x = event.clientX - rect.left;
        const y = event.clientY - rect.top;
        const dim = this._getViewHelperDim(rect.width, rect.height, true);
        if (dim <= 0) return false;
        const offsetX = rect.width - dim;
        const offsetY = rect.height - dim;

        if (x >= offsetX && x <= offsetX + dim && y >= offsetY && y <= offsetY + dim) {
          const nx = ((x - offsetX) / dim) * 2 - 1;
          const ny = -((y - offsetY) / dim) * 2 + 1;
          return this._hitTestViewHelper(vh, nx, ny, ctx.camera);
        }
        return false;
      };
      return vh;
    } catch (e) {
      console.warn('ViewHelper initialization fallback:', e);
      return null;
    }
  }

  _initViewHelper() {
    this.viewHelper = this.createViewHelper(this.camera, this.controls);
  }

  _initEventListeners() {
    this._syncPaneUnderCursor = (event, forceSwitch = false) => {
      this.lastPointerClient = { x: event.clientX, y: event.clientY };
      if (!this.areaManager || this.areaManager.isSingleFullViewport()) return;
      if (this.areaManager._dragState || this.areaManager._splitterDrag) return;
      if (this.transformControls?.dragging || this.isTransforming) return;
      if (typeof window !== 'undefined' && window.modalTransformManager?.isActive) return;
      if (!forceSwitch && event.buttons !== 0) return;

      const pane = this.areaManager.getPaneAtClientPoint(event.clientX, event.clientY);
      if (!pane) return;

      if (pane.id && pane.id !== this.areaManager.getActiveLeafId()) {
        this.areaManager.setActiveLeaf(pane.id);
      } else {
        const renderCam = this.getPaneRenderCamera(pane);
        if (this.transformControls && renderCam && this.transformControls.camera !== renderCam) {
          this.transformControls.camera = renderCam;
          this.transformControls.updateMatrixWorld?.();
        }
        this.syncViewportPaneControls(pane);
      }
    };

    this.domElement.addEventListener('pointerdown', (e) => this._syncPaneUnderCursor(e, true), true);
    this.domElement.addEventListener('wheel', (e) => this._syncPaneUnderCursor(e, true), { capture: true, passive: true });
    this.domElement.addEventListener('pointermove', (e) => this._syncPaneUnderCursor(e, false), true);

    this.domElement.addEventListener('pointerdown', this._boundOnPointerDown);
    this.domElement.addEventListener('pointermove', this._boundOnPointerMove);
    this.domElement.addEventListener('pointerup', this._boundOnPointerUp);
    this.domElement.addEventListener('wheel', () => this.requestRender(), { passive: true });
    window.addEventListener('keydown', this._boundOnKeyDown);
    window.addEventListener('resize', this._boundOnResize);
    window.addEventListener('blur', this._boundOnWindowBlur);
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', this._boundOnVisibilityChange);
    }

    const requestSceneRedraw = () => this.requestRender();
    const requestShadowRedraw = () => {
      this.markShadowDirty();
      this.requestRender();
    };
    this._boundRequestRedraw = requestSceneRedraw;
    this._boundRequestShadowRedraw = requestShadowRedraw;
    window.addEventListener('blender:geometryChanged', requestShadowRedraw);
    window.addEventListener('blender:sceneUpdated', requestShadowRedraw);
    window.addEventListener('blender:viewportCameraChanged', requestSceneRedraw);
    window.addEventListener('blender:cameraViewChanged', requestSceneRedraw);
    window.addEventListener('blender:mode-changed', requestShadowRedraw);
    window.addEventListener('blender:objectTransformed', requestShadowRedraw);

    // ResizeObserver for reliable container size tracking
    if (window.ResizeObserver) {
      this.resizeObserver = new ResizeObserver(() => this.onResize());
      this.resizeObserver.observe(this.container);
    }
  }

  // ==========================================
  // SELECTION & POINTER INTERACTION
  // ==========================================

  _onWindowBlur() {
    this.isPointerDown = false;
    this._pointerDownOnGizmo = false;
    try {
      if (this.domElement && typeof PointerEvent !== 'undefined') {
        this.domElement.dispatchEvent(new PointerEvent('pointercancel', { bubbles: true, cancelable: true }));
      }
    } catch (_) {}
    if (this.controls) {
      const wasEnabled = this.controls.enabled;
      this.controls.enabled = false;
      this.controls.update?.();
      this.controls.enabled = wasEnabled;
      this.syncViewportPaneControls();
    }
  }

  _onPointerDown(event) {
    if ((event.button ?? 0) !== 0) {
      return;
    }
    this.isPointerDown = true;
    this.pointerDownPos.set(event.clientX, event.clientY);
    this._pointerDownOnGizmo = Boolean(this.transformControls && this.transformControls.dragging);
  }

  _onPointerMove(event) {
    this.lastPointerClient = { x: event.clientX, y: event.clientY };
    const activelyInteracting = (
      this.isPointerDown ||
      this.isTransforming ||
      this.transformControls?.dragging ||
      (typeof window !== 'undefined' && (
        window.modalTransformManager?.isActive ||
        window.sculptMode?.isBrushing ||
        window.paintMode?.isBrushing
      ))
    );
    if (!activelyInteracting) return;
    this.getViewportNDC(event.clientX, event.clientY, this.pointer);
    this.requestRender();
  }

  _onPointerUp(event) {
    if ((event.button ?? 0) !== 0 || !this.isPointerDown) return;
    this.isPointerDown = false;
    const wasGizmoClick = this._pointerDownOnGizmo;
    this._pointerDownOnGizmo = false;
    this.requestRender();

    // Don't pick or trigger ViewHelper if user was dragging gizmo or orbiting camera
    const deltaX = Math.abs(event.clientX - this.pointerDownPos.x);
    const deltaY = Math.abs(event.clientY - this.pointerDownPos.y);
    if (deltaX > this.maxClickDelta || deltaY > this.maxClickDelta) {
      return;
    }

    // Check if ViewHelper consumed the click
    if (this.viewHelper?.visible) {
      const isSingle = !this.areaManager || this.areaManager.isSingleFullViewport();
      if (!isSingle && typeof this.viewHelper.handleClickTopRight === 'function') {
        const handled = this.viewHelper.handleClickTopRight(event);
        if (handled) return;
      }
      if (isSingle && typeof this.viewHelper.handleClick === 'function') {
        const handled = this.viewHelper.handleClick(event);
        if (handled) return;
      }
    }

    const isSelectionModifier = Boolean(event.shiftKey || event.metaKey || event.ctrlKey);

    // Don't pick if transformControls handled an unmodified click or is hovered/dragging
    if (!isSelectionModifier && (wasGizmoClick || (this.transformControls && (this.transformControls.dragging || this.transformControls.hovered)))) {
      return;
    }

    // Don't alter object selection while Sculpt, Paint, Modal Transform, Weight Paint brush, or Knife is active
    if (
      (typeof window !== 'undefined' && (window.sculptMode?.isActive || window.paintMode?.isActive || window.modalTransformManager?.isActive || window.rigSystem?._isWeightBrushing || window.rigSystem?._weightStrokeConsumed)) ||
      this.editMode?._knifeSession
    ) {
      return;
    }

    this._performRaycastSelection(event);
  }

  _performRaycastSelection(event) {
    if (this.editMode && this.editMode.isActive) {
      this.editMode.handleRaycast(event);
      return;
    }

    if (!this.sceneManager) return;

    const ctx = this.getViewportContextAtPoint(event.clientX, event.clientY);
    const rect = ctx.rect;
    const w = rect.width || 1;
    const h = rect.height || 1;
    this.pointer.set(
      ((event.clientX - rect.left) / w) * 2 - 1,
      -((event.clientY - rect.top) / h) * 2 + 1
    );
    this.raycaster.setFromCamera(this.pointer, ctx.camera || this.camera);

    // 1. Two-Bone IK Handle and Pose Mode bone selection priority
    if (typeof window !== 'undefined' && window.rigSystem) {
      const rig = window.rigSystem;

      // 1.1 Priority: IK Handles if IK mode is active
      if (rig.isIKEnabled && rig.ikHandlesGroup && rig.ikHandlesGroup.visible) {
        const ikHits = this.raycaster.intersectObjects(rig.ikHandlesGroup.children, true);
        if (ikHits.length > 0) {
          let hit = ikHits[0].object;
          while (hit && !hit.userData?.isIKHandle && hit.parent !== rig.ikHandlesGroup) {
            hit = hit.parent;
          }
          if (hit && hit.userData?.isIKHandle) {
            rig.selectIKHandle(hit);
            return;
          }
        }
      }

      // 1.2 Pose Mode / Edit Bone Mode / Weight Paint bones (joints & octahedral proxies)
      if (rig.isPoseMode || rig.isWeightPaintMode || rig.isEditBoneMode) {
        const pickableBones = [];
        this.scene.traverse((o) => {
          if (o.visible && (o.userData?.isBoneJoint || o.userData?.isBoneHitProxy || o.isBone)) {
            pickableBones.push(o);
          }
        });
        if (pickableBones.length > 0) {
          const boneHits = this.raycaster.intersectObjects(pickableBones, false);
          if (boneHits.length > 0) {
            const hit = boneHits[0].object;
            const targetBone = hit.userData?.targetBone || (hit.isBone ? hit : null);
            if (targetBone) {
              rig.selectBone(targetBone);
              return;
            }
          }
        }
      }
    }

    const pickables = this.sceneManager.getSelectableObjects();
    const intersects = this.raycaster.intersectObjects(pickables, true);

    const isMultiSelect = event.shiftKey || event.metaKey || event.ctrlKey;

    if (intersects.length > 0) {
      const hitObj = intersects[0].object;
      // Find top-level registered parent under root
      let picked = hitObj;
      while (picked.parent && picked.parent !== this.sceneManager.rootContainer && picked.parent !== this.scene) {
        picked = picked.parent;
      }

      if (
        picked &&
        hitObj &&
        picked !== hitObj &&
        hitObj.isMesh &&
        !hitObj.userData?.isHelper &&
        !hitObj.userData?.isSystemObject &&
        hitObj.geometry?.attributes?.position
      ) {
        picked.userData = picked.userData || {};
        picked.userData._lastClickedMesh = hitObj;
      }

      if (this.sceneManager.isSelected(picked) && isMultiSelect) {
        this.sceneManager.deselect(picked);
      } else {
        this.sceneManager.select(picked, isMultiSelect);
      }
    } else {
      // Clicked on empty background: deselect unless shift is held
      if (!isMultiSelect) {
        this.sceneManager.clearSelection();
      }
    }
  }

  // ==========================================
  // BLENDER HOTKEYS & KEYBOARD NAVIGATION
  // ==========================================

  _onKeyDown(event) {
    if (shouldBlockViewportShortcut()) return;
    if (!['Shift', 'Control', 'Alt', 'Meta'].includes(event.key)) {
      this.requestRender();
    }

    const key = event.key.toLowerCase();
    const isCtrl = event.ctrlKey || event.metaKey;

    // Blender Tab: Toggle Edit Mode / Object Mode. Do not hijack Tab while the
    // user is keyboard-navigating another control (menu, toolbar, dialog button).
    if (key === 'tab') {
      if (isInteractiveTarget() || isCtrl || event.altKey || event.shiftKey) return;
      event.preventDefault();
      this.toggleEditMode();
      return;
    }

    // NumLock-off NumpadDecimal reports Delete; route it before mesh/object deletion.
    if (event.code === 'NumpadDecimal' || event.code === 'Numpad5') {
      if (!isCtrl && !event.altKey && !event.shiftKey) {
        event.preventDefault();
        if (event.code === 'Numpad5') this.toggleProjection();
        else this.focusSelection();
      }
      return;
    }

    // Delegate to Edit Mode if active
    if (this.editMode && this.editMode.isActive) {
      const handled = this.editMode.handleKeyDown(event);
      if (handled) return;
    }

    // Sculpt Mode owns single-key shortcuts while active (prevents accidental
    // object duplication/deletion during a stroke)
    if (typeof window !== 'undefined' && window.sculptMode?.isActive) {
      return;
    }

    // Undo / Redo
    if (isCtrl && key === 'z') {
      event.preventDefault();
      if (event.shiftKey) {
        if (this.sceneManager) this.sceneManager.redo();
      } else {
        if (this.sceneManager) this.sceneManager.undo();
      }
      return;
    }

    if (isCtrl && key === 'y') {
      event.preventDefault();
      if (this.sceneManager) this.sceneManager.redo();
      return;
    }

    // Blender Transform Modes: G (Translate/Grab), R (Rotate), S (Scale).
    // Never swallow browser shortcuts such as Cmd/Ctrl+Shift+R (hard reload).
    const plainKey = !isCtrl && !event.altKey && !event.shiftKey;

    if (typeof window !== 'undefined' && window.rigSystem?.isEditBoneMode) {
      if (key === 'e' && plainKey) {
        event.preventDefault();
        window.rigSystem.extrudeBone();
        return;
      }
      if ((key === 'x' || key === 'delete') && !isCtrl && !event.altKey && !event.shiftKey) {
        event.preventDefault();
        window.rigSystem.deleteBone();
        return;
      }
    }

    if (typeof window !== 'undefined' && window.rigSystem?.isPoseMode && !isCtrl && !event.altKey) {
      if (key === 'i') {
        event.preventDefault();
        const boneArg = event.shiftKey ? 'all' : (window.rigSystem.activeBone || 'all');
        const res = window.rigSystem.keyframePoseToTimeline(window.rigSystem.activeCharacter, boneArg);
        if (window.codeEditor) {
          window.codeEditor.log('success', `🔑 Keyframed ${res.count} bone(s) at frame ${res.frame}`);
        }
        return;
      }
    }

    if (typeof window !== 'undefined' && window.rigSystem?.isWeightPaintMode && plainKey) {
      if (key === '[' || event.code === 'BracketLeft') {
        event.preventDefault();
        window.rigSystem.setWeightBrush({ radius: (window.rigSystem.weightBrush?.radius || 0.22) * 0.85 });
        return;
      }
      if (key === ']' || event.code === 'BracketRight') {
        event.preventDefault();
        window.rigSystem.setWeightBrush({ radius: (window.rigSystem.weightBrush?.radius || 0.22) * 1.18 });
        return;
      }
    }
    if (key === 'g' && plainKey) {
      event.preventDefault();
      this.setTransformMode('translate');
      return;
    }
    if (key === 'r' && plainKey) {
      event.preventDefault();
      this.setTransformMode('rotate');
      return;
    }
    if (key === 's' && plainKey) {
      event.preventDefault();
      this.setTransformMode('scale');
      return;
    }

    // Shift + D: Duplicate Active Selection
    if (event.shiftKey && key === 'd' && !isCtrl && !event.altKey) {
      event.preventDefault();
      const count = this.duplicateSelection();
      if (count > 0) {
        // Switch to translate mode immediately like Blender
        this.setTransformMode('translate');
      }
      return;
    }

    // X or Delete: Delete Selected Objects (plain only — Cmd/Ctrl+X is Cut, Shift+X must not bypass guards)
    if ((key === 'x' || key === 'delete') && !isCtrl && !event.altKey && !event.shiftKey) {
      event.preventDefault();
      this.deleteSelection();
      return;
    }

    // Escape: leave camera view, then clear selection or cancel transform
    if (key === 'escape') {
      event.preventDefault();
      if (typeof window !== 'undefined' && window.cameraManager?.lookingThrough) {
        window.cameraManager.exitCameraView();
        return;
      }
      if (this.sceneManager) {
        this.sceneManager.clearSelection();
      }
      return;
    }

    const allowPeriodFocus = key === '.' && this.keymapPreset !== 'blender-pro';
    if ((allowPeriodFocus || key === 'f') && plainKey) {
      event.preventDefault();
      this.focusSelection();
      return;
    }

    // Ctrl+Alt+0 / Cmd+Alt+0: Align active camera to current viewport
    if ((event.code === 'Numpad0' || event.code === 'Digit0' || key === '0') && isCtrl && event.altKey && !event.shiftKey) {
      event.preventDefault();
      window.cameraManager?.alignActiveCameraToView?.();
      return;
    }

    // Camera View: Numpad 0 (or 0 / Alt+0 for keyboards without a numpad)
    if (event.code === 'Numpad0' || (key === '0' && !isCtrl)) {
      event.preventDefault();
      if (typeof window !== 'undefined' && window.cameraManager) {
        window.cameraManager.toggleViewCamera(this.sceneManager?.getActiveObject?.());
      }
      return;
    }

    // Viewport presets: Numpad 1 (Front), 3 (Right), 7 (Top) — check event.code for macOS Option+1/3/7
    if (event.code === 'Numpad1' || (event.altKey && (key === '1' || event.code === 'Digit1'))) {
      event.preventDefault();
      this.setCameraPreset(event.ctrlKey ? 'back' : 'front');
      return;
    }
    if (event.code === 'Numpad3' || (event.altKey && (key === '3' || event.code === 'Digit3'))) {
      event.preventDefault();
      this.setCameraPreset(event.ctrlKey ? 'left' : 'right');
      return;
    }
    if (event.code === 'Numpad7' || (event.altKey && (key === '7' || event.code === 'Digit7'))) {
      event.preventDefault();
      this.setCameraPreset(event.ctrlKey ? 'bottom' : 'top');
      return;
    }

    // Numpad 4/6/8/2 orbit, Numpad +/- dolly (Blender viewport navigation)
    if (event.code === 'Numpad4' || event.code === 'Numpad6') {
      event.preventDefault();
      const step = Math.PI / 12;
      this.orbitCamera(event.code === 'Numpad4' ? -step : step, 0);
      return;
    }
    if (event.code === 'Numpad8' || event.code === 'Numpad2') {
      event.preventDefault();
      const step = Math.PI / 18;
      this.orbitCamera(0, event.code === 'Numpad8' ? -step : step);
      return;
    }
    if (event.code === 'NumpadAdd' || event.code === 'NumpadSubtract') {
      event.preventDefault();
      this.dollyCamera(event.code === 'NumpadAdd' ? 0.88 : 1.14);
      return;
    }
  }

  orbitCamera(deltaYaw = 0, deltaPitch = 0) {
    if (!this.camera || !this.controls) return;
    this._exitActivePaneCameraView();
    const target = this.controls.target;
    const offset = this.camera.position.clone().sub(target);
    const spherical = new THREE.Spherical().setFromVector3(offset);
    spherical.theta += deltaYaw;
    spherical.phi = THREE.MathUtils.clamp(spherical.phi + deltaPitch, 0.02, Math.PI - 0.02);
    offset.setFromSpherical(spherical);
    this.camera.position.copy(target).add(offset);
    this.camera.lookAt(target);
    this.controls.update();
    this.requestRender();
  }

  dollyCamera(factor = 1) {
    if (!this.camera || !this.controls) return;
    this._exitActivePaneCameraView();
    if (this.camera.isOrthographicCamera) {
      this.camera.zoom = THREE.MathUtils.clamp(this.camera.zoom / factor, this.controls.minZoom, this.controls.maxZoom);
      this.camera.updateProjectionMatrix();
      this.controls.update();
      this.requestRender();
      return;
    }
    const target = this.controls.target;
    const offset = this.camera.position.clone().sub(target);
    offset.multiplyScalar(factor);
    const distance = offset.length();
    if (distance < this.controls.minDistance || distance > this.controls.maxDistance) return;
    this.camera.position.copy(target).add(offset);
    this.camera.lookAt(target);
    this.controls.update();
    this.requestRender();
  }

  // ==========================================
  // TRANSFORM CONTROLS MANAGEMENT
  // ==========================================

  /**
   * Sets transform gizmo mode ('translate' | 'rotate' | 'scale')
   * @param {string} mode 
   */
  setTransformMode(mode) {
    if (!['translate', 'rotate', 'scale'].includes(mode)) return;
    this.currentTransformMode = mode;
    if (this.transformControls) {
      this.transformControls.setMode(mode);
    }
  }

  /**
   * Sets transform coordinate space ('world' | 'local')
   * @param {string} space 
   */
  setTransformSpace(space) {
    if (!['world', 'local'].includes(space)) return;
    this.currentTransformSpace = space;
    if (this.transformControls) {
      this.transformControls.setSpace(space);
    }
  }

  /**
   * Toggles grid snapping for gizmo operations
   * @param {boolean} enabled 
   */
  setSnapping(enabled) {
    this.snapEnabled = !!enabled;
    if (this.transformControls) {
      this.transformControls.setTranslationSnap(this.snapEnabled ? this.snapTranslation : null);
      this.transformControls.setRotationSnap(this.snapEnabled ? this.snapRotation : null);
      this.transformControls.setScaleSnap(this.snapEnabled ? this.snapScale : null);
    }
  }

  // ==========================================
  // SCENE MANAGER INTEGRATION
  // ==========================================

  /**
   * Attaches a SceneManager instance and hooks into its selection and history events
   * @param {SceneManager} sceneManager 
   */
  attachSceneManager(sceneManager) {
    this.sceneManager = sceneManager;

    // Listen to selection changes
    this.sceneManager.on('selectionChanged', ({ selected, active }) => {
      this.updateActiveGizmo(active);
      this.updateSelectionHelper();
      this.requestRender();
    });

    // Listen to object additions, clears & transforms
    this.sceneManager.on('objectAdded', () => this.requestRender());
    this.sceneManager.on('sceneCleared', () => this.requestRender());
    this.sceneManager.on('transformChanged', () => this.requestRender());
    this.sceneManager.on('hierarchyChanged', () => this.requestRender());

    // Listen to object removals
    this.sceneManager.on('objectRemoved', ({ object }) => {
      if (this.transformControls && this.transformControls.object === object) {
        this.transformControls.detach();
      }
      this.updateSelectionHelper();
      this.requestRender();
    });

    // Listen to visibility changes
    this.sceneManager.on('visibilityChanged', ({ object, visible }) => {
      if (!visible && this.transformControls && this.transformControls.object === object) {
        this.transformControls.detach();
      }
      this.updateSelectionHelper();
      this.requestRender();
    });
  }

  /**
   * Sets EditMode instance
   * @param {EditMode} editMode
   */
  setEditMode(editMode) {
    this.editMode = editMode;
  }

  /**
   * Toggles between Object Mode and Edit Mode
   */
  toggleEditMode() {
    if (!this.editMode) return;
    const rigSystem = typeof window !== 'undefined' ? window.rigSystem : null;

    // Leave Sculpt, Paint, or Weight Paint modes before toggling Edit Mode
    if (typeof window !== 'undefined' && window.sculptMode?.isActive) {
      window.sculptMode.exit();
    }
    if (typeof window !== 'undefined' && window.paintMode?.isActive) {
      window.paintMode.exit();
    }
    if (rigSystem?.isWeightPaintMode) {
      rigSystem.disableWeightPaintMode();
    }

    if (this.editMode.isActive) {
      this.editMode.exit();
      return;
    }

    if (rigSystem?.isEditBoneMode) {
      rigSystem.exitEditBoneMode();
      syncViewportModeOptions(this.sceneManager?.getActiveObject?.(), this.sceneManager, rigSystem);
      return;
    }

    if (rigSystem?.isPoseMode) {
      rigSystem.setPoseMode(false);
    }

    const active = this.sceneManager ? this.sceneManager.getActiveObject() : null;
    const mesh = resolveEditableMesh(active, this.sceneManager);
    if (mesh) {
      this.editMode.enter(mesh);
      syncViewportModeOptions(active, this.sceneManager, rigSystem);
      return;
    }

    const rigTarget = resolveRigTarget(active, this.sceneManager, rigSystem);
    if (rigSystem && rigTarget.hasSkeleton && rigSystem.enterEditBoneMode(rigTarget.target)) {
      syncViewportModeOptions(active, this.sceneManager, rigSystem);
      return;
    }

    const msg = 'Please select a Mesh or Armature object first to enter Edit Mode.';
    if (typeof window !== 'undefined' && window.app?.notify) {
      window.app.notify(msg, 'warning');
    } else {
      console.warn('[Engine]', msg);
    }
    syncViewportModeOptions(active, this.sceneManager, rigSystem);
  }

  /**
   * Updates TransformControls target object
   * @param {THREE.Object3D|null} object 
   */
  updateActiveGizmo(object) {
    if (!this.transformControls) return;
    if (this.editMode && this.editMode.isActive) return;
    if (typeof window !== 'undefined' && (window.sculptMode?.isActive || window.paintMode?.isActive || window.rigSystem?.isWeightPaintMode)) return;

    if (object && object.visible && !object.userData.locked) {
      this.transformControls.attach(object);
    } else {
      this.transformControls.detach();
    }
  }

  /**
   * Updates bounding box highlight around active selected object in O(1) using cached geometry.boundingBox
   * (avoids Three.js BoxHelper.setFromObject O(V) CPU vertex scan on high-poly meshes & Groups).
   */
  updateSelectionHelper() {
    if (!this.selectionBox) return;
    if (this.editMode && this.editMode.isActive) {
      this.selectionBox.visible = false;
      return;
    }

    const active = this.sceneManager ? this.sceneManager.getActiveObject() : null;
    if (
      active &&
      active.visible &&
      !active.userData?.isHelper &&
      !active.userData?.isSystemObject &&
      !active.isLight &&
      !active.isCamera &&
      (active.isMesh || active.userData?.isScatterGroup || resolveEditableMesh(active, this.sceneManager))
    ) {
      if (!this._fastSelBox) {
        this._fastSelBox = new THREE.Box3();
        this._fastPartBox = new THREE.Box3();
      }
      active.updateMatrixWorld(true);
      this._fastSelBox.makeEmpty();
      let hasSkinned = false;

      if (active.userData?.isScatterGroup) {
        const mats = active.userData._allMatrices;
        const count = mats ? Math.floor(mats.length / 16) : 0;
        const pad = Math.max(0.4, active.userData.boundingRadius || 0.8);
        if (count > 0) {
          let minX = Infinity, minY = Infinity, minZ = Infinity;
          let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
          for (let i = 0; i < count; i++) {
            const b = i * 16;
            const px = mats[b + 12], py = mats[b + 13], pz = mats[b + 14];
            if (px < minX) minX = px; if (px > maxX) maxX = px;
            if (py < minY) minY = py; if (py > maxY) maxY = py;
            if (pz < minZ) minZ = pz; if (pz > maxZ) maxZ = pz;
          }
          this._fastSelBox.min.set(minX - pad, Math.min(0, minY - pad), minZ - pad);
          this._fastSelBox.max.set(maxX + pad, maxY + pad, maxZ + pad);
          this._fastSelBox.applyMatrix4(active.matrixWorld);
        } else {
          const pos = new THREE.Vector3().setFromMatrixPosition(active.matrixWorld);
          this._fastSelBox.setFromCenterAndSize(pos, new THREE.Vector3(pad * 2, pad * 2, pad * 2));
        }
      } else {
        active.traverse((node) => {
          if (!node.isMesh || !node.visible || node.userData?.isHelper || node.userData?.isSystemObject) return;
          if (node.isSkinnedMesh) {
            hasSkinned = true;
            return;
          }
          if (!node.geometry) return;
          if (!node.geometry.boundingBox) node.geometry.computeBoundingBox();
          if (node.geometry.boundingBox && !node.geometry.boundingBox.isEmpty()) {
            this._fastPartBox.copy(node.geometry.boundingBox).applyMatrix4(node.matrixWorld);
            this._fastSelBox.union(this._fastPartBox);
          }
        });
      }

      if (hasSkinned || this._fastSelBox.isEmpty()) {
        this._fastSelBox.setFromObject(active);
      }
      if (!this._fastSelBox.isEmpty()) {
        this.selectionBox.box.copy(this._fastSelBox);
        this.selectionBox.visible = true;
      } else {
        this.selectionBox.visible = false;
      }
    } else {
      this.selectionBox.visible = false;
    }
  }

  /**
   * Deletes every selected object and releases its GPU resources.
   * Geometry/material/texture data stays in CPU memory, so undo can re-add the
   * object and three.js re-uploads it on the next render.
   * @returns {number} number of removed objects
   */
  deleteSelection() {
    if (!this.sceneManager) return 0;
    const selected = this.sceneManager.getSelectedObjects();
    if (selected.length === 0) return 0;
    if (selected.length === 1) {
      this.sceneManager.removeObject(selected[0], true, false);
    } else {
      const cmd = new RemoveObjectsCommand(this.sceneManager, selected);
      cmd.execute();
      this.sceneManager.executeCommand(cmd);
    }
    // Release GPU VBO handles immediately for unshared geometries while keeping CPU typed
    // arrays, skeletons, and materials intact so Ctrl+Z Undo re-uploads them on next render.
    const root = this.sceneManager.rootContainer || this.scene;
    for (const obj of selected) {
      obj.traverse?.((child) => {
        if (child.geometry && typeof child.geometry.dispose === 'function' &&
            !dataBlockRegistry.isGeometryShared(child.geometry, root, child)) {
          child.geometry.dispose();
        }
      });
    }
    return selected.length;
  }

  /**
   * Duplicates every selected object as one undo step (Blender Shift+D).
   * @returns {number} number of duplicated root objects
   */
  duplicateSelection() {
    if (!this.sceneManager) return 0;
    const selected = this.sceneManager.getSelectedObjects();
    if (selected.length === 0) return 0;
    return this.sceneManager.duplicateObjects(selected, { x: 1, y: 0, z: 1 }).length;
  }

  // ==========================================
  // CAMERA VIEW PRESETS & NAVIGATION
  // ==========================================

  _stopCameraTransitions() {
    if (this.viewHelper) this.viewHelper.animating = false;
    if (this.activeViewportPane?.viewHelper) this.activeViewportPane.viewHelper.animating = false;
    if (this.controls) {
      const prevDamp = this.controls.enableDamping;
      this.controls.enableDamping = false;
      this.controls.update();
      this.controls.enableDamping = prevDamp;
    }
  }

  /**
   * Smoothly animates or switches camera to standard views (Top, Front, Right, etc.)
   * @param {'front'|'back'|'right'|'left'|'top'|'bottom'|'isometric'} preset 
   */
  setCameraPreset(preset) {
    this._stopCameraTransitions();
    this._exitActivePaneCameraView();
    const target = this.controls.target.clone();
    const distance = this.camera.position.distanceTo(target);

    let offset = new THREE.Vector3();
    switch (preset) {
      case 'front':
        offset.set(0, 0, distance);
        break;
      case 'back':
        offset.set(0, 0, -distance);
        break;
      case 'right':
        offset.set(distance, 0, 0);
        break;
      case 'left':
        offset.set(-distance, 0, 0);
        break;
      case 'top':
        offset.set(0, distance, 0.0001); // Small offset to avoid gimbal lock
        break;
      case 'bottom':
        offset.set(0, -distance, 0.0001);
        break;
      case 'isometric':
      default:
        offset.set(distance * 0.577, distance * 0.577, distance * 0.577);
        break;
    }

    this.camera.position.copy(target).add(offset);
    this.camera.lookAt(target);
    this.camera.updateMatrixWorld(true);
    this.controls.update();
  }

  /**
   * Focuses camera view on the target object (Blender Numpad . frame)
   * @param {THREE.Object3D} object 
   */
  focusOnObject(object) {
    if (!object) return;
    object.updateWorldMatrix(true, true);
    this._focusBounds(new THREE.Box3().setFromObject(object));
  }

  _focusBounds(box) {
    if (box.isEmpty()) return;
    this._stopCameraTransitions();
    window.cameraManager?.exitCameraView();
    const camera = this.camera;
    const center = box.getCenter(new THREE.Vector3());
    const radius = box.getSize(new THREE.Vector3()).length() / 2;
    const direction = camera.position.clone().sub(this.controls.target);
    let distance = direction.length();
    direction.normalize();
    if (direction.lengthSq() < 0.001) direction.set(1, 1, 1).normalize();

    if (radius > 0) {
      if (camera.isOrthographicCamera) {
        const aspect = (camera.right - camera.left) / (camera.top - camera.bottom);
        const halfHeight = Math.max(0.5, radius * 1.2 / Math.min(1, aspect));
        camera.zoom = (camera.top - camera.bottom) / (2 * halfHeight);
        distance = Math.max(distance, radius * 2 + camera.near);
      } else {
        const halfFov = THREE.MathUtils.degToRad(camera.getEffectiveFOV()) / 2;
        const halfAngle = Math.atan(Math.tan(halfFov) * Math.min(1, camera.aspect));
        distance = Math.max(2, radius * 1.2 / Math.sin(halfAngle));
      }
    }
    this.controls.target.copy(center);
    camera.position.copy(center).addScaledVector(direction, distance);
    camera.lookAt(center);
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld(true);
    this.controls.update();
  }

  focusOn(object) {
    this.focusOnObject(object);
  }

  focusSelection() {
    if (this.editMode?.isActive) {
      const edit = this.editMode;
      edit.targetMesh.updateWorldMatrix(true, false);
      const box = new THREE.Box3();
      for (const index of edit.getActiveVertexIndices()) {
        box.expandByPoint(edit.vertices[index].clone().applyMatrix4(edit.targetMesh.matrixWorld));
      }
      this._focusBounds(box);
      return;
    }
    const selected = this.sceneManager?.getSelectedObjects ? this.sceneManager.getSelectedObjects() : [];
    if (selected.length > 1) {
      const box = new THREE.Box3();
      for (const obj of selected) {
        if (!obj) continue;
        obj.updateWorldMatrix(true, true);
        box.expandByObject(obj);
      }
      if (!box.isEmpty()) {
        this._focusBounds(box);
        return;
      }
    }
    const active = this.sceneManager ? this.sceneManager.getActiveObject() : null;
    if (active) this.focusOnObject(active);
  }

  // ==========================================
  // RENDER LOOP & HOOKS
  // ==========================================

  start() {
    if (this.isRunning) return;
    this.isRunning = true;
    this.requestRender();
  }

  stop() {
    this.isRunning = false;
    if (this.animationFrameId !== null) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }
    this._needsRender = false;
  }

  /**
   * Requests a coalesced redraw on the next animation frame (or immediate sync redraw).
   * @param {boolean} [immediate=false]
   */
  requestRender(immediate = false) {
    if (this._suppressRender) return;
    if (!this.renderer || !this.scene || !this.camera) return;
    if (immediate) {
      this._needsRender = false;
      this.markShadowDirty();
      this._lastRenderTime = typeof performance !== 'undefined' ? performance.now() : Date.now();
      this._render();
      return;
    }
    this._needsRender = true;
    if (!this.isRunning || typeof requestAnimationFrame !== 'function') {
      this._render();
      return;
    }
    if (this.animationFrameId === null) {
      this.animationFrameId = requestAnimationFrame(this._boundTick);
    }
  }

  render() {
    if (this._suppressRender) return;
    this._needsRender = false;
    this.markShadowDirty();
    this._lastRenderTime = typeof performance !== 'undefined' ? performance.now() : Date.now();
    this._render();
  }

  _tick(nowArg) {
    this.animationFrameId = null;
    if (!this.isRunning) return;
    if (typeof document !== 'undefined' && document.hidden) return;

    const now = Number.isFinite(nowArg) ? nowArg : (typeof performance !== 'undefined' ? performance.now() : Date.now());
    const minInterval = this.maxFPS > 0 ? (1000 / this.maxFPS) - 1.5 : 0;
    const elapsed = now - this._lastRenderTime;
    if (minInterval > 0 && this._lastRenderTime > 0 && elapsed >= 0 && elapsed < minInterval) {
      if (this._shouldContinueRendering()) {
        this.animationFrameId = requestAnimationFrame(this._boundTick);
      }
      return;
    }

    this._lastRenderTime = now;
    this._needsRender = false;

    const movingBefore = this._sampleControlsMotion();
    this._render();
    const movingAfter = this._sampleControlsMotion();

    if (movingBefore || movingAfter) {
      this._dampingGrace = 2;
    } else if (this._dampingGrace > 0) {
      this._dampingGrace--;
    }

    if (this._shouldContinueRendering()) {
      this.animationFrameId = requestAnimationFrame(this._boundTick);
    }
  }

  _sampleControlsMotion() {
    let changed = false;
    for (const ctrl of this.getAllViewportControls()) {
      const cam = ctrl?.object;
      if (!ctrl || !cam) continue;
      let snap = this._controlMotionState.get(ctrl);
      if (!snap) {
        snap = new Float64Array(9);
        snap[0] = cam.position.x;
        snap[1] = cam.position.y;
        snap[2] = cam.position.z;
        snap[3] = cam.quaternion.x;
        snap[4] = cam.quaternion.y;
        snap[5] = cam.quaternion.z;
        snap[6] = ctrl.target.x;
        snap[7] = ctrl.target.y;
        snap[8] = ctrl.target.z;
        this._controlMotionState.set(ctrl, snap);
        continue;
      }
      const dx = cam.position.x - snap[0];
      const dy = cam.position.y - snap[1];
      const dz = cam.position.z - snap[2];
      const qx = cam.quaternion.x - snap[3];
      const qy = cam.quaternion.y - snap[4];
      const qz = cam.quaternion.z - snap[5];
      const tx = ctrl.target.x - snap[6];
      const ty = ctrl.target.y - snap[7];
      const tz = ctrl.target.z - snap[8];
      const deltaSq = dx * dx + dy * dy + dz * dz + qx * qx + qy * qy + qz * qz + tx * tx + ty * ty + tz * tz;
      if (deltaSq > 1e-9) {
        changed = true;
      }
      snap[0] = cam.position.x;
      snap[1] = cam.position.y;
      snap[2] = cam.position.z;
      snap[3] = cam.quaternion.x;
      snap[4] = cam.quaternion.y;
      snap[5] = cam.quaternion.z;
      snap[6] = ctrl.target.x;
      snap[7] = ctrl.target.y;
      snap[8] = ctrl.target.z;
    }
    return changed;
  }

  _shouldContinueRendering() {
    if (this._needsRender || this._dampingGrace > 0) return true;
    if (this.isPointerDown || this.isTransforming || this.transformControls?.dragging) return true;
    if (this.viewHelper?.animating) return true;
    if (this.areaManager && !this.areaManager.isSingleFullViewport()) {
      for (const pane of this.areaManager.getViewportPanes()) {
        if (pane?.viewHelper?.animating) return true;
      }
    }
    if (typeof window !== 'undefined') {
      if (
        window.modalTransformManager?.isActive ||
        window.sculptMode?.isBrushing ||
        window.paintMode?.isBrushing ||
        window.timelineEngine?.isPlaying ||
        window.simulationManager?.playing ||
        window.cameraManager?.isAnimating ||
        window.mocapUI?.retargeter?.isPlaying
      ) {
        return true;
      }
    }
    for (const cb of this.renderCallbacks) {
      const meta = this._renderCallbackMeta.get(cb);
      if (meta?.passive) continue;
      if (typeof meta?.isActive === 'function') {
        if (meta.isActive()) return true;
        continue;
      }
      return true;
    }
    return false;
  }

  _render() {
    if (!this.renderer || !this.scene || !this.camera) return;
    // Clamp delta on wake-up from idle pause so animations/damping never jump
    const delta = Math.min(this.clock ? this.clock.getDelta() : 0.016, 0.1);

    // Update orbit damping across all active viewport controls
    for (const ctrl of this.getAllViewportControls()) {
      if (ctrl && ctrl.enabled) {
        ctrl.update();
      }
    }

    // Update active selection box helper if transforming (uses O(1) cached bounds)
    if (this.isTransforming && this.selectionBox && this.selectionBox.visible) {
      this.updateSelectionHelper();
    }

    // Update SkeletonHelper only when Rig / Pose / Bone editing is active
    if (typeof window !== 'undefined' && window.rigSystem) {
      const rs = window.rigSystem;
      if ((rs.isPoseMode || rs.isEditBoneMode || rs.isWeightPaintMode || rs.isIKEnabled) && typeof rs.updateSkeletonHelper === 'function') {
        rs.updateSkeletonHelper();
      }
    }

    // Mark shadow map dirty only when scene objects are animating/simulating (not on plain camera orbits)
    let hasActiveSceneMotion = Boolean(
      typeof window !== 'undefined' && (
        window.timelineEngine?.isPlaying ||
        window.simulationManager?.playing ||
        window.mocapUI?.retargeter?.isPlaying ||
        window.modalTransformManager?.isActive ||
        this.isTransforming ||
        this.transformControls?.dragging
      )
    );
    if (!hasActiveSceneMotion && this.renderCallbacks?.size > 0) {
      for (const cb of this.renderCallbacks) {
        const meta = this._renderCallbackMeta.get(cb);
        if (!meta?.passive && (!meta?.isActive || meta.isActive())) {
          hasActiveSceneMotion = true;
          break;
        }
      }
    }
    if (hasActiveSceneMotion) {
      this.markShadowDirty();
    }

    // User / Plugin render callbacks
    this.renderCallbacks?.forEach(cb => {
      try {
        cb(delta);
      } catch (e) {
        console.error('Error in render callback:', e);
      }
    });

    const renderT0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    const activeLodBias = this.viewportGovernor ? this.viewportGovernor.getEffectiveLodBias() : 1.0;

    if (!this._renderOverrideSize && this.areaManager && !this.areaManager.isSingleFullViewport()) {
      this.lodManager?.update?.(this.camera, activeLodBias);
      this.instancingSystem?.update?.(this.camera, activeLodBias, delta);
      this._renderMultiAreas(delta);
    } else {
      this.lodManager?.update?.(this.camera, activeLodBias);
      this.instancingSystem?.update?.(this.camera, activeLodBias, delta);
      let cw = this._renderOverrideSize?.width || 0;
      let ch = this._renderOverrideSize?.height || 0;
      if ((!cw || !ch) && this.renderer?.getSize) {
        if (!this._tmpRenderSize) this._tmpRenderSize = new THREE.Vector2();
        this.renderer.getSize(this._tmpRenderSize);
        cw = this._tmpRenderSize.x;
        ch = this._tmpRenderSize.y;
      }
      if (!cw) cw = this.container?.clientWidth || this.domElement?.clientWidth || window.innerWidth;
      if (!ch) ch = this.container?.clientHeight || this.domElement?.clientHeight || window.innerHeight;
      this.renderer.setScissorTest(false);
      this.renderer.setViewport(0, 0, Math.max(1, cw), Math.max(1, ch));
      this.renderer.autoClear = false;
      this.renderer.clear();

      // Render 3D Scene
      if (this.rasterRenderer) {
        this.rasterRenderer.renderFrame({
          scene: this.scene,
          camera: this.camera,
          delta,
        });
      } else {
        this.renderer.render(this.scene, this.camera);
      }

      // Render Navigation Gizmo ViewHelper on top (scaled/hidden consistently on small viewports)
      if (this.viewHelper?.visible && !(typeof window !== 'undefined' && window.cameraManager?.lookingThrough)) {
        if (!this.viewHelper.isViewHelper && typeof this.viewHelper.render === 'function') {
          if (this.viewHelper.animating) this.viewHelper.update?.(delta);
          this.viewHelper.render(this.renderer);
        } else {
          const dim = this._getViewHelperDim(cw, ch, false);
          if (dim > 0) {
            if (this.viewHelper.animating) {
              this.viewHelper.update?.(delta);
            }
            if (dim === 128 && typeof this.viewHelper.render === 'function') {
              this.viewHelper.render(this.renderer);
            } else {
              this._renderPaneViewHelper({ viewHelper: this.viewHelper, sceneCameraObj: null }, this.camera, 0, 0, cw, ch, false, delta);
              this.renderer.setViewport(0, 0, Math.max(1, cw), Math.max(1, ch));
            }
          }
        }
      }
    }

    const renderElapsedSec = ((typeof performance !== 'undefined' ? performance.now() : Date.now()) - renderT0) / 1000;
    this.lastRenderMs = renderElapsedSec * 1000;
    this.viewportGovernor?.recordFrame?.(renderElapsedSec);

    if (this._afterRenderCallbacks?.size > 0) {
      this._afterRenderCallbacks.forEach((cb) => {
        try { cb(delta); } catch (_) {}
      });
    }
  }

  _syncCameraAspect(cam, aspect) {
    if (!cam || !Number.isFinite(aspect) || aspect <= 0) return;
    if (cam.isOrthographicCamera) {
      const halfHeight = (cam.top - cam.bottom) / 2 || 5;
      const desiredLeft = -halfHeight * aspect;
      const desiredRight = halfHeight * aspect;
      if (Math.abs(cam.left - desiredLeft) > 1e-4 || Math.abs(cam.right - desiredRight) > 1e-4) {
        cam.left = desiredLeft;
        cam.right = desiredRight;
        cam.updateProjectionMatrix();
      }
    } else if (Math.abs((cam.aspect || 1) - aspect) > 1e-4) {
      cam.aspect = aspect;
      cam.updateProjectionMatrix();
    }
  }

  _renderPaneViewHelper(pane, camera, vx, vy, vw, vh, isMulti = true, delta = 0.016) {
    const vhObj = pane?.viewHelper;
    if (!vhObj || !vhObj.visible || pane.sceneCameraObj) return;
    const dim = this._getViewHelperDim(vw, vh, isMulti);
    if (dim <= 0) return;

    if (vhObj.animating && isMulti) vhObj.update?.(delta);

    vhObj.quaternion.copy(camera.quaternion).invert();
    vhObj.updateMatrixWorld(true);

    const pt = new THREE.Vector3(0, 0, 1).applyQuaternion(camera.quaternion);
    for (const child of vhObj.children) {
      const tag = child.userData?.type;
      if (!tag || !child.material) continue;
      if (tag === 'posX') child.material.opacity = pt.x >= 0 ? 1 : 0.5;
      else if (tag === 'negX') child.material.opacity = pt.x >= 0 ? 0.5 : 1;
      else if (tag === 'posY') child.material.opacity = pt.y >= 0 ? 1 : 0.5;
      else if (tag === 'negY') child.material.opacity = pt.y >= 0 ? 0.5 : 1;
      else if (tag === 'posZ') child.material.opacity = pt.z >= 0 ? 1 : 0.5;
      else if (tag === 'negZ') child.material.opacity = pt.z >= 0 ? 0.5 : 1;
    }

    this.renderer.clearDepth();
    this.renderer.setViewport(vx + vw - dim, vy, dim, dim);
    this.renderer.render(vhObj, this._viewHelperOrthoCam);
  }

  _renderMultiAreas(delta) {
    if (!this.renderer || !this.domElement) return;
    const canvasRect = this.domElement.getBoundingClientRect();
    if (!canvasRect.width || !canvasRect.height) return;

    const panes = this.areaManager.getViewportPanes();
    this.renderer.autoClear = false;
    this.renderer.setScissorTest(false);
    this.renderer.setViewport(0, 0, canvasRect.width, canvasRect.height);
    this.renderer.clear(true, true, true);

    if (panes.length === 0) return;

    const prevTcCam = this.transformControls?.camera;
    const prevTcVis = this.transformControls?.visible;
    const prevGridVis = this.grid?.visible;

    this.renderer.setScissorTest(true);
    try {
      for (const pane of panes) {
        const r = pane.viewportEl?.getBoundingClientRect?.();
        if (!r || r.width < 2 || r.height < 2) continue;

        const vx = Math.max(0, Math.round(r.left - canvasRect.left));
        const vw = Math.max(1, Math.round(r.width));
        const vh = Math.max(1, Math.round(r.height));
        const vy = Math.max(0, Math.round(canvasRect.bottom - r.bottom));

        let renderCam = pane.camera;
        let camEntry = null;
        let prevHelperVis = false;
        const wireSnapshots = [];

        if (pane.sceneCameraObj && typeof window !== 'undefined' && window.cameraManager) {
          camEntry = window.cameraManager.getCameraEntry(pane.sceneCameraObj);
          if (camEntry?.camera) {
            renderCam = camEntry.camera;
            prevHelperVis = Boolean(camEntry.helper?.visible);
            window.cameraManager._setCameraPartsVisible?.(camEntry, false);
            if (camEntry.helper) camEntry.helper.visible = false;
          }
        }
        if (!renderCam) continue;

        try {
          this._syncCameraAspect(renderCam, vw / vh);
          renderCam.updateMatrixWorld(true);

          if (this.grid) {
            this.grid.visible = Boolean(prevGridVis) && pane.showGrid !== false;
          }
          if (this.transformControls) {
            this.transformControls.visible = Boolean(prevTcVis) && pane.showGizmo !== false;
            this.transformControls.camera = renderCam;
            this.transformControls.updateMatrixWorld?.();
          }

          if (pane.shadingMode === 'wireframe' || pane.shadingMode === 'solid') {
            const wantWire = pane.shadingMode === 'wireframe';
            this.scene.traverse((obj) => {
              if (obj.isMesh && obj.material && !obj.userData?.isSystemObject) {
                const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
                for (const m of mats) {
                  if (m && typeof m.wireframe === 'boolean' && m.wireframe !== wantWire) {
                    wireSnapshots.push([m, m.wireframe]);
                    m.wireframe = wantWire;
                  }
                }
              }
            });
          }

          this.renderer.setViewport(vx, vy, vw, vh);
          this.renderer.setScissor(vx, vy, vw, vh);
          this.renderer.clear(true, true, true);
          this.renderer.render(this.scene, renderCam);
          this._renderPaneViewHelper(pane, renderCam, vx, vy, vw, vh);
        } finally {
          for (let i = 0; i < wireSnapshots.length; i++) {
            wireSnapshots[i][0].wireframe = wireSnapshots[i][1];
          }
          if (camEntry && window.cameraManager) {
            window.cameraManager._setCameraPartsVisible?.(camEntry, true);
            if (camEntry.helper) camEntry.helper.visible = prevHelperVis;
          }
        }
      }
    } finally {
      this.renderer.setScissorTest(false);
      if (this.grid && prevGridVis !== undefined) this.grid.visible = prevGridVis;
      if (this.transformControls) {
        if (prevTcVis !== undefined) this.transformControls.visible = prevTcVis;
        if (prevTcCam) {
          this.transformControls.camera = prevTcCam;
          this.transformControls.updateMatrixWorld?.();
        }
      }
    }
  }

  /**
   * Registers a callback executed before rendering a frame.
   * Pass `{ passive: true }` or `{ isActive: () => boolean }` so idle scenes can pause rendering.
   * @param {Function} callback (delta) => void
   * @param {Object} [options]
   * @returns {Function} unregister function
   */
  addRenderCallback(callback, options = {}) {
    this.renderCallbacks.add(callback);
    if (options && (options.passive || typeof options.isActive === 'function')) {
      this._renderCallbackMeta.set(callback, options);
    }
    this.requestRender();
    return () => {
      this.renderCallbacks.delete(callback);
      this._renderCallbackMeta.delete(callback);
    };
  }

  onAfterRender(callback) {
    this._afterRenderCallbacks.add(callback);
    return () => this._afterRenderCallbacks.delete(callback);
  }

  // ==========================================
  // RESIZE & UTILITIES
  // ==========================================

  /**
   * Sets Tone Mapping mode (agx, aces, reinhard, cineon, linear, none)
   */
  setToneMapping(mode, exposure = null) {
    if (!this.renderer) return;
    const mapping = {
      'agx': THREE.AgXToneMapping,
      'aces': THREE.ACESFilmicToneMapping,
      'reinhard': THREE.ReinhardToneMapping,
      'cineon': THREE.CineonToneMapping,
      'linear': THREE.LinearToneMapping,
      'none': THREE.NoToneMapping
    };
    if (typeof mode === 'string' && mapping[mode.toLowerCase()] !== undefined) {
      this.renderer.toneMapping = mapping[mode.toLowerCase()];
    } else if (typeof mode === 'number') {
      this.renderer.toneMapping = mode;
    }
    if (exposure !== null && !isNaN(exposure)) {
      this.renderer.toneMappingExposure = exposure;
    }
    if (this.scene) {
      this.scene.traverse((child) => {
        if (child.isMesh && child.material) {
          if (Array.isArray(child.material)) {
            child.material.forEach(m => m.needsUpdate = true);
          } else {
            child.material.needsUpdate = true;
          }
        }
      });
    }
  }

  getToneMapping() {
    if (!this.renderer) return 'none';
    const rev = {
      [THREE.AgXToneMapping]: 'AgX (Blender 4.x Default)',
      [THREE.ACESFilmicToneMapping]: 'ACES Filmic',
      [THREE.ReinhardToneMapping]: 'Reinhard',
      [THREE.CineonToneMapping]: 'Cineon',
      [THREE.LinearToneMapping]: 'Linear',
      [THREE.NoToneMapping]: 'None'
    };
    return rev[this.renderer.toneMapping] || 'Custom';
  }

  onResize() {
    if (!this.renderer || !this.camera || !this.container) return;
    if (this._renderOverrideSize) return;

    const width = this.container.clientWidth || window.innerWidth;
    const height = this.container.clientHeight || window.innerHeight;

    if (width === 0 || height === 0) return;

    const aspect = width / height;
    const viewportCameras = new Set([this.camera, this.perspectiveCamera, this.orthographicCamera]);
    for (const camera of viewportCameras) {
      if (camera.isOrthographicCamera) {
        const halfHeight = (camera.top - camera.bottom) / 2;
        camera.left = -halfHeight * aspect;
        camera.right = halfHeight * aspect;
      } else {
        camera.aspect = aspect;
      }
      camera.updateProjectionMatrix();
    }
    if (this.areaManager && !this.areaManager.isSingleFullViewport()) {
      for (const pane of this.areaManager.getViewportPanes()) {
        const pr = pane.viewportEl?.getBoundingClientRect?.();
        if (pr && pr.width > 0 && pr.height > 0) {
          const pAspect = pr.width / pr.height;
          this._syncCameraAspect(pane.perspectiveCamera, pAspect);
          this._syncCameraAspect(pane.orthographicCamera, pAspect);
        }
      }
    }
    if (typeof window !== 'undefined' && window.cameraManager) {
      window.cameraManager.updateAllAspects();
    }

    const pr = this._getViewportPixelRatio();
    this.renderer.setSize(width, height);
    this.renderer.setPixelRatio(pr);
    if (this.rasterRenderer) {
      this.rasterRenderer.setSize(width, height, pr);
    }
    this.requestRender();
  }

  /**
   * Captures high quality screenshot of current viewport
   * @param {string} [mimeType='image/png']
   * @param {number} [quality=0.95]
   * @returns {string} data URL
   */
  takeScreenshot(mimeType = 'image/png', quality = 0.95) {
    if (this.rasterRenderer) {
      return this.rasterRenderer.captureStill(this.scene, this.camera, {
        mimeType,
        quality,
        helpersToHide: [this.transformControls, this.selectionBox],
      });
    }

    // Hide helpers temporarily
    const prevGizmoVisible = this.transformControls ? this.transformControls.visible : false;
    const prevBoxVisible = this.selectionBox ? this.selectionBox.visible : false;

    if (this.transformControls) this.transformControls.visible = false;
    if (this.selectionBox) this.selectionBox.visible = false;

    this.renderer.render(this.scene, this.camera);
    const dataUrl = this.domElement.toDataURL(mimeType, quality);

    // Restore helpers
    if (this.transformControls) this.transformControls.visible = prevGizmoVisible;
    if (this.selectionBox) this.selectionBox.visible = prevBoxVisible;

    return dataUrl;
  }

  // ==========================================
  // CLEANUP & DISPOSE
  // ==========================================

  dispose() {
    this.stop();
    this.instancingSystem?.stopFoliageBrush?.();
    this.viewportGovernor?.detach?.();

    // Remove event listeners
    if (this.domElement) {
      this.domElement.removeEventListener('pointerdown', this._boundOnPointerDown);
      this.domElement.removeEventListener('pointermove', this._boundOnPointerMove);
      this.domElement.removeEventListener('pointerup', this._boundOnPointerUp);
    }
    window.removeEventListener('keydown', this._boundOnKeyDown);
    window.removeEventListener('resize', this._boundOnResize);
    if (this._boundOnWindowBlur) {
      window.removeEventListener('blur', this._boundOnWindowBlur);
    }
    if (typeof document !== 'undefined' && this._boundOnVisibilityChange) {
      document.removeEventListener('visibilitychange', this._boundOnVisibilityChange);
    }
    if (this._boundRequestRedraw) {
      window.removeEventListener('blender:viewportCameraChanged', this._boundRequestRedraw);
      window.removeEventListener('blender:cameraViewChanged', this._boundRequestRedraw);
    }
    if (this._boundRequestShadowRedraw) {
      window.removeEventListener('blender:geometryChanged', this._boundRequestShadowRedraw);
      window.removeEventListener('blender:sceneUpdated', this._boundRequestShadowRedraw);
      window.removeEventListener('blender:mode-changed', this._boundRequestShadowRedraw);
      window.removeEventListener('blender:objectTransformed', this._boundRequestShadowRedraw);
    }

    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
    }

    if (this.transformControls) {
      this.transformControls.dispose();
    }
    if (this.controls) {
      this.controls.dispose();
    }
    if (this.viewHelper && typeof this.viewHelper.dispose === 'function') {
      this.viewHelper.dispose();
    }
    if (this.selectionBox) {
      this.selectionBox.geometry?.dispose?.();
      this.selectionBox.material?.dispose?.();
    }
    if (this.grid) {
      this.grid.traverse?.((node) => {
        node.geometry?.dispose?.();
        if (Array.isArray(node.material)) node.material.forEach((m) => m?.dispose?.());
        else node.material?.dispose?.();
      });
    }
    if (this.rasterRenderer) {
      this.rasterRenderer.dispose();
      this.rasterRenderer = null;
    }
    if (this.renderer) {
      this.renderer.dispose();
      if (this.domElement && this.domElement.parentNode) {
        this.domElement.parentNode.removeChild(this.domElement);
      }
    }

    this.renderCallbacks.clear();
    this._renderCallbackMeta.clear();
    this._afterRenderCallbacks.clear();
  }
}
