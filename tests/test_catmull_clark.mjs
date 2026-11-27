/**
 * Test Catmull-Clark Subdivision Surface (Phase 3):
 * - True Catmull-Clark curvature smoothing with face & edge points
 * - Level 1, 2, 3 convergence towards limit surface
 * - Simple subdivision mode (linear tessellation without smoothing)
 * - Boundary edge & vertex preservation
 * - Crease support for sharp edge preservation
 * - Integration with modifier stack in modifiers.js
 *
 * Chạy: node --import ./tests/three-resolve-hooks.mjs tests/test_catmull_clark.mjs
 */
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { subdivideCatmullClark } from '../js/core/geometry/catmull-clark.js';
import { SubdivisionModifier, applyModifier, recomputeModifiers, getModifierStack } from '../js/core/modifiers.js';

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
// 1. CATMULL-CLARK SMOOTHING CONVERGENCE
// ---------------------------------------------------------------------------
await test('Catmull-Clark: Khối hộp làm tròn mượt mà qua các level 1, 2, 3', async () => {
  const box = new THREE.BoxGeometry(2, 2, 2);
  const sub1 = subdivideCatmullClark(box, { levels: 1 });
  const sub2 = subdivideCatmullClark(box, { levels: 2 });
  const sub3 = subdivideCatmullClark(box, { levels: 3 });

  assert.ok(sub1 && sub2 && sub3);
  const c1 = sub1.attributes.position.count;
  const c2 = sub2.attributes.position.count;
  const c3 = sub3.attributes.position.count;

  // Mỗi tam giác ở level 1 biến thành 3 quad = 6 tris -> 12 * 6 = 72 tris = 216 verts
  assert.equal(c1, 216, `Level 1 mong muốn 216 đỉnh, nhận được ${c1}`);
  // Level 2: mỗi quad biến thành 4 quad -> x4
  assert.equal(c2, c1 * 4, `Level 2 (${c2}) phải gấp 4 lần Level 1 (${c1})`);
  assert.equal(c3, c2 * 4, `Level 3 (${c3}) phải gấp 4 lần Level 2 (${c2})`);

  // Đỉnh góc của hộp ban đầu ở khoảng cách sqrt(3) ~ 1.732 từ tâm
  // Sau khi Catmull-Clark làm tròn, đỉnh góc phải co lại về phía mặt cầu giới hạn (< 1.732)
  const pos1 = sub1.attributes.position;
  let maxDist1 = 0;
  for (let i = 0; i < pos1.count; i++) {
    const d = Math.hypot(pos1.getX(i), pos1.getY(i), pos1.getZ(i));
    if (d > maxDist1) maxDist1 = d;
  }
  assert.ok(maxDist1 < Math.sqrt(3), `Đỉnh hộp phải bo tròn co lại từ 1.732, nhận được ${maxDist1}`);
});

// ---------------------------------------------------------------------------
// 2. SIMPLE SUBDIVISION MODE
// ---------------------------------------------------------------------------
await test('Catmull-Clark: Chế độ Simple tăng lưới nhưng giữ nguyên góc cạnh phẳng', async () => {
  const box = new THREE.BoxGeometry(2, 2, 2);
  const simpleSub = subdivideCatmullClark(box, { levels: 1, subdivisionType: 'simple' });

  simpleSub.computeBoundingBox();
  const bbox = simpleSub.boundingBox;

  // Bounding box của chế độ Simple giữ nguyên kích thước 2.0x2.0x2.0 chuẩn xác
  assert.ok(Math.abs(bbox.max.x - 1.0) < 1e-4);
  assert.ok(Math.abs(bbox.min.x - (-1.0)) < 1e-4);
  assert.ok(Math.abs(bbox.max.y - 1.0) < 1e-4);
  assert.ok(Math.abs(bbox.min.y - (-1.0)) < 1e-4);
  assert.ok(Math.abs(bbox.max.z - 1.0) < 1e-4);
  assert.ok(Math.abs(bbox.min.z - (-1.0)) < 1e-4);
});

// ---------------------------------------------------------------------------
// 3. BOUNDARY PRESERVATION ON OPEN MESH
// ---------------------------------------------------------------------------
await test('Catmull-Clark: Giữ nguyên chu vi cạnh biên trên bề mặt hở (PlaneGeometry)', async () => {
  const plane = new THREE.PlaneGeometry(2, 2);
  const subPlane = subdivideCatmullClark(plane, { levels: 2 });

  subPlane.computeBoundingBox();
  const bbox = subPlane.boundingBox;

  // Bề mặt hở khi subdivide giữ phẳng ở mặt phẳng Z=0
  for (let i = 0; i < subPlane.attributes.position.count; i++) {
    assert.ok(Math.abs(subPlane.attributes.position.getZ(i)) < 1e-4);
  }
  // Kích thước biên vẫn xấp xỉ [-1, 1]
  assert.ok(Math.abs(bbox.max.x - 1.0) < 0.1);
  assert.ok(Math.abs(bbox.min.x - (-1.0)) < 0.1);
});

// ---------------------------------------------------------------------------
// 4. CREASE SUPPORT
// ---------------------------------------------------------------------------
await test('Catmull-Clark: Crease = 1.0 giữ mép cạnh sắc không bị bo tròn', async () => {
  const box = new THREE.BoxGeometry(2, 2, 2);
  const sharpBox = subdivideCatmullClark(box, { levels: 1, crease: 1.0 });

  sharpBox.computeBoundingBox();
  const bbox = sharpBox.boundingBox;
  const size = new THREE.Vector3();
  bbox.getSize(size);

  // Khi crease = 1.0, cạnh hộp giữ nguyên độ sắc bén ở ngoài biên
  assert.ok(Math.abs(size.x - 2.0) < 0.05, `Size x phải gần 2.0 với crease=1, nhận được ${size.x}`);
});

// ---------------------------------------------------------------------------
// 5. MODIFIER STACK INTEGRATION
// ---------------------------------------------------------------------------
await test('Catmull-Clark: Tích hợp Modifier Stack trong modifiers.js', async () => {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial());
  const mod = applyModifier(mesh, 'subdivide', { subdivisions: 2 });

  assert.ok(mod && (mod.type === 'subdivide' || mod.type === 'subdivision'));
  const stack = getModifierStack(mesh);
  assert.equal(stack.length, 1);
  assert.equal(mesh.geometry.attributes.position.count, 216 * 4);
});

if (failures.length > 0) {
  console.error(`\n${failures.length} test(s) failed`);
  process.exit(1);
} else {
  console.log('\nAll Catmull-Clark tests passed!');
}
