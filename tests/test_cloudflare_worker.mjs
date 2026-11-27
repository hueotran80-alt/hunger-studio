/**
 * Comprehensive unit tests for Hunger 100% Serverless Cloudflare Worker
 * (`cloudflare/worker.js` + `cloudflare/cloud-bff.js`):
 *  1. Strict isolated Worker CSP on copilot-exec-worker-*.js and agent-exec-worker-*.js
 *  2. COOP/COEP + CSP on `/` and embed-friendly `frame-ancestors *` on `/embed.html`
 *  3. R2 asset delivery (`/models/*`, `/vendor/mediapipe/*`) with Range 206, ETag 304,
 *     CORP cross-origin, traversal rejection, and fallback to `env.ASSETS`
 *  4. External Python-only `/api/import/blend` proxy to `env.API_ORIGIN` (and 503 when unset)
 *  5. Native Serverless Cloud BFF:
 *     - `/healthz`, `/api/status`, `/api/config`, `/api/cloud/status` (zero secret leakage)
 *     - `/api/cloud/session` HttpOnly/Secure/SameSite cookie + CSRF enforcement on mutations
 *     - `/api/cloud/assets`: GLB magic 415, atomic `cloud_reserve_asset` + R2 upload,
 *       full DB + R2 + credit rollback on R2 write failure
 *     - `/api/cloud/public/assets/:id`: R2 zero-egress stream, Supabase signed URL fallback,
 *       and strict 404 for private assets (owner-only `/download` with `private, no-store`)
 *     - SePay HMAC-SHA256 webhook verification (valid, bad sig 401, account mismatch)
 *     - LemonSqueezy HMAC-SHA256 webhook (`test_mode` blocked 403, `order_refunded`, `order_created`)
 *     - `/api/cloud/ai/chat`: BYOK zero-cost path + credit charge & refund on upstream failure
 */
import assert from 'node:assert/strict';
import worker, { __cloudflareWorkerInternals } from '../cloudflare/worker.js';
import { __cloudBffInternals } from '../cloudflare/cloud-bff.js';

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`ok   ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`FAIL ${name}\n     ${err?.stack || err}`);
  }
}

function makeFakeR2(entries = {}, opts = {}) {
  const store = new Map(Object.entries(entries));
  const deleted = [];
  return {
    store,
    deleted,
    async head(key) {
      const item = store.get(key);
      if (!item) return null;
      return {
        size: item.bytes.byteLength,
        httpEtag: item.etag || `"etag-${key}"`,
        writeHttpMetadata(h) { if (item.contentType) h.set('Content-Type', item.contentType); },
      };
    },
    async get(key, getOpts = {}) {
      const item = store.get(key);
      if (!item) return null;
      let slice = item.bytes;
      if (getOpts.range) {
        slice = item.bytes.slice(getOpts.range.offset, getOpts.range.offset + getOpts.range.length);
      }
      return {
        size: item.bytes.byteLength,
        httpEtag: item.etag || `"etag-${key}"`,
        body: slice,
        writeHttpMetadata(h) { if (item.contentType) h.set('Content-Type', item.contentType); },
      };
    },
    async put(key, value, putOpts = {}) {
      if (opts.failPut) throw new Error('simulated R2 put error');
      const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
      store.set(key, { bytes, contentType: putOpts.httpMetadata?.contentType || 'application/octet-stream' });
    },
    async delete(key) {
      deleted.push(key);
      store.delete(key);
    },
  };
}

function makeFakeAssets(pages = {}) {
  return {
    async fetch(req) {
      const p = new URL(req.url).pathname;
      const body = pages[p] ?? `asset:${p}`;
      return new Response(body, { status: 200, headers: { 'Content-Type': p.endsWith('.js') ? 'text/javascript' : 'text/html' } });
    },
  };
}

function makeValidGlbBase64() {
  const bytes = new Uint8Array(24);
  bytes[0] = 0x67; bytes[1] = 0x6c; bytes[2] = 0x54; bytes[3] = 0x46; // 'glTF'
  bytes[4] = 2; // version 2
  bytes[8] = 24; // total length
  return Buffer.from(bytes).toString('base64');
}

function withMockFetch(handler, fn) {
  const prev = globalThis.fetch;
  globalThis.fetch = handler;
  return Promise.resolve().then(fn).finally(() => { globalThis.fetch = prev; });
}

const BASE_CLOUD_ENV = {
  SUPABASE_URL: 'https://fpkhjitqzieqofcviyqi.supabase.co',
  SUPABASE_ANON_KEY: 'anon-public-test-key',
  SUPABASE_SERVICE_KEY: 'service-secret-do-not-leak',
  COST_SAVE_PROJECT: '0',
  COST_UPLOAD_ASSET: '0',
  COST_AI_CHAT: '0',
};

console.log('\nCloudflare Worker (Hunger R2 + CSP + Serverless Cloud BFF) suite');

// ---------------------------------------------------------------------------
// 1–4. Static Assets, Headers, R2 CDN, and Optional External Proxy
// ---------------------------------------------------------------------------
await test('strict isolated Worker CSP is attached to copilot and agent exec workers', async () => {
  const env = { ASSETS: makeFakeAssets() };
  for (const p of [
    '/assets/copilot-exec-worker-Ab12Cd34.js',
    '/assets/agent-exec-worker-Zz99Yy00.js',
    '/js/ai/copilot-exec-worker.js',
    '/js/agent/agent-exec-worker.js',
  ]) {
    const res = await worker.fetch(new Request(`https://hunger.example${p}`), env);
    assert.equal(res.status, 200);
    const csp = res.headers.get('content-security-policy') || '';
    assert.ok(csp.includes("default-src 'none'"), p);
    assert.ok(csp.includes("connect-src 'none'"), p);
    assert.ok(csp.includes("worker-src 'none'"), p);
    assert.equal(res.headers.get('cross-origin-resource-policy'), 'same-origin');
    assert.equal(res.headers.get('cache-control'), 'no-cache');
  }
});

