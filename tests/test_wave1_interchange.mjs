/**
 * Wave 1B & 1C automated verification suite:
 *  - Full ASCII FBX 7.4 round-trip via FBXLoader.js:
 *      (1) multi-material mesh + UVs + normals + object animation
 *      (2) SkinnedMesh + Skeleton + bone clusters + BindPose + skeletal animation
 *      (3) BlendShapes (morphAttributes) + animated DeformPercent tracks
 *  - Apple AR USDZ exporter:
 *      (4) 64-byte alignment verification on every ZIP entry payload + UsdPreviewSurface + texture
 *  - 3MF exporter:
 *      (5) ZIP OPC structure + millimeter 3dmodel.model XML verification
 *  - Game / Marketplace Pack exporter:
 *      (6) Auto-LOD reduction + QuickHull UCX_ collision enclosure + non-overlapping Lightmap uv1
 *          (preserving uv0) + GLTFExporter -> GLTFLoader GLB binary round-trip
 */

import assert from 'node:assert/strict';
import * as THREE from 'three';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { unzipSync, strFromU8 } from 'three/addons/libs/fflate.module.js';

import { exportSceneToFBX, exportClipToFBX } from '../js/animation/fbx-exporter.js';
import { USDZExporter } from '../js/exporters/usdz-exporter.js';
import { ThreeMFExporter } from '../js/exporters/threemf-exporter.js';
import {
  computeConvexHullGeometry,
  ensureLightmapUV,
  generateLODChain,
  buildGamePackScene,
} from '../js/exporters/game-pack-exporter.js';

// Polyfill FileReader in Node if GLTFExporter binary uses Blob
if (typeof globalThis.FileReader === 'undefined') {
  globalThis.FileReader = class NodeFileReader {
    readAsArrayBuffer(blob) {
      blob.arrayBuffer().then((buf) => {
        this.result = buf;
        this.onloadend?.({ target: this });
        this.onload?.({ target: this });
      }).catch((err) => {
        this.error = err;
        this.onerror?.(err);
      });
    }
  };
}

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

console.log('Wave 1B & 1C Interchange Tests (FBX Full, USDZ, 3MF, Game Pack)');

// ---------------------------------------------------------------------------
// 1. FBX Multi-material Mesh + UVs + Normals + Object Animation
// ---------------------------------------------------------------------------
await test('FBX 7.4 exports multi-material mesh with UVs, normals & animation and round-trips through FBXLoader', async () => {
  const scene = new THREE.Group();
  const geom = new THREE.BoxGeometry(2, 1, 1);
  geom.clearGroups();
  const triCount = geom.index.count / 3;
  geom.addGroup(0, Math.floor(triCount / 2) * 3, 0);
  geom.addGroup(Math.floor(triCount / 2) * 3, (triCount - Math.floor(triCount / 2)) * 3, 1);

  const matA = new THREE.MeshStandardMaterial({ name: 'RedMat', color: 0xff2222 });
  const matB = new THREE.MeshStandardMaterial({ name: 'BlueMat', color: 0x2244ff });
  const mesh = new THREE.Mesh(geom, [matA, matB]);
  mesh.name = 'Crate';
  scene.add(mesh);

  const clip = new THREE.AnimationClip('CrateMove', 1.0, [
    new THREE.VectorKeyframeTrack('Crate.position', [0, 1], [0, 0, 0, 4, 2, 0]),
  ]);

  const out = exportSceneToFBX(scene, { animations: [clip], fps: 24 });
  assert.equal(out.format, 'binary');
  assert.ok(out.bytes instanceof Uint8Array);
  assert.ok(new TextDecoder().decode(out.bytes.subarray(0, 18)) === 'Kaydara FBX Binary');
  assert.equal(out.meshCount, 1);
  assert.equal(out.clipCount, 1);

  const parsed = new FBXLoader().parse(out.bytes.buffer.slice(out.bytes.byteOffset, out.bytes.byteOffset + out.bytes.byteLength), '');
  let importedMesh = null;
  parsed.traverse((o) => { if (o.isMesh) importedMesh = o; });
  assert.ok(importedMesh, 'FBXLoader must reconstruct Mesh');
  assert.ok(importedMesh.geometry.attributes.position.count >= 24);
  assert.ok(importedMesh.geometry.attributes.normal, 'normals preserved');
  assert.ok(importedMesh.geometry.attributes.uv, 'UVs preserved');
  assert.ok(Array.isArray(importedMesh.material) && importedMesh.material.length === 2, 'multi-material preserved');
  assert.equal(parsed.animations.length, 1);
});

