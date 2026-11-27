/**
 * Phase-1 geometry pipeline — codec (DOM-free, Worker-safe).
 *
 * Converts a THREE.BufferGeometry into a plain, transferable encoded object
 * of typed arrays, and back. All arrays are copied (slice) so the caller's
 * buffers are never detached or aliased. morphAttributes are ignored in v1.
 *
 * Only this module may import THREE; budget/topology kernels operate on the
 * plain encoded shape produced here.
 */
import * as THREE from 'three';

const ATTRIBUTES = ['position', 'normal', 'uv', 'uv1', 'color'];

/**
 * Copy a BufferAttribute's array into a fresh typed array of the same type.
 * Returns null when the attribute is missing.
 * @param {THREE.BufferAttribute|THREE.InterleavedBufferAttribute|undefined} attr
 */
function copyAttributeArray(attr) {
  if (!attr) return null;
  // Interleaved attributes: de-interleave into a dense array.
  // InterleavedBuffer has no `offset`; the per-element byte offset lives on the
  // InterleavedBufferAttribute (attr.offset) and the stride on attr.data.stride.
  if (attr.isInterleavedBufferAttribute) {
    const count = attr.count;
    const itemSize = attr.itemSize;
    const Ctor = attr.data.array.constructor;
    const out = new Ctor(count * itemSize);
    for (let i = 0; i < count; i++) {
      const base = i * attr.data.stride + attr.offset;
      for (let j = 0; j < itemSize; j++) {
        out[i * itemSize + j] = attr.data.array[base + j];
      }
    }
    return out;
  }
  return attr.array.slice();
}

/**
 * Encode a BufferGeometry into a plain transferable object.
 * @param {THREE.BufferGeometry} geometry
 * @returns {{
 *   position: Float32Array,
 *   normal: Float32Array|null,
 *   uv: Float32Array|null,
 *   color: Float32Array|null,
 *   index: Uint32Array|null,
 *   itemSizes: {position:number, normal:number|null, uv:number|null, color:number|null},
 *   groups: Array<{start:number,count:number,materialIndex:number}>,
 *   drawRange: {start:number,count:number},
 *   name: string
 * }}
 */
export function encodeGeometry(geometry) {
  if (!geometry || !geometry.isBufferGeometry) {
    throw new TypeError('encodeGeometry: expected a THREE.BufferGeometry');
  }
  const attrs = geometry.attributes || {};
  const position = copyAttributeArray(attrs.position);
  if (!position) throw new Error('encodeGeometry: geometry has no position attribute');

  const encoded = {
    position,
    normal: copyAttributeArray(attrs.normal),
    uv: copyAttributeArray(attrs.uv),
    uv1: copyAttributeArray(attrs.uv1),
    color: copyAttributeArray(attrs.color),
    index: geometry.index ? new Uint32Array(geometry.index.array) : null,
    itemSizes: {
      position: attrs.position.itemSize,
      normal: attrs.normal ? attrs.normal.itemSize : null,
      uv: attrs.uv ? attrs.uv.itemSize : null,
      uv1: attrs.uv1 ? attrs.uv1.itemSize : null,
      color: attrs.color ? attrs.color.itemSize : null
    },
    groups: (geometry.groups || []).map((g) => ({
      start: g.start,
      count: g.count,
      materialIndex: g.materialIndex || 0
    })),
    drawRange: {
      start: geometry.drawRange ? geometry.drawRange.start : 0,
      count: geometry.drawRange ? geometry.drawRange.count : Infinity
    },
    name: geometry.name || '',
    uvMeta: geometry.userData ? {
      _uvSeams: Array.isArray(geometry.userData._uvSeams) ? [...geometry.userData._uvSeams] : null,
      _uvPinned: geometry.userData._uvPinned ? JSON.parse(JSON.stringify(geometry.userData._uvPinned)) : null,
      _looseEdges: Array.isArray(geometry.userData._looseEdges) ? JSON.parse(JSON.stringify(geometry.userData._looseEdges)) : null,
    } : null,
  };
  return encoded;
}

