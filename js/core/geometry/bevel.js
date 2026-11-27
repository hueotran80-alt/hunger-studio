/**
 * @file bevel.js
 * @description Blender-parity True Polygon Bevel Operator & Modifier Engine.
 *
 * Operates on reconstructed planar polygonal faces (quads / n-gons) rather than
 * raw triangles so coplanar internal diagonals are never split open:
 * - True edge chamfering between adjacent polygonal faces (1 to 8 segments)
 * - Superellipse circular/elliptical profile (0.5 = circular, <0.5 concave, >0.5 convex)
 * - Overlap clamping (clampOverlap = true) preventing self-intersection
 * - Angle limit threshold (limitMethod = 'angle', angleLimitDeg)
 * - Partial-edge corner splits (un-beveled adjacent faces absorb bevel ends as N-gons)
 * - Watertight corner miters (subdivided spherical/barycentric grid for 3+ beveled edges)
 * - Harden normals / Auto-smooth bevel shading & UV interpolation
 */

import * as THREE from 'three';

/**
 * Spatial edge key invariant to vertex indexing/order.
 */
export function bevelEdgeCoordKey(v0, v1) {
  const k0 = `${Math.round(v0.x * 100000)},${Math.round(v0.y * 100000)},${Math.round(v0.z * 100000)}`;
  const k1 = `${Math.round(v1.x * 100000)},${Math.round(v1.y * 100000)},${Math.round(v1.z * 100000)}`;
  return k0 < k1 ? `${k0}|${k1}` : `${k1}|${k0}`;
}

function coordKey(x, y, z) {
  return `${Math.round(x * 100000)},${Math.round(y * 100000)},${Math.round(z * 100000)}`;
}

function edgePairKey(a, b) {
  return a < b ? `${a}_${b}` : `${b}_${a}`;
}

function computePolygonNormal(verts, weldedVertices) {
  const n = new THREE.Vector3();
  const a = weldedVertices[verts[0]];
  for (let k = 1; k + 1 < verts.length; k++) {
    const b = weldedVertices[verts[k]];
    const c = weldedVertices[verts[k + 1]];
    const e1 = new THREE.Vector3().subVectors(b, a);
    const e2 = new THREE.Vector3().subVectors(c, a);
    n.add(new THREE.Vector3().crossVectors(e1, e2));
  }
  const len = n.length();
  return len > 1e-12 ? n.divideScalar(len) : new THREE.Vector3(0, 1, 0);
}

function isSimpleConvexOrQuasiPlanar(verts, weldedVertices, normal) {
  if (verts.length < 3) return false;
  if (new Set(verts).size !== verts.length) return false;
  let posSigns = 0;
  let negSigns = 0;
  const e1 = new THREE.Vector3();
  const e2 = new THREE.Vector3();
  const cr = new THREE.Vector3();
  for (let k = 0; k < verts.length; k++) {
    const p0 = weldedVertices[verts[(k - 1 + verts.length) % verts.length]];
    const p1 = weldedVertices[verts[k]];
    const p2 = weldedVertices[verts[(k + 1) % verts.length]];
    e1.subVectors(p1, p0);
    e2.subVectors(p2, p1);
    cr.crossVectors(e1, e2);
    const d = cr.dot(normal);
    if (d > 1e-7) posSigns++;
    else if (d < -1e-7) negSigns++;
  }
  // Keep merged polygons convex (prevents twisting across rings/holes)
  return !(posSigns > 0 && negSigns > 0);
}

/**
 * Merges coplanar adjacent triangles into clean convex polygonal faces (quads, n-gons)
 * while respecting explicitly selected edges (when beveling internal seam/subdiv edges).
 */
