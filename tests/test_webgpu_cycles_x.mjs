/**
 * Official Headless WebGPU Cycles X + Rust BVH Automated Verification Suite
 * Self-contained: starts an ephemeral COOP/COEP HTTP server on an unused port, launches
 * headless Chrome with WebGPU enabled, and verifies:
 *   1. High-performance GPU adapter probing (`probeAdapter`)
 *   2. Zero-error compilation of all 4 WGSL shaders (trace, svgf_temporal, svgf_denoise, blit)
 *   3. TDR-safe chunked progressive GPU dispatch (`32 spp` in 4×8 spp chunks)
 *   4. Instant mid-frame cancellation via AbortController
 *   5. Principled BSDF v2 (Multi-Scattering GGX rough gold + GPU Texture Atlas + SVGF Albedo Demod/Remod)
 *   6. 2D HDRI Importance Sampling CDF exported by Rust WASM (`_hasEnvCdf === true`)
 *   7. SVGF Temporal Reprojection stability across frames (no flicker/boiling)
 *   8. Full 1280×720 animated MP4 export (O(N) BVH Refit + Zero-Copy WebCodecs H.264 decode check)
 *
 * Gracefully prints SKIP if headless Chrome or hardware WebGPU is unavailable on the host.
 * File: tests/test_webgpu_cycles_x.mjs
 */

import assert from 'node:assert';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.glb': 'model/gltf-binary',
  '.hdr': 'application/octet-stream',
};

function findChrome() {
  const candidates = [
    process.env.CHROME_BIN,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].filter(Boolean);
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function startStaticServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const cleanUrl = (req.url || '/').split('?')[0];
      const rel = cleanUrl === '/' ? 'index.html' : cleanUrl.replace(/^\/+/, '');
      const full = path.resolve(ROOT, rel);
      if (!full.startsWith(ROOT) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) {
        res.writeHead(404);
        res.end('Not Found');
        return;
      }
      const ext = path.extname(full).toLowerCase();
      res.writeHead(200, {
        'Content-Type': MIME[ext] || 'application/octet-stream',
        'Cross-Origin-Opener-Policy': 'same-origin',
        'Cross-Origin-Embedder-Policy': 'credentialless',
        'Cache-Control': 'no-store',
      });
      fs.createReadStream(full).pipe(res);
    });
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port });
    });
  });
}

class CdpClient {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.id = 0;
    this.pending = new Map();
    this.ready = new Promise((res, rej) => { this.ws.onopen = res; this.ws.onerror = rej; });
    this.ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      }
    };
  }
  async send(method, params = {}) {
    await this.ready;
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async evalAsync(expression) {
    const res = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (res.exceptionDetails) {
      throw new Error(res.exceptionDetails.exception?.description || res.exceptionDetails.text || 'Eval error');
    }
    return res.result?.value;
  }
  close() { try { this.ws.close(); } catch (_) {} }
}

async function waitUrl(url, ms = 12000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try { const r = await fetch(url); if (r.ok) return r; } catch (_) {}
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('timeout ' + url);
}

const chromeBin = findChrome();
if (!chromeBin) {
  console.log('SKIP: Chrome/Chromium not found; skipping headless WebGPU Cycles X suite');
  process.exit(0);
}

const { server, port } = await startStaticServer();
const cdpPort = 9400 + Math.floor(Math.random() * 400);
const chrome = spawn(chromeBin, [
  '--headless=new',
  '--no-sandbox',
  '--disable-gpu-sandbox',
  '--use-gl=angle',
  '--enable-webgl',
  '--enable-unsafe-webgpu',
  `--remote-debugging-port=${cdpPort}`,
  '--window-size=1280,720',
  `http://127.0.0.1:${port}/index.html`,
], { stdio: ['ignore', 'pipe', 'pipe'] });

