/**
 * Automated Test Suite for Phase 5: Deterministic Client-Side Video Export (Rust WASM + WebCodecs)
 * Tests Rust Video Kernel (flip_y, yuv420p, frame_hash),
 * VideoExportManager budget validation (<=1080p, <=1800 frames),
 * Deterministic frame timestamp calculation, MP4 Muxer integration,
 * cancellation with AbortController, and DSL/bpy compatibility.
 * File: tests/test_video_export.mjs
 */

import assert from 'node:assert';
import * as THREE from 'three';
import {
  initVideoKernel,
  isVideoKernelReady,
  getVideoKernelVersion,
  flipYInPlace,
  rgbaToYuv420p,
  computeFrameHash,
  computeFrameDiff,
  applyColorGradeInPlace,
  burnInMetadataInPlace,
  downscaleRgbaBox,
} from '../js/render/video-kernel-bridge.js';
import { VideoExportManager, VIDEO_BUDGET, formatTimecode, buildExportFilename } from '../js/render/video-export.js';
import { VideoEncoderClient, probePreferredVideoConfig } from '../js/render/video-encoder.js';
import { Muxer as Mp4Muxer, ArrayBufferTarget as Mp4ArrayBufferTarget } from 'mp4-muxer';
import {
  WebGPUPathTracer,
  computeChunkSchedule,
  selectRequiredGpuLimits,
  classifyGpuAdapterInfo,
  WebGPUDeviceLostError,
} from '../js/render/webgpu-pathtracer.js';
import { WebMMuxer } from '../js/render/webm-muxer.js';
import { FrameSource } from '../js/render/frame-source.js';
import { RasterRenderer } from '../js/render/raster-renderer.js';
import { packSceneForRust, packSceneGeometryForRefit, isRenderExcludedHelper } from '../js/render/rust-scene-pack.js';
import {
  computeScaledResolution,
  computeRecommendedBitrate,
  detectAnimationFrameRange,
} from '../js/ui/video-render-dialog.js';
import { unzipSync, strFromU8 } from 'three/addons/libs/fflate.module.js';

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

console.log('=== Test Suite: Video Export (Rust WASM + Deterministic Seek + Muxer) ===');

// 1. Initialize Rust Video Kernel WASM
await testAsync('Rust Video Kernel: nạp module WASM thành công trong Node', async () => {
  const ok = await initVideoKernel();
  assert.strictEqual(ok, true, 'Rust video kernel WASM phải nạp thành công');
  assert.strictEqual(isVideoKernelReady(), true, 'isVideoKernelReady phải trả về true');
});

// 2. Rust WASM flipYInPlace
test('Rust Video Kernel: đảo dòng Y in-place siêu tốc', () => {
  const width = 4;
  const height = 3;
  // Row 0: Red [255, 0, 0, 255]
  // Row 1: Green [0, 255, 0, 255]
  // Row 2: Blue [0, 0, 255, 255]
  const rgba = new Uint8Array(width * height * 4);
  for (let c = 0; c < width; c++) {
    // Row 0
    rgba[c * 4] = 255;
    rgba[c * 4 + 3] = 255;
    // Row 1
    rgba[(width + c) * 4 + 1] = 255;
    rgba[(width + c) * 4 + 3] = 255;
    // Row 2
    rgba[(width * 2 + c) * 4 + 2] = 255;
    rgba[(width * 2 + c) * 4 + 3] = 255;
  }

  flipYInPlace(rgba, width, height);

  // After flip:
  // Row 0 must be Blue [0, 0, 255, 255]
  // Row 1 must remain Green [0, 255, 0, 255]
  // Row 2 must be Red [255, 0, 0, 255]
  assert.strictEqual(rgba[2], 255, 'Hàng 0 sau flip phải là Blue');
  assert.strictEqual(rgba[0], 0, 'Hàng 0 sau flip không được là Red');

  const midRow = width * 4;
  assert.strictEqual(rgba[midRow + 1], 255, 'Hàng giữa phải giữ nguyên Green');

  const lastRow = width * 2 * 4;
  assert.strictEqual(rgba[lastRow], 255, 'Hàng cuối sau flip phải là Red');
});

// 3. Rust WASM rgbaToYuv420p (White + Pure Red + Pure Blue chroma verification)
test('Rust Video Kernel: chuyển đổi phẳng RGBA sang YUV420p theo chuẩn BT.601 (Trắng, Đỏ, Xanh dương)', () => {
  const w = 4;
  const h = 4;
  const fillSolid = (r, g, b) => {
    const buf = new Uint8Array(w * h * 4);
    for (let i = 0; i < buf.length; i += 4) {
      buf[i] = r; buf[i + 1] = g; buf[i + 2] = b; buf[i + 3] = 255;
    }
    return buf;
  };

  // Pure white: Y ~ 255 (or 235 studio), U ~ 128, V ~ 128
  const white = rgbaToYuv420p(fillSolid(255, 255, 255), w, h);
  assert.strictEqual(white.yPlane.length, w * h);
  assert.strictEqual(white.uPlane.length, (w / 2) * (h / 2));
  assert.strictEqual(white.vPlane.length, (w / 2) * (h / 2));
  assert.ok(white.yPlane[0] >= 234 && white.yPlane[0] <= 255, `Y trắng không hợp lệ: ${white.yPlane[0]}`);
  assert.ok(Math.abs(white.uPlane[0] - 128) <= 2, `U trắng phải ~128 (thực tế: ${white.uPlane[0]})`);
  assert.ok(Math.abs(white.vPlane[0] - 128) <= 2, `V trắng phải ~128 (thực tế: ${white.vPlane[0]})`);

  // Pure Red (255,0,0): BT.601 -> Y ~ 76, U < 100 (~85), V > 220 (~255)
  const red = rgbaToYuv420p(fillSolid(255, 0, 0), w, h);
  assert.ok(red.yPlane[0] >= 60 && red.yPlane[0] <= 90, `Y đỏ bất thường: ${red.yPlane[0]}`);
  assert.ok(red.uPlane[0] < 100, `U đỏ phải < 100 (thực tế: ${red.uPlane[0]})`);
  assert.ok(red.vPlane[0] > 220, `V đỏ phải > 220 (thực tế: ${red.vPlane[0]})`);

  // Pure Blue (0,0,255): BT.601 -> Y ~ 29, U > 220 (~255), V < 115 (~107)
  const blue = rgbaToYuv420p(fillSolid(0, 0, 255), w, h);
  assert.ok(blue.yPlane[0] >= 15 && blue.yPlane[0] <= 45, `Y xanh dương bất thường: ${blue.yPlane[0]}`);
  assert.ok(blue.uPlane[0] > 220, `U xanh dương phải > 220 (thực tế: ${blue.uPlane[0]})`);
  assert.ok(blue.vPlane[0] < 115, `V xanh dương phải < 115 (thực tế: ${blue.vPlane[0]})`);
});

