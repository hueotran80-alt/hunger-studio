/**
 * Wave 4C Verification Suite:
 * 1. Automatic Weights — Laplacian Cotangent Bone Heat CG solver (occlusion guard, lateral separation, deformation)
 * 2. Vertex Groups — CRUD, EditMode logical<->buffer assign/remove/select/deselect, L<->R mirror, skinWeight sync, Undo/Redo, .wbs round-trip
 * 3. Armature Pro — Connected bones (use_connect), Bone Collections visibility/select/rename, Undo/Redo, .wbs persistence
 * 4. IK / FK Switching — solveTwoBoneIK({ ikBlend }), setChainIKBlend, zero-pop snapIKToFK & snapFKToIK
 * 5. Export Subdivision Levels — SubdivisionModifier viewport vs renderLevels switching via withRenderSubdivisionLevels & VideoExportManager
 */

import assert from 'node:assert/strict';
import * as THREE from 'three';
import { computeLaplacianBoneHeatWeights } from '../js/animation/bone-heat.js';
import {
  ensureVertexGroups,
  addVertexGroup,
  removeVertexGroup,
  renameVertexGroup,
  setActiveVertexGroup,
  assignVerticesToGroup,
  removeVerticesFromGroup,
  selectGroupVertices,
  deselectGroupVertices,
  mirrorVertexGroup,
  getEditModeBufferVertexIndices,
  captureVertexGroupsSnapshot,
  VertexGroupsCommand,
} from '../js/animation/vertex-groups.js';
import { RigSystem } from '../js/animation/rig-system.js';
import { SceneManager } from '../js/core/scene-manager.js';
import { EditMode } from '../js/core/edit-mode.js';
import { StudioExporter } from '../js/exporters/export-import.js';
import {
  applyModifier,
  withRenderSubdivisionLevels,
} from '../js/core/modifiers.js';
import { VideoExportManager } from '../js/render/video-export.js';

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`  FAIL  ${name}\n   `, err?.stack || err);
  }
}

function buildTwoArmTCharacter(scene) {
  const armGroup = new THREE.Group();
  armGroup.name = 'HeatRigArmature';
  armGroup.userData.isArmature = true;

  const hips = new THREE.Bone(); hips.name = 'Hips'; hips.position.set(0, 0.2, 0);
  const spine = new THREE.Bone(); spine.name = 'Spine'; spine.position.set(0, 0.5, 0);
  const lArm = new THREE.Bone(); lArm.name = 'LeftArm'; lArm.position.set(0.25, 0.4, 0);
  const lFore = new THREE.Bone(); lFore.name = 'LeftForeArm'; lFore.position.set(0.55, 0, 0);
  const lHand = new THREE.Bone(); lHand.name = 'LeftHand'; lHand.position.set(0.5, 0, 0);
  const rArm = new THREE.Bone(); rArm.name = 'RightArm'; rArm.position.set(-0.25, 0.4, 0);
  const rFore = new THREE.Bone(); rFore.name = 'RightForeArm'; rFore.position.set(-0.55, 0, 0);
  const rHand = new THREE.Bone(); rHand.name = 'RightHand'; rHand.position.set(-0.5, 0, 0);

  hips.add(spine);
  spine.add(lArm); lArm.add(lFore); lFore.add(lHand);
  spine.add(rArm); rArm.add(rFore); rFore.add(rHand);
  armGroup.add(hips);
  scene.add(armGroup);
  armGroup.updateMatrixWorld(true);

  const skeleton = new THREE.Skeleton([hips, spine, lArm, lFore, lHand, rArm, rFore, rHand]);
  armGroup.userData.skeleton = skeleton;

  // Build combined character mesh: central torso + left arm + right arm
  const parts = [];
  const pushBox = (w, h, d, sx, sy, sz, ox, oy, oz) => {
    const g = new THREE.BoxGeometry(w, h, d, sx, sy, sz);
    g.translate(ox, oy, oz);
    parts.push(g);
  };
  pushBox(0.45, 1.0, 0.25, 4, 8, 2, 0, 0.7, 0);
  pushBox(1.1, 0.18, 0.18, 10, 3, 3, 0.80, 1.1, 0);
  pushBox(1.1, 0.18, 0.18, 10, 3, 3, -0.80, 1.1, 0);

  let totalPos = 0;
  for (const g of parts) {
    const nonIdx = g.index ? g.toNonIndexed() : g;
    nonIdx.computeVertexNormals();
    totalPos += nonIdx.attributes.position.array.length;
    g._nonIdx = nonIdx;
  }
  const posArr = new Float32Array(totalPos);
  const normArr = new Float32Array(totalPos);
  let off = 0;
  for (const g of parts) {
    posArr.set(g._nonIdx.attributes.position.array, off);
    normArr.set(g._nonIdx.attributes.normal.array, off);
    off += g._nonIdx.attributes.position.array.length;
  }
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(posArr, 3));
  geom.setAttribute('normal', new THREE.BufferAttribute(normArr, 3));
  const mesh = new THREE.Mesh(geom, new THREE.MeshStandardMaterial());
  mesh.name = 'HeatHeroMesh';
  scene.add(mesh);

  return { armGroup, skeleton, mesh, bones: { hips, spine, lArm, lFore, lHand, rArm, rFore, rHand } };
}

