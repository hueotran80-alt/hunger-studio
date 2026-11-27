/**
 * @file uv-unwrap.js
 * @description Pure Blender-standard UV unwrapping, packing, seam splitting,
 * texel-density equalization, and distortion analysis (no DOM dependencies).
 *
 * Implements:
 * - LSCM (Least Squares Conformal Maps, Lévy et al. 2002) with Jacobi PCG solver
 * - Smart UV Project (dihedral angle island clustering + planar tangent projection + pack)
 * - Cube / Cylinder / Sphere / View projections with proper +/-pi wraparound seam splitting
 * - Vertex pinning, Average Islands Scale, 2D Shelf/Skyline Pack Islands, and UV Stretch metrics
 */

import * as THREE from 'three';

const QUANT = 1e5;

/**
 * Quantized spatial key for a 3D vertex coordinate.
 * Survives vertex splitting across UV seams and normal splits.
 */
export function pointSpatialKey(x, y, z) {
  const qx = Math.round(x * QUANT) || 0;
  const qy = Math.round(y * QUANT) || 0;
  const qz = Math.round(z * QUANT) || 0;
  return `${qx},${qy},${qz}`;
}

/**
 * Canonical sorted spatial key for a 3D edge segment (a <-> b).
 */
export function edgeSpatialKey(ax, ay, az, bx, by, bz) {
  const ka = pointSpatialKey(ax, ay, az);
  const kb = pointSpatialKey(bx, by, bz);
  return ka <= kb ? `${ka}|${kb}` : `${kb}|${ka}`;
}

export function edgeSpatialKeyFromVectors(va, vb) {
  return edgeSpatialKey(va.x, va.y, va.z, vb.x, vb.y, vb.z);
}

/**
 * Normalize a seam collection (Set, Array, or null) into a Set<string>.
 */
export function normalizeSeamSet(seams) {
  if (!seams) return new Set();
  if (seams instanceof Set) return new Set(seams);
  if (Array.isArray(seams)) return new Set(seams.filter(s => typeof s === 'string'));
  return new Set();
}

/**
 * Normalizes geometry into triangle lists + welded 3D topological vertices + triangle adjacency.
 */
export function extractWeldedTopology(geometry, seamKeys = null, maxDihedralDeg = 180) {
  const posAttr = geometry?.attributes?.position;
  if (!posAttr || posAttr.count < 3) {
    return { triCount: 0, weldedVerts: [], triWelded: [], triRaw: [], triNormals: [], triAreas: [], triEdges: [], islands: [], isClosed: true };
  }

  const seams = normalizeSeamSet(seamKeys || geometry.userData?._uvSeams);
  const index = geometry.index;
  const rawTriCount = index ? Math.floor(index.count / 3) : Math.floor(posAttr.count / 3);

  const vertMap = new Map();
  const weldedVerts = []; // { x, y, z, key }
  const rawToWelded = new Int32Array(posAttr.count);

  for (let i = 0; i < posAttr.count; i++) {
    const x = posAttr.getX(i);
    const y = posAttr.getY(i);
    const z = posAttr.getZ(i);
    const key = pointSpatialKey(x, y, z);
    let w = vertMap.get(key);
    if (w === undefined) {
      w = weldedVerts.length;
      vertMap.set(key, w);
      weldedVerts.push({ x, y, z, key });
    }
    rawToWelded[i] = w;
  }

  const triWelded = [];
  const triRaw = [];
  const triNormals = [];
  const triAreas = [];

  const e1 = new THREE.Vector3();
  const e2 = new THREE.Vector3();
  const cross = new THREE.Vector3();

  for (let t = 0; t < rawTriCount; t++) {
    const r0 = index ? index.getX(t * 3) : t * 3;
    const r1 = index ? index.getX(t * 3 + 1) : t * 3 + 1;
    const r2 = index ? index.getX(t * 3 + 2) : t * 3 + 2;
    const w0 = rawToWelded[r0];
    const w1 = rawToWelded[r1];
    const w2 = rawToWelded[r2];
    if (w0 === w1 || w1 === w2 || w2 === w0) continue;

    const p0 = weldedVerts[w0];
    const p1 = weldedVerts[w1];
    const p2 = weldedVerts[w2];
    e1.set(p1.x - p0.x, p1.y - p0.y, p1.z - p0.z);
    e2.set(p2.x - p0.x, p2.y - p0.y, p2.z - p0.z);
    cross.crossVectors(e1, e2);
    const len = cross.length();
    const area = 0.5 * len;
    const norm = len > 1e-12
      ? { x: cross.x / len, y: cross.y / len, z: cross.z / len }
      : { x: 0, y: 1, z: 0 };

    triWelded.push([w0, w1, w2]);
    triRaw.push([r0, r1, r2]);
    triNormals.push(norm);
    triAreas.push(area);
  }

  const triCount = triWelded.length;
  const edgeUsers = new Map();
  const triEdgeSpatialKeys = new Array(triCount);

  for (let t = 0; t < triCount; t++) {
    const [a, b, c] = triWelded[t];
    const pairs = [[a, b], [b, c], [c, a]];
    const keys = [];
    for (let k = 0; k < 3; k++) {
      const u = pairs[k][0];
      const v = pairs[k][1];
      const wKey = u < v ? `${u}_${v}` : `${v}_${u}`;
      const pu = weldedVerts[u];
      const pv = weldedVerts[v];
      const sKey = edgeSpatialKey(pu.x, pu.y, pu.z, pv.x, pv.y, pv.z);
      keys.push(sKey);
      let list = edgeUsers.get(wKey);
      if (!list) {
        list = [];
        edgeUsers.set(wKey, list);
      }
      list.push({ tri: t, spatialKey: sKey });
    }
    triEdgeSpatialKeys[t] = keys;
  }

  const cosLimit = maxDihedralDeg >= 179.9
    ? -2
    : Math.cos((Math.max(0, Math.min(180, maxDihedralDeg)) * Math.PI) / 180);

  const adj = Array.from({ length: triCount }, () => []);
  for (const users of edgeUsers.values()) {
    if (users.length < 2) continue;
    const sKey = users[0].spatialKey;
    if (seams.has(sKey)) continue;
    if (users.length === 2) {
      const tA = users[0].tri;
      const tB = users[1].tri;
      if (cosLimit > -1.5) {
        const nA = triNormals[tA];
        const nB = triNormals[tB];
        const dot = nA.x * nB.x + nA.y * nB.y + nA.z * nB.z;
        if (dot < cosLimit) continue;
      }
      adj[tA].push(tB);
      adj[tB].push(tA);
    }
  }

  // Extract connected triangle islands across non-seam edges
  const visited = new Uint8Array(triCount);
  const islands = [];
  for (let t = 0; t < triCount; t++) {
    if (visited[t]) continue;
    const queue = [t];
    visited[t] = 1;
    for (let q = 0; q < queue.length; q++) {
      const cur = queue[q];
      const nbrs = adj[cur];
      for (let i = 0; i < nbrs.length; i++) {
        const nxt = nbrs[i];
        if (!visited[nxt]) {
          visited[nxt] = 1;
          queue.push(nxt);
        }
      }
    }
    islands.push(queue);
  }

  return {
    triCount,
    weldedVerts,
    rawToWelded,
    triWelded,
    triRaw,
    triNormals,
    triAreas,
    triEdgeSpatialKeys,
    edgeUsers,
    adj,
    islands,
    seams
  };
}

/**
 * Rebuilds a Three.js BufferGeometry splitting GPU vertices ONLY along UV seams / sharp UV splits,
 * preserving normals, skinning weights, vertex colors, groups, and userData metadata.
 *
 * @param {THREE.BufferGeometry} sourceGeom
 * @param {Array<[number, number, number]>} triRaw - Raw source vertex indices per triangle
 * @param {Float32Array} cornerUVs - Flat array length triRaw.length * 6: [u0,v0,u1,v1,u2,v2, ...]
 * @returns {THREE.BufferGeometry}
 */