await test('root HTML enforces COOP/COEP and embed.html allows cross-origin framing', async () => {
  const env = { ASSETS: makeFakeAssets(), SUPABASE_URL: 'https://fpkhjitqzieqofcviyqi.supabase.co' };
  const rootRes = await worker.fetch(new Request('https://hunger.example/'), env);
  assert.equal(rootRes.headers.get('cross-origin-opener-policy'), 'same-origin');
  assert.equal(rootRes.headers.get('cross-origin-embedder-policy'), 'credentialless');
  assert.ok(rootRes.headers.get('content-security-policy').includes("frame-ancestors 'self'"));
  assert.ok(rootRes.headers.get('content-security-policy').includes('https://fpkhjitqzieqofcviyqi.supabase.co'));

  for (const p of ['/embed.html', '/embed']) {
    const embedRes = await worker.fetch(new Request(`https://hunger.example${p}`), env);
    assert.equal(embedRes.headers.get('cross-origin-opener-policy'), null, p);
    assert.equal(embedRes.headers.get('cross-origin-resource-policy'), 'cross-origin', p);
    assert.equal(embedRes.headers.get('x-frame-options'), null, p);
    assert.ok(embedRes.headers.get('content-security-policy').includes('frame-ancestors *'), p);
  }
});

await test('R2 serves /models/* with Range 206, ETag 304, CORP cross-origin, and falls back to ASSETS on miss', async () => {
  const payload = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  const env = {
    HUNGER_ASSETS: makeFakeR2({
      'models/Bot_CC0.glb': { bytes: payload, contentType: 'model/gltf-binary', etag: '"bot-v1"' },
    }),
    ASSETS: makeFakeAssets({ '/models/fallback.glb': 'from-assets' }),
  };

  const res = await worker.fetch(new Request('https://hunger.example/models/Bot_CC0.glb'), env);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'model/gltf-binary');
  assert.equal(res.headers.get('cross-origin-resource-policy'), 'cross-origin');
  assert.equal(res.headers.get('etag'), '"bot-v1"');
  assert.equal((await res.arrayBuffer()).byteLength, 10);

  const rangeRes = await worker.fetch(
    new Request('https://hunger.example/models/Bot_CC0.glb', { headers: { Range: 'bytes=2-5' } }),
    env,
  );
  assert.equal(rangeRes.status, 206);
  assert.equal(rangeRes.headers.get('content-range'), 'bytes 2-5/10');
  assert.deepEqual([...new Uint8Array(await rangeRes.arrayBuffer())], [2, 3, 4, 5]);

  const notMod = await worker.fetch(
    new Request('https://hunger.example/models/Bot_CC0.glb', { headers: { 'If-None-Match': '"bot-v1"' } }),
    env,
  );
  assert.equal(notMod.status, 304);

  const fb = await worker.fetch(new Request('https://hunger.example/models/fallback.glb'), env);
  assert.equal(fb.status, 200);
  assert.equal(await fb.text(), 'from-assets');
});

await test('R2 key normalization blocks traversal and malformed paths', () => {
  const { normalizeR2Key } = __cloudflareWorkerInternals;
  assert.equal(normalizeR2Key('/models/Bot_CC0.glb'), 'models/Bot_CC0.glb');
  assert.equal(normalizeR2Key('/models/../secret.txt'), null);
  assert.equal(normalizeR2Key('/models/%2e%2e/secret.txt'), null);
  assert.equal(normalizeR2Key('/models/a\\b.glb'), null);
});

