/**
 * Agent UI layer: DOM contract tagging (data-agent-*), UI automation,
 * confirmation dialog, highlight and status pill.
 */
import { AgentError } from './agent-core.js';

export const CONTROL_SELECTOR = [
  'button', 'input:not([type=hidden])', 'select', 'textarea', 'summary', 'a[href]',
  '[role=button]', '[role=tab]', '[contenteditable="true"]',
  '.dropdown-item', '.workspace-tab', '.dock-tab', '.outliner-item', '.outliner-expand-arrow',
  '.prop-card-header', '.material-card', '.tl-diamond', '.tl-kf-modal-item',
  '.modifier-card-title-group', '.timeline-ruler-wrapper', '.b-slider', '[data-agent-control]',
  'canvas[id]'
].join(',');

const PANEL_RULES = [
  ['.agent-ui-root', () => 'agent'],
  ['.menu-item[id]', el => el.id],
  ['.workspace-tabs', () => 'workspaces'],
  ['.blender-header', () => 'header'],
  ['.blender-toolbar', () => 'toolbar'],
  ['#viewport-shading-popover', () => 'shading-popover'],
  ['#edit-mode-selector-group', () => 'edit-mode'],
  ['#sculpt-mode-selector-group', () => 'sculpt-mode'],
  ['.viewport-header', () => 'viewport-header'],
  ['#viewport-canvas-host', () => 'viewport'],
  ['.dock-tabs', () => 'dock-tabs'],
  ['#timeline-controls-bar', () => 'timeline'],
  ['.dock-pane[id]', el => el.id.replace(/^dock-/, '')],
  ['#outliner-panel', () => 'outliner'],
  ['#inspector-panel', () => 'inspector'],
  ['.blender-copilot-panel', () => 'ai-copilot'],
  ['.copilot-fab-btn', () => 'ai-copilot']
];

export const PANELS = {
  'scripting': { kind: 'dock', pane: 'dock-scripting', label: 'Scripting Console (DSL)' },
  'materials': { kind: 'dock', pane: 'dock-materials', label: 'PBR Material Shelf' },
  'pose': { kind: 'dock', pane: 'dock-pose', label: 'Pose & Rigging' },
  'timeline': { kind: 'dock', pane: 'dock-timeline', label: 'Timeline' },
  'graph-editor': { kind: 'dock', pane: 'dock-graph-editor', label: 'Graph Editor (F-Curve)' },
  'uv-editor': { kind: 'dock', pane: 'dock-uv-editor', label: 'UV Editor' },
  'mocap': { kind: 'dock', pane: 'dock-mocap', label: 'Video Mocap (AI)' },
  'stem': { kind: 'dock', pane: 'dock-stem', label: 'STEM Curriculum & 1-1 Tutor' },
  'menu-file': { kind: 'menu', label: 'File menu' },
  'menu-edit': { kind: 'menu', label: 'Edit menu' },
  'menu-add': { kind: 'menu', label: 'Add menu' },
  'menu-render': { kind: 'menu', label: 'Render menu' },
  'menu-help': { kind: 'menu', label: 'Help menu' },
  'shading-popover': { kind: 'popover', label: 'Viewport Shading popover' },
  'outliner': { kind: 'sidebar', label: 'Outliner' },
  'inspector': { kind: 'sidebar', label: 'Properties / Inspector' },
  'toolbar': { kind: 'toolbar', label: 'Left Toolbar' },
  'ai-copilot': { kind: 'copilot', label: 'AI 3D Copilot' },
  'workspace.layout': { kind: 'workspace', ws: 'layout', label: 'Layout workspace' },
  'workspace.viewport': { kind: 'workspace', ws: 'viewport', label: 'Viewport (Full / No Dock) workspace' },
  'workspace.modeling': { kind: 'workspace', ws: 'modeling', label: 'Modeling workspace (enters Edit Mode)' },
  'workspace.scripting': { kind: 'workspace', ws: 'scripting', label: 'Scripting workspace' },
  'workspace.ai': { kind: 'workspace', ws: 'ai', label: 'AI 3D Studio workspace' },
  'inspector.tool': { kind: 'inspector-tab', tab: 'tool', label: 'Inspector: Active Tool' },
  'inspector.world': { kind: 'inspector-tab', tab: 'world', label: 'Inspector: World' },
  'inspector.object': { kind: 'inspector-tab', tab: 'object', label: 'Inspector: Object' },
  'inspector.modifier': { kind: 'inspector-tab', tab: 'modifier', label: 'Inspector: Modifiers' },
  'inspector.material': { kind: 'inspector-tab', tab: 'material', label: 'Inspector: Material' },
  'inspector.armature': { kind: 'inspector-tab', tab: 'armature', label: 'Inspector: Armature' },
  'inspector.data': { kind: 'inspector-tab', tab: 'data', label: 'Inspector: Mesh Data' }
};

