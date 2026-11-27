/**
 * Test Shading & Normals (Phase 2):
 * - computeAutoSmoothNormals (angle threshold, sharp edge splitting, smooth curve preservation)
 * - recalculateNormals (Shift+N outside, Shift+Ctrl+N inside)
 * - flipNormals (vector negation and triangle winding reversal)
 * - setMeshShading / getShadingState / SHADING_MODES
 *
 * Chạy: node --import ./tests/three-resolve-hooks.mjs tests/test_shading_normals.mjs
 */
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
  computeAutoSmoothNormals,
  recalculateNormals,
  flipNormals
} from '../js/core/geometry/normals.js';
import {
  setMeshShading,
  getShadingState,
  SHADING_MODES,
  flipMeshNormals,
  recalculateMeshNormals
} from '../js/core/shading.js';

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

// ---------------------------------------------------------------------------
// 1. AUTO-SMOOTH NORMALS TESTS
// ---------------------------------------------------------------------------
await test('Auto-Smooth: Khối hộp 90° giữ góc sắc (split normals) với ngưỡng 30°', async () => {
  const box = new THREE.BoxGeometry(1, 1, 1);
  const autoSmoothed = computeAutoSmoothNormals(box, 30 * Math.PI / 180);

  assert.ok(autoSmoothed, 'Không tính được auto-smooth normals');
  const norm = autoSmoothed.attributes.normal;
  assert.ok(norm, 'Geometry thiếu attribute normal');

  // Khối hộp có 6 mặt, góc nhị diện giữa các mặt là 90° > 30°
  // Do đó, các mặt không được trộn pháp tuyến: pháp tuyến phải thuần trục (±1, 0, 0)
  for (let i = 0; i < norm.count; i++) {
    const nx = Math.abs(norm.getX(i));
    const ny = Math.abs(norm.getY(i));
    const nz = Math.abs(norm.getZ(i));
    const maxAxis = Math.max(nx, ny, nz);
    assert.ok(Math.abs(maxAxis - 1.0) < 1e-4, `Pháp tuyến hộp phải vuông góc với mặt, nhận được (${nx}, ${ny}, ${nz})`);
  }
});

await test('Auto-Smooth: Hình trụ (Cylinder) làm mượt thân cong nhưng giữ mép nắp 90°', async () => {
  const cylinder = new THREE.CylinderGeometry(1, 1, 2, 32); // 32 lát cắt quanh trục: góc giữa các mặt ~11.25° < 30°
  const autoSmoothed = computeAutoSmoothNormals(cylinder, 30 * Math.PI / 180);

  const norm = autoSmoothed.attributes.normal;
  const pos = autoSmoothed.attributes.position;

  // Kiểm tra đỉnh trên thân trụ: y trong khoảng (-0.9, 0.9)
  // Pháp tuyến thân trụ phải có ny ~ 0 và hướng bán kính (x, 0, z)
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i);
    if (Math.abs(y) < 0.8) {
      const ny = norm.getY(i);
      assert.ok(Math.abs(ny) < 1e-3, `Pháp tuyến thân trụ phải song song mặt ngang, ny = ${ny}`);
    }
  }
});

// ---------------------------------------------------------------------------
// 2. RECALCULATE NORMALS (OUTSIDE / INSIDE)
// ---------------------------------------------------------------------------
await test('Recalculate Normals Outside đảm bảo pháp tuyến hướng ra ngoài tâm', async () => {
  const sphere = new THREE.SphereGeometry(1, 12, 12);
  // Cố ý đảo ngược một số tam giác
  const flipped = flipNormals(sphere);
  const recalced = recalculateNormals(flipped, false);

  const pos = recalced.attributes.position;
  const norm = recalced.attributes.normal;

  // Đối với hình cầu tâm (0,0,0), mọi đỉnh có mặt tiếp giáp pháp tuyến phải hướng ra ngoài: dot(pos, norm) > 0
  let positiveDots = 0;
  let activeVerts = 0;
  for (let i = 0; i < pos.count; i++) {
    const lenSq = norm.getX(i) ** 2 + norm.getY(i) ** 2 + norm.getZ(i) ** 2;
    if (lenSq < 0.1) continue; // Bỏ qua đỉnh mồ côi không có tam giác của Three Sphere
    activeVerts++;
    const dot = pos.getX(i) * norm.getX(i) + pos.getY(i) * norm.getY(i) + pos.getZ(i) * norm.getZ(i);
    if (dot > 0.5) positiveDots++;
  }
  assert.equal(positiveDots, activeVerts, 'Tất cả đỉnh hình cầu có tam giác phải có pháp tuyến hướng ra ngoài');
});

await test('Recalculate Normals Inside đảo pháp tuyến hướng vào trong tâm', async () => {
  const sphere = new THREE.SphereGeometry(1, 8, 8);
  const recalcedInside = recalculateNormals(sphere, true);

  const pos = recalcedInside.attributes.position;
  const norm = recalcedInside.attributes.normal;

  let negativeDots = 0;
  let activeVerts = 0;
  for (let i = 0; i < pos.count; i++) {
    const lenSq = norm.getX(i) ** 2 + norm.getY(i) ** 2 + norm.getZ(i) ** 2;
    if (lenSq < 0.1) continue;
    activeVerts++;
    const dot = pos.getX(i) * norm.getX(i) + pos.getY(i) * norm.getY(i) + pos.getZ(i) * norm.getZ(i);
    if (dot < -0.5) negativeDots++;
  }
  assert.equal(negativeDots, activeVerts, 'Tất cả đỉnh hình cầu có tam giác phải có pháp tuyến hướng vào trong');
});

// ---------------------------------------------------------------------------
// 3. FLIP NORMALS
// ---------------------------------------------------------------------------
await test('Flip Normals đảo chiều vector pháp tuyến và thứ tự cuộn chỉ số (winding)', async () => {
  const geom = new THREE.BoxGeometry(1, 1, 1);
  const origNorm = new Float32Array(geom.attributes.normal.array);
  const origIndex = geom.index ? new Uint16Array(geom.index.array) : null;

  const flipped = flipNormals(geom);
  const newNorm = flipped.attributes.normal.array;

  for (let i = 0; i < origNorm.length; i++) {
    assert.equal(newNorm[i], -origNorm[i], `Normal index ${i} phải đảo dấu`);
  }

  if (origIndex && flipped.index) {
    const newIdx = flipped.index.array;
    // Kiểm tra tam giác đầu tiên đã tráo vertex 1 và 2
    assert.equal(newIdx[0], origIndex[0]);
    assert.equal(newIdx[1], origIndex[2]);
    assert.equal(newIdx[2], origIndex[1]);
  }
});

// ---------------------------------------------------------------------------
// 4. SHADING MANAGER & METADATA
// ---------------------------------------------------------------------------
await test('setMeshShading chuyển đổi mượt mà giữa Flat, Smooth, Auto và lưu userData', async () => {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial());

  setMeshShading(mesh, SHADING_MODES.FLAT);
  let state = getShadingState(mesh);
  assert.equal(state.mode, 'flat');

  setMeshShading(mesh, SHADING_MODES.AUTO, { angleDeg: 45 });
  state = getShadingState(mesh);
  assert.equal(state.mode, 'auto');
  assert.equal(state.angleDeg, 45);

  setMeshShading(mesh, SHADING_MODES.SMOOTH);
  state = getShadingState(mesh);
  assert.equal(state.mode, 'smooth');
});

if (failures.length > 0) {
  console.error(`\n${failures.length} test(s) failed`);
  process.exit(1);
} else {
  console.log('\nAll shading & normal tests passed!');
}
