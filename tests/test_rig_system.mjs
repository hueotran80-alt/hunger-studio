/**
 * Comprehensive unit & integration tests for RigSystem (Edit Bone Mode, Auto-Skinning,
 * Interactive Weight Paint Brush + Tools + Undo/Redo, Skeleton Visualizer, Two-Bone IK, Pose Engine).
 * Run:
 *   node --import ./tests/three-resolve-hooks.mjs tests/test_rig_system.mjs
 */
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
  RigSystem,
  WeightPaintCommand,
  PoseChangeCommand,
  EditArmatureCommand,
  AutoSkinCommand,
} from '../js/animation/rig-system.js';
import { ManualPoseEditor } from '../js/animation/manual-pose-editor.js';
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
    console.error(`FAIL ${name}\n     ${err?.stack || err?.message}`);
  }
}

function createMockSceneManager() {
  return {
    undoStack: [],
    redoStack: [],
    objects: new Map(),
    executeCommand(cmd) {
      this.undoStack.push(cmd);
      this.redoStack = [];
    },
    undo() {
      const cmd = this.undoStack.pop();
      if (cmd) {
        cmd.undo();
        this.redoStack.push(cmd);
        return true;
      }
      return false;
    },
    redo() {
      const cmd = this.redoStack.pop();
      if (cmd) {
        cmd.execute();
        this.undoStack.push(cmd);
        return true;
      }
      return false;
    },
    addObject(obj) {
      if (obj) this.objects.set(obj.uuid, obj);
    },
    removeObject(obj) {
      if (obj) this.objects.delete(obj.uuid);
      if (obj?.parent) obj.parent.remove(obj);
    },
    select() {},
    getActiveObject() { return null; },
    requestRender() {},
  };
}

function create3BoneChainMesh() {
  const b0 = new THREE.Bone(); b0.name = 'Root'; b0.position.set(0, 0, 0);
  const b1 = new THREE.Bone(); b1.name = 'Mid'; b1.position.set(0, 1, 0);
  const b2 = new THREE.Bone(); b2.name = 'Tip'; b2.position.set(0, 1, 0);
  b0.add(b1);
  b1.add(b2);
  const group = new THREE.Group();
  group.add(b0);
  const skeleton = new THREE.Skeleton([b0, b1, b2]);
  group.updateMatrixWorld(true);
  skeleton.calculateInverses();

  const geom = new THREE.CylinderGeometry(0.25, 0.25, 2.0, 16, 16);
  geom.translate(0, 1.0, 0); // Y in [0, 2]
  const mesh = new THREE.Mesh(geom, new THREE.MeshStandardMaterial());
  return { group, skeleton, mesh, bones: [b0, b1, b2] };
}

function assertNormalizedWeights(geom, maxBoneIndex) {
  const skinIdx = geom.attributes.skinIndex;
  const skinW = geom.attributes.skinWeight;
  assert.ok(skinIdx && skinW, 'Missing skinIndex or skinWeight attributes');
  for (let i = 0; i < skinW.count; i++) {
    let sum = 0;
    for (let s = 0; s < 4; s++) {
      const idx = skinIdx.getComponent(i, s);
      const w = skinW.getComponent(i, s);
      assert.ok(Number.isFinite(w) && w >= -1e-6, `Invalid weight ${w} at vertex ${i}`);
      assert.ok(idx >= 0 && idx <= maxBoneIndex, `Out-of-range skinIndex ${idx} > ${maxBoneIndex} at vertex ${i}`);
      sum += w;
    }
    assert.ok(Math.abs(sum - 1.0) <= 1e-3, `Vertex ${i} weight sum ${sum} != 1.0`);
  }
}

await test('1. Humanoid armature & visualizer preserve hierarchy and scale adaptively', () => {
  const scene = new THREE.Scene();
  const rigSystem = new RigSystem({ scene, THREE });
  const rig = rigSystem.createHumanoidArmature(1.8);
  scene.add(rig.armatureGroup);

  // Every bone except Hips must remain a direct child of its parent bone
  for (const b of rig.bones) {
    if (b.name !== 'Hips') {
      assert.ok(b.parent?.isBone, `Bone ${b.name} lost bone parent`);
      assert.ok(b.parent.children.includes(b), `Parent missing bone ${b.name}`);
    }
  }

  // Test adaptive visualizer scaling on a 0.01-scaled Mixamo-like rig
  const tinyRoot = new THREE.Group();
  tinyRoot.scale.setScalar(0.01);
  const t0 = new THREE.Bone(); t0.name = 'mixamorigHips'; t0.position.set(0, 95, 0);
  const t1 = new THREE.Bone(); t1.name = 'mixamorigSpine'; t1.position.set(0, 20, 0);
  const t2 = new THREE.Bone(); t2.name = 'mixamorigHead'; t2.position.set(0, 30, 0);
  t0.add(t1); t1.add(t2);
  tinyRoot.add(t0);
  const tinySkel = new THREE.Skeleton([t0, t1, t2]);
  scene.add(tinyRoot);
  tinyRoot.updateMatrixWorld(true);

  const vis = rigSystem.createSkeletonVisualizer(tinySkel, tinyRoot);
  assert.ok(vis, 'SkeletonHelper returned for tiny rig');
  const firstJoint = t0.children.find((c) => c.userData?.isBoneJoint);
  assert.ok(firstJoint, 'Joint handle attached to tiny bone');
  const radiusLocal = firstJoint.geometry.parameters.radius;
  // Median bone len in tiny local space is ~25, so local handle radius should scale up proportionally (> 0.4, vs old fixed 0.038)!
  assert.ok(radiusLocal >= 0.4, `Expected scaled local handle radius >= 0.4, got ${radiusLocal}`);
});

