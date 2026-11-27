/**
 * @file normals.js
 * @description Blender-parity Normal and Shading calculation utilities:
 * - Recalculate Normals Outside (Shift+N) & Inside (Shift+Ctrl+N)
 * - Flip Normals
 * - Auto-Smooth with custom angle threshold (Splits sharp edge normals while smoothing curved surfaces)
 */

import * as THREE from 'three';

/**
 * Inverts the normal vectors and face winding of a geometry.
 * @param {THREE.BufferGeometry} geometry
 * @returns {THREE.BufferGeometry}
 */
export function flipNormals(geometry) {
  if (!geometry || !geometry.attributes.position) return geometry;

  const out = geometry.clone();
  const norm = out.attributes.normal;
  if (norm) {
    for (let i = 0; i < norm.count * 3; i++) {
      norm.array[i] = -norm.array[i];
    }
    norm.needsUpdate = true;
  }

  // Reverse triangle winding index
  const index = out.index;
  if (index) {
    const arr = index.array;
    for (let t = 0; t < index.count / 3; t++) {
      const tmp = arr[t * 3 + 1];
      arr[t * 3 + 1] = arr[t * 3 + 2];
      arr[t * 3 + 2] = tmp;
    }
    index.needsUpdate = true;
  } else {
    // Non-indexed: reverse each triplet in-place
    const pos = out.attributes.position;
    for (let t = 0; t < pos.count / 3; t++) {
      for (const attrName of ['position', 'normal', 'uv', 'color']) {
        const attr = out.attributes[attrName];
        if (!attr) continue;
        const sz = attr.itemSize;
        const o1 = (t * 3 + 1) * sz;
        const o2 = (t * 3 + 2) * sz;
        for (let c = 0; c < sz; c++) {
          const tmp = attr.array[o1 + c];
          attr.array[o1 + c] = attr.array[o2 + c];
          attr.array[o2 + c] = tmp;
        }
        attr.needsUpdate = true;
      }
    }
  }

  return out;
}

/**
 * Recalculates triangle winding and normals to point outward (or inward).
 * Blender's "Recalculate Normals Outside" (Shift+N)
 * @param {THREE.BufferGeometry} geometry
 * @param {boolean} [inside=false] If true, points normals inward
 * @returns {THREE.BufferGeometry}
 */
