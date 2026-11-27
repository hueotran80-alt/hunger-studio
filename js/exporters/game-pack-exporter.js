/**
 * Game Engine & Marketplace Asset Prep Pipeline (Wave 1C)
 * File: js/exporters/game-pack-exporter.js
 *
 * Prepares production-ready assets without altering live scene geometry:
 *  - Auto-LOD Chain (`_LOD0`, `_LOD1`, `_LOD2`) using Decimate edge collapse
 *  - Convex Collision Hulls (`UCX_<MeshName>` — Unreal / Unity / Godot standard)
 *    via 3D incremental QuickHull
 *  - Non-overlapping Lightmap UV2 (`uv1` -> `TEXCOORD_1` in glTF 2.0) via
 *    Smart UV Project + Pack Islands while preserving `uv` (`TEXCOORD_0`)
 */

import * as THREE from 'three';
import { decimateMesh } from '../core/geometry/hard-surface-ops.js';
import { smartUVProjectGeometry, packUVIslandsInPlace } from '../core/geometry/uv-unwrap.js';

function deduplicatePoints(posAttr, eps = 1e-5) {
  const map = new Map();
  const pts = [];
  const inv = 1 / eps;
  for (let i = 0; i < posAttr.count; i += 1) {
    const x = posAttr.getX(i);
    const y = posAttr.getY(i);
    const z = posAttr.getZ(i);
    const key = `${Math.round(x * inv)}_${Math.round(y * inv)}_${Math.round(z * inv)}`;
    if (!map.has(key)) {
      map.set(key, true);
      pts.push(new THREE.Vector3(x, y, z));
    }
  }
  return pts;
}

function signedVolume6(a, b, c, d) {
  const ab = new THREE.Vector3().subVectors(b, a);
  const ac = new THREE.Vector3().subVectors(c, a);
  const ad = new THREE.Vector3().subVectors(d, a);
  return ab.cross(ac).dot(ad);
}

/**
 * Pure 3D QuickHull / Incremental Convex Hull returning a closed indexed BufferGeometry.
 * Falls back cleanly to oriented bounding box hull for degenerate/planar inputs.
 *
 * @param {THREE.BufferGeometry} sourceGeom
 * @returns {THREE.BufferGeometry}
 */
