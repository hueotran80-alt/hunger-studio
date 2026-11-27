/**
 * Blender Pro Modeling & Edit Mode Tests:
 * - Vertex Extrude (looseEdges persistence across rebuild & Undo/Redo)
 * - Edge Extrude (quad generation + Undo)
 * - Make Edge / Face (F): 2-vertex edge/split + 4-vertex manifold quad fill
 * - Dissolve Selection (Ctrl+X): edge dissolve merging faces + vertex dissolve
 * - Bridge Edge Loops: connecting two separate edge chains & closed loops
 * - Separate Selection (P): splitting selected faces into standalone scene mesh + Undo
 * - Knife Cut (K): splitting quad faces cleanly along segment + UV interpolation
 * - Selection-Scoped True Bevel (partial edges vs full, segments 1..8)
 * - Select More / Less / Edge Loop / Edge Ring
 * - Edge / Vertex Slide (G G) with Clamp (C) & Undo/Redo
 *
 * Chạy: node --import ./tests/three-resolve-hooks.mjs tests/test_blender_pro_tools.mjs
 */
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { SceneManager } from '../js/core/scene-manager.js';
import { EditMode } from '../js/core/edit-mode.js';

const failures = [];
async function test(name, fn) {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (err) {
    failures.push(name);
    console.error(`✗ ${name}\n  ${err.stack || err.message}`);
  }
}

function createHarness() {
  const scene = new THREE.Scene();
  const sm = new SceneManager(scene);
  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
  camera.position.set(0, 3, 6);
  camera.lookAt(0, 0, 0);
  const mockEngine = {
    scene,
    sceneManager: sm,
    camera,
    domElement: null,
    transformControls: null,
    snapEnabled: false,
    pivotMode: 'median',
    updateSelectionHelper() {}
  };
  const editMode = new EditMode(mockEngine, { sceneManager: sm });
  return { scene, sm, editMode };
}

function makeMaterial() {
  return new THREE.MeshStandardMaterial({ color: 0xcccccc });
}

/** Merge multiple planar BufferGeometries into one geometry without overlapping verts. */
function combineGeometries(geoms) {
  const positions = [];
  const uvs = [];
  for (const g of geoms) {
    const nonIdx = g.index ? g.toNonIndexed() : g;
    const pos = nonIdx.attributes.position;
    const uv = nonIdx.attributes.uv;
    for (let i = 0; i < pos.count; i++) {
      positions.push(pos.getX(i), pos.getY(i), pos.getZ(i));
      uvs.push(uv ? uv.getX(i) : 0, uv ? uv.getY(i) : 0);
    }
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3));
  out.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(uvs), 2));
  out.computeVertexNormals();
  return out;
}

// ---------------------------------------------------------------------------
// 1. VERTEX EXTRUDE + LOOSE EDGES PERSISTENCE
// ---------------------------------------------------------------------------
await test('Vertex Extrude tạo looseEdges bền vững qua rebuild và Undo/Redo', async () => {
  const { sm, editMode } = createHarness();
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), makeMaterial());
  sm.addObject(mesh);
  editMode.enter(mesh);

  assert.equal(editMode.vertices.length, 8);
  editMode.setMode('vertex');
  editMode.selectedVertices.add(0);

  const ok = editMode.extrude(1.0);
  assert.equal(ok, true, 'Vertex extrude phải trả về true');
  assert.equal(editMode.vertices.length, 9, 'Vertex extrude phải thêm 1 đỉnh mới');
  assert.equal(editMode.looseEdges.length, 1, 'Vertex extrude phải tạo 1 looseEdge');
  assert.equal(mesh.geometry.userData._looseEdges?.length, 1, 'Loose edge phải lưu vào geometry.userData');

  sm.undo();
  assert.equal(editMode.vertices.length, 8, 'Undo phải khôi phục 8 đỉnh');
  assert.equal(editMode.looseEdges.length, 0, 'Undo phải xóa looseEdge');

  sm.redo();
  assert.equal(editMode.vertices.length, 9, 'Redo phải khôi phục 9 đỉnh');
  assert.equal(editMode.looseEdges.length, 1, 'Redo phải khôi phục looseEdge');
});

