/**
 * Web Blender Studio - Material Studio & Procedural Texture Pipeline
 * Provides 16+ production-grade PBR material presets, procedural texture generators
 * (Perlin/Simplex Noise, Brushed Metal, Voronoi Cellular, Carbon Fiber Weave, Marble, Wood),
 * Tangent-space Normal Map generator (Sobel filter), and real-time material binding.
 * File: js/core/material-studio.js
 */

import * as THREE from 'three';
import { textureLeaseRegistry } from '../render/texture-lease-registry.js';

export class MaterialStudio {
  /**
   * @param {Object} [options]
   * @param {Object} [options.THREE]
   * @param {THREE.Scene} [options.scene]
   */
  constructor(options = {}) {
    this.THREE = options.THREE || THREE || (typeof window !== 'undefined' ? window.THREE : null);
    this.scene = options.scene || null;
    this._textureCache = new Map();
    this.activeMaterial = null;

    // Seeded random helper
    this._seed = 12345;
  }

  // =========================================================================
  // 1. PROCEDURAL TEXTURE GENERATION ENGINES (Perlin, Brushed, Voronoi, Carbon)
  // =========================================================================

  /**
   * Generates a 2D Perlin / Simplex Fractal Noise Map (fBm)
   * Perfect for natural organic bump, rock, dirt grunge, and micro-roughness.
   * @param {Object} [options]
   * @param {number} [options.width=512]
   * @param {number} [options.height=512]
   * @param {number} [options.scale=6.0]
   * @param {number} [options.octaves=4]
   * @param {number} [options.persistence=0.5]
   * @param {number} [options.lacunarity=2.0]
   * @param {string} [options.color1='#70757d']
   * @param {string} [options.color2='#1c1f24']
   * @returns {{canvas: HTMLCanvasElement, heightCanvas: HTMLCanvasElement, texture: THREE.CanvasTexture, normalMap: THREE.CanvasTexture}}
   */
  generateNoiseMap(options = {}) {
    const clampInt = (v, fb, lo, hi) => (Number.isFinite(Number(v)) ? Math.max(lo, Math.min(hi, Math.round(Number(v)))) : fb);
    const clampNum = (v, fb, lo, hi) => (Number.isFinite(Number(v)) ? Math.max(lo, Math.min(hi, Number(v))) : fb);
    const width = clampInt(options.width, 512, 32, 1024);
    const height = clampInt(options.height, 512, 32, 1024);
    const scale = clampNum(options.scale, 6.0, 0.5, 64);
    const octaves = clampInt(options.octaves, 4, 1, 8);
    const persistence = clampNum(options.persistence, 0.5, 0.05, 0.95);
    const lacunarity = clampNum(options.lacunarity, 2.0, 1.0, 4.0);
    const color1 = options.color1 || '#7a818c';
    const color2 = options.color2 || '#1c1f24';
    const seed = clampInt(options.seed, 42, 0, 1000000);

    const cacheKey = `noise_${width}_${height}_${scale}_${octaves}_${persistence}_${lacunarity}_${seed}_${color1}_${color2}`;
    if (this._textureCache.has(cacheKey)) {
      const hit = this._textureCache.get(cacheKey);
      // LRU refresh
      this._textureCache.delete(cacheKey);
      this._textureCache.set(cacheKey, hit);
      return hit;
    }
    if (this._textureCache.size >= 32) {
      const oldestKey = this._textureCache.keys().next().value;
      if (oldestKey !== undefined) this._textureCache.delete(oldestKey);
    }

    // Permutation table for gradient noise
    const perm = this._buildPermutationTable(seed);

    const grad = (hash, x, y) => {
      const h = hash & 7;
      const u = h < 4 ? x : y;
      const v = h < 4 ? y : x;
      return ((h & 1) === 0 ? u : -u) + ((h & 2) === 0 ? v : -v);
    };

    const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10); // Quintic curve

    const perlin2D = (x, y) => {
      const X = Math.floor(x) & 255;
      const Y = Math.floor(y) & 255;
      const xf = x - Math.floor(x);
      const yf = y - Math.floor(y);
      const u = fade(xf);
      const v = fade(yf);

      const aa = perm[perm[X] + Y];
      const ab = perm[perm[X] + Y + 1];
      const ba = perm[perm[X + 1] + Y];
      const bb = perm[perm[X + 1] + Y + 1];

      const x1 = (1 - u) * grad(aa, xf, yf) + u * grad(ba, xf - 1, yf);
      const x2 = (1 - u) * grad(ab, xf, yf - 1) + u * grad(bb, xf - 1, yf - 1);
      return (1 - v) * x1 + v * x2;
    };

    const fbm = (x, y) => {
      let total = 0;
      let freq = scale;
      let amp = 1.0;
      let maxAmp = 0;
      for (let i = 0; i < octaves; i++) {
        total += perlin2D(x * freq, y * freq) * amp;
        maxAmp += amp;
        amp *= persistence;
        freq *= lacunarity;
      }
      return (total / maxAmp) * 0.5 + 0.5; // Normalized to 0.0 - 1.0
    };

    const c1 = this._hexToRgb(color1);
    const c2 = this._hexToRgb(color2);

    // Diffuse Canvas
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    const imgData = ctx.createImageData(width, height);
    const data = imgData.data;

    // Height Canvas for Normal Map
    const hCanvas = document.createElement('canvas');
    hCanvas.width = width;
    hCanvas.height = height;
    const hCtx = hCanvas.getContext('2d');
    const hImgData = hCtx.createImageData(width, height);
    const hData = hImgData.data;

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const nx = x / width;
        const ny = y / height;
        const nVal = Math.min(1.0, Math.max(0.0, fbm(nx, ny)));

        const idx = (y * width + x) * 4;

        // Diffuse
        data[idx] = Math.round(c2.r + (c1.r - c2.r) * nVal);
        data[idx + 1] = Math.round(c2.g + (c1.g - c2.g) * nVal);
        data[idx + 2] = Math.round(c2.b + (c1.b - c2.b) * nVal);
        data[idx + 3] = 255;

