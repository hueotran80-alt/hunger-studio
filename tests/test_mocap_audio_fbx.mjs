import assert from 'node:assert/strict';
import * as THREE from 'three';
import { FBXLoader } from '../vendor/three/addons/loaders/FBXLoader.js';
import {
  sliceAudioPcm,
  resampleAudioBuffer,
  prepareAudioTrackForExport,
  probeAacEncoderConfig,
} from '../js/render/audio-extractor.js';
import { VideoEncoderClient } from '../js/render/video-encoder.js';
import {
  extractPoseLists,
  createSubjectTrackerState,
  selectTrackedPose,
  BrowserMocapEngine,
} from '../js/animation/browser-mocap.js';
import { exportClipToFBX } from '../js/animation/fbx-exporter.js';

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`PASS  ${name}`);
  } catch (err) {
    failed++;
    console.error(`FAIL  ${name}: ${err?.stack || err}`);
  }
}

function makeFakePose(hx, hy, torsoHeight = 0.25, vis = 0.9) {
  const world = Array.from({ length: 33 }, () => ({ x: 0, y: 0, z: 0, visibility: vis }));
  const image = Array.from({ length: 33 }, () => ({ x: hx, y: hy, z: 0, visibility: vis }));
  // Shoulders 11, 12; Hips 23, 24; Ankles 27, 28
  image[11] = { x: hx - 0.06, y: hy - torsoHeight, z: 0, visibility: vis };
  image[12] = { x: hx + 0.06, y: hy - torsoHeight, z: 0, visibility: vis };
  image[23] = { x: hx - 0.05, y: hy, z: 0, visibility: vis };
  image[24] = { x: hx + 0.05, y: hy, z: 0, visibility: vis };
  image[27] = { x: hx - 0.05, y: hy + torsoHeight * 1.4, z: 0, visibility: vis };
  image[28] = { x: hx + 0.05, y: hy + torsoHeight * 1.4, z: 0, visibility: vis };

  world[11] = { x: -0.18, y: -0.45, z: 0.02, visibility: vis };
  world[12] = { x: 0.18, y: -0.45, z: -0.02, visibility: vis };
  world[23] = { x: -0.10, y: 0.0, z: 0.01, visibility: vis };
  world[24] = { x: 0.10, y: 0.0, z: -0.01, visibility: vis };
  world[27] = { x: -0.12, y: 0.78, z: 0.0, visibility: vis };
  world[28] = { x: 0.12, y: 0.78, z: 0.0, visibility: vis };
  return { world, image };
}

function makeSynthAudioBuffer(sampleRate, numChannels, durationSec, freqHz = 440) {
  const length = Math.round(sampleRate * durationSec);
  const channels = [];
  for (let c = 0; c < numChannels; c++) {
    const ch = new Float32Array(length);
    for (let i = 0; i < length; i++) {
      ch[i] = 0.5 * Math.sin(2 * Math.PI * (freqHz + c * 110) * (i / sampleRate));
    }
    channels.push(ch);
  }
  return {
    sampleRate,
    numberOfChannels: numChannels,
    length,
    getChannelData: (c) => channels[c],
  };
}

