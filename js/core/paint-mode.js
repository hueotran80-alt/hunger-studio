/**
 * Vertex Paint & 3D/2D Texture Paint Modes
 * Includes BVH triangle-sphere 3D projection for cross-seam UV painting,
 * tile-based undo, weld-group vertex color symmetry, and curvature AO ("Dirty Vertex Colors").
 * File: js/core/paint-mode.js
 */

import * as THREE from 'three';
import { ensureBVH, raycastMeshAccelerated } from './bvh-accelerator.js';
import { smartUVProjectGeometry, applyUVGeometryUpdate, pointSpatialKey } from './geometry/uv-unwrap.js';
import { TILE_SIZE, PAINT_SLOTS, ensurePaintLayerStack } from './paint-layers.js';
import { VertexColorCommand, TexturePaintCommand } from './paint-commands.js';

function smoothFalloff(t, hardness = 0.5) {
  const x = Math.max(0, Math.min(1, t));
  const h = Math.max(0.0, Math.min(0.98, hardness));
  if (x <= h) return 1.0;
  const k = (x - h) / (1.0 - h);
  const s = 1.0 - k;
  return s * s * (3.0 - 2.0 * s);
}

function hexToRgba255(hex) {
  const c = new THREE.Color(hex || '#ffffff');
  const rgb = { r: 1, g: 1, b: 1 };
  c.getRGB(rgb, THREE.SRGBColorSpace);
  return [
    Math.max(0, Math.min(255, Math.round(rgb.r * 255))),
    Math.max(0, Math.min(255, Math.round(rgb.g * 255))),
    Math.max(0, Math.min(255, Math.round(rgb.b * 255))),
    255,
  ];
}

function clampU8(v) {
  return v < 0 ? 0 : (v > 255 ? 255 : (v + 0.5) | 0);
}

function distSqPointSegment2D(px, py, ax, ay, bx, by) {
  const vx = bx - ax, vy = by - ay;
  const lenSq = vx * vx + vy * vy;
  if (lenSq <= 1e-12) return (px - ax) * (px - ax) + (py - ay) * (py - ay);
  const t = Math.max(0, Math.min(1, ((px - ax) * vx + (py - ay) * vy) / lenSq));
  const cx = ax + vx * t, cy = ay + vy * t;
  return (px - cx) * (px - cx) + (py - cy) * (py - cy);
}

/**
 * Ensures mesh geometry has a `color` Float32 RGB attribute seeded to white (1,1,1)
 * and flips `material.vertexColors = true`. Returns { attr, prevFlags, nextFlags }.
 */
export function ensureVertexColorAttribute(mesh, enableVertexColors = true) {
  const geo = mesh?.geometry;
  if (!geo?.attributes?.position) return null;
  const count = geo.attributes.position.count;
  let attr = geo.attributes.color;
  if (!attr || attr.count !== count) {
    const arr = new Float32Array(count * 3);
    arr.fill(1.0);
    attr = new THREE.BufferAttribute(arr, 3);
    geo.setAttribute('color', attr);
  }
  const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  const prevFlags = mats.map((m) => Boolean(m?.vertexColors));
  const nextFlags = mats.map((m) => (enableVertexColors ? true : Boolean(m?.vertexColors)));
  if (enableVertexColors) {
    mats.forEach((m) => {
      if (m && !m.vertexColors) {
        m.vertexColors = true;
        m.needsUpdate = true;
      }
    });
  }
  return { attr, prevFlags, nextFlags };
}

/**
 * Computes welded topology + 1-ring neighbor lists for fast Vertex Paint strokes & Dirty Vertex Colors.
 */
export function buildVertexPaintTopology(geometry) {
  const pos = geometry?.attributes?.position;
  if (!pos) return null;
  const count = pos.count;
  const idx = geometry.index ? geometry.index.array : null;
  const triCount = idx ? Math.floor(idx.length / 3) : Math.floor(count / 3);

  const keyToGroup = new Map();
  const groupOf = new Int32Array(count);
  const groups = [];
  for (let i = 0; i < count; i++) {
    const k = pointSpatialKey(pos.getX(i), pos.getY(i), pos.getZ(i));
    let gid = keyToGroup.get(k);
    if (gid === undefined) {
      gid = groups.length;
      keyToGroup.set(k, gid);
      groups.push([]);
    }
    groupOf[i] = gid;
    groups[gid].push(i);
  }

  // Group-level adjacency & triangle connectivity
  const groupNeighbors = groups.map(() => new Set());
  for (let t = 0; t < triCount; t++) {
    const a = idx ? idx[t * 3] : t * 3;
    const b = idx ? idx[t * 3 + 1] : t * 3 + 1;
    const c = idx ? idx[t * 3 + 2] : t * 3 + 2;
    const ga = groupOf[a], gb = groupOf[b], gc = groupOf[c];
    if (ga !== gb) { groupNeighbors[ga].add(gb); groupNeighbors[gb].add(ga); }
    if (gb !== gc) { groupNeighbors[gb].add(gc); groupNeighbors[gc].add(gb); }
    if (gc !== ga) { groupNeighbors[gc].add(ga); groupNeighbors[ga].add(gc); }
  }

  const neighborGroups = groupNeighbors.map((s) => Array.from(s));
  return { count, groupOf, groups, neighborGroups };
}

/**
 * Computes local concavity / mean curvature vertex AO ("Dirty Vertex Colors" in Blender).
 */