// 4. Rust WASM 64-bit Frame Hash (verifies ALL channels R, G, B, A — not just R!)
test('Rust Video Kernel: băm hash 64-bit phân biệt đủ 4 kênh R/G/B/A và tất định', () => {
  const bufA = new Uint8Array([10, 20, 30, 255, 40, 50, 60, 255]);
  const bufB = new Uint8Array([10, 20, 30, 255, 40, 50, 60, 255]);
  const diffR = new Uint8Array([10, 20, 30, 255, 99, 50, 60, 255]);
  const green = new Uint8Array([0, 255, 0, 255, 0, 255, 0, 255]);
  const blue = new Uint8Array([0, 0, 255, 255, 0, 0, 255, 255]);
  const halfAlpha = new Uint8Array([0, 0, 255, 128, 0, 0, 255, 255]);

  const hashA = computeFrameHash(bufA);
  assert.notStrictEqual(hashA, 0n, 'Hash phải khác 0');
  assert.strictEqual(hashA, computeFrameHash(bufB), 'Cùng frame pixel phải có cùng hash tất định');
  assert.notStrictEqual(hashA, computeFrameHash(diffR), 'Khác kênh R phải cho hash khác');
  assert.notStrictEqual(computeFrameHash(green), computeFrameHash(blue), 'Khác kênh G/B phải cho hash khác');
  assert.notStrictEqual(computeFrameHash(blue), computeFrameHash(halfAlpha), 'Khác kênh Alpha phải cho hash khác');
  assert.strictEqual(computeFrameHash(new Uint8Array(0)), 0n, 'Buffer rỗng phải trả 0n');
});

// 5. Video Budget Validation + Edge Cases
test('VideoExportManager: Kiểm soát ngân sách & biên (<=1080p, >=16px, <=1800f, end<start, frameStep=0)', () => {
  const manager = new VideoExportManager();

  // Valid budget
  const valid = manager.validateBudget({ width: 1280, height: 720, startFrame: 0, endFrame: 60 });
  assert.strictEqual(valid.width, 1280);
  assert.strictEqual(valid.totalFrames, 61);

  // Below minimum resolution
  assert.throws(
    () => manager.validateBudget({ width: 8, height: 8 }),
    /below minimum 16x16/i,
    'Must reject resolution below 16x16'
  );

  // Over-resolution
  assert.throws(
    () => manager.validateBudget({ width: 3840, height: 2160 }),
    /exceeds budget maximum/i,
    'Must reject resolution exceeding 1080p'
  );

  // Over-frame count
  assert.throws(
    () => manager.validateBudget({ startFrame: 0, endFrame: 2500 }),
    /exceeds budget maximum/i,
    'Must reject frame count exceeding 1800'
  );

  // Inverted range (endFrame < startFrame) clamps to 1 frame; frameStep=0 clamps to 1
  const inverted = manager.validateBudget({ startFrame: 50, endFrame: 10, frameStep: 0 });
  assert.strictEqual(inverted.endFrame, 50);
  assert.strictEqual(inverted.frameStep, 1);
  assert.strictEqual(inverted.totalFrames, 1);

  // Odd resolution preserved for png-sequence (lossless), rounded even for mp4/webm
  const oddPng = manager.validateBudget({ width: 129, height: 73, format: 'png-sequence' });
  assert.strictEqual(oddPng.width, 129);
  assert.strictEqual(oddPng.height, 73);
});

// 6. Real VideoExportManager Timeline Pause/Restore, Frame Sequence, Progress & TimeSec
await testAsync('VideoExportManager: Trình tự seekToFrame, timeSec, progress và khôi phục timeline thật', async () => {
  const fakePng = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
  let pausedCalled = false;
  const sought = [];
  const timeline = {
    fps: 30,
    startFrame: 0,
    endFrame: 100,
    currentFrame: 7,
    isPlaying: true,
    pause() { pausedCalled = true; this.isPlaying = false; },
    seekToFrame(f) { sought.push(f); this.currentFrame = f; },
  };
  const manager = new VideoExportManager({
    scene: new THREE.Scene(),
    camera: new THREE.PerspectiveCamera(),
    timeline,
  });

  const beforeEvents = [];
  const progressEvents = [];
  const origEncode = FrameSource.prototype.encodeCanvasToPngBytes;
  FrameSource.prototype.encodeCanvasToPngBytes = async () => fakePng;
  try {
    const res = await manager.renderVideo({
      width: 32,
      height: 32,
      fps: 30,
      startFrame: 10,
      endFrame: 20,
      frameStep: 5,
      format: 'png-sequence',
      onBeforeFrame: (ev) => beforeEvents.push(ev),
      onProgress: (ev) => progressEvents.push(ev),
    });

    assert.strictEqual(pausedCalled, true, 'Phải tạm dừng timeline đang chạy trước khi xuất');
    assert.deepStrictEqual(beforeEvents.map((e) => e.currentFrame), [10, 15, 20]);
    assert.deepStrictEqual(beforeEvents.map((e) => e.frameIndex), [0, 1, 2]);
    assert.ok(Math.abs(beforeEvents[1].timeSec - (1 / 30)) < 1e-6);
    assert.ok(Math.abs(beforeEvents[2].timeSec - (2 / 30)) < 1e-6);
    assert.strictEqual(progressEvents.length, 3);
    assert.strictEqual(progressEvents[2].progress, 1);
    assert.strictEqual(timeline.currentFrame, 7, 'Phải khôi phục currentFrame gốc của timeline trong finally');
    assert.strictEqual(sought[sought.length - 1], 7);
    assert.strictEqual(res.frameCount, 3);
  } finally {
    FrameSource.prototype.encodeCanvasToPngBytes = origEncode;
  }
});

// 7. VideoEncoderClient error-guards (requireFrames, probeCapabilities) + real MP4 Muxer box output
await testAsync('VideoEncoderClient & MP4 Muxer: requireFrames chặn 0-chunk, probeCapabilities an toàn, mp4-muxer sinh ftyp/moov thật', async () => {
  const caps = await VideoEncoderClient.probeCapabilities(1280, 720, 30);
  assert.strictEqual(caps.webCodecs, false);
  assert.strictEqual(caps.mp4, false);
  assert.strictEqual(caps.webm, false);

  const encoder = new VideoEncoderClient({ width: 640, height: 360, fps: 30, format: 'mp4' });
  await encoder.init();
  assert.strictEqual(encoder.canEncode(), false, 'Không có WebCodecs thì canEncode() phải là false');
  await assert.rejects(
    () => encoder.finalize({ requireFrames: true }),
    /No frames were encoded/i,
    'finalize({ requireFrames: true }) phải báo lỗi khi 0 frame được mã hoá'
  );
  encoder.dispose();

  // Verify real mp4-muxer container assembly (ftyp + mdat + moov boxes)
  const target = new Mp4ArrayBufferTarget();
  const muxer = new Mp4Muxer({
    target,
    video: { codec: 'avc', width: 64, height: 64 },
    fastStart: 'in-memory',
  });
  const avccDesc = new Uint8Array([1, 0x42, 0xe0, 0x1f, 0xff, 0xe1, 0, 4, 0x67, 0x42, 0xe0, 0x1f, 1, 0, 2, 0x68, 0xce]);
  muxer.addVideoChunkRaw(new Uint8Array([0, 0, 0, 2, 0x65, 0x88]), 'key', 0, 33333, {
    decoderConfig: { codec: 'avc1.42e01f', description: avccDesc },
  });
  muxer.addVideoChunkRaw(new Uint8Array([0, 0, 0, 2, 0x41, 0x9a]), 'delta', 33333, 33333);
  muxer.finalize();
  const mp4Bytes = new Uint8Array(target.buffer);
  const ascii = Array.from(mp4Bytes).map((b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : '.')).join('');
  assert.ok(mp4Bytes.byteLength > 200, `MP4 container quá nhỏ: ${mp4Bytes.byteLength} B`);
  assert.ok(ascii.includes('ftyp'), 'MP4 thật phải chứa box ftyp');
  assert.ok(ascii.includes('moov'), 'MP4 thật phải chứa box moov');
  assert.ok(ascii.includes('mdat'), 'MP4 thật phải chứa box mdat');
});

