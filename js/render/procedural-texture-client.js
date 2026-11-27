/**
 * Web Blender Studio - Procedural Texture Client
 * Dispatches procedural texture generation to Web Worker, caches results by seed/options,
 * and converts pixel buffers into mipmapped, anisotropically-filtered THREE.DataTexture
 * maps (diffuse + Sobel normal + roughness) ready for crisp PBR slots at grazing angles.
 * File: js/render/procedural-texture-client.js
 */

import * as THREE from 'three';
import { executeProceduralGeneration } from './procedural-texture-worker.js';
import { textureLeaseRegistry } from './texture-lease-registry.js';

export class ProceduralTextureClient {
  /**
   * @param {Object} [options]
   * @param {string} [options.workerUrl]
   * @param {number} [options.maxAnisotropy=16]
   */
  constructor(options = {}) {
    this.workerUrl = options.workerUrl || null;
    this.maxAnisotropy = Math.max(1, Math.min(16, Number(options.maxAnisotropy) || 16));
    this.maxCacheEntries = Math.max(4, Math.min(64, Number(options.maxCacheEntries) || 24));
    this.maxCacheBytes = Math.max(16 * 1024 * 1024, Number(options.maxCacheBytes) || 128 * 1024 * 1024);
    this.cacheBytes = 0;
    this.worker = null;
    this.pending = new Map();
    this.cache = new Map();
    this._nextId = 1;

    this._initWorker();
  }

  _initWorker() {
    if (typeof Worker !== 'undefined') {
      try {
        this.worker = this.workerUrl
          ? new Worker(this.workerUrl, { type: 'module' })
          : new Worker(new URL('./procedural-texture-worker.js', import.meta.url), { type: 'module' });
        this.worker.onmessage = (e) => {
          const { id, width, height, rgbaBuffer, normalBuffer, roughnessBuffer, error } = e.data || {};
          const entry = this.pending.get(id);
          if (!entry) return;
          this.pending.delete(id);

          if (error) {
            entry.reject(new Error(error));
            return;
          }

          const rgba = new Uint8ClampedArray(rgbaBuffer);
          const normals = new Uint8ClampedArray(normalBuffer);
          const roughness = roughnessBuffer ? new Uint8ClampedArray(roughnessBuffer) : null;
          entry.resolve({ width, height, rgba, normals, roughness });
        };

        this.worker.onerror = (err) => {
          console.warn('[ProceduralTextureClient] Worker error; rejecting pending requests cleanly without main-thread freeze:', err?.message || err);
          const workerErr = new Error(`Procedural texture Worker error: ${err?.message || 'worker crashed'}`);
          try { this.worker?.terminate?.(); } catch (_) {}
          this.worker = null;
          for (const [id, entry] of [...this.pending.entries()]) {
            this.pending.delete(id);
            try { entry.reject(workerErr); } catch (_) {}
          }
        };
      } catch (err) {
        console.warn('[ProceduralTextureClient] Failed to initialize worker, fallback to in-thread:', err);
        this.worker = null;
      }
    }
  }

  getCacheKey(type, width, height, options = {}) {
    const normalized = {
      seed: 42,
      bumpIntensity: 1.5,
      ...options,
    };
    delete normalized.signal;
    const encodeVal = (v) => {
      if (v === undefined) return '"__undef__"';
      if (typeof v === 'number') {
        if (Number.isNaN(v)) return '"__NaN__"';
        if (v === Infinity) return '"__Inf__"';
        if (v === -Infinity) return '"__-Inf__"';
      }
      return JSON.stringify(v, (_, inner) => {
        if (typeof inner === 'number') {
          if (Number.isNaN(inner)) return '__NaN__';
          if (inner === Infinity) return '__Inf__';
          if (inner === -Infinity) return '__-Inf__';
        }
        return inner;
      });
    };
    const sorted = Object.keys(normalized)
      .sort()
      .map((k) => `${k}=${encodeVal(normalized[k])}`)
      .join('&');
    return `${String(type).toLowerCase()}_${width}x${height}_${sorted}`;
  }

  _configureMipmappedDataTexture(tex, isSrgb = false) {
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.generateMipmaps = true;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.anisotropy = this.maxAnisotropy;
    if (isSrgb && THREE.SRGBColorSpace) {
      tex.colorSpace = THREE.SRGBColorSpace;
    }
    tex.needsUpdate = true;
    return tex;
  }

