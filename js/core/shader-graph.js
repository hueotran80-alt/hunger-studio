/**
 * Shader Node Graph IR, Topological Compiler to Stackless VM Bytecode (`render_kernel::node_vm`),
 * Cycle Detection, Serialization, and Pure JS CPU Evaluator.
 * File: js/core/shader-graph.js
 */

import * as THREE from 'three';

export const INSTR_STRIDE = 8;
export const NO_REG = 255;

export const OP = {
  CONST_VEC4: 0,
  UV: 1,
  NOISE: 2,
  VORONOI: 3,
  COLOR_RAMP: 4,
  MIX: 5,
  MATH: 6,
  FRESNEL: 7,
  LAYER_WEIGHT: 8,
  TEX_IMAGE: 9,
  BUMP: 10,
  NORMAL_MAP: 11,
  SET_OUT: 12,
};

export const MIX_MODE = { MIX: 0, MULTIPLY: 1, ADD: 2, SCREEN: 3 };
export const MATH_MODE = {
  ADD: 0, SUBTRACT: 1, MULTIPLY: 2, DIVIDE: 3, POWER: 4,
  SINE: 5, MIN: 6, MAX: 7, LESS_THAN: 8, SMOOTH_MIN: 9, MULTIPLY_ADD: 10,
};

