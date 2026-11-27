import * as THREE from 'three';
import { AgentError, assertArg, toErrorObject, ok, IdRegistry, LogBuffer, EventBus, RateLimiter, TxManager, vec, colorHex, fnv1a, stableStringify, toPlain } from './agent-core.js';
import { AgentUI } from './agent-ui.js';
import { AgentManifest, SHORTCUTS } from './agent-manifest.js';
import { createAssetTools } from './agent-assets.js';
import { createGeometryTools } from './agent-geometry.js';
import { createAnimationTools } from './agent-animation.js';
import { createTutorialTools } from './agent-tutorial.js';

const PBR = { baseColor: 'color', metalness: 'metalness', roughness: 'roughness', emissive: 'emissive', emissiveIntensity: 'emissiveIntensity', clearcoat: 'clearcoat', clearcoatRoughness: 'clearcoatRoughness', transmission: 'transmission', ior: 'ior', sheen: 'sheen', sheenRoughness: 'sheenRoughness', opacity: 'opacity' };
const SLOTS = { baseColor: 'map', normal: 'normalMap', roughness: 'roughnessMap', metalness: 'metalnessMap', ao: 'aoMap', emissive: 'emissiveMap' };
const MAT_SCALARS = ['roughness', 'metalness', 'opacity', 'transparent', 'wireframe', 'side', 'emissiveIntensity', 'clearcoat', 'clearcoatRoughness', 'transmission', 'ior', 'sheen', 'sheenRoughness', 'vertexColors', 'flatShading'];
const MAT_COLORS = ['color', 'emissive', 'sheenColor'];

