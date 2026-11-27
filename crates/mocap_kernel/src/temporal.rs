//! Temporal 3D Lifting, Torso Continuity Disambiguation, and Minimum-Jerk Occlusion Inpainting.
//! Transforms frame-independent monocular pose estimates into temporally consistent 3D trajectories.

use crate::filters::{get_joint, get_vis, set_joint};
use crate::math::Vec3;

#[inline]
fn dot_xz(a: Vec3, b: Vec3) -> f32 {
    a.x * b.x + a.z * b.z
}

#[inline]
fn hermite01(t: f32) -> f32 {
    let x = t.clamp(0.0, 1.0);
    x * x * (3.0 - 2.0 * x)
}

/// Detect & repair sudden ~180° depth-flip inversions across the torso during fast turns or low-vis frames.
/// Reflects inverted Z coordinates around mid-hip whenever the local shoulder/hip side vector contradicts
/// the smooth temporal consensus over `[f-6 .. f+6]`.
pub fn enforce_temporal_torso_continuity(
    buf: &mut [f32],
    n_frames: usize,
    n_joints: usize,
    l_hip: usize,
    r_hip: usize,
    l_sh: usize,
    r_sh: usize,
    hips_idx: usize,
    upper_limb_indices: &[usize],
    min_vis: f32,
) {
    if n_frames < 5 || l_hip >= n_joints || r_hip >= n_joints || l_sh >= n_joints || r_sh >= n_joints {
        return;
    }

    let mut sides = Vec::with_capacity(n_frames);
    let mut confs = Vec::with_capacity(n_frames);
    for f in 0..n_frames {
        let lh = get_joint(buf, f, n_joints, l_hip);
        let rh = get_joint(buf, f, n_joints, r_hip);
        let ls = get_joint(buf, f, n_joints, l_sh);
        let rs = get_joint(buf, f, n_joints, r_sh);

        let v_hip = get_vis(buf, f, n_joints, l_hip).min(get_vis(buf, f, n_joints, r_hip));
        let v_sh = get_vis(buf, f, n_joints, l_sh).min(get_vis(buf, f, n_joints, r_sh));
        let w = (v_hip * 0.45 + v_sh * 0.55).clamp(0.0, 1.0);

        let sv = lh.sub(rh).mul(0.5).add(ls.sub(rs).mul(0.5));
        let xz = Vec3::new(sv.x, 0.0, sv.z);
        if xz.len_sq() > 1e-6 && w >= min_vis {
            sides.push(xz.normalized());
            confs.push(w);
        } else {
            sides.push(Vec3::ZERO);
            confs.push(0.0);
        }
    }

    let radius = 8usize;
    let mut flip_frame = vec![false; n_frames];
    let mut align_scores = vec![1.0f32; n_frames];
    for f in 0..n_frames {
        if confs[f] <= 0.0 {
            continue;
        }
        let s0 = f.saturating_sub(radius);
        let e0 = (f + radius).min(n_frames - 1);
        let mut sum = Vec3::ZERO;
        let mut wsum = 0.0f32;
        for k in s0..=e0 {
            if k == f || confs[k] <= 0.0 {
                continue;
            }
            let dist_w = 1.0 - (k.abs_diff(f) as f32 / (radius as f32 + 1.0));
            let w = confs[k] * dist_w;
            sum = sum.add(sides[k].mul(w));
            wsum += w;
        }
        if wsum < 0.2 || sum.len_sq() < 1e-5 {
            continue;
        }
        let ref_side = sum.normalized();
        align_scores[f] = dot_xz(sides[f], ref_side);
    }

    // Confirm runs of 1..=12 inverted frames anchored on both sides by agreeing frames
    let mut f = 0usize;
    while f < n_frames {
        if confs[f] > 0.0 && align_scores[f] < -0.45 {
            let start = f;
            let mut end = f + 1;
            while end < n_frames && end - start < 12 && confs[end] > 0.0 && align_scores[end] < -0.35 {
                end += 1;
            }
            let run_len = end - start;
            let mean_score = (start..end).map(|k| align_scores[k]).sum::<f32>() / (run_len.max(1) as f32);
            let anchor_min = if run_len <= 5 { 0.1 } else { 0.25 };
            let has_before = start > 0 && confs[start - 1] > 0.0 && align_scores[start - 1] > anchor_min;
            let has_after = end < n_frames && confs[end] > 0.0 && align_scores[end] > anchor_min;
            let confirmed = run_len <= 5 || (run_len <= 12 && mean_score < -0.60);
            if confirmed && has_before && has_after {
                for k in start..end {
                    flip_frame[k] = true;
                }
            }
            f = end;
        } else {
            f += 1;
        }
    }

    for f in 0..n_frames {
        if !flip_frame[f] {
            continue;
        }
        let anchor_z = if hips_idx < n_joints {
            get_joint(buf, f, n_joints, hips_idx).z
        } else {
            0.5 * (get_joint(buf, f, n_joints, l_hip).z + get_joint(buf, f, n_joints, r_hip).z)
        };
        let mut reflect = |j: usize| {
            if j >= n_joints {
                return;
            }
            let mut p = get_joint(buf, f, n_joints, j);
            p.z = 2.0 * anchor_z - p.z;
            set_joint(buf, f, n_joints, j, p);
        };
        reflect(l_hip);
        reflect(r_hip);
        reflect(l_sh);
        reflect(r_sh);
        for &ui in upper_limb_indices {
            reflect(ui);
        }
    }
}

