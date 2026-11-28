/**
 * Hunger 3D Studio — Multi-Asset Skeleton Template Library & Silhouette Auto-Fitter
 * File: js/animation/skeleton-templates.js
 *
 * Provides standardized, production-ready skeleton templates for diverse 3D asset
 * archetypes (humans, quadrupeds, birds, aquatic/fish, serpents/dragons, arachnids,
 * mechanical vehicles) plus vertex-silhouette anatomical fitting for custom uploaded
 * humanoid characters (T-Pose & A-Pose automatic detection).
 */

import * as THREE from 'three';

/**
 * Metadata + procedural bone-definition catalog.
 * Coordinates are in meters, Y-up, facing +Z, grounded at Y = 0.
 * Each bone tuple: [name, parentName, [relX, relY, relZ]]
 */
export const SKELETON_TEMPLATES = Object.freeze({
  humanoid_standard: {
    id: 'humanoid_standard',
    category: 'human',
    name: 'Humanoid Standard (22 Bones)',
    nameVi: 'Nhân vật Người chuẩn (22 xương)',
    description: 'Mixamo / Unity / Godot compatible core humanoid rig for AI Mocap.',
    descriptionVi: 'Khung xương người 22 xương chuẩn Mixamo / Unity / Godot cho AI Mocap.',
    defaultSize: 1.72,
    sizeParam: 'height',
    mocapCompatible: true,
    symmetryAxis: 'x',
    ikChains: ['leftArm', 'rightArm', 'leftLeg', 'rightLeg'],
    buildDefs(size = 1.72, options = {}) {
      const s = (Number(size) || 1.72) / 1.72;
      const pose = String(options.pose || 't-pose').toLowerCase();
      const armDropDeg = pose === 'a-pose' ? 36 : (Number(options.armDropDeg) || 0);
      const rad = THREE.MathUtils.degToRad(armDropDeg);
      const cA = Math.cos(rad);
      const sA = Math.sin(rad);

      const upperLen = 0.273 * s;
      const foreLen = 0.255 * s;

      const defs = [
        ['Hips', null, [0, 0.945 * s, 0]],
        ['Spine', 'Hips', [0, 0.125 * s, 0]],
        ['Spine1', 'Spine', [0, 0.135 * s, 0]],
        ['Spine2', 'Spine1', [0, 0.140 * s, 0]],
        ['Neck', 'Spine2', [0, 0.115 * s, 0]],
        ['Head', 'Neck', [0, 0.085 * s, 0.008 * s]],
      ];

      for (const [side, sign] of [['Left', 1], ['Right', -1]]) {
        defs.push([`${side}Shoulder`, 'Spine2', [sign * 0.050 * s, 0.070 * s, 0.006 * s]]);
        defs.push([`${side}Arm`, `${side}Shoulder`, [sign * 0.132 * s, 0.007 * s, -0.016 * s]]);
        defs.push([`${side}ForeArm`, `${side}Arm`, [sign * upperLen * cA, -upperLen * sA, -0.012 * s]]);
        defs.push([`${side}Hand`, `${side}ForeArm`, [sign * foreLen * cA, -foreLen * sA, 0.016 * s]]);

        defs.push([`${side}UpLeg`, 'Hips', [sign * 0.095 * s, -0.050 * s, 0]]);
        defs.push([`${side}Leg`, `${side}UpLeg`, [0, -0.410 * s, 0.016 * s]]);
        defs.push([`${side}Foot`, `${side}Leg`, [0, -0.397 * s, -0.028 * s]]);
        defs.push([`${side}ToeBase`, `${side}Foot`, [0, -0.062 * s, 0.118 * s]]);
      }
      return defs;
    },
  },

  humanoid_pro: {
    id: 'humanoid_pro',
    category: 'human',
    name: 'Humanoid Pro Full (56 Bones)',
    nameVi: 'Nhân vật Người Pro đầy đủ (56 xương)',
    description: '22 core bones + 30 articulated fingers + 4 limb twist helpers (studio grade).',
    descriptionVi: '22 xương chính + 30 xương ngón tay + 4 xương chống xoắn tay (chuẩn studio).',
    defaultSize: 1.72,
    sizeParam: 'height',
    mocapCompatible: true,
    symmetryAxis: 'x',
    ikChains: ['leftArm', 'rightArm', 'leftLeg', 'rightLeg'],
    buildDefs(size = 1.72, options = {}) {
      const s = (Number(size) || 1.72) / 1.72;
      const pose = String(options.pose || 't-pose').toLowerCase();
      const armDropDeg = pose === 'a-pose' ? 36 : (Number(options.armDropDeg) || 0);
      const rad = THREE.MathUtils.degToRad(armDropDeg);
      const cA = Math.cos(rad);
      const sA = Math.sin(rad);

      const upperLen = 0.273 * s;
      const foreLen = 0.255 * s;

      const defs = [
        ['Hips', null, [0, 0.945 * s, 0]],
        ['Spine', 'Hips', [0, 0.125 * s, 0]],
        ['Spine1', 'Spine', [0, 0.135 * s, 0]],
        ['Spine2', 'Spine1', [0, 0.140 * s, 0]],
        ['Neck', 'Spine2', [0, 0.115 * s, 0]],
        ['Head', 'Neck', [0, 0.085 * s, 0.008 * s]],
      ];

      for (const [side, sign] of [['Left', 1], ['Right', -1]]) {
        defs.push([`${side}Shoulder`, 'Spine2', [sign * 0.050 * s, 0.070 * s, 0.006 * s]]);
        defs.push([`${side}Arm`, `${side}Shoulder`, [sign * 0.132 * s, 0.007 * s, -0.016 * s]]);
        defs.push([`${side}ArmTwist`, `${side}Arm`, [sign * upperLen * 0.5 * cA, -upperLen * 0.5 * sA, -0.006 * s]]);
        defs.push([`${side}ForeArm`, `${side}Arm`, [sign * upperLen * cA, -upperLen * sA, -0.012 * s]]);
        defs.push([`${side}ForeArmTwist`, `${side}ForeArm`, [sign * foreLen * 0.5 * cA, -foreLen * 0.5 * sA, 0.008 * s]]);
        defs.push([`${side}Hand`, `${side}ForeArm`, [sign * foreLen * cA, -foreLen * sA, 0.016 * s]]);

        const hand = `${side}Hand`;
        const rotVec = (dx, dy, dz) => [
          sign * (dx * cA + dy * sA),
          -dx * sA + dy * cA,
          dz,
        ];

        defs.push([`${hand}Thumb1`, hand, rotVec(0.024 * s, -0.011 * s, 0.026 * s)]);
        defs.push([`${hand}Thumb2`, `${hand}Thumb1`, rotVec(0.026 * s, -0.008 * s, 0.018 * s)]);
        defs.push([`${hand}Thumb3`, `${hand}Thumb2`, rotVec(0.022 * s, -0.005 * s, 0.014 * s)]);

        const fingerSpecs = [
          ['Index', 0.026 * s, 0.036 * s, 0.024 * s, 0.020 * s],
          ['Middle', 0.008 * s, 0.040 * s, 0.026 * s, 0.021 * s],
          ['Ring', -0.010 * s, 0.036 * s, 0.024 * s, 0.020 * s],
          ['Pinky', -0.027 * s, 0.029 * s, 0.020 * s, 0.017 * s],
        ];
        for (const [fName, zOff, l1, l2, l3] of fingerSpecs) {
          defs.push([`${hand}${fName}1`, hand, rotVec(0.082 * s, 0, zOff)]);
          defs.push([`${hand}${fName}2`, `${hand}${fName}1`, rotVec(l1, 0, 0)]);
          defs.push([`${hand}${fName}3`, `${hand}${fName}2`, rotVec(l2, 0, 0)]);
        }

        defs.push([`${side}UpLeg`, 'Hips', [sign * 0.095 * s, -0.050 * s, 0]]);
        defs.push([`${side}Leg`, `${side}UpLeg`, [0, -0.410 * s, 0.016 * s]]);
        defs.push([`${side}Foot`, `${side}Leg`, [0, -0.397 * s, -0.028 * s]]);
        defs.push([`${side}ToeBase`, `${side}Foot`, [0, -0.062 * s, 0.118 * s]]);
      }
      return defs;
    },
  },

  quadruped: {
    id: 'quadruped',
    category: 'animal',
    name: 'Quadruped Animal (34 Bones)',
    nameVi: 'Động vật 4 chân — Chó / Mèo / Ngựa (34 xương)',
    description: 'Four-legged mammal skeleton (dog, cat, wolf, horse, deer) with spine, ears, jaw & 4-bone tail.',
    descriptionVi: 'Khung xương thú 4 chân (chó, mèo, sói, ngựa, hươu) có cột sống, tai, hàm và đuôi 4 đốt.',
    defaultSize: 0.95,
    sizeParam: 'height',
    mocapCompatible: false,
    symmetryAxis: 'x',
    ikChains: ['frontLeftLeg', 'frontRightLeg', 'backLeftLeg', 'backRightLeg'],
    buildDefs(size = 0.95) {
      const s = (Number(size) || 0.95) / 0.95;
      const defs = [
        // Pelvis root (facing +Z, tail toward -Z)
        ['Pelvis', null, [0, 0.62 * s, -0.32 * s]],
        ['Spine', 'Pelvis', [0, 0.02 * s, 0.22 * s]],
        ['Spine1', 'Spine', [0, 0.02 * s, 0.22 * s]],
        ['Chest', 'Spine1', [0, 0.03 * s, 0.22 * s]],
        ['Neck', 'Chest', [0, 0.12 * s, 0.14 * s]],
        ['Neck1', 'Neck', [0, 0.10 * s, 0.10 * s]],
        ['Head', 'Neck1', [0, 0.06 * s, 0.10 * s]],
        ['Jaw', 'Head', [0, -0.04 * s, 0.08 * s]],
        ['LeftEar', 'Head', [0.07 * s, 0.08 * s, -0.02 * s]],
        ['RightEar', 'Head', [-0.07 * s, 0.08 * s, -0.02 * s]],
        // 4-segment articulated tail
        ['Tail1', 'Pelvis', [0, 0.03 * s, -0.11 * s]],
        ['Tail2', 'Tail1', [0, -0.04 * s, -0.14 * s]],
        ['Tail3', 'Tail2', [0, -0.06 * s, -0.13 * s]],
        ['Tail4', 'Tail3', [0, -0.03 * s, -0.12 * s]],
      ];

      for (const [side, sign] of [['Left', 1], ['Right', -1]]) {
        // Anatomically accurate quadruped Front limb:
        // Scapula (withers -> point of shoulder +Z) -> Humerus/UpperArm (shoulder -> elbow -Z)
        // -> ForeArm (elbow -> carpus/knee straight down) -> Paw/Cannon (knee -> fetlock) -> Toe/Hoof (+Z)
        defs.push([`Front${side}Scapula`, 'Chest', [sign * 0.11 * s, 0.06 * s, 0.02 * s]]);
        defs.push([`Front${side}UpperArm`, `Front${side}Scapula`, [sign * 0.02 * s, -0.15 * s, 0.07 * s]]);
        defs.push([`Front${side}ForeArm`, `Front${side}UpperArm`, [0, -0.14 * s, -0.08 * s]]);
        defs.push([`Front${side}Paw`, `Front${side}ForeArm`, [0, -0.21 * s, 0.01 * s]]);
        defs.push([`Front${side}Toe`, `Front${side}Paw`, [0, -0.18 * s, 0.05 * s]]);

        // Anatomically accurate quadruped Hind limb:
        // Thigh/Femur (hip -> stifle DOWN & FORWARD +Z) -> Shin/Tibia (stifle -> hock DOWN & BACK -Z)
        // -> Hock/Cannon (hock -> fetlock straight DOWN) -> Paw/Pastern (fetlock -> hoof DOWN & FORWARD +Z)
        defs.push([`Back${side}Thigh`, 'Pelvis', [sign * 0.12 * s, -0.02 * s, -0.02 * s]]);
        defs.push([`Back${side}Shin`, `Back${side}Thigh`, [0, -0.20 * s, 0.08 * s]]);
        defs.push([`Back${side}Hock`, `Back${side}Shin`, [0, -0.19 * s, -0.11 * s]]);
        defs.push([`Back${side}Paw`, `Back${side}Hock`, [0, -0.17 * s, 0.02 * s]]);
        defs.push([`Back${side}Toe`, `Back${side}Paw`, [0, -0.06 * s, 0.06 * s]]);
      }
      return defs;
    },
  },

  bird: {
    id: 'bird',
    category: 'animal',
    name: 'Bird / Winged Creature (28 Bones)',
    nameVi: 'Chim / Sinh vật có cánh (28 xương)',
    description: 'Avian skeleton with articulated folding wings, tail fan, neck/beak & avian legs.',
    descriptionVi: 'Khung xương chim với đôi cánh gập nhiều khớp, quạt đuôi, cổ mỏ và chân chim.',
    defaultSize: 0.70,
    sizeParam: 'height',
    mocapCompatible: false,
    symmetryAxis: 'x',
    ikChains: ['leftWing', 'rightWing', 'leftLeg', 'rightLeg'],
    buildDefs(size = 0.70) {
      const s = (Number(size) || 0.70) / 0.70;
      const defs = [
        ['Pelvis', null, [0, 0.36 * s, -0.04 * s]],
        ['Spine', 'Pelvis', [0, 0.06 * s, 0.10 * s]],
        ['Chest', 'Spine', [0, 0.07 * s, 0.10 * s]],
        ['Neck', 'Chest', [0, 0.08 * s, 0.07 * s]],
        ['Neck1', 'Neck', [0, 0.08 * s, 0.04 * s]],
        ['Head', 'Neck1', [0, 0.06 * s, 0.05 * s]],
        ['BeakUpper', 'Head', [0, 0.00 * s, 0.09 * s]],
        ['BeakLower', 'Head', [0, -0.02 * s, 0.08 * s]],
        ['TailBase', 'Pelvis', [0, -0.02 * s, -0.12 * s]],
        ['TailFan', 'TailBase', [0, -0.03 * s, -0.16 * s]],
      ];

      for (const [side, sign] of [['Left', 1], ['Right', -1]]) {
        // Wing chain (5 bones per side)
        defs.push([`${side}WingShoulder`, 'Chest', [sign * 0.07 * s, 0.04 * s, 0.01 * s]]);
        defs.push([`${side}WingUpper`, `${side}WingShoulder`, [sign * 0.18 * s, 0.02 * s, -0.04 * s]]);
        defs.push([`${side}WingFore`, `${side}WingUpper`, [sign * 0.22 * s, 0.01 * s, 0.05 * s]]);
        defs.push([`${side}WingHand`, `${side}WingFore`, [sign * 0.18 * s, 0.00 * s, -0.02 * s]]);
        defs.push([`${side}WingTip`, `${side}WingHand`, [sign * 0.16 * s, -0.01 * s, -0.04 * s]]);

        // Avian digitigrade leg (4 bones per side)
        defs.push([`${side}Thigh`, 'Pelvis', [sign * 0.06 * s, -0.04 * s, 0.02 * s]]);
        defs.push([`${side}Drumstick`, `${side}Thigh`, [0, -0.14 * s, 0.04 * s]]);
        defs.push([`${side}Tarsus`, `${side}Drumstick`, [0, -0.14 * s, -0.05 * s]]);
        defs.push([`${side}Foot`, `${side}Tarsus`, [0, -0.04 * s, 0.07 * s]]);
      }
      return defs;
    },
  },

  fish: {
    id: 'fish',
    category: 'animal',
    name: 'Fish / Aquatic Swimmer (14 Bones)',
    nameVi: 'Cá / Sinh vật thủy sinh (14 xương)',
    description: 'Hydrodynamic spline body with undulating tail fin, jaw, dorsal & pectoral fins.',
    descriptionVi: 'Khung xương cá / cá heo với cột sống uốn lượn, vây lưng, vây ngực và đuôi.',
    defaultSize: 1.20,
    sizeParam: 'length',
    mocapCompatible: false,
    symmetryAxis: 'x',
    ikChains: [],
    buildDefs(size = 1.20) {
      const s = (Number(size) || 1.20) / 1.20;
      return [
        ['BodyRoot', null, [0, 0.45 * s, 0.12 * s]],
        ['Head', 'BodyRoot', [0, 0.01 * s, 0.24 * s]],
        ['Jaw', 'Head', [0, -0.06 * s, 0.12 * s]],
        ['DorsalFin', 'BodyRoot', [0, 0.16 * s, -0.02 * s]],
        ['LeftPectoralFin', 'BodyRoot', [0.12 * s, -0.07 * s, 0.10 * s]],
        ['RightPectoralFin', 'BodyRoot', [-0.12 * s, -0.07 * s, 0.10 * s]],
        ['Spine1', 'BodyRoot', [0, 0.0, -0.18 * s]],
        ['LeftPelvicFin', 'Spine1', [0.07 * s, -0.09 * s, 0.02 * s]],
        ['RightPelvicFin', 'Spine1', [-0.07 * s, -0.09 * s, 0.02 * s]],
        ['Spine2', 'Spine1', [0, 0.0, -0.18 * s]],
        ['Tail1', 'Spine2', [0, 0.0, -0.17 * s]],
        ['Tail2', 'Tail1', [0, 0.0, -0.15 * s]],
        ['TailFinUpper', 'Tail2', [0, 0.11 * s, -0.16 * s]],
        ['TailFinLower', 'Tail2', [0, -0.11 * s, -0.16 * s]],
      ];
    },
  },

  serpent: {
    id: 'serpent',
    category: 'creature',
    name: 'Snake / Dragon Spine (15 Bones)',
    nameVi: 'Rắn / Rồng / Xúc tu (15 xương)',
    description: 'Continuous 15-bone slithering spline chain for snakes, eastern dragons, worms or tentacles.',
    descriptionVi: 'Chuỗi 15 đốt xương uốn sóng liên tục cho rắn, rồng châu Á hoặc xúc tu.',
    defaultSize: 2.20,
    sizeParam: 'length',
    mocapCompatible: false,
    symmetryAxis: 'x',
    ikChains: [],
    buildDefs(size = 2.20) {
      const s = (Number(size) || 2.20) / 2.20;
      const seg = 0.17 * s;
      const defs = [
        ['Head', null, [0, 0.22 * s, 0.95 * s]],
        ['Jaw', 'Head', [0, -0.04 * s, 0.12 * s]],
        ['Neck', 'Head', [0, -0.04 * s, -0.14 * s]],
      ];
      let prev = 'Neck';
      for (let i = 1; i <= 11; i++) {
        const name = i === 11 ? 'TailTip' : `Body${i}`;
        const yOff = i === 1 ? -0.05 * s : 0;
        defs.push([name, prev, [0, yOff, -seg]]);
        prev = name;
      }
      return defs;
    },
  },

  arachnid: {
    id: 'arachnid',
    category: 'creature',
    name: 'Spider / Multi-Legged Mech (38 Bones)',
    nameVi: 'Nhện / Côn trùng / Robot 8 chân (38 xương)',
    description: '8-legged arachnid or walker mech skeleton with 4-segment articulated legs and mandibles.',
    descriptionVi: 'Khung xương nhện hoặc robot nhiều chân gồm 8 chân 4 đốt và cặp càng trước.',
    defaultSize: 1.00,
    sizeParam: 'span',
    mocapCompatible: false,
    symmetryAxis: 'x',
    ikChains: [],
    buildDefs(size = 1.00) {
      const s = (Number(size) || 1.00) / 1.00;
      const defs = [
        ['Cephalothorax', null, [0, 0.32 * s, 0]],
        ['Head', 'Cephalothorax', [0, 0.01 * s, 0.14 * s]],
        ['LeftMandible', 'Head', [0.05 * s, -0.03 * s, 0.09 * s]],
        ['RightMandible', 'Head', [-0.05 * s, -0.03 * s, 0.09 * s]],
        ['Abdomen', 'Cephalothorax', [0, 0.04 * s, -0.16 * s]],
        ['AbdomenTip', 'Abdomen', [0, 0.02 * s, -0.22 * s]],
      ];

      // 4 pairs of radial legs angled from front to rear
      const zOffsets = [0.09, 0.03, -0.03, -0.09];
      const yawAnglesDeg = [42, 16, -16, -42];
      for (const [side, sign] of [['L', 1], ['R', -1]]) {
        for (let idx = 0; idx < 4; idx++) {
          const n = idx + 1;
          const yaw = THREE.MathUtils.degToRad(yawAnglesDeg[idx]);
          const dx = Math.cos(yaw) * sign;
          const dz = Math.sin(yaw);
          const prefix = `Leg${side}${n}`;
          defs.push([`${prefix}_Coxa`, 'Cephalothorax', [sign * 0.11 * s, -0.02 * s, zOffsets[idx] * s]]);
          defs.push([`${prefix}_Femur`, `${prefix}_Coxa`, [dx * 0.16 * s, 0.15 * s, dz * 0.16 * s]]);
          defs.push([`${prefix}_Tibia`, `${prefix}_Femur`, [dx * 0.22 * s, -0.18 * s, dz * 0.22 * s]]);
          defs.push([`${prefix}_Tarsus`, `${prefix}_Tibia`, [dx * 0.12 * s, -0.27 * s, dz * 0.12 * s]]);
        }
      }
      return defs;
    },
  },

  vehicle: {
    id: 'vehicle',
    category: 'mechanical',
    name: 'Vehicle / Wheeled Rover & Turret (11 Bones)',
    nameVi: 'Xe cơ khí / Rover & Tháp pháo (11 xương)',
    description: 'Mechanical rig with chassis root, body suspension, 4 steering/spinning wheels & rotating turret.',
    descriptionVi: 'Khung xương cơ khí gồm khung gầm, giảm xóc thân xe, 4 bánh lái/quay và tháp pháo.',
    defaultSize: 2.40,
    sizeParam: 'length',
    mocapCompatible: false,
    symmetryAxis: 'x',
    ikChains: [],
    buildDefs(size = 2.40) {
      const s = (Number(size) || 2.40) / 2.40;
      return [
        ['ChassisRoot', null, [0, 0.42 * s, 0]],
        ['BodySuspension', 'ChassisRoot', [0, 0.22 * s, 0]],
        ['TurretYaw', 'BodySuspension', [0, 0.56 * s, -0.12 * s]],
        ['BarrelPitch', 'TurretYaw', [0, 0.12 * s, 0.42 * s]],
        ['HatchDoor', 'BodySuspension', [0, 0.48 * s, 0.45 * s]],
        // Front Left & Front Right steering + spinning wheel hubs
        ['WheelSteerFL', 'ChassisRoot', [0.76 * s, -0.06 * s, 0.88 * s]],
        ['WheelSpinFL', 'WheelSteerFL', [0.10 * s, 0, 0]],
        ['WheelSteerFR', 'ChassisRoot', [-0.76 * s, -0.06 * s, 0.88 * s]],
        ['WheelSpinFR', 'WheelSteerFR', [-0.10 * s, 0, 0]],
        // Rear Left & Rear Right spinning wheel hubs
        ['WheelSpinRL', 'ChassisRoot', [0.86 * s, -0.06 * s, -0.86 * s]],
        ['WheelSpinRR', 'ChassisRoot', [-0.86 * s, -0.06 * s, -0.86 * s]],
      ];
    },
  },
});

