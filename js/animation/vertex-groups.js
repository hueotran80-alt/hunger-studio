/**
 * @file vertex-groups.js
 * @description Blender-standard Vertex Groups management per mesh:
 * - Add / remove / rename / active selection
 * - Assign / remove Edit-Mode vertices with arbitrary weight (0..1)
 * - Select / deselect group vertices in Edit Mode
 * - Spatial L <-> R vertex weight mirroring across X=0
 * - Bidirectional sync with SkinnedMesh skinIndex / skinWeight attributes
 * - Pure JSON serialization inside mesh.userData.vertexGroups
 */

export function ensureVertexGroups(mesh) {
  if (!mesh || !mesh.isMesh) return { activeIndex: -1, groups: [] };
  mesh.userData = mesh.userData || {};
  if (!mesh.userData.vertexGroups || !Array.isArray(mesh.userData.vertexGroups.groups)) {
    mesh.userData.vertexGroups = { activeIndex: -1, groups: [] };
    if (mesh.isSkinnedMesh && mesh.skeleton?.bones && mesh.geometry?.attributes?.skinIndex) {
      syncVertexGroupsFromSkinAttributes(mesh);
    }
  }
  const vg = mesh.userData.vertexGroups;
  if (vg.groups.length === 0) vg.activeIndex = -1;
  else if (vg.activeIndex < 0 || vg.activeIndex >= vg.groups.length) vg.activeIndex = 0;
  return vg;
}

function resolveGroupIndex(vg, nameOrIdx) {
  if (!vg || !Array.isArray(vg.groups)) return -1;
  if (typeof nameOrIdx === 'number') {
    return nameOrIdx >= 0 && nameOrIdx < vg.groups.length ? nameOrIdx : -1;
  }
  return vg.groups.findIndex((g) => g.name === nameOrIdx);
}

export function getActiveVertexGroup(mesh) {
  const vg = ensureVertexGroups(mesh);
  if (vg.activeIndex < 0 || vg.activeIndex >= vg.groups.length) return null;
  return vg.groups[vg.activeIndex];
}

export function setActiveVertexGroup(mesh, nameOrIdx) {
  const vg = ensureVertexGroups(mesh);
  const idx = resolveGroupIndex(vg, nameOrIdx);
  if (idx === -1) return null;
  vg.activeIndex = idx;
  return vg.groups[idx];
}

export function addVertexGroup(mesh, baseName = 'Group') {
  const vg = ensureVertexGroups(mesh);
  const existing = new Set(vg.groups.map((g) => g.name));
  let name = String(baseName || 'Group').trim() || 'Group';
  let suffix = 1;
  while (existing.has(name)) {
    name = `${baseName}.${String(suffix++).padStart(3, '0')}`;
  }
  const group = { name, lock: false, entries: {} };
  vg.groups.push(group);
  vg.activeIndex = vg.groups.length - 1;
  return group;
}

function clearBoneWeightsOnVertices(mesh, boneName, vertexIndices = null) {
  if (!mesh?.isSkinnedMesh || !mesh.skeleton?.bones || !mesh.geometry?.attributes?.skinIndex) return;
  const bi = mesh.skeleton.bones.findIndex((b) => b.name === boneName);
  if (bi === -1) return;
  const idxAttr = mesh.geometry.attributes.skinIndex;
  const wAttr = mesh.geometry.attributes.skinWeight;
  const vertCount = idxAttr.count;
  const targets = vertexIndices || Array.from({ length: vertCount }, (_, i) => i);

  for (const vi of targets) {
    const v = Number(vi);
    if (!Number.isInteger(v) || v < 0 || v >= vertCount) continue;
    let sum = 0;
    for (let s = 0; s < 4; s++) {
      if (Math.round(idxAttr.getComponent(v, s)) === bi) {
        wAttr.setComponent(v, s, 0);
        idxAttr.setComponent(v, s, 0);
      } else {
        sum += wAttr.getComponent(v, s);
      }
    }
    if (sum > 1e-6) {
      for (let s = 0; s < 4; s++) {
        wAttr.setComponent(v, s, wAttr.getComponent(v, s) / sum);
      }
    }
  }
  idxAttr.needsUpdate = true;
  wAttr.needsUpdate = true;
}

