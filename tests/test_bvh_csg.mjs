/**
 * Test BVH/CSG (Giai đoạn 2.1): ba lớp — module bọc, chọn mặt qua boundsTree,
 * và Boolean thật giữa 2 khối. Chạy:
 *   node --import ./tests/three-resolve-hooks.mjs tests/test_bvh_csg.mjs
 */
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { ensureBVH, refitBVH, disposeBVH, raycastMeshAccelerated } from '../js/core/bvh-accelerator.js';
import { performBoolean, applyBoolean } from '../js/core/modifiers.js';

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

await test('ensureBVH build boundsTree và cache theo geometry version', async () => {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
  const bvh1 = ensureBVH(mesh);
  assert.ok(bvh1, 'không build được boundsTree');
  assert.equal(mesh.geometry.boundsTree, bvh1);
  const bvh2 = ensureBVH(mesh); // gọi lại phải trả đúng instance đã cache
  assert.equal(bvh2, bvh1);
  // Đổi geometry -> build lại
  mesh.geometry = new THREE.SphereGeometry(0.5, 16, 12);
  const bvh3 = ensureBVH(mesh);
  assert.ok(bvh3 && bvh3 !== bvh1, 'geometry mới phải build BVH mới');
});

await test('BVH raycast trúng đúng mặt hộp, sai số chấp nhận được', async () => {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2));
  mesh.updateMatrixWorld(true);
  ensureBVH(mesh);
  const raycaster = new THREE.Raycaster();
  raycaster.ray.origin.set(0, 0, 5);
  raycaster.ray.direction.set(0, 0, -1);
  const hits = raycaster.intersectObject(mesh, false);
  assert.ok(hits.length > 0, 'BVH raycast không trúng hộp');
  assert.ok(Math.abs(hits[0].distance - 4) < 1e-5, `distance = ${hits[0].distance}, mong 4`);
  assert.ok(hits[0].faceIndex !== undefined);
});

await test('refitBVH sau khi dịch đỉnh vẫn raycast đúng', async () => {
  const geom = new THREE.BoxGeometry(1, 1, 1);
  // Méo đỉnh trước khi build để khác bounding chuẩn
  geom.translate(3, 0, 0);
  const mesh = new THREE.Mesh(geom);
  mesh.updateMatrixWorld(true);
  ensureBVH(mesh);
  // Dịch tiếp và chỉ refit (không rebuild)
  geom.translate(1, 0, 0);
  mesh.geometry.attributes.position.version++;
  refitBVH(mesh);
  const raycaster = new THREE.Raycaster();
  raycaster.ray.origin.set(4, 0, 5);
  raycaster.ray.direction.set(0, 0, -1);
  const hits = raycaster.intersectObject(mesh, false);
  assert.ok(hits.length > 0, 'refit xong mất hit');
});

await test('disposeBVH dọn sạch boundsTree', async () => {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry());
  ensureBVH(mesh);
  assert.ok(mesh.geometry.boundsTree);
  disposeBVH(mesh);
  assert.equal(mesh.geometry.boundsTree, null);
});

