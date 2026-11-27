/**
 * Giai đoạn 1.3 — nhận rig nhân vật phổ biến (Mixamo / VRM-VRoid / CC / UE).
 * File: tests/test_rig_mapping.mjs
 *
 * Chạy: node --import ./tests/three-resolve-hooks.mjs tests/test_rig_mapping.mjs
 *
 * `_mapBones()` là cửa ngõ của mọi bộ xương: nếu tên xương không được nhận
 * diện thì retarget im lặng bỏ qua xương đó và nhân vật chỉ cử động nửa người.
 * Test dựng skeleton thật cho từng bộ đặt tên rồi kiểm tra map + retarget.
 */
import * as THREE from 'three';
import { MocapRetargeter } from '../js/animation/mocap-retargeter.js';
import { buildMocapFrames } from '../js/animation/mocap-filters.js';

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

// ---------------------------------------------------------------------------
// Dựng skeleton: [tên xương, xương cha]
// ---------------------------------------------------------------------------
function makeSkeleton(defs) {
  const root = new THREE.Group();
  root.name = 'Character';
  const byName = new Map();
  for (const [name, parent] of defs) {
    const bone = new THREE.Bone();
    bone.name = name;
    const p = parent ? byName.get(parent) : null;
    if (p) p.add(bone);
    else root.add(bone);
    bone.position.set(0, 0.14, 0);
    byName.set(name, bone);
  }
  root.updateMatrixWorld(true);
  return { root, byName };
}

const VRM = [
  ['J_Bip_C_Hips', null],
  ['J_Bip_C_Spine', 'J_Bip_C_Hips'],
  ['J_Bip_C_Chest', 'J_Bip_C_Spine'],
  ['J_Bip_C_Neck', 'J_Bip_C_Chest'],
  ['J_Bip_C_Head', 'J_Bip_C_Neck'],
  ['J_Bip_L_Shoulder', 'J_Bip_C_Chest'],
  ['J_Bip_L_UpperArm', 'J_Bip_L_Shoulder'],
  ['J_Bip_L_LowerArm', 'J_Bip_L_UpperArm'],
  ['J_Bip_L_Hand', 'J_Bip_L_LowerArm'],
  ['J_Bip_R_Shoulder', 'J_Bip_C_Chest'],
  ['J_Bip_R_UpperArm', 'J_Bip_R_Shoulder'],
  ['J_Bip_R_LowerArm', 'J_Bip_R_UpperArm'],
  ['J_Bip_R_Hand', 'J_Bip_R_LowerArm'],
  ['J_Bip_L_UpperLeg', 'J_Bip_C_Hips'],
  ['J_Bip_L_LowerLeg', 'J_Bip_L_UpperLeg'],
  ['J_Bip_L_Foot', 'J_Bip_L_LowerLeg'],
  ['J_Bip_L_ToeBase', 'J_Bip_L_Foot'],
  ['J_Bip_R_UpperLeg', 'J_Bip_C_Hips'],
  ['J_Bip_R_LowerLeg', 'J_Bip_R_UpperLeg'],
  ['J_Bip_R_Foot', 'J_Bip_R_LowerLeg'],
  ['J_Bip_R_ToeBase', 'J_Bip_R_Foot'],
];

const MIXAMO = [
  ['mixamorig:Hips', null],
  ['mixamorig:Spine', 'mixamorig:Hips'],
  ['mixamorig:Spine1', 'mixamorig:Spine'],
  ['mixamorig:Spine2', 'mixamorig:Spine1'],
  ['mixamorig:Neck', 'mixamorig:Spine2'],
  ['mixamorig:Head', 'mixamorig:Neck'],
  ['mixamorig:LeftShoulder', 'mixamorig:Spine2'],
  ['mixamorig:LeftArm', 'mixamorig:LeftShoulder'],
  ['mixamorig:LeftForeArm', 'mixamorig:LeftArm'],
  ['mixamorig:LeftHand', 'mixamorig:LeftForeArm'],
  ['mixamorig:LeftHandIndex1', 'mixamorig:LeftHand'],
  ['mixamorig:RightShoulder', 'mixamorig:Spine2'],
  ['mixamorig:RightArm', 'mixamorig:RightShoulder'],
  ['mixamorig:RightForeArm', 'mixamorig:RightArm'],
  ['mixamorig:RightHand', 'mixamorig:RightForeArm'],
  ['mixamorig:LeftUpLeg', 'mixamorig:Hips'],
  ['mixamorig:LeftLeg', 'mixamorig:LeftUpLeg'],
  ['mixamorig:LeftFoot', 'mixamorig:LeftLeg'],
  ['mixamorig:LeftToeBase', 'mixamorig:LeftFoot'],
  ['mixamorig:RightUpLeg', 'mixamorig:Hips'],
  ['mixamorig:RightLeg', 'mixamorig:RightUpLeg'],
  ['mixamorig:RightFoot', 'mixamorig:RightLeg'],
];

