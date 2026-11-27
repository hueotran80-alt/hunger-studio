//! High-precision Rust Mocap post-processing filters:
//! - Confidence gap fill (Catmull-Rom / cubic Hermite interior, clamped endpoints)
//! - Single-frame MAD outlier despiker
//! - Adaptive 1-Euro filter (causal or bidirectional zero-phase)
//! - Bidirectional camera-Z stabilization across all tracked joints
//! - Anatomical bone-length enforcement along parent->child chains
//! - True 3D metric root trajectory (XY translation + apparent torso-scale Z depth)
//! - Smooth Hermite ease-in/ease-out Foot-Lock IK with two-bone Law-of-Cosines knee solve

use crate::math::{median_f32, Vec3};
use std::f32::consts::PI;

pub fn smoothing_factor(dt: f32, cutoff_hz: f32) -> f32 {
    let cutoff = cutoff_hz.max(0.01);
    let r = 2.0 * PI * cutoff * dt.max(1e-4);
    r / (r + 1.0)
}

#[derive(Clone, Copy)]
pub struct OneEuro {
    min_cutoff: f32,
    beta: f32,
    d_cutoff: f32,
    initialized: bool,
    x_prev: f32,
    dx_prev: f32,
}

impl OneEuro {
    pub fn new(min_cutoff: f32, beta: f32, d_cutoff: f32) -> Self {
        Self {
            min_cutoff: min_cutoff.max(0.01),
            beta: beta.max(0.0),
            d_cutoff: d_cutoff.max(0.01),
            initialized: false,
            x_prev: 0.0,
            dx_prev: 0.0,
        }
    }

    pub fn filter(&mut self, x: f32, dt: f32) -> f32 {
        if !x.is_finite() {
            return self.x_prev;
        }
        if !self.initialized {
            self.initialized = true;
            self.x_prev = x;
            self.dx_prev = 0.0;
            return x;
        }
        let safe_dt = dt.max(1.0 / 240.0);
        let a_d = smoothing_factor(safe_dt, self.d_cutoff);
        let dx = (x - self.x_prev) / safe_dt;
        let dx_hat = a_d * dx + (1.0 - a_d) * self.dx_prev;
        let cutoff = self.min_cutoff + self.beta * dx_hat.abs();
        let a = smoothing_factor(safe_dt, cutoff);
        let x_hat = a * x + (1.0 - a) * self.x_prev;
        self.x_prev = x_hat;
        self.dx_prev = dx_hat;
        x_hat
    }
}

/// Fill occluded/missing gaps per joint `(n_frames x n_joints x 4 [x,y,z,vis])`.
pub fn gap_fill_joints(buf: &mut [f32], n_frames: usize, n_joints: usize, min_vis: f32, max_gap: usize) {
    if n_frames < 2 || n_joints == 0 {
        return;
    }
    let mut valid_idx = Vec::with_capacity(n_frames);
    for j in 0..n_joints {
        valid_idx.clear();
        for f in 0..n_frames {
            let base = (f * n_joints + j) * 4;
            let x = buf[base];
            let y = buf[base + 1];
            let z = buf[base + 2];
            let v = buf[base + 3];
            if v >= min_vis && x.is_finite() && y.is_finite() && z.is_finite() {
                valid_idx.push(f);
            }
        }
        if valid_idx.is_empty() {
            continue;
        }

        // Clamp leading frames before first valid sample.
        let first = valid_idx[0];
        let f_base = (first * n_joints + j) * 4;
        let first_xyz = [buf[f_base], buf[f_base + 1], buf[f_base + 2]];
        for f in 0..first {
            let b = (f * n_joints + j) * 4;
            buf[b] = first_xyz[0];
            buf[b + 1] = first_xyz[1];
            buf[b + 2] = first_xyz[2];
        }

        // Clamp trailing frames after last valid sample.
        let last = *valid_idx.last().unwrap();
        let l_base = (last * n_joints + j) * 4;
        let last_xyz = [buf[l_base], buf[l_base + 1], buf[l_base + 2]];
        for f in (last + 1)..n_frames {
            let b = (f * n_joints + j) * 4;
            buf[b] = last_xyz[0];
            buf[b + 1] = last_xyz[1];
            buf[b + 2] = last_xyz[2];
        }

        // Smooth Hermite C1 spline interpolation across interior gaps (catmull-rom tangent matched).
        for k in 0..(valid_idx.len() - 1) {
            let i0 = valid_idx[k];
            let i1 = valid_idx[k + 1];
            let span = i1 - i0;
            if span <= 1 {
                continue;
            }
            let b0 = (i0 * n_joints + j) * 4;
            let b1 = (i1 * n_joints + j) * 4;
            let span_f = span as f32;

            // Estimate entry/exit velocity tangents from neighboring valid anchor frames
            let m0 = if k > 0 {
                let ip = valid_idx[k - 1];
                let bp = (ip * n_joints + j) * 4;
                let dt_prev = ((i1 - ip) as f32).max(1.0);
                [
                    (buf[b1] - buf[bp]) * (span_f / dt_prev) * 0.65,
                    (buf[b1 + 1] - buf[bp + 1]) * (span_f / dt_prev) * 0.65,
                    (buf[b1 + 2] - buf[bp + 2]) * (span_f / dt_prev) * 0.65,
                ]
            } else {
                [buf[b1] - buf[b0], buf[b1 + 1] - buf[b0 + 1], buf[b1 + 2] - buf[b0 + 2]]
            };
            let m1 = if k + 2 < valid_idx.len() {
                let inxt = valid_idx[k + 2];
                let bn = (inxt * n_joints + j) * 4;
                let dt_next = ((inxt - i0) as f32).max(1.0);
                [
                    (buf[bn] - buf[b0]) * (span_f / dt_next) * 0.65,
                    (buf[bn + 1] - buf[b0 + 1]) * (span_f / dt_next) * 0.65,
                    (buf[bn + 2] - buf[b0 + 2]) * (span_f / dt_next) * 0.65,
                ]
            } else {
                [buf[b1] - buf[b0], buf[b1 + 1] - buf[b0 + 1], buf[b1 + 2] - buf[b0 + 2]]
            };

            let use_hermite = span - 1 <= max_gap;
            for f in (i0 + 1)..i1 {
                let u = (f - i0) as f32 / span_f;
                let b = (f * n_joints + j) * 4;
                if use_hermite {
                    let u2 = u * u;
                    let u3 = u2 * u;
                    let h00 = 2.0 * u3 - 3.0 * u2 + 1.0;
                    let h10 = u3 - 2.0 * u2 + u;
                    let h01 = -2.0 * u3 + 3.0 * u2;
                    let h11 = u3 - u2;
                    for c in 0..3 {
                        buf[b + c] = h00 * buf[b0 + c] + h10 * m0[c] + h01 * buf[b1 + c] + h11 * m1[c];
                    }
                    // Preserve low confidence flag inside long occluded spans while marking short filled spans usable
                    let dist_edge = (f - i0).min(i1 - f) as f32 / (0.5 * span_f).max(1.0);
                    let fill_vis = (buf[b0 + 3].min(buf[b1 + 3]) * (0.72 - 0.20 * dist_edge)).max(min_vis * 0.85);
                    buf[b + 3] = buf[b + 3].max(fill_vis.min(0.62));
                } else {
                    let t = u;
                    buf[b] = buf[b0] + (buf[b1] - buf[b0]) * t;
                    buf[b + 1] = buf[b0 + 1] + (buf[b1 + 1] - buf[b0 + 1]) * t;
                    buf[b + 2] = buf[b0 + 2] + (buf[b1 + 2] - buf[b0 + 2]) * t;
                }
            }
        }
    }
}

/// Remove single-frame MediaPipe teleport glitches using MAD over second-difference residuals.
pub fn despike_outliers(buf: &mut [f32], n_frames: usize, n_joints: usize, min_vis: f32) {
    if n_frames < 5 || n_joints == 0 {
        return;
    }
    let mut residuals = vec![0.0f32; n_frames];
    let mut sorted = Vec::with_capacity(n_frames);
    let mut fixed = vec![0.0f32; n_frames * 3];

    for j in 0..n_joints {
        residuals.fill(0.0);
        sorted.clear();
        for f in 1..(n_frames - 1) {
            let b_prev = ((f - 1) * n_joints + j) * 4;
            let b_curr = (f * n_joints + j) * 4;
            let b_next = ((f + 1) * n_joints + j) * 4;
            if buf[b_curr + 3] < min_vis {
                continue;
            }
            let mid_x = 0.5 * (buf[b_prev] + buf[b_next]);
            let mid_y = 0.5 * (buf[b_prev + 1] + buf[b_next + 1]);
            let mid_z = 0.5 * (buf[b_prev + 2] + buf[b_next + 2]);
            let dx = buf[b_curr] - mid_x;
            let dy = buf[b_curr + 1] - mid_y;
            let dz = buf[b_curr + 2] - mid_z;
            let r = (dx * dx + dy * dy + dz * dz).sqrt();
            residuals[f] = r;
            sorted.push(r);
        }
        if sorted.len() < 4 {
            continue;
        }
        let med = median_f32(&mut sorted);
        let mut devs: Vec<f32> = sorted.iter().map(|&r| (r - med).abs()).collect();
        let mad = median_f32(&mut devs);
        let thresh = (med + 4.5 * mad).max(0.08);

        for f in 0..n_frames {
            let b = (f * n_joints + j) * 4;
            fixed[f * 3] = buf[b];
            fixed[f * 3 + 1] = buf[b + 1];
            fixed[f * 3 + 2] = buf[b + 2];
        }
        for f in 1..(n_frames - 1) {
            if residuals[f] > thresh {
                let b_prev = ((f - 1) * n_joints + j) * 4;
                let b_next = ((f + 1) * n_joints + j) * 4;
                let span_d = Vec3::new(
                    buf[b_next] - buf[b_prev],
                    buf[b_next + 1] - buf[b_prev + 1],
                    buf[b_next + 2] - buf[b_prev + 2],
                )
                .len();
                // Replace only isolated 1-frame spikes where surrounding neighbors agree.
                if span_d < residuals[f] * 0.65 {
                    fixed[f * 3] = 0.5 * (buf[b_prev] + buf[b_next]);
                    fixed[f * 3 + 1] = 0.5 * (buf[b_prev + 1] + buf[b_next + 1]);
                    fixed[f * 3 + 2] = 0.5 * (buf[b_prev + 2] + buf[b_next + 2]);
                }
            }
        }
        // Boundary spike guard: catch first/last frame pops (e.g., seek/EOF jitter).
        if n_frames >= 5 {
            let end_thresh = thresh.max(0.06);
            let p1 = Vec3::new(fixed[3], fixed[4], fixed[5]);
            let p2 = Vec3::new(fixed[6], fixed[7], fixed[8]);
            let d12 = p1.sub(p2).len();
            let p0 = Vec3::new(fixed[0], fixed[1], fixed[2]);
            let d01 = p0.sub(p1).len();
            if get_vis(buf, 0, n_joints, j) > 0.0 && d01 > end_thresh && d01 > d12 * 2.3 + 0.04 {
                let est0 = p1.add(p1.sub(p2).mul(0.5));
                fixed[0] = est0.x;
                fixed[1] = est0.y;
                fixed[2] = est0.z;
            }

            let l_i = n_frames - 1;
            let pn1 = Vec3::new(
                fixed[(l_i - 1) * 3],
                fixed[(l_i - 1) * 3 + 1],
                fixed[(l_i - 1) * 3 + 2],
            );
            let pn2 = Vec3::new(
                fixed[(l_i - 2) * 3],
                fixed[(l_i - 2) * 3 + 1],
                fixed[(l_i - 2) * 3 + 2],
            );
            let dn12 = pn1.sub(pn2).len();
            let pn = Vec3::new(fixed[l_i * 3], fixed[l_i * 3 + 1], fixed[l_i * 3 + 2]);
            let dn_end = pn.sub(pn1).len();
            if get_vis(buf, l_i, n_joints, j) > 0.0 && dn_end > end_thresh && dn_end > dn12 * 2.3 + 0.04 {
                let est_n = pn1.add(pn1.sub(pn2).mul(0.5));
                fixed[l_i * 3] = est_n.x;
                fixed[l_i * 3 + 1] = est_n.y;
                fixed[l_i * 3 + 2] = est_n.z;
            }
        }
        for f in 0..n_frames {
            let b = (f * n_joints + j) * 4;
            buf[b] = fixed[f * 3];
            buf[b + 1] = fixed[f * 3 + 1];
            buf[b + 2] = fixed[f * 3 + 2];
        }
    }
}

