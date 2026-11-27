/**
 * Web Blender Studio - Procedural Texture Web Worker
 * Generates high-resolution tileable procedural PBR textures (Albedo, Sobel Normal, Roughness):
 *   - noise / perlin (multi-octave fBm)
 *   - voronoi / cellular
 *   - brushed (anisotropic brushed metal)
 *   - carbon (woven carbon fiber)
 *   - ashlar_stone (running-bond cut masonry blocks + weathered mortar + mineral grain)
 *   - stucco_plaster (hand-troweled lime mortar / plaster / concrete micro-surface)
 *   - roof_slates (overlapping beveled slate / tile shingles)
 *   - wood_grain (cathedral growth-ring hardwood planks & vessel pores)
 *   - checkered_marble (veined stone tiles in square or 45-deg diamond layout)
 *   - stained_mosaic (leaded architectural stained-glass cellular mosaic)
 * Budget limit: <= 2048x2048.
 * File: js/render/procedural-texture-worker.js
 */

import { generateProceduralHdriData } from './procedural-hdri.js';

const MAX_TEXTURE_DIMENSION = 2048;

function createPrng(seed = 12345) {
  let s = (Math.abs(seed) % 2147483647) || 1;
  return function () {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

function clamp01(v) {
  if (!Number.isFinite(v)) return 0.5;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function smoothstep(edge0, edge1, x) {
  const t = clamp01((x - edge0) / Math.max(1e-6, edge1 - edge0));
  return t * t * (3 - 2 * t);
}

function hexToRgb(hex) {
  if (typeof hex === 'number') {
    return { r: (hex >> 16) & 255, g: (hex >> 8) & 255, b: hex & 255 };
  }
  const clean = String(hex || '#808080').replace('#', '');
  if (clean.length === 3) {
    return {
      r: parseInt(clean[0] + clean[0], 16),
      g: parseInt(clean[1] + clean[1], 16),
      b: parseInt(clean[2] + clean[2], 16),
    };
  }
  const num = parseInt(clean, 16) || 0;
  return {
    r: (num >> 16) & 255,
    g: (num >> 8) & 255,
    b: num & 255,
  };
}

function mixRgb(a, b, t) {
  const k = clamp01(t);
  return [
    Math.round(a.r + (b.r - a.r) * k),
    Math.round(a.g + (b.g - a.g) * k),
    Math.round(a.b + (b.b - a.b) * k),
  ];
}

function buildPermutation(seed) {
  const prng = createPrng(seed);
  const p = new Uint8Array(256);
  for (let i = 0; i < 256; i++) p[i] = i;
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(prng() * (i + 1));
    const tmp = p[i];
    p[i] = p[j];
    p[j] = tmp;
  }
  const perm = new Uint8Array(512);
  for (let i = 0; i < 512; i++) perm[i] = p[i & 255];
  return perm;
}

/**
 * Tileable 2D Perlin + fBm sampler with period wrapping so repeat-wrapped UV seams are invisible!
 */
function createTileableNoise(seed = 42) {
  const perm = buildPermutation(seed);
  const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);
  const grad = (hash, x, y) => {
    const h = hash & 7;
    const u = h < 4 ? x : y;
    const v = h < 4 ? y : x;
    return ((h & 1) === 0 ? u : -u) + ((h & 2) === 0 ? v : -v);
  };

  const perlinPeriodic = (x, y, px, py) => {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const xf = x - xi;
    const yf = y - yi;
    const x0 = ((xi % px) + px) % px & 255;
    const y0 = ((yi % py) + py) % py & 255;
    const x1 = (((xi + 1) % px) + px) % px & 255;
    const y1 = (((yi + 1) % py) + py) % py & 255;
    const u = fade(xf);
    const v = fade(yf);
    const aa = perm[perm[x0] + y0];
    const ab = perm[perm[x0] + y1];
    const ba = perm[perm[x1] + y0];
    const bb = perm[perm[x1] + y1];
    const nx0 = (1 - u) * grad(aa, xf, yf) + u * grad(ba, xf - 1, yf);
    const nx1 = (1 - u) * grad(ab, xf, yf - 1) + u * grad(bb, xf - 1, yf - 1);
    return (1 - v) * nx0 + v * nx1;
  };

  const fbm = (u, v, baseFreq = 6, octaves = 4, persistence = 0.5) => {
    let total = 0;
    let amp = 1.0;
    let maxAmp = 0;
    let freq = Math.max(1, Math.round(baseFreq));
    for (let i = 0; i < octaves; i++) {
      total += perlinPeriodic(u * freq, v * freq, freq, freq) * amp;
      maxAmp += amp;
      amp *= persistence;
      freq *= 2;
    }
    return clamp01((total / Math.max(1e-6, maxAmp)) * 0.5 + 0.5);
  };

  const cellHash = (ix, iy) => {
    const h = perm[(perm[ix & 255] + (iy & 255)) & 511];
    return h / 255.0;
  };

  return { perlinPeriodic, fbm, cellHash };
}

function packRoughnessRgba(roughBytes) {
  const n = roughBytes.length;
  const out = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i++) {
    const v = roughBytes[i];
    const k = i * 4;
    out[k] = v;
    out[k + 1] = v;
    out[k + 2] = v;
    out[k + 3] = 255;
  }
  return out;
}

