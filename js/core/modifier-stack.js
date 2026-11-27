/**
 * Modifier stack async / cancelable / undoable (nền móng Phase 1).
 * File: js/core/modifier-stack.js
 *
 * Nguồn sự thật: `mesh.userData.baseGeometry` (source) + `mesh.userData.modifierStack`
 * (descriptor thuần). Evaluated geometry là cache. Mọi evaluate chạy trong Web
 * Worker (geometry-worker protocol v2); main thread chỉ transfer + swap + history.
 * Undo/redo khôi phục snapshot tức thì, không tính lại stack nặng.
 */
import { encodeGeometry, decodeGeometry } from './geometry/geometry-codec.js';
import { checkBudget, triangleCount } from './geometry/geometry-budget.js';
import { runModifierStack, geometryWorkerAvailable } from './geometry-worker-client.js';
import { ModifierStackCommand } from './geometry-commands.js';
import {
  executeModifier,
  MODIFIER_TYPES,
  getModifierDisplayName,
  prepareBooleanDescriptors,
  syncBooleanCuttersInScene
} from './modifiers.js';

const cache = new WeakMap(); // mesh -> { key, geometry }

const cloneDesc = (list) => (list || []).map((d) => ({ ...d, params: { ...(d.params || {}) } }));

export function getStack(mesh) {
  return Array.isArray(mesh?.userData?.modifierStack) ? mesh.userData.modifierStack : [];
}

function sourceOf(mesh) {
  return mesh.userData.baseGeometry || mesh.geometry;
}

function revisionOf(mesh) {
  return mesh.userData.stackRevision || 0;
}

function bumpRevision(mesh) {
  mesh.userData.stackRevision = revisionOf(mesh) + 1;
  return mesh.userData.stackRevision;
}

function keyOf(mesh, quality) {
  return `${mesh.uuid}:${revisionOf(mesh)}:${quality}:${JSON.stringify(getStack(mesh))}`;
}

function fireGeometryChanged(mesh) {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('blender:geometryChanged', { detail: { mesh, revision: revisionOf(mesh) } }));
  }
}

function snapshot(mesh) {
  return {
    descriptors: cloneDesc(getStack(mesh)),
    baseGeometry: mesh.userData.baseGeometry || null,
    geometry: mesh.geometry
  };
}

function evaluateStackSync(mesh, descriptors, onProgress, quality = 'final') {
  let current = sourceOf(mesh).clone();
  const total = descriptors.length;
  const renderQuality = quality === 'render';
  for (let i = 0; i < total; i++) {
    const desc = descriptors[i];
    if (!desc || desc.enabled === false) continue;
    const next = executeModifier(current, desc.type, { ...(desc.params || {}), _renderQuality: renderQuality });
    if (current && current !== mesh.geometry && current !== mesh.userData?.baseGeometry) {
      current.dispose?.();
    }
    current = next;
    if (onProgress) {
      onProgress({ index: i + 1, total, type: desc.type });
    }
  }
  current.computeBoundingBox?.();
  current.computeBoundingSphere?.();
  return current;
}

/** Evaluate stack trong worker (fallback đồng bộ trong Node/môi trường không Worker); trả về geometry mới (chưa gắn vào mesh). */
export async function evaluateStack(mesh, { quality = 'final', signal, onProgress, descriptors, sceneManager } = {}) {
  if (signal?.aborted) {
    throw Object.assign(new Error('Modifier evaluation aborted'), { name: 'AbortError' });
  }
  const rawList = descriptors || getStack(mesh);
  const list = prepareBooleanDescriptors(mesh, rawList, sceneManager || null);
  const encoded = encodeGeometry(sourceOf(mesh));
  const budget = checkBudget({
    encoded,
    inputTriangles: triangleCount(encoded),
    descriptors: list,
    mode: quality === 'preview' ? 'preview' : 'interactive'
  });
  if (!budget.ok) {
    throw Object.assign(new Error(`[modifier-stack] ${budget.reason}`), { budget });
  }
  let geometry;
  if (geometryWorkerAvailable()) {
    const res = await runModifierStack(encoded, list, {
      signal, onProgress, quality, key: `${mesh.uuid}:${quality}`
    });
    geometry = decodeGeometry(res.out);
  } else {
    geometry = evaluateStackSync(mesh, list, onProgress, quality);
  }
  cache.set(mesh, { key: keyOf(mesh, quality), geometry });
  return geometry;
}

