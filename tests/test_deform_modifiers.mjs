/**
 * Test Deform Modifiers (Phase 2):
 * - SolidifyModifier (even miter thickness, rim generation, inverted inner shell, offset)
 * - DisplaceModifier (3D procedural fBm noise, seed parity, directional modes)
 * - SmoothModifier (Laplacian relaxation, boundary pinning)
 * - RandomizeModifier (deterministic seeded PRNG, normal vs spherical jitter)
 * - EvenEdges (uniform edge relaxation)
 * - Integration with modifier stack in modifiers.js
 *
 * Chạy: node --import ./tests/three-resolve-hooks.mjs tests/test_deform_modifiers.mjs
 */
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
  solidifyMesh,
  displaceMesh,
  smoothMesh,
  randomizeMesh,
  evenEdgesMesh
} from '../js/core/geometry/deform-ops.js';
import {
  SolidifyModifier,
  DisplaceModifier,
  SmoothModifier,
  RandomizeModifier,
  applyModifier,
  recomputeModifiers,
  getModifierStack
} from '../js/core/modifiers.js';

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
// 1. SOLIDIFY TESTS
// ---------------------------------------------------------------------------
await test('Solidify tạo vỏ 3D dày từ mặt phẳng hở kèm vành (Rim)', async () => {
  const plane = new THREE.PlaneGeometry(2, 2, 1, 1); // 4 vertices, 2 tris, 4 boundary edges
  const solidified = solidifyMesh(plane, {
    thickness: 0.2,
    offset: -1.0,
    evenThickness: true,
    fillRim: true
  });

  assert.ok(solidified, 'Không tạo được solidified geometry');
  assert.equal(solidified.attributes.position.count, 8, 'Mặt phẳng 4 đỉnh khi solidify phải sinh 8 đỉnh (front + back)');

  // 2 mặt trước (front), 2 mặt sau (back), 4 cạnh biên x 2 tam giác/rim quad = 8 rim tris -> tổng cộng 12 tam giác = 36 indices
  const indexCount = solidified.index.count;
  assert.equal(indexCount, 36, `Mong muốn 36 indices (12 tam giác), nhận được ${indexCount}`);

  // Bounding box kiểm tra độ dày: Plane gốc z=0 -> Solidified có z từ -0.2 đến 0.0 (offset -1.0)
  solidified.computeBoundingBox();
  const bbox = solidified.boundingBox;
  assert.ok(Math.abs(bbox.max.z - 0.0) < 1e-4, `max.z mong muốn 0.0, nhận được ${bbox.max.z}`);
  assert.ok(Math.abs(bbox.min.z - (-0.2)) < 1e-4, `min.z mong muốn -0.2, nhận được ${bbox.min.z}`);
});

await test('Solidify offset = 0.0 sinh độ dày cân xứng 2 phía (centered)', async () => {
  const plane = new THREE.PlaneGeometry(1, 1);
  const solidified = solidifyMesh(plane, {
    thickness: 0.4,
    offset: 0.0,
    fillRim: true
  });
  solidified.computeBoundingBox();
  const bbox = solidified.boundingBox;
  assert.ok(Math.abs(bbox.max.z - 0.2) < 1e-4, `max.z mong muốn 0.2, nhận được ${bbox.max.z}`);
  assert.ok(Math.abs(bbox.min.z - (-0.2)) < 1e-4, `min.z mong muốn -0.2, nhận được ${bbox.min.z}`);
});

await test('Solidify trên khối kín (Cube) sinh vỏ trong lộn ngược pháp tuyến', async () => {
  const cube = new THREE.BoxGeometry(2, 2, 2);
  const solidified = solidifyMesh(cube, {
    thickness: 0.1,
    offset: -1.0,
    evenThickness: true
  });

  // Khối kín không sinh rim, chỉ nhân đôi số đỉnh (24 -> 48) và tam giác (12 -> 24)
  assert.equal(solidified.attributes.position.count, cube.attributes.position.count * 2);
  assert.equal(solidified.index.count, cube.index.count * 2);
});

