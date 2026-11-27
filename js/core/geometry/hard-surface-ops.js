/**
 * @file hard-surface-ops.js
 * @description Pure, Worker-safe Blender hard-surface geometry operators:
 * - buildParametricCutterGeometry (Box / Cylinder / Sphere parametric Boolean cutters)
 * - decimateMesh (Collapse / Planar / Un-Subdivide polygon reduction preserving UVs & boundaries)
 * - screwMesh (360° Lathe revolution & helical screw extrusion around X / Y / Z)
 * - weightedNormalMesh (Face Area / Corner Angle weighted split normals for flat hard-surface shading)
 */

import * as THREE from 'three';
import { buildMeshTopology } from './mesh-topology.js';

// ---------------------------------------------------------------------------
// 1. PARAMETRIC BOOLEAN CUTTER BUILDER
// ---------------------------------------------------------------------------

/**
 * Builds a local-space BufferGeometry for a parametric Boolean cutter primitive.
 * @param {Object} [params]
 * @returns {THREE.BufferGeometry}
 */
export function buildParametricCutterGeometry(params = {}) {
  const shape = String(params.cutterPrimitive || 'box').toLowerCase();
  const s = Math.max(0.05, Number(params.cutterSize) || 1.0);
  const offset = params.cutterOffset || { x: 0.45, y: 0.45, z: 0.45 };
  const rotDeg = params.cutterRotation || { x: 0, y: 0, z: 0 };
  const scale = params.cutterScale || { x: 1, y: 1, z: 1 };

  let geom;
  if (shape === 'cylinder') {
    geom = new THREE.CylinderGeometry(s * 0.5, s * 0.5, s * 1.4, 24);
  } else if (shape === 'sphere') {
    geom = new THREE.SphereGeometry(s * 0.6, 24, 16);
  } else {
    geom = new THREE.BoxGeometry(s, s, s);
  }

  const pos = new THREE.Vector3(
    Number(offset.x) || 0,
    Number(offset.y) || 0,
    Number(offset.z) || 0
  );
  const euler = new THREE.Euler(
    THREE.MathUtils.degToRad(Number(rotDeg.x) || 0),
    THREE.MathUtils.degToRad(Number(rotDeg.y) || 0),
    THREE.MathUtils.degToRad(Number(rotDeg.z) || 0),
    'XYZ'
  );
  const quat = new THREE.Quaternion().setFromEuler(euler);
  const scl = new THREE.Vector3(
    Math.abs(Number(scale.x) || 1) < 1e-4 ? 1 : Number(scale.x) || 1,
    Math.abs(Number(scale.y) || 1) < 1e-4 ? 1 : Number(scale.y) || 1,
    Math.abs(Number(scale.z) || 1) < 1e-4 ? 1 : Number(scale.z) || 1
  );

  const mat = new THREE.Matrix4().compose(pos, quat, scl);
  geom.applyMatrix4(mat);
  geom.computeVertexNormals();
  geom.computeBoundingBox();
  geom.computeBoundingSphere();
  return geom;
}

// ---------------------------------------------------------------------------
// 2. DECIMATE OPERATOR (Collapse / Planar / Un-Subdivide)
// ---------------------------------------------------------------------------

class MinHeap {
  constructor() {
    this.items = [];
  }
  get size() {
    return this.items.length;
  }
  push(item) {
    this.items.push(item);
    this._siftUp(this.items.length - 1);
  }
  pop() {
    const top = this.items[0];
    const last = this.items.pop();
    if (this.items.length > 0) {
      this.items[0] = last;
      this._siftDown(0);
    }
    return top;
  }
  _siftUp(i) {
    const items = this.items;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (items[p].cost <= items[i].cost) break;
      const tmp = items[p];
      items[p] = items[i];
      items[i] = tmp;
      i = p;
    }
  }
  _siftDown(i) {
    const items = this.items;
    const n = items.length;
    while (true) {
      let best = i;
      const l = i * 2 + 1;
      const r = i * 2 + 2;
      if (l < n && items[l].cost < items[best].cost) best = l;
      if (r < n && items[r].cost < items[best].cost) best = r;
      if (best === i) break;
      const tmp = items[best];
      items[best] = items[i];
      items[i] = tmp;
      i = best;
    }
  }
}

function edgePairKey(a, b) {
  return a < b ? `${a}_${b}` : `${b}_${a}`;
}

