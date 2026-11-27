/**
 * @file video-kernel-bridge.js
 * @description High-performance WebAssembly bridge connecting video frames to the Rust Video Kernel
 * (`crates/video_kernel`, compiled with +simd128) for:
 * - Zero-alloc persistent-buffer row inverting (flip_y_rgba)
 * - BT.601 RGBA -> Planar YUV420p (I420)
 * - 64-bit FNV-1a deterministic frame hashing & frame-to-frame MAE motion diff
 * - Blender-style Metadata Burn-In Stamp (5x7 bitmap font rendered in Rust WASM)
 * - In-place color grading (exposure, contrast, saturation, vignette)
 * - Fast box-filter RGBA downscale for Render Window preview
 */

let wasmInstance = null;
let wasmExports = null;
let isInitializing = false;
let initPromise = null;

// Persistent WASM frame scratch buffer to avoid alloc/dealloc churn per frame
let scratchPtr = 0;
let scratchCap = 0;

function ensureScratch(size) {
  if (!wasmExports || !wasmExports.alloc_bytes || size <= 0) return 0;
  if (scratchPtr && scratchCap >= size) return scratchPtr;
  if (scratchPtr && wasmExports.dealloc_bytes) {
    wasmExports.dealloc_bytes(scratchPtr, scratchCap);
    scratchPtr = 0;
    scratchCap = 0;
  }
  const ptr = wasmExports.alloc_bytes(size);
  if (ptr) {
    scratchPtr = ptr;
    scratchCap = size;
  }
  return ptr;
}

/**
 * Initializes the Rust Video Kernel WASM module.
 * @param {string|ArrayBuffer} [wasmSource]
 * @returns {Promise<boolean>}
 */
export async function initVideoKernel(wasmSource = null) {
  if (wasmExports) return true;
  if (isInitializing) return initPromise;

  isInitializing = true;
  initPromise = (async () => {
    try {
      let bytes = null;

      if (typeof process !== 'undefined' && process.versions && process.versions.node) {
        const fs = await import('fs');
        const path = await import('path');
        const defaultPath = path.resolve(process.cwd(), 'vendor/wasm/video_kernel.wasm');
        const targetPath = typeof wasmSource === 'string' ? wasmSource : defaultPath;
        bytes = fs.readFileSync(targetPath);
      } else {
        const defaultUrl = new URL('../../vendor/wasm/video_kernel.wasm', import.meta.url).href;
        const targetUrl = typeof wasmSource === 'string' ? wasmSource : defaultUrl;

        if (wasmSource instanceof ArrayBuffer || wasmSource instanceof Uint8Array) {
          bytes = wasmSource;
        } else {
          const response = await fetch(targetUrl);
          if (!response.ok) throw new Error(`HTTP ${response.status} loading ${targetUrl}`);
          bytes = await response.arrayBuffer();
        }
      }

      const { instance } = await WebAssembly.instantiate(bytes, {});
      wasmInstance = instance;
      wasmExports = instance.exports;
      scratchPtr = 0;
      scratchCap = 0;

      return true;
    } catch (err) {
      console.warn('[VideoKernel] Failed to initialize Rust WASM Kernel; falling back to JS:', err.message);
      wasmExports = null;
      wasmInstance = null;
      return false;
    } finally {
      isInitializing = false;
    }
  })();

  return initPromise;
}

export function isVideoKernelReady() {
  return wasmExports !== null;
}

export function getVideoKernelVersion() {
  return wasmExports?.vk_version ? wasmExports.vk_version() : 0;
}

/**
 * Inverts RGBA row lines in-place (from WebGL bottom-to-top to video top-to-bottom).
 * Uses persistent Rust WASM memory buffer if available, otherwise fast JS fallback.
 */
export function flipYInPlace(rgba, width, height) {
  if (!rgba || width === 0 || height <= 1) return;

  if (wasmExports && wasmExports.alloc_bytes && wasmExports.flip_y_rgba) {
    const size = width * height * 4;
    const ptr = ensureScratch(size);
    if (ptr) {
      new Uint8Array(wasmExports.memory.buffer, ptr, size).set(rgba);
      wasmExports.flip_y_rgba(ptr, width, height);
      rgba.set(new Uint8Array(wasmExports.memory.buffer, ptr, size));
      return;
    }
  }

  // JS Fallback: row-by-row swap
  const rowBytes = width * 4;
  const temp = new Uint8Array(rowBytes);
  let top = 0;
  let bottom = height - 1;
  while (top < bottom) {
    const topStart = top * rowBytes;
    const bottomStart = bottom * rowBytes;
    temp.set(rgba.subarray(topStart, topStart + rowBytes));
    rgba.copyWithin(topStart, bottomStart, bottomStart + rowBytes);
    rgba.set(temp, bottomStart);
    top++;
    bottom--;
  }
}

/**
 * Converts RGBA to Planar YUV420p (I420).
 */