function buildTestCharacter() {
  const root = new THREE.Group();
  root.name = 'TestArmature';

  const hips = new THREE.Bone();
  hips.name = 'mixamorigHips';
  hips.position.set(0, 1.0, 0);

  const spine = new THREE.Bone();
  spine.name = 'mixamorigSpine';
  spine.position.set(0, 0.25, 0);

  const head = new THREE.Bone();
  head.name = 'mixamorigHead';
  head.position.set(0, 0.35, 0);

  const leftArm = new THREE.Bone();
  leftArm.name = 'mixamorigLeftArm';
  leftArm.position.set(-0.2, 0.2, 0);

  const leftForeArm = new THREE.Bone();
  leftForeArm.name = 'mixamorigLeftForeArm';
  leftForeArm.position.set(-0.28, 0, 0);

  const leftUpLeg = new THREE.Bone();
  leftUpLeg.name = 'mixamorigLeftUpLeg';
  leftUpLeg.position.set(-0.1, -0.08, 0);

  spine.add(head, leftArm);
  leftArm.add(leftForeArm);
  hips.add(spine, leftUpLeg);
  root.add(hips);
  root.updateMatrixWorld(true);

  const times = [0, 0.25, 0.5, 0.75, 1.0];
  const hipsPos = new Float32Array(times.length * 3);
  const spineQuats = new Float32Array(times.length * 4);
  const armQuats = new Float32Array(times.length * 4);
  const qTmp = new THREE.Quaternion();
  const eTmp = new THREE.Euler();

  for (let i = 0; i < times.length; i++) {
    const t = times[i];
    hipsPos[i * 3] = 0.15 * Math.sin(t * Math.PI);
    hipsPos[i * 3 + 1] = 1.0 + 0.08 * Math.cos(t * Math.PI * 2);
    hipsPos[i * 3 + 2] = 0.05 * t;

    eTmp.set(0.25 * Math.sin(t * Math.PI), 0.3 * t, 0.1 * Math.cos(t * Math.PI), 'XYZ');
    qTmp.setFromEuler(eTmp);
    spineQuats.set([qTmp.x, qTmp.y, qTmp.z, qTmp.w], i * 4);

    eTmp.set(0.1, 0.2, 0.9 * Math.sin(t * Math.PI), 'XYZ');
    qTmp.setFromEuler(eTmp);
    armQuats.set([qTmp.x, qTmp.y, qTmp.z, qTmp.w], i * 4);
  }

  const clip = new THREE.AnimationClip('TestDanceClip', 1.0, [
    new THREE.VectorKeyframeTrack('mixamorigHips.position', times, hipsPos),
    new THREE.QuaternionKeyframeTrack('mixamorigSpine.quaternion', times, spineQuats),
    new THREE.QuaternionKeyframeTrack('mixamorigLeftArm.quaternion', times, armQuats),
  ]);

  return { root, hips, spine, leftArm, clip };
}

console.log('=== Mocap Audio, Multi-Person & ASCII FBX Test Suite ===');

await test('resampleAudioBuffer resamples 44.1kHz mono -> 48kHz stereo cleanly', async () => {
  const mono44 = makeSynthAudioBuffer(44100, 1, 0.5, 440);
  const out = await resampleAudioBuffer(mono44, 48000, 2);
  assert.ok(out);
  assert.equal(out.sampleRate, 48000);
  assert.equal(out.numberOfChannels, 2);
  assert.ok(Math.abs(out.length - 24000) <= 2);
  assert.deepEqual(Array.from(out.getChannelData(0).subarray(0, 64)), Array.from(out.getChannelData(1).subarray(0, 64)));
});

await test('sliceAudioPcm slices exact duration and pads trailing silence', async () => {
  const buf = makeSynthAudioBuffer(48000, 2, 0.25, 440);
  const sliced = sliceAudioPcm(buf, 0.1, 0.3, 2);
  assert.ok(sliced);
  assert.equal(sliced.sampleRate, 48000);
  assert.equal(sliced.numberOfChannels, 2);
  assert.equal(sliced.length, Math.round(0.3 * 48000));
  assert.ok(sliced.peak > 0.1, 'expected audible signal in active slice');
  assert.equal(sliced.channels[0][sliced.length - 1], 0, 'tail beyond source must be zero-padded');
});

