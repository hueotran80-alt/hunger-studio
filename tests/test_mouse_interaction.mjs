/**
 * Targeted Mouse & Navigation Interaction Regression Tests:
 * - Engine._onPointerDown / _onPointerUp LMB-only guards (RMB/MMB never clobber selection)
 * - ViewHelper single-pane handleClick vs multi-pane handleClickTopRight dispatch
 * - Active Sculpt/Modal/Knife guards preventing accidental raycast deselection
 * - _stopCameraTransitions flushing ViewHelper + OrbitControls damping before setCameraPreset
 * - BlenderProTools Shift+MMB / Alt+Shift+LMB THREE.MOUSE.ROTATE mapping & Ctrl/Gizmo marquee guards
 * - SculptMode _tempBrush Shift sync on _onPointerDown / _onPointerUp
 *
 * Chạy: node --import ./tests/three-resolve-hooks.mjs tests/test_mouse_interaction.mjs
 */
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Engine } from '../js/core/engine.js';
import { BlenderProTools } from '../js/core/blender-pro-keymap.js';
import { SculptMode } from '../js/core/sculpt-mode.js';
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

function makeFakeWindowAndDoc() {
  const prevWin = globalThis.window;
  const prevDoc = globalThis.document;
  const prevLS = globalThis.localStorage;
  const fakeStorage = new Map();
  globalThis.localStorage = {
    getItem: (k) => (fakeStorage.has(k) ? fakeStorage.get(k) : null),
    setItem: (k, v) => fakeStorage.set(k, String(v)),
    removeItem: (k) => fakeStorage.delete(k),
  };
  globalThis.window = {
    sculptMode: { isActive: false },
    modalTransformManager: { isActive: false },
    cameraManager: null,
    dispatchEvent() {},
  };
  globalThis.document = {
    body: { classList: { contains: () => false, toggle() {}, add() {}, remove() {} } },
    querySelector: () => null,
    getElementById: () => null,
    createElement: (tag) => (tag === 'canvas' ? {
      width: 64,
      height: 64,
      getContext: () => ({
        clearRect() {},
        beginPath() {},
        arc() {},
        closePath() {},
        fillStyle: '',
        fill() {},
        stroke() {},
        lineWidth: 1,
        strokeStyle: '',
        font: '',
        textAlign: '',
        fillText() {},
      }),
    } : {}),
  };
  return () => {
    globalThis.window = prevWin;
    globalThis.document = prevDoc;
    globalThis.localStorage = prevLS;
  };
}

function makeMockEngine(multiPane = false) {
  const engine = Object.create(Engine.prototype);
  const calls = { raycast: 0, handleClick: 0, handleClickTopRight: [], controlsUpdates: [] };
  engine.renderer = { domElement: { getBoundingClientRect: () => ({ left: 0, top: 0, width: 1000, height: 800 }) } };
  engine.domElement = engine.renderer.domElement;
  engine.isDraggingGizmo = false;
  engine.pointerDownPos = new THREE.Vector2();
  engine.lastPointerClient = { x: 0, y: 0 };
  engine.maxClickDelta = 5;
  engine.isPointerDown = false;
  engine.editMode = { isActive: false, _knifeSession: null };
  engine.areaManager = {
    isSingleFullViewport: () => !multiPane,
    getViewportPanes: () => [],
    getPaneAtClientPoint: () => null,
  };
  engine.activeViewportPane = null;
  engine.transformControls = { dragging: false };
  engine.camera = new THREE.PerspectiveCamera(45, 1.25, 0.1, 100);
  engine.camera.position.set(4, 3, 5);
  engine.camera.lookAt(0, 0, 0);
  engine.controls = {
    enableDamping: true,
    target: new THREE.Vector3(0, 0, 0),
    mouseButtons: { LEFT: null, MIDDLE: THREE.MOUSE.ROTATE, RIGHT: null },
    update() { calls.controlsUpdates.push(this.enableDamping); },
  };
  engine.viewHelper = {
    visible: true,
    animating: true,
    handleClick: () => { calls.handleClick++; return true; },
    handleClickTopRight: (e) => { calls.handleClickTopRight.push({ x: e.clientX, y: e.clientY }); return true; },
  };
  engine._performRaycastSelection = () => { calls.raycast++; };
  return { engine, calls };
}

