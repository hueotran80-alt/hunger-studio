/**
 * Web Blender Studio - Cycles X-Grade Hybrid Rust BVH + WebGPU Compute Path Tracer
 * 100% Web-Native, Zero Server GPU — brings Blender 4.5 Cycles X algorithms to the browser:
 *
 * 1. Rust WASM (`render_kernel.wasm`) builds Binned-SAH 32B BVH2 on frame 0 and runs
 *    O(N) `rk_refit` on animation frames 1..N (~1-5 ms), plus exports 2D HDRI Marginal/Conditional
 *    Importance Sampling CDF and UV + TBN Tangent attributes.
 * 2. Owen-Scrambled Sobol QMC + R2 Screen-Space Blue-Noise Cranley-Patterson Shift (replacing
 *    white noise — cleaner convergence at 8-32 spp like Cycles PMJ02/Sobol).
 * 3. Cycles X Adaptive Sampling on GPU (per-pixel even/odd error estimation stopping converged
 *    sky & diffuse pixels early after minSamples = 4).
 * 4. Principled BSDF v2 on WGSL: Heitz GGX VNDF sampling + Turquin Multi-Scattering GGX energy
 *    compensation + Clearcoat + Sheen + Glass Transmission (Beer-Lambert) + full GPU Texture
 *    Atlas (BaseColor, Normal Map TBN, Roughness, Metalness, Emissive).
 * 5. 2D HDRI Importance Sampling (Marginal/Conditional CDF from Rust) + Power-Heuristic MIS
 *    combining HDRI NEE, Analytic Lights NEE (Point/Sun/Spot/RectArea), and BSDF bounces.
 * 6. SVGF (Spatiotemporal Variance-Guided Filtering) + Motion-Vector Temporal Reprojection with
 *    disocclusion rejection, 3x3 neighborhood clamping, albedo demod/remod, and variance-guided
 *    separable à-trous filtering in VRAM.
 * 7. Exact Blender 4.5 OCIO AgX / ACES / Khronos PBR Neutral / Linear tonemap directly onto a
 *    WebGPU `<canvas>` for Zero-Copy GPU `VideoFrame(canvas)` H.264/VP9 encoding.
 *
 * File: js/render/webgpu-pathtracer.js
 */

import { RenderKernel, loadKernelBytes, TONEMAP, AGX_LOOK, encodeTonemapMode } from './rust-render-bridge.js';

const MAX_ATLAS_TEXTURES = 64;
const MAX_ATLAS_DIM = 2048;
const DEFAULT_SAMPLES_PER_CHUNK = 8;
const TARGET_GPU_BUFFER_LIMIT = 512 * 1024 * 1024; // Request up to 512 MiB on discrete GPUs

export class WebGPUDeviceLostError extends Error {
  constructor(message = 'WebGPU device lost during rendering') {
    super(message);
    this.name = 'WebGPUDeviceLostError';
  }
}

/**
 * Splits a target sample count into TDR-safe progressive GPU batches (each <= chunkSize spp)
 * so Windows WDDM 2-second GPU watchdog never kills discrete NVIDIA/AMD drivers on heavy scenes.
 */
export function computeChunkSchedule(totalSamples, chunkSize = DEFAULT_SAMPLES_PER_CHUNK) {
  const total = Math.max(1, Math.round(Number(totalSamples) || 1));
  const step = Math.max(1, Math.min(64, Math.round(Number(chunkSize) || DEFAULT_SAMPLES_PER_CHUNK)));
  const chunks = [];
  for (let start = 0; start < total; start += step) {
    const end = Math.min(total, start + step);
    chunks.push({
      sampleStart: start,
      sampleEnd: end,
      isFirst: start === 0,
      isLast: end >= total,
    });
  }
  return chunks;
}

/**
 * Selects safe elevated WebGPU device limits clamped to the user's actual GPU adapter capabilities.
 */
export function selectRequiredGpuLimits(adapterLimits) {
  if (!adapterLimits) return {};
  const required = {};
  if (typeof adapterLimits.maxBufferSize === 'number' && adapterLimits.maxBufferSize > 256 * 1024 * 1024) {
    required.maxBufferSize = Math.min(TARGET_GPU_BUFFER_LIMIT, adapterLimits.maxBufferSize);
  }
  if (typeof adapterLimits.maxStorageBufferBindingSize === 'number' && adapterLimits.maxStorageBufferBindingSize > 128 * 1024 * 1024) {
    required.maxStorageBufferBindingSize = Math.min(TARGET_GPU_BUFFER_LIMIT, adapterLimits.maxStorageBufferBindingSize);
  }
  return required;
}

/**
 * Classifies a WebGPU adapter's hardware info into a clean UI label and performance tier.
 */
export function classifyGpuAdapterInfo(info = {}, isFallback = false) {
  const vendor = String(info?.vendor || '').trim();
  const arch = String(info?.architecture || '').trim();
  const device = String(info?.device || '').trim();
  const desc = String(info?.description || '').trim();
  const combined = `${vendor} ${arch} ${device} ${desc}`.toLowerCase();

  const softwareRe = /(swiftshader|llvmpipe|softpipe|warp|microsoft basic|software|lavapipe)/;
  const discreteRe = /(nvidia|geforce|rtx|gtx|quadro|radeon rx|radeon pro|firepro|intel arc|b580|a770|a750|a380)/;

  let tier = 'integrated';
  if (isFallback || softwareRe.test(combined)) {
    tier = 'software';
  } else if (discreteRe.test(combined)) {
    tier = 'discrete';
  }

  let label = desc || [vendor, device || arch].filter(Boolean).join(' ') || 'WebGPU GPU';
  if (label.length > 42) label = `${label.slice(0, 39)}…`;
  return {
    label,
    vendor: vendor || 'unknown',
    architecture: arch || 'unknown',
    device: device || 'unknown',
    description: desc || '',
    isFallback: Boolean(isFallback || tier === 'software'),
    tier,
  };
}

