/**
 * Web Blender Studio - Video Motion Capture & Pose Tracking UI
 * File: js/ui/mocap-ui.js
 *
 * Provides Blender-like Video Motion Tracking & Full-Body Retargeting interface:
 * - 1-Click "Analyze & Apply Full Video" pipeline (auto-loads character if needed)
 * - Full-video (100% frames) MediaPipe AI tracking with live progress bar & ETA
 * - 60fps real-time 2D skeleton overlay on Movie Clip Editor
 * - Live-tunable anatomical stabilization (Smoothing, Depth Stability, Floor Grounding,
 *   Root Motion, Auto Yaw Alignment, Quick Yaw Presets)
 * - Synchronous playback with Studio Timeline & 3D Video Renderer
 */

import * as THREE from 'three';
import {
  videoSubjectBox,
  estimateVideoCameraPose,
  computeCameraOrbitPose,
} from '../animation/camera-framing.js';
import { closestFrameIndexByTime, POSE_BONE_CONNECTIONS } from '../animation/mocap-math.js';
import { MocapRetargeter } from '../animation/mocap-retargeter.js';
import { BrowserMocapEngine } from '../animation/browser-mocap.js';
import { initMocapKernel } from '../animation/mocap-kernel-bridge.js';
import { shouldBlockViewportShortcut } from '../core/interaction-guard.js';
import { listMotionTemplates, getMotionTemplate } from '../animation/motion-templates.js';
import { resolveCdnAssetUrl } from '../core/asset-cdn.js';
import { telemetry } from '../core/telemetry.js';
import { applyTranslations, onLangChange, t } from '../core/i18n.js';
import { listSkeletonTemplates } from '../animation/skeleton-templates.js';

export class MocapUI {
  constructor(app, containerId = 'dock-mocap') {
    this.app = app;
    this.container = document.getElementById(containerId);
    const engine = app?.engine || window.studioEngine || window.engine;
    const sceneMgr = app?.sceneManager || window.sceneManager;
    const timeline = app?.timelineEngine || window.timelineEngine;
    this.retargeter = new MocapRetargeter(engine, sceneMgr, timeline);

    this.videoElement = null;
    this.canvasElement = null;
    this.ctx = null;

    this.currentVideoPath = 'models/shuffle_dance.mp4';
    this._uploadedFile = null;
    this.mocapData = null;
    this.isTracking = false;
    this.isSyncWithTimeline = true;
    this.showOverlay = true;
    this._isRendering = false;
    this._lastAppliedTarget = null;
    this._applySeq = 0;
    this._reapplyTimer = null;
    this._rafSyncId = null;
    this._progressPollTimer = null;
    this._trackAbort = null;
    this.browserEngine = null;
    this._mediaInitialized = false;

    // Khung xương 2D dùng chung từ module toán mocap-math.js (bỏ bản copy trong UI).
    this.boneConnections = POSE_BONE_CONNECTIONS;

    this._initUI();
    applyTranslations(this.container);
    this._unsubLang = onLangChange(() => {
      if (!this.container) return;
      applyTranslations(this.container);
      this._refreshRigTemplateLabels();
      this._updateRigDiagnostics(this._resolveTargetCharacter({ includeUnrigged: true }));
    });
    this._bindEvents();
  }

  _initUI() {
    if (!this.container) return;

    this.container.innerHTML = `
      <div class="mocap-workspace">
        
        <!-- LEFT: Video Player & 2D Skeleton Tracking Overlay -->
        <div class="mocap-video-panel">
          
          <div class="mocap-video-head">
            <div class="mocap-video-title">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M17 10.5V7c0-.55-.45-1-1-1H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.55 0 1-.45 1-1v-3.5l4 4v-11l-4 4z"/></svg>
              <span>Movie Clip Editor</span>
              <span id="mocap-coverage-badge" class="mocap-pill mocap-pill--ghost" title="Analyzed video coverage">Not Analyzed</span>
            </div>
            <div class="mocap-video-badges">
              <span id="mocap-status-pill" class="mocap-pill">Ready</span>
              <span id="mocap-video-info" class="mocap-pill mocap-pill--ghost">No Video</span>
              <button id="btn-mocap-fullscreen" class="mp-btn mp-btn--icon" title="Toggle Fullscreen (Esc to exit)">⛶</button>
            </div>
          </div>

          <div class="mocap-video-stage" id="mocap-video-stage" title="Click video or press Space to Play / Pause">
            <video id="mocap-video" crossorigin="anonymous" playsinline loop preload="none"></video>
            <canvas id="mocap-canvas"></canvas>

            <button id="mocap-stage-play-btn" class="mocap-stage-play-btn" type="button" aria-label="Play/Pause Video">
              <svg viewBox="0 0 24 24" width="26" height="26" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
            </button>

            <div id="mocap-overlay-prompt" class="mocap-video-empty">
              <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="margin-bottom: 8px; opacity: 0.5;"><circle cx="12" cy="12" r="10"/><polygon points="10 8 16 12 10 16 10 8"/></svg>
              <div>Select a sample video or upload your own to begin analysis</div>
            </div>
          </div>

          <div class="mocap-video-transport">
            <button id="btn-mocap-play" class="mp-btn mp-btn--play" title="Play / Pause (Space)">▶ Play</button>
            <button id="btn-mocap-rewind" class="mp-btn mp-btn--icon" title="Jump to start (00:00)">⏮</button>
            <button id="btn-mocap-prev-frame" class="mp-btn mp-btn--icon" title="Previous Frame (←)">◀</button>
            <button id="btn-mocap-next-frame" class="mp-btn mp-btn--icon" title="Next Frame (→)">▶|</button>
            <div class="mocap-scrubber-wrap">
              <input type="range" id="mocap-scrubber" min="0" max="100" value="0" step="0.05">
            </div>
            <div class="mocap-timecode">
              <span id="mocap-time-current">00:00.00</span> <span class="mocap-time-sep">/</span> <span id="mocap-time-total">00:00.00</span>
            </div>
            <select id="mocap-playback-rate" class="mocap-rate-select" title="Video playback speed">
              <option value="1" selected>1.0x</option>
              <option value="0.5">0.5x</option>
              <option value="0.25">0.25x</option>
            </select>
          </div>
        </div>

        <!-- RIGHT: Controls, AI Tracking, Retargeting Parameters -->
        <div class="mocap-controls-panel">

          <!-- Quick Start Templates: Unity Humanoid, VRM / VTuber, TikTok Dance -->
          <div class="mocap-template-bar" id="mocap-template-bar" role="group" aria-label="Hunger Motion Templates">
            ${listMotionTemplates().map((tpl) => `
              <button type="button" class="mocap-tpl-card" data-template="${tpl.id}" title="${tpl.tagline}">
                <div class="mocap-tpl-head">
                  <span>${tpl.name}</span>
                  <span class="mocap-tpl-badge">${tpl.badge}</span>
                </div>
                <span class="mocap-tpl-desc">${tpl.tagline}</span>
              </button>
            `).join('')}
          </div>
          <div id="mocap-template-hint" class="mocap-mode-banner" style="display:none;">
            <span id="mocap-template-hint-text"></span>
            <button type="button" id="btn-mocap-open-advanced" class="mp-btn" style="padding:3px 8px;font-size:10.5px;">Advanced Tools</button>
          </div>

          <!-- Primary actions: 1-Click Full Video + Step Actions + Live Progress -->
          <div class="mp-actions">
            <button id="btn-mocap-full-pipeline" class="mp-btn mp-btn--hero" title="Automatically analyze 100% of the video and apply to the 3D character">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>
              <span>Analyze &amp; Apply Full Video (100%)</span>
            </button>

            <div class="mp-grid-2">
              <button id="btn-mocap-track" class="mp-btn mp-btn--primary" title="Run AI tracking using the frame settings below">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z"/></svg>
                <span>1. Track AI</span>
              </button>

              <button id="btn-mocap-apply" class="mp-btn mp-btn--success" disabled title="Apply tracked pose data to the selected 3D character">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M9 16.2L4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4L9 16.2z"/></svg>
                <span>2. Apply to Model</span>
              </button>
            </div>

            <div id="mocap-track-progress-wrap" class="mp-track-progress-wrap" style="display: none;">
              <div class="mp-progress"><div id="mocap-track-progress"></div></div>
              <div style="display: flex; align-items: center; gap: 6px; width: 100%;">
                <div id="mocap-track-progress-text" class="mp-hint" style="flex: 1;">Initializing AI...</div>
                <button id="btn-mocap-cancel" type="button" class="mp-btn" style="display: none; padding: 2px 8px; font-size: 11px;" title="Cancel running analysis">✕ Cancel</button>
              </div>
            </div>

            <div class="mp-row" style="justify-content: space-between;">
              <label class="mp-check">
                <input type="checkbox" id="mocap-sync-timeline" checked>
                Sync Studio Timeline
              </label>
              <label class="mp-check">
                <input type="checkbox" id="mocap-show-overlay" checked>
                2D Skeleton
              </label>
              <span id="mocap-ai-status" class="mocap-pill">AI: checking…</span>
            </div>
          </div>

          <!-- Card 1: Video Source + Target Character -->
          <div class="mp-card mp-card--wide">
            <div class="mp-card-head"><span class="mp-num">1</span> Video Source &amp; Target Character</div>
            <div class="mp-card-body mp-inputs-grid">
              <div>
                <label class="mp-label" for="mocap-video-preset">Source Video</label>
                <div class="mp-row" style="margin-bottom: 8px;">
                  <select id="mocap-video-preset" class="mp-field" style="flex: 1;">
                    <option value="models/shuffle_dance.mp4" selected>Shuffle Dance (shuffle_dance.mp4)</option>
                    <option value="models/uploaded_mocap.mp4">Uploaded Video (uploaded_mocap.mp4)</option>
                    <option value="models/sample_human_motion.webm">Guitarist Motion (sample_human_motion.webm)</option>
                    <option value="models/aerobics_exercise.webm">Aerobics Workout (aerobics_exercise.webm)</option>
                  </select>
                  <button id="btn-mocap-load-preset" class="mp-btn mp-btn--icon" title="Reload selected video">Load</button>
                </div>
                <input type="file" id="mocap-file-upload" accept="video/mp4,video/webm,video/quicktime,video/*" hidden>
                <button id="btn-mocap-upload" class="mp-btn" style="width: 100%;">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M9 16h6v-6h4l-7-7-7 7h4zm-4 2h14v2H5z"/></svg>
                  Upload Local Video (.mp4, .webm, .mov)
                </button>
              </div>

              <div id="mocap-char-dropzone" class="mp-char-dropzone">
                <label class="mp-label" for="mocap-target-character">Target 3D Character</label>
                <div class="mp-row" style="margin-bottom: 8px;">
                  <select id="mocap-target-character" class="mp-field" style="flex: 1;">
                    <option value="">(Auto-detect rigged character in scene)</option>
                  </select>
                  <button id="btn-mocap-refresh-targets" class="mp-btn mp-btn--icon" title="Rescan scene characters">Refresh</button>
                </div>
                <input type="file" id="mocap-char-upload" accept=".glb,.gltf,.vrm,.fbx,.obj,.zip" hidden>
                <button id="btn-mocap-upload-character" type="button" class="mp-btn mp-btn--upload-char" style="width: 100%; margin-bottom: 8px;" title="Upload your own 3D character (.glb, .gltf, .vrm, .fbx, .obj) or drag &amp; drop here">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M9 16h6v-6h4l-7-7-7 7h4zm-4 2h14v2H5z"/></svg>
                  <span data-i18n="mocap.uploadChar">Upload 3D Character (.glb, .vrm, .fbx, .obj)</span>
                </button>
                <div class="mp-row" style="margin-bottom: 8px;">
                  <button id="btn-mocap-load-michelle" class="mp-btn" style="flex: 1;" title="Load Studio Athlete CC0 rigged humanoid character (56 bones, 8 ARKit morphs)">+ Studio Athlete (CC0)</button>
                  <button id="btn-mocap-load-soldier" class="mp-btn" style="flex: 1;" title="Load Cyber Droid CC0 rigged humanoid character (56 bones, ceramic armor)">+ Cyber Droid (CC0)</button>
                </div>

                <!-- Live Rig Quality Diagnostics + 1-Click Auto-Rig & Skeleton Templates -->
                <div id="mocap-rig-diagnostics" class="mp-rig-diag">
                  <div class="mp-rig-diag-head">
                    <span id="mocap-rig-standard" class="mp-rig-title">No character selected</span>
                    <span id="mocap-rig-badge" class="mp-rig-badge mp-rig-badge--muted">--</span>
                  </div>
                  <div id="mocap-rig-summary" class="mp-rig-summary">Upload a custom .glb/.vrm/.fbx/.obj character or load a CC0 starter rig.</div>
                  <div class="mp-row" style="margin-top: 6px; gap: 6px;">
                    <select id="mocap-rig-template" class="mp-field" style="flex: 1; font-size: 11px; padding: 4px 6px;" title="Skeleton template for Auto-Rig or spawning a standalone rig">
                      ${listSkeletonTemplates().map((tpl) => `<option value="${tpl.id}">${tpl.name}</option>`).join('')}
                    </select>
                    <button id="btn-mocap-autorig" type="button" class="mp-btn mp-btn--autorig" style="padding: 4px 9px; font-size: 11px;" title="Auto-fit and bind a pro humanoid skeleton onto an unrigged mesh">
                      <span data-i18n="mocap.autoRig">Auto-Rig</span>
                    </button>
                    <button id="btn-mocap-add-rig-template" type="button" class="mp-btn" style="padding: 4px 8px; font-size: 11px;" title="Spawn selected skeleton template (Human, Animal, Creature, Vehicle) into the 3D scene">
                      <span data-i18n="mocap.addRig">+ Rig</span>
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <!-- Card 2: AI Scope, Anatomical Stabilization & Orientation -->
          <div class="mp-card">
            <div class="mp-card-head"><span class="mp-num">2</span> Scope &amp; Retarget Filtering</div>
            <div class="mp-card-body">
              <div class="mp-grid-2">
                <div>
                  <label class="mp-label" for="mocap-engine-mode">Inference Engine</label>
                  <select id="mocap-engine-mode" class="mp-field" title="Browser: MediaPipe WASM runs locally in browser with zero server GPU cost. Server: Python engine (requires mediapipe + opencv).">
                    <option value="browser" selected>Browser (WASM · Zero Server Cost)</option>
                    <option value="server">Server (Python MediaPipe)</option>
                  </select>
                </div>
                <div>
                  <label class="mp-label" for="mocap-model-tier">AI Model Accuracy</label>
                  <select id="mocap-model-tier" class="mp-field" title="Full: fast balanced offline accuracy. Heavy: highest 3D limb & occlusion accuracy (if model downloaded). Lite: fastest mobile speed.">
                    <option value="heavy">Heavy (Highest 3D Accuracy)</option>
                    <option value="full" selected>Full (Balanced · Default)</option>
                    <option value="lite">Lite (Ultra-Fast)</option>
                  </select>
                </div>
                <div>
                  <label class="mp-label" for="mocap-max-frames">Capture Range</label>
                  <select id="mocap-max-frames" class="mp-field">
                    <option value="0" selected>Full Video (100%)</option>
                    <option value="600">600 frames (~20s)</option>
                    <option value="360">360 frames (~12s)</option>
                    <option value="240">240 frames (~8s)</option>
                    <option value="120">120 frames (~4s · Fast)</option>
                    <option value="60">60 frames (~2s · Quick Test)</option>
                  </select>
                </div>
                <div>
                  <label class="mp-label" for="mocap-frame-step">Frame Step</label>
                  <select id="mocap-frame-step" class="mp-field">
                    <option value="1" selected>1 · Every frame (Smoothest)</option>
                    <option value="2">2 · 2x faster (15fps)</option>
                    <option value="3">3 · 3x ultra-fast (10fps)</option>
                  </select>
                </div>
                <div style="grid-column: 1 / -1;">
                  <label class="mp-label" for="mocap-subject-mode">Single Subject Focus (Anti-Intruder)</label>
                  <select id="mocap-subject-mode" class="mp-field" title="Track 1 performer only and stay locked onto them even when other people enter or cross in front of the camera">
                    <option value="auto" selected>Auto Lock Main Subject (Ignore Intruders)</option>
                    <option value="center">Focus Center Performer (Ignore Intruders)</option>
                    <option value="largest">Focus Closest Performer (Ignore Background)</option>
                    <option value="single">Single Pose Fast (Empty Stage Only)</option>
                  </select>
                </div>
              </div>

              <div class="mp-checks-grid">
                <label class="mp-check" title="Automatically align character facing direction to match the subject in the video">
                  <input type="checkbox" id="mocap-auto-align" checked>
                  Auto-Align Facing
                </label>
                <label class="mp-check" title="Pin supporting feet to floor level to prevent floating or sinking">
                  <input type="checkbox" id="mocap-ground-feet" checked>
                  Floor Contact
                </label>
                <label class="mp-check" title="Apply root hip vertical bounce and horizontal travel from the video">
                  <input type="checkbox" id="mocap-root-motion" checked>
                  Root Hip Motion
                </label>
                <label class="mp-check" title="Foot-Lock IK: anchor planted feet to floor contact points to eliminate sliding">
                  <input type="checkbox" id="mocap-foot-lock" checked>
                  Foot-Lock IK
                </label>
                <label class="mp-check" title="Track 21-point hands & animate all 30 finger bones + palm twist (runs MediaPipe HandLandmarker)">
                  <input type="checkbox" id="mocap-track-hands" checked>
                  Hands &amp; Fingers
                </label>
                <label class="mp-check" title="Track 52 ARKit face blendshapes & fine head orientation (runs MediaPipe FaceLandmarker)">
                  <input type="checkbox" id="mocap-track-face" checked>
                  Face &amp; Expressions
                </label>
                <label class="mp-check" title="Estimate &amp; subtract camera pan/tilt/zoom so camera panning does not drag dancer feet">
                  <input type="checkbox" id="mocap-cam-comp" checked>
                  Cam Pan/Zoom Comp.
                </label>
              </div>

              <div>
                <div class="mp-kv">
                  <span>Motion Smoothing (SLERP)</span>
                  <b id="mocap-smoothing-val">35%</b>
                </div>
                <input type="range" id="mocap-smoothing" min="0" max="90" value="35" step="5" class="mp-range">
              </div>

              <div>
                <div class="mp-kv">
                  <span>Depth Stability Z (Anti-Twist)</span>
                  <b id="mocap-depth-stability-val">50%</b>
                </div>
                <input type="range" id="mocap-depth-stability" min="0" max="90" value="50" step="5" class="mp-range">
              </div>

              <div>
                <div class="mp-kv">
                  <span>Yaw Offset (<span id="mocap-inferred-yaw">auto: --</span>)</span>
                  <b id="mocap-yaw-offset-val">0°</b>
                </div>
                <input type="range" id="mocap-yaw-offset" min="-180" max="180" value="0" step="1" class="mp-range">
                <div class="mp-yaw-presets">
                  <button type="button" class="mp-chip" data-yaw="0">0° Front</button>
                  <button type="button" class="mp-chip" data-yaw="-90">-90° Left</button>
                  <button type="button" class="mp-chip" data-yaw="90">+90° Right</button>
                  <button type="button" class="mp-chip" data-yaw="180">180° Back</button>
                </div>
              </div>

              <div id="mocap-facing-label" class="mp-hint">No video analyzed yet. All sliders update the model live.</div>
            </div>
          </div>

          <!-- Card 3: Render Video -->
          <div class="mp-card">
            <div class="mp-card-head"><span class="mp-num">3</span> Export &amp; Render 3D Video</div>
            <div class="mp-card-body">
              <div class="mp-grid-2">
                <div>
                  <label class="mp-label" for="mocap-render-format">Format</label>
                  <select id="mocap-render-format" class="mp-field">
                    <option value="auto" selected>Auto (Deterministic MP4)</option>
                    <option value="mp4">MP4 · H.264 (Frame-Exact)</option>
                    <option value="webm-vp9">WebM · VP9 (Live Stream)</option>
                    <option value="webm-vp8">WebM · VP8 (Live Stream)</option>
                  </select>
                </div>
                <div>
                  <label class="mp-label" for="mocap-render-res">Resolution</label>
                  <select id="mocap-render-res" class="mp-field">
                    <option value="viewport">Match Viewport</option>
                    <option value="video">Match Source Aspect Ratio</option>
                    <option value="1280x720" selected>1280 × 720 (HD)</option>
                    <option value="1920x1080">1920 × 1080 (Full HD)</option>
                    <option value="1080x1920">1080 × 1920 (TikTok 9:16)</option>
                  </select>
                </div>
                <div>
                  <label class="mp-label" for="mocap-render-fps">FPS</label>
                  <select id="mocap-render-fps" class="mp-field">
                    <option value="24">24 fps</option>
                    <option value="30" selected>30 fps</option>
                    <option value="60">60 fps</option>
                  </select>
                </div>
              </div>

              <label class="mp-check" style="margin-bottom: 6px;" title="Mux the original video's music/audio track (AAC for MP4, Opus for WebM) if present">
                <input type="checkbox" id="mocap-render-audio" checked> Include Source Audio / Music
              </label>

              <button id="btn-mocap-render" class="mp-btn mp-btn--render">Render Full 3D Clip</button>

              <!-- Smart Auto Camera & Angle Controls -->
              <div style="margin-top: 8px; padding-top: 8px; border-top: 1px solid rgba(255,255,255,0.08);">
                <div class="mp-checks" style="margin-bottom: 6px;">
                  <label class="mp-check" title="Automatically aim and frame 3D camera whenever a character or mocap is applied">
                    <input type="checkbox" id="mocap-auto-camera" checked>
                    Auto-Aim Camera
                  </label>
                  <label class="mp-check" title="Track moving character Hips softly during playback so dancer stays centered">
                    <input type="checkbox" id="mocap-follow-camera" checked>
                    Follow Character
                  </label>
                </div>

                <div style="margin-bottom: 6px;">
                  <label class="mp-label" for="mocap-camera-preset">Camera View Angle</label>
                  <select id="mocap-camera-preset" class="mp-field">
                    <option value="video-match" selected>Auto (Match Video Angle)</option>
                    <option value="three-quarter">3/4 Hero View (+35°)</option>
                    <option value="front">Front Full-Body (0°)</option>
                    <option value="side">Side Profile (+88°)</option>
                  </select>
                </div>

                <div>
                  <div class="mp-kv">
                    <span>Camera Pitch Angle</span>
                    <b id="mocap-cam-pitch-val">10°</b>
                  </div>
                  <input type="range" id="mocap-cam-pitch" min="-20" max="45" value="10" step="1" class="mp-range">
                </div>

                <div>
                  <div class="mp-kv">
                    <span>Lens FOV</span>
                    <b id="mocap-cam-fov-val">48°</b>
                  </div>
                  <input type="range" id="mocap-cam-fov" min="25" max="75" value="48" step="1" class="mp-range">
                </div>

                <div>
                  <div class="mp-kv">
                    <span>Distance Scale</span>
                    <b id="mocap-cam-zoom-val">1.00×</b>
                  </div>
                  <input type="range" id="mocap-cam-zoom" min="0.6" max="1.8" value="1.0" step="0.05" class="mp-range">
                </div>

                <div class="mp-row" style="margin-top: 6px;">
                  <button id="btn-mocap-fit-camera" class="mp-btn" style="flex: 1;" title="Snap viewport camera to character & selected viewing angle">Auto-Frame Camera</button>
                </div>
                <div id="mocap-camera-status" class="mp-hint">Auto-aim enabled: hides starter Cube & frames character cleanly on apply.</div>
              </div>

              <div class="mp-row" style="margin-top: 6px; gap: 6px;">
                <button id="btn-mocap-export-glb" class="mp-btn" style="flex: 1;" title="Export character mesh, armature, and mocap AnimationClip into a single .glb file (Blender, Unity, Godot compatible)">⬇ Export GLB</button>
                <button id="btn-mocap-export-bvh" class="mp-btn" style="flex: 1;" title="Export skeletal motion hierarchy + unwrapped ZXY Euler keyframes as a standard .bvh file (Blender, Maya, Unreal compatible)">⬇ Export BVH</button>
                <button id="btn-mocap-export-fbx" class="mp-btn" style="flex: 1;" title="Export skeletal hierarchy + ZYX Euler keyframes as Binary FBX 7.4 (.fbx) for Blender, Unity, Maya, Unreal">⬇ Export FBX</button>
              </div>
              <div id="mocap-export-status" class="mp-hint">Exports self-contained .glb (mesh + skeleton + clip), .bvh, or ASCII FBX 7.4 animation.</div>

              <div class="mp-progress"><div id="mocap-render-progress"></div></div>
              <div id="mocap-render-status" class="mp-hint">Not rendered yet. Records the full applied 3D motion clip.</div>
              <a id="mocap-render-download" class="mp-download" style="display: none;" download>⬇ Download Rendered Video</a>
            </div>
          </div>

          <!-- Card 4: Manual Skeleton Editing (Advanced) -->
          <details class="mp-card mp-card--wide mp-details mocap-advanced-only">
            <summary class="mp-card-head">
              <span class="mp-num">4</span>
              Manual Bone Posing (FK / IK)
              <span id="pose-edit-status" class="mp-hint" style="margin-left: auto;">Off</span>
            </summary>
            <div class="mp-card-body">
              <div class="mp-row">
                <button id="btn-pose-edit-toggle" class="mp-btn mp-btn--primary" style="flex: 1;">Enable Bone Posing</button>
                <button id="btn-pose-edit-reset" class="mp-btn" title="Reset all bones to Rest Pose">Rest</button>
                <button id="btn-pose-edit-mirror" class="mp-btn mp-btn--icon" title="Mirror Left arm/leg pose to Right">Mirror</button>
              </div>
              <div class="mp-row">
                <select id="pose-edit-joint" class="mp-field" style="flex: 1;">
                  <option value="">(Click a joint in the 3D viewport)</option>
                </select>
                <select id="pose-edit-mode" class="mp-field" style="flex: 0 0 120px;" title="Elbow/knee solving mode">
                  <option value="fk">Single Bone (FK)</option>
                  <option value="ik">Chain (IK)</option>
                </select>
              </div>
              <div class="mp-row">
                <button id="btn-pose-edit-load-mocap" class="mp-btn" style="flex: 1;" title="Reload character and seek to start of mocap clip">Load Mocap</button>
                <button id="btn-pose-edit-export" class="mp-btn" style="flex: 1;" title="Export current pose as JSON">Export Pose</button>
                <button id="btn-pose-edit-bake" class="mp-btn mp-btn--success" style="flex: 1;" title="Bake current pose as a keyframe">Bake</button>
              </div>
            </div>
          </details>

          <!-- Mocap Log & Summary Box -->
          <div id="mocap-log-box" class="mp-log">
            <div style="color: #777;">[Mocap Studio] Ready. Click <b>"Analyze &amp; Apply Full Video"</b> to process the full video in one click!</div>
          </div>

        </div>

      </div>
    `;

    this.videoElement = document.getElementById('mocap-video');
    this.canvasElement = document.getElementById('mocap-canvas');
    if (this.canvasElement) {
      this.ctx = this.canvasElement.getContext('2d');
    }

    this._initRenderFormats();
  }