await test('2. Edit Bone Mode (add, extrude, reparent cycle guard, delete remap + Undo/Redo)', () => {
  const scene = new THREE.Scene();
  const sm = createMockSceneManager();
  const rigSystem = new RigSystem({ scene, sceneManager: sm, THREE });
  const { group, skeleton, mesh } = create3BoneChainMesh();
  scene.add(group);
  scene.add(mesh);

  const skinned = rigSystem.autoSkinMesh(mesh, { skeleton });
  assert.ok(skinned?.isSkinnedMesh, 'Auto-skinned test mesh created');

  assert.equal(rigSystem.enterEditBoneMode(skinned), true);
  const baseCount = skeleton.bones.length;

  // Extrude from Mid bone (index 1)
  const midBone = skeleton.bones[1];
  const newBone = rigSystem.extrudeBone(midBone, [0.25, 0, 0], 'ArmBranch');
  assert.ok(newBone, 'extrudeBone created child bone');
  assert.equal(skeleton.bones.length, baseCount + 1);
  assert.equal(newBone.parent, midBone);

  // Rename bone (reject duplicates, accept unique)
  assert.equal(rigSystem.renameBone(newBone, 'Mid'), false);
  assert.equal(rigSystem.renameBone(newBone, 'LeftBranch'), true);
  assert.equal(newBone.name, 'LeftBranch');

  // Symmetrize X across added RightBranch
  const rightBone = rigSystem.addBone(midBone, 'RightBranch', [0.99, 0, 0]);
  assert.ok(rightBone);
  const mirroredCount = rigSystem.symmetrizeBones('left_to_right');
  assert.ok(mirroredCount >= 1);
  assert.ok(Math.abs(rightBone.position.x + 0.25) < 1e-4, `Expected RightBranch.x=-0.25, got ${rightBone.position.x}`);

  // Cycle rejection & valid reparent
  assert.equal(rigSystem.reparentBone('Root', 'Mid'), false, 'Should reject cycle Root -> Mid');
  const beforeWorld = new THREE.Vector3();
  rightBone.updateMatrixWorld(true);
  beforeWorld.setFromMatrixPosition(rightBone.matrixWorld);
  assert.equal(rigSystem.reparentBone(rightBone, 'Root'), true);
  const afterWorld = new THREE.Vector3();
  rightBone.updateMatrixWorld(true);
  afterWorld.setFromMatrixPosition(rightBone.matrixWorld);
  assert.ok(beforeWorld.distanceTo(afterWorld) < 1e-4, 'World position preserved on reparent');

  // Delete Mid bone (has child Tip + LeftBranch) -> remaps skinIndex safely & re-parents children
  const preDelCount = skeleton.bones.length;
  assert.equal(rigSystem.deleteBone(midBone), true);
  assert.equal(skeleton.bones.length, preDelCount - 1);
  assertNormalizedWeights(skinned.geometry, skeleton.bones.length - 1);

  // Undo Delete Bone -> bone count returns to preDelCount and original weights return
  assert.equal(sm.undo(), true);
  assert.equal(skeleton.bones.length, preDelCount);
  assertNormalizedWeights(skinned.geometry, skeleton.bones.length - 1);

  // Redo Delete Bone
  assert.equal(sm.redo(), true);
  assert.equal(skeleton.bones.length, preDelCount - 1);

  assert.equal(rigSystem.exitEditBoneMode(), true);
  assert.equal(rigSystem.isEditBoneMode, false);
});