function clampFiniteInt(val, fallback, min, max) {
  const n = Number(val);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

function clampFiniteFloat(val, fallback, min, max) {
  const n = Number(val);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function wrapMod(i, m) {
  return ((i % m) + m) % m;
}

function generateNoise(width, height, options = {}) {
  const {
    color1 = '#7a818c',
    color2 = '#1c1f24',
    roughnessMin = 0.55,
    roughnessMax = 0.88,
    seed = 42,
  } = options;
  const scale = clampFiniteFloat(options.scale, 6.0, 0.5, 64);
  const octaves = clampFiniteInt(options.octaves, 4, 1, 8);
  const persistence = clampFiniteFloat(options.persistence, 0.5, 0.05, 0.95);
  const noise = createTileableNoise(seed);
  const c1 = hexToRgb(color1);
  const c2 = hexToRgb(color2);
  const rgba = new Uint8ClampedArray(width * height * 4);
  const heights = new Uint8Array(width * height);
  const rough = new Uint8Array(width * height);

  for (let y = 0; y < height; y++) {
    const ny = y / height;
    const rowOffset = y * width;
    for (let x = 0; x < width; x++) {
      const nx = x / width;
      const nVal = noise.fbm(nx, ny, scale, octaves, persistence);
      const [r, g, b] = mixRgb(c2, c1, nVal);
      const idx = (rowOffset + x) * 4;
      rgba[idx] = r; rgba[idx + 1] = g; rgba[idx + 2] = b; rgba[idx + 3] = 255;
      heights[rowOffset + x] = Math.round(nVal * 255);
      rough[rowOffset + x] = Math.round(clamp01(roughnessMax - (roughnessMax - roughnessMin) * nVal) * 255);
    }
  }
  return { rgba, heights, rough };
}

function generateVoronoi(width, height, options = {}) {
  const {
    cells = 12,
    mode = 'f1',
    color1 = '#ffffff',
    color2 = '#111111',
    roughnessMin = 0.4,
    roughnessMax = 0.85,
    seed = 88,
  } = options;

  const prng = createPrng(seed);
  const safeCells = Number.isFinite(Number(cells)) ? Number(cells) : 12;
  const numCells = Math.max(4, Math.min(64, Math.floor(safeCells)));
  const points = [];
  for (let gy = 0; gy < numCells; gy++) {
    points[gy] = [];
    for (let gx = 0; gx < numCells; gx++) {
      points[gy][gx] = {
        x: (gx + 0.15 + prng() * 0.7) / numCells,
        y: (gy + 0.15 + prng() * 0.7) / numCells,
      };
    }
  }

  const c1 = hexToRgb(color1);
  const c2 = hexToRgb(color2);
  const rgba = new Uint8ClampedArray(width * height * 4);
  const heights = new Uint8Array(width * height);
  const rough = new Uint8Array(width * height);

  for (let y = 0; y < height; y++) {
    const v = y / height;
    const cellY = Math.floor(v * numCells);
    const rowOffset = y * width;
    for (let x = 0; x < width; x++) {
      const u = x / width;
      const cellX = Math.floor(u * numCells);
      let d1 = 999.0;
      let d2 = 999.0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const ny = (cellY + dy + numCells) % numCells;
          const nx = (cellX + dx + numCells) % numCells;
          const pt = points[ny][nx];
          const px = pt.x + (cellX + dx < 0 ? -1 : cellX + dx >= numCells ? 1 : 0);
          const py = pt.y + (cellY + dy < 0 ? -1 : cellY + dy >= numCells ? 1 : 0);
          const dist = Math.hypot(u - px, v - py);
          if (dist < d1) { d2 = d1; d1 = dist; }
          else if (dist < d2) { d2 = dist; }
        }
      }
      const val = mode === 'f2_minus_f1'
        ? Math.min(1.0, (d2 - d1) * numCells * 1.5)
        : Math.sqrt(Math.max(0.0, 1.0 - d1 * numCells * 1.6));
      const [r, g, b] = mixRgb(c2, c1, val);
      const idx = (rowOffset + x) * 4;
      rgba[idx] = r; rgba[idx + 1] = g; rgba[idx + 2] = b; rgba[idx + 3] = 255;
      heights[rowOffset + x] = Math.round(val * 255);
      rough[rowOffset + x] = Math.round(clamp01(roughnessMax - (roughnessMax - roughnessMin) * val) * 255);
    }
  }
  return { rgba, heights, rough };
}

function generateBrushed(width, height, options = {}) {
  const {
    direction = 'horizontal',
    color1 = '#d4d8de',
    color2 = '#868d96',
    roughnessMin = 0.18,
    roughnessMax = 0.42,
    seed = 77,
  } = options;
  const scratchDensity = clampFiniteFloat(options.scratchDensity, 0.7, 0.0, 1.0);
  const grain = clampFiniteFloat(options.grain, 0.15, 0.0, 1.0);
  const prng = createPrng(seed);
  const c1 = hexToRgb(color1);
  const c2 = hexToRgb(color2);
  const hasTint = options.color1 !== undefined || options.color2 !== undefined;
  const rgba = new Uint8ClampedArray(width * height * 4);
  const heights = new Uint8Array(width * height);
  const rough = new Uint8Array(width * height);

  const majorDim = direction === 'horizontal' ? height : width;
  const scratchLines = new Float32Array(majorDim);
  for (let i = 0; i < majorDim; i++) {
    scratchLines[i] = prng() < scratchDensity ? (prng() * 0.4 - 0.2) : 0;
  }

  for (let y = 0; y < height; y++) {
    const rowOffset = y * width;
    for (let x = 0; x < width; x++) {
      const lineIdx = direction === 'horizontal' ? y : x;
      const val = clamp01(0.5 + scratchLines[lineIdx] + (prng() - 0.5) * grain);
      const idx = (rowOffset + x) * 4;
      if (hasTint) {
        const [r, g, b] = mixRgb(c2, c1, val);
        rgba[idx] = r; rgba[idx + 1] = g; rgba[idx + 2] = b;
      } else {
        const b = Math.round(val * 255);
        rgba[idx] = b; rgba[idx + 1] = b; rgba[idx + 2] = b;
      }
      rgba[idx + 3] = 255;
      heights[rowOffset + x] = Math.round(val * 255);
      rough[rowOffset + x] = Math.round(clamp01(roughnessMax - (roughnessMax - roughnessMin) * val) * 255);
    }
  }
  return { rgba, heights, rough };
}

function generateCarbon(width, height) {
  const rgba = new Uint8ClampedArray(width * height * 4);
  const heights = new Uint8Array(width * height);
  const rough = new Uint8Array(width * height);
  const step = Math.max(8, Math.floor(width / 16));
  const filaments = 6;

  for (let y = 0; y < height; y++) {
    const rowOffset = y * width;
    const by = Math.floor(y / step);
    const ly = y % step;
    for (let x = 0; x < width; x++) {
      const bx = Math.floor(x / step);
      const lx = x % step;
      const isHorizontal = ((bx + by) % 4) < 2;
      const threadPos = isHorizontal ? (ly / step) * filaments : (lx / step) * filaments;
      const filamentFrac = (threadPos % 1) - 0.5;
      const bump = Math.max(0, Math.cos(filamentFrac * Math.PI));
      const val = clamp01((isHorizontal ? 0.18 : 0.08) + bump * 0.22);
      const b = Math.round(val * 255);
      const idx = (rowOffset + x) * 4;
      rgba[idx] = b; rgba[idx + 1] = b; rgba[idx + 2] = b; rgba[idx + 3] = 255;
      heights[rowOffset + x] = Math.round(bump * 255);
      rough[rowOffset + x] = Math.round((0.42 - bump * 0.22) * 255);
    }
  }
  return { rgba, heights, rough };
}

