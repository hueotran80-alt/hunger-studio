/**
 * Phase-1 geometry pipeline kernels: codec + budget + topology.
 * Chạy:
 *   node --import ./tests/three-resolve-hooks.mjs tests/test_geometry_pipeline.mjs
 */
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { encodeGeometry, decodeGeometry, transferables } from '../js/core/geometry/geometry-codec.js';
import {
  DEFAULT_GEOMETRY_BUDGET,
  triangleCount,
  estimateStackOutput,
  estimateBytes,
  checkBudget
} from '../js/core/geometry/geometry-budget.js';
import {
  buildTopology,
  selectionMask,
  boundaryEdges,
  manifoldCheck
} from '../js/core/geometry/mesh-topology.js';

let passed = 0, failed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`ok   ${name}`);
  } catch (err) {
    failed++;
    console.error(`✗ ${name}\n  ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Codec
// ---------------------------------------------------------------------------

test('codec round-trip BoxGeometry giữ nguyên position/normal/uv/index/groups', () => {
  const box = new THREE.BoxGeometry(1, 2, 3);
  box.name = 'TestBox';
  box.addGroup(0, 12, 2);
  const encoded = encodeGeometry(box);
  const back = decodeGeometry(encoded);

  assert.deepEqual(back.attributes.position.array, box.attributes.position.array);
  assert.deepEqual(back.attributes.normal.array, box.attributes.normal.array);
  assert.deepEqual(back.attributes.uv.array, box.attributes.uv.array);
  // Index chuẩn hóa về Uint32Array theo spec — so sánh giá trị.
  assert.deepEqual(Array.from(back.index.array), Array.from(box.index.array));
  assert.ok(back.index.array instanceof Uint32Array);
  assert.deepEqual(back.groups, box.groups);
  assert.equal(back.name, 'TestBox');
  assert.equal(back.attributes.position.itemSize, 3);
  assert.equal(back.attributes.uv.itemSize, 2);
  // Caller quyết định bounding — decode KHÔNG tự tính.
  assert.equal(back.boundingBox, null);
  assert.equal(back.boundingSphere, null);
});

test('codec round-trip custom geometry với color attr (itemSize 3 và 4)', () => {
  for (const colorSize of [3, 4]) {
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), 3));
    geom.setAttribute('color', new THREE.BufferAttribute(new Float32Array(3 * colorSize).fill(0.5), colorSize));
    geom.setIndex([0, 1, 2]);
    const encoded = encodeGeometry(geom);
    assert.equal(encoded.itemSizes.color, colorSize);
    const back = decodeGeometry(encoded);
    assert.deepEqual(back.attributes.color.array, geom.attributes.color.array);
    assert.equal(back.attributes.color.itemSize, colorSize);
    assert.deepEqual(Array.from(back.index.array), Array.from(geom.index.array));
  }
});

test('encodeGeometry copy mảng — sửa encoded không ảnh hưởng geometry gốc', () => {
  const box = new THREE.BoxGeometry();
  const encoded = encodeGeometry(box);
  assert.notEqual(encoded.position.buffer, box.attributes.position.array.buffer);
  const original = box.attributes.position.array[0];
  encoded.position[0] = 999;
  assert.equal(box.attributes.position.array[0], original);
});

test('transferables liệt kê đúng các ArrayBuffer, không trùng lặp', () => {
  const box = new THREE.BoxGeometry();
  const encoded = encodeGeometry(box);
  const list = transferables(encoded);
  const expected = [encoded.position, encoded.normal, encoded.uv, encoded.index]
    .filter(Boolean).map((a) => a.buffer);
  assert.equal(list.length, expected.length);
  for (const buf of expected) assert.ok(list.includes(buf), 'thiếu buffer của attribute');
  assert.equal(new Set(list).size, list.length, 'buffer bị lặp');
  assert.equal(transferables({}).length, 0);
});

// ---------------------------------------------------------------------------
// Budget
// ---------------------------------------------------------------------------

test('DEFAULT_GEOMETRY_BUDGET đúng giá trị spec', () => {
  assert.equal(DEFAULT_GEOMETRY_BUDGET.maxInputTriangles, 250000);
  assert.equal(DEFAULT_GEOMETRY_BUDGET.maxOutputTriangles, 500000);
  assert.equal(DEFAULT_GEOMETRY_BUDGET.maxTaskBytes, 128 * 1024 * 1024);
  assert.equal(DEFAULT_GEOMETRY_BUDGET.maxInteractiveMs, 10000);
  assert.equal(DEFAULT_GEOMETRY_BUDGET.maxBakeMs, 30000);
  assert.equal(DEFAULT_GEOMETRY_BUDGET.previewTriangles, 80000);
});

test('triangleCount đọc được encoded lẫn BufferGeometry', () => {
  const box = new THREE.BoxGeometry(); // 12 tam giác
  assert.equal(triangleCount(box), 12);
  assert.equal(triangleCount(encodeGeometry(box)), 12);
  assert.equal(triangleCount(encodeGeometry(box.toNonIndexed())), 12);
  assert.equal(triangleCount(null), 0);
});

test('subdivide level 2 trên 1000 tris dự đoán 16000; array count 5 dự đoán x5', () => {
  assert.equal(estimateStackOutput(1000, [{ type: 'subdivide', levels: 2 }]), 16000);
  assert.equal(estimateStackOutput(1000, [{ type: 'subdivision', level: 2 }]), 16000);
  assert.equal(estimateStackOutput(1000, [{ type: 'array', count: 5 }]), 5000);
});

test('hệ số tăng trưởng các modifier khác (mirror/solidify/bevel/wireframe/unknown)', () => {
  assert.equal(estimateStackOutput(100, [{ type: 'mirror' }]), 200);
  assert.equal(estimateStackOutput(100, [{ type: 'solidify' }]), 200);
  assert.equal(estimateStackOutput(100, [{ type: 'bevel', segments: 3 }]), 400);
  assert.ok(estimateStackOutput(100, [{ type: 'wireframe' }]) >= 200, 'wireframe phải bảo thủ');
  assert.equal(estimateStackOutput(100, [{ type: 'smooth' }]), 100);
  assert.equal(estimateStackOutput(100, [{ type: 'displace' }]), 100);
  assert.equal(estimateStackOutput(100, [{ type: 'khong-ro' }]), 100);
  // Stack nhiều modifier nhân dồn: array 5 rồi subdivide 1 → x20
  assert.equal(estimateStackOutput(1000, [{ type: 'array', count: 5 }, { type: 'subdivide', levels: 1 }]), 20000);
});

test('checkBudget từ chối output > 500k TRƯỚC khi cấp phát', () => {
  const result = checkBudget({
    inputTriangles: 100000,
    descriptors: [{ type: 'subdivide', levels: 2 }],
    mode: 'interactive'
  });
  assert.equal(result.ok, false);
  assert.equal(result.predictedTriangles, 1600000);
  assert.match(result.reason, /maxOutputTriangles/);
});

test('checkBudget preview từ chối > 80k, interactive cùng input thì qua', () => {
  const preview = checkBudget({ inputTriangles: 90000, mode: 'preview' });
  assert.equal(preview.ok, false);
  assert.match(preview.reason, /previewTriangles/);
  const interactive = checkBudget({ inputTriangles: 90000, mode: 'interactive' });
  assert.equal(interactive.ok, true);
});

test('checkBudget từ chối input > 250k và bytes > 128MB', () => {
  const tooMany = checkBudget({ inputTriangles: 300000, mode: 'bake' });
  assert.equal(tooMany.ok, false);
  assert.match(tooMany.reason, /maxInputTriangles/);

  const tooBig = checkBudget({ inputTriangles: 10, inputBytes: 200 * 1024 * 1024, mode: 'interactive' });
  assert.equal(tooBig.ok, false);
  assert.match(tooBig.reason, /maxTaskBytes/);
  assert.equal(tooBig.predictedBytes, 200 * 1024 * 1024);

  const fine = checkBudget({ inputTriangles: 1000, descriptors: [{ type: 'mirror' }], mode: 'interactive' });
  assert.deepEqual(fine, { ok: true, predictedTriangles: 2000, predictedBytes: 0 });
});

test('estimateBytes cộng đúng byteLength các mảng encoded', () => {
  const encoded = encodeGeometry(new THREE.BoxGeometry());
  const expected = encoded.position.byteLength + encoded.normal.byteLength
    + encoded.uv.byteLength + encoded.index.byteLength;
  assert.equal(estimateBytes(encoded), expected);
  assert.equal(estimateBytes(null), 0);
  // Budget theo bytes thật của encoded
  const result = checkBudget({ encoded, mode: 'interactive', budget: { maxTaskBytes: 10 } });
  assert.equal(result.ok, false);
});

// ---------------------------------------------------------------------------
// Topology
// ---------------------------------------------------------------------------

test('cube indexed (24 đỉnh) weld về 8 đỉnh, 12 face, 18 edge, không boundary', () => {
  const encoded = encodeGeometry(new THREE.BoxGeometry(1, 1, 1));
  const topo = buildTopology(encoded);
  assert.equal(topo.vertices.length, 8);
  assert.equal(topo.faces.length, 12);
  assert.equal(topo.edges.length, 18); // 12 cạnh hộp + 6 đường chéo tam giác hóa
  assert.equal(topo.vertexMap.length, 24);
  assert.equal(boundaryEdges(topo).length, 0, 'cube kín không có boundary');
  // Mọi edge kín đều có đúng 2 face
  for (const edge of topo.edges) assert.equal(edge.faces.length, 2);
});

test('cube non-indexed weld về 8 đỉnh; cornerUVs giữ đủ theo số position', () => {
  const geom = new THREE.BoxGeometry(1, 1, 1).toNonIndexed();
  const encoded = encodeGeometry(geom);
  const positionCount = encoded.position.length / 3; // 36
  const topo = buildTopology(encoded);
  assert.equal(topo.vertices.length, 8);
  assert.equal(topo.cornerUVs.length, positionCount, 'mỗi corner giữ 1 UV');
  // UV từng corner phải khớp UV gốc tại vị trí đó
  for (let i = 0; i < positionCount; i++) {
    assert.equal(topo.cornerUVs[i].u, encoded.uv[i * 2]);
    assert.equal(topo.cornerUVs[i].v, encoded.uv[i * 2 + 1]);
  }
  assert.equal(boundaryEdges(topo).length, 0);
});

test('manifoldCheck cube kín: nonManifold rỗng, boundary rỗng', () => {
  const topo = buildTopology(encodeGeometry(new THREE.BoxGeometry()));
  const report = manifoldCheck(topo);
  assert.deepEqual(report.nonManifoldEdges, []);
  assert.deepEqual(report.boundaryEdges, []);
});

test('plane hở có boundary edges; non-indexed vẫn đúng', () => {
  const indexed = buildTopology(encodeGeometry(new THREE.PlaneGeometry(1, 1)));
  assert.equal(indexed.vertices.length, 4);
  assert.equal(indexed.faces.length, 2);
  assert.equal(boundaryEdges(indexed).length, 4);

  const nonIndexed = buildTopology(encodeGeometry(new THREE.PlaneGeometry(1, 1).toNonIndexed()));
  assert.equal(nonIndexed.vertices.length, 4);
  const report = manifoldCheck(nonIndexed);
  assert.equal(report.boundaryEdges.length, 4);
  assert.deepEqual(report.nonManifoldEdges, []);
});

test('UV seam: vị trí weld nhưng UV per-corner tách riêng', () => {
  // 2 tam giác chung cạnh (đỉnh 1 và 2 trùng vị trí) nhưng UV khác nhau ở đỉnh shared.
  const encoded = {
    position: new Float32Array([
      0, 0, 0,  1, 0, 0,  0, 1, 0,   // tri A
      1, 0, 0,  1, 1, 0,  0, 1, 0    // tri B (đỉnh 3≡1, đỉnh 5≡2)
    ]),
    uv: new Float32Array([
      0, 0,  0.5, 0,  0, 1,
      0.6, 0,  1, 1,  0.1, 1        // UV khác tại cùng vị trí → seam
    ]),
    index: null, groups: [], drawRange: { start: 0, count: Infinity }, name: ''
  };
  const topo = buildTopology(encoded);
  assert.equal(topo.vertices.length, 4, 'vị trí trùng phải weld');
  const shared = topo.vertices[topo.vertexMap[1]];
  assert.equal(shared.uvCorners.length, 2, 'đỉnh seam giữ 2 UV corner');
  assert.notDeepEqual(
    { u: shared.uvCorners[0].u, v: shared.uvCorners[0].v },
    { u: shared.uvCorners[1].u, v: shared.uvCorners[1].v }
  );
  // Cạnh chung giữa 2 face là cạnh interior (2 face), không phải boundary.
  assert.equal(boundaryEdges(topo).length, 4);
});

test('explicit polygon faces (quad/ngon) được tôn trọng', () => {
  const encoded = {
    position: new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]),
    uv: null, index: null,
    faces: [[0, 1, 2, 3]],
    groups: [], drawRange: { start: 0, count: Infinity }, name: 'quad'
  };
  const topo = buildTopology(encoded);
  assert.equal(topo.faces.length, 1);
  assert.deepEqual(topo.faces[0].loops, [0, 1, 2, 3]);
  assert.equal(topo.edges.length, 4);
  assert.equal(boundaryEdges(topo).length, 4);
  assert.ok(Math.abs(topo.faces[0].normal.z - 1) < 1e-6, 'normal quad phải hướng +Z');
});

test('selectionMask đúng độ dài và bit cho vertex/edge/face', () => {
  const topo = buildTopology(encodeGeometry(new THREE.BoxGeometry()));
  const vMask = selectionMask(topo, { mode: 'vertex', indices: [0, 3, 7] });
  assert.ok(vMask instanceof Uint8Array);
  assert.equal(vMask.length, 8);
  assert.equal(vMask[0] + vMask[3] + vMask[7], 3);
  assert.equal(vMask[1], 0);

  const eMask = selectionMask(topo, { mode: 'edge', indices: [5] });
  assert.equal(eMask.length, 18);
  assert.equal(eMask[5], 1);

  const fMask = selectionMask(topo, { mode: 'face', indices: [11, 999] }); // 999 ngoài phạm vi → bỏ qua
  assert.equal(fMask.length, 12);
  assert.equal(fMask[11], 1);
});

test('groups/materialIndex gắn đúng vào face và vertex', () => {
  const box = new THREE.BoxGeometry();
  box.clearGroups();
  box.addGroup(0, 18, 1);  // 6 tam giác đầu → material 1
  box.addGroup(18, 18, 2); // 6 tam giác sau → material 2
  const topo = buildTopology(encodeGeometry(box));
  assert.equal(topo.faces[0].materialIndex, 1);
  assert.equal(topo.faces[0].group, 0);
  assert.equal(topo.faces[6].materialIndex, 2);
  assert.equal(topo.faces[6].group, 1);
});

// ---------------------------------------------------------------------------
console.log(`\n${passed + failed} GEOMETRY PIPELINE TESTS: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;