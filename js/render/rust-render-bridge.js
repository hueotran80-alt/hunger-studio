/**
 * @file rust-render-bridge.js
 * @description JS bridge for the Rust path-tracing kernel (`crates/render_kernel`, WASM).
 * `RenderKernel` wraps one WASM instance (usable in the main thread, a Web Worker or Node).
 * `renderRust()` drives a progressive, row-tiled render, optionally over a worker pool,
 * then denoises and tone-maps (AgX/ACES/Neutral/linear) into RGBA8.
 */

// Must not import `three` (via rust-scene-pack.js) because this module runs inside Web Workers without import maps.
export const MAT_STRIDE = 32;
export const LIGHT_STRIDE = 16;
export const TONEMAP = { linear: 0, aces: 1, agx: 2, neutral: 3 };
export const AGX_LOOK = { base: 0, punchy: 1, 'high-contrast': 2, 'medium-high': 3, 'low-contrast': 4 };
export function encodeTonemapMode(tonemap = 'agx', look = 'base') {
  const base = TONEMAP[tonemap] ?? TONEMAP.agx;
  const lk = AGX_LOOK[look] ?? 0;
  return base | (lk << 8);
}
export const BAKE_MODE = { ao: 0, normal: 1, worldNormal: 2, position: 3, curvature: 4, combined: 5 };
export const AOV_STRIDE = 8;

