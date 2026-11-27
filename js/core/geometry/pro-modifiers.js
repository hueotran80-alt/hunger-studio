/**
 * Pro Mesh Modifiers Library (Wave 3B)
 * Implements 10 missing Blender modifiers offline with Worker compatibility:
 * Shrinkwrap, Curve, Lattice, Skin, Remesh (Voxel / Surface-Nets / Blocks),
 * Weld, SimpleDeform (Twist / Bend / Taper / Stretch), Cast, Wave, DataTransfer.
 * File: js/core/geometry/pro-modifiers.js
 */

import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';

function ensureBVHLocal(geom) {
  if (!geom.boundsTree) {
    geom.boundsTree = new MeshBVH(geom, { maxLeafTris: 8, indirect: true });
  }
  return geom.boundsTree;
}

function decodeEncodedGeometry(enc) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(enc.position), 3));
  if (enc.normal) g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(enc.normal), 3));
  else g.computeVertexNormals();
  if (enc.uv) g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(enc.uv), 2));
  if (enc.color) g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(enc.color), enc.colorItemSize || 3));
  if (enc.index) g.setIndex(new THREE.BufferAttribute(new Uint32Array(enc.index), 1));
  return g;
}

function resolveTargetGeometry(params) {
  if (params.targetGeometry?.attributes?.position) {
    return { geom: params.targetGeometry, owned: false };
  }
  if (params._targetEncoded?.position) {
    return { geom: decodeEncodedGeometry(params._targetEncoded), owned: true };
  }
  return { geom: null, owned: false };
}

function computeTriBarycentric(p, a, b, c) {
  const v0 = b.clone().sub(a);
  const v1 = c.clone().sub(a);
  const v2 = p.clone().sub(a);
  const d00 = v0.dot(v0), d01 = v0.dot(v1), d11 = v1.dot(v1);
  const d20 = v2.dot(v0), d21 = v2.dot(v1);
  const denom = d00 * d11 - d01 * d01;
  if (Math.abs(denom) < 1e-12) return [1, 0, 0];
  const v = (d11 * d20 - d01 * d21) / denom;
  const w = (d00 * d21 - d01 * d20) / denom;
  const u = 1.0 - v - w;
  return [u, v, w];
}

// =============================================================================
// 1. WELD MODIFIER (Merge by Distance)
// =============================================================================

export function weldMesh(geometry, params = {}) {
  const dist = Math.max(1e-6, Number(params.distance ?? 0.002));
  const posAttr = geometry?.attributes?.position;
  if (!posAttr) return geometry.clone();

  const invTol = 1.0 / dist;
  const hasUV = Boolean(geometry.attributes.uv);
  const hasColor = Boolean(geometry.attributes.color);
  const colorSize = geometry.attributes.color?.itemSize || 3;
  const idx = geometry.index ? geometry.index.array : null;
  const vertCount = posAttr.count;

  const keyMap = new Map();
  const oldToNew = new Int32Array(vertCount);
  const newPos = [];
  const newUV = hasUV ? [] : null;
  const newColor = hasColor ? [] : null;
  const uvAttr = geometry.attributes.uv;
  const colAttr = geometry.attributes.color;
  const counts = [];

  for (let i = 0; i < vertCount; i++) {
    const x = posAttr.getX(i), y = posAttr.getY(i), z = posAttr.getZ(i);
    const qx = Math.round(x * invTol);
    const qy = Math.round(y * invTol);
    const qz = Math.round(z * invTol);
    const key = `${qx}_${qy}_${qz}`;
    let ni = keyMap.get(key);
    if (ni === undefined) {
      ni = counts.length;
      keyMap.set(key, ni);
      counts.push(1);
      newPos.push(x, y, z);
      if (newUV) newUV.push(uvAttr.getX(i), uvAttr.getY(i));
      if (newColor) {
        for (let k = 0; k < colorSize; k++) newColor.push(colAttr.array[i * colorSize + k]);
      }
    } else {
      const c = counts[ni];
      const nc = c + 1;
      counts[ni] = nc;
      newPos[ni * 3] = (newPos[ni * 3] * c + x) / nc;
      newPos[ni * 3 + 1] = (newPos[ni * 3 + 1] * c + y) / nc;
      newPos[ni * 3 + 2] = (newPos[ni * 3 + 2] * c + z) / nc;
    }
    oldToNew[i] = ni;
  }

  const triCount = idx ? Math.floor(idx.length / 3) : Math.floor(vertCount / 3);
  const newIndices = [];
  for (let t = 0; t < triCount; t++) {
    const a = oldToNew[idx ? idx[t * 3] : t * 3];
    const b = oldToNew[idx ? idx[t * 3 + 1] : t * 3 + 1];
    const c = oldToNew[idx ? idx[t * 3 + 2] : t * 3 + 2];
    if (a !== b && b !== c && c !== a) {
      newIndices.push(a, b, c);
    }
  }

  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(newPos, 3));
  if (newUV) out.setAttribute('uv', new THREE.Float32BufferAttribute(newUV, 2));
  if (newColor) out.setAttribute('color', new THREE.Float32BufferAttribute(newColor, colorSize));
  out.setIndex(newIndices);
  out.computeVertexNormals();
  return out;
}

// =============================================================================
// 2. SIMPLE DEFORM MODIFIER (Twist, Bend, Taper, Stretch)
// =============================================================================

