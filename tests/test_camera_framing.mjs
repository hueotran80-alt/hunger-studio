/**
 * Canh camera theo khung hình video gốc (dùng cho render mocap).
 * File: tests/test_camera_framing.mjs
 *
 * Chạy: node tests/test_camera_framing.mjs
 */
import {
  cameraFit,
  videoSubjectBox,
  estimateVideoCameraPose,
  computeCameraOrbitPose,
} from '../js/animation/camera-framing.js';

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

/** 33 landmark MediaPipe: chỉ các điểm cần cho framing có toạ độ thật. */
function poseFrame({ x0, x1, y0, y1, visibility = 0.9 }) {
  const row = Array.from({ length: 33 }, () => [0, 0, 0]);
  const set = (index, x, y, v = visibility) => { row[index] = [x, y, v]; };
  set(0, (x0 + x1) / 2, y0); // mũi (đỉnh)
  set(7, (x0 + x1) / 2, y0 + 0.02);
  set(8, (x0 + x1) / 2, y0 + 0.02);
  set(11, x0 + 0.01, y0 + 0.12);
  set(12, x1 - 0.01, y0 + 0.12);
  set(23, x0 + 0.02, y0 + 0.45);
  set(24, x1 - 0.02, y0 + 0.45);
  set(25, x0 + 0.03, y0 + 0.7);
  set(26, x1 - 0.03, y0 + 0.7);
  set(27, x0 + 0.03, y1);
  set(28, x1 - 0.03, y1);
  set(31, x0 + 0.02, y1);
  set(32, x1 - 0.02, y1);
  return row;
}

await test('videoSubjectBox đo đúng khung chủ thể (0..1)', async () => {
  const frames = [
    poseFrame({ x0: 0.4, x1: 0.6, y0: 0.2, y1: 0.9 }),
    poseFrame({ x0: 0.41, x1: 0.59, y0: 0.21, y1: 0.89 }),
    poseFrame({ x0: 0.4, x1: 0.61, y0: 0.2, y1: 0.9 }),
  ];
  const box = videoSubjectBox(frames);
  assert(box, 'không đo được khung');
  assertClose(box.cx, 0.5, 0.02, 'tâm ngang');
  assertClose(box.cy, 0.55, 0.02, 'tâm dọc');
  assertClose(box.h, 0.7, 0.03, 'chiều cao');
  assertClose(box.w, 0.2, 0.03, 'chiều rộng');
  assert(box.frames === 3, `frames = ${box.frames}`);
});

await test('videoSubjectBox bỏ qua landmark khuất và toạ độ ngoài khung', async () => {
  const row = poseFrame({ x0: 0.4, x1: 0.6, y0: 0.17, y1: 0.85 });
  row[31] = [0.5, 3.2, 0.9]; // toạ độ rác (ngoài khung)
  row[32] = [0.5, -0.4, 0.9];
  row[0] = [0.5, 0.15, 0.05]; // visibility quá thấp → bỏ
  const frames = [row, row, row];
  const box = videoSubjectBox(frames);
  assert(box, 'không đo được khung');
  // Điểm hợp lệ cao nhất là tai 0.19, thấp nhất là mắt cá 0.85 → h ≈ 0.66.
  assert(box.h < 1, `chiều cao bị kéo bởi dữ liệu rác: ${box.h}`);
  assert(box.h > 0.55 && box.h < 0.75, `chiều cao sai: ${box.h}`);
});

await test('videoSubjectBox trả null khi thiếu dữ liệu', async () => {
  assert(videoSubjectBox([]) === null, 'mảng rỗng vẫn trả khung');
  assert(videoSubjectBox(null) === null, 'null vẫn trả khung');
  const sparse = Array.from({ length: 5 }, () => [[0, 0, 0]]);
  assert(videoSubjectBox(sparse) === null, 'frame thiếu điểm vẫn trả khung');
  const twoFrames = [poseFrame({ x0: 0.4, x1: 0.6, y0: 0.2, y1: 0.9 }), poseFrame({ x0: 0.4, x1: 0.6, y0: 0.2, y1: 0.9 })];
  assert(videoSubjectBox(twoFrames) === null, 'chỉ 2 frame (dưới minFrames) vẫn trả khung');
});

