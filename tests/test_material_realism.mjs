/**
 * Automated Test Suite for Phase 4: Look-Dev Raster & Material Realism
 * Tests Principled BSDF physical channels (transmission, IOR, clearcoat, sheen),
 * procedural texture generation with budget limit (<=2048),
 * environment raw equirect source preservation, post-processing presets (fast/studio/cinematic),
 * and unified raster rendering.
 * File: tests/test_material_realism.mjs
 */

import assert from 'node:assert';
import * as THREE from 'three';
import { MaterialStudio } from '../js/core/material-studio.js';
import { PostProcessingManager, POST_PRESETS } from '../js/render/post-processing.js';
import { RasterRenderer } from '../js/render/raster-renderer.js';
import { ProceduralTextureClient } from '../js/render/procedural-texture-client.js';
import { executeProceduralGeneration } from '../js/render/procedural-texture-worker.js';

let passed = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`ok   ${name}`);
    passed++;
  } catch (err) {
    console.error(`FAIL ${name}`);
    console.error(err);
    process.exit(1);
  }
}

async function testAsync(name, fn) {
  try {
    await fn();
    console.log(`ok   ${name}`);
    passed++;
  } catch (err) {
    console.error(`FAIL ${name}`);
    console.error(err);
    process.exit(1);
  }
}

console.log('=== Test Suite: Look-Dev Raster & Material Realism (Phase 4) ===');

// 1. Upgrade from MeshStandardMaterial (with textures) & MeshPhysicalMaterial preservation
test('Principled Upgrade: chuyển Standard sang Physical giữ nguyên map, thuộc tính & không làm mất kênh Physical cũ', () => {
  const studio = new MaterialStudio({ THREE });
  const diffuseMap = new THREE.DataTexture(new Uint8Array([200, 100, 50, 255]), 1, 1);
  const normalMap = new THREE.DataTexture(new Uint8Array([128, 128, 255, 255]), 1, 1);
  const roughMap = new THREE.DataTexture(new Uint8Array([90, 90, 90, 255]), 1, 1);
  const metalMap = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);

  const standard = new THREE.MeshStandardMaterial({
    color: 0x3b82f6,
    roughness: 0.35,
    metalness: 0.75,
    map: diffuseMap,
    normalMap,
    roughnessMap: roughMap,
    metalnessMap: metalMap,
    emissive: new THREE.Color(0x112233),
    emissiveIntensity: 1.5,
    name: 'CarBody_Standard',
    userData: { testId: 42, customTag: 'sports-car' },
  });

  const physical = studio.upgradeToPhysicalMaterial(standard, {
    clearcoat: 0.9,
    clearcoatRoughness: 0.1,
    transmission: 0.8,
    ior: 1.45,
    thickness: 1.2,
  });

  assert.strictEqual(physical.isMeshPhysicalMaterial, true, 'Phải là MeshPhysicalMaterial');
  assert.strictEqual(physical.color.getHex(), 0x3b82f6, 'Màu cơ sở phải được bảo tồn');
  assert.strictEqual(physical.roughness, 0.35, 'Roughness phải được bảo tồn');
  assert.strictEqual(physical.metalness, 0.75, 'Metalness phải được bảo tồn');
  assert.strictEqual(physical.map, diffuseMap, 'Diffuse map phải được bảo tồn');
  assert.strictEqual(physical.normalMap, normalMap, 'Normal map phải được bảo tồn');
  assert.strictEqual(physical.roughnessMap, roughMap, 'Roughness map phải được bảo tồn');
  assert.strictEqual(physical.metalnessMap, metalMap, 'Metalness map phải được bảo tồn');
  assert.strictEqual(physical.emissive.getHex(), 0x112233, 'Emissive color phải được bảo tồn');
  assert.strictEqual(physical.emissiveIntensity, 1.5, 'Emissive intensity phải được bảo tồn');
  assert.strictEqual(physical.clearcoat, 0.9, 'Clearcoat phải nhận đúng giá trị');
  assert.strictEqual(physical.clearcoatRoughness, 0.1, 'Clearcoat roughness phải nhận đúng giá trị');
  assert.strictEqual(physical.transmission, 0.8, 'Transmission phải nhận đúng giá trị');
  assert.strictEqual(physical.ior, 1.45, 'IOR phải nhận đúng giá trị');
  assert.strictEqual(physical.thickness, 1.2, 'Thickness phải nhận đúng giá trị');
  assert.strictEqual(physical.transparent, true, 'Transmission > 0 phải tự động bật transparent = true');
  assert.strictEqual(physical.userData.testId, 42, 'userData phải được bảo toàn');

  // Opaque upgrade (transmission=0) must NOT force transparent=true
  const opaqueStd = new THREE.MeshStandardMaterial({ color: 0xffffff, transparent: false });
  const opaquePhys = studio.upgradeToPhysicalMaterial(opaqueStd, { clearcoat: 1.0, transmission: 0 });
  assert.strictEqual(opaquePhys.transparent, false, 'Transmission=0 không được ép bật transparent');

  // Re-upgrading an existing MeshPhysicalMaterial must keep prior physical properties
  const updated = studio.upgradeToPhysicalMaterial(physical, { sheen: 0.75, sheenRoughness: 0.4 });
  assert.strictEqual(updated.clearcoat, 0.9, 'Phải giữ nguyên clearcoat cũ khi nâng cấp lần 2');
  assert.strictEqual(updated.ior, 1.45, 'Phải giữ nguyên IOR cũ khi nâng cấp lần 2');
  assert.strictEqual(updated.sheen, 0.75, 'Phải cập nhật sheen mới');
});

