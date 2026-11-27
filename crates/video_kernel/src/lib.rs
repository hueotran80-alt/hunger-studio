//! Web Blender Studio - Ultra-Fast Rust Video & Animation Post-Processing Kernel (WASM + SIMD128)
//! Zero-GC-churn pixel pipeline:
//! - Persistent-scratch in-place Y-flip (WebGL bottom-up -> Video top-down)
//! - BT.601 RGBA -> Planar YUV420p (I420)
//! - 64-bit FNV-1a deterministic frame hashing & frame-to-frame MAE motion diff
//! - Color grading (exposure, contrast, saturation, vignette)
//! - Fast box-filter RGBA downscale for live Render Window preview
//! - Blender-style Metadata Burn-In Stamp (5x7 bitmap font overlay)

use std::alloc::{alloc, dealloc, Layout};

static mut SCRATCH_ROW: Vec<u8> = Vec::new();

#[no_mangle]
pub extern "C" fn alloc_bytes(size: usize) -> *mut u8 {
    if size == 0 {
        return std::ptr::null_mut();
    }
    let layout = Layout::from_size_align(size, 16).unwrap_or(Layout::new::<u8>());
    unsafe { alloc(layout) }
}

#[no_mangle]
pub extern "C" fn dealloc_bytes(ptr: *mut u8, size: usize) {
    if ptr.is_null() || size == 0 {
        return;
    }
    let layout = Layout::from_size_align(size, 16).unwrap_or(Layout::new::<u8>());
    unsafe { dealloc(ptr, layout) }
}

#[no_mangle]
pub extern "C" fn vk_version() -> u32 {
    2
}

/// Inverts WebGL bottom-to-top RGBA pixel rows in-place into standard video top-to-bottom.
/// Reuses a persistent scratch row buffer for zero per-frame heap allocations.
#[no_mangle]
#[allow(static_mut_refs)]
pub extern "C" fn flip_y_rgba(ptr: *mut u8, width: usize, height: usize) {
    if ptr.is_null() || width == 0 || height <= 1 {
        return;
    }
    let row_bytes = width * 4;
    let data = unsafe { std::slice::from_raw_parts_mut(ptr, width * height * 4) };

    unsafe {
        if SCRATCH_ROW.len() < row_bytes {
            SCRATCH_ROW.resize(row_bytes, 0);
        }
        let temp = &mut SCRATCH_ROW[..row_bytes];
        let mut top = 0;
        let mut bottom = height - 1;
        while top < bottom {
            let top_start = top * row_bytes;
            let top_end = top_start + row_bytes;
            let bottom_start = bottom * row_bytes;
            let bottom_end = bottom_start + row_bytes;

            temp.copy_from_slice(&data[top_start..top_end]);
            data.copy_within(bottom_start..bottom_end, top_start);
            data[bottom_start..bottom_end].copy_from_slice(temp);

            top += 1;
            bottom -= 1;
        }
    }
}

