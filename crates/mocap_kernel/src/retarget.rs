//! Pure-Rust Humanoid Mocap Retargeter:
//! Runs exact 20-bone FK, automatic +Y-down -> +Y-up coordinate normalization,
//! stabilized torso basis, pole-vector swing-twist limbs, anatomical hinge and
//! anti-crossover clamping, smooth ground contact projection, and dt-aware
//! zero-phase quaternion track smoothing with zero heap churn per frame.

use crate::math::{mat4_compose, mat4_mul, mat4_transform_point, median_f32, solve_aim_with_pole, Quat, Vec3};
use std::f32::consts::PI;

pub const N_BONES: usize = 22;
pub const N_CORE_BONES: usize = 20;
pub const BONE_SLOT_FLOATS: usize = 18;
pub const N_JOINTS: usize = 25;

// Bone slot indices (must match JS BONE_ORDER exactly)
pub const B_HIPS: usize = 0;
pub const B_SPINE: usize = 1;
pub const B_SPINE1: usize = 2;
pub const B_SPINE2: usize = 3;
pub const B_NECK: usize = 4;
pub const B_HEAD: usize = 5;
pub const B_L_SHOULDER: usize = 6;
pub const B_L_ARM: usize = 7;
pub const B_L_FOREARM: usize = 8;
pub const B_L_HAND: usize = 9;
pub const B_R_SHOULDER: usize = 10;
pub const B_R_ARM: usize = 11;
pub const B_R_FOREARM: usize = 12;
pub const B_R_HAND: usize = 13;
pub const B_L_UPLEG: usize = 14;
pub const B_L_LEG: usize = 15;
pub const B_L_FOOT: usize = 16;
pub const B_R_UPLEG: usize = 17;
pub const B_R_LEG: usize = 18;
pub const B_R_FOOT: usize = 19;
pub const B_L_TOE: usize = 20;
pub const B_R_TOE: usize = 21;

// Canonical Joint slots (`N_JOINTS = 25`, packed by mocap-kernel-bridge.js)
pub const J_HIPS: usize = 0;
pub const J_SPINE: usize = 1;
pub const J_NECK: usize = 2;
pub const J_HEAD: usize = 3;
pub const J_NOSE: usize = 4;
pub const J_L_EAR: usize = 5;
pub const J_R_EAR: usize = 6;
pub const J_L_SHOULDER: usize = 7;
pub const J_L_ELBOW: usize = 8;
pub const J_L_WRIST: usize = 9;
pub const J_L_HAND: usize = 10;
pub const J_R_SHOULDER: usize = 11;
pub const J_R_ELBOW: usize = 12;
pub const J_R_WRIST: usize = 13;
pub const J_R_HAND: usize = 14;
pub const J_L_HIP: usize = 15;
pub const J_L_KNEE: usize = 16;
pub const J_L_ANKLE: usize = 17;
pub const J_L_FOOT: usize = 18;
pub const J_R_HIP: usize = 19;
pub const J_R_KNEE: usize = 20;
pub const J_R_ANKLE: usize = 21;
pub const J_R_FOOT: usize = 22;
pub const J_L_HEEL: usize = 23;
pub const J_R_HEEL: usize = 24;

#[derive(Clone, Copy)]
pub struct BoneRest {
    pub present: bool,
    pub parent: i32,
    pub local_pos: Vec3,
    pub local_quat: Quat,
    pub local_scale: Vec3,
    pub rest_aim_world: Vec3,
    pub rest_pole_world: Vec3,
}

#[derive(Clone, Copy)]
pub struct RetargetConfig {
    pub fps: f32,
    pub root_motion: bool,
    pub root_scale: f32,
    pub depth_scale: f32,
    pub root_rotation_weight: f32,
    pub smoothness: f32,
    pub mirror_x: bool,
    pub facing_offset_deg: f32,
    pub auto_facing: bool,
    pub pole_weight: f32,
    pub char_height: f32,
    pub rest_min_foot_y: f32,
    pub torso_radius: f32,
    pub thigh_radius: f32,
    pub use_fullbody_ik: bool,
    pub disable_grounding: bool,
    pub rest_hips_world_pos: Vec3,
    pub rest_hips_world_quat: Quat,
    pub rest_hips_right: Vec3,
    pub rest_hips_fwd: Vec3,
    pub rest_torso_up: Vec3,
    pub rest_head_fwd: Vec3,
    pub hips_parent_world_quat: Quat,
    pub hips_parent_world_mat: [f32; 16],
    pub hips_parent_world_inv_mat: [f32; 16],
}

#[inline]
fn read_bone_slots(bone_slots: &[f32]) -> [BoneRest; N_BONES] {
    let mut out = [BoneRest {
        present: false,
        parent: -1,
        local_pos: Vec3::ZERO,
        local_quat: Quat::IDENTITY,
        local_scale: Vec3::new(1.0, 1.0, 1.0),
        rest_aim_world: Vec3::Y,
        rest_pole_world: Vec3::Z,
    }; N_BONES];

    for b in 0..N_BONES {
        let base = b * BONE_SLOT_FLOATS;
        if base + BONE_SLOT_FLOATS > bone_slots.len() {
            break;
        }
        out[b] = BoneRest {
            present: bone_slots[base] > 0.5,
            parent: bone_slots[base + 1].round() as i32,
            local_pos: Vec3::new(bone_slots[base + 2], bone_slots[base + 3], bone_slots[base + 4]),
            local_quat: Quat::new(
                bone_slots[base + 5],
                bone_slots[base + 6],
                bone_slots[base + 7],
                bone_slots[base + 8],
            )
            .normalized(),
            local_scale: Vec3::new(bone_slots[base + 9], bone_slots[base + 10], bone_slots[base + 11]),
            rest_aim_world: Vec3::new(bone_slots[base + 12], bone_slots[base + 13], bone_slots[base + 14]),
            rest_pole_world: Vec3::new(bone_slots[base + 15], bone_slots[base + 16], bone_slots[base + 17]),
        };
    }
    out
}

/// Forward kinematics over the canonical bones in topological order `0..N_BONES-1`.
pub fn fk_update(
    rest: &[BoneRest; N_BONES],
    cur_pos: &[Vec3; N_BONES],
    cur_quat: &[Quat; N_BONES],
    root_world_mat: &[f32; 16],
    root_world_quat: Quat,
    world_mats: &mut [[f32; 16]; N_BONES],
    world_quats: &mut [Quat; N_BONES],
    world_positions: &mut [Vec3; N_BONES],
) {
    for b in 0..N_BONES {
        if !rest[b].present {
            world_mats[b] = *root_world_mat;
            world_quats[b] = root_world_quat;
            world_positions[b] = Vec3::new(root_world_mat[12], root_world_mat[13], root_world_mat[14]);
            continue;
        }
        let local_mat = mat4_compose(cur_pos[b], cur_quat[b], rest[b].local_scale);
        let p = rest[b].parent;
        if p >= 0 && (p as usize) < b && rest[p as usize].present {
            let pi = p as usize;
            world_mats[b] = mat4_mul(&world_mats[pi], &local_mat);
            world_quats[b] = world_quats[pi].mul(cur_quat[b]).normalized();
        } else {
            world_mats[b] = mat4_mul(root_world_mat, &local_mat);
            world_quats[b] = root_world_quat.mul(cur_quat[b]).normalized();
        }
        world_positions[b] = Vec3::new(world_mats[b][12], world_mats[b][13], world_mats[b][14]);
    }
}

#[inline]
pub fn parent_world_quat(
    rest: &[BoneRest; N_BONES],
    world_quats: &[Quat; N_BONES],
    hips_parent_q: Quat,
    b: usize,
) -> Quat {
    let p = rest[b].parent;
    if p >= 0 && (p as usize) < N_BONES && rest[p as usize].present {
        world_quats[p as usize]
    } else {
        hips_parent_q
    }
}

#[inline]
fn rot_y_vec(v: Vec3, yaw_rad: f32) -> Vec3 {
    if yaw_rad.abs() < 1e-6 {
        return v;
    }
    let c = yaw_rad.cos();
    let s = yaw_rad.sin();
    Vec3::new(v.x * c + v.z * s, v.y, -v.x * s + v.z * c)
}

#[inline]
fn joint_at(
    joints: &[f32],
    f: usize,
    stride_joints: usize,
    idx: usize,
    y_flip: f32,
    mirror_x: bool,
    yaw_rad: f32,
) -> (Vec3, f32) {
    if idx >= stride_joints {
        return (Vec3::ZERO, 0.0);
    }
    let b = (f * stride_joints + idx) * 4;
    let x = if mirror_x { -joints[b] } else { joints[b] };
    // MediaPipe (+Y down, +Z into camera) -> Three.js (+Y up, +Z toward viewer) flips (y, z)
    let y = joints[b + 1] * y_flip;
    let z = joints[b + 2] * y_flip;
    (rot_y_vec(Vec3::new(x, y, z), yaw_rad), joints[b + 3])
}