export function listSkeletonTemplates(category = null) {
  const all = Object.values(SKELETON_TEMPLATES).map((tpl) => {
    const sampleDefs = tpl.buildDefs(tpl.defaultSize);
    return {
      id: tpl.id,
      category: tpl.category,
      name: tpl.name,
      nameVi: tpl.nameVi,
      description: tpl.description,
      descriptionVi: tpl.descriptionVi,
      defaultSize: tpl.defaultSize,
      sizeParam: tpl.sizeParam,
      boneCount: sampleDefs.length,
      mocapCompatible: tpl.mocapCompatible,
      symmetryAxis: tpl.symmetryAxis,
      ikChains: tpl.ikChains,
    };
  });
  return category ? all.filter((t) => t.category === category) : all;
}

export function getSkeletonTemplate(templateId) {
  return SKELETON_TEMPLATES[String(templateId || '').trim()] || null;
}

/**
 * Instantiate a THREE.Group + THREE.Skeleton from any template definition.
 */
export function buildSkeletonFromTemplate(templateId, options = {}) {
  const tpl = getSkeletonTemplate(templateId) || SKELETON_TEMPLATES.humanoid_pro;
  const size = Number(options.size ?? options.height ?? tpl.defaultSize) || tpl.defaultSize;
  const defs = options.customDefs || tpl.buildDefs(size, options);

  const bones = [];
  const boneMap = new Map();
  let rootBone = null;

  for (const [name, parentName, rel] of defs) {
    const bone = new THREE.Bone();
    bone.name = name;
    bone.position.set(rel[0], rel[1], rel[2]);
    if (parentName && boneMap.has(parentName)) {
      boneMap.get(parentName).add(bone);
    } else if (!rootBone) {
      rootBone = bone;
    } else {
      rootBone.add(bone);
    }
    bone.userData.restEuler = bone.rotation.clone();
    bone.userData.restQuat = bone.quaternion.clone();
    bones.push(bone);
    boneMap.set(name, bone);
  }

  const skeleton = new THREE.Skeleton(bones);
  const armatureGroup = new THREE.Group();
  armatureGroup.name = options.name || `${tpl.id.replace(/(^|_)([a-z])/g, (_, _sep, ch) => ch.toUpperCase())}_Armature`;
  if (rootBone) armatureGroup.add(rootBone);
  armatureGroup.userData.skeleton = skeleton;
  armatureGroup.userData.isArmature = true;
  armatureGroup.userData.skeletonTemplate = tpl.id;
  armatureGroup.userData.skeletonCategory = tpl.category;
  armatureGroup.updateMatrixWorld(true);
  skeleton.calculateInverses();

  return {
    template: tpl,
    armatureGroup,
    skeleton,
    bones,
    boneMap,
  };
}

