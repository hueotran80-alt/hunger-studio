//! Binned-SAH BVH2 (with O(N) refit) collapsed to 4-wide SIMD BVH4 + Möller–Trumbore.
use crate::math::*;

/// Hot geometry data used during intersection (36 bytes).
#[derive(Clone, Copy)]
pub struct TriGeom {
    pub p0: V3,
    pub e1: V3,
    pub e2: V3,
}

/// Cold per-triangle shading attributes read only on hit.
#[derive(Clone, Copy)]
pub struct TriAttr {
    pub n0: V3,
    pub n1: V3,
    pub n2: V3,
    pub uv0: [f32; 2],
    pub uv1: [f32; 2],
    pub uv2: [f32; 2],
    pub tangent: V3,
    pub b_sign: f32,
    pub mat: u32,
    pub area: f32,
}

/// Compact 32-byte binary BVH node.
#[repr(C)]
#[derive(Clone, Copy)]
pub struct Node {
    pub min: [f32; 3],
    /// Leaf: first triangle index. Interior: right child index (left = self + 1).
    pub a: u32,
    pub max: [f32; 3],
    /// Bits 0..30: triangle count (>0 = leaf, 0 = interior). Bits 30..32: split axis.
    pub meta: u32,
}

impl Node {
    #[inline(always)]
    pub fn leaf(min: V3, max: V3, a: u32, n: u32) -> Self {
        Node { min: [min.x, min.y, min.z], a, max: [max.x, max.y, max.z], meta: n & 0x3FFF_FFFF }
    }
    #[inline(always)]
    pub fn count(&self) -> u32 {
        self.meta & 0x3FFF_FFFF
    }
    #[inline(always)]
    pub fn axis(&self) -> u32 {
        (self.meta >> 30) & 3
    }
    #[inline(always)]
    pub fn min_v(&self) -> V3 {
        v3(self.min[0], self.min[1], self.min[2])
    }
    #[inline(always)]
    pub fn max_v(&self) -> V3 {
        v3(self.max[0], self.max[1], self.max[2])
    }
    #[inline(always)]
    pub fn set_bounds(&mut self, min: V3, max: V3) {
        self.min = [min.x, min.y, min.z];
        self.max = [max.x, max.y, max.z];
    }
}

/// 4-wide SIMD BVH node (16-byte aligned).
#[repr(C, align(16))]
#[derive(Clone, Copy)]
pub struct Node4 {
    pub min_x: [f32; 4],
    pub min_y: [f32; 4],
    pub min_z: [f32; 4],
    pub max_x: [f32; 4],
    pub max_y: [f32; 4],
    pub max_z: [f32; 4],
    /// Leaf: first tri index. Interior: Node4 index. Empty: u32::MAX.
    pub child: [u32; 4],
    /// Leaf: tri count (>0). Interior or empty: 0.
    pub count: [u32; 4],
}

pub struct Hit {
    pub t: f32,
    pub u: f32,
    pub v: f32,
    pub tri: u32,
}

pub struct Bvh {
    pub nodes: Vec<Node>,
    pub nodes4: Vec<Node4>,
    pub tris: Vec<TriGeom>,
    pub attrs: Vec<TriAttr>,
    /// Maps reordered BVH triangle index -> original triangle index from load.
    pub orig_idx: Vec<u32>,
}

#[derive(Clone, Copy)]
struct Aabb {
    min: V3,
    max: V3,
}

impl Aabb {
    fn empty() -> Aabb {
        Aabb { min: V3::splat(f32::INFINITY), max: V3::splat(f32::NEG_INFINITY) }
    }
    fn grow(&mut self, p: V3) {
        self.min = self.min.min(p);
        self.max = self.max.max(p);
    }
    fn merge(&mut self, o: &Aabb) {
        self.min = self.min.min(o.min);
        self.max = self.max.max(o.max);
    }
    fn area(&self) -> f32 {
        let d = self.max - self.min;
        if d.x < 0.0 { return 0.0; }
        2.0 * (d.x * d.y + d.y * d.z + d.z * d.x)
    }
}

const BINS: usize = 16;
const MAX_LEAF: usize = 4;

