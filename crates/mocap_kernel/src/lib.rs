//! Web Blender Studio — Pure-Rust WASM Mocap Kernel
//! Fast, deterministic joint post-processing + Foot-Lock IK + 20-bone Pole-Vector Humanoid Retargeting.

pub mod filters;
pub mod fullbody_ik;
pub mod kinematic_opt;
pub mod math;
pub mod retarget;
pub mod temporal;

use math::{Quat, Vec3};
use retarget::{N_BONES, N_CORE_BONES, RetargetConfig};
use std::alloc::{alloc, dealloc, Layout};

#[no_mangle]
pub extern "C" fn mk_alloc(byte_len: usize) -> *mut u8 {
    let size = byte_len.max(16);
    let layout = Layout::from_size_align(size, 16).unwrap();
    unsafe { alloc(layout) }
}

#[no_mangle]
pub extern "C" fn mk_free(ptr: *mut u8, byte_len: usize) {
    if ptr.is_null() {
        return;
    }
    let size = byte_len.max(16);
    let layout = Layout::from_size_align(size, 16).unwrap();
    unsafe { dealloc(ptr, layout) }
}

#[allow(clippy::too_many_arguments)]
fn process_joints_core(
    joints: &mut [f32],
    hip2d: &[f32],
    lm2d: &[f32],
    cam_motion: &[f32],
    chains_vec: &[(usize, usize)],
    out_root: &mut [f32],
    out_flags: Option<&mut [u8]>,
    n_frames: usize,
    n_joints: usize,
    fps: f32,
    min_cutoff: f32,
    beta: f32,
    d_cutoff: f32,
    min_vis: f32,
    max_gap: usize,
    zero_phase: u32,
    do_foot_lock: u32,
    vel_thresh: f32,
    floor_tol: f32,
    blend_frames: usize,
    hips_idx: usize,
    spine_idx: usize,
    neck_idx: i32,
    nose_idx: i32,
    l_sh: i32,
    r_sh: i32,
    l_elb: i32,
    r_elb: i32,
    l_wri: i32,
    r_wri: i32,
    l_han: i32,
    r_han: i32,
    l_hip: usize,
    l_knee: usize,
    l_ankle: usize,
    l_foot: i32,
    r_hip: usize,
    r_knee: usize,
    r_ankle: usize,
    r_foot: i32,
    occlusion_strength: f32,
    sg_passes: usize,
    temporal_lifting: bool,
    aspect_ratio: f32,
) -> i32 {
    let mut swap_pairs: Vec<(usize, usize)> = Vec::with_capacity(4);
    if l_knee < n_joints && r_knee < n_joints {
        swap_pairs.push((l_knee, r_knee));
    }
    if l_ankle < n_joints && r_ankle < n_joints {
        swap_pairs.push((l_ankle, r_ankle));
    }
    if l_elb >= 0 && r_elb >= 0 && (l_elb as usize) < n_joints && (r_elb as usize) < n_joints {
        swap_pairs.push((l_elb as usize, r_elb as usize));
    }
    if l_wri >= 0 && r_wri >= 0 && (l_wri as usize) < n_joints && (r_wri as usize) < n_joints {
        swap_pairs.push((l_wri as usize, r_wri as usize));
    }
    if !swap_pairs.is_empty() {
        filters::repair_lr_swaps(joints, n_frames, n_joints, &swap_pairs);
    }

    filters::gap_fill_joints(joints, n_frames, n_joints, min_vis, max_gap);
    filters::despike_outliers(joints, n_frames, n_joints, min_vis);

    if temporal_lifting && l_sh >= 0 && r_sh >= 0 {
        let mut all_limbs = Vec::with_capacity(16);
        for idx in [l_elb, r_elb, l_wri, r_wri, l_han, r_han, nose_idx, neck_idx, l_foot, r_foot] {
            if idx >= 0 && (idx as usize) < n_joints {
                all_limbs.push(idx as usize);
            }
        }
        for idx in [l_knee, r_knee, l_ankle, r_ankle] {
            if idx < n_joints {
                all_limbs.push(idx);
            }
        }
        temporal::enforce_temporal_torso_continuity(
            joints,
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

    if !lm2d.is_empty()
        && l_sh >= 0
        && r_sh >= 0
        && (l_sh as usize) < n_joints
        && (r_sh as usize) < n_joints
        && l_hip < n_joints
        && r_hip < n_joints
    {
        let mut bilat_chains = vec![
            (l_hip, l_knee, r_hip, r_knee),
            (l_knee, l_ankle, r_knee, r_ankle),
        ];
        if l_elb >= 0 && r_elb >= 0 && (l_elb as usize) < n_joints && (r_elb as usize) < n_joints {
            bilat_chains.push((l_sh as usize, l_elb as usize, r_sh as usize, r_elb as usize));
            if l_wri >= 0 && r_wri >= 0 && (l_wri as usize) < n_joints && (r_wri as usize) < n_joints {
                bilat_chains.push((l_elb as usize, l_wri as usize, r_elb as usize, r_wri as usize));
            }
        }
        filters::fuse_2d_to_3d_kinematic_aspect(
            joints,
            lm2d,
            n_frames,
            n_joints,
            l_hip,
            r_hip,
            l_sh as usize,
            r_sh as usize,
            min_vis,
            aspect_ratio,
        );
        kinematic_opt::optimize_perspective_2d_3d(
            joints,
            lm2d,
            chains_vec,
            &bilat_chains,
            n_frames,
            n_joints,
            hips_idx,
            l_hip,
            r_hip,
            l_sh as usize,
            r_sh as usize,
            l_knee,
            r_knee,
            min_vis,
            aspect_ratio,
        );
    }

    if temporal_lifting && l_sh >= 0 && r_sh >= 0 {
        temporal::run_temporal_lifting_opts(
            joints,
            lm2d,
            n_frames,
            n_joints,
            fps,
            hips_idx,
            l_sh,
            r_sh,
            l_elb,
            r_elb,
            l_wri,
            r_wri,
            l_hip,
            r_hip,
            l_knee,
            r_knee,
            l_ankle,
            r_ankle,
            nose_idx,
            min_vis,
            false,
        );
    }

    filters::filter_joints_one_euro(
        joints,
        n_frames,
        n_joints,
        fps,
        min_cutoff,
        beta,
        d_cutoff,
        zero_phase != 0,
    );
    filters::stabilize_all_depths(joints, n_frames, n_joints, 2, min_vis);

    if occlusion_strength > 1e-4
        && l_sh >= 0
        && r_sh >= 0
        && l_elb >= 0
        && r_elb >= 0
        && l_wri >= 0
        && r_wri >= 0
    {
        filters::resolve_occlusions_and_self_collision(
            joints,
            n_frames,
            n_joints,
            hips_idx,
            spine_idx,
            if neck_idx >= 0 { neck_idx as usize } else { n_joints },
            l_sh as usize,
            r_sh as usize,
            l_elb as usize,
            r_elb as usize,
            l_wri as usize,
            r_wri as usize,
            if l_han >= 0 { l_han as usize } else { n_joints },
            if r_han >= 0 { r_han as usize } else { n_joints },
            l_hip,
            r_hip,
            l_knee,
            r_knee,
            min_vis,
            occlusion_strength,
        );
    }

    if sg_passes > 0 {
        filters::savitzky_golay_smooth_joints(joints, n_frames, n_joints, min_vis, sg_passes);
    }

    let has_chains = !chains_vec.is_empty();
    filters::enforce_bone_lengths(joints, n_frames, n_joints, chains_vec, min_vis);
    if has_chains {
        let mut pairs = vec![(
            l_hip,
            l_knee,
            l_ankle,
            if l_foot >= 0 { Some(l_foot as usize) } else { None },
            r_hip,
            r_knee,
            r_ankle,
            if r_foot >= 0 { Some(r_foot as usize) } else { None },
        )];
        if l_sh >= 0 && r_sh >= 0 && l_elb >= 0 && r_elb >= 0 && l_wri >= 0 && r_wri >= 0 {
            pairs.push((
                l_sh as usize,
                l_elb as usize,
                l_wri as usize,
                if l_han >= 0 { Some(l_han as usize) } else { None },
                r_sh as usize,
                r_elb as usize,
                r_wri as usize,
                if r_han >= 0 { Some(r_han as usize) } else { None },
            ));
        }
        filters::normalize_bilateral_limb_lengths(joints, n_frames, n_joints, &pairs, min_vis);
    }
    if occlusion_strength > 1e-4
        && l_sh >= 0
        && r_sh >= 0
        && l_elb >= 0
        && r_elb >= 0
        && l_wri >= 0
        && r_wri >= 0
    {
        filters::enforce_leg_separation_and_occlusion(
            joints,
            n_frames,
            n_joints,
            hips_idx,
            if neck_idx >= 0 { neck_idx as usize } else { n_joints },
            l_sh as usize,
            r_sh as usize,
            l_elb as usize,
            r_elb as usize,
            l_wri as usize,
            r_wri as usize,
            if l_han >= 0 { l_han as usize } else { n_joints },
            if r_han >= 0 { r_han as usize } else { n_joints },
            l_hip,
            r_hip,
            l_knee,
            r_knee,
            l_ankle,
            r_ankle,
            if l_foot >= 0 { Some(l_foot as usize) } else { None },
            if r_foot >= 0 { Some(r_foot as usize) } else { None },
            min_vis,
            occlusion_strength,
        );
    }
    filters::compute_root_trajectory_compensated_aspect(
        joints,
        hip2d,
        cam_motion,
        n_frames,
        n_joints,
        hips_idx,
        spine_idx,
        1.05,
        0.9,
        aspect_ratio,
        out_root,
    );

    if do_foot_lock != 0 {
        let locked = filters::apply_foot_lock(
            joints,
            out_root,
            n_frames,
            n_joints,
            fps,
            l_hip,
            l_knee,
            l_ankle,
            if l_foot >= 0 { Some(l_foot as usize) } else { None },
            r_hip,
            r_knee,
            r_ankle,
            if r_foot >= 0 { Some(r_foot as usize) } else { None },
            vel_thresh,
            floor_tol,
            blend_frames,
            out_flags,
        );
        return locked as i32;
    }

    if let Some(flags) = out_flags {
        flags.fill(0);
    }
    0
}

fn decode_chains(chains_ptr: *const i32, n_chains: usize) -> Vec<(usize, usize)> {
    if chains_ptr.is_null() || n_chains == 0 {
        Vec::new()
    } else {
        let raw = unsafe { std::slice::from_raw_parts(chains_ptr, n_chains * 2) };
        (0..n_chains)
            .filter_map(|i| {
                let a = raw[i * 2];
                let b = raw[i * 2 + 1];
                if a >= 0 && b >= 0 {
                    Some((a as usize, b as usize))
                } else {
                    None
                }
            })
            .collect()
    }
}

/// Complete Rust post-processing on `[n_frames * n_joints * 4]` (`x, y, z, vis`) + `[n_frames * 4]` `hip2d`,
/// writing root trajectory `[n_frames * 3]` and optional `[n_frames * 2]` foot-lock flags.
/// Returns `total_locked` (>= 0) on success, or negative error code.
#[no_mangle]
pub extern "C" fn mk_process_joints(
    joints_ptr: *mut f32,
    hip2d_ptr: *const f32,
    chains_ptr: *const i32,
    out_root_ptr: *mut f32,
    out_flags_ptr: *mut u8,
    n_frames: usize,
    n_joints: usize,
    n_chains: usize,
    fps: f32,
    min_cutoff: f32,
    beta: f32,
    d_cutoff: f32,
    min_vis: f32,
    max_gap: usize,
    zero_phase: u32,
    do_foot_lock: u32,
    vel_thresh: f32,
    floor_tol: f32,
    blend_frames: usize,
    hips_idx: usize,
    spine_idx: usize,
    l_hip: usize,
    l_knee: usize,
    l_ankle: usize,
    l_foot: i32,
    r_hip: usize,
    r_knee: usize,
    r_ankle: usize,
    r_foot: i32,
) -> i32 {
    if joints_ptr.is_null() || out_root_ptr.is_null() || n_frames == 0 || n_joints == 0 {
        return -1;
    }
    let joints = unsafe { std::slice::from_raw_parts_mut(joints_ptr, n_frames * n_joints * 4) };
    let out_root = unsafe { std::slice::from_raw_parts_mut(out_root_ptr, n_frames * 3) };
    let hip2d: &[f32] = if hip2d_ptr.is_null() {
        &[]
    } else {
        unsafe { std::slice::from_raw_parts(hip2d_ptr, n_frames * 4) }
    };
    let mut flags_opt = if out_flags_ptr.is_null() {
        None
    } else {
        Some(unsafe { std::slice::from_raw_parts_mut(out_flags_ptr, n_frames * 2) })
    };
    let chains_vec = decode_chains(chains_ptr, n_chains);

    process_joints_core(
        joints,
        hip2d,
        &[],
        &[],
        &chains_vec,
        out_root,
        flags_opt.as_deref_mut(),
        n_frames,
        n_joints,
        fps,
        min_cutoff,
        beta,
        d_cutoff,
        min_vis,
        max_gap,
        zero_phase,
        do_foot_lock,
        vel_thresh,
        floor_tol,
        blend_frames,
        hips_idx,
        spine_idx,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        l_hip,
        l_knee,
        l_ankle,
        l_foot,
        r_hip,
        r_knee,
        r_ankle,
        r_foot,
        0.0,
        1,
        false,
        1.0,
    )
}

/// Extended Rust post-processing v2 with 2D-to-3D kinematic fusion, Blender-style occlusion recovery,
/// temporal 3D lifting, anti-self-collision torso clearance, and Savitzky-Golay polynomial polish.
#[no_mangle]
pub extern "C" fn mk_process_joints_v2(
    joints_ptr: *mut f32,
    hip2d_ptr: *const f32,
    lm2d_ptr: *const f32,
    chains_ptr: *const i32,
    out_root_ptr: *mut f32,
    out_flags_ptr: *mut u8,
    n_frames: usize,
    n_joints: usize,
    n_chains: usize,
    fps: f32,
    min_cutoff: f32,
    beta: f32,
    d_cutoff: f32,
    min_vis: f32,
    max_gap: usize,
    zero_phase: u32,
    do_foot_lock: u32,
    vel_thresh: f32,
    floor_tol: f32,
    blend_frames: usize,
    occlusion_strength: f32,
    sg_passes: usize,
    hips_idx: usize,
    spine_idx: usize,
    neck_idx: i32,
    l_sh: i32,
    r_sh: i32,
    l_elb: i32,
    r_elb: i32,
    l_wri: i32,
    r_wri: i32,
    l_han: i32,
    r_han: i32,
    l_hip: usize,
    l_knee: usize,
    l_ankle: usize,
    l_foot: i32,
    r_hip: usize,
    r_knee: usize,
    r_ankle: usize,
    r_foot: i32,
) -> i32 {
    mk_process_joints_v3(
        joints_ptr,
        hip2d_ptr,
        lm2d_ptr,
        std::ptr::null(),
        chains_ptr,
        out_root_ptr,
        out_flags_ptr,
        n_frames,
        n_joints,
        n_chains,
        fps,
        min_cutoff,
        beta,
        d_cutoff,
        min_vis,
        max_gap,
        zero_phase,
        do_foot_lock,
        vel_thresh,
        floor_tol,
        blend_frames,
        occlusion_strength,
        sg_passes,
        1,
        hips_idx,
        spine_idx,
        neck_idx,
        -1,
        l_sh,
        r_sh,
        l_elb,
        r_elb,
        l_wri,
        r_wri,
        l_han,
        r_han,
        l_hip,
        l_knee,
        l_ankle,
        l_foot,
        r_hip,
        r_knee,
        r_ankle,
        r_foot,
    )
}

/// Extended Rust post-processing v3: adds background camera pan/tilt/zoom compensation (`cam_motion_ptr`: `n_frames * 4`)
/// and full temporal 3D lifting (`temporal_lifting`). Delegates to `mk_process_joints_v4` with unit `aspect_ratio = 1.0`.
#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub extern "C" fn mk_process_joints_v3(
    joints_ptr: *mut f32,
    hip2d_ptr: *const f32,
    lm2d_ptr: *const f32,
    cam_motion_ptr: *const f32,
    chains_ptr: *const i32,
    out_root_ptr: *mut f32,
    out_flags_ptr: *mut u8,
    n_frames: usize,
    n_joints: usize,
    n_chains: usize,
    fps: f32,
    min_cutoff: f32,
    beta: f32,
    d_cutoff: f32,
    min_vis: f32,
    max_gap: usize,
    zero_phase: u32,
    do_foot_lock: u32,
    vel_thresh: f32,
    floor_tol: f32,
    blend_frames: usize,
    occlusion_strength: f32,
    sg_passes: usize,
    temporal_lifting: u32,
    hips_idx: usize,
    spine_idx: usize,
    neck_idx: i32,
    nose_idx: i32,
    l_sh: i32,
    r_sh: i32,
    l_elb: i32,
    r_elb: i32,
    l_wri: i32,
    r_wri: i32,
    l_han: i32,
    r_han: i32,
    l_hip: usize,
    l_knee: usize,
    l_ankle: usize,
    l_foot: i32,
    r_hip: usize,
    r_knee: usize,
    r_ankle: usize,
    r_foot: i32,
) -> i32 {
    mk_process_joints_v4(
        joints_ptr,
        hip2d_ptr,
        lm2d_ptr,
        cam_motion_ptr,
        chains_ptr,
        out_root_ptr,
        out_flags_ptr,
        n_frames,
        n_joints,
        n_chains,
        fps,
        min_cutoff,
        beta,
        d_cutoff,
        min_vis,
        max_gap,
        zero_phase,
        do_foot_lock,
        vel_thresh,
        floor_tol,
        blend_frames,
        occlusion_strength,
        sg_passes,
        temporal_lifting,
        1.0,
        hips_idx,
        spine_idx,
        neck_idx,
        nose_idx,
        l_sh,
        r_sh,
        l_elb,
        r_elb,
        l_wri,
        r_wri,
        l_han,
        r_han,
        l_hip,
        l_knee,
        l_ankle,
        l_foot,
        r_hip,
        r_knee,
        r_ankle,
        r_foot,
    )
}

/// Extended Rust post-processing v4: adds explicit `aspect_ratio` (`video_width / video_height`) so normalized
/// 2D landmarks map isotropically to metric 3D across 16:9 landscape, 4:3, and 9:16 portrait mobile videos.
#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub extern "C" fn mk_process_joints_v4(
    joints_ptr: *mut f32,
    hip2d_ptr: *const f32,
    lm2d_ptr: *const f32,
    cam_motion_ptr: *const f32,
    chains_ptr: *const i32,
    out_root_ptr: *mut f32,
    out_flags_ptr: *mut u8,
    n_frames: usize,
    n_joints: usize,
    n_chains: usize,
    fps: f32,
    min_cutoff: f32,
    beta: f32,
    d_cutoff: f32,
    min_vis: f32,
    max_gap: usize,
    zero_phase: u32,
    do_foot_lock: u32,
    vel_thresh: f32,
    floor_tol: f32,
    blend_frames: usize,
    occlusion_strength: f32,
    sg_passes: usize,
    temporal_lifting: u32,
    aspect_ratio: f32,
    hips_idx: usize,
    spine_idx: usize,
    neck_idx: i32,
    nose_idx: i32,
    l_sh: i32,
    r_sh: i32,
    l_elb: i32,
    r_elb: i32,
    l_wri: i32,
    r_wri: i32,
    l_han: i32,
    r_han: i32,
    l_hip: usize,
    l_knee: usize,
    l_ankle: usize,
    l_foot: i32,
    r_hip: usize,
    r_knee: usize,
    r_ankle: usize,
    r_foot: i32,
) -> i32 {
    if joints_ptr.is_null() || out_root_ptr.is_null() || n_frames == 0 || n_joints == 0 {
        return -1;
    }
    let joints = unsafe { std::slice::from_raw_parts_mut(joints_ptr, n_frames * n_joints * 4) };
    let out_root = unsafe { std::slice::from_raw_parts_mut(out_root_ptr, n_frames * 3) };
    let hip2d: &[f32] = if hip2d_ptr.is_null() {
        &[]
    } else {
        unsafe { std::slice::from_raw_parts(hip2d_ptr, n_frames * 4) }
    };
    let lm2d: &[f32] = if lm2d_ptr.is_null() {
        &[]
    } else {
        unsafe { std::slice::from_raw_parts(lm2d_ptr, n_frames * n_joints * 3) }
    };
    let cam_motion: &[f32] = if cam_motion_ptr.is_null() {
        &[]
    } else {
        unsafe { std::slice::from_raw_parts(cam_motion_ptr, n_frames * 4) }
    };
    let mut flags_opt = if out_flags_ptr.is_null() {
        None
    } else {
        Some(unsafe { std::slice::from_raw_parts_mut(out_flags_ptr, n_frames * 2) })
    };
    let chains_vec = decode_chains(chains_ptr, n_chains);

    process_joints_core(
        joints,
        hip2d,
        lm2d,
        cam_motion,
        &chains_vec,
        out_root,
        flags_opt.as_deref_mut(),
        n_frames,
        n_joints,
        fps,
        min_cutoff,
        beta,
        d_cutoff,
        min_vis,
        max_gap,
        zero_phase,
        do_foot_lock,
        vel_thresh,
        floor_tol,
        blend_frames,
        hips_idx,
        spine_idx,
        neck_idx,
        nose_idx,
        l_sh,
        r_sh,
        l_elb,
        r_elb,
        l_wri,
        r_wri,
        l_han,
        r_han,
        l_hip,
        l_knee,
        l_ankle,
        l_foot,
        r_hip,
        r_knee,
        r_ankle,
        r_foot,
        occlusion_strength,
        sg_passes,
        temporal_lifting != 0,
        aspect_ratio,
    )
}