export function simpleDeformMesh(geometry, params = {}) {
  const mode = String(params.mode || 'twist').toLowerCase();
  const axis = String(params.axis || 'y').toLowerCase();
  const angleRad = ((Number(params.angleDeg ?? 45)) * Math.PI) / 180;
  const factor = Number(params.factor ?? 0.5);
  const lockX = Boolean(params.lockX);
  const lockY = Boolean(params.lockY);
  const limitMin = Math.max(0, Math.min(1, Number(params.limitMin ?? 0)));
  const limitMax = Math.max(limitMin + 1e-4, Math.min(1, Number(params.limitMax ?? 1)));

  const out = geometry.clone();
  const pos = out.attributes.position;
  if (!pos) return out;
  out.computeBoundingBox();
  const bb = out.boundingBox;
  const axIdx = axis === 'x' ? 0 : (axis === 'z' ? 2 : 1);
  const o1Idx = (axIdx + 1) % 3;
  const o2Idx = (axIdx + 2) % 3;
  const minVal = bb.min.getComponent(axIdx);
  const maxVal = bb.max.getComponent(axIdx);
  const span = Math.max(1e-5, maxVal - minVal);
  const centerVal = 0.5 * (minVal + maxVal);
  const halfSpan = 0.5 * span;

  const vec = [0, 0, 0];
  for (let i = 0; i < pos.count; i++) {
    vec[0] = pos.getX(i);
    vec[1] = pos.getY(i);
    vec[2] = pos.getZ(i);
    const c = vec[axIdx];
    const tRaw = (c - minVal) / span;
    const tClamped = Math.max(limitMin, Math.min(limitMax, tRaw));
    const normCenter = ((minVal + tClamped * span) - centerVal) / halfSpan; // [-1, +1]

    if (mode === 'twist') {
      const th = angleRad * 0.5 * normCenter;
      const cs = Math.cos(th), sn = Math.sin(th);
      const a = vec[o1Idx], b = vec[o2Idx];
      vec[o1Idx] = a * cs - b * sn;
      vec[o2Idx] = a * sn + b * cs;
    } else if (mode === 'bend') {
      if (Math.abs(angleRad) > 1e-5) {
        const theta = angleRad * 0.5 * normCenter;
        const R = span / angleRad;
        const r = R - vec[o1Idx];
        const newAx = centerVal + r * Math.sin(theta);
        const newO1 = R - r * Math.cos(theta);
        vec[axIdx] = newAx;
        vec[o1Idx] = newO1;
      }
    } else if (mode === 'taper') {
      const s = Math.max(0.01, 1.0 + factor * normCenter);
      if (!lockX) vec[o1Idx] *= s;
      if (!lockY) vec[o2Idx] *= s;
    } else if (mode === 'stretch') {
      const s = 1.0 + factor;
      vec[axIdx] = centerVal + (c - centerVal) * s;
      const lat = s > 0.05 ? 1.0 / Math.sqrt(s) : 1.0;
      if (!lockX) vec[o1Idx] *= lat;
      if (!lockY) vec[o2Idx] *= lat;
    }

    pos.setXYZ(i, vec[0], vec[1], vec[2]);
  }
  pos.needsUpdate = true;
  out.computeVertexNormals();
  return out;
}

// =============================================================================
// 3. CAST MODIFIER (Sphere, Cylinder, Cuboid)
// =============================================================================

export function castMesh(geometry, params = {}) {
  const shape = String(params.shape || 'sphere').toLowerCase();
  const factor = Number(params.factor ?? 0.6);
  const out = geometry.clone();
  const pos = out.attributes.position;
  if (!pos) return out;
  out.computeBoundingSphere();
  const autoR = out.boundingSphere?.radius || 1.0;
  const r = Number(params.radius || 0) > 1e-5 ? Number(params.radius) : autoR;

  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    let tx = x, ty = y, tz = z;
    if (shape === 'cylinder') {
      const len = Math.hypot(x, z);
      if (len > 1e-7) {
        tx = (x / len) * r;
        tz = (z / len) * r;
      }
    } else if (shape === 'cuboid') {
      const m = Math.max(Math.abs(x), Math.abs(y), Math.abs(z));
      if (m > 1e-7) {
        tx = (x / m) * r;
        ty = (y / m) * r;
        tz = (z / m) * r;
      }
    } else {
      const len = Math.hypot(x, y, z);
      if (len > 1e-7) {
        tx = (x / len) * r;
        ty = (y / len) * r;
        tz = (z / len) * r;
      }
    }
    pos.setXYZ(i, x + (tx - x) * factor, y + (ty - y) * factor, z + (tz - z) * factor);
  }
  pos.needsUpdate = true;
  out.computeVertexNormals();
  return out;
}

// =============================================================================
// 4. WAVE MODIFIER
// =============================================================================

export function waveMesh(geometry, params = {}) {
  const height = Number(params.height ?? 0.25);
  const width = Math.max(0.05, Number(params.width ?? 1.2));
  const phase = Number(params.phase ?? 0.0);
  const time = Number(params.time ?? 0.0);
  const speed = Number(params.speed ?? 1.0);
  const motionX = params.motionX !== false;
  const motionZ = params.motionZ !== false;
  const cx = Number(params.centerX ?? 0.0);
  const cz = Number(params.centerZ ?? 0.0);
  const falloff = Number(params.falloffRadius ?? 0.0);

  const out = geometry.clone();
  const pos = out.attributes.position;
  if (!pos) return out;

  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const dx = motionX ? x - cx : 0;
    const dz = motionZ ? z - cz : 0;
    const d = Math.hypot(dx, dz);
    let atten = 1.0;
    if (falloff > 1e-4) {
      atten = Math.max(0, 1.0 - d / falloff);
      atten = atten * atten;
    }
    const offset = height * Math.cos((d * Math.PI * 2) / width - (phase + time * speed)) * atten;
    pos.setY(i, y + offset);
  }
  pos.needsUpdate = true;
  out.computeVertexNormals();
  return out;
}

