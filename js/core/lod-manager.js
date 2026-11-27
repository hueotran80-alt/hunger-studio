/**
 * Web Blender Studio — Rust WASM QEM Auto-LOD & Non-Destructive Mesh Detail Manager
 * File: js/core/lod-manager.js
 *
 * Provides:
 *   1. Fast QEM mesh simplification (`simplifyBufferGeometry`) powered by Rust WASM
 *      (`crates/mesh_kernel`), supporting multi-material `geometry.groups` (e.g. Bark + Leaves)
 *      with automatic JS fallback (`decimateMesh`).
 *   2. Non-destructive Mesh Detail Slider (`setMeshDetailLevel`): seamlessly reduce
 *      polygon count down to 5% (QEM) or subdivide up (+1/+2 levels) while preserving
 *      `mesh.userData.baseGeometry` for lossless 100% restoration.
 *   3. In-place `Auto-LOD` (`enableAutoLOD` / `disableAutoLOD` / `update`): swaps
 *      `mesh.geometry` across pre-computed `[LOD0, LOD1, LOD2]` tiers based on camera
 *      distance × `ViewportGovernor` bias while keeping `mesh.isMesh === true` so
 *      Outliner, Gizmos, EditMode, SculptMode, and GLB/.wbs exporters stay 100% intact.
 */

import * as THREE from 'three';
import {
  initMeshKernel,
  isMeshKernelReady,
  simplifyMeshQEMInWasm,
  subdivideMesh,
} from './mesh-kernel-bridge.js';
import { decimateMesh } from './geometry/hard-surface-ops.js';
import { subdivideCatmullClark } from './geometry/catmull-clark.js';
import { dataBlockRegistry } from './data-blocks.js';

const _camPos = new THREE.Vector3();
const _objPos = new THREE.Vector3();
const _box = new THREE.Box3();
const _sphere = new THREE.Sphere();

/**
 * Counts triangles in a Three.js BufferGeometry.
 * @param {THREE.BufferGeometry} geom
 * @returns {number}
 */
export function countGeometryTriangles(geom) {
  if (!geom?.attributes?.position) return 0;
  return geom.index ? Math.floor(geom.index.count / 3) : Math.floor(geom.attributes.position.count / 3);
}

/**
 * Simplifies a single-material BufferGeometry using Rust WASM QEM (or JS fallback).
 * @param {THREE.BufferGeometry} geometry
 * @param {number} ratio (0.02 .. 1.0)
 * @param {Object} [options]
 * @returns {THREE.BufferGeometry}
 */