/// Standalone smooth Hermite Foot-Lock IK directly on an already-processed joint buffer + root trajectory.
#[no_mangle]
pub extern "C" fn mk_apply_foot_lock(
    joints_ptr: *mut f32,
    root_ptr: *mut f32,
    out_flags_ptr: *mut u8,
    n_frames: usize,
    n_joints: usize,
    fps: f32,
    vel_thresh: f32,
    floor_tol: f32,
    blend_frames: usize,
    l_hip: usize,
    l_knee: usize,
    l_ankle: usize,
    l_foot: i32,
    r_hip: usize,
    r_knee: usize,
    r_ankle: usize,
    r_foot: i32,
) -> i32 {
    if joints_ptr.is_null() || root_ptr.is_null() || n_frames == 0 || n_joints == 0 {
        return -1;
    }
    let joints = unsafe { std::slice::from_raw_parts_mut(joints_ptr, n_frames * n_joints * 4) };
    let root = unsafe { std::slice::from_raw_parts_mut(root_ptr, n_frames * 3) };
    let mut flags_opt = if out_flags_ptr.is_null() {
        None
    } else {
        Some(unsafe { std::slice::from_raw_parts_mut(out_flags_ptr, n_frames * 2) })
    };
    let locked = filters::apply_foot_lock(
        joints,
        root,
        n_frames,
        n_joints,
        fps,
        l_hip,
        l_knee,
        l_ankle,
        if l_foot >= 0 { Some(l_foot as usize) } else { None },
        r_hip,
        r_knee,
        r_ankle,
        if r_foot >= 0 { Some(r_foot as usize) } else { None },
        vel_thresh,
        floor_tol,
        blend_frames,
        flags_opt.as_deref_mut(),
    );
    locked as i32
}