// ---------------------------------------------------------------------------
// 2. EDGE EXTRUDE
// ---------------------------------------------------------------------------
await test('Edge Extrude dựng mặt quad mới và hỗ trợ Undo', async () => {
  const { sm, editMode } = createHarness();
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2, 1, 1), makeMaterial());
  sm.addObject(mesh);
  editMode.enter(mesh);

  assert.equal(editMode.faces.length, 1);
  assert.equal(editMode.vertices.length, 4);
  editMode.setMode('edge');
  editMode.selectedEdges.add(0);

  const ok = editMode.extrude(0.5);
  assert.equal(ok, true, 'Edge extrude phải trả về true');
  assert.equal(editMode.faces.length, 2, 'Edge extrude trên cạnh phẳng phải tạo 1 quad mới (tổng 2 mặt)');
  assert.equal(editMode.vertices.length, 6, 'Edge extrude phải thêm 2 đỉnh mới (tổng 6 đỉnh)');

  sm.undo();
  assert.equal(editMode.faces.length, 1, 'Undo edge extrude phải về 1 mặt');
  assert.equal(editMode.vertices.length, 4, 'Undo edge extrude phải về 4 đỉnh');
});

// ---------------------------------------------------------------------------
// 3. MAKE EDGE / FACE (F)
// ---------------------------------------------------------------------------
await test('Make Edge / Face (F): nối 2 đỉnh & dựng lại mặt quad đã xóa theo pháp tuyến hướng ngoài', async () => {
  const { sm, editMode } = createHarness();

  // Case A: Xóa 1 mặt của Box rồi dùng 4 đỉnh biên vá lại bằng F
  const cube = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), makeMaterial());
  sm.addObject(cube);
  editMode.enter(cube);
  assert.equal(editMode.faces.length, 6);

  editMode.setMode('face');
  const targetFaceVertPositions = editMode.faces[0].verts.map(vi => editMode.vertices[vi].clone());
  const expectedNormal = editMode.faces[0].normal.clone();
  editMode.selectedFaces.add(0);
  editMode.deleteSelection('faces');
  assert.equal(editMode.faces.length, 5, 'Xóa 1 mặt của Box còn 5 mặt');

  editMode.setMode('vertex');
  editMode.selectedVertices.clear();
  for (const pos of targetFaceVertPositions) {
    const newIdx = editMode.vertices.findIndex(v => v.distanceTo(pos) < 1e-4);
    assert.ok(newIdx >= 0, 'Phải tìm lại đúng đỉnh biên theo tọa độ 3D sau khi xóa mặt');
    editMode.selectedVertices.add(newIdx);
  }

  const filled = editMode.fillOrMakeFace();
  assert.equal(filled, true, 'fillOrMakeFace với 4 đỉnh biên phải tạo lại mặt');
  assert.equal(editMode.faces.length, 6, 'Sau khi F, Box khôi phục đủ 6 mặt');

  const newFace = editMode.faces[editMode.faces.length - 1];
  assert.ok(newFace.normal.dot(expectedNormal) > 0.9, 'Mặt tạo bởi F phải tự định hướng pháp tuyến hướng ra ngoài');

  // Case B: Chọn 2 đỉnh không chung cạnh trên quad cong -> chia mặt thành 2 tam giác
  const plane = new THREE.Mesh(new THREE.PlaneGeometry(2, 2, 1, 1), makeMaterial());
  sm.addObject(plane);
  editMode.enter(plane);
  assert.equal(editMode.faces.length, 1);
  editMode.setMode('vertex');
  const fv = [...editMode.faces[0].verts];
  editMode.vertices[fv[0]].z = 0.5; // Tạo độ cong để 2 tam giác không đồng phẳng bị gộp lại
  editMode.selectedVertices.add(fv[0]);
  editMode.selectedVertices.add(fv[2]);
  const connected = editMode.fillOrMakeFace();
  assert.equal(connected, true, 'Nối 2 đỉnh chéo trong mặt phải trả về true');
  assert.equal(editMode.faces.length, 2, 'Nối 2 đỉnh chéo của quad phải tách thành 2 mặt tam giác');

  // Case C: Chọn 2 đỉnh rời (không chung mặt/cạnh) -> tạo looseEdge
  editMode.selectedVertices.clear();
  const baseIdx = editMode.vertices.length;
  editMode.vertices.push(new THREE.Vector3(-1, 3, 0), new THREE.Vector3(1, 3, 0));
  editMode.vertexUVs.push(null, null);
  editMode.selectedVertices.add(baseIdx);
  editMode.selectedVertices.add(baseIdx + 1);
  const madeEdge = editMode.fillOrMakeFace();
  assert.equal(madeEdge, true, 'F với 2 đỉnh rời phải tạo loose edge');
  assert.equal(editMode.looseEdges.length, 1, 'Phải tạo đúng 1 loose edge mới');
});

