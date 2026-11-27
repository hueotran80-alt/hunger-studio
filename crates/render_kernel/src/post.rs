//! Fast separable variance-guided edge-avoiding à-trous denoiser (SVGF-lite) and LUT-accelerated tone mapping.
use crate::math::*;
use std::sync::OnceLock;

pub const AOV_STRIDE: usize = 8; // albedo3, normal3, lum_sq, rough

/// Fast smooth monotonic approximation to exp(-x) for x >= 0 (no libm exp() call in hot loops).
#[inline(always)]
fn fast_decay(x: f32) -> f32 {
    if x <= 0.0 {
        return 1.0;
    }
    if x >= 12.0 {
        return 0.0;
    }
    let y = 1.0 + x * 0.25;
    let y2 = y * y;
    1.0 / (y2 * y2)
}

/// Separable (H + V) variance-guided à-trous denoiser.
/// - Skips pure sky/background pixels (no surface normal) in O(1).
/// - Uses 5+5 = 10 taps per pass instead of 5x5 = 25 taps (2.5x fewer memory reads).
/// - Zero `exp()`, `sqrt()`, or `powi(32)` calls inside the inner filter loop.
pub fn denoise(accum: &[f32], aov: &[f32], out: &mut [f32], w: usize, h: usize, spp: f32, passes: usize) {
    let n = w * h;
    if n == 0 {
        return;
    }
    let inv = 1.0 / spp.max(1.0);
    let inv_sqrt_spp = 1.0 / spp.sqrt().max(1.0);

    let mut col: Vec<V3> = Vec::with_capacity(n);
    let mut alb: Vec<V3> = Vec::with_capacity(n);
    let mut nrm: Vec<V3> = Vec::with_capacity(n);
    let mut has_surf: Vec<u8> = Vec::with_capacity(n);
    let mut sigma_inv2: Vec<f32> = Vec::with_capacity(n);

    for i in 0..n {
        let ab = i * AOV_STRIDE;
        let a = v3(aov[ab], aov[ab + 1], aov[ab + 2]) * inv;
        let c = v3(accum[i * 4], accum[i * 4 + 1], accum[i * 4 + 2]) * inv;
        let nv = v3(aov[ab + 3], aov[ab + 4], aov[ab + 5]);
        let nv2 = nv.dot(nv);
        if nv2 > 1e-6 {
            col.push(v3(c.x / (a.x + 0.02), c.y / (a.y + 0.02), c.z / (a.z + 0.02)));
            alb.push(a);
            nrm.push(nv / nv2.sqrt());
            has_surf.push(1);
            let l_mean = c.lum();
            let l2_mean = aov[ab + 6] * inv;
            let v_raw = (l2_mean - l_mean * l_mean).max(0.0) * inv_sqrt_spp;
            let rough = (aov[ab + 7] * inv).clamp(0.0, 1.0);
            let spec_damp = if rough < 0.06 { 0.35 } else { 1.0 };
            let sigma = ((0.3 * (0.15 + col[i].lum()) + 12.0 * v_raw.sqrt()) * spec_damp).max(0.08);
            sigma_inv2.push(1.0 / (sigma * sigma));
        } else {
            // Sky / background pixel: preserve exact radiance, skip bilateral passes.
            col.push(c);
            alb.push(V3::ZERO);
            nrm.push(V3::ZERO);
            has_surf.push(0);
            sigma_inv2.push(1.0);
        }
    }

    // When spp < 2.5, estimate spatial variance on surface pixels only.
    if spp < 2.5 {
        for y in 0..h as isize {
            for x in 0..w as isize {
                let ci = y as usize * w + x as usize;
                if has_surf[ci] == 0 {
                    continue;
                }
                let (mut s1, mut s2, mut cnt) = (0.0f32, 0.0f32, 0.0f32);
                for dy in -1..=1 {
                    let yy = y + dy;
                    if yy < 0 || yy >= h as isize {
                        continue;
                    }
                    for dx in -1..=1 {
                        let xx = x + dx;
                        if xx < 0 || xx >= w as isize {
                            continue;
                        }
                        let qi = yy as usize * w + xx as usize;
                        if has_surf[qi] != 0 && nrm[ci].dot(nrm[qi]) > 0.8 {
                            let l = col[qi].lum();
                            s1 += l;
                            s2 += l * l;
                            cnt += 1.0;
                        }
                    }
                }
                if cnt > 1.5 {
                    let m = s1 / cnt;
                    let v_sp = (s2 / cnt - m * m).max(0.0);
                    let s = (0.3 * (0.15 + col[ci].lum()) + 12.0 * v_sp.sqrt()).max(0.08);
                    sigma_inv2[ci] = sigma_inv2[ci].min(1.0 / (s * s));
                }
            }
        }
    }

    let mut tmp = col.clone();
    const K: [f32; 5] = [1.0 / 16.0, 0.25, 0.375, 0.25, 1.0 / 16.0];
    let num_passes = passes.min(4);
    let mut pass_scale_inv2 = 1.0f32;

    for p in 0..num_passes {
        let step = 1isize << p;
        let wi = w as isize;
        let hi = h as isize;

        // Horizontal 5-tap pass: col -> tmp
        for y in 0..h {
            let row = y * w;
            for x in 0..w {
                let ci = row + x;
                if has_surf[ci] == 0 {
                    tmp[ci] = col[ci];
                    continue;
                }
                let c0 = col[ci];
                let n0 = nrm[ci];
                let a0 = alb[ci];
                let inv_s2 = sigma_inv2[ci] * pass_scale_inv2;

                let mut sum = c0 * K[2];
                let mut wsum = K[2];
                let xi = x as isize;
                for (ki, &kx) in [-2isize, -1, 1, 2].iter().enumerate() {
                    let xx = xi + kx * step;
                    if xx < 0 || xx >= wi {
                        continue;
                    }
                    let qi = row + xx as usize;
                    if has_surf[qi] == 0 {
                        continue;
                    }
                    let dn = n0.dot(nrm[qi]);
                    if dn < 0.72 {
                        continue;
                    }
                    let da = a0 - alb[qi];
                    let da2 = da.dot(da);
                    if da2 > 0.16 {
                        continue;
                    }
                    let dn2 = dn * dn;
                    let dn4 = dn2 * dn2;
                    let dn8 = dn4 * dn4;
                    let dc = c0 - col[qi];
                    let e = da2 * 45.0 + dc.dot(dc) * inv_s2;
                    let kw = K[if ki < 2 { ki } else { ki + 1 }];
                    let wt = kw * dn8 * fast_decay(e);
                    sum = sum + col[qi] * wt;
                    wsum += wt;
                }
                tmp[ci] = sum / wsum;
            }
        }

        // Vertical 5-tap pass: tmp -> col
        for y in 0..h {
            let yi = y as isize;
            let row = y * w;
            for x in 0..w {
                let ci = row + x;
                if has_surf[ci] == 0 {
                    col[ci] = tmp[ci];
                    continue;
                }
                let c0 = tmp[ci];
                let n0 = nrm[ci];
                let a0 = alb[ci];
                let inv_s2 = sigma_inv2[ci] * pass_scale_inv2;

                let mut sum = c0 * K[2];
                let mut wsum = K[2];
                for (ki, &ky) in [-2isize, -1, 1, 2].iter().enumerate() {
                    let yy = yi + ky * step;
                    if yy < 0 || yy >= hi {
                        continue;
                    }
                    let qi = yy as usize * w + x;
                    if has_surf[qi] == 0 {
                        continue;
                    }
                    let dn = n0.dot(nrm[qi]);
                    if dn < 0.72 {
                        continue;
                    }
                    let da = a0 - alb[qi];
                    let da2 = da.dot(da);
                    if da2 > 0.16 {
                        continue;
                    }
                    let dn2 = dn * dn;
                    let dn4 = dn2 * dn2;
                    let dn8 = dn4 * dn4;
                    let dc = c0 - tmp[qi];
                    let e = da2 * 45.0 + dc.dot(dc) * inv_s2;
                    let kw = K[if ki < 2 { ki } else { ki + 1 }];
                    let wt = kw * dn8 * fast_decay(e);
                    sum = sum + tmp[qi] * wt;
                    wsum += wt;
                }
                col[ci] = sum / wsum;
            }
        }
        // Tighter color stopping each pass (0.55^-2 ~= 3.3)
        pass_scale_inv2 *= 2.8;
    }

    for i in 0..n {
        if has_surf[i] != 0 {
            let c = v3(
                col[i].x * (alb[i].x + 0.02),
                col[i].y * (alb[i].y + 0.02),
                col[i].z * (alb[i].z + 0.02),
            );
            out[i * 4] = c.x;
            out[i * 4 + 1] = c.y;
            out[i * 4 + 2] = c.z;
        } else {
            out[i * 4] = col[i].x;
            out[i * 4 + 1] = col[i].y;
            out[i * 4 + 2] = col[i].z;
        }
        out[i * 4 + 3] = accum[i * 4 + 3] * inv;
    }
}