/**
 * JSON.stringify turns a typed array into {"0":…,"1":…} (project files pass
 * through JSON), so accept array-likes as well as ArrayBuffer views.
 * @returns {number[]|null}
 */
function denseArrayLike(value) {
  if (Array.isArray(value) || ArrayBuffer.isView(value)) return value;
  if (!value || typeof value !== 'object') return null;
  let length = 0;
  for (const key in value) {
    const index = Number(key);
    if (Number.isInteger(index) && index >= 0 && index + 1 > length) length = index + 1;
  }
  if (!length) return null;
  const out = new Array(length);
  for (let i = 0; i < length; i++) {
    const n = Number(value[i]);
    out[i] = Number.isFinite(n) ? n : 0;
  }
  return out;
}

/**
 * Decode an encoded object back into a new THREE.BufferGeometry.
 * Bounding box/sphere are NOT computed — the caller decides when to do that.
 * @param {object} encoded
 * @returns {THREE.BufferGeometry}
 */
export function decodeGeometry(encoded) {
  if (!encoded || !encoded.position) {
    throw new TypeError('decodeGeometry: encoded object has no position array');
  }
  const geometry = new THREE.BufferGeometry();
  const sizes = encoded.itemSizes || {};
  const defaults = { position: 3, normal: 3, uv: 2, uv1: 2, color: 4 };

  for (const key of ATTRIBUTES) {
    const raw = denseArrayLike(encoded[key]);
    if (!raw) continue;
    const itemSize = sizes[key] || defaults[key];
    // Copy again so the decoded geometry never aliases the encoded buffers
    // (which may be transferred/detached by the caller afterwards). Keep the
    // original typed-array type; JSON-decoded values fall back to Float32.
    const array = ArrayBuffer.isView(raw) ? raw.slice() : Float32Array.from(raw);
    geometry.setAttribute(key, new THREE.BufferAttribute(array, itemSize));
  }

  if (encoded.index) {
    const index = denseArrayLike(encoded.index);
    if (index) geometry.setIndex(new THREE.BufferAttribute(new Uint32Array(index), 1));
  }
  for (const g of encoded.groups || []) {
    geometry.addGroup(g.start, g.count, g.materialIndex || 0);
  }
  if (encoded.drawRange) {
    const start = Number.isFinite(encoded.drawRange.start) && encoded.drawRange.start >= 0
      ? encoded.drawRange.start
      : 0;
    const rawCount = encoded.drawRange.count;
    const count = (rawCount === null || rawCount === undefined || !Number.isFinite(Number(rawCount)))
      ? Infinity
      : Math.max(0, Number(rawCount));
    geometry.setDrawRange(start, count);
  } else {
    geometry.setDrawRange(0, Infinity);
  }
  geometry.name = encoded.name || '';
  if (encoded.uvMeta) {
    geometry.userData = geometry.userData || {};
    if (Array.isArray(encoded.uvMeta._uvSeams)) geometry.userData._uvSeams = [...encoded.uvMeta._uvSeams];
    if (encoded.uvMeta._uvPinned && typeof encoded.uvMeta._uvPinned === 'object') {
      geometry.userData._uvPinned = JSON.parse(JSON.stringify(encoded.uvMeta._uvPinned));
    }
    if (Array.isArray(encoded.uvMeta._looseEdges)) {
      geometry.userData._looseEdges = JSON.parse(JSON.stringify(encoded.uvMeta._looseEdges));
    }
  }
  return geometry;
}

/**
 * Collect the unique underlying ArrayBuffers of an encoded object for
 * postMessage transfer lists.
 * @param {object} encoded
 * @returns {ArrayBuffer[]}
 */
export function transferables(encoded) {
  const buffers = [];
  const seen = new Set();
  if (!encoded) return buffers;
  for (const key of ATTRIBUTES.concat('index')) {
    const array = encoded[key];
    if (array && array.buffer && !seen.has(array.buffer)) {
      seen.add(array.buffer);
      buffers.push(array.buffer);
    }
  }
  return buffers;
}