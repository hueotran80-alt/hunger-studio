/**
 * Agent layer core: error contract, logging, events, rate limiting,
 * stable agent IDs, serializers and snapshot-based transactions that
 * share the SceneManager undo stack (Ctrl+Z).
 */
import * as THREE from 'three';

export const ERROR_CODES = Object.freeze([
  'E_PERMISSION', 'E_NOT_FOUND', 'E_INVALID_ARG', 'E_DISABLED', 'E_TIMEOUT',
  'E_CORS', 'E_TOO_LARGE', 'E_UNSUPPORTED', 'E_NEEDS_CONFIRM', 'E_TX_CONFLICT'
]);

export class AgentError extends Error {
  constructor(code, message, hint = '', toolId = null) {
    super(message);
    this.name = 'AgentError';
    this.code = ERROR_CODES.includes(code) ? code : 'E_INVALID_ARG';
    this.hint = hint || '';
    this.toolId = toolId;
  }
}

export const ok = (data) => ({ ok: true, data: data === undefined ? null : data });
export const fail = (code, message, hint = '', toolId = null) =>
  ({ ok: false, error: { code, message, hint: hint || '', toolId: toolId || null } });

export function toErrorObject(e, toolId) {
  if (e instanceof AgentError) {
    return { code: e.code, message: e.message, hint: e.hint, toolId: e.toolId || toolId || null };
  }
  const message = e?.message || String(e);
  let code = 'E_INVALID_ARG';
  let hint = 'Check arguments against agent.docs.get(toolId).params';
  if (/cors|cross-origin|failed to fetch|networkerror/i.test(message)) {
    code = 'E_CORS';
    hint = 'Load external files through agent.assets.importURL(url) so they go through the /api/agent/proxy allowlist.';
  } else if (/not (found|defined)|undefined|null/i.test(message)) {
    code = 'E_NOT_FOUND';
    hint = 'Use agent.scene.find({...}) or agent.scene.tree() to get a valid agentId first.';
  }
  return { code, message, hint, toolId: toolId || null };
}

export const assertArg = (cond, message, hint, toolId) => {
  if (!cond) throw new AgentError('E_INVALID_ARG', message, hint, toolId);
};

// ---------------------------------------------------------------------------
// Logs / events / rate limit
// ---------------------------------------------------------------------------

const LEVELS = { debug: 0, log: 1, info: 1, warn: 2, error: 3 };

export class LogBuffer {
  constructor(max = 1000) {
    this.max = max;
    this.items = [];
    this.seq = 0;
  }

  push({ level = 'info', source = 'app', message = '', data }) {
    const entry = { seq: ++this.seq, ts: Date.now(), level, source, message: String(message).slice(0, 2000) };
    if (data !== undefined) entry.data = data;
    this.items.push(entry);
    if (this.items.length > this.max) this.items.shift();
    return entry;
  }

  query({ since = 0, level, source, limit = 200 } = {}) {
    const min = level ? (LEVELS[level] ?? 0) : 0;
    const out = this.items.filter(e =>
      e.ts >= since && (LEVELS[e.level] ?? 1) >= min && (!source || e.source === source));
    return out.slice(-limit);
  }
}

export class EventBus {
  constructor() { this.handlers = new Map(); }

  on(evt, cb) {
    if (!this.handlers.has(evt)) this.handlers.set(evt, new Set());
    this.handlers.get(evt).add(cb);
    return () => this.handlers.get(evt)?.delete(cb);
  }

  emit(evt, payload) {
    this.handlers.get(evt)?.forEach(cb => {
      try { cb(payload); } catch (e) { console.warn('[agent] event handler error', e); }
    });
  }
}

export class RateLimiter {
  constructor(limits) {
    this.limits = limits;
    this.windows = new Map();
  }

  take(bucket) {
    const limit = this.limits[bucket];
    if (!limit) return { allowed: true };
    const now = Date.now();
    const arr = (this.windows.get(bucket) || []).filter(t => now - t < 60000);
    if (arr.length >= limit) {
      this.windows.set(bucket, arr);
      return { allowed: false, retryInMs: 60000 - (now - arr[0]), limit };
    }
    arr.push(now);
    this.windows.set(bucket, arr);
    return { allowed: true };
  }
}

// ---------------------------------------------------------------------------
// Stable IDs
// ---------------------------------------------------------------------------