await test('3. autoSkinMesh enforces lateral X-side separation, normalization, and skin deformation', () => {
  const scene = new THREE.Scene();
  const rigSystem = new RigSystem({ scene, THREE });
  const hips = new THREE.Bone(); hips.name = 'Hips'; hips.position.set(0, 0.9, 0);
  const lLeg = new THREE.Bone(); lLeg.name = 'LeftUpLeg'; lLeg.position.set(0.15, -0.1, 0);
  const lKnee = new THREE.Bone(); lKnee.name = 'LeftLeg'; lKnee.position.set(0, -0.45, 0);
  const rLeg = new THREE.Bone(); rLeg.name = 'RightUpLeg'; rLeg.position.set(-0.15, -0.1, 0);
  const rKnee = new THREE.Bone(); rKnee.name = 'RightLeg'; rKnee.position.set(0, -0.45, 0);
  hips.add(lLeg); lLeg.add(lKnee);
  hips.add(rLeg); rLeg.add(rKnee);
  const skeleton = new THREE.Skeleton([hips, lLeg, lKnee, rLeg, rKnee]);
  const armGroup = new THREE.Group();
  armGroup.add(hips);
  scene.add(armGroup);

  // Build two adjacent leg cylinders merged into a single test mesh
  const boxL = new THREE.BoxGeometry(0.12, 0.7, 0.12, 4, 8, 4);
  boxL.translate(0.15, 0.45, 0);
  const boxR = new THREE.BoxGeometry(0.12, 0.7, 0.12, 4, 8, 4);
  boxR.translate(-0.15, 0.45, 0);
  const posL = boxL.attributes.position.array;
  const posR = boxR.attributes.position.array;
  const merged = new THREE.BufferGeometry();
  const combined = new Float32Array(posL.length + posR.length);
  combined.set(posL, 0);
  combined.set(posR, posL.length);
  merged.setAttribute('position', new THREE.BufferAttribute(combined, 3));
  const mesh = new THREE.Mesh(merged, new THREE.MeshStandardMaterial());
  scene.add(mesh);

  const skinned = rigSystem.autoSkinMesh(mesh, { skeleton });
  assert.ok(skinned?.isSkinnedMesh);
  assertNormalizedWeights(skinned.geometry, skeleton.bones.length - 1);

  // Check vertex on +X side has stronger Left bone weights than Right bone weights
  const idxAttr = skinned.geometry.attributes.skinIndex;
  const wAttr = skinned.geometry.attributes.skinWeight;
  let leftBoneWeightOnPlusX = 0;
  let rightBoneWeightOnPlusX = 0;
  for (let s = 0; s < 4; s++) {
    const bi = idxAttr.getComponent(0, s);
    const w = wAttr.getComponent(0, s);
    if (bi === 1 || bi === 2) leftBoneWeightOnPlusX += w;
    if (bi === 3 || bi === 4) rightBoneWeightOnPlusX += w;
  }
  assert.ok(
    leftBoneWeightOnPlusX > rightBoneWeightOnPlusX,
    `Left leg weight (${leftBoneWeightOnPlusX.toFixed(3)}) must exceed Right leg weight (${rightBoneWeightOnPlusX.toFixed(3)}) on +X vertex`
  );

  // Verify skinned ankle vertex moves when LeftUpLeg rotates (must call skeleton.update() in headless Node)
  let ankleVert = 0;
  for (let i = 0; i < posAttrLen(skinned); i++) {
    if (skinned.geometry.attributes.position.getX(i) > 0.05 && skinned.geometry.attributes.position.getY(i) < 0.25) {
      ankleVert = i;
      break;
    }
  }
  function posAttrLen(m) { return m.geometry.attributes.position.count; }
  skinned.skeleton.update();
  const beforeV = skinned.getVertexPosition(ankleVert, new THREE.Vector3());
  lLeg.rotation.x = -Math.PI / 3;
  armGroup.updateMatrixWorld(true);
  skinned.skeleton.update();
  const afterV = skinned.getVertexPosition(ankleVert, new THREE.Vector3());
  assert.ok(beforeV.distanceTo(afterV) > 0.1, `Vertex must deform when weighted bone rotates (delta=${beforeV.distanceTo(afterV).toFixed(4)})`);
});

await test('4. Weight Paint modes (add/subtract/replace/smooth/symmetryX), tools & Undo/Redo', () => {
  const scene = new THREE.Scene();
  const sm = createMockSceneManager();
  const rigSystem = new RigSystem({ scene, sceneManager: sm, THREE });
  const hips = new THREE.Bone(); hips.name = 'Hips'; hips.position.set(0, 0, 0);
  const lArm = new THREE.Bone(); lArm.name = 'LeftArm'; lArm.position.set(0.3, 0, 0);
  const rArm = new THREE.Bone(); rArm.name = 'RightArm'; rArm.position.set(-0.3, 0, 0);
  hips.add(lArm); hips.add(rArm);
  const skeleton = new THREE.Skeleton([hips, lArm, rArm]);
  const rootGroup = new THREE.Group();
  rootGroup.add(hips);
  scene.add(rootGroup);

  const geom = new THREE.PlaneGeometry(1.0, 0.5, 10, 4);
  const nVerts = geom.attributes.position.count;
  const skinIndices = new Uint16Array(nVerts * 4);
  const skinWeights = new Float32Array(nVerts * 4);
  for (let i = 0; i < nVerts; i++) {
    skinIndices[i * 4 + 0] = 0; // 100% Hips initially
    skinWeights[i * 4 + 0] = 1.0;
  }
  geom.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(skinIndices, 4));
  geom.setAttribute('skinWeight', new THREE.Float32BufferAttribute(skinWeights, 4));
  const origMat = new THREE.MeshStandardMaterial({ color: 0xffffff });
  const skinnedMesh = new THREE.SkinnedMesh(geom, origMat);
  skinnedMesh.bind(skeleton);
  scene.add(skinnedMesh);

  assert.equal(rigSystem.enableWeightPaintMode(skinnedMesh, lArm), true);
  assert.ok(geom.attributes.color, 'Weight paint heatmap vertex color attribute generated');
  assert.notEqual(skinnedMesh.material, origMat, 'Weight Paint material applied');

  // Paint LeftArm at x=+0.3, y=0 with symmetryX -> should paint BOTH LeftArm (+0.3) and RightArm (-0.3)
  const res = rigSystem.paintWeight(skinnedMesh, lArm, new THREE.Vector3(0.3, 0, 0), 0.25, 1.0, 'add', { symmetryX: true });
  assert.ok(res.updatedVertices > 0);
  assertNormalizedWeights(geom, 2);

  // Confirm symmetry painted RightArm on negative X vertices
  const pos = geom.attributes.position;
  let rightArmMaxW = 0;
  for (let i = 0; i < nVerts; i++) {
    if (pos.getX(i) < -0.2) {
      rightArmMaxW = Math.max(rightArmMaxW, rigSystem._getVertexBoneWeight(geom.attributes.skinIndex, geom.attributes.skinWeight, i, 2));
    }
  }
  assert.ok(rightArmMaxW > 0.5, `Expected mirror symmetryX to raise RightArm weight > 0.5, got ${rightArmMaxW}`);

  // Test Subtract mode on a 100%-weighted vertex
  const subRes = rigSystem.paintWeight(skinnedMesh, lArm, new THREE.Vector3(0.3, 0, 0), 0.25, 0.8, 'subtract', { symmetryX: false });
  assert.ok(subRes.updatedVertices > 0);
  let leftAfterSub = 1.0;
  for (let i = 0; i < nVerts; i++) {
    if (Math.hypot(pos.getX(i) - 0.3, pos.getY(i)) < 0.08) {
      leftAfterSub = Math.min(leftAfterSub, rigSystem._getVertexBoneWeight(geom.attributes.skinIndex, geom.attributes.skinWeight, i, 1));
    }
  }
  assert.ok(leftAfterSub < 0.5, `Expected subtract to drop LeftArm weight below 0.5, got ${leftAfterSub}`);
  assertNormalizedWeights(geom, 2);

  // Test Replace & Smooth modes + smoothWeights & mirrorWeightsX & WeightPaintCommand Undo/Redo
  rigSystem.paintWeight(skinnedMesh, lArm, new THREE.Vector3(0.3, 0, 0), 0.2, 0.75, 'replace');
  rigSystem.paintWeight(skinnedMesh, lArm, new THREE.Vector3(0.3, 0, 0), 0.3, 0.5, 'smooth');
  assertNormalizedWeights(geom, 2);

  const smoothRes = rigSystem.smoothWeights(skinnedMesh, lArm, 1, 0.5, true);
  assert.equal(smoothRes.updatedVertices, nVerts);
  assert.equal(sm.undoStack.length, 1);

  const beforeUndoW = rigSystem._getVertexBoneWeight(geom.attributes.skinIndex, geom.attributes.skinWeight, 0, 1);
  assert.equal(sm.undo(), true);
  assert.equal(sm.redo(), true);
  const afterRedoW = rigSystem._getVertexBoneWeight(geom.attributes.skinIndex, geom.attributes.skinWeight, 0, 1);
  assert.ok(Math.abs(beforeUndoW - afterRedoW) < 1e-6);

  // Mirror Left -> Right across mesh + corrupt weight repair via normalizeWeights
  const mirRes = rigSystem.mirrorWeightsX(skinnedMesh, 'left', 0.15, true);
  assert.ok(mirRes.mirroredVertices > 0);
  geom.attributes.skinWeight.setXYZW(0, 2.0, -0.5, 9.0, 0.0);
  geom.attributes.skinIndex.setXYZW(0, 99, 0, 1, 0);
  const normRes = rigSystem.normalizeWeights(skinnedMesh, true);
  assert.ok(normRes.normalizedCount >= 1);
  assertNormalizedWeights(geom, 2);

  assert.equal(rigSystem.disableWeightPaintMode(), false);
  assert.equal(skinnedMesh.material, origMat, 'Original material restored on exit');
});

