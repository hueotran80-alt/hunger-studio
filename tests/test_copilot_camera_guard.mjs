/**
 * Test bản vá camera-guard & animate-bridge (Giai đoạn 2.2 follow-up).
 *   node --import ./tests/three-resolve-hooks.mjs tests/test_copilot_camera_guard.mjs
 *
 * Kiểm chứng:
 * 1. executeGeneratedCode sanitizer vô hiệu hoá code AI tự dịch chuyển camera
 *    người dùng / bật turntable.
 * 2. studio.animate() đăng ký vào engine render loop khi engine đang chạy
 *    (không còn RAF riêng bị đè nhịp).
 */
import assert from 'node:assert/strict';
import * as THREE from 'three';

// ---- 1. CAMERA GUARD SANITIZER ----
// Trích نفس các quy tắc replace trong js/ai/ai-copilot.js để test hành vi.
function sanitize(code) {
  let cleanCode = code.trim();
  cleanCode = cleanCode
    .replace(/(?:window\.)?engine\.camera\.position\.(?:set|copy|lerp|add)[^;]*;?/g, '/* [camera guard] preserve user camera */')
    .replace(/(?:window\.)?engine\.controls\.target\.(?:set|copy)[^;]*;?/g, '/* [camera guard] */')
    .replace(/(?:window\.)?engine\.controls\.enabled\s*=\s*(?:true|false)\s*;?/g, '/* [camera guard] */')
    .replace(/(?:window\.)?camera\.position\.(?:set|copy|lerp|add)[^;]*;?/g, '/* [camera guard] preserve user camera */')
    .replace(/camera\.lookAt\([^)]*\)\s*;?/g, '/* [camera guard] */')
    .replace(/withTurntable:\s*true/g, 'withTurntable: false /* [camera guard] disable auto-turntable */');
  return cleanCode;
}

const failures = [];
async function test(name, fn) {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (err) {
    failures.push(name);
    console.error(`✗ ${name}\n  ${err.message}`);
  }
}

await test('sanitizer chặn engine.camera.position.set(...) của AI', async () => {
  const out = sanitize(`
    studio.addCube({ x: 0, y: 1 });
    window.engine.camera.position.set(10, 20, 30);
    engine.camera.position.set(-5, 2, 8);
    camera.position.copy(new THREE.Vector3(1,2,3));
  `);
  assert.ok(!/\.position\.set\(/.test(out), 'vẫn còn position.set: ' + out);
  assert.ok(out.includes('[camera guard]'));
  assert.ok(out.includes('studio.addCube'), 'không được xoá code hợp lệ');
});

await test('sanitizer chặn controls.target/enabled và camera.lookAt', async () => {
  const out = sanitize(`
    window.engine.controls.target.set(0, 1, 0);
    engine.controls.enabled = false;
    camera.lookAt(0, 1, 0);
  `);
  assert.ok(!/controls\.target\.set/.test(out));
  assert.ok(!/controls\.enabled\s*=/.test(out));
  assert.ok(!/lookAt\(/.test(out));
});

await test('sanitizer tắt withTurntable:true mưu pic', async () => {
  const out = sanitize('studio.setupProStudio({ withTurntable: true });');
  assert.ok(!/withTurntable:\s*true(?!\/\*)/.test(out.replace(/\/\*[^]*?\*\//g, '')));
  assert.ok(out.includes('withTurntable: false'));
});

await test('system prompt chứa luật camera + animation cho Copilot', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../js/ai/ai-copilot.js', import.meta.url), 'utf8');
  assert.ok(src.includes('CRITICAL CAMERA RULES'), 'thiếu mục CAMERA RULES');
  assert.ok(src.includes('ANIMATION HONESTY RULES'), 'thiếu mục ANIMATION HONESTY');
  assert.ok(src.includes('NEVER move the user'), 'thiếu luật không đụng camera người dùng');
});

// ---- 2. ANIMATE ENGINE BRIDGE ----
await test('studio.animate() đăng ký engine render callback khi engine đang chạy', async () => {
  const { RapidStudio } = await import('../js/scripting/rapid-api.js');

  const registrations = [];
  const fakeEngine = {
    isRunning: true,
    addRenderCallback: (cb) => { registrations.push(cb); return () => { }; },
  };
  globalThis.window = {
    engine: fakeEngine,
  };

  const studioInst = new RapidStudio();
  let ticks = 0;
  studioInst.animate(function cb(time, delta, mesh) { ticks++; });

  assert.equal(registrations.length, 1, 'animate phải đăng ký qua engine.addRenderCallback');
  assert.equal(studioInst._animationFrameId ?? null, null, 'không được dùng RAF riêng khi engine chạy');

  // Mô phỏng vài frame render của engine
  registrations[0](0.016);
  registrations[0](0.032);
  assert.ok(ticks >= 2, `callback không được gọi bởi engine loop (ticks=${ticks})`);

  // stopAnimations phải gỡ sạch callback khỏi engine
  studioInst.stopAnimations();
  const ticksBefore = ticks;
  registrations[0](0.1);
  assert.equal(ticks, ticksBefore, 'callback vẫn chạy sau stopAnimations — chưa gỡ');
});

await test('studio.animate() fallback RAF khi engine chưa sẵn sàng', async () => {
  delete globalThis.window.engine;
  globalThis.window = {};
  globalThis.requestAnimationFrame = () => 999;   // stub cho môi trường Node
  globalThis.cancelAnimationFrame = () => {};
  const { RapidStudio } = await import('../js/scripting/rapid-api.js');
  const studioInst = new RapidStudio();
  studioInst.animate(() => { });
  assert.ok(studioInst._animationFrameId !== null && studioInst._animationFrameId !== undefined,
    'fallback RAF phải chạy');
  studioInst.stopAnimations();
});

if (failures.length) {
  console.error(`\n${failures.length} test FAIL`);
  process.exit(1);
}
console.log('\nALL CAMERA-GUARD / ANIMATE-BRIDGE TESTS PASSED');
