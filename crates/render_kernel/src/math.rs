//! Minimal vector math, deterministic QMC sampler & RNG for the render kernel (no dependencies).
use std::ops::{Add, Div, Mul, Neg, Sub};

pub const PI: f32 = std::f32::consts::PI;

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct V3 {
    pub x: f32,
    pub y: f32,
    pub z: f32,
}

#[inline(always)]
pub const fn v3(x: f32, y: f32, z: f32) -> V3 {
    V3 { x, y, z }
}

impl V3 {
    pub const ZERO: V3 = v3(0.0, 0.0, 0.0);
    pub const ONE: V3 = v3(1.0, 1.0, 1.0);
    #[inline(always)]
    pub fn splat(a: f32) -> V3 {
        v3(a, a, a)
    }
    #[inline(always)]
    pub fn dot(self, o: V3) -> f32 {
        self.x * o.x + self.y * o.y + self.z * o.z
    }
    #[inline(always)]
    pub fn cross(self, o: V3) -> V3 {
        v3(self.y * o.z - self.z * o.y, self.z * o.x - self.x * o.z, self.x * o.y - self.y * o.x)
    }
    #[inline(always)]
    pub fn len(self) -> f32 {
        self.dot(self).sqrt()
    }
    #[inline(always)]
    pub fn norm(self) -> V3 {
        let l = self.len();
        if l > 1e-20 { self * (1.0 / l) } else { v3(0.0, 1.0, 0.0) }
    }
    #[inline(always)]
    pub fn lum(self) -> f32 {
        0.2126 * self.x + 0.7152 * self.y + 0.0722 * self.z
    }
    #[inline(always)]
    pub fn maxc(self) -> f32 {
        self.x.max(self.y).max(self.z)
    }
    #[inline(always)]
    pub fn lerp(self, o: V3, t: f32) -> V3 {
        self * (1.0 - t) + o * t
    }
    #[inline(always)]
    pub fn mulv(self, o: V3) -> V3 {
        v3(self.x * o.x, self.y * o.y, self.z * o.z)
    }
    #[inline(always)]
    pub fn min(self, o: V3) -> V3 {
        v3(self.x.min(o.x), self.y.min(o.y), self.z.min(o.z))
    }
    #[inline(always)]
    pub fn max(self, o: V3) -> V3 {
        v3(self.x.max(o.x), self.y.max(o.y), self.z.max(o.z))
    }
    #[inline(always)]
    pub fn clamp(self, lo: f32, hi: f32) -> V3 {
        v3(self.x.clamp(lo, hi), self.y.clamp(lo, hi), self.z.clamp(lo, hi))
    }
    #[inline(always)]
    pub fn sqrt(self) -> V3 {
        v3(self.x.max(0.0).sqrt(), self.y.max(0.0).sqrt(), self.z.max(0.0).sqrt())
    }
    #[inline(always)]
    pub fn exp(self) -> V3 {
        v3(self.x.exp(), self.y.exp(), self.z.exp())
    }
    #[inline(always)]
    pub fn ln(self) -> V3 {
        v3(self.x.ln(), self.y.ln(), self.z.ln())
    }
    #[inline(always)]
    pub fn is_finite(self) -> bool {
        self.x.is_finite() && self.y.is_finite() && self.z.is_finite()
    }
    #[inline(always)]
    pub fn get(self, i: usize) -> f32 {
        match i { 0 => self.x, 1 => self.y, _ => self.z }
    }
}

