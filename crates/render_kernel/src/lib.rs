//! Web Blender Studio — Rust path-tracing render kernel (WASM + native).
//!
//! Binned-SAH BVH2 + 4-wide SIMD BVH4 with O(N) refit, Principled BSDF
//! (GGX/VNDF, anisotropy, clearcoat, sheen, subsurface, transmission + Beer-Lambert),
//! texture atlas (base/normal/rough/metal/emissive with TBN), NEE + MIS for
//! point/sphere/sun/spot/rect-area lights, emissive meshes & equirect HDRI,
//! homogeneous volumetric fog, QMC Sobol sampler, adaptive sampling,
//! variance-guided à-trous denoiser and AgX/ACES/Neutral/Linear tone mapping.

pub mod bake;
pub mod bvh;
pub mod env;
pub mod math;
pub mod node_vm;
pub mod post;
pub mod tex;

use bvh::*;
use env::Env;
use math::*;
use post::AOV_STRIDE;
use tex::TexStore;
use std::alloc::{alloc_zeroed, dealloc, Layout};

pub const MAT_STRIDE: usize = 32;
pub const LIGHT_STRIDE: usize = 16;

#[derive(Clone, Copy)]
pub struct Material {
    pub base: V3,
    pub metal: f32,
    pub rough: f32,
    pub emit: V3,
    pub trans: f32,
    pub ior: f32,
    pub opacity: f32,
    pub base_tex: i32,
    pub normal_tex: i32,
    pub rough_tex: i32,
    pub metal_tex: i32,
    pub emit_tex: i32,
    pub clearcoat: f32,
    pub clearcoat_rough: f32,
    pub sheen: f32,
    pub sheen_rough: f32,
    pub sheen_color: V3,
    pub attenuation_color: V3,
    pub attenuation_dist: f32,
    pub normal_scale: f32,
    pub anisotropy: f32,
    pub subsurface: f32,
    pub uv_repeat: [f32; 2],
}

impl Default for Material {
    fn default() -> Self {
        Material {
            base: V3::splat(0.8),
            metal: 0.0,
            rough: 0.5,
            emit: V3::ZERO,
            trans: 0.0,
            ior: 1.5,
            opacity: 1.0,
            base_tex: -1,
            normal_tex: -1,
            rough_tex: -1,
            metal_tex: -1,
            emit_tex: -1,
            clearcoat: 0.0,
            clearcoat_rough: 0.1,
            sheen: 0.0,
            sheen_rough: 0.5,
            sheen_color: V3::ONE,
            attenuation_color: V3::ONE,
            attenuation_dist: 0.0,
            normal_scale: 1.0,
            anisotropy: 0.0,
            subsurface: 0.0,
            uv_repeat: [1.0, 1.0],
        }
    }
}

#[derive(Clone, Copy)]
pub struct Light {
    /// 0: point/sphere, 1: directional/sun, 2: spot, 3: rect area
    pub kind: u32,
    pub pos: V3,
    pub color: V3,
    pub dir: V3,
    pub radius: f32,
    /// Spot: cos(outer_angle); Area: half-width.
    pub param0: f32,
    /// Spot: cos(inner_angle); Area: half-height.
    pub param1: f32,
    /// Area: normalized local U axis.
    pub area_u: V3,
}

#[derive(Clone, Copy)]
pub struct Camera {
    pub origin: V3,
    pub fwd: V3,
    pub right: V3,
    pub up: V3,
    pub aperture: f32,
    pub focus: f32,
    pub ortho: bool,
    /// Motion blur shutter fraction (0.0 = off, 0.5 = 180 deg Blender default, 1.0 = full frame).
    pub shutter: f32,
}

#[derive(Clone, Copy, Default)]
pub struct Volume {
    pub density: f32,
    pub anisotropy: f32,
    pub color: V3,
    pub max_dist: f32,
}

pub struct Scene {
    pub bvh: Bvh,
    pub mats: Vec<Material>,
    pub lights: Vec<Light>,
    pub textures: TexStore,
    pub env: Env,
    pub cam: Camera,
    pub bg_mode: u32, // 0 env visible, 1 solid colour, 2 transparent
    pub bg: V3,
    pub vol: Volume,
    pub eps: f32,
    pub shader_progs: Vec<Option<node_vm::ShaderProgram>>,
    // Emissive mesh NEE data (BVH-reordered tri indices).
    emissive_tris: Vec<u32>,
    emissive_cdf: Vec<f32>,
    emissive_power: Vec<f32>, // power per emissive tri, indexed by emissive_tris pos
    emissive_total: f32,
    tri_to_emissive: Vec<i32>,
    // Previous frame state for motion-vector temporal reprojection.
    prev_tris: Vec<TriGeom>,
    prev_cam: Option<Camera>,
    prev_mean: Vec<f32>,
    prev_aov: Vec<f32>,
    prev_w: usize,
    prev_h: usize,
    prev_spp: f32,
}

#[derive(Clone, Copy)]
pub struct RenderParams {
    pub spp: u32,
    pub seed: u32,
    pub max_bounces: u32,
    pub clamp: f32,
    pub adaptive_threshold: f32,
}

pub(crate) struct Sample {
    pub(crate) rad: V3,
    pub(crate) alpha: f32,
    pub(crate) albedo: V3,
    pub(crate) normal: V3,
    pub(crate) rough: f32,
}

#[inline]
fn schlick(f0: V3, c: f32) -> V3 {
    let m = (1.0 - c).clamp(0.0, 1.0);
    let m5 = m * m * m * m * m;
    f0 + (V3::ONE - f0) * m5
}

#[inline]
fn schlick_scalar(f0: f32, c: f32) -> f32 {
    let m = (1.0 - c).clamp(0.0, 1.0);
    let m5 = m * m * m * m * m;
    f0 + (1.0 - f0) * m5
}

#[inline]
fn fresnel_dielectric(cos_i: f32, eta: f32) -> f32 {
    let sin2_t = (1.0 - cos_i * cos_i) / (eta * eta);
    if sin2_t >= 1.0 { return 1.0; }
    let cos_t = (1.0 - sin2_t).sqrt();
    let rs = (cos_i - eta * cos_t) / (cos_i + eta * cos_t);
    let rp = (eta * cos_i - cos_t) / (eta * cos_i + cos_t);
    0.5 * (rs * rs + rp * rp)
}

#[inline]
fn ggx_d_aniso(hl: V3, ax: f32, ay: f32) -> f32 {
    let d = (hl.x * hl.x) / (ax * ax) + (hl.y * hl.y) / (ay * ay) + hl.z * hl.z;
    1.0 / (PI * ax * ay * d * d)
}

#[inline]
fn smith_g1_aniso(wl: V3, ax: f32, ay: f32) -> f32 {
    if wl.z <= 0.0 { return 0.0; }
    let ax_x = ax * wl.x;
    let ay_y = ay * wl.y;
    let l = (-1.0 + (1.0 + (ax_x * ax_x + ay_y * ay_y) / (wl.z * wl.z)).sqrt()) * 0.5;
    1.0 / (1.0 + l)
}

/// Heitz 2018 anisotropic VNDF sampling; `v` in local frame (z = normal).
fn sample_vndf_aniso(v: V3, ax: f32, ay: f32, u1: f32, u2: f32) -> V3 {
    let vh = v3(ax * v.x, ay * v.y, v.z).norm();
    let lensq = vh.x * vh.x + vh.y * vh.y;
    let t1 = if lensq > 0.0 { v3(-vh.y, vh.x, 0.0) / lensq.sqrt() } else { v3(1.0, 0.0, 0.0) };
    let t2 = vh.cross(t1);
    let r = u1.sqrt();
    let phi = 2.0 * PI * u2;
    let a = r * phi.cos();
    let mut b = r * phi.sin();
    let s = 0.5 * (1.0 + vh.z);
    b = (1.0 - s) * (1.0 - a * a).max(0.0).sqrt() + s * b;
    let nh = t1 * a + t2 * b + vh * (1.0 - a * a - b * b).max(0.0).sqrt();
    v3(ax * nh.x, ay * nh.y, nh.z.max(0.0)).norm()
}

/// Charlie sheen microfacet NDF (Estevez & Kulla 2017).
#[inline]
fn charlie_d(nh: f32, rough: f32) -> f32 {
    let inv_r = 1.0 / rough.clamp(0.05, 1.0);
    let sin2 = (1.0 - nh * nh).max(0.0);
    (2.0 + inv_r) * sin2.powf(inv_r * 0.5) / (2.0 * PI)
}

#[inline]
fn power(a: f32, b: f32) -> f32 {
    let (a2, b2) = (a * a, b * b);
    if a2 + b2 > 0.0 { a2 / (a2 + b2) } else { 0.0 }
}

/// Henyey-Greenstein phase function pdf and direction sampler.
#[inline]
fn hg_phase(cos_t: f32, g: f32) -> f32 {
    let g2 = g * g;
    let denom = (1.0 + g2 - 2.0 * g * cos_t).max(1e-4);
    (1.0 - g2) / (4.0 * PI * denom * denom.sqrt())
}

fn hg_sample(d: V3, g: f32, u1: f32, u2: f32) -> V3 {
    let cos_t = if g.abs() < 1e-3 {
        1.0 - 2.0 * u1
    } else {
        let sqr = (1.0 - g * g) / (1.0 - g + 2.0 * g * u1);
        ((1.0 + g * g - sqr * sqr) / (2.0 * g)).clamp(-1.0, 1.0)
    };
    let sin_t = (1.0 - cos_t * cos_t).max(0.0).sqrt();
    let phi = 2.0 * PI * u2;
    let (t1, t2) = basis(d);
    (t1 * (sin_t * phi.cos()) + t2 * (sin_t * phi.sin()) + d * cos_t).norm()
}

pub(crate) struct Shade {
    pub(crate) n: V3,
    pub(crate) t1: V3,
    pub(crate) t2: V3,
    pub(crate) base: V3,
    pub(crate) metal: f32,
    pub(crate) ax: f32,
    pub(crate) ay: f32,
    pub(crate) f0: V3,
    pub(crate) ms_comp: V3,
    pub(crate) clearcoat: f32,
    pub(crate) alpha_cc: f32,
    pub(crate) sheen: f32,
    pub(crate) sheen_rough: f32,
    pub(crate) sheen_color: V3,
    pub(crate) subsurface: f32,
    pub(crate) ps: f32,
    pub(crate) p_cc: f32,
}

impl Shade {
    pub(crate) fn new(m: &Material, n: V3, t1: V3, t2: V3, v: V3) -> Shade {
        let rough = m.rough.clamp(0.04, 1.0);
        let alpha = rough * rough;
        let aniso = m.anisotropy.clamp(-0.95, 0.95);
        let aspect = (1.0 - 0.9 * aniso.abs()).sqrt();
        let (ax, ay) = if aniso >= 0.0 {
            ((alpha / aspect).max(1e-3), (alpha * aspect).max(1e-3))
        } else {
            ((alpha * aspect).max(1e-3), (alpha / aspect).max(1e-3))
        };
        let f0d = ((m.ior - 1.0) / (m.ior + 1.0)).powi(2);
        let f0 = V3::splat(f0d).lerp(m.base, m.metal);
        let nv = n.dot(v).max(1e-4);
        let f_coat = m.clearcoat * schlick_scalar(0.04, nv);
        let kd_w = (1.0 - m.metal) * m.base.lum() * (1.0 - schlick(f0, nv).lum()) * (1.0 - f_coat);
        let ks_w = schlick(f0, nv).lum() * (1.0 - f_coat);
        let cc_w = f_coat;
        let sum_w = kd_w + ks_w + cc_w;
        let p_cc = if sum_w > 1e-5 { (cc_w / sum_w).clamp(0.0, 0.7) } else { 0.0 };
        let rem = 1.0 - p_cc;
        let ps = if kd_w < 1e-4 {
            rem
        } else {
            ((ks_w / (ks_w + kd_w)).clamp(0.05, 0.95)) * rem
        };
        let alpha_cc = m.clearcoat_rough.clamp(0.04, 1.0).powi(2);
        // Turquin / Blender Principled BSDF v2 Multi-Scattering GGX energy compensation
        let alpha_eff = (ax * ay).sqrt().clamp(0.0, 1.0);
        let ess = (1.0 / (1.0 + alpha_eff * (1.35 + 0.85 * (1.0 - nv).powf(1.5)))).clamp(0.28, 1.0);
        let ms_comp = V3::ONE + f0 * ((1.0 / ess) - 1.0);
        Shade {
            n, t1, t2, base: m.base, metal: m.metal, ax, ay, f0, ms_comp,
            clearcoat: m.clearcoat, alpha_cc,
            sheen: m.sheen, sheen_rough: m.sheen_rough, sheen_color: m.sheen_color,
            subsurface: m.subsurface, ps, p_cc,
        }
    }

    #[inline]
    fn to_local(&self, w: V3) -> V3 {
        v3(w.dot(self.t1), w.dot(self.t2), w.dot(self.n))
    }

    fn eval(&self, l: V3, v: V3) -> V3 {
        let nl = self.n.dot(l);
        let nv = self.n.dot(v);
        if nl <= 0.0 || nv <= 0.0 {
            // Subsurface wrap lighting on backface when subsurface > 0
            if self.subsurface > 0.0 && nv > 0.0 && nl > -0.5 {
                let wrap = ((nl + 0.5) / 1.5).max(0.0);
                return self.base * (self.subsurface * (1.0 - self.metal) * wrap / PI);
            }
            return V3::ZERO;
        }
        let h = (l + v).norm();
        let nh = self.n.dot(h).max(0.0);
        let vh = v.dot(h).max(0.0);
        let vl = self.to_local(v);
        let ll = self.to_local(l);
        let hl = self.to_local(h);
        let f = schlick(self.f0, vh);
        let spec = f.mulv(self.ms_comp) * (ggx_d_aniso(hl, self.ax, self.ay) * smith_g1_aniso(vl, self.ax, self.ay) * smith_g1_aniso(ll, self.ax, self.ay) / (4.0 * nv * nl));
        let kd = V3::ONE - schlick(self.f0, nv);
        let mut diff = self.base.mulv(kd) * ((1.0 - self.metal) / PI);
        if self.sheen > 0.0 {
            let s_val = charlie_d(nh, self.sheen_rough) / (4.0 * (nl + nv - nl * nv).max(0.1));
            diff = diff + self.sheen_color * (self.sheen * s_val);
        }
        let base_bsdf = diff + spec;
        if self.clearcoat > 0.0 {
            let fc = self.clearcoat * schlick_scalar(0.04, vh);
            let coat = ggx_d_aniso(hl, self.alpha_cc, self.alpha_cc)
                * smith_g1_aniso(vl, self.alpha_cc, self.alpha_cc)
                * smith_g1_aniso(ll, self.alpha_cc, self.alpha_cc)
                / (4.0 * nv * nl);
            return base_bsdf * (1.0 - self.clearcoat * schlick_scalar(0.04, nv)) + V3::splat(fc * coat);
        }
        base_bsdf
    }

    fn pdf(&self, l: V3, v: V3) -> f32 {
        let nl = self.n.dot(l);
        let nv = self.n.dot(v);
        if nl <= 0.0 || nv <= 0.0 { return 0.0; }
        let h = (l + v).norm();
        let vl = self.to_local(v);
        let hl = self.to_local(h);
        let spec = ggx_d_aniso(hl, self.ax, self.ay) * smith_g1_aniso(vl, self.ax, self.ay) / (4.0 * nv);
        let mut p = self.ps * spec + (1.0 - self.ps - self.p_cc).max(0.0) * nl / PI;
        if self.p_cc > 0.0 {
            let cc = ggx_d_aniso(hl, self.alpha_cc, self.alpha_cc)
                * smith_g1_aniso(vl, self.alpha_cc, self.alpha_cc)
                / (4.0 * nv);
            p += self.p_cc * cc;
        }
        p
    }
}

impl Scene {
    pub fn new(tris: Vec<TriGeom>, attrs: Vec<TriAttr>, mats: Vec<Material>, lights: Vec<Light>) -> Scene {
        let bvh = Bvh::build(tris, attrs);
        let (lo, hi) = bvh.bounds();
        let eps = ((hi - lo).len() * 2e-6).max(1e-5);
        let mut sc = Scene {
            bvh,
            mats,
            lights,
            textures: TexStore::new(),
            env: Env::sky(1.0, v3(0.45, 0.6, 0.85), v3(0.8, 0.8, 0.8), v3(0.25, 0.25, 0.25)),
            cam: Camera { origin: v3(0.0, 0.0, 5.0), fwd: v3(0.0, 0.0, -1.0), right: v3(1.0, 0.0, 0.0), up: v3(0.0, 1.0, 0.0), aperture: 0.0, focus: 5.0, ortho: false, shutter: 0.0 },
            bg_mode: 0,
            bg: V3::ZERO,
            vol: Volume::default(),
            eps,
            shader_progs: Vec::new(),
            emissive_tris: Vec::new(),
            emissive_cdf: Vec::new(),
            emissive_power: Vec::new(),
            emissive_total: 0.0,
            tri_to_emissive: Vec::new(),
            prev_tris: Vec::new(),
            prev_cam: None,
            prev_mean: Vec::new(),
            prev_aov: Vec::new(),
            prev_w: 0,
            prev_h: 0,
            prev_spp: 0.0,
        };
        sc.rebuild_emissive_table();
        sc
    }