function buildPlanarPolygons(triVerts, triUVs, weldedVertices, selectedSet) {
  const numTris = Math.floor(triVerts.length / 3);
  const faces = [];

  for (let t = 0; t < numTris; t++) {
    const i0 = triVerts[t * 3 + 0];
    const i1 = triVerts[t * 3 + 1];
    const i2 = triVerts[t * 3 + 2];
    if (i0 === i1 || i1 === i2 || i2 === i0) continue;
    const vs = [i0, i1, i2];
    const normal = computePolygonNormal(vs, weldedVertices);
    faces.push({
      id: faces.length,
      verts: vs,
      uvs: triUVs[t] ? triUVs[t].map(u => u.clone()) : null,
      normal,
      alive: true
    });
  }

  // Merge coplanar pairs starting with best-scoring quad pairs first (rectangularity + index proximity),
  // then convex n-gon merges (e.g. cylinder circular caps).
  const candidatePairs = [];
  const edgeMap = new Map();
  for (let fi = 0; fi < faces.length; fi++) {
    const vs = faces[fi].verts;
    for (let k = 0; k < 3; k++) {
      const u = vs[k];
      const v = vs[(k + 1) % 3];
      const key = edgePairKey(u, v);
      if (!edgeMap.has(key)) edgeMap.set(key, []);
      edgeMap.get(key).push({ fi, u, v });
    }
  }

  for (const [, list] of edgeMap.entries()) {
    if (list.length !== 2) continue;
    const a = list[0];
    const b = list[1];
    if (a.fi === b.fi) continue;
    // Must have opposite directed edge winding (manifold)
    if (!(a.u === b.v && a.v === b.u)) continue;
    const fA = faces[a.fi];
    const fB = faces[b.fi];
    if (fA.normal.dot(fB.normal) <= 0.9999) continue;

    if (selectedSet && selectedSet.has(bevelEdgeCoordKey(weldedVertices[a.u], weldedVertices[a.v]))) {
      continue;
    }

    // Score rectangularity: opposite vertices should have ~90° corner angles & diagonal >= sides
    const wA = fA.verts.find(x => x !== a.u && x !== a.v);
    const wB = fB.verts.find(x => x !== a.u && x !== a.v);
    if (wA === undefined || wB === undefined || wA === wB) continue;

    const pU = weldedVertices[a.u];
    const pV = weldedVertices[a.v];
    const pA = weldedVertices[wA];
    const pB = weldedVertices[wB];
    const diagSq = pU.distanceToSquared(pV);
    const d1 = new THREE.Vector3().subVectors(pU, pA).normalize();
    const d2 = new THREE.Vector3().subVectors(pV, pA).normalize();
    const rectScore = 1.0 - Math.abs(d1.dot(d2)); // 1.0 when 90 degrees
    const maxSideSq = Math.max(
      pA.distanceToSquared(pU), pA.distanceToSquared(pV),
      pB.distanceToSquared(pU), pB.distanceToSquared(pV)
    );
    const diagBonus = diagSq > maxSideSq * 1.02 ? 2.0 : 0.0;
    const orderBonus = Math.abs(a.fi - b.fi) === 1 ? 1.0 : 0.0;

    candidatePairs.push({
      fiA: a.fi,
      fiB: b.fi,
      u: a.u,
      v: a.v,
      score: diagBonus + rectScore + orderBonus
    });
  }

  candidatePairs.sort((x, y) => y.score - x.score);

  const spliceFaces = (fA, fB, u, v) => {
    const va = fA.verts;
    const vb = fB.verts;
    const iuA = va.indexOf(u);
    const ivB = vb.indexOf(v);
    if (iuA === -1 || ivB === -1) return null;
    if (va[(iuA + 1) % va.length] !== v || vb[(ivB + 1) % vb.length] !== u) return null;

    const mergedV = [];
    const mergedUV = [];
    // Walk fA from v around to u (excluding duplicate u->v internal chord)
    const startA = (iuA + 1) % va.length; // v
    for (let s = 0; s < va.length - 1; s++) {
      const idx = (startA + s) % va.length;
      mergedV.push(va[idx]);
      mergedUV.push(fA.uvs ? fA.uvs[idx] : null);
    }
    // Walk fB from u around to v
    const startB = (ivB + 1) % vb.length; // u
    for (let s = 0; s < vb.length - 1; s++) {
      const idx = (startB + s) % vb.length;
      mergedV.push(vb[idx]);
      mergedUV.push(fB.uvs ? fB.uvs[idx] : null);
    }

    if (!isSimpleConvexOrQuasiPlanar(mergedV, weldedVertices, fA.normal)) {
      return null;
    }

    return {
      verts: mergedV,
      uvs: mergedUV.some(Boolean) ? mergedUV.map(c => c ? c.clone() : new THREE.Vector2()) : null
    };
  };

  // Pass 1: form disjoint rectangular quads (prevents greedy zig-zag)
  for (const cand of candidatePairs) {
    const fA = faces[cand.fiA];
    const fB = faces[cand.fiB];
    if (!fA.alive || !fB.alive) continue;
    const res = spliceFaces(fA, fB, cand.u, cand.v);
    if (!res) continue;
    fA.verts = res.verts;
    fA.uvs = res.uvs;
    fB.alive = false;
  }

  // Pass 2: merge remaining coplanar faces sharing >=1 non-selected edge into convex N-gons
  // (e.g. cylinder circular cap, hexagonal caps) without crossing non-manifold/holes
  let didMerge = true;
  let guard = 0;
  while (didMerge && guard++ < 8) {
    didMerge = false;
    const active = faces.filter(f => f.alive);
    const eMap = new Map();
    for (const f of active) {
      const n = f.verts.length;
      for (let k = 0; k < n; k++) {
        const u = f.verts[k];
        const v = f.verts[(k + 1) % n];
        const key = edgePairKey(u, v);
        if (!eMap.has(key)) eMap.set(key, []);
        eMap.get(key).push({ face: f, u, v });
      }
    }
    for (const [, refs] of eMap.entries()) {
      if (refs.length !== 2) continue;
      const r0 = refs[0], r1 = refs[1];
      const fA = r0.face, fB = r1.face;
      if (!fA.alive || !fB.alive || fA === fB) continue;
      if (r0.u !== r1.v || r0.v !== r1.u) continue;
      if (fA.normal.dot(fB.normal) <= 0.9999) continue;
      if (selectedSet && selectedSet.has(bevelEdgeCoordKey(weldedVertices[r0.u], weldedVertices[r0.v]))) {
        continue;
      }
      const res = spliceFaces(fA, fB, r0.u, r0.v);
      if (!res) continue;
      fA.verts = res.verts;
      fA.uvs = res.uvs;
      fB.alive = false;
      didMerge = true;
    }
  }

  return faces
    .filter(f => f.alive)
    .map((f, idx) => ({
      id: idx,
      verts: f.verts,
      uvs: f.uvs,
      normal: computePolygonNormal(f.verts, weldedVertices)
    }));
}