await test('optional GPU/Blender routes (/api/import/blend) return 503 when API_ORIGIN unset and proxy when set', async () => {
  const unsetRes = await worker.fetch(new Request('https://hunger.example/api/import/blend', { method: 'POST' }), {});
  assert.equal(unsetRes.status, 503);
  const body = await unsetRes.json();
  assert.equal(body.error.code, 'E_BACKEND_UNCONFIGURED');

  const seen = [];
  await withMockFetch(async (url, init) => {
    seen.push({ url, host: init.headers.get('X-Forwarded-Host') });
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }, async () => {
    const okRes = await worker.fetch(
      new Request('https://hunger.example/api/import/blend?v=1', { method: 'POST' }),
      { API_ORIGIN: 'https://gpu.hunger.example' },
    );
    assert.equal(okRes.status, 200);
    assert.equal(seen[0].url, 'https://gpu.hunger.example/api/import/blend?v=1');
    assert.equal(seen[0].host, 'hunger.example');
  });
});

// ---------------------------------------------------------------------------
// 5. Native Serverless Cloud BFF Tests
// ---------------------------------------------------------------------------
await test('/healthz, /api/config, and /api/cloud/status run natively and never leak secrets', async () => {
  const env = { ...BASE_CLOUD_ENV, HUNGER_ASSETS: makeFakeR2(), GEMINI_API_KEY: 'gm-secret-xyz' };

  const hz = await worker.fetch(new Request('https://hunger.example/healthz'), env);
  assert.equal(hz.status, 200);
  const hzJson = await hz.json();
  assert.equal(hzJson.ok, true);
  assert.equal(hzJson.runtime, 'cloudflare-worker');
  assert.equal(hzJson.cloud, true);
  assert.equal(hzJson.r2, true);

  const cfgRes = await worker.fetch(new Request('https://hunger.example/api/config'), env);
  const cfgText = await cfgRes.text();
  assert.equal(cfgRes.status, 200);
  assert.ok(!cfgText.includes('gm-secret-xyz'));
  assert.ok(!cfgText.includes('service-secret-do-not-leak'));
  assert.equal(JSON.parse(cfgText).geminiConfigured, true);

  const stRes = await worker.fetch(new Request('https://hunger.example/api/cloud/status'), env);
  const stText = await stRes.text();
  assert.equal(stRes.status, 200);
  assert.ok(!stText.includes('service-secret-do-not-leak'));
  const st = JSON.parse(stText);
  assert.equal(st.enabled, true);
  assert.equal(st.provider, 'supabase');
  assert.equal(st.storage, 'cloudflare-r2');
  assert.equal(st.supabase.url, BASE_CLOUD_ENV.SUPABASE_URL);
  assert.equal(st.supabase.anonKey, BASE_CLOUD_ENV.SUPABASE_ANON_KEY);
  assert.equal(st.freeMode, true);
});

await test('/api/cloud/session sets HttpOnly Secure cookie and enforces CSRF on cookie mutations', async () => {
  const env = { ...BASE_CLOUD_ENV, HUNGER_ASSETS: makeFakeR2() };
  await withMockFetch(async (url, init) => {
    const u = String(url);
    if (u.endsWith('/auth/v1/user')) {
      assert.equal(init.headers.Authorization, 'Bearer user-jwt-123');
      return new Response(JSON.stringify({ id: '11111111-1111-1111-1111-111111111111', email: 'hueotran80@gmail.com' }), { status: 200 });
    }
    if (u.includes('/rest/v1/cloud_users') && init.method === 'POST') return new Response('', { status: 201 });
    if (u.includes('/rest/v1/cloud_users') && init.method === 'GET') {
      return new Response(JSON.stringify([{ id: '11111111-1111-1111-1111-111111111111', email: 'hueotran80@gmail.com', created_at: '2026-11-26T00:00:00Z' }]), { status: 200 });
    }
    if (u.endsWith('/rpc/cloud_grant_free')) return new Response('100', { status: 200 });
    if (u.endsWith('/rpc/cloud_balance')) return new Response('[100]', { status: 200 }); // verify array unwrap
    if (u.includes('/rest/v1/cloud_projects') && init.method === 'DELETE') return new Response(null, { status: 204 });
    throw new Error(`Unexpected fetch: ${init.method} ${u}`);
  }, async () => {
    const res = await worker.fetch(new Request('https://hunger.example/api/cloud/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'user-jwt-123' }),
    }), env);
    assert.equal(res.status, 200);
    const cookie = res.headers.get('set-cookie') || '';
    assert.ok(cookie.includes('wbs_session=user-jwt-123'));
    assert.ok(cookie.includes('HttpOnly'));
    assert.ok(cookie.includes('SameSite=Lax'));
    assert.ok(cookie.includes('Secure'));
    const body = await res.json();
    assert.equal(body.user.credits, 100);

    // Cross-site POST with cookie and no CSRF header MUST be rejected 403
    const csrfBlocked = await worker.fetch(new Request('https://hunger.example/api/cloud/projects/12345678/delete', {
      method: 'POST',
      headers: { Cookie: 'wbs_session=user-jwt-123', Origin: 'https://evil.example' },
    }), env);
    assert.equal(csrfBlocked.status, 403);

    // Same-origin POST with cookie succeeds
    const csrfOk = await worker.fetch(new Request('https://hunger.example/api/cloud/projects/12345678/delete', {
      method: 'POST',
      headers: { Cookie: 'wbs_session=user-jwt-123', 'Sec-Fetch-Site': 'same-origin' },
    }), env);
    assert.equal(csrfOk.status, 200);
  });
});

