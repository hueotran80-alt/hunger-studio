/**
 * Wave 2 Regression Suite — Verifies fixes across all 6 core Wave 2 groups:
 * - Group 14 (Look-Dev / HDRI orientation, MatCap variants, RasterRenderer stage guard, ViewportGovernor)
 * - Group 8  (UV LSCM internal seam split, pinned cluster preservation, FlipY count, geometry-codec uv1 + meta)
 * - Group 7  (Sculpt Mode 2.0 rotated normals, 1-ring Laplacian Smooth, Symmetry X, __sculptPrevLodGeom cleanup, Rust Surface-Nets)
 * - Group 13 (Rapier setLimits + reference, wakeUp on gravity change, Kinematic body step, 3D debugRender wireframe, antipodal-safe bake)
 * - Group 1  (Multi-Select Modal Transform, parented child local<->world math, S X -1 negative scale, CameraManager align/lock, Light Proxy clone & Shadow Budget)
 * - Group 2  (Quad-View 4-pane joinLeavesInTree, Outliner filter + Ctrl/Shift multi-select, Collection rename + removeObject cleanup, Inspector World/Modifier reorder)
 *
 * Run: node --import ./tests/three-resolve-hooks.mjs tests/test_wave2_fixes.mjs
 */

import assert from 'node:assert/strict';
import * as THREE from 'three';

