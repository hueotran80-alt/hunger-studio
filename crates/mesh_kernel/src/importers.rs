//! High-Performance Multi-Format DCC, Studio & CAD 3D Importers in Pure Rust (WASM)
//!
//! Supported formats (`format_id`):
//!   1 = Wavefront `.obj` + `.mtl` (including ZBrush `#MRGB` polypaint & `v x y z r g b`)
//!   2 = Autodesk 3ds Max `.3ds` (Binary chunk hierarchy `0x4D4D` + materials + Z-up -> Y-up)
//!   3 = MagicaVoxel `.vox` (Binary RIFF `VOX ` v150/v200 + palette RGBA + 6-neighbor face culling)
//!   4 = Pixar / Apple USD `.usda` (`Mesh` prims, `primvars:st`, `displayColor`, `UsdPreviewSurface`)
//!   5 = AutoCAD / Rhino `.dxf` (`3DFACE` & Polyface `POLYLINE`/`VERTEX` + ACI colors + layers)
//!   6 = 3MF `.3mf` (`3dmodel.model` XML `<vertices>`, `<triangles>`, `<basematerials>`)
//!   7 = Geomview / CGAL / Houdini `.off` / `COFF` (vertices, N-gon faces, per-vertex/face colors)
//!   8 = Collada `.dae` (Maya / Cinema 4D / SketchUp XML `<mesh>`, `<triangles>`/`<polylist>`, materials & images)

use std::cell::UnsafeCell;
use std::collections::HashMap;
use std::slice;

#[derive(Clone, Debug)]
pub struct ParsedMaterial {
    pub name: String,
    pub color: [f32; 3],
    pub emissive: [f32; 3],
    pub roughness: f32,
    pub metalness: f32,
    pub opacity: f32,
    pub double_sided: bool,
    pub map_kd: String,
    pub map_normal: String,
    pub map_roughness: String,
    pub map_metallic: String,
    pub map_emissive: String,
    pub map_alpha: String,
}

impl Default for ParsedMaterial {
    fn default() -> Self {
        Self {
            name: "Material".to_string(),
            color: [0.82, 0.84, 0.86],
            emissive: [0.0, 0.0, 0.0],
            roughness: 0.55,
            metalness: 0.05,
            opacity: 1.0,
            double_sided: false,
            map_kd: String::new(),
            map_normal: String::new(),
            map_roughness: String::new(),
            map_metallic: String::new(),
            map_emissive: String::new(),
            map_alpha: String::new(),
        }
    }
}

#[derive(Clone, Debug)]
pub struct ParsedSubmesh {
    pub name: String,
    pub index_start: u32,
    pub index_count: u32,
    pub material_index: i32,
    pub has_vertex_colors: bool,
}

pub struct ImportOutput {
    pub positions: Vec<f32>,
    pub normals: Vec<f32>,
    pub uvs: Vec<f32>,
    pub colors: Vec<f32>,
    pub indices: Vec<u32>,
    pub meta_json: Vec<u8>,
}

thread_local! {
    static IMPORT_OUT: UnsafeCell<ImportOutput> = UnsafeCell::new(ImportOutput {
        positions: Vec::new(),
        normals: Vec::new(),
        uvs: Vec::new(),
        colors: Vec::new(),
        indices: Vec::new(),
        meta_json: Vec::new(),
    });
}

#[inline(always)]
fn out_mut() -> &'static mut ImportOutput {
    IMPORT_OUT.with(|cell| unsafe { &mut *cell.get() })
}

#[inline(always)]
fn out_ref() -> &'static ImportOutput {
    IMPORT_OUT.with(|cell| unsafe { &*cell.get() })
}

#[no_mangle]
pub extern "C" fn mesh_kernel_import_get_positions_ptr() -> *const f32 {
    out_ref().positions.as_ptr()
}
#[no_mangle]
pub extern "C" fn mesh_kernel_import_get_positions_len() -> usize {
    out_ref().positions.len()
}
#[no_mangle]
pub extern "C" fn mesh_kernel_import_get_normals_ptr() -> *const f32 {
    out_ref().normals.as_ptr()
}
#[no_mangle]
pub extern "C" fn mesh_kernel_import_get_normals_len() -> usize {
    out_ref().normals.len()
}
#[no_mangle]
pub extern "C" fn mesh_kernel_import_get_uvs_ptr() -> *const f32 {
    out_ref().uvs.as_ptr()
}
#[no_mangle]
pub extern "C" fn mesh_kernel_import_get_uvs_len() -> usize {
    out_ref().uvs.len()
}
#[no_mangle]
pub extern "C" fn mesh_kernel_import_get_colors_ptr() -> *const f32 {
    out_ref().colors.as_ptr()
}
#[no_mangle]
pub extern "C" fn mesh_kernel_import_get_colors_len() -> usize {
    out_ref().colors.len()
}
#[no_mangle]
pub extern "C" fn mesh_kernel_import_get_indices_ptr() -> *const u32 {
    out_ref().indices.as_ptr()
}
#[no_mangle]
pub extern "C" fn mesh_kernel_import_get_indices_len() -> usize {
    out_ref().indices.len()
}
#[no_mangle]
pub extern "C" fn mesh_kernel_import_get_meta_ptr() -> *const u8 {
    out_ref().meta_json.as_ptr()
}
#[no_mangle]
pub extern "C" fn mesh_kernel_import_get_meta_len() -> usize {
    out_ref().meta_json.len()
}

/// Main FFI entry point for parsing DCC / Studio / CAD formats in Rust WASM.
/// Returns number of triangles parsed (`> 0` on success, `0` on invalid/empty input).
#[no_mangle]
pub extern "C" fn mesh_kernel_import_dcc(
    format_id: u32,
    data_ptr: *const u8,
    data_len: usize,
    aux_ptr: *const u8,
    aux_len: usize,
) -> u32 {
    let out = out_mut();
    out.positions.clear();
    out.normals.clear();
    out.uvs.clear();
    out.colors.clear();
    out.indices.clear();
    out.meta_json.clear();

    if data_ptr.is_null() || data_len == 0 {
        return 0;
    }
    let data = unsafe { slice::from_raw_parts(data_ptr, data_len) };
    let aux = if !aux_ptr.is_null() && aux_len > 0 {
        unsafe { slice::from_raw_parts(aux_ptr, aux_len) }
    } else {
        &[]
    };

    let mut materials: Vec<ParsedMaterial> = Vec::new();
    let mut submeshes: Vec<ParsedSubmesh> = Vec::new();

    let fmt_name = match format_id {
        1 => {
            parse_obj_and_mtl(data, aux, out, &mut materials, &mut submeshes);
            "obj"
        }
        2 => {
            parse_3ds_binary(data, out, &mut materials, &mut submeshes);
            "3ds"
        }
        3 => {
            parse_magicavoxel_vox(data, out, &mut materials, &mut submeshes);
            "vox"
        }
        4 => {
            parse_usda_ascii(data, out, &mut materials, &mut submeshes);
            "usda"
        }
        5 => {
            parse_dxf_ascii(data, out, &mut materials, &mut submeshes);
            "dxf"
        }
        6 => {
            parse_3mf_model_xml(data, out, &mut materials, &mut submeshes);
            "3mf"
        }
        7 => {
            parse_off_ascii(data, out, &mut materials, &mut submeshes);
            "off"
        }
        8 => {
            parse_collada_dae(data, out, &mut materials, &mut submeshes);
            "dae"
        }
        _ => return 0,
    };

    let vert_count = out.positions.len() / 3;
    let tri_count = out.indices.len() / 3;
    if vert_count == 0 || tri_count == 0 {
        return 0;
    }

    if out.normals.len() != out.positions.len() {
        compute_smooth_normals(&out.positions, &out.indices, &mut out.normals);
    }

    if submeshes.is_empty() {
        submeshes.push(ParsedSubmesh {
            name: "Imported_Mesh".to_string(),
            index_start: 0,
            index_count: out.indices.len() as u32,
            material_index: if materials.is_empty() { -1 } else { 0 },
            has_vertex_colors: out.colors.len() == out.positions.len(),
        });
    }

    out.meta_json = serialize_meta_json(fmt_name, &materials, &submeshes).into_bytes();
    tri_count as u32
}

// ===========================================================================
// SHARED HELPERS: Normals, JSON Escaping, sRGB -> Linear
// ===========================================================================

#[inline]
fn srgb_u8_to_linear(c: u8) -> f32 {
    let x = (c as f32) / 255.0;
    if x <= 0.04045 {
        x / 12.92
    } else {
        ((x + 0.055) / 1.055).powf(2.4)
    }
}

fn compute_smooth_normals(positions: &[f32], indices: &[u32], normals: &mut Vec<f32>) {
    normals.clear();
    normals.resize(positions.len(), 0.0);
    let v_count = positions.len() / 3;
    for tri in indices.chunks_exact(3) {
        let i0 = tri[0] as usize;
        let i1 = tri[1] as usize;
        let i2 = tri[2] as usize;
        if i0 >= v_count || i1 >= v_count || i2 >= v_count {
            continue;
        }
        let ax = positions[i0 * 3];
        let ay = positions[i0 * 3 + 1];
        let az = positions[i0 * 3 + 2];
        let bx = positions[i1 * 3] - ax;
        let by = positions[i1 * 3 + 1] - ay;
        let bz = positions[i1 * 3 + 2] - az;
        let cx = positions[i2 * 3] - ax;
        let cy = positions[i2 * 3 + 1] - ay;
        let cz = positions[i2 * 3 + 2] - az;
        let nx = by * cz - bz * cy;
        let ny = bz * cx - bx * cz;
        let nz = bx * cy - by * cx;
        for &vi in &[i0, i1, i2] {
            normals[vi * 3] += nx;
            normals[vi * 3 + 1] += ny;
            normals[vi * 3 + 2] += nz;
        }
    }
    for n in normals.chunks_exact_mut(3) {
        let len = (n[0] * n[0] + n[1] * n[1] + n[2] * n[2]).sqrt();
        if len > 1e-12 {
            n[0] /= len;
            n[1] /= len;
            n[2] /= len;
        } else {
            n[1] = 1.0;
        }
    }
}

fn json_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 4);
    for ch in s.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => {}
            c => out.push(c),
        }
    }
    out
}

