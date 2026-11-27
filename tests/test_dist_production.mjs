#!/usr/bin/env node
/**
 * Production Build (`dist/`) End-to-End Verification Gate
 * File: tests/test_dist_production.mjs
 *
 * Verifies that the Vite-bundled `dist/` artifact actually boots and executes
 * every critical subsystem in a real headless browser (catching bundler path,
 * worker chunk, WASM asset, import-map stripping, and COOP/COEP regressions):
 *   1. Asset Ship Policy check (dist/ exists, <= 25 MB per file)
 *   2. Zero HTTP 4xx/5xx static asset errors, zero COEP blocks, zero uncaught exceptions
 *   3. Studio core boot + dynamic WebSocket Bridge (`server.py --dist`)
 *   4. Bundled Geometry Web Worker (`bvh`, `csg`, `modifierStack`)
 *   5. Bundled WASM Kernels (EditMode MeshKernel, Rapier Physics, Video MP4 Export)
 *   6. Binary `.glb` export + `.wbs` ZIP project round-trip
 *   7. Live Share / Embed 3D `<iframe>` preview (same-origin COEP + cross-origin non-COEP)
 */

import assert from 'node:assert';
import { execSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findChromeBinary() {
  const candidates = [
    process.env.CHROME_BIN,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
  ].filter(Boolean);
  return candidates.find((b) => fs.existsSync(b)) || null;
}

function findPythonBinary() {
  const venvPy = path.join(ROOT, '.venv', 'bin', 'python');
  return fs.existsSync(venvPy) ? venvPy : 'python3';
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

async function waitHttp(url, retries = 60) {
  for (let i = 0; i < retries; i++) {
    try {
      const r = await fetch(url);
      if (r.ok || r.status < 500) return r;
    } catch (_) {}
    await sleep(300);
  }
  throw new Error(`Timeout waiting for ${url}`);
}

if (process.argv.includes('--build') || !fs.existsSync(path.join(DIST, 'index.html'))) {
  console.log('[dist-gate] Building production bundle (`npm run build`)...');
  execSync('npm run build', { cwd: ROOT, stdio: 'inherit' });
}

let passed = 0;
async function check(name, fn) {
  try {
    const detail = await fn();
    passed++;
    console.log(`ok   ${name}${detail ? ` — ${detail}` : ''}`);
  } catch (err) {
    console.error(`FAIL ${name}\n     ${err?.stack || err}`);
    cleanup();
    process.exit(1);
  }
}

// 1. Verify dist/ structure & 25 MB per-file host limit
let distFiles = [];
function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else distFiles.push({ path: p, size: fs.statSync(p).size });
  }
}
walk(DIST);

await check('dist/ artifact exists and obeys 25 MB per-file host budget', () => {
  assert.ok(fs.existsSync(path.join(DIST, 'index.html')), 'dist/index.html missing');
  assert.ok(fs.existsSync(path.join(DIST, 'embed.html')), 'dist/embed.html missing');
  assert.ok(fs.existsSync(path.join(DIST, 'motion.html')), 'dist/motion.html missing');
  for (const legalDoc of ['LICENSE', 'PRIVACY.md', 'TERMS.md', 'THIRD_PARTY_LICENSES.md']) {
    assert.ok(fs.existsSync(path.join(DIST, legalDoc)), `dist/${legalDoc} missing`);
  }
  const over25M = distFiles.filter((f) => f.size > 25 * 1024 * 1024);
  assert.strictEqual(over25M.length, 0, `Files > 25 MB: ${over25M.map((f) => f.path).join(', ')}`);
  const totalMB = (distFiles.reduce((s, f) => s + f.size, 0) / (1024 * 1024)).toFixed(1);
  return `${totalMB} MB across ${distFiles.length} files (0 files > 25 MB)`;
});

const chromeBin = findChromeBinary();
if (!chromeBin) {
  console.error('ERROR: Chrome binary not found for dist/ browser verification.');
  process.exit(2);
}