    pub fn rebuild_emissive_table(&mut self) {
        let ntri = self.bvh.tris.len();
        self.emissive_tris.clear();
        self.emissive_cdf.clear();
        self.emissive_power.clear();
        self.tri_to_emissive.clear();
        self.tri_to_emissive.resize(ntri, -1);
        let mut total = 0.0f32;
        self.emissive_cdf.push(0.0);
        for (i, attr) in self.bvh.attrs.iter().enumerate() {
            let m = self.material(attr.mat);
            let e_lum = if m.emit_tex >= 0 { m.emit.lum().max(1.0) } else { m.emit.lum() };
            if e_lum > 1e-4 && attr.area > 1e-9 {
                let p = e_lum * attr.area;
                let idx = self.emissive_tris.len() as i32;
                self.tri_to_emissive[i] = idx;
                self.emissive_tris.push(i as u32);
                self.emissive_power.push(p);
                total += p;
                self.emissive_cdf.push(total);
            }
        }
        self.emissive_total = total;
    }

    pub fn refit(&mut self, pos: &[f32], nrm: &[f32]) {
        self.prev_tris = self.bvh.tris.clone();
        self.prev_cam = Some(self.cam);
        self.bvh.refit(pos, nrm);
        let (lo, hi) = self.bvh.bounds();
        self.eps = ((hi - lo).len() * 2e-6).max(1e-5);
        self.rebuild_emissive_table();
    }

    /// Motion-vector temporal reprojection in linear RGBA space with 3x3 neighborhood clamping for rows [y0..y1).
    pub fn temporal_reproject_rows(
        &self,
        cur_mean: &[f32],
        cur_aov: &[f32],
        prev_mean: &[f32],
        prev_aov: &[f32],
        out_mean: &mut [f32],
        w: usize,
        h: usize,
        y0: usize,
        y1: usize,
        cur_spp: f32,
        prev_spp: f32,
        blend: f32,
    ) {
        let y1c = y1.min(h);
        if y1c <= y0 { return; }
        let start4 = y0 * w * 4;
        let end4 = y1c * w * 4;
        let Some(pcam) = self.prev_cam else {
            out_mean[start4..end4].copy_from_slice(&cur_mean[start4..end4]);
            return;
        };
        if self.prev_tris.len() != self.bvh.tris.len() || w == 0 || h == 0 || blend <= 0.0 {
            out_mean[start4..end4].copy_from_slice(&cur_mean[start4..end4]);
            return;
        }
        let inv_c = 1.0 / cur_spp.max(1.0);
        let inv_p = 1.0 / prev_spp.max(1.0);
        let r_len2 = pcam.right.dot(pcam.right).max(1e-12);
        let u_len2 = pcam.up.dot(pcam.up).max(1e-12);

        for y in y0..y1c {
            for x in 0..w {
                let ci = y * w + x;
                let ca = ci * AOV_STRIDE;
                let cur_n_raw = v3(cur_aov[ca + 3], cur_aov[ca + 4], cur_aov[ca + 5]);
                // Fast path: skip BVH intersection & 3x3 clamp for pure sky/background pixels (zero noise)
                if cur_n_raw.dot(cur_n_raw) <= 1e-6 {
                    out_mean[ci * 4..ci * 4 + 4].copy_from_slice(&cur_mean[ci * 4..ci * 4 + 4]);
                    continue;
                }
                let cur_c = v3(cur_mean[ci * 4], cur_mean[ci * 4 + 1], cur_mean[ci * 4 + 2]);
                let cur_alpha = cur_mean[ci * 4 + 3];

                // Trace center primary ray to recover exact surface motion vector.
                let sx = (x as f32 + 0.5) / w as f32 * 2.0 - 1.0;
                let sy = 1.0 - (y as f32 + 0.5) / h as f32 * 2.0;
                let (org, dir) = if self.cam.ortho {
                    (self.cam.origin + self.cam.right * sx + self.cam.up * sy, self.cam.fwd)
                } else {
                    (self.cam.origin, (self.cam.fwd + self.cam.right * sx + self.cam.up * sy).norm())
                };

                let hit_opt = self.bvh.intersect(org, dir, f32::INFINITY);
                let (psx, psy, is_sky) = if let Some(hit) = hit_opt {
                    let pt_prev_t = &self.prev_tris[hit.tri as usize];
                    let prev_pt = pt_prev_t.p0 + pt_prev_t.e1 * hit.u + pt_prev_t.e2 * hit.v;
                    let to_p = prev_pt - pcam.origin;
                    if pcam.ortho {
                        (to_p.dot(pcam.right) / r_len2, to_p.dot(pcam.up) / u_len2, false)
                    } else {
                        let z = to_p.dot(pcam.fwd);
                        if z <= 1e-4 {
                            out_mean[ci * 4..ci * 4 + 4].copy_from_slice(&cur_mean[ci * 4..ci * 4 + 4]);
                            continue;
                        }
                        (to_p.dot(pcam.right) / (z * r_len2), to_p.dot(pcam.up) / (z * u_len2), false)
                    }
                } else {
                    out_mean[ci * 4..ci * 4 + 4].copy_from_slice(&cur_mean[ci * 4..ci * 4 + 4]);
                    continue;
                };

                let px = (psx + 1.0) * 0.5 * w as f32 - 0.5;
                let py = (1.0 - psy) * 0.5 * h as f32 - 0.5;
                if px < 0.0 || px > (w - 1) as f32 || py < 0.0 || py > (h - 1) as f32 {
                    out_mean[ci * 4..ci * 4 + 4].copy_from_slice(&cur_mean[ci * 4..ci * 4 + 4]);
                    continue;
                }

                // Disocclusion rejection via normal & albedo check at nearest prev texel.
                let nx = px.round().clamp(0.0, (w - 1) as f32) as usize;
                let ny = py.round().clamp(0.0, (h - 1) as f32) as usize;
                let pi = ny * w + nx;
                let pa = pi * AOV_STRIDE;
                let cur_n = cur_n_raw * inv_c;
                let prev_n = v3(prev_aov[pa + 3], prev_aov[pa + 4], prev_aov[pa + 5]) * inv_p;
                let cur_has_n = cur_n.dot(cur_n) > 1e-4;
                let prev_has_n = prev_n.dot(prev_n) > 1e-4;
                if !is_sky && cur_has_n && prev_has_n {
                    if cur_n.norm().dot(prev_n.norm()) < 0.85 {
                        out_mean[ci * 4..ci * 4 + 4].copy_from_slice(&cur_mean[ci * 4..ci * 4 + 4]);
                        continue;
                    }
                    let cur_alb = v3(cur_aov[ca], cur_aov[ca + 1], cur_aov[ca + 2]) * inv_c;
                    let prev_alb = v3(prev_aov[pa], prev_aov[pa + 1], prev_aov[pa + 2]) * inv_p;
                    if (cur_alb - prev_alb).len() > 0.25 {
                        out_mean[ci * 4..ci * 4 + 4].copy_from_slice(&cur_mean[ci * 4..ci * 4 + 4]);
                        continue;
                    }
                } else if is_sky && prev_has_n {
                    out_mean[ci * 4..ci * 4 + 4].copy_from_slice(&cur_mean[ci * 4..ci * 4 + 4]);
                    continue;
                }

                // Bilinear sample from prev_mean.
                let x0 = (px.floor() as usize).min(w - 1);
                let y0 = (py.floor() as usize).min(h - 1);
                let x1 = (x0 + 1).min(w - 1);
                let y1 = (y0 + 1).min(h - 1);
                let tx = px - x0 as f32;
                let ty = py - y0 as f32;
                let sample_p = |ix: usize, iy: usize| {
                    let k = (iy * w + ix) * 4;
                    (v3(prev_mean[k], prev_mean[k + 1], prev_mean[k + 2]), prev_mean[k + 3])
                };
                let (c00, a00) = sample_p(x0, y0);
                let (c10, a10) = sample_p(x1, y0);
                let (c01, a01) = sample_p(x0, y1);
                let (c11, a11) = sample_p(x1, y1);
                let w00 = (1.0 - tx) * (1.0 - ty);
                let w10 = tx * (1.0 - ty);
                let w01 = (1.0 - tx) * ty;
                let w11 = tx * ty;
                let mut hist = c00 * w00 + c10 * w10 + c01 * w01 + c11 * w11;
                let hist_a = a00 * w00 + a10 * w10 + a01 * w01 + a11 * w11;

                // 3x3 neighborhood variance-box clamping on cur_mean to stop ghosting.
                let mut m1 = V3::ZERO;
                let mut m2 = V3::ZERO;
                let mut cnt = 0.0f32;
                for dy in -1isize..=1 {
                    let yy = (y as isize + dy).clamp(0, h as isize - 1) as usize;
                    for dx in -1isize..=1 {
                        let xx = (x as isize + dx).clamp(0, w as isize - 1) as usize;
                        let k = (yy * w + xx) * 4;
                        let nb = v3(cur_mean[k], cur_mean[k + 1], cur_mean[k + 2]);
                        m1 = m1 + nb;
                        m2 = m2 + nb.mulv(nb);
                        cnt += 1.0;
                    }
                }
                let mean3 = m1 / cnt;
                let std3 = (m2 / cnt - mean3.mulv(mean3)).max(V3::ZERO).sqrt();
                let lo = (mean3 - std3 * 1.5).max(V3::ZERO);
                let hi = mean3 + std3 * 1.5;
                hist = hist.max(lo).min(hi);

                let out_c = cur_c.lerp(hist, blend.clamp(0.0, 0.95));
                out_mean[ci * 4] = out_c.x;
                out_mean[ci * 4 + 1] = out_c.y;
                out_mean[ci * 4 + 2] = out_c.z;
                out_mean[ci * 4 + 3] = cur_alpha + (hist_a - cur_alpha) * blend.clamp(0.0, 0.95);
            }
        }
    }

    pub fn temporal_reproject(
        &self,
        cur_mean: &[f32],
        cur_aov: &[f32],
        prev_mean: &[f32],
        prev_aov: &[f32],
        out_mean: &mut [f32],
        w: usize,
        h: usize,
        cur_spp: f32,
        prev_spp: f32,
        blend: f32,
    ) {
        self.temporal_reproject_rows(cur_mean, cur_aov, prev_mean, prev_aov, out_mean, w, h, 0, h, cur_spp, prev_spp, blend);
    }

    #[inline]
    fn material(&self, i: u32) -> Material {
        self.mats.get(i as usize).copied().unwrap_or_default()
    }

    fn eval_material_hit(&self, attr: &TriAttr, u_bary: f32, v_bary: f32, ng: V3, mut ns: V3, view_dir: V3) -> (Material, V3, V3, V3) {
        let mut m = self.material(attr.mat);
        let w0 = 1.0 - u_bary - v_bary;
        let raw_u = attr.uv0[0] * w0 + attr.uv1[0] * u_bary + attr.uv2[0] * v_bary;
        let raw_v = attr.uv0[1] * w0 + attr.uv1[1] * u_bary + attr.uv2[1] * v_bary;
        let u = raw_u * m.uv_repeat[0];
        let v = raw_v * m.uv_repeat[1];

        if let Some(c) = self.textures.sample(m.base_tex, u, v) {
            m.base = m.base.mulv(v3(c[0], c[1], c[2]));
            m.opacity *= c[3];
        }
        if let Some(c) = self.textures.sample(m.rough_tex, u, v) {
            m.rough *= c[1]; // glTF G channel
        }
        if let Some(c) = self.textures.sample(m.metal_tex, u, v) {
            m.metal *= c[2]; // glTF B channel
        }
        if let Some(c) = self.textures.sample_rgb(m.emit_tex, u, v) {
            m.emit = m.emit.mulv(c);
        }

        // Compute orthonormal tangent frame around ns.
        let (mut t1, mut t2) = if attr.tangent.dot(attr.tangent) > 1e-6 {
            let t = (attr.tangent - ns * ns.dot(attr.tangent)).norm();
            let b = ns.cross(t) * attr.b_sign;
            (t, b)
        } else {
            basis(ns)
        };

        if let Some(nt) = self.textures.sample_rgb(m.normal_tex, u, v) {
            let nx = (nt.x * 2.0 - 1.0) * m.normal_scale;
            let ny = (nt.y * 2.0 - 1.0) * m.normal_scale;
            let nz = (nt.z * 2.0 - 1.0).max(0.05);
            let mapped = (t1 * nx + t2 * ny + ns * nz).norm();
            // Keep perturbed normal in the geometric front hemisphere.
            ns = if mapped.dot(ng) > 0.05 { mapped } else { (mapped + ng * 0.25).norm() };
            let (nt1, nt2) = basis(ns);
            t1 = nt1;
            t2 = nt2;
        }

        if let Some(Some(prog)) = self.shader_progs.get(attr.mat as usize) {
            if let Some(vo) = node_vm::eval_graph(prog, raw_u, raw_v, raw_u, raw_v, ns, t1, t2, view_dir, &self.textures) {
                if vo.has_base { m.base = vo.base; }
                if vo.has_metal { m.metal = vo.metal; }
                if vo.has_rough { m.rough = vo.rough; }
                if vo.has_emit { m.emit = vo.emit; }
                if vo.has_opacity { m.opacity = vo.opacity; }
                if vo.has_normal {
                    ns = if vo.normal.dot(ng) > 0.05 { vo.normal } else { (vo.normal + ng * 0.25).norm() };
                    let (nt1, nt2) = basis(ns);
                    t1 = nt1;
                    t2 = nt2;
                }
            }
        }
        (m, ns, t1, t2)
    }

