/**
 * @file modifiers.js
 * @description Blender-style Procedural Modifiers Engine for Web Blender Studio.
 * Implements non-destructive modifier stack evaluation on THREE.Mesh:
 * - ArrayModifier: Linear cloning with relative & constant stride offsets
 * - MirrorModifier: Symmetry across X, Y, and Z axes with seam merging & normal flipping
 * - WireframeModifier: Polygonal strut lattice generation with solid joints
 * - SubdivisionModifier: Loop / Catmull-Clark smooth surface subdivision
 * - BevelModifier: Chamfer edge insetting & profile beveling
 */

import * as THREE from 'three';
import { solidifyMesh, displaceMesh, smoothMesh, randomizeMesh } from './geometry/deform-ops.js';
import { bevelMesh } from './geometry/bevel.js';
import { subdivideCatmullClark } from './geometry/catmull-clark.js';
import {
  decimateMesh,
  screwMesh,
  weightedNormalMesh,
  buildParametricCutterGeometry
} from './geometry/hard-surface-ops.js';
import {
  shrinkwrapMesh,
  curveDeformMesh,
  latticeDeformMesh,
  skinMesh,
  remeshGeometry,
  weldMesh,
  simpleDeformMesh,
  castMesh,
  waveMesh,
  dataTransferMesh
} from './geometry/pro-modifiers.js';
import { evaluateCurveSpine } from './curve-objects.js';

// =============================================================================
// GEOMETRY UTILITIES
// =============================================================================

/**
 * Robustly merges multiple THREE.BufferGeometry instances into a single BufferGeometry.
 * Works offline without external cdn dependencies.
 * @param {THREE.BufferGeometry[]} geometries 
 * @returns {THREE.BufferGeometry}
 */
export function mergeBufferGeometries(geometries, useGroups = false) {
  if (!geometries || geometries.length === 0) {
    return new THREE.BufferGeometry();
  }
  if (geometries.length === 1) {
    const single = geometries[0].clone();
    if (useGroups) {
      single.clearGroups();
      single.addGroup(0, single.attributes.position.count, 0);
    }
    return single;
  }

  // Convert all geometries to non-indexed for universal attribute merging
  const nonIndexed = geometries.map((g) => {
    return g.index ? g.toNonIndexed() : g.clone();
  });

  let totalPosCount = 0;
  let totalNormCount = 0;
  let totalUvCount = 0;

  for (const g of nonIndexed) {
    if (g.attributes.position) totalPosCount += g.attributes.position.array.length;
    if (g.attributes.normal) totalNormCount += g.attributes.normal.array.length;
    if (g.attributes.uv) totalUvCount += g.attributes.uv.array.length;
  }

  const mergedPos = new Float32Array(totalPosCount);
  const mergedNorm = totalNormCount > 0 ? new Float32Array(totalPosCount) : null;
  const mergedUv = totalUvCount > 0 ? new Float32Array((totalPosCount / 3) * 2) : null;

  let posOffset = 0;
  let normOffset = 0;
  let uvOffset = 0;
  const groupRanges = [];

  for (const g of nonIndexed) {
    const vertCount = g.attributes.position ? g.attributes.position.count : 0;
    if (useGroups) groupRanges.push({ start: posOffset / 3, count: vertCount });
    if (g.attributes.position) {
      mergedPos.set(g.attributes.position.array, posOffset);
      posOffset += g.attributes.position.array.length;
    }
    if (mergedNorm && g.attributes.normal) {
      mergedNorm.set(g.attributes.normal.array, normOffset);
      normOffset += g.attributes.normal.array.length;
    }
    if (mergedUv && g.attributes.uv) {
      mergedUv.set(g.attributes.uv.array, uvOffset);
      uvOffset += g.attributes.uv.array.length;
    }
    g.dispose();
  }

  const merged = new THREE.BufferGeometry();
  merged.setAttribute('position', new THREE.BufferAttribute(mergedPos, 3));
  if (mergedNorm) {
    merged.setAttribute('normal', new THREE.BufferAttribute(mergedNorm, 3));
  } else {
    merged.computeVertexNormals();
  }
  if (mergedUv) {
    merged.setAttribute('uv', new THREE.BufferAttribute(mergedUv, 2));
  }

  if (useGroups) {
    groupRanges.forEach((r, i) => merged.addGroup(r.start, r.count, i));
  }

  merged.computeBoundingBox();
  merged.computeBoundingSphere();
  return merged;
}

/**
 * Extracts unique edges from a geometry.
 * @param {THREE.BufferGeometry} geometry 
 * @returns {Array<[THREE.Vector3, THREE.Vector3]>}
 */
export function extractUniqueEdges(geometry) {
  const nonIndexed = geometry.index ? geometry.toNonIndexed() : geometry;
  const pos = nonIndexed.attributes.position;
  if (!pos) return [];

  const edges = [];
  const edgeSet = new Set();
  const vA = new THREE.Vector3();
  const vB = new THREE.Vector3();
  const vC = new THREE.Vector3();

  const coordKey = (v) => `${Math.round(v.x * 1000) / 1000},${Math.round(v.y * 1000) / 1000},${Math.round(v.z * 1000) / 1000}`;

  const triCount = Math.floor(pos.count / 3);
  for (let t = 0; t < triCount; t++) {
    vA.fromBufferAttribute(pos, t * 3 + 0);
    vB.fromBufferAttribute(pos, t * 3 + 1);
    vC.fromBufferAttribute(pos, t * 3 + 2);

    const kA = coordKey(vA);
    const kB = coordKey(vB);
    const kC = coordKey(vC);

    const testEdge = (p1, p2, k1, k2) => {
      if (k1 === k2) return;
      const key = k1 < k2 ? `${k1}|${k2}` : `${k2}|${k1}`;
      if (!edgeSet.has(key)) {
        edgeSet.add(key);
        edges.push([p1.clone(), p2.clone()]);
      }
    };

    testEdge(vA, vB, kA, kB);
    testEdge(vB, vC, kB, kC);
    testEdge(vC, vA, kC, kA);
  }

  if (geometry.index && nonIndexed !== geometry) {
    nonIndexed.dispose();
  }

  return edges;
}

// =============================================================================
// MODIFIER IMPLEMENTATIONS
// =============================================================================

/**
 * 1. ArrayModifier
 * Duplicates the geometry linearly across specified count and offset strides.
 */
export class ArrayModifier {
  static get defaultParams() {
    return {
      count: 3,
      offset: { x: 1.5, y: 0.0, z: 0.0 },
      useRelativeOffset: true,
      useConstantOffset: false,
      constantOffset: { x: 0.0, y: 0.0, z: 0.0 }
    };
  }

