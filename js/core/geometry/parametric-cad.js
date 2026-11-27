/**
 * @file parametric-cad.js
 * @description Universal, Worker-safe Parametric CAD, Curve-Sweep, Extrude-with-Holes,
 * Lathe, Surface Shell Loft, Compound Merging, GPU Instancing, Triplanar Box UV,
 * Auto-Smooth Crease Normals, and Geometric Vertex Cavity AO for Hunger Studio.
 *
 * 100% pure mathematical geometry (no DOM, no network, no domain hardcoding).
 * Runs identically on Main Thread and inside isolated Copilot / Agent Web Workers.
 */

import * as DEFAULT_THREE from '../../../vendor/three/three.module.js';

function resolveThree(override) {
  return override || DEFAULT_THREE;
}

function pushUnique2D(out, x, y, eps = 1e-6) {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return;
  if (out.length > 0) {
    const prev = out[out.length - 1];
    if (Math.hypot(x - prev[0], y - prev[1]) <= eps) return;
  }
  out.push([x, y]);
}

function signedArea2D(pts) {
  let area = 0;
  for (let i = 0, n = pts.length; i < n; i++) {
    const [x0, y0] = pts[i];
    const [x1, y1] = pts[(i + 1) % n];
    area += x0 * y1 - x1 * y0;
  }
  return 0.5 * area;
}

/**
 * Evaluates a declarative 2D contour (raw `[x, y]` pairs or CAD path operations)
 * into a clean, deduplicated array of `[x, y]` vertices.
 *
 * Supported segment ops:
 * - `[x, y]` or `{ op: 'move' | 'line', to: [x, y] }`
 * - `{ op: 'arc', center: [cx, cy], radius, startAngle, endAngle, ccw, segments }`
 * - `{ op: 'twoCenterArc', centerX, springY, width, excess, reverse, segments }`
 * - `{ op: 'cubic', c1: [x1, y1], c2: [x2, y2], to: [x, y], segments }`
 * - `{ op: 'quad', c: [cx, cy], to: [x, y], segments }`
 * - `{ op: 'circle', center: [cx, cy], radius, segments, reverse }`
 * - `{ op: 'regularPolygon', center: [cx, cy], radius, sides, rotation, reverse }`
 * - `{ op: 'rosette', center: [cx, cy], outerRadius, innerRadius, lobes, rotation, segmentsPerLobe, reverse }`
 */
export function sample2DContour(contour, defaultSegments = 16) {
  if (!contour) return [];
  if (!Array.isArray(contour) && typeof contour === 'object') {
    return sample2DContour([contour], defaultSegments);
  }
  if (!Array.isArray(contour) || contour.length === 0) return [];

  const out = [];
  for (const item of contour) {
    if (Array.isArray(item) && item.length >= 2) {
      pushUnique2D(out, Number(item[0]) || 0, Number(item[1]) || 0);
      continue;
    }
    if (!item || typeof item !== 'object') continue;
    const op = String(item.op || item.type || 'line').toLowerCase();
    const segs = Math.max(2, Math.min(256, Math.round(Number(item.segments) || defaultSegments)));

    if (op === 'move' || op === 'line') {
      const to = item.to || [item.x ?? 0, item.y ?? 0];
      pushUnique2D(out, Number(to[0]) || 0, Number(to[1]) || 0);
    } else if (op === 'poly' || op === 'points') {
      for (const pt of item.points || []) {
        if (Array.isArray(pt) && pt.length >= 2) {
          pushUnique2D(out, Number(pt[0]) || 0, Number(pt[1]) || 0);
        } else if (pt && typeof pt === 'object' && ('x' in pt || 'y' in pt)) {
          pushUnique2D(out, Number(pt.x) || 0, Number(pt.y) || 0);
        }
      }
    } else if (op === 'rect' || op === 'rectangle' || op === 'roundedrect') {
      const cx = Number(item.center?.[0] ?? item.centerX ?? item.cx ?? 0);
      const cy = Number(item.center?.[1] ?? item.centerY ?? item.cy ?? 0);
      const w = Math.max(1e-4, Number(item.width ?? item.w ?? 1));
      const h = Math.max(1e-4, Number(item.height ?? item.h ?? 1));
      const hw = w * 0.5;
      const hh = h * 0.5;
      const r = op === 'roundedrect'
        ? Math.max(0, Math.min(hw * 0.99, hh * 0.99, Number(item.radius ?? item.r ?? Math.min(w, h) * 0.12)))
        : Math.max(0, Math.min(hw * 0.99, hh * 0.99, Number(item.radius ?? item.r ?? 0)));
      const pts = [];
      if (r > 1e-5) {
        const cornerSegs = Math.max(2, Math.min(16, Math.round(segs / 4)));
        const corners = [
          [cx + hw - r, cy - hh + r, -Math.PI / 2, 0],
          [cx + hw - r, cy + hh - r, 0, Math.PI / 2],
          [cx - hw + r, cy + hh - r, Math.PI / 2, Math.PI],
          [cx - hw + r, cy - hh + r, Math.PI, Math.PI * 1.5],
        ];
        for (const [ccx, ccy, a0, a1] of corners) {
          for (let i = 0; i <= cornerSegs; i++) {
            const ang = a0 + ((a1 - a0) * i) / cornerSegs;
            pts.push([ccx + Math.cos(ang) * r, ccy + Math.sin(ang) * r]);
          }
        }
      } else {
        pts.push([cx - hw, cy - hh], [cx + hw, cy - hh], [cx + hw, cy + hh], [cx - hw, cy + hh]);
      }
      if (item.reverse) pts.reverse();
      for (const [px, py] of pts) pushUnique2D(out, px, py);
    } else if (op === 'arc') {
      const cx = Number(item.center?.[0] ?? item.cx ?? 0);
      const cy = Number(item.center?.[1] ?? item.cy ?? 0);
      const r = Math.max(1e-5, Number(item.radius ?? 1));
      const a0 = Number(item.startAngle ?? 0);
      const a1 = Number(item.endAngle ?? Math.PI);
      for (let i = 0; i <= segs; i++) {
        const t = i / segs;
        const ang = a0 + (a1 - a0) * t;
        pushUnique2D(out, cx + Math.cos(ang) * r, cy + Math.sin(ang) * r);
      }
    } else if (op === 'twocenterarc' || op === 'biarc' || op === 'ogive' || op === 'pointedarch' || op === 'arch') {
      // General 2-center symmetrical arch from (-W/2, springY) over apex to (+W/2, springY).
      // Supports explicit `excess` OR direct total `height` (plus optional `baseY` legs).
      const cx0 = Number(item.centerX ?? item.cx ?? 0);
      const sy = Number(item.springY ?? 0);
      const w = Math.max(1e-4, Number(item.width ?? 2));
      let excess;
      if (item.excess !== undefined && Number.isFinite(Number(item.excess))) {
        excess = Math.max(0, Number(item.excess));
      } else if (item.height !== undefined && Number.isFinite(Number(item.height))) {
        const rise = Math.max(w * 0.5, Number(item.height) - sy);
        excess = Math.max(0, (rise / w) * (rise / w) - 0.25);
      } else {
        excess = 0.5;
      }
      const r = (excess + 0.5) * w;
      const offset = excess * w;
      const thetaMax = Math.acos(Math.min(1, Math.max(-1, offset / r)));
      const arcPts = [];
      const baseY = item.baseY !== undefined && Number.isFinite(Number(item.baseY)) ? Number(item.baseY) : null;
      if (baseY !== null && baseY < sy - 1e-5) {
        arcPts.push([cx0 - w * 0.5, baseY]);
      }
      for (let i = 0; i <= segs; i++) {
        const ang = Math.PI - (i / segs) * thetaMax;
        arcPts.push([cx0 + offset + r * Math.cos(ang), sy + r * Math.sin(ang)]);
      }
      for (let i = 1; i <= segs; i++) {
        const ang = thetaMax * (1 - i / segs);
        arcPts.push([cx0 - offset + r * Math.cos(ang), sy + r * Math.sin(ang)]);
      }
      if (baseY !== null && baseY < sy - 1e-5) {
        arcPts.push([cx0 + w * 0.5, baseY]);
      }
      if (item.reverse) arcPts.reverse();
      for (const [px, py] of arcPts) pushUnique2D(out, px, py);
    } else if (op === 'quad') {
      const start = out.length ? out[out.length - 1] : (item.from || [0, 0]);
      const c = item.c || [0, 0];
      const to = item.to || [0, 0];
      for (let i = 1; i <= segs; i++) {
        const t = i / segs;
        const mt = 1 - t;
        pushUnique2D(
          out,
          mt * mt * start[0] + 2 * mt * t * c[0] + t * t * to[0],
          mt * mt * start[1] + 2 * mt * t * c[1] + t * t * to[1]
        );
      }
    } else if (op === 'cubic' || op === 'bezier') {
      const start = out.length ? out[out.length - 1] : (item.from || [0, 0]);
      const c1 = item.c1 || start;
      const c2 = item.c2 || item.to || start;
      const to = item.to || start;
      for (let i = 1; i <= segs; i++) {
        const t = i / segs;
        const mt = 1 - t;
        pushUnique2D(
          out,
          mt ** 3 * start[0] + 3 * mt * mt * t * c1[0] + 3 * mt * t * t * c2[0] + t ** 3 * to[0],
          mt ** 3 * start[1] + 3 * mt * mt * t * c1[1] + 3 * mt * t * t * c2[1] + t ** 3 * to[1]
        );
      }
    } else if (op === 'circle') {
      const cx = Number(item.center?.[0] ?? item.cx ?? 0);
      const cy = Number(item.center?.[1] ?? item.cy ?? 0);
      const r = Math.max(1e-5, Number(item.radius ?? 1));
      const n = Math.max(6, segs);
      const pts = [];
      for (let i = 0; i < n; i++) {
        const ang = (2 * Math.PI * i) / n;
        pts.push([cx + Math.cos(ang) * r, cy + Math.sin(ang) * r]);
      }
      if (item.reverse) pts.reverse();
      for (const [px, py] of pts) pushUnique2D(out, px, py);
    } else if (op === 'regularpolygon' || op === 'ngon') {
      const cx = Number(item.center?.[0] ?? item.cx ?? 0);
      const cy = Number(item.center?.[1] ?? item.cy ?? 0);
      const r = Math.max(1e-5, Number(item.radius ?? 1));
      const sides = Math.max(3, Math.min(128, Math.round(Number(item.sides) || 6)));
      const rot = Number(item.rotation ?? 0);
      const pts = [];
      for (let i = 0; i < sides; i++) {
        const ang = rot + (2 * Math.PI * i) / sides;
        pts.push([cx + Math.cos(ang) * r, cy + Math.sin(ang) * r]);
      }
      if (item.reverse) pts.reverse();
      for (const [px, py] of pts) pushUnique2D(out, px, py);
    } else if (op === 'rosette' || op === 'cuspedring') {
      const cx = Number(item.center?.[0] ?? item.cx ?? 0);
      const cy = Number(item.center?.[1] ?? item.cy ?? 0);
      const rOuter = Math.max(1e-4, Number(item.outerRadius ?? 1));
      const rInner = Math.max(1e-4, Number(item.innerRadius ?? rOuter * 0.72));
      const lobes = Math.max(3, Math.min(64, Math.round(Number(item.lobes) || 4)));
      const rot = Number(item.rotation ?? 0);
      const perLobe = Math.max(4, Math.min(32, Math.round(Number(item.segmentsPerLobe) || 8)));
      const total = lobes * perLobe;
      const pts = [];
      for (let i = 0; i < total; i++) {
        const theta = (2 * Math.PI * i) / total;
        const lobeWave = Math.abs(Math.sin(0.5 * lobes * theta));
        const rad = rInner + (rOuter - rInner) * Math.pow(lobeWave, 0.75);
        const ang = rot + theta;
        pts.push([cx + Math.cos(ang) * rad, cy + Math.sin(ang) * rad]);
      }
      if (item.reverse) pts.reverse();
      for (const [px, py] of pts) pushUnique2D(out, px, py);
    }
  }

  if (out.length >= 2) {
    const first = out[0];
    const last = out[out.length - 1];
    if (Math.hypot(first[0] - last[0], first[1] - last[1]) <= 1e-6) {
      out.pop();
    }
  }
  return out;
}