const CC = [
  ['CC_Base_Hip', null],
  ['CC_Base_Spine01', 'CC_Base_Hip'],
  ['CC_Base_Spine02', 'CC_Base_Spine01'],
  ['CC_Base_NeckTwist01', 'CC_Base_Spine02'],
  ['CC_Base_Head', 'CC_Base_NeckTwist01'],
  ['CC_Base_L_Clavicle', 'CC_Base_Spine02'],
  ['CC_Base_L_Upperarm', 'CC_Base_L_Clavicle'],
  ['CC_Base_L_Forearm', 'CC_Base_L_Upperarm'],
  ['CC_Base_L_Hand', 'CC_Base_L_Forearm'],
  ['CC_Base_R_Clavicle', 'CC_Base_Spine02'],
  ['CC_Base_R_Upperarm', 'CC_Base_R_Clavicle'],
  ['CC_Base_R_Forearm', 'CC_Base_R_Upperarm'],
  ['CC_Base_R_Hand', 'CC_Base_R_Forearm'],
  ['CC_Base_L_Thigh', 'CC_Base_Hip'],
  ['CC_Base_L_Calf', 'CC_Base_L_Thigh'],
  ['CC_Base_L_Foot', 'CC_Base_L_Calf'],
  ['CC_Base_R_Thigh', 'CC_Base_Hip'],
  ['CC_Base_R_Calf', 'CC_Base_R_Thigh'],
  ['CC_Base_R_Foot', 'CC_Base_R_Calf'],
];

const CORE_KEYS = [
  'hips', 'spine', 'neck', 'head',
  'leftShoulder', 'leftArm', 'leftForearm', 'leftHand',
  'rightShoulder', 'rightArm', 'rightForearm', 'rightHand',
  'leftUpLeg', 'leftLeg', 'leftFoot',
  'rightUpLeg', 'rightLeg', 'rightFoot',
];

function mapRig(defs) {
  const { root, byName } = makeSkeleton(defs);
  const retargeter = new MocapRetargeter(null, null);
  const mapped = retargeter._mapBones(root);
  return { root, byName, retargeter, mapped };
}

// ---------------------------------------------------------------------------
// 1. VRM / VRoid
// ---------------------------------------------------------------------------
await test('VRM/VRoid (J_Bip_*) map đủ 18 xương lõi + giữ đúng bên trái/phải', async () => {
  const { mapped } = mapRig(VRM);
  const missing = CORE_KEYS.filter((k) => !mapped[k]);
  assert(missing.length === 0, `thiếu: ${missing.join(', ')}`);
  assert(mapped.hips.name === 'J_Bip_C_Hips', `hips → ${mapped.hips?.name}`);
  assert(mapped.leftArm.name === 'J_Bip_L_UpperArm', `leftArm → ${mapped.leftArm?.name} (mất bên L?)`);
  assert(mapped.rightArm.name === 'J_Bip_R_UpperArm', `rightArm → ${mapped.rightArm?.name}`);
  assert(mapped.leftUpLeg.name === 'J_Bip_L_UpperLeg', `leftUpLeg → ${mapped.leftUpLeg?.name}`);
  assert(mapped.leftHand.name === 'J_Bip_L_Hand', `leftHand → ${mapped.leftHand?.name}`);
  assert(mapped.leftFoot.name === 'J_Bip_L_Foot', `leftFoot → ${mapped.leftFoot?.name}`);
  // VRM chỉ có Spine + Chest (không có Spine1) → spine2 phải nhận Chest
  assert(mapped.spine2 && mapped.spine2.name === 'J_Bip_C_Chest', `spine2 → ${mapped.spine2?.name}`);
});

// ---------------------------------------------------------------------------
// 2. Mixamo
// ---------------------------------------------------------------------------
await test('Mixamo map đủ 20 xương và bỏ qua ngón tay', async () => {
  const { mapped } = mapRig(MIXAMO);
  const missing = [...CORE_KEYS, 'spine1', 'spine2'].filter((k) => !mapped[k]);
  assert(missing.length === 0, `thiếu: ${missing.join(', ')}`);
  assert(mapped.leftHand.name === 'mixamorig:LeftHand', `leftHand → ${mapped.leftHand?.name}`);
  assert(mapped.leftHand.name !== 'mixamorig:LeftHandIndex1', 'ngón tay bị nhận nhầm là bàn tay');
  assert(mapped.spine1.name === 'mixamorig:Spine1', `spine1 → ${mapped.spine1?.name}`);
});