export function removeVertexGroup(mesh, nameOrIdx) {
  const vg = ensureVertexGroups(mesh);
  const idx = resolveGroupIndex(vg, nameOrIdx);
  if (idx === -1) return false;
  const removedName = vg.groups[idx].name;
  vg.groups.splice(idx, 1);
  if (vg.groups.length === 0) vg.activeIndex = -1;
  else vg.activeIndex = Math.min(idx, vg.groups.length - 1);
  if (mesh.isSkinnedMesh) {
    clearBoneWeightsOnVertices(mesh, removedName);
    syncSkinAttributesFromVertexGroups(mesh);
  }
  return true;
}

export function renameVertexGroup(mesh, oldNameOrIdx, newName) {
  const vg = ensureVertexGroups(mesh);
  const idx = resolveGroupIndex(vg, oldNameOrIdx);
  if (idx === -1) return false;
  const clean = String(newName || '').trim();
  if (!clean) return false;
  if (vg.groups.some((g, gi) => gi !== idx && g.name === clean)) return false;
  vg.groups[idx].name = clean;
  if (mesh.isSkinnedMesh) syncSkinAttributesFromVertexGroups(mesh);
  return true;
}

export function assignVerticesToGroup(mesh, nameOrIdx, vertexIndices, weight = 1.0, mode = 'replace') {
  const vg = ensureVertexGroups(mesh);
  const idx = resolveGroupIndex(vg, nameOrIdx);
  if (idx === -1) return 0;
  const grp = vg.groups[idx];
  const vertCount = mesh.geometry?.attributes?.position?.count || 0;
  const clampedW = Math.max(0, Math.min(1, Number(weight) || 0));

  let changed = 0;
  for (const vi of vertexIndices || []) {
    const v = Number(vi);
    if (!Number.isInteger(v) || v < 0 || v >= vertCount) continue;
    const prev = Number(grp.entries[v]) || 0;
    let next = clampedW;
    if (mode === 'add') next = Math.min(1, prev + clampedW);
    else if (mode === 'subtract') next = Math.max(0, prev - clampedW);

    if (next <= 1e-5) delete grp.entries[v];
    else grp.entries[v] = Number(next.toFixed(5));
    changed++;
  }

  if (changed > 0 && mesh.isSkinnedMesh) {
    syncSkinAttributesFromVertexGroups(mesh);
  }
  return changed;
}

export function removeVerticesFromGroup(mesh, nameOrIdx, vertexIndices) {
  const vg = ensureVertexGroups(mesh);
  const idx = resolveGroupIndex(vg, nameOrIdx);
  if (idx === -1) return 0;
  const grp = vg.groups[idx];
  let removed = 0;
  for (const vi of vertexIndices || []) {
    const key = String(vi);
    if (key in grp.entries) {
      delete grp.entries[key];
      removed++;
    }
  }
  if (removed > 0 && mesh.isSkinnedMesh) {
    clearBoneWeightsOnVertices(mesh, grp.name, vertexIndices);
    syncSkinAttributesFromVertexGroups(mesh);
  }
  return removed;
}

export function getGroupVertexIndices(mesh, nameOrIdx, threshold = 0.001) {
  const vg = ensureVertexGroups(mesh);
  const idx = resolveGroupIndex(vg, nameOrIdx);
  if (idx === -1) return [];
  const grp = vg.groups[idx];
  const out = [];
  for (const [k, w] of Object.entries(grp.entries || {})) {
    if (Number(w) >= threshold) out.push(Number(k));
  }
  out.sort((a, b) => a - b);
  return out;
}

export function getEditModeBufferVertexIndices(editMode, mesh) {
  if (!editMode?.isActive || editMode.targetMesh !== mesh) return [];
  const activeLogical = typeof editMode.getActiveVertexIndices === 'function'
    ? editMode.getActiveVertexIndices()
    : Array.from(editMode.selectedVertices || []);
  if (!activeLogical.length) return [];
  const logicalSet = new Set(activeLogical);
  const map = editMode._outToLogical;
  const vertCount = mesh?.geometry?.attributes?.position?.count || 0;
  if (map && map.length > 0 && vertCount > 0) {
    const out = [];
    const limit = Math.min(vertCount, map.length);
    for (let i = 0; i < limit; i++) {
      if (logicalSet.has(map[i])) out.push(i);
    }
    return out;
  }
  return Array.from(logicalSet);
}

export function selectGroupVertices(mesh, nameOrIdx, editMode = null, threshold = 0.001) {
  const indices = getGroupVertexIndices(mesh, nameOrIdx, threshold);
  if (editMode?.isActive && editMode.targetMesh === mesh) {
    const map = editMode._outToLogical;
    for (const v of indices) {
      const logicalIdx = (map && v < map.length) ? map[v] : v;
      editMode.selectedVertices.add(logicalIdx);
    }
    editMode.updateVisuals?.();
    editMode.updateGizmoProxy?.();
  }
  return indices;
}