    fn eval_light_sample(&self, p: V3, l: &Light, r1: f32, r2: f32) -> Option<(V3, f32, V3, f32)> {
        // Returns (dir_to_light, dist, radiance, pdf_weight)
        match l.kind {
            1 => {
                // Directional / Sun with optional angular cone
                let dir = if l.radius > 1e-5 {
                    let cos_max = l.radius.cos();
                    let cz = 1.0 - r1 * (1.0 - cos_max);
                    let sz = (1.0 - cz * cz).max(0.0).sqrt();
                    let phi = 2.0 * PI * r2;
                    let (b1, b2) = basis(l.dir.norm());
                    (b1 * (sz * phi.cos()) + b2 * (sz * phi.sin()) + l.dir.norm() * cz).norm()
                } else {
                    l.dir.norm()
                };
                Some((dir, f32::INFINITY, l.color, 1.0))
            }
            2 => {
                // Spot light
                let to = l.pos - p;
                let d2 = to.dot(to).max(1e-8);
                let dist = d2.sqrt();
                let w = to / dist;
                let cos_theta = (-w).dot(l.dir.norm());
                let cos_outer = l.param0;
                let cos_inner = l.param1.max(cos_outer + 1e-4);
                if cos_theta <= cos_outer { return None; }
                let range_max = l.area_u.x;
                if range_max > 0.0 && dist >= range_max { return None; }
                let range_win = if range_max > 0.0 {
                    let r4 = (dist / range_max).powi(4);
                    let f = (1.0 - r4).clamp(0.0, 1.0);
                    f * f
                } else {
                    1.0
                };
                let t = ((cos_theta - cos_outer) / (cos_inner - cos_outer)).clamp(0.0, 1.0);
                let atten = t * t * (3.0 - 2.0 * t);
                let decay = if l.area_u.y > 0.0 { l.area_u.y } else { 2.0 };
                let dist_atten = if (decay - 2.0).abs() > 1e-3 { 1.0 / dist.powf(decay).max(1e-6) } else { 1.0 / d2 };
                if l.radius <= 1e-4 {
                    Some((w, dist, l.color * (atten * range_win * dist_atten), 1.0))
                } else {
                    let sin2 = (l.radius * l.radius / d2).min(0.9999);
                    let cos_max = (1.0 - sin2).sqrt();
                    let (b1, b2) = basis(w);
                    let cz = 1.0 - r1 * (1.0 - cos_max);
                    let sz = (1.0 - cz * cz).max(0.0).sqrt();
                    let phi = 2.0 * PI * r2;
                    let sdir = (b1 * (sz * phi.cos()) + b2 * (sz * phi.sin()) + w * cz).norm();
                    let solid = 2.0 * PI * (1.0 - cos_max);
                    let inv_area = 1.0 / (PI * l.radius * l.radius);
                    Some((sdir, dist, l.color * (atten * range_win * inv_area), solid))
                }
            }
            3 => {
                // RectAreaLight
                let n_l = l.dir.norm();
                let u_ax = l.area_u.norm();
                let v_ax = n_l.cross(u_ax).norm();
                let lp = l.pos + u_ax * ((r1 * 2.0 - 1.0) * l.param0) + v_ax * ((r2 * 2.0 - 1.0) * l.param1);
                let to = lp - p;
                let d2 = to.dot(to).max(1e-8);
                let dist = d2.sqrt();
                let w = to / dist;
                let cos_l = (-w).dot(n_l);
                if cos_l <= 0.0 { return None; }
                let area = 4.0 * l.param0 * l.param1;
                Some((w, dist, l.color, (cos_l * area) / d2))
            }
            _ => {
                // Point / Sphere light
                let to = l.pos - p;
                let d2 = to.dot(to).max(1e-8);
                let dist = d2.sqrt();
                let w = to / dist;
                let range_max = l.area_u.x;
                if range_max > 0.0 && dist >= range_max { return None; }
                let range_win = if range_max > 0.0 {
                    let r4 = (dist / range_max).powi(4);
                    let f = (1.0 - r4).clamp(0.0, 1.0);
                    f * f
                } else {
                    1.0
                };
                let decay = if l.area_u.y > 0.0 { l.area_u.y } else { 2.0 };
                let dist_atten = if (decay - 2.0).abs() > 1e-3 { 1.0 / dist.powf(decay).max(1e-6) } else { 1.0 / d2 };
                if l.radius <= 1e-4 {
                    Some((w, dist, l.color * (range_win * dist_atten), 1.0))
                } else {
                    let sin2 = (l.radius * l.radius / d2).min(0.9999);
                    let cos_max = (1.0 - sin2).sqrt();
                    let (b1, b2) = basis(w);
                    let cz = 1.0 - r1 * (1.0 - cos_max);
                    let sz = (1.0 - cz * cz).max(0.0).sqrt();
                    let phi = 2.0 * PI * r2;
                    let sdir = (b1 * (sz * phi.cos()) + b2 * (sz * phi.sin()) + w * cz).norm();
                    let solid = 2.0 * PI * (1.0 - cos_max);
                    let inv_area = 1.0 / (PI * l.radius * l.radius);
                    Some((sdir, dist, l.color * (range_win * inv_area), solid))
                }
            }
        }
    }

    fn sample_emissive_tri(&self, r_sel: f32, r1: f32, r2: f32) -> Option<(u32, V3, V3, V3, f32)> {
        if self.emissive_tris.is_empty() || self.emissive_total <= 0.0 { return None; }
        let target = r_sel * self.emissive_total;
        let mut lo = 0usize;
        let mut hi = self.emissive_tris.len();
        while lo + 1 < hi {
            let mid = (lo + hi) / 2;
            if self.emissive_cdf[mid] <= target { lo = mid; } else { hi = mid; }
        }
        let tri_idx = self.emissive_tris[lo];
        let g = &self.bvh.tris[tri_idx as usize];
        let a = &self.bvh.attrs[tri_idx as usize];
        let su = r1.sqrt();
        let b0 = 1.0 - su;
        let b1 = r2 * su;
        let lp = g.p0 + g.e1 * b0 + g.e2 * b1;
        let ng = g.e1.cross(g.e2).norm();
        let m = self.material(a.mat);
        let mut emit = m.emit;
        if m.emit_tex >= 0 {
            let w0 = 1.0 - b0 - b1;
            let u = (a.uv0[0] * w0 + a.uv1[0] * b0 + a.uv2[0] * b1) * m.uv_repeat[0];
            let v = (a.uv0[1] * w0 + a.uv1[1] * b0 + a.uv2[1] * b1) * m.uv_repeat[1];
            if let Some(c) = self.textures.sample_rgb(m.emit_tex, u, v) {
                emit = emit.mulv(c);
            }
        }
        let area_pdf = (self.emissive_power[lo] / self.emissive_total) / a.area.max(1e-9);
        Some((tri_idx, lp, ng, emit, area_pdf))
    }

    /// Evaluates shadow ray transmittance supporting colored glass (`trans > 0`) & alpha-cutout (`opacity < 1`).
    fn shadow_transmittance(&self, mut o: V3, d: V3, mut tmax: f32) -> V3 {
        let mut tr = V3::ONE;
        for _ in 0..8 {
            let Some(hit) = self.bvh.intersect(o, d, tmax) else { break; };
            let a = &self.bvh.attrs[hit.tri as usize];
            let mut m = self.material(a.mat);
            if m.base_tex >= 0 || m.opacity < 1.0 {
                let w0 = 1.0 - hit.u - hit.v;
                let u = (a.uv0[0] * w0 + a.uv1[0] * hit.u + a.uv2[0] * hit.v) * m.uv_repeat[0];
                let v = (a.uv0[1] * w0 + a.uv1[1] * hit.u + a.uv2[1] * hit.v) * m.uv_repeat[1];
                if let Some(c) = self.textures.sample(m.base_tex, u, v) {
                    m.base = m.base.mulv(v3(c[0], c[1], c[2]));
                    m.opacity *= c[3];
                }
            }
            let op = m.opacity.clamp(0.0, 1.0);
            let pass_trans = m.trans.clamp(0.0, 1.0) * (1.0 - m.metal.clamp(0.0, 1.0));
            if op >= 0.999 && pass_trans <= 0.001 {
                return V3::ZERO;
            }
            let pass_tint = V3::splat(1.0 - op) + m.base * (op * pass_trans);
            tr = tr.mulv(pass_tint);
            if tr.maxc() < 1e-3 {
                return V3::ZERO;
            }
            let step_t = hit.t + self.eps * 2.0;
            if tmax.is_finite() {
                if step_t >= tmax { break; }
                tmax -= step_t;
            }
            o = o + d * step_t;
        }
        tr
    }

    /// Direct lighting at a surface point (punctual/spot/area lights, emissive mesh NEE + HDRI with MIS).
    pub(crate) fn direct(&self, p: V3, sh: &Shade, v: V3, rng: &mut Sampler) -> V3 {
        let mut sum = V3::ZERO;
        let origin = p + sh.n * self.eps;
        if !self.lights.is_empty() {
            let nl = self.lights.len();
            let li = ((rng.f() * nl as f32) as usize).min(nl - 1);
            let l = &self.lights[li];
            let (r1, r2) = rng.f2();
            if let Some((dir, dist, radiance, pdf_scale)) = self.eval_light_sample(p, l, r1, r2) {
                let cos = sh.n.dot(dir);
                if cos > 0.0 {
                    let tmax = if dist.is_finite() { dist * 0.999 } else { f32::INFINITY };
                    let tr_shadow = self.shadow_transmittance(origin, dir, tmax);
                    if tr_shadow.maxc() > 0.0 {
                        sum = sum + sh.eval(dir, v).mulv(radiance).mulv(tr_shadow) * (cos * pdf_scale * nl as f32);
                    }
                }
            }
        }
        if !self.emissive_tris.is_empty() {
            let r_sel = rng.f();
            let (r1, r2) = rng.f2();
            if let Some((_ti, lp, ng_l, emit, area_pdf)) = self.sample_emissive_tri(r_sel, r1, r2) {
                let to = lp - origin;
                let d2 = to.dot(to);
                if d2 > 1e-8 {
                    let dist = d2.sqrt();
                    let dir = to / dist;
                    let cos_s = sh.n.dot(dir);
                    let cos_l = (-dir).dot(ng_l).abs();
                    if cos_s > 0.0 && cos_l > 1e-4 {
                        let tr_shadow = self.shadow_transmittance(origin, dir, dist * 0.998);
                        if tr_shadow.maxc() > 0.0 {
                            let solid_pdf = area_pdf * d2 / cos_l;
                            let w = power(solid_pdf, sh.pdf(dir, v));
                            sum = sum + sh.eval(dir, v).mulv(emit).mulv(tr_shadow) * (cos_s * w / solid_pdf);
                        }
                    }
                }
            }
        }
        if self.env.has_image() {
            let (r1, r2) = rng.f2();
            if let Some((dir, rad, pdf)) = self.env.sample(r1, r2) {
                let cos = sh.n.dot(dir);
                if cos > 0.0 {
                    let tr_shadow = self.shadow_transmittance(origin, dir, f32::INFINITY);
                    if tr_shadow.maxc() > 0.0 {
                        let w = power(pdf, sh.pdf(dir, v));
                        sum = sum + sh.eval(dir, v).mulv(rad).mulv(tr_shadow) * (cos * w / pdf);
                    }
                }
            }
        }
        sum
    }

    fn direct_volume(&self, p: V3, d: V3, rng: &mut Sampler) -> V3 {
        let mut sum = V3::ZERO;
        if !self.lights.is_empty() {
            let nl = self.lights.len();
            let li = ((rng.f() * nl as f32) as usize).min(nl - 1);
            let (r1, r2) = rng.f2();
            if let Some((dir, dist, radiance, pdf_scale)) = self.eval_light_sample(p, &self.lights[li], r1, r2) {
                let tmax = if dist.is_finite() { dist * 0.999 } else { f32::INFINITY };
                let tr_shadow = self.shadow_transmittance(p, dir, tmax);
                if tr_shadow.maxc() > 0.0 {
                    let ph = hg_phase(d.dot(dir), self.vol.anisotropy);
                    let tr = if dist.is_finite() { (-self.vol.density * dist).exp() } else { 0.0 };
                    sum = sum + radiance.mulv(tr_shadow) * (ph * tr * pdf_scale * nl as f32);
                }
            }
        }
        if self.env.has_image() {
            let (r1, r2) = rng.f2();
            if let Some((dir, rad, pdf)) = self.env.sample(r1, r2) {
                let tr_shadow = self.shadow_transmittance(p, dir, f32::INFINITY);
                if tr_shadow.maxc() > 0.0 {
                    let ph = hg_phase(d.dot(dir), self.vol.anisotropy);
                    let tr = (-self.vol.density * self.vol.max_dist).exp();
                    sum = sum + rad.mulv(tr_shadow) * (ph * tr / pdf);
                }
            }
        }
        sum
    }

    pub(crate) fn trace(&self, mut o: V3, mut d: V3, rng: &mut Sampler, p: &RenderParams) -> Sample {
        let mut thr = V3::ONE;
        let mut rad = V3::ZERO;
        let mut alpha = 1.0;
        let mut albedo = V3::ZERO;
        let mut normal = V3::ZERO;
        let mut primary_rough = 1.0f32;
        let mut aov_done = false;
        let mut bounce = 0u32;
        let mut guard = 0u32;
        let mut last_pdf = 0.0f32;
        let mut specular = true;
        let mut inside_trans = false;

        loop {
            guard += 1;
            if guard > 64 { break; }
            let hit_opt = self.bvh.intersect(o, d, f32::INFINITY);

            // Homogeneous volume scattering
            if self.vol.density > 0.0 && !inside_trans {
                let max_t = hit_opt.as_ref().map(|h| h.t).unwrap_or(self.vol.max_dist);
                let t_vol = -(1.0 - rng.f()).max(1e-7).ln() / self.vol.density;
                if t_vol < max_t {
                    let vp = o + d * t_vol;
                    if !aov_done {
                        albedo = self.vol.color;
                        normal = -d;
                        primary_rough = 1.0;
                        aov_done = true;
                    }
                    if bounce >= p.max_bounces { break; }
                    thr = thr.mulv(self.vol.color);
                    rad = rad + thr.mulv(self.direct_volume(vp, d, rng));
                    let (u1, u2) = rng.f2();
                    d = hg_sample(d, self.vol.anisotropy, u1, u2);
                    o = vp;
                    specular = false;
                    last_pdf = hg_phase(1.0, self.vol.anisotropy);
                    bounce += 1;
                    continue;
                }
            }

            let Some(hit) = hit_opt else {
                if bounce == 0 {
                    match self.bg_mode {
                        1 => rad = rad + thr.mulv(self.bg),
                        2 => { alpha = 0.0; }
                        _ => rad = rad + thr.mulv(self.env.eval(d)),
                    }
                    if !aov_done {
                        albedo = V3::ZERO;
                        normal = V3::ZERO;
                    }
                } else {
                    let w = if specular || !self.env.has_image() { 1.0 } else { power(last_pdf, self.env.pdf(d)) };
                    let tr = if self.vol.density > 0.0 { (-self.vol.density * self.vol.max_dist).exp() } else { 1.0 };
                    rad = rad + thr.mulv(self.env.eval(d)) * (w * tr);
                    if !aov_done {
                        albedo = self.env.eval(d).clamp(0.0, 1.0);
                        normal = -d;
                    }
                }
                break;
            };

            let geom = &self.bvh.tris[hit.tri as usize];
            let attr = &self.bvh.attrs[hit.tri as usize];
            let pt = o + d * hit.t;
            let mut ng = geom.e1.cross(geom.e2).norm();
            let w0 = 1.0 - hit.u - hit.v;
            let mut ns = if attr.n0.dot(attr.n0) > 0.0 {
                (attr.n0 * w0 + attr.n1 * hit.u + attr.n2 * hit.v).norm()
            } else {
                ng
            };
            if ns.dot(ng) < 0.0 { ns = -ns; }
            let front = ng.dot(d) < 0.0;
            if !front { ng = -ng; ns = -ns; }

            let (m, ns, t1, t2) = self.eval_material_hit(attr, hit.u, hit.v, ng, ns, -d);

            // Beer-Lambert absorption when travelling inside a transmissive volume
            if !front && m.attenuation_dist > 0.0 {
                let att_col = m.attenuation_color.clamp(1e-4, 1.0);
                let sigma_a = -att_col.ln() / m.attenuation_dist;
                thr = thr.mulv((-sigma_a * hit.t).exp());
            }

            if m.opacity < 1.0 && rng.f() > m.opacity {
                o = pt - ng * self.eps;
                continue;
            }

            // Emissive contribution (with MIS if reached via non-delta indirect bounce)
            if m.emit.maxc() > 0.0 {
                let w_emit = if bounce == 0 || specular || self.emissive_total <= 0.0 {
                    1.0
                } else {
                    let e_idx = self.tri_to_emissive[hit.tri as usize];
                    if e_idx >= 0 {
                        let cos_l = (-d).dot(ng).abs().max(1e-4);
                        let area_pdf = (self.emissive_power[e_idx as usize] / self.emissive_total) / attr.area.max(1e-9);
                        let solid_pdf = area_pdf * (hit.t * hit.t) / cos_l;
                        power(last_pdf, solid_pdf)
                    } else {
                        1.0
                    }
                };
                rad = rad + thr.mulv(m.emit) * w_emit;
            }

            let v = -d;
            let transmissive = m.trans > 0.0 && rng.f() < m.trans * (1.0 - m.metal);
            let is_delta_for_aov = (transmissive && m.rough < 0.15) || (m.metal > 0.85 && m.rough < 0.12);
            if !aov_done && !is_delta_for_aov {
                albedo = m.base;
                normal = ns;
                primary_rough = m.rough;
                aov_done = true;
            }

            if bounce >= p.max_bounces {
                if !aov_done {
                    albedo = m.base;
                    normal = ns;
                    primary_rough = m.rough;
                }
                break;
            }

            if transmissive {
                let to_local = |w: V3| v3(w.dot(t1), w.dot(t2), w.dot(ns));
                let alpha = m.rough.clamp(0.0, 1.0).powi(2).max(1e-5);
                let (u1, u2) = rng.f2();
                let hl = sample_vndf_aniso(to_local(v), alpha, alpha, u1, u2);
                let h = (t1 * hl.x + t2 * hl.y + ns * hl.z).norm();
                let eta = if front { m.ior } else { 1.0 / m.ior };
                let vh = v.dot(h).max(1e-4);
                let f = fresnel_dielectric(vh, eta);
                let (ndir, refracted) = if rng.f() < f {
                    (d - h * (2.0 * d.dot(h)), false)
                } else {
                    let r = 1.0 / eta;
                    let c = -d.dot(h);
                    let k = 1.0 - r * r * (1.0 - c * c);
                    if k < 0.0 {
                        (d - h * (2.0 * d.dot(h)), false)
                    } else {
                        ((d * r + h * (r * c - k.sqrt())).norm(), true)
                    }
                };
                let nl_abs = ndir.dot(ns).abs().max(1e-4);
                let g1_l = smith_g1_aniso(v3(ndir.dot(t1), ndir.dot(t2), nl_abs), alpha, alpha);
                thr = thr * g1_l;

                if refracted {
                    if front {
                        // Tint once on entry (matches glTF KHR_materials_transmission).
                        thr = thr.mulv(m.base);
                    }
                    inside_trans = front;
                    o = pt - ng * self.eps;
                } else {
                    inside_trans = !front;
                    o = pt + ng * self.eps;
                }
                d = ndir;
                specular = alpha < 0.02;
                if !specular {
                    let d_ndf = ggx_d_aniso(hl, alpha, alpha);
                    let g1_v = smith_g1_aniso(to_local(v), alpha, alpha);
                    let v_nv = v.dot(ns).abs().max(1e-4);
                    last_pdf = (d_ndf * g1_v / (4.0 * v_nv)).max(1e-4);
                } else {
                    last_pdf = 1e6;
                }
            } else {
                let sh = Shade::new(&m, ns, t1, t2, v);
                if v.dot(ns) <= 0.0 { break; }
                rad = rad + thr.mulv(self.direct(pt, &sh, v, rng));

                let r_lobe = rng.f();
                let (u1, u2) = rng.f2();
                let (ndir, w);
                if r_lobe < sh.p_cc {
                    let vl = sh.to_local(v);
                    let hl = sample_vndf_aniso(vl, sh.alpha_cc, sh.alpha_cc, u1, u2);
                    let h = t1 * hl.x + t2 * hl.y + ns * hl.z;
                    let l = d - h * (2.0 * d.dot(h));
                    let nl = ns.dot(l);
                    if nl <= 0.0 { break; }
                    let fc = sh.clearcoat * schlick_scalar(0.04, v.dot(h).max(0.0));
                    ndir = l;
                    w = V3::splat(fc * smith_g1_aniso(sh.to_local(l), sh.alpha_cc, sh.alpha_cc) / sh.p_cc);
                    specular = sh.alpha_cc < 0.01;
                } else if r_lobe < sh.p_cc + sh.ps {
                    let vl = sh.to_local(v);
                    let hl = sample_vndf_aniso(vl, sh.ax, sh.ay, u1, u2);
                    let h = t1 * hl.x + t2 * hl.y + ns * hl.z;
                    let l = d - h * (2.0 * d.dot(h));
                    let nl = ns.dot(l);
                    if nl <= 0.0 { break; }
                    let f = schlick(sh.f0, v.dot(h).max(0.0));
                    let coat_atten = 1.0 - sh.clearcoat * schlick_scalar(0.04, ns.dot(v));
                    ndir = l;
                    w = f.mulv(sh.ms_comp) * (coat_atten * smith_g1_aniso(sh.to_local(l), sh.ax, sh.ay) / sh.ps);
                    specular = sh.ax.max(sh.ay) < 0.01;
                } else {
                    let r = u1.sqrt();
                    let phi = 2.0 * PI * u2;
                    ndir = (t1 * (r * phi.cos()) + t2 * (r * phi.sin()) + ns * (1.0 - u1).max(0.0).sqrt()).norm();
                    let kd = V3::ONE - schlick(sh.f0, ns.dot(v));
                    let coat_atten = 1.0 - sh.clearcoat * schlick_scalar(0.04, ns.dot(v));
                    let p_diff = (1.0 - sh.ps - sh.p_cc).max(1e-4);
                    w = sh.base.mulv(kd) * (coat_atten * (1.0 - sh.metal) / p_diff);
                    specular = false;
                }
                last_pdf = sh.pdf(ndir, v);
                thr = thr.mulv(w);
                o = pt + ng * self.eps;
                d = ndir;
            }
            bounce += 1;
            if !thr.is_finite() { thr = V3::ZERO; }
            if bounce >= 3 {
                let q = thr.maxc().clamp(0.05, 1.0);
                if rng.f() > q { break; }
                thr = thr / q;
            }
            if thr.maxc() <= 0.0 { break; }
        }
        Sample { rad, alpha, albedo, normal, rough: primary_rough }
    }