/// Bi-directional temporal depth lifting & minimum-jerk bridging for occluded/low-confidence limb joints.
/// Preserves reliable 2D-aligned X/Y screen direction while reconstructing smooth 3D Z depth arcs
/// relative to parent root anchors (`shoulder`/`hip`).
#[allow(clippy::too_many_arguments)]
pub fn lift_occluded_depth_temporal(
    buf: &mut [f32],
    lm2d: &[f32],
    n_frames: usize,
    n_joints: usize,
    root_joint: usize,
    target_joint: usize,
    vis_threshold: f32,
    max_bridge: usize,
) {
    if n_frames < 4 || root_joint >= n_joints || target_joint >= n_joints || max_bridge < 2 {
        return;
    }
    let has_lm2d = lm2d.len() >= n_frames * n_joints * 3;
    let vis_of = |f: usize, b: &[f32]| -> f32 {
        let v3 = get_vis(b, f, n_joints, target_joint);
        if has_lm2d {
            let b2 = (f * n_joints + target_joint) * 3;
            0.65 * v3 + 0.35 * lm2d[b2 + 2].clamp(0.0, 1.0)
        } else {
            v3
        }
    };

    // Relative vectors (target - root) on confident anchors
    let mut rel = vec![Vec3::ZERO; n_frames];
    let mut len_acc = 0.0f32;
    let mut len_cnt = 0usize;
    let mut valid = vec![false; n_frames];

    for f in 0..n_frames {
        let r = get_joint(buf, f, n_joints, root_joint);
        let t = get_joint(buf, f, n_joints, target_joint);
        let d = t.sub(r);
        rel[f] = d;
        let v = vis_of(f, buf);
        if v >= vis_threshold && d.len_sq() > 1e-5 {
            valid[f] = true;
            len_acc += d.len();
            len_cnt += 1;
        }
    }
    if len_cnt == 0 {
        return;
    }
    let avg_len = len_acc / len_cnt as f32;

    let mut f = 0usize;
    while f < n_frames {
        if valid[f] {
            f += 1;
            continue;
        }
        let s = f;
        while f < n_frames && !valid[f] {
            f += 1;
        }
        let e = f; // [s .. e) are low-confidence frames
        let span = e - s;
        if span > max_bridge {
            continue;
        }
        let prev_a = if s > 0 && valid[s - 1] { Some(s - 1) } else { None };
        let next_a = if e < n_frames && valid[e] { Some(e) } else { None };

        match (prev_a, next_a) {
            (Some(a), Some(b)) => {
                let d0 = rel[a];
                let d1 = rel[b];
                for k in s..e {
                    let t = (k - a) as f32 / (b - a) as f32;
                    let w = hermite01(t);
                    let z_target = d0.z + (d1.z - d0.z) * w;

                    let r_k = get_joint(buf, k, n_joints, root_joint);
                    let cur = get_joint(buf, k, n_joints, target_joint);
                    let cur_rel = cur.sub(r_k);
                    let v = vis_of(k, buf);
                    // Low confidence blends strongly into smooth temporal Z while retaining reliable XY projection
                    let blend = (1.0 - (v / vis_threshold)).clamp(0.25, 0.92);
                    let xy_target = Vec3::new(
                        cur_rel.x + ((d0.x + (d1.x - d0.x) * w) - cur_rel.x) * (blend * 0.45),
                        cur_rel.y + ((d0.y + (d1.y - d0.y) * w) - cur_rel.y) * (blend * 0.45),
                        cur_rel.z + (z_target - cur_rel.z) * blend,
                    );
                    let cur_len = xy_target.len();
                    let fixed_rel = if cur_len > 1e-5 {
                        xy_target.mul(avg_len / cur_len)
                    } else {
                        d0.lerp(d1, w)
                    };
                    set_joint(buf, k, n_joints, target_joint, r_k.add(fixed_rel));
                }
            }
            (Some(a), None) => {
                let anchor = rel[a];
                for k in s..e {
                    let r_k = get_joint(buf, k, n_joints, root_joint);
                    let cur = get_joint(buf, k, n_joints, target_joint);
                    let cur_rel = cur.sub(r_k);
                    let decay = (-((k - a) as f32) * 0.12).exp();
                    let next_z = cur_rel.z + (anchor.z - cur_rel.z) * (0.75 * decay);
                    let next_rel = Vec3::new(cur_rel.x, cur_rel.y, next_z);
                    let l = next_rel.len();
                    set_joint(
                        buf,
                        k,
                        n_joints,
                        target_joint,
                        r_k.add(if l > 1e-5 { next_rel.mul(avg_len / l) } else { anchor }),
                    );
                }
            }
            (None, Some(b)) => {
                let anchor = rel[b];
                for k in s..e {
                    let r_k = get_joint(buf, k, n_joints, root_joint);
                    let cur = get_joint(buf, k, n_joints, target_joint);
                    let cur_rel = cur.sub(r_k);
                    let decay = (-((b - k) as f32) * 0.12).exp();
                    let next_z = cur_rel.z + (anchor.z - cur_rel.z) * (0.75 * decay);
                    let next_rel = Vec3::new(cur_rel.x, cur_rel.y, next_z);
                    let l = next_rel.len();
                    set_joint(
                        buf,
                        k,
                        n_joints,
                        target_joint,
                        r_k.add(if l > 1e-5 { next_rel.mul(avg_len / l) } else { anchor }),
                    );
                }
            }
            (None, None) => {}
        }
    }
}