fn serialize_meta_json(fmt: &str, materials: &[ParsedMaterial], submeshes: &[ParsedSubmesh]) -> String {
    let mut j = String::with_capacity(512 + materials.len() * 180 + submeshes.len() * 96);
    j.push_str("{\"format\":\"");
    j.push_str(fmt);
    j.push_str("\",\"materials\":[");
    for (i, m) in materials.iter().enumerate() {
        if i > 0 {
            j.push(',');
        }
        j.push_str(&format!(
            "{{\"name\":\"{}\",\"color\":[{:.5},{:.5},{:.5}],\"emissive\":[{:.5},{:.5},{:.5}],\"roughness\":{:.4},\"metalness\":{:.4},\"opacity\":{:.4},\"doubleSided\":{},\"mapKd\":\"{}\",\"mapNormal\":\"{}\",\"mapRoughness\":\"{}\",\"mapMetallic\":\"{}\",\"mapEmissive\":\"{}\",\"mapAlpha\":\"{}\"}}",
            json_escape(&m.name),
            m.color[0], m.color[1], m.color[2],
            m.emissive[0], m.emissive[1], m.emissive[2],
            m.roughness, m.metalness, m.opacity,
            if m.double_sided { "true" } else { "false" },
            json_escape(&m.map_kd),
            json_escape(&m.map_normal),
            json_escape(&m.map_roughness),
            json_escape(&m.map_metallic),
            json_escape(&m.map_emissive),
            json_escape(&m.map_alpha),
        ));
    }
    j.push_str("],\"submeshes\":[");
    for (i, s) in submeshes.iter().enumerate() {
        if i > 0 {
            j.push(',');
        }
        j.push_str(&format!(
            "{{\"name\":\"{}\",\"indexStart\":{},\"indexCount\":{},\"materialIndex\":{},\"hasVertexColors\":{}}}",
            json_escape(&s.name),
            s.index_start,
            s.index_count,
            s.material_index,
            if s.has_vertex_colors { "true" } else { "false" },
        ));
    }
    j.push_str("]}");
    j
}

// ===========================================================================
// 1. WAVEFRONT OBJ + MTL + ZBRUSH #MRGB POLYPAINT PARSER
// ===========================================================================

fn extract_mtl_texture_path(rest: &str) -> String {
    // Strip standard MTL texture options like `-bm 1.0`, `-s 1 1 1`, `-o 0 0 0`, `-clamp on`
    let tokens: Vec<&str> = rest.split_whitespace().collect();
    let mut i = 0;
    while i < tokens.len() {
        let t = tokens[i];
        if t.starts_with('-') {
            let skip = match t {
                "-s" | "-o" | "-t" => 3,
                "-mm" => 2,
                "-bm" | "-boost" | "-texres" | "-clamp" | "-blendu" | "-blendv" | "-imfchan" | "-type" => 1,
                _ => 1,
            };
            i += 1 + skip;
        } else {
            return tokens[i..].join(" ");
        }
    }
    rest.trim().to_string()
}

fn parse_mtl_bytes(mtl_bytes: &[u8], materials: &mut Vec<ParsedMaterial>, mat_lookup: &mut HashMap<String, i32>) {
    if mtl_bytes.is_empty() {
        return;
    }
    let text = String::from_utf8_lossy(mtl_bytes);
    let mut cur: Option<ParsedMaterial> = None;

    for raw_line in text.lines() {
        let line = raw_line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let mut parts = line.splitn(2, char::is_whitespace);
        let kw = parts.next().unwrap_or("");
        let rest = parts.next().unwrap_or("").trim();

        if kw.eq_ignore_ascii_case("newmtl") {
            if let Some(m) = cur.take() {
                let idx = materials.len() as i32;
                mat_lookup.insert(m.name.clone(), idx);
                materials.push(m);
            }
            cur = Some(ParsedMaterial {
                name: if rest.is_empty() { "Material".to_string() } else { rest.to_string() },
                color: [0.85, 0.85, 0.85],
                ..Default::default()
            });
            continue;
        }

        let Some(m) = cur.as_mut() else { continue };
        let lower = kw.to_ascii_lowercase();
        match lower.as_str() {
            "kd" => {
                let nums: Vec<f32> = rest.split_whitespace().filter_map(|s| s.parse().ok()).collect();
                if nums.len() >= 3 {
                    m.color = [nums[0], nums[1], nums[2]];
                }
            }
            "ke" => {
                let nums: Vec<f32> = rest.split_whitespace().filter_map(|s| s.parse().ok()).collect();
                if nums.len() >= 3 {
                    m.emissive = [nums[0], nums[1], nums[2]];
                }
            }
            "ns" => {
                if let Ok(ns) = rest.split_whitespace().next().unwrap_or("0").parse::<f32>() {
                    m.roughness = (1.0 - (ns.clamp(0.0, 1000.0) / 1000.0).sqrt()).clamp(0.04, 1.0);
                }
            }
            "pr" => {
                if let Ok(pr) = rest.split_whitespace().next().unwrap_or("0.5").parse::<f32>() {
                    m.roughness = pr.clamp(0.0, 1.0);
                }
            }
            "pm" => {
                if let Ok(pm) = rest.split_whitespace().next().unwrap_or("0").parse::<f32>() {
                    m.metalness = pm.clamp(0.0, 1.0);
                }
            }
            "d" => {
                if let Ok(d) = rest.split_whitespace().next().unwrap_or("1").parse::<f32>() {
                    m.opacity = d.clamp(0.0, 1.0);
                }
            }
            "tr" => {
                if let Ok(tr) = rest.split_whitespace().next().unwrap_or("0").parse::<f32>() {
                    m.opacity = (1.0 - tr).clamp(0.0, 1.0);
                }
            }
            "map_kd" => m.map_kd = extract_mtl_texture_path(rest),
            "map_bump" | "bump" | "norm" | "map_kn" => m.map_normal = extract_mtl_texture_path(rest),
            "map_pr" | "map_ns" => m.map_roughness = extract_mtl_texture_path(rest),
            "map_pm" | "map_ks" | "refl" => m.map_metallic = extract_mtl_texture_path(rest),
            "map_ke" => m.map_emissive = extract_mtl_texture_path(rest),
            "map_d" => {
                m.map_alpha = extract_mtl_texture_path(rest);
                m.double_sided = true;
            }
            _ => {}
        }
    }

    if let Some(m) = cur.take() {
        let idx = materials.len() as i32;
        mat_lookup.insert(m.name.clone(), idx);
        materials.push(m);
    }
}

