//! Environment lighting: procedural gradient sky or equirect HDR with importance sampling.
use crate::math::*;

pub struct Env {
    pub intensity: f32,
    pub rot: f32,
    pub top: V3,
    pub horizon: V3,
    pub bottom: V3,
    pub w: usize,
    pub h: usize,
    pub img: Vec<f32>,      // rgb, row 0 = zenith
    row_cdf: Vec<f32>,      // h+1
    col_cdf: Vec<f32>,      // h*(w+1)
    row_sum: Vec<f32>,
    total: f32,
}

impl Env {
    pub fn sky(intensity: f32, top: V3, horizon: V3, bottom: V3) -> Env {
        Env { intensity, rot: 0.0, top, horizon, bottom, w: 0, h: 0, img: vec![], row_cdf: vec![], col_cdf: vec![], row_sum: vec![], total: 0.0 }
    }

    pub fn has_image(&self) -> bool {
        self.w > 0 && self.total > 0.0
    }

    pub fn set_image(&mut self, rgb: &[f32], w: usize, h: usize) {
        self.w = w;
        self.h = h;
        self.img = rgb.to_vec();
        self.row_cdf = vec![0.0; h + 1];
        self.col_cdf = vec![0.0; h * (w + 1)];
        self.row_sum = vec![0.0; h];
        let mut total = 0.0;
        for y in 0..h {
            let st = (PI * (y as f32 + 0.5) / h as f32).sin();
            let mut acc = 0.0;
            for x in 0..w {
                let i = (y * w + x) * 3;
                let l = (0.2126 * rgb[i] + 0.7152 * rgb[i + 1] + 0.0722 * rgb[i + 2]).max(0.0) * st + 1e-8;
                acc += l;
                self.col_cdf[y * (w + 1) + x + 1] = acc;
            }
            self.row_sum[y] = acc;
            total += acc;
            self.row_cdf[y + 1] = total;
        }
        self.total = total;
    }

    #[inline]
    fn to_local(&self, d: V3) -> V3 {
        if self.rot == 0.0 { return d; }
        let (s, c) = (-self.rot).sin_cos();
        v3(c * d.x + s * d.z, d.y, -s * d.x + c * d.z)
    }

    #[inline]
    fn from_local(&self, d: V3) -> V3 {
        if self.rot == 0.0 { return d; }
        let (s, c) = self.rot.sin_cos();
        v3(c * d.x + s * d.z, d.y, -s * d.x + c * d.z)
    }

    pub fn eval(&self, dir: V3) -> V3 {
        let d = self.to_local(dir);
        if self.w == 0 {
            let t = d.y.clamp(-1.0, 1.0);
            let c = if t >= 0.0 { self.horizon.lerp(self.top, t.sqrt()) } else { self.horizon.lerp(self.bottom, (-t).sqrt()) };
            return c * self.intensity;
        }
        let u = d.z.atan2(d.x) / (2.0 * PI) + 0.5;
        let v = d.y.clamp(-1.0, 1.0).acos() / PI;
        let x = ((u * self.w as f32) as usize).min(self.w - 1);
        let y = ((v * self.h as f32) as usize).min(self.h - 1);
        let i = (y * self.w + x) * 3;
        v3(self.img[i], self.img[i + 1], self.img[i + 2]) * self.intensity
    }

    /// Solid-angle pdf of sampling `dir` via `sample`.
    pub fn pdf(&self, dir: V3) -> f32 {
        if !self.has_image() { return 0.0; }
        let d = self.to_local(dir);
        let u = d.z.atan2(d.x) / (2.0 * PI) + 0.5;
        let v = d.y.clamp(-1.0, 1.0).acos() / PI;
        let x = ((u * self.w as f32) as usize).min(self.w - 1);
        let y = ((v * self.h as f32) as usize).min(self.h - 1);
        let st = (PI * (y as f32 + 0.5) / self.h as f32).sin().max(1e-6);
        let i = (y * self.w + x) * 3;
        let l = (0.2126 * self.img[i] + 0.7152 * self.img[i + 1] + 0.0722 * self.img[i + 2]).max(0.0) * st + 1e-8;
        let p = l / self.total;
        p * (self.w * self.h) as f32 / (2.0 * PI * PI * st)
    }

    /// Returns (direction, radiance, pdf).
    pub fn sample(&self, r1: f32, r2: f32) -> Option<(V3, V3, f32)> {
        if !self.has_image() { return None; }
        let target = r1 * self.total;
        let y = upper(&self.row_cdf, target).min(self.h - 1);
        let row = &self.col_cdf[y * (self.w + 1)..(y + 1) * (self.w + 1)];
        let x = upper(row, r2 * self.row_sum[y]).min(self.w - 1);
        let u = (x as f32 + 0.5) / self.w as f32;
        let v = (y as f32 + 0.5) / self.h as f32;
        let (theta, phi) = (v * PI, (u - 0.5) * 2.0 * PI);
        let (st, ct) = theta.sin_cos();
        let local = v3(st * phi.cos(), ct, st * phi.sin());
        let dir = self.from_local(local);
        let i = (y * self.w + x) * 3;
        let rad = v3(self.img[i], self.img[i + 1], self.img[i + 2]) * self.intensity;
        let pdf = self.pdf(dir);
        if pdf <= 0.0 { return None; }
        Some((dir, rad, pdf))
    }

    /// Exports normalized 1D marginal row CDF (`out_row_cdf[h]`) and 2D conditional column CDF +
    /// solid-angle PDF (`out_col_cdf_pdf[w * h * 2]`, interleaved `[cdf, pdf]`) for WebGPU MIS.
    pub fn export_cdf(&self, out_row_cdf: &mut [f32], out_col_cdf_pdf: &mut [f32]) -> bool {
        if !self.has_image() || out_row_cdf.len() < self.h || out_col_cdf_pdf.len() < self.w * self.h * 2 {
            return false;
        }
        let inv_total = 1.0 / self.total.max(1e-12);
        let wh_over_2pi2 = (self.w * self.h) as f32 / (2.0 * PI * PI);
        for y in 0..self.h {
            out_row_cdf[y] = (self.row_cdf[y + 1] * inv_total).clamp(0.0, 1.0);
            let st = (PI * (y as f32 + 0.5) / self.h as f32).sin().max(1e-6);
            let inv_row = 1.0 / self.row_sum[y].max(1e-12);
            let row_base = y * (self.w + 1);
            for x in 0..self.w {
                let i3 = (y * self.w + x) * 3;
                let lum = (0.2126 * self.img[i3] + 0.7152 * self.img[i3 + 1] + 0.0722 * self.img[i3 + 2]).max(0.0) * st + 1e-8;
                let pdf = (lum * inv_total) * wh_over_2pi2 / st;
                let o2 = (y * self.w + x) * 2;
                out_col_cdf_pdf[o2] = (self.col_cdf[row_base + x + 1] * inv_row).clamp(0.0, 1.0);
                out_col_cdf_pdf[o2 + 1] = pdf;
            }
        }
        if self.h > 0 {
            out_row_cdf[self.h - 1] = 1.0;
        }
        true
    }
}

/// Smallest k >= 1 style index: finds i such that cdf[i] <= t < cdf[i+1].
fn upper(cdf: &[f32], t: f32) -> usize {
    let (mut lo, mut hi) = (0usize, cdf.len() - 1);
    while lo + 1 < hi {
        let mid = (lo + hi) / 2;
        if cdf[mid] <= t { lo = mid; } else { hi = mid; }
    }
    lo
}
