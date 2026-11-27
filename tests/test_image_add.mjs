import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
  isImageFile,
  createImageObject,
  updateImageObjectProperties,
  replaceImageObjectSource,
  convertImageToMeshPlane,
  applyImageAlignment,
} from '../js/core/image-objects.js';
import { SceneManager } from '../js/core/scene-manager.js';
import { RapidStudio } from '../js/scripting/rapid-api.js';

function makeSolidTexture(w = 64, h = 32, r = 200, g = 80, b = 40) {
  const data = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    data[i * 4] = r;
    data[i * 4 + 1] = g;
    data[i * 4 + 2] = b;
    data[i * 4 + 3] = 255;
  }
  const tex = new THREE.DataTexture(data, w, h, THREE.RGBAFormat);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

let passed = 0;
async function test(name, fn) {
  await fn();
  console.log(`  PASS: ${name}`);
  passed++;
}

async function run() {
  console.log('Running Image Objects Unit Tests...');

  await test('isImageFile recognizes standard image formats and rejects 3D/video extensions', async () => {
    assert.equal(isImageFile('ref_sheet.png'), true);
    assert.equal(isImageFile('blueprint.JPG'), true);
    assert.equal(isImageFile({ name: 'concept.webp' }), true);
    assert.equal(isImageFile('character.glb'), false);
    assert.equal(isImageFile('clip.mp4'), false);
    assert.equal(isImageFile(''), false);
  });

  await test('createImageObject creates Reference, Background, and Mesh Plane preserving aspect ratio', async () => {
    const scene = new THREE.Scene();
    const sm = new SceneManager(scene);
    const cam = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
    cam.position.set(0, 2, 6);
    cam.lookAt(0, 1, 0);
    cam.updateMatrixWorld(true);

    const tex = makeSolidTexture(200, 100); // 2:1 landscape aspect
    const refImg = await createImageObject({
      texture: tex,
      name: 'Side_Ref',
      mode: 'reference',
      width: 4.0,
      pixelWidth: 200,
      pixelHeight: 100,
      camera: cam,
      sceneManager: sm,
    });

    assert.equal(refImg.userData.isImageObject, true);
    assert.equal(refImg.userData.imageMode, 'reference');
    assert.ok(Math.abs(refImg.userData.aspect - 2.0) < 1e-6);
    const box = new THREE.Box3().setFromObject(refImg);
    const size = new THREE.Vector3();
    box.getSize(size);
    // Geometry width is 4, height is 2 (rotated slightly by camera pitch)
    assert.ok(refImg.geometry.parameters.width === 4);
    assert.ok(Math.abs(refImg.geometry.parameters.height - 2.0) < 1e-6);
    assert.equal(refImg.material.isMeshBasicMaterial, true);
    assert.equal(refImg.material.transparent, true);
    assert.equal(refImg.material.depthTest, true);

    const bgImg = await createImageObject({
      texture: makeSolidTexture(100, 200),
      mode: 'background',
      width: 2.0,
      pixelWidth: 100,
      pixelHeight: 200,
      align: 'front',
      sceneManager: sm,
    });
    assert.equal(bgImg.userData.imageMode, 'background');
    assert.equal(bgImg.userData.depthOrder, 'back');
    assert.equal(bgImg.material.depthTest, false);
    assert.equal(bgImg.renderOrder, -10);
    assert.equal(sm.objects.size, 2);

    const planeImg = await createImageObject({
      texture: makeSolidTexture(128, 128),
      mode: 'plane',
      width: 3.0,
      pixelWidth: 128,
      pixelHeight: 128,
      align: 'top',
      sceneManager: sm,
    });
    assert.equal(planeImg.material.isMeshStandardMaterial, true);
    assert.equal(planeImg.castShadow, true);
    assert.equal(planeImg.receiveShadow, true);
  });

  await test('updateImageObjectProperties updates size, opacity, depth, side, and UV flip without drift', async () => {
    const tex = makeSolidTexture(160, 80);
    const img = await createImageObject({
      texture: tex,
      mode: 'reference',
      width: 4.0,
      pixelWidth: 160,
      pixelHeight: 80,
      align: 'front',
    });

    updateImageObjectProperties(img, {
      baseWidth: 6.0,
      opacity: 0.42,
      depthOrder: 'front',
      displaySide: 'front',
      flipX: true,
      flipY: false,
    });

    assert.equal(img.geometry.parameters.width, 6.0);
    assert.ok(Math.abs(img.geometry.parameters.height - 3.0) < 1e-6);
    assert.ok(Math.abs(img.material.opacity - 0.42) < 1e-6);
    assert.equal(img.material.depthTest, false);
    assert.equal(img.renderOrder, 50);
    assert.equal(img.material.side, THREE.FrontSide);

    const uv = img.geometry.getAttribute('uv');
    // Top-left corner normally u=0, after flipX should be u=1
    assert.ok(Math.abs(uv.getX(0) - 1.0) < 1e-6);

    // Toggle flipX back off -> must return cleanly to u=0
    updateImageObjectProperties(img, { flipX: false });
    const uv2 = img.geometry.getAttribute('uv');
    assert.ok(Math.abs(uv2.getX(0) - 0.0) < 1e-6);

    applyImageAlignment(img, 'right');
    assert.ok(Math.abs(img.rotation.y - Math.PI / 2) < 1e-5);
  });

  await test('replaceImageObjectSource and convertImageToMeshPlane preserve UUID and selection integrity', async () => {
    const scene = new THREE.Scene();
    const sm = new SceneManager(scene);
    const img = await createImageObject({
      texture: makeSolidTexture(100, 100),
      mode: 'reference',
      width: 4.0,
      pixelWidth: 100,
      pixelHeight: 100,
      align: 'front',
      sceneManager: sm,
    });
    const origUuid = img.uuid;
    img.position.set(1.5, 2.0, -0.5);

    // Replace with tall portrait texture (100x200) -> height must double from 4 to 8!
    await replaceImageObjectSource(img, {
      texture: makeSolidTexture(100, 200, 10, 200, 90),
      pixelWidth: 100,
      pixelHeight: 200,
    });
    assert.equal(img.uuid, origUuid);
    assert.ok(Math.abs(img.geometry.parameters.width - 4.0) < 1e-6);
    assert.ok(Math.abs(img.geometry.parameters.height - 8.0) < 1e-6);
    assert.ok(Math.abs(img.position.x - 1.5) < 1e-6);

    // Convert Reference -> Lit Mesh Plane
    convertImageToMeshPlane(img, { sceneManager: sm });
    assert.equal(img.uuid, origUuid);
    assert.equal(img.userData.imageMode, 'plane');
    assert.equal(img.material.isMeshStandardMaterial, true);
    assert.equal(img.castShadow, true);
    assert.equal(img.material.depthTest, true);

    // Undo should cleanly remove added object if SceneManager recorded history
    assert.equal(sm.objects.size, 1);
    sm.undo();
    assert.equal(sm.objects.size, 0);
  });

  await test('RapidStudio.addImage exposes Add Image in DSL without touching Mocap', async () => {
    const scene = new THREE.Scene();
    const studio = new RapidStudio({ scene });
    const mesh = await studio.addImage({
      texture: makeSolidTexture(64, 64),
      mode: 'plane',
      width: 2.5,
      pixelWidth: 64,
      pixelHeight: 64,
      x: 3,
      y: 1.25,
      z: -2,
      align: 'front',
      name: 'DSL_Decal',
    });
    assert.ok(mesh);
    assert.equal(mesh.name, 'DSL_Decal');
    assert.equal(mesh.userData.imageMode, 'plane');
    assert.ok(Math.abs(mesh.position.x - 3) < 1e-6);
    assert.ok(Math.abs(mesh.position.y - 1.25) < 1e-6);
  });

  console.log(`\nAll ${passed} Image Objects tests passed!`);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