const DATA_KEYS = ['pane', 'workspace', 'mode', 'brush', 'tab', 'type', 'hdri', 'color', 'styleId', 'key',
  'cat', 'action', 'axis', 'prop', 'unit', 'channels', 'prompt', 'preset', 'value', 'slot', 'name'];

const DYNAMIC_ID = /[0-9a-f]{8}-[0-9a-f]{4}-|\d{6,}/i;

export function slug(text, max = 40) {
  return String(text || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, max).replace(/-+$/, '');
}

const clean = (t, max = 80) => String(t || '').replace(/\s+/g, ' ').trim().slice(0, max);

function directText(el) {
  let t = '';
  el.childNodes.forEach(n => {
    if (n.nodeType === 3) t += n.textContent;
    else if (n.nodeType === 1 && !/^(svg|select|input|textarea|ul|ol)$/i.test(n.tagName) && !n.matches('.dropdown-menu,.menu-dropdown,.submenu-flyout,.shortcut')) {
      t += ' ' + n.textContent;
    }
  });
  return clean(t);
}

export class AgentUI {
  constructor(ctx) {
    this.ctx = ctx;
    this.idToEl = new Map();
    this.autoConfirm = false;
    this._scheduled = false;
    this._styleInjected = false;
    this._statusEl = null;
  }

  init() {
    this._injectStyle();
    this.tagAll();
    this._observer = new MutationObserver(() => this._schedule());
    this._observer.observe(document.body, { childList: true, subtree: true });
    const onUser = (e) => {
      if (!e.isTrusted) return;
      const el = e.target?.closest?.('[data-agent-id]');
      if (!el || el.closest('.agent-ui-root')) return;
      this.ctx.events.emit('user:action', {
        event: e.type, id: el.dataset.agentId, type: el.dataset.agentType,
        label: el.dataset.agentLabel, panel: el.dataset.agentPanel, value: this._value(el), ts: Date.now()
      });
    };
    document.addEventListener('click', onUser, true);
    document.addEventListener('change', onUser, true);
  }

  _schedule() {
    if (this._scheduled) return;
    this._scheduled = true;
    requestAnimationFrame(() => {
      this._scheduled = false;
      this.tagAll();
    });
  }

  // ---------------------------------------------------------------------------
  // Tagging
  // ---------------------------------------------------------------------------

  panelOf(el) {
    for (const [sel, fn] of PANEL_RULES) {
      const anc = el.closest(sel);
      if (anc) return fn(anc);
    }
    const anyId = el.parentElement?.closest('[id]');
    return anyId ? slug(anyId.id) : 'app';
  }

  typeOf(el) {
    const tag = el.tagName.toLowerCase();
    if (tag === 'canvas') return 'viewport';
    if (tag === 'select' || el.classList.contains('tl-select')) return 'select';
    if (tag === 'textarea' || el.isContentEditable) return 'input';
    if (tag === 'input') {
      const t = (el.type || 'text').toLowerCase();
      if (t === 'range') return 'slider';
      if (t === 'checkbox' || t === 'radio') return 'toggle';
      if (t === 'color') return 'color';
      if (t === 'button' || t === 'submit') return 'button';
      return 'input';
    }
    if (el.classList.contains('b-slider')) return 'slider';
    if (el.matches('.workspace-tab,.dock-tab,.prop-tab-btn,.pose-cat-btn,[role=tab]')) return 'tab';
    if (el.matches('.dropdown-item,.menu-btn,.tl-kf-modal-item')) return 'menu-item';
    if (el.tagName === 'SUMMARY') return 'toggle';
    return 'button';
  }

  labelOf(el) {
    const aria = el.getAttribute('aria-label');
    if (aria) return clean(aria);
    const title = el.getAttribute('title') || el.dataset.tooltip;
    if (title) return clean(title);
    if (el.tagName === 'CANVAS') return el === this.ctx.engine?.renderer?.domElement ? '3D Viewport' : clean(el.id);
    if (el.matches('input,select,textarea')) {
      if (el.id) {
        const lab = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
        if (lab) return clean(lab.textContent);
      }
      const wrapLabel = el.closest('label');
      if (wrapLabel && clean(wrapLabel.textContent)) return clean(wrapLabel.textContent);
      const row = el.closest('.prop-row,.mp-row,.uv-row,.tl-row,.graph-row,.form-row');
      const rowLabel = row?.querySelector('.prop-label,label,.mp-label,span');
      if (rowLabel && rowLabel !== el && clean(rowLabel.textContent)) return clean(rowLabel.textContent);
      const prev = el.previousElementSibling;
      if (prev && /^(LABEL|SPAN)$/.test(prev.tagName) && clean(prev.textContent)) return clean(prev.textContent);
      if (el.placeholder) return clean(el.placeholder);
      if (el.name) return clean(el.name);
    }
    const text = directText(el) || clean(el.textContent);
    if (text) return text;
    return clean(el.id || el.className || el.tagName.toLowerCase());
  }