/// Scalar/vector retarget metadata block (`60 floats` matching JS packer):
/// 0..15:  hips_parent_world_mat (16)
/// 16..31: hips_parent_world_inv_mat (16)
/// 32..35: hips_parent_world_quat (4)
/// 36..38: rest_hips_world_pos (3)
/// 39..42: rest_hips_world_quat (4)
/// 43..45: rest_hips_right (3)
/// 46..48: rest_hips_fwd (3)
/// 49..51: rest_torso_up (3)
/// 52..54: rest_head_fwd (3)
/// 55:     char_height
/// 56:     rest_min_foot_y
/// 57:     fps
/// 58:     root_scale
/// 59:     depth_scale
/// 60:     root_rotation_weight
/// 61:     smoothness
/// 62:     facing_offset_deg
/// 63:     pole_weight
/// 64:     flags_bitmask (bit0 = root_motion, bit1 = mirror_x, bit2 = auto_facing)
fn parse_retarget_config(meta: &[f32]) -> RetargetConfig {
    let mut parent_mat = [0.0f32; 16];
    let mut parent_inv = [0.0f32; 16];
    parent_mat.copy_from_slice(&meta[0..16]);
    parent_inv.copy_from_slice(&meta[16..32]);

    let flags_bits = meta[64].round() as u32;
    let torso_radius = if meta.len() > 65 { meta[65] } else { 0.0 };
    let thigh_radius = if meta.len() > 66 { meta[66] } else { 0.0 };
    let disable_grounding = (flags_bits & 16) != 0;
    let use_fullbody_ik =
        !disable_grounding && ((flags_bits & 8) != 0 || (meta.len() > 67 && meta[67] > 0.5));

    RetargetConfig {
        fps: meta[57],
        root_motion: (flags_bits & 1) != 0,
        root_scale: meta[58],
        depth_scale: meta[59],
        root_rotation_weight: meta[60],
        smoothness: meta[61],
        mirror_x: (flags_bits & 2) != 0,
        facing_offset_deg: meta[62],
        auto_facing: (flags_bits & 4) != 0,
        pole_weight: meta[63],
        char_height: meta[55],
        rest_min_foot_y: meta[56],
        torso_radius,
        thigh_radius,
        use_fullbody_ik,
        disable_grounding,
        rest_hips_world_pos: Vec3::new(meta[36], meta[37], meta[38]),
        rest_hips_world_quat: Quat::new(meta[39], meta[40], meta[41], meta[42]).normalized(),
        rest_hips_right: Vec3::new(meta[43], meta[44], meta[45]),
        rest_hips_fwd: Vec3::new(meta[46], meta[47], meta[48]),
        rest_torso_up: Vec3::new(meta[49], meta[50], meta[51]),
        rest_head_fwd: Vec3::new(meta[52], meta[53], meta[54]),
        hips_parent_world_quat: Quat::new(meta[32], meta[33], meta[34], meta[35]).normalized(),
        hips_parent_world_mat: parent_mat,
        hips_parent_world_inv_mat: parent_inv,
    }
}

/// Retarget 20 core humanoid bones (legacy ABI, kept unchanged for backward compatibility).
#[no_mangle]
pub extern "C" fn mk_retarget_humanoid(
    bone_slots_ptr: *const f32,
    meta_ptr: *const f32,
    joints_ptr: *const f32,
    root_traj_ptr: *const f32,
    foot_flags_ptr: *const u8,
    n_frames: usize,
    stride_joints: usize,
    out_quats_ptr: *mut f32,
    out_hips_pos_ptr: *mut f32,
) -> i32 {
    mk_retarget_humanoid_v2(
        bone_slots_ptr,
        N_CORE_BONES,
        meta_ptr,
        65,
        joints_ptr,
        root_traj_ptr,
        foot_flags_ptr,
        n_frames,
        stride_joints,
        out_quats_ptr,
        out_hips_pos_ptr,
    )
}

/// Extended retargeter v2: supports `N_BONES = 22` (including `LeftToeBase`/`RightToeBase`),
/// calibrated mesh capsule radii (`meta[65..67]`), heel-to-toe landmarks (`stride_joints >= 25`),
/// and closed-loop two-foot Grounding IK.
#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub extern "C" fn mk_retarget_humanoid_v2(
    bone_slots_ptr: *const f32,
    n_bones_io: usize,
    meta_ptr: *const f32,
    meta_len: usize,
    joints_ptr: *const f32,
    root_traj_ptr: *const f32,
    foot_flags_ptr: *const u8,
    n_frames: usize,
    stride_joints: usize,
    out_quats_ptr: *mut f32,
    out_hips_pos_ptr: *mut f32,
) -> i32 {
    let n_bones = n_bones_io.clamp(1, N_BONES);
    if bone_slots_ptr.is_null()
        || meta_ptr.is_null()
        || meta_len < 65
        || joints_ptr.is_null()
        || root_traj_ptr.is_null()
        || out_quats_ptr.is_null()
        || out_hips_pos_ptr.is_null()
        || n_frames == 0
    {
        return -1;
    }

    let bone_slots = unsafe { std::slice::from_raw_parts(bone_slots_ptr, n_bones * retarget::BONE_SLOT_FLOATS) };
    let meta = unsafe { std::slice::from_raw_parts(meta_ptr, meta_len) };
    let joints = unsafe { std::slice::from_raw_parts(joints_ptr, n_frames * stride_joints * 4) };
    let root_traj = unsafe { std::slice::from_raw_parts(root_traj_ptr, n_frames * 3) };
    let foot_flags: &[u8] = if foot_flags_ptr.is_null() {
        &[]
    } else {
        unsafe { std::slice::from_raw_parts(foot_flags_ptr, n_frames * 2) }
    };
    let out_quats = unsafe { std::slice::from_raw_parts_mut(out_quats_ptr, n_frames * n_bones * 4) };
    let out_hips_pos = unsafe { std::slice::from_raw_parts_mut(out_hips_pos_ptr, n_frames * 3) };

    let cfg = parse_retarget_config(meta);
    retarget::retarget_humanoid_ext(
        bone_slots,
        joints,
        root_traj,
        foot_flags,
        n_frames,
        stride_joints,
        n_bones,
        &cfg,
        out_quats,
        out_hips_pos,
    );
    0
}

#[cfg(test)]
mod tests {
    use super::*;
    use retarget::*;
    use std::f32::consts::PI;

    fn make_test_rig_slots() -> ([f32; N_BONES * BONE_SLOT_FLOATS], [f32; 65]) {
        let mut slots = [0.0f32; N_BONES * BONE_SLOT_FLOATS];
        let set_slot = |slots: &mut [f32], idx: usize, parent: i32, pos: [f32; 3], aim: [f32; 3], pole: [f32; 3]| {
            let b = idx * BONE_SLOT_FLOATS;
            slots[b] = 1.0;
            slots[b + 1] = parent as f32;
            slots[b + 2] = pos[0];
            slots[b + 3] = pos[1];
            slots[b + 4] = pos[2];
            slots[b + 8] = 1.0; // identity local quat
            slots[b + 9] = 1.0;
            slots[b + 10] = 1.0;
            slots[b + 11] = 1.0;
            slots[b + 12] = aim[0];
            slots[b + 13] = aim[1];
            slots[b + 14] = aim[2];
            slots[b + 15] = pole[0];
            slots[b + 16] = pole[1];
            slots[b + 17] = pole[2];
        };

        set_slot(&mut slots, B_HIPS, -1, [0.0, 0.95, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]);
        set_slot(&mut slots, B_SPINE, B_HIPS as i32, [0.0, 0.15, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]);
        set_slot(&mut slots, B_SPINE1, B_SPINE as i32, [0.0, 0.15, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]);
        set_slot(&mut slots, B_NECK, B_SPINE1 as i32, [0.0, 0.18, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]);
        set_slot(&mut slots, B_HEAD, B_NECK as i32, [0.0, 0.12, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]);
        set_slot(&mut slots, B_L_ARM, B_SPINE1 as i32, [0.18, 0.15, 0.0], [1.0, 0.0, 0.0], [0.0, 0.0, -1.0]);
        set_slot(&mut slots, B_L_FOREARM, B_L_ARM as i32, [0.28, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 0.0, -1.0]);
        set_slot(&mut slots, B_R_ARM, B_SPINE1 as i32, [-0.18, 0.15, 0.0], [-1.0, 0.0, 0.0], [0.0, 0.0, -1.0]);
        set_slot(&mut slots, B_R_FOREARM, B_R_ARM as i32, [-0.28, 0.0, 0.0], [-1.0, 0.0, 0.0], [0.0, 0.0, -1.0]);
        set_slot(&mut slots, B_L_UPLEG, B_HIPS as i32, [0.10, 0.0, 0.0], [0.0, -1.0, 0.0], [0.0, 0.0, 1.0]);
        set_slot(&mut slots, B_L_LEG, B_L_UPLEG as i32, [0.0, -0.45, 0.0], [0.0, -1.0, 0.0], [0.0, 0.0, 1.0]);
        set_slot(&mut slots, B_L_FOOT, B_L_LEG as i32, [0.0, -0.45, 0.0], [0.0, 0.0, 1.0], [0.0, 1.0, 0.0]);
        set_slot(&mut slots, B_L_TOE, B_L_FOOT as i32, [0.0, 0.0, 0.14], [0.0, 0.0, 1.0], [0.0, 1.0, 0.0]);
        set_slot(&mut slots, B_R_UPLEG, B_HIPS as i32, [-0.10, 0.0, 0.0], [0.0, -1.0, 0.0], [0.0, 0.0, 1.0]);
        set_slot(&mut slots, B_R_LEG, B_R_UPLEG as i32, [0.0, -0.45, 0.0], [0.0, -1.0, 0.0], [0.0, 0.0, 1.0]);
        set_slot(&mut slots, B_R_FOOT, B_R_LEG as i32, [0.0, -0.45, 0.0], [0.0, 0.0, 1.0], [0.0, 1.0, 0.0]);
        set_slot(&mut slots, B_R_TOE, B_R_FOOT as i32, [0.0, 0.0, 0.14], [0.0, 0.0, 1.0], [0.0, 1.0, 0.0]);

        let mut meta = [0.0f32; 65];
        // Identity parent matrices
        meta[0] = 1.0; meta[5] = 1.0; meta[10] = 1.0; meta[15] = 1.0;
        meta[16] = 1.0; meta[21] = 1.0; meta[26] = 1.0; meta[31] = 1.0;
        meta[35] = 1.0; // parent world quat w
        meta[36] = 0.0; meta[37] = 0.95; meta[38] = 0.0; // rest hips pos
        meta[42] = 1.0; // rest hips quat w
        meta[43] = 1.0; meta[48] = 1.0; meta[50] = 1.0; meta[54] = 1.0;
        meta[55] = 1.72; // height
        meta[56] = 0.05; // rest_min_foot_y
        meta[57] = 30.0; // fps
        meta[58] = 1.0;  // root_scale
        meta[59] = 1.0;  // depth_scale
        meta[60] = 0.85; // root_rotation_weight
        meta[61] = 0.4;  // smoothness
        meta[62] = 0.0;  // facing offset
        meta[63] = 0.75; // pole_weight
        meta[64] = 1.0;  // root_motion = true

        (slots, meta)
    }