await test('cameraFit chiếu đúng tỉ lệ chiều cao chủ thể', async () => {
  const height = 1.8;
  const fovDeg = 50;
  const fit = cameraFit({
    center: [0, 0.9, 0],
    height,
    framing: { cx: 0.5, cy: 0.5, w: 0.3, h: 0.72 },
    fovDeg,
    aspect: 16 / 9,
  });
  const vfov = (fovDeg * Math.PI) / 180;
  const projected = height / (2 * fit.distance * Math.tan(vfov / 2));
  assertClose(projected, 0.72, 1e-6, 'tỉ lệ chiếu lại từ khoảng cách');
  assertClose(fit.position[2], fit.distance, 1e-9, 'camera nằm trên +Z so với tâm');
  assertClose(fit.aim[0], 0, 1e-9, 'chủ thể giữa khung → không lệch ngang');
  assertClose(fit.aim[1], 0.9, 1e-9, 'chủ thể giữa khung → không lệch dọc');
});

await test('cameraFit ngắm lệch để chủ thể rơi đúng chỗ trong khung', async () => {
  const base = { center: [0, 1, 0], height: 1.8, fovDeg: 50, aspect: 16 / 9 };
  const left = cameraFit({ ...base, framing: { cx: 0.3, cy: 0.5, w: 0.3, h: 0.7 } });
  assert(left.aim[0] > 0, `chủ thể lệch trái phải ngắm lệch phải, aim.x = ${left.aim[0]}`);

  const right = cameraFit({ ...base, framing: { cx: 0.7, cy: 0.5, w: 0.3, h: 0.7 } });
  assert(right.aim[0] < 0, `chủ thể lệch phải phải ngắm lệch trái, aim.x = ${right.aim[0]}`);

  const low = cameraFit({ ...base, framing: { cx: 0.5, cy: 0.7, w: 0.3, h: 0.7 } });
  assert(low.aim[1] > base.center[1], `chủ thể nằm thấp phải ngắm cao hơn, aim.y = ${low.aim[1]}`);
});

await test('cameraFit không có landmark thì dùng khung mặc định và giữ tâm', async () => {
  const fit = cameraFit({ center: [0, 0.9, 0], height: 1.8, framing: null, fovDeg: 50, aspect: 16 / 9 });
  assert(fit.source === 'default', `source = ${fit.source}`);
  assertClose(fit.subjectH, 0.82, 1e-9, 'tỉ lệ mặc định');
  assertClose(fit.aim[0], 0, 1e-9, 'aim.x');
  assertClose(fit.aim[1], 0.9, 1e-9, 'aim.y');
});

await test('cameraFit kẹp tỉ lệ chủ thể trong khoảng hợp lý', async () => {
  const tiny = cameraFit({ center: [0, 0, 0], height: 1.8, framing: { cx: 0.5, cy: 0.5, h: 0.01 }, fovDeg: 50, aspect: 1 });
  assertClose(tiny.subjectH, 0.12, 1e-9, 'kẹp dưới');
  const huge = cameraFit({ center: [0, 0, 0], height: 1.8, framing: { cx: 0.5, cy: 0.5, h: 1.4 }, fovDeg: 50, aspect: 1 });
  assertClose(huge.subjectH, 0.98, 1e-9, 'kẹp trên');
});

await test('chủ thể càng lớn trong khung thì camera càng gần', async () => {
  const base = { center: [0, 1, 0], height: 1.8, fovDeg: 50, aspect: 16 / 9 };
  const far = cameraFit({ ...base, framing: { cx: 0.5, cy: 0.5, h: 0.45 } });
  const near = cameraFit({ ...base, framing: { cx: 0.5, cy: 0.5, h: 0.9 } });
  assert(near.distance < far.distance, `near ${near.distance} không nhỏ hơn far ${far.distance}`);
});