await test('prepareAudioTrackForExport handles Buffer-like source without AAC encoder silently when skipAacProbe=false', async () => {
  const emptyTrack = await prepareAudioTrackForExport(null);
  assert.equal(emptyTrack, null);

  // When running in Node (no WebCodecs AudioEncoder), probe returns null -> graceful null
  const probed = await probeAacEncoderConfig(48000, 2);
  assert.equal(probed, null);

  // With AudioEncoder mocked, VideoEncoderClient stores audio metadata and guards dispose/flush
  const prevAudioEnc = globalThis.AudioEncoder;
  const prevAudioData = globalThis.AudioData;
  const prevEncodedAudio = globalThis.EncodedAudioChunk;
  const prevVideoEnc = globalThis.VideoEncoder;
  const prevVideoFrame = globalThis.VideoFrame;
  try {
    let audioConfigured = null;
    let audioChunksEncoded = 0;
    globalThis.EncodedAudioChunk = class {
      constructor(init) {
        this.type = init.type || 'key';
        this.timestamp = init.timestamp || 0;
        this.duration = init.duration || 21333;
        this.byteLength = init.data?.byteLength || 16;
        this._data = init.data || new Uint8Array(16);
      }
      copyTo(target) {
        new Uint8Array(target.buffer || target, target.byteOffset || 0, this.byteLength).set(this._data);
      }
    };
    globalThis.AudioEncoder = class {
      static async isConfigSupported(cfg) { return { supported: true, config: cfg }; }
      constructor({ output }) { this._output = output; }
      configure(cfg) { audioConfigured = cfg; }
      encode(frame) {
        audioChunksEncoded++;
        this._output(
          new globalThis.EncodedAudioChunk({ timestamp: frame.timestamp || 0, duration: 21333, data: new Uint8Array(16) }),
          audioChunksEncoded === 1 ? { decoderConfig: { description: new Uint8Array([0x11, 0x90]) } } : undefined,
        );
      }
      async flush() {}
      close() {}
    };
    globalThis.AudioData = class {
      constructor(init) { Object.assign(this, init); }
      close() {}
    };
    globalThis.VideoFrame = class {
      close() {}
    };
    globalThis.VideoEncoder = class {
      static async isConfigSupported(cfg) { return { supported: true, config: cfg }; }
      configure() {}
      encode() {}
      async flush() {}
      close() {}
    };
    const client = new VideoEncoderClient({
      width: 64,
      height: 64,
      fps: 30,
      audio: { codec: 'aac', sampleRate: 48000, numberOfChannels: 2, bitrate: 128000 },
    });
    await client.init();
    assert.equal(client.canEncode(), true);
    assert.equal(audioConfigured?.sampleRate, 48000);
    await client.addAudioPcm([new Float32Array(2048), new Float32Array(2048)], 48000);
    assert.equal(client.hasAudio(), true);
    client.dispose();
  } finally {
    globalThis.AudioEncoder = prevAudioEnc;
    globalThis.AudioData = prevAudioData;
    globalThis.EncodedAudioChunk = prevEncodedAudio;
    globalThis.VideoEncoder = prevVideoEnc;
    globalThis.VideoFrame = prevVideoFrame;
  }
});

await test('selectTrackedPose extracts primary dancer consistently despite array order swap & passerby', () => {
  const dancerA = makeFakePose(0.50, 0.52, 0.26, 0.95);
  const dancerB = makeFakePose(0.22, 0.50, 0.22, 0.90);
  const passerby = makeFakePose(0.84, 0.45, 0.30, 0.92);

  const tracker = createSubjectTrackerState('auto');
  const first = selectTrackedPose({
    landmarks: [dancerB.image, dancerA.image],
    worldLandmarks: [dancerB.world, dancerA.world],
  }, tracker);
  assert.equal(first.index, 1, 'initial auto mode prefers centered primary dancer');
  assert.equal(first.count, 2);

  // Swap detector slot order AND insert passerby at slot 0: continuity anchor stays locked on dancerA
  const movedA = makeFakePose(0.52, 0.51, 0.26, 0.95);
  const second = selectTrackedPose({
    landmarks: [passerby.image, dancerB.image, movedA.image],
    worldLandmarks: [passerby.world, dancerB.world, movedA.world],
  }, tracker);
  assert.equal(second.index, 2, 'continuity anchor must track movedA even after detector index shuffle');
  assert.equal(tracker.maxPeople, 3);
  assert.equal(tracker.multiPersonFrames, 2);
  assert.equal(tracker.subjectSwitches, 0);

  // Left-to-right indexed mode skips detector array instability
  const idxLeft = selectTrackedPose({
    landmarks: [passerby.image, dancerB.image, dancerA.image],
    worldLandmarks: [passerby.world, dancerB.world, dancerA.world],
  }, null, { subjectMode: 'index:0' });
  assert.equal(idxLeft.index, 1, 'index:0 sorts candidates left-to-right -> dancerB at hx=0.22');

  // Off-screen low-confidence ghost (hx < -0.04, vis < 0.38) and 1-frame far intruder
  // must be rejected as a gap rather than pulling the continuity anchor across the room
  const ghost = makeFakePose(-0.12, 0.79, 0.19, 0.08);
  const ghostSel = selectTrackedPose({
    landmarks: [ghost.image],
    worldLandmarks: [ghost.world],
  }, tracker);
  assert.equal(ghostSel.index, -1, 'offscreen low-vis ghost should return gap instead of stealing subject');
  assert.equal(tracker.lostFrames, 1);
  assert.ok(tracker.anchor.hx > 0.45, 'anchor remains locked on primary dancer during brief occlusion');

  // Returning to primary dancer resets lostFrames cleanly
  const backSel = selectTrackedPose({
    landmarks: [movedA.image],
    worldLandmarks: [movedA.world],
  }, tracker);
  assert.equal(backSel.index, 0);
  assert.equal(tracker.lostFrames, 0);
});

