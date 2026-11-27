//! Native multi-threaded CLI renderer for `render_kernel` (zero external dependencies).
//! Usage: rk_cli <scene.json> <out.png> [--threads N] [--spp N] [--no-denoise]
//!    or: rk_cli --bench  (runs built-in Cornell box benchmark)

use render_kernel::env::Env;
use render_kernel::math::*;
use render_kernel::post::{self, AOV_STRIDE};
use render_kernel::{build_tris_and_attrs, Camera, Light, Material, RenderParams, Scene};
use std::fs::File;
use std::io::{BufWriter, Write};
use std::time::Instant;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.iter().any(|a| a == "--bench") {
        run_bench(&args);
        return;
    }
    if args.len() < 3 || args.iter().any(|a| a == "-h" || a == "--help") {
        eprintln!("Usage: rk_cli <scene.json> <out.png> [--threads N] [--spp N] [--no-denoise]");
        eprintln!("   or: rk_cli --bench [--threads N] [--spp N] [--size WxH]");
        std::process::exit(if args.len() < 2 { 1 } else { 0 });
    }
    let scene_path = &args[1];
    let out_path = &args[2];
    let threads = parse_arg(&args, "--threads").unwrap_or_else(|| {
        std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4)
    });
    let spp_override: Option<u32> = parse_arg(&args, "--spp");
    let no_denoise = args.iter().any(|a| a == "--no-denoise");

    let text = std::fs::read_to_string(scene_path).unwrap_or_else(|e| {
        eprintln!("Failed to read {scene_path}: {e}");
        std::process::exit(1);
    });
    let val = Json::parse(&text).unwrap_or_else(|e| {
        eprintln!("Invalid JSON: {e}");
        std::process::exit(1);
    });
    let width = val.num("width").unwrap_or(512.0) as usize;
    let height = val.num("height").unwrap_or(384.0) as usize;
    let spp = spp_override.unwrap_or_else(|| val.num("samples").unwrap_or(64.0) as u32);
    let max_bounces = val.num("maxBounces").unwrap_or(5.0) as u32;
    let denoise = !no_denoise && val.bool("denoise").unwrap_or(true);
    let exposure = val.num("exposure").unwrap_or(1.0) as f32;
    let tonemap_mode = match val.str("tonemap").unwrap_or("agx") {
        "linear" => 0,
        "aces" => 1,
        "neutral" => 3,
        _ => 2,
    };

    let pos = val.f32_arr("pos");
    let nrm = val.f32_arr("nrm");
    let uvs = val.f32_arr("uvs");
    let mat_ids: Vec<u32> = val.f32_arr("matIds").into_iter().map(|x| x as u32).collect();
    let ntri = pos.len() / 9;
    let (tris, attrs) = build_tris_and_attrs(&pos, &nrm, &uvs, &mat_ids, ntri);

    let mut mats = Vec::new();
    if let Some(arr) = val.arr("materials") {
        for item in arr {
            let mut m = Material::default();
            if let Some(c) = item.vec3("color") { m.base = c; }
            if let Some(x) = item.num("metalness") { m.metal = x as f32; }
            if let Some(x) = item.num("roughness") { m.rough = x as f32; }
            if let Some(c) = item.vec3("emissive") { m.emit = c; }
            if let Some(x) = item.num("transmission") { m.trans = x as f32; }
            if let Some(x) = item.num("ior") { m.ior = x as f32; }
            if let Some(x) = item.num("clearcoat") { m.clearcoat = x as f32; }
            mats.push(m);
        }
    }
    if mats.is_empty() { mats.push(Material::default()); }

    let mut lights = Vec::new();
    if let Some(arr) = val.arr("lights") {
        for item in arr {
            let kind = match item.str("type").unwrap_or("point") {
                "directional" | "sun" => 1,
                "spot" => 2,
                "rect" | "area" => 3,
                _ => 0,
            };
            lights.push(Light {
                kind,
                pos: item.vec3("pos").unwrap_or(v3(0.0, 3.0, 0.0)),
                color: item.vec3("color").unwrap_or(V3::splat(20.0)),
                dir: item.vec3("dir").unwrap_or(v3(0.0, -1.0, 0.0)).norm(),
                radius: item.num("radius").unwrap_or(0.02) as f32,
                param0: item.num("param0").unwrap_or(0.8) as f32,
                param1: item.num("param1").unwrap_or(0.9) as f32,
                area_u: item.vec3("areaU").unwrap_or(v3(1.0, 0.0, 0.0)).norm(),
            });
        }
    }

    let mut sc = Scene::new(tris, attrs, mats, lights);
    if let Some(c) = val.obj("camera") {
        let origin = c.vec3("origin").unwrap_or(v3(0.0, 1.5, 4.0));
        let target = c.vec3("target").unwrap_or(v3(0.0, 1.0, 0.0));
        let fov = (c.num("fov").unwrap_or(50.0) as f32).to_radians();
        let fwd = (target - origin).norm();
        let right_n = fwd.cross(v3(0.0, 1.0, 0.0)).norm();
        let up_n = right_n.cross(fwd).norm();
        let ty = (fov * 0.5).tan();
        let tx = ty * (width as f32 / height as f32);
        sc.cam = Camera {
            origin,
            fwd,
            right: right_n * tx,
            up: up_n * ty,
            aperture: c.num("aperture").unwrap_or(0.0) as f32,
            focus: c.num("focus").unwrap_or(4.0) as f32,
            ortho: c.bool("ortho").unwrap_or(false),
            shutter: c.num("shutter").unwrap_or(0.0) as f32,
        };
    }
    if let Some(bg) = val.vec3("background") {
        sc.bg_mode = 1;
        sc.bg = bg;
    }

    let rgba = render_mt(&sc, width, height, spp, max_bounces, denoise, exposure, tonemap_mode, threads);
    write_png(out_path, &rgba, width, height).expect("Failed to write PNG");
    println!("Wrote {out_path} ({width}x{height}, {spp} spp, {threads} threads)");
}

