/**
 * Web Worker offload cho phép tính hình học nặng (Giai đoạn nền móng 3).
 * File: js/core/geometry-worker.js
 *
 * Module worker KHÔNG thừa hưởng import map của document, nên không thể import
 * bare 'three' / 'three-mesh-bvh' / 'three-bvh-csg'. Bootstrap này nạp source
 * vendor và viết lại bare import sang URL tuyệt đối TRONG BỘ NHỚ (không sửa
 * file vendor), rồi dựng MeshBVH / CSG trên luồng riêng để không chặn UI.
 *
 * Giao thức: { id, type: 'bvh' | 'csg', ... } -> { id, ok, ... } (transferable).
 */
import * as THREE from '../../vendor/three/three.module.js';

const threeURL = new URL('../../vendor/three/three.module.js', import.meta.url).href;

async function loadRewritten(url, replacements) {
  let code = await (await fetch(url, { cache: 'no-store' })).text();
  for (const [from, to] of replacements) code = code.split(from).join(to);
  return import(URL.createObjectURL(new Blob([code], { type: 'text/javascript' })));
}

// Không top-level await: đăng ký onmessage đồng bộ để mọi request đầu tiên được
// xếp hàng; bootstrap nạp module nằm trong promise `ready` mà handler tự chờ.
const ready = (async () => {
  const bvhCode = await (await fetch(new URL('../../vendor/three-mesh-bvh/index.module.js', import.meta.url).href)).text();
  const bvhURL = URL.createObjectURL(new Blob([bvhCode.split("from 'three'").join(`from '${threeURL}'`)], { type: 'text/javascript' }));
  const { MeshBVH } = await import(bvhURL);
  const csgCode = await (await fetch(new URL('../../vendor/three-bvh-csg/index.module.js', import.meta.url).href)).text();
  const csgURL = URL.createObjectURL(new Blob([
    csgCode.split("from 'three'").join(`from '${threeURL}'`).split("from 'three-mesh-bvh'").join(`from '${bvhURL}'`)
  ], { type: 'text/javascript' }));
  const csg = await import(csgURL);

  const noiseURL = new URL('./geometry/noise.js', import.meta.url).href;
  const topologyURL = new URL('./geometry/mesh-topology.js', import.meta.url).href;
  const deformOpsCode = await (await fetch(new URL('./geometry/deform-ops.js', import.meta.url).href)).text();
  const deformOpsURL = URL.createObjectURL(new Blob([
    deformOpsCode
      .split("from 'three'").join(`from '${threeURL}'`)
      .split("from './noise.js'").join(`from '${noiseURL}'`)
      .split("from './mesh-topology.js'").join(`from '${topologyURL}'`)
  ], { type: 'text/javascript' }));

  const bevelCode = await (await fetch(new URL('./geometry/bevel.js', import.meta.url).href)).text();
  const bevelURL = URL.createObjectURL(new Blob([
    bevelCode
      .split("from 'three'").join(`from '${threeURL}'`)
      .split("from './mesh-topology.js'").join(`from '${topologyURL}'`)
  ], { type: 'text/javascript' }));

  const catmullCode = await (await fetch(new URL('./geometry/catmull-clark.js', import.meta.url).href)).text();
  const catmullURL = URL.createObjectURL(new Blob([
    catmullCode.split("from 'three'").join(`from '${threeURL}'`)
  ], { type: 'text/javascript' }));

  const hardSurfaceCode = await (await fetch(new URL('./geometry/hard-surface-ops.js', import.meta.url).href)).text();
  const hardSurfaceURL = URL.createObjectURL(new Blob([
    hardSurfaceCode
      .split("from 'three'").join(`from '${threeURL}'`)
      .split("from './mesh-topology.js'").join(`from '${topologyURL}'`)
  ], { type: 'text/javascript' }));

  const proModCode = await (await fetch(new URL('./geometry/pro-modifiers.js', import.meta.url).href)).text();
  const proModURL = URL.createObjectURL(new Blob([
    proModCode
      .split("from 'three'").join(`from '${threeURL}'`)
      .split("from 'three-mesh-bvh'").join(`from '${bvhURL}'`)
  ], { type: 'text/javascript' }));

  const dataBlocksURL = new URL('./data-blocks.js', import.meta.url).href;
  const curveObjCode = await (await fetch(new URL('./curve-objects.js', import.meta.url).href)).text();
  const curveObjURL = URL.createObjectURL(new Blob([
    curveObjCode
      .split("from 'three'").join(`from '${threeURL}'`)
      .split("from './data-blocks.js'").join(`from '${dataBlocksURL}'`)
  ], { type: 'text/javascript' }));

  const modifiersURL = new URL('./modifiers.js', import.meta.url).href;
  const modifiers = await loadRewritten(
    modifiersURL,
    [
      ["from 'three'", `from '${threeURL}'`],
      ["from 'three-bvh-csg'", `from '${csgURL}'`],
      ["from './geometry/deform-ops.js'", `from '${deformOpsURL}'`],
      ["from './geometry/bevel.js'", `from '${bevelURL}'`],
      ["from './geometry/catmull-clark.js'", `from '${catmullURL}'`],
      ["from './geometry/hard-surface-ops.js'", `from '${hardSurfaceURL}'`],
      ["from './geometry/pro-modifiers.js'", `from '${proModURL}'`],
      ["from './curve-objects.js'", `from '${curveObjURL}'`]
    ]
  );
  return { MeshBVH, ...csg, modifiers };
})();