export function deselectGroupVertices(mesh, nameOrIdx, editMode = null, threshold = 0.001) {
  const indices = getGroupVertexIndices(mesh, nameOrIdx, threshold);
  if (editMode?.isActive && editMode.targetMesh === mesh) {
    const map = editMode._outToLogical;
    for (const v of indices) {
      const logicalIdx = (map && v < map.length) ? map[v] : v;
      editMode.selectedVertices.delete(logicalIdx);
    }
    editMode.updateVisuals?.();
    editMode.updateGizmoProxy?.();
  }
  return indices;
}

export function resolveMirrorGroupName(name) {
  const s = String(name || '');
  if (/Left/i.test(s)) return s.replace(/Left/i, (m) => (m[0] === 'L' ? 'Right' : 'right'));
  if (/Right/i.test(s)) return s.replace(/Right/i, (m) => (m[0] === 'R' ? 'Left' : 'left'));
  if (/_L$/i.test(s)) return s.slice(0, -1) + (s.endsWith('L') ? 'R' : 'r');
  if (/_R$/i.test(s)) return s.slice(0, -1) + (s.endsWith('R') ? 'L' : 'l');
  if (/\.L$/i.test(s)) return s.slice(0, -1) + (s.endsWith('L') ? 'R' : 'r');
  if (/\.R$/i.test(s)) return s.slice(0, -1) + (s.endsWith('R') ? 'L' : 'l');
  return s;
}

export function mirrorVertexGroup(mesh, nameOrIdx) {
  const vg = ensureVertexGroups(mesh);
  const idx = resolveGroupIndex(vg, nameOrIdx);
  const posAttr = mesh?.geometry?.attributes?.position;
  if (idx === -1 || !posAttr) return null;

  const srcGroup = vg.groups[idx];
  const targetName = resolveMirrorGroupName(srcGroup.name);
  let dstIdx = vg.groups.findIndex((g) => g.name === targetName);
  if (dstIdx === -1) {
    addVertexGroup(mesh, targetName);
    dstIdx = vg.groups.length - 1;
  }
  const dstGroup = vg.groups[dstIdx];
  const vertCount = posAttr.count;

  const nextEntries = {};
  for (const [k, w] of Object.entries(srcGroup.entries || {})) {
    const vi = Number(k);
    if (!Number.isInteger(vi) || vi < 0 || vi >= vertCount) continue;
    const mx = -posAttr.getX(vi);
    const my = posAttr.getY(vi);
    const mz = posAttr.getZ(vi);

    let bestV = vi;
    let bestD2 = Infinity;
    for (let j = 0; j < vertCount; j++) {
      const dx = posAttr.getX(j) - mx;
      const dy = posAttr.getY(j) - my;
      const dz = posAttr.getZ(j) - mz;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 < bestD2) {
        bestD2 = d2;
        bestV = j;
        if (d2 < 1e-8) break;
      }
    }
    nextEntries[bestV] = w;
  }

  if (dstGroup === srcGroup) {
    dstGroup.entries = { ...srcGroup.entries, ...nextEntries };
  } else {
    dstGroup.entries = nextEntries;
  }

  if (mesh.isSkinnedMesh) syncSkinAttributesFromVertexGroups(mesh);
  return dstGroup;
}

export function syncVertexGroupsFromSkinAttributes(mesh) {
  if (!mesh?.geometry?.attributes?.skinIndex || !mesh.skeleton?.bones) return;
  mesh.userData = mesh.userData || {};
  const bones = mesh.skeleton.bones;
  const idxAttr = mesh.geometry.attributes.skinIndex;
  const wAttr = mesh.geometry.attributes.skinWeight;
  const vertCount = idxAttr.count;

  const prev = mesh.userData.vertexGroups;
  const prevActiveName = (prev && Array.isArray(prev.groups) && prev.activeIndex >= 0 && prev.activeIndex < prev.groups.length)
    ? prev.groups[prev.activeIndex].name
    : null;
  const boneNameSet = new Set(bones.map((b) => b.name));
  const customGroups = (prev && Array.isArray(prev.groups))
    ? prev.groups.filter((g) => g && !boneNameSet.has(g.name))
    : [];

  const boneGroups = bones.map((b) => ({ name: b.name, lock: false, entries: {} }));
  for (let i = 0; i < vertCount; i++) {
    for (let s = 0; s < 4; s++) {
      const bi = Math.round(idxAttr.getComponent(i, s));
      const w = wAttr.getComponent(i, s);
      if (bi >= 0 && bi < boneGroups.length && w > 1e-5) {
        boneGroups[bi].entries[i] = Number(w.toFixed(5));
      }
    }
  }
  const merged = [...boneGroups, ...customGroups];
  let nextActive = merged.length > 0 ? 0 : -1;
  if (prevActiveName) {
    const foundIdx = merged.findIndex((g) => g.name === prevActiveName);
    if (foundIdx >= 0) nextActive = foundIdx;
  }
  mesh.userData.vertexGroups = {
    activeIndex: nextActive,
    groups: merged,
  };
}

