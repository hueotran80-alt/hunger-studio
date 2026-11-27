/**
 * Node regression tests for the client-side mocap pipeline (Giai đoạn 1).
 *
 *   node tests/test_mocap_filters.mjs
 *
 * Covers: 1-Euro filter, gap fill, bone-length enforcement, metric root
 * trajectory, foot-lock IK, frame schema, and the browser engine loop
 * (with an injected sampler so no MediaPipe model is downloaded).
 */
import assert from 'node:assert/strict';
import {
  SKELETON_JOINTS,
  OneEuroFilter,
  gapFillSeries,
  filterJointSeries,
  enforceBoneLengths,
  computeRootTrajectory,
  buildMocapFrames,
  detectFootContacts,
  applyFootLock,
  processJointSeries,
} from '../js/animation/mocap-filters.js';
import { BrowserMocapEngine, POSE_LANDMARK_INDEX } from '../js/animation/browser-mocap.js';

let passed = 0;
const failures = [];
function test(name, fn) {
  try {
    const ret = fn();
    if (ret && typeof ret.then === 'function') {
      throw new Error('Async function passed to sync test(); use await testAsync()');
    }
    passed += 1;
    console.log(`ok   ${name}`);
  } catch (err) {
    failures.push({ name, err });
    console.log(`FAIL ${name}\n     ${err.message}`);
  }
}
async function testAsync(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`ok   ${name}`);
  } catch (err) {
    failures.push({ name, err });
    console.log(`FAIL ${name}\n     ${err.message}`);
  }
}

const JOINT_KEYS = [
  'time', 'midHip', 'spine', 'neck', 'nose',
  'leftShoulder', 'leftElbow', 'leftWrist', 'leftHandIndex',
  'rightShoulder', 'rightElbow', 'rightWrist', 'rightHandIndex',
  'leftHip', 'leftKnee', 'leftAnkle', 'leftFoot',
  'rightHip', 'rightKnee', 'rightAnkle', 'rightFoot',
].sort();

const std = (arr) => {
  const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
  return Math.sqrt(arr.reduce((a, b) => a + (b - mean) ** 2, 0) / arr.length);
};

function seededRand(seed = 1337) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** MediaPipe-style body: +Y down, hip at origin, ankles 0.8 m below. */
function body({ hipX = 0, leftAnkleX = 0, leftAnkleY = 0.8, rightAnkleX = 0, rightAnkleY = 0.45, jitter = 0, rng = seededRand(42) } = {}) {
  const j = (x, y, z = 0) => [x + jitter * (rng() - 0.5), y, z];
  return {
    nose: j(hipX, -0.55),
    leftShoulder: j(hipX - 0.18, -0.45),
    rightShoulder: j(hipX + 0.18, -0.45),
    leftElbow: j(hipX - 0.3, -0.2),
    rightElbow: j(hipX + 0.3, -0.2),
    leftWrist: j(hipX - 0.35, 0.02),
    rightWrist: j(hipX + 0.35, 0.02),
    leftHandIndex: j(hipX - 0.37, 0.08),
    rightHandIndex: j(hipX + 0.37, 0.08),
    leftHip: j(hipX - 0.1, 0),
    rightHip: j(hipX + 0.1, 0),
    leftKnee: j(hipX - 0.1, 0.4),
    rightKnee: j(hipX + 0.1, 0.4),
    leftAnkle: j(leftAnkleX, leftAnkleY),
    rightAnkle: j(rightAnkleX, rightAnkleY),
    leftFoot: j(leftAnkleX + 0.12, leftAnkleY + 0.05),
    rightFoot: j(rightAnkleX + 0.12, rightAnkleY + 0.05),
  };
}

// ---------------------------------------------------------------------------
// 1-Euro filter
// ---------------------------------------------------------------------------
test('OneEuro: mẫu đầu tiên được trả nguyên vẹn', () => {
  const f = new OneEuroFilter({ freq: 30 });
  assert.deepEqual(f.filter([1, 2, 3]), [1, 2, 3]);
});

