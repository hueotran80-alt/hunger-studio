/**
 * @file fcurve-math.js
 * @description Blender-grade 1D F-Curve cubic Bezier solver, handle solver
 * (auto_clamped / aligned / free / vector), monotonicity clamping, and
 * curve extrapolation (constant / linear / cycle / cycle_offset).
 */

export const HANDLE_TYPES = Object.freeze(['auto_clamped', 'aligned', 'free', 'vector']);
export const EXTRAPOLATION_MODES = Object.freeze(['constant', 'linear', 'cycle', 'cycle_offset']);

const TWO_PI = Math.PI * 2;

export function normalizeHandleType(type) {
  const t = String(type || 'auto_clamped').toLowerCase();
  return HANDLE_TYPES.includes(t) ? t : 'auto_clamped';
}

export function normalizeExtrapolation(mode) {
  const m = String(mode || 'constant').toLowerCase();
  return EXTRAPOLATION_MODES.includes(m) ? m : 'constant';
}

export function cloneHandlePair(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const hl = Array.isArray(raw.hl) && raw.hl.length >= 2
    ? [Number(raw.hl[0]) || 0, Number(raw.hl[1]) || 0]
    : null;
  const hr = Array.isArray(raw.hr) && raw.hr.length >= 2
    ? [Number(raw.hr[0]) || 0, Number(raw.hr[1]) || 0]
    : null;
  return {
    hl,
    hr,
    type: normalizeHandleType(raw.type || raw.handleType),
  };
}

/**
 * Blender's correct_bezpart: ensures cubic Bezier segment x(u) has non-negative
 * derivative across u in [0, 1] so y(x) is guaranteed single-valued.
 */
export function enforceBezierMonotonicity(x0, y0, hx1, hy1, hx2, hy2, x3, y3) {
  if (hx1 < x0) hx1 = x0;
  if (hx2 > x3) hx2 = x3;

  const dx1 = hx1 - x0;
  const dy1 = hy1 - y0;
  const dx2 = x3 - hx2;
  const dy2 = y3 - hy2;
  const segLen = x3 - x0;
  const sumDx = dx1 + dx2;

  if (segLen > 1e-9 && sumDx > segLen) {
    const scale = segLen / sumDx;
    hx1 = x0 + dx1 * scale;
    hy1 = y0 + dy1 * scale;
    hx2 = x3 - dx2 * scale;
    hy2 = y3 - dy2 * scale;
  }

  return [x0, y0, hx1, hy1, hx2, hy2, x3, y3];
}

/**
 * Evaluates 1D F-Curve cubic Bezier y at horizontal target frame xTarget in [x0, x3]
 * using safeguarded Newton-Raphson + bisection root finding for x(u) = xTarget.
 */
export function solveCubicBezierTimeY(x0, y0, hx1, hy1, hx2, hy2, x3, y3, xTarget) {
  const segLen = x3 - x0;
  if (segLen <= 1e-9) return y0;
  if (xTarget <= x0) return y0;
  if (xTarget >= x3) return y3;

  const [px0, py0, cx1, cy1, cx2, cy2, px3, py3] =
    enforceBezierMonotonicity(x0, y0, hx1, hy1, hx2, hy2, x3, y3);

  // Polynomial coefficients for x(u) - xTarget = ax*u^3 + bx*u^2 + cx*u + dx0
  const ax = -px0 + 3 * cx1 - 3 * cx2 + px3;
  const bx = 3 * px0 - 6 * cx1 + 3 * cx2;
  const cx = -3 * px0 + 3 * cx1;
  const dx0 = px0 - xTarget;

  let lo = 0;
  let hi = 1;
  let u = Math.max(0, Math.min(1, (xTarget - px0) / segLen));

  for (let iter = 0; iter < 16; iter++) {
    const fx = ((ax * u + bx) * u + cx) * u + dx0;
    if (Math.abs(fx) < 1e-8) break;

    if (fx < 0) lo = u;
    else hi = u;

    const df = (3 * ax * u + 2 * bx) * u + cx;
    let nextU = Math.abs(df) > 1e-9 ? u - fx / df : 0.5 * (lo + hi);

    if (!Number.isFinite(nextU) || nextU <= lo || nextU >= hi) {
      nextU = 0.5 * (lo + hi);
    }
    if (Math.abs(nextU - u) < 1e-9) {
      u = nextU;
      break;
    }
    u = nextU;
  }

  // Exact cubic Bezier y(u)
  const ay = -py0 + 3 * cy1 - 3 * cy2 + py3;
  const by = 3 * py0 - 6 * cy1 + 3 * cy2;
  const cy = -3 * py0 + 3 * cy1;
  return ((ay * u + by) * u + cy) * u + py0;
}

