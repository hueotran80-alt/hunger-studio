/**
 * Giai đoạn 1.3 — xuất .glb KÈM AnimationClip, kiểm chứng bằng cách đọc lại file.
 * File: tests/test_glb_animation.mjs
 *
 * Chạy: node --import ./tests/three-resolve-hooks.mjs tests/test_glb_animation.mjs
 *
 * Test dùng đúng hàm production `StudioExporter.exportGLTF()` (cùng option với
 * nút xuất trong app), rồi:
 *   1. Bóc hộp GLB (header + JSON chunk + BIN chunk) và giải mã accessor của
 *      animation sampler → so sánh keyframe với clip gốc.
 *   2. Import lại bằng GLTFLoader để chắc chắn file mở được ở nơi khác
 *      (Blender/Unity/Godot cũng đọc đúng cấu trúc này).
 *   3. Đối chứng âm: xuất không kèm animation thì bộ kiểm tra PHẢI báo lỗi.
 */
import * as THREE from 'three';
import { StudioExporter } from '../js/exporters/export-import.js';
import { verifyAnimatedGLB, parseGLB, inspectAnimations, describeReport } from './glb-inspect.mjs';

// ---------------------------------------------------------------------------
// Node không có FileReader: GLTFExporter dùng nó cho đường binary. Shim tối
// thiểu, chỉ trong test — trình duyệt đã có sẵn.
// ---------------------------------------------------------------------------
if (typeof globalThis.FileReader === 'undefined') {
  globalThis.FileReader = class FileReaderShim {
    constructor() {
      this.result = null;
      this.onloadend = null;
      this.onerror = null;
    }
    readAsArrayBuffer(blob) {
      blob.arrayBuffer().then(
        (buffer) => { this.result = buffer; this.onloadend?.(); },
        (err) => { this.onerror?.(err); },
      );
    }
    readAsDataURL(blob) {
      blob.arrayBuffer().then((buffer) => {
        const base64 = Buffer.from(new Uint8Array(buffer)).toString('base64');
        this.result = `data:${blob.type || 'application/octet-stream'};base64,${base64}`;
        this.onloadend?.();
      });
    }
  };
}

let passed = 0;
const failures = [];
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`ok   ${name}`);
  } catch (err) {
    failures.push({ name, err });
    console.log(`FAIL ${name}\n     ${err.stack || err.message}`);
  }
}

function assert(cond, message) {
  if (!cond) throw new Error(message);
}
function assertClose(actual, expected, tol, message) {
  assert(Math.abs(actual - expected) <= tol, `${message}: ${actual} vs ${expected} (dung sai ${tol})`);
}

// ---------------------------------------------------------------------------
// Nhân vật 20 xương kiểu Mixamo + SkinnedMesh thật
// ---------------------------------------------------------------------------
const BONE_TREE = [
  ['Hips', null],
  ['Spine', 'Hips'],
  ['Spine1', 'Spine'],
  ['Spine2', 'Spine1'],
  ['Neck', 'Spine2'],
  ['Head', 'Neck'],
  ['LeftShoulder', 'Spine2'],
  ['LeftArm', 'LeftShoulder'],
  ['LeftForearm', 'LeftArm'],
  ['LeftHand', 'LeftForearm'],
  ['RightShoulder', 'Spine2'],
  ['RightArm', 'RightShoulder'],
  ['RightForearm', 'RightArm'],
  ['RightHand', 'RightForearm'],
  ['LeftUpLeg', 'Hips'],
  ['LeftLeg', 'LeftUpLeg'],
  ['LeftFoot', 'LeftLeg'],
  ['RightUpLeg', 'Hips'],
  ['RightLeg', 'RightUpLeg'],
  ['RightFoot', 'RightLeg'],
];

function buildCharacter() {
  const root = new THREE.Group();
  root.name = 'Character';

  const bones = new Map();
  for (const [name, parent] of BONE_TREE) {
    const bone = new THREE.Bone();
    bone.name = name;
    const p = parent ? bones.get(parent) : null;
    if (p) p.add(bone);
    else root.add(bone);
    // Rest pose: đặt xương theo trục Y để skeleton có độ dài thật.
    bone.position.set(0, name === 'Hips' ? 0.95 : 0.14, 0);
    bones.set(name, bone);
  }

  const orderedBones = [...bones.values()];
  const skeleton = new THREE.Skeleton(orderedBones);

  const geometry = new THREE.BoxGeometry(0.55, 1.8, 0.28, 1, 6, 1);
  const position = geometry.attributes.position;
  const skinIndices = [];
  const skinWeights = [];
  for (let i = 0; i < position.count; i++) {
    const y = position.getY(i);
    const t = THREE.MathUtils.clamp((y + 0.9) / 1.8, 0, 1);
    const index = Math.min(orderedBones.length - 1, Math.floor(t * (orderedBones.length - 1)));
    skinIndices.push(index, 0, 0, 0);
    skinWeights.push(1, 0, 0, 0);
  }
  geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(skinIndices, 4));
  geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(skinWeights, 4));

  const mesh = new THREE.SkinnedMesh(geometry, new THREE.MeshStandardMaterial({ color: 0x8899aa }));
  mesh.name = 'Body';
  mesh.add(orderedBones[0]);
  mesh.bind(skeleton);
  root.add(mesh);

  return { root, bones, skeleton, mesh };
}