/**
 * Projects uniform world/local-scale triplanar box UVs onto any BufferGeometry.
 */
export function applyTriplanarUV(geometry, options = {}, THREE = DEFAULT_THREE) {
  const T = resolveThree(THREE);
  if (!geometry?.attributes?.position) return geometry;
  const metersPerTile = Math.max(0.05, Number(options.metersPerTile ?? options.scale ?? 2.0));
  const inv = 1.0 / metersPerTile;
  const matrix = options.matrix || null;

  const pos = geometry.attributes.position;
  if (!geometry.attributes.normal) geometry.computeVertexNormals();
  const nrm = geometry.attributes.normal;
  const uvs = new Float32Array(pos.count * 2);
  const v = new T.Vector3();
  const n = new T.Vector3();
  const nMat = matrix ? new T.Matrix3().getNormalMatrix(matrix) : null;

  const index = geometry.index;
  if (!index) {
    const triCount = Math.floor(pos.count / 3);
    const a = new T.Vector3();
    const b = new T.Vector3();
    const c = new T.Vector3();
    const fn = new T.Vector3();
    for (let t = 0; t < triCount; t++) {
      const i0 = t * 3;
      a.fromBufferAttribute(pos, i0);
      b.fromBufferAttribute(pos, i0 + 1);
      c.fromBufferAttribute(pos, i0 + 2);
      if (matrix) {
        a.applyMatrix4(matrix);
        b.applyMatrix4(matrix);
        c.applyMatrix4(matrix);
      }
      fn.subVectors(b, a).cross(v.subVectors(c, a));
      const ax = Math.abs(fn.x), ay = Math.abs(fn.y), az = Math.abs(fn.z);
      const pts = [a, b, c];
      for (let k = 0; k < 3; k++) {
        const p = pts[k];
        let uCoord, vCoord;
        if (ay >= ax && ay >= az) {
          uCoord = p.x * inv;
          vCoord = p.z * inv;
        } else if (ax >= az) {
          uCoord = p.z * inv;
          vCoord = p.y * inv;
        } else {
          uCoord = p.x * inv;
          vCoord = p.y * inv;
        }
        uvs[(i0 + k) * 2] = uCoord;
        uvs[(i0 + k) * 2 + 1] = vCoord;
      }
    }
  } else {
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i);
      n.fromBufferAttribute(nrm, i);
      if (matrix) {
        v.applyMatrix4(matrix);
        n.applyMatrix3(nMat).normalize();
      }
      const ax = Math.abs(n.x), ay = Math.abs(n.y), az = Math.abs(n.z);
      if (ay >= ax && ay >= az) {
        uvs[i * 2] = v.x * inv;
        uvs[i * 2 + 1] = v.z * inv;
      } else if (ax >= az) {
        uvs[i * 2] = v.z * inv;
        uvs[i * 2 + 1] = v.y * inv;
      } else {
        uvs[i * 2] = v.x * inv;
        uvs[i * 2 + 1] = v.y * inv;
      }
    }
  }

  geometry.setAttribute('uv', new T.BufferAttribute(uvs, 2));
  return geometry;
}

/**
 * Computes Blender-style Auto-Smooth / Crease Angle split normals on any BufferGeometry.
 * Coplanar and gently curved faces (< creaseAngleDeg) interpolate smoothly while sharp
 * architectural edges (> creaseAngleDeg) stay razor-flat without shading gradients.
 */
export function applyCreaseNormals(geometry, creaseAngleDeg = 32, THREE = DEFAULT_THREE) {
  const T = resolveThree(THREE);
  if (!geometry?.attributes?.position) return geometry;
  const nonIndexed = geometry.index ? geometry.toNonIndexed() : geometry;
  const pos = nonIndexed.attributes.position;
  const triCount = Math.floor(pos.count / 3);
  if (triCount === 0) return nonIndexed;

  const cosThresh = Math.cos((Math.max(0.1, Math.min(179.9, Number(creaseAngleDeg) || 32)) * Math.PI) / 180);
  const faceNormals = new Float32Array(triCount * 3);
  const buckets = new Map();

  const a = new T.Vector3();
  const b = new T.Vector3();
  const c = new T.Vector3();
  const ab = new T.Vector3();
  const ac = new T.Vector3();
  const fn = new T.Vector3();

  const keyOf = (v) => `${Math.round(v.x * 1e4)},${Math.round(v.y * 1e4)},${Math.round(v.z * 1e4)}`;

  for (let t = 0; t < triCount; t++) {
    const base = t * 3;
    a.fromBufferAttribute(pos, base);
    b.fromBufferAttribute(pos, base + 1);
    c.fromBufferAttribute(pos, base + 2);
    ab.subVectors(b, a);
    ac.subVectors(c, a);
    // Area-weighted face normal (larger faces dominate just like WeightedNormal!)
    fn.crossVectors(ab, ac);
    faceNormals[base] = fn.x;
    faceNormals[base + 1] = fn.y;
    faceNormals[base + 2] = fn.z;

    const verts = [a, b, c];
    for (let k = 0; k < 3; k++) {
      const key = keyOf(verts[k]);
      let list = buckets.get(key);
      if (!list) {
        list = [];
        buckets.set(key, list);
      }
      list.push(t);
    }
  }

  const outNormals = new Float32Array(pos.count * 3);
  const unitNormals = new Float32Array(triCount * 3);
  for (let t = 0; t < triCount; t++) {
    const nx = faceNormals[t * 3];
    const ny = faceNormals[t * 3 + 1];
    const nz = faceNormals[t * 3 + 2];
    const len = Math.hypot(nx, ny, nz) || 1;
    unitNormals[t * 3] = nx / len;
    unitNormals[t * 3 + 1] = ny / len;
    unitNormals[t * 3 + 2] = nz / len;
  }

  for (let t = 0; t < triCount; t++) {
    const ux = unitNormals[t * 3];
    const uy = unitNormals[t * 3 + 1];
    const uz = unitNormals[t * 3 + 2];
    for (let k = 0; k < 3; k++) {
      const vi = t * 3 + k;
      a.fromBufferAttribute(pos, vi);
      const list = buckets.get(keyOf(a));
      let sx = 0, sy = 0, sz = 0;
      for (let i = 0; i < list.length; i++) {
        const ot = list[i];
        const dot = ux * unitNormals[ot * 3] + uy * unitNormals[ot * 3 + 1] + uz * unitNormals[ot * 3 + 2];
        if (dot >= cosThresh) {
          sx += faceNormals[ot * 3];
          sy += faceNormals[ot * 3 + 1];
          sz += faceNormals[ot * 3 + 2];
        }
      }
      const len = Math.hypot(sx, sy, sz);
      if (len > 1e-12) {
        outNormals[vi * 3] = sx / len;
        outNormals[vi * 3 + 1] = sy / len;
        outNormals[vi * 3 + 2] = sz / len;
      } else {
        outNormals[vi * 3] = ux;
        outNormals[vi * 3 + 1] = uy;
        outNormals[vi * 3 + 2] = uz;
      }
    }
  }

  nonIndexed.setAttribute('normal', new T.BufferAttribute(outNormals, 3));
  return nonIndexed;
}

/**
 * Computes fast, deterministic geometric Vertex Cavity & Ambient Occlusion into `color` attribute.
 * Darkens concave creases, deep molding grooves, downward soffits, and ground contact zones.
 */