    /// Accumulates `spp` samples (sums, not means) for rows `y0..y1`.
    /// Includes conservative root-AABB frustum cull for pure sky/background pixels (O(1)),
    /// early-exit after 4 miss samples, and variance-based adaptive sampling starting at 4 spp.
    pub fn render_rows(&self, accum: &mut [f32], aov: &mut [f32], w: usize, h: usize, y0: usize, y1: usize, base: usize, p: &RenderParams) {
        let cam = &self.cam;
        let adaptive = p.adaptive_threshold > 0.0 && p.spp >= 8;
        let min_spp = 4u32.min(p.spp);
        let can_sky_cull = cam.aperture <= 0.0 && cam.shutter <= 1e-4 && self.vol.density <= 0.0;
        let can_sky_early_exit = can_sky_cull && p.spp > 4;

        // Conservative padded scene AABB for O(1) sky-pixel rejection (zero edge aliasing)
        let (b_lo, b_hi) = self.bvh.bounds();
        let has_bvh = !self.bvh.nodes4.is_empty() && b_lo.x <= b_hi.x;
        let (p_lo, p_hi) = if can_sky_cull && has_bvh {
            let d_lo = (b_lo - cam.origin).len();
            let d_hi = (b_hi - cam.origin).len();
            let max_d = d_lo.max(d_hi).max(1.0);
            let px_step = cam.right.len() * (2.0 / w.max(1) as f32) + cam.up.len() * (2.0 / h.max(1) as f32);
            let pad = if cam.ortho { px_step * 1.5 + 1e-3 } else { px_step * max_d * 1.5 + 1e-3 };
            (b_lo - V3::splat(pad), b_hi + V3::splat(pad))
        } else {
            (V3::ZERO, V3::ZERO)
        };
        let spp_f = p.spp as f32;

        for y in y0..y1.min(h) {
            let cy = 1.0 - (y as f32 + 0.5) / h as f32 * 2.0;
            for x in 0..w {
                let idx = (y - base) * w + x;

                // O(1) conservative sky cull: if center ray misses padded scene AABB,
                // no jittered ray inside this pixel can hit any triangle.
                if can_sky_cull && has_bvh {
                    let cx = (x as f32 + 0.5) / w as f32 * 2.0 - 1.0;
                    let (c_org, c_dir) = if cam.ortho {
                        (cam.origin + cam.right * cx + cam.up * cy, cam.fwd)
                    } else {
                        (cam.origin, (cam.fwd + cam.right * cx + cam.up * cy).norm())
                    };
                    let inv_d = v3(1.0 / c_dir.x, 1.0 / c_dir.y, 1.0 / c_dir.z);
                    let tx0 = (p_lo.x - c_org.x) * inv_d.x;
                    let tx1 = (p_hi.x - c_org.x) * inv_d.x;
                    let ty0 = (p_lo.y - c_org.y) * inv_d.y;
                    let ty1 = (p_hi.y - c_org.y) * inv_d.y;
                    let tz0 = (p_lo.z - c_org.z) * inv_d.z;
                    let tz1 = (p_hi.z - c_org.z) * inv_d.z;
                    let tmin = tx0.min(tx1).max(ty0.min(ty1)).max(tz0.min(tz1)).max(0.0);
                    let tmax = tx0.max(tx1).min(ty0.max(ty1)).min(tz0.max(tz1));
                    if tmin > tmax {
                        let (rad, alpha) = match self.bg_mode {
                            1 => (self.bg, 1.0f32),
                            2 => (V3::ZERO, 0.0f32),
                            _ => (self.env.eval(c_dir), 1.0f32),
                        };
                        let lum = rad.lum();
                        accum[idx * 4] += rad.x * spp_f;
                        accum[idx * 4 + 1] += rad.y * spp_f;
                        accum[idx * 4 + 2] += rad.z * spp_f;
                        accum[idx * 4 + 3] += alpha * spp_f;
                        aov[idx * AOV_STRIDE + 6] += lum * lum * spp_f;
                        continue;
                    }
                }

                let mut sum_rgb = V3::ZERO;
                let mut sum_a = 0.0f32;
                let mut sum_alb = V3::ZERO;
                let mut sum_nrm = V3::ZERO;
                let mut sum_l = 0.0f32;
                let mut sum_l2 = 0.0f32;
                let mut sum_rough = 0.0f32;
                let mut taken = 0u32;
                let mut any_hit = false;

                for s_i in 0..p.spp {
                    let sample_idx = p.seed.wrapping_mul(p.spp).wrapping_add(s_i);
                    let mut rng = Sampler::new(x as u32, y as u32, sample_idx, p.seed);
                    let (jx, jy) = rng.f2();
                    let sx = (x as f32 + jx) / w as f32 * 2.0 - 1.0;
                    let sy = 1.0 - (y as f32 + jy) / h as f32 * 2.0;

                    // Blender-style physical camera shutter motion blur between current and previous frame
                    let (c_origin, c_fwd, c_right, c_up) = if cam.shutter > 1e-4 {
                        if let Some(pcam) = self.prev_cam {
                            let tm = rng.f() * cam.shutter.clamp(0.0, 1.0);
                            (
                                cam.origin.lerp(pcam.origin, tm),
                                cam.fwd.lerp(pcam.fwd, tm).norm(),
                                cam.right.lerp(pcam.right, tm),
                                cam.up.lerp(pcam.up, tm),
                            )
                        } else {
                            (cam.origin, cam.fwd, cam.right, cam.up)
                        }
                    } else {
                        (cam.origin, cam.fwd, cam.right, cam.up)
                    };

                    let (mut org, mut dir) = if cam.ortho {
                        (c_origin + c_right * sx + c_up * sy, c_fwd)
                    } else {
                        (c_origin, (c_fwd + c_right * sx + c_up * sy).norm())
                    };
                    if cam.aperture > 0.0 {
                        let focus_pt = org + dir * (cam.focus / dir.dot(c_fwd).max(1e-4));
                        let (lu1, lu2) = rng.f2();
                        let r = cam.aperture * lu1.sqrt();
                        let a = 2.0 * PI * lu2;
                        org = org + c_right.norm() * (r * a.cos()) + c_up.norm() * (r * a.sin());
                        dir = (focus_pt - org).norm();
                    }

                    let mut s = self.trace(org, dir, &mut rng, p);
                    if !s.rad.is_finite() { s.rad = V3::ZERO; }
                    let l = s.rad.maxc();
                    if l > p.clamp { s.rad = s.rad * (p.clamp / l); }

                    if s.normal.dot(s.normal) > 1e-6 || s.albedo.dot(s.albedo) > 1e-6 {
                        any_hit = true;
                    }

                    let lum = s.rad.lum();
                    sum_rgb = sum_rgb + s.rad;
                    sum_a += s.alpha;
                    sum_alb = sum_alb + s.albedo;
                    sum_nrm = sum_nrm + s.normal;
                    sum_l += lum;
                    sum_l2 += lum * lum;
                    sum_rough += s.rough;
                    taken += 1;

                    // Pure background/sky pixel: 4 stratified Sobol samples all missed geometry -> early exit!
                    if can_sky_early_exit && taken == 4 && !any_hit {
                        break;
                    }

                    if adaptive && taken >= min_spp && (taken & 3) == 0 && taken < p.spp {
                        let n = taken as f32;
                        let mean_l = sum_l / n;
                        let var_l = (sum_l2 / n - mean_l * mean_l).max(0.0);
                        let rel_err = (var_l / n).sqrt() / (mean_l + 0.05);
                        if rel_err < p.adaptive_threshold {
                            break;
                        }
                    }
                }

                // Scale partial adaptive sum to represent `p.spp` samples consistently across passes.
                let scale = if taken < p.spp { p.spp as f32 / taken as f32 } else { 1.0 };
                accum[idx * 4] += sum_rgb.x * scale;
                accum[idx * 4 + 1] += sum_rgb.y * scale;
                accum[idx * 4 + 2] += sum_rgb.z * scale;
                accum[idx * 4 + 3] += sum_a * scale;

                let ab = idx * AOV_STRIDE;
                aov[ab] += sum_alb.x * scale;
                aov[ab + 1] += sum_alb.y * scale;
                aov[ab + 2] += sum_alb.z * scale;
                aov[ab + 3] += sum_nrm.x * scale;
                aov[ab + 4] += sum_nrm.y * scale;
                aov[ab + 5] += sum_nrm.z * scale;
                aov[ab + 6] += sum_l2 * scale;
                aov[ab + 7] += sum_rough * scale;
            }
        }
    }
}

// ───────────────────────────── C ABI (WASM) ─────────────────────────────

static mut SCENE: Option<Scene> = None;

#[allow(static_mut_refs)]
fn scene() -> Option<&'static mut Scene> {
    unsafe { SCENE.as_mut() }
}

#[no_mangle]
pub extern "C" fn rk_alloc(size: usize) -> *mut u8 {
    if size == 0 { return std::ptr::null_mut(); }
    unsafe { alloc_zeroed(Layout::from_size_align(size, 16).unwrap()) }
}

#[no_mangle]
pub extern "C" fn rk_free(ptr: *mut u8, size: usize) {
    if ptr.is_null() || size == 0 { return; }
    unsafe { dealloc(ptr, Layout::from_size_align(size, 16).unwrap()) }
}

unsafe fn f32s<'a>(p: *const f32, n: usize) -> &'a [f32] {
    if p.is_null() || n == 0 { &[] } else { std::slice::from_raw_parts(p, n) }
}
unsafe fn f32s_mut<'a>(p: *mut f32, n: usize) -> &'a mut [f32] {
    std::slice::from_raw_parts_mut(p, n)
}

fn v3_at(s: &[f32], i: usize) -> V3 {
    v3(s[i], s[i + 1], s[i + 2])
}

/// Computes tangent + handedness sign from triangle edges & UVs.
pub fn compute_tangent(e1: V3, e2: V3, uv0: [f32; 2], uv1: [f32; 2], uv2: [f32; 2], n: V3) -> (V3, f32) {
    let du1 = uv1[0] - uv0[0];
    let dv1 = uv1[1] - uv0[1];
    let du2 = uv2[0] - uv0[0];
    let dv2 = uv2[1] - uv0[1];
    let det = du1 * dv2 - du2 * dv1;
    if det.abs() < 1e-8 {
        return (V3::ZERO, 1.0);
    }
    let inv = 1.0 / det;
    let t = (e1 * dv2 - e2 * dv1) * inv;
    let b = (e2 * du1 - e1 * du2) * inv;
    let t_norm = t.norm();
    let sign = if n.cross(t_norm).dot(b) < 0.0 { -1.0 } else { 1.0 };
    (t_norm, sign)
}

pub fn build_tris_and_attrs(pos: &[f32], nrm: &[f32], uvs: &[f32], ids: &[u32], ntri: usize) -> (Vec<TriGeom>, Vec<TriAttr>) {
    let mut tris = Vec::with_capacity(ntri);
    let mut attrs = Vec::with_capacity(ntri);
    let has_n = nrm.len() >= ntri * 9;
    let has_uv = uvs.len() >= ntri * 6;
    for t in 0..ntri {
        let b = t * 9;
        let (p0, p1, p2) = (v3_at(pos, b), v3_at(pos, b + 3), v3_at(pos, b + 6));
        let e1 = p1 - p0;
        let e2 = p2 - p0;
        let ng = e1.cross(e2);
        let area = 0.5 * ng.len();
        let ng_n = if area > 1e-12 { ng / (2.0 * area) } else { v3(0.0, 1.0, 0.0) };
        let z = V3::ZERO;
        let uv0 = if has_uv { [uvs[t * 6], uvs[t * 6 + 1]] } else { [0.0, 0.0] };
        let uv1 = if has_uv { [uvs[t * 6 + 2], uvs[t * 6 + 3]] } else { [0.0, 0.0] };
        let uv2 = if has_uv { [uvs[t * 6 + 4], uvs[t * 6 + 5]] } else { [0.0, 0.0] };
        let (tangent, b_sign) = if has_uv {
            compute_tangent(e1, e2, uv0, uv1, uv2, ng_n)
        } else {
            (V3::ZERO, 1.0)
        };
        tris.push(TriGeom { p0, e1, e2 });
        attrs.push(TriAttr {
            n0: if has_n { v3_at(nrm, b) } else { z },
            n1: if has_n { v3_at(nrm, b + 3) } else { z },
            n2: if has_n { v3_at(nrm, b + 6) } else { z },
            uv0, uv1, uv2,
            tangent,
            b_sign,
            mat: ids.get(t).copied().unwrap_or(0),
            area,
        });
    }
    (tris, attrs)
}