// ---------------------------------------------------------------------------
// Silhouette-Based Automatic Humanoid Joint Fitter (for Custom Uploaded Meshes)
// ---------------------------------------------------------------------------

/**
 * Analyze world-space vertex slices of any static humanoid mesh or group to detect:
 * - Exact height, grounding minY, centerX, centerZ
 * - Crotch split Y and left/right leg column centers
 * - Torso waist / chest widths & neck pinch Y
 * - Arm span & automatic T-Pose vs A-Pose arm angle detection
 * - Facing direction (+Z vs -Z) from foot protrusion
 */
export function analyzeHumanoidMeshSilhouette(meshOrGroup) {
  if (!meshOrGroup) return null;
  meshOrGroup.updateMatrixWorld(true);

  const worldVerts = [];
  const vTmp = new THREE.Vector3();
  const box = new THREE.Box3();

  const meshes = [];
  if (meshOrGroup.isMesh) {
    meshes.push(meshOrGroup);
  } else if (typeof meshOrGroup.traverse === 'function') {
    meshOrGroup.traverse((o) => {
      if (o.isMesh && o.geometry?.attributes?.position) meshes.push(o);
    });
  }

  let totalVerts = 0;
  for (const m of meshes) totalVerts += m.geometry.attributes.position.count;
  if (totalVerts < 8) return null;

  const stride = Math.max(1, Math.floor(totalVerts / 18000));
  for (const m of meshes) {
    const pos = m.geometry.attributes.position;
    const mat = m.matrixWorld;
    for (let i = 0; i < pos.count; i += stride) {
      vTmp.fromBufferAttribute(pos, i).applyMatrix4(mat);
      if (!Number.isFinite(vTmp.x) || !Number.isFinite(vTmp.y) || !Number.isFinite(vTmp.z)) continue;
      box.expandByPoint(vTmp);
      worldVerts.push(vTmp.x, vTmp.y, vTmp.z);
    }
  }

  if (box.isEmpty() || worldVerts.length < 24) return null;

  const minY = box.min.y;
  const maxY = box.max.y;
  const height = Math.max(0.05, maxY - minY);
  const centerX = (box.min.x + box.max.x) * 0.5;
  const centerZ = (box.min.z + box.max.z) * 0.5;
  const spanX = box.max.x - box.min.x;

  // Bin vertices into 40 horizontal Y bands (h in [0, 1])
  const BANDS = 40;
  const bands = Array.from({ length: BANDS }, () => ({
    minX: Infinity, maxX: -Infinity,
    minZ: Infinity, maxZ: -Infinity,
    sumZ: 0, count: 0,
    xs: [],
  }));

  for (let i = 0; i < worldVerts.length; i += 3) {
    const vx = worldVerts[i];
    const vy = worldVerts[i + 1];
    const vz = worldVerts[i + 2];
    const h = THREE.MathUtils.clamp((vy - minY) / height, 0, 0.9999);
    const bi = Math.min(BANDS - 1, Math.floor(h * BANDS));
    const b = bands[bi];
    if (vx < b.minX) b.minX = vx;
    if (vx > b.maxX) b.maxX = vx;
    if (vz < b.minZ) b.minZ = vz;
    if (vz > b.maxZ) b.maxZ = vz;
    b.sumZ += vz;
    b.count++;
    if (b.xs.length < 320) b.xs.push(vx);
  }

  // 1. Detect torso center & half-width around mid-torso (h = 0.58..0.72)
  let torsoHalfW = height * 0.11;
  let torsoZSum = 0;
  let torsoZCount = 0;
  for (let bi = 23; bi <= 28; bi++) {
    const b = bands[bi];
    if (b.count < 4) continue;
    // Use central vertices (within 0.22 * height of centerX) to exclude lowered A-pose arms!
    const coreXs = b.xs.filter((x) => Math.abs(x - centerX) <= height * 0.20);
    if (coreXs.length >= 4) {
      coreXs.sort((a, c) => a - c);
      const p10 = coreXs[Math.floor(coreXs.length * 0.1)];
      const p90 = coreXs[Math.floor(coreXs.length * 0.9)];
      torsoHalfW = Math.max(torsoHalfW, (p90 - p10) * 0.5);
    }
    torsoZSum += b.sumZ;
    torsoZCount += b.count;
  }
  torsoHalfW = THREE.MathUtils.clamp(torsoHalfW, height * 0.08, height * 0.16);
  const torsoZ = torsoZCount > 0 ? torsoZSum / torsoZCount : centerZ;

  // 2. Detect Crotch / Leg Split Height & Left/Right Leg X Center (h in 0.28..0.54)
  let crotchNorm = 0.48;
  let leftLegXSum = 0;
  let leftLegCount = 0;
  let rightLegXSum = 0;
  let rightLegCount = 0;
  const centerGap = height * 0.018;

  for (let bi = 11; bi <= 22; bi++) {
    const b = bands[bi];
    if (b.xs.length < 6) continue;
    let midPts = 0;
    let lSum = 0, lCnt = 0, rSum = 0, rCnt = 0;
    for (const x of b.xs) {
      const dx = x - centerX;
      if (Math.abs(dx) < centerGap) midPts++;
      else if (dx > 0 && dx < torsoHalfW * 1.4) { lSum += x; lCnt++; }
      else if (dx < 0 && -dx < torsoHalfW * 1.4) { rSum += x; rCnt++; }
    }
    if (lCnt >= 2 && rCnt >= 2 && midPts <= Math.max(1, b.xs.length * 0.04)) {
      crotchNorm = (bi + 0.5) / BANDS;
      leftLegXSum += lSum;
      leftLegCount += lCnt;
      rightLegXSum += rSum;
      rightLegCount += rCnt;
    }
  }
  const hipOffsetX = (leftLegCount > 4 && rightLegCount > 4)
    ? THREE.MathUtils.clamp(
      ((leftLegXSum / leftLegCount) - (rightLegXSum / rightLegCount)) * 0.5,
      height * 0.045,
      height * 0.095,
    )
    : height * 0.056;

  // 3. Detect Neck Pinch (minimum width in h in 0.80..0.90)
  let neckNorm = 0.85;
  let minNeckW = Infinity;
  for (let bi = 32; bi <= 36; bi++) {
    const b = bands[bi];
    if (b.count < 4) continue;
    const coreXs = b.xs.filter((x) => Math.abs(x - centerX) <= height * 0.14);
    if (coreXs.length < 4) continue;
    const w = Math.max(...coreXs) - Math.min(...coreXs);
    if (w < minNeckW) {
      minNeckW = w;
      neckNorm = (bi + 0.5) / BANDS;
    }
  }

  // 4. Detect Arm Tips & Rest Pose (T-Pose vs A-Pose)
  const shoulderNorm = THREE.MathUtils.clamp(neckNorm - 0.032, 0.78, 0.85);
  const shoulderY = minY + shoulderNorm * height;
  const shoulderX = THREE.MathUtils.clamp(torsoHalfW * 0.92, height * 0.09, height * 0.14);

  let maxLatAbs = 0;
  let armTipYSum = 0;
  let armTipCount = 0;
  const lateralThreshold = Math.max(torsoHalfW * 1.55, height * 0.21);

  for (let i = 0; i < worldVerts.length; i += 3) {
    const vx = worldVerts[i];
    const vy = worldVerts[i + 1];
    const h = (vy - minY) / height;
    if (h < 0.36 || h > 0.92) continue;
    const absDx = Math.abs(vx - centerX);
    if (absDx > maxLatAbs) maxLatAbs = absDx;
  }

  if (maxLatAbs > lateralThreshold) {
    const tipBandMin = maxLatAbs * 0.86;
    for (let i = 0; i < worldVerts.length; i += 3) {
      const vx = worldVerts[i];
      const vy = worldVerts[i + 1];
      const h = (vy - minY) / height;
      if (h < 0.36 || h > 0.92) continue;
      if (Math.abs(vx - centerX) >= tipBandMin) {
        armTipYSum += vy;
        armTipCount++;
      }
    }
  }

  let armDropDeg = 0;
  let detectedPose = 'T-Pose';
  let wristReach = height * 0.31;

  if (armTipCount >= 4 && maxLatAbs > lateralThreshold) {
    const tipY = armTipYSum / armTipCount;
    const dxArm = Math.max(0.05, maxLatAbs - shoulderX);
    const dyArm = shoulderY - tipY;
    const rawAngle = THREE.MathUtils.radToDeg(Math.atan2(dyArm, dxArm));
    armDropDeg = THREE.MathUtils.clamp(rawAngle, -10, 68);
    wristReach = THREE.MathUtils.clamp(Math.hypot(dxArm, dyArm) * 0.88, height * 0.24, height * 0.42);
    if (armDropDeg >= 16) detectedPose = 'A-Pose';
  } else {
    // Compact silhouette (arms close to body): default subtle A-pose
    armDropDeg = 42;
    detectedPose = 'A-Pose';
  }

  // 5. Foot forward direction check (h < 0.08)
  let footZSum = 0;
  let footCount = 0;
  for (let bi = 0; bi <= 3; bi++) {
    footZSum += bands[bi].sumZ;
    footCount += bands[bi].count;
  }
  const footAvgZ = footCount > 0 ? footZSum / footCount : torsoZ;
  const facingSignZ = (footAvgZ - torsoZ) < -height * 0.015 ? -1 : 1;

  return {
    minY,
    maxY,
    height,
    centerX,
    centerZ: torsoZ,
    spanX,
    crotchY: minY + crotchNorm * height,
    hipY: minY + THREE.MathUtils.clamp(crotchNorm + 0.055, 0.48, 0.59) * height,
    hipOffsetX,
    shoulderY,
    shoulderX,
    neckY: minY + neckNorm * height,
    headY: minY + THREE.MathUtils.clamp(neckNorm + 0.052, 0.86, 0.93) * height,
    armDropDeg: Number(armDropDeg.toFixed(1)),
    wristReach,
    detectedPose,
    facingSignZ,
  };
}

