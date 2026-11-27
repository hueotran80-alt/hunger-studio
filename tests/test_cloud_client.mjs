/**
 * Frontend cloud client: session persistence, auth refresh, API errors, uploads.
 * Run: node tests/test_cloud_client.mjs
 */
import {
  CloudClient,
  CloudApiError,
  parseAuthHash,
  decodeJwtPayload,
  sessionStorageKey,
  bytesToBase64
} from '../js/cloud/cloud-client.js';

let passed = 0;
const failures = [];
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`ok   ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.log(`FAIL ${name}\n     ${error.stack || error.message}`);
  }
}
function assert(condition, message) {
  if (!condition) throw new Error(message);
}
function response(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body))
  };
}
function memoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
    dump: () => Object.fromEntries(map)
  };
}
function jwt(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `header.${body}.signature`;
}
const ORIGIN = 'http://studio.test';

await test('status is enabled and cached', async () => {
  let calls = 0;
  const fetchImpl = async (url) => {
    calls += 1;
    assert(url === `${ORIGIN}/api/cloud/status`, url);
    return response(200, { success: true, enabled: true, provider: 'local', devLogin: true, plans: [] });
  };
  const client = new CloudClient({ fetchImpl, storage: memoryStorage(), origin: ORIGIN });
  const first = await client.status();
  const second = await client.status();
  assert(first.enabled === true && second.enabled, 'status not enabled');
  assert(calls === 1, `status should cache, called ${calls}`);
});

await test('dev login stores a session and sends the bearer header', async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url, init });
    if (url.endsWith('/api/cloud/status')) {
      return response(200, { success: true, enabled: true, devLogin: true });
    }
    if (url.endsWith('/api/cloud/dev-login')) {
      assert(JSON.parse(init.body).email === 'me@example.com', 'email body');
      return response(200, {
        success: true,
        session: { token: 'local-token', expiresAt: 2_000_000_000, provider: 'local' },
        user: { id: 'user1', email: 'me@example.com', credits: 100 }
      });
    }
    if (url.endsWith('/api/cloud/me')) {
      assert(init.headers.Authorization === 'Bearer local-token', init.headers.Authorization);
      return response(200, { success: true, user: { id: 'user1', email: 'me@example.com', credits: 100 } });
    }
    throw new Error(`unexpected ${url}`);
  };
  const storage = memoryStorage();
  const client = new CloudClient({ fetchImpl, storage, origin: ORIGIN, now: () => 1_000_000 });
  await client.devLogin('me@example.com');
  assert(client.isSignedIn(), 'not signed in');
  assert(client.session.user.email === 'me@example.com', 'session user');
  const me = await client.me();
  assert(me.user.credits === 100, 'me credits');
  const stored = JSON.parse(storage.getItem(sessionStorageKey));
  assert(stored.accessToken === 'local-token', 'session persisted');
});

await test('expired local session is discarded on load', () => {
  const stale = JSON.stringify({ provider: 'local', accessToken: 'old', expiresAt: 10, user: {} });
  const storage = memoryStorage({ [sessionStorageKey]: stale });
  const client = new CloudClient({ fetchImpl: async () => response(500, {}), storage, origin: ORIGIN, now: () => 1000 });
  assert(client.isSignedIn() === false, 'stale session should not sign in');
  assert(storage.getItem(sessionStorageKey) === null, 'stale session should be removed');
});

await test('402 insufficient credits is mapped with hint', async () => {
  const fetchImpl = async (url) => {
    if (url.endsWith('/api/cloud/status')) return response(200, { success: true, enabled: true });
    return response(402, {
      success: false,
      error: { code: 'E_INSUFFICIENT_CREDITS', message: 'Không đủ credit.', hint: 'Nạp thêm.' }
    });
  };
  const storage = memoryStorage({
    [sessionStorageKey]: JSON.stringify({
      provider: 'local', accessToken: 't', expiresAt: 9_999_999_999, user: { id: 'u', email: 'a@b.c' }
    })
  });
  const client = new CloudClient({ fetchImpl, storage, origin: ORIGIN, now: () => 1000 });
  let caught = null;
  try {
    await client.saveProject('Scene', { meta: {} });
  } catch (error) {
    caught = error;
  }
  assert(caught instanceof CloudApiError, 'wrong error type');
  assert(caught.code === 'E_INSUFFICIENT_CREDITS', caught.code);
  assert(caught.status === 402, String(caught.status));
  assert(caught.hint === 'Nạp thêm.', caught.hint);
});

await test('Supabase 401 triggers refresh and retries once', async () => {
  const calls = [];
  let access = 'old-token';
  const fetchImpl = async (url, init = {}) => {
    calls.push(url);
    if (url.endsWith('/api/cloud/status')) {
      return response(200, {
        success: true, enabled: true,
        supabase: { url: 'https://demo.supabase.co', anonKey: 'anon' }
      });
    }
    if (url.includes('/auth/v1/token?grant_type=refresh_token')) {
      assert(JSON.parse(init.body).refresh_token === 'refresh-1', 'refresh token');
      access = 'new-token';
      return response(200, {
        access_token: 'new-token', refresh_token: 'refresh-2', expires_in: 3600,
        user: { id: 'u1', email: 'a@example.com' }
      });
    }
    if (url.endsWith('/api/cloud/projects')) {
      if (init.headers.Authorization === 'Bearer old-token') {
        return response(401, { success: false, error: { code: 'E_AUTH_EXPIRED', message: 'expired' } });
      }
      return response(200, { success: true, projects: [{ id: 'p1' }] });
    }
    throw new Error(`unexpected ${url}`);
  };
  const storage = memoryStorage({
    [sessionStorageKey]: JSON.stringify({
      provider: 'supabase',
      accessToken: 'old-token',
      refreshToken: 'refresh-1',
      expiresAt: Date.now() + 3_600_000,
      user: { id: 'u1', email: 'a@example.com' }
    })
  });
  const client = new CloudClient({ fetchImpl, storage, origin: ORIGIN });
  const result = await client.listProjects();
  assert(result.projects.length === 1, 'projects');
  assert(access === 'new-token', 'token not refreshed');
  assert(client.session.accessToken === 'new-token', 'session not updated');
  assert(calls.filter((url) => url.includes('refresh_token')).length === 1, 'refresh count');
});

await test('magic-link hash creates a session and clears the redirect hash', async () => {
  const token = jwt({ sub: 'supabase-user', email: 'magic@example.com' });
  const storage = memoryStorage();
  let replaced = null;
  const client = new CloudClient({
    fetchImpl: async () => response(200, {}),
    storage,
    origin: ORIGIN,
    location: { origin: ORIGIN, pathname: '/index.html', search: '?x=1', hash: '' }
  });
  const originalHistory = globalThis.history;
  globalThis.history = { replaceState: (...args) => { replaced = args; } };
  try {
    const session = await client.handleAuthHash(
      `#access_token=${token}&refresh_token=r1&expires_in=3600&type=magiclink`
    );
    assert(session.user.email === 'magic@example.com', 'email from jwt');
    assert(client.isSignedIn(), 'signed in');
    assert(replaced && replaced[2] === '/index.html?x=1', `history not cleared: ${replaced}`);
  } finally {
    if (originalHistory === undefined) delete globalThis.history;
    else globalThis.history = originalHistory;
  }
});

