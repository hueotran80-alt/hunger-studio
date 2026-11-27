/**
 * Web Blender Studio - Blender-Style Render Animation Studio UI (Ctrl+F12)
 * Unified animation rendering window supporting:
 * - Cycles-Style Rust WASM Path Tracer (Multi-threaded Web Workers + SIMD128 BVH4 + O(N) BVH Refit
 *   + SkinnedMesh baking + SVGF Denoise + Motion-Vector Temporal Reprojection + Physical Camera Motion Blur)
 * - EEVEE-Style WebGL Look-Dev Raster (Fast / Studio / Cinematic + Rust video_kernel.wasm post pipeline)
 * - Output formats: MP4 (H.264 + AAC), WebM (VP9/VP8 + Opus), PNG Sequence (.zip with Alpha)
 * - Blender Output Properties: Resolution presets + Resolution %, Start/End/Step, FPS, Camera,
 *   Film Transparent, Audio Muxing, Rust Metadata Burn-In Stamp, and Color Grading.
 * File: js/ui/video-render-dialog.js
 */

import { VideoExportManager, VIDEO_BUDGET, normalizeVideoFormat, formatTimecode } from '../render/video-export.js';
import { VideoEncoderClient } from '../render/video-encoder.js';

export const RESOLUTION_PRESETS = Object.freeze({
  '720p': { label: '1280×720 (HD 16:9)', width: 1280, height: 720 },
  '1080p': { label: '1920×1080 (Full HD 16:9)', width: 1920, height: 1080 },
  'vertical-1080': { label: '1080×1920 (Vertical 9:16 · Shorts/TikTok)', width: 1080, height: 1920 },
  'vertical-720': { label: '720×1280 (Vertical HD 9:16)', width: 720, height: 1280 },
  'square-1080': { label: '1080×1080 (Square 1:1)', width: 1080, height: 1080 },
  '480p': { label: '854×480 (480p Fast Draft)', width: 854, height: 480 },
  'viewport': { label: 'Match Viewport', width: 0, height: 0 },
  'custom': { label: 'Custom…', width: 0, height: 0 },
});

export const QUALITY_PRESETS = Object.freeze({
  draft: { label: 'Draft (Small File)', bitsPerPixelFactor: 0.08, minBps: 1_500_000, maxBps: 4_000_000 },
  standard: { label: 'Standard (Balanced)', bitsPerPixelFactor: 0.16, minBps: 3_500_000, maxBps: 10_000_000 },
  high: { label: 'High (Sharp Web)', bitsPerPixelFactor: 0.28, minBps: 6_000_000, maxBps: 18_000_000 },
  master: { label: 'Master (Studio)', bitsPerPixelFactor: 0.45, minBps: 12_000_000, maxBps: 30_000_000 },
});

/**
 * Computes scaled output dimensions (like Blender's Resolution % slider),
 * clamped to VIDEO_BUDGET and rounded to even dimensions for video formats.
 */
export function computeScaledResolution(baseWidth, baseHeight, scalePercent = 100, format = 'mp4') {
  const pct = Math.max(10, Math.min(100, Number(scalePercent) || 100)) / 100;
  let w = Math.max(16, Math.round((Number(baseWidth) || 1280) * pct));
  let h = Math.max(16, Math.round((Number(baseHeight) || 720) * pct));

  // Clamp to MAX_DIM and MAX_PIXELS preserving aspect ratio
  if (w > VIDEO_BUDGET.MAX_DIM || h > VIDEO_BUDGET.MAX_DIM) {
    const s = VIDEO_BUDGET.MAX_DIM / Math.max(w, h);
    w = Math.max(16, Math.floor(w * s));
    h = Math.max(16, Math.floor(h * s));
  }
  if (w * h > VIDEO_BUDGET.MAX_PIXELS) {
    const s = Math.sqrt(VIDEO_BUDGET.MAX_PIXELS / (w * h));
    w = Math.max(16, Math.floor(w * s));
    h = Math.max(16, Math.floor(h * s));
  }

  const fmt = normalizeVideoFormat(format);
  if (fmt !== 'png-sequence') {
    w = Math.max(16, w & ~1);
    h = Math.max(16, h & ~1);
  }
  return { width: w, height: h };
}

/**
 * Computes an appropriate bitrate (bps) for resolution, FPS, and quality preset.
 */
export function computeRecommendedBitrate(width, height, fps = 30, qualityKey = 'standard') {
  const q = QUALITY_PRESETS[qualityKey] || QUALITY_PRESETS.standard;
  const raw = Math.round(width * height * Math.max(12, fps) * q.bitsPerPixelFactor);
  return Math.max(q.minBps, Math.min(q.maxBps, raw));
}

/**
 * Scans TimelineEngine tracks, bone tracks, NLA strips, and attached AnimationClip
 * to find the actual animated frame bounds.
 */
export function detectAnimationFrameRange(timeline) {
  if (!timeline) {
    return { startFrame: 0, endFrame: 100, hasKeyframes: false };
  }
  let minF = Infinity;
  let maxF = -Infinity;

  const visitKeys = (arr) => {
    if (!Array.isArray(arr)) return;
    for (let i = 0; i < arr.length; i++) {
      const f = arr[i]?.frame;
      if (Number.isFinite(f)) {
        if (f < minF) minF = f;
        if (f > maxF) maxF = f;
      }
    }
  };

  if (timeline.tracks && typeof timeline.tracks.forEach === 'function') {
    timeline.tracks.forEach((track) => {
      if (Array.isArray(track)) visitKeys(track);
      else if (track && typeof track === 'object') {
        visitKeys(track.keyframes);
        if (track.bones && typeof track.bones.forEach === 'function') {
          track.bones.forEach((b) => {
            visitKeys(b?.rotations);
            visitKeys(b?.positions);
          });
        }
      }
    });
  }

  if (timeline.boneTracks && typeof timeline.boneTracks.forEach === 'function') {
    timeline.boneTracks.forEach((boneMap) => {
      if (boneMap && typeof boneMap.forEach === 'function') {
        boneMap.forEach((b) => {
          visitKeys(b?.rotations);
          visitKeys(b?.positions);
        });
      }
    });
  }

  if (timeline.nlaTracks && typeof timeline.nlaTracks.forEach === 'function') {
    timeline.nlaTracks.forEach((tracksArr) => {
      if (!Array.isArray(tracksArr)) return;
      for (const tr of tracksArr) {
        for (const strip of (tr?.strips || [])) {
          if (Number.isFinite(strip.startFrame)) minF = Math.min(minF, strip.startFrame);
          if (Number.isFinite(strip.endFrame)) maxF = Math.max(maxF, strip.endFrame);
        }
      }
    });
  }

  const fps = Math.max(1, Number(timeline.fps) || 30);
  const clip = timeline._attachedClip;
  if (clip && Number.isFinite(clip.duration) && clip.duration > 0) {
    const clipEnd = Math.max(1, Math.round(clip.duration * fps));
    minF = Math.min(minF, 0);
    maxF = Math.max(maxF, clipEnd);
  }

  if (Number.isFinite(minF) && Number.isFinite(maxF) && maxF >= minF) {
    return {
      startFrame: Math.max(0, Math.floor(minF)),
      endFrame: Math.max(Math.floor(minF) + 1, Math.ceil(maxF)),
      hasKeyframes: true,
    };
  }
  return {
    startFrame: Math.max(0, Math.round(timeline.startFrame || 0)),
    endFrame: Math.max(1, Math.round(timeline.endFrame || 100)),
    hasKeyframes: false,
  };
}

function formatBytes(bytes) {
  if (!bytes || bytes < 1024) return `${bytes || 0} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function formatSeconds(sec) {
  if (!Number.isFinite(sec) || sec < 0) return '0.0s';
  if (sec < 60) return `${sec.toFixed(1)}s`;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}m ${String(s).padStart(2, '0')}s`;
}

