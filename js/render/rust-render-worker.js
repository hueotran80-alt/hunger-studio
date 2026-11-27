// Web Worker hosting one Rust render-kernel instance;
// supports row-tiled path tracing, zero-copy SharedArrayBuffer parallel denoise/temporal/tonemap, and texture baking.
import { RenderKernel, AOV_STRIDE } from './rust-render-bridge.js';

let kernel = null;
let sab = null; // { width, height, accum, aov, col, tmp, alb, nrm, meanA, meanB, prevAov, rgba }

self.onmessage = async (event) => {
  const msg = event.data;
  try {
    if (msg.type === 'init') {
      kernel = await RenderKernel.create(msg.wasm);
      kernel.loadScene(msg.packed);
      self.postMessage({ ok: true });
    } else if (msg.type === 'load') {
      kernel.loadScene(msg.packed);
      self.postMessage({ ok: true });
    } else if (msg.type === 'refit') {
      if (!kernel.refitScene(msg.packed)) kernel.loadScene(msg.packed);
      self.postMessage({ ok: true });
    } else if (msg.type === 'attach-sab') {
      const s = msg.sab;
      sab = s ? {
        width: s.width,
        height: s.height,
        accum: new Float32Array(s.accum),
        aov: new Float32Array(s.aov),
        col: new Float32Array(s.col),
        tmp: new Float32Array(s.tmp),
        alb: new Float32Array(s.alb),
        nrm: new Float32Array(s.nrm),
        meanA: new Float32Array(s.meanA),
        meanB: new Float32Array(s.meanB),
        prevAov: new Float32Array(s.prevAov),
        rgba: new Uint8ClampedArray(s.rgba),
      } : null;
      self.postMessage({ ok: true });
    } else if (msg.type === 'rows') {
      const result = kernel.renderRows(msg.params);
      self.postMessage({ ok: true, result }, [result.accum.buffer, result.aov.buffer]);
    } else if (msg.type === 'rows-sab') {
      const p = msg.params;
      const result = kernel.renderRows(p);
      const ao = p.y0 * p.width * 4;
      const go = p.y0 * p.width * AOV_STRIDE;
      if (p.clearFirst) {
        sab.accum.set(result.accum, ao);
        sab.aov.set(result.aov, go);
      } else {
        for (let i = 0; i < result.accum.length; i++) sab.accum[ao + i] += result.accum[i];
        for (let i = 0; i < result.aov.length; i++) sab.aov[go + i] += result.aov[i];
      }
      self.postMessage({ ok: true });
    } else if (msg.type === 'denoise-prep-sab') {
      const { width, height, y0, y1, spp } = msg.params;
      kernel.denoisePrepBand(sab.accum, sab.aov, sab.col, sab.alb, sab.nrm, width, height, y0, y1, spp);
      self.postMessage({ ok: true });
    } else if (msg.type === 'denoise-step-sab') {
      const { width, height, y0, y1, step, passScaleInv2, vertical } = msg.params;
      const src = vertical ? sab.tmp : sab.col;
      const dst = vertical ? sab.col : sab.tmp;
      kernel.denoiseStepBand(src, sab.alb, sab.nrm, dst, width, height, y0, y1, step, passScaleInv2, vertical);
      self.postMessage({ ok: true });
    } else if (msg.type === 'denoise-remod-sab') {
      const { width, height, y0, y1, spp, denoise, curMeanSlot } = msg.params;
      const curMean = curMeanSlot === 0 ? sab.meanA : sab.meanB;
      if (denoise) {
        kernel.denoiseRemodBand(sab.col, sab.alb, sab.nrm, curMean, width, height, y0, y1);
      } else {
        const inv = 1 / Math.max(1, spp);
        const start = y0 * width * 4;
        const end = y1 * width * 4;
        for (let i = start; i < end; i++) curMean[i] = sab.accum[i] * inv;
      }
      self.postMessage({ ok: true });
    } else if (msg.type === 'finalize-sab') {
      const { width, height, y0, y1, spp, prevSpp, useTemporal, hasPrev, blend, exposure, tonemap, tonemapLook, curMeanSlot } = msg.params;
      const curMean = curMeanSlot === 0 ? sab.meanA : sab.meanB;
      const prevMean = curMeanSlot === 0 ? sab.meanB : sab.meanA;
      if (useTemporal && hasPrev) {
        kernel.temporalReprojectBand(curMean, sab.aov, prevMean, sab.prevAov, sab.tmp, width, height, y0, y1, spp, prevSpp, blend);
        kernel.tonemapBand(sab.tmp, sab.rgba, width, height, y0, y1, exposure, tonemap, tonemapLook);
      } else {
        kernel.tonemapBand(curMean, sab.rgba, width, height, y0, y1, exposure, tonemap, tonemapLook);
      }
      self.postMessage({ ok: true });
    } else if (msg.type === 'commit-temporal-sab') {
      const { width, y0, y1, hasPrev, curMeanSlot } = msg.params;
      const curMean = curMeanSlot === 0 ? sab.meanA : sab.meanB;
      const start4 = y0 * width * 4;
      const end4 = y1 * width * 4;
      if (hasPrev) {
        curMean.set(sab.tmp.subarray(start4, end4), start4);
      }
      const startA = y0 * width * AOV_STRIDE;
      const endA = y1 * width * AOV_STRIDE;
      sab.prevAov.set(sab.aov.subarray(startA, endA), startA);
      self.postMessage({ ok: true });
    } else if (msg.type === 'bake') {
      const result = kernel.bakeRows(msg.params);
      self.postMessage({ ok: true, result }, [result.rgba.buffer, result.cov.buffer]);
    }
  } catch (error) {
    self.postMessage({ ok: false, error: String(error?.message || error) });
  }
};
