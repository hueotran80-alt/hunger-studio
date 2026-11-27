/**
 * @file bone-heat.js
 * @description Laplacian Cotangent Bone Heat solver (Baran & Popovic, Pinocchio 2007)
 * for volumetric heat-diffusion automatic skinning weights:
 * - Welds coincident UV/normal-seam vertices into logical manifold nodes
 * - Builds symmetric cotangent-weighted surface Laplacian L
 * - Ray-casts visibility against mesh triangles for boundary confidence diagonal H
 * - Solves sparse SPD system (L + H) w_b = H * rhs_b via Jacobi Conjugate Gradient
 * - Handles multi-island / disconnected shells safely without singular matrices
 */

import * as THREE from 'three';

function closestPointOnSegment(px, py, pz, ax, ay, az, bx, by, bz, out) {
  const abx = bx - ax;
  const aby = by - ay;
  const abz = bz - az;
  const lenSq = abx * abx + aby * aby + abz * abz;
  let t = 0;
  if (lenSq > 1e-10) {
    t = ((px - ax) * abx + (py - ay) * aby + (pz - az) * abz) / lenSq;
    if (t < 0) t = 0;
    else if (t > 1) t = 1;
  }
  out.x = ax + abx * t;
  out.y = ay + aby * t;
  out.z = az + abz * t;
  const dx = px - out.x;
  const dy = py - out.y;
  const dz = pz - out.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/**
 * Welds coincident geometry vertices and builds symmetric positive-semidefinite
 * cotangent Laplacian CSR matrix + logical normals.
 */
export function buildCotangentLaplacian(geom) {
  const posAttr = geom?.attributes?.position;
  if (!posAttr || posAttr.count < 3) return null;

  const vertCount = posAttr.count;
  const normAttr = geom.attributes.normal || null;
  const idxAttr = geom.index;
  const triCount = idxAttr ? Math.floor(idxAttr.count / 3) : Math.floor(vertCount / 3);
  if (triCount <= 0) return null;

  geom.computeBoundingBox();
  const sz = geom.boundingBox.getSize(new THREE.Vector3());
  const diag = Math.max(1e-3, Math.hypot(sz.x, sz.y, sz.z));
  const invWeld = 1.0 / Math.max(1e-5, diag * 1e-4);

  const keyToLogical = new Map();
  const origToLogical = new Int32Array(vertCount);
  const logicalCoords = [];
  const logicalNormals = [];

  for (let i = 0; i < vertCount; i++) {
    const x = posAttr.getX(i);
    const y = posAttr.getY(i);
    const z = posAttr.getZ(i);
    const key = `${Math.round(x * invWeld)}_${Math.round(y * invWeld)}_${Math.round(z * invWeld)}`;
    let li = keyToLogical.get(key);
    if (li === undefined) {
      li = logicalCoords.length / 3;
      keyToLogical.set(key, li);
      logicalCoords.push(x, y, z);
      logicalNormals.push(0, 0, 0);
    }
    origToLogical[i] = li;
    if (normAttr) {
      logicalNormals[li * 3] += normAttr.getX(i);
      logicalNormals[li * 3 + 1] += normAttr.getY(i);
      logicalNormals[li * 3 + 2] += normAttr.getZ(i);
    }
  }

  const logicalCount = logicalCoords.length / 3;
  for (let li = 0; li < logicalCount; li++) {
    const nx = logicalNormals[li * 3];
    const ny = logicalNormals[li * 3 + 1];
    const nz = logicalNormals[li * 3 + 2];
    const len = Math.hypot(nx, ny, nz);
    if (len > 1e-6) {
      logicalNormals[li * 3] = nx / len;
      logicalNormals[li * 3 + 1] = ny / len;
      logicalNormals[li * 3 + 2] = nz / len;
    }
  }

  // Accumulate cotangent weights W_ij cleanly into per-vertex neighbor Maps
  const edgeMaps = Array.from({ length: logicalCount }, () => new Map());
  const addEdgeWeight = (a, b, w) => {
    if (a === b || !Number.isFinite(w)) return;
    const clampedW = Math.max(1e-6, w); // Small positive epsilon ensures topological connectivity
    edgeMaps[a].set(b, (edgeMaps[a].get(b) || 0) + clampedW);
    edgeMaps[b].set(a, (edgeMaps[b].get(a) || 0) + clampedW);
  };

  for (let t = 0; t < triCount; t++) {
    const ia = idxAttr ? idxAttr.getX(t * 3) : t * 3;
    const ib = idxAttr ? idxAttr.getX(t * 3 + 1) : t * 3 + 1;
    const ic = idxAttr ? idxAttr.getX(t * 3 + 2) : t * 3 + 2;
    const la = origToLogical[ia];
    const lb = origToLogical[ib];
    const lc = origToLogical[ic];
    if (la === lb || lb === lc || lc === la) continue;

    const ax = logicalCoords[la * 3], ay = logicalCoords[la * 3 + 1], az = logicalCoords[la * 3 + 2];
    const bx = logicalCoords[lb * 3], by = logicalCoords[lb * 3 + 1], bz = logicalCoords[lb * 3 + 2];
    const cx = logicalCoords[lc * 3], cy = logicalCoords[lc * 3 + 1], cz = logicalCoords[lc * 3 + 2];

    const eABx = bx - ax, eABy = by - ay, eABz = bz - az;
    const eACx = cx - ax, eACy = cy - ay, eACz = cz - az;
    const eBCx = cx - bx, eBCy = cy - by, eBCz = cz - bz;

    const computeCot = (ux, uy, uz, vx, vy, vz) => {
      const dot = ux * vx + uy * vy + uz * vz;
      const cxp = uy * vz - uz * vy;
      const cyp = uz * vx - ux * vz;
      const czp = ux * vy - uy * vx;
      const crossLen = Math.sqrt(cxp * cxp + cyp * cyp + czp * czp);
      if (crossLen < 1e-8) return 0;
      return Math.max(0, dot / crossLen);
    };

    const cotA = computeCot(eABx, eABy, eABz, eACx, eACy, eACz); // opposite B-C
    const cotB = computeCot(-eABx, -eABy, -eABz, eBCx, eBCy, eBCz); // opposite A-C
    const cotC = computeCot(-eACx, -eACy, -eACz, -eBCx, -eBCy, -eBCz); // opposite A-B

    addEdgeWeight(lb, lc, 0.5 * cotA);
    addEdgeWeight(la, lc, 0.5 * cotB);
    addEdgeWeight(la, lb, 0.5 * cotC);
  }

  // Pack CSR symmetric graph
  const rowPtr = new Int32Array(logicalCount + 1);
  let nnz = 0;
  for (let i = 0; i < logicalCount; i++) {
    rowPtr[i] = nnz;
    nnz += edgeMaps[i].size;
  }
  rowPtr[logicalCount] = nnz;

  const colIdx = new Int32Array(nnz);
  const offVal = new Float64Array(nnz);
  const diagL = new Float64Array(logicalCount);

  let cursor = 0;
  for (let i = 0; i < logicalCount; i++) {
    let sum = 0;
    for (const [j, w] of edgeMaps[i].entries()) {
      colIdx[cursor] = j;
      offVal[cursor] = -w;
      sum += w;
      cursor++;
    }
    diagL[i] = sum;
  }

  return {
    vertCount,
    logicalCount,
    origToLogical,
    logicalCoords: new Float32Array(logicalCoords),
    logicalNormals: new Float32Array(logicalNormals),
    rowPtr,
    colIdx,
    offVal,
    diagL,
    diagSize: diag,
  };
}

/**
 * Solves (L + diag(H)) x = b using Jacobi-preconditioned Conjugate Gradient.
 * All arrays operate in Float64 for numerical stability.
 */
function solveSparseCG(lap, H, b, outX, maxIters = 200, tol = 1e-6) {
  const n = lap.logicalCount;
  const { rowPtr, colIdx, offVal, diagL } = lap;

  const r = new Float64Array(n);
  const z = new Float64Array(n);
  const p = new Float64Array(n);
  const Ap = new Float64Array(n);
  const invM = new Float64Array(n);

  let bNormSq = 0;
  for (let i = 0; i < n; i++) {
    const diagTotal = diagL[i] + H[i];
    invM[i] = diagTotal > 1e-12 ? 1.0 / diagTotal : 1.0;
    outX[i] = b[i] * invM[i];
    bNormSq += b[i] * b[i];
  }

  // Compute initial residual r = b - A * x
  for (let i = 0; i < n; i++) {
    let ax = (diagL[i] + H[i]) * outX[i];
    const end = rowPtr[i + 1];
    for (let k = rowPtr[i]; k < end; k++) {
      ax += offVal[k] * outX[colIdx[k]];
    }
    r[i] = b[i] - ax;
    z[i] = r[i] * invM[i];
    p[i] = z[i];
  }

  let rzOld = 0;
  for (let i = 0; i < n; i++) rzOld += r[i] * z[i];
  const stopSq = Math.max(1e-20, tol * tol * Math.max(1.0, bNormSq));

  for (let iter = 0; iter < maxIters; iter++) {
    let rSq = 0;
    for (let i = 0; i < n; i++) rSq += r[i] * r[i];
    if (rSq <= stopSq) break;

    let pAp = 0;
    for (let i = 0; i < n; i++) {
      let ax = (diagL[i] + H[i]) * p[i];
      const end = rowPtr[i + 1];
      for (let k = rowPtr[i]; k < end; k++) {
        ax += offVal[k] * p[colIdx[k]];
      }
      Ap[i] = ax;
      pAp += p[i] * ax;
    }

    if (Math.abs(pAp) < 1e-24) break;
    const alpha = rzOld / pAp;

    let rzNew = 0;
    for (let i = 0; i < n; i++) {
      outX[i] += alpha * p[i];
      r[i] -= alpha * Ap[i];
      z[i] = r[i] * invM[i];
      rzNew += r[i] * z[i];
    }

    if (Math.abs(rzOld) < 1e-24) break;
    const beta = rzNew / rzOld;
    for (let i = 0; i < n; i++) {
      p[i] = z[i] + beta * p[i];
    }
    rzOld = rzNew;
  }
}

function buildFallbackOcclusionChecker(geom, charScale) {
  const posAttr = geom.attributes.position;
  const idxAttr = geom.index;
  const triCount = idxAttr ? Math.floor(idxAttr.count / 3) : Math.floor(posAttr.count / 3);
  if (triCount <= 0 || triCount > 35000) return () => false;

  const triVerts = new Float32Array(triCount * 9);
  const triGrid = new Map();
  const rayStamp = new Int32Array(triCount);
  const voxel = Math.max(charScale / 12, 0.015);
  const invVoxel = 1.0 / voxel;
  let stampId = 0;

  for (let t = 0; t < triCount; t++) {
    const ia = idxAttr ? idxAttr.getX(t * 3) : t * 3;
    const ib = idxAttr ? idxAttr.getX(t * 3 + 1) : t * 3 + 1;
    const ic = idxAttr ? idxAttr.getX(t * 3 + 2) : t * 3 + 2;
    const ax = posAttr.getX(ia), ay = posAttr.getY(ia), az = posAttr.getZ(ia);
    const bx = posAttr.getX(ib), by = posAttr.getY(ib), bz = posAttr.getZ(ib);
    const cx = posAttr.getX(ic), cy = posAttr.getY(ic), cz = posAttr.getZ(ic);
    const b = t * 9;
    triVerts[b] = ax; triVerts[b + 1] = ay; triVerts[b + 2] = az;
    triVerts[b + 3] = bx; triVerts[b + 4] = by; triVerts[b + 5] = bz;
    triVerts[b + 6] = cx; triVerts[b + 7] = cy; triVerts[b + 8] = cz;

    const minX = Math.floor(Math.min(ax, bx, cx) * invVoxel);
    const maxX = Math.floor(Math.max(ax, bx, cx) * invVoxel);
    const minY = Math.floor(Math.min(ay, by, cy) * invVoxel);
    const maxY = Math.floor(Math.max(ay, by, cy) * invVoxel);
    const minZ = Math.floor(Math.min(az, bz, cz) * invVoxel);
    const maxZ = Math.floor(Math.max(az, bz, cz) * invVoxel);
    for (let gx = minX; gx <= maxX; gx++) {
      for (let gy = minY; gy <= maxY; gy++) {
        for (let gz = minZ; gz <= maxZ; gz++) {
          const key = `${gx}_${gy}_${gz}`;
          let list = triGrid.get(key);
          if (!list) {
            list = [];
            triGrid.set(key, list);
          }
          list.push(t);
        }
      }
    }
  }

  return (ox, oy, oz, tx, ty, tz) => {
    const dx = tx - ox, dy = ty - oy, dz = tz - oz;
    const segLen = Math.hypot(dx, dy, dz);
    if (segLen < 1e-5) return false;
    const invLen = 1.0 / segLen;
    const rdx = dx * invLen, rdy = dy * invLen, rdz = dz * invLen;
    const tMin = segLen * 0.04;
    const tMax = segLen * 0.94;
    stampId++;

    const steps = Math.min(24, Math.max(1, Math.ceil(segLen * invVoxel * 2)));
    let prevKey = '';
    for (let st = 0; st <= steps; st++) {
      const s = st / steps;
      const key = `${Math.floor((ox + dx * s) * invVoxel)}_${Math.floor((oy + dy * s) * invVoxel)}_${Math.floor((oz + dz * s) * invVoxel)}`;
      if (key === prevKey) continue;
      prevKey = key;
      const list = triGrid.get(key);
      if (!list) continue;
      for (let k = 0; k < list.length; k++) {
        const ti = list[k];
        if (rayStamp[ti] === stampId) continue;
        rayStamp[ti] = stampId;
        const base = ti * 9;
        const ax = triVerts[base], ay = triVerts[base + 1], az = triVerts[base + 2];
        const e1x = triVerts[base + 3] - ax, e1y = triVerts[base + 4] - ay, e1z = triVerts[base + 5] - az;
        const e2x = triVerts[base + 6] - ax, e2y = triVerts[base + 7] - ay, e2z = triVerts[base + 8] - az;
        const hx = rdy * e2z - rdz * e2y;
        const hy = rdz * e2x - rdx * e2z;
        const hz = rdx * e2y - rdy * e2x;
        const det = e1x * hx + e1y * hy + e1z * hz;
        if (det > -1e-7 && det < 1e-7) continue;
        const invDet = 1.0 / det;
        const sx = ox - ax, sy = oy - ay, sz = oz - az;
        const u = invDet * (sx * hx + sy * hy + sz * hz);
        if (u < -1e-4 || u > 1.0001) continue;
        const qx = sy * e1z - sz * e1y;
        const qy = sz * e1x - sx * e1z;
        const qz = sx * e1y - sy * e1x;
        const v = invDet * (rdx * qx + rdy * qy + rdz * qz);
        if (v < -1e-4 || u + v > 1.0001) continue;
        const tHit = invDet * (e2x * qx + e2y * qy + e2z * qz);
        if (tHit > tMin && tHit < tMax) return true;
      }
    }
    return false;
  };
}

/**
 * Computes top-4 normalized skinIndices / skinWeights using Laplacian Cotangent Bone Heat.
 * @param {THREE.BufferGeometry} geom
 * @param {Array<{index:number, startLocal:THREE.Vector3, endLocal:THREE.Vector3, side:string}>} boneInfos
 * @param {Object} [options]
 * @returns {{ skinIndices: Uint16Array, skinWeights: Float32Array, logicalCount: number }|null}
 */
export function computeLaplacianBoneHeatWeights(geom, boneInfos, options = {}) {
  if (!geom || !Array.isArray(boneInfos) || boneInfos.length === 0) return null;
  const lap = buildCotangentLaplacian(geom);
  if (!lap) return null;

  const { vertCount, logicalCount, origToLogical, logicalCoords, logicalNormals, diagL, diagSize } = lap;
  const boneCount = boneInfos.length;
  const charScale = Math.max(0.05, options.charScale || diagSize);
  const sideDeadband = options.sideDeadband || charScale * 0.03;
  const isSegmentOccluded = typeof options.isSegmentOccluded === 'function'
    ? options.isSegmentOccluded
    : buildFallbackOcclusionChecker(geom, charScale);

  const H = new Float64Array(logicalCount);
  const rhsAll = new Float64Array(logicalCount * boneCount);
  const cPt = { x: 0, y: 0, z: 0 };
  const minD2Floor = Math.pow(charScale * 0.008, 2);

  const vertDists = new Float64Array(boneCount);
  const vertVis = new Uint8Array(boneCount);

  for (let li = 0; li < logicalCount; li++) {
    const px = logicalCoords[li * 3];
    const py = logicalCoords[li * 3 + 1];
    const pz = logicalCoords[li * 3 + 2];
    const nx = logicalNormals[li * 3];
    const ny = logicalNormals[li * 3 + 1];
    const nz = logicalNormals[li * 3 + 2];

    const vertSide = px > sideDeadband ? 'left' : (px < -sideDeadband ? 'right' : 'center');
    const ox = px - nx * charScale * 0.004;
    const oy = py - ny * charScale * 0.004;
    const oz = pz - nz * charScale * 0.004;

    let minVisDist = Infinity;
    let minAnyDist = Infinity;
    let minAnyBone = 0;

    for (let bi = 0; bi < boneCount; bi++) {
      const b = boneInfos[bi];
      let d = closestPointOnSegment(
        px, py, pz,
        b.startLocal.x, b.startLocal.y, b.startLocal.z,
        b.endLocal.x, b.endLocal.y, b.endLocal.z,
        cPt
      );

      if (b.side && b.side !== 'center' && vertSide !== 'center' && b.side !== vertSide) {
        d *= 4.5;
      }
      vertDists[bi] = d;
      if (d < minAnyDist) {
        minAnyDist = d;
        minAnyBone = bi;
      }

      const occluded = isSegmentOccluded(ox, oy, oz, cPt.x, cPt.y, cPt.z);
      vertVis[bi] = occluded ? 0 : 1;
      if (!occluded && d < minVisDist) {
        minVisDist = d;
      }
    }

    if (Number.isFinite(minVisDist)) {
      const winners = [];
      const thresh = minVisDist * 1.02 + 1e-6;
      for (let bi = 0; bi < boneCount; bi++) {
        if (vertVis[bi] && vertDists[bi] <= thresh) winners.push(bi);
      }
      const wVal = 1.0 / Math.max(1, winners.length);
      for (const bi of winners) {
        rhsAll[bi * logicalCount + li] = wVal;
      }
      const baseL = Math.max(diagL[li], 1e-4);
      H[li] = baseL / Math.max(minVisDist * minVisDist, minD2Floor);
    } else {
      // Occluded surface interior vertex -> solved smoothly by Laplacian diffusion;
      // fallback seed assigned per island below if an entire shell is occluded.
      H[li] = 0;
      vertDists[0] = minAnyBone; // stash fallback bone temporarily in slot 0 when needed
    }
  }

  // Ensure every connected component has at least one vertex with H > 0 (SPD guarantee)
  const visited = new Uint8Array(logicalCount);
  const queue = new Int32Array(logicalCount);
  for (let start = 0; start < logicalCount; start++) {
    if (visited[start]) continue;
    let qHead = 0, qTail = 0;
    queue[qTail++] = start;
    visited[start] = 1;
    let hasSeed = false;

    while (qHead < qTail) {
      const cur = queue[qHead++];
      if (H[cur] > 0) hasSeed = true;
      const end = lap.rowPtr[cur + 1];
      for (let k = lap.rowPtr[cur]; k < end; k++) {
        const nb = lap.colIdx[k];
        if (!visited[nb]) {
          visited[nb] = 1;
          queue[qTail++] = nb;
        }
      }
    }

    if (!hasSeed) {
      // All vertices in this shell were occluded: seed nearest-Euclidean bone at each vertex in component
      for (let q = 0; q < qTail; q++) {
        const li = queue[q];
        const px = logicalCoords[li * 3], py = logicalCoords[li * 3 + 1], pz = logicalCoords[li * 3 + 2];
        const vertSide = px > sideDeadband ? 'left' : (px < -sideDeadband ? 'right' : 'center');
        let bestBi = 0, bestD = Infinity;
        for (let bi = 0; bi < boneCount; bi++) {
          const b = boneInfos[bi];
          let d = closestPointOnSegment(px, py, pz, b.startLocal.x, b.startLocal.y, b.startLocal.z, b.endLocal.x, b.endLocal.y, b.endLocal.z, cPt);
          if (b.side && b.side !== 'center' && vertSide !== 'center' && b.side !== vertSide) d *= 4.5;
          if (d < bestD) { bestD = d; bestBi = bi; }
        }
        rhsAll[bestBi * logicalCount + li] = 1.0;
        H[li] = Math.max(diagL[li], 1e-4) / Math.max(bestD * bestD, minD2Floor);
      }
    }
  }

  // Solve sparse SPD system for each bone in parallelizable vector form
  const logicalWeights = new Float64Array(logicalCount * boneCount);
  const bVec = new Float64Array(logicalCount);
  const xVec = new Float64Array(logicalCount);

  for (let bi = 0; bi < boneCount; bi++) {
    const offset = bi * logicalCount;
    let hasAnyRhs = false;
    for (let li = 0; li < logicalCount; li++) {
      const val = H[li] * rhsAll[offset + li];
      bVec[li] = val;
      if (val > 0) hasAnyRhs = true;
    }
    if (!hasAnyRhs) continue;

    solveSparseCG(lap, H, bVec, xVec);
    for (let li = 0; li < logicalCount; li++) {
      logicalWeights[li * boneCount + bi] = xVec[li] > 1e-5 ? xVec[li] : 0;
    }
  }

  // Map logical weights -> top 4 normalized influences on every mesh vertex
  const skinIndices = new Uint16Array(vertCount * 4);
  const skinWeights = new Float32Array(vertCount * 4);

  const logicalTopIdx = new Uint16Array(logicalCount * 4);
  const logicalTopW = new Float32Array(logicalCount * 4);
  const top4 = new Array(4);

  for (let li = 0; li < logicalCount; li++) {
    const base = li * boneCount;
    let cLen = 0;
    top4[0] = top4[1] = top4[2] = top4[3] = null;

    for (let bi = 0; bi < boneCount; bi++) {
      const w = logicalWeights[base + bi];
      if (w <= 1e-5) continue;
      if (cLen < 4 || w > top4[3].w) {
        const entry = { bi, w };
        if (cLen < 4) top4[cLen++] = entry;
        else top4[3] = entry;
        for (let k = cLen - 1; k > 0 && top4[k].w > top4[k - 1].w; k--) {
          const tmp = top4[k]; top4[k] = top4[k - 1]; top4[k - 1] = tmp;
        }
      }
    }

    let sumW = 0;
    for (let s = 0; s < cLen; s++) sumW += top4[s].w;
    const dst = li * 4;
    if (sumW > 1e-6) {
      for (let s = 0; s < cLen; s++) {
        logicalTopIdx[dst + s] = top4[s].bi;
        logicalTopW[dst + s] = top4[s].w / sumW;
      }
    } else {
      logicalTopIdx[dst] = 0;
      logicalTopW[dst] = 1.0;
    }
  }

  for (let i = 0; i < vertCount; i++) {
    const li = origToLogical[i];
    const src = li * 4;
    const dst = i * 4;
    skinIndices[dst] = logicalTopIdx[src];
    skinIndices[dst + 1] = logicalTopIdx[src + 1];
    skinIndices[dst + 2] = logicalTopIdx[src + 2];
    skinIndices[dst + 3] = logicalTopIdx[src + 3];
    skinWeights[dst] = logicalTopW[src];
    skinWeights[dst + 1] = logicalTopW[src + 1];
    skinWeights[dst + 2] = logicalTopW[src + 2];
    skinWeights[dst + 3] = logicalTopW[src + 3];
  }

  return { skinIndices, skinWeights, logicalCount };
}
