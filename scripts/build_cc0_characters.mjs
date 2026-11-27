#!/usr/bin/env node
/**
 * Generate 100% original CC0-1.0 rigged humanoid GLB characters (`models/Mannequin_CC0.glb`
 * and `models/Bot_CC0.glb`) with Mixamo-compatible 22-bone skeletons, clean PBR materials,
 * smooth skinning, and built-in animation clips (`IdleDance` / `Walk` / `TPose`).
 *
 * Usage:
 *   node --import ./tests/three-resolve-hooks.mjs scripts/build_cc0_characters.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

if (typeof globalThis.FileReader === 'undefined') {
  globalThis.FileReader = class NodeFileReader {
    constructor() {
      this.result = null;
      this.onloadend = null;
      this.onload = null;
      this.onerror = null;
    }
    readAsArrayBuffer(blob) {
      blob.arrayBuffer().then(
        (buf) => {
          this.result = buf;
          this.onload?.({ target: this });
          this.onloadend?.({ target: this });
        },
        (err) => this.onerror?.(err),
      );
    }
    readAsDataURL(blob) {
      blob.arrayBuffer().then(
        (buf) => {
          const b64 = Buffer.from(buf).toString('base64');
          this.result = `data:${blob.type || 'application/octet-stream'};base64,${b64}`;
          this.onload?.({ target: this });
          this.onloadend?.({ target: this });
        },
        (err) => this.onerror?.(err),
      );
    }
  };
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MODELS_DIR = path.join(ROOT, 'models');

function makeBone(name, parent, x, y, z) {
  const b = new THREE.Bone();
  b.name = name;
  b.position.set(x, y, z);
  if (parent) parent.add(b);
  return b;
}

/** Build a 22-bone Mixamo-compatible humanoid skeleton standing on Y=0 facing +Z. */
function buildHumanoidSkeleton(scale = 1.0) {
  const s = scale;
  const hips = makeBone('Hips', null, 0, 0.94 * s, 0);
  const spine = makeBone('Spine', hips, 0, 0.10 * s, 0);
  const spine1 = makeBone('Spine1', spine, 0, 0.13 * s, 0);
  const spine2 = makeBone('Spine2', spine1, 0, 0.14 * s, 0);
  const neck = makeBone('Neck', spine2, 0, 0.15 * s, 0);
  const head = makeBone('Head', neck, 0, 0.08 * s, 0);

  const leftShoulder = makeBone('LeftShoulder', spine2, 0.06 * s, 0.11 * s, 0);
  const leftArm = makeBone('LeftArm', leftShoulder, 0.11 * s, 0, 0);
  const leftForeArm = makeBone('LeftForeArm', leftArm, 0.25 * s, 0, 0);
  const leftHand = makeBone('LeftHand', leftForeArm, 0.23 * s, 0, 0);

  const rightShoulder = makeBone('RightShoulder', spine2, -0.06 * s, 0.11 * s, 0);
  const rightArm = makeBone('RightArm', rightShoulder, -0.11 * s, 0, 0);
  const rightForeArm = makeBone('RightForeArm', rightArm, -0.25 * s, 0, 0);
  const rightHand = makeBone('RightHand', rightForeArm, -0.23 * s, 0, 0);

  const leftUpLeg = makeBone('LeftUpLeg', hips, 0.095 * s, -0.04 * s, 0);
  const leftLeg = makeBone('LeftLeg', leftUpLeg, 0, -0.42 * s, 0);
  const leftFoot = makeBone('LeftFoot', leftLeg, 0, -0.41 * s, 0);
  const leftToeBase = makeBone('LeftToeBase', leftFoot, 0, -0.05 * s, 0.11 * s);

  const rightUpLeg = makeBone('RightUpLeg', hips, -0.095 * s, -0.04 * s, 0);
  const rightLeg = makeBone('RightLeg', rightUpLeg, 0, -0.42 * s, 0);
  const rightFoot = makeBone('RightFoot', rightLeg, 0, -0.41 * s, 0);
  const rightToeBase = makeBone('RightToeBase', rightFoot, 0, -0.05 * s, 0.11 * s);

  hips.updateMatrixWorld(true);
  const bones = [
    hips, spine, spine1, spine2, neck, head,
    leftShoulder, leftArm, leftForeArm, leftHand,
    rightShoulder, rightArm, rightForeArm, rightHand,
    leftUpLeg, leftLeg, leftFoot, leftToeBase,
    rightUpLeg, rightLeg, rightFoot, rightToeBase,
  ];
  const indexByName = Object.fromEntries(bones.map((b, i) => [b.name, i]));
  return { rootBone: hips, bones, indexByName };
}

