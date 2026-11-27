/**
 * Multi-Channel / Multi-Layer Paint Surfaces backed by BlobStore & Three.js Textures
 * Supports both Browser HTMLCanvasElement (CanvasTexture) and Headless Node PixelSurface (DataTexture).
 * File: js/core/paint-layers.js
 */

import * as THREE from 'three';

export const PAINT_SLOTS = {
  baseColor: {
    key: 'baseColor',
    label: 'Base Color',
    mapKey: 'map',
    srgb: true,
    defaultRgba: [204, 204, 204, 255],
  },
  roughness: {
    key: 'roughness',
    label: 'Roughness',
    mapKey: 'roughnessMap',
    srgb: false,
    defaultRgba: [128, 128, 128, 255],
  },
  metalness: {
    key: 'metalness',
    label: 'Metallic',
    mapKey: 'metalnessMap',
    srgb: false,
    defaultRgba: [0, 0, 0, 255],
  },
  bump: {
    key: 'bump',
    label: 'Bump / Height',
    mapKey: 'bumpMap',
    srgb: false,
    defaultRgba: [128, 128, 128, 255],
  },
  ao: {
    key: 'ao',
    label: 'Ambient Occlusion',
    mapKey: 'aoMap',
    srgb: false,
    defaultRgba: [255, 255, 255, 255],
  },
  normal: {
    key: 'normal',
    label: 'Normal Map',
    mapKey: 'normalMap',
    srgb: false,
    defaultRgba: [128, 128, 255, 255],
  },
};

export const TILE_SIZE = 64;

function clampU8(v) {
  return v < 0 ? 0 : (v > 255 ? 255 : (v + 0.5) | 0);
}

/**
 * Deterministic CPU RGBA8 buffer with optional browser HTMLCanvasElement mirror.
 */
export class PixelSurface {
  constructor(width = 1024, height = 1024, initialRgba = null) {
    this.width = Math.max(1, width | 0);
    this.height = Math.max(1, height | 0);
    this.data = new Uint8ClampedArray(this.width * this.height * 4);
    this.canvas = null;
    this._ctx = null;
    if (typeof document !== 'undefined' && typeof document.createElement === 'function') {
      const c = document.createElement('canvas');
      c.width = this.width;
      c.height = this.height;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      if (ctx) {
        this.canvas = c;
        this._ctx = ctx;
      }
    }
    if (initialRgba && initialRgba.length === 4) {
      this.fill(initialRgba[0], initialRgba[1], initialRgba[2], initialRgba[3]);
    }
  }

  fill(r, g, b, a = 255) {
    const d = this.data;
    const len = d.length;
    for (let i = 0; i < len; i += 4) {
      d[i] = r;
      d[i + 1] = g;
      d[i + 2] = b;
      d[i + 3] = a;
    }
    this.syncToCanvas();
  }

  setBytes(bytes) {
    if (!bytes || bytes.length !== this.data.length) return false;
    this.data.set(bytes);
    this.syncToCanvas();
    return true;
  }

  readRect(x, y, w, h) {
    const x0 = Math.max(0, x | 0);
    const y0 = Math.max(0, y | 0);
    const rw = Math.max(0, Math.min(this.width - x0, w | 0));
    const rh = Math.max(0, Math.min(this.height - y0, h | 0));
    const out = new Uint8ClampedArray(rw * rh * 4);
    for (let row = 0; row < rh; row++) {
      const srcOff = ((y0 + row) * this.width + x0) * 4;
      const dstOff = row * rw * 4;
      out.set(this.data.subarray(srcOff, srcOff + rw * 4), dstOff);
    }
    return out;
  }

  writeRect(x, y, w, h, bytes) {
    const x0 = Math.max(0, x | 0);
    const y0 = Math.max(0, y | 0);
    const rw = Math.max(0, Math.min(this.width - x0, w | 0));
    const rh = Math.max(0, Math.min(this.height - y0, h | 0));
    if (!rw || !rh) return;
    for (let row = 0; row < rh; row++) {
      const srcOff = row * rw * 4;
      const dstOff = ((y0 + row) * this.width + x0) * 4;
      this.data.set(bytes.subarray(srcOff, srcOff + rw * 4), dstOff);
    }
    if (this._ctx) {
      const imgData = this._ctx.createImageData(rw, rh);
      imgData.data.set(bytes.subarray(0, rw * rh * 4));
      this._ctx.putImageData(imgData, x0, y0);
    }
  }