export function buildSplitUVGeometry(sourceGeom, triRaw, cornerUVs) {
  const posAttr = sourceGeom.attributes.position;
  const normAttr = sourceGeom.attributes.normal;
  const colorAttr = sourceGeom.attributes.color;
  const skinIdxAttr = sourceGeom.attributes.skinIndex;
  const skinWgtAttr = sourceGeom.attributes.skinWeight;

  const lookup = new Map();
  const outSourceIndices = [];
  const outUVs = [];
  const outIndices = new Array(triRaw.length * 3);

  for (let t = 0; t < triRaw.length; t++) {
    const rawTriple = triRaw[t];
    for (let k = 0; k < 3; k++) {
      const srcIdx = rawTriple[k];
      const u = cornerUVs[t * 6 + k * 2];
      const v = cornerUVs[t * 6 + k * 2 + 1];
      const ku = Math.round(u * 1e4);
      const kv = Math.round(v * 1e4);
      const key = `${srcIdx}|${ku}|${kv}`;
      let outIdx = lookup.get(key);
      if (outIdx === undefined) {
        outIdx = outSourceIndices.length;
        lookup.set(key, outIdx);
        outSourceIndices.push(srcIdx);
        outUVs.push(u, v);
      }
      outIndices[t * 3 + k] = outIdx;
    }
  }

  const vertCount = outSourceIndices.length;
  const newGeom = new THREE.BufferGeometry();

  const outPos = new Float32Array(vertCount * 3);
  for (let i = 0; i < vertCount; i++) {
    const s = outSourceIndices[i];
    outPos[i * 3] = posAttr.getX(s);
    outPos[i * 3 + 1] = posAttr.getY(s);
    outPos[i * 3 + 2] = posAttr.getZ(s);
  }
  newGeom.setAttribute('position', new THREE.BufferAttribute(outPos, 3));
  newGeom.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(outUVs), 2));

  if (normAttr && normAttr.count === posAttr.count) {
    const outNorm = new Float32Array(vertCount * 3);
    for (let i = 0; i < vertCount; i++) {
      const s = outSourceIndices[i];
      outNorm[i * 3] = normAttr.getX(s);
      outNorm[i * 3 + 1] = normAttr.getY(s);
      outNorm[i * 3 + 2] = normAttr.getZ(s);
    }
    newGeom.setAttribute('normal', new THREE.BufferAttribute(outNorm, 3));
  }

  if (colorAttr && colorAttr.count === posAttr.count) {
    const itemSize = colorAttr.itemSize || 3;
    const outCol = new Float32Array(vertCount * itemSize);
    for (let i = 0; i < vertCount; i++) {
      const s = outSourceIndices[i];
      for (let c = 0; c < itemSize; c++) {
        outCol[i * itemSize + c] = colorAttr.array[s * itemSize + c];
      }
    }
    newGeom.setAttribute('color', new THREE.BufferAttribute(outCol, itemSize));
  }

  if (skinIdxAttr && skinWgtAttr && skinIdxAttr.count === posAttr.count) {
    const outSI = new Uint16Array(vertCount * 4);
    const outSW = new Float32Array(vertCount * 4);
    for (let i = 0; i < vertCount; i++) {
      const s = outSourceIndices[i];
      outSI[i * 4 + 0] = skinIdxAttr.getX(s);
      outSI[i * 4 + 1] = skinIdxAttr.getY(s);
      outSI[i * 4 + 2] = skinIdxAttr.getZ(s);
      outSI[i * 4 + 3] = skinIdxAttr.getW(s);
      outSW[i * 4 + 0] = skinWgtAttr.getX(s);
      outSW[i * 4 + 1] = skinWgtAttr.getY(s);
      outSW[i * 4 + 2] = skinWgtAttr.getZ(s);
      outSW[i * 4 + 3] = skinWgtAttr.getW(s);
    }
    newGeom.setAttribute('skinIndex', new THREE.BufferAttribute(outSI, 4));
    newGeom.setAttribute('skinWeight', new THREE.BufferAttribute(outSW, 4));
  }

  const IndexArray = vertCount > 65535 ? Uint32Array : Uint16Array;
  newGeom.setIndex(new THREE.BufferAttribute(new IndexArray(outIndices), 1));
  if (!newGeom.attributes.normal) {
    newGeom.computeVertexNormals();
  }
  newGeom.computeBoundingBox();
  newGeom.computeBoundingSphere();

  if (sourceGeom.groups?.length) {
    newGeom.groups = sourceGeom.groups.map(g => ({ ...g }));
  }
  newGeom.userData = cloneGeometryUserData(sourceGeom.userData);
  return newGeom;
}

/**
 * Clones BufferGeometry.userData without sharing mutable arrays/maps
 * (_uvSeams, _uvPinned, _looseEdges) while keeping live object refs safe.
 */
export function cloneGeometryUserData(ud) {
  if (!ud || typeof ud !== 'object') return {};
  const copy = { ...ud };
  if (Array.isArray(ud._uvSeams)) copy._uvSeams = [...ud._uvSeams];
  if (ud._uvPinned && typeof ud._uvPinned === 'object') {
    const pinnedCopy = {};
    for (const [k, v] of Object.entries(ud._uvPinned)) {
      pinnedCopy[k] = Array.isArray(v) ? [...v] : v;
    }
    copy._uvPinned = pinnedCopy;
  }
  if (Array.isArray(ud._looseEdges)) {
    copy._looseEdges = ud._looseEdges.map((e) => (
      Array.isArray(e) ? [...e] : (e && typeof e === 'object' ? { ...e } : e)
    ));
  }
  return copy;
}

/**
 * Clones a BufferGeometry with isolated seam/pin/edge userData for Undo/Redo snapshots.
 */
export function cloneGeometrySnapshot(geometry) {
  if (!geometry) return null;
  const cloned = geometry.clone();
  cloned.userData = cloneGeometryUserData(geometry.userData);
  return cloned;
}

/**
 * Updates targetMesh.geometry or mutates targetGeom in-place safely when vertex counts match,
 * or replaces mesh.geometry if vertices had to split across newly marked seams.
 */
export function applyUVGeometryUpdate(meshOrGeom, rebuiltGeom) {
  if (!rebuiltGeom) return null;
  if (meshOrGeom && meshOrGeom.isMesh) {
    const oldGeom = meshOrGeom.geometry;
    const oldCount = oldGeom?.attributes?.position?.count || 0;
    const newCount = rebuiltGeom.attributes?.position?.count || 0;
    const oldIdx = oldGeom?.index?.count || 0;
    const newIdx = rebuiltGeom.index?.count || 0;

    if (oldGeom && oldCount === newCount && oldIdx === newIdx) {
      oldGeom.setAttribute('uv', rebuiltGeom.attributes.uv);
      oldGeom.attributes.uv.needsUpdate = true;
      rebuiltGeom.dispose();
      return oldGeom;
    }
    if (oldGeom) {
      rebuiltGeom.userData = { ...cloneGeometryUserData(oldGeom.userData), ...cloneGeometryUserData(rebuiltGeom.userData) };
      oldGeom.dispose();
    }
    meshOrGeom.geometry = rebuiltGeom;
    return rebuiltGeom;
  }
  if (meshOrGeom && meshOrGeom.isBufferGeometry) {
    const oldCount = meshOrGeom.attributes?.position?.count || 0;
    const newCount = rebuiltGeom.attributes?.position?.count || 0;
    if (oldCount === newCount && (meshOrGeom.index?.count || 0) === (rebuiltGeom.index?.count || 0)) {
      meshOrGeom.setAttribute('uv', rebuiltGeom.attributes.uv);
      meshOrGeom.attributes.uv.needsUpdate = true;
      rebuiltGeom.dispose();
      return meshOrGeom;
    }
  }
  return rebuiltGeom;
}

// ============================================================================
// Island Planar Projection Helpers + Bounding Calipers
// ============================================================================

/**
 * Projects a triangle island onto its area-weighted average normal tangent frame (T, B).
 */
function projectIslandPlanar(topo, triList) {
  const n = new THREE.Vector3();
  for (let i = 0; i < triList.length; i++) {
    const t = triList[i];
    const tn = topo.triNormals[t];
    const area = Math.max(1e-8, topo.triAreas[t]);
    n.x += tn.x * area;
    n.y += tn.y * area;
    n.z += tn.z * area;
  }
  if (n.lengthSq() < 1e-12) n.set(0, 0, 1);
  n.normalize();

  // Pick stable tangent axis (world up unless near pole)
  const refUp = Math.abs(n.y) < 0.92 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(0, 0, 1);
  const tangent = new THREE.Vector3().crossVectors(refUp, n).normalize();
  const bitangent = new THREE.Vector3().crossVectors(n, tangent).normalize();

  const pts = [];
  for (let i = 0; i < triList.length; i++) {
    const t = triList[i];
    const [w0, w1, w2] = topo.triWelded[t];
    const triPts = [];
    for (const w of [w0, w1, w2]) {
      const p = topo.weldedVerts[w];
      const u = p.x * tangent.x + p.y * tangent.y + p.z * tangent.z;
      const v = p.x * bitangent.x + p.y * bitangent.y + p.z * bitangent.z;
      triPts.push([u, v]);
    }
    pts.push(triPts);
  }
  return pts;
}