function skinSinglePart(geometry, boneA, boneB = boneA, blend = 0, axis = 'y', minA = 0, maxA = 1) {
  const nonIdx = geometry.index ? geometry.toNonIndexed() : geometry.clone();
  nonIdx.computeVertexNormals();
  if (!nonIdx.attributes.uv) {
    const count = nonIdx.attributes.position.count;
    nonIdx.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(count * 2), 2));
  }
  const pos = nonIdx.attributes.position;
  const n = pos.count;
  const skinIdx = new Uint16Array(n * 4);
  const skinWt = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    let wB = 0;
    if (blend > 0 && boneB !== boneA) {
      const coord = axis === 'x' ? pos.getX(i) : (axis === 'z' ? pos.getZ(i) : pos.getY(i));
      const t = THREE.MathUtils.clamp((coord - minA) / Math.max(1e-5, maxA - minA), 0, 1);
      wB = t * blend;
    }
    skinIdx[i * 4 + 0] = boneA;
    skinIdx[i * 4 + 1] = boneB;
    skinWt[i * 4 + 0] = 1 - wB;
    skinWt[i * 4 + 1] = wB;
  }
  nonIdx.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(skinIdx, 4));
  nonIdx.setAttribute('skinWeight', new THREE.Float32BufferAttribute(skinWt, 4));
  return nonIdx;
}

function worldPosOf(bone) {
  const v = new THREE.Vector3();
  bone.getWorldPosition(v);
  return v;
}

function buildPartBetween(aBone, bBone, radiusTop, radiusBottom, radialSegs = 12) {
  const a = worldPosOf(aBone);
  const b = worldPosOf(bBone);
  const dir = new THREE.Vector3().subVectors(b, a);
  const len = Math.max(0.02, dir.length());
  const mid = new THREE.Vector3().addVectors(a, b).multiplyScalar(0.5);
  const geo = new THREE.CylinderGeometry(radiusTop, radiusBottom, len, radialSegs, 3);
  const quat = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().normalize());
  const mat = new THREE.Matrix4().compose(mid, quat, new THREE.Vector3(1, 1, 1));
  geo.applyMatrix4(mat);
  return geo;
}