  _ensureMediaInitialized() {
    if (this._mediaInitialized) return;
    this._mediaInitialized = true;
    initMocapKernel().catch(() => {});
    this._loadAvailableSamples();
    this.loadVideo(this.currentVideoPath);
    this._checkMocapHealth();
  }

  async _loadAvailableSamples() {
    const select = document.getElementById('mocap-video-preset');
    if (!select) return;
    try {
      const res = await fetch('/api/mocap/samples');
      const data = await res.json();
      if (data.success && Array.isArray(data.samples) && data.samples.length > 0) {
        const currentVal = select.value || this.currentVideoPath;
        select.innerHTML = '';
        for (const s of data.samples) {
          const opt = document.createElement('option');
          opt.value = s.file;
          opt.textContent = s.name;
          if (s.file === currentVal) opt.selected = true;
          select.appendChild(opt);
        }
      }
    } catch (_) {
      // Keep default options if offline
    }
  }

  _initRenderFormats() {
    const select = document.getElementById('mocap-render-format');
    if (!select) return;
    const hasWebCodecs = typeof VideoEncoder === 'function' && typeof VideoFrame === 'function';
    const mp4Opt = select.querySelector('option[value="mp4"]');
    if (mp4Opt && !hasWebCodecs && (typeof MediaRecorder === 'undefined' || !MediaRecorder.isTypeSupported?.('video/mp4'))) {
      mp4Opt.disabled = true;
      mp4Opt.textContent += ' · unsupported';
    }
    if (typeof MediaRecorder !== 'undefined' && typeof MediaRecorder.isTypeSupported === 'function') {
      for (const [value, mime] of Object.entries({ 'webm-vp9': 'video/webm;codecs=vp9', 'webm-vp8': 'video/webm;codecs=vp8' })) {
        const opt = select.querySelector(`option[value="${value}"]`);
        if (opt && !MediaRecorder.isTypeSupported(mime)) {
          opt.disabled = true;
          opt.textContent += ' · unsupported';
        }
      }
    }
    select.value = hasWebCodecs ? 'auto' : 'webm-vp9';
  }

  async _checkMocapHealth() {
    const pill = document.getElementById('mocap-ai-status');
    if (!pill) return;
    try {
      const res = await fetch('/api/mocap/health');
      const data = await res.json();
      if (data.available) {
        pill.textContent = 'AI Ready';
        pill.className = 'mocap-pill mocap-pill--ok';
        pill.title = data.model ? `MediaPipe: ${data.model}` : 'MediaPipe ready';
      } else if (BrowserMocapEngine.isSupported()) {
        pill.textContent = 'AI Ready (WASM)';
        pill.className = 'mocap-pill mocap-pill--ok';
        pill.title = 'Server does not have MediaPipe, so the browser will run the WASM model locally.';
        this._log(`ℹ️ Backend lacks MediaPipe/OpenCV (${data.error || 'unknown error'}) — running AI locally in the browser (WASM).`, '#00b4ff');
      } else {
        pill.textContent = 'Missing MediaPipe';
        pill.className = 'mocap-pill mocap-pill--err';
        pill.title = data.error || data.hint || '';
        this._log(`⚠️ Backend lacks MediaPipe/OpenCV: ${data.error || 'unknown error'}. ${data.hint || ''}`, '#e67e22');
      }
    } catch (e) {
      pill.textContent = 'AI Unknown';
      pill.className = 'mocap-pill mocap-pill--warn';
      pill.title = e.message;
    }
  }