fn render_mt(
    sc: &Scene,
    w: usize,
    h: usize,
    spp: u32,
    max_bounces: u32,
    denoise: bool,
    exposure: f32,
    tonemap_mode: u32,
    threads: usize,
) -> Vec<u8> {
    let t0 = Instant::now();
    let mut accum = vec![0.0f32; w * h * 4];
    let mut aov = vec![0.0f32; w * h * AOV_STRIDE];
    let params = RenderParams { spp, seed: 1, max_bounces, clamp: 20.0, adaptive_threshold: 0.015 };

    let chunk_rows = (h / threads.max(1)).max(1);
    std::thread::scope(|s| {
        let mut rem_acc = accum.as_mut_slice();
        let mut rem_aov = aov.as_mut_slice();
        let mut y = 0usize;
        let mut handles = Vec::new();
        while y < h {
            let y1 = (y + chunk_rows).min(h);
            let rows = y1 - y;
            let (acc_chunk, next_acc) = rem_acc.split_at_mut(rows * w * 4);
            let (aov_chunk, next_aov) = rem_aov.split_at_mut(rows * w * AOV_STRIDE);
            rem_acc = next_acc;
            rem_aov = next_aov;
            let y0 = y;
            handles.push(s.spawn(move || {
                sc.render_rows(acc_chunk, aov_chunk, w, h, y0, y1, y0, &params);
            }));
            y = y1;
        }
        for h in handles {
            h.join().unwrap();
        }
    });
    let trace_ms = t0.elapsed().as_secs_f64() * 1000.0;

    let mut mean = vec![0.0f32; w * h * 4];
    if denoise {
        post::denoise(&accum, &aov, &mut mean, w, h, spp as f32, 4);
    } else {
        post::mean(&accum, &mut mean, spp as f32);
    }
    let mut rgba = vec![0u8; w * h * 4];
    post::tonemap(&mean, &mut rgba, exposure, tonemap_mode);
    let total_ms = t0.elapsed().as_secs_f64() * 1000.0;
    println!("Render {w}x{h}x{spp}spp ({threads} threads): trace {trace_ms:.1} ms, total {total_ms:.1} ms");
    rgba
}