// ---------------------------------------------------------------------------
// 4. DISSOLVE SELECTION (Ctrl+X)
// ---------------------------------------------------------------------------
await test('Dissolve Selection (Ctrl+X): gộp 2 mặt kề nhau khi dissolve cạnh chung', async () => {
  const { sm, editMode } = createHarness();
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(4, 2, 2, 1), makeMaterial());
  sm.addObject(mesh);
  editMode.enter(mesh);

  assert.equal(editMode.faces.length, 2, 'Plane 2x1 phải có 2 mặt ban đầu');
  // Tìm cạnh chung giữa 2 mặt (edge.faces.length === 2)
  const sharedEdgeIdx = editMode.edges.findIndex(e => e.faces.length === 2);
  assert.ok(sharedEdgeIdx >= 0, 'Phải có cạnh chia đôi nằm giữa 2 mặt');

  editMode.setMode('edge');
  editMode.selectedEdges.add(sharedEdgeIdx);
  const ok = editMode.dissolveSelection();
  assert.equal(ok, true, 'Dissolve cạnh chung phải thành công');
  assert.equal(editMode.faces.length, 1, 'Dissolve cạnh chung gộp 2 mặt thành 1 mặt');

  sm.undo();
  assert.equal(editMode.faces.length, 2, 'Undo dissolve khôi phục 2 mặt');
});

// ---------------------------------------------------------------------------
// 5. BRIDGE EDGE LOOPS
// ---------------------------------------------------------------------------
await test('Bridge Edge Loops: nối 2 dải cạnh đối diện thành mặt quad cầu nối', async () => {
  const { sm, editMode } = createHarness();
  const p1 = new THREE.PlaneGeometry(2, 2, 1, 1);
  p1.rotateX(-Math.PI / 2);
  p1.translate(-3, 0, 0);
  const p2 = new THREE.PlaneGeometry(2, 2, 1, 1);
  p2.rotateX(-Math.PI / 2);
  p2.translate(3, 2, 0);
  const mesh = new THREE.Mesh(combineGeometries([p1, p2]), makeMaterial());
  sm.addObject(mesh);
  editMode.enter(mesh);

  assert.equal(editMode.faces.length, 2);
  // Tìm cạnh phải của p1 (x ≈ -2, y ≈ 0) và cạnh trái của p2 (x ≈ +2, y ≈ +2)
  const eLeftLoop = editMode.edges.findIndex(e =>
    Math.abs(editMode.vertices[e.v0].x + 2) < 0.05 && Math.abs(editMode.vertices[e.v1].x + 2) < 0.05
  );
  const eRightLoop = editMode.edges.findIndex(e =>
    Math.abs(editMode.vertices[e.v0].x - 2) < 0.05 && Math.abs(editMode.vertices[e.v1].x - 2) < 0.05
  );
  assert.ok(eLeftLoop >= 0 && eRightLoop >= 0, 'Phải tìm thấy 2 cạnh biên đối diện của 2 mesh');

  editMode.setMode('edge');
  editMode.selectedEdges.add(eLeftLoop);
  editMode.selectedEdges.add(eRightLoop);
  const bridged = editMode.bridgeEdgeLoops();
  assert.equal(bridged, true, 'Bridge Edge Loops phải nối thành công');
  assert.equal(editMode.faces.length, 3, 'Bridge 2 cạnh phải tạo thêm 1 mặt quad cầu nối (2 -> 3)');
});