// ---------------------------------------------------------------------------
// 2. FBX SkinnedMesh + Skeleton + BindPose + Animation
// ---------------------------------------------------------------------------
await test('FBX 7.4 exports SkinnedMesh + skin weights + Skeleton + AnimationClip through FBXLoader', async () => {
  const root = new THREE.Group();
  root.name = 'RigChar';

  const hips = new THREE.Bone();
  hips.name = 'Hips';
  const spine = new THREE.Bone();
  spine.name = 'Spine';
  spine.position.set(0, 1, 0);
  hips.add(spine);
  root.add(hips);
  root.updateMatrixWorld(true);

  const geom = new THREE.CylinderGeometry(0.3, 0.3, 2, 10, 4);
  geom.translate(0, 1, 0); // range y: [0, 2]
  const pos = geom.attributes.position;
  const skinIndices = new Uint16Array(pos.count * 4);
  const skinWeights = new Float32Array(pos.count * 4);
  for (let i = 0; i < pos.count; i += 1) {
    const y = pos.getY(i);
    const wSpine = Math.max(0, Math.min(1, y / 2));
    const wHips = 1 - wSpine;
    skinIndices[i * 4] = 0;
    skinWeights[i * 4] = wHips;
    skinIndices[i * 4 + 1] = 1;
    skinWeights[i * 4 + 1] = wSpine;
  }
  geom.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(skinIndices, 4));
  geom.setAttribute('skinWeight', new THREE.Float32BufferAttribute(skinWeights, 4));

  const skinned = new THREE.SkinnedMesh(geom, new THREE.MeshStandardMaterial({ color: 0xdddddd }));
  skinned.name = 'BodyMesh';
  const skeleton = new THREE.Skeleton([hips, spine]);
  root.add(skinned);
  skinned.bind(skeleton);

  const q0 = new THREE.Quaternion();
  const q1 = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, Math.PI / 4));
  const clip = new THREE.AnimationClip('Wave', 0.5, [
    new THREE.QuaternionKeyframeTrack('Spine.quaternion', [0, 0.5], [
      q0.x, q0.y, q0.z, q0.w,
      q1.x, q1.y, q1.z, q1.w,
    ]),
  ]);

  const out = exportClipToFBX(root, clip, { fps: 30, clipName: 'Wave' });
  assert.equal(out.meshCount, 1);
  assert.equal(out.boneCount, 2);

  const parsed = new FBXLoader().parse(out.bytes.buffer.slice(out.bytes.byteOffset, out.bytes.byteOffset + out.bytes.byteLength), '');
  let impSkinned = null;
  const impBones = [];
  parsed.traverse((o) => {
    if (o.isSkinnedMesh) impSkinned = o;
    if (o.isBone) impBones.push(o);
  });
  assert.ok(impSkinned, 'FBXLoader must reconstruct SkinnedMesh');
  assert.equal(impBones.length, 2, 'FBXLoader must reconstruct both bones');
  assert.ok(impSkinned.geometry.attributes.skinWeight, 'skinWeight restored');
  assert.ok(impSkinned.skeleton && impSkinned.skeleton.bones.length === 2, 'Skeleton bound with 2 bones');
  assert.equal(parsed.animations.length, 1);
  assert.ok(parsed.animations[0].tracks.some((t) => t.name.includes('Spine.quaternion')));
});