  _baseId(el, panel) {
    if (el === this.ctx.engine?.renderer?.domElement) return 'viewport';
    const id = el.id;
    if (id && !DYNAMIC_ID.test(id)) {
      const dup = document.querySelectorAll(`[id="${CSS.escape(id)}"]`).length > 1;
      return dup ? `${panel}.${id}` : id;
    }
    const row = el.closest('.outliner-item');
    if (row) {
      const obj = this._outlinerObject(row);
      const objKey = obj ? (this.ctx.ids.assign(obj)) : slug(row.dataset.uuid || row.dataset.id || 'row');
      if (el === row) return `outliner.${objKey}`;
      return `outliner.${objKey}.${slug(this.labelOf(el), 24) || 'action'}`;
    }
    for (const k of DATA_KEYS) {
      const v = el.dataset[k];
      if (v !== undefined && v !== '') return `${panel}.${slug(k)}.${slug(v, 32) || 'x'}`;
    }
    return `${panel}.${slug(this.labelOf(el), 36) || this.typeOf(el)}`;
  }

  _outlinerObject(row) {
    const sm = this.ctx.sceneManager;
    const key = row.dataset.uuid || row.dataset.id;
    if (!key || !sm) return null;
    let found = sm.objects.get(key) || null;
    if (!found) sm.traverseObjects?.(o => { if (!found && (o.uuid === key || o.userData?.id === key)) found = o; });
    return found;
  }

  tagElement(el) {
    if (!el.isConnected) return null;
    const existing = el.dataset.agentId;
    if (existing && this.idToEl.get(existing) === el) {
      this._refreshMeta(el);
      return existing;
    }
    const panel = this.panelOf(el);
    let id = this._baseId(el, panel);
    const holder = this.idToEl.get(id);
    if (holder && holder !== el && holder.isConnected) {
      let n = 2;
      while (this.idToEl.get(`${id}#${n}`) && this.idToEl.get(`${id}#${n}`) !== el && this.idToEl.get(`${id}#${n}`).isConnected) n++;
      id = `${id}#${n}`;
    }
    this.idToEl.set(id, el);
    el.dataset.agentId = id;
    el.dataset.agentPanel = panel;
    this._refreshMeta(el);
    return id;
  }

  _refreshMeta(el) {
    const type = this.typeOf(el);
    if (el.dataset.agentType !== type) el.dataset.agentType = type;
    const label = this.labelOf(el);
    if (el.dataset.agentLabel !== label) el.dataset.agentLabel = label;
  }

  tagAll(root = document) {
    const els = root.querySelectorAll(CONTROL_SELECTOR);
    els.forEach(el => {
      if (el.closest('.agent-ui-root') && !el.dataset.agentControl && !el.matches('button,input')) return;
      this.tagElement(el);
    });
    // Drop references to elements that left the DOM so their IDs can be reused by re-renders.
    this.idToEl.forEach((el, id) => { if (!el.isConnected) this.idToEl.delete(id); });
    return els.length;
  }

  // ---------------------------------------------------------------------------
  // Introspection
  // ---------------------------------------------------------------------------

