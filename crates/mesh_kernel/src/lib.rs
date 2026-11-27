use std::cell::UnsafeCell;
use std::cmp::Ordering;
use std::collections::{BinaryHeap, HashMap};
use std::slice;

pub mod importers;

#[no_mangle]
pub extern "C" fn mesh_kernel_version() -> u32 {
    210
}

/// Allocate 4-byte aligned memory buffer in WASM memory from JavaScript
#[no_mangle]
pub extern "C" fn mesh_kernel_alloc(size: usize) -> *mut u8 {
    let words = (size.max(1) + 3) / 4;
    let mut buf = Vec::<u32>::with_capacity(words);
    let ptr = buf.as_mut_ptr() as *mut u8;
    std::mem::forget(buf);
    ptr
}

/// Free memory buffer previously allocated by mesh_kernel_alloc
#[no_mangle]
pub extern "C" fn mesh_kernel_free(ptr: *mut u8, size: usize) {
    if !ptr.is_null() && size > 0 {
        let words = (size + 3) / 4;
        unsafe {
            let _ = Vec::from_raw_parts(ptr as *mut u32, 0, words);
        }
    }
}

// ---------------------------------------------------------------------------
// Thread-local / Single-threaded WASM Output Buffers
// ---------------------------------------------------------------------------

struct OutputBuffers {
    vertices: Vec<f32>,
    indices: Vec<u32>,
    edges: Vec<u32>,
    normals: Vec<f32>,
    map: Vec<u32>,
    uvs: Vec<f32>,
    matrices: Vec<f32>,
    lod_counts: [u32; 4],
}

struct SyncBuffers(UnsafeCell<OutputBuffers>);
unsafe impl Sync for SyncBuffers {}

static BUFFERS: SyncBuffers = SyncBuffers(UnsafeCell::new(OutputBuffers {
    vertices: Vec::new(),
    indices: Vec::new(),
    edges: Vec::new(),
    normals: Vec::new(),
    map: Vec::new(),
    uvs: Vec::new(),
    matrices: Vec::new(),
    lod_counts: [0; 4],
}));

#[inline(always)]
fn get_buffers_mut() -> &'static mut OutputBuffers {
    unsafe { &mut *BUFFERS.0.get() }
}

#[inline(always)]
fn get_buffers() -> &'static OutputBuffers {
    unsafe { &*BUFFERS.0.get() }
}

#[no_mangle]
pub extern "C" fn mesh_kernel_get_out_vertices_ptr() -> *const f32 {
    get_buffers().vertices.as_ptr()
}
#[no_mangle]
pub extern "C" fn mesh_kernel_get_out_vertices_len() -> usize {
    get_buffers().vertices.len()
}

#[no_mangle]
pub extern "C" fn mesh_kernel_get_out_indices_ptr() -> *const u32 {
    get_buffers().indices.as_ptr()
}
#[no_mangle]
pub extern "C" fn mesh_kernel_get_out_indices_len() -> usize {
    get_buffers().indices.len()
}

#[no_mangle]
pub extern "C" fn mesh_kernel_get_out_edges_ptr() -> *const u32 {
    get_buffers().edges.as_ptr()
}
#[no_mangle]
pub extern "C" fn mesh_kernel_get_out_edges_len() -> usize {
    get_buffers().edges.len()
}

#[no_mangle]
pub extern "C" fn mesh_kernel_get_out_normals_ptr() -> *const f32 {
    get_buffers().normals.as_ptr()
}
#[no_mangle]
pub extern "C" fn mesh_kernel_get_out_normals_len() -> usize {
    get_buffers().normals.len()
}

#[no_mangle]
pub extern "C" fn mesh_kernel_get_out_map_ptr() -> *const u32 {
    get_buffers().map.as_ptr()
}
#[no_mangle]
pub extern "C" fn mesh_kernel_get_out_map_len() -> usize {
    get_buffers().map.len()
}

#[no_mangle]
pub extern "C" fn mesh_kernel_get_out_uvs_ptr() -> *const f32 {
    get_buffers().uvs.as_ptr()
}
#[no_mangle]
pub extern "C" fn mesh_kernel_get_out_uvs_len() -> usize {
    get_buffers().uvs.len()
}

#[no_mangle]
pub extern "C" fn mesh_kernel_get_out_matrices_ptr() -> *const f32 {
    get_buffers().matrices.as_ptr()
}
#[no_mangle]
pub extern "C" fn mesh_kernel_get_out_matrices_len() -> usize {
    get_buffers().matrices.len()
}

#[no_mangle]
pub extern "C" fn mesh_kernel_get_out_lod_counts_ptr() -> *const u32 {
    get_buffers().lod_counts.as_ptr()
}

// ---------------------------------------------------------------------------
// Spatial Hash Key for Vertex Welding
// ---------------------------------------------------------------------------

#[inline(always)]
fn quantize_coord(val: f32, inv_tol: f32) -> i32 {
    (val * inv_tol).round() as i32
}

#[inline(always)]
fn hash_key(ix: i32, iy: i32, iz: i32) -> u64 {
    let x = (ix as i64) & 0x1FFFFF;
    let y = (iy as i64) & 0x1FFFFF;
    let z = (iz as i64) & 0x1FFFFF;
    ((x << 42) ^ (y << 21) ^ z) as u64
}

// ---------------------------------------------------------------------------
// Vertex Welding & Fast Topology Extraction
// ---------------------------------------------------------------------------

#[no_mangle]
pub extern "C" fn mesh_kernel_weld(
    pos_ptr: *const f32,
    pos_len: usize,
    index_ptr: *const u32,
    index_len: usize,
    tolerance: f32,
) -> u32 {
    if pos_ptr.is_null() || pos_len < 3 {
        return 0;
    }

    let positions = unsafe { slice::from_raw_parts(pos_ptr, pos_len) };
    let num_verts = pos_len / 3;
    let inv_tol = if tolerance > 0.0 { 1.0 / tolerance } else { 10000.0 };

    let mut welded_vertices: Vec<f32> = Vec::with_capacity(pos_len);
    let mut out_map: Vec<u32> = Vec::with_capacity(num_verts);
    let mut coord_map: HashMap<u64, u32> = HashMap::with_capacity(num_verts);

    for i in 0..num_verts {
        let x = positions[i * 3];
        let y = positions[i * 3 + 1];
        let z = positions[i * 3 + 2];

        let ix = quantize_coord(x, inv_tol);
        let iy = quantize_coord(y, inv_tol);
        let iz = quantize_coord(z, inv_tol);
        let key = hash_key(ix, iy, iz);

        if let Some(&existing_idx) = coord_map.get(&key) {
            out_map.push(existing_idx);
        } else {
            let new_idx = (welded_vertices.len() / 3) as u32;
            welded_vertices.push(x);
            welded_vertices.push(y);
            welded_vertices.push(z);
            coord_map.insert(key, new_idx);
            out_map.push(new_idx);
        }
    }

    // Process indices
    let mut welded_indices: Vec<u32> = Vec::new();
    let num_tris = if !index_ptr.is_null() && index_len >= 3 {
        let indices = unsafe { slice::from_raw_parts(index_ptr, index_len) };
        welded_indices.reserve(index_len);
        let count = index_len / 3;
        for t in 0..count {
            let i0 = indices[t * 3] as usize;
            let i1 = indices[t * 3 + 1] as usize;
            let i2 = indices[t * 3 + 2] as usize;

            let w0 = if i0 < out_map.len() { out_map[i0] } else { i0 as u32 };
            let w1 = if i1 < out_map.len() { out_map[i1] } else { i1 as u32 };
            let w2 = if i2 < out_map.len() { out_map[i2] } else { i2 as u32 };

            if w0 != w1 && w1 != w2 && w2 != w0 {
                welded_indices.push(w0);
                welded_indices.push(w1);
                welded_indices.push(w2);
            }
        }
        welded_indices.len() / 3
    } else {
        let count = num_verts / 3;
        welded_indices.reserve(count * 3);
        for t in 0..count {
            let w0 = out_map[t * 3];
            let w1 = out_map[t * 3 + 1];
            let w2 = out_map[t * 3 + 2];
            if w0 != w1 && w1 != w2 && w2 != w0 {
                welded_indices.push(w0);
                welded_indices.push(w1);
                welded_indices.push(w2);
            }
        }
        welded_indices.len() / 3
    };

    // Extract unique edges (v0 < v1) using 64-bit key
    let mut edge_map: HashMap<u64, ()> = HashMap::with_capacity(num_tris * 3);
    let mut unique_edges: Vec<u32> = Vec::with_capacity(num_tris * 3 * 2);

    let tri_count = welded_indices.len() / 3;
    for t in 0..tri_count {
        let i0 = welded_indices[t * 3];
        let i1 = welded_indices[t * 3 + 1];
        let i2 = welded_indices[t * 3 + 2];

        let pairs = [(i0, i1), (i1, i2), (i2, i0)];
        for (u, v) in pairs {
            let (v0, v1) = if u < v { (u, v) } else { (v, u) };
            let ekey = ((v0 as u64) << 32) | (v1 as u64);
            if edge_map.insert(ekey, ()).is_none() {
                unique_edges.push(v0);
                unique_edges.push(v1);
            }
        }
    }

    // Compute face normals
    let mut normals: Vec<f32> = Vec::with_capacity(tri_count * 3);
    for t in 0..tri_count {
        let i0 = welded_indices[t * 3] as usize;
        let i1 = welded_indices[t * 3 + 1] as usize;
        let i2 = welded_indices[t * 3 + 2] as usize;

        let ax = welded_vertices[i0 * 3];
        let ay = welded_vertices[i0 * 3 + 1];
        let az = welded_vertices[i0 * 3 + 2];

        let bx = welded_vertices[i1 * 3];
        let by = welded_vertices[i1 * 3 + 1];
        let bz = welded_vertices[i1 * 3 + 2];

        let cx = welded_vertices[i2 * 3];
        let cy = welded_vertices[i2 * 3 + 1];
        let cz = welded_vertices[i2 * 3 + 2];

        let abx = bx - ax;
        let aby = by - ay;
        let abz = bz - az;

        let acx = cx - ax;
        let acy = cy - ay;
        let acz = cz - az;

        let mut nx = aby * acz - abz * acy;
        let mut ny = abz * acx - abx * acz;
        // nz = (ab x ac).z = abx * acy - aby * acx
        let mut nz = abx * acy - aby * acx;

        let len = (nx * nx + ny * ny + nz * nz).sqrt();
        if len > 1e-6 {
            nx /= len;
            ny /= len;
            nz /= len;
        }

        normals.push(nx);
        normals.push(ny);
        normals.push(nz);
    }

    let buf = get_buffers_mut();
    buf.vertices = welded_vertices;
    buf.indices = welded_indices;
    buf.edges = unique_edges;
    buf.normals = normals;
    buf.map = out_map;

    1
}

// ---------------------------------------------------------------------------
// Linear / Loop Subdivision
// ---------------------------------------------------------------------------

