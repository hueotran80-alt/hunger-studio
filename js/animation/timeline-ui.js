/**
 * Web Blender Studio - Interactive Timeline UI & Dope Sheet
 * Mounts to '#dock-timeline' and coordinates with TimelineEngine:
 * - Frame ruler (0 -> 250) with major/minor tick marks.
 * - Draggable red playhead needle & scrub handle for real-time scrubbing.
 * - Yellow diamond keyframe markers (◆) on tracks (Summary, Location, Rotation, Scale).
 * - Full transport controls: Play/Pause, Stop/Rewind, Next/Prev Keyframe, Step forward/back.
 * - Action buttons: 'Insert Keyframe (I)', 'Delete Keyframe', 'Auto-Keyframe (Record ⏺)', 'Turntable Camera 360', 'Loop 🔁'.
 * - FPS selector (24, 30, 60 fps) and Interpolation selector (Catmull-Rom, Linear, EaseInOut).
 * - Blender hotkey 'I' popup menu for Location, Rotation, Scale, LocRotScale.
 */
import { isTextEntryTarget, shouldBlockViewportShortcut } from '../core/interaction-guard.js';
import { escapeHtml } from '../core/escape-html.js';

export class TimelineUI {
  /**
   * @param {HTMLElement|string} container Mount element or selector
   * @param {TimelineEngine} engine TimelineEngine instance
   * @param {SceneManager} sceneManager SceneManager instance
   */
  constructor(container, engine, sceneManager) {
    this.container = typeof container === 'string' ? document.querySelector(container) : container;
    this.engine = engine;
    this.sceneManager = sceneManager;

    // Scrubbing drag state
    this.isScrubbing = false;
    this.trackScrollLeft = 0;
    this.pixelsPerFrame = 8; // Width in pixels of 1 frame on ruler

    // Active keyframe selection
    this.selectedKeyframe = null; // { object, frame }
    this.viewMode = 'dopesheet'; // 'dopesheet' | 'action' | 'nla' | 'drivers'
    this.selectedNLAStrip = null; // { objectUuid, trackId, stripId }

    // DOM Elements cache
    this.elements = {};

    this.init();
  }

  init() {
    if (!this.container) {
      console.warn('[TimelineUI] Container not found.');
      return;
    }

    this._renderHTML();
    this._bindEvents();
    this._bindHeaderSync();
    this._bindKeyboardShortcuts();
    this._updateTrackView();
    this._updatePlayheadPosition();

    // Listen to engine events
    this.engine.on('frameChanged', ({ frame, isPlaying }) => {
      this._updatePlayheadPosition();
      this._syncFrameDisplay(frame);
      if (this.viewMode === 'drivers') {
        this._refreshDriverReadouts();
      }
    });

    this.engine.on('playStateChanged', ({ isPlaying }) => {
      this._updatePlayButtons(isPlaying);
    });

    this.engine.on('tracksChanged', () => {
      this._syncActionBar();
      this._updateTrackView();
    });

    this.engine.on('actionsChanged', () => {
      this._syncActionBar();
      this._updateTrackView();
    });

    this.engine.on('nlaChanged', () => {
      this._syncNLASelectedStripBar();
      this._updateTrackView();
    });

    this.engine.on('driversChanged', () => {
      if (this.viewMode === 'drivers') this._renderDriversPanel();
    });

    this.engine.on('turntableToggled', ({ active }) => {
      if (this.elements.btnTurntable) {
        this.elements.btnTurntable.classList.toggle('active', active);
      }
    });

    this.engine.on('autoKeyframeToggled', ({ active }) => {
      if (this.elements.btnRecord) {
        this.elements.btnRecord.classList.toggle('active', active);
      }
    });

    this.engine.on('loopToggled', ({ loop }) => {
      if (this.elements.btnLoop) {
        this.elements.btnLoop.classList.toggle('active', loop);
      }
    });

    // Listen to SceneManager selection
    if (this.sceneManager) {
      this.sceneManager.on('selectionChanged', () => {
        this._updateTrackView();
      });
    }

    // Listen to Pose Mode and Bone Selection events
    window.addEventListener('blender:bone-selected', () => {
      this._updateTrackView();
    });
    window.addEventListener('blender:pose-changed', () => {
      this._updateTrackView();
    });
    window.addEventListener('blender:mode-changed', () => {
      this._updateTrackView();
    });

    // Handle container resize
    window.addEventListener('resize', () => {
      this._drawRuler();
      this._updatePlayheadPosition();
    });
  }

  // =========================================================================
  // HTML TEMPLATE CREATION
  // =========================================================================