export class IdRegistry {
  constructor(prefix, key = 'agentId') {
    this.prefix = prefix;
    this.key = key;
    this.counter = 0;
    this.map = new Map();
  }

  _holder(obj) {
    return obj.userData ? obj.userData : obj;
  }

  assign(obj) {
    if (!obj) return null;
    const holder = this._holder(obj);
    const existing = holder[this.key];
    if (existing && this.map.get(existing) === obj) return existing;
    if (existing && !this.map.has(existing) && String(existing).startsWith(this.prefix)) {
      // Adopt IDs coming from a loaded project, keep the counter monotonic.
      this.map.set(existing, obj);
      const n = parseInt(String(existing).slice(this.prefix.length), 10);
      if (Number.isFinite(n) && n > this.counter) this.counter = n;
      return existing;
    }
    const id = `${this.prefix}${++this.counter}`;
    holder[this.key] = id;
    this.map.set(id, obj);
    return id;
  }

  get(id) { return this.map.get(id) || null; }

  delete(id) { this.map.delete(id); }
}

// ---------------------------------------------------------------------------
// Serialization helpers
// ---------------------------------------------------------------------------

export const r4 = (v) => Math.round(v * 10000) / 10000;
export const vec = (v) => (v ? [r4(v.x), r4(v.y), r4(v.z)] : null);
export const colorHex = (c) => (c && c.isColor ? `#${c.getHexString()}` : null);

export function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

export function stableStringify(value) {
  const seen = new WeakSet();
  const walk = (v) => {
    if (v === null || typeof v !== 'object') return v;
    if (seen.has(v)) return '[Circular]';
    seen.add(v);
    if (Array.isArray(v)) return v.map(walk);
    const out = {};
    Object.keys(v).sort().forEach(k => { out[k] = walk(v[k]); });
    return out;
  };
  return JSON.stringify(walk(value));
}

/** Converts arbitrary values (Object3D, vectors, typed arrays...) to JSON-safe data. */
export function toPlain(value, describeNode, depth = 0) {
  if (value === null || value === undefined) return value ?? null;
  const t = typeof value;
  if (t === 'number') return Number.isFinite(value) ? value : null;
  if (t === 'string' || t === 'boolean') return value;
  if (t === 'function') return `[Function ${value.name || 'anonymous'}]`;
  if (t === 'bigint') return value.toString();
  if (depth > 6) return '[MaxDepth]';
  if (value.isObject3D) return describeNode ? describeNode(value) : { name: value.name, type: value.type };
  if (value.isVector2) return [r4(value.x), r4(value.y)];
  if (value.isVector3) return vec(value);
  if (value.isVector4 || value.isQuaternion) return [r4(value.x), r4(value.y), r4(value.z), r4(value.w)];
  if (value.isEuler) return [r4(value.x), r4(value.y), r4(value.z)];
  if (value.isColor) return colorHex(value);
  if (value.isMaterial) return { name: value.name, type: value.type, agentMatId: value.userData?.agentMatId || null };
  if (value.isTexture) return { name: value.name, textureId: value.userData?.agentTextureId || null };
  if (value.isBufferGeometry) return { type: value.type, verts: value.attributes?.position?.count || 0 };
  if (value instanceof Error) return { name: value.name, message: value.message };
  if (ArrayBuffer.isView(value)) return { typedArray: value.constructor.name, length: value.length };
  if (value instanceof Map) return Object.fromEntries([...value].map(([k, v]) => [String(k), toPlain(v, describeNode, depth + 1)]));
  if (value instanceof Set) return [...value].map(v => toPlain(v, describeNode, depth + 1));
  if (typeof HTMLElement !== 'undefined' && value instanceof HTMLElement) {
    return { element: value.tagName.toLowerCase(), agentId: value.dataset?.agentId || null };
  }
  if (Array.isArray(value)) return value.slice(0, 5000).map(v => toPlain(v, describeNode, depth + 1));
  const out = {};
  Object.keys(value).slice(0, 500).forEach(k => {
    out[k] = toPlain(value[k], describeNode, depth + 1);
  });
  return out;
}

// ---------------------------------------------------------------------------
// Snapshots & transactions
// ---------------------------------------------------------------------------