#[no_mangle]
pub extern "C" fn mesh_kernel_subdivide(
    pos_ptr: *const f32,
    pos_len: usize,
    index_ptr: *const u32,
    index_len: usize,
    smooth: u32,
) -> u32 {
    if pos_ptr.is_null() || pos_len < 3 || index_ptr.is_null() || index_len < 3 {
        return 0;
    }

    let positions = unsafe { slice::from_raw_parts(pos_ptr, pos_len) };
    let indices = unsafe { slice::from_raw_parts(index_ptr, index_len) };
    let num_verts = pos_len / 3;
    let num_tris = index_len / 3;

    let mut new_verts = positions.to_vec();
    new_verts.reserve(num_verts * 3 + num_tris * 3 * 3);

    let mut edge_midpoints: HashMap<u64, u32> = HashMap::with_capacity(num_tris * 3);
    let mut new_indices: Vec<u32> = Vec::with_capacity(num_tris * 4 * 3);

    let mut get_midpoint = |u: u32, v: u32, verts: &mut Vec<f32>| -> u32 {
        let (v0, v1) = if u < v { (u, v) } else { (v, u) };
        let ekey = ((v0 as u64) << 32) | (v1 as u64);

        if let Some(&mid_idx) = edge_midpoints.get(&ekey) {
            mid_idx
        } else {
            let mid_idx = (verts.len() / 3) as u32;
            let i0 = v0 as usize * 3;
            let i1 = v1 as usize * 3;

            let mx = (verts[i0] + verts[i1]) * 0.5;
            let my = (verts[i0 + 1] + verts[i1 + 1]) * 0.5;
            let mz = (verts[i0 + 2] + verts[i1 + 2]) * 0.5;

            verts.push(mx);
            verts.push(my);
            verts.push(mz);

            edge_midpoints.insert(ekey, mid_idx);
            mid_idx
        }
    };

    for t in 0..num_tris {
        let v0 = indices[t * 3];
        let v1 = indices[t * 3 + 1];
        let v2 = indices[t * 3 + 2];

        let m01 = get_midpoint(v0, v1, &mut new_verts);
        let m12 = get_midpoint(v1, v2, &mut new_verts);
        let m20 = get_midpoint(v2, v0, &mut new_verts);

        new_indices.push(v0);
        new_indices.push(m01);
        new_indices.push(m20);

        new_indices.push(m01);
        new_indices.push(v1);
        new_indices.push(m12);

        new_indices.push(m20);
        new_indices.push(m12);
        new_indices.push(v2);

        new_indices.push(m01);
        new_indices.push(m12);
        new_indices.push(m20);
    }

    if smooth > 0 {
        let total_verts = new_verts.len() / 3;
        let mut neighbors: Vec<Vec<u32>> = vec![Vec::new(); total_verts];
        let tri_count = new_indices.len() / 3;

        for t in 0..tri_count {
            let a = new_indices[t * 3];
            let b = new_indices[t * 3 + 1];
            let c = new_indices[t * 3 + 2];

            neighbors[a as usize].push(b);
            neighbors[a as usize].push(c);
            neighbors[b as usize].push(a);
            neighbors[b as usize].push(c);
            neighbors[c as usize].push(a);
            neighbors[c as usize].push(b);
        }

        let mut smoothed = new_verts.clone();
        for i in num_verts..total_verts {
            let n_list = &neighbors[i];
            if !n_list.is_empty() {
                let mut sx = 0.0;
                let mut sy = 0.0;
                let mut sz = 0.0;
                for &nb in n_list {
                    sx += new_verts[nb as usize * 3];
                    sy += new_verts[nb as usize * 3 + 1];
                    sz += new_verts[nb as usize * 3 + 2];
                }
                let count = n_list.len() as f32;
                smoothed[i * 3] = new_verts[i * 3] * 0.5 + (sx / count) * 0.5;
                smoothed[i * 3 + 1] = new_verts[i * 3 + 1] * 0.5 + (sy / count) * 0.5;
                smoothed[i * 3 + 2] = new_verts[i * 3 + 2] * 0.5 + (sz / count) * 0.5;
            }
        }
        new_verts = smoothed;
    }

    let tri_count = new_indices.len() / 3;
    let mut edge_map: HashMap<u64, ()> = HashMap::with_capacity(tri_count * 3);
    let mut unique_edges: Vec<u32> = Vec::with_capacity(tri_count * 3 * 2);

    for t in 0..tri_count {
        let i0 = new_indices[t * 3];
        let i1 = new_indices[t * 3 + 1];
        let i2 = new_indices[t * 3 + 2];

        let pairs = [(i0, i1), (i1, i2), (i2, i0)];
        for (u, v) in pairs {
            let (v0, v1) = if u < v { (u, v) } else { (v, u) };
            let ekey = ((v0 as u64) << 32) | (v1 as u64);
            if edge_map.insert(ekey, ()).is_none() {
                unique_edges.push(v0);
                unique_edges.push(v1);
            }
        }
    }

    let buf = get_buffers_mut();
    buf.vertices = new_verts;
    buf.indices = new_indices;
    buf.edges = unique_edges;

    1
}

// ---------------------------------------------------------------------------
// Sculpt 2.0 High-Speed WASM Stroke Evaluator
// ---------------------------------------------------------------------------

#[no_mangle]
pub extern "C" fn mesh_kernel_sculpt_stroke(
    pos_ptr: *mut f32,
    norm_ptr: *mut f32,
    mask_ptr: *mut f32,
    base_pos_ptr: *const f32,
    vert_count: usize,
    cand_ptr: *const u32,
    cand_len: usize,
    brush_id: u32,
    cx: f32,
    cy: f32,
    cz: f32,
    nx: f32,
    ny: f32,
    nz: f32,
    dx: f32,
    dy: f32,
    dz: f32,
    radius: f32,
    strength: f32,
    dir: f32,
) -> u32 {
    if pos_ptr.is_null() || vert_count == 0 || radius <= 1e-6 {
        return 0;
    }

    let total_floats = vert_count * 3;
    let positions = unsafe { slice::from_raw_parts_mut(pos_ptr, total_floats) };
    let normals: Option<&[f32]> = if !norm_ptr.is_null() {
        Some(unsafe { slice::from_raw_parts(norm_ptr, total_floats) })
    } else {
        None
    };
    let mut mask_slice: Option<&mut [f32]> = if !mask_ptr.is_null() {
        Some(unsafe { slice::from_raw_parts_mut(mask_ptr, vert_count) })
    } else {
        None
    };
    let base_pos: Option<&[f32]> = if !base_pos_ptr.is_null() {
        Some(unsafe { slice::from_raw_parts(base_pos_ptr, total_floats) })
    } else {
        None
    };
    let candidates: Option<&[u32]> = if !cand_ptr.is_null() && cand_len > 0 {
        Some(unsafe { slice::from_raw_parts(cand_ptr, cand_len) })
    } else {
        None
    };

    let radius_sq = radius * radius;
    let strength_factor = strength * 0.15 * radius;
    let inv_radius = 1.0 / radius;

    // Normalize reference normal once
    let n_len = (nx * nx + ny * ny + nz * nz).sqrt();
    let (nnx, nny, nnz) = if n_len > 1e-6 {
        (nx / n_len, ny / n_len, nz / n_len)
    } else {
        (0.0, 1.0, 0.0)
    };

    // Pass 1 for Smooth (3) or Flatten (4): neighborhood centroid inside radius
    let mut avg_x = cx;
    let mut avg_y = cy;
    let mut avg_z = cz;
    if brush_id == 3 || brush_id == 4 {
        let mut sx = 0.0_f64;
        let mut sy = 0.0_f64;
        let mut sz = 0.0_f64;
        let mut count = 0_usize;

        let count_loop = if let Some(cands) = candidates {
            cands.len()
        } else {
            vert_count
        };
        for k in 0..count_loop {
            let vi = if let Some(cands) = candidates {
                cands[k] as usize
            } else {
                k
            };
            if vi >= vert_count {
                continue;
            }
            let base = vi * 3;
            let px = positions[base];
            let py = positions[base + 1];
            let pz = positions[base + 2];
            if (px - cx).abs() > radius || (py - cy).abs() > radius || (pz - cz).abs() > radius {
                continue;
            }
            let ddx = px - cx;
            let ddy = py - cy;
            let ddz = pz - cz;
            if ddx * ddx + ddy * ddy + ddz * ddz < radius_sq {
                sx += px as f64;
                sy += py as f64;
                sz += pz as f64;
                count += 1;
            }
        }
        if count > 0 {
            let inv_c = 1.0 / (count as f64);
            avg_x = (sx * inv_c) as f32;
            avg_y = (sy * inv_c) as f32;
            avg_z = (sz * inv_c) as f32;
        }
    }

    let mut modified: u32 = 0;
    let loop_len = if let Some(cands) = candidates {
        cands.len()
    } else {
        vert_count
    };

    for k in 0..loop_len {
        let vi = if let Some(cands) = candidates {
            cands[k] as usize
        } else {
            k
        };
        if vi >= vert_count {
            continue;
        }
        let idx = vi * 3;

        // Grab with base_pos anchors influence radius to stroke start positions
        let (rx, ry, rz) = if brush_id == 1 {
            if let Some(bp) = base_pos {
                (bp[idx], bp[idx + 1], bp[idx + 2])
            } else {
                (positions[idx], positions[idx + 1], positions[idx + 2])
            }
        } else {
            (positions[idx], positions[idx + 1], positions[idx + 2])
        };

        if (rx - cx).abs() > radius || (ry - cy).abs() > radius || (rz - cz).abs() > radius {
            continue;
        }
        let off_x = rx - cx;
        let off_y = ry - cy;
        let off_z = rz - cz;
        let dist_sq = off_x * off_x + off_y * off_y + off_z * off_z;
        if dist_sq >= radius_sq {
            continue;
        }

        let dist = dist_sq.sqrt();
        let norm_dist = dist * inv_radius;
        let one_minus_d2 = 1.0 - norm_dist * norm_dist;
        let falloff = one_minus_d2 * one_minus_d2;

        // Brush 9: Mask painting
        if brush_id == 9 {
            if let Some(ref mut m_arr) = mask_slice {
                let next_m = (m_arr[vi] + dir * falloff * strength * 0.5).clamp(0.0, 1.0);
                m_arr[vi] = next_m;
                modified += 1;
            }
            continue;
        }

        let mask_val = if let Some(ref m_arr) = mask_slice {
            m_arr[vi].clamp(0.0, 1.0)
        } else {
            0.0
        };
        if mask_val >= 0.999 {
            continue;
        }
        let mask_att = 1.0 - mask_val;
        let w = falloff * mask_att;

        match brush_id {
            0 => {
                // Draw
                let scale = dir * w * strength_factor;
                positions[idx] += nnx * scale;
                positions[idx + 1] += nny * scale;
                positions[idx + 2] += nnz * scale;
                modified += 1;
            }
            1 => {
                // Grab
                if let Some(bp) = base_pos {
                    positions[idx] = bp[idx] + dx * w;
                    positions[idx + 1] = bp[idx + 1] + dy * w;
                    positions[idx + 2] = bp[idx + 2] + dz * w;
                } else {
                    positions[idx] += dx * w;
                    positions[idx + 1] += dy * w;
                    positions[idx + 2] += dz * w;
                }
                modified += 1;
            }
            2 => {
                // Inflate along vertex normal
                let (vnx, vny, vnz) = if let Some(ns) = normals {
                    (ns[idx], ns[idx + 1], ns[idx + 2])
                } else {
                    (nnx, nny, nnz)
                };
                let scale = dir * w * strength_factor;
                positions[idx] += vnx * scale;
                positions[idx + 1] += vny * scale;
                positions[idx + 2] += vnz * scale;
                modified += 1;
            }
            3 => {
                // Smooth toward neighbor centroid
                let t = (w * strength * 0.4).clamp(0.0, 1.0);
                positions[idx] += (avg_x - rx) * t;
                positions[idx + 1] += (avg_y - ry) * t;
                positions[idx + 2] += (avg_z - rz) * t;
                modified += 1;
            }
            4 => {
                // Flatten toward local mean plane
                let dist_to_plane = (rx - avg_x) * nnx + (ry - avg_y) * nny + (rz - avg_z) * nnz;
                let t = (w * strength * 0.5).clamp(0.0, 1.0);
                positions[idx] -= nnx * dist_to_plane * t;
                positions[idx + 1] -= nny * dist_to_plane * t;
                positions[idx + 2] -= nnz * dist_to_plane * t;
                modified += 1;
            }
            5 => {
                // Clay Strips plateau
                let strip_falloff = (1.0 - norm_dist * norm_dist * norm_dist).max(0.0) * mask_att;
                let plane_offset = dir * radius * 0.15;
                let dist_to_plane =
                    ((rx - cx) * nnx + (ry - cy) * nny + (rz - cz) * nnz) - plane_offset;
                let t = (strip_falloff * strength * 0.6).clamp(0.0, 1.0);
                positions[idx] -= nnx * dist_to_plane * t;
                positions[idx + 1] -= nny * dist_to_plane * t;
                positions[idx + 2] -= nnz * dist_to_plane * t;
                modified += 1;
            }
            6 => {
                // Pinch tangentially toward center
                let tx = cx - rx;
                let ty = cy - ry;
                let tz = cz - rz;
                let dot_n = tx * nnx + ty * nny + tz * nnz;
                let tan_x = tx - nnx * dot_n;
                let tan_y = ty - nny * dot_n;
                let tan_z = tz - nnz * dot_n;
                let t = dir * w * strength * 0.35;
                positions[idx] += tan_x * t;
                positions[idx + 1] += tan_y * t;
                positions[idx + 2] += tan_z * t;
                modified += 1;
            }
            7 => {
                // Crease: pinch inward tangentially + sharp normal furrow/ridge
                let tx = cx - rx;
                let ty = cy - ry;
                let tz = cz - rz;
                let dot_n = tx * nnx + ty * nny + tz * nnz;
                let tan_x = tx - nnx * dot_n;
                let tan_y = ty - nny * dot_n;
                let tan_z = tz - nnz * dot_n;
                let pinch_w = w * strength * 0.25;
                let furrow_w = dir * w * falloff * strength_factor * 0.95;
                positions[idx] += tan_x * pinch_w + nnx * furrow_w;
                positions[idx + 1] += tan_y * pinch_w + nny * furrow_w;
                positions[idx + 2] += tan_z * pinch_w + nnz * furrow_w;
                modified += 1;
            }
            8 => {
                // Snake Hook: directional stroke pull + slight normal lift
                let hook_gain = w * (0.85 + 0.35 * strength);
                let lift = dir * w * strength * 0.04 * radius;
                positions[idx] += dx * hook_gain + nnx * lift;
                positions[idx + 1] += dy * hook_gain + nny * lift;
                positions[idx + 2] += dz * hook_gain + nnz * lift;
                modified += 1;
            }
            _ => {}
        }
    }

    modified
}