const OP_MAP = {
  difference: 'SUBTRACTION',
  subtract: 'SUBTRACTION',
  union: 'ADDITION',
  intersect: 'INTERSECTION',
  xor: 'DIFFERENCE',
};
const cancelled = new Set();

function geometryFrom(payload) {
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(payload.position, 3));
  if (payload.normal) geom.setAttribute('normal', new THREE.BufferAttribute(payload.normal, 3));
  if (payload.uv) geom.setAttribute('uv', new THREE.BufferAttribute(payload.uv, 2));
  if (payload.color) geom.setAttribute('color', new THREE.BufferAttribute(payload.color, payload.colorItemSize || 3));
  if (payload.index) geom.setIndex(new THREE.BufferAttribute(payload.index, 1));
  if (Array.isArray(payload.groups)) for (const g of payload.groups) geom.addGroup(g.start, g.count, g.materialIndex);
  if (payload.drawRange) geom.drawRange = { ...payload.drawRange };
  return geom;
}

function encodeGeometry(geom) {
  const out = {};
  const transfer = [];
  for (const key of ['position', 'normal', 'uv', 'color']) {
    const attr = geom.attributes[key];
    if (attr) {
      out[key] = attr.array.slice();
      transfer.push(out[key].buffer);
      if (key === 'color') out.colorItemSize = attr.itemSize;
    }
  }
  if (geom.index) { out.index = geom.index.array.slice(); transfer.push(out.index.buffer); }
  out.groups = (geom.groups || []).map((g) => ({ start: g.start, count: g.count, materialIndex: g.materialIndex }));
  out.drawRange = { ...geom.drawRange };
  return { out, transfer };
}

function buildBVH(payload, MeshBVH) {
  const geom = geometryFrom(payload);
  const bvh = new MeshBVH(geom, { maxLeafTris: payload.maxLeafTris || 8, indirect: true });
  const data = MeshBVH.serialize(bvh);
  const transfer = (data.roots || []).filter((r) => r instanceof ArrayBuffer);
  if (data.indirectBuffer?.buffer instanceof ArrayBuffer) {
    transfer.push(data.indirectBuffer.buffer);
  }
  return { data, transfer };
}

function runCSG(payload, csg) {
  const { Evaluator, Brush } = csg;
  const geoA = geometryFrom(payload.a);
  const geoB = geometryFrom(payload.b);
  if (!geoA.attributes.normal) geoA.computeVertexNormals();
  if (!geoB.attributes.normal) geoB.computeVertexNormals();
  const hasUv = Boolean(geoA.attributes.uv && geoB.attributes.uv);
  const a = new Brush(geoA);
  const b = new Brush(geoB);
  a.matrixWorld.fromArray(payload.matrixA); a.matrix.fromArray(payload.matrixA);
  b.matrixWorld.fromArray(payload.matrixB); b.matrix.fromArray(payload.matrixB);
  const evaluator = new Evaluator();
  evaluator.useGroups = false;
  evaluator.attributes = hasUv ? ['position', 'normal', 'uv'] : ['position', 'normal'];
  const result = evaluator.evaluate(a, b, csg[OP_MAP[payload.op] || 'SUBTRACTION']);
  const geom = result.geometry || result.children?.[0]?.geometry;
  if (!geom) return { out: null, transfer: [] };
  return encodeGeometry(geom);
}

function runModifierStack(payload, modifiers, id) {
  const registry = modifiers.MODIFIER_TYPES || {};
  let geom = geometryFrom(payload.geometry);
  const descriptors = payload.descriptors || [];
  const renderQuality = payload.quality === 'render';
  const total = descriptors.length;
  for (let i = 0; i < total; i++) {
    if (cancelled.has(id)) return { cancelled: true };
    const desc = descriptors[i];
    const Cls = registry[String(desc.type || '').toLowerCase()];
    if (!Cls || desc.enabled === false) continue;
    geom = Cls.execute(geom, { ...(desc.params || {}), _renderQuality: renderQuality }) || geom;
    self.postMessage({ id, progress: { stage: i + 1, total, percent: ((i + 1) / Math.max(1, total)) * 100 } });
  }
  if (cancelled.has(id)) return { cancelled: true };
  return encodeGeometry(geom);
}

self.onmessage = async (event) => {
  const { id, type, ...payload } = event.data || {};
  if (type === 'cancel') { cancelled.add(id); return; }
  try {
    const mods = await ready;
    if (type === 'bvh') {
      const { data, transfer } = buildBVH(payload, mods.MeshBVH);
      self.postMessage({ id, ok: true, data }, transfer);
    } else if (type === 'csg') {
      const { out, transfer } = runCSG(payload, mods);
      self.postMessage({ id, ok: true, out }, transfer);
    } else if (type === 'modifierStack') {
      const result = runModifierStack(payload, mods.modifiers, id);
      if (result.cancelled) self.postMessage({ id, ok: false, error: 'cancelled', cancelled: true });
      else self.postMessage({ id, ok: true, out: result.out }, result.transfer);
    } else {
      self.postMessage({ id, ok: false, error: `Unknown worker task: ${type}` });
    }
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err && err.message || err) });
  } finally {
    cancelled.delete(id);
  }
};
