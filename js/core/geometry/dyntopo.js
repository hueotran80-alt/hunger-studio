/**
 * Dynamic Topology (Dyntopo) Conformal Longest-Edge Bisection & Short-Edge Collapse
 * Subdivides and refines triangle density locally under a sculpt brush without T-junction cracks.
 * File: js/core/geometry/dyntopo.js
 */

import * as THREE from 'three';
import { weldMesh } from './pro-modifiers.js';

function edgeKey(a, b) {
  return a < b ? `${a}_${b}` : `${b}_${a}`;
}

/**
 * Ensures geometry is indexed & welded cleanly for conformal edge-sharing bisection.
 */
export function prepareIndexedSculptMesh(geometry, mask = null) {
  let geom = geometry;
  let maskOut = mask ? new Float32Array(mask) : null;

  if (!geom.index) {
    // Weld coincident vertices cleanly while transferring mask
    const srcPos = geom.attributes.position;
    const welded = weldMesh(geom, { distance: 1e-5 });
    if (maskOut && maskOut.length === srcPos.count) {
      const dstPos = welded.attributes.position;
      const newMask = new Float32Array(dstPos.count);
      const map = new Map();
      const inv = 1e5;
      for (let i = 0; i < srcPos.count; i++) {
        const k = `${Math.round(srcPos.getX(i) * inv)}_${Math.round(srcPos.getY(i) * inv)}_${Math.round(srcPos.getZ(i) * inv)}`;
        if (!map.has(k)) map.set(k, maskOut[i]);
      }
      for (let i = 0; i < dstPos.count; i++) {
        const k = `${Math.round(dstPos.getX(i) * inv)}_${Math.round(dstPos.getY(i) * inv)}_${Math.round(dstPos.getZ(i) * inv)}`;
        newMask[i] = map.get(k) || 0;
      }
      maskOut = newMask;
    }
    geom = welded;
  } else {
    geom = geom.clone();
  }
  return { geom, mask: maskOut };
}

/**
 * Conformal local edge bisection + optional short-edge collapse within `(center, radius)`.
 * Preserves vertex mask, UV, normals cleanly with zero T-junctions.
 */
