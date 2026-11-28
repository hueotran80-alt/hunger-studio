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
import { RigSystem, AutoSkinCommand } from '../js/animation/rig-system.js';
import { MocapRetargeter } from '../js/animation/mocap-retargeter.js';
import { SceneManager, TransformCommand } from '../js/core/scene-manager.js';
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

// ---------------------------------------------------------------------------
// 7. Orphan SkeletonHelper Cleanup on Undoable Delete, Undo, Hide & Clear
// ---------------------------------------------------------------------------
await test('SceneManager removes/restores/hides SkeletonHelper cleanly with rigged character (no ghost skeleton)', () => {
  const scene = new THREE.Scene();
  const sm = new SceneManager(scene);
  const rig = new RigSystem({ scene, THREE, sceneManager: sm });
  sm.rigSystem = rig;

  const grp = makeSyntheticHumanoidGroup('t-pose');
  sm.addObject(grp, null, false, false);
  rig.autoRigCharacter(grp, { templateId: 'humanoid_standard', mode: 'heat', showVisualizer: true });

  const countHelpers = () => scene.children.filter((c) => c.isSkeletonHelper || c.userData?.isSkeletonHelper).length;
  assert(countHelpers() === 1, `Expected 1 SkeletonHelper in scene after auto-rig, got ${countHelpers()}`);

  // Hide character -> SkeletonHelper hides too
  sm.setVisibility(grp, false);
  assert(rig.skeletonHelper.visible === false, 'Hiding character must hide its SkeletonHelper');
  sm.setVisibility(grp, true);
  assert(rig.skeletonHelper.visible === true, 'Showing character must restore its SkeletonHelper visibility');

  // Undoable delete (X / Delete -> disposeResources = false) -> NO ghost SkeletonHelper in scene!
  sm.removeObject(grp, true, false);
  assert(countHelpers() === 0, `Expected 0 ghost SkeletonHelpers after delete, got ${countHelpers()}`);
  assert(rig.skeletonHelper === null, 'rigSystem.skeletonHelper must be cleared on delete');

  // Undo (Ctrl+Z) -> character AND its SkeletonHelper come back cleanly
  sm.undo();
  assert(countHelpers() === 1, `Expected SkeletonHelper restored on undo, got ${countHelpers()}`);
  assert(rig.skeletonHelper !== null, 'rigSystem.skeletonHelper should be restored on undo');

  // clearScene -> zero helpers left behind
  sm.clearScene();
  assert(countHelpers() === 0, `Expected 0 SkeletonHelpers after clearScene, got ${countHelpers()}`);
});

// ---------------------------------------------------------------------------
// 8. Deep Audit Probes (5 Confirmed Lifecycle Bugs -> Regression Locked!)
// ---------------------------------------------------------------------------
await test('Probe 1: Undo/Redo preserves full RigSystem pose, IK, and real Three.js AnimationAction state atomically', () => {
  const scene = new THREE.Scene();
  const sm = new SceneManager(scene);
  const rig = new RigSystem({ scene, THREE, sceneManager: sm });
  sm.rigSystem = rig;

  const grp = makeSyntheticHumanoidGroup('t-pose');
  sm.addObject(grp, null, false, false);
  const res = rig.autoRigCharacter(grp, { templateId: 'humanoid_standard', mode: 'heat', showVisualizer: true });
  rig.activeCharacter = res.skinnedMeshes[0];
  rig.activeSkeleton = res.skeleton;
  rig.activeBone = res.skeleton.bones[0];
  rig.setPoseMode(true, res.skinnedMeshes[0]);
  rig.setupTwoBoneIK(grp);
  rig.setIKEnabled(true);

  const mixer = new THREE.AnimationMixer(grp);
  const track = new THREE.VectorKeyframeTrack('.position', [0, 1], [0, 0, 0, 0, 1, 0]);
  const clip = new THREE.AnimationClip('Walk', 1.0, [track]);
  const action = mixer.clipAction(clip);
  action.play();
  mixer.update(0.42);
  const fakeStudio = {
    _characterMixer: mixer,
    _characterMixerRoot: grp,
    _currentAction: action,
    _currentSkeletonHelper: null,
  };
  sm.studio = fakeStudio;

  const origChar = rig.activeCharacter;
  const origBone = rig.activeBone;
  const origChainCount = rig.ikChains.size;
  assert(origChainCount === 4, `Expected 4 IK chains before delete, got ${origChainCount}`);

  // Undoable delete -> state cleared while deleted, action NOT reset by stop()
  sm.removeObject(grp, true, false);
  assert(rig.activeCharacter === null && rig.isPoseMode === false && rig.ikChains.size === 0, 'Delete must clear live rig & IK state');
  assert(rig.skeletonHelper === null && rig.ikHandlesGroup === null, 'Delete must detach helper & IK group');
  assert(fakeStudio._characterMixerRoot === null && fakeStudio._characterMixer === null, 'Delete must detach RapidStudio mixer');

  // Undo -> full rig, pose, IK, and real AnimationAction playback state restored atomically!
  sm.undo();
  assert(rig.activeCharacter === origChar, 'Undo must restore activeCharacter');
  assert(rig.activeBone === origBone, 'Undo must restore activeBone');
  assert(rig.isPoseMode === true, 'Undo must restore isPoseMode');
  assert(rig.isIKEnabled === true && rig.ikChains.size === origChainCount, 'Undo must restore IK enabled & chains');
  assert(rig.skeletonHelper !== null && rig.ikHandlesGroup !== null, 'Undo must restore SkeletonHelper & IK group');
  assert(fakeStudio._characterMixerRoot === grp && fakeStudio._currentAction === action, 'Undo must restore RapidStudio mixer & action');
  assert(Math.abs(action.time - 0.42) < 1e-6 && action.isRunning() && action.isScheduled(), 'Undo must preserve live action time/running/scheduled');

  // Redo -> cleans up cleanly again, second Undo -> restores again!
  sm.redo();
  assert(rig.activeCharacter === null && rig.skeletonHelper === null && rig.ikHandlesGroup === null, 'Redo must re-detach rig helpers & state');
  sm.undo();
  assert(rig.activeCharacter === origChar && rig.isPoseMode === true && rig.ikChains.size === origChainCount, 'Second Undo must remain idempotent');
});