/// Suppress extreme per-frame acceleration glitches across temporal sequences without blurring crisp beats.
pub fn clamp_temporal_jerk(
    buf: &mut [f32],
    n_frames: usize,
    n_joints: usize,
    fps: f32,
    min_vis: f32,
) {
    if n_frames < 5 || n_joints == 0 {
        return;
    }
    let dt = 1.0 / fps.max(1.0);
    // Max physically plausible limb frame displacement overshoot (~0.09m @ 30fps)
    let soft_accel = (0.085 * (30.0 * dt).clamp(0.5, 1.8)).clamp(0.04, 0.16);
    let hard_accel = soft_accel * 2.1;

    for j in 0..n_joints {
        for f in 1..(n_frames - 1) {
            let vp = get_vis(buf, f - 1, n_joints, j);
            let vc = get_vis(buf, f, n_joints, j);
            let vn = get_vis(buf, f + 1, n_joints, j);
            if vp.min(vn) < min_vis {
                continue;
            }
            let pp = get_joint(buf, f - 1, n_joints, j);
            let pc = get_joint(buf, f, n_joints, j);
            let pn = get_joint(buf, f + 1, n_joints, j);
            let chord = pp.lerp(pn, 0.5);
            let dev = pc.sub(chord);
            let dev_len = dev.len();
            if dev_len > soft_accel {
                let target_max = if vc < 0.65 {
                    soft_accel * 0.6
                } else {
                    soft_accel + (dev_len - soft_accel).min(hard_accel - soft_accel) * 0.45
                };
                let fixed = chord.add(dev.normalized().mul(target_max.min(dev_len)));
                set_joint(buf, f, n_joints, j, fixed);
            }
        }
    }
}

