/**
 * Web Blender Studio - Progressive Path Tracing Session & Hero Frame Manager
 * Manages path-tracing render lifecycle, progressive sampling, AbortController,
 * hero frames (bounded <=32 samples), resource caps (200k tris/2MP/256 samples/3min),
 * and environment parity (HDR / equirect half-float / rotation / intensity).
 * File: js/render/pathtrace-session.js
 */

import * as THREE from 'three';
import { buildTracingScene, cloneTracingCamera, getTracingSize } from './pathtrace-scene.js';

export const PATHTRACE_CAPS = {
  MAX_TRIANGLES: 200000,
  // Must not be smaller than the video export budget (1920x1080 = 2,073,600 px),
  // otherwise 1080p + heroFrames always throws before rendering.
  MAX_PIXELS: 1920 * 1080, // 2.07 MP
  MAX_DIMENSION: 2048,
  MAX_SAMPLES: 256,
  MAX_DURATION_MS: 180000, // 3 minutes (180s)
  HERO_FRAME_MAX_SAMPLES: 32,
};

export class PathTraceSession {
  /**
   * @param {Object} options
   * @param {THREE.Scene} options.scene
   * @param {THREE.Camera} options.camera
   * @param {THREE.WebGLRenderer} [options.renderer]
   * @param {THREE.Object3D} [options.rootContainer]
   * @param {THREE.Group} [options.lightsGroup]
   * @param {TimelineEngine} [options.timeline]
   */
  constructor(options = {}) {
    this.scene = options.scene;
    this.camera = options.camera;
    this.renderer = options.renderer || null;
    this.rootContainer = options.rootContainer || null;
    this.lightsGroup = options.lightsGroup || null;
    this.timeline = options.timeline || null;

    this.busy = false;
    this._abortController = null;
    this.stats = {
      samples: 0,
      durationMs: 0,
      meshCount: 0,
      triangleCount: 0,
      environmentSkipped: false,
    };
  }

  /**
   * Aborts the ongoing path-tracing render session immediately.
   */
  abort() {
    if (this._abortController) {
      this._abortController.abort();
    }
  }