  _visible(el) {
    if (!el.isConnected) return false;
    if (el.offsetParent === null && getComputedStyle(el).position !== 'fixed') return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  _disabled(el) {
    return !!(el.disabled || el.getAttribute('aria-disabled') === 'true' || el.classList.contains('disabled') ||
      el.closest('fieldset[disabled]'));
  }

  _value(el) {
    const type = el.dataset.agentType || this.typeOf(el);
    if (el.tagName === 'INPUT') {
      if (el.type === 'checkbox' || el.type === 'radio') return el.checked;
      if (el.type === 'range' || el.type === 'number') return el.value === '' ? null : Number(el.value);
      if (el.type === 'file') return el.files ? el.files.length : 0;
      return el.value;
    }
    if (el.tagName === 'SELECT' || el.tagName === 'TEXTAREA') return el.value;
    if (el.tagName === 'SUMMARY') return !!el.parentElement?.open;
    if (type === 'tab' || type === 'button' || type === 'menu-item') {
      return el.classList.contains('active') || el.getAttribute('aria-pressed') === 'true' || el.getAttribute('aria-selected') === 'true';
    }
    return null;
  }

  describe(el) {
    const id = el.dataset.agentId || this.tagElement(el);
    const out = {
      id,
      type: el.dataset.agentType,
      label: el.dataset.agentLabel,
      panel: el.dataset.agentPanel,
      value: this._value(el),
      options: null,
      disabled: this._disabled(el),
      visible: this._visible(el),
      tooltip: clean(el.getAttribute('title') || el.dataset.tooltip || '', 200) || null,
      docsToolId: this.ctx.manifest ? this.ctx.manifest.toolIdForControl(id) : `ui.${id}`
    };
    if (el.tagName === 'SELECT') out.options = [...el.options].map(o => ({ value: o.value, label: clean(o.textContent) }));
    if (el.tagName === 'INPUT' && (el.type === 'range' || el.type === 'number')) {
      out.range = { min: el.min === '' ? null : Number(el.min), max: el.max === '' ? null : Number(el.max), step: el.step === '' || el.step === 'any' ? null : Number(el.step) };
    }
    if (el.tagName === 'INPUT' && el.type === 'file') out.accept = el.accept || '*';
    return out;
  }

  list({ panel, visibleOnly = false, type, query } = {}) {
    this.tagAll();
    const q = query ? String(query).toLowerCase() : null;
    const out = [];
    this.idToEl.forEach(el => {
      const d = this.describe(el);
      if (d.panel === 'agent') return;
      if (panel && d.panel !== panel && !d.panel.startsWith(`${panel}.`)) return;
      if (visibleOnly && !d.visible) return;
      if (type && d.type !== type) return;
      if (q && !(`${d.id} ${d.label} ${d.tooltip || ''}`.toLowerCase().includes(q))) return;
      out.push(d);
    });
    out.sort((a, b) => (a.panel === b.panel ? a.id.localeCompare(b.id) : a.panel.localeCompare(b.panel)));
    return out;
  }

  resolve(id, toolId) {
    if (typeof id !== 'string' || !id) {
      throw new AgentError('E_INVALID_ARG', 'Control id must be a non-empty string', 'Use agent.ui.list() to discover control ids.', toolId);
    }
    let el = this.idToEl.get(id);
    if (!el || !el.isConnected) {
      this.tagAll();
      el = this.idToEl.get(id) || document.querySelector(`[data-agent-id="${CSS.escape(id)}"]`);
    }
    if (!el || !el.isConnected) {
      const panelGuess = id.includes('.') ? id.split('.')[0] : null;
      const hint = panelGuess && PANELS[panelGuess]
        ? `Control is not rendered. Call agent.ui.openPanel('${panelGuess}') first, then agent.ui.list({panel:'${panelGuess}'}).`
        : 'Control not found in the current DOM. Use agent.ui.list({query}) to search, or open the panel that owns it.';
      throw new AgentError('E_NOT_FOUND', `UI control '${id}' not found`, hint, toolId);
    }
    if (el.closest('.agent-ui-root[data-agent-protected]')) {
      throw new AgentError('E_PERMISSION', 'Agents cannot operate the confirmation dialog', 'Wait for the user to answer agent.session.confirm().', toolId);
    }
    return el;
  }

  // ---------------------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------------------

  async click(id, { confirm } = {}) {
    const el = this.resolve(id, 'ui.click');
    if (this._disabled(el)) {
      throw new AgentError('E_DISABLED', `Control '${id}' is disabled`,
        'Check prerequisites in agent.docs.get(docsToolId).pitfalls (e.g. select a mesh first via agent.scene.select).', 'ui.click');
    }
    const def = this.ctx.manifest?.getTool(this.ctx.manifest.toolIdForControl(id));
    if (def?.requiresConfirm) {
      if (!confirm) {
        throw new AgentError('E_NEEDS_CONFIRM', `'${id}' is destructive and needs confirmation`,
          `Call agent.ui.click('${id}', {confirm:true}) to ask the user via agent.session.confirm().`, 'ui.click');
      }
      const okUser = await this.confirm({ title: 'Agent wants to perform a destructive action', message: `${def.label} (${id})`, danger: true });
      if (!okUser) throw new AgentError('E_PERMISSION', 'User denied the action', 'Ask the user or choose a non-destructive alternative.', 'ui.click');
    }
    this.highlight(id, 600);
    const origConfirm = window.confirm;
    if (def?.requiresConfirm) window.confirm = () => true;
    try {
      if (el.tagName === 'SUMMARY') el.parentElement.open = !el.parentElement.open;
      else if (el.tagName === 'CANVAS') throw new AgentError('E_UNSUPPORTED', 'Clicking the viewport canvas is not supported', 'Use agent.scene.select(agentId) or agent.util.raycast({x,y}).', 'ui.click');
      else el.click();
    } finally {
      window.confirm = origConfirm;
    }
    await new Promise(r => setTimeout(r, 30));
    return { id, value: this._value(el), activePanel: this.activePanel() };
  }

  async setValue(id, value) {
    const el = this.resolve(id, 'ui.setValue');
    if (this._disabled(el)) throw new AgentError('E_DISABLED', `Control '${id}' is disabled`, 'Enable it first (check its prerequisites).', 'ui.setValue');
    const fire = (type) => el.dispatchEvent(new Event(type, { bubbles: true }));
    if (el.tagName === 'SELECT') {
      const opts = [...el.options].map(o => o.value);
      if (!opts.includes(String(value))) {
        throw new AgentError('E_INVALID_ARG', `'${value}' is not an option of '${id}'`, `Valid options: ${opts.join(', ')}`, 'ui.setValue');
      }
      el.value = String(value);
      fire('input'); fire('change');
    } else if (el.tagName === 'INPUT' && (el.type === 'checkbox' || el.type === 'radio')) {
      const want = !!value;
      if (el.checked !== want) {
        el.checked = want;
        fire('input'); fire('change');
      }
    } else if (el.tagName === 'INPUT' && (el.type === 'range' || el.type === 'number')) {
      let v = Number(value);
      if (!Number.isFinite(v)) throw new AgentError('E_INVALID_ARG', `'${id}' needs a number`, 'Pass a numeric value.', 'ui.setValue');
      if (el.min !== '') v = Math.max(Number(el.min), v);
      if (el.max !== '') v = Math.min(Number(el.max), v);
      el.value = String(v);
      fire('input'); fire('change');
    } else if (el.tagName === 'INPUT' && el.type === 'color') {
      const hex = String(value);
      if (!/^#[0-9a-f]{6}$/i.test(hex)) throw new AgentError('E_INVALID_ARG', 'Color must be #rrggbb', "e.g. agent.ui.setValue(id, '#ff8800')", 'ui.setValue');
      el.value = hex.toLowerCase();
      fire('input'); fire('change');
    } else if (el.tagName === 'INPUT' && el.type === 'file') {
      throw new AgentError('E_PERMISSION', 'File inputs cannot be set programmatically', 'Use agent.assets.importURL(url) or agent.assets.pickFile({accept}).', 'ui.setValue');
    } else if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
      el.focus();
      el.value = String(value);
      fire('input'); fire('change');
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      el.blur();
    } else if (el.isContentEditable) {
      el.textContent = String(value);
      fire('input');
    } else {
      throw new AgentError('E_UNSUPPORTED', `'${id}' (${el.dataset.agentType}) has no settable value`, `Use agent.ui.click('${id}') instead.`, 'ui.setValue');
    }
    this.highlight(id, 500);
    await new Promise(r => setTimeout(r, 20));
    return { id, value: this._value(el) };
  }

  async openPanel(panelId) {
    const p = PANELS[panelId];
    if (!p) {
      throw new AgentError('E_NOT_FOUND', `Unknown panel '${panelId}'`, `Known panels: ${Object.keys(PANELS).join(', ')}`, 'ui.openPanel');
    }
    const app = window.app;
    switch (p.kind) {
      case 'dock': document.querySelector(`.dock-tab[data-pane="${p.pane}"]`)?.click(); break;
      case 'workspace': document.querySelector(`.workspace-tab[data-workspace="${p.ws}"]`)?.click(); break;
      case 'menu': {
        const m = document.getElementById(panelId);
        if (m && !m.classList.contains('open')) m.querySelector('.menu-btn')?.click();
        break;
      }
      case 'popover': {
        const pop = document.getElementById('viewport-shading-popover');
        if (pop && !this._popoverOpen()) document.getElementById('btn-shading-popover')?.click();
        break;
      }
      case 'sidebar': {
        const sb = document.getElementById('sidebar-right');
        if (sb && sb.style.display === 'none') sb.style.display = 'flex';
        app?.engine?.onResize?.();
        break;
      }
      case 'toolbar': {
        const tb = document.querySelector('.blender-toolbar');
        if (tb && tb.style.display === 'none') tb.style.display = 'flex';
        break;
      }
      case 'inspector-tab': {
        const sb = document.getElementById('sidebar-right');
        if (sb && sb.style.display === 'none') sb.style.display = 'flex';
        const btn = document.querySelector(`.prop-tab-btn[data-tab="${p.tab}"]`);
        if (!btn) throw new AgentError('E_NOT_FOUND', `Inspector tab '${p.tab}' is not available`, 'Select an object first: agent.scene.select([agentId]).', 'ui.openPanel');
        btn.click();
        break;
      }
      case 'copilot': (app?.aiCopilot || window.aiCopilot)?.show?.(); break;
      default: break;
    }
    await new Promise(r => setTimeout(r, 80));
    this.tagAll();
    return { panel: panelId, active: this.activePanel() };
  }

  async closePanel(panelId) {
    const p = PANELS[panelId];
    if (!p) throw new AgentError('E_NOT_FOUND', `Unknown panel '${panelId}'`, `Known panels: ${Object.keys(PANELS).join(', ')}`, 'ui.closePanel');
    switch (p.kind) {
      case 'menu': document.getElementById(panelId)?.classList.remove('open'); break;
      case 'popover': if (this._popoverOpen()) (document.getElementById('btn-popover-close') || document.getElementById('btn-shading-popover'))?.click(); break;
      case 'sidebar': { const sb = document.getElementById('sidebar-right'); if (sb) sb.style.display = 'none'; window.app?.engine?.onResize?.(); break; }
      case 'toolbar': { const tb = document.querySelector('.blender-toolbar'); if (tb) tb.style.display = 'none'; break; }
      case 'copilot': (window.app?.aiCopilot || window.aiCopilot)?.hide?.(); break;
      case 'dock':
        if (panelId === 'mocap' && document.getElementById('dock-mocap')?.classList.contains('mocap-focus')) {
          document.querySelector('.dock-tab[data-pane="dock-timeline"]')?.click();
        } else {
          return { panel: panelId, note: 'Dock panes cannot be closed; open another pane with agent.ui.openPanel().' };
        }
        break;
      default: return { panel: panelId, note: 'Panel kind has no close action' };
    }
    await new Promise(r => setTimeout(r, 50));
    return { panel: panelId, active: this.activePanel() };
  }

  _popoverOpen() {
    const pop = document.getElementById('viewport-shading-popover');
    if (!pop) return false;
    return pop.classList.contains('visible') || pop.classList.contains('open') || (pop.style.display && pop.style.display !== 'none' && getComputedStyle(pop).display !== 'none');
  }

  activePanel() {
    const dockTab = document.querySelector('.dock-tab.active');
    const pane = dockTab?.dataset.pane?.replace(/^dock-/, '') || null;
    const ws = document.querySelector('.workspace-tab.active')?.dataset.workspace || null;
    const menu = document.querySelector('.menu-item.open')?.id || null;
    const inspectorTab = document.querySelector('.prop-tab-btn.active')?.dataset.tab || null;
    const copilotOpen = !!document.querySelector('.blender-copilot-panel:not(.hidden)');
    return { dock: pane, workspace: ws, menu, popover: this._popoverOpen() ? 'shading-popover' : null, inspectorTab, copilot: copilotOpen };
  }

  async waitFor(id, { state = 'visible', timeout = 5000 } = {}) {
    const t0 = performance.now();
    const check = () => {
      this.tagAll();
      const el = this.idToEl.get(id);
      if (state === 'present') return !!el;
      if (state === 'absent') return !el;
      if (!el) return false;
      if (state === 'visible') return this._visible(el);
      if (state === 'hidden') return !this._visible(el);
      if (state === 'enabled') return !this._disabled(el);
      if (state === 'disabled') return this._disabled(el);
      throw new AgentError('E_INVALID_ARG', `Unknown state '${state}'`, "Use 'visible'|'hidden'|'enabled'|'disabled'|'present'|'absent'.", 'ui.waitFor');
    };
    while (performance.now() - t0 < timeout) {
      if (check()) return { id, state, elapsedMs: Math.round(performance.now() - t0) };
      await new Promise(r => setTimeout(r, 100));
    }
    throw new AgentError('E_TIMEOUT', `Control '${id}' did not become ${state} within ${timeout}ms`,
      'Open the owning panel first (agent.ui.openPanel) or increase timeout.', 'ui.waitFor');
  }

  async shortcut(keys, opts = {}) {
    if (typeof keys !== 'string' || !keys.trim()) {
      throw new AgentError('E_INVALID_ARG', 'shortcut needs a key combo string', "e.g. agent.ui.shortcut('Shift+D') or 'Numpad1'", 'ui.shortcut');
    }
    const parts = keys.split('+').map(s => s.trim()).filter(Boolean);
    const mods = { ctrlKey: false, shiftKey: false, altKey: false, metaKey: false };
    let main = parts.pop();
    parts.forEach(p => {
      const k = p.toLowerCase();
      if (k === 'ctrl' || k === 'control') mods.ctrlKey = true;
      else if (k === 'shift') mods.shiftKey = true;
      else if (k === 'alt' || k === 'option') mods.altKey = true;
      else if (k === 'cmd' || k === 'meta') mods.metaKey = true;
    });
    const isDeleteShortcut = /^(delete|del|x)$/i.test(String(main || '')) && !mods.ctrlKey && !mods.altKey && !mods.metaKey;
    if (isDeleteShortcut) {
      if (!opts.confirm) throw new AgentError('E_NEEDS_CONFIRM', 'Delete shortcut needs user confirmation.', 'Pass {confirm:true} to ask the user.', 'ui.shortcut');
      if (!await this.confirm({ title: 'Delete selection', message: 'Delete selected object(s)?', danger: true })) throw new AgentError('E_PERMISSION', 'User declined deletion.');
    }
    let key = main;
    let code;
    const named = { space: ' ', esc: 'Escape', escape: 'Escape', del: 'Delete', delete: 'Delete', tab: 'Tab', enter: 'Enter', period: '.', dot: '.' };
    if (/^numpad\d$/i.test(main)) { code = `Numpad${main.slice(-1)}`; key = main.slice(-1); }
    else if (named[main.toLowerCase()]) { key = named[main.toLowerCase()]; code = key === ' ' ? 'Space' : key; }
    else if (/^f\d{1,2}$/i.test(main)) { key = main.toUpperCase(); code = key; }
    else if (main.length === 1) {
      key = mods.shiftKey ? main.toUpperCase() : main.toLowerCase();
      code = /[a-z]/i.test(main) ? `Key${main.toUpperCase()}` : (/\d/.test(main) ? `Digit${main}` : undefined);
    }
    if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
    const init = { key, code, bubbles: true, cancelable: true, ...mods };
    const target = document.body;
    target.dispatchEvent(new KeyboardEvent('keydown', init));
    target.dispatchEvent(new KeyboardEvent('keyup', init));
    await new Promise(r => setTimeout(r, 40));
    return { keys, key, code: code || null, mods: Object.keys(mods).filter(m => mods[m]) };
  }

  highlight(id, ms = 1200) {
    let el = this.idToEl.get(id) || this.resolve(id, 'ui.highlight');
    let target = el;
    while (target && !this._visible(target)) target = target.parentElement;
    if (!target) return { id, highlighted: false };
    target.classList.add('agent-highlight');
    clearTimeout(target._agentHl);
    target._agentHl = setTimeout(() => target.classList.remove('agent-highlight'), Math.max(100, ms));
    return { id, highlighted: true, target: target === el ? id : (target.dataset.agentId || target.id || target.tagName.toLowerCase()) };
  }

  status(text, { tone = 'info', ttl = 0 } = {}) {
    if (!this._statusEl) {
      const el = document.createElement('div');
      el.className = 'agent-ui-root agent-status';
      el.setAttribute('aria-live', 'polite');
      document.body.appendChild(el);
      this._statusEl = el;
    }
    const el = this._statusEl;
    clearTimeout(el._ttl);
    if (!text) {
      el.classList.remove('visible');
      return { shown: false };
    }
    el.dataset.tone = tone;
    el.textContent = `Agent: ${String(text).slice(0, 200)}`;
    el.classList.add('visible');
    if (ttl > 0) el._ttl = setTimeout(() => el.classList.remove('visible'), ttl);
    return { shown: true, text: el.textContent };
  }

  notify(text) {
    this.status(text, { tone: 'warn', ttl: 2500 });
  }

  /** User-facing confirmation; only a trusted (real) click resolves `true`. */
  confirm({ title = 'Confirm', message = '', danger = false, timeoutMs = 120000 } = {}) {
    if (this.autoConfirm && !danger) return Promise.resolve(true);
    if (this.autoConfirm && danger && this.autoConfirmDanger) return Promise.resolve(true);
    return new Promise(resolve => {
      const root = document.createElement('div');
      root.className = 'agent-ui-root agent-confirm-backdrop';
      root.dataset.agentProtected = '1';
      root.innerHTML = `
        <div class="agent-confirm ${danger ? 'danger' : ''}" role="dialog" aria-modal="true">
          <div class="agent-confirm-title"></div>
          <div class="agent-confirm-msg"></div>
          <label class="agent-confirm-auto"><input type="checkbox"> Always allow for this session</label>
          <div class="agent-confirm-actions">
            <button type="button" class="agent-confirm-deny">Deny</button>
            <button type="button" class="agent-confirm-allow">Allow</button>
          </div>
        </div>`;
      root.querySelector('.agent-confirm-title').textContent = title;
      root.querySelector('.agent-confirm-msg').textContent = message;
      let done = false;
      const finish = (val) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        root.remove();
        this.ctx.log.push({ level: 'info', source: 'agent', message: `confirm "${title}" -> ${val ? 'allowed' : 'denied'}` });
        resolve(val);
      };
      root.querySelector('.agent-confirm-allow').addEventListener('click', (e) => {
        if (!e.isTrusted) return;
        if (root.querySelector('.agent-confirm-auto input').checked) {
          this.autoConfirm = true;
          this.autoConfirmDanger = true;
        }
        finish(true);
      });
      root.querySelector('.agent-confirm-deny').addEventListener('click', () => finish(false));
      root.addEventListener('keydown', (e) => { if (e.key === 'Escape') finish(false); });
      const timer = setTimeout(() => finish(false), timeoutMs);
      document.body.appendChild(root);
      root.querySelector('.agent-confirm-deny').focus();
    });
  }

