/**
 * @file mesh-kernel-bridge.js
 * @description High-performance WebAssembly bridge connecting Three.js BufferGeometry
 * to the Rust Mesh Kernel for fast vertex welding, half-edge topology, and subdivision.
 * Works both in the main browser thread, inside Web Workers, and in Node.js test runners.
 */

let wasmInstance = null;
let wasmExports = null;
let isInitializing = false;
let initPromise = null;

/**
 * Initializes the Rust Mesh Kernel WASM module.
 * @param {string|ArrayBuffer} [wasmSource] URL, relative path, or ArrayBuffer of the .wasm file.
 * @returns {Promise<boolean>} True if initialized successfully, false otherwise.
 */
export async function initMeshKernel(wasmSource = null) {
  if (wasmExports) return true;
  if (isInitializing) return initPromise;

  isInitializing = true;
  initPromise = (async () => {
    try {
      let bytes = null;

      if (wasmSource instanceof ArrayBuffer || wasmSource instanceof Uint8Array) {
        bytes = wasmSource;
      } else if (typeof process !== 'undefined' && process.versions && process.versions.node) {
        // Node.js environment (for tests)
        const fs = await import('fs');
        const path = await import('path');
        const defaultPath = path.resolve(process.cwd(), 'vendor/wasm/mesh_kernel.wasm');
        const targetPath = typeof wasmSource === 'string' ? wasmSource : defaultPath;
        bytes = fs.readFileSync(targetPath);
      } else {
        // Browser / Web Worker environment
        const defaultUrl = new URL('../../vendor/wasm/mesh_kernel.wasm', import.meta.url).href;
        const targetUrl = typeof wasmSource === 'string' ? wasmSource : defaultUrl;
        const response = await fetch(targetUrl);
        if (!response.ok) throw new Error(`HTTP ${response.status} loading ${targetUrl}`);
        bytes = await response.arrayBuffer();
      }

      const { instance } = await WebAssembly.instantiate(bytes, {});
      wasmInstance = instance;
      wasmExports = instance.exports;

      const version = wasmExports.mesh_kernel_version ? wasmExports.mesh_kernel_version() : 0;
      console.log(`[MeshKernel] Rust WASM Kernel initialized (version: ${version})`);
      if (typeof globalThis !== 'undefined') {
        globalThis.__WBS_MESH_KERNEL_QEM__ = simplifyMeshQEMInWasm;
      }
      return true;
    } catch (err) {
      console.warn('[MeshKernel] Failed to initialize Rust WASM Kernel; falling back to JS:', err.message);
      wasmExports = null;
      wasmInstance = null;
      return false;
    } finally {
      isInitializing = false;
    }
  })();

  return initPromise;
}

/**
 * Checks if the Rust WASM kernel is loaded and ready.
 * @returns {boolean}
 */
export function isMeshKernelReady() {
  return wasmExports !== null;
}

export function getMeshKernelVersion() {
  return wasmExports && typeof wasmExports.mesh_kernel_version === 'function'
    ? (wasmExports.mesh_kernel_version() >>> 0)
    : 0;
}

/**
 * Welds vertices within tolerance and extracts unique edges and clean index buffer in Rust WASM.
 * @param {Float32Array} positions Contiguous x, y, z vertex coordinates
 * @param {Uint32Array|Uint16Array|null} [indices] Triangle indices (null if non-indexed)
 * @param {number} [tolerance=0.0001] Spatial welding distance threshold
 * @returns {{
 *   vertices: Float32Array,
 *   indices: Uint32Array,
 *   edges: Uint32Array,
 *   normals: Float32Array,
 *   map: Uint32Array
 * }|null}
 */