/**
 * Builds an island-local welded vertex table, boundary vertex set, and 2D local triangles.
 * Uses corner union-find across NON-SEAM internal edges ONLY so internal seam cuts inside
 * an otherwise connected island split vertices cleanly along the seam fan!
 */
function buildIslandLocalMesh(topo, triList) {
  const T = triList.length;
  const cornerCount = T * 3;
  const parent = new Int32Array(cornerCount);
  const cornerWelded = new Int32Array(cornerCount);
  for (let i = 0; i < cornerCount; i++) parent[i] = i;

  const find = (x) => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };
  const unite = (a, b) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[rb] = ra;
  };

  // Collect half-edges inside this island by undirected welded vertex pair
  const edgeHalfs = new Map();
  for (let lt = 0; lt < T; lt++) {
    const t = triList[lt];
    const tri = topo.triWelded[t];
    for (let k = 0; k < 3; k++) {
      const wa = tri[k];
      const wb = tri[(k + 1) % 3];
      cornerWelded[lt * 3 + k] = wa;
      const key = wa < wb ? `${wa}_${wb}` : `${wb}_${wa}`;
      let list = edgeHalfs.get(key);
      if (!list) {
        list = [];
        edgeHalfs.set(key, list);
      }
      list.push({ lt, ca: lt * 3 + k, cb: lt * 3 + ((k + 1) % 3), wa, wb });
    }
  }

  // Merge corners across interior non-seam manifold edges ONLY
  for (const list of edgeHalfs.values()) {
    if (list.length !== 2) continue;
    const e0 = list[0];
    const e1 = list[1];
    const pa = topo.weldedVerts[e0.wa];
    const pb = topo.weldedVerts[e0.wb];
    const sKey = edgeSpatialKey(pa.x, pa.y, pa.z, pb.x, pb.y, pb.z);
    if (topo.seams.has(sKey)) continue; // Stop vertex welding across internal seams!

    if (e0.wa === e1.wa && e0.wb === e1.wb) {
      unite(e0.ca, e1.ca);
      unite(e0.cb, e1.cb);
    } else if (e0.wa === e1.wb && e0.wb === e1.wa) {
      unite(e0.ca, e1.cb);
      unite(e0.cb, e1.ca);
    }
  }

  const rootToLocal = new Map();
  const globalToLocal = new Map();
  const localToGlobal = [];
  const localTris = new Array(T);
  const triLocalByGlobal = new Map();
  const edgeCounts = new Map();

  for (let lt = 0; lt < T; lt++) {
    const t = triList[lt];
    const mapped = [0, 0, 0];
    for (let k = 0; k < 3; k++) {
      const c = lt * 3 + k;
      const r = find(c);
      let lv = rootToLocal.get(r);
      if (lv === undefined) {
        lv = localToGlobal.length;
        rootToLocal.set(r, lv);
        const gw = cornerWelded[c];
        localToGlobal.push(gw);
        if (!globalToLocal.has(gw)) globalToLocal.set(gw, lv);
      }
      mapped[k] = lv;
    }
    localTris[lt] = mapped;
    triLocalByGlobal.set(t, mapped);
    for (let k = 0; k < 3; k++) {
      const a = mapped[k];
      const b = mapped[(k + 1) % 3];
      const key = a < b ? `${a}_${b}` : `${b}_${a}`;
      edgeCounts.set(key, (edgeCounts.get(key) || 0) + 1);
    }
  }

  const boundarySet = new Set();
  for (const [key, count] of edgeCounts.entries()) {
    if (count === 1) {
      const [a, b] = key.split('_').map(Number);
      boundarySet.add(a);
      boundarySet.add(b);
    }
  }

  return {
    localToGlobal,
    globalToLocal,
    localTris,
    triLocalByGlobal,
    boundaryVerts: Array.from(boundarySet),
    hasBoundary: boundarySet.size >= 2
  };
}

/**
 * Finds the 2 farthest vertices among `candidates` in O(N) via 2-pass extreme sweep.
 */
function pickFarthestPinPair(weldedVerts, localToGlobal, candidates) {
  const pool = candidates.length >= 2
    ? candidates
    : Array.from({ length: localToGlobal.length }, (_, i) => i);
  if (pool.length < 2) return [0, 0, 1];

  const posOf = (li) => weldedVerts[localToGlobal[li]];
  const distSq = (a, b) => {
    const pa = posOf(a);
    const pb = posOf(b);
    const dx = pa.x - pb.x;
    const dy = pa.y - pb.y;
    const dz = pa.z - pb.z;
    return dx * dx + dy * dy + dz * dz;
  };

  let a = pool[0];
  let b = pool[1];
  let bestD = -1;
  for (const cand of pool) {
    const d = distSq(a, cand);
    if (d > bestD) {
      bestD = d;
      b = cand;
    }
  }
  bestD = -1;
  for (const cand of pool) {
    const d = distSq(b, cand);
    if (d > bestD) {
      bestD = d;
      a = cand;
    }
  }
  const dist = Math.sqrt(Math.max(1e-12, distSq(a, b)));
  return [a, b, dist];
}

// ============================================================================
// LSCM Conformal Solver (Least Squares Conformal Maps + Jacobi PCG)
// ============================================================================

/**
 * Solves LSCM on a single open topological island with >= 2 boundary / pinned vertices.
 * Returns { u: Float64Array, v: Float64Array } indexed by local vertex [0..V-1].
 */