const COLOR_PROPS = ['color', 'emissive', 'sheenColor', 'attenuationColor', 'specularColor'];
const SCALAR_PROPS = [
  'name', 'emissiveIntensity', 'roughness', 'metalness', 'opacity', 'transparent', 'wireframe',
  'side', 'clearcoat', 'clearcoatRoughness', 'transmission', 'ior', 'sheen', 'sheenRoughness',
  'flatShading', 'vertexColors', 'alphaTest', 'depthWrite', 'visible', 'envMapIntensity',
  'thickness', 'specularIntensity', 'polygonOffset', 'polygonOffsetFactor', 'polygonOffsetUnits'
];
export const MAP_SLOTS = [
  'map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'emissiveMap', 'alphaMap',
  'bumpMap', 'displacementMap', 'clearcoatMap', 'clearcoatNormalMap', 'clearcoatRoughnessMap',
  'sheenColorMap', 'transmissionMap', 'lightMap', 'specularColorMap', 'specularIntensityMap', 'matcap'
];
const LIGHT_PROPS = ['intensity', 'distance', 'angle', 'penumbra', 'decay', 'castShadow'];
const CAMERA_PROPS = ['fov', 'near', 'far', 'zoom'];
const DEEP_BUDGET = 20_000_000;

const isHelperNode = (o) =>
  o.userData?.isSystemObject || o.userData?.isHelper || /Helper$/.test(o.type || '') || o.isTransformControls;

function materialsOf(node) {
  const out = [];
  const add = (m) => { if (Array.isArray(m)) m.forEach(x => x && out.push(x)); else if (m) out.push(m); };
  add(node.material);
  add(node.userData?.__originalMaterial);
  return out;
}

function captureMaterial(m) {
  const vals = {};
  COLOR_PROPS.forEach(p => { if (m[p]?.isColor) vals[p] = m[p].getHex(); });
  SCALAR_PROPS.forEach(p => { if (p in m && typeof m[p] !== 'object') vals[p] = m[p]; });
  if (m.normalScale?.isVector2) vals.normalScale = [m.normalScale.x, m.normalScale.y];
  const maps = {};
  MAP_SLOTS.forEach(s => { if (s in m) maps[s] = m[s] || null; });
  return { vals, maps, key: JSON.stringify(vals) };
}

function captureTexture(t) {
  return {
    repeat: [t.repeat.x, t.repeat.y], offset: [t.offset.x, t.offset.y], center: [t.center.x, t.center.y],
    rotation: t.rotation, wrapS: t.wrapS, wrapT: t.wrapT, channel: t.channel ?? 0, flipY: t.flipY,
    colorSpace: t.colorSpace
  };
}

function captureGeometry(g, deepCopies) {
  const attrs = {};
  Object.keys(g.attributes).forEach(k => { attrs[k] = g.attributes[k]; });
  const morph = {};
  Object.keys(g.morphAttributes || {}).forEach(k => { morph[k] = [...(g.morphAttributes[k] || [])]; });
  const entry = {
    attrs, index: g.index || null, morph,
    groups: JSON.stringify(g.groups || []),
    drawRange: [g.drawRange.start, g.drawRange.count],
    copies: null
  };
  if (deepCopies) {
    entry.copies = new Map();
    const take = (attribute) => {
      const a = attribute?.isInterleavedBufferAttribute ? attribute.data : attribute;
      if (!a?.array || entry.copies.has(a)) return;
      if (deepCopies.used + a.array.length > DEEP_BUDGET) throw new AgentError('E_TOO_LARGE', 'Scene exceeds the atomic snapshot budget.', 'Use smaller scenes; no write has been applied.');
      deepCopies.used += a.array.length;
      entry.copies.set(a, a.array.slice());
    };
    Object.values(attrs).forEach(take);
    Object.values(morph).forEach(attributes => attributes.forEach(take));
    take(entry.index);
  }
  return entry;
}

function captureNode(o, sm) {
  const e = {
    parent: o.parent || null,
    index: o.parent ? o.parent.children.indexOf(o) : -1,
    p: o.position.toArray(), q: o.quaternion.toArray(), s: o.scale.toArray(),
    visible: o.visible, name: o.name,
    material: o.material || null,
    origMaterial: o.userData?.__originalMaterial || null,
    geometry: o.geometry || null,
    locked: !!o.userData?.locked,
    morph: o.morphTargetInfluences ? [...o.morphTargetInfluences] : null,
    shadow: [o.castShadow, o.receiveShadow],
    registered: !!(o.userData?.id && sm.objects.get(o.userData.id) === o),
    tags: o.userData?.tags ? JSON.stringify(o.userData.tags) : null,
    extra: null
  };
  if (o.isLight) {
    e.extra = { color: o.color?.getHex() };
    LIGHT_PROPS.forEach(p => { if (p in o) e.extra[p] = o[p]; });
  } else if (o.isCamera) {
    e.extra = {};
    CAMERA_PROPS.forEach(p => { if (p in o) e.extra[p] = o[p]; });
  }
  return e;
}