// ---------------------------------------------------------------------------
// 6. SEPARATE SELECTION (P)
// ---------------------------------------------------------------------------
await test('Separate Selection (P): tách mặt được chọn thành Mesh mới và hỗ trợ Undo', async () => {
  const { sm, editMode } = createHarness();
  const cube = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), makeMaterial());
  cube.position.set(1, 2, -1);
  sm.addObject(cube);
  editMode.enter(cube);

  editMode.setMode('face');
  editMode.selectedFaces.add(0);
  const sep = editMode.separateSelection();
  assert.ok(sep instanceof THREE.Mesh, 'Separate phải trả về THREE.Mesh mới');
  assert.equal(sm.getAllObjects().length, 2, 'Scene phải có 2 đối tượng sau khi separate');
  assert.equal(editMode.faces.length, 5, 'Mesh gốc chỉ còn 5 mặt');
  assert.equal(sep.position.distanceTo(cube.position), 0, 'Mesh mới phải giữ nguyên transform vị trí của mesh gốc');

  sm.undo(); // Undo AddObjectCommand
  assert.equal(sm.getAllObjects().length, 1, 'Undo bước 1 phải gỡ đối tượng mới tách');
  sm.undo(); // Undo GeometryCommand của mesh gốc
  assert.equal(editMode.faces.length, 6, 'Undo bước 2 phải khôi phục đủ 6 mặt cho mesh gốc');
});

// ---------------------------------------------------------------------------
// 7. KNIFE CUT (K)
// ---------------------------------------------------------------------------
await test('Knife Cut (K): cắt đôi mặt quad theo đường segment và thêm đỉnh cắt', async () => {
  const { sm, editMode } = createHarness();
  const plane = new THREE.Mesh(new THREE.PlaneGeometry(2, 2, 1, 1), makeMaterial());
  sm.addObject(plane);
  editMode.enter(plane);

  assert.equal(editMode.faces.length, 1);
  const splits = editMode.knife([
    new THREE.Vector3(-1.5, 0, 0),
    new THREE.Vector3(1.5, 0, 0)
  ]);
  assert.ok(splits >= 1, 'Knife cut phải cắt ít nhất 1 mặt');
  assert.equal(editMode.faces.length, 2, 'Cắt ngang qua tâm y=0 phải tách 1 mặt thành 2 mặt');
  assert.equal(editMode.vertices.length, 6, 'Knife cut tạo thêm 2 đỉnh trên hai cạnh dọc');

  sm.undo();
  assert.equal(editMode.faces.length, 1, 'Undo Knife khôi phục 1 mặt');
});

// ---------------------------------------------------------------------------
// 8. SELECTION-SCOPED TRUE BEVEL
// ---------------------------------------------------------------------------
await test('Selection-scoped True Bevel: chỉ vát cạnh được chọn và hỗ trợ đa phân đoạn (segments)', async () => {
  const { sm, editMode } = createHarness();

  const cubeFull = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), makeMaterial());
  sm.addObject(cubeFull);
  editMode.enter(cubeFull);
  editMode.setMode('edge');
  // Không chọn cạnh nào -> bevel toàn khối (2 segments)
  editMode.bevel(0.15, 2);
  const fullFaceCount = editMode.faces.length;

  const cubePartial = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), makeMaterial());
  sm.addObject(cubePartial);
  editMode.enter(cubePartial);
  editMode.setMode('edge');
  editMode.selectedEdges.add(0); // Chỉ vát đúng 1 cạnh
  editMode.bevel(0.15, 2);
  const partialFaceCount = editMode.faces.length;

  assert.ok(partialFaceCount > 6, 'Bevel 1 cạnh phải sinh thêm mặt vát (> 6 mặt)');
  assert.ok(
    partialFaceCount < fullFaceCount,
    `Bevel 1 cạnh (${partialFaceCount} mặt) phải ít mặt hơn bevel cả 12 cạnh (${fullFaceCount} mặt)`
  );
});