await test('CSG difference: hộp trừ hộp bé giữa mặt → có lỗ xuyên', async () => {
  const a = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2));
  a.name = 'A';
  const b = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.6, 4)); // khoan xuyên trục Z
  b.name = 'B';
  a.updateMatrixWorld(true);
  b.updateMatrixWorld(true);

  const result = performBoolean(a, b, 'difference');
  assert.ok(result, 'performBoolean trả null');
  const pos = result.attributes.position;
  assert.ok(pos && pos.count > 0);
  // Kiểm tra có lỗ: ray dọc trục Z qua tâm KHÔNG được trúng vật liệu đầy —
  // thử bằng cách đếm tam giác: hộp đặc 12 tri, có lỗ phải nhiều tri hơn rõ rệt.
  assert.ok(pos.count / 3 > 12, `quá ít tam giác (${pos.count / 3}) — chưa khoan lỗ`);
  // Điểm (0,0,0) phải NẰM NGOÀI vật liệu (lỗ xuyên thật): tia DoubleSide đi xuyên tâm phải có ĐÚNG 0 hit!
  // Đồng thời phần hộp thừa của thanh khoan B (z ∈ [1..2] và [-2..-1]) phải bị cắt sạch (A - B, không phải XOR).
  const probeMesh = new THREE.Mesh(result, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
  probeMesh.updateMatrixWorld(true);
  ensureBVH(probeMesh);
  const rcCenter = new THREE.Raycaster(new THREE.Vector3(0, 0, 10), new THREE.Vector3(0, 0, -1));
  const centerHits = rcCenter.intersectObject(probeMesh, false);
  assert.equal(centerHits.length, 0, `tia xuyên tâm lỗ vẫn trúng ${centerHits.length} mặt — chưa khoan lỗ thật (có thể nhầm XOR)`);

  // Tia đi qua phần thành đặc (x = 0.7) phải trúng đúng 2 mặt (mặt trước z=+1 và mặt sau z=-1)
  const rcRim = new THREE.Raycaster(new THREE.Vector3(0.7, 0, 10), new THREE.Vector3(0, 0, -1));
  const rimHits = rcRim.intersectObject(probeMesh, false);
  assert.equal(rimHits.length, 2, `thành đặc phải trúng 2 mặt, thực tế ${rimHits.length}`);
  assert.ok(Math.abs(rimHits[0].distance - 9) < 1e-3 && Math.abs(rimHits[1].distance - 11) < 1e-3);
});

await test('CSG union: hộp + hộp lệch nhau → khối liền, quy về local của A', async () => {
  // A ở gốc, B dịch (2,0,0) và hơi chồng lên nhau (B rộng hơn để giao)
  const a = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2));
  const b = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2));
  b.position.x = 1.5; // chồng 0.5 theo X
  a.updateMatrixWorld(true);
  b.updateMatrixWorld(true);
  const result = performBoolean(a, b, 'union');
  assert.ok(result, 'union trả null');
  const box = new THREE.Box3().setFromBufferAttribute(result.attributes.position);
  // Local của A: A giữ nguyên [-1..1] và nhánh của B mở rộng tới x=2.5
  assert.ok(Math.abs(box.min.x + 1) < 1e-3 && Math.abs(box.max.x - 2.5) < 1e-3,
    `bao hình union sai: min.x=${box.min.x}, max.x=${box.max.x}`);
});

await test('CSG intersect: phần chung được quy về local của A', async () => {
  const a = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2));
  a.position.set(-0.5, 0, 0); // A chiếm [-1.5..0.5] world
  const b = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2)); // B chiếm [-1..1] world
  a.updateMatrixWorld(true);
  b.updateMatrixWorld(true);
  // Phần chung world: x ∈ [-1..0.5] → local của A: x ∈ [-0.5..1]
  const result = performBoolean(a, b, 'intersect');
  assert.ok(result, 'intersect trả null');
  const box = new THREE.Box3().setFromBufferAttribute(result.attributes.position);
  assert.ok(Math.abs(box.min.x + 0.5) < 1e-3 && Math.abs(box.max.x - 1) < 1e-3,
    `phần chung sai (local A): min.x=${box.min.x}, max.x=${box.max.x}`);
});

await test('applyBoolean gắn kết quả vào mesh chính và trả geometry', async () => {
  const a = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2));
  const b = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.5, 4));
  a.updateMatrixWorld(true);
  b.updateMatrixWorld(true);
  const oldGeom = a.geometry;
  const newGeom = applyBoolean(a, b, 'difference');
  assert.ok(newGeom && a.geometry === newGeom, 'mesh chính không nhận geometry mới');
  assert.notEqual(a.geometry, oldGeom);
});

await test('CSG giữa 2 mesh ở vị trí/biến đổi khác nhau vẫn đúng world space', async () => {
  const a = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2));
  a.position.set(5, 0, 0);
  const b = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.5, 4));
  b.position.set(5, 0, 0); // khoan đúng tâm hộp A đã dịch
  a.updateMatrixWorld(true);
  b.updateMatrixWorld(true);
  const result = performBoolean(a, b, 'difference');
  assert.ok(result, 'trả null khi mesh có transform');
  const box = new THREE.Box3().setFromBufferAttribute(result.attributes.position);
  // Kết quả được quy về local của A: bao hình quanh gốc, đúng khối hộp gốc
  assert.ok(Math.abs(box.min.x + 1) < 1e-3 && Math.abs(box.max.x - 1) < 1e-3,
    `kết quả không ở local của A: ${box.min.x}..${box.max.x}`);
});