const TRACE_WGSL = /* wgsl */ `
struct Uniforms {
  camOrigin: vec4<f32>,      // xyz, aperture
  camFwd: vec4<f32>,         // xyz, focus
  camRight: vec4<f32>,       // xyz, isOrtho
  camUp: vec4<f32>,          // xyz, shutter
  prevOrigin: vec4<f32>,     // xyz, hasPrevCam
  prevFwd: vec4<f32>,        // xyz, exposure
  prevRight: vec4<f32>,      // xyz, adaptiveThreshold
  prevUp: vec4<f32>,         // xyz, bgMode (0=env, 1=solid, 2=transparent)
  bgColor: vec4<f32>,        // rgb, envIntensity
  miscF: vec4<f32>,          // envRot, clampVal, hasEnvCdf, frameIdx
  dims: vec4<u32>,           // width, height, totalSpp, maxBounces
  counts: vec4<u32>,         // seed, numLights, envW, envH
  chunk: vec4<u32>,          // sampleStart, sampleEnd, flags (1=first, 2=last), pad
  extra: vec4<u32>,          // emissiveCount, emissiveTexW, hasPrevTris, prevTriTexW
};

struct BvhNode {
  bmin: vec3<f32>,
  a: u32,
  bmax: vec3<f32>,
  nodeMeta: u32,
};

struct TriGeom {
  p0: vec3<f32>,
  mat: u32,
  e1: vec3<f32>,
  uv0x: f32,
  e2: vec3<f32>,
  uv0y: f32,
};

struct TriAttr {
  n0: vec3<f32>,
  uv1x: f32,
  n1: vec3<f32>,
  uv1y: f32,
  n2: vec3<f32>,
  uv2x: f32,
  tan: vec3<f32>,
  bSign: f32,
  uv2y: f32,
  area: f32,
  emAreaPdf: f32,
  pad1: f32,
};

struct TexAtlasUniforms {
  rects: array<vec4<f32>, 64>, // (uOff, vOff, uScale * (srgb ? +1 : -1), vScale)
};

@group(0) @binding(0) var<uniform> U: Uniforms;
@group(0) @binding(1) var<storage, read> bvhNodes: array<BvhNode>;
@group(0) @binding(2) var<storage, read> triGeom: array<TriGeom>;
@group(0) @binding(3) var<storage, read> triAttr: array<TriAttr>;
@group(0) @binding(4) var<storage, read> materials: array<vec4<f32>>;
@group(0) @binding(5) var<storage, read> lights: array<vec4<f32>>;
@group(0) @binding(6) var<storage, read_write> accumBuf: array<vec4<f32>>;
@group(0) @binding(7) var<storage, read_write> gbuf: array<vec4<f32>>;
@group(0) @binding(8) var<storage, read_write> stateBuf: array<vec4<f32>>;
@group(0) @binding(9) var<uniform> texAtlas: TexAtlasUniforms;
@group(0) @binding(10) var atlasTex: texture_2d<f32>;
@group(0) @binding(11) var atlasSampler: sampler;
@group(0) @binding(12) var envTex: texture_2d<f32>;
@group(0) @binding(13) var envCdfTex: texture_2d<f32>;
@group(0) @binding(14) var envRowCdfTex: texture_2d<f32>;
@group(0) @binding(15) var emissiveTex: texture_2d<f32>;
@group(0) @binding(16) var prevTriTex: texture_2d<f32>;

const PI: f32 = 3.14159265359;
const INV_PI: f32 = 0.31830988618;
const TWO_PI: f32 = 6.28318530718;

// ─── Algorithm 1: Owen-Scrambled Sobol QMC + R2 Blue-Noise Cranley-Patterson Shift ───
fn pcgHash(v_in: u32) -> u32 {
  var state = v_in * 747796405u + 2891336453u;
  let word = ((state >> ((state >> 28u) + 4u)) ^ state) * 277803737u;
  return (word >> 22u) ^ word;
}

// Laine-Karras hash for Owen scrambling (Burley 2020, Practical Hash-Based Owen Scrambling)
fn lkHash(x_in: u32, seed: u32) -> u32 {
  var x = x_in + seed;
  x ^= x * 0x6c50b47cu;
  x ^= x * 0xb82f1e52u;
  x ^= x * 0xc7afe638u;
  x ^= x * 0x8d22f6e6u;
  return x;
}

fn owenScramble(v: u32, seed: u32) -> u32 {
  return reverseBits(lkHash(reverseBits(v), seed));
}

fn sobol2nd(idx_in: u32) -> u32 {
  var idx = idx_in;
  var r: u32 = 0u;
  var v: u32 = 0x80000000u;
  while (idx != 0u) {
    if ((idx & 1u) != 0u) { r ^= v; }
    idx >>= 1u;
    v ^= v >> 1u;
  }
  return r;
}

struct QmcSampler {
  sampleIdx: u32,
  dim: u32,
  pixelHash: u32,
  r2Shift: vec2<f32>,
};

fn makeQmc(px: u32, py: u32, sampleIdx: u32, seed: u32) -> QmcSampler {
  // R2 low-discrepancy screen-space blue-noise sequence (Roberts 2018)
  let r2x = fract(f32(px) * 0.7548776662466927 + f32(py) * 0.5698402909980532 + f32(seed & 1023u) * 0.381966011);
  let r2y = fract(f32(px) * 0.5698402909980532 + f32(py) * 0.4301597090019468 + f32(seed & 1023u) * 0.618033989);
  let ph = pcgHash((px * 1973u) ^ (py * 9277u) ^ (seed * 26699u));
  return QmcSampler(sampleIdx, 0u, ph, vec2<f32>(r2x, r2y));
}

fn qmc2D(q: ptr<function, QmcSampler>) -> vec2<f32> {
  let d = (*q).dim;
  (*q).dim = d + 2u;
  let idx = (*q).sampleIdx;
  let s0 = pcgHash((*q).pixelHash ^ (d * 0x9e3779b9u));
  let s1 = pcgHash((*q).pixelHash ^ ((d + 1u) * 0x85ebca6bu));
  // Permute sample index per bounce pair to decorrelate dimensions cleanly (Cycles style)
  let permIdx = owenScramble(idx, s0 ^ 0x27d4eb2du);
  let u0 = f32(owenScramble(reverseBits(permIdx), s0) >> 8u) * (1.0 / 16777216.0);
  let u1 = f32(owenScramble(sobol2nd(permIdx), s1) >> 8u) * (1.0 / 16777216.0);
  if (d == 0u) {
    return fract(vec2<f32>(u0, u1) + (*q).r2Shift);
  }
  return vec2<f32>(u0, u1);
}

fn qmc1D(q: ptr<function, QmcSampler>) -> f32 {
  let d = (*q).dim;
  (*q).dim = d + 1u;
  let s = pcgHash((*q).pixelHash ^ (d * 0x9e3779b9u));
  let u = f32(owenScramble(reverseBits((*q).sampleIdx), s) >> 8u) * (1.0 / 16777216.0);
  return u;
}

// ─── Texture Atlas Sampling (Hardware GPU Cache + sRGB decode) ───
fn srgbToLinear(c: vec3<f32>) -> vec3<f32> {
  let lo = c / 12.92;
  let hi = pow(max((c + 0.055) / 1.055, vec3<f32>(0.0)), vec3<f32>(2.4));
  return select(hi, lo, c <= vec3<f32>(0.04045));
}

fn sampleAtlas(texIdF: f32, uv: vec2<f32>) -> vec4<f32> {
  let tid = i32(round(texIdF));
  if (tid < 0 || tid >= 64) { return vec4<f32>(-1.0); }
  let rect = texAtlas.rects[tid];
  let absScaleU = abs(rect.z);
  if (absScaleU < 1e-6 || rect.w < 1e-6) { return vec4<f32>(-1.0); }
  let wrapped = fract(uv);
  // Inset by half a texel to avoid bleeding across atlas borders
  let eps = 0.0005;
  let u = rect.x + clamp(wrapped.x, eps, 1.0 - eps) * absScaleU;
  let v = rect.y + clamp(wrapped.y, eps, 1.0 - eps) * rect.w;
  let raw = textureSampleLevel(atlasTex, atlasSampler, vec2<f32>(u, v), 0.0);
  if (rect.z > 0.0) {
    return vec4<f32>(srgbToLinear(raw.rgb), raw.a);
  }
  return raw;
}

// ─── Algorithm 4: 2D HDRI Importance Sampling (Marginal/Conditional CDF from Rust) + MIS ───
fn envToLocal(dir: vec3<f32>) -> vec3<f32> {
  let rot = -U.miscF.x;
  let c = cos(rot);
  let s = sin(rot);
  return vec3<f32>(c * dir.x + s * dir.z, dir.y, -s * dir.x + c * dir.z);
}

fn envFromLocal(dir: vec3<f32>) -> vec3<f32> {
  let rot = U.miscF.x;
  let c = cos(rot);
  let s = sin(rot);
  return vec3<f32>(c * dir.x + s * dir.z, dir.y, -s * dir.x + c * dir.z);
}

fn evalEnv(dir: vec3<f32>) -> vec3<f32> {
  if (U.bgColor.w <= 0.0) { return vec3<f32>(0.0); }
  let ew = U.counts.z;
  let eh = U.counts.w;
  if (ew > 0u && eh > 0u) {
    let d = envToLocal(dir);
    let u = fract(atan2(d.z, d.x) * (0.5 * INV_PI) + 0.5);
    let v = clamp(acos(clamp(d.y, -1.0, 1.0)) * INV_PI, 0.0, 1.0);
    let ix = min(i32(u * f32(ew)), i32(ew) - 1);
    let iy = min(i32(v * f32(eh)), i32(eh) - 1);
    return textureLoad(envTex, vec2<i32>(ix, iy), 0).rgb * U.bgColor.w;
  }
  let t = clamp(dir.y * 0.5 + 0.5, 0.0, 1.0);
  let sky = mix(vec3<f32>(0.18, 0.19, 0.22), vec3<f32>(0.55, 0.65, 0.80), t);
  return sky * U.bgColor.w;
}

fn envPdf(dir: vec3<f32>) -> f32 {
  if (U.miscF.z < 0.5 || U.bgColor.w <= 0.0) { return 0.0; }
  let ew = U.counts.z;
  let eh = U.counts.w;
  if (ew == 0u || eh == 0u) { return 0.0; }
  let d = envToLocal(dir);
  let u = fract(atan2(d.z, d.x) * (0.5 * INV_PI) + 0.5);
  let v = clamp(acos(clamp(d.y, -1.0, 1.0)) * INV_PI, 0.0, 1.0);
  let ix = min(i32(u * f32(ew)), i32(ew) - 1);
  let iy = min(i32(v * f32(eh)), i32(eh) - 1);
  return textureLoad(envCdfTex, vec2<i32>(ix, iy), 0).g;
}

struct EnvSample {
  dir: vec3<f32>,
  pdf: f32,
  rad: vec3<f32>,
  valid: f32,
};

fn sampleEnvCdf(r1: f32, r2: f32) -> EnvSample {
  var out = EnvSample(vec3<f32>(0.0, 1.0, 0.0), 0.0, vec3<f32>(0.0), 0.0);
  if (U.miscF.z < 0.5 || U.bgColor.w <= 0.0) { return out; }
  let ew = i32(U.counts.z);
  let eh = i32(U.counts.w);
  if (ew <= 0 || eh <= 0) { return out; }

  // Binary search 1D marginal row CDF
  var loY: i32 = 0;
  var hiY: i32 = eh - 1;
  while (loY < hiY) {
    let mid = (loY + hiY) >> 1;
    let c = textureLoad(envRowCdfTex, vec2<i32>(mid, 0), 0).r;
    if (c < r1) { loY = mid + 1; } else { hiY = mid; }
  }
  let y = loY;

  // Binary search 1D conditional column CDF along row y
  var loX: i32 = 0;
  var hiX: i32 = ew - 1;
  while (loX < hiX) {
    let mid = (loX + hiX) >> 1;
    let c = textureLoad(envCdfTex, vec2<i32>(mid, y), 0).r;
    if (c < r2) { loX = mid + 1; } else { hiX = mid; }
  }
  let x = loX;

  let cdfPdf = textureLoad(envCdfTex, vec2<i32>(x, y), 0);
  let pdf = cdfPdf.g;
  if (pdf <= 1e-7) { return out; }

  let u = (f32(x) + 0.5) / f32(ew);
  let v = (f32(y) + 0.5) / f32(eh);
  let theta = v * PI;
  let phi = (u - 0.5) * TWO_PI;
  let st = sin(theta);
  let localDir = vec3<f32>(st * cos(phi), cos(theta), st * sin(phi));
  out.dir = envFromLocal(localDir);
  out.rad = textureLoad(envTex, vec2<i32>(x, y), 0).rgb * U.bgColor.w;
  out.pdf = pdf;
  out.valid = 1.0;
  return out;
}

fn powerHeuristic(pa: f32, pb: f32) -> f32 {
  let a2 = pa * pa;
  let b2 = pb * pb;
  return a2 / max(a2 + b2, 1e-12);
}

// ─── BVH2 Traversal (Rust Binned-SAH 32B Nodes) ───
fn buildBasis(n: vec3<f32>) -> mat2x3<f32> {
  let signVal = select(-1.0, 1.0, n.z >= 0.0);
  let a = -1.0 / (signVal + n.z);
  let b = n.x * n.y * a;
  let t1 = vec3<f32>(1.0 + signVal * n.x * n.x * a, signVal * b, -signVal * n.x);
  let t2 = vec3<f32>(b, signVal + n.y * n.y * a, -n.y);
  return mat2x3<f32>(t1, t2);
}

fn hitAabb(bmin: vec3<f32>, bmax: vec3<f32>, o: vec3<f32>, invD: vec3<f32>, tmax: f32) -> f32 {
  let t0 = (bmin - o) * invD;
  let t1 = (bmax - o) * invD;
  let lo = min(t0, t1);
  let hi = max(t0, t1);
  let tmin = max(max(lo.x, lo.y), max(lo.z, 0.0));
  let tExit = min(min(hi.x, hi.y), min(hi.z, tmax));
  return select(1e30, tmin, tmin <= tExit * 1.000001);
}

struct HitInfo {
  t: f32,
  u: f32,
  v: f32,
  tri: u32,
};

fn loadPrevTri(ti: u32) -> mat3x3<f32> {
  let pw = max(1u, U.extra.w);
  let base = ti * 3u;
  let c0 = textureLoad(prevTriTex, vec2<i32>(i32(base % pw), i32(base / pw)), 0).xyz;
  let b1 = base + 1u;
  let c1 = textureLoad(prevTriTex, vec2<i32>(i32(b1 % pw), i32(b1 / pw)), 0).xyz;
  let b2 = base + 2u;
  let c2 = textureLoad(prevTriTex, vec2<i32>(i32(b2 % pw), i32(b2 / pw)), 0).xyz;
  return mat3x3<f32>(c0, c1, c2);
}

fn loadEmissiveEntry(idx: u32) -> vec4<f32> {
  let ew = max(1u, U.extra.y);
  return textureLoad(emissiveTex, vec2<i32>(i32(idx % ew), i32(idx / ew)), 0);
}

fn intersectBvh(o: vec3<f32>, d: vec3<f32>, tmaxIn: f32, tShut: f32) -> HitInfo {
  var best = HitInfo(tmaxIn, 0.0, 0.0, 0xFFFFFFFFu);
  let nNodes = arrayLength(&bvhNodes);
  if (nNodes == 0u) { return best; }
  let invD = 1.0 / d;
  if (hitAabb(bvhNodes[0].bmin, bvhNodes[0].bmax, o, invD, best.t) >= 1e29) {
    return best;
  }
  let useMotion = tShut > 1e-4 && U.extra.z != 0u;
  var stack: array<u32, 64>;
  stack[0] = 0u;
  var sp: i32 = 1;

  while (sp > 0) {
    sp -= 1;
    let idx = stack[sp];
    let node = bvhNodes[idx];
    let cnt = node.nodeMeta & 0x3FFFFFFFu;
    if (cnt > 0u) {
      let start = node.a;
      for (var i: u32 = 0u; i < cnt; i += 1u) {
        let ti = start + i;
        let tg = triGeom[ti];
        var p0 = tg.p0;
        var e1 = tg.e1;
        var e2 = tg.e2;
        if (useMotion) {
          let pv = loadPrevTri(ti);
          p0 = mix(p0, pv[0], tShut);
          e1 = mix(e1, pv[1], tShut);
          e2 = mix(e2, pv[2], tShut);
        }
        let p = cross(d, e2);
        let det = dot(e1, p);
        if (abs(det) < 1e-10) { continue; }
        let invDet = 1.0 / det;
        let s = o - p0;
        let u = dot(s, p) * invDet;
        if (u < 0.0 || u > 1.0) { continue; }
        let q = cross(s, e1);
        let v = dot(d, q) * invDet;
        if (v < 0.0 || u + v > 1.0) { continue; }
        let dist = dot(e2, q) * invDet;
        if (dist > 1e-5 && dist < best.t) {
          best.t = dist;
          best.u = u;
          best.v = v;
          best.tri = ti;
        }
      }
    } else {
      let leftIdx = idx + 1u;
      let rightIdx = node.a;
      let dl = hitAabb(bvhNodes[leftIdx].bmin, bvhNodes[leftIdx].bmax, o, invD, best.t);
      let dr = hitAabb(bvhNodes[rightIdx].bmin, bvhNodes[rightIdx].bmax, o, invD, best.t);
      if (dl < 1e29 && dr < 1e29) {
        if (dl < dr) {
          if (sp < 62) { stack[sp] = rightIdx; sp += 1; stack[sp] = leftIdx; sp += 1; }
        } else {
          if (sp < 62) { stack[sp] = leftIdx; sp += 1; stack[sp] = rightIdx; sp += 1; }
        }
      } else if (dl < 1e29) {
        if (sp < 63) { stack[sp] = leftIdx; sp += 1; }
      } else if (dr < 1e29) {
        if (sp < 63) { stack[sp] = rightIdx; sp += 1; }
      }
    }
  }
  return best;
}

fn occludedBvh(o: vec3<f32>, d: vec3<f32>, tmax: f32, tShut: f32) -> bool {
  let nNodes = arrayLength(&bvhNodes);
  if (nNodes == 0u) { return false; }
  let invD = 1.0 / d;
  if (hitAabb(bvhNodes[0].bmin, bvhNodes[0].bmax, o, invD, tmax) >= 1e29) {
    return false;
  }
  let useMotion = tShut > 1e-4 && U.extra.z != 0u;
  var stack: array<u32, 64>;
  stack[0] = 0u;
  var sp: i32 = 1;

  while (sp > 0) {
    sp -= 1;
    let idx = stack[sp];
    let node = bvhNodes[idx];
    let cnt = node.nodeMeta & 0x3FFFFFFFu;
    if (cnt > 0u) {
      let start = node.a;
      for (var i: u32 = 0u; i < cnt; i += 1u) {
        let ti = start + i;
        let tg = triGeom[ti];
        var p0 = tg.p0;
        var e1 = tg.e1;
        var e2 = tg.e2;
        if (useMotion) {
          let pv = loadPrevTri(ti);
          p0 = mix(p0, pv[0], tShut);
          e1 = mix(e1, pv[1], tShut);
          e2 = mix(e2, pv[2], tShut);
        }
        let p = cross(d, e2);
        let det = dot(e1, p);
        if (abs(det) < 1e-10) { continue; }
        let invDet = 1.0 / det;
        let s = o - p0;
        let u = dot(s, p) * invDet;
        if (u < 0.0 || u > 1.0) { continue; }
        let q = cross(s, e1);
        let v = dot(d, q) * invDet;
        if (v < 0.0 || u + v > 1.0) { continue; }
        let dist = dot(e2, q) * invDet;
        if (dist > 1e-5 && dist < tmax) {
          return true;
        }
      }
    } else {
      let leftIdx = idx + 1u;
      let rightIdx = node.a;
      if (hitAabb(bvhNodes[leftIdx].bmin, bvhNodes[leftIdx].bmax, o, invD, tmax) < 1e29 && sp < 63) {
        stack[sp] = leftIdx; sp += 1;
      }
      if (hitAabb(bvhNodes[rightIdx].bmin, bvhNodes[rightIdx].bmax, o, invD, tmax) < 1e29 && sp < 63) {
        stack[sp] = rightIdx; sp += 1;
      }
    }
  }
  return false;
}

fn shadowTransmittance(o: vec3<f32>, d: vec3<f32>, tmax: f32, tShut: f32) -> vec3<f32> {
  var ro = o;
  var remT = tmax;
  var tr = vec3<f32>(1.0);
  for (var hop: u32 = 0u; hop < 6u; hop += 1u) {
    let h = intersectBvh(ro, d, remT, tShut);
    if (h.tri == 0xFFFFFFFFu) { break; }
    let tg = triGeom[h.tri];
    let mb = tg.mat * 8u;
    let m0 = materials[mb];
    let m2 = materials[mb + 2u];
    let m7 = materials[mb + 7u];
    var base = m0.rgb;
    var opacity = clamp(m2.z, 0.0, 1.0);
    if (m2.w >= -0.5) {
      let ta = triAttr[h.tri];
      let w0 = 1.0 - h.u - h.v;
      let uv = (vec2<f32>(tg.uv0x, tg.uv0y) * w0 + vec2<f32>(ta.uv1x, ta.uv1y) * h.u + vec2<f32>(ta.uv2x, ta.uv2y) * h.v) * vec2<f32>(m7.z, m7.w);
      let texBase = sampleAtlas(m2.w, uv);
      if (texBase.x >= 0.0) {
        base = base * texBase.rgb;
        opacity *= texBase.a;
      }
    }
    let passTrans = clamp(m2.x, 0.0, 1.0) * (1.0 - clamp(m0.w, 0.0, 1.0));
    if (opacity >= 0.999 && passTrans <= 0.001) {
      return vec3<f32>(0.0);
    }
    let tint = vec3<f32>(1.0 - opacity) + base * (opacity * passTrans);
    tr = tr * tint;
    if (max(tr.x, max(tr.y, tr.z)) < 1e-3) {
      return vec3<f32>(0.0);
    }
    let stepT = h.t + 2e-4;
    if (remT < 1e19) {
      if (stepT >= remT) { break; }
      remT -= stepT;
    }
    ro = ro + d * stepT;
  }
  return tr;
}

// ─── Algorithm 3: Principled BSDF v2 (Heitz GGX VNDF + Multi-Scattering GGX + Clearcoat + Sheen) ───
fn schlick(f0: vec3<f32>, c: f32) -> vec3<f32> {
  let m = clamp(1.0 - c, 0.0, 1.0);
  let m2 = m * m;
  return f0 + (vec3<f32>(1.0) - f0) * (m2 * m2 * m);
}

fn schlickScalar(f0: f32, c: f32) -> f32 {
  let m = clamp(1.0 - c, 0.0, 1.0);
  let m2 = m * m;
  return f0 + (1.0 - f0) * (m2 * m2 * m);
}

fn ggxD(nh: f32, a2: f32) -> f32 {
  let d = nh * nh * (a2 - 1.0) + 1.0;
  return a2 / max(PI * d * d, 1e-7);
}

fn smithG1(nz: f32, a2: f32) -> f32 {
  let nz2 = max(nz * nz, 1e-7);
  return 2.0 / (1.0 + sqrt(1.0 + a2 * (1.0 - nz2) / nz2));
}

fn charlieD(nh: f32, rough: f32) -> f32 {
  let r = clamp(rough, 0.05, 1.0);
  let invR = 1.0 / (r * r);
  let sin2h = max(1.0 - nh * nh, 1e-5);
  return (2.0 + invR) * pow(sin2h, invR * 0.5) / TWO_PI;
}

// Heitz (2018) Sampling the GGX Distribution of Visible Normals (exact Cycles algorithm)
fn sampleGgxVndf(vl: vec3<f32>, alpha: f32, u1: f32, u2: f32) -> vec3<f32> {
  let vh = normalize(vec3<f32>(alpha * vl.x, alpha * vl.y, max(vl.z, 1e-4)));
  let lensq = vh.x * vh.x + vh.y * vh.y;
  let t1 = select(vec3<f32>(1.0, 0.0, 0.0), vec3<f32>(-vh.y, vh.x, 0.0) * inverseSqrt(lensq), lensq > 1e-7);
  let t2 = cross(vh, t1);
  let r = sqrt(clamp(u1, 0.0, 0.999999));
  let phi = TWO_PI * u2;
  let p1 = r * cos(phi);
  let p2Raw = r * sin(phi);
  let s = 0.5 * (1.0 + vh.z);
  let p2 = (1.0 - s) * sqrt(max(0.0, 1.0 - p1 * p1)) + s * p2Raw;
  let nh = t1 * p1 + t2 * p2 + vh * sqrt(max(0.0, 1.0 - p1 * p1 - p2 * p2));
  return normalize(vec3<f32>(alpha * nh.x, alpha * nh.y, max(0.0, nh.z)));
}

struct ShadeState {
  n: vec3<f32>,
  t1: vec3<f32>,
  t2: vec3<f32>,
  base: vec3<f32>,
  f0: vec3<f32>,
  msComp: vec3<f32>,
  metal: f32,
  alpha: f32,
  a2: f32,
  clearcoat: f32,
  alphaCc: f32,
  sheen: f32,
  sheenRough: f32,
  sheenColor: vec3<f32>,
  ps: f32,
  pCc: f32,
};

fn buildShade(
  n: vec3<f32>, t1: vec3<f32>, t2: vec3<f32>, v: vec3<f32>,
  base: vec3<f32>, metal: f32, rough: f32, ior: f32,
  clearcoat: f32, ccRough: f32, sheen: f32, sheenRough: f32, sheenColor: vec3<f32>
) -> ShadeState {
  let r = clamp(rough, 0.04, 1.0);
  let alpha = r * r;
  let a2 = alpha * alpha;
  let f0d = ((ior - 1.0) / (ior + 1.0));
  let f0 = mix(vec3<f32>(f0d * f0d), base, metal);
  let nv = max(dot(n, v), 1e-4);

  // Turquin / Blender Principled BSDF v2 Multi-Scattering GGX energy compensation
  let ess = clamp(1.0 / (1.0 + alpha * (1.35 + 0.85 * pow(max(0.0, 1.0 - nv), 1.5))), 0.28, 1.0);
  let msComp = vec3<f32>(1.0) + f0 * ((1.0 / ess) - 1.0);

  let fCoat = clearcoat * schlickScalar(0.04, nv);
  let fNv = schlick(f0, nv);
  let fLum = dot(fNv, vec3<f32>(0.2126, 0.7152, 0.0722));
  let bLum = dot(base, vec3<f32>(0.2126, 0.7152, 0.0722));
  let kdW = (1.0 - metal) * bLum * (1.0 - fLum) * (1.0 - fCoat);
  let ksW = fLum * (1.0 - fCoat);
  let sumW = kdW + ksW + fCoat;
  let pCc = select(0.0, clamp(fCoat / sumW, 0.0, 0.7), sumW > 1e-5);
  let rem = 1.0 - pCc;
  let ps = select(clamp(ksW / max(ksW + kdW, 1e-5), 0.05, 0.95) * rem, rem, kdW < 1e-4);
  let alphaCc = clamp(ccRough, 0.04, 1.0) * clamp(ccRough, 0.04, 1.0);
  return ShadeState(n, t1, t2, base, f0, msComp, metal, alpha, a2, clearcoat, alphaCc, sheen, sheenRough, sheenColor, ps, pCc);
}

fn evalBsdf(sh: ShadeState, v: vec3<f32>, l: vec3<f32>) -> vec3<f32> {
  let nv = dot(sh.n, v);
  let nl = dot(sh.n, l);
  if (nv <= 1e-4 || nl <= 1e-4) { return vec3<f32>(0.0); }
  let h = normalize(v + l);
  let nh = max(dot(sh.n, h), 0.0);
  let vh = max(dot(v, h), 0.0);
  let f = schlick(sh.f0, vh);
  let spec = f * sh.msComp * (ggxD(nh, sh.a2) * smithG1(nv, sh.a2) * smithG1(nl, sh.a2) / max(4.0 * nv * nl, 1e-5));
  let kd = vec3<f32>(1.0) - schlick(sh.f0, nv);
  var diff = sh.base * kd * ((1.0 - sh.metal) * INV_PI);
  if (sh.sheen > 0.0) {
    let sv = charlieD(nh, sh.sheenRough) / max(4.0 * (nl + nv - nl * nv), 0.1);
    diff = diff + sh.sheenColor * (sh.sheen * sv);
  }
  var res = diff + spec;
  if (sh.clearcoat > 0.0) {
    let a2c = sh.alphaCc * sh.alphaCc;
    let fc = sh.clearcoat * schlickScalar(0.04, vh);
    let coat = ggxD(nh, a2c) * smithG1(nv, a2c) * smithG1(nl, a2c) / max(4.0 * nv * nl, 1e-5);
    res = res * (1.0 - sh.clearcoat * schlickScalar(0.04, nv)) + vec3<f32>(fc * coat);
  }
  return res;
}

fn evalBsdfPdf(sh: ShadeState, v: vec3<f32>, l: vec3<f32>) -> f32 {
  let nv = dot(sh.n, v);
  let nl = dot(sh.n, l);
  if (nv <= 1e-4 || nl <= 1e-4) { return 0.0; }
  let h = normalize(v + l);
  let nh = max(dot(sh.n, h), 0.0);
  let specPdf = ggxD(nh, sh.a2) * smithG1(nv, sh.a2) / max(4.0 * nv, 1e-5);
  var p = sh.ps * specPdf + max(1.0 - sh.ps - sh.pCc, 0.0) * nl * INV_PI;
  if (sh.pCc > 0.0) {
    let a2c = sh.alphaCc * sh.alphaCc;
    let ccPdf = ggxD(nh, a2c) * smithG1(nv, a2c) / max(4.0 * nv, 1e-5);
    p += sh.pCc * ccPdf;
  }
  return p;
}

fn evalDirectLights(pt: vec3<f32>, ng: vec3<f32>, sh: ShadeState, v: vec3<f32>, bounce: u32, tShut: f32, q: ptr<function, QmcSampler>) -> vec3<f32> {
  var sum = vec3<f32>(0.0);
  let origin = pt + ng * 1e-4;
  let nl = U.counts.y;
  let hasAnalytic = nl > 0u;
  let hasHdri = U.miscF.z > 0.5 && U.bgColor.w > 0.0;
  let emCount = U.extra.x;
  let hasEmissive = emCount > 0u;

  // Cycles-style stochastic light-group selection on secondary bounces (halves shadow rays on bounce >= 1)
  var doAnalytic = hasAnalytic;
  var doHdri = hasHdri;
  var groupScale: f32 = 1.0;
  if (bounce >= 1u && hasAnalytic && hasHdri) {
    if (qmc1D(q) < 0.5) {
      doHdri = false;
    } else {
      doAnalytic = false;
    }
    groupScale = 2.0;
  }

  // 1. Analytic scene lights (Point/Sphere, Sun, Spot, RectArea)
  if (doAnalytic) {
    let li = min(u32(qmc1D(q) * f32(nl)), nl - 1u);
    let r2 = qmc2D(q);
    let b = li * 4u;
    let l0 = lights[b];
    let l1 = lights[b + 1u];
    let l2 = lights[b + 2u];
    let l3 = lights[b + 3u];
    let kind = u32(round(l0.x));
    let lpos = vec3<f32>(l0.y, l0.z, l0.w);
    let lcol = vec3<f32>(l1.x, l1.y, l1.z);
    let ldirRaw = vec3<f32>(l1.w, l2.x, l2.y);
    let lrad = l2.z;
    var wi = vec3<f32>(0.0);
    var dist = 1e20;
    var rad = vec3<f32>(0.0);
    var valid = false;

    if (kind == 1u) {
      let baseDir = normalize(ldirRaw);
      wi = baseDir;
      if (lrad > 1e-5) {
        let basis = buildBasis(baseDir);
        let r = sqrt(r2.x) * sin(lrad);
        let phi = TWO_PI * r2.y;
        wi = normalize(baseDir + basis[0] * (r * cos(phi)) + basis[1] * (r * sin(phi)));
      }
      rad = lcol;
      valid = true;
    } else if (kind == 0u || kind == 2u) {
      var lightPt = lpos;
      if (lrad > 1e-5) {
        let z = 1.0 - 2.0 * r2.x;
        let r = sqrt(max(0.0, 1.0 - z * z));
        let phi = TWO_PI * r2.y;
        lightPt = lpos + vec3<f32>(r * cos(phi), r * sin(phi), z) * lrad;
      }
      let to = lightPt - origin;
      let d2 = dot(to, to);
      if (d2 > 1e-8) {
        dist = sqrt(d2);
        wi = to / dist;
        var atten = 1.0 / d2;
        if (kind == 2u) {
          let cosA = dot(-wi, normalize(ldirRaw));
          let cosOuter = l2.w;
          let cosInner = l3.x;
          if (cosA <= cosOuter) { atten = 0.0; }
          else if (cosA < cosInner) {
            let t = clamp((cosA - cosOuter) / max(cosInner - cosOuter, 1e-5), 0.0, 1.0);
            atten *= t * t * (3.0 - 2.0 * t);
          }
        }
        rad = lcol * atten;
        valid = atten > 0.0;
      }
    } else if (kind == 3u) {
      let lnorm = normalize(ldirRaw);
      let hw = l2.w;
      let hh = l3.x;
      let uAx = normalize(vec3<f32>(l3.y, l3.z, l3.w));
      let vAx = cross(lnorm, uAx);
      let lightPt = lpos + uAx * ((r2.x * 2.0 - 1.0) * hw) + vAx * ((r2.y * 2.0 - 1.0) * hh);
      let to = lightPt - origin;
      let d2 = dot(to, to);
      if (d2 > 1e-8) {
        dist = sqrt(d2);
        wi = to / dist;
        let cosL = dot(-wi, lnorm);
        if (cosL > 1e-4) {
          let area = 4.0 * hw * hh;
          rad = lcol * (area * cosL / d2);
          valid = true;
        }
      }
    }

    if (valid) {
      let cosS = dot(sh.n, wi);
      if (cosS > 0.0) {
        let trSh = shadowTransmittance(origin, wi, dist * 0.998, tShut);
        if (trSh.x + trSh.y + trSh.z > 0.0) {
          sum = sum + evalBsdf(sh, v, wi) * rad * trSh * (cosS * f32(nl) * groupScale);
        }
      }
    }
  }

  // 2. Emissive Mesh NEE (O(log N) CDF binary search from Rust + Power-Heuristic MIS!)
  if (hasEmissive) {
    let rSel = qmc1D(q);
    var loE: u32 = 0u;
    var hiE: u32 = emCount - 1u;
    while (loE < hiE) {
      let mid = (loE + hiE) >> 1u;
      let c = loadEmissiveEntry(mid).y;
      if (c < rSel) { loE = mid + 1u; } else { hiE = mid; }
    }
    let entry = loadEmissiveEntry(loE);
    let ti = bitcast<u32>(entry.x);
    let areaPdf = entry.z;
    if (areaPdf > 1e-10) {
      let rTri = qmc2D(q);
      let s0 = sqrt(clamp(rTri.x, 0.0, 1.0));
      let bu = 1.0 - s0;
      let bv = rTri.y * s0;
      let tg = triGeom[ti];
      var p0 = tg.p0;
      var e1 = tg.e1;
      var e2 = tg.e2;
      if (tShut > 1e-4 && U.extra.z != 0u) {
        let pv = loadPrevTri(ti);
        p0 = mix(p0, pv[0], tShut);
        e1 = mix(e1, pv[1], tShut);
        e2 = mix(e2, pv[2], tShut);
      }
      let lp = p0 + e1 * bu + e2 * bv;
      let ngL = normalize(cross(e1, e2));
      let to = lp - origin;
      let d2 = dot(to, to);
      if (d2 > 1e-8) {
        let dist = sqrt(d2);
        let wi = to / dist;
        let cosS = dot(sh.n, wi);
        let cosL = abs(dot(-wi, ngL));
        if (cosS > 0.0 && cosL > 1e-4) {
          let trSh = shadowTransmittance(origin, wi, dist * 0.996, tShut);
          if (trSh.x + trSh.y + trSh.z > 0.0) {
            let mb = tg.mat * 8u;
            let m1 = materials[mb + 1u];
            let m3 = materials[mb + 3u];
            let m7 = materials[mb + 7u];
            var emCol = vec3<f32>(m1.y, m1.z, m1.w);
            if (m3.w >= -0.5) {
              let ta = triAttr[ti];
              let bw0 = 1.0 - bu - bv;
              let uvL = (vec2<f32>(tg.uv0x, tg.uv0y) * bw0 + vec2<f32>(ta.uv1x, ta.uv1y) * bu + vec2<f32>(ta.uv2x, ta.uv2y) * bv) * vec2<f32>(m7.z, m7.w);
              let tEm = sampleAtlas(m3.w, uvL);
              if (tEm.x >= 0.0) { emCol = emCol * tEm.rgb; }
            }
            let solidPdf = areaPdf * d2 / cosL;
            let misW = powerHeuristic(solidPdf, evalBsdfPdf(sh, v, wi));
            sum = sum + evalBsdf(sh, v, wi) * emCol * trSh * (cosS * misW / solidPdf);
          }
        }
      }
    }
  }

  // 3. HDRI 2D CDF Importance Sampling + Power-Heuristic MIS (exact Cycles Env NEE!)
  if (doHdri) {
    let rEnv = qmc2D(q);
    let es = sampleEnvCdf(rEnv.x, rEnv.y);
    if (es.valid > 0.5) {
      let cosS = dot(sh.n, es.dir);
      if (cosS > 0.0) {
        let trSh = shadowTransmittance(origin, es.dir, 1e20, tShut);
        if (trSh.x + trSh.y + trSh.z > 0.0) {
          let bsdfPdf = evalBsdfPdf(sh, v, es.dir);
          let effEnvPdf = es.pdf / groupScale;
          let misW = powerHeuristic(effEnvPdf, bsdfPdf);
          sum = sum + evalBsdf(sh, v, es.dir) * es.rad * trSh * (cosS * misW * groupScale / es.pdf);
        }
      }
    }
  }
  return sum;
}

@compute @workgroup_size(8, 8)
fn traceMain(@builtin(global_invocation_id) gid: vec3<u32>) {
  let w = U.dims.x;
  let h = U.dims.y;
  if (gid.x >= w || gid.y >= h) { return; }

  let idx = gid.y * w + gid.x;
  let gb = idx * 4u;
  let totalSpp = max(1u, U.dims.z);
  let sampleStart = U.chunk.x;
  let sampleEnd = min(totalSpp, U.chunk.y);
  let isFirst = (U.chunk.z & 1u) != 0u;
  let isLast = (U.chunk.z & 2u) != 0u;
  let maxBounces = max(1u, U.dims.w);
  let clampVal = max(1.0, U.miscF.y);
  let bgMode = u32(round(U.prevUp.w));
  let isOrtho = U.camRight.w > 0.5;
  let aperture = U.camOrigin.w;
  let focusDist = max(0.01, U.camFwd.w);
  let shutter = clamp(U.camUp.w, 0.0, 1.0);
  let hasPrev = U.prevOrigin.w > 0.5;
  let adaptThresh = U.prevRight.w;
  let useAdaptive = adaptThresh > 0.0 && totalSpp >= 8u;
  let minSpp = min(max(4u, totalSpp / 4u), totalSpp);

  var accRad = vec3<f32>(0.0);
  var accAlpha: f32 = 0.0;
  var accAlb = vec3<f32>(0.0);
  var accNrm = vec3<f32>(0.0);
  var accHitPos = vec3<f32>(0.0);
  var accHitDist: f32 = 0.0;
  var accRough: f32 = 0.0;
  var primaryMatId: f32 = -1.0;
  var hitCount: f32 = 0.0;

  var lumSum: f32 = 0.0;
  var lumSqSum: f32 = 0.0;
  var evenLum: f32 = 0.0;
  var oddLum: f32 = 0.0;
  var actualSpp: u32 = 0u;
  var convergedFlag: f32 = 0.0;

  if (isFirst) {
    // Conservative Root-AABB Sky Cull (O(1) fast path for pure background pixels)
    let canSkyCull = aperture <= 0.0 && shutter <= 1e-4 && arrayLength(&bvhNodes) > 0u;
    if (canSkyCull) {
      let ndcX = ((f32(gid.x) + 0.5) / f32(w)) * 2.0 - 1.0;
      let ndcY = 1.0 - ((f32(gid.y) + 0.5) / f32(h)) * 2.0;
      var roC = U.camOrigin.xyz;
      var rdC = normalize(U.camFwd.xyz + U.camRight.xyz * ndcX + U.camUp.xyz * ndcY);
      if (isOrtho) {
        roC = U.camOrigin.xyz + U.camRight.xyz * ndcX + U.camUp.xyz * ndcY;
        rdC = normalize(U.camFwd.xyz);
      }
      let rootMin = bvhNodes[0].bmin - vec3<f32>(0.08);
      let rootMax = bvhNodes[0].bmax + vec3<f32>(0.08);
      if (hitAabb(rootMin, rootMax, roC, 1.0 / rdC, 1e20) >= 1e29) {
        var bgRad = vec3<f32>(0.0);
        var bgA = 1.0;
        if (bgMode == 1u) { bgRad = U.bgColor.xyz; }
        else if (bgMode == 2u) { bgA = 0.0; }
        else { bgRad = evalEnv(rdC); }
        let lum = dot(bgRad, vec3<f32>(0.2126, 0.7152, 0.0722));
        accumBuf[idx] = vec4<f32>(bgRad, bgA);
        gbuf[gb] = vec4<f32>(0.0, 0.0, 0.0, 0.0);
        gbuf[gb + 1u] = vec4<f32>(0.0, 0.0, 0.0, 0.0);
        gbuf[gb + 2u] = vec4<f32>(0.0, 0.0, 0.0, -1.0);
        gbuf[gb + 3u] = vec4<f32>(lum, lum * lum, 1.0, 1.0);
        stateBuf[idx] = vec4<f32>(0.0, 0.0, 1.0, 2.0);
        return;
      }
    }
  } else {
    let prevSt = stateBuf[idx];
    if (prevSt.w >= 1.5) {
      // Sky pixel already finalized on chunk 0
      return;
    }
    if (prevSt.w >= 0.5 && !isLast) {
      // Surface pixel already converged in earlier chunk; wait for final normalization pass
      return;
    }
    let prevAcc = accumBuf[idx];
    accRad = prevAcc.rgb;
    accAlpha = prevAcc.a;
    let pg0 = gbuf[gb];
    let pg1 = gbuf[gb + 1u];
    let pg2 = gbuf[gb + 2u];
    let pg3 = gbuf[gb + 3u];
    accAlb = pg0.rgb;
    accHitDist = pg0.w;
    accNrm = pg1.rgb;
    hitCount = pg1.w;
    accHitPos = pg2.xyz;
    primaryMatId = pg2.w;
    lumSum = pg3.x;
    lumSqSum = pg3.y;
    accRough = pg3.w;
    evenLum = prevSt.x;
    oddLum = prevSt.y;
    actualSpp = u32(round(prevSt.z));
    convergedFlag = prevSt.w;
  }

  for (var s: u32 = sampleStart; s < sampleEnd; s += 1u) {
    if (convergedFlag >= 0.5) { break; }
    actualSpp = s + 1u;
    var q = makeQmc(gid.x, gid.y, s, U.counts.x);
    let j = qmc2D(&q);
    let ndcX = ((f32(gid.x) + j.x) / f32(w)) * 2.0 - 1.0;
    let ndcY = 1.0 - ((f32(gid.y) + j.y) / f32(h)) * 2.0;

    // Camera & Deformation Shutter Motion Blur (shared shutter time tShut for camera + triangles)
    var cOrigin = U.camOrigin.xyz;
    var cFwd = U.camFwd.xyz;
    var cRight = U.camRight.xyz;
    var cUp = U.camUp.xyz;
    var tShut: f32 = 0.0;
    if (shutter > 1e-4 && (hasPrev || U.extra.z != 0u)) {
      tShut = qmc1D(&q) * shutter;
      if (hasPrev) {
        cOrigin = mix(cOrigin, U.prevOrigin.xyz, tShut);
        cFwd = mix(cFwd, U.prevFwd.xyz, tShut);
        cRight = mix(cRight, U.prevRight.xyz, tShut);
        cUp = mix(cUp, U.prevUp.xyz, tShut);
      }
    }

    var ro = cOrigin;
    var rd = normalize(cFwd + cRight * ndcX + cUp * ndcY);
    if (isOrtho) {
      ro = cOrigin + cRight * ndcX + cUp * ndcY;
      rd = normalize(cFwd);
    } else if (aperture > 1e-5) {
      let dLens = qmc2D(&q);
      let lr = sqrt(dLens.x) * aperture;
      let lphi = TWO_PI * dLens.y;
      let focusPt = ro + rd * focusDist;
      ro = ro + normalize(cRight) * (lr * cos(lphi)) + normalize(cUp) * (lr * sin(lphi));
      rd = normalize(focusPt - ro);
    }

    var thr = vec3<f32>(1.0);
    var rad = vec3<f32>(0.0);
    var alpha: f32 = 1.0;
    var aovDone = false;
    var lastBsdfPdf: f32 = 0.0;
    var specularBounce = true;
    var insideTrans = false;

    for (var bounce: u32 = 0u; bounce <= maxBounces; bounce += 1u) {
      let hit = intersectBvh(ro, rd, 1e20, tShut);
      if (hit.tri == 0xFFFFFFFFu) {
        if (bounce == 0u) {
          if (bgMode == 1u) { rad = rad + thr * U.bgColor.xyz; }
          else if (bgMode == 2u) { alpha = 0.0; }
          else { rad = rad + thr * evalEnv(rd); }
        } else {
          var envMis = 1.0;
          if (!specularBounce && U.miscF.z > 0.5) {
            let epdf = envPdf(rd);
            if (epdf > 0.0) {
              // At bounce > 1 when both analytic lights & HDRI are present, HDRI NEE runs 50% stochastically
              let effEpdf = select(epdf, epdf * 0.5, U.counts.y > 0u && bounce >= 2u);
              envMis = powerHeuristic(lastBsdfPdf, effEpdf);
            }
          }
          rad = rad + thr * evalEnv(rd) * envMis;
        }
        break;
      }

      let tg = triGeom[hit.tri];
      let ta = triAttr[hit.tri];
      let pt = ro + rd * hit.t;
      var ng = normalize(cross(tg.e1, tg.e2));
      let w0 = 1.0 - hit.u - hit.v;
      var ns = ta.n0 * w0 + ta.n1 * hit.u + ta.n2 * hit.v;
      ns = select(ng, normalize(ns), dot(ns, ns) > 1e-8);
      if (dot(ns, ng) < 0.0) { ns = -ns; }
      let front = dot(ng, rd) < 0.0;
      if (!front) { ng = -ng; ns = -ns; }

      let mb = tg.mat * 8u;
      let m0 = materials[mb];
      let m1 = materials[mb + 1u];
      let m2 = materials[mb + 2u];
      let m3 = materials[mb + 3u];
      let m4 = materials[mb + 4u];
      let m5 = materials[mb + 5u];
      let m6 = materials[mb + 6u];
      let m7 = materials[mb + 7u];

      // Interpolate UV & apply material repeat
      let uvRaw = vec2<f32>(tg.uv0x, tg.uv0y) * w0 + vec2<f32>(ta.uv1x, ta.uv1y) * hit.u + vec2<f32>(ta.uv2x, ta.uv2y) * hit.v;
      let uv = uvRaw * vec2<f32>(m7.z, m7.w);

      // Sample GPU Texture Atlas (BaseColor, Roughness, Metalness, Emissive, Normal Map)
      var base = m0.rgb;
      var opacity = m2.z;
      let texBase = sampleAtlas(m2.w, uv);
      if (texBase.x >= 0.0) {
        base = base * texBase.rgb;
        opacity *= texBase.a;
      }

      var metal = clamp(m0.w, 0.0, 1.0);
      var rough = clamp(m1.x, 0.04, 1.0);
      let texRough = sampleAtlas(m3.y, uv);
      if (texRough.x >= 0.0) { rough = clamp(rough * texRough.g, 0.04, 1.0); }
      let texMetal = sampleAtlas(m3.z, uv);
      if (texMetal.x >= 0.0) { metal = clamp(metal * texMetal.b, 0.0, 1.0); }

      var emit = vec3<f32>(m1.y, m1.z, m1.w);
      let texEmit = sampleAtlas(m3.w, uv);
      if (texEmit.x >= 0.0) { emit = emit * texEmit.rgb; }

      // TBN Normal Mapping
      let basis = buildBasis(ns);
      var t1 = basis[0];
      var t2 = basis[1];
      if (dot(ta.tan, ta.tan) > 1e-6) {
        let tOrtho = ta.tan - ns * dot(ta.tan, ns);
        if (dot(tOrtho, tOrtho) > 1e-6) {
          t1 = normalize(tOrtho);
          t2 = cross(ns, t1) * ta.bSign;
        }
      }
      let texNorm = sampleAtlas(m3.x, uv);
      if (texNorm.x >= 0.0) {
        let nScale = m6.w;
        let tn = vec3<f32>((texNorm.x * 2.0 - 1.0) * nScale, (texNorm.y * 2.0 - 1.0) * nScale, max(0.05, texNorm.z * 2.0 - 1.0));
        let nMap = normalize(t1 * tn.x + t2 * tn.y + ns * tn.z);
        if (dot(nMap, ng) > 0.0) {
          ns = nMap;
          let b2 = buildBasis(ns);
          t1 = b2[0];
          t2 = b2[1];
        }
      }

      // Beer-Lambert volume absorption inside transmissive dielectric
      if (!front && m6.z > 0.0) {
        let attCol = clamp(vec3<f32>(m5.w, m6.x, m6.y), vec3<f32>(1e-4), vec3<f32>(1.0));
        thr = thr * exp(log(attCol) * (hit.t / m6.z));
      }

      // Stochastic alpha cutout
      if (opacity < 0.999 && qmc1D(&q) > opacity) {
        ro = pt + rd * 1e-4;
        continue;
      }

      let trans = clamp(m2.x, 0.0, 1.0);
      let ior = max(1.01, m2.y);

      if (!aovDone && trans < 0.5) {
        accAlb = accAlb + base;
        accNrm = accNrm + ns;
        // Exact per-vertex previous-frame world point for SVGF Object + SkinnedMesh Motion Vectors!
        var prevWorldPt = pt;
        if (U.extra.z != 0u) {
          let pv = loadPrevTri(hit.tri);
          prevWorldPt = pv[0] + pv[1] * hit.u + pv[2] * hit.v;
        }
        accHitPos = accHitPos + prevWorldPt;
        accHitDist += hit.t;
        accRough += rough;
        primaryMatId = f32(tg.mat);
        hitCount += 1.0;
        aovDone = true;
      }

      if (dot(emit, emit) > 1e-6) {
        var emMis: f32 = 1.0;
        if (bounce > 0u && !specularBounce && ta.emAreaPdf > 1e-10) {
          let cosL = max(abs(dot(-rd, ng)), 1e-4);
          let solidPdf = ta.emAreaPdf * (hit.t * hit.t) / cosL;
          emMis = powerHeuristic(lastBsdfPdf, solidPdf);
        }
        rad = rad + thr * emit * emMis;
      }
      if (bounce >= maxBounces) { break; }

      let v = -rd;
      if (trans > 0.0 && qmc1D(&q) < trans) {
        let eta = select(ior, 1.0 / ior, front);
        let alphaG = clamp(rough, 0.02, 1.0) * clamp(rough, 0.02, 1.0);
        let rG = qmc2D(&q);
        let vl = vec3<f32>(dot(v, t1), dot(v, t2), max(dot(v, ns), 1e-4));
        let hl = sampleGgxVndf(vl, alphaG, rG.x, rG.y);
        let hVec = normalize(t1 * hl.x + t2 * hl.y + ns * hl.z);
        let cosI = clamp(dot(v, hVec), 0.0, 1.0);
        let r0 = (1.0 - eta) / (1.0 + eta);
        let fr = schlickScalar(r0 * r0, cosI);
        let sin2t = eta * eta * (1.0 - cosI * cosI);
        if (sin2t > 1.0 || qmc1D(&q) < fr) {
          rd = reflect(rd, hVec);
          ro = pt + ng * 1e-4;
          insideTrans = !front;
        } else {
          rd = normalize(eta * rd + (eta * cosI - sqrt(max(0.0, 1.0 - sin2t))) * hVec);
          if (front) { thr = thr * base; }
          ro = pt - ng * 1e-4;
          insideTrans = front;
        }
        specularBounce = alphaG < 0.04;
        if (specularBounce) {
          lastBsdfPdf = 1e6;
        } else {
          let a2G = alphaG * alphaG;
          let nhG = max(dot(ns, hVec), 1e-4);
          let nvG = max(dot(v, ns), 1e-4);
          lastBsdfPdf = max(ggxD(nhG, a2G) * smithG1(nvG, a2G) / (4.0 * nvG), 1e-4);
        }
      } else {
        let nv = dot(ns, v);
        if (nv <= 1e-4) { break; }
        let sh = buildShade(ns, t1, t2, v, base, metal, rough, ior, m4.x, m4.y, m4.z, m4.w, m5.xyz);
        rad = rad + thr * evalDirectLights(pt, ng, sh, v, bounce, tShut, &q);

        let rLobe = qmc1D(&q);
        let rBsdf = qmc2D(&q);
        var ndir = vec3<f32>(0.0);
        var bw = vec3<f32>(0.0);

        if (rLobe < sh.pCc) {
          let vl = vec3<f32>(dot(v, t1), dot(v, t2), nv);
          let hl = sampleGgxVndf(vl, sh.alphaCc, rBsdf.x, rBsdf.y);
          let hVec = normalize(t1 * hl.x + t2 * hl.y + ns * hl.z);
          ndir = reflect(-v, hVec);
          let nl = dot(ns, ndir);
          if (nl <= 1e-4) { break; }
          let fc = sh.clearcoat * schlickScalar(0.04, max(dot(v, hVec), 0.0));
          bw = vec3<f32>(fc * smithG1(nl, sh.alphaCc * sh.alphaCc) / sh.pCc);
          specularBounce = sh.alphaCc < 0.02;
        } else if (rLobe < sh.pCc + sh.ps) {
          let vl = vec3<f32>(dot(v, t1), dot(v, t2), nv);
          let hl = sampleGgxVndf(vl, sh.alpha, rBsdf.x, rBsdf.y);
          let hVec = normalize(t1 * hl.x + t2 * hl.y + ns * hl.z);
          ndir = reflect(-v, hVec);
          let nl = dot(ns, ndir);
          if (nl <= 1e-4) { break; }
          let f = schlick(sh.f0, max(dot(v, hVec), 0.0));
          let coatAtten = 1.0 - sh.clearcoat * schlickScalar(0.04, nv);
          bw = f * sh.msComp * (coatAtten * smithG1(nl, sh.a2) / sh.ps);
          specularBounce = sh.alpha < 0.02;
        } else {
          let r = sqrt(rBsdf.x);
          let phi = TWO_PI * rBsdf.y;
          ndir = normalize(t1 * (r * cos(phi)) + t2 * (r * sin(phi)) + ns * sqrt(max(0.0, 1.0 - rBsdf.x)));
          let kd = vec3<f32>(1.0) - schlick(sh.f0, nv);
          let coatAtten = 1.0 - sh.clearcoat * schlickScalar(0.04, nv);
          let pDiff = max(1.0 - sh.ps - sh.pCc, 1e-4);
          bw = sh.base * kd * (coatAtten * (1.0 - sh.metal) / pDiff);
          specularBounce = false;
        }
        lastBsdfPdf = evalBsdfPdf(sh, v, ndir);
        thr = thr * bw;
        ro = pt + ng * 1e-4;
        rd = ndir;
      }

      // Russian Roulette after bounce 2
      if (bounce >= 2u) {
        let pSurv = clamp(max(thr.x, max(thr.y, thr.z)), 0.05, 0.95);
        if (qmc1D(&q) > pSurv) { break; }
        thr = thr / pSurv;
      }
    }

    let maxC = max(rad.x, max(rad.y, rad.z));
    if (maxC > clampVal) { rad = rad * (clampVal / maxC); }
    accRad = accRad + rad;
    accAlpha += alpha;

    let lum = dot(rad, vec3<f32>(0.2126, 0.7152, 0.0722));
    lumSum += lum;
    lumSqSum += lum * lum;
    if ((s & 1u) == 0u) { evenLum += lum; } else { oddLum += lum; }

    // ─── Algorithm 2: Cycles X Adaptive Sampling (early exit on converged pixels) ───
    if (useAdaptive && actualSpp >= minSpp && (actualSpp & 3u) == 0u) {
      let halfN = f32(actualSpp >> 1u);
      let eMean = evenLum / halfN;
      let oMean = oddLum / halfN;
      let err = abs(eMean - oMean) / max(eMean + oMean, 0.08);
      if (err < adaptThresh) {
        convergedFlag = 1.0;
        break;
      }
    }
  }

  if (!isLast) {
    // Store unnormalized progressive sums across TDR-safe GPU chunks
    accumBuf[idx] = vec4<f32>(accRad, accAlpha);
    gbuf[gb] = vec4<f32>(accAlb, accHitDist);
    gbuf[gb + 1u] = vec4<f32>(accNrm, hitCount);
    gbuf[gb + 2u] = vec4<f32>(accHitPos, primaryMatId);
    gbuf[gb + 3u] = vec4<f32>(lumSum, lumSqSum, f32(actualSpp), accRough);
    stateBuf[idx] = vec4<f32>(evenLum, oddLum, f32(actualSpp), convergedFlag);
    return;
  }

  let invS = 1.0 / f32(max(1u, actualSpp));
  accumBuf[idx] = vec4<f32>(accRad * invS, accAlpha * invS);
  if (hitCount > 0.5) {
    let invH = 1.0 / hitCount;
    let nAvg = accNrm * invH;
    let nLen = length(nAvg);
    gbuf[gb] = vec4<f32>(accAlb * invH, accHitDist * invH);
    gbuf[gb + 1u] = vec4<f32>(select(vec3<f32>(0.0, 1.0, 0.0), nAvg / nLen, nLen > 1e-5), 1.0);
    gbuf[gb + 2u] = vec4<f32>(accHitPos * invH, primaryMatId);
    gbuf[gb + 3u] = vec4<f32>(lumSum * invS, lumSqSum * invS, f32(actualSpp), accRough * invH);
  } else {
    gbuf[gb] = vec4<f32>(0.0, 0.0, 0.0, 0.0);
    gbuf[gb + 1u] = vec4<f32>(0.0, 0.0, 0.0, 0.0);
    gbuf[gb + 2u] = vec4<f32>(0.0, 0.0, 0.0, -1.0);
    gbuf[gb + 3u] = vec4<f32>(lumSum * invS, lumSqSum * invS, f32(actualSpp), 1.0);
  }
  stateBuf[idx] = vec4<f32>(evenLum, oddLum, f32(actualSpp), 2.0);
}
`;