  _renderHTML() {
    this.container.innerHTML = `
      <div class="blender-timeline-root">
        <!-- Sub-Toolbar Controls -->
        <div class="timeline-toolbar">
          <!-- Left: Transport Controls -->
          <div class="tl-toolbar-group tl-transport-group">
            <button class="tl-btn" id="tl-btn-first" title="First Frame (Shift+Left)">
              <svg viewBox="0 0 24 24"><path d="M6 6h2v12H6zm3.5 6l8.5 6V6z"/></svg>
            </button>
            <button class="tl-btn" id="tl-btn-prev-kf" title="Previous Keyframe (Down Arrow)">
              <svg viewBox="0 0 24 24"><path d="M11 18V6l-8.5 6 8.5 6zm.5-6l8.5 6V6l-8.5 6z"/></svg>
            </button>
            <button class="tl-btn" id="tl-btn-prev-frame" title="Step Back 1 Frame (Left Arrow)">
              <svg viewBox="0 0 24 24"><path d="M15.41 16.59L10.83 12l4.58-4.59L14 6l-6 6 6 6 1.41-1.41z"/></svg>
            </button>
            <button class="tl-btn tl-btn-play" id="tl-btn-play" title="Play/Pause (Space)">
              <svg class="icon-play" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
              <svg class="icon-pause" viewBox="0 0 24 24" style="display:none;"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>
            </button>
            <button class="tl-btn" id="tl-btn-next-frame" title="Step Forward 1 Frame (Right Arrow)">
              <svg viewBox="0 0 24 24"><path d="M8.59 16.59L13.17 12 8.59 7.41 10 6l6 6-6 6-1.41-1.41z"/></svg>
            </button>
            <button class="tl-btn" id="tl-btn-next-kf" title="Next Keyframe (Up Arrow)">
              <svg viewBox="0 0 24 24"><path d="M4 18l8.5-6L4 6v12zm9-12v12l8.5-6L13 6z"/></svg>
            </button>
            <button class="tl-btn" id="tl-btn-last" title="Last Frame (Shift+Right)">
              <svg viewBox="0 0 24 24"><path d="M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z"/></svg>
            </button>
          </div>

          <div class="tl-divider"></div>

          <!-- Middle: Keyframe Actions -->
          <div class="tl-toolbar-group tl-action-group">
            <button class="tl-btn tl-btn-accent" id="tl-btn-insert-kf" title="Insert Keyframe on Active Object (I)">
              <svg viewBox="0 0 24 24"><path d="M12 2l7 7-7 7-7-7 7-7zm0 4.83L8.83 10 12 13.17 15.17 10 12 6.83zM11 9h2v2h-2zm0-4h2v2h-2z"/></svg>
              <span>Keyframe (I)</span>
            </button>
            <button class="tl-btn" id="tl-btn-delete-kf" title="Delete Keyframe at Current Frame (Alt+I / X)">
              <svg viewBox="0 0 24 24"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
              <span>Delete</span>
            </button>
            <button class="tl-btn tl-btn-record" id="tl-btn-record" title="Auto-Keyframe (Record Mode)">
              <div class="record-dot"></div>
              <span>Auto-Key</span>
            </button>
            <button class="tl-btn tl-btn-turntable" id="tl-btn-turntable" title="Turntable Camera 360 Showcase">
              <svg viewBox="0 0 24 24"><path d="M12 2a10 10 0 1010 10A10 10 0 0012 2zm1 14.93V18h-2v-1.07A8.001 8.001 0 014.07 9H3V7h1.07A8.001 8.001 0 0111 2.07V1h2v1.07A8.001 8.001 0 0119.93 7H21v2h-1.07A8.001 8.001 0 0113 16.93zM12 6a6 6 0 106 6 6.006 6.006 0 00-6-6zm0 4a2 2 0 102 2 2 2 0 00-2-2z"/></svg>
              <span>Turntable 360</span>
            </button>
            <button class="tl-btn ${this.engine.loop ? 'active' : ''}" id="tl-btn-loop" title="Toggle Loop (🔁)">
              <svg viewBox="0 0 24 24"><path d="M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4z"/></svg>
            </button>
            <button class="tl-btn tl-btn-accent" id="tl-btn-render-video" title="Render Animation Video (Ctrl+F12 · EEVEE & Rust Cycles)">
              <svg viewBox="0 0 24 24"><path d="M18 4l2 4h-3l-2-4h-2l2 4h-3l-2-4H8l2 4H7L5 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V4h-4z"/></svg>
              <span>Render</span>
            </button>
          </div>

          <div class="tl-divider"></div>

          <!-- Right: Frame Counter, Range, FPS, Interpolation & Skeletal Presets -->
          <div class="tl-toolbar-group tl-settings-group">
            <div class="tl-field-pill">
              <span class="tl-field-label">Frame:</span>
              <input type="number" id="tl-input-current-frame" class="tl-input-number" min="0" max="10000" value="${this.engine.currentFrame}">
            </div>

            <div class="tl-field-pill">
              <span class="tl-field-label">Start:</span>
              <input type="number" id="tl-input-start-frame" class="tl-input-number" min="0" max="10000" value="${this.engine.startFrame}">
              <span class="tl-field-label">End:</span>
              <input type="number" id="tl-input-end-frame" class="tl-input-number" min="1" max="10000" value="${this.engine.endFrame}">
            </div>

            <div class="tl-field-pill">
              <span class="tl-field-label">FPS:</span>
              <select id="tl-select-fps" class="tl-select">
                <option value="24" ${this.engine.fps === 24 ? 'selected' : ''}>24 FPS</option>
                <option value="30" ${this.engine.fps === 30 ? 'selected' : ''}>30 FPS</option>
                <option value="60" ${this.engine.fps === 60 ? 'selected' : ''}>60 FPS</option>
              </select>
            </div>

            <div class="tl-field-pill">
              <span class="tl-field-label">Interp:</span>
              <select id="tl-select-interp" class="tl-select" title="Default Keyframe Interpolation Mode">
                <option value="bezier" ${this.engine.defaultInterpolation === 'bezier' ? 'selected' : ''}>Bezier</option>
                <option value="smooth" ${this.engine.defaultInterpolation === 'smooth' ? 'selected' : ''}>Auto Bezier</option>
                <option value="linear" ${this.engine.defaultInterpolation === 'linear' ? 'selected' : ''}>Linear</option>
                <option value="easeInOut" ${this.engine.defaultInterpolation === 'easeInOut' ? 'selected' : ''}>Ease In-Out</option>
                <option value="constant" ${this.engine.defaultInterpolation === 'constant' ? 'selected' : ''}>Constant</option>
              </select>
            </div>

            <div class="tl-view-tabs" id="tl-view-mode-tabs" role="tablist" aria-label="Animation Editor Mode">
              <button type="button" class="tl-mode-btn active" data-tl-mode="dopesheet">Dope Sheet</button>
              <button type="button" class="tl-mode-btn" data-tl-mode="action">Action</button>
              <button type="button" class="tl-mode-btn" data-tl-mode="nla">NLA</button>
              <button type="button" class="tl-mode-btn" data-tl-mode="drivers">Drivers</button>
            </div>

            <div class="tl-field-pill tl-pill-preset">
              <span class="tl-field-label">🦴 Preset:</span>
              <select id="tl-select-motion-preset" class="tl-select" style="background:#2d3436; color:#ffeaa7; font-weight:600;" title="Skeletal Motion Presets">
                <option value="">-- Motion Presets --</option>
                <option value="walk_cycle">🚶 Walk Cycle (24f)</option>
                <option value="combat_slash">⚔️ Combat Slash/Punch (30f)</option>
                <option value="wave_hand">👋 Wave Hand (16f)</option>
              </select>
            </div>
          </div>
        </div>

        <!-- Action Editor Sub-Bar (shown in Action / NLA mode) -->
        <div class="tl-subbar" id="tl-action-bar" style="display:none;">
          <span class="tl-subbar-label">Action:</span>
          <select id="tl-action-select" class="tl-select tl-action-select"></select>
          <button type="button" class="tl-btn" id="tl-btn-action-new" title="Create New Action">+ New</button>
          <button type="button" class="tl-btn" id="tl-btn-action-dup" title="Duplicate Current Action">Dup</button>
          <button type="button" class="tl-btn" id="tl-btn-action-fake" title="Toggle Fake User (F)">F</button>
          <button type="button" class="tl-btn tl-btn-accent" id="tl-btn-action-push" title="Push Active Action Down as NLA Strip">⬇ Push Down to NLA</button>
          <span class="tl-subbar-sep"></span>
          <button type="button" class="tl-btn" id="tl-btn-nla-add-track" style="display:none;" title="Add New NLA Track">+ NLA Track</button>
        </div>

        <!-- Main Timeline Body (Split: Track Headers <-> Dope Sheet / NLA Canvas) -->
        <div class="timeline-body-split" id="tl-body-split">
          <!-- Left: Track Channels Header -->
          <div class="timeline-channels-col">
            <div class="tl-ch-header">
              <span class="tl-ch-title" id="tl-ch-panel-title">Animation Channels</span>
            </div>
            <div class="tl-ch-rows" id="tl-channel-rows">
              <!-- Dynamically populated -->
            </div>
          </div>

          <!-- Right: Interactive Canvas Ruler & Tracks -->
          <div class="timeline-tracks-col" id="tl-tracks-scroll-container">
            <div class="timeline-tracks-content" id="tl-tracks-content">
              <!-- Ruler Canvas -->
              <div class="timeline-ruler-wrapper" id="tl-ruler-wrapper">
                <canvas id="tl-ruler-canvas" class="tl-ruler-canvas"></canvas>
              </div>

              <!-- Dope Sheet / NLA Lanes -->
              <div class="timeline-lanes-container" id="tl-lanes-container">
                <!-- Dynamically populated lanes and diamonds / NLA strips -->
              </div>

              <!-- Draggable Red Playhead Needle -->
              <div class="timeline-playhead-line" id="tl-playhead">
                <div class="timeline-playhead-handle" id="tl-playhead-handle">
                  <span id="tl-playhead-badge">0</span>
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- Selected NLA Strip Properties Bar -->
        <div class="tl-subbar tl-nla-strip-bar" id="tl-nla-strip-bar" style="display:none;"></div>

        <!-- Drivers View Panel -->
        <div class="tl-drivers-panel" id="tl-drivers-panel" style="display:none;"></div>

        <!-- Keyframe 'I' Popup Modal Menu (Hidden by default) -->
        <div class="blender-kf-modal" id="tl-kf-modal" style="display:none;" role="dialog" aria-label="Insert Keyframe">
          <div class="tl-kf-modal-title">Insert Keyframe</div>
          <div class="tl-kf-modal-item" data-channels="location">
            <span>Location</span>
            <span class="shortcut">1</span>
          </div>
          <div class="tl-kf-modal-item" data-channels="rotation">
            <span>Rotation</span>
            <span class="shortcut">2</span>
          </div>
          <div class="tl-kf-modal-item" data-channels="scale">
            <span>Scale</span>
            <span class="shortcut">3</span>
          </div>
          <div class="tl-kf-modal-divider"></div>
          <div class="tl-kf-modal-item active" data-channels="all">
            <span>LocRotScale (All)</span>
            <span class="shortcut">4 / Enter</span>
          </div>
          <div class="tl-kf-modal-divider"></div>
          <div class="tl-kf-modal-item" data-channels="active_bone" style="color: #f1c40f;">
            <span>🦴 Active Bone (Rot & Pos)</span>
            <span class="shortcut">5</span>
          </div>
          <div class="tl-kf-modal-item" data-channels="all_bones" style="color: #e67e22;">
            <span>🦴 All Armature Bones</span>
            <span class="shortcut">6</span>
          </div>
        </div>
      </div>
    `;

    // Cache elements
    this.elements = {
      root: this.container.querySelector('.blender-timeline-root'),
      btnPlay: this.container.querySelector('#tl-btn-play'),
      btnFirst: this.container.querySelector('#tl-btn-first'),
      btnLast: this.container.querySelector('#tl-btn-last'),
      btnPrevKf: this.container.querySelector('#tl-btn-prev-kf'),
      btnNextKf: this.container.querySelector('#tl-btn-next-kf'),
      btnPrevFrame: this.container.querySelector('#tl-btn-prev-frame'),
      btnNextFrame: this.container.querySelector('#tl-btn-next-frame'),
      btnInsertKf: this.container.querySelector('#tl-btn-insert-kf'),
      btnDeleteKf: this.container.querySelector('#tl-btn-delete-kf'),
      btnRecord: this.container.querySelector('#tl-btn-record'),
      btnTurntable: this.container.querySelector('#tl-btn-turntable'),
      btnLoop: this.container.querySelector('#tl-btn-loop'),
      btnRenderVideo: this.container.querySelector('#tl-btn-render-video'),
      inputCurrentFrame: this.container.querySelector('#tl-input-current-frame'),
      inputStartFrame: this.container.querySelector('#tl-input-start-frame'),
      inputEndFrame: this.container.querySelector('#tl-input-end-frame'),
      selectFps: this.container.querySelector('#tl-select-fps'),
      selectInterp: this.container.querySelector('#tl-select-interp'),
      selectMotionPreset: this.container.querySelector('#tl-select-motion-preset'),
      channelRows: this.container.querySelector('#tl-channel-rows'),
      tracksScroll: this.container.querySelector('#tl-tracks-scroll-container'),
      tracksContent: this.container.querySelector('#tl-tracks-content'),
      rulerWrapper: this.container.querySelector('#tl-ruler-wrapper'),
      rulerCanvas: this.container.querySelector('#tl-ruler-canvas'),
      lanesContainer: this.container.querySelector('#tl-lanes-container'),
      playhead: this.container.querySelector('#tl-playhead'),
      playheadBadge: this.container.querySelector('#tl-playhead-badge'),
      kfModal: this.container.querySelector('#tl-kf-modal'),
      modeTabs: this.container.querySelectorAll('.tl-mode-btn'),
      actionBar: this.container.querySelector('#tl-action-bar'),
      actionSelect: this.container.querySelector('#tl-action-select'),
      btnActionNew: this.container.querySelector('#tl-btn-action-new'),
      btnActionDup: this.container.querySelector('#tl-btn-action-dup'),
      btnActionFake: this.container.querySelector('#tl-btn-action-fake'),
      btnActionPush: this.container.querySelector('#tl-btn-action-push'),
      btnNlaAddTrack: this.container.querySelector('#tl-btn-nla-add-track'),
      bodySplit: this.container.querySelector('#tl-body-split'),
      chPanelTitle: this.container.querySelector('#tl-ch-panel-title'),
      nlaStripBar: this.container.querySelector('#tl-nla-strip-bar'),
      driversPanel: this.container.querySelector('#tl-drivers-panel'),
    };

    this._drawRuler();
  }

