/**
 * Web Blender Studio - Path Tracing Environment & Hero Frame Test Suite (Phase 6)
 * Tests procedural HDRI generation, half-float equirect conversion, PMREM/env parity,
 * PathTraceSession caps, AbortController, and HERO frame bounds.
 * Run: node --import ./tests/three-resolve-hooks.mjs tests/test_pathtrace_environment.mjs
 */

import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
  generateProceduralHdriData,
  createProceduralHdriTexture,
  evaluateHdriRadiance,
  toHalfFloat,
} from '../js/render/procedural-hdri.js';
import { buildTracingScene } from '../js/render/pathtrace-scene.js';
import { PathTraceSession, PATHTRACE_CAPS } from '../js/render/pathtrace-session.js';
import { VideoExportManager } from '../js/render/video-export.js';
import { FrameSource } from '../js/render/frame-source.js';
import { unzipSync } from 'three/addons/libs/fflate.module.js';

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    const ret = fn();
    if (ret && typeof ret.then === 'function') {
      throw new Error('Async test function passed to synchronous test() — use await testAsync()!');
    }
    console.log(`ok   ${name}`);
    passed++;
  } catch (err) {
    console.error(`FAIL ${name}`);
    console.error(err);
    failed++;
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
    failed++;
  }
}

console.log('=== Test Suite: Path-Tracing Environment & Hero Frame Parity (Phase 6) ===');

// 1. Procedural HDRI Generation & IEEE 754 Half-Float Edge Cases
test('Procedural HDRI: toHalfFloat chuẩn IEEE 754 (0, 0.5, ±1, ±2, overflow->Inf, ±Inf, NaN)', () => {
  assert.equal(toHalfFloat(0.0), 0x0000);
  assert.equal(toHalfFloat(0.5), 0x3800);
  assert.equal(toHalfFloat(1.0), 0x3c00);
  assert.equal(toHalfFloat(-1.0), 0xbc00);
  assert.equal(toHalfFloat(2.0), 0x4000);
  assert.equal(toHalfFloat(-2.0), 0xc000);

  // Finite overflow (> 65504) MUST produce clean 16-bit +Infinity (0x7c00), NOT NaN or > 16-bit!
  assert.equal(toHalfFloat(100001.0), 0x7c00);
  assert.equal(toHalfFloat(-100001.0), 0xfc00);
  assert.equal(toHalfFloat(Infinity), 0x7c00);
  assert.equal(toHalfFloat(-Infinity), 0xfc00);

  // NaN MUST encode as half-float NaN (exponent=31, mantissa!=0, fits in 16 bits)
  const hNan = toHalfFloat(NaN);
  assert.ok(hNan <= 0xffff && (hNan & 0x7c00) === 0x7c00 && (hNan & 0x03ff) !== 0, `toHalfFloat(NaN) invalid: 0x${hNan.toString(16)}`);
});

test('Procedural HDRI: evaluateHdriRadiance cho đặc tính màu/độ chói đúng từng preset & fallback an toàn', () => {
  // Golden Sunset: sun core at [0, 0.15, 0.988] must be intensely warm HDR
  const [sr, sg, sb] = evaluateHdriRadiance('golden-sunset', 0, 0.15, 0.988);
  assert.ok(sr > 15 && sr > sg && sg > sb, `Golden sunset sun core sai: [${sr},${sg},${sb}]`);

  // Cyberpunk Neon: cyan strip vs magenta strip
  const [cr, cg, cb] = evaluateHdriRadiance('cyberpunk-neon', -0.75, 0.5, 0.43);
  assert.ok(cb > cr * 5 && cg > cr * 5, `Cyberpunk cyan strip sai: [${cr},${cg},${cb}]`);
  const [mr, mg, mb] = evaluateHdriRadiance('cyberpunk-neon', 0.75, 0.5, 0.43);
  assert.ok(mr > mg * 5 && mb > mg * 5, `Cyberpunk magenta strip sai: [${mr},${mg},${mb}]`);

  // Studio Softbox: key light brighter than floor bounce; unknown preset falls back to studio-softbox
  const [kr, kg, kb] = evaluateHdriRadiance('studio-softbox', 0.5, 0.707, 0.5);
  const [fr, fg, fb] = evaluateHdriRadiance('studio-softbox', 0, -1, 0);
  assert.ok(kr + kg + kb > (fr + fg + fb) * 20, 'Studio key softbox phải sáng hơn sàn nhiều lần');
  assert.deepEqual(
    evaluateHdriRadiance('unknown-preset-xyz', 0.5, 0.707, 0.5),
    [kr, kg, kb],
    'Preset không tồn tại phải fallback an toàn về studio-softbox'
  );
});