test('OneEuro: tín hiệu hằng số không bị trôi', () => {
  const f = new OneEuroFilter({ freq: 30 });
  let out = null;
  for (let i = 0; i < 50; i++) out = f.filter([0.25, -1.5, 2]);
  out.forEach((v, i) => assert.ok(Math.abs(v - [0.25, -1.5, 2][i]) < 1e-9, `axis ${i} trôi: ${v}`));
});

test('OneEuro: giảm rung > 40% trên chuỗi nhiễu (seeded tất định)', () => {
  const rng = seededRand(2026);
  const raw = [];
  for (let i = 0; i < 90; i++) raw.push(0.5 + (rng() - 0.5) * 0.1);
  const f = new OneEuroFilter({ freq: 30, minCutoff: 1.2, beta: 0.05 });
  const out = raw.map((v) => f.filter([v])[0]);
  assert.ok(std(out.slice(5)) < std(raw.slice(5)) * 0.6, `std ${std(raw)} → ${std(out)}`);
});

test('OneEuro: bám chuyển động nhanh (không trễ quá 25% biên độ)', () => {
  const f = new OneEuroFilter({ freq: 30, minCutoff: 2.0, beta: 0.2 });
  let out = 0;
  // Ramp up to 1 m over 15 frames then hold: filter must reach >= 75%.
  for (let i = 0; i < 15; i++) out = f.filter([i / 14])[0];
  for (let i = 0; i < 25; i++) out = f.filter([1])[0];
  assert.ok(out > 0.75, `giá trị sau ramp chỉ ${out.toFixed(3)}`);
});

test('OneEuro: bỏ qua giá trị NaN/không phải số', () => {
  const f = new OneEuroFilter({ freq: 30 });
  f.filter([1, 1, 1]);
  const out = f.filter(['x', null, undefined]);
  out.forEach((v) => assert.ok(Number.isFinite(v), `NaN lọt ra: ${v}`));
});

// ---------------------------------------------------------------------------
// Gap fill / bone lengths
// ---------------------------------------------------------------------------
test('gapFill: nội suy frame thiếu ở giữa và giữ 2 đầu', () => {
  const series = [body(), null, body({ leftAnkleX: 0.4 })];
  const filled = gapFillSeries(series);
  assert.equal(filled.length, 3);
  assert.ok(Math.abs(filled[1].leftAnkle[0] - 0.2) < 1e-9, `nội suy sai: ${filled[1].leftAnkle[0]}`);
  assert.equal(filled[0].leftAnkle[0], 0);
  assert.equal(filled[2].leftAnkle[0], 0.4);
});

test('gapFill: điền gap đầu/cuối, giữ nguyên frame hợp lệ và xử lý chuỗi rỗng', () => {
  assert.deepEqual(gapFillSeries([]), []);
  const lead = gapFillSeries([null, null, body({ leftAnkleX: 0.35 })]);
  assert.ok(Math.abs(lead[0].leftAnkle[0] - 0.35) < 1e-9 && Math.abs(lead[1].leftAnkle[0] - 0.35) < 1e-9);
  const trail = gapFillSeries([body({ leftAnkleX: 0.25 }), null, null]);
  assert.ok(Math.abs(trail[2].leftAnkle[0] - 0.25) < 1e-9);

  const valid = [body({ leftAnkleX: 0.1, rightAnkleX: -0.2 }), body({ leftAnkleX: 0.4, rightAnkleX: 0.3 })];
  const filled = gapFillSeries(valid);
  assert.deepEqual(filled[0].leftAnkle, valid[0].leftAnkle);
  assert.deepEqual(filled[1].rightAnkle, valid[1].rightAnkle);

  // Frame bị hỏng một phần (chỉ 1 khớp mang NaN) phải được nội suy từ 2 frame kề!
  const partialBad = body({ leftAnkleX: 0.2 });
  partialBad.leftAnkle = [NaN, NaN, NaN];
  const repaired = gapFillSeries([body({ leftAnkleX: 0.0 }), partialBad, body({ leftAnkleX: 0.4 })]);
  assert.ok(Math.abs(repaired[1].leftAnkle[0] - 0.2) < 1e-9, `khớp NaN không được nội suy: ${repaired[1].leftAnkle}`);
});