// =============================================================================
// 5. SHRINKWRAP MODIFIER
// =============================================================================

export function shrinkwrapMesh(geometry, params = {}) {
  const { geom: tgtGeom, owned } = resolveTargetGeometry(params);
  const out = geometry.clone();
  if (!tgtGeom) return out;
  try {
    const pos = out.attributes.position;
    if (!pos) return out;
    if (!out.attributes.normal) out.computeVertexNormals();
    const nrm = out.attributes.normal;
    const bvh = ensureBVHLocal(tgtGeom);

    const tgtIdx = tgtGeom.index ? tgtGeom.index.array : null;
    const tgtPos = tgtGeom.attributes.position;

    // Matrix transforming source local -> target local
    const mSrcToTgt = new THREE.Matrix4();
    if (Array.isArray(params._relativeMatrix) && params._relativeMatrix.length === 16) {
      // _relativeMatrix = inv(host) * target -> so source->target = inv(_relativeMatrix)
      mSrcToTgt.fromArray(params._relativeMatrix).invert();
    }
    const mTgtToSrc = mSrcToTgt.clone().invert();
    const normSrcToTgt = new THREE.Matrix3().getNormalMatrix(mSrcToTgt);

    const offset = Number(params.offset ?? 0.0);
    const mode = String(params.mode || 'nearest_surface').toLowerCase();
    const raycaster = new THREE.Raycaster();
    const pTgt = new THREE.Vector3();
    const hitTmp = { point: new THREE.Vector3(), distance: 0, faceIndex: 0 };
    const va = new THREE.Vector3(), vb = new THREE.Vector3(), vc = new THREE.Vector3();
    const faceN = new THREE.Vector3();

    for (let i = 0; i < pos.count; i++) {
      pTgt.set(pos.getX(i), pos.getY(i), pos.getZ(i)).applyMatrix4(mSrcToTgt);
      let snapped = false;

      if (mode === 'project_normal' || mode === 'project_axis') {
        const dir = mode === 'project_axis'
          ? new THREE.Vector3(params.axis === 'x' ? 1 : 0, params.axis === 'y' || !params.axis ? 1 : 0, params.axis === 'z' ? 1 : 0)
          : new THREE.Vector3(nrm.getX(i), nrm.getY(i), nrm.getZ(i)).applyMatrix3(normSrcToTgt).normalize();
        const tryDirs = [dir, dir.clone().negate()];
        let best = null;
        for (const d of tryDirs) {
          raycaster.set(pTgt, d);
          const hits = bvh.raycast(raycaster.ray, THREE.DoubleSide);
          if (hits && hits.length > 0 && (!best || hits[0].distance < best.distance)) {
            best = hits[0];
          }
        }
        if (best) {
          pTgt.copy(best.point);
          if (best.face?.normal) pTgt.addScaledVector(best.face.normal, offset);
          snapped = true;
        }
      }

      if (!snapped) {
        const hit = bvh.closestPointToPoint(pTgt, hitTmp);
        if (hit) {
          const fi = hit.faceIndex;
          const ia = tgtIdx ? tgtIdx[fi * 3] : fi * 3;
          const ib = tgtIdx ? tgtIdx[fi * 3 + 1] : fi * 3 + 1;
          const ic = tgtIdx ? tgtIdx[fi * 3 + 2] : fi * 3 + 2;
          va.fromBufferAttribute(tgtPos, ia);
          vb.fromBufferAttribute(tgtPos, ib);
          vc.fromBufferAttribute(tgtPos, ic);
          faceN.subVectors(vb, va).cross(vc.sub(va)).normalize();
          pTgt.copy(hit.point).addScaledVector(faceN, offset);
        }
      }

      pTgt.applyMatrix4(mTgtToSrc);
      pos.setXYZ(i, pTgt.x, pTgt.y, pTgt.z);
    }
    pos.needsUpdate = true;
    out.computeVertexNormals();
    return out;
  } finally {
    if (owned) tgtGeom.dispose();
  }
}

// =============================================================================
// 6. DATA TRANSFER MODIFIER (Normals, UVs, Vertex Colors via BVH)
// =============================================================================