function createCharacterMesh({ name, scale, style }) {
  const { rootBone, bones, indexByName } = buildHumanoidSkeleton(scale);
  const s = scale;
  const partsByMat = [[], [], []]; // 0: primary body, 1: joint/accent, 2: visor/detail

  const addPart = (matGroup, geo, boneNameA, boneNameB = boneNameA, blend = 0, axis = 'y', minA = 0, maxA = 1) => {
    const skinned = skinSinglePart(geo, indexByName[boneNameA], indexByName[boneNameB], blend, axis, minA, maxA);
    partsByMat[matGroup].push(skinned);
  };

  // Pelvis / Hips
  const hipsPos = worldPosOf(bones[indexByName.Hips]);
  const pelvis = style === 'bot'
    ? new THREE.BoxGeometry(0.24 * s, 0.13 * s, 0.17 * s)
    : new THREE.CapsuleGeometry(0.11 * s, 0.06 * s, 6, 12);
  if (style === 'bot') pelvis.translate(hipsPos.x, hipsPos.y, hipsPos.z);
  else {
    pelvis.rotateZ(Math.PI / 2);
    pelvis.scale(1.15, 0.9, 0.85);
    pelvis.translate(hipsPos.x, hipsPos.y, hipsPos.z);
  }
  addPart(1, pelvis, 'Hips');

  // Torso (Spine -> Spine2)
  const spPos = worldPosOf(bones[indexByName.Spine]);
  const sp2Pos = worldPosOf(bones[indexByName.Spine2]);
  const waist = new THREE.CylinderGeometry(0.125 * s, 0.105 * s, 0.22 * s, 14);
  waist.scale(1.18, 1, 0.82);
  waist.translate(0, (spPos.y + sp2Pos.y) * 0.48, 0);
  addPart(0, waist, 'Spine', 'Spine1', 0.5, 'y', spPos.y, sp2Pos.y);

  const chest = style === 'bot'
    ? new THREE.BoxGeometry(0.30 * s, 0.21 * s, 0.19 * s)
    : new THREE.CapsuleGeometry(0.13 * s, 0.12 * s, 6, 14);
  if (style === 'bot') {
    chest.translate(0, sp2Pos.y + 0.04 * s, 0);
  } else {
    chest.rotateZ(Math.PI / 2);
    chest.scale(1.02, 1.15, 0.78);
    chest.translate(0, sp2Pos.y + 0.03 * s, 0);
  }
  addPart(0, chest, 'Spine2');

  // Chest core / emblem (+Z front marker)
  const badge = new THREE.BoxGeometry(0.08 * s, 0.06 * s, 0.03 * s);
  badge.translate(0, sp2Pos.y + 0.04 * s, 0.105 * s);
  addPart(2, badge, 'Spine2');

  // Neck + Head
  addPart(1, buildPartBetween(bones[indexByName.Neck], bones[indexByName.Head], 0.045 * s, 0.052 * s, 10), 'Neck');
  const headPos = worldPosOf(bones[indexByName.Head]);
  const headGeo = style === 'bot'
    ? new THREE.BoxGeometry(0.16 * s, 0.19 * s, 0.17 * s)
    : new THREE.SphereGeometry(0.098 * s, 16, 12);
  if (style !== 'bot') headGeo.scale(0.88, 1.12, 0.96);
  headGeo.translate(headPos.x, headPos.y + 0.08 * s, headPos.z);
  addPart(0, headGeo, 'Head');

  // Visor / eyes on +Z so front orientation is unmistakable
  const visor = new THREE.BoxGeometry(0.11 * s, 0.038 * s, 0.03 * s);
  visor.translate(headPos.x, headPos.y + 0.09 * s, headPos.z + 0.088 * s);
  addPart(2, visor, 'Head');

  // Arms
  for (const side of ['Left', 'Right']) {
    const sh = bones[indexByName[`${side}Shoulder`]];
    const arm = bones[indexByName[`${side}Arm`]];
    const fore = bones[indexByName[`${side}ForeArm`]];
    const hand = bones[indexByName[`${side}Hand`]];
    const sign = side === 'Left' ? 1 : -1;

    const shJoint = new THREE.SphereGeometry(0.058 * s, 10, 8);
    const armPos = worldPosOf(arm);
    shJoint.translate(armPos.x, armPos.y, armPos.z);
    addPart(1, shJoint, `${side}Shoulder`);

    addPart(0, buildPartBetween(arm, fore, 0.045 * s, 0.052 * s, 10), `${side}Arm`);
    const elJoint = new THREE.SphereGeometry(0.044 * s, 10, 8);
    const forePos = worldPosOf(fore);
    elJoint.translate(forePos.x, forePos.y, forePos.z);
    addPart(1, elJoint, `${side}ForeArm`);

    addPart(0, buildPartBetween(fore, hand, 0.036 * s, 0.043 * s, 10), `${side}ForeArm`);
    const handGeo = new THREE.BoxGeometry(0.09 * s, 0.045 * s, 0.075 * s);
    const handPos = worldPosOf(hand);
    handGeo.translate(handPos.x + sign * 0.04 * s, handPos.y, handPos.z);
    addPart(1, handGeo, `${side}Hand`);

    // Shoulder pads for Bot style
    if (style === 'bot') {
      const pad = new THREE.BoxGeometry(0.10 * s, 0.08 * s, 0.12 * s);
      pad.translate(armPos.x, armPos.y + 0.03 * s, armPos.z);
      addPart(2, pad, `${side}Shoulder`);
    }
  }

  // Legs + Feet
  for (const side of ['Left', 'Right']) {
    const up = bones[indexByName[`${side}UpLeg`]];
    const leg = bones[indexByName[`${side}Leg`]];
    const foot = bones[indexByName[`${side}Foot`]];
    const toe = bones[indexByName[`${side}ToeBase`]];

    const hipJ = new THREE.SphereGeometry(0.062 * s, 10, 8);
    const upPos = worldPosOf(up);
    hipJ.translate(upPos.x, upPos.y, upPos.z);
    addPart(1, hipJ, `${side}UpLeg`);

    addPart(0, buildPartBetween(up, leg, 0.054 * s, 0.072 * s, 12), `${side}UpLeg`);
    const kneeJ = new THREE.SphereGeometry(0.052 * s, 10, 8);
    const legPos = worldPosOf(leg);
    kneeJ.translate(legPos.x, legPos.y, legPos.z);
    addPart(1, kneeJ, `${side}Leg`);

    addPart(0, buildPartBetween(leg, foot, 0.042 * s, 0.054 * s, 12), `${side}Leg`);

    const footPos = worldPosOf(foot);
    const toePos = worldPosOf(toe);
    const footGeo = new THREE.BoxGeometry(0.095 * s, 0.06 * s, 0.14 * s);
    footGeo.translate(footPos.x, Math.max(0.03 * s, footPos.y - 0.025 * s), footPos.z + 0.04 * s);
    addPart(1, footGeo, `${side}Foot`);

    const toeGeo = new THREE.BoxGeometry(0.088 * s, 0.042 * s, 0.09 * s);
    toeGeo.translate(toePos.x, 0.021 * s, toePos.z + 0.025 * s);
    addPart(2, toeGeo, `${side}ToeBase`);
  }

  // Combine all parts with vertex colors into ONE single-draw-call SkinnedMesh
  const palette = style === 'bot'
    ? [new THREE.Color(0x3b6e8c), new THREE.Color(0x262b33), new THREE.Color(0xff8c24)]
    : [new THREE.Color(0xd99b82), new THREE.Color(0x454d59), new THREE.Color(0x2fa89c)];
  const coloredGeos = [];
  partsByMat.forEach((list, matIdx) => {
    const c = palette[matIdx];
    for (const geo of list) {
      const count = geo.attributes.position.count;
      const colors = new Float32Array(count * 3);
      for (let i = 0; i < count; i++) {
        colors[i * 3 + 0] = c.r;
        colors[i * 3 + 1] = c.g;
        colors[i * 3 + 2] = c.b;
      }
      geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
      coloredGeos.push(geo);
    }
  });
  const combined = mergeGeometries(coloredGeos, false);
  combined.computeBoundingBox();
  combined.computeBoundingSphere();

  const material = new THREE.MeshStandardMaterial({
    name: style === 'bot' ? 'Bot_PBR' : 'Mannequin_PBR',
    vertexColors: true,
    roughness: style === 'bot' ? 0.36 : 0.48,
    metalness: style === 'bot' ? 0.52 : 0.12,
  });

  const mesh = new THREE.SkinnedMesh(combined, material);
  mesh.name = `${name}_Mesh`;
  mesh.castShadow = true;
  mesh.receiveShadow = true;

  const skeleton = new THREE.Skeleton(bones);
  mesh.add(rootBone);
  mesh.bind(skeleton);

  const root = new THREE.Group();
  root.name = name;
  root.add(mesh);
  return { root, mesh, bones, indexByName };
}