test('enforceBoneLengths: mọi segment giữ đúng độ dài trung vị (seeded tất định)', () => {
  const rng = seededRand(9001);
  const series = [];
  for (let i = 0; i < 20; i++) {
    const b = body();
    b.leftKnee = [b.leftHip[0], 0.4 * (0.8 + rng() * 0.4), 0];
    b.leftAnkle = [0, 0.8 * (0.8 + rng() * 0.4), 0];
    series.push(b);
  }
  const fixed = enforceBoneLengths(series);
  const lengths = fixed.map((f) => {
    const d = [f.leftAnkle[0] - f.leftKnee[0], f.leftAnkle[1] - f.leftKnee[1], f.leftAnkle[2] - f.leftKnee[2]];
    return Math.hypot(...d);
  });
  lengths.forEach((l) => assert.ok(Math.abs(l - lengths[0]) < 1e-6, `độ dài lệch: ${l} vs ${lengths[0]}`));
});

// ---------------------------------------------------------------------------
// Frames / root trajectory
// ---------------------------------------------------------------------------
test('buildMocapFrames: schema khớp server (21 khoá) + time = i/fps', () => {
  const series = [body(), body(), body()];
  const frames = buildMocapFrames(series, { fps: 30 });
  assert.deepEqual(Object.keys(frames[0]).sort(), JOINT_KEYS);
  assert.equal(frames[0].time, 0);
  assert.equal(frames[2].time, Number((2 / 30).toFixed(5)));
});

test('buildMocapFrames: spine = hip + 0.65*(neck-hip)', () => {
  const frames = buildMocapFrames([body()], { fps: 30 });
  const f = frames[0];
  for (let i = 0; i < 3; i++) {
    const expected = f.midHip[i] + (f.neck[i] - f.midHip[i]) * 0.65;
    assert.ok(Math.abs(f.spine[i] - expected) < 1e-4, `spine[${i}] ${f.spine[i]} vs ${expected}`);
  }
});

test('buildMocapFrames: root offset được cộng vào mọi khớp', () => {
  const frames = buildMocapFrames([body()], { fps: 30, rootOffsets: [[1.5, 0.2, 0]] });
  assert.ok(Math.abs(frames[0].leftAnkle[0] - 1.5) < 1e-6);
  assert.ok(Math.abs(frames[0].nose[0] - 1.5) < 1e-6);
});

test('computeRootTrajectory: trả 0 khi không có hip 2D hợp lệ', () => {
  const offsets = computeRootTrajectory([body(), body()], [[500, 500, 0, 0], null], 30);
  assert.equal(offsets.length, 2);
  offsets.forEach((o) => assert.deepEqual(o, [0, 0, 0]));
});

test('computeRootTrajectory: dịch hông 2D sinh root motion và bị clamp ±2.5m', () => {
  // Camera pan far beyond the stage: raw offset is ~12m, clamp/filter must cap it.
  const series = [];
  const hip2d = [];
  for (let i = 0; i < 40; i++) {
    series.push(body());
    hip2d.push([i < 10 ? 500 : 6000, 500, 200, 0.9]);
  }
  const offsets = computeRootTrajectory(series, hip2d, 30);
  assert.ok(offsets[0][0] < -1.0, `không có root motion: ${offsets[0][0]}`);
  offsets.forEach((o) => assert.ok(
    Math.abs(o[0]) <= 2.5 + 1e-6 && Math.abs(o[1]) <= 0.8 + 1e-6,
    `vượt clamp: ${o[0]},${o[1]}`,
  ));
});

