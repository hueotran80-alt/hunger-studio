/**
 * Unit & integration verification for:
 *  - Multi-asset skeleton templates (8 archetypes: human, animal, creature, vehicle)
 *  - Vertex silhouette T-Pose / A-Pose detection & automatic humanoid joint fitting
 *  - Multi-mesh & single-mesh Auto-Rig + Bone Heat weight quality validation
 *  - Rig Diagnostics & expanded bone mapping (Mixamo, VRM, UE5, Rigify, CC4, Daz3D, Studio Pro)
 *  - Studio-grade CC0 GLB assets (models/Mannequin_CC0.glb & models/Bot_CC0.glb)
 *
 * Run:
 *   node --import ./tests/three-resolve-hooks.mjs tests/test_skeleton_templates_and_rig_pro.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import {
  listSkeletonTemplates,
  buildSkeletonFromTemplate,
  analyzeHumanoidMeshSilhouette,
  fitHumanoidSkeletonToMesh,
} from '../js/animation/skeleton-templates.js';
import { validateSkinWeights } from '../js/animation/bone-heat.js';
import { RigSystem } from '../js/animation/rig-system.js';
import { MocapRetargeter } from '../js/animation/mocap-retargeter.js';
import { t, setLang } from '../js/core/i18n.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

// Helper: construct a synthetic humanoid multi-mesh Group in either T-Pose or A-Pose
function makeSyntheticHumanoidGroup(pose = 't-pose') {
  const grp = new THREE.Group();
  grp.name = `Synth_${pose}`;
  const mat = new THREE.MeshStandardMaterial();

  const addPart = (geo, x, y, z, rz = 0) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.rotation.z = rz;
    grp.add(m);
    return m;
  };

  // Torso + Head
  addPart(new THREE.CylinderGeometry(0.14, 0.12, 0.52, 12, 6), 0, 1.18, 0);
  addPart(new THREE.SphereGeometry(0.11, 12, 10), 0, 1.62, 0);

  // Legs (two separate columns below crotch ~0.85m, feet grounded at Y = 0)
  addPart(new THREE.CylinderGeometry(0.065, 0.042, 0.85, 10, 6), 0.10, 0.425, 0);
  addPart(new THREE.CylinderGeometry(0.065, 0.042, 0.85, 10, 6), -0.10, 0.425, 0);
  // Feet protruding toward +Z
  addPart(new THREE.BoxGeometry(0.08, 0.05, 0.22), 0.10, 0.025, 0.06);
  addPart(new THREE.BoxGeometry(0.08, 0.05, 0.22), -0.10, 0.025, 0.06);

  // Arms: horizontal for T-pose, angled 38 deg down for A-pose
  const dropRad = pose === 'a-pose' ? THREE.MathUtils.degToRad(38) : 0;
  const armLen = 0.58;
  const shX = 0.18;
  const shY = 1.42;
  const cx = shX + Math.cos(dropRad) * (armLen * 0.5);
  const cy = shY - Math.sin(dropRad) * (armLen * 0.5);
  addPart(new THREE.CylinderGeometry(0.045, 0.032, armLen, 10, 6), cx, cy, 0, Math.PI / 2 - dropRad);
  addPart(new THREE.CylinderGeometry(0.045, 0.032, armLen, 10, 6), -cx, cy, 0, -(Math.PI / 2 - dropRad));

  grp.updateMatrixWorld(true);
  return grp;
}

function makeNamedSkeleton(defs) {
  const root = new THREE.Group();
  root.name = 'RigSample';
  const map = new Map();
  for (const [name, parent, pos] of defs) {
    const b = new THREE.Bone();
    b.name = name;
    if (pos) b.position.set(pos[0], pos[1], pos[2]);
    else b.position.set(0, 0.14, 0);
    if (parent && map.has(parent)) map.get(parent).add(b);
    else root.add(b);
    map.set(name, b);
  }
  root.updateMatrixWorld(true);
  return root;
}

function parseGlbFile(relPath) {
  const abs = path.join(ROOT, relPath);
  const buf = fs.readFileSync(abs);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const loader = new GLTFLoader();
  return new Promise((resolve, reject) => {
    loader.parse(ab, '', (gltf) => resolve({ gltf, bytes: buf.byteLength }), reject);
  });
}

// ---------------------------------------------------------------------------
// 1. Multi-Asset Skeleton Templates (8 Archetypes)
// ---------------------------------------------------------------------------
await test('listSkeletonTemplates exposes 8 multi-asset archetypes across human/animal/creature/mechanical', () => {
  const list = listSkeletonTemplates();
  const ids = list.map((x) => x.id);
  for (const req of ['humanoid_standard', 'humanoid_pro', 'quadruped', 'bird', 'fish', 'serpent', 'arachnid', 'vehicle']) {
    assert(ids.includes(req), `Missing skeleton template: ${req}`);
  }
  assert(list.every((tItem) => tItem.boneCount >= 10 && tItem.name && tItem.nameVi), 'Every template needs EN/VI names and >=10 bones');
});

await test('buildSkeletonFromTemplate builds valid hierarchies & inverses for all 8 templates', () => {
  for (const meta of listSkeletonTemplates()) {
    const res = buildSkeletonFromTemplate(meta.id);
    assert(res.bones.length === meta.boneCount, `${meta.id}: expected ${meta.boneCount} bones, got ${res.bones.length}`);
    assert(res.skeleton.bones.length === meta.boneCount, `${meta.id}: skeleton length mismatch`);
    assert(res.armatureGroup.userData.skeletonTemplate === meta.id, `${meta.id}: missing metadata tag`);
    for (const b of res.bones) {
      assert(Number.isFinite(b.position.x) && Number.isFinite(b.position.y) && Number.isFinite(b.position.z), `${meta.id}:${b.name} non-finite pos`);
    }
  }
  const aPose = buildSkeletonFromTemplate('humanoid_pro', { pose: 'a-pose' });
  const lFore = aPose.boneMap.get('LeftForeArm');
  assert(lFore.position.y < -0.1, `Expected A-pose LeftForeArm drop < -0.1, got ${lFore.position.y}`);

  const quad = buildSkeletonFromTemplate('quadruped');
  assert(quad.boneMap.get('BackLeftShin').position.z > 0, 'Quadruped Stifle (BackLeftShin) must angle forward (+Z)');
  assert(quad.boneMap.get('BackLeftHock').position.z < 0, 'Quadruped Hock (BackLeftHock) must angle backward (-Z)');
  assert(quad.boneMap.get('FrontLeftForeArm').position.z < 0, 'Quadruped Elbow (FrontLeftForeArm) must sit behind Shoulder (-Z)');
});

// ---------------------------------------------------------------------------
// 2. Silhouette Analysis & Auto-Fitting (T-Pose vs A-Pose)
// ---------------------------------------------------------------------------
await test('analyzeHumanoidMeshSilhouette accurately distinguishes T-Pose vs A-Pose and measures height/crotch', () => {
  const tGrp = makeSyntheticHumanoidGroup('t-pose');
  const tFit = analyzeHumanoidMeshSilhouette(tGrp);
  assert(tFit && Math.abs(tFit.height - 1.73) < 0.08, `T-pose height mismatch: ${tFit?.height}`);
  assert(tFit.detectedPose === 'T-Pose', `Expected T-Pose, got ${tFit.detectedPose} (drop=${tFit.armDropDeg})`);
  assert(tFit.facingSignZ === 1, `Expected +Z facing, got ${tFit.facingSignZ}`);

  const aGrp = makeSyntheticHumanoidGroup('a-pose');
  const aFit = analyzeHumanoidMeshSilhouette(aGrp);
  assert(aFit.detectedPose === 'A-Pose', `Expected A-Pose, got ${aFit.detectedPose} (drop=${aFit.armDropDeg})`);
  assert(aFit.armDropDeg > 18 && aFit.armDropDeg < 58, `Unexpected A-pose drop angle: ${aFit.armDropDeg}`);

  const fitted = fitHumanoidSkeletonToMesh(aGrp, { templateId: 'humanoid_pro' });
  assert(fitted.bones.length === 56, `Expected 56 fitted bones, got ${fitted.bones.length}`);
  assert(fitted.boneMap.get('LeftForeArm').position.y < -0.05, 'Fitted A-pose arm should slope downward');
});

// ---------------------------------------------------------------------------
// 3. Auto-Rig Character (Multi-Mesh Group + Single Mesh + Weight Validation)
// ---------------------------------------------------------------------------
await test('RigSystem.autoRigCharacter binds multi-mesh humanoid Group with valid Bone Heat weights', () => {
  const scene = new THREE.Scene();
  const rig = new RigSystem(scene, THREE);
  const grp = makeSyntheticHumanoidGroup('t-pose');
  scene.add(grp);

  const res = rig.autoRigCharacter(grp, { templateId: 'humanoid_pro', mode: 'heat', showVisualizer: false });
  assert(res && res.character === grp, 'autoRigCharacter failed on Group');
  assert(res.quality.boneCount === 56, `Expected 56 bones, got ${res.quality.boneCount}`);
  assert(res.quality.valid === true, `Invalid skin weights: ${JSON.stringify(res.quality)}`);
  assert(res.quality.unboundVertices === 0 && res.quality.nanVertices === 0, 'Unbound or NaN vertices detected');
  assert(res.skinnedMeshes.length >= 6, `Expected >=6 skinned meshes, got ${res.skinnedMeshes.length}`);

  const diag = MocapRetargeter.diagnoseRig(grp);
  assert(diag.score >= 90 && diag.grade === 'Pro', `Expected Pro auto-rigged score >=90, got ${diag.score} (${diag.grade})`);
  assert(diag.needsAutoRig === false, 'Auto-rigged character should no longer need auto-rig');
});

await test('RigSystem.autoRigCharacter binds single Mesh and validates weights cleanly', () => {
  const scene = new THREE.Scene();
  const rig = new RigSystem(scene, THREE);
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.16, 1.72, 14, 16), new THREE.MeshStandardMaterial());
  mesh.position.y = 0.86;
  mesh.name = 'SingleMeshAvatar';
  scene.add(mesh);

  const res = rig.autoRigCharacter(mesh, { templateId: 'humanoid_standard', mode: 'heat', showVisualizer: false });
  assert(res && res.skinnedMeshes.length === 1, 'Expected 1 skinned mesh');
  const check = validateSkinWeights(res.skinnedMeshes[0].geometry, 22);
  assert(check.valid && check.unboundCount === 0 && check.nanCount === 0, `Weight check failed: ${JSON.stringify(check)}`);
});

// ---------------------------------------------------------------------------
// 4. Rig Diagnostics & Expanded Bone Mapping (incl. Daz3D Genesis)
// ---------------------------------------------------------------------------
await test('MocapRetargeter.diagnoseRig recognizes Daz3D Genesis, Mixamo, and Static Unrigged Mesh', () => {
  const daz = makeNamedSkeleton([
    ['hip', null, [0, 0.95, 0]],
    ['abdomenLower', 'hip', [0, 0.12, 0]],
    ['abdomenUpper', 'abdomenLower', [0, 0.14, 0]],
    ['chestUpper', 'abdomenUpper', [0, 0.14, 0]],
    ['neckLower', 'chestUpper', [0, 0.12, 0]],
    ['head', 'neckLower', [0, 0.12, 0]],
    ['lCollar', 'chestUpper', [0.06, 0.06, 0]],
    ['lShldrBend', 'lCollar', [0.12, 0, 0]],
    ['lForearmBend', 'lShldrBend', [0.26, -0.15, 0]],
    ['lHand', 'lForearmBend', [0.24, -0.14, 0]],
    ['rCollar', 'chestUpper', [-0.06, 0.06, 0]],
    ['rShldrBend', 'rCollar', [-0.12, 0, 0]],
    ['rForearmBend', 'rShldrBend', [-0.26, -0.15, 0]],
    ['rHand', 'rForearmBend', [-0.24, -0.14, 0]],
    ['lThighBend', 'hip', [0.1, -0.05, 0]],
    ['lShin', 'lThighBend', [0, -0.42, 0]],
    ['lFoot', 'lShin', [0, -0.40, 0]],
    ['rThighBend', 'hip', [-0.1, -0.05, 0]],
    ['rShin', 'rThighBend', [0, -0.42, 0]],
    ['rFoot', 'rShin', [0, -0.40, 0]],
  ]);
  const dazDiag = MocapRetargeter.diagnoseRig(daz);
  assert(dazDiag.standard === 'Daz3D Genesis', `Expected Daz3D Genesis, got ${dazDiag.standard}`);
  assert(dazDiag.restPose === 'A-Pose', `Expected Daz3D A-Pose, got ${dazDiag.restPose}`);
  assert(dazDiag.criticalMatched === 15 && !dazDiag.needsAutoRig, `Daz3D missing critical bones: ${dazDiag.missingCritical}`);

  const unrigged = new THREE.Mesh(new THREE.BoxGeometry(0.5, 1.7, 0.3), new THREE.MeshStandardMaterial());
  const staticDiag = MocapRetargeter.diagnoseRig(unrigged);
  assert(staticDiag.hasSkeleton === false && staticDiag.needsAutoRig === true && staticDiag.grade === 'Needs Auto-Rig', 'Static mesh should flag Needs Auto-Rig');
});

// ---------------------------------------------------------------------------
// 5. Studio-Grade Blender CC0 GLB Verification (Mannequin_CC0 & Bot_CC0)
// ---------------------------------------------------------------------------
await test('models/Mannequin_CC0.glb is Pro-grade 56-bone humanoid with 8 ARKit blendshapes and <2.5MB', async () => {
  const { gltf, bytes } = await parseGlbFile('models/Mannequin_CC0.glb');
  assert(bytes < 2.5 * 1024 * 1024, `Mannequin_CC0.glb too large: ${(bytes / 1048576).toFixed(2)} MB`);
  const diag = MocapRetargeter.diagnoseRig(gltf.scene);
  assert(diag.totalBones === 56, `Expected 56 bones, got ${diag.totalBones}`);
  assert(diag.mappedCore === 22, `Expected 22/22 core mapped, got ${diag.mappedCore}`);
  assert(diag.fingerBones === 30, `Expected 30 finger bones, got ${diag.fingerBones}`);
  assert(diag.twistBones === 4, `Expected 4 twist bones, got ${diag.twistBones}`);
  assert(diag.faceMorphs >= 8, `Expected >=8 ARKit face morphs, got ${diag.faceMorphs}`);
  assert(diag.score === 100 && diag.grade === 'Pro', `Expected Pro 100/100, got ${diag.grade} ${diag.score}`);
  const clipNames = gltf.animations.map((a) => a.name);
  assert(clipNames.includes('IdleDance') && clipNames.includes('Walk'), `Expected IdleDance + Walk clips, got ${clipNames.join(', ')}`);
});

await test('models/Bot_CC0.glb is Pro-grade 56-bone humanoid with Walk + Idle clips and <2.5MB', async () => {
  const { gltf, bytes } = await parseGlbFile('models/Bot_CC0.glb');
  assert(bytes < 2.5 * 1024 * 1024, `Bot_CC0.glb too large: ${(bytes / 1048576).toFixed(2)} MB`);
  const diag = MocapRetargeter.diagnoseRig(gltf.scene);
  assert(diag.totalBones === 56, `Expected 56 bones, got ${diag.totalBones}`);
  assert(diag.mappedCore === 22 && diag.fingerBones === 30 && diag.twistBones === 4, `Unexpected Bot rig diag: ${JSON.stringify(diag)}`);
  assert(diag.score >= 95 && diag.grade === 'Pro', `Expected Pro >=95, got ${diag.grade} ${diag.score}`);
  const clipNames = gltf.animations.map((a) => a.name);
  assert(clipNames.includes('Walk'), `Bot_CC0.glb MUST include Walk clip (got ${clipNames.join(', ')})`);
});

await test('models/Horse_CC0.glb is seamless 34-bone quadruped with Gallop, Trot, Idle clips and clean skin weights', async () => {
  const { gltf, bytes } = await parseGlbFile('models/Horse_CC0.glb');
  assert(bytes < 2.5 * 1024 * 1024, `Horse_CC0.glb too large: ${(bytes / 1048576).toFixed(2)} MB`);
  let boneCount = 0;
  let skinnedMeshCount = 0;
  gltf.scene.traverse((o) => {
    if (o.isBone) boneCount += 1;
    if (o.isSkinnedMesh) {
      skinnedMeshCount += 1;
      const check = validateSkinWeights(o.geometry, o.skeleton?.bones?.length || 34);
      assert(check.valid && check.unboundCount === 0 && check.nanCount === 0, `Horse_CC0 invalid weights on ${o.name}: ${JSON.stringify(check)}`);
    }
  });
  assert(boneCount === 34, `Expected 34 quadruped bones, got ${boneCount}`);
  assert(skinnedMeshCount >= 1, 'Expected at least one SkinnedMesh in Horse_CC0.glb');
  const clipNames = gltf.animations.map((a) => a.name);
  for (const requiredClip of ['Gallop', 'Trot', 'Idle']) {
    const clip = gltf.animations.find((a) => a.name === requiredClip);
    assert(clip && clip.tracks.length >= 20, `Horse_CC0.glb missing or empty ${requiredClip} clip (clips: ${clipNames.join(', ')})`);
  }
});

// ---------------------------------------------------------------------------
// 6. VI / EN i18n Keys for Upload & Auto-Rig
// ---------------------------------------------------------------------------
await test('i18n VI and EN keys exist for custom character upload and Auto-Rig', () => {
  setLang('en', { persist: false, apply: false });
  assert(t('mocap.uploadChar').includes('Upload 3D Character'), 'Missing EN uploadChar');
  assert(t('mocap.autoRig') === 'Auto-Rig', 'Missing EN autoRig');
  setLang('vi', { persist: false, apply: false });
  assert(t('mocap.uploadChar').includes('Tải nhân vật 3D'), 'Missing VI uploadChar');
  assert(t('mocap.autoRig').includes('gắn xương'), 'Missing VI autoRig');
  setLang('en', { persist: false, apply: false });
});

console.log(`\nSummary: ${passed} passed, ${failures.length} failed.`);
if (failures.length > 0) process.exit(1);
