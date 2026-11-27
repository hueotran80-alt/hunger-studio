/**
 * Web Blender Studio - Deterministic Frame Source
 * Renders individual timeline frames off-screen at exact resolution, flips row lines
 * in-place with Rust WASM, and produces VideoFrames for encoding.
 * File: js/render/frame-source.js
 */

import * as THREE from 'three';
import {
  flipYInPlace,
  computeFrameHash,
  initVideoKernel,
  applyColorGradeInPlace,
  burnInMetadataInPlace,
} from './video-kernel-bridge.js';

export class FrameSource {
  /**
   * @param {Object} options
   * @param {THREE.WebGLRenderer} options.renderer
   * @param {THREE.Scene} options.scene
   * @param {THREE.Camera} options.camera
   * @param {RasterRenderer} [options.rasterRenderer]
   * @param {number} [options.width=1280]
   * @param {number} [options.height=720]
   */
  constructor(options = {}) {
    this.renderer = options.renderer;
    this.scene = options.scene;
    this.camera = options.camera;
    this.rasterRenderer = options.rasterRenderer || null;

    this.width = options.width || 1280;
    this.height = options.height || 720;

    // Video phải dùng cùng look-dev (GTAO/Bloom/Bokeh) như viewport và ảnh still.
    this.postProcess = options.postProcess !== false;
    this.preset = options.preset || null;
    this.transparent = !!options.transparent;
    this._postState = null;

    this.renderTarget = null;
    this.pixelBuffer = null;
    this.canvas = null;
    this.ctx = null;

    this._initBuffers();
  }

  async init() {
    await initVideoKernel();
    this._preparePostProcessing();
  }

  /**
   * Video có đi qua post-processing không. Preset 'fast' hoặc postProcess:false
   * quay về đường render-target thô như trước.
   * @returns {boolean}
   */
  _usesPostProcessing() {
    if (this.transparent) return false;
    const raster = this.rasterRenderer;
    const post = raster && raster.postProcessing;
    if (!this.postProcess || !this.renderer || !raster || !post) return false;
    // Preset override (vd. xuất 'cinematic' từ viewport đang 'fast') phải thắng
    // trạng thái enabled hiện tại, vì _preparePostProcessing sẽ bật lại passes.
    const effectivePreset = this.preset || raster.preset;
    return effectivePreset !== 'fast';
  }

  /**
   * Returns true when we can encode directly from `renderer.domElement` on GPU
   * (zero `gl.readPixels`, zero CPU Y-flip memcpy) — 5x-15x faster for WebGL video export.
   */
  _canZeroCopyGpu(options = {}) {
    if (options.zeroCopy !== true) return false;
    if (!this._postState) return false;
    if (options.createVideoFrame === false) return false;
    if (options.needPixels) return false;
    if (this.transparent) return false;
    if (options.colorGrade || options.metadataText) return false;
    if (typeof VideoFrame === 'undefined') return false;
    const dom = this.renderer?.domElement;
    if (!dom || typeof dom.width !== 'number') return false;
    return true;
  }

  /**
   * Đổi renderer + composer sang đúng độ phân giải video một lần cho cả lần xuất.
   * Composer vẽ ra canvas nên frame được đọc từ framebuffer mặc định.
   */
  _preparePostProcessing() {
    if (this._postState || !this.renderer) return;
    const usesPost = this._usesPostProcessing();
    const hasDom = Boolean(this.renderer.domElement && typeof this.renderer.getSize === 'function' && typeof this.renderer.getPixelRatio === 'function');
    if (!usesPost && !hasDom) return;
    const raster = this.rasterRenderer;
    const size = new THREE.Vector2();
    this.renderer.getSize(size);
    this._postState = {
      width: size.x,
      height: size.y,
      pixelRatio: this.renderer.getPixelRatio(),
      preset: raster?.preset || null,
      camera: raster?.postProcessing?.camera || raster?.camera || null,
      scene: raster?.postProcessing?.scene || raster?.scene || null,
    };
    if (usesPost && this.preset && this.preset !== raster.preset && typeof raster.setPreset === 'function') {
      raster.setPreset(this.preset);
    }
    this.renderer.setPixelRatio(1);
    this.renderer.setSize(this.width, this.height, false);
    if (usesPost && raster?.postProcessing) {
      raster.postProcessing.setSize(this.width, this.height, 1);
      if (typeof raster.postProcessing.updateCameraAndScene === 'function') {
        raster.postProcessing.updateCameraAndScene(this.camera, this.scene);
      }
    }
  }