// ─── Algorithm 5a: SVGF Spatiotemporal Reprojection + 3x3 Clamping + Moment Accumulation ───
const SVGF_TEMPORAL_WGSL = /* wgsl */ `
struct TemporalParams {
  prevOrigin: vec4<f32>, // xyz, isOrtho
  prevFwd: vec4<f32>,    // xyz, rLen2
  prevRight: vec4<f32>,  // xyz, uLen2
  prevUp: vec4<f32>,     // xyz, fLen2
  dims: vec4<u32>,       // width, height, hasPrev, enableTemporal
  cfg: vec4<f32>,        // alphaMin, maxHist, demodAlbedo, pad
};

@group(0) @binding(0) var<uniform> T: TemporalParams;
@group(0) @binding(1) var<storage, read> curRad: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read> curGbuf: array<vec4<f32>>;
@group(0) @binding(3) var<storage, read> prevRad: array<vec4<f32>>;
@group(0) @binding(4) var<storage, read> prevGbuf: array<vec4<f32>>;
@group(0) @binding(5) var<storage, read> prevMom: array<vec4<f32>>;
@group(0) @binding(6) var<storage, read_write> outRad: array<vec4<f32>>;
@group(0) @binding(7) var<storage, read_write> outMom: array<vec4<f32>>;

@compute @workgroup_size(8, 8)
fn temporalMain(@builtin(global_invocation_id) gid: vec3<u32>) {
  let w = T.dims.x;
  let h = T.dims.y;
  if (gid.x >= w || gid.y >= h) { return; }

  let idx = gid.y * w + gid.x;
  let cRad = curRad[idx];
  let gb = idx * 4u;
  let g0 = curGbuf[gb];
  let g1 = curGbuf[gb + 1u];
  let g2 = curGbuf[gb + 2u];
  let g3 = curGbuf[gb + 3u];
  let hasSurf = g1.w > 0.5;

  let curM1 = g3.x;
  let curM2 = g3.y;
  let curVar = max(curM2 - curM1 * curM1, 0.0);

  if (!hasSurf) {
    outRad[idx] = cRad;
    outMom[idx] = vec4<f32>(curM1, curM2, 1.0, 0.0);
    return;
  }

  var blended = cRad.rgb;
  var m1 = curM1;
  var m2 = curM2;
  var histLen: f32 = 1.0;

  // Motion-vector reprojection into previous frame using world hit position
  if (T.dims.z != 0u && T.dims.w != 0u) {
    let hitP = g2.xyz;
    let rel = hitP - T.prevOrigin.xyz;
    var ndcX: f32 = -10.0;
    var ndcY: f32 = -10.0;
    var validProj = false;
    if (T.prevOrigin.w > 0.5) {
      ndcX = dot(rel, T.prevRight.xyz) / max(T.prevFwd.w, 1e-8);
      ndcY = dot(rel, T.prevUp.xyz) / max(T.prevRight.w, 1e-8);
      validProj = true;
    } else {
      let z = dot(rel, T.prevFwd.xyz) / max(T.prevUp.w, 1e-8);
      if (z > 1e-4) {
        ndcX = dot(rel, T.prevRight.xyz) / max(T.prevFwd.w * z, 1e-8);
        ndcY = dot(rel, T.prevUp.xyz) / max(T.prevRight.w * z, 1e-8);
        validProj = true;
      }
    }

    if (validProj && abs(ndcX) <= 1.0 && abs(ndcY) <= 1.0) {
      let pxF = (ndcX * 0.5 + 0.5) * f32(w) - 0.5;
      let pyF = (0.5 - ndcY * 0.5) * f32(h) - 0.5;
      let px = i32(round(pxF));
      let py = i32(round(pyF));
      if (px >= 0 && px < i32(w) && py >= 0 && py < i32(h)) {
        let pIdx = u32(py) * w + u32(px);
        let pGb = pIdx * 4u;
        let pg0 = prevGbuf[pGb];
        let pg1 = prevGbuf[pGb + 1u];
        let pg2 = prevGbuf[pGb + 2u];

        let nDot = dot(g1.xyz, pg1.xyz);
        let dDiff = abs(g0.w - pg0.w) / max(g0.w, 0.1);
        let matOk = abs(g2.w - pg2.w) < 0.5;
        if (pg1.w > 0.5 && nDot > 0.88 && dDiff < 0.14 && matOk) {
          // 3x3 spatial neighborhood color clamping to prevent ghosting on moving objects/lights
          var cMin = cRad.rgb;
          var cMax = cRad.rgb;
          let wi = i32(w);
          let hi = i32(h);
          for (var dy: i32 = -1; dy <= 1; dy += 1) {
            let yy = clamp(i32(gid.y) + dy, 0, hi - 1);
            for (var dx: i32 = -1; dx <= 1; dx += 1) {
              let xx = clamp(i32(gid.x) + dx, 0, wi - 1);
              let qi = u32(yy) * w + u32(xx);
              let qc = curRad[qi].rgb;
              cMin = min(cMin, qc);
              cMax = max(cMax, qc);
            }
          }
          let margin = (cMax - cMin) * 0.25 + vec3<f32>(0.02);
          let clampedPrev = clamp(prevRad[pIdx].rgb, max(vec3<f32>(0.0), cMin - margin), cMax + margin);
          let pm = prevMom[pIdx];
          histLen = min(pm.z + 1.0, T.cfg.y);
          let alpha = max(1.0 / histLen, T.cfg.x);
          blended = mix(clampedPrev, cRad.rgb, alpha);
          m1 = mix(pm.x, curM1, alpha);
          m2 = mix(pm.y, curM2, alpha);
        }
      }
    }
  }

  // Estimate spatial 3x3 variance boost when temporal history is short (SVGF §4.2)
  var variance = max(m2 - m1 * m1, curVar * 0.25);
  if (histLen < 4.0) {
    var s1: f32 = 0.0;
    var s2: f32 = 0.0;
    var cnt: f32 = 0.0;
    let wi = i32(w);
    let hi = i32(h);
    for (var dy: i32 = -1; dy <= 1; dy += 1) {
      let yy = i32(gid.y) + dy;
      if (yy < 0 || yy >= hi) { continue; }
      for (var dx: i32 = -1; dx <= 1; dx += 1) {
        let xx = i32(gid.x) + dx;
        if (xx < 0 || xx >= wi) { continue; }
        let qi = u32(yy) * w + u32(xx);
        let qn = curGbuf[qi * 4u + 1u];
        if (qn.w > 0.5 && dot(g1.xyz, qn.xyz) > 0.85) {
          let l = dot(curRad[qi].rgb, vec3<f32>(0.2126, 0.7152, 0.0722));
          s1 += l;
          s2 += l * l;
          cnt += 1.0;
        }
      }
    }
    if (cnt > 1.5) {
      let sm = s1 / cnt;
      let spVar = max(s2 / cnt - sm * sm, 0.0);
      variance = max(variance, spVar);
    }
  }

  // Optional albedo demodulation before à-trous so sharp textures stay crisp!
  if (T.cfg.z > 0.5) {
    let denom = g0.rgb + vec3<f32>(0.02);
    outRad[idx] = vec4<f32>(blended / denom, cRad.a);
  } else {
    outRad[idx] = vec4<f32>(blended, cRad.a);
  }
  outMom[idx] = vec4<f32>(m1, m2, histLen, variance);
}
`;