export function weldAndExtractTopology(positions, indices = null, tolerance = 0.0001) {
  if (!wasmExports) return null;
  if (!positions || positions.length < 3) return null;

  const posBytes = positions.byteLength;
  const posPtr = wasmExports.mesh_kernel_alloc(posBytes);
  if (!posPtr) return null;

  const memoryBuffer = wasmExports.memory.buffer;
  new Float32Array(memoryBuffer, posPtr, positions.length).set(positions);

  let indexPtr = 0;
  let indexLen = 0;
  let indexBytes = 0;

  if (indices && indices.length >= 3) {
    indexLen = indices.length;
    indexBytes = indexLen * 4;
    indexPtr = wasmExports.mesh_kernel_alloc(indexBytes);
    if (!indexPtr) {
      wasmExports.mesh_kernel_free(posPtr, posBytes);
      return null;
    }
    const idxTarget = new Uint32Array(wasmExports.memory.buffer, indexPtr, indexLen);
    if (indices instanceof Uint32Array) {
      idxTarget.set(indices);
    } else {
      for (let i = 0; i < indexLen; i++) idxTarget[i] = indices[i];
    }
  }

  const ok = wasmExports.mesh_kernel_weld(posPtr, positions.length, indexPtr, indexLen, tolerance);

  // Free input buffers immediately
  wasmExports.mesh_kernel_free(posPtr, posBytes);
  if (indexPtr) wasmExports.mesh_kernel_free(indexPtr, indexBytes);

  if (!ok) return null;

  // Read output buffers from WASM linear memory
  const mem = wasmExports.memory.buffer;

  const outVertsPtr = wasmExports.mesh_kernel_get_out_vertices_ptr();
  const outVertsLen = wasmExports.mesh_kernel_get_out_vertices_len();
  const vertices = new Float32Array(mem, outVertsPtr, outVertsLen).slice();

  const outIdxPtr = wasmExports.mesh_kernel_get_out_indices_ptr();
  const outIdxLen = wasmExports.mesh_kernel_get_out_indices_len();
  const outIndices = new Uint32Array(mem, outIdxPtr, outIdxLen).slice();

  const outEdgesPtr = wasmExports.mesh_kernel_get_out_edges_ptr();
  const outEdgesLen = wasmExports.mesh_kernel_get_out_edges_len();
  const edges = new Uint32Array(mem, outEdgesPtr, outEdgesLen).slice();

  const outNormalsPtr = wasmExports.mesh_kernel_get_out_normals_ptr();
  const outNormalsLen = wasmExports.mesh_kernel_get_out_normals_len();
  const normals = new Float32Array(mem, outNormalsPtr, outNormalsLen).slice();

  const outMapPtr = wasmExports.mesh_kernel_get_out_map_ptr();
  const outMapLen = wasmExports.mesh_kernel_get_out_map_len();
  const map = new Uint32Array(mem, outMapPtr, outMapLen).slice();

  return {
    vertices,
    indices: outIndices,
    edges,
    normals,
    map
  };
}

/**
 * Subdivides a mesh in Rust WASM (splits each triangle into 4).
 * @param {Float32Array} positions
 * @param {Uint32Array|Uint16Array} indices
 * @param {boolean} [smooth=false] If true, applies Laplacian smoothing
 * @returns {{
 *   vertices: Float32Array,
 *   indices: Uint32Array,
 *   edges: Uint32Array
 * }|null}
 */
export function subdivideMesh(positions, indices, smooth = false) {
  if (!wasmExports) return null;
  if (!positions || positions.length < 3 || !indices || indices.length < 3) return null;

  const posBytes = positions.byteLength;
  const posPtr = wasmExports.mesh_kernel_alloc(posBytes);
  if (!posPtr) return null;

  new Float32Array(wasmExports.memory.buffer, posPtr, positions.length).set(positions);

  const indexLen = indices.length;
  const indexBytes = indexLen * 4;
  const indexPtr = wasmExports.mesh_kernel_alloc(indexBytes);
  if (!indexPtr) {
    wasmExports.mesh_kernel_free(posPtr, posBytes);
    return null;
  }

  const idxTarget = new Uint32Array(wasmExports.memory.buffer, indexPtr, indexLen);
  if (indices instanceof Uint32Array) {
    idxTarget.set(indices);
  } else {
    for (let i = 0; i < indexLen; i++) idxTarget[i] = indices[i];
  }

  const ok = wasmExports.mesh_kernel_subdivide(posPtr, positions.length, indexPtr, indexLen, smooth ? 1 : 0);

  wasmExports.mesh_kernel_free(posPtr, posBytes);
  wasmExports.mesh_kernel_free(indexPtr, indexBytes);

  if (!ok) return null;

  const mem = wasmExports.memory.buffer;

  const outVertsPtr = wasmExports.mesh_kernel_get_out_vertices_ptr();
  const outVertsLen = wasmExports.mesh_kernel_get_out_vertices_len();
  const vertices = new Float32Array(mem, outVertsPtr, outVertsLen).slice();

  const outIdxPtr = wasmExports.mesh_kernel_get_out_indices_ptr();
  const outIdxLen = wasmExports.mesh_kernel_get_out_indices_len();
  const outIndices = new Uint32Array(mem, outIdxPtr, outIdxLen).slice();

  const outEdgesPtr = wasmExports.mesh_kernel_get_out_edges_ptr();
  const outEdgesLen = wasmExports.mesh_kernel_get_out_edges_len();
  const edges = new Uint32Array(mem, outEdgesPtr, outEdgesLen).slice();

  return {
    vertices,
    indices: outIndices,
    edges
  };
}

