/**
 * Embed/share protocol: URL sanitizing, payload codec, link builders.
 * Run: node tests/test_embed_core.mjs
 */
import { gunzipSync } from '../vendor/three/addons/libs/fflate.module.js';
import {
  DEFAULT_OPTIONS,
  WARN_SHARE_BYTES,
  MAX_SHARE_BYTES,
  parseEmbedLocation,
  readEmbedOptions,
  sanitizeModelUrl,
  sanitizeBackground,
  encodeSharePayload,
  decodeSharePayload,
  serializeEmbedOptions,
  buildShareUrl,
  buildHostedEmbedUrl,
  buildIframeSnippet,
  shareSizeVerdict,
  payloadByteLength,
  isEmbedRedirect,
  pickAnimationClip,
  utf8ByteLength
} from '../js/embed/embed-core.js';

let passed = 0;
const failures = [];
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`ok   ${name}`);
  } catch (err) {
    failures.push({ name, err });
    console.log(`FAIL ${name}\n     ${err.stack || err.message}`);
  }
}
function assert(cond, message) {
  if (!cond) throw new Error(message);
}
async function assertThrows(fn, message) {
  let threw = false;
  try { await fn(); } catch (_) { threw = true; }
  assert(threw, message);
}

await test('parse: defaults when only a model is given', () => {
  const parsed = parseEmbedLocation('?glb=/models/Michelle.glb', '');
  assert(parsed.error === null, 'must parse');
  assert(parsed.src === '/models/Michelle.glb', `src=${parsed.src}`);
  assert(parsed.options.autoplay === true && parsed.options.loop === true, 'play defaults');
  assert(parsed.options.bg === DEFAULT_OPTIONS.bg, 'default bg');
  assert(parsed.options.dpr === 0, 'auto dpr');
});

await test('parse: rejects script-capable URLs and HTML data URLs', () => {
  for (const bad of [
    'javascript:alert(1)',
    ' JavaScript:alert(1)',
    'vbscript:msgbox(1)',
    'data:text/html,<script>alert(1)</script>',
    'file:///etc/passwd',
    'ftp://example.com/a.glb'
  ]) {
    assert(sanitizeModelUrl(bad) === null, `must reject ${bad}`);
    const parsed = parseEmbedLocation(`?glb=${encodeURIComponent(bad)}`, '');
    assert(parsed.error === 'missing-source', `parse must report missing source for ${bad}`);
  }
});

await test('parse: accepts http(s), blob and relative paths; rejects protocol-relative and mixed-content', () => {
  assert(sanitizeModelUrl('https://cdn.example.com/a.glb') === 'https://cdn.example.com/a.glb', 'https');
  assert(sanitizeModelUrl('http://cdn.example.com/a.glb') === 'http://cdn.example.com/a.glb', 'http');
  assert(sanitizeModelUrl('http://cdn.example.com/a.glb', { pageProtocol: 'https:' }) === null, 'reject mixed content on https');
  assert(sanitizeModelUrl('blob:http://localhost:8080/abc') === 'blob:http://localhost:8080/abc', 'blob');
  assert(sanitizeModelUrl('/models/a.glb') === '/models/a.glb', 'absolute path');
  assert(sanitizeModelUrl('./models/a.glb') === './models/a.glb', 'relative path');
  assert(sanitizeModelUrl('//cdn.example.com/a.glb') === null, 'protocol-relative rejected');
});

await test('parse: boolean flags and option aliases', () => {
  const o = readEmbedOptions(new URLSearchParams('autoplay=0&loop=no&controls=false&ui=off&grid=0&shadow=0&autorotate=1&badge=0&fit=0&dpr=9&clip=%20Walk%20'));
  assert(o.autoplay === false, 'autoplay');
  assert(o.loop === false, 'loop');
  assert(o.controls === false, 'controls');
  assert(o.ui === false, 'ui');
  assert(o.grid === false, 'grid');
  assert(o.shadow === false, 'shadow');
  assert(o.autorotate === true, 'autorotate');
  assert(o.badge === false, 'badge');
  assert(o.fit === false, 'fit');
  assert(o.dpr === 2, `dpr clamped to 2, got ${o.dpr}`);
  assert(o.clip === 'Walk', `clip trimmed, got "${o.clip}"`);
});