/** Clip đúng định dạng MocapRetargeter tạo ra: `<TênXương>.quaternion` + `Hips.position`. */
function buildClip(bones, { fps = 30, frames = 31 } = {}) {
  const times = Array.from({ length: frames }, (_, i) => i / fps);
  const duration = times[times.length - 1];
  const tracks = [];

  const sources = new Map();
  for (const [name, bone] of bones) {
    if (name === 'Hips') continue;
    const values = [];
    for (let i = 0; i < frames; i++) {
      const q = new THREE.Quaternion().setFromAxisAngle(
        new THREE.Vector3(1, 0, 0),
        Math.sin((i / (frames - 1)) * Math.PI * 2) * 0.25,
      );
      values.push(q.x, q.y, q.z, q.w);
    }
    sources.set(`${name}.quaternion`, values);
    tracks.push(new THREE.QuaternionKeyframeTrack(`${name}.quaternion`, times, values));
  }

  const hipValues = [];
  for (let i = 0; i < frames; i++) hipValues.push(0.4 * (i / (frames - 1)), 0.95, 0);
  sources.set('Hips.position', hipValues);
  tracks.push(new THREE.VectorKeyframeTrack('Hips.position', times, hipValues));

  const clip = new THREE.AnimationClip('Mocap_MediaPipe_Action', duration, tracks);
  return { clip, sources, times, duration };
}