await test('BrowserMocapEngine.processFrames forwards multiPersonStats for multi-person clip', async () => {
  const eng = new BrowserMocapEngine({ numPoses: 4 });
  const frames = [];
  for (let i = 0; i < 6; i++) {
    const main = makeFakePose(0.50 + i * 0.005, 0.52, 0.25, 0.95);
    const bg = makeFakePose(0.15, 0.50, 0.18, 0.85);
    frames.push({
      time: i / 30,
      pose: i % 2 === 0
        ? { landmarks: [main.image, bg.image], worldLandmarks: [main.world, bg.world] }
        : { landmarks: [bg.image, main.image], worldLandmarks: [bg.world, main.world] },
    });
  }
  const res = await eng.processFrames({
    fps: 30,
    totalFrames: frames.length,
    sampler: (idx) => frames[idx].pose,
    numPoses: 4,
    subjectMode: 'auto',
    compensateCamera: false,
    temporalLifting: false,
  });
  assert.equal(res.mocapFrames.length, 6);
  assert.equal(res.multiPersonStats.maxPeopleDetected, 2);
  assert.equal(res.multiPersonStats.multiPersonFrames, 6);
  assert.equal(res.multiPersonStats.subjectSwitches, 0);
  const { worldList } = extractPoseLists(frames[0].pose);
  assert.equal(worldList.length, 2);
});

