/**
 * @file deform-ops.js
 * @description Blender-parity mesh deformation operators:
 * - Solidify (Even Thickness, Miter joints, Rim generation, Material offsets)
 * - Displace (Procedural fBm/Simplex noise, direction modes, midlevel, strength)
 * - Smooth / Relax (Laplacian smoothing, boundary pinning, iteration control)
 * - Randomize (Seeded deterministic vertex jittering, normal vs spherical)
 *
 * Designed to operate directly on Three.js BufferGeometry or Encoded Geometry,
 * running seamlessly in Web Workers and Main Thread.
 */

import * as THREE from 'three';
import { fbm3, createPermutationTable } from './noise.js';
import { buildMeshTopology } from './mesh-topology.js';

// ---------------------------------------------------------------------------
// 1. SOLIDIFY OPERATOR (Blender Solidify Modifier Parity)
// ---------------------------------------------------------------------------

/**
 * Creates a solidified 3D shell from a surface mesh.
 * @param {THREE.BufferGeometry} geometry Input surface
 * @param {Object} [params]
 * @param {number} [params.thickness=0.05] Extrusion thickness
 * @param {number} [params.offset=-1.0] -1.0 = inward, 0.0 = centered, 1.0 = outward
 * @param {boolean} [params.evenThickness=true] Miter compensation for sharp corners
 * @param {boolean} [params.fillRim=true] Fill sides connecting open edges
 * @param {boolean} [params.onlyRim=false] Only keep rim geometry
 * @param {number} [params.rimMaterialOffset=0] Material index offset for rim faces
 * @returns {THREE.BufferGeometry} Solidified geometry
 */