  /**
   * @param {THREE.BufferGeometry} geometry 
   * @param {Object} params 
   * @returns {THREE.BufferGeometry}
   */
  static execute(geometry, params = {}) {
    const p = { ...this.defaultParams, ...params };
    const count = Math.max(1, Math.min(50, Math.floor(p.count || 1)));
    if (count <= 1) return geometry.clone();

    geometry.computeBoundingBox();
    const bbox = geometry.boundingBox || new THREE.Box3();
    const size = new THREE.Vector3();
    bbox.getSize(size);
    if (size.x === 0) size.x = 1;
    if (size.y === 0) size.y = 1;
    if (size.z === 0) size.z = 1;

    const step = new THREE.Vector3(0, 0, 0);
    if (p.useRelativeOffset !== false) {
      const rx = p.offset?.x !== undefined ? p.offset.x : 1.5;
      const ry = p.offset?.y !== undefined ? p.offset.y : 0.0;
      const rz = p.offset?.z !== undefined ? p.offset.z : 0.0;
      step.x += rx * size.x;
      step.y += ry * size.y;
      step.z += rz * size.z;
    }
    if (p.useConstantOffset) {
      step.x += p.constantOffset?.x || 0.0;
      step.y += p.constantOffset?.y || 0.0;
      step.z += p.constantOffset?.z || 0.0;
    }

    const clones = [];
    for (let i = 0; i < count; i++) {
      const g = geometry.clone();
      const translation = step.clone().multiplyScalar(i);
      g.translate(translation.x, translation.y, translation.z);
      clones.push(g);
    }

    return mergeBufferGeometries(clones);
  }
}

/**
 * 2. MirrorModifier
 * Symmetrically mirrors the geometry across the X, Y, or Z plane with normal correction and seam merging.
 */
export class MirrorModifier {
  static get defaultParams() {
    return {
      mirrorX: true,
      mirrorY: false,
      mirrorZ: false,
      merge: true,
      mergeThreshold: 0.005
    };
  }

  /**
   * @param {THREE.BufferGeometry} geometry 
   * @param {Object} params 
   * @returns {THREE.BufferGeometry}
   */
  static execute(geometry, params = {}) {
    const p = { ...this.defaultParams, ...params };
    const axes = [];
    if (p.mirrorX) axes.push('x');
    if (p.mirrorY) axes.push('y');
    if (p.mirrorZ) axes.push('z');

    if (axes.length === 0) {
      return geometry.clone();
    }

    let currentList = [geometry.clone()];

    for (const axis of axes) {
      const nextList = [];
      for (const geom of currentList) {
        nextList.push(geom);

        // Create mirrored copy
        const mirrored = geom.index ? geom.toNonIndexed() : geom.clone();
        const pos = mirrored.attributes.position;
        const norm = mirrored.attributes.normal;
        const uv = mirrored.attributes.uv;

        const axisIdx = axis === 'x' ? 0 : (axis === 'y' ? 1 : 2);

        // Negate axis coordinates and normals
        for (let i = 0; i < pos.count; i++) {
          pos.array[i * 3 + axisIdx] = -pos.array[i * 3 + axisIdx];
          if (norm) {
            norm.array[i * 3 + axisIdx] = -norm.array[i * 3 + axisIdx];
          }
        }

        // Invert triangle winding order to preserve outward facing normals
        for (let t = 0; t < pos.count; t += 3) {
          const v1 = (t + 1) * 3;
          const v2 = (t + 2) * 3;
          for (let k = 0; k < 3; k++) {
            const tempP = pos.array[v1 + k];
            pos.array[v1 + k] = pos.array[v2 + k];
            pos.array[v2 + k] = tempP;

            if (norm) {
              const tempN = norm.array[v1 + k];
              norm.array[v1 + k] = norm.array[v2 + k];
              norm.array[v2 + k] = tempN;
            }
          }

          if (uv) {
            const u1 = (t + 1) * 2;
            const u2 = (t + 2) * 2;
            for (let k = 0; k < 2; k++) {
              const tempU = uv.array[u1 + k];
              uv.array[u1 + k] = uv.array[u2 + k];
              uv.array[u2 + k] = tempU;
            }
          }
        }

        pos.needsUpdate = true;
        if (norm) norm.needsUpdate = true;

        nextList.push(mirrored);
      }
      currentList = nextList;
    }

    const merged = mergeBufferGeometries(currentList);

    // Merge vertices within threshold on mirror plane
    if (p.merge && p.mergeThreshold > 0) {
      const pos = merged.attributes.position;
      const thresh = p.mergeThreshold;
      for (const axis of axes) {
        const axisIdx = axis === 'x' ? 0 : (axis === 'y' ? 1 : 2);
        for (let i = 0; i < pos.count; i++) {
          if (Math.abs(pos.array[i * 3 + axisIdx]) <= thresh) {
            pos.array[i * 3 + axisIdx] = 0.0;
          }
        }
      }
      pos.needsUpdate = true;
      merged.computeVertexNormals();
    }

    return merged;
  }
}

/**
 * 3. WireframeModifier
 * Replaces or wraps mesh faces into solid 3D polygonal tubular struts.
 */
export class WireframeModifier {
  static get defaultParams() {
    return {
      thickness: 0.03,
      replaceOriginal: true
    };
  }

  /**
   * @param {THREE.BufferGeometry} geometry 
   * @param {Object} params 
   * @returns {THREE.BufferGeometry}
   */
  static execute(geometry, params = {}) {
    const p = { ...this.defaultParams, ...params };
    const thickness = Math.max(0.005, Math.min(0.5, p.thickness || 0.03));
    const radius = thickness * 0.5;

    const edges = extractUniqueEdges(geometry);
    if (edges.length === 0) return geometry.clone();

    const parts = [];
    const up = new THREE.Vector3(0, 1, 0);
    const mid = new THREE.Vector3();
    const dir = new THREE.Vector3();
    const q = new THREE.Quaternion();

    // Generate polygonal cylinder struts for each edge
    for (const [pA, pB] of edges) {
      const length = pA.distanceTo(pB);
      if (length < 0.0001) continue;

      const strut = new THREE.CylinderGeometry(radius, radius, length, 5, 1, false);
      mid.addVectors(pA, pB).multiplyScalar(0.5);
      dir.subVectors(pB, pA).normalize();

      q.setFromUnitVectors(up, dir);
      strut.applyQuaternion(q);
      strut.translate(mid.x, mid.y, mid.z);
      parts.push(strut);
    }

    // Generate joint spheres at unique vertices to seal strut intersections
    const pos = (geometry.index ? geometry.toNonIndexed() : geometry).attributes.position;
    const vertexSet = new Set();
    const v = new THREE.Vector3();
    const sphereRadius = radius * 1.15;
    const jointGeom = new THREE.SphereGeometry(sphereRadius, 6, 4);

    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i);
      const key = `${Math.round(v.x * 500)},${Math.round(v.y * 500)},${Math.round(v.z * 500)}`;
      if (!vertexSet.has(key)) {
        vertexSet.add(key);
        const joint = jointGeom.clone();
        joint.translate(v.x, v.y, v.z);
        parts.push(joint);
      }
    }
    jointGeom.dispose();

    const wireframeMesh = mergeBufferGeometries(parts);

    if (!p.replaceOriginal) {
      return mergeBufferGeometries([geometry.clone(), wireframeMesh]);
    }

    return wireframeMesh;
  }
}

/**
 * 4. SubdivisionModifier
 * Blender-parity Catmull-Clark & Simple subdivision surface smoothing.
 */
export class SubdivisionModifier {
  static get defaultParams() {
    return {
      subdivisions: 1,
      renderLevels: 2,
      subdivisionType: 'catmull-clark',
      crease: 0.0,
      uvSmooth: true,
      smooth: true
    };
  }