function makeClip(name, duration, keyframesByBone) {
  const tracks = [];
  for (const [boneName, spec] of Object.entries(keyframesByBone)) {
    if (spec.pos) {
      tracks.push(new THREE.VectorKeyframeTrack(`${boneName}.position`, spec.times, spec.pos));
    }
    if (spec.euler) {
      const qValues = [];
      const q = new THREE.Quaternion();
      const e = new THREE.Euler();
      for (let i = 0; i < spec.euler.length; i += 3) {
        e.set(spec.euler[i], spec.euler[i + 1], spec.euler[i + 2], 'XYZ');
        q.setFromEuler(e);
        qValues.push(q.x, q.y, q.z, q.w);
      }
      tracks.push(new THREE.QuaternionKeyframeTrack(`${boneName}.quaternion`, spec.times, qValues));
    }
  }
  return new THREE.AnimationClip(name, duration, tracks);
}

function buildAnimations(bones, indexByName) {
  const times = [0, 0.4, 0.8, 1.2, 1.6];
  const hipsY = bones[indexByName.Hips].position.y;
  const idleDance = makeClip('IdleDance', 1.6, {
    Hips: {
      times,
      pos: [0, hipsY, 0, 0, hipsY - 0.03, 0, 0, hipsY, 0, 0, hipsY - 0.03, 0, 0, hipsY, 0],
      euler: [0, 0, 0, 0, 0.14, 0.04, 0, 0, 0, 0, -0.14, -0.04, 0, 0, 0],
    },
    Spine1: { times, euler: [0, 0, 0, 0.04, -0.08, 0, 0, 0, 0, 0.04, 0.08, 0, 0, 0, 0] },
    LeftArm: { times, euler: [0, 0, -1.15, 0.25, 0, -0.95, 0, 0, -1.15, -0.2, 0, -1.05, 0, 0, -1.15] },
    RightArm: { times, euler: [0, 0, 1.15, -0.2, 0, 1.05, 0, 0, 1.15, 0.25, 0, 0.95, 0, 0, 1.15] },
    LeftForeArm: { times, euler: [0, 0.3, 0, 0, 0.75, 0, 0, 0.3, 0, 0, 0.55, 0, 0, 0.3, 0] },
    RightForeArm: { times, euler: [0, -0.3, 0, 0, -0.55, 0, 0, -0.3, 0, 0, -0.75, 0, 0, -0.3, 0] },
    LeftUpLeg: { times, euler: [0, 0, 0, -0.18, 0, 0, 0, 0, 0, 0.12, 0, 0, 0, 0, 0] },
    LeftLeg: { times, euler: [0, 0, 0, 0.32, 0, 0, 0, 0, 0, 0.05, 0, 0, 0, 0, 0] },
    RightUpLeg: { times, euler: [0, 0, 0, 0.12, 0, 0, 0, 0, 0, -0.18, 0, 0, 0, 0, 0] },
    RightLeg: { times, euler: [0, 0, 0, 0.05, 0, 0, 0, 0, 0, 0.32, 0, 0, 0, 0, 0] },
  });

  const walkClip = makeClip('Walk', 1.6, {
    Hips: {
      times,
      pos: [0, hipsY, 0, 0, hipsY + 0.025, 0, 0, hipsY, 0, 0, hipsY + 0.025, 0, 0, hipsY, 0],
      euler: [0, 0.06, 0, 0, -0.06, 0, 0, 0.06, 0, 0, -0.06, 0, 0, 0.06, 0],
    },
    LeftArm: { times, euler: [0, 0, -1.25, 0.32, 0, -1.25, 0, 0, -1.25, -0.32, 0, -1.25, 0, 0, -1.25] },
    RightArm: { times, euler: [0, 0, 1.25, -0.32, 0, 1.25, 0, 0, 1.25, 0.32, 0, 1.25, 0, 0, 1.25] },
    LeftUpLeg: { times, euler: [-0.35, 0, 0, 0.35, 0, 0, -0.35, 0, 0, 0.35, 0, 0, -0.35, 0, 0] },
    LeftLeg: { times, euler: [0.15, 0, 0, 0.45, 0, 0, 0.15, 0, 0, 0.45, 0, 0, 0.15, 0, 0] },
    RightUpLeg: { times, euler: [0.35, 0, 0, -0.35, 0, 0, 0.35, 0, 0, -0.35, 0, 0, 0.35, 0, 0] },
    RightLeg: { times, euler: [0.45, 0, 0, 0.15, 0, 0, 0.45, 0, 0, 0.15, 0, 0, 0.45, 0, 0] },
  });

  const tpose = makeClip('TPose', 0.1, {
    Hips: { times: [0, 0.1], pos: [0, hipsY, 0, 0, hipsY, 0], euler: [0, 0, 0, 0, 0, 0] },
  });

  return { idleDance, walkClip, tpose };
}

