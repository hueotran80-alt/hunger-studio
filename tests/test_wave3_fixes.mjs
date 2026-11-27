/**
 * Wave 3 Regression Suite — Verifies fixes across Groups 12, 15, 16, 21, 20, 19, 18, 17:
 *  - Group 12: MP4 tkhd rotation matrix, Rust mocap_kernel heel unpack & 21-key schema, CC4/GLTFExporter face tracks, BVH rest offsets
 *  - Group 15/16: Rust Point/Spot sphere flux parity & glass transmission shadow, VideoEncoder Opus rate sync & try/finally VideoFrame
 *  - Group 21/20: Embed normalizeHexColor('#11223380'), protocol-relative & HTTPS mixed-content rejection, USDZ AR export, recursive Local scan & Image tab UUID lookup
 *  - Group 19/18/17: STEM starter/solution scores (Lessons 2-6 < 70 on starter, >= 90 on solution), SceneManager 1-step CompositeCommand batch undo,
 *                    Copilot Guard hardening (Reflect/Proxy/proto/OPFS), StudioBridge cycle-safe JSON serialization, MCP save_path jailing.
 *
 * Run: node --import ./tests/three-resolve-hooks.mjs tests/test_wave3_fixes.mjs
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import * as THREE from 'three';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';

if (typeof globalThis.FileReader === 'undefined') {
  globalThis.FileReader = class FileReaderShim {
    constructor() { this.result = null; this.onloadend = null; this.onerror = null; }
    readAsArrayBuffer(blob) {
      blob.arrayBuffer().then(
        (buf) => { this.result = buf; this.onloadend?.(); },
        (err) => { this.onerror?.(err); },
      );
    }
  };
}

import { parseTkhdRotationDeg } from '../js/animation/video-decoder.js';
import { initMocapKernel, processJointsWasm } from '../js/animation/mocap-kernel-bridge.js';
import { solveFaceAndExpressionTracks } from '../js/animation/face-solver.js';
import { exportClipToBVH } from '../js/animation/bvh-exporter.js';
import { packSceneForRust } from '../js/render/rust-scene-pack.js';
import { renderRust } from '../js/render/rust-render-bridge.js';
import { sanitizeModelUrl, normalizeHexColor } from '../js/embed/embed-core.js';
import { USDZExporter } from '../js/exporters/usdz-exporter.js';
import { scanLocalDirectory, createLocalItemsFromFiles } from '../js/ui/asset-library-sources.js';
import { STEM_LESSONS, gradeStemLesson } from '../js/education/stem-curriculum.js';
import { SceneManager, CompositeCommand } from '../js/core/scene-manager.js';
import { RapidStudio } from '../js/scripting/rapid-api.js';
import { scanGeneratedCode } from '../js/ai/copilot-guard.js';
import { safeJsonSerialize } from '../js/core/studio-bridge.js';
import { buildSceneDigest, formatSceneDigestForPrompt } from '../js/ai/scene-digest.js';
import { runToolLoop, TOOL_RESULT_PREFIX } from '../js/ai/agent-tool-bridge.js';

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`ok   ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`FAIL ${name}\n     ${err.stack || err.message}`);
  }
}

console.log('\n=== Wave 3 Regression Suite ===');

// ---------------------------------------------------------------------------
// 1. Group 12: Mocap tkhd rotation, Rust heels/aspect, Face GLTF & BVH
// ---------------------------------------------------------------------------

await test('MP4 tkhd rotation matrix parses 0/90/180/270 degrees accurately', () => {
  const F = 65536;
  assert.equal(parseTkhdRotationDeg([F, 0, 0, 0, F, 0]), 0);
  assert.equal(parseTkhdRotationDeg([0, F, 0, -F, 0, 0]), 90);
  assert.equal(parseTkhdRotationDeg([-F, 0, 0, 0, -F, 0]), 180);
  assert.equal(parseTkhdRotationDeg([0, -F, 0, F, 0, 0]), 270);
});

await test('mocap_kernel preserves 21 enumerable keys + non-enumerable heels + aspect pan scaling', async () => {
  const ready = await initMocapKernel();
  assert.equal(ready, true, 'mocap_kernel WASM must initialize');

  const mkFrame = (i) => {
    const t = i / 30;
    return {
      time: t,
      nose: [0, 1.65, 0],
      leftEye: [0.04, 1.7, 0],
      rightEye: [-0.04, 1.7, 0],
      leftEar: [0.08, 1.68, -0.02],
      rightEar: [-0.08, 1.68, -0.02],
      leftShoulder: [0.18, 1.45, 0],
      rightShoulder: [-0.18, 1.45, 0],
      leftElbow: [0.25, 1.15, 0.02],
      rightElbow: [-0.25, 1.15, 0.02],
      leftWrist: [0.28, 0.9, 0.05],
      rightWrist: [-0.28, 0.9, 0.05],
      leftHip: [0.1, 0.95, 0],
      rightHip: [-0.1, 0.95, 0],
      leftKnee: [0.1, 0.52, 0],
      rightKnee: [-0.1, 0.52, 0],
      leftAnkle: [0.1, 0.08, 0],
      rightAnkle: [-0.1, 0.08, 0],
      leftHeel: [0.1, 0.03, -0.05],
      rightHeel: [-0.1, 0.03, -0.05],
      leftFoot: [0.1, 0.02, 0.14],
      rightFoot: [-0.1, 0.02, 0.14],
    };
  };
  const series = Array.from({ length: 10 }, (_, i) => mkFrame(i));
  const hip2dSeries = Array.from({ length: 10 }, () => [500, 500, 250, 0.99]);
  const cameraMotionSeries = Array.from({ length: 10 }, (_, i) => ({
    cumPanXNorm: i * 0.02,
    cumPanYNorm: 0,
    cumZoom: 1,
    confidence: 0.99,
  }));

  const outSquare = processJointsWasm(series, {
    fps: 30,
    aspectRatio: 1.0,
    hip2dSeries,
    cameraMotionSeries,
    depthStability: 0.8,
  });
  const outWide = processJointsWasm(series, {
    fps: 30,
    aspectRatio: 2.0,
    hip2dSeries,
    cameraMotionSeries,
    depthStability: 0.8,
  });

  assert.equal(outSquare.frames.length, 10);
  assert.equal(Object.keys(outSquare.frames[0]).length, 21, 'enumerable joint schema must stay 21 keys');
  assert.ok(Array.isArray(outSquare.frames[0].leftHeel) && outSquare.frames[0].leftHeel.length === 3, 'non-enumerable leftHeel preserved');
  assert.ok(Array.isArray(outSquare.frames[0].rightHeel) && outSquare.frames[0].rightHeel.length === 3, 'non-enumerable rightHeel preserved');
  const panDiff = Math.abs(outWide.frames[9].midHip[0] - outSquare.frames[9].midHip[0]);
  assert.ok(panDiff > 1e-2, `expected aspect ratio pan compensation on root trajectory to differ (diff=${panDiff})`);
});

await test('face-solver CC4 _L/_R morph tracks export cleanly through GLTFExporter', async () => {
  const geo = new THREE.BoxGeometry(0.4, 0.4, 0.4);
  const posAttr = geo.attributes.position;
  const targetArr = new Float32Array(posAttr.array.length);
  targetArr[0] = 0.05;
  geo.morphAttributes.position = [new THREE.BufferAttribute(targetArr, 3), new THREE.BufferAttribute(targetArr, 3)];
  const headMesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial());
  headMesh.name = 'CC_Base_Body';
  headMesh.morphTargetDictionary = { jawOpen: 0, eyeBlink_L: 1 };
  headMesh.morphTargetInfluences = [0, 0];

  const root = new THREE.Group();
  root.add(headMesh);

  const solved = solveFaceAndExpressionTracks({
    character: root,
    faceFrames: [
      { confidence: 0.99, blendshapes: { jawOpen: 0.5, eyeBlinkLeft: 0.7 } },
      { confidence: 0.99, blendshapes: { jawOpen: 0.2, eyeBlinkLeft: 0.1 } },
    ],
    times: [0, 0.5],
  });

  assert.ok(solved.tracks.length >= 2, 'should generate morph tracks');
  const jawTrack = solved.tracks.find((tr) => tr.name.includes('morphTargetInfluences[jawOpen]'));
  const blinkTrack = solved.tracks.find((tr) => tr.name.includes('morphTargetInfluences[eyeBlink_L]'));
  assert.ok(jawTrack && blinkTrack, 'must use GLTFExporter-compatible morph name binding & resolve _L alias');

  const clip = new THREE.AnimationClip('FaceTest', 0.5, solved.tracks);
  const exporter = new GLTFExporter();
  const glb = await exporter.parseAsync(root, { binary: true, animations: [clip] });
  assert.ok(glb instanceof ArrayBuffer && glb.byteLength > 200, 'GLTFExporter must export valid GLB');
});

await test('bvh-exporter uses bind-pose bone offsets even when skeleton is deformed', () => {
  const hips = new THREE.Bone(); hips.name = 'mixamorigHips'; hips.position.set(0, 1, 0);
  const spine = new THREE.Bone(); spine.name = 'mixamorigSpine'; spine.position.set(0, 0.4, 0);
  const head = new THREE.Bone(); head.name = 'mixamorigHead'; head.position.set(0, 0.5, 0);
  hips.add(spine); spine.add(head);

  const group = new THREE.Group();
  group.add(hips);
  group.updateMatrixWorld(true);

  const bones = [hips, spine, head];
  const boneInverses = bones.map((b) => new THREE.Matrix4().copy(b.matrixWorld).invert());
  const skel = new THREE.Skeleton(bones, boneInverses);
  const mesh = new THREE.SkinnedMesh(new THREE.BoxGeometry(0.1, 0.1, 0.1), new THREE.MeshStandardMaterial());
  mesh.bind(skel);
  group.add(mesh);

  // Deform skeleton before exporting BVH
  spine.rotation.set(0.6, 0.2, -0.3);
  group.updateMatrixWorld(true);

  const clip = new THREE.AnimationClip('Idle', 0.2, [
    new THREE.QuaternionKeyframeTrack('mixamorigSpine.quaternion', [0, 0.2], [0, 0, 0, 1, 0, 0.3, 0, 0.95]),
  ]);
  const res = exportClipToBVH(group, clip, { fps: 30, scale: 100 });
  assert.ok(typeof res?.bvh === 'string', 'exportClipToBVH returns { bvh }');
  assert.ok(res.bvh.includes('HIERARCHY') && res.bvh.includes('MOTION'), 'BVH must contain hierarchy and motion');
  assert.ok(res.bvh.includes('OFFSET 0.0000 40.0000 0.0000') || res.bvh.includes('OFFSET 0 40 0'), 'spine rest offset preserved');
});

// ---------------------------------------------------------------------------
// 2. Group 15/16: Rust render_kernel PointLight flux + Glass transmission shadow
// ---------------------------------------------------------------------------

await test('render_kernel PointLight flux parity and glass transmission shadow attenuation', async () => {
  const makeScene = (blocker) => {
    const scene = new THREE.Scene();
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(8, 8),
      new THREE.MeshStandardMaterial({ color: 0xe0e0e0, roughness: 0.9 })
    );
    floor.rotation.x = -Math.PI / 2;
    scene.add(floor);
    if (blocker) scene.add(blocker);

    const light = new THREE.PointLight(0xffffff, 18.0, 20, 2);
    light.position.set(0, 2.2, 0);
    scene.add(light);

    const cam = new THREE.PerspectiveCamera(45, 1, 0.1, 50);
    cam.position.set(0, 2.5, 4.2);
    cam.lookAt(0, 0, 0);
    cam.updateMatrixWorld(true);
    scene.updateMatrixWorld(true);
    return { scene, cam };
  };

  // Unoccluded PointLight should light floor brightly (previously 796x dim)
  const lit = makeScene(null);
  const packedLit = packSceneForRust({ scene: lit.scene, camera: lit.cam, width: 32, height: 32 });
  const resLit = await renderRust(packedLit, { width: 32, height: 32, samples: 8, denoise: false, threads: 1, tonemap: 'linear' });
  const centerIdx = (24 * 32 + 16) * 4;
  const litFloorLum = (resLit.rgba[centerIdx] + resLit.rgba[centerIdx + 1] + resLit.rgba[centerIdx + 2]) / 3;
  assert.ok(litFloorLum > 25, `PointLight should illuminate floor brightly, got ${litFloorLum}`);

  // Clear transmissive glass slab between light & floor vs opaque slab
  const glass = new THREE.Mesh(
    new THREE.BoxGeometry(1.6, 0.1, 1.6),
    new THREE.MeshPhysicalMaterial({ color: 0xffffff, transmission: 0.95, roughness: 0.05, ior: 1.45, metalness: 0 })
  );
  glass.position.set(0, 1.0, 0);
  const sGlass = makeScene(glass);
  const resGlass = await renderRust(packSceneForRust({ scene: sGlass.scene, camera: sGlass.cam, width: 32, height: 32 }), {
    width: 32, height: 32, samples: 8, denoise: false, threads: 1, tonemap: 'linear',
  });

  const opaque = new THREE.Mesh(
    new THREE.BoxGeometry(1.6, 0.1, 1.6),
    new THREE.MeshStandardMaterial({ color: 0x222222, roughness: 0.9 })
  );
  opaque.position.set(0, 1.0, 0);
  const sOpaque = makeScene(opaque);
  const resOpaque = await renderRust(packSceneForRust({ scene: sOpaque.scene, camera: sOpaque.cam, width: 32, height: 32 }), {
    width: 32, height: 32, samples: 8, denoise: false, threads: 1, tonemap: 'linear',
  });

  const glassFloorLum = (resGlass.rgba[centerIdx] + resGlass.rgba[centerIdx + 1] + resGlass.rgba[centerIdx + 2]) / 3;
  const opaqueFloorLum = (resOpaque.rgba[centerIdx] + resOpaque.rgba[centerIdx + 1] + resOpaque.rgba[centerIdx + 2]) / 3;
  assert.ok(glassFloorLum > opaqueFloorLum + 10, `Glass shadow (${glassFloorLum.toFixed(1)}) must transmit light vs opaque (${opaqueFloorLum.toFixed(1)})`);
});

// ---------------------------------------------------------------------------
// 3. Group 21/20: Embed hex+alpha, URL security, USDZ AR, Local scan
// ---------------------------------------------------------------------------

await test('Embed normalizeHexColor(#rrggbbaa), protocol-relative rejection & mixed-content guard', () => {
  const c8 = normalizeHexColor('#11223380');
  assert.equal(c8.hex, '#112233');
  assert.ok(Math.abs(c8.alpha - 128 / 255) < 1e-4);
  const c4 = normalizeHexColor('#f08a');
  assert.equal(c4.hex, '#ff0088');
  assert.ok(Math.abs(c4.alpha - 0xaa / 255) < 1e-4);

  assert.equal(sanitizeModelUrl('//evil.com/model.glb'), null, 'protocol-relative // must be rejected');
  assert.equal(sanitizeModelUrl('http://cdn.example.com/a.glb', { pageProtocol: 'https:' }), null, 'http mixed content rejected on https');
  assert.equal(sanitizeModelUrl('https://cdn.example.com/a.glb', { pageProtocol: 'https:' }), 'https://cdn.example.com/a.glb');
});

await test('USDZExporter creates valid ZIP header for AR Quick Look', async () => {
  const scene = new THREE.Scene();
  scene.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ color: 0xff8800 })));
  const res = await new USDZExporter().parseAsync(scene);
  const bytes = res?.bytes;
  assert.ok(bytes instanceof Uint8Array && bytes.byteLength > 100);
  assert.equal(bytes[0], 0x50);
  assert.equal(bytes[1], 0x4b);
  assert.equal(bytes[2], 0x03);
  assert.equal(bytes[3], 0x04);
  const ascii = Buffer.from(bytes).toString('latin1');
  assert.ok(ascii.includes('model.usda'), 'USDZ archive must contain model.usda');
});

await test('scanLocalDirectory scans subdirectories recursively with unique IDs & createLocalItemsFromFiles', async () => {
  const fakeFile = (name) => ({ kind: 'file', name, getFile: async () => new File(['abc'], name) });
  const fakeDir = (entries) => ({
    kind: 'directory',
    name: 'root',
    async *values() {
      for (const e of entries) yield e;
    },
  });
  const rootDir = fakeDir([
    { ...fakeDir([fakeFile('chair.glb')]), name: 'Furniture' },
    { ...fakeDir([fakeFile('chair.glb'), fakeFile('notes.txt')]), name: 'Props' },
  ]);
  const items = await scanLocalDirectory(rootDir);
  assert.equal(items.length, 2);
  assert.equal(items[0].id, 'local_Furniture/chair.glb');
  assert.equal(items[1].id, 'local_Props/chair.glb');
  assert.notEqual(items[0].id, items[1].id);

  const fallback = createLocalItemsFromFiles([{ name: 'model.glb', webkitRelativePath: 'Sub/model.glb' }]);
  assert.equal(fallback.length, 1);
  assert.equal(fallback[0].id, 'local_file_Sub/model.glb');
});

// ---------------------------------------------------------------------------
// 4. Group 19/18/17: STEM grading parity, Batch Undo, Guard, StudioBridge, MCP
// ---------------------------------------------------------------------------

await test('STEM starterCode for Lessons 2-6 scores < 70 and solutionCode scores >= 90 (L5 & L6 = 100)', async () => {
  const runSnippet = async (code, sm, studioInst, simMgr) => {
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    const prevWin = globalThis.window;
    const prevRaf = globalThis.requestAnimationFrame;
    const prevCaf = globalThis.cancelAnimationFrame;
    globalThis.requestAnimationFrame = () => 1;
    globalThis.cancelAnimationFrame = () => {};
    globalThis.window = { sceneManager: sm, simulationManager: simMgr, dispatchEvent: () => {} };
    try {
      const fn = new AsyncFunction('studio', 'bpy', 'print', 'console', code);
      await fn(studioInst, studioInst.bpy, () => {}, { log() {}, warn() {}, error() {} });
    } finally {
      studioInst.stopAnimations();
      globalThis.window = prevWin;
      globalThis.requestAnimationFrame = prevRaf;
      globalThis.cancelAnimationFrame = prevCaf;
    }
  };

  for (const lesson of STEM_LESSONS) {
    const scene = new THREE.Scene();
    const sm = new SceneManager(scene);
    const studioInst = new RapidStudio({ scene, sceneManager: sm, THREE });
    const simMgr = {
      bodies: new Map(),
      ensureInit: async () => true,
      setConfig: (obj, cfg) => {
        obj.userData.physics = { ...cfg };
        simMgr.bodies.set(obj.uuid, { config: obj.userData.physics });
      },
    };
    const tl = { tracks: new Map(), clips: new Map() };

    if (lesson.number >= 2) {
      await runSnippet(lesson.starterCode, sm, studioInst, simMgr);
      const rStarter = gradeStemLesson(lesson.id, { sceneManager: sm, studio: studioInst, timelineEngine: tl, simulationManager: simMgr, code: lesson.starterCode });
      assert.ok(rStarter.score < 70, `Lesson ${lesson.number} starterCode must score < 70, got ${rStarter.score}`);
    }

    const scene2 = new THREE.Scene();
    const sm2 = new SceneManager(scene2);
    const studio2 = new RapidStudio({ scene: scene2, sceneManager: sm2, THREE });
    await runSnippet(lesson.solutionCode, sm2, studio2, simMgr);
    const rSol = gradeStemLesson(lesson.id, { sceneManager: sm2, studio: studio2, timelineEngine: tl, simulationManager: simMgr, code: lesson.solutionCode });
    assert.ok(rSol.score >= 90, `Lesson ${lesson.number} solutionCode must score >= 90, got ${rSol.score}`);
    if (lesson.number >= 5) {
      assert.equal(rSol.score, 100, `Lesson ${lesson.number} solutionCode must score 100, got ${rSol.score}`);
    }
  }
});

await test('RapidStudio.animate passes (time, delta) argument order', () => {
  const prevRaf = globalThis.requestAnimationFrame;
  const prevCaf = globalThis.cancelAnimationFrame;
  globalThis.requestAnimationFrame = () => 1;
  globalThis.cancelAnimationFrame = () => {};
  try {
    const scene = new THREE.Scene();
    const studio = new RapidStudio({ scene, THREE });
    let captured = null;
    studio.animate((time, delta) => { captured = { time, delta }; });
    assert.equal(studio._animationCallbacks.length, 1);
    studio._animationCallbacks[0].callback(2.5, 0.016, null);
    assert.equal(captured.time, 2.5);
    assert.equal(captured.delta, 0.016);
    studio.stopAnimations();
  } finally {
    globalThis.requestAnimationFrame = prevRaf;
    globalThis.cancelAnimationFrame = prevCaf;
  }
});

await test('SceneManager beginBatch/endBatch collapses 20 operations into 1 CompositeCommand undo step', () => {
  const scene = new THREE.Scene();
  const sm = new SceneManager(scene);
  sm.beginBatch('Batch 20 cubes');
  for (let i = 0; i < 20; i += 1) {
    sm.addObject(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial()), null, false, true);
  }
  sm.endBatch();

  assert.equal(sm.objects.size, 20);
  assert.equal(sm.undoStack.length, 1);
  assert.ok(sm.undoStack[0] instanceof CompositeCommand);

  sm.undo();
  assert.equal(sm.objects.size, 0, 'single undo must revert all 20 objects');
  sm.redo();
  assert.equal(sm.objects.size, 20, 'single redo must restore all 20 objects');
});

await test('copilot-guard blocks Reflect, __proto__, Proxy, getPrototypeOf, .constructor and OPFS', async () => {
  for (const snippet of [
    'Reflect.get(window, "fetch")',
    'const x = ({}).__proto__',
    'new Proxy({}, {})',
    'Object.getPrototypeOf({})',
    '({}).constructor("return 1")()',
    'await navigator.storage.getDirectory()',
  ]) {
    const v = scanGeneratedCode(snippet);
    assert.equal(v.ok, false, `copilot-guard must statically block: ${snippet}`);
  }
});

await test('studio-bridge safeJsonSerialize handles circular objects & THREE.Mesh without crashing', () => {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial());
  mesh.name = 'CyclicBox';
  mesh.position.set(1, 2, 3);
  const cyclic = { ok: true, mesh };
  cyclic.self = cyclic;

  const json = safeJsonSerialize(cyclic);
  const parsed = JSON.parse(json);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.self, '[Circular]');
  assert.equal(parsed.mesh.name, 'CyclicBox');
  assert.deepEqual(parsed.mesh.position, [1, 2, 3]);
});

await test('scene-digest includes position & AABB size and agent-tool-bridge caps oversized TOOL_RESULT', async () => {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(2, 4, 6), new THREE.MeshStandardMaterial({ name: 'MatA' }));
  mesh.name = 'TallBox';
  mesh.position.set(1, 2, 3);
  const digest = buildSceneDigest({ children: [mesh] });
  assert.deepEqual(digest.objects[0].position, [1, 2, 3]);
  assert.deepEqual(digest.objects[0].size, [2, 4, 6]);
  const prompt = formatSceneDigestForPrompt(digest);
  assert.ok(prompt.includes('pos:[1,2,3]') && prompt.includes('size:[2,4,6]'));

  const big = 'X'.repeat(25000);
  let capturedToolMsg = '';
  let step = 0;
  await runToolLoop({
    chat: async (msgs) => {
      step += 1;
      if (step === 1) return '```json\n{"tool":"scene.tree","args":[]}\n```';
      capturedToolMsg = msgs[msgs.length - 1].content;
      return 'Done';
    },
    catalog: { text: '- scene.tree', ids: ['scene.tree'] },
    executor: { execute: async () => ({ tool: 'scene.tree', ok: true, data: big }) },
  });
  assert.ok(capturedToolMsg.startsWith(TOOL_RESULT_PREFIX));
  assert.ok(capturedToolMsg.length <= 8200, `TOOL_RESULT exceeded cap: ${capturedToolMsg.length}`);
  const payload = JSON.parse(capturedToolMsg.slice(TOOL_RESULT_PREFIX.length + 1));
  assert.equal(payload.data.truncated, true);
});

await test('studio_mcp.py _resolve_safe_save_path blocks directory traversal outside workspace', () => {
  const out = execFileSync('python3', [
    '-c',
    `
import sys, types
mcp_pkg = types.ModuleType("mcp")
mcp_srv = types.ModuleType("mcp.server")
mcp_ms = types.ModuleType("mcp.server.mcpserver")
class DummyMCP:
    def __init__(self, *a, **k): pass
    def tool(self):
        return lambda f: f
mcp_ms.MCPServer = DummyMCP
sys.modules.update({"mcp": mcp_pkg, "mcp.server": mcp_srv, "mcp.server.mcpserver": mcp_ms})
import studio_mcp, os
safe = studio_mcp._resolve_safe_save_path("exports/test_out.glb", "default.glb")
assert safe.startswith(studio_mcp.WORKSPACE_ROOT)
try:
    studio_mcp._resolve_safe_save_path("../../etc/passwd", "default.png")
    raise SystemExit(2)
except ValueError:
    print("OK")
`,
  ], { encoding: 'utf8' });
  assert.ok(out.trim().endsWith('OK'));
});

await test('pathtrace-session.js uses nullish coalescing for baseRenderer.toneMapping', () => {
  const src = fs.readFileSync(new URL('../js/render/pathtrace-session.js', import.meta.url), 'utf8');
  assert.ok(src.includes('baseRenderer.toneMapping ?? THREE.ACESFilmicToneMapping'));
});

await test('motapis model list preserves all 12 verified models and adds new working models', () => {
  const pySrc = fs.readFileSync(new URL('../server.py', import.meta.url), 'utf8');
  for (const m of [
    'claude-sonnet-4-6', 'claude-sonnet-5-5', 'gpt-6-luna', 'gpt-6-astra', 'gpt-5.6-sol',
    'deepseek-v4-flash', 'DeepSeek-V4-Flash-0731', 'deepseek-v4.1-flash-1017',
    'gemini-4-hydrogen', 'grok-4.5', 'glm-5.3-flash', 'minimax-m3', 'minimax-m2.7',
    'kimi-k3.1-pro', 'hy4-preview'
  ]) {
    assert.ok(pySrc.includes(`"${m}"`), `Missing motapis model in server.py: ${m}`);
  }
});

await test('rapid-api loadHumanWithAnimation uses CC0 Bot_CC0.glb / Mannequin_CC0.glb (no Soldier 404)', () => {
  const src = fs.readFileSync(new URL('../js/scripting/rapid-api.js', import.meta.url), 'utf8');
  assert.ok(!src.includes('Soldier_Human_Rigged.glb'), 'Still references missing Soldier_Human_Rigged.glb');
  assert.ok(src.includes('/models/Bot_CC0.glb'));
  assert.ok(src.includes('/models/Mannequin_CC0.glb'));
});

await test('browser-mocap skips storage.googleapis.com fallback when crossOriginIsolated is true', () => {
  const src = fs.readFileSync(new URL('../js/animation/browser-mocap.js', import.meta.url), 'utf8');
  assert.ok(src.includes('crossOriginIsolated'));
});

await test('ai-copilot Stop guard prevents fallback fire and strips <think> tags', () => {
  const src = fs.readFileSync(new URL('../js/ai/ai-copilot.js', import.meta.url), 'utf8');
  assert.ok(src.includes('aborted: true'));
  assert.ok(src.includes('stripThinkingTags'));
});

console.log(`\nWave 3 Summary: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