export function syncSkinAttributesFromVertexGroups(mesh) {
  if (!mesh?.isSkinnedMesh || !mesh.skeleton?.bones || !mesh.geometry?.attributes?.skinIndex) return false;
  const vg = ensureVertexGroups(mesh);
  const bones = mesh.skeleton.bones;
  const idxAttr = mesh.geometry.attributes.skinIndex;
  const wAttr = mesh.geometry.attributes.skinWeight;
  const vertCount = idxAttr.count;

  const boneNameMap = new Map();
  bones.forEach((b, bi) => boneNameMap.set(b.name, bi));

  const groupPerVert = Array.from({ length: vertCount }, () => []);
  for (const grp of vg.groups) {
    const bi = boneNameMap.get(grp.name);
    if (bi === undefined) continue;
    for (const [k, w] of Object.entries(grp.entries || {})) {
      const vi = Number(k);
      const val = Number(w);
      if (Number.isInteger(vi) && vi >= 0 && vi < vertCount && val > 1e-5) {
        groupPerVert[vi].push({ bi, w: val });
      }
    }
  }

  for (let i = 0; i < vertCount; i++) {
    const list = groupPerVert[i];
    if (list.length === 0) continue; // preserve existing non-group weights cleanly
    list.sort((a, b) => b.w - a.w);
    const top4 = list.slice(0, 4);
    let sum = 0;
    for (const item of top4) sum += item.w;
    for (let s = 0; s < 4; s++) {
      if (s < top4.length && sum > 1e-6) {
        idxAttr.setComponent(i, s, top4[s].bi);
        wAttr.setComponent(i, s, top4[s].w / sum);
      } else {
        idxAttr.setComponent(i, s, 0);
        wAttr.setComponent(i, s, 0);
      }
    }
  }
  idxAttr.needsUpdate = true;
  wAttr.needsUpdate = true;
  return true;
}

export function captureVertexGroupsSnapshot(mesh) {
  const vg = ensureVertexGroups(mesh);
  const idxAttr = mesh.geometry?.attributes?.skinIndex;
  const wAttr = mesh.geometry?.attributes?.skinWeight;
  return {
    vertexGroups: JSON.parse(JSON.stringify(vg)),
    skinIndex: idxAttr ? new Uint16Array(idxAttr.array) : null,
    skinWeight: wAttr ? new Float32Array(wAttr.array) : null,
  };
}

export function restoreVertexGroupsSnapshot(mesh, snap) {
  if (!mesh || !snap) return false;
  mesh.userData = mesh.userData || {};
  mesh.userData.vertexGroups = JSON.parse(JSON.stringify(snap.vertexGroups));
  if (snap.skinIndex && mesh.geometry?.attributes?.skinIndex) {
    mesh.geometry.attributes.skinIndex.array.set(snap.skinIndex);
    mesh.geometry.attributes.skinIndex.needsUpdate = true;
  }
  if (snap.skinWeight && mesh.geometry?.attributes?.skinWeight) {
    mesh.geometry.attributes.skinWeight.array.set(snap.skinWeight);
    mesh.geometry.attributes.skinWeight.needsUpdate = true;
  }
  return true;
}

export class VertexGroupsCommand {
  constructor(mesh, beforeSnap, afterSnap, onUpdate = null, description = 'Edit Vertex Groups') {
    this.mesh = mesh;
    this.beforeSnap = beforeSnap;
    this.afterSnap = afterSnap;
    this.onUpdate = onUpdate;
    this.description = description;
  }

  execute() {
    restoreVertexGroupsSnapshot(this.mesh, this.afterSnap);
    this.onUpdate?.();
  }

  undo() {
    restoreVertexGroupsSnapshot(this.mesh, this.beforeSnap);
    this.onUpdate?.();
  }
}
