/**
 * Optical background camera motion & zoom estimator for monocular Mocap.
 * Excludes the tracked subject bounding box (`personMaskNorm`) so foreground
 * dancing / limb sweeps never corrupt background camera pan/tilt/zoom flow.
 */

function clamp(v, lo, hi) {
  return v < lo ? lo : (v > hi ? hi : v);
}

function medianSorted(arr) {
  if (!arr.length) return 0;
  const s = arr.slice().sort((a, b) => a - b);
  const mid = s.length >> 1;
  return (s.length & 1) === 1 ? s[mid] : 0.5 * (s[mid - 1] + s[mid]);
}

/**
 * Downsample an RGBA8 buffer to normalized grayscale luminance `[0..1]` (`Float32Array`).
 * Reuses `outLuma` if provided and correctly sized.
 */
export function lumaFromImageData(rgba, srcW, srcH, dstW, dstH, outLuma = null) {
  const n = dstW * dstH;
  const luma = outLuma && outLuma.length >= n ? outLuma : new Float32Array(n);
  if (!rgba || srcW <= 0 || srcH <= 0) {
    luma.fill(0);
    return luma;
  }
  const sx = srcW / dstW;
  const sy = srcH / dstH;
  const inv255 = 1 / 255;
  for (let y = 0; y < dstH; y++) {
    const srcY = Math.min(srcH - 1, Math.floor((y + 0.5) * sy));
    const rowOff = srcY * srcW;
    const dstRow = y * dstW;
    for (let x = 0; x < dstW; x++) {
      const srcX = Math.min(srcW - 1, Math.floor((x + 0.5) * sx));
      const p = (rowOff + srcX) * 4;
      luma[dstRow + x] = (
        0.299 * rgba[p] +
        0.587 * rgba[p + 1] +
        0.114 * rgba[p + 2]
      ) * inv255;
    }
  }
  return luma;
}

/**
 * Estimate sub-pixel background translation `(dxBg, dyBg)` (in downsampled pixels)
 * and incremental zoom ratio from `prevLuma` -> `currLuma`, ignoring pixels
 * inside `personMaskNorm = { minX, maxX, minY, maxY }` (normalized `[0..1]`).
 *
 * Returns camera displacement `(camDxNorm, camDyNorm)` in `[0..1]` image units
 * where panning camera RIGHT shifts background LEFT (`dxBg < 0 -> camDxNorm > 0`).
 */
