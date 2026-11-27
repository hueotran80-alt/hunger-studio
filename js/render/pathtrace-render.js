import * as THREE from 'three';
import { buildTracingScene, cloneTracingCamera, getTracingSize } from './pathtrace-scene.js';
import { runWithRenderSubdiv } from '../core/render-subdiv.js';

export class PathTraceRenderManager {
  constructor(app) {
    this.app = app;
    this.engine = app.engine;
    this.busy = false;
    this._cancelled = false;
  }

  cancel() {
    this._cancelled = true;
  }

  async render({ samples = 64, scale = 0.5, denoise = false, onProgress = null, onPreview = null, engine: engineKind = 'gpu', threads = 0, tonemap = 'auto', adaptiveThreshold = 0 } = {}) {
    if (engineKind === 'auto') {
      if (typeof navigator !== 'undefined' && navigator.gpu) {
        try {
          const wgpuRes = await this.render({ samples, scale, denoise, onProgress, onPreview, engine: 'webgpu', threads, tonemap, adaptiveThreshold });
          if (wgpuRes) return wgpuRes;
        } catch (wgpuErr) {
          if (this._cancelled) throw wgpuErr;
          console.warn('[PathTrace] WebGPU unavailable/failed in auto mode — trying GPU/Rust:', wgpuErr?.message || wgpuErr);
        }
      }
      try {
        return await this.render({ samples, scale, denoise, onProgress, onPreview, engine: 'gpu', threads, tonemap, adaptiveThreshold });
      } catch (err) {
        const msg = String(err?.message || err);
        const recoverable = /GPU failed to compile|WebGL 2|EXT_color_buffer_float|GPU context lost|exceeds the \d+ triangles limit|Render timed out/i.test(msg);
        if (!recoverable || this._cancelled) throw err;
        onProgress?.(0, 0, 'GPU unavailable/limited — switching to Rust CPU Path Tracer…');
        const res = await this.render({ samples, scale, denoise, onProgress, onPreview, engine: 'rust', threads, tonemap, adaptiveThreshold });
        if (res) res.fallbackFrom = 'gpu';
        return res;
      }
    }
    return runWithRenderSubdiv(this.engine?.scene, async () => {
      if (engineKind === 'webgpu') return this.renderWebGPU({ samples, scale, denoise, onProgress, onPreview, tonemap, adaptiveThreshold });
      if (engineKind === 'rust') return this.renderRust({ samples, scale, denoise, onProgress, onPreview, threads, tonemap, adaptiveThreshold });
    if (this.busy) throw new Error('A render job is already running.');
    if (!Number.isInteger(samples) || samples < 1 || samples > 256) throw new Error('Samples must be an integer between 1 and 256.');
    if (typeof denoise !== 'boolean') throw new Error('Denoise must be true or false.');
    const engine = this.engine;
    if (!engine?.renderer) throw new Error('Renderer is not ready.');
    const size = engine.renderer.getSize(new THREE.Vector2());
    const { width, height } = getTracingSize(size.x, size.y, scale);
    this.busy = true;
    this._cancelled = false;
    let snapshot, renderer, tracer, generator, quad, background;
    const started = performance.now();
    const yieldToUI = () => new Promise((resolve) => setTimeout(resolve, 8));
    try {
      onProgress?.(0, 0, 'Loading path tracing engine…');
      const [{ PathTracingRenderer, PathTracingSceneGenerator, GradientEquirectTexture }, { FullScreenQuad }] = await Promise.all([
        import('three-gpu-pathtracer'), import('three/addons/postprocessing/Pass.js')
      ]);
      if (this._cancelled) return null;
      snapshot = buildTracingScene({
        scene: engine.scene, rootContainer: this.app.sceneManager?.rootContainer, lightsGroup: engine.lights?.group
      });
      if (!snapshot.meshCount) throw new Error('No visible PBR meshes found in scene to render.');
      const camera = cloneTracingCamera(engine.camera, width / height);
      await yieldToUI();
      if (this._cancelled) return null;
      renderer = new THREE.WebGLRenderer({ antialias: false, alpha: true, premultipliedAlpha: false, preserveDrawingBuffer: true });
      if (!renderer.capabilities.isWebGL2 || !renderer.extensions.has('EXT_color_buffer_float')) {
        throw new Error('GPU requires WebGL 2 and EXT_color_buffer_float for Path Tracing.');
      }
      let shaderError = false;
      renderer.debug.onShaderError = () => { shaderError = true; };
      renderer.setPixelRatio(1);
      renderer.setSize(width, height, false);
      renderer.outputColorSpace = engine.renderer.outputColorSpace;
      renderer.toneMappingExposure = engine.renderer.toneMappingExposure;
      renderer.toneMapping = THREE.NoToneMapping;
      onProgress?.(0, 0, 'Building BVH (up to 200,000 triangles)…');
      snapshot.prepareGeometry();
      if (!snapshot.meshCount) throw new Error('No visible PBR meshes found in scene to render.');
      generator = new PathTracingSceneGenerator(snapshot.scene);
      const generated = generator.generate();
      tracer = new PathTracingRenderer(renderer);
      const material = tracer.material;
      material.bounces = 5;
      material.transmissiveBounces = 5;
      material.filterGlossyFactor = 0.5;
      material.bvh.updateFrom(generated.bvh);
      const geometry = generated.geometry;
      material.attributesArray.updateFrom(geometry.attributes.normal, geometry.attributes.tangent, geometry.attributes.uv, geometry.attributes.color);
      material.materialIndexAttribute.updateFrom(geometry.attributes.materialIndex);
      material.textures.setTextures(renderer, generated.textures, 512, 512);
      material.materials.updateFrom(generated.materials, generated.textures);
      material.lights.updateFrom(generated.lights, generated.iesTextures);
      material.iesProfiles.setTextures(renderer, generated.iesTextures);
      material.environmentIntensity = snapshot.scene.environment
        ? (snapshot.scene.environmentIntensity !== undefined ? snapshot.scene.environmentIntensity : 1)
        : 0;
      if (snapshot.scene.environment) {
        material.envMapInfo.updateFrom(snapshot.scene.environment);
        if (material.environmentRotation && snapshot.scene.environmentRotation) {
          material.environmentRotation.makeRotationFromEuler(snapshot.scene.environmentRotation).invert();
        }
      }
      if (snapshot.scene.background) {
        background = new GradientEquirectTexture(16);
        background.topColor.copy(snapshot.scene.background);
        background.bottomColor.copy(snapshot.scene.background);
        background.update();
        material.backgroundMap = background;
      }
      material.backgroundAlpha = snapshot.scene.background ? 1 : 0;
      tracer.alpha = material.backgroundAlpha !== 1 || !renderer.extensions.has('EXT_float_blend');
      tracer.setCamera(camera);
      tracer.setSize(width, height);
      tracer.tiles.set(2, 2);
      while (tracer.samples < samples) {
        if (this._cancelled) return null;
        if (renderer.getContext().isContextLost()) throw new Error('GPU context lost; lower resolution and try again.');
        if (performance.now() - started > 180000) throw new Error('Render timed out after 3 minutes; reduce Samples or resolution.');
        if (!tracer.isCompiling) tracer.update();
        if (shaderError) throw new Error('GPU failed to compile Path Tracing shader.');
        onProgress?.(tracer.samples / samples, Math.floor(tracer.samples), tracer.isCompiling ? 'Compiling shader…' : null);
        await yieldToUI();
      }
      if (denoise) {
        onProgress?.(1, Math.floor(tracer.samples), 'Denoising…');
        await yieldToUI();
        if (this._cancelled) return null;
        const { createDenoiseMaterial } = await import('./pathtrace-denoise.js');
        if (this._cancelled) return null;
        quad = new FullScreenQuad(createDenoiseMaterial(tracer.target.texture));
      } else {
        quad = new FullScreenQuad(new THREE.MeshBasicMaterial({ map: tracer.target.texture, transparent: true, blending: THREE.NoBlending, depthTest: false, depthWrite: false }));
      }
      renderer.toneMapping = engine.renderer.toneMapping;
      renderer.setRenderTarget(null);
      renderer.setScissorTest(false);
      renderer.setClearColor(0, 0);
      renderer.clear();
      quad.render(renderer);
      if (shaderError) throw new Error('GPU failed to compile PNG output shader.');
      if (renderer.getContext().isContextLost()) throw new Error('GPU context lost; lower resolution and try again.');
      return {
        dataUrl: renderer.domElement.toDataURL('image/png'), width, height, samples: Math.floor(tracer.samples), denoised: denoise,
        meshCount: snapshot.meshCount, bakedSkinned: snapshot.bakedSkinned, skippedSkinned: snapshot.skippedSkinned,
        skippedMaterial: snapshot.skippedMaterial, environmentSkipped: snapshot.environmentSkipped
      };
    } finally {
      try {
        quad?.material.dispose();
        quad?.dispose();
        background?.dispose();
        tracer?.dispose();
        tracer?.material.dispose();
        generator?.geometry.dispose();
        snapshot?.dispose();
      } finally {
        // A dedicated context also releases library-owned texture-array targets on every exit path.
        renderer?.dispose();
        renderer?.forceContextLoss();
        this.busy = false;
      }
    }
    });
  }