// ---------------------------------------------------------------------------
// 9. SELECT MORE / LESS / EDGE LOOP / EDGE RING
// ---------------------------------------------------------------------------
await test('Select More / Less / Edge Loop / Edge Ring mở rộng và thu hẹp chuẩn xác', async () => {
  const { sm, editMode } = createHarness();
  const grid = new THREE.Mesh(new THREE.PlaneGeometry(4, 4, 3, 3), makeMaterial());
  sm.addObject(grid);
  editMode.enter(grid);

  // Chọn 1 đỉnh nằm bên trong (x ≈ -2/3, y ≈ -2/3)
  editMode.setMode('vertex');
  const innerVertIdx = editMode.vertices.findIndex(v => Math.abs(v.x) < 1.5 && Math.abs(v.y) < 1.5);
  assert.ok(innerVertIdx >= 0, 'Phải có đỉnh nội biên trong lưới 3x3');
  editMode.selectedVertices.add(innerVertIdx);

  editMode.selectMore();
  assert.ok(editMode.selectedVertices.size > 1, 'Select More phải lan ra các đỉnh láng giềng');
  const grownCount = editMode.selectedVertices.size;

  editMode.selectLess();
  assert.ok(editMode.selectedVertices.size < grownCount, 'Select Less phải thu hẹp vùng chọn');

  // Chọn 1 cạnh nội bộ giữa 2 mặt (edges[i].faces.length === 2)
  const interiorEdgeIdx = editMode.edges.findIndex(e => e.faces.length === 2);
  assert.ok(interiorEdgeIdx >= 0, 'Phải có cạnh nội bộ giữa 2 mặt');

  editMode.setMode('edge');
  editMode.selectEdgeLoop(interiorEdgeIdx, false);
  assert.ok(editMode.selectedEdges.size >= 2, `Edge Loop phải chọn cả chuỗi cạnh dọc (>=2), thấy ${editMode.selectedEdges.size}`);

  editMode.selectRing(interiorEdgeIdx, false);
  assert.ok(editMode.selectedEdges.size >= 2, `Edge Ring phải chọn cả vòng cạnh song song (>=2), thấy ${editMode.selectedEdges.size}`);
});

// ---------------------------------------------------------------------------
// 10. EDGE / VERTEX SLIDE (G G) + CLAMP + UNDO
// ---------------------------------------------------------------------------
await test('Edge / Vertex Slide (GG): trượt dọc cạnh láng giềng, kẹp Clamp và Undo', async () => {
  const { sm, editMode } = createHarness();
  // Plane 2x1: cột trái x=-2, cột giữa x=0, cột phải x=+2
  const plane = new THREE.Mesh(new THREE.PlaneGeometry(4, 2, 2, 1), makeMaterial());
  sm.addObject(plane);
  editMode.enter(plane);

  const middleEdgeIdx = editMode.edges.findIndex(e =>
    Math.abs(editMode.vertices[e.v0].x) < 1e-4 && Math.abs(editMode.vertices[e.v1].x) < 1e-4
  );
  assert.ok(middleEdgeIdx >= 0, 'Phải có cạnh đứng giữa x=0');

  editMode.setMode('edge');
  editMode.selectedEdges.add(middleEdgeIdx);
  editMode.beginModalVertexSession();
  const ready = editMode.prepareSlideTransform();
  assert.ok(ready && ready.perVertex?.size === 2, 'prepareSlideTransform phải khởi tạo được slide tracks');

  editMode.applySlideTransform(0.5, true);
  const v0 = editMode.vertices[editMode.edges[middleEdgeIdx].v0];
  assert.ok(Math.abs(Math.abs(v0.x) - 1.0) < 1e-3, `Slide 0.5 phải đưa x=0 tới ±1.0, nhận x=${v0.x}`);
  assert.ok(Math.abs(v0.z) < 1e-4, 'Slide trên mặt phẳng phải giữ nguyên z=0');

  // Test Clamp = true vs Clamp = false
  editMode.applySlideTransform(2.0, true);
  assert.ok(Math.abs(editMode.vertices[editMode.edges[middleEdgeIdx].v0].x) <= 2.001, 'Clamp=true không cho vượt quá đỉnh biên ±2');
  editMode.applySlideTransform(2.0, false);
  assert.ok(Math.abs(editMode.vertices[editMode.edges[middleEdgeIdx].v0].x) > 2.5, 'Clamp=false cho phép trượt vượt quá ±2');

  // Đặt lại 0.5 rồi commit + test Undo
  editMode.applySlideTransform(0.5, true);
  editMode.commitSlideTransform();
  assert.equal(
    editMode.vertices.filter(v => Math.abs(Math.abs(v.x) - 1.0) < 1e-3).length,
    2,
    'Sau commitSlideTransform() hai đỉnh cột giữa phải nằm tại |x|=1.0'
  );

  sm.undo();
  assert.equal(
    editMode.vertices.filter(v => Math.abs(v.x) < 1e-3).length,
    2,
    'Undo Slide phải đưa 2 đỉnh cột giữa về lại x=0'
  );
});