export function computeVertexCavityAO(geometry, options = {}, THREE = DEFAULT_THREE) {
  const T = resolveThree(THREE);
  if (!geometry?.attributes?.position) return geometry;
  if (!geometry.attributes.normal) geometry.computeVertexNormals();

  const strength = Math.max(0, Math.min(0.95, Number(options.strength ?? 0.38)));
  const hemiStrength = Math.max(0, Math.min(0.5, Number(options.hemiStrength ?? 0.14)));
  const groundStrength = Math.max(0, Math.min(0.5, Number(options.groundStrength ?? 0.10)));
  const groundY = options.groundY !== undefined ? Number(options.groundY) : null;
  const groundFalloff = Math.max(0.1, Number(options.groundFalloff ?? 1.8));

  const pos = geometry.attributes.position;
  const nrm = geometry.attributes.normal;
  const existingColor = geometry.attributes.color;
  const index = geometry.index;
  const triCount = Math.floor((index ? index.count : pos.count) / 3);

  // Weld spatial vertices to build 1-ring topological neighborhood
  const weldMap = new Map();
  const weldedPos = [];
  const weldedNorm = [];
  const rawToWeld = new Uint32Array(pos.count);
  const neighbors = [];

  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const key = `${Math.round(x * 1e3)},${Math.round(y * 1e3)},${Math.round(z * 1e3)}`;
    let wid = weldMap.get(key);
    if (wid === undefined) {
      wid = weldedPos.length;
      weldMap.set(key, wid);
      weldedPos.push([x, y, z]);
      weldedNorm.push([0, 0, 0]);
      neighbors.push(new Set());
    }
    rawToWeld[i] = wid;
    weldedNorm[wid][0] += nrm.getX(i);
    weldedNorm[wid][1] += nrm.getY(i);
    weldedNorm[wid][2] += nrm.getZ(i);
  }

  for (let t = 0; t < triCount; t++) {
    const i0 = index ? index.getX(t * 3) : t * 3;
    const i1 = index ? index.getX(t * 3 + 1) : t * 3 + 1;
    const i2 = index ? index.getX(t * 3 + 2) : t * 3 + 2;
    const w0 = rawToWeld[i0], w1 = rawToWeld[i1], w2 = rawToWeld[i2];
    if (w0 !== w1) { neighbors[w0].add(w1); neighbors[w1].add(w0); }
    if (w1 !== w2) { neighbors[w1].add(w2); neighbors[w2].add(w1); }
    if (w2 !== w0) { neighbors[w2].add(w0); neighbors[w0].add(w2); }
  }

  const concavity = new Float32Array(weldedPos.length);
  for (let w = 0; w < weldedPos.length; w++) {
    const nbrs = neighbors[w];
    if (nbrs.size === 0) continue;
    const [px, py, pz] = weldedPos[w];
    let nx = weldedNorm[w][0], ny = weldedNorm[w][1], nz = weldedNorm[w][2];
    const nLen = Math.hypot(nx, ny, nz) || 1;
    nx /= nLen; ny /= nLen; nz /= nLen;

    let avgDx = 0, avgDy = 0, avgDz = 0, avgDist = 0;
    for (const nb of nbrs) {
      const dx = weldedPos[nb][0] - px;
      const dy = weldedPos[nb][1] - py;
      const dz = weldedPos[nb][2] - pz;
      const d = Math.hypot(dx, dy, dz) || 1;
      avgDx += dx / d;
      avgDy += dy / d;
      avgDz += dz / d;
      avgDist += d;
    }
    const invCount = 1 / nbrs.size;
    avgDx *= invCount; avgDy *= invCount; avgDz *= invCount;
    void avgDist;
    // Positive projection along outward normal => neighbors wrap in front of vertex => concave crease!
    const proj = avgDx * nx + avgDy * ny + avgDz * nz;
    concavity[w] = Math.max(0, Math.min(1, proj * 1.85));
  }

  const colors = new Uint8Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const wid = rawToWeld[i];
    const ny = nrm.getY(i);
    const cavOcc = concavity[wid] * strength;
    const hemiOcc = Math.max(0, -ny) * hemiStrength + (1 - (ny * 0.5 + 0.5)) * (hemiStrength * 0.35);
    let gOcc = 0;
    if (groundY !== null && Number.isFinite(groundY)) {
      const h = Math.max(0, pos.getY(i) - groundY);
      if (h < groundFalloff) {
        gOcc = (1 - h / groundFalloff) * groundStrength * Math.max(0.2, 1 - Math.max(0, ny));
      }
    }
    const ao = Math.max(0.22, Math.min(1.0, 1.0 - cavOcc - hemiOcc - gOcc));
    const baseR = existingColor ? existingColor.getX(i) : 1.0;
    const baseG = existingColor ? existingColor.getY(i) : 1.0;
    const baseB = existingColor ? existingColor.getZ(i) : 1.0;
    colors[i * 3] = Math.max(0, Math.min(255, Math.round(baseR * ao * 255)));
    colors[i * 3 + 1] = Math.max(0, Math.min(255, Math.round(baseG * ao * 255)));
    colors[i * 3 + 2] = Math.max(0, Math.min(255, Math.round(baseB * ao * 255)));
  }

  geometry.setAttribute('color', new T.BufferAttribute(colors, 3, true));
  return geometry;
}

/**
 * Welds identical vertices across ALL geometry attributes into a compact indexed BufferGeometry
 * while preserving 100% of multi-material `groups`, `drawRange`, sharp crease normals, UV seams,
 * `uv1`, `tangent`, `skinIndex`/`skinWeight`, and custom attributes.
 * Uses a fast numeric spatial-hash bucket map (no per-vertex string allocation) and supports
 * `InterleavedBufferAttribute` safely via getX/getY/getZ/getW.
 */
export const DEFAULT_CAD_BUDGET = Object.freeze({
  maxGridDim: 512,
  maxTotalVerts: 1_500_000,
  maxInstances: 200_000,
  maxContourSegments: 256,
});

function copyAttrToFloat32(attr, targetArr, targetOffset, itemSize) {
  const count = attr.count;
  if (!attr.isInterleavedBufferAttribute && attr.array instanceof Float32Array && attr.itemSize === itemSize) {
    targetArr.set(attr.array, targetOffset);
    return;
  }
  let o = targetOffset;
  for (let i = 0; i < count; i++) {
    if (itemSize >= 1) targetArr[o++] = attr.getX(i);
    if (itemSize >= 2) targetArr[o++] = attr.getY(i);
    if (itemSize >= 3) targetArr[o++] = attr.getZ(i);
    if (itemSize >= 4) targetArr[o++] = attr.getW(i);
  }
}

function readAttrTuple(attr, index, out, offset) {
  const sz = attr.itemSize;
  if (sz >= 1) out[offset] = attr.getX(index);
  if (sz >= 2) out[offset + 1] = attr.getY(index);
  if (sz >= 3) out[offset + 2] = attr.getZ(index);
  if (sz >= 4) out[offset + 3] = attr.getW(index);
}

export function indexGeometry(geometry, options = {}, THREE = DEFAULT_THREE) {
  const T = resolveThree(THREE);
  if (!geometry?.isBufferGeometry || !geometry.attributes?.position) return geometry;
  const pos = geometry.attributes.position;
  const srcIndex = geometry.index;
  const totalRefs = srcIndex ? srcIndex.count : pos.count;
  if (totalRefs < 3) return geometry;
  if (totalRefs > DEFAULT_CAD_BUDGET.maxTotalVerts) {
    throw new Error(`indexGeometry input (${totalRefs} refs) exceeds budget (${DEFAULT_CAD_BUDGET.maxTotalVerts}).`);
  }

  const attrNames = Object.keys(geometry.attributes);
  const attrs = attrNames.map((name) => {
    const a = geometry.attributes[name];
    const isColor = name === 'color' && a.itemSize === 3;
    return {
      name,
      attr: a,
      itemSize: a.itemSize,
      isColor,
      isUint8Norm: isColor || (a.normalized && a.array instanceof Uint8Array),
      ArrayCtor: isColor
        ? Uint8Array
        : (a.array?.constructor && a.array.constructor !== Array ? a.array.constructor : Float32Array),
      normalized: isColor ? true : Boolean(a.normalized),
      out: [],
    };
  });

  // Compute adaptive position quantization tolerance scaled by bounding diagonal if unspecified
  let posEps = Number(options.posTolerance ?? 0);
  if (!(posEps > 0)) {
    if (!geometry.boundingBox) geometry.computeBoundingBox();
    const bb = geometry.boundingBox;
    const diag = bb ? bb.min.distanceTo(bb.max) : 1.0;
    posEps = Math.max(1e-5, Math.min(1e-3, (Number.isFinite(diag) && diag > 0 ? diag : 1.0) * 1e-5));
  }
  const posInv = 1 / posEps;
  const nrmEps = Number(options.nrmTolerance ?? 1e-3);
  const uvEps = Number(options.uvTolerance ?? 1e-4);

  const buckets = new Map();
  const newIndices = new Uint32Array(totalRefs);
  let uniqueCount = 0;

  const nrmAttr = geometry.attributes.normal || null;
  const uvAttr = geometry.attributes.uv || null;

  for (let i = 0; i < totalRefs; i++) {
    const vi = srcIndex ? srcIndex.getX(i) : i;
    const px = pos.getX(vi), py = pos.getY(vi), pz = pos.getZ(vi);
    const qx = Math.round(px * posInv) | 0;
    const qy = Math.round(py * posInv) | 0;
    const qz = Math.round(pz * posInv) | 0;
    // Fast 32-bit integer spatial hash (zero string allocation)
    let h = (Math.imul(qx, 73856093) ^ Math.imul(qy, 19349663) ^ Math.imul(qz, 83492791)) | 0;
    if (nrmAttr) {
      const qnx = Math.round(nrmAttr.getX(vi) * 100) | 0;
      const qny = Math.round(nrmAttr.getY(vi) * 100) | 0;
      const qnz = Math.round(nrmAttr.getZ(vi) * 100) | 0;
      h = (h ^ Math.imul(qnx, 2654435761) ^ Math.imul(qny, 2246822519) ^ Math.imul(qnz, 3266489917)) | 0;
    }

    let bucket = buckets.get(h);
    let found = -1;
    if (bucket) {
      for (let b = 0; b < bucket.length; b++) {
        const cand = bucket[b];
        let match = true;
        for (let aIdx = 0; aIdx < attrs.length; aIdx++) {
          const info = attrs[aIdx];
          const sz = info.itemSize;
          const base = cand * sz;
          const tol = info.name === 'position'
            ? posEps
            : info.name === 'normal' || info.name === 'tangent'
              ? nrmEps
              : info.name === 'uv' || info.name === 'uv1'
                ? uvEps
                : info.isColor
                  ? 1.5
                  : 1e-4;
          for (let c = 0; c < sz; c++) {
            let val = c === 0 ? info.attr.getX(vi) : c === 1 ? info.attr.getY(vi) : c === 2 ? info.attr.getZ(vi) : info.attr.getW(vi);
            if (info.isColor) val = Math.max(0, Math.min(255, Math.round(val * 255)));
            if (Math.abs(info.out[base + c] - val) > tol) {
              match = false;
              break;
            }
          }
          if (!match) break;
        }
        if (match) {
          found = cand;
          break;
        }
      }
    }

    if (found < 0) {
      found = uniqueCount++;
      for (let aIdx = 0; aIdx < attrs.length; aIdx++) {
        const info = attrs[aIdx];
        const sz = info.itemSize;
        for (let c = 0; c < sz; c++) {
          let val = c === 0 ? info.attr.getX(vi) : c === 1 ? info.attr.getY(vi) : c === 2 ? info.attr.getZ(vi) : info.attr.getW(vi);
          if (info.isColor) val = Math.max(0, Math.min(255, Math.round(val * 255)));
          info.out.push(val);
        }
      }
      if (bucket) bucket.push(found);
      else buckets.set(h, [found]);
    }
    newIndices[i] = found;
  }

  // Skip replacing if already indexed and no vertices were welded
  if (srcIndex && uniqueCount >= pos.count) return geometry;

  const out = new T.BufferGeometry();
  out.name = geometry.name || '';
  if (geometry.userData) out.userData = { ...geometry.userData };
  for (const info of attrs) {
    out.setAttribute(info.name, new T.BufferAttribute(new info.ArrayCtor(info.out), info.itemSize, info.normalized));
  }
  const idxArray = uniqueCount <= 65535 ? new Uint16Array(newIndices) : newIndices;
  out.setIndex(new T.BufferAttribute(idxArray, 1));
  // Preserve multi-material groups & drawRange (100% 1:1 index alignment with totalRefs!)
  if (Array.isArray(geometry.groups) && geometry.groups.length > 0) {
    for (const grp of geometry.groups) {
      out.addGroup(grp.start, grp.count, grp.materialIndex);
    }
  }
  if (geometry.drawRange && (geometry.drawRange.start !== 0 || geometry.drawRange.count !== Infinity)) {
    out.setDrawRange(geometry.drawRange.start, geometry.drawRange.count);
  }
  out.computeBoundingBox();
  out.computeBoundingSphere();
  return out;
}