export function computeConvexHullGeometry(sourceGeom) {
  const posAttr = sourceGeom?.attributes?.position;
  if (!posAttr || posAttr.count < 3) {
    throw new Error('computeConvexHullGeometry requires a geometry with >= 3 vertices.');
  }

  const pts = deduplicatePoints(posAttr, 1e-5);
  const makeBoxFallback = () => {
    const box = new THREE.Box3().setFromBufferAttribute(posAttr);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const boxGeom = new THREE.BoxGeometry(
      Math.max(1e-3, size.x),
      Math.max(1e-3, size.y),
      Math.max(1e-3, size.z),
    );
    boxGeom.translate(center.x, center.y, center.z);
    return boxGeom;
  };

  if (pts.length < 4) return makeBoxFallback();

  // 1. Seed extreme points along X, Y, Z to find initial non-degenerate tetrahedron
  let minX = 0, maxX = 0, minY = 0, maxY = 0, minZ = 0, maxZ = 0;
  for (let i = 1; i < pts.length; i += 1) {
    if (pts[i].x < pts[minX].x) minX = i;
    if (pts[i].x > pts[maxX].x) maxX = i;
    if (pts[i].y < pts[minY].y) minY = i;
    if (pts[i].y > pts[maxY].y) maxY = i;
    if (pts[i].z < pts[minZ].z) minZ = i;
    if (pts[i].z > pts[maxZ].z) maxZ = i;
  }
  const extremes = [minX, maxX, minY, maxY, minZ, maxZ];
  let i0 = extremes[0], i1 = extremes[1];
  let bestDist2 = -1;
  for (const a of extremes) {
    for (const b of extremes) {
      const d2 = pts[a].distanceToSquared(pts[b]);
      if (d2 > bestDist2) {
        bestDist2 = d2;
        i0 = a;
        i1 = b;
      }
    }
  }
  if (bestDist2 < 1e-10) return makeBoxFallback();

  // 3rd point farthest from line (i0, i1)
  const lineDir = new THREE.Vector3().subVectors(pts[i1], pts[i0]).normalize();
  let i2 = -1;
  let bestLineDist2 = 1e-10;
  const tmp = new THREE.Vector3();
  for (let i = 0; i < pts.length; i += 1) {
    if (i === i0 || i === i1) continue;
    tmp.subVectors(pts[i], pts[i0]);
    const proj = tmp.dot(lineDir);
    const dist2 = tmp.lengthSq() - proj * proj;
    if (dist2 > bestLineDist2) {
      bestLineDist2 = dist2;
      i2 = i;
    }
  }
  if (i2 < 0) return makeBoxFallback();

  // 4th point farthest from plane (i0, i1, i2)
  const planeNormal = new THREE.Vector3()
    .subVectors(pts[i1], pts[i0])
    .cross(new THREE.Vector3().subVectors(pts[i2], pts[i0]))
    .normalize();
  const planeOffset = planeNormal.dot(pts[i0]);
  let i3 = -1;
  let bestPlaneDist = 1e-6;
  for (let i = 0; i < pts.length; i += 1) {
    if (i === i0 || i === i1 || i === i2) continue;
    const d = Math.abs(planeNormal.dot(pts[i]) - planeOffset);
    if (d > bestPlaneDist) {
      bestPlaneDist = d;
      i3 = i;
    }
  }
  if (i3 < 0) return makeBoxFallback();

  // Orient initial tetrahedron outward
  let faces = [];
  const makeFace = (a, b, c) => {
    const n = new THREE.Vector3()
      .subVectors(pts[b], pts[a])
      .cross(new THREE.Vector3().subVectors(pts[c], pts[a]));
    const len = n.length();
    if (len < 1e-12) return null;
    n.divideScalar(len);
    return { a, b, c, n, d: n.dot(pts[a]) };
  };

  if (signedVolume6(pts[i0], pts[i1], pts[i2], pts[i3]) > 0) {
    // Flip i1/i2 so i3 sits behind face (i0, i1, i2)
    const t = i1;
    i1 = i2;
    i2 = t;
  }
  faces.push(makeFace(i0, i1, i2), makeFace(i0, i3, i1), makeFace(i1, i3, i2), makeFace(i2, i3, i0));
  faces = faces.filter(Boolean);

  const usedVerts = new Set([i0, i1, i2, i3]);
  const eps = 1e-6;

  // 2. Incremental hull expansion
  for (let vi = 0; vi < pts.length; vi += 1) {
    if (usedVerts.has(vi)) continue;
    const p = pts[vi];
    const visible = [];
    const hidden = [];
    for (const f of faces) {
      if (f.n.dot(p) - f.d > eps) visible.push(f);
      else hidden.push(f);
    }
    if (visible.length === 0) continue;

    usedVerts.add(vi);
    // Horizon edges belong to exactly 1 visible face (its twin is hidden)
    const edgeCounts = new Map();
    const directedEdges = [];
    for (const f of visible) {
      for (const [u, v] of [[f.a, f.b], [f.b, f.c], [f.c, f.a]]) {
        const key = u < v ? `${u}_${v}` : `${v}_${u}`;
        edgeCounts.set(key, (edgeCounts.get(key) || 0) + 1);
        directedEdges.push([u, v, key]);
      }
    }

    faces = hidden;
    for (const [u, v, key] of directedEdges) {
      if (edgeCounts.get(key) === 1) {
        const nf = makeFace(u, v, vi);
        if (nf) faces.push(nf);
      }
    }
  }

  if (faces.length < 4) return makeBoxFallback();

  // 3. Compact only hull vertices into BufferGeometry
  const vertRemap = new Map();
  const outPos = [];
  const outIdx = [];
  const mapVert = (origIdx) => {
    if (vertRemap.has(origIdx)) return vertRemap.get(origIdx);
    const next = outPos.length / 3;
    const p = pts[origIdx];
    outPos.push(p.x, p.y, p.z);
    vertRemap.set(origIdx, next);
    return next;
  };

  for (const f of faces) {
    outIdx.push(mapVert(f.a), mapVert(f.b), mapVert(f.c));
  }

  const hull = new THREE.BufferGeometry();
  hull.setAttribute('position', new THREE.Float32BufferAttribute(outPos, 3));
  hull.setIndex(outIdx);
  hull.computeVertexNormals();
  hull.computeBoundingBox();
  hull.computeBoundingSphere();
  return hull;
}

