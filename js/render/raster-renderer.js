/**
 * Web Blender Studio - Unified Raster Renderer
 * High-fidelity PBR raster frame renderer with post-processing (AO, Bloom, DOF, AgX Tone Mapping),
 * viewport presets (Fast / Studio / Cinematic), still captures, and environment raw source parity.
 * File: js/render/raster-renderer.js
 */

import * as THREE from 'three';
import { PostProcessingManager, POST_PRESETS } from './post-processing.js';

export class RasterRenderer {
  /**
   * @param {Object} options
   * @param {THREE.WebGLRenderer} options.renderer
   * @param {THREE.Scene} options.scene
   * @param {THREE.Camera} options.camera
   * @param {string} [options.preset='studio']
   */
  constructor(options = {}) {
    this.renderer = options.renderer;
    this.scene = options.scene;
    this.camera = options.camera;

    this.preset = options.preset || POST_PRESETS.STUDIO;

    // Post processing pipeline
    this.postProcessing = null;
    if (this.renderer && this.scene && this.camera) {
      try {
        this.postProcessing = new PostProcessingManager({
          renderer: this.renderer,
          scene: this.scene,
          camera: this.camera,
          preset: this.preset,
        });
      } catch (err) {
        console.warn('[RasterRenderer] Could not initialize post processing manager:', err);
        this.postProcessing = null;
      }
    }

    // Configure renderer defaults if available
    this._configureRendererDefaults();
  }

  _configureRendererDefaults() {
    if (!this.renderer) return;

    // Shadow setup
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    // Viewport overlay preservation (ViewHelper gizmo, transform controls)
    this.renderer.autoClear = false;

    // Blender 4.x AgX tone mapping
    if (THREE.AgXToneMapping !== undefined) {
      this.renderer.toneMapping = THREE.AgXToneMapping;
    } else if (THREE.ACESFilmicToneMapping !== undefined) {
      this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    }
    this.renderer.toneMappingExposure = 1.0;
  }

  /**
   * Switches look-dev preset ('fast', 'studio', 'cinematic').
   * @param {string} preset
   */
  setPreset(preset) {
    this.preset = preset;
    if (this.postProcessing) {
      this.postProcessing.applyPreset(preset);
    }
  }

  /**
   * Updates camera and scene references.
   * @param {THREE.Camera} camera
   * @param {THREE.Scene} [scene]
   */
  updateCameraAndScene(camera, scene) {
    this.camera = camera;
    if (scene) this.scene = scene;
    if (this.postProcessing) {
      this.postProcessing.updateCameraAndScene(camera, scene);
    }
  }

  /**
   * Updates render resolution.
   * @param {number} width
   * @param {number} height
   * @param {number} [pixelRatio]
   */
  setSize(width, height, pixelRatio) {
    if (this.postProcessing) {
      this.postProcessing.setSize(width, height, pixelRatio);
    }
  }

  /**
   * Sets environment on scene while preserving the raw equirect source for path-tracing.
   * @param {THREE.Scene} scene
   * @param {Object} options
   * @param {THREE.Texture} options.pmremTexture Pre-filtered radiance map for fast raster IBL
   * @param {THREE.Texture|HTMLCanvasElement|string} [options.rawSource] Unfiltered raw equirect source
   * @param {number} [options.rotation=0] Rotation in radians
   * @param {number} [options.intensity=1.0] Environment lighting intensity
   * @param {boolean} [options.asBackground=false] Also assign to scene.background
   */
  setEnvironment(scene, options = {}) {
    if (!scene) return;
    const {
      pmremTexture = null,
      rawSource = null,
      rotation = 0,
      intensity = 1.0,
      asBackground = false,
    } = options;

    scene.environment = pmremTexture;

    // Three.js r160+ environment rotation and intensity properties (Euler for pathtrace-scene compatibility)
    if (scene.environmentRotation?.isEuler) {
      scene.environmentRotation.y = rotation;
    } else {
      scene.environmentRotation = new THREE.Euler(0, rotation, 0);
    }
    if (scene.environmentIntensity !== undefined) {
      scene.environmentIntensity = intensity;
    }

    if (asBackground && pmremTexture) {
      scene.background = pmremTexture;
      if (scene.backgroundRotation?.isEuler) {
        scene.backgroundRotation.y = rotation;
      } else {
        scene.backgroundRotation = new THREE.Euler(0, rotation, 0);
      }
      if (scene.backgroundIntensity !== undefined) {
        scene.backgroundIntensity = intensity;
      }
    }

    // Preserve raw equirect source in userData for Path-Tracing & Phase 6
    scene.userData = scene.userData || {};
    scene.userData.rawEnvironmentSource = rawSource || pmremTexture;
    scene.userData.environmentRotation = rotation;
    scene.userData.environmentIntensity = intensity;
  }