test('Procedural HDRI: sinh đầy đủ 4 preset với giá trị HDR thực (> 1.0)', () => {
  const presets = ['studio-softbox', 'golden-sunset', 'cyberpunk-neon', 'industrial-warehouse'];

  for (const preset of presets) {
    const res = generateProceduralHdriData({ preset, width: 128, height: 64, format: 'float' });
    assert.equal(res.width, 128);
    assert.equal(res.height, 64);
    assert.equal(res.data.length, 128 * 64 * 4);

    let maxVal = 0;
    for (let i = 0; i < res.data.length; i += 4) {
      const r = res.data[i];
      const g = res.data[i + 1];
      const b = res.data[i + 2];
      const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      if (lum > maxVal) maxVal = lum;
    }

    assert.ok(
      maxVal > 2.0,
      `Preset ${preset} phải có độ chói HDR cực đại > 2.0 (thực tế: ${maxVal})`
    );
  }
});

test('Procedural HDRI: hỗ trợ xuất định dạng HalfFloat (Uint16Array) cho GPU', () => {
  const res = generateProceduralHdriData({ preset: 'studio-softbox', width: 64, height: 32, format: 'half-float' });
  assert.equal(res.format, 'half-float');
  assert.ok(res.data instanceof Uint16Array);
  assert.equal(res.data.length, 64 * 32 * 4);

  // Check that alpha channel is 1.0 in half float (0x3c00)
  assert.equal(res.data[3], 0x3c00);
});

test('Procedural HDRI: createProceduralHdriTexture tạo DataTexture chuẩn Three.js r160', () => {
  const texture = createProceduralHdriTexture({
    preset: 'golden-sunset',
    width: 64,
    height: 32,
    THREE,
  });

  assert.ok(texture.isDataTexture);
  assert.equal(texture.format, THREE.RGBAFormat);
  assert.equal(texture.type, THREE.HalfFloatType);
  assert.equal(texture.mapping, THREE.EquirectangularReflectionMapping);
  assert.equal(texture.image.width, 64);
  assert.equal(texture.image.height, 32);
  assert.ok(texture.image.data instanceof Uint16Array);

  texture.dispose();
});

// 2. PMREM / Environment Parity in buildTracingScene
test('Environment Parity: nhận rawEnvironmentSource từ userData và giữ nguyên rotation + intensity', () => {
  const scene = new THREE.Scene();
  const rawHdr = createProceduralHdriTexture({
    preset: 'studio-softbox',
    width: 64,
    height: 32,
    THREE,
  });

  // Attach raw equirect source and custom transform
  scene.userData.rawEnvironmentSource = rawHdr;
  scene.userData.environmentIntensity = 1.75;
  scene.userData.environmentRotation = 45; // 45 degrees

  // Add dummy PBR mesh so snapshot has meshCount > 0
  const geom = new THREE.BoxGeometry(1, 1, 1);
  const mat = new THREE.MeshStandardMaterial({ color: 0xff0000 });
  scene.add(new THREE.Mesh(geom, mat));

  const snapshot = buildTracingScene({ scene });

  assert.equal(snapshot.environmentSkipped, false, 'Không được skip rawEnvironmentSource');
  assert.ok(snapshot.scene.environment, 'Snapshot scene phải có environment');
  assert.equal(snapshot.scene.environment.type, THREE.HalfFloatType);
  assert.equal(snapshot.environmentIntensity, 1.75);
  assert.equal(snapshot.scene.environmentIntensity, 1.75);

  // Rotation verification (45 degrees = PI/4 rad)
  const expectedY = (45 * Math.PI) / 180;
  assert.ok(
    Math.abs(snapshot.environmentRotation.y - expectedY) < 1e-4,
    `Góc xoay môi trường phải là ${expectedY}, thực tế ${snapshot.environmentRotation.y}`
  );

  snapshot.dispose();
  rawHdr.dispose();
  geom.dispose();
  mat.dispose();
});