function solveLSCMIsland(topo, islandMeta, pinnedMap = null, cornerClusterHint = null) {
  const { localToGlobal, localTris, boundaryVerts } = islandMeta;
  const V = localToGlobal.length;
  const uOut = new Float64Array(V);
  const vOut = new Float64Array(V);

  if (V < 3 || localTris.length === 0) return { u: uOut, v: vOut, usedUserPins: false };

  // Special fast exact flattening for single-triangle islands
  if (localTris.length === 1) {
    const [a, b, c] = localTris[0];
    const p0 = topo.weldedVerts[localToGlobal[a]];
    const p1 = topo.weldedVerts[localToGlobal[b]];
    const p2 = topo.weldedVerts[localToGlobal[c]];
    const e1 = new THREE.Vector3(p1.x - p0.x, p1.y - p0.y, p1.z - p0.z);
    const e2 = new THREE.Vector3(p2.x - p0.x, p2.y - p0.y, p2.z - p0.z);
    const L1 = Math.max(1e-6, e1.length());
    const t1 = e1.clone().divideScalar(L1);
    const n = new THREE.Vector3().crossVectors(t1, e2);
    const t2 = n.lengthSq() > 1e-12 ? new THREE.Vector3().crossVectors(n.normalize(), t1) : new THREE.Vector3(0, 1, 0);
    uOut[a] = 0; vOut[a] = 0;
    uOut[b] = L1; vOut[b] = 0;
    uOut[c] = e2.dot(t1); vOut[c] = e2.dot(t2);
    return { u: uOut, v: vOut, usedUserPins: false };
  }

  // Collect pinned vertices per-island, distinguishing seam-split corners when cluster keys exist
  const pinnedLocal = new Map(); // localIdx -> [u, v]
  if (pinnedMap && pinnedMap.size >= 2) {
    const bySpatial = new Map();
    for (let li = 0; li < V; li++) {
      const gw = localToGlobal[li];
      const k = topo.weldedVerts[gw].key;
      const hint = cornerClusterHint ? cornerClusterHint.get(li) : null;
      const clusterKey = hint ? `${k}@${hint}` : null;
      if (clusterKey && pinnedMap.has(clusterKey)) {
        pinnedLocal.set(li, pinnedMap.get(clusterKey));
      } else if (pinnedMap.has(k)) {
        let arr = bySpatial.get(k);
        if (!arr) {
          arr = [];
          bySpatial.set(k, arr);
        }
        arr.push(li);
      }
    }
    for (const [k, lvs] of bySpatial.entries()) {
      const targetUv = pinnedMap.get(k);
      if (lvs.length === 1) {
        pinnedLocal.set(lvs[0], targetUv);
      } else if (cornerClusterHint) {
        // Pick the split corner closest to the saved pin UV so seams aren't welded back shut!
        let bestLv = lvs[0];
        let bestDist = Infinity;
        for (const li of lvs) {
          const hint = cornerClusterHint.get(li);
          if (!hint) continue;
          const [cu, cv] = hint.split('_').map(Number);
          const d = Math.hypot((cu / 1000) - targetUv[0], (cv / 1000) - targetUv[1]);
          if (d < bestDist) {
            bestDist = d;
            bestLv = li;
          }
        }
        pinnedLocal.set(bestLv, targetUv);
      } else {
        for (const li of lvs) pinnedLocal.set(li, targetUv);
      }
    }
  }
  const usedUserPins = pinnedLocal.size >= 2;
  if (!usedUserPins) {
    pinnedLocal.clear();
    const [pA, pB, dist] = pickFarthestPinPair(topo.weldedVerts, localToGlobal, boundaryVerts);
    pinnedLocal.set(pA, [0, 0]);
    pinnedLocal.set(pB, [dist, 0]);
  }

  // Index free variables: each free local vertex i gets (2*freeIdx, 2*freeIdx+1)
  const freeSlot = new Int32Array(V).fill(-1);
  let freeVertCount = 0;
  for (let li = 0; li < V; li++) {
    if (pinnedLocal.has(li)) {
      const [pu, pv] = pinnedLocal.get(li);
      uOut[li] = pu;
      vOut[li] = pv;
    } else {
      freeSlot[li] = freeVertCount++;
    }
  }

  if (freeVertCount === 0) return { u: uOut, v: vOut, usedUserPins };

  const dim = freeVertCount * 2;
  // Sparse normal equations N = A_f^T A_f + eps * I using row-major Map
  const matRows = Array.from({ length: dim }, () => new Map());
  const rhs = new Float64Array(dim);

  const addEntry = (r, c, val) => {
    matRows[r].set(c, (matRows[r].get(c) || 0) + val);
  };

  const e01 = new THREE.Vector3();
  const e02 = new THREE.Vector3();
  const nVec = new THREE.Vector3();
  const tDir = new THREE.Vector3();
  const bDir = new THREE.Vector3();

  for (let t = 0; t < localTris.length; t++) {
    const [i0, i1, i2] = localTris[t];
    const p0 = topo.weldedVerts[localToGlobal[i0]];
    const p1 = topo.weldedVerts[localToGlobal[i1]];
    const p2 = topo.weldedVerts[localToGlobal[i2]];

    e01.set(p1.x - p0.x, p1.y - p0.y, p1.z - p0.z);
    e02.set(p2.x - p0.x, p2.y - p0.y, p2.z - p0.z);
    const L01 = e01.length();
    if (L01 < 1e-10) continue;

    tDir.copy(e01).divideScalar(L01);
    nVec.crossVectors(tDir, e02);
    const h = nVec.length();
    if (h < 1e-10) continue;
    nVec.divideScalar(h);
    bDir.crossVectors(nVec, tDir);

    // Local 2D triangle coordinates (x0=0,y0=0), (x1=L01,y1=0), (x2, y2>0)
    const x0 = 0, y0 = 0;
    const x1 = L01, y1 = 0;
    const x2 = e02.dot(tDir);
    const y2 = e02.dot(bDir);
    const twoA = x1 * y2;
    if (Math.abs(twoA) < 1e-10) continue;
    const invSqrtTwoA = 1 / Math.sqrt(Math.abs(twoA));

    // Edge normals scaled so gradient is exact & residual norm^2 = conformal area energy
    const nx = [(y1 - y2) * invSqrtTwoA, (y2 - y0) * invSqrtTwoA, (y0 - y1) * invSqrtTwoA];
    const ny = [(x2 - x1) * invSqrtTwoA, (x0 - x2) * invSqrtTwoA, (x1 - x0) * invSqrtTwoA];

    // Row 1: sum(nx[k]*u_k - ny[k]*v_k) = 0
    // Row 2: sum(ny[k]*u_k + nx[k]*v_k) = 0
    const indices = [i0, i1, i2];
    for (let row = 0; row < 2; row++) {
      const freeCols = [];
      let pinConst = 0;
      for (let k = 0; k < 3; k++) {
        const li = indices[k];
        const cu = row === 0 ? nx[k] : ny[k];
        const cv = row === 0 ? -ny[k] : nx[k];
        const slot = freeSlot[li];
        if (slot >= 0) {
          freeCols.push([slot * 2, cu], [slot * 2 + 1, cv]);
        } else {
          pinConst += cu * uOut[li] + cv * vOut[li];
        }
      }
      for (let aIdx = 0; aIdx < freeCols.length; aIdx++) {
        const [r, vr] = freeCols[aIdx];
        rhs[r] -= vr * pinConst;
        for (let bIdx = 0; bIdx < freeCols.length; bIdx++) {
          const [c, vc] = freeCols[bIdx];
          addEntry(r, c, vr * vc);
        }
      }
    }
  }

  // Tikhonov regularization for strict positive definiteness on degenerate boundary corners
  for (let i = 0; i < dim; i++) {
    addEntry(i, i, 1e-8);
  }

  // Convert to compact CSR for fast Jacobi-PCG solve
  const rowPtr = new Int32Array(dim + 1);
  let nnz = 0;
  for (let i = 0; i < dim; i++) {
    rowPtr[i] = nnz;
    nnz += matRows[i].size;
  }
  rowPtr[dim] = nnz;

  const colIdx = new Int32Array(nnz);
  const vals = new Float64Array(nnz);
  const invDiag = new Float64Array(dim);
  let ptr = 0;
  for (let i = 0; i < dim; i++) {
    for (const [c, v] of matRows[i].entries()) {
      colIdx[ptr] = c;
      vals[ptr] = v;
      if (c === i) invDiag[i] = Math.abs(v) > 1e-14 ? 1 / v : 1;
      ptr++;
    }
  }

  // Preconditioned Conjugate Gradient
  const x = new Float64Array(dim);
  const r = new Float64Array(rhs);
  const z = new Float64Array(dim);
  const p = new Float64Array(dim);
  const Ap = new Float64Array(dim);

  let rzOld = 0;
  let bNorm = 0;
  for (let i = 0; i < dim; i++) {
    z[i] = invDiag[i] * r[i];
    p[i] = z[i];
    rzOld += r[i] * z[i];
    bNorm += rhs[i] * rhs[i];
  }

  const maxIter = Math.max(400, dim * 3);
  const tolSq = 1e-12 * Math.max(1, bNorm);

  for (let iter = 0; iter < maxIter; iter++) {
    if (rzOld <= tolSq) break;
    let pAp = 0;
    for (let i = 0; i < dim; i++) {
      let sum = 0;
      const start = rowPtr[i];
      const end = rowPtr[i + 1];
      for (let k = start; k < end; k++) {
        sum += vals[k] * p[colIdx[k]];
      }
      Ap[i] = sum;
      pAp += p[i] * sum;
    }
    if (Math.abs(pAp) < 1e-20) break;
    const alpha = rzOld / pAp;
    let rzNew = 0;
    let rNormSq = 0;
    for (let i = 0; i < dim; i++) {
      x[i] += alpha * p[i];
      r[i] -= alpha * Ap[i];
      rNormSq += r[i] * r[i];
      z[i] = invDiag[i] * r[i];
      rzNew += r[i] * z[i];
    }
    if (rNormSq <= tolSq) break;
    const beta = rzNew / Math.max(1e-20, rzOld);
    for (let i = 0; i < dim; i++) {
      p[i] = z[i] + beta * p[i];
    }
    rzOld = rzNew;
  }

  for (let li = 0; li < V; li++) {
    const slot = freeSlot[li];
    if (slot >= 0) {
      uOut[li] = Number.isFinite(x[slot * 2]) ? x[slot * 2] : 0;
      vOut[li] = Number.isFinite(x[slot * 2 + 1]) ? x[slot * 2 + 1] : 0;
    }
  }

  // Guarantee positive signed UV area when not externally pinned
  if (!usedUserPins) {
    let signedArea = 0;
    for (let t = 0; t < localTris.length; t++) {
      const [a, b, c] = localTris[t];
      signedArea += (uOut[b] - uOut[a]) * (vOut[c] - vOut[a]) - (uOut[c] - uOut[a]) * (vOut[b] - vOut[a]);
    }
    if (signedArea < 0) {
      for (let i = 0; i < V; i++) uOut[i] = -uOut[i];
    }
  }

  return { u: uOut, v: vOut, usedUserPins };
}