await test('exportClipToFBX emits valid Binary FBX 7.4 round-tripped by Three.js FBXLoader (non-destructive)', async () => {
  const { root, hips, spine, leftArm, clip } = buildTestCharacter();
  const savedHipsPos = hips.position.clone();
  const savedSpineQuat = spine.quaternion.clone();
  const savedArmQuat = leftArm.quaternion.clone();

  const out = exportClipToFBX(root, clip, { fps: 30, clipName: 'TestDanceFBX' });
  assert.equal(out.format, 'binary');
  assert.ok(out.bytes instanceof Uint8Array);
  assert.ok(new TextDecoder().decode(out.bytes.subarray(0, 18)) === 'Kaydara FBX Binary');
  assert.equal(out.boneCount, 6);
  assert.equal(out.frameCount, 31);

  // Verify non-destructive export restored original character pose identically
  assert.ok(hips.position.distanceTo(savedHipsPos) < 1e-6, 'hips position restored');
  assert.ok(1 - Math.abs(spine.quaternion.dot(savedSpineQuat)) < 1e-6, 'spine quaternion restored');
  assert.ok(1 - Math.abs(leftArm.quaternion.dot(savedArmQuat)) < 1e-6, 'leftArm quaternion restored');

  // Round-trip via vendored Three.js FBXLoader
  const loader = new FBXLoader();
  const buf = out.bytes.buffer.slice(out.bytes.byteOffset, out.bytes.byteOffset + out.bytes.byteLength);
  const imported = loader.parse(buf, '');

  const importedBones = [];
  imported.traverse((o) => { if (o.isBone) importedBones.push(o.name); });
  assert.equal(importedBones.length, 6, 'FBXLoader imported all 6 LimbNode bones');
  assert.ok(importedBones.includes('mixamorigHips'));
  assert.ok(importedBones.includes('mixamorigLeftForeArm'));

  assert.ok(Array.isArray(imported.animations) && imported.animations.length === 1, 'FBXLoader parsed 1 AnimationClip');
  const impClip = imported.animations[0];
  assert.ok(Math.abs(impClip.duration - 1.0) < 0.05, `clip duration matches ~1.0s (got ${impClip.duration})`);
  assert.ok(impClip.tracks.some((t) => t.name === 'mixamorigSpine.quaternion'), 'spine quaternion track imported');
  assert.ok(impClip.tracks.some((t) => t.name === 'mixamorigLeftArm.quaternion'), 'leftArm quaternion track imported');
  assert.ok(impClip.tracks.some((t) => t.name === 'mixamorigHips.position'), 'hips position track imported');

  // Drive imported character with AnimationMixer and verify bone actually animates over time
  const mixer = new THREE.AnimationMixer(imported);
  mixer.clipAction(impClip).play();
  mixer.setTime(0.0);
  const impSpine = imported.getObjectByName('mixamorigSpine');
  const qStart = impSpine.quaternion.clone();
  mixer.setTime(0.5);
  const qMid = impSpine.quaternion.clone();
  const angleDelta = 2 * Math.acos(Math.min(1, Math.abs(qStart.dot(qMid))));
  assert.ok(angleDelta > 0.15, `expected imported spine animation to move > 0.15 rad, got ${angleDelta}`);

  // Mixamo-style Armature (scale=0.01, rotX=+90deg) world-space scale & orientation parity check
  const mixRoot = new THREE.Group();
  const armature = new THREE.Group();
  armature.name = 'Armature';
  armature.scale.setScalar(0.01);
  armature.rotation.x = Math.PI / 2;
  const mHips = new THREE.Bone();
  mHips.name = 'mixamorigHips';
  mHips.position.set(0, 0, -95);
  const mSpine = new THREE.Bone();
  mSpine.name = 'mixamorigSpine';
  mSpine.position.set(0, 0, -25);
  mHips.add(mSpine);
  armature.add(mHips);
  mixRoot.add(armature);
  mixRoot.updateMatrixWorld(true);

  const origSpineWorld = mSpine.getWorldPosition(new THREE.Vector3());
  const mClip = new THREE.AnimationClip('MixScaleClip', 0.5, [
    new THREE.VectorKeyframeTrack('mixamorigHips.position', [0, 0.5], [0, 0, -95, 10, 0, -95]),
  ]);
  const mixFbx = exportClipToFBX(mixRoot, mClip, { fps: 30, clipName: 'MixScaleClip' });
  const mixImported = new FBXLoader().parse(mixFbx.bytes.buffer.slice(mixFbx.bytes.byteOffset, mixFbx.bytes.byteOffset + mixFbx.bytes.byteLength), '');
  mixImported.updateMatrixWorld(true);
  const impMixSpineWorld = mixImported.getObjectByName('mixamorigSpine').getWorldPosition(new THREE.Vector3());
  assert.ok(
    impMixSpineWorld.distanceTo(origSpineWorld) < 0.005,
    `expected Mixamo Armature world spine ~${origSpineWorld.toArray()}, got ${impMixSpineWorld.toArray()}`,
  );
});