await test('Probe 2: Nested parent/child & collection effective visibility never leaves floating SkeletonHelper', () => {
  const scene = new THREE.Scene();
  const sm = new SceneManager(scene);
  const rig = new RigSystem({ scene, THREE, sceneManager: sm });
  sm.rigSystem = rig;

  const outer = new THREE.Group();
  outer.name = 'OuterParent';
  const inner = makeSyntheticHumanoidGroup('t-pose');
  inner.name = 'InnerRigged';
  outer.add(inner);
  sm.addObject(outer, null, false, false);
  sm.addObject(inner, outer, false, false);
  rig.autoRigCharacter(inner, { templateId: 'humanoid_standard', mode: 'heat', showVisualizer: true });

  assert(rig.skeletonHelper && rig.skeletonHelper.visible === true, 'Initial helper should be visible');

  // Exact audit repro: hide outer -> hide inner -> show outer -> inner is STILL hidden so helper MUST stay hidden!
  sm.setVisibility(outer, false);
  assert(rig.skeletonHelper.visible === false, 'Hiding outer parent must hide child SkeletonHelper');
  sm.setVisibility(inner, false);
  assert(rig.skeletonHelper.visible === false, 'Hiding inner child keeps SkeletonHelper hidden');
  sm.setVisibility(outer, true);
  assert(outer.visible === true && inner.visible === false && rig.skeletonHelper.visible === false,
    `Expected {outer:true, inner:false, helper:false}, got {outer:${outer.visible}, inner:${inner.visible}, helper:${rig.skeletonHelper.visible}}`);

  // Showing inner now makes effective visibility true -> helper reappears
  sm.setVisibility(inner, true);
  assert(rig.skeletonHelper.visible === true, 'Showing inner child when outer is visible must show SkeletonHelper');

  // Collection visibility hiding root collection must hide helper too
  const rootColId = sm.collectionManager.rootId;
  sm.collectionManager.setCollectionVisibility(rootColId, false);
  assert(rig.skeletonHelper.visible === false, 'Hiding collection must hide SkeletonHelper');
  sm.collectionManager.setCollectionVisibility(rootColId, true);
  assert(rig.skeletonHelper.visible === true, 'Showing collection must restore SkeletonHelper');
});