/**
 * Course-laid cut stone masonry (running bond ashlar blocks + recessed mortar + mineral weathering).
 */
function generateAshlarStone(width, height, options = {}) {
  const {
    courses = 8,
    blocksPerCourse = 4,
    mortarWidth = 0.032,
    color1 = '#979ba3',
    color2 = '#70757e',
    mortarColor = '#50545c',
    weathering = 0.35,
    roughnessMin = 0.72,
    roughnessMax = 0.94,
    seed = 101,
  } = options;

  const noise = createTileableNoise(seed);
  const cLight = hexToRgb(color1);
  const cDark = hexToRgb(color2);
  const cMortar = hexToRgb(mortarColor);
  const rgba = new Uint8ClampedArray(width * height * 4);
  const heights = new Uint8Array(width * height);
  const rough = new Uint8Array(width * height);

  const rawCourses = clampFiniteInt(courses, 8, 2, 64);
  const nyCourses = (rawCourses & 1) ? Math.min(64, rawCourses + 1) : rawCourses; // Even courses guarantee seamless stagger wrap at v=0/1
  const nxBlocks = clampFiniteInt(blocksPerCourse, 4, 2, 64);

  for (let y = 0; y < height; y++) {
    const v = (y + 0.5) / height;
    const rowOffset = y * width;
    const courseFloat = v * nyCourses;
    const courseIdx = wrapMod(Math.floor(courseFloat), nyCourses);
    const localV = courseFloat - Math.floor(courseFloat);

    for (let x = 0; x < width; x++) {
      const u = (x + 0.5) / width;
      const stagger = (courseIdx & 1) * 0.5;
      // Subtle organic mortar waviness
      const warp = (noise.fbm(u, v, 16, 2, 0.5) - 0.5) * 0.012;
      const blockFloat = (u + warp) * nxBlocks + stagger;
      const blockIdx = wrapMod(Math.floor(blockFloat), nxBlocks);
      const localU = blockFloat - Math.floor(blockFloat);

      const edgeU = Math.min(localU, 1 - localU) * (nyCourses / nxBlocks);
      const edgeV = Math.min(localV, 1 - localV);
      const edgeDist = Math.min(edgeU, edgeV);
      const blockMask = smoothstep(mortarWidth * 0.55, mortarWidth * 1.55, edgeDist);

      const blockTint = noise.cellHash(blockIdx, courseIdx);
      const macroFbm = noise.fbm(u, v, 6, 4, 0.55);
      const microGrain = noise.fbm(u, v, 28, 3, 0.55);
      const streak = noise.fbm(u * 2.0, v * 0.5, 4, 3, 0.5);

      const stoneTone = clamp01(
        0.48 + (blockTint - 0.5) * 0.26 + (macroFbm - 0.5) * 0.34 + (microGrain - 0.5) * 0.22 - (1 - streak) * weathering * 0.25
      );
      const stoneRgb = mixRgb(cDark, cLight, stoneTone);
      const finalR = Math.round(cMortar.r + (stoneRgb[0] - cMortar.r) * blockMask);
      const finalG = Math.round(cMortar.g + (stoneRgb[1] - cMortar.g) * blockMask);
      const finalB = Math.round(cMortar.b + (stoneRgb[2] - cMortar.b) * blockMask);

      const idx = (rowOffset + x) * 4;
      rgba[idx] = finalR; rgba[idx + 1] = finalG; rgba[idx + 2] = finalB; rgba[idx + 3] = 255;

      const hVal = clamp01(blockMask * (0.68 + 0.20 * microGrain + 0.12 * macroFbm) + (1 - blockMask) * 0.12 * microGrain);
      heights[rowOffset + x] = Math.round(hVal * 255);
      const rVal = clamp01(roughnessMax - blockMask * (roughnessMax - roughnessMin) * stoneTone);
      rough[rowOffset + x] = Math.round(rVal * 255);
    }
  }
  return { rgba, heights, rough };
}

/**
 * Hand-troweled lime mortar / plaster / concrete surface.
 */
function generateStuccoPlaster(width, height, options = {}) {
  const {
    color1 = '#ede8de',
    color2 = '#d1cabd',
    scale = 7,
    roughnessMin = 0.74,
    roughnessMax = 0.90,
    seed = 202,
  } = options;
  const noise = createTileableNoise(seed);
  const c1 = hexToRgb(color1);
  const c2 = hexToRgb(color2);
  const rgba = new Uint8ClampedArray(width * height * 4);
  const heights = new Uint8Array(width * height);
  const rough = new Uint8Array(width * height);

  for (let y = 0; y < height; y++) {
    const v = (y + 0.5) / height;
    const rowOffset = y * width;
    for (let x = 0; x < width; x++) {
      const u = (x + 0.5) / width;
      const broad = noise.fbm(u, v, scale, 4, 0.55);
      const fine = noise.fbm(u, v, scale * 5, 3, 0.5);
      const pores = Math.pow(noise.fbm(u, v, scale * 10, 2, 0.5), 2.2);
      const val = clamp01(broad * 0.62 + fine * 0.28 + pores * 0.10);
      const [r, g, b] = mixRgb(c2, c1, val);
      const idx = (rowOffset + x) * 4;
      rgba[idx] = r; rgba[idx + 1] = g; rgba[idx + 2] = b; rgba[idx + 3] = 255;
      heights[rowOffset + x] = Math.round(clamp01(0.55 + (broad - 0.5) * 0.35 + (fine - 0.5) * 0.45 - (1 - pores) * 0.15) * 255);
      rough[rowOffset + x] = Math.round(clamp01(roughnessMax - (roughnessMax - roughnessMin) * val) * 255);
    }
  }
  return { rgba, heights, rough };
}

/**
 * Overlapping beveled slate / tile shingles in staggered courses.
 */