/// Detect whether raw input joints are in MediaPipe "+Y down" space (shoulder.y < hip.y / ankle.y > hip.y).
fn detect_y_down(joints: &[f32], n_frames: usize, stride_joints: usize) -> bool {
    let mut torso_dys = Vec::with_capacity(n_frames);
    let mut leg_dys = Vec::with_capacity(n_frames);
    for f in 0..n_frames {
        let (ls, lsv) = joint_at(joints, f, stride_joints, J_L_SHOULDER, 1.0, false, 0.0);
        let (rs, rsv) = joint_at(joints, f, stride_joints, J_R_SHOULDER, 1.0, false, 0.0);
        let (lh, lhv) = joint_at(joints, f, stride_joints, J_L_HIP, 1.0, false, 0.0);
        let (rh, rhv) = joint_at(joints, f, stride_joints, J_R_HIP, 1.0, false, 0.0);
        if lsv > 0.1 && rsv > 0.1 && lhv > 0.1 && rhv > 0.1 {
            let mid_sh_y = 0.5 * (ls.y + rs.y);
            let mid_hip_y = 0.5 * (lh.y + rh.y);
            torso_dys.push(mid_sh_y - mid_hip_y);
        }
        let (la, lav) = joint_at(joints, f, stride_joints, J_L_ANKLE, 1.0, false, 0.0);
        if lhv > 0.1 && lav > 0.1 {
            leg_dys.push(lh.y - la.y);
        }
    }
    if !torso_dys.is_empty() && median_f32(&mut torso_dys) < -0.05 {
        return true;
    }
    if !leg_dys.is_empty() && median_f32(&mut leg_dys) < -0.05 {
        return true;
    }
    false
}

/// Solve torso axes matching Three.js character convention:
/// `side = left - right` (`+X` on character facing `+Z`), `up = +Y`, `fwd = side x up` (`+Z`).
fn solve_frame_torso_basis(
    l_hip: Vec3,
    r_hip: Vec3,
    l_sho: Vec3,
    r_sho: Vec3,
    fallback_side: Vec3,
    fallback_fwd: Vec3,
) -> (Vec3, Vec3, Vec3, Vec3) {
    let hips_center = l_hip.add(r_hip).mul(0.5);
    let sh_center = l_sho.add(r_sho).mul(0.5);
    let raw_up = sh_center.sub(hips_center);
    // Smoothly blend upright Vec3::Y -> raw_up without a discontinuous threshold snap
    // when bending forward/downward across raw_up.y ~ 0.05 (prevents ~175° pelvis flips).
    let torso_up = if raw_up.len_sq() > 1e-6 {
        let up_n = raw_up.normalized();
        let t = ((up_n.y + 0.22) / 0.57).clamp(0.0, 1.0);
        let smooth_w = t * t * (3.0 - 2.0 * t);
        let blended = Vec3::Y.lerp(up_n, smooth_w);
        if blended.len_sq() > 1e-6 {
            blended.normalized()
        } else {
            Vec3::Y
        }
    } else {
        Vec3::Y
    };

    let hip_raw = l_hip.sub(r_hip);
    let sh_raw = l_sho.sub(r_sho);
    let hip_diff = Vec3::new(hip_raw.x, hip_raw.y * 0.35, hip_raw.z).normalized();
    let sh_diff = Vec3::new(sh_raw.x, sh_raw.y * 0.35, sh_raw.z).normalized();

    // Project onto a softly damped pelvis up axis first so extreme horizontal spine lean
    // does not annihilate lateral X/Z direction or invert L/R sign via noisy vertical Y.
    let pelvis_ref_up = Vec3::Y.lerp(torso_up, 0.42).normalized();
    let mut pelvis_side = hip_diff.mul(0.55).add(sh_diff.mul(0.45));
    pelvis_side = pelvis_side.project_onto_plane(pelvis_ref_up);
    if pelvis_side.len_sq() < 1e-6 {
        pelvis_side = fallback_side;
    } else {
        pelvis_side = pelvis_side.normalized();
    }

    let chest_ref_up = Vec3::Y.lerp(torso_up, 0.72).normalized();
    let mut chest_side = sh_diff.mul(0.80).add(hip_diff.mul(0.20));
    chest_side = chest_side.project_onto_plane(chest_ref_up);
    if chest_side.len_sq() < 1e-6 {
        chest_side = pelvis_side;
    } else {
        chest_side = chest_side.normalized();
    }

    let mut pelvis_fwd = pelvis_side.cross(pelvis_ref_up);
    pelvis_fwd = if pelvis_fwd.len_sq() > 1e-6 {
        pelvis_fwd.normalized()
    } else {
        fallback_fwd
    };

    (torso_up, pelvis_side, pelvis_fwd, chest_side)
}

#[inline]
fn signed_angle_xz(a: Vec3, b: Vec3) -> f32 {
    let cross_y = a.z * b.x - a.x * b.z;
    let dot = a.x * b.x + a.z * b.z;
    cross_y.atan2(dot)
}

fn estimate_auto_yaw_rad(
    joints: &[f32],
    n_frames: usize,
    stride_joints: usize,
    y_flip: f32,
    mirror_x: bool,
    rest_hips_right: Vec3,
    rest_hips_fwd: Vec3,
) -> f32 {
    let mut sum_sin = 0.0f32;
    let mut sum_cos = 0.0f32;
    let mut count = 0usize;

    let start_idx = if n_frames > 20 { (n_frames as f32 * 0.08) as usize } else { 0 };
    let end_idx = if n_frames > 20 { ((n_frames as f32 * 0.92).ceil() as usize).min(n_frames) } else { n_frames };

    for f in start_idx..end_idx {
        let (lh, lhv) = joint_at(joints, f, stride_joints, J_L_HIP, y_flip, mirror_x, 0.0);
        let (rh, rhv) = joint_at(joints, f, stride_joints, J_R_HIP, y_flip, mirror_x, 0.0);
        let (ls, lsv) = joint_at(joints, f, stride_joints, J_L_SHOULDER, y_flip, mirror_x, 0.0);
        let (rs, rsv) = joint_at(joints, f, stride_joints, J_R_SHOULDER, y_flip, mirror_x, 0.0);
        if lhv.min(rhv).min(lsv).min(rsv) < 0.25 {
            continue;
        }
        let side_vec = lh.sub(rh).mul(0.55).add(ls.sub(rs).mul(0.45));
        let side_xz = Vec3::new(side_vec.x, 0.0, side_vec.z);
        if side_xz.len_sq() < 1e-4 {
            continue;
        }
        let side_u = side_xz.normalized();
        let fwd_u = side_u.cross(Vec3::Y).normalized();
        let ang = signed_angle_xz(fwd_u, rest_hips_fwd);
        sum_sin += ang.sin();
        sum_cos += ang.cos();
        count += 1;
    }

    let _ = rest_hips_right;
    if count == 0 {
        return 0.0;
    }
    sum_sin.atan2(sum_cos)
}

fn constrain_thigh(vec: Vec3, side: Vec3, up: Vec3, fwd: Vec3, is_left: bool) -> Vec3 {
    let l = vec.len();
    if l < 1e-6 {
        return Vec3::new(0.0, -1.0, 0.0);
    }
    let u = vec.mul(1.0 / l);
    let mut s = u.dot(side);
    let mut y = u.dot(up);
    let mut f = u.dot(fwd);
    if is_left {
        s = s.clamp(-0.10, 0.62);
    } else {
        s = s.clamp(-0.62, 0.10);
    }
    // Limit hyper-backward leg split while keeping high kicks natural
    f = f.max(-0.55);
    y = y.min(0.62);
    let out = side.mul(s).add(up.mul(y)).add(fwd.mul(f)).normalized();
    if out.len_sq() > 1e-6 { out } else { Vec3::new(0.0, -1.0, 0.0) }
}

fn constrain_shin(vec: Vec3, thigh_u: Vec3, side: Vec3, fwd: Vec3, is_left: bool) -> Vec3 {
    let l = vec.len();
    if l < 1e-6 {
        return thigh_u;
    }
    let mut u = vec.mul(1.0 / l);
    let s = u.dot(side);
    if is_left && s < -0.10 {
        u = u.add(side.mul(-0.10 - s)).normalized();
    } else if !is_left && s > 0.10 {
        u = u.add(side.mul(0.10 - s)).normalized();
    }
    let along = u.dot(thigh_u);
    let perp = u.sub(thigh_u.mul(along));
    let fwd_comp = perp.dot(fwd);
    // Strict knee hinge: prevent forward knee hyperextension ("đầu gối gập ngược")
    if fwd_comp > 0.03 {
        u = u.sub(fwd.mul(fwd_comp - 0.03)).normalized();
    }
    // Clamp extreme fold (> ~152 deg) against impossible self-intersection
    if u.dot(thigh_u) < -0.88 {
        u = thigh_u.mul(-0.88).add(u.project_onto_plane(thigh_u).normalized().mul(0.474)).normalized();
    }
    u
}