  /**
   * @param {THREE.BufferGeometry} geometry 
   * @param {Object} params 
   * @returns {THREE.BufferGeometry}
   */
  static execute(geometry, params = {}) {
    const p = { ...this.defaultParams, ...params };
    const rawLevels = p._renderQuality ? (p.renderLevels ?? p.subdivisions ?? p.levels ?? 1) : (p.subdivisions ?? p.levels ?? 1);
    const levels = Math.max(0, Math.min(4, Math.floor(rawLevels)));
    if (levels <= 0) return geometry.clone();
    const type = p.subdivisionType || (p.smooth === false ? 'simple' : 'catmull-clark');

    return subdivideCatmullClark(geometry, {
      levels,
      subdivisionType: type,
      crease: p.crease ?? 0.0,
      uvSmooth: p.uvSmooth !== false
    });
  }
}

/**
 * 5. BevelModifier
 * Blender-parity Edge Chamfer & Rounding Bevel modifier.
 */
export class BevelModifier {
  static get defaultParams() {
    return {
      width: 0.08,
      segments: 1,
      profile: 0.5,
      clampOverlap: true,
      limitMethod: 'none',
      angleLimitDeg: 30,
      hardenNormals: false
    };
  }

  /**
   * @param {THREE.BufferGeometry} geometry 
   * @param {Object} params 
   * @returns {THREE.BufferGeometry}
   */
  static execute(geometry, params = {}) {
    return bevelMesh(geometry, { ...this.defaultParams, ...params });
  }
}

/**
 * 6. SolidifyModifier
 * Thickens a surface into a watertight volumetric shell with even miter thickness and rims.
 */
export class SolidifyModifier {
  static get defaultParams() {
    return {
      thickness: 0.05,
      offset: -1.0,
      evenThickness: true,
      fillRim: true,
      onlyRim: false
    };
  }

  static execute(geometry, params = {}) {
    return solidifyMesh(geometry, { ...this.defaultParams, ...params });
  }
}

/**
 * 7. DisplaceModifier
 * Deforms geometry along normals or world axes using multi-octave fBm procedural noise.
 */
export class DisplaceModifier {
  static get defaultParams() {
    return {
      strength: 0.2,
      midlevel: 0.5,
      scale: 2.0,
      octaves: 3,
      seed: 0,
      direction: 'normal'
    };
  }

  static execute(geometry, params = {}) {
    return displaceMesh(geometry, { ...this.defaultParams, ...params });
  }
}

/**
 * 8. SmoothModifier
 * Relaxes mesh vertices using Laplacian smoothing while preserving boundary perimeters.
 */
export class SmoothModifier {
  static get defaultParams() {
    return {
      factor: 0.5,
      iterations: 1,
      pinBoundary: true
    };
  }

  static execute(geometry, params = {}) {
    return smoothMesh(geometry, { ...this.defaultParams, ...params });
  }
}

/**
 * 9. RandomizeModifier
 * Jitters mesh vertex positions deterministically using seeded pseudo-random noise.
 */
export class RandomizeModifier {
  static get defaultParams() {
    return {
      amount: 0.05,
      seed: 42,
      normalOnly: false
    };
  }

  static execute(geometry, params = {}) {
    return randomizeMesh(geometry, { ...this.defaultParams, ...params });
  }
}

// =============================================================================
// BOOLEAN CSG (three-bvh-csg — cắt/gọt thật, khác 'bevel' chỉ inset mặt)
// =============================================================================

import { Evaluator, Brush, SUBTRACTION, ADDITION, INTERSECTION, DIFFERENCE } from 'three-bvh-csg';
const UNION = ADDITION;

/**
 * Chạy Boolean thật giữa 2 mesh dùng chung không gian thế giới (world space):
 * - `brushA` là mesh chính (thường là mesh đang chọn).
 * - `brushB` là mesh cắt/gọt (được trả về bind pose sau thao tác, không xoá).
 * - `op`: 'difference' | 'union' | 'intersect' | 'subtract' (alias).
 *
 * Trả về geometry kết quả trong **local space của brushA** nên gắn thẳng
 * vào mesh gốc mà không lệch vị trí.
 *
 * @param {THREE.Mesh} brushA
 * @param {THREE.Mesh} brushB
 * @param {'difference'|'union'|'intersect'} op
 * @returns {THREE.BufferGeometry|null}
 */
export function performBoolean(brushA, brushB, op = 'difference') {
  if (!brushA?.isMesh || !brushB?.isMesh) {
    console.warn('[Modifiers] Boolean requires 2 valid meshes.');
    return null;
  }
  brushA.updateWorldMatrix(true, false);
  brushB.updateWorldMatrix(true, false);

  // In three-bvh-csg, SUBTRACTION is A - B (Blender Difference), while DIFFERENCE is symmetric XOR.
  const OP_MAP = {
    difference: SUBTRACTION,
    subtract: SUBTRACTION,
    union: UNION,
    intersect: INTERSECTION,
    xor: DIFFERENCE,
  };
  const opKey = (op || 'difference').toLowerCase();
  const csgOp = OP_MAP[opKey] !== undefined ? OP_MAP[opKey] : SUBTRACTION;

  const geoA = brushA.geometry.clone();
  const geoB = brushB.geometry.clone();
  if (!geoA.attributes.normal) geoA.computeVertexNormals();
  if (!geoB.attributes.normal) geoB.computeVertexNormals();
  const hasUv = Boolean(geoA.attributes.uv && geoB.attributes.uv);

  const a = new Brush(geoA);
  a.updateMatrixWorld();
  const b = new Brush(geoB);
  b.updateMatrixWorld();

  // Đưa cả 2 brush vào cùng hệ quy chiếu thế giới để CSG đúng vị trí thật.
  a.matrixWorld.copy(brushA.matrixWorld);
  a.matrix.copy(brushA.matrixWorld);
  b.matrixWorld.copy(brushB.matrixWorld);
  b.matrix.copy(brushB.matrixWorld);

  const evaluator = new Evaluator();
  evaluator.useGroups = false; // giữ 1 material để không vỡ multi-material
  evaluator.attributes = hasUv ? ['position', 'normal', 'uv'] : ['position', 'normal'];

  try {
    const result = evaluator.evaluate(a, b, csgOp);
    // result là Group/BufferGeometry trong world space — quy về local của brushA.
    const geom = result.geometry || (result.children?.[0]?.geometry);
    if (!geom) return null;
    const invA = new THREE.Matrix4().copy(brushA.matrixWorld).invert();
    const local = geom.clone().applyMatrix4(invA);
    local.computeBoundingBox();
    local.computeBoundingSphere();
    if (local.attributes.position && local.attributes.position.count > 0) {
      local.computeVertexNormals();
    }
    return local;
  } catch (err) {
    console.error('[Modifiers] Boolean failed:', err);
    return null;
  }
}

/**
 * Áp Boolean ngay và thay geometry của mesh chính (undo bằng sceneManager
 * hoặc caller tự quản lý).
 * @returns {THREE.BufferGeometry|null} geometry mới đã gắn vào mesh chính.
 */
export function applyBoolean(meshTarget, meshTool, op = 'difference') {
  const geom = performBoolean(meshTarget, meshTool, op);
  if (!geom || !geom.attributes?.position || geom.attributes.position.count === 0) {
    if (geom?.dispose) geom.dispose();
    return null;
  }
  if (meshTarget.geometry) meshTarget.geometry.dispose();
  meshTarget.geometry = geom;
  return geom;
}