  /**
   * Trả canvas/composer về kích thước và preset của viewport sau khi xuất.
   */
  _restorePostProcessing() {
    const state = this._postState;
    if (!state) return;
    this._postState = null;
    if (!this.renderer) return;
    const raster = this.rasterRenderer;
    this.renderer.setPixelRatio(state.pixelRatio);
    this.renderer.setSize(state.width, state.height, false);
    if (raster && raster.postProcessing && typeof raster.postProcessing.setSize === 'function') {
      raster.postProcessing.setSize(state.width, state.height, state.pixelRatio);
    }
    if (raster && raster.postProcessing && typeof raster.postProcessing.updateCameraAndScene === 'function' && state.camera) {
      raster.postProcessing.updateCameraAndScene(state.camera, state.scene || this.scene);
    }
    if (this.preset && raster && state.preset !== raster.preset && typeof raster.setPreset === 'function') {
      raster.setPreset(state.preset);
    }
  }

  _initBuffers() {
    const w = this.width;
    const h = this.height;

    if (this.renderer) {
      this.renderTarget = new THREE.WebGLRenderTarget(w, h, {
        format: THREE.RGBAFormat,
        type: THREE.UnsignedByteType,
        colorSpace: THREE.SRGBColorSpace,
        depthBuffer: true,
        stencilBuffer: false,
      });
      // Three r160 skips tone mapping for render targets; this flag makes video frames
      // use the same AgX/ACES tone mapping as the viewport (WYSIWYG export).
      this.renderTarget.isXRRenderTarget = true;
      this.pixelBuffer = new Uint8Array(w * h * 4);
    }

    // Off-screen canvas for VideoFrame / fallback conversion
    if (typeof document !== 'undefined') {
      this.canvas = document.createElement('canvas');
      this.canvas.width = w;
      this.canvas.height = h;
      this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    }
  }