/**
 * 1. Extrudes any 2D outer contour + arbitrary cutout `holes` along Z into a solid 3D mesh geometry.
 */
export function buildExtrudeGeometry(options = {}, THREE = DEFAULT_THREE) {
  const T = resolveThree(THREE);
  const segs = Math.max(4, Math.min(128, Math.round(Number(options.curveSegments) || 20)));
  const outerPts = sample2DContour(options.contour || options.points || [], segs);
  if (outerPts.length < 3) {
    throw new Error('buildExtrudeGeometry requires an outer contour with at least 3 distinct points.');
  }
  // Ensure CCW outer winding for consistent outward normals
  if (signedArea2D(outerPts) < 0) outerPts.reverse();

  const shape = new T.Shape();
  shape.moveTo(outerPts[0][0], outerPts[0][1]);
  for (let i = 1; i < outerPts.length; i++) shape.lineTo(outerPts[i][0], outerPts[i][1]);
  shape.closePath();

  for (const rawHole of options.holes || []) {
    const holePts = sample2DContour(rawHole, segs);
    if (holePts.length < 3) continue;
    // Holes use CW winding relative to CCW outer contour
    if (signedArea2D(holePts) > 0) holePts.reverse();
    const path = new T.Path();
    path.moveTo(holePts[0][0], holePts[0][1]);
    for (let i = 1; i < holePts.length; i++) path.lineTo(holePts[i][0], holePts[i][1]);
    path.closePath();
    shape.holes.push(path);
  }

  const depth = Math.max(1e-4, Number(options.depth ?? 0.5));
  const bevelSize = Math.max(0, Number(options.bevelSize ?? 0.012));
  const bevelThickness = Math.max(0, Number(options.bevelThickness ?? bevelSize));
  const bevelEnabled = options.bevelEnabled !== undefined
    ? Boolean(options.bevelEnabled)
    : (bevelSize > 1e-5 && bevelThickness > 1e-5);

  let geom = new T.ExtrudeGeometry(shape, {
    depth,
    steps: Math.max(1, Math.min(32, Math.round(Number(options.steps) || 1))),
    curveSegments: segs,
    bevelEnabled,
    bevelSize,
    bevelThickness,
    bevelSegments: Math.max(1, Math.min(8, Math.round(Number(options.bevelSegments) || 2))),
  });

  if (options.centered !== false) {
    geom.translate(0, 0, -0.5 * depth);
  }

  geom = applyCreaseNormals(geom, options.creaseAngleDeg ?? 32, T);
  applyTriplanarUV(geom, { metersPerTile: options.uvScale ?? 2.0 }, T);
  if (options.vertexAO !== false) {
    computeVertexCavityAO(geom, typeof options.vertexAO === 'object' ? options.vertexAO : {}, T);
  }
  if (options.indexed !== false) {
    const indexed = indexGeometry(geom, {}, T);
    if (indexed !== geom) geom.dispose();
    geom = indexed;
  } else {
    geom.computeBoundingBox();
    geom.computeBoundingSphere();
  }
  return geom;
}

/**
 * 2. Sweeps any closed 2D cross-section `profile` along a 3D `path` with exact corner miter scaling.
 */
export function buildSweepGeometry(options = {}, THREE = DEFAULT_THREE) {
  const T = resolveThree(THREE);
  const rawProfile = sample2DContour(options.profile || [], options.profileSegments || 12);
  if (rawProfile.length < 3) {
    throw new Error('buildSweepGeometry requires a 2D profile with at least 3 points.');
  }
  // Consistent CCW 2D profile winding so swept quads face outward
  if (signedArea2D(rawProfile) < 0) rawProfile.reverse();

  const rawPath = (options.path || []).map((p) => {
    if (p?.isVector3) return p.clone();
    if (Array.isArray(p)) return new T.Vector3(Number(p[0]) || 0, Number(p[1]) || 0, Number(p[2]) || 0);
    if (p && typeof p === 'object') return new T.Vector3(Number(p.x) || 0, Number(p.y) || 0, Number(p.z) || 0);
    return new T.Vector3();
  });
  const closedPath = Boolean(options.closedPath);
  const pts = [];
  for (const p of rawPath) {
    if (!pts.length || p.distanceTo(pts[pts.length - 1]) > 1e-6) pts.push(p);
  }
  if (closedPath && pts.length >= 3 && pts[0].distanceTo(pts[pts.length - 1]) <= 1e-6) {
    pts.pop();
  }
  if (pts.length < 2) {
    throw new Error('buildSweepGeometry requires at least 2 distinct 3D path points.');
  }

  const nPts = pts.length;
  const nProf = rawProfile.length;
  const miterLimit = Math.max(1.0, Math.min(4.0, Number(options.miterLimit ?? 2.6)));
  const scaleStart = Number(options.scaleStart ?? 1.0);
  const scaleEnd = Number(options.scaleEnd ?? 1.0);
  const explicitPlaneNormal = Array.isArray(options.planeNormal)
    ? new T.Vector3(...options.planeNormal).normalize()
    : null;

  // Arc lengths for continuous UV parameterization
  const arcLen = [0];
  for (let i = 1; i < nPts; i++) {
    arcLen.push(arcLen[i - 1] + pts[i].distanceTo(pts[i - 1]));
  }
  const totalLen = closedPath
    ? arcLen[nPts - 1] + pts[nPts - 1].distanceTo(pts[0])
    : Math.max(1e-6, arcLen[nPts - 1]);

  // Segment unit directions
  const segDirs = [];
  const segCount = closedPath ? nPts : nPts - 1;
  for (let i = 0; i < segCount; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % nPts];
    segDirs.push(b.clone().sub(a).normalize());
  }

  // Build Parallel-Transport or Plane-Constrained frames per segment
  const segU = [];
  const segV = [];
  if (explicitPlaneNormal && explicitPlaneNormal.lengthSq() > 0.5) {
    for (let i = 0; i < segCount; i++) {
      const vAxis = explicitPlaneNormal.clone();
      let uAxis = new T.Vector3().crossVectors(vAxis, segDirs[i]);
      if (uAxis.lengthSq() < 1e-8) {
        uAxis = Math.abs(segDirs[i].x) < 0.9 ? new T.Vector3(1, 0, 0) : new T.Vector3(0, 1, 0);
        uAxis.addScaledVector(segDirs[i], -uAxis.dot(segDirs[i])).normalize();
      } else {
        uAxis.normalize();
      }
      const orthoV = new T.Vector3().crossVectors(segDirs[i], uAxis).normalize();
      segU.push(uAxis);
      segV.push(orthoV);
    }
  } else {
    const refUp = Array.isArray(options.up)
      ? new T.Vector3(...options.up).normalize()
      : (Math.abs(segDirs[0].y) < 0.92 ? new T.Vector3(0, 1, 0) : new T.Vector3(0, 0, 1));
    let u0 = new T.Vector3().crossVectors(refUp, segDirs[0]).normalize();
    if (u0.lengthSq() < 1e-8) u0 = new T.Vector3(1, 0, 0);
    let v0 = new T.Vector3().crossVectors(segDirs[0], u0).normalize();
    segU.push(u0);
    segV.push(v0);
    const q = new T.Quaternion();
    for (let i = 1; i < segCount; i++) {
      q.setFromUnitVectors(segDirs[i - 1], segDirs[i]);
      const ui = segU[i - 1].clone().applyQuaternion(q);
      ui.addScaledVector(segDirs[i], -ui.dot(segDirs[i])).normalize();
      const vi = new T.Vector3().crossVectors(segDirs[i], ui).normalize();
      segU.push(ui);
      segV.push(vi);
    }
  }

  // Compute mitered rings at each path vertex
  const rings = [];
  for (let i = 0; i < nPts; i++) {
    const tFrac = nPts > 1 ? i / (closedPath ? nPts : nPts - 1) : 0;
    const taper = Array.isArray(options.scales) && options.scales[i] !== undefined
      ? Number(options.scales[i])
      : scaleStart + (scaleEnd - scaleStart) * tFrac;

    let uDir, vDir, mScaleU = 1.0, mScaleV = 1.0;
    if (!closedPath && i === 0) {
      uDir = segU[0];
      vDir = segV[0];
    } else if (!closedPath && i === nPts - 1) {
      uDir = segU[segCount - 1];
      vDir = segV[segCount - 1];
    } else {
      const prevIdx = (i - 1 + segCount) % segCount;
      const nextIdx = i % segCount;
      const uA = segU[prevIdx], uB = segU[nextIdx];
      const vA = segV[prevIdx], vB = segV[nextIdx];

      const uSum = uA.clone().add(uB);
      if (uSum.lengthSq() > 1e-8) {
        uDir = uSum.normalize();
        mScaleU = Math.min(miterLimit, 1.0 / Math.max(0.25, uDir.dot(uA)));
      } else {
        uDir = uA.clone();
      }

      const vSum = vA.clone().add(vB);
      if (vSum.lengthSq() > 1e-8) {
        vDir = vSum.normalize();
        mScaleV = Math.min(miterLimit, 1.0 / Math.max(0.25, vDir.dot(vA)));
      } else {
        vDir = vA.clone();
      }
    }

    const ring = [];
    for (let j = 0; j < nProf; j++) {
      const [pu, pv] = rawProfile[j];
      ring.push(
        pts[i].clone()
          .addScaledVector(uDir, pu * taper * mScaleU)
          .addScaledVector(vDir, pv * taper * mScaleV)
      );
    }
    rings.push(ring);
  }

  // Profile perimeter distances for UV
  const profLen = [0];
  for (let j = 1; j <= nProf; j++) {
    const a = rawProfile[j - 1];
    const b = rawProfile[j % nProf];
    profLen.push(profLen[j - 1] + Math.hypot(b[0] - a[0], b[1] - a[1]));
  }
  const uvScale = Math.max(0.05, Number(options.uvScale ?? 2.0));

  const positions = [];
  const uvs = [];
  const pushTri = (p0, p1, p2, uv0, uv1, uv2) => {
    positions.push(p0.x, p0.y, p0.z, p1.x, p1.y, p1.z, p2.x, p2.y, p2.z);
    uvs.push(uv0[0], uv0[1], uv1[0], uv1[1], uv2[0], uv2[1]);
  };

  for (let i = 0; i < segCount; i++) {
    const r0 = rings[i];
    const r1 = rings[(i + 1) % nPts];
    const v0 = arcLen[i] / uvScale;
    const v1 = (i + 1 < nPts ? arcLen[i + 1] : totalLen) / uvScale;
    for (let j = 0; j < nProf; j++) {
      const jn = (j + 1) % nProf;
      const u0 = profLen[j] / uvScale;
      const u1 = profLen[j + 1] / uvScale;
      pushTri(r0[j], r1[j], r1[jn], [u0, v0], [u0, v1], [u1, v1]);
      pushTri(r0[j], r1[jn], r0[jn], [u0, v0], [u1, v1], [u1, v0]);
    }
  }

  // Cap open ends using ear-clipping via THREE.ShapeUtils
  if (!closedPath && options.capEnds !== false && nProf >= 3) {
    const vec2Profile = rawProfile.map(([u, v]) => new T.Vector2(u, v));
    const capTris = T.ShapeUtils.triangulateShape(vec2Profile, []);
    const startRing = rings[0];
    const endRing = rings[nPts - 1];
    for (const [i0, i1, i2] of capTris) {
      // Start cap faces -tangent
      pushTri(
        startRing[i0], startRing[i2], startRing[i1],
        [rawProfile[i0][0] / uvScale, rawProfile[i0][1] / uvScale],
        [rawProfile[i2][0] / uvScale, rawProfile[i2][1] / uvScale],
        [rawProfile[i1][0] / uvScale, rawProfile[i1][1] / uvScale]
      );
      // End cap faces +tangent
      pushTri(
        endRing[i0], endRing[i1], endRing[i2],
        [rawProfile[i0][0] / uvScale, rawProfile[i0][1] / uvScale],
        [rawProfile[i1][0] / uvScale, rawProfile[i1][1] / uvScale],
        [rawProfile[i2][0] / uvScale, rawProfile[i2][1] / uvScale]
      );
    }
  }

  let geom = new T.BufferGeometry();
  geom.setAttribute('position', new T.Float32BufferAttribute(positions, 3));
  geom.setAttribute('uv', new T.Float32BufferAttribute(uvs, 2));
  geom = applyCreaseNormals(geom, options.creaseAngleDeg ?? 34, T);
  if (options.vertexAO !== false) {
    computeVertexCavityAO(geom, typeof options.vertexAO === 'object' ? options.vertexAO : {}, T);
  }
  if (options.indexed !== false) {
    const indexed = indexGeometry(geom, {}, T);
    if (indexed !== geom) geom.dispose();
    geom = indexed;
  } else {
    geom.computeBoundingBox();
    geom.computeBoundingSphere();
  }
  return geom;
}