/// pos/nrm: f32[ntri*9]; uvs: f32[ntri*6] (nullable); mat_ids: u32[ntri];
/// mats: f32[nmat*32]; lights: f32[nlight*16].
/// Returns BVH node count, or 0 on invalid input.
#[no_mangle]
pub unsafe extern "C" fn rk_scene_load(
    pos: *const f32,
    nrm: *const f32,
    uvs: *const f32,
    mat_ids: *const u32,
    ntri: usize,
    mats: *const f32,
    nmat: usize,
    lights: *const f32,
    nlight: usize,
) -> usize {
    if ntri == 0 || pos.is_null() { return 0; }
    let pos_s = f32s(pos, ntri * 9);
    let nrm_s = f32s(nrm, ntri * 9);
    let uv_s = f32s(uvs, ntri * 6);
    let ids: &[u32] = if mat_ids.is_null() { &[] } else { std::slice::from_raw_parts(mat_ids, ntri) };
    let (tris, attrs) = build_tris_and_attrs(pos_s, nrm_s, uv_s, ids, ntri);

    let ms = f32s(mats, nmat * MAT_STRIDE);
    let materials: Vec<Material> = (0..nmat).map(|i| {
        let b = i * MAT_STRIDE;
        Material {
            base: v3_at(ms, b),
            metal: ms[b + 3],
            rough: ms[b + 4],
            emit: v3_at(ms, b + 5),
            trans: ms[b + 8],
            ior: ms[b + 9].max(1.0),
            opacity: ms[b + 10],
            base_tex: ms[b + 11] as i32,
            normal_tex: ms[b + 12] as i32,
            rough_tex: ms[b + 13] as i32,
            metal_tex: ms[b + 14] as i32,
            emit_tex: ms[b + 15] as i32,
            clearcoat: ms[b + 16],
            clearcoat_rough: ms[b + 17],
            sheen: ms[b + 18],
            sheen_rough: ms[b + 19],
            sheen_color: v3_at(ms, b + 20),
            attenuation_color: v3_at(ms, b + 23),
            attenuation_dist: ms[b + 26],
            normal_scale: if ms[b + 27] > 0.0 { ms[b + 27] } else { 1.0 },
            anisotropy: ms[b + 28],
            subsurface: ms[b + 29],
            uv_repeat: [
                if ms[b + 30].abs() > 1e-6 { ms[b + 30] } else { 1.0 },
                if ms[b + 31].abs() > 1e-6 { ms[b + 31] } else { 1.0 },
            ],
        }
    }).collect();

    let ls = f32s(lights, nlight * LIGHT_STRIDE);
    let light_v: Vec<Light> = (0..nlight).map(|i| {
        let b = i * LIGHT_STRIDE;
        Light {
            kind: ls[b] as u32,
            pos: v3_at(ls, b + 1),
            color: v3_at(ls, b + 4),
            dir: v3_at(ls, b + 7),
            radius: ls[b + 10],
            param0: ls[b + 11],
            param1: ls[b + 12],
            area_u: v3_at(ls, b + 13),
        }
    }).collect();

    let sc = Scene::new(tris, attrs, materials, light_v);
    let n = sc.bvh.nodes.len();
    SCENE = Some(sc);
    n
}

/// Fast BVH refit + lights update when topology & materials/textures didn't change (e.g. animation frames).
#[no_mangle]
pub unsafe extern "C" fn rk_refit(pos: *const f32, nrm: *const f32, ntri: usize, lights: *const f32, nlight: usize) -> i32 {
    let Some(sc) = scene() else { return -1 };
    if ntri != sc.bvh.tris.len() || pos.is_null() { return -2; }
    sc.refit(f32s(pos, ntri * 9), f32s(nrm, ntri * 9));
    if !lights.is_null() || nlight == 0 {
        let ls = f32s(lights, nlight * LIGHT_STRIDE);
        sc.lights = (0..nlight).map(|i| {
            let b = i * LIGHT_STRIDE;
            Light {
                kind: ls[b] as u32,
                pos: v3_at(ls, b + 1),
                color: v3_at(ls, b + 4),
                dir: v3_at(ls, b + 7),
                radius: ls[b + 10],
                param0: ls[b + 11],
                param1: ls[b + 12],
                area_u: v3_at(ls, b + 13),
            }
        }).collect();
    }
    0
}

/// Upload packed RGBA8 texture atlas + metadata (`[offset, w, h, flags]` * ntex).
#[no_mangle]
pub unsafe extern "C" fn rk_set_textures(data: *const u8, data_len: usize, metas: *const u32, ntex: usize) -> i32 {
    let Some(sc) = scene() else { return -1 };
    if ntex == 0 || data.is_null() || metas.is_null() {
        sc.textures.set(&[], &[], 0);
        sc.rebuild_emissive_table();
        return 0;
    }
    let data_s = std::slice::from_raw_parts(data, data_len);
    let meta_s = std::slice::from_raw_parts(metas, ntex * tex::TEX_META_STRIDE);
    sc.textures.set(data_s, meta_s, ntex);
    sc.rebuild_emissive_table();
    0
}

/// params f32[16]: intensity, rotY, top.rgb, horizon.rgb, bottom.rgb, bg_mode, bg.rgb.
/// Optional equirect rgb f32[w*h*3] (row 0 = zenith).
#[no_mangle]
pub unsafe extern "C" fn rk_set_env(params: *const f32, rgb: *const f32, w: usize, h: usize) -> i32 {
    let Some(sc) = scene() else { return -1 };
    let p = f32s(params, 16);
    let mut env = Env::sky(p[0], v3_at(p, 2), v3_at(p, 5), v3_at(p, 8));
    env.rot = p[1];
    if !rgb.is_null() && w > 0 && h > 0 {
        env.set_image(f32s(rgb, w * h * 3), w, h);
    }
    sc.env = env;
    sc.bg_mode = p[11] as u32;
    sc.bg = v3_at(p, 12);
    0
}

/// Configure homogeneous volumetric fog (`density = 0` disables).
#[no_mangle]
pub unsafe extern "C" fn rk_set_volume(density: f32, anisotropy: f32, r: f32, g: f32, b: f32, max_dist: f32) -> i32 {
    let Some(sc) = scene() else { return -1 };
    sc.vol = Volume {
        density: density.max(0.0),
        anisotropy: anisotropy.clamp(-0.95, 0.95),
        color: v3(r, g, b).clamp(0.0, 1.0),
        max_dist: if max_dist > 0.0 { max_dist } else { 100.0 },
    };
    0
}

/// params f32[16]: origin3, fwd3, right3, up3, aperture, focus, ortho (>0.5), shutter (0..1).
#[no_mangle]
pub unsafe extern "C" fn rk_set_camera(params: *const f32) -> i32 {
    let Some(sc) = scene() else { return -1 };
    let p = f32s(params, 16);
    sc.cam = Camera {
        origin: v3_at(p, 0),
        fwd: v3_at(p, 3),
        right: v3_at(p, 6),
        up: v3_at(p, 9),
        aperture: p[12],
        focus: p[13].max(1e-3),
        ortho: p[14] > 0.5,
        shutter: p[15].clamp(0.0, 1.0),
    };
    0
}

/// accum: f32[(y1-y0)*w*4], aov: f32[(y1-y0)*w*8] — tile-relative sums, zero-initialised. Rows y0..y1.
#[no_mangle]
pub unsafe extern "C" fn rk_render_rows(
    accum: *mut f32,
    aov: *mut f32,
    w: usize,
    h: usize,
    y0: usize,
    y1: usize,
    spp: u32,
    seed: u32,
    max_bounces: u32,
    clamp: f32,
    adaptive_threshold: f32,
) -> i32 {
    let Some(sc) = scene() else { return -1 };
    let p = RenderParams {
        spp,
        seed,
        max_bounces,
        clamp: if clamp > 0.0 { clamp } else { 1e9 },
        adaptive_threshold: adaptive_threshold.max(0.0),
    };
    let y1 = y1.min(h);
    if y1 <= y0 { return 0; }
    let rows = y1 - y0;
    sc.render_rows(f32s_mut(accum, rows * w * 4), f32s_mut(aov, rows * w * AOV_STRIDE), w, h, y0, y1, y0, &p);
    0
}

#[no_mangle]
pub unsafe extern "C" fn rk_denoise(accum: *const f32, aov: *const f32, out: *mut f32, w: usize, h: usize, spp: f32, passes: usize) {
    post::denoise(f32s(accum, w * h * 4), f32s(aov, w * h * AOV_STRIDE), f32s_mut(out, w * h * 4), w, h, spp, passes);
}

#[no_mangle]
pub unsafe extern "C" fn rk_temporal_reproject(
    cur_mean: *const f32,
    cur_aov: *const f32,
    prev_mean: *const f32,
    prev_aov: *const f32,
    out_mean: *mut f32,
    w: usize,
    h: usize,
    cur_spp: f32,
    prev_spp: f32,
    blend: f32,
) -> i32 {
    let Some(sc) = scene() else { return -1 };
    let n = w * h;
    sc.temporal_reproject(
        f32s(cur_mean, n * 4),
        f32s(cur_aov, n * AOV_STRIDE),
        f32s(prev_mean, n * 4),
        f32s(prev_aov, n * AOV_STRIDE),
        f32s_mut(out_mean, n * 4),
        w,
        h,
        cur_spp,
        prev_spp,
        blend,
    );
    0
}

#[no_mangle]
pub unsafe extern "C" fn rk_mean(accum: *const f32, out: *mut f32, n: usize, spp: f32) {
    post::mean(f32s(accum, n * 4), f32s_mut(out, n * 4), spp);
}

/// src: f32 rgba mean, out: u8 rgba. mode 0 linear, 1 ACES, 2 AgX, 3 Neutral.
#[no_mangle]
pub unsafe extern "C" fn rk_tonemap(src: *const f32, out: *mut u8, n: usize, exposure: f32, mode: u32) {
    post::tonemap(f32s(src, n * 4), std::slice::from_raw_parts_mut(out, n * 4), exposure, mode);
}

#[no_mangle]
pub extern "C" fn rk_reset_temporal() {
    if let Some(sc) = scene() {
        sc.prev_mean.clear();
        sc.prev_aov.clear();
        sc.prev_w = 0;
        sc.prev_h = 0;
        sc.prev_spp = 0.0;
    }
}

/// Fused zero-copy resolve inside WASM: denoise/mean -> persistent temporal reproject -> tonemap -> RGBA8.
/// Keeps prev_mean & prev_aov resident in WASM RAM across animation frames (eliminates ~74 MB/frame JS copies).
#[no_mangle]
pub unsafe extern "C" fn rk_resolve_frame(
    accum: *const f32,
    aov: *const f32,
    out_rgba: *mut u8,
    w: usize,
    h: usize,
    spp: f32,
    denoise_passes: usize,
    temporal_blend: f32,
    exposure: f32,
    tonemap_mode: u32,
) -> i32 {
    let Some(sc) = scene() else { return -1 };
    let n = w * h;
    if n == 0 || accum.is_null() || aov.is_null() || out_rgba.is_null() {
        return -2;
    }
    let acc_s = f32s(accum, n * 4);
    let aov_s = f32s(aov, n * AOV_STRIDE);
    let mut mean_buf = vec![0.0f32; n * 4];
    if denoise_passes > 0 {
        post::denoise(acc_s, aov_s, &mut mean_buf, w, h, spp, denoise_passes);
    } else {
        post::mean(acc_s, &mut mean_buf, spp);
    }

    let out_slice = std::slice::from_raw_parts_mut(out_rgba, n * 4);
    if temporal_blend > 0.0 {
        let has_prev = sc.prev_w == w && sc.prev_h == h && sc.prev_mean.len() == n * 4 && sc.prev_aov.len() == n * AOV_STRIDE;
        let final_mean = if has_prev {
            let mut reproj = vec![0.0f32; n * 4];
            sc.temporal_reproject(
                &mean_buf,
                aov_s,
                &sc.prev_mean,
                &sc.prev_aov,
                &mut reproj,
                w,
                h,
                spp,
                sc.prev_spp,
                temporal_blend,
            );
            reproj
        } else {
            mean_buf
        };
        post::tonemap(&final_mean, out_slice, exposure, tonemap_mode);
        sc.prev_mean = final_mean;
        sc.prev_aov.clear();
        sc.prev_aov.extend_from_slice(aov_s);
        sc.prev_w = w;
        sc.prev_h = h;
        sc.prev_spp = spp;
    } else {
        post::tonemap(&mean_buf, out_slice, exposure, tonemap_mode);
    }
    0
}

#[no_mangle]
pub unsafe extern "C" fn rk_bake_rows(
    tgt_pos: *const f32,
    tgt_nrm: *const f32,
    tgt_uv: *const f32,
    ntri: usize,
    width: usize,
    height: usize,
    y0: usize,
    y1: usize,
    out_rgba: *mut u8,
    out_cov: *mut u8,
    mode: u32,
    samples: u32,
    max_dist: f32,
    cage_offset: f32,
    bounds_lo: *const f32,
    bounds_hi: *const f32,
) -> i32 {
    let Some(sc) = scene() else { return -1 };
    let y1c = y1.min(height);
    if y1c <= y0 || ntri == 0 || width == 0 {
        return 0;
    }
    let rows = y1c - y0;
    let (bvh_lo, bvh_hi) = sc.bvh.bounds();
    let blo = if bounds_lo.is_null() { bvh_lo } else { v3_at(f32s(bounds_lo, 3), 0) };
    let bhi = if bounds_hi.is_null() { bvh_hi } else { v3_at(f32s(bounds_hi, 3), 0) };
    let nrm_s = if tgt_nrm.is_null() { &[] } else { f32s(tgt_nrm, ntri * 9) };
    bake::bake_rows(
        sc,
        f32s(tgt_pos, ntri * 9),
        nrm_s,
        f32s(tgt_uv, ntri * 6),
        ntri,
        width,
        height,
        y0,
        y1c,
        std::slice::from_raw_parts_mut(out_rgba, rows * width * 4),
        std::slice::from_raw_parts_mut(out_cov, rows * width),
        mode,
        samples,
        max_dist,
        cage_offset,
        blo,
        bhi,
    );
    0
}

#[no_mangle]
pub unsafe extern "C" fn rk_bake_dilate(rgba: *mut u8, cov: *mut u8, width: usize, height: usize, margin: usize) {
    let n = width * height;
    if rgba.is_null() || cov.is_null() || n == 0 { return; }
    bake::dilate_margin(
        std::slice::from_raw_parts_mut(rgba, n * 4),
        std::slice::from_raw_parts_mut(cov, n),
        width,
        height,
        margin,
    );
}

#[no_mangle]
pub unsafe extern "C" fn rk_set_shader_graph(
    mat_idx: usize,
    ops: *const u32,
    n_ops: usize,
    consts: *const f32,
    n_consts: usize,
) -> i32 {
    let Some(sc) = scene() else { return -1 };
    if mat_idx >= sc.shader_progs.len() {
        sc.shader_progs.resize_with(mat_idx + 1, || None);
    }
    if ops.is_null() || n_ops < node_vm::INSTR_STRIDE {
        sc.shader_progs[mat_idx] = None;
        return 0;
    }
    let op_s = std::slice::from_raw_parts(ops, n_ops);
    let const_s = if consts.is_null() || n_consts == 0 { &[] } else { std::slice::from_raw_parts(consts, n_consts) };
    sc.shader_progs[mat_idx] = Some(node_vm::ShaderProgram {
        ops: op_s.to_vec(),
        consts: const_s.to_vec(),
    });
    0
}

#[no_mangle]
pub unsafe extern "C" fn rk_denoise_prep_rows(
    accum: *const f32, aov: *const f32,
    col_out: *mut f32, alb_out: *mut f32, nrm_out: *mut f32,
    w: usize, h: usize, y0: usize, y1: usize, spp: f32,
) {
    let n = w * h;
    post::denoise_prep_rows(
        f32s(accum, n * 4), f32s(aov, n * AOV_STRIDE),
        f32s_mut(col_out, n * 4), f32s_mut(alb_out, n * 4), f32s_mut(nrm_out, n * 4),
        w, h, y0, y1, spp,
    );
}

#[no_mangle]
pub unsafe extern "C" fn rk_denoise_step_rows(
    col_in: *const f32, alb: *const f32, nrm: *const f32, col_out: *mut f32,
    w: usize, h: usize, y0: usize, y1: usize, step: i32, pass_scale_inv2: f32, vertical: u32,
) {
    let n = w * h;
    post::denoise_step_rows(
        f32s(col_in, n * 4), f32s(alb, n * 4), f32s(nrm, n * 4), f32s_mut(col_out, n * 4),
        w, h, y0, y1, step as isize, pass_scale_inv2, vertical != 0,
    );
}