// 2. Realistic Presets check
test('Realistic Presets: cung cấp đầy đủ các mẫu Glass, Car Paint, Velvet, Water', () => {
  const studio = new MaterialStudio({ THREE });
  const presets = studio.getMaterialPresets();

  assert.ok(presets.glass_crystal, 'Phải có preset glass_crystal');
  const glass = presets.glass_crystal.create();
  assert.strictEqual(glass.isMeshPhysicalMaterial, true, 'Glass phải là MeshPhysicalMaterial');
  assert.strictEqual(glass.transmission, 0.98, 'Glass transmission = 0.98');
  assert.strictEqual(glass.ior, 1.52, 'Glass IOR = 1.52 (chuẩn thủy tinh)');

  assert.ok(presets.car_paint_red, 'Phải có preset car_paint_red');
  const carPaint = presets.car_paint_red.create();
  assert.strictEqual(carPaint.clearcoat, 1.0, 'Car paint clearcoat = 1.0');

  assert.ok(presets.velvet_royal, 'Phải có preset velvet_royal');
  const velvet = presets.velvet_royal.create();
  assert.strictEqual(velvet.sheen, 1.0, 'Velvet sheen = 1.0');

  assert.ok(presets.water_pool, 'Phải có preset water_pool');
  const water = presets.water_pool.create();
  assert.strictEqual(water.ior, 1.333, 'Water IOR = 1.333 (chuẩn nước)');
});

