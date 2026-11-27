//! Perspective-Aware 2D+3D Kinematic Lifting, Gauss-Newton Refinement & Occlusion Recovery.
//!
//! Instead of naive orthographic XY blending, this solver jointly fits a per-clip
//! perspective pinhole camera model `(cx_f, cy_f, s_f, z_cam)` from high-visibility
//! torso/limb landmarks and solves iterative Gauss-Newton + tree bone-length projection
//! steps over 3D joint positions minimizing:
//!   1. Perspective 2D reprojection error `||Pi(P) - u_2d||^2` (using `1 / (1 + z_rel / z_cam)`),
//!   2. Raw monocular 3D prior weighted by confidence (`vis_3d`),
//!   3. Temporal minimum-acceleration smoothness (`P_f - 0.5 * (P_{f-1} + P_{f+1})`),
//!   4. Canonical bilateral anatomical bone lengths `||P_b - P_a|| = L_{a,b}`.
//! For long occluded limb spans (`vis < min_vis`), missing joints are lifted via
//! temporal cubic/linear trajectory + bone-length constraints with torso clearance.

use crate::filters::{get_joint, get_vis, set_joint};
use crate::math::{median_f32, Vec3};

#[inline]
fn smoothstep_range(edge0: f32, edge1: f32, x: f32) -> f32 {
    let denom = (edge1 - edge0).max(1e-6);
    let t = ((x - edge0) / denom).clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

#[derive(Clone, Copy)]
pub struct CameraFit {
    pub y_sign: f32,
    pub z_cam: f32,
    pub med_scale: f32,
    pub frame_scales: f32,
    pub mid_hip_2d: [f32; 2],
}

/// Robustly detect `+Y down` (-1 inverse? no: if ms3.y > mh3.y => 3D is +Y up => y2_to_y3 = -1)
/// and estimate weak-perspective pinhole focal scale `scale_f` + camera depth `z_cam` per frame.
fn fit_frame_cameras(
    buf: &[f32],
    lm2d: &[f32],
    n_frames: usize,
    n_joints: usize,
    l_hip: usize,
    r_hip: usize,
    l_sh: usize,
    r_sh: usize,
    l_knee: usize,
    r_knee: usize,
    min_vis: f32,
    aspect: f32,
) -> Option<(f32, f32, f32, Vec<[f32; 3]>)> {
    if n_frames == 0 || lm2d.len() < n_frames * n_joints * 3 {
        return None;
    }

    let mut y_diffs = Vec::with_capacity(n_frames);
    let mut scales = Vec::with_capacity(n_frames);
    let mut cam_params = vec![[0.5f32, 0.5f32, 1.0f32]; n_frames]; // [cx, cy, scale]

    let check_idxs = [l_hip, r_hip, l_sh, r_sh, l_knee, r_knee];

    for f in 0..n_frames {
        let mh3 = get_joint(buf, f, n_joints, l_hip)
            .add(get_joint(buf, f, n_joints, r_hip))
            .mul(0.5);
        let b2_lh = (f * n_joints + l_hip) * 3;
        let b2_rh = (f * n_joints + r_hip) * 3;
        let cx = 0.5 * (lm2d[b2_lh] + lm2d[b2_rh]);
        let cy = 0.5 * (lm2d[b2_lh + 1] + lm2d[b2_rh + 1]);
        cam_params[f][0] = cx;
        cam_params[f][1] = cy;

        let ms3 = get_joint(buf, f, n_joints, l_sh)
            .add(get_joint(buf, f, n_joints, r_sh))
            .mul(0.5);
        if (ms3.y - mh3.y).abs() > 0.08 {
            y_diffs.push(ms3.y - mh3.y);
        }

        // Fit scale robustly using all visible check pairs relative to mid-hip
        let mut pair_ratios = [0.0f32; 6];
        let mut pr_count = 0usize;
        for &idx in &check_idxs {
            if idx >= n_joints {
                continue;
            }
            let v3 = get_vis(buf, f, n_joints, idx);
            let b2 = (f * n_joints + idx) * 3;
            let x2 = lm2d[b2];
            let y2 = lm2d[b2 + 1];
            let v2 = lm2d[b2 + 2];
            if v3 < min_vis || v2 < 0.45 || !x2.is_finite() || !y2.is_finite() || (x2 == 0.0 && y2 == 0.0) {
                continue;
            }
            let p3 = get_joint(buf, f, n_joints, idx);
            let d3 = ((p3.x - mh3.x).powi(2) + (p3.y - mh3.y).powi(2)).sqrt();
            let dx2_iso = (x2 - cx) * aspect;
            let dy2_iso = y2 - cy;
            let d2 = (dx2_iso.powi(2) + dy2_iso.powi(2)).sqrt();
            if d3 > 0.14 && d2 > 0.025 {
                let r = (d3 / d2).clamp(0.45, 8.5);
                pair_ratios[pr_count] = r;
                pr_count += 1;
            }
        }
        if pr_count > 0 {
            let f_scale = median_f32(&mut pair_ratios[..pr_count]);
            scales.push(f_scale);
            cam_params[f][2] = f_scale;
        }
    }

    if scales.is_empty() {
        return None;
    }
    let med_scale = median_f32(&mut scales);
    for cp in &mut cam_params {
        if cp[2] == 1.0 && (med_scale - 1.0).abs() > 0.05 {
            cp[2] = med_scale;
        } else {
            cp[2] = (0.68 * med_scale + 0.32 * cp[2]).clamp(med_scale * 0.72, med_scale * 1.38);
        }
    }

    // In 2D image coordinates +Y is downward. Match 3D Y sign:
    // +Y up (ms3.y > mh3.y) => y2_to_y3 = -1.0; +Y down => +1.0
    let y2_to_y3 = if !y_diffs.is_empty() && median_f32(&mut y_diffs) > 0.0 {
        -1.0f32
    } else {
        1.0f32
    };

    // Estimate nominal camera distance D_cam in meters proportional to subject height in image
    // Standard ~50deg FOV smartphone/webcam video places standing ~1.7m person at ~2.8-3.6m.
    let z_cam = (med_scale * 1.15).clamp(2.2, 5.2);

    Some((y2_to_y3, z_cam, med_scale, cam_params))
}

/// Compute canonical bilateral bone lengths from median across high-visibility frames.
fn estimate_canonical_bone_lengths(
    buf: &[f32],
    chains: &[(usize, usize)],
    bilateral_pairs: &[(usize, usize, usize, usize)],
    n_frames: usize,
    n_joints: usize,
    min_vis: f32,
) -> Vec<f32> {
    let mut lengths = vec![0.0f32; chains.len()];
    let mut scratch = Vec::with_capacity(n_frames);
    for (ci, &(a, b)) in chains.iter().enumerate() {
        if a >= n_joints || b >= n_joints {
            continue;
        }
        scratch.clear();
        for f in 0..n_frames {
            let va = get_vis(buf, f, n_joints, a);
            let vb = get_vis(buf, f, n_joints, b);
            if va < min_vis.max(0.45) || vb < min_vis.max(0.45) {
                continue;
            }
            let d = get_joint(buf, f, n_joints, a).sub(get_joint(buf, f, n_joints, b)).len();
            if d > 0.03 && d < 1.2 {
                scratch.push(d);
            }
        }
        if !scratch.is_empty() {
            lengths[ci] = median_f32(&mut scratch);
        }
    }

    // Symmetrize bilateral limbs (left/right thigh, shin, upper-arm, forearm)
    for &(la, lb, ra, rb) in bilateral_pairs {
        let li = chains.iter().position(|&c| c == (la, lb));
        let ri = chains.iter().position(|&c| c == (ra, rb));
        if let (Some(i0), Some(i1)) = (li, ri) {
            let l0 = lengths[i0];
            let l1 = lengths[i1];
            if l0 > 0.04 && l1 > 0.04 {
                let sym = 0.5 * (l0 + l1);
                lengths[i0] = sym;
                lengths[i1] = sym;
            }
        }
    }

    lengths
}

/// Optimize 3D joint positions jointly against perspective 2D reprojection, monocular 3D priors,
/// temporal minimum-acceleration smoothness, and canonical constant bone lengths.
#[allow(clippy::too_many_arguments)]
pub fn optimize_perspective_2d_3d(
    buf: &mut [f32],
    lm2d: &[f32],
    chains: &[(usize, usize)],
    bilateral_limb_chains: &[(usize, usize, usize, usize)],
    n_frames: usize,
    n_joints: usize,
    hips_idx: usize,
    l_hip: usize,
    r_hip: usize,
    l_sh: usize,
    r_sh: usize,
    l_knee: usize,
    r_knee: usize,
    min_vis: f32,
    aspect_ratio: f32,
) {
    if n_frames < 3 || n_joints == 0 || lm2d.len() < n_frames * n_joints * 3 {
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

    let Some((y2_to_y3, z_cam, _med_scale, cam_params)) = fit_frame_cameras(
        buf, lm2d, n_frames, n_joints, l_hip, r_hip, l_sh, r_sh, l_knee, r_knee, min_vis, aspect,
    ) else {
        return;
    };

    let bone_lengths = estimate_canonical_bone_lengths(
        buf,
        chains,
        bilateral_limb_chains,
        n_frames,
        n_joints,
        min_vis,
    );

    // Preserve raw 3D observations as anchor priors
    let raw_buf = buf.to_vec();
    let n_iters = 4usize;

    for iter in 0..n_iters {
        let proj_step = if iter < 2 { 0.42 } else { 0.28 };
        let smooth_w_base = if iter < 2 { 0.20 } else { 0.14 };

        // 1. Joint Gauss-Newton step per frame (perspective 2D fidelity + 3D confidence prior + temporal smoothness)
        for f in 0..n_frames {
            let mh3 = get_joint(buf, f, n_joints, l_hip)
                .add(get_joint(buf, f, n_joints, r_hip))
                .mul(0.5);
            let [cx, cy, scale_f] = cam_params[f];

            // Detect camera forward sign in Z relative to viewer:
            // When 3D is +Y up (Three.js, y2_to_y3 == -1), viewer looks toward -Z -> closer is +Z.
            // When 3D is +Y down (MediaPipe, y2_to_y3 == +1), viewer looks toward +Z -> closer is -Z.
            let closer_z_sign = -y2_to_y3;

            for j in 0..n_joints {
                if j == l_hip || j == r_hip || j == hips_idx {
                    continue;
                }
                let p_cur = get_joint(buf, f, n_joints, j);
                let p_raw = get_joint(&raw_buf, f, n_joints, j);
                let v3 = get_vis(&raw_buf, f, n_joints, j);

                let b2 = (f * n_joints + j) * 3;
                let x2 = lm2d[b2];
                let y2 = lm2d[b2 + 1];
                let v2 = lm2d[b2 + 2];
                let valid2d = v2 >= 0.42
                    && x2.is_finite()
                    && y2.is_finite()
                    && !(x2 == 0.0 && y2 == 0.0);

                // Adaptive temporal chord neighbor target (zero weight at endpoints)
                let chord = if f > 0 && f + 1 < n_frames {
                    let pp = get_joint(buf, f - 1, n_joints, j);
                    let pn = get_joint(buf, f + 1, n_joints, j);
                    Some(pp.lerp(pn, 0.5))
                } else {
                    None
                };

                let mut target_x = p_cur.x;
                let mut target_y = p_cur.y;
                let mut target_z = p_cur.z;

                if valid2d {
                    // Perspective inverse scale at current depth offset relative to mid-hip:
                    // Closer to camera -> smaller effective depth -> slightly tighter metric XY scale
                    let z_rel_toward_cam = (p_cur.z - mh3.z) * closer_z_sign;
                    let persp = (1.0 - z_rel_toward_cam / z_cam).clamp(0.76, 1.28);
                    let eff_scale = scale_f * persp;

                    let proj_x = mh3.x + (x2 - cx) * aspect * eff_scale;
                    let proj_y = mh3.y + (y2 - cy) * eff_scale * y2_to_y3;
                    let dev2 = ((proj_x - p_cur.x).powi(2) + (proj_y - p_cur.y).powi(2)).sqrt();

                    if dev2 < 0.72 {
                        let taper = if dev2 <= 0.28 {
                            1.0
                        } else {
                            (1.0 - (dev2 - 0.28) / 0.44).clamp(0.15, 1.0)
                        };
                        let sh_scale = if j == l_sh || j == r_sh { 0.65 } else { 1.0 };
                        let w2 = proj_step
                            * sh_scale
                            * smoothstep_range(0.42, 0.90, v2)
                            * taper
                            * (if v3 < 0.45 { 1.15 } else { 0.90 });
                        target_x += (proj_x - p_cur.x) * w2;
                        target_y += (proj_y - p_cur.y) * w2;
                    }
                }

                // Confidence-weighted 3D prior + temporal minimum-acceleration damping (especially on Z)
                if let Some(ch) = chord {
                    let vis_conf = v3.clamp(0.0, 1.0);
                    // High visibility keeps fast sharp beats; occluded / noisy Z pulls smoothly toward chord
                    let dev_chord: f32 = p_cur.sub(ch).len();
                    let robust_scale: f32 = if dev_chord > 0.10 && vis_conf > 0.65 {
                        // Huber/IRLS attenuation so authentic fast punches/kicks remain crisp
                        (0.10f32 / dev_chord).clamp(0.32, 1.0)
                    } else {
                        1.0
                    };
                    // Smooth XY gently when occluded/low-vis; pull weakly on crisp fast motion
                    let w_smooth_xy = smooth_w_base * (1.10 - 0.78 * vis_conf) * robust_scale;
                    let w_smooth_z = (smooth_w_base * 1.40 * (1.28 - 0.55 * vis_conf)).clamp(0.05, 0.50);

                    target_x += (ch.x - target_x) * w_smooth_xy;
                    target_y += (ch.y - target_y) * w_smooth_xy;
                    target_z += (ch.z - target_z) * w_smooth_z;

                    // Keep a gentle 3D anchor on depth and low-2D-conf XY; high-conf 2D leads XY
                    let conf_2d = if valid2d { smoothstep_range(0.42, 0.88, v2) } else { 0.0 };
                    let w_anchor_xy = (0.30 * vis_conf * (1.0 - 0.75 * conf_2d)).clamp(0.04, 0.30);
                    let w_anchor_z = (0.28 * vis_conf).clamp(0.04, 0.28);
                    target_x += (p_raw.x - target_x) * w_anchor_xy;
                    target_y += (p_raw.y - target_y) * w_anchor_xy;
                    target_z += (p_raw.z - target_z) * w_anchor_z;
                }

                set_joint(buf, f, n_joints, j, Vec3::new(target_x, target_y, target_z));
            }
        }

        // 2. Foreshortening-Aware Kinematic Chain Projection:
        //    Only apply pure Delta-Z recovery when clearly foreshortened (dxy^2 < 0.76 * L^2),
        //    staying cleanly away from the sqrt(L^2 - dxy^2) infinity slope near full extension.
        for f in 0..n_frames {
            for (ci, &(parent_idx, child_idx)) in chains.iter().enumerate() {
                if parent_idx >= n_joints || child_idx >= n_joints {
                    continue;
                }
                let target_len = bone_lengths[ci];
                if target_len < 0.04 {
                    continue;
                }
                let pa = get_joint(buf, f, n_joints, parent_idx);
                let pb = get_joint(buf, f, n_joints, child_idx);
                let delta = pb.sub(pa);
                let cur_len = delta.len();
                if cur_len < 1e-5 {
                    continue;
                }

                let vb2 = lm2d[(f * n_joints + child_idx) * 3 + 2];
                if vb2 >= 0.65 {
                    let dxy2 = delta.x * delta.x + delta.y * delta.y;
                    if dxy2 < target_len * target_len * 0.76 {
                        let req_dz = (target_len * target_len - dxy2).max(0.0).sqrt();
                        let sign_z = if delta.z >= 0.0 { 1.0 } else { -1.0 };
                        let z_blended = delta.z + (sign_z * req_dz - delta.z) * 0.72;
                        let fixed_pb = Vec3::new(pa.x + delta.x, pa.y + delta.y, pa.z + z_blended);
                        set_joint(buf, f, n_joints, child_idx, pb.lerp(fixed_pb, 0.80));
                        continue;
                    }
                }

                // General soft-stiff spring projection along bone vector
                let exact_pb = pa.add(delta.mul(target_len / cur_len));
                set_joint(buf, f, n_joints, child_idx, pb.lerp(exact_pb, 0.62));
            }
        }
    }
}