    #[test]
    fn despike_removes_single_frame_glitch() {
        let mut buf = vec![0.0f32; 10 * 4];
        for f in 0..10 {
            buf[f * 4] = f as f32 * 0.02;
            buf[f * 4 + 3] = 0.95;
        }
        buf[5 * 4 + 1] = 2.5; // massive 2.5m single-frame glitch!
        filters::despike_outliers(&mut buf, 10, 1, 0.2);
        assert!(buf[5 * 4 + 1].abs() < 1e-4, "spike y={}", buf[5 * 4 + 1]);
    }

    #[test]
    fn foot_lock_ease_out_is_continuous() {
        let n = 16;
        let nj = 4; // 0=hip, 1=knee, 2=ankle, 3=foot
        let mut buf = vec![0.0f32; n * nj * 4];
        let mut root = vec![0.0f32; n * 3];
        for f in 0..n {
            let drift = if f < 8 { (f as f32) * 0.04 } else { 0.28 + ((f - 8) as f32) * 0.18 };
            let lift = if f >= 8 { ((f - 8) as f32) * 0.04 } else { 0.0 };
            for (j, y) in [(0, 0.9), (1, 0.45), (2, 0.02 + lift), (3, lift)].iter().copied() {
                let b = (f * nj + j) * 4;
                buf[b] = drift * if j >= 2 { 1.0 } else { 0.0 };
                buf[b + 1] = y;
                buf[b + 3] = 0.95;
            }
        }
        let mut flags = vec![0u8; n * 2];
        let locked = filters::apply_foot_lock(
            &mut buf, &mut root, n, nj, 30.0,
            0, 1, 2, Some(3), 0, 1, 2, Some(3),
            0.25, 0.05, 3, Some(&mut flags),
        );
        assert!(locked > 0);
        // Check step discontinuity between lock exit frame 7 and eased frame 8 is gentle (< 0.14m).
        let x7 = buf[(7 * nj + 2) * 4];
        let x8 = buf[(8 * nj + 2) * 4];
        assert!((x8 - x7).abs() < 0.15, "foot snap delta too large: {}", (x8 - x7).abs());
    }

    #[test]
    fn retarget_is_deterministic_across_reapplies() {
        let (slots, meta) = make_test_rig_slots();
        let n = 24;
        let nj = 23;
        let mut joints = vec![0.0f32; n * nj * 4];
        for f in 0..n {
            let t = f as f32 / 24.0;
            let set_j = |j_buf: &mut [f32], idx: usize, v: [f32; 3]| {
                let b = (f * nj + idx) * 4;
                j_buf[b] = v[0];
                j_buf[b + 1] = v[1];
                j_buf[b + 2] = v[2];
                j_buf[b + 3] = 0.95;
            };
            let arm_lift = (t * PI).sin() * 0.35;
            set_j(&mut joints, J_HIPS, [0.0, 0.95, 0.0]);
            set_j(&mut joints, J_SPINE, [0.0, 1.15, 0.0]);
            set_j(&mut joints, J_NECK, [0.0, 1.42, 0.0]);
            set_j(&mut joints, J_HEAD, [0.0, 1.56, 0.02]);
            set_j(&mut joints, J_NOSE, [0.0, 1.54, 0.14]);
            set_j(&mut joints, J_L_EAR, [0.08, 1.55, 0.0]);
            set_j(&mut joints, J_R_EAR, [-0.08, 1.55, 0.0]);
            set_j(&mut joints, J_L_SHOULDER, [0.18, 1.4, 0.0]);
            set_j(&mut joints, J_L_ELBOW, [0.40, 1.25 + arm_lift, 0.08]);
            set_j(&mut joints, J_L_WRIST, [0.52, 1.15 + arm_lift * 1.3, 0.25]);
            set_j(&mut joints, J_R_SHOULDER, [-0.18, 1.4, 0.0]);
            set_j(&mut joints, J_R_ELBOW, [-0.40, 1.25, 0.05]);
            set_j(&mut joints, J_R_WRIST, [-0.52, 1.10, 0.15]);
            set_j(&mut joints, J_L_HIP, [0.10, 0.92, 0.0]);
            set_j(&mut joints, J_L_KNEE, [0.10, 0.49, 0.12]);
            set_j(&mut joints, J_L_ANKLE, [0.10, 0.06, -0.05]);
            set_j(&mut joints, J_L_FOOT, [0.10, 0.02, 0.10]);
            set_j(&mut joints, J_R_HIP, [-0.10, 0.92, 0.0]);
            set_j(&mut joints, J_R_KNEE, [-0.10, 0.49, 0.02]);
            set_j(&mut joints, J_R_ANKLE, [-0.10, 0.05, 0.0]);
            set_j(&mut joints, J_R_FOOT, [-0.10, 0.02, 0.14]);
        }
        let root_traj = vec![0.0f32; n * 3];
        let foot_flags = vec![0u8; n * 2];

        let mut q1 = vec![0.0f32; n * N_CORE_BONES * 4];
        let mut p1 = vec![0.0f32; n * 3];
        let mut q2 = vec![0.0f32; n * N_CORE_BONES * 4];
        let mut p2 = vec![0.0f32; n * 3];

        mk_retarget_humanoid(
            slots.as_ptr(), meta.as_ptr(), joints.as_ptr(), root_traj.as_ptr(), foot_flags.as_ptr(),
            n, nj, q1.as_mut_ptr(), p1.as_mut_ptr(),
        );
        mk_retarget_humanoid(
            slots.as_ptr(), meta.as_ptr(), joints.as_ptr(), root_traj.as_ptr(), foot_flags.as_ptr(),
            n, nj, q2.as_mut_ptr(), p2.as_mut_ptr(),
        );

        assert_eq!(q1, q2);
        assert_eq!(p1, p2);
        assert!(q1.iter().all(|v| v.is_finite()));
        assert!(p1.iter().all(|v| v.is_finite()));
    }

    #[test]
    fn y_down_raw_mediapipe_auto_normalizes_upright() {
        let (slots, meta) = make_test_rig_slots();
        let n = 6;
        let nj = 23;
        let mut joints = vec![0.0f32; n * nj * 4];
        for f in 0..n {
            let set_j = |j_buf: &mut [f32], idx: usize, v: [f32; 3]| {
                let b = (f * nj + idx) * 4;
                j_buf[b] = v[0];
                j_buf[b + 1] = v[1];
                j_buf[b + 2] = v[2];
                j_buf[b + 3] = 0.95;
            };
            // Raw MediaPipe +Y DOWN sample (head negative Y, ankles positive Y)
            set_j(&mut joints, J_HIPS, [0.0, 0.0, 0.0]);
            set_j(&mut joints, J_SPINE, [0.0, -0.25, 0.0]);
            set_j(&mut joints, J_NECK, [0.0, -0.45, 0.0]);
            set_j(&mut joints, J_NOSE, [0.0, -0.55, -0.1]);
            set_j(&mut joints, J_L_SHOULDER, [0.18, -0.45, 0.0]);
            set_j(&mut joints, J_R_SHOULDER, [-0.18, -0.45, 0.0]);
            set_j(&mut joints, J_L_ELBOW, [0.35, -0.20, 0.0]);
            set_j(&mut joints, J_L_WRIST, [0.40, 0.05, 0.0]);
            set_j(&mut joints, J_R_ELBOW, [-0.35, -0.20, 0.0]);
            set_j(&mut joints, J_R_WRIST, [-0.40, 0.05, 0.0]);
            set_j(&mut joints, J_L_HIP, [0.10, 0.0, 0.0]);
            set_j(&mut joints, J_L_KNEE, [0.10, 0.42, 0.0]);
            set_j(&mut joints, J_L_ANKLE, [0.10, 0.84, 0.0]);
            set_j(&mut joints, J_R_HIP, [-0.10, 0.0, 0.0]);
            set_j(&mut joints, J_R_KNEE, [-0.10, 0.42, 0.0]);
            set_j(&mut joints, J_R_ANKLE, [-0.10, 0.84, 0.0]);
        }
        let root_traj = vec![0.0f32; n * 3];
        let foot_flags = vec![0u8; n * 2];
        let mut q_out = vec![0.0f32; n * N_CORE_BONES * 4];
        let mut p_out = vec![0.0f32; n * 3];

        mk_retarget_humanoid(
            slots.as_ptr(), meta.as_ptr(), joints.as_ptr(), root_traj.as_ptr(), foot_flags.as_ptr(),
            n, nj, q_out.as_mut_ptr(), p_out.as_mut_ptr(),
        );
        // Upright hips position stays around +0.95m (not inverted underground at -0.85m!)
        assert!(p_out[1] > 0.7 && p_out[1] < 1.3, "upright hips y={}", p_out[1]);
        // Standing left thigh rest dir (0, -1, 0) stays pointing down -> near-identity w > 0.85
        let w_up_leg = q_out[B_L_UPLEG * 4 + 3].abs();
        assert!(w_up_leg > 0.85, "thigh flipped! w={}", w_up_leg);
    }

    #[test]
    fn occlusion_recovery_prevents_chest_clipping() {
        let n = 20;
        let nj = N_JOINTS;
        let mut joints = vec![0.0f32; n * nj * 4];
        for f in 0..n {
            let phase = (f as f32 / n as f32) * 2.0 * PI;
            let set_j = |buf: &mut [f32], idx: usize, v: [f32; 3], vis: f32| {
                let b = (f * nj + idx) * 4;
                buf[b] = v[0];
                buf[b + 1] = v[1];
                buf[b + 2] = v[2];
                buf[b + 3] = vis;
            };
            set_j(&mut joints, J_HIPS, [0.0, 0.95, 0.0], 0.95);
            set_j(&mut joints, J_SPINE, [0.0, 1.18, 0.0], 0.95);
            set_j(&mut joints, J_NECK, [0.0, 1.45, 0.0], 0.95);
            set_j(&mut joints, J_L_SHOULDER, [0.19, 1.42, 0.0], 0.95);
            set_j(&mut joints, J_R_SHOULDER, [-0.19, 1.42, 0.0], 0.90);
            // Visible left arm swings normally
            set_j(&mut joints, J_L_ELBOW, [0.24, 1.16, 0.06 + 0.08 * phase.sin()], 0.92);
            set_j(&mut joints, J_L_WRIST, [0.25, 0.92, 0.14 + 0.10 * phase.sin()], 0.90);
            // Occluded far-side right arm collapsed right into chest center!
            set_j(&mut joints, J_R_ELBOW, [0.01, 1.15, 0.02], 0.05);
            set_j(&mut joints, J_R_WRIST, [0.02, 1.05, 0.03], 0.04);
            set_j(&mut joints, J_R_HAND, [0.02, 1.00, 0.03], 0.04);
            // Active knees for counterbalance swing
            set_j(&mut joints, J_L_HIP, [0.10, 0.92, 0.0], 0.95);
            set_j(&mut joints, J_R_HIP, [-0.10, 0.92, 0.0], 0.95);
            set_j(&mut joints, J_L_KNEE, [0.10, 0.48, 0.15 * phase.sin()], 0.92);
            set_j(&mut joints, J_R_KNEE, [-0.10, 0.48, -0.15 * phase.sin()], 0.85);
        }

        filters::resolve_occlusions_and_self_collision(
            &mut joints,
            n,
            nj,
            J_HIPS,
            J_SPINE,
            J_NECK,
            J_L_SHOULDER,
            J_R_SHOULDER,
            J_L_ELBOW,
            J_R_ELBOW,
            J_L_WRIST,
            J_R_WRIST,
            J_L_HAND,
            J_R_HAND,
            J_L_HIP,
            J_R_HIP,
            J_L_KNEE,
            J_R_KNEE,
            0.25,
            0.95,
        );

        for f in 0..n {
            let rw_b = (f * nj + J_R_WRIST) * 4;
            let rw = Vec3::new(joints[rw_b], joints[rw_b + 1], joints[rw_b + 2]);
            let re_b = (f * nj + J_R_ELBOW) * 4;
            let re = Vec3::new(joints[re_b], joints[re_b + 1], joints[re_b + 2]);
            let torso_xz_w = (rw.x * rw.x + rw.z * rw.z).sqrt();
            let torso_xz_e = (re.x * re.x + re.z * re.z).sqrt();
            assert!(torso_xz_e >= 0.18, "frame {} occluded elbow still inside torso XZ={}", f, torso_xz_e);
            assert!(torso_xz_w >= 0.18, "frame {} occluded wrist still inside torso XZ={}", f, torso_xz_w);
            assert!(joints[rw_b + 3] >= 0.5, "occluded wrist confidence not promoted");
        }
    }

