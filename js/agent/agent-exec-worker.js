import * as THREE from '../../vendor/three/three.module.js';
import {
  sample2DContour,
  buildExtrudeGeometry,
  buildSweepGeometry,
  buildLatheGeometry,
  buildSurfaceShellGeometry,
  buildLoftGeometry,
  sampleCurve3D,
  buildCurveScatterInstances,
  buildInstancedMesh,
  indexGeometry,
  mergePartGeometries,
  modifyGeometrySync,
} from '../core/geometry/parametric-cad.js';
import { inspectSceneBudget } from '../core/scene-budget.js';

const send = self.postMessage.bind(self);
const deny = () => { throw Object.assign(new Error('Network, storage and browser globals are unavailable in agent.exec; use agent.assets outside exec.'), { code: 'E_PERMISSION' }); };
for (const key of [
  'fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'WebTransport', 'Worker', 'SharedWorker',
  'importScripts', 'indexedDB', 'caches', 'cookieStore', 'BroadcastChannel', 'MessageChannel',
  'MessagePort', 'navigator', 'location', 'ServiceWorker', 'FileReader', 'FileReaderSync',
  'showDirectoryPicker', 'showOpenFilePicker', 'showSaveFilePicker'
]) {
  Object.defineProperty(self, key, { get: deny, configurable: false });
}
const scalarProps = ['roughness', 'metalness', 'opacity', 'transparent', 'wireframe', 'side', 'emissiveIntensity', 'clearcoat', 'clearcoatRoughness', 'transmission', 'ior', 'sheen', 'sheenRoughness', 'vertexColors', 'flatShading'];
const colors = ['color', 'emissive', 'sheenColor'];
const encodeMat = m => ({ type: m.type, name: m.name, ...Object.fromEntries(scalarProps.filter(k => k in m).map(k => [k, m[k]])), ...Object.fromEntries(colors.filter(k => m[k]?.isColor).map(k => [k, `#${m[k].getHexString()}`])) });
const geometryJSON = g => {
  const out = g.toJSON();
  if (!out.data) { const plain = new THREE.BufferGeometry().copy(g); return plain.toJSON(); }
  delete out.uuid;
  return out;
};
self.onmessage = async event => {
  const { code, nodes, selection } = event.data;
  const scene = new THREE.Scene();
  const objects = new Map();
  const logs = [];
  const log = Object.freeze(Object.fromEntries(['log', 'info', 'warn', 'error', 'debug'].map(level => [level, (...args) => {
    const entry = { level, args: args.map(v => typeof v === 'object' ? (v?.isObject3D ? { name: v.name, type: v.type } : String(v)) : v), ts: Date.now() };
    logs.push(entry); send({ kind: 'log', entry });
  }])));
  try {
    for (const n of nodes) {
      let o;
      const mats = (n.materials || []).map(m => {
        const Constructor = ['MeshStandardMaterial', 'MeshPhysicalMaterial', 'MeshBasicMaterial', 'MeshPhongMaterial', 'MeshLambertMaterial'].includes(m.type) ? THREE[m.type] : THREE.MeshStandardMaterial;
        const { type, ...params } = m; return new Constructor(params);
      });
      if (n.type === 'InstancedMesh' && n.geometry) {
        const g = new THREE.BufferGeometryLoader().parse(n.geometry);
        const cnt = Math.max(0, Number(n.instanceCount) || 0);
        const inst = new THREE.InstancedMesh(g, mats.length === 1 ? mats[0] : (mats[0] || new THREE.MeshStandardMaterial()), cnt);
        if (Array.isArray(n.instanceMatrices) && n.instanceMatrices.length >= cnt * 16 && inst.instanceMatrix?.array) {
          inst.instanceMatrix.array.set(n.instanceMatrices.slice(0, cnt * 16));
          inst.instanceMatrix.needsUpdate = true;
        }
        o = inst;
      } else if (n.geometry) {
        o = new THREE.Mesh(new THREE.BufferGeometryLoader().parse(n.geometry), mats.length === 1 ? mats[0] : mats);
        if (n.type === 'SkinnedMesh') o.userData.__preserveHostType = 'SkinnedMesh';
      } else if (n.type === 'PointLight') {
        o = new THREE.PointLight(n.lightColor ?? 0xffffff, n.lightIntensity ?? 1, n.lightDistance ?? 0, n.lightDecay ?? 2);
      } else if (n.type === 'DirectionalLight') {
        o = new THREE.DirectionalLight(n.lightColor ?? 0xffffff, n.lightIntensity ?? 1);
      } else if (n.type === 'SpotLight') {
        o = new THREE.SpotLight(n.lightColor ?? 0xffffff, n.lightIntensity ?? 1, n.lightDistance ?? 0);
      } else if (n.type === 'HemisphereLight') {
        o = new THREE.HemisphereLight(n.lightColor ?? 0xffffff, n.groundColor ?? 0x444444, n.lightIntensity ?? 1);
      } else if (n.type === 'AmbientLight') {
        o = new THREE.AmbientLight(n.lightColor ?? 0xffffff, n.lightIntensity ?? 1);
      } else if (n.type === 'Bone') o = new THREE.Bone();
      else {
        o = new THREE.Group();
        if (n.type && n.type !== 'Group') o.userData.__preserveHostType = n.type;
      }
      o.uuid = n.uuid; o.name = n.name; o.userData.agentId = n.agentId;
      o.position.fromArray(n.position); o.quaternion.fromArray(n.quaternion); o.scale.fromArray(n.scale); o.visible = n.visible;
      objects.set(n.uuid, o);
    }
    for (const n of nodes) (objects.get(n.parentUUID) || scene).add(objects.get(n.uuid));
    const find = id => {
      let out; scene.traverse(o => { if (o.userData.agentId === id || o.name === id) out = o; });
      if (!out) throw Object.assign(new Error(`Object ${id} not found`), { code: 'E_NOT_FOUND' });
      return out;
    };
    const describe = o => ({ agentId: o.userData.agentId || null, name: o.name, type: o.type, uuid: o.uuid, visible: o.visible, transform: { pos: o.position.toArray(), rot: [o.rotation.x, o.rotation.y, o.rotation.z], scale: o.scale.toArray() }, children: o.children.map(describe) });
    const add = (geometry, opts = {}) => {
      const hasVC = Boolean(geometry?.attributes?.color);
      const o = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({
        color: opts.color || '#a8b4c4',
        roughness: opts.roughness ?? .6,
        metalness: opts.metalness ?? 0,
        vertexColors: opts.vertexColors ?? hasVC,
        flatShading: opts.flatShading ?? false,
      }));
      o.name = opts.name || geometry.type.replace('Geometry', '');
      o.position.set(opts.x || 0, opts.y || 0, opts.z || 0);
      o.rotation.set(Number(opts.rotationX) || 0, Number(opts.rotationY) || 0, Number(opts.rotationZ) || 0);
      if (typeof opts.scale === 'number') o.scale.setScalar(opts.scale);
      else if (Array.isArray(opts.scale) && opts.scale.length === 3) o.scale.fromArray(opts.scale.map(Number));
      const parent = opts.parent?.isObject3D ? opts.parent : (typeof opts.parent === 'string' ? find(opts.parent) : scene);
      parent.add(o);
      return o;
    };
    const commands = [];
    let jobSeq = 0;
    const pbrQueuedObjects = new WeakSet();
    const pbrQueuedNames = new Set();
    const queueLiveCommand = (method, args) => {
      if (commands.length >= 256) throw Object.assign(new Error('Too many deferred live commands in exec.'), { code: 'E_TOO_LARGE' });
      const jobId = `exec_job_${++jobSeq}`;
      commands.push({ jobId, method, args });
      if (method === 'applyProceduralPBR' && args.length > 0) {
        const tgt = args[0];
        if (typeof tgt === 'string') pbrQueuedNames.add(tgt);
      }
      return { ok: true, queued: true, jobId, method, __execJobToken: jobId };
    };
    const studio = Object.freeze({
      addGroup: (name = 'Group', opts = {}) => {
        const g = new THREE.Group();
        g.name = typeof name === 'string' ? name : (opts?.name || 'Group');
        const cfg = typeof name === 'object' ? name : opts;
        if (cfg) {
          g.position.set(Number(cfg.x) || 0, Number(cfg.y) || 0, Number(cfg.z) || 0);
          if (typeof cfg.scale === 'number') g.scale.setScalar(cfg.scale);
        }
        const parent = cfg?.parent?.isObject3D ? cfg.parent : (typeof cfg?.parent === 'string' ? find(cfg.parent) : scene);
        parent.add(g);
        return g;
      },
      addCube: opts => add(new THREE.BoxGeometry(opts?.width || 1, opts?.height || 1, opts?.depth || 1), opts),
      addSphere: opts => add(new THREE.SphereGeometry(opts?.radius || 1, 32, 16), opts),
      addPlane: opts => add(new THREE.PlaneGeometry(opts?.width || 2, opts?.height || 2), opts),
      addCylinder: opts => add(new THREE.CylinderGeometry(opts?.radius || 1, opts?.radius || 1, opts?.height || 2, 32), opts),
      addCone: opts => add(new THREE.ConeGeometry(opts?.radius || 1, opts?.height || 2, 32), opts),
      addTorus: opts => add(new THREE.TorusGeometry(opts?.radius || 1, opts?.tube || .3), opts),
      sampleContour: (c, s) => sample2DContour(c, s),
      addExtrude: opts => add(buildExtrudeGeometry(opts || {}, THREE), opts),
      addSweep: opts => add(buildSweepGeometry(opts || {}, THREE), opts),
      addLathe: opts => add(buildLatheGeometry(opts || {}, THREE), opts),
      addSurfaceGrid: opts => add(buildSurfaceShellGeometry(opts || {}, THREE), opts),
      addLoft: opts => add(buildLoftGeometry(opts || {}, THREE), opts),
      sampleCurve3D: opts => sampleCurve3D(opts || {}, THREE),
      createCurve3D: opts => sampleCurve3D(opts || {}, THREE),
      addInstancedMesh: (source, instances = [], opts = {}) => {
        const src = typeof source === 'string' ? find(source) : source;
        const geom = src?.isBufferGeometry ? src : src?.geometry;
        const mat = opts.material || src?.material || new THREE.MeshStandardMaterial({ color: opts.color || '#a8b4c4', roughness: opts.roughness ?? 0.6, metalness: opts.metalness ?? 0 });
        const inst = buildInstancedMesh(geom, mat, instances, opts, THREE);
        inst.name = opts.name || 'InstancedMesh';
        if (opts.removeSource && src?.isObject3D) src.removeFromParent();
        const parent = opts.parent?.isObject3D ? opts.parent : scene;
        parent.add(inst);
        return inst;
      },
      scatterOnCurve: (sourceOrOpts, curveOrOpts = {}, opts = {}) => {
        let samples, cfg, srcObj;
        if (
          sourceOrOpts &&
          typeof sourceOrOpts === 'object' &&
          !sourceOrOpts.isObject3D &&
          !sourceOrOpts.isBufferGeometry &&
          ('curve' in sourceOrOpts || 'geometry' in sourceOrOpts || 'source' in sourceOrOpts)
        ) {
          cfg = sourceOrOpts;
          samples = Array.isArray(cfg.curve) ? cfg.curve : sampleCurve3D(cfg.curve || cfg, THREE);
          srcObj = typeof cfg.source === 'string' ? find(cfg.source) : (cfg.source || cfg.geometry || null);
        } else {
          cfg = opts || {};
          srcObj = typeof sourceOrOpts === 'string' ? find(sourceOrOpts) : sourceOrOpts;
          samples = Array.isArray(curveOrOpts) ? curveOrOpts : sampleCurve3D(curveOrOpts || {}, THREE);
        }
        const instances = buildCurveScatterInstances(samples, cfg);
        const geom = srcObj?.isBufferGeometry ? srcObj : (srcObj?.geometry || new THREE.BoxGeometry(0.2, 0.2, 0.2));
        const mat = cfg.material || srcObj?.material || new THREE.MeshStandardMaterial({ color: cfg.color || '#a8b4c4', roughness: cfg.roughness ?? 0.6 });
        const inst = buildInstancedMesh(geom, mat, instances, cfg, THREE);
        inst.name = cfg.name || 'CurveScatter';
        scene.add(inst);
        return inst;
      },
      scatter: (source, surface, opts = {}) => {
        const src = typeof source === 'string' ? find(source) : source;
        const surfObj = typeof surface === 'string' ? find(surface) : (surface?.isObject3D ? surface : null);
        const count = Math.max(1, Math.min(2000, Math.round(Number(opts.count) || 12)));
        let s = (Number(opts.seed) || 42) >>> 0;
        const rand = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
        const instances = [];
        if (surfObj) {
          surfObj.updateMatrixWorld(true);
          const box = new THREE.Box3().setFromObject(surfObj);
          const minX = Number.isFinite(box.min.x) ? box.min.x : -5;
          const maxX = Number.isFinite(box.max.x) ? box.max.x : 5;
          const minZ = Number.isFinite(box.min.z) ? box.min.z : -5;
          const maxZ = Number.isFinite(box.max.z) ? box.max.z : 5;
          const topY = Number.isFinite(box.max.y) ? box.max.y : (Number(opts.y) || 0);
          for (let i = 0; i < count; i++) {
            instances.push({
              x: minX + rand() * (maxX - minX),
              y: topY,
              z: minZ + rand() * (maxZ - minZ),
              rotationY: rand() * Math.PI * 2,
            });
          }
        } else {
          const radius = Number(opts.radius) || 5;
          for (let i = 0; i < count; i++) {
            const a = rand() * Math.PI * 2;
            const r = Math.sqrt(rand()) * radius;
            instances.push({ x: Math.cos(a) * r, y: Number(opts.y) || 0, z: Math.sin(a) * r, rotationY: rand() * Math.PI * 2 });
          }
        }
        const geom = src?.geometry || new THREE.BoxGeometry(0.4, 0.4, 0.4);
        const mat = src?.material || new THREE.MeshStandardMaterial({ color: '#7ea87e' });
        const inst = buildInstancedMesh(geom, mat, instances, opts, THREE);
        inst.name = opts.name || 'Scattered';
        scene.add(inst);
        return inst;
      },
      boolean: (arg0 = 'subtract', arg1 = null, arg2 = null, opts = {}) => {
        const opNames = new Set(['subtract', 'difference', 'union', 'intersect']);
        let op, targetA, targetB;
        if (typeof arg0 === 'string' && opNames.has(arg0.toLowerCase())) {
          op = arg0; targetA = arg1; targetB = arg2;
        } else {
          targetA = arg0; targetB = arg1; op = typeof arg2 === 'string' ? arg2 : 'subtract';
        }
        const objA = typeof targetA === 'string' ? find(targetA) : targetA;
        const objB = typeof targetB === 'string' ? find(targetB) : targetB;
        return queueLiveCommand('boolean', [op, objA?.uuid || targetA, objB?.uuid || targetB, opts]);
      },
      applyProceduralPBR: (target, opts = {}) => {
        const obj = typeof target === 'string' ? find(target) : target;
        const key = obj?.uuid || target;
        if (obj) pbrQueuedObjects.add(obj);
        if (typeof key === 'string') pbrQueuedNames.add(key);
        return queueLiveCommand('applyProceduralPBR', [key, opts]);
      },
      exportModel: (opts = {}) => queueLiveCommand('exportModel', [opts]),
      inspectSceneBudget: (tierOrOpts = 'architecture') => inspectSceneBudget(scene, typeof tierOrOpts === 'string' ? { tier: tierOrOpts } : (tierOrOpts || {})),
      indexGeometry: (geom, opts = {}) => indexGeometry(geom, opts, THREE),
      mergeMeshes: (parts, opts = {}) => {
        const geom = mergePartGeometries(parts, opts, THREE);
        if (opts.removeSources && Array.isArray(parts)) {
          for (const item of parts) {
            if (item?.isObject3D) item.removeFromParent();
          }
        }
        return add(geom, opts);
      },
      modifyGeometry: (id, type, params = {}) => { const o = typeof id === 'string' ? find(id) : id; if (o?.geometry) o.geometry = modifyGeometrySync(o.geometry, type, params, THREE); return o; },
      clearScene: () => { scene.clear(); },
      setColor: (id, color) => {
        const o = typeof id === 'string' ? find(id) : id;
        if (!o) return null;
        o.traverse?.((c) => {
          if (!c.material) return;
          (Array.isArray(c.material) ? c.material : [c.material]).forEach(m => m?.color?.set(color));
        });
        if (pbrQueuedObjects.has(o) || pbrQueuedNames.has(o.uuid) || (o.name && pbrQueuedNames.has(o.name)) || (typeof id === 'string' && pbrQueuedNames.has(id))) {
          queueLiveCommand('setColor', [o.uuid, color]);
        }
        return o;
      },
      setEmissive: (id, color, intensity = 1) => {
        const o = typeof id === 'string' ? find(id) : id;
        if (!o) return null;
        o.traverse?.((c) => {
          if (!c.material) return;
          (Array.isArray(c.material) ? c.material : [c.material]).forEach((m) => {
            if (m?.emissive) m.emissive.set(color);
            if (m) m.emissiveIntensity = intensity;
          });
        });
        if (pbrQueuedObjects.has(o) || pbrQueuedNames.has(o.uuid) || (o.name && pbrQueuedNames.has(o.name)) || (typeof id === 'string' && pbrQueuedNames.has(id))) {
          queueLiveCommand('setEmissive', [o.uuid, color, intensity]);
        }
        return o;
      },
      getObject: find
    });
    const agent = Object.freeze({ version: '1.0.0', scene: Object.freeze({
      get: find,
      tree: () => ({ ok: true, data: scene.children.map(describe) }),
      find: query => ({ ok: true, data: [...objects.values()].filter(o => !query.name || o.name.includes(query.name)).map(describe) }),
      rename: (id, name) => { find(id).name = name; return { ok: true, data: { agentId: id, name } }; },
      delete: id => { find(id).removeFromParent(); return { ok: true, data: { deleted: id } }; },
      select: ids => { selection.splice(0, selection.length, ...ids); return { ok: true, data: ids }; }
    }) });
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    const value = await new AsyncFunction('THREE', 'THREE_ADDONS', 'scene', 'studio', 'agent', 'console', '$', `"use strict";\n${code}`)(THREE, Object.freeze({}), scene, studio, agent, log, find);
    const resultNodes = [];
    scene.traverse(o => {
      if (o === scene) return;
      const entry = {
        uuid: o.uuid, agentId: o.userData.agentId || null, type: o.userData.__preserveHostType || o.type, name: o.name, visible: o.visible,
        parentUUID: o.parent === scene ? null : o.parent.uuid,
        position: o.position.toArray(), quaternion: o.quaternion.toArray(), scale: o.scale.toArray(),
        geometry: o.geometry ? geometryJSON(o.geometry) : null,
        materials: o.material ? (Array.isArray(o.material) ? o.material : [o.material]).map(encodeMat) : [],
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
      resultNodes.push(entry);
    });
    const plain = v => {
      if (v?.isObject3D) return describe(v);
      if (v?.isVector3 || v?.isVector2 || v?.isQuaternion) return v.toArray();
      if (v === undefined) return null;
      try { return JSON.parse(JSON.stringify(v)); } catch { return String(v); }
    };
    send({ kind: 'result', nodes: resultNodes, commands, selection, value: plain(value), logs });
  } catch (e) { send({ kind: 'error', error: { code: e.code || 'E_INVALID_ARG', message: e.message, hint: 'Use the mirrored THREE scene or supported studio primitives inside exec; call other agent APIs outside exec.' }, logs }); }
};