function generateRoofSlates(width, height, options = {}) {
  const {
    rows = 12,
    cols = 8,
    color1 = '#3a404a',
    color2 = '#20242b',
    roughnessMin = 0.42,
    roughnessMax = 0.68,
    seed = 303,
  } = options;
  const noise = createTileableNoise(seed);
  const c1 = hexToRgb(color1);
  const c2 = hexToRgb(color2);
  const rgba = new Uint8ClampedArray(width * height * 4);
  const heights = new Uint8Array(width * height);
  const rough = new Uint8Array(width * height);

  const rawRows = clampFiniteInt(rows, 12, 4, 64);
  const nRows = (rawRows & 1) ? Math.min(64, rawRows + 1) : rawRows;
  const nCols = clampFiniteInt(cols, 8, 3, 64);

  for (let y = 0; y < height; y++) {
    const v = y / height;
    const rowOffset = y * width;
    const rFloat = v * nRows;
    const rIdx = wrapMod(Math.floor(rFloat), nRows);
    const lv = rFloat - Math.floor(rFloat);

    for (let x = 0; x < width; x++) {
      const u = x / width;
      const cFloat = u * nCols + (rIdx & 1) * 0.5;
      const cIdx = wrapMod(Math.floor(cFloat), nCols);
      const lu = cFloat - Math.floor(cFloat);

      const sideGap = smoothstep(0.02, 0.065, Math.min(lu, 1 - lu));
      const overlapLip = smoothstep(0.0, 0.11, lv);
      const shingleSlope = 0.35 + 0.65 * lv;
      const cleavage = noise.fbm(u, v * 2, 18, 3, 0.5);
      const tileVar = noise.cellHash(cIdx, rIdx);

      const shade = clamp01((0.35 + tileVar * 0.30 + cleavage * 0.35) * sideGap * (0.45 + 0.55 * overlapLip));
      const [r, g, b] = mixRgb(c2, c1, shade);
      const idx = (rowOffset + x) * 4;
      rgba[idx] = r; rgba[idx + 1] = g; rgba[idx + 2] = b; rgba[idx + 3] = 255;

      const hVal = clamp01(sideGap * overlapLip * (shingleSlope * 0.78 + cleavage * 0.22));
      heights[rowOffset + x] = Math.round(hVal * 255);
      rough[rowOffset + x] = Math.round(clamp01(roughnessMax - (roughnessMax - roughnessMin) * shade) * 255);
    }
  }
  return { rgba, heights, rough };
}

/**
 * Natural hardwood planks & growth-ring grain (supports ironwood/mahogany/oak/walnut tones).
 */
function generateWoodGrain(width, height, options = {}) {
  const {
    planks = 4,
    ringScale = 14,
    color1 = '#5a2e1b',
    color2 = '#2c140b',
    roughnessMin = 0.24,
    roughnessMax = 0.48,
    seed = 404,
  } = options;
  const noise = createTileableNoise(seed);
  const c1 = hexToRgb(color1);
  const c2 = hexToRgb(color2);
  const rgba = new Uint8ClampedArray(width * height * 4);
  const heights = new Uint8Array(width * height);
  const rough = new Uint8Array(width * height);
  const nPlanks = clampFiniteInt(planks, 4, 1, 32);

  for (let y = 0; y < height; y++) {
    const v = (y + 0.5) / height;
    const rowOffset = y * width;
    for (let x = 0; x < width; x++) {
      const u = (x + 0.5) / width;
      const pFloat = u * nPlanks;
      const pIdx = wrapMod(Math.floor(pFloat), nPlanks);
      const lu = pFloat - Math.floor(pFloat);
      const plankGap = nPlanks > 1 ? smoothstep(0.008, 0.028, Math.min(lu, 1 - lu)) : 1.0;
      const plankShift = noise.cellHash(pIdx, 7) * 3.7;

      const warp = noise.fbm(u, v, 4, 3, 0.5) * 0.85;
      const ringArg = ((lu - 0.5) * ringScale + warp * 4.2 + plankShift) * Math.PI;
      const rings = Math.pow(0.5 + 0.5 * Math.sin(ringArg), 1.6);
      const vessels = noise.fbm(u * 6, v * 0.5, 24, 2, 0.5);

      const grainVal = clamp01((rings * 0.68 + vessels * 0.32) * plankGap);
      const [r, g, b] = mixRgb(c2, c1, grainVal);
      const idx = (rowOffset + x) * 4;
      rgba[idx] = r; rgba[idx + 1] = g; rgba[idx + 2] = b; rgba[idx + 3] = 255;

      heights[rowOffset + x] = Math.round(clamp01(plankGap * (0.65 + rings * 0.18 + vessels * 0.17)) * 255);
      rough[rowOffset + x] = Math.round(clamp01(roughnessMax - (roughnessMax - roughnessMin) * grainVal) * 255);
    }
  }
  return { rgba, heights, rough };
}

/**
 * Polished veined marble / stone floor tiles (supports orthogonal or 45-degree diamond checkerboard).
 */