await test('Probe 3: Interleaved multi-rig delete A -> rig B (no history) -> undo A never clobbers live Rig B ownership', () => {
  const scene = new THREE.Scene();
  const sm = new SceneManager(scene);
  const rig = new RigSystem({ scene, THREE, sceneManager: sm });
  sm.rigSystem = rig;

  const rigA = makeSyntheticHumanoidGroup('t-pose');
  rigA.name = 'RigA';
  sm.addObject(rigA, null, false, false);
  const resA = rig.autoRigCharacter(rigA, { templateId: 'humanoid_standard', mode: 'heat', showVisualizer: true });
  rig.activeCharacter = resA.skinnedMeshes[0];
  rig.setupTwoBoneIK(rigA);
  rig.setIKEnabled(true);

  // Delete Rig A (undoable)
  sm.removeObject(rigA, true, false);

  // Create & rig Rig B via non-history path
  const rigB = makeSyntheticHumanoidGroup('t-pose');
  rigB.name = 'RigB';
  sm.addObject(rigB, null, false, false);
  const resB = rig.autoRigCharacter(rigB, { templateId: 'humanoid_standard', mode: 'heat', showVisualizer: true });
  rig.activeCharacter = resB.skinnedMeshes[0];
  const helperB = rig.skeletonHelper;
  rig.setupTwoBoneIK(rigB);
  rig.setIKEnabled(true);
  const ikGroupB = rig.ikHandlesGroup;
  assert(ikGroupB.userData.targetRoot, 'IK group must be tagged with targetRoot');

  // Undo Rig A -> Rig A returns to scene, but live Rig B ownership MUST remain intact with ZERO duplicate helpers!
  sm.undo();
  const helpersInScene = scene.children.filter((c) => c.isSkeletonHelper || c.userData?.isSkeletonHelper);
  const ikGroupsInScene = scene.children.filter((c) => c.userData?.isIKHandlesGroup);
  assert(helpersInScene.length === 1, `Expected 1 live SkeletonHelper (Rig B), got ${helpersInScene.length}`);
  assert(rig.skeletonHelper === helperB, 'Undo A must NOT clobber live Rig B skeletonHelper');
  assert(rig.activeCharacter === resB.skinnedMeshes[0], 'Undo A must NOT clobber live Rig B activeCharacter');
  assert(ikGroupsInScene.length === 1 && rig.ikHandlesGroup === ikGroupB, 'Undo A must NOT clobber live Rig B IK group');
});

await test('Probe 4: History eviction and clearHistory dispose stashed helper & IK GPU resources (zero leak)', () => {
  const scene = new THREE.Scene();
  const sm = new SceneManager(scene);
  const rig = new RigSystem({ scene, THREE, sceneManager: sm });
  sm.rigSystem = rig;

  const grp = makeSyntheticHumanoidGroup('t-pose');
  sm.addObject(grp, null, false, false);
  rig.autoRigCharacter(grp, { templateId: 'humanoid_standard', mode: 'heat', showVisualizer: true });
  rig.setupTwoBoneIK(grp);

  let geoDisposals = 0;
  let matDisposals = 0;
  const wrapDispose = (obj) => {
    const origG = obj.geometry?.dispose?.bind(obj.geometry);
    if (origG) obj.geometry.dispose = () => { geoDisposals += 1; origG(); };
    const origM = obj.material?.dispose?.bind(obj.material);
    if (origM) obj.material.dispose = () => { matDisposals += 1; origM(); };
  };
  wrapDispose(rig.skeletonHelper);
  rig.ikHandlesGroup.traverse((n) => wrapDispose(n));

  sm.removeObject(grp, true, false);
  assert(Array.isArray(grp.userData._detachedRigHelpers) && grp.userData._detachedRigHelpers.length === 2, 'Should stash SkeletonHelper + IK group');
  assert(geoDisposals === 0 && matDisposals === 0, 'Undoable delete must not dispose stashed helpers while in undo stack');

  // Clear history -> evicted RemoveObjectCommand MUST dispose all stashed helper & IK GPU resources!
  sm.clearHistory();
  assert(geoDisposals >= 2 && matDisposals >= 2, `Expected helper+IK geometry/material disposal on clearHistory, got geo=${geoDisposals}, mat=${matDisposals}`);
  assert(grp.userData._detachedRigHelpers === undefined, '_detachedRigHelpers must be deleted after disposal');
});

await test('Probe 5: clearScene clears IK chains, chainBlends, activeIKHandle, and disposes IK handles', () => {
  const scene = new THREE.Scene();
  const sm = new SceneManager(scene);
  const rig = new RigSystem({ scene, THREE, sceneManager: sm });
  sm.rigSystem = rig;

  const grp = makeSyntheticHumanoidGroup('t-pose');
  sm.addObject(grp, null, false, false);
  rig.autoRigCharacter(grp, { templateId: 'humanoid_standard', mode: 'heat', showVisualizer: true });
  rig.setupTwoBoneIK(grp);
  rig.setIKEnabled(true);
  rig.chainBlends.set('leftLeg', 0.75);
  rig.activeIKHandle = rig.ikChains.get('leftLeg')?.targetHandle || null;

  assert(rig.ikChains.size === 4 && rig.chainBlends.size === 1 && rig.activeIKHandle !== null, 'Precondition: IK state populated');

  sm.clearScene();
  assert(rig.ikHandlesGroup === null, 'clearScene must clear ikHandlesGroup');
  assert(rig.ikChains.size === 0, `clearScene must clear ikChains, got size=${rig.ikChains.size}`);
  assert(rig.chainBlends.size === 0, `clearScene must clear chainBlends, got size=${rig.chainBlends.size}`);
  assert(rig.activeIKHandle === null, 'clearScene must clear activeIKHandle');
  assert(rig.isIKEnabled === false, 'clearScene must reset isIKEnabled');
  const leftoverIK = scene.children.filter((c) => c.userData?.isIKHandlesGroup);
  assert(leftoverIK.length === 0, `Expected 0 leftover IK groups in scene, got ${leftoverIK.length}`);
});