  // =========================================================================
  // EVENT BINDINGS
  // =========================================================================

  _bindEvents() {
    const el = this.elements;

    // Transport buttons
    el.btnPlay?.addEventListener('click', () => this.engine.togglePlay());
    el.btnFirst?.addEventListener('click', () => this.engine.seekToFrame(this.engine.startFrame));
    el.btnLast?.addEventListener('click', () => this.engine.seekToFrame(this.engine.endFrame));
    el.btnPrevFrame?.addEventListener('click', () => this.engine.stepFrame(-1));
    el.btnNextFrame?.addEventListener('click', () => this.engine.stepFrame(1));
    el.btnPrevKf?.addEventListener('click', () => this.engine.jumpToPrevKeyframe());
    el.btnNextKf?.addEventListener('click', () => this.engine.jumpToNextKeyframe());

    // Action buttons
    el.btnInsertKf?.addEventListener('click', (e) => {
      this._showInsertModal(e);
    });

    el.btnDeleteKf?.addEventListener('click', () => {
      const active = this.sceneManager ? this.sceneManager.getActiveObject() : null;
      if (active) {
        this.engine.deleteKeyframe(active, Math.round(this.engine.currentFrame));
      }
    });

    el.btnRecord?.addEventListener('click', () => {
      this.engine.setAutoKeyframe();
    });

    el.btnTurntable?.addEventListener('click', () => {
      this.engine.toggleTurntable();
    });

    el.btnLoop?.addEventListener('click', () => {
      this.engine.setLoop();
    });

    el.btnRenderVideo?.addEventListener('click', () => {
      if (typeof window !== 'undefined' && window.app?.openRenderAnimationDialog) {
        window.app.openRenderAnimationDialog();
      }
    });

    // Inputs
    el.inputCurrentFrame?.addEventListener('change', (e) => {
      const val = parseInt(e.target.value, 10);
      if (!isNaN(val)) this.engine.seekToFrame(val);
    });

    el.inputStartFrame?.addEventListener('change', (e) => {
      const start = parseInt(e.target.value, 10);
      const end = parseInt(el.inputEndFrame.value, 10);
      if (!isNaN(start) && !isNaN(end)) {
        this.engine.setFrameRange(start, end);
        this._drawRuler();
      }
    });

    el.inputEndFrame?.addEventListener('change', (e) => {
      const start = parseInt(el.inputStartFrame.value, 10);
      const end = parseInt(e.target.value, 10);
      if (!isNaN(start) && !isNaN(end)) {
        this.engine.setFrameRange(start, end);
        this._drawRuler();
      }
    });

    el.selectFps?.addEventListener('change', (e) => {
      this.engine.setFPS(parseInt(e.target.value, 10));
    });

    el.selectInterp?.addEventListener('change', (e) => {
      this.engine.setDefaultInterpolation(e.target.value);
    });

    el.selectMotionPreset?.addEventListener('change', (e) => {
      const presetKey = e.target.value;
      if (!presetKey) return;
      const ok = this.engine.applyMotionPreset(null, presetKey);
      if (ok) {
        if (el.inputStartFrame) el.inputStartFrame.value = this.engine.startFrame;
        if (el.inputEndFrame) el.inputEndFrame.value = this.engine.endFrame;
        if (el.selectFps) el.selectFps.value = this.engine.fps;
        this._drawRuler();
        this._updateTrackView();
        this._updatePlayheadPosition();
      }
      e.target.value = '';
    });

    // Mode tabs (Dope Sheet / Action / NLA / Drivers)
    el.modeTabs?.forEach((btn) => {
      btn.addEventListener('click', () => {
        this.setViewMode(btn.dataset.tlMode || 'dopesheet');
      });
    });

    // Action Editor controls
    el.actionSelect?.addEventListener('change', (e) => {
      const target = this._getActiveTargetObject();
      if (target) {
        this.engine.assignAction(target, e.target.value || null);
      }
    });

    el.btnActionNew?.addEventListener('click', () => {
      const target = this._getActiveTargetObject();
      this.engine.createAction(target, null, { cloneCurrent: !!target });
    });

    el.btnActionDup?.addEventListener('click', () => {
      const target = this._getActiveTargetObject();
      const cur = target ? this.engine.getActiveAction(target) : null;
      if (cur) this.engine.duplicateAction(cur.id, null, target);
    });

    el.btnActionFake?.addEventListener('click', () => {
      const target = this._getActiveTargetObject();
      const cur = target ? this.engine.getActiveAction(target) : null;
      if (cur) {
        this.engine.setActionFakeUser(cur.id, !cur.fakeUser);
        this._syncActionBar();
      }
    });

    el.btnActionPush?.addEventListener('click', () => {
      const target = this._getActiveTargetObject();
      if (target) {
        this.engine.pushActionToNLA(target);
        this.setViewMode('nla');
      }
    });

    el.btnNlaAddTrack?.addEventListener('click', () => {
      const target = this._getActiveTargetObject();
      if (target) {
        this.engine.addNLATrack(target);
        this._updateTrackView();
      }
    });

    // Scrubbing on Ruler & Tracks
    const startScrub = (e) => {
      this.isScrubbing = true;
      this._handleScrubMove(e);
      window.addEventListener('pointermove', onScrubMove);
      window.addEventListener('pointerup', onScrubEnd);
    };

    const onScrubMove = (e) => {
      if (this.isScrubbing) {
        this._handleScrubMove(e);
      }
    };

    const onScrubEnd = () => {
      this.isScrubbing = false;
      window.removeEventListener('pointermove', onScrubMove);
      window.removeEventListener('pointerup', onScrubEnd);
    };

    el.rulerWrapper?.addEventListener('pointerdown', startScrub);
    el.lanesContainer?.addEventListener('pointerdown', (e) => {
      // Don't scrub if clicking on a diamond directly
      if (e.target.classList.contains('tl-diamond')) return;
      startScrub(e);
    });

    // Modal selection
    el.kfModal?.querySelectorAll('.tl-kf-modal-item').forEach(item => {
      item.addEventListener('click', () => {
        const ch = item.dataset.channels;
        const active = this.sceneManager ? this.sceneManager.getActiveObject() : null;
        const rs = (typeof window !== 'undefined' ? window.rigSystem : null);

        if (ch === 'active_bone') {
          if (rs && rs.activeBone) {
            this.engine.insertBoneKeyframe(active, rs.activeBone, Math.round(this.engine.currentFrame), ['rotation', 'position']);
          } else {
            this.engine.insertKeyframe(active, Math.round(this.engine.currentFrame), ['active_bone']);
          }
        } else if (ch === 'all_bones') {
          this.engine.insertAllBonesKeyframe(active, Math.round(this.engine.currentFrame), ['rotation']);
        } else if (active) {
          const channels = ch === 'all' ? ['position', 'rotation', 'scale'] : [ch];
          this.engine.insertKeyframe(active, Math.round(this.engine.currentFrame), channels);
        }
        this._hideInsertModal();
      });
    });

    // Click outside modal closes it
    document.addEventListener('click', (e) => {
      if (el.kfModal && el.kfModal.style.display !== 'none') {
        if (!el.kfModal.contains(e.target) && !el.btnInsertKf.contains(e.target)) {
          this._hideInsertModal();
        }
      }
    });
  }

