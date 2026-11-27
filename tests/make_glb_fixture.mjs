/**
 * Sinh file .glb mẫu (nhân vật 20 xương + clip chuyển động rõ rệt) để kiểm tra
 * import bằng engine ngoài (Godot). Dùng CHÍNH `StudioExporter.exportGLTF`.
 * File: tests/make_glb_fixture.mjs
 *
 * Chạy: node --import ./tests/three-resolve-hooks.mjs tests/make_glb_fixture.mjs /tmp/out.glb
 */
import fs from 'node:fs';
import path from 'node:path';
import * as THREE from 'three';
import { StudioExporter } from '../js/exporters/export-import.js';

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
  };
}

const FPS = 30;
const FRAMES = 61; // 2 giây
const DURATION = (FRAMES - 1) / FPS;

const BONES = [
  ['Hips', null], ['Spine', 'Hips'], ['Spine1', 'Spine'], ['Spine2', 'Spine1'],
  ['Neck', 'Spine2'], ['Head', 'Neck'],
  ['LeftShoulder', 'Spine2'], ['LeftArm', 'LeftShoulder'], ['LeftForeArm', 'LeftArm'], ['LeftHand', 'LeftForeArm'],
  ['RightShoulder', 'Spine2'], ['RightArm', 'RightShoulder'], ['RightForeArm', 'RightArm'], ['RightHand', 'RightForeArm'],
  ['LeftUpLeg', 'Hips'], ['LeftLeg', 'LeftUpLeg'], ['LeftFoot', 'LeftLeg'],
  ['RightUpLeg', 'Hips'], ['RightLeg', 'RightUpLeg'], ['RightFoot', 'RightLeg'],
];

// Biên độ xoay quanh trục X cho từng xương (radian) — đủ lớn để Godot không
// tối ưu hoá mất track (importer của Godot bỏ track hằng số).
const SWING = {
  Spine: 0.25, Spine1: 0.2, Spine2: 0.2, Neck: 0.15, Head: 0.3,
  LeftShoulder: 0.2, LeftArm: 1.05, LeftForeArm: 0.7, LeftHand: 0.35,
  RightShoulder: 0.2, RightArm: 1.05, RightForeArm: 0.7, RightHand: 0.35,
  LeftUpLeg: 0.8, LeftLeg: 0.9, LeftFoot: 0.45,
  RightUpLeg: 0.8, RightLeg: 0.9, RightFoot: 0.45,
};

function buildCharacter() {
  const root = new THREE.Group();
  root.name = 'FixtureCharacter';
  const bones = new Map();
  for (const [name, parent] of BONES) {
    const bone = new THREE.Bone();
    bone.name = name;
    bone.position.set(0, name === 'Hips' ? 0.95 : 0.12, 0);
    const p = parent ? bones.get(parent) : null;
    if (p) p.add(bone); else root.add(bone);
    bones.set(name, bone);
  }
  const ordered = [...bones.values()];
  const skeleton = new THREE.Skeleton(ordered);

  const geometry = new THREE.CapsuleGeometry(0.22, 1.4, 4, 8);
  const position = geometry.attributes.position;
  const skinIndex = [];
  const skinWeight = [];
  for (let i = 0; i < position.count; i++) {
    const t = THREE.MathUtils.clamp((position.getY(i) + 0.9) / 1.8, 0, 1);
    const index = Math.min(ordered.length - 1, Math.floor(t * (ordered.length - 1)));
    skinIndex.push(index, 0, 0, 0);
    skinWeight.push(1, 0, 0, 0);
  }
  geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(skinIndex, 4));
  geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(skinWeight, 4));

  const mesh = new THREE.SkinnedMesh(geometry, new THREE.MeshStandardMaterial({ color: 0x55aacc }));
  mesh.name = 'Body';
  mesh.add(ordered[0]);
  mesh.bind(skeleton);
  root.add(mesh);
  return { root, bones };
}

function buildClip(bones) {
  const times = Array.from({ length: FRAMES }, (_, i) => i / FPS);
  const tracks = [];
  for (const [name, bone] of bones) {
    if (name === 'Hips') continue;
    const amp = SWING[name] ?? 0.15;
    const values = [];
    for (let i = 0; i < FRAMES; i++) {
      const phase = Math.sin((i / (FRAMES - 1)) * Math.PI * 2);
      const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), amp * phase);
      values.push(q.x, q.y, q.z, q.w);
    }
    tracks.push(new THREE.QuaternionKeyframeTrack(`${bone.name}.quaternion`, times, values));
  }

  const hipX = [];
  for (let i = 0; i < FRAMES; i++) {
    const t = i / (FRAMES - 1);
    hipX.push(0.6 * t, 0.95 + 0.08 * Math.sin(t * Math.PI * 2), 0);
  }
  tracks.push(new THREE.VectorKeyframeTrack('Hips.position', times, hipX));

  return new THREE.AnimationClip('Mocap_Fixture_Take', DURATION, tracks);
}

const outPath = process.argv[2] || path.join(process.cwd(), 'glb-fixture.glb');
const { root, bones } = buildCharacter();
const clip = buildClip(bones);

const exporter = new StudioExporter();
exporter.showToast = () => {};
const res = await exporter.exportGLTF(root, {
  binary: true,
  download: false,
  animations: [clip],
  embedImages: true,
  onlyVisible: true,
  filename: 'glb-fixture.glb',
});

fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
fs.writeFileSync(outPath, Buffer.from(res.buffer));
console.log(`fixture: ${outPath} (${(res.blob.size / 1024).toFixed(1)} KB) · ${clip.tracks.length} track · ${DURATION.toFixed(3)}s`);