pub fn mean(accum: &[f32], out: &mut [f32], spp: f32) {
    let inv = 1.0 / spp.max(1.0);
    for (o, a) in out.iter_mut().zip(accum.iter()) {
        *o = *a * inv;
    }
}

#[inline]
fn mat_mul(c0: V3, c1: V3, c2: V3, v: V3) -> V3 {
    c0 * v.x + c1 * v.y + c2 * v.z
}

fn pow22_lut() -> &'static [f32; 513] {
    static LUT: OnceLock<[f32; 513]> = OnceLock::new();
    LUT.get_or_init(|| {
        let mut t = [0.0f32; 513];
        for i in 0..513 {
            t[i] = (i as f32 / 512.0).powf(2.2);
        }
        t
    })
}

#[inline(always)]
fn fast_pow22(x: f32, lut: &[f32; 513]) -> f32 {
    if x <= 0.0 { return 0.0; }
    if x >= 1.0 { return x.powf(2.2); }
    let f = x * 512.0;
    let i = f as usize;
    let t = f - i as f32;
    lut[i] + (lut[i + 1] - lut[i]) * t
}

fn oetf_lut() -> &'static [u8; 4097] {
    static LUT: OnceLock<[u8; 4097]> = OnceLock::new();
    LUT.get_or_init(|| {
        let mut t = [0u8; 4097];
        for i in 0..4097 {
            let x = i as f32 / 4096.0;
            let s = if x <= 0.0031308 { 12.92 * x } else { 1.055 * x.powf(1.0 / 2.4) - 0.055 };
            t[i] = (s.clamp(0.0, 1.0) * 255.0 + 0.5) as u8;
        }
        t
    })
}

