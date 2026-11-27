//! Mesh texture map baking against Scene BVH (AO, Tangent/World Normal, Position, Curvature, Combined GI)
//! plus UV island margin dilation.

use crate::math::*;
use crate::{compute_tangent, RenderParams, Scene, Shade, PI};

pub const BAKE_AO: u32 = 0;
pub const BAKE_NORMAL_TANGENT: u32 = 1;
pub const BAKE_NORMAL_WORLD: u32 = 2;
pub const BAKE_POSITION: u32 = 3;
pub const BAKE_CURVATURE: u32 = 4;
pub const BAKE_COMBINED: u32 = 5;

#[inline]
fn clamp_u8(x: f32) -> u8 {
    (x.clamp(0.0, 1.0) * 255.0 + 0.5) as u8
}

#[inline]
fn linear_to_srgb(x: f32) -> f32 {
    let x = x.clamp(0.0, 1.0);
    if x <= 0.0031308 {
        12.92 * x
    } else {
        1.055 * x.powf(1.0 / 2.4) - 0.055
    }
}

#[inline]
fn v3_at(s: &[f32], i: usize) -> V3 {
    v3(s[i], s[i + 1], s[i + 2])
}

#[inline]
fn cosine_hemisphere(t1: V3, t2: V3, n: V3, u1: f32, u2: f32) -> V3 {
    let r = u1.clamp(0.0, 1.0).sqrt();
    let phi = 2.0 * PI * u2;
    let z = (1.0 - u1).max(0.0).sqrt();
    (t1 * (r * phi.cos()) + t2 * (r * phi.sin()) + n * z).norm()
}