await test('1. Laplacian Cotangent Bone Heat CG solver separates occluded/lateral parts, normalizes weights, and deforms mesh', () => {
  const scene = new THREE.Scene();
  const sm = new SceneManager(scene);
  const rig = new RigSystem({ scene, sceneManager: sm, THREE });
  const { armGroup, skeleton, mesh, bones } = buildTwoArmTCharacter(scene);

  // Direct CG solver test with occluding wall test
  const box = new THREE.BoxGeometry(0.4, 0.6, 0.4, 4, 4, 4);
  const wallGeom = box.clone();
  wallGeom.computeVertexNormals();
  const occludedTest = computeLaplacianBoneHeatWeights(
    wallGeom,
    [
      { index: 0, startLocal: new THREE.Vector3(0.12, -0.2, 0), endLocal: new THREE.Vector3(0.12, 0.2, 0), side: 'left' },
      { index: 1, startLocal: new THREE.Vector3(-0.12, -0.2, 0), endLocal: new THREE.Vector3(-0.12, 0.2, 0), side: 'right' },
    ],
    {
      isSegmentOccluded: (ox, _oy, _oz, tx) => (ox > 0.02 && tx < -0.02) || (ox < -0.02 && tx > 0.02),
    }
  );
  assert.ok(occludedTest && occludedTest.logicalCount > 8);

  const skinned = rig.autoSkinMesh(mesh, armGroup, { mode: 'heat' });
  assert.ok(skinned?.isSkinnedMesh, 'autoSkinMesh(heat) must produce SkinnedMesh');

  const idxAttr = skinned.geometry.attributes.skinIndex;
  const wAttr = skinned.geometry.attributes.skinWeight;
  const posAttr = skinned.geometry.attributes.position;
  assert.ok(idxAttr && wAttr);

  let checkedLeftTip = 0;
  let handIdx = -1;
  for (let i = 0; i < posAttr.count; i++) {
    let sum = 0;
    let wLeft = 0;
    let wRight = 0;
    for (let s = 0; s < 4; s++) {
      const bi = idxAttr.getComponent(i, s);
      const w = wAttr.getComponent(i, s);
      assert.ok(Number.isFinite(w) && w >= 0 && w <= 1.0001);
      sum += w;
      if (bi === 2 || bi === 3 || bi === 4) wLeft += w;
      if (bi === 5 || bi === 6 || bi === 7) wRight += w;
    }
    assert.ok(Math.abs(sum - 1.0) < 1e-3, `Vertex ${i} weights must sum to 1, got ${sum}`);
    if (posAttr.getX(i) > 1.15) {
      assert.ok(wLeft > 0.9 && wRight < 0.01, `Right arm bleeding onto Left hand tip (${wLeft.toFixed(3)} vs ${wRight.toFixed(3)})`);
      handIdx = i;
      checkedLeftTip++;
    }
  }
  assert.ok(checkedLeftTip > 0 && handIdx >= 0);

  // Vertex Groups should auto-sync after autoSkinMesh
  assert.ok(Array.isArray(skinned.userData?.vertexGroups?.groups));
  assert.equal(skinned.userData.vertexGroups.groups.length, skeleton.bones.length);

  // Deformation check under bone rotation
  skinned.skeleton.update();
  const pBefore = skinned.getVertexPosition(handIdx, new THREE.Vector3());
  bones.lArm.rotation.z = Math.PI / 4;
  armGroup.updateMatrixWorld(true);
  skinned.skeleton.update();
  const pAfter = skinned.getVertexPosition(handIdx, new THREE.Vector3());
  assert.ok(pBefore.distanceTo(pAfter) > 0.35, `Expected large hand tip displacement under LeftArm rotation, got ${pBefore.distanceTo(pAfter)}`);
});