// ============================================================================
// Pack Islands & Texel Density Equalization
// ============================================================================

/**
 * Extracts topological UV islands directly from an already-unwrapped BufferGeometry.
 * Corners at the same 3D position AND matching UV (within 1e-4) stay connected.
 */
export function extractUVIslandsFromGeometry(geometry) {
  const posAttr = geometry?.attributes?.position;
  const uvAttr = geometry?.attributes?.uv;
  if (!posAttr || !uvAttr || posAttr.count < 3) return [];

  const index = geometry.index;
  const triCount = index ? Math.floor(index.count / 3) : Math.floor(posAttr.count / 3);
  const cornerKeys = new Array(triCount);
  const keyToTris = new Map();

  for (let t = 0; t < triCount; t++) {
    const ks = [];
    for (let k = 0; k < 3; k++) {
      const vi = index ? index.getX(t * 3 + k) : t * 3 + k;
      const key = `${pointSpatialKey(posAttr.getX(vi), posAttr.getY(vi), posAttr.getZ(vi))}|${Math.round(uvAttr.getX(vi) * 1e4)}|${Math.round(uvAttr.getY(vi) * 1e4)}`;
      ks.push(key);
      let list = keyToTris.get(key);
      if (!list) {
        list = [];
        keyToTris.set(key, list);
      }
      list.push(t);
    }
    cornerKeys[t] = ks;
  }

  const visited = new Uint8Array(triCount);
  const islands = [];
  for (let t = 0; t < triCount; t++) {
    if (visited[t]) continue;
    const tris = [t];
    visited[t] = 1;
    const vertSet = new Set();

    for (let q = 0; q < tris.length; q++) {
      const cur = tris[q];
      for (let k = 0; k < 3; k++) {
        const vi = index ? index.getX(cur * 3 + k) : cur * 3 + k;
        vertSet.add(vi);
        const sharing = keyToTris.get(cornerKeys[cur][k]) || [];
        for (let s = 0; s < sharing.length; s++) {
          const nxt = sharing[s];
          if (!visited[nxt]) {
            visited[nxt] = 1;
            tris.push(nxt);
          }
        }
      }
    }

    let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
    let uvArea = 0;
    let area3D = 0;
    const e1 = new THREE.Vector3();
    const e2 = new THREE.Vector3();
    const pA = new THREE.Vector3();
    const pB = new THREE.Vector3();
    const pC = new THREE.Vector3();

    for (const triIdx of tris) {
      const i0 = index ? index.getX(triIdx * 3) : triIdx * 3;
      const i1 = index ? index.getX(triIdx * 3 + 1) : triIdx * 3 + 1;
      const i2 = index ? index.getX(triIdx * 3 + 2) : triIdx * 3 + 2;
      const u0 = uvAttr.getX(i0), v0 = uvAttr.getY(i0);
      const u1 = uvAttr.getX(i1), v1 = uvAttr.getY(i1);
      const u2 = uvAttr.getX(i2), v2 = uvAttr.getY(i2);
      uvArea += 0.5 * Math.abs((u1 - u0) * (v2 - v0) - (u2 - u0) * (v1 - v0));
      pA.fromBufferAttribute(posAttr, i0);
      pB.fromBufferAttribute(posAttr, i1);
      pC.fromBufferAttribute(posAttr, i2);
      e1.subVectors(pB, pA);
      e2.subVectors(pC, pA);
      area3D += 0.5 * e1.cross(e2).length();
    }

    for (const vi of vertSet) {
      const u = uvAttr.getX(vi);
      const v = uvAttr.getY(vi);
      if (u < minU) minU = u;
      if (u > maxU) maxU = u;
      if (v < minV) minV = v;
      if (v > maxV) maxV = v;
    }

    islands.push({
      tris,
      verts: Array.from(vertSet),
      minU, maxU, minV, maxV,
      width: maxU - minU,
      height: maxV - minV,
      uvArea,
      area3D
    });
  }

  return islands;
}

/**
 * Normalizes texel density across all UV islands to the area-weighted average density.
 */
export function averageIslandsScaleInPlace(geometry) {
  const islands = extractUVIslandsFromGeometry(geometry);
  if (islands.length <= 1) return false;
  const uvAttr = geometry.attributes.uv;

  let total3D = 0;
  let totalUV = 0;
  for (const isl of islands) {
    if (isl.area3D > 1e-10 && isl.uvArea > 1e-10) {
      total3D += isl.area3D;
      totalUV += isl.uvArea;
    }
  }
  if (total3D <= 1e-10 || totalUV <= 1e-10) return false;
  const targetRatio = totalUV / total3D;

  for (const isl of islands) {
    if (isl.area3D <= 1e-10 || isl.uvArea <= 1e-10) continue;
    const curRatio = isl.uvArea / isl.area3D;
    const s = Math.sqrt(targetRatio / curRatio);
    const cu = (isl.minU + isl.maxU) * 0.5;
    const cv = (isl.minV + isl.maxV) * 0.5;
    for (const vi of isl.verts) {
      uvAttr.setXY(
        vi,
        cu + (uvAttr.getX(vi) - cu) * s,
        cv + (uvAttr.getY(vi) - cv) * s
      );
    }
  }
  uvAttr.needsUpdate = true;
  return true;
}

/**
 * Finds minimum-area enclosing angle among candidate angles [0..90deg) and applies best rotation.
 */
function findOptimalIslandRotation(uvAttr, vertIndices, stepCount = 12) {
  if (vertIndices.length < 2) return 0;
  let bestAngle = 0;
  let bestMetric = Infinity;
  let bestW = 1, bestH = 1;

  for (let s = 0; s < stepCount; s++) {
    const rad = (s * (Math.PI * 0.5)) / stepCount;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
    for (const vi of vertIndices) {
      const u = uvAttr.getX(vi);
      const v = uvAttr.getY(vi);
      const ru = u * cos - v * sin;
      const rv = u * sin + v * cos;
      if (ru < minU) minU = ru;
      if (ru > maxU) maxU = ru;
      if (rv < minV) minV = rv;
      if (rv > maxV) maxV = rv;
    }
    const w = maxU - minU;
    const h = maxV - minV;
    const area = (w + 1e-4) * (h + 1e-4);
    // Slight preference for landscape / shorter shelf height when areas tie
    const metric = area + h * 0.0001;
    if (metric < bestMetric) {
      bestMetric = metric;
      bestAngle = rad;
      bestW = w;
      bestH = h;
    }
  }

  // Rotate 90deg if wider-than-tall helps row packing, or keep upright
  if (bestW > 0 && bestH > bestW * 1.15) {
    bestAngle += Math.PI * 0.5;
  }
  return bestAngle;
}

/**
 * Packs all UV islands inside [margin, 1 - margin]^2 using 2D Shelf Packing + binary scale fit,
 * guaranteeing zero overlapping island bounding boxes.
 */