    #[test]
    fn straight_knee_pole_has_no_180_flip() {
        let (slots, meta) = make_test_rig_slots();
        let n = 24;
        let nj = N_JOINTS;
        let mut joints = vec![0.0f32; n * nj * 4];
        for f in 0..n {
            // Sweep knee smoothly from slightly back (-0.03) through dead-straight (0.0) to bent (+0.16)
            let z_knee = -0.02 + (f as f32 / (n - 1) as f32) * 0.18;
            let set_j = |j_buf: &mut [f32], idx: usize, v: [f32; 3]| {
                let b = (f * nj + idx) * 4;
                j_buf[b] = v[0];
                j_buf[b + 1] = v[1];
                j_buf[b + 2] = v[2];
                j_buf[b + 3] = 0.95;
            };
            set_j(&mut joints, J_HIPS, [0.0, 0.95, 0.0]);
            set_j(&mut joints, J_SPINE, [0.0, 1.15, 0.0]);
            set_j(&mut joints, J_NECK, [0.0, 1.42, 0.0]);
            set_j(&mut joints, J_HEAD, [0.0, 1.56, 0.02]);
            set_j(&mut joints, J_NOSE, [0.0, 1.54, 0.14]);
            set_j(&mut joints, J_L_EAR, [0.08, 1.55, 0.0]);
            set_j(&mut joints, J_R_EAR, [-0.08, 1.55, 0.0]);
            set_j(&mut joints, J_L_SHOULDER, [0.18, 1.4, 0.0]);
            set_j(&mut joints, J_L_ELBOW, [0.35, 1.2, 0.05]);
            set_j(&mut joints, J_L_WRIST, [0.42, 1.0, 0.15]);
            set_j(&mut joints, J_R_SHOULDER, [-0.18, 1.4, 0.0]);
            set_j(&mut joints, J_R_ELBOW, [-0.35, 1.2, 0.05]);
            set_j(&mut joints, J_R_WRIST, [-0.42, 1.0, 0.15]);
            set_j(&mut joints, J_L_HIP, [0.10, 0.92, 0.0]);
            set_j(&mut joints, J_L_KNEE, [0.10, 0.49, z_knee]);
            set_j(&mut joints, J_L_ANKLE, [0.10, 0.06, 0.0]);
            set_j(&mut joints, J_L_FOOT, [0.10, 0.02, 0.14]);
            set_j(&mut joints, J_R_HIP, [-0.10, 0.92, 0.0]);
            set_j(&mut joints, J_R_KNEE, [-0.10, 0.49, 0.05]);
            set_j(&mut joints, J_R_ANKLE, [-0.10, 0.06, 0.0]);
            set_j(&mut joints, J_R_FOOT, [-0.10, 0.02, 0.14]);
        }
        let root_traj = vec![0.0f32; n * 3];
        let foot_flags = vec![0u8; n * 2];
        let mut q_out = vec![0.0f32; n * N_CORE_BONES * 4];
        let mut p_out = vec![0.0f32; n * 3];

        mk_retarget_humanoid(
            slots.as_ptr(),
            meta.as_ptr(),
            joints.as_ptr(),
            root_traj.as_ptr(),
            foot_flags.as_ptr(),
            n,
            nj,
            q_out.as_mut_ptr(),
            p_out.as_mut_ptr(),
        );

        let mut max_jump_deg = 0.0f32;
        for f in 1..n {
            let b0 = ((f - 1) * N_CORE_BONES + B_L_UPLEG) * 4;
            let b1 = (f * N_CORE_BONES + B_L_UPLEG) * 4;
            let q0 = Quat::new(q_out[b0], q_out[b0 + 1], q_out[b0 + 2], q_out[b0 + 3]).normalized();
            let q1 = Quat::new(q_out[b1], q_out[b1 + 1], q_out[b1 + 2], q_out[b1 + 3]).normalized();
            let dot = q0.dot(q1).abs().clamp(0.0, 1.0);
            let deg = (2.0 * dot.acos()).to_degrees();
            if deg > max_jump_deg {
                max_jump_deg = deg;
            }
        }
        assert!(max_jump_deg < 20.0, "LeftUpLeg snapped across straight knee: {} deg", max_jump_deg);
    }

    #[test]
    fn thigh_hand_clearance_and_leg_separation() {
        let n = 12;
        let nj = N_JOINTS;
        let mut joints = vec![0.0f32; n * nj * 4];
        for f in 0..n {
            let set_j = |buf: &mut [f32], idx: usize, v: [f32; 3], vis: f32| {
                let b = (f * nj + idx) * 4;
                buf[b] = v[0];
                buf[b + 1] = v[1];
                buf[b + 2] = v[2];
                buf[b + 3] = vis;
            };
            set_j(&mut joints, J_HIPS, [0.0, 0.95, 0.0], 0.95);
            set_j(&mut joints, J_SPINE, [0.0, 1.15, 0.0], 0.95);
            set_j(&mut joints, J_NECK, [0.0, 1.42, 0.0], 0.95);
            set_j(&mut joints, J_L_SHOULDER, [0.18, 1.40, 0.0], 0.95);
            set_j(&mut joints, J_R_SHOULDER, [-0.18, 1.40, 0.0], 0.95);
            // Left thigh raised high; place left wrist/hand intentionally inside left thigh
            set_j(&mut joints, J_L_HIP, [0.10, 0.92, 0.0], 0.95);
            set_j(&mut joints, J_L_KNEE, [0.10, 0.88, 0.42], 0.95);
            set_j(&mut joints, J_L_ANKLE, [0.05, 0.46, 0.42], 0.95);
            set_j(&mut joints, J_L_FOOT, [0.05, 0.44, 0.54], 0.95);
            set_j(&mut joints, J_L_ELBOW, [0.22, 1.12, 0.16], 0.90);
            set_j(&mut joints, J_L_WRIST, [0.10, 0.90, 0.22], 0.85);
            set_j(&mut joints, J_R_SHOULDER, [-0.18, 1.40, 0.0], 0.95);
            set_j(&mut joints, J_R_ELBOW, [-0.28, 1.15, 0.05], 0.90);
            set_j(&mut joints, J_R_WRIST, [-0.30, 0.90, 0.12], 0.85);
            // Right leg too close to left ankle
            set_j(&mut joints, J_R_HIP, [-0.10, 0.92, 0.0], 0.95);
            set_j(&mut joints, J_R_KNEE, [0.08, 0.86, 0.42], 0.95);
            set_j(&mut joints, J_R_ANKLE, [0.02, 0.46, 0.42], 0.95);
            set_j(&mut joints, J_R_FOOT, [0.02, 0.44, 0.54], 0.95);
        }

        filters::resolve_occlusions_and_self_collision(
            &mut joints,
            n,
            nj,
            J_HIPS,
            J_SPINE,
            J_NECK,
            J_L_SHOULDER,
            J_R_SHOULDER,
            J_L_ELBOW,
            J_R_ELBOW,
            J_L_WRIST,
            J_R_WRIST,
            nj,
            nj,
            J_L_HIP,
            J_R_HIP,
            J_L_KNEE,
            J_R_KNEE,
            0.35,
            0.92,
        );
        filters::enforce_leg_separation_and_occlusion(
            &mut joints,
            n,
            nj,
            J_HIPS,
            J_NECK,
            J_L_SHOULDER,
            J_R_SHOULDER,
            J_L_ELBOW,
            J_R_ELBOW,
            J_L_WRIST,
            J_R_WRIST,
            nj,
            nj,
            J_L_HIP,
            J_R_HIP,
            J_L_KNEE,
            J_R_KNEE,
            J_L_ANKLE,
            J_R_ANKLE,
            Some(J_L_FOOT),
            Some(J_R_FOOT),
            0.35,
            0.92,
        );

        let f = 6;
        let get_v = |idx: usize| -> [f32; 3] {
            let b = (f * nj + idx) * 4;
            [joints[b], joints[b + 1], joints[b + 2]]
        };
        let lw = get_v(J_L_WRIST);
        let lh = get_v(J_L_HIP);
        let lk = get_v(J_L_KNEE);
        // Closest distance from wrist to left thigh segment
        let ab = [lk[0] - lh[0], lk[1] - lh[1], lk[2] - lh[2]];
        let ap = [lw[0] - lh[0], lw[1] - lh[1], lw[2] - lh[2]];
        let ab2 = ab[0] * ab[0] + ab[1] * ab[1] + ab[2] * ab[2];
        let t = ((ap[0] * ab[0] + ap[1] * ab[1] + ap[2] * ab[2]) / ab2).clamp(0.0, 1.0);
        let dx = lw[0] - (lh[0] + t * ab[0]);
        let dy = lw[1] - (lh[1] + t * ab[1]);
        let dz = lw[2] - (lh[2] + t * ab[2]);
        let dist = (dx * dx + dy * dy + dz * dz).sqrt();
        assert!(dist >= 0.11, "left wrist still clipped raised thigh: dist={}", dist);

        let la = get_v(J_L_ANKLE);
        let ra = get_v(J_R_ANKLE);
        let ank_dist = ((la[0] - ra[0]).powi(2) + (la[1] - ra[1]).powi(2) + (la[2] - ra[2]).powi(2)).sqrt();
        assert!(ank_dist >= 0.13, "ankles too close / crossing: ank_dist={}", ank_dist);
    }

