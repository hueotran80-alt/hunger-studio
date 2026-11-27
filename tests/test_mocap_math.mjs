/**
 * Test module toán chung mocap-math.js (chạy bằng Node thuần, không DOM/Three).
 */
import assert from 'node:assert/strict';
import {
  clamp, median, closestFrameIndexByTime, POSE_BONE_CONNECTIONS,
} from '../js/animation/mocap-math.js';

const failures = [];
async function test(name, fn) {
  try {
    await fn();
    console.log(`✓ ${name}`);
  } catch (err) {
    failures.push(name);
    console.error(`✗ ${name}\n  ${err.message}`);
  }
}

await test('clamp kẹp đúng biên', async () => {
  assert.equal(clamp(5, 0, 10), 5);
  assert.equal(clamp(-1, 0, 10), 0);
  assert.equal(clamp(11, 0, 10), 10);
});

await test('median đúng với mảng lẻ/chẵn và bỏ NaN', async () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.equal(median([NaN, 2, 1, Infinity, 3]), 2);
  assert.equal(median([]), null);
  assert.equal(median([NaN]), null);
});

await test('closestFrameIndexByTime trỏ đúng frame giữa/hai biên', async () => {
  const frames = [0, 0, 0.1, 0.2, 0.3].map((time, i) => ({ time, i }));
  assert.equal(closestFrameIndexByTime(frames, 0.02), 1);
  assert.equal(closestFrameIndexByTime(frames, 0.12), 2);
  assert.equal(closestFrameIndexByTime(frames, 0.24), 3); // hoà 0,2/0,3 thì thắng phía sau nhỏ hơn mới đổi
  assert.equal(closestFrameIndexByTime(frames, -5), 0);
  assert.equal(closestFrameIndexByTime(frames, 99), 4);
  assert.equal(closestFrameIndexByTime([], 1), -1);
});

await test('closestFrameIndexByTime nhận cả mảng số thuần', async () => {
  assert.equal(closestFrameIndexByTime([0, 0.5, 1.0], 0.4), 1);
  assert.equal(closestFrameIndexByTime([0, 0.5, 1.0], 0.9), 2);
});

await test('POSE_BONE_CONNECTIONS dùng chỉ số landmark MediaPipe hợp lệ', async () => {
  assert.ok(POSE_BONE_CONNECTIONS.length >= 20);
  for (const [a, b] of POSE_BONE_CONNECTIONS) {
    assert.ok(Number.isInteger(a) && a >= 0 && a <= 32, `landmark ${a} ngoài phạm vi`);
    assert.ok(Number.isInteger(b) && b >= 0 && b <= 32, `landmark ${b} ngoài phạm vi`);
    assert.notEqual(a, b);
  }
  // Không có cặp trùng
  const keys = POSE_BONE_CONNECTIONS.map(([a, b]) => (a < b ? `${a}-${b}` : `${b}-${a}`));
  assert.equal(new Set(keys).size, keys.length, 'có cặp kết nối trùng');
});

if (failures.length) {
  console.error(`\n${failures.length} test FAIL`);
  process.exit(1);
}
console.log('\nAll mocap-math tests passed');