/**
 * Mapping from SculptMode brush names to Rust kernel `brush_id` integers.
 */
export const SCULPT_BRUSH_IDS = Object.freeze({
  draw: 0,
  grab: 1,
  inflate: 2,
  smooth: 3,
  flatten: 4,
  clay: 5,
  pinch: 6,
  crease: 7,
  snake_hook: 8,
  mask: 9
});

/**
 * Execute a Sculpt Mode 2.0 brush stroke in Rust WASM on `positions` (and `mask` when painting masks).
 * Mutates `positions` (and `mask` when brush is `'mask'`) in-place and returns the count of modified
 * vertices, or `null` if the WASM kernel is not initialized or inputs are invalid.
 *
 * @param {object} params
 * @param {Float32Array} params.positions
 * @param {Float32Array|null} [params.normals]
 * @param {Float32Array|null} [params.mask]
 * @param {Float32Array|null} [params.basePositions]
 * @param {Uint32Array|Int32Array|number[]|null} [params.candidates]
 * @param {string|number} [params.brush='draw']
 * @param {number[]|{x:number,y:number,z:number}} params.center
 * @param {number[]|{x:number,y:number,z:number}} [params.normal]
 * @param {number[]|{x:number,y:number,z:number}} [params.delta]
 * @param {number} [params.radius=0.4]
 * @param {number} [params.strength=0.5]
 * @param {number} [params.dir=1]
 * @returns {number|null}
 */
export function sculptStrokeInWasm({
  positions,
  normals = null,
  mask = null,
  basePositions = null,
  candidates = null,
  brush = 'draw',
  center,
  normal = [0, 1, 0],
  delta = [0, 0, 0],
  radius = 0.4,
  strength = 0.5,
  dir = 1.0
}) {
  if (!wasmExports || !positions || positions.length < 3) return null;
  if (typeof wasmExports.mesh_kernel_sculpt_stroke !== 'function') return null;

  const brushId = typeof brush === 'number'
    ? brush
    : (SCULPT_BRUSH_IDS[brush] ?? 0);

  const vertCount = (positions.length / 3) | 0;
  if (vertCount === 0) return 0;

  const posArr = positions instanceof Float32Array ? positions : new Float32Array(positions);
  const posBytes = posArr.byteLength;
  const normBytes = normals && normals.length >= posArr.length ? posArr.length * 4 : 0;
  const maskBytes = mask && mask.length >= vertCount ? vertCount * 4 : 0;
  const baseBytes = basePositions && basePositions.length >= posArr.length ? posArr.length * 4 : 0;

  let candArr = null;
  if (candidates && candidates.length > 0) {
    candArr = candidates instanceof Uint32Array ? candidates : new Uint32Array(candidates);
  }
  const candBytes = candArr ? candArr.byteLength : 0;

  let posPtr = 0;
  let normPtr = 0;
  let maskPtr = 0;
  let basePtr = 0;
  let candPtr = 0;

  try {
    posPtr = wasmExports.mesh_kernel_alloc(posBytes);
    normPtr = normBytes ? wasmExports.mesh_kernel_alloc(normBytes) : 0;
    maskPtr = maskBytes ? wasmExports.mesh_kernel_alloc(maskBytes) : 0;
    basePtr = baseBytes ? wasmExports.mesh_kernel_alloc(baseBytes) : 0;
    candPtr = candBytes ? wasmExports.mesh_kernel_alloc(candBytes) : 0;
    if (!posPtr || (normBytes && !normPtr) || (maskBytes && !maskPtr) || (baseBytes && !basePtr) || (candBytes && !candPtr)) {
      return null;
    }

    // Fetch buffer after all alloc calls in case WASM memory grew.
    const memIn = wasmExports.memory.buffer;
    new Float32Array(memIn, posPtr, posArr.length).set(posArr);
    if (normPtr) {
      const nSrc = normals instanceof Float32Array ? normals : new Float32Array(normals);
      new Float32Array(memIn, normPtr, posArr.length).set(nSrc.subarray(0, posArr.length));
    }
    if (maskPtr) {
      const mSrc = mask instanceof Float32Array ? mask : new Float32Array(mask);
      new Float32Array(memIn, maskPtr, vertCount).set(mSrc.subarray(0, vertCount));
    }
    if (basePtr) {
      const bSrc = basePositions instanceof Float32Array ? basePositions : new Float32Array(basePositions);
      new Float32Array(memIn, basePtr, posArr.length).set(bSrc.subarray(0, posArr.length));
    }
    if (candPtr && candArr) {
      new Uint32Array(memIn, candPtr, candArr.length).set(candArr);
    }

    const cx = Array.isArray(center) ? center[0] : center.x;
    const cy = Array.isArray(center) ? center[1] : center.y;
    const cz = Array.isArray(center) ? center[2] : center.z;
    const nx = Array.isArray(normal) ? normal[0] : normal.x;
    const ny = Array.isArray(normal) ? normal[1] : normal.y;
    const nz = Array.isArray(normal) ? normal[2] : normal.z;
    const dx = Array.isArray(delta) ? delta[0] : delta.x;
    const dy = Array.isArray(delta) ? delta[1] : delta.y;
    const dz = Array.isArray(delta) ? delta[2] : delta.z;

    const modified = wasmExports.mesh_kernel_sculpt_stroke(
      posPtr,
      normPtr,
      maskPtr,
      basePtr,
      vertCount,
      candPtr,
      candArr ? candArr.length : 0,
      brushId,
      cx, cy, cz,
      nx, ny, nz,
      dx, dy, dz,
      radius,
      strength,
      dir
    );

    const memOut = wasmExports.memory.buffer;
    if (brushId === 9) {
      if (maskPtr && mask) {
        const updatedMask = new Float32Array(memOut, maskPtr, vertCount);
        mask.set(updatedMask);
      }
    } else if (modified > 0) {
      const updatedPos = new Float32Array(memOut, posPtr, posArr.length);
      positions.set(updatedPos);
    }

    return modified >>> 0;
  } finally {
    if (candPtr) wasmExports.mesh_kernel_free(candPtr, candBytes);
    if (basePtr) wasmExports.mesh_kernel_free(basePtr, baseBytes);
    if (maskPtr) wasmExports.mesh_kernel_free(maskPtr, maskBytes);
    if (normPtr) wasmExports.mesh_kernel_free(normPtr, normBytes);
    if (posPtr) wasmExports.mesh_kernel_free(posPtr, posBytes);
  }
}