export const SHADER_NODE_DEFS = {
  UVMap: {
    label: 'UV Map',
    category: 'Input',
    color: '#8f3f4a',
    inputs: [],
    outputs: [{ id: 'uv', label: 'UV', type: 'vec2' }],
    defaults: { channel: 0, repeatX: 1, repeatY: 1, offsetX: 0, offsetY: 0 },
  },
  ImageTexture: {
    label: 'Image Texture',
    category: 'Texture',
    color: '#b55b26',
    inputs: [{ id: 'vector', label: 'Vector', type: 'vec2' }],
    outputs: [
      { id: 'color', label: 'Color', type: 'vec3' },
      { id: 'alpha', label: 'Alpha', type: 'float' },
    ],
    defaults: { textureId: '', slot: 'baseColor', texIndex: -1, srgb: true },
  },
  NoiseTexture: {
    label: 'Noise Texture',
    category: 'Texture',
    color: '#b55b26',
    inputs: [{ id: 'vector', label: 'Vector', type: 'vec2' }],
    outputs: [
      { id: 'fac', label: 'Fac', type: 'float' },
      { id: 'color', label: 'Color', type: 'vec3' },
    ],
    defaults: { scale: 6.0, detail: 4, roughness: 0.5, seed: 42 },
  },
  VoronoiTexture: {
    label: 'Voronoi Texture',
    category: 'Texture',
    color: '#b55b26',
    inputs: [{ id: 'vector', label: 'Vector', type: 'vec2' }],
    outputs: [
      { id: 'distance', label: 'Distance', type: 'float' },
      { id: 'color', label: 'Color', type: 'vec3' },
    ],
    defaults: { scale: 6.0, randomness: 1.0 },
  },
  ColorRamp: {
    label: 'ColorRamp',
    category: 'Converter',
    color: '#5a5f2a',
    inputs: [{ id: 'fac', label: 'Fac', type: 'float', defaultValue: 0.5 }],
    outputs: [
      { id: 'color', label: 'Color', type: 'vec3' },
      { id: 'alpha', label: 'Alpha', type: 'float' },
    ],
    defaults: {
      stops: [
        { pos: 0.0, color: '#1a1c22', alpha: 1.0 },
        { pos: 1.0, color: '#f2f4f8', alpha: 1.0 },
      ],
    },
  },
  Mix: {
    label: 'Mix Color',
    category: 'Color',
    color: '#6b6428',
    inputs: [
      { id: 'fac', label: 'Factor', type: 'float', defaultValue: 0.5 },
      { id: 'a', label: 'A', type: 'vec3', defaultValue: '#1e293b' },
      { id: 'b', label: 'B', type: 'vec3', defaultValue: '#e2e8f0' },
    ],
    outputs: [{ id: 'result', label: 'Result', type: 'vec3' }],
    defaults: { blendMode: 'MIX', clamp: true },
  },
  Math: {
    label: 'Math',
    category: 'Converter',
    color: '#3c5f80',
    inputs: [
      { id: 'a', label: 'Value', type: 'float', defaultValue: 0.5 },
      { id: 'b', label: 'Value', type: 'float', defaultValue: 0.5 },
      { id: 'c', label: 'Value', type: 'float', defaultValue: 0.0 },
    ],
    outputs: [{ id: 'value', label: 'Value', type: 'float' }],
    defaults: { operation: 'MULTIPLY', clamp: false },
  },
  Fresnel: {
    label: 'Fresnel',
    category: 'Input',
    color: '#8f3f4a',
    inputs: [{ id: 'ior', label: 'IOR', type: 'float', defaultValue: 1.45 }],
    outputs: [{ id: 'fac', label: 'Fac', type: 'float' }],
    defaults: { ior: 1.45 },
  },
  LayerWeight: {
    label: 'Layer Weight',
    category: 'Input',
    color: '#8f3f4a',
    inputs: [{ id: 'blend', label: 'Blend', type: 'float', defaultValue: 0.5 }],
    outputs: [
      { id: 'fresnel', label: 'Fresnel', type: 'float' },
      { id: 'facing', label: 'Facing', type: 'float' },
    ],
    defaults: { blend: 0.5 },
  },
  Bump: {
    label: 'Bump',
    category: 'Vector',
    color: '#5a4387',
    inputs: [
      { id: 'height', label: 'Height', type: 'float', defaultValue: 0.0 },
      { id: 'strength', label: 'Strength', type: 'float', defaultValue: 0.5 },
    ],
    outputs: [{ id: 'normal', label: 'Normal', type: 'vec3' }],
    defaults: { strength: 0.5, distance: 0.1 },
  },
  NormalMap: {
    label: 'Normal Map',
    category: 'Vector',
    color: '#5a4387',
    inputs: [
      { id: 'color', label: 'Color', type: 'vec3', defaultValue: '#8080ff' },
      { id: 'strength', label: 'Strength', type: 'float', defaultValue: 1.0 },
    ],
    outputs: [{ id: 'normal', label: 'Normal', type: 'vec3' }],
    defaults: { strength: 1.0 },
  },
  PrincipledBSDF: {
    label: 'Principled BSDF',
    category: 'Shader',
    color: '#2c6b42',
    inputs: [
      { id: 'baseColor', label: 'Base Color', type: 'vec3', defaultValue: '#cccccc' },
      { id: 'metallic', label: 'Metallic', type: 'float', defaultValue: 0.0 },
      { id: 'roughness', label: 'Roughness', type: 'float', defaultValue: 0.5 },
      { id: 'emission', label: 'Emission Color', type: 'vec3', defaultValue: '#000000' },
      { id: 'emissionStrength', label: 'Emission Strength', type: 'float', defaultValue: 0.0 },
      { id: 'alpha', label: 'Alpha', type: 'float', defaultValue: 1.0 },
      { id: 'normal', label: 'Normal', type: 'vec3' },
    ],
    outputs: [{ id: 'bsdf', label: 'BSDF', type: 'shader' }],
    defaults: {
      baseColor: '#cccccc',
      metallic: 0.0,
      roughness: 0.5,
      emission: '#000000',
      emissionStrength: 0.0,
      alpha: 1.0,
    },
  },
  MaterialOutput: {
    label: 'Material Output',
    category: 'Output',
    color: '#6b2525',
    inputs: [{ id: 'surface', label: 'Surface', type: 'shader' }],
    outputs: [],
    defaults: {},
  },
};

function hexToLinearRgb(hex) {
  const c = new THREE.Color(hex || '#ffffff');
  return [c.r, c.g, c.b];
}