/**
 * Enforces aligned or free handle constraints when one handle of a keyframe is dragged.
 * Returns normalized { hl: [df, dv], hr: [df, dv], type }.
 */
export function updateHandlePair(existing, editedSide, df, dv, requestedType = null) {
  const cur = cloneHandlePair(existing) || { hl: [-1, 0], hr: [1, 0], type: 'auto_clamped' };
  let type = requestedType ? normalizeHandleType(requestedType) : cur.type;
  if (!requestedType && (type === 'auto_clamped' || type === 'vector')) {
    // Manual handle drag automatically switches auto_clamped/vector -> aligned (Blender behavior)
    type = 'aligned';
  }

  let hl = cur.hl ? [...cur.hl] : [-1, 0];
  let hr = cur.hr ? [...cur.hr] : [1, 0];

  if (editedSide === 'left') {
    hl = [Math.min(0, df), dv];
    if (type === 'aligned') {
      const lenL = Math.hypot(hl[0], hl[1]);
      const lenR = Math.max(1e-4, Math.hypot(hr[0], hr[1]));
      if (lenL > 1e-6) {
        hr = [(-hl[0] / lenL) * lenR, (-hl[1] / lenL) * lenR];
        hr[0] = Math.max(0, hr[0]);
      }
    }
  } else if (editedSide === 'right') {
    hr = [Math.max(0, df), dv];
    if (type === 'aligned') {
      const lenR = Math.hypot(hr[0], hr[1]);
      const lenL = Math.max(1e-4, Math.hypot(hl[0], hl[1]));
      if (lenR > 1e-6) {
        hl = [(-hr[0] / lenR) * lenL, (-hr[1] / lenR) * lenL];
        hl[0] = Math.min(0, hl[0]);
      }
    }
  }

  return { hl, hr, type };
}

function unwrapAngleValues(points) {
  const n = points.length;
  const vals = new Array(n);
  if (n === 0) return vals;
  vals[0] = points[0].val;
  for (let i = 1; i < n; i++) {
    let diff = (points[i].val - vals[i - 1]) % TWO_PI;
    if (diff > Math.PI) diff -= TWO_PI;
    if (diff < -Math.PI) diff += TWO_PI;
    vals[i] = vals[i - 1] + diff;
  }
  return vals;
}

/**
 * Resolves exact per-point { frame, val, interpolation, hl, hr, handleType } for every
 * keyframe in a sorted F-Curve channel.
 */