/**
 * Remesh geometry to uniform edge density around `voxelSize` using Rust WASM.
 *
 * @param {Float32Array} positions
 * @param {Uint32Array|Int32Array|null} [indices]
 * @param {number} [voxelSize=0.1]
 * @returns {{ vertices: Float32Array, indices: Uint32Array, edges: Uint32Array, normals: Float32Array } | null}
 */
export function voxelRemeshInWasm(positions, indices = null, voxelSize = 0.1) {
  if (!wasmExports || !positions || positions.length < 9) return null;
  if (typeof wasmExports.mesh_kernel_voxel_remesh !== 'function') return null;

  const posArr = positions instanceof Float32Array ? positions : new Float32Array(positions);
  const posBytes = posArr.byteLength;
  const idxArr = indices && indices.length > 0
    ? (indices instanceof Uint32Array ? indices : new Uint32Array(indices))
    : null;
  const idxBytes = idxArr ? idxArr.byteLength : 0;

  let posPtr = 0;
  let idxPtr = 0;

  try {
    posPtr = wasmExports.mesh_kernel_alloc(posBytes);
    idxPtr = idxBytes ? wasmExports.mesh_kernel_alloc(idxBytes) : 0;
    if (!posPtr || (idxBytes && !idxPtr)) return null;

    const memIn = wasmExports.memory.buffer;
    new Float32Array(memIn, posPtr, posArr.length).set(posArr);
    if (idxPtr && idxArr) {
      new Uint32Array(memIn, idxPtr, idxArr.length).set(idxArr);
    }

    const ok = wasmExports.mesh_kernel_voxel_remesh(
      posPtr,
      posArr.length,
      idxPtr,
      idxArr ? idxArr.length : 0,
      voxelSize
    );

    if (!ok) return null;

    const memOut = wasmExports.memory.buffer;
    const vertices = new Float32Array(
      memOut,
      wasmExports.mesh_kernel_get_out_vertices_ptr(),
      wasmExports.mesh_kernel_get_out_vertices_len()
    ).slice();
    const outIndices = new Uint32Array(
      memOut,
      wasmExports.mesh_kernel_get_out_indices_ptr(),
      wasmExports.mesh_kernel_get_out_indices_len()
    ).slice();
    const edges = new Uint32Array(
      memOut,
      wasmExports.mesh_kernel_get_out_edges_ptr(),
      wasmExports.mesh_kernel_get_out_edges_len()
    ).slice();
    const normals = new Float32Array(
      memOut,
      wasmExports.mesh_kernel_get_out_normals_ptr(),
      wasmExports.mesh_kernel_get_out_normals_len()
    ).slice();

    return {
      vertices,
      indices: outIndices,
      edges,
      normals
    };
  } finally {
    if (idxPtr) wasmExports.mesh_kernel_free(idxPtr, idxBytes);
    if (posPtr) wasmExports.mesh_kernel_free(posPtr, posBytes);
  }
}