await test('5. Two-Bone IK handles 180-deg collinear vectors, UE5 aliases, Pose Engine & Bake', () => {
  const scene = new THREE.Scene();
  const rigSystem = new RigSystem({ scene, THREE });

  // Build UE5-named arm chain straight along +Y so target at -Y tests 180-deg flip guard
  const root = new THREE.Group();
  const upper = new THREE.Bone(); upper.name = 'upperarm_l'; upper.position.set(0, 1.5, 0);
  const mid = new THREE.Bone(); mid.name = 'lowerarm_l'; mid.position.set(0, 0.3, 0);
  const end = new THREE.Bone(); end.name = 'hand_l'; end.position.set(0, 0.3, 0);
  upper.add(mid); mid.add(end); root.add(upper); scene.add(root);
  root.updateMatrixWorld(true);

  const solved = rigSystem.solveTwoBoneIK(upper, mid, end, new THREE.Vector3(0, 0.95, 0), new THREE.Vector3(0, 1.2, -0.5));
  assert.equal(solved, true);
  end.updateMatrixWorld(true);
  const endPos = new THREE.Vector3().setFromMatrixPosition(end.matrixWorld);
  assert.ok(Number.isFinite(endPos.x) && Number.isFinite(endPos.y) && Number.isFinite(endPos.z), 'IK result finite at 180 deg');
  assert.ok(endPos.distanceTo(new THREE.Vector3(0, 0.95, 0)) < 0.08, `End effector reached target closely (dist=${endPos.distanceTo(new THREE.Vector3(0, 0.95, 0)).toFixed(3)})`);

  // Check Pose Engine + PoseChangeCommand + ManualPoseEditor bakeToClip on procedural humanoid
  const rig = rigSystem.createHumanoidArmature(1.8);
  scene.add(rig.armatureGroup);
  const poseBones = rig.skeleton.bones;
  const beforeQuats = poseBones.map(b => b.quaternion.clone());
  const beforePos = poseBones.map(b => b.position.clone());

  assert.equal(rigSystem.applyPose(rig.armatureGroup, 'military_salute'), true);
  const afterQuats = poseBones.map(b => b.quaternion.clone());
  const afterPos = poseBones.map(b => b.position.clone());
  const rArm = rig.boneMap.get('RightArm');
  assert.ok(rArm.quaternion.angleTo(beforeQuats[poseBones.indexOf(rArm)]) > 0.1, 'Pose changed RightArm rotation');

  const cmd = new PoseChangeCommand(rig.skeleton, beforeQuats, afterQuats, beforePos, afterPos, null, 'Pose');
  cmd.undo();
  assert.ok(rArm.quaternion.angleTo(beforeQuats[poseBones.indexOf(rArm)]) < 1e-5, 'PoseChangeCommand undo restored rest');
  cmd.execute();
  assert.ok(rArm.quaternion.angleTo(afterQuats[poseBones.indexOf(rArm)]) < 1e-5, 'PoseChangeCommand redo restored pose');

  rigSystem.mirrorPose(rig.armatureGroup, 'right_to_left');
  const lArm = rig.boneMap.get('LeftArm');
  assert.ok(lArm.quaternion.angleTo(new THREE.Quaternion()) > 0.1, 'mirrorPose mirrored Right -> Left');
  rigSystem.resetPose(rig.armatureGroup);
  assert.ok(lArm.quaternion.angleTo(new THREE.Quaternion()) < 1e-5, 'resetPose restored identity');

  // Verify setupTwoBoneIK resolves UE5 aliases cleanly
  const ueRoot = new THREE.Group();
  const uThigh = new THREE.Bone(); uThigh.name = 'thigh_l'; uThigh.position.set(0.1, 0.9, 0);
  const uCalf = new THREE.Bone(); uCalf.name = 'calf_l'; uCalf.position.set(0, -0.42, 0);
  const uFoot = new THREE.Bone(); uFoot.name = 'foot_l'; uFoot.position.set(0, -0.40, 0);
  uThigh.add(uCalf); uCalf.add(uFoot); ueRoot.add(uThigh);
  const ueSkel = new THREE.Skeleton([uThigh, uCalf, uFoot]);
  ueRoot.userData.skeleton = ueSkel;
  scene.add(ueRoot);
  rigSystem.setupTwoBoneIK(ueRoot);
  assert.ok(rigSystem.ikChains.has('leftLeg'), 'setupTwoBoneIK resolved UE5 thigh_l/calf_l/foot_l chain');

  // Verify ManualPoseEditor bakes manually adjusted pose cleanly into an AnimationClip
  const mpe = new ManualPoseEditor({ scene }, null);
  assert.equal(mpe.setCharacter(rig.armatureGroup), true);
  const mpeLArm = mpe.bones.get('leftArm');
  assert.ok(mpeLArm, 'ManualPoseEditor mapped LeftArm');
  mpeLArm.rotation.z = 0.75;
  const clip = mpe.bakeToClip('TestManual');
  assert.ok(clip && clip.tracks.length >= 10, `Expected clip tracks >= 10, got ${clip?.tracks?.length}`);
  const lArmTrack = clip.tracks.find((t) => t.name === 'LeftArm.quaternion');
  assert.ok(lArmTrack, 'Baked clip contains LeftArm.quaternion track');
  mpe.dispose();
});

