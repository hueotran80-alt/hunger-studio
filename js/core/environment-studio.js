/**
 * @file environment-studio.js
 * @description Advanced Lighting & Environment Studio System for Web Blender Studio.
 * Provides:
 * 1. HDRI Image-Based Lighting (IBL) & Environment Reflection via THREE.PMREMGenerator:
 *    - "Studio Softbox 3-Point" (Crisp product lighting & car paint reflections)
 *    - "Golden Sunset Sky" (Warm sunset with violet shadows & golden specular)
 *    - "Cyberpunk Neon City" (Sci-fi night city with cyan & magenta neon accents)
 *    - "Industrial Warehouse" (Factory skylights & high-contrast metal reflections)
 *    - Supports Environment Intensity, Background Blurriness, and HDRI Rotation.
 * 2. Dynamic Sky Dome: Sun Elevation (0-90°), Azimuth (0-360°), Turbidity, Rayleigh scattering
 *    with automatic real-time synchronization to directional sunlight & ambient warmth.
 * 3. Atmospheric / Depth Fog: Volumetric distance falloff with custom color & thematic presets
 *    (Neutral Studio, Daytime Haze, Sunset Dusk, Cyberpunk Neon, Dense Mist).
 * 4. Seamless Studio Cyclorama (Cyc Wall): Mathematically smooth curved studio photography
 *    infinity backdrop that catches soft contact shadows and diffuse ambient bounce.
 */

import * as THREE from 'three';
import { createProceduralHdriTexture } from '../render/procedural-hdri.js';

export class EnvironmentStudio {
  /**
   * @param {Object} options
   * @param {THREE.Scene} options.scene
   * @param {THREE.Camera} options.camera
   * @param {THREE.WebGLRenderer} [options.renderer]
   * @param {Object} [options.lights] Key light, fill light, ambient light references
   */
  constructor(options = {}) {
    this.scene = options.scene;
    this.camera = options.camera;
    this.renderer = options.renderer || null;
    this.lights = options.lights || null;

    // Default background color (Blender dark gray)
    this.defaultBgColor = new THREE.Color(0x282828);

    // =========================================================================
    // 1. HDRI IMAGE-BASED LIGHTING (IBL) & ENVIRONMENT REFLECTION STATE
    // =========================================================================
    this.hdriEnabled = true;
    this.currentHdriPreset = 'studio-softbox';
    this.environmentIntensity = 1.0;
    this.backgroundBlurriness = 0.15;
    this.environmentRotation = 0; // in degrees (0 - 360)
    this.showHdriBackground = false;

    this.pmremGenerator = null;
    this._envMapCache = new Map();
    this._pmremTargetCache = new Map();
    this._hdriCanvases = new Map();
    this._hdriHalfFloatCache = new Map();
    this.customHdrSource = null;
    this.customHdrTexture = null;
    this.customHdrPmremTarget = null;
    this._activeRawSource = null;
    this._activeBaseEnvMap = null;
    this._activeEnvMap = null;
    this._rotatedEquirectTarget = null;
    this._rotatedPmremTarget = null;
    this._rotScene = null;
    this._rotCam = null;
    this._rotMat = null;

    // Shadow Catcher state
    this.shadowCatcherEnabled = false;
    this.shadowCatcherOpacity = 0.45;
    this.shadowCatcherMesh = null;

    this.hdriPresets = {
      'studio-softbox': {
        name: 'Studio Softbox 3-Point',
        icon: '💡',
        category: 'Studio',
        description: 'Product photography studio lighting with crisp white softboxes reflecting cleanly on metals and car paint'
      },
      'golden-sunset': {
        name: 'Golden Sunset Sky',
        icon: '🌅',
        category: 'Outdoor',
        description: 'Vibrant sunset sky with warm golden and twilight purple reflections'
      },
      'cyberpunk-neon': {
        name: 'Cyberpunk Neon City',
        icon: '🏙️',
        category: 'Sci-Fi',
        description: 'Sci-fi night cityscape with cyan and magenta neon lighting'
      },
      'industrial-warehouse': {
        name: 'Industrial Warehouse',
        icon: '🏭',
        category: 'Interior',
        description: 'Industrial warehouse with overhead skylights and brushed-metal reflections'
      }
    };

    // =========================================================================
    // 2. SKY DOME STATE
    // =========================================================================
    this.skyEnabled = false;
    this.skyMesh = null;
    this.skyParams = {
      elevation: 35,     // Degrees (0 to 90)
      azimuth: 180,      // Degrees (0 to 360)
      turbidity: 8.0,
      rayleigh: 2.0,
      mieCoefficient: 0.005,
      mieDirectionalG: 0.8
    };

    // =========================================================================
    // 3. FOG STATE
    // =========================================================================
    this.fogEnabled = false;
    this.fogPresets = {
      'studio': {
        name: 'Neutral Studio',
        color: '#282828',
        near: 35,
        far: 190
      },
      'day': {
        name: 'Daytime Haze',
        color: '#98b8d4',
        near: 20,
        far: 140
      },
      'sunset': {
        name: 'Sunset Golden Hour',
        color: '#703726',
        near: 15,
        far: 105
      },
      'cyberpunk': {
        name: 'Cyberpunk Neon Night',
        color: '#130c26',
        near: 12,
        far: 90
      },
      'dense-mist': {
        name: 'Dense Mist',
        color: '#a0acb5',
        near: 6,
        far: 65
      }
    };
    this.currentFogPreset = 'studio';
    this.fogParams = {
      color: '#282828',
      near: 35,
      far: 190
    };

    // =========================================================================
    // 4. STUDIO CYCLORAMA BACKDROP STATE
    // =========================================================================
    this.backdropEnabled = false;
    this.backdropMesh = null;
    this.backdropPresets = {
      'blender-dark': { name: 'Blender Dark Studio', color: '#2b2d30', roughness: 0.75 },
      'pure-white':   { name: 'Pure White Studio',   color: '#f0f2f5', roughness: 0.65 },
      'warm-cream':   { name: 'Warm Cream',          color: '#e8ded2', roughness: 0.70 },
      'cyber-dark':   { name: 'Cyber Minimalist',    color: '#0d1017', roughness: 0.60 },
      'chroma-green': { name: 'Chroma Key Green',    color: '#00af3f', roughness: 0.80 },
      'neutral-gray': { name: 'Neutral Gray',        color: '#46494f', roughness: 0.75 }
    };
    this.currentBackdropPreset = 'blender-dark';
    this.backdropColor = '#2b2d30';

    // Event listeners
    this.listeners = new Map();

    // Initialize cyclorama geometry & material
    this._initBackdropMesh();

    // Try initializing HDRI if renderer is already provided or available
    this._tryInitHdri();
  }

  /**
   * Sets renderer reference and re-initializes PMREMGenerator if needed
   * @param {THREE.WebGLRenderer} renderer
   */
  setRenderer(renderer) {
    if (!renderer) return;
    this.renderer = renderer;
    if (this.pmremGenerator) {
      try { this.pmremGenerator.dispose(); } catch (_) {}
      this.pmremGenerator = null;
    }
    this._getPMREMGenerator();
    if (this.hdriEnabled) {
      this.setHdriPreset(this.currentHdriPreset, true);
    }
  }

  /**
   * Internal helper to retrieve or lazily create PMREMGenerator
   * @private
   */
  _getPMREMGenerator() {
    if (!this.pmremGenerator) {
      const rend = this.renderer ||
        (typeof window !== 'undefined' && (window.engine?.renderer || window.app?.engine?.renderer));
      if (rend) {
        this.renderer = rend;
        this.pmremGenerator = new THREE.PMREMGenerator(rend);
        this.pmremGenerator.compileEquirectangularShader();
      }
    }
    return this.pmremGenerator;
  }

  /**
   * Attempts initial HDRI setup
   * @private
   */
  _tryInitHdri() {
    // Schedule on next tick to allow engine and window.engine to finish mounting
    setTimeout(() => {
      if (this.hdriEnabled) {
        this.setHdriPreset(this.currentHdriPreset);
      }
    }, 50);
  }

  // =========================================================================
  // HDRI IMAGE-BASED LIGHTING (IBL) API & PROCEDURAL ENVIRONMENT GENERATOR
  // =========================================================================

  /**
   * Returns list of available HDRI environment presets
   * @returns {Array<Object>}
   */
  getAvailableHdriPresets() {
    return Object.entries(this.hdriPresets).map(([id, info]) => ({
      id,
      ...info
    }));
  }