/**
 * Simplifies a triangle mesh in Rust WASM using Garland-Heckbert Quadric Error Metrics (QEM),
 * preserving UVs, silhouette boundaries, and recomputing smooth vertex normals.
 *
 * @param {Float32Array} positions Contiguous x,y,z vertex positions
 * @param {Uint32Array|Uint16Array|null} [indices=null] Optional triangle indices
 * @param {Object} [options]
 * @param {Float32Array|null} [options.uvs=null] Optional u,v coordinates (2 floats per input vertex)
 * @param {number} [options.ratio=0.35] Target triangle ratio (0.01 .. 1.0)
 * @param {boolean} [options.lockBorders=true] Strongly preserve open borders & UV seams
 * @returns {{ vertices: Float32Array, indices: Uint32Array, normals: Float32Array, uvs: Float32Array|null } | null}
 */
export function simplifyMeshQEMInWasm(positions, indices = null, options = {}) {
  if (!wasmExports || typeof wasmExports.mesh_kernel_qem_simplify !== 'function') return null;
  if (!positions || positions.length < 9) return null;

  const posArr = positions instanceof Float32Array ? positions : new Float32Array(positions);
  const posBytes = posArr.byteLength;
  const inVerts = (posArr.length / 3) | 0;

  const rawUvs = options.uvs;
  const uvArr = rawUvs && rawUvs.length === inVerts * 2
    ? (rawUvs instanceof Float32Array ? rawUvs : new Float32Array(rawUvs))
    : null;
  const uvBytes = uvArr ? uvArr.byteLength : 0;

  const idxArr = indices && indices.length >= 3
    ? (indices instanceof Uint32Array ? indices : new Uint32Array(indices))
    : null;
  const idxBytes = idxArr ? idxArr.byteLength : 0;

  const ratio = Number.isFinite(options.ratio) ? Math.max(0.01, Math.min(1.0, options.ratio)) : 0.35;
  const lockBorders = options.lockBorders !== false ? 1 : 0;

  let posPtr = 0;
  let uvPtr = 0;
  let idxPtr = 0;

  try {
    posPtr = wasmExports.mesh_kernel_alloc(posBytes);
    if (!posPtr) return null;
    if (uvBytes > 0) {
      uvPtr = wasmExports.mesh_kernel_alloc(uvBytes);
      if (!uvPtr) return null;
    }
    if (idxBytes > 0) {
      idxPtr = wasmExports.mesh_kernel_alloc(idxBytes);
      if (!idxPtr) return null;
    }

    const memIn = wasmExports.memory.buffer;
    new Float32Array(memIn, posPtr, posArr.length).set(posArr);
    if (uvPtr && uvArr) new Float32Array(memIn, uvPtr, uvArr.length).set(uvArr);
    if (idxPtr && idxArr) new Uint32Array(memIn, idxPtr, idxArr.length).set(idxArr);

    const ok = wasmExports.mesh_kernel_qem_simplify(
      posPtr,
      posArr.length,
      uvPtr,
      uvArr ? uvArr.length : 0,
      idxPtr,
      idxArr ? idxArr.length : 0,
      ratio,
      lockBorders
    );
    if (!ok) return null;

    const memOut = wasmExports.memory.buffer;
    const vertices = new Float32Array(
      memOut,
      wasmExports.mesh_kernel_get_out_vertices_ptr(),
      wasmExports.mesh_kernel_get_out_vertices_len()
    ).slice();
    const outIndices = new Uint32Array(
      memOut,
      wasmExports.mesh_kernel_get_out_indices_ptr(),
      wasmExports.mesh_kernel_get_out_indices_len()
    ).slice();
    const normals = new Float32Array(
      memOut,
      wasmExports.mesh_kernel_get_out_normals_ptr(),
      wasmExports.mesh_kernel_get_out_normals_len()
    ).slice();
    const uvLen = wasmExports.mesh_kernel_get_out_uvs_len();
    const uvs = uvLen > 0
      ? new Float32Array(memOut, wasmExports.mesh_kernel_get_out_uvs_ptr(), uvLen).slice()
      : null;

    return { vertices, indices: outIndices, normals, uvs };
  } finally {
    if (idxPtr) wasmExports.mesh_kernel_free(idxPtr, idxBytes);
    if (uvPtr) wasmExports.mesh_kernel_free(uvPtr, uvBytes);
    if (posPtr) wasmExports.mesh_kernel_free(posPtr, posBytes);
  }
}