const httpPort = await getFreePort();
const wsPort = await getFreePort();
const extPort = await getFreePort();
const cdpPort = await getFreePort();
const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wbs-dist-gate-'));

const srv = spawn(
  findPythonBinary(),
  ['server.py', '--dist', '--port', String(httpPort), '--ws-port', String(wsPort)],
  { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] }
);

const extSrv = http.createServer((_req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><script>
    window.__EXT_EMBED__ = null;
    window.addEventListener('message', (e) => {
      if (e.data && e.data.type === 'studio-embed' && e.data.event === 'ready') window.__EXT_EMBED__ = e.data;
    });
  </script><iframe src="http://127.0.0.1:${httpPort}/embed.html?glb=/models/Mannequin_CC0.glb&autoplay=1"></iframe>`);
});
await new Promise((r) => extSrv.listen(extPort, 'localhost', r));

const chrome = spawn(chromeBin, [
  '--headless=new',
  `--remote-debugging-port=${cdpPort}`,
  `--user-data-dir=${profileDir}`,
  '--no-first-run',
  '--no-default-browser-check',
  '--enable-unsafe-swiftshader',
  '--use-angle=metal',
  '--enable-gpu',
  '--ignore-gpu-blocklist',
  '--autoplay-policy=no-user-gesture-required',
  '--window-size=1440,900',
  'about:blank',
], { stdio: 'ignore' });

let cleaned = false;
function cleanup() {
  if (cleaned) return;
  cleaned = true;
  try { chrome.kill('SIGKILL'); } catch (_) {}
  try { srv.kill('SIGKILL'); } catch (_) {}
  try { extSrv.close(); } catch (_) {}
  try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch (_) {}
}
process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(130); });
process.on('SIGTERM', () => { cleanup(); process.exit(143); });

await waitHttp(`http://127.0.0.1:${httpPort}/api/status`);
await waitHttp(`http://127.0.0.1:${cdpPort}/json/version`);

async function openCdpTab(url) {
  const t = await (await fetch(`http://127.0.0.1:${cdpPort}/json/new?about:blank`, { method: 'PUT' })).json();
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0;
  const pending = new Map();
  const httpErrors = [];
  const blocked = [];
  const exceptions = [];

  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m);
      pending.delete(m.id);
      return;
    }
    if (m.method === 'Page.javascriptDialogOpening') {
      ws.send(JSON.stringify({ id: ++id, method: 'Page.handleJavaScriptDialog', params: { accept: true } }));
      return;
    }
    if (m.method === 'Network.responseReceived' && m.params.response.status >= 400) {
      const u = m.params.response.url;
      if (!u.endsWith('/favicon.ico')) httpErrors.push(`${m.params.response.status} ${u}`);
    }
    if (m.method === 'Network.loadingFailed' && m.params.blockedReason) {
      blocked.push(m.params.blockedReason);
    }
    if (m.method === 'Runtime.exceptionThrown') {
      exceptions.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
    }
  };
  const call = (method, params = {}) => new Promise((r) => {
    const i = ++id;
    pending.set(i, r);
    ws.send(JSON.stringify({ id: i, method, params }));
  });
  const evalJs = async (expression) => {
    const res = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, timeout: 45000 });
    if (res.result?.exceptionDetails) {
      throw new Error(res.result.exceptionDetails.exception?.description || res.result.exceptionDetails.text);
    }
    return res.result?.result?.value;
  };
  await call('Runtime.enable');
  await call('Network.enable');
  await call('Page.enable');
  await call('Page.navigate', { url });
  return { t, ws, evalJs, httpErrors, blocked, exceptions };
}

const studioTab = await openCdpTab(`http://127.0.0.1:${httpPort}/`);