export function rgbaToYuv420p(rgba, width, height) {
  const ySize = width * height;
  const uvSize = (width / 2) * (height / 2);

  const yPlane = new Uint8Array(ySize);
  const uPlane = new Uint8Array(uvSize);
  const vPlane = new Uint8Array(uvSize);

  if (wasmExports && wasmExports.alloc_bytes && wasmExports.rgba_to_yuv420p) {
    const rgbaSize = width * height * 4;
    const rgbaPtr = wasmExports.alloc_bytes(rgbaSize);
    const yPtr = wasmExports.alloc_bytes(ySize);
    const uPtr = wasmExports.alloc_bytes(uvSize);
    const vPtr = wasmExports.alloc_bytes(uvSize);

    if (rgbaPtr && yPtr && uPtr && vPtr) {
      new Uint8Array(wasmExports.memory.buffer, rgbaPtr, rgbaSize).set(rgba);
      wasmExports.rgba_to_yuv420p(rgbaPtr, width, height, yPtr, uPtr, vPtr);
      const postMemoryU8 = new Uint8Array(wasmExports.memory.buffer);
      yPlane.set(postMemoryU8.subarray(yPtr, yPtr + ySize));
      uPlane.set(postMemoryU8.subarray(uPtr, uPtr + uvSize));
      vPlane.set(postMemoryU8.subarray(vPtr, vPtr + uvSize));

      wasmExports.dealloc_bytes(rgbaPtr, rgbaSize);
      wasmExports.dealloc_bytes(yPtr, ySize);
      wasmExports.dealloc_bytes(uPtr, uvSize);
      wasmExports.dealloc_bytes(vPtr, uvSize);
      return { yPlane, uPlane, vPlane };
    }
  }

  for (let r = 0; r < height; r++) {
    const rowOffset = r * width;
    const rgbaRow = rowOffset * 4;
    for (let c = 0; c < width; c++) {
      const px = rgbaRow + c * 4;
      yPlane[rowOffset + c] = Math.min(255, Math.max(0, (77 * rgba[px] + 150 * rgba[px + 1] + 29 * rgba[px + 2]) >> 8));
    }
  }

  const halfW = width / 2;
  const halfH = height / 2;
  for (let uvY = 0; uvY < halfH; uvY++) {
    const yTop = uvY * 2;
    const yBot = yTop + 1;
    const uvRow = uvY * halfW;
    for (let uvX = 0; uvX < halfW; uvX++) {
      const xLeft = uvX * 2;
      const xRight = xLeft + 1;
      const p0 = (yTop * width + xLeft) * 4;
      const p1 = (yTop * width + xRight) * 4;
      const p2 = (yBot * width + xLeft) * 4;
      const p3 = (yBot * width + xRight) * 4;
      const avgR = (rgba[p0] + rgba[p1] + rgba[p2] + rgba[p3]) >> 2;
      const avgG = (rgba[p0 + 1] + rgba[p1 + 1] + rgba[p2 + 1] + rgba[p3 + 1]) >> 2;
      const avgB = (rgba[p0 + 2] + rgba[p1 + 2] + rgba[p2 + 2] + rgba[p3 + 2]) >> 2;
      const uvIdx = uvRow + uvX;
      uPlane[uvIdx] = Math.min(255, Math.max(0, ((-43 * avgR - 84 * avgG + 128 * avgB) >> 8) + 128));
      vPlane[uvIdx] = Math.min(255, Math.max(0, ((128 * avgR - 107 * avgG - 21 * avgB) >> 8) + 128));
    }
  }
  return { yPlane, uPlane, vPlane };
}

/**
 * Computes 64-bit FNV-1a frame hash for determinism verification.
 * @returns {bigint}
 */
export function computeFrameHash(rgba) {
  if (!rgba || rgba.length === 0) return 0n;

  if (wasmExports && wasmExports.alloc_bytes && wasmExports.compute_frame_hash) {
    const size = rgba.length;
    const ptr = ensureScratch(size);
    if (ptr) {
      new Uint8Array(wasmExports.memory.buffer, ptr, size).set(rgba);
      const hash = wasmExports.compute_frame_hash(ptr, size);
      return BigInt.asUintN(64, BigInt(hash));
    }
  }

  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  for (let i = 0; i < rgba.length; i++) {
    hash ^= BigInt(rgba[i]);
    hash = (hash * prime) & 0xffffffffffffffffn;
  }
  return hash;
}

/**
 * Computes normalized Mean Absolute Error (0.0..1.0) between two equal-sized RGBA buffers in Rust WASM.
 */
export function computeFrameDiff(rgbaA, rgbaB) {
  if (!rgbaA || !rgbaB || rgbaA.length !== rgbaB.length || rgbaA.length < 4) return 0;
  const size = rgbaA.length;
  if (wasmExports && wasmExports.alloc_bytes && wasmExports.compute_frame_diff) {
    const pA = wasmExports.alloc_bytes(size);
    const pB = wasmExports.alloc_bytes(size);
    if (pA && pB) {
      const mem = new Uint8Array(wasmExports.memory.buffer);
      mem.set(rgbaA, pA);
      mem.set(rgbaB, pB);
      const diff = wasmExports.compute_frame_diff(pA, pB, size);
      wasmExports.dealloc_bytes(pA, size);
      wasmExports.dealloc_bytes(pB, size);
      return diff;
    }
  }
  let sum = 0;
  let count = 0;
  for (let i = 0; i + 3 < size; i += 4) {
    sum += Math.abs(rgbaA[i] - rgbaB[i]) + Math.abs(rgbaA[i + 1] - rgbaB[i + 1]) + Math.abs(rgbaA[i + 2] - rgbaB[i + 2]);
    count += 3;
  }
  return count ? sum / (count * 255) : 0;
}