  // =========================================================================
  // TOP HEADER CONTROLS BAR SYNC
  // =========================================================================

  _bindHeaderSync() {
    const playBtn = document.getElementById('btn-timeline-play');
    const rewindBtn = document.getElementById('btn-timeline-rewind');
    const frameIndicator = document.getElementById('timeline-current-frame');

    if (playBtn) {
      // Override default listener with engine toggle
      playBtn.onclick = (e) => {
        e.stopPropagation();
        this.engine.togglePlay();
      };
    }

    if (rewindBtn) {
      rewindBtn.onclick = (e) => {
        e.stopPropagation();
        this.engine.seekToFrame(this.engine.startFrame);
      };
    }

    this.engine.on('frameChanged', ({ frame }) => {
      if (frameIndicator) frameIndicator.innerText = frame;
    });

    this.engine.on('playStateChanged', ({ isPlaying }) => {
      if (playBtn) playBtn.innerText = isPlaying ? '⏸ Pause' : '▶ Play (Space)';
    });
  }

  // =========================================================================
  // GLOBAL SHORTCUTS
  // =========================================================================

  _bindKeyboardShortcuts() {
    window.addEventListener('keydown', (e) => {
      if (isTextEntryTarget()) return;

      const key = e.key.toLowerCase();
      const kfOpen = !!this.elements.kfModal && this.elements.kfModal.classList.contains('is-open');

      // The keyframe picker owns the keyboard while it is open. Handle it
      // before the global guard so its own 1-6/Enter/Escape keys still work.
      if (kfOpen) {
        // Browser/OS combos keep working while the picker is open.
        if (e.ctrlKey || e.metaKey || e.altKey) return;
        e.preventDefault();
        const active = this.sceneManager ? this.sceneManager.getActiveObject() : null;
        const rs = (typeof window !== 'undefined' ? window.rigSystem : null);

        if (e.key === '1' && active) {
          this.engine.insertKeyframe(active, Math.round(this.engine.currentFrame), ['location']);
          this._hideInsertModal();
        } else if (e.key === '2' && active) {
          this.engine.insertKeyframe(active, Math.round(this.engine.currentFrame), ['rotation']);
          this._hideInsertModal();
        } else if (e.key === '3' && active) {
          this.engine.insertKeyframe(active, Math.round(this.engine.currentFrame), ['scale']);
          this._hideInsertModal();
        } else if (e.key === '4' && active) {
          this.engine.insertKeyframe(active, Math.round(this.engine.currentFrame), ['all']);
          this._hideInsertModal();
        } else if (e.key === '5') {
          if (rs && rs.activeBone) {
            this.engine.insertBoneKeyframe(active, rs.activeBone, Math.round(this.engine.currentFrame), ['rotation', 'position']);
          } else if (active) {
            this.engine.insertKeyframe(active, Math.round(this.engine.currentFrame), ['active_bone']);
          }
          this._hideInsertModal();
        } else if (e.key === '6') {
          this.engine.insertAllBonesKeyframe(active, Math.round(this.engine.currentFrame), ['rotation']);
          this._hideInsertModal();
        } else if (e.key === 'Enter') {
          if (rs && rs.isPoseMode && rs.activeBone) {
            this.engine.insertBoneKeyframe(active, rs.activeBone, Math.round(this.engine.currentFrame), ['rotation', 'position']);
          } else if (active) {
            this.engine.insertKeyframe(active, Math.round(this.engine.currentFrame), ['all']);
          }
          this._hideInsertModal();
        } else if (e.key === 'Escape') {
          this._hideInsertModal();
        }
        return;
      }

      if (shouldBlockViewportShortcut()) return;

      // Blender I: Insert Keyframe. In Edit Mode I is Inset, so the timeline
      // must not open its picker as well.
      const editActive = typeof window !== 'undefined' && !!window.editMode?.isActive;
      if (key === 'i' && !e.ctrlKey && !e.metaKey && !editActive) {
        e.preventDefault();
        const active = this.sceneManager ? this.sceneManager.getActiveObject() : null;
        const rs = (typeof window !== 'undefined' ? window.rigSystem : null);

        if (active || (rs && rs.activeBone)) {
          if (e.altKey) {
            // Alt + I: Delete Keyframe
            if (rs && rs.isPoseMode && rs.activeBone) {
              this.engine.deleteBoneKeyframe(active, rs.activeBone.name, Math.round(this.engine.currentFrame));
            } else {
              this.engine.deleteKeyframe(active, Math.round(this.engine.currentFrame));
            }
          } else {
            this._showInsertModal();
          }
        }
      }

      // Space: Play/Pause (plain only; Cmd/Ctrl+Space belongs to the browser)
      if (e.code === 'Space' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        this.engine.togglePlay();
      }

      // Left / Right Arrow: Step Frame (Shift jumps to start/end)
      if (e.code === 'ArrowLeft' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        if (e.shiftKey) {
          this.engine.seekToFrame(this.engine.startFrame);
        } else {
          this.engine.stepFrame(-1);
        }
      } else if (e.code === 'ArrowRight' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        if (e.shiftKey) {
          this.engine.seekToFrame(this.engine.endFrame);
        } else {
          this.engine.stepFrame(1);
        }
      }

      // Up / Down Arrow: Jump to Next / Prev Keyframe (plain only)
      if (e.code === 'ArrowUp' && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
        e.preventDefault();
        this.engine.jumpToNextKeyframe();
      } else if (e.code === 'ArrowDown' && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
        e.preventDefault();
        this.engine.jumpToPrevKeyframe();
      }
    });
  }