export function packUVIslandsInPlace(geometry, options = {}) {
  const margin = Math.max(0, Math.min(0.15, Number(options.margin ?? 0.02)));
  const rotate = options.rotate !== false;
  const averageScale = options.averageScale !== false;

  const uvAttr = geometry?.attributes?.uv;
  if (!uvAttr || uvAttr.count === 0) return false;

  if (averageScale) {
    averageIslandsScaleInPlace(geometry);
  }

  const islands = extractUVIslandsFromGeometry(geometry);
  if (islands.length === 0) return false;

  // Normalize / optionally rotate each island to its local origin [0, w] x [0, h]
  const items = islands.map((isl) => {
    if (rotate && isl.verts.length >= 3) {
      const rad = findOptimalIslandRotation(uvAttr, isl.verts, 12);
      if (Math.abs(rad) > 1e-6) {
        const cos = Math.cos(rad);
        const sin = Math.sin(rad);
        for (const vi of isl.verts) {
          const u = uvAttr.getX(vi);
          const v = uvAttr.getY(vi);
          uvAttr.setXY(vi, u * cos - v * sin, u * sin + v * cos);
        }
      }
    }

    let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
    for (const vi of isl.verts) {
      const u = uvAttr.getX(vi);
      const v = uvAttr.getY(vi);
      if (u < minU) minU = u;
      if (u > maxU) maxU = u;
      if (v < minV) minV = v;
      if (v > maxV) maxV = v;
    }
    const w = Math.max(1e-5, maxU - minU);
    const h = Math.max(1e-5, maxV - minV);
    return { verts: isl.verts, minU, minV, w, h };
  });

  // Sort tallest first (FFD Shelf packing heuristic)
  items.sort((a, b) => (b.h - a.h) || (b.w - a.w));

  const tryPackAtScale = (scale, gap) => {
    const limit = 1 - margin * 2;
    if (limit <= 1e-4) return null;

    let cursorX = 0;
    let cursorY = 0;
    let shelfH = 0;
    const placements = new Array(items.length);

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const sw = item.w * scale;
      const sh = item.h * scale;
      if (sw > limit + 1e-6 || sh > limit + 1e-6) return null;

      if (cursorX > 0 && cursorX + sw > limit + 1e-6) {
        cursorX = 0;
        cursorY += shelfH + gap;
        shelfH = 0;
      }
      if (cursorY + sh > limit + 1e-6) return null;

      placements[i] = { x: cursorX, y: cursorY };
      cursorX += sw + gap;
      if (sh > shelfH) shelfH = sh;
    }
    return placements;
  };

  // Estimate upper/lower scale bounds & binary search tightest pack
  let totalArea = 0;
  let maxItemDim = 1e-5;
  for (const it of items) {
    totalArea += it.w * it.h;
    if (it.w > maxItemDim) maxItemDim = it.w;
    if (it.h > maxItemDim) maxItemDim = it.h;
  }
  const usable = Math.max(0.05, 1 - margin * 2);
  let lo = 0;
  let hi = Math.min(usable / maxItemDim, Math.sqrt((usable * usable) / Math.max(1e-10, totalArea)) * 1.4);
  if (!Number.isFinite(hi) || hi <= 0) hi = 1;

  // Ensure lo actually packs
  const gap = Math.min(margin * 0.5, usable * 0.03);
  let bestScale = hi * 0.1;
  let bestPlacements = tryPackAtScale(bestScale, gap);
  while (!bestPlacements && bestScale > 1e-6) {
    bestScale *= 0.5;
    bestPlacements = tryPackAtScale(bestScale, gap);
  }
  lo = bestScale;

  for (let step = 0; step < 24; step++) {
    const mid = (lo + hi) * 0.5;
    const res = tryPackAtScale(mid, gap);
    if (res) {
      lo = mid;
      bestScale = mid;
      bestPlacements = res;
    } else {
      hi = mid;
    }
  }

  if (!bestPlacements) return false;

  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const pl = bestPlacements[i];
    const ox = margin + pl.x;
    const oy = margin + pl.y;
    for (const vi of it.verts) {
      const nu = ox + (uvAttr.getX(vi) - it.minU) * bestScale;
      const nv = oy + (uvAttr.getY(vi) - it.minV) * bestScale;
      uvAttr.setXY(vi, nu, nv);
    }
  }
  uvAttr.needsUpdate = true;
  return true;
}

// ============================================================================
// High-Level Blender Unwrap Operators
// ============================================================================

/**
 * Blender Default `U -> Unwrap` (LSCM per seam-split island, automatic Smart fallback
 * ONLY for closed seamless islands that have 0 seams and 0 boundary edges).
 */
export function unwrapMeshLSCM(geometry, options = {}) {
  const topo = extractWeldedTopology(geometry, options.seamKeys, 180);
  if (topo.triCount === 0) return geometry.clone();

  const pinnedMap = options.pinnedMap instanceof Map ? options.pinnedMap : null;
  const margin = Number(options.margin ?? 0.02);
  const cornerUVs = new Float32Array(topo.triCount * 6);
  const existingUv = geometry.attributes?.uv || null;

  // Map global triangle index -> sequential index inside cornerUVs
  const solvedIslands = [];
  let anyPinnedIsland = false;

  for (const triList of topo.islands) {
    const islandMeta = buildIslandLocalMesh(topo, triList);
    let cornerClusterHint = null;
    if (existingUv) {
      cornerClusterHint = new Map();
      for (const t of triList) {
        const rawTri = topo.triRaw[t];
        const lTri = islandMeta.triLocalByGlobal.get(t);
        if (!lTri) continue;
        for (let k = 0; k < 3; k++) {
          const lv = lTri[k];
          if (!cornerClusterHint.has(lv) && rawTri[k] < existingUv.count) {
            const cu = Math.round(existingUv.getX(rawTri[k]) * 1000);
            const cv = Math.round(existingUv.getY(rawTri[k]) * 1000);
            cornerClusterHint.set(lv, `${cu}_${cv}`);
          }
        }
      }
    }

    // Count pins that actually belong to THIS island
    let islandPinMatches = 0;
    if (pinnedMap && pinnedMap.size >= 2) {
      for (let li = 0; li < islandMeta.localToGlobal.length; li++) {
        const k = topo.weldedVerts[islandMeta.localToGlobal[li]].key;
        const hint = cornerClusterHint?.get(li);
        if ((hint && pinnedMap.has(`${k}@${hint}`)) || pinnedMap.has(k)) {
          islandPinMatches += 1;
        }
      }
    }

    if (islandMeta.hasBoundary || islandPinMatches >= 2) {
      const { u, v, usedUserPins } = solveLSCMIsland(topo, islandMeta, pinnedMap, cornerClusterHint);
      if (usedUserPins) anyPinnedIsland = true;
      for (const t of triList) {
        const [l0, l1, l2] = islandMeta.triLocalByGlobal.get(t);
        cornerUVs[t * 6 + 0] = u[l0];
        cornerUVs[t * 6 + 1] = v[l0];
        cornerUVs[t * 6 + 2] = u[l1];
        cornerUVs[t * 6 + 3] = v[l1];
        cornerUVs[t * 6 + 4] = u[l2];
        cornerUVs[t * 6 + 5] = v[l2];
      }
      solvedIslands.push({ triList, mode: 'lscm', pinned: usedUserPins });
    } else {
      // Closed seamless island: split into planar clusters via Smart UV angle threshold
      const subTopo = extractIslandSmartClusters(topo, triList, 66);
      for (const cluster of subTopo) {
        const triUVs = projectIslandPlanar(topo, cluster);
        for (let i = 0; i < cluster.length; i++) {
          const t = cluster[i];
          cornerUVs[t * 6 + 0] = triUVs[i][0][0];
          cornerUVs[t * 6 + 1] = triUVs[i][0][1];
          cornerUVs[t * 6 + 2] = triUVs[i][1][0];
          cornerUVs[t * 6 + 3] = triUVs[i][1][1];
          cornerUVs[t * 6 + 4] = triUVs[i][2][0];
          cornerUVs[t * 6 + 5] = triUVs[i][2][1];
        }
        solvedIslands.push({ triList: cluster, mode: 'smart-fallback', pinned: false });
      }
    }
  }

  const rebuilt = buildSplitUVGeometry(geometry, topo.triRaw, cornerUVs);
  const respectPins = options.respectPins !== false;
  if (options.pack !== false && !(anyPinnedIsland && respectPins && !options.forcePackPinned)) {
    packUVIslandsInPlace(rebuilt, {
      margin,
      rotate: options.rotate !== false,
      averageScale: options.averageScale !== false
    });
  }
  return rebuilt;
}

/**
 * Helper to sub-cluster triangles in a closed island using angle threshold.
 */