  /**
   * Enables or disables HDRI environment reflections in scene
   * @param {boolean} enabled
   */
  enableHdri(enabled) {
    this.hdriEnabled = !!enabled;
    if (this.hdriEnabled) {
      this.setHdriPreset(this.currentHdriPreset);
    } else {
      if (this.scene) {
        this.scene.environment = null;
        if (this.showHdriBackground) {
          this.scene.background = this.defaultBgColor.clone();
        }
      }
    }
    this._emit('hdriChanged', { enabled: this.hdriEnabled, preset: this.currentHdriPreset });
  }

  /**
   * Loads an external .hdr or .exr environment map file via RGBELoader/EXRLoader and PMREMGenerator
   * @param {File|Blob|string} fileOrUrl - Local File object, Blob, or URL
   * @returns {Promise<THREE.Texture>}
   */
  async loadHDRFile(fileOrUrl) {
    const THREE = this.THREE || (typeof window !== 'undefined' ? window.THREE : null);
    if (!THREE) throw new Error('THREE is not available');

    const fileName = typeof fileOrUrl === 'string'
      ? fileOrUrl.split('?')[0].toLowerCase()
      : String(fileOrUrl?.name || '').toLowerCase();
    const isExr = fileName.endsWith('.exr');

    let LoaderClass = null;
    try {
      if (isExr) {
        const mod = await import('three/addons/loaders/EXRLoader.js');
        LoaderClass = mod.EXRLoader;
      } else {
        const mod = await import('three/addons/loaders/RGBELoader.js');
        LoaderClass = mod.RGBELoader;
      }
    } catch (e) {
      if (typeof window !== 'undefined') {
        LoaderClass = isExr ? window.EXRLoader : window.RGBELoader;
      }
    }

    if (!LoaderClass) {
      console.warn(`[EnvironmentStudio] ${isExr ? 'EXRLoader' : 'RGBELoader'} not found, using procedural HDRI fallback`);
      return this.setHdriPreset('studio-softbox');
    }

    let url = fileOrUrl;
    let needsRevoke = false;
    const persistentHdrUrl = typeof fileOrUrl === 'string' && !fileOrUrl.startsWith('blob:') ? fileOrUrl : null;
    if (fileOrUrl instanceof Blob || (typeof File !== 'undefined' && fileOrUrl instanceof File)) {
      url = URL.createObjectURL(fileOrUrl);
      needsRevoke = true;
    }

    const loader = new LoaderClass();
    return new Promise((resolve, reject) => {
      loader.load(
        url,
        (hdrTexture) => {
          if (needsRevoke) URL.revokeObjectURL(url);
          this.customHdrUrl = persistentHdrUrl;
          if (this.customHdrSource && this.customHdrSource !== hdrTexture) {
            try { this.customHdrSource.dispose(); } catch (_) {}
          }
          if (this.customHdrPmremTarget) {
            try { this.customHdrPmremTarget.dispose(); } catch (_) {}
            this.customHdrPmremTarget = null;
          }
          this.customHdrSource = hdrTexture;
          this._activeRawSource = hdrTexture;

          const pmrem = this._getPMREMGenerator();
          if (pmrem) {
            const rt = pmrem.fromEquirectangular(hdrTexture);
            this.customHdrPmremTarget = rt;
            const envMap = rt.texture;
            this.customHdrTexture = envMap;
            this._activeBaseEnvMap = envMap;
            this._activeEnvMap = envMap;
            if (this.scene) {
              this.scene.userData = this.scene.userData || {};
              this.scene.userData.rawEnvironmentSource = hdrTexture;
            }
            this.hdriEnabled = true;
            this._applyEnvironmentMap(envMap);
            this._emit('hdriChanged', { enabled: true, custom: true });
            resolve(this._activeEnvMap || envMap);
          } else {
            this.customHdrTexture = hdrTexture;
            this._activeBaseEnvMap = hdrTexture;
            this._activeEnvMap = hdrTexture;
            if (this.scene) {
              this.scene.environment = hdrTexture;
              this.scene.userData = this.scene.userData || {};
              this.scene.userData.rawEnvironmentSource = hdrTexture;
              if (this.showHdriBackground) {
                this.scene.background = hdrTexture;
              }
            }
            this.hdriEnabled = true;
            resolve(hdrTexture);
          }
        },
        undefined,
        (err) => {
          if (needsRevoke) URL.revokeObjectURL(url);
          console.error('[EnvironmentStudio] Failed to load HDR/EXR:', err);
          reject(err);
        }
      );
    });
  }

  loadHdr(fileOrUrl) {
    return this.loadHDRFile(fileOrUrl);
  }

  /**
   * Sets the active HDRI environment preset and applies pre-filtered radiance map
   * using the unified HalfFloat HDR source shared with Path Tracing.
   * @param {string} presetKey 'studio-softbox' | 'golden-sunset' | 'cyberpunk-neon' | 'industrial-warehouse'
   * @param {boolean} [forceRebuild=false]
   */
  setHdriPreset(presetKey, forceRebuild = false) {
    const normKey = String(presetKey).replace(/_/g, '-');
    if (!this.hdriPresets[normKey]) {
      console.warn(`[EnvironmentStudio] Unknown HDRI preset: ${presetKey}`);
      return;
    }

    this.currentHdriPreset = normKey;
    this.customHdrUrl = null;
    if (this.customHdrPmremTarget) {
      try { this.customHdrPmremTarget.dispose(); } catch (_) {}
      this.customHdrPmremTarget = null;
    }
    if (this.customHdrSource) {
      try { this.customHdrSource.dispose(); } catch (_) {}
      this.customHdrSource = null;
    }
    this.customHdrTexture = null;
    this.hdriEnabled = true;

    let halfFloatTex = this._hdriHalfFloatCache.get(normKey);
    if (!halfFloatTex || forceRebuild) {
      if (halfFloatTex) {
        try { halfFloatTex.dispose(); } catch (_) {}
      }
      try {
        halfFloatTex = createProceduralHdriTexture({ preset: normKey, width: 512, height: 256, THREE });
        this._hdriHalfFloatCache.set(normKey, halfFloatTex);
      } catch (err) {
        console.warn('[EnvironmentStudio] HalfFloat HDRI generation fallback:', err);
      }
    }

    let envMap = !forceRebuild ? this._envMapCache.get(normKey) : null;
    if (!envMap || forceRebuild) {
      const prevRt = this._pmremTargetCache.get(normKey);
      if (prevRt) {
        try { prevRt.dispose(); } catch (_) {}
        this._pmremTargetCache.delete(normKey);
      }
      const prevCached = this._envMapCache.get(normKey);
      if (prevCached && prevCached !== halfFloatTex) {
        try { prevCached.dispose(); } catch (_) {}
      }

      const sourceTex = halfFloatTex || (() => {
        const canvas = this._getOrCreateHdriCanvas(normKey);
        const tex = new THREE.CanvasTexture(canvas);
        tex.mapping = THREE.EquirectangularReflectionMapping;
        if (THREE.SRGBColorSpace) tex.colorSpace = THREE.SRGBColorSpace;
        return tex;
      })();

      const pmrem = this._getPMREMGenerator();
      if (pmrem) {
        try {
          const renderTarget = pmrem.fromEquirectangular(sourceTex);
          envMap = renderTarget.texture;
          this._pmremTargetCache.set(normKey, renderTarget);
          this._envMapCache.set(normKey, envMap);
        } catch (err) {
          console.warn('[EnvironmentStudio] PMREMGenerator error, using raw texture fallback:', err);
          envMap = sourceTex;
          this._envMapCache.set(normKey, envMap);
        }
      } else {
        envMap = sourceTex;
        this._envMapCache.set(normKey, envMap);
      }
    }

    this._activeRawSource = halfFloatTex || envMap;
    this._activeBaseEnvMap = envMap;

    if (this.scene) {
      this.scene.userData = this.scene.userData || {};
      this.scene.userData.rawEnvironmentSource = halfFloatTex || this._getOrCreateHdriCanvas(normKey);
      this.scene.userData.environmentIntensity = this.environmentIntensity;
      this.scene.userData.environmentRotation = this.environmentRotation;
    }

    this._applyEnvironmentMap(envMap);
    this._emit('hdriPresetChanged', { preset: normKey, ...this.hdriPresets[normKey] });
  }

  /**
   * Applies environment map to scene and synchronizes material reflections
   * @private
   */
  _applyEnvironmentMap(envMap) {
    if (!this.scene || !envMap) return;

    this._activeBaseEnvMap = envMap;
    this._activeEnvMap = envMap;
    this.scene.environment = envMap;

    // Apply rotation (updates scene.environment/background when rotated on WebGL)
    this._applyEnvironmentRotation(this.environmentRotation);

    // Apply intensity
    this.setEnvironmentIntensity(this.environmentIntensity);

    // Viewport background handling
    const activeEnv = this._activeEnvMap || envMap;
    if (this.showHdriBackground) {
      this.scene.background = activeEnv;
      if (this.scene.backgroundBlurriness !== undefined) {
        this.scene.backgroundBlurriness = this.backgroundBlurriness;
      }
      if (this.scene.backgroundIntensity !== undefined) {
        this.scene.backgroundIntensity = this.environmentIntensity;
      }
    } else if (!this.skyEnabled && !this.fogEnabled) {
      this.scene.background = this.defaultBgColor.clone();
    }

    if (typeof window !== 'undefined' && window.engine?.sceneManager?.requestRender) {
      window.engine.sceneManager.requestRender();
    }
  }