// ---------------------------------------------------------------------------
// 9. Deep Audit Round-2 Probes (All 6 Confirmed Bugs -> Regression Locked!)
// ---------------------------------------------------------------------------
function makeMockEngine() {
  const listeners = new Map();
  const domElement = {
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      listeners.get(type)?.delete(fn);
    },
    listenerCount(type) {
      return listeners.get(type)?.size || 0;
    },
  };
  const transformControls = {
    object: null,
    mode: 'translate',
    space: 'world',
    attach(obj) { this.object = obj; },
    detach() { this.object = null; },
    setMode(m) { this.mode = m; },
    setSpace(s) { this.space = s; },
  };
  return { transformControls, renderer: { domElement } };
}

await test('Audit2-1: Undo restores real Pose Mode gizmo, Edit Bone Mode gizmo, and Weight Paint material/canvas', () => {
  const scene = new THREE.Scene();
  const sm = new SceneManager(scene);
  const mockEngine = makeMockEngine();
  sm.engine = mockEngine;
  const rig = new RigSystem({ scene, THREE, sceneManager: sm, engine: mockEngine });
  sm.rigSystem = rig;

  const grp = makeSyntheticHumanoidGroup('t-pose');
  sm.addObject(grp, null, false, false);
  const res = rig.autoRigCharacter(grp, { templateId: 'humanoid_standard', mode: 'heat', showVisualizer: true });
  const hips = res.skeleton.bones[0];
  const skinned = res.skinnedMeshes[0];
  const origMat = skinned.material;

  // (a) Pose Mode: TransformControls attached to activeBone in rotate mode -> delete -> undo -> re-attached!
  rig.setPoseMode(true, res.character);
  rig.selectBone(hips);
  assert(mockEngine.transformControls.object === hips && mockEngine.transformControls.mode === 'rotate', 'Precondition: Pose gizmo attached to Hips');
  sm.removeObject(grp, true, false);
  assert(mockEngine.transformControls.object === null, 'Delete must detach TransformControls');
  sm.undo();
  assert(rig.isPoseMode === true && rig.activeBone === hips, 'Undo must restore Pose Mode & Hips');
  assert(mockEngine.transformControls.object === hips && mockEngine.transformControls.mode === 'rotate',
    `Undo must re-attach TransformControls to Hips (got object=${mockEngine.transformControls.object?.name}, mode=${mockEngine.transformControls.mode})`);

  // (b) Weight Paint Mode: material swapped + canvas listeners bound -> delete -> undo -> material & canvas restored!
  rig.enableWeightPaintMode(skinned, hips);
  assert(rig.isWeightPaintMode === true && skinned.material === skinned.userData._weightPaintMat, 'Precondition: Weight Paint material active');
  assert(rig._weightCanvasBound === mockEngine.renderer.domElement && mockEngine.renderer.domElement.listenerCount('pointerdown') === 1, 'Precondition: Weight Paint canvas listeners bound');
  sm.removeObject(grp, true, false);
  assert(rig.isWeightPaintMode === false && skinned.material === origMat && rig._weightCanvasBound === null, 'Delete must disable Weight Paint & restore original material');
  sm.undo();
  assert(rig.isWeightPaintMode === true && rig.weightPaintMesh === skinned, 'Undo must restore Weight Paint state');
  assert(skinned.material === skinned.userData._weightPaintMat, 'Undo must re-enable Weight Paint heatmap material');
  assert(rig._weightCanvasBound === mockEngine.renderer.domElement && mockEngine.renderer.domElement.listenerCount('pointerdown') === 1, 'Undo must re-bind Weight Paint canvas listeners');
  rig.disableWeightPaintMode();

  // (c) Edit Bone Mode: TransformControls attached in translate mode -> delete -> undo -> re-attached!
  rig.enterEditBoneMode(grp);
  rig.selectBone(hips);
  assert(rig.isEditBoneMode === true && mockEngine.transformControls.object === hips && mockEngine.transformControls.mode === 'translate', 'Precondition: Edit Bone gizmo attached');
  sm.removeObject(grp, true, false);
  assert(rig.isEditBoneMode === false && mockEngine.transformControls.object === null, 'Delete must exit Edit Bone & detach gizmo');
  sm.undo();
  assert(rig.isEditBoneMode === true && mockEngine.transformControls.object === hips && mockEngine.transformControls.mode === 'translate', 'Undo must restore Edit Bone Mode & translate gizmo');
});