export function resolveFCurvePoints(points, options = {}) {
  if (!Array.isArray(points) || points.length === 0) return [];
  const sorted = [...points].sort((a, b) => a.frame - b.frame);
  const n = sorted.length;
  const vals = options.unwrapAngles ? unwrapAngleValues(sorted) : sorted.map((p) => p.val);
  const defaultInterp = String(options.defaultInterpolation || 'smooth').toLowerCase();

  const resolved = new Array(n);

  for (let i = 0; i < n; i++) {
    const src = sorted[i];
    const interp = String(src.interpolation || defaultInterp).toLowerCase();
    const handleType = normalizeHandleType(src.handleType || src.handle?.type);

    const prevDt = i > 0
      ? Math.max(1e-5, sorted[i].frame - sorted[i - 1].frame)
      : (i + 1 < n ? Math.max(1e-5, sorted[i + 1].frame - sorted[i].frame) : 3);
    const nextDt = i + 1 < n
      ? Math.max(1e-5, sorted[i + 1].frame - sorted[i].frame)
      : prevDt;

    const rawHl = Array.isArray(src.hl) ? src.hl : (Array.isArray(src.handle?.hl) ? src.handle.hl : null);
    const rawHr = Array.isArray(src.hr) ? src.hr : (Array.isArray(src.handle?.hr) ? src.handle.hr : null);

    let hl = [-prevDt / 3, 0];
    let hr = [nextDt / 3, 0];

    if (interp === 'linear') {
      hl = [
        -prevDt / 3,
        i > 0 ? (vals[i - 1] - vals[i]) / 3 : (i + 1 < n ? -(vals[i + 1] - vals[i]) / 3 : 0),
      ];
      hr = [
        nextDt / 3,
        i + 1 < n ? (vals[i + 1] - vals[i]) / 3 : (i > 0 ? -(vals[i - 1] - vals[i]) / 3 : 0),
      ];
    } else if (interp === 'easeinout') {
      hl = [-prevDt / 3, 0];
      hr = [nextDt / 3, 0];
    } else if (handleType === 'vector') {
      const slopeL = i > 0 ? (vals[i] - vals[i - 1]) / prevDt : (i + 1 < n ? (vals[i + 1] - vals[i]) / nextDt : 0);
      const slopeR = i + 1 < n ? (vals[i + 1] - vals[i]) / nextDt : (i > 0 ? (vals[i] - vals[i - 1]) / prevDt : 0);
      hl = [-prevDt / 3, -slopeL * (prevDt / 3)];
      hr = [nextDt / 3, slopeR * (nextDt / 3)];
    } else if ((handleType === 'aligned' || handleType === 'free') && (rawHl || rawHr)) {
      hl = rawHl ? [Math.min(0, Number(rawHl[0]) || 0), Number(rawHl[1]) || 0] : [-prevDt / 3, 0];
      hr = rawHr ? [Math.max(0, Number(rawHr[0]) || 0), Number(rawHr[1]) || 0] : [nextDt / 3, 0];
    } else {
      // Blender Auto Clamped handles: zero slope at endpoints and local extrema,
      // clamped smooth tangent inside monotone stretches.
      if (i === 0 || i === n - 1) {
        hl = [-prevDt / 3, 0];
        hr = [nextDt / 3, 0];
      } else {
        const dvPrev = vals[i] - vals[i - 1];
        const dvNext = vals[i + 1] - vals[i];
        if (dvPrev * dvNext <= 0) {
          hl = [-prevDt / 3, 0];
          hr = [nextDt / 3, 0];
        } else {
          const sPrev = dvPrev / prevDt;
          const sNext = dvNext / nextDt;
          // Weighted harmonic-safe slope that avoids overshoot beyond neighbor values
          let slope = (2 * sPrev * sNext) / (sPrev + sNext);
          if (!Number.isFinite(slope)) slope = 0;
          const maxSlopeL = Math.abs(dvPrev) / Math.max(1e-5, prevDt / 3);
          const maxSlopeR = Math.abs(dvNext) / Math.max(1e-5, nextDt / 3);
          const clampedAbs = Math.min(Math.abs(slope), maxSlopeL, maxSlopeR);
          slope = Math.sign(dvPrev) * clampedAbs;
          hl = [-prevDt / 3, -slope * (prevDt / 3)];
          hr = [nextDt / 3, slope * (nextDt / 3)];
        }
      }
    }

    resolved[i] = {
      frame: src.frame,
      val: vals[i],
      rawVal: src.val,
      interpolation: interp,
      handleType,
      hl,
      hr,
    };
  }

  return resolved;
}