function extractIslandSmartClusters(topo, triList, angleLimitDeg = 66) {
  const cosLimit = Math.cos((Math.max(1, Math.min(179, angleLimitDeg)) * Math.PI) / 180);
  const inIsland = new Set(triList);
  const visited = new Set();
  const clusters = [];

  for (const seed of triList) {
    if (visited.has(seed)) continue;
    visited.add(seed);
    const cluster = [seed];
    const seedNorm = topo.triNormals[seed];

    for (let q = 0; q < cluster.length; q++) {
      const cur = cluster[q];
      const curNorm = topo.triNormals[cur];
      const nbrs = topo.adj[cur];
      for (const nxt of nbrs) {
        if (!inIsland.has(nxt) || visited.has(nxt)) continue;
        const nxtNorm = topo.triNormals[nxt];
        const dotAdj = curNorm.x * nxtNorm.x + curNorm.y * nxtNorm.y + curNorm.z * nxtNorm.z;
        const dotSeed = seedNorm.x * nxtNorm.x + seedNorm.y * nxtNorm.y + seedNorm.z * nxtNorm.z;
        if (dotAdj >= cosLimit && dotSeed >= Math.max(0.1, cosLimit - 0.15)) {
          visited.add(nxt);
          cluster.push(nxt);
        }
      }
    }
    clusters.push(cluster);
  }
  return clusters;
}

/**
 * Blender `U -> Smart UV Project`: splits mesh into angle-bounded planar clusters
 * and packs all islands neatly inside [0, 1]^2 with margin.
 */
export function smartUVProjectGeometry(geometry, options = {}) {
  const angleLimitDeg = Number(options.angleLimitDeg ?? 66);
  const margin = Number(options.margin ?? 0.02);
  const topo = extractWeldedTopology(geometry, options.seamKeys, angleLimitDeg);
  if (topo.triCount === 0) return geometry.clone();

  const cornerUVs = new Float32Array(topo.triCount * 6);
  for (const island of topo.islands) {
    const clusters = extractIslandSmartClusters(topo, island, angleLimitDeg);
    for (const cluster of clusters) {
      const triUVs = projectIslandPlanar(topo, cluster);
      for (let i = 0; i < cluster.length; i++) {
        const t = cluster[i];
        cornerUVs[t * 6 + 0] = triUVs[i][0][0];
        cornerUVs[t * 6 + 1] = triUVs[i][0][1];
        cornerUVs[t * 6 + 2] = triUVs[i][1][0];
        cornerUVs[t * 6 + 3] = triUVs[i][1][1];
        cornerUVs[t * 6 + 4] = triUVs[i][2][0];
        cornerUVs[t * 6 + 5] = triUVs[i][2][1];
      }
    }
  }

  const rebuilt = buildSplitUVGeometry(geometry, topo.triRaw, cornerUVs);
  packUVIslandsInPlace(rebuilt, { margin, rotate: true, averageScale: true });
  return rebuilt;
}

/**
 * Blender `U -> Cube Projection`: per-face dominant axis orthographic box mapping.
 */
export function cubeProjectGeometry(geometry, options = {}) {
  const topo = extractWeldedTopology(geometry, options.seamKeys, 180);
  if (topo.triCount === 0) return geometry.clone();

  geometry.computeBoundingBox();
  const bbox = geometry.boundingBox;
  const size = new THREE.Vector3();
  const center = new THREE.Vector3();
  bbox.getSize(size);
  bbox.getCenter(center);
  const maxSpan = Math.max(size.x, size.y, size.z, 1e-5);
  const scale = Number(options.cubeSize ?? 1.0) / maxSpan;

  const cornerUVs = new Float32Array(topo.triCount * 6);
  for (let t = 0; t < topo.triCount; t++) {
    const n = topo.triNormals[t];
    const ax = Math.abs(n.x), ay = Math.abs(n.y), az = Math.abs(n.z);
    const [w0, w1, w2] = topo.triWelded[t];
    const verts = [topo.weldedVerts[w0], topo.weldedVerts[w1], topo.weldedVerts[w2]];
    for (let k = 0; k < 3; k++) {
      const p = verts[k];
      const dx = (p.x - center.x) * scale;
      const dy = (p.y - center.y) * scale;
      const dz = (p.z - center.z) * scale;
      let u = 0.5, v = 0.5;
      if (ax >= ay && ax >= az) {
        u = (n.x >= 0 ? -dz : dz) + 0.5;
        v = dy + 0.5;
      } else if (ay >= ax && ay >= az) {
        u = dx + 0.5;
        v = (n.y >= 0 ? -dz : dz) + 0.5;
      } else {
        u = (n.z >= 0 ? dx : -dx) + 0.5;
        v = dy + 0.5;
      }
      cornerUVs[t * 6 + k * 2] = u;
      cornerUVs[t * 6 + k * 2 + 1] = v;
    }
  }

  const rebuilt = buildSplitUVGeometry(geometry, topo.triRaw, cornerUVs);
  if (options.pack) {
    packUVIslandsInPlace(rebuilt, { margin: 0.02, rotate: false, averageScale: false });
  }
  return rebuilt;
}

/**
 * Blender `U -> Cylinder Projection` with +/-pi wraparound seam fix.
 */
export function cylinderProjectGeometry(geometry, options = {}) {
  const topo = extractWeldedTopology(geometry, options.seamKeys, 180);
  if (topo.triCount === 0) return geometry.clone();

  geometry.computeBoundingBox();
  const bbox = geometry.boundingBox;
  const size = new THREE.Vector3();
  const center = new THREE.Vector3();
  bbox.getSize(size);
  bbox.getCenter(center);

  const twoPi = Math.PI * 2;
  const cornerUVs = new Float32Array(topo.triCount * 6);
  const spanY = Math.max(size.y, 1e-5);
  const minY = center.y - spanY * 0.5;

  for (let t = 0; t < topo.triCount; t++) {
    const [w0, w1, w2] = topo.triWelded[t];
    const verts = [topo.weldedVerts[w0], topo.weldedVerts[w1], topo.weldedVerts[w2]];
    const us = new Float64Array(3);
    const vs = new Float64Array(3);
    for (let k = 0; k < 3; k++) {
      const p = verts[k];
      us[k] = Math.atan2(p.z - center.z, p.x - center.x) / twoPi + 0.5;
      vs[k] = (p.y - minY) / spanY;
    }
    // Fix triangles crossing the +/-pi wraparound meridian
    const uMax = Math.max(us[0], us[1], us[2]);
    const uMin = Math.min(us[0], us[1], us[2]);
    if (uMax - uMin > 0.5) {
      for (let k = 0; k < 3; k++) {
        if (us[k] < 0.5) us[k] += 1.0;
      }
    }
    for (let k = 0; k < 3; k++) {
      cornerUVs[t * 6 + k * 2] = us[k];
      cornerUVs[t * 6 + k * 2 + 1] = vs[k];
    }
  }
  return buildSplitUVGeometry(geometry, topo.triRaw, cornerUVs);
}

/**
 * Blender `U -> Sphere Projection` with +/-pi wraparound seam fix.
 */
export function sphereProjectGeometry(geometry, options = {}) {
  const topo = extractWeldedTopology(geometry, options.seamKeys, 180);
  if (topo.triCount === 0) return geometry.clone();

  geometry.computeBoundingBox();
  const center = new THREE.Vector3();
  geometry.boundingBox.getCenter(center);

  const twoPi = Math.PI * 2;
  const cornerUVs = new Float32Array(topo.triCount * 6);

  for (let t = 0; t < topo.triCount; t++) {
    const [w0, w1, w2] = topo.triWelded[t];
    const verts = [topo.weldedVerts[w0], topo.weldedVerts[w1], topo.weldedVerts[w2]];
    const us = new Float64Array(3);
    const vs = new Float64Array(3);
    for (let k = 0; k < 3; k++) {
      const p = verts[k];
      const dx = p.x - center.x;
      const dy = p.y - center.y;
      const dz = p.z - center.z;
      const r = Math.hypot(dx, dy, dz) || 1;
      us[k] = Math.atan2(dz, dx) / twoPi + 0.5;
      vs[k] = Math.asin(Math.max(-1, Math.min(1, dy / r))) / Math.PI + 0.5;
    }
    const uMax = Math.max(us[0], us[1], us[2]);
    const uMin = Math.min(us[0], us[1], us[2]);
    if (uMax - uMin > 0.5) {
      for (let k = 0; k < 3; k++) {
        if (us[k] < 0.5) us[k] += 1.0;
      }
    }
    for (let k = 0; k < 3; k++) {
      cornerUVs[t * 6 + k * 2] = us[k];
      cornerUVs[t * 6 + k * 2 + 1] = vs[k];
    }
  }
  return buildSplitUVGeometry(geometry, topo.triRaw, cornerUVs);
}