#[inline(always)]
fn oetf_u8(x: f32, lut: &[u8; 4097]) -> u8 {
    let idx = (x.clamp(0.0, 1.0) * 4096.0 + 0.5) as usize;
    lut[idx.min(4096)]
}

fn agx_contrast(x: V3) -> V3 {
    let f = |x: f32| {
        let x2 = x * x;
        let x4 = x2 * x2;
        15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4 - 6.868 * x2 * x + 0.4298 * x2 + 0.1191 * x - 0.00232
    };
    v3(f(x.x), f(x.y), f(x.z))
}

/// Blender 4.x OCIO AgX Looks (0=Base, 1=Punchy, 2=High Contrast, 3=Medium High, 4=Low Contrast).
#[inline]
fn agx_apply_look(v: V3, look: u32) -> V3 {
    if look == 0 {
        return v;
    }
    let (slope, power, sat) = match look {
        1 => (1.0f32, 1.35f32, 1.40f32),  // Punchy (Blender 4.x official AgX Punchy)
        2 => (1.04f32, 1.40f32, 1.15f32), // High Contrast
        3 => (1.0f32, 1.18f32, 1.10f32),  // Medium High Contrast
        4 => (1.0f32, 0.85f32, 0.92f32),  // Low Contrast
        _ => return v,
    };
    let s = (v * slope).max(V3::ZERO);
    let p = v3(s.x.powf(power), s.y.powf(power), s.z.powf(power));
    let luma = 0.2126 * p.x + 0.7152 * p.y + 0.0722 * p.z;
    (V3::splat(luma) + (p - V3::splat(luma)) * sat).max(V3::ZERO)
}

