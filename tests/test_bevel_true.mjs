/**
 * Test True Bevel (Phase 3):
 * - True edge chamfering between adjacent faces (replacing naive face inset)
 * - Multi-segment round profile (1 to 4 segments)
 * - Overlap clamping (clampOverlap = true) prevents self-intersection
 * - Angle limit method (limitMethod = 'angle', angleLimitDeg)
 * - Harden normals support
 * - Integration with modifier stack in modifiers.js
 *
 * Chạy: node --import ./tests/three-resolve-hooks.mjs tests/test_bevel_true.mjs
 */
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { bevelMesh } from '../js/core/geometry/bevel.js';
import { BevelModifier, applyModifier, recomputeModifiers, getModifierStack } from '../js/core/modifiers.js';

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
// 1. FLAT CHAMFER (SEGMENTS = 1)
// ---------------------------------------------------------------------------
await test('True Bevel: Chamfer vát phẳng (segments=1) trên Cube sinh 26 mặt / các dải cạnh', async () => {
  const cube = new THREE.BoxGeometry(2, 2, 2);
  const beveled = bevelMesh(cube, { width: 0.1, segments: 1 });

  assert.ok(beveled, 'Không tạo được beveled geometry');
  const pos = beveled.attributes.position;
  assert.ok(pos && pos.count > 0, 'Geometry thiếu attribute position');

  // Khối hộp gốc 12 tam giác. Sau khi vát cạnh thật:
  // 6 mặt thụt vào + 12 dải cạnh vát (mỗi cạnh 2 tam giác = 24 tris) + 8 góc miter
  // Tổng số tam giác phải lớn hơn nhiều so với 12 tam giác của hộp ban đầu
  const triCount = pos.count / 3;
  assert.ok(triCount >= 40, `Số tam giác sau khi vát phải >= 40, nhận được ${triCount}`);

  // Bounding box phải nằm gọn trong kích thước hộp gốc [-1, 1]
  beveled.computeBoundingBox();
  const bbox = beveled.boundingBox;
  assert.ok(bbox.max.x <= 1.0001 && bbox.min.x >= -1.0001);
  assert.ok(bbox.max.y <= 1.0001 && bbox.min.y >= -1.0001);
  assert.ok(bbox.max.z <= 1.0001 && bbox.min.z >= -1.0001);
});

// ---------------------------------------------------------------------------
// 2. ROUND BEVEL (SEGMENTS > 1)
// ---------------------------------------------------------------------------
await test('True Bevel: Vát bo tròn (segments=2, segments=4) gia tăng độ mịn cạnh', async () => {
  const cube = new THREE.BoxGeometry(1, 1, 1);
  const bev1 = bevelMesh(cube, { width: 0.08, segments: 1 });
  const bev2 = bevelMesh(cube, { width: 0.08, segments: 2 });
  const bev4 = bevelMesh(cube, { width: 0.08, segments: 4 });

  const c1 = bev1.attributes.position.count;
  const c2 = bev2.attributes.position.count;
  const c4 = bev4.attributes.position.count;

  assert.ok(c2 > c1, `Segments=2 (${c2}) phải nhiều đỉnh hơn Segments=1 (${c1})`);
  assert.ok(c4 > c2, `Segments=4 (${c4}) phải nhiều đỉnh hơn Segments=2 (${c2})`);
});

// ---------------------------------------------------------------------------
// 3. OVERLAP CLAMPING
// ---------------------------------------------------------------------------
await test('True Bevel: Clamp Overlap ngăn tự đâm thủng khi width vượt quá kích thước cạnh', async () => {
  const tinyBox = new THREE.BoxGeometry(0.2, 0.2, 0.2); // Cạnh chỉ dài 0.2
  // Cố ý đặt width cực lớn (2.0)
  const beveled = bevelMesh(tinyBox, { width: 2.0, clampOverlap: true });

  beveled.computeBoundingBox();
  const bbox = beveled.boundingBox;

  // Bounding box không bị nổ hay biến dạng dị thường
  const size = new THREE.Vector3();
  bbox.getSize(size);
  assert.ok(size.x <= 0.2001, `Kích thước x (${size.x}) phải bị kẹp <= 0.2`);
  assert.ok(size.y <= 0.2001, `Kích thước y (${size.y}) phải bị kẹp <= 0.2`);
  assert.ok(size.z <= 0.2001, `Kích thước z (${size.z}) phải bị kẹp <= 0.2`);
});

