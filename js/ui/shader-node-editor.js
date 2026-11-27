/**
 * Interactive Blender-Style Visual Shader Node Editor
 * Pan/zoom canvas, cubic Bezier wire routing, cycle-checked connections,
 * ColorRamp/Math/Mix/Noise/Voronoi/Bump/Fresnel inline controls, and live GLSL/Rust sync.
 * File: js/ui/shader-node-editor.js
 */

import * as THREE from 'three';
import {
  SHADER_NODE_DEFS,
  ShaderGraph,
  getShaderGraphForMaterial,
  setShaderGraphForMaterial,
} from '../core/shader-graph.js';
import {
  applyShaderGraphToMaterial,
  updateShaderGraphUniforms,
} from '../core/shader-compiler-three.js';

const SOCKET_COLORS = {
  vec3: '#c7c729',
  vec2: '#6363c7',
  float: '#a1a1a1',
  shader: '#2ecc71',
};

export class ShaderNodeEditorUI {
  constructor(container, options = {}) {
    this.container = typeof container === 'string' ? document.querySelector(container) : container;
    this.sceneManager = options.sceneManager || null;
    this.engine = options.engine || null;

    this.targetMesh = null;
    this.targetMaterial = null;
    this.graph = null;

    this.panX = 40;
    this.panY = 40;
    this.zoom = 1.0;
    this.selectedNodeId = null;

    this._dragNode = null;
    this._panDrag = null;
    this._wireDrag = null;
    this._nodeEls = new Map();

    this._initDOM();
    this._bindEvents();
    this.syncFromSelection();
  }

  _initDOM() {
    if (!this.container) return;
    this.container.innerHTML = '';

    const root = document.createElement('div');
    root.id = 'shader-node-editor';
    root.style.cssText = 'display:flex;flex-direction:column;width:100%;height:100%;background:#18191d;color:#ddd;font-size:11px;position:relative;user-select:none;';

    const nodeOptions = Object.entries(SHADER_NODE_DEFS)
      .filter(([k]) => k !== 'MaterialOutput')
      .map(([k, d]) => `<option value="${k}">${d.category}: ${d.label}</option>`)
      .join('');

    root.innerHTML = `
      <div class="sg-toolbar" style="display:flex;align-items:center;gap:6px;padding:5px 10px;background:#24262c;border-bottom:1px solid #353842;flex-wrap:wrap;">
        <span style="font-weight:600;color:#fff;">Shader Nodes</span>
        <span id="sg-active-mat-name" style="padding:2px 6px;border-radius:3px;background:#1a1c22;border:1px solid #3b3f4c;color:#93c5fd;">No Material</span>
        <select id="sg-add-node-select" style="height:22px;background:#1c1e24;color:#eee;border:1px solid #3f4451;border-radius:3px;padding:0 4px;">
          <option value="">+ Add Node…</option>
          ${nodeOptions}
        </select>
        <select id="sg-preset-select" style="height:22px;background:#1c1e24;color:#eee;border:1px solid #3f4451;border-radius:3px;padding:0 4px;">
          <option value="">Presets…</option>
          <option value="procedural_stone">Noise + ColorRamp + Bump</option>
          <option value="fresnel_rim">Fresnel + Voronoi Coated</option>
          <option value="default">Principled Default</option>
        </select>
        <button type="button" id="sg-btn-frame" class="uv-btn" title="Reset Pan & Zoom">Frame</button>
        <button type="button" id="sg-btn-delete" class="uv-btn" title="Delete Selected Node (Del)">Delete</button>
      </div>
      <div id="sg-stage" style="position:relative;flex:1;overflow:hidden;background-image:radial-gradient(circle,#2f323b 1px,transparent 1px);background-size:20px 20px;cursor:default;">
        <svg id="sg-wire-svg" style="position:absolute;inset:0;width:100%;height:100%;pointer-events:none;overflow:visible;"></svg>
        <div id="sg-world" style="position:absolute;left:0;top:0;transform-origin:0 0;"></div>
      </div>
    `;

    this.container.appendChild(root);
    this.rootEl = root;
    this.stageEl = root.querySelector('#sg-stage');
    this.worldEl = root.querySelector('#sg-world');
    this.svgEl = root.querySelector('#sg-wire-svg');
    this.matBadgeEl = root.querySelector('#sg-active-mat-name');
  }

