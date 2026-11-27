/**
 * Automated Node test suite for Stage 4.1 (Overhauled):
 * 1. Practical 3D Modeling Curriculum & Geometry-Based Auto-Grader (Object Mode Assembly,
 *    Edit Mode Extrude/Inset/Bevel Topology, Modifiers/CSG, Sculpt/Stage, Rig/Animation, Physics).
 * 2. Zero-Overlap Pointer Positioning & Mouse Cursor Evasion.
 * 3. Fast 1.2x Neural/TTS Voice Engine with Pre-fetch Cache & Markdown Stripping.
 * 4. Agent & AI Model Tutor Control Bridge.
 */

import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
  STEM_LESSONS,
  getStemLesson,
  gradeStemLesson,
  computeAvatarTargetPosition,
  TutorVoiceEngine,
  createTutorialTools
} from '../js/agent/agent-tutorial.js';
import {
  getMeshTopologyStats,
  inspectSceneGeometrySummary
} from '../js/education/stem-curriculum.js';

let passed = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`ok   ${name}`);
    passed++;
  } catch (err) {
    console.error(`FAIL ${name}:`, err);
    process.exitCode = 1;
  }
}

async function testAsync(name, fn) {
  try {
    await fn();
    console.log(`ok   ${name}`);
    passed++;
  } catch (err) {
    console.error(`FAIL ${name}:`, err);
    process.exitCode = 1;
  }
}

// 1. Kiểm tra cấu trúc 6 chuyên đề Dựng mô hình 3D
test('STEM_LESSONS has 6 practical 3D Modeling lessons with 100-point geometry rubrics', () => {
  assert.equal(STEM_LESSONS.length, 6);
  for (const lesson of STEM_LESSONS) {
    assert.ok(lesson.id && lesson.title);
    assert.ok(/^(Cơ bản|Trung cấp|Nâng cao)/.test(lesson.level));
    assert.ok(lesson.starterCode.length > 30);
    assert.ok(lesson.solutionCode.length > 30);
    assert.ok(Array.isArray(lesson.steps) && lesson.steps.length >= 2);
    for (const step of lesson.steps) {
      assert.ok(step.title && step.voiceText && step.targetSelector);
    }
    const totalPts = lesson.rubric.reduce((s, r) => s + r.points, 0);
    assert.equal(totalPts, 100, `Rubric of ${lesson.id} must sum to 100`);
  }
  assert.equal(getStemLesson(1)?.id, 'lesson-01-primitives');
  assert.equal(getStemLesson('lesson-06-physics')?.number, 6);
});

// 2. Auto-Grader Bài 1: Chấm điểm Lắp ráp 3D trực quan trên Viewport (không cần code) & DSL
test('Auto-Grader Lesson 1 grades both UI-assembled scaled meshes (no code) and Cube+Sphere scenes', () => {
  const failReport = gradeStemLesson('lesson-01-primitives', { meshes: [], code: '' });
  assert.equal(failReport.score, 0);
  assert.equal(failReport.passed, false);

  // Trường hợp 1: Học viên dựng chiếc bàn bằng tay trên UI (không viết dòng code nào, dùng Scale + Move)
  const tableTop = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), new THREE.MeshStandardMaterial());
  tableTop.scale.set(1.6, 0.15, 1.0);
  tableTop.position.set(0, 1.2, 0);
  const leg1 = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), new THREE.MeshStandardMaterial());
  leg1.scale.set(0.15, 0.6, 0.15);
  leg1.position.set(-1.3, 0.6, -0.7);
  const leg2 = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), new THREE.MeshStandardMaterial());
  leg2.scale.set(0.15, 0.6, 0.15);
  leg2.position.set(1.3, 0.6, 0.7);

  const uiAssemblyReport = gradeStemLesson('lesson-01-primitives', {
    meshes: [tableTop, leg1, leg2],
    code: '' // Không cần bất kỳ dòng code nào!
  });
  assert.equal(uiAssemblyReport.score, 100);
  assert.equal(uiAssemblyReport.passed, true);

  // Trường hợp 2: Cube + Sphere
  const cube = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), new THREE.MeshStandardMaterial({ color: 0x3498db }));
  cube.position.set(-1.8, 1, 0);
  const sphere = new THREE.Mesh(new THREE.SphereGeometry(1), new THREE.MeshStandardMaterial({ color: 0xe74c3c }));
  sphere.position.set(1.8, 1, 0);

  const passReport = gradeStemLesson('lesson-01-primitives', {
    meshes: [cube, sphere],
    code: STEM_LESSONS[0].solutionCode
  });
  assert.equal(passReport.score, 100);
  assert.equal(passReport.passed, true);
  assert.equal(passReport.gradeLetter, 'Xuất sắc (A+)');
});