export function estimateBlockMotionPair(prevLuma, currLuma, w, h, personMaskNorm = null, opts = {}) {
  if (!prevLuma || !currLuma || prevLuma.length < w * h || currLuma.length < w * h) {
    return { camDxNorm: 0, camDyNorm: 0, deltaZoom: 1, confidence: 0, inliers: 0 };
  }

  const blockRadius = Math.max(2, opts.blockRadius ?? 4);
  const searchRadius = Math.max(3, opts.searchRadius ?? 8);
  const minTex = opts.minTextureEnergy ?? 0.018;
  const cols = opts.gridCols ?? 8;
  const rows = opts.gridRows ?? 5;

  const marginX = searchRadius + blockRadius + 1;
  const marginY = searchRadius + blockRadius + 1;
  if (w <= marginX * 2 + 4 || h <= marginY * 2 + 4) {
    return { camDxNorm: 0, camDyNorm: 0, deltaZoom: 1, confidence: 0, inliers: 0 };
  }

  const usableW = w - marginX * 2;
  const usableH = h - marginY * 2;
  const blockSamples = [];

  for (let gr = 0; gr < rows; gr++) {
    const cy = Math.round(marginY + ((gr + 0.5) / rows) * usableH);
    const ny = cy / h;
    for (let gc = 0; gc < cols; gc++) {
      const cx = Math.round(marginX + ((gc + 0.5) / cols) * usableW);
      const nx = cx / w;

      if (
        personMaskNorm &&
        nx >= personMaskNorm.minX &&
        nx <= personMaskNorm.maxX &&
        ny >= personMaskNorm.minY &&
        ny <= personMaskNorm.maxY
      ) {
        continue;
      }

      // Compute block mean & contrast energy in prevLuma to skip flat/solid walls
      let sum = 0;
      let sumSq = 0;
      let count = 0;
      for (let by = -blockRadius; by <= blockRadius; by += 2) {
        const off = (cy + by) * w + cx;
        for (let bx = -blockRadius; bx <= blockRadius; bx += 2) {
          const val = prevLuma[off + bx];
          sum += val;
          sumSq += val * val;
          count++;
        }
      }
      const mean = sum / count;
      const std = Math.sqrt(Math.max(0, sumSq / count - mean * mean));
      if (std < minTex) continue;

      // Coarse 2px step search over [-searchRadius .. +searchRadius]
      let bestDx = 0;
      let bestDy = 0;
      let bestSad = Infinity;
      let sadZero = 0;

      const evalSad = (dx, dy) => {
        let sad = 0;
        for (let by = -blockRadius; by <= blockRadius; by += 2) {
          const pRow = (cy + by) * w + cx;
          const cRow = (cy + by + dy) * w + cx + dx;
          for (let bx = -blockRadius; bx <= blockRadius; bx += 2) {
            const d = currLuma[cRow + bx] - prevLuma[pRow + bx];
            sad += d < 0 ? -d : d;
          }
        }
        return sad;
      };

      sadZero = evalSad(0, 0);
      bestSad = sadZero;

      for (let dy = -searchRadius; dy <= searchRadius; dy += 2) {
        for (let dx = -searchRadius; dx <= searchRadius; dx += 2) {
          if (dx === 0 && dy === 0) continue;
          const s = evalSad(dx, dy);
          if (s < bestSad) {
            bestSad = s;
            bestDx = dx;
            bestDy = dy;
          }
        }
      }

      // Fine 1px neighborhood refinement around best coarse match
      const cDx = bestDx;
      const cDy = bestDy;
      for (let dy = cDy - 1; dy <= cDy + 1; dy++) {
        for (let dx = cDx - 1; dx <= cDx + 1; dx++) {
          if (Math.abs(dx) > searchRadius || Math.abs(dy) > searchRadius) continue;
          const s = evalSad(dx, dy);
          if (s < bestSad) {
            bestSad = s;
            bestDx = dx;
            bestDy = dy;
          }
        }
      }

      // Parabolic subpixel interpolation using horizontal/vertical neighbors
      let subDx = bestDx;
      let subDy = bestDy;
      if (Math.abs(bestDx) < searchRadius && Math.abs(bestDy) < searchRadius) {
        const sL = evalSad(bestDx - 1, bestDy);
        const sR = evalSad(bestDx + 1, bestDy);
        const denomX = 2 * (sL - 2 * bestSad + sR);
        if (Math.abs(denomX) > 1e-6) {
          subDx += clamp((sL - sR) / denomX, -0.5, 0.5);
        }
        const sU = evalSad(bestDx, bestDy - 1);
        const sD = evalSad(bestDx, bestDy + 1);
        const denomY = 2 * (sU - 2 * bestSad + sD);
        if (Math.abs(denomY) > 1e-6) {
          subDy += clamp((sU - sD) / denomY, -0.5, 0.5);
        }
      }

      // Reject poor matches (occlusion or lighting flash)
      const avgAbsErr = bestSad / count;
      if (avgAbsErr > 0.16 && bestSad > sadZero * 0.92) continue;

      blockSamples.push({ cx, cy, dx: subDx, dy: subDy, std });
    }
  }

  if (blockSamples.length < 3) {
    return { camDxNorm: 0, camDyNorm: 0, deltaZoom: 1, confidence: 0, inliers: 0 };
  }

  const medDx = medianSorted(blockSamples.map((b) => b.dx));
  const medDy = medianSorted(blockSamples.map((b) => b.dy));
  const inliers = blockSamples.filter(
    (b) => Math.hypot(b.dx - medDx, b.dy - medDy) <= 1.25
  );

  if (inliers.length < 3) {
    return { camDxNorm: 0, camDyNorm: 0, deltaZoom: 1, confidence: 0, inliers: inliers.length };
  }

  const finalDx = medianSorted(inliers.map((b) => b.dx));
  const finalDy = medianSorted(inliers.map((b) => b.dy));

  // Estimate subtle radial zoom from residual motion relative to center
  let deltaZoom = 1;
  if (inliers.length >= 6) {
    const halfW = 0.5 * w;
    const halfH = 0.5 * h;
    const minRad = 0.16 * Math.min(w, h);
    const zoomEst = [];
    for (const b of inliers) {
      const rx = b.cx - halfW;
      const ry = b.cy - halfH;
      const r2 = rx * rx + ry * ry;
      if (r2 < minRad * minRad) continue;
      const ux = b.dx - finalDx;
      const uy = b.dy - finalDy;
      const radialRate = (ux * rx + uy * ry) / r2;
      if (Math.abs(radialRate) < 0.035) {
        zoomEst.push(1 + radialRate);
      }
    }
    if (zoomEst.length >= 4) {
      const medZ = clamp(medianSorted(zoomEst), 0.97, 1.03);
      // Ignore tiny zoom noise < 0.15% per frame
      deltaZoom = Math.abs(medZ - 1) > 0.0015 ? medZ : 1;
    }
  }

  // Camera pan RIGHT moves background LEFT (dxBg < 0 -> positive camera pan)
  const camDxNorm = -finalDx / w;
  const camDyNorm = -finalDy / h;
  const confidence = clamp((inliers.length / Math.max(6, cols * rows * 0.4)), 0, 1);

  return { camDxNorm, camDyNorm, deltaZoom, confidence, inliers: inliers.length };
}