/**
 * 3. Revolves a 2D `[radius, y]` profile around Y (supports polygonal 4/6/8-sided or smooth turned solids).
 */
export function buildLatheGeometry(options = {}, THREE = DEFAULT_THREE) {
  const T = resolveThree(THREE);
  const rawPts = sample2DContour(options.profile || options.points || [], options.profileSegments || 16);
  if (rawPts.length < 2) {
    throw new Error('buildLatheGeometry requires at least 2 [radius, y] profile points.');
  }
  const pts2 = rawPts.map(([r, y]) => new T.Vector2(Math.max(0, r), y));
  // Auto-close axis caps if requested and not already touching r=0
  if (options.capEnds !== false) {
    if (pts2[0].x > 1e-5) pts2.unshift(new T.Vector2(0, pts2[0].y));
    if (pts2[pts2.length - 1].x > 1e-5) pts2.push(new T.Vector2(0, pts2[pts2.length - 1].y));
  }
  const segments = Math.max(3, Math.min(128, Math.round(Number(options.segments) || 24)));
  const phiStart = Number(options.phiStart ?? 0);
  const phiLength = Number(options.phiLength ?? Math.PI * 2);

  let geom = new T.LatheGeometry(pts2, segments, phiStart, phiLength);
  // Default crease: polygonal lathes (<= 12 sides, e.g. octagonal plinths/spires) stay crisp-faceted!
  const defaultCrease = segments <= 12 ? 20 : 38;
  geom = applyCreaseNormals(geom, options.creaseAngleDeg ?? defaultCrease, T);
  applyTriplanarUV(geom, { metersPerTile: options.uvScale ?? 2.0 }, T);
  if (options.vertexAO !== false) {
    computeVertexCavityAO(geom, typeof options.vertexAO === 'object' ? options.vertexAO : {}, T);
  }
  if (options.indexed !== false) {
    const indexed = indexGeometry(geom, {}, T);
    if (indexed !== geom) geom.dispose();
    geom = indexed;
  } else {
    geom.computeBoundingBox();
    geom.computeBoundingSphere();
  }
  return geom;
}

/**
 * 4. Builds a curved surface or watertight thickened 3D shell from a `rows x cols` 3D point grid.
 */
export function buildSurfaceShellGeometry(options = {}, THREE = DEFAULT_THREE) {
  const T = resolveThree(THREE);
  const grid = options.grid;
  if (!Array.isArray(grid) || grid.length < 2 || !Array.isArray(grid[0]) || grid[0].length < 2) {
    throw new Error('buildSurfaceShellGeometry requires a 2D `grid` of [x, y, z] points (at least 2x2).');
  }
  const rows = grid.length;
  const cols = grid[0].length;
  if (rows > DEFAULT_CAD_BUDGET.maxGridDim || cols > DEFAULT_CAD_BUDGET.maxGridDim || rows * cols > DEFAULT_CAD_BUDGET.maxGridDim * DEFAULT_CAD_BUDGET.maxGridDim) {
    throw new Error(`buildSurfaceShellGeometry grid ${rows}x${cols} exceeds budget (${DEFAULT_CAD_BUDGET.maxGridDim}x${DEFAULT_CAD_BUDGET.maxGridDim}).`);
  }
  const thickness = Number(options.thickness ?? 0);
  if (!Number.isFinite(thickness)) throw new Error('buildSurfaceShellGeometry thickness must be finite.');
  const flipWinding = Boolean(options.flipWinding);

  const basePts = grid.map((row) =>
    row.map((p) => (p?.isVector3 ? p.clone() : new T.Vector3(Number(p[0]) || 0, Number(p[1]) || 0, Number(p[2]) || 0)))
  );

  // Smooth vertex normals on base grid for uniform shell thickness offset
  const vNorms = Array.from({ length: rows }, () => Array.from({ length: cols }, () => new T.Vector3()));
  const e1 = new T.Vector3();
  const e2 = new T.Vector3();
  const fn = new T.Vector3();
  for (let r = 0; r < rows - 1; r++) {
    for (let c = 0; c < cols - 1; c++) {
      const p00 = basePts[r][c];
      const p10 = basePts[r + 1][c];
      const p11 = basePts[r + 1][c + 1];
      const p01 = basePts[r][c + 1];
      e1.subVectors(p10, p00);
      e2.subVectors(p01, p00);
      fn.crossVectors(e1, e2);
      if (flipWinding) fn.negate();
      vNorms[r][c].add(fn);
      vNorms[r + 1][c].add(fn);
      vNorms[r + 1][c + 1].add(fn);
      vNorms[r][c + 1].add(fn);
    }
  }
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (vNorms[r][c].lengthSq() < 1e-10) vNorms[r][c].set(0, 1, 0);
      else vNorms[r][c].normalize();
    }
  }

  const positions = [];
  const pushQuad = (a, b, c, d, invert = false) => {
    if (invert) {
      positions.push(a.x, a.y, a.z, d.x, d.y, d.z, c.x, c.y, c.z);
      positions.push(a.x, a.y, a.z, c.x, c.y, c.z, b.x, b.y, b.z);
    } else {
      positions.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
      positions.push(a.x, a.y, a.z, c.x, c.y, c.z, d.x, d.y, d.z);
    }
  };

  if (Math.abs(thickness) <= 1e-5) {
    for (let r = 0; r < rows - 1; r++) {
      for (let c = 0; c < cols - 1; c++) {
        pushQuad(basePts[r][c], basePts[r + 1][c], basePts[r + 1][c + 1], basePts[r][c + 1], flipWinding);
      }
    }
  } else {
    const topPts = basePts.map((row, r) =>
      row.map((p, c) => p.clone().addScaledVector(vNorms[r][c], thickness))
    );
    const posThick = thickness > 0;
    for (let r = 0; r < rows - 1; r++) {
      for (let c = 0; c < cols - 1; c++) {
        // Top / extrados surface
        pushQuad(topPts[r][c], topPts[r + 1][c], topPts[r + 1][c + 1], topPts[r][c + 1], !posThick);
        // Bottom / intrados ceiling surface (opposite normal!)
        pushQuad(basePts[r][c], basePts[r + 1][c], basePts[r + 1][c + 1], basePts[r][c + 1], posThick);
      }
    }
    // Stitch 4 boundary rims for 100% watertight solid shell
    for (let c = 0; c < cols - 1; c++) {
      pushQuad(basePts[0][c], topPts[0][c], topPts[0][c + 1], basePts[0][c + 1], !posThick);
      pushQuad(basePts[rows - 1][c + 1], topPts[rows - 1][c + 1], topPts[rows - 1][c], basePts[rows - 1][c], !posThick);
    }
    for (let r = 0; r < rows - 1; r++) {
      pushQuad(basePts[r + 1][0], topPts[r + 1][0], topPts[r][0], basePts[r][0], !posThick);
      pushQuad(basePts[r][cols - 1], topPts[r][cols - 1], topPts[r + 1][cols - 1], basePts[r + 1][cols - 1], !posThick);
    }
  }

  let geom = new T.BufferGeometry();
  geom.setAttribute('position', new T.Float32BufferAttribute(positions, 3));
  geom = applyCreaseNormals(geom, options.creaseAngleDeg ?? 36, T);
  applyTriplanarUV(geom, { metersPerTile: options.uvScale ?? 2.0 }, T);
  if (options.vertexAO !== false) {
    computeVertexCavityAO(geom, typeof options.vertexAO === 'object' ? options.vertexAO : {}, T);
  }
  if (options.indexed !== false) {
    const indexed = indexGeometry(geom, {}, T);
    if (indexed !== geom) geom.dispose();
    geom = indexed;
  } else {
    geom.computeBoundingBox();
    geom.computeBoundingSphere();
  }
  return geom;
}