/**
 * Superellipse bevel profile interpolation from pStart (on face A) to pEnd (on face B)
 * around corner intersection point pOrig.
 * For prof === 0.5, exponent r = 2 produces a true circular fillet arc.
 */
function interpolateProfilePoint(pStart, pEnd, pOrig, frac, segCount, prof) {
  if (segCount <= 1) {
    return new THREE.Vector3().lerpVectors(pStart, pEnd, frac);
  }
  const pCorner = new THREE.Vector3().addVectors(pStart, pEnd).sub(pOrig);
  const vA = new THREE.Vector3().subVectors(pStart, pCorner);
  const vB = new THREE.Vector3().subVectors(pEnd, pCorner);

  const theta = frac * Math.PI * 0.5;
  const c = Math.max(0, Math.cos(theta));
  const s = Math.max(0, Math.sin(theta));

  // Map Blender profile [0..1] -> superellipse exponent r:
  // 0.0 -> 0.55 (concave), 0.25 -> 1.0 (flat), 0.5 -> 2.0 (circular), 1.0 -> 16.0 (sharp)
  let r;
  if (prof <= 0.5) {
    r = 0.55 + (prof / 0.5) * 1.45;
  } else {
    r = 2.0 * Math.pow(8.0, (prof - 0.5) * 2.0);
  }

  const cr = Math.pow(c, r);
  const sr = Math.pow(s, r);
  const denom = Math.pow(cr + sr, 1.0 / r) || 1.0;
  const u = c / denom;
  const v = s / denom;

  return pCorner.addScaledVector(vA, u).addScaledVector(vB, v);
}

/**
 * Computes planar corner intersection offset for corner k of polygon poly.
 */
function computePlanarCornerOffset(poly, k, polyEdges, beveledEdges, weldedVertices, effectiveWidth) {
  const vs = poly.verts;
  const m = vs.length;
  const vPrev = vs[(k - 1 + m) % m];
  const vCur = vs[k];
  const vNext = vs[(k + 1) % m];

  const pPrev = weldedVertices[vPrev];
  const pCur = weldedVertices[vCur];
  const pNext = weldedVertices[vNext];

  const ePrev = polyEdges.get(edgePairKey(vPrev, vCur));
  const eNext = polyEdges.get(edgePairKey(vCur, vNext));

  const wPrev = (ePrev && beveledEdges.has(ePrev)) ? effectiveWidth : 0;
  const wNext = (eNext && beveledEdges.has(eNext)) ? effectiveWidth : 0;

  if (wPrev === 0 && wNext === 0) {
    return pCur.clone();
  }

  const dPrev = new THREE.Vector3().subVectors(pCur, pPrev).normalize();
  const dNext = new THREE.Vector3().subVectors(pNext, pCur).normalize();
  const n = poly.normal;

  // Inward edge normals in face plane
  const inPrev = new THREE.Vector3().crossVectors(n, dPrev).normalize();
  const inNext = new THREE.Vector3().crossVectors(n, dNext).normalize();

  // Orthonormal 2D basis in poly plane
  const uAxis = dNext.clone();
  const vAxis = new THREE.Vector3().crossVectors(n, uAxis).normalize();

  const a11 = inPrev.dot(uAxis);
  const a12 = inPrev.dot(vAxis);
  const a21 = inNext.dot(uAxis);
  const a22 = inNext.dot(vAxis);

  const det = a11 * a22 - a12 * a21;
  let offsetVec;
  if (Math.abs(det) > 1e-4) {
    const du = (wPrev * a22 - wNext * a12) / det;
    const dv = (a11 * wNext - a21 * wPrev) / det;
    offsetVec = new THREE.Vector3().addScaledVector(uAxis, du).addScaledVector(vAxis, dv);
  } else {
    const avgIn = new THREE.Vector3().addVectors(inPrev, inNext).normalize();
    offsetVec = avgIn.multiplyScalar(0.5 * (wPrev + wNext));
  }

  // Clamp miter spike on ultra-acute angles
  const maxOffset = effectiveWidth * 4.0;
  if (offsetVec.length() > maxOffset) {
    offsetVec.setLength(maxOffset);
  }

  return pCur.clone().add(offsetVec);
}

/**
 * Executes a true Blender-parity Bevel on a BufferGeometry.
 * @param {THREE.BufferGeometry} geometry Input mesh geometry
 * @param {Object} [params]
 * @param {number} [params.width=0.08] Bevel width / offset distance
 * @param {number} [params.segments=1] Number of bevel segments (1 = flat chamfer, 2+ = rounded)
 * @param {number} [params.profile=0.5] Profile curve (0.5 = round, <0.5 concave, >0.5 convex)
 * @param {boolean} [params.clampOverlap=true] Clamps bevel offset to prevent overlap
 * @param {'none'|'angle'|'weight'} [params.limitMethod='none'] Selection criteria for beveling
 * @param {number} [params.angleLimitDeg=30] Angle threshold in degrees for limitMethod='angle'
 * @param {boolean} [params.hardenNormals=false] Flat face normals on inner faces & chamfer steps
 * @param {Set<string>|Array<string>|null} [params.selectedEdgeKeys=null] Optional edge coordinate keys to bevel
 * @returns {THREE.BufferGeometry}
 */