/**
 * Generates up to 100,000 column-major `Matrix4` instance transforms scattered evenly
 * by triangle surface area in world space using Rust WASM.
 *
 * @param {Float32Array} positions
 * @param {Uint32Array|Uint16Array|null} [indices=null]
 * @param {Object} [options]
 * @returns {{ matrices: Float32Array, count: number } | null}
 */
export function scatterSurfaceInWasm(positions, indices = null, options = {}) {
  if (!wasmExports || typeof wasmExports.mesh_kernel_scatter_surface !== 'function') return null;
  if (!positions || positions.length < 9) return null;

  const posArr = positions instanceof Float32Array ? positions : new Float32Array(positions);
  const posBytes = posArr.byteLength;
  const idxArr = indices && indices.length >= 3
    ? (indices instanceof Uint32Array ? indices : new Uint32Array(indices))
    : null;
  const idxBytes = idxArr ? idxArr.byteLength : 0;
  const matArr = options.surfaceMatrix && options.surfaceMatrix.length === 16
    ? (options.surfaceMatrix instanceof Float32Array ? options.surfaceMatrix : new Float32Array(options.surfaceMatrix))
    : null;
  const matBytes = matArr ? 64 : 0;

  const count = Math.max(1, Math.min(100000, Math.floor(Number(options.count) || 1000)));
  const seed = BigInt(Math.floor(Number(options.seed ?? 1337)));
  const minScale = Number.isFinite(options.minScale) ? options.minScale : 0.8;
  const maxScale = Number.isFinite(options.maxScale) ? options.maxScale : 1.25;
  const alignNormal = Number.isFinite(options.alignNormal) ? options.alignNormal : 0.7;
  const minNormalY = Number.isFinite(options.minNormalY) ? options.minNormalY : 0.35;
  const minSpacing = Number.isFinite(options.minSpacing) ? Math.max(0, options.minSpacing) : 0.0;

  let posPtr = 0;
  let idxPtr = 0;
  let matPtr = 0;

  try {
    posPtr = wasmExports.mesh_kernel_alloc(posBytes);
    if (!posPtr) return null;
    if (idxBytes > 0) {
      idxPtr = wasmExports.mesh_kernel_alloc(idxBytes);
      if (!idxPtr) return null;
    }
    if (matBytes > 0) {
      matPtr = wasmExports.mesh_kernel_alloc(matBytes);
      if (!matPtr) return null;
    }

    const memIn = wasmExports.memory.buffer;
    new Float32Array(memIn, posPtr, posArr.length).set(posArr);
    if (idxPtr && idxArr) new Uint32Array(memIn, idxPtr, idxArr.length).set(idxArr);
    if (matPtr && matArr) new Float32Array(memIn, matPtr, 16).set(matArr);

    const spawned = wasmExports.mesh_kernel_scatter_surface(
      posPtr,
      posArr.length,
      idxPtr,
      idxArr ? idxArr.length : 0,
      matPtr,
      count,
      seed,
      minScale,
      maxScale,
      alignNormal,
      minNormalY,
      minSpacing
    ) >>> 0;

    const memOut = wasmExports.memory.buffer;
    const matLen = wasmExports.mesh_kernel_get_out_matrices_len();
    const matrices = matLen > 0
      ? new Float32Array(memOut, wasmExports.mesh_kernel_get_out_matrices_ptr(), matLen).slice()
      : new Float32Array(0);

    return { matrices, count: spawned };
  } finally {
    if (matPtr) wasmExports.mesh_kernel_free(matPtr, matBytes);
    if (idxPtr) wasmExports.mesh_kernel_free(idxPtr, idxBytes);
    if (posPtr) wasmExports.mesh_kernel_free(posPtr, posBytes);
  }
}

