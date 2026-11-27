/**
 * Hard-Surface & Non-Destructive Modifier Stack Tests (Phase 4):
 * 1. BooleanModifier parametric cutters (Difference / Union / Intersect)
 * 2. BooleanModifier live Scene Object cutter + wireframe display & clean solid restore
 * 3. Live cutter TransformCommand dependency sync + Undo/Redo
 * 4. BlenderProTools BoolTool (applyQuickBoolean) + applyHardSurfacePolish
 * 5. DecimateModifier (collapse, planar, unsubdivide)
 * 6. ScrewModifier (360° Lathe + Helical Screw extrusion)
 * 7. WeightedNormalModifier after BevelModifier + geometry-budget estimateStackOutput
 *
 * Run: node --import ./tests/three-resolve-hooks.mjs tests/test_hard_surface_modifiers.mjs
 */
import assert from 'node:assert/strict';
import * as THREE from 'three';

// Install a lightweight DOM-free window EventTarget before loading modifier-stack
// so `blender:objectTransformed` and `blender:geometryChanged` run end-to-end in Node.
const eventBus = new EventTarget();
globalThis.window = Object.assign(eventBus, {
  addEventListener: eventBus.addEventListener.bind(eventBus),
  removeEventListener: eventBus.removeEventListener.bind(eventBus),
  dispatchEvent: eventBus.dispatchEvent.bind(eventBus),
  innerWidth: 1280,
  innerHeight: 720
});

const { SceneManager, TransformCommand } = await import('../js/core/scene-manager.js');
const {
  BooleanModifier,
  DecimateModifier,
  ScrewModifier,
  WeightedNormalModifier,
  BevelModifier,
  setCutterDisplayMode,
  syncBooleanCuttersInScene
} = await import('../js/core/modifiers.js');
const ModifierStack = await import('../js/core/modifier-stack.js');
const { checkBudget, estimateStackOutput, triangleCount } = await import('../js/core/geometry/geometry-budget.js');
const { encodeGeometry } = await import('../js/core/geometry/geometry-codec.js');
const { BlenderProTools } = await import('../js/core/blender-pro-keymap.js');

const failures = [];
async function test(name, fn) {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (err) {
    failures.push(name);
    console.error(`✗ ${name}\n  ${err.stack || err.message}`);
  }
}

function assertAllFinite(geom, label = 'geometry') {
  const pos = geom.attributes?.position;
  assert.ok(pos && pos.count > 0, `${label}: empty position buffer`);
  for (let i = 0; i < pos.array.length; i++) {
    assert.ok(Number.isFinite(pos.array[i]), `${label}: non-finite coordinate at index ${i}`);
  }
  const norm = geom.attributes?.normal;
  if (norm) {
    for (let i = 0; i < norm.array.length; i++) {
      assert.ok(Number.isFinite(norm.array[i]), `${label}: non-finite normal at index ${i}`);
    }
  }
}

function waitForGeometryChange(targetMesh, timeoutMs = 1500) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      window.removeEventListener('blender:geometryChanged', onEvt);
      reject(new Error('Timed out waiting for blender:geometryChanged'));
    }, timeoutMs);
    function onEvt(e) {
      const m = e?.detail?.mesh || e?.detail;
      if (m === targetMesh) {
        clearTimeout(timer);
        window.removeEventListener('blender:geometryChanged', onEvt);
        resolve(targetMesh.geometry);
      }
    }
    window.addEventListener('blender:geometryChanged', onEvt);
  });
}