function triangleNormal(positions, a, b, c, out = new THREE.Vector3()) {
  const pa = positions[a];
  const pb = positions[b];
  const pc = positions[c];
  const abx = pb.x - pa.x, aby = pb.y - pa.y, abz = pb.z - pa.z;
  const acx = pc.x - pa.x, acy = pc.y - pa.y, acz = pc.z - pa.z;
  out.set(
    aby * acz - abz * acy,
    abz * acx - abx * acz,
    abx * acy - aby * acx
  );
  const len = out.length();
  if (len > 1e-12) out.divideScalar(len);
  else out.set(0, 0, 0);
  return out;
}

/**
 * Reduces mesh triangle count via edge collapse, planar dissolution, or un-subdivide.
 * Preserves sharp corners, optional boundary perimeters, and UVs.
 * @param {THREE.BufferGeometry} geometry
 * @param {Object} [params]
 * @returns {THREE.BufferGeometry}
 */
export function decimateMesh(geometry, params = {}) {
  if (!geometry?.attributes?.position) return geometry;

  const mode = String(params.mode || 'collapse').toLowerCase();
  const ratio = THREE.MathUtils.clamp(
    params.ratio !== undefined ? Number(params.ratio) : 0.5,
    0.05,
    1.0
  );
  const angleLimitDeg = THREE.MathUtils.clamp(
    params.angleLimitDeg !== undefined ? Number(params.angleLimitDeg) : 15,
    0.1,
    179
  );
  const iterations = Math.max(1, Math.min(4, Math.round(Number(params.iterations) || 1)));
  const preserveBoundaries = params.preserveBoundaries !== false;

  const posAttr = geometry.attributes.position;
  const uvAttr = geometry.attributes.uv || null;
  const colAttr = geometry.attributes.color || null;
  const index = geometry.index;
  const rawTriCount = Math.floor((index ? index.count : posAttr.count) / 3);
  if (rawTriCount <= 4) return geometry.clone();
  if (mode === 'collapse' && ratio >= 0.999) return geometry.clone();

  // Weld coincident positions (1e-4 tolerance) into unique geometric vertices
  const weldMap = new Map();
  const positions = [];
  const rawToWelded = new Uint32Array(posAttr.count);
  for (let i = 0; i < posAttr.count; i++) {
    const x = posAttr.getX(i);
    const y = posAttr.getY(i);
    const z = posAttr.getZ(i);
    const key = `${Math.round(x * 1e4)},${Math.round(y * 1e4)},${Math.round(z * 1e4)}`;
    let wid = weldMap.get(key);
    if (wid === undefined) {
      wid = positions.length;
      positions.push(new THREE.Vector3(x, y, z));
      weldMap.set(key, wid);
    }
    rawToWelded[i] = wid;
  }

  const vertCount = positions.length;
  const tris = [];
  const vertTris = Array.from({ length: vertCount }, () => new Set());
  const tmpN = new THREE.Vector3();

  for (let t = 0; t < rawTriCount; t++) {
    const c0 = index ? index.getX(t * 3) : t * 3;
    const c1 = index ? index.getX(t * 3 + 1) : t * 3 + 1;
    const c2 = index ? index.getX(t * 3 + 2) : t * 3 + 2;
    const v0 = rawToWelded[c0];
    const v1 = rawToWelded[c1];
    const v2 = rawToWelded[c2];
    if (v0 === v1 || v1 === v2 || v2 === v0) continue;

    const ti = tris.length;
    const uv = uvAttr
      ? [
          new THREE.Vector2(uvAttr.getX(c0), uvAttr.getY(c0)),
          new THREE.Vector2(uvAttr.getX(c1), uvAttr.getY(c1)),
          new THREE.Vector2(uvAttr.getX(c2), uvAttr.getY(c2)),
        ]
      : null;
    const color = colAttr
      ? [
          new THREE.Vector3(colAttr.getX(c0), colAttr.getY(c0), colAttr.getZ(c0)),
          new THREE.Vector3(colAttr.getX(c1), colAttr.getY(c1), colAttr.getZ(c1)),
          new THREE.Vector3(colAttr.getX(c2), colAttr.getY(c2), colAttr.getZ(c2)),
        ]
      : null;
    const normal = triangleNormal(positions, v0, v1, v2, new THREE.Vector3());
    if (normal.lengthSq() < 1e-12) continue;
    tris.push({ v: [v0, v1, v2], uv, color, normal, deleted: false });
    vertTris[v0].add(ti);
    vertTris[v1].add(ti);
    vertTris[v2].add(ti);
  }

  let survivingTris = tris.length;
  if (survivingTris <= 4) return geometry.clone();

  let targetTris;
  if (mode === 'unsubdivide') {
    targetTris = Math.max(4, Math.round(survivingTris * Math.pow(0.5, iterations)));
  } else if (mode === 'planar') {
    targetTris = 4;
  } else {
    targetTris = Math.max(4, Math.round(survivingTris * ratio));
  }

  const cosPlanar = Math.cos(THREE.MathUtils.degToRad(angleLimitDeg));

  // Count edge occurrences initially to detect boundary vertices & crease complexity
  const isBoundaryVertex = (vi) => {
    const edgeCounts = new Map();
    for (const ti of vertTris[vi]) {
      const tri = tris[ti];
      if (tri.deleted) continue;
      for (let k = 0; k < 3; k++) {
        const a = tri.v[k];
        const b = tri.v[(k + 1) % 3];
        if (a !== vi && b !== vi) continue;
        const other = a === vi ? b : a;
        edgeCounts.set(other, (edgeCounts.get(other) || 0) + 1);
      }
    }
    for (const count of edgeCounts.values()) {
      if (count === 1) return true;
    }
    return false;
  };

  const countDistinctPlanes = (vi) => {
    const planes = [];
    for (const ti of vertTris[vi]) {
      const tri = tris[ti];
      if (tri.deleted || tri.normal.lengthSq() < 0.5) continue;
      if (!planes.some((n) => n.dot(tri.normal) > 0.996)) {
        planes.push(tri.normal);
      }
    }
    return planes.length;
  };

  const vertexVariancePenalty = (vi) => {
    const list = [];
    for (const ti of vertTris[vi]) {
      const tri = tris[ti];
      if (!tri.deleted && tri.normal.lengthSq() > 0.5) list.push(tri.normal);
    }
    if (list.length <= 1) return 0;
    let minDot = 1;
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const d = list[i].dot(list[j]);
        if (d < minDot) minDot = d;
      }
    }
    return Math.max(0, 1 - minDot);
  };

  const vertVersion = new Uint32Array(vertCount);
  const vertRedirect = new Int32Array(vertCount).fill(-1);
  const heap = new MinHeap();

  const evaluateEdge = (u, v) => {
    if (u === v || vertRedirect[u] !== -1 || vertRedirect[v] !== -1) return null;

    const uBound = isBoundaryVertex(u);
    const vBound = isBoundaryVertex(v);
    if (preserveBoundaries && uBound !== vBound && mode !== 'planar') return null;

    // Collect shared triangles and planar compatibility
    const shared = [];
    for (const ti of vertTris[u]) {
      const tri = tris[ti];
      if (!tri.deleted && tri.v.includes(v)) shared.push(ti);
    }
    if (shared.length === 0) return null;

    if (mode === 'planar') {
      if (shared.length > 2) return null;
      if (shared.length === 2) {
        if (tris[shared[0]].normal.dot(tris[shared[1]].normal) < cosPlanar) return null;
      }
      // For planar dissolution, pick which endpoint stays fixed so corners stay crisp
      const pU = countDistinctPlanes(u);
      const pV = countDistinctPlanes(v);
      let keep = u;
      let drop = v;
      if (pV > pU || (pV === pU && vBound && !uBound)) {
        keep = v;
        drop = u;
      }
      // Check that collapsing drop -> keep won't change plane of any face touching drop
      const targetPos = positions[keep];
      const dropPlanes = [];
      for (const ti of vertTris[drop]) {
        const tri = tris[ti];
        if (!tri.deleted) dropPlanes.push(tri.normal);
      }
      if (shared.length === 1 && dropPlanes.length > 1) {
        // Boundary edge: only collapse if incident faces are coplanar and boundary is colinear
        for (let i = 1; i < dropPlanes.length; i++) {
          if (dropPlanes[0].dot(dropPlanes[i]) < cosPlanar) return null;
        }
      }
      // Check adjacent faces of drop against targetPos
      for (const ti of vertTris[drop]) {
        const tri = tris[ti];
        if (tri.deleted || tri.v.includes(keep)) continue;
        const idxDrop = tri.v.indexOf(drop);
        const i0 = idxDrop === 0 ? keep : tri.v[0];
        const i1 = idxDrop === 1 ? keep : tri.v[1];
        const i2 = idxDrop === 2 ? keep : tri.v[2];
        // Substitute vertex position test
        const oldPosDrop = positions[drop];
        positions[drop] = targetPos;
        triangleNormal(positions, tri.v[0], tri.v[1], tri.v[2], tmpN);
        positions[drop] = oldPosDrop;
        if (tmpN.lengthSq() < 0.5 || tri.normal.dot(tmpN) < cosPlanar) return null;
        if (i0 === i1 || i1 === i2 || i2 === i0) return null;
      }
      const lenSq = positions[keep].distanceToSquared(positions[drop]);
      return { keep, drop, useMidpoint: false, cost: lenSq };
    }

    // Collapse / un-subdivide mode: determine target placement
    const pU = countDistinctPlanes(u);
    const pV = countDistinctPlanes(v);
    let keep = u;
    let drop = v;
    let useMidpoint = true;
    if (preserveBoundaries && (uBound || vBound)) {
      if (uBound && vBound) {
        if (pV > pU) { keep = v; drop = u; }
        useMidpoint = pU <= 1 && pV <= 1;
      } else {
        return null;
      }
    } else if (pU > pV) {
      keep = u;
      drop = v;
      useMidpoint = false;
    } else if (pV > pU) {
      keep = v;
      drop = u;
      useMidpoint = false;
    } else if (pU >= 3 || pV >= 3) {
      useMidpoint = false;
    }

    const edgeLenSq = positions[u].distanceToSquared(positions[v]);
    const penalty = (vertexVariancePenalty(u) + vertexVariancePenalty(v)) * 0.5;
    const cost = edgeLenSq * (1.0 + penalty * 8.0);
    return { keep, drop, useMidpoint, cost };
  };

  const pushEdgesForVertex = (vi, seenEdges = null) => {
    for (const ti of vertTris[vi]) {
      const tri = tris[ti];
      if (tri.deleted) continue;
      for (let k = 0; k < 3; k++) {
        const a = tri.v[k];
        const b = tri.v[(k + 1) % 3];
        if (a === b) continue;
        const key = edgePairKey(a, b);
        if (seenEdges) {
          if (seenEdges.has(key)) continue;
          seenEdges.add(key);
        }
        const cand = evaluateEdge(a, b);
        if (cand) {
          heap.push({
            ...cand,
            vKeep: vertVersion[cand.keep],
            vDrop: vertVersion[cand.drop],
          });
        }
      }
    }
  };

  const seenInitial = new Set();
  for (let vi = 0; vi < vertCount; vi++) {
    pushEdgesForVertex(vi, seenInitial);
  }

  const testPos = new THREE.Vector3();
  const minNormalDot = mode === 'planar' ? cosPlanar : 0.17;

  while (survivingTris > targetTris && heap.size > 0) {
    const item = heap.pop();
    const { keep, drop, useMidpoint, vKeep, vDrop } = item;
    if (vertRedirect[keep] !== -1 || vertRedirect[drop] !== -1) continue;
    if (vertVersion[keep] !== vKeep || vertVersion[drop] !== vDrop) continue;

    // Re-check shared tris count wouldn't drop below 4
    let deadCount = 0;
    for (const ti of vertTris[drop]) {
      const tri = tris[ti];
      if (!tri.deleted && tri.v.includes(keep)) deadCount++;
    }
    if (deadCount === 0 || survivingTris - deadCount < 4) continue;

    // Compute candidate target coordinate
    if (useMidpoint) {
      testPos.copy(positions[keep]).add(positions[drop]).multiplyScalar(0.5);
    } else {
      testPos.copy(positions[keep]);
    }

    // Validate no normal flip / fold on all surviving incident triangles of keep and drop
    const oldKeep = positions[keep].clone();
    const oldDrop = positions[drop].clone();
    positions[keep].copy(testPos);
    positions[drop].copy(testPos);

    let flipInvalid = false;
    const checkSet = [vertTris[keep], vertTris[drop]];
    for (const tset of checkSet) {
      for (const ti of tset) {
        const tri = tris[ti];
        if (tri.deleted) continue;
        const a = tri.v[0], b = tri.v[1], c = tri.v[2];
        if ((a === keep || a === drop) && (b === keep || b === drop || c === keep || c === drop)) {
          if (
            ((a === keep || a === drop) ? 1 : 0) +
            ((b === keep || b === drop) ? 1 : 0) +
            ((c === keep || c === drop) ? 1 : 0) >= 2
          ) {
            continue; // This triangle collapses and will be deleted
          }
        }
        triangleNormal(positions, a, b, c, tmpN);
        if (tmpN.lengthSq() < 0.5 || tri.normal.dot(tmpN) < minNormalDot) {
          flipInvalid = true;
          break;
        }
      }
      if (flipInvalid) break;
    }

    if (flipInvalid) {
      positions[keep].copy(oldKeep);
      positions[drop].copy(oldDrop);
      continue;
    }

    // Commit collapse: drop -> keep
    vertRedirect[drop] = keep;
    vertVersion[keep]++;
    vertVersion[drop]++;

    const touchedVerts = new Set([keep]);
    const dropList = Array.from(vertTris[drop]);
    for (const ti of dropList) {
      const tri = tris[ti];
      if (tri.deleted) continue;
      if (tri.v.includes(keep)) {
        tri.deleted = true;
        survivingTris--;
        for (const tv of tri.v) {
          if (tv !== keep && tv !== drop) vertTris[tv].delete(ti);
        }
        continue;
      }
      // Rewrite drop -> keep and interpolate UV if midpoint
      for (let k = 0; k < 3; k++) {
        if (tri.v[k] === drop) {
          tri.v[k] = keep;
        }
        touchedVerts.add(tri.v[k]);
      }
      vertTris[keep].add(ti);
    }
    vertTris[drop].clear();

    // Update surviving triangle normals around keep
    for (const ti of vertTris[keep]) {
      const tri = tris[ti];
      if (tri.deleted) continue;
      triangleNormal(positions, tri.v[0], tri.v[1], tri.v[2], tri.normal);
      for (const tv of tri.v) touchedVerts.add(tv);
    }

    // Re-queue adjacent edges for affected vertices
    const requeued = new Set();
    for (const tv of touchedVerts) {
      pushEdgesForVertex(tv, requeued);
    }
  }

  // Emit surviving non-indexed BufferGeometry
  const outPos = [];
  const outUv = uvAttr ? [] : null;
  const outCol = colAttr ? [] : null;
  for (const tri of tris) {
    if (tri.deleted) continue;
    for (let k = 0; k < 3; k++) {
      const p = positions[tri.v[k]];
      outPos.push(p.x, p.y, p.z);
      if (outUv && tri.uv) {
        outUv.push(tri.uv[k].x, tri.uv[k].y);
      }
      if (outCol && tri.color) {
        outCol.push(tri.color[k].x, tri.color[k].y, tri.color[k].z);
      }
    }
  }

  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(outPos, 3));
  if (outUv && outUv.length === (outPos.length / 3) * 2) {
    out.setAttribute('uv', new THREE.Float32BufferAttribute(outUv, 2));
  }
  if (outCol && outCol.length === outPos.length) {
    out.setAttribute('color', new THREE.Float32BufferAttribute(outCol, 3));
  }
  out.computeVertexNormals();
  out.computeBoundingBox();
  out.computeBoundingSphere();
  return out;
}