export function computeDirtyVertexColors(mesh, { strength = 0.65, contrast = 1.0 } = {}) {
  const ensured = ensureVertexColorAttribute(mesh, true);
  if (!ensured) return null;
  const { attr, prevFlags, nextFlags } = ensured;
  const prevColors = new Float32Array(attr.array);
  const geo = mesh.geometry;
  if (!geo.attributes.normal) geo.computeVertexNormals();
  const pos = geo.attributes.position;
  const nrm = geo.attributes.normal;
  const topo = buildVertexPaintTopology(geo);
  if (!topo) return null;

  const itemSize = attr.itemSize || 3;
  const nextColors = new Float32Array(prevColors);
  const aVec = new THREE.Vector3();
  const nVec = new THREE.Vector3();
  const diff = new THREE.Vector3();

  // Compute group-averaged normals & concavity metric
  for (let gid = 0; gid < topo.groups.length; gid++) {
    const verts = topo.groups[gid];
    const v0 = verts[0];
    aVec.fromBufferAttribute(pos, v0);
    nVec.set(0, 0, 0);
    for (const vi of verts) {
      nVec.x += nrm.getX(vi);
      nVec.y += nrm.getY(vi);
      nVec.z += nrm.getZ(vi);
    }
    if (nVec.lengthSq() < 1e-10) nVec.set(0, 1, 0);
    else nVec.normalize();

    const nbrs = topo.neighborGroups[gid];
    let concav = 0;
    if (nbrs.length > 0) {
      let sumDot = 0;
      for (const ngid of nbrs) {
        const nv = topo.groups[ngid][0];
        diff.set(pos.getX(nv) - aVec.x, pos.getY(nv) - aVec.y, pos.getZ(nv) - aVec.z);
        const len = diff.length();
        if (len > 1e-6) {
          // Neighbors sitting in front of tangent plane -> concave crevice
          sumDot += diff.dot(nVec) / len;
        }
      }
      concav = sumDot / nbrs.length;
    }

    // Concave -> dark cavity; convex -> bright ridge
    const rawShade = 0.72 - concav * 1.45 * contrast;
    const shade = Math.max(0.08, Math.min(1.0, rawShade));
    const factor = 1.0 - strength + strength * shade;

    for (const vi of verts) {
      const off = vi * itemSize;
      nextColors[off] = Math.max(0, Math.min(1, prevColors[off] * factor));
      nextColors[off + 1] = Math.max(0, Math.min(1, prevColors[off + 1] * factor));
      nextColors[off + 2] = Math.max(0, Math.min(1, prevColors[off + 2] * factor));
    }
  }

  attr.array.set(nextColors);
  attr.needsUpdate = true;
  return { prevColors, nextColors, prevFlags, nextFlags };
}

/**
 * Pure 3D-space triangle projection for cross-seam Texture Paint strokes.
 * Finds triangles whose bounds overlap the local-space brush sphere and splats brush color/operation
 * onto touched UV pixels (with 1.5px seam bleed outside island edges), recording dirty 64x64 tiles.
 */
