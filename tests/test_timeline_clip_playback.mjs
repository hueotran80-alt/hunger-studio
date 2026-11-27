/**
 * Nút Play của timeline phải phát AnimationClip gắn trên vật thể (clip mocap
 * hoặc clip của file .glb import), tua được theo frame.
 * File: tests/test_timeline_clip_playback.mjs
 *
 * Chạy: node --import ./tests/three-resolve-hooks.mjs tests/test_timeline_clip_playback.mjs
 */
import * as THREE from 'three';
import { TimelineEngine } from '../js/animation/timeline-engine.js';

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

const FPS = 30;

/** Nhân vật 3 xương + SkinnedMesh, đủ để mixer có cái để điều khiển. */
function buildRig() {
  const scene = new THREE.Group();
  scene.name = 'Scene_Collection';

  const hips = new THREE.Bone();
  hips.name = 'Hips';
  const spine = new THREE.Bone();
  spine.name = 'Spine';
  hips.add(spine);
  const arm = new THREE.Bone();
  arm.name = 'LeftArm';
  spine.add(arm);

  const mesh = new THREE.SkinnedMesh(
    new THREE.BoxGeometry(0.4, 1.6, 0.3),
    new THREE.MeshStandardMaterial(),
  );
  mesh.name = 'Body';
  mesh.add(hips);
  mesh.bind(new THREE.Skeleton([hips, spine, arm]));

  const character = new THREE.Group();
  character.name = 'Michelle';
  character.add(mesh);
  scene.add(character);

  return { scene, character, mesh, bones: { hips, spine, arm } };
}

/** Clip kiểu MocapRetargeter tạo ra: xoay tăng dần theo thời gian. */
function buildClip({ frames = 31 } = {}) {
  const times = Array.from({ length: frames }, (_, i) => i / FPS);
  const make = (amplitude) => {
    const values = [];
    for (let i = 0; i < frames; i++) {
      const q = new THREE.Quaternion().setFromAxisAngle(
        new THREE.Vector3(1, 0, 0),
        amplitude * (i / (frames - 1)),
      );
      values.push(q.x, q.y, q.z, q.w);
    }
    return values;
  };
  const clip = new THREE.AnimationClip('Mocap_MediaPipe_Action', times[times.length - 1], [
    new THREE.QuaternionKeyframeTrack('Spine.quaternion', times, make(1.2)),
    new THREE.QuaternionKeyframeTrack('LeftArm.quaternion', times, make(2.4)),
  ]);
  return clip;
}

await test('attachClip lưu clip và nới endFrame thực sự (20 -> >=60) cho đủ thời lượng', async () => {
  const timeline = new TimelineEngine({ fps: FPS, startFrame: 0, endFrame: 20 });
  const { character } = buildRig();
  const clip = buildClip({ frames: 61 }); // 2 s = 60 frames
  const entry = timeline.attachClip(character, clip);
  assert(entry, 'attachClip trả về null');
  assert(timeline.getAttachedClip(character) === clip, 'getAttachedClip không trả clip vừa gắn');
  assert(timeline.endFrame >= 60, `endFrame không được nới từ 20 lên >=60: ${timeline.endFrame}`);
  assert(timeline.clips.size === 1, `clips có ${timeline.clips.size} entry`);
});

await test('seekToFrame đổi pose xương theo frame (tua được)', async () => {
  const timeline = new TimelineEngine({ fps: FPS, startFrame: 0, endFrame: 60 });
  const { character, bones } = buildRig();
  timeline.attachClip(character, buildClip({ frames: 61 }));

  timeline.seekToFrame(0);
  const atStart = bones.spine.quaternion.clone();
  timeline.seekToFrame(30);
  const atMid = bones.spine.quaternion.clone();

  const delta = THREE.MathUtils.radToDeg(atStart.angleTo(atMid));
  assert(delta > 5, `xương Spine chỉ xoay ${delta.toFixed(2)}° giữa frame 0 và 30`);
});