await test('magic-link error hash throws a readable error', async () => {
  const client = new CloudClient({ fetchImpl: async () => response(200, {}), storage: memoryStorage(), origin: ORIGIN });
  let caught = null;
  try {
    await client.handleAuthHash('#error=access_denied&error_description=Link+expired');
  } catch (error) {
    caught = error;
  }
  assert(caught instanceof CloudApiError, 'wrong error type');
  assert(caught.message === 'Link expired', caught.message);
});

await test('auth hash parser rejects malformed tokens and exposes decode', () => {
  assert(parseAuthHash('#') === null, 'empty hash');
  assert(decodeJwtPayload('not-a-jwt') === null, 'bad jwt');
  const parsed = parseAuthHash('#access_token=a.b.c&expires_in=120', 5000);
  assert(parsed.session.expiresAt === 5000 + 120_000, 'expiry math');
});

await test('uploadAsset base64-encodes bytes without corruption', async () => {
  const bytes = new Uint8Array([0, 1, 2, 250, 255, 128]);
  let body = null;
  const fetchImpl = async (url, init) => {
    if (url.endsWith('/api/cloud/status')) return response(200, { success: true, enabled: true });
    body = JSON.parse(init.body);
    return response(200, { success: true, asset: { id: 'a1', url: '/api/cloud/public/assets/a1' } });
  };
  const storage = memoryStorage({
    [sessionStorageKey]: JSON.stringify({
      provider: 'local', accessToken: 't', expiresAt: 9_999_999_999, user: { id: 'u', email: 'a@b.c' }
    })
  });
  const client = new CloudClient({ fetchImpl, storage, origin: ORIGIN, now: () => 1000 });
  const result = await client.uploadAsset(bytes, 'cube.glb');
  assert(body.fileName === 'cube.glb', 'fileName');
  assert(body.contentType === 'model/gltf-binary', 'contentType');
  const decoded = Buffer.from(body.dataBase64, 'base64');
  assert(decoded.equals(Buffer.from(bytes)), 'base64 mismatch');
  assert(result.asset.id === 'a1', 'asset id');
  assert(bytesToBase64(bytes) === body.dataBase64, 'helper mismatch');
});