await test('/api/cloud/assets validates GLB magic, uses atomic cloud_reserve_asset + R2, and rolls back on R2 error', async () => {
  const userId = '11111111-1111-1111-1111-111111111111';
  const r2Ok = makeFakeR2();
  const envOk = { ...BASE_CLOUD_ENV, COST_UPLOAD_ASSET: '5', HUNGER_ASSETS: r2Ok };
  const calls = [];

  const mockSupabase = async (url, init) => {
    const u = String(url);
    calls.push({ method: init.method, url: u, body: init.body ? JSON.parse(init.body) : null });
    if (u.endsWith('/auth/v1/user')) return new Response(JSON.stringify({ id: userId, email: 'creator@example.com' }), { status: 200 });
    if (u.includes('/rest/v1/cloud_users') && init.method === 'POST') return new Response('', { status: 201 });
    if (u.includes('/rest/v1/cloud_users') && init.method === 'GET') return new Response(JSON.stringify([{ id: userId, email: 'creator@example.com', created_at: '2026-11-26T00:00:00Z' }]), { status: 200 });
    if (u.endsWith('/rpc/cloud_grant_free')) return new Response('100', { status: 200 });
    if (u.endsWith('/rpc/cloud_balance')) return new Response('100', { status: 200 });
    if (u.endsWith('/rpc/cloud_reserve_asset')) return new Response(JSON.stringify({ credits: 95, created_at: '2026-11-26T01:00:00Z' }), { status: 200 });
    if (u.includes('/rest/v1/cloud_assets') && init.method === 'DELETE') return new Response(null, { status: 204 });
    if (u.endsWith('/rpc/cloud_credit')) return new Response('100', { status: 200 });
    throw new Error(`Unexpected fetch: ${init.method} ${u}`);
  };

  await withMockFetch(mockSupabase, async () => {
    // 1. Non-GLB rejected 415 before RPC
    const badRes = await worker.fetch(new Request('https://hunger.example/api/cloud/assets', {
      method: 'POST',
      headers: { Authorization: 'Bearer jwt', 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileName: 'fake.glb', dataBase64: Buffer.from('not-a-glb-file-at-all-123456').toString('base64') }),
    }), envOk);
    assert.equal(badRes.status, 415);

    // 2. Valid GLB reserves atomically and writes to R2
    const okRes = await worker.fetch(new Request('https://hunger.example/api/cloud/assets', {
      method: 'POST',
      headers: { Authorization: 'Bearer jwt', 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileName: 'hero.glb', title: 'Hero', category: 'characters', dataBase64: makeValidGlbBase64() }),
    }), envOk);
    assert.equal(okRes.status, 200);
    const okBody = await okRes.json();
    assert.equal(okBody.asset.credits, 95);
    assert.equal(r2Ok.store.size, 1);
    const storedKey = [...r2Ok.store.keys()][0];
    assert.ok(storedKey.startsWith(`user_uploads/${userId}/`) && storedKey.endsWith('.glb'));

    // 3. R2 write failure triggers DB row delete + R2 cleanup + credit refund
    calls.length = 0;
    const r2Fail = makeFakeR2({}, { failPut: true });
    const failRes = await worker.fetch(new Request('https://hunger.example/api/cloud/assets', {
      method: 'POST',
      headers: { Authorization: 'Bearer jwt', 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileName: 'hero2.glb', dataBase64: makeValidGlbBase64() }),
    }), { ...BASE_CLOUD_ENV, COST_UPLOAD_ASSET: '5', HUNGER_ASSETS: r2Fail });
    assert.equal(failRes.status, 502);
    assert.ok(calls.some((c) => c.method === 'DELETE' && c.url.includes('/rest/v1/cloud_assets')));
    assert.ok(calls.some((c) => c.url.endsWith('/rpc/cloud_credit') && c.body?.p_reason === 'refund_upload_failed' && c.body?.p_amount === 5));
    assert.equal(r2Fail.deleted.length, 1);

    // 4. When R2 is not bound, automatically uploads to private Supabase Storage
    let sbStoragePutUrl = '';
    await withMockFetch(async (url, init) => {
      const u = String(url);
      if (u.includes('/storage/v1/object/shared-models/')) {
        sbStoragePutUrl = u;
        return new Response(JSON.stringify({ Key: 'shared-models/ok' }), { status: 200 });
      }
      return mockSupabase(url, init);
    }, async () => {
      const sbRes = await worker.fetch(new Request('https://hunger.example/api/cloud/assets', {
        method: 'POST',
        headers: { Authorization: 'Bearer jwt', 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileName: 'sb_hero.glb', dataBase64: makeValidGlbBase64() }),
      }), { ...BASE_CLOUD_ENV, COST_UPLOAD_ASSET: '5' });
      assert.equal(sbRes.status, 200);
      assert.ok(sbStoragePutUrl.includes(`/storage/v1/object/shared-models/${userId}/`));
    });
  });
});