// ---------------------------------------------------------------------------
// Volumetric Narrow-Band SDF + Surface-Nets Voxel Remesher (Ctrl+R in Sculpt)
// ---------------------------------------------------------------------------

#[inline]
fn dot3(a: [f32; 3], b: [f32; 3]) -> f32 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

#[inline]
fn sub3(a: [f32; 3], b: [f32; 3]) -> [f32; 3] {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

#[inline]
fn point_tri_dist_sq(p: [f32; 3], a: [f32; 3], b: [f32; 3], c: [f32; 3]) -> f32 {
    let ab = sub3(b, a);
    let ac = sub3(c, a);
    let ap = sub3(p, a);
    let d1 = dot3(ab, ap);
    let d2 = dot3(ac, ap);
    if d1 <= 0.0 && d2 <= 0.0 {
        return dot3(ap, ap);
    }

    let bp = sub3(p, b);
    let d3 = dot3(ab, bp);
    let d4 = dot3(ac, bp);
    if d3 >= 0.0 && d4 <= d3 {
        return dot3(bp, bp);
    }

    let vc = d1 * d4 - d3 * d2;
    if vc <= 0.0 && d1 >= 0.0 && d3 <= 0.0 {
        let v = d1 / (d1 - d3);
        let q = [a[0] + ab[0] * v, a[1] + ab[1] * v, a[2] + ab[2] * v];
        let pq = sub3(p, q);
        return dot3(pq, pq);
    }

    let cp = sub3(p, c);
    let d5 = dot3(ab, cp);
    let d6 = dot3(ac, cp);
    if d6 >= 0.0 && d5 <= d6 {
        return dot3(cp, cp);
    }

    let vb = d5 * d2 - d1 * d6;
    if vb <= 0.0 && d2 >= 0.0 && d6 <= 0.0 {
        let w = d2 / (d2 - d6);
        let q = [a[0] + ac[0] * w, a[1] + ac[1] * w, a[2] + ac[2] * w];
        let pq = sub3(p, q);
        return dot3(pq, pq);
    }

    let va = d3 * d6 - d5 * d4;
    if va <= 0.0 && (d4 - d3) >= 0.0 && (d5 - d6) >= 0.0 {
        let w = (d4 - d3) / ((d4 - d3) + (d5 - d6));
        let bc = sub3(c, b);
        let q = [b[0] + bc[0] * w, b[1] + bc[1] * w, b[2] + bc[2] * w];
        let pq = sub3(p, q);
        return dot3(pq, pq);
    }

    let denom = 1.0 / (va + vb + vc).max(1e-20);
    let v = vb * denom;
    let w = vc * denom;
    let q = [
        a[0] + ab[0] * v + ac[0] * w,
        a[1] + ab[1] * v + ac[1] * w,
        a[2] + ab[2] * v + ac[2] * w,
    ];
    let pq = sub3(p, q);
    dot3(pq, pq)
}

#[no_mangle]
pub extern "C" fn mesh_kernel_voxel_remesh(
    pos_ptr: *const f32,
    pos_len: usize,
    index_ptr: *const u32,
    index_len: usize,
    voxel_size: f32,
) -> u32 {
    if pos_ptr.is_null() || pos_len < 9 {
        return 0;
    }
    let positions = unsafe { slice::from_raw_parts(pos_ptr, pos_len) };
    let num_raw_verts = pos_len / 3;

    // 1. Spatial weld + bounds computation
    let inv_tol = 10000.0_f32;
    let mut verts: Vec<[f32; 3]> = Vec::with_capacity(num_raw_verts);
    let mut map: Vec<u32> = Vec::with_capacity(num_raw_verts);
    let mut coord_map: HashMap<u64, u32> = HashMap::with_capacity(num_raw_verts);

    let mut min_p = [f32::INFINITY; 3];
    let mut max_p = [f32::NEG_INFINITY; 3];

    for i in 0..num_raw_verts {
        let x = positions[i * 3];
        let y = positions[i * 3 + 1];
        let z = positions[i * 3 + 2];
        if !x.is_finite() || !y.is_finite() || !z.is_finite() {
            return 0;
        }
        min_p[0] = min_p[0].min(x);
        min_p[1] = min_p[1].min(y);
        min_p[2] = min_p[2].min(z);
        max_p[0] = max_p[0].max(x);
        max_p[1] = max_p[1].max(y);
        max_p[2] = max_p[2].max(z);

        let key = hash_key(
            quantize_coord(x, inv_tol),
            quantize_coord(y, inv_tol),
            quantize_coord(z, inv_tol),
        );
        if let Some(&wid) = coord_map.get(&key) {
            map.push(wid);
        } else {
            let wid = verts.len() as u32;
            verts.push([x, y, z]);
            coord_map.insert(key, wid);
            map.push(wid);
        }
    }

    let mut tris: Vec<[u32; 3]> = Vec::new();
    if !index_ptr.is_null() && index_len >= 3 {
        let indices = unsafe { slice::from_raw_parts(index_ptr, index_len) };
        let tcount = index_len / 3;
        tris.reserve(tcount);
        for t in 0..tcount {
            let i0 = indices[t * 3] as usize;
            let i1 = indices[t * 3 + 1] as usize;
            let i2 = indices[t * 3 + 2] as usize;
            if i0 < map.len() && i1 < map.len() && i2 < map.len() {
                let (w0, w1, w2) = (map[i0], map[i1], map[i2]);
                if w0 != w1 && w1 != w2 && w2 != w0 {
                    tris.push([w0, w1, w2]);
                }
            }
        }
    } else {
        let tcount = num_raw_verts / 3;
        tris.reserve(tcount);
        for t in 0..tcount {
            let (w0, w1, w2) = (map[t * 3], map[t * 3 + 1], map[t * 3 + 2]);
            if w0 != w1 && w1 != w2 && w2 != w0 {
                tris.push([w0, w1, w2]);
            }
        }
    }

    if tris.is_empty() {
        return 0;
    }

    // Determine whether input mesh forms a closed volumetric shell vs an open sheet
    let mut edge_use_count: HashMap<u64, u32> = HashMap::with_capacity(tris.len() * 3);
    for &[a, b, c] in &tris {
        for &(u, v) in &[(a, b), (b, c), (c, a)] {
            let (v0, v1) = if u < v { (u, v) } else { (v, u) };
            let ekey = ((v0 as u64) << 32) | (v1 as u64);
            *edge_use_count.entry(ekey).or_insert(0) += 1;
        }
    }
    let boundary_edges = edge_use_count.values().filter(|&&c| c == 1).count();
    let span_x = (max_p[0] - min_p[0]).max(0.0);
    let span_y = (max_p[1] - min_p[1]).max(0.0);
    let span_z = (max_p[2] - min_p[2]).max(0.0);
    let diag = (span_x * span_x + span_y * span_y + span_z * span_z).sqrt().max(1e-4);

    let req_step = if voxel_size.is_finite() && voxel_size > 0.0 {
        voxel_size
    } else {
        diag * 0.06
    };
    let mut step = req_step.max(diag * 0.015).min(diag * 0.45);

    // Compute grid dimensions inside a tight 140k-voxel budget
    let calc_dims = |s: f32| -> (usize, usize, usize) {
        let nx = (((span_x + 4.0 * s) / s).ceil() as usize + 1).max(5);
        let ny = (((span_y + 4.0 * s) / s).ceil() as usize + 1).max(5);
        let nz = (((span_z + 4.0 * s) / s).ceil() as usize + 1).max(5);
        (nx, ny, nz)
    };
    let (mut nx, mut ny, mut nz) = calc_dims(step);
    let max_voxels = 140_000_usize;
    let total_v = nx.saturating_mul(ny).saturating_mul(nz);
    if total_v > max_voxels {
        step *= ((total_v as f32) / (max_voxels as f32)).cbrt() * 1.03;
        let d = calc_dims(step);
        nx = d.0;
        ny = d.1;
        nz = d.2;
    }

    let ox = min_p[0] - 2.0 * step;
    let oy = min_p[1] - 2.0 * step;
    let oz = min_p[2] - 2.0 * step;
    let inv_step = 1.0 / step;
    let nv = nx * ny * nz;
    let vid = |i: usize, j: usize, k: usize| -> usize { (k * ny + j) * nx + i };

    // 2. Closed-volume +Z parity ray-casting (when watertight or near-closed)
    let is_closed = boundary_edges == 0 || (boundary_edges * 20 < tris.len());
    let mut parity = vec![0u8; nv];
    let mut inside_count = 0usize;

    if is_closed {
        let jx = step * 1.37e-5;
        let jy = step * 2.19e-5;
        for &[a, b, c] in &tris {
            let p0 = verts[a as usize];
            let p1 = verts[b as usize];
            let p2 = verts[c as usize];
            let d01x = p1[0] - p0[0];
            let d01y = p1[1] - p0[1];
            let d02x = p2[0] - p0[0];
            let d02y = p2[1] - p0[1];
            let denom = d01x * d02y - d02x * d01y;
            if denom.abs() < 1e-12 {
                continue;
            }
            let inv_denom = 1.0 / denom;

            let tri_min_x = p0[0].min(p1[0]).min(p2[0]);
            let tri_max_x = p0[0].max(p1[0]).max(p2[0]);
            let tri_min_y = p0[1].min(p1[1]).min(p2[1]);
            let tri_max_y = p0[1].max(p1[1]).max(p2[1]);

            let ix0 = (((tri_min_x - ox - jx) * inv_step).floor() as isize).clamp(0, nx as isize - 1) as usize;
            let ix1 = (((tri_max_x - ox - jx) * inv_step).ceil() as isize).clamp(0, nx as isize - 1) as usize;
            let iy0 = (((tri_min_y - oy - jy) * inv_step).floor() as isize).clamp(0, ny as isize - 1) as usize;
            let iy1 = (((tri_max_y - oy - jy) * inv_step).ceil() as isize).clamp(0, ny as isize - 1) as usize;

            for iy in iy0..=iy1 {
                let ry = oy + (iy as f32) * step + jy;
                for ix in ix0..=ix1 {
                    let rx = ox + (ix as f32) * step + jx;
                    let qx = rx - p0[0];
                    let qy = ry - p0[1];
                    let u = (qx * d02y - d02x * qy) * inv_denom;
                    let v = (d01x * qy - qx * d01y) * inv_denom;
                    if u >= 0.0 && v >= 0.0 && (u + v) <= 1.0 {
                        let w = 1.0 - u - v;
                        let z_hit = w * p0[2] + u * p1[2] + v * p2[2];
                        let kz = ((z_hit - oz) * inv_step).ceil() as isize;
                        if kz < nz as isize {
                            let k_idx = kz.max(0) as usize;
                            parity[vid(ix, iy, k_idx)] ^= 1;
                        }
                    }
                }
            }
        }

        // Prefix-XOR along Z columns
        for j in 0..ny {
            for i in 0..nx {
                let mut acc = 0u8;
                for k in 0..nz {
                    let id = vid(i, j, k);
                    acc ^= parity[id];
                    parity[id] = acc;
                    if acc != 0 {
                        inside_count += 1;
                    }
                }
            }
        }
    }

    // 3. Narrow-band exact point-to-triangle distance around surface triangles
    let mut dist_sq = vec![f32::INFINITY; nv];
    let band_dist = step * 2.15;
    for &[a, b, c] in &tris {
        let p0 = verts[a as usize];
        let p1 = verts[b as usize];
        let p2 = verts[c as usize];
        let bx0 = p0[0].min(p1[0]).min(p2[0]) - band_dist;
        let by0 = p0[1].min(p1[1]).min(p2[1]) - band_dist;
        let bz0 = p0[2].min(p1[2]).min(p2[2]) - band_dist;
        let bx1 = p0[0].max(p1[0]).max(p2[0]) + band_dist;
        let by1 = p0[1].max(p1[1]).max(p2[1]) + band_dist;
        let bz1 = p0[2].max(p1[2]).max(p2[2]) + band_dist;

        let i0 = (((bx0 - ox) * inv_step).floor() as isize).clamp(0, nx as isize - 1) as usize;
        let i1 = (((bx1 - ox) * inv_step).ceil() as isize).clamp(0, nx as isize - 1) as usize;
        let j0 = (((by0 - oy) * inv_step).floor() as isize).clamp(0, ny as isize - 1) as usize;
        let j1 = (((by1 - oy) * inv_step).ceil() as isize).clamp(0, ny as isize - 1) as usize;
        let k0 = (((bz0 - oz) * inv_step).floor() as isize).clamp(0, nz as isize - 1) as usize;
        let k1 = (((bz1 - oz) * inv_step).ceil() as isize).clamp(0, nz as isize - 1) as usize;

        for k in k0..=k1 {
            let gz = oz + (k as f32) * step;
            for j in j0..=j1 {
                let gy = oy + (j as f32) * step;
                for i in i0..=i1 {
                    let gx = ox + (i as f32) * step;
                    let d2 = point_tri_dist_sq([gx, gy, gz], p0, p1, p2);
                    let id = vid(i, j, k);
                    if d2 < dist_sq[id] {
                        dist_sq[id] = d2;
                    }
                }
            }
        }
    }

    let use_signed = is_closed && inside_count > 0;
    let shell_iso = step * 0.42;
    let mut sdf = vec![0.0_f32; nv];
    for id in 0..nv {
        let d = if dist_sq[id].is_finite() {
            dist_sq[id].sqrt()
        } else {
            step * 3.0
        };
        sdf[id] = if use_signed {
            if parity[id] != 0 { -d } else { d }
        } else {
            d - shell_iso
        };
    }

    // 4. Surface-Nets active cell vertex extraction
    let cx_n = nx - 1;
    let cy_n = ny - 1;
    let cz_n = nz - 1;
    let cell_id = |i: usize, j: usize, k: usize| -> usize { (k * cy_n + j) * cx_n + i };
    let mut cell_vert: Vec<u32> = vec![u32::MAX; cx_n * cy_n * cz_n];
    let mut sn_verts: Vec<[f32; 3]> = Vec::new();

    const EDGE_PAIRS: [(usize, usize); 12] = [
        (0, 1), (2, 3), (4, 5), (6, 7),
        (0, 2), (1, 3), (4, 6), (5, 7),
        (0, 4), (1, 5), (2, 6), (3, 7),
    ];

    for k in 0..cz_n {
        let pz = oz + (k as f32) * step;
        for j in 0..cy_n {
            let py = oy + (j as f32) * step;
            for i in 0..cx_n {
                let px = ox + (i as f32) * step;
                let cs = [
                    sdf[vid(i, j, k)],
                    sdf[vid(i + 1, j, k)],
                    sdf[vid(i, j + 1, k)],
                    sdf[vid(i + 1, j + 1, k)],
                    sdf[vid(i, j, k + 1)],
                    sdf[vid(i + 1, j, k + 1)],
                    sdf[vid(i, j + 1, k + 1)],
                    sdf[vid(i + 1, j + 1, k + 1)],
                ];
                let mut mask = 0u8;
                for c in 0..8 {
                    if cs[c] < 0.0 {
                        mask |= 1 << c;
                    }
                }
                if mask == 0 || mask == 255 {
                    continue;
                }

                let corners = [
                    [px, py, pz],
                    [px + step, py, pz],
                    [px, py + step, pz],
                    [px + step, py + step, pz],
                    [px, py, pz + step],
                    [px + step, py, pz + step],
                    [px, py + step, pz + step],
                    [px + step, py + step, pz + step],
                ];
                let mut sum = [0.0_f32; 3];
                let mut crossings = 0u32;
                for &(a, b) in &EDGE_PAIRS {
                    let sa = cs[a];
                    let sb = cs[b];
                    if (sa < 0.0) != (sb < 0.0) {
                        let denom = sa - sb;
                        let t = if denom.abs() > 1e-12 {
                            (sa / denom).clamp(0.02, 0.98)
                        } else {
                            0.5
                        };
                        sum[0] += corners[a][0] + (corners[b][0] - corners[a][0]) * t;
                        sum[1] += corners[a][1] + (corners[b][1] - corners[a][1]) * t;
                        sum[2] += corners[a][2] + (corners[b][2] - corners[a][2]) * t;
                        crossings += 1;
                    }
                }
                if crossings > 0 {
                    let inv_c = 1.0 / (crossings as f32);
                    let vidx = sn_verts.len() as u32;
                    sn_verts.push([sum[0] * inv_c, sum[1] * inv_c, sum[2] * inv_c]);
                    cell_vert[cell_id(i, j, k)] = vidx;
                }
            }
        }
    }

    if sn_verts.len() < 3 {
        return 0;
    }

    // 5. Emit oriented Surface-Nets quads along sign-changing interior grid edges
    let mut sn_tris: Vec<[u32; 3]> = Vec::new();
    let emit_quad = |c0: u32, c1: u32, c2: u32, c3: u32, forward: bool, out: &mut Vec<[u32; 3]>| {
        if c0 == u32::MAX || c1 == u32::MAX || c2 == u32::MAX || c3 == u32::MAX {
            return;
        }
        if forward {
            out.push([c0, c1, c2]);
            out.push([c0, c2, c3]);
        } else {
            out.push([c0, c2, c1]);
            out.push([c0, c3, c2]);
        }
    };

    // X-edges: outward +X when s(i) < 0 && s(i+1) >= 0
    for k in 1..cz_n {
        for j in 1..cy_n {
            for i in 0..cx_n {
                let s0 = sdf[vid(i, j, k)];
                let s1 = sdf[vid(i + 1, j, k)];
                if (s0 < 0.0) != (s1 < 0.0) {
                    emit_quad(
                        cell_vert[cell_id(i, j - 1, k - 1)],
                        cell_vert[cell_id(i, j, k - 1)],
                        cell_vert[cell_id(i, j, k)],
                        cell_vert[cell_id(i, j - 1, k)],
                        s0 < 0.0,
                        &mut sn_tris,
                    );
                }
            }
        }
    }

    // Y-edges: outward +Y when s(j) < 0 && s(j+1) >= 0
    for k in 1..cz_n {
        for j in 0..cy_n {
            for i in 1..cx_n {
                let s0 = sdf[vid(i, j, k)];
                let s1 = sdf[vid(i, j + 1, k)];
                if (s0 < 0.0) != (s1 < 0.0) {
                    emit_quad(
                        cell_vert[cell_id(i - 1, j, k - 1)],
                        cell_vert[cell_id(i - 1, j, k)],
                        cell_vert[cell_id(i, j, k)],
                        cell_vert[cell_id(i, j, k - 1)],
                        s0 < 0.0,
                        &mut sn_tris,
                    );
                }
            }
        }
    }

    // Z-edges: outward +Z when s(k) < 0 && s(k+1) >= 0
    for k in 0..cz_n {
        for j in 1..cy_n {
            for i in 1..cx_n {
                let s0 = sdf[vid(i, j, k)];
                let s1 = sdf[vid(i, j, k + 1)];
                if (s0 < 0.0) != (s1 < 0.0) {
                    emit_quad(
                        cell_vert[cell_id(i - 1, j - 1, k)],
                        cell_vert[cell_id(i, j - 1, k)],
                        cell_vert[cell_id(i, j, k)],
                        cell_vert[cell_id(i - 1, j, k)],
                        s0 < 0.0,
                        &mut sn_tris,
                    );
                }
            }
        }
    }

    if sn_tris.is_empty() {
        return 0;
    }

    // 6. Gentle Taubin smoothing (+0.33 / -0.31) to remove voxel grid faceting cleanly without shrinkage
    let vlen = sn_verts.len();
    for &lambda in &[0.33_f32, -0.31_f32] {
        let mut accum_nb: Vec<[f32; 3]> = vec![[0.0; 3]; vlen];
        let mut accum_cnt: Vec<u32> = vec![0; vlen];
        for &[i0, i1, i2] in &sn_tris {
            for &(a, b) in &[(i0, i1), (i1, i2), (i2, i0)] {
                let ua = a as usize;
                let ub = b as usize;
                accum_nb[ua][0] += sn_verts[ub][0];
                accum_nb[ua][1] += sn_verts[ub][1];
                accum_nb[ua][2] += sn_verts[ub][2];
                accum_cnt[ua] += 1;
                accum_nb[ub][0] += sn_verts[ua][0];
                accum_nb[ub][1] += sn_verts[ua][1];
                accum_nb[ub][2] += sn_verts[ua][2];
                accum_cnt[ub] += 1;
            }
        }
        for i in 0..vlen {
            let cnt = accum_cnt[i];
            if cnt == 0 {
                continue;
            }
            let inv_c = 1.0 / (cnt as f32);
            let dx_nb = accum_nb[i][0] * inv_c - sn_verts[i][0];
            let dy_nb = accum_nb[i][1] * inv_c - sn_verts[i][1];
            let dz_nb = accum_nb[i][2] * inv_c - sn_verts[i][2];
            sn_verts[i][0] += dx_nb * lambda;
            sn_verts[i][1] += dy_nb * lambda;
            sn_verts[i][2] += dz_nb * lambda;
        }
    }

    // 7. Area-weighted smooth vertex normals & unique edge extraction
    let mut final_normals: Vec<[f32; 3]> = vec![[0.0; 3]; vlen];
    let mut edge_map: HashMap<u64, ()> = HashMap::with_capacity(sn_tris.len() * 3);
    let mut unique_edges: Vec<u32> = Vec::with_capacity(sn_tris.len() * 6);
    let mut out_indices: Vec<u32> = Vec::with_capacity(sn_tris.len() * 3);

    for &[i0, i1, i2] in &sn_tris {
        out_indices.push(i0);
        out_indices.push(i1);
        out_indices.push(i2);

        let p0 = sn_verts[i0 as usize];
        let p1 = sn_verts[i1 as usize];
        let p2 = sn_verts[i2 as usize];
        let ab = [p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]];
        let ac = [p2[0] - p0[0], p2[1] - p0[1], p2[2] - p0[2]];
        let fn_x = ab[1] * ac[2] - ab[2] * ac[1];
        let fn_y = ab[2] * ac[0] - ab[0] * ac[2];
        let fn_z = ab[0] * ac[1] - ab[1] * ac[0];

        for &idx in &[i0 as usize, i1 as usize, i2 as usize] {
            final_normals[idx][0] += fn_x;
            final_normals[idx][1] += fn_y;
            final_normals[idx][2] += fn_z;
        }

        for &(u, v) in &[(i0, i1), (i1, i2), (i2, i0)] {
            let (v0, v1) = if u < v { (u, v) } else { (v, u) };
            let ekey = ((v0 as u64) << 32) | (v1 as u64);
            if edge_map.insert(ekey, ()).is_none() {
                unique_edges.push(v0);
                unique_edges.push(v1);
            }
        }
    }

    let mut out_verts: Vec<f32> = Vec::with_capacity(vlen * 3);
    let mut out_normals: Vec<f32> = Vec::with_capacity(vlen * 3);
    for i in 0..vlen {
        out_verts.push(sn_verts[i][0]);
        out_verts.push(sn_verts[i][1]);
        out_verts.push(sn_verts[i][2]);
        let n = final_normals[i];
        let len = (n[0] * n[0] + n[1] * n[1] + n[2] * n[2]).sqrt();
        if len > 1e-6 {
            out_normals.push(n[0] / len);
            out_normals.push(n[1] / len);
            out_normals.push(n[2] / len);
        } else {
            out_normals.push(0.0);
            out_normals.push(1.0);
            out_normals.push(0.0);
        }
    }

    let buf = get_buffers_mut();
    buf.vertices = out_verts;
    buf.indices = out_indices;
    buf.edges = unique_edges;
    buf.normals = out_normals;

    1
}

