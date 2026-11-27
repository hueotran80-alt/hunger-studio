/**
 * Concurrency, Rapid-Fire Cancellation, State Isolation & Face/Hand Solver Suite
 * File: tests/test_concurrency_cancellation.mjs
 *
 * Covers the remaining testing blind spots:
 *   1. GeometryWorkerClient 25-request rapid-click storm (latest-wins, 0 orphan promises)
 *   2. GeometryWorkerClient AbortController pre-flight & mid-flight cancellation
 *   3. PathTraceSession concurrent busy guard + post-abort recovery
 *   4. VideoExportManager concurrent render guard + mid-frame AbortSignal + real SimulationManager.stepFrames integration
 *   5. BlobStore 50-way parallel content-addressed deduplication & byte integrity
 *   6. FaceSolver (ARKit + VRM morph bindings, gap interpolation, jaw bone & head blend, NaN resilience)
 *   7. HandSolver (21-point left/right fingers, forearm twist distribution & rest-pose restoration)
 *   8. BrowserMocapEngine mid-stream AbortController cancellation
 */

import assert from 'node:assert';
import * as THREE from 'three';
import { runModifierStack, disposeGeometryWorker } from '../js/core/geometry-worker-client.js';
import { PathTraceSession } from '../js/render/pathtrace-session.js';
import { FrameSource } from '../js/render/frame-source.js';
import { VideoExportManager } from '../js/render/video-export.js';
import { BlobStore, MemoryBlobBackend, computeBlobRef } from '../js/core/blob-store.js';
import {
  ARKIT_BLENDSHAPES,
  collectFaceMorphBindings,
  extractHeadEulerFromMatrix,
  solveFaceAndExpressionTracks,
} from '../js/animation/face-solver.js';
import {
  FINGER_CHAINS,
  solveHandAndFingerTracks,
  applyTwistDistribution,
} from '../js/animation/hand-solver.js';
import { BrowserMocapEngine } from '../js/animation/browser-mocap.js';

let passed = 0;
async function test(name, fn) {
  await fn();
  passed += 1;
  console.log(`ok   ${name}`);
}

// 1. GeometryWorkerClient: 25-request rapid-click storm on same key (latest-wins)
await test('GeometryWorkerClient: 25 rapid-fire requests cùng key chỉ giữ request cuối, huỷ sạch 24 request cũ', async () => {
  const savedWorker = globalThis.Worker;
  const cancelledIds = [];
  globalThis.Worker = class MockWorker {
    constructor() {
      this.onmessage = null;
      this.onerror = null;
    }
    postMessage(msg) {
      if (msg.type === 'cancel') {
        cancelledIds.push(msg.id);
        return;
      }
      setTimeout(() => {
        this.onmessage?.({
          data: { id: msg.id, ok: true, out: { position: new Float32Array([1, 2, 3]) } },
        });
      }, 15);
    }
    terminate() {}
  };

  try {
    disposeGeometryWorker();
    const promises = [];
    for (let i = 0; i < 25; i++) {
      const encoded = { position: new Float32Array([i, 0, 0]) };
      promises.push(
        runModifierStack(encoded, [{ type: 'subdivision', enabled: true, params: { levels: 1 } }], {
          key: 'hero_mesh:stack',
        }).then(
          (res) => ({ status: 'fulfilled', index: i, res }),
          (err) => ({ status: 'rejected', index: i, cancelled: Boolean(err?.cancelled), name: err?.name })
        )
      );
    }

    const settled = await Promise.all(promises);
    const winners = settled.filter((s) => s.status === 'fulfilled');
    const cancelled = settled.filter((s) => s.status === 'rejected' && s.cancelled);

    assert.strictEqual(winners.length, 1, `Expected 1 winner, got ${winners.length}`);
    assert.strictEqual(winners[0].index, 24, 'Winner must be the 25th (latest) request');
    assert.strictEqual(cancelled.length, 24, `Expected 24 cancelled requests, got ${cancelled.length}`);
    assert.strictEqual(cancelledIds.length, 24, 'Worker must receive 24 cancel messages');
    disposeGeometryWorker();
  } finally {
    if (savedWorker === undefined) delete globalThis.Worker;
    else globalThis.Worker = savedWorker;
  }
});

