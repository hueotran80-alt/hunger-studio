/**
 * Web Blender Studio - Deterministic Video & Animation Export Engine
 * Exports timeline animation frame-by-frame with zero dropped frames:
 * - MP4 (H.264 + AAC) via WebCodecs + mp4-muxer
 * - WebM (VP9/VP8 + Opus) via WebCodecs + EBML WebMMuxer
 * - PNG Sequence (.zip) via fflate (lossless, transparent alpha supported, works in all browsers)
 * Supports WebGL Look-Dev Raster (Fast/Studio/Cinematic), Rust CPU Path Tracer, and Hero Frames.
 * File: js/render/video-export.js
 */

import { VideoEncoderClient } from './video-encoder.js';
import { FrameSource } from './frame-source.js';
import { prepareAudioTrackForExport } from './audio-extractor.js';
import { runWithRenderSubdiv } from '../core/render-subdiv.js';
import { applyColorGradeInPlace, burnInMetadataInPlace } from './video-kernel-bridge.js';

export function formatTimecode(frame, fps = 30) {
  const rawFps = Number(fps);
  const safeFps = Number.isFinite(rawFps) && rawFps > 0 ? Math.max(1, Math.round(rawFps)) : 30;
  const rawFrame = Number(frame);
  const f = Number.isFinite(rawFrame) ? Math.max(0, Math.round(rawFrame)) : 0;
  const ff = f % safeFps;
  const totalSec = Math.floor(f / safeFps);
  const ss = totalSec % 60;
  const totalMin = Math.floor(totalSec / 60);
  const mm = totalMin % 60;
  const hh = Math.floor(totalMin / 60);
  const pad2 = (n) => String(n).padStart(2, '0');
  return `${pad2(hh)}:${pad2(mm)}:${pad2(ss)}:${pad2(ff)}`;
}

export const VIDEO_BUDGET = {
  MAX_WIDTH: 1920,
  MAX_HEIGHT: 1080,
  MAX_DIM: 1920,
  MAX_PIXELS: 1920 * 1080,
  MAX_FRAMES: 1800,
  MAX_BYTES: 256 * 1024 * 1024, // 256 MiB
};

export function normalizeVideoFormat(rawFormat = 'mp4') {
  const f = String(rawFormat || 'mp4').toLowerCase().trim();
  if (f === 'webm' || f === 'vp9' || f === 'vp8') return 'webm';
  if (f === 'png' || f === 'png-sequence' || f === 'png_sequence' || f === 'zip' || f === 'frames') {
    return 'png-sequence';
  }
  if (f === 'auto') return 'auto';
  return 'mp4';
}