// 3. Auto-Grader Bài 2: Kiểm tra trực tiếp lưới đa giác sau khi Extrude/Inset trong Edit Mode & PBR
test('Auto-Grader Lesson 2 validates both Edit Mode Extrude/Inset topology (>24 vertices) and PBR + Light', () => {
  const rawCube = new THREE.Mesh(
    new THREE.BoxGeometry(2, 2, 2),
    new THREE.MeshStandardMaterial({ color: 0xd2d5da, metalness: 0.0, roughness: 0.65 })
  );
  const rawReport = gradeStemLesson('lesson-02-materials-lights', { meshes: [rawCube], lights: [], code: '' });
  assert.equal(rawReport.passed, false);

  // Mô phỏng khối Cube đã được Extrude / Subdivide trong Edit Mode (số đỉnh tăng từ 24 lên 54 đỉnh, không cần code)
  const extrudedMesh = new THREE.Mesh(
    new THREE.BoxGeometry(2, 2, 2, 2, 2, 2),
    new THREE.MeshStandardMaterial({ color: 0xd2d5da })
  );
  extrudedMesh.userData.primitiveType = 'cube';
  extrudedMesh.userData.editedInEditMode = true;
  const topo = getMeshTopologyStats(extrudedMesh);
  assert.ok(topo.vertexCount > 24 && topo.isExtrudedOrEdited);

  // Chuẩn mới: thiếu đèn thật thì KHÔNG đạt, dù lưới đã edit hay editor gõ chữ addLight.
  const noLightReport = gradeStemLesson('lesson-02-materials-lights', {
    meshes: [extrudedMesh],
    lights: [],
    code: 'studio.addLight({ type: "point" })' // chữ trong editor chưa chạy không được tính
  });
  assert.equal(noLightReport.score, 65);
  assert.equal(noLightReport.passed, false);

  const editModeReport = gradeStemLesson('lesson-02-materials-lights', {
    meshes: [extrudedMesh],
    lights: [new THREE.PointLight(0xffffff, 2.0)],
    code: ''
  });
  assert.equal(editModeReport.score, 100);
  assert.equal(editModeReport.passed, true);

  // Mô phỏng PBR Metallic + PointLight
  const goldSphere = new THREE.Mesh(
    new THREE.SphereGeometry(1.1),
    new THREE.MeshStandardMaterial({ color: 0xf1c40f, metalness: 0.9, roughness: 0.15 })
  );
  const full = gradeStemLesson('lesson-02-materials-lights', {
    meshes: [goldSphere],
    lights: [new THREE.PointLight(0xffffff, 2.0)],
    code: ''
  });
  assert.equal(full.score, 100);
});