await test('logout clears the persisted session', async () => {
  const storage = memoryStorage({
    [sessionStorageKey]: JSON.stringify({
      provider: 'local', accessToken: 't', expiresAt: 9_999_999_999, user: { id: 'u', email: 'a@b.c' }
    })
  });
  const client = new CloudClient({ fetchImpl: async () => response(200, {}), storage, origin: ORIGIN, now: () => 1000 });
  client.logout();
  assert(client.session === null, 'session not cleared');
  assert(storage.getItem(sessionStorageKey) === null, 'storage not cleared');
});

await test('absoluteUrl resolves server asset paths', () => {
  const client = new CloudClient({ fetchImpl: async () => response(200, {}), storage: memoryStorage(), origin: ORIGIN });
  assert(client.absoluteUrl('/api/cloud/public/assets/x') === `${ORIGIN}/api/cloud/public/assets/x`, 'relative');
  assert(client.absoluteUrl('https://cdn.example.com/a.glb') === 'https://cdn.example.com/a.glb', 'absolute');
});

await test('default global location supplies the origin (no constructor shadowing)', () => {
  const previous = globalThis.location;
  globalThis.location = { origin: ORIGIN, pathname: '/studio', search: '' };
  try {
    const client = new CloudClient({ fetchImpl: async () => response(200, {}), storage: memoryStorage() });
    assert(client.origin === ORIGIN, `origin was "${client.origin}"`);
    assert(
      client.absoluteUrl('/api/cloud/public/assets/x') === `${ORIGIN}/api/cloud/public/assets/x`,
      `absoluteUrl was "${client.absoluteUrl('/api/cloud/public/assets/x')}"`
    );
  } finally {
    if (previous === undefined) delete globalThis.location;
    else globalThis.location = previous;
  }
});

await test('magic link sends redirect_to and never puts the token in a URL', async () => {
  let requested = '';
  const fetchImpl = async (url) => {
    if (url.endsWith('/api/cloud/status')) {
      return response(200, {
        success: true, enabled: true,
        supabase: { url: 'https://demo.supabase.co', anonKey: 'anon' }
      });
    }
    requested = url;
    return response(200, {});
  };
  const client = new CloudClient({
    fetchImpl,
    storage: memoryStorage(),
    origin: ORIGIN,
    location: { origin: ORIGIN, pathname: '/index.html', search: '' }
  });
  await client.supabaseMagicLink('a@example.com');
  assert(requested.includes('redirect_to=http%3A%2F%2Fstudio.test%2Findex.html'), requested);
  assert(!requested.includes('access_token'), 'token leaked into URL');
});

await test('status failure degrades to disabled instead of throwing', async () => {
  const client = new CloudClient({
    fetchImpl: async () => { throw new Error('offline'); },
    storage: memoryStorage(),
    origin: ORIGIN
  });
  const status = await client.status();
  assert(status.enabled === false, 'should be disabled');
  assert(status.error.includes('offline'), status.error);
});