/**
 * Build a humanoid skeleton (Pro 56-bone or Standard 22-bone) automatically fitted
 * to the measured silhouette of an arbitrary uploaded static 3D mesh/character.
 */
export function fitHumanoidSkeletonToMesh(meshOrGroup, options = {}) {
  const fit = analyzeHumanoidMeshSilhouette(meshOrGroup);
  const templateId = options.templateId === 'humanoid_standard' ? 'humanoid_standard' : 'humanoid_pro';
  if (!fit) {
    return {
      ...buildSkeletonFromTemplate(templateId, options),
      silhouette: null,
    };
  }

  const h = fit.height;
  const rad = THREE.MathUtils.degToRad(fit.armDropDeg);
  const cA = Math.cos(rad);
  const sA = Math.sin(rad);

  const hipsY = fit.hipY;
  const upperTorsoSpan = Math.max(0.12 * h, fit.neckY - hipsY);
  const sp1 = upperTorsoSpan * 0.28;
  const sp2 = upperTorsoSpan * 0.30;
  const sp3 = upperTorsoSpan * 0.26;
  const neckRelY = upperTorsoSpan * 0.16;
  const headRelY = Math.max(0.04 * h, fit.headY - fit.neckY);

  const clavX = fit.shoulderX * 0.32;
  const shRelX = fit.shoulderX * 0.68;
  const spine2Y = hipsY + sp1 + sp2 + sp3;
  const clavRelY = THREE.MathUtils.clamp(fit.shoulderY - spine2Y, -0.02 * h, 0.08 * h);

  const upperArmLen = fit.wristReach * 0.51;
  const foreArmLen = fit.wristReach * 0.49;

  const legRootY = Math.max(fit.crotchY + 0.015 * h, hipsY - 0.03 * h);
  const legRelY = legRootY - hipsY;
  const ankleY = fit.minY + 0.052 * h;
  const legSpan = Math.max(0.18 * h, legRootY - ankleY);
  const thighLen = legSpan * 0.51;
  const shinLen = legSpan * 0.49;
  const toeLen = 0.068 * h * fit.facingSignZ;
  const s = h / 1.72;

  const defs = [
    ['Hips', null, [fit.centerX, hipsY, fit.centerZ]],
    ['Spine', 'Hips', [0, sp1, 0]],
    ['Spine1', 'Spine', [0, sp2, 0]],
    ['Spine2', 'Spine1', [0, sp3, 0]],
    ['Neck', 'Spine2', [0, neckRelY, 0]],
    ['Head', 'Neck', [0, headRelY, 0.005 * h * fit.facingSignZ]],
  ];

  const includeFingersAndTwist = templateId === 'humanoid_pro';

  for (const [side, sign] of [['Left', 1], ['Right', -1]]) {
    defs.push([`${side}Shoulder`, 'Spine2', [sign * clavX, clavRelY, 0]]);
    defs.push([`${side}Arm`, `${side}Shoulder`, [sign * shRelX, 0, 0]]);
    if (includeFingersAndTwist) {
      defs.push([`${side}ArmTwist`, `${side}Arm`, [sign * upperArmLen * 0.5 * cA, -upperArmLen * 0.5 * sA, 0]]);
    }
    defs.push([`${side}ForeArm`, `${side}Arm`, [sign * upperArmLen * cA, -upperArmLen * sA, -0.006 * h * fit.facingSignZ]]);
    if (includeFingersAndTwist) {
      defs.push([`${side}ForeArmTwist`, `${side}ForeArm`, [sign * foreArmLen * 0.5 * cA, -foreArmLen * 0.5 * sA, 0.004 * h * fit.facingSignZ]]);
    }
    defs.push([`${side}Hand`, `${side}ForeArm`, [sign * foreArmLen * cA, -foreArmLen * sA, 0.008 * h * fit.facingSignZ]]);

    if (includeFingersAndTwist) {
      const hand = `${side}Hand`;
      const rotVec = (dx, dy, dz) => [
        sign * (dx * cA + dy * sA),
        -dx * sA + dy * cA,
        dz * fit.facingSignZ,
      ];
      defs.push([`${hand}Thumb1`, hand, rotVec(0.022 * s, -0.010 * s, 0.024 * s)]);
      defs.push([`${hand}Thumb2`, `${hand}Thumb1`, rotVec(0.024 * s, -0.007 * s, 0.016 * s)]);
      defs.push([`${hand}Thumb3`, `${hand}Thumb2`, rotVec(0.020 * s, -0.005 * s, 0.012 * s)]);

      const fingerSpecs = [
        ['Index', 0.024 * s, 0.034 * s, 0.022 * s, 0.018 * s],
        ['Middle', 0.008 * s, 0.038 * s, 0.024 * s, 0.019 * s],
        ['Ring', -0.009 * s, 0.034 * s, 0.022 * s, 0.018 * s],
        ['Pinky', -0.025 * s, 0.027 * s, 0.018 * s, 0.015 * s],
      ];
      for (const [fName, zOff, l1, l2, l3] of fingerSpecs) {
        defs.push([`${hand}${fName}1`, hand, rotVec(0.074 * s, 0, zOff)]);
        defs.push([`${hand}${fName}2`, `${hand}${fName}1`, rotVec(l1, 0, 0)]);
        defs.push([`${hand}${fName}3`, `${hand}${fName}2`, rotVec(l2, 0, 0)]);
      }
    }

    defs.push([`${side}UpLeg`, 'Hips', [sign * fit.hipOffsetX, legRelY, 0]]);
    defs.push([`${side}Leg`, `${side}UpLeg`, [0, -thighLen, 0.008 * h * fit.facingSignZ]]);
    defs.push([`${side}Foot`, `${side}Leg`, [0, -shinLen, -0.014 * h * fit.facingSignZ]]);
    defs.push([`${side}ToeBase`, `${side}Foot`, [0, -0.036 * h, toeLen]]);
  }

  const built = buildSkeletonFromTemplate(templateId, {
    ...options,
    size: h,
    customDefs: defs,
    name: options.name || `${meshOrGroup.name || 'Character'}_AutoRig`,
  });

  return {
    ...built,
    silhouette: fit,
  };
}