await test('parse: transparent overrides bg; invalid bg falls back', () => {
  assert(readEmbedOptions(new URLSearchParams('transparent=1&bg=#ff0000')).bg === 'transparent', 'transparent wins');
  assert(readEmbedOptions(new URLSearchParams('bg=transparent')).transparent === true, 'bg=transparent');
  assert(readEmbedOptions(new URLSearchParams('bg=red')).bg === DEFAULT_OPTIONS.bg, 'named colors rejected');
  assert(sanitizeBackground('#abc') === '#abc', 'short hex');
  assert(sanitizeBackground('abc') === '#abc', 'hex without hash');
  assert(sanitizeBackground('#11223344') === '#11223344', 'alpha hex');
});

await test('payload: gzip roundtrip keeps every byte', async () => {
  const bytes = new Uint8Array(40_000);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 7 + (i >> 3)) & 0xff;
  const payload = await encodeSharePayload(bytes);
  assert(payload.startsWith('z'), `expected gzip flag, got ${payload[0]}`);
  assert(/^[A-Za-z0-9_-]+$/.test(payload.slice(1)), 'payload must be base64url');
  const decoded = await decodeSharePayload(payload);
  assert(decoded.length === bytes.length, 'length mismatch');
  for (let i = 0; i < bytes.length; i++) {
    if (decoded[i] !== bytes[i]) throw new Error(`byte ${i}: ${decoded[i]} != ${bytes[i]}`);
  }
});

await test('payload: incompressible data falls back to raw flag', async () => {
  const bytes = new Uint8Array([1, 2, 3]);
  const payload = await encodeSharePayload(bytes);
  assert(payload.startsWith('r'), `expected raw flag for tiny input, got ${payload[0]}`);
  const decoded = await decodeSharePayload(payload);
  assert(decoded.length === 3 && decoded[2] === 3, 'raw roundtrip');
});

await test('payload: corrupt/unknown formats are rejected', async () => {
  await assertThrows(() => decodeSharePayload(''), 'empty');
  await assertThrows(() => decodeSharePayload('x123'), 'unknown flag');
  await assertThrows(() => decodeSharePayload('z***'), 'invalid base64url');
  await assertThrows(() => encodeSharePayload(new Uint8Array(0)), 'empty model');
});

await test('payload: injected fflate fallback works without DecompressionStream', async () => {
  const bytes = new Uint8Array(2048);
  for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251;
  const payload = await encodeSharePayload(bytes);
  const original = globalThis.DecompressionStream;
  try {
    globalThis.DecompressionStream = undefined;
    const out = await decodeSharePayload(payload, { gunzip: (b) => gunzipSync(b) });
    assert(out.length === bytes.length && out[100] === bytes[100], 'fallback roundtrip');
  } finally {
    globalThis.DecompressionStream = original;
  }
});

await test('payload from hash is parsed; search z is a fallback', () => {
  const fromHash = parseEmbedLocation('?ui=0', '#z=zABCD');
  assert(fromHash.payload === 'zABCD', `hash payload=${fromHash.payload}`);
  const fromSearch = parseEmbedLocation('?z=zWXYZ', '');
  assert(fromSearch.payload === 'zWXYZ', 'search payload');
  const both = parseEmbedLocation('?z=zAAA', '#z=zBBB');
  assert(both.payload === 'zBBB', 'hash wins');
});

await test('options: only non-defaults are serialized', () => {
  const params = serializeEmbedOptions({ ...DEFAULT_OPTIONS });
  assert(params.toString() === '', `defaults should serialize empty, got ${params}`);
  const custom = serializeEmbedOptions({ ...DEFAULT_OPTIONS, grid: false, autorotate: true, bg: '#ff0000', clip: 'Idle' });
  assert(custom.get('grid') === '0', 'grid');
  assert(custom.get('autorotate') === '1', 'autorotate');
  assert(custom.get('bg') === '#ff0000', 'bg');
  assert(custom.get('clip') === 'Idle', 'clip');
});