function generateCheckeredMarble(width, height, options = {}) {
  const {
    tiles = 4,
    diagonal = true,
    groutWidth = 0.022,
    color1 = '#e8e2d5',
    color2 = '#32353b',
    veinColor = '#9b9589',
    roughnessMin = 0.10,
    roughnessMax = 0.28,
    seed = 505,
  } = options;
  const noise = createTileableNoise(seed);
  const cLight = hexToRgb(color1);
  const cDark = hexToRgb(color2);
  const cVein = hexToRgb(veinColor);
  const rgba = new Uint8ClampedArray(width * height * 4);
  const heights = new Uint8Array(width * height);
  const rough = new Uint8Array(width * height);
  const rawTiles = clampFiniteInt(tiles, 4, 2, 64);
  const nTiles = (rawTiles & 1) ? Math.min(64, rawTiles + 1) : rawTiles; // Even tile count ensures periodic checkerboard wrap at u/v = 0/1

  for (let y = 0; y < height; y++) {
    const v = (y + 0.5) / height;
    const rowOffset = y * width;
    for (let x = 0; x < width; x++) {
      const u = (x + 0.5) / width;
      const tu = diagonal ? (u + v) * nTiles : u * nTiles;
      const tv = diagonal ? (u - v + 1) * nTiles : v * nTiles;
      const ix = Math.floor(tu);
      const iy = Math.floor(tv);
      const fu = tu - ix;
      const fv = tv - iy;

      const edge = Math.min(Math.min(fu, 1 - fu), Math.min(fv, 1 - fv));
      const groutMask = smoothstep(groutWidth * 0.45, groutWidth * 1.35, edge);
      const isAlt = ((ix + iy) & 1) !== 0;

      const turb = noise.fbm(u, v, 6, 4, 0.55);
      // Use even integer frequencies (u*2 + v*2) so sin(theta*PI) wraps periodically across [0,1) without seam
      const veinSignal = Math.pow(1 - Math.abs(Math.sin((u * 2 + v * 2 + turb * 2.6) * Math.PI)), 6.0);
      const baseTile = isAlt ? cDark : cLight;
      const veinedRgb = mixRgb(baseTile, cVein, veinSignal * 0.48);

      const idx = (rowOffset + x) * 4;
      rgba[idx] = Math.round(68 + (veinedRgb[0] - 68) * groutMask);
      rgba[idx + 1] = Math.round(68 + (veinedRgb[1] - 68) * groutMask);
      rgba[idx + 2] = Math.round(70 + (veinedRgb[2] - 70) * groutMask);
      rgba[idx + 3] = 255;

      heights[rowOffset + x] = Math.round((0.18 + 0.80 * groutMask) * 255);
      const rVal = groutMask < 0.5 ? 0.85 : clamp01(roughnessMin + veinSignal * (roughnessMax - roughnessMin));
      rough[rowOffset + x] = Math.round(rVal * 255);
    }
  }
  return { rgba, heights, rough };
}

/**
 * Leaded stained-glass cellular mosaic (raised dark lead cames + jewel-toned glass cells).
 */
function generateStainedMosaic(width, height, options = {}) {
  const {
    cells = 14,
    leadWidth = 0.08,
    palette = ['#b91c1c', '#1d4ed8', '#d97706', '#047857', '#7e22ce', '#f59e0b'],
    seed = 606,
  } = options;
  const prng = createPrng(seed);
  const noise = createTileableNoise(seed + 17);
  const safeCells = Number.isFinite(Number(cells)) ? Number(cells) : 14;
  const numCells = Math.max(4, Math.min(64, Math.floor(safeCells)));
  const rgbPalette = (Array.isArray(palette) && palette.length > 0 ? palette : ['#b91c1c', '#1d4ed8']).slice(0, 32).map(hexToRgb);

  const points = [];
  for (let gy = 0; gy < numCells; gy++) {
    points[gy] = [];
    for (let gx = 0; gx < numCells; gx++) {
      points[gy][gx] = {
        x: (gx + 0.18 + prng() * 0.64) / numCells,
        y: (gy + 0.18 + prng() * 0.64) / numCells,
        col: rgbPalette[Math.floor(prng() * rgbPalette.length)],
      };
    }
  }

  const rgba = new Uint8ClampedArray(width * height * 4);
  const heights = new Uint8Array(width * height);
  const rough = new Uint8Array(width * height);

  for (let y = 0; y < height; y++) {
    const v = y / height;
    const cellY = Math.floor(v * numCells);
    const rowOffset = y * width;
    for (let x = 0; x < width; x++) {
      const u = x / width;
      const cellX = Math.floor(u * numCells);
      let d1 = 999, d2 = 999;
      let winCol = rgbPalette[0];

      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const ny = (cellY + dy + numCells) % numCells;
          const nx = (cellX + dx + numCells) % numCells;
          const pt = points[ny][nx];
          const px = pt.x + (cellX + dx < 0 ? -1 : cellX + dx >= numCells ? 1 : 0);
          const py = pt.y + (cellY + dy < 0 ? -1 : cellY + dy >= numCells ? 1 : 0);
          const dist = Math.hypot(u - px, v - py);
          if (dist < d1) { d2 = d1; d1 = dist; winCol = pt.col; }
          else if (dist < d2) { d2 = dist; }
        }
      }

      const border = (d2 - d1) * numCells;
      const glassMask = smoothstep(leadWidth * 0.45, leadWidth * 1.15, border);
      const ripple = 0.78 + 0.34 * noise.fbm(u, v, 14, 3, 0.5);
      const centerGlow = clamp01(1.12 - d1 * numCells * 0.55);

      const gr = Math.min(255, Math.round(winCol.r * ripple * centerGlow));
      const gg = Math.min(255, Math.round(winCol.g * ripple * centerGlow));
      const gb = Math.min(255, Math.round(winCol.b * ripple * centerGlow));

      const idx = (rowOffset + x) * 4;
      rgba[idx] = Math.round(28 + (gr - 28) * glassMask);
      rgba[idx + 1] = Math.round(30 + (gg - 30) * glassMask);
      rgba[idx + 2] = Math.round(34 + (gb - 34) * glassMask);
      rgba[idx + 3] = 255;

      // Raised lead came ridges around slightly rippled blown glass
      heights[rowOffset + x] = Math.round(((1 - glassMask) * 0.92 + glassMask * 0.45 * ripple) * 255);
      rough[rowOffset + x] = Math.round(((1 - glassMask) * 0.55 + glassMask * 0.08) * 255);
    }
  }
  return { rgba, heights, rough };
}

/**
 * Multi-scale weathered cast-concrete / hand-troweled lime-cement mortar with vertical rain-runoff patina.
 * Designed to read naturally across macro (100m), medium (30m), and close-up (3m) zoom distances without brick grids.
 */