pub fn bake_rows(
    scene: &Scene,
    tgt_pos: &[f32],
    tgt_nrm: &[f32],
    tgt_uv: &[f32],
    ntri: usize,
    width: usize,
    height: usize,
    y0: usize,
    y1: usize,
    out_rgba: &mut [u8],
    out_cov: &mut [u8],
    mode: u32,
    samples: u32,
    max_dist: f32,
    cage_offset: f32,
    bounds_lo: V3,
    bounds_hi: V3,
) {
    if ntri == 0 || width == 0 || height == 0 || y1 <= y0 {
        return;
    }
    let y_end = y1.min(height);
    let has_nrm = tgt_nrm.len() >= ntri * 9;
    let has_uv = tgt_uv.len() >= ntri * 6;
    if !has_uv || tgt_pos.len() < ntri * 9 {
        return;
    }

    let (bvh_lo, bvh_hi) = scene.bvh.bounds();
    let diag = (bvh_hi - bvh_lo).len().max(1e-3);
    let ao_dist = if max_dist > 0.0 { max_dist } else { diag * 0.35 };
    let probe_r = if max_dist > 0.0 { max_dist } else { diag * 0.015 };
    let spp = samples.max(1);
    let bounds_span = (bounds_hi - bounds_lo).max(v3(1e-5, 1e-5, 1e-5));

    for t in 0..ntri {
        let pb = t * 9;
        let ub = t * 6;
        let (p0, p1, p2) = (v3_at(tgt_pos, pb), v3_at(tgt_pos, pb + 3), v3_at(tgt_pos, pb + 6));
        let e1 = p1 - p0;
        let e2 = p2 - p0;
        let ng_raw = e1.cross(e2);
        let ng_len = ng_raw.len();
        if ng_len <= 1e-12 {
            continue;
        }
        let ng = ng_raw / ng_len;

        let (n0, n1, n2) = if has_nrm {
            (v3_at(tgt_nrm, pb).norm(), v3_at(tgt_nrm, pb + 3).norm(), v3_at(tgt_nrm, pb + 6).norm())
        } else {
            (ng, ng, ng)
        };

        let uv0 = [tgt_uv[ub], tgt_uv[ub + 1]];
        let uv1 = [tgt_uv[ub + 2], tgt_uv[ub + 3]];
        let uv2 = [tgt_uv[ub + 4], tgt_uv[ub + 5]];

        let (tri_t, tri_bsign) = compute_tangent(e1, e2, uv0, uv1, uv2, ng);

        // Wrap shifted UDIM / tiled coordinates cleanly back into [0,1] per-triangle island offset.
        let min_u = uv0[0].min(uv1[0]).min(uv2[0]);
        let max_u = uv0[0].max(uv1[0]).max(uv2[0]);
        let min_v = uv0[1].min(uv1[1]).min(uv2[1]);
        let max_v = uv0[1].max(uv1[1]).max(uv2[1]);

        let tile_u_start = (min_u.floor() as i32).clamp(-2, 2);
        let tile_u_end = (max_u.floor() as i32).clamp(-2, 2);
        let tile_v_start = (min_v.floor() as i32).clamp(-2, 2);
        let tile_v_end = (max_v.floor() as i32).clamp(-2, 2);

        for tv in tile_v_start..=tile_v_end {
            for tu in tile_u_start..=tile_u_end {
                let s_uv0 = [uv0[0] - tu as f32, uv0[1] - tv as f32];
                let s_uv1 = [uv1[0] - tu as f32, uv1[1] - tv as f32];
                let s_uv2 = [uv2[0] - tu as f32, uv2[1] - tv as f32];

                // Note flipY=true: image row y=0 is v=1.0, row y=H is v=0.0
                let x0p = s_uv0[0] * width as f32;
                let y0p = (1.0 - s_uv0[1]) * height as f32;
                let x1p = s_uv1[0] * width as f32;
                let y1p = (1.0 - s_uv1[1]) * height as f32;
                let x2p = s_uv2[0] * width as f32;
                let y2p = (1.0 - s_uv2[1]) * height as f32;

                let det = (x1p - x0p) * (y2p - y0p) - (x2p - x0p) * (y1p - y0p);
                if det.abs() < 1e-6 {
                    continue;
                }
                let inv_det = 1.0 / det;

                let min_px = (x0p.min(x1p).min(x2p).floor() as isize - 1).max(0) as usize;
                let max_px = (x0p.max(x1p).max(x2p).ceil() as isize + 1).min(width as isize - 1).max(0) as usize;
                let min_py = (y0p.min(y1p).min(y2p).floor() as isize - 1).max(y0 as isize) as usize;
                let max_py = (y0p.max(y1p).max(y2p).ceil() as isize + 1).min(y_end as isize - 1).max(y0 as isize) as usize;

                if max_px < min_px || max_py < min_py {
                    continue;
                }

                for gy in min_py..=max_py {
                    let cy = gy as f32 + 0.5;
                    let row_local = (gy - y0) * width;
                    for gx in min_px..=max_px {
                        let cx = gx as f32 + 0.5;
                        let w1 = ((cx - x0p) * (y2p - y0p) - (x2p - x0p) * (cy - y0p)) * inv_det;
                        let w2 = ((x1p - x0p) * (cy - y0p) - (cx - x0p) * (y1p - y0p)) * inv_det;
                        let w0 = 1.0 - w1 - w2;

                        // Slight half-texel tolerance avoids hairline seams along diagonal edges
                        if w0 < -0.02 || w1 < -0.02 || w2 < -0.02 {
                            continue;
                        }
                        let cw0 = w0.max(0.0);
                        let cw1 = w1.max(0.0);
                        let cw2 = w2.max(0.0);
                        let sum = (cw0 + cw1 + cw2).max(1e-6);
                        let (b0, b1, b2) = (cw0 / sum, cw1 / sum, cw2 / sum);

                        let low_p = p0 * b0 + p1 * b1 + p2 * b2;
                        let mut low_n = n0 * b0 + n1 * b1 + n2 * b2;
                        if low_n.dot(low_n) < 1e-8 {
                            low_n = ng;
                        } else {
                            low_n = low_n.norm();
                        }

                        // Optional high-to-low raycast along -low_n when cage_offset > 0
                        let (mut eval_p, mut eval_n) = (low_p, low_n);
                        if cage_offset > 0.0 {
                            let max_ray = (cage_offset * 3.0).max(max_dist);
                            let cast_origin = low_p + low_n * cage_offset;
                            let mut hit_opt = scene.bvh.intersect(cast_origin, -low_n, max_ray);
                            if hit_opt.is_none() {
                                hit_opt = scene.bvh.intersect(low_p - low_n * (cage_offset * 0.5), low_n, max_ray);
                            }
                            if let Some(hit) = hit_opt {
                                let hg = &scene.bvh.tris[hit.tri as usize];
                                let ha = &scene.bvh.attrs[hit.tri as usize];
                                let hw0 = 1.0 - hit.u - hit.v;
                                eval_p = hg.p0 + hg.e1 * hit.u + hg.e2 * hit.v;
                                let mut hn = ha.n0 * hw0 + ha.n1 * hit.u + ha.n2 * hit.v;
                                if hn.dot(hn) < 1e-8 {
                                    hn = hg.e1.cross(hg.e2).norm();
                                } else {
                                    hn = hn.norm();
                                }
                                eval_n = hn;
                            }
                        }

                        let (t1, t2) = if tri_t.dot(tri_t) > 1e-6 {
                            let t_ortho = (tri_t - low_n * low_n.dot(tri_t)).norm();
                            let b = low_n.cross(t_ortho) * tri_bsign;
                            (t_ortho, b)
                        } else {
                            basis(low_n)
                        };

                        let rgba = match mode {
                            BAKE_AO => {
                                let (eb1, eb2) = basis(eval_n);
                                let origin = eval_p + eval_n * scene.eps;
                                let mut unocc = 0.0f32;
                                for s in 0..spp {
                                    let mut rng = Sampler::new(gx as u32, gy as u32, s, 0x9E37_79B9);
                                    let (u1, u2) = rng.f2();
                                    let dir = cosine_hemisphere(eb1, eb2, eval_n, u1, u2);
                                    if !scene.bvh.occluded(origin, dir, ao_dist) {
                                        unocc += 1.0;
                                    }
                                }
                                let ao = unocc / spp as f32;
                                let v = clamp_u8(ao);
                                [v, v, v, 255]
                            }
                            BAKE_NORMAL_TANGENT => {
                                let nx = eval_n.dot(t1) * 0.5 + 0.5;
                                let ny = eval_n.dot(t2) * 0.5 + 0.5;
                                let nz = eval_n.dot(low_n) * 0.5 + 0.5;
                                [clamp_u8(nx), clamp_u8(ny), clamp_u8(nz), 255]
                            }
                            BAKE_NORMAL_WORLD => {
                                [clamp_u8(eval_n.x * 0.5 + 0.5), clamp_u8(eval_n.y * 0.5 + 0.5), clamp_u8(eval_n.z * 0.5 + 0.5), 255]
                            }
                            BAKE_POSITION => {
                                let rel = v3(
                                    (eval_p.x - bounds_lo.x) / bounds_span.x,
                                    (eval_p.y - bounds_lo.y) / bounds_span.y,
                                    (eval_p.z - bounds_lo.z) / bounds_span.z,
                                );
                                [clamp_u8(rel.x), clamp_u8(rel.y), clamp_u8(rel.z), 255]
                            }
                            BAKE_CURVATURE => {
                                let (eb1, eb2) = basis(eval_n);
                                let mut curv = 0.0f32;
                                let mut valid = 0.0f32;
                                let ring_n = 8;
                                for k in 0..ring_n {
                                    let ang = (k as f32) * (2.0 * PI / ring_n as f32);
                                    let offset_dir = (eb1 * ang.cos() + eb2 * ang.sin()).norm();
                                    let ro = eval_p + eval_n * (probe_r * 1.5) + offset_dir * probe_r;
                                    if let Some(hit) = scene.bvh.intersect(ro, -eval_n, probe_r * 3.0) {
                                        let ha = &scene.bvh.attrs[hit.tri as usize];
                                        let hw0 = 1.0 - hit.u - hit.v;
                                        let mut hn = ha.n0 * hw0 + ha.n1 * hit.u + ha.n2 * hit.v;
                                        if hn.dot(hn) > 1e-8 {
                                            hn = hn.norm();
                                            // Normals diverging outward away from probe center -> convex (+); converging -> concave (-)
                                            curv += (hn - eval_n).dot(offset_dir);
                                            valid += 1.0;
                                        }
                                    }
                                }
                                let c_norm = if valid > 0.0 { 0.5 + (curv / valid) * 1.25 } else { 0.5 };
                                let v = clamp_u8(c_norm);
                                [v, v, v, 255]
                            }
                            _ => {
                                // BAKE_COMBINED: evaluate surface material direct lights + 1-bounce GI + ambient env
                                let mut mat = scene.mats.first().copied().unwrap_or_default();
                                mat.metal = mat.metal.min(0.95);
                                let sh = Shade::new(&mat, eval_n, t1, t2, eval_n);
                                let origin = eval_p + eval_n * scene.eps;
                                let (eb1, eb2) = basis(eval_n);
                                let p_params = RenderParams {
                                    spp,
                                    seed: 0xBA4E_0001,
                                    max_bounces: 2,
                                    clamp: 10.0,
                                    adaptive_threshold: 0.0,
                                };
                                let mut sum_rad = V3::ZERO;
                                for s in 0..spp {
                                    let mut rng = Sampler::new(gx as u32, gy as u32, s, 0x517C_C1B7);
                                    // Direct illumination + emissive
                                    let mut li = mat.emit + scene.direct(eval_p, &sh, eval_n, &mut rng);
                                    // 1-bounce indirect sky / scene radiance
                                    let (u1, u2) = rng.f2();
                                    let indir = cosine_hemisphere(eb1, eb2, eval_n, u1, u2);
                                    let smp = scene.trace(origin, indir, &mut rng, &p_params);
                                    li = li + mat.base.mulv(smp.rad);
                                    sum_rad = sum_rad + li;
                                }
                                let avg = sum_rad / spp as f32;
                                [
                                    clamp_u8(linear_to_srgb(avg.x)),
                                    clamp_u8(linear_to_srgb(avg.y)),
                                    clamp_u8(linear_to_srgb(avg.z)),
                                    255,
                                ]
                            }
                        };

                        let pix_idx = row_local + gx;
                        let out4 = pix_idx * 4;
                        out_rgba[out4] = rgba[0];
                        out_rgba[out4 + 1] = rgba[1];
                        out_rgba[out4 + 2] = rgba[2];
                        out_rgba[out4 + 3] = rgba[3];
                        out_cov[pix_idx] = 1;
                    }
                }
            }
        }
    }
}