#[no_mangle]
pub unsafe extern "C" fn rk_denoise_remod_rows(
    col: *const f32, alb: *const f32, nrm: *const f32, mean_out: *mut f32,
    w: usize, h: usize, y0: usize, y1: usize,
) {
    let n = w * h;
    post::denoise_remod_rows(
        f32s(col, n * 4), f32s(alb, n * 4), f32s(nrm, n * 4), f32s_mut(mean_out, n * 4),
        w, h, y0, y1,
    );
}

#[no_mangle]
pub unsafe extern "C" fn rk_temporal_reproject_rows(
    cur_mean: *const f32, cur_aov: *const f32, prev_mean: *const f32, prev_aov: *const f32,
    out_mean: *mut f32, w: usize, h: usize, y0: usize, y1: usize, cur_spp: f32, prev_spp: f32, blend: f32,
) -> i32 {
    let Some(sc) = scene() else { return -1 };
    let n = w * h;
    sc.temporal_reproject_rows(
        f32s(cur_mean, n * 4), f32s(cur_aov, n * AOV_STRIDE),
        f32s(prev_mean, n * 4), f32s(prev_aov, n * AOV_STRIDE),
        f32s_mut(out_mean, n * 4), w, h, y0, y1, cur_spp, prev_spp, blend,
    );
    0
}

#[no_mangle]
pub unsafe extern "C" fn rk_tonemap_rows(
    src: *const f32, out: *mut u8, w: usize, h: usize, y0: usize, y1: usize, exposure: f32, mode: u32,
) {
    let n = w * h;
    post::tonemap_rows(f32s(src, n * 4), std::slice::from_raw_parts_mut(out, n * 4), w, h, y0, y1, exposure, mode);
}

/// GPU-aligned BVH2 export for WebGPU Compute Path Tracer (reuses Rust Binned-SAH BVH + O(N) refit!).
#[no_mangle]
pub extern "C" fn rk_bvh_node_count() -> usize {
    scene().map_or(0, |sc| sc.bvh.nodes.len())
}

#[no_mangle]
pub extern "C" fn rk_bvh_tri_count() -> usize {
    scene().map_or(0, |sc| sc.bvh.tris.len())
}

/// Writes `nodes.len() * 8` floats: [min.xyz, bits(a), max.xyz, bits(meta)] (32B GPU-aligned per node).
/// When `shutter > 1e-4` and `prev_tris` exist, computes bottom-up union AABBs covering `[t - shutter, t]`
/// (Cycles linear motion-blurred BVH) so moving/deforming triangles never clip outside leaf bounds.
pub fn export_bvh2_nodes_motion_slice(sc: &Scene, dst: &mut [f32], shutter: f32) -> usize {
    let nodes = &sc.bvh.nodes;
    let n_nodes = nodes.len();
    if n_nodes == 0 || dst.len() < n_nodes * 8 {
        return 0;
    }
    let use_motion = shutter > 1e-4 && sc.prev_tris.len() == sc.bvh.tris.len();
    if !use_motion {
        for (i, n) in nodes.iter().enumerate() {
            let b = i * 8;
            dst[b] = n.min[0];
            dst[b + 1] = n.min[1];
            dst[b + 2] = n.min[2];
            dst[b + 3] = f32::from_bits(n.a);
            dst[b + 4] = n.max[0];
            dst[b + 5] = n.max[1];
            dst[b + 6] = n.max[2];
            dst[b + 7] = f32::from_bits(n.meta);
        }
        return n_nodes;
    }

    let sh = shutter.clamp(0.0, 1.0);
    let mut mins = vec![[0.0f32; 3]; n_nodes];
    let mut maxs = vec![[0.0f32; 3]; n_nodes];
    // Nodes are stored in pre-order (parent index < child indices), so reverse order is exact bottom-up!
    for i in (0..n_nodes).rev() {
        let n = &nodes[i];
        let cnt = (n.meta & 0x3FFF_FFFF) as usize;
        if cnt > 0 {
            let start = n.a as usize;
            let mut lo = [f32::INFINITY; 3];
            let mut hi = [f32::NEG_INFINITY; 3];
            for ti in start..(start + cnt) {
                let ct = &sc.bvh.tris[ti];
                let pt = &sc.prev_tris[ti];
                let c_pts = [ct.p0, ct.p0 + ct.e1, ct.p0 + ct.e2];
                let p_pts = [pt.p0, pt.p0 + pt.e1, pt.p0 + pt.e2];
                for k in 0..3 {
                    let cur = c_pts[k];
                    let prev_sh = cur.lerp(p_pts[k], sh);
                    for v in [cur, prev_sh] {
                        if v.x < lo[0] { lo[0] = v.x; }
                        if v.y < lo[1] { lo[1] = v.y; }
                        if v.z < lo[2] { lo[2] = v.z; }
                        if v.x > hi[0] { hi[0] = v.x; }
                        if v.y > hi[1] { hi[1] = v.y; }
                        if v.z > hi[2] { hi[2] = v.z; }
                    }
                }
            }
            mins[i] = lo;
            maxs[i] = hi;
        } else {
            let li = i + 1;
            let ri = n.a as usize;
            mins[i] = [mins[li][0].min(mins[ri][0]), mins[li][1].min(mins[ri][1]), mins[li][2].min(mins[ri][2])];
            maxs[i] = [maxs[li][0].max(maxs[ri][0]), maxs[li][1].max(maxs[ri][1]), maxs[li][2].max(maxs[ri][2])];
        }
    }
    for i in 0..n_nodes {
        let n = &nodes[i];
        let b = i * 8;
        dst[b] = mins[i][0];
        dst[b + 1] = mins[i][1];
        dst[b + 2] = mins[i][2];
        dst[b + 3] = f32::from_bits(n.a);
        dst[b + 4] = maxs[i][0];
        dst[b + 5] = maxs[i][1];
        dst[b + 6] = maxs[i][2];
        dst[b + 7] = f32::from_bits(n.meta);
    }
    n_nodes
}

#[no_mangle]
pub unsafe extern "C" fn rk_export_bvh2_nodes(out: *mut f32) -> usize {
    let Some(sc) = scene() else { return 0 };
    if out.is_null() { return 0; }
    let n = sc.bvh.nodes.len();
    export_bvh2_nodes_motion_slice(sc, f32s_mut(out, n * 8), 0.0)
}

#[no_mangle]
pub unsafe extern "C" fn rk_export_bvh2_nodes_motion(out: *mut f32, shutter: f32) -> usize {
    let Some(sc) = scene() else { return 0 };
    if out.is_null() { return 0; }
    let n = sc.bvh.nodes.len();
    export_bvh2_nodes_motion_slice(sc, f32s_mut(out, n * 8), shutter)
}

/// Writes BVH-reordered triangles for WebGPU:
/// `out_geom`: ntri*12 floats = [p0.xyz, bits(mat), e1.xyz, uv0.x, e2.xyz, uv0.y]
/// `out_norm`: ntri*12 floats = [n0.xyz, 0, n1.xyz, 0, n2.xyz, 0]
#[no_mangle]
pub unsafe extern "C" fn rk_export_bvh2_tris(out_geom: *mut f32, out_norm: *mut f32) -> usize {
    let Some(sc) = scene() else { return 0 };
    if out_geom.is_null() || out_norm.is_null() { return 0; }
    let tris = &sc.bvh.tris;
    let attrs = &sc.bvh.attrs;
    let dg = f32s_mut(out_geom, tris.len() * 12);
    let dn = f32s_mut(out_norm, tris.len() * 12);
    for i in 0..tris.len() {
        let t = &tris[i];
        let a = &attrs[i];
        let b = i * 12;
        dg[b] = t.p0.x; dg[b + 1] = t.p0.y; dg[b + 2] = t.p0.z; dg[b + 3] = f32::from_bits(a.mat);
        dg[b + 4] = t.e1.x; dg[b + 5] = t.e1.y; dg[b + 6] = t.e1.z; dg[b + 7] = a.uv0[0];
        dg[b + 8] = t.e2.x; dg[b + 9] = t.e2.y; dg[b + 10] = t.e2.z; dg[b + 11] = a.uv0[1];

        dn[b] = a.n0.x; dn[b + 1] = a.n0.y; dn[b + 2] = a.n0.z; dn[b + 3] = a.uv1[0];
        dn[b + 4] = a.n1.x; dn[b + 5] = a.n1.y; dn[b + 6] = a.n1.z; dn[b + 7] = a.uv1[1];
        dn[b + 8] = a.n2.x; dn[b + 9] = a.n2.y; dn[b + 10] = a.n2.z; dn[b + 11] = a.uv2[0];
    }
    tris.len()
}

/// Extended GPU triangle attribute export (20 floats = 5 vec4s per tri):
/// `[n0.xyz, uv1.x,  n1.xyz, uv1.y,  n2.xyz, uv2.x,  tan.xyz, b_sign,  uv2.y, area, 0, 0]`
/// Pairs with `out_geom` (`[p0.xyz, bits(mat), e1.xyz, uv0.x, e2.xyz, uv0.y]`) for full UV + Normal Map TBN on WebGPU.
#[no_mangle]
pub unsafe extern "C" fn rk_export_bvh2_tris_ext(out_geom: *mut f32, out_attr: *mut f32) -> usize {
    let Some(sc) = scene() else { return 0 };
    if out_geom.is_null() || out_attr.is_null() { return 0; }
    let tris = &sc.bvh.tris;
    let attrs = &sc.bvh.attrs;
    let dg = f32s_mut(out_geom, tris.len() * 12);
    let da = f32s_mut(out_attr, tris.len() * 20);
    for i in 0..tris.len() {
        let t = &tris[i];
        let a = &attrs[i];
        let bg = i * 12;
        dg[bg] = t.p0.x; dg[bg + 1] = t.p0.y; dg[bg + 2] = t.p0.z; dg[bg + 3] = f32::from_bits(a.mat);
        dg[bg + 4] = t.e1.x; dg[bg + 5] = t.e1.y; dg[bg + 6] = t.e1.z; dg[bg + 7] = a.uv0[0];
        dg[bg + 8] = t.e2.x; dg[bg + 9] = t.e2.y; dg[bg + 10] = t.e2.z; dg[bg + 11] = a.uv0[1];

        let ba = i * 20;
        let em_idx = sc.tri_to_emissive.get(i).copied().unwrap_or(-1);
        let em_area_pdf = if em_idx >= 0 && sc.emissive_total > 1e-12 && a.area > 1e-9 {
            sc.emissive_power[em_idx as usize] / (sc.emissive_total * a.area)
        } else {
            0.0
        };
        da[ba] = a.n0.x; da[ba + 1] = a.n0.y; da[ba + 2] = a.n0.z; da[ba + 3] = a.uv1[0];
        da[ba + 4] = a.n1.x; da[ba + 5] = a.n1.y; da[ba + 6] = a.n1.z; da[ba + 7] = a.uv1[1];
        da[ba + 8] = a.n2.x; da[ba + 9] = a.n2.y; da[ba + 10] = a.n2.z; da[ba + 11] = a.uv2[0];
        da[ba + 12] = a.tangent.x; da[ba + 13] = a.tangent.y; da[ba + 14] = a.tangent.z; da[ba + 15] = a.b_sign;
        da[ba + 16] = a.uv2[1]; da[ba + 17] = a.area; da[ba + 18] = em_area_pdf; da[ba + 19] = 0.0;
    }
    tris.len()
}

/// Number of emissive triangles available for GPU Emissive Mesh NEE.
#[no_mangle]
pub extern "C" fn rk_emissive_count() -> usize {
    scene().map_or(0, |sc| if sc.emissive_total > 1e-12 { sc.emissive_tris.len() } else { 0 })
}

/// Exports `count * 4` floats: `[bits(triIdx), cdfNorm, areaPdf, 0.0]` for WebGPU Emissive Mesh NEE + MIS.
#[no_mangle]
pub unsafe extern "C" fn rk_export_emissive_cdf(out: *mut f32) -> usize {
    let Some(sc) = scene() else { return 0 };
    let n = sc.emissive_tris.len();
    if n == 0 || sc.emissive_total <= 1e-12 || out.is_null() {
        return 0;
    }
    let dst = f32s_mut(out, n * 4);
    let inv_total = 1.0 / sc.emissive_total;
    for i in 0..n {
        let ti = sc.emissive_tris[i];
        let area = sc.bvh.attrs[ti as usize].area.max(1e-9);
        let cdf_norm = (sc.emissive_cdf[i + 1] * inv_total).clamp(0.0, 1.0);
        let area_pdf = (sc.emissive_power[i] * inv_total) / area;
        let b = i * 4;
        dst[b] = f32::from_bits(ti);
        dst[b + 1] = if i + 1 == n { 1.0 } else { cdf_norm };
        dst[b + 2] = area_pdf;
        dst[b + 3] = 0.0;
    }
    n
}

/// Returns 1 if previous-frame BVH triangles exist (after refit) for per-vertex GPU motion vectors & blur.
#[no_mangle]
pub extern "C" fn rk_has_prev_tris() -> u32 {
    scene().map_or(0, |sc| if !sc.prev_tris.is_empty() && sc.prev_tris.len() == sc.bvh.tris.len() { 1 } else { 0 })
}

/// Exports previous-frame BVH-ordered triangles (`ntri * 12` floats = 3 vec4s per tri: `[p0.xyz, 0, e1.xyz, 0, e2.xyz, 0]`).
#[no_mangle]
pub unsafe extern "C" fn rk_export_prev_bvh2_tris(out_prev: *mut f32) -> usize {
    let Some(sc) = scene() else { return 0 };
    if out_prev.is_null() || sc.prev_tris.len() != sc.bvh.tris.len() || sc.prev_tris.is_empty() {
        return 0;
    }
    let dst = f32s_mut(out_prev, sc.prev_tris.len() * 12);
    for (i, t) in sc.prev_tris.iter().enumerate() {
        let b = i * 12;
        dst[b] = t.p0.x; dst[b + 1] = t.p0.y; dst[b + 2] = t.p0.z; dst[b + 3] = 0.0;
        dst[b + 4] = t.e1.x; dst[b + 5] = t.e1.y; dst[b + 6] = t.e1.z; dst[b + 7] = 0.0;
        dst[b + 8] = t.e2.x; dst[b + 9] = t.e2.y; dst[b + 10] = t.e2.z; dst[b + 11] = 0.0;
    }
    sc.prev_tris.len()
}

/// Writes HDRI width & height into `out_wh[2]`. Returns 1 if HDRI CDF is ready, 0 otherwise.
#[no_mangle]
pub unsafe extern "C" fn rk_env_dims(out_wh: *mut u32) -> u32 {
    let Some(sc) = scene() else { return 0 };
    if !sc.env.has_image() { return 0; }
    if !out_wh.is_null() {
        let dst = std::slice::from_raw_parts_mut(out_wh, 2);
        dst[0] = sc.env.w as u32;
        dst[1] = sc.env.h as u32;
    }
    1
}

/// Exports 1D row CDF (`h` floats) and 2D interleaved `[col_cdf, solid_angle_pdf]` (`w * h * 2` floats).
#[no_mangle]
pub unsafe extern "C" fn rk_export_env_cdf(out_row_cdf: *mut f32, out_col_cdf_pdf: *mut f32) -> u32 {
    let Some(sc) = scene() else { return 0 };
    if !sc.env.has_image() || out_row_cdf.is_null() || out_col_cdf_pdf.is_null() {
        return 0;
    }
    let w = sc.env.w;
    let h = sc.env.h;
    if sc.env.export_cdf(f32s_mut(out_row_cdf, h), f32s_mut(out_col_cdf_pdf, w * h * 2)) {
        1
    } else {
        0
    }
}

#[no_mangle]
pub extern "C" fn rk_version() -> u32 {
    5
}

#[cfg(test)]
mod tests {
    use super::*;

    fn quad(y: f32, s: f32, mat: u32) -> (Vec<TriGeom>, Vec<TriAttr>) {
        let (a, b, c, d) = (v3(-s, y, -s), v3(s, y, -s), v3(s, y, s), v3(-s, y, s));
        let n = v3(0.0, 1.0, 0.0);
        let mk = |p0: V3, p1: V3, p2: V3, uv0: [f32; 2], uv1: [f32; 2], uv2: [f32; 2]| {
            let e1 = p1 - p0;
            let e2 = p2 - p0;
            let area = 0.5 * e1.cross(e2).len();
            let (tangent, b_sign) = compute_tangent(e1, e2, uv0, uv1, uv2, n);
            (
                TriGeom { p0, e1, e2 },
                TriAttr { n0: n, n1: n, n2: n, uv0, uv1, uv2, tangent, b_sign, mat, area },
            )
        };
        let t1 = mk(a, d, c, [0.0, 0.0], [0.0, 1.0], [1.0, 1.0]);
        let t2 = mk(a, c, b, [0.0, 0.0], [1.0, 1.0], [1.0, 0.0]);
        (vec![t1.0, t2.0], vec![t1.1, t2.1])
    }