await test('2. Vertex Groups CRUD, EditMode select/assign/remove, L<->R mirror, Undo/Redo & .wbs persistence', async () => {
  const scene = new THREE.Scene();
  const sm = new SceneManager(scene);

  // 2A. EditMode logical <-> buffer vertex selection + assign/remove/select/deselect + Undo/Redo
  const box = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial());
  box.name = 'VG_Box';
  sm.addObject(box, null, false, false);

  const editMode = new EditMode({ scene, sceneManager: sm }, { sceneManager: sm });
  assert.equal(editMode.enter(box), true);
  editMode.selectionMode = 'vertex';
  editMode.selectedVertices.clear();
  // Pick first logical vertex (+X corner)
  const targetLogical = editMode.vertices.findIndex((v) => v.x > 0.4 && v.y > 0.4);
  assert.ok(targetLogical >= 0);
  editMode.selectedVertices.add(targetLogical);

  const bufVerts = getEditModeBufferVertexIndices(editMode, box);
  assert.ok(bufVerts.length >= 1, 'Welded logical corner should resolve to >=1 buffer vertices');

  const vgGrp = addVertexGroup(box, 'CornerPin');
  const snapBeforeAssign = captureVertexGroupsSnapshot(box);
  const assigned = assignVerticesToGroup(box, vgGrp.name, bufVerts, 0.75, 'replace');
  assert.equal(assigned, bufVerts.length);
  const snapAfterAssign = captureVertexGroupsSnapshot(box);
  sm.executeCommand(new VertexGroupsCommand(box, snapBeforeAssign, snapAfterAssign, null, 'Assign VG'));

  editMode.selectedVertices.clear();
  const selectedBuf = selectGroupVertices(box, 'CornerPin', editMode);
  assert.equal(selectedBuf.length, bufVerts.length);
  assert.ok(editMode.selectedVertices.has(targetLogical), 'selectGroupVertices must re-select EditMode logical vertex');

  deselectGroupVertices(box, 'CornerPin', editMode);
  assert.equal(editMode.selectedVertices.has(targetLogical), false, 'deselectGroupVertices must clear EditMode logical vertex');

  // Undo assign
  assert.equal(sm.canUndo(), true);
  sm.undo();
  assert.equal(Object.keys(ensureVertexGroups(box).groups[0].entries).length, 0);
  assert.equal(sm.canRedo(), true);
  sm.redo();
  assert.equal(Object.keys(ensureVertexGroups(box).groups[0].entries).length, bufVerts.length);

  removeVerticesFromGroup(box, 'CornerPin', bufVerts);
  assert.equal(Object.keys(ensureVertexGroups(box).groups[0].entries).length, 0);
  assert.equal(renameVertexGroup(box, 'CornerPin', 'Trim_L'), true);
  assignVerticesToGroup(box, 'Trim_L', bufVerts, 0.65, 'replace');
  const mirrored = mirrorVertexGroup(box, 'Trim_L');
  assert.equal(mirrored.name, 'Trim_R');
  const rIndices = Object.keys(mirrored.entries).map(Number);
  assert.ok(rIndices.length >= 1);
  for (const vi of rIndices) {
    assert.ok(box.geometry.attributes.position.getX(vi) < -0.4, 'Mirrored Trim_R vertices must lie on -X');
  }
  editMode.exit();

  // 2B. SkinnedMesh Vertex Group sync + remove group clears weights
  const rig = new RigSystem({ scene, sceneManager: sm, THREE });
  const { armGroup, mesh } = buildTwoArmTCharacter(scene);
  const skinned = rig.autoSkinMesh(mesh, armGroup, { mode: 'heat' });
  const initGroups = ensureVertexGroups(skinned);
  const leftArmIdx = initGroups.groups.findIndex((g) => g.name === 'LeftArm');
  assert.ok(leftArmIdx >= 0);
  setActiveVertexGroup(skinned, leftArmIdx);
  const removed = removeVertexGroup(skinned, 'RightForeArm');
  assert.equal(removed, true);
  assert.equal(ensureVertexGroups(skinned).groups.some((g) => g.name === 'RightForeArm'), false);

  // 2C. .wbs ZIP export/import preserves mesh.userData.vertexGroups
  const exporter = new StudioExporter({ scene, camera: new THREE.PerspectiveCamera(), sceneManager: sm });
  const pkg = await exporter.exportProjectPackage({ download: false });

  const scene2 = new THREE.Scene();
  const sm2 = new SceneManager(scene2);
  const importer = new StudioExporter({ scene: scene2, camera: new THREE.PerspectiveCamera(), sceneManager: sm2 });
  const imp = await importer.importProjectJSON(pkg.bytes);
  assert.equal(imp.success, true);

  const box2 = sm2.findObjectByName('VG_Box');
  assert.ok(box2);
  const vg2 = ensureVertexGroups(box2);
  assert.ok(vg2.groups.some((g) => g.name === 'Trim_L'));
  assert.ok(vg2.groups.some((g) => g.name === 'Trim_R'));
});