impl Bvh {
    pub fn build(tris: Vec<TriGeom>, attrs: Vec<TriAttr>) -> Bvh {
        let n = tris.len();
        let mut bounds = Vec::with_capacity(n);
        let mut cents = Vec::with_capacity(n);
        for t in &tris {
            let mut b = Aabb::empty();
            b.grow(t.p0);
            b.grow(t.p0 + t.e1);
            b.grow(t.p0 + t.e2);
            cents.push((b.min + b.max) * 0.5);
            bounds.push(b);
        }
        let mut idx: Vec<u32> = (0..n as u32).collect();
        let mut nodes: Vec<Node> = Vec::with_capacity(2 * n.max(1));
        if n > 0 {
            build_rec(&mut nodes, &mut idx, 0, n, &bounds, &cents);
        }
        let re_tris: Vec<TriGeom> = idx.iter().map(|&i| tris[i as usize]).collect();
        let re_attrs: Vec<TriAttr> = idx.iter().map(|&i| attrs[i as usize]).collect();
        let nodes4 = collapse_to_bvh4(&nodes);
        Bvh { nodes, nodes4, tris: re_tris, attrs: re_attrs, orig_idx: idx }
    }

    pub fn bounds(&self) -> (V3, V3) {
        match self.nodes.first() {
            Some(n) => (n.min_v(), n.max_v()),
            None => (V3::ZERO, V3::ZERO),
        }
    }

    /// Updates triangle positions/normals in-place and refits BVH bounds bottom-up in O(N).
    pub fn refit(&mut self, pos: &[f32], nrm: &[f32]) {
        let ntri = self.tris.len();
        if pos.len() < ntri * 9 { return; }
        let has_n = nrm.len() >= ntri * 9;
        for (i, &orig) in self.orig_idx.iter().enumerate() {
            let b = orig as usize * 9;
            let p0 = v3(pos[b], pos[b + 1], pos[b + 2]);
            let p1 = v3(pos[b + 3], pos[b + 4], pos[b + 5]);
            let p2 = v3(pos[b + 6], pos[b + 7], pos[b + 8]);
            let e1 = p1 - p0;
            let e2 = p2 - p0;
            let ng = e1.cross(e2);
            let area = 0.5 * ng.len();
            self.tris[i] = TriGeom { p0, e1, e2 };
            self.attrs[i].area = area;
            let ng_n = if area > 1e-12 { ng / (2.0 * area) } else { v3(0.0, 1.0, 0.0) };
            let (tan, b_sign) = crate::compute_tangent(e1, e2, self.attrs[i].uv0, self.attrs[i].uv1, self.attrs[i].uv2, ng_n);
            self.attrs[i].tangent = tan;
            self.attrs[i].b_sign = b_sign;
            if has_n {
                self.attrs[i].n0 = v3(nrm[b], nrm[b + 1], nrm[b + 2]);
                self.attrs[i].n1 = v3(nrm[b + 3], nrm[b + 4], nrm[b + 5]);
                self.attrs[i].n2 = v3(nrm[b + 6], nrm[b + 7], nrm[b + 8]);
            }
        }
        // Pre-order guarantees children always have index > parent.
        for idx in (0..self.nodes.len()).rev() {
            let count = self.nodes[idx].count();
            if count > 0 {
                let first = self.nodes[idx].a as usize;
                let mut b = Aabb::empty();
                for t in &self.tris[first..first + count as usize] {
                    b.grow(t.p0);
                    b.grow(t.p0 + t.e1);
                    b.grow(t.p0 + t.e2);
                }
                self.nodes[idx].set_bounds(b.min, b.max);
            } else {
                let l = &self.nodes[idx + 1];
                let r = &self.nodes[self.nodes[idx].a as usize];
                let min = l.min_v().min(r.min_v());
                let max = l.max_v().max(r.max_v());
                self.nodes[idx].set_bounds(min, max);
            }
        }
        self.nodes4 = collapse_to_bvh4(&self.nodes);
    }