export function dataTransferMesh(geometry, params = {}) {
  const { geom: tgtGeom, owned } = resolveTargetGeometry(params);
  const out = geometry.clone();
  if (!tgtGeom) return out;
  try {
    const pos = out.attributes.position;
    if (!pos) return out;
    if (!out.attributes.normal) out.computeVertexNormals();
    const bvh = ensureBVHLocal(tgtGeom);
    const tgtPos = tgtGeom.attributes.position;
    const tgtNrm = tgtGeom.attributes.normal;
    const tgtUv = tgtGeom.attributes.uv;
    const tgtCol = tgtGeom.attributes.color;
    const tgtIdx = tgtGeom.index ? tgtGeom.index.array : null;

    const transferNormals = params.transferNormals !== false && Boolean(tgtNrm);
    const transferUVs = Boolean(params.transferUVs) && Boolean(tgtUv);
    const transferColors = Boolean(params.transferColors) && Boolean(tgtCol);
    const mixFactor = Math.max(0, Math.min(1, Number(params.mixFactor ?? 1.0)));

    if (transferUVs && !out.attributes.uv) {
      out.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(pos.count * 2), 2));
    }
    if (transferColors && !out.attributes.color) {
      out.setAttribute('color', new THREE.BufferAttribute(new Float32Array(pos.count * 3).fill(1), 3));
    }

    const mSrcToTgt = new THREE.Matrix4();
    if (Array.isArray(params._relativeMatrix) && params._relativeMatrix.length === 16) {
      mSrcToTgt.fromArray(params._relativeMatrix).invert();
    }
    const mTgtToSrc = mSrcToTgt.clone().invert();
    const nrmTgtToSrc = new THREE.Matrix3().getNormalMatrix(mTgtToSrc);

    const pTgt = new THREE.Vector3();
    const hitTmp = { point: new THREE.Vector3(), distance: 0, faceIndex: 0 };
    const va = new THREE.Vector3(), vb = new THREE.Vector3(), vc = new THREE.Vector3();
    const na = new THREE.Vector3(), nb = new THREE.Vector3(), nc = new THREE.Vector3(), nRes = new THREE.Vector3();

    for (let i = 0; i < pos.count; i++) {
      pTgt.set(pos.getX(i), pos.getY(i), pos.getZ(i)).applyMatrix4(mSrcToTgt);
      const hit = bvh.closestPointToPoint(pTgt, hitTmp);
      if (!hit) continue;
      const fi = hit.faceIndex;
      const ia = tgtIdx ? tgtIdx[fi * 3] : fi * 3;
      const ib = tgtIdx ? tgtIdx[fi * 3 + 1] : fi * 3 + 1;
      const ic = tgtIdx ? tgtIdx[fi * 3 + 2] : fi * 3 + 2;
      va.fromBufferAttribute(tgtPos, ia);
      vb.fromBufferAttribute(tgtPos, ib);
      vc.fromBufferAttribute(tgtPos, ic);
      const [w0, w1, w2] = computeTriBarycentric(hit.point, va, vb, vc);

      if (transferNormals) {
        na.fromBufferAttribute(tgtNrm, ia);
        nb.fromBufferAttribute(tgtNrm, ib);
        nc.fromBufferAttribute(tgtNrm, ic);
        nRes.set(0, 0, 0).addScaledVector(na, w0).addScaledVector(nb, w1).addScaledVector(nc, w2).applyMatrix3(nrmTgtToSrc).normalize();
        const curN = new THREE.Vector3().fromBufferAttribute(out.attributes.normal, i);
        curN.lerp(nRes, mixFactor).normalize();
        out.attributes.normal.setXYZ(i, curN.x, curN.y, curN.z);
      }
      if (transferUVs) {
        const u = tgtUv.getX(ia) * w0 + tgtUv.getX(ib) * w1 + tgtUv.getX(ic) * w2;
        const v = tgtUv.getY(ia) * w0 + tgtUv.getY(ib) * w1 + tgtUv.getY(ic) * w2;
        out.attributes.uv.setXY(i, u, v);
      }
      if (transferColors) {
        const r = tgtCol.getX(ia) * w0 + tgtCol.getX(ib) * w1 + tgtCol.getX(ic) * w2;
        const g = tgtCol.getY(ia) * w0 + tgtCol.getY(ib) * w1 + tgtCol.getY(ic) * w2;
        const b = tgtCol.getZ(ia) * w0 + tgtCol.getZ(ib) * w1 + tgtCol.getZ(ic) * w2;
        out.attributes.color.setXYZ(i, r, g, b);
      }
    }
    if (transferNormals) out.attributes.normal.needsUpdate = true;
    if (transferUVs) out.attributes.uv.needsUpdate = true;
    if (transferColors) out.attributes.color.needsUpdate = true;
    return out;
  } finally {
    if (owned) tgtGeom.dispose();
  }
}

// =============================================================================
// 7. CURVE DEFORM MODIFIER
// =============================================================================