await test('6. System hygiene (Joint_*/Octa_*/IK handles), boneDisplayMode & Weight Paint color cleanup', async () => {
  const scene = new THREE.Scene();
  const rigSystem = new RigSystem({ THREE, scene });
  const { armatureGroup, skeleton } = rigSystem.createRiggedMannequin(1.8, { skinned: true });
  scene.add(armatureGroup);
  rigSystem.createSkeletonVisualizer(skeleton, armatureGroup);

  assert.ok(rigSystem.skeletonHelper, 'Skeleton visualizer group created');
  assert.equal(rigSystem.skeletonHelper.userData.isSystemObject, true, 'SkeletonHelper marked isSystemObject');
  assert.equal(rigSystem.skeletonHelper.userData.isHelper, true, 'SkeletonHelper marked isHelper');
  let jointCount = 0;
  let octaCount = 0;
  let firstOcta = null;
  armatureGroup.traverse((obj) => {
    if (obj.name.startsWith('Joint_')) {
      jointCount++;
      assert.equal(obj.userData.isSystemObject, true, `${obj.name} marked isSystemObject`);
      assert.equal(obj.userData.isHelper, true, `${obj.name} marked isHelper`);
      assert.equal(obj.userData.selectable, false, `${obj.name} selectable=false`);
    }
    if (obj.name.startsWith('Octa_')) {
      if (!firstOcta) firstOcta = obj;
      octaCount++;
      assert.equal(obj.userData.isSystemObject, true, `${obj.name} marked isSystemObject`);
      assert.equal(obj.userData.isHelper, true, `${obj.name} marked isHelper`);
      assert.equal(obj.userData.selectable, false, `${obj.name} selectable=false`);
    }
  });
  assert.ok(jointCount > 10 && octaCount > 10, `Found ${jointCount} joints and ${octaCount} octahedra`);

  rigSystem.setBoneDisplayMode('stick');
  assert.equal(firstOcta.visible, false, 'Stick display mode hides Octahedral bone shapes');
  rigSystem.setBoneDisplayMode('hidden');
  assert.equal(rigSystem.skeletonHelper.visible, false, 'Hidden mode hides skeleton visualizer');
  rigSystem.setBoneDisplayMode('octahedral');
  assert.equal(rigSystem.skeletonHelper.visible, true, 'Octahedral mode restores skeleton visibility');

  rigSystem.setupTwoBoneIK(armatureGroup);
  rigSystem.ikHandlesGroup.traverse((o) => {
    if (o.userData?.isIKHandle) {
      assert.equal(o.userData.isSystemObject, true, `${o.name} IK handle marked isSystemObject`);
      assert.equal(o.userData.isHelper, true, `${o.name} IK handle marked isHelper`);
    }
  });

  // Weight paint mode should remove temporary vertex color attribute upon exit
  const skinned = armatureGroup.getObjectByProperty('isSkinnedMesh', true);
  assert.equal(Boolean(skinned.geometry.attributes.color), false, 'Initially no vertex color attribute');
  rigSystem.enableWeightPaintMode(skinned, 'LeftArm');
  assert.equal(Boolean(skinned.geometry.attributes.color), true, 'Weight paint creates heatmap color attribute');
  rigSystem.disableWeightPaintMode();
  assert.equal(Boolean(skinned.geometry.attributes.color), false, 'Exiting Weight Paint cleans up temporary color attribute');
});