await test('play() + update() chạy hoạt cảnh theo thời gian', async () => {
  const timeline = new TimelineEngine({ fps: FPS, startFrame: 0, endFrame: 60 });
  const { character, bones } = buildRig();
  timeline.attachClip(character, buildClip({ frames: 61 }));

  timeline.seekToFrame(0);
  const initial = bones.arm.quaternion.clone();
  timeline.play();
  for (let i = 0; i < 15; i++) timeline.update(1 / FPS); // 0,5 s
  const later = bones.arm.quaternion.clone();

  assert(timeline.currentFrame > 10, `frame không tiến: ${timeline.currentFrame}`);
  assert(initial.angleTo(later) > 0.05, 'xương LeftArm không đổi khi play');
  timeline.pause();
});

await test('scrub khi đang pause vẫn giữ đúng pose (không tự chạy)', async () => {
  const timeline = new TimelineEngine({ fps: FPS, startFrame: 0, endFrame: 60 });
  const { character, bones } = buildRig();
  timeline.attachClip(character, buildClip({ frames: 61 }));

  timeline.seekToFrame(12);
  const a = bones.spine.quaternion.clone();
  timeline.update(1 / FPS); // không playing → không được tiến frame
  const b = bones.spine.quaternion.clone();
  assert(timeline.currentFrame === 12, `frame tự chạy khi pause: ${timeline.currentFrame}`);
  assert(a.angleTo(b) < 1e-6, 'pose đổi dù timeline đang pause');
});

await test('detachClip gỡ clip và trả nhân vật về bind pose', async () => {
  const timeline = new TimelineEngine({ fps: FPS, startFrame: 0, endFrame: 60 });
  const { character, bones } = buildRig();
  timeline.attachClip(character, buildClip({ frames: 61 }));
  timeline.seekToFrame(20);
  const posed = bones.spine.quaternion.clone();
  assert(posed.angleTo(new THREE.Quaternion()) > 0.01, 'clip không tạo pose trước khi gỡ');

  assert(timeline.detachClip(character) === true, 'detachClip không trả true');
  assert(timeline.clips.size === 0, 'clips còn entry sau khi gỡ');

  const freed = bones.spine.quaternion.clone();
  timeline.seekToFrame(5);
  const afterSeek = bones.spine.quaternion.clone();
  assert(freed.angleTo(afterSeek) < 1e-6, 'mixer vẫn ghi pose sau khi gỡ clip');
  assert(freed.angleTo(new THREE.Quaternion()) < 0.01, 'không trả về bind pose sau khi gỡ clip');
});

await test('clip có track trỏ tới node không tồn tại bị từ chối', async () => {
  const timeline = new TimelineEngine({ fps: FPS, startFrame: 0, endFrame: 60 });
  const { character } = buildRig();
  const orphan = new THREE.AnimationClip('Orphan', 1, [
    new THREE.QuaternionKeyframeTrack('NoSuchBone.quaternion', [0, 1], [0, 0, 0, 1, 0, 0, 0, 1]),
  ]);
  assert(timeline.attachClip(character, orphan) === null, 'clip mồ côi vẫn được gắn');
  assert(timeline.clips.size === 0, 'clip mồ côi vẫn tạo entry');
});

await test('clip lẫn track mồ côi thì chỉ giữ track bind được', async () => {
  const timeline = new TimelineEngine({ fps: FPS, startFrame: 0, endFrame: 60 });
  const { character, bones } = buildRig();
  const mixed = new THREE.AnimationClip('Mixed', 1, [
    new THREE.QuaternionKeyframeTrack('Spine.quaternion', [0, 1], [0, 0, 0, 1, 0.3, 0, 0, 0.95]),
    new THREE.QuaternionKeyframeTrack('NoSuchBone.quaternion', [0, 1], [0, 0, 0, 1, 0.3, 0, 0, 0.95]),
  ]);
  const entry = timeline.attachClip(character, mixed);
  assert(entry, 'attachClip từ chối nhầm clip còn track dùng được');
  assert(entry.clip.tracks.length === 1, `giữ ${entry.clip.tracks.length} track thay vì 1`);
  timeline.seekToFrame(15); // 0,5 s — giữa clip (đúng biên cuối sẽ loop về đầu)
  assert(bones.spine.quaternion.angleTo(new THREE.Quaternion()) > 0.01, 'xương Spine không được điều khiển');
});