// ---------------------------------------------------------------------------
// 1. BooleanModifier parametric Difference / Union / Intersect
// ---------------------------------------------------------------------------
await test('BooleanModifier: parametric Difference / Union / Intersect produce valid manifold geometry', async () => {
  const baseBox = new THREE.BoxGeometry(2, 2, 2);

  const diff = BooleanModifier.execute(baseBox, {
    operation: 'difference',
    operandType: 'primitive',
    cutterPrimitive: 'box',
    cutterSize: 1.2,
    cutterOffset: { x: 0.7, y: 0.7, z: 0.7 }
  });
  assertAllFinite(diff, 'boolean difference');
  assert.ok(diff.attributes.position.count > 36, `Expected carved faces > 36 verts, got ${diff.attributes.position.count}`);

  const union = BooleanModifier.execute(baseBox, {
    operation: 'union',
    operandType: 'primitive',
    cutterPrimitive: 'cylinder',
    cutterSize: 1.2,
    cutterOffset: { x: 1.0, y: 0, z: 0 }
  });
  assertAllFinite(union, 'boolean union');
  union.computeBoundingBox();
  assert.ok(union.boundingBox.max.x > 1.05, `Expected cylinder union to extend +X beyond 1.0, got ${union.boundingBox.max.x}`);

  const inter = BooleanModifier.execute(baseBox, {
    operation: 'intersect',
    operandType: 'primitive',
    cutterPrimitive: 'sphere',
    cutterSize: 1.2,
    cutterOffset: { x: 0, y: 0, z: 0 }
  });
  assertAllFinite(inter, 'boolean intersect');
  inter.computeBoundingBox();
  assert.ok(inter.boundingBox.max.x <= 0.85, `Expected sphere intersection radius <= 0.85, got ${inter.boundingBox.max.x}`);
});

// ---------------------------------------------------------------------------
// 2. BooleanModifier + Live Scene Object Cutter + Wireframe Display & Restore
// ---------------------------------------------------------------------------
await test('BooleanModifier: live scene cutter switches to wireframe helper and restores solid on toggle/remove', async () => {
  const scene = new THREE.Scene();
  const sm = new SceneManager(scene);
  window.sceneManager = sm;

  const origCutterMat = new THREE.MeshStandardMaterial({ color: 0x3399ff });
  const host = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), new THREE.MeshStandardMaterial({ color: 0x999999 }));
  host.name = 'HostCube';
  const cutter = new THREE.Mesh(new THREE.CylinderGeometry(0.6, 0.6, 3, 20), origCutterMat);
  cutter.name = 'DrillCutter';
  cutter.position.set(0.45, 0, 0.45);
  cutter.updateMatrixWorld(true);

  sm.addObject(host, null, true, false);
  sm.addObject(cutter, null, false, false);

  await ModifierStack.addModifier(
    host,
    'boolean',
    {
      operation: 'difference',
      operandType: 'object',
      targetId: cutter.userData.id || cutter.uuid,
      targetName: cutter.name,
      cutterDisplay: 'wire'
    },
    { sceneManager: sm }
  );

  assertAllFinite(host.geometry, 'live boolean host');
  assert.ok(host.geometry.attributes.position.count > 36, 'Live cutter should carve host cube');
  assert.equal(cutter.userData.__boolDisplayMode, 'wire', 'Cutter should enter wire display mode');
  assert.equal(cutter.material.wireframe, true, 'Cutter helper material should be wireframe');
  assert.equal(cutter.userData.__boolOrigMaterial, origCutterMat, 'Original material should be preserved');

  // Disabling modifier restores solid original material & uncut host cube
  await ModifierStack.toggleModifier(host, 0, { sceneManager: sm });
  assert.equal(cutter.userData.__boolDisplayMode, 'solid', 'Disabling boolean restores cutter solid display');
  assert.equal(cutter.material, origCutterMat, 'Original material restored when disabled');
  assert.equal(host.geometry.attributes.position.count, 24, 'Disabling boolean restores uncut cube');

  // Re-enabling switches back to wire; removing restores solid again
  await ModifierStack.toggleModifier(host, 0, { sceneManager: sm });
  assert.equal(cutter.userData.__boolDisplayMode, 'wire');
  await ModifierStack.removeModifier(host, 0, { sceneManager: sm });
  assert.equal(cutter.userData.__boolDisplayMode, 'solid');
  assert.equal(cutter.material, origCutterMat);

  setCutterDisplayMode(cutter, 'bounds');
  assert.equal(cutter.userData.__boolDisplayMode, 'bounds');
  setCutterDisplayMode(cutter, 'solid');
  syncBooleanCuttersInScene(sm);
  assert.equal(cutter.material, origCutterMat);
});

