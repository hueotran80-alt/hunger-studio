/**
 * Web Blender Studio - Post-Processing Pipeline
 * High-fidelity post-processing using EffectComposer, RenderPass, GTAOPass,
 * UnrealBloomPass, BokehPass (DOF), and OutputPass (AgX / ACESFilmic tone mapping).
 * File: js/render/post-processing.js
 */

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { BokehPass } from 'three/addons/postprocessing/BokehPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';

export const POST_PRESETS = {
  FAST: 'fast',
  STUDIO: 'studio',
  CINEMATIC: 'cinematic',
};

export class PostProcessingManager {
  /**
   * @param {Object} options
   * @param {THREE.WebGLRenderer} options.renderer
   * @param {THREE.Scene} options.scene
   * @param {THREE.Camera} options.camera
   * @param {number} [options.width]
   * @param {number} [options.height]
   * @param {string} [options.preset='studio']
   */
  constructor(options = {}) {
    this.renderer = options.renderer;
    this.scene = options.scene;
    this.camera = options.camera;

    this.width = options.width || (this.renderer?.domElement?.clientWidth || 800);
    this.height = options.height || (this.renderer?.domElement?.clientHeight || 600);
    this.pixelRatio = options.pixelRatio || (this.renderer?.getPixelRatio?.() || 1);

    this.currentPreset = options.preset || POST_PRESETS.STUDIO;
    this.enabled = this.currentPreset !== POST_PRESETS.FAST;

    // Settings for passes
    this.settings = {
      ao: {
        enabled: true,
        radius: 0.25,
        distanceExponent: 1.0,
        thickness: 1.0,
        scale: 1.0,
      },
      bloom: {
        enabled: true,
        strength: 0.35,
        radius: 0.4,
        threshold: 0.85,
      },
      dof: {
        enabled: false,
        focus: 5.0,
        aperture: 0.025,
        maxblur: 0.01,
      },
      toneMapping: {
        enabled: true,
      },
    };

    this.composer = null;
    this.renderPass = null;
    this.gtaoPass = null;
    this.bloomPass = null;
    this.bokehPass = null;
    this.outputPass = null;

    if (this.enabled && this.renderer && this.scene && this.camera) {
      this.initComposer();
    }
  }

  /**
   * Initializes or re-initializes the EffectComposer and passes.
   */
  initComposer() {
    this.dispose();

    const w = Math.max(1, Math.floor(this.width));
    const h = Math.max(1, Math.floor(this.height));

    // RenderTarget with HalfFloat HDR precision + WebGL2 MSAA before tonemapping
    const isWebGL2 = Boolean(this.renderer?.capabilities?.isWebGL2);
    const renderTarget = new THREE.WebGLRenderTarget(w * this.pixelRatio, h * this.pixelRatio, {
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      colorSpace: THREE.LinearSRGBColorSpace,
      depthBuffer: true,
      stencilBuffer: false,
      samples: isWebGL2 ? 4 : 0,
    });
    renderTarget.texture.name = 'PostProcessing.RT';

    this.composer = new EffectComposer(this.renderer, renderTarget);
    this.composer.setPixelRatio(this.pixelRatio);
    this.composer.setSize(w, h);

    // 1. Scene Render Pass
    this.renderPass = new RenderPass(this.scene, this.camera);
    this.composer.addPass(this.renderPass);

    // 2. Ground Truth Ambient Occlusion (GTAO) Pass
    try {
      this.gtaoPass = new GTAOPass(this.scene, this.camera, w, h);
      this.gtaoPass.enabled = this.settings.ao.enabled;
      this.gtaoPass.output = GTAOPass.OUTPUT.Default;
      this.gtaoPass.blendIntensity = this.settings.ao.scale;
      this.gtaoPass.updateGtaoMaterial?.({
        radius: this.settings.ao.radius,
        distanceExponent: this.settings.ao.distanceExponent,
        thickness: this.settings.ao.thickness,
        scale: this.settings.ao.scale,
        samples: this.currentPreset === POST_PRESETS.CINEMATIC ? 16 : 8,
      });
      this.composer.addPass(this.gtaoPass);
    } catch (err) {
      console.warn('[PostProcessing] GTAOPass could not be initialized, skipping AO:', err);
      this.gtaoPass = null;
    }

    // 3. Unreal Bloom Pass
    try {
      const bloomRes = new THREE.Vector2(w, h);
      this.bloomPass = new UnrealBloomPass(
        bloomRes,
        this.settings.bloom.strength,
        this.settings.bloom.radius,
        this.settings.bloom.threshold
      );
      this.bloomPass.enabled = this.settings.bloom.enabled;
      this.composer.addPass(this.bloomPass);
    } catch (err) {
      console.warn('[PostProcessing] UnrealBloomPass could not be initialized:', err);
      this.bloomPass = null;
    }

    // 4. Depth of Field (BokehPass)
    try {
      this.bokehPass = new BokehPass(this.scene, this.camera, {
        focus: this.settings.dof.focus,
        aperture: this.settings.dof.aperture,
        maxblur: this.settings.dof.maxblur,
      });
      this.bokehPass.enabled = this.settings.dof.enabled;
      this.composer.addPass(this.bokehPass);
    } catch (err) {
      console.warn('[PostProcessing] BokehPass could not be initialized:', err);
      this.bokehPass = null;
    }

    // 5. Output Pass (AgX / Tone Mapping & Color Space Transfer)
    try {
      this.outputPass = new OutputPass();
      this.composer.addPass(this.outputPass);
    } catch (err) {
      console.warn('[PostProcessing] OutputPass could not be initialized:', err);
      this.outputPass = null;
    }

    this.applyPreset(this.currentPreset);
  }