await test('3. Armature Pro: use_connect head/tail lock, Bone Collections visibility/rename, Undo/Redo & .wbs persistence', async () => {
  const scene = new THREE.Scene();
  const sm = new SceneManager(scene);
  const rig = new RigSystem({ scene, sceneManager: sm, THREE });
  const { armGroup, skeleton, bones } = buildTwoArmTCharacter(scene);
  sm.addObject(armGroup, null, false, false);

  assert.equal(rig.enterEditBoneMode(armGroup), true);
  const extruded = rig.extrudeBone(bones.lHand, new THREE.Vector3(0.25, 0, 0), 'LeftThumb');
  assert.ok(extruded);
  assert.equal(rig.getBoneConnected(extruded), true, 'Extruded bone defaults to use_connect = true');

  // Toggle use_connect false -> move bone away -> toggle true snaps back to parent tail
  const prePos = extruded.position.clone();
  assert.equal(rig.setBoneConnected(extruded, false), true);
  assert.equal(rig.getBoneConnected(extruded), false);
  extruded.position.set(0.9, 0.9, 0.9);
  rig.onEditBoneMoved(extruded);

  assert.equal(rig.setBoneConnected(extruded, true), true);
  assert.ok(extruded.position.distanceTo(prePos) < 1e-4, 'Re-enabling use_connect must snap head back to parent tail');

  // Undo & Redo setBoneConnected
  assert.equal(sm.canUndo(), true);
  sm.undo();
  assert.equal(rig.getBoneConnected(extruded), false);
  assert.equal(sm.canRedo(), true);
  sm.redo();
  assert.equal(rig.getBoneConnected(extruded), true);

  // Bone Collections CRUD, rename tracking, and visibility propagation
  const armsCol = rig.createBoneCollection('Arms', armGroup, ['LeftArm', 'LeftForeArm', 'RightArm']);
  assert.equal(armsCol.bones.length, 3);
  assert.equal(rig.renameBone('LeftForeArm', 'LeftLowerArm'), true);
  assert.ok(rig.getBoneCollections(armGroup)[0].bones.includes('LeftLowerArm'), 'Renaming bone updates collection member');

  assert.equal(rig.setBoneCollectionVisibility('Arms', false, armGroup), true);
  assert.equal(bones.lArm.userData.hiddenByCollection, true);
  assert.equal(bones.spine.userData.hiddenByCollection, false);
  for (const c of bones.lArm.children) {
    if (c.userData?.isBoneJoint || c.userData?.isBoneHitProxy) {
      assert.equal(c.visible, false, 'Hidden collection bone helper must stay hidden');
    }
  }
  // Display mode switch must keep hidden collection hidden
  rig.setBoneDisplayMode('stick');
  for (const c of bones.lArm.children) {
    if (c.userData?.isBoneJoint) {
      assert.equal(c.visible, false, 'setBoneDisplayMode must respect hidden collection');
    }
  }
  assert.equal(rig.setBoneCollectionVisibility('Arms', true, armGroup), true);
  assert.equal(bones.lArm.userData.hiddenByCollection, false);

  const picked = rig.selectBoneCollection('Arms', armGroup);
  assert.equal(picked.length, 3);
  assert.equal(rig.exitEditBoneMode(), true);

  // .wbs persistence of boneCollections + useConnect
  const exporter = new StudioExporter({ scene, camera: new THREE.PerspectiveCamera(), sceneManager: sm });
  const pkg = await exporter.exportProjectPackage({ download: false });

  const sceneB = new THREE.Scene();
  const smB = new SceneManager(sceneB);
  const importer = new StudioExporter({ scene: sceneB, camera: new THREE.PerspectiveCamera(), sceneManager: smB });
  const res = await importer.importProjectJSON(pkg.bytes);
  assert.equal(res.success, true);

  const armB = smB.findObjectByName('HeatRigArmature');
  assert.ok(armB);
  assert.ok(Array.isArray(armB.userData?.boneCollections) && armB.userData.boneCollections[0].name === 'Arms');
  const thumbB = armB.getObjectByName('LeftThumb');
  assert.equal(Boolean(thumbB?.userData?.useConnect), true);
});

