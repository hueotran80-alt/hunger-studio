/**
 * Web Blender Studio — Adaptive Viewport Navigation Governor ("Fast Orbit")
 * File: js/core/viewport-governor.js
 *
 * Automatically drops transient GPU fragment & geometry load during active mouse
 * camera navigation (Orbit / Pan / Wheel Zoom / Gizmo Drag) and crisply restores
 * 100% Retina resolution, LOD0 geometry, and studio post-processing 160 ms after
 * the pointer comes to rest:
 *   1. Dynamic PixelRatio scaling (`min(baseDpr, interactiveDprCap)` — up to 75% fewer fragment pixels on Retina)
 *   2. Transient GTAO / Bokeh DOF pass suspension (preserving OutputPass AgX tone mapping so brightness never flickers)
 *   3. Dynamic `lodBias` reduction (`0.42` while orbiting -> shifts distant trees/grass to coarser LODs immediately)
 *   4. Rolling FPS Emergency Governor: if sustained frame time exceeds 36 ms (< 28 FPS), keeps adaptive LOD bias engaged
 */

export class ViewportGovernor {
  /**
   * @param {Object} options
   * @param {import('./engine.js').Engine} [options.engine]
   * @param {boolean} [options.enabled=true]
   * @param {number} [options.interactiveDprCap=0.95]
   * @param {number} [options.interactiveLodBias=0.42]
   * @param {number} [options.settleDelayMs=160]
   */
  constructor(options = {}) {
    this.engine = options.engine || null;
    this.enabled = options.enabled !== false;
    this.interactiveDprCap = Number.isFinite(options.interactiveDprCap) ? options.interactiveDprCap : 0.95;
    this.interactiveLodBias = Number.isFinite(options.interactiveLodBias) ? options.interactiveLodBias : 0.42;
    this.settleDelayMs = Number.isFinite(options.settleDelayMs) ? Math.max(40, options.settleDelayMs) : 160;

    this.isNavigating = false;
    this._pointerOrbiting = false;
    this._settleTimer = null;
    this._savedDpr = null;
    this._savedPasses = null;

    // Rolling frame-time exponential moving average (ms)
    this.avgFrameMs = 16.6;
    this.lowFpsProtection = false;

    this._onControlStart = () => {
      this._pointerOrbiting = true;
      this.beginInteraction('orbit');
    };
    this._onControlChange = () => {
      if (this._pointerOrbiting || this.isNavigating) {
        this.touchInteraction();
      }
    };
    this._onControlEnd = () => {
      this._pointerOrbiting = false;
      this.scheduleSettle();
    };
    this._onWheel = () => {
      this.beginInteraction('wheel');
      this.scheduleSettle();
    };

    this._attachedControls = null;
    this._attachedDom = null;

    if (this.engine) {
      this.attach(this.engine);
    }
  }

  get isInteracting() {
    return this.isNavigating;
  }

  attach(engine = this.engine) {
    this.detach();
    this.engine = engine;
    const controls = engine?.controls;
    const dom = engine?.domElement;
    if (controls && typeof controls.addEventListener === 'function') {
      controls.addEventListener('start', this._onControlStart);
      controls.addEventListener('change', this._onControlChange);
      controls.addEventListener('end', this._onControlEnd);
      this._attachedControls = controls;
    }
    if (dom && typeof dom.addEventListener === 'function') {
      dom.addEventListener('wheel', this._onWheel, { passive: true });
      this._attachedDom = dom;
    }
  }

  syncControls() {
    if (this.engine) this.attach(this.engine);
  }

  detach() {
    if (this._settleTimer) {
      clearTimeout(this._settleTimer);
      this._settleTimer = null;
    }
    if (this.isNavigating) {
      this.settleNow(false);
    }
    if (this._attachedControls) {
      this._attachedControls.removeEventListener('start', this._onControlStart);
      this._attachedControls.removeEventListener('change', this._onControlChange);
      this._attachedControls.removeEventListener('end', this._onControlEnd);
      this._attachedControls = null;
    }
    if (this._attachedDom) {
      this._attachedDom.removeEventListener('wheel', this._onWheel);
      this._attachedDom = null;
    }
  }

  setEnabled(enabled) {
    const next = Boolean(enabled);
    if (this.enabled === next) return;
    this.enabled = next;
    if (!next && this.isNavigating) {
      this.settleNow(true);
    }
  }