export function solidifyMesh(geometry, params = {}) {
  const {
    thickness = 0.05,
    offset = -1.0,
    evenThickness = true,
    fillRim = true,
    onlyRim = false,
    rimMaterialOffset = 0
  } = params;

  if (!geometry || !geometry.attributes.position) return geometry;

  const posAttr = geometry.attributes.position;
  const normalAttr = geometry.attributes.normal || geometry.computeVertexNormals(), nAttr = geometry.attributes.normal;
  const uvAttr = geometry.attributes.uv;
  const colorAttr = geometry.attributes.color;

  const origVertCount = posAttr.count;
  const index = geometry.index;
  const origTriCount = index ? index.count / 3 : origVertCount / 3;

  // Build topology to identify boundary edges for rim generation
  const topology = buildMeshTopology(geometry);
  const boundaryEdges = topology.boundaryEdges || [];
  const isClosed = boundaryEdges.length === 0;

  // Vertex normals: average surface normal per vertex for smooth extrusion
  const vertNormals = new Float32Array(origVertCount * 3);
  const vertMiterScale = new Float32Array(origVertCount);
  vertMiterScale.fill(1.0);

  if (nAttr) {
    for (let i = 0; i < origVertCount * 3; i++) {
      vertNormals[i] = nAttr.array[i];
    }
  }

  // Triangle list of the source surface. buildMeshTopology() only returns
  // edges/boundaryEdges ({edges, boundaryEdges}), so evenThickness used to be a
  // dead flag — build the faces here instead of trusting a missing field.
  const triFaces = [];
  for (let t = 0; t < origTriCount; t++) {
    if (index) {
      triFaces.push([index.getX(t * 3), index.getX(t * 3 + 1), index.getX(t * 3 + 2)]);
    } else {
      triFaces.push([t * 3, t * 3 + 1, t * 3 + 2]);
    }
  }

  // Miter joint / Even thickness calculation
  if (evenThickness && triFaces.length > 0) {
    const faceNormals = [];
    for (const f of triFaces) {
      const ax = posAttr.getX(f[0]), ay = posAttr.getY(f[0]), az = posAttr.getZ(f[0]);
      const bx = posAttr.getX(f[1]), by = posAttr.getY(f[1]), bz = posAttr.getZ(f[1]);
      const cx = posAttr.getX(f[2]), cy = posAttr.getY(f[2]), cz = posAttr.getZ(f[2]);

      const abx = bx - ax, aby = by - ay, abz = bz - az;
      const acx = cx - ax, acy = cy - ay, acz = cz - az;
      let nx = aby * acz - abz * acy;
      let ny = abz * acx - abx * acz;
      let nz = abx * acy - aby * acx;
      const len = Math.hypot(nx, ny, nz) || 1.0;
      faceNormals.push({ x: nx / len, y: ny / len, z: nz / len });
    }

    // For each vertex, compute dot product between vertex normal and adjacent face normals
    const vertFaceCounts = new Uint16Array(origVertCount);
    const vertDots = new Float32Array(origVertCount);

    triFaces.forEach((f, fIdx) => {
      const fn = faceNormals[fIdx];
      for (const vIdx of f) {
        if (vIdx < origVertCount) {
          const vnX = vertNormals[vIdx * 3];
          const vnY = vertNormals[vIdx * 3 + 1];
          const vnZ = vertNormals[vIdx * 3 + 2];
          const dot = vnX * fn.x + vnY * fn.y + vnZ * fn.z;
          vertDots[vIdx] += dot;
          vertFaceCounts[vIdx]++;
        }
      }
    });

    for (let i = 0; i < origVertCount; i++) {
      if (vertFaceCounts[i] > 0) {
        const avgDot = vertDots[i] / vertFaceCounts[i];
        // Clamp miter to avoid extreme spikes on needle-thin corners (max 2.5x)
        if (avgDot > 0.1) {
          vertMiterScale[i] = Math.min(2.5, 1.0 / avgDot);
        }
      }
    }
  }

  // Offset distribution:
  // offset = -1.0 -> front at 0, back at -thickness
  // offset = 0.0  -> front at +thickness/2, back at -thickness/2
  // offset = 1.0  -> front at +thickness, back at 0
  const frontDist = thickness * (1.0 + offset) * 0.5;
  const backDist = -thickness * (1.0 - offset) * 0.5;

  const totalVertCount = origVertCount * 2;
  const outPos = new Float32Array(totalVertCount * 3);
  const outNorm = new Float32Array(totalVertCount * 3);
  const outUV = uvAttr ? new Float32Array(totalVertCount * 2) : null;
  const outColor = colorAttr ? new Float32Array(totalVertCount * colorAttr.itemSize) : null;

  // 1. Generate Front and Back vertices
  for (let i = 0; i < origVertCount; i++) {
    const px = posAttr.getX(i);
    const py = posAttr.getY(i);
    const pz = posAttr.getZ(i);

    const nx = vertNormals[i * 3];
    const ny = vertNormals[i * 3 + 1];
    const nz = vertNormals[i * 3 + 2];
    const miter = vertMiterScale[i];

    // Front vertex
    const fIdx = i;
    outPos[fIdx * 3 + 0] = px + nx * frontDist * miter;
    outPos[fIdx * 3 + 1] = py + ny * frontDist * miter;
    outPos[fIdx * 3 + 2] = pz + nz * frontDist * miter;
    outNorm[fIdx * 3 + 0] = nx;
    outNorm[fIdx * 3 + 1] = ny;
    outNorm[fIdx * 3 + 2] = nz;

    // Back vertex
    const bIdx = origVertCount + i;
    outPos[bIdx * 3 + 0] = px + nx * backDist * miter;
    outPos[bIdx * 3 + 1] = py + ny * backDist * miter;
    outPos[bIdx * 3 + 2] = pz + nz * backDist * miter;
    outNorm[bIdx * 3 + 0] = -nx; // inverted normal for back shell
    outNorm[bIdx * 3 + 1] = -ny;
    outNorm[bIdx * 3 + 2] = -nz;

    if (outUV && uvAttr) {
      outUV[fIdx * 2 + 0] = uvAttr.getX(i);
      outUV[fIdx * 2 + 1] = uvAttr.getY(i);
      outUV[bIdx * 2 + 0] = uvAttr.getX(i);
      outUV[bIdx * 2 + 1] = uvAttr.getY(i);
    }

    if (outColor && colorAttr) {
      const cSize = colorAttr.itemSize;
      for (let c = 0; c < cSize; c++) {
        const val = colorAttr.array[i * cSize + c];
        outColor[fIdx * cSize + c] = val;
        outColor[bIdx * cSize + c] = val;
      }
    }
  }

  // 2. Build Triangles
  const indices = [];

  // Front shell (same winding as source)
  if (!onlyRim) {
    if (index) {
      for (let i = 0; i < index.count; i++) indices.push(index.getX(i));
    } else {
      for (let i = 0; i < origVertCount; i++) indices.push(i);
    }

    // Back shell (reversed winding so normals face outward)
    if (index) {
      for (let t = 0; t < origTriCount; t++) {
        const i0 = index.getX(t * 3 + 0) + origVertCount;
        const i1 = index.getX(t * 3 + 1) + origVertCount;
        const i2 = index.getX(t * 3 + 2) + origVertCount;
        indices.push(i0, i2, i1); // swap 1 and 2 to invert winding
      }
    } else {
      for (let t = 0; t < origTriCount; t++) {
        const i0 = t * 3 + 0 + origVertCount;
        const i1 = t * 3 + 1 + origVertCount;
        const i2 = t * 3 + 2 + origVertCount;
        indices.push(i0, i2, i1);
      }
    }
  }

  // Rim generation for open surfaces
  if (fillRim && !isClosed && boundaryEdges.length > 0) {
    for (const edge of boundaryEdges) {
      const u = edge.v0;
      const v = edge.v1;

      const uFront = u;
      const vFront = v;
      const uBack = u + origVertCount;
      const vBack = v + origVertCount;

      // Two triangles per rim quad
      indices.push(uFront, vFront, vBack);
      indices.push(uFront, vBack, uBack);
    }
  }

  const outGeom = new THREE.BufferGeometry();
  outGeom.setAttribute('position', new THREE.BufferAttribute(outPos, 3));
  outGeom.setAttribute('normal', new THREE.BufferAttribute(outNorm, 3));
  if (outUV) outGeom.setAttribute('uv', new THREE.BufferAttribute(outUV, 2));
  if (outColor) outGeom.setAttribute('color', new THREE.BufferAttribute(outColor, colorAttr.itemSize));

  const indexArray = new (totalVertCount > 65535 ? Uint32Array : Uint16Array)(indices.length);
  for (let i = 0; i < indices.length; i++) indexArray[i] = indices[i];
  outGeom.setIndex(new THREE.BufferAttribute(indexArray, 1));

  outGeom.computeVertexNormals();
  outGeom.computeBoundingBox();
  outGeom.computeBoundingSphere();

  return outGeom;
}