#[inline]
fn hex_nibble(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

fn parse_obj_idx(tok: &str, len: usize) -> u32 {
    if tok.is_empty() || len == 0 {
        return 0;
    }
    if let Ok(v) = tok.parse::<i64>() {
        if v > 0 {
            let idx = (v as usize).saturating_sub(1);
            idx.min(len - 1) as u32
        } else if v < 0 {
            let rel = (len as i64) + v;
            rel.max(0).min((len - 1) as i64) as u32
        } else {
            0
        }
    } else {
        0
    }
}

fn parse_obj_and_mtl(
    obj_bytes: &[u8],
    mtl_bytes: &[u8],
    out: &mut ImportOutput,
    materials: &mut Vec<ParsedMaterial>,
    submeshes: &mut Vec<ParsedSubmesh>,
) {
    let mut mat_lookup: HashMap<String, i32> = HashMap::new();
    parse_mtl_bytes(mtl_bytes, materials, &mut mat_lookup);

    let mut raw_pos: Vec<[f32; 3]> = Vec::new();
    let mut raw_col: Vec<[f32; 3]> = Vec::new();
    let mut has_any_vcol = false;
    let mut mrgb_cursor: usize = 0;
    let mut raw_uv: Vec<[f32; 2]> = Vec::new();
    let mut raw_norm: Vec<[f32; 3]> = Vec::new();

    let mut cur_name = "OBJ_Mesh".to_string();
    let mut cur_mat_idx: i32 = if materials.is_empty() { -1 } else { 0 };
    let mut sub_index_start: u32 = 0;

    // De-index map `(pos_idx+1, uv_idx+1, norm_idx+1)` -> output vertex index
    let mut vert_cache: HashMap<(u32, u32, u32), u32> = HashMap::new();
    let mut any_uv_used = false;
    let mut any_norm_used = false;

    let flush_submesh = |submeshes: &mut Vec<ParsedSubmesh>,
                         indices_len: u32,
                         sub_start: &mut u32,
                         name: &str,
                         mat_idx: i32,
                         has_vc: bool| {
        if indices_len > *sub_start {
            submeshes.push(ParsedSubmesh {
                name: name.to_string(),
                index_start: *sub_start,
                index_count: indices_len - *sub_start,
                material_index: mat_idx,
                has_vertex_colors: has_vc,
            });
            *sub_start = indices_len;
        }
    };

    let text = String::from_utf8_lossy(obj_bytes);
    let mut corner_verts: Vec<u32> = Vec::with_capacity(8);

    for raw_line in text.lines() {
        let line = raw_line.trim();
        if line.is_empty() {
            continue;
        }
        // ZBrush Polypaint extension: `#MRGB MMRRGGBBMMRRGGBB...`
        if let Some(hex_str) = line.strip_prefix("#MRGB") {
            let hex = hex_str.trim().as_bytes();
            let chunks = hex.len() / 8;
            if chunks > 0 {
                has_any_vcol = true;
                if raw_col.len() < raw_pos.len() {
                    raw_col.resize(raw_pos.len(), [1.0, 1.0, 1.0]);
                }
                for c in 0..chunks {
                    let b = &hex[c * 8..c * 8 + 8];
                    if let (Some(r1), Some(r0), Some(g1), Some(g0), Some(b1), Some(b0)) = (
                        hex_nibble(b[2]), hex_nibble(b[3]),
                        hex_nibble(b[4]), hex_nibble(b[5]),
                        hex_nibble(b[6]), hex_nibble(b[7]),
                    ) {
                        let rgb = [
                            srgb_u8_to_linear((r1 << 4) | r0),
                            srgb_u8_to_linear((g1 << 4) | g0),
                            srgb_u8_to_linear((b1 << 4) | b0),
                        ];
                        if mrgb_cursor < raw_col.len() {
                            raw_col[mrgb_cursor] = rgb;
                        } else {
                            raw_col.push(rgb);
                        }
                        mrgb_cursor += 1;
                    }
                }
            }
            continue;
        }
        if line.starts_with('#') {
            continue;
        }

        let mut sp = line.split_whitespace();
        let Some(kw) = sp.next() else { continue };

        match kw {
            "v" => {
                let nums: Vec<f32> = sp.filter_map(|s| s.parse().ok()).collect();
                if nums.len() >= 3 {
                    raw_pos.push([nums[0], nums[1], nums[2]]);
                    if nums.len() >= 6 {
                        has_any_vcol = true;
                        let scale = if nums[3] > 1.001 || nums[4] > 1.001 || nums[5] > 1.001 {
                            1.0 / 255.0
                        } else {
                            1.0
                        };
                        raw_col.push([nums[3] * scale, nums[4] * scale, nums[5] * scale]);
                    } else if has_any_vcol {
                        raw_col.push([1.0, 1.0, 1.0]);
                    }
                }
            }
            "vt" => {
                let u: f32 = sp.next().and_then(|s| s.parse().ok()).unwrap_or(0.0);
                let v: f32 = sp.next().and_then(|s| s.parse().ok()).unwrap_or(0.0);
                raw_uv.push([u, v]);
            }
            "vn" => {
                let x: f32 = sp.next().and_then(|s| s.parse().ok()).unwrap_or(0.0);
                let y: f32 = sp.next().and_then(|s| s.parse().ok()).unwrap_or(1.0);
                let z: f32 = sp.next().and_then(|s| s.parse().ok()).unwrap_or(0.0);
                raw_norm.push([x, y, z]);
            }
            "o" | "g" => {
                let next_name: String = sp.collect::<Vec<&str>>().join("_");
                if !next_name.is_empty() && next_name != cur_name {
                    flush_submesh(
                        submeshes,
                        out.indices.len() as u32,
                        &mut sub_index_start,
                        &cur_name,
                        cur_mat_idx,
                        has_any_vcol,
                    );
                    cur_name = next_name;
                }
            }
            "usemtl" => {
                let mat_name = sp.collect::<Vec<&str>>().join(" ");
                if !mat_name.is_empty() {
                    let next_mat = if let Some(&idx) = mat_lookup.get(&mat_name) {
                        idx
                    } else {
                        let idx = materials.len() as i32;
                        materials.push(ParsedMaterial {
                            name: mat_name.clone(),
                            ..Default::default()
                        });
                        mat_lookup.insert(mat_name, idx);
                        idx
                    };
                    if next_mat != cur_mat_idx {
                        flush_submesh(
                            submeshes,
                            out.indices.len() as u32,
                            &mut sub_index_start,
                            &cur_name,
                            cur_mat_idx,
                            has_any_vcol,
                        );
                        cur_mat_idx = next_mat;
                    }
                }
            }
            "f" => {
                if raw_pos.is_empty() {
                    continue;
                }
                corner_verts.clear();
                for corner in sp {
                    let mut slash = corner.split('/');
                    let p_str = slash.next().unwrap_or("");
                    let t_str = slash.next().unwrap_or("");
                    let n_str = slash.next().unwrap_or("");

                    let pi = parse_obj_idx(p_str, raw_pos.len());
                    let ti = if !t_str.is_empty() && !raw_uv.is_empty() {
                        any_uv_used = true;
                        parse_obj_idx(t_str, raw_uv.len()) + 1
                    } else {
                        0
                    };
                    let ni = if !n_str.is_empty() && !raw_norm.is_empty() {
                        any_norm_used = true;
                        parse_obj_idx(n_str, raw_norm.len()) + 1
                    } else {
                        0
                    };

                    let key = (pi + 1, ti, ni);
                    let out_vi = if let Some(&existing) = vert_cache.get(&key) {
                        existing
                    } else {
                        let idx = (out.positions.len() / 3) as u32;
                        let p = raw_pos[pi as usize];
                        out.positions.extend_from_slice(&p);

                        let uv = if ti > 0 { raw_uv[(ti - 1) as usize] } else { [0.0, 0.0] };
                        out.uvs.extend_from_slice(&uv);

                        let nm = if ni > 0 { raw_norm[(ni - 1) as usize] } else { [0.0, 1.0, 0.0] };
                        out.normals.extend_from_slice(&nm);

                        let vc = if (pi as usize) < raw_col.len() {
                            raw_col[pi as usize]
                        } else {
                            [1.0, 1.0, 1.0]
                        };
                        out.colors.extend_from_slice(&vc);

                        vert_cache.insert(key, idx);
                        idx
                    };
                    corner_verts.push(out_vi);
                }

                if corner_verts.len() >= 3 {
                    let v0 = corner_verts[0];
                    for k in 1..(corner_verts.len() - 1) {
                        out.indices.push(v0);
                        out.indices.push(corner_verts[k]);
                        out.indices.push(corner_verts[k + 1]);
                    }
                }
            }
            _ => {}
        }
    }

    flush_submesh(
        submeshes,
        out.indices.len() as u32,
        &mut sub_index_start,
        &cur_name,
        cur_mat_idx,
        has_any_vcol,
    );

    if !any_uv_used {
        out.uvs.clear();
    }
    if !any_norm_used {
        out.normals.clear();
    }
    if !has_any_vcol {
        out.colors.clear();
    }
}

// ===========================================================================
// 2. AUTODESK 3DS MAX (.3ds) BINARY CHUNK PARSER
// ===========================================================================

#[inline]
fn read_u16_le(d: &[u8], off: usize) -> u16 {
    if off + 2 <= d.len() {
        u16::from_le_bytes([d[off], d[off + 1]])
    } else {
        0
    }
}

#[inline]
fn read_u32_le(d: &[u8], off: usize) -> u32 {
    if off + 4 <= d.len() {
        u32::from_le_bytes([d[off], d[off + 1], d[off + 2], d[off + 3]])
    } else {
        0
    }
}

#[inline]
fn read_f32_le(d: &[u8], off: usize) -> f32 {
    if off + 4 <= d.len() {
        f32::from_le_bytes([d[off], d[off + 1], d[off + 2], d[off + 3]])
    } else {
        0.0
    }
}

fn read_cstring(d: &[u8], start: usize, end: usize) -> (String, usize) {
    let mut pos = start;
    while pos < end && d[pos] != 0 {
        pos += 1;
    }
    let s = String::from_utf8_lossy(&d[start..pos]).to_string();
    let next = if pos < end { pos + 1 } else { end };
    (s, next)
}

fn parse_3ds_color_chunk(d: &[u8], start: usize, end: usize) -> [f32; 3] {
    let mut off = start;
    while off + 6 <= end {
        let cid = read_u16_le(d, off);
        let clen = read_u32_le(d, off + 2) as usize;
        if clen < 6 || off + clen > end {
            break;
        }
        if (cid == 0x0011 || cid == 0x0012) && off + 9 <= off + clen {
            return [
                srgb_u8_to_linear(d[off + 6]),
                srgb_u8_to_linear(d[off + 7]),
                srgb_u8_to_linear(d[off + 8]),
            ];
        } else if (cid == 0x0010 || cid == 0x0013) && off + 18 <= off + clen {
            return [
                read_f32_le(d, off + 6),
                read_f32_le(d, off + 10),
                read_f32_le(d, off + 14),
            ];
        }
        off += clen;
    }
    [0.8, 0.8, 0.8]
}

fn parse_3ds_map_chunk(d: &[u8], start: usize, end: usize) -> String {
    let mut off = start;
    while off + 6 <= end {
        let cid = read_u16_le(d, off);
        let clen = read_u32_le(d, off + 2) as usize;
        if clen < 6 || off + clen > end {
            break;
        }
        if cid == 0xA300 {
            let (name, _) = read_cstring(d, off + 6, off + clen);
            return name;
        }
        off += clen;
    }
    String::new()
}

fn parse_3ds_binary(
    data: &[u8],
    out: &mut ImportOutput,
    materials: &mut Vec<ParsedMaterial>,
    submeshes: &mut Vec<ParsedSubmesh>,
) {
    if data.len() < 12 || read_u16_le(data, 0) != 0x4D4D {
        return;
    }
    let main_end = (read_u32_le(data, 2) as usize).min(data.len());
    let mut mat_lookup: HashMap<String, i32> = HashMap::new();
    let mut has_any_uv = false;

    let mut main_off = 6;
    while main_off + 6 <= main_end {
        let cid = read_u16_le(data, main_off);
        let clen = read_u32_le(data, main_off + 2) as usize;
        if clen < 6 || main_off + clen > main_end {
            break;
        }
        if cid == 0x3D3D {
            let edit_end = main_off + clen;
            let mut e_off = main_off + 6;
            while e_off + 6 <= edit_end {
                let ecid = read_u16_le(data, e_off);
                let eclen = read_u32_le(data, e_off + 2) as usize;
                if eclen < 6 || e_off + eclen > edit_end {
                    break;
                }
                let e_chunk_end = e_off + eclen;

                if ecid == 0xAFFF {
                    // MAT_ENTRY
                    let mut mat = ParsedMaterial::default();
                    let mut m_off = e_off + 6;
                    while m_off + 6 <= e_chunk_end {
                        let mcid = read_u16_le(data, m_off);
                        let mclen = read_u32_le(data, m_off + 2) as usize;
                        if mclen < 6 || m_off + mclen > e_chunk_end {
                            break;
                        }
                        match mcid {
                            0xA000 => {
                                let (n, _) = read_cstring(data, m_off + 6, m_off + mclen);
                                if !n.is_empty() {
                                    mat.name = n;
                                }
                            }
                            0xA020 => mat.color = parse_3ds_color_chunk(data, m_off + 6, m_off + mclen),
                            0xA200 => mat.map_kd = parse_3ds_map_chunk(data, m_off + 6, m_off + mclen),
                            0xA230 => mat.map_normal = parse_3ds_map_chunk(data, m_off + 6, m_off + mclen),
                            _ => {}
                        }
                        m_off += mclen;
                    }
                    let idx = materials.len() as i32;
                    mat_lookup.insert(mat.name.clone(), idx);
                    materials.push(mat);
                } else if ecid == 0x4000 {
                    // EDIT_OBJECT
                    let (obj_name, mut o_off) = read_cstring(data, e_off + 6, e_chunk_end);
                    while o_off + 6 <= e_chunk_end {
                        let ocid = read_u16_le(data, o_off);
                        let oclen = read_u32_le(data, o_off + 2) as usize;
                        if oclen < 6 || o_off + oclen > e_chunk_end {
                            break;
                        }
                        if ocid == 0x4100 {
                            // OBJ_TRIMESH
                            let tri_end = o_off + oclen;
                            let mut t_off = o_off + 6;
                            let mut local_verts: Vec<[f32; 3]> = Vec::new();
                            let mut local_uvs: Vec<[f32; 2]> = Vec::new();
                            let mut local_faces: Vec<[u32; 3]> = Vec::new();
                            let mut face_mat: Vec<i32> = Vec::new();

                            while t_off + 6 <= tri_end {
                                let tcid = read_u16_le(data, t_off);
                                let tclen = read_u32_le(data, t_off + 2) as usize;
                                if tclen < 6 || t_off + tclen > tri_end {
                                    break;
                                }
                                let t_chunk_end = t_off + tclen;
                                match tcid {
                                    0x4110 if t_off + 8 <= t_chunk_end => {
                                        let v_cnt = read_u16_le(data, t_off + 6) as usize;
                                        let mut p = t_off + 8;
                                        for _ in 0..v_cnt {
                                            if p + 12 > t_chunk_end {
                                                break;
                                            }
                                            let x = read_f32_le(data, p);
                                            let y = read_f32_le(data, p + 4);
                                            let z = read_f32_le(data, p + 8);
                                            // 3ds Max Z-up -> Studio Y-up
                                            local_verts.push([x, z, -y]);
                                            p += 12;
                                        }
                                    }
                                    0x4140 if t_off + 8 <= t_chunk_end => {
                                        let uv_cnt = read_u16_le(data, t_off + 6) as usize;
                                        let mut p = t_off + 8;
                                        for _ in 0..uv_cnt {
                                            if p + 8 > t_chunk_end {
                                                break;
                                            }
                                            local_uvs.push([read_f32_le(data, p), read_f32_le(data, p + 4)]);
                                            p += 8;
                                        }
                                        if !local_uvs.is_empty() {
                                            has_any_uv = true;
                                        }
                                    }
                                    0x4120 if t_off + 8 <= t_chunk_end => {
                                        let f_cnt = read_u16_le(data, t_off + 6) as usize;
                                        let mut p = t_off + 8;
                                        for _ in 0..f_cnt {
                                            if p + 8 > t_chunk_end {
                                                break;
                                            }
                                            let a = read_u16_le(data, p) as u32;
                                            let b = read_u16_le(data, p + 2) as u32;
                                            let c = read_u16_le(data, p + 4) as u32;
                                            local_faces.push([a, b, c]);
                                            p += 8;
                                        }
                                        face_mat.resize(
                                            local_faces.len(),
                                            if materials.is_empty() { -1 } else { 0 },
                                        );
                                        // Parse nested MSH_MAT_GROUP (0x4130) chunks
                                        while p + 6 <= t_chunk_end {
                                            let scid = read_u16_le(data, p);
                                            let sclen = read_u32_le(data, p + 2) as usize;
                                            if sclen < 6 || p + sclen > t_chunk_end {
                                                break;
                                            }
                                            if scid == 0x4130 {
                                                let (mname, mut mp) = read_cstring(data, p + 6, p + sclen);
                                                let midx = *mat_lookup.get(&mname).unwrap_or(&-1);
                                                if mp + 2 <= p + sclen && midx >= 0 {
                                                    let n_assigned = read_u16_le(data, mp) as usize;
                                                    mp += 2;
                                                    for _ in 0..n_assigned {
                                                        if mp + 2 > p + sclen {
                                                            break;
                                                        }
                                                        let fi = read_u16_le(data, mp) as usize;
                                                        if fi < face_mat.len() {
                                                            face_mat[fi] = midx;
                                                        }
                                                        mp += 2;
                                                    }
                                                }
                                            }
                                            p += sclen;
                                        }
                                    }
                                    _ => {}
                                }
                                t_off += tclen;
                            }

                            if !local_verts.is_empty() && !local_faces.is_empty() {
                                let base_v = (out.positions.len() / 3) as u32;
                                for (i, v) in local_verts.iter().enumerate() {
                                    out.positions.extend_from_slice(v);
                                    let uv = local_uvs.get(i).copied().unwrap_or([0.0, 0.0]);
                                    out.uvs.extend_from_slice(&uv);
                                }
                                // Group faces by material index so multi-material 3DS objects keep distinct materials
                                let mut by_mat: HashMap<i32, Vec<[u32; 3]>> = HashMap::new();
                                for (fi, f) in local_faces.iter().enumerate() {
                                    let m = face_mat.get(fi).copied().unwrap_or(-1);
                                    by_mat.entry(m).or_default().push(*f);
                                }
                                let mut mat_keys: Vec<i32> = by_mat.keys().copied().collect();
                                mat_keys.sort();
                                for mk in mat_keys {
                                    let start = out.indices.len() as u32;
                                    for f in &by_mat[&mk] {
                                        if (f[0] as usize) < local_verts.len()
                                            && (f[1] as usize) < local_verts.len()
                                            && (f[2] as usize) < local_verts.len()
                                        {
                                            out.indices.push(base_v + f[0]);
                                            out.indices.push(base_v + f[1]);
                                            out.indices.push(base_v + f[2]);
                                        }
                                    }
                                    let cnt = (out.indices.len() as u32) - start;
                                    if cnt > 0 {
                                        submeshes.push(ParsedSubmesh {
                                            name: if obj_name.is_empty() {
                                                "Mesh_3DS".to_string()
                                            } else {
                                                obj_name.clone()
                                            },
                                            index_start: start,
                                            index_count: cnt,
                                            material_index: mk,
                                            has_vertex_colors: false,
                                        });
                                    }
                                }
                            }
                        }
                        o_off += oclen;
                    }
                }
                e_off += eclen;
            }
        }
        main_off += clen;
    }

    if !has_any_uv {
        out.uvs.clear();
    }
}

// ===========================================================================
// 3. MAGICAVOXEL (.vox) BINARY RIFF VOXEL MESHER (6-NEIGHBOR FACE CULLING)
// ===========================================================================

fn default_vox_palette(idx: u8) -> [u8; 4] {
    // Fallback palette when RGBA chunk is absent (deterministic vibrant MagicaVoxel-like ramp)
    if idx == 0 {
        return [255, 255, 255, 255];
    }
    let i = (idx - 1) as u32;
    if i < 216 {
        let r = (5 - (i / 36) % 6) * 51;
        let g = (5 - (i / 6) % 6) * 51;
        let b = (5 - i % 6) * 51;
        [r as u8, g as u8, b as u8, 255]
    } else {
        let v = (255 - ((i - 216) * 6).min(240)) as u8;
        [v, v, v, 255]
    }
}

fn parse_magicavoxel_vox(
    data: &[u8],
    out: &mut ImportOutput,
    materials: &mut Vec<ParsedMaterial>,
    submeshes: &mut Vec<ParsedSubmesh>,
) {
    if data.len() < 20 || &data[0..4] != b"VOX " {
        return;
    }

    let mut palette = [[255u8; 4]; 256];
    for i in 1..=255u8 {
        palette[i as usize] = default_vox_palette(i);
    }

    struct VoxModel {
        sx: i32,
        sy: i32,
        voxels: Vec<(i32, i32, i32, u8)>,
    }
    let mut models: Vec<VoxModel> = Vec::new();
    let mut pending_size = (16i32, 16i32, 16i32);

    // Walk MAIN chunk children starting at offset 8
    let mut off = 8;
    if off + 12 <= data.len() && &data[off..off + 4] == b"MAIN" {
        let content_bytes = read_u32_le(data, off + 4) as usize;
        off += 12 + content_bytes;
    }

    while off + 12 <= data.len() {
        let tag = &data[off..off + 4];
        let content_len = read_u32_le(data, off + 4) as usize;
        let children_len = read_u32_le(data, off + 8) as usize;
        let c_start = off + 12;
        let c_end = c_start.saturating_add(content_len);
        if c_end > data.len() {
            break;
        }

        if tag == b"SIZE" && content_len >= 12 {
            pending_size = (
                read_u32_le(data, c_start) as i32,
                read_u32_le(data, c_start + 4) as i32,
                read_u32_le(data, c_start + 8) as i32,
            );
        } else if tag == b"XYZI" && content_len >= 4 {
            let n = read_u32_le(data, c_start) as usize;
            let mut vox = Vec::with_capacity(n.min((content_len - 4) / 4));
            let mut p = c_start + 4;
            for _ in 0..n {
                if p + 4 > c_end {
                    break;
                }
                vox.push((data[p] as i32, data[p + 1] as i32, data[p + 2] as i32, data[p + 3]));
                p += 4;
            }
            models.push(VoxModel {
                sx: pending_size.0.max(1),
                sy: pending_size.1.max(1),
                voxels: vox,
            });
        } else if tag == b"RGBA" && content_len >= 1024 {
            for i in 0..255usize {
                let p = c_start + i * 4;
                palette[i + 1] = [data[p], data[p + 1], data[p + 2], data[p + 3]];
            }
        }

        off = c_end.saturating_add(children_len);
    }

    if models.is_empty() {
        return;
    }

    materials.push(ParsedMaterial {
        name: "MagicaVoxel_Palette".to_string(),
        color: [1.0, 1.0, 1.0],
        roughness: 0.65,
        metalness: 0.02,
        ..Default::default()
    });

    let voxel_scale = 0.05f32;
    // 6 neighbor directions in Studio Y-up space after mapping Vox `(vx, vy, vz)` -> `(vx, vz, -vy)`
    const DIRS: [([i32; 3], [f32; 3], [[f32; 3]; 4]); 6] = [
        // +X
        ([1, 0, 0], [1.0, 0.0, 0.0], [[1.0, 0.0, 1.0], [1.0, 0.0, 0.0], [1.0, 1.0, 0.0], [1.0, 1.0, 1.0]]),
        // -X
        ([-1, 0, 0], [-1.0, 0.0, 0.0], [[0.0, 0.0, 0.0], [0.0, 0.0, 1.0], [0.0, 1.0, 1.0], [0.0, 1.0, 0.0]]),
        // +Y (Vox +Z)
        ([0, 0, 1], [0.0, 1.0, 0.0], [[0.0, 1.0, 1.0], [1.0, 1.0, 1.0], [1.0, 1.0, 0.0], [0.0, 1.0, 0.0]]),
        // -Y (Vox -Z)
        ([0, 0, -1], [0.0, -1.0, 0.0], [[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [1.0, 0.0, 1.0], [0.0, 0.0, 1.0]]),
        // +Z in Studio = -Y in Vox
        ([0, -1, 0], [0.0, 0.0, 1.0], [[0.0, 0.0, 1.0], [1.0, 0.0, 1.0], [1.0, 1.0, 1.0], [0.0, 1.0, 1.0]]),
        // -Z in Studio = +Y in Vox
        ([0, 1, 0], [0.0, 0.0, -1.0], [[1.0, 0.0, 0.0], [0.0, 0.0, 0.0], [0.0, 1.0, 0.0], [1.0, 1.0, 0.0]]),
    ];

    for (mi, model) in models.iter().enumerate() {
        let mut occ: HashMap<(i32, i32, i32), u8> = HashMap::with_capacity(model.voxels.len());
        for &(x, y, z, ci) in &model.voxels {
            occ.insert((x, y, z), ci);
        }

        let start_idx = out.indices.len() as u32;
        let ox = -(model.sx as f32) * 0.5 + (mi as f32) * ((model.sx as f32) + 2.0);
        let oz_vox = -(model.sy as f32) * 0.5;

        for &(vx, vy, vz, ci) in &model.voxels {
            let rgba = palette[ci as usize];
            let col = [
                srgb_u8_to_linear(rgba[0]),
                srgb_u8_to_linear(rgba[1]),
                srgb_u8_to_linear(rgba[2]),
            ];
            let bx = (vx as f32 + ox) * voxel_scale;
            let by = (vz as f32) * voxel_scale;
            let bz = -(vy as f32 + oz_vox + 1.0) * voxel_scale;

            for (d_vox, norm, quad) in &DIRS {
                if occ.contains_key(&(vx + d_vox[0], vy + d_vox[1], vz + d_vox[2])) {
                    continue;
                }
                let base_v = (out.positions.len() / 3) as u32;
                for corner in quad {
                    out.positions.push(bx + corner[0] * voxel_scale);
                    out.positions.push(by + corner[1] * voxel_scale);
                    out.positions.push(bz + corner[2] * voxel_scale);
                    out.normals.extend_from_slice(norm);
                    out.colors.extend_from_slice(&col);
                }
                out.indices.extend_from_slice(&[
                    base_v, base_v + 1, base_v + 2,
                    base_v, base_v + 2, base_v + 3,
                ]);
            }
        }

        let cnt = (out.indices.len() as u32) - start_idx;
        if cnt > 0 {
            submeshes.push(ParsedSubmesh {
                name: format!("VoxModel_{}", mi),
                index_start: start_idx,
                index_count: cnt,
                material_index: 0,
                has_vertex_colors: true,
            });
        }
    }
}

// ===========================================================================
// 4. PIXAR / APPLE USD ASCII (.usda) PARSER
// ===========================================================================

fn extract_bracket_floats(s: &str) -> Vec<f32> {
    let Some(b0) = s.find('[') else { return Vec::new() };
    let Some(b1) = s[b0..].find(']') else { return Vec::new() };
    let inner = &s[b0 + 1..b0 + b1];
    inner
        .split(|c: char| c == ',' || c == '(' || c == ')' || c.is_whitespace())
        .filter(|t| !t.is_empty())
        .filter_map(|t| t.parse::<f32>().ok())
        .collect()
}

fn extract_bracket_ints(s: &str) -> Vec<i32> {
    let Some(b0) = s.find('[') else { return Vec::new() };
    let Some(b1) = s[b0..].find(']') else { return Vec::new() };
    let inner = &s[b0 + 1..b0 + b1];
    inner
        .split(|c: char| c == ',' || c.is_whitespace())
        .filter(|t| !t.is_empty())
        .filter_map(|t| t.parse::<i32>().ok())
        .collect()
}

fn parse_usda_ascii(
    data: &[u8],
    out: &mut ImportOutput,
    materials: &mut Vec<ParsedMaterial>,
    submeshes: &mut Vec<ParsedSubmesh>,
) {
    let text = String::from_utf8_lossy(data);
    let z_up = text.contains("upAxis = \"Z\"");

    // Pass 1: Extract `def Material "MatName"` blocks (`diffuseColor`, `metallic`, `roughness`, `asset inputs:file = @...@`)
    let mut mat_lookup: HashMap<String, i32> = HashMap::new();
    let mut pos = 0usize;
    let bytes = text.as_bytes();
    while let Some(rel) = text[pos..].find("def Material \"") {
        let m_start = pos + rel + "def Material \"".len();
        let Some(q_end) = text[m_start..].find('"') else { break };
        let mat_name = text[m_start..m_start + q_end].to_string();
        let Some(open_rel) = text[m_start + q_end..].find('{') else { break };
        let mut brace = 1i32;
        let mut cur = m_start + q_end + open_rel + 1;
        while cur < bytes.len() && brace > 0 {
            if bytes[cur] == b'{' {
                brace += 1;
            } else if bytes[cur] == b'}' {
                brace -= 1;
            }
            cur += 1;
        }
        let body = &text[m_start + q_end..cur];
        let mut mat = ParsedMaterial {
            name: mat_name.clone(),
            ..Default::default()
        };
        for l in body.lines() {
            let lt = l.trim();
            if lt.contains("inputs:diffuseColor") && lt.contains('(') {
                if let (Some(p0), Some(p1)) = (lt.find('('), lt.find(')')) {
                    let vals: Vec<f32> = lt[p0 + 1..p1]
                        .split(|c: char| c == ',' || c.is_whitespace())
                        .filter_map(|t| t.parse().ok())
                        .collect();
                    if vals.len() >= 3 {
                        mat.color = [vals[0], vals[1], vals[2]];
                    }
                }
            } else if lt.contains("inputs:metallic") && lt.contains('=') {
                if let Some(v) = lt.split('=').nth(1).and_then(|s| s.trim().parse::<f32>().ok()) {
                    mat.metalness = v.clamp(0.0, 1.0);
                }
            } else if lt.contains("inputs:roughness") && lt.contains('=') {
                if let Some(v) = lt.split('=').nth(1).and_then(|s| s.trim().parse::<f32>().ok()) {
                    mat.roughness = v.clamp(0.0, 1.0);
                }
            } else if lt.contains("inputs:file") && lt.contains('@') {
                if let Some(a0) = lt.find('@') {
                    if let Some(a1) = lt[a0 + 1..].find('@') {
                        let path = lt[a0 + 1..a0 + 1 + a1].trim_matches('@');
                        if mat.map_kd.is_empty() {
                            mat.map_kd = path.to_string();
                        }
                    }
                }
            }
        }
        let idx = materials.len() as i32;
        mat_lookup.insert(mat_name, idx);
        materials.push(mat);
        pos = cur;
    }

    // Pass 2: Extract `def Mesh "MeshName"` blocks
    let mut has_any_uv = false;
    let mut has_any_col = false;
    pos = 0;
    while let Some(rel) = text[pos..].find("def Mesh \"") {
        let m_start = pos + rel + "def Mesh \"".len();
        let Some(q_end) = text[m_start..].find('"') else { break };
        let mesh_name = text[m_start..m_start + q_end].to_string();
        let Some(open_rel) = text[m_start + q_end..].find('{') else { break };
        let mut brace = 1i32;
        let mut cur = m_start + q_end + open_rel + 1;
        while cur < bytes.len() && brace > 0 {
            if bytes[cur] == b'{' {
                brace += 1;
            } else if bytes[cur] == b'}' {
                brace -= 1;
            }
            cur += 1;
        }
        let body = &text[m_start + q_end + open_rel..cur];

        let points = if let Some(idx) = body.find("points") {
            extract_bracket_floats(&body[idx..])
        } else {
            Vec::new()
        };
        let counts = if let Some(idx) = body.find("faceVertexCounts") {
            extract_bracket_ints(&body[idx..])
        } else {
            Vec::new()
        };
        let face_indices = if let Some(idx) = body.find("faceVertexIndices") {
            extract_bracket_ints(&body[idx..])
        } else {
            Vec::new()
        };
        let st = if let Some(idx) = body.find("primvars:st") {
            extract_bracket_floats(&body[idx..])
        } else {
            Vec::new()
        };
        let disp_col = if let Some(idx) = body.find("displayColor") {
            extract_bracket_floats(&body[idx..])
        } else {
            Vec::new()
        };

        let mut bound_mat: i32 = -1;
        if let Some(b_idx) = body.find("material:binding") {
            let line = body[b_idx..].lines().next().unwrap_or("");
            if let (Some(l0), Some(l1)) = (line.find('<'), line.find('>')) {
                let target_path = &line[l0 + 1..l1];
                let leaf = target_path.rsplit('/').next().unwrap_or(target_path);
                if let Some(&mi) = mat_lookup.get(leaf) {
                    bound_mat = mi;
                }
            }
        }
        if bound_mat < 0 && disp_col.len() >= 3 {
            bound_mat = materials.len() as i32;
            materials.push(ParsedMaterial {
                name: format!("{}_DisplayColor", mesh_name),
                color: [disp_col[0], disp_col[1], disp_col[2]],
                ..Default::default()
            });
        }

        let num_pts = points.len() / 3;
        if num_pts >= 3 && !counts.is_empty() && !face_indices.is_empty() {
            let start_idx = out.indices.len() as u32;
            let face_varying_uv = st.len() / 2 == face_indices.len();
            let vertex_uv = st.len() / 2 == num_pts;
            if face_varying_uv || vertex_uv {
                has_any_uv = true;
            }
            let per_vert_col = disp_col.len() / 3 == num_pts && num_pts > 1;
            if per_vert_col {
                has_any_col = true;
            }

            let mut fi_cursor = 0usize;
            for &cnt in &counts {
                let c = cnt.max(0) as usize;
                if c < 3 || fi_cursor + c > face_indices.len() {
                    fi_cursor += c;
                    continue;
                }
                let base_v = (out.positions.len() / 3) as u32;
                for k in 0..c {
                    let pi = (face_indices[fi_cursor + k].max(0) as usize).min(num_pts - 1);
                    let px = points[pi * 3];
                    let py = points[pi * 3 + 1];
                    let pz = points[pi * 3 + 2];
                    if z_up {
                        out.positions.extend_from_slice(&[px, pz, -py]);
                    } else {
                        out.positions.extend_from_slice(&[px, py, pz]);
                    }

                    let uv = if face_varying_uv {
                        let uvi = fi_cursor + k;
                        [st[uvi * 2], st[uvi * 2 + 1]]
                    } else if vertex_uv {
                        [st[pi * 2], st[pi * 2 + 1]]
                    } else {
                        [0.0, 0.0]
                    };
                    out.uvs.extend_from_slice(&uv);

                    let col = if per_vert_col {
                        [disp_col[pi * 3], disp_col[pi * 3 + 1], disp_col[pi * 3 + 2]]
                    } else {
                        [1.0, 1.0, 1.0]
                    };
                    out.colors.extend_from_slice(&col);
                }
                for k in 1..(c as u32 - 1) {
                    out.indices.push(base_v);
                    out.indices.push(base_v + k);
                    out.indices.push(base_v + k + 1);
                }
                fi_cursor += c;
            }

            let index_cnt = (out.indices.len() as u32) - start_idx;
            if index_cnt > 0 {
                submeshes.push(ParsedSubmesh {
                    name: mesh_name,
                    index_start: start_idx,
                    index_count: index_cnt,
                    material_index: bound_mat,
                    has_vertex_colors: per_vert_col,
                });
            }
        }
        pos = cur;
    }

    if !has_any_uv {
        out.uvs.clear();
    }
    if !has_any_col {
        out.colors.clear();
    }
}

// ===========================================================================
// 5. AUTOCAD / RHINO DXF (.dxf) 3DFACE & POLYFACE MESH PARSER
// ===========================================================================

fn aci_color(code: i32) -> [f32; 3] {
    match code.abs() {
        1 => [0.92, 0.22, 0.22],
        2 => [0.95, 0.85, 0.20],
        3 => [0.22, 0.82, 0.32],
        4 => [0.20, 0.82, 0.88],
        5 => [0.24, 0.45, 0.95],
        6 => [0.85, 0.28, 0.88],
        8 => [0.50, 0.50, 0.52],
        9 => [0.72, 0.72, 0.74],
        _ => [0.82, 0.84, 0.86],
    }
}

fn parse_dxf_ascii(
    data: &[u8],
    out: &mut ImportOutput,
    materials: &mut Vec<ParsedMaterial>,
    submeshes: &mut Vec<ParsedSubmesh>,
) {
    let text = String::from_utf8_lossy(data);
    let mut lines = text.lines();
    let mut pairs: Vec<(i32, &str)> = Vec::new();
    while let (Some(c_line), Some(v_line)) = (lines.next(), lines.next()) {
        if let Ok(code) = c_line.trim().parse::<i32>() {
            pairs.push((code, v_line.trim()));
        }
    }

    let mut layer_tris: HashMap<String, (i32, Vec<[[f32; 3]; 3]>)> = HashMap::new();
    let mut i = 0usize;

    while i < pairs.len() {
        if pairs[i].0 == 0 && pairs[i].1.eq_ignore_ascii_case("3DFACE") {
            i += 1;
            let mut layer = "0".to_string();
            let mut col_code = 7;
            let mut pts = [[0.0f32; 3]; 4];
            let mut has_fourth = false;
            while i < pairs.len() && pairs[i].0 != 0 {
                let (c, v) = pairs[i];
                match c {
                    8 => layer = v.to_string(),
                    62 => col_code = v.parse().unwrap_or(7),
                    10 => pts[0][0] = v.parse().unwrap_or(0.0),
                    20 => pts[0][2] = -v.parse::<f32>().unwrap_or(0.0),
                    30 => pts[0][1] = v.parse().unwrap_or(0.0),
                    11 => pts[1][0] = v.parse().unwrap_or(0.0),
                    21 => pts[1][2] = -v.parse::<f32>().unwrap_or(0.0),
                    31 => pts[1][1] = v.parse().unwrap_or(0.0),
                    12 => pts[2][0] = v.parse().unwrap_or(0.0),
                    22 => pts[2][2] = -v.parse::<f32>().unwrap_or(0.0),
                    32 => pts[2][1] = v.parse().unwrap_or(0.0),
                    13 => { pts[3][0] = v.parse().unwrap_or(0.0); has_fourth = true; }
                    23 => { pts[3][2] = -v.parse::<f32>().unwrap_or(0.0); has_fourth = true; }
                    33 => { pts[3][1] = v.parse().unwrap_or(0.0); has_fourth = true; }
                    _ => {}
                }
                i += 1;
            }
            let entry = layer_tris.entry(layer).or_insert_with(|| (col_code, Vec::new()));
            entry.1.push([pts[0], pts[1], pts[2]]);
            if has_fourth && (pts[3] != pts[2]) {
                entry.1.push([pts[0], pts[2], pts[3]]);
            }
            continue;
        }

        if pairs[i].0 == 0 && pairs[i].1.eq_ignore_ascii_case("POLYLINE") {
            i += 1;
            let mut layer = "0".to_string();
            let mut col_code = 7;
            while i < pairs.len() && pairs[i].0 != 0 {
                if pairs[i].0 == 8 {
                    layer = pairs[i].1.to_string();
                } else if pairs[i].0 == 62 {
                    col_code = pairs[i].1.parse().unwrap_or(7);
                }
                i += 1;
            }
            let mut poly_verts: Vec<[f32; 3]> = Vec::new();
            let mut poly_faces: Vec<[usize; 4]> = Vec::new();
            while i < pairs.len() {
                if pairs[i].0 == 0 && pairs[i].1.eq_ignore_ascii_case("SEQEND") {
                    i += 1;
                    break;
                }
                if pairs[i].0 == 0 && pairs[i].1.eq_ignore_ascii_case("VERTEX") {
                    i += 1;
                    let mut p = [0.0f32; 3];
                    let mut flags = 0i32;
                    let mut fi = [0i32; 4];
                    while i < pairs.len() && pairs[i].0 != 0 {
                        let (c, v) = pairs[i];
                        match c {
                            10 => p[0] = v.parse().unwrap_or(0.0),
                            20 => p[2] = -v.parse::<f32>().unwrap_or(0.0),
                            30 => p[1] = v.parse().unwrap_or(0.0),
                            70 => flags = v.parse().unwrap_or(0),
                            71 => fi[0] = v.parse::<i32>().unwrap_or(0).abs(),
                            72 => fi[1] = v.parse::<i32>().unwrap_or(0).abs(),
                            73 => fi[2] = v.parse::<i32>().unwrap_or(0).abs(),
                            74 => fi[3] = v.parse::<i32>().unwrap_or(0).abs(),
                            _ => {}
                        }
                        i += 1;
                    }
                    if (flags & 128) != 0 && (flags & 64) == 0 && fi[0] > 0 && fi[1] > 0 && fi[2] > 0 {
                        poly_faces.push([
                            (fi[0] - 1) as usize,
                            (fi[1] - 1) as usize,
                            (fi[2] - 1) as usize,
                            if fi[3] > 0 { (fi[3] - 1) as usize } else { usize::MAX },
                        ]);
                    } else {
                        poly_verts.push(p);
                    }
                } else if pairs[i].0 == 0 {
                    break;
                } else {
                    i += 1;
                }
            }
            if !poly_verts.is_empty() && !poly_faces.is_empty() {
                let entry = layer_tris.entry(layer).or_insert_with(|| (col_code, Vec::new()));
                for f in poly_faces {
                    if f[0] < poly_verts.len() && f[1] < poly_verts.len() && f[2] < poly_verts.len() {
                        entry.1.push([poly_verts[f[0]], poly_verts[f[1]], poly_verts[f[2]]]);
                        if f[3] < poly_verts.len() && f[3] != f[2] {
                            entry.1.push([poly_verts[f[0]], poly_verts[f[2]], poly_verts[f[3]]]);
                        }
                    }
                }
            }
            continue;
        }
        i += 1;
    }

    let mut layer_names: Vec<String> = layer_tris.keys().cloned().collect();
    layer_names.sort();
    for lname in layer_names {
        let (col_code, tris) = &layer_tris[&lname];
        if tris.is_empty() {
            continue;
        }
        let midx = materials.len() as i32;
        materials.push(ParsedMaterial {
            name: format!("DXF_Layer_{}", lname),
            color: aci_color(*col_code),
            double_sided: true,
            ..Default::default()
        });
        let start = out.indices.len() as u32;
        for tri in tris {
            let bv = (out.positions.len() / 3) as u32;
            for pt in tri {
                out.positions.extend_from_slice(pt);
            }
            out.indices.extend_from_slice(&[bv, bv + 1, bv + 2]);
        }
        submeshes.push(ParsedSubmesh {
            name: format!("Layer_{}", lname),
            index_start: start,
            index_count: (out.indices.len() as u32) - start,
            material_index: midx,
            has_vertex_colors: false,
        });
    }
}

// ===========================================================================
// 6. 3MF (.3mf `3dmodel.model` XML) PARSER
// ===========================================================================

fn xml_attr<'a>(tag: &'a str, attr: &str) -> Option<&'a str> {
    let pat_dq = format!("{}=\"", attr);
    if let Some(p) = tag.find(&pat_dq) {
        let rest = &tag[p + pat_dq.len()..];
        if let Some(e) = rest.find('"') {
            return Some(&rest[..e]);
        }
    }
    let pat_sq = format!("{}='", attr);
    if let Some(p) = tag.find(&pat_sq) {
        let rest = &tag[p + pat_sq.len()..];
        if let Some(e) = rest.find('\'') {
            return Some(&rest[..e]);
        }
    }
    None
}