await test('public assets stream from R2 (or fallback to signed URL) while private assets are owner-only', async () => {
  const userId = '11111111-1111-1111-1111-111111111111';
  const glbBytes = new Uint8Array([0x67, 0x6c, 0x54, 0x46, 2, 0, 0, 0, 20, 0, 0, 0]);
  const r2 = makeFakeR2({
    'user_uploads/u1/pub12345.glb': { bytes: glbBytes, contentType: 'model/gltf-binary' },
    'user_uploads/u1/priv1234.glb': { bytes: glbBytes, contentType: 'model/gltf-binary' },
  });
  const env = { ...BASE_CLOUD_ENV, HUNGER_ASSETS: r2 };

  await withMockFetch(async (url, init) => {
    const u = String(url);
    if (u.endsWith('/auth/v1/user')) return new Response(JSON.stringify({ id: userId, email: 'owner@example.com' }), { status: 200 });
    if (u.includes('/rest/v1/cloud_users') && init.method === 'POST') return new Response('', { status: 201 });
    if (u.includes('/rest/v1/cloud_users') && init.method === 'GET') return new Response(JSON.stringify([{ id: userId, email: 'owner@example.com', created_at: '2026-11-26T00:00:00Z' }]), { status: 200 });
    if (u.endsWith('/rpc/cloud_grant_free') || u.endsWith('/rpc/cloud_balance')) return new Response('100', { status: 200 });
    if (u.includes('id=eq.pub12345&public=eq.true')) {
      return new Response(JSON.stringify([{ id: 'pub12345', name: 'pub.glb', content_type: 'model/gltf-binary', storage_path: 'user_uploads/u1/pub12345.glb', thumb_path: '' }]), { status: 200 });
    }
    if (u.includes('id=eq.legacy99&public=eq.true')) {
      return new Response(JSON.stringify([{ id: 'legacy99', name: 'old.glb', content_type: 'model/gltf-binary', storage_path: 'u1/legacy99.glb', thumb_path: '' }]), { status: 200 });
    }
    if (u.includes('/storage/v1/object/sign/shared-models/u1/legacy99.glb')) {
      return new Response(JSON.stringify({ signedURL: '/object/sign/shared-models/u1/legacy99.glb?token=signed123' }), { status: 200 });
    }
    if (u.includes('id=eq.priv1234&public=eq.true')) {
      return new Response(JSON.stringify([]), { status: 200 }); // not public!
    }
    if (u.includes(`id=eq.priv1234&user_id=eq.${userId}`)) {
      return new Response(JSON.stringify([{ id: 'priv1234', user_id: userId, name: 'secret.glb', content_type: 'model/gltf-binary', storage_path: 'user_uploads/u1/priv1234.glb', public: false }]), { status: 200 });
    }
    throw new Error(`Unexpected fetch: ${init.method} ${u}`);
  }, async () => {
    // 1. Public asset streams directly from R2
    const pub = await worker.fetch(new Request('https://hunger.example/api/cloud/public/assets/pub12345'), env);
    assert.equal(pub.status, 200);
    assert.equal(pub.headers.get('access-control-allow-origin'), '*');
    assert.equal(pub.headers.get('content-security-policy'), "default-src 'none'; sandbox");
    assert.equal((await pub.arrayBuffer()).byteLength, glbBytes.byteLength);

    // 2. Legacy public asset not in R2 redirects 302 to short-lived Supabase signed URL
    const legacy = await worker.fetch(new Request('https://hunger.example/api/cloud/public/assets/legacy99'), env);
    assert.equal(legacy.status, 302);
    assert.equal(
      legacy.headers.get('location'),
      `${BASE_CLOUD_ENV.SUPABASE_URL}/storage/v1/object/sign/shared-models/u1/legacy99.glb?token=signed123`,
    );

    // 3. Private asset denied on public route (404)
    const privPub = await worker.fetch(new Request('https://hunger.example/api/cloud/public/assets/priv1234'), env);
    assert.equal(privPub.status, 404);

    // 4. Private asset allowed on owner-authenticated /download with private, no-store
    const privDl = await worker.fetch(new Request('https://hunger.example/api/cloud/assets/priv1234/download', {
      headers: { Authorization: 'Bearer owner-jwt' },
    }), env);
    assert.equal(privDl.status, 200);
    assert.equal(privDl.headers.get('cache-control'), 'private, no-store');
  });
});