// 3. Procedural Texture Worker: ALL 4 patterns + Sobel normal perturbation + determinism + variance
test('Procedural Texture: đủ 4 mẫu (noise/voronoi/brushed/carbon), Sobel normal thật, tất định theo seed', () => {
  const cases = [
    ['noise', { scale: 4.0, octaves: 3, bumpIntensity: 1.5, seed: 123 }],
    ['voronoi', { cells: 8, mode: 'f1', bumpIntensity: 2.0, seed: 55 }],
    ['voronoi', { cells: 8, mode: 'f2_minus_f1', bumpIntensity: 2.0, seed: 55 }],
    ['brushed', { direction: 'horizontal', scratchDensity: 0.7, grain: 0.15, seed: 77 }],
    ['carbon', { bumpIntensity: 2.0 }],
  ];

  for (const [pattern, opts] of cases) {
    const res = executeProceduralGeneration(pattern, 64, 64, opts);
    assert.strictEqual(res.width, 64);
    assert.strictEqual(res.height, 64);
    assert.strictEqual(res.rgba.length, 64 * 64 * 4);
    assert.strictEqual(res.normals.length, 64 * 64 * 4);

    // Must not be a constant/blank image
    let minL = 255, maxL = 0, validBlue = 0, perturbedNrm = 0;
    for (let i = 0; i < res.rgba.length; i += 4) {
      const l = res.rgba[i];
      if (l < minL) minL = l;
      if (l > maxL) maxL = l;
      if (res.normals[i + 2] >= 120) validBlue++;
      if (Math.abs(res.normals[i] - 127) > 8 || Math.abs(res.normals[i + 1] - 127) > 8) perturbedNrm++;
    }
    assert.ok(maxL - minL >= 30, `Mẫu ${pattern} quá phẳng (range=${maxL - minL})`);
    assert.ok(validBlue / (64 * 64) > 0.99, `Normal map ${pattern} phải hướng +Z`);
    assert.ok(perturbedNrm > 100, `Sobel normal map ${pattern} không có độ nổi thực tế (${perturbedNrm} px)`);
  }

  // Determinism: same seed identical, different seed distinct
  const a1 = executeProceduralGeneration('noise', 32, 32, { seed: 42 });
  const a2 = executeProceduralGeneration('noise', 32, 32, { seed: 42 });
  const b = executeProceduralGeneration('noise', 32, 32, { seed: 99 });
  assert.deepStrictEqual(Buffer.from(a1.rgba), Buffer.from(a2.rgba), 'Cùng seed phải sinh pixel giống hệt');
  assert.notDeepStrictEqual(Buffer.from(a1.rgba), Buffer.from(b.rgba), 'Khác seed phải sinh pixel khác nhau');

  // Worker HDRI equirect generation path
  const hdri = executeProceduralGeneration('hdri', 64, 32, { preset: 'studio-softbox', format: 'half-float' });
  assert.strictEqual(hdri.isHdri, true);
  assert.ok(hdri.rgba instanceof Uint16Array && hdri.rgba.length === 64 * 32 * 4);
});

// 4. Procedural Texture Budget & Invalid Dimension Enforcement
test('Procedural Texture Budget: từ chối > 2048x2048 và kích thước <= 0 / không nguyên', () => {
  assert.throws(() => executeProceduralGeneration('noise', 4096, 4096), /exceeds maximum budget of 2048x2048/i);
  assert.throws(() => executeProceduralGeneration('noise', 2049, 64), /exceeds maximum budget of 2048x2048/i);
  assert.throws(() => executeProceduralGeneration('noise', 0, 64), /positive integers/i);
  assert.throws(() => executeProceduralGeneration('noise', -16, 64), /positive integers/i);
  assert.throws(() => executeProceduralGeneration('noise', 32.5, 32), /positive integers/i);
});

// 5. Procedural Texture Client: Cache Hit, Cache Miss on Option Change & Dispose Cleanup
await testAsync('Procedural Texture Client: cache hit, cache miss khi đổi seed/mode & dispose dọn sạch', async () => {
  const client = new ProceduralTextureClient();

  const res1 = await client.generateTextureMaps('voronoi', 64, 64, { seed: 55, mode: 'f1', bumpIntensity: 2.0 });
  assert.ok(res1.diffuseTexture.isDataTexture);
  assert.ok(res1.normalTexture.isDataTexture);
  assert.strictEqual(res1.diffuseTexture.image.width, 64);

  // Exact same options -> cache hit
  const res2 = await client.generateTextureMaps('voronoi', 64, 64, { seed: 55, mode: 'f1', bumpIntensity: 2.0 });
  assert.strictEqual(res1, res2, 'Cùng tham số phải lấy từ cache');

  // Different mode (f2_minus_f1) with SAME seed -> MUST be cache miss & produce different pixels!
  const res3 = await client.generateTextureMaps('voronoi', 64, 64, { seed: 55, mode: 'f2_minus_f1', bumpIntensity: 2.0 });
  assert.notStrictEqual(res1, res3, 'Đổi mode Voronoi phải tạo entry cache mới');
  assert.notDeepStrictEqual(Buffer.from(res1.rgba), Buffer.from(res3.rgba), 'f1 và f2_minus_f1 phải cho pixel khác nhau');

  // Different seed -> cache miss
  const res4 = await client.generateTextureMaps('voronoi', 64, 64, { seed: 99, mode: 'f1', bumpIntensity: 2.0 });
  assert.notStrictEqual(res1, res4);

  // Over-budget must reject cleanly
  await assert.rejects(() => client.generateTextureMaps('noise', 4096, 4096), /exceeds maximum budget/i);

  // Dispose must dispose textures and clear cache
  let disposedCount = 0;
  res1.diffuseTexture.addEventListener('dispose', () => disposedCount++);
  res1.normalTexture.addEventListener('dispose', () => disposedCount++);
  client.dispose();
  assert.strictEqual(client.cache.size, 0, 'dispose() phải xoá sạch cache');
  assert.strictEqual(disposedCount, 2, 'dispose() phải giải phóng cả diffuse và normal DataTexture');
});