export function curveDeformMesh(geometry, params = {}) {
  const spine = params._curveSpine;
  const out = geometry.clone();
  if (!spine?.points?.length || spine.points.length < 2) return out;

  const pos = out.attributes.position;
  if (!pos) return out;
  out.computeBoundingBox();
  const deformAxis = String(params.deformAxis || 'x').toLowerCase();
  const axIdx = deformAxis === 'y' ? 1 : (deformAxis === 'z' ? 2 : 0);
  const o1Idx = (axIdx + 1) % 3;
  const o2Idx = (axIdx + 2) % 3;

  const minS = out.boundingBox.min.getComponent(axIdx);
  const maxS = out.boundingBox.max.getComponent(axIdx);
  const meshSpan = Math.max(1e-5, maxS - minS);
  const arcs = spine.arcLengths;
  const totalLen = Math.max(1e-5, spine.totalLength);
  const stretch = Boolean(params.stretch);

  const pts = spine.points.map((p) => (p.isVector3 ? p : new THREE.Vector3(p.x, p.y, p.z)));
  const nrms = spine.normals.map((p) => (p.isVector3 ? p : new THREE.Vector3(p.x, p.y, p.z)));
  const bins = spine.binormals.map((p) => (p.isVector3 ? p : new THREE.Vector3(p.x, p.y, p.z)));

  const mTgtToHost = Array.isArray(params._relativeMatrix) && params._relativeMatrix.length === 16
    ? new THREE.Matrix4().fromArray(params._relativeMatrix)
    : null;

  const sampleAtArc = (sTarget) => {
    const s = Math.max(0, Math.min(totalLen, sTarget));
    let seg = 0;
    while (seg < arcs.length - 2 && arcs[seg + 1] < s) seg++;
    const segLen = Math.max(1e-6, arcs[seg + 1] - arcs[seg]);
    const t = Math.max(0, Math.min(1, (s - arcs[seg]) / segLen));
    const p = pts[seg].clone().lerp(pts[seg + 1], t);
    const n = nrms[seg].clone().lerp(nrms[seg + 1], t).normalize();
    const b = bins[seg].clone().lerp(bins[seg + 1], t).normalize();
    return { p, n, b };
  };

  const coord = [0, 0, 0];
  for (let i = 0; i < pos.count; i++) {
    coord[0] = pos.getX(i); coord[1] = pos.getY(i); coord[2] = pos.getZ(i);
    const sNorm = (coord[axIdx] - minS) / meshSpan;
    const sArc = stretch ? sNorm * totalLen : (coord[axIdx] - minS);
    const frame = sampleAtArc(sArc);
    const worldPt = frame.p.addScaledVector(frame.n, coord[o1Idx]).addScaledVector(frame.b, coord[o2Idx]);
    if (mTgtToHost) worldPt.applyMatrix4(mTgtToHost);
    pos.setXYZ(i, worldPt.x, worldPt.y, worldPt.z);
  }
  pos.needsUpdate = true;
  out.computeVertexNormals();
  return out;
}

// =============================================================================
// 8. LATTICE (FFD) MODIFIER
// =============================================================================

export function buildDefaultLatticeGrid(resU = 2, resV = 2, resW = 2, preset = 'none', strength = 0.5) {
  const nu = Math.max(2, Math.min(6, resU | 0));
  const nv = Math.max(2, Math.min(6, resV | 0));
  const nw = Math.max(2, Math.min(6, resW | 0));
  const pts = new Float32Array(nu * nv * nw * 3);
  for (let k = 0; k < nw; k++) {
    const w = k / (nw - 1);
    for (let j = 0; j < nv; j++) {
      const v = j / (nv - 1);
      for (let i = 0; i < nu; i++) {
        const u = i / (nu - 1);
        let x = u - 0.5, y = v - 0.5, z = w - 0.5;
        if (preset === 'taper_top') {
          const s = Math.max(0.1, 1.0 - strength * v);
          x *= s; z *= s;
        } else if (preset === 'shear_x') {
          x += strength * (v - 0.5);
        } else if (preset === 'arch_y') {
          y += strength * Math.cos((u - 0.5) * Math.PI);
        }
        const idx = ((k * nv + j) * nu + i) * 3;
        pts[idx] = x + 0.5;
        pts[idx + 1] = y + 0.5;
        pts[idx + 2] = z + 0.5;
      }
    }
  }
  return pts;
}

function bernstein(n, i, t) {
  // Exact Bernstein basis for 0 <= n <= 5
  const binom = [[1], [1, 1], [1, 2, 1], [1, 3, 3, 1], [1, 4, 6, 4, 1], [1, 5, 10, 10, 5, 1]];
  return binom[n][i] * Math.pow(t, i) * Math.pow(1 - t, n - i);
}

export function latticeDeformMesh(geometry, params = {}) {
  const nu = Math.max(2, Math.min(6, (params.resU ?? 3) | 0));
  const nv = Math.max(2, Math.min(6, (params.resV ?? 3) | 0));
  const nw = Math.max(2, Math.min(6, (params.resW ?? 3) | 0));
  const out = geometry.clone();
  const pos = out.attributes.position;
  if (!pos) return out;
  out.computeBoundingBox();
  const bb = out.boundingBox;
  const bMin = params.boundsMin ? new THREE.Vector3(...params.boundsMin) : bb.min;
  const bMax = params.boundsMax ? new THREE.Vector3(...params.boundsMax) : bb.max;
  const span = new THREE.Vector3(
    Math.max(1e-5, bMax.x - bMin.x),
    Math.max(1e-5, bMax.y - bMin.y),
    Math.max(1e-5, bMax.z - bMin.z)
  );

  const grid = Array.isArray(params.latticePoints) || params.latticePoints instanceof Float32Array
    ? params.latticePoints
    : buildDefaultLatticeGrid(nu, nv, nw, params.preset || 'taper_top', Number(params.strength ?? 0.5));

  for (let pIdx = 0; pIdx < pos.count; pIdx++) {
    const u = Math.max(0, Math.min(1, (pos.getX(pIdx) - bMin.x) / span.x));
    const v = Math.max(0, Math.min(1, (pos.getY(pIdx) - bMin.y) / span.y));
    const w = Math.max(0, Math.min(1, (pos.getZ(pIdx) - bMin.z) / span.z));

    let rx = 0, ry = 0, rz = 0;
    for (let k = 0; k < nw; k++) {
      const bk = bernstein(nw - 1, k, w);
      for (let j = 0; j < nv; j++) {
        const bj = bernstein(nv - 1, j, v) * bk;
        for (let i = 0; i < nu; i++) {
          const weight = bernstein(nu - 1, i, u) * bj;
          const off = ((k * nv + j) * nu + i) * 3;
          rx += grid[off] * weight;
          ry += grid[off + 1] * weight;
          rz += grid[off + 2] * weight;
        }
      }
    }
    pos.setXYZ(pIdx, bMin.x + rx * span.x, bMin.y + ry * span.y, bMin.z + rz * span.z);
  }
  pos.needsUpdate = true;
  out.computeVertexNormals();
  return out;
}