// 8. Immediate & Mid-Render AbortController Cancellation + State Cleanup
await testAsync('VideoExportManager: Huỷ tức thì & giữa chừng bằng AbortSignal phải dọn dẹp isExporting và khôi phục timeline', async () => {
  const fakePng = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2]);
  const timeline = {
    fps: 30,
    startFrame: 0,
    endFrame: 20,
    currentFrame: 4,
    isPlaying: false,
    pause() {},
    seekToFrame(f) { this.currentFrame = f; },
  };
  const manager = new VideoExportManager({
    scene: new THREE.Scene(),
    camera: new THREE.PerspectiveCamera(),
    timeline,
  });

  // 8a. Immediate abort before allocation
  const ac1 = new AbortController();
  ac1.abort();
  await assert.rejects(
    () => manager.renderVideo({ width: 64, height: 64, startFrame: 0, endFrame: 10, format: 'png-sequence', signal: ac1.signal }),
    (err) => err?.name === 'AbortError'
  );
  assert.strictEqual(manager.isExporting, false);

  // 8b. Mid-render abort on frame 2 of 10
  const ac2 = new AbortController();
  let renderedCount = 0;
  const origEncode = FrameSource.prototype.encodeCanvasToPngBytes;
  FrameSource.prototype.encodeCanvasToPngBytes = async () => fakePng;
  try {
    await assert.rejects(
      () => manager.renderVideo({
        width: 32,
        height: 32,
        startFrame: 0,
        endFrame: 9,
        format: 'png-sequence',
        signal: ac2.signal,
        onBeforeFrame: ({ frameIndex }) => {
          renderedCount++;
          if (frameIndex === 2) ac2.abort();
        },
      }),
      (err) => err?.name === 'AbortError'
    );
  } finally {
    FrameSource.prototype.encodeCanvasToPngBytes = origEncode;
  }
  assert.ok(renderedCount <= 3, `Phải dừng sớm ngay khi huỷ ở frame 2 (đã chạy ${renderedCount})`);
  assert.strictEqual(manager.isExporting, false, 'isExporting phải reset về false sau AbortError');
  assert.strictEqual(timeline.currentFrame, 4, 'Timeline phải quay về frame gốc 4 sau khi huỷ giữa chừng');
});

// 9. Concurrency Guard + Mid-Render WebGPUDeviceLostError Automatic Fallback to Rust CPU
await testAsync('VideoExportManager: Khoá chống render song song & tự động fallback WebGPUDeviceLostError -> Rust CPU', async () => {
  const fakePng = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7, 8]);
  const timeline = { fps: 30, startFrame: 0, endFrame: 2, currentFrame: 0, isPlaying: false, pause() {}, seekToFrame(f) { this.currentFrame = f; } };
  const manager = new VideoExportManager({
    scene: new THREE.Scene(),
    camera: new THREE.PerspectiveCamera(),
    timeline,
  });

  // 9a. Concurrent render rejection
  manager.isExporting = true;
  await assert.rejects(
    () => manager.renderVideo({ width: 32, height: 32, startFrame: 0, endFrame: 1, format: 'png-sequence' }),
    /already running/i,
    'Không được cho chạy 2 tác vụ renderVideo song song'
  );
  manager.isExporting = false;

  // 9b. Simulate WebGPU device loss on frame 1 -> must dispose WebGPU, switch to 'rust', and complete all 3 frames!
  const origInit = WebGPUPathTracer.prototype.init;
  const origDispose = WebGPUPathTracer.prototype.dispose;
  const origEncode = FrameSource.prototype.encodeCanvasToPngBytes;
  const origCapture = FrameSource.prototype.captureFrame;
  const origGpuFrame = manager._renderWebGpuFrame;
  const origRustFrame = manager._renderRustFrame;
  let webgpuDisposed = false;
  let rasterCaptureCalls = 0;
  const calls = [];
  WebGPUPathTracer.prototype.init = async () => true;
  WebGPUPathTracer.prototype.dispose = () => { webgpuDisposed = true; };
  FrameSource.prototype.encodeCanvasToPngBytes = async () => fakePng;
  FrameSource.prototype.captureFrame = (...args) => { rasterCaptureCalls++; return origCapture.apply(this, args); };
  manager._renderWebGpuFrame = async ({ frameIdx }) => {
    calls.push(`webgpu:${frameIdx}`);
    if (frameIdx === 1) throw new WebGPUDeviceLostError('Simulated WDDM TDR device reset');
    return { width: 32, height: 32 };
  };
  manager._renderRustFrame = async ({ frameIdx }) => {
    calls.push(`rust:${frameIdx}`);
    return { width: 32, height: 32 };
  };
  try {
    const res = await manager.renderVideo({
      width: 32,
      height: 32,
      startFrame: 0,
      endFrame: 2,
      format: 'png-sequence',
      engine: 'webgpu',
      rustSamples: 4,
    });
    assert.strictEqual(rasterCaptureCalls, 0, `WebGPU/Rust render tuyệt đối không được rơi xuống WebGL captureFrame (gọi ${rasterCaptureCalls} lần)`);
    assert.strictEqual(webgpuDisposed, true, 'WebGPUPathTracer bị lỗi phải được dispose ngay');
    assert.deepStrictEqual(calls, ['webgpu:0', 'webgpu:1', 'rust:1', 'rust:2'], `Thứ tự fallback sai: ${calls}`);
    assert.strictEqual(res.engine, 'rust', 'Kết quả sau fallback phải ghi nhận engine="rust"');
    assert.strictEqual(res.frameCount, 3);
    assert.strictEqual(manager.isExporting, false);
  } finally {
    WebGPUPathTracer.prototype.init = origInit;
    WebGPUPathTracer.prototype.dispose = origDispose;
    FrameSource.prototype.encodeCanvasToPngBytes = origEncode;
    FrameSource.prototype.captureFrame = origCapture;
    manager._renderWebGpuFrame = origGpuFrame;
    manager._renderRustFrame = origRustFrame;
  }
});