export class VideoRenderManager {
  constructor(app) {
    this.app = app;
    this.busy = false;
    this._abortController = null;
    this._backdrop = null;
    this._lastResult = null;
    this._lastBlobUrl = null;
    this._audioFile = null;
    this._audioLabel = '';
    this._capabilities = null;
    this._gpuAdapterInfo = null;
    this._closeWhenDone = false;
    this._settings = {
      engine: 'raster',
      postPreset: 'studio',
      rustSamples: 16,
      rustMaxBounces: 5,
      rustDenoise: true,
      rustTemporal: true,
      rustShutter: 0.0,
      rustThreads: 0,
      rustTonemap: 'agx',
      exposure: 1.0,
      resPreset: '720p',
      width: 1280,
      height: 720,
      scalePercent: 100,
      fps: 30,
      startFrame: 0,
      endFrame: 100,
      frameStep: 1,
      format: 'mp4',
      quality: 'standard',
      transparent: false,
      cameraMode: 'active',
      stepPhysics: false,
      metadataBurnIn: false,
      metadataPosition: 'bottom',
      contrast: 1.0,
      saturation: 1.0,
      vignette: 0.0,
      audioStartSec: 0,
      filename: 'animation_render',
    };
  }

  bindUI() {
    const ids = ['btn-render-animation', 'btn-file-render-animation'];
    for (const id of ids) {
      document.getElementById(id)?.addEventListener('click', (e) => {
        e?.stopPropagation?.();
        this.openDialog();
      });
    }
  }

  cancel() {
    if (this._abortController) {
      this._abortController.abort();
    }
  }

  _getTimeline() {
    return this.app?.timelineEngine || (typeof window !== 'undefined' ? window.timelineEngine : null);
  }

  _getEngine() {
    return this.app?.engine || (typeof window !== 'undefined' ? (window.engine || window.studioEngine) : null);
  }

  _getCameraManager() {
    return this.app?.cameraManager || (typeof window !== 'undefined' ? window.cameraManager : null);
  }

  _getSimulationManager() {
    return this.app?.simulationManager || (typeof window !== 'undefined' ? window.simulationManager : null);
  }

  _resolveCamera(mode) {
    const engine = this._getEngine();
    const cm = this._getCameraManager();
    if (!engine) return { camera: null, label: 'Viewport' };

    if (mode === 'viewport') {
      return { camera: engine.camera, label: 'Viewport' };
    }
    if (mode === 'active') {
      const activeData = cm?.getActiveCameraData?.();
      if (activeData) {
        const activeObj = cm.getActiveCameraObject?.();
        return { camera: activeData, label: activeObj?.name || 'Camera' };
      }
      return { camera: engine.camera, label: 'Viewport' };
    }
    if (cm?.cameras?.length) {
      const entry = cm.cameras.find((c) => c.group?.uuid === mode);
      if (entry?.camera) {
        return { camera: entry.camera, label: entry.group?.name || 'Camera' };
      }
    }
    return { camera: engine.camera, label: 'Viewport' };
  }

  _hasDynamicPhysics() {
    const sim = this._getSimulationManager();
    const root = this.app?.sceneManager?.rootContainer || this._getEngine()?.scene;
    if (!sim || !root) return false;
    let found = false;
    root.traverse?.((obj) => {
      if (obj?.userData?.physics?.body === 'dynamic') found = true;
    });
    return found;
  }

  _revokeLastUrl() {
    if (this._lastBlobUrl) {
      try { URL.revokeObjectURL(this._lastBlobUrl); } catch (_) {}
      this._lastBlobUrl = null;
    }
  }

  async openDialog(presetOverrides = null) {
    if (presetOverrides && typeof presetOverrides === 'object') {
      Object.assign(this._settings, presetOverrides);
    }

    const tl = this._getTimeline();
    if (tl && !this._backdrop) {
      this._settings.startFrame = Math.max(0, Math.round(tl.startFrame || 0));
      this._settings.endFrame = Math.max(this._settings.startFrame + 1, Math.round(tl.endFrame || 100));
      this._settings.fps = Math.round(tl.fps || 30);
    }

    if (!this._backdrop) {
      this._buildDialog();
    }

    this._backdrop.hidden = false;
    this._syncDynamicOptions();
    this._refreshComputedReadout();

    // Probe browser WebCodecs & WebGPU hardware GPU adapter asynchronously
    if (!this._capabilities) {
      VideoEncoderClient.probeCapabilities(1280, 720, 30).then((caps) => {
        this._capabilities = caps;
        this._updateCapabilityBanner();
      }).catch(() => {});
    } else {
      this._updateCapabilityBanner();
    }
    if (!this._gpuAdapterInfo && typeof navigator !== 'undefined' && navigator.gpu) {
      import('../render/webgpu-pathtracer.js')
        .then(({ WebGPUPathTracer }) => WebGPUPathTracer.probeAdapter())
        .then((info) => {
          this._gpuAdapterInfo = info;
          this._updateCapabilityBanner();
        })
        .catch(() => {});
    }

    this._backdrop.querySelector('#vr-btn-start')?.focus();
  }