    #[test]
    fn symmetric_bilateral_foot_lock() {
        let n = 40;
        let nj = N_JOINTS;
        let mut joints = vec![0.0f32; n * nj * 4];
        for f in 0..n {
            let set_j = |buf: &mut [f32], idx: usize, v: [f32; 3]| {
                let b = (f * nj + idx) * 4;
                buf[b] = v[0];
                buf[b + 1] = v[1];
                buf[b + 2] = v[2];
                buf[b + 3] = 0.95;
            };
            // Deliberately give left shin shorter raw estimate (~0.34m) than right (~0.40m)
            // First 20 frames left stands on floor; next 20 frames right stands on floor
            let l_lift = if f < 20 { 0.0 } else { 0.25 };
            let r_lift = if f >= 20 { 0.0 } else { 0.25 };
            set_j(&mut joints, J_HIPS, [0.0, 0.95, 0.0]);
            set_j(&mut joints, J_L_HIP, [0.10, 0.92, 0.0]);
            set_j(&mut joints, J_L_KNEE, [0.10, 0.49 + l_lift * 0.5, 0.05]);
            set_j(&mut joints, J_L_ANKLE, [0.10, 0.15 + l_lift, 0.0]);
            set_j(&mut joints, J_R_HIP, [-0.10, 0.92, 0.0]);
            set_j(&mut joints, J_R_KNEE, [-0.10, 0.49 + r_lift * 0.5, 0.05]);
            set_j(&mut joints, J_R_ANKLE, [-0.10, 0.09 + r_lift, 0.0]);
        }

        filters::normalize_bilateral_limb_lengths(
            &mut joints,
            n,
            nj,
            &[(J_L_HIP, J_L_KNEE, J_L_ANKLE, None, J_R_HIP, J_R_KNEE, J_R_ANKLE, None)],
            0.35,
        );
        let mut root = vec![0.0f32; n * 3];
        let mut flags = vec![0u8; n * 2];
        let total = filters::apply_foot_lock(
            &mut joints,
            &mut root,
            n,
            nj,
            30.0,
            J_L_HIP,
            J_L_KNEE,
            J_L_ANKLE,
            None,
            J_R_HIP,
            J_R_KNEE,
            J_R_ANKLE,
            None,
            0.35,
            0.09,
            2,
            Some(&mut flags),
        );
        let l_locked: usize = flags.iter().step_by(2).map(|&v| v as usize).sum();
        let r_locked: usize = flags.iter().skip(1).step_by(2).map(|&v| v as usize).sum();
        assert!(total > 0 && l_locked >= 10 && r_locked >= 10, "imbalanced foot lock l={} r={}", l_locked, r_locked);
    }

    #[test]
    fn boundary_frame_snap_suppression() {
        let (slots, mut meta) = make_test_rig_slots();
        meta[15] = 0.0; // zero smoothing so we directly test boundary pop suppressor
        let n = 16;
        let nj = N_JOINTS;
        let mut joints = vec![0.0f32; n * nj * 4];
        for f in 0..n {
            let set_j = |j_buf: &mut [f32], idx: usize, v: [f32; 3]| {
                let b = (f * nj + idx) * 4;
                j_buf[b] = v[0];
                j_buf[b + 1] = v[1];
                j_buf[b + 2] = v[2];
                j_buf[b + 3] = 0.95;
            };
            set_j(&mut joints, J_HIPS, [0.0, 0.95, 0.0]);
            set_j(&mut joints, J_SPINE, [0.0, 1.15, 0.0]);
            set_j(&mut joints, J_NECK, [0.0, 1.42, 0.0]);
            set_j(&mut joints, J_HEAD, [0.0, 1.56, 0.02]);
            set_j(&mut joints, J_NOSE, [0.0, 1.54, 0.14]);
            set_j(&mut joints, J_L_EAR, [0.08, 1.55, 0.0]);
            set_j(&mut joints, J_R_EAR, [-0.08, 1.55, 0.0]);
            set_j(&mut joints, J_L_SHOULDER, [0.18, 1.4, 0.0]);
            // Inject massive final-frame arm snap at f == n - 1
            let elb = if f == n - 1 { [0.15, 1.68, -0.20] } else { [0.35, 1.2, 0.05] };
            let wri = if f == n - 1 { [-0.05, 1.85, -0.25] } else { [0.42, 1.0, 0.15] };
            set_j(&mut joints, J_L_ELBOW, elb);
            set_j(&mut joints, J_L_WRIST, wri);
            set_j(&mut joints, J_R_SHOULDER, [-0.18, 1.4, 0.0]);
            set_j(&mut joints, J_R_ELBOW, [-0.35, 1.2, 0.05]);
            set_j(&mut joints, J_R_WRIST, [-0.42, 1.0, 0.15]);
            set_j(&mut joints, J_L_HIP, [0.10, 0.92, 0.0]);
            set_j(&mut joints, J_L_KNEE, [0.10, 0.49, 0.08]);
            set_j(&mut joints, J_L_ANKLE, [0.10, 0.06, 0.0]);
            set_j(&mut joints, J_L_FOOT, [0.10, 0.02, 0.14]);
            set_j(&mut joints, J_R_HIP, [-0.10, 0.92, 0.0]);
            set_j(&mut joints, J_R_KNEE, [-0.10, 0.49, 0.08]);
            set_j(&mut joints, J_R_ANKLE, [-0.10, 0.06, 0.0]);
            set_j(&mut joints, J_R_FOOT, [-0.10, 0.02, 0.14]);
        }
        let root_traj = vec![0.0f32; n * 3];
        let foot_flags = vec![0u8; n * 2];
        let mut q_out = vec![0.0f32; n * N_CORE_BONES * 4];
        let mut p_out = vec![0.0f32; n * 3];
        mk_retarget_humanoid(
            slots.as_ptr(),
            meta.as_ptr(),
            joints.as_ptr(),
            root_traj.as_ptr(),
            foot_flags.as_ptr(),
            n,
            nj,
            q_out.as_mut_ptr(),
            p_out.as_mut_ptr(),
        );
        let b0 = ((n - 2) * N_CORE_BONES + B_L_ARM) * 4;
        let b1 = ((n - 1) * N_CORE_BONES + B_L_ARM) * 4;
        let q0 = Quat::new(q_out[b0], q_out[b0 + 1], q_out[b0 + 2], q_out[b0 + 3]).normalized();
        let q1 = Quat::new(q_out[b1], q_out[b1 + 1], q_out[b1 + 2], q_out[b1 + 3]).normalized();
        let end_jump_deg = (2.0 * q0.dot(q1).abs().clamp(0.0, 1.0).acos()).to_degrees();
        assert!(end_jump_deg < 18.0, "end frame snapped: {} deg", end_jump_deg);
    }

    #[test]
    fn temporal_lifting_disambiguates_quick_180_flip() {
        let n = 15;
        let nj = 25;
        let mut joints = vec![0.0f32; n * nj * 4];
        for f in 0..n {
            let set_j = |buf: &mut [f32], idx: usize, v: [f32; 3], vis: f32| {
                let b = (f * nj + idx) * 4;
                buf[b] = v[0];
                buf[b + 1] = v[1];
                buf[b + 2] = v[2];
                buf[b + 3] = vis;
            };
            // Almost side-on shoulder/hip profile where frame 7 suffers a spurious depth-sign flip
            let flip = if f == 7 || f == 8 { -1.0 } else { 1.0 };
            set_j(&mut joints, J_HIPS, [0.0, 0.95, 0.0], 0.95);
            set_j(&mut joints, J_SPINE, [0.0, 1.20, 0.0], 0.95);
            set_j(&mut joints, J_NECK, [0.0, 1.42, 0.0], 0.95);
            set_j(&mut joints, J_NOSE, [0.0, 1.54, 0.12 * flip], 0.95);
            set_j(&mut joints, J_L_SHOULDER, [0.02 * flip, 1.42, 0.16 * flip], 0.95);
            set_j(&mut joints, J_R_SHOULDER, [-0.02 * flip, 1.42, -0.16 * flip], 0.95);
            set_j(&mut joints, J_L_HIP, [0.01 * flip, 0.92, 0.10 * flip], 0.95);
            set_j(&mut joints, J_R_HIP, [-0.01 * flip, 0.92, -0.10 * flip], 0.95);
        }
        temporal::run_temporal_lifting(
            &mut joints,
            &[],
            n,
            nj,
            30.0,
            J_HIPS,
            J_L_SHOULDER as i32,
            J_R_SHOULDER as i32,
            J_L_ELBOW as i32,
            J_R_ELBOW as i32,
            J_L_WRIST as i32,
            J_R_WRIST as i32,
            J_L_HIP,
            J_R_HIP,
            J_L_KNEE,
            J_R_KNEE,
            J_L_ANKLE,
            J_R_ANKLE,
            J_NOSE as i32,
            0.35,
        );
        // After temporal disambiguation, frame 7 must stay consistent with neighbors (positive L shoulder z)
        let ls_z_prev = joints[(6 * nj + J_L_SHOULDER) * 4 + 2];
        let ls_z_mid = joints[(7 * nj + J_L_SHOULDER) * 4 + 2];
        assert!(
            ls_z_mid * ls_z_prev > 0.0,
            "Spurious 180 flip was not corrected: prev={}, mid={}",
            ls_z_prev,
            ls_z_mid
        );
    }

    #[test]
    fn compensated_root_trajectory_cancels_camera_pan() {
        let n = 10;
        let nj = 25;
        let mut joints = vec![0.0f32; n * nj * 4];
        let mut hip2d = vec![0.0f32; n * 4];
        let mut cam_motion = vec![0.0f32; n * 4];
        for f in 0..n {
            let b = (f * nj) * 4;
            // Upright standing skeleton (neck above hips by 0.50m)
            joints[b + J_HIPS * 4 + 1] = 0.95;
            joints[b + J_HIPS * 4 + 3] = 0.95;
            joints[b + J_NECK * 4 + 1] = 1.45;
            joints[b + J_NECK * 4 + 3] = 0.95;

            // Camera pans RIGHT continuously (+0.02 norm/frame), so stationary dancer drifts LEFT in image (-0.02/frame)
            let pan_x = f as f32 * 0.02;
            cam_motion[f * 4] = pan_x;
            cam_motion[f * 4 + 1] = 0.0;
            cam_motion[f * 4 + 2] = 1.0;
            cam_motion[f * 4 + 3] = 0.95;

            // hip2d uses milli-normalized (* 1000) coordinates matching hip2DFrom()
            hip2d[f * 4] = (0.5 - pan_x) * 1000.0;
            hip2d[f * 4 + 1] = 500.0;
            hip2d[f * 4 + 2] = 250.0;
            hip2d[f * 4 + 3] = 0.95;
        }
        let mut out_comp = vec![0.0f32; n * 3];
        filters::compute_root_trajectory_compensated(
            &joints,
            &hip2d,
            &cam_motion,
            n,
            nj,
            J_HIPS,
            J_NECK,
            1.0,
            1.0,
            &mut out_comp,
        );
        // World X drift across the pan must be near zero (< 0.05m) instead of ~ -0.36m
        let max_x_drift = out_comp
            .chunks_exact(3)
            .map(|p| p[0].abs())
            .fold(0.0f32, f32::max);
        assert!(
            max_x_drift < 0.05,
            "Camera pan compensation failed to cancel stationary drift: max_x={}",
            max_x_drift
        );
    }