  // =========================================================================
  // SCRUBBING CALCULATION
  // =========================================================================

  _handleScrubMove(e) {
    const rect = this.elements.rulerWrapper.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    const clampedX = Math.max(0, Math.min(rect.width, clickX));

    const totalFrames = this.engine.endFrame - this.engine.startFrame;
    const ratio = clampedX / rect.width;
    const targetFrame = Math.round(this.engine.startFrame + ratio * totalFrames);

    this.engine.seekToFrame(targetFrame);
  }

  // =========================================================================
  // RULER DRAWING (Canvas)
  // =========================================================================

  _drawRuler() {
    const canvas = this.elements.rulerCanvas;
    if (!canvas) return;

    const wrapper = this.elements.rulerWrapper;
    const width = wrapper.clientWidth || 800;
    const height = wrapper.clientHeight || 26;

    canvas.width = width * window.devicePixelRatio;
    canvas.height = height * window.devicePixelRatio;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;

    const ctx = canvas.getContext('2d');
    ctx.scale(window.devicePixelRatio, window.devicePixelRatio);

    ctx.fillStyle = '#202020';
    ctx.fillRect(0, 0, width, height);

    const start = this.engine.startFrame;
    const end = this.engine.endFrame;
    const totalFrames = Math.max(1, end - start);

    ctx.strokeStyle = '#3d3d3d';
    ctx.fillStyle = '#8f8f8f';
    ctx.font = '9px Inter, -apple-system, sans-serif';
    ctx.lineWidth = 1;

    for (let f = start; f <= end; f++) {
      const x = ((f - start) / totalFrames) * width;

      if (f % 10 === 0) {
        // Major tick
        ctx.beginPath();
        ctx.moveTo(x, height);
        ctx.lineTo(x, height - 12);
        ctx.stroke();

        ctx.fillText(f.toString(), x + 3, height - 13);
      } else if (f % 5 === 0) {
        // Medium tick
        ctx.beginPath();
        ctx.moveTo(x, height);
        ctx.lineTo(x, height - 7);
        ctx.stroke();
      } else if (totalFrames <= 100) {
        // Minor tick
        ctx.beginPath();
        ctx.moveTo(x, height);
        ctx.lineTo(x, height - 4);
        ctx.stroke();
      }
    }
  }

  // =========================================================================
  // PLAYHEAD POSITIONING & UI SYNC
  // =========================================================================

  _updatePlayheadPosition() {
    const playhead = this.elements.playhead;
    const wrapper = this.elements.rulerWrapper;
    if (!playhead || !wrapper) return;

    const width = wrapper.clientWidth || 800;
    const start = this.engine.startFrame;
    const end = this.engine.endFrame;
    const current = this.engine.currentFrame;

    const fraction = (current - start) / Math.max(1, end - start);
    const x = fraction * width;

    playhead.style.transform = `translateX(${x}px)`;
  }

  _syncFrameDisplay(frame) {
    if (this.elements.inputCurrentFrame && document.activeElement !== this.elements.inputCurrentFrame) {
      this.elements.inputCurrentFrame.value = Math.round(frame);
    }
    if (this.elements.playheadBadge) {
      this.elements.playheadBadge.innerText = Math.round(frame);
    }
  }

  _updatePlayButtons(isPlaying) {
    if (this.elements.btnPlay) {
      const iconPlay = this.elements.btnPlay.querySelector('.icon-play');
      const iconPause = this.elements.btnPlay.querySelector('.icon-pause');
      if (iconPlay && iconPause) {
        iconPlay.style.display = isPlaying ? 'none' : 'block';
        iconPause.style.display = isPlaying ? 'block' : 'none';
      }
      this.elements.btnPlay.classList.toggle('active', isPlaying);
    }
  }

  // =========================================================================
  // TRACK & KEYFRAME DIAMONDS RENDERING
  // =========================================================================

  _getActiveTargetObject() {
    const rs = (typeof window !== 'undefined' ? window.rigSystem : null);
    let activeObj = this.sceneManager ? this.sceneManager.getActiveObject() : null;
    if (!activeObj && rs && rs.activeCharacter) activeObj = rs.activeCharacter;
    if (!activeObj) return null;
    return this.engine._findArmatureRoot(activeObj) || activeObj;
  }

  setViewMode(mode = 'dopesheet') {
    const valid = ['dopesheet', 'action', 'nla', 'drivers'];
    this.viewMode = valid.includes(mode) ? mode : 'dopesheet';
    const el = this.elements;

    el.modeTabs?.forEach((b) => b.classList.toggle('active', b.dataset.tlMode === this.viewMode));
    if (el.actionBar) {
      el.actionBar.style.display = (this.viewMode === 'action' || this.viewMode === 'nla') ? 'flex' : 'none';
    }
    if (el.btnNlaAddTrack) {
      el.btnNlaAddTrack.style.display = this.viewMode === 'nla' ? 'inline-flex' : 'none';
    }
    if (el.bodySplit) {
      el.bodySplit.style.display = this.viewMode === 'drivers' ? 'none' : 'flex';
    }
    if (el.driversPanel) {
      el.driversPanel.style.display = this.viewMode === 'drivers' ? 'flex' : 'none';
    }
    if (el.nlaStripBar) {
      el.nlaStripBar.style.display = (this.viewMode === 'nla' && this.selectedNLAStrip) ? 'flex' : 'none';
    }
    if (el.chPanelTitle) {
      el.chPanelTitle.textContent = this.viewMode === 'nla' ? 'NLA Tracks' : 'Animation Channels';
    }

    this._syncActionBar();
    this._updateTrackView();
  }

  _syncActionBar() {
    const sel = this.elements.actionSelect;
    if (!sel) return;
    const target = this._getActiveTargetObject();
    const activeAction = target ? this.engine.getActiveAction(target) : null;
    const allActions = Array.from(this.engine.actionsMap?.values?.() || []);

    sel.innerHTML = '<option value="">(No Action)</option>';
    for (const act of allActions) {
      const opt = document.createElement('option');
      opt.value = act.id;
      opt.textContent = `${act.fakeUser ? '[F] ' : ''}${act.name}`;
      if (activeAction && activeAction.id === act.id) opt.selected = true;
      sel.appendChild(opt);
    }

    if (this.elements.btnActionFake) {
      this.elements.btnActionFake.classList.toggle('active', !!activeAction?.fakeUser);
    }
  }