// ─── Algorithm 5b: SVGF Variance-Guided Edge-Avoiding Separable À-Trous + Albedo Remodulation ───
const DENOISE_WGSL = /* wgsl */ `
struct DenoiseParams {
  width: u32,
  height: u32,
  step: i32,
  vertical: u32,
  scaleInv2: f32,
  remodAlbedo: f32,
  pad1: f32,
  pad2: f32,
};

@group(0) @binding(0) var<uniform> D: DenoiseParams;
@group(0) @binding(1) var<storage, read> srcBuf: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read> gbuf: array<vec4<f32>>;
@group(0) @binding(3) var<storage, read> moments: array<vec4<f32>>;
@group(0) @binding(4) var<storage, read_write> dstBuf: array<vec4<f32>>;

@compute @workgroup_size(8, 8)
fn denoiseStep(@builtin(global_invocation_id) gid: vec3<u32>) {
  if (gid.x >= D.width || gid.y >= D.height) { return; }
  let ci = gid.y * D.width + gid.x;
  let c0 = srcBuf[ci];
  let gb = ci * 4u;
  let g0 = gbuf[gb];
  let n0 = gbuf[gb + 1u];
  if (n0.w < 0.5) {
    dstBuf[ci] = c0;
    return;
  }

  let a0 = g0.rgb;
  let z0 = max(g0.w, 0.05);
  let rough = gbuf[gb + 3u].w;
  let variance = max(moments[ci].w, 0.0);
  let specDamp = select(1.0, 0.3, rough < 0.08);
  let lum0 = dot(c0.rgb, vec3<f32>(0.2126, 0.7152, 0.0722));
  // SVGF variance-guided edge stopping sigma
  let sigma = max((0.25 * (0.12 + lum0) + 2.8 * sqrt(variance)) * specDamp, 0.06);
  let invS2 = D.scaleInv2 / (sigma * sigma);

  var kWeights = array<f32, 5>(0.0625, 0.25, 0.375, 0.25, 0.0625);
  var sum = c0.rgb * 0.375;
  var wsum = 0.375;
  let wi = i32(D.width);
  let hi = i32(D.height);

  for (var k: i32 = -2; k <= 2; k += 1) {
    if (k == 0) { continue; }
    let ox = select(k * D.step, 0, D.vertical != 0u);
    let oy = select(0, k * D.step, D.vertical != 0u);
    let xx = i32(gid.x) + ox;
    let yy = i32(gid.y) + oy;
    if (xx < 0 || xx >= wi || yy < 0 || yy >= hi) { continue; }
    let qi = u32(yy) * D.width + u32(xx);
    let qGb = qi * 4u;
    let nq = gbuf[qGb + 1u];
    if (nq.w < 0.5) { continue; }
    let dn = dot(n0.xyz, nq.xyz);
    if (dn < 0.78) { continue; }
    let q0 = gbuf[qGb];
    let dz = abs(z0 - q0.w) / (z0 * 0.15 + 0.02);
    if (dz > 3.5) { continue; }
    let da = a0 - q0.rgb;
    let da2 = dot(da, da);
    let dn2 = dn * dn;
    let dn4 = dn2 * dn2;
    let dn8 = dn4 * dn4;
    let cq = srcBuf[qi].rgb;
    let dc = c0.rgb - cq;
    let e = dz * 1.2 + da2 * 25.0 + dot(dc, dc) * invS2;
    let y = 1.0 + e * 0.25;
    let y2 = y * y;
    let wt = kWeights[k + 2] * dn8 / (y2 * y2);
    sum = sum + cq * wt;
    wsum += wt;
  }

  var outCol = sum / wsum;
  if (D.remodAlbedo > 0.5) {
    outCol = outCol * (a0 + vec3<f32>(0.02));
  }
  dstBuf[ci] = vec4<f32>(outCol, c0.a);
}
`;