// ---------------------------------------------------------------------------
// Foot-Lock IK
// ---------------------------------------------------------------------------
function walkFrames({ frames = 60, slide = 0.25, sign = 1 } = {}) {
  const out = [];
  for (let i = 0; i < frames; i++) {
    const t = i / (frames - 1);
    const f = body({
      leftAnkleX: slide * t,          // planted foot slides on the floor
      leftAnkleY: 0.8,
      rightAnkleX: 0.1 * t,
      rightAnkleY: 0.45 + 0.1 * Math.sin(t * Math.PI), // lifted foot
    });
    for (const key of Object.keys(f)) f[key] = [f[key][0], f[key][1] * sign, f[key][2]];
    out.push(f);
  }
  return buildMocapFrames(out, { fps: 30 });
}

test('detectFootContacts: nhận bàn chân trụ, bỏ qua bàn chân nhấc', () => {
  const frames = walkFrames();
  const contacts = detectFootContacts(frames, { fps: 30 });
  assert.ok(contacts.left.filter(Boolean).length > 50, `trụ chỉ ${contacts.left.filter(Boolean).length} frames`);
  assert.equal(contacts.right.filter(Boolean).length, 0, 'chân nhấc bị nhận nhầm là chạm sàn');
});

test('detectFootContacts: độc lập với quy ước trục Y (MediaPipe y-down / Three y-up)', () => {
  const down = detectFootContacts(walkFrames({ sign: 1 }), { fps: 30 });
  const up = detectFootContacts(walkFrames({ sign: -1 }), { fps: 30 });
  assert.deepEqual(down.left, up.left);
  assert.deepEqual(down.right, up.right);
});

test('applyFootLock: chân trụ đứng yên (<2cm) thay vì trượt 25cm', () => {
  const frames = walkFrames();
  const before = frames.map((f) => f.leftAnkle[0]);
  const { frames: locked, locked: counts } = applyFootLock(frames, { fps: 30 });
  const after = locked.map((f) => f.leftAnkle[0]);
  const driftBefore = Math.max(...before) - Math.min(...before);
  const driftAfter = Math.max(...after) - Math.min(...after);
  assert.ok(driftBefore > 0.2, `dữ liệu test chưa trượt: ${driftBefore}`);
  assert.ok(driftAfter < 0.02, `Foot-Lock chưa khoá: ${driftAfter.toFixed(4)} m`);
  assert.ok(counts.left > 50, `số frame khoá: ${counts.left}`);
});

test('applyFootLock: chân không chạm sàn giữ nguyên, ngón chân đi theo cổ chân', () => {
  const frames = walkFrames();
  const { frames: locked } = applyFootLock(frames, { fps: 30 });
  assert.ok(Math.abs(locked[30].rightAnkle[0] - frames[30].rightAnkle[0]) < 1e-9, 'chân nhấc bị sửa');
  const f = locked[20];
  const orig = frames[20];
  const dx = f.leftAnkle[0] - orig.leftAnkle[0];
  assert.ok(Math.abs((f.leftFoot[0] - orig.leftFoot[0]) - dx) < 1e-9, 'ngón chân không đi cùng cổ chân');
});

test('applyFootLock: giữ nguyên độ dài xương cẳng chân', () => {
  const frames = walkFrames();
  const { frames: locked } = applyFootLock(frames, { fps: 30 });
  const shin = locked.map((f) => Math.hypot(
    f.leftAnkle[0] - f.leftKnee[0],
    f.leftAnkle[1] - f.leftKnee[1],
    f.leftAnkle[2] - f.leftKnee[2],
  ));
  // The locked shin keeps the length captured at contact entry, not the visible
  // stretch caused by the original sliding foot.
  shin.forEach((l) => assert.ok(Math.abs(l - shin[0]) < 1e-6, `cẳng chân co giãn: ${l} vs ${shin[0]}`));
});