// ---------------------------------------------------------------------------
// 3. Live Cutter Transform Sync + TransformCommand Undo/Redo
// ---------------------------------------------------------------------------
await test('BooleanModifier: live cutter TransformCommand & Undo/Redo automatically re-evaluate host mesh', async () => {
  const scene = new THREE.Scene();
  const sm = new SceneManager(scene);
  window.sceneManager = sm;

  const host = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), new THREE.MeshStandardMaterial());
  host.name = 'BoolHost';
  const cutter = new THREE.Mesh(new THREE.BoxGeometry(1.2, 1.2, 1.2), new THREE.MeshStandardMaterial());
  cutter.name = 'BoolCutter';
  cutter.position.set(0.5, 0.5, 0.5);
  cutter.updateMatrixWorld(true);

  sm.addObject(host, null, true, false);
  sm.addObject(cutter, null, false, false);

  await ModifierStack.addModifier(
    host,
    'boolean',
    {
      operation: 'difference',
      operandType: 'object',
      targetId: cutter.userData.id || cutter.uuid,
      targetName: cutter.name,
      cutterDisplay: 'wire'
    },
    { sceneManager: sm }
  );

  const hasInteriorCutVert = (geom) => {
    const pos = geom.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const m = Math.max(Math.abs(pos.getX(i)), Math.abs(pos.getY(i)), Math.abs(pos.getZ(i)));
      if (m < 0.99) return true;
    }
    return false;
  };

  const cutVerts = host.geometry.attributes.position.count;
  assert.ok(cutVerts > 36 && hasInteriorCutVert(host.geometry), `Expected carved cube > 36 verts with interior notch, got ${cutVerts}`);

  // Move cutter far away via TransformCommand -> host should lose interior notch vertices cleanly
  const preState = {
    position: cutter.position.clone(),
    quaternion: cutter.quaternion.clone(),
    scale: cutter.scale.clone()
  };
  const farState = {
    position: new THREE.Vector3(6, 0, 0),
    quaternion: cutter.quaternion.clone(),
    scale: cutter.scale.clone()
  };

  const pMoveDone = waitForGeometryChange(host);
  const cmd = new TransformCommand(cutter, preState, farState);
  cmd.execute();
  sm.executeCommand(cmd);
  await pMoveDone;
  assertAllFinite(host.geometry, 'host after cutter moved away');
  const farVerts = host.geometry.attributes.position.count;
  assert.equal(hasInteriorCutVert(host.geometry), false, 'Moving cutter outside host leaves zero interior notch vertices');
  assert.ok(farVerts < cutVerts, `Expected fewer verts when uncut (${farVerts} < ${cutVerts})`);

  // Undo TransformCommand -> cutter returns to (0.5,0.5,0.5) & host re-carves automatically
  const pUndoDone = waitForGeometryChange(host);
  sm.undo();
  await pUndoDone;
  assert.equal(host.geometry.attributes.position.count, cutVerts, 'Undo restores live boolean cut');
  assert.equal(hasInteriorCutVert(host.geometry), true, 'Undo restores carved interior vertices');

  // Redo TransformCommand -> moves cutter away again & removes cut cleanly
  const pRedoDone = waitForGeometryChange(host);
  sm.redo();
  await pRedoDone;
  assert.equal(host.geometry.attributes.position.count, farVerts, 'Redo reapplies cutter move cleanly');
  assert.equal(hasInteriorCutVert(host.geometry), false, 'Redo leaves zero interior notch vertices');
});

