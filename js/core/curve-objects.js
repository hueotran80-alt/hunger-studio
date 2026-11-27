/**
 * Parametric Curve, Bezier, Path, and Vector Text3D Objects
 * Evaluates cubic Bezier & B-Spline curves with Parallel-Transport (Bishop) frames,
 * sweeps bevel tube / ribbon profiles, extrudes built-in offline vector glyphs for Text3D,
 * and supports non-destructive param edits + Convert-to-Mesh (`Alt+C`).
 * File: js/core/curve-objects.js
 */

import * as THREE from 'three';
import { dataBlockRegistry } from './data-blocks.js';

// Built-in clean geometric vector glyphs in [0..0.72] x [0..1.0] units (works 100% offline).
// Each glyph is either polygon contour loops `[outerLoop, ...holeLoops]` OR stroke polylines thickened cleanly.
const STROKE_GLYPHS = {
  A: [[[0.05, 0], [0.32, 1], [0.40, 1], [0.67, 0]], [[0.18, 0.34], [0.54, 0.34]]],
  B: [[[0.10, 0], [0.10, 1], [0.48, 1], [0.60, 0.85], [0.60, 0.62], [0.48, 0.52], [0.10, 0.52]], [[0.48, 0.52], [0.62, 0.40], [0.62, 0.14], [0.48, 0], [0.10, 0]]],
  C: [[[0.62, 0.84], [0.48, 0.98], [0.22, 0.98], [0.08, 0.80], [0.08, 0.20], [0.22, 0.02], [0.48, 0.02], [0.62, 0.16]]],
  D: [[[0.10, 0], [0.10, 1], [0.42, 1], [0.62, 0.80], [0.62, 0.20], [0.42, 0], [0.10, 0]]],
  E: [[[0.58, 1], [0.10, 1], [0.10, 0], [0.60, 0]], [[0.10, 0.52], [0.48, 0.52]]],
  F: [[[0.58, 1], [0.10, 1], [0.10, 0]], [[0.10, 0.52], [0.48, 0.52]]],
  G: [[[0.62, 0.84], [0.48, 0.98], [0.22, 0.98], [0.08, 0.80], [0.08, 0.20], [0.22, 0.02], [0.48, 0.02], [0.62, 0.18], [0.62, 0.48], [0.38, 0.48]]],
  H: [[[0.10, 0], [0.10, 1]], [[0.60, 0], [0.60, 1]], [[0.10, 0.52], [0.60, 0.52]]],
  I: [[[0.18, 1], [0.52, 1]], [[0.35, 1], [0.35, 0]], [[0.18, 0], [0.52, 0]]],
  J: [[[0.55, 1], [0.55, 0.22], [0.40, 0.02], [0.20, 0.02], [0.08, 0.18]]],
  K: [[[0.10, 0], [0.10, 1]], [[0.60, 1], [0.10, 0.46], [0.62, 0]]],
  L: [[[0.10, 1], [0.10, 0], [0.60, 0]]],
  M: [[[0.06, 0], [0.06, 1], [0.35, 0.42], [0.64, 1], [0.64, 0]]],
  N: [[[0.10, 0], [0.10, 1], [0.60, 0], [0.60, 1]]],
  O: [[[0.35, 1], [0.14, 0.88], [0.08, 0.50], [0.14, 0.12], [0.35, 0], [0.56, 0.12], [0.62, 0.50], [0.56, 0.88], [0.35, 1]]],
  P: [[[0.10, 0], [0.10, 1], [0.48, 1], [0.62, 0.85], [0.62, 0.62], [0.48, 0.48], [0.10, 0.48]]],
  Q: [[[0.35, 1], [0.14, 0.88], [0.08, 0.50], [0.14, 0.12], [0.35, 0], [0.56, 0.12], [0.62, 0.50], [0.56, 0.88], [0.35, 1]], [[0.40, 0.28], [0.66, -0.04]]],
  R: [[[0.10, 0], [0.10, 1], [0.48, 1], [0.62, 0.85], [0.62, 0.62], [0.48, 0.48], [0.10, 0.48]], [[0.38, 0.48], [0.62, 0]]],
  S: [[[0.60, 0.86], [0.44, 0.98], [0.22, 0.98], [0.10, 0.84], [0.10, 0.64], [0.26, 0.54], [0.46, 0.46], [0.62, 0.34], [0.62, 0.14], [0.46, 0.02], [0.22, 0.02], [0.08, 0.16]]],
  T: [[[0.06, 1], [0.64, 1]], [[0.35, 1], [0.35, 0]]],
  U: [[[0.10, 1], [0.10, 0.20], [0.24, 0.02], [0.46, 0.02], [0.60, 0.20], [0.60, 1]]],
  V: [[[0.06, 1], [0.35, 0], [0.64, 1]]],
  W: [[[0.04, 1], [0.20, 0], [0.35, 0.56], [0.50, 0], [0.66, 1]]],
  X: [[[0.08, 1], [0.62, 0]], [[0.62, 1], [0.08, 0]]],
  Y: [[[0.08, 1], [0.35, 0.50], [0.62, 1]], [[0.35, 0.50], [0.35, 0]]],
  Z: [[[0.08, 1], [0.60, 1], [0.08, 0], [0.62, 0]]],
  '0': [[[0.35, 1], [0.14, 0.86], [0.09, 0.50], [0.14, 0.14], [0.35, 0], [0.56, 0.14], [0.61, 0.50], [0.56, 0.86], [0.35, 1]], [[0.18, 0.20], [0.52, 0.80]]],
  '1': [[[0.20, 0.84], [0.36, 1], [0.36, 0]], [[0.18, 0], [0.54, 0]]],
  '2': [[[0.10, 0.82], [0.24, 0.98], [0.48, 0.98], [0.60, 0.82], [0.60, 0.62], [0.10, 0], [0.62, 0]]],
  '3': [[[0.10, 0.86], [0.24, 0.98], [0.48, 0.98], [0.60, 0.84], [0.60, 0.62], [0.44, 0.52], [0.28, 0.52]], [[0.44, 0.52], [0.62, 0.38], [0.62, 0.14], [0.46, 0.02], [0.22, 0.02], [0.08, 0.16]]],
  '4': [[[0.48, 0], [0.48, 1], [0.08, 0.34], [0.62, 0.34]]],
  '5': [[[0.58, 1], [0.14, 1], [0.12, 0.58], [0.46, 0.58], [0.62, 0.42], [0.62, 0.16], [0.46, 0.02], [0.20, 0.02], [0.08, 0.14]]],
  '6': [[[0.54, 0.88], [0.38, 0.98], [0.18, 0.92], [0.10, 0.68], [0.10, 0.16], [0.24, 0.02], [0.48, 0.02], [0.60, 0.18], [0.60, 0.42], [0.46, 0.54], [0.10, 0.54]]],
  '7': [[[0.08, 1], [0.62, 1], [0.24, 0]]],
  '8': [[[0.35, 0.52], [0.14, 0.64], [0.12, 0.84], [0.24, 0.98], [0.46, 0.98], [0.58, 0.84], [0.56, 0.64], [0.35, 0.52], [0.12, 0.38], [0.10, 0.16], [0.24, 0.02], [0.46, 0.02], [0.60, 0.16], [0.58, 0.38], [0.35, 0.52]]],
  '9': [[[0.58, 0.48], [0.22, 0.48], [0.10, 0.62], [0.10, 0.84], [0.24, 0.98], [0.48, 0.98], [0.60, 0.82], [0.60, 0.30], [0.48, 0.06], [0.24, 0.02], [0.12, 0.12]]],
  '-': [[[0.15, 0.50], [0.55, 0.50]]],
  '+': [[[0.15, 0.50], [0.55, 0.50]], [[0.35, 0.30], [0.35, 0.70]]],
  '.': [[[0.30, 0.04], [0.40, 0.04], [0.40, 0.14], [0.30, 0.14], [0.30, 0.04]]],
  '!': [[[0.35, 1], [0.35, 0.28]], [[0.35, 0.12], [0.35, 0.02]]],
  '?': [[[0.12, 0.80], [0.24, 0.98], [0.48, 0.98], [0.60, 0.82], [0.56, 0.62], [0.35, 0.46], [0.35, 0.28]], [[0.35, 0.12], [0.35, 0.02]]],
  ':': [[[0.30, 0.65], [0.40, 0.65]], [[0.30, 0.12], [0.40, 0.12]]],
  '/': [[[0.12, 0], [0.58, 1]]],
  '_': [[[0.05, 0], [0.65, 0]]],
};