await test('selectTrackedPose blocks larger/closer cross-over intruder across 6 occluded frames & keeps primary anchor clean', () => {
  const tracker = createSubjectTrackerState('auto');
  // Frames 0..2: primary performer at center (hx=0.48, torso2d=0.22) + closer large intruder approaching
  for (let f = 0; f < 3; f++) {
    const primary = makeFakePose(0.48, 0.52, 0.22, 0.94);
    const intruder = makeFakePose(0.20 + f * 0.09, 0.49, 0.39, 0.97);
    const sel = selectTrackedPose({
      landmarks: f === 0 ? [primary.image, intruder.image] : [intruder.image, primary.image],
      worldLandmarks: f === 0 ? [primary.world, intruder.world] : [intruder.world, primary.world],
    }, tracker);
    assert.equal(sel.index, f === 0 ? 0 : 1, `frame ${f} must lock onto primary performer even when intruder is larger`);
  }

  // Frames 3..8 (6 frames!): larger intruder steps directly across primary so ONLY intruder is emitted
  for (let f = 3; f <= 8; f++) {
    const intruderOnly = makeFakePose(0.45 + (f - 3) * 0.02, 0.49, 0.40, 0.97);
    const sel = selectTrackedPose({
      landmarks: [intruderOnly.image],
      worldLandmarks: [intruderOnly.world],
    }, tracker);
    assert.equal(sel.index, -1, `occluded frame ${f} must reject cross-over intruder instead of latching onto it`);
    assert.ok(tracker.homeProfile.torso2d < 0.26, 'homeProfile torso scale must stay uncorrupted by intruder');
  }
  assert.ok(tracker.blockedIntruders >= 6, `expected >= 6 intruder frames blocked, got ${tracker.blockedIntruders}`);

  // Frames 9..11: primary performer re-emerges after intruder passes -> seamless resume, zero switches
  const resumedPrimary = makeFakePose(0.49, 0.52, 0.22, 0.93);
  const intruderExiting = makeFakePose(0.84, 0.49, 0.39, 0.95);
  const res = selectTrackedPose({
    landmarks: [intruderExiting.image, resumedPrimary.image],
    worldLandmarks: [intruderExiting.world, resumedPrimary.world],
  }, tracker);
  assert.equal(res.index, 1, 'primary performer seamlessly re-acquired after cross-over');
  assert.equal(tracker.subjectSwitches, 0, 'zero subject switches across cross-over occlusion');
});

await test('selectTrackedPose blocks equal-size crossing passerby trajectory & processFrames repairs 1-frame teleport spikes', async () => {
  // 1. Equal-size crossing passerby trajectory occlusion test
  const tracker = createSubjectTrackerState('auto');
  for (let f = 0; f < 4; f++) {
    const main = makeFakePose(0.50, 0.52, 0.24, 0.95);
    const passer = makeFakePose(0.22 + f * 0.07, 0.51, 0.24, 0.94); // walking +0.07/frame right
    const sel = selectTrackedPose({
      landmarks: [passer.image, main.image],
      worldLandmarks: [passer.world, main.world],
    }, tracker);
    assert.equal(sel.index, 1, `frame ${f} tracks stationary main over approaching equal-size passerby`);
  }
  // Passerby steps straight in front of main at x=0.50 -> 0.56 for 2 frames while moving right
  for (let f = 4; f < 6; f++) {
    const passerBlocking = makeFakePose(0.50 + (f - 4) * 0.06, 0.51, 0.24, 0.94);
    const sel = selectTrackedPose({
      landmarks: [passerBlocking.image],
      worldLandmarks: [passerBlocking.world],
    }, tracker);
    assert.equal(sel.index, -1, `frame ${f} detects equal-size passerby velocity trajectory and blocks hijack`);
  }

  // 2. processFrames 1-frame teleport repair when running single-pose mode (intruder flashes for 1 frame)
  const eng = new BrowserMocapEngine({ numPoses: 1, subjectMode: 'single' });
  const frames = [];
  for (let i = 0; i < 9; i++) {
    const p = i === 4
      ? makeFakePose(0.86, 0.44, 0.36, 0.96) // sudden intruder flash across frame at f=4
      : makeFakePose(0.45 + i * 0.004, 0.52, 0.23, 0.95);
    frames.push({ landmarks: [p.image], worldLandmarks: [p.world] });
  }
  const out = await eng.processFrames({
    fps: 30,
    totalFrames: frames.length,
    sampler: (idx) => frames[idx],
    numPoses: 1,
    subjectMode: 'single',
    compensateCamera: false,
    temporalLifting: false,
  });
  assert.equal(out.mocapFrames.length, 9);
  assert.ok(out.multiPersonStats.blockedIntruders >= 1, '1-frame teleport intruder flagged cleanly');
  const hipJump = Math.hypot(
    out.mocapFrames[4].midHip[0] - out.mocapFrames[3].midHip[0],
    out.mocapFrames[4].midHip[1] - out.mocapFrames[3].midHip[1],
  );
  assert.ok(hipJump < 0.08, `expected C1 repaired hip at frame 4 without teleporting, jump=${hipJump}`);
});

console.log(`\nSummary: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