/// Converts RGBA buffer to Planar YUV420p (I420) using integer fixed-point arithmetic.
#[no_mangle]
pub extern "C" fn rgba_to_yuv420p(
    rgba_ptr: *const u8,
    width: usize,
    height: usize,
    y_ptr: *mut u8,
    u_ptr: *mut u8,
    v_ptr: *mut u8,
) {
    if rgba_ptr.is_null() || y_ptr.is_null() || u_ptr.is_null() || v_ptr.is_null() {
        return;
    }
    let rgba = unsafe { std::slice::from_raw_parts(rgba_ptr, width * height * 4) };
    let y_plane = unsafe { std::slice::from_raw_parts_mut(y_ptr, width * height) };
    let half_w = width / 2;
    let half_h = height / 2;
    let u_plane = unsafe { std::slice::from_raw_parts_mut(u_ptr, half_w * half_h) };
    let v_plane = unsafe { std::slice::from_raw_parts_mut(v_ptr, half_w * half_h) };

    for row in 0..height {
        let row_offset = row * width;
        let rgba_row = row_offset * 4;
        for col in 0..width {
            let px = rgba_row + col * 4;
            let r = rgba[px] as i32;
            let g = rgba[px + 1] as i32;
            let b = rgba[px + 2] as i32;
            let y_val = ((77 * r + 150 * g + 29 * b) >> 8).clamp(0, 255) as u8;
            y_plane[row_offset + col] = y_val;
        }
    }

    for uv_y in 0..half_h {
        let y_top = uv_y * 2;
        let y_bot = y_top + 1;
        let uv_row = uv_y * half_w;

        for uv_x in 0..half_w {
            let x_left = uv_x * 2;
            let x_right = x_left + 1;

            let p0 = (y_top * width + x_left) * 4;
            let p1 = (y_top * width + x_right) * 4;
            let p2 = (y_bot * width + x_left) * 4;
            let p3 = (y_bot * width + x_right) * 4;

            let avg_r = (rgba[p0] as i32 + rgba[p1] as i32 + rgba[p2] as i32 + rgba[p3] as i32) >> 2;
            let avg_g = (rgba[p0 + 1] as i32 + rgba[p1 + 1] as i32 + rgba[p2 + 1] as i32 + rgba[p3 + 1] as i32) >> 2;
            let avg_b = (rgba[p0 + 2] as i32 + rgba[p1 + 2] as i32 + rgba[p2 + 2] as i32 + rgba[p3 + 2] as i32) >> 2;

            let u_val = (((-43 * avg_r - 84 * avg_g + 128 * avg_b) >> 8) + 128).clamp(0, 255) as u8;
            let v_val = (((128 * avg_r - 107 * avg_g - 21 * avg_b) >> 8) + 128).clamp(0, 255) as u8;

            let uv_idx = uv_row + uv_x;
            u_plane[uv_idx] = u_val;
            v_plane[uv_idx] = v_val;
        }
    }
}

/// 64-bit FNV-1a Hash over pixel buffer for deterministic verification of identical/stalled frames.
#[no_mangle]
pub extern "C" fn compute_frame_hash(ptr: *const u8, len: usize) -> u64 {
    if ptr.is_null() || len == 0 {
        return 0;
    }
    let data = unsafe { std::slice::from_raw_parts(ptr, len) };
    let mut hash: u64 = 0xcbf29ce484222325;
    const PRIME: u64 = 0x100000001b3;

    for &b in data {
        hash ^= b as u64;
        hash = hash.wrapping_mul(PRIME);
    }
    hash
}

/// Computes normalized mean absolute difference (0.0..1.0) between two RGBA frame buffers.
#[no_mangle]
pub extern "C" fn compute_frame_diff(ptr_a: *const u8, ptr_b: *const u8, len: usize) -> f32 {
    if ptr_a.is_null() || ptr_b.is_null() || len < 4 {
        return 0.0;
    }
    let a = unsafe { std::slice::from_raw_parts(ptr_a, len) };
    let b = unsafe { std::slice::from_raw_parts(ptr_b, len) };
    let mut sum: u64 = 0;
    let mut count: u64 = 0;
    let mut i = 0;
    while i + 3 < len {
        sum += (a[i] as i32 - b[i] as i32).unsigned_abs() as u64;
        sum += (a[i + 1] as i32 - b[i + 1] as i32).unsigned_abs() as u64;
        sum += (a[i + 2] as i32 - b[i + 2] as i32).unsigned_abs() as u64;
        count += 3;
        i += 4;
    }
    if count == 0 {
        return 0.0;
    }
    (sum as f64 / (count as f64 * 255.0)) as f32
}

/// In-place vignette filter using fixed-point math for subtle cinema focus edge darkening.
#[no_mangle]
pub extern "C" fn apply_vignette_inplace(ptr: *mut u8, width: usize, height: usize, strength_fp: u32) {
    if ptr.is_null() || width == 0 || height == 0 || strength_fp == 0 {
        return;
    }
    let data = unsafe { std::slice::from_raw_parts_mut(ptr, width * height * 4) };
    let cx = (width as f32) * 0.5;
    let cy = (height as f32) * 0.5;
    let max_dist_sq = (cx * cx + cy * cy).max(1.0);
    let strength = (strength_fp as f32) / 256.0;

    for y in 0..height {
        let dy = (y as f32) - cy;
        let dy_sq = dy * dy;
        let row_offset = y * width * 4;

        for x in 0..width {
            let dx = (x as f32) - cx;
            let dist_sq = dx * dx + dy_sq;
            let f = (1.0 - (dist_sq / max_dist_sq) * strength).clamp(0.0, 1.0);

            let idx = row_offset + x * 4;
            data[idx] = ((data[idx] as f32) * f) as u8;
            data[idx + 1] = ((data[idx + 1] as f32) * f) as u8;
            data[idx + 2] = ((data[idx + 2] as f32) * f) as u8;
        }
    }
}