/**
 * Evaluates a complete F-Curve with true cubic Bezier handles and extrapolation.
 */
export function evaluateFCurve(points, frame, options = {}) {
  const resolved = resolveFCurvePoints(points, options);
  const n = resolved.length;
  if (n === 0) return null;
  if (n === 1) return resolved[0].val;

  const extrap = normalizeExtrapolation(options.extrapolation);
  const first = resolved[0];
  const last = resolved[n - 1];
  const span = last.frame - first.frame;

  let evalFrame = frame;
  let valueOffset = 0;

  if (frame < first.frame || frame > last.frame) {
    if (extrap === 'cycle' || extrap === 'cycle_offset') {
      if (span > 1e-6) {
        const cycles = Math.floor((frame - first.frame) / span);
        evalFrame = first.frame + ((frame - first.frame) - cycles * span);
        if (extrap === 'cycle_offset') {
          valueOffset = cycles * (last.val - first.val);
        }
      } else {
        return first.val;
      }
    } else if (extrap === 'linear') {
      if (frame < first.frame) {
        let slope = 0;
        if (first.interpolation === 'constant') {
          slope = 0;
        } else if (first.interpolation === 'linear' || first.handleType === 'vector') {
          slope = span > 1e-6 ? (resolved[1].val - first.val) / Math.max(1e-6, resolved[1].frame - first.frame) : 0;
        } else if (Math.abs(first.hl[0]) > 1e-6) {
          slope = first.hl[1] / first.hl[0];
        } else if (Math.abs(first.hr[0]) > 1e-6) {
          slope = first.hr[1] / first.hr[0];
        }
        return first.val + (frame - first.frame) * slope;
      } else {
        const prev = resolved[n - 2];
        let slope = 0;
        if (prev.interpolation === 'constant') {
          slope = 0;
        } else if (prev.interpolation === 'linear' || last.handleType === 'vector') {
          slope = (last.val - prev.val) / Math.max(1e-6, last.frame - prev.frame);
        } else if (Math.abs(last.hr[0]) > 1e-6) {
          slope = last.hr[1] / last.hr[0];
        } else if (Math.abs(last.hl[0]) > 1e-6) {
          slope = last.hl[1] / last.hl[0];
        }
        return last.val + (frame - last.frame) * slope;
      }
    } else {
      // Constant extrapolation (default)
      return frame <= first.frame ? first.val : last.val;
    }
  }

  if (evalFrame <= first.frame) return first.val + valueOffset;
  if (evalFrame >= last.frame) return last.val + valueOffset;

  // Binary search bounding segment [idx, idx + 1]
  let lo = 0;
  let hi = n - 2;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (resolved[mid].frame <= evalFrame) lo = mid;
    else hi = mid - 1;
  }

  const p1 = resolved[lo];
  const p2 = resolved[lo + 1];
  if (Math.abs(p2.frame - p1.frame) <= 1e-9) return p1.val + valueOffset;

  const t = (evalFrame - p1.frame) / (p2.frame - p1.frame);
  const mode = p1.interpolation;

  if (mode === 'constant') {
    return p1.val + valueOffset;
  }

  if (mode === 'linear') {
    return p1.val + t * (p2.val - p1.val) + valueOffset;
  }

  if (mode === 'easeinout') {
    const tSmooth = t * t * (3 - 2 * t);
    return p1.val + tSmooth * (p2.val - p1.val) + valueOffset;
  }

  // True Cubic Bezier ('bezier' | 'smooth' | fallback)
  const y = solveCubicBezierTimeY(
    p1.frame,
    p1.val,
    p1.frame + p1.hr[0],
    p1.val + p1.hr[1],
    p2.frame + p2.hl[0],
    p2.val + p2.hl[1],
    p2.frame,
    p2.val,
    evalFrame
  );
  return y + valueOffset;
}