/**
 * 5. Merges multiple Meshes, Groups, or `{ geometry, x, y, z, rotationX, rotationY, rotationZ, scale, tint }`
 * descriptors into a single clean, single-draw-call BufferGeometry.
 */
export function mergePartGeometries(parts = [], options = {}, THREE = DEFAULT_THREE) {
  const T = resolveThree(THREE);
  const prepared = [];
  const tmpPos = new T.Vector3();
  const tmpQuat = new T.Quaternion();
  const tmpScale = new T.Vector3(1, 1, 1);
  const tmpEuler = new T.Euler();
  const tmpMat = new T.Matrix4();

  const collectItem = (item, parentMatrix = null) => {
    if (!item) return;
    if (item.isMesh && item.geometry && typeof item.updateMatrix === 'function') {
      item.updateMatrix();
      const worldMat = parentMatrix ? parentMatrix.clone().multiply(item.matrix) : item.matrix.clone();
      prepared.push({ geometry: item.geometry, matrix: worldMat, tint: item.userData?.vertexTint || null });
      for (const child of item.children || []) collectItem(child, worldMat);
      return;
    }
    if (item.isObject3D && typeof item.updateMatrix === 'function') {
      item.updateMatrix();
      const worldMat = parentMatrix ? parentMatrix.clone().multiply(item.matrix) : item.matrix.clone();
      for (const child of item.children || []) collectItem(child, worldMat);
      return;
    }
    if (item.geometry?.isBufferGeometry) {
      let mat;
      if (item.matrix?.isMatrix4) {
        mat = item.matrix.clone();
      } else {
        tmpPos.set(Number(item.x) || 0, Number(item.y) || 0, Number(item.z) || 0);
        tmpEuler.set(Number(item.rotationX) || 0, Number(item.rotationY) || 0, Number(item.rotationZ) || 0, 'XYZ');
        tmpQuat.setFromEuler(tmpEuler);
        if (typeof item.scale === 'number') tmpScale.setScalar(item.scale);
        else if (Array.isArray(item.scale)) tmpScale.set(item.scale[0] ?? 1, item.scale[1] ?? 1, item.scale[2] ?? 1);
        else tmpScale.set(Number(item.scaleX ?? 1), Number(item.scaleY ?? 1), Number(item.scaleZ ?? 1));
        mat = tmpMat.clone().compose(tmpPos, tmpQuat, tmpScale);
      }
      if (parentMatrix) mat.premultiply(parentMatrix);
      prepared.push({ geometry: item.geometry, matrix: mat, tint: item.tint ?? item.color ?? null });
    }
  };

  for (const item of parts) collectItem(item, null);
  if (prepared.length === 0) return new T.BufferGeometry();

  let totalVerts = 0;
  const clones = [];
  for (const entry of prepared) {
    const src = entry.geometry;
    // Safely de-interleave or un-index so InterleavedBufferAttribute never reads out of bounds
    let g;
    if (src.index) {
      g = src.toNonIndexed();
    } else {
      g = new T.BufferGeometry();
      for (const attrName of Object.keys(src.attributes)) {
        const a = src.attributes[attrName];
        if (!a) continue;
        const flat = new Float32Array(a.count * a.itemSize);
        copyAttrToFloat32(a, flat, 0, a.itemSize);
        g.setAttribute(attrName, new T.BufferAttribute(flat, a.itemSize));
      }
    }
    g.applyMatrix4(entry.matrix);
    if (!g.attributes.normal) g.computeVertexNormals();
    if (!g.attributes.uv) applyTriplanarUV(g, { metersPerTile: options.uvScale ?? 2.0 }, T);
    totalVerts += g.attributes.position.count;
    if (totalVerts > DEFAULT_CAD_BUDGET.maxTotalVerts) {
      g.dispose();
      clones.forEach((c) => c.geom.dispose());
      throw new Error(`mergePartGeometries vertex count (${totalVerts}) exceeds budget (${DEFAULT_CAD_BUDGET.maxTotalVerts}).`);
    }
    clones.push({ geom: g, tint: entry.tint });
  }

  const posArr = new Float32Array(totalVerts * 3);
  const nrmArr = new Float32Array(totalVerts * 3);
  const uvArr = new Float32Array(totalVerts * 2);
  const colArr = new Float32Array(totalVerts * 3);
  let hasAnyColor = false;
  let vCursor = 0;
  const parsedTint = new T.Color();

  for (const { geom, tint } of clones) {
    const count = geom.attributes.position.count;
    copyAttrToFloat32(geom.attributes.position, posArr, vCursor * 3, 3);
    copyAttrToFloat32(geom.attributes.normal, nrmArr, vCursor * 3, 3);
    copyAttrToFloat32(geom.attributes.uv, uvArr, vCursor * 2, 2);

    const srcCol = geom.attributes.color;
    let tr = 1, tg = 1, tb = 1;
    if (tint !== null && tint !== undefined) {
      parsedTint.set(tint);
      tr = parsedTint.r; tg = parsedTint.g; tb = parsedTint.b;
      hasAnyColor = true;
    }
    if (srcCol) {
      hasAnyColor = true;
      for (let i = 0; i < count; i++) {
        colArr[(vCursor + i) * 3] = srcCol.getX(i) * tr;
        colArr[(vCursor + i) * 3 + 1] = srcCol.getY(i) * tg;
        colArr[(vCursor + i) * 3 + 2] = srcCol.getZ(i) * tb;
      }
    } else {
      for (let i = 0; i < count; i++) {
        colArr[(vCursor + i) * 3] = tr;
        colArr[(vCursor + i) * 3 + 1] = tg;
        colArr[(vCursor + i) * 3 + 2] = tb;
      }
    }
    vCursor += count;
    geom.dispose();
  }

  const out = new T.BufferGeometry();
  out.setAttribute('position', new T.BufferAttribute(posArr, 3));
  out.setAttribute('normal', new T.BufferAttribute(nrmArr, 3));
  out.setAttribute('uv', new T.BufferAttribute(uvArr, 2));
  if (hasAnyColor) {
    out.setAttribute('color', new T.BufferAttribute(colArr, 3));
  }
  let result = out;
  if (options.recomputeCreaseNormals) {
    const smoothed = applyCreaseNormals(out, options.creaseAngleDeg ?? 32, T);
    if (smoothed !== out) out.dispose();
    result = smoothed;
  }
  if (options.vertexAO) {
    computeVertexCavityAO(result, typeof options.vertexAO === 'object' ? options.vertexAO : {}, T);
  }
  if (options.indexed !== false) {
    const indexed = indexGeometry(result, {}, T);
    if (indexed !== result) result.dispose();
    result = indexed;
  } else {
    result.computeBoundingBox();
    result.computeBoundingSphere();
  }
  return result;
}

/**
 * 6. Builds a GPU-instanced `THREE.InstancedMesh` from a prototype geometry/mesh and transform list.
 */
export function buildInstancedMesh(source, material, instances = [], options = {}, THREE = DEFAULT_THREE) {
  const T = resolveThree(THREE);
  const geom = source?.isBufferGeometry ? source : source?.geometry;
  if (!geom?.isBufferGeometry) {
    throw new Error('buildInstancedMesh requires a Mesh or BufferGeometry source.');
  }
  const mat = material || source?.material || new T.MeshStandardMaterial({ color: 0xd2d5da, roughness: 0.65 });
  const list = Array.isArray(instances) ? instances : [];
  if (list.length > DEFAULT_CAD_BUDGET.maxInstances) {
    throw new Error(`buildInstancedMesh instance count (${list.length}) exceeds budget (${DEFAULT_CAD_BUDGET.maxInstances}).`);
  }
  const count = list.length;
  const inst = new T.InstancedMesh(geom, mat, count);
  inst.name = options.name || 'InstancedMesh';
  inst.castShadow = options.castShadow !== false;
  inst.receiveShadow = options.receiveShadow !== false;

  const pos = new T.Vector3();
  const euler = new T.Euler();
  const quat = new T.Quaternion();
  const scl = new T.Vector3(1, 1, 1);
  const mtx = new T.Matrix4();
  const col = new T.Color();
  let hasInstanceColor = false;

  for (let i = 0; i < count; i++) {
    const item = list[i] || {};
    if (Array.isArray(item) && item.length === 16) {
      mtx.fromArray(item);
    } else if (item.matrix?.isMatrix4) {
      mtx.copy(item.matrix);
    } else {
      if (Array.isArray(item.position)) {
        pos.set(Number(item.position[0]) || 0, Number(item.position[1]) || 0, Number(item.position[2]) || 0);
      } else if (item.position && typeof item.position === 'object') {
        pos.set(Number(item.position.x) || 0, Number(item.position.y) || 0, Number(item.position.z) || 0);
      } else {
        pos.set(Number(item.x) || 0, Number(item.y) || 0, Number(item.z) || 0);
      }
      if (Array.isArray(item.rotation)) {
        euler.set(Number(item.rotation[0]) || 0, Number(item.rotation[1]) || 0, Number(item.rotation[2]) || 0, 'XYZ');
      } else if (item.rotation && typeof item.rotation === 'object') {
        euler.set(Number(item.rotation.x) || 0, Number(item.rotation.y) || 0, Number(item.rotation.z) || 0, 'XYZ');
      } else {
        euler.set(
          Number(item.rotationX ?? item.rx) || 0,
          Number(item.rotationY ?? item.ry) || 0,
          Number(item.rotationZ ?? item.rz) || 0,
          'XYZ'
        );
      }
      quat.setFromEuler(euler);
      if (typeof item.scale === 'number') scl.setScalar(item.scale);
      else if (Array.isArray(item.scale)) scl.set(Number(item.scale[0] ?? 1), Number(item.scale[1] ?? 1), Number(item.scale[2] ?? 1));
      else if (item.scale && typeof item.scale === 'object') scl.set(Number(item.scale.x ?? 1), Number(item.scale.y ?? 1), Number(item.scale.z ?? 1));
      else scl.set(Number(item.scaleX ?? item.sx ?? 1), Number(item.scaleY ?? item.sy ?? 1), Number(item.scaleZ ?? item.sz ?? 1));
      mtx.compose(pos, quat, scl);
    }
    inst.setMatrixAt(i, mtx);
    if (item.color !== undefined && item.color !== null) {
      col.set(item.color);
      inst.setColorAt(i, col);
      hasInstanceColor = true;
    }
  }
  inst.instanceMatrix.needsUpdate = true;
  if (hasInstanceColor && inst.instanceColor) inst.instanceColor.needsUpdate = true;
  inst.computeBoundingBox?.();
  inst.computeBoundingSphere?.();
  return inst;
}