/// Same constants as three.js / Blender AgX with optional OCIO Look (0..4).
pub fn agx_with_look(c: V3, exposure: f32, look: u32) -> V3 {
    let lut = pow22_lut();
    let to2020 = |v: V3| mat_mul(v3(0.6274, 0.0691, 0.0164), v3(0.3293, 0.9195, 0.0880), v3(0.0433, 0.0113, 0.8956), v);
    let to709 = |v: V3| mat_mul(v3(1.6605, -0.1246, -0.0182), v3(-0.5876, 1.1329, -0.1006), v3(-0.0728, -0.0083, 1.1187), v);
    let inset = |v: V3| mat_mul(v3(0.856627153315983, 0.137318972929847, 0.11189821299995), v3(0.0951212405381588, 0.761241990602591, 0.0767994186031903), v3(0.0482516061458583, 0.101439036467562, 0.811302368396859), v);
    let outset = |v: V3| mat_mul(v3(1.1271005818144368, -0.1413297634984383, -0.14132976349843826), v3(-0.11060664309660323, 1.157823702216272, -0.11060664309660294), v3(-0.016493938717834573, -0.016493938717834257, 1.2519364065950405), v);
    let (min_ev, max_ev) = (-12.47393f32, 4.026069f32);
    let mut v = to2020(c) * exposure;
    v = inset(v);
    v = v3(v.x.max(1e-10).log2(), v.y.max(1e-10).log2(), v.z.max(1e-10).log2());
    v = (v - V3::splat(min_ev)) / (max_ev - min_ev);
    v = v.max(V3::ZERO).min(V3::ONE);
    v = agx_contrast(v);
    v = outset(v);
    v = agx_apply_look(v, look);
    v = v3(fast_pow22(v.x, lut), fast_pow22(v.y, lut), fast_pow22(v.z, lut));
    to709(v)
}

pub fn agx(c: V3, exposure: f32) -> V3 {
    agx_with_look(c, exposure, 0)
}

pub fn aces(c: V3, exposure: f32) -> V3 {
    let fit = |v: V3| {
        let f = |x: f32| (x * (x + 0.0245786) - 0.000090537) / (x * (0.983729 * x + 0.4329510) + 0.238081);
        v3(f(v.x), f(v.y), f(v.z))
    };
    let mut v = c * (exposure / 0.6);
    v = mat_mul(v3(0.59719, 0.07600, 0.02840), v3(0.35458, 0.90834, 0.13383), v3(0.04823, 0.01566, 0.83777), v);
    v = fit(v);
    mat_mul(v3(1.60475, -0.10208, -0.00327), v3(-0.53108, 1.10813, -0.07276), v3(-0.07367, -0.00605, 1.07602), v)
}

/// Khronos PBR Neutral tone mapping.
pub fn neutral(c: V3, exposure: f32) -> V3 {
    const START_COMPRESSION: f32 = 0.8 - 0.04;
    const DESATURATION: f32 = 0.15;
    let mut color = (c * exposure).max(V3::ZERO);
    let x = color.x.min(color.y).min(color.z);
    let offset = if x < 0.08 { x - 6.25 * x * x } else { 0.04 };
    color = color - V3::splat(offset);
    let peak = color.maxc();
    if peak < START_COMPRESSION { return color; }
    let d = 1.0 - START_COMPRESSION;
    let new_peak = 1.0 - d * d / (peak + d - START_COMPRESSION);
    color = color * (new_peak / peak);
    let g = 1.0 - 1.0 / (DESATURATION * (peak - new_peak) + 1.0);
    color.lerp(V3::splat(new_peak), g)
}

/// mode low byte: 0 linear, 1 ACES, 2 AgX, 3 Khronos Neutral; high byte `(mode >> 8)`: AgX Look (0..4).
pub fn tonemap(src: &[f32], out: &mut [u8], exposure: f32, mode: u32) {
    let base_mode = mode & 0xFF;
    let look = (mode >> 8) & 0xFF;
    let lut = oetf_lut();
    let mut last_s = [f32::NAN; 4];
    let mut last_o = [0u8; 4];
    for (s, o) in src.chunks_exact(4).zip(out.chunks_exact_mut(4)) {
        if s[0] == last_s[0] && s[1] == last_s[1] && s[2] == last_s[2] && s[3] == last_s[3] {
            o.copy_from_slice(&last_o);
            continue;
        }
        let a = s[3].clamp(0.0, 1.0);
        let c = if a > 1e-4 { v3(s[0], s[1], s[2]) / a } else { V3::ZERO };
        let t = match base_mode {
            1 => aces(c, exposure),
            2 => agx_with_look(c, exposure, look),
            3 => neutral(c, exposure),
            _ => c * exposure,
        };
        let px = [
            oetf_u8(t.x, lut),
            oetf_u8(t.y, lut),
            oetf_u8(t.z, lut),
            (a * 255.0 + 0.5) as u8,
        ];
        last_s = [s[0], s[1], s[2], s[3]];
        last_o = px;
        o.copy_from_slice(&px);
    }
}