/**
 * Boolean bất đồng bộ: cặp mesh lớn đẩy sang Web Worker (CSG) để không chặn UI;
 * mesh nhỏ / không Worker / worker lỗi fallback về performBoolean đồng bộ.
 */
export async function performBooleanAsync(brushA, brushB, op = 'difference', { minTriangles } = {}) {
  if (!brushA?.isMesh || !brushB?.isMesh) return performBoolean(brushA, brushB, op);
  // Lazy import: tránh kéo worker-client vào module worker khi nạp modifiers.
  const { geometryWorkerAvailable, csgInWorker, triangleCount, WORKER_CSG_MIN_TRIANGLES } = await import('./geometry-worker-client.js');
  const total = triangleCount(brushA.geometry) + triangleCount(brushB.geometry);
  if (!geometryWorkerAvailable() || total < (minTriangles ?? WORKER_CSG_MIN_TRIANGLES)) return performBoolean(brushA, brushB, op);
  brushA.updateWorldMatrix(true, false);
  brushB.updateMatrixWorld(true, false);
  try {
    const out = await csgInWorker(
      brushA.geometry, brushB.geometry,
      brushA.matrixWorld.toArray(), brushB.matrixWorld.toArray(), op
    );
    if (!out) return null;
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(out.position, 3));
    if (out.normal) geom.setAttribute('normal', new THREE.BufferAttribute(out.normal, 3));
    if (out.uv) geom.setAttribute('uv', new THREE.BufferAttribute(out.uv, 2));
    if (out.index) geom.setIndex(new THREE.BufferAttribute(out.index, 1));
    geom.applyMatrix4(new THREE.Matrix4().copy(brushA.matrixWorld).invert());
    geom.computeBoundingBox();
    geom.computeBoundingSphere();
    geom.computeVertexNormals();
    return geom;
  } catch (err) {
    console.warn('[Modifiers] worker boolean failed, fallback CPU:', err?.message);
    return performBoolean(brushA, brushB, op);
  }
}

export async function applyBooleanAsync(meshTarget, meshTool, op = 'difference') {
  const geom = await performBooleanAsync(meshTarget, meshTool, op);
  if (!geom) return null;
  if (meshTarget.geometry) meshTarget.geometry.dispose();
  meshTarget.geometry = geom;
  return geom;
}

// =============================================================================
// HARD-SURFACE MODIFIERS (Boolean, Decimate, Screw, Weighted Normal)
// =============================================================================

function _normalizeCSGAttributes(geomA, geomB) {
  const countA = geomA?.attributes?.position?.count || 0;
  const countB = geomB?.attributes?.position?.count || 0;
  if (countA < 3 || countB < 3) return false;

  if (!geomA.attributes.normal) geomA.computeVertexNormals();
  if (!geomB.attributes.normal) geomB.computeVertexNormals();

  if (!geomA.attributes.uv) {
    geomA.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(countA * 2), 2));
  }
  if (!geomB.attributes.uv) {
    geomB.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(countB * 2), 2));
  }

  // three-bvh-csg requires identical attribute sets between brushA and brushB
  for (const attr of ['color', 'tangent']) {
    const aAttr = geomA.attributes[attr];
    const bAttr = geomB.attributes[attr];
    if (!aAttr || !bAttr || aAttr.itemSize !== bAttr.itemSize) {
      if (aAttr) geomA.deleteAttribute(attr);
      if (bAttr) geomB.deleteAttribute(attr);
    }
  }
  return true;
}

function _decodeEncodedCutter(enc) {
  if (!enc || !enc.position) return null;
  const g = new THREE.BufferGeometry();
  const posArr = enc.position instanceof Float32Array ? enc.position.slice() : new Float32Array(enc.position);
  g.setAttribute('position', new THREE.BufferAttribute(posArr, 3));
  if (enc.normal) {
    const nArr = enc.normal instanceof Float32Array ? enc.normal.slice() : new Float32Array(enc.normal);
    g.setAttribute('normal', new THREE.BufferAttribute(nArr, 3));
  }
  if (enc.uv) {
    const uvArr = enc.uv instanceof Float32Array ? enc.uv.slice() : new Float32Array(enc.uv);
    g.setAttribute('uv', new THREE.BufferAttribute(uvArr, 2));
  }
  if (enc.index) {
    const idxArr = enc.index instanceof Uint32Array ? enc.index.slice() : new Uint32Array(enc.index);
    g.setIndex(new THREE.BufferAttribute(idxArr, 1));
  }
  return g;
}

/**
 * Resolves a scene cutter mesh by ID, UUID, or exact name.
 * @param {string} targetId
 * @param {string} targetName
 * @param {Object|null} [sceneManager]
 * @param {THREE.Object3D|null} [excludeMesh]
 * @returns {THREE.Mesh|null}
 */
export function resolveSceneCutter(targetId, targetName, sceneManager = null, excludeMesh = null) {
  const sm = sceneManager || (typeof window !== 'undefined' ? window.sceneManager : null);
  if (!sm) return null;

  if (targetId && typeof sm.resolveObject === 'function') {
    const direct = sm.resolveObject(targetId);
    if (direct && direct !== excludeMesh && direct.isMesh) return direct;
  }

  const all = typeof sm.getAllObjects === 'function'
    ? sm.getAllObjects()
    : Array.from(sm.objects?.values() || []);

  if (targetId) {
    const byId = all.find((o) =>
      o !== excludeMesh && o.isMesh && (o.userData?.id === targetId || o.uuid === targetId)
    );
    if (byId) return byId;
  }

  if (targetName) {
    const byName = all.find((o) => o !== excludeMesh && o.isMesh && o.name === targetName);
    if (byName) return byName;
  }

  return null;
}

/**
 * Returns cloned modifier descriptors with transient cutter snapshots attached
 * (`_cutterEncoded`, `_relativeMatrix`) for worker/sync Boolean evaluation
 * without mutating `mesh.userData.modifierStack`.
 */
export function prepareBooleanDescriptors(hostMesh, descriptors, sceneManager = null) {
  const list = Array.isArray(descriptors) ? descriptors : [];
  return list.map((d) => {
    const cloned = { ...d, params: { ...(d.params || {}) } };
    const normType = String(cloned.type || '').toLowerCase();
    if (cloned.enabled === false) return cloned;

    const p = cloned.params;
    const targetNeeded = normType === 'boolean' || normType === 'bool' || normType === 'shrinkwrap' || normType === 'data_transfer' || normType === 'curve';
    if (!targetNeeded) return cloned;

    if ((p.targetId || p.targetName) && !p._cutterEncoded && !p._targetEncoded && !p._curveSpine) {
      const targetObj = resolveSceneCutter(p.targetId, p.targetName, sceneManager, hostMesh);
      if (targetObj?.isMesh && targetObj.geometry?.attributes?.position) {
        hostMesh?.updateWorldMatrix?.(true, false);
        targetObj.updateWorldMatrix(true, false);

        const relMat = hostMesh
          ? new THREE.Matrix4().copy(hostMesh.matrixWorld).invert().multiply(targetObj.matrixWorld)
          : targetObj.matrixWorld.clone();
        p._relativeMatrix = relMat.toArray();

        if (normType === 'curve' && targetObj.userData?.curveData) {
          p._curveSpine = evaluateCurveSpine(targetObj.userData.curveData);
        } else {
          const cg = targetObj.geometry;
          const enc = {
            position: cg.attributes.position.array.slice(),
            normal: cg.attributes.normal ? cg.attributes.normal.array.slice() : null,
            uv: cg.attributes.uv ? cg.attributes.uv.array.slice() : null,
            color: cg.attributes.color ? cg.attributes.color.array.slice() : null,
            colorItemSize: cg.attributes.color?.itemSize || 3,
            index: cg.index ? new Uint32Array(cg.index.array) : null,
          };
          if (normType === 'boolean' || normType === 'bool') p._cutterEncoded = enc;
          else p._targetEncoded = enc;
        }
      }
    }
    return cloned;
  });
}