// ---------------------------------------------------------------------------
// 4. BlenderProTools BoolTool (applyQuickBoolean) + applyHardSurfacePolish
// ---------------------------------------------------------------------------
await test('BlenderProTools: applyQuickBoolean and applyHardSurfacePolish build non-destructive stack', async () => {
  const scene = new THREE.Scene();
  const sm = new SceneManager(scene);
  window.sceneManager = sm;

  const host = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), new THREE.MeshStandardMaterial());
  host.name = 'ArmorPlate';
  const cutter = new THREE.Mesh(new THREE.BoxGeometry(1, 3, 1), new THREE.MeshStandardMaterial());
  cutter.name = 'SlotCutter';
  cutter.position.set(0.6, 0, 0);
  cutter.updateMatrixWorld(true);

  sm.addObject(cutter, null, false, false);
  sm.addObject(host, null, true, false);
  sm.select(cutter, false);
  sm.select(host, true); // activeObject is host, cutter is also selected

  const proTools = new BlenderProTools({
    engine: { updateSelectionHelper() {} },
    sceneManager: sm,
    editMode: null,
    modalTransform: null,
    modelingSuite: null
  });

  const res = await proTools.applyQuickBoolean('difference');
  assert.ok(res && res.host === host && res.cutters[0] === cutter, 'applyQuickBoolean resolved active host + cutter');
  assert.equal(cutter.userData.__boolDisplayMode, 'wire');
  assert.ok(host.geometry.attributes.position.count > 36, 'Quick Boolean difference should carve host');

  const prePolishCount = host.geometry.attributes.position.count;
  await proTools.applyHardSurfacePolish(host);
  await proTools.applyHardSurfacePolish(host); // verify idempotent (no duplicate bevel/weighted_normal)

  const types = ModifierStack.getStack(host).map((m) => m.type);
  assert.deepEqual(types, ['boolean', 'bevel', 'weighted_normal'], `Unexpected stack order: ${JSON.stringify(types)}`);
  assertAllFinite(host.geometry, 'hard-surface polished mesh');
  assert.ok(host.geometry.attributes.position.count > prePolishCount, 'Bevel should subdivide sharp edges');
});

// ---------------------------------------------------------------------------
// 5. DecimateModifier: collapse, planar, unsubdivide
// ---------------------------------------------------------------------------
await test('DecimateModifier: collapse, planar, and unsubdivide reduce triangles cleanly', async () => {
  const sphere = new THREE.SphereGeometry(1, 24, 16);
  const sphereTris = sphere.index ? sphere.index.count / 3 : sphere.attributes.position.count / 3;

  const collapsed = DecimateModifier.execute(sphere, { mode: 'collapse', ratio: 0.35 });
  assertAllFinite(collapsed, 'decimate collapse');
  const collapsedTris = Math.floor((collapsed.index ? collapsed.index.count : collapsed.attributes.position.count) / 3);
  assert.ok(collapsedTris < sphereTris * 0.55 && collapsedTris >= 4, `Expected collapsed tris < 55% of ${sphereTris}, got ${collapsedTris}`);

  const subBox = new THREE.BoxGeometry(2, 2, 2, 4, 4, 4);
  const subBoxTris = subBox.index ? subBox.index.count / 3 : subBox.attributes.position.count / 3;
  const planar = DecimateModifier.execute(subBox, { mode: 'planar', angleLimit: 5.0 });
  assertAllFinite(planar, 'decimate planar');
  const planarTris = Math.floor((planar.index ? planar.index.count : planar.attributes.position.count) / 3);
  assert.ok(planarTris < subBoxTris * 0.5, `Expected planar decimation to merge coplanar faces (< ${subBoxTris * 0.5}), got ${planarTris}`);

  const unsub = DecimateModifier.execute(sphere, { mode: 'unsubdivide', iterations: 1 });
  assertAllFinite(unsub, 'decimate unsubdivide');
  const unsubTris = Math.floor((unsub.index ? unsub.index.count : unsub.attributes.position.count) / 3);
  assert.ok(unsubTris < sphereTris && unsubTris >= 4, `Expected unsubdivide tris < ${sphereTris}, got ${unsubTris}`);
});