// 10. Post-processing parity: video frames go through the composer (GTAO/Bloom/Bokeh)
await testAsync('FrameSource: video dùng post-processing thay vì render target thô', async () => {
  const calls = [];
  const renderer = {
    getSize: (v) => { v.set(800, 600); return v; },
    getPixelRatio: () => 2,
    setPixelRatio: (r) => calls.push(['setPixelRatio', r]),
    setSize: (w, h, updateStyle) => calls.push(['setSize', w, h, updateStyle]),
    getRenderTarget: () => null,
    setRenderTarget: () => calls.push(['setRenderTarget']),
    clear: () => calls.push(['clear']),
    readRenderTargetPixels: () => calls.push(['readRenderTargetPixels']),
    render: () => calls.push(['rawRender']),
    getContext: () => ({
      RGBA: 0x1908,
      UNSIGNED_BYTE: 0x1401,
      readPixels: (x, y, w, h) => calls.push(['readPixels', w, h]),
    }),
  };
  const post = {
    enabled: true,
    setSize: (w, h, ratio) => calls.push(['postSize', w, h, ratio]),
    updateCameraAndScene: () => calls.push(['postCamera']),
    render: () => calls.push(['postRender']),
  };
  let preset = 'cinematic';
  const raster = {
    get preset() { return preset; },
    setPreset: (p) => { preset = p; calls.push(['setPreset', p]); },
    postProcessing: post,
    renderFrame: (opts) => calls.push(['rasterRender', opts.target === undefined ? null : opts.target]),
  };
  const camera = {
    isPerspectiveCamera: true,
    aspect: 1,
    updateProjectionMatrix: () => calls.push(['updateProjection']),
  };

  const frameSource = new FrameSource({
    renderer,
    rasterRenderer: raster,
    scene: {},
    camera,
    width: 8,
    height: 6,
    preset: 'studio',
  });

  assert.strictEqual(frameSource._usesPostProcessing(), true, 'Preset cinematic phải dùng post-processing');
  await frameSource.init();
  assert.strictEqual(preset, 'studio', 'postPreset phải ghi đè preset khi xuất');
  assert.ok(calls.some((c) => c[0] === 'setSize' && c[1] === 8 && c[2] === 6 && c[3] === false),
    'Renderer phải được resize về độ phân giải video');
  assert.ok(calls.some((c) => c[0] === 'postSize' && c[1] === 8 && c[2] === 6 && c[3] === 1),
    'Composer phải được resize về độ phân giải video');

  frameSource.captureFrame({ createVideoFrame: false });
  const rasterCalls = calls.filter((c) => c[0] === 'rasterRender');
  assert.strictEqual(rasterCalls.length, 1, 'Phải render đúng một frame');
  assert.strictEqual(rasterCalls[0][1], null, 'Đường post-processing phải render ra canvas (target = null)');
  assert.ok(calls.some((c) => c[0] === 'readPixels' && c[1] === 8 && c[2] === 6),
    'Frame phải được đọc từ framebuffer đúng kích thước video');
  assert.ok(!calls.some((c) => c[0] === 'readRenderTargetPixels'),
    'Không được đọc render target thô khi post-processing bật');

  frameSource.dispose();
  assert.strictEqual(preset, 'cinematic', 'Preset viewport phải được khôi phục sau khi xuất');
  assert.ok(calls.some((c) => c[0] === 'setSize' && c[1] === 800 && c[2] === 600),
    'Renderer phải được trả về kích thước viewport');
  assert.ok(calls.some((c) => c[0] === 'setPixelRatio' && c[1] === 2),
    'Pixel ratio viewport phải được khôi phục');
});

test('FrameSource: preset fast hoặc postProcess:false tắt post-processing', () => {
  const renderer = { getContext: () => ({}) };
  const fast = new FrameSource({
    renderer,
    rasterRenderer: { preset: 'fast', postProcessing: { enabled: true } },
    width: 8,
    height: 6,
  });
  assert.strictEqual(fast._usesPostProcessing(), false, 'Preset fast không dùng composer');

  const off = new FrameSource({
    renderer,
    rasterRenderer: { preset: 'studio', postProcessing: { enabled: true } },
    width: 8,
    height: 6,
    postProcess: false,
  });
  assert.strictEqual(off._usesPostProcessing(), false, 'postProcess:false phải tắt composer');

  const override = new FrameSource({
    renderer,
    rasterRenderer: { preset: 'fast', postProcessing: { enabled: false } },
    width: 8,
    height: 6,
    preset: 'cinematic',
  });
  assert.strictEqual(override._usesPostProcessing(), true,
    'postPreset phải bật composer dù viewport đang ở preset fast');
});