/// Parallel row-sliced stage 1: demodulate albedo & compute per-pixel sigma_inv2 for rows [y0..y1).
/// `col_out`, `alb_out`, `nrm_out`: f32[w*h*4] (w-channel of col_out = sigma_inv2, w-channel of nrm_out = has_surf 1.0/0.0).
pub fn denoise_prep_rows(
    accum: &[f32],
    aov: &[f32],
    col_out: &mut [f32],
    alb_out: &mut [f32],
    nrm_out: &mut [f32],
    w: usize,
    h: usize,
    y0: usize,
    y1: usize,
    spp: f32,
) {
    let inv = 1.0 / spp.max(1.0);
    let inv_sqrt_spp = 1.0 / spp.sqrt().max(1.0);
    for y in y0..y1.min(h) {
        let row = y * w;
        for x in 0..w {
            let i = row + x;
            let ab = i * AOV_STRIDE;
            let a = v3(aov[ab], aov[ab + 1], aov[ab + 2]) * inv;
            let c = v3(accum[i * 4], accum[i * 4 + 1], accum[i * 4 + 2]) * inv;
            let nv = v3(aov[ab + 3], aov[ab + 4], aov[ab + 5]);
            let nv2 = nv.dot(nv);
            let o4 = i * 4;
            if nv2 > 1e-6 {
                let dcol = v3(c.x / (a.x + 0.02), c.y / (a.y + 0.02), c.z / (a.z + 0.02));
                let l_mean = c.lum();
                let l2_mean = aov[ab + 6] * inv;
                let v_raw = (l2_mean - l_mean * l_mean).max(0.0) * inv_sqrt_spp;
                let rough = (aov[ab + 7] * inv).clamp(0.0, 1.0);
                let spec_damp = if rough < 0.06 { 0.35 } else { 1.0 };
                let sigma = ((0.3 * (0.15 + dcol.lum()) + 12.0 * v_raw.sqrt()) * spec_damp).max(0.08);
                let nn = nv / nv2.sqrt();
                col_out[o4] = dcol.x;
                col_out[o4 + 1] = dcol.y;
                col_out[o4 + 2] = dcol.z;
                col_out[o4 + 3] = 1.0 / (sigma * sigma);
                alb_out[o4] = a.x;
                alb_out[o4 + 1] = a.y;
                alb_out[o4 + 2] = a.z;
                alb_out[o4 + 3] = accum[o4 + 3] * inv;
                nrm_out[o4] = nn.x;
                nrm_out[o4 + 1] = nn.y;
                nrm_out[o4 + 2] = nn.z;
                nrm_out[o4 + 3] = 1.0;
            } else {
                col_out[o4] = c.x;
                col_out[o4 + 1] = c.y;
                col_out[o4 + 2] = c.z;
                col_out[o4 + 3] = 1.0;
                alb_out[o4] = 0.0;
                alb_out[o4 + 1] = 0.0;
                alb_out[o4 + 2] = 0.0;
                alb_out[o4 + 3] = accum[o4 + 3] * inv;
                nrm_out[o4] = 0.0;
                nrm_out[o4 + 1] = 0.0;
                nrm_out[o4 + 2] = 0.0;
                nrm_out[o4 + 3] = 0.0;
            }
        }
    }
}

