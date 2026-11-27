/**
 * Web Blender Studio - Export Options Dialog (glTF / GLB Commercial Optimizer UI)
 * Opens from File -> Export -> glTF / GLB Options...
 * Uses shared `inspectSceneBudget()` and `StudioExporter.exportGLTF()` options.
 * File: js/ui/export-dialog.js
 */
import { inspectSceneBudget } from '../core/scene-budget.js';

const EXPORT_PRESETS = {
  web_share: {
    label: 'Web Share (Balanced)',
    textureFormat: 'auto',
    lossyDataMaps: false,
    maxTextureSize: 1024,
    indexGeometries: true,
    deduplicateMaterials: true,
    tier: 'architecture',
  },
  mobile_fast: {
    label: 'Mobile / Fast Embed',
    textureFormat: 'auto',
    lossyDataMaps: false,
    maxTextureSize: 512,
    indexGeometries: true,
    deduplicateMaterials: true,
    tier: 'product',
  },
  dcc_lossless: {
    label: 'DCC / Archive Lossless',
    textureFormat: 'png',
    lossyDataMaps: false,
    maxTextureSize: 2048,
    indexGeometries: true,
    deduplicateMaterials: false,
    tier: 'architecture',
  },
};

export class ExportOptionsDialog {
  constructor(app) {
    this.app = app;
    this.overlay = null;
    this._busy = false;
  }

  open() {
    this._prevFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (this.overlay) {
      this._refreshBudget();
      this.overlay.hidden = false;
      this.overlay.style.display = 'flex';
    } else {
      this._buildDom();
      this._refreshBudget();
    }
    const runBtn = this.overlay?.querySelector('#exp-dlg-run');
    const statusHint = this.overlay?.querySelector('#exp-dlg-status');
    if (runBtn) {
      if (this.app?.exporter?._exportInProgress) {
        runBtn.textContent = 'Exporting...';
        runBtn.disabled = true;
        if (statusHint) statusHint.textContent = '⏳ Previous export is finishing cleanup… button will re-enable automatically.';
      } else {
        runBtn.textContent = 'Export Model';
        runBtn.disabled = false;
        if (statusHint) statusHint.textContent = '';
      }
    }
    if (!this._boundSettled) {
      this._boundSettled = () => {
        const btn = this.overlay?.querySelector('#exp-dlg-run');
        const hint = this.overlay?.querySelector('#exp-dlg-status');
        if (btn && !this._busy && !this.app?.exporter?._exportInProgress) {
          btn.textContent = 'Export Model';
          btn.disabled = false;
          if (hint) hint.textContent = '';
        }
      };
      window.addEventListener('studio:exportSettled', this._boundSettled);
    }
    if (!this._boundKeyDown) {
      this._boundKeyDown = (e) => this._onDialogKeyDown(e);
      window.addEventListener('keydown', this._boundKeyDown, true);
    }
    const focusFirst = this.overlay?.querySelector('#exp-dlg-preset, button, select, input');
    focusFirst?.focus?.();
  }

  close() {
    if (this._busy || this._exportAbort) {
      this._exportCancelGen = (this._exportCancelGen || 0) + 1;
      try { this._exportAbort?.abort?.(); } catch (_) {}
      this._exportAbort = null;
      this._busy = false;
      const runBtn = this.overlay?.querySelector('#exp-dlg-run');
      if (runBtn && !this.app?.exporter?._exportInProgress) {
        runBtn.textContent = 'Export Model';
        runBtn.disabled = false;
      }
    }
    if (this._boundKeyDown) {
      window.removeEventListener('keydown', this._boundKeyDown, true);
      this._boundKeyDown = null;
    }
    if (this.overlay) {
      this.overlay.hidden = true;
      this.overlay.style.display = 'none';
    }
    if (this._prevFocus && typeof this._prevFocus.focus === 'function' && document.contains(this._prevFocus)) {
      this._prevFocus.focus();
    }
    this._prevFocus = null;
  }

  _onDialogKeyDown(e) {
    if (!this.overlay || this.overlay.hidden) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopImmediatePropagation();
      this.close();
      return;
    }
    if (e.key === 'Tab') {
      const focusables = [...this.overlay.querySelectorAll('button:not([disabled]), select:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])')];
      if (!focusables.length) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  }