// ---------------------------------------------------------------------------
// 3. SCREW / LATHE OPERATOR
// ---------------------------------------------------------------------------

/**
 * Extracts clean profile edge segments [Vector3, Vector3] from a BufferGeometry.
 */
function extractScrewProfile(geometry, axis) {
  const posAttr = geometry.attributes.position;
  const index = geometry.index;
  const triCount = Math.floor((index ? index.count : posAttr.count) / 3);
  const topo = buildMeshTopology(geometry);

  const rawEdges = topo.boundaryEdges && topo.boundaryEdges.length > 0
    ? topo.boundaryEdges
    : topo.edges || [];

  const getP = (vi) => new THREE.Vector3(posAttr.getX(vi), posAttr.getY(vi), posAttr.getZ(vi));
  const segs = [];

  if (topo.boundaryEdges && topo.boundaryEdges.length > 0) {
    for (const e of topo.boundaryEdges) {
      segs.push([getP(e.v0), getP(e.v1)]);
    }
    return segs;
  }

  // Closed mesh: skip coplanar quad diagonals (2 incident triangles with dot > 0.999)
  const triNormal = (t) => {
    const i0 = index ? index.getX(t * 3) : t * 3;
    const i1 = index ? index.getX(t * 3 + 1) : t * 3 + 1;
    const i2 = index ? index.getX(t * 3 + 2) : t * 3 + 2;
    const a = getP(i0), b = getP(i1), c = getP(i2);
    return new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a)).normalize();
  };

  for (const e of rawEdges) {
    if (e.faces && e.faces.length === 2 && e.faces[0] < triCount && e.faces[1] < triCount) {
      const n0 = triNormal(e.faces[0]);
      const n1 = triNormal(e.faces[1]);
      if (n0.dot(n1) > 0.999) continue; // Internal coplanar quad diagonal
    }
    segs.push([getP(e.v0), getP(e.v1)]);
  }

  // Keep high-poly closed sources bounded to a manageable profile
  if (segs.length > 24) {
    const axKey = axis === 'X' ? 'x' : axis === 'Z' ? 'z' : 'y';
    segs.sort((sA, sB) => {
      const yA = (sA[0][axKey] + sA[1][axKey]) * 0.5;
      const yB = (sB[0][axKey] + sB[1][axKey]) * 0.5;
      return yA - yB;
    });
    return segs.slice(0, 24);
  }

  return segs;
}