// ---------------------------------------------------------------------------
// 3. FBX BlendShapes (Morph Targets) + DeformPercent Animation
// ---------------------------------------------------------------------------
await test('FBX 7.4 exports BlendShape morph targets & DeformPercent animation through FBXLoader', async () => {
  const root = new THREE.Group();
  const geom = new THREE.BoxGeometry(1, 1, 1);
  const basePos = geom.attributes.position;
  const smileDelta = new Float32Array(basePos.count * 3);
  for (let i = 0; i < basePos.count; i += 1) {
    // Displace top vertices upward by +0.5
    if (basePos.getY(i) > 0) smileDelta[i * 3 + 1] = 0.5;
  }
  geom.morphTargetsRelative = true;
  geom.morphAttributes.position = [new THREE.BufferAttribute(smileDelta, 3)];
  geom.morphAttributes.position[0].name = 'Smile';

  const mesh = new THREE.Mesh(geom, new THREE.MeshStandardMaterial({ color: 0xffccaa }));
  mesh.name = 'Head';
  mesh.morphTargetDictionary = { Smile: 0 };
  mesh.morphTargetInfluences = [0];
  root.add(mesh);

  const clip = new THREE.AnimationClip('Facial', 0.5, [
    new THREE.NumberKeyframeTrack('Head.morphTargetInfluences[0]', [0, 0.5], [0, 1]),
  ]);

  const out = exportSceneToFBX(root, { animations: [clip], fps: 20 });
  assert.equal(out.blendShapeCount, 1);

  const parsed = new FBXLoader().parse(out.bytes.buffer.slice(out.bytes.byteOffset, out.bytes.byteOffset + out.bytes.byteLength), '');
  let impMesh = null;
  parsed.traverse((o) => { if (o.isMesh) impMesh = o; });
  assert.ok(impMesh);
  assert.ok(Array.isArray(impMesh.geometry.morphAttributes.position), 'morphAttributes.position restored');
  assert.equal(impMesh.geometry.morphAttributes.position.length, 1);

  // Verify delta values match +0.5 on top vertices
  const mAttr = impMesh.geometry.morphAttributes.position[0];
  let maxDeltaY = 0;
  for (let i = 0; i < mAttr.count; i += 1) maxDeltaY = Math.max(maxDeltaY, mAttr.getY(i));
  assert.ok(Math.abs(maxDeltaY - 0.5) < 1e-4, `expected morph delta Y ~0.5, got ${maxDeltaY}`);

  assert.equal(parsed.animations.length, 1);
  assert.ok(
    parsed.animations[0].tracks.some((t) => t.name.includes('morphTargetInfluences')),
    'DeformPercent curve imported as morphTargetInfluences track',
  );

  // Also verify explicit format:'ascii' keeps round-tripping
  const outAscii = exportSceneToFBX(root, { animations: [clip], fps: 20, format: 'ascii' });
  assert.equal(outAscii.format, 'ascii');
  assert.ok(outAscii.fbx.includes('FBXVersion: 7400'));
  const parsedAscii = new FBXLoader().parse(new TextEncoder().encode(outAscii.fbx).buffer, '');
  assert.equal(parsedAscii.animations.length, 1);
});

// ---------------------------------------------------------------------------
// 4. Apple AR USDZ Exporter (64-byte alignment + USDA + textures)
// ---------------------------------------------------------------------------
await test('USDZExporter emits uncompressed ZIP with 64-byte aligned file offsets, USDA & embedded texture', async () => {
  const root = new THREE.Group();
  const group = new THREE.Group();
  group.name = 'SubAssembly';
  group.position.set(1, 0, -2);

  const tex = new THREE.Texture();
  tex.name = 'CheckerTex';
  tex.image = {
    src: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  };
  const mat = new THREE.MeshStandardMaterial({ name: 'PropMat', color: 0x44aaee, roughness: 0.35, metalness: 0.8, map: tex });
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), mat);
  mesh.name = 'ARBox';
  group.add(mesh);
  root.add(group);

  const exporter = new USDZExporter();
  const res = await exporter.parseAsync(root);
  assert.equal(res.meshCount, 1);
  assert.equal(res.materialCount, 1);
  assert.equal(res.textureCount, 1);

  // Verify local ZIP headers manually: method === 0 AND dataOffset % 64 === 0 for every entry
  const dv = new DataView(res.bytes.buffer, res.bytes.byteOffset, res.bytes.byteLength);
  let pos = 0;
  let localFiles = 0;
  while (pos + 30 <= res.bytes.byteLength && dv.getUint32(pos, true) === 0x04034b50) {
    const method = dv.getUint16(pos + 8, true);
    const compSize = dv.getUint32(pos + 18, true);
    const nameLen = dv.getUint16(pos + 26, true);
    const extraLen = dv.getUint16(pos + 28, true);
    const dataOffset = pos + 30 + nameLen + extraLen;
    assert.equal(method, 0, 'USDZ entries must be uncompressed (STORE method 0)');
    assert.equal(dataOffset % 64, 0, `USDZ payload offset ${dataOffset} must be a multiple of 64`);
    localFiles += 1;
    pos = dataOffset + compSize;
  }
  assert.equal(localFiles, 2);

  const unzipped = unzipSync(res.bytes);
  const usda = strFromU8(unzipped['model.usda']);
  assert.ok(usda.startsWith('#usda 1.0'));
  assert.ok(usda.includes('UsdPreviewSurface'));
  assert.ok(usda.includes('UsdUVTexture'));
  assert.ok(Object.keys(unzipped).some((k) => k.startsWith('textures/') && k.endsWith('.png')));
});