/// Expands baked UV islands outward into empty padding pixels by `margin` pixels to prevent seam bleeding.
pub fn dilate_margin(rgba: &mut [u8], cov: &mut [u8], width: usize, height: usize, margin: usize) {
    if width == 0 || height == 0 || margin == 0 {
        return;
    }
    let n = width * height;
    if rgba.len() < n * 4 || cov.len() < n {
        return;
    }
    let mut next_rgba = rgba.to_vec();
    let mut next_cov = cov.to_vec();

    for _ in 0..margin {
        let mut changed = false;
        for y in 0..height {
            for x in 0..width {
                let idx = y * width + x;
                if cov[idx] != 0 {
                    continue;
                }
                let mut sr = 0u32;
                let mut sg = 0u32;
                let mut sb = 0u32;
                let mut sa = 0u32;
                let mut cnt = 0u32;
                let y0 = y.saturating_sub(1);
                let y1 = (y + 1).min(height - 1);
                let x0 = x.saturating_sub(1);
                let x1 = (x + 1).min(width - 1);
                for ny in y0..=y1 {
                    for nx in x0..=x1 {
                        let ni = ny * width + nx;
                        if cov[ni] != 0 {
                            let n4 = ni * 4;
                            sr += rgba[n4] as u32;
                            sg += rgba[n4 + 1] as u32;
                            sb += rgba[n4 + 2] as u32;
                            sa += rgba[n4 + 3] as u32;
                            cnt += 1;
                        }
                    }
                }
                if cnt > 0 {
                    let o4 = idx * 4;
                    next_rgba[o4] = (sr / cnt) as u8;
                    next_rgba[o4 + 1] = (sg / cnt) as u8;
                    next_rgba[o4 + 2] = (sb / cnt) as u8;
                    next_rgba[o4 + 3] = (sa / cnt) as u8;
                    next_cov[idx] = 1;
                    changed = true;
                }
            }
        }
        rgba.copy_from_slice(&next_rgba);
        cov.copy_from_slice(&next_cov);
        if !changed {
            break;
        }
    }
}