await check('dist/ index.html boots Studio + WebSocket bridge with 0 HTTP/COEP/JS errors', async () => {
  for (let i = 0; i < 40; i++) {
    const ready = await studioTab.evalJs(
      'Boolean(window.app && window.sceneManager && window.studio && window.studioBridge?.ws?.readyState === 1)'
    );
    if (ready) break;
    await sleep(250);
  }
  const state = await studioTab.evalJs(`({
    app: Boolean(window.app),
    wsOpen: window.studioBridge?.ws?.readyState === 1,
    wsPort: window.studioBridge?.port,
    crossOriginIsolated: window.crossOriginIsolated,
    simReadyOnEmptyBoot: Boolean(window.simulationManager?.ready),
    rapierFetchedOnBoot: performance.getEntriesByType('resource').some((r) => /rapier/i.test(r.name)),
    hasFilmRoot: Boolean(window.scene?.getObjectByName?.('FILM_ROOT')),
  })`);
  assert.strictEqual(state.app, true, 'window.app missing');
  assert.strictEqual(state.wsOpen, true, 'WebSocket bridge not OPEN');
  assert.strictEqual(state.wsPort, wsPort, `Expected wsPort ${wsPort}, got ${state.wsPort}`);
  assert.strictEqual(state.crossOriginIsolated, true, 'crossOriginIsolated must be true for SharedArrayBuffer');
  assert.strictEqual(state.simReadyOnEmptyBoot, false, 'Rapier simulation must stay lazy until requested');
  assert.strictEqual(state.rapierFetchedOnEmptyBoot ?? state.rapierFetchedOnBoot, false, 'rapier chunk must not load on default empty boot');
  assert.strictEqual(state.hasFilmRoot, false, 'FILM_ROOT must not exist after deleting film-project module');
  assert.deepStrictEqual(studioTab.httpErrors, [], `HTTP errors: ${studioTab.httpErrors.join(', ')}`);
  assert.deepStrictEqual(studioTab.blocked, [], `Blocked requests: ${studioTab.blocked.join(', ')}`);
  assert.deepStrictEqual(studioTab.exceptions, [], `Uncaught exceptions: ${studioTab.exceptions.join(', ')}`);
  return `crossOriginIsolated=true, WS=127.0.0.1:${wsPort} OPEN`;
});

const geomWorkerAsset = fs.readdirSync(path.join(DIST, 'assets'))
  .find((f) => f.startsWith('geometry-worker-') && !f.startsWith('geometry-worker-client-') && f.endsWith('.js'));