fn parse_hex_color(hex: &str) -> [f32; 3] {
    let h = hex.trim().trim_start_matches('#');
    if h.len() >= 6 {
        let b = h.as_bytes();
        if let (Some(r1), Some(r0), Some(g1), Some(g0), Some(b1), Some(b0)) = (
            hex_nibble(b[0]), hex_nibble(b[1]),
            hex_nibble(b[2]), hex_nibble(b[3]),
            hex_nibble(b[4]), hex_nibble(b[5]),
        ) {
            return [
                srgb_u8_to_linear((r1 << 4) | r0),
                srgb_u8_to_linear((g1 << 4) | g0),
                srgb_u8_to_linear((b1 << 4) | b0),
            ];
        }
    }
    [0.82, 0.84, 0.86]
}

fn parse_3mf_model_xml(
    data: &[u8],
    out: &mut ImportOutput,
    materials: &mut Vec<ParsedMaterial>,
    submeshes: &mut Vec<ParsedSubmesh>,
) {
    let text = String::from_utf8_lossy(data);

    // Parse <base name="..." displaycolor="#RRGGBB" />
    let mut scan = 0usize;
    while let Some(rel) = text[scan..].find("<base ") {
        let s = scan + rel;
        let Some(e_rel) = text[s..].find('>') else { break };
        let tag = &text[s..s + e_rel];
        let name = xml_attr(tag, "name").unwrap_or("3MF_Material").to_string();
        let col = xml_attr(tag, "displaycolor").map(parse_hex_color).unwrap_or([0.82, 0.84, 0.86]);
        materials.push(ParsedMaterial {
            name,
            color: col,
            ..Default::default()
        });
        scan = s + e_rel + 1;
    }

    // Parse each <mesh>...</mesh>
    let mut obj_idx = 0usize;
    scan = 0;
    while let Some(rel) = text[scan..].find("<mesh>") {
        let m_start = scan + rel + 6;
        let Some(m_end_rel) = text[m_start..].find("</mesh>") else { break };
        let mesh_xml = &text[m_start..m_start + m_end_rel];
        scan = m_start + m_end_rel + 7;

        let base_v = (out.positions.len() / 3) as u32;
        let mut local_v_count = 0u32;
        let mut v_scan = 0usize;
        while let Some(vr) = mesh_xml[v_scan..].find("<vertex ") {
            let vs = v_scan + vr;
            let Some(ve) = mesh_xml[vs..].find('>') else { break };
            let vtag = &mesh_xml[vs..vs + ve];
            let x: f32 = xml_attr(vtag, "x").and_then(|s| s.parse().ok()).unwrap_or(0.0);
            let y: f32 = xml_attr(vtag, "y").and_then(|s| s.parse().ok()).unwrap_or(0.0);
            let z: f32 = xml_attr(vtag, "z").and_then(|s| s.parse().ok()).unwrap_or(0.0);
            // 3MF is Z-up millimeters -> convert to Y-up (keep scale 0.001 if large > 50, else 1.0)
            out.positions.extend_from_slice(&[x, z, -y]);
            local_v_count += 1;
            v_scan = vs + ve + 1;
        }

        let start_idx = out.indices.len() as u32;
        let mut mat_used: i32 = if materials.is_empty() { -1 } else { 0 };
        let mut t_scan = 0usize;
        while let Some(tr) = mesh_xml[t_scan..].find("<triangle ") {
            let ts = t_scan + tr;
            let Some(te) = mesh_xml[ts..].find('>') else { break };
            let ttag = &mesh_xml[ts..ts + te];
            let v1: u32 = xml_attr(ttag, "v1").and_then(|s| s.parse().ok()).unwrap_or(0);
            let v2: u32 = xml_attr(ttag, "v2").and_then(|s| s.parse().ok()).unwrap_or(0);
            let v3: u32 = xml_attr(ttag, "v3").and_then(|s| s.parse().ok()).unwrap_or(0);
            if let Some(p1) = xml_attr(ttag, "p1").and_then(|s| s.parse::<i32>().ok()) {
                if (p1 as usize) < materials.len() {
                    mat_used = p1;
                }
            }
            if v1 < local_v_count && v2 < local_v_count && v3 < local_v_count {
                out.indices.push(base_v + v1);
                out.indices.push(base_v + v2);
                out.indices.push(base_v + v3);
            }
            t_scan = ts + te + 1;
        }

        let cnt = (out.indices.len() as u32) - start_idx;
        if cnt > 0 {
            submeshes.push(ParsedSubmesh {
                name: format!("Part_3MF_{}", obj_idx),
                index_start: start_idx,
                index_count: cnt,
                material_index: mat_used,
                has_vertex_colors: false,
            });
            obj_idx += 1;
        }
    }
}