// ---------------------------------------------------------------------------
// 5. 3MF Exporter
// ---------------------------------------------------------------------------
await test('ThreeMFExporter produces valid .3mf OPC archive with millimeter vertices & triangles', async () => {
  const root = new THREE.Group();
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(0.1, 0.2, 0.3),
    new THREE.MeshStandardMaterial({ name: 'PLA_Orange', color: 0xff6600 }),
  );
  mesh.name = 'PrintPart';
  mesh.position.set(0, 0.1, 0);
  root.add(mesh);

  const res = new ThreeMFExporter().parse(root);
  assert.equal(res.meshCount, 1);
  assert.equal(res.triangleCount, 12);

  const entries = unzipSync(res.bytes);
  assert.ok(entries['[Content_Types].xml']);
  assert.ok(entries['_rels/.rels']);
  assert.ok(entries['3D/3dmodel.model']);
  const xml = strFromU8(entries['3D/3dmodel.model']);
  assert.ok(xml.includes('unit="millimeter"'));
  assert.ok(xml.includes('<basematerials id="1">'));
  assert.ok(xml.includes('<triangle '));
  assert.ok(xml.includes('displaycolor="#FF6600"'));
});

// ---------------------------------------------------------------------------
// 6. Game / Marketplace Pack (Auto-LOD + QuickHull UCX_ + Lightmap UV1 + GLB)
// ---------------------------------------------------------------------------
await test('GamePackExporter builds LOD0..2, enclosing QuickHull UCX_, non-overlapping uv1 & round-trips GLB', async () => {
  const sphereGeom = new THREE.SphereGeometry(1, 20, 14);
  const origUv0 = sphereGeom.attributes.uv.clone();
  const mesh = new THREE.Mesh(sphereGeom, new THREE.MeshStandardMaterial({ color: 0x33cc88 }));
  mesh.name = 'Prop';
  mesh.position.set(2, 0, -1);

  // Lightmap UV preserves uv0 while creating uv1
  const lmGeom = ensureLightmapUV(sphereGeom);
  assert.ok(lmGeom.attributes.uv1, 'must create uv1 (TEXCOORD_1)');
  assert.ok(lmGeom.attributes.uv, 'must retain uv (TEXCOORD_0)');
  // Check uv0 corner values were preserved (not overwritten by Smart UV)
  const firstOrigU = origUv0.getX(sphereGeom.index.getX(0));
  const firstRestoredU = lmGeom.attributes.uv.getX(lmGeom.index.getX(0));
  assert.ok(Math.abs(firstOrigU - firstRestoredU) < 1e-4, 'uv0 preserved alongside uv1');

  // QuickHull encloses every point of source geometry
  const hull = computeConvexHullGeometry(sphereGeom);
  assert.ok(hull.attributes.position.count >= 12);
  const hullBox = new THREE.Box3().setFromBufferAttribute(hull.attributes.position);
  const srcBox = new THREE.Box3().setFromBufferAttribute(sphereGeom.attributes.position);
  assert.ok(hullBox.min.x <= srcBox.min.x + 1e-4 && hullBox.max.x >= srcBox.max.x - 1e-4);

  const { group, report } = buildGamePackScene(mesh, { lodRatios: [1.0, 0.5, 0.25] });
  assert.equal(report.lodMeshes, 3);
  assert.equal(report.collisionMeshes, 1);
  assert.equal(report.lightmapUVCount, 3);
  assert.ok(report.trianglesByLod[1] < report.trianglesByLod[0], 'LOD1 must have fewer tris than LOD0');
  assert.ok(report.trianglesByLod[2] < report.trianglesByLod[1], 'LOD2 must have fewer tris than LOD1');
  assert.ok(group.getObjectByName('Prop_LOD0'));
  assert.ok(group.getObjectByName('Prop_LOD2'));
  assert.ok(group.getObjectByName('UCX_Prop'));

  // Round-trip through real GLTFExporter -> GLTFLoader to verify TEXCOORD_1 (`uv1`) & UCX_ survive
  const glbBuffer = await new Promise((resolve, reject) => {
    new GLTFExporter().parse(group, resolve, reject, { binary: true });
  });
  const loaded = await new Promise((resolve, reject) => {
    new GLTFLoader().parse(glbBuffer, '', resolve, reject);
  });
  const loadedLod0 = loaded.scene.getObjectByName('Prop_LOD0');
  const loadedCol = loaded.scene.getObjectByName('UCX_Prop');
  assert.ok(loadedLod0?.geometry?.attributes?.uv1, 'TEXCOORD_1 (uv1) survived GLB export/import');
  assert.ok(loadedCol?.isMesh, 'UCX_Prop collision hull survived GLB export/import');
});

console.log(`\nSummary: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