// 12. Rust Video Kernel v2 (+simd128): metadata burn-in, color grade (exposure/contrast/saturation/vignette), frame diff & downscale
test('Rust Video Kernel v2: Metadata Burn-In, Color Grade (Exposure/Contrast/Saturation/Vignette), Frame Diff & Downscale', () => {
  assert.ok(getVideoKernelVersion() >= 2, `video_kernel version phải >= 2 (thực tế: ${getVideoKernelVersion()})`);

  const w = 160;
  const h = 48;
  const bufA = new Uint8Array(w * h * 4).fill(120);
  const bufB = new Uint8Array(w * h * 4).fill(120);
  assert.strictEqual(computeFrameDiff(bufA, bufB), 0, '2 frame giống hệt nhau phải có diff = 0');

  burnInMetadataInPlace(bufA, w, h, 'F:0042 | 00:00:01:12 | RUST CYCLES', { position: 'bottom', scale: 1 });
  const diffAfterStamp = computeFrameDiff(bufA, bufB);
  assert.ok(diffAfterStamp > 0.01, `Burn-in metadata phải làm thay đổi pixel thanh đáy (diff=${diffAfterStamp})`);

  // Exposure 1.5x, Exposure=0 (fade-to-black), Exposure=10 clamp, Contrast=0 (flat mid-gray 128)
  const gradeBuf = new Uint8Array(16 * 16 * 4);
  for (let i = 0; i < gradeBuf.length; i += 4) {
    gradeBuf[i] = 100; gradeBuf[i + 1] = 100; gradeBuf[i + 2] = 100; gradeBuf[i + 3] = 255;
  }
  applyColorGradeInPlace(gradeBuf, 16, 16, { exposure: 1.5, contrast: 1.0, saturation: 1.0, vignette: 0.0 });
  assert.ok(gradeBuf[0] >= 145 && gradeBuf[0] <= 155, `Exposure 1.5x từ 100 phải ~150 (thực tế: ${gradeBuf[0]})`);

  const darkBuf = new Uint8Array([150, 100, 50, 255, 150, 100, 50, 255, 150, 100, 50, 255, 150, 100, 50, 255]);
  applyColorGradeInPlace(darkBuf, 2, 2, { exposure: 0.0, contrast: 1.0, saturation: 1.0, vignette: 0.0 });
  assert.strictEqual(darkBuf[0], 0, `Exposure=0 phải ra đen tuyệt đối 0 (thực tế: ${darkBuf[0]})`);
  assert.strictEqual(darkBuf[3], 255, 'Alpha phải được giữ nguyên khi exposure=0');

  const flatCtr = new Uint8Array([20, 240, 100, 255]);
  applyColorGradeInPlace(flatCtr, 1, 1, { exposure: 1.0, contrast: 0.0, saturation: 1.0, vignette: 0.0 });
  assert.ok(Math.abs(flatCtr[0] - 128) <= 2 && Math.abs(flatCtr[1] - 128) <= 2, `Contrast=0 phải phẳng về ~128 (thực tế: [${flatCtr[0]},${flatCtr[1]}])`);

  // Saturation = 0 must desaturate pure red [210, 40, 40] to neutral gray (R ≈ G ≈ B)
  const satBuf = new Uint8Array(4 * 4 * 4);
  for (let i = 0; i < satBuf.length; i += 4) {
    satBuf[i] = 210; satBuf[i + 1] = 40; satBuf[i + 2] = 40; satBuf[i + 3] = 255;
  }
  applyColorGradeInPlace(satBuf, 4, 4, { exposure: 1.0, contrast: 1.0, saturation: 0.0, vignette: 0.0 });
  assert.ok(Math.abs(satBuf[0] - satBuf[1]) <= 2 && Math.abs(satBuf[1] - satBuf[2]) <= 2,
    `Saturation=0 phải khử màu về xám (thực tế: [${satBuf[0]},${satBuf[1]},${satBuf[2]}])`);

  // Contrast = 1.8 must push dark pixel lower and bright pixel higher
  const ctrBuf = new Uint8Array(2 * 2 * 4);
  ctrBuf.set([60, 60, 60, 255, 200, 200, 200, 255, 60, 60, 60, 255, 200, 200, 200, 255]);
  applyColorGradeInPlace(ctrBuf, 2, 2, { exposure: 1.0, contrast: 1.8, saturation: 1.0, vignette: 0.0 });
  assert.ok(ctrBuf[0] < 45 && ctrBuf[4] > 215, `Contrast 1.8x phải kéo giãn tối/sáng (${ctrBuf[0]} vs ${ctrBuf[4]})`);

  // Vignette = 0.8 must darken corner (0,0) strictly more than center (8,8)
  const vigBuf = new Uint8Array(16 * 16 * 4);
  for (let i = 0; i < vigBuf.length; i += 4) {
    vigBuf[i] = 200; vigBuf[i + 1] = 200; vigBuf[i + 2] = 200; vigBuf[i + 3] = 255;
  }
  applyColorGradeInPlace(vigBuf, 16, 16, { exposure: 1.0, contrast: 1.0, saturation: 1.0, vignette: 0.8 });
  const cornerVal = vigBuf[0];
  const centerVal = vigBuf[(8 * 16 + 8) * 4];
  assert.ok(centerVal > cornerVal + 40, `Vignette phải làm tối góc (${cornerVal}) hơn tâm (${centerVal})`);

  const small = downscaleRgbaBox(gradeBuf, 16, 16, 4, 4);
  assert.strictEqual(small.length, 4 * 4 * 4);
  assert.ok(Math.abs(small[0] - gradeBuf[0]) <= 2, 'Box downscale trên nền phẳng phải giữ nguyên màu');
});