// ===========================================================================
// 5. QEM MESH SIMPLIFICATION (Garland-Heckbert Quadric Error Metrics)
// ===========================================================================

#[derive(Clone, Copy, Default)]
struct SymQuadric([f64; 10]);

impl SymQuadric {
    #[inline(always)]
    fn from_plane(a: f64, b: f64, c: f64, d: f64, weight: f64) -> Self {
        Self([
            weight * a * a,
            weight * a * b,
            weight * a * c,
            weight * a * d,
            weight * b * b,
            weight * b * c,
            weight * b * d,
            weight * c * c,
            weight * c * d,
            weight * d * d,
        ])
    }

    #[inline(always)]
    fn add_assign(&mut self, rhs: &Self) {
        for i in 0..10 {
            self.0[i] += rhs.0[i];
        }
    }

    #[inline(always)]
    fn add(&self, rhs: &Self) -> Self {
        let mut out = *self;
        out.add_assign(rhs);
        out
    }

    #[inline(always)]
    fn eval(&self, x: f64, y: f64, z: f64) -> f64 {
        let q = &self.0;
        let err = q[0] * x * x
            + 2.0 * q[1] * x * y
            + 2.0 * q[2] * x * z
            + 2.0 * q[3] * x
            + q[4] * y * y
            + 2.0 * q[5] * y * z
            + 2.0 * q[6] * y
            + q[7] * z * z
            + 2.0 * q[8] * z
            + q[9];
        if err > 0.0 { err } else { 0.0 }
    }
}