  /**
   * Adjusts environment IBL reflection intensity without recompiling material shaders.
   * @param {number} intensity (0.0 to 3.0+)
   */
  setEnvironmentIntensity(intensity) {
    this.environmentIntensity = Math.max(0, Number(intensity));

    if (this.scene) {
      this.scene.userData = this.scene.userData || {};
      this.scene.userData.environmentIntensity = this.environmentIntensity;

      if (this.scene.environmentIntensity !== undefined) {
        this.scene.environmentIntensity = this.environmentIntensity;
      }
      if (this.showHdriBackground && this.scene.backgroundIntensity !== undefined) {
        this.scene.backgroundIntensity = this.environmentIntensity;
      }

      // envMapIntensity is a WebGL uniform — update cleanly without setting m.needsUpdate = true
      this.scene.traverse((child) => {
        if (child.isMesh && child.material) {
          const mats = Array.isArray(child.material) ? child.material : [child.material];
          for (let i = 0; i < mats.length; i++) {
            const m = mats[i];
            if (m && (m.isMeshStandardMaterial || m.isMeshPhysicalMaterial)) {
              m.envMapIntensity = this.environmentIntensity;
            }
          }
        }
      });
    }

    if (typeof window !== 'undefined' && window.engine?.sceneManager?.requestRender) {
      window.engine.sceneManager.requestRender();
    }
    this._emit('environmentChanged', { type: 'intensity', intensity: this.environmentIntensity });
  }

  /**
   * Sets background blurriness when HDRI is shown as viewport background
   * @param {number} blur (0.0 = sharp, 1.0 = completely blurred)
   */
  setBackgroundBlurriness(blur) {
    this.backgroundBlurriness = Math.min(1.0, Math.max(0.0, Number(blur)));

    if (this.scene && this.showHdriBackground) {
      if (this.scene.backgroundBlurriness !== undefined) {
        this.scene.backgroundBlurriness = this.backgroundBlurriness;
      }
      if (typeof window !== 'undefined' && window.engine?.sceneManager?.requestRender) {
        window.engine.sceneManager.requestRender();
      }
    }

    this._emit('environmentChanged', { type: 'blurriness', blur: this.backgroundBlurriness });
  }

  /**
   * Rotates HDRI environment map along Y axis (azimuth)
   * @param {number} degrees (0 to 360)
   */
  setEnvironmentRotation(degrees) {
    const d = Number(degrees) || 0;
    this.environmentRotation = ((d % 360) + 360) % 360;
    this._applyEnvironmentRotation(this.environmentRotation);
    if (typeof window !== 'undefined' && window.engine?.sceneManager?.requestRender) {
      window.engine.sceneManager.requestRender();
    }
    this._emit('environmentChanged', { type: 'rotation', rotation: this.environmentRotation });
  }