await test('ensureBVH dùng indirect:true giữ nguyên index buffer và raycastMeshAccelerated trả đúng faceIndex gốc', async () => {
  const geom = new THREE.BoxGeometry(10.3, 2.6, 8.7, 7, 7, 7);
  const before = geom.index.array.slice();
  const mesh = new THREE.Mesh(geom, new THREE.MeshStandardMaterial());
  mesh.updateMatrixWorld(true);

  const bvh = ensureBVH(mesh);
  assert.ok(bvh && bvh.indirect, 'BVH phải bật indirect:true để không đảo thứ tự tam giác');
  assert.deepEqual(geom.index.array, before, 'ensureBVH không được làm xáo trộn geometry.index');

  // Probe top face centroid ray and compare against an untouched linear mesh
  const refMesh = new THREE.Mesh(new THREE.BoxGeometry(10.3, 2.6, 8.7, 7, 7, 7), new THREE.MeshStandardMaterial());
  refMesh.updateMatrixWorld(true);
  const rcBvh = new THREE.Raycaster(new THREE.Vector3(1.2, 10, 0.8), new THREE.Vector3(0, -1, 0));
  const rcLin = new THREE.Raycaster(new THREE.Vector3(1.2, 10, 0.8), new THREE.Vector3(0, -1, 0));
  const hitsBvh = raycastMeshAccelerated(mesh, rcBvh);
  const hitsLin = rcLin.intersectObject(refMesh, false);
  assert.ok(hitsBvh.length > 0 && hitsLin.length > 0);
  assert.equal(hitsBvh[0].faceIndex, hitsLin[0].faceIndex);

  // Empty/loose-vertex geometry with < 3 vertices must safely return null instead of throwing
  const emptyGeom = new THREE.BufferGeometry();
  emptyGeom.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0], 3));
  assert.equal(ensureBVH(new THREE.Mesh(emptyGeom)), null);
});

await test('CSG hoạt động trên mesh thiếu UV/normal (STL/OBJ thô) và applyBoolean không xoá trắng mesh khi intersect rỗng', async () => {
  const gA = new THREE.BoxGeometry(2, 2, 2).toNonIndexed();
  gA.deleteAttribute('uv'); gA.deleteAttribute('normal');
  const gB = new THREE.BoxGeometry(0.8, 0.8, 4).toNonIndexed();
  gB.deleteAttribute('uv'); gB.deleteAttribute('normal');
  const a = new THREE.Mesh(gA), b = new THREE.Mesh(gB);
  a.updateMatrixWorld(true); b.updateMatrixWorld(true);
  const diff = performBoolean(a, b, 'difference');
  assert.ok(diff && diff.attributes.position.count > 0, 'performBoolean lỗi trên geometry thiếu uv/normal');

  // Disjoint intersect: applyBoolean must return null and preserve original mesh geometry
  const x1 = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
  const x2 = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
  x2.position.set(10, 0, 0);
  x1.updateMatrixWorld(true); x2.updateMatrixWorld(true);
  const origGeo = x1.geometry;
  assert.equal(applyBoolean(x1, x2, 'intersect'), null, 'intersect 2 khối rời nhau phải trả null');
  assert.equal(x1.geometry, origGeo, 'applyBoolean không được xoá geometry gốc khi intersect rỗng');

  // Null/invalid BVH inputs & non-indexed raycast
  assert.equal(ensureBVH(null), null);
  assert.doesNotThrow(() => refitBVH(null));
  assert.doesNotThrow(() => disposeBVH(null));
  assert.deepEqual(raycastMeshAccelerated(null, new THREE.Raycaster()), []);
});

if (failures.length) {
  console.error(`\n${failures.length} test FAIL`);
  process.exit(1);
}
console.log('\nALL BVH/CSG TESTS PASSED');