await test('7. Geodesic Bone Heat isolation, cleanWeights, transferWeights & AutoSkinCommand Undo/Redo', async () => {
  const scene = new THREE.Scene();
  const sm = createMockSceneManager();
  const rigSystem = new RigSystem({ THREE, scene, sceneManager: sm });

  // Build simple spine + left arm hanging closely beside torso (5 cm air gap!)
  const root = new THREE.Group();
  const bSpine = new THREE.Bone(); bSpine.name = 'Spine'; bSpine.position.set(0, 1.0, 0);
  const bChest = new THREE.Bone(); bChest.name = 'Spine2'; bChest.position.set(0, 0.4, 0);
  const bArm = new THREE.Bone(); bArm.name = 'LeftArm'; bArm.position.set(0.22, 0.05, 0);
  const bElbow = new THREE.Bone(); bElbow.name = 'LeftForeArm'; bElbow.position.set(0, -0.35, 0);
  bSpine.add(bChest);
  bChest.add(bArm);
  bArm.add(bElbow);
  root.add(bSpine);
  const skel = new THREE.Skeleton([bSpine, bChest, bArm, bElbow]);
  root.updateMatrixWorld(true);
  skel.calculateInverses();
  scene.add(root);

  // Merge Torso box (x in [-0.14, 0.14], y in [0.95, 1.45]) and close Arm sleeve (x in [0.19, 0.25], y in [1.05, 1.45])
  const torsoG = new THREE.BoxGeometry(0.28, 0.50, 0.22, 4, 6, 4);
  torsoG.translate(0, 1.20, 0);
  const armG = new THREE.BoxGeometry(0.06, 0.40, 0.06, 2, 6, 2);
  armG.translate(0.22, 1.25, 0);

  const tp = torsoG.attributes.position.array;
  const ap = armG.attributes.position.array;
  const posArr = new Float32Array(tp.length + ap.length);
  posArr.set(tp, 0); posArr.set(ap, tp.length);
  const tIdx = torsoG.index.array;
  const aIdx = armG.index.array;
  const idxArr = new Uint32Array(tIdx.length + aIdx.length);
  idxArr.set(tIdx, 0);
  const vOff = torsoG.attributes.position.count;
  for (let i = 0; i < aIdx.length; i++) idxArr[tIdx.length + i] = aIdx[i] + vOff;

  const merged = new THREE.BufferGeometry();
  merged.setAttribute('position', new THREE.BufferAttribute(posArr, 3));
  merged.setIndex(new THREE.BufferAttribute(idxArr, 1));
  const rawMesh = new THREE.Mesh(merged, new THREE.MeshStandardMaterial());
  rawMesh.name = 'TorsoAndCloseArm';
  scene.add(rawMesh);
  sm.addObject(rawMesh);

  const skinned = rigSystem.autoSkinMesh(rawMesh, skel);
  assert.ok(skinned && skinned.isSkinnedMesh, 'autoSkinMesh returned SkinnedMesh');
  assert.equal(sm.undoStack.length, 1, 'AutoSkinCommand recorded on undoStack');
  assert.ok(sm.undoStack[0] instanceof AutoSkinCommand);

  // Check Torso right wall (x > 0.12, x < 0.15) has minimal bleed from LeftArm/LeftForeArm
  const posAttr = skinned.geometry.attributes.position;
  const sIdx = skinned.geometry.attributes.skinIndex;
  const sW = skinned.geometry.attributes.skinWeight;
  let torsoWallTested = 0;
  let maxArmBleedOnTorso = 0;
  for (let i = 0; i < vOff; i++) {
    if (posAttr.getX(i) > 0.12 && posAttr.getY(i) < 1.32) {
      torsoWallTested++;
      let armWeight = 0;
      for (let s = 0; s < 4; s++) {
        const bi = sIdx.getComponent(i, s);
        if (bi === 2 || bi === 3) armWeight += sW.getComponent(i, s);
      }
      if (armWeight > maxArmBleedOnTorso) maxArmBleedOnTorso = armWeight;
    }
  }
  assert.ok(torsoWallTested > 0, 'Checked torso outer rib vertices next to arm');
  assert.ok(maxArmBleedOnTorso < 0.10, `Geodesic Bone Heat isolated Torso from adjacent Arm (maxArmBleed=${maxArmBleedOnTorso.toFixed(3)})`);

  // Verify Undo/Redo restores original rawMesh then re-applies skinnedMesh
  sm.undo();
  assert.equal(scene.children.includes(rawMesh), true, 'Undo restored raw Mesh');
  sm.redo();
  assert.equal(scene.children.includes(skinned), true, 'Redo restored SkinnedMesh');

  // Verify cleanWeights prunes sub-threshold weights & caps max influences
  sIdx.setXYZW(0, 0, 1, 2, 3);
  sW.setXYZW(0, 0.90, 0.08, 0.015, 0.005);
  rigSystem.cleanWeights(skinned, 0.02, 2, true);
  let activeSlots = 0;
  let sum0 = 0;
  for (let s = 0; s < 4; s++) {
    const w = sW.getComponent(0, s);
    if (w > 1e-6) activeSlots++;
    sum0 += w;
  }
  assert.ok(activeSlots <= 2, `cleanWeights capped influences to <=2 (got ${activeSlots})`);
  assert.ok(Math.abs(sum0 - 1.0) < 1e-4, 'cleanWeights renormalized weight sum to 1.0');

  // Verify transferWeights copies torso weights onto a jacket mesh
  const shirtGeom = new THREE.BoxGeometry(0.32, 0.42, 0.26, 4, 6, 4);
  shirtGeom.translate(0, 1.20, 0);
  const shirtRaw = new THREE.Mesh(shirtGeom, new THREE.MeshStandardMaterial());
  shirtRaw.name = 'Jacket';
  scene.add(shirtRaw);
  const shirtSkinned = rigSystem.transferWeights(skinned, shirtRaw);
  assert.ok(shirtSkinned && shirtSkinned.isSkinnedMesh, 'transferWeights created bound SkinnedMesh');
  assert.equal(shirtSkinned.skeleton, skinned.skeleton, 'Transferred shirt shares source skeleton');
});