/**
 * Switches a Boolean cutter mesh between wire/bounds/hidden/solid display modes
 * cleanly while preserving its original PBR material for restore.
 */
export function setCutterDisplayMode(cutterMesh, mode = 'wire') {
  if (!cutterMesh || !cutterMesh.isMesh) return;
  const nextMode = String(mode || 'wire').toLowerCase();

  if (nextMode === 'solid') {
    if (cutterMesh.userData.__boolOrigMaterial) {
      cutterMesh.material = cutterMesh.userData.__boolOrigMaterial;
      delete cutterMesh.userData.__boolOrigMaterial;
    }
    if (cutterMesh.userData.__boolHelperMaterial) {
      cutterMesh.userData.__boolHelperMaterial.dispose?.();
      delete cutterMesh.userData.__boolHelperMaterial;
    }
    cutterMesh.visible = true;
    cutterMesh.userData.visible = true;
    cutterMesh.userData.__boolDisplayMode = 'solid';
    return;
  }

  if (nextMode === 'hidden') {
    if (cutterMesh.userData.__boolOrigMaterial) {
      cutterMesh.material = cutterMesh.userData.__boolOrigMaterial;
      delete cutterMesh.userData.__boolOrigMaterial;
    }
    if (cutterMesh.userData.__boolHelperMaterial) {
      cutterMesh.userData.__boolHelperMaterial.dispose?.();
      delete cutterMesh.userData.__boolHelperMaterial;
    }
    cutterMesh.visible = false;
    cutterMesh.userData.visible = false;
    cutterMesh.userData.__boolDisplayMode = 'hidden';
    return;
  }

  // 'wire' or 'bounds'
  if (!cutterMesh.userData.__boolOrigMaterial && !cutterMesh.userData.__boolHelperMaterial) {
    cutterMesh.userData.__boolOrigMaterial = cutterMesh.material;
  }
  if (cutterMesh.userData.__boolHelperMaterial && cutterMesh.userData.__boolDisplayMode !== nextMode) {
    cutterMesh.userData.__boolHelperMaterial.dispose?.();
    delete cutterMesh.userData.__boolHelperMaterial;
  }
  if (!cutterMesh.userData.__boolHelperMaterial) {
    const isBounds = nextMode === 'bounds';
    cutterMesh.userData.__boolHelperMaterial = new THREE.MeshBasicMaterial({
      color: isBounds ? 0x00d2d3 : 0xff9f43,
      wireframe: true,
      transparent: true,
      opacity: isBounds ? 0.35 : 0.6,
      depthWrite: false,
    });
  }
  cutterMesh.material = cutterMesh.userData.__boolHelperMaterial;
  cutterMesh.visible = true;
  cutterMesh.userData.visible = true;
  cutterMesh.userData.__boolDisplayMode = nextMode;
}

/**
 * Synchronizes display states for all Boolean cutters in the scene; restores
 * any cutter mesh no longer referenced by an active Boolean modifier to solid.
 */
export function syncBooleanCuttersInScene(sceneManager = null) {
  const sm = sceneManager || (typeof window !== 'undefined' ? window.sceneManager : null);
  if (!sm) return 0;

  const objects = typeof sm.getAllObjects === 'function'
    ? sm.getAllObjects()
    : Array.from(sm.objects?.values() || []);

  const activeCutters = new Map();
  for (const obj of objects) {
    if (!obj?.isMesh) continue;
    const stack = obj.userData?.modifierStack;
    if (!Array.isArray(stack)) continue;
    for (const mod of stack) {
      const t = String(mod?.type || '').toLowerCase();
      if ((t !== 'boolean' && t !== 'bool') || mod.enabled === false) continue;
      const p = mod.params || {};
      if (!p.targetId && !p.targetName) continue;
      const cutter = resolveSceneCutter(p.targetId, p.targetName, sm, obj);
      if (cutter && cutter.isMesh) {
        activeCutters.set(cutter, p.cutterDisplay || 'wire');
      }
    }
  }

  for (const [cutter, displayMode] of activeCutters.entries()) {
    cutter.userData._isBooleanCutter = true;
    setCutterDisplayMode(cutter, displayMode);
  }

  for (const obj of objects) {
    if (!obj?.isMesh || !obj.userData?._isBooleanCutter) continue;
    if (!activeCutters.has(obj)) {
      setCutterDisplayMode(obj, 'solid');
      delete obj.userData._isBooleanCutter;
    }
  }

  return activeCutters.size;
}

/**
 * 10. BooleanModifier
 * Non-destructive CSG Boolean (Difference / Union / Intersect) supporting both
 * live scene object cutters and self-contained parametric cutters.
 */
export class BooleanModifier {
  static get defaultParams() {
    return {
      operation: 'difference',
      operandType: 'primitive',
      targetId: '',
      targetName: '',
      cutterDisplay: 'wire',
      solver: 'manifold',
      cutterPrimitive: 'box',
      cutterSize: 1.0,
      cutterOffset: { x: 0.45, y: 0.45, z: 0.45 },
      cutterRotation: { x: 0, y: 0, z: 0 },
      cutterScale: { x: 1, y: 1, z: 1 }
    };
  }

