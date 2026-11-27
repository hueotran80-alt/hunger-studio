//! Stackless Register-Based Shader Node VM for Procedural Materials
//! Mirrors GLSL shader-compiler-three output for path-tracing & texture baking parity.

use crate::math::*;
use crate::tex::TexStore;

pub const INSTR_STRIDE: usize = 8;
pub const MAX_REGS: usize = 64;

pub const OP_CONST_VEC4: u32 = 0;
pub const OP_UV: u32 = 1;
pub const OP_NOISE: u32 = 2;
pub const OP_VORONOI: u32 = 3;
pub const OP_COLOR_RAMP: u32 = 4;
pub const OP_MIX: u32 = 5;
pub const OP_MATH: u32 = 6;
pub const OP_FRESNEL: u32 = 7;
pub const OP_LAYER_WEIGHT: u32 = 8;
pub const OP_TEX_IMAGE: u32 = 9;
pub const OP_BUMP: u32 = 10;
pub const OP_NORMAL_MAP: u32 = 11;
pub const OP_SET_OUT: u32 = 12;

pub const NO_REG: u32 = 255;

#[derive(Clone, Default)]
pub struct ShaderProgram {
    /// Flattened instructions: 8 u32 words per instruction.
    pub ops: Vec<u32>,
    /// Float constant pool referenced by instructions.
    pub consts: Vec<f32>,
}

impl ShaderProgram {
    pub fn is_empty(&self) -> bool {
        self.ops.len() < INSTR_STRIDE
    }
}

pub struct VmOutput {
    pub base: V3,
    pub metal: f32,
    pub rough: f32,
    pub emit: V3,
    pub normal: V3,
    pub opacity: f32,
    pub has_normal: bool,
    pub has_base: bool,
    pub has_metal: bool,
    pub has_rough: bool,
    pub has_emit: bool,
    pub has_opacity: bool,
}

#[inline]
fn fade(t: f32) -> f32 {
    t * t * t * (t * (t * 6.0 - 15.0) + 10.0)
}

#[inline]
fn hash2i(ix: i32, iy: i32, seed: u32) -> u32 {
    let mut h = (ix as u32).wrapping_mul(374_761_393)
        ^ (iy as u32).wrapping_mul(668_265_263)
        ^ seed.wrapping_mul(2_246_822_519);
    h = (h ^ (h >> 13)).wrapping_mul(1_274_126_177);
    h ^ (h >> 16)
}

#[inline]
fn grad2(h: u32, dx: f32, dy: f32) -> f32 {
    match h & 7 {
        0 => dx + dy,
        1 => -dx + dy,
        2 => dx - dy,
        3 => -dx - dy,
        4 => dx,
        5 => -dx,
        6 => dy,
        _ => -dy,
    }
}

fn perlin2(x: f32, y: f32, seed: u32) -> f32 {
    let fx = x.floor();
    let fy = y.floor();
    let ix = fx as i32;
    let iy = fy as i32;
    let dx = x - fx;
    let dy = y - fy;
    let u = fade(dx);
    let v = fade(dy);

    let g00 = grad2(hash2i(ix, iy, seed), dx, dy);
    let g10 = grad2(hash2i(ix + 1, iy, seed), dx - 1.0, dy);
    let g01 = grad2(hash2i(ix, iy + 1, seed), dx, dy - 1.0);
    let g11 = grad2(hash2i(ix + 1, iy + 1, seed), dx - 1.0, dy - 1.0);

    let nx0 = g00 + (g10 - g00) * u;
    let nx1 = g01 + (g11 - g01) * u;
    (nx0 + (nx1 - nx0) * v) * 0.5 + 0.5
}

pub fn eval_fbm_noise(u: f32, v: f32, scale: f32, detail: f32, roughness: f32, seed: u32) -> f32 {
    let octs = detail.clamp(1.0, 8.0) as usize;
    let rough = roughness.clamp(0.0, 1.0);
    let mut freq = scale;
    let mut amp = 1.0f32;
    let mut sum = 0.0f32;
    let mut norm = 0.0f32;
    for i in 0..octs {
        sum += perlin2(u * freq, v * freq, seed.wrapping_add(i as u32 * 97)) * amp;
        norm += amp;
        freq *= 2.0;
        amp *= rough;
    }
    if norm > 0.0 {
        (sum / norm).clamp(0.0, 1.0)
    } else {
        0.5
    }
}