// ─── Algorithm 6: Exact Blender 4.5 OCIO AgX / ACES / Khronos PBR Neutral / Linear Blit ───
const BLIT_WGSL = /* wgsl */ `
struct BlitParams {
  width: u32,
  height: u32,
  tonemapMode: u32,
  pad: u32,
  exposure: f32,
  pad1: f32,
  pad2: f32,
  pad3: f32,
};

@group(0) @binding(0) var<uniform> B: BlitParams;
@group(0) @binding(1) var<storage, read> pixels: array<vec4<f32>>;

struct VsOut {
  @builtin(position) pos: vec4<f32>,
};

@vertex
fn vsMain(@builtin(vertex_index) vid: u32) -> VsOut {
  var p = array<vec2<f32>, 3>(
    vec2<f32>(-1.0, -1.0),
    vec2<f32>(3.0, -1.0),
    vec2<f32>(-1.0, 3.0)
  );
  var out: VsOut;
  out.pos = vec4<f32>(p[vid], 0.0, 1.0);
  return out;
}

fn agxContrast(x: vec3<f32>) -> vec3<f32> {
  let x2 = x * x;
  let x4 = x2 * x2;
  return 15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4 - 6.868 * x2 * x + 0.4298 * x2 + 0.1191 * x - 0.00232;
}

fn agxApplyLook(v: vec3<f32>, look: u32) -> vec3<f32> {
  if (look == 0u) { return v; }
  var slope: f32 = 1.0;
  var power: f32 = 1.0;
  var sat: f32 = 1.0;
  if (look == 1u) { slope = 1.0; power = 1.35; sat = 1.40; }
  else if (look == 2u) { slope = 1.04; power = 1.40; sat = 1.15; }
  else if (look == 3u) { slope = 1.0; power = 1.18; sat = 1.10; }
  else if (look == 4u) { slope = 1.0; power = 0.85; sat = 0.92; }
  let s = max(v * slope, vec3<f32>(0.0));
  let p = pow(s, vec3<f32>(power));
  let luma = dot(p, vec3<f32>(0.2126, 0.7152, 0.0722));
  return max(vec3<f32>(luma) + (p - vec3<f32>(luma)) * sat, vec3<f32>(0.0));
}

// Blender 4.x / Troy Sobotka Rec.2020 AgX + OCIO Looks (0=Base, 1=Punchy, 2=High, 3=MedHigh, 4=Low)
fn tonemapAgx(c: vec3<f32>, expVal: f32, look: u32) -> vec3<f32> {
  // WGSL mat3x3 is column-major — construct from exact row vectors transposed
  let to2020 = transpose(mat3x3<f32>(
    vec3<f32>(0.6274039, 0.3292830, 0.0433131),
    vec3<f32>(0.0690973, 0.9195404, 0.0113623),
    vec3<f32>(0.0163914, 0.0880133, 0.8955953)
  ));
  let to709 = transpose(mat3x3<f32>(
    vec3<f32>( 1.6604910, -0.5876411, -0.0728499),
    vec3<f32>(-0.1245505,  1.1328999, -0.0083494),
    vec3<f32>(-0.0181508, -0.1005789,  1.1187297)
  ));
  let inset = transpose(mat3x3<f32>(
    vec3<f32>(0.856627153315983, 0.0951212405381588, 0.0482516061458583),
    vec3<f32>(0.137318972929847, 0.761241990602591,  0.101439036467562),
    vec3<f32>(0.11189821299995,  0.0767994186031903, 0.811302368396859)
  ));
  let outset = transpose(mat3x3<f32>(
    vec3<f32>( 1.1271005818144368, -0.11060664309660323, -0.016493938717834573),
    vec3<f32>(-0.1413297634984383,  1.157823702216272,   -0.016493938717834257),
    vec3<f32>(-0.14132976349843826,-0.11060664309660294,  1.2519364065950405)
  ));
  var v = inset * (to2020 * max(c * expVal, vec3<f32>(0.0)));
  v = log2(max(v, vec3<f32>(1e-10)));
  v = clamp((v - vec3<f32>(-12.47393)) / (4.026069 - (-12.47393)), vec3<f32>(0.0), vec3<f32>(1.0));
  v = outset * agxContrast(v);
  v = agxApplyLook(v, look);
  v = pow(max(v, vec3<f32>(0.0)), vec3<f32>(2.2));
  return to709 * v;
}

fn tonemapAces(c: vec3<f32>, expVal: f32) -> vec3<f32> {
  let m1 = mat3x3<f32>(
    vec3<f32>(0.59719, 0.07600, 0.02840),
    vec3<f32>(0.35458, 0.90834, 0.13383),
    vec3<f32>(0.04823, 0.01566, 0.83777)
  );
  let m2 = mat3x3<f32>(
    vec3<f32>(1.60475, -0.10208, -0.00327),
    vec3<f32>(-0.53108, 1.10813, -0.07276),
    vec3<f32>(-0.07367, -0.00605, 1.07602)
  );
  let v = m1 * max(c * (expVal / 0.6), vec3<f32>(0.0));
  let a = v * (v + 0.0245786) - 0.000090537;
  let b = v * (0.983729 * v + 0.4329510) + 0.238081;
  return m2 * (a / b);
}

// Khronos PBR Neutral (exact Blender 4.2+ Khronos PBR Neutral)
fn tonemapNeutral(c: vec3<f32>, expVal: f32) -> vec3<f32> {
  let startComp = 0.76;
  let desat = 0.15;
  var color = max(c * expVal, vec3<f32>(0.0));
  let x = min(color.x, min(color.y, color.z));
  let offset = select(0.04, x - 6.25 * x * x, x < 0.08);
  color = color - vec3<f32>(offset);
  let peak = max(color.x, max(color.y, color.z));
  if (peak < startComp) { return color; }
  let d = 1.0 - startComp;
  let newPeak = 1.0 - d * d / (peak + d - startComp);
  color = color * (newPeak / peak);
  let g = 1.0 - 1.0 / (desat * (peak - newPeak) + 1.0);
  return mix(color, vec3<f32>(newPeak), g);
}

fn oetf(x: vec3<f32>) -> vec3<f32> {
  let c = clamp(x, vec3<f32>(0.0), vec3<f32>(1.0));
  let lo = 12.92 * c;
  let hi = 1.055 * pow(c, vec3<f32>(1.0 / 2.4)) - 0.055;
  return select(hi, lo, c <= vec3<f32>(0.0031308));
}

@fragment
fn fsMain(@builtin(position) fragPos: vec4<f32>) -> @location(0) vec4<f32> {
  let x = min(u32(fragPos.x), B.width - 1u);
  let y = min(u32(fragPos.y), B.height - 1u);
  let s = pixels[y * B.width + x];
  let a = clamp(s.a, 0.0, 1.0);
  let c = select(vec3<f32>(0.0), s.rgb / a, a > 1e-4);
  let baseMode = B.tonemapMode & 0xFFu;
  let agxLook = (B.tonemapMode >> 8u) & 0xFFu;
  var t = c * B.exposure;
  if (baseMode == 1u) { t = tonemapAces(c, B.exposure); }
  else if (baseMode == 2u) { t = tonemapAgx(c, B.exposure, agxLook); }
  else if (baseMode == 3u) { t = tonemapNeutral(c, B.exposure); }
  return vec4<f32>(oetf(t) * a, a);
}
`;