export async function loadKernelBytes(wasmSource = null) {
  if (wasmSource instanceof ArrayBuffer || ArrayBuffer.isView(wasmSource)) return wasmSource;
  if (typeof process !== 'undefined' && process.versions?.node) {
    const fs = await import('fs');
    const path = await import('path');
    return fs.readFileSync(typeof wasmSource === 'string' ? wasmSource : path.resolve(process.cwd(), 'vendor/wasm/render_kernel.wasm'));
  }
  const url = typeof wasmSource === 'string' ? wasmSource : new URL('../../vendor/wasm/render_kernel.wasm', import.meta.url).href;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status} loading ${url}`);
  return response.arrayBuffer();
}

export class RenderKernel {
  static async create(wasmSource = null) {
    const bytes = await loadKernelBytes(wasmSource);
    const { instance } = await WebAssembly.instantiate(bytes, {});
    return new RenderKernel(instance.exports);
  }

  constructor(exports) {
    this.x = exports;
    this.sceneLoaded = false;
    this.triCount = 0;
  }

  get version() { return this.x.rk_version(); }

  _put(array) {
    const ptr = this.x.rk_alloc(array.byteLength);
    new Uint8Array(this.x.memory.buffer, ptr, array.byteLength).set(new Uint8Array(array.buffer, array.byteOffset, array.byteLength));
    return ptr;
  }

  _with(arrays, fn) {
    const ptrs = arrays.map((a) => (a && a.byteLength ? this._put(a) : 0));
    try { return fn(ptrs); } finally {
      ptrs.forEach((p, i) => { if (p) this.x.rk_free(p, arrays[i].byteLength); });
    }
  }

  /** @returns {number} BVH node count */
  loadScene(packed) {
    const { pos, nrm, uvs, matIds, mats, lights, triCount } = packed;
    const nodes = this._with([pos, nrm, uvs, matIds, mats, lights], ([p, n, u, m, ms, ls]) =>
      this.x.rk_scene_load(p, n, u, m, triCount, ms, mats.length / MAT_STRIDE, ls, lights.length / LIGHT_STRIDE));
    if (!nodes) throw new Error('Rust kernel rejected the scene (no valid triangles).');
    this.sceneLoaded = true;
    this.triCount = triCount;
    if (packed.textures?.count > 0) {
      this._with([packed.textures.data, packed.textures.metas], ([td, tm]) => {
        this.x.rk_set_textures(td, packed.textures.data.byteLength, tm, packed.textures.count);
      });
    } else {
      this.x.rk_set_textures(0, 0, 0, 0);
    }
    if (Array.isArray(packed.shaderProgs) && typeof this.x.rk_set_shader_graph === 'function') {
      packed.shaderProgs.forEach((prog, matIdx) => {
        if (!prog || !prog.ops?.length) return;
        this._with([prog.ops, prog.consts], ([opPtr, cPtr]) => {
          this.x.rk_set_shader_graph(matIdx, opPtr, prog.ops.length, cPtr, prog.consts?.length || 0);
        });
      });
    }
    this._applyEnvVolumeCamera(packed);
    return nodes;
  }

  /** Fast BVH refit when topology & textures did not change. Returns false if full reload needed. */
  refitScene(packed) {
    if (!this.sceneLoaded || packed.triCount !== this.triCount) return false;
    const rc = this._with([packed.pos, packed.nrm, packed.lights], ([p, n, ls]) =>
      this.x.rk_refit(p, n, packed.triCount, ls, packed.lights.length / LIGHT_STRIDE));
    if (rc !== 0) return false;
    this._applyEnvVolumeCamera(packed);
    return true;
  }

  _applyEnvVolumeCamera(packed) {
    this._with([packed.env.params, packed.env.rgb], ([pp, rp]) => {
      this.x.rk_set_env(pp, rp, packed.env.w || 0, packed.env.h || 0);
    });
    if (packed.volume && packed.volume.density > 0) {
      const v = packed.volume;
      this.x.rk_set_volume(v.density, v.anisotropy || 0, v.color[0], v.color[1], v.color[2], v.maxDist || 100);
    } else {
      this.x.rk_set_volume(0, 0, 0, 0, 0, 100);
    }
    this.setCamera(packed.camera);
  }

  setCamera(params) {
    this._with([params], ([p]) => this.x.rk_set_camera(p));
  }

  /** Renders rows [y0,y1) and returns the partial sums for exactly those rows. */
  renderRows({ width, height, y0, y1, spp, seed, maxBounces = 5, clamp = 20, adaptiveThreshold = 0 }) {
    const rows = y1 - y0;
    const accBytes = rows * width * 16;
    const aovBytes = rows * width * AOV_STRIDE * 4;
    const a = this.x.rk_alloc(accBytes);
    const g = this.x.rk_alloc(aovBytes);
    try {
      const rc = this.x.rk_render_rows(a, g, width, height, y0, y1, spp, seed, maxBounces, clamp, adaptiveThreshold);
      if (rc !== 0) throw new Error('Rust kernel has no scene loaded.');
      const mem = this.x.memory.buffer;
      return {
        y0, y1,
        accum: new Float32Array(mem, a, rows * width * 4).slice(),
        aov: new Float32Array(mem, g, rows * width * AOV_STRIDE).slice()
      };
    } finally {
      this.x.rk_free(a, accBytes);
      this.x.rk_free(g, aovBytes);
    }
  }

  /** accum/aov are sums over `spp` samples. Returns RGBA8 (straight alpha) and keeps temporal state resident in WASM RAM. */
  resolve({ accum, aov, width, height, spp, denoise = false, denoisePasses = 4, exposure = 1, tonemap = 'agx', tonemapLook = 'base', temporal = null }) {
    const n = width * height;
    const toneMode = encodeTonemapMode(tonemap, tonemapLook);

    // Fast fused WASM path: avoids copying 74 MB/frame of prevMean+prevAov across JS<->WASM
    if (this.sceneLoaded && typeof this.x.rk_resolve_frame === 'function') {
      const useTemporal = Boolean(temporal);
      if (useTemporal && !temporal._wasmInitialized) {
        if (typeof this.x.rk_reset_temporal === 'function') this.x.rk_reset_temporal();
        temporal._wasmInitialized = true;
      }
      const out = this.x.rk_alloc(n * 4);
      try {
        const rc = this._with([accum, aov], ([a, g]) =>
          this.x.rk_resolve_frame(
            a,
            g,
            out,
            width,
            height,
            spp,
            denoise ? denoisePasses : 0,
            useTemporal ? (temporal.blend ?? 0.75) : 0.0,
            exposure,
            toneMode
          )
        );
        if (rc === 0) {
          if (useTemporal) {
            temporal.state = {
              wasmResident: true,
              width,
              height,
              prevSpp: spp,
              prevMean: { length: n * 4 },
            };
          }
          return new Uint8ClampedArray(new Uint8Array(this.x.memory.buffer, out, n * 4).slice().buffer);
        }
      } finally {
        this.x.rk_free(out, n * 4);
      }
    }

    const mean = this.x.rk_alloc(n * 16);
    const out = this.x.rk_alloc(n * 4);
    let reprojPtr = 0;
    try {
      this._with([accum, aov], ([a, g]) => {
        if (denoise) this.x.rk_denoise(a, g, mean, width, height, spp, denoisePasses);
        else this.x.rk_mean(a, mean, n, spp);
      });
      let finalMeanPtr = mean;
      if (temporal) {
        const st = temporal.state;
        const canReproj = this.sceneLoaded && st && st.width === width && st.height === height && st.prevMean?.length === n * 4;
        if (canReproj) {
          reprojPtr = this.x.rk_alloc(n * 16);
          this._with([aov, st.prevMean, st.prevAov], ([ca, pm, pa]) => {
            this.x.rk_temporal_reproject(mean, ca, pm, pa, reprojPtr, width, height, spp, st.prevSpp, temporal.blend ?? 0.75);
          });
          finalMeanPtr = reprojPtr;
        }
        const savedMean = new Float32Array(this.x.memory.buffer, finalMeanPtr, n * 4).slice();
        temporal.state = { prevMean: savedMean, prevAov: aov.slice(), prevSpp: spp, width, height };
      }
      this.x.rk_tonemap(finalMeanPtr, out, n, exposure, toneMode);
      return new Uint8ClampedArray(new Uint8Array(this.x.memory.buffer, out, n * 4).slice().buffer);
    } finally {
      if (reprojPtr) this.x.rk_free(reprojPtr, n * 16);
      this.x.rk_free(mean, n * 16);
      this.x.rk_free(out, n * 4);
    }
  }

  /** Exports Rust's Binned-SAH BVH2 (with optional motion-union AABBs when shutter > 0) + extended UV/TBN/emissive attrs. */
  exportBvh2ForGpu(shutter = 0) {
    if (!this.sceneLoaded || typeof this.x.rk_export_bvh2_nodes !== 'function') return null;
    const nodeCount = this.x.rk_bvh_node_count();
    const triCount = this.x.rk_bvh_tri_count();
    if (!nodeCount || !triCount) return null;

    const hasExt = typeof this.x.rk_export_bvh2_tris_ext === 'function';
    const hasMotionNodes = typeof this.x.rk_export_bvh2_nodes_motion === 'function';
    const nBytes = nodeCount * 8 * 4;
    const gBytes = triCount * 12 * 4;
    const aFloats = hasExt ? 20 : 12;
    const aBytes = triCount * aFloats * 4;
    const nPtr = this.x.rk_alloc(nBytes);
    const gPtr = this.x.rk_alloc(gBytes);
    const aPtr = this.x.rk_alloc(aBytes);
    try {
      if (hasMotionNodes && shutter > 1e-4) {
        this.x.rk_export_bvh2_nodes_motion(nPtr, shutter);
      } else {
        this.x.rk_export_bvh2_nodes(nPtr);
      }
      if (hasExt) {
        this.x.rk_export_bvh2_tris_ext(gPtr, aPtr);
      } else {
        this.x.rk_export_bvh2_tris(gPtr, aPtr);
      }
      const mem = this.x.memory.buffer;
      const triAttrF32 = new Float32Array(mem, aPtr, triCount * aFloats).slice();
      return {
        nodeCount,
        triCount,
        hasExtendedAttrs: hasExt,
        nodesF32: new Float32Array(mem, nPtr, nodeCount * 8).slice(),
        triGeomF32: new Float32Array(mem, gPtr, triCount * 12).slice(),
        triNormF32: triAttrF32,
        triAttrF32,
      };
    } finally {
      this.x.rk_free(nPtr, nBytes);
      this.x.rk_free(gPtr, gBytes);
      this.x.rk_free(aPtr, aBytes);
    }
  }

  /** Exports Rust's emissive triangle CDF (`count * 4` floats: `[bits(triIdx), cdfNorm, areaPdf, 0]`) for WebGPU MIS. */
  exportEmissiveCdfForGpu() {
    if (!this.sceneLoaded || typeof this.x.rk_emissive_count !== 'function' || typeof this.x.rk_export_emissive_cdf !== 'function') {
      return null;
    }
    const count = this.x.rk_emissive_count();
    if (!count) return null;
    const bytes = count * 4 * 4;
    const ptr = this.x.rk_alloc(bytes);
    try {
      const written = this.x.rk_export_emissive_cdf(ptr);
      if (!written) return null;
      return {
        count: written,
        dataF32: new Float32Array(this.x.memory.buffer, ptr, written * 4).slice(),
      };
    } finally {
      this.x.rk_free(ptr, bytes);
    }
  }

  /** Exports previous-frame BVH-ordered triangles (`triCount * 12` floats) for per-vertex GPU motion vectors & blur. */
  exportPrevTrisForGpu() {
    if (!this.sceneLoaded || typeof this.x.rk_has_prev_tris !== 'function' || typeof this.x.rk_export_prev_bvh2_tris !== 'function') {
      return null;
    }
    if (!this.x.rk_has_prev_tris()) return null;
    const triCount = this.x.rk_bvh_tri_count();
    if (!triCount) return null;
    const bytes = triCount * 12 * 4;
    const ptr = this.x.rk_alloc(bytes);
    try {
      const written = this.x.rk_export_prev_bvh2_tris(ptr);
      if (!written) return null;
      return {
        triCount: written,
        prevGeomF32: new Float32Array(this.x.memory.buffer, ptr, written * 12).slice(),
      };
    } finally {
      this.x.rk_free(ptr, bytes);
    }
  }

  /** Exports Rust's 2D HDRI Importance Sampling CDF (row marginal + col conditional + solid-angle PDF) for WebGPU MIS. */
  exportEnvCdfForGpu() {
    if (!this.sceneLoaded || typeof this.x.rk_env_dims !== 'function' || typeof this.x.rk_export_env_cdf !== 'function') {
      return null;
    }
    const whPtr = this.x.rk_alloc(8);
    let w = 0, h = 0;
    try {
      const ok = this.x.rk_env_dims(whPtr);
      if (!ok) return null;
      const wh = new Uint32Array(this.x.memory.buffer, whPtr, 2);
      w = wh[0];
      h = wh[1];
    } finally {
      this.x.rk_free(whPtr, 8);
    }
    if (!w || !h) return null;
    const rBytes = h * 4;
    const cBytes = w * h * 2 * 4;
    const rPtr = this.x.rk_alloc(rBytes);
    const cPtr = this.x.rk_alloc(cBytes);
    try {
      const ok = this.x.rk_export_env_cdf(rPtr, cPtr);
      if (!ok) return null;
      const mem = this.x.memory.buffer;
      return {
        width: w,
        height: h,
        rowCdfF32: new Float32Array(mem, rPtr, h).slice(),
        colCdfPdfF32: new Float32Array(mem, cPtr, w * h * 2).slice(),
      };
    } finally {
      this.x.rk_free(rPtr, rBytes);
      this.x.rk_free(cPtr, cBytes);
    }
  }

  /** Parallel worker helper: Stage 1 demodulate + variance on band [y0..y1) with zero full-frame copy. */
  denoisePrepBand(accum, aov, colOut, albOut, nrmOut, width, height, y0, y1, spp) {
    const bh = y1 - y0;
    if (bh <= 0) return;
    const s4 = y0 * width * 4, e4 = y1 * width * 4;
    const sA = y0 * width * AOV_STRIDE, eA = y1 * width * AOV_STRIDE;
    const b4 = bh * width * 4 * 4;
    const cPtr = this.x.rk_alloc(b4);
    const aPtr = this.x.rk_alloc(b4);
    const nPtr = this.x.rk_alloc(b4);
    try {
      this._with([accum.subarray(s4, e4), aov.subarray(sA, eA)], ([accP, aovP]) => {
        this.x.rk_denoise_prep_rows(accP, aovP, cPtr, aPtr, nPtr, width, bh, 0, bh, spp);
      });
      const mem = this.x.memory.buffer;
      colOut.set(new Float32Array(mem, cPtr, bh * width * 4), s4);
      albOut.set(new Float32Array(mem, aPtr, bh * width * 4), s4);
      nrmOut.set(new Float32Array(mem, nPtr, bh * width * 4), s4);
    } finally {
      this.x.rk_free(cPtr, b4);
      this.x.rk_free(aPtr, b4);
      this.x.rk_free(nPtr, b4);
    }
  }

  /** Parallel worker helper: Horizontal or vertical 5-tap à-trous pass on band [y0..y1) with minimal halo. */
  denoiseStepBand(colIn, alb, nrm, colOut, width, height, y0, y1, step, passScaleInv2, vertical) {
    const halo = vertical ? step * 2 : 0;
    const by0 = Math.max(0, y0 - halo);
    const by1 = Math.min(height, y1 + halo);
    const bh = by1 - by0;
    if (bh <= 0) return;
    const bs4 = by0 * width * 4, be4 = by1 * width * 4;
    const b4 = bh * width * 4 * 4;
    const outPtr = this.x.rk_alloc(b4);
    try {
      this._with([colIn.subarray(bs4, be4), alb.subarray(bs4, be4), nrm.subarray(bs4, be4)], ([ciP, alP, nrP]) => {
        this.x.rk_denoise_step_rows(ciP, alP, nrP, outPtr, width, bh, y0 - by0, y1 - by0, step, passScaleInv2, vertical ? 1 : 0);
      });
      const mem = this.x.memory.buffer;
      const localOff = (y0 - by0) * width * 4;
      const outSlice = new Float32Array(mem, outPtr, bh * width * 4).subarray(localOff, localOff + (y1 - y0) * width * 4);
      colOut.set(outSlice, y0 * width * 4);
    } finally {
      this.x.rk_free(outPtr, b4);
    }
  }

  /** Parallel worker helper: Remodulate denoised illumination by albedo on band [y0..y1). */
  denoiseRemodBand(col, alb, nrm, meanOut, width, height, y0, y1) {
    const bh = y1 - y0;
    if (bh <= 0) return;
    const s4 = y0 * width * 4, e4 = y1 * width * 4;
    const b4 = bh * width * 4 * 4;
    const outPtr = this.x.rk_alloc(b4);
    try {
      this._with([col.subarray(s4, e4), alb.subarray(s4, e4), nrm.subarray(s4, e4)], ([cP, aP, nP]) => {
        this.x.rk_denoise_remod_rows(cP, aP, nP, outPtr, width, bh, 0, bh);
      });
      meanOut.set(new Float32Array(this.x.memory.buffer, outPtr, bh * width * 4), s4);
    } finally {
      this.x.rk_free(outPtr, b4);
    }
  }

  /** Parallel worker helper: Motion-vector temporal reprojection on band [y0..y1). */
  temporalReprojectBand(curMean, curAov, prevMean, prevAov, outMean, width, height, y0, y1, curSpp, prevSpp, blend) {
    const n = width * height;
    const outPtr = this.x.rk_alloc(n * 16);
    try {
      this._with([curMean, curAov, prevMean, prevAov], ([cmP, caP, pmP, paP]) => {
        this.x.rk_temporal_reproject_rows(cmP, caP, pmP, paP, outPtr, width, height, y0, y1, curSpp, prevSpp, blend);
      });
      const s4 = y0 * width * 4;
      const len4 = (y1 - y0) * width * 4;
      outMean.set(new Float32Array(this.x.memory.buffer, outPtr, n * 4).subarray(s4, s4 + len4), s4);
    } finally {
      this.x.rk_free(outPtr, n * 16);
    }
  }

  /** Parallel worker helper: LUT AgX/ACES/Neutral/Linear tonemap on band [y0..y1). */
  tonemapBand(srcMean, outRgba, width, height, y0, y1, exposure, tonemap, tonemapLook = 'base') {
    const bh = y1 - y0;
    if (bh <= 0) return;
    const s4 = y0 * width * 4, e4 = y1 * width * 4;
    const outBytes = bh * width * 4;
    const outPtr = this.x.rk_alloc(outBytes);
    try {
      this._with([srcMean.subarray(s4, e4)], ([sP]) => {
        this.x.rk_tonemap_rows(sP, outPtr, width, bh, 0, bh, exposure, encodeTonemapMode(tonemap, tonemapLook));
      });
      outRgba.set(new Uint8ClampedArray(this.x.memory.buffer, outPtr, outBytes), s4);
    } finally {
      this.x.rk_free(outPtr, outBytes);
    }
  }

  /** Bakes rows [y0,y1) of target mesh against loaded BVH scene. Returns { y0, y1, rgba, cov }. */
  bakeRows({ pos, nrm = null, uv, ntri, width, height, y0, y1, mode = 0, samples = 32, maxDist = 0, cageOffset = 0, boundsLo = null, boundsHi = null }) {
    const rows = Math.max(0, y1 - y0);
    const outBytes = rows * width * 4;
    const covBytes = rows * width;
    const oPtr = this.x.rk_alloc(Math.max(4, outBytes));
    const cPtr = this.x.rk_alloc(Math.max(4, covBytes));
    try {
      const rc = this._with([pos, nrm, uv, boundsLo, boundsHi], ([pp, np, up, bl, bh]) =>
        this.x.rk_bake_rows(pp, np, up, ntri, width, height, y0, y1, oPtr, cPtr, mode, samples, maxDist, cageOffset, bl, bh));
      if (rc !== 0) throw new Error('Rust kernel has no scene loaded for bake.');
      const mem = this.x.memory.buffer;
      return {
        y0, y1,
        rgba: new Uint8Array(mem, oPtr, outBytes).slice(),
        cov: new Uint8Array(mem, cPtr, covBytes).slice(),
      };
    } finally {
      this.x.rk_free(oPtr, Math.max(4, outBytes));
      this.x.rk_free(cPtr, Math.max(4, covBytes));
    }
  }

  /** Dilates baked UV islands outward by `margin` pixels in-place. */
  dilateBakeMargin(rgba, cov, width, height, margin = 4) {
    if (!margin || width <= 0 || height <= 0) return rgba;
    const oPtr = this._put(rgba);
    const cPtr = this._put(cov);
    try {
      this.x.rk_bake_dilate(oPtr, cPtr, width, height, margin);
      const mem = this.x.memory.buffer;
      rgba.set(new Uint8Array(mem, oPtr, width * height * 4));
      cov.set(new Uint8Array(mem, cPtr, width * height));
      return rgba;
    } finally {
      this.x.rk_free(oPtr, rgba.byteLength);
      this.x.rk_free(cPtr, cov.byteLength);
    }
  }
}

/** Splits [0,height) into `count` chunks of whole rows. */
export function splitRows(height, count) {
  const per = Math.max(1, Math.ceil(height / Math.max(1, count)));
  const out = [];
  for (let y = 0; y < height; y += per) out.push([y, Math.min(height, y + per)]);
  return out;
}

export function canUseSharedArrayBuffer() {
  return typeof SharedArrayBuffer !== 'undefined' && typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated === true;
}

export class RenderPool {
  constructor(size = Math.max(1, Math.min(8, (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 4))) {
    this.size = size;
    this.workers = [];
    this._lastSignature = null;
    this._lastTriCount = 0;
    this._sab = null;
  }

  static supported() { return typeof Worker !== 'undefined'; }

  async ensureSharedFrame(width, height) {
    if (!canUseSharedArrayBuffer() || !this.workers.length) return null;
    if (this._sab && this._sab.width === width && this._sab.height === height) {
      return this._sab;
    }
    const n = width * height;
    const sab = {
      width,
      height,
      accum: new SharedArrayBuffer(n * 16),
      aov: new SharedArrayBuffer(n * AOV_STRIDE * 4),
      col: new SharedArrayBuffer(n * 16),
      tmp: new SharedArrayBuffer(n * 16),
      alb: new SharedArrayBuffer(n * 16),
      nrm: new SharedArrayBuffer(n * 16),
      meanA: new SharedArrayBuffer(n * 16),
      meanB: new SharedArrayBuffer(n * 16),
      prevAov: new SharedArrayBuffer(n * AOV_STRIDE * 4),
      rgba: new SharedArrayBuffer(n * 4),
    };
    await Promise.all(this.workers.map((w) => new Promise((resolve, reject) => {
      w.onmessage = (e) => (e.data.ok ? resolve() : reject(new Error(e.data.error)));
      w.postMessage({ type: 'attach-sab', sab });
    })));
    this._sab = sab;
    return sab;
  }

  async _createWorker(wasmBytes, packed) {
    const copy = (b) => (b instanceof ArrayBuffer ? b.slice(0) : b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
    return new Promise((resolve, reject) => {
      const w = new Worker(new URL('./rust-render-worker.js', import.meta.url), { type: 'module' });
      let settled = false;
      w.onmessage = (e) => {
        if (settled) return;
        settled = true;
        w.onerror = null;
        if (e.data?.ok) resolve(w);
        else reject(new Error(e.data?.error || 'Render worker init failed'));
      };
      w.onerror = (e) => {
        if (settled) return;
        settled = true;
        try { w.terminate(); } catch (_) {}
        reject(new Error(e.message || 'Render worker error'));
      };
      w.postMessage({ type: 'init', wasm: copy(wasmBytes), packed });
    });
  }

  async init(wasmBytes, packed) {
    this.workers = await Promise.all(Array.from({ length: this.size }, () => this._createWorker(wasmBytes, packed)));
    this._lastSignature = `${packed.triCount}:${packed.mats.length}:${packed.textures?.count || 0}`;
    this._lastTriCount = packed.triCount;
  }

  async updateScene(packed) {
    let canRefit = false;
    if (packed.refitOnly) {
      canRefit = Boolean(this._lastSignature && packed.triCount === this._lastTriCount);
    } else {
      const sig = `${packed.triCount}:${packed.mats?.length || 0}:${packed.textures?.count || 0}`;
      canRefit = this._lastSignature === sig;
      this._lastSignature = sig;
      this._lastTriCount = packed.triCount;
    }
    const msgType = canRefit ? 'refit' : 'load';
    await Promise.all(this.workers.map((w) => new Promise((resolve, reject) => {
      let settled = false;
      const fail = (err) => { if (!settled) { settled = true; reject(err); } };
      w.onmessage = (e) => { if (!settled) { settled = true; e.data?.ok ? resolve() : reject(new Error(e.data?.error || 'Worker scene update error')); } };
      w.onerror = (e) => fail(new Error(e.message || 'Render worker crashed during scene update'));
      w.onmessageerror = () => fail(new Error('Render worker message deserialization error'));
      w.postMessage({ type: msgType, packed });
    })));
  }

  run(tasks, msgType = 'rows') {
    return new Promise((resolve, reject) => {
      if (!tasks.length) { resolve([]); return; }
      if (!this.workers.length) { reject(new Error('No render workers initialized')); return; }
      const results = new Array(tasks.length);
      let next = 0, done = 0, settled = false;
      const failOnce = (err) => {
        if (settled) return;
        settled = true;
        reject(err instanceof Error ? err : new Error(String(err)));
      };
      const feed = (worker) => {
        if (settled || next >= tasks.length) return;
        const idx = next++;
        worker.onmessage = (e) => {
          if (settled) return;
          if (!e.data?.ok) return failOnce(new Error(e.data?.error || 'Render worker task failed'));
          results[idx] = e.data.result;
          if (++done === tasks.length) {
            settled = true;
            resolve(results);
          } else {
            feed(worker);
          }
        };
        worker.onerror = (e) => failOnce(new Error(e.message || 'Render worker error'));
        worker.onmessageerror = () => failOnce(new Error('Render worker message error'));
        worker.postMessage({ type: msgType, params: tasks[idx] });
      };
      this.workers.forEach(feed);
    });
  }

  dispose() {
    this.workers.forEach((w) => w.terminate());
    this.workers = [];
    this._lastSignature = null;
    this._lastTriCount = 0;
    this._sab = null;
  }
}

/**
 * Progressive render. `passSpp` samples per pass; each pass is split into row chunks.
 * Automatically uses zero-copy SharedArrayBuffer parallel denoise/temporal/tonemap across all Web Workers
 * when COOP/COEP cross-origin isolation is active, with seamless fallback to single-thread WASM resolve.
 * @returns {Promise<{rgba:Uint8ClampedArray,width:number,height:number,samples:number,ms:number,sabParallel?:boolean}|null>} null when aborted
 */
export async function renderRust(packed, opts = {}) {
  const {
    width, height, samples = 64, passSpp = 4, maxBounces = 5, clamp = 20, denoise = true,
    denoisePasses = 4, exposure = 1, tonemap = 'agx', tonemapLook = 'base', adaptiveThreshold = 0, seedOffset = 0, temporal = null,
    signal = null, onProgress = null, onPreview = null, threads = 0, wasmSource = null,
    pool: externalPool = null, kernel: externalKernel = null
  } = opts;
  if (!(width > 0 && height > 0)) throw new Error('Invalid render dimensions.');
  const started = Date.now();
  const bytes = externalKernel ? null : await loadKernelBytes(wasmSource);
  const main = externalKernel || await RenderKernel.create(bytes);
  let ownedPool = null;
  const useThreads = threads !== 1 && RenderPool.supported();
  let activePool = externalPool;
  if (useThreads) {
    if (activePool && activePool.workers.length > 0) {
      await activePool.updateScene(packed);
    } else if (activePool) {
      await activePool.init(bytes || await loadKernelBytes(wasmSource), packed);
    } else {
      ownedPool = new RenderPool(threads > 0 ? threads : undefined);
      await ownedPool.init(bytes, packed);
      activePool = ownedPool;
    }
  } else {
    if (!main.refitScene(packed)) main.loadScene(packed);
  }

  // Zero-copy SharedArrayBuffer parallel path (COOP/COEP active + worker pool)
  const sab = activePool ? await activePool.ensureSharedFrame(width, height) : null;
  if (sab && !onPreview) {
    let done = 0, pass = 0;
    try {
      while (done < samples) {
        if (signal?.aborted) return null;
        const spp = Math.min(passSpp, samples - done);
        const chunks = splitRows(height, activePool.size * 3);
        const tasks = chunks.map(([y0, y1]) => ({
          width, height, y0, y1, spp, seed: seedOffset + pass + 1, maxBounces, clamp, adaptiveThreshold,
          clearFirst: pass === 0,
        }));
        await activePool.run(tasks, 'rows-sab');
        done += spp;
        pass++;
        onProgress?.(done / samples, done);
      }

      if (signal?.aborted) return null;
      const bands = splitRows(height, activePool.size);
      if (denoise) {
        await activePool.run(bands.map(([y0, y1]) => ({ width, height, y0, y1, spp: samples })), 'denoise-prep-sab');
        let scaleInv2 = 1.0;
        for (let p = 0; p < Math.min(4, denoisePasses); p++) {
          const step = 1 << p;
          await activePool.run(
            bands.map(([y0, y1]) => ({ width, height, y0, y1, step, passScaleInv2: scaleInv2, vertical: false })),
            'denoise-step-sab'
          );
          await activePool.run(
            bands.map(([y0, y1]) => ({ width, height, y0, y1, step, passScaleInv2: scaleInv2, vertical: true })),
            'denoise-step-sab'
          );
          scaleInv2 *= 2.8;
        }
      }

      const useTemporal = Boolean(temporal);
      const hasPrev = Boolean(
        useTemporal &&
        temporal._sabReady &&
        temporal._sabWidth === width &&
        temporal._sabHeight === height
      );
      const curMeanSlot = useTemporal ? ((temporal._sabSlot || 0) & 1) : 0;
      const prevSpp = hasPrev ? (temporal._sabPrevSpp || samples) : samples;

      await activePool.run(
        bands.map(([y0, y1]) => ({ width, height, y0, y1, spp: samples, denoise, curMeanSlot })),
        'denoise-remod-sab'
      );
      await activePool.run(
        bands.map(([y0, y1]) => ({
          width, height, y0, y1, spp: samples, prevSpp,
          useTemporal, hasPrev, blend: temporal?.blend ?? 0.75,
          exposure, tonemap, tonemapLook, curMeanSlot,
        })),
        'finalize-sab'
      );
      if (useTemporal) {
        await activePool.run(
          bands.map(([y0, y1]) => ({ width, y0, y1, hasPrev, curMeanSlot })),
          'commit-temporal-sab'
        );
        temporal._sabReady = true;
        temporal._sabWidth = width;
        temporal._sabHeight = height;
        temporal._sabPrevSpp = samples;
        temporal._sabSlot = curMeanSlot ^ 1;
        temporal.state = { wasmResident: true, sabParallel: true, width, height, prevSpp: samples, prevMean: { length: width * height * 4 } };
      }
      const rgba = new Uint8ClampedArray(sab.rgba).slice();
      return { rgba, width, height, samples, ms: Date.now() - started, sabParallel: true };
    } finally {
      ownedPool?.dispose();
    }
  }

  // Standard fallback path (non-COOP hosts, Node tests, or progressive preview)
  if (useThreads && temporal) {
    if (!main.refitScene(packed)) main.loadScene(packed);
  }
  const accum = new Float32Array(width * height * 4);
  const aov = new Float32Array(width * height * AOV_STRIDE);
  let done = 0, pass = 0;
  try {
    while (done < samples) {
      if (signal?.aborted) return null;
      const spp = Math.min(passSpp, samples - done);
      const chunks = splitRows(height, activePool ? activePool.size * 3 : 1);
      const tasks = chunks.map(([y0, y1]) => ({
        width, height, y0, y1, spp, seed: seedOffset + pass + 1, maxBounces, clamp, adaptiveThreshold
      }));
      const parts = activePool ? await activePool.run(tasks) : tasks.map((t) => main.renderRows(t));
      for (const p of parts) {
        const ao = p.y0 * width * 4, go = p.y0 * width * AOV_STRIDE;
        for (let i = 0; i < p.accum.length; i++) accum[ao + i] += p.accum[i];
        for (let i = 0; i < p.aov.length; i++) aov[go + i] += p.aov[i];
      }
      done += spp;
      pass++;
      onProgress?.(done / samples, done);
      if (onPreview && (done < samples) && (pass === 1 || pass % 2 === 0)) {
        const previewRgba = main.resolve({ accum, aov, width, height, spp: done, denoise: false, exposure, tonemap, tonemapLook });
        onPreview({ rgba: previewRgba, width, height, samples: done });
      }
      if (!activePool) await new Promise((r) => setTimeout(r, 0));
    }
    const rgba = main.resolve({ accum, aov, width, height, spp: samples, denoise, denoisePasses, exposure, tonemap, tonemapLook, temporal });
    return { rgba, width, height, samples, ms: Date.now() - started, sabParallel: false };
  } finally {
    ownedPool?.dispose();
  }
}