await test('Audit2-2: RigSystem setters (setBoneDisplayMode, setPoseMode, setIKEnabled, createSkeletonVisualizer) obey effective visibility', () => {
  const scene = new THREE.Scene();
  const sm = new SceneManager(scene);
  const rig = new RigSystem({ scene, THREE, sceneManager: sm });
  sm.rigSystem = rig;

  const grp = makeSyntheticHumanoidGroup('t-pose');
  sm.addObject(grp, null, false, false);
  const res = rig.autoRigCharacter(grp, { templateId: 'humanoid_standard', mode: 'heat', showVisualizer: true });
  rig.setupTwoBoneIK(grp);

  // Hide character root -> EVERY RigSystem setter must keep skeletonHelper & ikHandlesGroup hidden!
  sm.setVisibility(grp, false);
  assert(rig.skeletonHelper.visible === false, 'Precondition: helper hidden when root hidden');

  rig.setBoneDisplayMode('stick');
  assert(rig.skeletonHelper.visible === false, 'setBoneDisplayMode must NOT reveal helper on hidden root');
  rig.setBoneDisplayMode('octahedral');
  assert(rig.skeletonHelper.visible === false, 'setBoneDisplayMode(octahedral) must NOT reveal helper on hidden root');

  rig.setPoseMode(true, grp);
  assert(rig.skeletonHelper.visible === false, 'setPoseMode(true) must NOT reveal helper on hidden root');

  rig.setIKEnabled(true);
  assert(rig.ikHandlesGroup.visible === false, 'setIKEnabled(true) must NOT reveal IK handles on hidden root');

  rig.createSkeletonVisualizer(res.skeleton, grp);
  assert(rig.skeletonHelper.visible === false, 'createSkeletonVisualizer must NOT reveal helper on hidden root');

  // Once root becomes visible again, both helper & IK handles appear cleanly!
  sm.setVisibility(grp, true);
  assert(rig.skeletonHelper.visible === true && rig.ikHandlesGroup.visible === true, 'Showing root must reveal helper & enabled IK handles');
});

await test('Audit2-3: Object hidden by Collection stays locally visible (userData.visible=true) after delete -> undo -> show collection', () => {
  const scene = new THREE.Scene();
  const sm = new SceneManager(scene);
  const rig = new RigSystem({ scene, THREE, sceneManager: sm });
  sm.rigSystem = rig;

  const subCol = sm.collectionManager.createCollection('HiddenChars');
  const grp = makeSyntheticHumanoidGroup('t-pose');
  sm.addObject(grp, null, false, false);
  sm.collectionManager.moveObjectToCollection(grp, subCol.id);
  rig.autoRigCharacter(grp, { templateId: 'humanoid_standard', mode: 'heat', showVisualizer: true });

  // Hide collection -> object becomes effectively hidden while local userData.visible stays true
  sm.collectionManager.setCollectionVisibility(subCol.id, false);
  assert(grp.visible === false && grp.userData.visible === true && rig.skeletonHelper.visible === false,
    'Precondition: hidden by collection with local userData.visible=true');

  // Delete -> Undo while collection is STILL hidden
  sm.removeObject(grp, true, false);
  sm.undo();
  assert(grp.userData.visible === true, `Undo MUST NOT overwrite userData.visible to false (got ${grp.userData.visible})`);
  assert(grp.visible === false && rig.skeletonHelper.visible === false, 'Object & helper must remain effectively hidden while collection is still hidden');

  // Now show collection -> BOTH object AND its SkeletonHelper MUST become visible!
  sm.collectionManager.setCollectionVisibility(subCol.id, true);
  assert(grp.visible === true && grp.userData.visible === true && rig.skeletonHelper.visible === true,
    `Expected visible after showing collection, got obj=${grp.visible}, local=${grp.userData.visible}, helper=${rig.skeletonHelper.visible}`);

  // Also test alternate order: hide collection -> delete -> show collection BEFORE undo -> undo -> visible!
  sm.collectionManager.setCollectionVisibility(subCol.id, false);
  sm.removeObject(grp, true, false);
  sm.collectionManager.setCollectionVisibility(subCol.id, true);
  sm.undo();
  assert(grp.visible === true && grp.userData.visible === true && rig.skeletonHelper.visible === true,
    `Expected visible when collection shown before undo, got obj=${grp.visible}, local=${grp.userData.visible}, helper=${rig.skeletonHelper.visible}`);
});