  syncToCanvas() {
    if (!this._ctx) return;
    const img = this._ctx.createImageData(this.width, this.height);
    img.data.set(this.data);
    this._ctx.putImageData(img, 0, 0);
  }

  syncFromCanvas() {
    if (!this._ctx) return;
    const img = this._ctx.getImageData(0, 0, this.width, this.height);
    this.data.set(img.data);
  }

  rasterizeExternalImage(image) {
    if (!image) return false;
    if (image.data && image.width && image.height) {
      // Nearest/bilinear resample from DataTexture / ImageData
      const sw = image.width;
      const sh = image.height;
      const sdata = image.data;
      for (let y = 0; y < this.height; y++) {
        const sy = Math.min(sh - 1, Math.floor((y / this.height) * sh));
        for (let x = 0; x < this.width; x++) {
          const sx = Math.min(sw - 1, Math.floor((x / this.width) * sw));
          const si = (sy * sw + sx) * 4;
          const di = (y * this.width + x) * 4;
          this.data[di] = sdata[si];
          this.data[di + 1] = sdata[si + 1];
          this.data[di + 2] = sdata[si + 2];
          this.data[di + 3] = sdata[si + 3] ?? 255;
        }
      }
      this.syncToCanvas();
      return true;
    }
    if (this._ctx && typeof this._ctx.drawImage === 'function') {
      try {
        this._ctx.clearRect(0, 0, this.width, this.height);
        this._ctx.drawImage(image, 0, 0, this.width, this.height);
        this.syncFromCanvas();
        return true;
      } catch (_) {
        return false;
      }
    }
    return false;
  }

  clone() {
    const copy = new PixelSurface(this.width, this.height);
    copy.data.set(this.data);
    copy.syncToCanvas();
    return copy;
  }
}

