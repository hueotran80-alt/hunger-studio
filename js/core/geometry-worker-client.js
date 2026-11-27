/**
 * Client phía main-thread cho geometry-worker (Giai đoạn nền móng 3).
 * File: js/core/geometry-worker-client.js
 *
 * Singleton worker + hàng đợi request/id. Mọi hàm trả về Promise và TỰ fallback
 * về null khi Worker không khả dụng (Node/SSR/trình duyệt cũ) để caller dùng
 * đường CPU. Không ném lỗi vỡ UI: lỗi worker -> reject, caller quyết định fallback.
 */
let worker = null;
let nextId = 1;
const pending = new Map();
let workerBroken = false;

export const WORKER_BVH_MIN_TRIANGLES = 50000;
export const WORKER_CSG_MIN_TRIANGLES = 20000;

export function geometryWorkerAvailable() {
  return typeof Worker !== 'undefined' && !workerBroken;
}

function getWorker() {
  if (workerBroken || typeof Worker === 'undefined') return null;
  if (!worker) {
    worker = new Worker(new URL('./geometry-worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = (event) => {
      const data = event.data || {};
      const { id, ok, error, progress, ...rest } = data;
      const entry = pending.get(id);
      if (!entry) return;
      if (progress) { entry.onProgress?.(progress); return; }
      pending.delete(id);
      if (entry.key && latestByKey.get(entry.key) === id) latestByKey.delete(entry.key);
      clearTimeout(entry.timer);
      entry.detach?.();
      ok ? entry.resolve({ ok: true, ...rest }) : entry.reject(Object.assign(new Error(error || 'geometry worker failed'), { cancelled: !!data.cancelled }));
    };
    worker.onerror = () => {
      workerBroken = true;
      for (const [, entry] of pending) { clearTimeout(entry.timer); entry.reject(new Error('geometry worker crashed')); }
      pending.clear();
      try { worker.terminate(); } catch (_) { /* noop */ }
      worker = null;
    };
  }
  return worker;
}

const latestByKey = new Map();

function abortError() { return Object.assign(new Error('cancelled'), { name: 'AbortError', cancelled: true }); }

function cancelRequest(id) {
  const entry = pending.get(id);
  if (!entry) return;
  pending.delete(id);
  clearTimeout(entry.timer);
  entry.detach?.();
  try { worker?.postMessage({ type: 'cancel', id }); } catch (_) { /* noop */ }
  entry.reject(abortError());
}

function resetWorker() {
  for (const [, e] of pending) { clearTimeout(e.timer); e.reject(new Error('geometry worker reset')); }
  pending.clear();
  latestByKey.clear();
  if (worker) { try { worker.terminate(); } catch (_) { /* noop */ } }
  worker = null;
  workerBroken = false;
}

function request(type, payload, transfer = [], { signal, timeoutMs = 60000, onProgress, key } = {}) {
  const w = getWorker();
  if (!w) return Promise.reject(new Error('Worker unavailable'));
  const id = nextId++;
  // latest-wins: hủy request trước đó cùng key (mesh + stack revision)
  if (key) {
    const prevId = latestByKey.get(key);
    if (prevId != null && pending.has(prevId)) cancelRequest(prevId);
    latestByKey.set(key, id);
  }
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      if (key && latestByKey.get(key) === id) latestByKey.delete(key);
      signal?.removeEventListener('abort', onAbort);
    };
    const onAbort = () => cancelRequest(id);
    const timer = setTimeout(() => {
      pending.delete(id);
      cleanup();
      reject(new Error('geometry worker timeout'));
      resetWorker();
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer, onProgress, key, detach: cleanup });
    if (signal) {
      if (signal.aborted) { clearTimeout(timer); pending.delete(id); cleanup(); reject(abortError()); return; }
      signal.addEventListener('abort', onAbort, { once: true });
    }
    w.postMessage({ id, type, ...payload }, transfer);
  });
}

function geometryPayload(geom) {
  const out = { position: geom.attributes.position.array.slice() };
  const transfer = [out.position.buffer];
  if (geom.attributes.normal) { out.normal = geom.attributes.normal.array.slice(); transfer.push(out.normal.buffer); }
  if (geom.attributes.uv) { out.uv = geom.attributes.uv.array.slice(); transfer.push(out.uv.buffer); }
  if (geom.index) { out.index = geom.index.array.slice(); transfer.push(out.index.buffer); }
  return { out, transfer };
}

export function triangleCount(geom) {
  if (!geom?.attributes?.position) return 0;
  return geom.index ? geom.index.count / 3 : geom.attributes.position.count / 3;
}

/** Build MeshBVH trong worker; trả về serialized roots để deserialize phía main. */
export async function buildBVHInWorker(geom, { maxLeafTris = 8 } = {}) {
  const { out, transfer } = geometryPayload(geom);
  const { data } = await request('bvh', { ...out, maxLeafTris }, transfer);
  return data;
}

/** CSG boolean trong worker; trả về attribute arrays của geometry kết quả (world space). */
export async function csgInWorker(geomA, geomB, matrixA, matrixB, op) {
  const a = geometryPayload(geomA);
  const b = geometryPayload(geomB);
  const { out } = await request('csg', {
    a: a.out, b: b.out, matrixA, matrixB, op
  }, [...a.transfer, ...b.transfer]);
  return out;
}

/** Danh sách ArrayBuffer transferable của một encoded geometry. */
export function encodedTransferables(encoded) {
  const t = [];
  for (const k of ['position', 'normal', 'uv', 'color', 'index']) {
    if (encoded?.[k]?.buffer) t.push(encoded[k].buffer);
  }
  return t;
}

/** Evaluate cả modifier stack trong worker (protocol v2, cancel/progress/latest-wins). */
export function runModifierStack(encoded, descriptors, opts = {}) {
  return request(
    'modifierStack',
    { geometry: encoded, descriptors, quality: opts.quality },
    encodedTransferables(encoded),
    opts
  );
}

export function disposeGeometryWorker() {
  for (const [, entry] of pending) { clearTimeout(entry.timer); entry.reject(new Error('worker disposed')); }
  pending.clear();
  latestByKey.clear();
  if (worker) { try { worker.terminate(); } catch (_) { /* noop */ } }
  worker = null;
  workerBroken = false;
}