fn run_bench(args: &[String]) {
    let threads = parse_arg(args, "--threads").unwrap_or_else(|| {
        std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4)
    });
    let spp: u32 = parse_arg(args, "--spp").unwrap_or(32);
    let (w, h) = (256usize, 192usize);

    // Build Cornell box + 2 high-poly spheres (~4.8k tris, matching test_rust_render.mjs)
    let mut pos = Vec::new();
    let mut nrm = Vec::new();
    let mut ids = Vec::new();
    let mut add_quad = |a: V3, b: V3, c: V3, d: V3, n: V3, m: u32| {
        for tri in [[a, b, c], [a, c, d]] {
            for p in tri {
                pos.extend_from_slice(&[p.x, p.y, p.z]);
                nrm.extend_from_slice(&[n.x, n.y, n.z]);
            }
            ids.push(m);
        }
    };
    // Room walls
    add_quad(v3(-3.0, 0.0, -3.0), v3(-3.0, 0.0, 3.0), v3(3.0, 0.0, 3.0), v3(3.0, 0.0, -3.0), v3(0.0, 1.0, 0.0), 0); // floor
    add_quad(v3(-3.0, 4.0, -3.0), v3(3.0, 4.0, -3.0), v3(3.0, 4.0, 3.0), v3(-3.0, 4.0, 3.0), v3(0.0, -1.0, 0.0), 0); // ceil
    add_quad(v3(-3.0, 0.0, -3.0), v3(3.0, 0.0, -3.0), v3(3.0, 4.0, -3.0), v3(-3.0, 4.0, -3.0), v3(0.0, 0.0, 1.0), 0); // back
    add_quad(v3(-2.98, 0.0, 3.0), v3(-2.98, 0.0, -3.0), v3(-2.98, 4.0, -3.0), v3(-2.98, 4.0, 3.0), v3(1.0, 0.0, 0.0), 1); // left red
    add_quad(v3(2.98, 0.0, -3.0), v3(2.98, 0.0, 3.0), v3(2.98, 4.0, 3.0), v3(2.98, 4.0, -3.0), v3(-1.0, 0.0, 0.0), 2); // right green
    add_quad(v3(-0.8, 3.98, -0.8), v3(0.8, 3.98, -0.8), v3(0.8, 3.98, 0.8), v3(-0.8, 3.98, 0.8), v3(0.0, -1.0, 0.0), 5); // lamp
    // Two 48x24 spheres
    let mut add_sphere = |center: V3, r: f32, m: u32| {
        let (nu, nv) = (48usize, 24usize);
        let pt = |iu: usize, iv: usize| -> (V3, V3) {
            let u = iu as f32 / nu as f32 * 2.0 * PI;
            let v = iv as f32 / nv as f32 * PI;
            let n = v3(v.sin() * u.cos(), v.cos(), v.sin() * u.sin());
            (center + n * r, n)
        };
        for iv in 0..nv {
            for iu in 0..nu {
                let (p00, n00) = pt(iu, iv);
                let (p10, n10) = pt(iu + 1, iv);
                let (p01, n01) = pt(iu, iv + 1);
                let (p11, n11) = pt(iu + 1, iv + 1);
                for tri in [[(p00, n00), (p01, n01), (p11, n11)], [(p00, n00), (p11, n11), (p10, n10)]] {
                    for (p, n) in tri {
                        pos.extend_from_slice(&[p.x, p.y, p.z]);
                        nrm.extend_from_slice(&[n.x, n.y, n.z]);
                    }
                    ids.push(m);
                }
            }
        }
    };
    add_sphere(v3(-1.1, 0.8, -0.5), 0.8, 3);
    add_sphere(v3(1.1, 0.8, 0.3), 0.8, 4);

    let (tris, attrs) = build_tris_and_attrs(&pos, &nrm, &[], &ids, ids.len());
    let mats = vec![
        Material { base: v3(0.8, 0.8, 0.8), rough: 0.9, ..Material::default() },
        Material { base: v3(0.8, 0.13, 0.13), rough: 0.9, ..Material::default() },
        Material { base: v3(0.13, 0.67, 0.2), rough: 0.9, ..Material::default() },
        Material { base: v3(1.0, 0.82, 0.5), metal: 1.0, rough: 0.18, ..Material::default() },
        Material { base: v3(1.0, 1.0, 1.0), trans: 1.0, rough: 0.02, ior: 1.5, ..Material::default() },
        Material { base: V3::ZERO, emit: V3::splat(12.0), ..Material::default() },
    ];
    let lights = vec![Light { kind: 0, pos: v3(0.0, 3.5, 0.5), color: V3::splat(28.0), dir: V3::ZERO, radius: 0.02, param0: 0.0, param1: 0.0, area_u: V3::ZERO }];
    let mut sc = Scene::new(tris, attrs, mats, lights);
    sc.env = Env::sky(0.0, V3::ZERO, V3::ZERO, V3::ZERO);
    sc.bg_mode = 1;
    sc.bg = v3(0.02, 0.02, 0.025);
    let origin = v3(0.0, 2.0, 2.9);
    let fwd = (v3(0.0, 1.4, 0.0) - origin).norm();
    let right = fwd.cross(v3(0.0, 1.0, 0.0)).norm();
    let up = right.cross(fwd).norm();
    let ty = (70.0f32.to_radians() * 0.5).tan();
    let tx = ty * (w as f32 / h as f32);
    sc.cam = Camera { origin, fwd, right: right * tx, up: up * ty, aperture: 0.0, focus: 3.0, ortho: false, shutter: 0.0 };

    println!("Triangles: {}, BVH4 nodes: {}", sc.bvh.tris.len(), sc.bvh.nodes4.len());
    render_mt(&sc, w, h, spp, 5, true, 1.0, 2, 1);
    render_mt(&sc, w, h, spp, 5, true, 1.0, 2, threads);
}