#[derive(Clone, Copy)]
struct QemEdgeCandidate {
    cost: f64,
    u: u32,
    v: u32,
    ver_u: u32,
    ver_v: u32,
    choice: u8, // 0 = pos[u], 1 = pos[v], 2 = midpoint
}

impl PartialEq for QemEdgeCandidate {
    fn eq(&self, other: &Self) -> bool {
        self.cost.to_bits() == other.cost.to_bits() && self.u == other.u && self.v == other.v
    }
}
impl Eq for QemEdgeCandidate {}

impl PartialOrd for QemEdgeCandidate {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}
impl Ord for QemEdgeCandidate {
    fn cmp(&self, other: &Self) -> Ordering {
        // Reverse ordering for min-heap
        other
            .cost
            .partial_cmp(&self.cost)
            .unwrap_or(Ordering::Equal)
            .then_with(|| other.u.cmp(&self.u))
            .then_with(|| other.v.cmp(&self.v))
    }
}

#[inline(always)]
fn eval_edge_candidate(
    u: u32,
    v: u32,
    positions: &[[f64; 3]],
    quadrics: &[SymQuadric],
    is_border: &[bool],
    ver: &[u32],
    lock_borders: bool,
) -> QemEdgeCandidate {
    let pu = positions[u as usize];
    let pv = positions[v as usize];
    let pm = [0.5 * (pu[0] + pv[0]), 0.5 * (pu[1] + pv[1]), 0.5 * (pu[2] + pv[2])];
    let q = quadrics[u as usize].add(&quadrics[v as usize]);

    let dx = pu[0] - pv[0];
    let dy = pu[1] - pv[1];
    let dz = pu[2] - pv[2];
    let len_sq = dx * dx + dy * dy + dz * dz;
    // Slight edge-length regularizer avoids needle triangles on flat foliage planes
    let reg = 1e-7 * len_sq;

    let bu = is_border[u as usize];
    let bv = is_border[v as usize];

    let (mut best_cost, choice) = if lock_borders && bu && !bv {
        // Snap interior vertex onto border vertex to keep silhouette/UV seam anchored
        (q.eval(pu[0], pu[1], pu[2]) + reg, 0u8)
    } else if lock_borders && bv && !bu {
        (q.eval(pv[0], pv[1], pv[2]) + reg, 1u8)
    } else {
        let cu = q.eval(pu[0], pu[1], pu[2]);
        let cv = q.eval(pv[0], pv[1], pv[2]);
        let cm = q.eval(pm[0], pm[1], pm[2]);
        if cm <= cu && cm <= cv {
            (cm + reg, 2u8)
        } else if cu <= cv {
            (cu + reg, 0u8)
        } else {
            (cv + reg, 1u8)
        }
    };

    if lock_borders && bu && bv {
        best_cost += 0.25 * len_sq;
    }

    QemEdgeCandidate {
        cost: best_cost,
        u,
        v,
        ver_u: ver[u as usize],
        ver_v: ver[v as usize],
        choice,
    }
}

#[inline(always)]
fn tri_normal_unnorm(a: [f64; 3], b: [f64; 3], c: [f64; 3]) -> [f64; 3] {
    let ux = b[0] - a[0];
    let uy = b[1] - a[1];
    let uz = b[2] - a[2];
    let vx = c[0] - a[0];
    let vy = c[1] - a[1];
    let vz = c[2] - a[2];
    [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx]
}