await check('dist/ Geometry Web Worker executes BVH, CSG Boolean & Modifier Stack cleanly', async () => {
  assert.ok(geomWorkerAsset, 'geometry-worker-*.js chunk missing in dist/assets/');
  const res = await studioTab.evalJs(`(async () => {
    const w = new Worker('/assets/${geomWorkerAsset}', { type: 'module' });
    const ask = (msg) => new Promise((resolve) => {
      const id = Math.floor(Math.random() * 1e9);
      const fn = (e) => { if (e.data?.id === id && !e.data.progress) { w.removeEventListener('message', fn); resolve(e.data); } };
      w.addEventListener('message', fn);
      w.postMessage({ ...msg, id });
    });
    const cube = new Float32Array([
      -1,-1, 1,  1,-1, 1,  1, 1, 1,  -1,-1, 1,  1, 1, 1, -1, 1, 1,
      -1,-1,-1, -1, 1,-1,  1, 1,-1,  -1,-1,-1,  1, 1,-1,  1,-1,-1,
      -1, 1,-1, -1, 1, 1,  1, 1, 1,  -1, 1,-1,  1, 1, 1,  1, 1,-1,
      -1,-1,-1,  1,-1,-1,  1,-1, 1,  -1,-1,-1,  1,-1, 1, -1,-1, 1,
       1,-1,-1,  1, 1,-1,  1, 1, 1,   1,-1,-1,  1, 1, 1,  1,-1, 1,
      -1,-1,-1, -1,-1, 1, -1, 1, 1,  -1,-1,-1, -1, 1, 1, -1, 1,-1,
    ]);
    const idMat = [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1];
    const shiftMat = [1,0,0,0, 0,1,0,0, 0,0,1,0, 0.5,0,0,1];
    const bvh = await ask({ type: 'bvh', position: cube.slice() });
    const csg = await ask({ type: 'csg', op: 'union', a: { position: cube.slice() }, matrixA: idMat, b: { position: cube.slice() }, matrixB: shiftMat });
    const mod = await ask({
      type: 'modifierStack',
      geometry: { position: cube.slice() },
      descriptors: [
        { type: 'bevel', enabled: true, params: { amount: 0.1, segments: 2 } },
        { type: 'subdivision', enabled: true, params: { levels: 1 } },
        { type: 'solidify', enabled: true, params: { thickness: 0.05 } },
      ],
    });
    w.terminate();
    return {
      bvhOk: bvh.ok,
      csgOk: csg.ok, csgVerts: (csg.out?.position?.length || 0) / 3,
      modOk: mod.ok, modVerts: (mod.out?.position?.length || 0) / 3,
    };
  })()`);
  assert.strictEqual(res.bvhOk, true, 'BVH worker failed');
  assert.strictEqual(res.csgOk, true, 'CSG worker failed');
  assert.ok(res.csgVerts > 36, 'CSG vertices invalid');
  assert.strictEqual(res.modOk, true, 'ModifierStack worker failed');
  assert.ok(res.modVerts > 500, 'ModifierStack vertices invalid');
  return `BVH ok · CSG ${res.csgVerts}v · ModifierStack ${res.modVerts}v`;
});

await check('dist/ EditMode WASM MeshKernel, Rapier Physics, GLB & .wbs ZIP round-trip', async () => {
  const res = await studioTab.evalJs(`(async () => {
    const cube = window.studio.addCube({ name: 'ProdGateCube' });
    cube.position.set(0, 3, 0);
    cube.updateMatrixWorld(true);
    window.sceneManager.setSelection([cube]);
    window.editMode.enter(cube);
    window.editMode.exit();

    await window.simulationManager.init();
    window.simulationManager.setConfig(cube, { body: 'dynamic' });
    window.simulationManager.stepFrames(15);
    const fellUnderGravity = cube.position.y < 2.95;

    const glb = await window.exporter.exportGLTF(window.sceneManager.rootContainer, { binary: true, download: false });
    const wbs = await window.exporter.exportProjectPackage({ download: false });
    const wbsBytes = wbs?.blob?.size || wbs?.bytes?.byteLength || 0;
    const fileObj = new File([wbs.blob], 'gate.wbs', { type: 'application/octet-stream' });
    await window.exporter.importProjectJSON(fileObj);
    const restored = window.sceneManager.findObjectByName?.('ProdGateCube')
      || [...(window.sceneManager.objects?.values?.() || [])].find(o => o.name === 'ProdGateCube');
    return {
      fellUnderGravity,
      glbBytes: glb?.blob?.size || glb?.byteLength || 0,
      wbsBytes,
      restored: Boolean(restored),
    };
  })()`);
  assert.strictEqual(res.fellUnderGravity, true, 'Rapier physics did not step dynamic cube under gravity');
  assert.ok(res.glbBytes > 500, `GLB export too small: ${res.glbBytes}`);
  assert.ok(res.wbsBytes > 200, `.wbs export too small: ${res.wbsBytes}`);
  assert.strictEqual(res.restored, true, 'ProdGateCube missing after .wbs round-trip');
  return `Rapier gravity OK · GLB ${res.glbBytes} B · .wbs ${res.wbsBytes} B round-trip OK`;
});