await test('Engine _onPointerDown/_onPointerUp bỏ qua RMB/MMB và không hủy vùng chọn', async () => {
  const restore = makeFakeWindowAndDoc();
  try {
    const { engine, calls } = makeMockEngine(false);
    engine._onPointerDown({ button: 2, clientX: 500, clientY: 400 });
    engine._onPointerUp({ button: 2, clientX: 500, clientY: 400 });
    engine._onPointerDown({ button: 1, clientX: 500, clientY: 400 });
    engine._onPointerUp({ button: 1, clientX: 500, clientY: 400 });
    assert.equal(calls.raycast, 0, 'RMB và MMB không được gọi _performRaycastSelection');
    assert.equal(calls.handleClick, 0, 'RMB và MMB không được kích hoạt ViewHelper');
  } finally {
    restore();
  }
});

await test('ViewHelper single-pane chỉ gọi handleClick(event) và multi-pane gọi handleClickTopRight góc dưới phải', async () => {
  const restore = makeFakeWindowAndDoc();
  try {
    // Single-pane: bottom-right click should use handleClick(event), not handleClickTopRight
    const single = makeMockEngine(false);
    single.engine._onPointerDown({ button: 0, clientX: 950, clientY: 750 });
    single.engine._onPointerUp({ button: 0, clientX: 950, clientY: 750 });
    assert.equal(single.calls.handleClick, 1);
    assert.equal(single.calls.handleClickTopRight.length, 0);
    assert.equal(single.calls.raycast, 0, 'Click trúng ViewHelper không được deselect object');

    // Multi-pane: dispatches to handleClickTopRight(event), NOT handleClick(event)
    const multi = makeMockEngine(true);
    multi.engine._onPointerDown({ button: 0, clientX: 960, clientY: 740 });
    multi.engine._onPointerUp({ button: 0, clientX: 960, clientY: 740 });
    assert.equal(multi.calls.handleClickTopRight.length, 1);
    assert.equal(multi.calls.handleClick, 0);
    assert.equal(multi.calls.raycast, 0);
    assert.equal(multi.calls.handleClickTopRight[0].x, 960);
    assert.equal(multi.calls.handleClickTopRight[0].y, 740);
  } finally {
    restore();
  }
});

await test('Engine _onPointerUp chặn raycast khi Sculpt/Modal/Knife đang bật hoặc khi kéo > 5px', async () => {
  const restore = makeFakeWindowAndDoc();
  try {
    const { engine, calls } = makeMockEngine(false);
    engine.viewHelper.handleClick = () => false;

    // 1. Drag > 5px
    engine._onPointerDown({ button: 0, clientX: 100, clientY: 100 });
    engine._onPointerUp({ button: 0, clientX: 120, clientY: 100 });
    assert.equal(calls.raycast, 0);

    // 2. Sculpt Mode active
    globalThis.window.sculptMode.isActive = true;
    engine._onPointerDown({ button: 0, clientX: 100, clientY: 100 });
    engine._onPointerUp({ button: 0, clientX: 100, clientY: 100 });
    assert.equal(calls.raycast, 0);
    globalThis.window.sculptMode.isActive = false;

    // 3. Modal Transform active
    globalThis.window.modalTransformManager.isActive = true;
    engine._onPointerDown({ button: 0, clientX: 100, clientY: 100 });
    engine._onPointerUp({ button: 0, clientX: 100, clientY: 100 });
    assert.equal(calls.raycast, 0);
    globalThis.window.modalTransformManager.isActive = false;

    // 4. EditMode Knife session active
    engine.editMode = { isActive: true, _knifeSession: { points: [] } };
    engine._onPointerDown({ button: 0, clientX: 100, clientY: 100 });
    engine._onPointerUp({ button: 0, clientX: 100, clientY: 100 });
    assert.equal(calls.raycast, 0);
    engine.editMode._knifeSession = null;

    // 5. Normal short LMB click works
    engine._onPointerDown({ button: 0, clientX: 100, clientY: 100 });
    engine._onPointerUp({ button: 0, clientX: 101, clientY: 101 });
    assert.equal(calls.raycast, 1);
  } finally {
    restore();
  }
});