await test('listCommunity and uploadAsset pass category and thumbnail metadata cleanly', async () => {
  let calledUrl = '';
  let postedBody = null;
  const fetchImpl = async (url, init = {}) => {
    if (url.endsWith('/api/cloud/status')) return response(200, { success: true, enabled: true });
    if (url.includes('/api/cloud/community')) {
      calledUrl = url;
      return response(200, { success: true, items: [{ id: 'c1', category: 'vegetation', title: 'Pine' }] });
    }
    if (url.endsWith('/api/cloud/assets')) {
      postedBody = JSON.parse(init.body);
      return response(200, { success: true, asset: { id: 'c1', category: 'vegetation' } });
    }
    throw new Error(`unexpected ${url}`);
  };
  const storage = memoryStorage({
    [sessionStorageKey]: JSON.stringify({
      provider: 'supabase', accessToken: 'tok', refreshToken: 'r1',
      expiresAt: Date.now() + 3_600_000, user: { id: 'u1', email: 'a@b.c' }
    })
  });
  const client = new CloudClient({ fetchImpl, storage, origin: ORIGIN });
  const comm = await client.listCommunity({ category: 'vegetation', q: 'pine', limit: 24 });
  assert(calledUrl.includes('category=vegetation') && calledUrl.includes('q=pine'), calledUrl);
  assert(comm.items.length === 1 && comm.items[0].title === 'Pine', 'community items');
  await client.uploadAsset(new Uint8Array([0x67, 0x6c, 0x54, 0x46]), 'pine.glb', {
    title: 'Pine', category: 'vegetation', tags: ['tree'], thumbnailBase64: 'data:image/png;base64,AA==', public: true
  });
  assert(postedBody.category === 'vegetation' && postedBody.title === 'Pine' && postedBody.thumbnailBase64, 'metadata sent');
});

await test('singleflight refreshSession coalesces concurrent refresh calls into one request', async () => {
  let refreshCount = 0;
  const fetchImpl = async (url) => {
    if (url.endsWith('/api/cloud/status')) {
      return response(200, { success: true, enabled: true, supabase: { url: 'https://demo.supabase.co', anonKey: 'anon' } });
    }
    if (url.includes('/auth/v1/token')) {
      refreshCount += 1;
      await new Promise((r) => setTimeout(r, 15));
      return response(200, { access_token: 'fresh-tok', refresh_token: 'fresh-ref', expires_in: 3600, user: { id: 'u1', email: 'a@b.c' } });
    }
    return response(200, { success: true, ok: true });
  };
  const client = new CloudClient({
    fetchImpl,
    storage: memoryStorage({
      [sessionStorageKey]: JSON.stringify({
        provider: 'supabase', accessToken: 'old', refreshToken: 'r1',
        expiresAt: 1000, user: { id: 'u1', email: 'a@b.c' }
      })
    }),
    origin: ORIGIN,
    now: () => 2000
  });
  const [r1, r2, r3] = await Promise.all([client.refreshSession(), client.refreshSession(), client.refreshSession()]);
  assert(refreshCount === 1, `expected 1 refresh call, got ${refreshCount}`);
  assert(r1.accessToken === 'fresh-tok' && r2.accessToken === 'fresh-tok' && r3.accessToken === 'fresh-tok', 'shared refreshed token');
});

await test('exportMyData, deleteMyAccount, and aiChat send expected endpoints and BYOK header', async () => {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, method: init.method || 'GET', headers: init.headers || {}, body: init.body });
    if (url.endsWith('/api/cloud/me/export')) return response(200, { exportedAt: '2026-11-25', user: { id: 'u1' } });
    if (url.endsWith('/api/cloud/ai/chat')) return response(200, { success: true, reply: 'ok' });
    if (url.endsWith('/api/cloud/me/delete')) return response(200, { success: true, deleted: true });
    throw new Error(`unexpected ${url}`);
  };
  const client = new CloudClient({
    fetchImpl,
    storage: memoryStorage({
      [sessionStorageKey]: JSON.stringify({
        provider: 'local', accessToken: 'tok1', expiresAt: 9_999_999_999, user: { id: 'u1', email: 'a@b.c' }
      })
    }),
    origin: ORIGIN,
    now: () => 1000
  });
  const exp = await client.exportMyData();
  assert(exp.user.id === 'u1', 'exported user');
  await client.aiChat({ messages: [{ role: 'user', content: 'hi' }] }, { byokKey: 'sk-user-byok' });
  const aiCall = calls.find((c) => c.url.endsWith('/api/cloud/ai/chat'));
  assert(aiCall.headers['X-AI-Provider-Key'] === 'sk-user-byok', 'BYOK header sent');
  assert(aiCall.headers.Authorization === 'Bearer tok1', 'Bearer sent');
  await client.deleteMyAccount('DELETE');
  assert(!client.isSignedIn(), 'signed out after deleteMyAccount');
});

if (failures.length) {
  console.log(`\n${failures.length} CLOUD CLIENT TEST(S) FAILED`);
  process.exitCode = 1;
} else {
  console.log(`\nALL ${passed} CLOUD CLIENT TESTS PASSED`);
}
