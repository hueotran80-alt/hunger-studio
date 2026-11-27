/**
 * Test Prefab Library (Giai đoạn 2.2) — phần thuần dữ liệu + place() với
 * RapidStudio giả lập (không tải .glb thật).
 *   node --import ./tests/three-resolve-hooks.mjs tests/test_prefab_library.mjs
 */
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { PrefabLibrary, prefabLibrary } from '../js/scripting/prefab-library.js';

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

await test('catalog mặc định có prefab rigged + chiều cao chuẩn', async () => {
  const lib = new PrefabLibrary();
  const mannequin = lib.get('mannequin');
  assert.ok(mannequin, 'thiếu mannequin');
  assert.ok(mannequin.rigged, 'mannequin phải rigged');
  assert.ok(mannequin.naturalHeight > 1 && mannequin.naturalHeight < 2);
  assert.ok(lib.get('bot') && lib.get('head_scan'));
  // Backward-compatible legacy aliases
  assert.equal(lib.get('michelle')?.id, 'mannequin');
  assert.equal(lib.get('soldier')?.id, 'bot');
  assert.ok(lib.list().length >= 3);
});

await test('search() khớp tiếng Việt không dấu + từ khoá tiếng Anh', async () => {
  const lib = new PrefabLibrary();
  const top1 = lib.search('nhan vat chien binh')[0];
  assert.equal(top1?.id, 'bot');
  const top2 = lib.search('a woman dancing')[0];
  assert.equal(top2?.id, 'mannequin');
  const top3 = lib.search('human face portrait')[0];
  assert.equal(top3?.id, 'head_scan');
  assert.equal(lib.search('con meo').length, 0, 'không khớp thì mảng rỗng');
});

await test('search() xếp hạng theo điểm giảm dần', async () => {
  const lib = new PrefabLibrary();
  const res = lib.search('nguoi linh chien binh');
  assert.ok(res.length >= 1);
  assert.equal(res[0].id, 'bot'); // khớp cả 'linh' + 'chiến binh' -> cao nhất
});

await test('register() thêm prefab mới và ghi đè id trùng', async () => {
  const lib = new PrefabLibrary();
  lib.register({ id: 'tree_oak', name: 'Cây sồi', url: 'models/oak.glb', keywords: ['tree', 'cay'], naturalHeight: 5 });
  assert.equal(lib.get('tree_oak').naturalHeight, 5);
  lib.register({ id: 'tree_oak', name: 'Cây sồi v2', url: 'models/oak2.glb', naturalHeight: 6 });
  assert.equal(lib.list().filter((p) => p.id === 'tree_oak').length, 1);
  assert.equal(lib.get('tree_oak').url, 'models/oak2.glb');
});

await test('describeForAI() liệt kê đủ prefab + cú pháp placePrefab', async () => {
  const text = prefabLibrary.describeForAI();
  for (const id of ['mannequin', 'bot', 'head_scan']) {
    assert.ok(text.includes(`"${id}"`), `thiếu id ${id}`);
  }
  assert.ok(text.includes('studio.placePrefab'));
  assert.ok(text.includes('await'));
});

await test('place() scale theo height và hướng mặt +Z chuẩn CC0, đăng ký vào cảnh', async () => {
  const registered = [];
  const mockStudio = {
    THREE,
    _register(obj, name) {
      if (name) obj.name = name;
      registered.push(obj);
      return obj;
    },
    log: () => { },
  };
  const lib = new PrefabLibrary({ studio: mockStudio });

  // Giả template thay vì tải .glb: hộp cao 1.66 "mét" đại diện Mannequin CC0
  const fakeTemplate = new THREE.Mesh(new THREE.BoxGeometry(0.5, 1.66, 0.3));
  fakeTemplate.scale.setScalar(1); // đã ở naturalHeight
  lib._cache.set('models/Mannequin_CC0.glb', fakeTemplate);
  lib._cache.set('models/Bot_CC0.glb', (() => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(0.6, 1.8, 0.4));
    return m;
  })());

  const mannequin = await lib.place('mannequin', { x: 1, z: 2, height: 1.8 });
  assert.ok(Math.abs(mannequin.scale.x - 1.8 / 1.66) < 1e-6, `scale sai: ${mannequin.scale.x}`);
  assert.equal(Math.round(mannequin.rotation.y), 0);
  assert.equal(mannequin.name, 'mannequin');
  assert.equal(registered.length, 1);

  const bot = await lib.place('bot', { height: 1.8 });
  assert.equal(Math.round(bot.rotation.y), 0);
  assert.ok(bot.children.length === 0); // đơn giản: là mesh trần

  // Legacy alias resolves to CC0 mannequin cleanly
  const tiny = await lib.place('michelle', { scale: 0.5, height: 9 });
  assert.ok(Math.abs(tiny.scale.x - 0.5) < 1e-6);
});

await test('place() với id lạ ném lỗi rõ ràng', async () => {
  const lib = new PrefabLibrary({ studio: { THREE, _register: () => { } } });
  await assert.rejects(() => lib.place('khong_ton_tai'), /does not exist|not found/i);
});

if (failures.length) {
  console.error(`\n${failures.length} test FAIL`);
  process.exit(1);
}
console.log('\nALL PREFAB LIBRARY TESTS PASSED');