/**
 * Applies Blender-style in-place color grading in Rust WASM (exposure, contrast, saturation, vignette).
 */
export function applyColorGradeInPlace(rgba, width, height, opts = {}) {
  if (!rgba || width <= 0 || height <= 0) return;
  const exposure = Number.isFinite(opts.exposure) ? opts.exposure : 1.0;
  const contrast = Number.isFinite(opts.contrast) ? opts.contrast : 1.0;
  const saturation = Number.isFinite(opts.saturation) ? opts.saturation : 1.0;
  const vignette = Number.isFinite(opts.vignette) ? opts.vignette : 0.0;
  if (
    Math.abs(exposure - 1) < 1e-4 &&
    Math.abs(contrast - 1) < 1e-4 &&
    Math.abs(saturation - 1) < 1e-4 &&
    vignette < 1e-4
  ) {
    return;
  }

  if (wasmExports && wasmExports.alloc_bytes && wasmExports.apply_color_grade_inplace) {
    const size = width * height * 4;
    const ptr = ensureScratch(size);
    if (ptr) {
      new Uint8Array(wasmExports.memory.buffer, ptr, size).set(rgba);
      wasmExports.apply_color_grade_inplace(ptr, width, height, exposure, contrast, saturation, vignette);
      rgba.set(new Uint8Array(wasmExports.memory.buffer, ptr, size));
      return;
    }
  }
}

/**
 * Renders Blender-style Metadata Burn-In Stamp directly into an RGBA buffer using Rust WASM.
 * @param {Uint8Array|Uint8ClampedArray} rgba
 * @param {number} width
 * @param {number} height
 * @param {string} text ASCII metadata string e.g. "F:0042 | 00:00:01:12 | CAM:Camera | RUST CYCLES"
 * @param {{ position?: 'bottom'|'top', scale?: number }} [opts]
 */
export function burnInMetadataInPlace(rgba, width, height, text, opts = {}) {
  if (!rgba || width < 32 || height < 24 || !text) return;
  const clean = String(text).replace(/[^\x20-\x7E]/g, ' ');
  if (!clean.length) return;

  if (wasmExports && wasmExports.alloc_bytes && wasmExports.burn_in_metadata_rgba) {
    const size = width * height * 4;
    const ptr = ensureScratch(size);
    const tPtr = wasmExports.alloc_bytes(clean.length);
    if (ptr && tPtr) {
      const mem = new Uint8Array(wasmExports.memory.buffer);
      mem.set(rgba, ptr);
      for (let i = 0; i < clean.length; i++) mem[tPtr + i] = clean.charCodeAt(i) & 0x7f;
      const pos = opts.position === 'top' ? 1 : 0;
      const scale = Math.max(0, Math.round(opts.scale || 0));
      wasmExports.burn_in_metadata_rgba(ptr, width, height, tPtr, clean.length, pos, scale);
      rgba.set(new Uint8Array(wasmExports.memory.buffer, ptr, size));
      wasmExports.dealloc_bytes(tPtr, clean.length);
      return;
    }
    if (tPtr) wasmExports.dealloc_bytes(tPtr, clean.length);
  }
}

/**
 * Fast box-filter RGBA downscale in Rust WASM for Render Window live preview.
 */
export function downscaleRgbaBox(src, sw, sh, dw, dh) {
  const dst = new Uint8ClampedArray(dw * dh * 4);
  if (!src || sw <= 0 || sh <= 0 || dw <= 0 || dh <= 0) return dst;

  if (wasmExports && wasmExports.alloc_bytes && wasmExports.downscale_rgba_box) {
    const sBytes = sw * sh * 4;
    const dBytes = dw * dh * 4;
    const sPtr = wasmExports.alloc_bytes(sBytes);
    const dPtr = wasmExports.alloc_bytes(dBytes);
    if (sPtr && dPtr) {
      new Uint8Array(wasmExports.memory.buffer, sPtr, sBytes).set(src);
      wasmExports.downscale_rgba_box(sPtr, sw, sh, dPtr, dw, dh);
      dst.set(new Uint8Array(wasmExports.memory.buffer, dPtr, dBytes));
      wasmExports.dealloc_bytes(sPtr, sBytes);
      wasmExports.dealloc_bytes(dPtr, dBytes);
      return dst;
    }
    if (sPtr) wasmExports.dealloc_bytes(sPtr, sBytes);
    if (dPtr) wasmExports.dealloc_bytes(dPtr, dBytes);
  }
  return dst;
}