function expandPolylineRibbonShape(pts, halfW = 0.055) {
  if (!pts || pts.length < 2) return null;
  const left = [];
  const right = [];
  for (let i = 0; i < pts.length; i++) {
    const prev = pts[Math.max(0, i - 1)];
    const next = pts[Math.min(pts.length - 1, i + 1)];
    let dx = next[0] - prev[0];
    let dy = next[1] - prev[1];
    const len = Math.hypot(dx, dy) || 1;
    dx /= len;
    dy /= len;
    const nx = -dy * halfW;
    const ny = dx * halfW;
    left.push([pts[i][0] + nx, pts[i][1] + ny]);
    right.push([pts[i][0] - nx, pts[i][1] - ny]);
  }
  const shape = new THREE.Shape();
  shape.moveTo(left[0][0], left[0][1]);
  for (let i = 1; i < left.length; i++) shape.lineTo(left[i][0], left[i][1]);
  for (let i = right.length - 1; i >= 0; i--) shape.lineTo(right[i][0], right[i][1]);
  shape.closePath();
  return shape;
}

/**
 * Evaluates a cubic Bezier or B-Spline / Path descriptor into uniform spine samples
 * `{ points, tangents, normals, binormals, arcLengths, totalLength, closed }`.
 */
export function evaluateCurveSpine(curveData) {
  const kind = curveData?.kind || 'bezier';
  const resPerSeg = Math.max(2, Math.min(64, Number(curveData?.resolution || 16)));
  const closed = Boolean(curveData?.closed);
  const rawPts = Array.isArray(curveData?.points) ? curveData.points : [];

  const samples = [];
  if (kind === 'text') {
    return { points: [], tangents: [], normals: [], binormals: [], arcLengths: [0], totalLength: 0, closed: false };
  }

  if (rawPts.length >= 2) {
    if (kind === 'bezier') {
      const segCount = closed ? rawPts.length : rawPts.length - 1;
      for (let s = 0; s < segCount; s++) {
        const a = rawPts[s];
        const b = rawPts[(s + 1) % rawPts.length];
        const p0 = new THREE.Vector3(...(a.p || [0, 0, 0]));
        const p1 = new THREE.Vector3(...(a.hR || a.p || [0, 0, 0]));
        const p2 = new THREE.Vector3(...(b.hL || b.p || [0, 0, 0]));
        const p3 = new THREE.Vector3(...(b.p || [0, 0, 0]));
        const bez = new THREE.CubicBezierCurve3(p0, p1, p2, p3);
        const startStep = s === 0 ? 0 : 1;
        for (let k = startStep; k <= resPerSeg; k++) {
          samples.push(bez.getPoint(k / resPerSeg));
        }
      }
    } else {
      // Catmull-Rom / NURBS-like smooth path
      const vecs = rawPts.map((pt) => new THREE.Vector3(...(pt.p || pt)));
      const cat = new THREE.CatmullRomCurve3(vecs, closed, 'catmullrom', 0.5);
      const total = Math.max(4, rawPts.length * resPerSeg);
      for (let k = 0; k <= total; k++) {
        samples.push(cat.getPoint(k / total));
      }
    }
  }

  if (samples.length < 2) {
    return { points: samples, tangents: [], normals: [], binormals: [], arcLengths: [0], totalLength: 0, closed };
  }

  const n = samples.length;
  const tangents = [];
  const normals = [];
  const binormals = [];
  const arcLengths = [0];

  for (let i = 0; i < n; i++) {
    const prev = samples[i > 0 ? i - 1 : (closed ? n - 2 : 0)];
    const next = samples[i < n - 1 ? i + 1 : (closed ? 1 : n - 1)];
    const t = next.clone().sub(prev);
    if (t.lengthSq() < 1e-10) t.set(1, 0, 0);
    else t.normalize();
    tangents.push(t);
    if (i > 0) {
      arcLengths.push(arcLengths[i - 1] + samples[i].distanceTo(samples[i - 1]));
    }
  }

  // Parallel transport (Bishop) frame avoids twisting singularities of Frenet frames
  const up = Math.abs(tangents[0].y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
  let n0 = new THREE.Vector3().crossVectors(up, tangents[0]);
  if (n0.lengthSq() < 1e-10) n0.set(1, 0, 0);
  else n0.normalize();
  normals.push(n0);
  binormals.push(new THREE.Vector3().crossVectors(tangents[0], n0).normalize());

  const q = new THREE.Quaternion();
  for (let i = 1; i < n; i++) {
    q.setFromUnitVectors(tangents[i - 1], tangents[i]);
    const ni = normals[i - 1].clone().applyQuaternion(q).normalize();
    // Orthonormalize cleanly against tangent[i]
    ni.addScaledVector(tangents[i], -ni.dot(tangents[i])).normalize();
    normals.push(ni);
    binormals.push(new THREE.Vector3().crossVectors(tangents[i], ni).normalize());
  }

  return {
    points: samples,
    tangents,
    normals,
    binormals,
    arcLengths,
    totalLength: arcLengths[arcLengths.length - 1] || 0,
    closed,
  };
}

/**
 * Generates swept tube / ribbon BufferGeometry from curveData.
 */
export function buildCurveGeometry(curveData) {
  if (curveData?.kind === 'text') {
    return buildTextGeometry(curveData);
  }
  const spine = evaluateCurveSpine(curveData);
  const { points, normals, binormals, arcLengths, totalLength, closed } = spine;
  if (points.length < 2) return new THREE.BufferGeometry();

  const radius = Math.max(0.005, Number(curveData?.bevelDepth ?? 0.06));
  const radialSegs = Math.max(4, Math.min(32, Number(curveData?.bevelResolution ?? 10)));
  const capEnds = !closed && curveData?.fillCaps !== false;

  const positions = [];
  const norms = [];
  const uvs = [];
  const indices = [];

  const ringCount = points.length;
  for (let i = 0; i < ringCount; i++) {
    const p = points[i];
    const n = normals[i];
    const b = binormals[i];
    const vCoord = totalLength > 1e-6 ? arcLengths[i] / totalLength : i / Math.max(1, ringCount - 1);
    for (let j = 0; j <= radialSegs; j++) {
      const ang = (j / radialSegs) * Math.PI * 2;
      const ca = Math.cos(ang), sa = Math.sin(ang);
      const radialDir = new THREE.Vector3().addScaledVector(n, ca).addScaledVector(b, sa).normalize();
      positions.push(p.x + radialDir.x * radius, p.y + radialDir.y * radius, p.z + radialDir.z * radius);
      norms.push(radialDir.x, radialDir.y, radialDir.z);
      uvs.push(j / radialSegs, vCoord);
    }
  }

  const stride = radialSegs + 1;
  for (let i = 0; i < ringCount - 1; i++) {
    for (let j = 0; j < radialSegs; j++) {
      const a = i * stride + j;
      const b = (i + 1) * stride + j;
      const c = (i + 1) * stride + (j + 1);
      const d = i * stride + (j + 1);
      indices.push(a, b, d, b, c, d);
    }
  }

  // Optional end caps for open tubes
  if (capEnds && ringCount >= 2) {
    const addCap = (ringIdx, dirSign) => {
      const center = points[ringIdx];
      const tan = spine.tangents[ringIdx].clone().multiplyScalar(dirSign);
      const centerVert = positions.length / 3;
      positions.push(center.x, center.y, center.z);
      norms.push(tan.x, tan.y, tan.z);
      uvs.push(0.5, 0.5);
      const baseRing = ringIdx * stride;
      for (let j = 0; j < radialSegs; j++) {
        const v0 = baseRing + j;
        const v1 = baseRing + j + 1;
        if (dirSign < 0) indices.push(centerVert, v1, v0);
        else indices.push(centerVert, v0, v1);
      }
    };
    addCap(0, -1);
    addCap(ringCount - 1, 1);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(norms, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  return geo;
}

/**
 * Generates watertight extruded 3D Text geometry from offline vector glyph shapes.
 */
export function buildTextGeometry(textData) {
  const str = String(textData?.text ?? 'BLENDER').toUpperCase();
  const size = Math.max(0.05, Number(textData?.size ?? 0.8));
  const depth = Math.max(0.01, Number(textData?.depth ?? 0.16));
  const bevelSize = Math.max(0.0, Number(textData?.bevelSize ?? 0.02));
  const bevelThickness = Math.max(0.0, Number(textData?.bevelThickness ?? 0.02));
  const letterSpacing = Number(textData?.letterSpacing ?? 0.82);

  const shapes = [];
  let cursorX = 0;
  let cursorY = 0;
  const maxWidthEst = str.split('\n').reduce((m, line) => Math.max(m, line.length * letterSpacing), 1);
  const startX = -0.5 * maxWidthEst * size;

  const lines = str.split('\n');
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    cursorX = startX;
    cursorY = (lines.length - 1 - li * 1.35) * 0.5 * size;
    for (let ci = 0; ci < line.length; ci++) {
      const ch = line[ci];
      if (ch === ' ') {
        cursorX += letterSpacing * 0.65 * size;
        continue;
      }
      const strokes = STROKE_GLYPHS[ch] || STROKE_GLYPHS['-'];
      for (const poly of strokes) {
        const scaled = poly.map(([gx, gy]) => [cursorX + gx * size, cursorY + gy * size]);
        const sh = expandPolylineRibbonShape(scaled, 0.068 * size);
        if (sh) shapes.push(sh);
      }
      cursorX += letterSpacing * size;
    }
  }

  if (shapes.length === 0) return new THREE.BoxGeometry(0.2, 0.2, depth);
  const geo = new THREE.ExtrudeGeometry(shapes, {
    depth,
    bevelEnabled: bevelSize > 1e-4 && bevelThickness > 1e-4,
    bevelThickness,
    bevelSize,
    bevelSegments: Math.max(1, Number(textData?.bevelSegments ?? 2)),
    curveSegments: 4,
  });
  geo.center();
  geo.computeVertexNormals();
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  return geo;
}

export function createBezierCurveObject(preset = 'bezier', opts = {}) {
  let points;
  let closed = false;
  let kind = 'bezier';
  let name = opts.name || 'BezierCurve';

  if (preset === 'circle') {
    const k = 0.55228475;
    points = [
      { p: [1, 0, 0], hL: [1, 0, k], hR: [1, 0, -k] },
      { p: [0, 0, -1], hL: [k, 0, -1], hR: [-k, 0, -1] },
      { p: [-1, 0, 0], hL: [-1, 0, -k], hR: [-1, 0, k] },
      { p: [0, 0, 1], hL: [-k, 0, 1], hR: [k, 0, 1] },
    ];
    closed = true;
    name = opts.name || 'BezierCircle';
  } else if (preset === 'path') {
    kind = 'nurbs';
    points = [
      { p: [-1.5, 0, 0] },
      { p: [-0.5, 0.4, 0.6] },
      { p: [0.5, -0.2, -0.6] },
      { p: [1.5, 0.3, 0] },
    ];
    name = opts.name || 'NurbsPath';
  } else {
    points = [
      { p: [-1.2, 0, 0], hL: [-1.7, 0, -0.4], hR: [-0.5, 0, 0.8] },
      { p: [1.2, 0, 0], hL: [0.5, 0, -0.8], hR: [1.7, 0, 0.4] },
    ];
  }

  const curveData = {
    kind,
    closed,
    resolution: opts.resolution ?? 16,
    bevelDepth: opts.bevelDepth ?? 0.06,
    bevelResolution: opts.bevelResolution ?? 10,
    fillCaps: true,
    points,
  };

  const mesh = new THREE.Mesh(
    buildCurveGeometry(curveData),
    new THREE.MeshStandardMaterial({ color: 0xe2e8f0, roughness: 0.45, metalness: 0.1 })
  );
  mesh.name = name;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.userData.curveData = curveData;
  mesh.userData.isCurveObject = true;

  dataBlockRegistry.register('curves', `crv_${mesh.uuid.slice(0, 8)}`, {
    name,
    kind,
    users: new Set([mesh.uuid]),
  });
  return mesh;
}

export function createText3DObject(text = 'STUDIO', opts = {}) {
  const curveData = {
    kind: 'text',
    text,
    size: opts.size ?? 0.8,
    depth: opts.depth ?? 0.16,
    bevelSize: opts.bevelSize ?? 0.02,
    bevelThickness: opts.bevelThickness ?? 0.02,
    bevelSegments: opts.bevelSegments ?? 2,
    letterSpacing: opts.letterSpacing ?? 0.85,
  };
  const mesh = new THREE.Mesh(
    buildTextGeometry(curveData),
    new THREE.MeshStandardMaterial({ color: 0xf59e0b, roughness: 0.35, metalness: 0.15 })
  );
  mesh.name = opts.name || `Text_${text.slice(0, 12)}`;
  mesh.position.y = 0.5;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.userData.curveData = curveData;
  mesh.userData.isCurveObject = true;

  dataBlockRegistry.register('curves', `txt_${mesh.uuid.slice(0, 8)}`, {
    name: mesh.name,
    kind: 'text',
    users: new Set([mesh.uuid]),
  });
  return mesh;
}

export function rebuildCurveMesh(mesh, patch = null) {
  if (!mesh?.userData?.curveData) return false;
  if (patch && typeof patch === 'object') {
    Object.assign(mesh.userData.curveData, patch);
  }
  const nextGeo = buildCurveGeometry(mesh.userData.curveData);
  if (mesh.geometry && mesh.geometry !== mesh.userData.baseGeometry) {
    mesh.geometry.dispose();
  }
  mesh.geometry = nextGeo;
  if (mesh.userData.baseGeometry) {
    mesh.userData.baseGeometry.dispose();
    mesh.userData.baseGeometry = nextGeo.clone();
  }
  return true;
}

export function convertCurveToMesh(mesh, sceneManager = null) {
  if (!mesh?.userData?.curveData) return false;
  const oldCurve = structuredClone(mesh.userData.curveData);
  delete mesh.userData.curveData;
  delete mesh.userData.isCurveObject;
  if (sceneManager?.recordExecutedCommand) {
    sceneManager.recordExecutedCommand({
      name: 'Convert Curve to Mesh',
      execute() {
        delete mesh.userData.curveData;
        delete mesh.userData.isCurveObject;
      },
      undo() {
        mesh.userData.curveData = structuredClone(oldCurve);
        mesh.userData.isCurveObject = true;
      },
    });
  }
  return true;
}