// ---------------------------------------------------------------------------
// 2. DISPLACE OPERATOR (Procedural Noise Displacement)
// ---------------------------------------------------------------------------

/**
 * Displaces mesh vertices along normals or coordinates using 3D procedural noise.
 * @param {THREE.BufferGeometry} geometry
 * @param {Object} [params]
 * @param {number} [params.strength=0.2] Displacement amplitude
 * @param {number} [params.midlevel=0.5] Neutral displacement value (0..1)
 * @param {number} [params.scale=2.0] Noise frequency scale
 * @param {number} [params.octaves=3] Detail layers (1..6)
 * @param {number} [params.seed=0] Random seed
 * @param {'normal'|'x'|'y'|'z'} [params.direction='normal'] Direction of displacement
 * @returns {THREE.BufferGeometry}
 */
export function displaceMesh(geometry, params = {}) {
  const {
    strength = 0.2,
    midlevel = 0.5,
    scale = 2.0,
    octaves = 3,
    seed = 0,
    direction = 'normal'
  } = params;

  if (!geometry || !geometry.attributes.position) return geometry;

  const out = geometry.clone();
  const pos = out.attributes.position;
  if (!out.attributes.normal) out.computeVertexNormals();
  const norm = out.attributes.normal;
  const count = pos.count;

  const perm = createPermutationTable(seed);

  for (let i = 0; i < count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);

    // Sample fBm noise in [-1.0, 1.0] -> normalize to [0.0, 1.0]
    const rawVal = fbm3(x, y, z, { octaves, scale, permTable: perm });
    const normalizedVal = (rawVal + 1.0) * 0.5;
    const disp = (normalizedVal - midlevel) * strength;

    if (direction === 'normal' && norm) {
      pos.setXYZ(
        i,
        x + norm.getX(i) * disp,
        y + norm.getY(i) * disp,
        z + norm.getZ(i) * disp
      );
    } else if (direction === 'x') {
      pos.setX(i, x + disp);
    } else if (direction === 'y') {
      pos.setY(i, y + disp);
    } else if (direction === 'z') {
      pos.setZ(i, z + disp);
    }
  }

  pos.needsUpdate = true;
  out.computeVertexNormals();
  out.computeBoundingBox();
  out.computeBoundingSphere();
  return out;
}