/**
 * Revolves and/or helically extrudes a mesh profile around X, Y, or Z axis.
 * @param {THREE.BufferGeometry} geometry
 * @param {Object} [params]
 * @returns {THREE.BufferGeometry}
 */
export function screwMesh(geometry, params = {}) {
  if (!geometry?.attributes?.position) return geometry;

  const axis = String(params.axis || 'Y').toUpperCase();
  const angleDeg = THREE.MathUtils.clamp(
    params.angleDeg !== undefined ? Number(params.angleDeg) : 360,
    1,
    360
  );
  const steps = Math.max(3, Math.min(128, Math.round(Number(params.steps) || 16)));
  const iterations = Math.max(1, Math.min(12, Math.round(Number(params.iterations) || 1)));
  const screwOffset = Number(params.screwOffset) || 0;
  const radiusOffset = Number(params.radiusOffset) || 0;
  const flipNormals = !!params.flipNormals;

  const segs = extractScrewProfile(geometry, axis);
  if (segs.length === 0) return geometry.clone();

  const axisVec = axis === 'X'
    ? new THREE.Vector3(1, 0, 0)
    : axis === 'Z'
      ? new THREE.Vector3(0, 0, 1)
      : new THREE.Vector3(0, 1, 0);
  const radialShiftAxis = axis === 'X'
    ? new THREE.Vector3(0, 1, 0)
    : new THREE.Vector3(1, 0, 0);

  // Measure radial span around the axis to handle centered primitives gracefully
  let minAxPerp = Infinity, maxAxPerp = -Infinity;
  for (const [p0, p1] of segs) {
    for (const p of [p0, p1]) {
      const v = axis === 'X' ? p.y : p.x;
      if (v < minAxPerp) minAxPerp = v;
      if (v > maxAxPerp) maxAxPerp = v;
    }
  }
  const centeredLatheShift = (
    Math.abs(radiusOffset) <= 1e-6 &&
    Math.abs(screwOffset) <= 1e-6 &&
    minAxPerp < -0.01 &&
    maxAxPerp > 0.01
  )
    ? (maxAxPerp - minAxPerp) * 0.6
    : 0;

  if (Math.abs(radiusOffset) > 1e-6 || centeredLatheShift > 0) {
    for (const [p0, p1] of segs) {
      for (const p of [p0, p1]) {
        const rx = axis === 'X' ? 0 : p.x;
        const ry = axis === 'Y' ? 0 : p.y;
        const rz = axis === 'Z' ? 0 : p.z;
        const rLen = Math.hypot(rx, ry, rz);
        if (Math.abs(radiusOffset) > 1e-6) {
          if (rLen > 1e-6) {
            p.x += (rx / rLen) * radiusOffset;
            p.y += (ry / rLen) * radiusOffset;
            p.z += (rz / rLen) * radiusOffset;
          } else {
            p.addScaledVector(radialShiftAxis, radiusOffset);
          }
        }
        if (centeredLatheShift > 0) {
          p.addScaledVector(radialShiftAxis, centeredLatheShift);
        }
      }
    }
  }

  const totalSteps = Math.max(3, Math.min(256, steps * iterations));
  const totalAngle = THREE.MathUtils.degToRad(angleDeg) * iterations;
  const totalShift = screwOffset * iterations;
  const weldFullTurn = Math.abs(totalAngle - Math.PI * 2) < 1e-4 && Math.abs(totalShift) < 1e-5;

  const positions = [];
  const uvs = [];
  const quatA = new THREE.Quaternion();
  const quatB = new THREE.Quaternion();
  const a0 = new THREE.Vector3();
  const b0 = new THREE.Vector3();
  const a1 = new THREE.Vector3();
  const b1 = new THREE.Vector3();

  const segCount = segs.length;
  for (let si = 0; si < totalSteps; si++) {
    const t0 = si / totalSteps;
    const t1 = (si + 1) / totalSteps;
    const ang0 = t0 * totalAngle;
    const ang1 = (weldFullTurn && si === totalSteps - 1) ? 0 : t1 * totalAngle;
    const shift0 = t0 * totalShift;
    const shift1 = t1 * totalShift;

    quatA.setFromAxisAngle(axisVec, ang0);
    quatB.setFromAxisAngle(axisVec, ang1);

    for (let j = 0; j < segCount; j++) {
      const [p0, p1] = segs[j];
      const v0 = j / segCount;
      const v1 = (j + 1) / segCount;

      a0.copy(p0).applyQuaternion(quatA).addScaledVector(axisVec, shift0);
      b0.copy(p1).applyQuaternion(quatA).addScaledVector(axisVec, shift0);
      a1.copy(p0).applyQuaternion(quatB).addScaledVector(axisVec, shift1);
      b1.copy(p1).applyQuaternion(quatB).addScaledVector(axisVec, shift1);

      if (!flipNormals) {
        positions.push(
          a0.x, a0.y, a0.z, b0.x, b0.y, b0.z, b1.x, b1.y, b1.z,
          a0.x, a0.y, a0.z, b1.x, b1.y, b1.z, a1.x, a1.y, a1.z
        );
        uvs.push(t0, v0, t0, v1, t1, v1, t0, v0, t1, v1, t1, v0);
      } else {
        positions.push(
          a0.x, a0.y, a0.z, b1.x, b1.y, b1.z, b0.x, b0.y, b0.z,
          a0.x, a0.y, a0.z, a1.x, a1.y, a1.z, b1.x, b1.y, b1.z
        );
        uvs.push(t0, v0, t1, v1, t0, v1, t0, v0, t1, v0, t1, v1);
      }
    }
  }

  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  out.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  out.computeVertexNormals();
  out.computeBoundingBox();
  out.computeBoundingSphere();
  return out;
}

