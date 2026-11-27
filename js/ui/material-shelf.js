/**
 * Web Blender Studio - Material Shelf Component (PBR Asset Browser)
 * Provides visual 1-click material assignment with category tabs & preview spheres.
 * File: js/ui/material-shelf.js
 */

export class MaterialShelf {
  constructor(container, options = {}) {
    this.container = typeof container === 'string' ? document.querySelector(container) : container;
    this.materialStudio = options.materialStudio || null;
    this.sceneManager = options.sceneManager || null;
    this.selectedPreset = null;

    this._initUI();
  }

  _initUI() {
    if (!this.container) return;

    this.panel = document.createElement('div');
    this.panel.className = 'blender-material-shelf';
    this.panel.id = 'blender-material-shelf';
    this.activeTab = 'presets';
    this.panel.innerHTML = `
      <div class="shelf-header">
        <div class="shelf-title" style="display:flex;align-items:center;gap:6px;">
          <span>PBR Materials</span>
          <button type="button" class="shelf-tab-btn active" data-tab="presets" style="font-size:10px;padding:2px 6px;border-radius:3px;border:1px solid #444;background:#2f3542;color:#e5e7eb;cursor:pointer;">Presets (24)</button>
          <button type="button" class="shelf-tab-btn" data-tab="procedural" style="font-size:10px;padding:2px 6px;border-radius:3px;border:1px solid #444;background:#1c1f26;color:#9ca3af;cursor:pointer;">Arch Procedural (9)</button>
        </div>
        <div class="shelf-actions">
          <button class="shelf-btn-minimize" id="btn-minimize-mat-shelf" title="Minimize / Expand">_</button>
        </div>
      </div>
      <div class="shelf-body" id="mat-shelf-body">
        <div class="material-grid" id="material-grid"></div>
      </div>
    `;

    this.container.appendChild(this.panel);
    this.panel.querySelectorAll('.shelf-tab-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.activeTab = btn.dataset.tab;
        this.panel.querySelectorAll('.shelf-tab-btn').forEach((b) => {
          const active = b.dataset.tab === this.activeTab;
          b.classList.toggle('active', active);
          b.style.background = active ? '#2f3542' : '#1c1f26';
          b.style.color = active ? '#e5e7eb' : '#9ca3af';
        });
        this.renderPresets();
      });
    });
    this.renderPresets();
    this._bindEvents();
  }

  renderPresets() {
    if (!this.materialStudio) return;
    const grid = this.panel.querySelector('#material-grid');
    if (!grid) return;

    grid.innerHTML = '';
    if (this.activeTab === 'procedural') {
      const procRecipes = [
        { pattern: 'weathered_concrete', name: 'Weathered Concrete', category: 'Arch PBR', swatch: 'linear-gradient(135deg,#6e727a,#3f434a,#23262b)' },
        { pattern: 'ashlar_stone', name: 'Ashlar Stone', category: 'Arch PBR', swatch: 'linear-gradient(135deg,#9ca3af,#6b7280,#374151)' },
        { pattern: 'clay_roof_tiles', name: 'Clay Roof Tiles', category: 'Arch PBR', swatch: 'linear-gradient(135deg,#bc553a,#7e301d)' },
        { pattern: 'roof_slates', name: 'Roof Slates', category: 'Arch PBR', swatch: 'linear-gradient(135deg,#475569,#1e293b)' },
        { pattern: 'stucco_plaster', name: 'Stucco Plaster', category: 'Arch PBR', swatch: 'linear-gradient(135deg,#f3eee4,#d6cfc0)' },
        { pattern: 'wood_grain', name: 'Wood Grain', category: 'Arch PBR', swatch: 'linear-gradient(135deg,#78350f,#451a03)' },
        { pattern: 'checkered_marble', name: 'Checkered Marble', category: 'Arch PBR', swatch: 'conic-gradient(#e5e7eb 90deg,#1f2937 90deg 180deg,#e5e7eb 180deg 270deg,#1f2937 270deg)' },
        { pattern: 'mullioned_glass', name: 'Mullioned Glass', category: 'Arch PBR', swatch: 'linear-gradient(135deg,#f1f5f9 15%,#1e293b 15%,#1e293b 85%,#f1f5f9 85%)' },
        { pattern: 'stained_mosaic', name: 'Stained Mosaic', category: 'Arch PBR', swatch: 'linear-gradient(135deg,#b91c1c,#1d4ed8,#d97706,#047857)' },
      ];
      procRecipes.forEach((rec) => {
        const card = document.createElement('div');
        card.className = 'material-card';
        card.dataset.pattern = rec.pattern;
        card.title = `Generate async 1K Procedural PBR: ${rec.name} (Albedo sRGB + Normal/Roughness linear PNG)`;
        card.innerHTML = `
          <div class="material-card-swatch" style="width:26px;height:26px;border-radius:4px;background:${rec.swatch};box-shadow:inset -1px -2px 4px rgba(0,0,0,0.45);margin-bottom:4px;"></div>
          <div class="material-card-name">${rec.name}</div>
          <div class="material-card-category">${rec.category}</div>
        `;
        card.addEventListener('click', async () => {
          const selected = this.sceneManager?.getSelectedObjects?.() || [];
          const target = selected[0] || this.sceneManager?.activeSelection;
          if (!target || typeof window === 'undefined' || !window.studio?.applyProceduralPBR) return;
          this._archPbrAbort?.abort?.();
          const ac = new AbortController();
          this._archPbrAbort = ac;
          const gen = (this._archPbrGen = (this._archPbrGen || 0) + 1);
          card.style.opacity = '0.55';
          try {
            await window.studio.applyProceduralPBR(target, { pattern: rec.pattern, resolution: 512, signal: ac.signal });
          } catch (err) {
            if (err?.name !== 'AbortError') throw err;
          } finally {
            if (gen === this._archPbrGen) {
              this._archPbrAbort = null;
            }
            card.style.opacity = '1';
          }
        });
        grid.appendChild(card);
      });
      return;
    }
    const presets = this.materialStudio.getMaterialPresets();

    const defaultSwatches = {
      skin_realistic: 'radial-gradient(circle at 35% 30%, #ffe4d6, #e8beac 65%, #9c6b56)',
      skin_tan: 'radial-gradient(circle at 35% 30%, #e0a989, #b57a58 65%, #6e4228)',
      gold_24k: 'radial-gradient(circle at 35% 30%, #fffbeb, #fbbf24 55%, #92400e)',
      chrome_mirror: 'radial-gradient(circle at 35% 30%, #ffffff, #cbd5e1 50%, #334155)',
      brushed_titanium: 'radial-gradient(circle at 35% 30%, #e2e8f0, #94a3b8 60%, #334155)',
      car_paint_red: 'radial-gradient(circle at 35% 30%, #fda4af, #e11d48 55%, #4c0519)',
      glass_crystal: 'radial-gradient(circle at 35% 30%, #ffffff, #bae6fd 60%, #0284c7)',
      water_surface: 'radial-gradient(circle at 35% 30%, #a5f3fc, #06b6d4 65%, #164e63)',
      carbon_fiber: 'radial-gradient(circle at 35% 30%, #64748b, #1e293b 65%, #090d16)',
      wood_polished: 'radial-gradient(circle at 35% 30%, #d97706, #92400e 65%, #451a03)',
      marble_white: 'radial-gradient(circle at 35% 30%, #ffffff, #e2e8f0 70%, #94a3b8)',
      fabric_velvet: 'radial-gradient(circle at 35% 30%, #d8b4fe, #6b21a8 65%, #2e1065)',
      leather_black: 'radial-gradient(circle at 35% 30%, #52525b, #18181b 70%, #09090b)',
      neon_cyan: 'radial-gradient(circle at 35% 30%, #ffffff, #22d3ee 55%, #0891b2)'
    };

    Object.entries(presets).forEach(([key, preset]) => {
      const card = document.createElement('div');
      card.className = 'material-card';
      card.dataset.key = key;
      card.title = `Apply material: ${preset.name} (${preset.category})`;
      const bg = preset.swatch || defaultSwatches[key] || 'radial-gradient(circle at 35% 30%, #e2e8f0, #64748b)';

      card.innerHTML = `
        <div class="material-card-swatch" style="width: 26px; height: 26px; border-radius: 50%; background: ${bg}; box-shadow: inset -2px -3px 6px rgba(0,0,0,0.45), 0 2px 5px rgba(0,0,0,0.35); margin-bottom: 4px;"></div>
        <div class="material-card-name">${preset.name.split('(')[0].trim()}</div>
        <div class="material-card-category">${preset.category}</div>
      `;

      card.addEventListener('click', () => {
        this.applySelectedMaterial(key);
      });

      grid.appendChild(card);
    });
  }

  applySelectedMaterial(presetKey) {
    if (!this.materialStudio) return;

    // Highlight card
    const cards = this.panel.querySelectorAll('.material-card');
    cards.forEach(c => c.classList.toggle('active', c.dataset.key === presetKey));

    // Get active selection from SceneManager or Engine
    const sm = this.sceneManager || (typeof window !== 'undefined' ? window.sceneManager : null);
    const target = sm ? (sm.getActiveObject ? sm.getActiveObject() : sm.activeSelection) : null;

    if (!target) {
      if (typeof window !== 'undefined' && window.codeEditor) {
        window.codeEditor.log('warn', `⚠️ Select an object in the 3D Viewport before assigning material "${presetKey}".`);
      }
      return;
    }

    if (typeof window !== 'undefined' && window.matcapStudio?.isMatCapActive) {
      if (typeof window.app?.setShadingMode === 'function') {
        window.app.setShadingMode('material');
      } else {
        window.matcapStudio.toggleMatCapMode(false);
      }
    }

    const appliedMat = this.materialStudio.applyPreset(target, presetKey);
    if (appliedMat && typeof window !== 'undefined' && window.codeEditor) {
      window.codeEditor.log('success', `✓ Applied material [${presetKey}] to "${target.name || 'Object'}".`);
    }

    // Refresh Inspector
    if (typeof window !== 'undefined' && window.inspector) {
      window.inspector.update(target);
    }
  }

  _bindEvents() {
    const btnMin = this.panel.querySelector('#btn-minimize-mat-shelf');
    const body = this.panel.querySelector('#mat-shelf-body');
    if (btnMin && body) {
      btnMin.addEventListener('click', () => {
        const isCollapsed = body.classList.toggle('collapsed');
        btnMin.textContent = isCollapsed ? '▲' : '_';
      });
    }
  }
}

export default MaterialShelf;