  _buildDialog() {
    const backdrop = document.createElement('div');
    backdrop.id = 'video-render-backdrop';
    backdrop.className = 'vr-backdrop';
    backdrop.innerHTML = `
      <style>
        .vr-backdrop {
          position: fixed; inset: 0; z-index: 100065;
          background: rgba(8, 10, 14, 0.76); backdrop-filter: blur(4px);
          padding: 16px; box-sizing: border-box; overflow: auto;
        }
        .vr-backdrop:not([hidden]) { display: grid; place-items: center; }
        .vr-backdrop[hidden] { display: none !important; }
        .vr-dialog {
          background: #1d1f24; color: #e5e8ee; border: 1px solid #383c46;
          border-radius: 10px; width: 960px; max-width: 96vw; max-height: 92vh;
          display: flex; flex-direction: column; overflow: hidden;
          box-shadow: 0 24px 64px rgba(0,0,0,0.65);
          font: 12.5px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        }
        .vr-header {
          display: flex; align-items: center; justify-content: space-between;
          padding: 10px 16px; background: #262930; border-bottom: 1px solid #353942;
        }
        .vr-header-left { display: flex; align-items: center; gap: 10px; }
        .vr-title { font-size: 14px; font-weight: 600; color: #f2f4f8; }
        .vr-badge {
          font-size: 10.5px; font-weight: 600; padding: 2px 7px; border-radius: 4px;
          background: #2f4b7c; color: #cfe2ff; letter-spacing: 0.2px;
        }
        .vr-badge.rust { background: #6b3416; color: #ffd4b3; }
        .vr-shortcut-pill {
          font-size: 11px; color: #969eab; background: #1a1c21;
          border: 1px solid #343842; border-radius: 4px; padding: 1px 6px;
        }
        .vr-close-btn {
          background: transparent; border: none; color: #9ea6b2; font-size: 16px;
          cursor: pointer; padding: 2px 8px; border-radius: 4px;
        }
        .vr-close-btn:hover { background: #363a44; color: #fff; }

        .vr-body {
          display: grid; grid-template-columns: 1.15fr 1fr; gap: 0;
          flex: 1; min-height: 0; overflow: hidden;
        }
        @media (max-width: 820px) {
          .vr-body { grid-template-columns: 1fr; overflow: auto; }
        }

        /* Left Preview Pane */
        .vr-preview-col {
          display: flex; flex-direction: column; padding: 14px;
          background: #14161a; border-right: 1px solid #2e323b; min-height: 0;
        }
        .vr-stage {
          position: relative; flex: 1; min-height: 290px;
          display: flex; align-items: center; justify-content: center;
          border: 1px solid #2c3039; border-radius: 6px; overflow: hidden;
          background-color: #111317;
          background-image:
            linear-gradient(45deg, #1b1e24 25%, transparent 25%),
            linear-gradient(-45deg, #1b1e24 25%, transparent 25%),
            linear-gradient(45deg, transparent 75%, #1b1e24 75%),
            linear-gradient(-45deg, transparent 75%, #1b1e24 75%);
          background-size: 18px 18px;
          background-position: 0 0, 0 9px, 9px -9px, -9px 0px;
        }
        .vr-stage canvas, .vr-stage video {
          max-width: 100%; max-height: 100%; object-fit: contain; display: none;
        }
        .vr-stage-empty {
          text-align: center; color: #8c95a3; padding: 24px; max-width: 340px;
        }
        .vr-stage-empty strong { color: #d5dbe5; display: block; margin-bottom: 6px; font-size: 13.5px; }
        .vr-overlay-pill {
          position: absolute; top: 8px; left: 8px; right: 8px;
          display: flex; justify-content: space-between; gap: 8px; pointer-events: none;
        }
        .vr-pill {
          background: rgba(15, 17, 22, 0.82); color: #dce2ec; font-size: 11px;
          padding: 3px 8px; border-radius: 4px; border: 1px solid rgba(255,255,255,0.08);
          font-variant-numeric: tabular-nums;
        }
        .vr-progress-wrap { margin-top: 10px; }
        .vr-progress-track {
          height: 7px; background: #262a33; border-radius: 4px; overflow: hidden;
        }
        .vr-progress-fill {
          height: 100%; width: 0%;
          background: linear-gradient(90deg, #e87d0d, #f5a623);
          transition: width 80ms linear;
        }
        .vr-status-line {
          margin-top: 6px; font-size: 11.5px; color: #aeb6c4;
          display: flex; justify-content: space-between; gap: 8px; flex-wrap: wrap;
          font-variant-numeric: tabular-nums;
        }
        .vr-status-line.ok { color: #6fdc96; }
        .vr-status-line.err { color: #ff7b7b; }
        .vr-actions {
          display: flex; gap: 8px; flex-wrap: wrap; margin-top: 12px; align-items: center;
        }
        .vr-btn {
          background: #2b2f38; color: #e5e8ee; border: 1px solid #3f4552;
          border-radius: 5px; padding: 7px 12px; font-size: 12px; font-weight: 500;
          cursor: pointer; display: inline-flex; align-items: center; gap: 6px;
        }
        .vr-btn:hover:not(:disabled) { background: #363b47; border-color: #555d6e; }
        .vr-btn:disabled { opacity: 0.45; cursor: not-allowed; }
        .vr-btn.primary {
          background: #d9730d; border-color: #ef8a24; color: #fff; font-weight: 600;
        }
        .vr-btn.primary:hover:not(:disabled) { background: #eb8217; }
        .vr-btn.success {
          background: #1f7a49; border-color: #2aa362; color: #fff; font-weight: 600;
        }
        .vr-btn.success:hover:not(:disabled) { background: #259157; }
        .vr-btn.danger { background: #7a2626; border-color: #a83737; color: #fff; }
        .vr-btn.sm { padding: 4px 8px; font-size: 11px; }

        /* Right Properties Pane */
        .vr-props-col {
          padding: 12px 14px; overflow-y: auto; display: flex; flex-direction: column; gap: 10px;
          background: #1d1f24;
        }
        .vr-card {
          background: #24272e; border: 1px solid #323640; border-radius: 7px; padding: 10px 12px;
        }
        .vr-card-title {
          font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px;
          color: #9ba5b5; margin-bottom: 8px; display: flex; justify-content: space-between; align-items: center;
        }
        .vr-grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
        .vr-grid-3 { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 6px; }
        .vr-field { display: flex; flex-direction: column; gap: 3px; margin-bottom: 6px; }
        .vr-field:last-child { margin-bottom: 0; }
        .vr-field label { font-size: 11px; color: #a7b0be; display: flex; justify-content: space-between; }
        .vr-input, .vr-select {
          background: #16181d; color: #edf0f5; border: 1px solid #3a3f4b;
          border-radius: 4px; padding: 5px 7px; font-size: 12px; width: 100%; box-sizing: border-box;
        }
        .vr-input:focus, .vr-select:focus { outline: none; border-color: #e87d0d; }
        .vr-check-row {
          display: flex; align-items: center; gap: 7px; font-size: 12px; color: #d6dce6;
          margin: 4px 0; cursor: pointer;
        }
        .vr-check-row input[type="checkbox"] { accent-color: #e87d0d; }
        .vr-inline-row { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
        .vr-hint { font-size: 11px; color: #8c95a3; margin-top: 3px; }
        .vr-cap-bar {
          font-size: 11px; padding: 5px 8px; border-radius: 4px;
          background: #19212c; border: 1px solid #2b3a4f; color: #a7c4e6;
          margin-bottom: 6px;
        }
      </style>

      <div class="vr-dialog" role="dialog" aria-modal="true" aria-labelledby="vr-dialog-title">
        <div class="vr-header">
          <div class="vr-header-left">
            <span class="vr-title" id="vr-dialog-title">🎬 Render Animation</span>
            <span class="vr-badge" id="vr-engine-badge">EEVEE · WebGL + Rust Video Kernel</span>
            <span class="vr-shortcut-pill">Ctrl+F12</span>
          </div>
          <button type="button" class="vr-close-btn" id="vr-btn-close" title="Close (Esc)">✕</button>
        </div>

        <div class="vr-body">
          <!-- LEFT: Render Result Preview & Player -->
          <div class="vr-preview-col">
            <div class="vr-stage" id="vr-stage">
              <div class="vr-overlay-pill">
                <span class="vr-pill" id="vr-pill-left">Ready</span>
                <span class="vr-pill" id="vr-pill-right">1280×720 · 30 FPS</span>
              </div>
              <div class="vr-stage-empty" id="vr-stage-empty">
                <strong>Blender-Style Animation Render Studio</strong>
                Click <b>Preview Frame</b> to inspect lighting & camera, or <b>Render Animation</b> to export deterministic video with Rust WASM acceleration.
              </div>
              <canvas id="vr-preview-canvas"></canvas>
              <video id="vr-result-video" controls loop muted playsinline></video>
            </div>

            <div class="vr-progress-wrap">
              <div class="vr-progress-track">
                <div class="vr-progress-fill" id="vr-progress-fill"></div>
              </div>
              <div class="vr-status-line" id="vr-status-line" role="status">
                <span id="vr-status-text">Ready to render timeline animation.</span>
                <span id="vr-status-metrics"></span>
              </div>
            </div>

            <div class="vr-actions">
              <button type="button" class="vr-btn" id="vr-btn-preview" title="Render current frame only with selected settings">👁 Preview Frame</button>
              <button type="button" class="vr-btn primary" id="vr-btn-start">🎬 Render Animation</button>
              <button type="button" class="vr-btn danger" id="vr-btn-cancel" disabled>⏹ Cancel</button>
              <button type="button" class="vr-btn success" id="vr-btn-download" hidden>⬇ Download</button>
            </div>
          </div>

          <!-- RIGHT: Blender Render & Output Properties -->
          <div class="vr-props-col">
            <!-- 1. Render Engine -->
            <div class="vr-card">
              <div class="vr-card-title">
                <span>Render Properties</span>
                <span id="vr-wasm-badge" style="color:#6fdc96;font-weight:600;">🦀 Rust WASM SIMD128</span>
              </div>

              <div class="vr-field">
                <label for="vr-engine">Render Engine</label>
                <select id="vr-engine" class="vr-select">
                  <option value="raster">EEVEE · WebGL Look-Dev (Fastest · Zero-Copy GPU)</option>
                  <option value="webgpu">Cycles X · WebGPU + Rust BVH (QMC · BSDF v2 · HDRI MIS · SVGF)</option>
                  <option value="rust">Cycles · Rust CPU Path Tracer (WASM Multi-Thread + SAB)</option>
                </select>
              </div>

              <!-- EEVEE Look-Dev Options -->
              <div id="vr-eevee-opts">
                <div class="vr-field">
                  <label for="vr-post-preset">Look-Dev Quality (Post-Processing)</label>
                  <select id="vr-post-preset" class="vr-select">
                    <option value="fast">Fast (Direct PBR, No Post)</option>
                    <option value="studio" selected>Studio (GTAO + Bloom + AgX)</option>
                    <option value="cinematic">Cinematic (GTAO + Bloom + DOF + AgX)</option>
                  </select>
                </div>
              </div>

              <!-- Cycles (Rust WASM) Options -->
              <div id="vr-cycles-opts" style="display:none;">
                <div class="vr-grid-3">
                  <div class="vr-field">
                    <label for="vr-rust-samples">Samples (SPP)</label>
                    <select id="vr-rust-samples" class="vr-select">
                      <option value="4">4 (Ultra-Fast Draft)</option>
                      <option value="8" selected>8 (Fast + Temporal)</option>
                      <option value="16">16 (Standard)</option>
                      <option value="32">32 (High)</option>
                      <option value="64">64 (Production)</option>
                      <option value="128">128 (Ultra)</option>
                    </select>
                  </div>
                  <div class="vr-field">
                    <label for="vr-rust-bounces">Max Bounces</label>
                    <input type="number" id="vr-rust-bounces" class="vr-input" min="1" max="12" value="5">
                  </div>
                  <div class="vr-field">
                    <label for="vr-rust-threads">CPU Threads</label>
                    <select id="vr-rust-threads" class="vr-select">
                      <option value="0" selected>Auto</option>
                      <option value="1">1</option>
                      <option value="2">2</option>
                      <option value="4">4</option>
                      <option value="8">8</option>
                    </select>
                  </div>
                </div>
                <div class="vr-grid-2">
                  <div class="vr-field">
                    <label for="vr-rust-tonemap">Color Management</label>
                    <select id="vr-rust-tonemap" class="vr-select">
                      <option value="agx" selected>AgX (Blender 4.x)</option>
                      <option value="aces">ACES Filmic</option>
                      <option value="neutral">Khronos Neutral</option>
                      <option value="linear">Linear</option>
                    </select>
                  </div>
                  <div class="vr-field">
                    <label for="vr-rust-look">AgX Look (OCIO)</label>
                    <select id="vr-rust-look" class="vr-select">
                      <option value="base" selected>None (Base)</option>
                      <option value="punchy">Punchy</option>
                      <option value="medium-high">Medium High Contrast</option>
                      <option value="high-contrast">High Contrast</option>
                      <option value="low-contrast">Low Contrast</option>
                    </select>
                  </div>
                </div>
                <div class="vr-field">
                  <label for="vr-rust-shutter"><span>Motion Blur Shutter (Camera + Object)</span><span id="vr-shutter-val">0.00</span></label>
                  <input type="range" id="vr-rust-shutter" min="0" max="1" step="0.05" value="0">
                </div>
                <div class="vr-inline-row">
                  <label class="vr-check-row"><input type="checkbox" id="vr-rust-denoise" checked> SVGF Denoise (Rust)</label>
                  <label class="vr-check-row"><input type="checkbox" id="vr-rust-temporal" checked> Temporal Anti-Flicker</label>
                </div>
              </div>

              <label class="vr-check-row" id="vr-transparent-wrap">
                <input type="checkbox" id="vr-transparent">
                <span>Film → Transparent Background (PNG Sequence / WebM)</span>
              </label>
            </div>

            <!-- 2. Camera, Dimensions & Frame Range -->
            <div class="vr-card">
              <div class="vr-card-title">
                <span>Dimensions & Timeline</span>
                <span id="vr-summary-tag" style="color:#f5a623;font-variant-numeric:tabular-nums;">101f · 3.37s</span>
              </div>

              <div class="vr-grid-2">
                <div class="vr-field">
                  <label for="vr-camera">Render Camera</label>
                  <select id="vr-camera" class="vr-select"></select>
                </div>
                <div class="vr-field">
                  <label for="vr-res-preset">Resolution Preset</label>
                  <select id="vr-res-preset" class="vr-select">
                    <option value="720p" selected>1280×720 (HD 16:9)</option>
                    <option value="1080p">1920×1080 (Full HD 16:9)</option>
                    <option value="vertical-1080">1080×1920 (9:16 Shorts/TikTok)</option>
                    <option value="vertical-720">720×1280 (9:16 Vertical HD)</option>
                    <option value="square-1080">1080×1080 (1:1 Square)</option>
                    <option value="480p">854×480 (480p Draft)</option>
                    <option value="viewport">Match Viewport</option>
                    <option value="custom">Custom…</option>
                  </select>
                </div>
              </div>

              <div class="vr-grid-3">
                <div class="vr-field">
                  <label for="vr-width">Width (px)</label>
                  <input type="number" id="vr-width" class="vr-input" min="16" max="1920" step="2" value="1280">
                </div>
                <div class="vr-field">
                  <label for="vr-height">Height (px)</label>
                  <input type="number" id="vr-height" class="vr-input" min="16" max="1920" step="2" value="720">
                </div>
                <div class="vr-field">
                  <label for="vr-scale-pct">Scale %</label>
                  <select id="vr-scale-pct" class="vr-select">
                    <option value="25">25% (Fast Test)</option>
                    <option value="50">50% (Half)</option>
                    <option value="75">75%</option>
                    <option value="100" selected>100% (Full)</option>
                  </select>
                </div>
              </div>

              <div class="vr-grid-3">
                <div class="vr-field">
                  <label for="vr-start">Start Frame</label>
                  <input type="number" id="vr-start" class="vr-input" min="0" max="10000" value="0">
                </div>
                <div class="vr-field">
                  <label for="vr-end">End Frame</label>
                  <input type="number" id="vr-end" class="vr-input" min="0" max="10000" value="100">
                </div>
                <div class="vr-field">
                  <label for="vr-step">Frame Step</label>
                  <input type="number" id="vr-step" class="vr-input" min="1" max="30" value="1">
                </div>
              </div>

              <div class="vr-inline-row" style="margin-top:6px;">
                <select id="vr-fps" class="vr-select" style="width:105px;">
                  <option value="24">24 FPS</option>
                  <option value="25">25 FPS</option>
                  <option value="30" selected>30 FPS</option>
                  <option value="60">60 FPS</option>
                </select>
                <button type="button" class="vr-btn sm" id="vr-btn-sync-tl">Sync Timeline</button>
                <button type="button" class="vr-btn sm" id="vr-btn-fit-kf">Fit Keyframes</button>
                <label class="vr-check-row" style="margin-left:auto;">
                  <input type="checkbox" id="vr-turntable"> Turntable 360°
                </label>
              </div>

              <div id="vr-physics-row" class="vr-inline-row" style="display:none;margin-top:6px;padding-top:6px;border-top:1px solid #323640;">
                <label class="vr-check-row"><input type="checkbox" id="vr-step-physics"> Step Rapier Physics during render</label>
                <button type="button" class="vr-btn sm" id="vr-btn-bake-physics">Bake to Timeline</button>
              </div>
            </div>

            <!-- 3. Output Format, Audio & Metadata Burn-In -->
            <div class="vr-card">
              <div class="vr-card-title"><span>Output, Audio & Metadata (Rust Kernel)</span></div>
              <div class="vr-cap-bar" id="vr-cap-bar">Checking browser WebCodecs capabilities…</div>

              <div class="vr-grid-2">
                <div class="vr-field">
                  <label for="vr-format">File Format</label>
                  <select id="vr-format" class="vr-select">
                    <option value="mp4" selected>MP4 · H.264 + AAC (Universal)</option>
                    <option value="webm">WebM · VP9/VP8 + Opus (Open Web)</option>
                    <option value="png-sequence">PNG Sequence (.zip · Lossless/Alpha)</option>
                  </select>
                </div>
                <div class="vr-field" id="vr-quality-field">
                  <label for="vr-quality">Encoding Quality</label>
                  <select id="vr-quality" class="vr-select">
                    <option value="draft">Draft (Fast / Small)</option>
                    <option value="standard" selected>Standard (Balanced)</option>
                    <option value="high">High (Sharp Web)</option>
                    <option value="master">Master (Studio Bitrate)</option>
                  </select>
                </div>
              </div>

              <div class="vr-field">
                <label for="vr-filename">Output Filename</label>
                <input type="text" id="vr-filename" class="vr-input" value="animation_render" placeholder="animation_render">
              </div>

              <!-- Audio Track -->
              <div id="vr-audio-section" style="margin-top:6px;padding-top:6px;border-top:1px solid #323640;">
                <div class="vr-inline-row">
                  <input type="file" id="vr-audio-input" accept="audio/*,video/*" hidden>
                  <button type="button" class="vr-btn sm" id="vr-btn-audio">🎵 Attach Audio / Music…</button>
                  <button type="button" class="vr-btn sm" id="vr-btn-mocap-audio" style="display:none;">Use Mocap Audio</button>
                  <button type="button" class="vr-btn sm" id="vr-btn-audio-clear" style="display:none;">✕</button>
                  <span id="vr-audio-label" class="vr-hint" style="margin:0;">No audio track</span>
                </div>
              </div>

              <!-- Metadata Burn-In Stamp & Look Grade (Rust video_kernel.wasm) -->
              <div style="margin-top:8px;padding-top:6px;border-top:1px solid #323640;">
                <div class="vr-inline-row" style="justify-content:space-between;">
                  <label class="vr-check-row">
                    <input type="checkbox" id="vr-metadata-burnin">
                    <span>Burn-In Metadata Stamp (Frame · Timecode · Camera)</span>
                  </label>
                  <select id="vr-metadata-pos" class="vr-select" style="width:92px;">
                    <option value="bottom" selected>Bottom</option>
                    <option value="top">Top</option>
                  </select>
                </div>
                <div class="vr-grid-3" style="margin-top:6px;">
                  <div class="vr-field">
                    <label for="vr-exposure"><span>Exposure</span><span id="vr-exp-val">1.0</span></label>
                    <input type="range" id="vr-exposure" min="0.3" max="2.5" step="0.05" value="1.0">
                  </div>
                  <div class="vr-field">
                    <label for="vr-contrast"><span>Contrast</span><span id="vr-con-val">1.0</span></label>
                    <input type="range" id="vr-contrast" min="0.5" max="1.8" step="0.05" value="1.0">
                  </div>
                  <div class="vr-field">
                    <label for="vr-vignette"><span>Vignette</span><span id="vr-vig-val">0.0</span></label>
                    <input type="range" id="vr-vignette" min="0" max="0.8" step="0.05" value="0">
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    `;

    document.body.appendChild(backdrop);
    this._backdrop = backdrop;
    this._bindDialogEvents();
  }