  _bindEvents() {
    this._bindPoseEditEvents();
    const playBtn = document.getElementById('btn-mocap-play');
    const rewindBtn = document.getElementById('btn-mocap-rewind');
    const prevFrameBtn = document.getElementById('btn-mocap-prev-frame');
    const nextFrameBtn = document.getElementById('btn-mocap-next-frame');
    const rateSelect = document.getElementById('mocap-playback-rate');
    const videoStage = document.getElementById('mocap-video-stage');
    const stagePlayBtn = document.getElementById('mocap-stage-play-btn');
    const scrubber = document.getElementById('mocap-scrubber');
    const loadPresetBtn = document.getElementById('btn-mocap-load-preset');
    const presetSelect = document.getElementById('mocap-video-preset');
    const uploadBtn = document.getElementById('btn-mocap-upload');
    const fileInput = document.getElementById('mocap-file-upload');
    const refreshTargetsBtn = document.getElementById('btn-mocap-refresh-targets');
    const targetSelect = document.getElementById('mocap-target-character');
    const loadMichelleBtn = document.getElementById('btn-mocap-load-michelle');
    const loadSoldierBtn = document.getElementById('btn-mocap-load-soldier');
    const fullPipelineBtn = document.getElementById('btn-mocap-full-pipeline');
    const trackBtn = document.getElementById('btn-mocap-track');
    const cancelBtn = document.getElementById('btn-mocap-cancel');
    const applyBtn = document.getElementById('btn-mocap-apply');
    const syncCheckbox = document.getElementById('mocap-sync-timeline');
    const overlayCheckbox = document.getElementById('mocap-show-overlay');

    // Video playback & stage click-to-play
    playBtn?.addEventListener('click', () => this.togglePlay());
    rewindBtn?.addEventListener('click', () => this.seek(0));
    prevFrameBtn?.addEventListener('click', () => this.stepFrame(-1));
    nextFrameBtn?.addEventListener('click', () => this.stepFrame(1));
    rateSelect?.addEventListener('change', (e) => {
      if (this.videoElement) {
        this.videoElement.playbackRate = parseFloat(e.target.value) || 1.0;
      }
    });
    videoStage?.addEventListener('click', (e) => {
      if (e.target.closest('button') && e.target.closest('button') !== stagePlayBtn) return;
      this.togglePlay();
    });

    // Scrubber
    scrubber?.addEventListener('input', (e) => {
      const pct = parseFloat(e.target.value) || 0;
      scrubber.style.setProperty('--progress', `${pct}%`);
      if (this.videoElement && this.videoElement.duration) {
        const time = (pct / 100) * this.videoElement.duration;
        this.seek(time);
      }
    });

    // Preset select (auto-loads on change or button click)
    presetSelect?.addEventListener('change', () => {
      if (presetSelect.value) this.loadVideo(presetSelect.value);
    });
    loadPresetBtn?.addEventListener('click', () => {
      const val = presetSelect?.value;
      if (val) this.loadVideo(val);
    });

    // Custom video upload
    uploadBtn?.addEventListener('click', () => fileInput?.click());
    fileInput?.addEventListener('change', (e) => this._handleFileUpload(e));

    // Target characters & Custom 3D Character Upload + Auto-Rig
    const charUploadBtn = document.getElementById('btn-mocap-upload-character');
    const charFileInput = document.getElementById('mocap-char-upload');
    const charDropzone = document.getElementById('mocap-char-dropzone');
    const autoRigBtn = document.getElementById('btn-mocap-autorig');
    const addRigTplBtn = document.getElementById('btn-mocap-add-rig-template');

    charUploadBtn?.addEventListener('click', () => charFileInput?.click());
    charFileInput?.addEventListener('change', (e) => this._handleCharacterUpload(e));
    if (charDropzone) {
      charDropzone.addEventListener('dragover', (e) => {
        e.preventDefault();
        charDropzone.classList.add('is-dragover');
      });
      charDropzone.addEventListener('dragleave', () => {
        charDropzone.classList.remove('is-dragover');
      });
      charDropzone.addEventListener('drop', (e) => {
        e.preventDefault();
        charDropzone.classList.remove('is-dragover');
        const file = e.dataTransfer?.files?.[0];
        if (file) this.uploadCharacterFile(file);
      });
    }

    autoRigBtn?.addEventListener('click', () => this.autoRigSelectedCharacter());
    addRigTplBtn?.addEventListener('click', () => this.spawnSelectedRigTemplate());

    refreshTargetsBtn?.addEventListener('click', () => this.refreshTargetList());
    targetSelect?.addEventListener('change', () => {
      const chosen = this._resolveTargetCharacter({ includeUnrigged: true });
      this._updateRigDiagnostics(chosen);
      if (this.mocapData && chosen && !this.retargeter.diagnoseRig(chosen).needsAutoRig) {
        this.applyRetargeting();
      }
    });
    loadMichelleBtn?.addEventListener('click', () => this._loadPresetCharacter('models/Mannequin_CC0.glb', 'Mannequin_CC0'));
    loadSoldierBtn?.addEventListener('click', () => this._loadPresetCharacter('models/Bot_CC0.glb', 'Bot_CC0'));

    // 3 Curated Motion Templates (Unity Humanoid, VRM / VTuber, TikTok Dance 9:16)
    this.container?.querySelectorAll('.mocap-tpl-card[data-template]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const tplId = btn.getAttribute('data-template');
        if (tplId) this.applyTemplate(tplId);
      });
    });
    document.getElementById('btn-mocap-open-advanced')?.addEventListener('click', () => {
      this.app?.setWorkspace?.('advanced');
    });

    // 1-Click Full Video Pipeline
    fullPipelineBtn?.addEventListener('click', () => this.runFullVideoPipeline());

    // Step buttons
    trackBtn?.addEventListener('click', () => this.runTracking());
    cancelBtn?.addEventListener('click', () => this.cancelTracking());
    applyBtn?.addEventListener('click', () => this.applyRetargeting());

    // Live retargeting & stabilization controls
    const autoAlignCheckbox = document.getElementById('mocap-auto-align');
    const groundFeetCheckbox = document.getElementById('mocap-ground-feet');
    const rootMotionCheckbox = document.getElementById('mocap-root-motion');
    const smoothingSlider = document.getElementById('mocap-smoothing');
    const smoothingVal = document.getElementById('mocap-smoothing-val');
    const depthSlider = document.getElementById('mocap-depth-stability');
    const depthVal = document.getElementById('mocap-depth-stability-val');
    const yawOffsetSlider = document.getElementById('mocap-yaw-offset');
    const yawOffsetValue = document.getElementById('mocap-yaw-offset-val');

    smoothingSlider?.addEventListener('input', (e) => {
      if (smoothingVal) smoothingVal.textContent = `${e.target.value}%`;
    });
    smoothingSlider?.addEventListener('change', () => this._reapplyAlignment());

    depthSlider?.addEventListener('input', (e) => {
      if (depthVal) depthVal.textContent = `${e.target.value}%`;
    });
    depthSlider?.addEventListener('change', () => this._reapplyAlignment());

    yawOffsetSlider?.addEventListener('input', (e) => {
      if (yawOffsetValue) yawOffsetValue.textContent = `${e.target.value}°`;
    });
    yawOffsetSlider?.addEventListener('change', () => this._reapplyAlignment());

    // Quick yaw preset chips
    this.container?.querySelectorAll('.mp-chip[data-yaw]').forEach((chip) => {
      chip.addEventListener('click', () => {
        const yaw = parseInt(chip.getAttribute('data-yaw') || '0', 10);
        if (yawOffsetSlider) yawOffsetSlider.value = String(yaw);
        if (yawOffsetValue) yawOffsetValue.textContent = `${yaw}°`;
        this._reapplyAlignment();
      });
    });

    const footLockCheckbox = document.getElementById('mocap-foot-lock');
    autoAlignCheckbox?.addEventListener('change', () => this._reapplyAlignment());
    groundFeetCheckbox?.addEventListener('change', () => this._reapplyAlignment());
    rootMotionCheckbox?.addEventListener('change', () => this._reapplyAlignment());
    footLockCheckbox?.addEventListener('change', () => this._reapplyAlignment());

    // Render video
    const renderBtn = document.getElementById('btn-mocap-render');
    renderBtn?.addEventListener('click', () => this.renderVideo());

    document.getElementById('btn-mocap-fit-camera')?.addEventListener('click', () => {
      this.frameCameraToVideo({ auto: false });
    });

    const camPresetSelect = document.getElementById('mocap-camera-preset');
    const camPitchSlider = document.getElementById('mocap-cam-pitch');
    const camPitchVal = document.getElementById('mocap-cam-pitch-val');
    const camFovSlider = document.getElementById('mocap-cam-fov');
    const camFovVal = document.getElementById('mocap-cam-fov-val');
    const camZoomSlider = document.getElementById('mocap-cam-zoom');
    const camZoomVal = document.getElementById('mocap-cam-zoom-val');
    const autoCamCheckbox = document.getElementById('mocap-auto-camera');

    const snapCameraFromControls = () => {
      this._followAnchorPos = null;
      this.frameCameraToVideo({ auto: true, silent: true });
    };

    camPresetSelect?.addEventListener('change', snapCameraFromControls);
    autoCamCheckbox?.addEventListener('change', (e) => {
      if (e.target.checked) snapCameraFromControls();
    });
    camPitchSlider?.addEventListener('input', (e) => {
      this._camPitchDirty = true;
      if (camPitchVal) camPitchVal.textContent = `${e.target.value}°`;
      snapCameraFromControls();
    });
    camFovSlider?.addEventListener('input', (e) => {
      if (camFovVal) camFovVal.textContent = `${e.target.value}°`;
      snapCameraFromControls();
    });
    camZoomSlider?.addEventListener('input', (e) => {
      if (camZoomVal) camZoomVal.textContent = `${Number(e.target.value).toFixed(2)}×`;
      snapCameraFromControls();
    });

    // Export the retargeted character + its AnimationClip as .glb, .bvh, or .fbx
    const exportGlbBtn = document.getElementById('btn-mocap-export-glb');
    exportGlbBtn?.addEventListener('click', () => this.exportAnimatedGLB());
    const exportBvhBtn = document.getElementById('btn-mocap-export-bvh');
    exportBvhBtn?.addEventListener('click', () => this.exportBVH());
    const exportFbxBtn = document.getElementById('btn-mocap-export-fbx');
    exportFbxBtn?.addEventListener('click', () => this.exportFBX());

    // Fullscreen focus mode
    const fsBtn = document.getElementById('btn-mocap-fullscreen');
    const mocapPane = document.getElementById('dock-mocap');
    const homeParent = mocapPane?.parentElement;
    let focusPlaceholder = null;
    const setFocus = (on) => {
      if (!mocapPane || !homeParent) return;
      if (on && mocapPane.parentElement !== document.body) {
        focusPlaceholder = document.createComment('mocap-pane-home');
        homeParent.insertBefore(focusPlaceholder, mocapPane);
        document.body.appendChild(mocapPane);
      } else if (!on && focusPlaceholder) {
        focusPlaceholder.parentNode.replaceChild(mocapPane, focusPlaceholder);
        focusPlaceholder = null;
      }
      mocapPane.classList.toggle('mocap-focus', on);
      document.body.classList.toggle('mocap-focus-active', on);
      if (fsBtn) {
        fsBtn.textContent = on ? '✕' : '⛶';
        fsBtn.title = on ? 'Exit fullscreen (Esc)' : 'Expand fullscreen (Esc to exit)';
      }
      setTimeout(() => { this._syncCanvasSize(); this._drawOverlay(); }, 80);
    };
    fsBtn?.addEventListener('click', () => setFocus(!mocapPane?.classList.contains('mocap-focus')));
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && mocapPane?.classList.contains('mocap-focus') && !shouldBlockViewportShortcut()) {
        setFocus(false);
      }
    });
    this._setMocapFocus = setFocus;

    // Timeline & Overlay checkboxes
    syncCheckbox?.addEventListener('change', (e) => {
      this.isSyncWithTimeline = e.target.checked;
    });
    overlayCheckbox?.addEventListener('change', (e) => {
      this.showOverlay = e.target.checked;
      this._drawOverlay();
    });

    // Video element listeners + 60fps RAF sync loop
    if (this.videoElement) {
      this.videoElement.addEventListener('timeupdate', () => this._onVideoTimeUpdate());
      this.videoElement.addEventListener('loadedmetadata', () => this._onVideoMetadataLoaded());
      this.videoElement.addEventListener('loadeddata', () => {
        // Seek slightly past 0.00s black fade-in on initial load so user sees the dancer right away
        if (this.videoElement.paused && this.videoElement.currentTime < 0.05 && (this.videoElement.duration || 0) > 1.0) {
          this.videoElement.currentTime = 0.35;
        }
        this._syncCanvasSize();
        this._drawOverlay();
      });
      this.videoElement.addEventListener('play', () => {
        this._updatePlayUIState(true);
        if (!this._isRendering) {
          if (this.app?.timelineEngine?.isPlaying) {
            this.app.timelineEngine.pause();
          }
          this.retargeter.pause(); // Driven frame-accurately by video clock in _startSyncLoop
          this._startSyncLoop();
        }
      });
      this.videoElement.addEventListener('pause', () => {
        this._updatePlayUIState(false);
        this._stopSyncLoop();
        if (!this._isRendering) this.retargeter.pause();
      });
      this.videoElement.addEventListener('ended', () => {
        this._updatePlayUIState(false);
        this._stopSyncLoop();
      });
    }

    // Intercept Top Dock "▶ Play (Space)", "⏮ Rewind", and Spacebar when Video Mocap tab is active
    const isMocapActive = () => {
      const pane = document.getElementById('dock-mocap');
      return !!(pane && (pane.classList.contains('active') || pane.classList.contains('mocap-focus')));
    };
    const topPlayBtn = document.getElementById('btn-timeline-play');
    const topRewindBtn = document.getElementById('btn-timeline-rewind');
    topPlayBtn?.addEventListener('click', (e) => {
      if (isMocapActive()) {
        e.stopImmediatePropagation();
        e.preventDefault();
        this.togglePlay();
      }
    }, true);
    topRewindBtn?.addEventListener('click', (e) => {
      if (isMocapActive()) {
        e.stopImmediatePropagation();
        e.preventDefault();
        this.seek(0);
      }
    }, true);
    window.addEventListener('keydown', (e) => {
      if (!isMocapActive()) return;
      if (shouldBlockViewportShortcut()) return;
      if (e.code === 'Space' && !e.ctrlKey && !e.altKey) {
        e.stopImmediatePropagation();
        e.preventDefault();
        this.togglePlay();
      } else if (e.code === 'ArrowLeft' && !e.ctrlKey) {
        e.stopImmediatePropagation();
        e.preventDefault();
        if (e.shiftKey) this.seek(0);
        else this.stepFrame(-1);
      } else if (e.code === 'ArrowRight' && !e.ctrlKey) {
        e.stopImmediatePropagation();
        e.preventDefault();
        this.stepFrame(1);
      }
    }, true);

    // Resize observer so 2D skeleton overlay always fits the video element
    if (typeof ResizeObserver !== 'undefined' && this.videoElement) {
      this._resizeObserver = new ResizeObserver(() => {
        this._syncCanvasSize();
        this._drawOverlay();
      });
      this._resizeObserver.observe(this.videoElement);
    }

    // Hook Studio Timeline manual scrubbing (only when timeline is NOT playing)
    if (this.app?.timelineEngine) {
      this.app.timelineEngine.on('frameChanged', ({ frame, fps, isPlaying }) => {
        if (!isPlaying && this.isSyncWithTimeline && this.videoElement && this.videoElement.paused && !this.videoElement.seeking) {
          const targetTime = frame / (fps || 30);
          if (targetTime <= (this.videoElement.duration || 0) && Math.abs(this.videoElement.currentTime - targetTime) > 0.05) {
            this.videoElement.currentTime = targetTime;
            this.retargeter.seek(targetTime);
            this._drawOverlay();
          }
        }
      });
    }

    const sm = this.app?.sceneManager || window.sceneManager;
    if (sm?.on) {
      sm.on('objectRemoved', () => {
        this.refreshTargetList();
      });
    }
  }

  _startSyncLoop() {
    this._stopSyncLoop();
    const tick = () => {
      if (!this.videoElement || this.videoElement.paused || this._isRendering) {
        this._rafSyncId = null;
        return;
      }
      this._syncPlaybackFrame();
      this._rafSyncId = requestAnimationFrame(tick);
    };
    this._rafSyncId = requestAnimationFrame(tick);
  }

  _stopSyncLoop() {
    if (this._rafSyncId) {
      cancelAnimationFrame(this._rafSyncId);
      this._rafSyncId = null;
    }
  }

  _syncPlaybackFrame(overrideTime = null) {
    if (!this.videoElement || this._isRendering) return;
    const rawCur = this.videoElement.currentTime || 0;
    const cur = Number.isFinite(overrideTime)
      ? overrideTime
      : (this.videoElement.paused && rawCur < 0.02 && Number.isFinite(this._lastSeekTarget) ? this._lastSeekTarget : rawCur);
    const dur = this.videoElement.duration || 1;
    const clipDur = this.retargeter.currentClip?.duration || 0;

    // If only a partial clip was analyzed, loop video at clipDur so video & 3D stay in sync
    if (!Number.isFinite(overrideTime) && !this.videoElement.paused && clipDur > 0.2 && clipDur < dur - 0.5 && cur > clipDur) {
      this._lastSeekTarget = null;
      this.videoElement.currentTime = 0;
      return;
    }

    const timeCur = document.getElementById('mocap-time-current');
    if (timeCur) timeCur.textContent = this._formatTime(cur);

    const pct = Math.max(0, Math.min(100, (cur / dur) * 100));
    const scrubber = document.getElementById('mocap-scrubber');
    if (scrubber) {
      if (!scrubber.matches(':active')) {
        scrubber.value = String(pct);
      }
      scrubber.style.setProperty('--progress', `${pct}%`);
    }

    // Update top dock header Frame counter when synced
    if (this.isSyncWithTimeline) {
      const fps = this.mocapData?.fps || this.app?.timelineEngine?.fps || 30;
      const frameEl = document.getElementById('timeline-current-frame');
      if (frameEl) frameEl.textContent = String(Math.round(cur * fps));
    }

    // Lock 3D character pose to exact video timestamp
    this.retargeter.seek(cur);

    // Track root motion softly when Follow Character is active
    this._updateFollowCamera();

    // Draw 60fps 2D skeleton overlay
    this._drawOverlay(cur);
  }

  _getSceneCandidates() {
    const sm = this.app?.sceneManager || window.sceneManager;
    const engine = this.app?.engine || window.studioEngine || window.engine;
    if (typeof sm?.getAllObjects === 'function') return sm.getAllObjects();
    if (sm?.objects instanceof Map) return Array.from(sm.objects.values());
    if (Array.isArray(sm?.objects)) return sm.objects;
    return engine?.scene?.children || [];
  }

  _hideUntouchedDefaultCube() {
    const sm = this.app?.sceneManager || window.sceneManager;
    const engine = this.app?.engine || window.studioEngine || window.engine;
    const candidates = this._getSceneCandidates();
    let hiddenAny = false;
    for (const o of candidates) {
      if (!o || o.visible === false) continue;
      const isDefaultCube = o.name === 'Cube'
        && o.userData?.primitiveType === 'cube'
        && Math.abs(o.position.x) < 0.05
        && Math.abs(o.position.y - 1.0) < 0.05
        && Math.abs(o.position.z) < 0.05
        && Math.abs(o.scale.x - 1) < 0.05
        && Math.abs(o.scale.y - 1) < 0.05
        && Math.abs(o.scale.z - 1) < 0.05;
      if (isDefaultCube) {
        o.visible = false;
        o.userData = o.userData || {};
        o.userData._autoHiddenForMocap = true;
        hiddenAny = true;
        try { sm?.emit?.('objectChanged', o); } catch (_) { /* ignore */ }
      }
    }
    if (hiddenAny) {
      engine?.requestRender?.();
    }
    return hiddenAny;
  }

  _restoreAutoHiddenDefaultCube() {
    const sm = this.app?.sceneManager || window.sceneManager;
    const engine = this.app?.engine || window.studioEngine || window.engine;
    const candidates = this._getSceneCandidates();
    let restoredAny = false;
    for (const o of candidates) {
      if (!o || !o.userData?._autoHiddenForMocap) continue;
      delete o.userData._autoHiddenForMocap;
      if (o.visible === false) {
        o.visible = true;
        restoredAny = true;
        try { sm?.emit?.('objectChanged', o); } catch (_) { /* ignore */ }
      }
    }
    if (restoredAny) {
      engine?.requestRender?.();
    }
    return restoredAny;
  }

  _getCharacterAnchorWorldPos(target) {
    if (!target) return null;
    target.updateMatrixWorld(true);
    let hipsBone = null;
    target.traverse((o) => {
      if (!hipsBone && o.isBone && /hips|pelvis/i.test(o.name)) {
        hipsBone = o;
      }
    });
    const out = new THREE.Vector3();
    if (hipsBone) {
      hipsBone.getWorldPosition(out);
    } else {
      target.getWorldPosition(out);
    }
    return out;
  }

  _updateFollowCamera() {
    const followEl = document.getElementById('mocap-follow-camera');
    if (followEl && !followEl.checked) {
      this._followAnchorPos = null;
      return;
    }
    const target = this._lastAppliedTarget;
    if (!target || !target.parent) return;
    const engine = this.app?.engine || window.studioEngine || window.engine;
    if (!engine?.camera || !engine?.controls) return;

    const cur = this._getCharacterAnchorWorldPos(target);
    if (!cur) return;
    if (!this._followAnchorPos) {
      this._followAnchorPos = cur.clone();
      return;
    }
    const dx = cur.x - this._followAnchorPos.x;
    const dy = (cur.y - this._followAnchorPos.y) * 0.25;
    const dz = cur.z - this._followAnchorPos.z;
    if (dx * dx + dy * dy + dz * dz > 1e-7 && dx * dx + dy * dy + dz * dz < 4.0) {
      const k = 0.32;
      engine.camera.position.x += dx * k;
      engine.camera.position.y = Math.max(0.15, engine.camera.position.y + dy * k);
      engine.camera.position.z += dz * k;
      engine.controls.target.x += dx * k;
      engine.controls.target.y += dy * k;
      engine.controls.target.z += dz * k;
      engine.controls.update();
      engine.requestRender?.();
    }
    this._followAnchorPos.copy(cur);
  }

  _updatePlayUIState(isPlaying) {
    const playBtn = document.getElementById('btn-mocap-play');
    if (playBtn) {
      playBtn.textContent = isPlaying ? '⏸ Pause' : '▶ Play';
      playBtn.classList.toggle('is-playing', isPlaying);
    }
    const stageBtn = document.getElementById('mocap-stage-play-btn');
    if (stageBtn) {
      stageBtn.classList.toggle('is-playing', isPlaying);
      stageBtn.innerHTML = isPlaying
        ? '<svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>'
        : '<svg viewBox="0 0 24 24" width="26" height="26" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
    }
    const topPlayBtn = document.getElementById('btn-timeline-play');
    const mocapPane = document.getElementById('dock-mocap');
    if (topPlayBtn && mocapPane && (mocapPane.classList.contains('active') || mocapPane.classList.contains('mocap-focus'))) {
      topPlayBtn.textContent = isPlaying ? '⏸ Pause' : '▶ Play (Space)';
    }
  }

  _bindPoseEditEvents() {
    const toggleBtn = document.getElementById('btn-pose-edit-toggle');
    if (toggleBtn) toggleBtn.addEventListener('click', () => this.togglePoseEdit());

    const vpBtn = document.getElementById('btn-vp-pose');
    if (vpBtn) vpBtn.addEventListener('click', () => {
      if (!document.getElementById('btn-pose-edit-toggle')) {
        this._log('Open the "Video Mocap (AI)" tab to use the manual bone posing controls.', '#e67e22');
        return;
      }
      this.togglePoseEdit();
    });

    const resetBtn = document.getElementById('btn-pose-edit-reset');
    if (resetBtn) resetBtn.addEventListener('click', () => {
      if (!this.poseEditor || !this.poseEditor.enabled) {
        this._log('Enable bone posing mode first.', '#e67e22');
        return;
      }
      this.poseEditor.resetAll();
      this._log('↺ Reset all bones to Rest Pose.', '#2ecc71');
    });

    const mirrorBtn = document.getElementById('btn-pose-edit-mirror');
    if (mirrorBtn) mirrorBtn.addEventListener('click', () => {
      if (!this.poseEditor || !this.poseEditor.enabled) {
        this._log('Enable bone posing mode first.', '#e67e22');
        return;
      }
      this.poseEditor.mirrorLR();
      this._log('🪞 Mirrored L ➔ R limb pose.', '#2ecc71');
    });

    const jointSel = document.getElementById('pose-edit-joint');
    if (jointSel) jointSel.addEventListener('change', (e) => {
      if (!this.poseEditor || !this.poseEditor.enabled) return;
      const key = e.target.value;
      if (!key) return;
      this.poseEditor.selectJoint(key);
      const bone = this.poseEditor.bones.get(key);
      const handle = bone ? this.poseEditor.handles.get(bone.uuid) : null;
      if (handle) this.poseEditor._attachGizmoForHandle(handle);
    });

    const modeSel = document.getElementById('pose-edit-mode');
    if (modeSel) modeSel.addEventListener('change', (e) => {
      if (this.poseEditor) {
        this.poseEditor.mode = e.target.value;
        this.poseEditor.chainDepth = e.target.value === 'ik' ? 4 : 1;
      }
    });

    const loadMocapBtn = document.getElementById('btn-pose-edit-load-mocap');
    if (loadMocapBtn) loadMocapBtn.addEventListener('click', () => {
      if (this.mocapData) {
        this.applyRetargeting();
        this._log('🎞 Reloaded mocap clip.', '#3498db');
      } else {
        this._log('No mocap data yet. Click "Analyze & Apply Full Video" first.', '#e67e22');
      }
    });

    const bakeBtn = document.getElementById('btn-pose-edit-bake');
    if (bakeBtn) bakeBtn.addEventListener('click', () => {
      if (!this.poseEditor || !this.poseEditor.enabled) {
        this._log('Enable bone posing mode first.', '#e67e22');
        return;
      }
      const clip = this.poseEditor.bakeToClip();
      if (!clip) {
        this._log('No character available to bake.', '#e74c3c');
        return;
      }
      this.retargeter.exitManualEdit(clip);
      this.poseEditor.enable(false);
      this.poseEditor.disposeHandles();
      const btn = document.getElementById('btn-pose-edit-toggle');
      if (btn) { btn.textContent = 'Enable Bone Posing'; btn.style.background = '#1f6f8b'; }
      const statusEl = document.getElementById('pose-edit-status');
      if (statusEl) { statusEl.textContent = 'Baked'; statusEl.style.color = '#2ecc71'; }
      this._log(`Baked pose to clip "${clip.name}" (${clip.tracks.length} tracks).`, '#2ecc71');
    });

    const exportBtn = document.getElementById('btn-pose-edit-export');
    if (exportBtn) exportBtn.addEventListener('click', () => {
      if (!this.poseEditor) {
        this._log('Bone posing mode is not active.', '#e67e22');
        return;
      }
      const pose = this.poseEditor.exportPose();
      const blob = new Blob([JSON.stringify(pose, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `pose_${Date.now()}.json`;
      a.click();
      URL.revokeObjectURL(a.href);
      this._log('Exported pose to JSON file.', '#2ecc71');
    });
  }

  /** Releases the WASM landmarker (model lives in GPU/WASM memory) and revokes Blob URLs. */
  dispose() {
    try {
      if (this._trackAbort) this._trackAbort.abort();
    } catch (_) {}
    this._trackAbort = null;
    if (this._uploadedObjectUrl) {
      try { URL.revokeObjectURL(this._uploadedObjectUrl); } catch (_) {}
      this._uploadedObjectUrl = null;
    }
    if (this.lastRenderResult?.url) {
      try { URL.revokeObjectURL(this.lastRenderResult.url); } catch (_) {}
      this.lastRenderResult.url = null;
    }
    this._uploadedFile = null;
    if (this.browserEngine) {
      this.browserEngine.dispose();
      this.browserEngine = null;
    }
    this._stopProgressPolling();
  }

  onShow() {
    this._ensureMediaInitialized();
    this.refreshTargetList();
    if (!this.container.classList.contains('mocap-focus') &&
        this.container.getBoundingClientRect().width < 480) {
      this._setMocapFocus?.(true);
    }
    this._syncCanvasSize();
    this._drawOverlay();
  }

  _log(msg, color = '#aaa') {
    const box = document.getElementById('mocap-log-box');
    if (!box) return;
    const time = new Date().toLocaleTimeString();
    const div = document.createElement('div');
    div.style.color = String(color || '#aaa');
    div.style.marginBottom = '2px';
    const ts = document.createElement('span');
    ts.style.color = '#555';
    ts.textContent = `[${time}]`;
    div.append(ts, document.createTextNode(` ${String(msg ?? '')}`));
    box.appendChild(div);
    while (box.children.length > 250) {
      box.removeChild(box.firstElementChild);
    }
    box.scrollTop = box.scrollHeight;
  }

  // ---------------------------------------------------------------- //
  // Manual skeleton editing
  // ---------------------------------------------------------------- //

  _resolveTargetCharacter({ includeUnrigged = false } = {}) {
    const sm = this.app?.sceneManager || window.sceneManager;
    const targetSelect = document.getElementById('mocap-target-character');
    let target = null;
    const selectedId = targetSelect?.value;
    if (selectedId && sm) {
      target = (typeof sm.resolveObject === 'function' ? sm.resolveObject(selectedId) : null) ||
               sm.scene?.getObjectById(parseInt(selectedId, 10)) ||
               sm.scene?.getObjectByProperty('uuid', selectedId);
    }
    if (!target && sm) {
      for (const obj of sm.getAllObjects()) {
        let hasBone = false;
        obj.traverse((child) => { if (child.isBone) hasBone = true; });
        if (hasBone) { target = obj; break; }
      }
      if (!target && includeUnrigged) {
        const active = sm.getActiveObject?.();
        if (active && this._isCharacterMeshCandidate(active)) target = active;
      }
    }
    return target;
  }

  _isCharacterMeshCandidate(obj) {
    if (!obj || obj.userData?.isSkeletonHelper || obj.userData?.isJointHandle || obj.userData?.isIKHandle) return false;
    if (obj.isLight || obj.isCamera || obj.userData?.isFloor || obj.userData?.isCyclorama) return false;
    if (obj.name === 'Cube' && obj.userData?.primitiveType === 'cube' && obj.userData?._autoHiddenForMocap) return false;
    let hasMesh = false;
    obj.traverse?.((c) => {
      if (c.isMesh && !c.userData?.isSkeletonHelper && c.geometry?.attributes?.position?.count >= 8) {
        hasMesh = true;
      }
    });
    return hasMesh;
  }

  async _ensurePoseEditor() {
    if (this.poseEditor) return this.poseEditor;
    const engine = this.app?.engine || this.engine || window.engine;
    const sm = this.app?.sceneManager || window.sceneManager;
    if (!engine) throw new Error('3D Engine is not ready');
    const mod = await import('../animation/manual-pose-editor.js');
    this.poseEditor = new mod.ManualPoseEditor(engine, sm);
    this._jointLabels = mod.JOINT_LABELS;
    return this.poseEditor;
  }

  async togglePoseEdit() {
    try {
      const editor = await this._ensurePoseEditor();
      const statusEl = document.getElementById('pose-edit-status');
      const btn = document.getElementById('btn-pose-edit-toggle');

      if (editor.enabled) {
        editor.enable(false);
        editor.disposeHandles();
        if (btn) { btn.textContent = '✏️ Enable Bone Edit'; btn.style.background = '#1f6f8b'; }
        if (statusEl) { statusEl.textContent = 'Off'; statusEl.style.color = '#666'; }
        this._log('Manual bone editing disabled.', '#888');
        return;
      }

      const target = this._resolveTargetCharacter();
      if (!target) {
        this._log('⚠️ No rigged character in scene. Load Mannequin CC0 / Bot CC0 first.', '#e74c3c');
        return;
      }

      this.retargeter.enterManualEdit();
      if (this.videoElement) this.videoElement.pause();

      editor.setCharacter(target);
      if (!this._poseUpdateHooked) {
        const engine = this.app?.engine || window.engine;
        if (engine && typeof engine.addRenderCallback === 'function') {
          engine.addRenderCallback(() => editor.update(), { passive: true });
        }
        this._poseUpdateHooked = true;
      }

      this._fillJointList(editor);
      if (btn) { btn.textContent = '⏹ Disable Bone Edit'; btn.style.background = '#c0392b'; }
      if (statusEl) { statusEl.textContent = `Editing: ${target.name}`; statusEl.style.color = '#2ecc71'; }
      this._log(`✏️ Enabled manual bone editing for "${target.name}".`, '#00b4ff');
    } catch (err) {
      console.error(err);
      this._log(`❌ Failed to enable manual bone editing: ${err.message}`, '#e74c3c');
    }
  }

  _fillJointList(editor) {
    const sel = document.getElementById('pose-edit-joint');
    if (!sel || !editor) return;
    const labels = this._jointLabels || {};
    sel.innerHTML = '<option value="">(Click a joint in the 3D viewport)</option>';
    for (const key of editor.bones.keys()) {
      const opt = document.createElement('option');
      opt.value = key;
      opt.textContent = labels[key] || key;
      sel.appendChild(opt);
    }
  }

  // ---------------------------------------------------------------- //
  // Video Loading & Overlay
  // ---------------------------------------------------------------- //

  loadVideo(videoPath, options = {}) {
    if (!this.videoElement) return;
    this._stopSyncLoop();
    this._lastSeekTarget = null;
    if (this._uploadedObjectUrl && this._uploadedObjectUrl !== videoPath) {
      try { URL.revokeObjectURL(this._uploadedObjectUrl); } catch (_) {}
      this._uploadedObjectUrl = null;
    }
    if (options.isObjectUrl && typeof videoPath === 'string' && videoPath.startsWith('blob:')) {
      this._uploadedObjectUrl = videoPath;
    }
    this.currentVideoPath = videoPath;
    this._uploadedFile = options.file || null;
    this.mocapData = null;

    const applyBtn = document.getElementById('btn-mocap-apply');
    if (applyBtn) {
      applyBtn.disabled = true;
    }

    const badge = document.getElementById('mocap-coverage-badge');
    if (badge) {
      badge.textContent = 'Not analyzed';
      badge.className = 'mocap-pill mocap-pill--ghost';
    }

    const pill = document.getElementById('mocap-status-pill');
    if (pill) {
      pill.textContent = 'Loading...';
      pill.style.background = '#2c3e50';
      pill.style.color = '#3498db';
    }

    const prompt = document.getElementById('mocap-overlay-prompt');
    if (prompt) prompt.style.display = 'none';

    const resolvedVideoSrc = options.isObjectUrl ? videoPath : resolveCdnAssetUrl(videoPath);
    this.videoElement.src = resolvedVideoSrc;
    this.videoElement.load();
    this._log(`Loading source video: ${videoPath}...`, '#3498db');
  }

  /**
   * Apply one of the 3 curated Hunger Motion Beta templates (unity_humanoid, vrm_avatar, tiktok_dance).
   * Loads the template's CC0/CC-BY character, reference clip, retargeting & export defaults.
   */
  async applyTemplate(templateId, { autoRun = false } = {}) {
    const tpl = getMotionTemplate(templateId);
    if (!tpl) return null;
    this.activeTemplateId = tpl.id;
    this._ensureMediaInitialized();

    this.container?.querySelectorAll('.mocap-tpl-card[data-template]').forEach((el) => {
      el.classList.toggle('active', el.getAttribute('data-template') === tpl.id);
    });
    const hintBox = document.getElementById('mocap-template-hint');
    const hintText = document.getElementById('mocap-template-hint-text');
    if (hintBox && hintText) {
      hintText.textContent = `${tpl.name}: ${tpl.exportNote}`;
      hintBox.style.display = 'flex';
    }

    const s = tpl.settings;
    const setVal = (id, val) => {
      const el = document.getElementById(id);
      if (el && val !== undefined) el.value = String(val);
    };
    const setChk = (id, checked) => {
      const el = document.getElementById(id);
      if (el && typeof checked === 'boolean') el.checked = checked;
    };
    setVal('mocap-model-tier', s.modelTier);
    setVal('mocap-max-frames', s.maxFrames);
    setVal('mocap-frame-step', s.frameStep);
    setVal('mocap-subject-mode', s.subjectMode);
    setChk('mocap-auto-align', s.autoAlign);
    setChk('mocap-ground-feet', s.groundFeet);
    setChk('mocap-root-motion', s.rootMotion);
    setChk('mocap-foot-lock', s.footLock);
    setChk('mocap-track-hands', s.trackHands);
    setChk('mocap-track-face', s.trackFace);
    setChk('mocap-cam-comp', s.camComp);
    setVal('mocap-smoothing', s.smoothing);
    const smVal = document.getElementById('mocap-smoothing-val');
    if (smVal) smVal.textContent = `${s.smoothing}%`;
    setVal('mocap-depth-stability', s.depthStability);
    const dpVal = document.getElementById('mocap-depth-stability-val');
    if (dpVal) dpVal.textContent = `${s.depthStability}%`;
    setVal('mocap-yaw-offset', s.yawOffset);
    const ywVal = document.getElementById('mocap-yaw-offset-val');
    if (ywVal) ywVal.textContent = `${s.yawOffset}°`;
    setVal('mocap-camera-preset', s.cameraPreset);
    setVal('mocap-render-res', s.renderRes);
    setVal('mocap-render-fps', s.renderFps);
    setChk('mocap-render-audio', s.includeAudio);

    const presetSel = document.getElementById('mocap-video-preset');
    if (presetSel) {
      if (![...presetSel.options].some((o) => o.value === tpl.videoUrl)) {
        const opt = document.createElement('option');
        opt.value = tpl.videoUrl;
        opt.textContent = tpl.videoLabel;
        presetSel.appendChild(opt);
      }
      presetSel.value = tpl.videoUrl;
    }

    this.loadVideo(tpl.videoUrl);
    telemetry.track('template_selected', { templateId: tpl.id, exportTarget: tpl.exportTarget });
    this._log(`Loaded template "${tpl.name}" (${tpl.badge})`, '#f97316');

    try {
      await this._loadPresetCharacter(tpl.characterUrl, tpl.characterName, { autoApply: false });
    } catch (_) {
      if (tpl.fallbackCharacterUrl && tpl.fallbackCharacterUrl !== tpl.characterUrl) {
        await this._loadPresetCharacter(tpl.fallbackCharacterUrl, 'Mannequin_CC0', { autoApply: false }).catch(() => {});
      }
    }

    if (autoRun) {
      await this.runFullVideoPipeline();
    }
    return tpl;
  }

  _onVideoMetadataLoaded() {
    const w = this.videoElement.videoWidth;
    const h = this.videoElement.videoHeight;
    const dur = this.videoElement.duration || 0;
    const estFrames = Math.round(dur * 30);

    const info = document.getElementById('mocap-video-info');
    if (info) {
      info.textContent = `${w}×${h} • ${dur.toFixed(1)}s`;
    }

    const timeTotal = document.getElementById('mocap-time-total');
    if (timeTotal) {
      timeTotal.textContent = this._formatTime(dur);
    }

    // Update the "Full Video" option label with exact video duration & frame estimate
    const maxFramesSelect = document.getElementById('mocap-max-frames');
    const fullOpt = maxFramesSelect?.querySelector('option[value="0"]');
    if (fullOpt && dur > 0) {
      fullOpt.textContent = `Full Video (~${estFrames} frames • ${dur.toFixed(1)}s)`;
    }

    const pill = document.getElementById('mocap-status-pill');
    if (pill) {
      pill.textContent = 'Video Ready';
      pill.style.background = '#27ae60';
      pill.style.color = '#fff';
    }

    this._syncCanvasSize();
    this._drawOverlay();
    this._log(`Video ready: ${w}×${h}, duration ${dur.toFixed(2)}s (~${estFrames} frames).`, '#2ecc71');
  }

  _formatTime(sec) {
    if (isNaN(sec) || sec < 0) return '00:00.00';
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    const ms = Math.floor((sec % 1) * 100);
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(ms).padStart(2, '0')}`;
  }

  _syncCanvasSize() {
    if (!this.videoElement || !this.canvasElement) return;
    const rect = this.videoElement.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      this.canvasElement.width = rect.width;
      this.canvasElement.height = rect.height;
      this.canvasElement.style.width = `${rect.width}px`;
      this.canvasElement.style.height = `${rect.height}px`;
      this.canvasElement.style.left = `${this.videoElement.offsetLeft}px`;
      this.canvasElement.style.top = `${this.videoElement.offsetTop}px`;
    }
  }

  togglePlay() {
    if (!this.videoElement) return;
    this._lastSeekTarget = null;
    if (this.videoElement.paused) {
      this.videoElement.play().catch((err) => {
        console.warn('[MocapUI] Video play error:', err);
      });
    } else {
      this.videoElement.pause();
    }
  }

  stepFrame(delta = 1) {
    if (!this.videoElement) return;
    if (!this.videoElement.paused) {
      this.videoElement.pause();
    }
    const fps = this.mocapData?.fps || 30;
    const dur = this.videoElement.duration || 0;
    const baseTime = (this.videoElement.paused && (this.videoElement.currentTime || 0) < 0.02 && Number.isFinite(this._lastSeekTarget))
      ? this._lastSeekTarget
      : (this.videoElement.currentTime || 0);
    const nextTime = Math.max(0, Math.min(dur, baseTime + (delta / fps)));
    this.seek(nextTime);
  }

  seek(time) {
    if (!this.videoElement) return;
    const dur = this.videoElement.duration || 1;
    const clamped = Math.max(0, Math.min(dur, time));
    this._lastSeekTarget = clamped > 0 ? clamped : null;
    try { this.videoElement.currentTime = clamped; } catch (_) {}
    this._syncPlaybackFrame(clamped);
  }

  _onVideoTimeUpdate() {
    if (!this.videoElement || this._isRendering) return;
    // When paused/scrubbing, update immediately; when playing, _startSyncLoop handles 60fps updates
    if (this.videoElement.paused) {
      this._syncPlaybackFrame();
    }
  }

  _findClosestFrameIndex(curTime) {
    const frames = this.mocapData?.mocapFrames;
    const lms = this.mocapData?.landmarks2D;
    if (!lms || lms.length === 0) return -1;
    if (!frames || frames.length !== lms.length) {
      const dur = this.mocapData.duration || this.videoElement?.duration || 1.0;
      return Math.min(lms.length - 1, Math.max(0, Math.floor((curTime / dur) * lms.length)));
    }
    // Binary search theo timestamp frame (module mocap-math.js) để đồng bộ VFR chính xác.
    return closestFrameIndexByTime(frames, curTime);
  }

  _drawOverlay(overrideTime = null) {
    if (!this.ctx || !this.canvasElement || !this.videoElement) return;
    const cw = this.canvasElement.width;
    const ch = this.canvasElement.height;
    this.ctx.clearRect(0, 0, cw, ch);

    if (!this.showOverlay || !this.mocapData || !this.mocapData.landmarks2D || this.mocapData.landmarks2D.length === 0) {
      return;
    }

    const rawCur = this.videoElement.currentTime || 0;
    const cur = Number.isFinite(overrideTime)
      ? overrideTime
      : (this.videoElement.paused && rawCur < 0.02 && Number.isFinite(this._lastSeekTarget) ? this._lastSeekTarget : rawCur);
    const frameIndex = this._findClosestFrameIndex(cur);
    if (frameIndex < 0) return;
    const frameLandmarks = this.mocapData.landmarks2D[frameIndex];
    if (!frameLandmarks || frameLandmarks.length === 0) return;

    const vw = this.mocapData.videoWidth || this.videoElement.videoWidth || 1280;
    const vh = this.mocapData.videoHeight || this.videoElement.videoHeight || 720;
    const videoAspect = vw / Math.max(1, vh);
    const canvasAspect = cw / Math.max(1, ch);
    let drawW = cw;
    let drawH = ch;
    let offX = 0;
    let offY = 0;
    if (Math.abs(videoAspect - canvasAspect) > 1e-3) {
      if (canvasAspect > videoAspect) {
        drawH = ch;
        drawW = ch * videoAspect;
        offX = (cw - drawW) * 0.5;
      } else {
        drawW = cw;
        drawH = cw / videoAspect;
        offY = (ch - drawH) * 0.5;
      }
    }

    // Browser WASM returns normalized [0..1] landmarks2D; server engine returns pixels [0..vw, 0..vh].
    let maxCoord = 0;
    for (let i = 0; i < frameLandmarks.length; i++) {
      const p = frameLandmarks[i];
      if (!p) continue;
      if (Math.abs(p[0]) > maxCoord) maxCoord = Math.abs(p[0]);
      if (Math.abs(p[1]) > maxCoord) maxCoord = Math.abs(p[1]);
    }
    const isNormalized = maxCoord <= 2.0;
    const scaleX = isNormalized ? drawW : (drawW / vw);
    const scaleY = isNormalized ? drawH : (drawH / vh);

    // 1. Draw Skeleton Bones
    this.ctx.lineWidth = 2.6;
    this.ctx.strokeStyle = '#00f2fe';
    this.ctx.shadowColor = '#00d2ff';
    this.ctx.shadowBlur = 5;

    for (const [i1, i2] of this.boneConnections) {
      const p1 = frameLandmarks[i1];
      const p2 = frameLandmarks[i2];
      if (p1 && p2 && (p1[2] ?? 1) > 0.25 && (p2[2] ?? 1) > 0.25) {
        this.ctx.beginPath();
        this.ctx.moveTo(offX + p1[0] * scaleX, offY + p1[1] * scaleY);
        this.ctx.lineTo(offX + p2[0] * scaleX, offY + p2[1] * scaleY);
        this.ctx.stroke();
      }
    }

    // 2. Draw Skeleton Joints
    this.ctx.shadowBlur = 3;
    for (let i = 0; i < frameLandmarks.length; i++) {
      const p = frameLandmarks[i];
      if (p && (p[2] ?? 1) > 0.25) {
        const x = offX + p[0] * scaleX;
        const y = offY + p[1] * scaleY;
        this.ctx.fillStyle = (i >= 11 && i <= 22) ? '#ff9f43' : (i >= 23 ? '#2ed573' : '#ff4757');
        this.ctx.beginPath();
        this.ctx.arc(x, y, 3.8, 0, Math.PI * 2);
        this.ctx.fill();
      }
    }
    this.ctx.shadowBlur = 0;
  }

  // ---------------------------------------------------------------- //
  // Full-Video 1-Click Pipeline & AI Tracking
  // ---------------------------------------------------------------- //

  /**
   * 1-Click Full Video Pipeline:
   * 1. Sets frame limit to 0 (Full Video 100%)
   * 2. Ensures a rigged 3D character is loaded in the scene (auto-loads Mannequin_CC0.glb if none)
   * 3. Runs MediaPipe tracking across the entire video with live progress bar
   * 4. Retargets onto the 3D character, syncs timeline, and starts playback
   */
  async runFullVideoPipeline() {
    if (this.isTracking) return;

    const maxFramesSelect = document.getElementById('mocap-max-frames');
    if (maxFramesSelect) maxFramesSelect.value = '0';

    // Ensure a rigged character exists in the scene
    let target = this._resolveTargetCharacter();
    if (!target) {
      this._log('🤖 No rigged character in scene — auto-loading Mannequin_CC0.glb...', '#00b4ff');
      try {
        target = await this._loadPresetCharacter('models/Mannequin_CC0.glb', 'Mannequin_CC0', { autoApply: false });
      } catch (e) {
        this._log(`⚠️ Failed to auto-load Mannequin_CC0.glb: ${e.message}`, '#e67e22');
      }
    }

    const ok = await this.runTracking({ forceFullVideo: true });
    if (ok && this.mocapData) {
      await this.applyRetargeting();
    }
  }

  _startProgressPolling() {
    this._stopProgressPolling();
    const wrap = document.getElementById('mocap-track-progress-wrap');
    const bar = document.getElementById('mocap-track-progress');
    const txt = document.getElementById('mocap-track-progress-text');
    if (wrap) wrap.style.display = 'flex';
    if (bar) bar.style.width = '2%';
    if (txt) txt.textContent = 'Starting MediaPipe AI...';

    this._progressPollTimer = setInterval(async () => {
      try {
        const res = await fetch('/api/mocap/progress');
        if (!res.ok) return;
        const p = await res.json();
        if (!p.active && p.percent >= 100) return;
        const pct = Math.max(2, Math.min(99, Number(p.percent) || 0));
        if (bar) bar.style.width = `${pct}%`;
        if (txt && p.total > 0) {
          const eta = p.etaSec > 0 ? ` • ~${Math.ceil(p.etaSec)}s remaining` : '';
          const fpsInfo = p.fps > 0 ? ` • ${p.fps} fps` : '';
          txt.textContent = `Tracking: ${p.processed}/${p.total} frames (${pct.toFixed(0)}%)${fpsInfo}${eta}`;
        }
      } catch (_) {
        // Ignore poll error
      }
    }, 350);
  }

  _stopProgressPolling(finalText = '') {
    if (this._progressPollTimer) {
      clearInterval(this._progressPollTimer);
      this._progressPollTimer = null;
    }
    const wrap = document.getElementById('mocap-track-progress-wrap');
    const bar = document.getElementById('mocap-track-progress');
    const txt = document.getElementById('mocap-track-progress-text');
    if (bar) bar.style.width = finalText ? '100%' : '0%';
    if (txt && finalText) txt.textContent = finalText;
    if (!finalText && wrap) wrap.style.display = 'none';
  }

  /** 'browser' = MediaPipe WASM on this machine (no server GPU), 'server' = Python MediaPipe. */
  _engineMode() {
    const el = document.getElementById('mocap-engine-mode');
    return el && el.value === 'server' ? 'server' : 'browser';
  }

  _showProgress(text, percent = 2) {
    const wrap = document.getElementById('mocap-track-progress-wrap');
    const bar = document.getElementById('mocap-track-progress');
    const txt = document.getElementById('mocap-track-progress-text');
    if (wrap) wrap.style.display = 'flex';
    if (bar) bar.style.width = `${Math.max(2, Math.min(100, percent))}%`;
    if (txt) txt.textContent = text;
  }

  async _trackOnServer({ maxFrames, frameStep }) {
    const resp = await fetch('/api/mocap/track', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        videoPath: this.currentVideoPath,
        maxFrames,
        frameStep,
      }),
    });
    const data = await resp.json();
    if (!resp.ok || !data.success) throw new Error(data.error || 'Server returned tracking error');
    return data;
  }

  /** Full pose tracking inside the browser: zero upload, zero server GPU. */
  async _trackInBrowser({ maxFrames, frameStep }) {
    if (!this.videoElement) throw new Error('No video loaded to analyze.');
    if (!BrowserMocapEngine.isSupported()) {
      throw new Error('This browser does not support WebAssembly — please switch to Server mode.');
    }
    if (!this.browserEngine) this.browserEngine = new BrowserMocapEngine();
    this._trackAbort = typeof AbortController === 'function' ? new AbortController() : null;
    const started = typeof performance !== 'undefined' ? performance.now() : Date.now();
    this._showProgress('Loading MediaPipe model (WASM)...', 3);

    try {
      const modelTier = document.getElementById('mocap-model-tier')?.value || 'full';
      const trackHands = document.getElementById('mocap-track-hands')?.checked !== false;
      const trackFace = document.getElementById('mocap-track-face')?.checked !== false;
      const compensateCamera = document.getElementById('mocap-cam-comp')?.checked !== false;
      const subjectRaw = document.getElementById('mocap-subject-mode')?.value || 'auto';
      const numPoses = subjectRaw === 'single' ? 1 : 4;
      const subjectMode = subjectRaw === 'single' ? 'auto' : subjectRaw;
      return await this.browserEngine.processVideo(this.videoElement, {
        modelTier,
        numPoses,
        subjectMode,
        maxFrames,
        frameStep,
        videoSource: this._uploadedFile || undefined,
        signal: this._trackAbort ? this._trackAbort.signal : undefined,
        footLock: document.getElementById('mocap-foot-lock')?.checked !== false,
        trackHands,
        trackFace,
        compensateCamera,
        onProgress: (p) => this._onBrowserProgress(p, started),
      });
    } finally {
      this._trackAbort = null;
    }
  }

  _onBrowserProgress(p, startedAt) {
    const elapsed = Math.max(0.001, ((typeof performance !== 'undefined' ? performance.now() : Date.now()) - startedAt) / 1000);
    const rate = p.processed / elapsed;
    const eta = rate > 0 ? (p.total - p.processed) / rate : 0;
    const detected = p.detected > 0 ? ` • detected ${p.detected}` : '';
    this._showProgress(
      `Local analysis: ${p.processed}/${p.total} frames (${p.percent.toFixed(0)}%)${detected} • ${rate.toFixed(1)} fps`
      + (eta > 0.5 ? ` • ~${Math.ceil(eta)}s left` : ''),
      p.percent
    );
  }

  cancelTracking() {
    if (!this.isTracking) return false;
    try {
      if (this._trackAbort) this._trackAbort.abort();
    } catch (_) {}
    this._stopProgressPolling('Analysis cancelled.');
    return true;
  }

  async runTracking(opts = {}) {
    if (this.isTracking) return false;
    this.isTracking = true;

    const fullBtn = document.getElementById('btn-mocap-full-pipeline');
    const trackBtn = document.getElementById('btn-mocap-track');
    const cancelBtn = document.getElementById('btn-mocap-cancel');
    const pill = document.getElementById('mocap-status-pill');
    const badge = document.getElementById('mocap-coverage-badge');

    const rawMaxFrames = opts.forceFullVideo
      ? 0
      : parseInt(document.getElementById('mocap-max-frames')?.value ?? '0', 10);
    const maxFrames = isNaN(rawMaxFrames) ? 0 : rawMaxFrames;
    const frameStep = parseInt(document.getElementById('mocap-frame-step')?.value || '1', 10);

    if (fullBtn) fullBtn.disabled = true;
    if (cancelBtn) cancelBtn.style.display = 'inline-flex';
    if (trackBtn) {
      trackBtn.disabled = true;
      trackBtn.innerHTML = `<span>⏳ Analyzing...</span>`;
    }
    if (pill) {
      pill.textContent = 'Tracking Pose...';
      pill.style.background = '#e67e22';
      pill.style.color = '#fff';
    }

    const modeLabel = maxFrames <= 0 ? 'FULL VIDEO (100%)' : `${maxFrames} frames`;
    const useBrowser = this._engineMode() === 'browser';
    const engineLabel = useBrowser ? 'Browser (MediaPipe WASM)' : 'Server (Python MediaPipe)';
    this._log(`🚀 Starting AI analysis · ${engineLabel}: ${this.currentVideoPath} (${modeLabel}, Step: ${frameStep})...`, '#e67e22');
    if (useBrowser) this._showProgress('Loading MediaPipe model (WASM)...', 2);
    else this._startProgressPolling();

    let succeeded = false;
    try {
      const data = useBrowser
        ? await this._trackInBrowser({ maxFrames, frameStep })
        : await this._trackOnServer({ maxFrames, frameStep });

      this.mocapData = data;
      this._syncCanvasSize();
      this._drawOverlay();

      const applyBtn = document.getElementById('btn-mocap-apply');
      if (applyBtn) {
        applyBtn.disabled = false;
      }

      const frameCount = (data.mocapFrames && data.mocapFrames.length) || data.numFrames || 0;
      const covPct = data.coveragePct ?? 100;
      const dur = data.duration || 0;

      if (pill) {
        pill.textContent = `Tracked (${frameCount}f • ${dur.toFixed(1)}s)`;
        pill.style.background = '#27ae60';
        pill.style.color = '#fff';
      }
      if (badge) {
        badge.textContent = data.isFullVideo
          ? `✓ Full Video (${frameCount} frames • ${dur.toFixed(1)}s)`
          : `✓ ${frameCount} frames (${covPct}% • ${dur.toFixed(1)}s)`;
        badge.className = 'mocap-pill mocap-pill--ok';
      }

      this._stopProgressPolling(`Completed: ${frameCount} frames (${dur.toFixed(2)}s • ${covPct}% of video)`);
      const locked = data.footLockFrames
        ? ` • Foot-Lock: ${data.footLockFrames.left + data.footLockFrames.right} frames`
        : '';
      const blockedTxt = data.multiPersonStats?.blockedIntruders > 0
        ? `, ${data.multiPersonStats.blockedIntruders} intruder frames blocked`
        : '';
      const crowd = data.multiPersonStats && (data.multiPersonStats.maxPeopleDetected > 1 || data.multiPersonStats.blockedIntruders > 0)
        ? ` • 1-Subject Lock (${data.multiPersonStats.maxPeopleDetected} people in frame${blockedTxt})`
        : '';
      const engineInfo = data.engine === 'browser-wasm' ? 'in browser (WASM)' : 'on server (Python)';
      this._log(`✅ Analyzed ${frameCount} frames @ ${data.fps || 30}fps (${dur.toFixed(2)}s — ${covPct}% video coverage) · ${engineInfo}${locked}${crowd}!`, '#2ecc71');
      succeeded = true;

    } catch (err) {
      this._stopProgressPolling();
      if (err && err.name === 'AbortError') {
        if (pill) {
          pill.textContent = 'Cancelled';
          pill.style.background = '#555';
          pill.style.color = '#fff';
        }
        this._log('⚠️ AI motion tracking cancelled by user.', '#e67e22');
      } else {
        console.error('[MocapUI] Tracking failed:', err);
        if (pill) {
          pill.textContent = 'Tracking Error';
          pill.style.background = '#e74c3c';
          pill.style.color = '#fff';
        }
        const hint = useBrowser
          ? ' Try switching "AI Compute Backend" to Server if the browser blocks WASM models.'
          : (/mediapipe|opencv|not initialized|chưa sẵn sàng/i.test(err.message)
            ? ' Check backend: run .venv/bin/python server.py.'
            : '');
        this._log(`❌ Motion tracking error: ${err.message}.${hint}`, '#e74c3c');
      }
    } finally {
      this.isTracking = false;
      if (cancelBtn) cancelBtn.style.display = 'none';
      if (fullBtn) fullBtn.disabled = false;
      if (trackBtn) {
        trackBtn.disabled = false;
        trackBtn.innerHTML = `
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z"/></svg>
          <span>1. Analyze AI</span>
        `;
      }
    }
    return succeeded;
  }

  _getRetargetOptionsFromUI() {
    const autoAlignEl = document.getElementById('mocap-auto-align');
    const groundFeetEl = document.getElementById('mocap-ground-feet');
    const rootMotionEl = document.getElementById('mocap-root-motion');
    const smoothingVal = parseFloat(document.getElementById('mocap-smoothing')?.value ?? '35');
    const depthVal = parseFloat(document.getElementById('mocap-depth-stability')?.value ?? '50');
    const yawOffset = parseFloat(document.getElementById('mocap-yaw-offset')?.value || '0') || 0;
    const footLockEl = document.getElementById('mocap-foot-lock');
    const trackHandsEl = document.getElementById('mocap-track-hands');
    const trackFaceEl = document.getElementById('mocap-track-face');

    return {
      autoAlign: autoAlignEl ? autoAlignEl.checked : true,
      groundFeet: groundFeetEl ? groundFeetEl.checked : true,
      rootMotion: rootMotionEl ? rootMotionEl.checked : true,
      footLock: footLockEl ? footLockEl.checked : true,
      trackHands: trackHandsEl ? trackHandsEl.checked : true,
      trackFace: trackFaceEl ? trackFaceEl.checked : true,
      smoothing: (isNaN(smoothingVal) ? 35 : smoothingVal) / 100.0,
      depthStability: (isNaN(depthVal) ? 50 : depthVal) / 100.0,
      yawOffsetDeg: yawOffset,
    };
  }

  async applyRetargeting(options = {}) {
    if (!this.mocapData) {
      this._log('Please run Analyze AI before applying retargeting.', '#e74c3c');
      return false;
    }

    const mySeq = ++this._applySeq;
    await initMocapKernel().catch(() => {});
    if (mySeq !== this._applySeq) return false;

    let target = this._resolveTargetCharacter();
    if (!target) {
      this._log('🤖 No rigged character in scene — auto-loading Mannequin_CC0.glb...', '#3498db');
      try {
        target = await this._loadPresetCharacter('models/Mannequin_CC0.glb', 'Mannequin_CC0', { autoApply: false });
      } catch (e) {
        this._log('⚠️ No rigged character found in the 3D scene! Please click "+ Mannequin CC0" or "+ Bot CC0".', '#e74c3c');
        return false;
      }
      if (mySeq !== this._applySeq) return false;
    }

      if (this._lastAppliedTarget && this._lastAppliedTarget !== target) {
      try { this.retargeter.restoreBindPose(this._lastAppliedTarget); } catch (_) { /* ignore */ }
    }

    this._hideUntouchedDefaultCube();

    const retargetOpts = { ...this._getRetargetOptionsFromUI(), ...options };
    const result = this.retargeter.retarget(target, this.mocapData, retargetOpts);

    if (result.success) {
      this._lastAppliedTarget = target;

      const yawEl = document.getElementById('mocap-inferred-yaw');
      if (yawEl) {
        const sign = result.inferredYawDeg >= 0 ? '+' : '';
        yawEl.textContent = `auto: ${sign}${result.inferredYawDeg.toFixed(0)}°`;
      }
      const facingEl = document.getElementById('mocap-facing-label');
      if (facingEl) {
        const engineTag = result.engine === 'rust-wasm' ? ' • Rust WASM' : '';
        facingEl.textContent = `Video facing: ${result.facingLabel} • Clip: ${result.duration.toFixed(2)}s (${result.numFrames} frames${engineTag})`;
      }

      // Sync Studio Timeline FPS + endFrame with full mocap duration
      const timeline = this.app?.timelineEngine || window.timelineEngine;
      const syncEnabled = document.getElementById('mocap-sync-timeline')?.checked !== false;
      const clipFps = Number(this.mocapData?.fps || result.fps || timeline?.fps || 30);
      const targetFps = Math.max(10, Math.min(120, Math.round(clipFps)));
      if (timeline && syncEnabled && targetFps > 0 && targetFps !== timeline.fps) {
        if (typeof timeline.setFPS === 'function') timeline.setFPS(targetFps);
        else timeline.fps = targetFps;
      }
      const tlFps = timeline?.fps || 30;
      if (timeline && result.duration > 0) {
        const neededFrames = Math.max(60, Math.ceil(result.duration * tlFps));
        if (typeof timeline.setFrameRange === 'function') {
          timeline.setFrameRange(1, neededFrames);
        } else if ('endFrame' in timeline) {
          timeline.endFrame = neededFrames;
        }
      }

      // Attach clip to timeline so Studio Play button and scrubber play back the animation.
      if (timeline && typeof timeline.attachClip === 'function' && this.retargeter.currentClip) {
        timeline.attachClip(target, this.retargeter.currentClip, { syncRange: false });
        if (!this._timelinePlayHooked && typeof timeline.on === 'function') {
          this._timelinePlayHooked = true;
          timeline.on('playStateChanged', ({ isPlaying }) => {
            if (!isPlaying) return;
            // Timeline is primary playback driver: pause video & mocap mixer to avoid fighting for pose.
            try { this.retargeter.pause(); } catch (_) { /* ignore */ }
            try { this.videoElement?.pause(); } catch (_) { /* ignore */ }
          });
        }
      }

      if (!options.silent) {
        const engineDesc = result.engine === 'rust-wasm' ? ' [Rust WASM]' : '';
        this._log(
          `🎉 APPLIED SUCCESSFULLY${engineDesc}: ${result.tracksCount} tracks • ${result.numFrames} frames (${result.duration.toFixed(2)}s) to "${target.name}" (${result.facingLabel}).`,
          '#2ecc71'
        );
      }
      telemetry.markFirstAnimation({
        templateId: this.activeTemplateId || null,
        tracks: result.tracksCount,
        durationSec: result.duration,
      });

      const seekTime = Number.isFinite(options.seekTime)
        ? options.seekTime
        : (this.videoElement ? (this.videoElement.currentTime || 0) : 0);

      if (this.videoElement) {
        if (this.videoElement.paused && !options.keepPaused) {
          this.videoElement.currentTime = 0;
          this.retargeter.seek(0);
          this.videoElement.play().catch(() => {});
        } else if (options.keepPaused) {
          this.retargeter.pause();
          this.retargeter.seek(seekTime);
          if (timeline && !timeline.isPlaying && typeof timeline.seekToFrame === 'function') {
            timeline.seekToFrame(Math.max(1, Math.round(seekTime * tlFps) + 1));
          }
        } else {
          this.retargeter.seek(seekTime);
        }
      } else if (options.keepPaused) {
        this.retargeter.pause();
        this.retargeter.seek(seekTime);
      }

      const autoCamEnabled = document.getElementById('mocap-auto-camera')?.checked !== false;
      if (autoCamEnabled && options.autoCamera !== false) {
        this._followAnchorPos = null;
        this.frameCameraToVideo({ target, auto: true, silent: true });
      } else {
        this._followAnchorPos = this._getCharacterAnchorWorldPos(target);
      }

      if (this.videoElement && options.keepPaused) {
        this._lastSeekTarget = seekTime > 0 ? seekTime : null;
        this._syncCanvasSize();
        this._syncPlaybackFrame(seekTime);
      }
      return true;
    } else {
      this._log(`❌ Retarget Error: ${result.error}`, '#e74c3c');
      return false;
    }
  }

  /**
   * Re-run retargeting immediately after the user tweaks stabilization/orientation controls.
   * Debounced briefly and sequence-guarded to avoid stale re-apply races during slider drags.
   */
  _reapplyAlignment() {
    if (!this.mocapData || !this._lastAppliedTarget) return;
    if (!this.retargeter.currentClip) return;
    if (this._reapplyTimer) clearTimeout(this._reapplyTimer);
    this._reapplyTimer = setTimeout(() => {
      this._reapplyTimer = null;
      const timeline = this.app?.timelineEngine || window.timelineEngine;
      const tlFps = timeline?.fps || 30;
      const wasPaused = this.videoElement
        ? (this.videoElement.paused && !timeline?.isPlaying)
        : !timeline?.isPlaying;
      const rawCur = this.videoElement ? (this.videoElement.currentTime || 0) : 0;
      const curTime = this.videoElement
        ? ((wasPaused && rawCur < 0.02 && Number.isFinite(this._lastSeekTarget)) ? this._lastSeekTarget : rawCur)
        : ((timeline?.currentFrame ? (timeline.currentFrame - 1) / tlFps : 0));
      this.applyRetargeting({
        silent: true,
        keepPaused: wasPaused,
        seekTime: curTime,
        autoCamera: false,
      });
    }, 40);
  }

  // ---------------------------------------------------------------- //
  // 3D Video Rendering
  // ---------------------------------------------------------------- //

  _probeRecorderSupport(mimeType, canvas) {
    return new Promise((resolve) => {
      let stream = null;
      let recorder = null;
      let settled = false;
      let bytes = 0;
      const finish = (ok) => {
        if (settled) return;
        settled = true;
        try {
          if (stream) stream.getTracks().forEach((t) => t.stop());
        } catch (_) { /* ignore */ }
        resolve(ok);
      };
      try {
        stream = canvas.captureStream(12);
        recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 600000 });
      } catch (e) {
        finish(false);
        return;
      }
      recorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) bytes += e.data.size;
      };
      recorder.onerror = () => finish(false);
      const MIN_PROBE_BYTES = 2048;
      recorder.onstop = () => finish(bytes >= MIN_PROBE_BYTES);
      try {
        recorder.start(100);
      } catch (e) {
        finish(false);
        return;
      }
      setTimeout(() => {
        try {
          if (recorder.state !== 'inactive') recorder.stop();
          else finish(bytes >= MIN_PROBE_BYTES);
        } catch (_) {
          finish(bytes >= MIN_PROBE_BYTES);
        }
      }, 700);
      setTimeout(() => finish(bytes >= MIN_PROBE_BYTES), 1500);
    });
  }

  /**
   * Exports the retargeted character and its mocap AnimationClip as ONE binary
   * .glb — the file Blender / Unity / Godot import directly (mesh + skeleton +
   * action). The clip lives on the retargeter, so no timeline round-trip is
   * needed. exportGLTF() drops tracks that don't resolve inside the exported
   * subtree, and only clips with at least one usable track reach the file.
   */
  async exportAnimatedGLB(options = {}) {
    const download = options.download !== false;
    const app = this.app || window.app;
    const exporter = app?.exporter || window.exporter;
    const btn = document.getElementById('btn-mocap-export-glb');
    const statusEl = document.getElementById('mocap-export-status');
    const setStatus = (text, color) => {
      if (statusEl) {
        statusEl.textContent = text;
        statusEl.style.color = color || '';
      }
    };

    if (!exporter || typeof exporter.exportGLTF !== 'function') {
      this._log('❌ Studio glTF exporter not found.', '#e74c3c');
      setStatus('glTF exporter not found.', '#e74c3c');
      return null;
    }

    const target = this._lastAppliedTarget
      || (app?.sceneManager?.getActiveObject?.() || null);
    if (!target) {
      this._log('⚠️ No character to export — apply mocap to a character first.', '#e67e22');
      setStatus('No mocap-applied character found.', '#e67e22');
      return null;
    }

    const clip = this.retargeter?.currentClip;
    if (!clip || !clip.tracks || clip.tracks.length === 0) {
      this._log('⚠️ No mocap clip found — click "Apply" before exporting GLB.', '#e67e22');
      setStatus('No mocap clip to export.', '#e67e22');
      return null;
    }

    const safeName = String(target.name || 'character').replace(/[^\w.-]+/g, '_') || 'character';
    const filename = `${safeName}_mocap.glb`;
    const restore = btn ? { text: btn.textContent, disabled: btn.disabled } : null;
    if (btn) {
      btn.disabled = true;
      btn.textContent = '⏳ Exporting GLB...';
    }
    setStatus(`Exporting ${filename} (${clip.tracks.length} tracks)…`, '#e67e22');

    try {
      const res = await exporter.exportGLTF(target, {
        binary: true,
        filename,
        animations: [clip],
        embedImages: true,
        onlyVisible: true,
        download,
      });
      const kb = (res.blob.size / 1024).toFixed(1);
      const msg = `✅ ${filename} — ${kb} KB · ${clip.tracks.length} tracks · ${clip.duration.toFixed(2)}s`;
      telemetry.recordVideoToGlbResult({
        ok: true,
        sizeKB: Number(kb),
        tracks: clip.tracks.length,
        durationSec: Number(clip.duration.toFixed(2)),
        templateId: this.activeTemplateId || null,
      });
      this._log(msg, '#2ecc71');
      this._log(
        'ℹ️ Godot/Blender do not auto-play on open: select AnimationPlayer (Godot) or Armature (Blender) and press ▶.',
        '#3498db'
      );
      setStatus(msg, '#2ecc71');
      return res;
    } catch (err) {
      telemetry.recordVideoToGlbResult({
        ok: false,
        templateId: this.activeTemplateId || null,
        error: err?.message || String(err),
      });
      const msg = `❌ GLB export error: ${err?.message || err}`;
      this._log(msg, '#e74c3c');
      setStatus(msg, '#e74c3c');
      return null;
    } finally {
      if (btn && restore) {
        btn.disabled = restore.disabled;
        btn.textContent = restore.text;
      }
    }
  }

  /**
   * Exports the active skeleton + retargeted AnimationClip as a standard BioVision (.bvh) file.
   */
  _exportSkeletonText(options = {}, cfg = {}) {
    const download = options.download !== false;
    const app = this.app || window.app;
    const btn = document.getElementById(cfg.btnId);
    const statusEl = document.getElementById('mocap-export-status');
    const setStatus = (text, color) => {
      if (statusEl) {
        statusEl.textContent = text;
        statusEl.style.color = color || '';
      }
    };

    const target = this._lastAppliedTarget || app?.sceneManager?.getActiveObject?.() || null;
    if (!target || !this.retargeter?.currentClip) {
      const msg = `⚠️ Apply mocap to a rigged character before exporting ${cfg.label}.`;
      this._log(msg, '#e67e22');
      setStatus(msg, '#e67e22');
      return null;
    }

    const restore = btn ? { text: btn.textContent, disabled: btn.disabled } : null;
    if (btn) {
      btn.disabled = true;
      btn.textContent = `⏳ Exporting ${cfg.label}...`;
    }

    try {
      const fps = Number(options.fps || this.mocapData?.fps || 30);
      const res = cfg.invoke(target, { fps, ...options });
      const payload = cfg.bytesKey && res[cfg.bytesKey] ? res[cfg.bytesKey] : res[cfg.textKey];
      const mime = payload instanceof Uint8Array ? 'application/octet-stream' : 'text/plain;charset=utf-8';
      const blob = new Blob([payload], { type: mime });
      const safeName = String(target.name || 'character').replace(/[^\w.-]+/g, '_') || 'character';
      const filename = `${safeName}_mocap.${cfg.ext}`;

      if (download) {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 10000);
      }

      const kb = (blob.size / 1024).toFixed(1);
      const msg = `✅ ${filename} — ${kb} KB · ${res.boneCount} bones · ${res.frameCount} frames`;
      this._log(msg, '#2ecc71');
      setStatus(msg, '#2ecc71');
      return { ...res, blob, filename };
    } catch (err) {
      const msg = `❌ ${cfg.label} export error: ${err?.message || err}`;
      this._log(msg, '#e74c3c');
      setStatus(msg, '#e74c3c');
      return null;
    } finally {
      if (btn && restore) {
        btn.disabled = restore.disabled;
        btn.textContent = restore.text;
      }
    }
  }

  /**
   * Exports the active skeleton + retargeted AnimationClip as a standard BioVision (.bvh) file.
   */
  exportBVH(options = {}) {
    return this._exportSkeletonText(options, {
      label: 'BVH',
      btnId: 'btn-mocap-export-bvh',
      ext: 'bvh',
      textKey: 'bvh',
      invoke: (target, opts) => this.retargeter.exportBVH(target, opts),
    });
  }

  /**
   * Exports the active skeleton + retargeted AnimationClip as a Binary Autodesk FBX 7.4 (.fbx) file.
   */
  exportFBX(options = {}) {
    return this._exportSkeletonText(options, {
      label: 'FBX',
      btnId: 'btn-mocap-export-fbx',
      ext: 'fbx',
      bytesKey: 'bytes',
      textKey: 'fbx',
      invoke: (target, opts) => this.retargeter.exportFBX(target, opts),
    });
  }

  /**
   * Đo khung hình chủ thể trong video gốc từ landmark 2D (0..1 của khung hình).
   * @returns {{cx:number, cy:number, w:number, h:number, frames:number}|null}
   */
  _videoFramingFromLandmarks() {
    return videoSubjectBox(this.mocapData?.landmarks2D);
  }

  /**
   * Bao hình thế giới của nhân vật — ưu tiên khung xương để bỏ qua helper/mesh phụ.
   */
  _characterBounds(character) {
    if (!character) return null;
    character.updateWorldMatrix(true, true);
    const box = new THREE.Box3();
    const point = new THREE.Vector3();
    let bones = 0;
    character.traverse((child) => {
      if (!child.isBone) return;
      child.getWorldPosition(point);
      box.expandByPoint(point);
      bones += 1;
    });
    if (bones >= 3 && !box.isEmpty()) return { box, source: 'skeleton' };

    const meshBox = new THREE.Box3().setFromObject(character);
    if (meshBox.isEmpty()) return null;
    return { box: meshBox, source: 'mesh' };
  }

  /**
   * Đặt camera khớp góc nhìn video gốc để render ra đúng khung hình:
   * - trục nhìn: +Z (hệ quy chiếu retargeter đã căn, chủ thể trong video nhìn về +Z)
   * - khoảng cách: để chiều cao nhân vật chiếm đúng % chiều cao khung video
   * - điểm ngắm: lệch để chủ thể rơi đúng vị trí ngang/dọc như trong video
   * @returns {{distance:number, subjectH:number, cx:number, cy:number, source:string}|null}
   */
  frameCameraToVideo(options = {}) {
    const app = this.app || window.app;
    const engine = app?.engine || window.engine || window.studioEngine;
    const camera = engine?.camera;
    const statusEl = document.getElementById('mocap-camera-status');
    const setStatus = (text, color) => {
      if (!statusEl) return;
      statusEl.textContent = text;
      statusEl.style.color = color || '';
    };

    if (!camera) {
      setStatus('Viewport camera not found.', '#e74c3c');
      return null;
    }

    let target = options.target || this._lastAppliedTarget;
    if (!target || !target.parent) {
      target = typeof this._resolveTargetCharacter === 'function' ? this._resolveTargetCharacter() : null;
    }
    if (!target) {
      setStatus('No character in scene — apply mocap to a character first.', '#e67e22');
      return null;
    }

    const bounds = this._characterBounds(target);
    if (!bounds) {
      setStatus('Could not measure character bounds.', '#e74c3c');
      return null;
    }

    const framing = this._videoFramingFromLandmarks();
    const height = Math.max(1e-3, bounds.box.max.y - bounds.box.min.y);
    const center = bounds.box.getCenter(new THREE.Vector3());

    const presetEl = document.getElementById('mocap-camera-preset');
    const pitchEl = document.getElementById('mocap-cam-pitch');
    const pitchValEl = document.getElementById('mocap-cam-pitch-val');
    const fovEl = document.getElementById('mocap-cam-fov');
    const zoomEl = document.getElementById('mocap-cam-zoom');

    const mode = options.mode || presetEl?.value || 'video-match';
    const retargetOpts = typeof this._getRetargetOptionsFromUI === 'function' ? this._getRetargetOptionsFromUI() : {};
    const cameraHint = options.cameraHint
      || this.retargeter?.lastAlignment?.cameraHint
      || (this.mocapData?.mocapFrames
        ? estimateVideoCameraPose(this.mocapData.mocapFrames, this.mocapData.landmarks2D, {
          autoAlign: retargetOpts.autoAlign !== false,
          yawOffsetDeg: retargetOpts.yawOffsetDeg || 0,
          mirrorX: retargetOpts.mirrorX || false,
        })
        : null);

    let pitchDeg;
    if (Number.isFinite(Number(options.pitchDeg))) {
      pitchDeg = Number(options.pitchDeg);
    } else if (this._camPitchDirty && pitchEl) {
      pitchDeg = Number(pitchEl.value);
    } else if (mode === 'video-match' && Number.isFinite(cameraHint?.elevationDeg)) {
      pitchDeg = cameraHint.elevationDeg;
      if (pitchEl) pitchEl.value = String(Math.round(pitchDeg));
      if (pitchValEl) pitchValEl.textContent = `${Math.round(pitchDeg)}°`;
    } else if (pitchEl) {
      pitchDeg = Number(pitchEl.value);
    }

    const fovDeg = Number.isFinite(Number(options.fovDeg))
      ? Number(options.fovDeg)
      : (fovEl ? Number(fovEl.value) : (camera.fov || 48));
    const zoomScale = Number.isFinite(Number(options.zoomScale))
      ? Number(options.zoomScale)
      : (zoomEl ? Number(zoomEl.value) : 1.0);

    if (camera.isPerspectiveCamera && Number.isFinite(fovDeg) && Math.abs(camera.fov - fovDeg) > 0.05) {
      camera.fov = Math.max(20, Math.min(85, fovDeg));
    }

    const aspect = camera.isOrthographicCamera
      ? (camera.right - camera.left) / Math.max(1e-5, camera.top - camera.bottom)
      : (camera.aspect || 16 / 9);

    const orbit = computeCameraOrbitPose({
      center: [center.x, center.y, center.z],
      height,
      framing,
      cameraHint,
      mode,
      pitchDeg,
      fovDeg: camera.fov || fovDeg,
      aspect,
      zoomScale,
      defaultSubjectHeight: options.defaultSubjectHeight,
    });
    const { distance, subjectH, cx: subjectCx, cy: subjectCy, azimuthDeg, elevationDeg } = orbit;

    camera.position.set(orbit.position[0], orbit.position[1], orbit.position[2]);
    const aim = new THREE.Vector3(orbit.aim[0], orbit.aim[1], orbit.aim[2]);
    if (camera.isOrthographicCamera) {
      const viewHeight = height / subjectH;
      camera.zoom = (camera.top - camera.bottom) / viewHeight;
      const azRad = (azimuthDeg * Math.PI) / 180;
      const elRad = (elevationDeg * Math.PI) / 180;
      camera.position.set(
        aim.x + Math.cos(elRad) * Math.sin(azRad) * distance,
        Math.max(0.15, aim.y + Math.sin(elRad) * distance),
        aim.z + Math.cos(elRad) * Math.cos(azRad) * distance,
      );
    }
    camera.lookAt(aim);
    camera.updateProjectionMatrix();

    if (engine.controls) {
      engine.controls.target.copy(aim);
      if (typeof engine.controls.update === 'function') engine.controls.update();
    }
    this._followAnchorPos = this._getCharacterAnchorWorldPos(target);
    engine.requestRender?.();

    const info = {
      distance,
      height,
      subjectH,
      cx: subjectCx,
      cy: subjectCy,
      azimuthDeg,
      elevationDeg,
      fovDeg: camera.fov || fovDeg,
      mode,
      source: orbit.source,
      bounds: bounds.source,
    };
    this._lastCameraFit = info;

    const modeLabels = {
      'video-match': 'Video Match',
      'three-quarter': '3/4 Hero',
      front: 'Front',
      side: 'Side Profile',
    };
    const modeLabel = modeLabels[mode] || mode;
    const pct = Math.round(subjectH * 100);
    setStatus(
      `🎯 ${modeLabel} · yaw ${Math.round(azimuthDeg)}° · pitch ${Math.round(elevationDeg)}° · ${distance.toFixed(2)}m (${pct}% height)`,
      '#2ecc71',
    );
    if (!options.silent) {
      this._log(
        `🎯 Camera [${modeLabel}]: ${distance.toFixed(2)} m · yaw ${Math.round(azimuthDeg)}° · pitch ${Math.round(elevationDeg)}° · FOV ${Math.round(info.fovDeg)}°`,
        '#2ecc71',
      );
    }
    return info;
  }

  async _canRunLiveAudioContext() {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return false;
    let probe = null;
    try {
      probe = new AudioCtx();
      if (probe.state === 'running') return true;
      await Promise.race([
        probe.resume().catch(() => {}),
        new Promise((resolve) => setTimeout(resolve, 60)),
      ]);
      return probe.state === 'running';
    } catch (_) {
      return false;
    } finally {
      try {
        await probe?.close?.();
      } catch (_) {}
    }
  }

  _getAudioSource(options = {}) {
    const checkbox = document.getElementById('mocap-render-audio');
    const enabled = options.includeAudio !== undefined
      ? Boolean(options.includeAudio)
      : (checkbox ? checkbox.checked : true);
    if (!enabled) return null;
    return options.audioSource || this._uploadedFile || this.videoElement?.currentSrc || this.currentVideoPath || null;
  }

  async _renderVideoDeterministicMP4(engine, clip, options = {}) {
    const renderer = engine?.renderer;
    const camera = engine?.camera;
    const canvas = renderer?.domElement;
    if (!engine?.scene || !renderer || !camera || !canvas) return false;

    const { VideoExportManager, VIDEO_BUDGET } = await import('../render/video-export.js');

    const resVal = options.res || document.getElementById('mocap-render-res')?.value || '1280x720';
    let fps = Math.max(12, Math.min(60, parseInt(options.fps || document.getElementById('mocap-render-fps')?.value || '30', 10) || 30));

    let outW = 1280;
    let outH = 720;
    if (resVal === 'viewport') {
      outW = Math.min(VIDEO_BUDGET.MAX_WIDTH, Math.max(64, canvas.clientWidth || 1280));
      outH = Math.min(VIDEO_BUDGET.MAX_HEIGHT, Math.max(64, canvas.clientHeight || 720));
    } else if (resVal === 'video') {
      const vw = this.videoElement?.videoWidth || 0;
      const vh = this.videoElement?.videoHeight || 0;
      if (vw > 0 && vh > 0) {
        const s = Math.min(1, VIDEO_BUDGET.MAX_WIDTH / vw, VIDEO_BUDGET.MAX_HEIGHT / vh);
        outW = Math.max(64, Math.round(vw * s));
        outH = Math.max(64, Math.round(vh * s));
      }
    } else if (typeof resVal === 'string' && resVal.includes('x')) {
      const [pw, ph] = resVal.split('x').map((v) => parseInt(v, 10));
      if (pw > 0 && ph > 0) {
        outW = Math.min(VIDEO_BUDGET.MAX_WIDTH, pw);
        outH = Math.min(VIDEO_BUDGET.MAX_HEIGHT, ph);
      }
    }
    // H.264 YUV420p requires even dimensions
    outW = outW & ~1;
    outH = outH & ~1;

    let totalFrames = Math.max(2, Math.round(clip.duration * fps) + 1);
    if (totalFrames > VIDEO_BUDGET.MAX_FRAMES) {
      fps = Math.max(12, Math.floor((VIDEO_BUDGET.MAX_FRAMES - 1) / Math.max(0.1, clip.duration)));
      totalFrames = Math.min(VIDEO_BUDGET.MAX_FRAMES, Math.max(2, Math.round(clip.duration * fps) + 1));
    }

    this._isRendering = true;
    this._stopSyncLoop();
    const prevPaused = !this.retargeter.isPlaying;
    this.retargeter.pause();
    const prevTime = this.retargeter.action?.time || 0;
    if (this.videoElement) this.videoElement.pause();

    const renderBtn = document.getElementById('btn-mocap-render');
    const progressEl = document.getElementById('mocap-render-progress');
    const statusEl = document.getElementById('mocap-render-status');
    const linkEl = document.getElementById('mocap-render-download');
    if (renderBtn) {
      renderBtn.disabled = true;
      renderBtn.textContent = '⏳ Rendering MP4...';
      renderBtn.style.opacity = '0.7';
    }
    if (progressEl) progressEl.style.width = '0%';
    if (linkEl) linkEl.style.display = 'none';
    if (statusEl) {
      statusEl.textContent = `Deterministic MP4 render: 0/${totalFrames} frames...`;
      statusEl.style.color = '#e67e22';
    }

    const prevPixelRatio = renderer.getPixelRatio();
    const prevW = canvas.clientWidth || Math.round(canvas.width / prevPixelRatio) || 1280;
    const prevH = canvas.clientHeight || Math.round(canvas.height / prevPixelRatio) || 720;
    const prevAspect = camera.aspect;
    const prevLeft = camera.left;
    const prevRight = camera.right;
    const prevControlsEnabled = engine.controls ? engine.controls.enabled : true;
    if (engine.controls) engine.controls.enabled = false;

    const restoreViewport = () => {
      engine._renderOverrideSize = null;
      if (engine.controls) engine.controls.enabled = prevControlsEnabled;
      renderer.setPixelRatio(prevPixelRatio);
      renderer.setSize(prevW, prevH, false);
      if (engine.rasterRenderer?.setSize) {
        engine.rasterRenderer.setSize(prevW, prevH, prevPixelRatio);
      }
      if (camera.isOrthographicCamera) {
        camera.left = prevLeft;
        camera.right = prevRight;
      } else {
        camera.aspect = prevAspect;
      }
      camera.updateProjectionMatrix();
      engine.onResize?.();
      engine.requestRender?.();
    };

    try {
      engine._renderOverrideSize = { width: outW, height: outH };
      renderer.setPixelRatio(1);
      renderer.setSize(outW, outH, false);
      if (engine.rasterRenderer?.setSize) {
        engine.rasterRenderer.setSize(outW, outH, 1);
      }
      if (camera.isOrthographicCamera) {
        const halfWidth = ((camera.top - camera.bottom) / 2) * (outW / outH);
        camera.left = -halfWidth;
        camera.right = halfWidth;
      } else {
        camera.aspect = outW / outH;
      }
      camera.updateProjectionMatrix();

      if (options.autoFrame !== false) {
        const fit = this.frameCameraToVideo({ silent: true });
        if (fit) {
          this._log(
            `🎯 Camera matched video: ${fit.distance.toFixed(2)} m · subject ${Math.round(fit.subjectH * 100)}% frame height` +
            `${fit.source === 'video' ? '' : ' (default — no 2D landmarks available)'}.`,
            '#3498db',
          );
        }
      }

      const timelineObj = this.app?.timelineEngine || window.timelineEngine;
      const retargeter = this.retargeter;
      const mocapTimeline = {
        fps,
        startFrame: 0,
        endFrame: totalFrames - 1,
        currentFrame: 0,
        isPlaying: false,
        pause() {},
        seekToFrame: (frameIdx) => {
          const t = Math.min(clip.duration, Math.max(0, frameIdx / fps));
          if (timelineObj && timelineObj._attachedClip && typeof timelineObj.seekToFrame === 'function') {
            timelineObj.seekToFrame(frameIdx, true);
          } else {
            retargeter.seek(t);
          }
        },
      };

      const exporter = new VideoExportManager({
        renderer,
        scene: engine.scene,
        camera,
        rasterRenderer: engine.rasterRenderer || null,
        timeline: mocapTimeline,
      });

      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const filename = `mocap_render_${stamp}.mp4`;
      const bitrate = Math.min(18_000_000, Math.max(3_000_000, Math.round(outW * outH * fps * 0.14)));

      this._log(`🎬 Starting deterministic H.264 MP4 render (${outW}×${outH} @ ${fps}fps, ${totalFrames} frames)...`, '#e67e22');

      const audioSource = this._getAudioSource(options);
      const result = await exporter.renderVideo({
        width: outW,
        height: outH,
        fps,
        bitrate,
        startFrame: 0,
        endFrame: totalFrames - 1,
        filename,
        postProcess: options.postProcess !== false,
        includeAudio: Boolean(audioSource),
        audioSource,
        audioStartSec: Number.isFinite(options.audioStartSec) ? options.audioStartSec : 0,
        signal: options.signal || null,
        onBeforeFrame: ({ frameIndex }) => {
          if (frameIndex === 0) this._followAnchorPos = null;
          this._updateFollowCamera();
          engine.scene.updateMatrixWorld(true);
        },
        onProgress: ({ progress, frame }) => {
          const pct = Math.min(100, progress * 100);
          if (progressEl) progressEl.style.width = `${pct.toFixed(1)}%`;
          if (statusEl) {
            statusEl.textContent = `Rendering MP4: ${frame + 1}/${totalFrames} frames (${pct.toFixed(0)}%)`;
          }
        },
      });

      if (!result || !result.blob || result.blob.size < 1024) {
        throw new Error('Produced empty MP4 output');
      }

      if (this.lastRenderResult?.url) {
        try { URL.revokeObjectURL(this.lastRenderResult.url); } catch (_) {}
      }
      const url = URL.createObjectURL(result.blob);
      this.lastRenderResult = { ...result, url };
      if (linkEl) {
        linkEl.href = url;
        linkEl.download = filename;
        linkEl.style.display = 'block';
      }
      if (options.download !== false) {
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
      }
      if (progressEl) progressEl.style.width = '100%';
      const mb = (result.blob.size / 1024 / 1024).toFixed(2);
      const audioTag = result.hasAudio ? ' + AAC Audio' : '';
      if (statusEl) {
        statusEl.textContent = `Done: ${outW}×${outH} @ ${fps}fps • MP4${audioTag} • ${mb} MB`;
        statusEl.style.color = '#6fdc96';
      }
      this._log(`✅ Deterministic MP4 complete: ${outW}×${outH} @ ${fps}fps, ${totalFrames} frames${result.hasAudio ? ' (+ AAC Audio)' : ''}, ${mb} MB (${filename}).`, '#2ecc71');
      return true;
    } catch (err) {
      if (err && err.name === 'AbortError') {
        this._log('⚠️ MP4 render cancelled.', '#e67e22');
      } else {
        this._log(`❌ Deterministic MP4 render error: ${err?.message || err}`, '#e74c3c');
      }
      return false;
    } finally {
      restoreViewport();
      this.retargeter.setLoopRepeat();
      this.retargeter.seek(prevTime);
      if (prevPaused) this.retargeter.pause();
      else this.retargeter.play();
      this._isRendering = false;
      if (renderBtn) {
        renderBtn.disabled = false;
        renderBtn.textContent = '🎬 Render Full 3D Clip';
        renderBtn.style.opacity = '1';
      }
    }
  }

  async renderVideo(options = {}) {
    if (this._isRendering) return Promise.resolve(false);

    const engine = this.app?.engine || window.engine || window.studioEngine;
    const renderer = engine?.renderer;
    const camera = engine?.camera;
    const canvas = renderer?.domElement;
    if (!engine || !renderer || !camera || !canvas) {
      this._log('❌ 3D viewport not found for rendering.', '#e74c3c');
      return Promise.resolve(false);
    }
    if (document.visibilityState === 'hidden') {
      this._log('⚠️ Studio tab is hidden so the browser will not render frames. Bring the Studio tab to the foreground and retry.', '#e67e22');
      return Promise.resolve(false);
    }
    if (typeof engine.start === 'function' && !engine.isRunning) engine.start();
    const clip = this.retargeter.currentClip;
    if (!clip || !(clip.duration > 0.05)) {
      this._log('⚠️ No motion clip available. Click "Analyze & Apply Full Video" before rendering.', '#e67e22');
      return Promise.resolve(false);
    }

    const formatSelect = document.getElementById('mocap-render-format');
    const formatVal = options.format || formatSelect?.value || 'auto';
    const hasWebCodecs = typeof VideoEncoder === 'function' && typeof VideoFrame === 'function';

    // Route Auto / MP4 through deterministic frame-by-frame WebCodecs H.264 + video_kernel.wasm pipeline
    if ((formatVal === 'auto' || formatVal === 'mp4') && hasWebCodecs && options.liveStream !== true) {
      const ok = await this._renderVideoDeterministicMP4(engine, clip, options);
      if (ok || formatVal === 'mp4') {
        return ok;
      }
      this._log('⚠️ Deterministic MP4 export unavailable — falling back to live WebM MediaRecorder.', '#e67e22');
    }

    if (typeof MediaRecorder === 'undefined' || typeof canvas.captureStream !== 'function') {
      this._log('❌ Browser does not support MediaRecorder/captureStream. Use Chrome or Edge.', '#e74c3c');
      return Promise.resolve(false);
    }

    const formatLabel = formatSelect?.selectedOptions?.[0]?.textContent || 'WebM';
    const liveAudioSource = this._getAudioSource(options);
    let preparedLiveAudio = null;
    let attachAudioTrackToMediaStreamFn = null;
    if (liveAudioSource) {
      // MediaRecorder muxing with an opus audio track stalls to 0 bytes if AudioContext stays suspended.
      const canRunLiveAudio = await this._canRunLiveAudioContext();
      if (!canRunLiveAudio) {
        this._log('ℹ️ Live WebM audio skipped (AudioContext suspended without user gesture; click viewport once or use MP4 H.264 for guaranteed AAC audio).', '#9aa5b1');
      } else {
        try {
          const audioMod = await import('../render/audio-extractor.js');
          attachAudioTrackToMediaStreamFn = audioMod.attachAudioTrackToMediaStream;
          preparedLiveAudio = await audioMod.prepareAudioTrackForExport(liveAudioSource, {
            startSec: Number.isFinite(options.audioStartSec) ? options.audioStartSec : 0,
            durationSec: clip.duration,
            skipAacProbe: true,
          });
        } catch (_) {
          preparedLiveAudio = null;
        }
      }
    }

    const mimeByFormat = {
      'webm-vp9': preparedLiveAudio
        ? ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp9', 'video/webm']
        : ['video/webm;codecs=vp9'],
      'webm-vp8': preparedLiveAudio
        ? ['video/webm;codecs=vp8,opus', 'video/webm;codecs=vp8', 'video/webm']
        : ['video/webm;codecs=vp8'],
      mp4: preparedLiveAudio
        ? ['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4;codecs=avc1.42E01E', 'video/mp4']
        : ['video/mp4;codecs=avc1.42E01E', 'video/mp4'],
      auto: preparedLiveAudio
        ? ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm', 'video/mp4']
        : ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm', 'video/mp4'],
    };
    const mimeCandidates = mimeByFormat[formatVal] || mimeByFormat.auto;
    let mimeType = '';
    if (typeof MediaRecorder.isTypeSupported === 'function') {
      mimeType = mimeCandidates.find((m) => MediaRecorder.isTypeSupported(m)) || '';
    } else {
      mimeType = mimeCandidates[0];
    }
    if (!mimeType) {
      this._log(`❌ Format "${formatLabel}" is not supported by this browser. Please select WebM (VP9/VP8).`, '#e74c3c');
      return Promise.resolve(false);
    }
    if (formatVal === 'mp4' && !(await this._probeRecorderSupport(mimeType, canvas))) {
      const opt = formatSelect?.querySelector('option[value="mp4"]');
      if (opt) {
        opt.disabled = true;
        if (!opt.textContent.includes('unavailable')) opt.textContent += ' · unavailable';
      }
      if (formatSelect) formatSelect.value = 'webm-vp9';
      const statusEl = document.getElementById('mocap-render-status');
      if (statusEl) {
        statusEl.textContent = 'MP4 unavailable in this browser. Switched to WebM VP9.';
        statusEl.style.color = '#f0a95a';
      }
      this._log('⚠️ Browser reported MP4 support but could not record data. Switched to WebM VP9 — click Render again.', '#e67e22');
      return Promise.resolve(false);
    }

    this._isRendering = true;
    this._stopSyncLoop();
    if (typeof engine.start === 'function' && !engine.isRunning) engine.start();

    const renderBtn = document.getElementById('btn-mocap-render');
    const progressEl = document.getElementById('mocap-render-progress');
    const statusEl = document.getElementById('mocap-render-status');
    const linkEl = document.getElementById('mocap-render-download');
    if (renderBtn) {
      renderBtn.disabled = true;
      renderBtn.textContent = '⏳ Rendering...';
      renderBtn.style.opacity = '0.7';
    }
    if (progressEl) progressEl.style.width = '0%';
    if (linkEl) linkEl.style.display = 'none';
    if (statusEl) {
      statusEl.textContent = 'Recording 3D frames... (keep this tab visible)';
      statusEl.style.color = '#e67e22';
    }

    if (this.videoElement) this.videoElement.pause();
    this._log(`🎬 Starting render ${clip.duration.toFixed(2)}s (${formatLabel})...`, '#e67e22');

    const resVal = document.getElementById('mocap-render-res')?.value || '1280x720';
    const fps = Math.max(12, parseInt(document.getElementById('mocap-render-fps')?.value || '30', 10) || 30);
    const prevPixelRatio = renderer.getPixelRatio();
    const prevW = canvas.clientWidth || Math.round(canvas.width / prevPixelRatio);
    const prevH = canvas.clientHeight || Math.round(canvas.height / prevPixelRatio);
    const prevAspect = camera.aspect;
    const prevLeft = camera.left;
    const prevRight = camera.right;
    const prevControlsEnabled = engine.controls.enabled;
    engine.controls.enabled = false;
    let outW = canvas.width;
    let outH = canvas.height;

    let frameW = 0;
    let frameH = 0;
    if (resVal === 'video') {
      // Giữ đúng tỉ lệ khung video gốc (video dọc quay bằng điện thoại → render dọc).
      const vw = this.videoElement?.videoWidth || 0;
      const vh = this.videoElement?.videoHeight || 0;
      if (vw > 0 && vh > 0) {
        const scale = Math.min(1, 1920 / Math.max(vw, vh));
        frameW = Math.max(2, Math.round(vw * scale));
        frameH = Math.max(2, Math.round(vh * scale));
      } else {
        this._log('⚠️ No source video for aspect ratio — using viewport resolution.', '#e67e22');
      }
    } else if (resVal !== 'viewport') {
      const parts = resVal.split('x').map((n) => parseInt(n, 10));
      frameW = parts[0];
      frameH = parts[1];
    }

    if (frameW > 0 && frameH > 0) {
      outW = frameW;
      outH = frameH;
      engine._renderOverrideSize = { width: frameW, height: frameH };
      renderer.setPixelRatio(1);
      renderer.setSize(frameW, frameH, false);
      if (engine.rasterRenderer?.setSize) {
        engine.rasterRenderer.setSize(frameW, frameH, 1);
      }
      if (camera.isOrthographicCamera) {
        const halfWidth = (camera.top - camera.bottom) / 2 * frameW / frameH;
        camera.left = -halfWidth;
        camera.right = halfWidth;
      } else {
        camera.aspect = frameW / frameH;
      }
      camera.updateProjectionMatrix();
      engine.requestRender?.();
    }

    // Canh camera theo góc nhìn + khung hình của video gốc trước khi ghi hình.
    if (options.autoFrame !== false) {
      const fit = this.frameCameraToVideo({ silent: true });
      if (fit) {
        this._log(
          `🎯 Camera matched video: ${fit.distance.toFixed(2)} m · subject ${Math.round(fit.subjectH * 100)}% frame height` +
          `${fit.source === 'video' ? '' : ' (default — no 2D landmarks available)'}.`,
          '#3498db'
        );
      }
    }

    const restoreViewport = () => {
      engine._renderOverrideSize = null;
      engine.controls.enabled = prevControlsEnabled;
      if (resVal !== 'viewport') {
        renderer.setPixelRatio(prevPixelRatio);
        renderer.setSize(prevW, prevH, false);
        if (engine.rasterRenderer?.setSize) {
          engine.rasterRenderer.setSize(prevW, prevH, prevPixelRatio);
        }
        if (camera.isOrthographicCamera) {
          camera.left = prevLeft;
          camera.right = prevRight;
        } else {
          camera.aspect = prevAspect;
        }
        camera.updateProjectionMatrix();
      }
      engine.onResize?.();
      engine.requestRender?.();
    };

    const chunks = [];
    const bitrate = Math.min(20000000, Math.max(2500000, Math.round(outW * outH * fps * 0.12)));
    let stream, recorder;
    let audioController = null;
    try {
      stream = canvas.captureStream(fps);
      const mimeSupportsAudio = !mimeType.includes('codecs=') || mimeType.includes('opus') || mimeType.includes('mp4a');
      if (preparedLiveAudio && mimeSupportsAudio && attachAudioTrackToMediaStreamFn) {
        audioController = attachAudioTrackToMediaStreamFn(preparedLiveAudio, stream, { durationSec: clip.duration });
      }
      recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: bitrate });
    } catch (e) {
      await audioController?.stop?.();
      stream?.getTracks().forEach((track) => track.stop());
      this._isRendering = false;
      restoreViewport();
      if (renderBtn) {
        renderBtn.disabled = false;
        renderBtn.textContent = '🎬 Render Full 3D Clip';
        renderBtn.style.opacity = '1';
      }
      this._log(`❌ Failed to create capture stream: ${e.message}`, '#e74c3c');
      return Promise.resolve(false);
    }

    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) chunks.push(e.data);
    };

    const durationMs = Math.max(300, Math.round(clip.duration * 1000));
    const startedAt = performance.now();
    const progressTimer = setInterval(() => {
      const pct = Math.min(100, ((performance.now() - startedAt) / durationMs) * 100);
      if (progressEl) progressEl.style.width = `${pct.toFixed(1)}%`;
    }, 100);

    return new Promise((resolve) => {
      let stopTimer = null;
      let followRafId = null;

      const finalize = (blob, error) => {
        clearInterval(progressTimer);
        if (stopTimer) clearTimeout(stopTimer);
        if (followRafId) cancelAnimationFrame(followRafId);
        restoreViewport();
        this.retargeter.setLoopRepeat();
        this.retargeter.seek(0);
        this.retargeter.pause();
        this._isRendering = false;
        audioController?.stop?.();
        try { stream.getTracks().forEach((t) => t.stop()); } catch (_) { /* ignore */ }

        if (renderBtn) {
          renderBtn.disabled = false;
          renderBtn.textContent = '🎬 Render Full 3D Clip';
          renderBtn.style.opacity = '1';
        }

        const actualType = recorder.mimeType || mimeType || '';
        const mp4Requested = formatVal === 'mp4' || actualType.includes('mp4');
        const minPlausibleBytes = Math.max(8192, Math.round(clip.duration * 1500));
        if (error || !blob || blob.size < minPlausibleBytes) {
          if (progressEl) progressEl.style.width = '0%';
          if (mp4Requested) {
            const opt = formatSelect?.querySelector('option[value="mp4"]');
            if (opt) {
              opt.disabled = true;
              if (!opt.textContent.includes('unavailable')) opt.textContent += ' · unavailable';
            }
            if (formatSelect) formatSelect.value = 'webm-vp9';
            if (statusEl) {
              statusEl.textContent = 'MP4 unavailable in this browser. Switched to WebM VP9 — click Render again.';
              statusEl.style.color = '#f0a95a';
            }
            this._log('⚠️ MP4 produced an empty/invalid file in this browser. Switched to WebM VP9 — click Render again.', '#e67e22');
          } else {
            if (statusEl) {
              statusEl.textContent = `${formatLabel} render failed. Retry or choose WebM VP9.`;
              statusEl.style.color = '#e74c3c';
            }
            this._log(`❌ Video render failed${error ? `: ${error.message || error}` : ''}.`, '#e74c3c');
          }
          resolve(false);
          return;
        }

        const ext = (recorder.mimeType || mimeType).includes('mp4') ? 'mp4' : 'webm';
        const hasLiveAudio = Boolean(audioController);
        if (this.lastRenderResult?.url) {
          try { URL.revokeObjectURL(this.lastRenderResult.url); } catch (_) {}
        }
        const url = URL.createObjectURL(blob);
        const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const fileName = `mocap_render_${stamp}.${ext}`;
        this.lastRenderResult = { blob, filename: fileName, duration: clip.duration, width: outW, height: outH, fps, hasAudio: hasLiveAudio, url };

        if (linkEl) {
          linkEl.href = url;
          linkEl.download = fileName;
          linkEl.style.display = 'block';
        }

        if (options.download !== false) {
          const a = document.createElement('a');
          a.href = url;
          a.download = fileName;
          document.body.appendChild(a);
          a.click();
          a.remove();
        }

        if (progressEl) progressEl.style.width = '100%';
        const audioTag = hasLiveAudio ? ' + Audio' : '';
        if (statusEl) {
          statusEl.textContent = `Done: ${outW}×${outH} @ ${fps}fps • ${ext.toUpperCase()}${audioTag} • ${(blob.size / 1024 / 1024).toFixed(2)} MB`;
          statusEl.style.color = '#6fdc96';
        }
        this._log(`✅ Rendered 3D video: ${outW}×${outH} @ ${fps}fps, ${clip.duration.toFixed(2)}s${hasLiveAudio ? ' (+ Audio)' : ''}, ${(blob.size / 1024 / 1024).toFixed(2)} MB (${fileName}).`, '#2ecc71');
        resolve(true);
      };

      recorder.onstop = () => {
        const type = recorder.mimeType || mimeType || 'video/webm';
        finalize(new Blob(chunks, { type }), null);
      };
      recorder.onerror = (event) => finalize(null, event.error || new Error('MediaRecorder error'));

      this.retargeter.playOnceFromStart();
      audioController?.start?.();
      const tickRenderFollow = () => {
        if (!this._isRendering) return;
        this._updateFollowCamera();
        followRafId = requestAnimationFrame(tickRenderFollow);
      };
      followRafId = requestAnimationFrame(tickRenderFollow);

      try {
        recorder.start(200);
      } catch (e) {
        finalize(null, e);
        return;
      }

      stopTimer = setTimeout(() => {
        try {
          if (recorder.state !== 'inactive') recorder.stop();
        } catch (_) { /* ignore */ }
      }, durationMs + 250);
    });
  }

  // ---------------------------------------------------------------- //
  // Character & Upload Management
  // ---------------------------------------------------------------- //

  refreshTargetList() {
    const sm = this.app?.sceneManager || window.sceneManager;
    const select = document.getElementById('mocap-target-character');
    if (!select || !sm) return;

    const prevSelected = select.value;
    select.innerHTML = '';
    const objects = sm.getAllObjects();
    let riggedCount = 0;
    let unriggedCount = 0;

    for (const obj of objects) {
      let boneCount = 0;
      obj.traverse((child) => {
        if (child.isBone) boneCount++;
      });

      if (boneCount > 0) {
        riggedCount++;
        const opt = document.createElement('option');
        opt.value = obj.id;
        opt.textContent = `${obj.name} (${boneCount} bones)`;
        if (String(obj.id) === String(prevSelected)) opt.selected = true;
        select.appendChild(opt);
      }
    }

    for (const obj of objects) {
      let boneCount = 0;
      obj.traverse((child) => { if (child.isBone) boneCount++; });
      if (boneCount === 0 && obj.userData?.isCustomMocapUpload && this._isCharacterMeshCandidate(obj)) {
        unriggedCount++;
        const opt = document.createElement('option');
        opt.value = obj.id;
        opt.textContent = `${obj.name} (${t('mocap.unriggedTag', 'Unrigged - Auto-Rig')})`;
        if (String(obj.id) === String(prevSelected)) opt.selected = true;
        select.appendChild(opt);
      }
    }

    if (riggedCount === 0 && unriggedCount === 0) {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = t('mocap.autoLoadPlaceholder', '(Auto-load Studio Athlete CC0 when clicking Analyze & Apply)');
      select.appendChild(opt);
      this._restoreAutoHiddenDefaultCube();
    }

    this._updateRigDiagnostics(this._resolveTargetCharacter({ includeUnrigged: true }));
  }

  _refreshRigTemplateLabels() {
    const sel = document.getElementById('mocap-rig-template');
    if (!sel) return;
    const isVi = (document.documentElement?.lang || 'en') === 'vi';
    const cur = sel.value;
    const templates = listSkeletonTemplates();
    sel.innerHTML = templates
      .map((tpl) => `<option value="${tpl.id}">${isVi ? tpl.nameVi : tpl.name}</option>`)
      .join('');
    if (cur) sel.value = cur;
  }

  _updateRigDiagnostics(character) {
    const stdEl = document.getElementById('mocap-rig-standard');
    const badgeEl = document.getElementById('mocap-rig-badge');
    const sumEl = document.getElementById('mocap-rig-summary');
    const autoRigBtn = document.getElementById('btn-mocap-autorig');
    if (!stdEl || !badgeEl || !sumEl) return;

    if (!character) {
      stdEl.textContent = t('mocap.rigNoChar', 'No character selected');
      badgeEl.textContent = '--';
      badgeEl.className = 'mp-rig-badge mp-rig-badge--muted';
      sumEl.textContent = t('mocap.rigEmptyHint', 'Upload a custom .glb/.vrm/.fbx/.obj character or load a CC0 starter rig.');
      autoRigBtn?.classList.remove('is-highlighted');
      return;
    }

    const diag = this.retargeter.diagnoseRig(character);
    stdEl.textContent = `${character.name || 'Character'} · ${diag.standard}`;

    if (diag.needsAutoRig) {
      badgeEl.textContent = diag.hasSkeleton ? `${diag.score}/100` : t('mocap.rigUnrigged', 'Unrigged');
      badgeEl.className = 'mp-rig-badge mp-rig-badge--warn';
      sumEl.textContent = diag.hasSkeleton
        ? `${t('mocap.rigIncomplete', 'Missing key humanoid joints')} (${diag.criticalMatched}/${diag.criticalTotal}) — ${t('mocap.rigClickAutoRig', 'click Auto-Rig to bind a pro skeleton.')}`
        : t('mocap.rigStaticHint', 'Static 3D mesh detected. Click Auto-Rig to automatically fit a 56-bone humanoid skeleton.');
      autoRigBtn?.classList.add('is-highlighted');
      return;
    }

    autoRigBtn?.classList.remove('is-highlighted');
    badgeEl.textContent = `${diag.grade} ${diag.score}/100`;
    badgeEl.className = diag.score >= 90
      ? 'mp-rig-badge mp-rig-badge--pro'
      : (diag.score >= 75 ? 'mp-rig-badge mp-rig-badge--good' : 'mp-rig-badge mp-rig-badge--warn');

    const parts = [
      diag.restPose,
      `${diag.mappedCore}/${diag.maxCore} core`,
      `${diag.fingerBones} fingers`,
      `${diag.twistBones} twist`,
    ];
    if (diag.faceMorphs > 0) parts.push(`${diag.faceMorphs} face`);
    sumEl.textContent = parts.join(' · ');
  }

  _normalizeUploadedCharacter(root) {
    if (!root) return root;
    root.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(root);
    if (box.isEmpty()) return root;

    const size = box.getSize(new THREE.Vector3());
    const height = Math.max(1e-4, size.y);

    // Normalize extreme cm/mm/tiny DCC export scales cleanly into human studio scale (~1.72m)
    if (height > 8.0 || height < 0.25) {
      const targetScale = 1.72 / height;
      root.scale.multiplyScalar(targetScale);
      root.updateMatrixWorld(true);
      box.setFromObject(root);
    }

    // Center X/Z around origin and ground lowest foot/sole cleanly onto Y = 0
    const center = box.getCenter(new THREE.Vector3());
    root.position.x -= center.x;
    root.position.z -= center.z;
    root.position.y -= box.min.y;
    root.updateMatrixWorld(true);
    return root;
  }

  async _handleCharacterUpload(event) {
    const file = event?.target?.files?.[0];
    if (event?.target) event.target.value = '';
    if (!file) return;
    await this.uploadCharacterFile(file);
  }

  async uploadCharacterFile(file) {
    if (!file) return null;
    const ext = String(file.name || '').split('.').pop().toLowerCase();
    const supported = new Set(['glb', 'gltf', 'vrm', 'fbx', 'obj', 'zip']);
    if (!supported.has(ext)) {
      this._log(`Unsupported 3D character format ".${ext}". Use .glb, .gltf, .vrm, .fbx, .obj, or .zip.`, '#e74c3c');
      return null;
    }

    const sm = this.app?.sceneManager || window.sceneManager;
    const exporter = this.app?.exporter || window.exporter;
    const cleanName = String(file.name || 'CustomCharacter').replace(/\.[^.]+$/, '').replace(/[^\w.-]+/g, '_') || 'CustomCharacter';

    this._log(`Importing custom 3D character: ${file.name} (${(file.size / 1024 / 1024).toFixed(2)} MB)...`, '#3498db');

    try {
      let imported = null;
      if (exporter && typeof exporter.importUniversal === 'function') {
        const res = await exporter.importUniversal(file, { select: false });
        imported = res?.object || res?.scene || res || null;
      } else if (ext === 'glb' || ext === 'gltf' || ext === 'vrm') {
        const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
        const blobUrl = URL.createObjectURL(file);
        try {
          const gltf = await new GLTFLoader().loadAsync(blobUrl);
          imported = gltf.scene || gltf.scenes?.[0] || null;
          if (imported && sm) sm.addObject(imported);
        } finally {
          URL.revokeObjectURL(blobUrl);
        }
      } else {
        throw new Error('Studio model importer is not initialized.');
      }

      if (!imported || !imported.isObject3D) {
        throw new Error('No 3D mesh or skeleton found inside uploaded file.');
      }

      imported.name = cleanName;
      imported.userData = imported.userData || {};
      imported.userData.isCustomMocapUpload = true;

      this._normalizeUploadedCharacter(imported);
      MocapRetargeter.captureBindPose(imported);
      this._hideUntouchedDefaultCube();

      if (sm) {
        if (!imported.parent) sm.addObject(imported);
        sm.setSelection?.([imported]);
      }

      this.refreshTargetList();
      const select = document.getElementById('mocap-target-character');
      if (select) select.value = String(imported.id);

      const diag = this.retargeter.diagnoseRig(imported);
      this._updateRigDiagnostics(imported);

      const autoCam = document.getElementById('mocap-auto-camera')?.checked !== false;
      if (autoCam) {
        this.frameCameraToVideo({
          target: imported,
          mode: this.mocapData ? undefined : 'three-quarter',
          auto: true,
          silent: true,
        });
      }

      telemetry.track('custom_character_uploaded', {
        ext,
        standard: diag.standard,
        score: diag.score,
        hasSkeleton: diag.hasSkeleton,
      });

      if (diag.needsAutoRig) {
        this._log(
          `Loaded "${cleanName}" (${diag.standard}). Click "Auto-Rig" to automatically fit a 56-bone humanoid skeleton for Mocap.`,
          '#f39c12'
        );
      } else {
        this._log(
          `Loaded custom character "${cleanName}" — ${diag.standard} (${diag.grade} ${diag.score}/100 · ${diag.restPose} · ${diag.mappedCore}/22 core, ${diag.fingerBones} fingers).`,
          '#2ecc71'
        );
        if (this.mocapData) {
          await this.applyRetargeting();
        }
      }
      return imported;
    } catch (err) {
      this._log(`Failed to import character "${file.name}": ${err?.message || err}`, '#e74c3c');
      return null;
    }
  }

  async autoRigSelectedCharacter() {
    const rigSystem = this.app?.rigSystem || window.rigSystem;
    const sm = this.app?.sceneManager || window.sceneManager;
    if (!rigSystem || typeof rigSystem.autoRigCharacter !== 'function') {
      this._log('Rigging engine is not ready.', '#e74c3c');
      return null;
    }

    const target = this._resolveTargetCharacter({ includeUnrigged: true }) || sm?.getActiveObject?.();
    if (!target || !this._isCharacterMeshCandidate(target)) {
      this._log('Select or upload a 3D mesh character before clicking Auto-Rig.', '#e67e22');
      return null;
    }

    const tplSelect = document.getElementById('mocap-rig-template');
    const selectedTpl = tplSelect?.value || 'humanoid_pro';
    const templateId = (selectedTpl === 'humanoid_standard' || selectedTpl === 'humanoid_pro')
      ? selectedTpl
      : 'humanoid_pro';

    this._log(`Auto-Rigging "${target.name}" with ${templateId} (silhouette joint fitting + Bone Heat weights)...`, '#3498db');

    try {
      const res = rigSystem.autoRigCharacter(target, {
        templateId,
        mode: 'heat',
        reRig: false,
      });
      if (!res?.character) {
        this._log(`Could not auto-rig "${target.name}" (ensure mesh has static geometry).`, '#e67e22');
        return null;
      }

      const riggedChar = res.character;
      riggedChar.userData = riggedChar.userData || {};
      riggedChar.userData.isCustomMocapUpload = true;
      riggedChar.updateMatrixWorld(true);
      MocapRetargeter.captureBindPose(riggedChar);

      sm?.setSelection?.([riggedChar]);
      this.refreshTargetList();
      const select = document.getElementById('mocap-target-character');
      if (select) select.value = String(riggedChar.id);
      this._updateRigDiagnostics(riggedChar);

      const poseLabel = res.silhouette?.detectedPose || 'Standard';
      const q = res.quality || {};
      this._log(
        `Auto-Rig complete for "${riggedChar.name}": ${q.boneCount || 56} bones (${poseLabel}), ${q.totalVertices || 0} verts, valid=${q.valid !== false}.`,
        '#2ecc71'
      );

      if (this.mocapData) {
        await this.applyRetargeting();
      }
      return res;
    } catch (err) {
      this._log(`Auto-Rig failed: ${err?.message || err}`, '#e74c3c');
      return null;
    }
  }

  spawnSelectedRigTemplate() {
    const rigSystem = this.app?.rigSystem || window.rigSystem;
    const sm = this.app?.sceneManager || window.sceneManager;
    const engine = this.app?.engine || window.studioEngine || window.engine;
    if (!rigSystem || typeof rigSystem.createSkeletonFromTemplate !== 'function') {
      this._log('Rigging engine is not ready.', '#e74c3c');
      return null;
    }
    const tplId = document.getElementById('mocap-rig-template')?.value || 'humanoid_pro';
    const res = rigSystem.createSkeletonFromTemplate(tplId, { addToScene: true });
    if (res?.armatureGroup) {
      this._hideUntouchedDefaultCube();
      sm?.setSelection?.([res.armatureGroup]);
      engine?.focusOn?.(res.armatureGroup);
      this.refreshTargetList();
      this._log(`Spawned skeleton template "${res.template?.name || tplId}" (${res.bones?.length || 0} bones).`, '#2ecc71');
    }
    return res;
  }

  _loadPresetCharacter(url, defaultName, { autoApply = true } = {}) {
    this._log(`Loading 3D rigged character: ${defaultName} (${url})...`, '#3498db');
    const sm = this.app?.sceneManager || window.sceneManager;
    const engine = this.app?.engine || window.studioEngine;

    return new Promise(async (resolve, reject) => {
      try {
        const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
        const loader = new GLTFLoader();
        const resolvedUrl = resolveCdnAssetUrl(url);
        loader.load(resolvedUrl, async (gltf) => {
          const root = gltf.scene;
          root.name = defaultName;
          root.position.set(0, 0, 0);
          root.scale.set(1, 1, 1);

          // Soldier_Human_Rigged.glb has its internal bind pose facing -Z (away from camera).
          // Rotate root by 180° around Y so Soldier faces the camera (+Z) like Michelle.
          if (/soldier/i.test(defaultName) || /soldier/i.test(url)) {
            root.rotation.set(0, Math.PI, 0);
          }
          root.updateMatrixWorld(true);
          MocapRetargeter.captureBindPose(root);

          this._hideUntouchedDefaultCube();
          if (sm) {
            sm.addObject(root);
            sm.setSelection([root]);
          }
          this.refreshTargetList();
          const select = document.getElementById('mocap-target-character');
          if (select) select.value = String(root.id);
          this._updateRigDiagnostics(root);

          // Auto-frame camera cleanly onto loaded character
          const autoCam = document.getElementById('mocap-auto-camera')?.checked !== false;
          if (autoCam) {
            this.frameCameraToVideo({
              target: root,
              mode: this.mocapData ? undefined : 'three-quarter',
              auto: true,
              silent: true,
            });
          } else if (engine && engine.camera) {
            engine.camera.position.set(0, 1.05, 2.5);
            engine.camera.lookAt(0, 0.9, 0);
            if (engine.controls) {
              engine.controls.target.set(0, 0.9, 0);
              engine.controls.update();
            }
          }

          this._log(`✅ Successfully loaded ${defaultName} into 3D scene!`, '#2ecc71');
          if (autoApply && this.mocapData) {
            await this.applyRetargeting();
          }
          resolve(root);
        }, undefined, (err) => {
          this._log(`❌ Error loading model ${defaultName}: ${err}`, '#e74c3c');
          reject(err);
        });
      } catch (e) {
        this._log(`❌ Error initializing GLTFLoader: ${e}`, '#e74c3c');
        reject(e);
      }
    });
  }

  async _handleFileUpload(event) {
    const file = event.target.files?.[0];
    if (event.target) event.target.value = '';
    if (!file) return;

    // Client-side WASM mode processes local files straight from memory / Blob URL (zero server upload)
    if (this._engineMode() === 'browser') {
      const blobUrl = URL.createObjectURL(file);
      const presetSelect = document.getElementById('mocap-video-preset');
      if (presetSelect) {
        let localOpt = presetSelect.querySelector('option[data-local-upload="1"]');
        if (!localOpt) {
          localOpt = document.createElement('option');
          localOpt.dataset.localUpload = '1';
          presetSelect.appendChild(localOpt);
        }
        localOpt.value = blobUrl;
        localOpt.textContent = `Local: ${file.name}`;
        presetSelect.value = blobUrl;
      }
      this.loadVideo(blobUrl, { file, isObjectUrl: true });
      this._log(`✅ Loaded local video (offline zero-upload): ${file.name} (${(file.size / 1024 / 1024).toFixed(2)} MB).`, '#2ecc71');
      return;
    }

    this._log(`Uploading custom video: ${file.name} (${(file.size / 1024 / 1024).toFixed(2)} MB)...`, '#3498db');

    const reader = new FileReader();
    reader.onload = async (e) => {
      try {
        const base64Data = e.target.result;
        const resp = await fetch('/api/mocap/upload', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            fileName: file.name,
            fileData: base64Data
          })
        });

        const data = await resp.json();
        if (resp.ok && data.success) {
          this._log(`✅ Video uploaded: ${data.videoPath}. Click "Analyze & Apply Full Video" to begin!`, '#2ecc71');
          await this._loadAvailableSamples();
          const presetSelect = document.getElementById('mocap-video-preset');
          if (presetSelect) presetSelect.value = data.videoPath;
          this.loadVideo(data.videoPath, { file });
        } else {
          throw new Error(data.error || 'Upload error');
        }
      } catch (err) {
        this._log(`❌ Video upload error: ${err.message}`, '#e74c3c');
      }
    };
    reader.readAsDataURL(file);
  }
}