/**
 * Shelf-packs all extracted scene RGBA8 textures into a single GPU 2D texture atlas (<= 2048x2048)
 * and returns normalized UV rects for WGSL hardware bilinear sampling.
 */
function buildTextureAtlas(textures) {
  const rects = new Float32Array(MAX_ATLAS_TEXTURES * 4);
  const metaArr = textures?.metas || textures?.meta;
  if (!textures?.count || !textures.data?.byteLength || !metaArr?.length) {
    return { width: 4, height: 4, rgba: new Uint8Array(4 * 4 * 4).fill(255), rects };
  }

  const count = Math.min(textures.count, MAX_ATLAS_TEXTURES);
  const items = [];
  const capPerTex = count <= 4 ? 1024 : (count <= 16 ? 512 : 256);
  for (let i = 0; i < count; i++) {
    const b = i * 4;
    const offset = metaArr[b];
    const sw = metaArr[b + 1];
    const sh = metaArr[b + 2];
    const srgb = (metaArr[b + 3] & 1) !== 0;
    if (!(sw > 0 && sh > 0)) continue;
    const scale = Math.min(1, capPerTex / Math.max(sw, sh));
    const dw = Math.max(1, Math.round(sw * scale));
    const dh = Math.max(1, Math.round(sh * scale));
    items.push({ id: i, offset, sw, sh, dw, dh, srgb });
  }
  if (items.length === 0) {
    return { width: 4, height: 4, rgba: new Uint8Array(4 * 4 * 4).fill(255), rects };
  }

  // Shelf-pack sorted by height descending
  const sorted = [...items].sort((a, b) => b.dh - a.dh);
  let atlasW = 64;
  for (const it of sorted) atlasW = Math.max(atlasW, it.dw + 2);
  let totalArea = 0;
  for (const it of sorted) totalArea += (it.dw + 2) * (it.dh + 2);
  atlasW = Math.min(MAX_ATLAS_DIM, Math.max(atlasW, 1 << Math.ceil(Math.log2(Math.sqrt(totalArea * 1.35)))));

  let curX = 0, curY = 0, shelfH = 0;
  for (const it of sorted) {
    if (curX + it.dw + 2 > atlasW) {
      curX = 0;
      curY += shelfH;
      shelfH = 0;
    }
    if (curY + it.dh + 2 > MAX_ATLAS_DIM) {
      it.placed = false;
      continue;
    }
    it.ax = curX + 1;
    it.ay = curY + 1;
    it.placed = true;
    curX += it.dw + 2;
    shelfH = Math.max(shelfH, it.dh + 2);
  }
  const atlasH = Math.min(MAX_ATLAS_DIM, Math.max(4, Math.ceil((curY + shelfH) / 4) * 4));
  const rgba = new Uint8Array(atlasW * atlasH * 4);
  const src = textures.data;

  for (const it of sorted) {
    if (!it.placed) continue;
    for (let y = 0; y < it.dh; y++) {
      const sy = Math.min(it.sh - 1, Math.floor((y + 0.5) * it.sh / it.dh));
      for (let x = 0; x < it.dw; x++) {
        const sx = Math.min(it.sw - 1, Math.floor((x + 0.5) * it.sw / it.dw));
        const si = (it.offset + sy * it.sw + sx) * 4;
        const di = ((it.ay + y) * atlasW + (it.ax + x)) * 4;
        rgba[di] = src[si];
        rgba[di + 1] = src[si + 1];
        rgba[di + 2] = src[si + 2];
        rgba[di + 3] = src[si + 3];
      }
    }
    const rb = it.id * 4;
    rects[rb] = it.ax / atlasW;
    rects[rb + 1] = it.ay / atlasH;
    // Sign of uScale encodes sRGB (+1) vs Linear (-1)
    rects[rb + 2] = (it.dw / atlasW) * (it.srgb ? 1 : -1);
    rects[rb + 3] = it.dh / atlasH;
  }

  return { width: atlasW, height: atlasH, rgba, rects };
}