  _injectStyle() {
    if (this._styleInjected) return;
    this._styleInjected = true;
    const css = document.createElement('style');
    css.id = 'agent-ui-style';
    css.textContent = `
      .agent-highlight { outline: 2px solid #4cc2ff !important; outline-offset: 2px; animation: agentPulse 0.9s ease-in-out infinite; }
      @keyframes agentPulse { 0%,100% { box-shadow: 0 0 0 0 rgba(76,194,255,.7); } 50% { box-shadow: 0 0 0 6px rgba(76,194,255,0); } }
      .agent-status { position: fixed; left: 64px; bottom: 14px; z-index: 100000; max-width: 46vw; padding: 6px 12px; border-radius: 14px;
        background: rgba(20,24,30,.92); color: #d8f1ff; border: 1px solid #2f7fb0; font: 12px/1.4 system-ui, sans-serif;
        pointer-events: none; opacity: 0; transform: translateY(6px); transition: opacity .18s, transform .18s; }
      .agent-status.visible { opacity: 1; transform: none; }
      .agent-status[data-tone="warn"] { border-color: #c9892b; color: #ffe2b0; }
      .agent-status[data-tone="error"] { border-color: #c0392b; color: #ffd0cb; }
      .agent-confirm-backdrop { position: fixed; inset: 0; z-index: 100001; background: rgba(0,0,0,.45); display: flex; align-items: center; justify-content: center; }
      .agent-confirm { width: min(420px, 92vw); background: #2b2d31; color: #e6e6e6; border: 1px solid #4a4d55; border-radius: 8px; padding: 16px 18px;
        font: 13px/1.5 system-ui, sans-serif; box-shadow: 0 12px 40px rgba(0,0,0,.5); }
      .agent-confirm.danger { border-color: #b8443a; }
      .agent-confirm-title { font-weight: 700; font-size: 14px; margin-bottom: 8px; }
      .agent-confirm-msg { white-space: pre-wrap; margin-bottom: 12px; color: #c9c9c9; }
      .agent-confirm-auto { display: flex; gap: 6px; align-items: center; font-size: 12px; color: #aaa; margin-bottom: 12px; }
      .agent-confirm-actions { display: flex; justify-content: flex-end; gap: 8px; }
      .agent-confirm-actions button { padding: 6px 14px; border-radius: 4px; border: 1px solid #555; background: #3a3d44; color: #eee; cursor: pointer; }
      .agent-confirm-allow { background: #2d6fa3 !important; border-color: #3d8cc9 !important; }
      .agent-confirm.danger .agent-confirm-allow { background: #a8392f !important; border-color: #c44b40 !important; }
      .agent-filepick { position: fixed; right: 18px; bottom: 18px; z-index: 100001; background: #2b2d31; color: #eee; border: 1px solid #3d8cc9;
        border-radius: 8px; padding: 12px 14px; font: 13px system-ui, sans-serif; box-shadow: 0 8px 30px rgba(0,0,0,.45); display: flex; gap: 8px; align-items: center; }
      .agent-filepick button { padding: 5px 12px; border-radius: 4px; border: 1px solid #555; background: #3a3d44; color: #eee; cursor: pointer; }
      .agent-filepick .agent-filepick-go { background: #2d6fa3; border-color: #3d8cc9; }
    `;
    document.head.appendChild(css);
  }
}