/// Simplifies a triangle mesh using Garland-Heckbert Quadric Error Metrics (QEM),
/// preserving UVs, silhouette boundaries, and recomputing smooth vertex normals.
#[no_mangle]
pub extern "C" fn mesh_kernel_qem_simplify(
    pos_ptr: *const f32,
    pos_len: usize,
    uv_ptr: *const f32,
    uv_len: usize,
    idx_ptr: *const u32,
    idx_len: usize,
    target_ratio: f32,
    lock_borders: u32,
) -> u32 {
    if pos_ptr.is_null() || pos_len < 9 || pos_len % 3 != 0 {
        return 0;
    }

    let raw_pos = unsafe { slice::from_raw_parts(pos_ptr, pos_len) };
    let in_verts = pos_len / 3;
    let has_uv = !uv_ptr.is_null() && uv_len == in_verts * 2;
    let raw_uv = if has_uv {
        unsafe { slice::from_raw_parts(uv_ptr, uv_len) }
    } else {
        &[]
    };

    // Compute bounding diagonal for scale-invariant spatial welding
    let mut min_p = [f32::INFINITY; 3];
    let mut max_p = [f32::NEG_INFINITY; 3];
    for i in 0..in_verts {
        let x = raw_pos[i * 3];
        let y = raw_pos[i * 3 + 1];
        let z = raw_pos[i * 3 + 2];
        if !x.is_finite() || !y.is_finite() || !z.is_finite() {
            return 0;
        }
        if x < min_p[0] { min_p[0] = x; }
        if y < min_p[1] { min_p[1] = y; }
        if z < min_p[2] { min_p[2] = z; }
        if x > max_p[0] { max_p[0] = x; }
        if y > max_p[1] { max_p[1] = y; }
        if z > max_p[2] { max_p[2] = z; }
    }
    let diag = (((max_p[0] - min_p[0]).powi(2)
        + (max_p[1] - min_p[1]).powi(2)
        + (max_p[2] - min_p[2]).powi(2))
        .sqrt())
    .max(1e-4);
    let inv_pos_tol = 1.0 / (diag * 1e-5).max(1e-7);

    // Weld vertices that share both position AND UV (within 1e-3) so soup meshes connect
    // while UV seams stay sharp and un-smeared.
    let mut weld_map: HashMap<(i32, i32, i32, i32, i32), u32> = HashMap::with_capacity(in_verts);
    let mut remap: Vec<u32> = Vec::with_capacity(in_verts);
    let mut positions: Vec<[f64; 3]> = Vec::with_capacity(in_verts);
    let mut uvs: Vec<[f32; 2]> = if has_uv { Vec::with_capacity(in_verts) } else { Vec::new() };

    for i in 0..in_verts {
        let px = raw_pos[i * 3];
        let py = raw_pos[i * 3 + 1];
        let pz = raw_pos[i * 3 + 2];
        let qx = quantize_coord(px, inv_pos_tol);
        let qy = quantize_coord(py, inv_pos_tol);
        let qz = quantize_coord(pz, inv_pos_tol);
        let (qu, qv, u0, v0) = if has_uv {
            let u = raw_uv[i * 2];
            let v = raw_uv[i * 2 + 1];
            let su = if u.is_finite() { u } else { 0.0 };
            let sv = if v.is_finite() { v } else { 0.0 };
            ((su * 1000.0).round() as i32, (sv * 1000.0).round() as i32, su, sv)
        } else {
            (0, 0, 0.0, 0.0)
        };
        let key = (qx, qy, qz, qu, qv);
        if let Some(&existing) = weld_map.get(&key) {
            remap.push(existing);
        } else {
            let nid = positions.len() as u32;
            positions.push([px as f64, py as f64, pz as f64]);
            if has_uv {
                uvs.push([u0, v0]);
            }
            weld_map.insert(key, nid);
            remap.push(nid);
        }
    }

    let raw_tris_count = if !idx_ptr.is_null() && idx_len >= 3 {
        idx_len / 3
    } else {
        in_verts / 3
    };
    if raw_tris_count == 0 {
        return 0;
    }

    let mut tris: Vec<[u32; 3]> = Vec::with_capacity(raw_tris_count);
    if !idx_ptr.is_null() && idx_len >= 3 {
        let raw_idx = unsafe { slice::from_raw_parts(idx_ptr, raw_tris_count * 3) };
        for t in 0..raw_tris_count {
            let i0 = raw_idx[t * 3] as usize;
            let i1 = raw_idx[t * 3 + 1] as usize;
            let i2 = raw_idx[t * 3 + 2] as usize;
            if i0 >= in_verts || i1 >= in_verts || i2 >= in_verts {
                continue;
            }
            let a = remap[i0];
            let b = remap[i1];
            let c = remap[i2];
            if a != b && b != c && c != a {
                tris.push([a, b, c]);
            }
        }
    } else {
        for t in 0..raw_tris_count {
            let a = remap[t * 3];
            let b = remap[t * 3 + 1];
            let c = remap[t * 3 + 2];
            if a != b && b != c && c != a {
                tris.push([a, b, c]);
            }
        }
    }

    let initial_tris = tris.len();
    if initial_tris == 0 {
        return 0;
    }

    let clamped_ratio = target_ratio.clamp(0.01, 1.0);
    let target_tris = ((initial_tris as f32 * clamped_ratio).round() as usize).max(1);

    let v_count = positions.len();
    let mut quadrics: Vec<SymQuadric> = vec![SymQuadric::default(); v_count];
    let mut vert_tris: Vec<Vec<u32>> = vec![Vec::new(); v_count];
    let mut edge_use_count: HashMap<(u32, u32), (u32, u32)> = HashMap::with_capacity(initial_tris * 2);

    for (ti, tri) in tris.iter().enumerate() {
        let a = tri[0];
        let b = tri[1];
        let c = tri[2];
        vert_tris[a as usize].push(ti as u32);
        vert_tris[b as usize].push(ti as u32);
        vert_tris[c as usize].push(ti as u32);

        let pa = positions[a as usize];
        let pb = positions[b as usize];
        let pc = positions[c as usize];
        let n = tri_normal_unnorm(pa, pb, pc);
        let len = (n[0] * n[0] + n[1] * n[1] + n[2] * n[2]).sqrt();
        if len > 1e-12 {
            let inv = 1.0 / len;
            let nx = n[0] * inv;
            let ny = n[1] * inv;
            let nz = n[2] * inv;
            let d = -(nx * pa[0] + ny * pa[1] + nz * pa[2]);
            let area = 0.5 * len;
            let q = SymQuadric::from_plane(nx, ny, nz, d, area);
            quadrics[a as usize].add_assign(&q);
            quadrics[b as usize].add_assign(&q);
            quadrics[c as usize].add_assign(&q);
        }

        for &(x, y) in &[(a, b), (b, c), (c, a)] {
            let ek = if x < y { (x, y) } else { (y, x) };
            let entry = edge_use_count.entry(ek).or_insert((0, ti as u32));
            entry.0 += 1;
        }
    }

    let lock = lock_borders != 0;
    let mut is_border = vec![false; v_count];
    let border_weight_scale = if lock { 6.0 } else { 0.2 };

    for (&(u, v), &(cnt, sample_ti)) in &edge_use_count {
        if cnt == 1 {
            is_border[u as usize] = true;
            is_border[v as usize] = true;
            // Add Garland-Heckbert perpendicular boundary constraint plane
            let tri = tris[sample_ti as usize];
            let tn = tri_normal_unnorm(
                positions[tri[0] as usize],
                positions[tri[1] as usize],
                positions[tri[2] as usize],
            );
            let pu = positions[u as usize];
            let pv = positions[v as usize];
            let ex = pv[0] - pu[0];
            let ey = pv[1] - pu[1];
            let ez = pv[2] - pu[2];
            // Plane normal = edge x tri_normal
            let bx = ey * tn[2] - ez * tn[1];
            let by = ez * tn[0] - ex * tn[2];
            let bz = ex * tn[1] - ey * tn[0];
            let blen = (bx * bx + by * by + bz * bz).sqrt();
            if blen > 1e-12 {
                let inv = 1.0 / blen;
                let nx = bx * inv;
                let ny = by * inv;
                let nz = bz * inv;
                let d = -(nx * pu[0] + ny * pu[1] + nz * pu[2]);
                let edge_len_sq = ex * ex + ey * ey + ez * ez;
                let bq = SymQuadric::from_plane(nx, ny, nz, d, border_weight_scale * edge_len_sq);
                quadrics[u as usize].add_assign(&bq);
                quadrics[v as usize].add_assign(&bq);
            }
        }
    }

    let mut alive_tri = vec![true; initial_tris];
    let mut alive_vert = vec![true; v_count];
    let mut vert_ver = vec![0u32; v_count];
    let mut live_tris = initial_tris;

    if live_tris > target_tris {
        let mut heap: BinaryHeap<QemEdgeCandidate> = BinaryHeap::with_capacity(edge_use_count.len() * 2);
        for &(u, v) in edge_use_count.keys() {
            heap.push(eval_edge_candidate(u, v, &positions, &quadrics, &is_border, &vert_ver, lock));
        }

        let mut neighbor_buf: Vec<u32> = Vec::with_capacity(32);

        while live_tris > target_tris {
            let Some(cand) = heap.pop() else { break; };
            let mut u = cand.u;
            let mut v = cand.v;
            if u == v || !alive_vert[u as usize] || !alive_vert[v as usize] {
                continue;
            }
            if vert_ver[u as usize] != cand.ver_u || vert_ver[v as usize] != cand.ver_v {
                continue;
            }

            let pu = positions[u as usize];
            let pv = positions[v as usize];
            let new_pos = match cand.choice {
                0 => pu,
                1 => pv,
                _ => [0.5 * (pu[0] + pv[0]), 0.5 * (pu[1] + pv[1]), 0.5 * (pu[2] + pv[2])],
            };
            let new_uv = if has_uv {
                let uu = uvs[u as usize];
                let uv = uvs[v as usize];
                match cand.choice {
                    0 => uu,
                    1 => uv,
                    _ => [0.5 * (uu[0] + uv[0]), 0.5 * (uu[1] + uv[1])],
                }
            } else {
                [0.0, 0.0]
            };

            // Keep vertex with larger adjacency as survivor `u` to minimize copy work
            if vert_tris[u as usize].len() < vert_tris[v as usize].len() {
                std::mem::swap(&mut u, &mut v);
            }

            // Normal-inversion guard on surviving triangles around u and v
            let mut flipped = false;
            for &vid in &[u, v] {
                for &ti in &vert_tris[vid as usize] {
                    if !alive_tri[ti as usize] {
                        continue;
                    }
                    let t = tris[ti as usize];
                    let has_u = t[0] == u || t[1] == u || t[2] == u;
                    let has_v = t[0] == v || t[1] == v || t[2] == v;
                    if has_u && has_v {
                        continue; // This face collapses away
                    }
                    let p0 = positions[t[0] as usize];
                    let p1 = positions[t[1] as usize];
                    let p2 = positions[t[2] as usize];
                    let old_n = tri_normal_unnorm(p0, p1, p2);
                    let np0 = if t[0] == u || t[0] == v { new_pos } else { p0 };
                    let np1 = if t[1] == u || t[1] == v { new_pos } else { p1 };
                    let np2 = if t[2] == u || t[2] == v { new_pos } else { p2 };
                    let new_n = tri_normal_unnorm(np0, np1, np2);
                    let len_old = (old_n[0] * old_n[0] + old_n[1] * old_n[1] + old_n[2] * old_n[2]).sqrt();
                    let len_new = (new_n[0] * new_n[0] + new_n[1] * new_n[1] + new_n[2] * new_n[2]).sqrt();
                    if len_old > 1e-12 && len_new > 1e-12 {
                        let cos = (old_n[0] * new_n[0] + old_n[1] * new_n[1] + old_n[2] * new_n[2]) / (len_old * len_new);
                        if cos < 0.15 {
                            flipped = true;
                            break;
                        }
                    }
                }
                if flipped {
                    break;
                }
            }
            if flipped {
                continue;
            }

            // Commit collapse v -> u
            positions[u as usize] = new_pos;
            if has_uv {
                uvs[u as usize] = new_uv;
            }
            let qv = quadrics[v as usize];
            quadrics[u as usize].add_assign(&qv);
            is_border[u as usize] = is_border[u as usize] || is_border[v as usize];
            alive_vert[v as usize] = false;
            vert_ver[u as usize] = vert_ver[u as usize].wrapping_add(1);
            vert_ver[v as usize] = vert_ver[v as usize].wrapping_add(1);

            // Update triangles incident to v
            let v_inc = std::mem::take(&mut vert_tris[v as usize]);
            for ti in v_inc {
                if !alive_tri[ti as usize] {
                    continue;
                }
                let t = &mut tris[ti as usize];
                for slot in t.iter_mut() {
                    if *slot == v {
                        *slot = u;
                    }
                }
                if t[0] == t[1] || t[1] == t[2] || t[2] == t[0] {
                    alive_tri[ti as usize] = false;
                    live_tris = live_tris.saturating_sub(1);
                } else {
                    vert_tris[u as usize].push(ti);
                }
            }

            // Prune dead triangles & collect unique ring neighbors around u
            neighbor_buf.clear();
            let u_list = &mut vert_tris[u as usize];
            let mut write_idx = 0;
            for read_idx in 0..u_list.len() {
                let ti = u_list[read_idx];
                if !alive_tri[ti as usize] {
                    continue;
                }
                let t = tris[ti as usize];
                if t[0] == t[1] || t[1] == t[2] || t[2] == t[0] {
                    alive_tri[ti as usize] = false;
                    live_tris = live_tris.saturating_sub(1);
                    continue;
                }
                u_list[write_idx] = ti;
                write_idx += 1;
                for &vx in &t {
                    if vx != u && alive_vert[vx as usize] && !neighbor_buf.contains(&vx) {
                        neighbor_buf.push(vx);
                    }
                }
            }
            u_list.truncate(write_idx);

            for &nb in &neighbor_buf {
                let (ea, eb) = if u < nb { (u, nb) } else { (nb, u) };
                heap.push(eval_edge_candidate(ea, eb, &positions, &quadrics, &is_border, &vert_ver, lock));
            }
        }
    }

    // Compact surviving vertices & triangles and recompute smooth normals
    let mut final_remap: Vec<u32> = vec![u32::MAX; v_count];
    let mut out_verts: Vec<f32> = Vec::with_capacity(live_tris * 3);
    let mut out_uvs: Vec<f32> = if has_uv { Vec::with_capacity(live_tris * 2) } else { Vec::new() };
    let mut out_indices: Vec<u32> = Vec::with_capacity(live_tris * 3);

    for (ti, t) in tris.iter().enumerate() {
        if !alive_tri[ti] {
            continue;
        }
        if t[0] == t[1] || t[1] == t[2] || t[2] == t[0] {
            continue;
        }
        let mut mapped = [0u32; 3];
        for k in 0..3 {
            let old_v = t[k] as usize;
            if final_remap[old_v] == u32::MAX {
                let nv = (out_verts.len() / 3) as u32;
                final_remap[old_v] = nv;
                let p = positions[old_v];
                out_verts.push(p[0] as f32);
                out_verts.push(p[1] as f32);
                out_verts.push(p[2] as f32);
                if has_uv {
                    let uv = uvs[old_v];
                    out_uvs.push(uv[0]);
                    out_uvs.push(uv[1]);
                }
            }
            mapped[k] = final_remap[old_v];
        }
        out_indices.push(mapped[0]);
        out_indices.push(mapped[1]);
        out_indices.push(mapped[2]);
    }

    let out_v_count = out_verts.len() / 3;
    let mut out_normals = vec![0.0f32; out_v_count * 3];
    for chunk in out_indices.chunks_exact(3) {
        let i0 = chunk[0] as usize;
        let i1 = chunk[1] as usize;
        let i2 = chunk[2] as usize;
        let p0 = [out_verts[i0 * 3], out_verts[i0 * 3 + 1], out_verts[i0 * 3 + 2]];
        let p1 = [out_verts[i1 * 3], out_verts[i1 * 3 + 1], out_verts[i1 * 3 + 2]];
        let p2 = [out_verts[i2 * 3], out_verts[i2 * 3 + 1], out_verts[i2 * 3 + 2]];
        let ux = p1[0] - p0[0];
        let uy = p1[1] - p0[1];
        let uz = p1[2] - p0[2];
        let vx = p2[0] - p0[0];
        let vy = p2[1] - p0[1];
        let vz = p2[2] - p0[2];
        let nx = uy * vz - uz * vy;
        let ny = uz * vx - ux * vz;
        let nz = ux * vy - uy * vx;
        for &vi in &[i0, i1, i2] {
            out_normals[vi * 3] += nx;
            out_normals[vi * 3 + 1] += ny;
            out_normals[vi * 3 + 2] += nz;
        }
    }
    for v in 0..out_v_count {
        let nx = out_normals[v * 3];
        let ny = out_normals[v * 3 + 1];
        let nz = out_normals[v * 3 + 2];
        let len = (nx * nx + ny * ny + nz * nz).sqrt();
        if len > 1e-12 {
            out_normals[v * 3] = nx / len;
            out_normals[v * 3 + 1] = ny / len;
            out_normals[v * 3 + 2] = nz / len;
        } else {
            out_normals[v * 3 + 1] = 1.0;
        }
    }

    let buf = get_buffers_mut();
    buf.vertices = out_verts;
    buf.indices = out_indices;
    buf.normals = out_normals;
    buf.uvs = out_uvs;
    buf.edges.clear();
    buf.map.clear();

    1
}