fn parse_arg<T: std::str::FromStr>(args: &[String], flag: &str) -> Option<T> {
    args.windows(2).find(|w| w[0] == flag).and_then(|w| w[1].parse().ok())
}

// ── Minimal PNG writer (stored DEFLATE blocks, zero deps) ──

fn crc32(data: &[u8]) -> u32 {
    let mut crc = 0xFFFF_FFFFu32;
    for &b in data {
        crc ^= b as u32;
        for _ in 0..8 {
            crc = if crc & 1 != 0 { (crc >> 1) ^ 0xEDB8_8320 } else { crc >> 1 };
        }
    }
    !crc
}

fn adler32(data: &[u8]) -> u32 {
    let (mut a, mut b) = (1u32, 0u32);
    for &x in data {
        a = (a + x as u32) % 65521;
        b = (b + a) % 65521;
    }
    (b << 16) | a
}

fn write_png(path: &str, rgba: &[u8], w: usize, h: usize) -> std::io::Result<()> {
    let mut raw = Vec::with_capacity((w * 4 + 1) * h);
    for y in 0..h {
        raw.push(0);
        raw.extend_from_slice(&rgba[y * w * 4..(y + 1) * w * 4]);
    }
    let mut zlib = vec![0x78, 0x01]; // zlib header
    let mut off = 0;
    while off < raw.len() {
        let len = (raw.len() - off).min(65535);
        let last = if off + len == raw.len() { 1 } else { 0 };
        zlib.push(last);
        zlib.extend_from_slice(&(len as u16).to_le_bytes());
        zlib.extend_from_slice(&(!(len as u16)).to_le_bytes());
        zlib.extend_from_slice(&raw[off..off + len]);
        off += len;
    }
    zlib.extend_from_slice(&adler32(&raw).to_be_bytes());

    let mut f = BufWriter::new(File::create(path)?);
    f.write_all(&[137, 80, 78, 71, 13, 10, 26, 10])?;
    let mut write_chunk = |tag: &[u8; 4], data: &[u8]| -> std::io::Result<()> {
        f.write_all(&(data.len() as u32).to_be_bytes())?;
        f.write_all(tag)?;
        f.write_all(data)?;
        let mut buf = Vec::with_capacity(4 + data.len());
        buf.extend_from_slice(tag);
        buf.extend_from_slice(data);
        f.write_all(&crc32(&buf).to_be_bytes())
    };
    let mut ihdr = Vec::with_capacity(13);
    ihdr.extend_from_slice(&(w as u32).to_be_bytes());
    ihdr.extend_from_slice(&(h as u32).to_be_bytes());
    ihdr.extend_from_slice(&[8, 6, 0, 0, 0]);
    write_chunk(b"IHDR", &ihdr)?;
    write_chunk(b"IDAT", &zlib)?;
    write_chunk(b"IEND", &[])
}

// ── Minimal recursive-descent JSON parser (zero deps) ──

#[derive(Clone)]
enum Json {
    Null,
    Bool(bool),
    Num(f64),
    Str(String),
    Arr(Vec<Json>),
    Obj(Vec<(String, Json)>),
}