await test('4. IK / FK Switching & Blending: zero-pop snapIKToFK, snapFKToIK & continuous ikBlend', () => {
  const scene = new THREE.Scene();
  const rig = new RigSystem({ scene, THREE });
  const { armGroup, skeleton, bones } = buildTwoArmTCharacter(scene);
  rig.activeCharacter = armGroup;
  rig.activeSkeleton = skeleton;
  assert.equal(rig.setupTwoBoneIK(armGroup), true);
  rig.setIKEnabled(true);

  // Pose left arm via FK
  bones.lArm.rotation.set(0.2, 0.1, -0.55);
  bones.lFore.rotation.set(0, 0.75, 0);
  armGroup.updateMatrixWorld(true);
  const fkEndBefore = bones.lHand.getWorldPosition(new THREE.Vector3());
  const fkMidBefore = bones.lFore.getWorldPosition(new THREE.Vector3());

  // Snap IK handles to current FK pose -> ZERO world-space pop when solving at blend=1
  assert.equal(rig.snapIKToFK('leftArm'), 1);
  assert.equal(rig.getChainIKBlend('leftArm'), 1.0);
  const chain = rig.ikChains.get('leftArm');
  assert.ok(chain.targetHandle.position.distanceTo(fkEndBefore) < 1e-4, 'IK target must match FK hand world position');

  rig.onIKHandleMoved(chain.targetHandle);
  const endAfterSnapIK = bones.lHand.getWorldPosition(new THREE.Vector3());
  const midAfterSnapIK = bones.lFore.getWorldPosition(new THREE.Vector3());
  assert.ok(endAfterSnapIK.distanceTo(fkEndBefore) < 2e-3, `snapIKToFK caused end pop: ${endAfterSnapIK.distanceTo(fkEndBefore)}`);
  assert.ok(midAfterSnapIK.distanceTo(fkMidBefore) < 2e-3, `snapIKToFK caused elbow pop: ${midAfterSnapIK.distanceTo(fkMidBefore)}`);

  // Move IK target significantly -> blend between FK (0.0), Mid (0.5), IK (1.0)
  const fkEnd = fkEndBefore.clone();
  chain.targetHandle.position.set(0.85, 0.75, 0.35);
  rig.setChainIKBlend('leftArm', 1.0);
  const ikEnd = bones.lHand.getWorldPosition(new THREE.Vector3());
  assert.ok(ikEnd.distanceTo(fkEnd) > 0.2, 'Moved IK target should displace hand far from FK pose');

  rig.setChainIKBlend('leftArm', 0.5);
  const halfEnd = bones.lHand.getWorldPosition(new THREE.Vector3());
  assert.ok(halfEnd.distanceTo(fkEnd) > 0.05 && halfEnd.distanceTo(ikEnd) > 0.05, 'ikBlend=0.5 must lie strictly between FK and IK poses');

  rig.setChainIKBlend('leftArm', 0.0);
  const zeroEnd = bones.lHand.getWorldPosition(new THREE.Vector3());
  assert.ok(zeroEnd.distanceTo(fkEnd) < 1e-4, 'ikBlend=0.0 must match original FK pose');

  // Switch back to full IK then Snap FK to IK -> blend becomes 0.0 while keeping IK world pose!
  rig.setChainIKBlend('leftArm', 1.0);
  const ikTargetEnd = bones.lHand.getWorldPosition(new THREE.Vector3());
  assert.equal(rig.snapFKToIK('leftArm'), 1);
  assert.equal(rig.getChainIKBlend('leftArm'), 0.0);
  const fkSnappedEnd = bones.lHand.getWorldPosition(new THREE.Vector3());
  assert.ok(fkSnappedEnd.distanceTo(ikTargetEnd) < 1e-4, `snapFKToIK caused pop: ${fkSnappedEnd.distanceTo(ikTargetEnd)}`);
});