async function exportGLB(target, clip) {
  const exporter = new StudioExporter();
  exporter.showToast = () => {};
  exporter.triggerDownload = () => { throw new Error('test không được tải file'); };
  const options = {
    binary: true,
    download: false,
    embedImages: true,
    onlyVisible: true,
  };
  if (clip) options.animations = [clip];
  return exporter.exportGLTF(target, options);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
const { root, bones, skeleton } = buildCharacter();
const { clip, sources, times, duration } = buildClip(bones);

let exported = null;
await test('StudioExporter.exportGLTF xuất .glb nhị phân có header hợp lệ', async () => {
  exported = await exportGLB(root, clip);
  assert(exported && exported.buffer, 'không trả ArrayBuffer');
  assert(exported.filename.endsWith('.glb'), `tên file lạ: ${exported.filename}`);
  assert(exported.blob.size > 1000, `blob quá nhỏ: ${exported.blob.size}`);
  const parsed = parseGLB(exported.buffer);
  assert(parsed.chunks.length === 2, `số chunk = ${parsed.chunks.length}, mong đợi 2`);
  assert(parsed.json.meshes?.length === 1, `meshes = ${parsed.json.meshes?.length}`);
  assert(parsed.json.skins?.[0]?.joints?.length === BONE_TREE.length,
    `skin joints = ${parsed.json.skins?.[0]?.joints?.length}, mong đợi ${BONE_TREE.length}`);
});

await test('GLB chứa AnimationClip thật: đúng tên, đủ channel, đúng thời lượng', async () => {
  const report = verifyAnimatedGLB(exported.buffer, {
    clipName: 'Mocap_MediaPipe_Action',
    duration,
    minChannels: clip.tracks.length,
    bones: ['Hips', 'Head', 'LeftFoot', 'RightHand'],
  });
  assert(report.ok, `\n  - ${report.problems.join('\n  - ')}`);
  assert(report.summary.channels === clip.tracks.length,
    `${report.summary.channels} channel vs ${clip.tracks.length} track`);
  assert(report.summary.keys === times.length * clip.tracks.length,
    `tổng keyframe ${report.summary.keys}, mong đợi ${times.length * clip.tracks.length}`);
  console.log(`     ${describeReport(report)}`);
});

await test('Dữ liệu keyframe trong BIN khớp clip gốc (không phải metadata rỗng)', async () => {
  const parsed = parseGLB(exported.buffer);
  const [animation] = inspectAnimations(parsed.json, parsed.bin);
  // glTF dùng path "rotation"/"translation" (Three.js gọi là quaternion/position).
  const channel = animation.channels.find((c) => c.nodeName === 'Spine1' && c.path === 'rotation');
  assert(channel, `không có track Spine1.rotation (đang có: ${[...new Set(animation.channels.map((c) => c.nodeName))].join(', ')})`);
  const source = sources.get('Spine1.quaternion');
  for (const i of [0, 1, Math.floor(times.length / 2), times.length - 1]) {
    for (let c = 0; c < 4; c++) {
      assertClose(channel.values[i][c], source[i * 4 + c], 1e-5, `Spine1 key ${i} thành phần ${c}`);
    }
    assertClose(channel.times[i], times[i], 1e-5, `thời gian key ${i}`);
  }

  const hips = animation.channels.find((c) => c.nodeName === 'Hips' && c.path === 'translation');

  assert(hips, 'không có track Hips.translation');
  const lastX = hips.values[hips.values.length - 1][0];
  assertClose(lastX, 0.4, 1e-4, 'Hips.translation X ở keyframe cuối');
});

await test('Import lại bằng GLTFLoader: animation + xương + clip dùng được', async () => {
  const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
  const gltf = await new Promise((resolve, reject) => {
    new GLTFLoader().parse(
      exported.buffer.slice(0),
      '',
      resolve,
      (err) => reject(err instanceof Error ? err : new Error(String(err))),
    );
  });
  assert(gltf.animations.length === 1, `import lại thấy ${gltf.animations.length} animation`);
  const loadedClip = gltf.animations[0];
  assert(loadedClip.name === 'Mocap_MediaPipe_Action', `tên clip bị đổi: ${loadedClip.name}`);
  assertClose(loadedClip.duration, duration, 1e-4, 'độ dài clip sau khi import');
  assert(loadedClip.tracks.length === clip.tracks.length,
    `${loadedClip.tracks.length} track vs ${clip.tracks.length}`);

  let skinned = null;
  const names = new Set();
  gltf.scene.traverse((o) => {
    if (o.isBone) names.add(o.name);
    if (o.isSkinnedMesh) skinned = o;
  });
  assert(skinned, 'không tìm thấy SkinnedMesh sau khi import');
  for (const required of ['Hips', 'Head', 'LeftFoot', 'RightHand']) {
    assert(names.has(required), `thiếu xương ${required} sau khi import (có: ${[...names].slice(0, 8).join(', ')})`);
  }

  // Ba.js phải tìm được node đích cho mọi track thì Blender/Unity mới nhận.
  const unresolved = loadedClip.tracks.filter((t) => {
    const { nodeName } = THREE.PropertyBinding.parseTrackName(t.name);
    return !THREE.PropertyBinding.findNode(gltf.scene, nodeName);
  });
  assert(unresolved.length === 0, `track không tìm được node: ${unresolved.map((t) => t.name).join(', ')}`);

  // Phát thử clip 1 giây để chắc chắn mixer thật sự chạy được.
  const mixer = new THREE.AnimationMixer(gltf.scene);
  const action = mixer.clipAction(loadedClip).play();
  mixer.update(duration / 2);
  assert(action.isRunning(), 'action không chạy sau khi import');
  assert(skeleton.bones.length === BONE_TREE.length, 'skeleton gốc bị thay đổi trong lúc test');
});

await test('Đối chứng âm: xuất không kèm animation thì bộ kiểm tra phải báo lỗi', async () => {
  const plain = await exportGLB(root, null);
  const parsed = parseGLB(plain.buffer);
  assert(!parsed.json.animations || parsed.json.animations.length === 0,
    'file không animation lại có animations[]');
  const report = verifyAnimatedGLB(plain.buffer, { clipName: 'Mocap_MediaPipe_Action' });
  assert(!report.ok, 'bộ kiểm tra đã bỏ sót file thiếu animation');
  const failedChecks = report.checks.filter((c) => !c.ok).map((c) => c.name);
  assert(failedChecks.some((n) => n.includes('animation')), `checks lỗi: ${failedChecks.join(', ')}`);
});

await test('Clip rỗng (0 track) không tạo ra animation giả trong file', async () => {
  const empty = new THREE.AnimationClip('Empty', 0, []);
  const res = await exportGLB(root, empty);
  const parsed = parseGLB(res.buffer);
  const count = parsed.json.animations?.length || 0;
  assert(count === 0, `GLB có ${count} animation từ clip rỗng`);
});

// Hồi quy: nút "Export GLB" xuất CẢ CẢNH và không truyền clip nào. Clip mocap
// được gắn lên chính nhân vật, nên exporter phải tự gom animation từ node con —
// trước đây file xuất ra chỉ có dáng, không có action nào.
await test('Xuất cả cảnh tự gom clip gắn trên vật thể con (nút Export GLB)', async () => {
  const attached = new THREE.AnimationClip('Attached_Take', 1, [
    new THREE.QuaternionKeyframeTrack('Spine.quaternion', [0, 1], [0, 0, 0, 1, 0.2, 0, 0, 0.98]),
  ]);
  const body = root.getObjectByName('Body');
  body.animations = [attached];
  try {
    const res = await exportGLB(root, null);
    const parsed = parseGLB(res.buffer);
    const names = (parsed.json.animations || []).map((a) => a.name);
    assert(names.includes('Attached_Take'), `thiếu clip gắn trên vật thể con (có: ${names.join(', ') || 'không có'})`);
    const anim = inspectAnimations(parsed.json, parsed.bin).find((a) => a.name === 'Attached_Take');
    assert(anim && anim.channels.length === 1, 'clip gắn trên vật thể con bị rỗng khi xuất');
  } finally {
    body.animations = [];
  }
});

// GLTFLoader thêm hậu tố khi tên node trùng (import lần 2) → tên track trong clip
// không còn khớp, mixer im lặng không chạy. Exporter phải ánh xạ lại.
await test('Đổi tên track khi node bị trùng tên (_001) sau khi import', async () => {
  const exporter = new StudioExporter();
  const sceneRoot = new THREE.Group();
  const mesh = new THREE.SkinnedMesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial());
  const bone = new THREE.Bone();
  bone.name = 'Spine_001';
  mesh.add(bone);
  mesh.bind(new THREE.Skeleton([bone]));
  sceneRoot.add(mesh);

  const clip = new THREE.AnimationClip('Take', 1, [
    new THREE.QuaternionKeyframeTrack('Spine.quaternion', [0, 1], [0, 0, 0, 1, 0.2, 0, 0, 0.98]),
  ]);
  const remapped = exporter._remapClipTrackNames(sceneRoot, clip);
  assert(remapped !== clip, 'không trả clip mới dù tên track đã lệch');
  assert(remapped.tracks[0].name === 'Spine_001.quaternion', `tên track: ${remapped.tracks[0].name}`);

  // Không mơ hồ (không có node trùng) thì giữ nguyên clip gốc.
  const clean = new THREE.Group();
  const lone = new THREE.Bone();
  lone.name = 'Hips';
  clean.add(lone);
  assert(exporter._remapClipTrackNames(clean, clip) === clip, 'clip bị đổi dù không cần');
});