impl Json {
    fn parse(s: &str) -> Result<Json, String> {
        let b = s.as_bytes();
        let mut p = 0;
        let v = Self::val(b, &mut p)?;
        Ok(v)
    }
    fn ws(b: &[u8], p: &mut usize) {
        while *p < b.len() && b[*p].is_ascii_whitespace() { *p += 1; }
    }
    fn val(b: &[u8], p: &mut usize) -> Result<Json, String> {
        Self::ws(b, p);
        if *p >= b.len() { return Err("Unexpected EOF".into()); }
        match b[*p] {
            b'{' => {
                *p += 1;
                let mut m = Vec::new();
                Self::ws(b, p);
                if *p < b.len() && b[*p] == b'}' { *p += 1; return Ok(Json::Obj(m)); }
                loop {
                    Self::ws(b, p);
                    let k = match Self::val(b, p)? { Json::Str(s) => s, _ => return Err("Expected string key".into()) };
                    Self::ws(b, p);
                    if *p >= b.len() || b[*p] != b':' { return Err("Expected ':'".into()); }
                    *p += 1;
                    let v = Self::val(b, p)?;
                    m.push((k, v));
                    Self::ws(b, p);
                    if *p < b.len() && b[*p] == b',' { *p += 1; continue; }
                    if *p < b.len() && b[*p] == b'}' { *p += 1; break; }
                    return Err("Expected ',' or '}'".into());
                }
                Ok(Json::Obj(m))
            }
            b'[' => {
                *p += 1;
                let mut a = Vec::new();
                Self::ws(b, p);
                if *p < b.len() && b[*p] == b']' { *p += 1; return Ok(Json::Arr(a)); }
                loop {
                    a.push(Self::val(b, p)?);
                    Self::ws(b, p);
                    if *p < b.len() && b[*p] == b',' { *p += 1; continue; }
                    if *p < b.len() && b[*p] == b']' { *p += 1; break; }
                    return Err("Expected ',' or ']'".into());
                }
                Ok(Json::Arr(a))
            }
            b'"' => {
                *p += 1;
                let mut out = String::new();
                while *p < b.len() && b[*p] != b'"' {
                    if b[*p] == b'\\' && *p + 1 < b.len() { *p += 1; }
                    out.push(b[*p] as char);
                    *p += 1;
                }
                *p += 1;
                Ok(Json::Str(out))
            }
            b't' => { *p += 4; Ok(Json::Bool(true)) }
            b'f' => { *p += 5; Ok(Json::Bool(false)) }
            b'n' => { *p += 4; Ok(Json::Null) }
            _ => {
                let st = *p;
                while *p < b.len() && (b[*p].is_ascii_digit() || b"-.+eE".contains(&b[*p])) { *p += 1; }
                let n: f64 = std::str::from_utf8(&b[st..*p]).map_err(|e| e.to_string())?.parse().map_err(|_| "Bad number")?;
                Ok(Json::Num(n))
            }
        }
    }
    fn get(&self, k: &str) -> Option<&Json> {
        match self { Json::Obj(m) => m.iter().find(|(x, _)| x == k).map(|(_, v)| v), _ => None }
    }
    fn num(&self, k: &str) -> Option<f64> { match self.get(k)? { Json::Num(x) => Some(*x), _ => None } }
    fn bool(&self, k: &str) -> Option<bool> { match self.get(k)? { Json::Bool(x) => Some(*x), _ => None } }
    fn str(&self, k: &str) -> Option<&str> { match self.get(k)? { Json::Str(s) => Some(s.as_str()), _ => None } }
    fn arr(&self, k: &str) -> Option<&[Json]> { match self.get(k)? { Json::Arr(a) => Some(a), _ => None } }
    fn obj(&self, k: &str) -> Option<&Json> { self.get(k) }
    fn f32_arr(&self, k: &str) -> Vec<f32> {
        self.arr(k).map(|a| a.iter().filter_map(|v| match v { Json::Num(x) => Some(*x as f32), _ => None }).collect()).unwrap_or_default()
    }
    fn vec3(&self, k: &str) -> Option<V3> {
        let a = self.arr(k)?;
        if a.len() < 3 { return None; }
        let g = |i: usize| match a[i] { Json::Num(x) => x as f32, _ => 0.0 };
        Some(v3(g(0), g(1), g(2)))
    }
}