  _q(sel) {
    return this._backdrop?.querySelector(sel);
  }

  _bindDialogEvents() {
    const backdrop = this._backdrop;

    const close = () => {
      if (this.busy) {
        this._closeWhenDone = true;
        this.cancel();
        this._setStatus('Cancelling render…', '');
      } else {
        backdrop.hidden = true;
      }
    };

    this._q('#vr-btn-close').addEventListener('click', close);
    backdrop.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        close();
        return;
      }
      // Prevent studio viewport shortcuts (G/R/S/X/Space) while dialog is open
      e.stopPropagation();
    });

    // Engine toggle
    this._q('#vr-engine').addEventListener('change', () => {
      const val = this._q('#vr-engine').value;
      const isCyclesLike = val === 'rust' || val === 'webgpu';
      this._q('#vr-eevee-opts').style.display = isCyclesLike ? 'none' : 'block';
      this._q('#vr-cycles-opts').style.display = isCyclesLike ? 'block' : 'none';
      const badge = this._q('#vr-engine-badge');
      if (val === 'webgpu') {
        badge.textContent = 'Cycles X · WebGPU Compute + Rust BVH';
      } else if (val === 'rust') {
        badge.textContent = 'Cycles · Rust WASM Multi-Thread + SAB';
      } else {
        badge.textContent = 'EEVEE · WebGL Zero-Copy GPU';
      }
      badge.classList.toggle('rust', isCyclesLike);
      this._refreshComputedReadout();
    });

    // Resolution preset
    this._q('#vr-res-preset').addEventListener('change', () => {
      const key = this._q('#vr-res-preset').value;
      const preset = RESOLUTION_PRESETS[key];
      if (key === 'viewport') {
        const canvas = this._getEngine()?.renderer?.domElement;
        const w = Math.min(VIDEO_BUDGET.MAX_DIM, Math.max(64, canvas?.clientWidth || 1280));
        const h = Math.min(VIDEO_BUDGET.MAX_DIM, Math.max(64, canvas?.clientHeight || 720));
        this._q('#vr-width').value = w & ~1;
        this._q('#vr-height').value = h & ~1;
      } else if (preset && preset.width > 0) {
        this._q('#vr-width').value = preset.width;
        this._q('#vr-height').value = preset.height;
      }
      this._refreshComputedReadout();
    });

    const onCustomDim = () => {
      this._q('#vr-res-preset').value = 'custom';
      this._refreshComputedReadout();
    };
    this._q('#vr-width').addEventListener('input', onCustomDim);
    this._q('#vr-height').addEventListener('input', onCustomDim);

    ['#vr-scale-pct', '#vr-start', '#vr-end', '#vr-step', '#vr-fps', '#vr-format', '#vr-quality', '#vr-camera'].forEach((sel) => {
      this._q(sel).addEventListener('change', () => this._refreshComputedReadout());
      this._q(sel).addEventListener('input', () => this._refreshComputedReadout());
    });

    // Sliders readouts
    this._q('#vr-rust-shutter').addEventListener('input', (e) => {
      this._q('#vr-shutter-val').textContent = Number(e.target.value).toFixed(2);
    });
    this._q('#vr-exposure').addEventListener('input', (e) => {
      this._q('#vr-exp-val').textContent = Number(e.target.value).toFixed(2);
    });
    this._q('#vr-contrast').addEventListener('input', (e) => {
      this._q('#vr-con-val').textContent = Number(e.target.value).toFixed(2);
    });
    this._q('#vr-vignette').addEventListener('input', (e) => {
      this._q('#vr-vig-val').textContent = Number(e.target.value).toFixed(2);
    });

    // Sync Timeline & Fit Keyframes
    this._q('#vr-btn-sync-tl').addEventListener('click', () => {
      const tl = this._getTimeline();
      if (!tl) return;
      this._q('#vr-start').value = Math.max(0, Math.round(tl.startFrame || 0));
      this._q('#vr-end').value = Math.max(1, Math.round(tl.endFrame || 100));
      const fpsStr = String(Math.round(tl.fps || 30));
      const fpsSel = this._q('#vr-fps');
      if ([...fpsSel.options].some((o) => o.value === fpsStr)) fpsSel.value = fpsStr;
      this._refreshComputedReadout();
    });

    this._q('#vr-btn-fit-kf').addEventListener('click', () => {
      const tl = this._getTimeline();
      const range = detectAnimationFrameRange(tl);
      this._q('#vr-start').value = range.startFrame;
      this._q('#vr-end').value = range.endFrame;
      this._refreshComputedReadout();
      this._setStatus(
        range.hasKeyframes
          ? `Fitted range to keyframes/clip: ${range.startFrame} – ${range.endFrame}.`
          : 'No keyframes detected — using Timeline range (or enable Turntable 360°).',
        ''
      );
    });

    // Turntable quick toggle
    this._q('#vr-turntable').addEventListener('change', (e) => {
      const tl = this._getTimeline();
      if (!tl) return;
      if (e.target.checked && !tl.turntable?.active) {
        tl.startTurntable?.();
      } else if (!e.target.checked && tl.turntable?.active) {
        tl.stopTurntable?.();
      }
    });

    // Physics Bake shortcut
    this._q('#vr-btn-bake-physics').addEventListener('click', async () => {
      const sim = this._getSimulationManager();
      const tl = this._getTimeline();
      if (!sim || typeof sim.bake !== 'function') return;
      const start = Math.max(0, parseInt(this._q('#vr-start').value, 10) || 0);
      const end = Math.max(start + 1, parseInt(this._q('#vr-end').value, 10) || 100);
      const fps = tl?.fps || parseInt(this._q('#vr-fps')?.value, 10) || 30;
      this._setStatus(`Baking physics frames ${start}..${end} to Timeline…`, '');
      try {
        await sim.ensureInit?.();
        const res = sim.bake({ fps, frames: end - start, startFrame: start });
        if (!res) {
          this._setStatus('No rigid bodies to bake to Timeline.', 'err');
          return;
        }
        this._q('#vr-step-physics').checked = false;
        this._setStatus(`Physics baked to Timeline (${start}–${end}). Ready to render!`, 'ok');
      } catch (err) {
        this._setStatus(`Physics bake error: ${err?.message || err}`, 'err');
      }
    });

    // Audio upload & Mocap audio
    const audioInput = this._q('#vr-audio-input');
    this._q('#vr-btn-audio').addEventListener('click', () => audioInput.click());
    audioInput.addEventListener('change', () => {
      const f = audioInput.files?.[0];
      if (!f) return;
      this._audioFile = f;
      this._audioLabel = f.name;
      this._updateAudioUI();
    });
    this._q('#vr-btn-mocap-audio').addEventListener('click', () => {
      const mocap = this.app?.mocapUI || (typeof window !== 'undefined' ? window.mocapUI : null);
      const src = mocap?._getAudioSource?.({ includeAudio: true })
        || mocap?._uploadedFile
        || mocap?.uploadedVideoFile
        || mocap?.videoElement?.currentSrc
        || null;
      if (src) {
        this._audioFile = src;
        this._audioLabel = 'Mocap Source Video Audio';
        this._updateAudioUI();
      }
    });
    this._q('#vr-btn-audio-clear').addEventListener('click', () => {
      this._audioFile = null;
      this._audioLabel = '';
      audioInput.value = '';
      this._updateAudioUI();
    });

    // Main render actions
    this._q('#vr-btn-preview').addEventListener('click', () => this.renderPreviewFrame());
    this._q('#vr-btn-start').addEventListener('click', () => this.startRender());
    this._q('#vr-btn-cancel').addEventListener('click', () => {
      this.cancel();
      this._setStatus('Cancelling render…', '');
    });
    this._q('#vr-btn-download').addEventListener('click', () => {
      if (this._lastResult?.blob) {
        const exp = new VideoExportManager();
        exp.downloadBlob(this._lastResult.blob, this._lastResult.filename);
      }
    });
  }

  _syncDynamicOptions() {
    // Populate cameras
    const camSel = this._q('#vr-camera');
    const prevVal = camSel.value || 'active';
    const cm = this._getCameraManager();
    const activeCamObj = cm?.getActiveCameraObject?.();
    const opts = [];
    if (activeCamObj) {
      opts.push({ value: 'active', label: `Active Camera (${activeCamObj.name})` });
    }
    opts.push({ value: 'viewport', label: 'Viewport Camera (Current View)' });
    if (cm?.cameras?.length) {
      for (const entry of cm.cameras) {
        if (!entry?.group) continue;
        opts.push({ value: entry.group.uuid, label: `Camera: ${entry.group.name}` });
      }
    }
    camSel.textContent = '';
    for (const o of opts) {
      const optEl = document.createElement('option');
      optEl.value = String(o.value ?? '');
      optEl.textContent = String(o.label ?? '');
      camSel.appendChild(optEl);
    }
    if (opts.some((o) => o.value === prevVal)) camSel.value = prevVal;

    // Turntable state
    const tl = this._getTimeline();
    this._q('#vr-turntable').checked = Boolean(tl?.turntable?.active);

    // Physics row visibility
    this._q('#vr-physics-row').style.display = this._hasDynamicPhysics() ? 'flex' : 'none';

    // Mocap audio shortcut visibility
    const mocap = this.app?.mocapUI || (typeof window !== 'undefined' ? window.mocapUI : null);
    const hasMocapAudio = Boolean(mocap?._uploadedFile || mocap?.uploadedVideoFile || mocap?.videoElement?.currentSrc);
    this._q('#vr-btn-mocap-audio').style.display = hasMocapAudio ? 'inline-flex' : 'none';
    this._updateAudioUI();
  }

  _updateAudioUI() {
    const label = this._q('#vr-audio-label');
    const clearBtn = this._q('#vr-btn-audio-clear');
    if (this._audioFile) {
      label.textContent = `🎵 ${this._audioLabel || 'Audio attached'}`;
      label.style.color = '#6fdc96';
      clearBtn.style.display = 'inline-flex';
    } else {
      label.textContent = 'No audio track';
      label.style.color = '#8c95a3';
      clearBtn.style.display = 'none';
    }
  }

  _updateCapabilityBanner() {
    const bar = this._q('#vr-cap-bar');
    if (!bar) return;
    const c = this._capabilities;
    const g = this._gpuAdapterInfo;
    const parts = [];
    if (c) {
      parts.push(c.mp4 ? (c.mp4Hardware ? 'MP4 H.264 (HW GPU) ✓' : 'MP4 H.264 ✓') : 'MP4 ✗');
      parts.push(c.webm ? (c.webmHardware ? 'WebM VP9 (HW) ✓' : 'WebM VP9 ✓') : 'WebM ✗');
      parts.push('PNG ZIP ✓');
      if (c.audioWebCodecs) parts.push('Audio ✓');
    }
    if (g?.supported) {
      const tierTag = g.tier === 'discrete' ? 'Discrete GPU' : (g.tier === 'software' ? 'Software Fallback' : 'GPU');
      parts.push(`⚡ ${g.label} (${tierTag})`);
    }
    const hasWebGpu = typeof navigator !== 'undefined' && Boolean(navigator.gpu);
    const hasSab = typeof SharedArrayBuffer !== 'undefined' && typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated;
    const hwBadge = this._q('#vr-wasm-badge');
    if (hwBadge) {
      const hw = [];
      if (g?.supported && !g.isFallback) {
        hw.push(`⚡ ${g.tier === 'discrete' ? 'dGPU' : 'WebGPU'}`);
      } else if (hasWebGpu) {
        hw.push('⚡ WebGPU');
      }
      hw.push('🦀 Rust');
      if (hasSab) hw.push('🧵 SAB');
      hwBadge.textContent = hw.join(' · ');
      if (g?.supported) {
        hwBadge.title = `WebGPU High-Perf Adapter: ${g.label} (${g.tier}) · Max Buffer ${(g.maxBufferSize / (1024 * 1024)).toFixed(0)} MB`;
      }
    }
    if (parts.length) bar.textContent = `Ready: ${parts.join(' · ')}`;

    if (!c) return;
    // If current format is unsupported, auto-select the best supported one
    const fmtSel = this._q('#vr-format');
    if (fmtSel.value === 'mp4' && !c.mp4) {
      fmtSel.value = c.webm ? 'webm' : 'png-sequence';
      this._refreshComputedReadout();
    } else if (fmtSel.value === 'webm' && !c.webm) {
      fmtSel.value = c.mp4 ? 'mp4' : 'png-sequence';
      this._refreshComputedReadout();
    }
  }

  _readOptionsFromUI() {
    const format = normalizeVideoFormat(this._q('#vr-format').value);
    const rawW = parseInt(this._q('#vr-width').value, 10) || 1280;
    const rawH = parseInt(this._q('#vr-height').value, 10) || 720;
    const scalePercent = parseInt(this._q('#vr-scale-pct').value, 10) || 100;
    const { width, height } = computeScaledResolution(rawW, rawH, scalePercent, format);

    const startFrame = Math.max(0, parseInt(this._q('#vr-start').value, 10) || 0);
    const endFrame = Math.max(startFrame, parseInt(this._q('#vr-end').value, 10) || startFrame);
    const frameStep = Math.max(1, Math.min(30, parseInt(this._q('#vr-step').value, 10) || 1));
    const fps = Math.max(12, Math.min(60, parseInt(this._q('#vr-fps').value, 10) || 30));
    const totalFrames = Math.max(1, Math.floor((endFrame - startFrame) / frameStep) + 1);

    const rawEngine = this._q('#vr-engine').value;
    const engine = rawEngine === 'rust' ? 'rust' : (rawEngine === 'webgpu' ? 'webgpu' : 'raster');
    const postPreset = this._q('#vr-post-preset').value || 'studio';
    const quality = this._q('#vr-quality').value || 'standard';
    const bitrate = computeRecommendedBitrate(width, height, fps, quality);
    const transparent = Boolean(this._q('#vr-transparent').checked && format !== 'mp4');
    const camResolved = this._resolveCamera(this._q('#vr-camera').value || 'active');

    const exposure = parseFloat(this._q('#vr-exposure').value) || 1.0;
    const contrast = parseFloat(this._q('#vr-contrast').value) || 1.0;
    const vignette = parseFloat(this._q('#vr-vignette').value) || 0.0;
    const hasGrade = Math.abs(exposure - 1) > 1e-3 || Math.abs(contrast - 1) > 1e-3 || vignette > 1e-3;

    return {
      engine,
      postPreset,
      postProcess: postPreset !== 'fast',
      rustSamples: parseInt(this._q('#vr-rust-samples').value, 10) || 16,
      rustMaxBounces: parseInt(this._q('#vr-rust-bounces').value, 10) || 5,
      rustThreads: parseInt(this._q('#vr-rust-threads').value, 10) || 0,
      rustTonemap: this._q('#vr-rust-tonemap').value || 'agx',
      rustTonemapLook: this._q('#vr-rust-look')?.value || 'base',
      rustDenoise: Boolean(this._q('#vr-rust-denoise').checked),
      rustTemporal: Boolean(this._q('#vr-rust-temporal').checked),
      rustShutter: parseFloat(this._q('#vr-rust-shutter').value) || 0,
      exposure,
      width,
      height,
      fps,
      bitrate,
      startFrame,
      endFrame,
      frameStep,
      totalFrames,
      format,
      transparent,
      camera: camResolved.camera,
      cameraName: camResolved.label,
      stepPhysics: Boolean(this._q('#vr-step-physics').checked),
      audioSource: format === 'png-sequence' ? null : this._audioFile,
      includeAudio: format !== 'png-sequence' && Boolean(this._audioFile),
      metadataBurnIn: this._q('#vr-metadata-burnin').checked
        ? { position: this._q('#vr-metadata-pos').value || 'bottom' }
        : false,
      colorGrade: hasGrade
        ? { exposure: (engine === 'rust' || engine === 'webgpu') ? 1.0 : exposure, contrast, saturation: 1.0, vignette }
        : null,
      filename: this._q('#vr-filename').value?.trim() || 'animation_render',
    };
  }

  _refreshComputedReadout() {
    const opts = this._readOptionsFromUI();
    const dur = opts.totalFrames / opts.fps;
    this._q('#vr-summary-tag').textContent = `${opts.totalFrames}f · ${dur.toFixed(2)}s`;
    this._q('#vr-pill-right').textContent = `${opts.width}×${opts.height} · ${opts.fps} FPS`;

    const isPng = opts.format === 'png-sequence';
    this._q('#vr-quality-field').style.opacity = isPng ? '0.45' : '1';
    this._q('#vr-quality').disabled = isPng || this.busy;
    this._q('#vr-audio-section').style.display = isPng ? 'none' : 'block';

    const transInput = this._q('#vr-transparent');
    const transWrap = this._q('#vr-transparent-wrap');
    if (opts.format === 'mp4') {
      transInput.disabled = true;
      transWrap.style.opacity = '0.5';
      transWrap.title = 'H.264 MP4 does not support alpha transparency. Switch format to PNG Sequence (.zip) or WebM.';
    } else {
      transInput.disabled = this.busy;
      transWrap.style.opacity = '1';
      transWrap.title = '';
    }
  }

  _setControlsDisabled(disabled) {
    const inputs = this._backdrop.querySelectorAll('.vr-props-col input, .vr-props-col select, .vr-props-col button');
    inputs.forEach((el) => { el.disabled = disabled; });
    this._q('#vr-btn-start').disabled = disabled;
    this._q('#vr-btn-preview').disabled = disabled;
    this._q('#vr-btn-cancel').disabled = !disabled;
    if (!disabled) this._refreshComputedReadout();
  }

  _setStatus(text, tone = '', metrics = '') {
    const line = this._q('#vr-status-line');
    line.className = 'vr-status-line' + (tone ? ` ${tone}` : '');
    this._q('#vr-status-text').textContent = text;
    if (metrics !== undefined) this._q('#vr-status-metrics').textContent = metrics;
  }

  _paintPreviewCanvas(srcCanvas) {
    if (!srcCanvas) return;
    const dst = this._q('#vr-preview-canvas');
    const videoEl = this._q('#vr-result-video');
    const emptyEl = this._q('#vr-stage-empty');
    if (emptyEl) emptyEl.style.display = 'none';
    if (videoEl) {
      videoEl.pause?.();
      videoEl.style.display = 'none';
    }
    dst.style.display = 'block';
    if (dst.width !== srcCanvas.width || dst.height !== srcCanvas.height) {
      dst.width = srcCanvas.width;
      dst.height = srcCanvas.height;
    }
    const ctx = dst.getContext('2d');
    ctx.clearRect(0, 0, dst.width, dst.height);
    ctx.drawImage(srcCanvas, 0, 0);
  }

  _engineLabel(engine) {
    if (engine === 'webgpu') return 'WebGPU Cycles X';
    if (engine === 'rust') return 'Rust CPU Cycles';
    return 'EEVEE';
  }

  /**
   * Renders a single preview frame (current timeline frame) using the exact selected engine & settings.
   */
  async renderPreviewFrame() {
    if (this.busy) return;
    const engine = this._getEngine();
    const tl = this._getTimeline();
    if (!engine?.renderer || !engine?.scene) {
      this._setStatus('3D Engine is not ready.', 'err');
      return;
    }

    const opts = this._readOptionsFromUI();
    const curFrame = tl ? Math.round(tl.currentFrame || 0) : opts.startFrame;
    const engLabel = this._engineLabel(opts.engine);

    this.busy = true;
    this._closeWhenDone = false;
    this._abortController = new AbortController();
    this._setControlsDisabled(true);
    this._q('#vr-progress-fill').style.width = '15%';
    this._q('#vr-pill-left').textContent = `Preview Frame ${curFrame} (${engLabel})`;
    this._setStatus(`Rendering preview frame ${curFrame} (${opts.width}×${opts.height})…`, '');

    try {
      const exporter = new VideoExportManager({
        renderer: engine.renderer,
        scene: engine.scene,
        camera: opts.camera || engine.camera,
        rasterRenderer: engine.rasterRenderer || null,
        timeline: tl,
        engineInstance: engine,
      });

      const res = await exporter.renderVideo({
        ...opts,
        startFrame: curFrame,
        endFrame: curFrame,
        frameStep: 1,
        format: 'png-sequence',
        includeAudio: false,
        audioSource: null,
        signal: this._abortController.signal,
        onFramePreview: ({ canvas, samplesDone, samplesTarget, progressive }) => {
          this._paintPreviewCanvas(canvas);
          if (progressive && samplesTarget) {
            const pct = Math.round((samplesDone / samplesTarget) * 100);
            this._q('#vr-progress-fill').style.width = `${pct}%`;
            this._q('#vr-pill-left').textContent = `Frame ${curFrame} · ${samplesDone}/${samplesTarget} spp`;
          }
        },
      });

      this._q('#vr-progress-fill').style.width = '100%';
      this._q('#vr-pill-left').textContent = `Preview Frame ${curFrame} · ${res.renderMs.toFixed(0)} ms`;
      const detail = (opts.engine === 'rust' || opts.engine === 'webgpu')
        ? `${engLabel} (${opts.rustSamples} spp)`
        : `EEVEE (${opts.postPreset})`;
      this._setStatus(
        `Preview complete: Frame ${curFrame} · ${opts.width}×${opts.height} · ${detail}.`,
        'ok',
        `${res.renderMs.toFixed(0)} ms`
      );
    } catch (err) {
      if (err?.name === 'AbortError') {
        this._setStatus('Preview cancelled.', '');
      } else {
        this._setStatus(`Preview error: ${err?.message || err}`, 'err');
      }
    } finally {
      this.busy = false;
      this._abortController = null;
      this._setControlsDisabled(false);
      if (this._closeWhenDone) {
        this._backdrop.hidden = true;
      }
    }
  }

  /**
   * Executes full deterministic animation render (MP4 / WebM / PNG Sequence ZIP).
   */
  async startRender() {
    if (this.busy) return;
    const engine = this._getEngine();
    const tl = this._getTimeline();
    const sim = this._getSimulationManager();
    if (!engine?.renderer || !engine?.scene) {
      this._setStatus('3D Engine is not ready.', 'err');
      return;
    }

    const opts = this._readOptionsFromUI();
    if (opts.totalFrames > VIDEO_BUDGET.MAX_FRAMES) {
      this._setStatus(`Frame count ${opts.totalFrames} exceeds maximum budget (${VIDEO_BUDGET.MAX_FRAMES} frames). Increase Step or reduce range.`, 'err');
      return;
    }

    const engLabel = this._engineLabel(opts.engine);
    this.busy = true;
    this._closeWhenDone = false;
    this._abortController = new AbortController();
    this._setControlsDisabled(true);
    this._q('#vr-btn-download').hidden = true;
    this._q('#vr-progress-fill').style.width = '0%';
    this._q('#vr-pill-left').textContent = `Starting ${engLabel}…`;
    this._setStatus(`Rendering ${opts.totalFrames} frames (${opts.width}×${opts.height} @ ${opts.fps} FPS · ${engLabel})…`, '');

    try {
      const exporter = new VideoExportManager({
        renderer: engine.renderer,
        scene: engine.scene,
        camera: opts.camera || engine.camera,
        rasterRenderer: engine.rasterRenderer || null,
        timeline: tl,
        engineInstance: engine,
      });

      let lastPreviewAt = 0;
      const res = await exporter.renderVideo({
        ...opts,
        allowWebmFallback: opts.format === 'mp4',
        simulationManager: sim,
        signal: this._abortController.signal,
        onFramePreview: ({ canvas, frame, frameIndex, totalFrames, samplesDone, samplesTarget, progressive }) => {
          const now = performance.now();
          // Paint every frame for Rust Cycles, or throttle to ~15fps during fast EEVEE renders
          if (opts.engine === 'rust' || opts.engine === 'webgpu' || frameIndex === 0 || frameIndex === totalFrames - 1 || now - lastPreviewAt >= 65) {
            lastPreviewAt = now;
            this._paintPreviewCanvas(canvas);
          }
          if (progressive && samplesTarget) {
            this._q('#vr-pill-left').textContent = `Frame ${frame} (${frameIndex + 1}/${totalFrames}) · ${samplesDone}/${samplesTarget} spp`;
          } else {
            this._q('#vr-pill-left').textContent = `Frame ${frame} (${frameIndex + 1}/${totalFrames}) · ${formatTimecode(frame, opts.fps)}`;
          }
        },
        onProgress: ({ progress, frame, frameIndex, totalFrames, elapsedMs, fpsRate, message }) => {
          const pct = Math.min(100, (progress || 0) * 100);
          this._q('#vr-progress-fill').style.width = `${pct.toFixed(1)}%`;
          const elapsedSec = (elapsedMs || 0) / 1000;
          const remaining = progress > 0.02 ? Math.max(0, elapsedSec * (1 / progress - 1)) : 0;
          const statusMsg = message
            ? `${message} · ${pct.toFixed(0)}%`
            : `Rendering frame ${frame} (${frameIndex + 1}/${totalFrames}) · ${pct.toFixed(0)}%`;
          this._setStatus(
            statusMsg,
            '',
            `${(fpsRate || 0).toFixed(1)} fps · ${formatSeconds(elapsedSec)}` + (remaining > 0.4 ? ` · ETA ~${formatSeconds(remaining)}` : '')
          );
        },
      });

      this._revokeLastUrl();
      this._lastResult = res;
      this._lastBlobUrl = URL.createObjectURL(res.blob);

      // Show inline video player for MP4 / WebM
      const videoEl = this._q('#vr-result-video');
      const canvasEl = this._q('#vr-preview-canvas');
      const emptyEl = this._q('#vr-stage-empty');
      if (res.format === 'mp4' || res.format === 'webm') {
        if (emptyEl) emptyEl.style.display = 'none';
        canvasEl.style.display = 'none';
        videoEl.src = this._lastBlobUrl;
        videoEl.style.display = 'block';
        videoEl.play().catch(() => {});
      }

      const dlBtn = this._q('#vr-btn-download');
      dlBtn.hidden = false;
      dlBtn.textContent = `⬇ Download ${res.format === 'png-sequence' ? 'PNG ZIP' : res.format.toUpperCase()} (${formatBytes(res.bytes)})`;

      this._q('#vr-progress-fill').style.width = '100%';
      const refitTag = res.bvhRefits > 0 ? ` · ${res.bvhRefits} BVH refits` : '';
      const audioTag = res.hasAudio ? ` + ${res.audioCodec || 'Audio'}` : '';
      this._q('#vr-pill-left').textContent = `Done · ${res.frameCount}f · ${res.duration.toFixed(2)}s`;
      this._setStatus(
        `Render complete: ${res.width}×${res.height} @ ${res.fps} FPS · ${res.format.toUpperCase()}${audioTag} · ${formatBytes(res.bytes)}${refitTag}`,
        'ok',
        `${formatSeconds(res.renderMs / 1000)} (${res.avgFps.toFixed(1)} fps)`
      );
    } catch (err) {
      if (err?.name === 'AbortError') {
        this._q('#vr-pill-left').textContent = 'Cancelled';
        this._setStatus('Render cancelled by user.', '');
      } else {
        this._q('#vr-pill-left').textContent = 'Error';
        this._setStatus(`Render error: ${err?.message || err}`, 'err');
      }
    } finally {
      this.busy = false;
      this._abortController = null;
      this._setControlsDisabled(false);
      if (this._closeWhenDone) {
        this._backdrop.hidden = true;
      }
    }
  }
}