/**
 * Generates non-overlapping Lightmap UVs (`uv1` -> `TEXCOORD_1` in glTF 2.0)
 * on a cloned geometry while keeping `uv` (`TEXCOORD_0`) untouched.
 *
 * @param {THREE.BufferGeometry} geometry
 * @param {{ angleLimitDeg?: number, islandMargin?: number }} [options]
 * @returns {THREE.BufferGeometry}
 */
export function ensureLightmapUV(geometry, options = {}) {
  if (!geometry?.attributes?.position) return geometry;
  const angleLimitDeg = Number(options.angleLimitDeg ?? 66);
  const islandMargin = Number(options.islandMargin ?? 0.03);

  const savedUv0 = geometry.attributes.uv || null;
  const savedIdx = geometry.index || null;
  const savedSeams = geometry.userData?._uvSeams ? Array.from(geometry.userData._uvSeams) : null;

  const projected = smartUVProjectGeometry(geometry, { angleLimitDeg, margin: islandMargin });
  packUVIslandsInPlace(projected, { margin: islandMargin });

  const lmUv = projected.attributes.uv.clone();
  projected.setAttribute('uv1', lmUv);

  if (savedUv0) {
    const projVertCount = projected.attributes.position.count;
    const projIdx = projected.index;
    const rawTriCount = Math.floor((savedIdx ? savedIdx.count : geometry.attributes.position.count) / 3);
    if (projIdx && projIdx.count === rawTriCount * 3) {
      const restoredUv0 = new Float32Array(projVertCount * 2);
      for (let t = 0; t < rawTriCount; t += 1) {
        for (let k = 0; k < 3; k += 1) {
          const origV = savedIdx ? savedIdx.getX(t * 3 + k) : t * 3 + k;
          const projV = projIdx.getX(t * 3 + k);
          restoredUv0[projV * 2] = savedUv0.getX(origV);
          restoredUv0[projV * 2 + 1] = savedUv0.getY(origV);
        }
      }
      projected.setAttribute('uv', new THREE.BufferAttribute(restoredUv0, 2));
    } else if (savedUv0.count === projVertCount) {
      projected.setAttribute('uv', savedUv0.clone());
    }
  } else {
    projected.setAttribute('uv', lmUv.clone());
  }

  if (savedSeams) {
    projected.userData = { ...(projected.userData || {}), _uvSeams: savedSeams };
  }
  return projected;
}

/**
 * Generates an Auto-LOD array of meshes `[LOD0, LOD1, ...]` from a source mesh.
 */
export function generateLODChain(mesh, ratios = [1.0, 0.5, 0.2], options = {}) {
  if (!mesh?.isMesh || !mesh.geometry) return [];
  const baseName = mesh.name || 'Asset';
  const results = [];

  for (let i = 0; i < ratios.length; i += 1) {
    const ratio = THREE.MathUtils.clamp(Number(ratios[i]) || 1.0, 0.05, 1.0);
    let geom = mesh.geometry.clone();
    if (ratio < 0.999) {
      geom = decimateMesh(geom, {
        mode: 'collapse',
        ratio,
        preserveBoundaries: options.preserveBoundaries !== false,
      });
    }
    if (options.generateLightmapUV !== false) {
      geom = ensureLightmapUV(geom, options);
    }
    const lodMesh = new THREE.Mesh(geom, mesh.material);
    lodMesh.name = `${baseName}_LOD${i}`;
    lodMesh.position.copy(mesh.position);
    lodMesh.quaternion.copy(mesh.quaternion);
    lodMesh.scale.copy(mesh.scale);
    lodMesh.userData = { lodLevel: i, lodRatio: ratio };
    results.push(lodMesh);
  }
  return results;
}