test('processJointSeries: pipeline đầy đủ sinh frame hữu hạn, đúng số lượng', () => {
  const frames = processJointSeries([body(), body(), body()], { fps: 30 });
  assert.equal(frames.length, 3);
  for (const f of frames) {
    for (const key of JOINT_KEYS) {
      const v = f[key];
      if (key === 'time') { assert.ok(Number.isFinite(v)); continue; }
      v.forEach((n) => assert.ok(Number.isFinite(n), `${key} có NaN`));
    }
  }
});

// ---------------------------------------------------------------------------
// BrowserMocapEngine (không tải model: sampler được tiêm vào)
// ---------------------------------------------------------------------------
function worldLandmarks(opts = {}) {
  const list = new Array(33).fill(null).map(() => ({ x: 0.5, y: 0.5, z: 0, visibility: 0.9 }));
  const bodyJoints = body(opts);
  for (const [joint, index] of Object.entries(POSE_LANDMARK_INDEX)) {
    const [x, y, z] = bodyJoints[joint];
    list[index] = { x, y, z, visibility: 0.9 };
  }
  return list;
}

function normalizedLandmarks() {
  return new Array(33).fill(null).map((_, i) => ({
    x: 0.5 + (i % 5) * 0.01,
    y: 0.4 + (i % 7) * 0.02,
    z: 0,
    visibility: 0.8,
  }));
}

test('poseToJoints: map đúng 17 khớp, loại frame thiếu visibility', () => {
  const engine = new BrowserMocapEngine();
  const joints = engine.poseToJoints(worldLandmarks());
  assert.ok(joints, 'không nhận frame hợp lệ');
  assert.deepEqual(Object.keys(joints.joints).sort(), [...SKELETON_JOINTS].sort());
  assert.equal(joints.joints.leftAnkle[1], 0.8);

  const hidden = worldLandmarks();
  for (const idx of [11, 12, 23, 24]) hidden[idx].visibility = 0;
  assert.equal(engine.poseToJoints(hidden), null);
});

await testAsync('processFrames: maxFrames + frameStep lấy đúng số frame và đúng schema', async () => {
  const engine = new BrowserMocapEngine();
  const calls = [];
  const result = await engine.processFrames({
    fps: 30,
    totalFrames: 300,
    maxFrames: 10,
    frameStep: 3,
    footLock: true,
    sampler: (index) => {
      calls.push(index);
      return { worldLandmarks: worldLandmarks(), landmarks: normalizedLandmarks() };
    },
  });
  assert.equal(calls.length, 10);
  assert.deepEqual(calls.slice(0, 3), [0, 3, 6]);
  assert.equal(result.success, true);
  assert.equal(result.engine, 'browser-wasm');
  assert.equal(result.numFrames, 10);
  assert.equal(result.mocapFrames.length, 10);
  assert.deepEqual(Object.keys(result.mocapFrames[0]).sort(), JOINT_KEYS);
  assert.equal(result.landmarks2D.length, 10);
  assert.equal(result.landmarks2D[0].length, 33);
  assert.ok(result.footLockFrames, 'thiếu thông tin foot-lock');
});

test('buildMocapFrames: times tuỳ biến giữ đúng nhịp video khi subsample', () => {
  const frames = buildMocapFrames([body(), body(), body()], { fps: 15, times: [0, 0.2, 0.4] });
  assert.equal(frames[1].time, 0.2);
  assert.equal(frames[2].time, 0.4);
});

await testAsync('processFrames: frameStep không làm clip chạy nhanh gấp đôi', async () => {
  const engine = new BrowserMocapEngine();
  const result = await engine.processFrames({
    fps: 30,
    totalFrames: 300,
    frameStep: 3,
    maxFrames: 10,
    sampler: () => ({ worldLandmarks: [worldLandmarks()], landmarks: [normalizedLandmarks()] }),
  });
  // Samples are 3 video frames apart => 0.1s of real time per sample.
  assert.ok(Math.abs(result.mocapFrames[1].time - 0.1) < 1e-6, `time ${result.mocapFrames[1].time}`);
  // 10 samples, 3 frames apart => last timestamp 27/30 = 0.9s of real video.
  assert.ok(Math.abs(result.duration - 0.9) < 1e-6, `duration ${result.duration}`);
  assert.equal(result.videoFps, 30);
  assert.equal(result.fps, 10);
});

