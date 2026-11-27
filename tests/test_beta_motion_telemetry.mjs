/**
 * Hunger Motion Beta Gate — Telemetry, Sentry Envelope, Motion Templates, CDN Resolver,
 * Export Cancel, Community Category Alignment & Cloudflare Staging Route Verification.
 * File: tests/test_beta_motion_telemetry.mjs
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from '../vendor/three/three.module.js';
import {
  HungerTelemetry,
  buildSentryEventPayload,
  sanitizeTelemetryString,
} from '../js/core/telemetry.js';
import {
  listMotionTemplates,
  getMotionTemplate,
  resolveTemplateFromSearch,
} from '../js/animation/motion-templates.js';
import {
  resolveCdnAssetUrl,
  setCdnBaseUrl,
  isCdnEligiblePath,
} from '../js/core/asset-cdn.js';
import { StudioExporter } from '../js/exporters/export-import.js';
import worker from '../cloudflare/worker.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let passed = 0;
async function test(name, fn) {
  await fn();
  console.log(`  PASS: ${name}`);
  passed += 1;
}

console.log('=== Hunger Motion Beta Verification Suite (Telemetry / Templates / CDN / Edge / Cancel) ===');

await test('1. Telemetry sanitizes emails, tokens, and local home paths & builds Sentry v7 event', () => {
  const clean = sanitizeTelemetryString('Failed for alice@example.com at /Users/trantuan/secret?token=abc123');
  assert.ok(!clean.includes('alice@example.com'), 'email redacted');
  assert.ok(!clean.includes('abc123'), 'token redacted');
  assert.ok(!clean.includes('/Users/trantuan'), 'local username redacted');

  const ev = buildSentryEventPayload(new TypeError('Broken rig for bob@test.io'), {
    subsystem: 'mocap',
    workspace: 'motion',
    fatal: true,
    extra: { frames: 120, note: 'token=xyz999' },
  });
  assert.equal(ev.level, 'fatal');
  assert.equal(ev.platform, 'javascript');
  assert.equal(ev.tags.subsystem, 'mocap');
  assert.ok(!ev.exception.values[0].value.includes('bob@test.io'));
});

await test('2. HungerTelemetry tracks all 5 Beta KPIs cleanly (crash-free, V2G %, TTFA, TTI)', async () => {
  const sentBatches = [];
  const tel = new HungerTelemetry({
    enabled: true,
    fetchImpl: async (_url, init) => {
      sentBatches.push(JSON.parse(init.body));
      return { ok: true, status: 202 };
    },
  });
  tel.markInteractive({ workspace: 'motion', interactiveMs: 1420, deferredPanels: true });
  tel.track('template_selected', { templateId: 'unity_humanoid' });
  tel.markFirstAnimation({ templateId: 'unity_humanoid', tracks: 21, durationSec: 6.4 });
  tel.recordVideoToGlbResult({ ok: true, sizeKB: 812, tracks: 21, durationSec: 6.4 });
  tel.recordVideoToGlbResult({ ok: true, sizeKB: 904, tracks: 21, durationSec: 7.2 });
  const m = tel.getSessionMetrics();
  assert.equal(m.crashFree, true);
  assert.equal(m.initialInteractiveMs, 1420);
  assert.ok(m.timeToFirstAnimationSec !== null && m.timeToFirstAnimationSec >= 0);
  assert.equal(m.videoToGlbAttempts, 2);
  assert.equal(m.videoToGlbSuccesses, 2);
  assert.equal(m.videoToGlbSuccessRate, 100);

  // Non-fatal error does not mark session crashed; fatal does
  tel.captureException(new Error('non-fatal warning'), { fatal: false });
  assert.equal(tel.getSessionMetrics().crashFree, true);
  tel.captureException(new Error('fatal gpu lost'), { fatal: true });
  assert.equal(tel.getSessionMetrics().crashFree, false);
});

await test('3. All 3 Hunger Motion templates (Unity Humanoid, VRM, TikTok Dance) resolve & reference valid assets', () => {
  const tpls = listMotionTemplates();
  assert.equal(tpls.length, 3);
  const ids = tpls.map((t) => t.id);
  assert.deepEqual(ids, ['unity_humanoid', 'vrm_avatar', 'tiktok_dance']);

  assert.equal(getMotionTemplate('unity')?.id, 'unity_humanoid');
  assert.equal(getMotionTemplate('vrm')?.id, 'vrm_avatar');
  assert.equal(getMotionTemplate('tiktok')?.id, 'tiktok_dance');
  assert.equal(resolveTemplateFromSearch('?workspace=motion&template=tiktok')?.id, 'tiktok_dance');

  for (const tpl of tpls) {
    assert.ok(fs.existsSync(path.join(ROOT, tpl.characterUrl)), `Missing character asset ${tpl.characterUrl}`);
    assert.ok(fs.existsSync(path.join(ROOT, tpl.videoUrl)), `Missing video asset ${tpl.videoUrl}`);
    assert.equal(tpl.settings.footLock, true, `${tpl.id} enables Foot-Lock IK`);
  }
  assert.equal(getMotionTemplate('vrm_avatar').settings.trackFace, true, 'VRM template enables ARKit face');
  assert.equal(getMotionTemplate('tiktok_dance').settings.renderRes, '1080x1920', 'TikTok template defaults to 9:16');
});

await test('4. Runtime CDN resolver maps eligible media/models/WASM to CDN base and keeps blob/http intact', () => {
  setCdnBaseUrl('https://cdn.hungermotion.dev/');
  assert.equal(isCdnEligiblePath('models/Mannequin_CC0.glb'), true);
  assert.equal(isCdnEligiblePath('vendor/mediapipe/wasm'), true);
  assert.equal(isCdnEligiblePath('js/app.js'), false);
  assert.equal(resolveCdnAssetUrl('models/shuffle_dance.mp4'), 'https://cdn.hungermotion.dev/models/shuffle_dance.mp4');
  assert.equal(resolveCdnAssetUrl('/vendor/mediapipe/vision_bundle.mjs'), 'https://cdn.hungermotion.dev/vendor/mediapipe/vision_bundle.mjs');
  assert.equal(resolveCdnAssetUrl('blob:https://example.com/123'), 'blob:https://example.com/123');
  setCdnBaseUrl('');
  assert.equal(resolveCdnAssetUrl('models/shuffle_dance.mp4'), '/models/shuffle_dance.mp4');
});

await test('5. Export Cancel aborts during _prepareOptimizedGltfExport traverse & restores scene state cleanly', () => {
  const scene = new THREE.Scene();
  const mat = new THREE.MeshStandardMaterial({ color: 0xff5500 });
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), mat);
  scene.add(mesh);
  const exporter = new StudioExporter({ scene, THREE });
  const ac = new AbortController();
  ac.abort();
  assert.throws(
    () => exporter._prepareOptimizedGltfExport(scene, { signal: ac.signal }),
    (err) => err?.name === 'AbortError',
    'aborted signal immediately aborts optimizer traverse'
  );
  assert.strictEqual(mesh.material, mat, 'original material intact after mid-optimizer abort');
});

await test('6. Cloudflare Worker routes /motion landing, /api/telemetry/event + summary, & unified Community categories', async () => {
  const fakeEnv = {
    STUDIO_ENV: 'staging',
    ASSETS: {
      fetch: async (req) => {
        const u = new URL(req.url);
        if (u.pathname === '/motion.html') {
          return new Response('<!doctype html><title>Hunger Motion</title>', {
            status: 200,
            headers: { 'Content-Type': 'text/html; charset=utf-8' },
          });
        }
        return new Response('Not Found', { status: 404 });
      },
    },
  };

  // /motion serves motion.html with CSP & no-cache
  const landingRes = await worker.fetch(new Request('https://hunger-studio-staging.workers.dev/motion'), fakeEnv);
  assert.equal(landingRes.status, 200);
  assert.ok((await landingRes.text()).includes('Hunger Motion'));
  assert.ok(landingRes.headers.get('content-security-policy')?.includes("default-src 'self'"));

  // /healthz exposes staging environment & telemetry
  const healthRes = await worker.fetch(new Request('https://hunger-studio-staging.workers.dev/healthz'), fakeEnv);
  const health = await healthRes.json();
  assert.equal(health.ok, true);
  assert.equal(health.environment, 'staging');
  assert.equal(health.telemetry, true);

  // /api/cloud/status includes ALL UI community categories (environments, vegetation, materials, scenes)
  const cloudRes = await worker.fetch(new Request('https://hunger-studio-staging.workers.dev/api/cloud/status'), fakeEnv);
  const cloud = await cloudRes.json();
  for (const cat of ['environments', 'vegetation', 'materials', 'architecture', 'characters', 'props', 'scenes']) {
    assert.ok(cloud.categories.includes(cat), `Community category "${cat}" must be accepted by Edge BFF`);
  }

  // /api/telemetry/event ingests session + V2G metrics and /api/telemetry/summary aggregates KPIs
  const telRes = await worker.fetch(new Request('https://hunger-studio-staging.workers.dev/api/telemetry/event', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sessionId: 'sess01',
      events: [
        { kind: 'analytics', name: 'session_interactive', workspace: 'motion', props: { initialInteractiveMs: 1200 } },
        { kind: 'analytics', name: 'first_animation_achieved', workspace: 'motion', props: { timeToFirstAnimationSec: 45 } },
        { kind: 'analytics', name: 'mocap_export_glb', workspace: 'motion', props: { ok: true, sizeKB: 780 } },
      ],
    }),
  }), fakeEnv);
  assert.equal(telRes.status, 202);
  const sumRes = await worker.fetch(new Request('https://hunger-studio-staging.workers.dev/api/telemetry/summary'), fakeEnv);
  const sum = await sumRes.json();
  assert.equal(sum.ok, true);
  assert.equal(sum.kpi.crashFreePct, 100);
  assert.equal(sum.kpi.videoToGlbSuccessPct, 100);
  assert.equal(sum.kpi.medianInteractiveMs, 1200);
});

await test('7. motion.html landing page exists and links all 3 Hunger Motion templates', () => {
  const html = fs.readFileSync(path.join(ROOT, 'motion.html'), 'utf8');
  assert.ok(html.includes('Hunger Motion'));
  assert.ok(html.includes('workspace=motion&amp;template=unity_humanoid'));
  assert.ok(html.includes('workspace=motion&amp;template=vrm_avatar'));
  assert.ok(html.includes('workspace=motion&amp;template=tiktok_dance'));
});

await test('8. Cloudflare Edge forwards fatal errors in Sentry Envelope v7 format when SENTRY_DSN is set', async () => {
  const received = [];
  const srv = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      received.push({
        url: req.url,
        contentType: req.headers['content-type'],
        sentryAuth: req.headers['x-sentry-auth'],
        body: Buffer.concat(chunks).toString('utf8'),
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"id":"ok"}');
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const { port } = srv.address();
  try {
    const fakeEnv = {
      STUDIO_ENV: 'staging',
      SENTRY_DSN: `http://testpubkey123@127.0.0.1:${port}/99`,
    };
    const health = await (await worker.fetch(new Request('https://hunger-studio-staging.workers.dev/healthz'), fakeEnv)).json();
    assert.equal(health.sentryConfigured, true, '/healthz reports sentryConfigured=true when SENTRY_DSN is valid');

    const sentryEvent = buildSentryEventPayload(new Error('Staging fatal smoke'), { subsystem: 'mocap', fatal: true });
    const res = await worker.fetch(new Request('https://hunger-studio-staging.workers.dev/api/telemetry/event', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: 'sess-sentry',
        events: [{ kind: 'error', workspace: 'motion', sentry: sentryEvent }],
      }),
    }), fakeEnv);
    assert.equal(res.status, 202);
    const body = await res.json();
    assert.equal(body.sentryForwarded, 1, 'Sentry forward count equals 1');
    assert.equal(received.length, 1, 'Mock Sentry server received 1 envelope');
    assert.equal(received[0].url, '/api/99/envelope/');
    assert.equal(received[0].contentType, 'application/x-sentry-envelope');
    assert.ok(received[0].sentryAuth.includes('sentry_key=testpubkey123'));
    const lines = received[0].body.split('\n');
    assert.equal(lines.length, 3, 'Sentry envelope has 3 newline-delimited JSON sections');
    assert.equal(JSON.parse(lines[2]).environment, 'staging');
  } finally {
    srv.close();
  }
});

console.log(`\nALL ${passed} BETA MOTION & TELEMETRY TESTS PASSED`);