export class CameraMotionEstimator {
  constructor(options = {}) {
    this.width = Math.max(48, Math.round(options.width ?? 128));
    this.height = Math.max(36, Math.round(options.height ?? 72));
    this.searchRadius = options.searchRadius ?? 8;
    this.blockRadius = options.blockRadius ?? 4;
    this.minTextureEnergy = options.minTextureEnergy ?? 0.018;

    this._prevLuma = null;
    this._currLuma = new Float32Array(this.width * this.height);
    this._scratchCanvas = null;
    this._scratchCtx = null;

    this.cumPanXNorm = 0;
    this.cumPanYNorm = 0;
    this.cumZoom = 1;
    this.series = [];
  }

  reset() {
    this._prevLuma = null;
    this.cumPanXNorm = 0;
    this.cumPanYNorm = 0;
    this.cumZoom = 1;
    this.series = [];
  }

  /**
   * Build normalized subject exclusion rect `[0..1]` from MediaPipe 2D landmarks `[x, y, vis]`.
   */
  static maskFromLandmarks(lmFrame, pad = 0.11) {
    if (!Array.isArray(lmFrame) || lmFrame.length < 10) return null;
    let minX = 1;
    let maxX = 0;
    let minY = 1;
    let maxY = 0;
    let count = 0;
    for (let i = 0; i < lmFrame.length; i++) {
      const lm = lmFrame[i];
      if (!lm) continue;
      const x = Array.isArray(lm) ? Number(lm[0]) : Number(lm.x);
      const y = Array.isArray(lm) ? Number(lm[1]) : Number(lm.y);
      const v = Array.isArray(lm) ? Number(lm[2] ?? 0.9) : Number(lm.visibility ?? 0.9);
      if (!Number.isFinite(x) || !Number.isFinite(y) || v < 0.15) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      count++;
    }
    if (count < 4) return null;
    return {
      minX: clamp(minX - pad, 0, 1),
      maxX: clamp(maxX + pad, 0, 1),
      minY: clamp(minY - pad * 0.85, 0, 1),
      maxY: clamp(maxY + pad * 0.85, 0, 1),
    };
  }