export function splatBrushTrianglesInLocalSphere({
  geometry,
  layer,
  localCenter,
  localRadius,
  brush = 'draw',
  colorRgba = [255, 110, 64, 255],
  strength = 0.75,
  hardness = 0.5,
  smearRgba = null,
  dirtyTiles = null,
  bleedPx = 1.5,
}) {
  const pos = geometry?.attributes?.position;
  const uv = geometry?.attributes?.uv;
  if (!pos || !uv || !layer) return 0;

  const W = layer.width;
  const H = layer.height;
  const data = layer.data;
  const idx = geometry.index ? geometry.index.array : null;
  const triCount = idx ? Math.floor(idx.length / 3) : Math.floor(pos.count / 3);
  const r2 = localRadius * localRadius;

  // Gather candidate triangle indices via BVH if present, else AABB sweep
  const candidates = [];
  if (geometry.boundsTree) {
    const sphere = new THREE.Sphere(localCenter, localRadius);
    geometry.boundsTree.shapecast({
      intersectsBounds: (box) => box.intersectsSphere(sphere),
      intersectsTriangle: (_tri, triIndex) => {
        candidates.push(triIndex);
        return false;
      },
    });
  } else {
    for (let t = 0; t < triCount; t++) {
      const a = idx ? idx[t * 3] : t * 3;
      const b = idx ? idx[t * 3 + 1] : t * 3 + 1;
      const c = idx ? idx[t * 3 + 2] : t * 3 + 2;
      const minX = Math.min(pos.getX(a), pos.getX(b), pos.getX(c));
      const maxX = Math.max(pos.getX(a), pos.getX(b), pos.getX(c));
      if (localCenter.x + localRadius < minX || localCenter.x - localRadius > maxX) continue;
      const minY = Math.min(pos.getY(a), pos.getY(b), pos.getY(c));
      const maxY = Math.max(pos.getY(a), pos.getY(b), pos.getY(c));
      if (localCenter.y + localRadius < minY || localCenter.y - localRadius > maxY) continue;
      const minZ = Math.min(pos.getZ(a), pos.getZ(b), pos.getZ(c));
      const maxZ = Math.max(pos.getZ(a), pos.getZ(b), pos.getZ(c));
      if (localCenter.z + localRadius < minZ || localCenter.z - localRadius > maxZ) continue;
      candidates.push(t);
    }
  }

  if (candidates.length === 0) return 0;

  const ensureTileSaved = (px, py) => {
    if (!dirtyTiles) return;
    const tx = Math.floor(px / TILE_SIZE);
    const ty = Math.floor(py / TILE_SIZE);
    const key = `${tx},${ty}`;
    if (dirtyTiles.has(key)) return;
    const x0 = tx * TILE_SIZE;
    const y0 = ty * TILE_SIZE;
    const w = Math.min(TILE_SIZE, W - x0);
    const h = Math.min(TILE_SIZE, H - y0);
    dirtyTiles.set(key, {
      tx, ty, x: x0, y: y0, w, h,
      before: layer.readRect(x0, y0, w, h),
      after: null,
    });
  };

  // Deduplicate pixel writes within a single dab by taking max weight per pixel
  const pixelWeights = new Map(); // linIdx -> weight
  const bleedSq = bleedPx * bleedPx;

  for (let ci = 0; ci < candidates.length; ci++) {
    const t = candidates[ci];
    const ia = idx ? idx[t * 3] : t * 3;
    const ib = idx ? idx[t * 3 + 1] : t * 3 + 1;
    const ic = idx ? idx[t * 3 + 2] : t * 3 + 2;

    const ax = pos.getX(ia), ay = pos.getY(ia), az = pos.getZ(ia);
    const bx = pos.getX(ib), by = pos.getY(ib), bz = pos.getZ(ib);
    const cx = pos.getX(ic), cy = pos.getY(ic), cz = pos.getZ(ic);

    const u0 = uv.getX(ia), v0 = uv.getY(ia);
    const u1 = uv.getX(ib), v1 = uv.getY(ib);
    const u2 = uv.getX(ic), v2 = uv.getY(ic);

    const du1 = u1 - u0, dv1 = v1 - v0;
    const du2 = u2 - u0, dv2 = v2 - v0;
    const det = du1 * dv2 - du2 * dv1;
    if (Math.abs(det) < 1e-10) continue;
    const invDet = 1.0 / det;

    // Triangle pixel coordinates (note flipY=true: y = (1 - v) * H)
    const p0x = u0 * W, p0y = (1.0 - v0) * H;
    const p1x = u1 * W, p1y = (1.0 - v1) * H;
    const p2x = u2 * W, p2y = (1.0 - v2) * H;

    const minPx = Math.floor(Math.min(p0x, p1x, p2x) - bleedPx);
    const maxPx = Math.ceil(Math.max(p0x, p1x, p2x) + bleedPx);
    const minPy = Math.floor(Math.min(p0y, p1y, p2y) - bleedPx);
    const maxPy = Math.ceil(Math.max(p0y, p1y, p2y) + bleedPx);

    for (let gy = minPy; gy <= maxPy; gy++) {
      const py = ((gy % H) + H) % H;
      const v = 1.0 - (gy + 0.5) / H;
      for (let gx = minPx; gx <= maxPx; gx++) {
        const px = ((gx % W) + W) % W;
        const u = (gx + 0.5) / W;

        const ru = u - u0;
        const rv = v - v0;
        const b1 = (ru * dv2 - du2 * rv) * invDet;
        const b2 = (du1 * rv - ru * dv1) * invDet;
        const b0 = 1.0 - b1 - b2;

        let marginAtten = 1.0;
        let cb0 = b0, cb1 = b1, cb2 = b2;
        if (b0 < 0 || b1 < 0 || b2 < 0) {
          const cxp = gx + 0.5, cyp = gy + 0.5;
          const dSq = Math.min(
            distSqPointSegment2D(cxp, cyp, p0x, p0y, p1x, p1y),
            distSqPointSegment2D(cxp, cyp, p1x, p1y, p2x, p2y),
            distSqPointSegment2D(cxp, cyp, p2x, p2y, p0x, p0y)
          );
          if (dSq > bleedSq) continue;
          marginAtten = Math.max(0.15, 1.0 - Math.sqrt(dSq) / (bleedPx + 0.25));
          cb0 = Math.max(0, b0);
          cb1 = Math.max(0, b1);
          cb2 = Math.max(0, b2);
          const sum = cb0 + cb1 + cb2 || 1;
          cb0 /= sum; cb1 /= sum; cb2 /= sum;
        }

        const px3 = cb0 * ax + cb1 * bx + cb2 * cx;
        const py3 = cb0 * ay + cb1 * by + cb2 * cy;
        const pz3 = cb0 * az + cb1 * bz + cb2 * cz;

        const dx3 = px3 - localCenter.x;
        const dy3 = py3 - localCenter.y;
        const dz3 = pz3 - localCenter.z;
        const distSq = dx3 * dx3 + dy3 * dy3 + dz3 * dz3;
        if (distSq > r2) continue;

        const dist = Math.sqrt(distSq);
        const w = smoothFalloff(dist / localRadius, hardness) * strength * marginAtten;
        if (w <= 1e-4) continue;

        const lin = py * W + px;
        const prevW = pixelWeights.get(lin) || 0;
        if (w > prevW) pixelWeights.set(lin, w);
      }
    }
  }

  if (pixelWeights.size === 0) return 0;

  let touched = 0;
  const srcRgba = brush === 'smear' && smearRgba ? smearRgba : colorRgba;
  let softenRead = null;
  if (brush === 'soften') {
    softenRead = new Uint8ClampedArray(data);
  }

  for (const [lin, w] of pixelWeights.entries()) {
    const px = lin % W;
    const py = Math.floor(lin / W);
    ensureTileSaved(px, py);
    const i4 = lin * 4;
    if (brush === 'erase') {
      data[i4 + 3] = clampU8(data[i4 + 3] * (1.0 - w));
    } else if (brush === 'soften' && softenRead) {
      let r = 0, g = 0, b = 0, a = 0, cnt = 0;
      for (let oy = -1; oy <= 1; oy++) {
        const ny = Math.max(0, Math.min(H - 1, py + oy));
        for (let ox = -1; ox <= 1; ox++) {
          const nx = Math.max(0, Math.min(W - 1, px + ox));
          const ni = (ny * W + nx) * 4;
          r += softenRead[ni];
          g += softenRead[ni + 1];
          b += softenRead[ni + 2];
          a += softenRead[ni + 3];
          cnt++;
        }
      }
      data[i4] = clampU8(data[i4] + (r / cnt - data[i4]) * w);
      data[i4 + 1] = clampU8(data[i4 + 1] + (g / cnt - data[i4 + 1]) * w);
      data[i4 + 2] = clampU8(data[i4 + 2] + (b / cnt - data[i4 + 2]) * w);
      data[i4 + 3] = clampU8(data[i4 + 3] + (a / cnt - data[i4 + 3]) * w);
    } else {
      data[i4] = clampU8(data[i4] + (srcRgba[0] - data[i4]) * w);
      data[i4 + 1] = clampU8(data[i4 + 1] + (srcRgba[1] - data[i4 + 1]) * w);
      data[i4 + 2] = clampU8(data[i4 + 2] + (srcRgba[2] - data[i4 + 2]) * w);
      data[i4 + 3] = clampU8(data[i4 + 3] + (srcRgba[3] - data[i4 + 3]) * w);
    }
    touched++;
  }

  layer.surface.syncToCanvas();
  return touched;
}

/**
 * 2D UV space circular brush splat (for interactive painting directly in UV Editor).
 */