pub fn eval_voronoi(u: f32, v: f32, scale: f32, randomness: f32) -> (f32, V3) {
    let px = u * scale;
    let py = v * scale;
    let ix = px.floor() as i32;
    let iy = py.floor() as i32;
    let fx = px - px.floor();
    let fy = py - py.floor();
    let rnd = randomness.clamp(0.0, 1.0);

    let mut min_d2 = f32::INFINITY;
    let mut cell_col = V3::splat(0.5);

    for oy in -1..=1 {
        for ox in -1..=1 {
            let cx = ix + ox;
            let cy = iy + oy;
            let h1 = hash2i(cx, cy, 101);
            let h2 = hash2i(cx, cy, 202);
            let jx = (h1 as f32) / (u32::MAX as f32);
            let jy = (h2 as f32) / (u32::MAX as f32);
            let dx = (ox as f32) + (jx * rnd) - fx;
            let dy = (oy as f32) + (jy * rnd) - fy;
            let d2 = dx * dx + dy * dy;
            if d2 < min_d2 {
                min_d2 = d2;
                let h3 = hash2i(cx, cy, 303);
                cell_col = v3(
                    ((h1 & 0xFFFF) as f32) / 65535.0,
                    ((h2 & 0xFFFF) as f32) / 65535.0,
                    ((h3 & 0xFFFF) as f32) / 65535.0,
                );
            }
        }
    }
    (min_d2.sqrt().clamp(0.0, 1.0), cell_col)
}

#[inline]
fn dielectic_fresnel(cos_t: f32, ior: f32) -> f32 {
    let r0 = ((1.0 - ior) / (1.0 + ior)).powi(2);
    let m = (1.0 - cos_t.clamp(0.0, 1.0)).powi(5);
    (r0 + (1.0 - r0) * m).clamp(0.0, 1.0)
}

#[inline]
fn read_reg_or_const4(regs: &[[f32; 4]; MAX_REGS], consts: &[f32], reg_idx: u32, f_off: usize) -> [f32; 4] {
    if (reg_idx as usize) < MAX_REGS {
        regs[reg_idx as usize]
    } else if f_off + 3 < consts.len() {
        [consts[f_off], consts[f_off + 1], consts[f_off + 2], consts[f_off + 3]]
    } else {
        [0.0, 0.0, 0.0, 1.0]
    }
}

#[inline]
fn read_reg_or_const1(regs: &[[f32; 4]; MAX_REGS], consts: &[f32], reg_idx: u32, f_off: usize) -> f32 {
    if (reg_idx as usize) < MAX_REGS {
        regs[reg_idx as usize][0]
    } else if f_off < consts.len() {
        consts[f_off]
    } else {
        0.0
    }
}

