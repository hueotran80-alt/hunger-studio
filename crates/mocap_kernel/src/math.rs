//! Compact 3D vector, quaternion, and 4x4 transform math matching Three.js conventions
//! (`Quat = [x, y, z, w]`, column-major `Mat4` indices `0..15`).

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Vec3 {
    pub x: f32,
    pub y: f32,
    pub z: f32,
}

impl Vec3 {
    pub const ZERO: Vec3 = Vec3 { x: 0.0, y: 0.0, z: 0.0 };
    pub const X: Vec3 = Vec3 { x: 1.0, y: 0.0, z: 0.0 };
    pub const Y: Vec3 = Vec3 { x: 0.0, y: 1.0, z: 0.0 };
    pub const Z: Vec3 = Vec3 { x: 0.0, y: 0.0, z: 1.0 };

    #[inline]
    pub const fn new(x: f32, y: f32, z: f32) -> Self {
        Self { x, y, z }
    }

    #[inline]
    pub fn add(self, o: Self) -> Self {
        Self::new(self.x + o.x, self.y + o.y, self.z + o.z)
    }

    #[inline]
    pub fn sub(self, o: Self) -> Self {
        Self::new(self.x - o.x, self.y - o.y, self.z - o.z)
    }

    #[inline]
    pub fn mul(self, s: f32) -> Self {
        Self::new(self.x * s, self.y * s, self.z * s)
    }

    #[inline]
    pub fn dot(self, o: Self) -> f32 {
        self.x * o.x + self.y * o.y + self.z * o.z
    }

    #[inline]
    pub fn cross(self, o: Self) -> Self {
        Self::new(
            self.y * o.z - self.z * o.y,
            self.z * o.x - self.x * o.z,
            self.x * o.y - self.y * o.x,
        )
    }

    #[inline]
    pub fn len_sq(self) -> f32 {
        self.dot(self)
    }

    #[inline]
    pub fn len(self) -> f32 {
        self.len_sq().sqrt()
    }

    #[inline]
    pub fn normalized(self) -> Self {
        let l = self.len();
        if l > 1e-8 {
            self.mul(1.0 / l)
        } else {
            Self::ZERO
        }
    }

    #[inline]
    pub fn lerp(self, o: Self, t: f32) -> Self {
        Self::new(
            self.x + (o.x - self.x) * t,
            self.y + (o.y - self.y) * t,
            self.z + (o.z - self.z) * t,
        )
    }