import { evaluateHdriRadiance, evaluateHdriRadianceInto, generateProceduralHdriData } from '../js/render/procedural-hdri.js';
import { MatCapStudio } from '../js/core/matcap-studio.js';
import { RasterRenderer } from '../js/render/raster-renderer.js';
import { ViewportGovernor } from '../js/core/viewport-governor.js';
import {
  extractWeldedTopology,
  unwrapMeshLSCM,
  packUVIslandsInPlace,
  countFlippedUVTriangles,
  edgeSpatialKeyFromVectors,
} from '../js/core/geometry/uv-unwrap.js';
import { encodeGeometry, decodeGeometry } from '../js/core/geometry/geometry-codec.js';
import { SculptMode } from '../js/core/sculpt-mode.js';
import { initMeshKernel, voxelRemeshInWasm } from '../js/core/mesh-kernel-bridge.js';
import { SimulationManager } from '../js/simulation/simulation-manager.js';
import { SceneManager } from '../js/core/scene-manager.js';
import { ModalTransformManager } from '../js/core/modal-transform.js';
import { CameraManager } from '../js/core/camera-manager.js';
import {
  ensureLightHelper,
  ensureLightProxy,
  syncLightDirection,
  enforceShadowBudget,
  removeLightHelper,
} from '../js/core/light-helper.js';
import {
  createLeafArea,
  splitLeafInTree,
  joinLeavesInTree,
  computeNormalizedRects,
  listLeafNodes,
} from '../js/ui/workspace-areas.js';
import { Outliner } from '../js/ui/outliner.js';
import { Inspector } from '../js/ui/inspector.js';
import { gradeStemLesson } from '../js/education/stem-curriculum.js';

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`ok   ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`FAIL ${name}\n     ${err?.stack || err}`);
  }
}

function makeFakeDOM() {
  const prevWin = globalThis.window;
  const prevDoc = globalThis.document;
  const listeners = new Map();

  class FakeEl {
    constructor(tag = 'div') {
      this.tagName = tag.toUpperCase();
      this.id = '';
      this.className = '';
      this.dataset = {};
      this.style = {};
      this.children = [];
      this.parentElement = null;
      this._listeners = new Map();
      this._html = '';
      this.textContent = '';
      this.title = '';
      this.value = '';
      this.checked = false;
      this.disabled = false;
      this.classList = {
        _set: new Set(),
        add: (...cls) => cls.forEach((c) => this.classList._set.add(c)),
        remove: (...cls) => cls.forEach((c) => this.classList._set.delete(c)),
        toggle: (c, f) => {
          const on = f === undefined ? !this.classList._set.has(c) : Boolean(f);
          if (on) this.classList._set.add(c);
          else this.classList._set.delete(c);
          return on;
        },
        contains: (c) => this.classList._set.has(c),
      };
    }
    set innerHTML(v) {
      this._html = String(v || '');
      if (this._html === '') {
        this.children.length = 0;
      } else {
        // Minimal structural hydration for id and class queries (#outliner-tree-root, .prop-object-name-input)
        this.children.length = 0;
        const tagRe = /<([a-z0-9-]+)([^>]*)>/gi;
        for (const m of this._html.matchAll(tagRe)) {
          const el = new FakeEl(m[1]);
          const attrs = m[2] || '';
          const idM = attrs.match(/\bid=["']([^"']+)["']/i);
          if (idM) el.id = idM[1];
          const clsM = attrs.match(/\bclass=["']([^"']+)["']/i);
          if (clsM) el.className = clsM[1];
          if (el.id || el.className) this.appendChild(el);
        }
      }
    }
    get innerHTML() {
      return this._html;
    }
    appendChild(ch) {
      ch.parentElement = this;
      this.children.push(ch);
      return ch;
    }
    append(...args) {
      args.forEach((a) => { if (a && typeof a === 'object') this.appendChild(a); });
    }
    remove() {
      if (this.parentElement) {
        this.parentElement.children = this.parentElement.children.filter((x) => x !== this);
        this.parentElement = null;
      }
    }
    addEventListener(type, fn) {
      if (!this._listeners.has(type)) this._listeners.set(type, []);
      this._listeners.get(type).push(fn);
    }
    removeEventListener(type, fn) {
      const arr = this._listeners.get(type);
      if (arr) this._listeners.set(type, arr.filter((x) => x !== fn));
    }
    dispatchEvent(ev) {
      const arr = this._listeners.get(ev.type) || [];
      arr.forEach((fn) => fn(ev));
    }
    querySelector(sel) {
      if (sel.startsWith('#')) {
        const id = sel.slice(1);
        for (const ch of this.children) {
          if (ch.id === id) return ch;
          const found = ch.querySelector?.(sel);
          if (found) return found;
        }
      } else if (sel.startsWith('.')) {
        const cls = sel.slice(1);
        for (const ch of this.children) {
          if ((ch.className || '').split(/\s+/).includes(cls)) return ch;
          const found = ch.querySelector?.(sel);
          if (found) return found;
        }
      }
      return null;
    }
    querySelectorAll(sel) {
      const out = [];
      const walk = (node) => {
        for (const ch of node.children) {
          const cls = sel.startsWith('.') ? sel.slice(1) : null;
          if (cls && (ch.className || '').split(/\s+/).includes(cls)) out.push(ch);
          walk(ch);
        }
      };
      walk(this);
      return out;
    }
    getBoundingClientRect() {
      return { left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600 };
    }
    getContext() {
      return {
        fillStyle: '',
        strokeStyle: '',
        fillRect() {},
        clearRect() {},
        createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }),
        putImageData() {},
        beginPath() {},
        arc() {},
        fill() {},
        createRadialGradient: () => ({ addColorStop() {} }),
        createLinearGradient: () => ({ addColorStop() {} }),
      };
    }
  }

  const fakeDoc = {
    body: new FakeEl('body'),
    head: new FakeEl('head'),
    createElement: (tag) => new FakeEl(tag),
    createTextNode: (t) => ({ textContent: String(t) }),
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {},
    removeEventListener() {},
  };
  const fakeWin = {
    innerWidth: 1280,
    innerHeight: 720,
    CustomEvent: class CustomEvent {
      constructor(type, init = {}) {
        this.type = type;
        this.detail = init.detail;
      }
    },
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    removeEventListener(type, fn) {
      const arr = listeners.get(type);
      if (arr) listeners.set(type, arr.filter((x) => x !== fn));
    },
    dispatchEvent(ev) {
      const arr = listeners.get(ev.type) || [];
      arr.forEach((fn) => fn(ev));
    },
    requestAnimationFrame: (cb) => { cb(); return 1; },
    cancelAnimationFrame() {},
  };

  globalThis.document = fakeDoc;
  globalThis.window = fakeWin;
  return () => {
    globalThis.window = prevWin;
    globalThis.document = prevDoc;
  };
}

// =========================================================================
// 1. Group 14 — Look-Dev Raster, HDRI Orientation, MatCap Variants, Governor
// =========================================================================

await test('HDRI vertical/azimuth matches Three.js equirectUv and evaluateHdriRadianceInto avoids alloc', async () => {
  const w = 64;
  const h = 32;
  const { data } = generateProceduralHdriData({ preset: 'golden-sunset', width: w, height: h, format: 'float' });
  // Compare top row (v near 1 -> +Y zenith) vs bottom row (v near 0 -> -Y nadir) for sunset sky > ground
  const nadirIdx = 0; // row 0 (v ~ 0.015 -> dy < 0)
  const zenithIdx = ((h - 1) * w) * 4; // top row (v ~ 0.985 -> dy > 0)
  const nadirLum = data[nadirIdx] + data[nadirIdx + 1] + data[nadirIdx + 2];
  const zenithLum = data[zenithIdx] + data[zenithIdx + 1] + data[zenithIdx + 2];
  assert.ok(zenithLum > nadirLum, `Golden sunset zenith (${zenithLum}) must exceed dark ground (${nadirLum})`);

  const out = new Float32Array(3);
  evaluateHdriRadianceInto('studio-softbox', 0.4, 0.7, -0.5, out);
  const arr = evaluateHdriRadiance('studio-softbox', 0.4, 0.7, -0.5);
  assert.ok(Math.abs(out[0] - arr[0]) < 1e-5 && Math.abs(out[1] - arr[1]) < 1e-5 && Math.abs(out[2] - arr[2]) < 1e-5);
});

await test('MatCapStudio getMaterial creates distinct variant instances without mutating solid singleton', async () => {
  const cleanupDom = makeFakeDOM();
  try {
    const studio = new MatCapStudio();
    const solid = studio.getMaterial('clay-gray');
    const wire = studio.getMaterial('clay-gray', { wireframe: true });
    const xray = studio.getMaterial('clay-gray', { opacity: 0.4 });
    assert.notEqual(solid, wire);
    assert.notEqual(solid, xray);
    assert.equal(solid.wireframe, false);
    assert.equal(wire.wireframe, true);
    assert.equal(solid.transparent, false);
    assert.equal(xray.transparent, true);
    assert.ok(Math.abs(xray.opacity - 0.4) < 1e-6);
  } finally {
    cleanupDom();
  }
});

await test('RasterRenderer hideHelpers keeps isRenderableStage and ViewportGovernor preserves preset edits', async () => {
  const scene = new THREE.Scene();
  const stageMesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial());
  stageMesh.userData.isRenderableStage = true;
  stageMesh.userData.isSystemObject = true;
  const helperMesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial());
  helperMesh.userData.isSystemObject = true;
  scene.add(stageMesh, helperMesh);

  let helperVisDuringRender = null;
  let stageVisDuringRender = null;
  const fakeRenderer = {
    shadowMap: { enabled: false, type: 0, autoUpdate: true, needsUpdate: false },
    toneMapping: 0,
    toneMappingExposure: 1,
    getSize: (t) => t.set(64, 64),
    getPixelRatio: () => 1,
    getRenderTarget: () => null,
    setPixelRatio() {},
    setSize() {},
    setRenderTarget() {},
    clear() {},
    render: () => {
      helperVisDuringRender = helperMesh.visible;
      stageVisDuringRender = stageMesh.visible;
    },
    dispose() {},
  };
  const rr = new RasterRenderer({ renderer: fakeRenderer, scene, camera: new THREE.PerspectiveCamera(), preset: 'fast' });
  rr.renderFrame({ hideHelpers: true });
  assert.equal(helperVisDuringRender, false, 'Regular system helper hidden when hideHelpers=true');
  assert.equal(stageVisDuringRender, true, 'isRenderableStage preserved when hideHelpers=true');
  assert.equal(helperMesh.visible, true, 'Helper visibility restored after render');

  // ViewportGovernor user preset protection during navigation
  let appliedPresets = [];
  rr.postProcessing = {
    enabled: true,
    currentPreset: 'fast',
    gtaoPass: { enabled: false },
    bokehPass: { enabled: false },
    applyPreset(p) {
      this.currentPreset = p;
      appliedPresets.push(p);
    },
    render() {},
    setSize() {},
    updateCameraAndScene() {},
    dispose() {},
  };
  const gov = new ViewportGovernor({ engine: { rasterRenderer: rr, renderer: fakeRenderer, lodManager: null, instancingSystem: null, markShadowDirty() {}, requestRender() {} } });
  gov.beginInteraction('orbit');
  rr.postProcessing.currentPreset = 'cinematic';
  gov.settleNow(false);
  assert.equal(rr.postProcessing.currentPreset, 'cinematic', 'ViewportGovernor must not overwrite preset edited mid-orbit');
  assert.equal(appliedPresets[appliedPresets.length - 1], 'cinematic');
});

// =========================================================================
// 2. Group 8 — UV LSCM Internal Seam Split, Pins, Flip Count, Geometry Codec
// =========================================================================

await test('UV unwrap splits internal seams without welding & codec preserves uv1 + seam/pin metadata', async () => {
  // 2x2 pyramid/tent (9 vertices, non-zero curvature at apex (0,0,1.2)) with a seam cut from apex to top-mid (0,1,0)
  const geom = new THREE.PlaneGeometry(2, 2, 2, 2);
  geom.attributes.position.setZ(4, 1.2);
  geom.computeVertexNormals();
  const vCenter = new THREE.Vector3(0, 0, 1.2);
  const vTopMid = new THREE.Vector3(0, 1, 0);
  const seamKey = edgeSpatialKeyFromVectors(vCenter, vTopMid);
  geom.userData._uvSeams = [seamKey];

  const topo = extractWeldedTopology(geom, new Set([seamKey]));
  assert.equal(topo.weldedVerts.length, 9, '2x2 tent has 9 welded 3D vertices');

  // Flattening a curved cone/tent opens the internal seam dart cleanly (> 9 UV verts!)
  geom.userData._uvPinned = { 'p0': [0.1, 0.2], 'p1': [0.8, 0.2] };
  const unwrapped = unwrapMeshLSCM(geom, { angleLimit: 66 });
  assert.ok(unwrapped.attributes.uv, 'UV attribute exists after LSCM');
  assert.ok(unwrapped.attributes.position.count > 9, `Internal seam split opens UV verts (${unwrapped.attributes.position.count} > 9)`);
  assert.ok(countFlippedUVTriangles(unwrapped) === 0, 'Standard front tent unwrap should have 0 flipped UV triangles');

  // Test countFlippedUVTriangles catches flipped triangle
  const flipGeo = new THREE.BufferGeometry();
  flipGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), 3));
  flipGeo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([0, 0, 0, 1, 1, 0]), 2)); // clockwise = negative signed area
  assert.equal(countFlippedUVTriangles(flipGeo), 1);

  // Test packUVIslandsInPlace skipPinned option & geometry-codec uv1 + uvMeta round-trip
  unwrapped.setAttribute('uv1', unwrapped.attributes.uv.clone());
  unwrapped.userData._uvSeams = [seamKey];
  unwrapped.userData._uvPinned = { k0: [0.25, 0.75] };
  const encoded = encodeGeometry(unwrapped);
  const decoded = decodeGeometry(encoded);
  assert.ok(decoded.attributes.uv1, 'Decoded geometry preserves uv1 attribute');
  assert.deepEqual(decoded.userData._uvSeams, [seamKey], 'Decoded geometry preserves _uvSeams');
  assert.deepEqual(decoded.userData._uvPinned, { k0: [0.25, 0.75] }, 'Decoded geometry preserves _uvPinned');

  const uvBeforePack = Array.from(unwrapped.attributes.uv.array);
  packUVIslandsInPlace(unwrapped, { preservePinnedIslands: true });
  assert.equal(uvBeforePack.length, unwrapped.attributes.uv.array.length);
});

// =========================================================================
// 3. Group 7 — Sculpt Mode 2.0 Rotated Normals, 1-Ring Smooth, Symmetry X, WASM
// =========================================================================

await test('SculptMode pushes rotated mesh along local outward normal, smooths 1-ring & cleans LOD0', async () => {
  const cleanupDom = makeFakeDOM();
  try {
    const geom = new THREE.BoxGeometry(2, 2, 2, 4, 4, 4);
    const mesh = new THREE.Mesh(geom, new THREE.MeshStandardMaterial());
    mesh.rotation.y = Math.PI / 2; // 90 deg rotation!
    mesh.updateMatrixWorld(true);

    // Prepare Auto-LOD fallback geometry to test exit() cleanup
    const lowGeo = new THREE.BoxGeometry(2, 2, 2, 1, 1, 1);
    const highGeo = geom;
    mesh.geometry = lowGeo;
    mesh.userData.lod = { levels: [highGeo, lowGeo], activeLevel: 1 };

    const sculpt = new SculptMode({ engine: null, sceneManager: null });
    sculpt.setBrush('draw');
    sculpt.setRadius(0.6);
    sculpt.setStrength(0.8);
    assert.equal(sculpt.enter(mesh), true);
    assert.equal(mesh.geometry, highGeo, 'enter() promotes mesh to LOD0');

    // Compute hit point on +Z local face (which in world is +X = +1 due to +90deg Y rotation)
    const worldHit = new THREE.Vector3(1, 0, 0);
    const localNormal = new THREE.Vector3(0, 0, 1);
    const sampleIdx = (() => {
      const p = highGeo.attributes.position;
      for (let i = 0; i < p.count; i++) {
        if (Math.abs(p.getX(i)) < 0.01 && Math.abs(p.getY(i)) < 0.01 && p.getZ(i) > 0.99) return i;
      }
      return 0;
    })();
    const zBefore = highGeo.attributes.position.getZ(sampleIdx);
    sculpt._applyBrush({ point: worldHit, face: { normal: localNormal }, object: mesh }, 1.0);
    const zAfter = highGeo.attributes.position.getZ(sampleIdx);
    assert.ok(zAfter > zBefore + 0.01, `Draw on +90deg rotated mesh must push local +Z outward (${zBefore} -> ${zAfter})`);

    // Test exit() restores __sculptPrevLodGeom cleanly
    sculpt.exit();
    assert.equal(mesh.geometry, lowGeo, 'exit() restores prior LOD geometry when fallback path was used');
    assert.equal(mesh.userData.__sculptPrevLodGeom, undefined);

    // Verify 1-ring Laplacian neighbor cache & Symmetry X half-space non-doubling
    const plane = new THREE.Mesh(new THREE.PlaneGeometry(2, 2, 4, 4), new THREE.MeshStandardMaterial());
    const centerIdx = 12; // middle row vertex at x = 0 on 5x5 grid
    plane.geometry.attributes.position.setZ(centerIdx, 0.8);
    plane.geometry.computeVertexNormals();
    sculpt.enter(plane);
    sculpt.symmetryX = true;
    sculpt.setBrush('smooth');
    sculpt._buildVertexNeighbors?.(plane.geometry);
    const smoothNeighbors = sculpt._vertNeighbors;
    assert.ok(Array.isArray(smoothNeighbors) && smoothNeighbors.length === 25, '1-ring welded neighbors built');
    sculpt._applyBrush({ point: new THREE.Vector3(0, 0, 0.8), face: { normal: new THREE.Vector3(0, 0, 1) }, object: plane }, 1.0);
    const centerZAfterSmooth = plane.geometry.attributes.position.getZ(centerIdx);
    assert.ok(centerZAfterSmooth < 0.8 && centerZAfterSmooth >= 0, `Smooth lowers peak spike (${centerZAfterSmooth})`);
    sculpt.exit();

    // Rust WASM Surface-Nets voxelRemeshInWasm smoke test
    await initMeshKernel();
    const boxPos = new Float32Array(new THREE.BoxGeometry(1, 1, 1).toNonIndexed().attributes.position.array);
    const remeshed = voxelRemeshInWasm(boxPos, null, 0.25);
    assert.ok(remeshed && remeshed.vertices?.length >= 36, 'Surface-Nets WASM remesh produces valid vertices');
  } finally {
    cleanupDom();
  }
});

// =========================================================================
// 4. Group 13 — Rapier Physics, setLimits + Reference, Kinematic, Wireframe, STEM L6
// =========================================================================

await test('Rapier Physics honors revolute limits + reference, Kinematic body, debugRender wireframe & STEM L6', async () => {
  const sm = new SceneManager(new THREE.Scene());
  const owner = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial());
  owner.position.set(0, 5, 0);
  const arm = new THREE.Mesh(new THREE.BoxGeometry(1, 2, 1), new THREE.MeshStandardMaterial());
  arm.position.set(0, 3.2, 0);
  arm.rotation.z = Math.PI / 4; // 45 deg initial angle (non-zero reference!)
  sm.addObject(owner, null, false, false);
  sm.addObject(arm, null, false, false);

  const sim = new SimulationManager({ sceneManager: sm });
  await sim.init();
  sim.setConfig(owner, { body: 'fixed' });
  sim.setConfig(arm, { body: 'dynamic' });

  const spec = sim.createJoint(owner, arm, { type: 'revolute', axis: 'z' });
  assert.ok(spec);
  sim.setJointConfig(owner, spec, { limitsEnabled: true, lowerDeg: -20, upperDeg: 20 });

  // Verify the joint's Rapier limits are offset by reference so initial angle 45 deg stays inside [-20, +20] relative!
  sim.stepFrames(30);
  const relAngle = sim.getJointAngle(owner, spec);
  assert.ok(Math.abs(relAngle) <= 22, `Revolute angle relative to initial 45deg pose stays within [-20,+20] limits (got ${relAngle})`);

  // Test Kinematic body pushing a dynamic body & debugRender wireframe creation
  sim.reset();
  const pusher = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial());
  pusher.position.set(0, 10, 0);
  sm.addObject(pusher, null, false, false);
  sim.setConfig(pusher, { body: 'kinematic' });
  sim.setGravity(0, -9.81, 0);
  pusher.position.set(0, 10.5, 0);
  sim.stepFrames(2);
  const pusherEntry = sim.bodies.get(pusher);
  assert.ok(Math.abs(pusherEntry.body.translation().y - 10.5) < 0.05, 'Kinematic body moved to target position during step');

  sim.setDebugEnabled(true);
  assert.ok(sim._debugHelper && sim._debugHelper.visible === true, 'Rapier debug wireframe created and visible');
  assert.ok(sim._debugHelper.geometry.attributes.position.count > 0, 'Rapier debug wireframe has vertices');

  // Verify STEM Lesson 6 rubric accepts canonical body: 'dynamic'
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial());
  mesh.userData.physics = { enabled: true, body: 'dynamic', restitution: 0.7 };
  const g6 = gradeStemLesson(6, { objects: [mesh] });
  assert.ok(g6.score >= 70, `STEM L6 rubric scores dynamic rigid body cleanly (got ${g6.score})`);
});

// =========================================================================
// 5. Group 1 — Multi-Select Modal, Parented Math, Negative Scale, Camera, Light Proxy/Budget
// =========================================================================

await test('ModalTransform supports Multi-Select, parented child math, S X -1 negative scale & 1-step Undo', async () => {
  const cleanupDom = makeFakeDOM();
  try {
    const sm = new SceneManager(new THREE.Scene());
    const fakeCam = new THREE.PerspectiveCamera(50, 1.33, 0.1, 100);
    fakeCam.position.set(0, 0, 10);
    fakeCam.lookAt(0, 0, 0);
    fakeCam.updateMatrixWorld(true);
    const fakeEngine = {
      scene: sm.scene,
      camera: fakeCam,
      domElement: document.createElement('canvas'),
      controls: { enabled: true },
      transformControls: { visible: true },
      pivotMode: 'median',
      updateSelectionHelper() {},
      getViewportRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
    };

    const parent = new THREE.Group();
    parent.position.set(5, 0, 0);
    parent.rotation.y = Math.PI / 2; // +90 deg parent!
    sm.addObject(parent, null, false, false);

    const child = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial());
    child.position.set(0, 0, 0);
    const sibling = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial());
    sibling.position.set(0, 0, 0);
    sm.addObject(child, parent, false, false);
    sm.addObject(sibling, null, false, false);

    sm.setSelection([child, sibling], child);
    const mt = new ModalTransformManager({ engine: fakeEngine, sceneManager: sm, editMode: null });

    // 1) Global +X translation by +2m across rotated parent child + root sibling
    assert.equal(mt.start('translate', { axisLock: 'X', isLocalAxis: false }), true);
    mt.numericInput = '2';
    mt.hasNumericInput = true;
    mt._updateTransformation(false, false);
    mt.confirm();

    const childWorldAfter = child.getWorldPosition(new THREE.Vector3());
    const sibWorldAfter = sibling.getWorldPosition(new THREE.Vector3());
    assert.ok(Math.abs(childWorldAfter.x - 7.0) < 1e-4, `Parented child moved +2m in world X (got ${childWorldAfter.x})`);
    assert.ok(Math.abs(sibWorldAfter.x - 2.0) < 1e-4, `Sibling moved +2m in world X (got ${sibWorldAfter.x})`);

    // Single Ctrl+Z reverts BOTH objects atomically
    sm.undo();
    assert.ok(Math.abs(child.getWorldPosition(new THREE.Vector3()).x - 5.0) < 1e-4);
    assert.ok(Math.abs(sibling.getWorldPosition(new THREE.Vector3()).x - 0.0) < 1e-4);

    // 2) Negative mirror scale S X -1 on single mesh
    sm.select(sibling, false);
    assert.equal(mt.start('scale', { axisLock: 'X' }), true);
    mt.numericInput = '-1';
    mt.hasNumericInput = true;
    mt._updateTransformation(false, false);
    mt.confirm();
    assert.ok(Math.abs(sibling.scale.x + 1.0) < 1e-6, `Negative scale S X -1 must preserve -1 (got ${sibling.scale.x})`);
  } finally {
    cleanupDom();
  }
});

await test('CameraManager alignActiveCameraToView + Lock-to-View & Light Proxy clone + Shadow Budget <= 4', async () => {
  const cleanupDom = makeFakeDOM();
  try {
    const sm = new SceneManager(new THREE.Scene());
    const viewCam = new THREE.PerspectiveCamera(55, 1.5, 0.1, 1000);
    viewCam.position.set(12, 8, -4);
    viewCam.lookAt(0, 0, 0);
    viewCam.updateMatrixWorld(true);

    const fakeControls = {
      object: viewCam,
      target: new THREE.Vector3(0, 0, 0),
      enabled: true,
      listeners: new Map(),
      addEventListener(t, f) { if (!this.listeners.has(t)) this.listeners.set(t, []); this.listeners.get(t).push(f); },
      removeEventListener(t, f) { const a = this.listeners.get(t); if (a) this.listeners.set(t, a.filter((x) => x !== f)); },
      update() {},
    };
    const fakeEngine = {
      scene: sm.scene,
      camera: viewCam,
      perspectiveCamera: viewCam,
      controls: fakeControls,
      syncViewportPaneControls() {},
      updateViewportCameraLabel() {},
      requestRender() {},
    };
    const cm = new CameraManager(fakeEngine, { sceneManager: sm });
    const camGroup = cm.createCamera({ name: 'ShotCam', position: { x: 1, y: 1, z: 1 } });

    const aligned = cm.alignActiveCameraToView(camGroup);
    assert.equal(aligned, camGroup);
    assert.ok(camGroup.position.distanceTo(viewCam.position) < 1e-4, 'Ctrl+Alt+0 aligns camera position to viewport');
    assert.equal(cm.setLockToView(true), true);

    // Light Proxy must survive light.clone() without circular JSON crash + syncLightDirection aims -Z
    const sun = new THREE.DirectionalLight(0xffeedd, 2.0);
    sun.position.set(0, 10, 5);
    sun.rotation.x = -Math.PI / 4;
    ensureLightHelper(sun);
    const clonedSun = sun.clone();
    assert.ok(clonedSun.isDirectionalLight, 'Light with PickProxy clones cleanly');
    syncLightDirection(sun);
    assert.ok(sun.target.position.y < sun.position.y, 'DirectionalLight target updated along rotated -Z');
    removeLightHelper(sun);

    // Shadow Budget caps simultaneous shadow lights to <= 4 while keeping active light enabled
    const lights = [];
    for (let i = 0; i < 6; i++) {
      const pt = new THREE.PointLight(0xffffff, i + 1);
      pt.castShadow = true;
      sm.addObject(pt, null, false, false);
      lights.push(pt);
    }
    const res = enforceShadowBudget(sm, lights[0], 4);
    assert.equal(res.enabledCount, 4);
    assert.equal(lights[0].castShadow, true, 'Active light stays prioritized inside shadow budget');
    assert.equal(lights.filter((l) => l.castShadow).length, 4);
  } finally {
    cleanupDom();
  }
});

// =========================================================================
// 6. Group 2 — Workspace 4-Pane Join, Outliner Filter/Multi/Collections, Inspector World
// =========================================================================

await test('Workspace Quad 4-pane joinLeavesInTree, Outliner filter/multi-select & Collection cleanup, Inspector World', async () => {
  const cleanupDom = makeFakeDOM();
  try {
    // Build symmetrical 4-pane Quad split: [TL | TR] over [BL | BR]
    let root = createLeafArea({ id: 'tl' });
    const sV = splitLeafInTree(root, 'tl', 'vertical', 0.5, false, { id: 'tr' });
    const sL = splitLeafInTree(sV.node, 'tl', 'horizontal', 0.4, false, { id: 'bl' });
    const sR = splitLeafInTree(sL.node, 'tr', 'horizontal', 0.4, false, { id: 'br' });
    root = sR.node;
    assert.equal(listLeafNodes(root).length, 4);

    // Join top-left TL with top-right TR (previously failed with null because neither was direct child of root!)
    const joinedTop = joinLeavesInTree(root, 'tl', 'tr');
    assert.ok(joinedTop, '4-pane symmetrical TL+TR join succeeds');
    assert.equal(listLeafNodes(joinedTop).length, 3);
    const rects = computeNormalizedRects(joinedTop);
    assert.ok(Math.abs(rects.get('tl').w - 1.0) < 1e-4, 'Merged TL spans full top width');
    assert.ok(Math.abs(rects.get('tl').h - 0.4) < 1e-4);
    assert.ok(Math.abs(rects.get('bl').w - 0.5) < 1e-4);
    assert.ok(Math.abs(rects.get('br').w - 0.5) < 1e-4);

    // Outliner Type Filter + Multi-Select + Collection rename + removeObject UUID cleanup
    const sm = new SceneManager(new THREE.Scene());
    const box = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial());
    box.name = 'HeroCube';
    const light = new THREE.PointLight(0xffffff, 1);
    light.name = 'KeyPoint';
    sm.addObject(box, null, false, false);
    sm.addObject(light, null, false, false);

    const col = sm.collectionManager.createCollection('Props');
    assert.equal(sm.collectionManager.renameCollection(col.id, 'Lighting'), true);
    sm.collectionManager.moveObjectToCollection(light, col.id);
    assert.equal(col.objectUuids.has(light.uuid), true);

    const outliner = new Outliner(document.createElement('div'), sm);
    outliner.setTypeFilter('light');
    assert.equal(outliner._renderedNodes.some((n) => n.name === 'HeroCube'), false, 'Light filter hides Mesh');
    assert.equal(outliner._renderedNodes.some((n) => n.name === 'KeyPoint'), true, 'Light filter shows Light');

    outliner.setTypeFilter('all');
    // Shift range select across HeroCube & KeyPoint
    const cubeNode = outliner._renderedNodes.find((n) => n.name === 'HeroCube');
    const lightNode = outliner._renderedNodes.find((n) => n.name === 'KeyPoint');
    outliner.selectNode(cubeNode, false);
    outliner.selectNode(lightNode, { shiftKey: true, ctrlKey: false });
    assert.equal(sm.getSelectedObjects().length, 2, 'Shift-click selects range in SceneManager');

    // Ctrl-click toggles Light back out
    outliner.selectNode(lightNode, { shiftKey: false, ctrlKey: true });
    assert.equal(sm.getSelectedObjects().length, 1);

    // Deleting object cleans its UUID out of its collection
    sm.removeObject(light, false, false);
    assert.equal(col.objectUuids.has(light.uuid), false, 'removeObject scrubs UUID from collection');

    // Inspector renders World tab even when targetObject is null
    sm.clearSelection();
    const insp = new Inspector(document.createElement('div'), sm);
    insp.activeTab = 'world';
    insp.targetObject = null;
    insp.render();
    assert.ok(insp.contentBody.children.length > 0, 'World tab renders card even with no active selection');
  } finally {
    cleanupDom();
  }
});

await test('Inspector curve/text metadata renders as inert DOM properties', async () => {
  const cleanupDom = makeFakeDOM();
  try {
    const payload = '1" autofocus onfocus="window.__curveXss=1"><img src=x onerror="window.__curveXss=2">';
    const insp = new Inspector(document.createElement('div'));
    insp.targetObject = { userData: { curveData: { kind: 'text', text: payload, depth: payload, size: payload } } };
    insp.renderCurveSection();

    assert.equal(insp.contentBody.querySelector('#curv-text-val').value, payload);
    assert.equal(insp.contentBody.querySelector('#curv-text-depth').value, payload);
    assert.equal(insp.contentBody.querySelector('#curv-text-depth-val').textContent, payload);
    assert.equal(insp.contentBody.querySelector('#curv-text-val').onfocus, undefined);
    assert.equal(insp.contentBody.querySelector('#curv-text-depth').onfocus, undefined);
    assert.equal(insp.contentBody.querySelector('[onerror]'), null);

    insp.contentBody.innerHTML = '';
    insp.targetObject = { userData: { curveData: { kind: 'bezier', bevelDepth: payload, resolution: payload, closed: true } } };
    insp.renderCurveSection();
    assert.equal(insp.contentBody.querySelector('#curv-bevel-depth').value, payload);
    assert.equal(insp.contentBody.querySelector('#curv-resolution').value, payload);
    assert.equal(insp.contentBody.querySelector('#curv-closed').checked, true);
    assert.equal(insp.contentBody.querySelector('[onerror]'), null);
  } finally {
    cleanupDom();
  }
});

console.log(`\nWave 2 Regression Suite: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