test('Environment Parity: PMREM thông thường không có rawSource vẫn giữ tương thích ngược (environmentSkipped=true)', () => {
  const scene = new THREE.Scene();
  const pmremRenderTarget = new THREE.WebGLRenderTarget(4, 4, { type: THREE.HalfFloatType });
  scene.environment = pmremRenderTarget.texture;

  const geom = new THREE.BoxGeometry(1, 1, 1);
  const mat = new THREE.MeshStandardMaterial();
  scene.add(new THREE.Mesh(geom, mat));

  const snapshot = buildTracingScene({ scene });

  assert.equal(snapshot.scene.environment, null);
  assert.equal(snapshot.environmentSkipped, true);

  snapshot.dispose();
  pmremRenderTarget.dispose();
  geom.dispose();
  mat.dispose();
});

// 3. PathTraceSession Caps, Concurrency Guard & AbortSignal
await testAsync('PathTraceSession: Giới hạn ngân sách (<=256 spp, <=2MP, >0px), khoá busy & AbortSignal', async () => {
  const session = new PathTraceSession({
    scene: new THREE.Scene(),
    camera: new THREE.PerspectiveCamera(),
    renderer: { getSize: (v) => v.set(640, 360) },
  });

  // Valid calls
  assert.doesNotThrow(() => session.validateCaps({ samples: 32, width: 1280, height: 720 }));
  assert.doesNotThrow(() => session.validateCaps({ samples: 256, width: 1920, height: 1080 }));

  // Invalid samples
  assert.throws(() => session.validateCaps({ samples: 0 }), /Samples must be an integer/);
  assert.throws(() => session.validateCaps({ samples: 257 }), /Samples must be an integer/);
  assert.throws(() => session.validateCaps({ samples: 64.5 }), /Samples must be an integer/);

  // Zero / negative / non-finite dimensions
  assert.throws(() => session.validateCaps({ samples: 16, width: 0, height: 360 }), /positive finite/i);
  assert.throws(() => session.validateCaps({ samples: 16, width: -64, height: 360 }), /positive finite/i);
  assert.throws(() => session.validateCaps({ samples: 16, width: 640, height: NaN }), /positive finite/i);

  // Dimension / Pixel cap (> 1920*1080 px or > 2048px side)
  assert.throws(
    () => session.validateCaps({ samples: 64, width: 2560, height: 1440 }),
    /exceeds the maximum limit/
  );
  assert.throws(
    () => session.validateCaps({ samples: 64, width: 2049, height: 500 }),
    /exceed the maximum dimension/
  );

  // Pre-aborted AbortSignal returns null cleanly and leaves busy=false
  const ac = new AbortController();
  ac.abort();
  const abortedRes = await session.render({ samples: 16, width: 320, height: 180, signal: ac.signal });
  assert.equal(abortedRes, null);
  assert.equal(session.busy, false);

  // Concurrent render guard
  session.busy = true;
  await assert.rejects(() => session.render({ samples: 16 }), /already running/i);
  session.busy = false;
});