await test('Audit2-4: Undo preserves real THREE.AnimationAction paused, time, enabled, fade weight, and scheduled state', () => {
  const scene = new THREE.Scene();
  const sm = new SceneManager(scene);
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial());
  sm.addObject(mesh, null, false, false);

  const mixer = new THREE.AnimationMixer(mesh);
  const clip = new THREE.AnimationClip('Walk', 2.0, [new THREE.VectorKeyframeTrack('.position', [0, 2], [0, 0, 0, 2, 0, 0])]);
  const action = mixer.clipAction(clip);
  action.fadeIn(1.0).play();
  mixer.update(0.5);
  action.paused = true;

  const before = {
    time: action.time,
    paused: action.paused,
    enabled: action.enabled,
    weight: action.getEffectiveWeight(),
    scheduled: action.isScheduled(),
    running: action.isRunning(),
  };
  assert(Math.abs(before.time - 0.5) < 1e-6 && before.paused === true && before.enabled === true && before.weight > 0.4 && before.scheduled === true,
    `Unexpected initial paused action state: ${JSON.stringify(before)}`);

  const fakeStudio = { _characterMixer: mixer, _characterMixerRoot: mesh, _currentAction: action, _currentSkeletonHelper: null };
  sm.studio = fakeStudio;

  // Delete (undoable) -> mixer detached, action NOT reset by stop()
  sm.removeObject(mesh, true, false);
  assert(fakeStudio._characterMixer === null && fakeStudio._currentAction === null, 'Mixer must detach on delete');

  // Undo -> exact paused, time, enabled, fade weight, scheduled state preserved bit-for-bit!
  sm.undo();
  assert(fakeStudio._characterMixer === mixer && fakeStudio._currentAction === action, 'Mixer & action restored');
  assert(Math.abs(action.time - before.time) < 1e-6, `Action time lost: ${action.time} vs ${before.time}`);
  assert(action.paused === true && action.enabled === true, `Action paused/enabled lost: paused=${action.paused}, enabled=${action.enabled}`);
  assert(Math.abs(action.getEffectiveWeight() - before.weight) < 1e-6, `Action fade weight lost: ${action.getEffectiveWeight()} vs ${before.weight}`);
  assert(action.isScheduled() === true && action.isRunning() === false, `Action scheduled/running mismatch: scheduled=${action.isScheduled()}, running=${action.isRunning()}`);
});

await test('Audit2-5: AutoSkinCommand history eviction disposes stashed helpers on replaced oldMesh', () => {
  const scene = new THREE.Scene();
  const sm = new SceneManager(scene);
  const rig = new RigSystem({ scene, THREE, sceneManager: sm });
  sm.rigSystem = rig;

  const oldMesh = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.16, 1.72, 12, 10), new THREE.MeshStandardMaterial());
  oldMesh.name = 'OldUnrigged';
  sm.addObject(oldMesh, null, false, false);

  const built = buildSkeletonFromTemplate('humanoid_standard');
  sm.addObject(built.armatureGroup, null, false, false);
  rig.createSkeletonVisualizer(built.skeleton, oldMesh);

  let helperGeoDisposed = 0;
  let helperMatDisposed = 0;
  const origG = rig.skeletonHelper.geometry.dispose.bind(rig.skeletonHelper.geometry);
  const origM = rig.skeletonHelper.material.dispose.bind(rig.skeletonHelper.material);
  rig.skeletonHelper.geometry.dispose = () => { helperGeoDisposed += 1; origG(); };
  rig.skeletonHelper.material.dispose = () => { helperMatDisposed += 1; origM(); };

  const newMesh = new THREE.SkinnedMesh(oldMesh.geometry.clone(), oldMesh.material.clone());
  newMesh.name = 'NewSkinned';
  const cmd = new AutoSkinCommand(rig, oldMesh, newMesh, built.skeleton, 'Auto-Skin Test');
  cmd.execute();
  sm.executeCommand(cmd);

  assert(Array.isArray(oldMesh.userData._detachedRigHelpers) && oldMesh.userData._detachedRigHelpers.length === 1,
    'AutoSkin swap should stash oldMesh helper for undo');
  assert(helperGeoDisposed === 0 && helperMatDisposed === 0, 'Must not dispose stashed helper while AutoSkinCommand is in history');

  // Clear history -> AutoSkinCommand eviction MUST dispose oldMesh stashed helper!
  sm.clearHistory();
  assert(helperGeoDisposed === 1 && helperMatDisposed === 1,
    `AutoSkinCommand clearHistory must dispose stashed helper (got geo=${helperGeoDisposed}, mat=${helperMatDisposed})`);
  assert(oldMesh.userData._detachedRigHelpers === undefined, 'oldMesh._detachedRigHelpers must be cleared');
});