fn constrain_arm(vec: Vec3, side: Vec3, fwd: Vec3, is_left: bool) -> Vec3 {
    let l = vec.len();
    if l < 1e-6 {
        return if is_left { side } else { side.mul(-1.0) };
    }
    let mut u = vec.mul(1.0 / l);
    let s = u.dot(side);
    let f = u.dot(fwd);
    // Prevent upper arm from swinging laterally through/behind torso into opposite side ("dính người")
    if f < 0.35 {
        if is_left && s < -0.12 {
            u = u.add(side.mul(-0.12 - s)).normalized();
        } else if !is_left && s > 0.12 {
            u = u.add(side.mul(0.12 - s)).normalized();
        }
    }
    // Soft limit posterior shoulder hyper-extension behind back
    if f < -0.62 {
        u = u.add(fwd.mul(-0.62 - f)).normalized();
    }
    u
}

fn constrain_forearm(vec: Vec3, upper_u: Vec3) -> Vec3 {
    let l = vec.len();
    if l < 1e-6 {
        return upper_u;
    }
    let mut u = vec.mul(1.0 / l);
    // Limit impossible > ~148 deg backward fold onto shoulder
    let d = u.dot(upper_u);
    if d < -0.85 {
        let perp = u.project_onto_plane(upper_u);
        let p_u = if perp.len_sq() > 1e-6 { perp.normalized() } else { Vec3::Z.project_onto_plane(upper_u).normalized() };
        u = upper_u.mul(-0.85).add(p_u.mul(0.526)).normalized();
    }
    u
}