    pub fn intersect(&self, o: V3, d: V3, tmax: f32) -> Option<Hit> {
        if self.nodes4.is_empty() { return None; }
        let inv = v3(1.0 / d.x, 1.0 / d.y, 1.0 / d.z);
        let mut best: Option<Hit> = None;
        let mut tm = tmax;
        let mut stack = [(0u32, 0.0f32); 128];
        let mut sp = 1usize;
        while sp > 0 {
            sp -= 1;
            let (ni, node_t0) = stack[sp];
            if node_t0 > tm { continue; }
            let n4 = &self.nodes4[ni as usize];
            let (mask, t0s) = slab4(n4, o, inv, tm);
            if mask == 0 { continue; }

            // Process leaves immediately to tighten `tm` before pushing interior children.
            let mut int_buf = [(0u32, 0.0f32); 4];
            let mut int_n = 0usize;
            for k in 0..4 {
                if (mask & (1 << k)) == 0 { continue; }
                let cnt = n4.count[k];
                let ch = n4.child[k];
                if ch == u32::MAX { continue; }
                if cnt > 0 {
                    for i in ch..ch + cnt {
                        if let Some((t, u, v)) = tri_hit(&self.tris[i as usize], o, d, tm) {
                            tm = t;
                            best = Some(Hit { t, u, v, tri: i });
                        }
                    }
                } else {
                    int_buf[int_n] = (ch, t0s[k]);
                    int_n += 1;
                }
            }
            // Sort interior children descending by t0 so nearest is popped first.
            if int_n > 1 {
                for i in 1..int_n {
                    let key = int_buf[i];
                    let mut j = i;
                    while j > 0 && int_buf[j - 1].1 < key.1 {
                        int_buf[j] = int_buf[j - 1];
                        j -= 1;
                    }
                    int_buf[j] = key;
                }
            }
            for item in &int_buf[..int_n] {
                if item.1 <= tm && sp < 128 {
                    stack[sp] = *item;
                    sp += 1;
                }
            }
        }
        best
    }

    pub fn occluded(&self, o: V3, d: V3, tmax: f32) -> bool {
        if self.nodes4.is_empty() { return false; }
        let inv = v3(1.0 / d.x, 1.0 / d.y, 1.0 / d.z);
        let mut stack = [0u32; 128];
        let mut sp = 1usize;
        while sp > 0 {
            sp -= 1;
            let n4 = &self.nodes4[stack[sp] as usize];
            let (mask, _) = slab4(n4, o, inv, tmax);
            if mask == 0 { continue; }
            for k in 0..4 {
                if (mask & (1 << k)) == 0 { continue; }
                let cnt = n4.count[k];
                let ch = n4.child[k];
                if ch == u32::MAX { continue; }
                if cnt > 0 {
                    for i in ch..ch + cnt {
                        if tri_hit(&self.tris[i as usize], o, d, tmax).is_some() {
                            return true;
                        }
                    }
                } else if sp < 128 {
                    stack[sp] = ch;
                    sp += 1;
                }
            }
        }
        false
    }
}

#[cfg(all(target_arch = "wasm32", target_feature = "simd128"))]
#[inline(always)]
fn slab4(n: &Node4, o: V3, inv: V3, tmax: f32) -> (u32, [f32; 4]) {
    use core::arch::wasm32::*;
    unsafe {
        let ox = f32x4_splat(o.x);
        let oy = f32x4_splat(o.y);
        let oz = f32x4_splat(o.z);
        let ix = f32x4_splat(inv.x);
        let iy = f32x4_splat(inv.y);
        let iz = f32x4_splat(inv.z);

        let x0 = f32x4_mul(f32x4_sub(v128_load(n.min_x.as_ptr() as *const v128), ox), ix);
        let x1 = f32x4_mul(f32x4_sub(v128_load(n.max_x.as_ptr() as *const v128), ox), ix);
        let y0 = f32x4_mul(f32x4_sub(v128_load(n.min_y.as_ptr() as *const v128), oy), iy);
        let y1 = f32x4_mul(f32x4_sub(v128_load(n.max_y.as_ptr() as *const v128), oy), iy);
        let z0 = f32x4_mul(f32x4_sub(v128_load(n.min_z.as_ptr() as *const v128), oz), iz);
        let z1 = f32x4_mul(f32x4_sub(v128_load(n.max_z.as_ptr() as *const v128), oz), iz);

        let tmin = f32x4_max(
            f32x4_max(f32x4_min(x0, x1), f32x4_min(y0, y1)),
            f32x4_max(f32x4_min(z0, z1), f32x4_splat(0.0)),
        );
        let t_max = f32x4_min(
            f32x4_min(f32x4_max(x0, x1), f32x4_max(y0, y1)),
            f32x4_min(f32x4_max(z0, z1), f32x4_splat(tmax)),
        );
        let cmp = f32x4_le(tmin, f32x4_mul(t_max, f32x4_splat(1.0000004)));
        let mask = i32x4_bitmask(cmp) as u32;
        let mut t0s = [0.0f32; 4];
        v128_store(t0s.as_mut_ptr() as *mut v128, tmin);
        (mask, t0s)
    }
}