await check('dist/ Video MP4 export (Rust Video Kernel WASM + WebCodecs + mp4-muxer)', async () => {
  const res = await studioTab.evalJs(`(async () => {
    const out = await window.studio.renderVideo({
      width: 320, height: 180, fps: 15, startFrame: 1, endFrame: 4, format: 'mp4', download: false,
    });
    return { size: out?.blob?.size || out?.size || 0, type: out?.blob?.type || out?.mimeType || '' };
  })()`);
  assert.ok(res.size > 500, `MP4 export empty: ${res.size}`);
  return `MP4 ${res.size} B (${res.type || 'video/mp4'})`;
});

await check('dist/ Share / Embed 3D preview works in COEP Studio AND external cross-origin site', async () => {
  const sameOriginOk = await studioTab.evalJs(`(async () => {
    const dlg = await window.app._ensureShareDialog();
    dlg.open();
    let ok = false;
    for (let i = 0; i < 60; i++) {
      const f = document.querySelector('#ss-preview iframe');
      if (f?.contentWindow?.studioEmbed?.ready) { ok = true; break; }
      await new Promise(r => setTimeout(r, 200));
    }
    dlg.close();
    return ok;
  })()`);
  assert.strictEqual(sameOriginOk, true, 'Same-origin COEP ShareDialog preview failed to boot');
  assert.deepStrictEqual(studioTab.blocked, [], `COEP/CSP blocked: ${studioTab.blocked.join(', ')}`);

  const extTab = await openCdpTab(`http://localhost:${extPort}/`);
  let extState = null;
  for (let i = 0; i < 50; i++) {
    extState = await extTab.evalJs('window.__EXT_EMBED__');
    if (extState) break;
    await sleep(250);
  }
  extTab.ws.close();
  assert.ok(extState && Array.isArray(extState.clips) && extState.clips.includes('IdleDance'), 'Cross-origin embed failed');
  assert.deepStrictEqual(extTab.blocked, [], `Cross-origin blocked: ${extTab.blocked.join(', ')}`);
  return `Studio preview READY + cross-origin localhost embed READY (${extState.clips.join(', ')})`;
});

await check('dist/ agent.exec() CSP Worker & studio.loadHumanWithAnimation() CC0 character work cleanly', async () => {
  const res = await studioTab.evalJs(`(async () => {
    const execOk = await window.agent.exec('return 1 + 2 + 3;');
    let execBlockedRes = null;
    let execRejected = false;
    try {
      execBlockedRes = await window.agent.exec('return await fetch("/api/status");');
    } catch (e) {
      execRejected = true;
    }
    const model = await window.studio.loadHumanWithAnimation({
      character: 'bot',
      animation: 'walk',
      name: 'DistGateBot',
      x: 1,
      y: 0,
      z: 0,
      showBones: false
    });
    const clips = Array.isArray(model?.animations) ? model.animations.map((c) => c.name) : [];
    return {
      execOk: execOk?.ok ? execOk.value : null,
      netBlocked: execRejected || (execBlockedRes?.ok === false && execBlockedRes?.error?.code === 'E_PERMISSION'),
      botLoaded: Boolean(model),
      clips
    };
  })()`);
  assert.strictEqual(res.execOk, 6, `agent.exec math failed: ${JSON.stringify(res.execOk)}`);
  assert.strictEqual(res.netBlocked, true, 'agent.exec fetch() must be blocked by strict worker CSP');
  assert.strictEqual(res.botLoaded, true, 'studio.loadHumanWithAnimation bot failed in dist/');
  assert.ok(res.clips.includes('Walk'), `Expected Walk clip on Bot_CC0, got ${res.clips.join(',')}`);
  assert.deepStrictEqual(studioTab.httpErrors, [], `HTTP errors after loadHumanWithAnimation: ${studioTab.httpErrors.join(', ')}`);
  return `agent.exec()=6 (fetch blocked) · Bot_CC0 loaded [${res.clips.join(', ')}]`;
});