  _bindEvents() {
    if (!this.rootEl) return;

    this.rootEl.querySelector('#sg-add-node-select')?.addEventListener('change', (e) => {
      const type = e.target.value;
      if (!type) return;
      e.target.value = '';
      if (!this.graph) this.ensureGraphOnSelection();
      if (!this.graph) return;
      const cx = (180 - this.panX) / this.zoom;
      const cy = (120 - this.panY) / this.zoom;
      const n = this.graph.addNode(type, cx + Math.random() * 40, cy + Math.random() * 40);
      this.selectedNodeId = n.id;
      this.applyAndRender();
    });

    this.rootEl.querySelector('#sg-preset-select')?.addEventListener('change', (e) => {
      const p = e.target.value;
      if (!p) return;
      e.target.value = '';
      this.applyPresetGraph(p);
    });

    this.rootEl.querySelector('#sg-btn-frame')?.addEventListener('click', () => {
      this.panX = 40;
      this.panY = 40;
      this.zoom = 1.0;
      this.render();
    });

    this.rootEl.querySelector('#sg-btn-delete')?.addEventListener('click', () => {
      if (this.graph && this.selectedNodeId) {
        if (this.graph.removeNode(this.selectedNodeId)) {
          this.selectedNodeId = null;
          this.applyAndRender();
        }
      }
    });

    if (this.stageEl) {
      this.stageEl.addEventListener('wheel', (e) => {
        e.preventDefault();
        const factor = e.deltaY < 0 ? 1.1 : 0.9;
        const rect = this.stageEl.getBoundingClientRect();
        const mx = e.clientX - rect.left;
        const my = e.clientY - rect.top;
        const nextZoom = Math.max(0.35, Math.min(2.2, this.zoom * factor));
        this.panX = mx - (mx - this.panX) * (nextZoom / this.zoom);
        this.panY = my - (my - this.panY) * (nextZoom / this.zoom);
        this.zoom = nextZoom;
        this._applyTransform();
        this._renderWires();
      }, { passive: false });

      this.stageEl.addEventListener('pointerdown', (e) => {
        if (e.button === 1 || (e.button === 0 && e.altKey) || e.target === this.stageEl) {
          this._panDrag = { startX: e.clientX, startY: e.clientY, origPanX: this.panX, origPanY: this.panY };
          this.stageEl.setPointerCapture?.(e.pointerId);
        }
      });

      this.stageEl.addEventListener('pointermove', (e) => {
        if (this._panDrag) {
          this.panX = this._panDrag.origPanX + (e.clientX - this._panDrag.startX);
          this.panY = this._panDrag.origPanY + (e.clientY - this._panDrag.startY);
          this._applyTransform();
          this._renderWires();
          return;
        }
        if (this._dragNode) {
          const dx = (e.clientX - this._dragNode.startX) / this.zoom;
          const dy = (e.clientY - this._dragNode.startY) / this.zoom;
          const node = this.graph?.nodes.get(this._dragNode.nodeId);
          if (node) {
            node.x = Math.round(this._dragNode.origX + dx);
            node.y = Math.round(this._dragNode.origY + dy);
            const el = this._nodeEls.get(node.id);
            if (el) {
              el.style.left = `${node.x}px`;
              el.style.top = `${node.y}px`;
            }
            this._renderWires();
          }
          return;
        }
        if (this._wireDrag) {
          const rect = this.stageEl.getBoundingClientRect();
          this._wireDrag.curX = e.clientX - rect.left;
          this._wireDrag.curY = e.clientY - rect.top;
          this._renderWires();
        }
      });

      const stopDrag = (e) => {
        if (this._wireDrag) {
          const target = document.elementFromPoint(e.clientX, e.clientY);
          const inSock = target?.closest?.('[data-socket-dir="in"]');
          if (inSock && this.graph) {
            const toNode = inSock.dataset.nodeId;
            const toSocket = inSock.dataset.socketId;
            if (this.graph.connect(this._wireDrag.fromNode, this._wireDrag.fromSocket, toNode, toSocket)) {
              this.applyAndRender();
            } else {
              this._renderWires();
            }
          }
          this._wireDrag = null;
          this._renderWires();
        }
        this._dragNode = null;
        this._panDrag = null;
      };
      this.stageEl.addEventListener('pointerup', stopDrag);
      this.stageEl.addEventListener('pointercancel', stopDrag);
    }

    if (this.sceneManager?.on) {
      this.sceneManager.on('selectionChanged', () => this.syncFromSelection());
    }
  }