    #[test]
    fn retarget_v2_solves_toe_dorsiflexion_and_grounding_ik() {
        let (slots, meta_base) = make_test_rig_slots();
        let mut meta = [0.0f32; 68];
        meta[..65].copy_from_slice(&meta_base);
        meta[65] = 0.14; // torso_radius
        meta[66] = 0.075; // thigh_radius
        meta[67] = 1.0; // use_fullbody_ik

        let n = 8;
        let nj = 25;
        let mut joints = vec![0.0f32; n * nj * 4];
        for f in 0..n {
            let set_j = |buf: &mut [f32], idx: usize, v: [f32; 3]| {
                let b = (f * nj + idx) * 4;
                buf[b] = v[0];
                buf[b + 1] = v[1];
                buf[b + 2] = v[2];
                buf[b + 3] = 0.95;
            };
            set_j(&mut joints, J_HIPS, [0.0, 0.95, 0.0]);
            set_j(&mut joints, J_SPINE, [0.0, 1.20, 0.0]);
            set_j(&mut joints, J_NECK, [0.0, 1.42, 0.0]);
            set_j(&mut joints, J_NOSE, [0.0, 1.54, 0.12]);
            set_j(&mut joints, J_L_SHOULDER, [0.18, 1.42, 0.0]);
            set_j(&mut joints, J_L_ELBOW, [0.35, 1.20, 0.05]);
            set_j(&mut joints, J_L_WRIST, [0.42, 1.0, 0.15]);
            set_j(&mut joints, J_R_SHOULDER, [-0.18, 1.42, 0.0]);
            set_j(&mut joints, J_R_ELBOW, [-0.35, 1.20, 0.05]);
            set_j(&mut joints, J_R_WRIST, [-0.42, 1.0, 0.15]);
            // Left heel lifts up on tiptoe while foot tip remains near ground!
            set_j(&mut joints, J_L_HIP, [0.10, 0.92, 0.0]);
            set_j(&mut joints, J_L_KNEE, [0.10, 0.52, 0.10]);
            set_j(&mut joints, J_L_ANKLE, [0.10, 0.14, -0.02]);
            set_j(&mut joints, J_L_HEEL, [0.10, 0.13, -0.06]);
            set_j(&mut joints, J_L_FOOT, [0.10, 0.02, 0.14]);
            // Right foot planted flat
            set_j(&mut joints, J_R_HIP, [-0.10, 0.92, 0.0]);
            set_j(&mut joints, J_R_KNEE, [-0.10, 0.49, 0.04]);
            set_j(&mut joints, J_R_ANKLE, [-0.10, 0.06, 0.0]);
            set_j(&mut joints, J_R_HEEL, [-0.10, 0.02, -0.05]);
            set_j(&mut joints, J_R_FOOT, [-0.10, 0.02, 0.14]);
        }
        let root_traj = vec![0.0f32; n * 3];
        let foot_flags = vec![1u8; n * 2]; // both grounded -> tests double-support IK + toe pivot
        let mut q_out = vec![0.0f32; n * N_BONES * 4];
        let mut p_out = vec![0.0f32; n * 3];

        let rc = mk_retarget_humanoid_v2(
            slots.as_ptr(),
            N_BONES,
            meta.as_ptr(),
            meta.len(),
            joints.as_ptr(),
            root_traj.as_ptr(),
            foot_flags.as_ptr(),
            n,
            nj,
            q_out.as_mut_ptr(),
            p_out.as_mut_ptr(),
        );
        assert_eq!(rc, 0);
        assert!(q_out.iter().all(|v| v.is_finite()));
        assert!(p_out.iter().all(|v| v.is_finite()));

        // LeftToeBase should dorsiflex non-trivially compared to flat RightToeBase
        let lt_idx = (3 * N_BONES + B_L_TOE) * 4;
        let rt_idx = (3 * N_BONES + B_R_TOE) * 4;
        let q_lt = Quat::new(q_out[lt_idx], q_out[lt_idx + 1], q_out[lt_idx + 2], q_out[lt_idx + 3]);
        let q_rt = Quat::new(q_out[rt_idx], q_out[rt_idx + 1], q_out[rt_idx + 2], q_out[rt_idx + 3]);
        let lt_ang = (2.0 * q_lt.w.abs().clamp(0.0, 1.0).acos()).to_degrees();
        let rt_ang = (2.0 * q_rt.w.abs().clamp(0.0, 1.0).acos()).to_degrees();
        assert!(
            lt_ang > rt_ang + 5.0,
            "Expected lifted heel to bend LeftToeBase more than flat RightToeBase: L={} deg, R={} deg",
            lt_ang,
            rt_ang
        );
    }

    #[test]
    fn kinematic_opt_improves_2d_3d_foreshortened_pose() {
        let n = 12usize;
        let nj = 25usize;
        let mut joints = vec![0.0f32; n * nj * 4];
        let mut lm2d = vec![0.0f32; n * nj * 3];

        // Ground-truth upright dancer reaching left forearm toward camera (foreshortened in 2D)
        // MediaPipe +Y down coordinate system, camera at z_cam = 3.0m
        let z_cam = 3.0f32;
        let f_scale = 0.28f32;
        for f in 0..n {
            let phase = (f as f32) * 0.2;
            let elbow_true = [0.22f32, -0.25, 0.02];
            let wrist_true = [0.24f32, -0.22 + 0.04 * phase.sin(), -0.24f32]; // pointed forward (-Z toward camera, 0.26m forearm)
            let pts: [(usize, [f32; 3], [f32; 3]); 9] = [
                (J_HIPS, [0.0, 0.0, 0.0], [0.0, 0.0, 0.0]),
                (J_L_HIP, [0.10, 0.02, 0.0], [0.10, 0.02, 0.0]),
                (J_R_HIP, [-0.10, 0.02, 0.0], [-0.10, 0.02, 0.0]),
                (J_L_KNEE, [0.10, 0.42, 0.0], [0.10, 0.42, 0.0]),
                (J_R_KNEE, [-0.10, 0.42, 0.0], [-0.10, 0.42, 0.0]),
                (J_L_SHOULDER, [0.18, -0.45, 0.0], [0.18, -0.45, 0.0]),
                (J_R_SHOULDER, [-0.18, -0.45, 0.0], [-0.18, -0.45, 0.0]),
                (J_L_ELBOW, elbow_true, elbow_true),
                // Inject noisy stretched wrist measurement on odd frames
                (
                    J_L_WRIST,
                    wrist_true,
                    [
                        wrist_true[0] + if f % 2 == 1 { 0.09 } else { 0.0 },
                        wrist_true[1] - if f % 2 == 1 { 0.08 } else { 0.0 },
                        wrist_true[2] * 0.4,
                    ],
                ),
            ];
            for (idx, gt, noisy) in pts {
                let b3 = (f * nj + idx) * 4;
                joints[b3] = noisy[0];
                joints[b3 + 1] = noisy[1];
                joints[b3 + 2] = noisy[2];
                joints[b3 + 3] = 0.90;

                // Exact pinhole 2D projection of ground truth
                let denom = z_cam + gt[2];
                let b2 = (f * nj + idx) * 3;
                lm2d[b2] = 0.5 + (gt[0] / denom) / f_scale;
                lm2d[b2 + 1] = 0.5 + (gt[1] / denom) / f_scale;
                lm2d[b2 + 2] = 0.95;
            }
        }

        // Measure noisy error before optimization
        let mut err_before = 0.0f32;
        for f in 0..n {
            let phase = (f as f32) * 0.2;
            let wy_gt = -0.22 + 0.04 * phase.sin();
            let b3 = (f * nj + J_L_WRIST) * 4;
            err_before += ((joints[b3] - 0.24).powi(2) + (joints[b3 + 1] - wy_gt).powi(2)).sqrt();
        }
        err_before /= n as f32;

        let chains = [(J_L_SHOULDER, J_L_ELBOW), (J_L_ELBOW, J_L_WRIST)];
        let bilat = [(J_L_ELBOW, J_L_WRIST, J_R_ELBOW, J_R_WRIST)];
        kinematic_opt::optimize_perspective_2d_3d(
            &mut joints,
            &lm2d,
            &chains,
            &bilat,
            n,
            nj,
            J_HIPS,
            J_L_HIP,
            J_R_HIP,
            J_L_SHOULDER,
            J_R_SHOULDER,
            J_L_KNEE,
            J_R_KNEE,
            0.35,
            1.0,
        );

        let mut err_after = 0.0f32;
        for f in 0..n {
            let phase = (f as f32) * 0.2;
            let wy_gt = -0.22 + 0.04 * phase.sin();
            let b3 = (f * nj + J_L_WRIST) * 4;
            err_after += ((joints[b3] - 0.24).powi(2) + (joints[b3 + 1] - wy_gt).powi(2)).sqrt();
        }
        err_after /= n as f32;
        assert!(
            err_after < err_before * 0.45,
            "Expected kinematic_opt to sharply cut XY reprojection error: before={}, after={}",
            err_before,
            err_after
        );
    }

    #[test]
    fn wide_lunge_foot_lock_never_overextends_or_flips_knee() {
        // Planted foot gets pulled horizontally far beyond max reach (len_u=0.43, len_l=0.42 -> 0.85m):
        // compliant reach clamp must preserve shin/thigh lengths and never collapse or flip knee!
        let n = 20usize;
        let nj = 25usize;
        let mut buf = vec![0.0f32; n * nj * 4];
        let mut root = vec![0.0f32; n * 3];
        for f in 0..n {
            let step_x = if f < 8 { 0.0 } else { ((f - 8) as f32 / 11.0) * 1.15 };
            let mut set = |j: usize, p: [f32; 3]| {
                let b = (f * nj + j) * 4;
                buf[b] = p[0];
                buf[b + 1] = p[1];
                buf[b + 2] = p[2];
                buf[b + 3] = 0.95;
            };
            set(J_HIPS, [step_x, 0.90, 0.0]);
            set(J_L_HIP, [step_x + 0.10, 0.88, 0.0]);
            set(J_R_HIP, [step_x - 0.10, 0.88, 0.0]);
            set(J_L_KNEE, [step_x + 0.10, 0.47, 0.08]);
            set(J_R_KNEE, [step_x - 0.10, 0.47, 0.08]);
            set(J_L_ANKLE, [0.10, 0.05, 0.0]); // planted while hips translate +1.15m in world
            set(J_R_ANKLE, [step_x - 0.10, 0.05, 0.0]);
            set(J_L_FOOT, [0.10, 0.01, 0.14]);
            set(J_R_FOOT, [step_x - 0.10, 0.01, 0.14]);
            root[f * 3] = 0.0;
            root[f * 3 + 1] = 0.0;
            root[f * 3 + 2] = 0.0;
        }
        let mut flags = vec![0u8; n * 2];
        let _locked = filters::apply_foot_lock(
            &mut buf,
            &mut root,
            n,
            nj,
            30.0,
            J_L_HIP,
            J_L_KNEE,
            J_L_ANKLE,
            Some(J_L_FOOT),
            J_R_HIP,
            J_R_KNEE,
            J_R_ANKLE,
            Some(J_R_FOOT),
            1.8,
            0.055,
            2,
            Some(&mut flags),
        );
        for f in 0..n {
            let lh = Vec3::new(buf[(f * nj + J_L_HIP) * 4], buf[(f * nj + J_L_HIP) * 4 + 1], buf[(f * nj + J_L_HIP) * 4 + 2]);
            let lk = Vec3::new(buf[(f * nj + J_L_KNEE) * 4], buf[(f * nj + J_L_KNEE) * 4 + 1], buf[(f * nj + J_L_KNEE) * 4 + 2]);
            let la = Vec3::new(buf[(f * nj + J_L_ANKLE) * 4], buf[(f * nj + J_L_ANKLE) * 4 + 1], buf[(f * nj + J_L_ANKLE) * 4 + 2]);
            let d_u = lk.sub(lh).len();
            let d_l = la.sub(lk).len();
            let d_tot = la.sub(lh).len();
            assert!(d_tot <= (d_u + d_l) * 0.992 + 1e-3, "Frame {f} overextended: tot={d_tot}, u={d_u}, l={d_l}");
            assert!(lk.z >= lh.z - 0.05 && lk.z >= la.z - 0.05, "Frame {f} knee flipped backward: lk.z={}", lk.z);
        }
    }