/// Apply 1-Euro filter (zero-phase forward+backward averaged if `zero_phase`, else causal).
pub fn filter_joints_one_euro(
    buf: &mut [f32],
    n_frames: usize,
    n_joints: usize,
    fps: f32,
    min_cutoff: f32,
    beta: f32,
    d_cutoff: f32,
    zero_phase: bool,
) {
    if n_frames < 2 || n_joints == 0 {
        return;
    }
    let dt = 1.0 / fps.max(1.0);
    let mut fwd = vec![0.0f32; n_frames];
    let mut bwd = vec![0.0f32; n_frames];

    for j in 0..n_joints {
        for c in 0..3 {
            let mut fx = OneEuro::new(min_cutoff, beta, d_cutoff);
            for f in 0..n_frames {
                fwd[f] = fx.filter(buf[(f * n_joints + j) * 4 + c], dt);
            }
            if zero_phase && n_frames >= 3 {
                let mut bx = OneEuro::new(min_cutoff, beta, d_cutoff);
                for f in (0..n_frames).rev() {
                    bwd[f] = bx.filter(buf[(f * n_joints + j) * 4 + c], dt);
                }
                for f in 0..n_frames {
                    buf[(f * n_joints + j) * 4 + c] = 0.5 * (fwd[f] + bwd[f]);
                }
            } else {
                for f in 0..n_frames {
                    buf[(f * n_joints + j) * 4 + c] = fwd[f];
                }
            }
        }
    }
}

/// Bilateral Gaussian smoothing specifically on Z depth across ALL joints, preserving crisp X/Y
/// while removing MediaPipe's depth wobble consistently on torso and limbs.
pub fn stabilize_all_depths(buf: &mut [f32], n_frames: usize, n_joints: usize, radius: usize, min_vis: f32) {
    if n_frames < 3 || n_joints == 0 || radius == 0 {
        return;
    }
    let sigma = (radius as f32) * 0.55 + 0.35;
    let inv_two_sig2 = 1.0 / (2.0 * sigma * sigma);
    let mut smoothed = vec![0.0f32; n_frames];

    for j in 0..n_joints {
        for f in 0..n_frames {
            let center_b = (f * n_joints + j) * 4;
            let z0 = buf[center_b + 2];
            if !z0.is_finite() {
                smoothed[f] = 0.0;
                continue;
            }
            let start = f.saturating_sub(radius);
            let end = (f + radius).min(n_frames - 1);
            let mut sum = 0.0f32;
            let mut wsum = 0.0f32;
            for k in start..=end {
                let kb = (k * n_joints + j) * 4;
                let zk = buf[kb + 2];
                let vk = buf[kb + 3];
                if !zk.is_finite() {
                    continue;
                }
                let dt = (k as isize - f as isize) as f32;
                let dz = (zk - z0).abs();
                // Spatial range kernel suppresses averaging across true rapid forward thrusts.
                let range_w = (-dz * dz / (2.0 * 0.14 * 0.14)).exp();
                let time_w = (-(dt * dt) * inv_two_sig2).exp();
                let vis_w = if vk >= min_vis { vk.clamp(0.2, 1.0) } else { 0.15 };
                let w = time_w * range_w * vis_w;
                sum += zk * w;
                wsum += w;
            }
            smoothed[f] = if wsum > 1e-6 { sum / wsum } else { z0 };
        }
        for f in 0..n_frames {
            buf[(f * n_joints + j) * 4 + 2] = smoothed[f];
        }
    }
}

/// Enforce median anatomical segment lengths along `(parent, child)` bone pairs.
pub fn enforce_bone_lengths(
    buf: &mut [f32],
    n_frames: usize,
    n_joints: usize,
    chains: &[(usize, usize)],
    min_vis: f32,
) {
    if n_frames == 0 || chains.is_empty() {
        return;
    }
    let mut samples = Vec::with_capacity(n_frames);
    let mut targets = vec![0.0f32; chains.len()];

    for (ci, &(p, c)) in chains.iter().enumerate() {
        if p >= n_joints || c >= n_joints {
            continue;
        }
        samples.clear();
        for f in 0..n_frames {
            let bp = (f * n_joints + p) * 4;
            let bc = (f * n_joints + c) * 4;
            if buf[bp + 3] < min_vis || buf[bc + 3] < min_vis {
                continue;
            }
            let d = Vec3::new(
                buf[bc] - buf[bp],
                buf[bc + 1] - buf[bp + 1],
                buf[bc + 2] - buf[bp + 2],
            )
            .len();
            if d > 1e-4 {
                samples.push(d);
            }
        }
        if !samples.is_empty() {
            targets[ci] = median_f32(&mut samples);
        }
    }

    let mut unit_dirs = vec![Vec3::ZERO; chains.len()];
    let mut has_dir = vec![false; chains.len()];

    for f in 0..n_frames {
        // 1. Capture ALL unit directions BEFORE mutating any joint position in frame f!
        for (ci, &(p, c)) in chains.iter().enumerate() {
            has_dir[ci] = false;
            if targets[ci] <= 1e-4 || p >= n_joints || c >= n_joints {
                continue;
            }
            let bp = (f * n_joints + p) * 4;
            let bc = (f * n_joints + c) * 4;
            let p_pos = Vec3::new(buf[bp], buf[bp + 1], buf[bp + 2]);
            let c_pos = Vec3::new(buf[bc], buf[bc + 1], buf[bc + 2]);
            let dir = c_pos.sub(p_pos);
            let len = dir.len();
            if len > 1e-6 {
                unit_dirs[ci] = dir.mul(1.0 / len);
                has_dir[ci] = true;
            }
        }
        // 2. Reconstruct joint positions down each chain in topological order
        for (ci, &(p, c)) in chains.iter().enumerate() {
            if !has_dir[ci] {
                continue;
            }
            let bp = (f * n_joints + p) * 4;
            let bc = (f * n_joints + c) * 4;
            let p_pos = Vec3::new(buf[bp], buf[bp + 1], buf[bp + 2]);
            let next_c = p_pos.add(unit_dirs[ci].mul(targets[ci]));
            buf[bc] = next_c.x;
            buf[bc + 1] = next_c.y;
            buf[bc + 2] = next_c.z;
        }
    }
}

/// Compute 3D metric root trajectory (`n_frames * 3 [x, y, z]`) from smoothed 2D hip anchors + apparent torso scale.
pub fn compute_root_trajectory(
    buf: &[f32],
    hip2d: &[f32], // n_frames * 4: [x, y, torso_px_scale, valid]
    n_frames: usize,
    n_joints: usize,
    hips_idx: usize,
    spine_idx: usize,
    xy_gain: f32,
    depth_gain: f32,
    out_root: &mut [f32],
) {
    compute_root_trajectory_compensated(
        buf,
        hip2d,
        &[],
        n_frames,
        n_joints,
        hips_idx,
        spine_idx,
        xy_gain,
        depth_gain,
        out_root,
    );
}

/// Camera-compensated 3D metric root trajectory (`cam_motion`: optional `n_frames * 4` `[cum_pan_x_norm, cum_pan_y_norm, cum_zoom, conf]`).
#[allow(clippy::too_many_arguments)]
pub fn compute_root_trajectory_compensated(
    buf: &[f32],
    hip2d: &[f32],
    cam_motion: &[f32],
    n_frames: usize,
    n_joints: usize,
    hips_idx: usize,
    spine_idx: usize,
    xy_gain: f32,
    depth_gain: f32,
    out_root: &mut [f32],
) {
    compute_root_trajectory_compensated_aspect(
        buf,
        hip2d,
        cam_motion,
        n_frames,
        n_joints,
        hips_idx,
        spine_idx,
        xy_gain,
        depth_gain,
        1.0,
        out_root,
    );
}

