/**
 * @file shading-popover.js
 * @description Blender 4.x Viewport Shading & Environment Popover UI Controller.
 * Manages the floating popover menu for MatCap selection, HDRI Image-Based Lighting (IBL),
 * Lighting types (Studio, MatCap, Flat), Studio Cyclorama Backdrop, Atmospheric Fog, and Dynamic Sky Dome.
 */

export class ShadingPopoverUI {
  /**
   * @param {Object} options
   * @param {MatCapStudio} options.matcapStudio
   * @param {EnvironmentStudio} options.environmentStudio
   * @param {Object} options.app Main BlenderApp instance
   */
  constructor(options = {}) {
    this.matcapStudio = options.matcapStudio;
    this.environmentStudio = options.environmentStudio;
    this.app = options.app;

    this.isOpen = false;
    this.currentLightingType = 'studio'; // 'studio' | 'matcap' | 'flat'

    // DOM Elements
    this.triggerBtn = document.getElementById('btn-shading-popover');
    this.popoverEl = document.getElementById('viewport-shading-popover');
    this.matcapGrid = document.getElementById('matcap-grid');
    this.matcapActiveName = document.getElementById('matcap-active-name');
    this.closeBtn = document.getElementById('btn-popover-close');

    // Controls
    this.lightingButtons = document.querySelectorAll('#shading-lighting-type .popover-btn');
    this.rasterPresetButtons = document.querySelectorAll('#shading-raster-preset .popover-btn');
    this.checkFastOrbit = document.getElementById('check-fast-orbit');

    // HDRI Environment Controls
    this.checkHdri = document.getElementById('check-hdri-environment');
    this.hdriOptions = document.getElementById('hdri-options');
    this.selectHdriPreset = document.getElementById('select-hdri-preset');
    this.hdriPresetButtons = document.querySelectorAll('#hdri-preset-pills .preset-pill');
    this.checkHdriAsBg = document.getElementById('check-hdri-as-bg');
    this.sliderHdriIntensity = document.getElementById('slider-hdri-intensity');
    this.valHdriIntensity = document.getElementById('val-hdri-intensity');
    this.sliderHdriBlur = document.getElementById('slider-hdri-blur');
    this.valHdriBlur = document.getElementById('val-hdri-blur');
    this.sliderHdriRotation = document.getElementById('slider-hdri-rotation');
    this.valHdriRotation = document.getElementById('val-hdri-rotation');
    this.btnLoadHdri = document.getElementById('btn-load-hdri');
    this.inputLoadHdri = document.getElementById('input-load-hdri');

    // Backdrop controls
    this.checkBackdrop = document.getElementById('check-studio-backdrop');
    this.backdropOptions = document.getElementById('backdrop-options');
    this.backdropPresetButtons = document.querySelectorAll('#backdrop-preset-row .preset-pill');
    this.checkShadowCatcher = document.getElementById('check-shadow-catcher');

    // Fog controls
    this.checkFog = document.getElementById('check-atmospheric-fog');
    this.fogOptions = document.getElementById('fog-options');
    this.selectFogPreset = document.getElementById('select-fog-preset');
    this.sliderFogDist = document.getElementById('slider-fog-distance');
    this.valFogDist = document.getElementById('val-fog-distance');

    // Sky controls
    this.checkSky = document.getElementById('check-sky-dome');
    this.skyOptions = document.getElementById('sky-options');
    this.sliderSunElev = document.getElementById('slider-sun-elevation');
    this.valSunElev = document.getElementById('val-sun-elevation');
    this.sliderSunAzim = document.getElementById('slider-sun-azimuth');
    this.valSunAzim = document.getElementById('val-sun-azimuth');

    this._matcapThumbnailsBuilt = false;
    this.init();
  }

  init() {
    this._bindEvents();
    this._updateActiveStates();
  }