  /** GPU compute path tracer (Cycles X algorithms in WGSL + Rust BVH). */
  async renderWebGPU({ samples = 64, scale = 0.5, denoise = true, onProgress = null, onPreview = null, tonemap = 'auto', adaptiveThreshold = 0 } = {}) {
    if (this.busy) throw new Error('A render job is already running.');
    if (!Number.isInteger(samples) || samples < 1 || samples > 4096) throw new Error('Samples must be an integer between 1 and 4096.');
    const engine = this.engine;
    if (!engine?.renderer) throw new Error('Renderer is not ready.');
    const size = engine.renderer.getSize(new THREE.Vector2());
    const { width, height } = getTracingSize(size.x, size.y, scale);
    this.busy = true;
    this._cancelled = false;
    let snapshot;
    let tracer;
    try {
      onProgress?.(0, 0, 'Initializing WebGPU Cycles X kernel…');
      const [{ packSceneForRust }, { WebGPUPathTracer }] = await Promise.all([
        import('./rust-scene-pack.js'),
        import('./webgpu-pathtracer.js'),
      ]);
      const supported = await WebGPUPathTracer.isSupported();
      if (!supported) throw new Error('Hardware WebGPU compute path tracing is unavailable.');
      tracer = new WebGPUPathTracer();
      const ok = await tracer.init();
      if (!ok) throw new Error('WebGPU device initialization failed.');

      snapshot = buildTracingScene({ scene: engine.scene, rootContainer: this.app.sceneManager?.rootContainer, lightsGroup: engine.lights?.group, maxTriangles: 2000000 });
      snapshot.prepareGeometry();
      if (!snapshot.meshCount) throw new Error('No visible PBR meshes found in scene to render.');
      const camera = cloneTracingCamera(engine.camera, width / height);
      const packed = packSceneForRust({ scene: snapshot.scene, camera, width, height });

      const ac = new AbortController();
      const poll = setInterval(() => { if (this._cancelled) ac.abort(); }, 100);
      const resolvedTonemap = tonemap && tonemap !== 'auto'
        ? tonemap
        : (engine.renderer.toneMapping === THREE.ACESFilmicToneMapping
            ? 'aces'
            : (engine.renderer.toneMapping === THREE.NoToneMapping ? 'linear' : 'agx'));
      const outCanvas = document.createElement('canvas');
      outCanvas.width = width;
      outCanvas.height = height;
      const outCtx = outCanvas.getContext('2d');
      const startedAt = performance.now();
      let res;
      try {
        res = await tracer.renderFrame(packed, {
          width,
          height,
          samples,
          denoise,
          denoisePasses: 3,
          temporal: false,
          adaptiveThreshold,
          exposure: engine.renderer.toneMappingExposure || 1,
          tonemap: resolvedTonemap,
          signal: ac.signal,
          onChunkProgress: ({ samplesDone, samplesTarget }) => {
            onProgress?.(samplesTarget > 0 ? samplesDone / samplesTarget : 0, samplesDone, null);
          },
        });
      } catch (err) {
        if (err?.name === 'AbortError' || this._cancelled) return null;
        throw err;
      } finally {
        clearInterval(poll);
      }
      if (!res || this._cancelled) return null;
      if (denoise) {
        onProgress?.(1, samples, 'Denoising…');
        if (this._cancelled) return null;
      }
      outCtx.drawImage(res.canvas, 0, 0);
      return {
        dataUrl: outCanvas.toDataURL('image/png'),
        width,
        height,
        samples,
        denoised: denoise,
        engine: 'webgpu',
        ms: performance.now() - startedAt,
        meshCount: snapshot.meshCount,
        triangleCount: packed.triCount,
        bakedSkinned: snapshot.bakedSkinned,
        skippedSkinned: snapshot.skippedSkinned,
        skippedMaterial: snapshot.skippedMaterial,
        environmentSkipped: snapshot.environmentSkipped,
      };
    } finally {
      tracer?.dispose();
      snapshot?.dispose();
      this.busy = false;
    }
  }