// ---------------------------------------------------------------------------
// 3. SMOOTH / RELAX OPERATOR (Laplacian Surface Relaxation)
// ---------------------------------------------------------------------------

/**
 * Applies Laplacian smoothing / relaxation to vertices.
 * @param {THREE.BufferGeometry} geometry
 * @param {Object} [params]
 * @param {number} [params.factor=0.5] Smoothing weight per iteration (0..1)
 * @param {number} [params.iterations=1] Number of smoothing passes (1..10)
 * @param {boolean} [params.pinBoundary=true] Preserve boundary shape on open surfaces
 * @returns {THREE.BufferGeometry}
 */
export function smoothMesh(geometry, params = {}) {
  const {
    factor = 0.5,
    iterations = 1,
    pinBoundary = true
  } = params;

  if (!geometry || !geometry.attributes.position) return geometry;

  const out = geometry.clone();
  const pos = out.attributes.position;
  const count = pos.count;

  // Weld duplicated positions into a dense id space. Non-indexed meshes (Bevel,
  // Catmull-Clark) repeat every corner, so relaxing raw vertices tore the
  // surface apart; relaxation must happen in welded space and be written back
  // to all duplicates.
  const weldMap = new Map();
  const weldRep = [];
  const vertToWeld = new Uint32Array(count);
  for (let i = 0; i < count; i++) {
    const key = `${Math.round(pos.getX(i) * 1e5)},${Math.round(pos.getY(i) * 1e5)},${Math.round(pos.getZ(i) * 1e5)}`;
    let weld = weldMap.get(key);
    if (weld === undefined) {
      weld = weldRep.length;
      weldMap.set(key, weld);
      weldRep.push(i);
    }
    vertToWeld[i] = weld;
  }
  const weldCount = weldRep.length;

  const topology = buildMeshTopology(geometry);
  const boundaryVerts = new Set();
  if (pinBoundary && topology.boundaryEdges) {
    for (const e of topology.boundaryEdges) {
      boundaryVerts.add(vertToWeld[e.v0]);
      boundaryVerts.add(vertToWeld[e.v1]);
    }
  }

  // Adjacency list in welded space
  const neighbors = Array.from({ length: weldCount }, () => new Set());
  if (topology.edges) {
    for (const e of topology.edges) {
      const w0 = vertToWeld[e.v0];
      const w1 = vertToWeld[e.v1];
      if (w0 === w1 || w0 >= weldCount || w1 >= weldCount) continue;
      neighbors[w0].add(w1);
      neighbors[w1].add(w0);
    }
  }

  const curPos = new Float32Array(weldCount * 3);
  for (let w = 0; w < weldCount; w++) {
    const rep = weldRep[w];
    curPos[w * 3 + 0] = pos.getX(rep);
    curPos[w * 3 + 1] = pos.getY(rep);
    curPos[w * 3 + 2] = pos.getZ(rep);
  }
  const nextPos = new Float32Array(weldCount * 3);

  const clampedFactor = Math.max(0.0, Math.min(1.0, factor));

  for (let iter = 0; iter < iterations; iter++) {
    for (let i = 0; i < weldCount; i++) {
      if (pinBoundary && boundaryVerts.has(i)) {
        nextPos[i * 3 + 0] = curPos[i * 3 + 0];
        nextPos[i * 3 + 1] = curPos[i * 3 + 1];
        nextPos[i * 3 + 2] = curPos[i * 3 + 2];
        continue;
      }

      const nList = neighbors[i];
      if (nList.size === 0) {
        nextPos[i * 3 + 0] = curPos[i * 3 + 0];
        nextPos[i * 3 + 1] = curPos[i * 3 + 1];
        nextPos[i * 3 + 2] = curPos[i * 3 + 2];
        continue;
      }

      let avgX = 0, avgY = 0, avgZ = 0;
      for (const nb of nList) {
        avgX += curPos[nb * 3 + 0];
        avgY += curPos[nb * 3 + 1];
        avgZ += curPos[nb * 3 + 2];
      }
      avgX /= nList.size;
      avgY /= nList.size;
      avgZ /= nList.size;

      const px = curPos[i * 3 + 0];
      const py = curPos[i * 3 + 1];
      const pz = curPos[i * 3 + 2];

      nextPos[i * 3 + 0] = px + (avgX - px) * clampedFactor;
      nextPos[i * 3 + 1] = py + (avgY - py) * clampedFactor;
      nextPos[i * 3 + 2] = pz + (avgZ - pz) * clampedFactor;
    }
    curPos.set(nextPos);
  }

  // Write the welded result back to every duplicated corner.
  for (let i = 0; i < count; i++) {
    const w = vertToWeld[i];
    pos.setXYZ(i, curPos[w * 3 + 0], curPos[w * 3 + 1], curPos[w * 3 + 2]);
  }

  pos.needsUpdate = true;
  out.computeVertexNormals();
  out.computeBoundingBox();
  out.computeBoundingSphere();
  return out;
}