#[cfg(not(all(target_arch = "wasm32", target_feature = "simd128")))]
#[inline(always)]
fn slab4(n: &Node4, o: V3, inv: V3, tmax: f32) -> (u32, [f32; 4]) {
    let mut mask = 0u32;
    let mut t0s = [0.0f32; 4];
    for k in 0..4 {
        let tx1 = (n.min_x[k] - o.x) * inv.x;
        let tx2 = (n.max_x[k] - o.x) * inv.x;
        let ty1 = (n.min_y[k] - o.y) * inv.y;
        let ty2 = (n.max_y[k] - o.y) * inv.y;
        let tz1 = (n.min_z[k] - o.z) * inv.z;
        let tz2 = (n.max_z[k] - o.z) * inv.z;
        let t0 = tx1.min(tx2).max(ty1.min(ty2)).max(tz1.min(tz2)).max(0.0);
        let t1 = tx1.max(tx2).min(ty1.max(ty2)).min(tz1.max(tz2)).min(tmax);
        t0s[k] = t0;
        if t0 <= t1 * 1.0000004 {
            mask |= 1 << k;
        }
    }
    (mask, t0s)
}

#[inline(always)]
fn tri_hit(t: &TriGeom, o: V3, d: V3, tmax: f32) -> Option<(f32, f32, f32)> {
    let p = d.cross(t.e2);
    let det = t.e1.dot(p);
    if det.abs() < 1e-14 { return None; }
    let inv = 1.0 / det;
    let s = o - t.p0;
    let u = s.dot(p) * inv;
    if !(0.0..=1.0).contains(&u) { return None; }
    let q = s.cross(t.e1);
    let v = d.dot(q) * inv;
    if v < 0.0 || u + v > 1.0 { return None; }
    let dist = t.e2.dot(q) * inv;
    if dist > 1e-7 && dist < tmax { Some((dist, u, v)) } else { None }
}

fn collapse_to_bvh4(nodes2: &[Node]) -> Vec<Node4> {
    if nodes2.is_empty() { return Vec::new(); }
    let mut out = Vec::with_capacity(nodes2.len() / 2 + 1);
    if nodes2[0].count() > 0 {
        let mut n4 = empty_node4();
        let r = &nodes2[0];
        n4.min_x[0] = r.min[0]; n4.min_y[0] = r.min[1]; n4.min_z[0] = r.min[2];
        n4.max_x[0] = r.max[0]; n4.max_y[0] = r.max[1]; n4.max_z[0] = r.max[2];
        n4.child[0] = r.a;
        n4.count[0] = r.count();
        out.push(n4);
        return out;
    }
    collapse_rec(nodes2, 0, &mut out);
    out
}

fn empty_node4() -> Node4 {
    Node4 {
        min_x: [f32::INFINITY; 4],
        min_y: [f32::INFINITY; 4],
        min_z: [f32::INFINITY; 4],
        max_x: [f32::NEG_INFINITY; 4],
        max_y: [f32::NEG_INFINITY; 4],
        max_z: [f32::NEG_INFINITY; 4],
        child: [u32::MAX; 4],
        count: [0; 4],
    }
}

fn node_area(n: &Node) -> f32 {
    let d = n.max_v() - n.min_v();
    if d.x < 0.0 { return 0.0; }
    2.0 * (d.x * d.y + d.y * d.z + d.z * d.x)
}