  /** CPU path tracer written in Rust (WASM), tiled over Web Workers. No triangle cap, no GPU needed. */
  async renderRust({ samples = 64, scale = 0.5, denoise = true, onProgress = null, onPreview = null, threads = 0, tonemap = 'auto', adaptiveThreshold = 0 } = {}) {
    if (this.busy) throw new Error('A render job is already running.');
    if (!Number.isInteger(samples) || samples < 1 || samples > 4096) throw new Error('Samples must be an integer between 1 and 4096.');
    const engine = this.engine;
    if (!engine?.renderer) throw new Error('Renderer is not ready.');
    const size = engine.renderer.getSize(new THREE.Vector2());
    const { width, height } = getTracingSize(size.x, size.y, scale);
    this.busy = true;
    this._cancelled = false;
    let snapshot;
    try {
      onProgress?.(0, 0, 'Packing scene for Rust kernel…');
      const [{ packSceneForRust }, { renderRust }] = await Promise.all([import('./rust-scene-pack.js'), import('./rust-render-bridge.js')]);
      snapshot = buildTracingScene({ scene: engine.scene, rootContainer: this.app.sceneManager?.rootContainer, lightsGroup: engine.lights?.group, maxTriangles: 2000000 });
      snapshot.prepareGeometry();
      if (!snapshot.meshCount) throw new Error('No visible PBR meshes found in scene to render.');
      const camera = cloneTracingCamera(engine.camera, width / height);
      const packed = packSceneForRust({ scene: snapshot.scene, camera, width, height });
      const ac = new AbortController();
      const poll = setInterval(() => { if (this._cancelled) ac.abort(); }, 100);
      const resolvedTonemap = tonemap && tonemap !== 'auto'
        ? tonemap
        : (engine.renderer.toneMapping === THREE.ACESFilmicToneMapping ? 'aces' : (engine.renderer.toneMapping === THREE.NoToneMapping ? 'linear' : 'agx'));
      const previewCanvas = onPreview ? document.createElement('canvas') : null;
      if (previewCanvas) { previewCanvas.width = width; previewCanvas.height = height; }
      let result;
      try {
        result = await renderRust(packed, {
          width, height, samples, denoise, threads, adaptiveThreshold, signal: ac.signal,
          exposure: engine.renderer.toneMappingExposure || 1,
          tonemap: resolvedTonemap,
          onProgress: (ratio, done) => onProgress?.(ratio, done, null),
          onPreview: onPreview ? ({ rgba }) => {
            previewCanvas.getContext('2d').putImageData(new ImageData(rgba, width, height), 0, 0);
            onPreview(previewCanvas.toDataURL('image/png'));
          } : null
        });
      } finally { clearInterval(poll); }
      if (!result) return null;
      const canvas = document.createElement('canvas');
      canvas.width = width; canvas.height = height;
      canvas.getContext('2d').putImageData(new ImageData(result.rgba, width, height), 0, 0);
      return { dataUrl: canvas.toDataURL('image/png'), width, height, samples, denoised: denoise, engine: 'rust', ms: result.ms, meshCount: snapshot.meshCount, triangleCount: packed.triCount, bakedSkinned: snapshot.bakedSkinned, skippedSkinned: snapshot.skippedSkinned, skippedMaterial: snapshot.skippedMaterial, environmentSkipped: snapshot.environmentSkipped };
    } finally {
      snapshot?.dispose();
      this.busy = false;
    }
  }