/**
 * 7. Worker-safe synchronous geometry modifiers ('mirror', 'array', 'solidify',
 * 'taper', 'twist', 'crease_normals', 'box_uv', 'vertex_ao').
 */
export function modifyGeometrySync(geometry, type, params = {}, THREE = DEFAULT_THREE) {
  const T = resolveThree(THREE);
  if (!geometry?.isBufferGeometry) return geometry;
  const kind = String(type || '').toLowerCase().replace(/[-_\s]/g, '');

  const toFlatClone = (src) => {
    if (src.index) return src.toNonIndexed();
    const out = new T.BufferGeometry();
    for (const k of Object.keys(src.attributes)) {
      const a = src.attributes[k];
      if (!a) continue;
      const flat = new Float32Array(a.count * a.itemSize);
      copyAttrToFloat32(a, flat, 0, a.itemSize);
      out.setAttribute(k, new T.BufferAttribute(flat, a.itemSize));
    }
    return out;
  };

  if (kind === 'mirror') {
    const axes = [];
    if (params.mirrorX ?? (params.axis === 'x' || params.axis === undefined)) axes.push(0);
    if (params.mirrorY || params.axis === 'y') axes.push(1);
    if (params.mirrorZ || params.axis === 'z') axes.push(2);
    let list = [toFlatClone(geometry)];
    const thresh = Number(params.mergeThreshold ?? 0.002);
    for (const ax of axes) {
      const next = [];
      for (const g of list) {
        next.push(g);
        const m = g.clone();
        const pos = m.attributes.position;
        const nrm = m.attributes.normal;
        const uv = m.attributes.uv;
        const col = m.attributes.color;
        for (let i = 0; i < pos.count; i++) {
          pos.array[i * 3 + ax] = -pos.array[i * 3 + ax];
          if (nrm) nrm.array[i * 3 + ax] = -nrm.array[i * 3 + ax];
        }
        for (let t = 0; t < pos.count; t += 3) {
          const i1 = t + 1, i2 = t + 2;
          for (const attr of [pos, nrm, uv, col]) {
            if (!attr) continue;
            const sz = attr.itemSize;
            for (let c = 0; c < sz; c++) {
              const tmp = attr.array[i1 * sz + c];
              attr.array[i1 * sz + c] = attr.array[i2 * sz + c];
              attr.array[i2 * sz + c] = tmp;
            }
          }
        }
        next.push(m);
      }
      list = next;
    }
    const merged = mergePartGeometries(list.map((g) => ({ geometry: g })), {}, T);
    list.forEach((g) => g.dispose());
    if (params.merge !== false && thresh > 0) {
      const pos = merged.attributes.position;
      for (const ax of axes) {
        for (let i = 0; i < pos.count; i++) {
          if (Math.abs(pos.array[i * 3 + ax]) <= thresh) pos.array[i * 3 + ax] = 0;
        }
      }
      pos.needsUpdate = true;
    }
    return applyCreaseNormals(merged, params.creaseAngleDeg ?? 32, T);
  }

  if (kind === 'array') {
    const count = Math.max(1, Math.min(200, Math.round(Number(params.count) || 2)));
    const sx = Number(params.stepX ?? params.offset?.x ?? 0);
    const sy = Number(params.stepY ?? params.offset?.y ?? 0);
    const sz = Number(params.stepZ ?? params.offset?.z ?? 0);
    const parts = [];
    for (let i = 0; i < count; i++) {
      parts.push({ geometry, x: sx * i, y: sy * i, z: sz * i });
    }
    return mergePartGeometries(parts, {}, T);
  }

  if (kind === 'solidify') {
    const thickness = Number(params.thickness ?? 0.15);
    const base = geometry.index ? geometry.toNonIndexed() : geometry.clone();
    if (!base.attributes.normal) base.computeVertexNormals();
    const inner = base.clone();
    const p = inner.attributes.position;
    const n = inner.attributes.normal;
    for (let i = 0; i < p.count; i++) {
      p.setXYZ(
        i,
        p.getX(i) - n.getX(i) * thickness,
        p.getY(i) - n.getY(i) * thickness,
        p.getZ(i) - n.getZ(i) * thickness
      );
      n.setXYZ(i, -n.getX(i), -n.getY(i), -n.getZ(i));
    }
    for (let t = 0; t < p.count; t += 3) {
      for (const attr of [p, n, inner.attributes.uv, inner.attributes.color]) {
        if (!attr) continue;
        const sz = attr.itemSize;
        for (let c = 0; c < sz; c++) {
          const tmp = attr.array[(t + 1) * sz + c];
          attr.array[(t + 1) * sz + c] = attr.array[(t + 2) * sz + c];
          attr.array[(t + 2) * sz + c] = tmp;
        }
      }
    }
    const out = mergePartGeometries([{ geometry: base }, { geometry: inner }], {}, T);
    base.dispose();
    inner.dispose();
    return out;
  }

  if (kind === 'taper') {
    const out = geometry.clone();
    out.computeBoundingBox();
    const bb = out.boundingBox;
    const spanY = Math.max(1e-5, bb.max.y - bb.min.y);
    const factor = Number(params.factor ?? 0.5);
    const pos = out.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const t = (pos.getY(i) - bb.min.y) / spanY;
      const s = 1 + (factor - 1) * t;
      pos.setX(i, pos.getX(i) * s);
      pos.setZ(i, pos.getZ(i) * s);
    }
    return applyCreaseNormals(out, params.creaseAngleDeg ?? 32, T);
  }

  if (kind === 'twist') {
    const out = geometry.clone();
    out.computeBoundingBox();
    const bb = out.boundingBox;
    const spanY = Math.max(1e-5, bb.max.y - bb.min.y);
    const angle = Number(params.angle ?? Math.PI * 0.5);
    const pos = out.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const y = pos.getY(i);
      const a = angle * ((y - bb.min.y) / spanY);
      const ca = Math.cos(a), sa = Math.sin(a);
      const x = pos.getX(i), z = pos.getZ(i);
      pos.setX(i, x * ca - z * sa);
      pos.setZ(i, x * sa + z * ca);
    }
    return applyCreaseNormals(out, params.creaseAngleDeg ?? 32, T);
  }

  if (kind === 'creasenormals' || kind === 'autosmooth') {
    return applyCreaseNormals(geometry.clone(), params.angle ?? params.creaseAngleDeg ?? 32, T);
  }

  if (kind === 'boxuv' || kind === 'triplanaruv') {
    return applyTriplanarUV(geometry.clone(), params, T);
  }

  if (kind === 'vertexao' || kind === 'cavityao') {
    return computeVertexCavityAO(geometry.clone(), params, T);
  }

  return geometry.clone();
}

/**
 * 8. Multi-Profile Parametric Loft (`buildLoftGeometry`):
 * Connects 2+ arbitrary 2D cross-section profiles positioned/rotated/scaled in 3D space
 * with uniform arc-length resampling, minimum-twist seam alignment, optional watertight end caps,
 * crease normals, continuous UVs, optional Vertex AO, and automatic vertex indexing.
 */
function resampleClosed2D(pts, count) {
  const n = pts.length;
  if (n < 3) return pts;
  const cum = [0];
  for (let i = 0; i < n; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % n];
    cum.push(cum[i] + Math.hypot(b[0] - a[0], b[1] - a[1]));
  }
  const total = cum[n] || 1;
  const out = [];
  let seg = 0;
  for (let k = 0; k < count; k++) {
    const target = (k / count) * total;
    while (seg < n - 1 && cum[seg + 1] < target) seg++;
    const segLen = Math.max(1e-8, cum[seg + 1] - cum[seg]);
    const t = Math.max(0, Math.min(1, (target - cum[seg]) / segLen));
    const a = pts[seg];
    const b = pts[(seg + 1) % n];
    out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
  }
  return out;
}