// ===========================================================================
// 7. GEOMVIEW / CGAL / HOUDINI OFF & COFF (.off) PARSER
// ===========================================================================

fn parse_off_ascii(
    data: &[u8],
    out: &mut ImportOutput,
    materials: &mut Vec<ParsedMaterial>,
    submeshes: &mut Vec<ParsedSubmesh>,
) {
    let text = String::from_utf8_lossy(data);
    let mut clean_tokens: Vec<&str> = Vec::new();
    let mut lines_non_comment: Vec<&str> = Vec::new();

    for raw in text.lines() {
        let no_comment = raw.split('#').next().unwrap_or("").trim();
        if !no_comment.is_empty() {
            lines_non_comment.push(no_comment);
        }
    }
    if lines_non_comment.is_empty() {
        return;
    }

    let mut line_idx = 0usize;
    let first = lines_non_comment[0];
    if first.contains("OFF") {
        let after = first.rsplit("OFF").next().unwrap_or("").trim();
        if !after.is_empty() {
            clean_tokens.extend(after.split_whitespace());
        }
        line_idx = 1;
    }

    while clean_tokens.len() < 3 && line_idx < lines_non_comment.len() {
        clean_tokens.extend(lines_non_comment[line_idx].split_whitespace());
        line_idx += 1;
    }
    if clean_tokens.len() < 2 {
        return;
    }
    let n_verts: usize = clean_tokens[0].parse().unwrap_or(0);
    let n_faces: usize = clean_tokens[1].parse().unwrap_or(0);
    if n_verts < 3 || n_faces < 1 {
        return;
    }

    let mut has_vcol = false;
    let mut v_read = 0usize;
    while v_read < n_verts && line_idx < lines_non_comment.len() {
        let nums: Vec<f32> = lines_non_comment[line_idx]
            .split_whitespace()
            .filter_map(|s| s.parse().ok())
            .collect();
        line_idx += 1;
        if nums.len() >= 3 {
            out.positions.extend_from_slice(&[nums[0], nums[1], nums[2]]);
            if nums.len() >= 6 {
                has_vcol = true;
                let sc = if nums[3] > 1.001 || nums[4] > 1.001 || nums[5] > 1.001 {
                    1.0 / 255.0
                } else {
                    1.0
                };
                out.colors.extend_from_slice(&[nums[3] * sc, nums[4] * sc, nums[5] * sc]);
            } else {
                out.colors.extend_from_slice(&[1.0, 1.0, 1.0]);
            }
            v_read += 1;
        }
    }

    let mut f_read = 0usize;
    while f_read < n_faces && line_idx < lines_non_comment.len() {
        let toks: Vec<&str> = lines_non_comment[line_idx].split_whitespace().collect();
        line_idx += 1;
        if toks.len() < 4 {
            continue;
        }
        let k: usize = toks[0].parse().unwrap_or(0);
        if k >= 3 && toks.len() >= 1 + k {
            let corner: Vec<u32> = (0..k)
                .filter_map(|ci| toks[1 + ci].parse::<u32>().ok())
                .filter(|&vi| (vi as usize) < v_read)
                .collect();
            if corner.len() == k {
                // Optional per-face color after vertex indices
                if !has_vcol && toks.len() >= 1 + k + 3 {
                    if let (Ok(r), Ok(g), Ok(b)) = (
                        toks[1 + k].parse::<f32>(),
                        toks[1 + k + 1].parse::<f32>(),
                        toks[1 + k + 2].parse::<f32>(),
                    ) {
                        has_vcol = true;
                        let sc = if r > 1.001 || g > 1.001 || b > 1.001 { 1.0 / 255.0 } else { 1.0 };
                        for &vi in &corner {
                            let base = (vi as usize) * 3;
                            if base + 2 < out.colors.len() {
                                out.colors[base] = r * sc;
                                out.colors[base + 1] = g * sc;
                                out.colors[base + 2] = b * sc;
                            }
                        }
                    }
                }
                for t in 1..(k - 1) {
                    out.indices.push(corner[0]);
                    out.indices.push(corner[t]);
                    out.indices.push(corner[t + 1]);
                }
            }
        }
        f_read += 1;
    }

    if !has_vcol {
        out.colors.clear();
    } else {
        materials.push(ParsedMaterial {
            name: "OFF_VertexColor".to_string(),
            color: [1.0, 1.0, 1.0],
            ..Default::default()
        });
    }

    if !out.indices.is_empty() {
        submeshes.push(ParsedSubmesh {
            name: "OFF_Mesh".to_string(),
            index_start: 0,
            index_count: out.indices.len() as u32,
            material_index: if materials.is_empty() { -1 } else { 0 },
            has_vertex_colors: has_vcol,
        });
    }
}