await test('video dọc (9:16) không đổi khoảng cách, chỉ đổi độ lệch ngang', async () => {
  const base = { center: [0, 1, 0], height: 1.8, fovDeg: 50, framing: { cx: 0.3, cy: 0.5, h: 0.7 } };
  const wide = cameraFit({ ...base, aspect: 16 / 9 });
  const portrait = cameraFit({ ...base, aspect: 9 / 16 });
  assertClose(portrait.distance, wide.distance, 1e-9, 'khoảng cách phụ thuộc chiều cao dọc');
  assert(Math.abs(portrait.aim[0]) < Math.abs(wide.aim[0]), 'khung hẹp phải lệch ngang ít hơn');
});

await test('estimateVideoCameraPose nhận diện góc máy thẳng và góc máy nhìn nghiêng', async () => {
  const frontFrames = Array.from({ length: 12 }, () => ({
    leftHip: [0.1, 0.9, 0],
    rightHip: [-0.1, 0.9, 0],
    leftShoulder: [0.18, 1.4, 0],
    rightShoulder: [-0.18, 1.4, 0],
  }));
  const frontHint = estimateVideoCameraPose(frontFrames);
  assertClose(frontHint.inferredYawDeg, 0, 1e-3, 'góc yaw front');
  assertClose(frontHint.videoMatchAzimuthDeg, 0, 1e-3, 'azimuth match front');

  // Người quay sang +X (camera ở phía +Z thấy sườn phải -> cần quay -90° quanh +Y để mặt hướng +Z)
  const sideFrames = Array.from({ length: 12 }, () => ({
    leftHip: [0, 0.9, -0.1],
    rightHip: [0, 0.9, 0.1],
    leftShoulder: [0, 1.4, -0.18],
    rightShoulder: [0, 1.4, 0.18],
  }));
  const sideHint = estimateVideoCameraPose(sideFrames);
  assertClose(sideHint.inferredYawDeg, -90, 1e-2, 'góc yaw quay phải -90°');
  assertClose(sideHint.videoMatchAzimuthDeg, -90, 1e-2, 'camera match nhìn sườn -90°');
});

await test('computeCameraOrbitPose hỗ trợ preset front, three-quarter, side, video-match và pitch/zoom', async () => {
  const base = {
    center: [0, 0.9, 0],
    height: 1.72,
    fovDeg: 48,
    aspect: 16 / 9,
    cameraHint: { frontAzimuthDeg: 0, videoMatchAzimuthDeg: -74, elevationDeg: 10 },
  };
  const vMatch = computeCameraOrbitPose({ ...base, mode: 'video-match' });
  const front = computeCameraOrbitPose({ ...base, mode: 'front' });
  const q34 = computeCameraOrbitPose({ ...base, mode: 'three-quarter' });
  const side = computeCameraOrbitPose({ ...base, mode: 'side' });

  assertClose(vMatch.azimuthDeg, -74, 1e-6, 'video-match azimuth');
  assertClose(front.azimuthDeg, 0, 1e-6, 'front azimuth');
  assertClose(q34.azimuthDeg, 35, 1e-6, 'three-quarter azimuth');
  assertClose(side.azimuthDeg, 88, 1e-6, 'side azimuth');

  // Zoom lớn hơn -> đứng xa hơn; pitch cao hơn -> camera Y cao hơn
  const zoomedOut = computeCameraOrbitPose({ ...base, mode: 'front', zoomScale: 1.5, pitchDeg: 25 });
  assert(zoomedOut.distance > front.distance * 1.4, 'zoomScale=1.5 phải kéo camera ra xa');
  assert(zoomedOut.position[1] > front.position[1] + 0.5, 'pitch=25° phải nâng camera cao hơn');

  // Pitch âm không chui xuống dưới mặt sàn
  const lowPitch = computeCameraOrbitPose({ ...base, mode: 'front', pitchDeg: -35 });
  assert(lowPitch.position[1] >= 0.15, `camera không được chui xuống sàn: y=${lowPitch.position[1]}`);
});

console.log('');
if (failures.length === 0) {
  console.log(`ALL ${passed} CAMERA FRAMING TESTS PASSED`);
  process.exit(0);
}
console.log(`${passed} passed, ${failures.length} failed`);
process.exit(1);