  ensureGraphOnSelection() {
    const obj = this.sceneManager?.getActiveObject();
    let mesh = obj?.isMesh ? obj : null;
    if (!mesh && obj?.traverse) {
      obj.traverse((c) => { if (!mesh && c.isMesh) mesh = c; });
    }
    if (!mesh) return null;
    if (!mesh.material || (Array.isArray(mesh.material) && !mesh.material[0])) {
      mesh.material = new THREE.MeshPhysicalMaterial({ color: 0xcccccc, roughness: 0.5 });
    }
    const mat = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
    let g = getShaderGraphForMaterial(mat);
    if (!g) {
      g = ShaderGraph.createDefault();
      setShaderGraphForMaterial(mat, g);
      applyShaderGraphToMaterial(mat, g);
    }
    this.targetMesh = mesh;
    this.targetMaterial = mat;
    this.graph = g;
    return g;
  }

  syncFromSelection() {
    const obj = this.sceneManager?.getActiveObject();
    let mesh = obj?.isMesh ? obj : null;
    if (!mesh && obj?.traverse) {
      obj.traverse((c) => { if (!mesh && c.isMesh) mesh = c; });
    }
    this.targetMesh = mesh;
    const mat = mesh ? (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material) : null;
    this.targetMaterial = mat;
    // IMPORTANT: Never write a blank default ShaderGraph onto `mat.userData.shaderGraphJson`
    // merely from selecting an object — doing so overwrites textured PBR materials on save/reload or Path Tracing!
    const existingGraph = mat ? getShaderGraphForMaterial(mat) : null;
    this.graph = existingGraph || (mat ? ShaderGraph.createDefault() : null);
    if (this.matBadgeEl) {
      this.matBadgeEl.textContent = mat ? (mat.name || 'Material') : 'No Material';
    }
    this.render();
  }

  applyPresetGraph(presetName) {
    if (!this.targetMaterial) this.ensureGraphOnSelection();
    if (!this.targetMaterial) return;
    const g = ShaderGraph.createDefault();
    const bsdf = Array.from(g.nodes.values()).find((n) => n.type === 'PrincipledBSDF');
    if (presetName === 'procedural_stone' && bsdf) {
      const uv = g.addNode('UVMap', 20, 120);
      const noise = g.addNode('NoiseTexture', 150, 80, { scale: 9.0, detail: 5, roughness: 0.6 });
      const ramp = g.addNode('ColorRamp', 310, 40, {
        stops: [
          { pos: 0.25, color: '#2b2d34', alpha: 1 },
          { pos: 0.6, color: '#787d8a', alpha: 1 },
          { pos: 0.9, color: '#d0d5dd', alpha: 1 },
        ],
      });
      const bump = g.addNode('Bump', 310, 220, { strength: 0.65, distance: 0.12 });
      bsdf.x = 500;
      bsdf.y = 80;
      const out = Array.from(g.nodes.values()).find((n) => n.type === 'MaterialOutput');
      if (out) { out.x = 760; out.y = 80; }
      g.connect(uv.id, 'uv', noise.id, 'vector');
      g.connect(noise.id, 'fac', ramp.id, 'fac');
      g.connect(ramp.id, 'color', bsdf.id, 'baseColor');
      g.connect(noise.id, 'fac', bump.id, 'height');
      g.connect(bump.id, 'normal', bsdf.id, 'normal');
    } else if (presetName === 'fresnel_rim' && bsdf) {
      const vor = g.addNode('VoronoiTexture', 80, 60, { scale: 12.0, randomness: 0.9 });
      const fres = g.addNode('Fresnel', 80, 220, { ior: 1.55 });
      const mix = g.addNode('Mix', 280, 80, { blendMode: 'MIX', a: '#1d4ed8', b: '#f43f5e' });
      bsdf.x = 500;
      const out = Array.from(g.nodes.values()).find((n) => n.type === 'MaterialOutput');
      if (out) out.x = 760;
      g.connect(fres.id, 'fac', mix.id, 'fac');
      g.connect(vor.id, 'color', mix.id, 'a');
      g.connect(mix.id, 'result', bsdf.id, 'baseColor');
    }
    this.graph = g;
    this.applyAndRender(true);
  }