    fn sphere(center: V3, radius: f32, mat: u32) -> (Vec<TriGeom>, Vec<TriAttr>) {
        let (nu, nv) = (24, 12);
        let mut tris = Vec::new();
        let mut attrs = Vec::new();
        let pt = |iu: usize, iv: usize| -> (V3, V3) {
            let u = iu as f32 / nu as f32 * 2.0 * PI;
            let v = iv as f32 / nv as f32 * PI;
            let n = v3(v.sin() * u.cos(), v.cos(), v.sin() * u.sin());
            (center + n * radius, n)
        };
        let mut push = |p0: V3, p1: V3, p2: V3, n0: V3, n1: V3, n2: V3| {
            let e1 = p1 - p0;
            let e2 = p2 - p0;
            let area = 0.5 * e1.cross(e2).len();
            if area > 1e-10 {
                tris.push(TriGeom { p0, e1, e2 });
                attrs.push(TriAttr { n0, n1, n2, uv0: [0.0, 0.0], uv1: [1.0, 0.0], uv2: [0.0, 1.0], tangent: V3::ZERO, b_sign: 1.0, mat, area });
            }
        };
        for iv in 0..nv {
            for iu in 0..nu {
                let (p00, n00) = pt(iu, iv);
                let (p10, n10) = pt(iu + 1, iv);
                let (p01, n01) = pt(iu, iv + 1);
                let (p11, n11) = pt(iu + 1, iv + 1);
                push(p00, p01, p11, n00, n01, n11);
                push(p00, p11, p10, n00, n11, n10);
            }
        }
        (tris, attrs)
    }

    #[test]
    fn bvh_node_is_32_bytes_and_matches_brute_force() {
        assert_eq!(std::mem::size_of::<Node>(), 32);
        let mut r = Rng::new(1, 2, 3);
        let mut tris = vec![];
        let mut attrs = vec![];
        for _ in 0..500 {
            let c = v3(r.f() * 10.0, r.f() * 10.0, r.f() * 10.0);
            let a = c + v3(r.f(), r.f(), r.f());
            let b = c + v3(r.f(), r.f(), r.f());
            let e1 = a - c;
            let e2 = b - c;
            tris.push(TriGeom { p0: c, e1, e2 });
            attrs.push(TriAttr { n0: V3::ZERO, n1: V3::ZERO, n2: V3::ZERO, uv0: [0.0; 2], uv1: [0.0; 2], uv2: [0.0; 2], tangent: V3::ZERO, b_sign: 1.0, mat: 0, area: 0.5 * e1.cross(e2).len() });
        }
        let bvh = Bvh::build(tris.clone(), attrs.clone());
        for _ in 0..300 {
            let o = v3(r.f() * 10.0, r.f() * 10.0, -3.0);
            let d = v3(r.f() - 0.5, r.f() - 0.5, 1.0).norm();
            let fast = bvh.intersect(o, d, f32::INFINITY).map(|h| h.t);
            let mut best: Option<f32> = None;
            for (t, a) in tris.iter().zip(attrs.iter()) {
                let single = Bvh::build(vec![*t], vec![*a]);
                if let Some(h) = single.intersect(o, d, f32::INFINITY) {
                    if best.map_or(true, |b| h.t < b) { best = Some(h.t); }
                }
            }
            match (fast, best) {
                (Some(a), Some(b)) => assert!((a - b).abs() < 1e-3),
                (None, None) => {}
                _ => panic!("hit mismatch"),
            }
            assert_eq!(bvh.occluded(o, d, f32::INFINITY), best.is_some());
        }
    }

    #[test]
    fn bvh_refit_updates_moved_geometry() {
        let pos0 = vec![-1.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0];
        let (tris, attrs) = build_tris_and_attrs(&pos0, &[], &[], &[0], 1);
        let mut sc = Scene::new(tris, attrs, vec![Material::default()], vec![]);
        assert!(sc.bvh.intersect(v3(0.0, 0.2, 2.0), v3(0.0, 0.0, -1.0), 100.0).is_some());
        let pos1 = vec![9.0, 0.0, 0.0, 11.0, 0.0, 0.0, 10.0, 1.0, 0.0];
        sc.refit(&pos1, &[]);
        assert!(sc.bvh.intersect(v3(0.0, 0.2, 2.0), v3(0.0, 0.0, -1.0), 100.0).is_none());
        assert!(sc.bvh.intersect(v3(10.0, 0.2, 2.0), v3(0.0, 0.0, -1.0), 100.0).is_some());
    }

    #[test]
    fn white_furnace_diffuse_and_glass_are_energy_conserving() {
        let (t_q, a_q) = quad(0.0, 50.0, 0);
        let mut sc = Scene::new(t_q, a_q, vec![Material { base: V3::ONE, metal: 0.0, rough: 1.0, ..Material::default() }], vec![]);
        sc.env = Env::sky(1.0, V3::ONE, V3::ONE, V3::ONE);
        sc.cam.origin = v3(0.0, 2.0, 0.0);
        sc.cam.fwd = v3(0.0, -1.0, 0.0);
        sc.cam.right = v3(0.1, 0.0, 0.0);
        sc.cam.up = v3(0.0, 0.0, 0.1);
        let (w, h) = (8, 8);
        let (mut a, mut g) = (vec![0.0; w * h * 4], vec![0.0; w * h * AOV_STRIDE]);
        let p = RenderParams { spp: 128, seed: 7, max_bounces: 4, clamp: 1e9, adaptive_threshold: 0.0 };
        sc.render_rows(&mut a, &mut g, w, h, 0, h, 0, &p);
        let m: f32 = (0..w * h).map(|i| a[i * 4]).sum::<f32>() / (w * h) as f32 / 128.0;
        assert!(m > 0.85 && m < 1.05, "diffuse furnace mean {m}");

        // Glass sphere under uniform white sky: clear glass preserves ~1.0 radiance!
        let (t_s, a_s) = sphere(v3(0.0, 0.0, 0.0), 1.0, 0);
        let mut gs = Scene::new(t_s, a_s, vec![Material { base: V3::ONE, metal: 0.0, rough: 0.02, trans: 1.0, ior: 1.5, ..Material::default() }], vec![]);
        gs.env = Env::sky(1.0, V3::ONE, V3::ONE, V3::ONE);
        gs.cam.origin = v3(0.0, 0.0, 3.0);
        gs.cam.fwd = v3(0.0, 0.0, -1.0);
        gs.cam.right = v3(0.3, 0.0, 0.0);
        gs.cam.up = v3(0.0, 0.3, 0.0);
        let (mut ga, mut gg) = (vec![0.0; w * h * 4], vec![0.0; w * h * AOV_STRIDE]);
        let gp = RenderParams { spp: 64, seed: 5, max_bounces: 8, clamp: 1e9, adaptive_threshold: 0.0 };
        gs.render_rows(&mut ga, &mut gg, w, h, 0, h, 0, &gp);
        let gm: f32 = (0..w * h).map(|i| ga[i * 4]).sum::<f32>() / (w * h) as f32 / 64.0;
        assert!(gm > 0.90 && gm < 1.05, "glass furnace mean {gm}");
    }

    #[test]
    fn deterministic_and_row_tiling_equal() {
        let (t_q, a_q) = quad(0.0, 5.0, 0);
        let mut sc = Scene::new(t_q, a_q, vec![], vec![Light { kind: 0, pos: v3(0.0, 3.0, 0.0), color: V3::splat(30.0), dir: V3::ZERO, radius: 0.3, param0: 0.0, param1: 0.0, area_u: V3::ZERO }]);
        sc.cam.origin = v3(0.0, 2.0, 4.0);
        sc.cam.fwd = v3(0.0, -0.3, -1.0).norm();
        sc.cam.right = v3(0.6, 0.0, 0.0);
        sc.cam.up = v3(0.0, 0.6, 0.0);
        let (w, h) = (16, 12);
        let p = RenderParams { spp: 16, seed: 3, max_bounces: 3, clamp: 100.0, adaptive_threshold: 0.02 };
        let (mut a1, mut g1) = (vec![0.0; w * h * 4], vec![0.0; w * h * AOV_STRIDE]);
        sc.render_rows(&mut a1, &mut g1, w, h, 0, h, 0, &p);
        let (mut a2, mut g2) = (vec![0.0; w * h * 4], vec![0.0; w * h * AOV_STRIDE]);
        sc.render_rows(&mut a2, &mut g2, w, h, 0, 5, 0, &p);
        sc.render_rows(&mut a2, &mut g2, w, h, 5, h, 0, &p);
        assert_eq!(a1, a2);
    }

    #[test]
    fn spot_and_rect_area_and_emissive_lights_work() {
        let (t_q, a_q) = quad(0.0, 5.0, 0);
        let spot = Light {
            kind: 2, pos: v3(0.0, 3.0, 0.0), color: V3::splat(30.0),
            dir: v3(0.0, -1.0, 0.0), radius: 0.0,
            param0: 0.8, param1: 0.95, area_u: V3::ZERO,
        };
        let mut sc = Scene::new(t_q.clone(), a_q.clone(), vec![Material::default()], vec![spot]);
        sc.env = Env::sky(0.0, V3::ZERO, V3::ZERO, V3::ZERO);
        sc.cam.origin = v3(0.0, 2.0, 4.0);
        sc.cam.fwd = v3(0.0, -0.4, -1.0).norm();
        sc.cam.right = v3(1.2, 0.0, 0.0);
        sc.cam.up = v3(0.0, 0.9, 0.0);
        let (w, h) = (16, 12);
        let (mut a, mut g) = (vec![0.0; w * h * 4], vec![0.0; w * h * AOV_STRIDE]);
        let p = RenderParams { spp: 8, seed: 1, max_bounces: 2, clamp: 100.0, adaptive_threshold: 0.0 };
        sc.render_rows(&mut a, &mut g, w, h, 0, h, 0, &p);
        let center_lum = a[(6 * w + 8) * 4];
        let corner_lum = a[0];
        assert!(center_lum > corner_lum * 3.0 && center_lum > 0.1, "spot center {center_lum} vs corner {corner_lum}");

        // RectAreaLight
        let area_l = Light {
            kind: 3, pos: v3(0.0, 2.5, 0.0), color: V3::splat(5.0),
            dir: v3(0.0, -1.0, 0.0), radius: 0.0,
            param0: 1.0, param1: 1.0, area_u: v3(1.0, 0.0, 0.0),
        };
        let mut sc2 = Scene::new(t_q, a_q, vec![Material::default()], vec![area_l]);
        sc2.env = Env::sky(0.0, V3::ZERO, V3::ZERO, V3::ZERO);
        sc2.cam = sc.cam;
        let (mut a2, mut g2) = (vec![0.0; w * h * 4], vec![0.0; w * h * AOV_STRIDE]);
        sc2.render_rows(&mut a2, &mut g2, w, h, 0, h, 0, &p);
        assert!(a2[(6 * w + 8) * 4] > 0.1);
    }

    #[test]
    fn temporal_reprojection_tracks_motion_and_reduces_noise() {
        let mut pos0 = Vec::new();
        let mut nrm0 = Vec::new();
        let ids = vec![0u32, 0u32];
        for tri in [
            [v3(-1.0, -1.0, 0.0), v3(1.0, -1.0, 0.0), v3(1.0, 1.0, 0.0)],
            [v3(-1.0, -1.0, 0.0), v3(1.0, 1.0, 0.0), v3(-1.0, 1.0, 0.0)],
        ] {
            for p in tri {
                pos0.extend_from_slice(&[p.x, p.y, p.z]);
                nrm0.extend_from_slice(&[0.0, 0.0, 1.0]);
            }
        }
        let (tris, attrs) = build_tris_and_attrs(&pos0, &nrm0, &[], &ids, 2);
        let mut sc = Scene::new(
            tris,
            attrs,
            vec![Material { base: v3(0.7, 0.7, 0.7), rough: 0.9, ..Material::default() }],
            vec![Light { kind: 0, pos: v3(0.0, 0.0, 3.0), color: V3::splat(25.0), dir: V3::ZERO, radius: 0.3, param0: 0.0, param1: 0.0, area_u: V3::ZERO }],
        );
        sc.cam = Camera {
            origin: v3(0.0, 0.0, 3.0), fwd: v3(0.0, 0.0, -1.0),
            right: v3(1.5, 0.0, 0.0), up: v3(0.0, 1.5, 0.0),
            aperture: 0.0, focus: 3.0, ortho: false, shutter: 0.0,
        };
        let (w, h) = (32usize, 32usize);
        let (mut a0, mut g0) = (vec![0.0; w * h * 4], vec![0.0; w * h * AOV_STRIDE]);
        sc.render_rows(&mut a0, &mut g0, w, h, 0, h, 0, &RenderParams { spp: 4, seed: 1, max_bounces: 2, clamp: 20.0, adaptive_threshold: 0.0 });
        let mut m0 = vec![0.0; w * h * 4];
        post::mean(&a0, &mut m0, 4.0);

        // Move quad by +0.3 in X for frame 1 and refit.
        let pos1: Vec<f32> = pos0.chunks_exact(3).flat_map(|p| [p[0] + 0.3, p[1], p[2]]).collect();
        sc.refit(&pos1, &nrm0);
        let (mut a1, mut g1) = (vec![0.0; w * h * 4], vec![0.0; w * h * AOV_STRIDE]);
        sc.render_rows(&mut a1, &mut g1, w, h, 0, h, 0, &RenderParams { spp: 4, seed: 2, max_bounces: 2, clamp: 20.0, adaptive_threshold: 0.0 });
        let mut m1 = vec![0.0; w * h * 4];
        post::mean(&a1, &mut m1, 4.0);
        let mut m1_t = vec![0.0; w * h * 4];
        sc.temporal_reproject(&m1, &g1, &m0, &g0, &mut m1_t, w, h, 4.0, 4.0, 0.75);

        // Temporal result stays lit on the moved quad and differs from static copy.
        let center_c = m1_t[(16 * w + 18) * 4];
        assert!(center_c > 0.2 && center_c.is_finite(), "temporal center {center_c}");
        assert_ne!(m1, m1_t);
    }

    #[test]
    fn denoiser_reduces_noise() {
        let (w, h) = (32, 32);
        let mut r = Rng::new(9, 9, 9);
        let mut a = vec![0.0f32; w * h * 4];
        let mut g = vec![0.0f32; w * h * AOV_STRIDE];
        for i in 0..w * h {
            let v = 0.5 + (r.f() - 0.5) * 0.8;
            a[i * 4] = v; a[i * 4 + 1] = v; a[i * 4 + 2] = v; a[i * 4 + 3] = 1.0;
            g[i * AOV_STRIDE] = 1.0; g[i * AOV_STRIDE + 1] = 1.0; g[i * AOV_STRIDE + 2] = 1.0;
            g[i * AOV_STRIDE + 4] = 1.0;
            g[i * AOV_STRIDE + 6] = v * v;
            g[i * AOV_STRIDE + 7] = 0.8;
        }
        let mut out = vec![0.0; w * h * 4];
        post::denoise(&a, &g, &mut out, w, h, 1.0, 4);
        let var = |s: &dyn Fn(usize) -> f32| { let m: f32 = (0..w * h).map(s).sum::<f32>() / (w * h) as f32; (0..w * h).map(|i| (s(i) - m).powi(2)).sum::<f32>() / (w * h) as f32 };
        assert!(var(&|i| out[i * 4]) < var(&|i| a[i * 4]) * 0.25);
    }