await test('Audit2-6: Bone joint & octahedron proxy geometries and materials are disposed cleanly (deduped) on clearHistory', () => {
  const scene = new THREE.Scene();
  const sm = new SceneManager(scene);
  const rig = new RigSystem({ scene, THREE, sceneManager: sm });
  sm.rigSystem = rig;

  const grp = makeSyntheticHumanoidGroup('t-pose');
  sm.addObject(grp, null, false, false);
  rig.autoRigCharacter(grp, { templateId: 'humanoid_standard', mode: 'heat', showVisualizer: true });

  const uniqueGeos = new Set();
  const uniqueMats = new Set();
  const disposedGeos = new Set();
  const disposedMats = new Set();
  let geoDisposeCalls = 0;
  let matDisposeCalls = 0;

  grp.traverse((node) => {
    if (!node.userData?.isBoneJoint && !node.userData?.isBoneHitProxy) return;
    if (node.geometry && !uniqueGeos.has(node.geometry)) {
      uniqueGeos.add(node.geometry);
      const orig = node.geometry.dispose.bind(node.geometry);
      node.geometry.dispose = () => { geoDisposeCalls += 1; disposedGeos.add(node.geometry); orig(); };
    }
    if (node.material && !uniqueMats.has(node.material)) {
      uniqueMats.add(node.material);
      const orig = node.material.dispose.bind(node.material);
      node.material.dispose = () => { matDisposeCalls += 1; disposedMats.add(node.material); orig(); };
    }
  });
  assert(uniqueGeos.size >= 15 && uniqueMats.size >= 30,
    `Expected >=15 unique proxy geos & >=30 unique proxy mats, got ${uniqueGeos.size}/${uniqueMats.size}`);

  // Undoable delete -> proxies still kept alive for undo
  sm.removeObject(grp, true, false);
  assert(geoDisposeCalls === 0 && matDisposeCalls === 0, 'Undoable delete must not dispose proxies yet');

  // Clear history -> EVERY unique proxy geometry & material disposed EXACTLY ONCE!
  sm.clearHistory();
  assert(disposedGeos.size === uniqueGeos.size && geoDisposeCalls === uniqueGeos.size,
    `Expected all ${uniqueGeos.size} unique proxy geometries disposed once, got disposed=${disposedGeos.size} calls=${geoDisposeCalls}`);
  assert(disposedMats.size === uniqueMats.size && matDisposeCalls === uniqueMats.size,
    `Expected all ${uniqueMats.size} unique proxy materials disposed once, got disposed=${disposedMats.size} calls=${matDisposeCalls}`);
});

await test('Audit3-1: History eviction and clearHistory dispose deleted mesh resources once while protecting live/parent-undoable subtrees', () => {
  // A. Regular Mesh delete -> maxHistory eviction -> geometry, material, and texture disposed once
  const sceneA = new THREE.Scene();
  const smA = new SceneManager(sceneA);
  smA.maxHistory = 1;
  const geoA = new THREE.BoxGeometry(1, 1, 1);
  const texA = new THREE.DataTexture(new Uint8Array([255, 0, 0, 255]), 1, 1);
  const matA = new THREE.MeshStandardMaterial({ map: texA });
  let geoADisposed = 0;
  let matADisposed = 0;
  let texADisposed = 0;
  const origGeoA = geoA.dispose.bind(geoA);
  const origMatA = matA.dispose.bind(matA);
  const origTexA = texA.dispose.bind(texA);
  geoA.dispose = () => { geoADisposed += 1; origGeoA(); };
  matA.dispose = () => { matADisposed += 1; origMatA(); };
  texA.dispose = () => { texADisposed += 1; origTexA(); };

  const meshA = new THREE.Mesh(geoA, matA);
  meshA.name = 'EvictBox';
  smA.addObject(meshA, null, true);
  smA.removeObject(meshA, true, false);
  assert(geoADisposed === 0 && matADisposed === 0 && texADisposed === 0,
    'Deleted mesh resources must stay alive while RemoveObjectCommand is in undoStack');

  const spacer = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial());
  spacer.name = 'Spacer';
  smA.addObject(spacer, null, true);
  assert(geoADisposed === 1 && matADisposed === 1 && texADisposed === 1,
    `Expected evicted deleted mesh resources disposed once (geo=${geoADisposed}, mat=${matADisposed}, tex=${texADisposed})`);

  // B. Deleted regular Mesh -> clearHistory() -> disposed once (idempotent on repeat)
  const sceneB = new THREE.Scene();
  const smB = new SceneManager(sceneB);
  const geoB = new THREE.BoxGeometry(1, 1, 1);
  const matB = new THREE.MeshStandardMaterial();
  let geoBDisposed = 0;
  let matBDisposed = 0;
  const origGeoB = geoB.dispose.bind(geoB);
  const origMatB = matB.dispose.bind(matB);
  geoB.dispose = () => { geoBDisposed += 1; origGeoB(); };
  matB.dispose = () => { matBDisposed += 1; origMatB(); };

  const meshB = new THREE.Mesh(geoB, matB);
  meshB.name = 'ClearHistoryBox';
  smB.addObject(meshB, null, false);
  smB.removeObject(meshB, true, false);
  assert(geoBDisposed === 0 && matBDisposed === 0, 'Must not dispose before clearHistory');
  smB.clearHistory();
  assert(geoBDisposed === 1 && matBDisposed === 1,
    `Expected clearHistory to dispose once (geo=${geoBDisposed}, mat=${matBDisposed})`);
  smB.clearHistory();
  assert(geoBDisposed === 1 && matBDisposed === 1, 'Repeat clearHistory must not double-dispose');

  // C. Child TransformCommand evicted while parent RemoveObjectCommand remains in undoStack
  const sceneC = new THREE.Scene();
  const smC = new SceneManager(sceneC);
  smC.maxHistory = 1;
  const parentGroup = new THREE.Group();
  parentGroup.name = 'ParentGrp';
  const childGeo = new THREE.BoxGeometry(1, 1, 1);
  const childMat = new THREE.MeshBasicMaterial();
  let childGeoDisposed = 0;
  let childMatDisposed = 0;
  const origCG = childGeo.dispose.bind(childGeo);
  const origCM = childMat.dispose.bind(childMat);
  childGeo.dispose = () => { childGeoDisposed += 1; origCG(); };
  childMat.dispose = () => { childMatDisposed += 1; origCM(); };
  const childMesh = new THREE.Mesh(childGeo, childMat);
  childMesh.name = 'ChildMesh';
  parentGroup.add(childMesh);
  smC.addObject(parentGroup, null, false);

  const zeroQ = new THREE.Quaternion();
  const unitS = new THREE.Vector3(1, 1, 1);
  smC.executeCommand(new TransformCommand(
    childMesh,
    { position: childMesh.position, quaternion: zeroQ, scale: unitS },
    { position: new THREE.Vector3(2, 0, 0), quaternion: zeroQ, scale: unitS }
  ));
  smC.removeObject(parentGroup, true, false);
  assert(childGeoDisposed === 0 && childMatDisposed === 0,
    'Child resources must remain intact when TransformCommand evicts while parent delete is still undoable');

  smC.clearHistory();
  assert(childGeoDisposed === 1 && childMatDisposed === 1,
    `Expected child disposed once when parent delete clears (geo=${childGeoDisposed}, mat=${childMatDisposed})`);
});