/// Fast in-place Blender-like color grading: exposure multiplier, contrast (1.0=neutral),
/// saturation (1.0=neutral), and radial vignette (0.0..1.0). Preserves alpha.
#[no_mangle]
pub extern "C" fn apply_color_grade_inplace(
    ptr: *mut u8,
    width: usize,
    height: usize,
    exposure: f32,
    contrast: f32,
    saturation: f32,
    vignette: f32,
) {
    if ptr.is_null() || width == 0 || height == 0 {
        return;
    }
    let exp = exposure.clamp(0.0, 8.0);
    let con = contrast.clamp(0.0, 3.0);
    let sat = saturation.clamp(0.0, 3.0);
    let vig = vignette.clamp(0.0, 1.0);
    if (exp - 1.0).abs() < 1e-4 && (con - 1.0).abs() < 1e-4 && (sat - 1.0).abs() < 1e-4 && vig < 1e-4 {
        return;
    }
    let data = unsafe { std::slice::from_raw_parts_mut(ptr, width * height * 4) };
    let cx = width as f32 * 0.5;
    let cy = height as f32 * 0.5;
    let inv_max_r2 = 1.0 / (cx * cx + cy * cy).max(1.0);

    for y in 0..height {
        let dy = y as f32 - cy;
        let dy2 = dy * dy;
        let row = y * width * 4;
        for x in 0..width {
            let i = row + x * 4;
            let mut r = data[i] as f32 * (1.0 / 255.0) * exp;
            let mut g = data[i + 1] as f32 * (1.0 / 255.0) * exp;
            let mut b = data[i + 2] as f32 * (1.0 / 255.0) * exp;

            if (con - 1.0).abs() >= 1e-4 {
                r = (r - 0.5) * con + 0.5;
                g = (g - 0.5) * con + 0.5;
                b = (b - 0.5) * con + 0.5;
            }
            if (sat - 1.0).abs() >= 1e-4 {
                let lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
                r = lum + (r - lum) * sat;
                g = lum + (g - lum) * sat;
                b = lum + (b - lum) * sat;
            }
            if vig >= 1e-4 {
                let dx = x as f32 - cx;
                let vf = (1.0 - (dx * dx + dy2) * inv_max_r2 * vig).clamp(0.0, 1.0);
                r *= vf;
                g *= vf;
                b *= vf;
            }
            data[i] = (r.clamp(0.0, 1.0) * 255.0 + 0.5) as u8;
            data[i + 1] = (g.clamp(0.0, 1.0) * 255.0 + 0.5) as u8;
            data[i + 2] = (b.clamp(0.0, 1.0) * 255.0 + 0.5) as u8;
        }
    }
}

/// Fast box-filter RGBA downscale for crisp live Render Window preview thumbnails.
#[no_mangle]
pub extern "C" fn downscale_rgba_box(
    src_ptr: *const u8,
    sw: usize,
    sh: usize,
    dst_ptr: *mut u8,
    dw: usize,
    dh: usize,
) {
    if src_ptr.is_null() || dst_ptr.is_null() || sw == 0 || sh == 0 || dw == 0 || dh == 0 {
        return;
    }
    let src = unsafe { std::slice::from_raw_parts(src_ptr, sw * sh * 4) };
    let dst = unsafe { std::slice::from_raw_parts_mut(dst_ptr, dw * dh * 4) };

    for dy in 0..dh {
        let sy0 = (dy * sh) / dh;
        let sy1 = (((dy + 1) * sh) / dh).max(sy0 + 1).min(sh);
        for dx in 0..dw {
            let sx0 = (dx * sw) / dw;
            let sx1 = (((dx + 1) * sw) / dw).max(sx0 + 1).min(sw);
            let mut r = 0u32;
            let mut g = 0u32;
            let mut b = 0u32;
            let mut a = 0u32;
            let mut cnt = 0u32;
            for sy in sy0..sy1 {
                let row = sy * sw * 4;
                for sx in sx0..sx1 {
                    let i = row + sx * 4;
                    r += src[i] as u32;
                    g += src[i + 1] as u32;
                    b += src[i + 2] as u32;
                    a += src[i + 3] as u32;
                    cnt += 1;
                }
            }
            let di = (dy * dw + dx) * 4;
            let c = cnt.max(1);
            dst[di] = (r / c) as u8;
            dst[di + 1] = (g / c) as u8;
            dst[di + 2] = (b / c) as u8;
            dst[di + 3] = (a / c) as u8;
        }
    }
}