  /**
   * Feed downsampled grayscale luminance buffer directly (ideal for unit tests & custom callers).
   */
  feedLuma(lumaBuffer, personMaskNorm = null) {
    if (!lumaBuffer || lumaBuffer.length < this.width * this.height) {
      const entry = {
        cumPanXNorm: this.cumPanXNorm,
        cumPanYNorm: this.cumPanYNorm,
        cumZoom: this.cumZoom,
        confidence: 0,
      };
      this.series.push(entry);
      return { ...entry, dxNorm: 0, dyNorm: 0, inliers: 0 };
    }

    if (!this._prevLuma) {
      this._prevLuma = new Float32Array(this.width * this.height);
      this._prevLuma.set(lumaBuffer.subarray(0, this.width * this.height));
      const entry = { cumPanXNorm: 0, cumPanYNorm: 0, cumZoom: 1, confidence: 1 };
      this.series.push(entry);
      return { ...entry, dxNorm: 0, dyNorm: 0, inliers: 0 };
    }

    const res = estimateBlockMotionPair(
      this._prevLuma,
      lumaBuffer,
      this.width,
      this.height,
      personMaskNorm,
      {
        searchRadius: this.searchRadius,
        blockRadius: this.blockRadius,
        minTextureEnergy: this.minTextureEnergy,
      },
    );

    if (res.confidence > 0.15) {
      // Suppress tiny sub-0.25px stationary camera tremor
      const dx = Math.abs(res.camDxNorm) * this.width < 0.25 ? 0 : res.camDxNorm;
      const dy = Math.abs(res.camDyNorm) * this.height < 0.25 ? 0 : res.camDyNorm;
      this.cumPanXNorm = clamp(this.cumPanXNorm + dx, -3.5, 3.5);
      this.cumPanYNorm = clamp(this.cumPanYNorm + dy, -2.5, 2.5);
      this.cumZoom = clamp(this.cumZoom * res.deltaZoom, 0.45, 2.25);
    }

    this._prevLuma.set(lumaBuffer.subarray(0, this.width * this.height));
    const entry = {
      cumPanXNorm: this.cumPanXNorm,
      cumPanYNorm: this.cumPanYNorm,
      cumZoom: this.cumZoom,
      confidence: res.confidence,
    };
    this.series.push(entry);
    return {
      ...entry,
      dxNorm: res.camDxNorm,
      dyNorm: res.camDyNorm,
      inliers: res.inliers,
    };
  }

  /**
   * Feed raw RGBA8 frame buffer (`srcW x srcH`) and update cumulative camera pan/zoom.
   */
  feedRgba(rgba, srcW, srcH, personMaskNorm = null) {
    lumaFromImageData(rgba, srcW, srcH, this.width, this.height, this._currLuma);
    return this.feedLuma(this._currLuma, personMaskNorm);
  }

  /**
   * Feed a video/image/canvas source (`HTMLVideoElement`, `HTMLCanvasElement`, `ImageBitmap`)
   * using a reusable tiny offscreen `128x72` canvas so GPU->CPU readback stays negligible (<0.2 ms).
   */
  feedMediaSource(source, personMaskNorm = null) {
    if (!source || typeof document === 'undefined') {
      return this.feedLuma(null, personMaskNorm);
    }
    if (!this._scratchCanvas) {
      this._scratchCanvas = document.createElement('canvas');
      this._scratchCanvas.width = this.width;
      this._scratchCanvas.height = this.height;
      this._scratchCtx = this._scratchCanvas.getContext('2d', { willReadFrequently: true });
    }
    if (!this._scratchCtx) return this.feedLuma(null, personMaskNorm);
    try {
      this._scratchCtx.drawImage(source, 0, 0, this.width, this.height);
      const img = this._scratchCtx.getImageData(0, 0, this.width, this.height);
      return this.feedRgba(img.data, this.width, this.height, personMaskNorm);
    } catch {
      return this.feedLuma(null, personMaskNorm);
    }
  }

  getSeries() {
    return this.series.slice();
  }
}

export default CameraMotionEstimator;