// ---------------------------------------------------------------------------
// 4. WEIGHTED NORMAL OPERATOR (Blender Weighted Normal Parity)
// ---------------------------------------------------------------------------

/**
 * Computes area- and corner-angle-weighted split vertex normals so large flat
 * faces remain flat-shaded while small bevel chamfers shade smoothly.
 * @param {THREE.BufferGeometry} geometry
 * @param {Object} [params]
 * @returns {THREE.BufferGeometry}
 */
export function weightedNormalMesh(geometry, params = {}) {
  if (!geometry?.attributes?.position) return geometry;

  const mode = String(params.mode || 'face_area_and_angle').toLowerCase();
  const weight = THREE.MathUtils.clamp(
    params.weight !== undefined ? Number(params.weight) : 50,
    1,
    100
  );
  const keepSharp = params.keepSharp !== false;
  const thresholdDeg = THREE.MathUtils.clamp(
    params.thresholdDeg !== undefined ? Number(params.thresholdDeg) : 30,
    1,
    180
  );

  const src = geometry.index ? geometry.toNonIndexed() : geometry.clone();
  src.userData = { ...(geometry.userData || {}) };

  const pos = src.attributes.position;
  const numTris = Math.floor(pos.count / 3);
  if (numTris === 0) return src;

  const faceNormals = new Float32Array(numTris * 3);
  const faceAreas = new Float32Array(numTris);
  const cornerAngles = new Float32Array(pos.count);

  const p0 = new THREE.Vector3(), p1 = new THREE.Vector3(), p2 = new THREE.Vector3();
  const e01 = new THREE.Vector3(), e02 = new THREE.Vector3(), e12 = new THREE.Vector3();
  const cross = new THREE.Vector3();

  for (let t = 0; t < numTris; t++) {
    p0.fromBufferAttribute(pos, t * 3 + 0);
    p1.fromBufferAttribute(pos, t * 3 + 1);
    p2.fromBufferAttribute(pos, t * 3 + 2);

    e01.subVectors(p1, p0);
    e02.subVectors(p2, p0);
    e12.subVectors(p2, p1);

    cross.crossVectors(e01, e02);
    const doubleArea = cross.length();
    faceAreas[t] = doubleArea * 0.5;
    if (doubleArea > 1e-12) cross.divideScalar(doubleArea);
    else cross.set(0, 1, 0);

    faceNormals[t * 3 + 0] = cross.x;
    faceNormals[t * 3 + 1] = cross.y;
    faceNormals[t * 3 + 2] = cross.z;

    const l01 = e01.length() || 1e-9;
    const l02 = e02.length() || 1e-9;
    const l12 = e12.length() || 1e-9;
    cornerAngles[t * 3 + 0] = Math.acos(THREE.MathUtils.clamp(e01.dot(e02) / (l01 * l02), -1, 1));
    cornerAngles[t * 3 + 1] = Math.acos(THREE.MathUtils.clamp((-e01.dot(e12)) / (l01 * l12), -1, 1));
    cornerAngles[t * 3 + 2] = Math.acos(THREE.MathUtils.clamp(e02.dot(e12) / (l02 * l12), -1, 1));
  }

  // Spatial hash for coincident vertex corners (1e-4 tolerance)
  const coordMap = new Map();
  for (let i = 0; i < pos.count; i++) {
    const key = `${Math.round(pos.getX(i) * 1e4)}_${Math.round(pos.getY(i) * 1e4)}_${Math.round(pos.getZ(i) * 1e4)}`;
    let list = coordMap.get(key);
    if (!list) {
      list = [];
      coordMap.set(key, list);
    }
    list.push(i);
  }

  const exponent = Math.max(0.2, (weight / 50) * 3.0);
  const cosThresh = keepSharp ? Math.cos(THREE.MathUtils.degToRad(thresholdDeg)) : -1.0;
  const outNormals = new Float32Array(pos.count * 3);

  for (const corners of coordMap.values()) {
    for (const cIdx of corners) {
      const myTri = Math.floor(cIdx / 3);
      const myNx = faceNormals[myTri * 3 + 0];
      const myNy = faceNormals[myTri * 3 + 1];
      const myNz = faceNormals[myTri * 3 + 2];

      let ax = 0, ay = 0, az = 0;
      for (const otherIdx of corners) {
        const oTri = Math.floor(otherIdx / 3);
        const oNx = faceNormals[oTri * 3 + 0];
        const oNy = faceNormals[oTri * 3 + 1];
        const oNz = faceNormals[oTri * 3 + 2];

        const dot = myNx * oNx + myNy * oNy + myNz * oNz;
        if (dot < cosThresh) continue;

        const area = faceAreas[oTri] + 1e-8;
        const angle = cornerAngles[otherIdx] + 1e-6;
        let baseW;
        if (mode === 'face_area') baseW = area;
        else if (mode === 'corner_angle') baseW = angle;
        else baseW = area * angle;

        const w = Math.pow(baseW, exponent);
        ax += oNx * w;
        ay += oNy * w;
        az += oNz * w;
      }

      const len = Math.hypot(ax, ay, az);
      if (len > 1e-12) {
        outNormals[cIdx * 3 + 0] = ax / len;
        outNormals[cIdx * 3 + 1] = ay / len;
        outNormals[cIdx * 3 + 2] = az / len;
      } else {
        outNormals[cIdx * 3 + 0] = myNx;
        outNormals[cIdx * 3 + 1] = myNy;
        outNormals[cIdx * 3 + 2] = myNz;
      }
    }
  }

  src.setAttribute('normal', new THREE.BufferAttribute(outNormals, 3));
  src.computeBoundingBox();
  src.computeBoundingSphere();
  return src;
}
