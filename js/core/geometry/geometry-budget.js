/**
 * Phase-1 geometry pipeline — budget kernel (PURE: no THREE, no DOM).
 *
 * Deterministic pre-flight checks so heavy geometry tasks are rejected BEFORE
 * any large allocation happens (main thread or Worker). Operates on the plain
 * encoded objects from geometry-codec.js; triangleCount also accepts a raw
 * BufferGeometry duck-type ({attributes:{position:{count}}, index:{count}})
 * without importing THREE.
 */

export const DEFAULT_GEOMETRY_BUDGET = Object.freeze({
  maxInputTriangles: 250000,
  maxOutputTriangles: 500000,
  maxTaskBytes: 128 * 1024 * 1024,
  maxInteractiveMs: 10000,
  maxBakeMs: 30000,
  previewTriangles: 80000
});

/**
 * Number of triangles in an encoded object (or BufferGeometry duck-type).
 * @param {object} encodedOrGeometry
 * @returns {number}
 */
export function triangleCount(encodedOrGeometry) {
  const g = encodedOrGeometry;
  if (!g) return 0;
  let vertexCount = 0;
  let indexCount = null;
  if (g.attributes && g.attributes.position) {
    // Raw THREE.BufferGeometry duck-type (no import needed).
    vertexCount = g.attributes.position.count;
    indexCount = g.index ? g.index.count : null;
  } else if (g.position) {
    const itemSize = (g.itemSizes && g.itemSizes.position) || 3;
    vertexCount = Math.floor(g.position.length / itemSize);
    indexCount = g.index ? g.index.length : null;
  } else {
    return 0;
  }
  const elements = indexCount !== null ? indexCount : vertexCount;
  return Math.floor(elements / 3);
}

function intParam(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.floor(n));
}

/**
 * Reads a modifier parameter from the real descriptor shape
 * `{ type, params: {...} }`, falling back to a flat `descriptor[key]`.
 * @param {object} descriptor
 * @param {object} params
 * @param {string} key
 */
function descriptorParam(descriptor, params, key) {
  if (params && params[key] !== undefined) return params[key];
  return descriptor ? descriptor[key] : undefined;
}

/**
 * Conservative growth factor for a single modifier descriptor
 * `{ type, params: {...} }`. Unknown types are treated as x1.
 * @param {object} descriptor
 * @returns {number}
 */
function growthFactor(descriptor) {
  const type = String((descriptor && descriptor.type) || '').toLowerCase();
  const params = (descriptor && descriptor.params) || {};
  switch (type) {
    case 'array':
      return Math.max(1, intParam(descriptorParam(descriptor, params, 'count'), 1));
    case 'mirror':
      return 2;
    case 'wireframe':
      // Conservative: every triangle edge can become a quad (2 tris) plus caps.
      return 6;
    case 'subdivide':
    case 'subdivision':
    case 'subsurf': {
      const levels = intParam(
        descriptorParam(descriptor, params, 'subdivisions') !== undefined
          ? descriptorParam(descriptor, params, 'subdivisions')
          : (descriptorParam(descriptor, params, 'levels') !== undefined
            ? descriptorParam(descriptor, params, 'levels')
            : descriptorParam(descriptor, params, 'level')),
        1
      );
      return Math.pow(4, levels);
    }
    case 'bevel': {
      const segments = intParam(descriptorParam(descriptor, params, 'segments'), 1);
      return segments + 1;
    }
    case 'solidify':
      return 2;
    case 'boolean':
    case 'bool':
      return 2;
    case 'decimate':
      return Math.min(1, Math.max(0.05, Number(descriptorParam(descriptor, params, 'ratio')) || 0.5));
    case 'screw':
    case 'lathe': {
      const steps = Math.max(3, intParam(descriptorParam(descriptor, params, 'steps'), 16));
      const iters = Math.max(1, intParam(descriptorParam(descriptor, params, 'iterations'), 1));
      return Math.max(1, Math.min(64, steps * iters));
    }
    case 'weighted_normal':
    case 'weightednormal':
    case 'displace':
    case 'smooth':
    case 'randomize':
      return 1;
    default:
      return 1;
  }
}

/**
 * Predict output triangle count after applying an ordered list of modifier
 * descriptors. Pure and deterministic.
 * @param {number} inputTriangles
 * @param {Array<object>} descriptors
 * @returns {number}
 */
export function estimateStackOutput(inputTriangles, descriptors) {
  let predicted = Math.max(0, Number(inputTriangles) || 0);
  for (const descriptor of descriptors || []) {
    predicted *= growthFactor(descriptor);
    // Clamp to a finite safe value; the budget check will reject anything huge.
    if (!Number.isFinite(predicted) || predicted > Number.MAX_SAFE_INTEGER) {
      return Number.MAX_SAFE_INTEGER;
    }
  }
  return Math.ceil(predicted);
}

/**
 * Total byteLength of the typed arrays in an encoded object.
 * @param {object} encoded
 * @returns {number}
 */
export function estimateBytes(encoded) {
  if (!encoded) return 0;
  let bytes = 0;
  const seen = new Set();
  for (const key of ['position', 'normal', 'uv', 'color', 'index']) {
    const array = encoded[key];
    if (array && array.byteLength && !seen.has(array.buffer || array)) {
      seen.add(array.buffer || array);
      bytes += array.byteLength;
    }
  }
  return bytes;
}

/**
 * Pre-flight budget check. Rejects BEFORE allocation when any hard limit is
 * exceeded. Pure and deterministic.
 * @param {{inputTriangles?:number, encoded?:object, descriptors?:Array<object>,
 *          mode?:'interactive'|'bake'|'preview', budget?:object, inputBytes?:number}} options
 * @returns {{ok:true, predictedTriangles:number, predictedBytes:number} |
 *           {ok:false, reason:string, predictedTriangles:number, predictedBytes:number}}
 */
export function checkBudget(options = {}) {
  const budget = Object.assign({}, DEFAULT_GEOMETRY_BUDGET, options.budget || {});
  const mode = options.mode || 'interactive';
  const inputTriangles = options.inputTriangles !== undefined
    ? Math.max(0, Math.floor(Number(options.inputTriangles) || 0))
    : triangleCount(options.encoded);
  const predictedTriangles = estimateStackOutput(inputTriangles, options.descriptors);
  const predictedBytes = options.inputBytes !== undefined
    ? Math.max(0, Number(options.inputBytes) || 0)
    : estimateBytes(options.encoded);

  if (inputTriangles > budget.maxInputTriangles) {
    return {
      ok: false,
      reason: `input triangles ${inputTriangles} exceed maxInputTriangles ${budget.maxInputTriangles}`,
      predictedTriangles,
      predictedBytes
    };
  }
  if (predictedBytes > budget.maxTaskBytes) {
    return {
      ok: false,
      reason: `task bytes ${predictedBytes} exceed maxTaskBytes ${budget.maxTaskBytes}`,
      predictedTriangles,
      predictedBytes
    };
  }
  if (predictedTriangles > budget.maxOutputTriangles) {
    return {
      ok: false,
      reason: `predicted output triangles ${predictedTriangles} exceed maxOutputTriangles ${budget.maxOutputTriangles}`,
      predictedTriangles,
      predictedBytes
    };
  }
  if (mode === 'preview' && predictedTriangles > budget.previewTriangles) {
    return {
      ok: false,
      reason: `preview triangles ${predictedTriangles} exceed previewTriangles ${budget.previewTriangles}`,
      predictedTriangles,
      predictedBytes
    };
  }
  return { ok: true, predictedTriangles, predictedBytes };
}