  static execute(geometry, params = {}) {
    if (!geometry?.attributes?.position) return geometry;
    const cfg = { ...this.defaultParams, ...params };

    const opKey = String(cfg.operation || 'difference').toLowerCase();
    const OP_MAP = {
      difference: SUBTRACTION,
      subtract: SUBTRACTION,
      union: UNION,
      intersect: INTERSECTION,
      xor: DIFFERENCE,
    };
    const csgOp = OP_MAP[opKey] !== undefined ? OP_MAP[opKey] : SUBTRACTION;

    let cutterGeom = null;
    if (cfg._cutterEncoded?.position) {
      cutterGeom = _decodeEncodedCutter(cfg._cutterEncoded);
      if (cutterGeom && Array.isArray(cfg._relativeMatrix) && cfg._relativeMatrix.length === 16) {
        cutterGeom.applyMatrix4(new THREE.Matrix4().fromArray(cfg._relativeMatrix));
      }
    } else if (cfg.cutterGeometry?.isBufferGeometry) {
      cutterGeom = cfg.cutterGeometry.clone();
      if (cfg.relativeMatrix?.isMatrix4) {
        cutterGeom.applyMatrix4(cfg.relativeMatrix);
      } else if (Array.isArray(cfg.relativeMatrix) && cfg.relativeMatrix.length === 16) {
        cutterGeom.applyMatrix4(new THREE.Matrix4().fromArray(cfg.relativeMatrix));
      }
    } else if (cfg.targetId || cfg.targetName) {
      const cutterMesh = resolveSceneCutter(cfg.targetId, cfg.targetName);
      if (cutterMesh?.isMesh && cutterMesh.geometry?.attributes?.position) {
        cutterGeom = cutterMesh.geometry.clone();
        cutterMesh.updateWorldMatrix(true, false);
        if (Array.isArray(cfg._relativeMatrix) && cfg._relativeMatrix.length === 16) {
          cutterGeom.applyMatrix4(new THREE.Matrix4().fromArray(cfg._relativeMatrix));
        } else if (cfg._hostMatrixWorld) {
          const hostInv = new THREE.Matrix4().fromArray(cfg._hostMatrixWorld).invert();
          cutterGeom.applyMatrix4(hostInv.multiply(cutterMesh.matrixWorld));
        }
      } else if (cfg.operandType === 'object') {
        return geometry.clone();
      }
    } else if (cfg.operandType === 'object') {
      return geometry.clone();
    } else {
      cutterGeom = buildParametricCutterGeometry(cfg);
    }

    if (!cutterGeom) return geometry.clone();

    const geomA = geometry.clone();
    if (!_normalizeCSGAttributes(geomA, cutterGeom)) {
      geomA.dispose();
      cutterGeom.dispose();
      return geometry.clone();
    }

    const a = new Brush(geomA);
    a.updateMatrixWorld();
    const b = new Brush(cutterGeom);
    b.updateMatrixWorld();

    const evaluator = new Evaluator();
    evaluator.useGroups = false;

    try {
      const result = evaluator.evaluate(a, b, csgOp);
      const out = result?.geometry || result?.children?.[0]?.geometry;
      geomA.dispose();
      cutterGeom.dispose();
      if (!out || !out.attributes?.position?.count) {
        return geometry.clone();
      }
      out.clearGroups();
      out.computeVertexNormals();
      out.computeBoundingBox();
      out.computeBoundingSphere();
      return out;
    } catch (err) {
      console.warn('[Modifiers] Boolean modifier evaluation skipped:', err?.message || err);
      geomA.dispose();
      cutterGeom.dispose();
      return geometry.clone();
    }
  }
}

/**
 * 11. DecimateModifier
 * Polygon reduction via edge collapse, planar dissolution, or un-subdivide.
 */
export class DecimateModifier {
  static get defaultParams() {
    return {
      mode: 'collapse',
      ratio: 0.5,
      angleLimitDeg: 15,
      iterations: 1,
      preserveBoundaries: true
    };
  }

  static execute(geometry, params = {}) {
    const merged = { ...this.defaultParams, ...params };
    if (
      merged.mode === 'collapse' &&
      (!geometry.groups || geometry.groups.length <= 1) &&
      !geometry?.attributes?.color &&
      !geometry?.attributes?.skinIndex &&
      !geometry?.attributes?.tangent &&
      typeof globalThis !== 'undefined' &&
      typeof globalThis.__WBS_MESH_KERNEL_QEM__ === 'function' &&
      geometry?.attributes?.position
    ) {
      const ratio = Number.isFinite(merged.ratio) ? merged.ratio : 0.5;
      if (ratio < 0.999) {
        const res = globalThis.__WBS_MESH_KERNEL_QEM__(
          geometry.attributes.position.array,
          geometry.index ? geometry.index.array : null,
          {
            uvs: geometry.attributes.uv ? geometry.attributes.uv.array : null,
            ratio,
            lockBorders: merged.preserveBoundaries !== false,
          }
        );
        if (res && res.indices.length >= 3) {
          const out = new THREE.BufferGeometry();
          out.setAttribute('position', new THREE.BufferAttribute(res.vertices, 3));
          out.setAttribute('normal', new THREE.BufferAttribute(res.normals, 3));
          if (res.uvs && res.uvs.length === (res.vertices.length / 3) * 2) {
            out.setAttribute('uv', new THREE.BufferAttribute(res.uvs, 2));
          }
          out.setIndex(new THREE.BufferAttribute(res.indices, 1));
          out.computeBoundingBox();
          out.computeBoundingSphere();
          return out;
        }
      }
    }
    return decimateMesh(geometry, merged);
  }
}

/**
 * 12. ScrewModifier
 * Revolves and/or helically extrudes a mesh profile around X, Y, or Z.
 */
export class ScrewModifier {
  static get defaultParams() {
    return {
      axis: 'Y',
      angleDeg: 360,
      steps: 16,
      iterations: 1,
      screwOffset: 0.0,
      radiusOffset: 0.0,
      flipNormals: false
    };
  }

  static execute(geometry, params = {}) {
    return screwMesh(geometry, { ...this.defaultParams, ...params });
  }
}

/**
 * 13. WeightedNormalModifier
 * Face-area / corner-angle weighted normals for crisp flat hard-surface shading.
 */
export class WeightedNormalModifier {
  static get defaultParams() {
    return {
      mode: 'face_area_and_angle',
      weight: 50,
      keepSharp: true,
      thresholdDeg: 30
    };
  }

  static execute(geometry, params = {}) {
    return weightedNormalMesh(geometry, { ...this.defaultParams, ...params });
  }
}

// =============================================================================
// WAVE 3 PRO MODIFIERS (Shrinkwrap, Curve, Lattice, Skin, Remesh, Weld, SimpleDeform, Cast, Wave, DataTransfer, Multires)
// =============================================================================

export class ShrinkwrapModifier {
  static get defaultParams() {
    return { targetId: '', targetName: '', mode: 'nearest_surface', axis: 'y', offset: 0.0 };
  }
  static execute(geometry, params = {}) {
    return shrinkwrapMesh(geometry, { ...this.defaultParams, ...params });
  }
}

export class CurveModifier {
  static get defaultParams() {
    return { targetId: '', targetName: '', deformAxis: 'x', stretch: false };
  }
  static execute(geometry, params = {}) {
    return curveDeformMesh(geometry, { ...this.defaultParams, ...params });
  }
}

export class LatticeModifier {
  static get defaultParams() {
    return { resU: 3, resV: 3, resW: 3, preset: 'taper_top', strength: 0.45, latticePoints: null };
  }
  static execute(geometry, params = {}) {
    return latticeDeformMesh(geometry, { ...this.defaultParams, ...params });
  }
}

export class SkinModifier {
  static get defaultParams() {
    return { thickness: 0.14, radialSegments: 8 };
  }
  static execute(geometry, params = {}) {
    return skinMesh(geometry, { ...this.defaultParams, ...params });
  }
}

export class RemeshModifier {
  static get defaultParams() {
    return { mode: 'voxel', voxelSize: 0.16, smoothIterations: 2 };
  }
  static execute(geometry, params = {}) {
    return remeshGeometry(geometry, { ...this.defaultParams, ...params });
  }
}

export class WeldModifier {
  static get defaultParams() {
    return { distance: 0.002 };
  }
  static execute(geometry, params = {}) {
    return weldMesh(geometry, { ...this.defaultParams, ...params });
  }
}

export class SimpleDeformModifier {
  static get defaultParams() {
    return { mode: 'twist', axis: 'y', angleDeg: 60, factor: 0.5, limitMin: 0, limitMax: 1 };
  }
  static execute(geometry, params = {}) {
    return simpleDeformMesh(geometry, { ...this.defaultParams, ...params });
  }
}