await check('dist/ AI Copilot + AgentToolBridge (<think> strip, Stop) & STEM Tutor (Live quiet, pause/resume, cancel race)', async () => {
  const res = await studioTab.evalJs(`(async () => {
    const f = String.fromCharCode(96).repeat(3);
    const tool = window.AgentToolBridge.extractToolCall('<think>planning step</think>\\n' + f + 'json\\n{"tool":"scene.tree","args":[{}]}\\n' + f);
    const parsedCopilot = window.aiCopilot._parseLLMResponse('<think>secret chain</think>\\nXong!\\n' + f + 'javascript\\nstudio.addCube({ name: "ParsedBox" });\\n' + f);

    // Verify Stop aborts clean without fallback crash
    const ac = new AbortController();
    window.aiCopilot._activeAbortController = ac;
    window.aiCopilot.stopGeneration();
    const stopAborted = Boolean(window.aiCopilot._userAborted && ac.signal.aborted);
    window.aiCopilot._userAborted = false;
    window.aiCopilot._activeAbortController = null;

    // Verify STEM Live toggle/pause state cleanly without speaking immediately on toggle
    const tutor = window.stemTutor;
    tutor.setVoiceEnabled(true);
    tutor.voice.stop();
    const spokenBefore = tutor.voice.lastSpokenText;
    // Simulate active direct voice session
    const fakeRec = { start() {}, abort() {}, stop() {} };
    tutor.voiceSession.recognitionFactory = () => fakeRec;
    tutor.voiceSession.recognition = null;
    tutor.toggleLiveVoice();
    const spokeOnOpenMic = tutor.voice.isSpeaking;
    tutor.toggleVoicePause();
    const pausedMic = Boolean(tutor.voiceSession.isPaused);
    tutor.toggleVoicePause();
    const resumedMic = !tutor.voiceSession.isPaused;
    tutor.voiceCoordinator.stopAll();

    // Verify stale askAICoach cancellation when startLesson supersedes it
    const origFetch = window.fetch;
    window.fetch = async (url, opts) => {
      if (String(url).includes('/api/ai/chat')) {
        await new Promise((_, reject) => {
          opts?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('Aborted'), { name: 'AbortError' })));
        });
      }
      return origFetch(url, opts);
    };
    const stalePromise = tutor.askAICoach('Hướng dẫn tạo cầu thang', { speak: false });
    tutor.startLesson('lesson-02-materials-lights', { loadStarter: true, speak: false, guided: false });
    const staleRes = await stalePromise;
    window.fetch = origFetch;

    // Verify Pause / Resume walkthrough preserves bubble text
    tutor.startLesson('lesson-01-primitives', { loadStarter: false, speak: false, guided: true, autoAdvance: true });
    const beforePauseText = tutor.currentBubbleText;
    tutor.pauseWalkthrough();
    const afterPauseText = tutor.currentBubbleText;
    const isPausedWalk = !tutor.isAutoWalking && Boolean(tutor._pausedState);
    tutor.resumeWalkthrough({ speak: false });
    const isResumedWalk = Boolean(tutor.isAutoWalking);
    tutor.stopWalkthrough({ stopVoice: true });

    return {
      toolName: tool?.tool,
      copilotExp: parsedCopilot?.explanation,
      copilotHasCode: /studio\.addCube/.test(parsedCopilot?.code || ''),
      stopAborted,
      spokeOnOpenMic,
      pausedMic,
      resumedMic,
      staleCancelled: Boolean(staleRes?.cancelled),
      activeLessonId: tutor.activeLesson?.id,
      preservedText: beforePauseText === afterPauseText && beforePauseText.length > 0,
      isPausedWalk,
      isResumedWalk,
      spokenUnchanged: spokenBefore === tutor.voice.lastSpokenText || !spokeOnOpenMic
    };
  })()`);
  assert.strictEqual(res.toolName, 'scene.tree', `extractToolCall failed: ${res.toolName}`);
  assert.strictEqual(res.copilotExp, 'Xong!', `Copilot <think> strip failed: ${res.copilotExp}`);
  assert.strictEqual(res.copilotHasCode, true, 'Copilot code fence extraction failed');
  assert.strictEqual(res.stopAborted, true, 'stopGeneration did not abort active controller');
  assert.strictEqual(res.spokeOnOpenMic, false, 'toggleLiveVoice must not speak immediately on mic open');
  assert.strictEqual(res.pausedMic, true, 'toggleVoicePause did not pause voice session');
  assert.strictEqual(res.resumedMic, true, 'toggleVoicePause did not resume voice session');
  assert.strictEqual(res.staleCancelled, true, 'superseded askAICoach did not cancel cleanly');
  assert.strictEqual(res.activeLessonId, 'lesson-01-primitives', 'lesson switching failed');
  assert.strictEqual(res.preservedText, true, 'pauseWalkthrough altered/wiped guide text');
  assert.strictEqual(res.isPausedWalk, true, 'pauseWalkthrough state incorrect');
  assert.strictEqual(res.isResumedWalk, true, 'resumeWalkthrough did not restart walkthrough');
  return 'Copilot <think>/Stop + STEM Live quiet/pause/resume + stale cancellation OK';
});