  _buildDom() {
    const overlay = document.createElement('div');
    overlay.id = 'hunger-export-options-overlay';
    overlay.className = 'wbs-modal-backdrop';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', 'Export glTF / GLB Options');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(10,12,16,0.68);z-index:9990;display:flex;align-items:center;justify-content:center;font-family:Inter,system-ui,sans-serif;';
    overlay.innerHTML = `
      <div style="width:460px;max-width:94vw;background:#23252b;color:#e5e7eb;border:1px solid #3c404b;border-radius:8px;box-shadow:0 20px 50px rgba(0,0,0,0.55);overflow:hidden;">
        <div style="display:flex;align-items:center;justify-content:space-between;padding:12px 16px;background:#1b1d22;border-bottom:1px solid #323640;">
          <strong style="font-size:13px;letter-spacing:0.2px;">Export glTF / GLB Options</strong>
          <button id="exp-dlg-close" style="background:none;border:none;color:#9ca3af;cursor:pointer;font-size:16px;">&times;</button>
        </div>
        <div style="padding:14px 16px;display:flex;flex-direction:column;gap:11px;font-size:12px;">
          <label style="display:flex;justify-content:space-between;align-items:center;gap:8px;">
            <span>Preset</span>
            <select id="exp-dlg-preset" style="width:230px;background:#181a1f;color:#e5e7eb;border:1px solid #3c404b;border-radius:4px;padding:5px 8px;">
              <option value="web_share">Web Share (Color JPEG + Data PNG, 1024px)</option>
              <option value="mobile_fast">Mobile / Fast Embed (512px)</option>
              <option value="dcc_lossless">DCC / Archive Lossless (All PNG, 2048px)</option>
            </select>
          </label>
          <label style="display:flex;justify-content:space-between;align-items:center;gap:8px;">
            <span>Format</span>
            <select id="exp-dlg-binary" style="width:230px;background:#181a1f;color:#e5e7eb;border:1px solid #3c404b;border-radius:4px;padding:5px 8px;">
              <option value="glb">Binary glTF (.glb)</option>
              <option value="gltf">JSON glTF (.gltf)</option>
            </select>
          </label>
          <label style="display:flex;justify-content:space-between;align-items:center;gap:8px;">
            <span>Texture Encoding</span>
            <select id="exp-dlg-texfmt" style="width:230px;background:#181a1f;color:#e5e7eb;border:1px solid #3c404b;border-radius:4px;padding:5px 8px;">
              <option value="auto">Auto (JPEG Color + Lossless PNG Data)</option>
              <option value="png">Lossless PNG (All Maps)</option>
            </select>
          </label>
          <label style="display:flex;justify-content:space-between;align-items:center;gap:8px;">
            <span>Max Texture Size</span>
            <select id="exp-dlg-maxtex" style="width:230px;background:#181a1f;color:#e5e7eb;border:1px solid #3c404b;border-radius:4px;padding:5px 8px;">
              <option value="512">512 px</option>
              <option value="1024" selected>1024 px</option>
              <option value="2048">2048 px</option>
            </select>
          </label>
          <div style="display:flex;flex-direction:column;gap:6px;padding:8px 10px;background:#1b1d22;border-radius:5px;border:1px solid #2e323c;">
            <label style="display:flex;align-items:center;gap:8px;cursor:pointer;">
              <input id="exp-dlg-index" type="checkbox" checked />
              <span>Weld &amp; Index static geometries (preserves multi-material groups)</span>
            </label>
            <label style="display:flex;align-items:center;gap:8px;cursor:pointer;">
              <input id="exp-dlg-dedup" type="checkbox" checked />
              <span>Deduplicate identical PBR materials (full physical signature)</span>
            </label>
            <label style="display:flex;align-items:center;gap:8px;cursor:pointer;">
              <input id="exp-dlg-report" type="checkbox" />
              <span>Also download <code>export-report.json</code></span>
            </label>
          </div>
          <div id="exp-dlg-budget" style="padding:8px 10px;background:#16181d;border-radius:5px;border:1px solid #2d313b;line-height:1.5;color:#cbd5e1;"></div>
          <div id="exp-dlg-status" style="font-size:11px;color:#fbbf24;min-height:14px;"></div>
          <div style="font-size:11px;color:#94a3b8;">
            Normal, Roughness, Metalness &amp; AO maps are always exported as lossless PNG to preserve surface shading precision.
          </div>
        </div>
        <div style="display:flex;justify-content:flex-end;gap:8px;padding:10px 16px;background:#1b1d22;border-top:1px solid #323640;">
          <button id="exp-dlg-cancel" style="padding:6px 14px;background:#2f333d;color:#e5e7eb;border:1px solid #444956;border-radius:4px;cursor:pointer;font-size:12px;">Cancel</button>
          <button id="exp-dlg-run" style="padding:6px 16px;background:#3b82f6;color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:12px;font-weight:600;">Export Model</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    this.overlay = overlay;

    const $ = (id) => overlay.querySelector(id);
    $('#exp-dlg-close').onclick = () => this.close();
    $('#exp-dlg-cancel').onclick = () => this.close();
    overlay.addEventListener('click', (e) => { if (e.target === overlay) this.close(); });
    $('#exp-dlg-preset').addEventListener('change', (e) => {
      const p = EXPORT_PRESETS[e.target.value];
      if (!p) return;
      $('#exp-dlg-texfmt').value = p.textureFormat;
      $('#exp-dlg-maxtex').value = String(p.maxTextureSize);
      $('#exp-dlg-index').checked = p.indexGeometries;
      $('#exp-dlg-dedup').checked = p.deduplicateMaterials;
      this._refreshBudget();
    });

    $('#exp-dlg-run').onclick = async () => {
      if (this._busy || this.app?.exporter?._exportInProgress || !this.app?.exporter?.exportGLTF) return;
      this._busy = true;
      const runGen = (this._exportCancelGen = (this._exportCancelGen || 0) + 1);
      const ac = new AbortController();
      this._exportAbort = ac;
      const runBtn = $('#exp-dlg-run');
      runBtn.textContent = 'Exporting...';
      runBtn.disabled = true;
      try {
        const binary = $('#exp-dlg-binary').value === 'glb';
        const opts = {
          binary,
          download: false,
          optimize: true,
          textureFormat: $('#exp-dlg-texfmt').value,
          lossyDataMaps: false,
          maxTextureSize: Number($('#exp-dlg-maxtex').value) || 1024,
          indexGeometries: $('#exp-dlg-index').checked,
          deduplicateMaterials: $('#exp-dlg-dedup').checked,
          signal: ac.signal,
        };
        const t0 = performance.now();
        const res = await this.app.exporter.exportGLTF(null, opts);
        if (runGen !== this._exportCancelGen || ac.signal.aborted) return;
        if (res?.blob) {
          this.app.exporter.triggerDownload(res.blob, res.filename || (binary ? 'blender_export.glb' : 'blender_export.gltf'));
        }
        const exportMs = Math.round(performance.now() - t0);
        if ($('#exp-dlg-report').checked) {
          const budget = this._computeBudget();
          const report = {
            filename: res?.filename || (binary ? 'blender_export.glb' : 'blender_export.gltf'),
            exportedBytes: res?.blob?.size || 0,
            exportMs,
            options: { ...opts, signal: undefined },
            budget,
          };
          const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
          this.app.exporter.triggerDownload(blob, 'export-report.json');
        }
        this._busy = false;
        this._exportAbort = null;
        this.close();
      } catch (err) {
        if (err?.name !== 'AbortError') throw err;
      } finally {
        if (runGen === this._exportCancelGen) {
          this._busy = false;
          this._exportAbort = null;
          runBtn.textContent = 'Export Model';
          runBtn.disabled = false;
        }
      }
    };
  }

  _computeBudget() {
    const root = this.app?.sceneManager?.rootContainer || this.app?.engine?.scene;
    return inspectSceneBudget(root, { tier: 'architecture', renderer: this.app?.engine?.renderer || null });
  }

  _refreshBudget() {
    if (!this.overlay) return;
    const el = this.overlay.querySelector('#exp-dlg-budget');
    if (!el) return;
    const b = this._computeBudget();
    const color = b.status === 'ok' ? '#34d399' : (b.status === 'warn' ? '#fbbf24' : '#f87171');
    el.innerHTML = `
      <div style="display:flex;justify-content:space-between;">
        <span>Triangles (Unique / Rendered):</span>
        <strong>${b.uniqueTris.toLocaleString()} / ${b.renderedTris.toLocaleString()}</strong>
      </div>
      <div style="display:flex;justify-content:space-between;">
        <span>Draw Calls · Materials · Images:</span>
        <strong>${b.drawCalls} · ${b.uniqueMaterials} · ${b.uniqueImages} (${b.colorMapCount}C / ${b.dataMapCount}D)</strong>
      </div>
      <div style="display:flex;justify-content:space-between;">
        <span>Geom RAM · Tex VRAM · Est. GLB:</span>
        <strong style="color:${color};">${b.uniqueGeomMB} MB · ${b.textureVRAM_MB} MB · ~${b.estimatedGlbMB} MB</strong>
      </div>
      ${b.warnings.length ? `<div style="margin-top:5px;color:#fbbf24;font-size:11px;">⚠ ${b.warnings[0]}</div>` : ''}
    `;
  }
}