function generateWeatheredConcrete(width, height, options = {}) {
  const {
    color1 = '#8f8b83',
    color2 = '#555451',
    streakColor = '#323230',
    scale = 4,
    rainStreaks = 0.48,
    streakFrequency = 9,
    microGrain = 0.28,
    roughnessMin = 0.66,
    roughnessMax = 0.93,
    seed = 707,
  } = options;
  const noise = createTileableNoise(seed);
  const cLight = hexToRgb(color1);
  const cBase = hexToRgb(color2);
  const cStreak = hexToRgb(streakColor);
  const rgba = new Uint8ClampedArray(width * height * 4);
  const heights = new Uint8Array(width * height);
  const rough = new Uint8Array(width * height);

  for (let y = 0; y < height; y++) {
    const v = (y + 0.5) / height;
    const rowOffset = y * width;
    for (let x = 0; x < width; x++) {
      const u = (x + 0.5) / width;
      // 1. Macro mineral mottling (readable from 40m–120m)
      const macro = noise.fbm(u, v, scale, 4, 0.55);
      // 2. Medium trowel patches (readable from 12m–40m)
      const med = noise.fbm(u, v, scale * 3, 3, 0.52);
      // 3. Anisotropic vertical rain-drip runoff streaks (warped slightly horizontally)
      const uWarp = u + (noise.fbm(u, v, scale * 2, 2, 0.5) - 0.5) * 0.06;
      const dripBand = noise.fbm(uWarp * streakFrequency, v, 2, 3, 0.55);
      const dripVertical = noise.fbm(uWarp * 2, v, 3, 2, 0.5);
      const streakMask = clamp01(smoothstep(0.46, 0.80, (1 - dripBand) * (0.55 + 0.45 * dripVertical)) * rainStreaks);
      // 4. Micro sand/cement aggregate & hairline pores (readable at 2m–10m close-up)
      const fine = noise.fbm(u, v, scale * 12, 3, 0.52);
      const pores = Math.pow(noise.fbm(u, v, scale * 22, 2, 0.5), 2.4);

      const baseTone = clamp01(macro * 0.54 + med * 0.28 + (fine - 0.5) * microGrain + (pores - 0.5) * 0.12);
      const mortarRgb = mixRgb(cBase, cLight, baseTone);
      const [r, g, b] = mixRgb(
        { r: mortarRgb[0], g: mortarRgb[1], b: mortarRgb[2] },
        cStreak,
        streakMask
      );

      const idx = (rowOffset + x) * 4;
      rgba[idx] = r; rgba[idx + 1] = g; rgba[idx + 2] = b; rgba[idx + 3] = 255;

      const hVal = clamp01(
        0.54 + (macro - 0.5) * 0.22 + (med - 0.5) * 0.28 + (fine - 0.5) * 0.36 - (1 - pores) * 0.14 - streakMask * 0.08
      );
      heights[rowOffset + x] = Math.round(hVal * 255);
      // Damp rain streaks have slightly lower micro-roughness than dry mineral cement
      const rVal = clamp01(roughnessMax - (roughnessMax - roughnessMin) * (baseTone * 0.65 + streakMask * 0.45));
      rough[rowOffset + x] = Math.round(rVal * 255);
    }
  }
  return { rgba, heights, rough };
}

/**
 * Curved barrel / mission / terracotta clay roof tiles with 3D cylindrical profile & kiln color variation.
 */
function generateClayRoofTiles(width, height, options = {}) {
  const {
    rows = 10,
    cols = 14,
    color1 = '#b5563d',
    color2 = '#7c3523',
    patinaColor = '#3a2d28',
    weathering = 0.28,
    roughnessMin = 0.46,
    roughnessMax = 0.78,
    seed = 808,
  } = options;
  const noise = createTileableNoise(seed);
  const cLight = hexToRgb(color1);
  const cDark = hexToRgb(color2);
  const cPatina = hexToRgb(patinaColor);
  const rgba = new Uint8ClampedArray(width * height * 4);
  const heights = new Uint8Array(width * height);
  const rough = new Uint8Array(width * height);

  const nRows = clampFiniteInt(rows, 10, 2, 64);
  const nCols = clampFiniteInt(cols, 14, 3, 64);

  for (let y = 0; y < height; y++) {
    const v = y / height;
    const rowOffset = y * width;
    const rFloat = v * nRows;
    const rIdx = wrapMod(Math.floor(rFloat), nRows);
    const lv = rFloat - Math.floor(rFloat);

    for (let x = 0; x < width; x++) {
      const u = x / width;
      const cFloat = u * nCols;
      const cIdx = wrapMod(Math.floor(cFloat), nCols);
      const lu = cFloat - Math.floor(cFloat);

      // Cylindrical barrel arch across each tile column + horizontal step lip at course bottom
      const barrel = Math.cos((lu - 0.5) * Math.PI); // 0 at valley, 1 at crest
      const overlapLip = smoothstep(0.0, 0.13, lv);
      const lipShadow = 0.42 + 0.58 * overlapLip;
      const kilnVar = noise.cellHash(cIdx, rIdx);
      const clayGrain = noise.fbm(u, v, 16, 3, 0.5);
      const moss = clamp01(
        smoothstep(0.42, 0.85, (1 - barrel) * 0.55 + (1 - overlapLip) * 0.55 + (noise.fbm(u, v, 6, 3, 0.5) - 0.35)) * weathering
      );

      const firingTone = clamp01((0.28 + barrel * 0.42 + kilnVar * 0.22 + (clayGrain - 0.5) * 0.16) * lipShadow);
      const clayRgb = mixRgb(cDark, cLight, firingTone);
      const [r, g, b] = mixRgb({ r: clayRgb[0], g: clayRgb[1], b: clayRgb[2] }, cPatina, moss);

      const idx = (rowOffset + x) * 4;
      rgba[idx] = r; rgba[idx + 1] = g; rgba[idx + 2] = b; rgba[idx + 3] = 255;

      const hVal = clamp01(overlapLip * (0.22 + barrel * 0.68 + clayGrain * 0.10));
      heights[rowOffset + x] = Math.round(hVal * 255);
      rough[rowOffset + x] = Math.round(clamp01(roughnessMin + (1 - barrel * 0.5) * (roughnessMax - roughnessMin) + moss * 0.15) * 255);
    }
  }
  return { rgba, heights, rough };
}

/**
 * Architectural mullioned window grid (crisp painted/stone/wood muntin bars + reflective tinted/stained glass panes).
 */