/// Compact 5x7 uppercase/numeric/punctuation bitmap font for Blender-style Metadata Burn-In.
/// Each glyph is 7 rows of 5 bits (bit 4 = leftmost pixel).
fn glyph_5x7(ch: u8) -> [u8; 7] {
    let c = if ch >= b'a' && ch <= b'z' { ch - 32 } else { ch };
    match c {
        b'0' => [0x0E, 0x11, 0x13, 0x15, 0x19, 0x11, 0x0E],
        b'1' => [0x04, 0x0C, 0x04, 0x04, 0x04, 0x04, 0x0E],
        b'2' => [0x0E, 0x11, 0x01, 0x06, 0x08, 0x10, 0x1F],
        b'3' => [0x1F, 0x02, 0x04, 0x02, 0x01, 0x11, 0x0E],
        b'4' => [0x02, 0x06, 0x0A, 0x12, 0x1F, 0x02, 0x02],
        b'5' => [0x1F, 0x10, 0x1E, 0x01, 0x01, 0x11, 0x0E],
        b'6' => [0x06, 0x08, 0x10, 0x1E, 0x11, 0x11, 0x0E],
        b'7' => [0x1F, 0x01, 0x02, 0x04, 0x08, 0x08, 0x08],
        b'8' => [0x0E, 0x11, 0x11, 0x0E, 0x11, 0x11, 0x0E],
        b'9' => [0x0E, 0x11, 0x11, 0x0F, 0x01, 0x02, 0x0C],
        b'A' => [0x0E, 0x11, 0x11, 0x1F, 0x11, 0x11, 0x11],
        b'B' => [0x1E, 0x11, 0x11, 0x1E, 0x11, 0x11, 0x1E],
        b'C' => [0x0E, 0x11, 0x10, 0x10, 0x10, 0x11, 0x0E],
        b'D' => [0x1C, 0x12, 0x11, 0x11, 0x11, 0x12, 0x1C],
        b'E' => [0x1F, 0x10, 0x10, 0x1E, 0x10, 0x10, 0x1F],
        b'F' => [0x1F, 0x10, 0x10, 0x1E, 0x10, 0x10, 0x10],
        b'G' => [0x0E, 0x11, 0x10, 0x17, 0x11, 0x11, 0x0F],
        b'H' => [0x11, 0x11, 0x11, 0x1F, 0x11, 0x11, 0x11],
        b'I' => [0x0E, 0x04, 0x04, 0x04, 0x04, 0x04, 0x0E],
        b'J' => [0x07, 0x02, 0x02, 0x02, 0x02, 0x12, 0x0C],
        b'K' => [0x11, 0x12, 0x14, 0x18, 0x14, 0x12, 0x11],
        b'L' => [0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x1F],
        b'M' => [0x11, 0x1B, 0x15, 0x15, 0x11, 0x11, 0x11],
        b'N' => [0x11, 0x11, 0x19, 0x15, 0x13, 0x11, 0x11],
        b'O' => [0x0E, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0E],
        b'P' => [0x1E, 0x11, 0x11, 0x1E, 0x10, 0x10, 0x10],
        b'Q' => [0x0E, 0x11, 0x11, 0x11, 0x15, 0x12, 0x0D],
        b'R' => [0x1E, 0x11, 0x11, 0x1E, 0x14, 0x12, 0x11],
        b'S' => [0x0F, 0x10, 0x10, 0x0E, 0x01, 0x01, 0x1E],
        b'T' => [0x1F, 0x04, 0x04, 0x04, 0x04, 0x04, 0x04],
        b'U' => [0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0E],
        b'V' => [0x11, 0x11, 0x11, 0x11, 0x11, 0x0A, 0x04],
        b'W' => [0x11, 0x11, 0x11, 0x15, 0x15, 0x1B, 0x11],
        b'X' => [0x11, 0x11, 0x0A, 0x04, 0x0A, 0x11, 0x11],
        b'Y' => [0x11, 0x11, 0x0A, 0x04, 0x04, 0x04, 0x04],
        b'Z' => [0x1F, 0x01, 0x02, 0x04, 0x08, 0x10, 0x1F],
        b':' => [0x00, 0x04, 0x04, 0x00, 0x04, 0x04, 0x00],
        b'.' => [0x00, 0x00, 0x00, 0x00, 0x00, 0x0C, 0x0C],
        b'-' => [0x00, 0x00, 0x00, 0x1F, 0x00, 0x00, 0x00],
        b'/' => [0x01, 0x02, 0x02, 0x04, 0x08, 0x08, 0x10],
        b'|' => [0x04, 0x04, 0x04, 0x04, 0x04, 0x04, 0x04],
        b'_' => [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x1F],
        b'(' => [0x02, 0x04, 0x08, 0x08, 0x08, 0x04, 0x02],
        b')' => [0x08, 0x04, 0x02, 0x02, 0x02, 0x04, 0x08],
        b'[' => [0x0E, 0x08, 0x08, 0x08, 0x08, 0x08, 0x0E],
        b']' => [0x0E, 0x02, 0x02, 0x02, 0x02, 0x02, 0x0E],
        b'#' => [0x0A, 0x0A, 0x1F, 0x0A, 0x1F, 0x0A, 0x0A],
        b'%' => [0x19, 0x19, 0x02, 0x04, 0x08, 0x13, 0x13],
        b'+' => [0x00, 0x04, 0x04, 0x1F, 0x04, 0x04, 0x00],
        b',' => [0x00, 0x00, 0x00, 0x00, 0x04, 0x04, 0x08],
        _ => [0x00; 7],
    }
}