const sameArr = (a, b) => {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
};

function nodeEqual(a, b) {
  return a.parent === b.parent && a.index === b.index && sameArr(a.p, b.p) && sameArr(a.q, b.q) &&
    sameArr(a.s, b.s) && a.visible === b.visible && a.name === b.name && a.material === b.material &&
    a.origMaterial === b.origMaterial && a.geometry === b.geometry && a.locked === b.locked &&
    sameArr(a.morph, b.morph) && sameArr(a.shadow, b.shadow) && a.registered === b.registered &&
    a.tags === b.tags && JSON.stringify(a.extra) === JSON.stringify(b.extra);
}

function materialEqual(a, b) {
  if (a.key !== b.key) return false;
  for (const s of new Set([...Object.keys(a.maps), ...Object.keys(b.maps)])) {
    if ((a.maps[s] || null) !== (b.maps[s] || null)) return false;
  }
  return true;
}

function arraysContentEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export class SceneSnapshotter {
  constructor(ctx) {
    this.ctx = ctx;
  }

  get sm() { return this.ctx.sceneManager; }

  /** Agent-visible scope: rootContainer subtree + registered objects + non-system scene children. */
  collectNodes() {
    const sm = this.sm;
    const set = new Set();
    const visit = (o) => {
      if (set.has(o)) return;
      if (o !== sm.rootContainer && isHelperNode(o)) return;
      set.add(o);
      o.children.forEach(visit);
    };
    visit(sm.rootContainer);
    sm.objects.forEach(o => visit(o));
    sm.scene.children.forEach(c => {
      if (c !== sm.rootContainer && !isHelperNode(c) && c !== this.ctx.engine?.transformControls) visit(c);
    });
    return set;
  }

  capture({ deep = false } = {}) {
    const sm = this.sm;
    const nodes = new Map();
    const mats = new Map();
    const texs = new Map();
    const geos = new Map();
    const deepCopies = deep ? { used: 0, skipped: false } : null;
    this.collectNodes().forEach(o => {
      nodes.set(o, captureNode(o, sm));
      materialsOf(o).forEach(m => {
        if (mats.has(m)) return;
        const cm = captureMaterial(m);
        mats.set(m, cm);
        Object.values(cm.maps).forEach(t => { if (t && !texs.has(t)) texs.set(t, captureTexture(t)); });
      });
      if (o.geometry?.isBufferGeometry && !geos.has(o.geometry)) geos.set(o.geometry, captureGeometry(o.geometry, deepCopies));
    });
    return {
      ts: Date.now(),
      nodes, mats, texs, geos,
      registry: new Map(sm.objects),
      selection: sm.getSelectedObjects(),
      active: sm.activeObject,
      deep,
      deepSkipped: !!deepCopies?.skipped
    };
  }

  /** Diff of two snapshots; `after` may be omitted to compare against the live scene. */
  diff(before, after = null) {
    const now = after || this.capture({ deep: false });
    const d = { nodes: [], mats: [], texs: [], geos: [], registry: [], selB: before.selection, actB: before.active, selA: now.selection, actA: now.active };

    new Set([...before.nodes.keys(), ...now.nodes.keys()]).forEach(o => {
      const b = before.nodes.get(o) || null;
      const a = now.nodes.get(o) || null;
      if (b && a && nodeEqual(a, b)) return;
      d.nodes.push({ obj: o, b, a });
    });

    // Materials: compare those present in both; new materials are carried by node refs.
    before.mats.forEach((b, m) => {
      const a = now.mats.get(m) || captureMaterial(m);
      if (!materialEqual(a, b)) d.mats.push({ m, b, a });
    });
    before.texs.forEach((b, t) => {
      const a = now.texs.get(t) || captureTexture(t);
      if (JSON.stringify(a) !== JSON.stringify(b)) d.texs.push({ t, b, a });
    });

    before.geos.forEach((b, g) => {
      const a = now.geos.get(g) || captureGeometry(g, null);
      let changed = b.index !== a.index || b.groups !== a.groups || !sameArr(b.drawRange, a.drawRange);
      const names = new Set([...Object.keys(b.attrs), ...Object.keys(a.attrs)]);
      names.forEach(n => { if (b.attrs[n] !== a.attrs[n]) changed = true; });
      const mk = new Set([...Object.keys(b.morph), ...Object.keys(a.morph)]);
      mk.forEach(k => { if (!sameArr(b.morph[k], a.morph[k])) changed = true; });
      // In-place edits (deep snapshots only)
      let afterCopies = null;
      if (b.copies) {
        b.copies.forEach((copy, attr) => {
          if (!attr.array || !arraysContentEqual(copy, attr.array)) {
            changed = true;
            afterCopies = afterCopies || new Map();
            if (attr.array) afterCopies.set(attr, attr.array.slice());
          }
        });
      }
      if (!changed) return;
      d.geos.push({ g, b, a: { ...a, copies: afterCopies } });
    });

    new Set([...before.registry.keys(), ...now.registry.keys()]).forEach(id => {
      const b = before.registry.get(id) || null;
      const a = now.registry.get(id) || null;
      if (a !== b) d.registry.push({ id, b, a });
    });

    const selChanged = before.active !== now.active || !sameArr(before.selection, now.selection);
    d.empty = !d.nodes.length && !d.mats.length && !d.texs.length && !d.geos.length && !d.registry.length;
    d.selectionChanged = selChanged;
    return d;
  }

  summarize(d) {
    const label = (o) => o?.userData?.agentId || o?.name || o?.type;
    const added = [], removed = [], modified = [];
    d.nodes.forEach(({ obj, b, a }) => {
      if (!b) added.push({ agentId: obj.userData?.agentId || null, name: obj.name, type: obj.type });
      else if (!a) removed.push({ agentId: obj.userData?.agentId || null, name: b.name, type: obj.type });
      else {
        const fields = [];
        if (a.parent !== b.parent || a.index !== b.index) fields.push('hierarchy');
        if (!sameArr(a.p, b.p)) fields.push('position');
        if (!sameArr(a.q, b.q)) fields.push('rotation');
        if (!sameArr(a.s, b.s)) fields.push('scale');
        if (a.visible !== b.visible) fields.push('visible');
        if (a.name !== b.name) fields.push('name');
        if (a.material !== b.material || a.origMaterial !== b.origMaterial) fields.push('material');
        if (a.geometry !== b.geometry) fields.push('geometry');
        if (!sameArr(a.morph, b.morph)) fields.push('morph');
        if (JSON.stringify(a.extra) !== JSON.stringify(b.extra)) fields.push('properties');
        if (a.locked !== b.locked) fields.push('locked');
        if (fields.length) modified.push({ agentId: label(obj), name: a.name, fields });
      }
    });
    return {
      added, removed, modified,
      materialsChanged: d.mats.map(({ m, b, a }) => ({
        agentMatId: m.userData?.agentMatId || null, name: m.name,
        fields: Object.keys({ ...a.vals, ...b.vals }).filter(k => JSON.stringify(a.vals[k]) !== JSON.stringify(b.vals[k]))
          .concat(Object.keys({ ...a.maps, ...b.maps }).filter(k => (a.maps[k] || null) !== (b.maps[k] || null)))
      })),
      texturesChanged: d.texs.length,
      geometriesChanged: d.geos.length
    };
  }

  /** Applies the `side` ('b' = before, 'a' = after) of a diff to the live scene. */
  apply(d, side) {
    const sm = this.sm;
    const engine = this.ctx.engine;
    const other = side === 'b' ? 'a' : 'b';
    const tc = engine?.transformControls;

    // 1. Detach nodes absent on the target side.
    const detached = [];
    d.nodes.forEach(e => {
      if (e[side] || !e.obj.parent) return;
      if (tc?.object) {
        let hit = false;
        e.obj.traverse(c => { if (c === tc.object) hit = true; });
        if (hit) tc.detach();
      }
      e.obj.parent.remove(e.obj);
      detached.push(e.obj);
    });

    // 2. Re-attach / reorder.
    const structural = d.nodes.filter(e => e[side] && e[side].parent &&
      (!e[other] || e[other].parent !== e[side].parent || e[other].index !== e[side].index || e.obj.parent !== e[side].parent));
    structural.sort((x, y) => x[side].index - y[side].index);
    structural.forEach(e => {
      const t = e[side];
      if (e.obj.parent !== t.parent) t.parent.add(e.obj);
      const ch = t.parent.children;
      const i = ch.indexOf(e.obj);
      if (i !== -1 && i !== t.index) {
        ch.splice(i, 1);
        ch.splice(Math.min(Math.max(0, t.index), ch.length), 0, e.obj);
      }
    });

    // 3. Node properties.
    d.nodes.forEach(e => {
      const t = e[side];
      if (!t) return;
      const o = e.obj;
      o.position.fromArray(t.p);
      o.quaternion.fromArray(t.q);
      o.scale.fromArray(t.s);
      o.visible = t.visible;
      if (o.userData) o.userData.visible = t.visible;
      o.name = t.name;
      if ('material' in o && t.material) o.material = t.material;
      if (o.userData) {
        if (t.origMaterial) o.userData.__originalMaterial = t.origMaterial;
        else delete o.userData.__originalMaterial;
        o.userData.locked = t.locked;
        if (t.tags) o.userData.tags = JSON.parse(t.tags); else delete o.userData.tags;
      }
      if (t.geometry && o.geometry !== t.geometry) o.geometry = t.geometry;
      if (t.morph && o.morphTargetInfluences) t.morph.forEach((v, i) => { o.morphTargetInfluences[i] = v; });
      o.castShadow = t.shadow[0];
      o.receiveShadow = t.shadow[1];
      if (t.extra) {
        Object.entries(t.extra).forEach(([k, v]) => {
          if (k === 'color' && o.color?.isColor) o.color.setHex(v);
          else if (k in o) o[k] = v;
        });
        if (o.isCamera) o.updateProjectionMatrix?.();
      }
      o.updateMatrix();
    });

    // 4. Materials / textures.
    d.mats.forEach(e => {
      const t = e[side];
      const m = e.m;
      Object.entries(t.vals).forEach(([k, v]) => {
        if (COLOR_PROPS.includes(k) && m[k]?.isColor) m[k].setHex(v);
        else if (k === 'normalScale' && m.normalScale) m.normalScale.set(v[0], v[1]);
        else m[k] = v;
      });
      Object.entries(t.maps).forEach(([s, tex]) => { m[s] = tex; });
      m.needsUpdate = true;
    });
    d.texs.forEach(e => {
      const t = e[side];
      const tx = e.t;
      tx.repeat.set(...t.repeat); tx.offset.set(...t.offset); tx.center.set(...t.center);
      tx.rotation = t.rotation; tx.wrapS = t.wrapS; tx.wrapT = t.wrapT;
      if ('channel' in tx) tx.channel = t.channel;
      if (tx.flipY !== t.flipY || tx.colorSpace !== t.colorSpace) {
        tx.flipY = t.flipY;
        tx.colorSpace = t.colorSpace;
        tx.needsUpdate = true;
      }
    });

    // 5. Geometry.
    d.geos.forEach(e => {
      const t = e[side];
      const g = e.g;
      Object.keys({ ...g.attributes }).forEach(n => { if (!(n in t.attrs)) g.deleteAttribute(n); });
      Object.entries(t.attrs).forEach(([n, attr]) => { if (g.getAttribute(n) !== attr) g.setAttribute(n, attr); });
      if (g.index !== t.index) g.setIndex(t.index);
      g.morphAttributes = {};
      Object.entries(t.morph).forEach(([k, arr]) => { g.morphAttributes[k] = [...arr]; });
      g.groups = JSON.parse(t.groups);
      g.setDrawRange(t.drawRange[0], t.drawRange[1]);
      if (t.copies) {
        t.copies.forEach((copy, attr) => {
          if (attr.array && attr.array.length === copy.length) attr.array.set(copy);
          else attr.array = copy.slice();
          attr.needsUpdate = true;
        });
      }
      Object.values(g.attributes).forEach(a => { a.needsUpdate = true; });
      g.boundingBox = null;
      g.boundingSphere = null;
    });

    // 6. Registry.
    const addedReg = [], removedReg = [];
    d.registry.forEach(r => {
      const t = r[side];
      if (t) { sm.objects.set(r.id, t); if (!r[other]) addedReg.push(t); }
      else { const o = r[other]; sm.objects.delete(r.id); if (o) removedReg.push(o); }
    });

    // 7. Selection.
    const sel = (side === 'b' ? d.selB : d.selA).filter(o => o.parent);
    const act = side === 'b' ? d.actB : d.actA;
    sm.selectedObjects.clear();
    sel.forEach(o => sm.selectedObjects.add(o));
    sm.activeObject = act && act.parent ? act : (sel[sel.length - 1] || null);

    // 8. Notify UI.
    removedReg.forEach(o => sm.emit('objectRemoved', { object: o }));
    addedReg.forEach(o => sm.emit('objectAdded', { object: o, parent: o.parent }));
    sm.emit('hierarchyChanged');
    sm.emit('selectionChanged', { selected: sm.getSelectedObjects(), active: sm.activeObject });
    if (typeof window !== 'undefined') {
      window.outliner?.render?.();
      const em = window.editMode;
      if (em?.isActive && d.geos.length && typeof em.syncTopologyFromGeometry === 'function') {
        try { em.syncTopologyFromGeometry(); } catch (_) { /* ignore */ }
      }
    }
    sm.requestRender?.();
    engine?.requestRender?.();
    return { detached };
  }

  /** Releases GPU resources of nodes that only existed on one discarded side. */
  disposeOrphans(nodes, keepSnapshot) {
    const keepGeo = new Set(keepSnapshot.geos.keys());
    const keepMat = new Set(keepSnapshot.mats.keys());
    nodes.forEach(o => o.traverse(c => {
      if (c.geometry && !keepGeo.has(c.geometry)) c.geometry.dispose?.();
      materialsOf(c).forEach(m => { if (!keepMat.has(m)) m.dispose?.(); });
    }));
  }
}