/**
 * Frustum-culls and partitions N instance matrices into 3 contiguous LOD slices
 * `[LOD0 | LOD1 | LOD2]` in Rust WASM.
 *
 * @param {Float32Array} allMatrices N * 16 column-major floats
 * @param {Object} [options]
 * @returns {{ packedMatrices: Float32Array, counts: [number, number, number, number], totalVisible: number } | null}
 */
export function cullAndLodInstancesInWasm(allMatrices, options = {}) {
  if (!wasmExports || typeof wasmExports.mesh_kernel_cull_and_lod_instances !== 'function') return null;
  if (!allMatrices || allMatrices.length < 16) {
    return { packedMatrices: new Float32Array(0), counts: [0, 0, 0, 0], totalVisible: 0 };
  }

  const matArr = allMatrices instanceof Float32Array ? allMatrices : new Float32Array(allMatrices);
  const instanceCount = (matArr.length / 16) | 0;
  const matBytes = instanceCount * 64;

  const planesArr = options.frustumPlanes && options.frustumPlanes.length === 24
    ? (options.frustumPlanes instanceof Float32Array ? options.frustumPlanes : new Float32Array(options.frustumPlanes))
    : null;
  const planesBytes = planesArr ? 96 : 0;

  const cam = options.cameraPosition || [0, 0, 0];
  const baseRadius = Number.isFinite(options.boundingRadius) ? options.boundingRadius : 1.0;
  const lod1Dist = Number.isFinite(options.lod1Distance) ? options.lod1Distance : 15.0;
  const lod2Dist = Number.isFinite(options.lod2Distance) ? options.lod2Distance : 35.0;
  const maxDist = Number.isFinite(options.maxDistance) ? options.maxDistance : 120.0;
  const lodBias = Number.isFinite(options.lodBias) ? options.lodBias : 1.0;

  let matPtr = 0;
  let planesPtr = 0;

  try {
    matPtr = wasmExports.mesh_kernel_alloc(matBytes);
    if (!matPtr) return null;
    if (planesBytes > 0) {
      planesPtr = wasmExports.mesh_kernel_alloc(planesBytes);
      if (!planesPtr) return null;
    }

    const memIn = wasmExports.memory.buffer;
    new Float32Array(memIn, matPtr, instanceCount * 16).set(matArr.subarray(0, instanceCount * 16));
    if (planesPtr && planesArr) new Float32Array(memIn, planesPtr, 24).set(planesArr);

    const totalVisible = wasmExports.mesh_kernel_cull_and_lod_instances(
      matPtr,
      instanceCount,
      planesPtr,
      cam[0] || 0,
      cam[1] || 0,
      cam[2] || 0,
      baseRadius,
      lod1Dist,
      lod2Dist,
      maxDist,
      lodBias
    ) >>> 0;

    const memOut = wasmExports.memory.buffer;
    const outLen = wasmExports.mesh_kernel_get_out_matrices_len();
    const packedMatrices = outLen > 0
      ? new Float32Array(memOut, wasmExports.mesh_kernel_get_out_matrices_ptr(), outLen).slice()
      : new Float32Array(0);
    const countsView = new Uint32Array(memOut, wasmExports.mesh_kernel_get_out_lod_counts_ptr(), 4);
    const counts = [countsView[0], countsView[1], countsView[2], countsView[3]];

    return { packedMatrices, counts, totalVisible };
  } finally {
    if (planesPtr) wasmExports.mesh_kernel_free(planesPtr, planesBytes);
    if (matPtr) wasmExports.mesh_kernel_free(matPtr, matBytes);
  }
}

export const DCC_FORMAT_IDS = Object.freeze({
  obj: 1,
  '3ds': 2,
  vox: 3,
  usda: 4,
  usd: 4,
  dxf: 5,
  '3mf': 6,
  off: 7,
  coff: 7,
  dae: 8,
});