function generateMullionedGlass(width, height, options = {}) {
  const {
    cols = 4,
    rows = 8,
    frameWidth = 0.13,
    outerBorder = 0.055,
    frameColor = '#eef1f4',
    paneColor1 = '#1f2b38',
    paneColor2 = '#304356',
    palette = null,
    diamondLead = false,
    frameRoughness = 0.58,
    glassRoughness = 0.07,
    seed = 909,
  } = options;
  const noise = createTileableNoise(seed);
  const cFrame = hexToRgb(frameColor);
  const cPane1 = hexToRgb(paneColor1);
  const cPane2 = hexToRgb(paneColor2);
  const rgbPalette = Array.isArray(palette) && palette.length > 0 ? palette.map(hexToRgb) : null;
  const rgba = new Uint8ClampedArray(width * height * 4);
  const heights = new Uint8Array(width * height);
  const rough = new Uint8Array(width * height);

  const nCols = clampFiniteInt(cols, 4, 1, 64);
  const nRows = clampFiniteInt(rows, 8, 1, 64);

  for (let y = 0; y < height; y++) {
    const v = y / height;
    const rowOffset = y * width;
    const rFloat = v * nRows;
    const rIdx = Math.floor(rFloat);
    const lv = rFloat - rIdx;

    for (let x = 0; x < width; x++) {
      const u = x / width;
      const cFloat = u * nCols;
      const cIdx = Math.floor(cFloat);
      const lu = cFloat - cIdx;

      const outerEdge = Math.min(Math.min(u, 1 - u), Math.min(v, 1 - v));
      const outerMask = outerBorder > 0 ? (1 - smoothstep(outerBorder * 0.75, outerBorder * 1.05, outerEdge)) : 0;

      const barEdgeU = Math.min(lu, 1 - lu);
      const barEdgeV = Math.min(lv, 1 - lv);
      const barDist = Math.min(barEdgeU, barEdgeV * (nCols / Math.max(nCols, nRows * 0.65)));
      const muntinMask = 1 - smoothstep(frameWidth * 0.42, frameWidth * 0.68, barDist);

      let leadMask = 0;
      if (diamondLead) {
        const dDiag = Math.min(Math.abs((lu + lv) - 1), Math.abs(lu - lv));
        leadMask = (1 - smoothstep(0.02, 0.045, dDiag)) * 0.65;
      }

      const frameFactor = clamp01(Math.max(outerMask, muntinMask));
      const paneHash = noise.cellHash(cIdx, rIdx);
      const glassRipple = noise.fbm(u, v, 10, 3, 0.5);

      let glassRgb;
      if (rgbPalette) {
        const pCol = rgbPalette[Math.floor(paneHash * rgbPalette.length) % rgbPalette.length];
        const glow = 0.72 + 0.42 * glassRipple;
        glassRgb = [
          Math.min(255, Math.round(pCol.r * glow)),
          Math.min(255, Math.round(pCol.g * glow)),
          Math.min(255, Math.round(pCol.b * glow)),
        ];
      } else {
        glassRgb = mixRgb(cPane1, cPane2, clamp01(paneHash * 0.55 + glassRipple * 0.45));
      }

      if (leadMask > 0.01) {
        glassRgb = [
          Math.round(glassRgb[0] * (1 - leadMask) + 42 * leadMask),
          Math.round(glassRgb[1] * (1 - leadMask) + 46 * leadMask),
          Math.round(glassRgb[2] * (1 - leadMask) + 52 * leadMask),
        ];
      }

      const frameShade = 0.90 + 0.10 * glassRipple;
      const fr = Math.min(255, Math.round(cFrame.r * frameShade));
      const fg = Math.min(255, Math.round(cFrame.g * frameShade));
      const fb = Math.min(255, Math.round(cFrame.b * frameShade));

      const idx = (rowOffset + x) * 4;
      rgba[idx] = Math.round(glassRgb[0] + (fr - glassRgb[0]) * frameFactor);
      rgba[idx + 1] = Math.round(glassRgb[1] + (fg - glassRgb[1]) * frameFactor);
      rgba[idx + 2] = Math.round(glassRgb[2] + (fb - glassRgb[2]) * frameFactor);
      rgba[idx + 3] = 255;

      heights[rowOffset + x] = Math.round(clamp01(frameFactor * 0.92 + (1 - frameFactor) * (0.25 + leadMask * 0.35 + glassRipple * 0.08)) * 255);
      rough[rowOffset + x] = Math.round(clamp01(frameFactor * frameRoughness + (1 - frameFactor) * (glassRoughness + leadMask * 0.35)) * 255);
    }
  }
  return { rgba, heights, rough };
}

function generateNormalMap(heights, width, height, intensity = 1.5) {
  const normals = new Uint8ClampedArray(width * height * 4);
  const getH = (x, y) => {
    const cx = (x + width) % width;
    const cy = (y + height) % height;
    return heights[cy * width + cx] / 255.0;
  };

  for (let y = 0; y < height; y++) {
    const rowOffset = y * width;
    for (let x = 0; x < width; x++) {
      const tl = getH(x - 1, y - 1);
      const t = getH(x, y - 1);
      const tr = getH(x + 1, y - 1);
      const l = getH(x - 1, y);
      const r = getH(x + 1, y);
      const bl = getH(x - 1, y + 1);
      const b = getH(x, y + 1);
      const br = getH(x + 1, y + 1);

      const dX = (tr + 2.0 * r + br) - (tl + 2.0 * l + bl);
      const dY = (bl + 2.0 * b + br) - (tl + 2.0 * t + tr);

      let nx = -dX * intensity;
      let ny = -dY * intensity;
      let nz = 1.0;
      const len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1.0;
      nx /= len; ny /= len; nz /= len;

      const idx = (rowOffset + x) * 4;
      normals[idx] = Math.floor((nx * 0.5 + 0.5) * 255);
      normals[idx + 1] = Math.floor((ny * 0.5 + 0.5) * 255);
      normals[idx + 2] = Math.floor((nz * 0.5 + 0.5) * 255);
      normals[idx + 3] = 255;
    }
  }
  return normals;
}