  /**
   * Generates spherical swatch buttons inside the grid for all styles
   * @private
   */
  _buildMatCapThumbnails() {
    if (!this.matcapGrid || !this.matcapStudio) return;

    this.matcapGrid.innerHTML = '';
    const styles = this.matcapStudio.getAvailableStyles();
    const activeStyle = this.matcapStudio.getActiveStyle();

    styles.forEach(style => {
      const item = document.createElement('button');
      item.className = `matcap-item ${style.id === activeStyle ? 'active' : ''}`;
      item.dataset.styleId = style.id;
      item.title = `${style.name} - ${style.description}`;

      const img = document.createElement('img');
      img.className = 'matcap-thumb-img';
      img.alt = style.name;
      img.src = style.preview;

      const label = document.createElement('span');
      label.className = 'matcap-thumb-label';
      label.textContent = style.name;

      item.appendChild(img);
      item.appendChild(label);

      item.addEventListener('click', (e) => {
        e.stopPropagation();
        this.selectMatCap(style.id);
      });

      this.matcapGrid.appendChild(item);
    });

    if (this.matcapActiveName) {
      const current = styles.find(s => s.id === activeStyle);
      this.matcapActiveName.textContent = current ? current.name : 'Red Wax';
    }
  }

  /**
   * Binds UI event listeners
   * @private
   */
  _bindEvents() {
    // Toggle popover visibility
    this.triggerBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.togglePopover();
    });

    // Close button
    this.closeBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.closePopover();
    });

    // Dismiss when clicking outside
    this._onDocPointerDown = (e) => {
      if (this.isOpen && this.popoverEl && !this.popoverEl.contains(e.target) && !this.triggerBtn?.contains(e.target)) {
        this.closePopover();
      }
    };
    document.addEventListener('pointerdown', this._onDocPointerDown);

    // Prevent clicks inside popover from propagating to viewport raycaster
    this.popoverEl?.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
    });

    // Lighting Type Buttons
    this.lightingButtons.forEach(btn => {
      btn.addEventListener('click', () => {
        this.lightingButtons.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const type = btn.dataset.type;
        this.setLightingType(type);
      });
    });

    // Raster Look-Dev Preset Buttons (Fast / Studio / Cinematic)
    this.rasterPresetButtons?.forEach(btn => {
      btn.addEventListener('click', () => {
        this.rasterPresetButtons.forEach(b => b.classList.toggle('active', b === btn));
        const preset = btn.dataset.preset;
        if (this.app?.engine?.rasterRenderer) {
          this.app.engine.rasterRenderer.setPreset(preset);
          if (this.app.sceneManager?.requestRender) this.app.sceneManager.requestRender();
        }
      });
    });

    // Fast Orbit (Dynamic DPR + LOD Bias while orbiting/zooming)
    this.checkFastOrbit?.addEventListener('change', (e) => {
      const enabled = Boolean(e.target.checked);
      this.app?.engine?.viewportGovernor?.setEnabled?.(enabled);
    });

    // =========================================================================
    // HDRI ENVIRONMENT (IBL) EVENTS
    // =========================================================================

    // HDRI Enable Toggle
    this.checkHdri?.addEventListener('change', (e) => {
      const enabled = e.target.checked;
      if (this.hdriOptions) {
        this.hdriOptions.style.display = enabled ? 'flex' : 'none';
      }
      this.environmentStudio?.enableHdri(enabled);
    });

    // HDRI Preset Dropdown
    this.selectHdriPreset?.addEventListener('change', (e) => {
      const presetKey = e.target.value;
      this.selectHdri(presetKey);
    });

    // HDRI Preset Pills
    this.hdriPresetButtons.forEach(btn => {
      btn.addEventListener('click', () => {
        const presetKey = btn.dataset.hdri;
        this.selectHdri(presetKey);
      });
    });

    // HDRI as Viewport Background Toggle
    this.checkHdriAsBg?.addEventListener('change', (e) => {
      this.environmentStudio?.toggleHdriBackground(e.target.checked);
    });

    // HDRI Environment Intensity Slider
    this.sliderHdriIntensity?.addEventListener('input', (e) => {
      const val = parseFloat(e.target.value);
      if (this.valHdriIntensity) this.valHdriIntensity.textContent = val.toFixed(1);
      this.environmentStudio?.setEnvironmentIntensity(val);
    });

    // HDRI Background Blur Slider
    this.sliderHdriBlur?.addEventListener('input', (e) => {
      const val = parseFloat(e.target.value);
      if (this.valHdriBlur) this.valHdriBlur.textContent = val.toFixed(2);
      this.environmentStudio?.setBackgroundBlurriness(val);
    });

    // HDRI Rotation Slider
    this.sliderHdriRotation?.addEventListener('input', (e) => {
      const val = parseInt(e.target.value, 10);
      if (this.valHdriRotation) this.valHdriRotation.textContent = `${val}°`;
      this.environmentStudio?.setEnvironmentRotation(val);
    });

    // Custom HDRI File Load (Task 4.1)
    this.btnLoadHdri?.addEventListener('click', () => {
      this.inputLoadHdri?.click();
    });
    this.inputLoadHdri?.addEventListener('change', (e) => {
      const file = e.target.files?.[0];
      if (file && this.environmentStudio) {
        this.environmentStudio.loadHDRFile(file);
      }
    });

    // Studio Backdrop Toggle
    this.checkBackdrop?.addEventListener('change', (e) => {
      const enabled = e.target.checked;
      if (this.backdropOptions) {
        this.backdropOptions.style.display = enabled ? 'flex' : 'none';
      }
      this.environmentStudio?.enableBackdrop(enabled);
    });

    // Backdrop Preset Pills
    this.backdropPresetButtons.forEach(btn => {
      btn.addEventListener('click', () => {
        this.backdropPresetButtons.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const color = btn.dataset.color;
        this.environmentStudio?.setBackdropColor(color);
      });
    });

    // Shadow Catcher Toggle
    this.checkShadowCatcher?.addEventListener('change', (e) => {
      this.environmentStudio?.enableShadowCatcher?.(e.target.checked);
    });

    // Atmospheric Fog Toggle
    this.checkFog?.addEventListener('change', (e) => {
      const enabled = e.target.checked;
      if (this.fogOptions) {
        this.fogOptions.style.display = enabled ? 'flex' : 'none';
      }
      this.environmentStudio?.enableFog(enabled);
    });

    // Fog Preset Dropdown
    this.selectFogPreset?.addEventListener('change', (e) => {
      const presetKey = e.target.value;
      this.environmentStudio?.setFogPreset(presetKey);
    });

    // Fog Distance Slider
    this.sliderFogDist?.addEventListener('input', (e) => {
      const dist = Number(e.target.value);
      if (this.valFogDist) this.valFogDist.textContent = dist;
      this.environmentStudio?.updateFog({ far: dist });
    });

    // Dynamic Sky Dome Toggle
    this.checkSky?.addEventListener('change', (e) => {
      const enabled = e.target.checked;
      if (this.skyOptions) {
        this.skyOptions.style.display = enabled ? 'flex' : 'none';
      }
      this.environmentStudio?.enableSky(enabled);
    });

    // Sun Elevation Slider
    this.sliderSunElev?.addEventListener('input', (e) => {
      const val = Number(e.target.value);
      if (this.valSunElev) this.valSunElev.textContent = `${val}°`;
      this.environmentStudio?.setSunPosition({ elevation: val });
    });

    // Sun Azimuth Slider
    this.sliderSunAzim?.addEventListener('input', (e) => {
      const val = Number(e.target.value);
      if (this.valSunAzim) this.valSunAzim.textContent = `${val}°`;
      this.environmentStudio?.setSunPosition({ azimuth: val });
    });

    // External listener: MatCap style changes
    this.matcapStudio?.on('styleChanged', ({ style }) => {
      this._updateActiveMatCapUI(style);
    });

    // External listener: HDRI preset changes
    this.environmentStudio?.on('hdriPresetChanged', ({ preset }) => {
      this._updateActiveHdriUI(preset);
    });
  }

  /**
   * Selects and activates an HDRI environment preset
   * @param {string} presetKey
   */
  selectHdri(presetKey) {
    if (!this.environmentStudio) return;

    this.environmentStudio.setHdriPreset(presetKey);
    this._updateActiveHdriUI(presetKey);

    // If currently in studio lighting mode or rendered/material preview, request render
    if (typeof window !== 'undefined' && window.engine?.sceneManager?.requestRender) {
      window.engine.sceneManager.requestRender();
    }
  }

  /**
   * Updates UI pills and dropdown to reflect active HDRI preset
   * @private
   */
  _updateActiveHdriUI(activePresetKey) {
    if (this.selectHdriPreset) {
      this.selectHdriPreset.value = activePresetKey;
    }
    this.hdriPresetButtons.forEach(btn => {
      btn.classList.toggle('active', btn.dataset.hdri === activePresetKey);
    });
  }

  /**
   * Activates a MatCap style and updates scene
   * @param {string} styleId
   */
  selectMatCap(styleId) {
    if (!this.matcapStudio) return;

    // Switch lighting type button to matcap
    this.lightingButtons.forEach(b => {
      b.classList.toggle('active', b.dataset.type === 'matcap');
    });
    this.currentLightingType = 'matcap';

    // Switch Viewport Shading pill to 'Solid' if in wireframe or material preview
    const solidPill = document.getElementById('shading-solid');
    if (solidPill) {
      document.querySelectorAll('.shading-pill-btn').forEach(b => b.classList.remove('active'));
      solidPill.classList.add('active');
    }

    // Apply matcap
    this.matcapStudio.toggleMatCapMode(true, styleId);
    this._updateActiveMatCapUI(styleId);
  }

  /**
   * Sets viewport lighting type: Studio (PBR) vs MatCap vs Flat
   * @param {string} type 'studio' | 'matcap' | 'flat'
   */
  setLightingType(type) {
    this.currentLightingType = type;
    const matcapSection = document.getElementById('section-matcap-palette');

    if (type === 'matcap') {
      if (matcapSection) matcapSection.style.opacity = '1';
      this.app?._setMeshFlatLighting?.(false);
      this.matcapStudio?.toggleMatCapMode(true);
    } else if (type === 'studio') {
      if (matcapSection) matcapSection.style.opacity = '0.5';
      this.app?._setMeshFlatLighting?.(false);
      this.matcapStudio?.toggleMatCapMode(false);
      if (this.environmentStudio && !this.environmentStudio.hdriEnabled) {
        this.environmentStudio.enableHdri(true);
      }
    } else if (type === 'flat') {
      if (matcapSection) matcapSection.style.opacity = '0.5';
      this.matcapStudio?.toggleMatCapMode(false);
      this.app?._setMeshFlatLighting?.(true);
    }
  }

  /**
   * Updates active state classes on thumbnails
   * @private
   */
  _updateActiveMatCapUI(activeStyleId) {
    const items = this.matcapGrid?.querySelectorAll('.matcap-item');
    items?.forEach(item => {
      item.classList.toggle('active', item.dataset.styleId === activeStyleId);
    });

    if (this.matcapActiveName && this.matcapStudio) {
      const styles = this.matcapStudio.styles || this.matcapStudio.getAvailableStyles();
      const current = styles.find(s => s.id === activeStyleId);
      if (current) this.matcapActiveName.textContent = current.name;
    }
  }

  /**
   * Synchronizes UI switches with current studio states
   * @private
   */
  _updateActiveStates() {
    if (this.environmentStudio) {
      if (this.checkHdri) this.checkHdri.checked = this.environmentStudio.hdriEnabled;
      if (this.checkHdriAsBg) this.checkHdriAsBg.checked = this.environmentStudio.showHdriBackground;
      if (this.sliderHdriIntensity) {
        this.sliderHdriIntensity.value = this.environmentStudio.environmentIntensity;
        if (this.valHdriIntensity) this.valHdriIntensity.textContent = Number(this.environmentStudio.environmentIntensity).toFixed(1);
      }
      if (this.sliderHdriBlur) {
        this.sliderHdriBlur.value = this.environmentStudio.backgroundBlurriness;
        if (this.valHdriBlur) this.valHdriBlur.textContent = Number(this.environmentStudio.backgroundBlurriness).toFixed(2);
      }
      if (this.sliderHdriRotation) {
        this.sliderHdriRotation.value = this.environmentStudio.environmentRotation;
        if (this.valHdriRotation) this.valHdriRotation.textContent = `${this.environmentStudio.environmentRotation}°`;
      }
      this._updateActiveHdriUI(this.environmentStudio.currentHdriPreset);

      if (this.checkBackdrop) this.checkBackdrop.checked = this.environmentStudio.backdropEnabled;
      if (this.checkShadowCatcher) this.checkShadowCatcher.checked = Boolean(this.environmentStudio.shadowCatcherEnabled);
      if (this.checkFog) this.checkFog.checked = this.environmentStudio.fogEnabled;
      if (this.checkSky) this.checkSky.checked = this.environmentStudio.skyEnabled;
    }
    if (this.checkFastOrbit && this.app?.engine?.viewportGovernor) {
      this.checkFastOrbit.checked = Boolean(this.app.engine.viewportGovernor.enabled);
    }
  }

  togglePopover() {
    if (this.isOpen) {
      this.closePopover();
    } else {
      this.openPopover();
    }
  }

  openPopover() {
    this.isOpen = true;
    if (!this._matcapThumbnailsBuilt) {
      this._buildMatCapThumbnails();
      this._matcapThumbnailsBuilt = true;
    }
    if (this.popoverEl) {
      this.popoverEl.classList.add('visible');
      this.popoverEl.style.display = 'block';

      // Anchor under the trigger, clamped inside the viewport so the panel
      // stays reachable on narrow windows instead of overflowing off-screen.
      const margin = 8;
      const triggerRect = this.triggerBtn?.getBoundingClientRect();
      const width = this.popoverEl.offsetWidth || 250;
      let left = triggerRect ? triggerRect.right - width : margin;
      let top = triggerRect ? triggerRect.bottom + 6 : 60;
      left = Math.max(margin, Math.min(left, window.innerWidth - width - margin));
      top = Math.max(margin, Math.min(top, window.innerHeight - margin - 160));
      this.popoverEl.style.position = 'fixed';
      this.popoverEl.style.boxSizing = 'border-box';
      this.popoverEl.style.left = `${left}px`;
      this.popoverEl.style.right = 'auto';
      this.popoverEl.style.top = `${top}px`;

      // `position: fixed` is relative to a transformed ancestor in some layouts,
      // so correct using the real painted rect before capping the height.
      const rect = this.popoverEl.getBoundingClientRect();
      if (rect.right > window.innerWidth - margin) left -= rect.right - (window.innerWidth - margin);
      if (rect.left < margin) left += margin - rect.left;
      if (rect.bottom > window.innerHeight - margin) top -= rect.bottom - (window.innerHeight - margin);
      if (rect.top < margin) top += margin - rect.top;
      this.popoverEl.style.left = `${left}px`;
      this.popoverEl.style.top = `${top}px`;

      const finalRect = this.popoverEl.getBoundingClientRect();
      this.popoverEl.style.maxHeight = `${Math.max(160, window.innerHeight - finalRect.top - margin)}px`;
      this.popoverEl.style.overflowY = 'auto';
    }
    this.triggerBtn?.classList.add('active');
  }

  closePopover() {
    this.isOpen = false;
    if (this.popoverEl) {
      this.popoverEl.classList.remove('visible');
      this.popoverEl.style.display = 'none';
    }
    this.triggerBtn?.classList.remove('active');
  }

  dispose() {
    if (this._onDocPointerDown) {
      document.removeEventListener('pointerdown', this._onDocPointerDown);
      this._onDocPointerDown = null;
    }
  }
}