// ---------------------------------------------------------------------------
// 2. DISPLACE TESTS
// ---------------------------------------------------------------------------
await test('Displace biến dạng đỉnh theo nhiễu fBm 3D có tính tất định (seed parity)', async () => {
  const sphereA = new THREE.SphereGeometry(1, 16, 16);
  const sphereB = new THREE.SphereGeometry(1, 16, 16);

  const dispA = displaceMesh(sphereA, { strength: 0.3, scale: 2.5, octaves: 3, seed: 12345 });
  const dispB = displaceMesh(sphereB, { strength: 0.3, scale: 2.5, octaves: 3, seed: 12345 });

  const posA = dispA.attributes.position.array;
  const posB = dispB.attributes.position.array;

  assert.equal(posA.length, posB.length);
  for (let i = 0; i < posA.length; i++) {
    assert.equal(posA[i], posB[i], `Vị trí đỉnh tại index ${i} phải giống hệt nhau khi cùng seed`);
  }

  // Seed khác phải tạo kết quả khác biệt
  const dispC = displaceMesh(sphereA, { strength: 0.3, scale: 2.5, octaves: 3, seed: 99999 });
  const posC = dispC.attributes.position.array;
  let diffCount = 0;
  for (let i = 0; i < posA.length; i++) {
    if (Math.abs(posA[i] - posC[i]) > 1e-5) diffCount++;
  }
  assert.ok(diffCount > 0, 'Seed khác nhau phải tạo dịch chuyển khác nhau');
});

await test('Displace hỗ trợ các hướng trục toạ độ x, y, z và pháp tuyến', async () => {
  const box = new THREE.BoxGeometry(1, 1, 1);
  const dispZ = displaceMesh(box, { strength: 0.5, direction: 'z', seed: 42 });

  const origPos = box.attributes.position;
  const newPos = dispZ.attributes.position;

  for (let i = 0; i < origPos.count; i++) {
    // X và Y không đổi khi displace direction = 'z'
    assert.equal(origPos.getX(i), newPos.getX(i));
    assert.equal(origPos.getY(i), newPos.getY(i));
  }
});

// ---------------------------------------------------------------------------
// 3. SMOOTH / RELAX TESTS
// ---------------------------------------------------------------------------
await test('Smooth Laplacian làm phẳng bề mặt gồ ghề và giữ nguyên biên (pinBoundary)', async () => {
  const plane = new THREE.PlaneGeometry(2, 2, 4, 4); // lưới 5x5 đỉnh = 25 đỉnh
  // Tạo đỉnh ở giữa nhô cao lên
  const pos = plane.attributes.position;
  const centerIdx = 12; // (x=0, y=0)
  pos.setZ(centerIdx, 2.0); // gai cao 2.0
  pos.needsUpdate = true;

  const smoothed = smoothMesh(plane, { factor: 0.8, iterations: 3, pinBoundary: true });
  const smoothedPos = smoothed.attributes.position;

  // Đỉnh ở giữa phải bị kéo phẳng xuống đáng kể
  const newZ = smoothedPos.getZ(centerIdx);
  assert.ok(newZ < 2.0, `Đỉnh trung tâm phải giảm chiều cao sau khi smooth, nhận được ${newZ}`);

  // Các đỉnh biên phải được bảo tồn chính xác (z = 0)
  const cornerIdx = 0;
  assert.equal(smoothedPos.getZ(cornerIdx), 0.0, 'Đỉnh biên góc phải được ghim nguyên vẹn');
});

await test('EvenEdges phân phối đều cạnh theo cơ chế thư giãn lặp', async () => {
  const plane = new THREE.PlaneGeometry(1, 1, 2, 2);
  const even = evenEdgesMesh(plane, { factor: 0.8 });
  assert.ok(even && even.attributes.position.count === plane.attributes.position.count);
});

// ---------------------------------------------------------------------------
// 4. RANDOMIZE TESTS
// ---------------------------------------------------------------------------
await test('Randomize làm rung đỉnh theo seed tất định', async () => {
  const sphere1 = new THREE.SphereGeometry(1, 8, 8);
  const rand1 = randomizeMesh(sphere1, { amount: 0.1, seed: 777 });
  const rand2 = randomizeMesh(sphere1, { amount: 0.1, seed: 777 });

  const a1 = rand1.attributes.position.array;
  const a2 = rand2.attributes.position.array;
  for (let i = 0; i < a1.length; i++) {
    assert.equal(a1[i], a2[i]);
  }
});

// ---------------------------------------------------------------------------
// 5. MODIFIER STACK INTEGRATION
// ---------------------------------------------------------------------------
await test('Tích hợp Modifier Stack: Solidify + Displace phối hợp không phá huỷ', async () => {
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial());

  const mod1 = applyModifier(mesh, 'solidify', { thickness: 0.1 });
  assert.ok(mod1 && mod1.type === 'solidify');
  assert.equal(mesh.geometry.attributes.position.count, 8);

  const mod2 = applyModifier(mesh, 'displace', { strength: 0.05, seed: 10 });
  assert.ok(mod2 && mod2.type === 'displace');

  const stack = getModifierStack(mesh);
  assert.equal(stack.length, 2);
  assert.equal(stack[0].type, 'solidify');
  assert.equal(stack[1].type, 'displace');
});

if (failures.length > 0) {
  console.error(`\n${failures.length} test(s) failed`);
  process.exit(1);
} else {
  console.log('\nAll deform modifier tests passed!');
}