  /**
   * Records a rendered frame delta (seconds) to track sustained frame-time pressure.
   * @param {number} deltaSec
   */
  recordFrame(deltaSec) {
    if (!Number.isFinite(deltaSec) || deltaSec <= 0 || deltaSec > 0.5) return;
    // Clamp one-off shader compilation spikes so a single frame cannot lock lowFpsProtection
    const ms = Math.min(75, deltaSec * 1000);
    this.avgFrameMs = this.avgFrameMs * 0.88 + ms * 0.12;
    if (this.avgFrameMs > 36) {
      this.lowFpsProtection = true;
    } else if (this.avgFrameMs < 24) {
      this.lowFpsProtection = false;
    }
  }

  /**
   * Effective LOD distance multiplier:
   *   - `1.0` when idle at healthy FPS (full crisp LOD0)
   *   - `0.42` while actively orbiting/zooming camera
   *   - `0.65` when sustained FPS < 28 even at rest
   */
  getEffectiveLodBias() {
    if (!this.enabled) return 1.0;
    if (this.isNavigating) return this.interactiveLodBias;
    if (this.lowFpsProtection) return 0.65;
    return 1.0;
  }

  beginInteraction(_reason = 'input') {
    if (!this.enabled || !this.engine?.renderer) return;
    if (this._settleTimer) {
      clearTimeout(this._settleTimer);
      this._settleTimer = null;
    }
    if (this.isNavigating) return;

    this.isNavigating = true;
    const renderer = this.engine.renderer;
    const currentDpr = typeof renderer.getPixelRatio === 'function' ? renderer.getPixelRatio() : 1;
    this._savedDpr = currentDpr;

    const targetDpr = Math.max(0.5, Math.min(currentDpr, this.interactiveDprCap));
    if (targetDpr < currentDpr - 0.02 && typeof renderer.setPixelRatio === 'function') {
      renderer.setPixelRatio(targetDpr);
      const post = this.engine.rasterRenderer?.postProcessing;
      if (post?.composer && typeof post.composer.setPixelRatio === 'function') {
        post.composer.setPixelRatio(targetDpr);
      }
    }

    // Suspend heavy screen-space AO & Bokeh passes while keeping OutputPass tone mapping intact
    const post = this.engine.rasterRenderer?.postProcessing;
    if (post && post.enabled) {
      this._savedPasses = {
        gtao: post.gtaoPass ? post.gtaoPass.enabled : false,
        bokeh: post.bokehPass ? post.bokehPass.enabled : false,
        preset: post.currentPreset,
      };
      if (post.gtaoPass) post.gtaoPass.enabled = false;
      if (post.bokehPass) post.bokehPass.enabled = false;
    }
  }

  touchInteraction() {
    if (!this.enabled) return;
    if (!this.isNavigating) {
      this.beginInteraction('change');
    }
    if (!this._pointerOrbiting) {
      this.scheduleSettle();
    }
  }

  scheduleSettle() {
    if (this._settleTimer) clearTimeout(this._settleTimer);
    this._settleTimer = setTimeout(() => {
      this._settleTimer = null;
      if (!this._pointerOrbiting) {
        this.settleNow(true);
      }
    }, this.settleDelayMs);
  }

  settleNow(requestCrispFrame = true) {
    if (this._settleTimer) {
      clearTimeout(this._settleTimer);
      this._settleTimer = null;
    }
    if (!this.isNavigating) return;
    this.isNavigating = false;
    // At rest, always restore crisp 1.0 LOD0 quality
    this.lowFpsProtection = false;
    this.avgFrameMs = Math.min(this.avgFrameMs, 16.6);

    const renderer = this.engine?.renderer;
    if (renderer && this._savedDpr != null && typeof renderer.setPixelRatio === 'function') {
      const targetDpr = typeof this.engine._getViewportPixelRatio === 'function'
        ? this.engine._getViewportPixelRatio()
        : this._savedDpr;
      renderer.setPixelRatio(targetDpr);
      const post = this.engine.rasterRenderer?.postProcessing;
      if (post?.composer && typeof post.composer.setPixelRatio === 'function') {
        post.composer.setPixelRatio(targetDpr);
      }
    }
    this._savedDpr = null;

    const post = this.engine?.rasterRenderer?.postProcessing;
    if (post && this._savedPasses) {
      // Respect user preset changes made during navigation instead of clobbering them
      if (this._savedPasses.preset === post.currentPreset) {
        if (post.gtaoPass) post.gtaoPass.enabled = this._savedPasses.gtao;
        if (post.bokehPass) post.bokehPass.enabled = this._savedPasses.bokeh;
      } else {
        post.applyPreset(post.currentPreset);
      }
    }
    this._savedPasses = null;

    if (requestCrispFrame) {
      this.engine?.requestRender?.();
    }
  }

  dispose() {
    this.detach();
    this.engine = null;
  }
}
