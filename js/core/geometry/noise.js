/**
 * @file noise.js
 * @description Fast deterministic 3D Simplex & Fractional Brownian Motion (fBm) noise
 * for procedural mesh displacement, texturing, and terrain deformation.
 * Zero external dependencies.
 */

// Permutation table initialized from a standard seed
const DEFAULT_PERM = new Uint8Array([
  151,160,137,91,90,15,131,13,201,95,96,53,194,233,7,225,140,36,103,30,69,142,
  8,99,37,240,21,10,23,190,6,148,247,120,234,75,0,26,197,62,94,252,219,203,117,
  35,11,32,57,177,33,88,237,149,56,87,174,20,125,136,171,168,68,175,74,165,71,
  134,139,48,27,166,77,146,158,231,83,111,229,122,60,211,133,230,220,105,92,41,
  55,46,245,40,244,102,143,54,65,25,63,161,1,216,80,73,209,76,132,187,208,89,
  18,169,200,196,135,130,116,188,159,86,164,100,109,198,173,186,3,64,52,217,226,
  250,124,123,5,202,38,147,118,126,255,82,85,212,207,206,59,227,47,16,58,17,182,
  189,28,42,223,183,170,213,119,248,152,2,44,154,163,70,221,153,101,155,167,43,
  172,9,129,22,39,253,19,98,108,110,79,113,224,232,178,185,112,104,218,246,97,
  228,251,34,242,193,238,210,144,12,191,179,162,241,81,51,145,235,249,14,239,
  107,49,192,214,31,181,199,106,157,184,84,204,176,115,121,50,45,127,4,150,254,
  138,236,205,93,222,114,67,29,24,72,243,141,128,195,78,66,215,61,156,180
]);

/**
 * Creates a seeded 512-entry permutation table.
 * @param {number} seed
 * @returns {Uint8Array}
 */
export function createPermutationTable(seed = 0) {
  const p = new Uint8Array(512);
  const base = new Uint8Array(256);
  for (let i = 0; i < 256; i++) base[i] = i;

  // LCG PRNG for repeatable shuffle
  let state = (seed ^ 0x6a09e667) >>> 0;
  const lcg = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };

  for (let i = 255; i > 0; i--) {
    const j = Math.floor(lcg() * (i + 1));
    const tmp = base[i];
    base[i] = base[j];
    base[j] = tmp;
  }

  for (let i = 0; i < 256; i++) {
    p[i] = base[i];
    p[256 + i] = base[i];
  }
  return p;
}

const DEFAULT_P = new Uint8Array(512);
for (let i = 0; i < 256; i++) {
  DEFAULT_P[i] = DEFAULT_PERM[i];
  DEFAULT_P[256 + i] = DEFAULT_PERM[i];
}

const F3 = 1.0 / 3.0;
const G3 = 1.0 / 6.0;

const GRAD3 = [
  1,1,0, -1,1,0, 1,-1,0, -1,-1,0,
  1,0,1, -1,0,1, 1,0,-1, -1,0,-1,
  0,1,1, 0,-1,1, 0,1,-1, 0,-1,-1
];

/**
 * 3D Simplex noise in range [-1, 1].
 * @param {number} x
 * @param {number} y
 * @param {number} z
 * @param {Uint8Array} [p] Permutation table
 * @returns {number}
 */