export function refineDyntopoRegion(geometry, localCenter, localRadius, detailSize = 0.08, sculptMask = null, options = {}) {
  const maxSplits = Math.max(4, Math.min(256, options.maxSplits ?? 80));
  const detail = Math.max(0.004, Number(detailSize) || 0.08);
  const splitThreshSq = (detail * 1.35) ** 2;
  const collapseThreshSq = (detail * 0.40) ** 2;
  const maxVertBudget = options.maxVertices ?? 120000;

  const prepared = prepareIndexedSculptMesh(geometry, sculptMask);
  const geom = prepared.geom;
  const posAttr = geom.attributes.position;
  const idxAttr = geom.index;
  if (!posAttr || !idxAttr) {
    return { geometry: geom, mask: prepared.mask, splitCount: 0, collapseCount: 0, changed: false };
  }

  const pos = Array.from(posAttr.array);
  const hasUv = Boolean(geom.attributes.uv);
  const uv = hasUv ? Array.from(geom.attributes.uv.array) : null;
  const mask = prepared.mask ? Array.from(prepared.mask) : new Array(posAttr.count).fill(0);
  const tris = [];
  for (let i = 0; i + 2 < idxAttr.count; i += 3) {
    const a = idxAttr.getX(i), b = idxAttr.getX(i + 1), c = idxAttr.getX(i + 2);
    if (a !== b && b !== c && c !== a) tris.push([a, b, c]);
  }

  const r2 = localRadius * localRadius;
  const cx = localCenter.x, cy = localCenter.y, cz = localCenter.z;

  const distSqVert = (vi) => {
    const dx = pos[vi * 3] - cx;
    const dy = pos[vi * 3 + 1] - cy;
    const dz = pos[vi * 3 + 2] - cz;
    return dx * dx + dy * dy + dz * dz;
  };
  const edgeLenSq = (a, b) => {
    const dx = pos[a * 3] - pos[b * 3];
    const dy = pos[a * 3 + 1] - pos[b * 3 + 1];
    const dz = pos[a * 3 + 2] - pos[b * 3 + 2];
    return dx * dx + dy * dy + dz * dz;
  };

  // Build edge -> incident tri list dynamically
  const buildEdgeMap = () => {
    const map = new Map();
    for (let ti = 0; ti < tris.length; ti++) {
      const tr = tris[ti];
      if (!tr) continue;
      for (let e = 0; e < 3; e++) {
        const u = tr[e], v = tr[(e + 1) % 3];
        const k = edgeKey(u, v);
        let list = map.get(k);
        if (!list) { list = []; map.set(k, list); }
        list.push(ti);
      }
    }
    return map;
  };

  let splitCount = 0;
  let edgeMap = buildEdgeMap();

  // Pass 1: Conformal longest-edge bisection across all triangles inside brush sphere
  for (let pass = 0; pass < 3 && splitCount < maxSplits && (pos.length / 3) < maxVertBudget; pass++) {
    let passSplits = 0;
    const triLimit = tris.length;
    for (let ti = 0; ti < triLimit && splitCount < maxSplits; ti++) {
      const tr = tris[ti];
      if (!tr) continue;
      const [a, b, c] = tr;
      if (distSqVert(a) > r2 && distSqVert(b) > r2 && distSqVert(c) > r2) {
        // Also check triangle centroid in sphere
        const mx = (pos[a * 3] + pos[b * 3] + pos[c * 3]) / 3 - cx;
        const my = (pos[a * 3 + 1] + pos[b * 3 + 1] + pos[c * 3 + 1]) / 3 - cy;
        const mz = (pos[a * 3 + 2] + pos[b * 3 + 2] + pos[c * 3 + 2]) / 3 - cz;
        if (mx * mx + my * my + mz * mz > r2) continue;
      }

      const l01 = edgeLenSq(a, b);
      const l12 = edgeLenSq(b, c);
      const l20 = edgeLenSq(c, a);
      const maxL = Math.max(l01, l12, l20);
      if (maxL <= splitThreshSq) continue;

      let ea = a, eb = b;
      if (l12 >= l01 && l12 >= l20) { ea = b; eb = c; }
      else if (l20 >= l01 && l20 >= l12) { ea = c; eb = a; }

      const k = edgeKey(ea, eb);
      const inc = edgeMap.get(k);
      if (!inc || inc.length === 0) continue;

      // Allocate midpoint vertex
      const mIdx = pos.length / 3;
      pos.push(
        0.5 * (pos[ea * 3] + pos[eb * 3]),
        0.5 * (pos[ea * 3 + 1] + pos[eb * 3 + 1]),
        0.5 * (pos[ea * 3 + 2] + pos[eb * 3 + 2])
      );
      if (uv) {
        uv.push(0.5 * (uv[ea * 2] + uv[eb * 2]), 0.5 * (uv[ea * 2 + 1] + uv[eb * 2 + 1]));
      }
      mask.push(0.5 * (mask[ea] + mask[eb]));

      // Split EVERY triangle touching (ea, eb) simultaneously -> ZERO T-junction cracks!
      const affectedTris = inc.slice();
      edgeMap.delete(k);
      for (const adjTi of affectedTris) {
        const atr = tris[adjTi];
        if (!atr) continue;
        // Find vertex order matching (u, v, opp) preserving winding!
        let u = -1, v = -1, opp = -1;
        for (let e = 0; e < 3; e++) {
          const p = atr[e], q = atr[(e + 1) % 3], r = atr[(e + 2) % 3];
          if ((p === ea && q === eb) || (p === eb && q === ea)) {
            u = p; v = q; opp = r; break;
          }
        }
        if (u === -1) continue;
        // Replace adjTi with (u, mIdx, opp) and append (mIdx, v, opp)
        tris[adjTi] = [u, mIdx, opp];
        const newTi = tris.length;
        tris.push([mIdx, v, opp]);

        // Update edge map entries
        const registerEdge = (x, y, idx) => {
          const ek = edgeKey(x, y);
          let arr = edgeMap.get(ek);
          if (!arr) { arr = []; edgeMap.set(ek, arr); }
          arr.push(idx);
        };
        const replaceTriRef = (x, y, oldIdx, nextIdx) => {
          const arr = edgeMap.get(edgeKey(x, y));
          if (arr) {
            const p = arr.indexOf(oldIdx);
            if (p !== -1) arr[p] = nextIdx;
          }
        };
        replaceTriRef(v, opp, adjTi, newTi);
        registerEdge(u, mIdx, adjTi);
        registerEdge(mIdx, opp, adjTi);
        registerEdge(mIdx, v, newTi);
        registerEdge(opp, mIdx, newTi);
      }

      splitCount++;
      passSplits++;
    }
    if (passSplits === 0) break;
  }

  // Pass 2: Safe interior short-edge collapse (prevents micro-triangle spikes)
  let collapseCount = 0;
  if (splitCount === 0 && tris.length > 16) {
    const remap = new Int32Array(pos.length / 3);
    for (let i = 0; i < remap.length; i++) remap[i] = i;
    const findRoot = (x) => { while (remap[x] !== x) x = remap[x]; return x; };

    for (const [, inc] of edgeMap.entries()) {
      if (collapseCount >= 24) break;
      if (inc.length !== 2) continue; // Only manifold interior edges
      const t0 = tris[inc[0]], t1 = tris[inc[1]];
      if (!t0 || !t1) continue;
      // Find shared endpoints (ea, eb) and distinct opposite verts
      const shared = [];
      for (const v of t0) if (t1.includes(v)) shared.push(v);
      if (shared.length !== 2) continue;
      const a = findRoot(shared[0]), b = findRoot(shared[1]);
      if (a === b) continue;
      if (distSqVert(a) > r2 || distSqVert(b) > r2) continue;
      if (edgeLenSq(a, b) >= collapseThreshSq) continue;
      if (mask[a] > 0.5 || mask[b] > 0.5) continue;

      // Merge b -> midpoint into a
      pos[a * 3] = 0.5 * (pos[a * 3] + pos[b * 3]);
      pos[a * 3 + 1] = 0.5 * (pos[a * 3 + 1] + pos[b * 3 + 1]);
      pos[a * 3 + 2] = 0.5 * (pos[a * 3 + 2] + pos[b * 3 + 2]);
      remap[b] = a;
      collapseCount++;
    }

    if (collapseCount > 0) {
      for (let ti = 0; ti < tris.length; ti++) {
        const tr = tris[ti];
        if (!tr) continue;
        const a = findRoot(tr[0]), b = findRoot(tr[1]), c = findRoot(tr[2]);
        if (a === b || b === c || c === a) tris[ti] = null;
        else tris[ti] = [a, b, c];
      }
    }
  }

  if (splitCount === 0 && collapseCount === 0) {
    geom.dispose();
    return { geometry: null, mask: null, splitCount: 0, collapseCount: 0, changed: false };
  }

  const finalIndices = [];
  for (let ti = 0; ti < tris.length; ti++) {
    const tr = tris[ti];
    if (tr) finalIndices.push(tr[0], tr[1], tr[2]);
  }

  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  if (uv) out.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  out.setIndex(finalIndices);
  out.computeVertexNormals();
  out.computeBoundingBox();
  out.computeBoundingSphere();

  geom.dispose();
  return {
    geometry: out,
    mask: new Float32Array(mask),
    splitCount,
    collapseCount,
    changed: true,
  };
}