  /**
   * Switches look-dev preset: 'fast', 'studio', or 'cinematic'.
   * @param {string} preset
   */
  applyPreset(preset) {
    this.currentPreset = preset;

    switch (preset) {
      case POST_PRESETS.FAST:
        this.enabled = false;
        if (this.gtaoPass) this.gtaoPass.enabled = false;
        if (this.bloomPass) this.bloomPass.enabled = false;
        if (this.bokehPass) this.bokehPass.enabled = false;
        break;

      case POST_PRESETS.CINEMATIC:
        this.enabled = true;
        if (!this.composer && this.renderer && this.scene && this.camera) {
          this.initComposer();
          return;
        }
        this.settings.ao.enabled = true;
        this.settings.ao.scale = 1.35;
        this.settings.bloom.enabled = true;
        this.settings.bloom.strength = 0.55;
        this.settings.bloom.radius = 0.5;
        this.settings.bloom.threshold = 0.8;
        this.settings.dof.enabled = true;
        this.settings.dof.aperture = 0.02;

        if (this.gtaoPass) {
          this.gtaoPass.enabled = true;
          this.gtaoPass.blendIntensity = this.settings.ao.scale;
          this.gtaoPass.updateGtaoMaterial?.({
            radius: this.settings.ao.radius,
            distanceExponent: this.settings.ao.distanceExponent,
            thickness: this.settings.ao.thickness,
            scale: this.settings.ao.scale,
            samples: 16,
          });
        }
        if (this.bloomPass) {
          this.bloomPass.enabled = true;
          this.bloomPass.strength = this.settings.bloom.strength;
          this.bloomPass.radius = this.settings.bloom.radius;
          this.bloomPass.threshold = this.settings.bloom.threshold;
        }
        if (this.bokehPass) {
          this.bokehPass.enabled = true;
          this.bokehPass.uniforms.aperture.value = this.settings.dof.aperture;
        }
        break;

      case POST_PRESETS.STUDIO:
      default:
        this.enabled = true;
        if (!this.composer && this.renderer && this.scene && this.camera) {
          this.initComposer();
          return;
        }
        this.settings.ao.enabled = true;
        this.settings.ao.scale = 1.0;
        this.settings.bloom.enabled = true;
        this.settings.bloom.strength = 0.35;
        this.settings.bloom.radius = 0.4;
        this.settings.bloom.threshold = 0.85;
        this.settings.dof.enabled = false;

        if (this.gtaoPass) {
          this.gtaoPass.enabled = true;
          this.gtaoPass.blendIntensity = this.settings.ao.scale;
          this.gtaoPass.updateGtaoMaterial?.({
            radius: this.settings.ao.radius,
            distanceExponent: this.settings.ao.distanceExponent,
            thickness: this.settings.ao.thickness,
            scale: this.settings.ao.scale,
            samples: 8,
          });
        }
        if (this.bloomPass) {
          this.bloomPass.enabled = true;
          this.bloomPass.strength = this.settings.bloom.strength;
          this.bloomPass.radius = this.settings.bloom.radius;
          this.bloomPass.threshold = this.settings.bloom.threshold;
        }
        if (this.bokehPass) this.bokehPass.enabled = false;
        break;
    }
  }

  /**
   * Updates camera and scene references (e.g. after camera switch).
   * @param {THREE.Camera} camera
   * @param {THREE.Scene} [scene]
   */
  updateCameraAndScene(camera, scene) {
    this.camera = camera;
    if (scene) this.scene = scene;

    if (this.renderPass) {
      this.renderPass.camera = camera;
      if (scene) this.renderPass.scene = scene;
    }
    if (this.gtaoPass) {
      this.gtaoPass.camera = camera;
      if (scene) this.gtaoPass.scene = scene;
    }
    if (this.bokehPass) {
      this.bokehPass.camera = camera;
      if (scene) this.bokehPass.scene = scene;
    }
  }