await test('clip rỗng bị từ chối, không tạo mixer', async () => {
  const timeline = new TimelineEngine({ fps: FPS, startFrame: 0, endFrame: 60 });
  const { character } = buildRig();
  const empty = new THREE.AnimationClip('Empty', 0, []);
  assert(timeline.attachClip(character, empty) === null, 'clip rỗng vẫn được gắn');
  assert(timeline.clips.size === 0, 'clip rỗng vẫn tạo entry');
});

await test('xoá vật thể thì clip cũng bị gỡ (bindEngine)', async () => {
  const timeline = new TimelineEngine({ fps: FPS, startFrame: 0, endFrame: 60 });
  const { scene, character } = buildRig();

  // SceneManager tối thiểu: chỉ cần emit objectRemoved như bản thật.
  const listeners = new Map();
  const fakeSceneManager = {
    on(evt, cb) { listeners.set(evt, cb); },
    emit(evt, payload) { listeners.get(evt)?.(payload); },
  };
  const fakeEngine = { addRenderCallback: () => () => {} };
  timeline.bindEngine(fakeEngine, fakeSceneManager);

  timeline.attachClip(character, buildClip({ frames: 61 }));
  fakeSceneManager.emit('objectRemoved', { object: character });
  assert(timeline.clips.size === 0, 'clip còn lại sau khi xoá vật thể');
});

await test('gắn clip mới đè lên nhân vật cũ thay thế sạch mixer (không chồng trộn pose cũ)', async () => {
  const timeline = new TimelineEngine({ fps: FPS, startFrame: 0, endFrame: 60 });
  const { character, bones } = buildRig();
  const makeDirClip = (name, angle) => {
    const times = [0, 2];
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), angle);
    return new THREE.AnimationClip(name, 2, [
      new THREE.QuaternionKeyframeTrack('Spine.quaternion', times, [0, 0, 0, 1, q.x, q.y, q.z, q.w]),
    ]);
  };
  timeline.attachClip(character, makeDirClip('Pos', 1.5));
  const negClip = makeDirClip('Neg', -1.5);
  timeline.attachClip(character, negClip);
  assert(timeline.clips.size === 1, `có ${timeline.clips.size} entry thay vì 1`);
  assert(timeline.getAttachedClip(character) === negClip, 'không cập nhật clip mới');
  timeline.seekToFrame(30);
  assert(bones.spine.quaternion.x < -0.3, `pose clip cũ bị rò sang clip mới: q.x=${bones.spine.quaternion.x}`);
});

await test('seekToFrame & update() an toàn với NaN, Infinity, delta âm và startFrame === endFrame', async () => {
  const timeline = new TimelineEngine({ fps: FPS, startFrame: 0, endFrame: 60 });
  const { character, bones } = buildRig();
  timeline.attachClip(character, buildClip({ frames: 61 }));
  timeline.seekToFrame(15);

  for (const bad of [-10, NaN, Infinity, -Infinity]) {
    timeline.seekToFrame(bad);
    assert(Number.isFinite(timeline.currentFrame), `currentFrame thành ${timeline.currentFrame} khi seek(${bad})`);
    assert(Number.isFinite(bones.spine.quaternion.w), `quaternion NaN khi seek(${bad})`);
  }

  timeline.play();
  for (const dt of [0, -0.5, NaN, Infinity, 50]) {
    timeline.update(dt);
    assert(
      Number.isFinite(timeline.currentFrame) && timeline.currentFrame >= timeline.startFrame && timeline.currentFrame <= timeline.endFrame,
      `update(${dt}) phá currentFrame=${timeline.currentFrame}`,
    );
  }
  timeline.pause();

  // startFrame === endFrame must not divide by zero (overflow % 0 -> NaN)
  const single = new TimelineEngine({ fps: FPS, startFrame: 10, endFrame: 10 });
  single.play();
  single.update(0.1);
  assert(single.currentFrame === 10, `startFrame==endFrame cho currentFrame=${single.currentFrame}`);
  single.pause();
});

console.log('');
if (failures.length === 0) {
  console.log(`ALL ${passed} TIMELINE CLIP PLAYBACK TESTS PASSED`);
  process.exit(0);
}
console.log(`${passed} passed, ${failures.length} failed`);
process.exit(1);