  /**
   * Captures the current scene frame into pixel buffer and flips lines using Rust WASM.
   * @param {Object} [options]
   * @param {number} [options.timestampUs=0]
   * @returns {{ pixelBuffer: Uint8Array, videoFrame: VideoFrame|null, frameHash: bigint, width: number, height: number }}
   */
  captureFrame(options = {}) {
    const timestampUs = options.timestampUs || 0;
    const w = this.width;
    const h = this.height;

    if (this.renderer && this.renderTarget) {
      // Match the projection to the export resolution. Without this a vertical
      // 720x1280 export keeps the viewport aspect and the picture is stretched.
      const camera = this.camera;
      const targetAspect = w / h;
      const previousAspect = camera && camera.isPerspectiveCamera ? camera.aspect : null;
      const previousOrtho = camera && camera.isOrthographicCamera
        ? { left: camera.left, right: camera.right }
        : null;

      if (previousAspect !== null && previousAspect !== targetAspect) {
        camera.aspect = targetAspect;
        camera.updateProjectionMatrix();
      } else if (previousOrtho) {
        const halfH = (camera.top - camera.bottom) / 2;
        camera.left = -halfH * targetAspect;
        camera.right = halfH * targetAspect;
        camera.updateProjectionMatrix();
      }

      if (typeof this.scene?.updateMatrixWorld === 'function') {
        this.scene.updateMatrixWorld(true);
      }
      if (typeof camera?.updateMatrixWorld === 'function') {
        camera.updateMatrixWorld(true);
      }

      const prevBg = this.transparent ? this.scene?.background : undefined;
      const prevClearAlpha = this.transparent && typeof this.renderer.getClearAlpha === 'function'
        ? this.renderer.getClearAlpha()
        : null;

      const fromComposer = this._usesPostProcessing() && !!this._postState;
      const zeroCopyGpu = this._canZeroCopyGpu(options);
      try {
        if (this.transparent) {
          if (this.scene) this.scene.background = null;
          if (typeof this.renderer.setClearAlpha === 'function') {
            this.renderer.setClearAlpha(0);
          }
        }

        if (fromComposer) {
          // Composer (RenderPass → GTAO → Bloom → Bokeh → OutputPass) chỉ vẽ ra
          // canvas, nên đọc framebuffer mặc định thay vì render target thô.
          if (typeof this.rasterRenderer.postProcessing?.updateCameraAndScene === 'function') {
            this.rasterRenderer.postProcessing.updateCameraAndScene(this.camera, this.scene);
          }
          this.rasterRenderer.renderFrame({
            scene: this.scene,
            camera: this.camera,
            hideHelpers: true,
            delta: 1 / 30,
          });
          if (!zeroCopyGpu) {
            const gl = this.renderer.getContext();
            gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, this.pixelBuffer);
          }
        } else if (zeroCopyGpu && this._postState) {
          // Zero-copy direct GPU canvas render (skip renderTarget + readPixels + CPU flipY!)
          if (this.rasterRenderer) {
            this.rasterRenderer.renderFrame({
              scene: this.scene,
              camera: this.camera,
              target: null,
              hideHelpers: true,
              delta: 1 / 30,
            });
          } else {
            this.renderer.setRenderTarget(null);
            this.renderer.clear();
            this.renderer.render(this.scene, this.camera);
          }
        } else if (this.rasterRenderer) {
          this.rasterRenderer.renderFrame({
            scene: this.scene,
            camera: this.camera,
            target: this.renderTarget,
            hideHelpers: true,
          });
        } else {
          const prevTarget = this.renderer.getRenderTarget();
          this.renderer.setRenderTarget(this.renderTarget);
          this.renderer.clear();
          this.renderer.render(this.scene, this.camera);
          this.renderer.setRenderTarget(prevTarget);
        }

        if (zeroCopyGpu) {
          if (this._lastVideoFrame) {
            try { this._lastVideoFrame.close(); } catch (_) {}
            this._lastVideoFrame = null;
          }
          const durationUs = options.durationUs || Math.round(1_000_000 / 30);
          const vf = new VideoFrame(this.renderer.domElement, {
            timestamp: timestampUs,
            duration: durationUs,
          });
          this._lastVideoFrame = vf;
          return {
            pixelBuffer: null,
            videoFrame: vf,
            frameHash: 0n,
            width: w,
            height: h,
            canvas: this.renderer.domElement,
            zeroCopy: true,
          };
        }

        // Composer đã đọc thẳng framebuffer; render-target thô mới cần đọc lại.
        if (!fromComposer) {
          this.renderer.readRenderTargetPixels(this.renderTarget, 0, 0, w, h, this.pixelBuffer);
        }

        // Invert row lines from bottom-up to top-down via Rust WASM Kernel
        flipYInPlace(this.pixelBuffer, w, h);

        // Optional Rust WASM color grade & Blender-style metadata burn-in stamp
        if (options.colorGrade) {
          applyColorGradeInPlace(this.pixelBuffer, w, h, options.colorGrade);
        }
        if (options.metadataText) {
          burnInMetadataInPlace(this.pixelBuffer, w, h, options.metadataText, {
            position: options.metadataPosition || 'bottom',
          });
        }
      } finally {
        if (this.transparent) {
          if (this.scene) this.scene.background = prevBg;
          if (prevClearAlpha !== null && typeof this.renderer.setClearAlpha === 'function') {
            this.renderer.setClearAlpha(prevClearAlpha);
          }
        }
        if (previousAspect !== null && previousAspect !== targetAspect) {
          camera.aspect = previousAspect;
          camera.updateProjectionMatrix();
        } else if (previousOrtho) {
          camera.left = previousOrtho.left;
          camera.right = previousOrtho.right;
          camera.updateProjectionMatrix();
        }
      }
    }