  /**
   * Sets canvas/viewport dimensions.
   * @param {number} width
   * @param {number} height
   * @param {number} [pixelRatio]
   */
  setSize(width, height, pixelRatio) {
    const w = Math.max(1, Math.floor(Number(width) || 1));
    const h = Math.max(1, Math.floor(Number(height) || 1));
    this.width = w;
    this.height = h;
    if (pixelRatio !== undefined) this.pixelRatio = pixelRatio;

    if (this.composer) {
      // composer.setPixelRatio() triggers composer.setSize() at effective (w * pixelRatio, h * pixelRatio);
      // do not call pass.setSize(w, h) afterward or it overrides DPR scaling back to 1x.
      this.composer.setPixelRatio(this.pixelRatio);
      this.composer.setSize(w, h);
    }
  }

  /**
   * Configures parameters of specific passes.
   * @param {Object} options
   */
  configurePasses(options = {}) {
    if (options.ao) {
      Object.assign(this.settings.ao, options.ao);
      if (this.gtaoPass) {
        if (options.ao.enabled !== undefined) this.gtaoPass.enabled = options.ao.enabled;
        if (options.ao.scale !== undefined) {
          this.gtaoPass.blendIntensity = options.ao.scale;
        }
        const gtaoParams = {};
        if (options.ao.radius !== undefined) gtaoParams.radius = options.ao.radius;
        if (options.ao.distanceExponent !== undefined) gtaoParams.distanceExponent = options.ao.distanceExponent;
        if (options.ao.thickness !== undefined) gtaoParams.thickness = options.ao.thickness;
        if (options.ao.distanceFallOff !== undefined) gtaoParams.distanceFallOff = options.ao.distanceFallOff;
        if (options.ao.scale !== undefined) gtaoParams.scale = options.ao.scale;
        if (options.ao.samples !== undefined) gtaoParams.samples = options.ao.samples;
        if (Object.keys(gtaoParams).length > 0) {
          this.gtaoPass.updateGtaoMaterial?.(gtaoParams);
        }
      }
    }

    if (options.bloom) {
      Object.assign(this.settings.bloom, options.bloom);
      if (this.bloomPass) {
        if (options.bloom.enabled !== undefined) this.bloomPass.enabled = options.bloom.enabled;
        if (options.bloom.strength !== undefined) this.bloomPass.strength = options.bloom.strength;
        if (options.bloom.radius !== undefined) this.bloomPass.radius = options.bloom.radius;
        if (options.bloom.threshold !== undefined) this.bloomPass.threshold = options.bloom.threshold;
      }
    }

    if (options.dof) {
      Object.assign(this.settings.dof, options.dof);
      if (this.bokehPass) {
        if (options.dof.enabled !== undefined) this.bokehPass.enabled = options.dof.enabled;
        if (options.dof.focus !== undefined && this.bokehPass.uniforms.focus) {
          this.bokehPass.uniforms.focus.value = options.dof.focus;
        }
        if (options.dof.aperture !== undefined && this.bokehPass.uniforms.aperture) {
          this.bokehPass.uniforms.aperture.value = options.dof.aperture;
        }
        if (options.dof.maxblur !== undefined && this.bokehPass.uniforms.maxblur) {
          this.bokehPass.uniforms.maxblur.value = options.dof.maxblur;
        }
      }
    }
  }

  /**
   * Renders the post-processing stack.
   * @param {number} [deltaTime=0.016]
   */
  render(deltaTime = 0.016) {
    if (!this.enabled || !this.composer) {
      this.renderer.render(this.scene, this.camera);
      return;
    }

    this.composer.render(deltaTime);
  }

  /**
   * Frees GPU resources and render targets.
   */
  dispose() {
    if (this.gtaoPass?.blendMaterial?.dispose) this.gtaoPass.blendMaterial.dispose();
    if (this.gtaoPass?.gtaoMaterial?.dispose) this.gtaoPass.gtaoMaterial.dispose();
    if (this.gtaoPass?.dispose) this.gtaoPass.dispose();
    if (this.bloomPass?.dispose) this.bloomPass.dispose();
    if (this.bokehPass?.dispose) this.bokehPass.dispose();
    if (this.outputPass?.dispose) this.outputPass.dispose();
    if (this.composer?.renderTarget1) this.composer.renderTarget1.dispose();
    if (this.composer?.renderTarget2) this.composer.renderTarget2.dispose();
    if (this.composer?.dispose) this.composer.dispose();
    this.composer = null;
    this.gtaoPass = null;
    this.bloomPass = null;
    this.bokehPass = null;
    this.outputPass = null;
    this.renderPass = null;
  }
}