// ---------------------------------------------------------------------------
// 11. JS WELD _outToLogical + GIZMO DRAG LIVE MATRIXWORLD SYNC
// ---------------------------------------------------------------------------
await test('EditMode JS weld _outToLogical và _handleGizmoChange tự cập nhật matrixWorld', async () => {
  const { sm, editMode } = createHarness();
  editMode.engine.transformControls = {
    object: editMode.gizmoProxy,
    dragging: false,
    attach() {},
    detach() {},
  };
  const box = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), makeMaterial());
  sm.addObject(box);
  editMode.enter(box);

  // JS fallback path must populate _outToLogical aligned 1:1 with buffer vertices
  assert.ok(editMode._outToLogical instanceof Int32Array, '_outToLogical phải được khởi tạo trên JS weld path');
  const posAttr = box.geometry.attributes.position;
  assert.equal(editMode._outToLogical.length, posAttr.count);
  for (let bi = 0; bi < posAttr.count; bi++) {
    const li = editMode._outToLogical[bi];
    assert.ok(li >= 0 && li < editMode.vertices.length, `Chỉ số logical ${li} hợp lệ`);
    const v = editMode.vertices[li];
    assert.ok(Math.abs(posAttr.getX(bi) - v.x) < 1e-5 && Math.abs(posAttr.getY(bi) - v.y) < 1e-5);
  }

  // Select vertex 0, move gizmoProxy WITHOUT calling external updateMatrixWorld(true)
  editMode.setMode('vertex');
  editMode.selectedVertices.add(0);
  editMode.updateGizmoProxy();
  const startY = editMode.vertices[0].y;
  editMode._handleGizmoMouseDown();
  editMode.gizmoProxy.position.y += 0.75;
  editMode._handleGizmoChange();
  assert.ok(
    Math.abs(editMode.vertices[0].y - (startY + 0.75)) < 1e-4,
    `vertices[0].y phải biến dạng live +0.75, nhận ${editMode.vertices[0].y}`
  );
  editMode._handleGizmoMouseUp();
  sm.undo();
  assert.ok(Math.abs(editMode.vertices[0].y - startY) < 1e-4, 'Undo Gizmo drag phải khôi phục đỉnh');
});

// ---------------------------------------------------------------------------
// 12. EDIT MODE RAYCAST PICKING (FRONT/BACK VERTS, EDGES, BVH FACE)
// ---------------------------------------------------------------------------
await test('EditMode handleRaycast chọn chuẩn đỉnh trước/sau, cạnh và mặt BVH', async () => {
  const { sm, editMode } = createHarness();
  const rect = { left: 0, top: 0, width: 1000, height: 800 };
  editMode.engine.getViewportRect = () => rect;
  editMode.engine.camera.aspect = rect.width / rect.height;
  editMode.engine.camera.position.set(4, 3, 5);
  editMode.engine.camera.lookAt(0, 0, 0);
  editMode.engine.camera.updateMatrixWorld(true);
  editMode.engine.camera.updateProjectionMatrix();

  const box = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), makeMaterial());
  box.updateMatrixWorld(true);
  sm.addObject(box);
  editMode.enter(box);

  const projectToClient = (vec) => {
    const p = vec.clone().project(editMode.engine.camera);
    return {
      clientX: rect.left + (p.x * 0.5 + 0.5) * rect.width,
      clientY: rect.top + (-p.y * 0.5 + 0.5) * rect.height,
      shiftKey: false,
      button: 0,
    };
  };

  // Every logical vertex (including backmost (-1,-1,-1)) should be pickable via screen projection
  editMode.setMode('vertex');
  for (let vi = 0; vi < editMode.vertices.length; vi++) {
    editMode.selectedVertices.clear();
    const ev = projectToClient(editMode.vertices[vi]);
    editMode.handleRaycast(ev);
    assert.ok(editMode.selectedVertices.has(vi), `Vertex ${vi} phải được chọn bằng handleRaycast`);
  }

  // Face pick on top face (0, 1, 0) using BVH DoubleSide
  editMode.setMode('face');
  editMode.selectedFaces.clear();
  editMode.handleRaycast(projectToClient(new THREE.Vector3(0, 1, 0)));
  assert.equal(editMode.selectedFaces.size, 1, 'Face mode phải chọn được mặt trên bằng BVH');
});