async function record(mesh, before, after, { sceneManager, description } = {}) {
  if (!sceneManager) return;
  sceneManager.executeCommand(new ModifierStackCommand({
    mesh, before, after, description,
    onApply: (m, snap) => {
      bumpRevision(m);
      cache.set(m, { key: keyOf(m, 'final'), geometry: snap.geometry });
      syncBooleanCuttersInScene(sceneManager);
      fireGeometryChanged(m);
    }
  }));
}

async function mutate(mesh, fn, { sceneManager, description = 'Modifier stack', quality = 'final', signal, onProgress } = {}) {
  const before = snapshot(mesh);
  // Giữ source gốc trước khi thay geometry bằng evaluated (nguồn sự thật).
  if (!mesh.userData.baseGeometry) mesh.userData.baseGeometry = before.geometry;
  const list = cloneDesc(getStack(mesh));
  fn(list);
  mesh.userData.modifierStack = list;
  const myRev = bumpRevision(mesh);
  let geometry;
  try {
    geometry = await evaluateStack(mesh, { quality, signal, onProgress, sceneManager });
  } catch (err) {
    // Only roll back if no newer mutate() superseded this evaluation
    if (revisionOf(mesh) === myRev) {
      mesh.userData.modifierStack = cloneDesc(before.descriptors);
      mesh.geometry = before.geometry;
      bumpRevision(mesh);
    }
    throw err;
  }
  mesh.geometry = geometry;
  const after = snapshot(mesh);
  await record(mesh, before, after, { sceneManager, description });
  syncBooleanCuttersInScene(sceneManager);
  fireGeometryChanged(mesh);
  return geometry;
}

const MODIFIER_ALIASES = {
  subsurf: 'subdivision',
  subdivide: 'subdivision',
  bool: 'boolean',
  displacement: 'displace',
  relax: 'smooth',
};