export function paintLayer2DAtUV({
  layer,
  u,
  v,
  radiusPx = 16,
  brush = 'draw',
  colorRgba = [255, 110, 64, 255],
  strength = 0.75,
  hardness = 0.5,
  smearRgba = null,
  dirtyTiles = null,
}) {
  if (!layer) return 0;
  const W = layer.width;
  const H = layer.height;
  const data = layer.data;
  const uW = u - Math.floor(u);
  const vW = v - Math.floor(v);
  const cx = uW * W;
  const cy = (1.0 - vW) * H;
  const r = Math.max(1, radiusPx);
  const rSq = r * r;

  const ensureTileSaved = (px, py) => {
    if (!dirtyTiles) return;
    const tx = Math.floor(px / TILE_SIZE);
    const ty = Math.floor(py / TILE_SIZE);
    const key = `${tx},${ty}`;
    if (dirtyTiles.has(key)) return;
    const x0 = tx * TILE_SIZE;
    const y0 = ty * TILE_SIZE;
    const w = Math.min(TILE_SIZE, W - x0);
    const h = Math.min(TILE_SIZE, H - y0);
    dirtyTiles.set(key, {
      tx, ty, x: x0, y: y0, w, h,
      before: layer.readRect(x0, y0, w, h),
      after: null,
    });
  };

  const x0 = Math.max(0, Math.floor(cx - r));
  const x1 = Math.min(W - 1, Math.ceil(cx + r));
  const y0 = Math.max(0, Math.floor(cy - r));
  const y1 = Math.min(H - 1, Math.ceil(cy + r));
  const srcRgba = brush === 'smear' && smearRgba ? smearRgba : colorRgba;
  let softenCopy = brush === 'soften' ? new Uint8ClampedArray(data) : null;
  let touched = 0;

  for (let py = y0; py <= y1; py++) {
    for (let px = x0; px <= x1; px++) {
      const dx = (px + 0.5) - cx;
      const dy = (py + 0.5) - cy;
      const d2 = dx * dx + dy * dy;
      if (d2 > rSq) continue;
      const w = smoothFalloff(Math.sqrt(d2) / r, hardness) * strength;
      if (w <= 1e-4) continue;
      ensureTileSaved(px, py);
      const i4 = (py * W + px) * 4;
      if (brush === 'erase') {
        data[i4 + 3] = clampU8(data[i4 + 3] * (1.0 - w));
      } else if (brush === 'soften' && softenCopy) {
        let rr = 0, gg = 0, bb = 0, aa = 0, cnt = 0;
        for (let oy = -1; oy <= 1; oy++) {
          const ny = Math.max(0, Math.min(H - 1, py + oy));
          for (let ox = -1; ox <= 1; ox++) {
            const nx = Math.max(0, Math.min(W - 1, px + ox));
            const ni = (ny * W + nx) * 4;
            rr += softenCopy[ni]; gg += softenCopy[ni + 1]; bb += softenCopy[ni + 2]; aa += softenCopy[ni + 3];
            cnt++;
          }
        }
        data[i4] = clampU8(data[i4] + (rr / cnt - data[i4]) * w);
        data[i4 + 1] = clampU8(data[i4 + 1] + (gg / cnt - data[i4 + 1]) * w);
        data[i4 + 2] = clampU8(data[i4 + 2] + (bb / cnt - data[i4 + 2]) * w);
        data[i4 + 3] = clampU8(data[i4 + 3] + (aa / cnt - data[i4 + 3]) * w);
      } else {
        data[i4] = clampU8(data[i4] + (srcRgba[0] - data[i4]) * w);
        data[i4 + 1] = clampU8(data[i4 + 1] + (srcRgba[1] - data[i4 + 1]) * w);
        data[i4 + 2] = clampU8(data[i4 + 2] + (srcRgba[2] - data[i4 + 2]) * w);
        data[i4 + 3] = clampU8(data[i4 + 3] + (srcRgba[3] - data[i4 + 3]) * w);
      }
      touched++;
    }
  }

  if (touched > 0) layer.surface.syncToCanvas();
  return touched;
}

/**
 * Coordinates Vertex Paint and Texture Paint modes inside the 3D Viewport & UV Editor.
 */
export class PaintModeManager {
  constructor(engine, options = {}) {
    this.engine = engine || null;
    this.sceneManager = options.sceneManager || null;
    this.dataBlockRegistry = options.dataBlockRegistry || null;
    this.blobStore = options.blobStore || null;

    this.mode = null; // null | 'vertex-paint' | 'texture-paint'
    this.targetMesh = null;

    // Shared brush controls
    this.brush = 'draw'; // Vertex: 'mix'|'add'|'subtract'|'blur'|'smear' ; Texture: 'draw'|'erase'|'soften'|'smear'
    this.radius = 0.35;
    this.radiusPx = 22;
    this.strength = 0.8;
    this.hardness = 0.55;
    this.colorHex = '#ff6b35';
    this.symmetryX = false;
    this.symmetryY = false;
    this.symmetryZ = false;
    this.activeSlot = 'baseColor';

    this.isBrushing = false;
    this._strokeStartColors = null;
    this._strokeStartFlags = null;
    this._strokeDirtyTiles = null;
    this._strokeSlot = null;
    this._strokeLayerId = null;
    this._smearColor = null;
    this._smearRgba = null;
    this._topo = null;

    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2();
    this._invMatrix = new THREE.Matrix4();
    this._normalMatrix = new THREE.Matrix3();
    this._tmpColor = new THREE.Color();

    this.brushCursor = null;
    this._initCursor();

    this._onPointerDown = this._onPointerDown.bind(this);
    this._onPointerMove = this._onPointerMove.bind(this);
    this._onPointerUp = this._onPointerUp.bind(this);
    this._onKeyDown = this._onKeyDown.bind(this);
  }

  get isActive() {
    return this.mode === 'vertex-paint' || this.mode === 'texture-paint';
  }

  _initCursor() {
    if (!this.engine?.scene) return;
    const geo = new THREE.RingGeometry(0.9, 1.0, 48);
    const mat = new THREE.MeshBasicMaterial({
      color: 0x38bdf8,
      side: THREE.DoubleSide,
      depthTest: false,
      transparent: true,
      opacity: 0.85,
    });
    this.brushCursor = new THREE.Mesh(geo, mat);
    this.brushCursor.visible = false;
    this.brushCursor.renderOrder = 999;
    this.brushCursor.userData.isSystemHelper = true;
    this.engine.scene.add(this.brushCursor);
  }