// ---------------------------------------------------------------------------
// 4. ANGLE LIMIT METHOD
// ---------------------------------------------------------------------------
await test('True Bevel: Limit Method = angle chỉ vát mép khi góc nhị diện >= ngưỡng', async () => {
  const box = new THREE.BoxGeometry(1, 1, 1);
  // Góc 90° > 30° -> vát bình thường
  const bevAnglePass = bevelMesh(box, { width: 0.05, limitMethod: 'angle', angleLimitDeg: 30 });
  // Ngưỡng 100° > 90° -> không cạnh nào đủ điều kiện vát
  const bevAngleBlock = bevelMesh(box, { width: 0.05, limitMethod: 'angle', angleLimitDeg: 100 });

  const countPass = bevAnglePass.attributes.position.count;
  const countBlock = bevAngleBlock.attributes.position.count;

  assert.ok(countPass > countBlock, `Vát mép với góc 30° (${countPass}) phải sinh cạnh vát so với góc 100° (${countBlock})`);
});

// ---------------------------------------------------------------------------
// 5. MODIFIER STACK INTEGRATION
// ---------------------------------------------------------------------------
await test('True Bevel: Tích hợp Modifier Stack trong modifiers.js', async () => {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial());
  const mod = applyModifier(mesh, 'bevel', { width: 0.05, segments: 2 });

  assert.ok(mod && mod.type === 'bevel');
  const stack = getModifierStack(mesh);
  assert.equal(stack.length, 1);
  assert.equal(stack[0].params.segments, 2);
  assert.ok(mesh.geometry.attributes.position.count > 36);
});

// ---------------------------------------------------------------------------
// 6. MULTI-FACE WATERTIGHT BEVEL ON CYLINDER (32 SEGMENTS)
// ---------------------------------------------------------------------------
await test('True Bevel: Vát mép CylinderGeometry(32) với 3 segments kín khối (0 open/non-manifold edges)', async () => {
  const cyl = new THREE.CylinderGeometry(1, 1, 2, 32);
  const origTris = cyl.index ? cyl.index.count / 3 : cyl.attributes.position.count / 3;
  const beveled = bevelMesh(cyl, {
    width: 0.08,
    segments: 3,
    limitMethod: 'angle',
    angleLimitDeg: 30,
    clampOverlap: true
  });

  assert.ok(beveled, 'Phải tạo được Cylinder beveled geometry');
  const nonIdx = beveled.index ? beveled.toNonIndexed() : beveled;
  const pos = nonIdx.attributes.position;
  assert.ok(pos && pos.count > 0 && pos.count % 3 === 0);
  const triCount = pos.count / 3;
  assert.ok(triCount > origTris, `Số tam giác (${triCount}) phải lớn hơn Cylinder gốc (${origTris})`);

  // Check welded watertight topology (every edge shared by exactly 2 triangles)
  const vMap = new Map();
  const weldedTris = [];
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    assert.ok(Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z), 'Tất cả toạ độ phải hữu hạn');
    const key = `${Math.round(x * 1e4)}_${Math.round(y * 1e4)}_${Math.round(z * 1e4)}`;
    let vi = vMap.get(key);
    if (vi === undefined) {
      vi = vMap.size;
      vMap.set(key, vi);
    }
    weldedTris.push(vi);
  }

  const edgeCounts = new Map();
  for (let t = 0; t < weldedTris.length; t += 3) {
    const tri = [weldedTris[t], weldedTris[t + 1], weldedTris[t + 2]];
    for (let k = 0; k < 3; k++) {
      const a = tri[k];
      const b = tri[(k + 1) % 3];
      if (a === b) continue;
      const eKey = a < b ? `${a}_${b}` : `${b}_${a}`;
      edgeCounts.set(eKey, (edgeCounts.get(eKey) || 0) + 1);
    }
  }
  let openEdges = 0;
  let nonManifoldEdges = 0;
  for (const count of edgeCounts.values()) {
    if (count === 1) openEdges++;
    else if (count > 2) nonManifoldEdges++;
  }
  assert.equal(openEdges, 0, `Không được có open edges trên Cylinder beveled (got ${openEdges})`);
  assert.equal(nonManifoldEdges, 0, `Không được có non-manifold edges trên Cylinder beveled (got ${nonManifoldEdges})`);

  beveled.computeBoundingBox();
  assert.ok(beveled.boundingBox.max.y <= 1.0001 && beveled.boundingBox.min.y >= -1.0001);
});

if (failures.length > 0) {
  console.error(`\n${failures.length} test(s) failed`);
  process.exit(1);
} else {
  console.log('\nAll true bevel tests passed!');
}