async function exportGlbWithLicense(root, animations, outFile, title) {
  const exporter = new GLTFExporter();
  const gltfBuf = await new Promise((resolve, reject) => {
    exporter.parse(
      root,
      (res) => resolve(res),
      (err) => reject(err),
      { binary: true, animations },
    );
  });

  // Patch GLTF JSON asset.copyright + extras cleanly in the GLB binary chunk
  const u8 = new Uint8Array(gltfBuf);
  const view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const jsonLen = view.getUint32(12, true);
  const jsonText = Buffer.from(u8.subarray(20, 20 + jsonLen)).toString('utf8');
  const gltfJson = JSON.parse(jsonText);
  gltfJson.asset = gltfJson.asset || { version: '2.0' };
  gltfJson.asset.copyright = 'CC0-1.0 (Public Domain Dedication) — Web Blender Studio';
  gltfJson.asset.extras = {
    title,
    author: 'Web Blender Studio',
    license: 'CC0-1.0',
  };
  const nextJsonBytes = Buffer.from(JSON.stringify(gltfJson), 'utf8');
  const padLen = (4 - (nextJsonBytes.length % 4)) % 4;
  const paddedJson = Buffer.concat([nextJsonBytes, Buffer.alloc(padLen, 0x20)]);
  const restBin = Buffer.from(u8.subarray(20 + jsonLen));
  const totalLen = 12 + 8 + paddedJson.length + restBin.length;
  const out = Buffer.alloc(totalLen);
  out.writeUInt32LE(0x46546c67, 0);
  out.writeUInt32LE(2, 4);
  out.writeUInt32LE(totalLen, 8);
  out.writeUInt32LE(paddedJson.length, 12);
  out.writeUInt32LE(0x4e4f534a, 16);
  paddedJson.copy(out, 20);
  restBin.copy(out, 20 + paddedJson.length);

  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, out);
  return out;
}