export function bevelMesh(geometry, params = {}) {
  const {
    width = 0.08,
    segments = 1,
    profile = 0.5,
    clampOverlap = true,
    limitMethod = 'none',
    angleLimitDeg = 30,
    hardenNormals = false,
    selectedEdgeKeys = null
  } = params;

  if (!geometry || !geometry.attributes || !geometry.attributes.position) {
    return geometry;
  }

  const segCount = Math.max(1, Math.min(8, Math.floor(segments)));
  const prof = Math.max(0.0, Math.min(1.0, profile));
  const angleLimitRad = (angleLimitDeg * Math.PI) / 180.0;

  const nonIndexed = geometry.index ? geometry.toNonIndexed() : geometry.clone();
  const posAttr = nonIndexed.attributes.position;
  const uvAttr = nonIndexed.attributes.uv;
  const numTris = Math.floor(posAttr.count / 3);

  if (numTris === 0) {
    nonIndexed.dispose();
    return geometry.clone();
  }

  // 1. Weld positions spatially
  const pMap = new Map();
  const weldedVertices = [];
  const triVerts = new Uint32Array(numTris * 3);
  const triUVs = new Array(numTris);

  for (let i = 0; i < posAttr.count; i++) {
    const x = posAttr.getX(i);
    const y = posAttr.getY(i);
    const z = posAttr.getZ(i);
    const key = coordKey(x, y, z);
    let uid = pMap.get(key);
    if (uid === undefined) {
      uid = weldedVertices.length;
      weldedVertices.push(new THREE.Vector3(x, y, z));
      pMap.set(key, uid);
    }
    triVerts[i] = uid;
  }

  for (let t = 0; t < numTris; t++) {
    if (uvAttr) {
      triUVs[t] = [
        new THREE.Vector2(uvAttr.getX(t * 3 + 0), uvAttr.getY(t * 3 + 0)),
        new THREE.Vector2(uvAttr.getX(t * 3 + 1), uvAttr.getY(t * 3 + 1)),
        new THREE.Vector2(uvAttr.getX(t * 3 + 2), uvAttr.getY(t * 3 + 2))
      ];
    } else {
      triUVs[t] = null;
    }
  }

  const selectedSet = selectedEdgeKeys
    ? (selectedEdgeKeys instanceof Set ? selectedEdgeKeys : new Set(selectedEdgeKeys))
    : null;

  // 2. Reconstruct true planar polygons (quads / N-gons) so internal diagonal edges don't tear
  const polys = buildPlanarPolygons(triVerts, triUVs, weldedVertices, selectedSet);

  // 3. Build polygon edge adjacency
  const polyEdges = new Map();
  const edgeList = [];
  for (let fi = 0; fi < polys.length; fi++) {
    const poly = polys[fi];
    const m = poly.verts.length;
    for (let k = 0; k < m; k++) {
      const u = poly.verts[k];
      const v = poly.verts[(k + 1) % m];
      if (u === v) continue;
      const key = edgePairKey(u, v);
      let entry = polyEdges.get(key);
      if (!entry) {
        entry = {
          id: edgeList.length,
          v0: Math.min(u, v),
          v1: Math.max(u, v),
          key,
          faces: [],
          sides: [] // { polyIdx, kStart, kEnd, u, v }
        };
        polyEdges.set(key, entry);
        edgeList.push(entry);
      }
      if (!entry.faces.includes(fi)) entry.faces.push(fi);
      entry.sides.push({ polyIdx: fi, kStart: k, kEnd: (k + 1) % m, u, v });
    }
  }

  // 4. Identify beveled polygon edges
  const beveledEdges = new Set();
  const minBevelAngle = limitMethod === 'angle' ? angleLimitRad : (1.0 * Math.PI / 180.0);

  for (const e of edgeList) {
    if (e.faces.length !== 2) continue;
    if (selectedSet && !selectedSet.has(bevelEdgeCoordKey(weldedVertices[e.v0], weldedVertices[e.v1]))) {
      continue;
    }
    const nA = polys[e.faces[0]].normal;
    const nB = polys[e.faces[1]].normal;
    const dot = Math.max(-1.0, Math.min(1.0, nA.dot(nB)));
    const angle = Math.acos(dot);
    if (angle >= minBevelAngle || (selectedSet && angle > 1e-4)) {
      beveledEdges.add(e);
    }
  }

  if (beveledEdges.size === 0) {
    nonIndexed.dispose();
    return geometry.clone();
  }

  // 5. Overlap clamping against shortest edge adjacent to any beveled edge
  let minEdgeLen = Infinity;
  for (const e of edgeList) {
    const len = weldedVertices[e.v0].distanceTo(weldedVertices[e.v1]);
    if (len > 1e-6) minEdgeLen = Math.min(minEdgeLen, len);
  }
  if (!Number.isFinite(minEdgeLen) || minEdgeLen <= 1e-6) minEdgeLen = 1.0;
  const effectiveWidth = clampOverlap ? Math.min(width, minEdgeLen * 0.45) : width;

  // 6. Compute corner offset positions on every polygon
  // polyCornerPos[polyIdx][k], polyCornerUV[polyIdx][k]
  const polyCornerPos = new Array(polys.length);
  const polyCornerUV = new Array(polys.length);

  for (let fi = 0; fi < polys.length; fi++) {
    const poly = polys[fi];
    const m = poly.verts.length;
    polyCornerPos[fi] = new Array(m);
    polyCornerUV[fi] = new Array(m);
    for (let k = 0; k < m; k++) {
      polyCornerPos[fi][k] = computePlanarCornerOffset(poly, k, polyEdges, beveledEdges, weldedVertices, effectiveWidth);
      polyCornerUV[fi][k] = poly.uvs && poly.uvs[k] ? poly.uvs[k].clone() : null;
    }
  }

  // Track which vertices sit on beveled edges so un-beveled adjacent polygons
  // split cleanly around the chamfer endpoints (Blender N-gon edge absorption).
  const vertToIncidentEdges = Array.from({ length: weldedVertices.length }, () => []);
  const vertToBeveledEdges = Array.from({ length: weldedVertices.length }, () => []);
  for (const e of edgeList) {
    vertToIncidentEdges[e.v0].push(e);
    vertToIncidentEdges[e.v1].push(e);
    if (beveledEdges.has(e)) {
      vertToBeveledEdges[e.v0].push(e);
      vertToBeveledEdges[e.v1].push(e);
    }
  }

  // 7. Build triangle output buffers
  const outPositions = [];
  const outNormals = [];
  const outUVs = [];
  const outIsSmoothCurve = [];

  const addTriangle = (p0, p1, p2, u0 = null, u1 = null, u2 = null, refNormal = null, isSmoothCurve = false) => {
    const cross = new THREE.Vector3()
      .subVectors(p1, p0)
      .cross(new THREE.Vector3().subVectors(p2, p0));
    if (cross.lengthSq() < 1e-16) return;

    if (refNormal && cross.dot(refNormal) < 0) {
      const tmpP = p1; p1 = p2; p2 = tmpP;
      const tmpU = u1; u1 = u2; u2 = tmpU;
      cross.negate();
    }

    const calcN = cross.clone().normalize();
    outPositions.push(p0.x, p0.y, p0.z, p1.x, p1.y, p1.z, p2.x, p2.y, p2.z);
    outNormals.push(calcN.x, calcN.y, calcN.z, calcN.x, calcN.y, calcN.z, calcN.x, calcN.y, calcN.z);
    if (u0 && u1 && u2) {
      outUVs.push(u0.x, u0.y, u1.x, u1.y, u2.x, u2.y);
    } else {
      outUVs.push(0, 0, 1, 0, 0, 1);
    }
    outIsSmoothCurve.push(isSmoothCurve);
  };

  const emitFanPolygon = (pts, uvs, refNormal, isSmoothCurve = false) => {
    if (pts.length < 3) return;
    for (let k = 1; k < pts.length - 1; k++) {
      addTriangle(
        pts[0], pts[k], pts[k + 1],
        uvs ? uvs[0] : null,
        uvs ? uvs[k] : null,
        uvs ? uvs[k + 1] : null,
        refNormal,
        isSmoothCurve
      );
    }
  };

  // Precompute endpoint data per beveled edge so both polygons and corner miters match bit-for-bit
  const edgeStripInfo = new Map();
  for (const e of beveledEdges) {
    if (e.sides.length !== 2) continue;
    const sA = e.sides[0];
    const sB = e.sides[1];
    // On sA, edge runs u -> v. On sB (opposite winding), v -> u.
    // Match u corner on sA with its counterpart on sB, and v corner with its counterpart.
    const posA_u = polyCornerPos[sA.polyIdx][sA.kStart];
    const posA_v = polyCornerPos[sA.polyIdx][sA.kEnd];
    const uvA_u = polyCornerUV[sA.polyIdx][sA.kStart];
    const uvA_v = polyCornerUV[sA.polyIdx][sA.kEnd];

    const posB_u = sB.u === sA.u ? polyCornerPos[sB.polyIdx][sB.kStart] : polyCornerPos[sB.polyIdx][sB.kEnd];
    const posB_v = sB.v === sA.v ? polyCornerPos[sB.polyIdx][sB.kEnd] : polyCornerPos[sB.polyIdx][sB.kStart];
    const uvB_u = sB.u === sA.u ? polyCornerUV[sB.polyIdx][sB.kStart] : polyCornerUV[sB.polyIdx][sB.kEnd];
    const uvB_v = sB.v === sA.v ? polyCornerUV[sB.polyIdx][sB.kEnd] : polyCornerUV[sB.polyIdx][sB.kStart];

    const refNorm = new THREE.Vector3().addVectors(polys[sA.polyIdx].normal, polys[sB.polyIdx].normal);
    if (refNorm.lengthSq() < 1e-12) refNorm.copy(polys[sA.polyIdx].normal);
    else refNorm.normalize();

    const origU = weldedVertices[sA.u];
    const origV = weldedVertices[sA.v];

    const rowAt = (frac) => {
      const p0 = interpolateProfilePoint(posA_u, posB_u, origU, frac, segCount, prof);
      const p1 = interpolateProfilePoint(posA_v, posB_v, origV, frac, segCount, prof);
      const u0 = uvA_u && uvB_u ? new THREE.Vector2().lerpVectors(uvA_u, uvB_u, frac) : null;
      const u1 = uvA_v && uvB_v ? new THREE.Vector2().lerpVectors(uvA_v, uvB_v, frac) : null;
      return { p0, p1, u0, u1 };
    };

    edgeStripInfo.set(e, {
      e,
      u: sA.u,
      v: sA.v,
      polyA: sA.polyIdx,
      polyB: sB.polyIdx,
      posA_u, posA_v, posB_u, posB_v,
      uvA_u, uvA_v, uvB_u, uvB_v,
      refNorm,
      rowAt
    });
  }

  // Helper: at vertex vIdx on face `polyIdx`, when BOTH incident polygon edges of `poly` are un-beveled
  // yet vertex vIdx touches beveled edge(s), compute the exact chain of corner points from `ePrev` side
  // across to `eNext` side so `poly` stitches seamlessly with chamfer strips!
  const getCornerReplacementForUnbeveledCorner = (poly, k) => {
    const m = poly.verts.length;
    const vPrev = poly.verts[(k - 1 + m) % m];
    const vCur = poly.verts[k];
    const vNext = poly.verts[(k + 1) % m];

    const bevAtVert = vertToBeveledEdges[vCur];
    if (bevAtVert.length !== 1) {
      return null; // Handled by 2+-bevel vertex miter patch
    }

    const bevEdge = bevAtVert[0];
    const strip = edgeStripInfo.get(bevEdge);
    if (!strip) return null;

    // Both edges of this face at vCur are non-beveled, and bevEdge terminates right at vCur
    // splitting this face corner along [pOnFaceA ... pOnFaceB].
    // Only absorb if this polygon shares edge(vPrev,vCur) with one beveled face and edge(vCur,vNext) with the other!
    const ePrev = polyEdges.get(edgePairKey(vPrev, vCur));
    const eNext = polyEdges.get(edgePairKey(vCur, vNext));
    if (!ePrev || !eNext || beveledEdges.has(ePrev) || beveledEdges.has(eNext)) return null;

    const pFromPrevFace = ePrev.faces.includes(strip.polyA)
      ? (strip.u === vCur ? strip.posA_u : strip.posA_v)
      : (ePrev.faces.includes(strip.polyB) ? (strip.u === vCur ? strip.posB_u : strip.posB_v) : null);
    const pToNextFace = eNext.faces.includes(strip.polyA)
      ? (strip.u === vCur ? strip.posA_u : strip.posA_v)
      : (eNext.faces.includes(strip.polyB) ? (strip.u === vCur ? strip.posB_u : strip.posB_v) : null);

    if (!pFromPrevFace || !pToNextFace) return null;

    const uvFromPrevFace = ePrev.faces.includes(strip.polyA)
      ? (strip.u === vCur ? strip.uvA_u : strip.uvA_v)
      : (strip.u === vCur ? strip.uvB_u : strip.uvB_v);
    const uvToNextFace = eNext.faces.includes(strip.polyA)
      ? (strip.u === vCur ? strip.uvA_u : strip.uvA_v)
      : (strip.u === vCur ? strip.uvB_u : strip.uvB_v);

    const orig = weldedVertices[vCur];
    const pts = [];
    const uvs = [];
    for (let s = 0; s <= segCount; s++) {
      const frac = s / segCount;
      pts.push(interpolateProfilePoint(pFromPrevFace, pToNextFace, orig, frac, segCount, prof));
      if (uvFromPrevFace && uvToNextFace) {
        uvs.push(new THREE.Vector2().lerpVectors(uvFromPrevFace, uvToNextFace, frac));
      } else {
        uvs.push(polyCornerUV[poly.id][k]?.clone() || null);
      }
    }
    return { pts, uvs };
  };

  // A. Emit main polygonal faces (inset + un-beveled corner absorptions)
  for (let fi = 0; fi < polys.length; fi++) {
    const poly = polys[fi];
    const m = poly.verts.length;
    const pts = [];
    const uvs = [];
    let hasAllUVs = Boolean(poly.uvs);

    for (let k = 0; k < m; k++) {
      const vPrev = poly.verts[(k - 1 + m) % m];
      const vCur = poly.verts[k];
      const vNext = poly.verts[(k + 1) % m];
      const ePrev = polyEdges.get(edgePairKey(vPrev, vCur));
      const eNext = polyEdges.get(edgePairKey(vCur, vNext));
      const prevBev = Boolean(ePrev && beveledEdges.has(ePrev));
      const nextBev = Boolean(eNext && beveledEdges.has(eNext));

      if (!prevBev && !nextBev && vertToBeveledEdges[vCur].length === 1) {
        const rep = getCornerReplacementForUnbeveledCorner(poly, k);
        if (rep) {
          for (let r = 0; r < rep.pts.length; r++) {
            pts.push(rep.pts[r]);
            if (hasAllUVs && rep.uvs[r]) uvs.push(rep.uvs[r]);
            else hasAllUVs = false;
          }
          continue;
        }
      }

      pts.push(polyCornerPos[fi][k]);
      if (hasAllUVs && polyCornerUV[fi][k]) uvs.push(polyCornerUV[fi][k]);
      else hasAllUVs = false;
    }

    emitFanPolygon(pts, hasAllUVs ? uvs : null, poly.normal, false);
  }

  // B. Emit chamfer strips along beveled edges
  for (const [, strip] of edgeStripInfo.entries()) {
    for (let s = 0; s < segCount; s++) {
      const row0 = strip.rowAt(s / segCount);
      const row1 = strip.rowAt((s + 1) / segCount);

      addTriangle(row0.p0, row0.p1, row1.p1, row0.u0, row0.u1, row1.u1, strip.refNorm, segCount > 1);
      addTriangle(row0.p0, row1.p1, row1.p0, row0.u0, row1.u1, row1.u0, strip.refNorm, segCount > 1);
    }
  }

  // C. Emit watertight vertex corner miters when 3+ edges meet around a vertex with 2+ beveled edges
  for (let vIdx = 0; vIdx < weldedVertices.length; vIdx++) {
    const bevEdgesAtV = vertToBeveledEdges[vIdx];
    if (bevEdgesAtV.length < 3) {
      // If exactly 2 beveled edges meet along an un-beveled 3rd edge (like Top-Front + Top-Left
      // meeting at Front-Left vertical edge), both chamfer strips converge onto the SAME slid
      // endpoint vertex on the 3rd edge -> strips stitch edge-to-edge directly with zero gap!
      if (bevEdgesAtV.length < 2) continue;
      // Check if any incident face corner still sits strictly separate (4+-edge non-triangular vertex)
      if (vertToIncidentEdges[vIdx].length <= 3) continue;
    }

    // Collect distinct beveled corner endpoints around vIdx (1 per incident face touching beveled edge)
    const incidentPolys = new Map();
    for (const e of vertToIncidentEdges[vIdx]) {
      for (const fi of e.faces) {
        if (incidentPolys.has(fi)) continue;
        const poly = polys[fi];
        const k = poly.verts.indexOf(vIdx);
        if (k !== -1) {
          incidentPolys.set(fi, {
            polyIdx: fi,
            pos: polyCornerPos[fi][k],
            uv: polyCornerUV[fi][k],
            normal: poly.normal
          });
        }
      }
    }

    const corners = Array.from(incidentPolys.values());
    if (corners.length < 3) continue;

    // Deduplicate coincident positions (e.g. from un-beveled adjacent edges)
    const uniq = [];
    for (const c of corners) {
      if (!uniq.some(u => u.pos.distanceToSquared(c.pos) < 1e-10)) {
        uniq.push(c);
      }
    }
    if (uniq.length < 3) continue;

    const origV = weldedVertices[vIdx];
    const centroid = new THREE.Vector3();
    const cornerUV = new THREE.Vector2();
    let uvCount = 0;
    for (const c of uniq) {
      centroid.add(c.pos);
      if (c.uv) { cornerUV.add(c.uv); uvCount++; }
    }
    centroid.divideScalar(uniq.length);
    if (uvCount > 0) cornerUV.divideScalar(uvCount);

    const outNormal = new THREE.Vector3();
    for (const c of uniq) outNormal.add(c.normal);
    if (outNormal.lengthSq() < 1e-6) outNormal.subVectors(origV, centroid);
    if (outNormal.lengthSq() < 1e-6) outNormal.set(0, 1, 0);
    outNormal.normalize();

    const tangent = new THREE.Vector3(1, 0, 0);
    if (Math.abs(outNormal.dot(tangent)) > 0.9) tangent.set(0, 0, 1);
    const bitangent = new THREE.Vector3().crossVectors(outNormal, tangent).normalize();
    tangent.crossVectors(bitangent, outNormal).normalize();

    // Order radially CCW around outNormal
    const sorted = uniq.slice().sort((a, b) => {
      const da = new THREE.Vector3().subVectors(a.pos, centroid);
      const db = new THREE.Vector3().subVectors(b.pos, centroid);
      return Math.atan2(da.dot(bitangent), da.dot(tangent)) - Math.atan2(db.dot(bitangent), db.dot(tangent));
    });

    if (segCount === 1) {
      const pts = sorted.map(c => c.pos);
      const uvs = uvCount === uniq.length ? sorted.map(c => c.uv) : null;
      emitFanPolygon(pts, uvs, outNormal, false);
    } else if (sorted.length === 3) {
      // Barycentric spherical-corner grid matching all 3 chamfer profile curves bit-for-bit
      const [c0, c1, c2] = sorted;
      const N = segCount;

      const edge01 = []; // k = 0..N from c0 -> c1
      const edge12 = []; // k = 0..N from c1 -> c2
      const edge20 = []; // k = 0..N from c2 -> c0
      for (let s = 0; s <= N; s++) {
        const f = s / N;
        edge01.push({
          pos: interpolateProfilePoint(c0.pos, c1.pos, origV, f, N, prof),
          uv: c0.uv && c1.uv ? new THREE.Vector2().lerpVectors(c0.uv, c1.uv, f) : null
        });
        edge12.push({
          pos: interpolateProfilePoint(c1.pos, c2.pos, origV, f, N, prof),
          uv: c1.uv && c2.uv ? new THREE.Vector2().lerpVectors(c1.uv, c2.uv, f) : null
        });
        edge20.push({
          pos: interpolateProfilePoint(c2.pos, c0.pos, origV, f, N, prof),
          uv: c2.uv && c0.uv ? new THREE.Vector2().lerpVectors(c2.uv, c0.uv, f) : null
        });
      }

      // Compute center corner point for superellipse dome (intersection of the 3 inset planes)
      const interiorOrigin = new THREE.Vector3()
        .addVectors(c0.pos, c1.pos)
        .add(c2.pos)
        .sub(origV.clone().multiplyScalar(2));
      const domeRadius = Math.max(1e-6,
        (c0.pos.distanceTo(interiorOrigin) + c1.pos.distanceTo(interiorOrigin) + c2.pos.distanceTo(interiorOrigin)) / 3
      );

      // Grid G[i][j] for i + j <= N (barycentric: w0=(N-i-j)/N, w1=i/N, w2=j/N)
      const G = Array.from({ length: N + 1 }, () => []);
      for (let i = 0; i <= N; i++) {
        for (let j = 0; j <= N - i; j++) {
          const k = N - i - j;
          if (j === 0) {
            G[i][j] = edge01[i];
          } else if (k === 0) {
            G[i][j] = edge12[j];
          } else if (i === 0) {
            G[i][j] = edge20[k];
          } else {
            const w0 = k / N;
            const w1 = i / N;
            const w2 = j / N;
            const linPos = new THREE.Vector3()
              .addScaledVector(c0.pos, w0)
              .addScaledVector(c1.pos, w1)
              .addScaledVector(c2.pos, w2);
            const linUV = (c0.uv && c1.uv && c2.uv)
              ? new THREE.Vector2().addScaledVector(c0.uv, w0).addScaledVector(c1.uv, w1).addScaledVector(c2.uv, w2)
              : null;

            // Project onto corner superellipse/spherical dome around interiorOrigin
            const rel = new THREE.Vector3().subVectors(linPos, interiorOrigin);
            const relLen = rel.length();
            let pos = linPos;
            if (relLen > 1e-6 && prof > 0.25) {
              const targetSphere = interiorOrigin.clone().addScaledVector(rel, domeRadius / relLen);
              const blend = prof <= 0.5 ? (prof - 0.25) / 0.25 : 1.0;
              pos = new THREE.Vector3().lerpVectors(linPos, targetSphere, blend);
              if (prof > 0.5) {
                pos.lerp(origV, (prof - 0.5) * 0.65);
              }
            }
            G[i][j] = { pos, uv: linUV };
          }
        }
      }

      for (let i = 0; i < N; i++) {
        for (let j = 0; j < N - i; j++) {
          const pA = G[i][j];
          const pB = G[i + 1][j];
          const pC = G[i][j + 1];
          addTriangle(pA.pos, pB.pos, pC.pos, pA.uv, pB.uv, pC.uv, outNormal, true);
          if (i + j + 1 < N) {
            const pD = G[i + 1][j + 1];
            addTriangle(pB.pos, pD.pos, pC.pos, pB.uv, pD.uv, pC.uv, outNormal, true);
          }
        }
      }
    } else {
      // M >= 4 beveled corners around vertex (concentric rings from rounded apex to boundary curves)
      const M = sorted.length;
      const rings = [];
      // Outer boundary ring (matches each chamfer strip endpoint/curve)
      const outer = [];
      for (let i = 0; i < M; i++) {
        const cA = sorted[i];
        const cB = sorted[(i + 1) % M];
        for (let s = 0; s < segCount; s++) {
          const frac = s / segCount;
          outer.push({
            pos: interpolateProfilePoint(cA.pos, cB.pos, origV, frac, segCount, prof),
            uv: cA.uv && cB.uv ? new THREE.Vector2().lerpVectors(cA.uv, cB.uv, frac) : null
          });
        }
      }
      rings.push(outer);
      const bulgePos = new THREE.Vector3().lerpVectors(centroid, origV, Math.min(0.65, prof * 0.75));
      for (let i = 0; i < outer.length; i++) {
        const p0 = outer[i];
        const p1 = outer[(i + 1) % outer.length];
        addTriangle(bulgePos, p0.pos, p1.pos, uvCount > 0 ? cornerUV : null, p0.uv, p1.uv, outNormal, true);
      }
    }
  }

  nonIndexed.dispose();

  // Smooth vertex normals ONLY on rounded bevel curves when !hardenNormals (keeps planar faces crisp flat)
  if (!hardenNormals && segCount > 1) {
    const triCountOut = Math.floor(outPositions.length / 9);
    const accum = new Map();
    for (let t = 0; t < triCountOut; t++) {
      if (!outIsSmoothCurve[t]) continue;
      const nx = outNormals[t * 9 + 0];
      const ny = outNormals[t * 9 + 1];
      const nz = outNormals[t * 9 + 2];
      for (let c = 0; c < 3; c++) {
        const vi = t * 9 + c * 3;
        const k = coordKey(outPositions[vi], outPositions[vi + 1], outPositions[vi + 2]);
        let vec = accum.get(k);
        if (!vec) { vec = new THREE.Vector3(); accum.set(k, vec); }
        vec.x += nx; vec.y += ny; vec.z += nz;
      }
    }
    for (let t = 0; t < triCountOut; t++) {
      if (!outIsSmoothCurve[t]) continue;
      for (let c = 0; c < 3; c++) {
        const vi = t * 9 + c * 3;
        const k = coordKey(outPositions[vi], outPositions[vi + 1], outPositions[vi + 2]);
        const sum = accum.get(k);
        if (sum && sum.lengthSq() > 1e-12) {
          const n = sum.clone().normalize();
          outNormals[vi + 0] = n.x;
          outNormals[vi + 1] = n.y;
          outNormals[vi + 2] = n.z;
        }
      }
    }
  }

  const outGeom = new THREE.BufferGeometry();
  outGeom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(outPositions), 3));
  outGeom.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(outNormals), 3));
  outGeom.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(outUVs), 2));
  outGeom.computeBoundingBox();
  outGeom.computeBoundingSphere();

  return outGeom;
}