/**
 * Transaction manager. While a transaction is open, SceneManager commands are captured
 * (not pushed); on commit a single composite command is pushed to the shared undo stack.
 */
export class TxManager {
  constructor(ctx) {
    this.ctx = ctx;
    this.snap = new SceneSnapshotter(ctx);
    this.stack = [];
    this.history = [];
    this.seq = 0;
    this._installed = false;
    this._idleTimer = null;
  }

  get open() { return this.stack.length > 0; }
  get current() { return this.stack[this.stack.length - 1] || null; }

  install() {
    if (this._installed) return;
    const sm = this.ctx.sceneManager;
    this._origExecute = sm.executeCommand.bind(sm);
    this._origUndo = sm.undo.bind(sm);
    this._origRedo = sm.redo.bind(sm);
    this._origClearHistory = sm.clearHistory.bind(sm);
    sm.executeCommand = (cmd) => {
      if (this.open) {
        this.stack.forEach(t => t.ops.push(cmd?.description || cmd?.constructor?.name || 'command'));
        return;
      }
      return this._origExecute(cmd);
    };
    sm.undo = () => {
      if (this.open) {
        this.ctx.notify?.('Agent transaction in progress — wait for commit before Undo.');
        return;
      }
      return this._origUndo();
    };
    sm.redo = () => {
      if (this.open) {
        this.ctx.notify?.('Agent transaction in progress — wait for commit before Redo.');
        return;
      }
      return this._origRedo();
    };
    sm.clearHistory = () => {
      if (this.open) return;
      return this._origClearHistory();
    };
    this._installed = true;
  }