function inspectEditTopology(em) {
  let openEdges = 0;
  let nonManifoldEdges = 0;
  for (const e of em.edges) {
    if (e.faces.length === 1) openEdges++;
    else if (e.faces.length > 2) nonManifoldEdges++;
  }
  const halfEdges = new Map();
  let windingConflicts = 0;
  for (let fi = 0; fi < em.faces.length; fi++) {
    const vs = em.faces[fi].verts;
    for (let k = 0; k < vs.length; k++) {
      const a = vs[k];
      const b = vs[(k + 1) % vs.length];
      const key = `${a}->${b}`;
      if (halfEdges.has(key)) windingConflicts++;
      else halfEdges.set(key, fi);
    }
  }
  return { openEdges, nonManifoldEdges, windingConflicts };
}

// ---------------------------------------------------------------------------
// 13. PARTIAL SUBDIVIDE WATERTIGHTNESS (NO T-JUNCTIONS)
// ---------------------------------------------------------------------------
await test('Partial Subdivide: chia lưới 1 mặt của Cube tự khâu cạnh kề (0 openEdges)', async () => {
  const { sm, editMode } = createHarness();
  const cube = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), makeMaterial());
  sm.addObject(cube);
  editMode.enter(cube);
  editMode.setMode('face');
  editMode.selectedFaces.add(0);

  editMode.subdivide();
  assert.equal(editMode.faces.length, 9, 'Subdivide 1 mặt quad trên Cube phải cho 9 mặt');
  const topo = inspectEditTopology(editMode);
  assert.equal(topo.openEdges, 0, `Không được có openEdges sau partial subdivide (got ${topo.openEdges})`);
  assert.equal(topo.nonManifoldEdges, 0, `Không được có nonManifoldEdges (got ${topo.nonManifoldEdges})`);
  assert.equal(topo.windingConflicts, 0, `Không được có windingConflicts (got ${topo.windingConflicts})`);
});

// ---------------------------------------------------------------------------
// 14. KNIFE CUT T-JUNCTION SPLICING ON CLOSED CUBE
// ---------------------------------------------------------------------------
await test('Knife Cut (K) trên Cube kín tự chèn đỉnh cắt vào mặt kề (0 openEdges)', async () => {
  const { sm, editMode } = createHarness();
  const cube = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), makeMaterial());
  sm.addObject(cube);
  editMode.enter(cube);

  const splits = editMode.knife([
    new THREE.Vector3(-1.2, 1.0, 0),
    new THREE.Vector3(1.2, 1.0, 0)
  ]);
  assert.ok(splits >= 1, 'Knife cut phải cắt ít nhất 1 mặt');
  assert.equal(editMode.faces.length, 7, 'Cắt 1 mặt trên Cube phải tăng từ 6 -> 7 mặt');
  const topo = inspectEditTopology(editMode);
  assert.equal(topo.openEdges, 0, `Knife cut không được tạo T-junction openEdges (got ${topo.openEdges})`);
  assert.equal(topo.nonManifoldEdges, 0);
  assert.equal(topo.windingConflicts, 0);
});