  _updateTrackView() {
    const channelRowsEl = this.elements.channelRows;
    const lanesContainerEl = this.elements.lanesContainer;
    if (!channelRowsEl || !lanesContainerEl) return;

    this._syncActionBar();

    if (this.viewMode === 'drivers') {
      this._renderDriversPanel();
      return;
    }

    if (this.viewMode === 'nla') {
      this._renderNLATrackView(channelRowsEl, lanesContainerEl);
      return;
    }

    channelRowsEl.innerHTML = '';
    lanesContainerEl.innerHTML = '';

    const rs = (typeof window !== 'undefined' ? window.rigSystem : null);
    let activeObj = this.sceneManager ? this.sceneManager.getActiveObject() : null;
    if (!activeObj && rs && rs.activeCharacter) {
      activeObj = rs.activeCharacter;
    }
    const activeBone = (rs && rs.isPoseMode) ? rs.activeBone : null;

    // Resolve armature root if activeObj is a bone or child
    const armatureRoot = activeObj ? (this.engine._findArmatureRoot(activeObj) || activeObj) : null;
    const targetTrack = armatureRoot && this.engine.tracks.has(armatureRoot.uuid)
      ? this.engine.tracks.get(armatureRoot.uuid)
      : (activeObj && this.engine.tracks.has(activeObj.uuid) ? this.engine.tracks.get(activeObj.uuid) : null);

    const trackName = armatureRoot ? armatureRoot.name : (activeObj ? activeObj.name : 'No Selection (All Tracks)');
    const keyframes = targetTrack ? targetTrack.keyframes : [];

    // 1. Channel Row 1: Summary / Object Track
    const summaryRow = document.createElement('div');
    summaryRow.className = 'tl-ch-row tl-ch-summary';
    const safeTrackName = escapeHtml(trackName);
    summaryRow.innerHTML = `
      <svg class="tl-ch-icon" viewBox="0 0 24 24"><path d="M12 2l7 7-7 7-7-7 7-7z"/></svg>
      <span class="tl-ch-name" title="${safeTrackName}">${safeTrackName}</span>
      <span class="tl-ch-badge">${keyframes.length} kf</span>
    `;
    channelRowsEl.appendChild(summaryRow);

    const summaryLane = document.createElement('div');
    summaryLane.className = 'tl-lane tl-lane-summary';
    this._renderKeyframeDiamonds(summaryLane, keyframes, 'all', armatureRoot || activeObj);
    lanesContainerEl.appendChild(summaryLane);

    // If an object is selected, render individual channels (Location, Rotation, Scale)
    if (activeObj || armatureRoot) {
      const targetObj = armatureRoot || activeObj;
      const channels = [
        { id: 'location', name: 'Location (X, Y, Z)', color: '#4772b3' },
        { id: 'rotation', name: 'Rotation (Euler)', color: '#43a047' },
        { id: 'scale', name: 'Scale (Dimensions)', color: '#e58c2c' }
      ];

      channels.forEach(ch => {
        const chRow = document.createElement('div');
        chRow.className = `tl-ch-row tl-ch-sub tl-ch-${ch.id}`;
        chRow.innerHTML = `
          <div class="tl-ch-dot" style="background:${ch.color};"></div>
          <span class="tl-ch-name">${ch.name}</span>
        `;
        channelRowsEl.appendChild(chRow);

        const chLane = document.createElement('div');
        chLane.className = `tl-lane tl-lane-sub tl-lane-${ch.id}`;

        // Filter keyframes containing this channel
        const chKeyframes = keyframes.filter(k => {
          if (ch.id === 'location') return !!k.position;
          if (ch.id === 'rotation') return !!k.rotation;
          if (ch.id === 'scale') return !!k.scale;
          return false;
        });

        this._renderKeyframeDiamonds(chLane, chKeyframes, ch.id, targetObj);
        lanesContainerEl.appendChild(chLane);
      });

      // 2. Render Skeletal Bone Tracks
      const boneTracks = targetTrack?.boneTracks || (armatureRoot ? this.engine.getBoneTracks(armatureRoot) : null);
      const isArmatureOrSkinned = targetObj.userData?.isArmature || targetObj.isSkinnedMesh || targetObj.skeleton || (rs && rs.activeCharacter === targetObj);

      if (isArmatureOrSkinned || (boneTracks && boneTracks.size > 0) || activeBone) {
        // Section Header for Bones
        const boneHeaderRow = document.createElement('div');
        boneHeaderRow.className = 'tl-ch-row tl-ch-summary';
        boneHeaderRow.style.background = '#2c3e50';
        boneHeaderRow.style.borderTop = '1px solid #34495e';
        const bCount = boneTracks ? boneTracks.size : 0;
        boneHeaderRow.innerHTML = `
          <span style="font-size:12px; margin-right:4px;">🦴</span>
          <span class="tl-ch-name" style="color:#f39c12; font-weight:600;">SKELETAL BONES (${bCount})</span>
        `;
        channelRowsEl.appendChild(boneHeaderRow);

        const boneHeaderLane = document.createElement('div');
        boneHeaderLane.className = 'tl-lane tl-lane-summary';
        boneHeaderLane.style.background = '#1e272e';
        lanesContainerEl.appendChild(boneHeaderLane);

        // If in Pose Mode and activeBone has focus, render active bone highlighted first
        if (activeBone) {
          const bEntry = boneTracks ? boneTracks.get(activeBone.name) : null;
          const rotKf = bEntry?.rotationTrack || [];
          const posKf = bEntry?.positionTrack || [];
          const allBoneKf = [...rotKf];
          posKf.forEach(pk => {
            if (!allBoneKf.some(k => k.frame === pk.frame)) allBoneKf.push(pk);
          });
          allBoneKf.sort((a, b) => a.frame - b.frame);

          const aRow = document.createElement('div');
          aRow.className = 'tl-ch-row tl-ch-sub';
          aRow.style.background = '#2d3436';
          aRow.style.borderLeft = '3px solid #00cec9';
          aRow.innerHTML = `
            <div class="tl-ch-dot" style="background:#00cec9;"></div>
            <span class="tl-ch-name" style="color:#81ecec; font-weight:600;">🦴 Active: ${escapeHtml(activeBone.name)}</span>
            <span class="tl-ch-badge" style="background:#00cec9; color:#000;">${allBoneKf.length} kf</span>
          `;
          channelRowsEl.appendChild(aRow);

          const aLane = document.createElement('div');
          aLane.className = 'tl-lane tl-lane-sub';
          aLane.style.background = 'rgba(0, 206, 201, 0.08)';
          this._renderKeyframeDiamonds(aLane, allBoneKf, 'bone', targetObj, activeBone.name);
          lanesContainerEl.appendChild(aLane);
        }

        // Render all other keyframed bones
        if (boneTracks && boneTracks.size > 0) {
          boneTracks.forEach((bEntry, bName) => {
            if (activeBone && bName === activeBone.name) return; // Already rendered above
            const rotKf = bEntry.rotationTrack || [];
            const posKf = bEntry.positionTrack || [];
            const allBoneKf = [...rotKf];
            posKf.forEach(pk => {
              if (!allBoneKf.some(k => k.frame === pk.frame)) allBoneKf.push(pk);
            });
            allBoneKf.sort((a, b) => a.frame - b.frame);

            const bRow = document.createElement('div');
            bRow.className = 'tl-ch-row tl-ch-sub';
            const safeBoneName = escapeHtml(bName);
            bRow.innerHTML = `
              <div class="tl-ch-dot" style="background:#f39c12;"></div>
              <span class="tl-ch-name" title="Bone: ${safeBoneName}">🦴 ${safeBoneName}</span>
              <span class="tl-ch-badge">${allBoneKf.length} kf</span>
            `;
            channelRowsEl.appendChild(bRow);

            const bLane = document.createElement('div');
            bLane.className = 'tl-lane tl-lane-sub';
            this._renderKeyframeDiamonds(bLane, allBoneKf, 'bone', targetObj, bName);
            lanesContainerEl.appendChild(bLane);
          });
        }
      }
    } else {
      // Empty state prompt
      const emptyNote = document.createElement('div');
      emptyNote.className = 'tl-empty-hint';
      emptyNote.innerText = 'Select a 3D object or Armature to view & record keyframes (Hotkeys: I = Insert, Space = Play)';
      lanesContainerEl.appendChild(emptyNote);
    }

    this._drawRuler();
    this._updatePlayheadPosition();
  }