export function recalculateNormals(geometry, inside = false) {
  if (!geometry || !geometry.attributes.position) return geometry;

  const out = geometry.clone();
  const pos = out.attributes.position;
  const index = out.index;
  const numTris = Math.floor((index ? index.count : pos.count) / 3);
  if (numTris === 0) return out;

  const vIndex = (t, c) => (index ? index.getX(t * 3 + c) : t * 3 + c);

  // Weld duplicated positions so UV-seam splits still share topology.
  const weldIds = new Uint32Array(pos.count);
  const weldMap = new Map();
  for (let i = 0; i < pos.count; i++) {
    const key = `${Math.round(pos.getX(i) * 1e5)}_${Math.round(pos.getY(i) * 1e5)}_${Math.round(pos.getZ(i) * 1e5)}`;
    let id = weldMap.get(key);
    if (id === undefined) {
      id = i;
      weldMap.set(key, id);
    }
    weldIds[i] = id;
  }

  // Edge -> faces traversing it, with traversal direction.
  const edgeMap = new Map();
  for (let t = 0; t < numTris; t++) {
    for (let c = 0; c < 3; c++) {
      const a = weldIds[vIndex(t, c)];
      const b = weldIds[vIndex(t, (c + 1) % 3)];
      if (a === b) continue;
      const key = a < b ? `${a}_${b}` : `${b}_${a}`;
      let entry = edgeMap.get(key);
      if (!entry) {
        entry = [];
        edgeMap.set(key, entry);
      }
      entry.push({ face: t, from: a, to: b });
    }
  }

  // Propagate one consistent winding across each connected component.
  const adjacency = Array.from({ length: numTris }, () => []);
  let closed = true;
  for (const entry of edgeMap.values()) {
    if (entry.length !== 2) {
      closed = false;
      continue;
    }
    const [first, second] = entry;
    // Neighbours must traverse their shared edge in opposite directions.
    const sameDirection = first.from === second.from && first.to === second.to;
    adjacency[first.face].push({ face: second.face, sameDirection });
    adjacency[second.face].push({ face: first.face, sameDirection });
  }

  const flipped = new Int8Array(numTris).fill(-1);
  const queue = [];
  for (let seed = 0; seed < numTris; seed++) {
    if (flipped[seed] !== -1) continue;
    flipped[seed] = 0;
    queue.length = 0;
    queue.push(seed);
    while (queue.length > 0) {
      const face = queue.pop();
      for (const neighbour of adjacency[face]) {
        if (flipped[neighbour.face] !== -1) continue;
        flipped[neighbour.face] = flipped[face] ^ (neighbour.sameDirection ? 1 : 0);
        queue.push(neighbour.face);
      }
    }
  }

  const pA = new THREE.Vector3(), pB = new THREE.Vector3(), pC = new THREE.Vector3();
  const crossBC = new THREE.Vector3();

  // Which way does "outside" point? Signed volume is exact on closed meshes
  // (concave shells and tori included) and a bounding-box centre is not.
  let signedVolume6 = 0;
  for (let t = 0; t < numTris; t++) {
    pA.fromBufferAttribute(pos, vIndex(t, 0));
    pB.fromBufferAttribute(pos, vIndex(t, 1));
    pC.fromBufferAttribute(pos, vIndex(t, 2));
    const volume = pA.dot(crossBC.crossVectors(pB, pC));
    signedVolume6 += flipped[t] ? -volume : volume;
  }

  let pointsOutward;
  if (closed && Math.abs(signedVolume6) > 1e-12) {
    pointsOutward = signedVolume6 > 0;
  } else {
    // Open / nearly flat mesh: majority vote against the bounding-box centre.
    out.computeBoundingBox();
    const center = new THREE.Vector3();
    out.boundingBox.getCenter(center);
    const vAB = new THREE.Vector3(), vAC = new THREE.Vector3(), fn = new THREE.Vector3();
    const centroid = new THREE.Vector3();
    let outward = 0;
    let inward = 0;
    for (let t = 0; t < numTris; t++) {
      pA.fromBufferAttribute(pos, vIndex(t, 0));
      pB.fromBufferAttribute(pos, vIndex(t, 1));
      pC.fromBufferAttribute(pos, vIndex(t, 2));
      fn.crossVectors(vAB.subVectors(pB, pA), vAC.subVectors(pC, pA));
      if (flipped[t]) fn.negate();
      centroid.set(0, 0, 0).add(pA).add(pB).add(pC).multiplyScalar(1 / 3);
      if (fn.dot(centroid.sub(center)) >= 0) outward += 1;
      else inward += 1;
    }
    pointsOutward = outward >= inward;
  }

  const needGlobalFlip = pointsOutward === inside;

  for (let t = 0; t < numTris; t++) {
    if (!(needGlobalFlip ^ (flipped[t] === 1))) continue;

    if (index) {
      const i1 = index.getX(t * 3 + 1);
      const i2 = index.getX(t * 3 + 2);
      index.setX(t * 3 + 1, i2);
      index.setX(t * 3 + 2, i1);
    } else {
      for (const attrName of Object.keys(out.attributes)) {
        const attr = out.attributes[attrName];
        if (!attr || !attr.array || attr.isInterleavedBufferAttribute) continue;
        const sz = attr.itemSize;
        const o1 = (t * 3 + 1) * sz;
        const o2 = (t * 3 + 2) * sz;
        for (let c = 0; c < sz; c++) {
          const tmp = attr.array[o1 + c];
          attr.array[o1 + c] = attr.array[o2 + c];
          attr.array[o2 + c] = tmp;
        }
      }
    }
  }

  if (index) index.needsUpdate = true;
  out.computeVertexNormals();
  return out;
}