export function buildExportFilename(baseName, format, width, height) {
  const ext = format === 'webm' ? 'webm' : (format === 'png-sequence' ? 'zip' : 'mp4');
  const raw = String(baseName || '').trim();
  if (!raw) {
    return `blender_render_${width}x${height}_${Date.now()}.${ext}`;
  }
  const clean = raw
    .replace(/[<>:"/\\|?*\x00-\x1f]+/g, '_')
    .replace(/\.(mp4|webm|zip)$/i, '')
    .replace(/^\.+|\.+$/g, '')
    .trim();
  return `${clean || 'blender_render'}.${ext}`;
}

export class VideoExportManager {
  /**
   * @param {Object} options
   * @param {THREE.WebGLRenderer} options.renderer
   * @param {THREE.Scene} options.scene
   * @param {THREE.Camera} options.camera
   * @param {RasterRenderer} [options.rasterRenderer]
   * @param {TimelineEngine} options.timeline
   * @param {Object} [options.engineInstance] Optional BlenderEngine instance (paused during export to avoid rAF races)
   */
  constructor(options = {}) {
    this.renderer = options.renderer;
    this.scene = options.scene;
    this.camera = options.camera;
    this.rasterRenderer = options.rasterRenderer || null;
    this.timeline = options.timeline || null;
    this.engineInstance = options.engineInstance || null;
    this.isExporting = false;
    // Look-dev mặc định cho video: dùng đúng preset đang bật ở viewport.
    this.postProcess = options.postProcess !== false;
    this.postPreset = options.postPreset || null;
  }

  /**
   * Validates render request against resource budget.
   * Supports landscape (1920x1080), portrait (1080x1920), and square (1080x1080) up to 2.07 MP.
   */
  validateBudget(options = {}) {
    const format = normalizeVideoFormat(options.format || 'mp4');
    let width = Math.round(Number(options.width) || 1280);
    let height = Math.round(Number(options.height) || 720);
    const startFrame = options.startFrame !== undefined
      ? Math.round(Number(options.startFrame))
      : Math.round(this.timeline?.startFrame || 0);
    const rawEnd = options.endFrame !== undefined
      ? Math.round(Number(options.endFrame))
      : Math.round(this.timeline?.endFrame || 100);
    const endFrame = Math.max(startFrame, rawEnd);
    const frameStep = Math.max(1, Math.min(60, Math.round(Number(options.frameStep) || 1)));
    const totalFrames = Math.max(1, Math.floor((endFrame - startFrame) / frameStep) + 1);

    if (width < 16 || height < 16) {
      throw new Error(`Video resolution ${width}x${height} is below minimum 16x16`);
    }
    if (
      width > VIDEO_BUDGET.MAX_DIM ||
      height > VIDEO_BUDGET.MAX_DIM ||
      (width * height) > VIDEO_BUDGET.MAX_PIXELS
    ) {
      throw new Error(
        `Video resolution ${width}x${height} exceeds budget maximum ${VIDEO_BUDGET.MAX_WIDTH}x${VIDEO_BUDGET.MAX_HEIGHT}`
      );
    }
    if (totalFrames > VIDEO_BUDGET.MAX_FRAMES) {
      throw new Error(
        `Frame count ${totalFrames} exceeds budget maximum ${VIDEO_BUDGET.MAX_FRAMES} frames`
      );
    }

    // H.264 / VP9 YUV420p requires even dimensions
    if (format !== 'png-sequence') {
      width = Math.max(16, width & ~1);
      height = Math.max(16, height & ~1);
    }

    return { width, height, startFrame, endFrame, frameStep, totalFrames, format };
  }

  /**
   * Renders the timeline animation frame-by-frame and exports to MP4, WebM, or PNG Sequence ZIP.
   * @param {Object} [options]
   * @param {number} [options.width=1280]
   * @param {number} [options.height=720]
   * @param {number} [options.fps=30]
   * @param {number} [options.bitrate=6000000]
   * @param {number} [options.startFrame]
   * @param {number} [options.endFrame]
   * @param {number} [options.frameStep=1]
   * @param {'mp4'|'webm'|'auto'|'png-sequence'} [options.format='mp4']
   * @param {string} [options.filename]
   * @param {'raster'|'rust'} [options.engine='raster']
   * @param {boolean} [options.postProcess=true]
   * @param {'fast'|'studio'|'cinematic'} [options.postPreset]
   * @param {boolean} [options.transparent=false] Transparent alpha background (PNG sequence / WebM)
   * @param {THREE.Camera} [options.camera] Override render camera
   * @param {Object} [options.engineInstance] Optional BlenderEngine instance to pause during export
   * @param {Object} [options.simulationManager] Optional Rapier SimulationManager
   * @param {boolean} [options.stepPhysics=false] Step physics deterministically per frame during export
   * @param {AbortSignal} [options.signal]
   * @param {Function} [options.onProgress] ({ progress, frame, frameIndex, totalFrames, elapsedMs, fpsRate }) => void
   * @param {Function} [options.onFramePreview] ({ canvas, frame, frameIndex, totalFrames, frameHash }) => void
   * @returns {Promise<Object>}
   */
  async renderVideo(options = {}) {
    if (this.isExporting) {
      throw new Error('A video render job is already running');
    }

    const { width, height, startFrame, endFrame, frameStep, totalFrames, format: requestedFormat } =
      this.validateBudget(options);
    const fps = Math.max(1, Math.min(120, Math.round(Number(options.fps) || (this.timeline?.fps || 30))));
    const bitrate = Math.max(500_000, Math.min(40_000_000, Math.round(Number(options.bitrate) || 6_000_000)));
    const signal = options.signal || null;
    const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;
    const onFramePreview = typeof options.onFramePreview === 'function' ? options.onFramePreview : null;
    const renderCamera = options.camera || this.camera;
    const engineInst = options.engineInstance || this.engineInstance || null;
    const simManager = options.simulationManager || null;
    const stepPhysics = Boolean(
      options.stepPhysics &&
      simManager &&
      (typeof simManager.stepFrames === 'function' || typeof simManager.step === 'function')
    );
    if (stepPhysics && !simManager.ready && typeof simManager.ensureInit === 'function') {
      await simManager.ensureInit();
    }

    // Hero frames option: e.g. [0] or { frames: [0], samples: 16 }
    const heroConfig = options.heroFrames;
    const heroFramesSet = new Set(
      Array.isArray(heroConfig)
        ? heroConfig
        : (Array.isArray(heroConfig?.frames) ? heroConfig.frames : [])
    );
    const heroSamples = Math.min(
      typeof heroConfig?.samples === 'number' ? heroConfig.samples : 16,
      32
    );
    let pathtraceSession = null;

    // engine:'webgpu' → Hybrid Rust BVH2 + WebGPU Compute Path Tracer (falls back to 'rust' if WebGPU unavailable).
    // engine:'rust'   → Rust CPU Path Tracer (cached worker pool + SharedArrayBuffer parallel denoise + O(N) BVH refit).
    let engineKind = options.engine === 'webgpu' ? 'webgpu' : (options.engine === 'rust' ? 'rust' : 'raster');
    const isCycles = engineKind === 'rust' || engineKind === 'webgpu';
    const rustOpts = isCycles
      ? {
          samples: Math.min(options.rustSamples || 16, 256),
          maxBounces: Math.max(1, Math.min(12, Math.round(options.rustMaxBounces ?? 5))),
          denoise: options.rustDenoise !== false,
          adaptiveThreshold: options.rustAdaptive ?? 0.015,
          fixedSeed: options.rustFixedSeed !== false,
          temporalReproject: options.rustTemporal !== false,
          temporalBlend: options.rustTemporalBlend ?? 0.7,
          shutter: Math.max(0, Math.min(1, Number(options.rustShutter ?? options.motionBlurShutter ?? 0) || 0)),
          exposure: Number.isFinite(options.exposure) ? options.exposure : (this.renderer?.toneMappingExposure || 1),
          tonemap: options.rustTonemap || 'agx',
          tonemapLook: options.rustTonemapLook || options.tonemapLook || 'base',
          threads: options.rustThreads || 0,
        }
      : null;
    const colorGrade = options.colorGrade || null;
    const metadataBurnIn = options.metadataBurnIn || false;
    const metadataPosition = (typeof metadataBurnIn === 'object' && metadataBurnIn?.position) || 'bottom';
    const cameraLabel = options.cameraName || renderCamera?.parent?.name || renderCamera?.name || 'Viewport';
    let rustCache = null;
    let webgpuTracer = null;

    // Aborting before anything is allocated must still surface as AbortError.
    if (signal?.aborted) {
      throw new DOMException('Video render cancelled by user', 'AbortError');
    }

    // Resolve 'auto' format based on browser WebCodecs capabilities
    let resolvedFormat = requestedFormat;
    if (resolvedFormat === 'auto') {
      const caps = await VideoEncoderClient.probeCapabilities(width, height, fps);
      resolvedFormat = caps.mp4 ? 'mp4' : (caps.webm ? 'webm' : 'png-sequence');
    }

    const isPngSequence = resolvedFormat === 'png-sequence';
    const transparent = Boolean(options.transparent && resolvedFormat !== 'mp4');
    const filename = buildExportFilename(options.filename, resolvedFormat, width, height);

    this.isExporting = true;

    const frameSource = new FrameSource({
      renderer: this.renderer,
      scene: this.scene,
      camera: renderCamera,
      rasterRenderer: this.rasterRenderer,
      width,
      height,
      transparent,
      postProcess: options.postProcess !== undefined ? options.postProcess : this.postProcess,
      preset: options.postPreset !== undefined ? options.postPreset : this.postPreset,
    });

    let encoder = null;
    let preparedAudio = null;
    const includeAudio = !isPngSequence && options.includeAudio !== false;
    const audioSource = includeAudio ? (options.audioSource || options.audioBuffer || null) : null;
    const audioStartSec = Number.isFinite(options.audioStartSec)
      ? Math.max(0, options.audioStartSec)
      : (startFrame / fps);
    const clipDurationSec = totalFrames / fps;

    const origFrame = this.timeline ? this.timeline.currentFrame : 0;
    const origPlaying = this.timeline ? this.timeline.isPlaying : false;
    const origTimelineEnd = this.timeline ? this.timeline.endFrame : undefined;
    if (this.timeline && origPlaying) {
      this.timeline.pause();
    }
    if (this.timeline && endFrame > this.timeline.endFrame) {
      this.timeline.endFrame = endFrame;
    }

    // Pause viewport rAF loop, suppress seekToFrame side-renders & lock ViewportGovernor at full LOD0
    const prevEngineRunning = Boolean(engineInst?.isRunning);
    const prevOverrideSize = engineInst ? engineInst._renderOverrideSize : null;
    const prevControlsEnabled = engineInst?.controls ? engineInst.controls.enabled : null;
    const prevSuppressRender = engineInst ? Boolean(engineInst._suppressRender) : false;
    const prevGovEnabled = engineInst?.viewportGovernor ? Boolean(engineInst.viewportGovernor.enabled) : null;
    if (engineInst) {
      if (prevEngineRunning && typeof engineInst.stop === 'function') {
        engineInst.stop();
      }
      engineInst._suppressRender = true;
      if (engineInst.viewportGovernor) {
        engineInst.viewportGovernor.enabled = false;
        engineInst.viewportGovernor.isNavigating = false;
        engineInst.viewportGovernor.lowFpsProtection = false;
      }
      engineInst._renderOverrideSize = { width, height };
      if (engineInst.controls) engineInst.controls.enabled = false;
    }

    const startedAt = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const pngArchive = isPngSequence ? {} : null;

    return await runWithRenderSubdiv(this.scene, async () => {
      try {
        await frameSource.init();

        if (audioSource && !isPngSequence) {
          try {
            preparedAudio = await prepareAudioTrackForExport(audioSource, {
              startSec: audioStartSec,
              durationSec: clipDurationSec,
              bitrate: options.audioBitrate || 128_000,
              codec: resolvedFormat === 'webm' ? 'opus' : 'aac',
              signal,
            });
          } catch (err) {
            if (err?.name === 'AbortError') throw err;
            console.warn('[VideoExport] Audio decode/prepare skipped:', err?.message || err);
            preparedAudio = null;
          }
        }

        if (!isPngSequence) {
          encoder = new VideoEncoderClient({
            width,
            height,
            fps,
            bitrate,
            format: resolvedFormat,
            audio: preparedAudio ? {
              codec: preparedAudio.codec,
              webcodecsCodec: preparedAudio.webcodecsCodec,
              numberOfChannels: preparedAudio.numberOfChannels,
              sampleRate: preparedAudio.sampleRate,
              bitrate: preparedAudio.bitrate,
            } : null,
          });
          await encoder.init();

          // If MP4 failed to configure (e.g. open-source Chromium without H.264) and caller allowed fallback
          if (!encoder.canEncode() && options.allowWebmFallback && resolvedFormat === 'mp4') {
            encoder.dispose();
            resolvedFormat = 'webm';
            encoder = new VideoEncoderClient({
              width,
              height,
              fps,
              bitrate,
              format: 'webm',
              audio: null,
            });
            await encoder.init();
          }

          if (!encoder.canEncode()) {
            throw new Error(
              `This browser does not support WebCodecs ${resolvedFormat.toUpperCase()} encoding. ` +
              'Switch output format to WebM or PNG Sequence (.zip), or use Chrome/Edge.'
            );
          }
        }

        if (stepPhysics) {
          try {
            if (typeof simManager.init === 'function') await simManager.init();
            else if (typeof simManager.ensureReady === 'function') await simManager.ensureReady();
            if (typeof simManager.reset === 'function') simManager.reset();
          } catch (err) {
            console.warn('[VideoExport] Physics init warning:', err?.message || err);
          }
        }

        const padWidth = Math.max(4, String(endFrame).length);
        const yieldFrame = () => new Promise((resolve) => setTimeout(resolve, 0));
        let lastYieldAt = typeof performance !== 'undefined' ? performance.now() : Date.now();
        const frameDurationUs = Math.round(1_000_000 / fps);
        let physicsAccum = 0;

        for (let i = 0; i < totalFrames; i++) {
          if (signal?.aborted) {
            throw new DOMException('Video render cancelled by user', 'AbortError');
          }

          const currentFrame = startFrame + i * frameStep;
          if (this.timeline) {
            this.timeline.seekToFrame(currentFrame, true);
          }
          if (stepPhysics && i > 0) {
            try {
              if (typeof simManager.stepFrames === 'function') {
                const fixedDt = simManager.fixedDt || (1 / 60);
                physicsAccum += frameStep / fps;
                const subSteps = Math.floor((physicsAccum + 1e-9) / fixedDt);
                if (subSteps > 0) {
                  simManager.stepFrames(subSteps);
                  physicsAccum -= subSteps * fixedDt;
                }
              } else {
                simManager.step(frameStep / fps);
              }
            } catch (_) {}
          }
          if (typeof options.onBeforeFrame === 'function') {
            await options.onBeforeFrame({
              frameIndex: i,
              currentFrame,
              timeSec: i / fps,
              totalFrames,
            });
          }

          const timestampUs = Math.round((i * 1_000_000) / fps);
          const engineTag = engineKind === 'webgpu'
            ? `WEBGPU CYCLES ${rustOpts.samples}SPP`
            : (engineKind === 'rust' ? `RUST CYCLES ${rustOpts.samples}SPP` : 'WEBGL EEVEE');
          const metadataText = metadataBurnIn
            ? (typeof metadataBurnIn === 'object' && typeof metadataBurnIn.format === 'function'
                ? metadataBurnIn.format({ frame: currentFrame, frameIndex: i, totalFrames, fps, width, height, cameraLabel, engine: engineKind })
                : `F:${String(currentFrame).padStart(padWidth, '0')} | ${formatTimecode(currentFrame, fps)} | CAM:${cameraLabel} | ${engineTag} | ${width}X${height}`)
            : null;

          let frameInput = null;
          let previewCanvas = null;
          let frameHash = 0n;

          if (engineKind === 'webgpu' && rustOpts) {
            if (!rustCache) rustCache = { pool: null, kernel: null, bytes: null, basePacked: null, refitCount: 0, webgpu: null };
            if (!webgpuTracer) {
              try {
                const { WebGPUPathTracer } = await import('./webgpu-pathtracer.js');
                const tracer = new WebGPUPathTracer();
                const ok = await tracer.init();
                if (ok) {
                  webgpuTracer = tracer;
                } else {
                  console.warn('[VideoExport] WebGPU unavailable — falling back to Rust CPU Path Tracer.');
                  engineKind = 'rust';
                }
              } catch (err) {
                console.warn('[VideoExport] WebGPU init failed — falling back to Rust CPU Path Tracer:', err?.message || err);
                engineKind = 'rust';
              }
            }
            if (webgpuTracer) {
              try {
                const gpuCanvas = await this._renderWebGpuFrame({
                  tracer: webgpuTracer,
                  camera: renderCamera,
                  width,
                  height,
                  transparent,
                  signal,
                  frameIdx: i,
                  totalFrames,
                  rustCache,
                  colorGrade,
                  metadataText,
                  metadataPosition,
                  onChunkProgress: onFramePreview
                    ? ({ samplesDone, samplesTarget }) => {
                        onFramePreview({
                          canvas: null,
                          frame: currentFrame,
                          frameIndex: i,
                          totalFrames,
                          samplesDone,
                          samplesTarget,
                          progressive: true,
                        });
                      }
                    : null,
                  ...rustOpts,
                });
                frameInput = gpuCanvas;
                previewCanvas = gpuCanvas;
              } catch (err) {
                if (err?.name === 'WebGPUDeviceLostError') {
                  console.warn('[VideoExport] WebGPU device lost mid-render — seamlessly switching to Rust CPU Path Tracer:', err.message);
                  try { webgpuTracer.dispose(); } catch (_) {}
                  webgpuTracer = null;
                  engineKind = 'rust';
                } else {
                  throw err;
                }
              }
            }
          }

          if (engineKind === 'rust' && rustOpts && !frameInput) {
            if (!rustCache) rustCache = { pool: null, kernel: null, bytes: null, basePacked: null, refitCount: 0 };
            const rustCanvas = await this._renderRustFrame({
              camera: renderCamera,
              width,
              height,
              transparent,
              signal,
              frameIdx: i,
              currentFrame,
              totalFrames,
              rustCache,
              colorGrade,
              metadataText,
              metadataPosition,
              onPassPreview: onFramePreview
                ? (passCanvas, doneSamples) => {
                    onFramePreview({
                      canvas: passCanvas,
                      frame: currentFrame,
                      frameIndex: i,
                      totalFrames,
                      samplesDone: doneSamples,
                      samplesTarget: rustOpts.samples,
                      progressive: true,
                    });
                  }
                : null,
              ...rustOpts,
            });
            frameInput = rustCanvas;
            previewCanvas = rustCanvas;
          } else if (!frameInput && heroFramesSet.has(currentFrame)) {
            console.warn(
              `[VideoExport] Hero frame ${currentFrame} rendered with path-tracing (samples=${heroSamples}). ` +
              'Warning: Video animation sequences may exhibit temporal flicker between frames.'
            );
            if (!pathtraceSession) {
              const { PathTraceSession } = await import('./pathtrace-session.js');
              pathtraceSession = new PathTraceSession({
                scene: this.scene,
                camera: renderCamera,
                renderer: this.renderer,
                timeline: this.timeline,
              });
            }
            const ptResult = await pathtraceSession.renderHeroFrame({
              frameIndex: currentFrame,
              samples: heroSamples,
              width,
              height,
              denoise: true,
              signal,
            });
            frameInput = ptResult?.canvas || frameSource.canvas;
            previewCanvas = frameInput;
          }
          let ownedVideoFrame = null;
          try {
            if (!frameInput) {
              const needPixels = isPngSequence || Boolean(colorGrade || metadataText || transparent);
              const captured = frameSource.captureFrame({
                timestampUs,
                durationUs: frameDurationUs,
                createVideoFrame: !isPngSequence,
                zeroCopy: !needPixels,
                needPixels,
                drawToCanvas: needPixels && (isPngSequence || Boolean(onFramePreview)),
                colorGrade,
                metadataText,
                metadataPosition,
              });
              frameHash = captured.frameHash;
              ownedVideoFrame = captured.videoFrame || null;
              frameInput = captured.videoFrame || captured.canvas || frameSource.canvas;
              previewCanvas = captured.canvas || frameSource.canvas;
            }

            if (isPngSequence) {
              const pngBytes = await frameSource.encodeCanvasToPngBytes(previewCanvas);
              const frameLabel = String(currentFrame).padStart(padWidth, '0');
              pngArchive[`frame_${frameLabel}.png`] = pngBytes;
            } else {
              await encoder.addFrame(frameInput, i, timestampUs);
            }
          } finally {
            if (ownedVideoFrame && typeof ownedVideoFrame.close === 'function') {
              try {
                ownedVideoFrame.close();
              } catch (_) {}
            }
          }

          if (onFramePreview && previewCanvas) {
            try {
              onFramePreview({
                canvas: previewCanvas,
                frame: currentFrame,
                frameIndex: i,
                totalFrames,
                frameHash,
              });
            } catch (_) {}
          }

          if (onProgress) {
            const elapsedMs = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - startedAt;
            const fpsRate = elapsedMs > 0 ? ((i + 1) * 1000) / elapsedMs : 0;
            onProgress({
              progress: (i + 1) / totalFrames,
              frame: currentFrame,
              frameIndex: i,
              totalFrames,
              elapsedMs,
              fpsRate,
            });
          }

          // Yield periodically (~40ms cadence) so Cancel & preview stay responsive without 4ms/frame timer clamp penalty
          if (onFramePreview || onProgress) {
            const nowMs = typeof performance !== 'undefined' ? performance.now() : Date.now();
            if (nowMs - lastYieldAt >= 40) {
              lastYieldAt = nowMs;
              await yieldFrame();
            }
          }
        }

        let blob;
        let hasAudio = false;
        let videoCodec = null;
        let audioCodec = null;
        let mimeType = 'video/mp4';

        if (isPngSequence) {
          const { zipSync, strToU8 } = await import('three/addons/libs/fflate.module.js');
          const manifest = {
            studio: 'Web Blender Studio',
            format: 'png-sequence',
            width,
            height,
            fps,
            startFrame,
            endFrame,
            frameStep,
            frameCount: totalFrames,
            duration: totalFrames / fps,
            engine: engineKind,
            transparent,
            createdAt: new Date().toISOString(),
          };
          pngArchive['render_manifest.json'] = strToU8(JSON.stringify(manifest, null, 2));
          // PNGs are already deflated, level 0 makes zipping instant with zero CPU waste
          const zipped = zipSync(pngArchive, { level: 0 });
          mimeType = 'application/zip';
          blob = new Blob([zipped], { type: mimeType });
          videoCodec = 'png';
        } else {
          if (preparedAudio && encoder.audioEncoder) {
            await encoder.addAudioPcm(preparedAudio.channels, preparedAudio.sampleRate, signal);
          }
          blob = await encoder.finalize({ requireFrames: true });
          hasAudio = encoder.hasAudio();
          videoCodec = encoder.activeVideoCodec;
          audioCodec = hasAudio ? encoder.activeAudioCodec : null;
          mimeType = encoder.mimeType || (resolvedFormat === 'webm' ? 'video/webm' : 'video/mp4');
        }

        const renderMs = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - startedAt;
        if (blob && blob.size > VIDEO_BUDGET.MAX_BYTES) {
          throw new Error(
            `Exported video (${(blob.size / (1024 * 1024)).toFixed(1)} MB) exceeds 256 MB budget limit.`
          );
        }
        const duration = totalFrames / fps;
        const finalFilename = buildExportFilename(options.filename, resolvedFormat, width, height);

        return {
          blob,
          filename: finalFilename,
          format: resolvedFormat,
          mimeType,
          duration,
          frameCount: totalFrames,
          startFrame,
          endFrame,
          frameStep,
          width,
          height,
          fps,
          hasAudio,
          videoCodec,
          audioCodec,
          engine: engineKind,
          transparent,
          bvhRefits: rustCache?.refitCount || 0,
          renderMs,
          avgFps: renderMs > 0 ? (totalFrames * 1000) / renderMs : 0,
          bytes: blob?.size || 0,
        };
      } finally {
        this.isExporting = false;
        webgpuTracer?.dispose();
        rustCache?.pool?.dispose();
        frameSource.dispose();
        encoder?.dispose();

        if (stepPhysics && typeof simManager.reset === 'function') {
          try { simManager.reset(); } catch (_) {}
        }

        // Restore timeline state
        if (this.timeline) {
          if (origTimelineEnd !== undefined) this.timeline.endFrame = origTimelineEnd;
          this.timeline.seekToFrame(origFrame, true);
        }

        // Restore engine rAF loop & viewport controls
        if (engineInst) {
          engineInst._suppressRender = prevSuppressRender;
          if (engineInst.viewportGovernor && prevGovEnabled !== null) {
            engineInst.viewportGovernor.enabled = prevGovEnabled;
          }
          engineInst._renderOverrideSize = prevOverrideSize;
          if (engineInst.controls && prevControlsEnabled !== null) {
            engineInst.controls.enabled = prevControlsEnabled;
          }
          if (typeof engineInst.onResize === 'function') {
            engineInst.onResize();
          }
          if (prevEngineRunning && typeof engineInst.start === 'function') {
            engineInst.start();
          } else if (typeof engineInst.requestRender === 'function') {
            engineInst.requestRender();
          }
        }
      }
    });
  }

  async _renderWebGpuFrame({
    tracer,
    camera: srcCamera = null,
    width,
    height,
    transparent = false,
    samples = 16,
    maxBounces = 5,
    denoise = true,
    signal = null,
    frameIdx = 0,
    totalFrames = 1,
    rustCache = null,
    adaptiveThreshold = 0.025,
    fixedSeed = true,
    temporalReproject = true,
    shutter = 0,
    exposure = 1,
    tonemap = 'agx',
    tonemapLook = 'base',
    colorGrade = null,
    metadataText = null,
    metadataPosition = 'bottom',
    onChunkProgress = null,
  }) {
    if (signal?.aborted) throw new DOMException('Video render cancelled by user', 'AbortError');
    const { packSceneForRust, packSceneGeometryForRefit } = await import('./rust-scene-pack.js');
    const activeCam = srcCamera || this.camera;
    if (typeof this.scene?.updateMatrixWorld === 'function') this.scene.updateMatrixWorld(true);
    if (typeof activeCam?.updateMatrixWorld === 'function') activeCam.updateMatrixWorld(true);

    const camera = activeCam.clone();
    if (camera.isPerspectiveCamera) {
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
    } else if (camera.isOrthographicCamera) {
      const halfH = (camera.top - camera.bottom) / 2;
      camera.left = -halfH * (width / height);
      camera.right = halfH * (width / height);
      camera.updateProjectionMatrix();
    }
    camera.matrixWorld.copy(activeCam.matrixWorld);

    let packed = null;
    if (rustCache?.basePacked) {
      packed = packSceneGeometryForRefit({
        scene: this.scene, camera, width, height,
        prevPacked: rustCache.basePacked, transparent, shutter,
      });
      if (packed) rustCache.refitCount = (rustCache.refitCount || 0) + 1;
    }
    if (!packed) {
      packed = packSceneForRust({ scene: this.scene, camera, width, height, transparent, shutter });
      if (rustCache) rustCache.basePacked = packed;
    }

    const useTemporal = Boolean(temporalReproject && totalFrames > 1);
    const res = await tracer.renderFrame(packed, {
      width,
      height,
      samples,
      maxBounces,
      denoise,
      denoisePasses: 3,
      temporal: useTemporal,
      adaptiveThreshold,
      exposure: Number.isFinite(exposure) ? exposure : (this.renderer?.toneMappingExposure || 1),
      tonemap,
      tonemapLook,
      seed: useTemporal ? ((frameIdx + 1) * 131) : (fixedSeed ? 1 : (frameIdx + 1) * 97),
      signal,
      onChunkProgress,
    });
    if (signal?.aborted) throw new DOMException('Video render cancelled by user', 'AbortError');

    if (colorGrade || metadataText) {
      const c2d = typeof OffscreenCanvas !== 'undefined'
        ? new OffscreenCanvas(width, height)
        : Object.assign(document.createElement('canvas'), { width, height });
      const ctx = c2d.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(res.canvas, 0, 0);
      const img = ctx.getImageData(0, 0, width, height);
      if (colorGrade) applyColorGradeInPlace(img.data, width, height, colorGrade);
      if (metadataText) burnInMetadataInPlace(img.data, width, height, metadataText, { position: metadataPosition });
      ctx.putImageData(img, 0, 0);
      return c2d;
    }
    return res.canvas;
  }

  async _renderRustFrame({
    camera: srcCamera = null,
    width,
    height,
    transparent = false,
    samples = 16,
    maxBounces = 5,
    denoise = true,
    signal = null,
    frameIdx = 0,
    totalFrames = 1,
    rustCache = null,
    adaptiveThreshold = 0.015,
    fixedSeed = true,
    temporalReproject = true,
    temporalBlend = 0.7,
    shutter = 0,
    exposure = 1,
    tonemap = 'agx',
    tonemapLook = 'base',
    threads = 0,
    colorGrade = null,
    metadataText = null,
    metadataPosition = 'bottom',
    onPassPreview = null,
  }) {
    const [{ packSceneForRust, packSceneGeometryForRefit }, { renderRust, loadKernelBytes, RenderKernel, RenderPool }] = await Promise.all([
      import('./rust-scene-pack.js'),
      import('./rust-render-bridge.js')
    ]);
    const activeCam = srcCamera || this.camera;
    if (typeof this.scene?.updateMatrixWorld === 'function') {
      this.scene.updateMatrixWorld(true);
    }
    if (typeof activeCam?.updateMatrixWorld === 'function') {
      activeCam.updateMatrixWorld(true);
    }
    const camera = activeCam.clone();
    if (camera.isPerspectiveCamera) {
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
    } else if (camera.isOrthographicCamera) {
      const halfH = (camera.top - camera.bottom) / 2;
      camera.left = -halfH * (width / height);
      camera.right = halfH * (width / height);
      camera.updateProjectionMatrix();
    }
    camera.matrixWorld.copy(activeCam.matrixWorld);

    // Fast O(N) BVH refit path for frames 1..N (skips texture extraction & worker texture IPC!)
    let packed = null;
    if (rustCache?.basePacked) {
      packed = packSceneGeometryForRefit({
        scene: this.scene,
        camera,
        width,
        height,
        prevPacked: rustCache.basePacked,
        transparent,
        shutter,
      });
      if (packed) {
        rustCache.refitCount = (rustCache.refitCount || 0) + 1;
      }
    }
    if (!packed) {
      packed = packSceneForRust({ scene: this.scene, camera, width, height, transparent, shutter });
      if (rustCache) rustCache.basePacked = packed;
    }

    if (rustCache) {
      if (!rustCache.bytes) rustCache.bytes = await loadKernelBytes();
      if (!rustCache.kernel) rustCache.kernel = await RenderKernel.create(rustCache.bytes);
      if (!rustCache.pool && threads !== 1 && RenderPool.supported()) {
        rustCache.pool = new RenderPool(threads > 0 ? threads : undefined);
      }
      if (temporalReproject && !rustCache.temporal) {
        rustCache.temporal = { blend: temporalBlend, state: null };
      }
    }

    // For multi-frame animation sequences (<= 32 spp), render in a single pass per frame to avoid
    // redundant mid-frame resolve/IPC sync barriers; keep progressive pass preview for single-frame Preview or >32 spp.
    const wantMidPassPreview = Boolean(onPassPreview && (totalFrames === 1 || samples > 32));
    const previewCanvas = wantMidPassPreview
      ? (typeof OffscreenCanvas !== 'undefined'
          ? new OffscreenCanvas(width, height)
          : Object.assign(document.createElement('canvas'), { width, height }))
      : null;

    const passSpp = wantMidPassPreview ? Math.min(samples, 8) : Math.min(samples, 32);
    const denoisePasses = totalFrames > 1 ? 3 : 4;
    const result = await renderRust(packed, {
      width,
      height,
      samples,
      maxBounces,
      denoise,
      denoisePasses,
      signal,
      passSpp,
      adaptiveThreshold,
      seedOffset: fixedSeed ? 0 : frameIdx * 100,
      temporal: temporalReproject ? (rustCache?.temporal || null) : null,
      exposure: Number.isFinite(exposure) ? exposure : (this.renderer?.toneMappingExposure || 1),
      tonemap,
      tonemapLook,
      threads,
      pool: rustCache?.pool || null,
      kernel: rustCache?.kernel || null,
      onPreview: wantMidPassPreview && previewCanvas
        ? ({ rgba, samples: doneSamples }) => {
            previewCanvas.getContext('2d').putImageData(new ImageData(rgba, width, height), 0, 0);
            onPassPreview(previewCanvas, doneSamples);
          }
        : null,
    });
    if (!result) throw new DOMException('Video render cancelled by user', 'AbortError');

    if (colorGrade) {
      applyColorGradeInPlace(result.rgba, width, height, colorGrade);
    }
    if (metadataText) {
      burnInMetadataInPlace(result.rgba, width, height, metadataText, { position: metadataPosition });
    }

    const canvas = typeof OffscreenCanvas !== 'undefined'
      ? new OffscreenCanvas(width, height)
      : Object.assign(document.createElement('canvas'), { width, height });
    canvas.getContext('2d').putImageData(new ImageData(result.rgba, width, height), 0, 0);
    return canvas;
  }

  /**
   * Helper to trigger a direct browser file download for a Blob.
   * @param {Blob} blob
   * @param {string} filename
   */
  downloadBlob(blob, filename) {
    if (typeof document === 'undefined' || !blob) return;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 1000);
  }
}