export class CastModifier {
  static get defaultParams() {
    return { shape: 'sphere', factor: 0.65, radius: 0.0 };
  }
  static execute(geometry, params = {}) {
    return castMesh(geometry, { ...this.defaultParams, ...params });
  }
}

export class WaveModifier {
  static get defaultParams() {
    return { height: 0.25, width: 1.2, speed: 1.0, phase: 0.0, time: 0.0, motionX: true, motionZ: true, falloffRadius: 0.0 };
  }
  static execute(geometry, params = {}) {
    return waveMesh(geometry, { ...this.defaultParams, ...params });
  }
}

export class DataTransferModifier {
  static get defaultParams() {
    return { targetId: '', targetName: '', transferNormals: true, transferUVs: false, transferColors: false, mixFactor: 1.0 };
  }
  static execute(geometry, params = {}) {
    return dataTransferMesh(geometry, { ...this.defaultParams, ...params });
  }
}

export class MultiresModifier {
  static get defaultParams() {
    return { levels: 1, renderLevels: 2, sculptLevel: 1, deltas: {} };
  }
  static execute(geometry, params = {}) {
    const p = { ...this.defaultParams, ...params };
    const rawLevel = p._renderQuality ? (p.renderLevels ?? p.levels ?? 1) : (p.levels ?? 1);
    const targetLevel = Math.max(0, Math.min(4, Math.floor(rawLevel)));
    let cur = geometry.clone();
    for (let lvl = 1; lvl <= targetLevel; lvl++) {
      const next = subdivideCatmullClark(cur, { levels: 1, subdivisionType: 'catmull-clark', uvSmooth: true });
      cur.dispose();
      cur = next;
      const lvlDeltas = p.deltas?.[String(lvl)];
      const pos = cur.attributes?.position;
      if (lvlDeltas && pos && Array.isArray(lvlDeltas) && lvlDeltas.length >= pos.count * 3) {
        for (let i = 0; i < pos.count; i++) {
          pos.setXYZ(
            i,
            pos.getX(i) + lvlDeltas[i * 3],
            pos.getY(i) + lvlDeltas[i * 3 + 1],
            pos.getZ(i) + lvlDeltas[i * 3 + 2]
          );
        }
        pos.needsUpdate = true;
        cur.computeVertexNormals();
      }
    }
    return cur;
  }
}

// =============================================================================
// MODIFIER REGISTRY & STACK MANAGER
// =============================================================================

export const MODIFIER_TYPES = {
  array: ArrayModifier,
  mirror: MirrorModifier,
  wireframe: WireframeModifier,
  subsurf: SubdivisionModifier,
  subdivide: SubdivisionModifier,
  subdivision: SubdivisionModifier,
  bevel: BevelModifier,
  solidify: SolidifyModifier,
  displace: DisplaceModifier,
  displacement: DisplaceModifier,
  smooth: SmoothModifier,
  relax: SmoothModifier,
  randomize: RandomizeModifier,
  boolean: BooleanModifier,
  bool: BooleanModifier,
  decimate: DecimateModifier,
  screw: ScrewModifier,
  lathe: ScrewModifier,
  weighted_normal: WeightedNormalModifier,
  weightednormal: WeightedNormalModifier,
  shrinkwrap: ShrinkwrapModifier,
  curve: CurveModifier,
  lattice: LatticeModifier,
  skin: SkinModifier,
  remesh: RemeshModifier,
  weld: WeldModifier,
  simple_deform: SimpleDeformModifier,
  simpledeform: SimpleDeformModifier,
  cast: CastModifier,
  wave: WaveModifier,
  data_transfer: DataTransferModifier,
  datatransfer: DataTransferModifier,
  multires: MultiresModifier,
};

/**
 * Executes a single modifier on a geometry.
 * @param {THREE.BufferGeometry} geometry 
 * @param {string} type 
 * @param {Object} params 
 * @returns {THREE.BufferGeometry}
 */
export function executeModifier(geometry, type, params = {}) {
  const normType = (type || '').toLowerCase();
  const ModifierClass = MODIFIER_TYPES[normType];
  if (!ModifierClass) {
    console.warn(`[Modifiers] Unknown modifier type: ${type}`);
    return geometry.clone();
  }
  return ModifierClass.execute(geometry, params);
}

/**
 * Applies a new modifier to a mesh's modifier stack and updates its geometry non-destructively.
 * @param {THREE.Mesh} mesh 
 * @param {string} modifierType - 'array' | 'mirror' | 'wireframe' | 'subdivide' | 'bevel' | 'boolean' | 'decimate' | 'screw' | 'weighted_normal'
 * @param {Object} [params] 
 * @returns {Object} The created modifier descriptor
 */