  _updateCursorColor() {
    if (!this.brushCursor?.material) return;
    this.brushCursor.material.color.setHex(this.mode === 'vertex-paint' ? 0xc084fc : 0x38bdf8);
  }

  enter(mesh, paintKind = 'texture-paint', options = {}) {
    if (!mesh?.isMesh || !mesh.geometry?.attributes?.position) return false;
    if (this.isActive) this.exit();
    if (typeof window !== 'undefined') {
      if (window.editMode?.isActive) window.editMode.exit();
      if (window.sculptMode?.isActive) window.sculptMode.exit();
      if (window.rigSystem?.isWeightPaintMode) window.rigSystem.disableWeightPaintMode();
      if (window.rigSystem?.isEditBoneMode) window.rigSystem.exitEditBoneMode();
      if (window.rigSystem?.isPoseMode) window.rigSystem.setPoseMode(false);
    }

    this.targetMesh = mesh;
    this.mode = paintKind === 'vertex-paint' ? 'vertex-paint' : 'texture-paint';
    ensureBVH(mesh);

    if (this.mode === 'vertex-paint') {
      const vcInit = ensureVertexColorAttribute(mesh, true);
      this._pendingInitialVcFlags = vcInit?.prevFlags ? [...vcInit.prevFlags] : null;
      this._topo = buildVertexPaintTopology(mesh.geometry);
      if (this.brush === 'erase' || this.brush === 'soften') this.brush = 'mix';
    } else {
      if (!mesh.geometry.attributes.uv) {
        const projected = smartUVProjectGeometry(mesh.geometry);
        applyUVGeometryUpdate(mesh, projected);
      }
      const w = options.width || 1024;
      const h = options.height || 1024;
      this.ensureMaterialAndSlot(mesh, this.activeSlot, w, h);
      if (this.brush === 'mix' || this.brush === 'add' || this.brush === 'subtract' || this.brush === 'blur') {
        this.brush = 'draw';
      }
    }

    if (this.engine?.transformControls) {
      this.engine.transformControls.detach();
    }

    const canvas = this.engine?.renderer?.domElement;
    if (canvas) {
      canvas.addEventListener('pointerdown', this._onPointerDown);
      canvas.addEventListener('pointermove', this._onPointerMove);
    }
    if (typeof window !== 'undefined') {
      window.addEventListener('pointerup', this._onPointerUp);
      window.addEventListener('keydown', this._onKeyDown);
    }

    this._updateCursorColor();
    this._syncToolbarUI(true);
    this._notifyRender();
    return true;
  }

  exit() {
    if (!this.isActive) return;
    const canvas = this.engine?.renderer?.domElement;
    if (canvas) {
      canvas.removeEventListener('pointerdown', this._onPointerDown);
      canvas.removeEventListener('pointermove', this._onPointerMove);
    }
    if (typeof window !== 'undefined') {
      window.removeEventListener('pointerup', this._onPointerUp);
      window.removeEventListener('keydown', this._onKeyDown);
    }
    if (this.brushCursor) this.brushCursor.visible = false;
    if (this.mode === 'vertex-paint' && this.targetMesh && this._pendingInitialVcFlags && !this.targetMesh.userData?.paintVertexColor) {
      const mats = Array.isArray(this.targetMesh.material) ? this.targetMesh.material : [this.targetMesh.material];
      mats.forEach((m, i) => {
        if (m && typeof this._pendingInitialVcFlags[i] === 'boolean') {
          m.vertexColors = this._pendingInitialVcFlags[i];
          m.needsUpdate = true;
        }
      });
    }
    this._pendingInitialVcFlags = null;
    const previousMesh = this.targetMesh;
    this.mode = null;
    this.isBrushing = false;
    this.targetMesh = null;
    this._topo = null;
    this._strokeStartColors = null;
    this._strokeDirtyTiles = null;
    this._syncToolbarUI(false);
    const activeTarget = this.engine?.sceneManager?.getActiveObject?.() || previousMesh;
    this.engine?.updateActiveGizmo?.(activeTarget);
    this.engine?.updateSelectionHelper?.();
    this.engine?.syncViewportPaneControls?.();
    this._notifyRender();
  }

  ensureMaterialAndSlot(mesh = this.targetMesh, slotKey = this.activeSlot, width = 1024, height = 1024) {
    if (!mesh) return null;
    if (!mesh.material || Array.isArray(mesh.material) && !mesh.material[0]) {
      mesh.material = new THREE.MeshStandardMaterial({ color: 0xcccccc, roughness: 0.5, metalness: 0.0 });
    }
    const mat = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
    const stack = ensurePaintLayerStack(mat, {
      dataBlockRegistry: this.dataBlockRegistry,
      blobStore: this.blobStore,
    });
    const slot = stack.ensureSlot(slotKey, width, height);
    return { mat, stack, slot };
  }

  setBrush(brush) {
    this.brush = brush;
  }

  setColor(hex) {
    this.colorHex = hex;
  }

  setSlot(slotKey) {
    if (!PAINT_SLOTS[slotKey]) return;
    this.activeSlot = slotKey;
    if (this.mode === 'texture-paint' && this.targetMesh) {
      this.ensureMaterialAndSlot(this.targetMesh, slotKey);
      this._emitTextureUpdated();
    }
  }

  // -------------------------------------------------------------------------
  // Symmetry Helper
  // -------------------------------------------------------------------------

  _enumerateSymmetryPoints(localPt) {
    const pts = [localPt.clone()];
    const axes = [];
    if (this.symmetryX) axes.push('x');
    if (this.symmetryY) axes.push('y');
    if (this.symmetryZ) axes.push('z');
    for (const ax of axes) {
      const curLen = pts.length;
      for (let i = 0; i < curLen; i++) {
        const m = pts[i].clone();
        m[ax] = -m[ax];
        pts.push(m);
      }
    }
    return pts;
  }

  // -------------------------------------------------------------------------
  // Vertex Paint Operations (Weld-Aware + Undoable)
  // -------------------------------------------------------------------------