function computeEnvSignature(env) {
  if (!env || !env.w || !env.h || !env.rgb?.length) return '0';
  const rgb = env.rgb;
  let h = (env.w * 73856093) ^ (env.h * 19349663);
  const step = Math.max(1, Math.floor(rgb.length / 16));
  for (let i = 0; i < rgb.length; i += step) {
    h = Math.imul(h ^ Math.round((rgb[i] || 0) * 1000), 16777619);
  }
  return `${env.w}x${env.h}:${h >>> 0}`;
}

export class WebGPUPathTracer {
  /**
   * Probes for a hardware WebGPU adapter (preferring discrete high-performance GPUs such as
   * NVIDIA RTX / AMD Radeon / Apple Silicon) and returns detailed hardware info for UI & limits.
   */
  static async probeAdapter() {
    if (typeof navigator === 'undefined' || !navigator.gpu) {
      return { supported: false, label: 'WebGPU unavailable', isFallback: true, tier: 'none' };
    }
    try {
      let adapter = await navigator.gpu.requestAdapter({
        powerPreference: 'high-performance',
        forceFallbackAdapter: false,
      });
      if (!adapter) {
        adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
      }
      if (!adapter) {
        return { supported: false, label: 'No WebGPU adapter', isFallback: true, tier: 'none' };
      }
      const rawInfo = adapter.info || (typeof adapter.requestAdapterInfo === 'function' ? await adapter.requestAdapterInfo().catch(() => ({})) : {});
      const classified = classifyGpuAdapterInfo(rawInfo, Boolean(adapter.isFallbackAdapter));
      return {
        supported: true,
        ...classified,
        maxBufferSize: adapter.limits?.maxBufferSize || 256 * 1024 * 1024,
        maxStorageBufferBindingSize: adapter.limits?.maxStorageBufferBindingSize || 128 * 1024 * 1024,
      };
    } catch (_) {
      return { supported: false, label: 'WebGPU probe failed', isFallback: true, tier: 'none' };
    }
  }

  static async isSupported() {
    const info = await WebGPUPathTracer.probeAdapter();
    return Boolean(info.supported && !info.isFallback);
  }

  constructor() {
    this.device = null;
    this.gpuInfo = null;
    this._deviceLost = false;
    this._deviceLostReason = '';
    this.format = 'bgra8unorm';
    this.canvas = null;
    this.ctx = null;
    this.kernel = null;
    this.width = 0;
    this.height = 0;
    this._tracePipeline = null;
    this._temporalPipeline = null;
    this._denoisePipeline = null;
    this._blitPipeline = null;
    this._buffers = {};
    this._textures = {};
    this._sampler = null;
    this._prevCam = null;
    this._hasPrevHistory = false;
    this._hasEnvCdf = false;
    this._emissiveCount = 0;
    this._emissiveTexW = 1;
    this._hasPrevTris = false;
    this._prevTriTexW = 1;
    this._frameCounter = 0;
    this._sceneSig = null;
  }