// ---------------------------------------------------------------------------
// 6. ScrewModifier: 360° Lathe + Helical Screw extrusion
// ---------------------------------------------------------------------------
await test('ScrewModifier: revolves 360° Lathe profiles and helical coils with valid bounds & normals', async () => {
  const profile = new THREE.PlaneGeometry(0.4, 0.8, 1, 2);
  profile.translate(0.6, 0, 0);

  const lathe = ScrewModifier.execute(profile, {
    axis: 'Y',
    angleDeg: 360,
    steps: 16,
    screwOffset: 0,
    radiusOffset: 0.4,
    iterations: 1
  });
  assertAllFinite(lathe, 'screw 360 lathe');
  assert.ok(lathe.attributes.position.count > 100, `Expected lathe mesh > 100 verts, got ${lathe.attributes.position.count}`);
  assert.ok(lathe.attributes.uv && lathe.attributes.uv.count === lathe.attributes.position.count, 'Screw should generate UVs');

  const helix = ScrewModifier.execute(profile, {
    axis: 'Y',
    angleDeg: 360,
    steps: 12,
    screwOffset: 1.5,
    radiusOffset: 0.4,
    iterations: 2,
    flipNormals: true
  });
  assertAllFinite(helix, 'helical screw');
  helix.computeBoundingBox();
  const height = helix.boundingBox.max.y - helix.boundingBox.min.y;
  assert.ok(height >= 2.8, `Expected 2 helical turns with offset 1.5 to span height >= 2.8, got ${height}`);
});

// ---------------------------------------------------------------------------
// 7. WeightedNormalModifier after BevelModifier + geometry-budget compatibility
// ---------------------------------------------------------------------------
await test('WeightedNormalModifier & geometry-budget: area-weighted bevel normals + budget check pass', async () => {
  const cube = new THREE.BoxGeometry(2, 2, 2);
  const beveled = BevelModifier.execute(cube, { width: 0.12, segments: 2 });
  const weighted = WeightedNormalModifier.execute(beveled, {
    mode: 'face_area_and_angle',
    weight: 65,
    keepSharp: true,
    thresholdDeg: 35
  });

  assertAllFinite(weighted, 'weighted normal beveled cube');
  const norm = weighted.attributes.normal;
  let checkedUnit = 0;
  for (let i = 0; i < norm.count; i++) {
    const len = Math.hypot(norm.getX(i), norm.getY(i), norm.getZ(i));
    assert.ok(Math.abs(len - 1.0) < 1e-3, `Non-unit normal length ${len} at vertex ${i}`);
    checkedUnit++;
  }
  assert.ok(checkedUnit >= 36);

  const descriptors = [
    { type: 'boolean', enabled: true, params: { operation: 'difference', operandType: 'primitive' } },
    { type: 'bevel', enabled: true, params: { width: 0.05, segments: 2 } },
    { type: 'decimate', enabled: true, params: { mode: 'collapse', ratio: 0.5 } },
    { type: 'screw', enabled: true, params: { steps: 16, iterations: 1 } },
    { type: 'weighted_normal', enabled: true, params: { mode: 'face_area_and_angle', weight: 50 } }
  ];
  const encoded = encodeGeometry(cube);
  const inTris = triangleCount(encoded);
  const est = estimateStackOutput(inTris, descriptors);
  const budget = checkBudget({ encoded, inputTriangles: inTris, descriptors, mode: 'interactive' });
  assert.ok(budget.ok, `Expected budget.ok=true, got reason=${budget.reason}`);
  assert.ok(Number.isFinite(est) && est > inTris, `Expected finite estimated triangles, got ${est}`);
});

if (failures.length > 0) {
  console.error(`\nFAILED ${failures.length} hard-surface tests: ${failures.join(', ')}`);
  process.exit(1);
}
console.log('\nAll 7 hard-surface & BoolTool tests passed!');