/**
 * Blender `U -> Reset`: resets each face/triangle cleanly onto [0, 1]^2.
 */
export function resetUVsGeometry(geometry) {
  const topo = extractWeldedTopology(geometry, null, 180);
  if (topo.triCount === 0) return geometry.clone();
  const cornerUVs = new Float32Array(topo.triCount * 6);
  for (let t = 0; t < topo.triCount; t++) {
    const even = (t % 2) === 0;
    if (even) {
      cornerUVs[t * 6 + 0] = 0; cornerUVs[t * 6 + 1] = 0;
      cornerUVs[t * 6 + 2] = 1; cornerUVs[t * 6 + 3] = 0;
      cornerUVs[t * 6 + 4] = 1; cornerUVs[t * 6 + 5] = 1;
    } else {
      cornerUVs[t * 6 + 0] = 0; cornerUVs[t * 6 + 1] = 0;
      cornerUVs[t * 6 + 2] = 1; cornerUVs[t * 6 + 3] = 1;
      cornerUVs[t * 6 + 4] = 0; cornerUVs[t * 6 + 5] = 1;
    }
  }
  return buildSplitUVGeometry(geometry, topo.triRaw, cornerUVs);
}

/**
 * Computes per-triangle normalized UV Stretch distortion [0..1] (0 = undistorted, 1 = severe stretch).
 * Used for Blender's Display Stretch overlay (Angle or Area mode).
 */
/**
 * Counts triangles whose UV winding is flipped (signed 2D area < 0).
 */
export function countFlippedUVTriangles(geometry) {
  const uv = geometry?.attributes?.uv;
  if (!uv) return 0;
  const idx = geometry.index;
  const triCount = idx ? Math.floor(idx.count / 3) : Math.floor(uv.count / 3);
  let flipped = 0;
  for (let t = 0; t < triCount; t++) {
    const a = idx ? idx.getX(t * 3) : t * 3;
    const b = idx ? idx.getX(t * 3 + 1) : t * 3 + 1;
    const c = idx ? idx.getX(t * 3 + 2) : t * 3 + 2;
    const au = uv.getX(a), av = uv.getY(a);
    const area2 = (uv.getX(b) - au) * (uv.getY(c) - av) - (uv.getX(c) - au) * (uv.getY(b) - av);
    if (area2 < -1e-9) flipped++;
  }
  return flipped;
}

export function computeUVStretch(geometry, mode = 'angle') {
  const posAttr = geometry?.attributes?.position;
  const uvAttr = geometry?.attributes?.uv;
  if (!posAttr || !uvAttr) return new Float32Array(0);
  const index = geometry.index;
  const triCount = index ? Math.floor(index.count / 3) : Math.floor(posAttr.count / 3);
  const scores = new Float32Array(triCount);

  const p0 = new THREE.Vector3();
  const p1 = new THREE.Vector3();
  const p2 = new THREE.Vector3();
  const e1 = new THREE.Vector3();
  const e2 = new THREE.Vector3();

  let totalArea3D = 0;
  let totalAreaUV = 0;
  const triA3 = new Float64Array(triCount);
  const triA2 = new Float64Array(triCount);

  for (let t = 0; t < triCount; t++) {
    const i0 = index ? index.getX(t * 3) : t * 3;
    const i1 = index ? index.getX(t * 3 + 1) : t * 3 + 1;
    const i2 = index ? index.getX(t * 3 + 2) : t * 3 + 2;
    p0.fromBufferAttribute(posAttr, i0);
    p1.fromBufferAttribute(posAttr, i1);
    p2.fromBufferAttribute(posAttr, i2);
    e1.subVectors(p1, p0);
    e2.subVectors(p2, p0);
    const a3 = 0.5 * e1.clone().cross(e2).length();
    triA3[t] = a3;
    totalArea3D += a3;

    const u0 = uvAttr.getX(i0), v0 = uvAttr.getY(i0);
    const u1 = uvAttr.getX(i1), v1 = uvAttr.getY(i1);
    const u2 = uvAttr.getX(i2), v2 = uvAttr.getY(i2);
    const a2 = 0.5 * Math.abs((u1 - u0) * (v2 - v0) - (u2 - u0) * (v1 - v0));
    triA2[t] = a2;
    totalAreaUV += a2;

    if (mode === 'angle') {
      const l3a = Math.max(1e-8, p0.distanceTo(p1));
      const l3b = Math.max(1e-8, p1.distanceTo(p2));
      const l3c = Math.max(1e-8, p2.distanceTo(p0));
      const l2a = Math.max(1e-8, Math.hypot(u1 - u0, v1 - v0));
      const l2b = Math.max(1e-8, Math.hypot(u2 - u1, v2 - v1));
      const l2c = Math.max(1e-8, Math.hypot(u0 - u2, v0 - v2));
      // Angle cosines difference invariant to global scale
      const cos3 = [
        (l3a * l3a + l3c * l3c - l3b * l3b) / (2 * l3a * l3c),
        (l3a * l3a + l3b * l3b - l3c * l3c) / (2 * l3a * l3b),
        (l3b * l3b + l3c * l3c - l3a * l3a) / (2 * l3b * l3c)
      ];
      const cos2 = [
        (l2a * l2a + l2c * l2c - l2b * l2b) / (2 * l2a * l2c),
        (l2a * l2a + l2b * l2b - l2c * l2c) / (2 * l2a * l2b),
        (l2b * l2b + l2c * l2c - l2a * l2a) / (2 * l2b * l2c)
      ];
      const err = (
        Math.abs(cos3[0] - cos2[0]) +
        Math.abs(cos3[1] - cos2[1]) +
        Math.abs(cos3[2] - cos2[2])
      ) / 1.5;
      scores[t] = Math.min(1, Math.max(0, err));
    }
  }

  if (mode === 'area') {
    const idealRatio = totalAreaUV / Math.max(1e-12, totalArea3D);
    for (let t = 0; t < triCount; t++) {
      if (triA3[t] <= 1e-12 || idealRatio <= 1e-12) {
        scores[t] = 1;
      } else {
        const rel = triA2[t] / (triA3[t] * idealRatio);
        const ratio = Math.max(rel, 1 / Math.max(1e-6, rel));
        scores[t] = Math.min(1, Math.max(0, Math.log2(ratio) * 0.5));
      }
    }
  }
  return scores;
}

/**
 * Generates an authentic Blender UV Color Grid or UV Checkerboard onto an offscreen/HTML Canvas.
 */
export function renderUVCheckerToCanvas(canvas, kind = 'color_grid', size = 512) {
  if (!canvas) return null;
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  const cells = 8;
  const step = size / cells;
  const palette = [
    '#3867d6', '#4b7bec', '#20bf6b', '#0fb9b1',
    '#fa8231', '#eb3b5a', '#8854d0', '#a55eea'
  ];

  for (let row = 0; row < cells; row++) {
    for (let col = 0; col < cells; col++) {
      const dark = (row + col) % 2 === 0;
      if (kind === 'color_grid') {
        ctx.fillStyle = dark ? '#2d2f34' : palette[(row * 3 + col) % palette.length];
      } else {
        ctx.fillStyle = dark ? '#222222' : '#cfcfcf';
      }
      ctx.fillRect(col * step, row * step, step, step);

      // 4x4 sub-grid inside each tile
      const sub = step / 4;
      ctx.strokeStyle = kind === 'color_grid' ? 'rgba(255,255,255,0.22)' : 'rgba(128,128,128,0.3)';
      ctx.lineWidth = 1;
      for (let s = 1; s < 4; s++) {
        ctx.beginPath();
        ctx.moveTo(col * step + s * sub, row * step);
        ctx.lineTo(col * step + s * sub, (row + 1) * step);
        ctx.moveTo(col * step, row * step + s * sub);
        ctx.lineTo((col + 1) * step, row * step + s * sub);
        ctx.stroke();
      }

      if (kind === 'color_grid') {
        const cx = col * step + step * 0.5;
        const cy = row * step + step * 0.5;
        ctx.fillStyle = 'rgba(255,255,255,0.88)';
        ctx.font = `bold ${Math.max(10, Math.floor(step * 0.28))}px monospace`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        const label = `${String.fromCharCode(65 + col)}${cells - row}`;
        ctx.fillText(label, cx, cy);
      }
    }
  }
  return canvas;
}