  _beginVertexStroke() {
    const mesh = this.targetMesh;
    const ensured = ensureVertexColorAttribute(mesh, true);
    if (!ensured) return;
    this._strokeStartColors = new Float32Array(ensured.attr.array);
    this._strokeStartFlags = this._pendingInitialVcFlags ? [...this._pendingInitialVcFlags] : [...ensured.prevFlags];
    this._pendingInitialVcFlags = null;
    if (!this._topo) this._topo = buildVertexPaintTopology(mesh.geometry);
    this._smearColor = null;
  }

  applyVertexBrushAtLocalPoint(localPt) {
    const mesh = this.targetMesh;
    if (!mesh?.geometry?.attributes?.position) return 0;
    const ensured = ensureVertexColorAttribute(mesh, true);
    const attr = ensured.attr;
    const pos = mesh.geometry.attributes.position;
    if (!this._topo) this._topo = buildVertexPaintTopology(mesh.geometry);
    const itemSize = attr.itemSize || 3;

    this._tmpColor.set(this.colorHex || '#ffffff'); // sRGB hex -> linear float32
    const targetR = this._tmpColor.r;
    const targetG = this._tmpColor.g;
    const targetB = this._tmpColor.b;

    const r = Math.max(1e-4, this.radius);
    const r2 = r * r;
    const pts = this._enumerateSymmetryPoints(localPt);
    const touchedGroups = new Set();

    // Smear samples color at first dab
    if (this.brush === 'smear' && !this._smearColor) {
      let bestGid = 0, bestD2 = Infinity;
      for (let gid = 0; gid < this._topo.groups.length; gid++) {
        const vi = this._topo.groups[gid][0];
        const dx = pos.getX(vi) - localPt.x;
        const dy = pos.getY(vi) - localPt.y;
        const dz = pos.getZ(vi) - localPt.z;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 < bestD2) { bestD2 = d2; bestGid = gid; }
      }
      const v0 = this._topo.groups[bestGid][0] * itemSize;
      this._smearColor = [attr.array[v0], attr.array[v0 + 1], attr.array[v0 + 2]];
    }

    const snapColors = this.brush === 'blur' ? new Float32Array(attr.array) : null;