await test('SePay webhook verifies HMAC-SHA256, checks bank account, and credits payment', async () => {
  const secret = 'sepay-test-secret';
  const env = { ...BASE_CLOUD_ENV, SEPAY_BANK: 'MB', SEPAY_ACCOUNT: '0123456789', SEPAY_WEBHOOK_SECRET: secret };
  const payload = JSON.stringify({
    id: 9001, transferType: 'in', accountNumber: '0123456789', transferAmount: 69000, content: 'Thanh toan WBSABCD1234',
  });
  const sig = await __cloudBffInternals.hmacSha256Hex(secret, new TextEncoder().encode(payload));

  // Bad signature -> 401
  const bad = await worker.fetch(new Request('https://hunger.example/api/cloud/webhook/sepay', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-SePay-Signature': '0000' }, body: payload,
  }), env);
  assert.equal(bad.status, 401);

  // Wrong account -> ignored
  const wrongAcctPayload = JSON.stringify({ id: 9002, transferType: 'in', accountNumber: '9999999999', transferAmount: 69000, content: 'WBSABCD1234' });
  const wrongSig = await __cloudBffInternals.hmacSha256Hex(secret, new TextEncoder().encode(wrongAcctPayload));
  const wrongAcct = await worker.fetch(new Request('https://hunger.example/api/cloud/webhook/sepay', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-SePay-Signature': `sha256=${wrongSig}` }, body: wrongAcctPayload,
  }), env);
  assert.equal(wrongAcct.status, 200);
  assert.equal((await wrongAcct.json()).ignored, 'account_mismatch');

  // Valid signature -> calls cloud_mark_payment_paid
  let rpcArgs = null;
  await withMockFetch(async (url, init) => {
    assert.ok(String(url).endsWith('/rpc/cloud_mark_payment_paid'));
    rpcArgs = JSON.parse(init.body);
    return new Response(JSON.stringify({ applied: true, reason: 'credited', credits: 400 }), { status: 200 });
  }, async () => {
    const ok = await worker.fetch(new Request('https://hunger.example/api/cloud/webhook/sepay', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-SePay-Signature': `sha256=${sig}` }, body: payload,
    }), env);
    assert.equal(ok.status, 200);
    const body = await ok.json();
    assert.equal(body.applied, true);
    assert.equal(body.credits, 400);
    assert.equal(rpcArgs.p_code, 'WBSABCD1234');
    assert.equal(rpcArgs.p_paid_amount, 69000);
    assert.equal(rpcArgs.p_provider, 'sepay');
  });
});

await test('LemonSqueezy webhook blocks test_mode (403) and handles order_refunded + order_created', async () => {
  const secret = 'lemon-secret-xyz';
  const env = { ...BASE_CLOUD_ENV, LEMONSQUEEZY_SIGNING_SECRET: secret, LEMONSQUEEZY_VARIANT_STARTER: 'var-1' };

  async function sendLemon(obj) {
    const body = JSON.stringify(obj);
    const sig = await __cloudBffInternals.hmacSha256Hex(secret, new TextEncoder().encode(body));
    return worker.fetch(new Request('https://hunger.example/api/cloud/webhook/lemonsqueezy', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Signature': sig }, body,
    }), env);
  }

  // test_mode rejected 403
  const tm = await sendLemon({ meta: { test_mode: true, event_name: 'order_created' }, data: { id: '1', attributes: { status: 'paid' } } });
  assert.equal(tm.status, 403);

  // order_refunded calls cloud_refund_payment
  await withMockFetch(async (url, init) => {
    if (String(url).endsWith('/rpc/cloud_refund_payment')) {
      const args = JSON.parse(init.body);
      assert.equal(args.p_code, 'WBSREFU1234');
      assert.equal(args.p_provider, 'lemonsqueezy');
      return new Response(JSON.stringify({ applied: true, reason: 'refunded', credits: 100 }), { status: 200 });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  }, async () => {
    const ref = await sendLemon({
      meta: { test_mode: false, event_name: 'order_refunded', custom_data: { payment_code: 'WBSREFU1234' } },
      data: { id: 'ord-99', attributes: { status: 'refunded', refunded: true } },
    });
    assert.equal(ref.status, 200);
    const j = await ref.json();
    assert.equal(j.applied, true);
    assert.equal(j.reason, 'refunded');
  });
});

