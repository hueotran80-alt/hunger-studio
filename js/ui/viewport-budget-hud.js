/**
 * Web Blender Studio - Viewport Budget HUD Chip & Popover
 * Lightweight header chip showing live commercial Web3D budget metrics from `inspectSceneBudget()`.
 * File: js/ui/viewport-budget-hud.js
 */
import { inspectSceneBudget } from '../core/scene-budget.js';

export class ViewportBudgetHUD {
  constructor(app) {
    this.app = app;
    this.tier = 'architecture';
    this.chip = null;
    this.popover = null;
    this.isOpen = false;
    this._mount();
  }

  _mount() {
    const headerRight = document.querySelector('.blender-header-right');
    if (!headerRight || document.getElementById('stat-budget-chip')) return;

    const chip = document.createElement('button');
    chip.id = 'stat-budget-chip';
    chip.type = 'button';
    chip.className = 'header-stat';
    chip.style.cssText = 'background:#20232a;border:1px solid #353945;border-radius:4px;padding:2px 7px;cursor:pointer;display:inline-flex;align-items:center;gap:5px;color:#d1d5db;font-size:11px;margin-left:4px;';
    chip.title = 'Click to inspect Scene RAM, Texture VRAM, Draw Calls & Estimated GLB Budget';
    chip.innerHTML = `<span id="stat-budget-dot" style="width:7px;height:7px;border-radius:50%;background:#34d399;display:inline-block;"></span><span id="stat-budget-text">Budget</span>`;
    headerRight.appendChild(chip);
    this.chip = chip;

    const pop = document.createElement('div');
    pop.id = 'viewport-budget-popover';
    pop.style.cssText = 'display:none;position:fixed;top:36px;right:12px;width:300px;background:#1e2026;color:#e5e7eb;border:1px solid #3a3e4a;border-radius:6px;padding:10px 12px;z-index:9900;box-shadow:0 12px 32px rgba(0,0,0,0.5);font-size:11.5px;line-height:1.5;';
    document.body.appendChild(pop);
    this.popover = pop;

    chip.addEventListener('click', (e) => {
      e.stopPropagation();
      this.isOpen = !this.isOpen;
      pop.style.display = this.isOpen ? 'block' : 'none';
      if (this.isOpen) this.refresh();
    });
    document.addEventListener('click', (e) => {
      if (this.isOpen && !pop.contains(e.target) && e.target !== chip) {
        this.isOpen = false;
        pop.style.display = 'none';
      }
    });
    this.refresh();
  }

  refresh() {
    if (!this.chip) return;
    const root = this.app?.sceneManager?.rootContainer || this.app?.engine?.scene;
    const b = inspectSceneBudget(root, { tier: this.tier, renderer: this.app?.engine?.renderer || null });
    const color = b.status === 'ok' ? '#34d399' : (b.status === 'warn' ? '#fbbf24' : '#f87171');
    const dot = this.chip.querySelector('#stat-budget-dot');
    const txt = this.chip.querySelector('#stat-budget-text');
    if (dot) dot.style.background = color;
    if (txt) txt.textContent = `GLB ~${b.estimatedGlbMB}MB · VRAM ${b.textureVRAM_MB}MB`;

    if (this.isOpen && this.popover) {
      this.popover.innerHTML = `
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;padding-bottom:6px;border-bottom:1px solid #2e323c;">
          <strong>Scene Budget</strong>
          <select id="budget-tier-select" style="background:#14161b;color:#e5e7eb;border:1px solid #3a3e4a;border-radius:3px;font-size:11px;padding:2px 5px;">
            <option value="mobile" ${this.tier === 'mobile' ? 'selected' : ''}>Mobile / AR</option>
            <option value="product" ${this.tier === 'product' ? 'selected' : ''}>Product</option>
            <option value="architecture" ${this.tier === 'architecture' ? 'selected' : ''}>Architecture</option>
          </select>
        </div>
        <div style="display:flex;justify-content:space-between;"><span>Unique / Rendered Tris</span><strong>${b.uniqueTris.toLocaleString()} / ${b.renderedTris.toLocaleString()}</strong></div>
        <div style="display:flex;justify-content:space-between;"><span>Draw Calls (Instanced)</span><strong>${b.drawCalls} (${b.instancedCount} inst)</strong></div>
        <div style="display:flex;justify-content:space-between;"><span>Geometry Buffers</span><strong>${b.uniqueGeomMB} MB (${b.indexedGeoms}/${b.uniqueGeoms} idx)</strong></div>
        <div style="display:flex;justify-content:space-between;"><span>Texture VRAM (w/ Mips)</span><strong>${b.textureVRAM_MB} MB (${b.uniqueImages} imgs)</strong></div>
        <div style="display:flex;justify-content:space-between;"><span>Estimated GLB</span><strong style="color:${color};">~${b.estimatedGlbMB} MB</strong></div>
        ${b.jsHeapMB !== null ? `<div style="display:flex;justify-content:space-between;"><span>JS Heap</span><strong>${b.jsHeapMB} MB</strong></div>` : ''}
        ${b.warnings.length ? `<div style="margin-top:6px;padding-top:6px;border-top:1px solid #2e323c;color:#fbbf24;font-size:11px;">${b.warnings.map((w) => `• ${w}`).join('<br/>')}</div>` : '<div style="margin-top:6px;color:#34d399;font-size:11px;">✓ Within commercial budget</div>'}
      `;
      const sel = this.popover.querySelector('#budget-tier-select');
      if (sel) {
        sel.onchange = (ev) => {
          this.tier = ev.target.value;
          this.refresh();
        };
      }
    }
  }
}