    #[test]
    fn bake_ao_normal_position_and_dilation() {
        // Build L-corner: horizontal floor quad at y=0 and vertical blocker wall at x=0
        let pos: Vec<f32> = vec![
            // Floor quad [0..2]x[-1..1] at y=0
            0.0, 0.0, -1.0,  2.0, 0.0, -1.0,  2.0, 0.0, 1.0,
            0.0, 0.0, -1.0,  2.0, 0.0, 1.0,   0.0, 0.0, 1.0,
            // Vertical wall x=0, y=[0..2]
            0.0, 0.0, -1.0,  0.0, 0.0, 1.0,   0.0, 2.0, 1.0,
            0.0, 0.0, -1.0,  0.0, 2.0, 1.0,   0.0, 2.0, -1.0,
        ];
        let nrm: Vec<f32> = vec![
            0.0, 1.0, 0.0,  0.0, 1.0, 0.0,  0.0, 1.0, 0.0,
            0.0, 1.0, 0.0,  0.0, 1.0, 0.0,  0.0, 1.0, 0.0,
            1.0, 0.0, 0.0,  1.0, 0.0, 0.0,  1.0, 0.0, 0.0,
            1.0, 0.0, 0.0,  1.0, 0.0, 0.0,  1.0, 0.0, 0.0,
        ];
        let uvs: Vec<f32> = vec![
            // Floor maps into left half U [0.05..0.45], V [0.1..0.9]
            0.05, 0.1,  0.45, 0.1,  0.45, 0.9,
            0.05, 0.1,  0.45, 0.9,  0.05, 0.9,
            // Wall maps into right half U [0.55..0.95], V [0.1..0.9]
            0.55, 0.1,  0.95, 0.1,  0.95, 0.9,
            0.55, 0.1,  0.95, 0.9,  0.55, 0.9,
        ];
        let ids = vec![0u32; 4];
        let (tris, attrs) = build_tris_and_attrs(&pos, &nrm, &uvs, &ids, 4);
        let sc = Scene::new(tris, attrs, vec![Material::default()], vec![]);

        let (w, h) = (32usize, 32usize);
        let mut rgba = vec![0u8; w * h * 4];
        let mut cov = vec![0u8; w * h];
        let (blo, bhi) = sc.bvh.bounds();
        bake::bake_rows(&sc, &pos, &nrm, &uvs, 4, w, h, 0, h, &mut rgba, &mut cov, bake::BAKE_AO, 32, 3.0, 0.0, blo, bhi);

        // Floor pixel near wall (x = 3 -> u ~ 0.11 near x=0 corner) must be darker than open end (x = 13 -> u ~ 0.42)
        let py = 16;
        let corner_ao = rgba[(py * w + 3) * 4];
        let open_ao = rgba[(py * w + 13) * 4];
        assert!(corner_ao < open_ao, "corner AO {corner_ao} should be darker than open AO {open_ao}");

        // Tangent normal self-bake yields flat ~128,128,255
        let mut tn_rgba = vec![0u8; w * h * 4];
        let mut tn_cov = vec![0u8; w * h];
        bake::bake_rows(&sc, &pos, &nrm, &uvs, 4, w, h, 0, h, &mut tn_rgba, &mut tn_cov, bake::BAKE_NORMAL_TANGENT, 1, 1.0, 0.0, blo, bhi);
        let center_n = &tn_rgba[(py * w + 8) * 4..(py * w + 8) * 4 + 4];
        assert!((center_n[0] as i32 - 128).abs() <= 4 && (center_n[1] as i32 - 128).abs() <= 4 && center_n[2] >= 250);

        // Test margin dilation fills pixel immediately outside island border (gy=1, cov was 0 before dilate)
        assert_eq!(cov[0], 0);
        bake::dilate_margin(&mut rgba, &mut cov, w, h, 4);
        assert_eq!(cov[2 * w + 8], 1);
    }

    #[test]
    fn shader_node_vm_evaluates_noise_ramp_bump_fresnel() {
        // Build: UV -> Noise -> ColorRamp -> BaseColor + Noise -> Bump -> Normal + Fresnel -> Roughness
        use crate::node_vm::*;
        let ops: Vec<u32> = vec![
            // 0: OP_UV -> r0
            OP_UV, 0, 0, 0, 0, 0, 0, 0,
            // 1: OP_NOISE (arg0=r0, fOff=0 -> scale=4, detail=3, rough=0.5, seed=7) -> r1
            OP_NOISE, 1, 0, 0, 0, 0, 0, 0,
            // 2: OP_COLOR_RAMP (arg0=r1, fOff=4 -> 1+10 floats: 2 stops, flags=2) -> r2
            OP_COLOR_RAMP, 2, 1, 0, 0, 0, 4, 2,
            // 3: OP_FRESNEL (arg0=NO_REG, fOff=15 -> ior=1.5) -> r3
            OP_FRESNEL, 3, NO_REG, 0, 0, 0, 15, 0,
            // 4: OP_BUMP (arg0=r1, arg1=NO_REG, arg2=4 (height eval up to 4), fOff=16 -> str=0.8, dist=0.2, h0_fb=0) -> r4
            OP_BUMP, 4, 1, NO_REG, 4, 0, 16, 0,
            // 5: OP_SET_OUT baseColor = r2 (flags=0)
            OP_SET_OUT, 0, 2, 0, 0, 0, 0, 0,
            // 6: OP_SET_OUT roughness = r3 (flags=2)
            OP_SET_OUT, 0, 3, 0, 0, 0, 0, 2,
            // 7: OP_SET_OUT normal = r4 (flags=4)
            OP_SET_OUT, 0, 4, 0, 0, 0, 0, 4,
        ];
        let consts: Vec<f32> = vec![
            // 0..4: noise
            4.0, 3.0, 0.5, 7.0,
            // 4..15: color ramp placeholder + 2 stops
            0.0,
            0.0, 0.1, 0.2, 0.9, 1.0,
            1.0, 0.9, 0.3, 0.1, 1.0,
            // 15: fresnel ior
            1.5,
            // 16..19: bump strength, dist, fallback
            0.8, 0.2, 0.0,
        ];
        let prog = ShaderProgram { ops, consts };
        let tex = TexStore::new();
        let ns = v3(0.0, 1.0, 0.0);
        let t1 = v3(1.0, 0.0, 0.0);
        let t2 = v3(0.0, 0.0, 1.0);
        let view_dir = v3(0.0, 0.6, 0.8).norm();
        let out_a = eval_graph(&prog, 0.15, 0.25, 0.15, 0.25, ns, t1, t2, view_dir, &tex).unwrap();
        let out_b = eval_graph(&prog, 0.65, 0.75, 0.65, 0.75, ns, t1, t2, view_dir, &tex).unwrap();
        assert!(out_a.has_base && out_a.has_rough && out_a.has_normal);
        assert!((out_a.base - out_b.base).len() > 1e-4, "procedural noise+ramp must vary across UV");
        assert!(out_a.normal.y > 0.5 && out_a.normal.is_finite());
        assert!(out_a.rough > 0.04 && out_a.rough < 1.0);
    }

    #[test]
    fn camera_shutter_motion_blur_blends_between_frames() {
        // Small emissive white square at x=0, black background
        let mut pos = Vec::new();
        let mut nrm = Vec::new();
        let a = v3(-0.3, -0.3, 0.0);
        let b = v3(0.3, -0.3, 0.0);
        let c = v3(0.3, 0.3, 0.0);
        let d = v3(-0.3, 0.3, 0.0);
        for tri in [[a, b, c], [a, c, d]] {
            for p in tri {
                pos.extend_from_slice(&[p.x, p.y, p.z]);
                nrm.extend_from_slice(&[0.0, 0.0, 1.0]);
            }
        }
        let (tris, attrs) = build_tris_and_attrs(&pos, &nrm, &[], &[0, 0], 2);
        let mut sc = Scene::new(
            tris,
            attrs,
            vec![Material { base: V3::ZERO, emit: V3::splat(2.0), ..Material::default() }],
            vec![],
        );
        sc.env = Env::sky(0.0, V3::ZERO, V3::ZERO, V3::ZERO);
        sc.bg_mode = 1;
        sc.bg = V3::ZERO;
        sc.cam = Camera {
            origin: v3(0.0, 0.0, 3.0), fwd: v3(0.0, 0.0, -1.0),
            right: v3(1.5, 0.0, 0.0), up: v3(0.0, 1.5, 0.0),
            aperture: 0.0, focus: 3.0, ortho: false, shutter: 0.0,
        };
        // Refit captures prev_cam = origin (0,0,3); then move camera to x=1.0
        sc.refit(&pos, &nrm);
        sc.cam.origin = v3(1.0, 0.0, 3.0);

        let (w, h) = (32usize, 16usize);
        let params = RenderParams { spp: 32, seed: 1, max_bounces: 1, clamp: 20.0, adaptive_threshold: 0.0 };

        // Sharp frame (shutter = 0): center pixel (x=16, y=8) looks at x=1.0 -> misses square at x=0!
        sc.cam.shutter = 0.0;
        let (mut a_sharp, mut g_sharp) = (vec![0.0; w * h * 4], vec![0.0; w * h * AOV_STRIDE]);
        sc.render_rows(&mut a_sharp, &mut g_sharp, w, h, 0, h, 0, &params);
        let center_sharp = a_sharp[(8 * w + 16) * 4] / 32.0;

        // Motion-blurred frame (shutter = 1.0): rays sweep camera x in [0.0..1.0], hitting the square!
        sc.cam.shutter = 1.0;
        let (mut a_blur, mut g_blur) = (vec![0.0; w * h * 4], vec![0.0; w * h * AOV_STRIDE]);
        sc.render_rows(&mut a_blur, &mut g_blur, w, h, 0, h, 0, &params);
        let center_blur = a_blur[(8 * w + 16) * 4] / 32.0;

        assert!(center_sharp < 0.05, "sharp center should miss emissive square: {center_sharp}");
        assert!(center_blur > 0.08, "motion-blurred center should pick up trail from prev_cam: {center_blur}");
    }

    #[test]
    fn row_sliced_denoise_matches_full_frame_denoise() {
        let (w, h) = (24usize, 16usize);
        let n = w * h;
        let mut rng = Rng::new(11, 22, 33);
        let mut accum = vec![0.0f32; n * 4];
        let mut aov = vec![0.0f32; n * AOV_STRIDE];
        let spp = 8.0f32;
        for i in 0..n {
            let v = (0.5 + (rng.f() - 0.5) * 0.4) * spp;
            accum[i * 4] = v; accum[i * 4 + 1] = v * 0.8; accum[i * 4 + 2] = v * 0.6; accum[i * 4 + 3] = spp;
            aov[i * AOV_STRIDE] = 0.7 * spp; aov[i * AOV_STRIDE + 1] = 0.7 * spp; aov[i * AOV_STRIDE + 2] = 0.7 * spp;
            aov[i * AOV_STRIDE + 3] = 0.0; aov[i * AOV_STRIDE + 4] = spp; aov[i * AOV_STRIDE + 5] = 0.0;
            aov[i * AOV_STRIDE + 6] = (v / spp) * (v / spp) * spp;
            aov[i * AOV_STRIDE + 7] = 0.5 * spp;
        }
        let mut full = vec![0.0f32; n * 4];
        post::denoise(&accum, &aov, &mut full, w, h, spp, 3);

        let mut col = vec![0.0f32; n * 4];
        let mut tmp = vec![0.0f32; n * 4];
        let mut alb = vec![0.0f32; n * 4];
        let mut nrm = vec![0.0f32; n * 4];
        let mut sliced = vec![0.0f32; n * 4];
        for (y0, y1) in [(0, 6), (6, 11), (11, h)] {
            post::denoise_prep_rows(&accum, &aov, &mut col, &mut alb, &mut nrm, w, h, y0, y1, spp);
        }
        let mut scale_inv2 = 1.0f32;
        for p in 0..3 {
            let step = 1isize << p;
            for (y0, y1) in [(0, 6), (6, 11), (11, h)] {
                post::denoise_step_rows(&col, &alb, &nrm, &mut tmp, w, h, y0, y1, step, scale_inv2, false);
            }
            for (y0, y1) in [(0, 6), (6, 11), (11, h)] {
                post::denoise_step_rows(&tmp, &alb, &nrm, &mut col, w, h, y0, y1, step, scale_inv2, true);
            }
            scale_inv2 *= 2.8;
        }
        for (y0, y1) in [(0, 6), (6, 11), (11, h)] {
            post::denoise_remod_rows(&col, &alb, &nrm, &mut sliced, w, h, y0, y1);
        }
        for i in 0..n * 4 {
            assert!((full[i] - sliced[i]).abs() < 1e-5, "mismatch at {i}: full={} sliced={}", full[i], sliced[i]);
        }
    }

    #[test]
    fn multiscatter_ggx_rough_metal_conserves_energy_and_env_cdf_valid() {
        // Rough white metal under uniform white sky: multi-scattering GGX prevents dark energy loss!
        let (t_q, a_q) = quad(0.0, 50.0, 0);
        let mut sc = Scene::new(
            t_q,
            a_q,
            vec![Material { base: V3::ONE, metal: 1.0, rough: 0.9, ..Material::default() }],
            vec![],
        );
        sc.env = Env::sky(1.0, V3::ONE, V3::ONE, V3::ONE);
        sc.cam.origin = v3(0.0, 2.0, 0.0);
        sc.cam.fwd = v3(0.0, -1.0, 0.0);
        sc.cam.right = v3(0.1, 0.0, 0.0);
        sc.cam.up = v3(0.0, 0.0, 0.1);
        let (w, h) = (8, 8);
        let (mut a, mut g) = (vec![0.0; w * h * 4], vec![0.0; w * h * AOV_STRIDE]);
        let p = RenderParams { spp: 128, seed: 9, max_bounces: 4, clamp: 1e9, adaptive_threshold: 0.0 };
        sc.render_rows(&mut a, &mut g, w, h, 0, h, 0, &p);
        let m: f32 = (0..w * h).map(|i| a[i * 4]).sum::<f32>() / (w * h) as f32 / 128.0;
        assert!(m > 0.80 && m < 1.15, "rough metal multi-scatter furnace mean {m}");

        // 2D HDRI CDF export must be monotonic [0..1] with positive solid-angle PDFs
        let (ew, eh) = (16usize, 8usize);
        let mut hdr = vec![0.1f32; ew * eh * 3];
        // Bright sun spot at (x=12, y=2)
        let sun = (2 * ew + 12) * 3;
        hdr[sun] = 50.0; hdr[sun + 1] = 45.0; hdr[sun + 2] = 40.0;
        let mut env = Env::sky(1.0, V3::ONE, V3::ONE, V3::ONE);
        env.set_image(&hdr, ew, eh);
        let mut row_cdf = vec![0.0f32; eh];
        let mut col_cdf_pdf = vec![0.0f32; ew * eh * 2];
        assert!(env.export_cdf(&mut row_cdf, &mut col_cdf_pdf));
        assert!((row_cdf[eh - 1] - 1.0).abs() < 1e-5);
        for y in 1..eh {
            assert!(row_cdf[y] >= row_cdf[y - 1]);
        }
        let sun_pdf = col_cdf_pdf[(2 * ew + 12) * 2 + 1];
        let dim_pdf = col_cdf_pdf[(6 * ew + 1) * 2 + 1];
        assert!(sun_pdf > dim_pdf * 50.0, "sun pdf ({sun_pdf}) should greatly exceed dim sky ({dim_pdf})");
    }

    #[test]
    fn agx_looks_emissive_export_and_motion_bvh_union_bounds() {
        // 1. OCIO AgX Looks: Punchy darkens shadows / increases contrast & saturation vs Base; Low Contrast lifts darks
        let mid_col = v3(0.35, 0.12, 0.08);
        let base_c = post::agx_with_look(mid_col, 1.0, 0);
        let punchy_c = post::agx_with_look(mid_col, 1.0, 1);
        let low_c = post::agx_with_look(mid_col, 1.0, 4);
        let sat = |c: V3| c.maxc() - c.x.min(c.y).min(c.z);
        assert!(sat(punchy_c) > sat(base_c), "AgX Punchy saturation ({}) must exceed Base ({})", sat(punchy_c), sat(base_c));
        assert!(low_c.lum() > base_c.lum(), "AgX Low Contrast dark/mid lum ({}) must exceed Base ({})", low_c.lum(), base_c.lum());

        // 2. Motion BVH union bounds: when a triangle moves from x=0..1 to x=5..6, shutter=1.0 root AABB must cover [0, 6]
        let pos0 = vec![0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.5, 1.0, 0.0];
        let (tris, attrs) = build_tris_and_attrs(&pos0, &[], &[], &[0], 1);
        let mut sc = Scene::new(
            tris,
            attrs,
            vec![Material { emit: v3(10.0, 8.0, 6.0), ..Material::default() }],
            vec![],
        );
        assert_eq!(sc.emissive_tris.len(), 1);
        assert!(sc.emissive_total > 1.0);

        let pos1 = vec![5.0, 0.0, 0.0, 6.0, 0.0, 0.0, 5.5, 1.0, 0.0];
        sc.refit(&pos1, &[]);
        let mut static_nodes = vec![0.0f32; sc.bvh.nodes.len() * 8];
        let mut motion_nodes = vec![0.0f32; sc.bvh.nodes.len() * 8];
        export_bvh2_nodes_motion_slice(&sc, &mut static_nodes, 0.0);
        export_bvh2_nodes_motion_slice(&sc, &mut motion_nodes, 1.0);
        assert!(static_nodes[0] >= 4.99 && static_nodes[4] >= 5.99, "static AABB x=[{}, {}]", static_nodes[0], static_nodes[4]);
        assert!(motion_nodes[0] <= 0.01 && motion_nodes[4] >= 5.99, "motion union AABB x=[{}, {}]", motion_nodes[0], motion_nodes[4]);
    }
}