await test('Xuất GLB khôi phục vật liệu PBR gốc sau MatCap và trả lại MatCap cho viewport', async () => {
  const { root: matRoot, mesh: matMesh, bones: matBones } = buildCharacter();
  const pbr = new THREE.MeshStandardMaterial({ color: 0xcc3322, roughness: 0.3, metalness: 0.8 });
  const matcap = new THREE.MeshMatcapMaterial();
  matMesh.material = matcap;
  matMesh.userData.__originalMaterial = pbr;
  const { clip: matClip } = buildClip(matBones, { frames: 11 });
  const res = await exportGLB(matRoot, matClip);
  const parsed = parseGLB(res.buffer);
  const mat = parsed.json.materials?.[0];
  assert(mat?.pbrMetallicRoughness, 'GLB thiếu pbrMetallicRoughness');
  assertClose(mat.pbrMetallicRoughness.metallicFactor ?? 0, 0.8, 1e-3, 'GLB không xuất PBR metallic gốc');
  assertClose(mat.pbrMetallicRoughness.roughnessFactor ?? 0, 0.3, 1e-3, 'GLB không xuất PBR roughness gốc');
  assert(matMesh.material === matcap, 'không khôi phục MatCap cho viewport sau khi xuất');
});

await test('Xuất GLB lọc track 0-keyframe và giữ nguyên nhiều AnimationClip cùng lúc', async () => {
  const { root: r2, bones: b2 } = buildCharacter();
  const { clip: c1 } = buildClip(b2, { frames: 11 });
  c1.name = 'Walk';
  const { clip: c2 } = buildClip(b2, { frames: 11 });
  c2.name = 'Jump';
  const bad = buildClip(b2, { frames: 5 }).clip;
  bad.name = 'EmptyTracks';
  bad.tracks.forEach((t) => { t.times = new Float32Array(0); t.values = new Float32Array(0); });

  const exporter = new StudioExporter();
  exporter.showToast = () => {};
  const res = await exporter.exportGLTF(r2, { binary: true, download: false, animations: [c1, c2, bad] });
  const parsed = parseGLB(res.buffer);
  const anims = inspectAnimations(parsed.json, parsed.bin);
  assert(anims.length === 2, `kỳ vọng 2 animation hợp lệ (loại bad), nhận ${anims.length}`);
  assert(anims.map((a) => a.name).sort().join(',') === 'Jump,Walk', `tên clip: ${anims.map((a) => a.name)}`);
});

console.log('');
if (failures.length === 0) {
  console.log(`ALL ${passed} GLB ANIMATION TESTS PASSED`);
  process.exit(0);
}
console.log(`${passed} passed, ${failures.length} failed`);
process.exit(1);