// ===========================================================================
// 8. COLLADA (.dae) XML PARSER (MAYA / CINEMA 4D / SKETCHUP)
// ===========================================================================

fn xml_inner<'a>(xml: &'a str, open_pat: &str, close_pat: &str) -> Option<(&'a str, &'a str, usize)> {
    let s = xml.find(open_pat)?;
    let tag_end = xml[s..].find('>')? + s;
    let header_tag = &xml[s..tag_end];
    if header_tag.ends_with('/') {
        return Some((header_tag, "", tag_end + 1));
    }
    let close_pos = xml[tag_end + 1..].find(close_pat)? + tag_end + 1;
    let body = &xml[tag_end + 1..close_pos];
    Some((header_tag, body, close_pos + close_pat.len()))
}

fn parse_collada_dae(
    data: &[u8],
    out: &mut ImportOutput,
    materials: &mut Vec<ParsedMaterial>,
    submeshes: &mut Vec<ParsedSubmesh>,
) {
    let text = String::from_utf8_lossy(data);
    let z_up = text.contains("<up_axis>Z_UP</up_axis>");

    // 1. <library_images>: image_id -> file path
    let mut images: HashMap<String, String> = HashMap::new();
    let mut scan = 0usize;
    while let Some((hdr, body, next)) = xml_inner(&text[scan..], "<image", "</image>") {
        if let Some(id) = xml_attr(hdr, "id") {
            if let Some((_, init_body, _)) = xml_inner(body, "<init_from", "</init_from>") {
                images.insert(id.to_string(), init_body.trim().to_string());
            }
        }
        scan += next;
    }

    // 2. <library_effects>: effect_id -> (color, texture_path)
    let mut effects: HashMap<String, ([f32; 3], String)> = HashMap::new();
    scan = 0;
    while let Some((hdr, body, next)) = xml_inner(&text[scan..], "<effect", "</effect>") {
        if let Some(eid) = xml_attr(hdr, "id") {
            let mut col = [0.82f32, 0.84, 0.86];
            let mut tex_path = String::new();
            if let Some((_, diff_body, _)) = xml_inner(body, "<diffuse", "</diffuse>") {
                if let Some((_, col_body, _)) = xml_inner(diff_body, "<color", "</color>") {
                    let nums: Vec<f32> = col_body.split_whitespace().filter_map(|s| s.parse().ok()).collect();
                    if nums.len() >= 3 {
                        col = [nums[0], nums[1], nums[2]];
                    }
                }
                if let Some((thdr, _, _)) = xml_inner(diff_body, "<texture", ">") {
                    if let Some(tref) = xml_attr(thdr, "texture") {
                        if let Some(p) = images.get(tref) {
                            tex_path = p.clone();
                        } else {
                            // Resolve via <newparam sid="..."><sampler2D><source>...</source></sampler2D> -> <surface><init_from>
                            tex_path = images.values().next().cloned().unwrap_or_default();
                        }
                    }
                }
            }
            effects.insert(eid.to_string(), (col, tex_path));
        }
        scan += next;
    }

    // 3. <library_materials>: mat_id / symbol -> material_index
    let mut mat_by_id: HashMap<String, i32> = HashMap::new();
    scan = 0;
    while let Some((hdr, body, next)) = xml_inner(&text[scan..], "<material", "</material>") {
        let mid = xml_attr(hdr, "id").unwrap_or("Material").to_string();
        let mname = xml_attr(hdr, "name").unwrap_or(&mid).to_string();
        let mut pmat = ParsedMaterial {
            name: mname.clone(),
            ..Default::default()
        };
        if let Some(ie_pos) = body.find("<instance_effect") {
            let ie_end = body[ie_pos..].find('>').unwrap_or(0) + ie_pos;
            if let Some(url) = xml_attr(&body[ie_pos..ie_end], "url") {
                let clean = url.trim_start_matches('#');
                if let Some((col, tex)) = effects.get(clean) {
                    pmat.color = *col;
                    pmat.map_kd = tex.clone();
                    if !pmat.map_kd.is_empty() {
                        pmat.color = [1.0, 1.0, 1.0];
                    }
                }
            }
        }
        let idx = materials.len() as i32;
        mat_by_id.insert(mid, idx);
        mat_by_id.insert(mname, idx);
        materials.push(pmat);
        scan += next;
    }

    // 4. <library_geometries>: parse <geometry><mesh>
    let mut has_any_uv = false;
    let mut has_any_norm = false;
    scan = 0;
    while let Some((ghdr, gbody, gnext)) = xml_inner(&text[scan..], "<geometry", "</geometry>") {
        let gname = xml_attr(ghdr, "name")
            .or_else(|| xml_attr(ghdr, "id"))
            .unwrap_or("DAE_Geometry")
            .to_string();
        scan += gnext;

        let Some((_, mbody, _)) = xml_inner(gbody, "<mesh", "</mesh>") else { continue };

        // Map source_id -> Vec<f32>
        let mut sources: HashMap<String, Vec<f32>> = HashMap::new();
        let mut s_scan = 0usize;
        while let Some((shdr, sbody, snext)) = xml_inner(&mbody[s_scan..], "<source", "</source>") {
            if let Some(sid) = xml_attr(shdr, "id") {
                if let Some((_, fabody, _)) = xml_inner(sbody, "<float_array", "</float_array>") {
                    let arr: Vec<f32> = fabody.split_whitespace().filter_map(|s| s.parse().ok()).collect();
                    sources.insert(sid.to_string(), arr);
                }
            }
            s_scan += snext;
        }

        // Map <vertices id="..."> -> position source_id
        let mut vertices_pos_src: HashMap<String, String> = HashMap::new();
        if let Some((vhdr, vbody, _)) = xml_inner(mbody, "<vertices", "</vertices>") {
            if let Some(vid) = xml_attr(vhdr, "id") {
                let mut iscan = 0usize;
                while let Some(ip) = vbody[iscan..].find("<input ") {
                    let is = iscan + ip;
                    let Some(ie) = vbody[is..].find('>') else { break };
                    let itag = &vbody[is..is + ie];
                    if xml_attr(itag, "semantic") == Some("POSITION") {
                        if let Some(src) = xml_attr(itag, "source") {
                            vertices_pos_src.insert(vid.to_string(), src.trim_start_matches('#').to_string());
                        }
                    }
                    iscan = is + ie + 1;
                }
            }
        }

        // Parse <triangles> and <polylist> primitives
        for &(prim_open, prim_close, is_polylist) in &[
            ("<triangles", "</triangles>", false),
            ("<polylist", "</polylist>", true),
        ] {
            let mut p_scan = 0usize;
            while let Some((phdr, pbody, pnext)) = xml_inner(&mbody[p_scan..], prim_open, prim_close) {
                p_scan += pnext;
                let mat_sym = xml_attr(phdr, "material").unwrap_or("");
                let mat_idx = mat_by_id
                    .get(mat_sym)
                    .copied()
                    .unwrap_or(if materials.is_empty() { -1 } else { 0 });

                let mut pos_src_id = String::new();
                let mut norm_src_id = String::new();
                let mut uv_src_id = String::new();
                let mut pos_off = 0usize;
                let mut norm_off = usize::MAX;
                let mut uv_off = usize::MAX;
                let mut max_off = 0usize;

                let mut iscan = 0usize;
                while let Some(ip) = pbody[iscan..].find("<input ") {
                    let is = iscan + ip;
                    let Some(ie) = pbody[is..].find('>') else { break };
                    let itag = &pbody[is..is + ie];
                    let sem = xml_attr(itag, "semantic").unwrap_or("");
                    let src = xml_attr(itag, "source").unwrap_or("").trim_start_matches('#');
                    let off_v: usize = xml_attr(itag, "offset").and_then(|s| s.parse().ok()).unwrap_or(0);
                    if off_v > max_off {
                        max_off = off_v;
                    }
                    match sem {
                        "VERTEX" => {
                            pos_off = off_v;
                            pos_src_id = vertices_pos_src.get(src).cloned().unwrap_or_else(|| src.to_string());
                        }
                        "POSITION" => {
                            pos_off = off_v;
                            pos_src_id = src.to_string();
                        }
                        "NORMAL" => {
                            norm_off = off_v;
                            norm_src_id = src.to_string();
                        }
                        "TEXCOORD" if uv_off == usize::MAX => {
                            uv_off = off_v;
                            uv_src_id = src.to_string();
                        }
                        _ => {}
                    }
                    iscan = is + ie + 1;
                }

                let Some(pos_arr) = sources.get(&pos_src_id) else { continue };
                let norm_arr = sources.get(&norm_src_id);
                let uv_arr = sources.get(&uv_src_id);
                let stride = max_off + 1;

                let vcounts: Vec<usize> = if is_polylist {
                    if let Some((_, vc_body, _)) = xml_inner(pbody, "<vcount", "</vcount>") {
                        vc_body.split_whitespace().filter_map(|s| s.parse().ok()).collect()
                    } else {
                        Vec::new()
                    }
                } else {
                    Vec::new()
                };

                let Some((_, idx_body, _)) = xml_inner(pbody, "<p", "</p>") else { continue };
                let p_vals: Vec<usize> = idx_body.split_whitespace().filter_map(|s| s.parse().ok()).collect();
                if p_vals.len() < stride * 3 {
                    continue;
                }

                let start_idx = out.indices.len() as u32;
                let mut v_cache: HashMap<(usize, usize, usize), u32> = HashMap::new();
                let mut emit_corner = |base: usize| -> u32 {
                    let pi = p_vals[base + pos_off];
                    let ni = if norm_off != usize::MAX { p_vals[base + norm_off] + 1 } else { 0 };
                    let ti = if uv_off != usize::MAX { p_vals[base + uv_off] + 1 } else { 0 };
                    if let Some(&existing) = v_cache.get(&(pi, ti, ni)) {
                        return existing;
                    }
                    let out_vi = (out.positions.len() / 3) as u32;
                    let p0 = (pi * 3).min(pos_arr.len().saturating_sub(3));
                    let (px, py, pz) = (pos_arr[p0], pos_arr[p0 + 1], pos_arr[p0 + 2]);
                    if z_up {
                        out.positions.extend_from_slice(&[px, pz, -py]);
                    } else {
                        out.positions.extend_from_slice(&[px, py, pz]);
                    }
                    if let (true, Some(na)) = (ni > 0, norm_arr) {
                        has_any_norm = true;
                        let n0 = ((ni - 1) * 3).min(na.len().saturating_sub(3));
                        let (nx, ny, nz) = (na[n0], na[n0 + 1], na[n0 + 2]);
                        if z_up {
                            out.normals.extend_from_slice(&[nx, nz, -ny]);
                        } else {
                            out.normals.extend_from_slice(&[nx, ny, nz]);
                        }
                    } else {
                        out.normals.extend_from_slice(&[0.0, 1.0, 0.0]);
                    }
                    if let (true, Some(ua)) = (ti > 0, uv_arr) {
                        has_any_uv = true;
                        let u0 = ((ti - 1) * 2).min(ua.len().saturating_sub(2));
                        out.uvs.extend_from_slice(&[ua[u0], ua[u0 + 1]]);
                    } else {
                        out.uvs.extend_from_slice(&[0.0, 0.0]);
                    }
                    v_cache.insert((pi, ti, ni), out_vi);
                    out_vi
                };

                if is_polylist && !vcounts.is_empty() {
                    let mut cursor = 0usize;
                    for &vc in &vcounts {
                        if vc < 3 || (cursor + vc) * stride > p_vals.len() {
                            cursor += vc;
                            continue;
                        }
                        let c0 = emit_corner(cursor * stride);
                        let mut prev = emit_corner((cursor + 1) * stride);
                        for k in 2..vc {
                            let cur = emit_corner((cursor + k) * stride);
                            out.indices.extend_from_slice(&[c0, prev, cur]);
                            prev = cur;
                        }
                        cursor += vc;
                    }
                } else {
                    let total_corners = p_vals.len() / stride;
                    let tri_cnt = total_corners / 3;
                    for t in 0..tri_cnt {
                        let a = emit_corner((t * 3) * stride);
                        let b = emit_corner((t * 3 + 1) * stride);
                        let c = emit_corner((t * 3 + 2) * stride);
                        out.indices.extend_from_slice(&[a, b, c]);
                    }
                }

                let cnt = (out.indices.len() as u32) - start_idx;
                if cnt > 0 {
                    submeshes.push(ParsedSubmesh {
                        name: gname.clone(),
                        index_start: start_idx,
                        index_count: cnt,
                        material_index: mat_idx,
                        has_vertex_colors: false,
                    });
                }
            }
        }
    }

    if !has_any_uv {
        out.uvs.clear();
    }
    if !has_any_norm {
        out.normals.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_obj_mtl_and_zbrush_mrgb_import() {
        let obj = b"mtllib plant.mtl\no Leaves\nv 0 0 0\nv 1 0 0\nv 0 1 0\n#MRGB ff22aa44ff33bb55ff44cc66\nvt 0 0\nvt 1 0\nvt 0 1\nusemtl LeafMat\nf 1/1 2/2 3/3\n";
        let mtl = b"newmtl LeafMat\nKd 0.2 0.8 0.3\nNs 250\nmap_Kd -s 1 1 1 textures/leaf_diff.png\nmap_Bump -bm 0.8 textures/leaf_nor.png\n";
        let tris = mesh_kernel_import_dcc(1, obj.as_ptr(), obj.len(), mtl.as_ptr(), mtl.len());
        assert_eq!(tris, 1);
        assert_eq!(mesh_kernel_import_get_positions_len(), 9);
        assert_eq!(mesh_kernel_import_get_uvs_len(), 6);
        assert_eq!(mesh_kernel_import_get_colors_len(), 9);
        let meta = std::str::from_utf8(unsafe {
            slice::from_raw_parts(mesh_kernel_import_get_meta_ptr(), mesh_kernel_import_get_meta_len())
        })
        .unwrap();
        assert!(meta.contains("textures/leaf_diff.png"));
        assert!(meta.contains("textures/leaf_nor.png"));
    }

    #[test]
    fn test_magicavoxel_vox_culling() {
        // Build a minimal valid VOX v150 binary with 2 adjacent voxels (12 - 2 = 10 exposed faces = 20 tris)
        let mut buf: Vec<u8> = Vec::new();
        buf.extend_from_slice(b"VOX ");
        buf.extend_from_slice(&150u32.to_le_bytes());
        buf.extend_from_slice(b"MAIN");
        buf.extend_from_slice(&0u32.to_le_bytes());
        buf.extend_from_slice(&44u32.to_le_bytes());
        // SIZE chunk
        buf.extend_from_slice(b"SIZE");
        buf.extend_from_slice(&12u32.to_le_bytes());
        buf.extend_from_slice(&0u32.to_le_bytes());
        buf.extend_from_slice(&4u32.to_le_bytes());
        buf.extend_from_slice(&4u32.to_le_bytes());
        buf.extend_from_slice(&4u32.to_le_bytes());
        // XYZI chunk (2 adjacent voxels at (0,0,0) and (1,0,0))
        buf.extend_from_slice(b"XYZI");
        buf.extend_from_slice(&12u32.to_le_bytes());
        buf.extend_from_slice(&0u32.to_le_bytes());
        buf.extend_from_slice(&2u32.to_le_bytes());
        buf.extend_from_slice(&[0, 0, 0, 1]);
        buf.extend_from_slice(&[1, 0, 0, 2]);

        let tris = mesh_kernel_import_dcc(3, buf.as_ptr(), buf.len(), std::ptr::null(), 0);
        // 2 cubes = 12 faces, minus 2 shared interior faces = 10 faces = 20 triangles!
        assert_eq!(tris, 20);
        assert_eq!(mesh_kernel_import_get_colors_len(), (mesh_kernel_import_get_positions_len()));
    }

    #[test]
    fn test_3ds_usda_dxf_off_dae_parsers() {
        // OFF with color
        let off = b"COFF\n4 2 0\n0 0 0 255 0 0\n1 0 0 0 255 0\n1 1 0 0 0 255\n0 1 0 255 255 0\n3 0 1 2\n3 0 2 3\n";
        assert_eq!(mesh_kernel_import_dcc(7, off.as_ptr(), off.len(), std::ptr::null(), 0), 2);

        // DXF 3DFACE
        let dxf = b"0\nSECTION\n2\nENTITIES\n0\n3DFACE\n8\nWalls\n62\n1\n10\n0.0\n20\n0.0\n30\n0.0\n11\n2.0\n21\n0.0\n31\n0.0\n12\n2.0\n22\n2.0\n32\n0.0\n13\n0.0\n23\n2.0\n33\n0.0\n0\nENDSEC\n0\nEOF\n";
        assert_eq!(mesh_kernel_import_dcc(5, dxf.as_ptr(), dxf.len(), std::ptr::null(), 0), 2);

        // USDA Mesh + Material
        let usda = br#"#usda 1.0
( upAxis = "Z" )
def Material "PotMat" {
    def Shader "Surface" {
        color3f inputs:diffuseColor = (0.8, 0.3, 0.2)
        asset inputs:file = @textures/pot_diff.jpg@
    }
}
def Mesh "Pot" {
    rel material:binding = </PotMat>
    point3f[] points = [(0,0,0), (1,0,0), (1,1,0), (0,1,0)]
    int[] faceVertexCounts = [4]
    int[] faceVertexIndices = [0, 1, 2, 3]
    texCoord2f[] primvars:st = [(0,0), (1,0), (1,1), (0,1)]
}
"#;
        assert_eq!(mesh_kernel_import_dcc(4, usda.as_ptr(), usda.len(), std::ptr::null(), 0), 2);

        // Collada DAE
        let dae = br##"<?xml version="1.0" encoding="utf-8"?>
<COLLADA version="1.4.1">
  <library_images><image id="img1"><init_from>leaf.png</init_from></image></library_images>
  <library_effects><effect id="fx1"><profile_COMMON><technique sid="common"><lambert><diffuse><texture texture="img1"/></diffuse></lambert></technique></profile_COMMON></effect></library_effects>
  <library_materials><material id="mat1" name="Leaf"><instance_effect url="#fx1"/></material></library_materials>
  <library_geometries>
    <geometry id="g1" name="LeafMesh">
      <mesh>
        <source id="pos"><float_array count="9">0 0 0 1 0 0 0 1 0</float_array></source>
        <source id="uv"><float_array count="6">0 0 1 0 0 1</float_array></source>
        <vertices id="verts"><input semantic="POSITION" source="#pos"/></vertices>
        <triangles count="1" material="mat1">
          <input semantic="VERTEX" source="#verts" offset="0"/>
          <input semantic="TEXCOORD" source="#uv" offset="1"/>
          <p>0 0 1 1 2 2</p>
        </triangles>
      </mesh>
    </geometry>
  </library_geometries>
</COLLADA>"##;
        assert_eq!(mesh_kernel_import_dcc(8, dae.as_ptr(), dae.len(), std::ptr::null(), 0), 1);
    }
}