await test('Engine setCameraPreset xóa momentum ViewHelper + OrbitControls damping tức thời', async () => {
  const restore = makeFakeWindowAndDoc();
  try {
    const { engine, calls } = makeMockEngine(false);
    engine.viewHelper.animating = true;
    engine.setCameraPreset('front');
    assert.equal(engine.viewHelper.animating, false);
    assert.ok(calls.controlsUpdates.includes(false), '_stopCameraTransitions phải tắt enableDamping khi xả momentum');
    assert.equal(engine.controls.enableDamping, true, 'Sau khi xả momentum phải khôi phục enableDamping');
    assert.ok(engine.camera.position.z > 0 && Math.abs(engine.camera.position.x) < 1e-6);
  } finally {
    restore();
  }
});

await test('BlenderProTools Shift+MMB / Alt+Shift+LMB gán MOUSE.ROTATE (bù OrbitControls invert) & chặn marquee khi Ctrl/Gizmo', async () => {
  const restore = makeFakeWindowAndDoc();
  try {
    const { engine } = makeMockEngine(false);
    const tools = new BlenderProTools({
      engine,
      sceneManager: { selectedObjects: new Set(), clearSelection() {} },
      editMode: { isActive: false },
      modalTransform: { isActive: false },
      modelingSuite: null,
    });
    tools.keymapPreset = 'blender-pro';

    // Shift+MMB must assign MOUSE.ROTATE so OrbitControls internally switches to PAN
    tools._onCapturePointerDown({ button: 1, shiftKey: true, ctrlKey: false, metaKey: false, altKey: false, clientX: 200, clientY: 200 });
    assert.equal(engine.controls.mouseButtons.MIDDLE, THREE.MOUSE.ROTATE);

    // Alt+Shift+LMB must assign MOUSE.ROTATE for OrbitControls Emulate-3-Button-Mouse Pan
    tools._onCapturePointerDown({ button: 0, shiftKey: true, ctrlKey: false, metaKey: false, altKey: true, clientX: 200, clientY: 200 });
    assert.equal(engine.controls.mouseButtons.LEFT, THREE.MOUSE.ROTATE);

    // Ctrl+LMB must NOT start marquee candidate
    tools._lmbCandidate = null;
    tools._onCapturePointerDown({
      button: 0, shiftKey: false, ctrlKey: true, metaKey: false, altKey: false,
      clientX: 200, clientY: 200, target: { closest: () => null },
    });
    assert.equal(tools._lmbCandidate, null);

    // Active transformControls.dragging clears _lmbCandidate without creating _boxState
    tools._lmbCandidate = { startX: 200, startY: 200, shiftKey: false };
    engine.transformControls.dragging = true;
    tools._onWindowPointerMove({ clientX: 300, clientY: 300 });
    assert.equal(tools._lmbCandidate, null);
    assert.equal(tools._boxState, null);
  } finally {
    restore();
  }
});