// 4. Auto-Grader Bài 3, 4, 5, 6 (Modifiers, Sculpt/Stage, Rig/Animation, Physics)
test('Auto-Grader Lessons 3, 4, 5, 6 validate Modifiers, Sculpt/Stage, Animation, and Physics', () => {
  // Lesson 3: Mesh gắn Modifier (không cần viết vòng lặp for trong code)
  const modMesh = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2, 2, 2, 2), new THREE.MeshStandardMaterial());
  modMesh.userData.modifierStack = [{ id: 'm1', type: 'array', enabled: true }];
  const r3Mod = gradeStemLesson('lesson-03-loops-architecture', {
    objects: [modMesh],
    meshes: [modMesh],
    code: ''
  });
  assert.equal(r3Mod.score, 100);

  // Lesson 4: Stage + >= 2 lights
  const pillars = [-2, 2].map(i => {
    const m = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, 3), new THREE.MeshStandardMaterial());
    m.position.set(i * 3.0, 1.5, 0);
    return m;
  });
  const r4 = gradeStemLesson('lesson-04-prefab-stage', {
    meshes: pillars,
    lights: [new THREE.PointLight(), new THREE.PointLight()],
    code: ''
  });
  assert.equal(r4.score, 100);

  // Lesson 3 chuẩn mới: chỉ edit lưới (không modifier/loop) không được tính là kỹ thuật modifier
  const editedOnly = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2, 2, 2, 2), new THREE.MeshStandardMaterial());
  editedOnly.userData.editedInEditMode = true;
  const r3EditedOnly = gradeStemLesson('lesson-03-loops-architecture', {
    objects: [editedOnly],
    meshes: [editedOnly],
    code: ''
  });
  assert.equal(r3EditedOnly.criteria.find(c => c.id === 'uses-for-loop').passed, false);

  // Lesson 5: nhân vật có sẵn animations nhưng chưa gắn timeline/chưa chạy thì không tính là hoạt cảnh
  const idleCharacter = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), new THREE.MeshStandardMaterial());
  idleCharacter.animations = [new THREE.AnimationClip('idle', 1, [])];
  const r5Idle = gradeStemLesson('lesson-05-animation', {
    meshes: [idleCharacter],
    objects: [idleCharacter],
    code: ''
  });
  assert.equal(r5Idle.criteria.find(c => c.id === 'uses-animation-driver').passed, false);

  // Lesson 5: Animation driver / Timeline
  const r5 = gradeStemLesson('lesson-05-animation', {
    meshes: [pillars[0]],
    studio: { _animationCallbacks: [() => {}] },
    code: ''
  });
  assert.equal(r5.score, 100);

  // Lesson 6: Physics dynamic body at y >= 2.5
  const ball = new THREE.Mesh(new THREE.SphereGeometry(0.8), new THREE.MeshStandardMaterial());
  ball.position.set(0, 4.5, 0);
  ball.userData.physics = { enabled: true, type: 'dynamic', restitution: 0.8 };
  const r6 = gradeStemLesson('lesson-06-physics', {
    meshes: [ball],
    code: ''
  });
  assert.equal(r6.score, 100);

  // Kiểm tra hàm inspectSceneGeometrySummary dùng cho AI Coach 1-1
  const summary = inspectSceneGeometrySummary([modMesh, ball], { isActive: true, selectionMode: 'face' });
  assert.equal(summary.activeMode, 'edit');
  assert.equal(summary.editSelectionMode, 'face');
  assert.equal(summary.meshCount, 2);
  assert.ok(summary.totalVertices > 24);
});