await check('dist/ Copilot scene.add -> SceneManager/Outliner sync, empty digest & safe scene.clear()', async () => {
  const res = await studioTab.evalJs(`(async () => {
    const cop = window.aiCopilot;
    const sm = window.sceneManager;
    cop.settings.humanConstructionMode = false;
    sm.clearScene();
    const emptyDigest = cop._describeLiveScene();

    const okAdd = await cop.executeGeneratedCode('const box = new THREE.Mesh(new THREE.BoxGeometry(1,1,1), new THREE.MeshStandardMaterial({ color: 0xff2200 })); box.name = "DistSyncBox"; scene.add(box);');
    const countAfterAdd = sm.objects.size;
    const outlinerHasBox = document.getElementById('outliner-tree-root')?.textContent?.includes('DistSyncBox') || false;
    const digestAfterAdd = cop._describeLiveScene();

    const okClear = await cop.executeGeneratedCode('scene.clear();');
    const countAfterClear = sm.objects.size;
    const rootStillAttached = Boolean(sm.rootContainer && sm.rootContainer.parent === window.scene);
    const outlinerCleared = !(document.getElementById('outliner-tree-root')?.textContent?.includes('DistSyncBox'));
    return { okAdd, countAfterAdd, outlinerHasBox, hasBoxInDigest: digestAfterAdd.includes('DistSyncBox'), emptyIsEmpty: emptyDigest.includes('EMPTY'), okClear, countAfterClear, rootStillAttached, outlinerCleared };
  })()`);
  assert.strictEqual(res.emptyIsEmpty, true, 'Empty scene digest still polluted with system objects');
  assert.strictEqual(res.okAdd, true, 'executeGeneratedCode scene.add failed');
  assert.strictEqual(res.countAfterAdd, 1, `scene.add mesh not registered in SceneManager (size=${res.countAfterAdd})`);
  assert.strictEqual(res.outlinerHasBox, true, 'scene.add mesh missing from Outliner DOM');
  assert.strictEqual(res.hasBoxInDigest, true, 'scene.add mesh missing from _describeLiveScene');
  assert.strictEqual(res.okClear, true, 'executeGeneratedCode scene.clear failed');
  assert.strictEqual(res.countAfterClear, 0, 'scene.clear did not clear SceneManager objects');
  assert.strictEqual(res.rootStillAttached, true, 'scene.clear detached rootContainer from engine scene');
  assert.strictEqual(res.outlinerCleared, true, 'Outliner did not refresh after scene.clear');
  return 'scene.add -> Outliner/SceneManager synced · scene.clear() safe';
});

studioTab.ws.close();
cleanup();

console.log(`\nALL ${passed}/${passed} PRODUCTION DIST GATE CHECKS PASSED`);
process.exit(0);
