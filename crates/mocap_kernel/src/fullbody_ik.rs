//! Closed-Loop Full-Body Grounding IK, Two-Foot Floor Contact Projection,
//! and Anatomical `ToeBase` Articulation in rigged character space.

use crate::filters::solve_two_bone_mid_joint;
use crate::math::{mat4_transform_point, Quat, Vec3};
use crate::retarget::{
    fk_update, parent_world_quat, solve_bone_step, BoneRest, B_HEAD, B_HIPS, B_L_FOOT, B_L_LEG,
    B_L_TOE, B_L_UPLEG, B_R_FOOT, B_R_LEG, B_R_TOE, B_R_UPLEG, B_SPINE2, N_BONES,
};

#[inline]
pub(crate) fn foot_lowest_y(
    rest: &[BoneRest; N_BONES],
    world_positions: &[Vec3; N_BONES],
    b_foot: usize,
    b_toe: usize,
) -> Option<f32> {
    if !rest[b_foot].present {
        return None;
    }
    let mut y = world_positions[b_foot].y;
    if rest[b_toe].present {
        y = y.min(world_positions[b_toe].y);
    }
    Some(y)
}

#[inline]
fn smoothstep(edge0: f32, edge1: f32, x: f32) -> f32 {
    let t = ((x - edge0) / (edge1 - edge0).max(1e-5)).clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

/// Apply analytical reach-clamped 2-bone leg IK on `(upleg -> leg -> foot)` so `foot`
/// reaches `target_ankle_w` without knee hyperextension, backward knee flip, or axial twist,
/// using the solved in-plane hinge pole (`compute_in_plane_pole`).
#[allow(clippy::too_many_arguments)]
fn apply_two_bone_leg_ik(
    rest: &[BoneRest; N_BONES],
    rest_world_quats: &[Quat; N_BONES],
    cur_pos: &[Vec3; N_BONES],
    cur_quat: &mut [Quat; N_BONES],
    hips_parent_world_mat: &[f32; 16],
    hips_parent_world_quat: Quat,
    b_upleg: usize,
    b_leg: usize,
    b_foot: usize,
    target_ankle_w: Vec3,
    knee_pole_fwd: Vec3,
    blend: f32,
    world_mats: &mut [[f32; 16]; N_BONES],
    world_quats: &mut [Quat; N_BONES],
    world_positions: &mut [Vec3; N_BONES],
) {
    if !rest[b_upleg].present || !rest[b_leg].present || !rest[b_foot].present || blend <= 1e-4 {
        return;
    }
    let hip_w = world_positions[b_upleg];
    let knee_w = world_positions[b_leg];
    let ankle_w = world_positions[b_foot];
    let len_u = knee_w.sub(hip_w).len();
    let len_l = ankle_w.sub(knee_w).len();
    if len_u < 0.05 || len_l < 0.05 {
        return;
    }

    // Strict spherical projection inside anatomical [min_reach, max_reach] so IK never hyperextends
    let min_reach = (len_u - len_l).abs().max(0.24 * (len_u + len_l));
    let max_reach = (len_u + len_l) * 0.980;
    let to_target = target_ankle_w.sub(hip_w);
    let raw_dist = to_target.len();
    let clamped_target_w = if raw_dist > 1e-6 {
        let clamped_dist = raw_dist.clamp(min_reach, max_reach);
        hip_w.add(to_target.mul(clamped_dist / raw_dist))
    } else {
        ankle_w
    };

    // Guard knee hint against flipping backward past collinearity while preserving lateral turnout
    let chord_u = clamped_target_w.sub(hip_w).normalized();
    let raw_pole_off = knee_w.sub(hip_w);
    let perp_knee = raw_pole_off.sub(chord_u.mul(raw_pole_off.dot(chord_u)));
    let perp_fwd = knee_pole_fwd.sub(chord_u.mul(knee_pole_fwd.dot(chord_u)));
    let fwd_n = if perp_fwd.len_sq() > 1e-6 {
        perp_fwd.normalized()
    } else {
        knee_pole_fwd
    };
    let safe_knee_hint =
        if perp_knee.len_sq() < (len_u * 0.12).powi(2) || perp_knee.dot(fwd_n) < -len_u * 0.05 {
            hip_w.add(chord_u.mul(len_u * 0.5)).add(fwd_n.mul(len_u * 0.25))
        } else {
            knee_w.lerp(hip_w.add(fwd_n.mul(0.25)), 0.16)
        };

    let new_knee_w = solve_two_bone_mid_joint(hip_w, clamped_target_w, len_u, len_l, safe_knee_hint);
    let d_thigh = new_knee_w.sub(hip_w);
    let d_shin = clamped_target_w.sub(new_knee_w);
    if d_thigh.len_sq() < 1e-6 || d_shin.len_sq() < 1e-6 {
        return;
    }

    // Use the exact in-plane sagittal hinge normal `(d_thigh_u, d_shin_u)` so femur roll matches the knee bend
    let d_thigh_u = d_thigh.normalized();
    let d_shin_u = d_shin.normalized();
    let in_plane_pole = crate::retarget::compute_in_plane_pole(d_thigh_u, d_shin_u, fwd_n, Some(fwd_n));

    let prev_up = cur_quat[b_upleg];
    let q_up_target = solve_bone_step(
        rest,
        rest_world_quats,
        world_quats,
        hips_parent_world_quat,
        b_upleg,
        d_thigh_u,
        in_plane_pole,
        0.55,
        1.0,
        (95.0f32).to_radians(),
    );
    cur_quat[b_upleg] = prev_up.slerp(q_up_target, blend).normalized();
    fk_update(
        rest,
        cur_pos,
        cur_quat,
        hips_parent_world_mat,
        hips_parent_world_quat,
        world_mats,
        world_quats,
        world_positions,
    );

    let prev_low = cur_quat[b_leg];
    let cur_shin_dir = world_positions[b_foot].sub(world_positions[b_leg]);
    if cur_shin_dir.len_sq() > 1e-6 {
        let q_delta = Quat::from_unit_vectors(cur_shin_dir.normalized(), d_shin_u);
        let target_w_q = q_delta.mul(world_quats[b_leg]).normalized();
        let pq = parent_world_quat(rest, world_quats, hips_parent_world_quat, b_leg);
        let q_low_target = pq.conj().mul(target_w_q).normalized();
        cur_quat[b_leg] = prev_low.slerp(q_low_target, blend).normalized();
        fk_update(
            rest,
            cur_pos,
            cur_quat,
            hips_parent_world_mat,
            hips_parent_world_quat,
            world_mats,
            world_quats,
            world_positions,
        );
    }
}

/// Orient Foot pitch from heel-to-toe lift and articulate ToeBase dorsiflexion cleanly.
/// Returns the resolved desired world direction of `b_foot` so Post-IK leg correction preserves it.
#[allow(clippy::too_many_arguments)]
fn align_foot_and_toe(
    rest: &[BoneRest; N_BONES],
    rest_world_quats: &[Quat; N_BONES],
    cur_pos: &[Vec3; N_BONES],
    cur_quat: &mut [Quat; N_BONES],
    hips_parent_world_mat: &[f32; 16],
    hips_parent_world_quat: Quat,
    rest_min_foot_y: f32,
    hips_fwd: Vec3,
    b_foot: usize,
    b_toe: usize,
    locked: bool,
    heel_opt: Option<(Vec3, f32)>,
    toe_tgt_opt: Option<(Vec3, f32)>,
    world_mats: &mut [[f32; 16]; N_BONES],
    world_quats: &mut [Quat; N_BONES],
    world_positions: &mut [Vec3; N_BONES],
) -> Option<Vec3> {
    if !rest[b_foot].present {
        return None;
    }
    if let (Some((heel_p, hv)), Some((toe_p, tv))) = (heel_opt, toe_tgt_opt) {
        if hv > 0.25 && tv > 0.25 {
            let foot_delta_w = world_quats[b_foot].mul(rest_world_quats[b_foot].conj()).normalized();
            let foot_cur_dir = foot_delta_w.rotate_vec3(rest[b_foot].rest_aim_world).normalized();
            let horiz = Vec3::new(foot_cur_dir.x, 0.0, foot_cur_dir.z);
            if horiz.len_sq() > 1e-6 {
                let h_u = horiz.normalized();
                let heel_lift = heel_p.y - toe_p.y;
                let t_lift = ((heel_lift - 0.025) / 0.065).clamp(0.0, 1.0);
                let lift_w = t_lift * t_lift * (3.0 - 2.0 * t_lift);
                if lift_w > 0.02 || locked {
                    let cap_v = toe_p.sub(heel_p).normalized();
                    let steep_pitch = cap_v.y.clamp(-0.52, -0.08);
                    let flat_pitch = -0.05f32;
                    let pitch = flat_pitch * (1.0 - lift_w) + steep_pitch * lift_w;
                    let xz_scale = (1.0 - pitch * pitch).max(0.0).sqrt();
                    let target_foot_w = Vec3::new(h_u.x * xz_scale, pitch, h_u.z * xz_scale).normalized();
                    let blend_foot = if locked {
                        0.72 + 0.13 * lift_w
                    } else {
                        0.78 * lift_w
                    };
                    cur_quat[b_foot] = solve_bone_step(
                        rest,
                        rest_world_quats,
                        world_quats,
                        hips_parent_world_quat,
                        b_foot,
                        target_foot_w,
                        rest[b_foot].rest_pole_world,
                        0.0,
                        blend_foot,
                        38.0f32.to_radians(),
                    );
                    fk_update(
                        rest,
                        cur_pos,
                        cur_quat,
                        hips_parent_world_mat,
                        hips_parent_world_quat,
                        world_mats,
                        world_quats,
                        world_positions,
                    );
                }
            }
        }
    }

    let foot_delta_w = world_quats[b_foot].mul(rest_world_quats[b_foot].conj()).normalized();
    let desired_foot_dir = foot_delta_w.rotate_vec3(rest[b_foot].rest_aim_world).normalized();

    if rest[b_toe].present {
        let horizontal_fwd = Vec3::new(desired_foot_dir.x, 0.0, desired_foot_dir.z);
        let target_toe_dir = if horizontal_fwd.len_sq() > 1e-6 {
            let h_u = horizontal_fwd.normalized();
            let ankle_h_above_floor = (world_positions[b_foot].y - rest_min_foot_y).max(0.0);
            let heel_lift_w = match (heel_opt, toe_tgt_opt) {
                (Some((hp, hv)), Some((tp, tv))) if hv > 0.25 && tv > 0.25 => {
                    let t = (((hp.y - tp.y) - 0.025) / 0.065).clamp(0.0, 1.0);
                    t * t * (3.0 - 2.0 * t)
                }
                _ => 0.0,
            };
            let ankle_w = if locked {
                ((ankle_h_above_floor - 0.015) / 0.045).clamp(0.0, 1.0)
            } else {
                0.0
            };
            let ground_flex_w = heel_lift_w.max(ankle_w);
            let flat_pitch = desired_foot_dir.y.clamp(-0.08, 0.05);
            let air_pitch = if let (Some((heel_p, hv)), Some((toe_p, tv))) = (heel_opt, toe_tgt_opt) {
                if hv > 0.25 && tv > 0.25 {
                    let cap_v = toe_p.sub(heel_p);
                    if cap_v.len_sq() > 1e-5 {
                        (cap_v.normalized().y * 0.28).clamp(-0.18, 0.18)
                    } else {
                        -0.03
                    }
                } else {
                    -0.03
                }
            } else {
                -0.03
            };
            let base_pitch = if locked { flat_pitch } else { air_pitch };
            let toe_pitch_down = base_pitch * (1.0 - ground_flex_w);
            Vec3::new(h_u.x, toe_pitch_down, h_u.z).normalized()
        } else {
            hips_fwd
        };

        cur_quat[b_toe] = solve_bone_step(
            rest,
            rest_world_quats,
            world_quats,
            hips_parent_world_quat,
            b_toe,
            target_toe_dir,
            rest[b_toe].rest_pole_world,
            0.0,
            0.85,
            34.0f32.to_radians(),
        );
        fk_update(
            rest,
            cur_pos,
            cur_quat,
            hips_parent_world_mat,
            hips_parent_world_quat,
            world_mats,
            world_quats,
            world_positions,
        );
    }

    Some(desired_foot_dir)
}

/// After two-bone leg IK adjusts thigh/shin rotations, restore desired foot orientation
/// and flatten ToeBase horizontally against floor penetration.
#[allow(clippy::too_many_arguments)]
fn restore_foot_and_toe_after_ik(
    rest: &[BoneRest; N_BONES],
    rest_world_quats: &[Quat; N_BONES],
    cur_pos: &[Vec3; N_BONES],
    cur_quat: &mut [Quat; N_BONES],
    hips_parent_world_mat: &[f32; 16],
    hips_parent_world_quat: Quat,
    rest_min_foot_y: f32,
    b_foot: usize,
    b_toe: usize,
    locked: bool,
    desired_foot_dir_opt: Option<Vec3>,
    world_mats: &mut [[f32; 16]; N_BONES],
    world_quats: &mut [Quat; N_BONES],
    world_positions: &mut [Vec3; N_BONES],
) {
    if !rest[b_foot].present {
        return;
    }
    if let Some(desired_dir) = desired_foot_dir_opt {
        cur_quat[b_foot] = solve_bone_step(
            rest,
            rest_world_quats,
            world_quats,
            hips_parent_world_quat,
            b_foot,
            desired_dir,
            rest[b_foot].rest_pole_world,
            0.0,
            0.88,
            40.0f32.to_radians(),
        );
        fk_update(
            rest,
            cur_pos,
            cur_quat,
            hips_parent_world_mat,
            hips_parent_world_quat,
            world_mats,
            world_quats,
            world_positions,
        );
    }

    if rest[b_toe].present {
        let foot_delta_w = world_quats[b_foot].mul(rest_world_quats[b_foot].conj()).normalized();
        let foot_dir_w = foot_delta_w.rotate_vec3(rest[b_foot].rest_aim_world).normalized();
        let horiz = Vec3::new(foot_dir_w.x, 0.0, foot_dir_w.z);
        if horiz.len_sq() > 1e-6 {
            let h_u = horiz.normalized();
            let toe_y = world_positions[b_toe].y;
            let ankle_y = world_positions[b_foot].y;
            let toe_pen = (rest_min_foot_y - toe_y).max(0.0);
            let pitch = if locked || toe_pen > 0.001 {
                let lift_pitch = (toe_pen * 3.2).clamp(0.0, 0.28);
                let flat = ((ankle_y - rest_min_foot_y) * -0.15).clamp(-0.04, 0.02);
                lift_pitch.max(flat)
            } else {
                foot_dir_w.y.clamp(-0.10, 0.08)
            };
            let target_toe_dir = Vec3::new(h_u.x, pitch, h_u.z).normalized();
            cur_quat[b_toe] = solve_bone_step(
                rest,
                rest_world_quats,
                world_quats,
                hips_parent_world_quat,
                b_toe,
                target_toe_dir,
                rest[b_toe].rest_pole_world,
                0.0,
                0.86,
                34.0f32.to_radians(),
            );
            fk_update(
                rest,
                cur_pos,
                cur_quat,
                hips_parent_world_mat,
                hips_parent_world_quat,
                world_mats,
                world_quats,
                world_positions,
            );
        }
    }
}

/// Full-body biomechanical grounding + compliant two-foot stance IK + reach-safe pelvis assist + ToeBase articulation.
#[allow(clippy::too_many_arguments)]
pub fn solve_fullbody_ground_and_toes(
    rest: &[BoneRest; N_BONES],
    rest_world_quats: &[Quat; N_BONES],
    cur_pos: &mut [Vec3; N_BONES],
    cur_quat: &mut [Quat; N_BONES],
    hips_parent_world_mat: &[f32; 16],
    hips_parent_world_inv_mat: &[f32; 16],
    hips_parent_world_quat: Quat,
    rest_min_foot_y: f32,
    root_motion: bool,
    left_locked: bool,
    right_locked: bool,
    hips_fwd: Vec3,
    hips_side: Vec3,
    l_heel_opt: Option<(Vec3, f32)>,
    r_heel_opt: Option<(Vec3, f32)>,
    l_toe_target_opt: Option<(Vec3, f32)>,
    r_toe_target_opt: Option<(Vec3, f32)>,
    smooth_floor_dy: &mut f32,
    smooth_com_dxz: &mut [f32; 2],
    planted_xz: &mut [Option<Vec3>; 2],
    release_blend: &mut [f32; 2],
    first_frame: bool,
    world_mats: &mut [[f32; 16]; N_BONES],
    world_quats: &mut [Quat; N_BONES],
    world_positions: &mut [Vec3; N_BONES],
) {
    // 1. Coupled Pelvis Grounding (100% stance closure, smooth airborne fade on true jumps)
    if rest[B_HIPS].present {
        let l_fy = foot_lowest_y(rest, world_positions, B_L_FOOT, B_L_TOE);
        let r_fy = foot_lowest_y(rest, world_positions, B_R_FOOT, B_R_TOE);
        let min_all_y = match (l_fy, r_fy) {
            (Some(a), Some(b)) => Some(a.min(b)),
            (Some(a), None) => Some(a),
            (None, Some(b)) => Some(b),
            (None, None) => None,
        };
        let stance_y = match (left_locked, right_locked, l_fy, r_fy) {
            (true, false, Some(a), _) => Some(a),
            (false, true, _, Some(b)) => Some(b),
            _ => min_all_y,
        };

        if let (Some(min_all), Some(sy)) = (min_all_y, stance_y) {
            let needed_lift = rest_min_foot_y - min_all;
            let raw_dy = if needed_lift > 0.001 {
                needed_lift.clamp(0.0, 0.85)
            } else {
                let needed_drop = rest_min_foot_y - sy;
                if left_locked || right_locked {
                    let w = 1.0 - 0.65 * smoothstep(0.28, 0.48, -needed_drop);
                    (needed_drop * w).clamp(-0.42, 0.0)
                } else if !root_motion {
                    needed_drop.clamp(-0.65, 0.0)
                } else {
                    let air_gap = (-needed_drop).max(0.0);
                    let w = if air_gap <= 0.055 {
                        1.0
                    } else {
                        1.0 - smoothstep(0.055, 0.14, air_gap)
                    };
                    (needed_drop * w).clamp(-0.35, 0.0)
                }
            };

            *smooth_floor_dy = if first_frame {
                raw_dy
            } else if raw_dy > *smooth_floor_dy {
                (*smooth_floor_dy * 0.25 + raw_dy * 0.75).max(needed_lift.max(-1.0))
            } else {
                *smooth_floor_dy * 0.35 + raw_dy * 0.65
            };
            if min_all + *smooth_floor_dy < rest_min_foot_y - 0.001 {
                *smooth_floor_dy = rest_min_foot_y - min_all;
            }

            let hips_w = world_positions[B_HIPS];
            let grounded_w = Vec3::new(hips_w.x, hips_w.y + *smooth_floor_dy, hips_w.z);
            cur_pos[B_HIPS] = mat4_transform_point(hips_parent_world_inv_mat, grounded_w);
            fk_update(
                rest,
                cur_pos,
                cur_quat,
                hips_parent_world_mat,
                hips_parent_world_quat,
                world_mats,
                world_quats,
                world_positions,
            );
        }

        // 1b. COM/ZMP Stance-Polygon Balance Stabilization:
        let mut target_dx = 0.0f32;
        let mut target_dz = 0.0f32;
        if (left_locked || right_locked) && rest[B_L_FOOT].present && rest[B_R_FOOT].present {
            let p_hip = world_positions[B_HIPS];
            let p_chest = if rest[B_SPINE2].present {
                world_positions[B_SPINE2]
            } else {
                p_hip
            };
            let p_head = if rest[B_HEAD].present {
                world_positions[B_HEAD]
            } else {
                p_chest
            };
            let p_ll = if rest[B_L_LEG].present {
                world_positions[B_L_LEG]
            } else {
                p_hip
            };
            let p_rl = if rest[B_R_LEG].present {
                world_positions[B_R_LEG]
            } else {
                p_hip
            };
            let com_x = p_hip.x * 0.42 + p_chest.x * 0.28 + p_head.x * 0.08 + p_ll.x * 0.11 + p_rl.x * 0.11;
            let com_z = p_hip.z * 0.42 + p_chest.z * 0.28 + p_head.z * 0.08 + p_ll.z * 0.11 + p_rl.z * 0.11;

            let lf = world_positions[B_L_FOOT];
            let rf = world_positions[B_R_FOOT];
            let (min_x, max_x, min_z, max_z, gain) = match (left_locked, right_locked) {
                (true, true) => (
                    lf.x.min(rf.x) - 0.08,
                    lf.x.max(rf.x) + 0.08,
                    lf.z.min(rf.z) - 0.13,
                    lf.z.max(rf.z) + 0.13,
                    0.52f32,
                ),
                (true, false) => (lf.x - 0.09, lf.x + 0.09, lf.z - 0.13, lf.z + 0.13, 0.36f32),
                (false, true) => (rf.x - 0.09, rf.x + 0.09, rf.z - 0.13, rf.z + 0.13, 0.36f32),
                (false, false) => (com_x, com_x, com_z, com_z, 0.0),
            };
            let clamped_x = com_x.clamp(min_x, max_x);
            let clamped_z = com_z.clamp(min_z, max_z);
            target_dx = ((clamped_x - com_x) * gain).clamp(-0.042, 0.042);
            target_dz = ((clamped_z - com_z) * gain).clamp(-0.042, 0.042);
        }
        if first_frame {
            smooth_com_dxz[0] = target_dx;
            smooth_com_dxz[1] = target_dz;
        } else {
            smooth_com_dxz[0] = smooth_com_dxz[0] * 0.72 + target_dx * 0.28;
            smooth_com_dxz[1] = smooth_com_dxz[1] * 0.72 + target_dz * 0.28;
        }
        if smooth_com_dxz[0].abs() > 1e-4 || smooth_com_dxz[1].abs() > 1e-4 {
            let hips_w = world_positions[B_HIPS];
            let balanced_w = Vec3::new(hips_w.x + smooth_com_dxz[0], hips_w.y, hips_w.z + smooth_com_dxz[1]);
            cur_pos[B_HIPS] = mat4_transform_point(hips_parent_world_inv_mat, balanced_w);
            fk_update(
                rest,
                cur_pos,
                cur_quat,
                hips_parent_world_mat,
                hips_parent_world_quat,
                world_mats,
                world_quats,
                world_positions,
            );
        }
    }

    // 2a. Pre-IK Foot & Toe Orientation Pass: measure sole offset BEFORE leg IK targets
    let l_pole_hint = hips_fwd.add(hips_side.mul(0.08)).normalized();
    let r_pole_hint = hips_fwd.sub(hips_side.mul(0.08)).normalized();
    let leg_specs = [
        (0usize, left_locked, B_L_UPLEG, B_L_LEG, B_L_FOOT, B_L_TOE, l_heel_opt, l_toe_target_opt, l_pole_hint),
        (1usize, right_locked, B_R_UPLEG, B_R_LEG, B_R_FOOT, B_R_TOE, r_heel_opt, r_toe_target_opt, r_pole_hint),
    ];
    let mut desired_foot_dirs: [Option<Vec3>; 2] = [None, None];
    let mut sole_offsets: [f32; 2] = [0.0, 0.0];

    for &(side, locked, _, _, b_foot, b_toe, heel_opt, toe_tgt_opt, _) in &leg_specs {
        desired_foot_dirs[side] = align_foot_and_toe(
            rest,
            rest_world_quats,
            cur_pos,
            cur_quat,
            hips_parent_world_mat,
            hips_parent_world_quat,
            rest_min_foot_y,
            hips_fwd,
            b_foot,
            b_toe,
            locked,
            heel_opt,
            toe_tgt_opt,
            world_mats,
            world_quats,
            world_positions,
        );
        if rest[b_foot].present {
            let fy = foot_lowest_y(rest, world_positions, b_foot, b_toe).unwrap_or(world_positions[b_foot].y);
            sole_offsets[side] = (world_positions[b_foot].y - fy).clamp(0.0, 0.22);
        }
    }

    // 2b. Compliant Stance Anchors + Pelvis Reach-Deficit Assist
    let mut leg_targets = [Vec3::ZERO; 2];
    let mut leg_active = [false; 2];
    let mut leg_blends = [0.0f32; 2];
    let mut assist_pelvis_dy = 0.0f32;

    for &(side, locked, b_up, b_low, b_foot, b_toe, _, _, _) in &leg_specs {
        if !rest[b_up].present || !rest[b_low].present || !rest[b_foot].present {
            continue;
        }
        let hip_w = world_positions[b_up];
        let knee_w = world_positions[b_low];
        let ankle_cur = world_positions[b_foot];
        let len_u = knee_w.sub(hip_w).len();
        let len_l = ankle_cur.sub(knee_w).len();
        let safe_reach = (len_u + len_l) * 0.968;
        let fy = foot_lowest_y(rest, world_positions, b_foot, b_toe).unwrap_or(rest_min_foot_y);
        let floor_ankle_y = rest_min_foot_y + sole_offsets[side];
        let err_y = rest_min_foot_y - fy;
        let needs_lift = err_y > 0.0015;
        let wants_ground = locked || needs_lift || (err_y > -0.025 && !root_motion);

        let target_y = if locked {
            floor_ankle_y
        } else if needs_lift {
            ankle_cur.y + err_y.clamp(0.0, 0.22)
        } else {
            ankle_cur.y.max(floor_ankle_y)
        };

        let mut target_xz = (ankle_cur.x, ankle_cur.z);
        let mut ik_blend = 0.0f32;
        if locked {
            let mut anchor = planted_xz[side].unwrap_or(Vec3::new(ankle_cur.x, target_y, ankle_cur.z));
            anchor.y = target_y;

            let dx = anchor.x - ankle_cur.x;
            let dz = anchor.z - ankle_cur.z;
            let drift_xz = (dx * dx + dz * dz).sqrt();
            if drift_xz > 0.14 {
                let s = 0.14 / drift_xz;
                anchor.x = ankle_cur.x + dx * s;
                anchor.z = ankle_cur.z + dz * s;
            }
            let diff_h = Vec3::new(anchor.x - hip_w.x, target_y - hip_w.y, anchor.z - hip_w.z);
            let h_dist = diff_h.len();
            if h_dist > safe_reach * 1.02 && (diff_h.x * diff_h.x + diff_h.z * diff_h.z) > 1e-6 {
                let cur_h = (diff_h.x * diff_h.x + diff_h.z * diff_h.z).sqrt();
                let max_h = ((safe_reach * 1.01).powi(2) - (target_y - hip_w.y).powi(2))
                    .max(0.0)
                    .sqrt();
                if cur_h > max_h {
                    let s = max_h / cur_h;
                    anchor.x = hip_w.x + diff_h.x * s;
                    anchor.z = hip_w.z + diff_h.z * s;
                }
            }
            planted_xz[side] = Some(anchor);
            release_blend[side] = 1.0;
            target_xz = (anchor.x, anchor.z);
            ik_blend = 0.92;
        } else if planted_xz[side].is_some() && release_blend[side] > 0.02 {
            release_blend[side] = (release_blend[side] - 0.34).max(0.0);
            let w_rel = release_blend[side];
            let anchor = planted_xz[side].unwrap();
            target_xz = (
                ankle_cur.x + (anchor.x - ankle_cur.x) * w_rel,
                ankle_cur.z + (anchor.z - ankle_cur.z) * w_rel,
            );
            ik_blend = (0.78 * w_rel).max(if needs_lift { 0.88 } else { 0.0 });
            if release_blend[side] <= 0.01 {
                planted_xz[side] = None;
            }
        } else {
            planted_xz[side] = None;
            release_blend[side] = 0.0;
            if needs_lift {
                ik_blend = 0.92;
            } else if wants_ground && err_y < -0.002 {
                ik_blend = 0.84;
            }
        }

        let tgt = Vec3::new(target_xz.0, target_y, target_xz.1);
        leg_targets[side] = tgt;
        leg_active[side] = ik_blend > 1e-3 && (wants_ground || tgt.sub(ankle_cur).len_sq() > 1e-6);
        leg_blends[side] = ik_blend;

        if (locked || needs_lift) && safe_reach > 0.1 {
            let diff = tgt.sub(hip_w);
            let dist = diff.len();
            if dist > safe_reach {
                let h2 = diff.x * diff.x + diff.z * diff.z;
                let max_vertical = (safe_reach * safe_reach - h2).max(0.0).sqrt();
                let needed_hip_y = tgt.y + max_vertical;
                let d_y = (needed_hip_y - hip_w.y).clamp(-0.14, 0.0);
                if d_y < assist_pelvis_dy {
                    assist_pelvis_dy = d_y;
                }
            }
        }
    }

    if assist_pelvis_dy < -0.001 && rest[B_HIPS].present {
        let hips_w = world_positions[B_HIPS];
        let assisted_w = Vec3::new(hips_w.x, hips_w.y + assist_pelvis_dy, hips_w.z);
        cur_pos[B_HIPS] = mat4_transform_point(hips_parent_world_inv_mat, assisted_w);
        fk_update(
            rest,
            cur_pos,
            cur_quat,
            hips_parent_world_mat,
            hips_parent_world_quat,
            world_mats,
            world_quats,
            world_positions,
        );
    }

    // 2c. Closed-loop Two-Bone Leg IK + Post-IK Foot Restoration + Sub-millimeter Closure
    for &(side, locked, b_up, b_low, b_foot, b_toe, _, _, pole_hint) in &leg_specs {
        if !leg_active[side] {
            continue;
        }
        apply_two_bone_leg_ik(
            rest,
            rest_world_quats,
            cur_pos,
            cur_quat,
            hips_parent_world_mat,
            hips_parent_world_quat,
            b_up,
            b_low,
            b_foot,
            leg_targets[side],
            pole_hint,
            leg_blends[side],
            world_mats,
            world_quats,
            world_positions,
        );
        restore_foot_and_toe_after_ik(
            rest,
            rest_world_quats,
            cur_pos,
            cur_quat,
            hips_parent_world_mat,
            hips_parent_world_quat,
            rest_min_foot_y,
            b_foot,
            b_toe,
            locked,
            desired_foot_dirs[side],
            world_mats,
            world_quats,
            world_positions,
        );

        if let Some(fy_now) = foot_lowest_y(rest, world_positions, b_foot, b_toe) {
            let res_err = rest_min_foot_y - fy_now;
            if res_err > 0.0012 || (locked && res_err.abs() > 0.0018 && res_err.abs() < 0.09) {
                let ank_now = world_positions[b_foot];
                let tgt2 = Vec3::new(
                    leg_targets[side].x,
                    ank_now.y + res_err.clamp(-0.08, 0.14),
                    leg_targets[side].z,
                );
                apply_two_bone_leg_ik(
                    rest,
                    rest_world_quats,
                    cur_pos,
                    cur_quat,
                    hips_parent_world_mat,
                    hips_parent_world_quat,
                    b_up,
                    b_low,
                    b_foot,
                    tgt2,
                    pole_hint,
                    0.90,
                    world_mats,
                    world_quats,
                    world_positions,
                );
                restore_foot_and_toe_after_ik(
                    rest,
                    rest_world_quats,
                    cur_pos,
                    cur_quat,
                    hips_parent_world_mat,
                    hips_parent_world_quat,
                    rest_min_foot_y,
                    b_foot,
                    b_toe,
                    locked,
                    desired_foot_dirs[side],
                    world_mats,
                    world_quats,
                    world_positions,
                );
            }
        }
    }
}