await test('buildShareUrl: payload lives in the fragment and no token leaks', () => {
  const url = buildShareUrl('https://studio.example.com/embed.html?token=SECRET', 'zABC', {
    ...DEFAULT_OPTIONS,
    controls: false,
    bg: '#222222'
  });
  assert(url.startsWith('https://studio.example.com/embed.html?'), url);
  assert(!url.includes('token'), 'token must not be copied');
  assert(!url.includes('#SECRET'), 'secret must not be copied');
  assert(url.endsWith('#z=zABC'), `hash missing: ${url}`);
  const parsed = new URL(url);
  assert(parsed.searchParams.get('controls') === '0', 'controls');
  assert(parsed.searchParams.get('bg') === '#222222', 'bg');
});

await test('buildHostedEmbedUrl: http(s) only, keeps options', () => {
  const url = buildHostedEmbedUrl('http://127.0.0.1:8080/embed.html', 'https://cdn.example.com/a.glb', {
    ...DEFAULT_OPTIONS, grid: false
  });
  const parsed = new URL(url);
  assert(parsed.searchParams.get('glb') === 'https://cdn.example.com/a.glb', 'glb');
  assert(parsed.searchParams.get('grid') === '0', 'grid');
  assert(parsed.hash === '', 'hosted links have no fragment');
  let threw = false;
  try { buildHostedEmbedUrl('http://x/embed.html', 'javascript:alert(1)'); } catch (_) { threw = true; }
  assert(threw, 'must reject javascript:');
});

await test('iframe snippet escapes attribute-breaking characters', () => {
  const snippet = buildIframeSnippet('https://x/embed.html?glb=https://a/b.glb&x=1&y="2', { title: 'A "model" & more' });
  assert(snippet.includes('&amp;'), 'ampersand escaped');
  assert(!snippet.includes('"2"'), 'quote escaped');
  assert(snippet.includes('&quot;model&quot;'), 'title quote escaped');
  assert(snippet.includes('allowfullscreen'), 'fullscreen allowed');
  assert(snippet.includes('loading="lazy"'), 'lazy loaded');
});

await test('size verdict thresholds', () => {
  assert(payloadByteLength('z' + 'A'.repeat(4000)) >= 2999, 'payload byte estimate');
  assert(payloadByteLength('') === 0, 'empty payload');
  assert(shareSizeVerdict(10_000).level === 'ok', 'ok');
  assert(shareSizeVerdict(WARN_SHARE_BYTES + 1).level === 'warn', 'warn');
  assert(shareSizeVerdict(MAX_SHARE_BYTES + 1).level === 'too-large', 'too large');
});

await test('?view=embed redirect detection', () => {
  assert(isEmbedRedirect('?view=embed') === true, 'embed');
  assert(isEmbedRedirect('?view=VIEWER') === true, 'viewer');
  assert(isEmbedRedirect('?tab=hunyuan3d') === false, 'tab');
  assert(isEmbedRedirect('') === false, 'empty');
});

await test('clip picker: exact, case-insensitive, contains, then longest', () => {
  const clips = [
    { name: 'Idle', duration: 2 },
    { name: 'Run', duration: 1 },
    { name: 'LongTake', duration: 9 }
  ];
  assert(pickAnimationClip(clips, 'Run').name === 'Run', 'exact');
  assert(pickAnimationClip(clips, 'run').name === 'Run', 'case-insensitive');
  assert(pickAnimationClip(clips, 'ake').name === 'LongTake', 'contains');
  assert(pickAnimationClip(clips, 'missing').name === 'LongTake', 'longest fallback');
  assert(pickAnimationClip(clips, '').name === 'LongTake', 'no name means longest');
  assert(pickAnimationClip([], 'x') === null, 'empty list');
  assert(pickAnimationClip(null, 'x') === null, 'null list');
});

await test('utf8ByteLength counts non-ASCII names as bytes', () => {
  assert(utf8ByteLength('abc') === 3, 'ascii');
  assert(utf8ByteLength('ế') === 3, `utf8, got ${utf8ByteLength('ế')}`);
});

if (failures.length) {
  console.log(`\n${failures.length} EMBED CORE TEST(S) FAILED`);
  process.exitCode = 1;
} else {
  console.log(`\nALL ${passed} EMBED CORE TESTS PASSED`);
}
