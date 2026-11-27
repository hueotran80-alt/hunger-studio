//! Texture atlas storage and bilinear sampler (sRGB LUT + repeat wrap).
use crate::math::*;

pub const TEX_META_STRIDE: usize = 4;

#[derive(Clone, Copy, Debug)]
pub struct TexMeta {
    pub offset: usize, // pixel offset in `data` (each pixel = 4 bytes RGBA8)
    pub w: usize,
    pub h: usize,
    pub srgb: bool,
}

pub struct TexStore {
    pub data: Vec<u8>,
    pub metas: Vec<TexMeta>,
    srgb_lut: [f32; 256],
    lin_lut: [f32; 256],
}

impl Default for TexStore {
    fn default() -> Self {
        Self::new()
    }
}

impl TexStore {
    pub fn new() -> Self {
        let mut srgb_lut = [0.0f32; 256];
        let mut lin_lut = [0.0f32; 256];
        for i in 0..256 {
            let x = i as f32 * (1.0 / 255.0);
            lin_lut[i] = x;
            srgb_lut[i] = if x <= 0.04045 {
                x * (1.0 / 12.92)
            } else {
                ((x + 0.055) * (1.0 / 1.055)).powf(2.4)
            };
        }
        TexStore { data: Vec::new(), metas: Vec::new(), srgb_lut, lin_lut }
    }

    pub fn set(&mut self, data: &[u8], meta_words: &[u32], ntex: usize) {
        self.data = data.to_vec();
        self.metas.clear();
        self.metas.reserve(ntex);
        for i in 0..ntex {
            let b = i * TEX_META_STRIDE;
            if b + 3 >= meta_words.len() { break; }
            self.metas.push(TexMeta {
                offset: meta_words[b] as usize,
                w: meta_words[b + 1] as usize,
                h: meta_words[b + 2] as usize,
                srgb: (meta_words[b + 3] & 1) != 0,
            });
        }
    }

    #[inline(always)]
    fn fetch(&self, meta: &TexMeta, x: usize, y: usize, lut: &[f32; 256]) -> [f32; 4] {
        let i = (meta.offset + y * meta.w + x) * 4;
        if i + 3 >= self.data.len() {
            return [1.0, 1.0, 1.0, 1.0];
        }
        [
            lut[self.data[i] as usize],
            lut[self.data[i + 1] as usize],
            lut[self.data[i + 2] as usize],
            self.lin_lut[self.data[i + 3] as usize],
        ]
    }

    /// Bilinear sample with repeat wrap; row 0 corresponds to v = 0.
    #[inline]
    pub fn sample(&self, tex_id: i32, u: f32, v: f32) -> Option<[f32; 4]> {
        if tex_id < 0 { return None; }
        let meta = self.metas.get(tex_id as usize)?;
        if meta.w == 0 || meta.h == 0 { return None; }
        let lut = if meta.srgb { &self.srgb_lut } else { &self.lin_lut };
        let uu = u - u.floor();
        let vv = v - v.floor();
        let fx = uu * meta.w as f32 - 0.5;
        let fy = vv * meta.h as f32 - 0.5;
        let x0i = fx.floor() as isize;
        let y0i = fy.floor() as isize;
        let tx = fx - x0i as f32;
        let ty = fy - y0i as f32;

        let w = meta.w as isize;
        let h = meta.h as isize;
        let x0 = x0i.rem_euclid(w) as usize;
        let x1 = (x0i + 1).rem_euclid(w) as usize;
        let y0 = y0i.rem_euclid(h) as usize;
        let y1 = (y0i + 1).rem_euclid(h) as usize;

        let c00 = self.fetch(meta, x0, y0, lut);
        let c10 = self.fetch(meta, x1, y0, lut);
        let c01 = self.fetch(meta, x0, y1, lut);
        let c11 = self.fetch(meta, x1, y1, lut);

        let w00 = (1.0 - tx) * (1.0 - ty);
        let w10 = tx * (1.0 - ty);
        let w01 = (1.0 - tx) * ty;
        let w11 = tx * ty;
        Some([
            c00[0] * w00 + c10[0] * w10 + c01[0] * w01 + c11[0] * w11,
            c00[1] * w00 + c10[1] * w10 + c01[1] * w01 + c11[1] * w11,
            c00[2] * w00 + c10[2] * w10 + c01[2] * w01 + c11[2] * w11,
            c00[3] * w00 + c10[3] * w10 + c01[3] * w01 + c11[3] * w11,
        ])
    }

    #[inline]
    pub fn sample_rgb(&self, tex_id: i32, u: f32, v: f32) -> Option<V3> {
        let c = self.sample(tex_id, u, v)?;
        Some(v3(c[0], c[1], c[2]))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bilinear_and_wrap_and_srgb() {
        let mut store = TexStore::new();
        // 2x2 RGBA8: (0,0)=black, (1,0)=white, (0,1)=red, (1,1)=green
        let data = [
            0, 0, 0, 255,
            255, 255, 255, 255,
            255, 0, 0, 255,
            0, 255, 0, 255,
        ];
        // linear texture
        store.set(&data, &[0, 2, 2, 0, 0, 2, 2, 1], 2);
        // Center of pixel (0,0) is at u=0.25, v=0.25
        let c00 = store.sample(0, 0.25, 0.25).unwrap();
        assert!(c00[0].abs() < 1e-5 && c00[1].abs() < 1e-5);
        // Wrap negative u/v: u=-0.75 -> 0.25, v=1.25 -> 0.25
        let cw = store.sample(0, -0.75, 1.25).unwrap();
        assert!((cw[0] - c00[0]).abs() < 1e-5);
        // Midpoint between (0,0) black and (1,0) white: u=0.5, v=0.25 -> 0.5
        let cm = store.sample(0, 0.5, 0.25).unwrap();
        assert!((cm[0] - 0.5).abs() < 1e-5);
        // sRGB midpoint: tex 1 at (0.5, 0.25) -> 0.5 (since LUT of 0 is 0, LUT of 255 is 1, interpolated in linear!)
        let cs = store.sample(1, 0.5, 0.25).unwrap();
        assert!((cs[0] - 0.5).abs() < 1e-5);
        // sRGB ~188 -> ~0.5 linear
        let mut s2 = TexStore::new();
        s2.set(&[188, 188, 188, 255], &[0, 1, 1, 1], 1);
        let c188 = s2.sample(0, 0.5, 0.5).unwrap();
        assert!(c188[0] > 0.48 && c188[0] < 0.52, "srgb 188 = {}", c188[0]);
    }
}
