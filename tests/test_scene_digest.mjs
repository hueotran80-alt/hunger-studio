/**
 * Unit tests — AI live scene digest.
 * Cho Copilot biết cảnh thật (hierarchy, poly, material, clip, selection) thay
 * vì cờ boolean. Kiểm tra cả nội dung digest lẫn ngân sách prompt.
 */
import assert from 'node:assert/strict';
import { buildSceneDigest, formatSceneDigestForPrompt } from '../js/ai/scene-digest.js';

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  PASS  ${name}`);
    passed += 1;
  } catch (err) {
    console.error(`  FAIL  ${name}\n        ${err.message}`);
    failed += 1;
  }
}

function makeMesh(name, vertices, { triangles = null, material = 'Default', skinned = false, morphs = 0 } = {}) {
  return {
    name,
    type: skinned ? 'SkinnedMesh' : 'Mesh',
    isMesh: true,
    isSkinnedMesh: skinned,
    geometry: {
      attributes: { position: { count: vertices } },
      index: triangles === null ? null : { count: triangles * 3 }
    },
    material: material ? { name: material } : null,
    position: { x: 1.234, y: -2.5, z: 0 },
    morphTargetInfluences: new Array(morphs).fill(0),
    children: []
  };
}

function makeGroup(name, children = []) {
  return { name, type: 'Group', isGroup: true, children, position: { x: 0, y: 0, z: 0 } };
}

function makeScene(children = []) {
  return { type: 'Scene', children };
}

const house = makeGroup('House_Group', [
  makeMesh('Wall_Main', 1200, { triangles: 800, material: 'Brick' }),
  makeMesh('Window_Glass', 240, { triangles: 160, material: 'Glass' })
]);
const hero = makeMesh('Hero', 3000, { triangles: 2000, material: 'Skin', skinned: true, morphs: 3 });
hero.animations = [{ name: 'Idle' }, { name: 'Walk' }];
const sun = { name: 'Sun', type: 'DirectionalLight', isLight: true, children: [] };
const camera = { name: 'Camera', type: 'PerspectiveCamera', isCamera: true, children: [] };
const helper = {
  name: 'GridHelper',
  type: 'GridHelper',
  isMesh: true,
  geometry: { attributes: { position: { count: 999 } }, index: { count: 999 } },
  children: []
};

console.log('\nAI live scene digest suite');

test('đếm đúng object/mesh/group/light/camera và bỏ qua helper', () => {
  const digest = buildSceneDigest(makeScene([house, hero, sun, camera, helper]));
  assert.equal(digest.isEmpty, false);
  assert.equal(digest.counts.meshes, 3, 'Wall + Window + Hero');
  assert.equal(digest.counts.groups, 1);
  assert.equal(digest.counts.lights, 1);
  assert.equal(digest.counts.cameras, 1);
  // 6 = House_Group + Wall + Window + Hero + Sun + Camera (GridHelper bị loại)
  assert.equal(digest.counts.objects, 6, 'không tính GridHelper');
  assert.equal(digest.counts.skinned, 1);
});

test('tổng hợp poly count và sắp xếp object nặng nhất trước', () => {
  const digest = buildSceneDigest(makeScene([house, hero]));
  assert.equal(digest.counts.triangles, 800 + 160 + 2000);
  assert.equal(digest.counts.vertices, 1200 + 240 + 3000);
  assert.equal(digest.objects[0].name, 'Hero');
  assert.equal(digest.objects[1].name, 'Wall_Main');
});

test('gom material duy nhất, đếm animation clip của rig', () => {
  const digest = buildSceneDigest(makeScene([house, hero]));
  assert.deepEqual(digest.materials, ['Brick', 'Glass', 'Skin']);
  assert.deepEqual(digest.clips, ['Idle', 'Walk']);
  assert.equal(digest.counts.materials, 3);
  assert.equal(digest.counts.clips, 2);
});

test('giữ selection và morph target count', () => {
  const digest = buildSceneDigest(makeScene([hero]), { selection: ['Hero'] });
  assert.deepEqual(digest.selection, ['Hero']);
  const heroEntry = digest.objects.find((object) => object.name === 'Hero');
  assert.equal(heroEntry.morphTargets, 3);
  assert.equal(heroEntry.skinned, true);
  assert.deepEqual(heroEntry.position, [1.23, -2.5, 0]);
});

test('giới hạn maxObjects và bật cờ truncated', () => {
  const many = Array.from({ length: 10 }, (_, index) => makeMesh(`M${index}`, 100 + index, { triangles: 10 + index }));
  const digest = buildSceneDigest(makeScene(many), { maxObjects: 4 });
  assert.equal(digest.objects.length, 4);
  assert.equal(digest.truncated, true);
  assert.equal(digest.counts.objects, 10);
});

test('cảnh rỗng: isEmpty và prompt nói EMPTY', () => {
  const digest = buildSceneDigest(makeScene([]));
  assert.equal(digest.isEmpty, true);
  assert.equal(digest.counts.objects, 0);
  assert.match(formatSceneDigestForPrompt(digest), /EMPTY/);
});

test('scene null/undefined không ném lỗi', () => {
  assert.equal(buildSceneDigest(null).isEmpty, true);
  assert.equal(buildSceneDigest(undefined).isEmpty, true);
  assert.match(formatSceneDigestForPrompt(null), /unavailable/);
});

test('prompt text chứa số liệu, selection, material và chỉ dẫn "build on"', () => {
  const text = formatSceneDigestForPrompt(buildSceneDigest(makeScene([house, hero, sun]), { selection: ['Hero'] }));
  assert.match(text, /3 objects|objects \(/);
  assert.match(text, /Selection: Hero/);
  assert.match(text, /Materials: .*Brick/);
  assert.match(text, /Animation clips: Idle, Walk/);
  assert.match(text, /Build ON these objects/);
  assert.match(text, /Hero \[SkinnedMesh/);
});

test('prompt text tôn trọng maxChars', () => {
  const digest = buildSceneDigest(makeScene([house, hero]), { maxObjects: 24 });
  const text = formatSceneDigestForPrompt(digest, { maxChars: 260 });
  assert.ok(text.length <= 260, `length=${text.length}`);
  assert.ok(text.endsWith('…'));
});

test('material dạng mảng (multi-material) được ghép tên', () => {
  const mesh = makeMesh('Multi', 300, { triangles: 100 });
  mesh.material = [{ name: 'Wood' }, { name: 'Metal' }];
  const digest = buildSceneDigest(makeScene([mesh]));
  assert.equal(digest.objects[0].material, 'Wood + Metal');
  assert.deepEqual(digest.materials, ['Metal', 'Wood']);
});

test('object có userData.isLightHelper bị loại khỏi digest', () => {
  const helperMesh = makeMesh('HelperMesh', 500, { triangles: 400 });
  helperMesh.userData = { isLightHelper: true };
  const digest = buildSceneDigest(makeScene([helperMesh, hero]));
  assert.equal(digest.counts.meshes, 1);
  assert.equal(digest.objects.length, 1);
});

test('object không tên nhận nhãn ổn định Mesh#n / Group#n thay vì (unnamed)', () => {
  const unnamedA = makeMesh('', 100, { triangles: 10 });
  const unnamedB = makeMesh('', 100, { triangles: 20 });
  const unnamedGroup = makeGroup('', [makeMesh('', 50, { triangles: 5 })]);
  const digest = buildSceneDigest(makeScene([unnamedA, unnamedB, unnamedGroup]));
  const labels = digest.objects.map((object) => object.name).sort();
  assert.deepEqual(labels, ['Group#3', 'Mesh#1', 'Mesh#2', 'Mesh#4'].sort());
  assert.ok(!labels.some((label) => label.includes('unnamed')));
  const text = formatSceneDigestForPrompt(digest);
  assert.ok(!text.includes('(unnamed)'));
});

test('digest ổn định (cùng input -> cùng output đã sắp xếp)', () => {
  const first = JSON.stringify(buildSceneDigest(makeScene([house, hero])).objects.map((o) => o.name));
  const second = JSON.stringify(buildSceneDigest(makeScene([house, hero])).objects.map((o) => o.name));
  assert.equal(first, second);
});

test('bỏ qua Studio_Lighting / system groups nhưng vẫn đếm user objects bên trong Scene_Collection', () => {
  const sysLights = { name: 'Studio_Lighting', type: 'Group', isGroup: true, userData: { isSystemObject: true }, children: [sun] };
  const sysGrid = { name: 'GridGroup', type: 'Group', isGroup: true, userData: { isSystemObject: true }, children: [helper] };
  const sceneCol = { name: 'Scene_Collection', type: 'Group', isGroup: true, userData: { isSystemObject: true }, children: [] };

  const emptyDigest = buildSceneDigest(makeScene([sysLights, sysGrid, sceneCol]));
  assert.equal(emptyDigest.isEmpty, true);
  assert.equal(emptyDigest.counts.objects, 0);

  sceneCol.children.push(makeMesh('MyCube', 24, { triangles: 12 }));
  const populated = buildSceneDigest(makeScene([sysLights, sysGrid, sceneCol]));
  assert.equal(populated.isEmpty, false);
  assert.equal(populated.counts.meshes, 1);
  assert.equal(populated.objects[0].name, 'MyCube');
});

console.log(`\nSummary: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