  async init(wasmBytes = null) {
    if (this.device && !this._deviceLost) return true;
    if (typeof navigator === 'undefined' || !navigator.gpu) return false;
    let adapter = await navigator.gpu.requestAdapter({
      powerPreference: 'high-performance',
      forceFallbackAdapter: false,
    });
    if (!adapter) {
      adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    }
    if (!adapter) return false;

    const rawInfo = adapter.info || (typeof adapter.requestAdapterInfo === 'function' ? await adapter.requestAdapterInfo().catch(() => ({})) : {});
    this.gpuInfo = classifyGpuAdapterInfo(rawInfo, Boolean(adapter.isFallbackAdapter));
    if (this.gpuInfo.isFallback) {
      return false;
    }

    const requiredLimits = selectRequiredGpuLimits(adapter.limits);
    try {
      this.device = await adapter.requestDevice({ requiredLimits });
    } catch (_) {
      this.device = await adapter.requestDevice();
    }
    this._deviceLost = false;
    this._deviceLostReason = '';
    this.device.lost.then((lostInfo) => {
      this._deviceLost = true;
      this._deviceLostReason = lostInfo?.message || lostInfo?.reason || 'GPU device lost';
    }).catch(() => {
      this._deviceLost = true;
    });
    this.format = navigator.gpu.getPreferredCanvasFormat();

    const bytes = wasmBytes || await loadKernelBytes();
    this.kernel = await RenderKernel.create(bytes);

    const compileAndCheck = async (label, code) => {
      const mod = this.device.createShaderModule({ label, code });
      const info = await mod.getCompilationInfo();
      const errs = info.messages.filter((m) => m.type === 'error');
      if (errs.length) {
        const msg = errs.map((e) => `${label}:${e.lineNum}:${e.linePos} ${e.message}`).join('\n');
        throw new Error(`WGSL compile error:\n${msg}`);
      }
      return mod;
    };

    const traceMod = await compileAndCheck('trace', TRACE_WGSL);
    this._tracePipeline = await this.device.createComputePipelineAsync({
      layout: 'auto',
      compute: { module: traceMod, entryPoint: 'traceMain' },
    });

    const tempMod = await compileAndCheck('svgf_temporal', SVGF_TEMPORAL_WGSL);
    this._temporalPipeline = await this.device.createComputePipelineAsync({
      layout: 'auto',
      compute: { module: tempMod, entryPoint: 'temporalMain' },
    });

    const denoiseMod = await compileAndCheck('svgf_denoise', DENOISE_WGSL);
    this._denoisePipeline = await this.device.createComputePipelineAsync({
      layout: 'auto',
      compute: { module: denoiseMod, entryPoint: 'denoiseStep' },
    });

    const blitMod = await compileAndCheck('blit', BLIT_WGSL);
    this._blitPipeline = await this.device.createRenderPipelineAsync({
      layout: 'auto',
      vertex: { module: blitMod, entryPoint: 'vsMain' },
      fragment: {
        module: blitMod,
        entryPoint: 'fsMain',
        targets: [{ format: this.format }],
      },
      primitive: { topology: 'triangle-list' },
    });

    this._sampler = this.device.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    });

    this._buffers.uniform = this.device.createBuffer({
      size: 224,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this._buffers.texRects = this.device.createBuffer({
      size: MAX_ATLAS_TEXTURES * 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this._buffers.temporalUniform = this.device.createBuffer({
      size: 96,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this._buffers.blitUniform = this.device.createBuffer({
      size: 32,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // Initialize default 1x1 dummy textures so bindings are always valid
    this._uploadTexture2D('atlas', 4, 4, 'rgba8unorm', new Uint8Array(4 * 4 * 4).fill(255), 4);
    this._uploadTexture2D('env', 1, 1, 'rgba32float', new Float32Array([0, 0, 0, 1]), 16);
    this._uploadTexture2D('envCdf', 1, 1, 'rg32float', new Float32Array([1, 0]), 8);
    this._uploadTexture2D('envRowCdf', 1, 1, 'r32float', new Float32Array([1]), 4);
    this._uploadTexture2D('emissive', 1, 1, 'rgba32float', new Float32Array([0, 1, 0, 0]), 16);
    this._uploadTexture2D('prevTri', 1, 1, 'rgba32float', new Float32Array([0, 0, 0, 0]), 16);

    return true;
  }

  _uploadTexture2D(key, width, height, format, dataView, bytesPerPixel) {
    this._textures[key]?.destroy?.();
    const tex = this.device.createTexture({
      size: { width, height, depthOrArrayLayers: 1 },
      format,
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this.device.queue.writeTexture(
      { texture: tex },
      dataView,
      { bytesPerRow: width * bytesPerPixel, rowsPerImage: height },
      { width, height, depthOrArrayLayers: 1 }
    );
    this._textures[key] = tex;
    return tex;
  }

  _ensureBuffer(key, byteLength, usage) {
    const minSize = Math.max(16, Math.ceil(byteLength / 16) * 16);
    const existing = this._buffers[key];
    if (existing && existing.size >= minSize) return existing;
    existing?.destroy();
    const buf = this.device.createBuffer({ size: minSize, usage });
    this._buffers[key] = buf;
    return buf;
  }

  _ensureOutput(width, height) {
    if (this.width === width && this.height === height && this.canvas) return;
    this.width = width;
    this.height = height;
    if (!this.canvas) {
      this.canvas = typeof document !== 'undefined'
        ? document.createElement('canvas')
        : new OffscreenCanvas(width, height);
    }
    this.canvas.width = width;
    this.canvas.height = height;
    this.ctx = this.canvas.getContext('webgpu');
    this.ctx.configure({
      device: this.device,
      format: this.format,
      alphaMode: 'premultiplied',
    });

    const n = width * height;
    const rw = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST;
    this._ensureBuffer('accum', n * 16, rw);
    this._ensureBuffer('gbuf', n * 64, rw);
    this._ensureBuffer('stateBuf', n * 16, rw);
    this._ensureBuffer('prevRad', n * 16, rw);
    this._ensureBuffer('prevGbuf', n * 64, rw);
    this._ensureBuffer('prevMom', n * 16, rw);
    this._ensureBuffer('curMom', n * 16, rw);
    this._ensureBuffer('denoiseA', n * 16, rw);
    this._ensureBuffer('denoiseB', n * 16, rw);
    this._hasPrevHistory = false;
  }

  resetHistory() {
    this._prevCam = null;
    this._hasPrevHistory = false;
    this._frameCounter = 0;
  }

  /**
   * Uploads packed scene to Rust WASM (builds BVH2 on frame 0, O(N) refit on frames 1..N)
   * and syncs GPU storage buffers, Texture Atlas, and 2D HDRI Importance Sampling CDF.
   */
  uploadScene(packed, shutter = 0) {
    let refitted = false;
    const envSig = computeEnvSignature(packed.env);
    if (packed.refitOnly) {
      refitted = this.kernel.refitScene(packed);
    } else {
      const sig = `${packed.triCount}:${packed.mats?.length || 0}:${packed.textures?.count || 0}:${envSig}`;
      if (this._sceneSig === sig && this.kernel.refitScene(packed)) {
        refitted = true;
      } else {
        this.kernel.loadScene(packed);
        this._sceneSig = sig;
        this.resetHistory();
      }
    }

    const gpuBvh = this.kernel.exportBvh2ForGpu(shutter);
    if (!gpuBvh) throw new Error('Failed to export Rust BVH2 for WebGPU.');

    const ro = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST;
    const bNodes = this._ensureBuffer('bvhNodes', gpuBvh.nodesF32.byteLength, ro);
    const bGeom = this._ensureBuffer('triGeom', gpuBvh.triGeomF32.byteLength, ro);
    const attrF32 = gpuBvh.triAttrF32 || gpuBvh.triNormF32;
    const bAttr = this._ensureBuffer('triAttr', attrF32.byteLength, ro);
    this.device.queue.writeBuffer(bNodes, 0, gpuBvh.nodesF32);
    this.device.queue.writeBuffer(bGeom, 0, gpuBvh.triGeomF32);
    this.device.queue.writeBuffer(bAttr, 0, attrF32);

    // Upload Emissive Mesh CDF texture for GPU Emissive NEE + MIS
    const emCdf = this.kernel.exportEmissiveCdfForGpu();
    if (emCdf && emCdf.count > 0) {
      const emW = Math.min(2048, emCdf.count);
      const emH = Math.ceil(emCdf.count / emW);
      const padded = new Float32Array(emW * emH * 4);
      padded.set(emCdf.dataF32);
      this._uploadTexture2D('emissive', emW, emH, 'rgba32float', padded, 16);
      this._emissiveCount = emCdf.count;
      this._emissiveTexW = emW;
    } else {
      this._uploadTexture2D('emissive', 1, 1, 'rgba32float', new Float32Array([0, 1, 0, 0]), 16);
      this._emissiveCount = 0;
      this._emissiveTexW = 1;
    }

    // Upload Previous-Frame BVH-ordered triangles for Per-Vertex SVGF Motion Vectors & Deformation Motion Blur
    const prevTris = this.kernel.exportPrevTrisForGpu();
    if (prevTris && prevTris.triCount === gpuBvh.triCount && prevTris.triCount > 0) {
      const nTexels = prevTris.triCount * 3;
      const pw = Math.min(2048, nTexels);
      const ph = Math.ceil(nTexels / pw);
      const padded = new Float32Array(pw * ph * 4);
      padded.set(prevTris.prevGeomF32);
      this._uploadTexture2D('prevTri', pw, ph, 'rgba32float', padded, 16);
      this._hasPrevTris = true;
      this._prevTriTexW = pw;
    } else {
      this._uploadTexture2D('prevTri', 1, 1, 'rgba32float', new Float32Array([0, 0, 0, 0]), 16);
      this._hasPrevTris = false;
      this._prevTriTexW = 1;
    }

    if (!packed.refitOnly && packed.mats) {
      const bMats = this._ensureBuffer('materials', Math.max(128, packed.mats.byteLength), ro);
      this.device.queue.writeBuffer(bMats, 0, packed.mats);
    }

    if (!packed.refitOnly) {
      // Upload packed Texture Atlas (BaseColor / Normal / Roughness / Metalness / Emissive)
      const atlas = buildTextureAtlas(packed.textures);
      this._uploadTexture2D('atlas', atlas.width, atlas.height, 'rgba8unorm', atlas.rgba, 4);
      this.device.queue.writeBuffer(this._buffers.texRects, 0, atlas.rects);
    }

    const lightsArr = packed.lights?.byteLength ? packed.lights : new Float32Array(16);
    const bLights = this._ensureBuffer('lights', lightsArr.byteLength, ro);
    this.device.queue.writeBuffer(bLights, 0, lightsArr);

    if (!packed.refitOnly) {
      // Upload HDRI equirect texture + Rust-computed 2D Importance Sampling CDF
      const ew = packed.env?.w || 0;
      const eh = packed.env?.h || 0;
      if (ew > 0 && eh > 0 && packed.env.rgb) {
        const envRgba = new Float32Array(ew * eh * 4);
        const src = packed.env.rgb;
        for (let i = 0; i < ew * eh; i++) {
          envRgba[i * 4] = src[i * 3];
          envRgba[i * 4 + 1] = src[i * 3 + 1];
          envRgba[i * 4 + 2] = src[i * 3 + 2];
          envRgba[i * 4 + 3] = 1.0;
        }
        this._uploadTexture2D('env', ew, eh, 'rgba32float', envRgba, 16);

        const cdf = this.kernel.exportEnvCdfForGpu();
        if (cdf && cdf.width === ew && cdf.height === eh) {
          this._uploadTexture2D('envCdf', ew, eh, 'rg32float', cdf.colCdfPdfF32, 8);
          this._uploadTexture2D('envRowCdf', eh, 1, 'r32float', cdf.rowCdfF32, 4);
          this._hasEnvCdf = true;
        } else {
          this._hasEnvCdf = false;
        }
      } else {
        this._uploadTexture2D('env', 1, 1, 'rgba32float', new Float32Array([0, 0, 0, 1]), 16);
        this._uploadTexture2D('envCdf', 1, 1, 'rg32float', new Float32Array([1, 0]), 8);
        this._uploadTexture2D('envRowCdf', 1, 1, 'r32float', new Float32Array([1]), 4);
        this._hasEnvCdf = false;
      }
    }

    return { refitted, nodeCount: gpuBvh.nodeCount, triCount: gpuBvh.triCount };
  }

  /**
   * Renders one frame on GPU (Cycles X QMC+Adaptive+Principled v2+HDRI MIS -> SVGF Temporal +
   * Variance-Guided Separable À-Trous -> Blender 4.5 AgX/Neutral/ACES Blit onto WebGPU canvas).
   * Returns `{ canvas, width, height, refitted }` ready for Zero-Copy `VideoFrame(canvas)`.
   */
  async renderFrame(packed, opts = {}) {
    if (this._deviceLost || !this.device) {
      throw new WebGPUDeviceLostError(this._deviceLostReason || 'WebGPU device is not active');
    }
    const {
      width,
      height,
      samples = 16,
      maxBounces = 5,
      denoise = true,
      denoisePasses = 3,
      temporal = true,
      adaptiveThreshold = 0.025,
      exposure = 1.0,
      tonemap = 'agx',
      tonemapLook = 'base',
      seed = 1,
      clamp = 20.0,
      samplesPerChunk = DEFAULT_SAMPLES_PER_CHUNK,
      signal = null,
      onChunkProgress = null,
    } = opts;

    if (signal?.aborted) throw new DOMException('Render cancelled', 'AbortError');
    this._ensureOutput(width, height);
    const cam = packed.camera;
    const shutterVal = Math.max(0, Math.min(1, Number(cam?.[15]) || 0));
    const { refitted } = this.uploadScene(packed, shutterVal);

    // Pack Trace Uniforms (224 bytes, including chunk + extra emissive/prevTri slots)
    const uBuf = new ArrayBuffer(224);
    const f32 = new Float32Array(uBuf);
    const u32 = new Uint32Array(uBuf);
    const prev = this._prevCam || cam;
    const ep = packed.env.params;
    const toneMode = encodeTonemapMode(tonemap, tonemapLook);

    // 0..3: camOrigin+aperture, camFwd+focus, camRight+ortho, camUp+shutter
    f32.set([cam[0], cam[1], cam[2], cam[12]], 0);
    f32.set([cam[3], cam[4], cam[5], cam[13]], 4);
    f32.set([cam[6], cam[7], cam[8], cam[14]], 8);
    f32.set([cam[9], cam[10], cam[11], cam[15]], 12);
    // 4..7: prevCam + adaptiveThreshold + bgMode
    f32.set([prev[0], prev[1], prev[2], this._prevCam ? 1 : 0], 16);
    f32.set([prev[3], prev[4], prev[5], exposure], 20);
    f32.set([prev[6], prev[7], prev[8], adaptiveThreshold], 24);
    f32.set([prev[9], prev[10], prev[11], ep[11]], 28);
    // 8..9: bgColor + envIntensity, miscF (envRot, clamp, hasEnvCdf, frameIdx)
    f32.set([ep[12], ep[13], ep[14], ep[0]], 32);
    f32.set([ep[1], clamp, this._hasEnvCdf ? 1 : 0, this._frameCounter], 36);
    // 10..11: dims & counts (u32), 13: extra (emissiveCount, emissiveTexW, hasPrevTris, prevTriTexW)
    u32.set([width, height, samples, maxBounces], 40);
    u32.set([seed >>> 0, Math.floor((packed.lights?.length || 0) / 16), packed.env?.w || 0, packed.env?.h || 0], 44);
    u32.set([this._emissiveCount, this._emissiveTexW, this._hasPrevTris ? 1 : 0, this._prevTriTexW], 52);

    const wx = Math.ceil(width / 8);
    const wy = Math.ceil(height / 8);

    // 1. TDR-Safe Progressive Chunked Path Trace Compute Passes
    const traceBG = this.device.createBindGroup({
      layout: this._tracePipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this._buffers.uniform } },
        { binding: 1, resource: { buffer: this._buffers.bvhNodes } },
        { binding: 2, resource: { buffer: this._buffers.triGeom } },
        { binding: 3, resource: { buffer: this._buffers.triAttr } },
        { binding: 4, resource: { buffer: this._buffers.materials } },
        { binding: 5, resource: { buffer: this._buffers.lights } },
        { binding: 6, resource: { buffer: this._buffers.accum } },
        { binding: 7, resource: { buffer: this._buffers.gbuf } },
        { binding: 8, resource: { buffer: this._buffers.stateBuf } },
        { binding: 9, resource: { buffer: this._buffers.texRects } },
        { binding: 10, resource: this._textures.atlas.createView() },
        { binding: 11, resource: this._sampler },
        { binding: 12, resource: this._textures.env.createView() },
        { binding: 13, resource: this._textures.envCdf.createView() },
        { binding: 14, resource: this._textures.envRowCdf.createView() },
        { binding: 15, resource: this._textures.emissive.createView() },
        { binding: 16, resource: this._textures.prevTri.createView() },
      ],
    });

    const schedule = computeChunkSchedule(samples, samplesPerChunk);
    for (let ci = 0; ci < schedule.length; ci++) {
      if (signal?.aborted) throw new DOMException('Render cancelled', 'AbortError');
      if (this._deviceLost) {
        throw new WebGPUDeviceLostError(this._deviceLostReason || 'WebGPU device lost mid-frame');
      }
      const ch = schedule[ci];
      const flags = (ch.isFirst ? 1 : 0) | (ch.isLast ? 2 : 0);
      u32.set([ch.sampleStart, ch.sampleEnd, flags, 0], 48);
      this.device.queue.writeBuffer(this._buffers.uniform, 0, uBuf);

      const chunkEnc = this.device.createCommandEncoder();
      const tracePass = chunkEnc.beginComputePass();
      tracePass.setPipeline(this._tracePipeline);
      tracePass.setBindGroup(0, traceBG);
      tracePass.dispatchWorkgroups(wx, wy);
      tracePass.end();
      this.device.queue.submit([chunkEnc.finish()]);
      await this.device.queue.onSubmittedWorkDone();

      if (typeof onChunkProgress === 'function') {
        try {
          onChunkProgress({ samplesDone: ch.sampleEnd, samplesTarget: samples, chunkIndex: ci, chunkCount: schedule.length });
        } catch (_) {}
      }
    }

    if (signal?.aborted) throw new DOMException('Render cancelled', 'AbortError');
    if (this._deviceLost) {
      throw new WebGPUDeviceLostError(this._deviceLostReason || 'WebGPU device lost before denoise');
    }

    // Pack SVGF Temporal Uniforms (96 bytes)
    const tBuf = new ArrayBuffer(96);
    const tf = new Float32Array(tBuf);
    const tu = new Uint32Array(tBuf);
    const rLen2 = prev[6] * prev[6] + prev[7] * prev[7] + prev[8] * prev[8];
    const uLen2 = prev[9] * prev[9] + prev[10] * prev[10] + prev[11] * prev[11];
    const fLen2 = prev[3] * prev[3] + prev[4] * prev[4] + prev[5] * prev[5];
    tf.set([prev[0], prev[1], prev[2], prev[14]], 0);
    tf.set([prev[3], prev[4], prev[5], rLen2], 4);
    tf.set([prev[6], prev[7], prev[8], uLen2], 8);
    tf.set([prev[9], prev[10], prev[11], fLen2], 12);
    const doDenoise = Boolean(denoise && denoisePasses > 0);
    tu.set([width, height, this._hasPrevHistory ? 1 : 0, temporal ? 1 : 0], 16);
    tf.set([0.2, 8.0, doDenoise ? 1.0 : 0.0, 0.0], 20);
    this.device.queue.writeBuffer(this._buffers.temporalUniform, 0, tBuf);

    const enc = this.device.createCommandEncoder();

    // 2. SVGF Temporal Reprojection + Moments + Albedo Demodulation (writes denoiseA + curMom)
    const tempBG = this.device.createBindGroup({
      layout: this._temporalPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this._buffers.temporalUniform } },
        { binding: 1, resource: { buffer: this._buffers.accum } },
        { binding: 2, resource: { buffer: this._buffers.gbuf } },
        { binding: 3, resource: { buffer: this._buffers.prevRad } },
        { binding: 4, resource: { buffer: this._buffers.prevGbuf } },
        { binding: 5, resource: { buffer: this._buffers.prevMom } },
        { binding: 6, resource: { buffer: this._buffers.denoiseA } },
        { binding: 7, resource: { buffer: this._buffers.curMom } },
      ],
    });
    const tempPass = enc.beginComputePass();
    tempPass.setPipeline(this._temporalPipeline);
    tempPass.setBindGroup(0, tempBG);
    tempPass.dispatchWorkgroups(wx, wy);
    tempPass.end();

    // Save temporally-accumulated UN-FILTERED radiance BEFORE spatial À-trous overwrites denoiseA
    const nPix = width * height;
    enc.copyBufferToBuffer(this._buffers.denoiseA, 0, this._buffers.prevRad, 0, nPix * 16);
    enc.copyBufferToBuffer(this._buffers.gbuf, 0, this._buffers.prevGbuf, 0, nPix * 64);
    enc.copyBufferToBuffer(this._buffers.curMom, 0, this._buffers.prevMom, 0, nPix * 16);

    // 3. SVGF Variance-Guided Separable À-Trous Passes (ping-pong denoiseA <-> denoiseB)
    let finalBuf = this._buffers.denoiseA;
    if (doDenoise) {
      const nPasses = Math.min(3, denoisePasses);
      let scaleInv2 = 1.0;
      for (let p = 0; p < nPasses; p++) {
        const step = 1 << p;
        const isLast = p === nPasses - 1;
        this._dispatchDenoise(enc, this._buffers.denoiseA, this._buffers.denoiseB, width, height, step, 0, scaleInv2, 0.0, wx, wy);
        this._dispatchDenoise(enc, this._buffers.denoiseB, this._buffers.denoiseA, width, height, step, 1, scaleInv2, isLast ? 1.0 : 0.0, wx, wy);
        scaleInv2 *= 2.8;
      }
      finalBuf = this._buffers.denoiseA;
    }

    // 4. Exact Blender 4.5 AgX / ACES / Khronos Neutral / Linear Fragment Blit -> WebGPU Canvas
    const blitU = new ArrayBuffer(32);
    new Uint32Array(blitU, 0, 4).set([width, height, toneMode, 0]);
    new Float32Array(blitU, 16, 4).set([exposure, 0, 0, 0]);
    this.device.queue.writeBuffer(this._buffers.blitUniform, 0, blitU);

    const blitBG = this.device.createBindGroup({
      layout: this._blitPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this._buffers.blitUniform } },
        { binding: 1, resource: { buffer: finalBuf } },
      ],
    });

    const texView = this.ctx.getCurrentTexture().createView();
    const renderPass = enc.beginRenderPass({
      colorAttachments: [{
        view: texView,
        clearValue: { r: 0, g: 0, b: 0, a: 0 },
        loadOp: 'clear',
        storeOp: 'store',
      }],
    });
    renderPass.setPipeline(this._blitPipeline);
    renderPass.setBindGroup(0, blitBG);
    renderPass.draw(3);
    renderPass.end();

    this.device.queue.submit([enc.finish()]);
    await this.device.queue.onSubmittedWorkDone();

    this._prevCam = new Float32Array(cam);
    this._hasPrevHistory = true;
    this._frameCounter += 1;

    return { canvas: this.canvas, width, height, refitted };
  }

  _dispatchDenoise(enc, srcBuf, dstBuf, width, height, step, vertical, scaleInv2, remodAlbedo, wx, wy) {
    const uBuf = new ArrayBuffer(32);
    new Uint32Array(uBuf, 0, 4).set([width, height, step, vertical]);
    new Float32Array(uBuf, 16, 4).set([scaleInv2, remodAlbedo, 0, 0]);
    const passKey = `du_${step}_${vertical}_${remodAlbedo > 0.5 ? 1 : 0}`;
    const du = this._ensureBuffer(passKey, 32, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
    this.device.queue.writeBuffer(du, 0, uBuf);

    const bg = this.device.createBindGroup({
      layout: this._denoisePipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: du } },
        { binding: 1, resource: { buffer: srcBuf } },
        { binding: 2, resource: { buffer: this._buffers.gbuf } },
        { binding: 3, resource: { buffer: this._buffers.curMom } },
        { binding: 4, resource: { buffer: dstBuf } },
      ],
    });
    const pass = enc.beginComputePass();
    pass.setPipeline(this._denoisePipeline);
    pass.setBindGroup(0, bg);
    pass.dispatchWorkgroups(wx, wy);
    pass.end();
  }

  dispose() {
    for (const buf of Object.values(this._buffers)) {
      try { buf?.destroy?.(); } catch (_) {}
    }
    for (const tex of Object.values(this._textures)) {
      try { tex?.destroy?.(); } catch (_) {}
    }
    this._buffers = {};
    this._textures = {};
    this._sampler = null;
    try { this.device?.destroy?.(); } catch (_) {}
    this.device = null;
    this.ctx = null;
    this.canvas = null;
    this.kernel = null;
    this._prevCam = null;
    this._hasPrevHistory = false;
    this._sceneSig = null;
  }
}