#[inline]
fn smoothstep_scalar(e0: f32, e1: f32, x: f32) -> f32 {
    let t = ((x - e0) / (e1 - e0).max(1e-5)).clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

/// True in-plane Blender IK Pole Vector: points out of the joint bend apex (`d_upper - d_lower`)
/// smoothly cross-fading to `fallback_pole` as the limb approaches straight extension.
pub(crate) fn compute_in_plane_pole(
    d_upper: Vec3,
    d_lower: Vec3,
    fallback_pole: Vec3,
    anterior_hint: Option<Vec3>,
) -> Vec3 {
    let chord = d_upper.add(d_lower);
    let bend_cos = d_upper.dot(d_lower).clamp(-1.0, 1.0);
    let bend_strength = smoothstep_scalar(0.015, 0.18, 1.0 - bend_cos);
    if chord.len_sq() < 1e-6 || bend_strength < 1e-4 {
        return fallback_pole;
    }
    let chord_u = chord.normalized();
    let mut apex = d_upper.sub(d_lower).project_onto_plane(chord_u);
    if apex.len_sq() < 1e-6 {
        return fallback_pole;
    }
    apex = apex.normalized();
    if let Some(ant) = anterior_hint {
        // Knees must face anteriorly (+hips_fwd), never flip posteriorly behind the leg
        let d_ant = apex.dot(ant);
        if d_ant < 0.05 {
            apex = apex.sub(ant.mul(d_ant - 0.15)).normalized();
        }
    }
    fallback_pole.lerp(apex, bend_strength).normalized()
}

/// Core Helper: rotate bone `b` smoothly using current FK world quat + inherited ancestor delta.
#[allow(clippy::too_many_arguments)]
pub fn solve_bone_step(
    rest: &[BoneRest; N_BONES],
    rest_world_quats: &[Quat; N_BONES],
    world_quats: &[Quat; N_BONES],
    hips_parent_world_quat: Quat,
    b: usize,
    desired_dir_w: Vec3,
    desired_pole_w: Vec3,
    pole_weight: f32,
    blend_weight: f32,
    max_delta_rad: f32,
) -> Quat {
    let cur_world_q = world_quats[b];
    let inherited_delta = cur_world_q.mul(rest_world_quats[b].conj()).normalized();
    let cur_aim_w = inherited_delta.rotate_vec3(rest[b].rest_aim_world);
    let cur_pole_w = inherited_delta.rotate_vec3(rest[b].rest_pole_world);

    let mut q_delta = solve_aim_with_pole(cur_aim_w, desired_dir_w, cur_pole_w, desired_pole_w, pole_weight);
    if blend_weight < 0.999 {
        q_delta = Quat::IDENTITY.slerp(q_delta, blend_weight.clamp(0.0, 1.0));
    }
    if max_delta_rad < PI - 1e-3 {
        q_delta = q_delta.clamp_angle(max_delta_rad);
    }
    let target_world_q = q_delta.mul(cur_world_q).normalized();
    let parent_q = parent_world_quat(rest, world_quats, hips_parent_world_quat, b);
    parent_q.conj().mul(target_world_q).normalized()
}

pub fn retarget_humanoid(
    bone_slots: &[f32],
    joints: &[f32],
    root_traj: &[f32],
    foot_flags: &[u8],
    n_frames: usize,
    stride_joints: usize,
    cfg: &RetargetConfig,
    out_quats: &mut [f32],
    out_hips_pos: &mut [f32],
) {
    retarget_humanoid_ext(
        bone_slots,
        joints,
        root_traj,
        foot_flags,
        n_frames,
        stride_joints,
        N_CORE_BONES,
        cfg,
        out_quats,
        out_hips_pos,
    );
}

#[allow(clippy::too_many_arguments)]
pub fn retarget_humanoid_ext(
    bone_slots: &[f32],
    joints: &[f32],
    root_traj: &[f32],
    foot_flags: &[u8],
    n_frames: usize,
    stride_joints: usize,
    n_out_bones: usize,
    cfg: &RetargetConfig,
    out_quats: &mut [f32],
    out_hips_pos: &mut [f32],
) {
    let n_out = n_out_bones.clamp(1, N_BONES);
    if n_frames == 0 || out_quats.len() < n_frames * n_out * 4 || out_hips_pos.len() < n_frames * 3 {
        return;
    }
    let mut work_quats = vec![0.0f32; n_frames * N_BONES * 4];

    let rest = read_bone_slots(bone_slots);
    let mut rest_pos = [Vec3::ZERO; N_BONES];
    let mut rest_quat = [Quat::IDENTITY; N_BONES];
    for b in 0..N_BONES {
        rest_pos[b] = rest[b].local_pos;
        rest_quat[b] = rest[b].local_quat;
    }
    let mut rest_world_mats = [[0.0f32; 16]; N_BONES];
    let mut rest_world_quats = [Quat::IDENTITY; N_BONES];
    let mut rest_world_pos = [Vec3::ZERO; N_BONES];
    fk_update(
        &rest,
        &rest_pos,
        &rest_quat,
        &cfg.hips_parent_world_mat,
        cfg.hips_parent_world_quat,
        &mut rest_world_mats,
        &mut rest_world_quats,
        &mut rest_world_pos,
    );

    let is_y_down = detect_y_down(joints, n_frames, stride_joints);
    let y_flip = if is_y_down { -1.0f32 } else { 1.0f32 };

    let total_yaw = if cfg.auto_facing {
        estimate_auto_yaw_rad(
            joints,
            n_frames,
            stride_joints,
            y_flip,
            cfg.mirror_x,
            cfg.rest_hips_right,
            cfg.rest_hips_fwd,
        ) + cfg.facing_offset_deg.to_radians()
    } else {
        cfg.facing_offset_deg.to_radians()
    };

    let scale_factor = (cfg.char_height / 1.72).clamp(0.45, 2.5);

    let mut cur_pos;
    let mut cur_quat;
    let mut world_mats = rest_world_mats;
    let mut world_quats = rest_world_quats;
    let mut world_positions = rest_world_pos;

    let mut smooth_floor_dy = 0.0f32;
    let mut smooth_com_dxz = [0.0f32; 2];
    let mut planted_xz: [Option<Vec3>; 2] = [None, None];
    let mut release_blend: [f32; 2] = [0.0, 0.0];
    let dt_loop = 1.0 / cfg.fps.max(1.0);
    let max_arm_pole_step = (26.0f32.to_radians() * (dt_loop * 30.0).clamp(0.65, 1.8)).clamp(0.28, 0.85);
    let mut prev_arm_poles: [Option<Vec3>; 2] = [None, None];

    for f in 0..n_frames {
        cur_pos = rest_pos;
        cur_quat = rest_quat;
        macro_rules! sync_fk {
            () => {
                fk_update(
                    &rest,
                    &cur_pos,
                    &cur_quat,
                    &cfg.hips_parent_world_mat,
                    cfg.hips_parent_world_quat,
                    &mut world_mats,
                    &mut world_quats,
                    &mut world_positions,
                );
            };
        }
        sync_fk!();

        let (lh_p, lh_v) = joint_at(joints, f, stride_joints, J_L_HIP, y_flip, cfg.mirror_x, total_yaw);
        let (rh_p, rh_v) = joint_at(joints, f, stride_joints, J_R_HIP, y_flip, cfg.mirror_x, total_yaw);
        let (ls_p, ls_v) = joint_at(joints, f, stride_joints, J_L_SHOULDER, y_flip, cfg.mirror_x, total_yaw);
        let (rs_p, rs_v) = joint_at(joints, f, stride_joints, J_R_SHOULDER, y_flip, cfg.mirror_x, total_yaw);

        let (torso_up, pelvis_side, _pelvis_fwd, chest_side) = solve_frame_torso_basis(
            lh_p,
            rh_p,
            ls_p,
            rs_p,
            cfg.rest_hips_right,
            cfg.rest_hips_fwd,
        );

        // Natural torso/pelvis groove balance (~42% of torso lean, damped lateral roll)
        let hips_up = Vec3::Y.lerp(torso_up, 0.42).normalized();
        let mut hips_side = Vec3::new(pelvis_side.x, pelvis_side.y * 0.35, pelvis_side.z);
        hips_side = hips_side.project_onto_plane(hips_up);
        hips_side = if hips_side.len_sq() > 1e-6 {
            hips_side.normalized()
        } else {
            cfg.rest_hips_right
        };
        let hips_fwd = hips_side.cross(hips_up).normalized();

        // ---- 1. HIPS (Root Orientation + Root Translation) ----
        if rest[B_HIPS].present {
            let rest_basis = Quat::from_basis(
                cfg.rest_hips_right.normalized(),
                Vec3::Y,
                cfg.rest_hips_fwd.normalized(),
            );
            let target_basis = Quat::from_basis(hips_side, hips_up, hips_fwd);
            let delta_world = target_basis.mul(rest_basis.conj()).normalized();
            let target_world_q = delta_world.mul(cfg.rest_hips_world_quat).normalized();
            let target_local_q = cfg.hips_parent_world_quat.conj().mul(target_world_q).normalized();
            cur_quat[B_HIPS] = rest[B_HIPS]
                .local_quat
                .slerp(target_local_q, cfg.root_rotation_weight.clamp(0.0, 1.0));

            if cfg.root_motion && root_traj.len() >= (f + 1) * 3 {
                let rx_raw = if cfg.mirror_x { -root_traj[f * 3] } else { root_traj[f * 3] };
                let ry_raw = root_traj[f * 3 + 1] * y_flip;
                let rz_raw = root_traj[f * 3 + 2] * y_flip;
                let delta_w = rot_y_vec(
                    Vec3::new(
                        rx_raw * scale_factor * cfg.root_scale,
                        ry_raw * scale_factor * cfg.root_scale,
                        rz_raw * scale_factor * cfg.depth_scale,
                    ),
                    total_yaw,
                );
                let target_world_pos = cfg.rest_hips_world_pos.add(delta_w);
                cur_pos[B_HIPS] = mat4_transform_point(&cfg.hips_parent_world_inv_mat, target_world_pos);
            }
            sync_fk!();
        }

        // ---- 2. SPINE CHAIN ----
        let active_spine: Vec<usize> = [B_SPINE, B_SPINE1, B_SPINE2]
            .iter()
            .copied()
            .filter(|&b| rest[b].present)
            .collect();
        if !active_spine.is_empty() {
            let swing_remain = Quat::from_unit_vectors(hips_up, torso_up);
            let p_s = hips_side.project_onto_plane(torso_up).normalized();
            let c_s = chest_side.project_onto_plane(torso_up).normalized();
            let twist_ang = if p_s.len_sq() > 1e-6 && c_s.len_sq() > 1e-6 {
                p_s.cross(c_s).dot(torso_up).atan2(p_s.dot(c_s)).clamp(-0.65, 0.65)
            } else {
                0.0
            };
            let q_twist = Quat::from_axis_angle(torso_up, twist_ang);
            let q_step = Quat::IDENTITY.slerp(q_twist.mul(swing_remain), 1.0 / active_spine.len() as f32);
            for &sp in &active_spine {
                let parent_q = parent_world_quat(&rest, &world_quats, cfg.hips_parent_world_quat, sp);
                let next_w = q_step.mul(world_quats[sp]).normalized();
                cur_quat[sp] = parent_q.conj().mul(next_w).normalized();
                sync_fk!();
            }
        }

        // ---- 3. NECK & HEAD ----
        let (neck_j, neck_v) = joint_at(joints, f, stride_joints, J_NECK, y_flip, cfg.mirror_x, total_yaw);
        let (nose_j, nose_v) = joint_at(joints, f, stride_joints, J_NOSE, y_flip, cfg.mirror_x, total_yaw);
        if neck_v > 0.25 && nose_v > 0.25 && (rest[B_NECK].present || rest[B_HEAD].present) {
            let head_vec = nose_j.sub(neck_j).normalized();
            let neutral_dir = torso_up.mul(0.65).add(hips_fwd.mul(0.76)).normalized();
            if head_vec.len_sq() > 1e-6 && neutral_dir.len_sq() > 1e-6 {
                let q_delta = Quat::from_unit_vectors(neutral_dir, head_vec).clamp_angle(28.0f32.to_radians());
                let head_targets: Vec<usize> = [B_NECK, B_HEAD]
                    .iter()
                    .copied()
                    .filter(|&b| rest[b].present)
                    .collect();
                let step = Quat::IDENTITY.slerp(q_delta, 0.65 / head_targets.len() as f32);
                for &hb in &head_targets {
                    let pq = parent_world_quat(&rest, &world_quats, cfg.hips_parent_world_quat, hb);
                    cur_quat[hb] = pq.conj().mul(step.mul(world_quats[hb]).normalized()).normalized();
                    sync_fk!();
                }
            }
        }

        // ---- 4. CLAVICLES, ARMS, FOREARMS & HANDS (Pole-Vector Swing-Twist!) ----
        let (lelb_p, lelb_v) = joint_at(joints, f, stride_joints, J_L_ELBOW, y_flip, cfg.mirror_x, total_yaw);
        let (lwri_p, lwri_v) = joint_at(joints, f, stride_joints, J_L_WRIST, y_flip, cfg.mirror_x, total_yaw);
        let (lhan_p, lhan_v) = joint_at(joints, f, stride_joints, J_L_HAND, y_flip, cfg.mirror_x, total_yaw);

        let (relb_p, relb_v) = joint_at(joints, f, stride_joints, J_R_ELBOW, y_flip, cfg.mirror_x, total_yaw);
        let (rwri_p, rwri_v) = joint_at(joints, f, stride_joints, J_R_WRIST, y_flip, cfg.mirror_x, total_yaw);
        let (rhan_p, rhan_v) = joint_at(joints, f, stride_joints, J_R_HAND, y_flip, cfg.mirror_x, total_yaw);

        let arms = [
            (true, B_L_SHOULDER, B_L_ARM, B_L_FOREARM, B_L_HAND, ls_p, ls_v, lelb_p, lelb_v, lwri_p, lwri_v, lhan_p, lhan_v),
            (false, B_R_SHOULDER, B_R_ARM, B_R_FOREARM, B_R_HAND, rs_p, rs_v, relb_p, relb_v, rwri_p, rwri_v, rhan_p, rhan_v),
        ];

        for &(is_left, b_clav, b_up, b_low, b_hand, sh_p, sh_v, elb_p, elb_v, wri_p, wri_v, han_p, han_v) in &arms {
            if !rest[b_up].present {
                continue;
            }
            let raw_upper_v = elb_p.sub(sh_p);
            if raw_upper_v.len_sq() < 1e-6 && sh_v.min(elb_v) < 0.05 {
                continue;
            }
            let d_upper = constrain_arm(raw_upper_v, hips_side, hips_fwd, is_left);
            let raw_fore_v = wri_p.sub(elb_p);
            let has_fore = raw_fore_v.len_sq() > 1e-6;
            let d_fore = if has_fore {
                constrain_forearm(raw_fore_v, d_upper)
            } else {
                Vec3::ZERO
            };

            if rest[b_clav].present {
                cur_quat[b_clav] = solve_bone_step(
                    &rest, &rest_world_quats, &world_quats, cfg.hips_parent_world_quat,
                    b_clav, d_upper, rest[b_clav].rest_pole_world, 0.0, 0.18, 16.0f32.to_radians(),
                );
                sync_fk!();
            }

            // Posterior-inferior anatomical elbow pole agrees with Mixamo T-pose rest pole (-fwd)
            let arm_slot = if is_left { 0usize } else { 1usize };
            let fallback_arm_pole = hips_fwd.mul(-0.86).add(Vec3::Y.mul(-0.51)).normalized();
            let base_fallback = prev_arm_poles[arm_slot].unwrap_or(fallback_arm_pole);
            let mut pole_arm = if has_fore {
                compute_in_plane_pole(d_upper, d_fore, base_fallback, Some(hips_fwd.mul(-1.0)))
            } else {
                fallback_arm_pole
            };
            if let Some(prev_p) = prev_arm_poles[arm_slot] {
                let p_cur = pole_arm.project_onto_plane(d_upper);
                let p_prev = prev_p.project_onto_plane(d_upper);
                if p_cur.len_sq() > 1e-6 && p_prev.len_sq() > 1e-6 {
                    let u_cur = p_cur.normalized();
                    let u_prev = p_prev.normalized();
                    let cos_a = u_prev.dot(u_cur).clamp(-1.0, 1.0);
                    let ang = cos_a.acos();
                    if ang > max_arm_pole_step && ang > 1e-5 {
                        let t = if cos_a < -0.35 {
                            0.15
                        } else {
                            (max_arm_pole_step / ang).clamp(0.08, 1.0)
                        };
                        let blended = u_prev.lerp(u_cur, t);
                        pole_arm = if blended.len_sq() > 1e-6 {
                            blended.normalized()
                        } else {
                            u_prev
                        };
                    }
                }
            }
            prev_arm_poles[arm_slot] = Some(pole_arm);

            cur_quat[b_up] = solve_bone_step(
                &rest, &rest_world_quats, &world_quats, cfg.hips_parent_world_quat,
                b_up, d_upper, pole_arm, cfg.pole_weight, 1.0, PI,
            );
            sync_fk!();

            if rest[b_low].present && has_fore {
                cur_quat[b_low] = solve_bone_step(
                    &rest, &rest_world_quats, &world_quats, cfg.hips_parent_world_quat,
                    b_low, d_fore, rest[b_low].rest_pole_world, 0.0, 1.0, PI,
                );
                sync_fk!();
            }

            if rest[b_hand].present && han_v > 0.2 && wri_v > 0.2 {
                let h_dir = han_p.sub(wri_p).normalized();
                if h_dir.len_sq() > 1e-6 {
                    cur_quat[b_hand] = solve_bone_step(
                        &rest, &rest_world_quats, &world_quats, cfg.hips_parent_world_quat,
                        b_hand, h_dir, rest[b_hand].rest_pole_world, 0.0, 0.55, 28.0f32.to_radians(),
                    );
                    sync_fk!();
                }
            }
        }

        // ---- 5. LEGS & FEET (True In-Plane Pole-Vector Knee Tracking + Anatomical Hinge + Foot Lock Flatten) ----
        let (lkne_p, lkne_v) = joint_at(joints, f, stride_joints, J_L_KNEE, y_flip, cfg.mirror_x, total_yaw);
        let (lank_p, lank_v) = joint_at(joints, f, stride_joints, J_L_ANKLE, y_flip, cfg.mirror_x, total_yaw);
        let (lfot_p, lfot_v) = joint_at(joints, f, stride_joints, J_L_FOOT, y_flip, cfg.mirror_x, total_yaw);

        let (rkne_p, rkne_v) = joint_at(joints, f, stride_joints, J_R_KNEE, y_flip, cfg.mirror_x, total_yaw);
        let (rank_p, rank_v) = joint_at(joints, f, stride_joints, J_R_ANKLE, y_flip, cfg.mirror_x, total_yaw);
        let (rfot_p, rfot_v) = joint_at(joints, f, stride_joints, J_R_FOOT, y_flip, cfg.mirror_x, total_yaw);

        let left_locked = foot_flags.get(f * 2).copied().unwrap_or(0) > 0;
        let right_locked = foot_flags.get(f * 2 + 1).copied().unwrap_or(0) > 0;

        let legs = [
            (true, B_L_UPLEG, B_L_LEG, B_L_FOOT, lh_p, lh_v, lkne_p, lkne_v, lank_p, lank_v, lfot_p, lfot_v, left_locked),
            (false, B_R_UPLEG, B_R_LEG, B_R_FOOT, rh_p, rh_v, rkne_p, rkne_v, rank_p, rank_v, rfot_p, rfot_v, right_locked),
        ];

        for &(is_left, b_up, b_low, b_foot, hp, hv, kn, kv, an, av, ft, fv, locked) in &legs {
            if !rest[b_up].present {
                continue;
            }
            let raw_thigh_v = kn.sub(hp);
            if raw_thigh_v.len_sq() < 1e-6 && hv.min(kv) < 0.05 {
                continue;
            }
            let d_thigh = constrain_thigh(raw_thigh_v, hips_side, Vec3::Y, hips_fwd, is_left);
            let raw_shin_v = an.sub(kn);
            let has_shin = raw_shin_v.len_sq() > 1e-6;
            let d_shin = if has_shin {
                constrain_shin(raw_shin_v, d_thigh, hips_side, hips_fwd, is_left)
            } else {
                Vec3::ZERO
            };

            // Anterior anatomical knee pole (+hips_fwd with subtle lateral stance bias):
            // smooth continuous transition eliminates 180-deg twist flips when straightening leg!
            let fallback_leg_pole = hips_fwd
                .add(hips_side.mul(if is_left { 0.12 } else { -0.12 }))
                .normalized();
            let pole_leg = if has_shin {
                compute_in_plane_pole(d_thigh, d_shin, fallback_leg_pole, Some(hips_fwd))
            } else {
                fallback_leg_pole
            };

            cur_quat[b_up] = solve_bone_step(
                &rest, &rest_world_quats, &world_quats, cfg.hips_parent_world_quat,
                b_up, d_thigh, pole_leg, cfg.pole_weight, 1.0, PI,
            );
            sync_fk!();

            if rest[b_low].present && has_shin && (av > 0.05 || locked) {
                cur_quat[b_low] = solve_bone_step(
                    &rest, &rest_world_quats, &world_quats, cfg.hips_parent_world_quat,
                    b_low, d_shin, rest[b_low].rest_pole_world, 0.0, 1.0, PI,
                );
                sync_fk!();
            }

            if rest[b_foot].present {
                let natural_dir = hips_fwd.mul(0.85).add(Vec3::new(0.0, -0.5, 0.0)).normalized();
                let target_foot_dir = if locked {
                    natural_dir
                } else if fv > 0.25 && av > 0.25 {
                    let mut cap = ft.sub(an).normalized();
                    if cap.dot(hips_fwd) < -0.15 {
                        cap = cap.sub(hips_fwd.mul(cap.dot(hips_fwd) - 0.2)).normalized();
                    }
                    natural_dir.lerp(cap, 0.55).normalized()
                } else {
                    natural_dir
                };
                cur_quat[b_foot] = solve_bone_step(
                    &rest, &rest_world_quats, &world_quats, cfg.hips_parent_world_quat,
                    b_foot, target_foot_dir, rest[b_foot].rest_pole_world, 0.0, 1.0, 35.0f32.to_radians(),
                );
                sync_fk!();
            }
        }

        // ---- 5b. RIG-SPACE FK SELF-COLLISION & LEG-SEPARATION POLISH ----
        let closest_pt_seg = |p: Vec3, a: Vec3, b: Vec3| -> Vec3 {
            let ab = b.sub(a);
            let d2 = ab.len_sq();
            if d2 < 1e-8 {
                return a;
            }
            let t = (p.sub(a).dot(ab) / d2).clamp(0.0, 1.0);
            a.add(ab.mul(t))
        };

        // Keep left & right ankles/knees laterally separated on actual character bone positions
        if rest[B_L_UPLEG].present
            && rest[B_R_UPLEG].present
            && rest[B_L_LEG].present
            && rest[B_R_LEG].present
            && rest[B_L_FOOT].present
            && rest[B_R_FOOT].present
        {
            for _ in 0..4 {
                let d_foot = world_positions[B_L_FOOT].sub(world_positions[B_R_FOOT]).len();
                let d_knee = world_positions[B_L_LEG].sub(world_positions[B_R_LEG]).len();
                if d_foot >= 0.135 && d_knee >= 0.135 {
                    break;
                }
                let l_leg_v = world_positions[B_L_FOOT].sub(world_positions[B_L_UPLEG]);
                let mut axis_l = l_leg_v.cross(hips_side).normalized();
                if axis_l.len_sq() < 1e-6 {
                    axis_l = hips_fwd;
                }
                let r_leg_v = world_positions[B_R_FOOT].sub(world_positions[B_R_UPLEG]);
                let mut axis_r = r_leg_v.cross(hips_side.mul(-1.0)).normalized();
                if axis_r.len_sq() < 1e-6 {
                    axis_r = hips_fwd.mul(-1.0);
                }
                let wl = if left_locked && !right_locked {
                    0.5f32
                } else if !left_locked && right_locked {
                    1.35f32
                } else {
                    1.0f32
                };
                let wr = if right_locked && !left_locked {
                    0.5f32
                } else if !right_locked && left_locked {
                    1.35f32
                } else {
                    1.0f32
                };
                let pq_l = parent_world_quat(&rest, &world_quats, cfg.hips_parent_world_quat, B_L_UPLEG);
                let delta_l = Quat::from_axis_angle(axis_l, 0.055 * wl);
                cur_quat[B_L_UPLEG] = pq_l.conj().mul(delta_l.mul(world_quats[B_L_UPLEG]).normalized()).normalized();

                let pq_r = parent_world_quat(&rest, &world_quats, cfg.hips_parent_world_quat, B_R_UPLEG);
                let delta_r = Quat::from_axis_angle(axis_r, 0.055 * wr);
                cur_quat[B_R_UPLEG] = pq_r.conj().mul(delta_r.mul(world_quats[B_R_UPLEG]).normalized()).normalized();
                sync_fk!();
            }
        }

        // Guarantee actual rig hand/forearm bones stay cleanly outside torso & baggy thigh volumes
        for &(is_left, b_up, b_low, b_hand) in &[
            (true, B_L_ARM, B_L_FOREARM, B_L_HAND),
            (false, B_R_ARM, B_R_FOREARM, B_R_HAND),
        ] {
            if !rest[b_up].present || !rest[b_hand].present {
                continue;
            }
            let arm_side = if is_left { hips_side } else { hips_side.mul(-1.0) };
            for _ in 0..6 {
                let hand_p = world_positions[b_hand];
                let elb_p = if rest[b_low].present { world_positions[b_low] } else { hand_p };
                let mid_fore = elb_p.lerp(hand_p, 0.5);
                let tip_p = hand_p.add(hand_p.sub(elb_p).normalized().mul(0.055));
                let sh_p = world_positions[b_up];

                let mut worst_margin = 0.0f32;
                let mut worst_probe = hand_p;
                let mut worst_col = hand_p;

                let mut check_seg = |probe: Vec3, a: Vec3, b: Vec3, req: f32| {
                    let q = closest_pt_seg(probe, a, b);
                    let margin = probe.sub(q).len() - req;
                    if margin < worst_margin {
                        worst_margin = margin;
                        worst_probe = probe;
                        worst_col = q;
                    }
                };

                let req_torso = if cfg.torso_radius > 0.02 { cfg.torso_radius.clamp(0.115, 0.22) } else { 0.155 };
                let req_thigh = if cfg.thigh_radius > 0.02 { cfg.thigh_radius.clamp(0.085, 0.185) } else { 0.132 };
                if rest[B_HIPS].present && rest[B_NECK].present {
                    check_seg(hand_p, world_positions[B_HIPS], world_positions[B_NECK], req_torso);
                    check_seg(mid_fore, world_positions[B_HIPS], world_positions[B_NECK], (req_torso - 0.010).max(0.105));
                }
                if rest[B_L_UPLEG].present && rest[B_L_LEG].present {
                    check_seg(hand_p, world_positions[B_L_UPLEG], world_positions[B_L_LEG], req_thigh);
                    check_seg(tip_p, world_positions[B_L_UPLEG], world_positions[B_L_LEG], (req_thigh - 0.004).max(0.082));
                    check_seg(mid_fore, world_positions[B_L_UPLEG], world_positions[B_L_LEG], (req_thigh - 0.012).max(0.078));
                }
                if rest[B_R_UPLEG].present && rest[B_R_LEG].present {
                    check_seg(hand_p, world_positions[B_R_UPLEG], world_positions[B_R_LEG], req_thigh);
                    check_seg(tip_p, world_positions[B_R_UPLEG], world_positions[B_R_LEG], (req_thigh - 0.004).max(0.082));
                    check_seg(mid_fore, world_positions[B_R_UPLEG], world_positions[B_R_LEG], (req_thigh - 0.012).max(0.078));
                }

                if worst_margin >= 0.0 {
                    break;
                }
                let radial = worst_probe.sub(worst_col);
                let exit_dir = radial
                    .add(arm_side.mul(0.14))
                    .add(Vec3::Y.mul(0.09))
                    .add(hips_fwd.mul(0.04))
                    .normalized();
                let arm_vec = worst_probe.sub(sh_p);
                let mut rot_axis = arm_vec.cross(exit_dir).normalized();
                if rot_axis.len_sq() < 1e-6 {
                    rot_axis = hips_fwd;
                }
                let pq_u = parent_world_quat(&rest, &world_quats, cfg.hips_parent_world_quat, b_up);
                let delta_u = Quat::from_axis_angle(rot_axis, 0.065);
                cur_quat[b_up] = pq_u.conj().mul(delta_u.mul(world_quats[b_up]).normalized()).normalized();
                sync_fk!();
            }
        }

        // ---- 6. CLOSED-LOOP FULL-BODY TWO-FOOT IK + TOEBASE ARTICULATION ----
        let (l_heel_opt, r_heel_opt, l_toe_opt, r_toe_opt) = if stride_joints >= 25 {
            (
                Some(joint_at(joints, f, stride_joints, J_L_HEEL, y_flip, cfg.mirror_x, total_yaw)),
                Some(joint_at(joints, f, stride_joints, J_R_HEEL, y_flip, cfg.mirror_x, total_yaw)),
                Some(joint_at(joints, f, stride_joints, J_L_FOOT, y_flip, cfg.mirror_x, total_yaw)),
                Some(joint_at(joints, f, stride_joints, J_R_FOOT, y_flip, cfg.mirror_x, total_yaw)),
            )
        } else {
            (
                None,
                None,
                Some(joint_at(joints, f, stride_joints, J_L_FOOT, y_flip, cfg.mirror_x, total_yaw)),
                Some(joint_at(joints, f, stride_joints, J_R_FOOT, y_flip, cfg.mirror_x, total_yaw)),
            )
        };
        if !cfg.disable_grounding && (cfg.use_fullbody_ik || rest[B_L_TOE].present || rest[B_R_TOE].present) {
            crate::fullbody_ik::solve_fullbody_ground_and_toes(
                &rest,
                &rest_world_quats,
                &mut cur_pos,
                &mut cur_quat,
                &cfg.hips_parent_world_mat,
                &cfg.hips_parent_world_inv_mat,
                cfg.hips_parent_world_quat,
                cfg.rest_min_foot_y,
                cfg.root_motion,
                left_locked,
                right_locked,
                hips_fwd,
                hips_side,
                l_heel_opt,
                r_heel_opt,
                l_toe_opt,
                r_toe_opt,
                &mut smooth_floor_dy,
                &mut smooth_com_dxz,
                &mut planted_xz,
                &mut release_blend,
                f == 0,
                &mut world_mats,
                &mut world_quats,
                &mut world_positions,
            );
        } else if !cfg.disable_grounding && rest[B_HIPS].present {
            let mut min_fy = f32::INFINITY;
            if rest[B_L_FOOT].present {
                min_fy = min_fy.min(world_positions[B_L_FOOT].y);
            }
            if rest[B_R_FOOT].present {
                min_fy = min_fy.min(world_positions[B_R_FOOT].y);
            }
            if min_fy.is_finite() {
                let needed_dy = cfg.rest_min_foot_y - min_fy;
                let dy = if needed_dy > 0.001 || !cfg.root_motion {
                    needed_dy.clamp(-0.65, 0.85)
                } else {
                    let air_gap = (-needed_dy).max(0.0);
                    let w = if air_gap <= 0.075 {
                        1.0
                    } else {
                        let t = ((air_gap - 0.075) / 0.135).clamp(0.0, 1.0);
                        1.0 - t * t * (3.0 - 2.0 * t)
                    };
                    (needed_dy * w).clamp(-0.35, 0.0)
                };
                smooth_floor_dy = if f == 0 {
                    dy
                } else if dy > smooth_floor_dy {
                    (smooth_floor_dy * 0.25 + dy * 0.75).max(needed_dy.max(-1.0))
                } else {
                    smooth_floor_dy * 0.35 + dy * 0.65
                };
                if min_fy + smooth_floor_dy < cfg.rest_min_foot_y - 0.001 {
                    smooth_floor_dy = cfg.rest_min_foot_y - min_fy;
                }
                let hips_w = world_positions[B_HIPS];
                let grounded_w = Vec3::new(hips_w.x, hips_w.y + smooth_floor_dy, hips_w.z);
                cur_pos[B_HIPS] = crate::math::mat4_transform_point(&cfg.hips_parent_world_inv_mat, grounded_w);
            }
        }

        // ---- 6b. HAND / FOREARM FLOOR CONTACT CLAMP (prevents wrists/elbows piercing floor) ----
        if rest[B_HIPS].present {
            sync_fk!();
            let hand_floor_y = cfg.rest_min_foot_y + 0.025;
            for &(is_left, b_up, b_low, b_hand) in &[
                (true, B_L_ARM, B_L_FOREARM, B_L_HAND),
                (false, B_R_ARM, B_R_FOREARM, B_R_HAND),
            ] {
                if !rest[b_up].present || !rest[b_hand].present {
                    continue;
                }
                let arm_side = if is_left { hips_side } else { hips_side.mul(-1.0) };
                for _ in 0..6 {
                    let sh_p = world_positions[b_up];
                    let hand_p = world_positions[b_hand];
                    let elb_p = if rest[b_low].present { world_positions[b_low] } else { hand_p };
                    let tip_p = hand_p.add(hand_p.sub(elb_p).normalized().mul(0.055));
                    let mut lowest_p = tip_p;
                    let mut lowest_y = tip_p.y;
                    if hand_p.y < lowest_y {
                        lowest_y = hand_p.y;
                        lowest_p = hand_p;
                    }
                    if elb_p.y < lowest_y {
                        lowest_y = elb_p.y;
                        lowest_p = elb_p;
                    }
                    let pen = hand_floor_y - lowest_y;
                    if pen <= 0.002 {
                        break;
                    }
                    let arm_vec = lowest_p.sub(sh_p);
                    let len = arm_vec.len();
                    if len < 1e-4 {
                        break;
                    }
                    let lift_dir = Vec3::Y.add(arm_side.mul(0.18)).normalized();
                    let mut rot_axis = arm_vec.cross(lift_dir).normalized();
                    if rot_axis.len_sq() < 1e-6 {
                        rot_axis = hips_fwd;
                    }
                    let step_ang = (pen / len).clamp(0.03, 0.22);
                    let pq_u = parent_world_quat(&rest, &world_quats, cfg.hips_parent_world_quat, b_up);
                    let delta_u = Quat::from_axis_angle(rot_axis, step_ang);
                    cur_quat[b_up] = pq_u.conj().mul(delta_u.mul(world_quats[b_up]).normalized()).normalized();
                    sync_fk!();
                }
            }
        }

        out_hips_pos[f * 3] = cur_pos[B_HIPS].x;
        out_hips_pos[f * 3 + 1] = cur_pos[B_HIPS].y;
        out_hips_pos[f * 3 + 2] = cur_pos[B_HIPS].z;

        for b in 0..N_BONES {
            let qb = (f * N_BONES + b) * 4;
            let q = cur_quat[b].normalized();
            work_quats[qb] = q.x;
            work_quats[qb + 1] = q.y;
            work_quats[qb + 2] = q.z;
            work_quats[qb + 3] = q.w;
        }
    }

    // ---- 7. BLENDER F-CURVE CLEANUP: HEMISPHERE + SPIKE DESPIKE + DT-AWARE ZERO-PHASE SLERP ----
    let dt = 1.0 / cfg.fps.max(1.0);
    let s = cfg.smoothness.clamp(0.0, 0.99);
    let cutoff_hz = 22.0 - s * 17.5;
    let alpha = if s > 1e-4 {
        (1.0 - (-cutoff_hz * dt).exp()).clamp(0.05, 1.0)
    } else {
        1.0
    };

    // Scale spike guard threshold by frame duration so 15fps/60fps both guard ~26 deg @ 30fps
    let spike_thresh_rad = (26.0f32.to_radians() * (dt * 30.0).clamp(0.65, 1.8)).clamp(0.25, 1.15);

    let mut fwd_q = vec![Quat::IDENTITY; n_frames];
    let mut bwd_q = vec![Quat::IDENTITY; n_frames];

    for b in 0..N_BONES {
        if !rest[b].present {
            continue;
        }
        for f in 1..n_frames {
            let p_idx = ((f - 1) * N_BONES + b) * 4;
            let c_idx = (f * N_BONES + b) * 4;
            let dot = work_quats[p_idx] * work_quats[c_idx]
                + work_quats[p_idx + 1] * work_quats[c_idx + 1]
                + work_quats[p_idx + 2] * work_quats[c_idx + 2]
                + work_quats[p_idx + 3] * work_quats[c_idx + 3];
            if dot < 0.0 {
                work_quats[c_idx] = -work_quats[c_idx];
                work_quats[c_idx + 1] = -work_quats[c_idx + 1];
                work_quats[c_idx + 2] = -work_quats[c_idx + 2];
                work_quats[c_idx + 3] = -work_quats[c_idx + 3];
            }
        }

        // Single-frame rotational pop repair (eliminates sudden joint snaps between smooth frames)
        if n_frames >= 3 {
            for f in 1..(n_frames - 1) {
                let ip = ((f - 1) * N_BONES + b) * 4;
                let ic = (f * N_BONES + b) * 4;
                let inx = ((f + 1) * N_BONES + b) * 4;
                let qp = Quat::new(work_quats[ip], work_quats[ip + 1], work_quats[ip + 2], work_quats[ip + 3]);
                let qc = Quat::new(work_quats[ic], work_quats[ic + 1], work_quats[ic + 2], work_quats[ic + 3]);
                let qn = Quat::new(work_quats[inx], work_quats[inx + 1], work_quats[inx + 2], work_quats[inx + 3]);
                let dp = 2.0 * qp.dot(qc).abs().clamp(0.0, 1.0).acos();
                let dn = 2.0 * qc.dot(qn).abs().clamp(0.0, 1.0).acos();
                let d_span = 2.0 * qp.dot(qn).abs().clamp(0.0, 1.0).acos();
                if dp > spike_thresh_rad && dn > spike_thresh_rad && d_span < (dp + dn) * 0.65 {
                    let fixed = qp.slerp(qn, 0.5);
                    work_quats[ic] = fixed.x;
                    work_quats[ic + 1] = fixed.y;
                    work_quats[ic + 2] = fixed.z;
                    work_quats[ic + 3] = fixed.w;
                }
            }
            // Multi-frame (2..=3 frame) rotational pop repair (eliminates brief tracker inversions)
            if n_frames >= 5 {
                let multi_thresh = (spike_thresh_rad * 1.45).max(38.0f32.to_radians());
                for span in 2usize..=3usize {
                    if n_frames < span + 2 {
                        continue;
                    }
                    let mut f = 1usize;
                    while f + span < n_frames {
                        let i_bef = ((f - 1) * N_BONES + b) * 4;
                        let i_aft = ((f + span) * N_BONES + b) * 4;
                        let qb = Quat::new(work_quats[i_bef], work_quats[i_bef + 1], work_quats[i_bef + 2], work_quats[i_bef + 3]);
                        let qa = Quat::new(work_quats[i_aft], work_quats[i_aft + 1], work_quats[i_aft + 2], work_quats[i_aft + 3]);
                        let d_anchor = 2.0 * qb.dot(qa).abs().clamp(0.0, 1.0).acos();
                        if d_anchor < multi_thresh * 1.15 {
                            let i_first = (f * N_BONES + b) * 4;
                            let i_last = ((f + span - 1) * N_BONES + b) * 4;
                            let q_first = Quat::new(work_quats[i_first], work_quats[i_first + 1], work_quats[i_first + 2], work_quats[i_first + 3]);
                            let q_last = Quat::new(work_quats[i_last], work_quats[i_last + 1], work_quats[i_last + 2], work_quats[i_last + 3]);
                            let d_enter = 2.0 * qb.dot(q_first).abs().clamp(0.0, 1.0).acos();
                            let d_exit = 2.0 * q_last.dot(qa).abs().clamp(0.0, 1.0).acos();
                            if d_enter > multi_thresh && d_exit > multi_thresh && d_anchor < (d_enter + d_exit) * 0.55 {
                                for k in 0..span {
                                    let t = (k + 1) as f32 / (span + 1) as f32;
                                    let fixed = qb.slerp(qa, t).normalized();
                                    let ik = ((f + k) * N_BONES + b) * 4;
                                    work_quats[ik] = fixed.x;
                                    work_quats[ik + 1] = fixed.y;
                                    work_quats[ik + 2] = fixed.z;
                                    work_quats[ik + 3] = fixed.w;
                                }
                                f += span + 1;
                                continue;
                            }
                        }
                        f += 1;
                    }
                }
            }
            // Boundary frame snap suppression (eliminates f == 0 and f == n_frames - 1 pops)
            if n_frames >= 4 {
                let b_snap_rad = (20.0f32).to_radians();
                let i0 = b * 4;
                let i1 = (N_BONES + b) * 4;
                let i2 = (2 * N_BONES + b) * 4;
                let q0 = Quat::new(work_quats[i0], work_quats[i0 + 1], work_quats[i0 + 2], work_quats[i0 + 3]);
                let q1 = Quat::new(work_quats[i1], work_quats[i1 + 1], work_quats[i1 + 2], work_quats[i1 + 3]);
                let q2 = Quat::new(work_quats[i2], work_quats[i2 + 1], work_quats[i2 + 2], work_quats[i2 + 3]);
                let d01 = 2.0 * q0.dot(q1).abs().clamp(0.0, 1.0).acos();
                let d12 = 2.0 * q1.dot(q2).abs().clamp(0.0, 1.0).acos();
                if d01 > b_snap_rad && d01 > d12 * 2.0 + (6.0f32).to_radians() {
                    let max_step = (d12 * 1.35).clamp((5.0f32).to_radians(), (14.0f32).to_radians());
                    let fixed0 = q1.slerp(q0, (max_step / d01).clamp(0.0, 0.5)).normalized();
                    work_quats[i0] = fixed0.x;
                    work_quats[i0 + 1] = fixed0.y;
                    work_quats[i0 + 2] = fixed0.z;
                    work_quats[i0 + 3] = fixed0.w;
                }

                let lf = n_frames - 1;
                let in0 = (lf * N_BONES + b) * 4;
                let in1 = ((lf - 1) * N_BONES + b) * 4;
                let in2 = ((lf - 2) * N_BONES + b) * 4;
                let qn = Quat::new(work_quats[in0], work_quats[in0 + 1], work_quats[in0 + 2], work_quats[in0 + 3]);
                let qn1 = Quat::new(work_quats[in1], work_quats[in1 + 1], work_quats[in1 + 2], work_quats[in1 + 3]);
                let qn2 = Quat::new(work_quats[in2], work_quats[in2 + 1], work_quats[in2 + 2], work_quats[in2 + 3]);
                let dn = 2.0 * qn.dot(qn1).abs().clamp(0.0, 1.0).acos();
                let dn12 = 2.0 * qn1.dot(qn2).abs().clamp(0.0, 1.0).acos();
                if dn > b_snap_rad && dn > dn12 * 2.0 + (6.0f32).to_radians() {
                    let max_step = (dn12 * 1.35).clamp((5.0f32).to_radians(), (14.0f32).to_radians());
                    let fixed_n = qn1.slerp(qn, (max_step / dn).clamp(0.0, 0.5)).normalized();
                    work_quats[in0] = fixed_n.x;
                    work_quats[in0 + 1] = fixed_n.y;
                    work_quats[in0 + 2] = fixed_n.z;
                    work_quats[in0 + 3] = fixed_n.w;
                }
            }
        }

        if s <= 1e-4 || n_frames < 3 {
            continue;
        }
        let passes = if s >= 0.45 { 2 } else { 1 };
        for _ in 0..passes {
            for f in 0..n_frames {
                let i = (f * N_BONES + b) * 4;
                let q = Quat::new(work_quats[i], work_quats[i + 1], work_quats[i + 2], work_quats[i + 3]);
                fwd_q[f] = if f == 0 { q } else { fwd_q[f - 1].slerp(q, alpha) };
            }
            for f in (0..n_frames).rev() {
                let i = (f * N_BONES + b) * 4;
                let q = Quat::new(work_quats[i], work_quats[i + 1], work_quats[i + 2], work_quats[i + 3]);
                bwd_q[f] = if f == n_frames - 1 { q } else { bwd_q[f + 1].slerp(q, alpha) };
            }
            for f in 0..n_frames {
                let avg = fwd_q[f].slerp(bwd_q[f], 0.5).normalized();
                let i = (f * N_BONES + b) * 4;
                work_quats[i] = avg.x;
                work_quats[i + 1] = avg.y;
                work_quats[i + 2] = avg.z;
                work_quats[i + 3] = avg.w;
            }
        }

        if matches!(b, B_L_TOE | B_R_TOE) && n_frames >= 2 {
            let max_step = (10.0f32.to_radians() * (dt * 30.0).clamp(0.65, 1.8)).clamp(0.08, 0.35);
            for f in 1..n_frames {
                let ip = ((f - 1) * N_BONES + b) * 4;
                let ic = (f * N_BONES + b) * 4;
                let qp = Quat::new(work_quats[ip], work_quats[ip + 1], work_quats[ip + 2], work_quats[ip + 3]);
                let mut qc = Quat::new(work_quats[ic], work_quats[ic + 1], work_quats[ic + 2], work_quats[ic + 3]);
                if qp.dot(qc) < 0.0 {
                    qc = Quat::new(-qc.x, -qc.y, -qc.z, -qc.w);
                }
                let ang = 2.0 * qp.dot(qc).clamp(-1.0, 1.0).acos();
                if ang > max_step && ang > 1e-5 {
                    let clamped = qp.slerp(qc, max_step / ang).normalized();
                    work_quats[ic] = clamped.x;
                    work_quats[ic + 1] = clamped.y;
                    work_quats[ic + 2] = clamped.z;
                    work_quats[ic + 3] = clamped.w;
                }
            }
        }
    }

    for f in 0..n_frames {
        let src = (f * N_BONES) * 4;
        let dst = (f * n_out) * 4;
        let count = n_out * 4;
        out_quats[dst..dst + count].copy_from_slice(&work_quats[src..src + count]);
    }

    // Savitzky-Golay 5-point root position glide polish when smoothness is active
    if s > 0.10 && n_frames >= 5 {
        let mix_w = ((s - 0.10) / 0.90).clamp(0.0, 0.85);
        let raw_hips = out_hips_pos[..n_frames * 3].to_vec();
        for f in 2..(n_frames - 2) {
            for c in 0..3 {
                let sg = (-3.0 * raw_hips[(f - 2) * 3 + c]
                    + 12.0 * raw_hips[(f - 1) * 3 + c]
                    + 17.0 * raw_hips[f * 3 + c]
                    + 12.0 * raw_hips[(f + 1) * 3 + c]
                    - 3.0 * raw_hips[(f + 2) * 3 + c])
                    / 35.0;
                out_hips_pos[f * 3 + c] = raw_hips[f * 3 + c] + (sg - raw_hips[f * 3 + c]) * mix_w;
            }
        }
    }

    // ---- 8. POST-SMOOTH RESIDUAL FLOOR CLOSURE ----
    // Stage 7 rotational & root smoothing can introduce 3-15 mm floor float or sink.
    // Re-evaluate final smoothed FK pose and apply a smooth vertical Hips residual closure
    // (100% lift on floor penetration, smooth closure on stance/micro-float) so final keyframes
    // stick solidly to the floor without re-introducing rotation jitter or twisting knees/hips.
    if !cfg.disable_grounding && rest[B_HIPS].present && (rest[B_L_FOOT].present || rest[B_R_FOOT].present) {
        let mut raw_dy = vec![0.0f32; n_frames];
        let mut min_fy_vec = vec![cfg.rest_min_foot_y; n_frames];
        let mut pose_pos = rest_pos;
        let mut pose_quat = rest_quat;
        for f in 0..n_frames {
            pose_pos[B_HIPS] = Vec3::new(out_hips_pos[f * 3], out_hips_pos[f * 3 + 1], out_hips_pos[f * 3 + 2]);
            for b in 0..N_BONES {
                let qb = (f * N_BONES + b) * 4;
                pose_quat[b] = Quat::new(
                    work_quats[qb],
                    work_quats[qb + 1],
                    work_quats[qb + 2],
                    work_quats[qb + 3],
                )
                .normalized();
            }
            fk_update(
                &rest,
                &pose_pos,
                &pose_quat,
                &cfg.hips_parent_world_mat,
                cfg.hips_parent_world_quat,
                &mut world_mats,
                &mut world_quats,
                &mut world_positions,
            );
            let l_fy = crate::fullbody_ik::foot_lowest_y(&rest, &world_positions, B_L_FOOT, B_L_TOE);
            let r_fy = crate::fullbody_ik::foot_lowest_y(&rest, &world_positions, B_R_FOOT, B_R_TOE);
            let min_all = match (l_fy, r_fy) {
                (Some(a), Some(b)) => a.min(b),
                (Some(a), None) => a,
                (None, Some(b)) => b,
                (None, None) => cfg.rest_min_foot_y,
            };
            min_fy_vec[f] = min_all;
            let left_locked = foot_flags.get(f * 2).copied().unwrap_or(0) > 0;
            let right_locked = foot_flags.get(f * 2 + 1).copied().unwrap_or(0) > 0;
            let stance_y = match (left_locked, right_locked, l_fy, r_fy) {
                (true, false, Some(a), _) => a,
                (false, true, _, Some(b)) => b,
                _ => min_all,
            };
            let hard_min_f = cfg.rest_min_foot_y - min_all;
            if hard_min_f > 0.0005 {
                raw_dy[f] = hard_min_f.clamp(0.0, 0.25);
            } else if left_locked || right_locked || !cfg.root_motion {
                // Clamp downward closure to hard_min_f so settling the stance foot never drives the opposite foot underground.
                let drop = (cfg.rest_min_foot_y - stance_y).max(hard_min_f);
                if drop < -0.0005 && drop > -0.08 {
                    raw_dy[f] = drop;
                }
            }
        }
        let mut sm_dy = raw_dy.clone();
        if n_frames >= 3 {
            for f in 1..(n_frames - 1) {
                sm_dy[f] = 0.25 * raw_dy[f - 1] + 0.50 * raw_dy[f] + 0.25 * raw_dy[f + 1];
            }
        }
        for f in 0..n_frames {
            let hard_min = cfg.rest_min_foot_y - min_fy_vec[f];
            let dy = sm_dy[f].max(hard_min);
            if dy.abs() > 1e-5 {
                let hw = crate::math::mat4_transform_point(
                    &cfg.hips_parent_world_mat,
                    Vec3::new(out_hips_pos[f * 3], out_hips_pos[f * 3 + 1], out_hips_pos[f * 3 + 2]),
                );
                let fixed_local = crate::math::mat4_transform_point(
                    &cfg.hips_parent_world_inv_mat,
                    Vec3::new(hw.x, hw.y + dy, hw.z),
                );
                out_hips_pos[f * 3] = fixed_local.x;
                out_hips_pos[f * 3 + 1] = fixed_local.y;
                out_hips_pos[f * 3 + 2] = fixed_local.z;
            }
        }
    }
}