  /**
   * Validates parameters against hard resource caps.
   */
  validateCaps({ samples = 64, scale = 0.5, width, height } = {}) {
    if (!Number.isInteger(samples) || samples < 1 || samples > PATHTRACE_CAPS.MAX_SAMPLES) {
      throw new Error(`Samples must be an integer between 1 and ${PATHTRACE_CAPS.MAX_SAMPLES}. Received: ${samples}`);
    }

    if (width !== undefined && height !== undefined) {
      if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
        throw new Error(`Invalid dimensions ${width}x${height}: width and height must be positive finite numbers.`);
      }
      const totalPixels = width * height;
      if (totalPixels > PATHTRACE_CAPS.MAX_PIXELS) {
        throw new Error(
          `Resolution ${width}x${height} (${totalPixels} px) exceeds the maximum limit of ${PATHTRACE_CAPS.MAX_PIXELS} px (2 MP).`
        );
      }
      if (width > PATHTRACE_CAPS.MAX_DIMENSION || height > PATHTRACE_CAPS.MAX_DIMENSION) {
        throw new Error(
          `Dimensions ${width}x${height} exceed the maximum dimension of ${PATHTRACE_CAPS.MAX_DIMENSION} px.`
        );
      }
    }
  }

  /**
   * Executes a progressive path-tracing render.
   * @param {Object} [options]
   * @param {number} [options.samples=64] Number of samples (1 to 256)
   * @param {number} [options.scale=0.5] Scaling factor (0.5, 1, 2)
   * @param {number} [options.width] Explicit render width
   * @param {number} [options.height] Explicit render height
   * @param {boolean} [options.denoise=false] Apply edge-preserving denoise pass
   * @param {AbortSignal} [options.signal] Cancellation signal
   * @param {Function} [options.onProgress] Callback ({ progress, currentSample, totalSamples, stage, elapsedMs })
   * @returns {Promise<{ dataUrl: string, canvas: HTMLCanvasElement, width: number, height: number, samples: number, durationMs: number, denoised: boolean, stats: Object }|null>}
   */
  async render(options = {}) {
    if (this.busy) {
      throw new Error('A Path Tracing session is already running.');
    }

    const {
      samples = 64,
      scale = 0.5,
      denoise = false,
      signal = null,
      onProgress = null,
    } = options;

    const baseRenderer = this.renderer;
    if (!baseRenderer) {
      throw new Error('Renderer has not been initialized.');
    }

    const viewportSize = baseRenderer.getSize ? baseRenderer.getSize(new THREE.Vector2()) : new THREE.Vector2(1280, 720);
    const traceSize = options.width && options.height
      ? { width: Math.floor(options.width), height: Math.floor(options.height) }
      : getTracingSize(viewportSize.x, viewportSize.y, scale);

    const { width, height } = traceSize;
    this.validateCaps({ samples, width, height });

    this.busy = true;
    this._abortController = new AbortController();

    const effectiveSignal = signal || this._abortController.signal;
    if (effectiveSignal.aborted) {
      this.busy = false;
      return null;
    }

    let snapshot = null;
    let dedicatedRenderer = null;
    let tracer = null;
    let generator = null;
    let quad = null;
    let background = null;

    const started = performance.now();
    const yieldToUI = () => new Promise((resolve) => setTimeout(resolve, 8));

    try {
      onProgress?.({ progress: 0, currentSample: 0, totalSamples: samples, stage: 'Loading Path Tracing engine…', elapsedMs: 0 });

      // Lazy import libraries
      const [{ PathTracingRenderer, PathTracingSceneGenerator, GradientEquirectTexture }, { FullScreenQuad }] = await Promise.all([
        import('three-gpu-pathtracer'),
        import('three/addons/postprocessing/Pass.js'),
      ]);

      if (effectiveSignal.aborted) return null;

      // 1. Build Scene Snapshot
      snapshot = buildTracingScene({
        scene: this.scene,
        rootContainer: this.rootContainer,
        lightsGroup: this.lightsGroup,
        maxTriangles: PATHTRACE_CAPS.MAX_TRIANGLES,
      });

      if (!snapshot.meshCount) {
        throw new Error('Scene has no visible PBR meshes to render with Path Tracing.');
      }

      const camera = cloneTracingCamera(this.camera, width / height);
      await yieldToUI();
      if (effectiveSignal.aborted) return null;

      // 2. Initialize Dedicated Off-Screen WebGL2 Context
      dedicatedRenderer = new THREE.WebGLRenderer({
        antialias: false,
        alpha: true,
        premultipliedAlpha: false,
        preserveDrawingBuffer: true,
      });

      if (!dedicatedRenderer.capabilities.isWebGL2 || !dedicatedRenderer.extensions.has('EXT_color_buffer_float')) {
        throw new Error('GPU requires WebGL 2 and the EXT_color_buffer_float extension for Path Tracing.');
      }

      let shaderError = false;
      dedicatedRenderer.debug.onShaderError = () => { shaderError = true; };
      dedicatedRenderer.setPixelRatio(1);
      dedicatedRenderer.setSize(width, height, false);
      dedicatedRenderer.outputColorSpace = baseRenderer.outputColorSpace || THREE.SRGBColorSpace;
      dedicatedRenderer.toneMappingExposure = baseRenderer.toneMappingExposure || 1.0;
      dedicatedRenderer.toneMapping = THREE.NoToneMapping;

      onProgress?.({
        progress: 0.05,
        currentSample: 0,
        totalSamples: samples,
        stage: `Building BVH (${snapshot.triangleCount} triangles)…`,
        elapsedMs: Math.round(performance.now() - started),
      });

      snapshot.prepareGeometry();
      if (!snapshot.meshCount) {
        throw new Error('Scene has no visible PBR meshes after geometry preparation.');
      }

      generator = new PathTracingSceneGenerator(snapshot.scene);
      const generated = generator.generate();

      tracer = new PathTracingRenderer(dedicatedRenderer);
      const material = tracer.material;
      material.bounces = 5;
      material.transmissiveBounces = 5;
      material.filterGlossyFactor = 0.5;
      material.bvh.updateFrom(generated.bvh);

      const geometry = generated.geometry;
      material.attributesArray.updateFrom(
        geometry.attributes.normal,
        geometry.attributes.tangent,
        geometry.attributes.uv,
        geometry.attributes.color
      );
      material.materialIndexAttribute.updateFrom(geometry.attributes.materialIndex);
      material.textures.setTextures(dedicatedRenderer, generated.textures, 512, 512);
      material.materials.updateFrom(generated.materials, generated.textures);
      material.lights.updateFrom(generated.lights, generated.iesTextures);
      material.iesProfiles.setTextures(dedicatedRenderer, generated.iesTextures);

      // =========================================================================
      // ENVIRONMENT & PMREM PARITY INTEGRATION
      // =========================================================================
      if (snapshot.scene.environment) {
        material.environmentIntensity = snapshot.scene.environmentIntensity !== undefined
          ? snapshot.scene.environmentIntensity
          : 1.0;

        material.envMapInfo.updateFrom(snapshot.scene.environment);

        if (material.environmentRotation && snapshot.scene.environmentRotation) {
          material.environmentRotation.makeRotationFromEuler(snapshot.scene.environmentRotation).invert();
        }
      } else {
        material.environmentIntensity = 0;
      }

      if (snapshot.scene.background) {
        background = new GradientEquirectTexture(16);
        background.topColor.copy(snapshot.scene.background);
        background.bottomColor.copy(snapshot.scene.background);
        background.update();
        material.backgroundMap = background;
      }
      material.backgroundAlpha = snapshot.scene.background ? 1 : 0;
      tracer.alpha = material.backgroundAlpha !== 1 || !dedicatedRenderer.extensions.has('EXT_float_blend');

      tracer.setCamera(camera);
      tracer.setSize(width, height);
      tracer.tiles.set(2, 2);

      // 3. Progressive Sampling Loop
      while (tracer.samples < samples) {
        if (effectiveSignal.aborted) {
          return null;
        }

        const elapsed = performance.now() - started;
        if (elapsed > PATHTRACE_CAPS.MAX_DURATION_MS) {
          throw new Error(`Exceeded maximum Path Tracing timeout of ${PATHTRACE_CAPS.MAX_DURATION_MS / 1000}s. Try lowering Samples.`);
        }

        if (dedicatedRenderer.getContext().isContextLost()) {
          throw new Error('GPU lost WebGL context (Context Lost); lower the resolution and try again.');
        }

        if (!tracer.isCompiling) {
          tracer.update();
        }

        if (shaderError) {
          throw new Error('GPU could not compile Path Tracing shader.');
        }

        const currentSample = Math.floor(tracer.samples);
        const progressRatio = Math.min(1.0, currentSample / samples);

        onProgress?.({
          progress: progressRatio,
          currentSample,
          totalSamples: samples,
          stage: tracer.isCompiling ? 'Compiling Path Tracing shader…' : `Accumulating sample ${currentSample}/${samples}…`,
          elapsedMs: Math.round(elapsed),
        });

        await yieldToUI();
      }

      // 4. Denoise Filter Pass
      if (denoise) {
        onProgress?.({
          progress: 1.0,
          currentSample: samples,
          totalSamples: samples,
          stage: 'Applying edge-preserving denoiser…',
          elapsedMs: Math.round(performance.now() - started),
        });
        await yieldToUI();

        if (effectiveSignal.aborted) return null;

        const { createDenoiseMaterial } = await import('./pathtrace-denoise.js');
        if (effectiveSignal.aborted) return null;

        quad = new FullScreenQuad(createDenoiseMaterial(tracer.target.texture));
      } else {
        quad = new FullScreenQuad(
          new THREE.MeshBasicMaterial({
            map: tracer.target.texture,
            transparent: true,
            blending: THREE.NoBlending,
            depthTest: false,
            depthWrite: false,
          })
        );
      }

      // 5. Tone Mapping & Final Composite
      dedicatedRenderer.toneMapping = baseRenderer.toneMapping ?? THREE.ACESFilmicToneMapping;
      dedicatedRenderer.setRenderTarget(null);
      dedicatedRenderer.setScissorTest(false);
      dedicatedRenderer.setClearColor(0, 0);
      dedicatedRenderer.clear();
      quad.render(dedicatedRenderer);

      if (shaderError) throw new Error('GPU could not compile export shader.');
      if (dedicatedRenderer.getContext().isContextLost()) throw new Error('GPU context lost after rendering.');

      const durationMs = Math.round(performance.now() - started);
      const dataUrl = dedicatedRenderer.domElement.toDataURL('image/png');
      // The dedicated WebGL context is destroyed in `finally`; keep a 2D copy so callers
      // (e.g. hero frames in video export) can still read the pixels.
      let outputCanvas = dedicatedRenderer.domElement;
      if (typeof document !== 'undefined') {
        outputCanvas = document.createElement('canvas');
        outputCanvas.width = width;
        outputCanvas.height = height;
        outputCanvas.getContext('2d').drawImage(dedicatedRenderer.domElement, 0, 0);
      }

      this.stats = {
        samples: Math.floor(tracer.samples),
        durationMs,
        meshCount: snapshot.meshCount,
        triangleCount: snapshot.triangleCount,
        bakedSkinned: snapshot.bakedSkinned,
        skippedSkinned: snapshot.skippedSkinned,
        skippedMaterial: snapshot.skippedMaterial,
        environmentSkipped: snapshot.environmentSkipped,
        denoised: denoise,
      };

      return {
        dataUrl,
        canvas: outputCanvas,
        width,
        height,
        samples: this.stats.samples,
        durationMs,
        denoised: denoise,
        stats: { ...this.stats },
      };
    } finally {
      try {
        quad?.material?.dispose();
        quad?.dispose();
        background?.dispose();
        tracer?.dispose();
        tracer?.material?.dispose();
        generator?.geometry?.dispose();
        snapshot?.dispose();
      } finally {
        dedicatedRenderer?.dispose();
        dedicatedRenderer?.forceContextLoss();
        this.busy = false;
        this._abortController = null;
      }
    }
  }

  /**
   * Renders a single bounded HERO frame (<=32 samples) with path-tracing.
   * Can be injected into video export or downloaded as high-quality PNG.
   * @param {Object} [options]
   * @param {number} [options.frameIndex=0]
   * @param {number} [options.samples=16] Maximum capped at 32
   * @param {number} [options.scale=1.0]
   * @param {boolean} [options.denoise=true]
   * @param {AbortSignal} [options.signal]
   * @param {Function} [options.onProgress]
   * @returns {Promise<{ dataUrl: string, canvas: HTMLCanvasElement, width: number, height: number, samples: number, frameIndex: number }|null>}
   */
  async renderHeroFrame(options = {}) {
    const frameIndex = options.frameIndex !== undefined ? options.frameIndex : 0;
    const requestedSamples = options.samples || 16;
    const boundedSamples = Math.min(requestedSamples, PATHTRACE_CAPS.HERO_FRAME_MAX_SAMPLES);

    console.warn(
      `[PathTraceSession] Rendering HERO Frame #${frameIndex} with path-tracing (${boundedSamples} samples). ` +
      `Warning: Video animation sequences may exhibit temporal flicker between frames without synchronized denoising.`
    );

    if (this.timeline) {
      this.timeline.seekToFrame(frameIndex, true);
    }

    const result = await this.render({
      ...options,
      samples: boundedSamples,
      denoise: options.denoise !== undefined ? options.denoise : true,
    });

    if (!result) return null;

    return {
      ...result,
      frameIndex,
    };
  }
}