  bindUI() {
    document.getElementById('btn-render-pathtrace')?.addEventListener('click', () => this.openDialog());
  }

  openDialog() {
    if (this._backdrop) {
      this._backdrop.hidden = false;
      this._backdrop.querySelector('#pt-start').focus();
      return;
    }
    const backdrop = document.createElement('div');
    backdrop.className = 'ss-backdrop pt-backdrop';
    backdrop.style.cssText = 'position:fixed;inset:0;z-index:100060;background:rgba(0,0,0,.65);padding:16px;box-sizing:border-box;overflow:auto;';
    backdrop.innerHTML = `
      <style>.pt-backdrop:not([hidden]) { display:grid;place-items:center; }.pt-backdrop[hidden] { display:none!important; }</style>
      <div role="dialog" aria-modal="true" aria-labelledby="pt-title" style="background:#1b1b1b;border:1px solid #3d3d3d;border-radius:10px;padding:18px 20px;width:420px;max-width:92vw;max-height:90vh;overflow:auto;color:#e6e6e6;font:13px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;">
        <div id="pt-title" style="font-weight:600;font-size:14px;margin-bottom:10px;">Path Tracing — Render PNG</div>
        <div style="display:flex;gap:12px;flex-wrap:wrap;align-items:center;margin-bottom:10px;">
          <label>Engine <select id="pt-engine" style="background:#2a2a2a;color:#fff;border:1px solid #444;padding:3px 6px;"><option value="auto" selected>Auto (WebGPU / GPU → Rust fallback)</option><option value="webgpu">WebGPU (Cycles X Compute)</option><option value="gpu">GPU (three-gpu-pathtracer)</option><option value="rust">Rust CPU (WASM, Multi-threaded)</option></select></label>
          <label>Samples <select id="pt-samples" style="background:#2a2a2a;color:#fff;border:1px solid #444;padding:3px 6px;">
            <option value="32" selected>32 (fast)</option><option value="64">64</option><option value="128">128</option><option value="256">256</option>
          </select></label>
          <label>Resolution <select id="pt-scale" style="background:#2a2a2a;color:#fff;border:1px solid #444;padding:3px 6px;">
            <option value="0.5" selected>0.5×</option><option value="1">1×</option><option value="2">2×</option>
          </select></label>
          <label>CPU Threads <select id="pt-threads" style="background:#2a2a2a;color:#fff;border:1px solid #444;padding:3px 6px;">
            <option value="0" selected>Auto</option><option value="1">1</option><option value="2">2</option><option value="4">4</option><option value="8">8</option>
          </select></label>
          <label>Tone Map <select id="pt-tonemap" style="background:#2a2a2a;color:#fff;border:1px solid #444;padding:3px 6px;">
            <option value="auto" selected>Match Viewport</option><option value="agx">AgX</option><option value="aces">ACES</option><option value="neutral">Khronos Neutral</option><option value="linear">Linear</option>
          </select></label>
        </div>
        <label style="display:block;margin-bottom:10px;"><input id="pt-denoise" type="checkbox"> Denoise (edge-preserving bilateral filter)</label>
        <div id="pt-status" role="status" style="color:#b0b6bd;margin-bottom:8px;">PBR still render from current camera and pose; pause timeline to pick a frame. Max 2 MP / 200,000 triangles (GPU) · UV0 textures only. Denoising may soften fine detail.</div>
        <div style="background:#2a2a2a;height:6px;margin-bottom:12px;"><div id="pt-progress" style="background:#00d2d3;height:6px;width:0%;"></div></div>
        <img id="pt-preview" alt="Path tracing result" style="display:none;width:100%;max-height:35vh;object-fit:contain;border:1px solid #3d3d3d;margin-bottom:10px;" />
        <div style="display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end;">
          <button id="pt-cancel" disabled>Cancel Render</button>
          <button id="pt-download" hidden>Download PNG</button>
          <button id="pt-start">Render</button>
          <button id="pt-close">Close</button>
        </div>
      </div>`;
    document.body.appendChild(backdrop);
    this._backdrop = backdrop;
    const status = backdrop.querySelector('#pt-status');
    const progress = backdrop.querySelector('#pt-progress');
    const preview = backdrop.querySelector('#pt-preview');
    const startBtn = backdrop.querySelector('#pt-start');
    const cancelBtn = backdrop.querySelector('#pt-cancel');
    const downloadBtn = backdrop.querySelector('#pt-download');
    const denoiseInput = backdrop.querySelector('#pt-denoise');
    const close = () => {
      if (this.busy) { this.cancel(); status.textContent = 'Cancelling…'; this._closeWhenDone = true; }
      else { backdrop.hidden = true; document.getElementById('btn-render-pathtrace')?.focus(); }
    };
    backdrop.querySelector('#pt-close').addEventListener('click', close);
    backdrop.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
      if (event.key === 'Tab') {
        const buttons = [...backdrop.querySelectorAll('select, input, button')].filter((el) => !el.disabled && !el.hidden);
        const first = buttons[0], last = buttons[buttons.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    });
    cancelBtn.addEventListener('click', () => { this.cancel(); status.textContent = 'Cancelling…'; });
    downloadBtn.addEventListener('click', () => {
      const link = document.createElement('a');
      link.href = preview.src;
      link.download = `pathtrace_${Date.now()}.png`;
      link.click();
    });
    startBtn.addEventListener('click', async () => {
      this._closeWhenDone = false;
      startBtn.disabled = true;
      cancelBtn.disabled = false;
      backdrop.querySelector('#pt-samples').disabled = true;
      backdrop.querySelector('#pt-scale').disabled = true;
      backdrop.querySelector('#pt-engine').disabled = true;
      backdrop.querySelector('#pt-threads').disabled = true;
      backdrop.querySelector('#pt-tonemap').disabled = true;
      denoiseInput.disabled = true;
      downloadBtn.hidden = true;
      preview.style.display = 'none';
      progress.style.width = '0%';
      const startedAt = performance.now();
      try {
        const result = await this.render({
          samples: Number(backdrop.querySelector('#pt-samples').value),
          scale: Number(backdrop.querySelector('#pt-scale').value),
          denoise: denoiseInput.checked,
          engine: backdrop.querySelector('#pt-engine')?.value || 'gpu',
          threads: Number(backdrop.querySelector('#pt-threads')?.value || 0),
          tonemap: backdrop.querySelector('#pt-tonemap')?.value || 'auto',
          onPreview: (dataUrl) => {
            preview.src = dataUrl;
            preview.style.display = 'block';
          },
          onProgress: (ratio, done, phase) => {
            progress.style.width = `${Math.round(ratio * 100)}%`;
            if (this._cancelled) { status.textContent = 'Cancelling…'; return; }
            if (phase) { status.textContent = phase; return; }
            const elapsed = (performance.now() - startedAt) / 1000;
            const eta = ratio > 0.05 ? Math.max(0, elapsed * (1 / ratio - 1)) : 0;
            status.textContent = `Sampling ${done}… (${elapsed.toFixed(1)}s` + (eta > 0.5 ? ` · ETA ~${eta.toFixed(0)}s)` : ')');
          }
        });
        if (!result) status.textContent = 'Render cancelled.';
        else {
          preview.src = result.dataUrl;
          preview.style.display = 'block';
          downloadBtn.hidden = false;
          progress.style.width = '100%';
          const sec = result.ms ? ` · ${(result.ms / 1000).toFixed(2)}s` : '';
          status.textContent = `Done: ${result.width}×${result.height} · ${result.samples} samples · ${result.meshCount} mesh` + sec +
            (result.fallbackFrom ? ` · ${result.fallbackFrom.toUpperCase()}→Rust fallback` : '') +
            (result.denoised ? ' · denoised' : '') +
            (result.bakedSkinned ? ` · ${result.bakedSkinned} skinned mesh (current pose)` : '') +
            (result.skippedSkinned ? ` · skipped ${result.skippedSkinned} unrigged skinned mesh` : '') +
            (result.skippedMaterial ? ` · skipped ${result.skippedMaterial} non-PBR mesh` : '') +
            (result.environmentSkipped ? ' · without viewport HDR/PMREM' : '');
        }
      } catch (error) { status.textContent = `Error: ${error.message}`; }
      finally {
        startBtn.disabled = false;
        cancelBtn.disabled = true;
        backdrop.querySelector('#pt-samples').disabled = false;
        backdrop.querySelector('#pt-scale').disabled = false;
        backdrop.querySelector('#pt-engine').disabled = false;
        backdrop.querySelector('#pt-threads').disabled = false;
        backdrop.querySelector('#pt-tonemap').disabled = false;
        denoiseInput.disabled = false;
        if (this._closeWhenDone) { backdrop.hidden = true; document.getElementById('btn-render-pathtrace')?.focus(); }
      }
    });
    startBtn.focus();
  }
}