  /**
   * Renders a single frame. Used for real-time viewport, timeline playback, and frame export.
   * @param {Object} [options]
   * @param {THREE.Scene} [options.scene]
   * @param {THREE.Camera} [options.camera]
   * @param {THREE.WebGLRenderTarget} [options.target=null]
   * @param {number} [options.delta=0.016]
   * @param {boolean} [options.hideHelpers=false]
   * @param {Array<THREE.Object3D>} [options.helpersToHide=[]]
   */
  renderFrame(options = {}) {
    const sc = options.scene || this.scene;
    const cam = options.camera || this.camera;
    const target = options.target || null;
    const delta = options.delta !== undefined ? options.delta : 0.016;
    const hideHelpers = !!options.hideHelpers;
    const helpersToHide = [...(options.helpersToHide || [])];

    if (!this.renderer || !sc || !cam) return;

    // Exports (video frames, stills) must not contain viewport overlays: grid, gizmo, cursor, camera bodies…
    if (hideHelpers) {
      const overlayNames = new Set([
        'Floor_Grid', 'Selection_Helpers', 'ModalTransform_Helpers',
        'Blender_3D_Cursor', 'Blender_Measure_Helper', 'EditMode_GizmoProxy',
        'Camera.Frustum',
      ]);
      const checkAndCollect = (child) => {
        if (!child || !child.visible) return;
        const isStage = Boolean(child.userData?.isRenderableStage) ||
          child.name === 'Studio_Cyclorama_Backdrop' ||
          child.name === 'Procedural_Sky_Dome';
        const isOverlay =
          overlayNames.has(child.name) ||
          child.isTransformControls ||
          child.type === 'TransformControlsGizmo' ||
          child.type === 'TransformControlsPlane' ||
          /Helper$/.test(child.type || '') ||
          (!isStage &&
            child.name !== 'Scene_Collection' &&
            child.userData &&
            (child.userData.isHelper ||
              child.userData.isCameraPart ||
              child.userData.isLightHelper ||
              (child.userData.isSystemObject && (!child.children || child.children.length === 0))));
        if (isOverlay) {
          helpersToHide.push(child);
        }
      };
      if (typeof sc.traverse === 'function') {
        sc.traverse(checkAndCollect);
      } else if (Array.isArray(sc.children)) {
        for (const child of sc.children) checkAndCollect(child);
      }
    }

    // Helper visibility toggle
    const prevVisibilities = new Map();
    if (helpersToHide.length > 0) {
      helpersToHide.forEach((obj) => {
        if (obj) {
          prevVisibilities.set(obj, obj.visible);
          obj.visible = false;
        }
      });
    }

    const prevRenderTarget = this.renderer.getRenderTarget();
    const prevPostCam = this.postProcessing?.camera;
    const prevPostScene = this.postProcessing?.scene;
    const postSwapped = Boolean(
      !target &&
      this.postProcessing &&
      this.postProcessing.enabled &&
      this.preset !== POST_PRESETS.FAST &&
      (cam !== prevPostCam || sc !== prevPostScene)
    );

    try {
      if (target) {
        this.renderer.setRenderTarget(target);
        this.renderer.clear();
        this.renderer.render(sc, cam);
      } else if (this.postProcessing && this.postProcessing.enabled && this.preset !== POST_PRESETS.FAST) {
        if (postSwapped) {
          this.postProcessing.updateCameraAndScene(cam, sc);
        }
        this.postProcessing.render(delta);
      } else {
        // autoClear is disabled for viewport overlays, so clear explicitly (stills/resize).
        this.renderer.clear();
        this.renderer.render(sc, cam);
      }
    } finally {
      if (postSwapped && prevPostCam && prevPostScene) {
        this.postProcessing.updateCameraAndScene(prevPostCam, prevPostScene);
      }
      if (target) {
        this.renderer.setRenderTarget(prevRenderTarget);
      }
      // Restore helper visibility
      prevVisibilities.forEach((vis, obj) => {
        obj.visible = vis;
      });
    }
  }