// ===========================================================================
// 6. FAST SURFACE SCATTER & FRUSTUM / LOD INSTANCE MATRIX PARTITIONING
// ===========================================================================

struct SplitMix64(u64);

impl SplitMix64 {
    #[inline(always)]
    fn next_u64(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E3779B97F4A7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58476D1CE4E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D049BB133111EB);
        z ^ (z >> 31)
    }

    #[inline(always)]
    fn next_f32(&mut self) -> f32 {
        ((self.next_u64() >> 40) as f32) * (1.0 / ((1u64 << 24) as f32))
    }
}

#[inline(always)]
fn transform_point_mat4(m: &[f32; 16], p: [f32; 3]) -> [f32; 3] {
    [
        m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
        m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
        m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
    ]
}

#[inline(always)]
fn quat_from_unit_vectors(from: [f32; 3], to: [f32; 3]) -> [f32; 4] {
    let mut r = from[0] * to[0] + from[1] * to[1] + from[2] * to[2] + 1.0;
    let (x, y, z);
    if r < 1e-6 {
        r = 0.0;
        if from[0].abs() > from[2].abs() {
            x = -from[1];
            y = from[0];
            z = 0.0;
        } else {
            x = 0.0;
            y = -from[2];
            z = from[1];
        }
    } else {
        x = from[1] * to[2] - from[2] * to[1];
        y = from[2] * to[0] - from[0] * to[2];
        z = from[0] * to[1] - from[1] * to[0];
    }
    let len = (x * x + y * y + z * z + r * r).sqrt().max(1e-12);
    [x / len, y / len, z / len, r / len]
}

#[inline(always)]
fn quat_mul(a: [f32; 4], b: [f32; 4]) -> [f32; 4] {
    [
        a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
        a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
        a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
        a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
    ]
}

#[inline(always)]
fn write_trs_matrix4(out: &mut Vec<f32>, pos: [f32; 3], q: [f32; 4], s: [f32; 3]) {
    let (x, y, z, w) = (q[0], q[1], q[2], q[3]);
    let x2 = x + x;
    let y2 = y + y;
    let z2 = z + z;
    let xx = x * x2;
    let xy = x * y2;
    let xz = x * z2;
    let yy = y * y2;
    let yz = y * z2;
    let zz = z * z2;
    let wx = w * x2;
    let wy = w * y2;
    let wz = w * z2;

    // Column-major THREE.Matrix4
    out.extend_from_slice(&[
        (1.0 - (yy + zz)) * s[0],
        (xy + wz) * s[0],
        (xz - wy) * s[0],
        0.0,
        (xy - wz) * s[1],
        (1.0 - (xx + zz)) * s[1],
        (yz + wx) * s[1],
        0.0,
        (xz + wy) * s[2],
        (yz - wx) * s[2],
        (1.0 - (xx + yy)) * s[2],
        0.0,
        pos[0],
        pos[1],
        pos[2],
        1.0,
    ]);
}

/// Scatters up to 100,000 instance Matrix4 transforms onto a surface mesh in world space
/// using area-weighted triangle CDF, slope filtering, and O(1) spatial hash minimum spacing.
#[no_mangle]
pub extern "C" fn mesh_kernel_scatter_surface(
    pos_ptr: *const f32,
    pos_len: usize,
    idx_ptr: *const u32,
    idx_len: usize,
    surface_mat_ptr: *const f32,
    count: u32,
    seed: u64,
    min_scale: f32,
    max_scale: f32,
    align_normal: f32,
    min_normal_y: f32,
    min_spacing: f32,
) -> u32 {
    if pos_ptr.is_null() || pos_len < 9 || pos_len % 3 != 0 || count == 0 {
        get_buffers_mut().matrices.clear();
        return 0;
    }

    let capped_count = count.min(100_000) as usize;
    let raw_pos = unsafe { slice::from_raw_parts(pos_ptr, pos_len) };
    let v_count = pos_len / 3;

    let mat: [f32; 16] = if !surface_mat_ptr.is_null() {
        let s = unsafe { slice::from_raw_parts(surface_mat_ptr, 16) };
        let mut arr = [0.0f32; 16];
        arr.copy_from_slice(s);
        arr
    } else {
        [
            1.0, 0.0, 0.0, 0.0,
            0.0, 1.0, 0.0, 0.0,
            0.0, 0.0, 1.0, 0.0,
            0.0, 0.0, 0.0, 1.0,
        ]
    };

    let tri_count = if !idx_ptr.is_null() && idx_len >= 3 {
        idx_len / 3
    } else {
        v_count / 3
    };
    if tri_count == 0 {
        get_buffers_mut().matrices.clear();
        return 0;
    }

    struct ScatterTri {
        a: [f32; 3],
        b: [f32; 3],
        c: [f32; 3],
        normal: [f32; 3],
    }

    let mut valid_tris: Vec<ScatterTri> = Vec::with_capacity(tri_count);
    let mut cdf: Vec<f64> = Vec::with_capacity(tri_count);
    let mut total_area = 0.0f64;

    let raw_idx = if !idx_ptr.is_null() && idx_len >= 3 {
        Some(unsafe { slice::from_raw_parts(idx_ptr, tri_count * 3) })
    } else {
        None
    };

    for t in 0..tri_count {
        let (i0, i1, i2) = if let Some(idx) = raw_idx {
            (idx[t * 3] as usize, idx[t * 3 + 1] as usize, idx[t * 3 + 2] as usize)
        } else {
            (t * 3, t * 3 + 1, t * 3 + 2)
        };
        if i0 >= v_count || i1 >= v_count || i2 >= v_count {
            continue;
        }
        let pa = transform_point_mat4(&mat, [raw_pos[i0 * 3], raw_pos[i0 * 3 + 1], raw_pos[i0 * 3 + 2]]);
        let pb = transform_point_mat4(&mat, [raw_pos[i1 * 3], raw_pos[i1 * 3 + 1], raw_pos[i1 * 3 + 2]]);
        let pc = transform_point_mat4(&mat, [raw_pos[i2 * 3], raw_pos[i2 * 3 + 1], raw_pos[i2 * 3 + 2]]);

        let ux = pb[0] - pa[0];
        let uy = pb[1] - pa[1];
        let uz = pb[2] - pa[2];
        let vx = pc[0] - pa[0];
        let vy = pc[1] - pa[1];
        let vz = pc[2] - pa[2];
        let cx = uy * vz - uz * vy;
        let cy = uz * vx - ux * vz;
        let cz = ux * vy - uy * vx;
        let cross_len = (cx * cx + cy * cy + cz * cz).sqrt();
        if cross_len <= 1e-8 {
            continue;
        }
        let inv = 1.0 / cross_len;
        let mut nx = cx * inv;
        let mut ny = cy * inv;
        let mut nz = cz * inv;
        // Double-sided upward normal flip if terrain winding faces slightly downward? No: respect winding unless upside-down plane
        if ny < 0.0 && min_normal_y <= -1.0 {
            nx = -nx;
            ny = -ny;
            nz = -nz;
        }
        if ny < min_normal_y {
            continue;
        }
        total_area += (0.5 * cross_len) as f64;
        valid_tris.push(ScatterTri { a: pa, b: pb, c: pc, normal: [nx, ny, nz] });
        cdf.push(total_area);
    }

    let buf = get_buffers_mut();
    buf.matrices.clear();
    if valid_tris.is_empty() || total_area <= 0.0 {
        return 0;
    }

    buf.matrices.reserve(capped_count * 16);
    let mut rng = SplitMix64(seed ^ 0xA5A5_5A5A_F0F0_0F0F);
    let s_lo = min_scale.max(0.001);
    let s_hi = max_scale.max(s_lo);
    let align = align_normal.clamp(0.0, 1.0);
    let use_spacing = min_spacing > 1e-4;
    let spacing_sq = min_spacing * min_spacing;
    let inv_cell = if use_spacing { 1.0 / min_spacing } else { 1.0 };
    let mut grid: HashMap<(i32, i32, i32), Vec<[f32; 3]>> = if use_spacing {
        HashMap::with_capacity(capped_count)
    } else {
        HashMap::new()
    };

    let max_attempts = if use_spacing { capped_count * 6 } else { capped_count };
    let mut spawned = 0u32;

    for _ in 0..max_attempts {
        if spawned as usize >= capped_count {
            break;
        }
        let target_area = (rng.next_f32() as f64) * total_area;
        let tri_idx = match cdf.binary_search_by(|probe| probe.partial_cmp(&target_area).unwrap_or(Ordering::Equal)) {
            Ok(idx) => idx,
            Err(idx) => idx.min(valid_tris.len() - 1),
        };
        let tri = &valid_tris[tri_idx];

        let r1 = rng.next_f32().sqrt();
        let r2 = rng.next_f32();
        let w0 = 1.0 - r1;
        let w1 = r1 * (1.0 - r2);
        let w2 = r1 * r2;
        let px = w0 * tri.a[0] + w1 * tri.b[0] + w2 * tri.c[0];
        let py = w0 * tri.a[1] + w1 * tri.b[1] + w2 * tri.c[1];
        let pz = w0 * tri.a[2] + w1 * tri.b[2] + w2 * tri.c[2];

        if use_spacing {
            let gx = (px * inv_cell).floor() as i32;
            let gy = (py * inv_cell).floor() as i32;
            let gz = (pz * inv_cell).floor() as i32;
            let mut too_close = false;
            'cell_search: for dx in -1..=1 {
                for dy in -1..=1 {
                    for dz in -1..=1 {
                        if let Some(pts) = grid.get(&(gx + dx, gy + dy, gz + dz)) {
                            for p in pts {
                                let ddx = px - p[0];
                                let ddy = py - p[1];
                                let ddz = pz - p[2];
                                if ddx * ddx + ddy * ddy + ddz * ddz < spacing_sq {
                                    too_close = true;
                                    break 'cell_search;
                                }
                            }
                        }
                    }
                }
            }
            if too_close {
                continue;
            }
            grid.entry((gx, gy, gz)).or_default().push([px, py, pz]);
        }

        // Blended up vector between world +Y and surface normal
        let mut ux = tri.normal[0] * align;
        let mut uy = (1.0 - align) + tri.normal[1] * align;
        let mut uz = tri.normal[2] * align;
        let ulen = (ux * ux + uy * uy + uz * uz).sqrt().max(1e-8);
        ux /= ulen;
        uy /= ulen;
        uz /= ulen;

        let tilt_q = quat_from_unit_vectors([0.0, 1.0, 0.0], [ux, uy, uz]);
        let half_yaw = rng.next_f32() * std::f32::consts::PI;
        let yaw_q = [0.0, half_yaw.sin(), 0.0, half_yaw.cos()];
        let q = quat_mul(tilt_q, yaw_q);

        let sc = s_lo + rng.next_f32() * (s_hi - s_lo);
        // Subtle organic vertical variation (+/- 8%)
        let sy = sc * (0.92 + 0.16 * rng.next_f32());
        write_trs_matrix4(&mut buf.matrices, [px, py, pz], q, [sc, sy, sc]);
        spawned += 1;
    }

    spawned
}