// 13. Vertical 9:16 (1080x1920), Square (1080x1080), Even Rounding, Timecode & Filename Sanitization
test('VideoExportManager: Dọc 1080x1920, vuông 1080x1080, làm tròn chẵn, timecode & lọc tên file an toàn', () => {
  const manager = new VideoExportManager();

  const portrait = manager.validateBudget({ width: 1080, height: 1920, startFrame: 0, endFrame: 30 });
  assert.strictEqual(portrait.width, 1080);
  assert.strictEqual(portrait.height, 1920);

  const square = manager.validateBudget({ width: 1080, height: 1080, startFrame: 0, endFrame: 20, frameStep: 2 });
  assert.strictEqual(square.totalFrames, 11, 'Frames 0,2,4,...,20 phải gồm 11 frame');
  assert.strictEqual(square.frameStep, 2);

  const odd = manager.validateBudget({ width: 1281, height: 721, format: 'mp4' });
  assert.strictEqual(odd.width % 2, 0, 'Chiều rộng MP4 phải là số chẵn');
  assert.strictEqual(odd.height % 2, 0, 'Chiều cao MP4 phải là số chẵn');

  assert.strictEqual(formatTimecode(42, 30), '00:00:01:12');
  assert.strictEqual(formatTimecode(-5, 30), '00:00:00:00');
  assert.strictEqual(formatTimecode(NaN, 30), '00:00:00:00');
  assert.strictEqual(formatTimecode(Infinity, 30), '00:00:00:00');
  assert.strictEqual(formatTimecode(30, Infinity), '00:00:01:00');
  assert.strictEqual(formatTimecode(3661 * 30 + 15, 30), '01:01:01:15');
  assert.strictEqual(buildExportFilename('my_shot.mp4', 'webm', 1280, 720), 'my_shot.webm');
  assert.strictEqual(buildExportFilename('clip.MP4', 'webm', 1280, 720), 'clip.webm');
  assert.strictEqual(buildExportFilename('my_shot', 'png-sequence', 1280, 720), 'my_shot.zip');
  assert.strictEqual(buildExportFilename('..', 'mp4', 1280, 720), 'blender_render.mp4');
  assert.strictEqual(buildExportFilename('.mp4', 'mp4', 1280, 720), 'blender_render.mp4');
  const safeName = buildExportFilename('../../evil/clip?:*.mp4', 'mp4', 1280, 720);
  assert.ok(!/[<>:"/\\|?*]/.test(safeName) && !safeName.startsWith('.') && safeName.endsWith('.mp4'), `Tên file chưa được lọc an toàn: ${safeName}`);
});

// 14. Deterministic WebM EBML Muxer (VP9+Opus+Cues AND VP8 Video-Only)
test('WebMMuxer: Sinh container WebM hợp lệ (EBML, V_VP9+A_OPUS+Cues và V_VP8 video-only)', () => {
  const hasBytes = (haystack, needle) => {
    for (let i = 0; i <= haystack.length - needle.length; i++) {
      let ok = true;
      for (let j = 0; j < needle.length; j++) if (haystack[i + j] !== needle[j]) { ok = false; break; }
      if (ok) return true;
    }
    return false;
  };

  const muxer = new WebMMuxer({
    video: { codec: 'V_VP9', width: 640, height: 360, fps: 30 },
    audio: { sampleRate: 48000, numberOfChannels: 2 },
  });
  muxer.addVideoChunk(new Uint8Array([0x82, 0x49, 0x83, 0x42, 0x01, 0x02]), 0, 33333, true);
  muxer.addVideoChunk(new Uint8Array([0x82, 0x49, 0x83, 0x42, 0x03, 0x04]), 33333, 33333, false);
  muxer.addAudioChunk(new Uint8Array([0xf8, 0xff, 0xfe, 0x00]), 0, 20000);

  const u8 = new Uint8Array(muxer.finalize());
  assert.ok(u8.byteLength > 100, 'File WebM phải có kích thước hợp lệ');
  assert.deepStrictEqual(Array.from(u8.subarray(0, 4)), [0x1a, 0x45, 0xdf, 0xa3]);
  // Cluster ID: 1F 43 B6 75, Cues ID: 1C 53 BB 6B
  assert.ok(hasBytes(u8, [0x1f, 0x43, 0xb6, 0x75]), 'Container WebM phải có Cluster element (1F 43 B6 75)');
  assert.ok(hasBytes(u8, [0x1c, 0x53, 0xbb, 0x6b]), 'Container WebM phải có Cues index (1C 53 BB 6B)');
  const ascii = Array.from(u8).map((b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : '.')).join('');
  assert.ok(ascii.includes('webm'), 'Container phải chứa DocType "webm"');
  assert.ok(ascii.includes('V_VP9'), 'Track video phải là V_VP9');
  assert.ok(ascii.includes('A_OPUS'), 'Track audio phải là A_OPUS');
  assert.ok(ascii.includes('OpusHead'), 'Audio track phải có RFC 7845 OpusHead CodecPrivate');

  // Video-only VP8 mode must NOT emit A_OPUS / OpusHead
  const vp8Muxer = new WebMMuxer({
    video: { codec: 'V_VP8', width: 320, height: 180, fps: 24 },
    audio: null,
  });
  vp8Muxer.addVideoChunk(new Uint8Array([0x10, 0x00, 0x00, 0x9d, 0x01, 0x2a]), 0, 41667, true);
  const vp8Bytes = new Uint8Array(vp8Muxer.finalize());
  const vp8Ascii = Array.from(vp8Bytes).map((b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : '.')).join('');
  assert.ok(vp8Ascii.includes('V_VP8'), 'Video-only track phải là V_VP8');
  assert.ok(!vp8Ascii.includes('A_OPUS') && !vp8Ascii.includes('OpusHead'), 'Chế độ video-only không được sinh track audio');
});

// 16. Rust Scene Packer: Helper filtering, SkinnedMesh baking, fast refit, transparent & shutter
test('Rust Scene Packer: Lọc helper/camera body, bake SkinnedMesh, fast refit, transparent & shutter', () => {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0.1, 0.2, 0.3);

  // Visible box mesh
  const box = new THREE.Mesh(
    new THREE.BoxGeometry(1, 1, 1),
    new THREE.MeshStandardMaterial({ color: 0xff0000 })
  );
  scene.add(box);

  // Helper & Camera body (must be excluded!)
  const grid = new THREE.Mesh(new THREE.PlaneGeometry(10, 10), new THREE.MeshBasicMaterial());
  grid.name = 'Floor_Grid';
  scene.add(grid);
  const camBody = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.5, 0.5), new THREE.MeshStandardMaterial());
  camBody.userData.isCameraPart = true;
  scene.add(camBody);
  assert.strictEqual(isRenderExcludedHelper(grid), true);
  assert.strictEqual(isRenderExcludedHelper(camBody), true);

  // SkinnedMesh with 1 bone rotated 90 degrees around Z
  const skinGeo = new THREE.BufferGeometry();
  skinGeo.setAttribute('position', new THREE.Float32BufferAttribute([1, 0, 0, 1, 1, 0, 0, 1, 0], 3));
  skinGeo.setAttribute('normal', new THREE.Float32BufferAttribute([0, 0, 1, 0, 0, 1, 0, 0, 1], 3));
  skinGeo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], 4));
  skinGeo.setAttribute('skinWeight', new THREE.Float32BufferAttribute([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0], 4));
  const bone = new THREE.Bone();
  const skinned = new THREE.SkinnedMesh(skinGeo, new THREE.MeshStandardMaterial({ color: 0x00ff00 }));
  skinned.add(bone);
  skinned.bind(new THREE.Skeleton([bone]));
  scene.add(skinned);
  scene.updateMatrixWorld(true);
  // Animate bone +90 deg around Z after binding at rest pose
  bone.rotation.z = Math.PI / 2;

  const cam = new THREE.PerspectiveCamera(50, 16 / 9, 0.1, 100);
  cam.position.set(0, 0, 5);
  cam.lookAt(0, 0, 0);

  const packed = packSceneForRust({ scene, camera: cam, width: 320, height: 180, transparent: true, shutter: 0.5 });
  // Box = 12 tris + SkinnedMesh = 1 tri = 13 tris (Floor_Grid & camBody excluded!)
  assert.strictEqual(packed.triCount, 13, `Helper/camera body phải bị loại (kỳ vọng 13 tri, thực tế ${packed.triCount})`);
  assert.strictEqual(packed.env.params[11], 2, 'transparent:true phải đặt bg_mode = 2');
  assert.ok(Math.abs(packed.camera[15] - 0.5) < 1e-5, 'shutter 0.5 phải ghi vào camera[15]');

  // Vertex 0 of SkinnedMesh was (1,0,0), rotated +90° around Z -> (0,1,0)
  const skBase = 12 * 9;
  assert.ok(Math.abs(packed.pos[skBase] - 0) < 1e-3 && Math.abs(packed.pos[skBase + 1] - 1) < 1e-3,
    `SkinnedMesh vertex 0 phải xoay theo xương về (0,1,0), thực tế (${packed.pos[skBase]}, ${packed.pos[skBase + 1]})`);

  // Animate box & bone for frame 1 and test fast refit packing
  box.position.x = 3.0;
  bone.rotation.z = Math.PI; // (1,0,0) -> (-1,0,0)
  const refit = packSceneGeometryForRefit({ scene, camera: cam, width: 320, height: 180, prevPacked: packed, transparent: false, shutter: 0.25 });
  assert.ok(refit && refit.refitOnly === true, 'Fast refit phải trả về gói refitOnly');
  assert.strictEqual(refit.triCount, 13);
  assert.strictEqual(refit.textures, undefined, 'Refit-only không được đóng gói/clone lại textures');
  assert.ok(Math.abs(refit.pos[skBase] - (-1)) < 1e-3 && Math.abs(refit.pos[skBase + 1]) < 1e-3,
    `Refit phải cập nhật SkinnedMesh theo xương mới (-1,0,0), thực tế (${refit.pos[skBase]}, ${refit.pos[skBase + 1]})`);
  assert.strictEqual(refit.env.params[11], 1, 'transparent:false với background màu phải đặt bg_mode = 1');
  assert.ok(Math.abs(refit.camera[15] - 0.25) < 1e-5);
});