fn collapse_rec(nodes2: &[Node], root2: usize, out: &mut Vec<Node4>) -> u32 {
    let me = out.len();
    out.push(empty_node4());

    let mut slots = [0usize; 4];
    let mut len = 2usize;
    slots[0] = root2 + 1;
    slots[1] = nodes2[root2].a as usize;

    while len < 4 {
        // Expand the interior child with largest surface area.
        let mut best_i = None;
        let mut best_area = -1.0f32;
        for (i, &idx2) in slots[..len].iter().enumerate() {
            if nodes2[idx2].count() == 0 {
                let a = node_area(&nodes2[idx2]);
                if a > best_area {
                    best_area = a;
                    best_i = Some(i);
                }
            }
        }
        let Some(i) = best_i else { break; };
        let exp = slots[i];
        slots[i] = exp + 1;
        slots[len] = nodes2[exp].a as usize;
        len += 1;
    }

    for (k, &idx2) in slots[..len].iter().enumerate() {
        let n2 = &nodes2[idx2];
        out[me].min_x[k] = n2.min[0];
        out[me].min_y[k] = n2.min[1];
        out[me].min_z[k] = n2.min[2];
        out[me].max_x[k] = n2.max[0];
        out[me].max_y[k] = n2.max[1];
        out[me].max_z[k] = n2.max[2];
        let cnt = n2.count();
        if cnt > 0 {
            out[me].child[k] = n2.a;
            out[me].count[k] = cnt;
        } else {
            let child4 = collapse_rec(nodes2, idx2, out);
            out[me].child[k] = child4;
            out[me].count[k] = 0;
        }
    }
    me as u32
}

fn build_rec(nodes: &mut Vec<Node>, idx: &mut [u32], lo: usize, hi: usize, bounds: &[Aabb], cents: &[V3]) -> usize {
    let me = nodes.len();
    let mut bb = Aabb::empty();
    let mut cb = Aabb::empty();
    for &i in &idx[lo..hi] {
        bb.merge(&bounds[i as usize]);
        cb.grow(cents[i as usize]);
    }
    nodes.push(Node::leaf(bb.min, bb.max, lo as u32, (hi - lo) as u32));
    let count = hi - lo;
    if count <= MAX_LEAF { return me; }
    let ext = cb.max - cb.min;
    let axis = if ext.x >= ext.y && ext.x >= ext.z { 0 } else if ext.y >= ext.z { 1 } else { 2 };
    let lo_c = cb.min.get(axis);
    let span = ext.get(axis);
    if span < 1e-12 { return me; }

    let mut cnt = [0usize; BINS];
    let mut bin_b = [Aabb::empty(); BINS];
    let to_bin = |c: V3| (((c.get(axis) - lo_c) / span * BINS as f32) as usize).min(BINS - 1);
    for &i in &idx[lo..hi] {
        let b = to_bin(cents[i as usize]);
        cnt[b] += 1;
        bin_b[b].merge(&bounds[i as usize]);
    }
    let mut right_area = [0.0f32; BINS];
    let mut acc = Aabb::empty();
    for i in (1..BINS).rev() {
        acc.merge(&bin_b[i]);
        right_area[i] = acc.area();
    }
    let mut acc = Aabb::empty();
    let mut left_n = 0usize;
    let mut best = (f32::INFINITY, 0usize);
    for i in 0..BINS - 1 {
        acc.merge(&bin_b[i]);
        left_n += cnt[i];
        let right_n = count - left_n;
        if left_n == 0 || right_n == 0 { continue; }
        let cost = acc.area() * left_n as f32 + right_area[i + 1] * right_n as f32;
        if cost < best.0 { best = (cost, i); }
    }
    let leaf_cost = bb.area() * count as f32;
    let split_cost = 0.125 * bb.area() * count as f32 + best.0;
    if best.0.is_infinite() || (count <= 8 && split_cost >= leaf_cost * 1.0) { return me; }

    let mut i = lo;
    let mut j = hi;
    while i < j {
        if to_bin(cents[idx[i] as usize]) <= best.1 { i += 1; } else { j -= 1; idx.swap(i, j); }
    }
    let mid = if i == lo || i == hi { (lo + hi) / 2 } else { i };
    build_rec(nodes, idx, lo, mid, bounds, cents);
    let right = build_rec(nodes, idx, mid, hi, bounds, cents);
    nodes[me].a = right as u32;
    nodes[me].meta = (axis as u32) << 30;
    me
}