await test('Audit3-2: clearScene() disposes Group rig with registered child SkinnedMeshes and helpers exactly once per unique resource', () => {
  const scene = new THREE.Scene();
  const sm = new SceneManager(scene);
  const rig = new RigSystem({ scene, THREE, sceneManager: sm });
  sm.rigSystem = rig;

  const grp = makeSyntheticHumanoidGroup('t-pose');
  sm.addObject(grp, null, true);
  const res = rig.autoRigCharacter(grp, { templateId: 'humanoid_standard', mode: 'heat', showVisualizer: true });
  assert(res && res.character === grp, 'autoRigCharacter must succeed');
  for (const skm of res.skinnedMeshes) {
    if (!Array.from(sm.objects.values()).includes(skm)) {
      sm.objects.set(skm.userData?.id || skm.uuid, skm);
    }
  }
  assert(sm.objects.size > 1, `Expected parent + child SkinnedMeshes registered in sm.objects, got ${sm.objects.size}`);

  const geoCounts = new Map();
  const matCounts = new Map();
  const trackNode = (node) => {
    if (!node) return;
    if (node.geometry && typeof node.geometry.dispose === 'function' && !geoCounts.has(node.geometry)) {
      const g = node.geometry;
      geoCounts.set(g, 0);
      const orig = g.dispose.bind(g);
      g.dispose = () => { geoCounts.set(g, geoCounts.get(g) + 1); orig(); };
    }
    if (node.material) {
      const mats = Array.isArray(node.material) ? node.material : [node.material];
      for (const m of mats) {
        if (m && typeof m.dispose === 'function' && !matCounts.has(m)) {
          matCounts.set(m, 0);
          const orig = m.dispose.bind(m);
          m.dispose = () => { matCounts.set(m, matCounts.get(m) + 1); orig(); };
        }
      }
    }
  };
  scene.traverse(trackNode);
  if (rig.skeletonHelper) rig.skeletonHelper.traverse(trackNode);
  if (rig.ikHandlesGroup) rig.ikHandlesGroup.traverse(trackNode);

  assert(geoCounts.size >= 20 && matCounts.size >= 30,
    `Expected >=20 unique geos and >=30 unique mats on rigged group, got ${geoCounts.size}/${matCounts.size}`);

  sm.clearScene();

  const dupGeos = Array.from(geoCounts.values()).filter((c) => c !== 1);
  const dupMats = Array.from(matCounts.values()).filter((c) => c !== 1);
  assert(dupGeos.length === 0,
    `Every unique geometry must be disposed exactly once on clearScene (bad counts: ${JSON.stringify(Array.from(geoCounts.values()))})`);
  assert(dupMats.length === 0,
    `Every unique material must be disposed exactly once on clearScene (bad counts: ${JSON.stringify(Array.from(matCounts.values()))})`);
  assert(sm.objects.size === 0, 'sm.objects must be cleared');
  assert(sm.undoStack.length === 0 && sm.redoStack.length === 0, 'history must be cleared');
});

console.log(`\nSummary: ${passed} passed, ${failures.length} failed.`);
if (failures.length > 0) process.exit(1);