/**
 * Parses a DCC / Studio / CAD 3D file (`obj`+`mtl`, `3ds`, `vox`, `usda`, `dxf`, `3mf`, `off`, `dae`)
 * directly inside Rust WASM (`mesh_kernel_import_dcc`).
 *
 * @param {string|number} format Format key (`'obj'`, `'3ds'`, `'vox'`, `'usda'`, `'dxf'`, `'3mf'`, `'off'`, `'dae'`) or numeric ID
 * @param {Uint8Array|ArrayBuffer} dataBytes Primary model file bytes
 * @param {Uint8Array|ArrayBuffer|null} [auxBytes=null] Optional companion bytes (e.g. `.mtl` for `.obj`)
 * @returns {{
 *   triangleCount: number,
 *   positions: Float32Array,
 *   normals: Float32Array,
 *   uvs: Float32Array,
 *   colors: Float32Array,
 *   indices: Uint32Array,
 *   meta: { format: string, materials: Array<Object>, submeshes: Array<Object> }
 * } | null}
 */
export function parseDccModelInWasm(format, dataBytes, auxBytes = null) {
  if (!wasmExports || typeof wasmExports.mesh_kernel_import_dcc !== 'function') return null;
  const formatId = typeof format === 'number'
    ? format
    : DCC_FORMAT_IDS[String(format || '').toLowerCase()];
  if (!formatId || !dataBytes) return null;

  const mainArr = dataBytes instanceof Uint8Array ? dataBytes : new Uint8Array(dataBytes);
  if (mainArr.byteLength === 0) return null;
  const auxArr = auxBytes
    ? (auxBytes instanceof Uint8Array ? auxBytes : new Uint8Array(auxBytes))
    : null;

  let dataPtr = 0;
  let auxPtr = 0;
  const mainLen = mainArr.byteLength;
  const auxLen = auxArr ? auxArr.byteLength : 0;

  try {
    dataPtr = wasmExports.mesh_kernel_alloc(mainLen);
    if (!dataPtr) return null;
    if (auxLen > 0) {
      auxPtr = wasmExports.mesh_kernel_alloc(auxLen);
      if (!auxPtr) return null;
    }

    const memIn = wasmExports.memory.buffer;
    new Uint8Array(memIn, dataPtr, mainLen).set(mainArr);
    if (auxPtr && auxArr) {
      new Uint8Array(memIn, auxPtr, auxLen).set(auxArr);
    }

    const triangleCount = wasmExports.mesh_kernel_import_dcc(
      formatId,
      dataPtr,
      mainLen,
      auxPtr,
      auxLen
    ) >>> 0;

    if (triangleCount === 0) return null;

    const memOut = wasmExports.memory.buffer;
    const posLen = wasmExports.mesh_kernel_import_get_positions_len();
    const normLen = wasmExports.mesh_kernel_import_get_normals_len();
    const uvLen = wasmExports.mesh_kernel_import_get_uvs_len();
    const colLen = wasmExports.mesh_kernel_import_get_colors_len();
    const idxLen = wasmExports.mesh_kernel_import_get_indices_len();
    const metaLen = wasmExports.mesh_kernel_import_get_meta_len();

    const positions = posLen > 0
      ? new Float32Array(memOut, wasmExports.mesh_kernel_import_get_positions_ptr(), posLen).slice()
      : new Float32Array(0);
    const normals = normLen > 0
      ? new Float32Array(memOut, wasmExports.mesh_kernel_import_get_normals_ptr(), normLen).slice()
      : new Float32Array(0);
    const uvs = uvLen > 0
      ? new Float32Array(memOut, wasmExports.mesh_kernel_import_get_uvs_ptr(), uvLen).slice()
      : new Float32Array(0);
    const colors = colLen > 0
      ? new Float32Array(memOut, wasmExports.mesh_kernel_import_get_colors_ptr(), colLen).slice()
      : new Float32Array(0);
    const indices = idxLen > 0
      ? new Uint32Array(memOut, wasmExports.mesh_kernel_import_get_indices_ptr(), idxLen).slice()
      : new Uint32Array(0);

    let meta = { format: String(format), materials: [], submeshes: [] };
    if (metaLen > 0) {
      const metaBytes = new Uint8Array(memOut, wasmExports.mesh_kernel_import_get_meta_ptr(), metaLen);
      const jsonText = new TextDecoder('utf-8').decode(metaBytes);
      meta = JSON.parse(jsonText);
    }

    return {
      triangleCount,
      positions,
      normals,
      uvs,
      colors,
      indices,
      meta,
    };
  } finally {
    if (auxPtr) wasmExports.mesh_kernel_free(auxPtr, auxLen);
    if (dataPtr) wasmExports.mesh_kernel_free(dataPtr, mainLen);
  }
}
