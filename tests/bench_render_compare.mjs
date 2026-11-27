/**
 * Headless Chrome real-browser benchmark comparing:
 *   - Raster Look-Dev (WebGL2 + PostProcessing)
 *   - GPU Path Tracer (three-gpu-pathtracer)
 *   - Rust CPU WASM Path Tracer (1, 4, auto=8 Web Workers)
 *   - Video Export (Raster vs Rust cached pool + BVH refit + temporal reprojection)
 * Outputs JSON + formatted table and saves comparison PNGs to BENCH_OUT_DIR.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const PORT = 8941;
const CDP_PORT = 9361;
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const OUT_DIR = process.env.BENCH_OUT_DIR || '/Users/trantuan/.gemini/antigravity/brain/8f9003f6-2715-4b6c-9584-d48c893a3125/scratch/bench';
fs.mkdirSync(OUT_DIR, { recursive: true });

class CdpClient {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.id = 0;
    this.pending = new Map();
    this.ready = new Promise((res, rej) => {
      this.ws.onopen = res;
      this.ws.onerror = rej;
    });
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
  async call(method, params = {}) {
    await this.ready;
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async evalAsync(expr) {
    const r = await this.call('Runtime.evaluate', {
      expression: `(async () => { ${expr} })()`,
      awaitPromise: true,
      returnByValue: true
    });
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text || 'JS eval error');
    }
    return r.result?.value;
  }
  close() { try { this.ws.close(); } catch (_) {} }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForJson(url, timeoutMs = 15000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try {
      const r = await fetch(url);
      if (r.ok) return await r.json();
    } catch (_) {}
    await sleep(250);
  }
  throw new Error(`Timeout waiting for ${url}`);
}

const PY = fs.existsSync('.venv/bin/python') ? '.venv/bin/python' : 'python3';
const srv = spawn(PY, ['server.py', '--port', String(PORT)], { stdio: 'ignore' });
// Wait until server.py is actually listening before launching Chrome.
let srvReady = false;
for (let i = 0; i < 40; i++) {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/index.html`);
    if (r.ok) { srvReady = true; break; }
  } catch (_) {}
  await sleep(150);
}
if (!srvReady) throw new Error('server.py failed to start');
const userDir = `/tmp/chrome_bench_${CDP_PORT}`;
fs.rmSync(userDir, { recursive: true, force: true });
const chrome = spawn(CHROME, [
  '--headless=new',
  '--use-gl=angle',
  '--enable-webgl',
  '--ignore-gpu-blocklist',
  '--no-sandbox',
  `--remote-debugging-port=${CDP_PORT}`,
  '--window-size=1280,800',
  `--user-data-dir=${userDir}`,
  `http://127.0.0.1:${PORT}/index.html`
], { stdio: 'ignore' });

let cdp = null;
try {
  const targets = await waitForJson(`http://127.0.0.1:${CDP_PORT}/json`);
  const page = targets.find((t) => t.type === 'page' && t.url.includes('127.0.0.1')) || targets.find((t) => t.type === 'page') || targets[0];
  if (!page?.webSocketDebuggerUrl) throw new Error('No CDP page target found');
  cdp = new CdpClient(page.webSocketDebuggerUrl);
  cdp.ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      console.error('[Browser console.error]', msg.params.args.map((a) => a.value || a.description).join(' '));
    }
  });
  await cdp.call('Runtime.enable');
  await cdp.call('Page.enable');

  // Wait for Studio initialization (retrying while execution context attaches)
  let ready = false;
  for (let i = 0; i < 60; i++) {
    try {
      ready = await cdp.evalAsync(`return Boolean(window.app?.pathTraceRender && window.app?.engine?.renderer);`);
      if (ready) break;
    } catch (_) {}
    await sleep(250);
  }
  if (!ready) throw new Error('Studio did not initialize');

  const envInfo = await cdp.evalAsync(`
    const gl = window.app.engine.renderer.getContext();
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    return {
      cores: navigator.hardwareConcurrency,
      webgl2: window.app.engine.renderer.capabilities.isWebGL2,
      floatExt: !!gl.getExtension('EXT_color_buffer_float'),
      glRenderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
      glVendor: dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR),
      hasWebCodecs: typeof VideoEncoder !== 'undefined' && typeof VideoFrame !== 'undefined'
    };
  `);
  console.log('Browser Environment:', JSON.stringify(envInfo));

  // Helper injected in page to set up benchmark scenes cleanly
  const results = await cdp.evalAsync(`
    const THREE = await import('/vendor/three/three.module.js');
    const { packSceneForRust } = await import('/js/render/rust-scene-pack.js');
    const { renderRust } = await import('/js/render/rust-render-bridge.js');
    const { VideoExportManager } = await import('/js/render/video-export.js');
    const app = window.app;
    const engine = app.engine;
    const pt = app.pathTraceRender;
    const out = { env: ${JSON.stringify(envInfo)}, stills: [], video: [] };

    const root = app.sceneManager?.rootContainer || engine.scene;
    const lightsGrp = engine.lights?.group || engine.scene;

    function clearUserMeshes() {
      const hidden = [];
      for (const parent of [root, lightsGrp]) {
        parent.children.forEach((c) => {
          if (c.visible && !c.isCamera && !c.userData?.__bench) {
            hidden.push(c);
            c.visible = false;
          }
        });
      }
      return () => {
        hidden.forEach((c) => { c.visible = true; });
      };
    }

    function addCornell(container, segU = 48, segV = 24, withTex = false) {
      const room = new THREE.Mesh(new THREE.BoxGeometry(6, 4, 6), new THREE.MeshStandardMaterial({ color: 0xcccccc, roughness: 0.9, side: THREE.BackSide }));
      room.position.y = 2;
      const left = new THREE.Mesh(new THREE.PlaneGeometry(4, 6), new THREE.MeshStandardMaterial({ color: 0xcc2222, roughness: 0.9 }));
      left.position.set(-2.98, 2, 0); left.rotation.y = Math.PI / 2;
      const right = new THREE.Mesh(new THREE.PlaneGeometry(4, 6), new THREE.MeshStandardMaterial({ color: 0x22aa33, roughness: 0.9 }));
      right.position.set(2.98, 2, 0); right.rotation.y = -Math.PI / 2;

      let floorMat = new THREE.MeshStandardMaterial({ color: 0xcccccc, roughness: 0.7 });
      if (withTex) {
        const c = document.createElement('canvas'); c.width = 256; c.height = 256;
        const ctx = c.getContext('2d');
        for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
          ctx.fillStyle = (x + y) % 2 ? '#e0dcd4' : '#3a4a5e';
          ctx.fillRect(x * 32, y * 32, 32, 32);
        }
        const tex = new THREE.CanvasTexture(c);
        floorMat = new THREE.MeshStandardMaterial({ color: 0xffffff, map: tex, roughness: 0.55 });
      }
      const floor = new THREE.Mesh(new THREE.PlaneGeometry(5.9, 5.9), floorMat);
      floor.rotation.x = -Math.PI / 2; floor.position.y = 0.01;

      const metal = new THREE.Mesh(new THREE.SphereGeometry(0.8, segU, segV), new THREE.MeshStandardMaterial({ color: 0xffd27f, metalness: 1, roughness: 0.18 }));
      metal.position.set(-1.1, 0.8, -0.5);
      const glass = new THREE.Mesh(new THREE.SphereGeometry(0.8, segU, segV), new THREE.MeshPhysicalMaterial({ color: 0xffffff, transmission: 1, roughness: 0.02, ior: 1.5 }));
      glass.position.set(1.1, 0.8, 0.3);
      const lamp = new THREE.Mesh(new THREE.PlaneGeometry(1.6, 1.6), new THREE.MeshStandardMaterial({ color: 0x000000, emissive: 0xffffff, emissiveIntensity: 12 }));
      lamp.position.set(0, 3.98, 0); lamp.rotation.x = Math.PI / 2;
      const key = new THREE.PointLight(0xfff0dd, 28, 0); key.position.set(0, 3.5, 0.5);
      container.add(room, floor, left, right, metal, glass, lamp, key);
      return { metal, glass };
    }

    const restore = clearUserMeshes();
    const benchGroup = new THREE.Group();
    benchGroup.userData.__bench = true;
    root.add(benchGroup);
    engine.scene.background = new THREE.Color(0.02, 0.02, 0.025);
    engine.scene.environment = null;
    engine.scene.userData.rawEnvironmentSource = null;

    // ─── SCENE 1: Cornell Box (4,622 tris, 256x192, 32 spp) ───
    addCornell(benchGroup, 48, 24, false);
    engine.camera.fov = 70;
    engine.camera.position.set(0, 2, 2.9);
    engine.camera.lookAt(0, 1.4, 0);
    engine.camera.updateProjectionMatrix();
    engine.camera.updateMatrixWorld(true);
    engine.renderer.setSize(512, 384, false);

    // Raster baseline
    {
      const rt = new THREE.WebGLRenderTarget(256, 192);
      const t0 = performance.now();
      engine.rasterRenderer.renderFrame({ scene: engine.scene, camera: engine.camera, target: rt, hideHelpers: true });
      const buf = new Uint8Array(256 * 192 * 4);
      engine.renderer.readRenderTargetPixels(rt, 0, 0, 256, 192, buf);
      const ms = performance.now() - t0;
      rt.dispose();
      out.stills.push({ scene: 'Cornell 4.6k tris', res: '256x192', spp: 1, engine: 'Raster (WebGL2)', ms: Math.round(ms * 10) / 10, ok: true });
    }

    // Rust CPU WASM (1, 4, auto workers)
    for (const [label, threads, denoise] of [
      ['Rust WASM (1 thread, denoise)', 1, true],
      ['Rust WASM (4 threads, denoise)', 4, true],
      ['Rust WASM (auto threads, no denoise)', 0, false],
      ['Rust WASM (auto threads, denoise)', 0, true],
    ]) {
      const t0 = performance.now();
      try {
        const r = await pt.renderRust({ samples: 32, scale: 0.5, denoise, threads });
        const ms = performance.now() - t0;
        out.stills.push({
          scene: 'Cornell 4.6k tris', res: r.width + 'x' + r.height, spp: 32,
          engine: label, ms: Math.round(ms), kernelMs: r.ms, tris: r.triangleCount, ok: true,
          dataUrl: label.includes('auto threads, denoise') ? r.dataUrl : undefined
        });
      } catch (e) {
        out.stills.push({ scene: 'Cornell 4.6k tris', res: '256x192', spp: 32, engine: label, ms: Math.round(performance.now() - t0), ok: false, error: e.message });
      }
    }

    // ─── SCENE 2: Textured PBR (~19.6k tris, 512x384, 32 spp) — Rust first ───
    benchGroup.clear();
    addCornell(benchGroup, 96, 51, true);
    {
      const t0 = performance.now();
      try {
        const r = await pt.renderRust({ samples: 32, scale: 1.0, denoise: true, threads: 0 });
        out.stills.push({ scene: 'Textured Cornell ~19.6k tris', res: r.width + 'x' + r.height, spp: 32, engine: 'Rust WASM auto (512x384, tex, denoise)', ms: Math.round(performance.now() - t0), kernelMs: r.ms, ok: true, dataUrl: r.dataUrl });
      } catch (e) {
        out.stills.push({ scene: 'Textured Cornell ~19.6k tris', res: '512x384', spp: 32, engine: 'Rust WASM auto (512x384, tex, denoise)', ms: Math.round(performance.now() - t0), ok: false, error: e.message });
      }
    }

    // ─── SCENE 3: High-Poly Stress (>220k tris, 256x192, 16 spp) — Rust ───
    benchGroup.clear();
    addCornell(benchGroup, 360, 155, false); // ~223k tris total!
    {
      const t0 = performance.now();
      try {
        const r = await pt.renderRust({ samples: 16, scale: 0.5, denoise: true, threads: 0 });
        out.stills.push({ scene: 'High-Poly >220k tris', res: r.width + 'x' + r.height, spp: 16, engine: 'Rust WASM auto (>220k tris)', ms: Math.round(performance.now() - t0), kernelMs: r.ms, tris: r.triangleCount, ok: true });
      } catch (e) {
        out.stills.push({ scene: 'High-Poly >220k tris', res: '256x192', spp: 16, engine: 'Rust WASM auto (>220k tris)', ms: Math.round(performance.now() - t0), ok: false, error: e.message });
      }
    }

    // ─── SCENE 4: Video Animation (6 frames, 320x240, 16 spp) ───
    benchGroup.clear();
    const { metal } = addCornell(benchGroup, 48, 24, false);
    const fakeTimeline = {
      fps: 30, startFrame: 0, endFrame: 5, currentFrame: 0, isPlaying: false,
      pause() {},
      seekToFrame(f) {
        this.currentFrame = f;
        metal.position.x = -1.1 + f * 0.14;
        metal.updateMatrixWorld(true);
      }
    };
    const exporter = new VideoExportManager({
      renderer: engine.renderer,
      scene: engine.scene,
      camera: engine.camera,
      rasterRenderer: engine.rasterRenderer,
      timeline: fakeTimeline
    });

    if (out.env.hasWebCodecs) {
      const t0 = performance.now();
      try {
        const vRaster = await exporter.renderVideo({ width: 320, height: 240, fps: 30, startFrame: 0, endFrame: 5, postProcess: false });
        out.video.push({ mode: 'Raster WebGL2 -> WebCodecs MP4', frames: 6, res: '320x240', ms: Math.round(performance.now() - t0), bytes: vRaster.blob.size, ok: true });
      } catch (e) {
        out.video.push({ mode: 'Raster WebGL2 -> WebCodecs MP4', frames: 6, res: '320x240', ms: Math.round(performance.now() - t0), ok: false, error: e.message });
      }

      const t1 = performance.now();
      try {
        const vRust = await exporter.renderVideo({ width: 320, height: 240, fps: 30, startFrame: 0, endFrame: 5, engine: 'rust', rustSamples: 16, rustDenoise: true, rustTemporal: true });
        out.video.push({ mode: 'Rust WASM (Pool+Refit+Temporal) -> MP4', frames: 6, res: '320x240', ms: Math.round(performance.now() - t1), bytes: vRust.blob.size, ok: true });
      } catch (e) {
        out.video.push({ mode: 'Rust WASM (Pool+Refit+Temporal) -> MP4', frames: 6, res: '320x240', ms: Math.round(performance.now() - t1), ok: false, error: e.message });
      }
    }

    // ─── GPU Path Tracer (denoise:true only — MeshBasicMaterial FloatType read fails on ANGLE Metal when denoise:false) ───
    // Note: pathtrace-render.js calls forceContextLoss() in finally, so we run Scene 1 & Scene 2 on separate fresh page loads if needed.
    benchGroup.clear();
    addCornell(benchGroup, 48, 24, false);
    {
      const t0 = performance.now();
      try {
        const r = await pt.render({ engine: 'gpu', samples: 32, scale: 0.5, denoise: true });
        out.stills.push({ scene: 'Cornell 4.6k tris', res: r.width + 'x' + r.height, spp: 32, engine: 'GPU PT (denoise)', ms: Math.round(performance.now() - t0), ok: true, dataUrl: r.dataUrl });
      } catch (e) {
        out.stills.push({ scene: 'Cornell 4.6k tris', res: '256x192', spp: 32, engine: 'GPU PT (denoise)', ms: Math.round(performance.now() - t0), ok: false, error: e.message });
      }
    }
    benchGroup.clear();
    addCornell(benchGroup, 360, 155, false);
    {
      const t0 = performance.now();
      try {
        const r = await pt.render({ engine: 'gpu', samples: 16, scale: 0.5, denoise: true });
        out.stills.push({ scene: 'High-Poly >220k tris', res: r.width + 'x' + r.height, spp: 16, engine: 'GPU PT (>200k tris cap)', ms: Math.round(performance.now() - t0), ok: true });
      } catch (e) {
        out.stills.push({ scene: 'High-Poly >220k tris', res: '256x192', spp: 16, engine: 'GPU PT (>200k tris cap)', ms: Math.round(performance.now() - t0), ok: false, error: e.message });
      }
    }

    restore();
    benchGroup.parent?.remove(benchGroup);
    return out;
  `);

  for (const s of results.stills) {
    if (s.dataUrl) {
      const b64 = s.dataUrl.split(',')[1];
      const fname = s.engine.replace(/[^a-z0-9]+/gi, '_').toLowerCase() + '.png';
      const fpath = path.join(OUT_DIR, fname);
      fs.writeFileSync(fpath, Buffer.from(b64, 'base64'));
      s.savedPng = fpath;
      delete s.dataUrl;
    }
  }
  const reportPath = path.join(OUT_DIR, 'report.json');
  fs.writeFileSync(reportPath, JSON.stringify(results, null, 2));
  console.log('\n=== BENCHMARK RESULTS SAVED TO ' + reportPath + ' ===');
  console.log(JSON.stringify(results, null, 2));
} catch (err) {
  console.error('BENCHMARK ERROR:', err);
  process.exitCode = 1;
} finally {
  cdp?.close();
  try { chrome.kill('SIGKILL'); } catch (_) {}
  try { srv.kill('SIGKILL'); } catch (_) {}
  await sleep(300);
  try { fs.rmSync(userDir, { recursive: true, force: true }); } catch (_) {}
}