// =============================================================================
// 9. SKIN MODIFIER (Skeleton / Edge-Graph Tubular Volume Envelope)
// =============================================================================

export function skinMesh(geometry, params = {}) {
  const posAttr = geometry?.attributes?.position;
  if (!posAttr || posAttr.count === 0) return new THREE.BufferGeometry();
  const radius = Math.max(0.01, Number(params.thickness ?? 0.12));
  const radialSegs = Math.max(4, Math.min(16, (params.radialSegments ?? 8) | 0));
  const idx = geometry.index ? geometry.index.array : null;

  // Deduplicate vertices & edges via spatial keys so split faces share clean joints
  const invTol = 1e4;
  const keyMap = new Map();
  const nodes = [];
  const vertToNode = new Int32Array(posAttr.count);
  for (let i = 0; i < posAttr.count; i++) {
    const x = posAttr.getX(i), y = posAttr.getY(i), z = posAttr.getZ(i);
    const k = `${Math.round(x * invTol)}_${Math.round(y * invTol)}_${Math.round(z * invTol)}`;
    let ni = keyMap.get(k);
    if (ni === undefined) {
      ni = nodes.length;
      keyMap.set(k, ni);
      nodes.push(new THREE.Vector3(x, y, z));
    }
    vertToNode[i] = ni;
  }

  const edgeSet = new Set();
  const edges = [];
  const addEdge = (a, b) => {
    if (a === b) return;
    const lo = Math.min(a, b), hi = Math.max(a, b);
    const key = `${lo}_${hi}`;
    if (edgeSet.has(key)) return;
    edgeSet.add(key);
    edges.push([lo, hi]);
  };

  if (idx) {
    const triCount = Math.floor(idx.length / 3);
    for (let t = 0; t < triCount; t++) {
      const a = vertToNode[idx[t * 3]], b = vertToNode[idx[t * 3 + 1]], c = vertToNode[idx[t * 3 + 2]];
      addEdge(a, b); addEdge(b, c); addEdge(c, a);
    }
  } else if (posAttr.count >= 3) {
    for (let t = 0; t + 2 < posAttr.count; t += 3) {
      const a = vertToNode[t], b = vertToNode[t + 1], c = vertToNode[t + 2];
      addEdge(a, b); addEdge(b, c); addEdge(c, a);
    }
  } else if (nodes.length >= 2) {
    for (let i = 0; i + 1 < nodes.length; i++) addEdge(i, i + 1);
  }

  const outPos = [];
  const outNrm = [];
  const outUv = [];

  const pushTri = (pa, pb, pc) => {
    const e1 = pb.clone().sub(pa), e2 = pc.clone().sub(pa);
    const n = e1.cross(e2).normalize();
    outPos.push(pa.x, pa.y, pa.z, pb.x, pb.y, pb.z, pc.x, pc.y, pc.z);
    outNrm.push(n.x, n.y, n.z, n.x, n.y, n.z, n.x, n.y, n.z);
    outUv.push(0, 0, 1, 0, 0.5, 1);
  };

  // Joint spheres
  const sphProto = new THREE.SphereGeometry(radius, radialSegs, Math.max(4, Math.floor(radialSegs / 2)));
  const spNon = sphProto.toNonIndexed();
  const spPos = spNon.attributes.position;
  for (const node of nodes) {
    for (let t = 0; t < spPos.count; t += 3) {
      const a = new THREE.Vector3().fromBufferAttribute(spPos, t).add(node);
      const b = new THREE.Vector3().fromBufferAttribute(spPos, t + 1).add(node);
      const c = new THREE.Vector3().fromBufferAttribute(spPos, t + 2).add(node);
      pushTri(a, b, c);
    }
  }
  sphProto.dispose();
  spNon.dispose();

  // Edge limb cylinders
  const upVec = new THREE.Vector3(0, 1, 0);
  for (const [ia, ib] of edges) {
    const a = nodes[ia], b = nodes[ib];
    const diff = b.clone().sub(a);
    const len = diff.length();
    if (len < 1e-5) continue;
    const mid = a.clone().add(b).multiplyScalar(0.5);
    const q = new THREE.Quaternion().setFromUnitVectors(upVec, diff.normalize());
    const cyl = new THREE.CylinderGeometry(radius * 0.92, radius * 0.92, len, radialSegs, 1, true);
    const cNon = cyl.toNonIndexed();
    const cPos = cNon.attributes.position;
    for (let t = 0; t < cPos.count; t += 3) {
      const p0 = new THREE.Vector3().fromBufferAttribute(cPos, t).applyQuaternion(q).add(mid);
      const p1 = new THREE.Vector3().fromBufferAttribute(cPos, t + 1).applyQuaternion(q).add(mid);
      const p2 = new THREE.Vector3().fromBufferAttribute(cPos, t + 2).applyQuaternion(q).add(mid);
      pushTri(p0, p1, p2);
    }
    cyl.dispose();
    cNon.dispose();
  }

  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(outPos, 3));
  out.setAttribute('normal', new THREE.Float32BufferAttribute(outNrm, 3));
  out.setAttribute('uv', new THREE.Float32BufferAttribute(outUv, 2));
  return weldMesh(out, { distance: 1e-4 });
}