export function addModifier(mesh, type, params = {}, opts = {}) {
  const rawType = String(type || 'array').toLowerCase();
  const normType = MODIFIER_ALIASES[rawType] || rawType;
  const ModCls = MODIFIER_TYPES[normType];
  const defaults = ModCls?.defaultParams ? JSON.parse(JSON.stringify(ModCls.defaultParams)) : {};
  const label = getModifierDisplayName(normType);
  return mutate(mesh, (l) => l.push({
    id: `mod_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    type: normType,
    name: label,
    enabled: true,
    params: { ...defaults, ...params }
  }), { description: `Add ${label} modifier`, ...opts });
}

export function updateModifier(mesh, index, params, opts = {}) {
  return mutate(mesh, (l) => { l[index] = { ...l[index], params: { ...l[index].params, ...params } }; }, { description: 'Update modifier', ...opts });
}

export function removeModifier(mesh, index, opts = {}) {
  return mutate(mesh, (l) => l.splice(index, 1), { description: 'Remove modifier', ...opts });
}

export function toggleModifier(mesh, index, opts = {}) {
  return mutate(mesh, (l) => { l[index] = { ...l[index], enabled: l[index].enabled === false }; }, { description: 'Toggle modifier', ...opts });
}

export function reorderModifier(mesh, from, to, opts = {}) {
  return mutate(mesh, (l) => { const [d] = l.splice(from, 1); l.splice(to, 0, d); }, { description: 'Reorder modifier', ...opts });
}

/** Preview không record history (slider drag); commit gọi commitPreview. */
export async function previewStack(mesh, opts = {}) {
  return evaluateStack(mesh, { ...opts, quality: 'preview' });
}

const scrubStates = new WeakMap();

/**
 * Cập nhật tham số modifier trong một gesture kéo slider: evaluate ngay nhưng
 * KHÔNG ghi history ở từng sự kiện `input` (trước đây mỗi pixel kéo sinh một
 * entry undo). `commitModifierScrub` ghi đúng MỘT bước undo với snapshot trước
 * khi gesture bắt đầu.
 * @param {THREE.Mesh} mesh
 * @param {number} index
 * @param {object} params
 * @param {object} [opts] { sceneManager, description, signal, onProgress }
 */
export async function scrubModifier(mesh, index, params, opts = {}) {
  let state = scrubStates.get(mesh);
  if (!state) {
    state = { before: snapshot(mesh), opts: {}, timer: null };
    scrubStates.set(mesh, state);
  }
  state.opts = opts;

  if (!mesh.userData.baseGeometry) mesh.userData.baseGeometry = mesh.geometry;
  const prevDesc = cloneDesc(getStack(mesh));
  const prevGeom = mesh.geometry;
  const list = cloneDesc(getStack(mesh));
  if (!list[index]) return mesh.geometry;
  list[index] = { ...list[index], params: { ...list[index].params, ...params } };
  mesh.userData.modifierStack = list;
  const myRev = bumpRevision(mesh);

  let geometry;
  try {
    geometry = await evaluateStack(mesh, { ...opts, quality: opts.quality || 'final' });
  } catch (err) {
    if (revisionOf(mesh) === myRev) {
      mesh.userData.modifierStack = prevDesc;
      mesh.geometry = prevGeom;
      bumpRevision(mesh);
    }
    throw err;
  }
  mesh.geometry = geometry;
  syncBooleanCuttersInScene(opts.sceneManager);
  fireGeometryChanged(mesh);

  // Tự chốt sau khi ngừng kéo: gesture vẫn chỉ tốn 1 entry dù không có sự kiện `change`.
  if (state.timer) clearTimeout(state.timer);
  state.timer = setTimeout(() => { commitModifierScrub(mesh).catch(() => {}); }, 300);
  return geometry;
}

/**
 * Ghi history cho gesture scrub hiện tại (một entry duy nhất).
 * @param {THREE.Mesh} mesh
 */
export async function commitModifierScrub(mesh) {
  const state = scrubStates.get(mesh);
  if (!state) return;
  scrubStates.delete(mesh);
  if (state.timer) clearTimeout(state.timer);

  const before = state.before;
  const after = snapshot(mesh);
  if (JSON.stringify(before.descriptors) === JSON.stringify(after.descriptors) && before.geometry === after.geometry) return;
  await record(mesh, before, after, { ...state.opts, description: state.opts.description || 'Update modifier' });
}

export async function commitPreview(mesh, opts = {}) {
  const before = snapshot(mesh);
  if (!mesh.userData.baseGeometry) mesh.userData.baseGeometry = before.geometry;
  const geometry = await evaluateStack(mesh, { ...opts, quality: 'final' });
  mesh.geometry = geometry;
  bumpRevision(mesh);
  await record(mesh, before, snapshot(mesh), opts);
  fireGeometryChanged(mesh);
  return geometry;
}

/**
 * Bake prefix 0..upTo: source trở thành geometry đã evaluate của prefix,
 * descriptor prefix bị bỏ (sửa bug bake chỉ bỏ đúng 1 modifier).
 */
export async function bakeModifiers(mesh, upTo, opts = {}) {
  const list = getStack(mesh);
  const end = upTo == null ? list.length - 1 : Math.min(upTo, list.length - 1);
  if (end < 0) return mesh.geometry;
  const before = snapshot(mesh);
  const prevBase = mesh.userData.baseGeometry;
  const prefix = list.slice(0, end + 1);
  const suffix = cloneDesc(list.slice(end + 1));
  const myRev = bumpRevision(mesh);
  let geometry;
  try {
    const bakedSource = await evaluateStack(mesh, { ...opts, descriptors: prefix });
    if (revisionOf(mesh) !== myRev) {
      return mesh.geometry;
    }
    mesh.userData.baseGeometry = bakedSource;
    mesh.userData.modifierStack = suffix;
    cache.delete(mesh);
    geometry = suffix.length ? await evaluateStack(mesh, opts) : bakedSource;
    if (revisionOf(mesh) !== myRev) {
      return mesh.geometry;
    }
  } catch (err) {
    if (revisionOf(mesh) === myRev) {
      mesh.userData.baseGeometry = prevBase;
      mesh.userData.modifierStack = cloneDesc(before.descriptors);
      mesh.geometry = before.geometry;
      cache.delete(mesh);
      bumpRevision(mesh);
    }
    throw err;
  }
  mesh.geometry = geometry;
  await record(mesh, before, snapshot(mesh), { ...opts, description: 'Bake modifiers' });
  syncBooleanCuttersInScene(opts.sceneManager);
  fireGeometryChanged(mesh);
  return geometry;
}

export function getCachedEvaluated(mesh) {
  const entry = cache.get(mesh);
  return entry && entry.key === keyOf(mesh, 'final') ? entry.geometry : null;
}

export function clearStackCache(mesh) {
  cache.delete(mesh);
}

const dependentSyncState = new WeakMap();

async function _evaluateHostQueue(host, sceneManager, quality) {
  let state = dependentSyncState.get(host);
  if (!state) {
    state = { running: false, pending: false, quality };
    dependentSyncState.set(host, state);
  }
  state.quality = quality;
  if (state.running) {
    state.pending = true;
    return host.geometry;
  }
  state.running = true;
  try {
    do {
      state.pending = false;
      bumpRevision(host);
      try {
        const geometry = await evaluateStack(host, {
          quality: state.quality,
          sceneManager
        });
        host.geometry = geometry;
        fireGeometryChanged(host);
        sceneManager?.requestRender?.();
      } catch (err) {
        if (!err?.cancelled) {
          console.warn('[modifier-stack] Live Boolean sync failed:', err?.message || err);
        }
      }
    } while (state.pending);
  } finally {
    state.running = false;
  }
  return host.geometry;
}

/**
 * Re-evaluates meshes whose active Boolean modifier references `changedObject`,
 * or `changedObject` itself if it carries a live object-based Boolean modifier.
 */
export async function refreshBooleanDependents(changedObject, { sceneManager = null, quality = 'final' } = {}) {
  const sm = sceneManager || (typeof window !== 'undefined' ? window.sceneManager : null);
  if (!sm || !changedObject) return [];

  const objects = typeof sm.getAllObjects === 'function'
    ? sm.getAllObjects()
    : Array.from(sm.objects?.values() || []);

  const changedId = changedObject.userData?.id || changedObject.uuid;
  const changedName = changedObject.name;
  const affectedHosts = [];

  for (const obj of objects) {
    if (!obj?.isMesh) continue;
    const stack = obj.userData?.modifierStack;
    if (!Array.isArray(stack) || stack.length === 0) continue;

    let touches = false;
    for (const mod of stack) {
      if (!mod || mod.enabled === false) continue;
      const t = String(mod.type || '').toLowerCase();
      if (t !== 'boolean' && t !== 'bool') continue;
      const p = mod.params || {};
      if (!p.targetId && !p.targetName) continue;
      if (obj === changedObject) {
        touches = true;
        break;
      }
      if ((p.targetId && (p.targetId === changedId || p.targetId === changedObject.uuid || sm.resolveObject?.(p.targetId) === changedObject)) ||
          (p.targetName && changedName && p.targetName === changedName)) {
        touches = true;
        break;
      }
    }
    if (touches) affectedHosts.push(obj);
  }

  await Promise.all(affectedHosts.map((host) => _evaluateHostQueue(host, sm, quality)));
  return affectedHosts;
}

if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  const onObjTransform = (e) => {
    const detail = e?.detail;
    const obj = detail?.object || detail;
    if (!obj || !obj.isObject3D) return;
    const quality = detail?.phase === 'interactive' ? 'preview' : 'final';
    refreshBooleanDependents(obj, { quality }).catch(() => {});
  };
  window.addEventListener('blender:objectTransformed', onObjTransform);
  window.addEventListener('blender:transformChanged', onObjTransform);
}