function simplifySingleGeometry(geometry, ratio, options = {}) {
  const clamped = Math.max(0.02, Math.min(1.0, Number(ratio) || 0.35));
  if (clamped >= 0.999) return geometry.clone();

  const posAttr = geometry.attributes?.position;
  if (!posAttr || posAttr.count < 3) return geometry.clone();

  if (isMeshKernelReady()) {
    const uvAttr = geometry.attributes?.uv;
    const res = simplifyMeshQEMInWasm(
      posAttr.array,
      geometry.index ? geometry.index.array : null,
      {
        uvs: uvAttr && uvAttr.itemSize === 2 ? uvAttr.array : null,
        ratio: clamped,
        lockBorders: options.lockBorders !== false,
      }
    );
    if (res && res.indices && res.indices.length >= 3) {
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

  return decimateMesh(geometry, {
    mode: 'collapse',
    ratio: clamped,
    preserveBoundaries: options.lockBorders !== false,
  });
}

/**
 * Simplifies any BufferGeometry (including multi-material `groups` such as tree bark + foliage).
 * @param {THREE.BufferGeometry} geometry
 * @param {number} ratio (0.02 .. 1.0)
 * @param {Object} [options]
 * @returns {THREE.BufferGeometry}
 */
export function simplifyBufferGeometry(geometry, ratio = 0.35, options = {}) {
  if (!geometry?.attributes?.position) return geometry;
  const clamped = Math.max(0.02, Math.min(1.0, Number(ratio) || 0.35));
  if (clamped >= 0.999) return geometry.clone();

  const groups = Array.isArray(geometry.groups) && geometry.groups.length > 1 ? geometry.groups : null;
  if (!groups) {
    return simplifySingleGeometry(geometry, clamped, options);
  }

  // Multi-material mesh: simplify each material group independently so materialIndex never mixes
  const posAttr = geometry.attributes.position;
  const uvAttr = geometry.attributes.uv;
  const idxArray = geometry.index ? geometry.index.array : null;

  const mergedPositions = [];
  const mergedNormals = [];
  const mergedUvs = [];
  const mergedIndices = [];
  const mergedGroups = [];
  let hasAllUvs = Boolean(uvAttr && uvAttr.itemSize === 2);
  let vertexOffset = 0;
  let indexOffset = 0;

  for (const grp of groups) {
    const start = grp.start || 0;
    const count = grp.count || 0;
    if (count < 3) continue;

    const subPos = new Float32Array(count * 3);
    const subUv = hasAllUvs ? new Float32Array(count * 2) : null;
    for (let i = 0; i < count; i++) {
      const vi = idxArray ? idxArray[start + i] : (start + i);
      subPos[i * 3] = posAttr.getX(vi);
      subPos[i * 3 + 1] = posAttr.getY(vi);
      subPos[i * 3 + 2] = posAttr.getZ(vi);
      if (subUv) {
        subUv[i * 2] = uvAttr.getX(vi);
        subUv[i * 2 + 1] = uvAttr.getY(vi);
      }
    }

    const subGeom = new THREE.BufferGeometry();
    subGeom.setAttribute('position', new THREE.BufferAttribute(subPos, 3));
    if (subUv) subGeom.setAttribute('uv', new THREE.BufferAttribute(subUv, 2));

    const simp = simplifySingleGeometry(subGeom, clamped, options);
    subGeom.dispose();

    const sPos = simp.attributes.position.array;
    const sNorm = simp.attributes.normal?.array;
    const sUv = simp.attributes.uv?.array;
    const sIdx = simp.index ? simp.index.array : null;
    const sVertCount = sPos.length / 3;
    const sIdxCount = sIdx ? sIdx.length : sVertCount;

    for (let i = 0; i < sPos.length; i++) mergedPositions.push(sPos[i]);
    if (sNorm && sNorm.length === sPos.length) {
      for (let i = 0; i < sNorm.length; i++) mergedNormals.push(sNorm[i]);
    } else {
      for (let i = 0; i < sVertCount; i++) mergedNormals.push(0, 1, 0);
    }
    if (hasAllUvs) {
      if (sUv && sUv.length === sVertCount * 2) {
        for (let i = 0; i < sUv.length; i++) mergedUvs.push(sUv[i]);
      } else {
        for (let i = 0; i < sVertCount; i++) mergedUvs.push(0, 0);
      }
    }

    if (sIdx) {
      for (let i = 0; i < sIdx.length; i++) mergedIndices.push(sIdx[i] + vertexOffset);
    } else {
      for (let i = 0; i < sVertCount; i++) mergedIndices.push(i + vertexOffset);
    }

    mergedGroups.push({
      start: indexOffset,
      count: sIdxCount,
      materialIndex: grp.materialIndex ?? 0,
    });

    vertexOffset += sVertCount;
    indexOffset += sIdxCount;
    simp.dispose();
  }

  if (mergedIndices.length < 3) return simplifySingleGeometry(geometry, clamped, options);

  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(new Float32Array(mergedPositions), 3));
  out.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(mergedNormals), 3));
  if (hasAllUvs && mergedUvs.length === vertexOffset * 2) {
    out.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(mergedUvs), 2));
  }
  out.setIndex(new THREE.BufferAttribute(new Uint32Array(mergedIndices), 1));
  for (const g of mergedGroups) out.addGroup(g.start, g.count, g.materialIndex);
  out.computeBoundingBox();
  out.computeBoundingSphere();
  return out;
}

export class LODManager {
  constructor(options = {}) {
    this.engine = options.engine || null;
    this.managedRoots = new Set();
    this.defaultRatios = [1.0, 0.35, 0.12];
    this.defaultDistances = [0, 14, 34];
  }

  async ensureKernel() {
    if (!isMeshKernelReady()) {
      await initMeshKernel();
    }
    return isMeshKernelReady();
  }