await test('8. Mannequin skinned arm-to-bone alignment, multi-convention Symmetrize & Bone Roll', async () => {
  const scene = new THREE.Scene();
  const rigSystem = new RigSystem({ THREE, scene });
  const { armatureGroup, boneMap } = rigSystem.createRiggedMannequin(1.8, { skinned: true });
  scene.add(armatureGroup);
  armatureGroup.updateMatrixWorld(true);

  const skinned = armatureGroup.getObjectByProperty('isSkinnedMesh', true);
  assert.ok(skinned, 'Mannequin skinned mesh created');
  const pos = skinned.geometry.attributes.position;
  const lArmPos = new THREE.Vector3().setFromMatrixPosition(boneMap.get('LeftArm').matrixWorld);
  const lForePos = new THREE.Vector3().setFromMatrixPosition(boneMap.get('LeftForeArm').matrixWorld);
  const armMid = lArmPos.clone().lerp(lForePos, 0.5);

  let minArmVertDist = Infinity;
  const tmp = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    tmp.fromBufferAttribute(pos, i);
    const d = tmp.distanceTo(armMid);
    if (d < minArmVertDist) minArmVertDist = d;
  }
  assert.ok(minArmVertDist < 0.08, `Mannequin skinned upper arm wraps LeftArm bone at y=${armMid.y.toFixed(2)} (minDist=${minArmVertDist.toFixed(3)})`);

  // Multi-convention side detection & .L/.R symmetrize + setBoneRoll preserving child world pos
  assert.equal(RigSystem.detectBoneSide('clavicle_l'), 1);
  assert.equal(RigSystem.detectBoneSide('clavicle_r'), -1);
  assert.equal(RigSystem.detectBoneSide('Arm.L.001'), 1);
  assert.equal(RigSystem.detectBoneSide('J_Bip_R_Hand'), -1);
  assert.equal(RigSystem.detectBoneSide('Spine2'), 0);

  const armRoot = new THREE.Group();
  const lB = new THREE.Bone(); lB.name = 'shoulder.L'; lB.position.set(0.2, 1.5, 0);
  const lChild = new THREE.Bone(); lChild.name = 'hand.L'; lChild.position.set(0.3, 0, 0);
  const rB = new THREE.Bone(); rB.name = 'shoulder.R'; rB.position.set(-0.15, 1.4, 0);
  lB.add(lChild); armRoot.add(lB); armRoot.add(rB);
  const sLR = new THREE.Skeleton([lB, lChild, rB]);
  armRoot.userData.skeleton = sLR;
  scene.add(armRoot);

  rigSystem.enterEditBoneMode(armRoot);
  lB.position.set(0.38, 1.52, 0.04);
  const mirrored = rigSystem.symmetrizeBones('left_to_right');
  assert.equal(mirrored, 1, 'Symmetrized .L -> .R across X=0');
  assert.ok(Math.abs(rB.position.x + 0.38) < 1e-4 && Math.abs(rB.position.y - 1.52) < 1e-4, 'Mirrored bone coordinates exact');

  lChild.updateMatrixWorld(true);
  const childWorldBefore = new THREE.Vector3().setFromMatrixPosition(lChild.matrixWorld);
  rigSystem.setBoneRoll(lB, Math.PI / 4, { recordUndo: false });
  lChild.updateMatrixWorld(true);
  const childWorldAfter = new THREE.Vector3().setFromMatrixPosition(lChild.matrixWorld);
  assert.ok(childWorldBefore.distanceTo(childWorldAfter) < 1e-4, 'setBoneRoll rotates bone axis without moving child tip');
});

