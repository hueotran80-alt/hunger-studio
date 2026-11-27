#!/usr/bin/env node
/**
 * Official Headless Browser & GPU Test Suite Runner (CDP)
 * File: tests/run_browser_suites.mjs
 *
 * Runs all 14 browser/WebGL/WASM/WebCodecs HTML test suites (`tests/*-suite.html`)
 * in headless Chrome with isolated HTTP + WebSocket ports and strict zero-defect gates:
 *   - 0 failed test assertions
 *   - 0 suite timeouts
 *   - 0 COEP/CORP/CSP blocked network requests
 *   - 0 uncaught runtime exceptions
 *
 * Usage:
 *   node tests/run_browser_suites.mjs              # Run all 14 suites
 *   node tests/run_browser_suites.mjs embed mocap  # Run selected suites
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ALL_SUITES = [
  'asset',
  'character',
  'cloud',
  'embed',
  'geometry-worker',
  'render',
  'video-export',
  'webcodecs',
  'pathtrace',
  'browser',
  'interaction',
  'mocap',
  'chaos-ui',
  'lod-instancing',
];

const SUITE_TIMEOUT_MS = Number(process.env.SUITE_TIMEOUT_SEC || 240) * 1000;
const PATHTRACE_TIMEOUT_MS = Number(process.env.PATHTRACE_TIMEOUT_SEC || Math.max(240, Number(process.env.SUITE_TIMEOUT_SEC || 240))) * 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findChromeBinary() {
  const candidates = [
    process.env.CHROME_BIN,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].filter(Boolean);
  for (const bin of candidates) {
    if (fs.existsSync(bin)) return bin;
  }
  return null;
}

function findPythonBinary() {
  const venvPy = path.join(ROOT, '.venv', 'bin', 'python');
  if (fs.existsSync(venvPy)) return venvPy;
  return 'python3';
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
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

function buildProbeExpr(suite) {
  return `(() => {
    const s = document.getElementById('summary');
    const st = s ? s.textContent.trim() : null;
    let done = false;
    let passed = null, failed = null, total = null, fails = [];
    const collectArr = (arr) => {
      if (!Array.isArray(arr)) return;
      total = arr.length;
      passed = arr.filter(x => x && (x.ok === true || x.pass === true || x.status === 'pass')).length;
      const fl = arr.filter(x => x && (x.ok === false || x.pass === false || x.status === 'fail'));
      failed = fl.length;
      fails = fl.map(x => (x.name || x.title || '') + ' :: ' + String(x.detail || x.error || x.message || '').slice(0, 240));
    };
    const suiteName = ${JSON.stringify(suite)};
    if (suiteName === 'asset' && window.__ASSET_SUITE_RESULTS__) {
      done = true;
      collectArr(window.__ASSET_SUITE_RESULTS__.items);
      passed = window.__ASSET_SUITE_RESULTS__.passed;
      failed = window.__ASSET_SUITE_RESULTS__.failed;
    } else if (suiteName === 'browser' && window.__SUITE_RESULTS__) {
      done = true;
      collectArr(window.__SUITE_RESULTS__.results);
    } else if (suiteName === 'character' && window.__CHARACTER_SUITE_RESULTS__) {
      done = true;
      collectArr(window.__CHARACTER_SUITE_RESULTS__.items);
      passed = window.__CHARACTER_SUITE_RESULTS__.passed;
      failed = window.__CHARACTER_SUITE_RESULTS__.failed;
    } else if (suiteName === 'cloud' && Array.isArray(window.__CLOUD_SUITE_RESULTS__)) {
      const arr = window.__CLOUD_SUITE_RESULTS__;
      if (st && !/Đang chạy/i.test(st) && arr.length >= 2 && arr.every(x => x.status !== 'running')) {
        done = true;
        collectArr(arr);
      }
    } else if (suiteName === 'embed' && Array.isArray(window.__EMBED_SUITE_RESULTS__)) {
      const stageTxt = document.getElementById('stage')?.textContent || '';
      if (stageTxt.includes('Suite finished')) {
        done = true;
        collectArr(window.__EMBED_SUITE_RESULTS__);
      }
    } else if (suiteName === 'geometry-worker' && window.__GEOMETRY_WORKER_DONE__) {
      done = true;
      collectArr(window.__GEOMETRY_WORKER_RESULTS__);
    } else if (suiteName === 'interaction' && window.__INTERACTION_DONE__) {
      done = true;
      collectArr(window.__INTERACTION_RESULTS__);
    } else if (suiteName === 'mocap' && window.__MOCAP_SUITE_RESULTS__) {
      done = true;
      if (window.__MOCAP_SUITE_RESULTS__.error) {
        failed = 1;
        fails = ['Boot error :: ' + window.__MOCAP_SUITE_RESULTS__.error];
      } else {
        collectArr(window.__MOCAP_SUITE_RESULTS__.results);
      }
    } else if (suiteName === 'pathtrace' && Array.isArray(window.__PATH_TRACE_RESULTS__)) {
      collectArr(window.__PATH_TRACE_RESULTS__);
      if (window.__PATH_TRACE_DONE__ === true || (st && !/Đang chạy/i.test(st))) {
        done = true;
      }
    } else if (suiteName === 'render' && Array.isArray(window.__RENDER_SUITE_RESULTS__)) {
      const arr = window.__RENDER_SUITE_RESULTS__;
      if (st && st.includes('/5 pass')) {
        done = true;
        collectArr(arr);
      }
    } else if (suiteName === 'video-export' && Array.isArray(window.__VIDEO_EXPORT_RESULTS__)) {
      const arr = window.__VIDEO_EXPORT_RESULTS__;
      if (st && st.includes('/5 pass')) {
        done = true;
        collectArr(arr);
      }
    } else if (suiteName === 'webcodecs' && window.__WEBCODECS_SUITE_RESULTS__) {
      done = true;
      collectArr(window.__WEBCODECS_SUITE_RESULTS__.results);
    } else if (suiteName === 'chaos-ui' && window.__CHAOS_UI_SUITE_RESULTS__) {
      done = true;
      collectArr(window.__CHAOS_UI_SUITE_RESULTS__.items);
      passed = window.__CHAOS_UI_SUITE_RESULTS__.passed;
      failed = window.__CHAOS_UI_SUITE_RESULTS__.failed;
    } else if (suiteName === 'lod-instancing' && window.__LOD_INSTANCING_SUITE_RESULTS__) {
      done = true;
      collectArr(window.__LOD_INSTANCING_SUITE_RESULTS__.items);
      passed = window.__LOD_INSTANCING_SUITE_RESULTS__.passed;
      failed = window.__LOD_INSTANCING_SUITE_RESULTS__.failed;
    }
    return { done, summary: st, passed, failed, total, fails, step: window.__PATH_TRACE_STEP__ || null };
  })()`;
}

const requested = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const suites = requested.length ? requested : ALL_SUITES;
for (const s of suites) {
  if (!ALL_SUITES.includes(s)) {
    console.error(`Unknown browser suite "${s}". Available: ${ALL_SUITES.join(', ')}`);
    process.exit(2);
  }
}

const chromeBin = findChromeBinary();
if (!chromeBin) {
  console.error('SKIP/ERROR: Chrome/Chromium binary not found. Set CHROME_BIN to run browser suites.');
  process.exit(2);
}

const httpPort = await getFreePort();
const wsPort = await getFreePort();
const cdpPort = await getFreePort();
const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wbs-browser-suites-'));
const cloudDataDir = path.join(profileDir, 'cloud_data');
const cloudConfigPath = path.join(profileDir, 'cloud_config.json');
fs.mkdirSync(cloudDataDir, { recursive: true });
fs.writeFileSync(cloudConfigPath, JSON.stringify({
  provider: 'local',
  data_dir: cloudDataDir,
  allow_dev_login: true,
  allow_test_billing: true,
  session_secret: 'wbs-browser-suite-ephemeral-local-secret-0123456789abcdef',
  free_credits: 100,
  sepay: {
    bank: 'MB',
    account: '0123456789',
    holder: 'STUDIO TEST',
    webhook_secret: 'wbs-suite-sepay-secret'
  }
}), { encoding: 'utf8', mode: 0o600 });

const srv = spawn(findPythonBinary(), ['server.py', '--port', String(httpPort), '--ws-port', String(wsPort)], {
  cwd: ROOT,
  env: {
    ...process.env,
    CLOUD_CONFIG: cloudConfigPath,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

const isMac = process.platform === 'darwin';
const chromeGpuArgs = isMac
  ? ['--enable-unsafe-swiftshader', '--use-angle=metal', '--enable-gpu']
  : ['--no-sandbox', '--disable-dev-shm-usage', '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader'];

const chrome = spawn(chromeBin, [
  '--headless=new',
  `--remote-debugging-port=${cdpPort}`,
  `--user-data-dir=${profileDir}`,
  '--no-first-run',
  '--no-default-browser-check',
  ...chromeGpuArgs,
  '--ignore-gpu-blocklist',
  '--autoplay-policy=no-user-gesture-required',
  '--window-size=1600,1000',
  'about:blank',
], { stdio: 'ignore' });

let cleaned = false;
function cleanup() {
  if (cleaned) return;
  cleaned = true;
  try { chrome.kill('SIGKILL'); } catch (_) {}
  try { srv.kill('SIGKILL'); } catch (_) {}
  try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch (_) {}
}
process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(130); });
process.on('SIGTERM', () => { cleanup(); process.exit(143); });

await waitHttp(`http://127.0.0.1:${httpPort}/api/status`);
await waitHttp(`http://127.0.0.1:${cdpPort}/json/version`);

console.log(`Browser Test Harness online: http=127.0.0.1:${httpPort} ws=127.0.0.1:${wsPort} cdp=127.0.0.1:${cdpPort}`);

async function runSingleSuite(name) {
  const target = await (await fetch(`http://127.0.0.1:${cdpPort}/json/new?about:blank`, { method: 'PUT' })).json();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

  let msgId = 0;
  const pending = new Map();
  const blockedRequests = [];
  const uncaughtExceptions = [];

  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m);
      pending.delete(m.id);
      return;
    }
    if (m.method === 'Page.javascriptDialogOpening') {
      ws.send(JSON.stringify({ id: ++msgId, method: 'Page.handleJavaScriptDialog', params: { accept: true } }));
      return;
    }
    if (m.method === 'Network.loadingFailed' && m.params.blockedReason) {
      blockedRequests.push(`${m.params.blockedReason} (${m.params.type || 'unknown'})`);
    }
    if (m.method === 'Runtime.exceptionThrown') {
      const desc = m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text || 'Exception';
      uncaughtExceptions.push(desc.slice(0, 260));
    }
    if (m.method === 'Runtime.consoleAPICalled' && name === 'pathtrace') {
      const line = (m.params.args || []).map((a) => a.value ?? a.description ?? '').join(' ');
      if (line.startsWith('[pathtrace]')) {
        console.log(`       ${line}`);
      }
    }
  };

  const call = (method, params = {}) => new Promise((resolve) => {
    const i = ++msgId;
    pending.set(i, resolve);
    ws.send(JSON.stringify({ id: i, method, params }));
  });
  const evalJs = async (expression) => (
    await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, timeout: 20000 })
  ).result?.result?.value;

  await call('Runtime.enable');
  await call('Network.enable');
  await call('Page.enable');

  const startedAt = Date.now();
  const suiteTimeoutMs = name === 'pathtrace' ? PATHTRACE_TIMEOUT_MS : SUITE_TIMEOUT_MS;
  await call('Page.navigate', { url: `http://127.0.0.1:${httpPort}/tests/${name}-suite.html` });
  const probeExpr = buildProbeExpr(name);

  let state = null;
  while (Date.now() - startedAt < suiteTimeoutMs) {
    await sleep(1200);
    try {
      const next = await evalJs(probeExpr);
      if (next && typeof next === 'object') state = next;
    } catch (err) {
      if (!state) state = { evalError: String(err) };
    }
    if (state && state.done) break;
  }

  ws.close();
  await fetch(`http://127.0.0.1:${cdpPort}/json/close/${target.id}`).catch(() => {});

  const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1);
  const timedOut = !(state && state.done);
  const summaryText = String(state?.summary || '');
  const hasUnexpectedSkip = /\bSKIP\s*\(\d+\)/i.test(summaryText);
  const ok = !timedOut && !hasUnexpectedSkip && (state.failed === 0) && blockedRequests.length === 0 && uncaughtExceptions.length === 0;
  return {
    suite: name,
    ok,
    timedOut,
    elapsedSec,
    passed: state?.passed ?? 0,
    failed: state?.failed ?? (timedOut ? 1 : 0),
    total: state?.total ?? 0,
    summary: state?.summary ?? null,
    step: state?.step ?? null,
    fails: state?.fails ?? [],
    blockedRequests: [...new Set(blockedRequests)],
    uncaughtExceptions: [...new Set(uncaughtExceptions)],
  };
}

let anyFailure = false;
let totalAssertionsPassed = 0;
const summaryRows = [];

for (const s of suites) {
  const res = await runSingleSuite(s);
  summaryRows.push(res);
  totalAssertionsPassed += Number(res.passed || 0);
  const badge = res.ok ? 'PASS' : 'FAIL';
  const stepInfo = !res.ok && res.step ? ` [lastStep: ${res.step}]` : '';
  console.log(
    `[${badge}] ${s.padEnd(16)} ${String(res.passed).padStart(2)}/${String(res.total).padEnd(2)} (${res.elapsedSec}s) — ${res.summary || 'TIMEOUT'}${stepInfo}`
  );
  if (!res.ok) {
    anyFailure = true;
    for (const f of res.fails) console.error(`       ✖ ${f}`);
    for (const b of res.blockedRequests) console.error(`       ✖ BLOCKED: ${b}`);
    for (const ex of res.uncaughtExceptions) console.error(`       ✖ UNCAUGHT: ${ex}`);
  }
}

cleanup();

if (anyFailure) {
  console.error(`\nBROWSER SUITES FAILED (${summaryRows.filter((r) => !r.ok).length}/${summaryRows.length} suites failed)`);
  process.exit(1);
}
console.log(`\nALL ${summaryRows.length}/${summaryRows.length} BROWSER SUITES PASSED (${totalAssertionsPassed} browser checks verified, 0 blocked, 0 uncaught)`);
process.exit(0);