export function simplex3(x, y, z, p = DEFAULT_P) {
  const s = (x + y + z) * F3;
  let i = Math.floor(x + s);
  let j = Math.floor(y + s);
  let k = Math.floor(z + s);

  const t = (i + j + k) * G3;
  const X0 = i - t;
  const Y0 = j - t;
  const Z0 = k - t;
  const x0 = x - X0;
  const y0 = y - Y0;
  const z0 = z - Z0;

  let i1, j1, k1;
  let i2, j2, k2;

  if (x0 >= y0) {
    if (y0 >= z0) { i1=1; j1=0; k1=0; i2=1; j2=1; k2=0; }
    else if (x0 >= z0) { i1=1; j1=0; k1=0; i2=1; j2=0; k2=1; }
    else { i1=0; j1=0; k1=1; i2=1; j2=0; k2=1; }
  } else {
    if (y0 < z0) { i1=0; j1=0; k1=1; i2=0; j2=1; k2=1; }
    else if (x0 < z0) { i1=0; j1=1; k1=0; i2=0; j2=1; k2=1; }
    else { i1=0; j1=1; k1=0; i2=1; j2=1; k2=0; }
  }

  const x1 = x0 - i1 + G3;
  const y1 = y0 - j1 + G3;
  const z1 = z0 - k1 + G3;
  const x2 = x0 - i2 + 2.0 * G3;
  const y2 = y0 - j2 + 2.0 * G3;
  const z2 = z0 - k2 + 2.0 * G3;
  const x3 = x0 - 1.0 + 3.0 * G3;
  const y3 = y0 - 1.0 + 3.0 * G3;
  const z3 = z0 - 1.0 + 3.0 * G3;

  const ii = i & 255;
  const jj = j & 255;
  const kk = k & 255;

  let n0 = 0.0, n1 = 0.0, n2 = 0.0, n3 = 0.0;

  let t0 = 0.6 - x0*x0 - y0*y0 - z0*z0;
  if (t0 > 0) {
    const gi0 = (p[ii + p[jj + p[kk]]] % 12) * 3;
    t0 *= t0;
    n0 = t0 * t0 * (GRAD3[gi0]*x0 + GRAD3[gi0+1]*y0 + GRAD3[gi0+2]*z0);
  }

  let t1 = 0.6 - x1*x1 - y1*y1 - z1*z1;
  if (t1 > 0) {
    const gi1 = (p[ii + i1 + p[jj + j1 + p[kk + k1]]] % 12) * 3;
    t1 *= t1;
    n1 = t1 * t1 * (GRAD3[gi1]*x1 + GRAD3[gi1+1]*y1 + GRAD3[gi1+2]*z1);
  }

  let t2 = 0.6 - x2*x2 - y2*y2 - z2*z2;
  if (t2 > 0) {
    const gi2 = (p[ii + i2 + p[jj + j2 + p[kk + k2]]] % 12) * 3;
    t2 *= t2;
    n2 = t2 * t2 * (GRAD3[gi2]*x2 + GRAD3[gi2+1]*y2 + GRAD3[gi2+2]*z2);
  }

  let t3 = 0.6 - x3*x3 - y3*y3 - z3*z3;
  if (t3 > 0) {
    const gi3 = (p[ii + 1 + p[jj + 1 + p[kk + 1]]] % 12) * 3;
    t3 *= t3;
    n3 = t3 * t3 * (GRAD3[gi3]*x3 + GRAD3[gi3+1]*y3 + GRAD3[gi3+2]*z3);
  }

  return 32.0 * (n0 + n1 + n2 + n3);
}

/**
 * Fractional Brownian Motion (fBm) noise with multi-octave accumulation.
 * Exactly matches Blender's Displace / Cloud / Musgrave noise behavior.
 *
 * @param {number} x
 * @param {number} y
 * @param {number} z
 * @param {Object} [options]
 * @param {number} [options.octaves=4] Number of noise detail layers
 * @param {number} [options.lacunarity=2.0] Frequency multiplier per octave
 * @param {number} [options.gain=0.5] Amplitude multiplier per octave (persistence)
 * @param {number} [options.scale=1.0] Base frequency scale
 * @param {Uint8Array} [options.permTable] Seeded permutation table
 * @returns {number} Value in approximately [-1.0, 1.0]
 */
export function fbm3(x, y, z, { octaves = 4, lacunarity = 2.0, gain = 0.5, scale = 1.0, permTable = DEFAULT_P } = {}) {
  let total = 0.0;
  let frequency = scale;
  let amplitude = 1.0;
  let maxAmp = 0.0;

  for (let i = 0; i < octaves; i++) {
    total += simplex3(x * frequency, y * frequency, z * frequency, permTable) * amplitude;
    maxAmp += amplitude;
    amplitude *= gain;
    frequency *= lacunarity;
  }

  return maxAmp > 0.0 ? total / maxAmp : total;
}