// ---------------------------------------------------------------------------
// 3. Character Creator / Reallusion
// ---------------------------------------------------------------------------
await test('Character Creator (CC_Base_*) map đủ 18 xương lõi', async () => {
  const { mapped } = mapRig(CC);
  const missing = CORE_KEYS.filter((k) => !mapped[k]);
  assert(missing.length === 0, `thiếu: ${missing.join(', ')}`);
  assert(mapped.leftArm.name === 'CC_Base_L_Upperarm', `leftArm → ${mapped.leftArm?.name}`);
  assert(mapped.rightLeg.name === 'CC_Base_R_Calf', `rightLeg → ${mapped.rightLeg?.name}`);
  // CC không có xương "neck" trơn — phải dùng NeckTwist01 thay vì bỏ trống.
  assert(mapped.neck.name === 'CC_Base_NeckTwist01', `neck → ${mapped.neck?.name}`);
});

// ---------------------------------------------------------------------------
// 4. Retarget thật trên skeleton VRM
// ---------------------------------------------------------------------------
function bodySample(t) {
  const map = {
    nose: [0, -0.55], leftShoulder: [-0.18, -0.45], rightShoulder: [0.18, -0.45],
    leftElbow: [-0.3, -0.2], rightElbow: [0.3, -0.2],
    leftWrist: [-0.35, 0.02], rightWrist: [0.35, 0.02],
    leftHandIndex: [-0.37, 0.08], rightHandIndex: [0.37, 0.08],
    leftHip: [-0.1, 0], rightHip: [0.1, 0],
    leftKnee: [-0.1, 0.4], rightKnee: [0.1, 0.4],
    leftAnkle: [-0.1, 0.8], rightAnkle: [0.1, 0.8],
    leftFoot: [-0.1, 0.85], rightFoot: [0.1, 0.85],
  };
  const joints = {};
  for (const [joint, [x, y]] of Object.entries(map)) {
    joints[joint] = [x + 0.02 * t, y, 0];
  }
  return joints;
}

await test('Retarget lên skeleton VRM tạo clip có track đúng tên xương VRM', async () => {
  const { root } = mapRig(VRM);
  const retargeter = new MocapRetargeter(null, null);
  const frames = buildMocapFrames(Array.from({ length: 24 }, (_, i) => bodySample(i / 23)), { fps: 30 });
  const result = retargeter.retarget(root, { fps: 30, mocapFrames: frames }, {
    autoAlign: false, groundFeet: true, smoothing: 0.2, footLock: true,
  });

  assert(result.success, `retarget lỗi: ${result.error}`);
  assert(result.tracksCount >= 18, `chỉ có ${result.tracksCount} track`);
  const clip = retargeter.currentClip;
  assert(clip && clip.tracks.length === result.tracksCount, 'currentClip không khớp số track');
  const names = new Set(clip.tracks.map((t) => t.name));
  for (const required of ['J_Bip_C_Hips.position', 'J_Bip_C_Hips.quaternion', 'J_Bip_L_Hand.quaternion', 'J_Bip_R_Foot.quaternion']) {
    assert(names.has(required), `thiếu track ${required}`);
  }
  assert(result.numFrames === 24, `numFrames = ${result.numFrames}`);
  // buildMocapFrames làm tròn mốc thời gian về 5 chữ số thập phân.
  assert(Math.abs(result.duration - 23 / 30) < 1e-4, `duration = ${result.duration}`);
});

await test('Xương không map được (thiếu hẳn) không làm retarget sập', async () => {
  // Skeleton tối giản: chỉ hông + cột sống + đầu, thiếu tay chân.
  const partial = [
    ['Hips', null], ['Spine', 'Hips'], ['Chest', 'Spine'], ['Neck', 'Chest'], ['Head', 'Neck'],
  ];
  const { root } = mapRig(partial);
  const retargeter = new MocapRetargeter(null, null);
  const frames = buildMocapFrames(Array.from({ length: 10 }, (_, i) => bodySample(i / 9)), { fps: 30 });
  const result = retargeter.retarget(root, { fps: 30, mocapFrames: frames }, { autoAlign: false, footLock: false });
  assert(result.success, `retarget nên chạy được một phần, lỗi: ${result.error}`);
  assert(result.tracksCount >= 4, `chỉ tạo ${result.tracksCount} track`);
});

console.log('');
if (failures.length === 0) {
  console.log(`ALL ${passed} RIG MAPPING TESTS PASSED`);
  process.exit(0);
}
console.log(`${passed} passed, ${failures.length} failed`);
process.exit(1);