export function buildLoftGeometry(options = {}, THREE = DEFAULT_THREE) {
  const T = resolveThree(THREE);
  if (Array.isArray(options.grid) && !Array.isArray(options.sections)) {
    return buildSurfaceShellGeometry(options, T);
  }
  const sections = options.sections;
  if (!Array.isArray(sections) || sections.length < 2) {
    throw new Error('buildLoftGeometry requires `sections` with at least 2 cross-section profiles.');
  }
  if (sections.length > DEFAULT_CAD_BUDGET.maxGridDim) {
    throw new Error(`buildLoftGeometry section count (${sections.length}) exceeds budget (${DEFAULT_CAD_BUDGET.maxGridDim}).`);
  }

  const samples = Math.max(4, Math.min(128, Math.round(Number(options.samples ?? options.segments) || 24)));
  const rings = [];
  const tmpPos = new T.Vector3();
  const tmpEuler = new T.Euler();
  const tmpQuat = new T.Quaternion();
  const tmpScale = new T.Vector3(1, 1, 1);
  const tmpMat = new T.Matrix4();

  for (let sIdx = 0; sIdx < sections.length; sIdx++) {
    const sec = sections[sIdx];
    const raw = sample2DContour(sec.contour || sec.profile || sec.points || [], samples);
    if (raw.length < 3) throw new Error(`Loft section ${sIdx} must have at least 3 contour points.`);
    if (signedArea2D(raw) < 0) raw.reverse();
    const resampled = resampleClosed2D(raw, samples);

    if (sec.matrix?.isMatrix4) {
      tmpMat.copy(sec.matrix);
    } else {
      tmpPos.set(Number(sec.x) || 0, Number(sec.y) || 0, Number(sec.z) || 0);
      tmpEuler.set(Number(sec.rotationX) || 0, Number(sec.rotationY) || 0, Number(sec.rotationZ ?? sec.twist) || 0, 'XYZ');
      tmpQuat.setFromEuler(tmpEuler);
      if (typeof sec.scale === 'number') tmpScale.setScalar(sec.scale);
      else if (Array.isArray(sec.scale)) tmpScale.set(sec.scale[0] ?? 1, sec.scale[1] ?? 1, sec.scale[2] ?? 1);
      else tmpScale.set(Number(sec.scaleX ?? 1), Number(sec.scaleY ?? 1), Number(sec.scaleZ ?? 1));
      tmpMat.compose(tmpPos, tmpQuat, tmpScale);
    }

    // Default loft plane: 2D contour lies in XZ (horizontal cross-section stacked along Y) unless plane === 'xy'
    const inXY = sec.plane === 'xy' || options.plane === 'xy';
    const ring3D = resampled.map(([u, v]) => {
      const p = inXY ? new T.Vector3(u, v, 0) : new T.Vector3(u, 0, v);
      return p.applyMatrix4(tmpMat);
    });

    // Align seam index to minimize twist relative to previous ring
    if (rings.length > 0 && options.alignSeams !== false) {
      const prev = rings[rings.length - 1];
      let bestShift = 0;
      let bestDist = Infinity;
      for (let shift = 0; shift < samples; shift++) {
        let d = 0;
        for (let k = 0; k < samples; k += Math.max(1, Math.floor(samples / 8))) {
          d += prev[k].distanceToSquared(ring3D[(k + shift) % samples]);
        }
        if (d < bestDist) {
          bestDist = d;
          bestShift = shift;
        }
      }
      if (bestShift > 0) {
        rings.push([...ring3D.slice(bestShift), ...ring3D.slice(0, bestShift)]);
      } else {
        rings.push(ring3D);
      }
    } else {
      rings.push(ring3D);
    }
  }

  const positions = [];
  const uvs = [];
  const closedLoft = Boolean(options.closed);
  const ringSpans = closedLoft ? rings.length : rings.length - 1;
  const pushTri = (a, b, c, ua, va, ub, vb, uc, vc) => {
    positions.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
    uvs.push(ua, va, ub, vb, uc, vc);
  };

  for (let r = 0; r < ringSpans; r++) {
    const r0 = rings[r];
    const r1 = rings[(r + 1) % rings.length];
    const v0 = r / Math.max(1, ringSpans);
    const v1 = (r + 1) / Math.max(1, ringSpans);
    for (let k = 0; k < samples; k++) {
      const kn = (k + 1) % samples;
      const u0 = k / samples;
      const u1 = (k + 1) / samples;
      pushTri(r0[k], r1[k], r1[kn], u0, v0, u0, v1, u1, v1);
      pushTri(r0[k], r1[kn], r0[kn], u0, v0, u1, v1, u1, v0);
    }
  }

  if (!closedLoft) {
    const addCap = (ring, reverse) => {
      const center = new T.Vector3();
      for (const p of ring) center.add(p);
      center.divideScalar(ring.length);
      for (let k = 0; k < samples; k++) {
        const kn = (k + 1) % samples;
        if (reverse) pushTri(center, ring[kn], ring[k], 0.5, 0.5, 1, 0, 0, 0);
        else pushTri(center, ring[k], ring[kn], 0.5, 0.5, 0, 0, 1, 0);
      }
    };
    if (options.capStart !== false && options.caps !== false) addCap(rings[0], false);
    if (options.capEnd !== false && options.caps !== false) addCap(rings[rings.length - 1], true);
  }

  let geom = new T.BufferGeometry();
  geom.setAttribute('position', new T.Float32BufferAttribute(positions, 3));
  geom.setAttribute('uv', new T.Float32BufferAttribute(uvs, 2));
  geom = applyCreaseNormals(geom, options.creaseAngleDeg ?? 36, T);
  if (options.uvScale) applyTriplanarUV(geom, { metersPerTile: options.uvScale }, T);
  if (options.vertexAO !== false) {
    computeVertexCavityAO(geom, typeof options.vertexAO === 'object' ? options.vertexAO : {}, T);
  }
  if (options.indexed !== false) {
    const indexed = indexGeometry(geom, {}, T);
    if (indexed !== geom) geom.dispose();
    geom = indexed;
  } else {
    geom.computeBoundingBox();
    geom.computeBoundingSphere();
  }
  return geom;
}

/**
 * 9. Parametric 3D Curve Sampler (`sampleCurve3D`):
 * Generates smooth 3D point/tangent frames for catenary cables, arches, helices, baroque scrolls,
 * Catmull-Rom splines, and cubic Bezier curves.
 */
export function sampleCurve3D(options = {}, THREE = DEFAULT_THREE) {
  const T = resolveThree(THREE);
  const type = String(options.type || 'catmullrom').toLowerCase();
  const segments = Math.max(2, Math.min(256, Math.round(Number(options.segments) || 24)));
  const rawPts = [];

  if (type === 'catenary') {
    const p0 = options.start || [0, 0, 0];
    const p1 = options.end || [10, 0, 0];
    const sag = Number(options.sag ?? 1.5);
    // True hyperbolic cosine catenary: y_sag(t) = -sag * (cosh(a) - cosh(a*(2t-1))) / (cosh(a) - 1)
    // Equals 0 at t=0,1 and -sag at t=0.5 with physically accurate catenary slope.
    const a = Math.max(0.25, Math.min(4.0, Number(options.catenaryShape ?? 1.6)));
    const coshA = Math.cosh(a);
    const denom = Math.max(1e-6, coshA - 1);
    for (let i = 0; i <= segments; i++) {
      const t = i / segments;
      const x = p0[0] + (p1[0] - p0[0]) * t;
      const z = p0[2] + (p1[2] - p0[2]) * t;
      const sagFactor = (coshA - Math.cosh(a * (2 * t - 1))) / denom;
      const y = p0[1] + (p1[1] - p0[1]) * t - sagFactor * sag;
      rawPts.push(new T.Vector3(x, y, z));
    }
  } else if (type === 'helix' || type === 'spiral') {
    const rStart = Number(options.radiusStart ?? options.radius ?? 1.0);
    const rEnd = Number(options.radiusEnd ?? rStart);
    const height = Number(options.height ?? 4.0);
    const turns = Number(options.turns ?? 2.0);
    for (let i = 0; i <= segments; i++) {
      const t = i / segments;
      const a = t * turns * Math.PI * 2;
      const r = rStart + (rEnd - rStart) * t;
      rawPts.push(new T.Vector3(Math.cos(a) * r, t * height, Math.sin(a) * r));
    }
  } else if (type === 'scroll' || type === 'volute') {
    const rStart = Number(options.startRadius ?? 0.6);
    const rEnd = Number(options.endRadius ?? 0.08);
    const turns = Number(options.turns ?? 1.5);
    for (let i = 0; i <= segments; i++) {
      const t = i / segments;
      const a = t * turns * Math.PI * 2;
      const r = rStart + (rEnd - rStart) * t;
      rawPts.push(new T.Vector3(Math.cos(a) * r, Math.sin(a) * r, 0));
    }
  } else if (type === 'arch') {
    const w = Number(options.width ?? 3.0);
    const springY = Number(options.springY ?? 0);
    const excess = Number(options.excess ?? 0.65);
    const pts2d = sample2DContour([{ op: 'twoCenterArc', centerX: 0, springY, width: w, excess, segments }], segments);
    for (const [x, y] of pts2d) rawPts.push(new T.Vector3(x, y, 0));
  } else if (type === 'bezier' && Array.isArray(options.points) && options.points.length >= 4) {
    const cp = options.points.map((p) => new T.Vector3(p[0] || 0, p[1] || 0, p[2] || 0));
    const curve = new T.CubicBezierCurve3(cp[0], cp[1], cp[2], cp[3]);
    rawPts.push(...curve.getPoints(segments));
  } else {
    const cp = (options.points || [[0, 0, 0], [2, 1, 0], [4, 0, 0]]).map((p) =>
      p?.isVector3 ? p.clone() : new T.Vector3(p[0] || 0, p[1] || 0, p[2] || 0)
    );
    if (cp.length < 2) throw new Error('sampleCurve3D requires at least 2 control points.');
    const curve = new T.CatmullRomCurve3(cp, Boolean(options.closed));
    rawPts.push(...curve.getPoints(segments));
  }

  if (options.pointsOnly) {
    return rawPts.map((p) => [p.x, p.y, p.z]);
  }

  const samples = [];
  const n = rawPts.length;
  for (let i = 0; i < n; i++) {
    const p = rawPts[i];
    const prev = rawPts[Math.max(0, i - 1)];
    const next = rawPts[Math.min(n - 1, i + 1)];
    const tan = next.clone().sub(prev);
    if (tan.lengthSq() < 1e-10) tan.set(1, 0, 0);
    else tan.normalize();
    samples.push({
      point: [p.x, p.y, p.z],
      tangent: [tan.x, tan.y, tan.z],
      t: i / Math.max(1, n - 1),
    });
  }
  return samples;
}

/**
 * 10. Deterministic Curve Instance Transform Generator (`buildCurveScatterInstances`):
 * Converts sampled 3D curve frames into GPU InstancedMesh transform descriptors.
 */
export function buildCurveScatterInstances(curveSamples = [], options = {}) {
  const alignTangent = options.alignTangent !== false;
  const skipEnds = Boolean(options.skipEnds);
  const scaleMin = Number(options.scaleMin ?? options.scale ?? 1);
  const scaleMax = Number(options.scaleMax ?? scaleMin);
  let seed = (Math.floor(Number(options.seed ?? 42)) >>> 0) || 1;
  const rand = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };

  const out = [];
  for (let i = 0; i < curveSamples.length; i++) {
    if (skipEnds && (i === 0 || i === curveSamples.length - 1)) continue;
    const s = curveSamples[i];
    const pt = Array.isArray(s) ? s : s.point;
    const tan = Array.isArray(s) ? [1, 0, 0] : (s.tangent || [1, 0, 0]);
    const yaw = alignTangent ? Math.atan2(tan[0], tan[2]) : 0;
    const scl = scaleMin + (scaleMax - scaleMin) * rand();
    out.push({
      x: pt[0],
      y: pt[1] + (Number(options.yOffset) || 0),
      z: pt[2],
      rotationX: Number(options.rotationX) || 0,
      rotationY: yaw + (Number(options.rotationY) || 0),
      rotationZ: Number(options.rotationZ) || 0,
      scale: scl,
    });
  }
  return out;
}