/// Frustum-culls and partitions N instance matrices into 3 contiguous LOD buckets
/// `[LOD0 | LOD1 | LOD2]` in `out_matrices` and writes `[n0, n1, n2, n_culled]` to `lod_counts`.
#[no_mangle]
pub extern "C" fn mesh_kernel_cull_and_lod_instances(
    matrices_ptr: *const f32,
    instance_count: u32,
    planes_ptr: *const f32,
    cam_x: f32,
    cam_y: f32,
    cam_z: f32,
    base_radius: f32,
    lod1_dist: f32,
    lod2_dist: f32,
    max_dist: f32,
    lod_bias: f32,
) -> u32 {
    let buf = get_buffers_mut();
    buf.matrices.clear();
    buf.lod_counts = [0; 4];

    if matrices_ptr.is_null() || instance_count == 0 {
        return 0;
    }

    let n = instance_count as usize;
    let src = unsafe { slice::from_raw_parts(matrices_ptr, n * 16) };
    let has_planes = !planes_ptr.is_null();
    let planes: [f32; 24] = if has_planes {
        let p = unsafe { slice::from_raw_parts(planes_ptr, 24) };
        let mut arr = [0.0f32; 24];
        arr.copy_from_slice(p);
        arr
    } else {
        [0.0; 24]
    };

    let bias = lod_bias.clamp(0.1, 4.0);
    let d1 = (lod1_dist * bias).max(0.0);
    let d2 = (lod2_dist * bias).max(d1);
    let dmax = if max_dist > 0.0 { (max_dist * bias.sqrt()).max(d2) } else { f32::INFINITY };
    let d1_sq = d1 * d1;
    let d2_sq = d2 * d2;
    let dmax_sq = dmax * dmax;
    let r0 = base_radius.max(0.05);

    let mut b0: Vec<u32> = Vec::with_capacity(n / 2 + 1);
    let mut b1: Vec<u32> = Vec::with_capacity(n / 2 + 1);
    let mut b2: Vec<u32> = Vec::with_capacity(n / 2 + 1);
    let mut culled = 0u32;

    for i in 0..n {
        let base = i * 16;
        let tx = src[base + 12];
        let ty = src[base + 13];
        let tz = src[base + 14];

        let dx = tx - cam_x;
        let dy = ty - cam_y;
        let dz = tz - cam_z;
        let dist_sq = dx * dx + dy * dy + dz * dz;
        if dist_sq > dmax_sq {
            culled += 1;
            continue;
        }

        if has_planes {
            // Estimate max axis scale from columns 0..2
            let sx_sq = src[base] * src[base] + src[base + 1] * src[base + 1] + src[base + 2] * src[base + 2];
            let sy_sq = src[base + 4] * src[base + 4] + src[base + 5] * src[base + 5] + src[base + 6] * src[base + 6];
            let sz_sq = src[base + 8] * src[base + 8] + src[base + 9] * src[base + 9] + src[base + 10] * src[base + 10];
            let max_s = sx_sq.max(sy_sq).max(sz_sq).sqrt();
            let rad = r0 * max_s;

            let mut outside = false;
            for p in 0..6 {
                let po = p * 4;
                let signed_d = planes[po] * tx + planes[po + 1] * ty + planes[po + 2] * tz + planes[po + 3];
                if signed_d < -rad {
                    outside = true;
                    break;
                }
            }
            if outside {
                culled += 1;
                continue;
            }
        }

        if dist_sq < d1_sq {
            b0.push(i as u32);
        } else if dist_sq < d2_sq {
            b1.push(i as u32);
        } else {
            b2.push(i as u32);
        }
    }

    let total_vis = b0.len() + b1.len() + b2.len();
    buf.matrices.reserve(total_vis * 16);
    for &idx in b0.iter().chain(b1.iter()).chain(b2.iter()) {
        let off = (idx as usize) * 16;
        buf.matrices.extend_from_slice(&src[off..off + 16]);
    }
    buf.lod_counts = [b0.len() as u32, b1.len() as u32, b2.len() as u32, culled];

    total_vis as u32
}

// ---------------------------------------------------------------------------
// Unit Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    // WASM runtime is single-threaded and shares global output buffers across calls;
    // serialize host unit tests that assert against those static buffers.
    static KERNEL_TEST_LOCK: Mutex<()> = Mutex::new(());

    #[test]
    fn test_version() {
        assert_eq!(mesh_kernel_version(), 210);
    }

    #[test]
    fn test_weld_cube_faces() {
        let _guard = KERNEL_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let positions: [f32; 18] = [
            0.0, 0.0, 0.0,
            1.0, 0.0, 0.0,
            1.0, 1.0, 0.0,
            0.0, 0.0, 0.0,
            1.0, 1.0, 0.0,
            0.0, 1.0, 0.0,
        ];

        let ret = mesh_kernel_weld(
            positions.as_ptr(),
            positions.len(),
            std::ptr::null(),
            0,
            0.001,
        );
        assert_eq!(ret, 1);

        let out_verts_len = mesh_kernel_get_out_vertices_len();
        assert_eq!(out_verts_len, 12);

        let out_indices_len = mesh_kernel_get_out_indices_len();
        assert_eq!(out_indices_len, 6);

        let out_edges_len = mesh_kernel_get_out_edges_len();
        assert_eq!(out_edges_len, 10);
    }

    #[test]
    fn test_subdivide_triangle() {
        let _guard = KERNEL_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let positions: [f32; 9] = [
            0.0, 0.0, 0.0,
            2.0, 0.0, 0.0,
            0.0, 2.0, 0.0,
        ];
        let indices: [u32; 3] = [0, 1, 2];

        let ret = mesh_kernel_subdivide(
            positions.as_ptr(),
            positions.len(),
            indices.as_ptr(),
            indices.len(),
            0,
        );
        assert_eq!(ret, 1);

        assert_eq!(mesh_kernel_get_out_indices_len(), 12);
        assert_eq!(mesh_kernel_get_out_vertices_len(), 18);
    }

    #[test]
    fn test_sculpt_stroke_and_mask() {
        let mut pos: [f32; 9] = [0.0, 0.0, 0.0, 0.2, 0.0, 0.0, 1.0, 0.0, 0.0];
        let mut norm: [f32; 9] = [0.0, 1.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 0.0];
        let mut mask: [f32; 3] = [0.0, 1.0, 0.0];
        let cands: [u32; 3] = [0, 1, 2];

        // Draw at origin with radius 0.5: vertex 0 moves +Y, vertex 1 masked (stays 0), vertex 2 outside radius
        let touched = mesh_kernel_sculpt_stroke(
            pos.as_mut_ptr(),
            norm.as_mut_ptr(),
            mask.as_mut_ptr(),
            std::ptr::null(),
            3,
            cands.as_ptr(),
            3,
            0, // draw
            0.0,
            0.0,
            0.0,
            0.0,
            1.0,
            0.0,
            0.0,
            0.0,
            0.0,
            0.5,
            1.0,
            1.0,
        );
        assert_eq!(touched, 1);
        assert!(pos[1] > 0.01);
        assert_eq!(pos[4], 0.0);
        assert_eq!(pos[7], 0.0);
    }

    #[test]
    fn test_voxel_remesh() {
        let _guard = KERNEL_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        // 2x2x2 coarse cube corners (2 tris on 1 quad spanning length 2.0)
        let pos: [f32; 12] = [
            -1.0, 0.0, -1.0, 1.0, 0.0, -1.0, 1.0, 0.0, 1.0, -1.0, 0.0, 1.0,
        ];
        let idx: [u32; 6] = [0, 1, 2, 0, 2, 3];
        let ret = mesh_kernel_voxel_remesh(pos.as_ptr(), pos.len(), idx.as_ptr(), idx.len(), 0.25);
        assert_eq!(ret, 1);
        assert!(mesh_kernel_get_out_indices_len() > 24);
        assert_eq!(
            mesh_kernel_get_out_normals_len(),
            mesh_kernel_get_out_vertices_len()
        );
    }

    #[test]
    fn test_qem_simplify_grid_and_uvs() {
        let _guard = KERNEL_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        // 10x10 UV grid = 121 vertices, 200 triangles
        let n = 10usize;
        let mut pos = Vec::new();
        let mut uvs = Vec::new();
        let mut idx = Vec::new();
        for y in 0..=n {
            for x in 0..=n {
                let u = x as f32 / n as f32;
                let v = y as f32 / n as f32;
                pos.extend_from_slice(&[u * 4.0 - 2.0, (u * 3.14).sin() * 0.3, v * 4.0 - 2.0]);
                uvs.extend_from_slice(&[u, v]);
            }
        }
        let stride = (n + 1) as u32;
        for y in 0..n as u32 {
            for x in 0..n as u32 {
                let a = y * stride + x;
                let b = a + 1;
                let c = a + stride;
                let d = c + 1;
                idx.extend_from_slice(&[a, c, b, b, c, d]);
            }
        }

        let ok = mesh_kernel_qem_simplify(
            pos.as_ptr(),
            pos.len(),
            uvs.as_ptr(),
            uvs.len(),
            idx.as_ptr(),
            idx.len(),
            0.25,
            1,
        );
        assert_eq!(ok, 1);
        let out_tris = mesh_kernel_get_out_indices_len() / 3;
        assert!(out_tris <= 55 && out_tris >= 40, "unexpected out_tris={}", out_tris);
        assert_eq!(
            mesh_kernel_get_out_uvs_len() / 2,
            mesh_kernel_get_out_vertices_len() / 3
        );
    }

    #[test]
    fn test_scatter_and_cull_lod_instances() {
        let _guard = KERNEL_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let pos: [f32; 12] = [
            -10.0, 0.0, -10.0,
             10.0, 0.0, -10.0,
             10.0, 0.0,  10.0,
            -10.0, 0.0,  10.0,
        ];
        let idx: [u32; 6] = [0, 2, 1, 0, 3, 2];
        let spawned = mesh_kernel_scatter_surface(
            pos.as_ptr(),
            pos.len(),
            idx.as_ptr(),
            idx.len(),
            std::ptr::null(),
            500,
            42,
            0.8,
            1.2,
            1.0,
            0.5,
            0.4,
        );
        assert!(spawned > 200 && spawned <= 500, "spawned={}", spawned);
        assert_eq!(mesh_kernel_get_out_matrices_len(), (spawned as usize) * 16);

        let all_mats = unsafe {
            slice::from_raw_parts(
                mesh_kernel_get_out_matrices_ptr(),
                mesh_kernel_get_out_matrices_len(),
            )
        }
        .to_vec();

        let vis = mesh_kernel_cull_and_lod_instances(
            all_mats.as_ptr(),
            spawned,
            std::ptr::null(),
            0.0,
            0.0,
            0.0,
            0.5,
            4.0,
            8.0,
            12.0,
            1.0,
        );
        let counts = unsafe { slice::from_raw_parts(mesh_kernel_get_out_lod_counts_ptr(), 4) };
        assert_eq!(counts[0] + counts[1] + counts[2], vis);
        assert_eq!(vis + counts[3], spawned);
    }
}