/// Parallel row-sliced separable horizontal or vertical 5-tap à-trous pass for rows [y0..y1).
pub fn denoise_step_rows(
    col_in: &[f32],
    alb: &[f32],
    nrm: &[f32],
    col_out: &mut [f32],
    w: usize,
    h: usize,
    y0: usize,
    y1: usize,
    step: isize,
    pass_scale_inv2: f32,
    vertical: bool,
) {
    const K: [f32; 5] = [1.0 / 16.0, 0.25, 0.375, 0.25, 1.0 / 16.0];
    let wi = w as isize;
    let hi = h as isize;
    for y in y0..y1.min(h) {
        let yi = y as isize;
        let row = y * w;
        for x in 0..w {
            let ci = row + x;
            let o4 = ci * 4;
            let inv_s2_base = col_in[o4 + 3];
            if nrm[o4 + 3] < 0.5 {
                col_out[o4] = col_in[o4];
                col_out[o4 + 1] = col_in[o4 + 1];
                col_out[o4 + 2] = col_in[o4 + 2];
                col_out[o4 + 3] = inv_s2_base;
                continue;
            }
            let c0 = v3(col_in[o4], col_in[o4 + 1], col_in[o4 + 2]);
            let n0 = v3(nrm[o4], nrm[o4 + 1], nrm[o4 + 2]);
            let a0 = v3(alb[o4], alb[o4 + 1], alb[o4 + 2]);
            let inv_s2 = inv_s2_base * pass_scale_inv2;

            let mut sum = c0 * K[2];
            let mut wsum = K[2];
            let xi = x as isize;
            for (ki, &ko) in [-2isize, -1, 1, 2].iter().enumerate() {
                let qi = if vertical {
                    let yy = yi + ko * step;
                    if yy < 0 || yy >= hi { continue; }
                    yy as usize * w + x
                } else {
                    let xx = xi + ko * step;
                    if xx < 0 || xx >= wi { continue; }
                    row + xx as usize
                };
                let q4 = qi * 4;
                if nrm[q4 + 3] < 0.5 { continue; }
                let dn = n0.x * nrm[q4] + n0.y * nrm[q4 + 1] + n0.z * nrm[q4 + 2];
                if dn < 0.72 { continue; }
                let dax = a0.x - alb[q4];
                let day = a0.y - alb[q4 + 1];
                let daz = a0.z - alb[q4 + 2];
                let da2 = dax * dax + day * day + daz * daz;
                if da2 > 0.16 { continue; }
                let dn2 = dn * dn;
                let dn4 = dn2 * dn2;
                let dn8 = dn4 * dn4;
                let dcx = c0.x - col_in[q4];
                let dcy = c0.y - col_in[q4 + 1];
                let dcz = c0.z - col_in[q4 + 2];
                let e = da2 * 45.0 + (dcx * dcx + dcy * dcy + dcz * dcz) * inv_s2;
                let kw = K[if ki < 2 { ki } else { ki + 1 }];
                let wt = kw * dn8 * fast_decay(e);
                sum.x += col_in[q4] * wt;
                sum.y += col_in[q4 + 1] * wt;
                sum.z += col_in[q4 + 2] * wt;
                wsum += wt;
            }
            let inv_w = 1.0 / wsum;
            col_out[o4] = sum.x * inv_w;
            col_out[o4 + 1] = sum.y * inv_w;
            col_out[o4 + 2] = sum.z * inv_w;
            col_out[o4 + 3] = inv_s2_base;
        }
    }
}

/// Parallel row-sliced remodulate (albedo multiply) into linear RGBA mean for rows [y0..y1).
pub fn denoise_remod_rows(
    col: &[f32],
    alb: &[f32],
    nrm: &[f32],
    mean_out: &mut [f32],
    w: usize,
    h: usize,
    y0: usize,
    y1: usize,
) {
    for y in y0..y1.min(h) {
        let row = y * w;
        for x in 0..w {
            let o4 = (row + x) * 4;
            if nrm[o4 + 3] >= 0.5 {
                mean_out[o4] = col[o4] * (alb[o4] + 0.02);
                mean_out[o4 + 1] = col[o4 + 1] * (alb[o4 + 1] + 0.02);
                mean_out[o4 + 2] = col[o4 + 2] * (alb[o4 + 2] + 0.02);
            } else {
                mean_out[o4] = col[o4];
                mean_out[o4 + 1] = col[o4 + 1];
                mean_out[o4 + 2] = col[o4 + 2];
            }
            mean_out[o4 + 3] = alb[o4 + 3];
        }
    }
}

/// Parallel row-sliced tonemap for rows [y0..y1).
pub fn tonemap_rows(src: &[f32], out: &mut [u8], w: usize, h: usize, y0: usize, y1: usize, exposure: f32, mode: u32) {
    let y1c = y1.min(h);
    if y1c <= y0 { return; }
    let start = y0 * w * 4;
    let end = y1c * w * 4;
    tonemap(&src[start..end], &mut out[start..end], exposure, mode);
}