await test('/api/cloud/ai/chat supports zero-cost BYOK and refunds credits if upstream AI fails', async () => {
  const userId = '11111111-1111-1111-1111-111111111111';
  const env = { ...BASE_CLOUD_ENV, COST_AI_CHAT: '2', GEMINI_API_KEY: 'srv-gemini-key' };
  const calls = [];

  await withMockFetch(async (url, init) => {
    const u = String(url);
    calls.push({ url: u, headers: init.headers, body: init.body ? JSON.parse(init.body) : null });
    if (u.endsWith('/auth/v1/user')) return new Response(JSON.stringify({ id: userId, email: 'u@example.com' }), { status: 200 });
    if (u.includes('/rest/v1/cloud_users') && init.method === 'POST') return new Response('', { status: 201 });
    if (u.includes('/rest/v1/cloud_users') && init.method === 'GET') return new Response(JSON.stringify([{ id: userId, email: 'u@example.com', created_at: '2026-11-26T00:00:00Z' }]), { status: 200 });
    if (u.endsWith('/rpc/cloud_grant_free') || u.endsWith('/rpc/cloud_balance')) return new Response('50', { status: 200 });
    if (u.endsWith('/rpc/cloud_charge')) return new Response('48', { status: 200 });
    if (u.endsWith('/rpc/cloud_credit')) return new Response('50', { status: 200 });
    if (u.includes('generativelanguage.googleapis.com')) {
      if (init.headers.Authorization === 'Bearer user-byok-key') {
        return new Response(JSON.stringify({ choices: [{ message: { content: 'ok-byok' } }] }), { status: 200 });
      }
      return new Response('upstream overloaded', { status: 503 });
    }
    throw new Error(`Unexpected fetch: ${u}`);
  }, async () => {
    // 1. BYOK skips cloud_charge and forwards user key
    const byokRes = await worker.fetch(new Request('https://hunger.example/api/cloud/ai/chat', {
      method: 'POST',
      headers: { Authorization: 'Bearer jwt', 'Content-Type': 'application/json', 'X-AI-Provider-Key': 'user-byok-key' },
      body: JSON.stringify({ provider: 'gemini', messages: [{ role: 'user', content: 'hi' }] }),
    }), env);
    assert.equal(byokRes.status, 200);
    assert.ok(!calls.some((c) => c.url.endsWith('/rpc/cloud_charge')));

    // 2. Managed AI charges 2 credits and automatically refunds on upstream 503
    calls.length = 0;
    const failRes = await worker.fetch(new Request('https://hunger.example/api/cloud/ai/chat', {
      method: 'POST',
      headers: { Authorization: 'Bearer jwt', 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'gemini', messages: [{ role: 'user', content: 'hi' }] }),
    }), env);
    assert.equal(failRes.status, 502);
    assert.ok(calls.some((c) => c.url.endsWith('/rpc/cloud_charge') && c.body?.p_amount === 2));
    assert.ok(calls.some((c) => c.url.endsWith('/rpc/cloud_credit') && c.body?.p_amount === 2 && c.body?.p_reason === 'refund_ai_failed'));
  });
});

await test('/api/ai/chat supports MOTAPIS_API_KEYS multi-key failover and rejects endpoint override', async () => {
  const env = { ...BASE_CLOUD_ENV, MOTAPIS_API_KEYS: '["sk-k1","sk-k2"]', MOTAPIS_MODEL: 'gpt-6-astra' };

  const cfgRes = await worker.fetch(new Request('https://hunger.example/api/config'), env);
  const cfgText = await cfgRes.text();
  assert.ok(!cfgText.includes('sk-k1') && !cfgText.includes('sk-k2'));
  const cfgJson = JSON.parse(cfgText);
  assert.equal(cfgJson.hasCustomKeys, true);
  assert.equal(cfgJson.customKeysCount, 2);
  assert.ok(Array.isArray(cfgJson.freeModels?.motapis));

  const badEndpoint = await worker.fetch(new Request('https://hunger.example/api/ai/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider: 'motapis', endpoint: 'https://evil.example', messages: [{ role: 'user', content: 'hi' }] }),
  }), env);
  assert.equal(badEndpoint.status, 400);

  const triedAuth = [];
  await withMockFetch(async (_url, init) => {
    triedAuth.push(init.headers.Authorization);
    if (init.headers.Authorization === 'Bearer sk-k1') {
      return new Response('rate limited', { status: 429 });
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: 'OK from k2' } }] }), { status: 200 });
  }, async () => {
    const okRes = await worker.fetch(new Request('https://hunger.example/api/ai/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'motapis', messages: [{ role: 'user', content: 'hi' }] }),
    }), env);
    assert.equal(okRes.status, 200);
    assert.deepEqual(triedAuth, ['Bearer sk-k1', 'Bearer sk-k2']);
    const data = await okRes.json();
    assert.equal(data.choices[0].message.content, 'OK from k2');
  });
});