/**
 * Builds a complete non-destructive Game/Marketplace export group containing
 * LOD meshes (`_LOD0..2`), Lightmap UV2 (`uv1` / `TEXCOORD_1`), and `UCX_`
 * convex hull collision meshes.
 */
export function buildGamePackScene(target, options = {}) {
  if (!target) throw new Error('buildGamePackScene requires a target Object3D/Scene.');
  const ratios = Array.isArray(options.lodRatios) && options.lodRatios.length ? options.lodRatios : [1.0, 0.5, 0.2];
  const includeCollision = options.includeCollision !== false;
  const generateLightmapUV = options.generateLightmapUV !== false;

  target.updateMatrixWorld(true);
  const packGroup = new THREE.Group();
  packGroup.name = `${target.name || 'GameAsset'}_Pack`;

  const report = {
    sourceMeshes: 0,
    lodMeshes: 0,
    collisionMeshes: 0,
    lightmapUVCount: 0,
    trianglesByLod: new Array(ratios.length).fill(0),
    collisionTriangles: 0,
  };

  const sources = [];
  target.traverse((node) => {
    if (!node?.isMesh || !node.geometry?.attributes?.position) return;
    if (node.userData?.isHelper || node.userData?.isSystemObject || node.userData?.isLightHelper) return;
    if (options.onlyVisible !== false && !node.visible) return;
    sources.push(node);
  });

  if (sources.length === 0) {
    throw new Error('No exportable meshes found for Game/Marketplace pack.');
  }

  for (const src of sources) {
    report.sourceMeshes += 1;
    // Bake world transform cleanly relative to target root if nested
    const worldMesh = new THREE.Mesh(src.geometry.clone(), src.material);
    worldMesh.name = src.name || `Mesh_${report.sourceMeshes}`;
    const pos = new THREE.Vector3();
    const quat = new THREE.Quaternion();
    const scl = new THREE.Vector3();
    src.matrixWorld.decompose(pos, quat, scl);
    worldMesh.position.copy(pos);
    worldMesh.quaternion.copy(quat);
    worldMesh.scale.copy(scl);

    const lods = generateLODChain(worldMesh, ratios, { generateLightmapUV });
    lods.forEach((lodMesh, li) => {
      const tris = lodMesh.geometry.index
        ? Math.floor(lodMesh.geometry.index.count / 3)
        : Math.floor(lodMesh.geometry.attributes.position.count / 3);
      report.trianglesByLod[li] += tris;
      report.lodMeshes += 1;
      if (lodMesh.geometry.attributes.uv1) report.lightmapUVCount += 1;
      packGroup.add(lodMesh);
    });

    if (includeCollision) {
      const hullGeom = computeConvexHullGeometry(worldMesh.geometry);
      const colMesh = new THREE.Mesh(
        hullGeom,
        new THREE.MeshStandardMaterial({ name: 'UCX_Collision', color: 0x00ff88, transparent: true, opacity: 0.25, roughness: 0.9 })
      );
      colMesh.name = `UCX_${worldMesh.name}`;
      colMesh.position.copy(worldMesh.position);
      colMesh.quaternion.copy(worldMesh.quaternion);
      colMesh.scale.copy(worldMesh.scale);
      colMesh.userData = { isCollisionMesh: true };
      const colTris = hullGeom.index
        ? Math.floor(hullGeom.index.count / 3)
        : Math.floor(hullGeom.attributes.position.count / 3);
      report.collisionTriangles += colTris;
      report.collisionMeshes += 1;
      packGroup.add(colMesh);
    }
  }

  return { group: packGroup, report };
}