/**
 * Computes Blender-parity Auto-Smooth normals with dihedral angle threshold.
 * Surfaces with curvature angle <= threshold are smoothed; sharp corners > threshold
 * have crisp split normals.
 *
 * @param {THREE.BufferGeometry} geometry
 * @param {number} [angleThresholdRad=0.523598775] 30 degrees in radians
 * @returns {THREE.BufferGeometry}
 */
export function computeAutoSmoothNormals(geometry, angleThresholdRad = 30 * Math.PI / 180) {
  if (!geometry || !geometry.attributes.position) return geometry;

  // Un-index the geometry to allow independent corner normals for split edges
  const src = geometry.index ? geometry.toNonIndexed() : geometry.clone();
  const pos = src.attributes.position;
  const numTris = pos.count / 3;

  // 1. Calculate Face Normals
  const faceNormals = new Float32Array(numTris * 3);
  const pA = new THREE.Vector3(), pB = new THREE.Vector3(), pC = new THREE.Vector3();
  const vAB = new THREE.Vector3(), vAC = new THREE.Vector3(), fn = new THREE.Vector3();

  for (let t = 0; t < numTris; t++) {
    pA.fromBufferAttribute(pos, t * 3 + 0);
    pB.fromBufferAttribute(pos, t * 3 + 1);
    pC.fromBufferAttribute(pos, t * 3 + 2);

    vAB.subVectors(pB, pA);
    vAC.subVectors(pC, pA);
    fn.crossVectors(vAB, vAC).normalize();

    faceNormals[t * 3 + 0] = fn.x;
    faceNormals[t * 3 + 1] = fn.y;
    faceNormals[t * 3 + 2] = fn.z;
  }

  // 2. Spatial Hash to group corner vertices that share the same 3D position
  const coordMap = new Map();
  for (let i = 0; i < pos.count; i++) {
    const kx = Math.round(pos.getX(i) * 10000);
    const ky = Math.round(pos.getY(i) * 10000);
    const kz = Math.round(pos.getZ(i) * 10000);
    const key = `${kx}_${ky}_${kz}`;

    if (!coordMap.has(key)) coordMap.set(key, []);
    coordMap.get(key).push(i);
  }

  const outNormals = new Float32Array(pos.count * 3);
  const cosThreshold = Math.cos(angleThresholdRad);

  // 3. For each vertex corner, accumulate face normals of adjacent faces whose
  // dihedral angle difference is <= threshold (dot product >= cosThreshold)
  for (const cornerIndices of coordMap.values()) {
    for (const cIdx of cornerIndices) {
      const myTriIdx = Math.floor(cIdx / 3);
      const myNx = faceNormals[myTriIdx * 3 + 0];
      const myNy = faceNormals[myTriIdx * 3 + 1];
      const myNz = faceNormals[myTriIdx * 3 + 2];

      let accumX = 0, accumY = 0, accumZ = 0;

      for (const otherIdx of cornerIndices) {
        const otherTriIdx = Math.floor(otherIdx / 3);
        const otherNx = faceNormals[otherTriIdx * 3 + 0];
        const otherNy = faceNormals[otherTriIdx * 3 + 1];
        const otherNz = faceNormals[otherTriIdx * 3 + 2];

        const dot = myNx * otherNx + myNy * otherNy + myNz * otherNz;
        if (dot >= cosThreshold) {
          accumX += otherNx;
          accumY += otherNy;
          accumZ += otherNz;
        }
      }

      const len = Math.hypot(accumX, accumY, accumZ) || 1.0;
      outNormals[cIdx * 3 + 0] = accumX / len;
      outNormals[cIdx * 3 + 1] = accumY / len;
      outNormals[cIdx * 3 + 2] = accumZ / len;
    }
  }

  src.setAttribute('normal', new THREE.BufferAttribute(outNormals, 3));
  return src;
}