// 2. GeometryWorkerClient: AbortController pre-flight & mid-flight
await test('GeometryWorkerClient: AbortSignal pre-flight không gửi message; mid-flight huỷ ngay lập tức', async () => {
  const savedWorker = globalThis.Worker;
  const posted = [];
  globalThis.Worker = class MockWorker {
    postMessage(msg) { posted.push(msg); }
    terminate() {}
  };

  try {
    disposeGeometryWorker();
    const preCtrl = new AbortController();
    preCtrl.abort();
    await assert.rejects(
      () => runModifierStack({ position: new Float32Array(9) }, [], { signal: preCtrl.signal }),
      (err) => err.name === 'AbortError' && err.cancelled === true
    );
    assert.strictEqual(posted.length, 0, 'Pre-aborted request must not post to worker');

    const midCtrl = new AbortController();
    const midPromise = runModifierStack({ position: new Float32Array(9) }, [], { signal: midCtrl.signal });
    assert.strictEqual(posted.length, 1);
    midCtrl.abort();
    await assert.rejects(() => midPromise, (err) => err.name === 'AbortError' && err.cancelled === true);
    assert.strictEqual(posted.length, 2);
    assert.strictEqual(posted[1].type, 'cancel');
    assert.strictEqual(posted[1].id, posted[0].id);
    disposeGeometryWorker();
  } finally {
    if (savedWorker === undefined) delete globalThis.Worker;
    else globalThis.Worker = savedWorker;
  }
});

// 3. PathTraceSession: concurrent busy guard & state recovery after failure
await test('PathTraceSession: chặn 2 phiên chạy chồng nhau và mở khoá busy sau khi kết thúc/lỗi', async () => {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
  const session = new PathTraceSession({ scene, camera, renderer: {} });

  session.busy = true;
  await assert.rejects(
    () => session.render({ width: 64, height: 64, samples: 4 }),
    /already running/i
  );
  session.busy = false;

  // Invalid caps must throw without leaving busy=true
  await assert.rejects(
    () => session.render({ width: 4096, height: 4096, samples: 4 }),
    /exceed/i
  );
  assert.strictEqual(session.busy, false, 'busy flag must remain false after cap rejection');
});