  applyAndRender(forceRecompile = false) {
    if (this.targetMaterial && this.graph) {
      applyShaderGraphToMaterial(this.targetMaterial, this.graph, { forceRecompile });
      this.sceneManager?.markDirty?.();
      this.engine?.render?.();
    }
    this.render();
  }

  _applyTransform() {
    if (this.worldEl) {
      this.worldEl.style.transform = `translate(${this.panX}px, ${this.panY}px) scale(${this.zoom})`;
    }
  }

  render() {
    if (!this.worldEl || !this.svgEl) return;
    this.worldEl.innerHTML = '';
    this._nodeEls.clear();
    this._applyTransform();

    if (!this.graph) {
      this.svgEl.innerHTML = '';
      return;
    }

    for (const node of this.graph.nodes.values()) {
      const el = this._buildNodeEl(node);
      this.worldEl.appendChild(el);
      this._nodeEls.set(node.id, el);
    }

    requestAnimationFrame(() => this._renderWires());
  }

  _buildNodeEl(node) {
    const def = SHADER_NODE_DEFS[node.type];
    const el = document.createElement('div');
    const isSel = this.selectedNodeId === node.id;
    el.className = 'sg-node';
    el.dataset.nodeId = node.id;
    el.style.cssText = `position:absolute;left:${node.x}px;top:${node.y}px;width:190px;background:#25272e;border:1px solid ${isSel ? '#f59e0b' : '#3d414d'};border-radius:6px;box-shadow:0 4px 12px rgba(0,0,0,0.45);overflow:visible;`;

    const hdr = document.createElement('div');
    hdr.style.cssText = `padding:4px 8px;background:${def.color};color:#fff;font-weight:600;border-radius:5px 5px 0 0;cursor:grab;display:flex;justify-content:space-between;align-items:center;`;
    hdr.textContent = def.label;
    hdr.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      this.selectedNodeId = node.id;
      this._dragNode = { nodeId: node.id, startX: e.clientX, startY: e.clientY, origX: node.x, origY: node.y };
      this.worldEl.querySelectorAll('.sg-node').forEach((n) => {
        n.style.borderColor = n.dataset.nodeId === node.id ? '#f59e0b' : '#3d414d';
      });
    });
    el.appendChild(hdr);

    const body = document.createElement('div');
    body.style.cssText = 'padding:6px 8px;display:flex;flex-direction:column;gap:5px;';

    // Outputs
    for (const out of def.outputs) {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;justify-content:flex-end;align-items:center;gap:6px;position:relative;';
      row.innerHTML = `<span>${out.label}</span><span class="sg-socket" data-socket-dir="out" data-node-id="${node.id}" data-socket-id="${out.id}" style="width:10px;height:10px;border-radius:50%;background:${SOCKET_COLORS[out.type] || '#ccc'};border:1px solid #111;margin-right:-13px;cursor:crosshair;pointer-events:auto;"></span>`;
      row.querySelector('.sg-socket').addEventListener('pointerdown', (e) => {
        e.stopPropagation();
        const rect = this.stageEl.getBoundingClientRect();
        this._wireDrag = {
          fromNode: node.id,
          fromSocket: out.id,
          startX: e.clientX - rect.left,
          startY: e.clientY - rect.top,
          curX: e.clientX - rect.left,
          curY: e.clientY - rect.top,
        };
      });
      body.appendChild(row);
    }

    // Node-specific inline properties (enums / ColorRamp / scale sliders)
    this._appendNodePropertyControls(body, node);

    // Inputs
    for (const inp of def.inputs) {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;gap:6px;position:relative;';
      const dot = document.createElement('span');
      dot.className = 'sg-socket';
      dot.dataset.socketDir = 'in';
      dot.dataset.nodeId = node.id;
      dot.dataset.socketId = inp.id;
      dot.title = 'Drop wire to connect, click to disconnect';
      dot.style.cssText = `width:10px;height:10px;border-radius:50%;background:${SOCKET_COLORS[inp.type] || '#ccc'};border:1px solid #111;margin-left:-13px;cursor:pointer;flex-shrink:0;`;
      dot.addEventListener('click', (e) => {
        e.stopPropagation();
        if (this.graph.disconnect(node.id, inp.id)) this.applyAndRender();
      });
      row.appendChild(dot);
      const lbl = document.createElement('span');
      lbl.textContent = inp.label;
      lbl.style.flex = '1';
      row.appendChild(lbl);

      // Show inline widget if input isn't wired
      if (!this.graph.getInputLink(node.id, inp.id) && inp.defaultValue !== undefined) {
        this._appendInlineSocketWidget(row, node, inp);
      }
      body.appendChild(row);
    }

    el.appendChild(body);
    return el;
  }

  _appendNodePropertyControls(body, node) {
    const p = node.props;
    const addSlider = (label, key, min, max, step) => {
      const wrap = document.createElement('label');
      wrap.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:4px;font-size:10px;color:#b0b5c0;';
      wrap.innerHTML = `<span>${label}</span><input type="range" min="${min}" max="${max}" step="${step}" value="${p[key] ?? min}" style="width:90px;height:4px;">`;
      wrap.querySelector('input').addEventListener('input', (e) => {
        this.graph.updateNodeProps(node.id, { [key]: parseFloat(e.target.value) });
        if (this.targetMaterial) {
          updateShaderGraphUniforms(this.targetMaterial, this.graph);
          this.sceneManager?.markDirty?.();
          this.engine?.render?.();
        }
      });
      body.appendChild(wrap);
    };

    if (node.type === 'NoiseTexture') {
      addSlider('Scale', 'scale', 0.5, 40, 0.5);
      addSlider('Detail', 'detail', 1, 8, 1);
      addSlider('Rough', 'roughness', 0, 1, 0.05);
    } else if (node.type === 'VoronoiTexture') {
      addSlider('Scale', 'scale', 0.5, 40, 0.5);
      addSlider('Random', 'randomness', 0, 1, 0.05);
    } else if (node.type === 'Mix') {
      const sel = document.createElement('select');
      sel.style.cssText = 'background:#1b1d22;color:#ddd;border:1px solid #3c404d;border-radius:3px;font-size:10px;';
      ['MIX', 'MULTIPLY', 'ADD', 'SCREEN'].forEach((m) => {
        const opt = document.createElement('option');
        opt.value = m; opt.textContent = m;
        if (p.blendMode === m) opt.selected = true;
        sel.appendChild(opt);
      });
      sel.addEventListener('change', () => {
        this.graph.updateNodeProps(node.id, { blendMode: sel.value });
        this.applyAndRender();
      });
      body.appendChild(sel);
    } else if (node.type === 'Math') {
      const sel = document.createElement('select');
      sel.style.cssText = 'background:#1b1d22;color:#ddd;border:1px solid #3c404d;border-radius:3px;font-size:10px;';
      ['ADD', 'SUBTRACT', 'MULTIPLY', 'DIVIDE', 'POWER', 'SINE', 'MIN', 'MAX', 'LESS_THAN', 'MULTIPLY_ADD'].forEach((m) => {
        const opt = document.createElement('option');
        opt.value = m; opt.textContent = m;
        if (p.operation === m) opt.selected = true;
        sel.appendChild(opt);
      });
      sel.addEventListener('change', () => {
        this.graph.updateNodeProps(node.id, { operation: sel.value });
        this.applyAndRender();
      });
      body.appendChild(sel);
    } else if (node.type === 'Bump') {
      addSlider('Dist', 'distance', 0.01, 1.0, 0.01);
    } else if (node.type === 'ColorRamp' && Array.isArray(p.stops)) {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;gap:4px;';
      p.stops.forEach((st, idx) => {
        const ci = document.createElement('input');
        ci.type = 'color';
        ci.value = st.color || '#ffffff';
        ci.style.cssText = 'width:24px;height:18px;padding:0;border:none;background:transparent;cursor:pointer;';
        ci.addEventListener('input', () => {
          p.stops[idx].color = ci.value;
          this.graph.updateNodeProps(node.id, { stops: p.stops });
          if (this.targetMaterial) {
            updateShaderGraphUniforms(this.targetMaterial, this.graph);
            this.sceneManager?.markDirty?.();
            this.engine?.render?.();
          }
        });
        row.appendChild(ci);
      });
      body.appendChild(row);
    }
  }

  _appendInlineSocketWidget(row, node, inp) {
    const val = node.props[inp.id] ?? inp.defaultValue;
    if (inp.type === 'vec3' && typeof val === 'string') {
      const ci = document.createElement('input');
      ci.type = 'color';
      ci.value = val;
      ci.style.cssText = 'width:26px;height:16px;padding:0;border:none;background:transparent;cursor:pointer;';
      ci.addEventListener('input', () => {
        this.graph.updateNodeProps(node.id, { [inp.id]: ci.value });
        if (this.targetMaterial) {
          updateShaderGraphUniforms(this.targetMaterial, this.graph);
          this.sceneManager?.markDirty?.();
          this.engine?.render?.();
        }
      });
      row.appendChild(ci);
    } else if (inp.type === 'float') {
      const ni = document.createElement('input');
      ni.type = 'number';
      ni.step = '0.05';
      ni.value = String(val);
      ni.style.cssText = 'width:46px;height:16px;background:#181a1f;color:#eee;border:1px solid #3c404d;border-radius:3px;font-size:10px;padding:0 3px;';
      ni.addEventListener('input', () => {
        const num = parseFloat(ni.value);
        if (Number.isFinite(num)) {
          this.graph.updateNodeProps(node.id, { [inp.id]: num });
          if (this.targetMaterial) {
            updateShaderGraphUniforms(this.targetMaterial, this.graph);
            this.sceneManager?.markDirty?.();
            this.engine?.render?.();
          }
        }
      });
      row.appendChild(ni);
    }
  }

  _renderWires() {
    if (!this.svgEl || !this.stageEl || !this.graph) return;
    const stageRect = this.stageEl.getBoundingClientRect();
    const paths = [];

    const socketPos = (nid, dir, sid) => {
      const el = this.worldEl.querySelector(`.sg-socket[data-node-id="${nid}"][data-socket-dir="${dir}"][data-socket-id="${sid}"]`);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return {
        x: r.left + r.width * 0.5 - stageRect.left,
        y: r.top + r.height * 0.5 - stageRect.top,
      };
    };

    const bezier = (x0, y0, x1, y1, color = '#94a3b8') => {
      const dx = Math.max(40, Math.abs(x1 - x0) * 0.5);
      return `<path d="M${x0},${y0} C${x0 + dx},${y0} ${x1 - dx},${y1} ${x1},${y1}" stroke="${color}" stroke-width="2.2" fill="none" stroke-linecap="round"/>`;
    };

    for (const l of this.graph.links) {
      const p0 = socketPos(l.fromNode, 'out', l.fromSocket);
      const p1 = socketPos(l.toNode, 'in', l.toSocket);
      if (p0 && p1) paths.push(bezier(p0.x, p0.y, p1.x, p1.y, '#e2e8f0'));
    }

    if (this._wireDrag) {
      paths.push(bezier(this._wireDrag.startX, this._wireDrag.startY, this._wireDrag.curX, this._wireDrag.curY, '#f59e0b'));
    }

    this.svgEl.innerHTML = paths.join('');
  }
}

export default ShaderNodeEditorUI;