let cdp = null;
const watchdog = setTimeout(() => {
  console.error('FAIL WebGPU Cycles X suite timed out after 90s');
  try { cdp?.close(); } catch (_) {}
  try { chrome.kill('SIGKILL'); } catch (_) {}
  try { server.close(); } catch (_) {}
  process.exit(1);
}, 90_000);
watchdog.unref?.();
try {
  const targets = await (await waitUrl(`http://127.0.0.1:${cdpPort}/json/list`)).json();
  const page = targets.find((t) => t.type === 'page');
  if (!page) throw new Error('No Chrome page target found');
  cdp = new CdpClient(page.webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');

  const res = await cdp.evalAsync(`(async () => {
    while (!window.app?.engine || !window.app?.timelineEngine) await new Promise(r => setTimeout(r, 100));
    const THREE = await import('three');
    const { WebGPUPathTracer } = await import('./js/render/webgpu-pathtracer.js');
    const { packSceneForRust } = await import('./js/render/rust-scene-pack.js');
    const { createProceduralHdriTexture } = await import('./js/render/procedural-hdri.js');
    const { VideoExportManager } = await import('./js/render/video-export.js');
    const { unzipSync } = await import('three/addons/libs/fflate.module.js');

    const adapterInfo = await WebGPUPathTracer.probeAdapter();
    if (!adapterInfo.supported || adapterInfo.isFallback) {
      return { skip: true, reason: 'No hardware WebGPU adapter: ' + adapterInfo.label };
    }

    const app = window.app;
    const engine = app.engine;
    const tl = app.timelineEngine;
    const scene = new THREE.Scene();

    const hdri = createProceduralHdriTexture({ THREE, preset: 'studio-softbox', width: 128, height: 64 });
    scene.userData.rawEnvironmentSource = hdri;
    scene.environment = hdri;
    scene.background = hdri;
    scene.environmentIntensity = 1.0;

    // 8x8 high-contrast checkerboard texture
    const tc = document.createElement('canvas'); tc.width = 128; tc.height = 128;
    const tctx = tc.getContext('2d');
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
      tctx.fillStyle = ((x + y) & 1) ? '#f2eee8' : '#162032';
      tctx.fillRect(x * 16, y * 16, 16, 16);
    }
    const checkerTex = new THREE.CanvasTexture(tc);
    checkerTex.colorSpace = THREE.SRGBColorSpace;
    checkerTex.needsUpdate = true;

    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(16, 16),
      new THREE.MeshStandardMaterial({ color: 0x606060, roughness: 0.85, metalness: 0.0 })
    );
    floor.rotation.x = -Math.PI / 2;
    scene.add(floor);

    const cube = new THREE.Mesh(
      new THREE.BoxGeometry(1.6, 1.6, 1.6),
      new THREE.MeshStandardMaterial({ map: checkerTex, roughness: 0.45, metalness: 0.0 })
    );
    cube.position.set(0, 0.8, 0);
    scene.add(cube);

    const gold = new THREE.Mesh(
      new THREE.SphereGeometry(0.75, 24, 16),
      new THREE.MeshPhysicalMaterial({ color: 0xf0c250, metalness: 1.0, roughness: 0.82 })
    );
    gold.position.set(2.0, 0.75, 0);
    scene.add(gold);

    const sun = new THREE.DirectionalLight(0xffffff, 2.5);
    sun.position.set(4, 7, 5);
    scene.add(sun);

    const cam = new THREE.PerspectiveCamera(45, 640 / 360, 0.1, 100);
    cam.position.set(0, 1.6, 5.2);
    cam.lookAt(0, 0.8, 0);
    cam.updateMatrixWorld(true);

    const pt = new WebGPUPathTracer();
    const initOk = await pt.init();
    const packed = packSceneForRust({ scene, camera: cam, width: 640, height: 360 });

    // Test TDR-safe chunked progressive dispatch (32 spp in 4x8 chunks)
    const chunksSeen = [];
    const f0 = await pt.renderFrame(packed, {
      width: 640, height: 360, samples: 32, samplesPerChunk: 8,
      denoise: true, temporal: false, tonemap: 'agx', seed: 1,
      onChunkProgress: (c) => chunksSeen.push(c.samplesDone),
    });

    const c2d = document.createElement('canvas'); c2d.width = 640; c2d.height = 360;
    const ctx2 = c2d.getContext('2d', { willReadFrequently: true });
    ctx2.drawImage(f0.canvas, 0, 0);
    const img = ctx2.getImageData(0, 0, 640, 360).data;

    let cMinL = 255, cMaxL = 0;
    for (let y = 145; y < 235; y += 2) {
      for (let x = 275; x < 365; x += 2) {
        const o = (y * 640 + x) * 4;
        const l = 0.2126 * img[o] + 0.7152 * img[o + 1] + 0.0722 * img[o + 2];
        if (l < cMinL) cMinL = l;
        if (l > cMaxL) cMaxL = l;
      }
    }

    let gR = 0, gG = 0, gB = 0, gN = 0;
    for (let y = 165; y < 210; y++) {
      for (let x = 445; x < 495; x++) {
        const o = (y * 640 + x) * 4;
        gR += img[o]; gG += img[o + 1]; gB += img[o + 2]; gN++;
      }
    }

    // Test mid-frame AbortController cancellation between chunks
    const ac = new AbortController();
    let abortedProperly = false;
    try {
      await pt.renderFrame(packed, {
        width: 640, height: 360, samples: 32, samplesPerChunk: 8,
        signal: ac.signal,
        onChunkProgress: ({ samplesDone }) => { if (samplesDone >= 8) ac.abort(); },
      });
    } catch (err) {
      abortedProperly = err?.name === 'AbortError';
    }

    // Test SVGF temporal stability across 5 frames
    const temporalR = [];
    for (let k = 1; k <= 5; k++) {
      const fk = await pt.renderFrame(packed, {
        width: 640, height: 360, samples: 8, samplesPerChunk: 8,
        denoise: true, temporal: true, tonemap: 'agx', seed: (k + 1) * 131,
      });
      ctx2.drawImage(fk.canvas, 0, 0);
      temporalR.push(ctx2.getImageData(470, 180, 1, 1).data[0]);
    }
    const hasEnvCdf = pt._hasEnvCdf;
    pt.dispose();

    // Test full animated 1280x720 MP4 export (6 frames, O(N) BVH Refit + Zero-Copy H.264)
    tl.insertKeyframe(cube, 0, 'locrotscale');
    cube.rotation.y = 0.6;
    tl.insertKeyframe(cube, 5, 'locrotscale');
    const exp = new VideoExportManager({
      renderer: engine.renderer, scene, camera: cam,
      rasterRenderer: engine.rasterRenderer, timeline: tl, engineInstance: engine,
    });
    const vidRes = await exp.renderVideo({
      width: 1280, height: 720, fps: 30, startFrame: 0, endFrame: 5,
      format: 'mp4', engine: 'webgpu', rustSamples: 8, rustDenoise: true, rustTemporal: true,
    });
    const url = URL.createObjectURL(vidRes.blob);
    let vidInfo;
    try {
      const v = document.createElement('video');
      v.muted = true; v.preload = 'auto'; v.src = url;
      await new Promise((r, j) => {
        const t = setTimeout(() => j(new Error('video timeout')), 8000);
        v.onloadeddata = () => { clearTimeout(t); r(); };
        v.onerror = () => { clearTimeout(t); j(new Error('video decode fail')); };
      });
      // Read back decoded MP4 frame 0 pixels to confirm non-black Cycles X output (not empty/raster fallback)
      const vc = document.createElement('canvas'); vc.width = 160; vc.height = 90;
      const vctx = vc.getContext('2d', { willReadFrequently: true });
      vctx.drawImage(v, 0, 0, 160, 90);
      const vd = vctx.getImageData(0, 0, 160, 90).data;
      let vLum = 0;
      for (let i = 0; i < vd.length; i += 4) vLum += 0.2126 * vd[i] + 0.7152 * vd[i + 1] + 0.0722 * vd[i + 2];
      vidInfo = { w: v.videoWidth, h: v.videoHeight, dur: +v.duration.toFixed(3), meanLum: +(vLum / (160 * 90)).toFixed(1) };
    } finally { URL.revokeObjectURL(url); }

    // ─── Test 8b: Emissive-only WebGPU MP4 pixel proof (WebGL Raster renders floor black; Cycles X lights it!) ───
    const webmEmScene = new THREE.Scene();
    webmEmScene.background = new THREE.Color(0x000000);
    const weFloor = new THREE.Mesh(
      new THREE.PlaneGeometry(10, 10),
      new THREE.MeshStandardMaterial({ color: 0xeeeeee, roughness: 0.85, metalness: 0.0 })
    );
    weFloor.rotation.x = -Math.PI / 2;
    webmEmScene.add(weFloor);
    const wePanel = new THREE.Mesh(
      new THREE.PlaneGeometry(1.8, 1.8),
      new THREE.MeshStandardMaterial({ color: 0x000000, emissive: new THREE.Color(1, 0.9, 0.75), emissiveIntensity: 20.0, roughness: 1.0 })
    );
    wePanel.position.set(0, 2.0, 0);
    wePanel.rotation.x = Math.PI / 2;
    webmEmScene.add(wePanel);
    const weCam = new THREE.PerspectiveCamera(45, 320 / 180, 0.1, 50);
    weCam.position.set(0, 1.4, 4.2); weCam.lookAt(0, 0.2, 0); weCam.updateMatrixWorld(true);
    const expWebm = new VideoExportManager({
      renderer: engine.renderer, scene: webmEmScene, camera: weCam,
      rasterRenderer: engine.rasterRenderer, timeline: tl, engineInstance: engine,
    });
    const webmRes = await expWebm.renderVideo({
      width: 320, height: 180, fps: 24, startFrame: 0, endFrame: 2,
      format: 'webm', engine: 'webgpu', rustSamples: 12, rustDenoise: true, rustTemporal: false,
    });
    const webmUrl = URL.createObjectURL(webmRes.blob);
    let webmInfo;
    try {
      const wv = document.createElement('video');
      wv.muted = true; wv.preload = 'auto'; wv.src = webmUrl;
      await new Promise((r, j) => {
        const t = setTimeout(() => j(new Error('webm timeout')), 8000);
        wv.onloadeddata = () => { clearTimeout(t); r(); };
        wv.onerror = () => { clearTimeout(t); j(new Error('webm decode fail')); };
      });
      const wc = document.createElement('canvas'); wc.width = 320; wc.height = 180;
      const wctx = wc.getContext('2d', { willReadFrequently: true });
      wctx.drawImage(wv, 0, 0, 320, 180);
      const fd = wctx.getImageData(120, 110, 80, 50).data;
      let fLum = 0;
      for (let i = 0; i < fd.length; i += 4) fLum += 0.2126 * fd[i] + 0.7152 * fd[i + 1] + 0.0722 * fd[i + 2];
      webmInfo = { w: wv.videoWidth, h: wv.videoHeight, bytes: webmRes.bytes, floorLum: +(fLum / (80 * 50)).toFixed(1) };
    } finally { URL.revokeObjectURL(webmUrl); }

    // ─── Test 9: OCIO AgX Looks (Base vs Punchy vs Low Contrast) ───
    const ptExtra = new WebGPUPathTracer();
    await ptExtra.init();
    const cEx = document.createElement('canvas'); cEx.width = 320; cEx.height = 180;
    const ctxEx = cEx.getContext('2d', { willReadFrequently: true });
    function sampleBoxStats(x0, y0, x1, y1) {
      const d = ctxEx.getImageData(x0, y0, x1 - x0, y1 - y0).data;
      let r = 0, g = 0, b = 0, sat = 0, n = 0;
      for (let i = 0; i < d.length; i += 4) {
        r += d[i]; g += d[i + 1]; b += d[i + 2];
        sat += Math.max(d[i], d[i + 1], d[i + 2]) - Math.min(d[i], d[i + 1], d[i + 2]);
        n++;
      }
      const mr = r / n, mg = g / n, mb = b / n;
      return { r: +mr.toFixed(1), g: +mg.toFixed(1), b: +mb.toFixed(1), lum: +(0.2126 * mr + 0.7152 * mg + 0.0722 * mb).toFixed(1), sat: +(sat / n).toFixed(1) };
    }

    const lookScene = new THREE.Scene();
    const redMat = new THREE.MeshStandardMaterial({ color: 0xcc3322, roughness: 0.5, metalness: 0.0 });
    const redCube = new THREE.Mesh(new THREE.BoxGeometry(2.2, 2.2, 2.2), redMat);
    lookScene.add(redCube);
    const lSun = new THREE.DirectionalLight(0xffffff, 2.0);
    lSun.position.set(2, 3, 4);
    lookScene.add(lSun);
    const lCam = new THREE.PerspectiveCamera(45, 320 / 180, 0.1, 50);
    lCam.position.set(0, 0.3, 4.2); lCam.lookAt(0, 0, 0); lCam.updateMatrixWorld(true);
    const pLook = packSceneForRust({ scene: lookScene, camera: lCam, width: 320, height: 180 });

    const rBase = await ptExtra.renderFrame(pLook, { width: 320, height: 180, samples: 8, denoise: false, temporal: false, tonemap: 'agx', tonemapLook: 'base', seed: 1 });
    ctxEx.drawImage(rBase.canvas, 0, 0);
    const lookBase = sampleBoxStats(120, 60, 200, 120);

    const rPunchy = await ptExtra.renderFrame(pLook, { width: 320, height: 180, samples: 8, denoise: false, temporal: false, tonemap: 'agx', tonemapLook: 'punchy', seed: 1 });
    ctxEx.drawImage(rPunchy.canvas, 0, 0);
    const lookPunchy = sampleBoxStats(120, 60, 200, 120);

    const rLow = await ptExtra.renderFrame(pLook, { width: 320, height: 180, samples: 8, denoise: false, temporal: false, tonemap: 'agx', tonemapLook: 'low-contrast', seed: 1 });
    ctxEx.drawImage(rLow.canvas, 0, 0);
    const lookLow = sampleBoxStats(120, 60, 200, 120);

    // ─── Test 10: Emissive Mesh NEE + Power-Heuristic MIS (ZERO analytic lights, ZERO HDRI!) ───
    const emScene = new THREE.Scene();
    emScene.background = new THREE.Color(0x000000);
    const emFloor = new THREE.Mesh(
      new THREE.PlaneGeometry(10, 10),
      new THREE.MeshStandardMaterial({ color: 0xdddddd, roughness: 0.85, metalness: 0.0 })
    );
    emFloor.rotation.x = -Math.PI / 2;
    emScene.add(emFloor);
    const emPanel = new THREE.Mesh(
      new THREE.PlaneGeometry(1.4, 1.4),
      new THREE.MeshStandardMaterial({ color: 0x000000, emissive: new THREE.Color(1, 0.9, 0.75), emissiveIntensity: 18.0, roughness: 1.0 })
    );
    emPanel.position.set(0, 2.2, 0);
    emPanel.rotation.x = Math.PI / 2;
    emScene.add(emPanel);
    const emCam = new THREE.PerspectiveCamera(45, 320 / 180, 0.1, 50);
    emCam.position.set(0, 1.4, 4.2); emCam.lookAt(0, 0.2, 0); emCam.updateMatrixWorld(true);
    const pEm = packSceneForRust({ scene: emScene, camera: emCam, width: 320, height: 180 });
    const rEm = await ptExtra.renderFrame(pEm, { width: 320, height: 180, samples: 16, denoise: true, temporal: false, tonemap: 'agx', seed: 1 });
    ctxEx.drawImage(rEm.canvas, 0, 0);
    const emFloorStats = sampleBoxStats(120, 105, 200, 160);
    const emissiveCount = ptExtra._emissiveCount;

    // ─── Test 11 & 12: Per-Vertex Object Motion Vectors (SVGF) + Deformation Object Motion Blur ───
    const mbScene = new THREE.Scene();
    mbScene.background = new THREE.Color(0x020204);
    const mbFloor = new THREE.Mesh(
      new THREE.PlaneGeometry(14, 14),
      new THREE.MeshStandardMaterial({ color: 0x18181c, roughness: 0.9, metalness: 0.0 })
    );
    mbFloor.rotation.x = -Math.PI / 2;
    mbFloor.position.y = -1.0;
    mbScene.add(mbFloor);
    const mover = new THREE.Mesh(
      new THREE.BoxGeometry(0.9, 0.9, 0.9),
      new THREE.MeshStandardMaterial({ color: 0x000000, emissive: new THREE.Color(4.0, 0.6, 0.4), emissiveIntensity: 1.0 })
    );
    mover.position.set(-1.5, 0, 0);
    mbScene.add(mover);
    const mbCam = new THREE.PerspectiveCamera(45, 320 / 180, 0.1, 50);
    mbCam.position.set(0, 0.2, 5.5); mbCam.lookAt(0, 0, 0); mbCam.updateMatrixWorld(true);

    // Frame 0: cube on LEFT (x = -1.5)
    const pMb0 = packSceneForRust({ scene: mbScene, camera: mbCam, width: 320, height: 180, shutter: 0 });
    await ptExtra.renderFrame(pMb0, { width: 320, height: 180, samples: 8, denoise: true, temporal: true, tonemap: 'agx', seed: 1 });

    // Frame 1: cube jumps to RIGHT (x = +1.5) while camera stays 100% STATIC
    mover.position.set(1.5, 0, 0);
    mbScene.updateMatrixWorld(true);
    const pMb1Sharp = packSceneForRust({ scene: mbScene, camera: mbCam, width: 320, height: 180, shutter: 0 });
    const rSharp = await ptExtra.renderFrame(pMb1Sharp, { width: 320, height: 180, samples: 16, denoise: true, temporal: true, tonemap: 'agx', seed: 2 });
    const hasPrevTris = ptExtra._hasPrevTris;
    ctxEx.drawImage(rSharp.canvas, 0, 0);
    const mvOldLeft = sampleBoxStats(60, 75, 100, 115);   // Old cube spot (should be dark, no frozen ghost!)
    const mvMidSharp = sampleBoxStats(145, 75, 175, 115); // Midpoint x=0 with shutter=0 (should be dark!)
    const mvNewRight = sampleBoxStats(220, 75, 260, 115); // New cube spot (should be bright red!)

    // Now test Deformation / Object Motion Blur with shutter = 0.9 across (-1.5 -> +1.5)
    ptExtra.resetHistory();
    mover.position.set(-1.5, 0, 0);
    mbScene.updateMatrixWorld(true);
    const pMbBlur0 = packSceneForRust({ scene: mbScene, camera: mbCam, width: 320, height: 180, shutter: 0.9 });
    // Force fresh scene load so prev_tris starts at x = -1.5
    ptExtra._sceneSig = null;
    await ptExtra.renderFrame(pMbBlur0, { width: 320, height: 180, samples: 8, denoise: false, temporal: false, tonemap: 'agx', seed: 1 });
    mover.position.set(1.5, 0, 0);
    mbScene.updateMatrixWorld(true);
    const pMbBlur1 = packSceneForRust({ scene: mbScene, camera: mbCam, width: 320, height: 180, shutter: 0.9 });
    const rBlur = await ptExtra.renderFrame(pMbBlur1, { width: 320, height: 180, samples: 32, denoise: false, temporal: false, tonemap: 'agx', seed: 3 });
    ctxEx.drawImage(rBlur.canvas, 0, 0);
    const mvMidBlur = sampleBoxStats(145, 75, 175, 115); // Midpoint x=0 with shutter=0.9 (must catch bright trail!)

    // ─── Test 13: HDRI Swap Cache Invalidation (_sceneSig) on reused WebGPUPathTracer ───
    const envScene = new THREE.Scene();
    const envSphere = new THREE.Mesh(
      new THREE.SphereGeometry(1.1, 20, 14),
      new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.85, metalness: 0.0 })
    );
    envScene.add(envSphere);
    function makeSolidEnv(r, g, b) {
      const d = new Float32Array(16 * 8 * 4);
      for (let i = 0; i < 128; i++) { d[i * 4] = r; d[i * 4 + 1] = g; d[i * 4 + 2] = b; d[i * 4 + 3] = 1; }
      const t = new THREE.DataTexture(d, 16, 8, THREE.RGBAFormat, THREE.FloatType);
      t.needsUpdate = true;
      return t;
    }
    const envCam = new THREE.PerspectiveCamera(45, 320 / 180, 0.1, 50);
    envCam.position.set(0, 0, 4.0); envCam.lookAt(0, 0, 0); envCam.updateMatrixWorld(true);
    const blueEnv = makeSolidEnv(0.05, 0.15, 0.95);
    envScene.userData.rawEnvironmentSource = blueEnv; envScene.environment = blueEnv; envScene.background = blueEnv; envScene.environmentIntensity = 1.0;
    const rEnvBlue = await ptExtra.renderFrame(packSceneForRust({ scene: envScene, camera: envCam, width: 320, height: 180 }), { width: 320, height: 180, samples: 8, denoise: false, temporal: false, tonemap: 'agx', seed: 1 });
    ctxEx.drawImage(rEnvBlue.canvas, 0, 0);
    const envBlueStats = sampleBoxStats(130, 60, 190, 120);

    const warmEnv = makeSolidEnv(0.95, 0.35, 0.05);
    envScene.userData.rawEnvironmentSource = warmEnv; envScene.environment = warmEnv; envScene.background = warmEnv;
    const rEnvWarm = await ptExtra.renderFrame(packSceneForRust({ scene: envScene, camera: envCam, width: 320, height: 180 }), { width: 320, height: 180, samples: 8, denoise: false, temporal: false, tonemap: 'agx', seed: 1 });
    ctxEx.drawImage(rEnvWarm.canvas, 0, 0);
    const envWarmStats = sampleBoxStats(130, 60, 190, 120);

    // ─── Test 14: Single-Chunk vs Multi-Chunk (TDR) Pixel Parity ───
    const rOneChunk = await ptExtra.renderFrame(pLook, {
      width: 320, height: 180, samples: 16, samplesPerChunk: 16,
      denoise: false, temporal: false, adaptiveThreshold: 0, tonemap: 'agx', seed: 7,
    });
    ctxEx.drawImage(rOneChunk.canvas, 0, 0);
    const chunkSingle = sampleBoxStats(120, 60, 200, 120);

    const rMultiChunk = await ptExtra.renderFrame(pLook, {
      width: 320, height: 180, samples: 16, samplesPerChunk: 4,
      denoise: false, temporal: false, adaptiveThreshold: 0, tonemap: 'agx', seed: 7,
    });
    ctxEx.drawImage(rMultiChunk.canvas, 0, 0);
    const chunkMulti = sampleBoxStats(120, 60, 200, 120);

    // ─── Test 15: GPU Normal Map TBN Perturbation (Right-tilted vs Left-tilted normal under right light) ───
    function makeNormalTex(nxByte, nyByte, nzByte) {
      const nc = document.createElement('canvas'); nc.width = 16; nc.height = 16;
      const nctx = nc.getContext('2d');
      nctx.fillStyle = \`rgb(\${nxByte},\${nyByte},\${nzByte})\`;
      nctx.fillRect(0, 0, 16, 16);
      const t = new THREE.CanvasTexture(nc);
      t.colorSpace = THREE.NoColorSpace;
      t.needsUpdate = true;
      return t;
    }
    const nmCam = new THREE.PerspectiveCamera(45, 320 / 180, 0.1, 30);
    nmCam.position.set(0, 0, 3.2); nmCam.lookAt(0, 0, 0); nmCam.updateMatrixWorld(true);
    const renderNormalQuad = async (nxByte) => {
      const sc = new THREE.Scene();
      sc.background = new THREE.Color(0x000000);
      const q = new THREE.Mesh(
        new THREE.PlaneGeometry(2.6, 2.6),
        new THREE.MeshStandardMaterial({ color: 0xdddddd, roughness: 0.9, metalness: 0.0, normalMap: makeNormalTex(nxByte, 128, 180) })
      );
      const sideSun = new THREE.DirectionalLight(0xffffff, 3.0);
      sideSun.position.set(5, 0, 1.0); // Grazing light from the RIGHT (+X)
      sc.add(q, sideSun);
      const pNm = packSceneForRust({ scene: sc, camera: nmCam, width: 320, height: 180 });
      const rNm = await ptExtra.renderFrame(pNm, { width: 320, height: 180, samples: 8, denoise: false, temporal: false, tonemap: 'linear', seed: 1 });
      ctxEx.drawImage(rNm.canvas, 0, 0);
      return sampleBoxStats(130, 65, 190, 115);
    };
    const nrmTowardLight = await renderNormalQuad(240); // +X tilted toward right sun
    const nrmAwayLight = await renderNormalQuad(15);    // -X tilted away from right sun

    // ─── Test 16: OrthographicCamera Projection on WebGPU ───
    const orthoScene = new THREE.Scene();
    orthoScene.background = new THREE.Color(0x000000);
    const oCube = new THREE.Mesh(
      new THREE.BoxGeometry(1.2, 1.2, 1.2),
      new THREE.MeshStandardMaterial({ color: 0xee3322, roughness: 0.5, metalness: 0.0 })
    );
    const oSun = new THREE.DirectionalLight(0xffffff, 2.5);
    oSun.position.set(1, 2, 4);
    orthoScene.add(oCube, oSun);
    const oCam = new THREE.OrthographicCamera(-2.0, 2.0, 1.125, -1.125, 0.1, 20);
    oCam.position.set(0, 0, 5); oCam.lookAt(0, 0, 0); oCam.updateMatrixWorld(true);
    const rOrtho = await ptExtra.renderFrame(
      packSceneForRust({ scene: orthoScene, camera: oCam, width: 320, height: 180 }),
      { width: 320, height: 180, samples: 8, denoise: false, temporal: false, tonemap: 'agx', seed: 1 }
    );
    ctxEx.drawImage(rOrtho.canvas, 0, 0);
    const orthoCenter = sampleBoxStats(145, 75, 175, 105);
    const orthoCorner = sampleBoxStats(8, 8, 36, 36);
    ptExtra.dispose();

    // ─── Test 17: Transparent Background + PNG Sequence ZIP Export via WebGPU ───
    const expPng = new VideoExportManager({
      renderer: engine.renderer, scene: orthoScene, camera: oCam,
      rasterRenderer: engine.rasterRenderer, timeline: tl, engineInstance: engine,
    });
    const pngRes = await expPng.renderVideo({
      width: 160, height: 90, fps: 24, startFrame: 0, endFrame: 1,
      format: 'png-sequence', transparent: true, engine: 'webgpu', rustSamples: 8, rustDenoise: false,
    });
    const zipEntries = unzipSync(new Uint8Array(await pngRes.blob.arrayBuffer()));
    const bmp = await createImageBitmap(new Blob([zipEntries['frame_0000.png']], { type: 'image/png' }));
    const pc = document.createElement('canvas'); pc.width = 160; pc.height = 90;
    const pctx = pc.getContext('2d', { willReadFrequently: true });
    pctx.clearRect(0, 0, 160, 90);
    pctx.drawImage(bmp, 0, 0);
    bmp.close();
    const skyPx = Array.from(pctx.getImageData(4, 4, 1, 1).data);
    const midPx = Array.from(pctx.getImageData(80, 45, 1, 1).data);

    // ─── Test 18: WebGPU InstancedMesh + MorphTarget + Mid-Session Resize + Topology Change ───
    const ptAdv = new WebGPUPathTracer();
    await ptAdv.init();
    const advScene = new THREE.Scene();
    advScene.background = new THREE.Color(0x000000);
    const instBox = new THREE.InstancedMesh(
      new THREE.BoxGeometry(0.85, 0.85, 0.85),
      new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.5 }),
      2
    );
    instBox.setMatrixAt(0, new THREE.Matrix4().makeTranslation(-1.3, 0, 0));
    instBox.setMatrixAt(1, new THREE.Matrix4().makeTranslation(1.3, 0, 0));
    instBox.setColorAt(0, new THREE.Color(1, 0.05, 0.05));
    instBox.setColorAt(1, new THREE.Color(0.05, 1, 0.05));
    instBox.instanceMatrix.needsUpdate = true;
    instBox.instanceColor.needsUpdate = true;
    const advSun = new THREE.DirectionalLight(0xffffff, 3.0);
    advSun.position.set(0, 1, 5);
    advScene.add(instBox, advSun);
    const advCam = new THREE.PerspectiveCamera(45, 16 / 9, 0.1, 30);
    advCam.position.set(0, 0, 5.0); advCam.lookAt(0, 0, 0); advCam.updateMatrixWorld(true);
    const rInst = await ptAdv.renderFrame(
      packSceneForRust({ scene: advScene, camera: advCam, width: 320, height: 180 }),
      { width: 320, height: 180, samples: 8, denoise: true, temporal: true, tonemap: 'linear', seed: 1 }
    );
    ctxEx.drawImage(rInst.canvas, 0, 0);
    const instLeft = sampleBoxStats(70, 75, 105, 105);
    const instRight = sampleBoxStats(215, 75, 250, 105);

    // Mid-session resize (320x180 -> 160x90) + topology change (add 3rd blue morphed mesh at center)
    const morphGeo = new THREE.BoxGeometry(0.9, 0.9, 0.9);
    const posArr = morphGeo.attributes.position.array;
    const deltaArr = new Float32Array(posArr.length);
    for (let i = 0; i < posArr.length; i += 3) deltaArr[i + 2] = 2.0; // shift +2 along Z when influence=1
    morphGeo.morphTargetsRelative = true;
    morphGeo.morphAttributes.position = [new THREE.Float32BufferAttribute(deltaArr, 3)];
    const morphMesh = new THREE.Mesh(morphGeo, new THREE.MeshStandardMaterial({ color: 0x2266ff, roughness: 0.5 }));
    morphMesh.position.set(0, 0, -2.0); // morphed +2 -> lands at z=0 in front of camera!
    morphMesh.morphTargetInfluences[0] = 1.0;
    advScene.add(morphMesh);
    const rResize = await ptAdv.renderFrame(
      packSceneForRust({ scene: advScene, camera: advCam, width: 160, height: 90 }),
      { width: 160, height: 90, samples: 8, denoise: true, temporal: true, tonemap: 'linear', seed: 2 }
    );
    const rc2 = document.createElement('canvas'); rc2.width = 160; rc2.height = 90;
    const rctx2 = rc2.getContext('2d', { willReadFrequently: true });
    rctx2.drawImage(rResize.canvas, 0, 0);
    const rd = rctx2.getImageData(70, 35, 20, 20).data;
    let mbR = 0, mbG = 0, mbB = 0, mbN = 0;
    for (let i = 0; i < rd.length; i += 4) { mbR += rd[i]; mbG += rd[i + 1]; mbB += rd[i + 2]; mbN++; }
    const morphCenter = { r: +(mbR / mbN).toFixed(1), g: +(mbG / mbN).toFixed(1), b: +(mbB / mbN).toFixed(1) };
    ptAdv.dispose();

    return {
      skip: false,
      adapterInfo,
      initOk,
      hasEnvCdf,
      texCount: packed.textures?.count || 0,
      matTexIds: Array.from(packed.mats).filter((_, idx) => idx % 32 === 11),
      chunksSeen,
      abortedProperly,
      checkerMinL: +cMinL.toFixed(1),
      checkerMaxL: +cMaxL.toFixed(1),
      checkerDelta: +(cMaxL - cMinL).toFixed(1),
      goldRgb: [+(gR / gN).toFixed(1), +(gG / gN).toFixed(1), +(gB / gN).toFixed(1)],
      temporalR,
      mp4: { bytes: vidRes.bytes, bvhRefits: vidRes.bvhRefits, renderMs: +vidRes.renderMs.toFixed(0), vid: vidInfo },
      webmEmissive: webmInfo,
      agxLooks: { base: lookBase, punchy: lookPunchy, low: lookLow },
      emissiveNee: { emissiveCount, floorStats: emFloorStats },
      motion: { hasPrevTris, oldLeft: mvOldLeft, midSharp: mvMidSharp, newRight: mvNewRight, midBlur: mvMidBlur },
      hdriSwap: { blue: envBlueStats, warm: envWarmStats },
      chunkParity: { single: chunkSingle, multi: chunkMulti },
      normalMap: { toward: nrmTowardLight, away: nrmAwayLight },
      ortho: { center: orthoCenter, corner: orthoCorner },
      transparentPng: { skyPx, midPx, entryCount: Object.keys(zipEntries).length },
      instMorphResize: { instLeft, instRight, morphCenter },
    };
  })()`);

  if (res.skip) {
    console.log(`SKIP: ${res.reason}`);
    process.exit(0);
  }

  assert.strictEqual(res.initOk, true, 'WebGPUPathTracer.init() must succeed');
  console.log(`ok   WebGPU high-performance adapter: ${res.adapterInfo.label} (${res.adapterInfo.tier})`);

  assert.deepStrictEqual(res.chunksSeen, [8, 16, 24, 32], `Expected 4x8 TDR-safe chunks, got ${res.chunksSeen}`);
  console.log('ok   TDR-safe chunked progressive dispatch (4×8 = 32 spp)');

  assert.strictEqual(res.abortedProperly, true, 'AbortController must cancel mid-frame between chunks');
  console.log('ok   Mid-frame AbortController cancellation between GPU chunks');

  assert.strictEqual(res.hasEnvCdf, true, 'Rust 2D HDRI Importance Sampling CDF must upload to GPU');
  console.log('ok   2D HDRI Marginal/Conditional CDF MIS active');

  assert.ok(res.checkerDelta >= 80, `Texture atlas + SVGF demod/remod contrast too low: delta=${res.checkerDelta} minL=${res.checkerMinL} maxL=${res.checkerMaxL} texCount=${res.texCount} matTexIds=${JSON.stringify(res.matTexIds)}`);
  console.log(`ok   GPU Texture Atlas + SVGF Albedo Demod/Remod preserves crisp texture (delta=${res.checkerDelta})`);

  assert.ok(res.goldRgb[0] > 60 && res.goldRgb[0] > res.goldRgb[1] && res.goldRgb[1] > res.goldRgb[2], `Rough gold Multi-Scatter GGX unexpected RGB: ${res.goldRgb}`);
  console.log(`ok   Principled BSDF v2 Multi-Scattering GGX rough gold RGB=[${res.goldRgb.join(', ')}]`);

  const drift = Math.abs(res.temporalR[4] - res.temporalR[3]);
  assert.ok(drift <= 4, `SVGF temporal drift too high: ${res.temporalR}`);
  console.log(`ok   SVGF temporal reprojection stable (${res.temporalR.join(' -> ')}, drift=${drift})`);

  assert.strictEqual(res.mp4.vid.w, 1280);
  assert.strictEqual(res.mp4.vid.h, 720);
  assert.strictEqual(res.mp4.bvhRefits, 5);
  assert.ok(res.mp4.bytes > 2000);
  assert.ok(res.mp4.vid.meanLum > 15, `Decoded MP4 frame 0 looks blank/black (meanLum=${res.mp4.vid.meanLum})`);
  console.log(`ok   720p animated MP4 decoded cleanly (${res.mp4.vid.w}×${res.mp4.vid.h}, ${res.mp4.bytes} B, lum=${res.mp4.vid.meanLum}, ${res.mp4.bvhRefits} BVH refits, ${res.mp4.renderMs} ms)`);

  // Test 8b: WebM VP9 + Emissive-only Cycles X Pixel Proof (proves VideoExportManager actually encodes gpuCanvas, not WebGL raster!)
  assert.strictEqual(res.webmEmissive.w, 320);
  assert.strictEqual(res.webmEmissive.h, 180);
  assert.ok(res.webmEmissive.bytes > 1000);
  assert.ok(
    res.webmEmissive.floorLum > 25,
    `WebGPU WebM floor is dark (lum=${res.webmEmissive.floorLum}) — video-export may have overwritten gpuCanvas with WebGL raster!`
  );
  console.log(`ok   WebGPU WebM VP9 decoded cleanly & proved real Cycles X pixels (320×180, ${res.webmEmissive.bytes} B, emissiveFloorLum=${res.webmEmissive.floorLum})`);

  // Test 9: OCIO AgX Looks
  assert.ok(
    res.agxLooks.punchy.sat > res.agxLooks.base.sat + 2 && res.agxLooks.low.lum > res.agxLooks.base.lum + 2,
    `OCIO AgX Looks mismatch: ${JSON.stringify(res.agxLooks)}`
  );
  console.log(`ok   OCIO AgX Looks verified (sat Base=${res.agxLooks.base.sat} -> Punchy=${res.agxLooks.punchy.sat}; lum Base=${res.agxLooks.base.lum} -> Low=${res.agxLooks.low.lum})`);

  // Test 10: Emissive Mesh NEE + MIS
  assert.ok(
    res.emissiveNee.emissiveCount >= 2 && res.emissiveNee.floorStats.lum > 25,
    `Emissive Mesh NEE failed: ${JSON.stringify(res.emissiveNee)}`
  );
  console.log(`ok   Emissive Mesh NEE + MIS lit floor with 0 lights/HDRI (emTris=${res.emissiveNee.emissiveCount}, floorLum=${res.emissiveNee.floorStats.lum})`);

  // Test 11: Per-Vertex Object Motion Vectors (SVGF)
  assert.strictEqual(res.motion.hasPrevTris, true, 'prevTriTex must be active after refit');
  assert.ok(
    res.motion.newRight.r > 120 && res.motion.oldLeft.r < res.motion.newRight.r - 40,
    `Per-vertex object motion reprojection failed: ${JSON.stringify(res.motion)}`
  );
  console.log(`ok   Per-Vertex Object Motion Vectors active (oldLeftR=${res.motion.oldLeft.r}, newRightR=${res.motion.newRight.r})`);

  // Test 12: Deformation / Object Motion Blur (Linear Motion BVH + Triangle Shutter Lerp)
  assert.ok(
    res.motion.midSharp.lum < 35 && res.motion.midBlur.lum > res.motion.midSharp.lum + 25,
    `Object Motion Blur failed: sharp=${JSON.stringify(res.motion.midSharp)} blur=${JSON.stringify(res.motion.midBlur)}`
  );
  console.log(`ok   Deformation / Object Motion Blur verified (midLum shutter=0: ${res.motion.midSharp.lum} -> shutter=0.9: ${res.motion.midBlur.lum})`);

  // Test 13: HDRI Swap Cache Invalidation
  assert.ok(
    res.hdriSwap.blue.b > res.hdriSwap.blue.r + 20 && res.hdriSwap.warm.r > res.hdriSwap.warm.b + 20,
    `HDRI swap cache invalidation failed: ${JSON.stringify(res.hdriSwap)}`
  );
  console.log(`ok   HDRI swap cache invalidation verified (Blue=[${res.hdriSwap.blue.r},${res.hdriSwap.blue.g},${res.hdriSwap.blue.b}] -> Warm=[${res.hdriSwap.warm.r},${res.hdriSwap.warm.g},${res.hdriSwap.warm.b}])`);

  // Test 14: Single-Chunk vs Multi-Chunk (TDR) Pixel Parity
  const chunkDiff = Math.abs(res.chunkParity.single.lum - res.chunkParity.multi.lum);
  assert.ok(chunkDiff <= 2.5, `Single-chunk vs 4-chunk normalization drift too high: ${JSON.stringify(res.chunkParity)}`);
  console.log(`ok   TDR Single-Chunk vs Multi-Chunk pixel parity (1×16 lum=${res.chunkParity.single.lum} vs 4×4 lum=${res.chunkParity.multi.lum}, Δ=${chunkDiff.toFixed(2)})`);

  // Test 15: GPU Normal Map TBN Perturbation
  assert.ok(
    res.normalMap.toward.lum > res.normalMap.away.lum + 30,
    `GPU Normal Map TBN perturbation failed: ${JSON.stringify(res.normalMap)}`
  );
  console.log(`ok   GPU Normal Map TBN perturbation verified (towardSunLum=${res.normalMap.toward.lum} vs awayLum=${res.normalMap.away.lum})`);

  // Test 16: OrthographicCamera on WebGPU
  assert.ok(
    res.ortho.center.r > 100 && res.ortho.center.r > res.ortho.center.g + 30 && res.ortho.corner.lum < 15,
    `WebGPU OrthographicCamera failed: ${JSON.stringify(res.ortho)}`
  );
  console.log(`ok   WebGPU OrthographicCamera projection verified (centerR=${res.ortho.center.r}, cornerLum=${res.ortho.corner.lum})`);

  // Test 17: Transparent Background + PNG Sequence ZIP via WebGPU
  assert.strictEqual(res.transparentPng.entryCount, 3, 'PNG ZIP must have 2 frames + render_manifest.json');
  assert.strictEqual(res.transparentPng.skyPx[3], 0, `Transparent WebGPU PNG sky alpha must be 0, got ${res.transparentPng.skyPx}`);
  assert.strictEqual(res.transparentPng.midPx[3], 255, `Transparent WebGPU PNG mesh alpha must be 255, got ${res.transparentPng.midPx}`);
  assert.ok(res.transparentPng.midPx[0] > 80, `Transparent WebGPU PNG mesh center must be lit red, got ${res.transparentPng.midPx}`);
  console.log(`ok   WebGPU Transparent PNG Sequence ZIP verified (skyRGBA=[${res.transparentPng.skyPx}], meshRGBA=[${res.transparentPng.midPx}])`);

  // Test 18: WebGPU InstancedMesh + MorphTarget + Mid-Session Resize + Topology Change
  assert.ok(
    res.instMorphResize.instLeft.r > 150 && res.instMorphResize.instLeft.r > res.instMorphResize.instLeft.g + 90 &&
    res.instMorphResize.instRight.g > 150 && res.instMorphResize.instRight.g > res.instMorphResize.instRight.r + 90,
    `WebGPU InstancedMesh colors/positions failed: ${JSON.stringify(res.instMorphResize)}`
  );
  assert.ok(
    res.instMorphResize.morphCenter.b > 150 && res.instMorphResize.morphCenter.b > res.instMorphResize.morphCenter.r + 90,
    `WebGPU mid-session resize + topology change + morph target failed: ${JSON.stringify(res.instMorphResize)}`
  );
  console.log(`ok   WebGPU InstancedMesh + MorphTarget + Resize + Topology Change verified (L.r=${res.instMorphResize.instLeft.r}, R.g=${res.instMorphResize.instRight.g}, MorphCenter.b=${res.instMorphResize.morphCenter.b})`);

  console.log('\nALL 19 WEBGPU CYCLES X GPU SUITE TESTS PASSED');
  process.exitCode = 0;
} catch (err) {
  console.error(err);
  process.exitCode = 1;
} finally {
  clearTimeout(watchdog);
  try { if (cdp) cdp.close(); } catch (_) {}
  try { chrome.kill('SIGKILL'); } catch (_) {}
  try { server.closeAllConnections?.(); server.close(); } catch (_) {}
  process.exit(process.exitCode || 0);
}