  /**
   * Renders a UV-shifted equirectangular HDR texture + PMREM on WebGL so HDRI Y-rotation
   * visibly updates both IBL reflections and background in Three.js r160.
   * @private
   */
  _bakeRotatedPmrem(rawTex, rad) {
    const pmrem = this._getPMREMGenerator();
    const renderer = this.renderer;
    if (!pmrem || !renderer || !rawTex) return null;

    try {
      const w = Math.max(64, Math.min(1024, rawTex.image?.width || 512));
      const h = Math.max(32, Math.min(512, rawTex.image?.height || 256));
      if (!this._rotatedEquirectTarget || this._rotatedEquirectTarget.width !== w || this._rotatedEquirectTarget.height !== h) {
        if (this._rotatedEquirectTarget) {
          try { this._rotatedEquirectTarget.dispose(); } catch (_) {}
        }
        this._rotatedEquirectTarget = new THREE.WebGLRenderTarget(w, h, {
          type: THREE.HalfFloatType,
          format: THREE.RGBAFormat,
          minFilter: THREE.LinearFilter,
          magFilter: THREE.LinearFilter,
          depthBuffer: false,
          stencilBuffer: false,
          generateMipmaps: false,
        });
        this._rotatedEquirectTarget.texture.mapping = THREE.EquirectangularReflectionMapping;
      }

      if (!this._rotScene) {
        this._rotCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
        this._rotMat = new THREE.ShaderMaterial({
          uniforms: {
            tSource: { value: null },
            uShift: { value: 0 },
            uFlipY: { value: 0 },
          },
          vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
          fragmentShader: `
            uniform sampler2D tSource;
            uniform float uShift;
            uniform float uFlipY;
            varying vec2 vUv;
            void main() {
              float u = fract(vUv.x - uShift);
              float v = mix(vUv.y, 1.0 - vUv.y, uFlipY);
              gl_FragColor = texture2D(tSource, vec2(u, v));
            }
          `,
          depthTest: false,
          depthWrite: false,
          toneMapped: false,
        });
        const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this._rotMat);
        quad.frustumCulled = false;
        this._rotScene = new THREE.Scene();
        this._rotScene.add(quad);
      }

      this._rotMat.uniforms.tSource.value = rawTex;
      this._rotMat.uniforms.uShift.value = rad / (Math.PI * 2.0);
      this._rotMat.uniforms.uFlipY.value = rawTex.flipY ? 1.0 : 0.0;

      const prevTarget = renderer.getRenderTarget();
      const prevAutoClear = renderer.autoClear;
      renderer.setRenderTarget(this._rotatedEquirectTarget);
      renderer.autoClear = false;
      renderer.clear();
      renderer.render(this._rotScene, this._rotCam);
      renderer.autoClear = prevAutoClear;
      renderer.setRenderTarget(prevTarget);

      if (this._rotatedPmremTarget) {
        try { this._rotatedPmremTarget.dispose(); } catch (_) {}
        this._rotatedPmremTarget = null;
      }
      this._rotatedPmremTarget = pmrem.fromEquirectangular(this._rotatedEquirectTarget.texture);
      return this._rotatedPmremTarget.texture;
    } catch (_) {
      return null;
    }
  }

  /**
   * @private
   */
  _applyEnvironmentRotation(degrees) {
    if (!this.scene) return;
    const rad = THREE.MathUtils.degToRad(degrees);

    this.scene.userData = this.scene.userData || {};
    this.scene.userData.environmentRotation = degrees;

    if (!this.scene.environmentRotation) {
      this.scene.environmentRotation = new THREE.Euler(0, rad, 0);
    } else {
      this.scene.environmentRotation.y = rad;
    }
    if (!this.scene.backgroundRotation) {
      this.scene.backgroundRotation = new THREE.Euler(0, rad, 0);
    } else {
      this.scene.backgroundRotation.y = rad;
    }

    let resolvedEnv = this._activeBaseEnvMap || this.customHdrTexture || this._envMapCache.get(this.currentHdriPreset);
    if (this.hdriEnabled && this._activeRawSource && Math.abs(degrees % 360) > 0.01) {
      const rotated = this._bakeRotatedPmrem(this._activeRawSource, rad);
      if (rotated) resolvedEnv = rotated;
    }

    if (resolvedEnv) {
      this._activeEnvMap = resolvedEnv;
      if (this.hdriEnabled) {
        this.scene.environment = resolvedEnv;
        if (this.showHdriBackground) {
          this.scene.background = resolvedEnv;
        }
      }
    }
  }

  /**
   * Toggles showing the HDRI map as the viewport background
   * @param {boolean} show
   */
  toggleHdriBackground(show) {
    this.showHdriBackground = !!show;
    if (this.showHdriBackground) {
      const envMap = this._activeEnvMap || this.customHdrTexture || this._envMapCache.get(this.currentHdriPreset);
      if (envMap && this.scene) {
        this.scene.background = envMap;
        if (this.scene.backgroundBlurriness !== undefined) {
          this.scene.backgroundBlurriness = this.backgroundBlurriness;
        }
        if (this.scene.backgroundIntensity !== undefined) {
          this.scene.backgroundIntensity = this.environmentIntensity;
        }
      }
    } else if (this.scene) {
      if (this.skyEnabled && this.skyMesh) {
        // sky dome takes over background
      } else if (this.fogEnabled) {
        this.scene.background = new THREE.Color(this.fogParams.color);
      } else {
        this.scene.background = this.defaultBgColor.clone();
      }
    }
    if (typeof window !== 'undefined' && window.engine?.sceneManager?.requestRender) {
      window.engine.sceneManager.requestRender();
    }
    this._emit('environmentChanged', { type: 'showBackground', show: this.showHdriBackground });
  }

  // =========================================================================
  // HIGH-FIDELITY PROCEDURAL HDRI EQUIRECTANGULAR CANVASES
  // =========================================================================

  /**
   * Returns or generates an offscreen equirectangular canvas for a preset
   * @private
   */
  _getOrCreateHdriCanvas(presetKey) {
    if (this._hdriCanvases.has(presetKey)) {
      return this._hdriCanvases.get(presetKey);
    }

    const width = 1024;
    const height = 512;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');

    switch (presetKey) {
      case 'studio-softbox':
        this._drawStudioSoftbox(ctx, width, height);
        break;
      case 'golden-sunset':
        this._drawGoldenSunset(ctx, width, height);
        break;
      case 'cyberpunk-neon':
        this._drawCyberpunkNeon(ctx, width, height);
        break;
      case 'industrial-warehouse':
        this._drawIndustrialWarehouse(ctx, width, height);
        break;
      default:
        this._drawStudioSoftbox(ctx, width, height);
    }

    this._hdriCanvases.set(presetKey, canvas);
    return canvas;
  }

  /**
   * 1. Studio Softbox 3-Point: Professional product photography studio
   * Key softbox, fill softbox, overhead strip light, and reflective studio floor
   * @private
   */
  _drawStudioSoftbox(ctx, w, h) {
    // 1. Base Studio Wall/Floor Gradient
    const bgGrad = ctx.createLinearGradient(0, 0, 0, h);
    bgGrad.addColorStop(0.0, '#101215');
    bgGrad.addColorStop(0.35, '#202328');
    bgGrad.addColorStop(0.50, '#2e3239'); // Horizon line
    bgGrad.addColorStop(0.55, '#1e2126');
    bgGrad.addColorStop(1.0, '#0c0d10');
    ctx.fillStyle = bgGrad;
    ctx.fillRect(0, 0, w, h);

    // Subtle horizon ambient glow
    const horizGrad = ctx.createLinearGradient(0, h * 0.45, 0, h * 0.55);
    horizGrad.addColorStop(0.0, 'rgba(255,255,255,0.0)');
    horizGrad.addColorStop(0.5, 'rgba(200,215,230,0.12)');
    horizGrad.addColorStop(1.0, 'rgba(0,0,0,0.0)');
    ctx.fillStyle = horizGrad;
    ctx.fillRect(0, h * 0.45, w, h * 0.10);

    // 2. Key Light: Large softbox at azimuth ~45° (X ~ 140), elevation ~35° (Y ~ 150)
    const kx = w * 0.22;
    const ky = h * 0.32;
    const kw = w * 0.16;
    const kh = h * 0.22;

    // Softbox diffuse halo
    const kHalo = ctx.createRadialGradient(kx + kw / 2, ky + kh / 2, kh * 0.2, kx + kw / 2, ky + kh / 2, kw * 1.2);
    kHalo.addColorStop(0.0, 'rgba(255, 255, 255, 0.45)');
    kHalo.addColorStop(0.5, 'rgba(220, 235, 255, 0.18)');
    kHalo.addColorStop(1.0, 'rgba(220, 235, 255, 0.0)');
    ctx.fillStyle = kHalo;
    ctx.fillRect(kx - kw, ky - kh, kw * 3, kh * 3);

    // Softbox panel: luminous white with soft edge
    const kBox = ctx.createLinearGradient(kx, ky, kx + kw, ky + kh);
    kBox.addColorStop(0.0, '#ffffff');
    kBox.addColorStop(0.5, '#f5f8ff');
    kBox.addColorStop(1.0, '#e0e8f5');
    ctx.fillStyle = kBox;
    this._drawRoundedRect(ctx, kx, ky, kw, kh, 8);
    ctx.fill();

    // 3. Fill Light: Medium softbox at azimuth ~240° (X ~ 680), elevation ~40°
    const fx = w * 0.68;
    const fy = h * 0.35;
    const fw = w * 0.13;
    const fh = h * 0.18;

    const fHalo = ctx.createRadialGradient(fx + fw / 2, fy + fh / 2, fh * 0.2, fx + fw / 2, fy + fh / 2, fw * 1.1);
    fHalo.addColorStop(0.0, 'rgba(180, 210, 255, 0.30)');
    fHalo.addColorStop(1.0, 'rgba(180, 210, 255, 0.0)');
    ctx.fillStyle = fHalo;
    ctx.fillRect(fx - fw, fy - fh, fw * 3, fh * 3);

    const fBox = ctx.createLinearGradient(fx, fy, fx + fw, fy + fh);
    fBox.addColorStop(0.0, '#d8e6f8');
    fBox.addColorStop(1.0, '#a5c0e2');
    ctx.fillStyle = fBox;
    this._drawRoundedRect(ctx, fx, fy, fw, fh, 6);
    ctx.fill();

    // 4. Overhead Rim / Strip Light: Long horizontal strip light overhead (zenith area)
    const sx = w * 0.38;
    const sy = h * 0.09;
    const sw = w * 0.28;
    const sh = h * 0.045;

    const sHalo = ctx.createRadialGradient(sx + sw / 2, sy + sh / 2, sh * 0.5, sx + sw / 2, sy + sh / 2, sw * 0.7);
    sHalo.addColorStop(0.0, 'rgba(255, 255, 255, 0.5)');
    sHalo.addColorStop(1.0, 'rgba(255, 255, 255, 0.0)');
    ctx.fillStyle = sHalo;
    ctx.fillRect(sx - sw * 0.3, sy - sh * 3, sw * 1.6, sh * 7);

    ctx.fillStyle = '#ffffff';
    this._drawRoundedRect(ctx, sx, sy, sw, sh, 4);
    ctx.fill();

    // 5. Floor contact reflections of softboxes (diffuse bounce)
    ctx.fillStyle = 'rgba(255, 255, 255, 0.08)';
    ctx.fillRect(kx, h * 0.62, kw, kh * 0.4);
    ctx.fillStyle = 'rgba(180, 210, 255, 0.05)';
    ctx.fillRect(fx, h * 0.65, fw, fh * 0.35);
  }

  /**
   * 2. Golden Sunset Sky: Warm sunset with rich amber highlights and violet twilight
   * @private
   */
  _drawGoldenSunset(ctx, w, h) {
    // 1. Atmospheric Sky Gradient (top down to horizon)
    const skyGrad = ctx.createLinearGradient(0, 0, 0, h);
    skyGrad.addColorStop(0.0, '#0d1330');  // Zenith night indigo
    skyGrad.addColorStop(0.20, '#221a48'); // Violet twilight
    skyGrad.addColorStop(0.35, '#682552'); // Crimson rose
    skyGrad.addColorStop(0.46, '#c43d22'); // Warm amber orange
    skyGrad.addColorStop(0.52, '#ff9922'); // Horizon blazing gold
    skyGrad.addColorStop(0.55, '#3a1b12'); // Dark horizon ground
    skyGrad.addColorStop(0.70, '#15101a'); // Dark cool earth
    skyGrad.addColorStop(1.0, '#09070d');  // Nadir
    ctx.fillStyle = skyGrad;
    ctx.fillRect(0, 0, w, h);

    // 2. Horizon Golden Glow Band
    const horizGlow = ctx.createLinearGradient(0, h * 0.45, 0, h * 0.58);
    horizGlow.addColorStop(0.0, 'rgba(255, 170, 50, 0.0)');
    horizGlow.addColorStop(0.4, 'rgba(255, 200, 90, 0.55)');
    horizGlow.addColorStop(0.6, 'rgba(255, 120, 20, 0.35)');
    horizGlow.addColorStop(1.0, 'rgba(0, 0, 0, 0.0)');
    ctx.fillStyle = horizGlow;
    ctx.fillRect(0, h * 0.45, w, h * 0.13);

    // 3. Low Sun Disk on Horizon (Azimuth 180° = center of panorama)
    const sunX = w * 0.50;
    const sunY = h * 0.50;

    // Atmospheric wide corona bloom
    const corona = ctx.createRadialGradient(sunX, sunY, 15, sunX, sunY, w * 0.38);
    corona.addColorStop(0.0, 'rgba(255, 240, 200, 0.95)');
    corona.addColorStop(0.15, 'rgba(255, 170, 40, 0.65)');
    corona.addColorStop(0.40, 'rgba(230, 70, 20, 0.30)');
    corona.addColorStop(0.80, 'rgba(120, 30, 50, 0.08)');
    corona.addColorStop(1.0, 'rgba(0, 0, 0, 0.0)');
    ctx.fillStyle = corona;
    ctx.fillRect(sunX - w * 0.4, sunY - h * 0.4, w * 0.8, h * 0.8);

    // Intense bright core of the sun
    const sunCore = ctx.createRadialGradient(sunX, sunY, 0, sunX, sunY, 28);
    sunCore.addColorStop(0.0, '#ffffff');
    sunCore.addColorStop(0.5, '#fff4cc');
    sunCore.addColorStop(0.85, '#ffaa33');
    sunCore.addColorStop(1.0, 'rgba(255, 170, 50, 0.0)');
    ctx.fillStyle = sunCore;
    ctx.beginPath();
    ctx.arc(sunX, sunY, 28, 0, Math.PI * 2);
    ctx.fill();

    // 4. Golden water/ground specular trail
    const waterTrail = ctx.createLinearGradient(sunX - 60, sunY, sunX + 60, sunY);
    waterTrail.addColorStop(0.0, 'rgba(255, 170, 40, 0.0)');
    waterTrail.addColorStop(0.5, 'rgba(255, 220, 140, 0.45)');
    waterTrail.addColorStop(1.0, 'rgba(255, 170, 40, 0.0)');
    ctx.fillStyle = waterTrail;
    ctx.fillRect(sunX - 70, sunY, 140, h * 0.35);

    // Scattered twilight clouds
    ctx.fillStyle = 'rgba(70, 25, 55, 0.35)';
    this._drawRoundedRect(ctx, w * 0.15, h * 0.38, w * 0.22, 14, 7);
    ctx.fill();
    this._drawRoundedRect(ctx, w * 0.68, h * 0.42, w * 0.20, 12, 6);
    ctx.fill();
  }

  /**
   * 3. Cyberpunk Neon City: Sci-fi night skyline with electric cyan and hot magenta neon glows
   * @private
   */
  _drawCyberpunkNeon(ctx, w, h) {
    // 1. Dark Midnight City Atmosphere
    const darkGrad = ctx.createLinearGradient(0, 0, 0, h);
    darkGrad.addColorStop(0.0, '#04060d');  // Midnight zenith
    darkGrad.addColorStop(0.40, '#0a0d1c'); // Smog skyline
    darkGrad.addColorStop(0.52, '#120b22'); // Street level horizon
    darkGrad.addColorStop(0.60, '#060810'); // Wet asphalt
    darkGrad.addColorStop(1.0, '#020306');
    ctx.fillStyle = darkGrad;
    ctx.fillRect(0, 0, w, h);

    // 2. Distant Skyscraper Silhouettes along horizon
    ctx.fillStyle = '#070914';
    const numBuildings = 32;
    for (let i = 0; i < numBuildings; i++) {
      const bx = (i / numBuildings) * w;
      const bw = (w / numBuildings) * 0.92;
      const bh = (0.08 + Math.sin(i * 3.7) * 0.06 + Math.cos(i * 1.3) * 0.05) * h;
      ctx.fillRect(bx, h * 0.52 - bh, bw, bh);
    }

    // 3. Electric Cyan Neon Tower Cluster (Left Side, Azimuth ~75°)
    const cyanX = w * 0.22;
    const cyanGlow = ctx.createRadialGradient(cyanX, h * 0.35, 10, cyanX, h * 0.35, w * 0.25);
    cyanGlow.addColorStop(0.0, 'rgba(0, 242, 254, 0.65)');
    cyanGlow.addColorStop(0.4, 'rgba(0, 180, 216, 0.25)');
    cyanGlow.addColorStop(1.0, 'rgba(0, 180, 216, 0.0)');
    ctx.fillStyle = cyanGlow;
    ctx.fillRect(cyanX - w * 0.3, 0, w * 0.6, h * 0.65);

    // Cyan vertical neon columns
    const cyanStrips = [cyanX - 45, cyanX - 15, cyanX + 25, cyanX + 60];
    cyanStrips.forEach((cx, idx) => {
      const sh = (0.24 + (idx % 2) * 0.08) * h;
      const sy = h * 0.52 - sh;

      // Glow halo
      ctx.fillStyle = 'rgba(0, 242, 254, 0.35)';
      ctx.fillRect(cx - 4, sy, 14, sh);

      // Core filament
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(cx, sy, 6, sh);
    });

    // 4. Hot Magenta / Neon Pink Cluster (Right Side, Azimuth ~285°)
    const magX = w * 0.76;
    const magGlow = ctx.createRadialGradient(magX, h * 0.35, 10, magX, h * 0.35, w * 0.25);
    magGlow.addColorStop(0.0, 'rgba(255, 0, 128, 0.65)');
    magGlow.addColorStop(0.4, 'rgba(217, 4, 103, 0.22)');
    magGlow.addColorStop(1.0, 'rgba(217, 4, 103, 0.0)');
    ctx.fillStyle = magGlow;
    ctx.fillRect(magX - w * 0.3, 0, w * 0.6, h * 0.65);

    // Magenta vertical neon columns
    const magStrips = [magX - 50, magX - 10, magX + 30, magX + 70];
    magStrips.forEach((mx, idx) => {
      const sh = (0.22 + ((idx + 1) % 2) * 0.09) * h;
      const sy = h * 0.52 - sh;

      ctx.fillStyle = 'rgba(255, 0, 128, 0.35)';
      ctx.fillRect(mx - 4, sy, 14, sh);

      ctx.fillStyle = '#ffffff';
      ctx.fillRect(mx, sy, 6, sh);
    });

    // 5. Wet Street Puddle Reflections on Ground
    // Cyan wet road streaks
    const cyanPuddle = ctx.createLinearGradient(cyanX - 60, 0, cyanX + 60, 0);
    cyanPuddle.addColorStop(0.0, 'rgba(0, 242, 254, 0.0)');
    cyanPuddle.addColorStop(0.5, 'rgba(0, 242, 254, 0.35)');
    cyanPuddle.addColorStop(1.0, 'rgba(0, 242, 254, 0.0)');
    ctx.fillStyle = cyanPuddle;
    ctx.fillRect(cyanX - 80, h * 0.52, 160, h * 0.40);

    // Magenta wet road streaks
    const magPuddle = ctx.createLinearGradient(magX - 60, 0, magX + 60, 0);
    magPuddle.addColorStop(0.0, 'rgba(255, 0, 128, 0.0)');
    magPuddle.addColorStop(0.5, 'rgba(255, 0, 128, 0.35)');
    magPuddle.addColorStop(1.0, 'rgba(255, 0, 128, 0.0)');
    ctx.fillStyle = magPuddle;
    ctx.fillRect(magX - 80, h * 0.52, 160, h * 0.40);
  }

  /**
   * 4. Industrial Warehouse: Steel warehouse rafters, daylight skylights & warm high-bay lamps
   * @private
   */
  _drawIndustrialWarehouse(ctx, w, h) {
    // 1. Concrete & Steel Interior Walls Gradient
    const indGrad = ctx.createLinearGradient(0, 0, 0, h);
    indGrad.addColorStop(0.0, '#15181c');  // Steel truss ceiling
    indGrad.addColorStop(0.40, '#22272e'); // Factory wall
    indGrad.addColorStop(0.52, '#282d35'); // Horizon floor seam
    indGrad.addColorStop(0.65, '#191b20'); // Damp concrete
    indGrad.addColorStop(1.0, '#0f1114');  // Lower floor
    ctx.fillStyle = indGrad;
    ctx.fillRect(0, 0, w, h);

    // 2. Ceiling Steel Truss Grid
    ctx.strokeStyle = '#121417';
    ctx.lineWidth = 3;
    for (let x = 0; x < w; x += 48) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x + 24, h * 0.42);
      ctx.stroke();
    }

    // 3. Arched Ceiling Skylights (Bright Daylight Opening)
    const numSkylights = 6;
    for (let i = 0; i < numSkylights; i++) {
      const sw = w * 0.09;
      const sh = h * 0.12;
      const sx = (i + 0.5) * (w / numSkylights) - sw / 2;
      const sy = h * 0.14;

      // Daylight glow
      const sHalo = ctx.createRadialGradient(sx + sw / 2, sy + sh / 2, sh * 0.2, sx + sw / 2, sy + sh / 2, sw * 1.1);
      sHalo.addColorStop(0.0, 'rgba(240, 248, 255, 0.65)');
      sHalo.addColorStop(0.5, 'rgba(210, 230, 255, 0.20)');
      sHalo.addColorStop(1.0, 'rgba(210, 230, 255, 0.0)');
      ctx.fillStyle = sHalo;
      ctx.fillRect(sx - sw * 0.5, sy - sh * 0.5, sw * 2, sh * 2);

      // Skylight glass pane
      const glass = ctx.createLinearGradient(sx, sy, sx, sy + sh);
      glass.addColorStop(0.0, '#ffffff');
      glass.addColorStop(0.5, '#eef6ff');
      glass.addColorStop(1.0, '#cce0ff');
      ctx.fillStyle = glass;
      this._drawRoundedRect(ctx, sx, sy, sw, sh, 4);
      ctx.fill();

      // Window cross-bars
      ctx.strokeStyle = '#22252a';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(sx + sw / 2, sy);
      ctx.lineTo(sx + sw / 2, sy + sh);
      ctx.moveTo(sx, sy + sh / 2);
      ctx.lineTo(sx + sw, sy + sh / 2);
      ctx.stroke();
    }

    // 4. Warm Hanging Pendant Lamps (Tungsten/Sodium Accents)
    const numLamps = 5;
    for (let i = 0; i < numLamps; i++) {
      const lx = (i + 0.8) * (w / numLamps);
      const ly = h * 0.32;

      // Warm amber glow
      const lGlow = ctx.createRadialGradient(lx, ly, 2, lx, ly, 38);
      lGlow.addColorStop(0.0, 'rgba(255, 190, 80, 0.9)');
      lGlow.addColorStop(0.4, 'rgba(255, 140, 40, 0.35)');
      lGlow.addColorStop(1.0, 'rgba(255, 140, 40, 0.0)');
      ctx.fillStyle = lGlow;
      ctx.beginPath();
      ctx.arc(lx, ly, 38, 0, Math.PI * 2);
      ctx.fill();

      // Lamp bulb
      ctx.fillStyle = '#fff4d6';
      ctx.beginPath();
      ctx.arc(lx, ly, 5, 0, Math.PI * 2);
      ctx.fill();
    }

    // 5. Polished Industrial Concrete Floor Reflections
    const floorGrad = ctx.createLinearGradient(0, h * 0.52, 0, h);
    floorGrad.addColorStop(0.0, 'rgba(210, 230, 255, 0.12)');
    floorGrad.addColorStop(0.3, 'rgba(210, 230, 255, 0.05)');
    floorGrad.addColorStop(1.0, 'rgba(0, 0, 0, 0.0)');
    ctx.fillStyle = floorGrad;
    ctx.fillRect(0, h * 0.52, w, h * 0.48);
  }

  /**
   * Helper to draw rounded rectangle on 2D canvas
   * @private
   */
  _drawRoundedRect(ctx, x, y, width, height, radius) {
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.lineTo(x + width - radius, y);
    ctx.quadraticCurveTo(x + width, y, x + width, y + radius);
    ctx.lineTo(x + width, y + height - radius);
    ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
    ctx.lineTo(x + radius, y + height);
    ctx.quadraticCurveTo(x, y + height, x, y + height - radius);
    ctx.lineTo(x, y + radius);
    ctx.quadraticCurveTo(x, y, x + radius, y);
    ctx.closePath();
  }

  // =========================================================================
  // DYNAMIC SKY DOME & SUNLIGHT
  // =========================================================================

  /**
   * Toggles dynamic Sky Dome
   * @param {boolean} enabled
   * @param {Object} [params]
   */
  enableSky(enabled, params = {}) {
    this.skyEnabled = !!enabled;
    Object.assign(this.skyParams, params);

    if (this.skyEnabled) {
      if (!this.skyMesh) {
        this._createSkyDomeMesh();
      }
      if (this.skyMesh && !this.scene.children.includes(this.skyMesh)) {
        this.scene.add(this.skyMesh);
      }
      if (this.skyMesh) {
        this.skyMesh.visible = true;
      }
      this.updateSunPosition();
    } else {
      if (this.skyMesh) {
        this.skyMesh.visible = false;
      }
      // Restore background
      if (this.showHdriBackground && this.hdriEnabled) {
        const envMap = this._envMapCache.get(this.currentHdriPreset);
        if (envMap) this.scene.background = envMap;
      } else if (!this.fogEnabled) {
        this.scene.background = this.defaultBgColor.clone();
      } else {
        this.scene.background = new THREE.Color(this.fogParams.color);
      }
      // Reset sunlight to standard studio angle
      this._resetStudioLighting();
    }

    this._emit('environmentChanged', { type: 'sky', enabled: this.skyEnabled });
  }

  /**
   * Updates sun position and synchronizes lighting
   * @param {Object} [params] { elevation, azimuth, turbidity, rayleigh }
   */
  setSunPosition(params = {}) {
    Object.assign(this.skyParams, params);
    this.updateSunPosition();
  }

  setSkyElevation(elevation) {
    this.enableSky(true);
    this.setSunPosition({ elevation: Number(elevation) });
  }

  setSkyAzimuth(azimuth) {
    this.enableSky(true);
    this.setSunPosition({ azimuth: Number(azimuth) });
  }

  /**
   * Computes spherical coordinates and updates shader uniforms + directional key light
   */
  updateSunPosition() {
    const { elevation, azimuth } = this.skyParams;

    const phi = THREE.MathUtils.degToRad(90 - elevation);
    const theta = THREE.MathUtils.degToRad(azimuth);

    const sunDirection = new THREE.Vector3().setFromSphericalCoords(1, phi, theta);

    // Update Sky Shader uniforms if active
    if (this.skyMesh && this.skyMesh.material && this.skyMesh.material.uniforms) {
      const u = this.skyMesh.material.uniforms;
      if (u.sunPosition) u.sunPosition.value.copy(sunDirection);
      if (u.turbidity) u.turbidity.value = this.skyParams.turbidity;
      if (u.rayleigh) u.rayleigh.value = this.skyParams.rayleigh;
      if (u.mieCoefficient) u.mieCoefficient.value = this.skyParams.mieCoefficient;
      if (u.mieDirectionalG) u.mieDirectionalG.value = this.skyParams.mieDirectionalG;
    }

    // Synchronize KeyLight / Sun Light in Scene
    if (this.lights && this.lights.keyLight) {
      const dist = 30;
      this.lights.keyLight.position.copy(sunDirection).multiplyScalar(dist);

      if (elevation <= 2) {
        this.lights.keyLight.color.setHex(0xff5522);
        this.lights.keyLight.intensity = 0.8;
      } else if (elevation < 15) {
        const t = (elevation - 2) / 13;
        this.lights.keyLight.color.lerpColors(new THREE.Color(0xff6622), new THREE.Color(0xffaa44), t);
        this.lights.keyLight.intensity = 1.3;
      } else if (elevation < 45) {
        const t = (elevation - 15) / 30;
        this.lights.keyLight.color.lerpColors(new THREE.Color(0xffbb66), new THREE.Color(0xfff5ea), t);
        this.lights.keyLight.intensity = 1.8;
      } else {
        this.lights.keyLight.color.setHex(0xffffff);
        this.lights.keyLight.intensity = 2.0;
      }
    }

    if (this.lights && this.lights.ambient) {
      if (elevation < 10) {
        this.lights.ambient.color.setHex(0x5a485c);
        this.lights.ambient.intensity = 0.35;
      } else {
        this.lights.ambient.color.setHex(0xffffff);
        this.lights.ambient.intensity = 0.45;
      }
    }
  }

  /**
   * Builds procedural Sky Dome mesh with high quality atmospheric gradient shader
   * @private
   */
  _createSkyDomeMesh() {
    const vertexShader = `
      varying vec3 vWorldPosition;
      void main() {
        vec4 worldPosition = modelMatrix * vec4(position, 1.0);
        vWorldPosition = worldPosition.xyz;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `;

    const fragmentShader = `
      uniform vec3 sunPosition;
      uniform float turbidity;
      uniform float rayleigh;
      uniform float mieCoefficient;
      uniform float mieDirectionalG;
      varying vec3 vWorldPosition;

      void main() {
        vec3 point = normalize(vWorldPosition);
        vec3 sunDir = normalize(sunPosition);

        float cosTheta = max(0.0, point.y);
        float sunY = max(-0.1, sunDir.y);

        float turbFactor = clamp((turbidity - 2.0) / 14.0, 0.0, 1.0);
        float rayleighFactor = clamp(rayleigh / 3.0, 0.25, 1.5);

        vec3 zenithColor = mix(
          vec3(0.05, 0.12, 0.35),
          vec3(0.18, 0.42, 0.82) * rayleighFactor,
          clamp(sunY * 1.5, 0.1, 1.0)
        );
        vec3 horizonColor = mix(
          vec3(0.85, 0.35, 0.15),
          mix(vec3(0.72, 0.82, 0.95), vec3(0.82, 0.78, 0.72), turbFactor),
          clamp(sunY * 2.5, 0.0, 1.0)
        );

        float horizonFactor = pow(1.0 - cosTheta, mix(3.5, 2.2, turbFactor));
        vec3 skyColor = mix(zenithColor, horizonColor, horizonFactor);

        float sunDot = max(0.0, dot(point, sunDir));
        float g = clamp(mieDirectionalG, -0.95, 0.95);
        float g2 = g * g;
        float miePhase = (1.0 - g2) / max(0.02, 4.0 * 3.14159265 * pow(max(0.001, 1.0 + g2 - 2.0 * g * sunDot), 1.5));
        float sunDisc = smoothstep(0.9992, 0.9998, sunDot);
        float sunGlow = pow(sunDot, 64.0) * 0.6 + pow(sunDot, 8.0) * 0.2 + miePhase * clamp(mieCoefficient * 40.0, 0.0, 1.5);

        vec3 sunColor = mix(vec3(1.0, 0.45, 0.1), vec3(1.0, 0.98, 0.9), clamp(sunY * 2.0, 0.1, 1.0));

        vec3 finalColor = skyColor + sunColor * (sunDisc * 3.5 + sunGlow * 0.9);
        gl_FragColor = vec4(finalColor, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `;

    const uniforms = {
      sunPosition: { value: new THREE.Vector3(0, 1, 0) },
      turbidity: { value: this.skyParams.turbidity },
      rayleigh: { value: this.skyParams.rayleigh },
      mieCoefficient: { value: this.skyParams.mieCoefficient },
      mieDirectionalG: { value: this.skyParams.mieDirectionalG }
    };

    const geometry = new THREE.SphereGeometry(800, 32, 16);
    const material = new THREE.ShaderMaterial({
      name: 'Procedural_Sky_Dome_Material',
      vertexShader,
      fragmentShader,
      uniforms,
      side: THREE.BackSide,
      depthWrite: false,
      toneMapped: true,
    });

    this.skyMesh = new THREE.Mesh(geometry, material);
    this.skyMesh.name = 'Procedural_Sky_Dome';
    this.skyMesh.userData.isSystemObject = true;
    this.skyMesh.userData.isRenderableStage = true;
    this.skyMesh.userData.selectable = false;
  }

  /**
   * Resets lighting to standard Blender Studio defaults
   * @private
   */
  _resetStudioLighting() {
    if (this.lights && this.lights.keyLight) {
      this.lights.keyLight.position.set(8, 12, 8);
      this.lights.keyLight.color.setHex(0xfff8ee);
      this.lights.keyLight.intensity = 1.8;
    }
    if (this.lights && this.lights.ambient) {
      this.lights.ambient.color.setHex(0xffffff);
      this.lights.ambient.intensity = 0.45;
    }
  }

  // =========================================================================
  // ATMOSPHERIC / DEPTH FOG
  // =========================================================================

  /**
   * Toggles fog in the scene
   * @param {boolean} enabled
   * @param {Object} [params] { color, near, far }
   */
  enableFog(enabled, params = {}) {
    this.fogEnabled = !!enabled;
    Object.assign(this.fogParams, params);

    if (this.fogEnabled) {
      const fogColor = new THREE.Color(this.fogParams.color);
      this.scene.fog = new THREE.Fog(fogColor, this.fogParams.near, this.fogParams.far);

      if (!this.skyEnabled && !this.showHdriBackground) {
        this.scene.background = fogColor.clone();
      }
    } else {
      this.scene.fog = null;
      if (!this.skyEnabled && !this.showHdriBackground) {
        this.scene.background = this.defaultBgColor.clone();
      }
    }

    this._emit('environmentChanged', { type: 'fog', enabled: this.fogEnabled });
  }

  /**
   * Applies one of the built-in fog presets
   * @param {string} presetKey 'studio' | 'day' | 'sunset' | 'cyberpunk' | 'dense-mist'
   */
  setFogPreset(presetKey) {
    const normKey = String(presetKey).replace(/_/g, '-');
    const preset = this.fogPresets[normKey] || this.fogPresets[presetKey];
    if (!preset) return;

    this.currentFogPreset = normKey;
    this.fogParams.color = preset.color;
    this.fogParams.near = preset.near;
    this.fogParams.far = preset.far;

    this.enableFog(true, this.fogParams);

    this._emit('fogPresetChanged', { preset: normKey, ...preset });
  }

  setAtmosphericFog(presetKey) {
    return this.setFogPreset(presetKey);
  }

  /**
   * Updates fog distance and color values directly
   * @param {Object} params { color, near, far }
   */
  updateFog(params = {}) {
    Object.assign(this.fogParams, params);
    if (this.fogEnabled && this.scene.fog) {
      if (params.color !== undefined) {
        const col = new THREE.Color(params.color);
        this.scene.fog.color.copy(col);
        if (!this.skyEnabled && !this.showHdriBackground) {
          this.scene.background = col.clone();
        }
      }
      if (params.near !== undefined) this.scene.fog.near = Number(params.near);
      if (params.far !== undefined) this.scene.fog.far = Number(params.far);
    }
  }

  // =========================================================================
  // SEAMLESS STUDIO CYCLORAMA (CYC WALL BACKDROP)
  // =========================================================================

  /**
   * Initializes parametric cyclorama geometry
   * Curved L-shaped floor-to-wall profile with smooth circular arc fillet
   * @private
   */
  _initBackdropMesh() {
    const width = 120;
    const floorDepth = 45;
    const curveRadius = 18;
    const wallHeight = 55;

    const widthSegs = 60;
    const depthSegs = 70;

    const geom = new THREE.BufferGeometry();
    const positions = [];
    const uvs = [];
    const indices = [];

    const zSteps = depthSegs;
    const xSteps = widthSegs;

    for (let j = 0; j <= zSteps; j++) {
      const v = j / zSteps;
      let y = 0;
      let z = 0;

      if (v < 0.40) {
        const t = v / 0.40;
        z = floorDepth * (1 - t);
        y = 0;
      } else if (v < 0.75) {
        const t = (v - 0.40) / 0.35;
        const angle = t * (Math.PI / 2);
        z = -Math.sin(angle) * curveRadius;
        y = (1.0 - Math.cos(angle)) * curveRadius;
      } else {
        const t = (v - 0.75) / 0.25;
        z = -curveRadius;
        y = curveRadius + t * wallHeight;
      }

      for (let i = 0; i <= xSteps; i++) {
        const u = i / xSteps;
        const x = (u - 0.5) * width;

        positions.push(x, y, z);
        uvs.push(u, v);
      }
    }

    for (let j = 0; j < zSteps; j++) {
      for (let i = 0; i < xSteps; i++) {
        const a = j * (xSteps + 1) + i;
        const b = (j + 1) * (xSteps + 1) + i;
        const c = (j + 1) * (xSteps + 1) + (i + 1);
        const d = j * (xSteps + 1) + (i + 1);

        indices.push(a, b, d);
        indices.push(b, c, d);
      }
    }

    geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geom.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geom.setIndex(indices);
    geom.computeVertexNormals();

    const mat = new THREE.MeshStandardMaterial({
      name: 'Studio_Backdrop_Material',
      color: new THREE.Color(this.backdropColor),
      roughness: 0.75,
      metalness: 0.03,
      side: THREE.FrontSide
    });

    this.backdropMesh = new THREE.Mesh(geom, mat);
    this.backdropMesh.name = 'Studio_Cyclorama_Backdrop';
    this.backdropMesh.receiveShadow = true;
    this.backdropMesh.castShadow = false;
    this.backdropMesh.userData.isSystemObject = true;
    this.backdropMesh.userData.isRenderableStage = true;
    this.backdropMesh.userData.selectable = false;
    this.backdropMesh.position.set(0, -0.01, 0);
    this.backdropMesh.visible = false;
  }

  // =========================================================================
  // SHADOW CATCHER FLOOR PLANE (E-COMMERCE / COMPOSITING)
  // =========================================================================

  _initShadowCatcherMesh() {
    if (this.shadowCatcherMesh) return this.shadowCatcherMesh;
    const geom = new THREE.PlaneGeometry(80, 80);
    geom.rotateX(-Math.PI / 2);
    const mat = new THREE.ShadowMaterial({ opacity: this.shadowCatcherOpacity });
    mat.name = 'Studio_Shadow_Catcher_Material';
    const mesh = new THREE.Mesh(geom, mat);
    mesh.name = 'Studio_Shadow_Catcher';
    mesh.receiveShadow = true;
    mesh.castShadow = false;
    mesh.position.set(0, -0.002, 0);
    mesh.userData = {
      isSystemObject: true,
      isRenderableStage: true,
      isShadowCatcher: true,
      selectable: false,
    };
    mesh.visible = false;
    this.shadowCatcherMesh = mesh;
    return mesh;
  }

  enableShadowCatcher(enabled, options = {}) {
    this.shadowCatcherEnabled = !!enabled;
    if (Number.isFinite(options.opacity)) {
      this.shadowCatcherOpacity = Math.max(0.05, Math.min(1, Number(options.opacity)));
    }
    const mesh = this._initShadowCatcherMesh();
    mesh.material.opacity = this.shadowCatcherOpacity;
    if (Number.isFinite(options.y)) {
      mesh.position.y = Number(options.y);
    }
    if (this.shadowCatcherEnabled) {
      if (this.scene && !this.scene.children.includes(mesh)) {
        this.scene.add(mesh);
      }
      mesh.visible = true;
    } else {
      mesh.visible = false;
    }
    if (typeof window !== 'undefined' && window.engine?.sceneManager?.requestRender) {
      window.engine.sceneManager.requestRender();
    }
    this._emit('environmentChanged', { type: 'shadowCatcher', enabled: this.shadowCatcherEnabled });
    return this.shadowCatcherEnabled;
  }

  setShadowCatcherOpacity(opacity) {
    this.shadowCatcherOpacity = Math.max(0.05, Math.min(1, Number(opacity) || 0.45));
    if (this.shadowCatcherMesh?.material) {
      this.shadowCatcherMesh.material.opacity = this.shadowCatcherOpacity;
      if (typeof window !== 'undefined' && window.engine?.sceneManager?.requestRender) {
        window.engine.sceneManager.requestRender();
      }
    }
  }

  /**
   * Toggles studio backdrop cyclorama
   * @param {boolean} enabled
   * @param {string} [color]
   */
  enableBackdrop(enabled, color = this.backdropColor) {
    this.backdropEnabled = !!enabled;
    this.backdropColor = color;

    if (this.backdropMesh) {
      if (this.backdropEnabled) {
        if (!this.scene.children.includes(this.backdropMesh)) {
          this.scene.add(this.backdropMesh);
        }
        this.backdropMesh.visible = true;
        this.backdropMesh.material.color.set(this.backdropColor);
      } else {
        this.backdropMesh.visible = false;
      }
    }

    this._emit('environmentChanged', { type: 'backdrop', enabled: this.backdropEnabled });
  }

  /**
   * Keeps the cyclorama from ever blocking the user's view.
   * The wall is only drawn while the camera is in front of it (inside the studio);
   * orbiting behind it or far to the side hides it instead of showing a huge dark slab.
   * @param {THREE.Camera} [camera]
   */
  updateBackdropVisibility(camera = this.camera) {
    const mesh = this.backdropMesh;
    if (!mesh || !camera) return;
    if (!this.backdropEnabled) {
      if (mesh.visible) mesh.visible = false;
      return;
    }
    const p = camera.position;
    const behindWall = p.z < -4;                // wall front face points +Z, curve starts near z=-18
    const outsideSide = Math.abs(p.x) > 55;      // beyond the 120-wide wall
    const tooHigh = p.y > 90;
    const shouldShow = !(behindWall || outsideSide || tooHigh);
    if (mesh.visible !== shouldShow) mesh.visible = shouldShow;
  }

  /**
   * Updates cyclorama color and preset
   * @param {string} colorHex
   * @param {number} [roughness]
   */
  setBackdropColor(colorHex, roughness = 0.75) {
    this.backdropColor = colorHex;
    if (this.backdropMesh && this.backdropMesh.material) {
      this.backdropMesh.material.color.set(colorHex);
      this.backdropMesh.material.roughness = roughness;
    }
  }

  /**
   * Applies a backdrop preset
   * @param {string} presetKey
   */
  setBackdropPreset(presetKey) {
    const normKey = String(presetKey).replace(/_/g, '-');
    const preset = this.backdropPresets[normKey] || this.backdropPresets[presetKey];
    if (!preset) return;

    this.currentBackdropPreset = normKey;
    this.enableBackdrop(true, preset.color);
    this.setBackdropColor(preset.color, preset.roughness);
  }

  // =========================================================================
  // STATE EXPORT & IMPORT
  // =========================================================================

  /**
   * Serializes environment configuration
   * @returns {Object}
   */
  exportConfig() {
    return {
      hdri: {
        enabled: this.hdriEnabled,
        preset: this.currentHdriPreset,
        intensity: this.environmentIntensity,
        blurriness: this.backgroundBlurriness,
        rotation: this.environmentRotation,
        showBackground: this.showHdriBackground
      },
      sky: {
        enabled: this.skyEnabled,
        ...this.skyParams
      },
      fog: {
        enabled: this.fogEnabled,
        preset: this.currentFogPreset,
        ...this.fogParams
      },
      backdrop: {
        enabled: this.backdropEnabled,
        preset: this.currentBackdropPreset,
        color: this.backdropColor
      },
      shadowCatcher: {
        enabled: this.shadowCatcherEnabled,
        opacity: this.shadowCatcherOpacity
      }
    };
  }

  /**
   * Restores environment state from configuration
   * @param {Object} config
   */
  importConfig(config = {}) {
    if (config.hdri) {
      this.hdriEnabled = config.hdri.enabled !== false;
      this.environmentIntensity = config.hdri.intensity ?? 1.0;
      this.backgroundBlurriness = config.hdri.blurriness ?? 0.15;
      this.environmentRotation = config.hdri.rotation ?? 0;
      this.showHdriBackground = !!config.hdri.showBackground;
      if (this.hdriEnabled && config.hdri.preset) {
        this.setHdriPreset(config.hdri.preset);
      } else if (!this.hdriEnabled) {
        this.enableHdri(false);
      }
    }
    if (config.sky) {
      this.enableSky(config.sky.enabled, config.sky);
    }
    if (config.fog) {
      this.enableFog(config.fog.enabled, config.fog);
    }
    if (config.backdrop) {
      this.enableBackdrop(config.backdrop.enabled, config.backdrop.color);
    }
    if (config.shadowCatcher) {
      this.enableShadowCatcher(config.shadowCatcher.enabled, config.shadowCatcher);
    }
  }

  /**
   * Event listener subscription
   * @param {string} event
   * @param {Function} callback
   */
  on(event, callback) {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event).add(callback);
    return () => this.listeners.get(event).delete(callback);
  }

  _emit(event, data) {
    if (this.listeners.has(event)) {
      this.listeners.get(event).forEach(cb => {
        try { cb(data); } catch (e) { console.error('EnvironmentStudio event error:', e); }
      });
    }
  }

  /**
   * Disposes geometries, materials, and PMREM render targets
   */
  dispose() {
    if (this._rotatedPmremTarget) {
      try { this._rotatedPmremTarget.dispose(); } catch (_) {}
      this._rotatedPmremTarget = null;
    }
    if (this._rotatedEquirectTarget) {
      try { this._rotatedEquirectTarget.dispose(); } catch (_) {}
      this._rotatedEquirectTarget = null;
    }
    if (this._rotScene) {
      this._rotScene.traverse((obj) => {
        try { obj.geometry?.dispose(); } catch (_) {}
        try { obj.material?.dispose(); } catch (_) {}
      });
      this._rotScene = null;
      this._rotCam = null;
      this._rotMat = null;
    }
    if (this.customHdrPmremTarget) {
      try { this.customHdrPmremTarget.dispose(); } catch (_) {}
      this.customHdrPmremTarget = null;
    }
    if (this.customHdrSource) {
      try { this.customHdrSource.dispose(); } catch (_) {}
      this.customHdrSource = null;
    }
    if (this.pmremGenerator) {
      try { this.pmremGenerator.dispose(); } catch (_) {}
      this.pmremGenerator = null;
    }
    this._pmremTargetCache.forEach((rt) => {
      try { rt.dispose(); } catch (_) {}
    });
    this._pmremTargetCache.clear();
    this._envMapCache.forEach((tex) => {
      try { tex.dispose(); } catch (_) {}
    });
    this._envMapCache.clear();
    this._hdriHalfFloatCache.forEach((tex) => {
      try { tex.dispose(); } catch (_) {}
    });
    this._hdriHalfFloatCache.clear();
    this._hdriCanvases.clear();

    if (this.skyMesh) {
      this.skyMesh.geometry.dispose();
      this.skyMesh.material.dispose();
      this.scene?.remove(this.skyMesh);
    }
    if (this.backdropMesh) {
      this.backdropMesh.geometry.dispose();
      this.backdropMesh.material.dispose();
      this.scene?.remove(this.backdropMesh);
    }
    if (this.shadowCatcherMesh) {
      this.shadowCatcherMesh.geometry.dispose();
      this.shadowCatcherMesh.material.dispose();
      this.scene?.remove(this.shadowCatcherMesh);
    }
    this.listeners.clear();
  }
}