  begin(label = 'Agent action', { deep = false, explicit = false } = {}) {
    if (explicit && this.stack.some(t => t.explicit)) {
      throw new AgentError('E_TX_CONFLICT', `Transaction ${this.stack.find(t => t.explicit).txId} is still open`,
        'Call agent.tx.commit(txId) or agent.tx.rollback(txId) before agent.tx.begin().', 'tx.begin');
    }
    const tx = {
      txId: `tx_${++this.seq}`,
      label, explicit, deep,
      ts: Date.now(),
      ops: [],
      before: this.snap.capture({ deep }),
      nested: this.stack.length > 0,
      status: 'open'
    };
    this.stack.push(tx);
    if (explicit) this._touch(tx);
    return tx;
  }

  _touch(tx) {
    clearTimeout(this._idleTimer);
    if (!tx?.explicit) return;
    this._idleTimer = setTimeout(() => {
      if (tx.status === 'open') {
        this.ctx.log?.push({ level: 'warn', source: 'agent', message: `Auto-commit idle transaction ${tx.txId} after 120s` });
        try { this.commit(tx.txId); } catch (_) { /* ignore */ }
      }
    }, 120000);
  }

  touchExplicit() {
    const ex = this.stack.find(t => t.explicit);
    if (ex) this._touch(ex);
  }