/// Complete temporal lifting pass executed after basic gap-fill/despike and before One-Euro & FK retargeting.
#[allow(clippy::too_many_arguments)]
pub fn run_temporal_lifting(
    buf: &mut [f32],
    lm2d: &[f32],
    n_frames: usize,
    n_joints: usize,
    fps: f32,
    hips_idx: usize,
    l_sh: i32,
    r_sh: i32,
    l_elb: i32,
    r_elb: i32,
    l_wri: i32,
    r_wri: i32,
    l_hip: usize,
    r_hip: usize,
    l_knee: usize,
    r_knee: usize,
    l_ankle: usize,
    r_ankle: usize,
    nose_idx: i32,
    min_vis: f32,
) {
    run_temporal_lifting_opts(
        buf, lm2d, n_frames, n_joints, fps, hips_idx,
        l_sh, r_sh, l_elb, r_elb, l_wri, r_wri,
        l_hip, r_hip, l_knee, r_knee, l_ankle, r_ankle,
        nose_idx, min_vis, true,
    );
}

/// Inner temporal lifting pass allowing callers to skip redundant torso flip when already run single-pass.
#[allow(clippy::too_many_arguments)]
pub fn run_temporal_lifting_opts(
    buf: &mut [f32],
    lm2d: &[f32],
    n_frames: usize,
    n_joints: usize,
    fps: f32,
    hips_idx: usize,
    l_sh: i32,
    r_sh: i32,
    l_elb: i32,
    r_elb: i32,
    l_wri: i32,
    r_wri: i32,
    l_hip: usize,
    r_hip: usize,
    l_knee: usize,
    r_knee: usize,
    l_ankle: usize,
    r_ankle: usize,
    nose_idx: i32,
    min_vis: f32,
    do_torso_flip: bool,
) {
    if do_torso_flip {
        let mut all_limbs = Vec::with_capacity(12);
        for idx in [l_elb, r_elb, l_wri, r_wri, nose_idx] {
            if idx >= 0 && (idx as usize) < n_joints {
                all_limbs.push(idx as usize);
            }
        }
        for idx in [l_knee, r_knee, l_ankle, r_ankle] {
            if idx < n_joints {
                all_limbs.push(idx);
            }
        }
        if l_sh >= 0 && r_sh >= 0 {
            enforce_temporal_torso_continuity(
                buf,
                n_frames,
                n_joints,
                l_hip,
                r_hip,
                l_sh as usize,
                r_sh as usize,
                hips_idx,
                &all_limbs,
                min_vis,
            );
        }
    }

    let max_bridge = ((fps * 1.1).round() as usize).clamp(12, 48);
    if l_sh >= 0 && l_elb >= 0 {
        lift_occluded_depth_temporal(buf, lm2d, n_frames, n_joints, l_sh as usize, l_elb as usize, 0.70, max_bridge);
        if l_wri >= 0 {
            lift_occluded_depth_temporal(buf, lm2d, n_frames, n_joints, l_elb as usize, l_wri as usize, 0.70, max_bridge);
        }
    }
    if r_sh >= 0 && r_elb >= 0 {
        lift_occluded_depth_temporal(buf, lm2d, n_frames, n_joints, r_sh as usize, r_elb as usize, 0.70, max_bridge);
        if r_wri >= 0 {
            lift_occluded_depth_temporal(buf, lm2d, n_frames, n_joints, r_elb as usize, r_wri as usize, 0.70, max_bridge);
        }
    }
    lift_occluded_depth_temporal(buf, lm2d, n_frames, n_joints, l_hip, l_knee, 0.68, max_bridge);
    lift_occluded_depth_temporal(buf, lm2d, n_frames, n_joints, l_knee, l_ankle, 0.68, max_bridge);
    lift_occluded_depth_temporal(buf, lm2d, n_frames, n_joints, r_hip, r_knee, 0.68, max_bridge);
    lift_occluded_depth_temporal(buf, lm2d, n_frames, n_joints, r_knee, r_ankle, 0.68, max_bridge);

    clamp_temporal_jerk(buf, n_frames, n_joints, fps, min_vis);
}