/// Renders Blender-style Metadata Burn-In Stamp directly into an RGBA8 frame in Rust WASM.
/// `position`: 0 = bottom bar, 1 = top bar. `scale`: pixel scale (0 = auto based on width).
#[no_mangle]
pub extern "C" fn burn_in_metadata_rgba(
    ptr: *mut u8,
    width: usize,
    height: usize,
    text_ptr: *const u8,
    text_len: usize,
    position: u32,
    scale: u32,
) {
    if ptr.is_null() || text_ptr.is_null() || width < 32 || height < 24 || text_len == 0 {
        return;
    }
    let data = unsafe { std::slice::from_raw_parts_mut(ptr, width * height * 4) };
    let text = unsafe { std::slice::from_raw_parts(text_ptr, text_len) };

    let s = if scale > 0 {
        scale as usize
    } else if width >= 1200 {
        2
    } else {
        1
    };
    let char_w = 6 * s;
    let char_h = 7 * s;
    let pad_x = 8 * s;
    let pad_y = 5 * s;
    let bar_h = (char_h + pad_y * 2).min(height);
    let y0 = if position == 1 { 0 } else { height.saturating_sub(bar_h) };

    // Semi-transparent dark Blender-style stamp bar (65% black)
    for y in y0..(y0 + bar_h).min(height) {
        let row = y * width * 4;
        for x in 0..width {
            let i = row + x * 4;
            data[i] = ((data[i] as u32 * 90) >> 8) as u8;
            data[i + 1] = ((data[i + 1] as u32 * 90) >> 8) as u8;
            data[i + 2] = ((data[i + 2] as u32 * 90) >> 8) as u8;
            data[i + 3] = data[i + 3].max(190);
        }
    }

    let text_y = y0 + pad_y;
    let mut cursor_x = pad_x;
    for &ch in text {
        if cursor_x + char_w > width.saturating_sub(pad_x) {
            break;
        }
        let glyph = glyph_5x7(ch);
        for gy in 0..7 {
            let row_bits = glyph[gy];
            if row_bits == 0 {
                continue;
            }
            for gx in 0..5 {
                if (row_bits & (1 << (4 - gx))) != 0 {
                    for sy in 0..s {
                        let py = text_y + gy * s + sy;
                        if py >= height { continue; }
                        for sx in 0..s {
                            let px = cursor_x + gx * s + sx;
                            if px >= width { continue; }
                            let idx = (py * width + px) * 4;
                            data[idx] = 242;
                            data[idx + 1] = 244;
                            data[idx + 2] = 248;
                            data[idx + 3] = 255;
                        }
                    }
                }
            }
        }
        cursor_x += char_w;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn flip_y_inverts_rows_and_preserves_middle() {
        let (w, h) = (2usize, 3usize);
        let mut buf = vec![0u8; w * h * 4];
        for c in 0..w {
            buf[c * 4] = 255; buf[c * 4 + 3] = 255; // row 0 red
            buf[(w + c) * 4 + 1] = 255; buf[(w + c) * 4 + 3] = 255; // row 1 green
            buf[(2 * w + c) * 4 + 2] = 255; buf[(2 * w + c) * 4 + 3] = 255; // row 2 blue
        }
        flip_y_rgba(buf.as_mut_ptr(), w, h);
        assert_eq!(&buf[0..4], &[0, 0, 255, 255]);
        assert_eq!(&buf[w * 4..w * 4 + 4], &[0, 255, 0, 255]);
        assert_eq!(&buf[2 * w * 4..2 * w * 4 + 4], &[255, 0, 0, 255]);
    }

    #[test]
    fn frame_diff_detects_identical_vs_changed() {
        let a = vec![100u8; 64];
        let b = vec![100u8; 64];
        let c = vec![200u8; 64];
        assert_eq!(compute_frame_diff(a.as_ptr(), b.as_ptr(), a.len()), 0.0);
        let d = compute_frame_diff(a.as_ptr(), c.as_ptr(), a.len());
        assert!((d - 100.0 / 255.0).abs() < 1e-4, "expected ~0.392, got {d}");
    }

    #[test]
    fn metadata_burn_in_draws_bar_and_glyphs() {
        let (w, h) = (160usize, 48usize);
        let mut buf = vec![120u8; w * h * 4];
        let label = b"F:0042 | 00:00:01:12 | CYCLES";
        burn_in_metadata_rgba(buf.as_mut_ptr(), w, h, label.as_ptr(), label.len(), 0, 1);
        // Bottom bar background should be darkened (< 60), text pixels bright (> 230)
        let mut bright_px = 0usize;
        let mut dark_px = 0usize;
        for y in (h - 17)..h {
            for x in 0..w {
                let r = buf[(y * w + x) * 4];
                if r > 230 { bright_px += 1; }
                if r < 60 { dark_px += 1; }
            }
        }
        assert!(bright_px > 50, "expected crisp stamped text pixels, got {bright_px}");
        assert!(dark_px > 500, "expected darkened metadata plate, got {dark_px}");
    }

    #[test]
    fn downscale_box_averages_2x2() {
        let (sw, sh) = (4usize, 4usize);
        let mut src = vec![0u8; sw * sh * 4];
        for p in 0..(sw * sh) {
            src[p * 4] = 200;
            src[p * 4 + 1] = 100;
            src[p * 4 + 2] = 50;
            src[p * 4 + 3] = 255;
        }
        let mut dst = vec![0u8; 2 * 2 * 4];
        downscale_rgba_box(src.as_ptr(), sw, sh, dst.as_mut_ptr(), 2, 2);
        assert_eq!(&dst[0..4], &[200, 100, 50, 255]);
    }

    #[test]
    fn frame_hash_distinguishes_all_rgba_channels() {
        let green = [0u8, 255, 0, 255, 0, 255, 0, 255];
        let blue = [0u8, 0, 255, 255, 0, 0, 255, 255];
        let alpha = [0u8, 0, 255, 128, 0, 0, 255, 255];
        let hg = compute_frame_hash(green.as_ptr(), green.len());
        let hb = compute_frame_hash(blue.as_ptr(), blue.len());
        let ha = compute_frame_hash(alpha.as_ptr(), alpha.len());
        assert_ne!(hg, hb, "G and B channels must affect frame hash");
        assert_ne!(hb, ha, "Alpha channel must affect frame hash");
    }

    #[test]
    fn color_grade_supports_zero_exposure_and_zero_contrast() {
        let mut dark = [150u8, 100, 50, 255];
        apply_color_grade_inplace(dark.as_mut_ptr(), 1, 1, 0.0, 1.0, 1.0, 0.0);
        assert_eq!(dark, [0, 0, 0, 255]);

        let mut flat = [20u8, 240, 100, 255];
        apply_color_grade_inplace(flat.as_mut_ptr(), 1, 1, 1.0, 0.0, 1.0, 0.0);
        assert!((flat[0] as i32 - 128).abs() <= 1 && (flat[1] as i32 - 128).abs() <= 1 && flat[3] == 255);
    }
}