        // Height (Grayscale)
        const b = Math.round(nVal * 255);
        hData[idx] = b;
        hData[idx + 1] = b;
        hData[idx + 2] = b;
        hData[idx + 3] = 255;
      }
    }

    ctx.putImageData(imgData, 0, 0);
    hCtx.putImageData(hImgData, 0, 0);

    const texture = new this.THREE.CanvasTexture(canvas);
    texture.wrapS = this.THREE.RepeatWrapping;
    texture.wrapT = this.THREE.RepeatWrapping;

    const normalMap = this.generateNormalMapFromCanvas(hCanvas, 2.0);

    const result = { canvas, heightCanvas: hCanvas, texture, normalMap };
    this._textureCache.set(cacheKey, result);
    return result;
  }

  /**
   * Generates a Brushed Metal Map with high-frequency directional scratches
   * Creates realistic anisotropic highlights on titanium, aluminum, and stainless steel.
   * @param {Object} [options]
   * @param {number} [options.width=512]
   * @param {number} [options.height=512]
   * @param {string} [options.direction='horizontal'] 'horizontal' | 'vertical'
   * @param {string} [options.baseColor='#8a95a5']
   * @returns {{canvas: HTMLCanvasElement, heightCanvas: HTMLCanvasElement, texture: THREE.CanvasTexture, normalMap: THREE.CanvasTexture}}
   */
  generateBrushedMetalMap(options = {}) {
    const {
      width = 512,
      height = 512,
      direction = 'horizontal',
      baseColor = '#8a95a5',
      seed = 777
    } = options;

    const cacheKey = `brushed_${width}_${height}_${direction}_${baseColor}_${seed}`;
    if (this._textureCache.has(cacheKey)) {
      return this._textureCache.get(cacheKey);
    }

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    const imgData = ctx.createImageData(width, height);
    const data = imgData.data;

    const hCanvas = document.createElement('canvas');
    hCanvas.width = width;
    hCanvas.height = height;
    const hCtx = hCanvas.getContext('2d');
    const hImgData = hCtx.createImageData(width, height);
    const hData = hImgData.data;

    const base = this._hexToRgb(baseColor);

    // Seeded random pseudo generator
    let s = seed;
    const pseudoRand = () => {
      s = (s * 9301 + 49297) % 233280;
      return s / 233280;
    };

    // Precompute random 1D streak heights
    const streakCount = direction === 'horizontal' ? height : width;
    const streaks = new Float32Array(streakCount);
    for (let i = 0; i < streakCount; i++) {
      streaks[i] = (pseudoRand() - 0.5) * 60;
    }

    // Secondary sub-streaks for ultra-fine microgrooves
    const microStreaks = new Float32Array(streakCount);
    for (let i = 0; i < streakCount; i++) {
      microStreaks[i] = (pseudoRand() - 0.5) * 35;
    }

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const streakIdx = direction === 'horizontal' ? y : x;
        const mainStreak = streaks[streakIdx];
        const micro = microStreaks[streakIdx];

        // Random subtle jitter along the scratch length
        const alongJitter = (pseudoRand() - 0.5) * 12;

        const val = Math.min(255, Math.max(0, 128 + mainStreak + micro + alongJitter));

        const idx = (y * width + x) * 4;

        // Diffuse
        data[idx] = Math.min(255, Math.max(0, base.r + (val - 128) * 0.45));
        data[idx + 1] = Math.min(255, Math.max(0, base.g + (val - 128) * 0.45));
        data[idx + 2] = Math.min(255, Math.max(0, base.b + (val - 128) * 0.45));
        data[idx + 3] = 255;

        // Height
        hData[idx] = val;
        hData[idx + 1] = val;
        hData[idx + 2] = val;
        hData[idx + 3] = 255;
      }
    }

    ctx.putImageData(imgData, 0, 0);
    hCtx.putImageData(hImgData, 0, 0);

    const texture = new this.THREE.CanvasTexture(canvas);
    texture.wrapS = this.THREE.RepeatWrapping;
    texture.wrapT = this.THREE.RepeatWrapping;

    // Normal map with high intensity for anisotropic specular highlights
    const normalMap = this.generateNormalMapFromCanvas(hCanvas, 2.5);

    const result = { canvas, heightCanvas: hCanvas, texture, normalMap };
    this._textureCache.set(cacheKey, result);
    return result;
  }

  /**
   * Generates a Voronoi Cellular Map (Worley noise)
   * Produces biological cells, reptile/snake scales, cracked mud, and organic leather.
   * @param {Object} [options]
   * @param {number} [options.width=512]
   * @param {number} [options.height=512]
   * @param {number} [options.cells=10] Number of cells per axis
   * @param {string} [options.mode='f1'] 'f1' (rounded cells) | 'f2_minus_f1' (cracked boundaries)
   * @param {string} [options.color1='#e2e8f0']
   * @param {string} [options.color2='#1a202c']
   * @returns {{canvas: HTMLCanvasElement, heightCanvas: HTMLCanvasElement, texture: THREE.CanvasTexture, normalMap: THREE.CanvasTexture}}
   */
  generateVoronoiMap(options = {}) {
    const clampInt = (v, fb, lo, hi) => (Number.isFinite(Number(v)) ? Math.max(lo, Math.min(hi, Math.round(Number(v)))) : fb);
    const width = clampInt(options.width, 512, 32, 1024);
    const height = clampInt(options.height, 512, 32, 1024);
    const cells = clampInt(options.cells, 10, 4, 64);
    const mode = options.mode || 'f1';
    const color1 = options.color1 || '#cbd5e1';
    const color2 = options.color2 || '#1e293b';
    const seed = clampInt(options.seed, 999, 0, 1000000);

    const cacheKey = `voronoi_${width}_${height}_${cells}_${mode}_${seed}_${color1}_${color2}`;
    if (this._textureCache.has(cacheKey)) {
      const hit = this._textureCache.get(cacheKey);
      this._textureCache.delete(cacheKey);
      this._textureCache.set(cacheKey, hit);
      return hit;
    }
    if (this._textureCache.size >= 32) {
      const oldestKey = this._textureCache.keys().next().value;
      if (oldestKey !== undefined) this._textureCache.delete(oldestKey);
    }

    // Generate grid points with jitter
    let s = seed;
    const pseudoRand = () => {
      s = (s * 9301 + 49297) % 233280;
      return s / 233280;
    };

    const numCells = Math.max(4, cells);
    const points = [];
    for (let gy = 0; gy < numCells; gy++) {
      points[gy] = [];
      for (let gx = 0; gx < numCells; gx++) {
        points[gy][gx] = {
          x: (gx + 0.15 + pseudoRand() * 0.70) / numCells,
          y: (gy + 0.15 + pseudoRand() * 0.70) / numCells
        };
      }
    }

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    const imgData = ctx.createImageData(width, height);
    const data = imgData.data;

    const hCanvas = document.createElement('canvas');
    hCanvas.width = width;
    hCanvas.height = height;
    const hCtx = hCanvas.getContext('2d');
    const hImgData = hCtx.createImageData(width, height);
    const hData = hImgData.data;

    const c1 = this._hexToRgb(color1);
    const c2 = this._hexToRgb(color2);

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const u = x / width;
        const v = y / height;

        const cellX = Math.floor(u * numCells);
        const cellY = Math.floor(v * numCells);

        let d1 = 999.0;
        let d2 = 999.0;

        // Check 3x3 neighbor grid with toroidal wrap
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const ny = (cellY + dy + numCells) % numCells;
            const nx = (cellX + dx + numCells) % numCells;
            const pt = points[ny][nx];

            let px = pt.x + (cellX + dx < 0 ? -1 : (cellX + dx >= numCells ? 1 : 0));
            let py = pt.y + (cellY + dy < 0 ? -1 : (cellY + dy >= numCells ? 1 : 0));

            const dist = Math.sqrt((u - px) * (u - px) + (v - py) * (v - py));
            if (dist < d1) {
              d2 = d1;
              d1 = dist;
            } else if (dist < d2) {
              d2 = dist;
            }
          }
        }

        let val = 0;
        if (mode === 'f2_minus_f1') {
          val = Math.min(1.0, (d2 - d1) * numCells * 1.5);
        } else {
          // f1: smooth rounded dome
          val = Math.max(0.0, 1.0 - d1 * numCells * 1.6);
          val = Math.sqrt(val); // hemispherical profile
        }

        const idx = (y * width + x) * 4;

        // Diffuse
        data[idx] = Math.round(c2.r + (c1.r - c2.r) * val);
        data[idx + 1] = Math.round(c2.g + (c1.g - c2.g) * val);
        data[idx + 2] = Math.round(c2.b + (c1.b - c2.b) * val);
        data[idx + 3] = 255;

        // Height
        const b = Math.round(val * 255);
        hData[idx] = b;
        hData[idx + 1] = b;
        hData[idx + 2] = b;
        hData[idx + 3] = 255;
      }
    }

    ctx.putImageData(imgData, 0, 0);
    hCtx.putImageData(hImgData, 0, 0);

    const texture = new this.THREE.CanvasTexture(canvas);
    texture.wrapS = this.THREE.RepeatWrapping;
    texture.wrapT = this.THREE.RepeatWrapping;

    const normalMap = this.generateNormalMapFromCanvas(hCanvas, 2.2);

    const result = { canvas, heightCanvas: hCanvas, texture, normalMap };
    this._textureCache.set(cacheKey, result);
    return result;
  }

  /**
   * Generates a 2x2 Twill Carbon Fiber Weave with 3D thread relief
   * Gives hyper-realistic racing / aerospace carbon composite reflections.
   * @param {Object} [options]
   * @param {number} [options.size=512]
   * @returns {{canvas: HTMLCanvasElement, heightCanvas: HTMLCanvasElement, texture: THREE.CanvasTexture, normalMap: THREE.CanvasTexture}}
   */
  generateCarbonFiberWeaveMap(options = {}) {
    const { size = 512 } = options;
    const cacheKey = `carbon_twill_${size}`;
    if (this._textureCache.has(cacheKey)) {
      return this._textureCache.get(cacheKey);
    }

    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    const imgData = ctx.createImageData(size, size);
    const data = imgData.data;

    const hCanvas = document.createElement('canvas');
    hCanvas.width = size;
    hCanvas.height = size;
    const hCtx = hCanvas.getContext('2d');
    const hImgData = hCtx.createImageData(size, size);
    const hData = hImgData.data;

    const step = 32; // Bundle size in pixels
    const filaments = 6; // Micro-threads per bundle

    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const bx = Math.floor(x / step);
        const by = Math.floor(y / step);

        // 2x2 Twill pattern matrix
        const isHorizontal = ((bx + by) % 4) < 2;

        const lx = x % step;
        const ly = y % step;

        let threadPos = 0;
        if (isHorizontal) {
          threadPos = (ly / step) * filaments;
        } else {
          threadPos = (lx / step) * filaments;
        }

        // Sinusoidal filament bump profile
        const filamentFrac = (threadPos % 1) - 0.5;
        const filamentBump = Math.cos(filamentFrac * Math.PI);

        // Main bundle dome curvature
        const bundleFrac = isHorizontal ? (ly / step - 0.5) : (lx / step - 0.5);
        const bundleDome = Math.cos(bundleFrac * Math.PI);

        const heightVal = Math.min(255, Math.max(0, Math.floor((bundleDome * 0.7 + filamentBump * 0.3) * 255)));

        const idx = (y * size + x) * 4;

        // Diffuse: Dark carbon weave with anisotropic thread shading
        const tone = isHorizontal ? 24 : 16;
        const threadShade = Math.floor((heightVal / 255.0) * 22);

        data[idx] = tone + threadShade;
        data[idx + 1] = tone + 3 + threadShade;
        data[idx + 2] = tone + 6 + threadShade;
        data[idx + 3] = 255;

        // Height
        hData[idx] = heightVal;
        hData[idx + 1] = heightVal;
        hData[idx + 2] = heightVal;
        hData[idx + 3] = 255;
      }
    }

    ctx.putImageData(imgData, 0, 0);
    hCtx.putImageData(hImgData, 0, 0);

    const texture = new this.THREE.CanvasTexture(canvas);
    texture.wrapS = this.THREE.RepeatWrapping;
    texture.wrapT = this.THREE.RepeatWrapping;

    const normalMap = this.generateNormalMapFromCanvas(hCanvas, 2.5);

    const result = { canvas, heightCanvas: hCanvas, texture, normalMap };
    this._textureCache.set(cacheKey, result);
    return result;
  }

  /**
   * Generates procedural skin micro-pore and epidermal noise
   */
  generateSkinTexture(width = 512, height = 512, baseColor = '#eac3ad') {
    const key = `skin_${width}_${height}_${baseColor}`;
    if (this._textureCache.has(key)) return this._textureCache.get(key);

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');

    ctx.fillStyle = baseColor;
    ctx.fillRect(0, 0, width, height);

    const img = ctx.getImageData(0, 0, width, height);
    const data = img.data;
    for (let i = 0; i < data.length; i += 4) {
      const n = (Math.random() - 0.5) * 16;
      const pore = Math.random() < 0.06 ? -22 : 0;
      data[i] = Math.min(255, Math.max(0, data[i] + n + pore));
      data[i + 1] = Math.min(255, Math.max(0, data[i + 1] + n * 0.8 + pore));
      data[i + 2] = Math.min(255, Math.max(0, data[i + 2] + n * 0.6 + pore));
    }
    ctx.putImageData(img, 0, 0);

    const tex = new this.THREE.CanvasTexture(canvas);
    tex.wrapS = this.THREE.RepeatWrapping;
    tex.wrapT = this.THREE.RepeatWrapping;
    this._textureCache.set(key, tex);
    return tex;
  }

  /**
   * Generates procedural carbon fiber weave texture (legacy compatibility)
   */
  generateCarbonFiberTexture(size = 256) {
    const res = this.generateCarbonFiberWeaveMap({ size });
    return res.texture;
  }

  /**
   * Generates procedural wood grain texture
   */
  generateWoodTexture(width = 512, height = 512) {
    const key = `wood_${width}_${height}`;
    if (this._textureCache.has(key)) return this._textureCache.get(key);

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');

    const img = ctx.createImageData(width, height);
    const data = img.data;

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const nx = x / width;
        const ny = y / height;
        const dist = Math.sqrt(Math.pow(nx - 0.5, 2) + Math.pow(ny - 0.5, 2) * 4);
        const ring = Math.sin(dist * 45 + Math.sin(ny * 25) * 1.5);
        const val = Math.floor((ring + 1) * 0.5 * 45);

        const idx = (y * width + x) * 4;
        data[idx] = 145 + val;     // R (warm brown)
        data[idx + 1] = 95 + val;  // G
        data[idx + 2] = 55 + val;  // B
        data[idx + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);

    const tex = new this.THREE.CanvasTexture(canvas);
    tex.wrapS = this.THREE.RepeatWrapping;
    tex.wrapT = this.THREE.RepeatWrapping;
    this._textureCache.set(key, tex);
    return tex;
  }

  /**
   * Generates procedural marble stone texture
   */
  generateMarbleTexture(width = 512, height = 512) {
    const key = `marble_${width}_${height}`;
    if (this._textureCache.has(key)) return this._textureCache.get(key);

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');

    const img = ctx.createImageData(width, height);
    const data = img.data;

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const nx = x / width;
        const ny = y / height;
        const vein = Math.sin(nx * 15 + Math.sin(ny * 20) * 2.2);
        const intensity = Math.pow(Math.abs(vein), 4) * 110;

        const idx = (y * width + x) * 4;
        const base = 215 - intensity;
        data[idx] = base;
        data[idx + 1] = base + 5;
        data[idx + 2] = base + 12;
        data[idx + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);

    const tex = new this.THREE.CanvasTexture(canvas);
    tex.wrapS = this.THREE.RepeatWrapping;
    tex.wrapT = this.THREE.RepeatWrapping;
    this._textureCache.set(key, tex);
    return tex;
  }

  // =========================================================================
  // 2. NORMAL MAP GENERATOR (High-Precision Sobel Filter)
  // =========================================================================

  /**
   * Generates procedural Tangent-space Normal map from heightmap canvas via Sobel filter
   * Normal vector: (R = -dX, G = -dY, B = +Z), flat surface = (128, 128, 255)
   * @param {HTMLCanvasElement} srcCanvas
   * @param {number} [intensity=1.5]
   * @returns {THREE.CanvasTexture}
   */
  generateNormalMapFromCanvas(srcCanvas, intensity = 1.5) {
    const w = srcCanvas.width;
    const h = srcCanvas.height;
    const srcCtx = srcCanvas.getContext('2d');
    const srcImg = srcCtx.getImageData(0, 0, w, h);
    const sData = srcImg.data;

    const outCanvas = document.createElement('canvas');
    outCanvas.width = w;
    outCanvas.height = h;
    const outCtx = outCanvas.getContext('2d');
    const outImg = outCtx.createImageData(w, h);
    const oData = outImg.data;

    const getH = (x, y) => {
      const px = (x + w) % w; // Toroidal repeat
      const py = (y + h) % h;
      const i = (py * w + px) * 4;
      return (sData[i] + sData[i + 1] + sData[i + 2]) / (3.0 * 255.0);
    };

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        // 3x3 Sobel kernel convolution
        const dX = (getH(x + 1, y - 1) + 2 * getH(x + 1, y) + getH(x + 1, y + 1)) -
                   (getH(x - 1, y - 1) + 2 * getH(x - 1, y) + getH(x - 1, y + 1));
        const dY = (getH(x - 1, y + 1) + 2 * getH(x, y + 1) + getH(x + 1, y + 1)) -
                   (getH(x - 1, y - 1) + 2 * getH(x, y - 1) + getH(x + 1, y - 1));

        // OpenGL Tangent Space Normal Vector
        let nx = -dX * intensity;
        let ny = -dY * intensity;
        let nz = 1.0;
        const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
        nx /= len;
        ny /= len;
        nz /= len;

        const idx = (y * w + x) * 4;
        oData[idx] = Math.floor((nx * 0.5 + 0.5) * 255);
        oData[idx + 1] = Math.floor((ny * 0.5 + 0.5) * 255);
        oData[idx + 2] = Math.floor((nz * 0.5 + 0.5) * 255);
        oData[idx + 3] = 255;
      }
    }
    outCtx.putImageData(outImg, 0, 0);

    const tex = new this.THREE.CanvasTexture(outCanvas);
    tex.wrapS = this.THREE.RepeatWrapping;
    tex.wrapT = this.THREE.RepeatWrapping;
    return tex;
  }

  // =========================================================================
  // 3. UNIFIED PROCEDURAL TEXTURE API
  // =========================================================================

  /**
   * Unified generator for any procedural texture type
   * @param {string} type 'noise'|'perlin'|'brushed'|'brushed_metal'|'voronoi'|'carbon'|'wood'|'marble'
   * @param {Object} [options]
   * @returns {{texture: THREE.CanvasTexture, normalMap: THREE.CanvasTexture, canvas: HTMLCanvasElement}}
   */
  generateProceduralTexture(type, options = {}) {
    const t = String(type).toLowerCase().replace(/[-_]/g, '');

    switch (t) {
      case 'noise':
      case 'perlin':
        return this.generateNoiseMap(options);

      case 'brushed':
      case 'brushedmetal':
        return this.generateBrushedMetalMap(options);

      case 'voronoi':
      case 'cellular':
        return this.generateVoronoiMap(options);

      case 'carbon':
      case 'carbonfiber':
      case 'carbonfiberweave':
        return this.generateCarbonFiberWeaveMap(options);

      case 'marble': {
        const tex = this.generateMarbleTexture(options.width || 512, options.height || 512);
        const norm = this.generateNormalMapFromCanvas(tex.image, options.bumpIntensity || 1.2);
        return { texture: tex, normalMap: norm, canvas: tex.image };
      }

      case 'wood': {
        const tex = this.generateWoodTexture(options.width || 512, options.height || 512);
        const norm = this.generateNormalMapFromCanvas(tex.image, options.bumpIntensity || 1.5);
        return { texture: tex, normalMap: norm, canvas: tex.image };
      }

      default:
        console.warn(`[MaterialStudio] Unknown procedural texture type: ${type}`);
        return this.generateNoiseMap(options);
    }
  }

  /**
   * Applies procedural map(s) to a target Mesh or Group
   * @param {THREE.Mesh|THREE.Group} target
   * @param {string} mapSlot 'normalMap' | 'map' | 'roughnessMap' | 'all'
   * @param {string} textureType 'noise' | 'brushed' | 'voronoi' | 'carbon' | 'marble' | 'wood' | 'none'
   * @param {Object} [options]
   * @param {number} [options.repeat=4] UV Repeat
   * @param {number} [options.bumpIntensity=1.0] Normal scale strength
   */
  applyProceduralMap(target, mapSlot = 'normalMap', textureType = 'brushed', options = {}) {
    if (!target) return null;

    const repeat = options.repeat !== undefined ? Number(options.repeat) : 4;
    const bumpIntensity = options.bumpIntensity !== undefined ? Number(options.bumpIntensity) : 1.0;

    const applyToMaterial = (mat) => {
      if (!mat) return;

      if (textureType === 'none') {
        // Clear maps
        if (mapSlot === 'normalMap' || mapSlot === 'all') {
          mat.normalMap = null;
        }
        if (mapSlot === 'map' || mapSlot === 'all') {
          mat.map = null;
        }
        if (mapSlot === 'roughnessMap' || mapSlot === 'all') {
          mat.roughnessMap = null;
        }
        mat.needsUpdate = true;
        if (mat.userData) {
          mat.userData.proceduralMap = null;
        }
        return;
      }

      const proc = this.generateProceduralTexture(textureType, options);
      if (!proc) return;

      const cloneWithRepeat = (tex) => {
        if (!tex) return null;
        const cloned = tex.clone();
        cloned.image = tex.image;
        cloned.wrapS = this.THREE.RepeatWrapping;
        cloned.wrapT = this.THREE.RepeatWrapping;
        cloned.repeat.set(repeat, repeat);
        cloned.needsUpdate = true;
        return cloned;
      };

      if (mapSlot === 'normalMap' || mapSlot === 'all') {
        mat.normalMap = cloneWithRepeat(proc.normalMap);
        if (!mat.normalScale) {
          mat.normalScale = new this.THREE.Vector2(bumpIntensity, bumpIntensity);
        } else {
          mat.normalScale.set(bumpIntensity, bumpIntensity);
        }
      }

      if (mapSlot === 'map' || mapSlot === 'all') {
        mat.map = cloneWithRepeat(proc.texture);
      }

      if (mapSlot === 'roughnessMap') {
        let rCanvas = proc.roughnessCanvas || null;
        if (!rCanvas && proc.heightCanvas && typeof document !== 'undefined') {
          // Derive a physically calibrated linear roughness map (inverted cavity roughness [0.25..0.88]) instead of raw height
          rCanvas = document.createElement('canvas');
          rCanvas.width = proc.heightCanvas.width;
          rCanvas.height = proc.heightCanvas.height;
          const rCtx = rCanvas.getContext('2d');
          const hCtx = proc.heightCanvas.getContext('2d');
          if (rCtx && hCtx) {
            const hData = hCtx.getImageData(0, 0, rCanvas.width, rCanvas.height);
            const rImg = rCtx.createImageData(rCanvas.width, rCanvas.height);
            const src = hData.data;
            const dst = rImg.data;
            for (let i = 0; i < src.length; i += 4) {
              const hNorm = src[i] / 255;
              const roughVal = Math.round((0.88 - hNorm * 0.63) * 255);
              dst[i] = roughVal;
              dst[i + 1] = roughVal;
              dst[i + 2] = roughVal;
              dst[i + 3] = 255;
            }
            rCtx.putImageData(rImg, 0, 0);
            proc.roughnessCanvas = rCanvas;
          }
        }
        const rTex = rCanvas ? new this.THREE.CanvasTexture(rCanvas) : cloneWithRepeat(proc.texture);
        if (rTex) {
          rTex.wrapS = this.THREE.RepeatWrapping;
          rTex.wrapT = this.THREE.RepeatWrapping;
          rTex.repeat.set(repeat, repeat);
          if (this.THREE.NoColorSpace) rTex.colorSpace = this.THREE.NoColorSpace;
          rTex.needsUpdate = true;
        }
        mat.roughnessMap = rTex;
      }

      mat.userData = mat.userData || {};
      mat.userData.proceduralMap = {
        type: textureType,
        slot: mapSlot,
        repeat,
        bumpIntensity
      };

      mat.needsUpdate = true;
    };

    if (target.isMesh) {
      const mats = Array.isArray(target.material) ? target.material : [target.material];
      mats.forEach(applyToMaterial);
    } else if (target.isGroup) {
      target.traverse((child) => {
        if (child.isMesh && child.material) {
          const mats = Array.isArray(child.material) ? child.material : [child.material];
          mats.forEach(applyToMaterial);
        }
      });
    }

    if (typeof window !== 'undefined' && window.engine?.sceneManager?.requestRender) {
      window.engine.sceneManager.requestRender();
    }

    return target;
  }

  /**
   * Upgrades a material (e.g. MeshStandardMaterial) to MeshPhysicalMaterial,
   * preserving all base PBR properties, textures, maps, and applying new physical parameters.
   * @param {THREE.Material} mat
   * @param {Object} [props] transmission, ior, thickness, clearcoat, sheen, etc.
   * @returns {THREE.MeshPhysicalMaterial}
   */
  upgradeToPhysicalMaterial(mat, props = {}) {
    const THREE = this.THREE;
    if (!mat) return new THREE.MeshPhysicalMaterial(props);

    if (mat.isMeshPhysicalMaterial) {
      Object.assign(mat, props);
      if (mat.transmission > 0 && !mat.transparent) {
        mat.transparent = true;
      }
      mat.needsUpdate = true;
      return mat;
    }

    const physical = new THREE.MeshPhysicalMaterial({
      color: mat.color ? mat.color.clone() : new THREE.Color(0xcccccc),
      roughness: mat.roughness !== undefined ? mat.roughness : 0.5,
      metalness: mat.metalness !== undefined ? mat.metalness : 0.0,
      map: mat.map || null,
      roughnessMap: mat.roughnessMap || null,
      metalnessMap: mat.metalnessMap || null,
      normalMap: mat.normalMap || null,
      normalScale: mat.normalScale ? mat.normalScale.clone() : new THREE.Vector2(1, 1),
      emissive: mat.emissive ? mat.emissive.clone() : new THREE.Color(0x000000),
      emissiveIntensity: mat.emissiveIntensity !== undefined ? mat.emissiveIntensity : 1.0,
      emissiveMap: mat.emissiveMap || null,
      aoMap: mat.aoMap || null,
      aoMapIntensity: mat.aoMapIntensity !== undefined ? mat.aoMapIntensity : 1.0,
      bumpMap: mat.bumpMap || null,
      bumpScale: mat.bumpScale !== undefined ? mat.bumpScale : 1.0,
      displacementMap: mat.displacementMap || null,
      displacementScale: mat.displacementScale !== undefined ? mat.displacementScale : 1.0,
      displacementBias: mat.displacementBias !== undefined ? mat.displacementBias : 0.0,
      lightMap: mat.lightMap || null,
      lightMapIntensity: mat.lightMapIntensity !== undefined ? mat.lightMapIntensity : 1.0,
      envMap: mat.envMap || null,
      envMapIntensity: mat.envMapIntensity !== undefined ? mat.envMapIntensity : 1.0,
      alphaMap: mat.alphaMap || null,
      alphaTest: mat.alphaTest || 0,
      vertexColors: !!mat.vertexColors,
      wireframe: !!mat.wireframe,
      flatShading: !!mat.flatShading,
      side: mat.side !== undefined ? mat.side : THREE.FrontSide,
      transparent: mat.transparent !== undefined ? mat.transparent : false,
      opacity: mat.opacity !== undefined ? mat.opacity : 1.0,
      name: mat.name || 'Principled BSDF',
      ...props
    });

    if (mat.userData) {
      try {
        physical.userData = JSON.parse(JSON.stringify(mat.userData));
      } catch (e) {
        physical.userData = { ...mat.userData };
      }
    }

    if (physical.transmission > 0 && !physical.transparent) {
      physical.transparent = true;
    }

    textureLeaseRegistry.transfer(mat, physical);
    physical.needsUpdate = true;
    return physical;
  }

  // =========================================================================
  // 4. 16+ INDUSTRIAL PBR MATERIAL PRESETS
  // =========================================================================

  /**
   * Returns dictionary of available material preset definitions
   */
  getMaterialPresets() {
    const THREE = this.THREE;

    return {
      car_paint_red: {
        name: 'Candy Apple Red Car Paint',
        category: 'Automotive',
        icon: '🚗',
        color: 0xb91c1c,
        swatch: 'radial-gradient(circle at 35% 30%, #fda4af, #b91c1c 55%, #450a0a)',
        create: () => new THREE.MeshPhysicalMaterial({
          color: 0xb91c1c,
          roughness: 0.18,
          metalness: 0.85,
          clearcoat: 1.0,
          clearcoatRoughness: 0.06,
        })
      },
      velvet_royal: {
        name: 'Midnight Velvet',
        category: 'Fabric',
        icon: '👗',
        color: 0x1e1b4b,
        swatch: 'radial-gradient(circle at 35% 30%, #a5b4fc, #312e81 58%, #0f0d2e)',
        create: () => new THREE.MeshPhysicalMaterial({
          color: 0x1e1b4b,
          roughness: 0.88,
          metalness: 0.0,
          sheen: 1.0,
          sheenRoughness: 0.4,
          sheenColor: new THREE.Color(0x818cf8),
        })
      },
      water_pool: {
        name: 'Pool Water',
        category: 'Liquid',
        icon: '🌊',
        color: 0x38bdf8,
        swatch: 'radial-gradient(circle at 35% 30%, #e0f2fe, #38bdf8 55%, #0369a1)',
        create: () => new THREE.MeshPhysicalMaterial({
          color: 0x38bdf8,
          roughness: 0.06,
          metalness: 0.0,
          transmission: 0.92,
          ior: 1.333,
          thickness: 2.0,
          transparent: true,
        })
      },
      skin_realistic: {
        name: 'Subsurface Skin',
        category: 'Organic',
        icon: '👤',
        color: 0xe8beac,
        swatch: 'radial-gradient(circle at 35% 30%, #ffe4d6, #e8beac 62%, #9c6b56)',
        create: () => new THREE.MeshPhysicalMaterial({
          color: 0xe8beac,
          roughness: 0.52,
          metalness: 0.0,
          clearcoat: 0.22,
          clearcoatRoughness: 0.32,
          sheen: 0.85,
          sheenColor: new THREE.Color(0xff8066),
          sheenRoughness: 0.45
        })
      },
      skin_tan: {
        name: 'Tan Skin SSS',
        category: 'Organic',
        icon: '🏽',
        color: 0xb57a58,
        swatch: 'radial-gradient(circle at 35% 30%, #e0a989, #b57a58 62%, #6e4228)',
        create: () => new THREE.MeshPhysicalMaterial({
          color: 0xb57a58,
          roughness: 0.48,
          metalness: 0.0,
          clearcoat: 0.25,
          clearcoatRoughness: 0.28,
          sheen: 0.8,
          sheenColor: new THREE.Color(0xcc6045)
        })
      },
      gold_24k: {
        name: '24K Royal Gold',
        category: 'Metal',
        icon: '🪙',
        color: 0xffd700,
        swatch: 'radial-gradient(circle at 35% 30%, #fffbeb, #fbbf24 55%, #92400e)',
        create: () => new THREE.MeshStandardMaterial({
          color: 0xffd700,
          roughness: 0.15,
          metalness: 0.95
        })
      },
      chrome_mirror: {
        name: 'Mirror Chrome',
        category: 'Metal',
        icon: '🪞',
        color: 0xf5f6fa,
        swatch: 'radial-gradient(circle at 35% 30%, #ffffff, #cbd5e1 50%, #334155)',
        create: () => new THREE.MeshStandardMaterial({
          color: 0xf5f6fa,
          roughness: 0.03,
          metalness: 1.0
        })
      },
      brushed_titanium: {
        name: 'Brushed Titanium',
        category: 'Metal',
        icon: '⚙️',
        color: 0x959ea8,
        swatch: 'radial-gradient(circle at 35% 30%, #e2e8f0, #94a3b8 60%, #334155)',
        create: () => {
          const mat = new THREE.MeshStandardMaterial({
            color: 0x959ea8,
            roughness: 0.32,
            metalness: 0.90
          });
          const brushed = this.generateBrushedMetalMap({ direction: 'horizontal', baseColor: '#959ea8' });
          brushed.normalMap.repeat.set(4, 4);
          mat.normalMap = brushed.normalMap;
          mat.normalScale = new THREE.Vector2(1.2, 1.2);
          return mat;
        }
      },
      glass_crystal: {
        name: 'Crystal Glass',
        category: 'Transparent',
        icon: '💎',
        color: 0xbae6fd,
        swatch: 'radial-gradient(circle at 35% 30%, #ffffff, #bae6fd 60%, #0284c7)',
        create: () => new THREE.MeshPhysicalMaterial({
          color: 0xffffff,
          roughness: 0.04,
          metalness: 0.0,
          transmission: 0.98,
          ior: 1.52,
          thickness: 1.5,
          transparent: true,
          opacity: 1.0
        })
      },
      water_surface: {
        name: 'Clear Water Surface',
        category: 'Transparent',
        icon: '💧',
        color: 0x22a6b3,
        swatch: 'radial-gradient(circle at 35% 30%, #a5f3fc, #06b6d4 65%, #164e63)',
        create: () => {
          const mat = new THREE.MeshPhysicalMaterial({
            color: 0x22a6b3,
            roughness: 0.08,
            metalness: 0.05,
            transmission: 0.88,
            transparent: true,
            opacity: 0.88
          });
          const vor = this.generateVoronoiMap({ cells: 12, mode: 'f1' });
          vor.normalMap.repeat.set(6, 6);
          mat.normalMap = vor.normalMap;
          mat.normalScale = new THREE.Vector2(0.8, 0.8);
          return mat;
        }
      },
      carbon_fiber: {
        name: 'Carbon Fiber Weave',
        category: 'Composite',
        icon: '🏁',
        color: 0x202428,
        swatch: 'radial-gradient(circle at 35% 30%, #64748b, #1e293b 65%, #090d16)',
        create: () => {
          const mat = new THREE.MeshStandardMaterial({
            color: 0xffffff,
            roughness: 0.28,
            metalness: 0.70
          });
          const carbon = this.generateCarbonFiberWeaveMap({ size: 512 });
          carbon.texture.repeat.set(8, 8);
          carbon.normalMap.repeat.set(8, 8);
          if (THREE.SRGBColorSpace) carbon.texture.colorSpace = THREE.SRGBColorSpace;
          mat.map = carbon.texture;
          mat.normalMap = carbon.normalMap;
          mat.normalScale = new THREE.Vector2(1.5, 1.5);
          return mat;
        }
      },
      wood_polished: {
        name: 'Polished Oak Wood',
        category: 'Architectural',
        icon: '🪵',
        color: 0xb57845,
        swatch: 'radial-gradient(circle at 35% 30%, #d97706, #92400e 65%, #451a03)',
        create: () => {
          const mat = new THREE.MeshStandardMaterial({
            color: 0xffffff,
            roughness: 0.38,
            metalness: 0.05
          });
          mat.map = this.generateWoodTexture(512, 512);
          if (mat.map && THREE.SRGBColorSpace) mat.map.colorSpace = THREE.SRGBColorSpace;
          return mat;
        }
      },
      marble_white: {
        name: 'White Marble',
        category: 'Architectural',
        icon: '🏛️',
        color: 0xf5f5f7,
        swatch: 'radial-gradient(circle at 35% 30%, #ffffff, #e2e8f0 70%, #94a3b8)',
        create: () => {
          const mat = new THREE.MeshPhysicalMaterial({
            color: 0xffffff,
            roughness: 0.20,
            metalness: 0.05,
            clearcoat: 0.45,
            clearcoatRoughness: 0.15
          });
          mat.map = this.generateMarbleTexture(512, 512);
          if (mat.map && THREE.SRGBColorSpace) mat.map.colorSpace = THREE.SRGBColorSpace;
          return mat;
        }
      },
      fabric_velvet: {
        name: 'Royal Velvet',
        category: 'Fabric',
        icon: '🧶',
        color: 0x3d124d,
        swatch: 'radial-gradient(circle at 35% 30%, #d8b4fe, #6b21a8 65%, #2e1065)',
        create: () => new THREE.MeshPhysicalMaterial({
          color: 0x3d124d,
          roughness: 0.85,
          metalness: 0.0,
          sheen: 1.0,
          sheenColor: new THREE.Color(0xb540e6),
          sheenRoughness: 0.5
        })
      },
      leather_black: {
        name: 'Black Leather',
        category: 'Organic',
        icon: '👞',
        color: 0x18181b,
        swatch: 'radial-gradient(circle at 35% 30%, #52525b, #18181b 70%, #09090b)',
        create: () => {
          const mat = new THREE.MeshStandardMaterial({
            color: 0x18181b,
            roughness: 0.45,
            metalness: 0.05
          });
          const vor = this.generateVoronoiMap({ cells: 16, mode: 'f1', color1: '#252528', color2: '#121214' });
          vor.normalMap.repeat.set(10, 10);
          mat.normalMap = vor.normalMap;
          mat.normalScale = new THREE.Vector2(1.0, 1.0);
          return mat;
        }
      },
      neon_cyan: {
        name: 'Cyber Neon Emissive',
        category: 'Emissive',
        icon: '⚡',
        color: 0x00cec9,
        swatch: 'radial-gradient(circle at 35% 30%, #ffffff, #22d3ee 55%, #0891b2)',
        create: () => new THREE.MeshStandardMaterial({
          color: 0x00cec9,
          emissive: 0x00cec9,
          emissiveIntensity: 3.5,
          roughness: 0.2,
          metalness: 0.8
        })
      },
      ceramic_clay: {
        name: 'Glazed Ceramic',
        category: 'Craft',
        color: 0xffffff,
        swatch: 'radial-gradient(circle at 35% 30%, #ffffff, #cbd5e1 70%, #64748b)',
        create: () => new THREE.MeshPhysicalMaterial({
          color: 0xffffff,
          roughness: 0.15,
          metalness: 0.0,
          clearcoat: 0.8,
          clearcoatRoughness: 0.1
        })
      },
      rubber_matte: {
        name: 'Matte Black Rubber',
        category: 'Industrial',
        color: 0x222428,
        swatch: 'radial-gradient(circle at 35% 30%, #475569, #1e293b 70%, #0f172a)',
        create: () => new THREE.MeshStandardMaterial({
          color: 0x222428,
          roughness: 0.92,
          metalness: 0.02
        })
      },
      cotton_shirt_sale: {
        name: 'Streetwear Jacket Fabric',
        category: 'Fabric',
        color: 0xe11d48,
        swatch: 'radial-gradient(circle at 35% 30%, #fb7185, #e11d48 70%, #881337)',
        create: () => new THREE.MeshPhysicalMaterial({
          color: 0xe11d48,
          roughness: 0.78,
          metalness: 0.02,
          sheen: 0.9,
          sheenColor: new THREE.Color(0xffb4c4),
          sheenRoughness: 0.55
        })
      },
      denim_jeans: {
        name: 'Blue Denim Jeans',
        category: 'Fabric',
        color: 0x254e7a,
        swatch: 'radial-gradient(circle at 35% 30%, #60a5fa, #1d4ed8 70%, #1e3a8a)',
        create: () => {
          const mat = new THREE.MeshPhysicalMaterial({
            color: 0xffffff,
            roughness: 0.84,
            metalness: 0.0,
            sheen: 0.55,
            sheenColor: new THREE.Color(0x93c5fd),
            sheenRoughness: 0.7
          });
          const noise = this.generateNoiseMap({ scale: 18, color1: '#2f5d8c', color2: '#1b3857' });
          noise.texture.repeat.set(6, 6);
          if (THREE.SRGBColorSpace) noise.texture.colorSpace = THREE.SRGBColorSpace;
          mat.map = noise.texture;
          return mat;
        }
      },
      phone_oled_screen: {
        name: 'Smartphone OLED Screen',
        category: 'Electronics',
        color: 0x111827,
        swatch: 'radial-gradient(circle at 35% 30%, #67e8f9, #0284c7 65%, #0f172a)',
        create: () => new THREE.MeshPhysicalMaterial({
          color: 0x111827,
          emissive: 0x38bdf8,
          emissiveIntensity: 1.4,
          roughness: 0.05,
          metalness: 0.1,
          clearcoat: 1.0,
          clearcoatRoughness: 0.03
        })
      },
      aluminum_anodized: {
        name: 'Space Gray Anodized Aluminum',
        category: 'Electronics',
        color: 0x64748b,
        swatch: 'radial-gradient(circle at 35% 30%, #cbd5e1, #64748b 65%, #334155)',
        create: () => new THREE.MeshStandardMaterial({
          color: 0x64748b,
          roughness: 0.26,
          metalness: 0.88
        })
      },
      wall_pastel_cream: {
        name: 'Warm Bedroom Wall',
        category: 'Interior',
        color: 0xebe4d8,
        swatch: 'radial-gradient(circle at 35% 30%, #fef3c7, #e7e5e4 70%, #a8a29e)',
        create: () => new THREE.MeshStandardMaterial({
          color: 0xebe4d8,
          roughness: 0.92,
          metalness: 0.0
        })
      },
      desk_walnut: {
        name: 'Walnut Desk Wood',
        category: 'Interior',
        color: 0x6b4423,
        swatch: 'radial-gradient(circle at 35% 30%, #a16207, #713f12 70%, #422006)',
        create: () => {
          const mat = new THREE.MeshStandardMaterial({
            color: 0xc29268,
            roughness: 0.42,
            metalness: 0.04
          });
          mat.map = this.generateWoodTexture(512, 512);
          if (mat.map && THREE.SRGBColorSpace) mat.map.colorSpace = THREE.SRGBColorSpace;
          return mat;
        }
      },
      bedding_linen: {
        name: 'Soft Bedding Linen',
        category: 'Interior',
        color: 0xdbeafe,
        swatch: 'radial-gradient(circle at 35% 30%, #f8fafc, #cbd5e1 70%, #64748b)',
        create: () => new THREE.MeshPhysicalMaterial({
          color: 0xdbeafe,
          roughness: 0.88,
          metalness: 0.0,
          sheen: 0.75,
          sheenColor: new THREE.Color(0xffffff),
          sheenRoughness: 0.65
        })
      },
      carpet_woven: {
        name: 'Woven Floor Rug',
        category: 'Interior',
        color: 0x4b5563,
        swatch: 'radial-gradient(circle at 35% 30%, #94a3b8, #475569 70%, #1e293b)',
        create: () => {
          const mat = new THREE.MeshStandardMaterial({
            color: 0x4b5563,
            roughness: 0.96,
            metalness: 0.0
          });
          const noise = this.generateNoiseMap({ scale: 22, color1: '#64748b', color2: '#334155' });
          noise.normalMap.repeat.set(8, 8);
          mat.normalMap = noise.normalMap;
          mat.normalScale = new THREE.Vector2(0.8, 0.8);
          return mat;
        }
      }
    };
  }

  _isSystemObject(node) {
    let cur = node;
    while (cur) {
      if (cur.isScene || cur.name === 'Scene_Collection') return false;
      if (
        cur.userData?.isSystemObject ||
        cur.userData?.isSystemHelper ||
        cur.userData?.isHelper ||
        cur.userData?.isLightHelper ||
        cur.userData?.selectable === false ||
        cur.isTransformControls ||
        cur.isTransformControlsGizmo ||
        cur.isTransformControlsPlane
      ) {
        return true;
      }
      cur = cur.parent;
    }
    return false;
  }

  /**
   * Applies preset material to a target mesh, group, or Object3D hierarchy
   */
  applyPreset(target, presetKey) {
    if (!target || this._isSystemObject(target)) return null;
    const presets = this.getMaterialPresets();
    const preset = presets[presetKey];
    if (!preset) {
      console.warn(`[MaterialStudio] Unknown preset: ${presetKey}`);
      return null;
    }

    const newMaterial = preset.create();
    newMaterial.name = `Mat_${presetKey}`;

    const assignMeshMaterial = (mesh) => {
      if (!mesh?.isMesh || this._isSystemObject(mesh)) return;
      mesh.userData = mesh.userData || {};
      const prevMats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      const keepVertexColors = Boolean(mesh.geometry?.attributes?.color) || prevMats.some((m) => m?.vertexColors);
      const targetMat = keepVertexColors ? Object.assign(newMaterial.clone(), { vertexColors: true }) : newMaterial;
      if (!mesh.userData.__importedMaterial && mesh.material) {
        if (prevMats.some((m) => m && !m.userData?.isDefaultClay)) {
          mesh.userData.__importedMaterial = Array.isArray(mesh.material)
            ? mesh.material.map((m) => m?.clone?.() || m)
            : (mesh.material.clone?.() || mesh.material);
        }
      }
      if (mesh.userData?.__originalMaterial) {
        // Keep MatCap backup in sync so restoring shading never reverts to stale material
        mesh.userData.__originalMaterial = targetMat;
        if (!mesh.material?.isMeshMatcapMaterial) {
          mesh.material = targetMat;
          mesh.material.needsUpdate = true;
        }
      } else {
        mesh.material = targetMat;
        mesh.material.needsUpdate = true;
      }
    };

    if (target.isMesh) {
      assignMeshMaterial(target);
    } else if (typeof target.traverse === 'function') {
      target.traverse((child) => {
        if (child.isMesh) assignMeshMaterial(child);
      });
    }

    this.activeMaterial = newMaterial;
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('blender:material-changed', {
        detail: { material: newMaterial, presetKey, target }
      }));
      if (typeof window.engine?.requestRender === 'function') {
        window.engine.requestRender();
      } else if (typeof window.engine?.render === 'function') {
        window.engine.render();
      }
    }
    return newMaterial;
  }

  // =========================================================================
  // 5. HELPER MATH & COLOR UTILITIES
  // =========================================================================

  _hexToRgb(hex) {
    const clean = hex.replace('#', '');
    const num = parseInt(clean.length === 3 ? clean.split('').map(c => c + c).join('') : clean, 16);
    return {
      r: (num >> 16) & 255,
      g: (num >> 8) & 255,
      b: num & 255
    };
  }

  _buildPermutationTable(seed = 42) {
    let s = seed;
    const pseudo = () => {
      s = (s * 9301 + 49297) % 233280;
      return s / 233280;
    };

    const p = new Uint8Array(256);
    for (let i = 0; i < 256; i++) p[i] = i;
    for (let i = 255; i > 0; i--) {
      const j = Math.floor(pseudo() * (i + 1));
      const tmp = p[i];
      p[i] = p[j];
      p[j] = tmp;
    }

    const perm = new Uint8Array(512);
    for (let i = 0; i < 512; i++) {
      perm[i] = p[i & 255];
    }
    return perm;
  }
}

export default MaterialStudio;