await testAsync('processFrames: onProgress tăng dần và kết thúc 100%', async () => {
  const engine = new BrowserMocapEngine();
  const seen = [];
  await engine.processFrames({
    fps: 30,
    totalFrames: 12,
    sampler: () => ({ worldLandmarks: worldLandmarks(), landmarks: normalizedLandmarks() }),
    onProgress: (p) => seen.push(p),
  });
  assert.equal(seen.length, 12);
  assert.equal(seen[seen.length - 1].percent, 100);
  for (let i = 1; i < seen.length; i++) assert.ok(seen[i].processed >= seen[i - 1].processed);
});

await testAsync('processFrames: frame không nhận dạng được thì nội suy, không vỡ clip', async () => {
  const engine = new BrowserMocapEngine();
  const result = await engine.processFrames({
    fps: 30,
    totalFrames: 6,
    sampler: (index) => (index === 3 ? null : { worldLandmarks: worldLandmarks(), landmarks: normalizedLandmarks() }),
  });
  assert.equal(result.numFrames, 6);
  assert.equal(result.detectedFrames, 5);
  for (const f of result.mocapFrames) {
    assert.ok(Number.isFinite(f.leftAnkle[0]), 'có NaN sau khi nội suy');
  }
});

await testAsync('processFrames: huỷ giữa chừng ném AbortError', async () => {
  const engine = new BrowserMocapEngine();
  const controller = new AbortController();
  let calls = 0;
  await assert.rejects(
    engine.processFrames({
      fps: 30,
      totalFrames: 50,
      signal: controller.signal,
      sampler: () => {
        calls += 1;
        if (calls === 3) controller.abort();
        return { worldLandmarks: worldLandmarks(), landmarks: normalizedLandmarks() };
      },
    }),
    (err) => err.name === 'AbortError',
  );
});

await testAsync('processFrames: video with no person -> clear error', async () => {
  const engine = new BrowserMocapEngine();
  await assert.rejects(
    engine.processFrames({ fps: 30, totalFrames: 5, sampler: () => null }),
    /No human pose detected/i,
  );
});

await testAsync('processFrames: lỗi sampler đơn lẻ không làm hỏng cả clip', async () => {
  const engine = new BrowserMocapEngine();
  const result = await engine.processFrames({
    fps: 30,
    totalFrames: 5,
    sampler: (index) => {
      if (index === 2) throw new Error('decode fail');
      return { worldLandmarks: worldLandmarks(), landmarks: normalizedLandmarks() };
    },
  });
  assert.equal(result.numFrames, 5);
  assert.equal(result.detectedFrames, 4);
});

await testAsync('processFrames: nhận đúng shape thật của MediaPipe ([[33 landmarks]])', async () => {
  const engine = new BrowserMocapEngine();
  const result = await engine.processFrames({
    fps: 30,
    totalFrames: 6,
    // PoseLandmarkerResult returns one nested list per detected pose.
    sampler: () => ({ worldLandmarks: [worldLandmarks()], landmarks: [normalizedLandmarks()] }),
  });
  assert.equal(result.detectedFrames, 6);
  assert.equal(result.detectionRate, 1);
  assert.equal(result.numFrames, 6);
  assert.equal(result.landmarks2D[0].length, 33);
  assert.ok(Number.isFinite(result.mocapFrames[0].leftAnkle[1]), 'frame rỗng sau khi map landmark lồng');
});