// 17. RasterRenderer hides nested camera bodies & helpers during export and restores them
test('RasterRenderer: Ẩn toàn bộ camera body & helper lồng nhau khi hideHelpers=true rồi khôi phục', () => {
  const scene = new THREE.Scene();
  const camGroup = new THREE.Group();
  const camBody = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
  camBody.userData.isCameraPart = true;
  camGroup.add(camBody);
  scene.add(camGroup);

  const solidMesh = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
  scene.add(solidMesh);

  let bodyVisibleDuringRender = true;
  let solidVisibleDuringRender = false;
  const mockRenderer = {
    shadowMap: {},
    getRenderTarget: () => null,
    setRenderTarget: () => {},
    clear: () => {},
    render: () => {
      bodyVisibleDuringRender = camBody.visible;
      solidVisibleDuringRender = solidMesh.visible;
    },
  };
  const rr = new RasterRenderer({ renderer: mockRenderer, scene, camera: new THREE.PerspectiveCamera(), preset: 'fast' });
  rr.renderFrame({ scene, camera: new THREE.PerspectiveCamera(), hideHelpers: true });

  assert.strictEqual(bodyVisibleDuringRender, false, 'Camera body lồng nhau phải bị ẩn trong lúc render');
  assert.strictEqual(solidVisibleDuringRender, true, 'Mesh bình thường phải giữ nguyên visible');
  assert.strictEqual(camBody.visible, true, 'Camera body phải được khôi phục visible=true sau render');
});

// 18. FrameSource transparent background + OrthographicCamera aspect
test('FrameSource: Transparent BG tắt post-processing, khôi phục background & OrthographicCamera', () => {
  const scene = new THREE.Scene();
  const bg = new THREE.Color(0.2, 0.2, 0.2);
  scene.background = bg;
  let clearAlpha = 1;
  let bgDuringRender = bg;
  let alphaDuringRender = 1;
  const renderer = {
    getRenderTarget: () => null,
    setRenderTarget: () => {},
    clear: () => {},
    getClearAlpha: () => clearAlpha,
    setClearAlpha: (a) => { clearAlpha = a; },
    render: (sc) => { bgDuringRender = sc.background; alphaDuringRender = clearAlpha; },
    readRenderTargetPixels: () => {},
  };
  const ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 100);
  const fs = new FrameSource({
    renderer,
    rasterRenderer: { preset: 'studio', postProcessing: { enabled: true } },
    scene,
    camera: ortho,
    width: 16,
    height: 8,
    transparent: true,
  });
  assert.strictEqual(fs._usesPostProcessing(), false, 'Transparent BG phải tắt composer để giữ kênh alpha');
  fs.rasterRenderer = null; // use raw renderer path to observe bg/alpha directly
  fs.captureFrame({ createVideoFrame: false });
  assert.strictEqual(bgDuringRender, null, 'scene.background phải là null trong lúc render transparent');
  assert.strictEqual(alphaDuringRender, 0, 'clearAlpha phải là 0 trong lúc render transparent');
  assert.strictEqual(scene.background, bg, 'scene.background phải được khôi phục sau capture');
  assert.strictEqual(clearAlpha, 1, 'clearAlpha phải được khôi phục về 1');
  assert.strictEqual(ortho.left, -1, 'OrthographicCamera left phải được khôi phục');
  assert.strictEqual(ortho.right, 1, 'OrthographicCamera right phải được khôi phục');
  fs.dispose();
});

// 19. PNG Sequence ZIP Export end-to-end (with frameStep & render_manifest.json)
await testAsync('VideoExportManager: Xuất PNG Sequence (.zip) kèm render_manifest.json và frameStep', async () => {
  const fakePng = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
  const soughtFrames = [];
  const timeline = {
    fps: 24,
    startFrame: 0,
    endFrame: 4,
    currentFrame: 0,
    isPlaying: false,
    pause() {},
    seekToFrame(f) { soughtFrames.push(f); this.currentFrame = f; },
  };
  const manager = new VideoExportManager({
    scene: new THREE.Scene(),
    camera: new THREE.PerspectiveCamera(),
    timeline,
  });

  // Patch encodeCanvasToPngBytes on prototype temporarily for headless Node test (no DOM canvas)
  const origEncode = FrameSource.prototype.encodeCanvasToPngBytes;
  FrameSource.prototype.encodeCanvasToPngBytes = async () => fakePng;
  try {
    const res = await manager.renderVideo({
      width: 64,
      height: 64,
      fps: 24,
      startFrame: 0,
      endFrame: 4,
      frameStep: 2,
      format: 'png-sequence',
      transparent: true,
      filename: 'turntable_test',
    });

    assert.strictEqual(res.format, 'png-sequence');
    assert.strictEqual(res.filename, 'turntable_test.zip');
    assert.strictEqual(res.mimeType, 'application/zip');
    assert.strictEqual(res.frameCount, 3);
    assert.strictEqual(res.transparent, true);
    assert.deepStrictEqual(soughtFrames.slice(0, 3), [0, 2, 4]);

    const unzipped = unzipSync(new Uint8Array(await res.blob.arrayBuffer()));
    assert.ok(unzipped['frame_0000.png'], 'ZIP phải chứa frame_0000.png');
    assert.ok(unzipped['frame_0002.png'], 'ZIP phải chứa frame_0002.png');
    assert.ok(unzipped['frame_0004.png'], 'ZIP phải chứa frame_0004.png');
    assert.ok(unzipped['render_manifest.json'], 'ZIP phải chứa render_manifest.json');
    const manifest = JSON.parse(strFromU8(unzipped['render_manifest.json']));
    assert.strictEqual(manifest.fps, 24);
    assert.strictEqual(manifest.frameCount, 3);
    assert.strictEqual(manifest.transparent, true);
  } finally {
    FrameSource.prototype.encodeCanvasToPngBytes = origEncode;
  }
});

// 20. Render Animation Studio UI pure helpers (Resolution %, Bitrate, Keyframe range)
test('VideoRenderDialog helpers: Resolution %, Bitrate và detectAnimationFrameRange', () => {
  const half = computeScaledResolution(1920, 1080, 50, 'mp4');
  assert.deepStrictEqual(half, { width: 960, height: 540 });

  const vert = computeScaledResolution(1080, 1920, 100, 'mp4');
  assert.deepStrictEqual(vert, { width: 1080, height: 1920 });

  const clamped4k = computeScaledResolution(3840, 2160, 100, 'mp4');
  assert.ok(clamped4k.width <= 1920 && clamped4k.width * clamped4k.height <= VIDEO_BUDGET.MAX_PIXELS);

  const brDraft = computeRecommendedBitrate(1280, 720, 30, 'draft');
  const brHigh = computeRecommendedBitrate(1920, 1080, 60, 'high');
  assert.ok(brHigh > brDraft, '1080p60 High phải có bitrate lớn hơn 720p30 Draft');

  const fakeTl = {
    fps: 30,
    startFrame: 0,
    endFrame: 250,
    tracks: new Map([['obj1', [{ frame: 10 }, { frame: 75 }]]]),
    _attachedClip: { duration: 3.0 }, // 90 frames
  };
  const range = detectAnimationFrameRange(fakeTl);
  assert.deepStrictEqual(range, { startFrame: 0, endFrame: 90, hasKeyframes: true });
});