  /**
   * Renders diamond markers (◆) on a lane
   */
  _renderKeyframeDiamonds(laneElement, keyframes, channelType, object = null, boneName = null) {
    const start = this.engine.startFrame;
    const end = this.engine.endFrame;
    const totalFrames = Math.max(1, end - start);

    keyframes.forEach(kf => {
      const frac = (kf.frame - start) / totalFrames;
      if (frac < 0 || frac > 1) return; // Outside visible range

      const percent = frac * 100;
      const diamond = document.createElement('div');
      const isBone = !!boneName || channelType === 'bone';
      diamond.className = `tl-diamond ${isBone ? 'tl-bone-diamond' : ''} ${kf.frame === Math.round(this.engine.currentFrame) ? 'active' : ''}`;
      diamond.style.left = `${percent}%`;

      if (isBone) {
        diamond.title = `🦴 Bone [${boneName || 'Bone'}] @ Frame ${kf.frame} (${kf.interpolation || 'slerp'})`;
      } else {
        diamond.title = `Frame ${kf.frame} (${channelType}): ${kf.interpolation || 'smooth'}`;
      }

      // Diamond click seeks to frame
      diamond.addEventListener('click', (e) => {
        e.stopPropagation();
        this.engine.seekToFrame(kf.frame);
      });

      // Right-click deletes keyframe
      diamond.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const msg = isBone
          ? `Delete bone keyframe for [${boneName}] at frame ${kf.frame}?`
          : `Delete keyframe at frame ${kf.frame}?`;
        if (confirm(msg)) {
          if (isBone && boneName) {
            this.engine.deleteBoneKeyframe(object, boneName, kf.frame);
          } else {
            const target = object || (this.sceneManager ? this.sceneManager.getActiveObject() : null);
            if (target) {
              this.engine.deleteKeyframe(target, kf.frame);
            }
          }
        }
      });

      laneElement.appendChild(diamond);
    });
  }

  // =========================================================================
  // KEYFRAME MODAL (HotKey 'I')
  // =========================================================================

  _showInsertModal(e = null) {
    const modal = this.elements.kfModal;
    if (!modal) return;

    if (e && e.clientX) {
      modal.style.left = `${Math.min(window.innerWidth - 180, e.clientX)}px`;
      modal.style.top = `${Math.max(10, e.clientY - 140)}px`;
    } else {
      // Position near center / bottom dock
      const dock = document.getElementById('bottom-dock');
      const rect = dock ? dock.getBoundingClientRect() : { left: 100, top: 400 };
      modal.style.left = `${rect.left + 80}px`;
      modal.style.top = `${rect.top - 140}px`;
    }

    modal.style.display = 'block';
    modal.classList.add('is-open');
  }

  _hideInsertModal() {
    if (this.elements.kfModal) {
      this.elements.kfModal.style.display = 'none';
      this.elements.kfModal.classList.remove('is-open');
    }
  }

  // =========================================================================
  // WAVE 4B: NLA STRIP VIEW & DRIVERS EDITOR PANEL
  // =========================================================================

  _renderNLATrackView(channelRowsEl, lanesContainerEl) {
    channelRowsEl.innerHTML = '';
    lanesContainerEl.innerHTML = '';

    const target = this._getActiveTargetObject();
    if (!target) {
      const hint = document.createElement('div');
      hint.className = 'tl-empty-hint';
      hint.textContent = 'Select an object to layer NLA Tracks & Strips.';
      lanesContainerEl.appendChild(hint);
      this._syncNLASelectedStripBar();
      return;
    }

    const nlaTracks = this.engine.getNLATracks(target);
    const start = this.engine.startFrame;
    const end = this.engine.endFrame;
    const totalFrames = Math.max(1, end - start);

    if (nlaTracks.length === 0) {
      const hint = document.createElement('div');
      hint.className = 'tl-empty-hint';
      hint.textContent = 'No NLA Tracks yet. Use "+ NLA Track" or "⬇ Push Down to NLA".';
      lanesContainerEl.appendChild(hint);
      this._syncNLASelectedStripBar();
      return;
    }

    // Render top-to-bottom visually cleanly (last pushed / top track at top)
    for (let i = nlaTracks.length - 1; i >= 0; i--) {
      const tr = nlaTracks[i];
      const row = document.createElement('div');
      row.className = 'tl-ch-row tl-nla-row';
      const safeTrackLabel = escapeHtml(tr.name);
      row.innerHTML = `
        <span class="tl-ch-name" title="${safeTrackLabel}">${safeTrackLabel}</span>
        <button type="button" class="tl-nla-mini-btn ${tr.muted ? 'muted' : ''}" data-act="mute" title="Mute Track">M</button>
        <button type="button" class="tl-nla-mini-btn ${tr.solo ? 'solo' : ''}" data-act="solo" title="Solo Track">S</button>
        <button type="button" class="tl-nla-mini-btn" data-act="add-strip" title="Add Strip from Selected Action">+</button>
        <button type="button" class="tl-nla-mini-btn" data-act="del-track" title="Delete NLA Track">✕</button>
      `;

      row.querySelector('[data-act="mute"]')?.addEventListener('click', () => {
        this.engine.setNLATrackState(target, tr.id, { muted: !tr.muted });
      });
      row.querySelector('[data-act="solo"]')?.addEventListener('click', () => {
        this.engine.setNLATrackState(target, tr.id, { solo: !tr.solo });
      });
      row.querySelector('[data-act="add-strip"]')?.addEventListener('click', () => {
        const chosenId = this.elements.actionSelect?.value || this.engine.actionsMap?.keys().next().value;
        if (chosenId) {
          const st = this.engine.addNLAStrip(target, tr.id, { actionId: chosenId, startFrame: Math.round(this.engine.currentFrame) });
          if (st) this.selectedNLAStrip = { objectUuid: target.uuid, trackId: tr.id, stripId: st.id };
          this._syncNLASelectedStripBar();
        }
      });
      row.querySelector('[data-act="del-track"]')?.addEventListener('click', () => {
        if (this.selectedNLAStrip?.trackId === tr.id) this.selectedNLAStrip = null;
        this.engine.removeNLATrack(target, tr.id);
      });
      channelRowsEl.appendChild(row);

      const lane = document.createElement('div');
      lane.className = `tl-lane tl-nla-lane ${tr.muted ? 'is-muted' : ''}`;

      for (const strip of tr.strips || []) {
        const leftPct = ((strip.startFrame - start) / totalFrames) * 100;
        const widthPct = Math.max(2, ((strip.endFrame - strip.startFrame) / totalFrames) * 100);
        const el = document.createElement('div');
        const isSel = this.selectedNLAStrip?.stripId === strip.id;
        el.className = `tl-nla-strip tl-nla-blend-${strip.blendMode} ${isSel ? 'selected' : ''}`;
        el.style.left = `${leftPct}%`;
        el.style.width = `${widthPct}%`;
        el.title = `${strip.name} [${strip.startFrame.toFixed(1)}..${strip.endFrame.toFixed(1)}] (${strip.blendMode}, inf=${strip.influence})`;
        el.innerHTML = `<span class="tl-nla-strip-label">${escapeHtml(strip.name)}</span><span class="tl-nla-strip-badge">${escapeHtml(strip.blendMode).slice(0, 3).toUpperCase()} ${(strip.influence * 100).toFixed(0)}%</span>`;

        el.addEventListener('mousedown', (e) => {
          e.stopPropagation();
          this.selectedNLAStrip = { objectUuid: target.uuid, trackId: tr.id, stripId: strip.id };
          this._syncNLASelectedStripBar();
          const startClientX = e.clientX;
          const origStart = strip.startFrame;
          const span = strip.endFrame - strip.startFrame;
          const laneW = Math.max(100, lane.getBoundingClientRect().width);
          const onMove = (mv) => {
            const dx = mv.clientX - startClientX;
            const dFrames = Math.round((dx / laneW) * totalFrames);
            this.engine.updateNLAStrip(target, tr.id, strip.id, {
              startFrame: origStart + dFrames,
              endFrame: origStart + dFrames + span,
            });
          };
          const onUp = () => {
            window.removeEventListener('mousemove', onMove);
            window.removeEventListener('mouseup', onUp);
          };
          window.addEventListener('mousemove', onMove);
          window.addEventListener('mouseup', onUp);
        });

        lane.appendChild(el);
      }

      lanesContainerEl.appendChild(lane);
    }

    this._syncNLASelectedStripBar();
    this._drawRuler();
    this._updatePlayheadPosition();
  }

  _syncNLASelectedStripBar() {
    const bar = this.elements.nlaStripBar;
    if (!bar) return;
    if (this.viewMode !== 'nla' || !this.selectedNLAStrip) {
      bar.style.display = 'none';
      return;
    }

    const target = this._getActiveTargetObject();
    const list = target ? this.engine.getNLATracks(target) : [];
    const tr = list.find((t) => t.id === this.selectedNLAStrip.trackId);
    const strip = tr?.strips?.find((s) => s.id === this.selectedNLAStrip.stripId);
    if (!target || !tr || !strip) {
      bar.style.display = 'none';
      return;
    }

    bar.style.display = 'flex';
    bar.innerHTML = `
      <span class="tl-subbar-label">Strip: <b>${escapeHtml(strip.name)}</b></span>
      <label class="tl-mini-field">Start <input type="number" id="nla-st-start" step="1" value="${strip.startFrame}"></label>
      <label class="tl-mini-field">End <input type="number" id="nla-st-end" step="1" value="${strip.endFrame}"></label>
      <label class="tl-mini-field">Scale <input type="number" id="nla-st-scale" step="0.1" min="0.05" value="${strip.scale}"></label>
      <label class="tl-mini-field">Repeat <input type="number" id="nla-st-repeat" step="0.5" min="0.1" value="${strip.repeat}"></label>
      <label class="tl-mini-field">Blend
        <select id="nla-st-blend">
          <option value="replace" ${strip.blendMode === 'replace' ? 'selected' : ''}>Replace</option>
          <option value="add" ${strip.blendMode === 'add' ? 'selected' : ''}>Add</option>
          <option value="multiply" ${strip.blendMode === 'multiply' ? 'selected' : ''}>Multiply</option>
        </select>
      </label>
      <label class="tl-mini-field">Influence <input type="number" id="nla-st-inf" step="0.05" min="0" max="1" value="${strip.influence}"></label>
      <label class="tl-mini-field">Extrap
        <select id="nla-st-extrap">
          <option value="nothing" ${strip.extrapolate === 'nothing' ? 'selected' : ''}>Nothing</option>
          <option value="hold" ${strip.extrapolate === 'hold' ? 'selected' : ''}>Hold</option>
          <option value="hold_forward" ${strip.extrapolate === 'hold_forward' ? 'selected' : ''}>Hold Forward</option>
        </select>
      </label>
      <button type="button" class="tl-btn" id="nla-st-del" style="color:#ff8a80;">Delete Strip</button>
    `;

    bar.querySelector('#nla-st-start')?.addEventListener('change', (e) => this.engine.updateNLAStrip(target, tr.id, strip.id, { startFrame: Number(e.target.value) }));
    bar.querySelector('#nla-st-end')?.addEventListener('change', (e) => this.engine.updateNLAStrip(target, tr.id, strip.id, { endFrame: Number(e.target.value) }));
    bar.querySelector('#nla-st-scale')?.addEventListener('change', (e) => this.engine.updateNLAStrip(target, tr.id, strip.id, { scale: Number(e.target.value) }));
    bar.querySelector('#nla-st-repeat')?.addEventListener('change', (e) => this.engine.updateNLAStrip(target, tr.id, strip.id, { repeat: Number(e.target.value) }));
    bar.querySelector('#nla-st-blend')?.addEventListener('change', (e) => this.engine.updateNLAStrip(target, tr.id, strip.id, { blendMode: e.target.value }));
    bar.querySelector('#nla-st-inf')?.addEventListener('change', (e) => this.engine.updateNLAStrip(target, tr.id, strip.id, { influence: Number(e.target.value) }));
    bar.querySelector('#nla-st-extrap')?.addEventListener('change', (e) => this.engine.updateNLAStrip(target, tr.id, strip.id, { extrapolate: e.target.value }));
    bar.querySelector('#nla-st-del')?.addEventListener('click', () => {
      this.selectedNLAStrip = null;
      this.engine.removeNLAStrip(target, tr.id, strip.id);
    });
  }

  _renderDriversPanel() {
    const panel = this.elements.driversPanel;
    if (!panel) return;
    const target = this._getActiveTargetObject();
    const drivers = this.engine.getDrivers(target);
    const allObjs = this.sceneManager?.getAllObjects?.() || [];

    const propOptions = [
      'position.x', 'position.y', 'position.z',
      'rotation.x', 'rotation.y', 'rotation.z',
      'scale.x', 'scale.y', 'scale.z',
      'intensity', 'material.opacity', 'material.roughness', 'morphTargetInfluences.0'
    ];

    panel.innerHTML = `
      <div class="tl-drv-builder">
        <span class="tl-subbar-label">${target ? `Drivers on <b>${escapeHtml(target.name)}</b>` : 'Select Object to Add Driver'}</span>
        ${target ? `
          <select id="drv-target-prop" class="tl-select">${propOptions.map((p) => `<option value="${escapeHtml(p)}">${escapeHtml(p)}</option>`).join('')}</select>
          <input type="text" id="drv-expr-input" class="tl-drv-expr" value="sin(frame * 0.15) * 2" placeholder="Math expr (frame, time, var)">
          <span class="tl-subbar-label">Var <code>x</code>=</span>
          <select id="drv-var-obj" class="tl-select">
            <option value="">None</option>
            ${allObjs.map((o) => `<option value="${escapeHtml(o.uuid)}">${escapeHtml(o.name)}</option>`).join('')}
          </select>
          <select id="drv-var-prop" class="tl-select">${propOptions.slice(0, 9).map((p) => `<option value="${escapeHtml(p)}">${escapeHtml(p)}</option>`).join('')}</select>
          <button type="button" class="tl-btn tl-btn-accent" id="drv-btn-add">+ Add Driver</button>
          <span id="drv-builder-err" class="tl-drv-err"></span>
        ` : ''}
      </div>
      <div class="tl-drv-list">
        ${drivers.length === 0 ? '<div class="tl-empty-hint" style="padding:12px;">No Sandboxed Drivers on active object. Safe functions: sin, cos, clamp, lerp, smoothstep, abs, min, max, min/max/frame/time.</div>' : ''}
        ${drivers.map((d) => `
          <div class="tl-drv-row" data-drv-id="${escapeHtml(d.id)}">
            <input type="checkbox" class="drv-en" ${d.enabled ? 'checked' : ''} title="Enable Driver">
            <span class="tl-drv-prop">${d.boneName ? `${escapeHtml(d.boneName)}:` : ''}${escapeHtml(d.targetPath)}</span>
            <input type="text" class="tl-drv-row-expr" value="${escapeHtml(d.expression)}">
            <span class="tl-drv-val">= ${(Number(d.lastValue) || 0).toFixed(4)}</span>
            ${d.lastError ? `<span class="tl-drv-err">${escapeHtml(d.lastError)}</span>` : ''}
            <button type="button" class="tl-btn drv-del" title="Delete Driver">✕</button>
          </div>
        `).join('')}
      </div>
    `;

    panel.querySelector('#drv-btn-add')?.addEventListener('click', () => {
      const targetPath = panel.querySelector('#drv-target-prop')?.value || 'position.y';
      const expr = panel.querySelector('#drv-expr-input')?.value || '0';
      const varObjUuid = panel.querySelector('#drv-var-obj')?.value;
      const varProp = panel.querySelector('#drv-var-prop')?.value || 'position.x';
      const errEl = panel.querySelector('#drv-builder-err');
      try {
        const vars = varObjUuid ? [{ name: 'x', objectUuid: varObjUuid, propertyPath: varProp }] : [];
        this.engine.addDriver({ targetObject: target, targetPath, expression: expr, variables: vars });
        if (errEl) errEl.textContent = '';
      } catch (err) {
        if (errEl) errEl.textContent = err.message;
      }
    });

    panel.querySelectorAll('.tl-drv-row').forEach((row) => {
      const id = row.dataset.drvId;
      row.querySelector('.drv-en')?.addEventListener('change', (e) => {
        this.engine.updateDriver(id, { enabled: e.target.checked });
      });
      row.querySelector('.tl-drv-row-expr')?.addEventListener('change', (e) => {
        this.engine.updateDriver(id, { expression: e.target.value });
        this._renderDriversPanel();
      });
      row.querySelector('.drv-del')?.addEventListener('click', () => {
        this.engine.removeDriver(id);
      });
    });
  }

  _refreshDriverReadouts() {
    const panel = this.elements.driversPanel;
    if (!panel) return;
    const target = this._getActiveTargetObject();
    const drivers = this.engine.getDrivers(target);
    for (const d of drivers) {
      const row = panel.querySelector(`.tl-drv-row[data-drv-id="${d.id}"]`);
      const valEl = row?.querySelector('.tl-drv-val');
      if (valEl) valEl.textContent = `= ${(Number(d.lastValue) || 0).toFixed(4)}`;
    }
  }
}