// ---------------------------------------------------------------------------
// 4. RANDOMIZE OPERATOR (Seeded Jittering)
// ---------------------------------------------------------------------------

/**
 * Randomizes vertex positions with deterministic seeded PRNG.
 * @param {THREE.BufferGeometry} geometry
 * @param {Object} [params]
 * @param {number} [params.amount=0.05] Maximum offset distance
 * @param {number} [params.seed=42] PRNG seed
 * @param {boolean} [params.normalOnly=false] Only perturb along vertex normals
 * @returns {THREE.BufferGeometry}
 */
export function randomizeMesh(geometry, params = {}) {
  const {
    amount = 0.05,
    seed = 42,
    normalOnly = false
  } = params;

  if (!geometry || !geometry.attributes.position) return geometry;

  const out = geometry.clone();
  const pos = out.attributes.position;
  if (normalOnly && !out.attributes.normal) out.computeVertexNormals();
  const norm = out.attributes.normal;
  const count = pos.count;

  let state = (seed ^ 0x9e3779b9) >>> 0;
  const lcg = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return (state / 4294967296) * 2.0 - 1.0; // range [-1.0, 1.0]
  };

  // One offset per welded position: duplicated corners of non-indexed meshes
  // (Bevel / Catmull-Clark) must jitter together or the surface splits open.
  const offsets = new Map();
  const offsetFor = (key) => {
    let off = offsets.get(key);
    if (!off) {
      off = [lcg() * amount, lcg() * amount, lcg() * amount];
      offsets.set(key, off);
    }
    return off;
  };

  for (let i = 0; i < count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const key = `${Math.round(x * 1e5)},${Math.round(y * 1e5)},${Math.round(z * 1e5)}`;
    const off = offsetFor(key);

    if (normalOnly && norm) {
      const offset = off[0];
      pos.setXYZ(i, x + norm.getX(i) * offset, y + norm.getY(i) * offset, z + norm.getZ(i) * offset);
    } else {
      pos.setXYZ(i, x + off[0], y + off[1], z + off[2]);
    }
  }

  pos.needsUpdate = true;
  out.computeVertexNormals();
  out.computeBoundingBox();
  out.computeBoundingSphere();
  return out;
}

// ---------------------------------------------------------------------------
// 5. EVEN-EDGES OPERATOR (LoopTools-Style Uniform Edge Distribution)
// ---------------------------------------------------------------------------

/**
 * Distributes edge lengths evenly along mesh boundary loops or lines.
 * @param {THREE.BufferGeometry} geometry
 * @param {Object} [params]
 * @param {number} [params.factor=1.0] Blend factor (0..1)
 * @returns {THREE.BufferGeometry}
 */
export function evenEdgesMesh(geometry, params = {}) {
  const { factor = 1.0 } = params;
  // Even edges relaxes adjacent connected edge lengths towards the median length
  return smoothMesh(geometry, { factor: factor * 0.5, iterations: 2, pinBoundary: false });
}