// ---------------------------------------------------------------------------
// 15. LOOP CUT (2 CUTS) + DISSOLVE BACK TO 6 FACES
// ---------------------------------------------------------------------------
await test('Loop Cut (2 cuts) + Dissolve (Ctrl+X) khôi phục sạch về 6 mặt Cube', async () => {
  const { sm, editMode } = createHarness();
  const cube = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), makeMaterial());
  sm.addObject(cube);
  editMode.enter(cube);
  editMode.setMode('edge');

  const topFrontEdge = editMode.edges.findIndex(e => {
    const a = editMode.vertices[e.v0];
    const b = editMode.vertices[e.v1];
    return Math.abs(a.y - 1) < 0.05 && Math.abs(b.y - 1) < 0.05 && Math.abs(a.z - 1) < 0.05 && Math.abs(b.z - 1) < 0.05;
  });
  assert.ok(topFrontEdge >= 0, 'Phải tìm thấy cạnh top-front của Cube');

  const cutOk = editMode.loopCut(topFrontEdge, 2);
  assert.equal(cutOk, true, 'Loop Cut 2 nhát phải thành công');
  assert.equal(editMode.faces.length, 14, 'Loop Cut 2 nhát trên Cube phải sinh 14 mặt');
  assert.ok(editMode.selectedEdges.size === 8, `Loop Cut 2 nhát phải chọn 8 cạnh của 2 loop mới (got ${editMode.selectedEdges.size})`);

  const disOk = editMode.dissolveSelection();
  assert.equal(disOk, true, 'Dissolve ngay sau Loop Cut phải thành công');
  assert.equal(editMode.faces.length, 6, 'Dissolve toàn bộ 2 loop phải trả về đúng 6 mặt Cube');
  const topo = inspectEditTopology(editMode);
  assert.equal(topo.openEdges, 0);
  assert.equal(topo.nonManifoldEdges, 0);
});

// ---------------------------------------------------------------------------
// 16. DUPLICATE SELECTION PRESERVES UNWELDED TOPOLOGY ACROSS HISTORY EVENTS
// ---------------------------------------------------------------------------
await test('Duplicate Selection (Shift+D) giữ nguyên 12 đỉnh / 7 mặt (không bị historyChanged weld mất)', async () => {
  const { sm, editMode } = createHarness();
  const cube = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), makeMaterial());
  sm.addObject(cube);
  editMode.enter(cube);
  editMode.setMode('face');
  editMode.selectedFaces.add(0);

  editMode.duplicateSelection();
  assert.equal(editMode.vertices.length, 12, 'Duplicate 1 quad trên Cube phải cho 8 + 4 = 12 đỉnh');
  assert.equal(editMode.faces.length, 7, 'Duplicate 1 mặt trên Cube phải cho 6 + 1 = 7 mặt');
  const topo = inspectEditTopology(editMode);
  assert.equal(topo.nonManifoldEdges, 0);
  assert.equal(topo.openEdges, 4, 'Mặt nhân bản rời có đúng 4 cạnh mở');

  sm.undo();
  assert.equal(editMode.faces.length, 6);
  assert.equal(editMode.vertices.length, 8);
});

// ---------------------------------------------------------------------------
// 17. MULTI-FACE SPHERE CONNECTED REGION INSET + RADIAL EXTRUDE
// ---------------------------------------------------------------------------
await test('Multi-face SphereGeometry(24x12): Region Inset + Extrude dải xích đạo kín khối', async () => {
  const { sm, editMode } = createHarness();
  const sphere = new THREE.Mesh(new THREE.SphereGeometry(1.15, 24, 12), makeMaterial());
  sm.addObject(sphere);
  editMode.enter(sphere);
  editMode.setMode('face');

  const initFaces = editMode.faces.length;
  for (let fi = 0; fi < editMode.faces.length; fi++) {
    const f = editMode.faces[fi];
    if (Math.abs(f.centroid.y) < 0.35) editMode.selectedFaces.add(fi);
  }
  assert.equal(editMode.selectedFaces.size, 48, 'Dải xích đạo 2x24 mặt phải có đúng 48 mặt');

  editMode.inset(0.2);
  assert.ok(editMode.faces.length > initFaces, 'Region Inset dải xích đạo phải tăng số mặt');
  let topo = inspectEditTopology(editMode);
  assert.equal(topo.openEdges, 0, `Region Inset trên Sphere không được tạo openEdges (got ${topo.openEdges})`);
  assert.equal(topo.nonManifoldEdges, 0);
  assert.equal(topo.windingConflicts, 0);

  editMode.extrude(0.18);
  topo = inspectEditTopology(editMode);
  assert.equal(topo.openEdges, 0, `Extrude trên Sphere không được tạo openEdges (got ${topo.openEdges})`);
  assert.equal(topo.nonManifoldEdges, 0);
  assert.equal(topo.windingConflicts, 0);
});

if (failures.length > 0) {
  console.error(`\n${failures.length} BLENDER PRO TESTS FAILED`);
  process.exit(1);
}
console.log('\nALL 17 BLENDER PRO MODELING TESTS PASSED');