  /**
   * High-resolution still capture with post-processing and helper hiding.
   * @param {THREE.Scene} scene
   * @param {THREE.Camera} camera
   * @param {Object} [options]
   * @param {number} [options.width]
   * @param {number} [options.height]
   * @param {string} [options.mimeType='image/png']
   * @param {number} [options.quality=0.95]
   * @param {string} [options.preset] Override preset for capture (e.g. 'cinematic')
   * @param {boolean} [options.transparent=false]
   * @param {Array<THREE.Object3D>} [options.helpersToHide=[]]
   * @returns {string} Data URL
   */
  captureStill(scene, camera, options = {}) {
    const sc = scene || this.scene;
    const cam = camera || this.camera;
    const {
      width = null,
      height = null,
      mimeType = 'image/png',
      quality = 0.95,
      preset = this.preset,
      transparent = false,
      helpersToHide = [],
    } = options;

    if (!this.renderer || !sc || !cam) return '';

    const origSize = new THREE.Vector2();
    this.renderer.getSize(origSize);
    const origPixelRatio = typeof this.renderer.getPixelRatio === 'function' ? this.renderer.getPixelRatio() : 1;
    const origPreset = this.preset;
    const origAspect = cam.aspect;
    const origOrthoLeft = cam.left;
    const origOrthoRight = cam.right;
    const origBackground = sc.background;
    const origClearAlpha = typeof this.renderer.getClearAlpha === 'function' ? this.renderer.getClearAlpha() : 1;
    const origClearColor = typeof this.renderer.getClearColor === 'function'
      ? this.renderer.getClearColor(new THREE.Color())
      : null;

    const targetWidth = Math.max(1, Math.floor(width || origSize.x || 1));
    const targetHeight = Math.max(1, Math.floor(height || origSize.y || 1));
    const hasExplicitSize = Boolean(width || height);
    const needsResize = targetWidth !== origSize.x || targetHeight !== origSize.y || (hasExplicitSize && origPixelRatio !== 1);

    try {
      if (preset && preset !== this.preset) {
        this.setPreset(preset);
      }

      if (transparent) {
        sc.background = null;
        if (typeof this.renderer.setClearAlpha === 'function') {
          this.renderer.setClearAlpha(0);
        }
      }

      if (needsResize) {
        if (typeof this.renderer.setPixelRatio === 'function') {
          this.renderer.setPixelRatio(1);
        }
        this.renderer.setSize(targetWidth, targetHeight, false);
        if (this.postProcessing) {
          this.postProcessing.setSize(targetWidth, targetHeight, 1);
        }
        const nextAspect = targetWidth / targetHeight;
        if (cam.isPerspectiveCamera) {
          cam.aspect = nextAspect;
          cam.updateProjectionMatrix();
        } else if (cam.isOrthographicCamera && Number.isFinite(cam.top) && Number.isFinite(cam.bottom)) {
          const halfH = Math.abs(cam.top - cam.bottom) * 0.5;
          const midX = (origOrthoLeft + origOrthoRight) * 0.5;
          cam.left = midX - halfH * nextAspect;
          cam.right = midX + halfH * nextAspect;
          cam.updateProjectionMatrix();
        }
      }

      this.renderFrame({
        scene: sc,
        camera: cam,
        hideHelpers: true,
        helpersToHide,
        delta: 0.016,
      });

      return this.renderer.domElement.toDataURL(mimeType, quality);
    } finally {
      if (transparent) {
        sc.background = origBackground;
        if (typeof this.renderer.setClearColor === 'function' && origClearColor) {
          this.renderer.setClearColor(origClearColor, origClearAlpha);
        } else if (typeof this.renderer.setClearAlpha === 'function') {
          this.renderer.setClearAlpha(origClearAlpha);
        }
      }
      if (needsResize) {
        if (typeof this.renderer.setPixelRatio === 'function') {
          this.renderer.setPixelRatio(origPixelRatio);
        }
        this.renderer.setSize(origSize.x, origSize.y, false);
        if (this.postProcessing) {
          this.postProcessing.setSize(origSize.x, origSize.y, origPixelRatio);
        }
        if (cam.isPerspectiveCamera) {
          cam.aspect = origAspect;
          cam.updateProjectionMatrix();
        } else if (cam.isOrthographicCamera) {
          cam.left = origOrthoLeft;
          cam.right = origOrthoRight;
          cam.updateProjectionMatrix();
        }
      }
      if (origPreset !== this.preset) {
        this.setPreset(origPreset);
      }
    }
  }

  /**
   * Disposes post-processing and renderer references.
   */
  dispose() {
    if (this.postProcessing) {
      this.postProcessing.dispose();
      this.postProcessing = null;
    }
    this.renderer = null;
    this.scene = null;
    this.camera = null;
  }
}