// 4. Hero Frame Bounds, Timeline Seek & Warning (PROPERLY AWAITED!)
await testAsync('PathTraceSession: Hero Frame tua timeline đúng frame, kẹp <= 32 samples và cảnh báo flicker', async () => {
  let warningMessage = null;
  const originalWarn = console.warn;
  console.warn = (...args) => {
    warningMessage = args.join(' ');
  };

  try {
    const events = [];
    const timeline = {
      seekToFrame(f, immediate) {
        events.push(`seek:${f}:${immediate}`);
      },
    };
    const session = new PathTraceSession({
      scene: new THREE.Scene(),
      camera: new THREE.PerspectiveCamera(),
      timeline,
    });

    assert.equal(PATHTRACE_CAPS.HERO_FRAME_MAX_SAMPLES, 32);

    let passedSamples = null;
    session.render = async (opts) => {
      events.push(`render:${opts.samples}`);
      passedSamples = opts.samples;
      return { canvas: {}, width: 640, height: 360, samples: opts.samples };
    };

    const res = await session.renderHeroFrame({
      frameIndex: 15,
      samples: 64,
    });

    assert.equal(res.frameIndex, 15);
    assert.equal(passedSamples, 32, 'Hero frame phải bị kẹp ở mức tối đa 32 samples');
    assert.deepEqual(events, ['seek:15:true', 'render:32'], 'Phải seek timeline trước khi gọi render()');
    assert.ok(
      warningMessage && warningMessage.includes('flicker'),
      'Must emit flicker warning for hero frame'
    );
  } finally {
    console.warn = originalWarn;
  }
});

// 5. Real VideoExportManager Hero Frame Routing (frames 0 & 2 raster, frame 1 hero path-trace capped <= 32)
await testAsync('VideoExportManager: Định tuyến heroFrames thật (chỉ frame 1 qua PathTrace <=32 spp, còn lại raster)', async () => {
  const fakePng = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 9]);
  const timeline = { startFrame: 0, endFrame: 2, fps: 30, currentFrame: 0, isPlaying: false, pause() {}, seekToFrame(f) { this.currentFrame = f; } };
  const manager = new VideoExportManager({
    renderer: {},
    scene: new THREE.Scene(),
    camera: new THREE.PerspectiveCamera(),
    timeline,
  });

  const origHero = PathTraceSession.prototype.renderHeroFrame;
  const origCapture = FrameSource.prototype.captureFrame;
  const origEncode = FrameSource.prototype.encodeCanvasToPngBytes;
  const origWarn = console.warn;

  const heroCalls = [];
  let rasterCaptures = 0;
  console.warn = () => {};
  PathTraceSession.prototype.renderHeroFrame = async (opts) => {
    heroCalls.push({ frameIndex: opts.frameIndex, samples: opts.samples });
    return { canvas: { width: 32, height: 32 }, frameIndex: opts.frameIndex };
  };
  FrameSource.prototype.captureFrame = () => {
    rasterCaptures++;
    return { frameHash: 1n, canvas: { width: 32, height: 32 } };
  };
  FrameSource.prototype.encodeCanvasToPngBytes = async () => fakePng;

  try {
    const res = await manager.renderVideo({
      width: 32,
      height: 32,
      fps: 30,
      startFrame: 0,
      endFrame: 2,
      format: 'png-sequence',
      heroFrames: { frames: [1], samples: 99 },
    });

    assert.equal(res.frameCount, 3);
    assert.deepEqual(heroCalls, [{ frameIndex: 1, samples: 32 }], 'Chỉ frame 1 được path-trace và phải kẹp samples=32');
    assert.equal(rasterCaptures, 2, 'Frame 0 và 2 phải đi đường raster (2 lần capture)');
    const entries = unzipSync(new Uint8Array(await res.blob.arrayBuffer()));
    assert.ok(entries['frame_0000.png'] && entries['frame_0001.png'] && entries['frame_0002.png']);
  } finally {
    PathTraceSession.prototype.renderHeroFrame = origHero;
    FrameSource.prototype.captureFrame = origCapture;
    FrameSource.prototype.encodeCanvasToPngBytes = origEncode;
    console.warn = origWarn;
  }
});

console.log();
if (failed === 0) {
  console.log(`ALL ${passed} PATH-TRACING ENVIRONMENT & HERO TESTS PASSED`);
} else {
  console.error(`FAILED: ${failed} tests failed.`);
  process.exit(1);
}