export function applyModifier(mesh, modifierType, params = {}) {
  if (!mesh || !mesh.isMesh) {
    console.warn('[Modifiers] Cannot apply modifier to a non-mesh object');
    return null;
  }

  // Backup original base geometry if not yet backed up
  if (!mesh.userData.baseGeometry) {
    mesh.userData.baseGeometry = mesh.geometry.clone();
  }

  if (!mesh.userData.modifierStack) {
    mesh.userData.modifierStack = [];
  }

  const type = (modifierType || 'array').toLowerCase();
  const ModifierClass = MODIFIER_TYPES[type] || ArrayModifier;
  const defaults = ModifierClass.defaultParams || {};

  const modifier = {
    id: `mod_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
    type: type,
    name: getModifierDisplayName(type),
    enabled: true,
    params: { ...defaults, ...params }
  };

  mesh.userData.modifierStack.push(modifier);
  recomputeModifiers(mesh);
  return modifier;
}

/**
 * Updates an existing modifier's parameters and re-evaluates the stack.
 * @param {THREE.Mesh} mesh 
 * @param {string} modifierId 
 * @param {Object} newParams 
 */
export function updateModifier(mesh, modifierId, newParams = {}) {
  if (!mesh || !mesh.userData.modifierStack) return;

  const mod = mesh.userData.modifierStack.find((m) => m.id === modifierId);
  if (mod) {
    mod.params = { ...mod.params, ...newParams };
    recomputeModifiers(mesh);
  }
}

/**
 * Removes a modifier from the stack and re-evaluates.
 * @param {THREE.Mesh} mesh 
 * @param {string} modifierId 
 */
export function removeModifier(mesh, modifierId) {
  if (!mesh || !mesh.userData.modifierStack) return;

  const stack = mesh.userData.modifierStack;
  const idx = stack.findIndex((m) => m.id === modifierId);
  if (idx !== -1) {
    stack.splice(idx, 1);
  }

  if (stack.length === 0) {
    // Restore clean base geometry
    if (mesh.userData.baseGeometry) {
      if (mesh.geometry && mesh.geometry !== mesh.userData.baseGeometry) {
        mesh.geometry.dispose();
      }
      mesh.geometry = mesh.userData.baseGeometry.clone();
      mesh.userData.baseGeometry.dispose();
      delete mesh.userData.baseGeometry;
    }
    syncBooleanCuttersInScene();
  } else {
    recomputeModifiers(mesh);
  }
}

/**
 * Toggles a modifier enabled state.
 * @param {THREE.Mesh} mesh 
 * @param {string} modifierId 
 * @param {boolean} [forceEnabled] 
 */
export function toggleModifier(mesh, modifierId, forceEnabled = null) {
  if (!mesh || !mesh.userData.modifierStack) return;

  const mod = mesh.userData.modifierStack.find((m) => m.id === modifierId);
  if (mod) {
    mod.enabled = forceEnabled !== null ? forceEnabled : !mod.enabled;
    recomputeModifiers(mesh);
  }
}

/**
 * Permanently merges (bakes) modifiers into the mesh geometry.
 * If modifierId is provided, bakes up to that specific modifier.
 * If omitted, bakes all active modifiers.
 * @param {THREE.Mesh} mesh 
 * @param {string|null} [modifierId=null] 
 */
export function bakeModifiers(mesh, modifierId = null) {
  if (!mesh || !mesh.userData.modifierStack || mesh.userData.modifierStack.length === 0) return;

  const stack = mesh.userData.modifierStack;

  if (!modifierId) {
    // Bake entire stack permanently
    if (mesh.userData.baseGeometry) {
      mesh.userData.baseGeometry.dispose();
      delete mesh.userData.baseGeometry;
    }
    mesh.userData.modifierStack = [];
    syncBooleanCuttersInScene();
    return;
  }

  // Bake single modifier
  const idx = stack.findIndex((m) => m.id === modifierId);
  if (idx === -1) return;

  const prepared = prepareBooleanDescriptors(mesh, stack);
  let current = mesh.userData.baseGeometry.clone();
  for (let i = 0; i <= idx; i++) {
    const mod = prepared[i];
    if (mod.enabled) {
      const next = executeModifier(current, mod.type, mod.params);
      current.dispose();
      current = next;
    }
  }

  // Set new base geometry
  if (mesh.userData.baseGeometry) {
    mesh.userData.baseGeometry.dispose();
  }
  mesh.userData.baseGeometry = current;

  // Remove the baked modifier
  stack.splice(idx, 1);

  if (stack.length === 0) {
    mesh.geometry = mesh.userData.baseGeometry.clone();
    delete mesh.userData.baseGeometry;
    syncBooleanCuttersInScene();
  } else {
    recomputeModifiers(mesh);
  }
}

/**
 * Re-evaluates the entire modifier stack sequentially against the mesh's baseGeometry.
 * @param {THREE.Mesh} mesh 
 */
export function recomputeModifiers(mesh, opts = {}) {
  if (!mesh || !mesh.isMesh) return;

  if (!mesh.userData.baseGeometry) {
    mesh.userData.baseGeometry = mesh.geometry.clone();
  }

  const rawStack = mesh.userData.modifierStack || [];
  const stack = prepareBooleanDescriptors(mesh, rawStack);
  const renderQuality = Boolean(opts.renderQuality);
  let evaluated = mesh.userData.baseGeometry.clone();

  for (const mod of stack) {
    if (!mod.enabled) continue;
    try {
      const next = executeModifier(evaluated, mod.type, { ...mod.params, _renderQuality: renderQuality });
      evaluated.dispose();
      evaluated = next;
    } catch (err) {
      console.error(`[Modifiers] Error evaluating modifier '${mod.name}':`, err);
    }
  }

  // Dispose previous geometry if it was derived
  if (mesh.geometry && mesh.geometry !== mesh.userData.baseGeometry) {
    mesh.geometry.dispose();
  }

  mesh.geometry = evaluated;
  mesh.geometry.computeBoundingBox();
  mesh.geometry.computeBoundingSphere();

  syncBooleanCuttersInScene();

  // Notify system of geometry update
  if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
    window.dispatchEvent(new CustomEvent('blender:geometryChanged', { detail: mesh }));
  }
}

/**
 * Returns current modifier stack on a mesh.
 * @param {THREE.Mesh} mesh 
 * @returns {Array}
 */
export function getModifierStack(mesh) {
  return mesh?.userData?.modifierStack || [];
}

/**
 * Helper to get clean human-readable name for modifier types.
 * @param {string} type 
 * @returns {string}
 */
export function getModifierDisplayName(type) {
  switch ((type || '').toLowerCase()) {
    case 'array': return 'Array';
    case 'mirror': return 'Mirror';
    case 'wireframe': return 'Wireframe';
    case 'subsurf':
    case 'subdivide':
    case 'subdivision': return 'Subdivision Surface';
    case 'bevel': return 'Bevel';
    case 'solidify': return 'Solidify';
    case 'displace':
    case 'displacement': return 'Displace';
    case 'smooth':
    case 'relax': return 'Smooth';
    case 'randomize': return 'Randomize';
    case 'boolean':
    case 'bool': return 'Boolean';
    case 'decimate': return 'Decimate';
    case 'screw':
    case 'lathe': return 'Screw';
    case 'weighted_normal':
    case 'weightednormal': return 'Weighted Normal';
    case 'shrinkwrap': return 'Shrinkwrap';
    case 'curve': return 'Curve';
    case 'lattice': return 'Lattice';
    case 'skin': return 'Skin';
    case 'remesh': return 'Remesh';
    case 'weld': return 'Weld';
    case 'simple_deform':
    case 'simpledeform': return 'SimpleDeform';
    case 'cast': return 'Cast';
    case 'wave': return 'Wave';
    case 'data_transfer':
    case 'datatransfer': return 'DataTransfer';
    case 'multires': return 'Multiresolution';
    default: return 'Modifier';
  }
}

/**
 * Temporarily switches all Subdivision / Multires modifiers in `scene` to `renderLevels`
 * during final render/export (`useRender = true`) and restores viewport `subdivisions` cleanly.
 */
export function setRenderSubdivisionQuality(scene, useRender = false) {
  if (!scene?.traverse) return 0;
  let updated = 0;
  scene.traverse((obj) => {
    if (!obj.isMesh || !Array.isArray(obj.userData?.modifierStack)) return;
    const hasSub = obj.userData.modifierStack.some((m) =>
      m.enabled !== false && (m.type === 'subdivide' || m.type === 'subdivision' || m.type === 'multires')
    );
    if (!hasSub) return;
    recomputeModifiers(obj, { renderQuality: Boolean(useRender) });
    updated++;
  });
  return updated;
}

export async function withRenderSubdivisionLevels(scene, fn) {
  const switched = setRenderSubdivisionQuality(scene, true);
  try {
    return await fn();
  } finally {
    if (switched > 0) setRenderSubdivisionQuality(scene, false);
  }
}

// Attach to window for global debugging & DSL access
if (typeof window !== 'undefined') {
  window.modifiers = {
    applyModifier,
    updateModifier,
    removeModifier,
    toggleModifier,
    bakeModifiers,
    recomputeModifiers,
    getModifierStack,
    performBoolean,
    applyBoolean,
    performBooleanAsync,
    applyBooleanAsync,
    resolveSceneCutter,
    prepareBooleanDescriptors,
    setCutterDisplayMode,
    syncBooleanCuttersInScene,
    setRenderSubdivisionQuality,
    withRenderSubdivisionLevels,
    ArrayModifier,
    MirrorModifier,
    WireframeModifier,
    SubdivisionModifier,
    BevelModifier,
    SolidifyModifier,
    DisplaceModifier,
    SmoothModifier,
    RandomizeModifier,
    BooleanModifier,
    DecimateModifier,
    ScrewModifier,
    WeightedNormalModifier
  };
}