  _find(txId, toolId) {
    const tx = txId ? this.stack.find(t => t.txId === txId) : this.current;
    if (!tx) {
      throw new AgentError('E_NOT_FOUND', `Transaction ${txId || '(current)'} is not open`,
        'Use agent.tx.list() to inspect transactions; only open ones can be committed or rolled back.', toolId);
    }
    if (tx !== this.current) {
      throw new AgentError('E_TX_CONFLICT', `Transaction ${tx.txId} has nested transactions still open`,
        `Close ${this.current.txId} first.`, toolId);
    }
    return tx;
  }

  commit(txId) {
    const tx = this._find(txId, 'tx.commit');
    this.stack.pop();
    const d = this.snap.diff(tx.before);
    const summary = this.snap.summarize(d);
    tx.status = 'committed';
    tx.changes = summary;
    if (!tx.nested && !d.empty) {
      const label = `Agent: ${tx.label}`;
      this._origExecute({
        description: label,
        isAgentCommand: true,
        txId: tx.txId,
        execute: () => this.snap.apply(d, 'a'),
        undo: () => this.snap.apply(d, 'b')
      });
    }
    if (!tx.nested) clearTimeout(this._idleTimer);
    this._record(tx);
    this.ctx.events?.emit('scene:change', { source: 'agent', txId: tx.txId, label: tx.label, changes: summary });
    return { txId: tx.txId, label: tx.label, committed: !d.empty, changes: summary, deepSkipped: tx.before.deepSkipped };
  }