impl Add for V3 { type Output = V3; #[inline(always)] fn add(self, o: V3) -> V3 { v3(self.x + o.x, self.y + o.y, self.z + o.z) } }
impl Sub for V3 { type Output = V3; #[inline(always)] fn sub(self, o: V3) -> V3 { v3(self.x - o.x, self.y - o.y, self.z - o.z) } }
impl Mul<f32> for V3 { type Output = V3; #[inline(always)] fn mul(self, s: f32) -> V3 { v3(self.x * s, self.y * s, self.z * s) } }
impl Div<f32> for V3 { type Output = V3; #[inline(always)] fn div(self, s: f32) -> V3 { self * (1.0 / s) } }
impl Neg for V3 { type Output = V3; #[inline(always)] fn neg(self) -> V3 { v3(-self.x, -self.y, -self.z) } }

/// Orthonormal basis around `n` (Duff et al. 2017).
#[inline]
pub fn basis(n: V3) -> (V3, V3) {
    let s = if n.z >= 0.0 { 1.0 } else { -1.0 };
    let a = -1.0 / (s + n.z);
    let b = n.x * n.y * a;
    (v3(1.0 + s * n.x * n.x * a, s * b, -s * n.x), v3(b, s + n.y * n.y * a, -n.y))
}

#[inline(always)]
pub fn hash_u32(mut x: u32) -> u32 {
    x ^= x >> 16;
    x = x.wrapping_mul(0x7feb_352d);
    x ^= x >> 15;
    x = x.wrapping_mul(0x846c_a68b);
    x ^= x >> 16;
    x
}

/// Owen-style fast bit-scrambled radical inverse in base 2 (Sobol 1D).
#[inline(always)]
fn radical_inv_2(mut i: u32, scramble: u32) -> f32 {
    i = i.reverse_bits() ^ scramble;
    (i >> 8) as f32 * (1.0 / 16_777_216.0)
}

/// Scrambled Sobol-2D (van der Corput + Sobol direction matrix) for low-discrepancy 2D pairs.
#[inline(always)]
fn sobol_2(mut i: u32, scramble: u32) -> f32 {
    let mut r = 0u32;
    let mut v = 0x8000_0000u32;
    while i != 0 {
        if i & 1 != 0 {
            r ^= v;
        }
        v ^= v >> 1;
        i >>= 1;
    }
    r ^= scramble;
    (r >> 8) as f32 * (1.0 / 16_777_216.0)
}

/// PCG-based deterministic RNG.
pub struct Rng(u64);

impl Rng {
    pub fn new(a: u32, b: u32, c: u32) -> Rng {
        let mut r = Rng(((a as u64) << 32 | b as u64) ^ ((c as u64).wrapping_mul(0x9E37_79B9_7F4A_7C15)));
        r.0 = r.0.wrapping_add(0x1405_7B7E_F767_814F);
        r.next_u32();
        r.next_u32();
        r
    }
    #[inline(always)]
    pub fn next_u32(&mut self) -> u32 {
        let old = self.0;
        self.0 = old.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        let xs = (((old >> 18) ^ old) >> 27) as u32;
        let rot = (old >> 59) as u32;
        xs.rotate_right(rot)
    }
    #[inline(always)]
    pub fn f(&mut self) -> f32 {
        (self.next_u32() >> 8) as f32 * (1.0 / 16_777_216.0)
    }
}

/// Deterministic Cranley-Patterson / padded QMC sampler for fast convergence.
/// Uses scrambled 2D Sobol for early bounce pairs and decorrelated Halton/R2/PCG for higher dims.
pub struct Sampler {
    pub rng: Rng,
    sample_idx: u32,
    px_hash: u32,
    dim: u32,
}

impl Sampler {
    #[inline]
    pub fn new(x: u32, y: u32, sample_idx: u32, seed: u32) -> Self {
        let px_hash = hash_u32(x.wrapping_mul(0x9E37_79B1) ^ y.wrapping_mul(0x85EB_CA77) ^ seed.wrapping_mul(0xC2B2_AE3D));
        let rng = Rng::new(x ^ (sample_idx << 16), y ^ sample_idx, seed);
        Sampler { rng, sample_idx, px_hash, dim: 0 }
    }

    #[inline(always)]
    pub fn f(&mut self) -> f32 {
        let d = self.dim;
        self.dim += 1;
        if d < 16 {
            let s = hash_u32(self.px_hash ^ d.wrapping_mul(0x27D4_EB2D));
            if d & 1 == 0 {
                radical_inv_2(self.sample_idx, s)
            } else {
                sobol_2(self.sample_idx, s)
            }
        } else {
            self.rng.f()
        }
    }

    #[inline(always)]
    pub fn f2(&mut self) -> (f32, f32) {
        let d = self.dim;
        if d < 16 && (d & 1) == 0 {
            self.dim += 2;
            let s0 = hash_u32(self.px_hash ^ d.wrapping_mul(0x27D4_EB2D));
            let s1 = hash_u32(self.px_hash ^ (d + 1).wrapping_mul(0x27D4_EB2D));
            (radical_inv_2(self.sample_idx, s0), sobol_2(self.sample_idx, s1))
        } else {
            (self.f(), self.f())
        }
    }
}