async function verifyGlb(filePath, expectedClip) {
  const loader = new GLTFLoader();
  const buf = fs.readFileSync(filePath);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const gltf = await new Promise((resolve, reject) => loader.parse(ab, '', resolve, reject));
  let boneCount = 0;
  let skinnedCount = 0;
  gltf.scene.traverse((o) => {
    if (o.isBone) boneCount += 1;
    if (o.isSkinnedMesh) skinnedCount += 1;
  });
  const clipNames = (gltf.animations || []).map((a) => a.name);
  if (boneCount !== 22 || skinnedCount !== 1 || !clipNames.includes(expectedClip)) {
    throw new Error(`Verification failed for ${filePath}: bones=${boneCount}, skinned=${skinnedCount}, clips=${clipNames.join(',')}`);
  }
  console.log(`ok   ${path.relative(ROOT, filePath)} · ${(buf.length / 1024).toFixed(1)} KB · ${boneCount} bones · clips=[${clipNames.join(', ')}]`);
}

async function main() {
  const mannequin = createCharacterMesh({ name: 'Mannequin_CC0', scale: 1.0, style: 'mannequin' });
  const mAnims = buildAnimations(mannequin.bones, mannequin.indexByName);
  const mannequinOut = path.join(MODELS_DIR, 'Mannequin_CC0.glb');
  await exportGlbWithLicense(mannequin.root, [mAnims.idleDance, mAnims.tpose], mannequinOut, 'Mannequin CC0');
  await verifyGlb(mannequinOut, 'IdleDance');

  const bot = createCharacterMesh({ name: 'Bot_CC0', scale: 1.08, style: 'bot' });
  const bAnims = buildAnimations(bot.bones, bot.indexByName);
  const botOut = path.join(MODELS_DIR, 'Bot_CC0.glb');
  await exportGlbWithLicense(bot.root, [bAnims.walkClip, bAnims.tpose], botOut, 'Bot CC0');
  await verifyGlb(botOut, 'Walk');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