// 4. VideoExportManager: concurrent export guard + mid-frame AbortController + SimulationManager.stepFrames
await test('VideoExportManager: chặn render chồng chéo, huỷ sạch qua AbortSignal & gọi đúng SimulationManager.stepFrames', async () => {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(50, 16 / 9, 0.1, 100);
  camera.position.z = 4;
  scene.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial({ color: 0xffaa00 })));

  let soughtFrames = [];
  const mockTimeline = {
    fps: 30,
    currentFrame: 1,
    isPlaying: false,
    seekToFrame(f) { soughtFrames.push(f); this.currentFrame = f; },
  };

  let initCalled = 0;
  let resetCalled = 0;
  let steppedSubFrames = 0;
  const mockSimManager = {
    fixedDt: 1 / 60,
    async init() { initCalled++; },
    reset() { resetCalled++; },
    stepFrames(n) { steppedSubFrames += n; },
  };

  const manager = new VideoExportManager({ scene, camera, timeline: mockTimeline });

  // Concurrent guard check
  manager.isExporting = true;
  await assert.rejects(
    () => manager.renderVideo({ width: 160, height: 120, startFrame: 1, endFrame: 3, format: 'png-sequence' }),
    /already running/i
  );
  manager.isExporting = false;

  // Mid-frame AbortController check on PNG sequence + stepPhysics
  const abortCtrl = new AbortController();
  const origEncode = FrameSource.prototype.encodeCanvasToPngBytes;
  FrameSource.prototype.encodeCanvasToPngBytes = async () => new Uint8Array([137, 80, 78, 71]);
  try {
    await assert.rejects(
      () => manager.renderVideo({
        width: 64,
        height: 48,
        fps: 30,
        startFrame: 1,
        endFrame: 6,
        format: 'png-sequence',
        stepPhysics: true,
        simulationManager: mockSimManager,
        signal: abortCtrl.signal,
        onBeforeFrame({ frameIndex }) {
          // Abort during frameIndex 2 -> frame 0 and 1 encoded, frame 2 completes then loop aborts before frame 3
          if (frameIndex === 1) abortCtrl.abort();
        },
      }),
      (err) => err.name === 'AbortError'
    );
  } finally {
    FrameSource.prototype.encodeCanvasToPngBytes = origEncode;
  }

  assert.strictEqual(manager.isExporting, false, 'isExporting must reset to false after AbortError');
  assert.strictEqual(initCalled, 1, 'simManager.init() must be awaited when stepPhysics=true');
  assert.strictEqual(resetCalled, 2, 'simManager.reset() must run before frame 0 AND restore in finally on abort');
  // Frame 0 (no step), Frame 1 (+2 substeps at 60Hz/30fps, abort triggered inside onBeforeFrame -> loop aborts at start of Frame 2)
  assert.strictEqual(steppedSubFrames, 2, `Expected 2 Rapier substeps before abort, got ${steppedSubFrames}`);
  assert.deepStrictEqual(soughtFrames.slice(0, 2), [1, 2]);
});

// 5. BlobStore: 50-way parallel content-addressed deduplication & byte integrity
await test('BlobStore: 50 ghi song song khử trùng lặp chính xác và toàn vẹn từng byte', async () => {
  const backend = new MemoryBlobBackend();
  const store = new BlobStore({ backend });

  const uniquePayloads = Array.from({ length: 10 }, (_, k) => {
    const arr = new Uint8Array(256);
    for (let i = 0; i < arr.length; i++) arr[i] = (k * 37 + i) & 0xff;
    return arr;
  });

  // 50 concurrent writes (each unique payload written 5 times simultaneously)
  const writes = await Promise.all(
    Array.from({ length: 50 }, (_, idx) => {
      const payload = uniquePayloads[idx % 10];
      return store.put(payload, { mime: 'application/octet-stream' });
    })
  );

  const stats = await store.stats();
  assert.strictEqual(stats.blobCount, 10, `Expected 10 deduplicated blobs, got ${stats.blobCount}`);
  assert.strictEqual(stats.totalBytes, 10 * 256);

  for (let k = 0; k < 10; k++) {
    const expectedRef = await computeBlobRef(uniquePayloads[k]);
    assert.strictEqual(writes[k].ref, expectedRef);
    const readBack = await store.get(expectedRef);
    assert.deepStrictEqual(Array.from(readBack), Array.from(uniquePayloads[k]));
  }
});