    #[test]
    fn coupled_grounding_prevents_float_in_stance_and_releases_on_jump() {
        let (slots, meta_base) = make_test_rig_slots();
        let mut meta = [0.0f32; 68];
        meta[..65].copy_from_slice(&meta_base);
        meta[64] = (1 | 4 | 8) as f32; // root_motion | auto_facing | fullbody_ik
        meta[65] = 0.14;
        meta[66] = 0.075;
        meta[67] = 1.0;

        let n = 20usize;
        let nj = 25usize;
        let mut joints = vec![0.0f32; n * nj * 4];
        let mut foot_flags = vec![0u8; n * 2];
        let mut root_traj = vec![0.0f32; n * 3];
        for f in 0..n {
            // Frames 0..10: floating stance (+0.14m in capture) while foot-locked.
            // Frames 10..20: true vertical jump (+0.48m in capture) while unlocked.
            let jump = if f >= 10 { 0.48 } else { 0.14 };
            root_traj[f * 3 + 1] = jump;
            let locked_val = if f < 10 { 1u8 } else { 0u8 };
            foot_flags[f * 2] = locked_val;
            foot_flags[f * 2 + 1] = locked_val;

            let mut set_j = |idx: usize, v: [f32; 3]| {
                let b = (f * nj + idx) * 4;
                joints[b] = v[0];
                joints[b + 1] = v[1] + jump;
                joints[b + 2] = v[2];
                joints[b + 3] = 0.95;
            };
            set_j(J_HIPS, [0.0, 0.95, 0.0]);
            set_j(J_SPINE, [0.0, 1.20, 0.0]);
            set_j(J_NECK, [0.0, 1.42, 0.0]);
            set_j(J_NOSE, [0.0, 1.54, 0.12]);
            set_j(J_L_SHOULDER, [0.18, 1.42, 0.0]);
            set_j(J_L_ELBOW, [0.35, 1.20, 0.05]);
            set_j(J_L_WRIST, [0.42, 1.00, 0.15]);
            set_j(J_R_SHOULDER, [-0.18, 1.42, 0.0]);
            set_j(J_R_ELBOW, [-0.35, 1.20, 0.05]);
            set_j(J_R_WRIST, [-0.42, 1.00, 0.15]);
            set_j(J_L_HIP, [0.10, 0.92, 0.0]);
            set_j(J_L_KNEE, [0.10, 0.50, 0.04]);
            set_j(J_L_ANKLE, [0.10, 0.08, 0.0]);
            set_j(J_L_HEEL, [0.10, 0.02, -0.05]);
            set_j(J_L_FOOT, [0.10, 0.02, 0.14]);
            set_j(J_R_HIP, [-0.10, 0.92, 0.0]);
            set_j(J_R_KNEE, [-0.10, 0.50, 0.04]);
            set_j(J_R_ANKLE, [-0.10, 0.08, 0.0]);
            set_j(J_R_HEEL, [-0.10, 0.02, -0.05]);
            set_j(J_R_FOOT, [-0.10, 0.02, 0.14]);
        }
        let mut q_out = vec![0.0f32; n * N_BONES * 4];
        let mut p_out = vec![0.0f32; n * 3];
        let rc = mk_retarget_humanoid_v2(
            slots.as_ptr(), N_BONES, meta.as_ptr(), meta.len(),
            joints.as_ptr(), root_traj.as_ptr(), foot_flags.as_ptr(),
            n, nj, q_out.as_mut_ptr(), p_out.as_mut_ptr(),
        );
        assert_eq!(rc, 0);

        // Stance hips at f=4 must be lowered cleanly toward bind ~0.95 (not half-dropped or hovering!)
        let stance_hips_y = p_out[4 * 3 + 1];
        assert!(
            stance_hips_y < 1.00,
            "Expected 100% stance pelvis grounding near ~0.95m (was hovering at {stance_hips_y})"
        );
        // Jump hips at f=16 must rise freely above stance height (+0.22m or more)
        let jump_hips_y = p_out[16 * 3 + 1];
        assert!(
            jump_hips_y > stance_hips_y + 0.22,
            "Expected jump to lift hips freely: stance={stance_hips_y}, jump={jump_hips_y}"
        );
    }

    #[test]
    fn disable_grounding_flag_preserves_elevated_hips() {
        let (slots, meta_base) = make_test_rig_slots();
        let mut meta = [0.0f32; 68];
        meta[..65].copy_from_slice(&meta_base);
        meta[64] = (1 | 4 | 16) as f32; // bit 16 = disable_grounding
        meta[65] = 0.14;
        meta[66] = 0.075;
        meta[67] = 0.0;

        let n = 6usize;
        let nj = 25usize;
        let mut joints = vec![0.0f32; n * nj * 4];
        let mut root_traj = vec![0.0f32; n * 3];
        for f in 0..n {
            root_traj[f * 3 + 1] = 0.50; // Stage 1 vertical scale *0.65 -> +0.325m upward offset (~1.275m)
            let mut set_j = |idx: usize, v: [f32; 3]| {
                let b = (f * nj + idx) * 4;
                joints[b] = v[0];
                joints[b + 1] = v[1];
                joints[b + 2] = v[2];
                joints[b + 3] = 0.95;
            };
            set_j(J_HIPS, [0.0, 0.95, 0.0]);
            set_j(J_SPINE, [0.0, 1.20, 0.0]);
            set_j(J_NECK, [0.0, 1.42, 0.0]);
            set_j(J_L_SHOULDER, [0.18, 1.42, 0.0]);
            set_j(J_R_SHOULDER, [-0.18, 1.42, 0.0]);
            set_j(J_L_HIP, [0.10, 0.92, 0.0]);
            set_j(J_L_KNEE, [0.10, 0.50, 0.04]);
            set_j(J_L_ANKLE, [0.10, 0.08, 0.0]);
            set_j(J_R_HIP, [-0.10, 0.92, 0.0]);
            set_j(J_R_KNEE, [-0.10, 0.50, 0.04]);
            set_j(J_R_ANKLE, [-0.10, 0.08, 0.0]);
        }
        let foot_flags = vec![1u8; n * 2];
        let mut q_out = vec![0.0f32; n * N_BONES * 4];
        let mut p_out = vec![0.0f32; n * 3];
        let rc = mk_retarget_humanoid_v2(
            slots.as_ptr(), N_BONES, meta.as_ptr(), meta.len(),
            joints.as_ptr(), root_traj.as_ptr(), foot_flags.as_ptr(),
            n, nj, q_out.as_mut_ptr(), p_out.as_mut_ptr(),
        );
        assert_eq!(rc, 0);
        // With grounding disabled + 35cm upward root motion, hips remain lifted > 1.20m
        assert!(p_out[3 * 3 + 1] > 1.20, "Expected disable_grounding to preserve lifted hips, got {}", p_out[3 * 3 + 1]);
    }

    #[test]
    fn swing_foot_never_pierces_floor_below_toe() {
        let (mut slots, meta_base) = make_test_rig_slots();
        // Match Diag3: ToeBase is at (0, -0.05, 0.14) below Foot (y=0.05 -> toe y=0.00, rest_min_foot_y=0.0)
        // and Foot rest_aim_world points toward ToeBase: normalize(0, -0.05, 0.14)
        for &b in &[B_L_FOOT, B_R_FOOT] {
            let base = b * BONE_SLOT_FLOATS;
            let aim = Vec3::new(0.0, -0.05, 0.14).normalized();
            slots[base + 12] = aim.x;
            slots[base + 13] = aim.y;
            slots[base + 14] = aim.z;
        }
        for &b in &[B_L_TOE, B_R_TOE] {
            let base = b * BONE_SLOT_FLOATS;
            slots[base + 3] = -0.05;
        }
        let mut meta = [0.0f32; 68];
        meta[..65].copy_from_slice(&meta_base);
        meta[56] = 0.0; // rest_min_foot_y = 0.0
        meta[61] = 0.0; // smoothing = 0.0
        meta[64] = (1 | 4 | 8) as f32;
        meta[65] = 0.14;
        meta[66] = 0.075;
        meta[67] = 1.0;

        let n = 4usize;
        let nj = 25usize;
        let mut joints = vec![0.0f32; n * nj * 4];
        let mut foot_flags = vec![0u8; n * 2];
        for f in 0..n {
            foot_flags[f * 2] = 1; // left locked
            foot_flags[f * 2 + 1] = 0; // right unlocked
            let mut set_j = |idx: usize, v: [f32; 3]| {
                let b = (f * nj + idx) * 4;
                joints[b] = v[0];
                joints[b + 1] = v[1];
                joints[b + 2] = v[2];
                joints[b + 3] = 0.95;
            };
            set_j(J_HIPS, [0.0, -0.02945, 0.0]);
            set_j(J_SPINE, [0.0, -0.32195, 0.0]);
            set_j(J_NECK, [0.0, -0.47945, 0.0]);
            set_j(J_NOSE, [0.0, -0.60945, 0.05]);
            set_j(J_L_SHOULDER, [0.18, -0.47945, 0.0]);
            set_j(J_R_SHOULDER, [-0.18, -0.47945, 0.0]);
            set_j(J_L_HIP, [0.10, -0.02945, 0.0]);
            set_j(J_L_KNEE, [0.10, 0.38527, -0.07367]);
            set_j(J_L_ANKLE, [0.10, 0.80315, -0.0015]);
            set_j(J_L_HEEL, [0.10, 0.84, -0.04]);
            set_j(J_L_FOOT, [0.10, 0.81612, 0.13851]);
            set_j(J_R_HIP, [-0.10, -0.02945, 0.0]);
            set_j(J_R_KNEE, [-0.10, 0.25318, -0.00585]);
            set_j(J_R_ANKLE, [-0.10, 0.56594, 0.0243]);
            set_j(J_R_HEEL, [-0.10, 0.60, -0.02]);
            set_j(J_R_FOOT, [-0.10, 0.5219, 0.16629]);
        }
        let root_traj = vec![0.0f32; n * 3];
        let mut q_out = vec![0.0f32; n * N_BONES * 4];
        let mut p_out = vec![0.0f32; n * 3];
        let rc = mk_retarget_humanoid_v2(
            slots.as_ptr(), N_BONES, meta.as_ptr(), meta.len(),
            joints.as_ptr(), root_traj.as_ptr(), foot_flags.as_ptr(),
            n, nj, q_out.as_mut_ptr(), p_out.as_mut_ptr(),
        );
        assert_eq!(rc, 0);

        for f in 0..n {
            let mut m_world = [[0.0f32; 16]; N_BONES];
            for b in 0..N_BONES {
                let sbase = b * BONE_SLOT_FLOATS;
                let parent = slots[sbase + 1].round() as i32;
                let pos = if b == B_HIPS {
                    Vec3::new(p_out[f * 3], p_out[f * 3 + 1], p_out[f * 3 + 2])
                } else {
                    Vec3::new(slots[sbase + 2], slots[sbase + 3], slots[sbase + 4])
                };
                let qb = (f * N_BONES + b) * 4;
                let q = Quat::new(q_out[qb], q_out[qb + 1], q_out[qb + 2], q_out[qb + 3]).normalized();
                let local = crate::math::mat4_compose(pos, q, Vec3::new(1.0, 1.0, 1.0));
                m_world[b] = if parent >= 0 {
                    crate::math::mat4_mul(&m_world[parent as usize], &local)
                } else {
                    local
                };
            }
            let min_y = m_world[B_L_FOOT][13]
                .min(m_world[B_L_TOE][13])
                .min(m_world[B_R_FOOT][13])
                .min(m_world[B_R_TOE][13]);
            eprintln!("f={f} hips_y={:.4} l_ft={:.4} l_toe={:.4} r_ft={:.4} r_toe={:.4}", p_out[f*3+1], m_world[B_L_FOOT][13], m_world[B_L_TOE][13], m_world[B_R_FOOT][13], m_world[B_R_TOE][13]);
            assert!(min_y >= -0.002, "Frame {f} foot/toe pierced floor: min_y={min_y}");
        }
    }
}