// 21. TDR-safe WebGPU chunk schedule for discrete GPUs (Windows 2s WDDM watchdog protection)
test('WebGPU TDR chunking: computeChunkSchedule chia đều mẫu bảo vệ driver GPU', () => {
  const c32 = computeChunkSchedule(32, 8);
  assert.strictEqual(c32.length, 4);
  assert.deepStrictEqual(c32[0], { sampleStart: 0, sampleEnd: 8, isFirst: true, isLast: false });
  assert.deepStrictEqual(c32[3], { sampleStart: 24, sampleEnd: 32, isFirst: false, isLast: true });

  const c13 = computeChunkSchedule(13, 8);
  assert.strictEqual(c13.length, 2);
  assert.deepStrictEqual(c13[1], { sampleStart: 8, sampleEnd: 13, isFirst: false, isLast: true });

  const c1 = computeChunkSchedule(1, 8);
  assert.strictEqual(c1.length, 1);
  assert.strictEqual(c1[0].isFirst, true);
  assert.strictEqual(c1[0].isLast, true);
});

// 22. Discrete GPU adapter classification & elevated VRAM requiredLimits clamping
test('WebGPU Discrete GPU: classifyGpuAdapterInfo & selectRequiredGpuLimits hoạt động chính xác', () => {
  const rtx = classifyGpuAdapterInfo({ vendor: 'nvidia', architecture: 'ada', description: 'NVIDIA GeForce RTX 4070' }, false);
  assert.strictEqual(rtx.tier, 'discrete');
  assert.strictEqual(rtx.isFallback, false);
  assert.ok(rtx.label.includes('RTX 4070'));

  const rx = classifyGpuAdapterInfo({ vendor: 'amd', description: 'AMD Radeon RX 7800 XT' }, false);
  assert.strictEqual(rx.tier, 'discrete');

  const sw = classifyGpuAdapterInfo({ vendor: 'google', description: 'SwiftShader Device (Subzero)' }, false);
  assert.strictEqual(sw.tier, 'software');
  assert.strictEqual(sw.isFallback, true);

  const limitsHigh = selectRequiredGpuLimits({
    maxBufferSize: 2 * 1024 * 1024 * 1024,
    maxStorageBufferBindingSize: 1024 * 1024 * 1024,
  });
  assert.strictEqual(limitsHigh.maxBufferSize, 512 * 1024 * 1024);
  assert.strictEqual(limitsHigh.maxStorageBufferBindingSize, 512 * 1024 * 1024);

  const limitsSmall = selectRequiredGpuLimits({
    maxBufferSize: 256 * 1024 * 1024,
    maxStorageBufferBindingSize: 128 * 1024 * 1024,
  });
  assert.deepStrictEqual(limitsSmall, {});

  const lostErr = new WebGPUDeviceLostError('TDR reset');
  assert.strictEqual(lostErr.name, 'WebGPUDeviceLostError');
});

// 23. Hardware GPU Video Encoding probe (NVENC/VCN/VideoToolbox prefer-hardware -> fallback)
await testAsync('VideoEncoderClient: probePreferredVideoConfig ưu tiên prefer-hardware rồi mới fallback', async () => {
  const calls = [];
  const resHw = await probePreferredVideoConfig(
    ['avc1.640028', 'avc1.42e01f'],
    { width: 1280, height: 720, bitrate: 4_000_000, framerate: 30 },
    async (cfg) => {
      calls.push(`${cfg.codec}:${cfg.hardwareAcceleration}`);
      return { supported: cfg.codec === 'avc1.640028' && cfg.hardwareAcceleration === 'prefer-hardware' };
    }
  );
  assert.ok(resHw && resHw.hardwareAccelerated === true && resHw.codec === 'avc1.640028');
  assert.strictEqual(calls[0], 'avc1.640028:prefer-hardware');

  // Fallback when hardware encoder rejects
  const resFb = await probePreferredVideoConfig(
    ['avc1.640028', 'avc1.42e01f'],
    { width: 1280, height: 720, bitrate: 4_000_000, framerate: 30 },
    async (cfg) => ({ supported: cfg.hardwareAcceleration === 'no-preference' && cfg.codec === 'avc1.42e01f' })
  );
  assert.ok(resFb && resFb.hardwareAccelerated === false && resFb.codec === 'avc1.42e01f');
});

// 24. FrameSource zero-copy opt-in & _postState safety contract (prevents null pixelBuffer & black canvas)
await testAsync('FrameSource: giữ hợp đồng pixelBuffer mặc định và chặn zeroCopy khi chưa init()', async () => {
  const savedVF = globalThis.VideoFrame;
  globalThis.VideoFrame = class FakeVideoFrame {
    constructor(src, opts) { this.src = src; this.opts = opts; }
    close() {}
  };
  try {
    let renderedToCanvas = 0;
    let renderedToTarget = 0;
    let currentTarget = null;
    const mockRenderer = {
      domElement: { width: 64, height: 48 },
      getSize(v) { v.set(64, 48); return v; },
      getPixelRatio() { return 1; },
      setPixelRatio() {},
      setSize() {},
      getRenderTarget() { return currentTarget; },
      setRenderTarget(t) { currentTarget = t; },
      clear() {},
      render() {
        if (currentTarget) renderedToTarget++;
        else renderedToCanvas++;
      },
      readRenderTargetPixels(_rt, _x, _y, w, h, buf) {
        buf.fill(128);
        assert.strictEqual(buf.length, w * h * 4);
      },
    };
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(50, 64 / 48, 0.1, 100);
    const fsUninit = new FrameSource({ renderer: mockRenderer, scene, camera, width: 16, height: 12 });

    // Without init() (_postState is null), even zeroCopy:true MUST NOT read blank domElement
    const f1 = fsUninit.captureFrame({ timestampUs: 0, zeroCopy: true });
    assert.ok(f1.pixelBuffer instanceof Uint8Array && f1.pixelBuffer.length === 16 * 12 * 4);
    assert.strictEqual(renderedToTarget, 1);
    assert.strictEqual(renderedToCanvas, 0);

    // After init(), default captureFrame() still returns pixelBuffer (opt-in zeroCopy)
    await fsUninit.init();
    const f2 = fsUninit.captureFrame({ timestampUs: 33333 });
    assert.ok(f2.pixelBuffer instanceof Uint8Array && f2.pixelBuffer.length === 16 * 12 * 4);

    // Explicit zeroCopy:true after init() takes the fast GPU canvas VideoFrame path
    const f3 = fsUninit.captureFrame({ timestampUs: 66666, zeroCopy: true });
    assert.strictEqual(f3.zeroCopy, true);
    assert.strictEqual(f3.pixelBuffer, null);
    assert.ok(f3.videoFrame instanceof globalThis.VideoFrame);
    assert.strictEqual(renderedToCanvas, 1);
    fsUninit.dispose();
  } finally {
    if (savedVF === undefined) delete globalThis.VideoFrame;
    else globalThis.VideoFrame = savedVF;
  }
});

console.log(`\nALL ${passed} VIDEO EXPORT & RUST KERNEL TESTS PASSED`);