await test('SculptMode _onPointerDown / _onPointerUp đồng bộ Shift smooth brush & bỏ qua MMB', async () => {
  const restore = makeFakeWindowAndDoc();
  try {
    const sculpt = Object.create(SculptMode.prototype);
    sculpt.isActive = true;
    sculpt.brushType = 'draw';
    sculpt._tempBrush = null;
    sculpt._invertStroke = false;
    sculpt.isSculpting = false;
    sculpt._hasMovedDuringStroke = false;
    sculpt.targetMesh = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), new THREE.MeshBasicMaterial());
    sculpt.engine = {
      domElement: { getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }) },
      camera: new THREE.PerspectiveCamera(),
      controls: { enabled: true },
    };
    sculpt._updateMouse = () => {};
    sculpt._raycastTarget = () => ({ point: new THREE.Vector3(), faceIndex: 0 });
    sculpt._grabPlane = new THREE.Plane();
    sculpt._invMatrix = new THREE.Matrix4();
    sculpt._tmpWorldScale = new THREE.Vector3(1, 1, 1);
    sculpt._applyBrush = () => {};
    sculpt._beginUndoSnapshot = () => {};
    sculpt._updateBrushCursor = () => {};
    sculpt._syncUIState = () => {};
    sculpt._onPointerMove = () => {};

    // MMB ignored cleanly
    sculpt._onPointerDown({ button: 1, shiftKey: false, ctrlKey: false, altKey: false, clientX: 50, clientY: 50 });
    assert.equal(sculpt.isSculpting, false);
    assert.equal(sculpt.engine.controls.enabled, true);

    // Shift+LMB sets temporary smooth brush
    sculpt._onPointerDown({ button: 0, shiftKey: true, ctrlKey: false, altKey: false, clientX: 50, clientY: 50 });
    assert.equal(sculpt.isSculpting, true);
    assert.equal(sculpt._tempBrush, 'smooth');
    assert.equal(sculpt.engine.controls.enabled, false);

    // Releasing mouse with Shift already released clears _tempBrush
    sculpt._onPointerUp({ button: 0, shiftKey: false });
    assert.equal(sculpt.isSculpting, false);
    assert.equal(sculpt._tempBrush, null);
    assert.equal(sculpt.engine.controls.enabled, true);
  } finally {
    restore();
  }
});

await test('Thoát split-screen (setActiveViewportPane / syncViewportPaneControls) khôi phục OrbitControls và tôn trọng Camera View', async () => {
  const restore = makeFakeWindowAndDoc();
  try {
    const engine = Object.create(Engine.prototype);
    let isSingle = false;
    const cam0 = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
    const cam1 = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
    const sceneCam = new THREE.PerspectiveCamera(35, 1, 0.1, 100);
    const pane0 = { id: 'area-main', isPrimary: true, camera: cam0, perspectiveCamera: cam0, orthographicCamera: cam0, controls: { enabled: false }, viewHelper: {}, sceneCameraObj: null };
    const pane1 = { id: 'area-1', isPrimary: false, camera: cam1, perspectiveCamera: cam1, orthographicCamera: cam1, controls: { enabled: true }, viewHelper: {}, sceneCameraObj: null };

    engine.scene = new THREE.Scene();
    engine.areaManager = {
      isSingleFullViewport: () => isSingle,
      panes: new Map([['area-main', pane0], ['area-1', pane1]]),
      getActivePane: () => pane0,
    };
    engine.activeViewportPane = pane1;
    engine.camera = cam1;
    engine.controls = pane1.controls;
    engine.transformControls = { dragging: false, camera: cam1, updateMatrixWorld() {} };
    engine.rasterRenderer = null;
    engine.updateViewportCameraLabel = () => {};

    // Exit split back to pane0 (whose controls.enabled was false while pane1 was hovered!)
    isSingle = true;
    engine.setActiveViewportPane(pane0);
    assert.equal(pane0.controls.enabled, true, 'Pane sống sót sau thoát split phải bật lại controls.enabled');
    assert.equal(engine.controls.enabled, true);
    assert.equal(pane1.controls.enabled, false, 'Pane cũ không còn được bật');

    // Locked by pane.sceneCameraObj or window.cameraManager.lookingThrough -> controls must stay disabled
    pane0.sceneCameraObj = { name: 'ShotCam' };
    globalThis.window.cameraManager = {
      lookingThrough: pane0.sceneCameraObj,
      getCameraEntry: () => ({ camera: sceneCam }),
    };
    engine.syncViewportPaneControls(pane0);
    assert.equal(pane0.controls.enabled, false, 'Đang nhìn qua Camera View không được bật OrbitControls');

    pane0.sceneCameraObj = null;
    globalThis.window.cameraManager.lookingThrough = null;
    engine.syncViewportPaneControls(pane0);
    assert.equal(pane0.controls.enabled, true, 'Thoát Camera View bật lại OrbitControls');
  } finally {
    restore();
  }
});