/// Camera-compensated 3D metric root trajectory scaled consistently across aspect ratios.
#[allow(clippy::too_many_arguments)]
pub fn compute_root_trajectory_compensated_aspect(
    buf: &[f32],
    hip2d: &[f32],
    cam_motion: &[f32],
    n_frames: usize,
    n_joints: usize,
    hips_idx: usize,
    spine_idx: usize,
    xy_gain: f32,
    depth_gain: f32,
    aspect_ratio: f32,
    out_root: &mut [f32],
) {
    let safe_aspect = if aspect_ratio.is_finite() { aspect_ratio.clamp(0.25, 4.0) } else { 1.0 };
    if n_frames == 0 || out_root.len() < n_frames * 3 {
        return;
    }
    let has_cam = cam_motion.len() >= n_frames * 4;
    let cam_at = |f: usize| -> (f32, f32, f32) {
        if !has_cam {
            return (0.0, 0.0, 1.0);
        }
        let b = f * 4;
        let conf = cam_motion[b + 3];
        if conf <= 0.20 {
            return (0.0, 0.0, 1.0);
        }
        (
            cam_motion[b],
            cam_motion[b + 1],
            cam_motion[b + 2].clamp(0.4, 2.5),
        )
    };

    let mut torso_lens = Vec::with_capacity(n_frames);
    let mut scales_2d = Vec::with_capacity(n_frames);
    for f in 0..n_frames {
        if hips_idx < n_joints && spine_idx < n_joints {
            let bh = (f * n_joints + hips_idx) * 4;
            let bs = (f * n_joints + spine_idx) * 4;
            let d = Vec3::new(
                buf[bs] - buf[bh],
                buf[bs + 1] - buf[bh + 1],
                buf[bs + 2] - buf[bh + 2],
            )
            .len();
            if d > 1e-4 {
                torso_lens.push(d);
            }
        }
        if hip2d.len() >= (f + 1) * 4 && hip2d[f * 4 + 3] > 0.5 && hip2d[f * 4 + 2] > 1e-4 {
            let (_, _, cz) = cam_at(f);
            scales_2d.push(hip2d[f * 4 + 2] / cz);
        }
    }

    let ref_3d = if torso_lens.is_empty() { 0.45 } else { median_f32(&mut torso_lens) };
    let mut valid_2d: Vec<usize> = (0..n_frames)
        .filter(|&f| hip2d.len() >= (f + 1) * 4 && hip2d[f * 4 + 3] > 0.5 && hip2d[f * 4 + 2] > 1e-4)
        .collect();
    if valid_2d.is_empty() {
        out_root[..n_frames * 3].fill(0.0);
        return;
    }
    let f0 = valid_2d[0];
    let (pan0_x, pan0_y, zoom0) = cam_at(f0);
    let x0 = hip2d[f0 * 4];
    let y0 = hip2d[f0 * 4 + 1];
    let s0 = if !scales_2d.is_empty() {
        // Use median of first 12 valid camera-normalized frames as rest camera distance reference.
        let mut head_scales: Vec<f32> = scales_2d.iter().copied().take(12).collect();
        median_f32(&mut head_scales).max(1e-4)
    } else {
        (hip2d[f0 * 4 + 2] / zoom0).max(1e-4)
    };

    // Pass 1: raw metric trajectory (with background pan/zoom subtracted when available).
    let mut raw = vec![0.0f32; n_frames * 3];
    for f in 0..n_frames {
        let valid = hip2d.len() >= (f + 1) * 4 && hip2d[f * 4 + 3] > 0.5 && hip2d[f * 4 + 2] > 1e-4;
        if !valid {
            if f > 0 {
                raw[f * 3] = raw[(f - 1) * 3];
                raw[f * 3 + 1] = raw[(f - 1) * 3 + 1];
                raw[f * 3 + 2] = raw[(f - 1) * 3 + 2];
            }
            continue;
        }
        let (px, py, pz) = cam_at(f);
        let rel_zoom = (pz / zoom0).clamp(0.4, 2.5);
        let hx = hip2d[f * 4];
        let hy = hip2d[f * 4 + 1];
        let s = (hip2d[f * 4 + 2] / rel_zoom).max(1e-4);
        let m_per_unit = (ref_3d / s) * xy_gain;
        let dx = ((hx - x0) + (px - pan0_x) * safe_aspect * 1000.0) * m_per_unit;
        let dy = -((hy - y0) + (py - pan0_y) * 1000.0) * m_per_unit;
        // Larger apparent subject scale (after removing camera zoom) -> closer (+Z); smaller -> farther (-Z).
        let raw_dz = (1.0 - s0 / s) * depth_gain;
        raw[f * 3] = dx.clamp(-4.5, 4.5);
        raw[f * 3 + 1] = dy.clamp(-1.5, 1.5);
        raw[f * 3 + 2] = raw_dz.clamp(-1.8, 1.8);
    }

    // Re-zero first valid frame & box-smooth Z strongly + XY lightly to remove micro-jitter.
    let _ = valid_2d.clear();
    let r0x = raw[f0 * 3];
    let r0y = raw[f0 * 3 + 1];
    let r0z = raw[f0 * 3 + 2];
    for f in 0..n_frames {
        raw[f * 3] -= r0x;
        raw[f * 3 + 1] -= r0y;
        raw[f * 3 + 2] -= r0z;
    }

    for f in 0..n_frames {
        let s_xy = f.saturating_sub(1);
        let e_xy = (f + 1).min(n_frames - 1);
        let mut sx = 0.0f32;
        let mut sy = 0.0f32;
        let cnt_xy = (e_xy - s_xy + 1) as f32;
        for k in s_xy..=e_xy {
            sx += raw[k * 3];
            sy += raw[k * 3 + 1];
        }
        let s_z = f.saturating_sub(4);
        let e_z = (f + 4).min(n_frames - 1);
        let mut sz = 0.0f32;
        let cnt_z = (e_z - s_z + 1) as f32;
        for k in s_z..=e_z {
            sz += raw[k * 3 + 2];
        }
        out_root[f * 3] = sx / cnt_xy;
        out_root[f * 3 + 1] = sy / cnt_xy;
        out_root[f * 3 + 2] = sz / cnt_z;
    }
}

/// Analytical 2-bone knee solver preserving thigh `len_u` & shin `len_l` with pole vector `pole`.
pub(crate) fn solve_two_bone_mid_joint(root: Vec3, end_eff: Vec3, len_u: f32, len_l: f32, pole_hint: Vec3) -> Vec3 {
    let to_end = end_eff.sub(root);
    let max_reach = (len_u + len_l) * 0.996;
    let min_reach = (len_u - len_l).abs().max(0.02);
    let mut dist = to_end.len();
    if dist < 1e-6 {
        return root.add(pole_hint.normalized().mul(len_u));
    }
    let dir = to_end.mul(1.0 / dist);
    dist = dist.clamp(min_reach, max_reach);

    let cos_a = ((len_u * len_u + dist * dist - len_l * len_l) / (2.0 * len_u * dist)).clamp(-1.0, 1.0);
    let sin_a = (1.0 - cos_a * cos_a).max(0.0).sqrt();

    let mut bend = pole_hint.sub(root).project_onto_plane(dir);
    if bend.len_sq() < 1e-8 {
        bend = Vec3::Z.project_onto_plane(dir);
        if bend.len_sq() < 1e-8 {
            bend = Vec3::X.project_onto_plane(dir);
        }
    }
    let bend_dir = bend.normalized();
    root.add(dir.mul(len_u * cos_a)).add(bend_dir.mul(len_u * sin_a))
}

#[inline]
pub(crate) fn get_joint(buf: &[f32], f: usize, n_joints: usize, j: usize) -> Vec3 {
    let b = (f * n_joints + j) * 4;
    Vec3::new(buf[b], buf[b + 1], buf[b + 2])
}

#[inline]
pub(crate) fn set_joint(buf: &mut [f32], f: usize, n_joints: usize, j: usize, v: Vec3) {
    let b = (f * n_joints + j) * 4;
    buf[b] = v.x;
    buf[b + 1] = v.y;
    buf[b + 2] = v.z;
}