  /**
   * Non-destructively adjusts mesh or Group polygon density:
   *   - `detailFactor < 1.0` (0.05 .. 0.99): Rust WASM QEM Simplification
   *   - `detailFactor === 1.0`: Restores exact `baseGeometry`
   *   - `detailFactor > 1.0` (e.g. 2.0 = +1 subdiv, 3.0 = +2 subdiv): Subdivision (UV-preserving when UVs exist)
   */
  async setMeshDetailLevel(targetObject, detailFactor = 1.0, options = {}) {
    if (!targetObject?.isObject3D) return null;
    await this.ensureKernel();

    const meshes = [];
    if (targetObject.isMesh && targetObject.geometry) {
      meshes.push(targetObject);
    } else {
      targetObject.traverse?.((n) => {
        if (n?.isMesh && !n.isInstancedMesh && !n.userData?.isHelper && !n.userData?.isSystemObject && n.geometry?.attributes?.position) {
          meshes.push(n);
        }
      });
    }
    if (meshes.length === 0) return null;

    const factor = Number.isFinite(detailFactor) ? detailFactor : 1.0;
    const root = this.engine?.sceneManager?.rootContainer || this.engine?.scene || null;
    let totalBaseTris = 0;
    let totalCurTris = 0;

    for (const mesh of meshes) {
      if (!mesh.userData.baseGeometry) {
        mesh.userData.baseGeometry = mesh.geometry.clone();
      }
      const base = mesh.userData.baseGeometry;

      let nextGeom;
      if (Math.abs(factor - 1.0) < 0.01) {
        nextGeom = base.clone();
      } else if (factor < 1.0) {
        const ratio = Math.max(0.03, Math.min(0.99, factor));
        nextGeom = simplifyBufferGeometry(base, ratio, options);
      } else {
        const levels = Math.min(2, Math.max(1, Math.round(factor - 1.0)));
        if (base.attributes?.uv) {
          nextGeom = subdivideCatmullClark(base, {
            levels,
            subdivisionType: options.smooth === false ? 'simple' : 'catmull-clark',
            uvSmooth: true,
          });
        } else {
          let current = base.clone();
          for (let lv = 0; lv < levels; lv++) {
            if (isMeshKernelReady()) {
              const idx = current.index ? current.index.array : null;
              const sub = subdivideMesh(current.attributes.position.array, idx, options.smooth !== false);
              if (sub && sub.indices.length >= 3) {
                const g = new THREE.BufferGeometry();
                g.setAttribute('position', new THREE.BufferAttribute(sub.vertices, 3));
                g.setAttribute('normal', new THREE.BufferAttribute(sub.normals, 3));
                g.setIndex(new THREE.BufferAttribute(sub.indices, 1));
                g.computeBoundingBox();
                g.computeBoundingSphere();
                current.dispose();
                current = g;
              }
            }
          }
          nextGeom = current;
        }
      }

      const oldGeom = mesh.geometry;
      mesh.geometry = nextGeom;
      mesh.userData.meshDetailFactor = factor;
      if (
        oldGeom &&
        oldGeom !== base &&
        oldGeom !== nextGeom &&
        !dataBlockRegistry.isGeometryShared(oldGeom, root, mesh)
      ) {
        oldGeom.dispose?.();
      }

      totalBaseTris += countGeometryTriangles(base);
      totalCurTris += countGeometryTriangles(nextGeom);
    }

    targetObject.userData.meshDetailFactor = factor;
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('blender:geometryChanged', { detail: { object: targetObject } }));
    }
    this.engine?.requestRender?.();
    return {
      baseTriangles: totalBaseTris,
      currentTriangles: totalCurTris,
      factor,
    };
  }

  /**
   * Builds 3-tier Auto-LOD (`LOD0=100%`, `LOD1=35%`, `LOD2=12%`) on a Mesh or hierarchical Tree Group.
   */
  async enableAutoLOD(targetObject, options = {}) {
    if (!targetObject?.isObject3D) return null;
    await this.ensureKernel();

    const ratios = Array.isArray(options.ratios) && options.ratios.length === 3
      ? options.ratios
      : this.defaultRatios;
    const distances = Array.isArray(options.distances) && options.distances.length === 3
      ? options.distances
      : this.defaultDistances;

    let lod0Tris = 0;
    let lod1Tris = 0;
    let lod2Tris = 0;
    let meshParts = 0;

    targetObject.traverse((node) => {
      if (!node.isMesh || !node.geometry || node.userData?.isHelper || node.userData?.isSystemObject) return;
      const base = node.userData.baseGeometry || node.geometry.clone();
      node.userData.baseGeometry = base;

      // Dispose previous Auto-LOD tiers if re-configuring
      if (Array.isArray(node.userData._autoLodGeoms)) {
        for (let i = 1; i < node.userData._autoLodGeoms.length; i++) {
          const g = node.userData._autoLodGeoms[i];
          if (g && g !== base && g !== node.geometry) g.dispose?.();
        }
      }

      const g0 = base;
      const g1 = simplifyBufferGeometry(base, ratios[1], { lockBorders: true });
      const g2 = simplifyBufferGeometry(base, ratios[2], { lockBorders: false });

      node.userData._autoLodGeoms = [g0, g1, g2];
      node.userData._autoLodTier = 0;
      if (node.userData._origCastShadow === undefined) {
        node.userData._origCastShadow = Boolean(node.castShadow);
      }
      node.geometry = g0;

      lod0Tris += countGeometryTriangles(g0);
      lod1Tris += countGeometryTriangles(g1);
      lod2Tris += countGeometryTriangles(g2);
      meshParts += 1;
    });

    if (meshParts === 0) return null;

    targetObject.userData.autoLOD = {
      enabled: true,
      ratios: [...ratios],
      distances: [...distances],
      lod0Tris,
      lod1Tris,
      lod2Tris,
      meshParts,
      stats: { lod0Tris, lod1Tris, lod2Tris, meshParts },
    };

    this.managedRoots.add(targetObject);
    this.engine?.requestRender?.();
    return targetObject.userData.autoLOD;
  }

  forceLOD0(root = null) {
    const saved = [];
    const targets = root ? [root] : [...this.managedRoots];
    for (const target of targets) {
      if (!target || typeof target.traverse !== 'function') continue;
      target.traverse((node) => {
        if (!node.isMesh || !Array.isArray(node.userData?._autoLodGeoms)) return;
        const g0 = node.userData._autoLodGeoms[0];
        const prevGeom = node.geometry;
        const prevTier = node.userData._autoLodTier;
        const prevCastShadow = node.castShadow;
        if (g0 && (prevGeom !== g0 || prevTier !== 0)) {
          saved.push([node, prevGeom, prevTier, prevCastShadow]);
          node.geometry = g0;
          node.userData._autoLodTier = 0;
          if (node.userData._origCastShadow !== undefined) {
            node.castShadow = node.userData._origCastShadow;
          }
        }
      });
    }
    return saved;
  }

  restoreLODs(saved = []) {
    if (!Array.isArray(saved)) return;
    for (const [node, prevGeom, prevTier, prevCastShadow] of saved) {
      if (!node || !node.isMesh) continue;
      if (prevGeom) node.geometry = prevGeom;
      if (prevTier !== undefined) node.userData._autoLodTier = prevTier;
      if (prevCastShadow !== undefined) node.castShadow = prevCastShadow;
    }
  }

  disableAutoLOD(targetObject) {
    if (!targetObject?.isObject3D) return;
    targetObject.traverse((node) => {
      if (!node.isMesh || !Array.isArray(node.userData?._autoLodGeoms)) return;
      const [g0, g1, g2] = node.userData._autoLodGeoms;
      node.geometry = g0;
      if (g1 && g1 !== g0) g1.dispose?.();
      if (g2 && g2 !== g0) g2.dispose?.();
      delete node.userData._autoLodGeoms;
      delete node.userData._autoLodTier;
      if (node.userData._origCastShadow !== undefined) {
        node.castShadow = node.userData._origCastShadow;
      }
    });
    if (targetObject.userData?.autoLOD) {
      targetObject.userData.autoLOD.enabled = false;
    }
    this.managedRoots.delete(targetObject);
    this.engine?.requestRender?.();
  }

  /**
   * Evaluates camera distances for all managed Auto-LOD objects prior to rendering.
   * Automatically pins active EditMode/SculptMode/PaintMode target to `LOD0`!
   * @param {THREE.Camera} camera
   * @param {number} [lodBias=1.0] < 1.0 shifts to coarser LODs earlier (used while orbiting mouse)
   */
  update(camera, lodBias = 1.0) {
    if (!camera || this.managedRoots.size === 0) return 0;
    camera.getWorldPosition(_camPos);
    const bias = Math.max(0.15, Math.min(3.0, Number(lodBias) || 1.0));

    const pinnedMesh = (typeof window !== 'undefined')
      ? (window.editMode?.isActive && window.editMode.targetMesh)
        || (window.sculptMode?.isActive && window.sculptMode.targetMesh)
        || (window.paintMode?.isActive && window.paintMode.targetMesh)
        || null
      : null;

    let switched = 0;
    for (const root of [...this.managedRoots]) {
      if (!root.parent) {
        this.managedRoots.delete(root);
        continue;
      }
      const cfg = root.userData?.autoLOD;
      if (!cfg?.enabled || !root.visible) continue;

      _box.setFromObject(root);
      if (!_box.isEmpty()) {
        _box.getBoundingSphere(_sphere);
        _objPos.copy(_sphere.center);
      } else {
        root.getWorldPosition(_objPos);
      }
      const dist = _camPos.distanceTo(_objPos);
      const d1 = (cfg.distances?.[1] ?? 14) * bias;
      const d2 = (cfg.distances?.[2] ?? 34) * bias;
      const desiredTier = dist >= d2 ? 2 : (dist >= d1 ? 1 : 0);

      root.traverse((node) => {
        if (!node.isMesh || !Array.isArray(node.userData?._autoLodGeoms)) return;
        const tier = node === pinnedMesh ? 0 : desiredTier;
        if (node.userData._autoLodTier !== tier) {
          const nextGeom = node.userData._autoLodGeoms[tier] || node.userData._autoLodGeoms[0];
          if (nextGeom) {
            node.geometry = nextGeom;
            node.userData._autoLodTier = tier;
            if (node.userData._origCastShadow) {
              // Skip expensive leaf shadow casting at distant LOD2
              node.castShadow = tier < 2;
            }
            switched += 1;
          }
        }
      });
    }
    if (switched > 0 && typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('blender:geometryChanged'));
    }
    return switched;
  }
}