fn eval_prefix(
    prog: &ShaderProgram,
    instr_limit: usize,
    u: f32,
    v: f32,
    u1: f32,
    v1: f32,
    ns: V3,
    t1: V3,
    t2: V3,
    view_dir: V3,
    textures: &TexStore,
    regs: &mut [[f32; 4]; MAX_REGS],
    bump_depth: u32,
) -> Option<VmOutput> {
    let n_instr = (prog.ops.len() / INSTR_STRIDE).min(instr_limit);
    let consts = &prog.consts;
    let cos_nv = ns.dot(view_dir).abs().clamp(0.0, 1.0);

    let mut out = VmOutput {
        base: V3::splat(0.8),
        metal: 0.0,
        rough: 0.5,
        emit: V3::ZERO,
        normal: ns,
        opacity: 1.0,
        has_normal: false,
        has_base: false,
        has_metal: false,
        has_rough: false,
        has_emit: false,
        has_opacity: false,
    };

    for idx in 0..n_instr {
        let base_i = idx * INSTR_STRIDE;
        let op = prog.ops[base_i];
        let dst = prog.ops[base_i + 1] as usize;
        let arg0 = prog.ops[base_i + 2];
        let arg1 = prog.ops[base_i + 3];
        let arg2 = prog.ops[base_i + 4];
        let arg3 = prog.ops[base_i + 5];
        let f_off = prog.ops[base_i + 6] as usize;
        let flags = prog.ops[base_i + 7];

        if op != OP_SET_OUT && dst >= MAX_REGS {
            continue;
        }

        match op {
            OP_CONST_VEC4 => {
                if f_off + 3 < consts.len() {
                    regs[dst] = [consts[f_off], consts[f_off + 1], consts[f_off + 2], consts[f_off + 3]];
                }
            }
            OP_UV => {
                let (su, sv) = if flags == 1 { (u1, v1) } else { (u, v) };
                if f_off + 3 < consts.len() {
                    regs[dst] = [
                        su * consts[f_off] + consts[f_off + 2],
                        sv * consts[f_off + 1] + consts[f_off + 3],
                        0.0,
                        1.0,
                    ];
                } else {
                    regs[dst] = [su, sv, 0.0, 1.0];
                }
            }
            OP_NOISE => {
                let vec = read_reg_or_const4(regs, consts, arg0, f_off + 4);
                let (cu, cv) = if (arg0 as usize) < MAX_REGS { (vec[0], vec[1]) } else { (u, v) };
                let scale = consts.get(f_off).copied().unwrap_or(6.0);
                let detail = consts.get(f_off + 1).copied().unwrap_or(4.0);
                let rough = consts.get(f_off + 2).copied().unwrap_or(0.5);
                let seed = consts.get(f_off + 3).copied().unwrap_or(42.0) as u32;
                let n = eval_fbm_noise(cu, cv, scale, detail, rough, seed);
                regs[dst] = [n, n, n, 1.0];
            }
            OP_VORONOI => {
                let vec = read_reg_or_const4(regs, consts, arg0, f_off + 2);
                let (cu, cv) = if (arg0 as usize) < MAX_REGS { (vec[0], vec[1]) } else { (u, v) };
                let scale = consts.get(f_off).copied().unwrap_or(6.0);
                let rnd = consts.get(f_off + 1).copied().unwrap_or(1.0);
                let (dist, col) = eval_voronoi(cu, cv, scale, rnd);
                regs[dst] = [dist, dist, dist, 1.0];
                if (arg1 as usize) < MAX_REGS {
                    regs[arg1 as usize] = [col.x, col.y, col.z, 1.0];
                }
            }
            OP_COLOR_RAMP => {
                let fac = read_reg_or_const1(regs, consts, arg0, f_off).clamp(0.0, 1.0);
                let count = (flags as usize).max(1);
                let base_c = f_off + 1;
                if base_c + count * 5 <= consts.len() {
                    let mut out_c = [consts[base_c + 1], consts[base_c + 2], consts[base_c + 3], consts[base_c + 4]];
                    for s in 0..count {
                        let p0 = consts[base_c + s * 5];
                        if s == 0 && fac <= p0 {
                            out_c = [consts[base_c + 1], consts[base_c + 2], consts[base_c + 3], consts[base_c + 4]];
                            break;
                        }
                        if s + 1 < count {
                            let p1 = consts[base_c + (s + 1) * 5];
                            if fac <= p1 {
                                let t = if (p1 - p0).abs() > 1e-6 { ((fac - p0) / (p1 - p0)).clamp(0.0, 1.0) } else { 0.0 };
                                let o0 = base_c + s * 5 + 1;
                                let o1 = base_c + (s + 1) * 5 + 1;
                                out_c = [
                                    consts[o0] + (consts[o1] - consts[o0]) * t,
                                    consts[o0 + 1] + (consts[o1 + 1] - consts[o0 + 1]) * t,
                                    consts[o0 + 2] + (consts[o1 + 2] - consts[o0 + 2]) * t,
                                    consts[o0 + 3] + (consts[o1 + 3] - consts[o0 + 3]) * t,
                                ];
                                break;
                            }
                        } else {
                            let o0 = base_c + s * 5 + 1;
                            out_c = [consts[o0], consts[o0 + 1], consts[o0 + 2], consts[o0 + 3]];
                        }
                    }
                    regs[dst] = out_c;
                }
            }
            OP_MIX => {
                let fac = read_reg_or_const1(regs, consts, arg0, f_off);
                let ca = read_reg_or_const4(regs, consts, arg1, f_off + 1);
                let cb = read_reg_or_const4(regs, consts, arg2, f_off + 5);
                let t = if (flags & 256) != 0 { fac.clamp(0.0, 1.0) } else { fac };
                let mode = flags & 0xFF;
                let mut res = [0.0f32; 4];
                for c in 0..3 {
                    let mixed = match mode {
                        1 => ca[c] * (1.0 - t + t * cb[c]),
                        2 => ca[c] + cb[c] * t,
                        3 => {
                            let scr = 1.0 - (1.0 - ca[c]) * (1.0 - cb[c]);
                            ca[c] + (scr - ca[c]) * t
                        }
                        _ => ca[c] + (cb[c] - ca[c]) * t,
                    };
                    res[c] = if (flags & 256) != 0 { mixed.clamp(0.0, 1.0) } else { mixed };
                }
                res[3] = 1.0;
                regs[dst] = res;
            }
            OP_MATH => {
                let a = read_reg_or_const1(regs, consts, arg0, f_off);
                let b = read_reg_or_const1(regs, consts, arg1, f_off + 1);
                let mode = flags & 0xFF;
                let mut val = match mode {
                    0 => a + b,
                    1 => a - b,
                    2 => a * b,
                    3 => if b.abs() > 1e-6 { a / b } else { 0.0 },
                    4 => a.max(0.0).powf(b),
                    5 => a.sin(),
                    6 => a.min(b),
                    7 => a.max(b),
                    8 => if a < b { 1.0 } else { 0.0 },
                    9 => {
                        let k = read_reg_or_const1(regs, consts, arg2, f_off + 2).max(1e-5);
                        let h = (k - (a - b).abs()).max(0.0) / k;
                        a.min(b) - h * h * k * 0.25
                    }
                    10 => {
                        let c = read_reg_or_const1(regs, consts, arg2, f_off + 2);
                        a * b + c
                    }
                    _ => a + b,
                };
                if (flags & 256) != 0 {
                    val = val.clamp(0.0, 1.0);
                }
                regs[dst] = [val, val, val, 1.0];
            }
            OP_FRESNEL => {
                let ior = read_reg_or_const1(regs, consts, arg0, f_off).max(1.0);
                let f = dielectic_fresnel(cos_nv, ior);
                regs[dst] = [f, f, f, 1.0];
            }
            OP_LAYER_WEIGHT => {
                let blend = read_reg_or_const1(regs, consts, arg0, f_off).clamp(0.0, 0.999);
                let facing = 1.0 - cos_nv.powf(if blend < 0.5 { 2.0 * blend.max(1e-3) } else { 0.5 / (1.0 - blend).max(1e-3) });
                let eta = 1.0 / (1.0 - blend).max(1e-3);
                let fresnel = dielectic_fresnel(cos_nv, eta);
                regs[dst] = [fresnel, fresnel, fresnel, 1.0];
                if (arg1 as usize) < MAX_REGS {
                    regs[arg1 as usize] = [facing, facing, facing, 1.0];
                }
            }
            OP_TEX_IMAGE => {
                let vec = read_reg_or_const4(regs, consts, arg0, f_off);
                let (cu, cv) = if (arg0 as usize) < MAX_REGS { (vec[0], vec[1]) } else { (u, v) };
                let tex_id = flags as i32;
                let smp = textures.sample(tex_id, cu, cv).unwrap_or([1.0, 1.0, 1.0, 1.0]);
                regs[dst] = smp;
                if (arg1 as usize) < MAX_REGS {
                    regs[arg1 as usize] = [smp[3], smp[3], smp[3], 1.0];
                }
            }
            OP_BUMP => {
                // arg0: height reg, arg1: strength reg/NO_REG, arg2: height_eval_end_idx, arg3: distance const fallback offset in f_off
                let strength = read_reg_or_const1(regs, consts, arg1, f_off).clamp(0.0, 4.0);
                let dist = consts.get(f_off + 1).copied().unwrap_or(0.05);
                let h0 = read_reg_or_const1(regs, consts, arg0, f_off + 2);
                let mut mapped = ns;
                if bump_depth == 0 && (arg0 as usize) < MAX_REGS && strength > 1e-4 {
                    let eps_uv = 0.002f32;
                    let sub_end = (arg2 as usize).min(idx);
                    let mut regs_dx = [[0.0f32; 4]; MAX_REGS];
                    let mut regs_dy = [[0.0f32; 4]; MAX_REGS];
                    eval_prefix(prog, sub_end, u + eps_uv, v, u1 + eps_uv, v1, ns, t1, t2, view_dir, textures, &mut regs_dx, 1);
                    eval_prefix(prog, sub_end, u, v + eps_uv, u1, v1 + eps_uv, ns, t1, t2, view_dir, textures, &mut regs_dy, 1);
                    let hx = regs_dx[arg0 as usize][0];
                    let hy = regs_dy[arg0 as usize][0];
                    let dhdu = (hx - h0) / eps_uv;
                    let dhdv = (hy - h0) / eps_uv;
                    let scale = strength * dist;
                    mapped = (ns - t1 * (dhdu * scale * 0.02) - t2 * (dhdv * scale * 0.02)).norm();
                }
                regs[dst] = [mapped.x, mapped.y, mapped.z, 1.0];
            }
            OP_NORMAL_MAP => {
                let nc = read_reg_or_const4(regs, consts, arg0, f_off + 1);
                let strength = read_reg_or_const1(regs, consts, arg1, f_off).max(0.0);
                let nx = (nc[0] * 2.0 - 1.0) * strength;
                let ny = (nc[1] * 2.0 - 1.0) * strength;
                let nz = (nc[2] * 2.0 - 1.0).max(0.05);
                let mapped = (t1 * nx + t2 * ny + ns * nz).norm();
                regs[dst] = [mapped.x, mapped.y, mapped.z, 1.0];
            }
            OP_SET_OUT => {
                match flags {
                    0 => {
                        let c = read_reg_or_const4(regs, consts, arg0, f_off);
                        out.base = v3(c[0].max(0.0), c[1].max(0.0), c[2].max(0.0));
                        out.has_base = true;
                    }
                    1 => {
                        out.metal = read_reg_or_const1(regs, consts, arg0, f_off).clamp(0.0, 1.0);
                        out.has_metal = true;
                    }
                    2 => {
                        out.rough = read_reg_or_const1(regs, consts, arg0, f_off).clamp(0.04, 1.0);
                        out.has_rough = true;
                    }
                    3 => {
                        let ec = read_reg_or_const4(regs, consts, arg0, f_off);
                        let es = read_reg_or_const1(regs, consts, arg1, f_off + 4).max(0.0);
                        out.emit = v3(ec[0] * es, ec[1] * es, ec[2] * es);
                        out.has_emit = true;
                    }
                    4 => {
                        if (arg0 as usize) < MAX_REGS {
                            let n = regs[arg0 as usize];
                            let v = v3(n[0], n[1], n[2]);
                            if v.dot(v) > 1e-6 {
                                out.normal = v.norm();
                                out.has_normal = true;
                            }
                        }
                    }
                    5 => {
                        out.opacity = read_reg_or_const1(regs, consts, arg0, f_off).clamp(0.0, 1.0);
                        out.has_opacity = true;
                    }
                    _ => {}
                }
            }
            _ => {}
        }
        let _ = arg3;
    }

    Some(out)
}

pub fn eval_graph(
    prog: &ShaderProgram,
    u: f32,
    v: f32,
    u1: f32,
    v1: f32,
    ns: V3,
    t1: V3,
    t2: V3,
    view_dir: V3,
    textures: &TexStore,
) -> Option<VmOutput> {
    if prog.is_empty() {
        return None;
    }
    let mut regs = [[0.0f32; 4]; MAX_REGS];
    eval_prefix(
        prog,
        prog.ops.len() / INSTR_STRIDE,
        u,
        v,
        u1,
        v1,
        ns,
        t1,
        t2,
        view_dir,
        textures,
        &mut regs,
        0,
    )
}