// =============================================================================
// 10. REMESH MODIFIER (Watertight Surface-Nets Voxel Remesh & Blocks)
// =============================================================================

export function remeshGeometry(geometry, params = {}) {
  const mode = String(params.mode || 'voxel').toLowerCase();
  const smoothIters = Math.max(0, Math.min(8, (params.smoothIterations ?? 2) | 0));
  const posAttr = geometry?.attributes?.position;
  if (!posAttr || posAttr.count < 3) return geometry.clone();

  const workGeo = geometry.clone();
  workGeo.computeBoundingBox();
  const bb = workGeo.boundingBox;
  const size = bb.getSize(new THREE.Vector3());
  const diag = Math.max(1e-3, size.length());

  // Adaptive step ensures resolution scales smoothly across tiny or huge scenes without locking memory
  let step = Math.max(diag * 0.006, Number(params.voxelSize ?? diag * 0.08));
  const pad = step * 1.5;
  const minB = bb.min.clone().addScalar(-pad);
  const maxB = bb.max.clone().addScalar(pad);
  const fullSize = maxB.clone().sub(minB);
  while ((fullSize.x / step) * (fullSize.y / step) * (fullSize.z / step) > 96000) {
    step *= 1.18;
  }

  const nx = Math.max(3, Math.ceil(fullSize.x / step) + 1);
  const ny = Math.max(3, Math.ceil(fullSize.y / step) + 1);
  const nz = Math.max(3, Math.ceil(fullSize.z / step) + 1);

  const bvh = ensureBVHLocal(workGeo);
  const raycaster = new THREE.Raycaster();
  const hitTmp = { point: new THREE.Vector3(), distance: 0, faceIndex: 0 };
  const samplePt = new THREE.Vector3();
  const dirs = [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1)];

  // Evaluate signed occupancy on grid corners (- inside, + outside)
  const totalCorners = nx * ny * nz;
  const phi = new Float32Array(totalCorners);
  const cornerIdx = (ix, iy, iz) => (iz * ny + iy) * nx + ix;

  for (let iz = 0; iz < nz; iz++) {
    for (let iy = 0; iy < ny; iy++) {
      for (let ix = 0; ix < nx; ix++) {
        samplePt.set(minB.x + ix * step, minB.y + iy * step, minB.z + iz * step);
        const h = bvh.closestPointToPoint(samplePt, hitTmp);
        let dist = h ? h.distance : diag;
        // Majority parity vote across 3 cardinal rays for watertight inside/outside sign
        let inVotes = 0;
        for (let r = 0; r < 3; r++) {
          raycaster.set(samplePt, dirs[r]);
          const hits = bvh.raycast(raycaster.ray, THREE.DoubleSide);
          if (hits && (hits.length % 2 === 1)) inVotes++;
        }
        if (inVotes >= 2) dist = -dist;
        phi[cornerIdx(ix, iy, iz)] = dist;
      }
    }
  }

  const outVerts = [];
  const outIdx = [];

  if (mode === 'blocks') {
    const cx = nx - 1, cy = ny - 1, cz = nz - 1;
    const isSolid = (ix, iy, iz) => {
      if (ix < 0 || iy < 0 || iz < 0 || ix >= cx || iy >= cy || iz >= cz) return false;
      samplePt.set(minB.x + (ix + 0.5) * step, minB.y + (iy + 0.5) * step, minB.z + (iz + 0.5) * step);
      let votes = 0;
      for (let r = 0; r < 3; r++) {
        raycaster.set(samplePt, dirs[r]);
        const hits = bvh.raycast(raycaster.ray, THREE.DoubleSide);
        if (hits && (hits.length % 2 === 1)) votes++;
      }
      return votes >= 2;
    };
    const emitQuad = (p0, p1, p2, p3) => {
      const b = outVerts.length / 3;
      outVerts.push(p0[0], p0[1], p0[2], p1[0], p1[1], p1[2], p2[0], p2[1], p2[2], p3[0], p3[1], p3[2]);
      outIdx.push(b, b + 1, b + 2, b, b + 2, b + 3);
    };
    for (let z = 0; z < cz; z++) {
      for (let y = 0; y < cy; y++) {
        for (let x = 0; x < cx; x++) {
          if (!isSolid(x, y, z)) continue;
          const x0 = minB.x + x * step, x1 = x0 + step;
          const y0 = minB.y + y * step, y1 = y0 + step;
          const z0 = minB.z + z * step, z1 = z0 + step;
          if (!isSolid(x + 1, y, z)) emitQuad([x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1]);
          if (!isSolid(x - 1, y, z)) emitQuad([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]);
          if (!isSolid(x, y + 1, z)) emitQuad([x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0]);
          if (!isSolid(x, y - 1, z)) emitQuad([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]);
          if (!isSolid(x, y, z + 1)) emitQuad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]);
          if (!isSolid(x, y, z - 1)) emitQuad([x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0]);
        }
      }
    }
  } else {
    // Surface-Nets dual vertex extraction per surface-crossing cell
    const cx = nx - 1, cy = ny - 1, cz = nz - 1;
    const cellVert = new Int32Array(cx * cy * cz).fill(-1);
    const cellIdx = (x, y, z) => (z * cy + y) * cx + x;
    const edgePairs = [
      [0, 1], [2, 3], [4, 5], [6, 7],
      [0, 2], [1, 3], [4, 6], [5, 7],
      [0, 4], [1, 5], [2, 6], [3, 7],
    ];
    const cornerOff = [
      [0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0],
      [0, 0, 1], [1, 0, 1], [0, 1, 1], [1, 1, 1],
    ];

    for (let z = 0; z < cz; z++) {
      for (let y = 0; y < cy; y++) {
        for (let x = 0; x < cx; x++) {
          let mask = 0;
          const vals = [0, 0, 0, 0, 0, 0, 0, 0];
          for (let c = 0; c < 8; c++) {
            const o = cornerOff[c];
            vals[c] = phi[cornerIdx(x + o[0], y + o[1], z + o[2])];
            if (vals[c] < 0) mask |= (1 << c);
          }
          if (mask === 0 || mask === 255) continue;

          let sx = 0, sy = 0, sz = 0, ecnt = 0;
          for (const [a, b] of edgePairs) {
            if ((vals[a] < 0) === (vals[b] < 0)) continue;
            const t = vals[a] / (vals[a] - vals[b]);
            const oa = cornerOff[a], ob = cornerOff[b];
            sx += oa[0] + (ob[0] - oa[0]) * t;
            sy += oa[1] + (ob[1] - oa[1]) * t;
            sz += oa[2] + (ob[2] - oa[2]) * t;
            ecnt++;
          }
          if (ecnt === 0) continue;
          const vid = outVerts.length / 3;
          outVerts.push(
            minB.x + (x + sx / ecnt) * step,
            minB.y + (y + sy / ecnt) * step,
            minB.z + (z + sz / ecnt) * step
          );
          cellVert[cellIdx(x, y, z)] = vid;
        }
      }
    }

    const pushDualQuad = (v0, v1, v2, v3, flip) => {
      if (v0 < 0 || v1 < 0 || v2 < 0 || v3 < 0) return;
      if (flip) outIdx.push(v0, v3, v2, v0, v2, v1);
      else outIdx.push(v0, v1, v2, v0, v2, v3);
    };

    for (let z = 1; z < cz; z++) {
      for (let y = 1; y < cy; y++) {
        for (let x = 1; x < cx; x++) {
          const s0 = phi[cornerIdx(x, y, z)] < 0;
          if (x < cx - 1 && (phi[cornerIdx(x + 1, y, z)] < 0) !== s0) {
            pushDualQuad(cellVert[cellIdx(x, y - 1, z - 1)], cellVert[cellIdx(x, y, z - 1)], cellVert[cellIdx(x, y, z)], cellVert[cellIdx(x, y - 1, z)], !s0);
          }
          if (y < cy - 1 && (phi[cornerIdx(x, y + 1, z)] < 0) !== s0) {
            pushDualQuad(cellVert[cellIdx(x - 1, y, z - 1)], cellVert[cellIdx(x - 1, y, z)], cellVert[cellIdx(x, y, z)], cellVert[cellIdx(x, y, z - 1)], !s0);
          }
          if (z < cz - 1 && (phi[cornerIdx(x, y, z + 1)] < 0) !== s0) {
            pushDualQuad(cellVert[cellIdx(x - 1, y - 1, z)], cellVert[cellIdx(x, y - 1, z)], cellVert[cellIdx(x, y, z)], cellVert[cellIdx(x - 1, y, z)], !s0);
          }
        }
      }
    }
  }

  workGeo.dispose();
  if (outVerts.length < 9 || outIdx.length < 3) {
    return geometry.clone();
  }

  // Optional Laplacian relaxation for smooth organic remesh
  if (smoothIters > 0 && mode !== 'blocks') {
    const nV = outVerts.length / 3;
    const nbrs = Array.from({ length: nV }, () => new Set());
    for (let t = 0; t + 2 < outIdx.length; t += 3) {
      const a = outIdx[t], b = outIdx[t + 1], c = outIdx[t + 2];
      nbrs[a].add(b); nbrs[a].add(c);
      nbrs[b].add(a); nbrs[b].add(c);
      nbrs[c].add(a); nbrs[c].add(b);
    }
    const scratch = new Float32Array(outVerts.length);
    for (let it = 0; it < smoothIters; it++) {
      scratch.set(outVerts);
      for (let v = 0; v < nV; v++) {
        const set = nbrs[v];
        if (set.size === 0) continue;
        let ax = 0, ay = 0, az = 0;
        for (const n of set) {
          ax += scratch[n * 3]; ay += scratch[n * 3 + 1]; az += scratch[n * 3 + 2];
        }
        const inv = 1 / set.size;
        outVerts[v * 3] = scratch[v * 3] + (ax * inv - scratch[v * 3]) * 0.45;
        outVerts[v * 3 + 1] = scratch[v * 3 + 1] + (ay * inv - scratch[v * 3 + 1]) * 0.45;
        outVerts[v * 3 + 2] = scratch[v * 3 + 2] + (az * inv - scratch[v * 3 + 2]) * 0.45;
      }
    }
  }

  const result = new THREE.BufferGeometry();
  result.setAttribute('position', new THREE.Float32BufferAttribute(outVerts, 3));
  result.setIndex(outIdx);
  result.computeVertexNormals();
  return result;
}