export async function createAgent(app) {
  const sm = app.sceneManager;
  const ctx = { app, engine: app.engine, sceneManager: sm, log: new LogBuffer(), events: new EventBus(), ids: new IdRegistry('obj_'), textures: new IdRegistry('tex_', 'agentTextureId'), materials: new IdRegistry('mat_', 'agentMatId') };
  const rate = new RateLimiter({ scene: 300, assets: 60 });
  const tx = new TxManager(ctx); tx.install();
  ctx.ui = new AgentUI(ctx); ctx.manifest = new AgentManifest(ctx); ctx.notify = text => ctx.ui.notify(text);
  let busy = false;
  ctx.scan = () => [...tx.snap.collectNodes()].filter(o => o !== sm.rootContainer);
  const uniqueName = (object, requested) => {
    const names = new Set(ctx.scan().filter(o => o !== object).map(o => o.name));
    const base = String(requested || object.type || 'Object');
    let name = base, n = 1;
    while (names.has(name)) name = `${base}_${String(n++).padStart(3, '0')}`;
    return name;
  };
  // Xương KHÔNG bị đổi tên: track animation (mocap, clip của file .glb) bind theo
  // tên xương, đổi tên một cái là cả hoạt cảnh im lặng không chạy.
  ctx.assignHierarchy = root => root.traverse(o => {
    if (o.userData?.isSystemObject || o.userData?.isHelper) return;
    ctx.ids.assign(o);
    if (!o.isBone && !o.userData?.isSkeletonRoot) o.name = uniqueName(o, o.name);
  });
  ctx.scan().forEach(o => { ctx.ids.assign(o); if (!o.isBone) o.name = uniqueName(o, o.name); });
  sm.on('objectAdded', ({ object }) => ctx.assignHierarchy(object));
  ctx.node = id => {
    const o = ctx.scan().find(o => ctx.ids.assign(o) === id);
    if (!o) throw new AgentError('E_NOT_FOUND', `Object '${id}' is not in the scene.`, 'Use agent.scene.tree() or agent.scene.find() first.');
    return o;
  };
  ctx.mesh = id => { const o = ctx.node(id); assertArg(o.isMesh, `${id} is not a mesh.`, 'Select a mesh child from agent.scene.tree().'); return o; };
  ctx.materialsOf = o => { const m = o.userData?.__originalMaterial || o.material; return m ? (Array.isArray(m) ? m : [m]) : []; };
  ctx.setMaterials = (o, materials) => {
    const m = materials.length === 1 ? materials[0] : materials;
    if (o.userData?.__originalMaterial) o.userData.__originalMaterial = m; else o.material = m;
    if (app.currentShadingMode === 'material' || app.currentShadingMode === 'rendered') o.material = m;
  };
  ctx.changed = () => { app.engine?.markShadowDirty?.(); app.engine?.requestRender?.(); window.dispatchEvent(new Event('blender:geometryChanged')); sm.emit('hierarchyChanged'); };
  ctx.mutate = async (label, fn, { deep = false } = {}) => {
    if (busy) throw new AgentError('E_TX_CONFLICT', 'Another agent write is running.', 'Await the previous call before starting another write.');
    busy = true;
    try { return (await tx.run(label, fn, { deep })).result; }
    finally { busy = false; }
  };
  ctx.detach = object => {
    object.traverse(o => { if (o.userData.id && sm.objects.has(o.userData.id)) sm.objects.delete(o.userData.id); });
    if (app.engine.transformControls.object && (app.engine.transformControls.object === object || object.getObjectByProperty('uuid', app.engine.transformControls.object.uuid))) app.engine.transformControls.detach();
    object.removeFromParent();
    sm.setSelection(sm.getSelectedObjects().filter(o => o.parent));
    sm.emit('objectRemoved', { object });
  };
  ctx.confirm = opts => ctx.ui.confirm(opts);
  ctx.requireConfirm = async (title, message, opts = {}) => {
    if (!opts.confirm) throw new AgentError('E_NEEDS_CONFIRM', title, 'Pass {confirm:true} to show a user confirmation dialog.');
    if (!await ctx.confirm({ title, message, danger: true })) throw new AgentError('E_PERMISSION', 'User declined the action.');
  };
  const describe = (o, { depth = 20, compact = false } = {}, level = 0) => {
    const node = { agentId: ctx.ids.assign(o), name: o.name, type: o.type, uuid: o.uuid, visible: o.visible, locked: !!o.userData.locked,
      transform: { pos: vec(o.position), rot: [o.rotation.x, o.rotation.y, o.rotation.z].map(v => Math.round(v * 10000) / 10000), scale: vec(o.scale) },
      material: ctx.materialsOf(o).map(m => ({ matId: ctx.materials.assign(m), name: m.name, type: m.type })) };
    if (!compact && level < depth) node.children = o.children.filter(c => ctx.scan().includes(c)).map(c => describe(c, { depth, compact }, level + 1));
    return node;
  };
  const info = id => {
    const o = ctx.node(id), geometry = o.geometry;
    o.updateWorldMatrix(true, true);
    const bounds = new THREE.Box3().setFromObject(o);
    const bones = []; o.traverse(c => { if (c.isBone) bones.push({ agentId: ctx.ids.assign(c), name: c.name }); });
    return { ...describe(o, { compact: true }), geometry: geometry ? { verts: geometry.attributes.position?.count || 0, tris: (geometry.index?.count || geometry.attributes.position?.count || 0) / 3, uvSets: Object.keys(geometry.attributes).filter(k => /^uv\d*$/.test(k)), attributes: Object.fromEntries(Object.entries(geometry.attributes).map(([k, a]) => [k, { count: a.count, itemSize: a.itemSize }])) } : null,
      materials: ctx.materialsOf(o).map(m => ({ matId: ctx.materials.assign(m), name: m.name, type: m.type, maps: Object.fromEntries(Object.entries(SLOTS).map(([key, slot]) => [key, m[slot] ? { textureId: ctx.textures.assign(m[slot]), name: m[slot].name } : null])), pbr: Object.fromEntries(Object.entries(PBR).filter(([, p]) => p in m).map(([key, p]) => [key, m[p]?.isColor ? colorHex(m[p]) : m[p]])) })),
      bounds: bounds.isEmpty() ? null : { min: vec(bounds.min), max: vec(bounds.max), size: vec(bounds.getSize(new THREE.Vector3())) }, bones, morphTargets: o.morphTargetDictionary || null };
  };
  const wrap = (toolId, fn, { bucket, write = false, deep = false } = {}) => async (...args) => {
    const start = performance.now();
    try {
      if (bucket) {
        const r = rate.take(bucket);
        if (!r.allowed) throw new AgentError('E_PERMISSION', `Rate limit ${r.limit}/minute exceeded.`, `Retry in ${Math.ceil(r.retryInMs / 1000)} seconds.`);
      }
      tx.touchExplicit();
      const result = write ? await ctx.mutate(toolId, () => fn(...args), { deep }) : await fn(...args);
      ctx.log.push({ source: 'agent', message: toolId, data: { elapsedMs: Math.round(performance.now() - start) } });
      return ok(result);
    } catch (e) {
      const error = toErrorObject(e, toolId);
      ctx.log.push({ level: 'error', source: 'agent', message: `${toolId}: ${error.message}` }); ctx.events.emit('error', error);
      return { ok: false, error };
    }
  };
  const namespace = (name, raw, opts = {}) => Object.freeze(Object.fromEntries(Object.entries(raw).map(([key, fn]) => [key, wrap(`${name}.${key}`, fn, opts[key] || {})])));
  const scene = namespace('scene', {
    tree: (opts = {}) => { const nodes = ctx.scan(); return nodes.filter(o => !nodes.includes(o.parent)).map(o => describe(o, opts)); },
    find: (q = {}) => ctx.scan().filter(o => (!q.name || o.name.toLowerCase().includes(String(q.name).toLowerCase())) && (!q.agentId || o.userData.agentId === q.agentId) && (!q.type || o.type === q.type) && (!q.tag || o.userData.tags?.includes(q.tag)) && (!q.materialName || ctx.materialsOf(o).some(m => m.name === q.materialName))).map(o => describe(o, { compact: true })),
    get: () => { throw new AgentError('E_PERMISSION', 'Live scene handles are only exposed inside agent.exec.', "Use agent.scene.info(id), or agent.exec(\"$('obj_1').position.x = 2\")."); },
    info,
    select: ids => { assertArg(Array.isArray(ids), 'Selection must be an array of agentIds.'); sm.setSelection(ids.map(ctx.node)); return ids; },
    focus: id => { const o = ctx.node(id); app.engine.focusOnObject(o); return { agentId: id }; },
    rename: (id, name) => { assertArg(typeof name === 'string' && name.trim().length > 0 && name.length <= 200, 'Name must be 1–200 characters.'); const o = ctx.node(id); sm.renameObject(o, uniqueName(o, name.trim())); return describe(o, { compact: true }); },
    delete: async (id, opts = {}) => { const o = ctx.node(id); await ctx.requireConfirm('Delete object', o.name, opts); return ctx.mutate('Delete object', () => { ctx.detach(o); return { agentId: id, deleted: true }; }); },
    clear: async (opts = {}) => { await ctx.requireConfirm('Clear scene', 'Delete all user objects in the scene?', opts); return ctx.mutate('Clear scene', () => { const nodes = ctx.scan(); nodes.filter(o => !nodes.includes(o.parent)).forEach(ctx.detach); return { cleared: true }; }); }
  }, Object.fromEntries(['tree', 'find', 'info', 'select', 'focus', 'rename', 'delete', 'clear'].map(k => [k, { bucket: 'scene', write: k === 'rename' }])));
  const applyPbr = (m, patch) => {
    assertArg(patch && typeof patch === 'object' && !Array.isArray(patch), 'PBR patch must be an object.');
    for (const [key, value] of Object.entries(patch)) {
      const prop = PBR[key]; assertArg(prop, `Unsupported PBR property '${key}'.`, `Supported: ${Object.keys(PBR).join(', ')}`);
      if (['color', 'emissive'].includes(prop)) { assertArg(typeof value === 'string' && /^#[\da-f]{6}$/i.test(value), `${key} must be #rrggbb.`); m[prop].set(value); }
      else { assertArg(Number.isFinite(value), `${key} must be finite.`); assertArg(value >= 0 && (['ior', 'emissiveIntensity'].includes(key) || value <= 1), `${key} is outside its valid range.`); if (key === 'ior') assertArg(value >= 1 && value <= 2.333, 'ior must be 1–2.333.'); m[prop] = value; }
    }
    m.transparent = m.opacity < 1; m.needsUpdate = true;
    return m;
  };
  const material = namespace('material', {
    create: (name, pbr = {}) => { const m = applyPbr(new THREE.MeshPhysicalMaterial(), pbr); m.name = String(name || 'Material'); return ctx.materials.assign(m); },
    assign: (id, matId) => { const o = ctx.mesh(id), m = ctx.materials.get(matId); if (!m) throw new AgentError('E_NOT_FOUND', `Material ${matId} not found.`); ctx.setMaterials(o, [m]); return { agentId: id, matId }; },
    set: (id, patch) => {
      const o = ctx.mesh(id);
      const mats = ctx.materialsOf(o).map(m => {
        let clone;
        if (m.isMeshPhysicalMaterial) clone = m.clone();
        else { clone = new THREE.MeshPhysicalMaterial(); if (m.isMeshStandardMaterial) THREE.MeshStandardMaterial.prototype.copy.call(clone, m); else { if (m.color) clone.color.copy(m.color); clone.map = m.map || null; } }
        applyPbr(clone, patch); ctx.materials.assign(clone); return clone;
      });
      ctx.setMaterials(o, mats); return info(id).materials;
    },
    listMaps: id => Object.fromEntries(Object.entries(SLOTS).map(([key, slot]) => [key, ctx.materialsOf(ctx.mesh(id)).map(m => m[slot] ? { textureId: ctx.textures.assign(m[slot]), name: m[slot].name } : null)])),
    setMap: (id, slot, textureId, opts = {}) => {
      const key = SLOTS[slot]; assertArg(key, `Unsupported map slot '${slot}'.`);
      const source = textureId === null ? null : ctx.textures.get(textureId);
      if (textureId !== null && !source) throw new AgentError('E_NOT_FOUND', `Texture ${textureId} not found.`);
      const texture = source?.clone();
      if (texture) {
        texture.channel = opts.uvChannel ?? 0; assertArg(Number.isInteger(texture.channel) && texture.channel >= 0 && texture.channel <= 3, 'uvChannel must be 0–3.');
        assertArg(ctx.mesh(id).geometry.getAttribute(texture.channel ? `uv${texture.channel}` : 'uv'), 'Requested UV channel does not exist.');
        const wraps = { repeat: THREE.RepeatWrapping, clamp: THREE.ClampToEdgeWrapping, mirror: THREE.MirroredRepeatWrapping };
        if (opts.wrap) { assertArg(opts.wrap in wraps, 'wrap must be repeat/clamp/mirror.'); texture.wrapS = texture.wrapT = wraps[opts.wrap]; }
        for (const prop of ['repeat', 'offset']) if (opts[prop]) { assertArg(opts[prop].length === 2 && opts[prop].every(Number.isFinite), `${prop} must be [u,v].`); texture[prop].fromArray(opts[prop]); }
        if (opts.rotation !== undefined) { assertArg(Number.isFinite(opts.rotation), 'rotation must be radians.'); texture.rotation = opts.rotation; }
        texture.flipY = opts.flipY ?? false; texture.colorSpace = ['baseColor', 'emissive'].includes(slot) ? THREE.SRGBColorSpace : THREE.NoColorSpace; texture.needsUpdate = true; ctx.textures.assign(texture);
      }
      const o = ctx.mesh(id); ctx.setMaterials(o, ctx.materialsOf(o).map(m => { const clone = m.clone(); clone[key] = texture || null; clone.needsUpdate = true; ctx.materials.assign(clone); return clone; }));
      return { agentId: id, slot, textureId: texture ? ctx.textures.assign(texture) : null };
    }
  }, Object.fromEntries(['create', 'assign', 'set', 'setMap'].map(k => [k, { write: true, bucket: 'scene' }])));
  ctx.screenshot = async ({ width, height, format = 'png', viewportOnly = true } = {}) => {
    if (!viewportOnly) throw new AgentError('E_UNSUPPORTED', 'Full DOM screenshots require the browser tool.', 'Use viewportOnly:true or a browser screenshot.');
    assertArg(['png', 'jpeg', 'webp'].includes(format), 'format must be png, jpeg or webp.');
    const renderer = app.engine.renderer;
    app.engine.scene.updateMatrixWorld(true);
    app.engine.markShadowDirty?.();
    if (app.engine.rasterRenderer && app.engine.rasterRenderer.preset !== 'fast' && app.engine.rasterRenderer.postProcessing?.enabled) {
      app.engine.rasterRenderer.renderFrame({ scene: app.engine.scene, camera: app.engine.camera, hideHelpers: true });
    } else {
      renderer.render(app.engine.scene, app.engine.camera);
    }
    const source = renderer.domElement;
    const w = width ?? source.width, h = height ?? Math.round(w * source.height / source.width);
    assertArg(Number.isInteger(w) && Number.isInteger(h) && w > 0 && h > 0 && w <= 4096 && h <= 4096, 'Screenshot dimensions must be 1–4096.');
    const canvas = document.createElement('canvas'); canvas.width = w; canvas.height = h; canvas.getContext('2d').drawImage(source, 0, 0, w, h);
    return canvas.toDataURL(`image/${format}`, .88);
  };
  const observe = namespace('observe', {
    screenshot: ctx.screenshot,
    logs: opts => ctx.log.query(opts),
    state: () => ({ activePanel: ctx.ui.activePanel(), selection: sm.getSelectedObjects().map(o => ctx.ids.assign(o)), mode: app.sculptMode?.isActive ? 'sculpt' : app.editMode?.isActive ? 'edit' : 'object', dirty: sm.canUndo(), objectCount: ctx.scan().length, fps: Number(document.getElementById('stat-fps')?.textContent) || 0 }),
    performance: () => ({ fps: Number(document.getElementById('stat-fps')?.textContent) || 0, drawCalls: app.engine.renderer.info.render.calls, tris: app.engine.renderer.info.render.triangles, textures: app.engine.renderer.info.memory.textures, gpuMemMB: null })
  });
  const geometry = createGeometryTools(ctx);
  const uv = namespace('uv', geometry.uv, Object.fromEntries(['unwrap', 'project', 'pack', 'transform'].map(k => [k, { write: true, bucket: 'scene' }])));
  const decal = namespace('decal', geometry.decal, { project: { write: true, bucket: 'scene' } });
  const assets = namespace('assets', createAssetTools(ctx), Object.fromEntries(['importURL', 'importFiles', 'loadTexture', 'delete'].map(k => [k, { bucket: 'assets' }])));
  const animation = createAnimationTools(ctx);
  const anim = namespace('anim', { ...animation, mixer: () => { throw new AgentError('E_PERMISSION', 'Live mixers cannot be serialized through the agent API.', 'Use anim.play, pause, seek, blend and stop.'); } }, { retarget: { write: true, bucket: 'scene' } });
  const tutorial = namespace('tutorial', createTutorialTools(ctx));
  const uiRaw = Object.fromEntries(['list', 'click', 'setValue', 'openPanel', 'closePanel', 'activePanel', 'waitFor', 'shortcut', 'highlight', 'status'].map(k => [k, ctx.ui[k].bind(ctx.ui)]));
  const ui = namespace('ui', uiRaw, { click: { write: true }, setValue: { write: true } });
  const docs = namespace('docs', { get: id => ctx.manifest.docs.get(id), search: query => ctx.manifest.docs.search(query), all: () => ctx.manifest.docs.all() });
  const txApi = namespace('tx', {
    begin: label => { if (busy) throw new AgentError('E_TX_CONFLICT', 'A write is in progress.'); return tx.begin(label, { explicit: true, deep: true }).txId; },
    commit: id => { if (busy) throw new AgentError('E_TX_CONFLICT', 'A write is in progress.'); return tx.commit(id); },
    rollback: id => { if (busy) throw new AgentError('E_TX_CONFLICT', 'A write is in progress.'); return tx.rollback(id); }, list: () => tx.list()
  });
  const util = namespace('util', {
    hash: value => fnv1a(stableStringify(value)),
    raycast: ({ x, y }) => { assertArg(Number.isFinite(x) && Number.isFinite(y) && Math.abs(x) <= 1 && Math.abs(y) <= 1, 'x,y must be normalized viewport coordinates -1..1.'); const ray = new THREE.Raycaster(); ray.setFromCamera(new THREE.Vector2(x, y), app.engine.camera); return ray.intersectObjects(ctx.scan(), false).map(hit => ({ agentId: ctx.ids.assign(hit.object), point: vec(hit.point), normal: vec(hit.face?.normal), distance: hit.distance, faceIndex: hit.faceIndex })); }
  });
  const allowedDomains = ['cdn.jsdelivr.net', 'raw.githubusercontent.com', 'assets.mixamo.com', 'models.readyplayer.me', 'raw.githack.com'];
  let proxy = false;
  if (typeof fetch === 'function') {
    fetch('/api/agent/allowlist')
      .then((response) => (response.ok ? response.json() : null))
      .then((result) => {
        if (result?.ok) {
          proxy = true;
          allowedDomains.splice(0, allowedDomains.length, ...(result.data.allowedDomains || allowedDomains));
        }
      })
      .catch(() => {});
  }
  const session = Object.freeze({ id: `session_${crypto.randomUUID()}`, token: crypto.randomUUID(), user: 'local', startedAt: new Date().toISOString(), confirm: wrap('session.confirm', ctx.confirm) });
  const agent = { version: '1.0.0', session, scene, assets, material, uv, decal, anim, ui, observe: Object.freeze({ ...observe, events: Object.freeze({ on: (event, callback) => { assertArg(typeof callback === 'function', 'Event listener must be a function.'); ctx.log.push({ source: 'agent', message: `observe.events.on(${event})` }); return ctx.events.on(event, callback); } }) }), docs, tx: txApi, tutorial, util,
    undo: wrap('undo', () => { if (busy) throw new AgentError('E_TX_CONFLICT', 'Write in progress.'); return tx.undo(); }), redo: wrap('redo', () => { if (busy) throw new AgentError('E_TX_CONFLICT', 'Write in progress.'); return tx.redo(); }),
    caps: wrap('caps', async (opts = {}) => ({ version: '1.0.0', buildHash: fnv1a(JSON.stringify(ctx.manifest.tools().map(t => t.id))), features: { gltf: true, fbx: true, obj: true, draco: true, ktx2: false, exr: true, hdr: true, uvUnwrap: ['smart', 'cube'], decal: true, morph: true, skeleton: true, retarget: true, videoExport: true, screenshot: true, undo: true, proxy, execIsolation: 'worker-csp', execAddons: false, execLiveHandles: 'mirrored', execStudioMethods: ['addCube', 'addSphere', 'addPlane', 'addCylinder', 'addCone', 'addTorus', 'clearScene', 'setColor', 'getObject'] }, tools: ctx.manifest.tools(), shortcuts: SHORTCUTS, limits: { maxUploadMB: 50, maxTextureSize: app.engine.renderer.capabilities.maxTextureSize, maxObjects: 5000, allowedDomains }, audit: await ctx.manifest.audit(opts) }))
  };
  agent.exec = (code, opts = {}) => executeIsolated(code, opts, ctx, tx, wrap, describe, () => busy, value => { busy = value; });
  ctx.ui.init();
  for (const key of ['log', 'info', 'warn', 'error', 'debug']) {
    const original = console[key].bind(console);
    console[key] = (...args) => { ctx.log.push({ level: key, source: 'app', message: args.map(a => typeof a === 'string' ? a : (a?.message || String(a))).join(' ') }); original(...args); };
  }
  window.addEventListener('error', e => { ctx.log.push({ level: 'error', source: 'app', message: e.message }); ctx.events.emit('error', { message: e.message }); });
  window.addEventListener('unhandledrejection', e => ctx.log.push({ level: 'error', source: 'app', message: e.reason?.message || String(e.reason) }));
  ['objectAdded', 'objectRemoved', 'hierarchyChanged', 'selectionChanged'].forEach(event => sm.on(event, () => ctx.events.emit('scene:change', { source: 'app', event })));
  ctx.ui.status('Ready — API v1.0.0', { ttl: 3500 });
  return Object.freeze(agent);
}

export const ALLOWED_NEW_NODE_TYPES = new Set([
  'Mesh', 'InstancedMesh', 'Group', 'Object3D', 'Bone',
  'PointLight', 'DirectionalLight', 'SpotLight', 'HemisphereLight', 'AmbientLight'
]);

export function validateExecNodes(nodes, before = new Map()) {
  const uuids = new Set();
  for (const n of nodes) {
    assertArg(n && typeof n.uuid === 'string' && !uuids.has(n.uuid), 'Invalid or duplicated object UUID.');
    uuids.add(n.uuid);
    const prevNode = before.get(n.uuid);
    if (prevNode && prevNode.type !== n.type) {
      throw new AgentError('E_INVALID_ARG', `exec cannot change existing object "${prevNode.name}" type from ${prevNode.type} to ${n.type}.`);
    }
    if (!prevNode && n.type && !ALLOWED_NEW_NODE_TYPES.has(n.type)) {
      throw new AgentError('E_UNSUPPORTED', `exec cannot synthesize unsupported node type "${n.type}".`);
    }
    assertArg(typeof n.name === 'string' && n.name.length <= 200, 'Object name exceeds 200 characters.');
    for (const p of ['position', 'quaternion', 'scale']) {
      assertArg(Array.isArray(n[p]) && n[p].length === (p === 'quaternion' ? 4 : 3) && n[p].every(Number.isFinite), `Invalid ${p}.`);
    }
  }
  return uuids;
}

function encodeMaterial(m) { return { type: m.type, name: m.name, ...Object.fromEntries(MAT_SCALARS.filter(k => k in m).map(k => [k, m[k]])), ...Object.fromEntries(MAT_COLORS.filter(k => m[k]?.isColor).map(k => [k, colorHex(m[k])])) }; }
function encodeGeometry(g) { const json = g.toJSON(); const out = json.data ? json : new THREE.BufferGeometry().copy(g).toJSON(); delete out.uuid; return out; }

async function executeIsolated(code, opts, ctx, tx, wrap, describe, isBusy, setBusy) {
  const logs = [];
  let worker, timer, ownsBusy = false;
  const call = wrap('exec', async () => {
    assertArg(typeof code === 'string' && code.length <= 200000, 'exec code must be a string under 200KB.');
    const timeout = opts.timeout ?? 30000; assertArg(Number.isInteger(timeout) && timeout >= 1 && timeout <= 120000, 'timeout must be 1–120000ms.');
    const nowMs = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());
    const deadlineAt = nowMs() + timeout;
    if (isBusy() || tx.open) throw new AgentError('E_TX_CONFLICT', 'exec requires no pending writes or transactions.', 'Commit or roll back your explicit transaction first.');
    setBusy(true); ownsBusy = true;
    const workerURL = new URL('./agent-exec-worker.js', import.meta.url);
    const policyResponse = await fetch(workerURL);
    if (nowMs() >= deadlineAt) throw new AgentError('E_TIMEOUT', `exec exceeded ${timeout}ms.`);
    const policy = policyResponse.headers.get('content-security-policy') || '';
    if (!policy.includes("connect-src 'none'") || !policy.includes("worker-src 'none'")) throw new AgentError('E_PERMISSION', 'exec requires the server worker isolation policy.', 'Restart the updated server.py before using exec.');
    const sm = ctx.sceneManager;
    const liveNodes = ctx.scan();
    const nodes = liveNodes.map(o => {
      const entry = {
        uuid: o.uuid, agentId: ctx.ids.assign(o), type: o.type, name: o.name, visible: o.visible,
        parentUUID: liveNodes.includes(o.parent) ? o.parent.uuid : null,
        position: o.position.toArray(), quaternion: o.quaternion.toArray(), scale: o.scale.toArray(),
        geometry: o.geometry ? encodeGeometry(o.geometry) : null,
        materials: ctx.materialsOf(o).map(encodeMaterial),
      };
      if (o.isInstancedMesh) {
        entry.type = 'InstancedMesh';
        entry.instanceCount = o.count;
        entry.instanceMatrices = o.instanceMatrix?.array ? Array.from(o.instanceMatrix.array.subarray(0, o.count * 16)) : [];
      } else if (o.isLight) {
        if (o.color?.isColor) entry.lightColor = o.color.getHex();
        if (o.groundColor?.isColor) entry.groundColor = o.groundColor.getHex();
        if (typeof o.intensity === 'number') entry.lightIntensity = o.intensity;
        if (typeof o.distance === 'number') entry.lightDistance = o.distance;
        if (typeof o.decay === 'number') entry.lightDecay = o.decay;
      }
      return entry;
    });
    assertArg(JSON.stringify(nodes).length <= 24 * 1024 * 1024, 'exec scene snapshot exceeds 24MB.', 'Use direct agent APIs for large assets.');
    const before = new Map(nodes.map(n => [n.uuid, n]));
    const initial = tx.snap.capture({ deep: true });
    const response = await new Promise((resolve, reject) => {
      const remMs = Math.max(1, Math.round(deadlineAt - nowMs()));
      worker = new Worker(new URL('./agent-exec-worker.js', import.meta.url), { type: 'module' });
      timer = setTimeout(() => { worker.terminate(); reject(new AgentError('E_TIMEOUT', `exec exceeded ${timeout}ms.`, 'The worker was terminated; the live scene was not changed.')); }, remMs);
      worker.onerror = e => reject(new AgentError('E_INVALID_ARG', e.message));
      worker.onmessage = e => {
        const message = e.data;
        if (message.kind === 'log') { if (logs.length < 1000) logs.push(message.entry); }
        else if (message.kind === 'error') reject(new AgentError(message.error.code, message.error.message, message.error.hint));
        else if (message.kind === 'result') resolve(message);
      };
      worker.postMessage({ code, nodes, selection: sm.getSelectedObjects().map(o => ctx.ids.assign(o)) });
    });
    worker.terminate(); clearTimeout(timer);
    const intervening = tx.snap.diff(initial);
    if (!intervening.empty || intervening.selectionChanged) throw new AgentError('E_TX_CONFLICT', 'The user changed the scene during exec.', 'Retry against the current scene; user edits were preserved.');
    assertArg(Array.isArray(response.nodes) && response.nodes.length <= 5000, 'exec scene exceeds object limit.');
    const uuids = validateExecNodes(response.nodes, before);
    if (nowMs() >= deadlineAt) throw new AgentError('E_TIMEOUT', `exec exceeded ${timeout}ms before commit.`);
    for (const n of response.nodes) {
      if (!n.parentUUID) continue;
      assertArg(uuids.has(n.parentUUID), 'Missing parent UUID.');
      const visited = new Set([n.uuid]); let parent = n.parentUUID;
      while (parent) { assertArg(!visited.has(parent), 'Scene hierarchy contains a cycle.'); visited.add(parent); parent = response.nodes.find(x => x.uuid === parent)?.parentUUID; }
    }
    const removed = nodes.filter(n => !uuids.has(n.uuid));
    if (opts.dryRun) {
      const changes = { added: [], removed: removed.map(n => ({ agentId: n.agentId, name: n.name, type: n.type })), modified: [], materialsChanged: [], texturesChanged: 0, geometriesChanged: 0 };
      for (const n of response.nodes) {
        const old = before.get(n.uuid);
        if (!old) { changes.added.push({ agentId: null, name: n.name, type: n.type }); continue; }
        const fields = ['position', 'quaternion', 'scale', 'name', 'visible', 'parentUUID'].filter(k => JSON.stringify(n[k]) !== JSON.stringify(old[k]));
        if (JSON.stringify(n.geometry) !== JSON.stringify(old.geometry)) { fields.push('geometry'); changes.geometriesChanged++; }
        if (JSON.stringify(n.materials) !== JSON.stringify(old.materials)) { fields.push('material'); changes.materialsChanged.push({ agentId: n.agentId }); }
        if (fields.length) changes.modified.push({ agentId: n.agentId, name: n.name, fields });
      }
      return { value: toPlain(response.value, describe), logs, changes, txId: null, dryRun: true, autoCommit: false };
    }
    if (removed.length) await ctx.requireConfirm('exec deletes scene objects', removed.map(n => n.name).join(', '), opts);
    const confirmedDiff = tx.snap.diff(initial);
    if (!confirmedDiff.empty || confirmedDiff.selectionChanged) throw new AgentError('E_TX_CONFLICT', 'Scene changed while waiting for confirmation.', 'Retry against the current scene.');
    const transaction = tx.begin(opts.label || 'Execute script', { deep: true, explicit: opts.autoCommit === false });
    try {
      const objects = new Map(liveNodes.map(o => [o.uuid, o]));
      for (const n of response.nodes) {
        let object = objects.get(n.uuid);
        if (!object) {
          if (n.type === 'InstancedMesh' && n.geometry) {
            const g = new THREE.BufferGeometryLoader().parse(n.geometry);
            const cnt = Math.max(0, Number(n.instanceCount) || 0);
            const inst = new THREE.InstancedMesh(g, new THREE.MeshStandardMaterial(), cnt);
            if (Array.isArray(n.instanceMatrices) && n.instanceMatrices.length >= cnt * 16 && inst.instanceMatrix?.array) {
              inst.instanceMatrix.array.set(n.instanceMatrices.slice(0, cnt * 16));
              inst.instanceMatrix.needsUpdate = true;
            }
            object = inst;
          } else if (n.geometry) object = new THREE.Mesh(new THREE.BufferGeometryLoader().parse(n.geometry), new THREE.MeshStandardMaterial());
          else if (n.type === 'PointLight') object = new THREE.PointLight(n.lightColor ?? 0xffffff, n.lightIntensity ?? 1, n.lightDistance ?? 0, n.lightDecay ?? 2);
          else if (n.type === 'DirectionalLight') object = new THREE.DirectionalLight(n.lightColor ?? 0xffffff, n.lightIntensity ?? 1);
          else if (n.type === 'SpotLight') object = new THREE.SpotLight(n.lightColor ?? 0xffffff, n.lightIntensity ?? 1, n.lightDistance ?? 0);
          else if (n.type === 'HemisphereLight') object = new THREE.HemisphereLight(n.lightColor ?? 0xffffff, n.groundColor ?? 0x444444, n.lightIntensity ?? 1);
          else if (n.type === 'AmbientLight') object = new THREE.AmbientLight(n.lightColor ?? 0xffffff, n.lightIntensity ?? 1);
          else object = n.type === 'Bone' ? new THREE.Bone() : new THREE.Group();
          object.uuid = n.uuid; object.name = n.name; ctx.ids.assign(object); objects.set(n.uuid, object);
        }
      }
      removed.filter(n => !removed.some(p => p.uuid === n.parentUUID)).forEach(n => ctx.detach(objects.get(n.uuid)));
      for (const n of response.nodes) {
        const object = objects.get(n.uuid), old = before.get(n.uuid);
        const parent = n.parentUUID ? objects.get(n.parentUUID) : sm.rootContainer;
        if (!old) sm.addObject(object, parent, false, false);
        else if ((old.parentUUID || null) !== n.parentUUID) parent.add(object);
        object.position.fromArray(n.position); object.quaternion.fromArray(n.quaternion); object.scale.fromArray(n.scale); object.visible = n.visible;
        if (!old || n.name !== old.name) sm.renameObject(object, n.name);
        if (!object.isLight && !object.isCamera && n.geometry && (!old || JSON.stringify(n.geometry) !== JSON.stringify(old.geometry))) object.geometry = new THREE.BufferGeometryLoader().parse(n.geometry);
        if (!object.isLight && !object.isCamera && n.materials.length && (!old || JSON.stringify(n.materials) !== JSON.stringify(old.materials))) {
          const materials = n.materials.map((data, i) => {
            const source = ctx.materialsOf(object)[i];
            const mat = source?.clone() || new THREE.MeshPhysicalMaterial();
            const { type, ...params } = data; mat.setValues(params); mat.needsUpdate = true; ctx.materials.assign(mat); return mat;
          });
          ctx.setMaterials(object, materials);
        }
        ctx.assignHierarchy(object); object.updateMatrix();
      }
      if (response.selection) sm.setSelection(response.selection.map(id => ctx.scan().find(o => o.userData.agentId === id)).filter(Boolean));
      const jobResults = new Map();
      const resolveExecTarget = (ref) => {
        if (!ref) return ref;
        if (typeof ref === 'string' && objects.has(ref)) return objects.get(ref);
        return ref;
      };
      if (Array.isArray(response.commands) && response.commands.length && typeof window !== 'undefined' && window.studio) {
        for (const cmd of response.commands) {
          if (nowMs() >= deadlineAt) throw new AgentError('E_TIMEOUT', `exec exceeded ${timeout}ms during host commands.`);
          if (!cmd || !Array.isArray(cmd.args)) continue;
          let cmdRes = null;
          if (cmd.method === 'applyProceduralPBR' && typeof window.studio.applyProceduralPBR === 'function') {
            cmdRes = await window.studio.applyProceduralPBR(resolveExecTarget(cmd.args[0]), cmd.args[1]);
          } else if (cmd.method === 'setColor' && typeof window.studio.setColor === 'function') {
            window.studio.setColor(resolveExecTarget(cmd.args[0]), cmd.args[1]);
            cmdRes = { ok: true };
          } else if (cmd.method === 'setEmissive' && typeof window.studio.setEmissive === 'function') {
            window.studio.setEmissive(resolveExecTarget(cmd.args[0]), cmd.args[1], cmd.args[2]);
            cmdRes = { ok: true };
          } else if (cmd.method === 'boolean' && typeof window.studio.boolean === 'function') {
            cmdRes = await window.studio.boolean(cmd.args[0], resolveExecTarget(cmd.args[1]), resolveExecTarget(cmd.args[2]), cmd.args[3]);
          } else if (cmd.method === 'exportModel' && window.app?.exporter?.exportGLTF) {
            const exp = await window.app.exporter.exportGLTF(null, { download: false, ...(cmd.args[0] || {}) });
            cmdRes = { ok: true, filename: exp?.filename || 'model.glb', bytes: exp?.blob?.size || exp?.buffer?.byteLength || 0 };
          }
          if (cmd.jobId && cmdRes !== null) jobResults.set(cmd.jobId, cmdRes);
        }
      }
      if (jobResults.size) {
        const rewriteExecTokens = (val) => {
          if (Array.isArray(val)) return val.map(rewriteExecTokens);
          if (!val || typeof val !== 'object') return val;
          if (val.__execJobToken && jobResults.has(val.__execJobToken)) {
            return jobResults.get(val.__execJobToken);
          }
          const out = {};
          for (const [k, v] of Object.entries(val)) out[k] = rewriteExecTokens(v);
          return out;
        };
        response.value = rewriteExecTokens(response.value);
      }
      ctx.changed();
      const changes = tx.preview(transaction);
      if (opts.dryRun) tx.rollback(transaction.txId);
      else if (opts.autoCommit !== false) tx.commit(transaction.txId);
      return { value: toPlain(response.value, describe), logs, changes, txId: transaction.txId, dryRun: !!opts.dryRun, autoCommit: opts.autoCommit !== false };
    } catch (e) { if (transaction.status === 'open') tx.rollback(transaction.txId); throw e; }
  });
  try {
    const result = await call();
    return result.ok ? { ...result, value: result.data.value, logs } : { ...result, value: null, logs };
  } finally { clearTimeout(timer); worker?.terminate(); if (ownsBusy) setBusy(false); }
}