    // Compute frame hash in Rust WASM for verification
    const frameHash = computeFrameHash(this.pixelBuffer || new Uint8Array(16));

    if (options.drawToCanvas && this.ctx && this.pixelBuffer) {
      const imgData = new ImageData(new Uint8ClampedArray(this.pixelBuffer.buffer, this.pixelBuffer.byteOffset, this.pixelBuffer.byteLength), w, h);
      this.ctx.putImageData(imgData, 0, 0);
    }

    let videoFrame = null;
    if (options.createVideoFrame !== false && typeof VideoFrame !== 'undefined' && this.pixelBuffer) {
      if (this._lastVideoFrame) {
        try { this._lastVideoFrame.close(); } catch (_) {}
        this._lastVideoFrame = null;
      }
      try {
        videoFrame = new VideoFrame(this.pixelBuffer, {
          format: 'RGBA',
          codedWidth: w,
          codedHeight: h,
          timestamp: timestampUs,
        });
      } catch (_) {
        // Fallback: draw ImageData to Canvas then construct VideoFrame
        if (this.ctx) {
          const imgData = new ImageData(new Uint8ClampedArray(this.pixelBuffer.buffer), w, h);
          this.ctx.putImageData(imgData, 0, 0);
          videoFrame = new VideoFrame(this.canvas, { timestamp: timestampUs });
        }
      }
      this._lastVideoFrame = videoFrame;
    }

    return {
      pixelBuffer: this.pixelBuffer,
      videoFrame,
      frameHash,
      width: w,
      height: h,
      canvas: this.canvas,
    };
  }

  /**
   * Draws the last captured RGBA pixelBuffer onto this.canvas and returns the canvas.
   * @returns {HTMLCanvasElement|null}
   */
  drawToCanvas() {
    if (!this.ctx || !this.pixelBuffer) return this.canvas;
    const imgData = new ImageData(
      new Uint8ClampedArray(this.pixelBuffer.buffer, this.pixelBuffer.byteOffset, this.pixelBuffer.byteLength),
      this.width,
      this.height
    );
    this.ctx.putImageData(imgData, 0, 0);
    return this.canvas;
  }

  /**
   * Encodes the current frame (or given canvas) to PNG bytes (Uint8Array).
   * Works in browsers via canvas.toBlob / convertToBlob, with dataURL fallback.
   * @param {HTMLCanvasElement|OffscreenCanvas} [sourceCanvas]
   * @returns {Promise<Uint8Array>}
   */
  async encodeCanvasToPngBytes(sourceCanvas = null) {
    const target = sourceCanvas || this.drawToCanvas();
    if (!target) {
      throw new Error('Canvas unavailable for PNG sequence encoding');
    }
    if (typeof target.convertToBlob === 'function') {
      const blob = await target.convertToBlob({ type: 'image/png' });
      return new Uint8Array(await blob.arrayBuffer());
    }
    if (typeof target.toBlob === 'function') {
      const blob = await new Promise((resolve, reject) => {
        target.toBlob((b) => (b ? resolve(b) : reject(new Error('canvas.toBlob returned null'))), 'image/png');
      });
      return new Uint8Array(await blob.arrayBuffer());
    }
    if (typeof target.toDataURL === 'function') {
      const dataUrl = target.toDataURL('image/png');
      const base64 = dataUrl.split(',')[1] || '';
      const bin = atob(base64);
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out;
    }
    throw new Error('Target canvas does not support PNG export');
  }

  dispose() {
    this._restorePostProcessing();
    if (this._lastVideoFrame) {
      try { this._lastVideoFrame.close(); } catch (_) {}
      this._lastVideoFrame = null;
    }
    if (this.renderTarget) {
      this.renderTarget.dispose();
      this.renderTarget = null;
    }
    this.pixelBuffer = null;
    this.canvas = null;
    this.ctx = null;
  }
}