    for (const p of pts) {
      for (let gid = 0; gid < this._topo.groups.length; gid++) {
        const verts = this._topo.groups[gid];
        const vi0 = verts[0];
        const dx = pos.getX(vi0) - p.x;
        const dy = pos.getY(vi0) - p.y;
        const dz = pos.getZ(vi0) - p.z;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 > r2) continue;

        const w = smoothFalloff(Math.sqrt(d2) / r, this.hardness) * this.strength;
        if (w <= 1e-4) continue;
        touchedGroups.add(gid);

        const off0 = vi0 * itemSize;
        let nr = attr.array[off0];
        let ng = attr.array[off0 + 1];
        let nb = attr.array[off0 + 2];

        if (this.brush === 'add') {
          nr = Math.min(1, nr + targetR * w);
          ng = Math.min(1, ng + targetG * w);
          nb = Math.min(1, nb + targetB * w);
        } else if (this.brush === 'subtract') {
          nr = Math.max(0, nr - targetR * w);
          ng = Math.max(0, ng - targetG * w);
          nb = Math.max(0, nb - targetB * w);
        } else if (this.brush === 'blur' && snapColors) {
          const nbrs = this._topo.neighborGroups[gid];
          if (nbrs.length > 0) {
            let sr = 0, sg = 0, sb = 0;
            for (const ngid of nbrs) {
              const nv = this._topo.groups[ngid][0] * itemSize;
              sr += snapColors[nv]; sg += snapColors[nv + 1]; sb += snapColors[nv + 2];
            }
            const inv = 1 / nbrs.length;
            nr += (sr * inv - nr) * w;
            ng += (sg * inv - ng) * w;
            nb += (sb * inv - nb) * w;
          }
        } else if (this.brush === 'smear' && this._smearColor) {
          nr += (this._smearColor[0] - nr) * w;
          ng += (this._smearColor[1] - ng) * w;
          nb += (this._smearColor[2] - nb) * w;
        } else {
          // Default Mix
          nr += (targetR - nr) * w;
          ng += (targetG - ng) * w;
          nb += (targetB - nb) * w;
        }

        for (const vi of verts) {
          const off = vi * itemSize;
          attr.array[off] = nr;
          attr.array[off + 1] = ng;
          attr.array[off + 2] = nb;
        }
      }
    }

    if (touchedGroups.size > 0) {
      attr.needsUpdate = true;
      mesh.userData.paintVertexColor = true;
      this._notifyRender();
    }
    return touchedGroups.size;
  }

  _commitVertexStroke(label = 'Vertex Paint') {
    if (!this.targetMesh || !this._strokeStartColors) return null;
    const ensured = ensureVertexColorAttribute(this.targetMesh, true);
    const nextColors = new Float32Array(ensured.attr.array);
    const cmd = new VertexColorCommand(
      this.targetMesh,
      this._strokeStartColors,
      nextColors,
      this._strokeStartFlags,
      ensured.nextFlags,
      () => this._notifyRender(),
      label
    );
    this._recordCommand(cmd);
    this._strokeStartColors = null;
    this._strokeStartFlags = null;
    return cmd;
  }

  fillVertexColor(hex = this.colorHex, mesh = this.targetMesh) {
    if (!mesh?.geometry?.attributes?.position) return null;
    const ensured = ensureVertexColorAttribute(mesh, true);
    const prevColors = new Float32Array(ensured.attr.array);
    const itemSize = ensured.attr.itemSize || 3;
    const col = new THREE.Color(hex);
    const nextColors = new Float32Array(prevColors);
    for (let i = 0; i < ensured.attr.count; i++) {
      const o = i * itemSize;
      nextColors[o] = col.r;
      nextColors[o + 1] = col.g;
      nextColors[o + 2] = col.b;
    }
    ensured.attr.array.set(nextColors);
    ensured.attr.needsUpdate = true;
    mesh.userData.paintVertexColor = true;
    const prevFlags = this._pendingInitialVcFlags ? [...this._pendingInitialVcFlags] : ensured.prevFlags;
    this._pendingInitialVcFlags = null;
    const cmd = new VertexColorCommand(
      mesh, prevColors, nextColors, prevFlags, ensured.nextFlags,
      () => this._notifyRender(), 'Fill Vertex Colors'
    );
    this._recordCommand(cmd);
    this._notifyRender();
    return cmd;
  }

  dirtyVertexColors(opts = {}, mesh = this.targetMesh) {
    if (!mesh?.geometry?.attributes?.position) return null;
    const res = computeDirtyVertexColors(mesh, opts);
    if (!res) return null;
    mesh.userData.paintVertexColor = true;
    const prevFlags = this._pendingInitialVcFlags ? [...this._pendingInitialVcFlags] : res.prevFlags;
    this._pendingInitialVcFlags = null;
    const cmd = new VertexColorCommand(
      mesh, res.prevColors, res.nextColors, prevFlags, res.nextFlags,
      () => this._notifyRender(), 'Dirty Vertex Colors'
    );
    this._recordCommand(cmd);
    this._notifyRender();
    return cmd;
  }

  // -------------------------------------------------------------------------
  // Texture Paint Operations (3D BVH Projection + 2D UV Canvas + Tile Undo)
  // -------------------------------------------------------------------------

  _beginTextureStroke() {
    const info = this.ensureMaterialAndSlot(this.targetMesh, this.activeSlot);
    if (!info) return null;
    const layer = info.stack.getActiveLayer(this.activeSlot);
    this._strokeDirtyTiles = new Map();
    this._strokeSlot = this.activeSlot;
    this._strokeLayerId = layer?.id || null;
    this._smearRgba = null;
    return { info, layer };
  }

  applyTextureBrushAtLocalPoint(localPt, uvSample = null) {
    const mesh = this.targetMesh;
    if (!mesh?.geometry?.attributes?.uv) return 0;
    const info = this.ensureMaterialAndSlot(mesh, this.activeSlot);
    const layer = info?.stack?.getActiveLayer(this.activeSlot);
    if (!layer) return 0;

    if (!this._strokeDirtyTiles) this._beginTextureStroke();

    if (this.brush === 'smear' && !this._smearRgba && uvSample) {
      this._smearRgba = this.sampleRgbaAtUV(layer, uvSample.x, uvSample.y);
    }

    const rgba = hexToRgba255(this.colorHex);
    const pts = this._enumerateSymmetryPoints(localPt);
    let totalTouched = 0;
    for (const pt of pts) {
      totalTouched += splatBrushTrianglesInLocalSphere({
        geometry: mesh.geometry,
        layer,
        localCenter: pt,
        localRadius: Math.max(1e-4, this.radius),
        brush: this.brush,
        colorRgba: rgba,
        strength: this.strength,
        hardness: this.hardness,
        smearRgba: this._smearRgba,
        dirtyTiles: this._strokeDirtyTiles,
      });
    }

    if (totalTouched > 0) {
      info.stack.compositeSlot(this.activeSlot);
      this._emitTextureUpdated();
      this._notifyRender();
    }
    return totalTouched;
  }

  paint2DAtUV(u, v, options = {}) {
    const mesh = options.mesh || this.targetMesh || this.sceneManager?.getActiveObject();
    if (!mesh?.isMesh) return 0;
    const slotKey = options.slot || this.activeSlot;
    const info = this.ensureMaterialAndSlot(mesh, slotKey);
    const layer = info?.stack?.getActiveLayer(slotKey);
    if (!layer) return 0;

    const beginNew = options.beginStroke || !this._strokeDirtyTiles;
    if (beginNew) {
      this._strokeDirtyTiles = new Map();
      this._strokeSlot = slotKey;
      this._strokeLayerId = layer.id;
      this._smearRgba = this.brush === 'smear' ? this.sampleRgbaAtUV(layer, u, v) : null;
    }

    const rgba = options.colorHex ? hexToRgba255(options.colorHex) : hexToRgba255(this.colorHex);
    const touched = paintLayer2DAtUV({
      layer,
      u,
      v,
      radiusPx: options.radiusPx ?? this.radiusPx,
      brush: options.brush ?? this.brush,
      colorRgba: rgba,
      strength: options.strength ?? this.strength,
      hardness: options.hardness ?? this.hardness,
      smearRgba: this._smearRgba,
      dirtyTiles: this._strokeDirtyTiles,
    });

    if (touched > 0) {
      info.stack.compositeSlot(slotKey);
      this._emitTextureUpdated();
      this._notifyRender();
    }
    if (options.commitStroke) {
      this.commitTextureStroke(mesh, options.label || 'UV Texture Paint');
    }
    return touched;
  }

  sampleRgbaAtUV(layer, u, v) {
    if (!layer) return [255, 255, 255, 255];
    const uW = u - Math.floor(u);
    const vW = v - Math.floor(v);
    const px = Math.max(0, Math.min(layer.width - 1, Math.floor(uW * layer.width)));
    const py = Math.max(0, Math.min(layer.height - 1, Math.floor((1 - vW) * layer.height)));
    const i4 = (py * layer.width + px) * 4;
    return [layer.data[i4], layer.data[i4 + 1], layer.data[i4 + 2], layer.data[i4 + 3]];
  }

  commitTextureStroke(mesh = this.targetMesh, label = 'Texture Paint') {
    const tiles = this._strokeDirtyTiles;
    if (!tiles || tiles.size === 0 || !mesh) {
      this._strokeDirtyTiles = null;
      return null;
    }
    const info = this.ensureMaterialAndSlot(mesh, this._strokeSlot || this.activeSlot);
    const slot = info?.stack?.getSlot(this._strokeSlot || this.activeSlot);
    const layer = slot?.layers?.find((l) => l.id === this._strokeLayerId) || info?.stack?.getActiveLayer(this.activeSlot);
    if (!layer) {
      this._strokeDirtyTiles = null;
      return null;
    }

    for (const t of tiles.values()) {
      t.after = layer.readRect(t.x, t.y, t.w, t.h);
    }

    const cmd = new TexturePaintCommand(
      info.stack,
      this._strokeSlot || this.activeSlot,
      layer.id,
      tiles,
      () => {
        this._emitTextureUpdated();
        this._notifyRender();
      },
      label
    );
    this._recordCommand(cmd);
    this._strokeDirtyTiles = null;
    return cmd;
  }

  // -------------------------------------------------------------------------
  // Viewport Pointer & Shortcut Event Handlers
  // -------------------------------------------------------------------------

  _raycastTarget(event) {
    if (!this.engine || !this.targetMesh) return null;
    const ctx = this.engine.getViewportContextAtPoint(event.clientX, event.clientY);
    const rect = ctx.rect;
    if (!rect || rect.width <= 0 || rect.height <= 0) return null;
    this.pointer.set(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1
    );
    this.raycaster.setFromCamera(this.pointer, ctx.camera || this.engine.camera);
    const hits = raycastMeshAccelerated(this.targetMesh, this.raycaster);
    return hits && hits.length > 0 ? hits[0] : null;
  }

  _updateBrushCursor(hit) {
    if (!this.brushCursor) return;
    if (!hit) {
      this.brushCursor.visible = false;
      return;
    }
    this.brushCursor.visible = true;
    const r = Math.max(0.01, this.radius);
    this.brushCursor.scale.set(r, r, r);
    const faceN = hit.face?.normal ? hit.face.normal.clone() : new THREE.Vector3(0, 1, 0);
    this._normalMatrix.getNormalMatrix(this.targetMesh.matrixWorld);
    faceN.applyMatrix3(this._normalMatrix).normalize();
    this.brushCursor.position.copy(hit.point).addScaledVector(faceN, 0.002);
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), faceN);
    this.brushCursor.quaternion.copy(q);
  }

  _onPointerDown(event) {
    if (!this.isActive || (event.button ?? 0) !== 0 || event.altKey) return;
    const hit = this._raycastTarget(event);
    if (!hit) return;

    event.stopPropagation?.();
    this.isBrushing = true;
    this.engine?.syncViewportPaneControls?.();

    this._invMatrix.copy(this.targetMesh.matrixWorld).invert();
    const localPt = hit.point.clone().applyMatrix4(this._invMatrix);

    if (this.mode === 'vertex-paint') {
      this._beginVertexStroke();
      this.applyVertexBrushAtLocalPoint(localPt);
    } else {
      this._beginTextureStroke();
      this.applyTextureBrushAtLocalPoint(localPt, hit.uv || null);
    }
  }

  _onPointerMove(event) {
    if (!this.isActive) return;
    const hit = this._raycastTarget(event);
    this._updateBrushCursor(hit);
    if (!this.isBrushing || !hit) return;

    this._invMatrix.copy(this.targetMesh.matrixWorld).invert();
    const localPt = hit.point.clone().applyMatrix4(this._invMatrix);
    if (this.mode === 'vertex-paint') {
      this.applyVertexBrushAtLocalPoint(localPt);
    } else {
      this.applyTextureBrushAtLocalPoint(localPt, hit.uv || null);
    }
  }

  _onPointerUp() {
    if (!this.isActive || !this.isBrushing) return;
    this.isBrushing = false;
    if (this.mode === 'vertex-paint') {
      this._commitVertexStroke();
    } else {
      this.commitTextureStroke();
    }
  }

  _onKeyDown(event) {
    if (!this.isActive) return;
    const key = event.key.toLowerCase();
    if (key === '[') {
      this.radius = Math.max(0.02, +(this.radius * 0.85).toFixed(3));
      this._syncToolbarUI(true);
    } else if (key === ']') {
      this.radius = Math.min(5.0, +(this.radius * 1.15).toFixed(3));
      this._syncToolbarUI(true);
    } else if (event.shiftKey && key === 'k' && this.mode === 'vertex-paint') {
      event.preventDefault();
      this.fillVertexColor();
    }
  }

  _recordCommand(cmd) {
    if (!cmd) return;
    const sm = this.sceneManager;
    if (sm && typeof sm.recordExecutedCommand === 'function') {
      sm.recordExecutedCommand(cmd);
    } else if (sm?.undoStack && typeof sm.undoStack.push === 'function') {
      // Fallback command registration
      sm.undoStack.push(cmd);
      if (Array.isArray(sm.redoStack)) sm.redoStack.length = 0;
      sm.markDirty?.();
    }
  }

  _emitTextureUpdated() {
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('blender:textureUpdated', {
        detail: { mesh: this.targetMesh, slot: this.activeSlot },
      }));
    }
  }

  _notifyRender() {
    this.sceneManager?.markDirty?.();
    this.engine?.render?.();
  }

  _syncToolbarUI(visible) {
    if (typeof document === 'undefined') return;
    const grp = document.getElementById('paint-mode-selector-group');
    if (grp) grp.style.display = visible ? 'flex' : 'none';
    const slotWrap = document.getElementById('paint-slot-wrap');
    if (slotWrap) slotWrap.style.display = this.mode === 'texture-paint' ? 'inline-flex' : 'none';
    const dirtyBtn = document.getElementById('btn-paint-dirty-vc');
    if (dirtyBtn) dirtyBtn.style.display = this.mode === 'vertex-paint' ? 'inline-flex' : 'none';
    const fillBtn = document.getElementById('btn-paint-fill');
    if (fillBtn) fillBtn.style.display = visible ? 'inline-flex' : 'none';
    const sel = document.getElementById('viewport-mode');
    if (sel) {
      if (visible && this.mode && sel.value !== this.mode) sel.value = this.mode;
      else if (!visible && (sel.value === 'vertex-paint' || sel.value === 'texture-paint')) sel.value = 'object';
    }
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('blender:mode-changed', {
        detail: { mode: visible && this.mode ? this.mode : 'object' }
      }));
    }
    const rVal = document.getElementById('val-paint-radius');
    const rSlider = document.getElementById('slider-paint-radius');
    if (rVal) rVal.textContent = String(this.radius);
    if (rSlider) rSlider.value = String(this.radius);
    const sVal = document.getElementById('val-paint-strength');
    const sSlider = document.getElementById('slider-paint-strength');
    if (sVal) sVal.textContent = String(this.strength);
    if (sSlider) sSlider.value = String(this.strength);
  }
}

export default PaintModeManager;