/// Apply smooth Hermite ease-in/ease-out Foot-Lock IK directly on joint buffer + root trajectory.
/// Returns total number of foot-contact frames locked across left & right legs.
pub fn apply_foot_lock(
    buf: &mut [f32],
    root: &mut [f32],
    n_frames: usize,
    n_joints: usize,
    fps: f32,
    l_hip: usize,
    l_knee: usize,
    l_ankle: usize,
    l_foot: Option<usize>,
    r_hip: usize,
    r_knee: usize,
    r_ankle: usize,
    r_foot: Option<usize>,
    vel_thresh: f32,
    floor_tol: f32,
    blend_frames: usize,
    out_flags: Option<&mut [u8]>, // n_frames * 2 bytes: [left_locked, right_locked]
) -> usize {
    if n_frames < 3 || n_joints == 0 {
        return 0;
    }

    // Axis-agnostic floor detection: support both MediaPipe (+Y down: ankle > hip)
    // and Three.js (+Y up: ankle < hip).
    let mut hip_to_ankle_ys = Vec::with_capacity(n_frames * 2);
    for f in 0..n_frames {
        hip_to_ankle_ys.push(get_joint(buf, f, n_joints, l_ankle).y - get_joint(buf, f, n_joints, l_hip).y);
        hip_to_ankle_ys.push(get_joint(buf, f, n_joints, r_ankle).y - get_joint(buf, f, n_joints, r_hip).y);
    }
    let is_y_down = median_f32(&mut hip_to_ankle_ys) > 0.0;
    // `root` comes from `compute_root_trajectory` in +Y up / +Z forward space; project into `buf`'s coordinate axis.
    let root_at = |frame: usize| -> Vec3 {
        let rx = root[frame * 3];
        let ry = root[frame * 3 + 1];
        let rz = root[frame * 3 + 2];
        if is_y_down {
            Vec3::new(rx, -ry, -rz)
        } else {
            Vec3::new(rx, ry, rz)
        }
    };

    // Floor level = 97th percentile in +Y down (lowest visual foot), or 3rd percentile in +Y up.
    // Also track bounded per-side ground threshold so slight left/right hip tilt never starves one leg's lock.
    let mut y_vals = Vec::with_capacity(n_frames * 2);
    let mut l_y_vals = Vec::with_capacity(n_frames);
    let mut r_y_vals = Vec::with_capacity(n_frames);
    for f in 0..n_frames {
        let r = root_at(f);
        let ly = get_joint(buf, f, n_joints, l_ankle).y + r.y;
        let ry = get_joint(buf, f, n_joints, r_ankle).y + r.y;
        y_vals.push(ly);
        y_vals.push(ry);
        l_y_vals.push(ly);
        r_y_vals.push(ry);
    }
    y_vals.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    l_y_vals.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    r_y_vals.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let pct = if is_y_down { 0.97 } else { 0.03 };
    let pct_side = if is_y_down { 0.94 } else { 0.06 };
    let pct_idx = ((y_vals.len() as f32) * pct).floor() as usize;
    let floor_y = y_vals[pct_idx.min(y_vals.len() - 1)];
    let l_idx = ((l_y_vals.len() as f32) * pct_side).floor() as usize;
    let r_idx = ((r_y_vals.len() as f32) * pct_side).floor() as usize;
    let l_floor_raw = l_y_vals[l_idx.min(l_y_vals.len() - 1)];
    let r_floor_raw = r_y_vals[r_idx.min(r_y_vals.len() - 1)];
    let floor_l = if is_y_down {
        l_floor_raw.clamp(floor_y - 0.05, floor_y + 0.025)
    } else {
        l_floor_raw.clamp(floor_y - 0.025, floor_y + 0.05)
    };
    let floor_r = if is_y_down {
        r_floor_raw.clamp(floor_y - 0.05, floor_y + 0.025)
    } else {
        r_floor_raw.clamp(floor_y - 0.025, floor_y + 0.05)
    };

    // Sliding local stance floor envelope: tolerates mild monocular scale/camera pitch drift
    // without forcing the entire clip to one rigid global constant `floor_y`, while ignoring airborne jumps.
    let mut local_floor = vec![floor_y; n_frames];
    let half_win = 18usize;
    let mut win_vals = Vec::with_capacity((half_win * 2 + 1) * 2);
    for f in 0..n_frames {
        win_vals.clear();
        let w_start = f.saturating_sub(half_win);
        let w_end = (f + half_win + 1).min(n_frames);
        for k in w_start..w_end {
            let rk = root_at(k);
            let ly = get_joint(buf, k, n_joints, l_ankle).y + rk.y;
            let ry = get_joint(buf, k, n_joints, r_ankle).y + rk.y;
            if (ly - floor_y).abs() <= 0.11 {
                win_vals.push(ly);
            }
            if (ry - floor_y).abs() <= 0.11 {
                win_vals.push(ry);
            }
        }
        if !win_vals.is_empty() {
            win_vals.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
            let w_pct = if is_y_down { 0.94 } else { 0.06 };
            let idx = ((win_vals.len() as f32) * w_pct).floor() as usize;
            let raw = win_vals[idx.min(win_vals.len() - 1)];
            local_floor[f] = raw.clamp(floor_y - 0.075, floor_y + 0.075);
        }
    }
    if n_frames >= 5 {
        let raw_lf = local_floor.clone();
        for f in 0..n_frames {
            let s = f.saturating_sub(4);
            let e = (f + 5).min(n_frames);
            let mut sum = 0.0f32;
            for k in s..e {
                sum += raw_lf[k];
            }
            local_floor[f] = sum / (e - s) as f32;
        }
    }

    // Median segment lengths for two-bone knee reconstruction.
    let mut lu_samples = Vec::with_capacity(n_frames);
    let mut ll_samples = Vec::with_capacity(n_frames);
    let mut ru_samples = Vec::with_capacity(n_frames);
    let mut rl_samples = Vec::with_capacity(n_frames);
    for f in 0..n_frames {
        lu_samples.push(get_joint(buf, f, n_joints, l_knee).sub(get_joint(buf, f, n_joints, l_hip)).len());
        ll_samples.push(get_joint(buf, f, n_joints, l_ankle).sub(get_joint(buf, f, n_joints, l_knee)).len());
        ru_samples.push(get_joint(buf, f, n_joints, r_knee).sub(get_joint(buf, f, n_joints, r_hip)).len());
        rl_samples.push(get_joint(buf, f, n_joints, r_ankle).sub(get_joint(buf, f, n_joints, r_knee)).len());
    }
    let l_len_u = median_f32(&mut lu_samples).max(0.05);
    let l_len_l = median_f32(&mut ll_samples).max(0.05);
    let r_len_u = median_f32(&mut ru_samples).max(0.05);
    let r_len_l = median_f32(&mut rl_samples).max(0.05);

    let legs = [
        (0usize, l_hip, l_knee, l_ankle, l_foot, l_len_u, l_len_l, floor_l),
        (1usize, r_hip, r_knee, r_ankle, r_foot, r_len_u, r_len_l, floor_r),
    ];

    let mut total_locked = 0usize;
    let mut contacts = vec![false; n_frames];
    let mut weights = vec![0.0f32; n_frames];
    let mut anchor_pos = vec![Vec3::ZERO; n_frames];

    // Copy flags buffer slice reference cleanly.
    let mut local_flags = vec![0u8; n_frames * 2];

    for &(side, hip, knee, ankle, foot_opt, len_u, len_l, side_floor_y) in &legs {
        if hip >= n_joints || knee >= n_joints || ankle >= n_joints {
            continue;
        }
        let reach_max = (len_u + len_l) * 0.985;
        let reach_min = (len_u - len_l).abs().max(0.22 * (len_u + len_l));

        contacts.fill(false);
        for f in 0..n_frames {
            let p_curr = get_joint(buf, f, n_joints, ankle).add(root_at(f));
            let speed = if f > 0 {
                let p_prev = get_joint(buf, f - 1, n_joints, ankle).add(root_at(f - 1));
                p_curr.sub(p_prev).len() * fps.max(1.0)
            } else {
                0.0
            };
            let ref_floor = local_floor[f].clamp(side_floor_y - 0.05, side_floor_y + 0.05);
            let height_above_floor = if is_y_down {
                ref_floor - p_curr.y
            } else {
                p_curr.y - ref_floor
            };
            let prev_planted = f > 0 && contacts[f - 1];
            let h_gate = if prev_planted { floor_tol * 1.45 } else { floor_tol };
            let v_gate = if prev_planted { vel_thresh * 1.55 } else { vel_thresh };
            contacts[f] = height_above_floor <= h_gate && speed <= v_gate;
        }
        // Bridge 1-frame contact dropouts and discard isolated 1-frame blips.
        let orig = contacts.clone();
        for f in 1..(n_frames - 1) {
            if !orig[f] && orig[f - 1] && orig[f + 1] {
                contacts[f] = true;
            } else if orig[f] && !orig[f - 1] && !orig[f + 1] {
                contacts[f] = false;
            }
        }

        // Identify contiguous contact segments and compute median XZ + local stance Y anchor per segment.
        weights.fill(0.0);
        anchor_pos.fill(Vec3::ZERO);
        let mut f = 0;
        while f < n_frames {
            if !contacts[f] {
                f += 1;
                continue;
            }
            let start = f;
            while f < n_frames && contacts[f] {
                f += 1;
            }
            let end = f; // exclusive
            let mut xs = Vec::with_capacity(end - start);
            let mut zs = Vec::with_capacity(end - start);
            let mut ys = Vec::with_capacity(end - start);
            for k in start..end {
                let w = get_joint(buf, k, n_joints, ankle).add(root_at(k));
                xs.push(w.x);
                zs.push(w.z);
                ys.push(local_floor[k].clamp(side_floor_y - 0.05, side_floor_y + 0.05));
                total_locked += 1;
                local_flags[k * 2 + side] = 1;
            }
            let ax = median_f32(&mut xs);
            let az = median_f32(&mut zs);
            let ay = median_f32(&mut ys);
            let anchor = Vec3::new(ax, ay, az);

            for k in start..end {
                weights[k] = 1.0;
                anchor_pos[k] = Vec3::new(
                    anchor.x,
                    local_floor[k].clamp(side_floor_y - 0.05, side_floor_y + 0.05),
                    anchor.z,
                );
            }
            // Smooth ease-in before `start` and ease-out after `end - 1` so joints never snap!
            if blend_frames > 0 {
                for b in 1..=blend_frames {
                    if start >= b {
                        let k = start - b;
                        if !contacts[k] {
                            let u = 1.0 - (b as f32 / (blend_frames + 1) as f32);
                            let w = u * u * (3.0 - 2.0 * u);
                            if w > weights[k] {
                                weights[k] = w;
                                anchor_pos[k] = anchor;
                            }
                        }
                    }
                    let k2 = end - 1 + b;
                    if k2 < n_frames && !contacts[k2] {
                        let u = 1.0 - (b as f32 / (blend_frames + 1) as f32);
                        let w = u * u * (3.0 - 2.0 * u);
                        if w > weights[k2] {
                            weights[k2] = w;
                            anchor_pos[k2] = anchor;
                        }
                    }
                }
            }
        }

        // Apply weighted anchor + reach-clamped two-bone knee correction (no hyperextension or leg distortion).
        for f in 0..n_frames {
            let w = weights[f];
            if w <= 1e-4 {
                continue;
            }
            let r_vec = root_at(f);
            let target_local = anchor_pos[f].sub(r_vec);
            let old_ankle = get_joint(buf, f, n_joints, ankle);
            let mut new_ankle = old_ankle.lerp(target_local, w);

            let hip_pos = get_joint(buf, f, n_joints, hip);
            let knee_pos = get_joint(buf, f, n_joints, knee);

            // Softly release Foot-Lock if anchor pulls leg past 97% of anatomical max reach,
            // then project onto [reach_min, reach_max] so two-bone IK never hyperextends.
            let cand_dist = new_ankle.sub(hip_pos).len();
            if cand_dist > reach_max * 0.97 {
                let excess = ((cand_dist - reach_max * 0.97)
                    / (0.10 * (len_u + len_l)).max(0.05))
                    .clamp(0.0, 1.0);
                let fade = 1.0 - excess * excess * (3.0 - 2.0 * excess);
                new_ankle = old_ankle.lerp(target_local, w * fade);
            }
            let to_ank = new_ankle.sub(hip_pos);
            let ank_dist = to_ank.len();
            if ank_dist > reach_max && ank_dist > 1e-6 {
                new_ankle = hip_pos.add(to_ank.mul(reach_max / ank_dist));
            } else if ank_dist < reach_min && ank_dist > 1e-6 {
                new_ankle = hip_pos.add(to_ank.mul(reach_min / ank_dist));
            }

            let new_knee = solve_two_bone_mid_joint(hip_pos, new_ankle, len_u, len_l, knee_pos);

            set_joint(buf, f, n_joints, ankle, new_ankle);
            set_joint(buf, f, n_joints, knee, new_knee);

            if let Some(fj) = foot_opt {
                if fj < n_joints {
                    let delta = new_ankle.sub(old_ankle);
                    let mut new_foot = get_joint(buf, f, n_joints, fj).add(delta);
                    let min_local_y = local_floor[f] - r_vec.y;
                    if is_y_down {
                        if new_foot.y > min_local_y {
                            new_foot.y = min_local_y;
                        }
                    } else if new_foot.y < min_local_y {
                        new_foot.y = min_local_y;
                    }
                    set_joint(buf, f, n_joints, fj, new_foot);
                }
            }
        }
    }

    if let Some(flags) = out_flags {
        let len = flags.len().min(local_flags.len());
        flags[..len].copy_from_slice(&local_flags[..len]);
    }
    total_locked
}