// 6. Environment Raw Source & Rotation/Intensity Parity (asBackground true vs false)
test('Environment Parity: giữ rawEnvironmentSource, rotation, intensity và tôn trọng asBackground=false', () => {
  const scene = new THREE.Scene();
  const originalBg = new THREE.Color(0x101820);
  scene.background = originalBg;
  const renderer = new RasterRenderer();

  const mockPmrem = new THREE.Texture();
  const mockRawEquirect = new THREE.DataTexture(new Uint8Array([255, 200, 150, 255]), 1, 1, THREE.RGBAFormat);
  const rotRad = (45 * Math.PI) / 180;

  // asBackground: false must NOT overwrite scene.background
  renderer.setEnvironment(scene, {
    pmremTexture: mockPmrem,
    rawSource: mockRawEquirect,
    rotation: rotRad,
    intensity: 1.25,
    asBackground: false,
  });
  assert.strictEqual(scene.environment, mockPmrem);
  assert.strictEqual(scene.background, originalBg, 'asBackground=false không được ghi đè scene.background');
  assert.strictEqual(scene.userData.rawEnvironmentSource, mockRawEquirect);
  assert.strictEqual(scene.userData.environmentIntensity, 1.25);
  assert.strictEqual(scene.userData.environmentRotation, rotRad);

  // asBackground: true must update scene.background
  renderer.setEnvironment(scene, {
    pmremTexture: mockPmrem,
    rawSource: mockRawEquirect,
    rotation: rotRad,
    intensity: 1.75,
    asBackground: true,
  });
  assert.strictEqual(scene.background, mockPmrem, 'asBackground=true phải gán scene.background');
  assert.strictEqual(scene.userData.environmentIntensity, 1.75);

  renderer.dispose();
});

// 7. Look-Dev Presets (Fast / Studio / Cinematic) + Return to Fast + Dispose Idempotency
test('Look-Dev Presets: cấu hình AO, Bloom, DOF giữa Fast/Studio/Cinematic & chuyển ngược về Fast + dispose', () => {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);

  const mockRenderer = {
    domElement: { clientWidth: 400, clientHeight: 300 },
    getPixelRatio: () => 1,
    setSize: () => {},
    setPixelRatio: () => {},
    render: () => {},
    getRenderTarget: () => null,
    setRenderTarget: () => {},
    clear: () => {},
    shadowMap: { enabled: false, type: 0 },
    capabilities: { isWebGL2: true },
    getContext: () => ({ getExtension: () => null }),
    state: { setDepthTest: () => {}, setDepthMask: () => {} },
  };

  const post = new PostProcessingManager({
    renderer: mockRenderer,
    scene,
    camera,
    width: 400,
    height: 300,
    preset: POST_PRESETS.FAST,
  });

  assert.strictEqual(post.enabled, false, 'Fast preset phải tắt composer');

  post.applyPreset(POST_PRESETS.STUDIO);
  assert.strictEqual(post.enabled, true);
  assert.strictEqual(post.settings.ao.enabled, true);
  assert.strictEqual(post.settings.bloom.enabled, true);
  assert.strictEqual(post.settings.dof.enabled, false);

  post.applyPreset(POST_PRESETS.CINEMATIC);
  assert.strictEqual(post.enabled, true);
  assert.strictEqual(post.settings.ao.enabled, true);
  assert.strictEqual(post.settings.bloom.enabled, true);
  assert.strictEqual(post.settings.dof.enabled, true);
  assert.strictEqual(post.settings.bloom.strength, 0.55);

  // Switching back to FAST must disable post-processing cleanly
  post.applyPreset(POST_PRESETS.FAST);
  assert.strictEqual(post.enabled, false, 'Chuyển về Fast phải tắt composer');

  // setSize & double dispose must be safe
  post.setSize(640, 360, 1);
  post.dispose();
  post.dispose();
});

console.log(`\nALL ${passed} LOOK-DEV & MATERIAL REALISM TESTS PASSED`);