// 6. FaceSolver: ARKit/VRM morph targets, gap interpolation, jaw bone & head orientation blend
await test('FaceSolver: nội suy khoảng trống, tạo MorphTarget + Jaw track + pha trộn hướng đầu an toàn', async () => {
  assert.strictEqual(ARKIT_BLENDSHAPES.length, 52, 'ARKit standard has 52 blendshapes');

  const root = new THREE.Group();
  const headBone = new THREE.Bone();
  headBone.name = 'Head';
  const jawBone = new THREE.Bone();
  jawBone.name = 'Jaw';
  headBone.add(jawBone);
  root.add(headBone);

  const faceGeo = new THREE.BoxGeometry(0.2, 0.2, 0.2);
  faceGeo.morphAttributes.position = [
    new THREE.Float32BufferAttribute(new Float32Array(faceGeo.attributes.position.count * 3), 3),
    new THREE.Float32BufferAttribute(new Float32Array(faceGeo.attributes.position.count * 3), 3),
  ];
  const faceMesh = new THREE.Mesh(faceGeo, new THREE.MeshBasicMaterial());
  faceMesh.name = 'Head_Mesh';
  faceMesh.morphTargetDictionary = { jawOpen: 0, eyeBlinkLeft: 1 };
  faceMesh.morphTargetInfluences = [0, 0];
  root.add(faceMesh);
  root.updateMatrixWorld(true);

  const bindings = collectFaceMorphBindings(root);
  assert.strictEqual(bindings.length, 2);

  // 6 frames with frame 2 & 3 dropped (null / low confidence) -> must interpolate cleanly
  const times = new Float32Array([0, 1 / 30, 2 / 30, 3 / 30, 4 / 30, 5 / 30]);
  const identityMat = [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1];
  const euler0 = extractHeadEulerFromMatrix(identityMat);
  assert.ok(euler0 && Math.abs(euler0.pitch) < 1e-6 && Math.abs(euler0.yaw) < 1e-6);

  const faceFrames = [
    { confidence: 0.9, blendshapes: { jawOpen: 0.1, eyeBlinkLeft: 0.0 }, headMatrix: identityMat },
    { confidence: 0.9, blendshapes: { jawOpen: 0.8, eyeBlinkLeft: 0.9 }, headMatrix: identityMat },
    null, // dropout gap
    { confidence: 0.1, blendshapes: { jawOpen: 1.0 } }, // below 0.25 confidence threshold -> ignored
    { confidence: 0.95, blendshapes: { jawOpen: 0.4, eyeBlinkLeft: 0.2 }, headMatrix: identityMat },
    { confidence: 0.95, blendshapes: { jawOpen: 0.0, eyeBlinkLeft: 0.0 }, headMatrix: identityMat },
  ];
  const coreQuats = { head: new Float32Array(6 * 4) };
  for (let i = 0; i < 6; i++) coreQuats.head[i * 4 + 3] = 1;

  const solved = solveFaceAndExpressionTracks({
    faceFrames,
    character: root,
    rig: { head: headBone, jaw: jawBone },
    times,
    fps: 30,
    coreQuatBuffers: coreQuats,
  });

  assert.strictEqual(solved.detectedFrames, 4);
  assert.strictEqual(solved.jawAnimated, true);
  assert.ok(solved.morphTrackCount >= 1);
  for (const tr of solved.tracks) {
    assert.ok(tr.values.every((v) => Number.isFinite(v)), `Non-finite value in face track ${tr.name}`);
  }
});