export class PaintLayer {
  constructor(name = 'Layer', width = 1024, height = 1024, options = {}) {
    this.id = options.id || `pl_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
    this.name = name;
    this.visible = options.visible !== false;
    this.opacity = Number.isFinite(options.opacity) ? Math.max(0, Math.min(1, options.opacity)) : 1.0;
    this.blendMode = options.blendMode || 'normal'; // 'normal' | 'multiply' | 'add'
    this.surface = new PixelSurface(width, height, options.fillRgba || null);
    if (options.bytes) {
      this.surface.setBytes(options.bytes);
    }
  }

  get width() { return this.surface.width; }
  get height() { return this.surface.height; }
  get data() { return this.surface.data; }

  readRect(x, y, w, h) {
    return this.surface.readRect(x, y, w, h);
  }

  writeRect(x, y, w, h, bytes) {
    this.surface.writeRect(x, y, w, h, bytes);
  }

  snapshot() {
    return {
      id: this.id,
      name: this.name,
      visible: this.visible,
      opacity: this.opacity,
      blendMode: this.blendMode,
      width: this.width,
      height: this.height,
      bytes: new Uint8ClampedArray(this.data),
    };
  }
}

const STACK_BY_MATERIAL = new WeakMap();

export class PaintLayerStack {
  constructor(material, options = {}) {
    this.material = material;
    this.dataBlockRegistry = options.dataBlockRegistry || null;
    this.blobStore = options.blobStore || null;
    this.slots = new Map();
    if (material && typeof material === 'object') {
      STACK_BY_MATERIAL.set(material, this);
    }
  }

  getSlot(slotKey) {
    return this.slots.get(slotKey) || null;
  }

  ensureSlot(slotKey = 'baseColor', width = 1024, height = 1024, opts = {}) {
    const spec = PAINT_SLOTS[slotKey] || PAINT_SLOTS.baseColor;
    let slot = this.slots.get(spec.key);
    if (slot) return slot;

    const w = Math.max(16, Math.min(4096, width | 0));
    const h = Math.max(16, Math.min(4096, height | 0));
    const composite = new PixelSurface(w, h, spec.defaultRgba);

    // Seed background layer from existing material texture or base color
    let fillRgba = [...spec.defaultRgba];
    if (spec.key === 'baseColor' && this.material?.color && !this.material[spec.mapKey]) {
      const c = this.material.color;
      const rgb = { r: 0.8, g: 0.8, b: 0.8 };
      c.getRGB(rgb, THREE.SRGBColorSpace);
      fillRgba = [clampU8(rgb.r * 255), clampU8(rgb.g * 255), clampU8(rgb.b * 255), 255];
      if (!opts.preserveMaterialTint) {
        this.material.color.setRGB(1, 1, 1);
      }
    } else if (spec.key === 'roughness' && this.material && !this.material[spec.mapKey]) {
      const r = clampU8((this.material.roughness ?? 0.5) * 255);
      fillRgba = [r, r, r, 255];
      if (!opts.preserveMaterialTint) {
        this.material.roughness = 1.0;
      }
    } else if (spec.key === 'metalness' && this.material && !this.material[spec.mapKey]) {
      const m = clampU8((this.material.metalness ?? 0.0) * 255);
      fillRgba = [m, m, m, 255];
      if (!opts.preserveMaterialTint) {
        this.material.metalness = 1.0;
      }
    }

    const baseLayer = new PaintLayer('Base Layer', w, h, { fillRgba });
    const existingTex = this.material?.[spec.mapKey];
    if (existingTex?.image) {
      baseLayer.surface.rasterizeExternalImage(existingTex.image);
    }

    let texture = existingTex;
    if (!texture || (!texture.isCanvasTexture && !texture.isDataTexture)) {
      texture = this._createTextureFromSurface(composite, spec.srgb);
    } else {
      // Replace backing image cleanly if surface canvas exists
      if (composite.canvas) {
        texture = this._createTextureFromSurface(composite, spec.srgb);
      } else {
        texture.image = { data: composite.data, width: w, height: h };
        texture.flipY = true;
        texture.needsUpdate = true;
      }
    }

    slot = {
      key: spec.key,
      width: w,
      height: h,
      layers: [baseLayer],
      activeLayerId: baseLayer.id,
      composite,
      texture,
      srgb: spec.srgb,
    };
    this.slots.set(spec.key, slot);
    if (this.material) {
      this.material[spec.mapKey] = texture;
      this.material.needsUpdate = true;
    }
    this.compositeSlot(spec.key);
    this._registerImageDataBlock(spec.key, slot);
    return slot;
  }

  _createTextureFromSurface(surface, srgb) {
    let tex;
    if (surface.canvas) {
      tex = new THREE.CanvasTexture(surface.canvas);
    } else {
      tex = new THREE.DataTexture(surface.data, surface.width, surface.height, THREE.RGBAFormat);
    }
    tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    tex.flipY = true;
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.needsUpdate = true;
    return tex;
  }

  _registerImageDataBlock(slotKey, slot) {
    if (!this.dataBlockRegistry || typeof this.dataBlockRegistry.register !== 'function') return;
    const matName = this.material?.name || 'Material';
    const id = `img_${this.material?.uuid?.slice(0, 8) || 'mat'}_${slotKey}`;
    this.dataBlockRegistry.register('images', id, {
      name: `${matName}_${slotKey}`,
      imageUuid: slot.texture?.uuid,
      width: slot.width,
      height: slot.height,
      slot: slotKey,
    });
  }

  getActiveLayer(slotKey = 'baseColor') {
    const slot = this.slots.get(slotKey);
    if (!slot || !slot.layers.length) return null;
    return slot.layers.find((l) => l.id === slot.activeLayerId) || slot.layers[slot.layers.length - 1];
  }

  addLayer(slotKey = 'baseColor', name = null, fillRgba = [0, 0, 0, 0]) {
    const slot = this.ensureSlot(slotKey);
    const layer = new PaintLayer(name || `Layer ${slot.layers.length + 1}`, slot.width, slot.height, { fillRgba });
    slot.layers.push(layer);
    slot.activeLayerId = layer.id;
    this.compositeSlot(slotKey);
    return layer;
  }

  removeLayer(slotKey, layerId) {
    const slot = this.slots.get(slotKey);
    if (!slot || slot.layers.length <= 1) return false;
    const idx = slot.layers.findIndex((l) => l.id === layerId);
    if (idx === -1) return false;
    slot.layers.splice(idx, 1);
    if (slot.activeLayerId === layerId) {
      slot.activeLayerId = slot.layers[Math.max(0, idx - 1)].id;
    }
    this.compositeSlot(slotKey);
    return true;
  }

  snapshotSlot(slotKey) {
    const slot = this.slots.get(slotKey);
    if (!slot) return null;
    return {
      width: slot.width,
      height: slot.height,
      activeLayerId: slot.activeLayerId,
      layers: slot.layers.map((l) => l.snapshot()),
    };
  }

  restoreSlotSnapshot(slotKey, snap) {
    if (!snap) return;
    const slot = this.ensureSlot(slotKey, snap.width, snap.height);
    slot.layers = snap.layers.map((s) => new PaintLayer(s.name, s.width, s.height, {
      id: s.id,
      visible: s.visible,
      opacity: s.opacity,
      blendMode: s.blendMode,
      bytes: s.bytes,
    }));
    slot.activeLayerId = snap.activeLayerId;
    this.compositeSlot(slotKey);
  }

  /**
   * Composites visible layers in the slot into `slot.composite` and flags `slot.texture.needsUpdate = true`.
   */
  compositeSlot(slotKey = 'baseColor') {
    const slot = this.slots.get(slotKey);
    if (!slot) return null;
    const out = slot.composite.data;
    const spec = PAINT_SLOTS[slotKey] || PAINT_SLOTS.baseColor;
    const [dr, dg, db, da] = spec.defaultRgba;
    const nPix = slot.width * slot.height;

    // Seed with base spec color at alpha 255
    for (let i = 0; i < nPix * 4; i += 4) {
      out[i] = dr;
      out[i + 1] = dg;
      out[i + 2] = db;
      out[i + 3] = da;
    }

    for (const layer of slot.layers) {
      if (!layer.visible || layer.opacity <= 0) continue;
      const src = layer.data;
      const op = layer.opacity;
      const mode = layer.blendMode;
      for (let i = 0; i < nPix * 4; i += 4) {
        const sa = (src[i + 3] / 255) * op;
        if (sa <= 0) continue;
        const sr = src[i];
        const sg = src[i + 1];
        const sb = src[i + 2];
        const br = out[i];
        const bg = out[i + 1];
        const bb = out[i + 2];
        let rr = sr, rg = sg, rb = sb;
        if (mode === 'multiply') {
          rr = (br * sr) / 255;
          rg = (bg * sg) / 255;
          rb = (bb * sb) / 255;
        } else if (mode === 'add') {
          rr = Math.min(255, br + sr);
          rg = Math.min(255, bg + sg);
          rb = Math.min(255, bb + sb);
        }
        out[i] = clampU8(br + (rr - br) * sa);
        out[i + 1] = clampU8(bg + (rg - bg) * sa);
        out[i + 2] = clampU8(bb + (rb - bb) * sa);
        out[i + 3] = 255;
      }
    }

    slot.composite.syncToCanvas();
    if (slot.texture) {
      if (slot.texture.isDataTexture && slot.texture.image) {
        slot.texture.image.data = out;
      }
      slot.texture.needsUpdate = true;
    }
    return slot.texture;
  }

  /**
   * Captures baked or painted RGBA8 buffer into an active/new layer on `slotKey`.
   */
  applyRawRgbaToSlot(slotKey, rgba, width, height, layerName = 'Baked Map') {
    const slot = this.ensureSlot(slotKey, width, height);
    if (slot.width !== width || slot.height !== height) {
      // Resize slot backing cleanly to match bake target resolution
      slot.width = width;
      slot.height = height;
      slot.composite = new PixelSurface(width, height, PAINT_SLOTS[slotKey]?.defaultRgba);
      const tex = this._createTextureFromSurface(slot.composite, slot.srgb);
      if (this.material) {
        const spec = PAINT_SLOTS[slotKey] || PAINT_SLOTS.baseColor;
        slot.texture?.dispose?.();
        slot.texture = tex;
        this.material[spec.mapKey] = tex;
        this.material.needsUpdate = true;
      } else {
        slot.texture = tex;
      }
      slot.layers = [];
    }
    const existing = slot.layers.find((l) => l.name === layerName);
    if (existing && existing.width === width && existing.height === height) {
      existing.surface.setBytes(rgba);
      slot.activeLayerId = existing.id;
    } else {
      const layer = new PaintLayer(layerName, width, height, { bytes: rgba });
      slot.layers.push(layer);
      slot.activeLayerId = layer.id;
    }
    this.compositeSlot(slotKey);
    this._registerImageDataBlock(slotKey, slot);
    return slot;
  }

  toJSONSync() {
    const resolved = new Map();
    for (const [key, slot] of this.slots.entries()) {
      resolved.set(key, slot.layers.map((layer) => {
        const bytes = new Uint8Array(layer.data.buffer, layer.data.byteOffset, layer.data.byteLength);
        return { b64: bytesToB64(bytes) };
      }));
    }
    return encodeSlotsWithResolvedPayloads(this.slots, resolved);
  }

  async toJSON(putBlobFn = null) {
    if (typeof putBlobFn !== 'function') return this.toJSONSync();
    const resolved = new Map();
    for (const [key, slot] of this.slots.entries()) {
      const payloads = [];
      for (const layer of slot.layers) {
        const bytes = new Uint8Array(layer.data.buffer, layer.data.byteOffset, layer.data.byteLength);
        const res = await putBlobFn(bytes, { mime: 'application/octet-stream', kind: `paint_${key}` });
        payloads.push({ __blobRef: typeof res === 'string' ? res : res.ref, byteLength: bytes.byteLength });
      }
      resolved.set(key, payloads);
    }
    return encodeSlotsWithResolvedPayloads(this.slots, resolved);
  }

  static fromJSONSync(material, data, options = {}) {
    const decoded = new Map();
    if (data && typeof data === 'object') {
      for (const [slotKey, slotData] of Object.entries(data)) {
        if (!slotData || !Array.isArray(slotData.layers)) continue;
        slotData.layers.forEach((l, idx) => {
          if (l.pixels?.b64) decoded.set(`${slotKey}:${idx}`, b64ToBytes(l.pixels.b64));
        });
      }
    }
    return buildStackFromDecodedSlots(material, data, decoded, options);
  }

  static async fromJSON(material, data, getBlobFn = null, options = {}) {
    const decoded = new Map();
    if (data && typeof data === 'object') {
      for (const [slotKey, slotData] of Object.entries(data)) {
        if (!slotData || !Array.isArray(slotData.layers)) continue;
        for (let idx = 0; idx < slotData.layers.length; idx++) {
          const l = slotData.layers[idx];
          if (l.pixels?.__blobRef && typeof getBlobFn === 'function') {
            const raw = await getBlobFn(l.pixels.__blobRef);
            if (raw) decoded.set(`${slotKey}:${idx}`, new Uint8ClampedArray(raw.buffer, raw.byteOffset, raw.byteLength));
          } else if (l.pixels?.b64) {
            decoded.set(`${slotKey}:${idx}`, b64ToBytes(l.pixels.b64));
          }
        }
      }
    }
    return buildStackFromDecodedSlots(material, data, decoded, options);
  }
}

function bytesToB64(bytes) {
  if (typeof btoa === 'function') {
    let bin = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      bin += String.fromCharCode(...bytes.subarray(i, Math.min(i + chunk, bytes.length)));
    }
    return btoa(bin);
  }
  return Buffer.from(bytes).toString('base64');
}

function b64ToBytes(b64) {
  if (typeof atob === 'function') {
    const bin = atob(b64);
    const out = new Uint8ClampedArray(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  return new Uint8ClampedArray(Buffer.from(b64, 'base64'));
}

function encodeSlotsWithResolvedPayloads(slots, resolvedPayloads) {
  const serializedSlots = {};
  for (const [key, slot] of slots.entries()) {
    const payloads = resolvedPayloads.get(key) || [];
    serializedSlots[key] = {
      width: slot.width,
      height: slot.height,
      activeLayerId: slot.activeLayerId,
      layers: slot.layers.map((layer, idx) => ({
        id: layer.id,
        name: layer.name,
        visible: layer.visible,
        opacity: layer.opacity,
        blendMode: layer.blendMode,
        width: layer.width,
        height: layer.height,
        pixels: payloads[idx],
      })),
    };
  }
  return serializedSlots;
}

function buildStackFromDecodedSlots(material, data, decodedBytesByLayer, options = {}) {
  const stack = new PaintLayerStack(material, options);
  if (!data || typeof data !== 'object') return stack;
  for (const [slotKey, slotData] of Object.entries(data)) {
    if (!slotData || !Array.isArray(slotData.layers) || slotData.layers.length === 0) continue;
    const spec = PAINT_SLOTS[slotKey] || PAINT_SLOTS.baseColor;
    const w = slotData.width || 1024;
    const h = slotData.height || 1024;
    const composite = new PixelSurface(w, h, spec.defaultRgba);
    const layers = slotData.layers.map((l, idx) => new PaintLayer(l.name, l.width || w, l.height || h, {
      id: l.id,
      visible: l.visible,
      opacity: l.opacity,
      blendMode: l.blendMode,
      bytes: decodedBytesByLayer.get(`${slotKey}:${idx}`) || null,
    }));
    const texture = stack._createTextureFromSurface(composite, spec.srgb);
    stack.slots.set(slotKey, {
      key: slotKey,
      width: w,
      height: h,
      layers,
      activeLayerId: slotData.activeLayerId || layers[layers.length - 1].id,
      composite,
      texture,
      srgb: spec.srgb,
    });
    if (material) {
      material[spec.mapKey] = texture;
      material.needsUpdate = true;
    }
    stack.compositeSlot(slotKey);
  }
  return stack;
}

function collectStacksMapFromRoot(root) {
  const out = {};
  if (!root) return out;
  const seen = new Set();
  root.traverse((obj) => {
    if (!obj.isMesh || !obj.material) return;
    const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
    for (const mat of mats) {
      if (!mat || seen.has(mat.uuid)) continue;
      seen.add(mat.uuid);
      const stack = getPaintLayerStack(mat);
      if (stack && stack.slots.size > 0) out[mat.uuid] = stack;
    }
  });
  return out;
}

function mapMaterialsByUuid(root) {
  const byMatUuid = new Map();
  root?.traverse?.((obj) => {
    if (!obj.isMesh || !obj.material) return;
    const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
    for (const mat of mats) {
      if (mat) byMatUuid.set(mat.uuid, mat);
    }
  });
  return byMatUuid;
}

/**
 * Retrieves an existing PaintLayerStack for a material without creating one.
 */
export function getPaintLayerStack(material) {
  if (!material) return null;
  return STACK_BY_MATERIAL.get(material) || null;
}

/**
 * Retrieves or creates the PaintLayerStack attached to a material.
 */
export function ensurePaintLayerStack(material, options = {}) {
  if (!material) return null;
  const existing = STACK_BY_MATERIAL.get(material);
  if (existing instanceof PaintLayerStack) {
    return existing;
  }
  return new PaintLayerStack(material, options);
}

export function serializeScenePaintStacksSync(root) {
  const out = collectStacksMapFromRoot(root);
  const encoded = {};
  for (const [uuid, stack] of Object.entries(out)) {
    encoded[uuid] = stack.toJSONSync();
  }
  return encoded;
}

export async function serializeScenePaintStacks(root, putBlobFn = null) {
  const out = collectStacksMapFromRoot(root);
  const encoded = {};
  for (const [uuid, stack] of Object.entries(out)) {
    encoded[uuid] = await stack.toJSON(putBlobFn);
  }
  return encoded;
}

export function restoreScenePaintStacksSync(root, paintStacksMap, options = {}) {
  if (!root || !paintStacksMap || typeof paintStacksMap !== 'object') return 0;
  const byMatUuid = mapMaterialsByUuid(root);
  let restored = 0;
  for (const [uuid, stackData] of Object.entries(paintStacksMap)) {
    const mat = byMatUuid.get(uuid);
    if (!mat) continue;
    PaintLayerStack.fromJSONSync(mat, stackData, options);
    restored++;
  }
  return restored;
}

export async function restoreScenePaintStacks(root, paintStacksMap, getBlobFn = null, options = {}) {
  if (!root || !paintStacksMap || typeof paintStacksMap !== 'object') return 0;
  const byMatUuid = mapMaterialsByUuid(root);
  let restored = 0;
  for (const [uuid, stackData] of Object.entries(paintStacksMap)) {
    const mat = byMatUuid.get(uuid);
    if (!mat) continue;
    await PaintLayerStack.fromJSON(mat, stackData, getBlobFn, options);
    restored++;
  }
  return restored;
}