// 5. Toán học định vị Con trỏ Giáo viên KHÔNG CHẮN GIAO DIỆN & TỰ ĐỘNG NÉ CHUỘT
test('computeAvatarTargetPosition guarantees zero overlap with target controls and evades mouse cursor', () => {
  const vp = { width: 1280, height: 800 };

  // Mục tiêu ở thanh menu đỉnh (#menu-add) -> đặt bên dưới, mũi tên chỉ lên (up), không đè lên nút
  const menuRect = { left: 180, top: 8, right: 230, bottom: 34, width: 50, height: 26 };
  const topMenuPos = computeAvatarTargetPosition(menuRect, vp, 44);
  assert.equal(topMenuPos.pointerDirection, 'up');
  assert.equal(topMenuPos.overlapsTarget, false);
  assert.ok(topMenuPos.y >= menuRect.bottom + 10);

  // Mục tiêu ở Sidebar bên phải (#outliner-panel) -> đặt bên trái mục tiêu, mũi tên chỉ sang phải (right)
  const rightRect = { left: 980, top: 200, right: 1260, bottom: 500, width: 280, height: 300 };
  const rightPanelPos = computeAvatarTargetPosition(rightRect, vp, 44);
  assert.equal(rightPanelPos.pointerDirection, 'right');
  assert.equal(rightPanelPos.overlapsTarget, false);
  assert.ok(rightPanelPos.x + 44 <= rightRect.left);

  // Mục tiêu ở Toolbar bên trái (#tool-move) -> đặt bên phải mục tiêu, mũi tên chỉ sang trái (left)
  const leftRect = { left: 8, top: 180, right: 44, bottom: 216, width: 36, height: 36 };
  const leftToolPos = computeAvatarTargetPosition(leftRect, vp, 44);
  assert.equal(leftToolPos.pointerDirection, 'left');
  assert.equal(leftToolPos.overlapsTarget, false);

  // Kiểm tra tự động né chuột (Cursor Evasion): khi chuột người dùng tiến thẳng vào vị trí bên phải nút #tool-move,
  // con trỏ Giáo viên tự động chuyển sang vị trí bên dưới hoặc bên trên nút!
  const evadedPos = computeAvatarTargetPosition(leftRect, vp, 44, {
    x: leftToolPos.x + 20,
    y: leftToolPos.y + 20
  });
  assert.equal(evadedPos.overlapsTarget, false);
  assert.notEqual(
    `${evadedPos.x},${evadedPos.y}`,
    `${leftToolPos.x},${leftToolPos.y}`,
    'Avatar must shift away when user mouse cursor approaches'
  );
});

// 6. Bộ phát giọng nói Giáo viên 1-1 Tốc độ cao (1.2x + Clean Markdown + Pre-fetch)
test('TutorVoiceEngine defaults to fast 1.2x rate, strips markdown, and supports setRate/mute', () => {
  let spokenUtterance = null;
  const mockSynth = {
    getVoices: () => [
      { name: 'Alex', lang: 'en-US' },
      { name: 'Linh', lang: 'vi-VN' }
    ],
    speak: (u) => { spokenUtterance = u; },
    cancel: () => {}
  };

  const engine = new TutorVoiceEngine({
    speechSynthesis: mockSynth,
    utteranceFactory: (text) => ({ text })
  });

  assert.equal(engine.rate, 1.2);
  const res = engine.speak('Bấm nút **`Extrude (E)`** -> đùn khối `#btn-edit-extrude`!');
  assert.equal(res.spoken, true);
  assert.equal(res.rate, 1.2);
  assert.ok(!res.text.includes('**') && !res.text.includes('`') && !res.text.includes('#btn-edit-extrude'));
  assert.equal(spokenUtterance.rate, 1.2);

  engine.setRate(1.35);
  assert.equal(engine.rate, 1.35);
  engine.stop();

  engine.setEnabled(false);
  assert.equal(engine.speak('Đang tắt tiếng').spoken, false);
  assert.equal(engine.speak('Nghe lại', { force: true }).spoken, true);
  engine.stop();
});

// 7. Tích hợp giữa agent.tutorial.step và stemTutor
await testAsync('agent.tutorial.step moves the STEM Tutor avatar to the highlighted control and speaks', async () => {
  const movedTargets = [];
  const ctx = {
    ui: {
      highlight: async (id) => ({ id, highlighted: true })
    },
    app: {
      stemTutor: {
        moveToTarget: (target, opts) => movedTargets.push({ target, opts })
      }
    }
  };

  const tutorial = createTutorialTools(ctx);
  tutorial.start({ title: 'Bài hướng dẫn 1-1', audience: 'Học viên 3D' });
  await tutorial.step({
    text: 'Hãy bấm vào menu Add để thêm khối lập phương.',
    highlight: 'menu-add',
    screenshot: false
  });

  assert.equal(movedTargets.length, 1);
  assert.equal(movedTargets[0].target, 'menu-add');
  assert.equal(movedTargets[0].opts.speechText, 'Hãy bấm vào menu Add để thêm khối lập phương.');
});

console.log(`\n${passed} STEM TUTOR & 3D MODELING AUTO-GRADER TESTS PASSED`);
if (process.exitCode) console.error('STEM TUTOR SUITE FAILED');