#[inline]
fn smoothstep_f32(edge0: f32, edge1: f32, x: f32) -> f32 {
    let t = ((x - edge0) / (edge1 - edge0).max(1e-5)).clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

#[inline]
pub(crate) fn closest_point_on_segment(p: Vec3, a: Vec3, b: Vec3) -> Vec3 {
    let ab = b.sub(a);
    let denom = ab.len_sq();
    if denom < 1e-8 {
        return a;
    }
    let t = (p.sub(a).dot(ab) / denom).clamp(0.0, 1.0);
    a.add(ab.mul(t))
}

#[inline]
pub(crate) fn get_vis(buf: &[f32], f: usize, n_joints: usize, j: usize) -> f32 {
    if j >= n_joints {
        return 0.0;
    }
    buf[(f * n_joints + j) * 4 + 3]
}

/// Fuses high-precision 2D image coordinates (`lm2d`: `[x2d, y2d, vis2d]` per joint) with 3D world coordinates
/// to sharpen XY limb fidelity during fast 2D-to-3D transitions while suppressing monocular Z pumping.
pub fn fuse_2d_to_3d_kinematic(
    buf: &mut [f32],
    lm2d: &[f32],
    n_frames: usize,
    n_joints: usize,
    l_hip: usize,
    r_hip: usize,
    l_sh: usize,
    r_sh: usize,
    min_vis: f32,
) {
    fuse_2d_to_3d_kinematic_aspect(buf, lm2d, n_frames, n_joints, l_hip, r_hip, l_sh, r_sh, min_vis, 1.0);
}

#[allow(clippy::too_many_arguments)]
pub fn fuse_2d_to_3d_kinematic_aspect(
    buf: &mut [f32],
    lm2d: &[f32],
    n_frames: usize,
    n_joints: usize,
    l_hip: usize,
    r_hip: usize,
    l_sh: usize,
    r_sh: usize,
    min_vis: f32,
    aspect_ratio: f32,
) {
    if n_frames < 3 || lm2d.len() < n_frames * n_joints * 3 {
        return;
    }
    if l_hip >= n_joints || r_hip >= n_joints || l_sh >= n_joints || r_sh >= n_joints {
        return;
    }
    let aspect = if aspect_ratio.is_finite() && aspect_ratio > 0.25 && aspect_ratio < 4.0 {
        aspect_ratio
    } else {
        1.0
    };

    // Auto-detect whether 3D world buffer uses +Y down (MediaPipe) or +Y up (Three.js)
    let mut y_sign_samples = Vec::with_capacity(n_frames);
    let mut scale_ratios = Vec::with_capacity(n_frames);
    let mut frame_scales = vec![0.0f32; n_frames];
    let mut mid_hip_2d = vec![[0.5f32, 0.5f32]; n_frames];

    for f in 0..n_frames {
        let b2_lh = (f * n_joints + l_hip) * 3;
        let b2_rh = (f * n_joints + r_hip) * 3;
        let b2_ls = (f * n_joints + l_sh) * 3;
        let b2_rs = (f * n_joints + r_sh) * 3;

        let mh2_x = 0.5 * (lm2d[b2_lh] + lm2d[b2_rh]);
        let mh2_y = 0.5 * (lm2d[b2_lh + 1] + lm2d[b2_rh + 1]);
        mid_hip_2d[f] = [mh2_x, mh2_y];

        let core_v2 = lm2d[b2_lh + 2]
            .min(lm2d[b2_rh + 2])
            .min(lm2d[b2_ls + 2])
            .min(lm2d[b2_rs + 2]);
        let core_v3 = get_vis(buf, f, n_joints, l_hip)
            .min(get_vis(buf, f, n_joints, r_hip))
            .min(get_vis(buf, f, n_joints, l_sh))
            .min(get_vis(buf, f, n_joints, r_sh));

        if core_v2 < min_vis || core_v3 < min_vis {
            continue;
        }

        let ms2_x = 0.5 * (lm2d[b2_ls] + lm2d[b2_rs]);
        let ms2_y = 0.5 * (lm2d[b2_ls + 1] + lm2d[b2_rs + 1]);
        let d2 = (((ms2_x - mh2_x) * aspect).powi(2) + (ms2_y - mh2_y).powi(2)).sqrt();

        let mh3 = get_joint(buf, f, n_joints, l_hip)
            .add(get_joint(buf, f, n_joints, r_hip))
            .mul(0.5);
        let ms3 = get_joint(buf, f, n_joints, l_sh)
            .add(get_joint(buf, f, n_joints, r_sh))
            .mul(0.5);
        let t3_xy = ((ms3.x - mh3.x).powi(2) + (ms3.y - mh3.y).powi(2)).sqrt();

        if d2 > 0.03 && t3_xy > 0.15 {
            let ratio = (t3_xy / d2).clamp(0.4, 8.0);
            scale_ratios.push(ratio);
            frame_scales[f] = ratio;
        }
        if (ms3.y - mh3.y).abs() > 0.1 {
            y_sign_samples.push(ms3.y - mh3.y);
        }
    }

    if scale_ratios.is_empty() {
        return;
    }
    let med_scale = median_f32(&mut scale_ratios);
    // In 2D image coordinates, shoulder.y < hip.y (-Y up). Match 3D Y convention:
    // If 3D is +Y down (ms3.y < mh3.y), multiplier = +1; if +Y up (ms3.y > mh3.y), multiplier = -1.
    let y2_to_y3 = if !y_sign_samples.is_empty() && median_f32(&mut y_sign_samples) > 0.0 {
        -1.0f32
    } else {
        1.0f32
    };

    for f in 0..n_frames {
        // Fill frame scale smoothly around median to ignore oblique shoulder pitch shrinkage
        let raw_s = if frame_scales[f] > 0.0 { frame_scales[f] } else { med_scale };
        let scale = (0.70 * med_scale + 0.30 * raw_s).clamp(med_scale * 0.72, med_scale * 1.35);

        let mh3 = get_joint(buf, f, n_joints, l_hip)
            .add(get_joint(buf, f, n_joints, r_hip))
            .mul(0.5);
        let [mh2_x, mh2_y] = mid_hip_2d[f];

        for j in 0..n_joints {
            if j == l_hip || j == r_hip {
                continue;
            }
            let b2 = (f * n_joints + j) * 3;
            let x2 = lm2d[b2];
            let y2 = lm2d[b2 + 1];
            let v2 = lm2d[b2 + 2];
            if v2 < 0.48 || !x2.is_finite() || !y2.is_finite() || (x2 == 0.0 && y2 == 0.0) {
                continue;
            }
            let p3 = get_joint(buf, f, n_joints, j);
            let proj_x = mh3.x + (x2 - mh2_x) * aspect * scale;
            let proj_y = mh3.y + (y2 - mh2_y) * scale * y2_to_y3;

            // Soft taper up to 0.72m rejects multi-person outliers while keeping large dynamic
            // limb extensions (high knees, raised elbows, strides) aligned with 2D silhouette.
            let dev = ((proj_x - p3.x).powi(2) + (proj_y - p3.y).powi(2)).sqrt();
            if dev > 0.72 {
                continue;
            }
            let taper = if dev <= 0.32 {
                1.0
            } else {
                (1.0 - (dev - 0.32) / 0.40).clamp(0.18, 1.0)
            };
            let base_w = if j == l_sh || j == r_sh {
                0.38
            } else if v2 > 0.72 {
                0.58
            } else {
                0.44
            };
            let w_xy = base_w * smoothstep_f32(0.45, 0.90, v2) * taper;
            let b3 = (f * n_joints + j) * 4;
            buf[b3] = p3.x + (proj_x - p3.x) * w_xy;
            buf[b3 + 1] = p3.y + (proj_y - p3.y) * w_xy;
        }
    }
}

/// Unswaps sudden left/right limb crossover glitches (common in 2D profile crossings).
pub fn repair_lr_swaps(
    buf: &mut [f32],
    n_frames: usize,
    n_joints: usize,
    pairs: &[(usize, usize)],
) {
    if n_frames < 4 || pairs.is_empty() {
        return;
    }
    for f in 1..(n_frames - 1) {
        for &(jl, jr) in pairs {
            if jl >= n_joints || jr >= n_joints {
                continue;
            }
            let l_prev = get_joint(buf, f - 1, n_joints, jl);
            let r_prev = get_joint(buf, f - 1, n_joints, jr);
            let l_curr = get_joint(buf, f, n_joints, jl);
            let r_curr = get_joint(buf, f, n_joints, jr);
            let l_next = get_joint(buf, f + 1, n_joints, jl);
            let r_next = get_joint(buf, f + 1, n_joints, jr);

            let l_mid = l_prev.lerp(l_next, 0.5);
            let r_mid = r_prev.lerp(r_next, 0.5);

            let keep_cost = l_curr.sub(l_mid).len_sq() + r_curr.sub(r_mid).len_sq();
            let swap_cost = r_curr.sub(l_mid).len_sq() + l_curr.sub(r_mid).len_sq();

            // Swap when cross-matching is > 2.2x closer AND neighbors agree strongly with unswapped path
            let neighbor_sep = l_mid.sub(r_mid).len_sq();
            if neighbor_sep > 0.015 && keep_cost > 0.03 && swap_cost < keep_cost * 0.42 {
                let vl = get_vis(buf, f, n_joints, jl);
                let vr = get_vis(buf, f, n_joints, jr);
                set_joint(buf, f, n_joints, jl, r_curr);
                set_joint(buf, f, n_joints, jr, l_curr);
                buf[(f * n_joints + jl) * 4 + 3] = vr;
                buf[(f * n_joints + jr) * 4 + 3] = vl;
            }
        }
    }
}

/// Blender-inspired Occlusion Recovery & Torso Self-Collision Prevention ("tránh dính người"):
/// 1. Replaces persistently occluded far-side arm joints (`vis < min_vis`, e.g. side-profile video)
///    with natural anatomical relaxed postures + subtle contralateral stride swing (instead of
///    freezing in T-pose or collapsing into the chest).
/// 2. Enforces soft Pelvis/Chest/Head clearance capsules so limbs never stab through or stick to the torso.
#[allow(clippy::too_many_arguments)]
pub fn resolve_occlusions_and_self_collision(
    buf: &mut [f32],
    n_frames: usize,
    n_joints: usize,
    hips_idx: usize,
    spine_idx: usize,
    neck_idx: usize,
    l_sh: usize,
    r_sh: usize,
    l_elb: usize,
    r_elb: usize,
    l_wri: usize,
    r_wri: usize,
    l_han: usize,
    r_han: usize,
    l_hip: usize,
    r_hip: usize,
    l_kne: usize,
    r_kne: usize,
    min_vis: f32,
    strength: f32,
) {
    if n_frames == 0 || strength <= 1e-4 {
        return;
    }
    if l_sh >= n_joints || r_sh >= n_joints || l_hip >= n_joints || r_hip >= n_joints {
        return;
    }
    let s = strength.clamp(0.0, 1.0);

    // Measure median limb lengths so natural occluded pose preserves exact skeleton scale
    let mut upper_lens = Vec::with_capacity(n_frames * 2);
    let mut fore_lens = Vec::with_capacity(n_frames * 2);
    let mut sh_widths = Vec::with_capacity(n_frames);
    let mut hip_widths = Vec::with_capacity(n_frames);
    for f in 0..n_frames {
        let ls = get_joint(buf, f, n_joints, l_sh);
        let rs = get_joint(buf, f, n_joints, r_sh);
        let lh = get_joint(buf, f, n_joints, l_hip);
        let rh = get_joint(buf, f, n_joints, r_hip);
        sh_widths.push(ls.sub(rs).len());
        hip_widths.push(lh.sub(rh).len());
        if l_elb < n_joints && get_vis(buf, f, n_joints, l_elb) >= min_vis {
            upper_lens.push(get_joint(buf, f, n_joints, l_elb).sub(ls).len());
        }
        if r_elb < n_joints && get_vis(buf, f, n_joints, r_elb) >= min_vis {
            upper_lens.push(get_joint(buf, f, n_joints, r_elb).sub(rs).len());
        }
        if l_elb < n_joints && l_wri < n_joints && get_vis(buf, f, n_joints, l_wri) >= min_vis {
            fore_lens.push(get_joint(buf, f, n_joints, l_wri).sub(get_joint(buf, f, n_joints, l_elb)).len());
        }
        if r_elb < n_joints && r_wri < n_joints && get_vis(buf, f, n_joints, r_wri) >= min_vis {
            fore_lens.push(get_joint(buf, f, n_joints, r_wri).sub(get_joint(buf, f, n_joints, r_elb)).len());
        }
    }

    let torso_sh_w = median_f32(&mut sh_widths).clamp(0.24, 0.55);
    let torso_hip_w = median_f32(&mut hip_widths).clamp(0.16, 0.42);
    let upper_len = if !upper_lens.is_empty() { median_f32(&mut upper_lens).clamp(0.18, 0.40) } else { 0.28 };
    let fore_len = if !fore_lens.is_empty() { median_f32(&mut fore_lens).clamp(0.16, 0.36) } else { 0.25 };

    let r_chest = (torso_sh_w * 0.44).clamp(0.12, 0.18);
    let r_pelvis = (torso_hip_w * 0.72).clamp(0.12, 0.19);
    let r_thigh = (torso_hip_w * 0.40).clamp(0.08, 0.12);
    let hard_s = if s >= 0.55 { 1.0 } else { s };

    // Smoothly track contralateral thigh stride phase for natural arm counter-swing when occluded
    for f in 0..n_frames {
        let ls = get_joint(buf, f, n_joints, l_sh);
        let rs = get_joint(buf, f, n_joints, r_sh);
        let lh = get_joint(buf, f, n_joints, l_hip);
        let rh = get_joint(buf, f, n_joints, r_hip);

        let mid_hip = if hips_idx < n_joints && get_joint(buf, f, n_joints, hips_idx).len_sq() > 1e-8 {
            get_joint(buf, f, n_joints, hips_idx)
        } else {
            lh.add(rh).mul(0.5)
        };
        let mid_sh = if neck_idx < n_joints && get_joint(buf, f, n_joints, neck_idx).sub(mid_hip).len_sq() > 0.04 {
            get_joint(buf, f, n_joints, neck_idx)
        } else {
            ls.add(rs).mul(0.5)
        };
        let _sp = if spine_idx < n_joints { get_joint(buf, f, n_joints, spine_idx) } else { mid_hip.lerp(mid_sh, 0.65) };

        // Anatomically consistent orthonormal basis in BOTH +Y down & +Y up:
        // side = left - right; up = mid_sh - mid_hip; fwd = side x up
        let torso_up = mid_sh.sub(mid_hip).normalized();
        if torso_up.len_sq() < 1e-6 {
            continue;
        }
        let mut torso_side = ls.sub(rs).mul(0.6).add(lh.sub(rh).mul(0.4)).project_onto_plane(torso_up);
        if torso_side.len_sq() < 1e-6 {
            torso_side = Vec3::X;
        } else {
            torso_side = torso_side.normalized();
        }
        let torso_fwd = torso_side.cross(torso_up).normalized();

        let cap_a = mid_hip.lerp(mid_sh, 0.16);
        let cap_b = mid_sh.lerp(mid_hip, 0.05);
        let lk_opt = if l_kne < n_joints && get_joint(buf, f, n_joints, l_kne).sub(lh).len_sq() > 0.015 {
            Some(get_joint(buf, f, n_joints, l_kne))
        } else {
            None
        };
        let rk_opt = if r_kne < n_joints && get_joint(buf, f, n_joints, r_kne).sub(rh).len_sq() > 0.015 {
            Some(get_joint(buf, f, n_joints, r_kne))
        } else {
            None
        };

        let push_out_of_torso = |pt: Vec3, lat_sign: f32, clearance: f32, low_vis: bool| -> Vec3 {
            let q_chest = closest_point_on_segment(pt, cap_a, cap_b);
            let q_pelvis = mid_hip;
            let req_chest = r_chest + clearance;
            let req_pelvis = r_pelvis + clearance;

            let diff_c = pt.sub(q_chest);
            let diff_p = pt.sub(q_pelvis);
            let dc = diff_c.len();
            let dp = diff_p.len();

            let (q, diff, d, req) = if (dp - req_pelvis) < (dc - req_chest) {
                (q_pelvis, diff_p, dp, req_pelvis)
            } else {
                (q_chest, diff_c, dc, req_chest)
            };

            let lat_axis = torso_side.mul(lat_sign);
            let lat_coord = diff.dot(lat_axis);
            let fwd_coord = diff.dot(torso_fwd);

            // Anisotropic anatomical torso ellipsoid: shallower anterior/posterior ribcage depth
            // avoids pushing valid arms-in-front-of-chest choreography away, while catching genuine
            // core penetration (`|fwd| < r_depth`) or occluded arms collapsing behind spine.
            let r_depth = (0.095 + clearance * 0.55).clamp(0.10, 0.155);
            let lat_span = req.max(0.12);
            let radial_xy_sq = (lat_coord / lat_span).powi(2) + (fwd_coord / r_depth).powi(2);
            let penetrating = radial_xy_sq < 1.0 && diff.dot(torso_up).abs() < 0.34;
            let crossed_behind = lat_coord < -0.025 && fwd_coord < 0.04;
            let mut out = if penetrating || crossed_behind {
                let target_dir = if d > req * 0.45 && !crossed_behind && !low_vis {
                    let radial = diff.project_onto_plane(torso_up);
                    let biased = radial.add(lat_axis.mul(0.06)).add(torso_fwd.mul(0.08));
                    biased.normalized()
                } else {
                    // Clean lateral-anterior exit normal so arms never get trapped inside or behind chest
                    lat_axis.mul(0.84).add(torso_fwd.mul(0.46)).add(torso_up.mul(-0.12)).normalized()
                };
                let pushed_d = req.max(d).min(r_depth.max(lat_span));
                let out_pt = q.add(target_dir.mul(pushed_d)).add(torso_up.mul(diff.dot(torso_up)));
                pt.lerp(out_pt, hard_s)
            } else {
                pt
            };

            // Push elbow/wrist/hand cleanly out of both left & right thigh capsules (hip -> knee)
            let thighs = [(lh, lk_opt, 1.0f32), (rh, rk_opt, -1.0f32)];
            for (h_p, k_opt, th_sign) in thighs {
                if let Some(k_p) = k_opt {
                    let th_vec = k_p.sub(h_p);
                    let th_len_sq = th_vec.len_sq();
                    if th_len_sq < 0.015 {
                        continue;
                    }
                    let q_th = closest_point_on_segment(out, h_p, k_p);
                    let diff_th = out.sub(q_th);
                    let d_th = diff_th.len();
                    let req_th = r_thigh + clearance;
                    if d_th < req_th {
                        let th_dir = th_vec.mul(1.0 / th_len_sq.sqrt());
                        let radial = diff_th.project_onto_plane(th_dir);
                        let push_lat = if (lat_sign * th_sign) > 0.0 {
                            lat_axis
                        } else {
                            torso_side.mul(th_sign)
                        };
                        // Bias exit laterally outward & upward over the thigh (never down into hip/thigh)
                        let exit_dir = radial
                            .add(push_lat.mul(req_th * 0.62))
                            .add(torso_up.mul(req_th * 0.56))
                            .add(torso_fwd.mul(req_th * 0.20));
                        let dir = if exit_dir.len_sq() > 1e-6 {
                            exit_dir.normalized()
                        } else {
                            push_lat.mul(0.75).add(torso_up.mul(0.65)).normalized()
                        };
                        let pushed = q_th.add(dir.mul(req_th));
                        out = out.lerp(pushed, hard_s);
                    }
                }
            }
            out
        };

        // Opposite knee stride offset for natural subtle occluded arm counterbalance
        let l_leg_swing = if l_kne < n_joints {
            get_joint(buf, f, n_joints, l_kne).sub(lh).dot(torso_fwd)
        } else {
            0.0
        };
        let r_leg_swing = if r_kne < n_joints {
            get_joint(buf, f, n_joints, r_kne).sub(rh).dot(torso_fwd)
        } else {
            0.0
        };

        let arms = [
            (1.0f32, l_sh, ls, l_elb, l_wri, l_han, r_leg_swing),
            (-1.0f32, r_sh, rs, r_elb, r_wri, r_han, l_leg_swing),
        ];

        for (lat_sign, _sh_i, sh_pos, elb_i, wri_i, han_i, opp_leg_fwd) in arms {
            if elb_i >= n_joints || wri_i >= n_joints {
                continue;
            }
            let lat_axis = torso_side.mul(lat_sign);
            let elb_vis = get_vis(buf, f, n_joints, elb_i);
            let wri_vis = get_vis(buf, f, n_joints, wri_i);

            // Counterbalance swing relative to opposite leg (~35% amplitude, smooth relaxed posture)
            let swing_fwd = (-opp_leg_fwd * 0.35).clamp(-0.14, 0.18);
            let nat_elb_dir = torso_up
                .mul(-0.92)
                .add(lat_axis.mul(0.28))
                .add(torso_fwd.mul(-0.08 + swing_fwd * 0.5))
                .normalized();
            let nat_elb = sh_pos.add(nat_elb_dir.mul(upper_len));

            let nat_fore_dir = torso_up
                .mul(-0.74)
                .add(torso_fwd.mul(0.58 + swing_fwd))
                .add(lat_axis.mul(0.22))
                .normalized();
            let nat_wri = nat_elb.add(nat_fore_dir.mul(fore_len));

            // Confidence weight: only blend toward anatomical counterbalance when genuinely occluded/low-vis
            let w_elb = smoothstep_f32(min_vis * 0.45, min_vis.max(0.34), elb_vis);
            let w_wri = smoothstep_f32(min_vis * 0.45, min_vis.max(0.34), wri_vis);

            let raw_elb = get_joint(buf, f, n_joints, elb_i);
            let raw_wri = get_joint(buf, f, n_joints, wri_i);

            let blend_elb = nat_elb.lerp(raw_elb, w_elb + (1.0 - w_elb) * (1.0 - s));
            let safe_elb = push_out_of_torso(blend_elb, lat_sign, 0.042, elb_vis < min_vis);
            set_joint(buf, f, n_joints, elb_i, safe_elb);
            if elb_vis < min_vis {
                buf[(f * n_joints + elb_i) * 4 + 3] = elb_vis.max(0.65);
            }

            // Keep forearm relative continuation when wrist is occluded while elbow was reconstructed
            let raw_wri_rebased = if wri_vis < min_vis && elb_vis < min_vis {
                nat_wri
            } else {
                raw_wri
            };
            let blend_wri = nat_wri.lerp(raw_wri_rebased, w_wri + (1.0 - w_wri) * (1.0 - s));
            let mut safe_wri = push_out_of_torso(blend_wri, lat_sign, 0.055, wri_vis < min_vis);
            // Guarantee forearm points away from shoulder clipping back through elbow
            let fore_v = safe_wri.sub(safe_elb);
            if fore_v.len_sq() < 1e-5 {
                safe_wri = safe_elb.add(nat_fore_dir.mul(fore_len));
            }
            set_joint(buf, f, n_joints, wri_i, safe_wri);
            if wri_vis < min_vis {
                buf[(f * n_joints + wri_i) * 4 + 3] = wri_vis.max(0.65);
            }

            if han_i < n_joints {
                let raw_han = get_joint(buf, f, n_joints, han_i);
                let han_dir = safe_wri.sub(safe_elb).normalized();
                let nat_han = safe_wri.add(han_dir.mul(0.08));
                let hv = get_vis(buf, f, n_joints, han_i);
                let wh = smoothstep_f32(min_vis * 0.6, (min_vis * 1.7).max(0.58), hv);
                let safe_han = push_out_of_torso(nat_han.lerp(raw_han, wh), lat_sign, 0.06, hv < min_vis);
                set_joint(buf, f, n_joints, han_i, safe_han);
                if hv < min_vis {
                    buf[(f * n_joints + han_i) * 4 + 3] = hv.max(0.65);
                }
            }
        }
    }
}

/// Zero-phase 5-point Savitzky-Golay cubic polynomial polish (`[-3, 12, 17, 12, -3]/35`),
/// removing high-frequency 2D->3D quantization tremor without rounding rapid peaks.
pub fn savitzky_golay_smooth_joints(
    buf: &mut [f32],
    n_frames: usize,
    n_joints: usize,
    min_vis: f32,
    passes: usize,
) {
    if n_frames < 5 || passes == 0 || n_joints == 0 {
        return;
    }
    let mut tmp = vec![0.0f32; n_frames];
    for _ in 0..passes {
        for j in 0..n_joints {
            for c in 0..3 {
                for f in 0..n_frames {
                    tmp[f] = buf[(f * n_joints + j) * 4 + c];
                }
                for f in 2..(n_frames - 2) {
                    if get_vis(buf, f, n_joints, j) < min_vis * 0.3 {
                        continue;
                    }
                    let y = (-3.0 * tmp[f - 2]
                        + 12.0 * tmp[f - 1]
                        + 17.0 * tmp[f]
                        + 12.0 * tmp[f + 1]
                        - 3.0 * tmp[f + 2])
                        / 35.0;
                    buf[(f * n_joints + j) * 4 + c] = y;
                }
            }
        }
    }
}

/// Enforces bilateral symmetry between paired left/right limb chains while preserving joint angles.
/// Each pair is `(l_parent, l_mid, l_end, l_tip_opt, r_parent, r_mid, r_end, r_tip_opt)`.
pub fn normalize_bilateral_limb_lengths(
    buf: &mut [f32],
    n_frames: usize,
    n_joints: usize,
    pairs: &[(usize, usize, usize, Option<usize>, usize, usize, usize, Option<usize>)],
    min_vis: f32,
) {
    if n_frames == 0 || pairs.is_empty() {
        return;
    }

    fn collect_limb_med(
        buf: &[f32],
        n_frames: usize,
        n_joints: usize,
        p: usize,
        c: usize,
        min_vis: f32,
    ) -> Option<f32> {
        if p >= n_joints || c >= n_joints {
            return None;
        }
        let mut vis_samples = Vec::with_capacity(n_frames);
        let mut all_samples = Vec::with_capacity(n_frames);
        for f in 0..n_frames {
            let vp = get_vis(buf, f, n_joints, p);
            let vc = get_vis(buf, f, n_joints, c);
            let d = get_joint(buf, f, n_joints, c)
                .sub(get_joint(buf, f, n_joints, p))
                .len();
            if d > 1e-4 {
                all_samples.push(d);
                if vp >= min_vis && vc >= min_vis {
                    vis_samples.push(d);
                }
            }
        }
        if vis_samples.len() >= 3 {
            Some(median_f32(&mut vis_samples))
        } else if !all_samples.is_empty() {
            Some(median_f32(&mut all_samples))
        } else {
            None
        }
    }

    for &(lp, lm, le, lt_opt, rp, rm, re, rt_opt) in pairs {
        if lp >= n_joints || lm >= n_joints || le >= n_joints
            || rp >= n_joints || rm >= n_joints || re >= n_joints
        {
            continue;
        }
        let target_u = match (
            collect_limb_med(buf, n_frames, n_joints, lp, lm, min_vis),
            collect_limb_med(buf, n_frames, n_joints, rp, rm, min_vis),
        ) {
            (Some(lu), Some(ru)) => (0.5 * (lu + ru)).max(0.05),
            (Some(u), None) | (None, Some(u)) => u.max(0.05),
            (None, None) => continue,
        };
        let target_l = match (
            collect_limb_med(buf, n_frames, n_joints, lm, le, min_vis),
            collect_limb_med(buf, n_frames, n_joints, rm, re, min_vis),
        ) {
            (Some(ll), Some(rl)) => (0.5 * (ll + rl)).max(0.05),
            (Some(l), None) | (None, Some(l)) => l.max(0.05),
            (None, None) => continue,
        };

        for f in 0..n_frames {
            for &(p, m, e, t_opt) in &[(lp, lm, le, lt_opt), (rp, rm, re, rt_opt)] {
                let p_pos = get_joint(buf, f, n_joints, p);
                let m_pos = get_joint(buf, f, n_joints, m);
                let e_pos = get_joint(buf, f, n_joints, e);

                let vm = m_pos.sub(p_pos);
                let new_m = if vm.len_sq() > 1e-6 {
                    p_pos.add(vm.normalized().mul(target_u))
                } else {
                    m_pos
                };
                let dm = new_m.sub(m_pos);
                let e_shifted = e_pos.add(dm);
                let ve = e_shifted.sub(new_m);
                let new_e = if ve.len_sq() > 1e-6 {
                    new_m.add(ve.normalized().mul(target_l))
                } else {
                    e_shifted
                };
                let de = new_e.sub(e_pos);
                set_joint(buf, f, n_joints, m, new_m);
                set_joint(buf, f, n_joints, e, new_e);
                if let Some(t) = t_opt {
                    if t < n_joints {
                        let t_pos = get_joint(buf, f, n_joints, t);
                        set_joint(buf, f, n_joints, t, t_pos.add(de));
                    }
                }
            }
        }
    }
}

/// Final post-length multi-angle collision & occluded-leg guard:
/// 1) Prevents backward-knee hyperextension when legs rotate out of camera view.
/// 2) Separates ankles/knees/shins laterally so far-side legs never scissor through stance legs.
/// 3) Ensures finalized wrists/hands remain clear of pelvis & baggy thigh capsules after length clamping.
#[allow(clippy::too_many_arguments)]
pub fn enforce_leg_separation_and_occlusion(
    buf: &mut [f32],
    n_frames: usize,
    n_joints: usize,
    hips_idx: usize,
    neck_idx: usize,
    l_sh: usize,
    r_sh: usize,
    l_elb: usize,
    r_elb: usize,
    l_wri: usize,
    r_wri: usize,
    l_han: usize,
    r_han: usize,
    l_hip: usize,
    r_hip: usize,
    l_kne: usize,
    r_kne: usize,
    l_ank: usize,
    r_ank: usize,
    l_foot_opt: Option<usize>,
    r_foot_opt: Option<usize>,
    min_vis: f32,
    strength: f32,
) {
    if n_frames == 0 || strength <= 1e-4 {
        return;
    }
    if l_sh >= n_joints || r_sh >= n_joints || l_hip >= n_joints || r_hip >= n_joints {
        return;
    }
    let s = strength.clamp(0.0, 1.0);
    let hard_s = if s >= 0.55 { 1.0 } else { s };

    let mut hip_widths = Vec::with_capacity(n_frames);
    let mut sh_widths = Vec::with_capacity(n_frames);
    for f in 0..n_frames {
        hip_widths.push(get_joint(buf, f, n_joints, l_hip).sub(get_joint(buf, f, n_joints, r_hip)).len());
        sh_widths.push(get_joint(buf, f, n_joints, l_sh).sub(get_joint(buf, f, n_joints, r_sh)).len());
    }
    let torso_hip_w = median_f32(&mut hip_widths).clamp(0.16, 0.42);
    let torso_sh_w = median_f32(&mut sh_widths).clamp(0.24, 0.55);
    let r_chest = (torso_sh_w * 0.50).clamp(0.14, 0.22);
    let r_pelvis = (torso_hip_w * 0.94).clamp(0.16, 0.24);
    let r_thigh = (torso_hip_w * 0.46).clamp(0.095, 0.14);

    for f in 0..n_frames {
        let ls = get_joint(buf, f, n_joints, l_sh);
        let rs = get_joint(buf, f, n_joints, r_sh);
        let lh = get_joint(buf, f, n_joints, l_hip);
        let rh = get_joint(buf, f, n_joints, r_hip);

        let mid_hip = if hips_idx < n_joints && get_joint(buf, f, n_joints, hips_idx).len_sq() > 1e-8 {
            get_joint(buf, f, n_joints, hips_idx)
        } else {
            lh.add(rh).mul(0.5)
        };
        let mid_sh = if neck_idx < n_joints && get_joint(buf, f, n_joints, neck_idx).sub(mid_hip).len_sq() > 0.04 {
            get_joint(buf, f, n_joints, neck_idx)
        } else {
            ls.add(rs).mul(0.5)
        };
        let torso_up = mid_sh.sub(mid_hip).normalized();
        if torso_up.len_sq() < 1e-6 {
            continue;
        }
        let mut torso_side = ls.sub(rs).mul(0.6).add(lh.sub(rh).mul(0.4)).project_onto_plane(torso_up);
        if torso_side.len_sq() < 1e-6 {
            torso_side = Vec3::X;
        } else {
            torso_side = torso_side.normalized();
        }
        let torso_fwd = torso_side.cross(torso_up).normalized();

        // 1) Guard knees against backward hyperextension on occluded/profile frames
        for &(hip_i, kne_i, ank_i) in &[(l_hip, l_kne, l_ank), (r_hip, r_kne, r_ank)] {
            if hip_i >= n_joints || kne_i >= n_joints || ank_i >= n_joints {
                continue;
            }
            let hp = get_joint(buf, f, n_joints, hip_i);
            let kp = get_joint(buf, f, n_joints, kne_i);
            let ap = get_joint(buf, f, n_joints, ank_i);
            let mid_ha = hp.lerp(ap, 0.5);
            let kne_fwd = kp.sub(mid_ha).dot(torso_fwd);
            let k_vis = get_vis(buf, f, n_joints, kne_i);
            let min_fwd = if k_vis < min_vis * 0.85 { 0.025 } else { -0.015 };
            if kne_fwd < min_fwd {
                let target_fwd = if k_vis < min_vis * 0.85 { 0.032 } else { 0.018 };
                let corrected = kp.add(torso_fwd.mul((target_fwd - kne_fwd) * hard_s));
                set_joint(buf, f, n_joints, kne_i, corrected);
            }
        }

        // 2) Maintain minimum lateral clearance between left & right knees, shins, and ankles
        if l_kne < n_joints && r_kne < n_joints && l_ank < n_joints && r_ank < n_joints {
            let push_pair = |buf_ref: &mut [f32],
                             li: usize,
                             ri: usize,
                             lf_opt: Option<usize>,
                             rf_opt: Option<usize>,
                             min_sep: f32| {
                let lp = get_joint(buf_ref, f, n_joints, li);
                let rp = get_joint(buf_ref, f, n_joints, ri);
                let diff = lp.sub(rp);
                let d = diff.len();
                if d < min_sep {
                    let flat = diff.project_onto_plane(torso_up);
                    let dir = if flat.len_sq() > 1e-5 && flat.dot(torso_side) >= -0.03 {
                        flat.normalized()
                    } else if flat.len_sq() > 1e-5 {
                        // Prefer preserving current separation side, biased toward torso_side
                        flat.normalized().lerp(torso_side, 0.65).normalized()
                    } else {
                        torso_side
                    };
                    let lv = get_vis(buf_ref, f, n_joints, li).clamp(0.1, 1.0);
                    let rv = get_vis(buf_ref, f, n_joints, ri).clamp(0.1, 1.0);
                    let w_tot = (1.15 - lv) + (1.15 - rv);
                    let wl = ((1.15 - lv) / w_tot).clamp(0.25, 0.75);
                    let wr = 1.0 - wl;
                    let push = (min_sep - d) * hard_s;
                    let dl = dir.mul(push * wl);
                    let dr = dir.mul(-push * wr);
                    set_joint(buf_ref, f, n_joints, li, lp.add(dl));
                    set_joint(buf_ref, f, n_joints, ri, rp.add(dr));
                    if let Some(lf) = lf_opt {
                        if lf < n_joints {
                            let fpos = get_joint(buf_ref, f, n_joints, lf);
                            set_joint(buf_ref, f, n_joints, lf, fpos.add(dl));
                        }
                    }
                    if let Some(rf) = rf_opt {
                        if rf < n_joints {
                            let fpos = get_joint(buf_ref, f, n_joints, rf);
                            set_joint(buf_ref, f, n_joints, rf, fpos.add(dr));
                        }
                    }
                }
            };
            push_pair(buf, l_kne, r_kne, None, None, 0.140);
            push_pair(buf, l_ank, r_ank, l_foot_opt, r_foot_opt, 0.145);

            // Mid-shin scissor guard
            let lk = get_joint(buf, f, n_joints, l_kne);
            let rk = get_joint(buf, f, n_joints, r_kne);
            let la = get_joint(buf, f, n_joints, l_ank);
            let ra = get_joint(buf, f, n_joints, r_ank);
            let l_mid = lk.lerp(la, 0.5);
            let r_mid = rk.lerp(ra, 0.5);
            let q_r = closest_point_on_segment(l_mid, rk, ra);
            let q_l = closest_point_on_segment(r_mid, lk, la);
            let d_shin = l_mid.sub(q_r).len().min(r_mid.sub(q_l).len());
            if d_shin < 0.132 {
                let need = (0.136 - d_shin) * 0.5 * hard_s;
                let dl = torso_side.mul(need);
                let dr = torso_side.mul(-need);
                set_joint(buf, f, n_joints, l_ank, la.add(dl));
                set_joint(buf, f, n_joints, r_ank, ra.add(dr));
                set_joint(buf, f, n_joints, l_kne, lk.add(dl.mul(0.5)));
                set_joint(buf, f, n_joints, r_kne, rk.add(dr.mul(0.5)));
            }
        }

        // 3) Post-length arm clearance safety clamp against pelvis & thighs
        let cap_a = mid_hip.lerp(mid_sh, 0.16);
        let cap_b = mid_sh.lerp(mid_hip, 0.05);
        let lk_opt = if l_kne < n_joints { Some(get_joint(buf, f, n_joints, l_kne)) } else { None };
        let rk_opt = if r_kne < n_joints { Some(get_joint(buf, f, n_joints, r_kne)) } else { None };
        for (lat_sign, joints_with_clear) in [
            (1.0f32, [(l_elb, 0.045f32), (l_wri, 0.065f32), (l_han, 0.070f32)]),
            (-1.0f32, [(r_elb, 0.045f32), (r_wri, 0.065f32), (r_han, 0.070f32)]),
        ] {
            let lat_axis = torso_side.mul(lat_sign);
            for (ji, clearance) in joints_with_clear {
                if ji >= n_joints {
                    continue;
                }
                let mut pt = get_joint(buf, f, n_joints, ji);
                let q_chest = closest_point_on_segment(pt, cap_a, cap_b);
                let dc = pt.sub(q_chest).len();
                let req_c = r_chest + clearance;
                if dc < req_c {
                    let radial = pt.sub(q_chest).project_onto_plane(torso_up);
                    let dir = radial.add(lat_axis.mul(0.08)).add(torso_fwd.mul(0.05));
                    let unit = if dir.len_sq() > 1e-6 { dir.normalized() } else { lat_axis.mul(0.85).add(torso_fwd.mul(0.5)).normalized() };
                    let out_c = q_chest.add(unit.mul(req_c)).add(torso_up.mul(pt.sub(q_chest).dot(torso_up)));
                    pt = pt.lerp(out_c, hard_s);
                }
                let dp = pt.sub(mid_hip).len();
                let req_p = r_pelvis + clearance;
                if dp < req_p {
                    let radial = pt.sub(mid_hip).project_onto_plane(torso_up);
                    let dir = radial.add(lat_axis.mul(req_p * 0.45)).add(torso_fwd.mul(req_p * 0.25));
                    let unit = if dir.len_sq() > 1e-6 { dir.normalized() } else { lat_axis.mul(0.85).add(torso_fwd.mul(0.5)).normalized() };
                    let out_p = mid_hip.add(unit.mul(req_p)).add(torso_up.mul(pt.sub(mid_hip).dot(torso_up)));
                    pt = pt.lerp(out_p, hard_s);
                }
                for (h_p, k_opt, th_sign) in [(lh, lk_opt, 1.0f32), (rh, rk_opt, -1.0f32)] {
                    if let Some(k_p) = k_opt {
                        let th_v = k_p.sub(h_p);
                        let th_lsq = th_v.len_sq();
                        if th_lsq < 0.015 {
                            continue;
                        }
                        let q_th = closest_point_on_segment(pt, h_p, k_p);
                        let diff_th = pt.sub(q_th);
                        let d_th = diff_th.len();
                        let req_th = r_thigh + clearance;
                        if d_th < req_th {
                            let th_dir = th_v.mul(1.0 / th_lsq.sqrt());
                            let radial = diff_th.project_onto_plane(th_dir);
                            let push_lat = if (lat_sign * th_sign) > 0.0 { lat_axis } else { torso_side.mul(th_sign) };
                            let exit_dir = radial
                                .add(push_lat.mul(req_th * 0.62))
                                .add(torso_up.mul(req_th * 0.56))
                                .add(torso_fwd.mul(req_th * 0.20));
                            let unit = if exit_dir.len_sq() > 1e-6 {
                                exit_dir.normalized()
                            } else {
                                push_lat.mul(0.75).add(torso_up.mul(0.65)).normalized()
                            };
                            pt = pt.lerp(q_th.add(unit.mul(req_th)), hard_s);
                        }
                    }
                }
                set_joint(buf, f, n_joints, ji, pt);
            }
        }
    }
}