export class ShaderGraph {
  constructor(data = null) {
    this.id = data?.id || `sg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    this.version = 1;
    this.topologyRevision = 1;
    this.paramRevision = 1;
    this.nodes = new Map();
    this.links = []; // { id, fromNode, fromSocket, toNode, toSocket }
    this._nextNodeNum = 1;

    if (data && Array.isArray(data.nodes) && data.nodes.length > 0) {
      for (const n of data.nodes) {
        const def = SHADER_NODE_DEFS[n.type];
        if (!def) continue;
        this.nodes.set(n.id, {
          id: n.id,
          type: n.type,
          x: Number(n.x || 0),
          y: Number(n.y || 0),
          props: { ...structuredClone(def.defaults), ...(n.props || {}) },
        });
        const match = /(\d+)$/.exec(n.id);
        if (match) this._nextNodeNum = Math.max(this._nextNodeNum, parseInt(match[1], 10) + 1);
      }
      if (Array.isArray(data.links)) {
        for (const l of data.links) {
          this.connect(l.fromNode, l.fromSocket, l.toNode, l.toSocket, { bumpRevision: false });
        }
      }
    }
  }

  static createDefault() {
    const g = new ShaderGraph();
    const bsdf = g.addNode('PrincipledBSDF', 260, 120);
    const out = g.addNode('MaterialOutput', 540, 120);
    g.connect(bsdf.id, 'bsdf', out.id, 'surface');
    g.topologyRevision = 1;
    g.paramRevision = 1;
    return g;
  }

  addNode(type, x = 80, y = 80, props = {}) {
    const def = SHADER_NODE_DEFS[type];
    if (!def) throw new Error(`Unknown shader node type: ${type}`);
    const id = `n${this._nextNodeNum++}`;
    const node = {
      id,
      type,
      x: Number(x || 0),
      y: Number(y || 0),
      props: { ...structuredClone(def.defaults), ...structuredClone(props) },
    };
    this.nodes.set(id, node);
    this.topologyRevision++;
    this.paramRevision++;
    return node;
  }

  removeNode(nodeId) {
    const n = this.nodes.get(nodeId);
    if (!n || n.type === 'MaterialOutput') return false;
    this.nodes.delete(nodeId);
    this.links = this.links.filter((l) => l.fromNode !== nodeId && l.toNode !== nodeId);
    this.topologyRevision++;
    this.paramRevision++;
    return true;
  }

  updateNodeProps(nodeId, partial) {
    const n = this.nodes.get(nodeId);
    if (!n) return false;
    Object.assign(n.props, partial);
    // ColorRamp stop count alters const table layout / loop unroll in GLSL
    if (partial.stops || partial.blendMode || partial.operation) {
      this.topologyRevision++;
    }
    this.paramRevision++;
    return true;
  }

  hasPath(startNodeId, targetNodeId) {
    if (startNodeId === targetNodeId) return true;
    const visited = new Set();
    const stack = [startNodeId];
    while (stack.length > 0) {
      const cur = stack.pop();
      if (cur === targetNodeId) return true;
      if (visited.has(cur)) continue;
      visited.add(cur);
      for (const l of this.links) {
        if (l.fromNode === cur) stack.push(l.toNode);
      }
    }
    return false;
  }

  connect(fromNodeId, fromSocket, toNodeId, toSocket, opts = {}) {
    const fromN = this.nodes.get(fromNodeId);
    const toN = this.nodes.get(toNodeId);
    if (!fromN || !toN || fromNodeId === toNodeId) return false;
    const fromDef = SHADER_NODE_DEFS[fromN.type];
    const toDef = SHADER_NODE_DEFS[toN.type];
    if (!fromDef?.outputs?.some((o) => o.id === fromSocket)) return false;
    if (!toDef?.inputs?.some((i) => i.id === toSocket)) return false;

    // Cycle check: if `toNode` already reaches `fromNode`, connecting `fromNode -> toNode` would form a loop
    if (this.hasPath(toNodeId, fromNodeId)) return false;

    // Replace existing link bound to (toNodeId, toSocket)
    this.links = this.links.filter((l) => !(l.toNode === toNodeId && l.toSocket === toSocket));
    this.links.push({
      id: `lnk_${fromNodeId}_${fromSocket}_${toNodeId}_${toSocket}`,
      fromNode: fromNodeId,
      fromSocket,
      toNode: toNodeId,
      toSocket,
    });
    if (opts.bumpRevision !== false) {
      this.topologyRevision++;
      this.paramRevision++;
    }
    return true;
  }

  disconnect(toNodeId, toSocket) {
    const before = this.links.length;
    this.links = this.links.filter((l) => !(l.toNode === toNodeId && l.toSocket === toSocket));
    if (this.links.length !== before) {
      this.topologyRevision++;
      this.paramRevision++;
      return true;
    }
    return false;
  }

  getInputLink(nodeId, socketId) {
    return this.links.find((l) => l.toNode === nodeId && l.toSocket === socketId) || null;
  }

  /**
   * Returns nodes reachable from MaterialOutput in topological dependency order.
   */
  topologicalOrder() {
    let outNode = null;
    for (const n of this.nodes.values()) {
      if (n.type === 'MaterialOutput') { outNode = n; break; }
    }
    if (!outNode) return [];

    const ordered = [];
    const state = new Map(); // 1=visiting, 2=done
    const visit = (nid) => {
      const st = state.get(nid) || 0;
      if (st === 2) return;
      if (st === 1) return; // safety guard
      state.set(nid, 1);
      const node = this.nodes.get(nid);
      if (node) {
        const def = SHADER_NODE_DEFS[node.type];
        for (const inp of def.inputs) {
          const lnk = this.getInputLink(nid, inp.id);
          if (lnk) visit(lnk.fromNode);
        }
        ordered.push(node);
      }
      state.set(nid, 2);
    };
    visit(outNode.id);
    return ordered;
  }

  /**
   * Compiles topological graph into stackless 8-word bytecode matching `crates/render_kernel/src/node_vm.rs`.
   */
  compileToBytecode(resolveTexId = null) {
    const order = this.topologicalOrder();
    const ops = [];
    const consts = [];
    const socketReg = new Map(); // `${nodeId}:${socket}` -> regIdx
    let nextReg = 0;

    const allocReg = () => (nextReg < 64 ? nextReg++ : 63);
    const pushConst = (...vals) => {
      const off = consts.length;
      for (const v of vals) consts.push(Number(v) || 0);
      return off;
    };
    const emit = (op, dst = 0, a0 = 0, a1 = 0, a2 = 0, a3 = 0, fOff = 0, flags = 0) => {
      ops.push(op >>> 0, dst >>> 0, a0 >>> 0, a1 >>> 0, a2 >>> 0, a3 >>> 0, fOff >>> 0, flags >>> 0);
      return (ops.length / INSTR_STRIDE) - 1;
    };
    const inReg = (nid, socket) => {
      const lnk = this.getInputLink(nid, socket);
      if (!lnk) return NO_REG;
      const r = socketReg.get(`${lnk.fromNode}:${lnk.fromSocket}`);
      return r === undefined ? NO_REG : r;
    };

    for (const node of order) {
      const p = node.props || {};
      switch (node.type) {
        case 'UVMap': {
          const r = allocReg();
          const fOff = pushConst(p.repeatX ?? 1, p.repeatY ?? 1, p.offsetX ?? 0, p.offsetY ?? 0);
          emit(OP.UV, r, 0, 0, 0, 0, fOff, p.channel === 1 ? 1 : 0);
          socketReg.set(`${node.id}:uv`, r);
          break;
        }
        case 'ImageTexture': {
          const rCol = allocReg();
          const rAlp = allocReg();
          const rVec = inReg(node.id, 'vector');
          const resolvedId = typeof resolveTexId === 'function' ? resolveTexId(node) : (p.texIndex ?? -1);
          emit(OP.TEX_IMAGE, rCol, rVec, rAlp, 0, 0, 0, resolvedId < 0 ? 0xFFFF_FFFF : resolvedId);
          socketReg.set(`${node.id}:color`, rCol);
          socketReg.set(`${node.id}:alpha`, rAlp);
          break;
        }
        case 'NoiseTexture': {
          const r = allocReg();
          const rVec = inReg(node.id, 'vector');
          const fOff = pushConst(p.scale ?? 6.0, p.detail ?? 4, p.roughness ?? 0.5, p.seed ?? 42);
          emit(OP.NOISE, r, rVec, 0, 0, 0, fOff, 0);
          socketReg.set(`${node.id}:fac`, r);
          socketReg.set(`${node.id}:color`, r);
          break;
        }
        case 'VoronoiTexture': {
          const rDist = allocReg();
          const rCol = allocReg();
          const rVec = inReg(node.id, 'vector');
          const fOff = pushConst(p.scale ?? 6.0, p.randomness ?? 1.0);
          emit(OP.VORONOI, rDist, rVec, rCol, 0, 0, fOff, 0);
          socketReg.set(`${node.id}:distance`, rDist);
          socketReg.set(`${node.id}:color`, rCol);
          break;
        }
        case 'ColorRamp': {
          const r = allocReg();
          const rFac = inReg(node.id, 'fac');
          const stops = (Array.isArray(p.stops) && p.stops.length > 0 ? p.stops : [
            { pos: 0, color: '#000000', alpha: 1 },
            { pos: 1, color: '#ffffff', alpha: 1 },
          ]).slice().sort((a, b) => a.pos - b.pos);
          const fOff = pushConst(p.fac ?? 0.5);
          for (const st of stops) {
            const rgb = hexToLinearRgb(st.color);
            pushConst(st.pos ?? 0, rgb[0], rgb[1], rgb[2], st.alpha ?? 1);
          }
          emit(OP.COLOR_RAMP, r, rFac, 0, 0, 0, fOff, stops.length);
          socketReg.set(`${node.id}:color`, r);
          socketReg.set(`${node.id}:alpha`, r);
          break;
        }
        case 'Mix': {
          const r = allocReg();
          const rFac = inReg(node.id, 'fac');
          const rA = inReg(node.id, 'a');
          const rB = inReg(node.id, 'b');
          const rgbA = hexToLinearRgb(p.a ?? '#1e293b');
          const rgbB = hexToLinearRgb(p.b ?? '#e2e8f0');
          const fOff = pushConst(p.fac ?? 0.5, rgbA[0], rgbA[1], rgbA[2], 1, rgbB[0], rgbB[1], rgbB[2], 1);
          const flags = (MIX_MODE[p.blendMode] ?? 0) | (p.clamp !== false ? 256 : 0);
          emit(OP.MIX, r, rFac, rA, rB, 0, fOff, flags);
          socketReg.set(`${node.id}:result`, r);
          break;
        }
        case 'Math': {
          const r = allocReg();
          const rA = inReg(node.id, 'a');
          const rB = inReg(node.id, 'b');
          const rC = inReg(node.id, 'c');
          const fOff = pushConst(p.a ?? 0.5, p.b ?? 0.5, p.c ?? 0.0);
          const flags = (MATH_MODE[p.operation] ?? 0) | (p.clamp ? 256 : 0);
          emit(OP.MATH, r, rA, rB, rC, 0, fOff, flags);
          socketReg.set(`${node.id}:value`, r);
          break;
        }
        case 'Fresnel': {
          const r = allocReg();
          const rIor = inReg(node.id, 'ior');
          const fOff = pushConst(p.ior ?? 1.45);
          emit(OP.FRESNEL, r, rIor, 0, 0, 0, fOff, 0);
          socketReg.set(`${node.id}:fac`, r);
          break;
        }
        case 'LayerWeight': {
          const rFres = allocReg();
          const rFac = allocReg();
          const rBlend = inReg(node.id, 'blend');
          const fOff = pushConst(p.blend ?? 0.5);
          emit(OP.LAYER_WEIGHT, rFres, rBlend, rFac, 0, 0, fOff, 0);
          socketReg.set(`${node.id}:fresnel`, rFres);
          socketReg.set(`${node.id}:facing`, rFac);
          break;
        }
        case 'Bump': {
          const r = allocReg();
          const rH = inReg(node.id, 'height');
          const rS = inReg(node.id, 'strength');
          const curInstrCount = ops.length / INSTR_STRIDE;
          const fOff = pushConst(p.strength ?? 0.5, p.distance ?? 0.1, p.height ?? 0.0);
          emit(OP.BUMP, r, rH, rS, curInstrCount, 0, fOff, 0);
          socketReg.set(`${node.id}:normal`, r);
          break;
        }
        case 'NormalMap': {
          const r = allocReg();
          const rC = inReg(node.id, 'color');
          const rS = inReg(node.id, 'strength');
          const rgb = hexToLinearRgb(p.color ?? '#8080ff');
          const fOff = pushConst(p.strength ?? 1.0, rgb[0], rgb[1], rgb[2], 1.0);
          emit(OP.NORMAL_MAP, r, rC, rS, 0, 0, fOff, 0);
          socketReg.set(`${node.id}:normal`, r);
          break;
        }
        case 'PrincipledBSDF': {
          const rBase = inReg(node.id, 'baseColor');
          const rMetal = inReg(node.id, 'metallic');
          const rRough = inReg(node.id, 'roughness');
          const rEmit = inReg(node.id, 'emission');
          const rEmitStr = inReg(node.id, 'emissionStrength');
          const rAlpha = inReg(node.id, 'alpha');
          const rNrm = inReg(node.id, 'normal');

          const rgbBase = hexToLinearRgb(p.baseColor ?? '#cccccc');
          const fBase = pushConst(rgbBase[0], rgbBase[1], rgbBase[2], 1.0);
          emit(OP.SET_OUT, 0, rBase, 0, 0, 0, fBase, 0);

          const fMetal = pushConst(p.metallic ?? 0.0);
          emit(OP.SET_OUT, 0, rMetal, 0, 0, 0, fMetal, 1);

          const fRough = pushConst(p.roughness ?? 0.5);
          emit(OP.SET_OUT, 0, rRough, 0, 0, 0, fRough, 2);

          const rgbEmit = hexToLinearRgb(p.emission ?? '#000000');
          const fEmit = pushConst(rgbEmit[0], rgbEmit[1], rgbEmit[2], 1.0, p.emissionStrength ?? 0.0);
          emit(OP.SET_OUT, 0, rEmit, rEmitStr, 0, 0, fEmit, 3);

          if (rNrm !== NO_REG) {
            emit(OP.SET_OUT, 0, rNrm, 0, 0, 0, 0, 4);
          }
          if (rAlpha !== NO_REG || (p.alpha !== undefined && p.alpha < 1)) {
            const fA = pushConst(p.alpha ?? 1.0);
            emit(OP.SET_OUT, 0, rAlpha, 0, 0, 0, fA, 5);
          }
          break;
        }
        default:
          break;
      }
    }

    return {
      ops: new Uint32Array(ops),
      consts: new Float32Array(consts),
      topologyRevision: this.topologyRevision,
      paramRevision: this.paramRevision,
    };
  }

  toJSON() {
    return {
      id: this.id,
      version: this.version,
      nodes: Array.from(this.nodes.values()).map((n) => ({
        id: n.id,
        type: n.type,
        x: n.x,
        y: n.y,
        props: structuredClone(n.props),
      })),
      links: this.links.map((l) => ({
        fromNode: l.fromNode,
        fromSocket: l.fromSocket,
        toNode: l.toNode,
        toSocket: l.toSocket,
      })),
    };
  }

  static fromJSON(data) {
    return new ShaderGraph(data);
  }
}

// =========================================================================
// Pure JS CPU Reference VM (Parity Check & Node Preview Evaluation)
// =========================================================================

function fadeJS(t) { return t * t * t * (t * (t * 6 - 15) + 10); }
function hash2iJS(ix, iy, seed) {
  let h = (Math.imul(ix | 0, 374761393) ^ Math.imul(iy | 0, 668265263) ^ Math.imul(seed >>> 0, 2246822519)) >>> 0;
  h = Math.imul((h ^ (h >>> 13)) >>> 0, 1274126177) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}
function grad2JS(h, dx, dy) {
  switch (h & 7) {
    case 0: return dx + dy;
    case 1: return -dx + dy;
    case 2: return dx - dy;
    case 3: return -dx - dy;
    case 4: return dx;
    case 5: return -dx;
    case 6: return dy;
    default: return -dy;
  }
}
export function evalFbmNoiseCPU(u, v, scale = 6, detail = 4, roughness = 0.5, seed = 42) {
  const octs = Math.max(1, Math.min(8, Math.floor(detail)));
  const r = Math.max(0, Math.min(1, roughness));
  let freq = scale, amp = 1, sum = 0, norm = 0;
  for (let i = 0; i < octs; i++) {
    const x = u * freq, y = v * freq;
    const fx = Math.floor(x), fy = Math.floor(y);
    const dx = x - fx, dy = y - fy;
    const fu = fadeJS(dx), fv = fadeJS(dy);
    const s = (seed + i * 97) >>> 0;
    const g00 = grad2JS(hash2iJS(fx, fy, s), dx, dy);
    const g10 = grad2JS(hash2iJS(fx + 1, fy, s), dx - 1, dy);
    const g01 = grad2JS(hash2iJS(fx, fy + 1, s), dx, dy - 1);
    const g11 = grad2JS(hash2iJS(fx + 1, fy + 1, s), dx - 1, dy - 1);
    const nx0 = g00 + (g10 - g00) * fu;
    const nx1 = g01 + (g11 - g01) * fu;
    sum += ((nx0 + (nx1 - nx0) * fv) * 0.5 + 0.5) * amp;
    norm += amp;
    freq *= 2;
    amp *= r;
  }
  return norm > 0 ? Math.max(0, Math.min(1, sum / norm)) : 0.5;
}

export function evaluateShaderBytecodeCPU(bytecode, ctx = {}) {
  const { ops, consts } = bytecode;
  const u = ctx.u ?? 0.5;
  const v = ctx.v ?? 0.5;
  const cosNV = Math.max(0, Math.min(1, ctx.cosNV ?? 1.0));
  const regs = Array.from({ length: 64 }, () => [0, 0, 0, 1]);
  const read4 = (ri, fOff) => (ri < 64 ? regs[ri] : [consts[fOff] ?? 0, consts[fOff + 1] ?? 0, consts[fOff + 2] ?? 0, consts[fOff + 3] ?? 1]);
  const read1 = (ri, fOff) => (ri < 64 ? regs[ri][0] : (consts[fOff] ?? 0));

  const out = { base: [0.8, 0.8, 0.8], metal: 0, rough: 0.5, emit: [0, 0, 0], normal: [0, 1, 0], alpha: 1 };
  const nInstr = Math.floor(ops.length / INSTR_STRIDE);

  for (let i = 0; i < nInstr; i++) {
    const b = i * INSTR_STRIDE;
    const op = ops[b], dst = ops[b + 1], a0 = ops[b + 2], a1 = ops[b + 3], a2 = ops[b + 4], fOff = ops[b + 6], flags = ops[b + 7];
    if (op === OP.UV) {
      regs[dst] = [u * (consts[fOff] ?? 1) + (consts[fOff + 2] ?? 0), v * (consts[fOff + 1] ?? 1) + (consts[fOff + 3] ?? 0), 0, 1];
    } else if (op === OP.NOISE) {
      const vec = a0 < 64 ? regs[a0] : [u, v, 0, 1];
      const val = evalFbmNoiseCPU(vec[0], vec[1], consts[fOff], consts[fOff + 1], consts[fOff + 2], consts[fOff + 3]);
      regs[dst] = [val, val, val, 1];
    } else if (op === OP.COLOR_RAMP) {
      const fac = Math.max(0, Math.min(1, read1(a0, fOff)));
      const count = Math.max(1, flags);
      const baseC = fOff + 1;
      let col = [consts[baseC + 1], consts[baseC + 2], consts[baseC + 3], consts[baseC + 4]];
      for (let s = 0; s < count; s++) {
        const p0 = consts[baseC + s * 5];
        if (s === 0 && fac <= p0) break;
        if (s + 1 < count) {
          const p1 = consts[baseC + (s + 1) * 5];
          if (fac <= p1) {
            const t = Math.abs(p1 - p0) > 1e-6 ? Math.max(0, Math.min(1, (fac - p0) / (p1 - p0))) : 0;
            const o0 = baseC + s * 5 + 1, o1 = baseC + (s + 1) * 5 + 1;
            col = [0, 1, 2, 3].map((k) => consts[o0 + k] + (consts[o1 + k] - consts[o0 + k]) * t);
            break;
          }
        } else {
          const o0 = baseC + s * 5 + 1;
          col = [consts[o0], consts[o0 + 1], consts[o0 + 2], consts[o0 + 3]];
        }
      }
      regs[dst] = col;
    } else if (op === OP.MATH) {
      const a = read1(a0, fOff), bVal = read1(a1, fOff + 1);
      const m = flags & 0xFF;
      let val = 0;
      if (m === 0) val = a + bVal;
      else if (m === 1) val = a - bVal;
      else if (m === 2) val = a * bVal;
      else if (m === 3) val = Math.abs(bVal) > 1e-6 ? a / bVal : 0;
      else if (m === 4) val = Math.pow(Math.max(0, a), bVal);
      else if (m === 5) val = Math.sin(a);
      else if (m === 6) val = Math.min(a, bVal);
      else if (m === 7) val = Math.max(a, bVal);
      else if (m === 8) val = a < bVal ? 1 : 0;
      if (flags & 256) val = Math.max(0, Math.min(1, val));
      regs[dst] = [val, val, val, 1];
    } else if (op === OP.MIX) {
      const fac = read1(a0, fOff);
      const ca = read4(a1, fOff + 1), cb = read4(a2, fOff + 5);
      const t = (flags & 256) ? Math.max(0, Math.min(1, fac)) : fac;
      const m = flags & 0xFF;
      const outC = [0, 0, 0, 1];
      for (let c = 0; c < 3; c++) {
        let res = m === 1 ? ca[c] * (1 - t + t * cb[c]) : (m === 2 ? ca[c] + cb[c] * t : ca[c] + (cb[c] - ca[c]) * t);
        outC[c] = (flags & 256) ? Math.max(0, Math.min(1, res)) : res;
      }
      regs[dst] = outC;
    } else if (op === OP.FRESNEL) {
      const ior = Math.max(1.0, read1(a0, fOff));
      const r0 = Math.pow((1 - ior) / (1 + ior), 2);
      const f = r0 + (1 - r0) * Math.pow(1 - cosNV, 5);
      regs[dst] = [f, f, f, 1];
    } else if (op === OP.SET_OUT) {
      if (flags === 0) out.base = read4(a0, fOff).slice(0, 3);
      else if (flags === 1) out.metal = Math.max(0, Math.min(1, read1(a0, fOff)));
      else if (flags === 2) out.rough = Math.max(0.04, Math.min(1, read1(a0, fOff)));
      else if (flags === 3) {
        const ec = read4(a0, fOff), es = Math.max(0, read1(a1, fOff + 4));
        out.emit = [ec[0] * es, ec[1] * es, ec[2] * es];
      } else if (flags === 5) out.alpha = Math.max(0, Math.min(1, read1(a0, fOff)));
    }
  }
  return out;
}

const GRAPH_BY_MATERIAL = new WeakMap();
export function getShaderGraphForMaterial(material) {
  if (!material) return null;
  if (GRAPH_BY_MATERIAL.has(material)) return GRAPH_BY_MATERIAL.get(material);
  if (material.userData?.shaderGraphJson) {
    const g = ShaderGraph.fromJSON(material.userData.shaderGraphJson);
    GRAPH_BY_MATERIAL.set(material, g);
    return g;
  }
  return null;
}

export function setShaderGraphForMaterial(material, graph) {
  if (!material) return;
  if (!graph) {
    GRAPH_BY_MATERIAL.delete(material);
    if (material.userData) delete material.userData.shaderGraphJson;
    return;
  }
  GRAPH_BY_MATERIAL.set(material, graph);
  material.userData = material.userData || {};
  material.userData.shaderGraphJson = graph.toJSON();
}