export function executeProceduralGeneration(type, width, height, rawOptions = {}) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new Error(`Invalid texture resolution ${width}x${height}: dimensions must be positive integers`);
  }
  if (width > MAX_TEXTURE_DIMENSION || height > MAX_TEXTURE_DIMENSION) {
    throw new Error(
      `Texture resolution ${width}x${height} exceeds maximum budget of ${MAX_TEXTURE_DIMENSION}x${MAX_TEXTURE_DIMENSION}`
    );
  }

  // Strip non-finite numeric or coercible-string numeric overrides (NaN, "NaN", +/-Infinity) so defaults apply cleanly
  const NUMERIC_KEYS = new Set([
    'scale', 'octaves', 'persistence', 'lacunarity', 'cells', 'courses', 'blocksPerCourse',
    'rows', 'cols', 'planks', 'tiles', 'grain', 'scratchDensity', 'roughnessMin', 'roughnessMax',
    'weathering', 'rainStreaks', 'streakFrequency', 'microGrain', 'mortarWidth', 'groutWidth',
    'leadWidth', 'frameWidth', 'outerBorder', 'frameRoughness', 'glassRoughness', 'ringScale',
    'bumpIntensity', 'seed'
  ]);
  const options = {};
  if (rawOptions && typeof rawOptions === 'object') {
    for (const [k, v] of Object.entries(rawOptions)) {
      if (typeof v === 'number') {
        if (!Number.isFinite(v)) continue;
        options[k] = v;
      } else if (NUMERIC_KEYS.has(k)) {
        const coerced = Number(v);
        if (!Number.isFinite(coerced)) continue;
        options[k] = coerced;
      } else {
        options[k] = v;
      }
    }
  }
  if (options.scale !== undefined) options.scale = clampFiniteFloat(options.scale, 6, 0.5, 64);
  if (options.roughnessMin !== undefined) options.roughnessMin = clampFiniteFloat(options.roughnessMin, 0.2, 0.02, 1.0);
  if (options.roughnessMax !== undefined) options.roughnessMax = clampFiniteFloat(options.roughnessMax, 0.9, 0.02, 1.0);
  if (options.weathering !== undefined) options.weathering = clampFiniteFloat(options.weathering, 0.3, 0, 1.0);
  if (options.rainStreaks !== undefined) options.rainStreaks = clampFiniteFloat(options.rainStreaks, 0.45, 0, 1.0);
  if (options.streakFrequency !== undefined) options.streakFrequency = clampFiniteFloat(options.streakFrequency, 9, 1, 64);
  if (options.microGrain !== undefined) options.microGrain = clampFiniteFloat(options.microGrain, 0.28, 0, 1.0);
  if (options.mortarWidth !== undefined) options.mortarWidth = clampFiniteFloat(options.mortarWidth, 0.032, 0.002, 0.25);
  if (options.groutWidth !== undefined) options.groutWidth = clampFiniteFloat(options.groutWidth, 0.022, 0.002, 0.25);
  if (options.leadWidth !== undefined) options.leadWidth = clampFiniteFloat(options.leadWidth, 0.08, 0.005, 0.35);
  if (options.frameWidth !== undefined) options.frameWidth = clampFiniteFloat(options.frameWidth, 0.13, 0.01, 0.45);
  if (options.ringScale !== undefined) options.ringScale = clampFiniteFloat(options.ringScale, 14, 1, 64);
  if (options.seed !== undefined) options.seed = clampFiniteInt(options.seed, 42, 0, 1000000);

  const t = String(type).toLowerCase().replace(/[-_\s]/g, '');
  let result;

  switch (t) {
    case 'hdri':
    case 'hdriequirect':
    case 'equirecthdri': {
      const hdri = generateProceduralHdriData({
        preset: options.preset || 'studio-softbox',
        width,
        height,
        format: options.format || 'half-float',
      });
      return {
        width: hdri.width,
        height: hdri.height,
        rgba: hdri.data,
        isHdri: true,
        format: hdri.format,
      };
    }

    case 'voronoi':
    case 'cellular':
      result = generateVoronoi(width, height, options);
      break;

    case 'brushed':
    case 'brushedmetal':
      result = generateBrushed(width, height, options);
      break;

    case 'carbon':
    case 'carbonfiber':
      result = generateCarbon(width, height, options);
      break;

    case 'ashlar':
    case 'ashlarstone':
    case 'masonry':
    case 'stonewall':
      result = generateAshlarStone(width, height, options);
      break;

    case 'stucco':
    case 'stuccoplaster':
    case 'plaster':
    case 'mortar':
    case 'concrete':
      result = generateStuccoPlaster(width, height, options);
      break;

    case 'roofslates':
    case 'slate':
    case 'shingles':
    case 'rooftiles':
      result = generateRoofSlates(width, height, options);
      break;

    case 'wood':
    case 'woodgrain':
    case 'hardwood':
    case 'timber':
      result = generateWoodGrain(width, height, options);
      break;

    case 'checkeredmarble':
    case 'marble':
    case 'marbletile':
    case 'stonefloor':
      result = generateCheckeredMarble(width, height, options);
      break;

    case 'stainedmosaic':
    case 'stainedglass':
    case 'mosaic':
      result = generateStainedMosaic(width, height, options);
      break;

    case 'weatheredconcrete':
    case 'concretepatina':
    case 'agedplaster':
    case 'caststone':
      result = generateWeatheredConcrete(width, height, options);
      break;

    case 'clayrooftiles':
    case 'barreltiles':
    case 'terracottatiles':
    case 'claytiles':
      result = generateClayRoofTiles(width, height, options);
      break;

    case 'mullionedglass':
    case 'windowgrid':
    case 'panedwindow':
      result = generateMullionedGlass(width, height, options);
      break;

    case 'noise':
    case 'perlin':
    default:
      result = generateNoise(width, height, options);
      break;
  }

  const normalIntensity = clampFiniteFloat(options.bumpIntensity, 1.5, 0.0, 10.0);
  const normals = generateNormalMap(result.heights, width, height, normalIntensity);
  const roughness = packRoughnessRgba(result.rough);

  return {
    width,
    height,
    rgba: result.rgba,
    heights: result.heights,
    normals,
    roughness,
  };
}

if (typeof self !== 'undefined' && typeof self.postMessage === 'function' && typeof window === 'undefined') {
  self.onmessage = function (e) {
    const { id, type, width, height, options } = e.data || {};
    try {
      const res = executeProceduralGeneration(type, width, height, options);
      if (res.isHdri) {
        self.postMessage(
          {
            id,
            width: res.width,
            height: res.height,
            isHdri: true,
            format: res.format,
            rgbaBuffer: res.rgba.buffer,
          },
          [res.rgba.buffer]
        );
      } else {
        self.postMessage(
          {
            id,
            width: res.width,
            height: res.height,
            rgbaBuffer: res.rgba.buffer,
            normalBuffer: res.normals.buffer,
            roughnessBuffer: res.roughness.buffer,
          },
          [res.rgba.buffer, res.normals.buffer, res.roughness.buffer]
        );
      }
    } catch (err) {
      self.postMessage({ id, error: err.message || String(err) });
    }
  };
}