  rollback(txId) {
    const tx = this._find(txId, 'tx.rollback');
    this.stack.pop();
    const d = this.snap.diff(tx.before);
    const summary = this.snap.summarize(d);
    if (!d.empty || d.selectionChanged) {
      const { detached } = this.snap.apply(d, 'b');
      this.snap.disposeOrphans(detached, tx.before);
    }
    tx.status = 'rolledBack';
    tx.changes = summary;
    if (!tx.nested) clearTimeout(this._idleTimer);
    this._record(tx);
    return { txId: tx.txId, label: tx.label, rolledBack: true, reverted: summary, deepSkipped: tx.before.deepSkipped };
  }

  /** Diff of the current transaction (or a snapshot) without closing it. */
  preview(tx = this.current) {
    if (!tx) return null;
    return this.snap.summarize(this.snap.diff(tx.before));
  }

  async run(label, fn, { deep = false } = {}) {
    const tx = this.begin(label, { deep });
    try {
      const result = await fn(tx);
      const info = this.commit(tx.txId);
      return { result, tx: info };
    } catch (e) {
      if (tx.status === 'open') {
        // Close any nested transactions left open by the failing code.
        while (this.current && this.current !== tx) this.rollback(this.current.txId);
        this.rollback(tx.txId);
      }
      throw e;
    }
  }

  _record(tx) {
    this.history.push({
      txId: tx.txId, label: tx.label, ts: tx.ts, status: tx.status,
      ops: tx.ops.slice(0, 200), nested: tx.nested, changes: tx.changes || null
    });
    if (this.history.length > 200) this.history.shift();
  }

  list() {
    const open = this.stack.map(t => ({ txId: t.txId, label: t.label, ts: t.ts, status: 'open', ops: t.ops.slice(0, 200), nested: t.nested }));
    return [...this.history, ...open];
  }

  undo() {
    if (this.open) throw new AgentError('E_TX_CONFLICT', 'Cannot undo while a transaction is open', 'Commit or roll back the open transaction first.', 'undo');
    const sm = this.ctx.sceneManager;
    if (!sm.canUndo()) throw new AgentError('E_NOT_FOUND', 'Nothing to undo', 'Undo stack is empty.', 'undo');
    const desc = sm.undoStack[sm.undoStack.length - 1]?.description || null;
    this._origUndo();
    return { undone: desc, canUndo: sm.canUndo(), canRedo: sm.canRedo() };
  }

  redo() {
    if (this.open) throw new AgentError('E_TX_CONFLICT', 'Cannot redo while a transaction is open', 'Commit or roll back the open transaction first.', 'redo');
    const sm = this.ctx.sceneManager;
    if (!sm.canRedo()) throw new AgentError('E_NOT_FOUND', 'Nothing to redo', 'Redo stack is empty.', 'redo');
    const desc = sm.redoStack[sm.redoStack.length - 1]?.description || null;
    this._origRedo();
    return { redone: desc, canUndo: sm.canUndo(), canRedo: sm.canRedo() };
  }
}

export { THREE };