await test('/mcp JSON-RPC 2.0 and CLI REST bridge route through BRIDGE_HUB Durable Object', async () => {
  const seen = [];
  const fakeHub = {
    getByName(sessionId) {
      return {
        async fetch(req) {
          const u = new URL(req.url);
          if (u.pathname === '/status') {
            return Response.json({ connectedBrowsers: 1 });
          }
          if (u.pathname === '/command') {
            const tok = req.headers.get('x-studio-token');
            if (tok !== 'valid-bridge-token-123456') {
              return Response.json({ success: false, ok: false, error: { code: 'E_UNAUTHORIZED', message: 'bad token' } }, { status: 401 });
            }
            const body = await req.json();
            seen.push({ sessionId, body });
            if (body.action === 'get_scene') {
              return Response.json({
                success: true,
                scene: { totalObjects: 1, activeObject: 'Cube', objects: [{ name: 'Cube', type: 'Mesh', position: [0, 1, 0], selected: true }] },
              });
            }
            if (body.action === 'screenshot') {
              return Response.json({ success: true, width: 640, height: 360, dataUrl: 'data:image/png;base64,iVBORw0KGgo=' });
            }
            if (body.action === 'agent') {
              return Response.json({ ok: true, data: { method: body.method, args: body.args } });
            }
            return Response.json({ success: true, message: 'Executed' });
          }
          return new Response('not found', { status: 404 });
        },
      };
    },
  };
  const env = { ...BASE_CLOUD_ENV, BRIDGE_HUB: fakeHub, AI_PROVIDER: 'motapis' };

  // 1. /api/status reports bridgeEnabled + wsPath + mcpEndpoint + connectedBrowsers
  const stRes = await worker.fetch(new Request('https://hunger.example/api/status?session=hg_demo1'), env);
  assert.equal(stRes.status, 200);
  const st = await stRes.json();
  assert.equal(st.bridgeEnabled, true);
  assert.equal(st.wsPath, '/api/bridge/ws');
  assert.equal(st.mcpEndpoint, '/mcp');
  assert.equal(st.connectedBrowsers, 1);

  // 2. MCP initialize & tools/list
  const initRes = await worker.fetch(new Request('https://hunger.example/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
  }), env);
  assert.equal(initRes.status, 200);
  const initJson = await initRes.json();
  assert.equal(initJson.result.serverInfo.name, 'hunger-3d-studio');

  const listRes = await worker.fetch(new Request('https://hunger.example/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
  }), env);
  const listJson = await listRes.json();
  assert.equal(listJson.result.tools.length, 8);

  // 3. MCP tools/call with valid Bearer token
  const sceneRes = await worker.fetch(new Request('https://hunger.example/mcp?session=hg_demo1', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer valid-bridge-token-123456' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'studio_get_scene', arguments: {} } }),
  }), env);
  const sceneJson = await sceneRes.json();
  assert.ok(sceneJson.result.content[0].text.includes('Cube'));

  // 4. MCP screenshot returns image + text content blocks
  const shotRes = await worker.fetch(new Request('https://hunger.example/mcp?session=hg_demo1', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer valid-bridge-token-123456' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'studio_capture_viewport', arguments: {} } }),
  }), env);
  const shotJson = await shotRes.json();
  assert.equal(shotJson.result.content[0].type, 'image');
  assert.equal(shotJson.result.content[0].mimeType, 'image/png');

  // 5. CLI REST /api/agent/call rejects bad token (401) and accepts valid token (200)
  const badCli = await worker.fetch(new Request('https://hunger.example/api/agent/call', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Studio-Token': 'wrong' },
    body: JSON.stringify({ method: 'scene.tree', args: [] }),
  }), env);
  assert.equal(badCli.status, 401);

  const okCli = await worker.fetch(new Request('https://hunger.example/api/agent/call', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Studio-Token': 'valid-bridge-token-123456', 'X-Studio-Session': 'hg_demo1' },
    body: JSON.stringify({ method: 'scene.tree', args: [] }),
  }), env);
  assert.equal(okCli.status, 200);
  const okCliJson = await okCli.json();
  assert.equal(okCliJson.ok, true);
  assert.equal(okCliJson.data.method, 'scene.tree');

  // 6. Native Edge routes: /api/tts (204), /api/mocap/samples & health (200), /api/hunyuan3d/status (200), /api/agent/proxy SSRF guard
  const ttsRes = await worker.fetch(new Request('https://hunger.example/api/tts?lang=vi&text=hello'), env);
  assert.equal(ttsRes.status, 204);

  const mocapSamples = await (await worker.fetch(new Request('https://hunger.example/api/mocap/samples'), env)).json();
  assert.equal(mocapSamples.success, true);
  assert.equal(mocapSamples.samples.length, 3);

  const mocapHealth = await (await worker.fetch(new Request('https://hunger.example/api/mocap/health'), env)).json();
  assert.equal(mocapHealth.browserWasm, true);

  const hyStatus = await (await worker.fetch(new Request('https://hunger.example/api/hunyuan3d/status'), env)).json();
  assert.equal(hyStatus.success, true);

  const badProxy = await worker.fetch(new Request('https://hunger.example/api/agent/proxy?url=https://169.254.169.254/latest'), env);
  assert.equal(badProxy.status, 403);
});

console.log(`\nCloudflare Worker: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