await test('9. Pin-Feet IK during Hips drag + alignEndBone + Bone Constraints Engine', async () => {
  const scene = new THREE.Scene();
  const rigSystem = new RigSystem({ THREE, scene });
  const { armatureGroup, boneMap } = rigSystem.createHumanoidArmature(1.8);
  scene.add(armatureGroup);
  rigSystem.setupTwoBoneIK(armatureGroup);
  rigSystem.setIKEnabled(true);
  rigSystem.setPinFeetIK(true);

  const hips = boneMap.get('Hips');
  const leftKnee = boneMap.get('LeftLeg');
  const leftFoot = boneMap.get('LeftFoot');
  const rightFoot = boneMap.get('RightFoot');
  leftFoot.updateMatrixWorld(true);
  rightFoot.updateMatrixWorld(true);

  const lFootBefore = new THREE.Vector3().setFromMatrixPosition(leftFoot.matrixWorld);
  const rFootBefore = new THREE.Vector3().setFromMatrixPosition(rightFoot.matrixWorld);
  const lFootQuatBefore = leftFoot.getWorldQuaternion(new THREE.Quaternion());

  // Squat Hips down by 20 cm and trigger foot-pinned IK update
  hips.position.y -= 0.20;
  rigSystem.onBoneRotated(hips);
  leftFoot.updateMatrixWorld(true);
  rightFoot.updateMatrixWorld(true);

  const lFootAfter = new THREE.Vector3().setFromMatrixPosition(leftFoot.matrixWorld);
  const rFootAfter = new THREE.Vector3().setFromMatrixPosition(rightFoot.matrixWorld);
  const lFootQuatAfter = leftFoot.getWorldQuaternion(new THREE.Quaternion());

  assert.ok(lFootAfter.distanceTo(lFootBefore) < 0.015, `Left foot stayed pinned on crouch (drift=${lFootAfter.distanceTo(lFootBefore).toFixed(4)})`);
  assert.ok(rFootAfter.distanceTo(rFootBefore) < 0.015, `Right foot stayed pinned on crouch (drift=${rFootAfter.distanceTo(rFootBefore).toFixed(4)})`);
  assert.ok(leftKnee.quaternion.angleTo(new THREE.Quaternion()) > 0.35, 'Knee flexed naturally while Hips crouched');
  assert.ok(lFootQuatAfter.angleTo(lFootQuatBefore) < 0.05, 'alignEndBone preserved flat foot floor orientation');

  // Test Constraints: Humanoid Limits, Copy Rotation, Track To
  rigSystem.setIKEnabled(false);
  rigSystem.resetPose(armatureGroup);
  const limited = rigSystem.applyHumanoidJointLimits(armatureGroup);
  assert.ok(limited >= 10, `Applied anatomical limits to ${limited} bones`);

  leftKnee.rotation.set(-1.0, 0.5, 0, 'XYZ'); // Hyperextend knee backwards (-57 deg)
  rigSystem.evaluateConstraints(armatureGroup);
  assert.ok(leftKnee.rotation.x >= -0.02, `Limit Rotation stopped knee hyperextension (x=${(leftKnee.rotation.x * 180 / Math.PI).toFixed(1)} deg)`);

  const lArm = boneMap.get('LeftArm');
  const rArm = boneMap.get('RightArm');
  rigSystem.addBoneConstraint(rArm, {
    type: 'copyRotation',
    targetBone: 'LeftArm',
    invert: { y: true, z: true },
  });
  lArm.rotation.set(0.4, 0.25, -0.5, 'XYZ');
  rigSystem.evaluateConstraints(armatureGroup);
  assert.ok(Math.abs(rArm.rotation.x - 0.4) < 0.05 && Math.abs(rArm.rotation.z - 0.5) < 0.05, 'Copy Rotation mirrored LeftArm -> RightArm');

  const lookTarget = new THREE.Object3D();
  lookTarget.position.set(1.5, 1.74, 1.5);
  scene.add(lookTarget);
  const head = boneMap.get('Head');
  rigSystem.clearBoneConstraints(head);
  rigSystem.addBoneConstraint(head, {
    type: 'trackTo',
    targetBone: lookTarget,
    forwardAxis: 'Z',
  });
  rigSystem.evaluateConstraints(armatureGroup);
  head.updateMatrixWorld(true);
  const headFwd = new THREE.Vector3(0, 0, 1).applyQuaternion(head.getWorldQuaternion(new THREE.Quaternion()));
  const expectedDir = lookTarget.position.clone().sub(new THREE.Vector3().setFromMatrixPosition(head.matrixWorld)).normalize();
  assert.ok(headFwd.dot(expectedDir) > 0.98, `TrackTo aimed head toward target (dot=${headFwd.dot(expectedDir).toFixed(3)})`);
});

await test('10. Keyframe Pose to Timeline (I / Shift+I) & Non-Destructive Rig Bake to AnimationClip', async () => {
  const scene = new THREE.Scene();
  const rigSystem = new RigSystem({ THREE, scene });
  const tl = new TimelineEngine({ fps: 30, startFrame: 0, endFrame: 30 });
  rigSystem.timelineEngine = tl;

  const { armatureGroup, boneMap } = rigSystem.createRiggedMannequin(1.8, { skinned: true });
  scene.add(armatureGroup);
  const hips = boneMap.get('Hips');
  const spine = boneMap.get('Spine');

  tl.currentFrame = 0;
  const k0 = rigSystem.keyframePoseToTimeline(armatureGroup, 'all');
  assert.ok(k0.count >= 15 && k0.tracks >= 15, `Keyframed all ${k0.count} bones at frame 0`);

  hips.position.y -= 0.15;
  spine.rotation.x = 0.45;
  tl.currentFrame = 15;
  const k1 = rigSystem.keyframePoseToTimeline(armatureGroup, 'all');
  assert.equal(k1.frame, 15);

  const clip = rigSystem.bakeRigToClip({
    startFrame: 0,
    endFrame: 15,
    fps: 30,
    clipName: 'SquatTest',
    target: armatureGroup,
    onFrame: (f) => {
      hips.position.y = 0.98 - 0.18 * Math.sin((f / 15) * Math.PI);
    },
  });
  assert.ok(clip && clip.tracks.length >= 20, `Baked AnimationClip has ${clip.tracks.length} tracks`);
  const hipsPosTrack = clip.tracks.find(t => t.name === 'Hips.position');
  assert.ok(hipsPosTrack, 'Baked clip contains Hips.position track');
  assert.ok(clip.duration > 0.4, `Clip duration ${clip.duration.toFixed(2)}s valid`);
  assert.ok(Math.abs(spine.rotation.x - 0.45) < 1e-4, 'Bake restored non-destructive pose afterwards');
});

console.log(`\nSUMMARY: ${passed} passed, ${failures.length} failed`);
if (failures.length > 0) process.exit(1);