await test('getViewportContextAtPoint & getViewportNDC phân giải đúng pane dưới con trỏ và sceneCameraObj', async () => {
  const restore = makeFakeWindowAndDoc();
  try {
    const engine = Object.create(Engine.prototype);
    const cam0 = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
    const cam1 = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
    const shotCamObj = { name: 'ShotCam' };
    const shotCam = new THREE.PerspectiveCamera(30, 1.5, 0.1, 100);
    const r0 = { left: 0, top: 0, right: 400, bottom: 600, width: 400, height: 600 };
    const r1 = { left: 406, top: 0, right: 1000, bottom: 600, width: 594, height: 600 };
    const pane0 = { id: 'p0', camera: cam0, controls: {}, viewportEl: { getBoundingClientRect: () => r0 }, sceneCameraObj: null };
    const pane1 = { id: 'p1', camera: cam1, controls: {}, viewportEl: { getBoundingClientRect: () => r1 }, sceneCameraObj: shotCamObj };

    globalThis.window.cameraManager = {
      getCameraEntry: (obj) => (obj === shotCamObj ? { camera: shotCam } : null),
    };
    engine.domElement = { getBoundingClientRect: () => ({ left: 0, top: 0, right: 1000, bottom: 600, width: 1000, height: 600 }) };
    engine.camera = cam0;
    engine.controls = pane0.controls;
    engine.activeViewportPane = pane0;
    engine.areaManager = {
      isSingleFullViewport: () => false,
      getActivePane: () => pane0,
      getPaneAtClientPoint: (cx, cy) => (cx >= 406 ? pane1 : pane0),
    };

    // Center of pane1 = (406 + 594/2 = 703, 300) even while activeViewportPane is still pane0!
    const ctx = engine.getViewportContextAtPoint(703, 300);
    assert.equal(ctx.pane, pane1);
    assert.equal(ctx.camera, shotCam, 'Phải dùng render camera của sceneCameraObj khi raycast trong pane Camera');
    assert.ok(Math.abs(shotCam.aspect - (594 / 600)) < 1e-4, 'Aspect camera phải khớp kích thước thực của pane1');

    const ndc = engine.getViewportNDC(703, 300);
    assert.ok(Math.abs(ndc.x) < 1e-6 && Math.abs(ndc.y) < 1e-6, `Kỳ vọng NDC (0,0) tại tâm pane1, nhận (${ndc.x}, ${ndc.y})`);
  } finally {
    restore();
  }
});

await test('ViewHelper tự ẩn/thu nhỏ trên khung hình nhỏ và không nuốt click ngoài góc dưới phải', async () => {
  const restore = makeFakeWindowAndDoc();
  try {
    const engine = Object.create(Engine.prototype);
    engine.domElement = { getBoundingClientRect: () => ({ left: 0, top: 0, right: 360, bottom: 220, width: 360, height: 220 }) };
    engine.camera = new THREE.PerspectiveCamera(45, 360 / 220, 0.1, 100);
    engine.controls = { target: new THREE.Vector3(), addEventListener() {} };
    engine.areaManager = { isSingleFullViewport: () => true };

    assert.equal(engine._getViewHelperDim(194, 162, false), 0, 'Viewport < 200x150 phải ẩn ViewHelper');
    assert.equal(engine._getViewHelperDim(300, 140, false), 0, 'Viewport thấp < 150px phải ẩn ViewHelper');
    assert.equal(engine._getViewHelperDim(354, 222, false), 53, 'Viewport nhỏ vừa thu tỷ lệ dim = floor(222 * 0.24)');
    assert.equal(engine._getViewHelperDim(874, 582, false), 128, 'Viewport desktop giữ nguyên 128px');

    const vh = engine.createViewHelper(engine.camera, engine.controls);
    assert.ok(vh && typeof vh.handleClick === 'function');
    // Center of 360x220 = (180, 110): previously inside hardcoded 128x128 from bottom-right? Wait at 360-128=232; on 220x200 center (110,100) WAS inside [220-128=92..220]!
    engine.domElement = { getBoundingClientRect: () => ({ left: 0, top: 0, right: 220, bottom: 200, width: 220, height: 200 }) };
    const dim = engine._getViewHelperDim(220, 200, false); // 48
    assert.equal(dim, 48);
    assert.equal(vh.handleClick({ button: 0, clientX: 110, clientY: 100 }), false, 'Click ở tâm viewport nhỏ không được rơi vào ViewHelper');
  } finally {
    restore();
  }
});