await test('5. Subdivision viewport vs renderLevels switch via withRenderSubdivisionLevels & VideoExportManager', async () => {
  const scene = new THREE.Scene();
  const box = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial());
  box.name = 'SubdivActor';
  scene.add(box);
  applyModifier(box, 'subdivision', { subdivisions: 1, renderLevels: 2, subdivisionType: 'catmull-clark' });
  const vpVerts = box.geometry.attributes.position.count;
  assert.ok(vpVerts > 24, `Viewport subdiv level 1 should subdivide cube, got ${vpVerts}`);

  let insideVerts = 0;
  await withRenderSubdivisionLevels(scene, async () => {
    insideVerts = box.geometry.attributes.position.count;
  });
  assert.ok(insideVerts > vpVerts * 2, `Render subdiv level 2 (${insideVerts}) must exceed viewport level 1 (${vpVerts})`);
  assert.equal(box.geometry.attributes.position.count, vpVerts, 'withRenderSubdivisionLevels must restore viewport geometry afterwards');

  // Verify VideoExportManager.renderVideo cleanly invokes and restores withRenderSubdivisionLevels even if headless WebGL init fails
  const mockRenderer = { setPixelRatio() {}, setSize() {}, render() {}, dispose() {} };
  const cam = new THREE.PerspectiveCamera();
  const vexp = new VideoExportManager({ renderer: mockRenderer, scene, camera: cam });
  await assert.rejects(() => vexp.renderVideo({ width: 64, height: 64, startFrame: 0, endFrame: 1 }));
  assert.equal(box.geometry.attributes.position.count, vpVerts, 'VideoExportManager failure must still restore viewport subdiv level');
});

await test('6. Cross-mode safety: WeightPaint preserves VertexColors & custom VertexGroups, EditMode rebuild keeps color/skin', () => {
  const scene = new THREE.Scene();
  const sm = new SceneManager(scene);
  const rig = new RigSystem({ scene, sceneManager: sm, THREE });
  const { armGroup, mesh, bones } = buildTwoArmTCharacter(scene);
  sm.addObject(mesh, null, false, false);

  // Paint red RGB color on raw mesh BEFORE skinning
  const vCnt = mesh.geometry.attributes.position.count;
  const colArr = new Float32Array(vCnt * 3);
  for (let i = 0; i < vCnt; i++) {
    colArr[i * 3] = 0.9; colArr[i * 3 + 1] = 0.1; colArr[i * 3 + 2] = 0.2;
  }
  mesh.geometry.setAttribute('color', new THREE.BufferAttribute(colArr, 3));
  mesh.material.vertexColors = true;

  const skinned = rig.autoSkinMesh(mesh, armGroup, { mode: 'heat' });
  addVertexGroup(skinned, 'CustomPin');
  assignVerticesToGroup(skinned, 'CustomPin', [0, 1], 0.85, 'replace');

  // Enter WeightPaint -> paints heatmap over color attr -> run smoothWeights + WeightPaintCommand undo -> Exit WeightPaint
  assert.equal(rig.enableWeightPaintMode(skinned, bones.lArm), true);
  rig.smoothWeights(skinned, bones.lArm, 1, 0.5, true);
  assert.ok(ensureVertexGroups(skinned).groups.some((g) => g.name === 'CustomPin'), 'WeightPaint sync must preserve custom non-bone Vertex Groups');
  sm.undo();
  assert.ok(ensureVertexGroups(skinned).groups.some((g) => g.name === 'CustomPin'), 'WeightPaint Undo must preserve custom non-bone Vertex Groups');

  rig.disableWeightPaintMode();
  const cAttrAfter = skinned.geometry.attributes.color;
  assert.ok(cAttrAfter, 'Original Vertex Color attribute must remain after WeightPaint exit');
  assert.ok(Math.abs(cAttrAfter.getX(0) - 0.9) < 1e-4 && Math.abs(cAttrAfter.getY(0) - 0.1) < 1e-4, 'Original Vertex Color RGB must be restored cleanly after WeightPaint exit');

  // EditMode topological rebuild preserves vertex color & skin attributes
  const em = new EditMode({ scene, sceneManager: sm }, { sceneManager: sm });
  assert.equal(em.enter(skinned), true);
  em.rebuildGeometry();
  assert.ok(skinned.geometry.attributes.color, 'EditMode rebuildGeometry must preserve color attribute');
  assert.ok(skinned.geometry.attributes.skinIndex && skinned.geometry.attributes.skinWeight, 'EditMode rebuildGeometry must preserve skin attributes on SkinnedMesh');
  em.exit();
});

console.log(`\nWave 4C Rigging & Vertex Groups Suite: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