    #[inline]
    pub fn project_onto_plane(self, normal: Self) -> Self {
        let n = normal.normalized();
        self.sub(n.mul(self.dot(n)))
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Quat {
    pub x: f32,
    pub y: f32,
    pub z: f32,
    pub w: f32,
}

impl Quat {
    pub const IDENTITY: Quat = Quat {
        x: 0.0,
        y: 0.0,
        z: 0.0,
        w: 1.0,
    };

    #[inline]
    pub const fn new(x: f32, y: f32, z: f32, w: f32) -> Self {
        Self { x, y, z, w }
    }

    #[inline]
    pub fn normalized(self) -> Self {
        let l = (self.x * self.x + self.y * self.y + self.z * self.z + self.w * self.w).sqrt();
        if l > 1e-8 {
            let inv = 1.0 / l;
            Self::new(self.x * inv, self.y * inv, self.z * inv, self.w * inv)
        } else {
            Self::IDENTITY
        }
    }

    #[inline]
    pub fn conj(self) -> Self {
        Self::new(-self.x, -self.y, -self.z, self.w)
    }

    #[inline]
    pub fn mul(self, b: Self) -> Self {
        Self::new(
            self.w * b.x + self.x * b.w + self.y * b.z - self.z * b.y,
            self.w * b.y - self.x * b.z + self.y * b.w + self.z * b.x,
            self.w * b.z + self.x * b.y - self.y * b.x + self.z * b.w,
            self.w * b.w - self.x * b.x - self.y * b.y - self.z * b.z,
        )
    }

    #[inline]
    pub fn dot(self, b: Self) -> f32 {
        self.x * b.x + self.y * b.y + self.z * b.z + self.w * b.w
    }

    #[inline]
    pub fn rotate_vec3(self, v: Vec3) -> Vec3 {
        let u = Vec3::new(self.x, self.y, self.z);
        let s = self.w;
        u.mul(2.0 * u.dot(v))
            .add(v.mul(s * s - u.dot(u)))
            .add(u.cross(v).mul(2.0 * s))
    }

    #[inline]
    pub fn from_axis_angle(axis: Vec3, angle_rad: f32) -> Self {
        let n = axis.normalized();
        if n.len_sq() < 1e-12 {
            return Self::IDENTITY;
        }
        let half = 0.5 * angle_rad;
        let s = half.sin();
        Self::new(n.x * s, n.y * s, n.z * s, half.cos()).normalized()
    }

    #[inline]
    pub fn from_unit_vectors(from: Vec3, to: Vec3) -> Self {
        let a = from.normalized();
        let b = to.normalized();
        if a.len_sq() < 1e-12 || b.len_sq() < 1e-12 {
            return Self::IDENTITY;
        }
        let r = a.dot(b) + 1.0;
        if r < 1e-6 {
            let ortho = if a.x.abs() > a.z.abs() {
                Vec3::new(-a.y, a.x, 0.0)
            } else {
                Vec3::new(0.0, -a.z, a.y)
            };
            let n = ortho.normalized();
            Self::new(n.x, n.y, n.z, 0.0)
        } else {
            let c = a.cross(b);
            Self::new(c.x, c.y, c.z, r).normalized()
        }
    }

    /// Shortest-path spherical linear interpolation.
    pub fn slerp(self, mut b: Self, t: f32) -> Self {
        let t = t.clamp(0.0, 1.0);
        if t <= 0.0 {
            return self.normalized();
        }
        if t >= 1.0 {
            return b.normalized();
        }
        let mut dot = self.dot(b);
        if dot < 0.0 {
            dot = -dot;
            b = Self::new(-b.x, -b.y, -b.z, -b.w);
        }
        if dot > 0.9995 {
            return Self::new(
                self.x + (b.x - self.x) * t,
                self.y + (b.y - self.y) * t,
                self.z + (b.z - self.z) * t,
                self.w + (b.w - self.w) * t,
            )
            .normalized();
        }
        let theta_0 = dot.clamp(-1.0, 1.0).acos();
        let sin_theta_0 = theta_0.sin();
        if sin_theta_0.abs() < 1e-6 {
            return self.normalized();
        }
        let theta = theta_0 * t;
        let sin_theta = theta.sin();
        let s0 = (theta_0 - theta).sin() / sin_theta_0;
        let s1 = sin_theta / sin_theta_0;
        Self::new(
            self.x * s0 + b.x * s1,
            self.y * s0 + b.y * s1,
            self.z * s0 + b.z * s1,
            self.w * s0 + b.w * s1,
        )
        .normalized()
    }

    /// Clamp angle from identity smoothly to `max_angle_rad`.
    pub fn clamp_angle(self, max_angle_rad: f32) -> Self {
        let q = self.normalized();
        let w_clamped = q.w.abs().clamp(0.0, 1.0);
        let angle = 2.0 * w_clamped.acos();
        if angle <= max_angle_rad || angle < 1e-6 {
            return q;
        }
        let s = (1.0 - w_clamped * w_clamped).max(0.0).sqrt();
        if s < 1e-6 {
            return Self::IDENTITY;
        }
        let sign = if q.w >= 0.0 { 1.0 } else { -1.0 };
        let axis = Vec3::new(q.x * sign / s, q.y * sign / s, q.z * sign / s);
        Self::from_axis_angle(axis, max_angle_rad)
    }

    /// Decompose `self` into `swing * twist` around unit `axis` (`self = swing * twist`).
    pub fn swing_twist(self, axis: Vec3) -> (Self, Self) {
        let n = axis.normalized();
        let r = Vec3::new(self.x, self.y, self.z);
        let proj = n.mul(r.dot(n));
        let twist_raw = Self::new(proj.x, proj.y, proj.z, self.w);
        let len_sq = twist_raw.x * twist_raw.x
            + twist_raw.y * twist_raw.y
            + twist_raw.z * twist_raw.z
            + twist_raw.w * twist_raw.w;
        let twist = if len_sq > 1e-10 {
            let inv = 1.0 / len_sq.sqrt();
            Self::new(
                twist_raw.x * inv,
                twist_raw.y * inv,
                twist_raw.z * inv,
                twist_raw.w * inv,
            )
        } else {
            Self::IDENTITY
        };
        let swing = self.mul(twist.conj()).normalized();
        (swing, twist)
    }

    /// Three.js `makeBasis(x_axis, y_axis, z_axis)` -> Quaternion.
    pub fn from_basis(x_axis: Vec3, y_axis: Vec3, z_axis: Vec3) -> Self {
        let m00 = x_axis.x;
        let m10 = x_axis.y;
        let m20 = x_axis.z;
        let m01 = y_axis.x;
        let m11 = y_axis.y;
        let m21 = y_axis.z;
        let m02 = z_axis.x;
        let m12 = z_axis.y;
        let m22 = z_axis.z;
        let trace = m00 + m11 + m22;
        if trace > 0.0 {
            let s = 0.5 / (trace + 1.0).sqrt();
            Self::new((m21 - m12) * s, (m02 - m20) * s, (m10 - m01) * s, 0.25 / s).normalized()
        } else if m00 > m11 && m00 > m22 {
            let s = 2.0 * (1.0 + m00 - m11 - m22).sqrt();
            Self::new(0.25 * s, (m01 + m10) / s, (m02 + m20) / s, (m21 - m12) / s).normalized()
        } else if m11 > m22 {
            let s = 2.0 * (1.0 + m11 - m00 - m22).sqrt();
            Self::new((m01 + m10) / s, 0.25 * s, (m12 + m21) / s, (m02 - m20) / s).normalized()
        } else {
            let s = 2.0 * (1.0 + m22 - m00 - m11).sqrt();
            Self::new((m02 + m20) / s, (m12 + m21) / s, 0.25 * s, (m10 - m01) / s).normalized()
        }
    }
}

/// Pole-vector swing-twist rotation:
/// Rotates `rest_dir -> target_dir`, then rotates around `target_dir` so `rest_pole` aligns toward `target_pole`.
pub fn solve_aim_with_pole(
    rest_dir: Vec3,
    target_dir: Vec3,
    rest_pole: Vec3,
    target_pole: Vec3,
    pole_weight: f32,
) -> Quat {
    let dir_a = rest_dir.normalized();
    let dir_b = target_dir.normalized();
    if dir_a.len_sq() < 1e-10 || dir_b.len_sq() < 1e-10 {
        return Quat::IDENTITY;
    }
    let q_aim = Quat::from_unit_vectors(dir_a, dir_b);
    let pw = pole_weight.clamp(0.0, 1.0);
    if pw < 1e-4 {
        return q_aim;
    }
    let rotated_pole = q_aim.rotate_vec3(rest_pole).project_onto_plane(dir_b);
    let desired_pole = target_pole.project_onto_plane(dir_b);
    let len_rp = rotated_pole.len();
    let len_dp = desired_pole.len();
    if len_rp < 1e-4 || len_dp < 1e-4 {
        return q_aim;
    }
    let rp = rotated_pole.mul(1.0 / len_rp);
    let dp = desired_pole.mul(1.0 / len_dp);
    let cos_t = rp.dot(dp).clamp(-1.0, 1.0);
    let sin_t = rp.cross(dp).dot(dir_b);
    let twist_angle = sin_t.atan2(cos_t) * pw;
    let q_twist = Quat::from_axis_angle(dir_b, twist_angle);
    q_twist.mul(q_aim).normalized()
}

/// Column-major 4x4 matrix transform of point `v` (`w = 1`).
#[inline]
pub fn mat4_transform_point(m: &[f32; 16], v: Vec3) -> Vec3 {
    let w = m[3] * v.x + m[7] * v.y + m[11] * v.z + m[15];
    let inv_w = if w.abs() > 1e-8 { 1.0 / w } else { 1.0 };
    Vec3::new(
        (m[0] * v.x + m[4] * v.y + m[8] * v.z + m[12]) * inv_w,
        (m[1] * v.x + m[5] * v.y + m[9] * v.z + m[13]) * inv_w,
        (m[2] * v.x + m[6] * v.y + m[10] * v.z + m[14]) * inv_w,
    )
}

#[inline]
pub fn mat4_compose(pos: Vec3, q: Quat, scale: Vec3) -> [f32; 16] {
    let x = q.x;
    let y = q.y;
    let z = q.z;
    let w = q.w;
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

    [
        (1.0 - (yy + zz)) * scale.x,
        (xy + wz) * scale.x,
        (xz - wy) * scale.x,
        0.0,
        (xy - wz) * scale.y,
        (1.0 - (xx + zz)) * scale.y,
        (yz + wx) * scale.y,
        0.0,
        (xz + wy) * scale.z,
        (yz - wx) * scale.z,
        (1.0 - (xx + yy)) * scale.z,
        0.0,
        pos.x,
        pos.y,
        pos.z,
        1.0,
    ]
}

#[inline]
pub fn mat4_mul(a: &[f32; 16], b: &[f32; 16]) -> [f32; 16] {
    let mut out = [0.0f32; 16];
    for c in 0..4 {
        let b0 = b[c * 4];
        let b1 = b[c * 4 + 1];
        let b2 = b[c * 4 + 2];
        let b3 = b[c * 4 + 3];
        out[c * 4] = a[0] * b0 + a[4] * b1 + a[8] * b2 + a[12] * b3;
        out[c * 4 + 1] = a[1] * b0 + a[5] * b1 + a[9] * b2 + a[13] * b3;
        out[c * 4 + 2] = a[2] * b0 + a[6] * b1 + a[10] * b2 + a[14] * b3;
        out[c * 4 + 3] = a[3] * b0 + a[7] * b1 + a[11] * b2 + a[15] * b3;
    }
    out
}

pub fn median_f32(vals: &mut [f32]) -> f32 {
    if vals.is_empty() {
        return 0.0;
    }
    vals.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let m = vals.len() / 2;
    if vals.len() % 2 == 1 {
        vals[m]
    } else {
        0.5 * (vals[m - 1] + vals[m])
    }
}