await testAsync('processVideo: nhận shape lồng và trả kết quả dùng được', async () => {
  const engine = new BrowserMocapEngine();
  let landmarkerCalls = 0;
  await engine.init({
    landmarkerFactory: async () => ({
      detectForVideo: () => {
        landmarkerCalls += 1;
        return { worldLandmarks: [worldLandmarks()], landmarks: [normalizedLandmarks()] };
      },
      close: () => {},
    }),
  });
  // Minimal <video> stand-in: processVideo only needs duration/currentTime/paused/dispatch.
  const fakeVideo = {
    duration: 2,
    currentTime: 0,
    paused: true,
    videoWidth: 1280,
    videoHeight: 720,
    listeners: new Map(),
    addEventListener(type, cb) { this.listeners.set(type, cb); },
    removeEventListener(type) { this.listeners.delete(type); },
    play() { return Promise.resolve(); },
    pause() {},
  };
  globalThis.document = {
    createElement: () => ({ width: 0, height: 0, getContext: () => ({ drawImage() {} }) }),
  };
  try {
    const result = await engine.processVideo(fakeVideo, { maxFrames: 4, frameStep: 5 });
    assert.equal(result.numFrames, 4);
    assert.ok(landmarkerCalls >= 4, `detectForVideo gọi ${landmarkerCalls} lần`);
    assert.equal(result.detectedFrames, 4);
  } finally {
    delete globalThis.document;
  }
});

await testAsync('dispose: đóng landmarker và từ chối chạy tiếp', async () => {
  let closed = false;
  const engine = new BrowserMocapEngine();
  await engine.init({ landmarkerFactory: async () => ({ close: () => { closed = true; }, detectForVideo: () => null }) });
  engine.dispose();
  assert.equal(closed, true);
  await assert.rejects(engine.init(), /disposed/);
});

test('biên an toàn: OneEuro(freq=0), enforceBoneLengths(xương dài 0), footLock(0..2 frame & fps=0)', () => {
  for (const cfg of [{ freq: 0 }, { freq: -30 }, { freq: 30, minCutoff: 0 }]) {
    const f = new OneEuroFilter(cfg);
    f.filter([1, 2, 3]);
    f.filter([2, 3, 4]).forEach((v) => assert.ok(Number.isFinite(v)));
  }
  const collapsed = body();
  collapsed.leftAnkle = [...collapsed.leftKnee];
  for (const fr of enforceBoneLengths([body(), collapsed, body()])) {
    fr.leftAnkle.forEach((n) => assert.ok(Number.isFinite(n), 'xương dài 0 sinh NaN'));
  }
  for (const n of [0, 1, 2]) {
    const frames = buildMocapFrames(Array.from({ length: n }, () => body()), { fps: 30 });
    assert.equal(detectFootContacts(frames, { fps: 30 }).left.length, n);
    assert.equal(applyFootLock(frames, { fps: 30 }).frames.length, n);
  }
  const f3 = buildMocapFrames([body(), body(), body()], { fps: 30 });
  assert.equal(detectFootContacts(f3, { fps: 0 }).left.length, 3);
});

await testAsync('processFrames: chặn frameStep=0 (không treo vô hạn) và signal đã abort sẵn', async () => {
  const engine = new BrowserMocapEngine();
  const ac = new AbortController();
  ac.abort();
  let calls = 0;
  await assert.rejects(
    engine.processFrames({ fps: 30, totalFrames: 10, signal: ac.signal, sampler: () => { calls++; return null; } }),
    (err) => err.name === 'AbortError',
  );
  assert.equal(calls, 0, 'signal đã abort không được gọi sampler');

  const r = await engine.processFrames({
    fps: 30, totalFrames: 5, frameStep: 0, maxFrames: 5,
    sampler: () => ({ worldLandmarks: [worldLandmarks()], landmarks: [normalizedLandmarks()] }),
  });
  assert.equal(r.numFrames, 5);
});

console.log('');
if (failures.length) {
  console.error(`MOCAP CLIENT SUITE FAILED — ${passed} passed, ${failures.length} failed`);
  process.exit(1);
}
console.log(`MOCAP CLIENT SUITE PASSED — ${passed} tests`);