  _buildBufferTexture(rgba, width, height, isSrgb = false) {
    if (
      typeof document !== 'undefined' &&
      typeof document.createElement === 'function' &&
      typeof ImageData !== 'undefined'
    ) {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        if (ctx) {
          const clamped = rgba instanceof Uint8ClampedArray
            ? rgba
            : new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, rgba.byteLength);
          ctx.putImageData(new ImageData(clamped, width, height), 0, 0);
          return this._configureMipmappedDataTexture(new THREE.CanvasTexture(canvas), isSrgb);
        }
      } catch (_) {}
    }
    return this._configureMipmappedDataTexture(
      new THREE.DataTexture(rgba, width, height, THREE.RGBAFormat, THREE.UnsignedByteType),
      isSrgb
    );
  }

  /**
   * Generates procedural PBR maps asynchronously.
   * @param {string} type 'noise' | 'voronoi' | 'brushed' | 'carbon' | 'ashlar_stone' | 'stucco_plaster' | 'roof_slates' | 'wood_grain' | 'checkered_marble' | 'stained_mosaic'
   * @param {number} width <= 2048
   * @param {number} height <= 2048
   * @param {Object} [options]
   */
  async generateTextureMaps(type, width = 512, height = 512, options = {}) {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
      throw new Error(`Invalid procedural texture dimensions: ${width}x${height}`);
    }
    if (width > 2048 || height > 2048) {
      throw new Error(`Requested size ${width}x${height} exceeds maximum budget of 2048x2048`);
    }
    const signal = options.signal || null;
    if (signal?.aborted) {
      throw Object.assign(new Error('Procedural texture generation aborted'), { name: 'AbortError' });
    }

    const cacheKey = this.getCacheKey(type, width, height, options);
    if (this.cache.has(cacheKey)) {
      const hit = this.cache.get(cacheKey);
      this.cache.delete(cacheKey);
      this.cache.set(cacheKey, hit);
      return hit;
    }

    // Deduplicate concurrent requests for the exact same cacheKey so cache & byte accounting never race
    if (!this._inFlight) this._inFlight = new Map();
    if (this._inFlight.has(cacheKey)) {
      const sharedPromise = this._inFlight.get(cacheKey);
      if (!signal) return sharedPromise;
      return new Promise((resolve, reject) => {
        const onAbort = () => reject(Object.assign(new Error('Procedural texture generation aborted'), { name: 'AbortError' }));
        if (signal.aborted) return onAbort();
        signal.addEventListener('abort', onAbort, { once: true });
        sharedPromise.then(
          (val) => { signal.removeEventListener('abort', onAbort); resolve(val); },
          (err) => { signal.removeEventListener('abort', onAbort); reject(err); }
        );
      });
    }

    const taskPromise = (async () => {
      let rawData;
      if (this.worker) {
        const id = this._nextId++;
        rawData = await new Promise((resolve, reject) => {
          const timeoutMs = Math.max(2000, Math.min(30000, Number(options.timeoutMs) || 8000));
          const cleanup = () => {
            clearTimeout(timer);
            if (signal) signal.removeEventListener('abort', onAbort);
          };
          const onAbort = () => {
            if (!this.pending.has(id)) return;
            this.pending.delete(id);
            cleanup();
            reject(Object.assign(new Error('Procedural texture generation aborted'), { name: 'AbortError' }));
          };
          const timer = setTimeout(() => {
            if (!this.pending.has(id)) return;
            const timeoutErr = new Error(`Procedural texture generation timed out after ${timeoutMs}ms (${type} ${width}x${height}).`);
            try { this.worker?.terminate?.(); } catch (_) {}
            this.worker = null;
            // Reject this request AND every other orphaned in-flight request on the terminated worker
            for (const [pid, req] of [...this.pending.entries()]) {
              this.pending.delete(pid);
              try {
                req.reject(pid === id ? timeoutErr : new Error('Procedural texture Worker terminated after sibling request timeout.'));
              } catch (_) {}
            }
          }, timeoutMs);
          if (signal) {
            if (signal.aborted) return onAbort();
            signal.addEventListener('abort', onAbort, { once: true });
          }
          const workerOpts = { ...options };
          delete workerOpts.signal; // AbortSignal is not structured-cloneable
          this.pending.set(id, {
            type,
            width,
            height,
            options: workerOpts,
            resolve: (val) => { cleanup(); resolve(val); },
            reject: (err) => { cleanup(); reject(err); },
          });
          try {
            this.worker.postMessage({ id, type, width, height, options: workerOpts });
          } catch (postErr) {
            this.pending.delete(id);
            cleanup();
            reject(postErr);
          }
        });
      } else {
        const res = executeProceduralGeneration(type, width, height, options);
        rawData = {
          width: res.width,
          height: res.height,
          rgba: res.rgba,
          normals: res.normals,
          roughness: res.roughness,
        };
      }

      if (signal?.aborted) {
        throw Object.assign(new Error('Procedural texture generation aborted'), { name: 'AbortError' });
      }

      const diffuseTexture = this._buildBufferTexture(rawData.rgba, rawData.width, rawData.height, true);
      const normalTexture = this._buildBufferTexture(rawData.normals, rawData.width, rawData.height, false);
      const roughnessTexture = rawData.roughness
        ? this._buildBufferTexture(rawData.roughness, rawData.width, rawData.height, false)
        : null;

      const retainRawInCache = !diffuseTexture.isCanvasTexture || options.keepRawBuffers === true;
      const mapCount = roughnessTexture ? 3 : 2;
      const estimatedBytes = Math.round(rawData.width * rawData.height * 4 * mapCount * 1.33);
      const cachedEntry = {
        diffuseTexture,
        normalTexture,
        roughnessTexture,
        rgba: retainRawInCache ? rawData.rgba : null,
        normals: retainRawInCache ? rawData.normals : null,
        roughness: retainRawInCache ? rawData.roughness : null,
        width: rawData.width,
        height: rawData.height,
        estimatedBytes,
        leases: 0,
      };

      // If key already populated concurrently, adjust byte accounting cleanly before overwrite
      if (this.cache.has(cacheKey)) {
        const prev = this.cache.get(cacheKey);
        this.cacheBytes = Math.max(0, this.cacheBytes - (prev?.estimatedBytes || 0));
        textureLeaseRegistry.unregisterCacheEntry(prev);
        this.cache.delete(cacheKey);
      }

      while (this.cache.size >= this.maxCacheEntries || (this.cacheBytes + estimatedBytes > this.maxCacheBytes && this.cache.size > 0)) {
        let evictedKey = null;
        for (const [k, entry] of this.cache.entries()) {
          if ((entry.leases || 0) <= 0) {
            evictedKey = k;
            break;
          }
        }
        if (!evictedKey) break;
        const oldest = this.cache.get(evictedKey);
        if (oldest) {
          this.cacheBytes = Math.max(0, this.cacheBytes - (oldest.estimatedBytes || 0));
          textureLeaseRegistry.unregisterCacheEntry(oldest);
          oldest.diffuseTexture?.dispose?.();
          oldest.normalTexture?.dispose?.();
          oldest.roughnessTexture?.dispose?.();
        }
        this.cache.delete(evictedKey);
      }
      textureLeaseRegistry.registerCacheEntry(cachedEntry);
      this.cache.set(cacheKey, cachedEntry);
      this.cacheBytes += estimatedBytes;
      return cachedEntry;
    })();

    this._inFlight.set(cacheKey, taskPromise);
    try {
      return await taskPromise;
    } finally {
      this._inFlight.delete(cacheKey);
    }
  }

  acquireLease(entryOrKey) {
    const entry = typeof entryOrKey === 'string' ? this.cache.get(entryOrKey) : entryOrKey;
    if (entry && typeof entry === 'object') {
      entry.leases = (entry.leases || 0) + 1;
      return entry.leases;
    }
    return 0;
  }

  releaseLease(entryOrKey) {
    const entry = typeof entryOrKey === 'string' ? this.cache.get(entryOrKey) : entryOrKey;
    if (entry && typeof entry === 'object') {
      entry.leases = Math.max(0, (entry.leases || 0) - 1);
      return entry.leases;
    }
    return 0;
  }

  clearCache({ force = false } = {}) {
    for (const [k, item] of [...this.cache.entries()]) {
      if (!force && (item.leases || 0) > 0) continue;
      this.cacheBytes = Math.max(0, this.cacheBytes - (item.estimatedBytes || 0));
      textureLeaseRegistry.unregisterCacheEntry(item);
      item.diffuseTexture?.dispose?.();
      item.normalTexture?.dispose?.();
      item.roughnessTexture?.dispose?.();
      this.cache.delete(k);
    }
    if (force) {
      this.cache.clear();
      this.cacheBytes = 0;
    }
  }

  dispose() {
    const disposedErr = Object.assign(new Error('ProceduralTextureClient disposed'), { name: 'AbortError' });
    for (const [, req] of this.pending.entries()) {
      try { req.reject?.(disposedErr); } catch (_) {}
    }
    this.pending.clear();
    if (this._inFlight) this._inFlight.clear();
    this.clearCache({ force: true });

    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
  }
}