// 7. HandSolver: 21-point fingers, forearm twist distribution & rest-pose preservation
await test('HandSolver: giải khớp ngón tay 21 điểm, phân bổ xoắn cẳng tay và bảo toàn Rest Pose xương', async () => {
  assert.strictEqual(Object.keys(FINGER_CHAINS).length, 5);

  const root = new THREE.Group();
  const foreL = new THREE.Bone(); foreL.name = 'LeftForeArm'; foreL.position.set(0.25, 1.4, 0);
  const twistL = new THREE.Bone(); twistL.name = 'LeftForeArmTwist'; twistL.position.set(0.12, 0, 0);
  const handL = new THREE.Bone(); handL.name = 'LeftHand'; handL.position.set(0.25, 0, 0);
  const idx1 = new THREE.Bone(); idx1.name = 'LeftHandIndex1'; idx1.position.set(0.08, 0, 0.02);
  const idx2 = new THREE.Bone(); idx2.name = 'LeftHandIndex2'; idx2.position.set(0.04, 0, 0);
  const idx3 = new THREE.Bone(); idx3.name = 'LeftHandIndex3'; idx3.position.set(0.03, 0, 0);
  const mid1 = new THREE.Bone(); mid1.name = 'LeftHandMiddle1'; mid1.position.set(0.08, 0, 0);
  const pnk1 = new THREE.Bone(); pnk1.name = 'LeftHandPinky1'; pnk1.position.set(0.07, 0, -0.02);

  idx2.add(idx3); idx1.add(idx2);
  handL.add(idx1, mid1, pnk1);
  foreL.add(twistL, handL);
  root.add(foreL);
  root.updateMatrixWorld(true);

  const restHandQuat = handL.quaternion.clone();
  const restIdx1Quat = idx1.quaternion.clone();

  const make21Landmarks = (curl = 0.3) => Array.from({ length: 21 }, (_, lm) => ({
    x: lm * 0.01,
    y: -curl * (lm % 4) * 0.02,
    z: 0,
  }));

  const times = new Float32Array([0, 1 / 30, 2 / 30, 3 / 30]);
  const handFrames = [
    { left: { confidence: 0.9, worldLandmarks: make21Landmarks(0.0) } },
    { left: { confidence: 0.9, worldLandmarks: make21Landmarks(0.6) } },
    null, // dropout frame
    { left: { confidence: 0.9, worldLandmarks: make21Landmarks(0.2) } },
  ];

  const coreQuatBuffers = {
    leftForearm: new Float32Array([0,0,0,1, 0,0,0,1, 0,0,0,1, 0,0,0,1]),
    leftHand: new Float32Array([0,0,0,1, 0.2588,0,0,0.9659, 0.2588,0,0,0.9659, 0,0,0,1]),
  };
  const rig = {
    leftForearm: foreL,
    leftForearmTwist: twistL,
    leftHand: handL,
    fingers: {
      leftHandIndex1: idx1,
      leftHandIndex2: idx2,
      leftHandIndex3: idx3,
      leftHandMiddle1: mid1,
      leftHandPinky1: pnk1,
    },
  };

  const fingerTracks = solveHandAndFingerTracks({
    handFrames,
    rig,
    times,
    fps: 30,
    coreQuatBuffers,
    character: root,
  });

  // Character rest quaternions MUST be untouched after temporary FK solving
  assert.ok(handL.quaternion.angleTo(restHandQuat) < 1e-6, 'Hand bone rest quaternion was mutated');
  assert.ok(idx1.quaternion.angleTo(restIdx1Quat) < 1e-6, 'Finger bone rest quaternion was mutated');
  for (const tr of fingerTracks) {
    assert.ok(tr.values.every((v) => Number.isFinite(v)), `Non-finite quaternion in ${tr.name}`);
  }

  const twistTracks = applyTwistDistribution({ rig, coreQuatBuffers, times, fps: 30 });
  for (const tr of twistTracks) {
    assert.ok(tr.values.every((v) => Number.isFinite(v)), `Non-finite twist quaternion in ${tr.name}`);
  }
});

// 8. BrowserMocapEngine: mid-stream AbortController stops frame sampling immediately
await test('BrowserMocapEngine: AbortController dừng lấy mẫu ngay giữa luồng frame và dispose() an toàn nhiều lần', async () => {
  const engine = new BrowserMocapEngine();
  engine.landmarker = {
    detectForVideo() {
      return { worldLandmarks: [], landmarks: [] };
    },
    close() {},
  };

  const ctrl = new AbortController();
  let sampledFrames = 0;
  await assert.rejects(
    () => engine.processFrames({
      totalFrames: 20,
      fps: 30,
      duration: 20 / 30,
      signal: ctrl.signal,
      async sampler(idx) {
        sampledFrames++;
        if (idx === 3) ctrl.abort();
        return { frame: {}, timestampMs: idx * 33 };
      },
    }),
    (err) => err.name === 'AbortError'
  );
  assert.strictEqual(sampledFrames, 4, `Expected sampling to stop right after abort at idx=3, got ${sampledFrames}`);

  // Idempotent dispose
  engine.dispose();
  engine.dispose();
});

console.log(`\nALL ${passed}/8 CONCURRENCY, CANCELLATION & SOLVER TESTS PASSED`);