await test('EditMode handleRaycast chọn đúng mặt trên mesh chia lưới (7x7x7 Box, Subdivide, Sphere có pole suy biến)', async () => {
  const restore = makeFakeWindowAndDoc();
  try {
    const engine = makeMockEngine(false);
    engine.scene = new THREE.Scene();
    engine.camera = new THREE.PerspectiveCamera(45, 1000 / 800, 0.1, 200);
    engine.camera.position.set(7, 10, 9);
    engine.camera.lookAt(0, 1, 0);
    engine.camera.updateMatrixWorld(true);
    engine.transformControls = {
      object: null,
      dragging: false,
      attach(o) { this.object = o; },
      detach() { this.object = null; },
      addEventListener() {},
      removeEventListener() {},
    };
    const rect = { left: 0, top: 0, width: 1000, height: 800 };
    engine.getViewportContextAtPoint = () => ({ rect, camera: engine.camera, pane: null });

    const editMode = new EditMode(engine, {});

    const verifyPickedFaces = (mesh, label) => {
      mesh.updateMatrixWorld(true);
      editMode.enter(mesh);
      editMode.setSelectionMode('face');
      const camPos = engine.camera.position;
      const pickedFaces = [];
      for (const f of editMode.faces) {
        const wc = f.centroid.clone().applyMatrix4(mesh.matrixWorld);
        const wn = f.normal.clone().transformDirection(mesh.matrixWorld).normalize();
        if (wn.dot(camPos.clone().sub(wc).normalize()) < 0.4) continue;
        const ndc = wc.clone().project(engine.camera);
        if (Math.abs(ndc.x) > 0.8 || Math.abs(ndc.y) > 0.8) continue;
        pickedFaces.push({ f, wc, ndc });
        if (pickedFaces.length >= 12) break;
      }
      assert.ok(pickedFaces.length >= 6, `${label}: không đủ mặt hướng về camera`);
      for (const item of pickedFaces) {
        editMode.selectedFaces.clear();
        const clientX = rect.left + (item.ndc.x + 1) * 0.5 * rect.width;
        const clientY = rect.top + (-item.ndc.y + 1) * 0.5 * rect.height;
        editMode.handleRaycast({ clientX, clientY, shiftKey: false, metaKey: false, ctrlKey: false, altKey: false });
        assert.deepEqual([...editMode.selectedFaces], [item.f.id],
          `${label}: click mặt ${item.f.id} nhưng chọn nhầm [${[...editMode.selectedFaces]}]`);
      }
      editMode.exit();
    };

    const box294 = new THREE.Mesh(new THREE.BoxGeometry(10.3, 2.6, 8.7, 7, 7, 7), new THREE.MeshStandardMaterial());
    box294.position.set(0, 1, 0);
    verifyPickedFaces(box294, 'Box 7x7x7 (294 faces)');

    const subMesh = new THREE.Mesh(new THREE.BoxGeometry(4, 4, 4), new THREE.MeshStandardMaterial());
    subMesh.position.set(0, 2, 0);
    subMesh.updateMatrixWorld(true);
    editMode.enter(subMesh);
    editMode.setSelectionMode('face');
    editMode.subdivide();
    editMode.selectedFaces.clear();
    editMode.subdivide();
    editMode.exit();
    verifyPickedFaces(subMesh, 'Cube + Subdivide x2 (96 faces)');

    const sphere = new THREE.Mesh(new THREE.SphereGeometry(2.5, 16, 12), new THREE.MeshStandardMaterial());
    sphere.position.set(0, 1, 0);
    verifyPickedFaces(sphere, 'SphereGeometry 16x12');
  } finally {
    restore();
  }
});

if (failures.length > 0) {
  console.error(`\n${failures.length} MOUSE INTERACTION TESTS FAILED`);
  process.exit(1);
}
console.log('\nALL 10 MOUSE INTERACTION REGRESSION TESTS PASSED');
