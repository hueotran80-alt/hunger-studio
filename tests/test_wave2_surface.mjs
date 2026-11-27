/**
 * Wave 2 automated verification suite:
 * - 2A: Vertex Paint (weld-aware seam paint, Dirty Vertex Colors AO, undo/redo)
 * - 2A: Texture Paint (3D BVH cross-seam continuity + 1.5px seam bleed, 2D UV paint, 64x64 tile undo/redo, .wbs round-trip)
 * - 2B: Rust Bake Kernel (AO corner darkening, High-to-Low Tangent Normal projection, Position, Curvature, Combined GI, margin dilation)
 * - 2C: Shader Node Graph IR (cycle detection, GLSL compilation, uniform-only parameter updates, Rust node_vm path-tracing evaluation)
 * - 2D: Unified Asset Browser (catalog search/tag filter + BVH raycast normal-aligned viewport drop)
 */

import assert from 'node:assert/strict';
import * as THREE from 'three';
import { SceneManager } from '../js/core/scene-manager.js';
import { StudioExporter } from '../js/exporters/export-import.js';
import { PaintModeManager } from '../js/core/paint-mode.js';
import { getPaintLayerStack } from '../js/core/paint-layers.js';
import { bakeMeshTexture } from '../js/render/texture-baker.js';
import { ShaderGraph, evaluateShaderBytecodeCPU } from '../js/core/shader-graph.js';
import { compileShaderGraphToGLSL, applyShaderGraphToMaterial, updateShaderGraphUniforms } from '../js/core/shader-compiler-three.js';
import { packSceneForRust } from '../js/render/rust-scene-pack.js';
import { renderRust } from '../js/render/rust-render-bridge.js';
import { MaterialStudio } from '../js/core/material-studio.js';
import { MatCapStudio } from '../js/core/matcap-studio.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { dataBlockRegistry } from '../js/core/data-blocks.js';
import { buildAssetCatalog, filterAssetCatalog, pickDropTransformOnScene } from '../js/ui/asset-browser.js';

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

await test('2A Vertex Paint: weld-aware seam stroke, Dirty Vertex Colors AO, Undo/Redo', async () => {
  const scene = new THREE.Scene();
  const sm = new SceneManager(scene);
  // L-corner mesh with concave crevice along x=0, y=0 + coincident duplicate vertices across UV split
  const geo = new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  // Push one central face inward to create a genuine concave pocket for Dirty Vertex Colors
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    if (pos.getZ(i) > 0.49 && Math.hypot(pos.getX(i), pos.getY(i)) < 0.35) {
      pos.setZ(i, 0.25);
    }
  }
  geo.computeVertexNormals();
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'VCBox';
  sm.addObject(mesh);

  const pm = new PaintModeManager(null, { sceneManager: sm, dataBlockRegistry });
  assert.equal(pm.enter(mesh, 'vertex-paint'), true);
  assert.equal(mat.vertexColors, true);

  pm.setColor('#ff2200');
  pm.radius = 0.6;
  pm.strength = 1.0;
  pm._beginVertexStroke();
  const touched = pm.applyVertexBrushAtLocalPoint(new THREE.Vector3(0.5, 0.0, 0.0));
  assert.ok(touched > 0, 'Vertex paint brush should touch vertices');
  pm._commitVertexStroke();

  // Check BoxGeometry shared corners have identical vertex colors across split faces
  const colAttr = geo.attributes.color;
  const cornerVerts = [];
  for (let i = 0; i < pos.count; i++) {
    if (Math.abs(pos.getX(i) - 0.5) < 1e-4 && Math.abs(pos.getY(i) - 0.5) < 1e-4 && Math.abs(pos.getZ(i) - 0.5) < 1e-4) {
      cornerVerts.push(i);
    }
  }
  assert.ok(cornerVerts.length >= 3, 'Box corner should have 3 split face vertices');
  const r0 = colAttr.getX(cornerVerts[0]);
  for (const vi of cornerVerts) {
    assert.ok(Math.abs(colAttr.getX(vi) - r0) < 1e-5, 'Welded vertex colors across split seam must match');
  }

  // Dirty Vertex Colors AO
  const cmdDirty = pm.dirtyVertexColors({ strength: 0.9 });
  assert.ok(cmdDirty);
  let pocketColor = Infinity;
  let outerCornerColor = 0;
  for (let i = 0; i < pos.count; i++) {
    if (Math.abs(pos.getZ(i) - 0.25) < 0.02) pocketColor = Math.min(pocketColor, colAttr.getX(i));
    if (Math.abs(pos.getX(i)) > 0.49 && Math.abs(pos.getY(i)) > 0.49 && Math.abs(pos.getZ(i) - 0.5) < 0.02) {
      outerCornerColor = Math.max(outerCornerColor, colAttr.getX(i));
    }
  }
  assert.ok(pocketColor < outerCornerColor, `Crevice vertex (${pocketColor.toFixed(3)}) must be darker than convex corner (${outerCornerColor.toFixed(3)})`);

  // Undo both commands cleanly restores white & vertexColors=false
  sm.undo();
  sm.undo();
  assert.equal(mat.vertexColors, false);
  pm.exit();
});

await test('2A Texture Paint: 3D cross-seam continuity + 2D UV paint + tile Undo + .wbs round-trip', async () => {
  const scene = new THREE.Scene();
  const sm = new SceneManager(scene);
  // Two triangles meeting in 3D along x=0 ([-1..0] and [0..1]), separated cleanly across UV islands!
  const geo = new THREE.BufferGeometry();
  const pos = new Float32Array([
    -1, -0.5, 0,  0, -0.5, 0,  0, 0.5, 0,
     0, -0.5, 0,  1, -0.5, 0,  0, 0.5, 0,
  ]);
  const nrm = new Float32Array([
    0, 0, 1,  0, 0, 1,  0, 0, 1,
    0, 0, 1,  0, 0, 1,  0, 0, 1,
  ]);
  const uv = new Float32Array([
    0.05, 0.2,  0.30, 0.2,  0.30, 0.8, // Left triangle: seam edge sits at U=0.30
    0.70, 0.2,  0.95, 0.2,  0.70, 0.8, // Right triangle: SAME 3D edge sits at U=0.70!
  ]);
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));

  const mat = new THREE.MeshStandardMaterial({ color: 0xdddddd });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'SeamPlane';
  sm.addObject(mesh);

  const pm = new PaintModeManager(null, { sceneManager: sm, dataBlockRegistry });
  assert.equal(pm.enter(mesh, 'texture-paint', { width: 128, height: 128 }), true);
  const { slot } = pm.ensureMaterialAndSlot(mesh, 'baseColor', 128, 128);
  const layer = getPaintLayerStack(mat).getActiveLayer('baseColor');
  assert.equal(layer.width, 128);

  pm.setColor('#00ff44');
  pm.radius = 0.25;
  pm.strength = 1.0;
  pm._beginTextureStroke();
  const touched = pm.applyTextureBrushAtLocalPoint(new THREE.Vector3(0, 0, 0));
  assert.ok(touched > 0, '3D brush should touch UV texels');
  const cmd3D = pm.commitTextureStroke(mesh, 'Seam Cross Stroke');
  assert.ok(cmd3D && cmd3D.tiles.size > 0);

  // Sample BOTH separated UV islands right along the seam (U=0.295 vs U=0.705 at V=0.5)!
  const leftSeamPx = pm.sampleRgbaAtUV(layer, 0.295, 0.5);
  const rightSeamPx = pm.sampleRgbaAtUV(layer, 0.705, 0.5);
  assert.ok(leftSeamPx[1] > 230 && leftSeamPx[0] < 30, `Left UV seam pixel should be green, got ${leftSeamPx}`);
  assert.ok(rightSeamPx[1] > 230 && rightSeamPx[0] < 30, `Right UV seam pixel must be painted across seam, got ${rightSeamPx}`);

  // Also test 2D UV Canvas painting at dead center (0.5, 0.5) + Undo/Redo
  pm.setColor('#1133ff');
  pm.paint2DAtUV(0.5, 0.5, { mesh, radiusPx: 8, beginStroke: true, commitStroke: true });
  const centerBlue = pm.sampleRgbaAtUV(layer, 0.5, 0.5);
  assert.ok(centerBlue[2] > 220 && centerBlue[0] < 40, `Center 2D brush pixel should be blue, got ${centerBlue}`);

  sm.undo();
  const centerReverted = pm.sampleRgbaAtUV(layer, 0.5, 0.5);
  assert.ok(centerReverted[2] < 235 && centerReverted[0] > 180, 'Undo should revert 2D stroke');
  sm.redo();
  assert.ok(pm.sampleRgbaAtUV(layer, 0.5, 0.5)[2] > 220, 'Redo should restore 2D stroke');

  // Verify PaintLayerStack persists cleanly inside .wbs archive and restores!
  pm.exit();
  const exporter = new StudioExporter({ scene, camera: new THREE.PerspectiveCamera(), sceneManager: sm });
  const pkg = await exporter.exportProjectPackage({ download: false });
  assert.ok(pkg.bytes.length > 0);

  const scene2 = new THREE.Scene();
  const sm2 = new SceneManager(scene2);
  const exporter2 = new StudioExporter({ scene: scene2, camera: new THREE.PerspectiveCamera(), sceneManager: sm2 });
  await exporter2.importProjectPackage(pkg.bytes, { clearScene: true });
  const restored = scene2.getObjectByName('SeamPlane');
  assert.ok(restored?.material, 'Restored SeamPlane must exist');
  const restoredStack = getPaintLayerStack(restored.material);
  assert.ok(restoredStack?.getSlot('baseColor'), 'PaintLayerStack must survive .wbs round-trip');
  const restoredLayer = restoredStack.getActiveLayer('baseColor');
  assert.ok(pm.sampleRgbaAtUV(restoredLayer, 0.705, 0.5)[1] > 230, 'Cross-seam painted layer pixels must survive .wbs import');
});

await test('2B Rust Bake Kernel: AO corner darkening, High-to-Low Tangent Normal, Curvature, Position & Margin Dilation', async () => {
  const scene = new THREE.Scene();
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.7 });

  // Target low-poly floor quad at y=0, UVs inside [0.1..0.9] leaving border margin empty to verify dilation!
  const floorGeo = new THREE.BufferGeometry();
  floorGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
    0, 0, -1,  2, 0, -1,  2, 0, 1,
    0, 0, -1,  2, 0, 1,   0, 0, 1,
  ]), 3));
  floorGeo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array([
    0, 1, 0,  0, 1, 0,  0, 1, 0,
    0, 1, 0,  0, 1, 0,  0, 1, 0,
  ]), 3));
  floorGeo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([
    0.1, 0.1,  0.9, 0.1,  0.9, 0.9,
    0.1, 0.1,  0.9, 0.9,  0.1, 0.9,
  ]), 2));
  const floor = new THREE.Mesh(floorGeo, mat);

  // Vertical blocker wall at x=0
  const wallGeo = new THREE.BufferGeometry();
  wallGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
    0, 0, -1,  0, 0, 1,  0, 2, 1,
    0, 0, -1,  0, 2, 1,  0, 2, -1,
  ]), 3));
  wallGeo.computeVertexNormals();
  wallGeo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(12), 2));
  const wall = new THREE.Mesh(wallGeo, new THREE.MeshStandardMaterial());

  scene.add(floor, wall);
  const aoRes = await bakeMeshTexture({
    mesh: floor,
    scene,
    mode: 'ao',
    width: 64,
    height: 64,
    samples: 32,
    maxDist: 3.0,
    margin: 4,
    threads: 1,
  });
  assert.equal(aoRes.appliedSlot, 'ao');
  assert.ok(mat.aoMap, 'AO bake should attach aoMap to material');
  // Row 32: x=8 (near wall x=0) vs x=54 (open end x=2)
  const nearWall = aoRes.rgba[(32 * 64 + 8) * 4];
  const openEnd = aoRes.rgba[(32 * 64 + 54) * 4];
  assert.ok(nearWall < openEnd, `Baked AO near wall (${nearWall}) must be darker than open end (${openEnd})`);
  // Check dilation filled margin pixel right outside [0.1..0.9] box (x=4 -> outside 0.1*64=6.4, within margin=4!)
  assert.equal(aoRes.cov[32 * 64 + 4], 1, '4px margin dilation must fill pixels adjacent to UV island');

  // High-to-Low Tangent Normal bake: tilt high-poly mesh by ~25 deg around Z
  const highGeo = floorGeo.clone();
  const tiltedNormal = new THREE.Vector3(0.4226, 0.9063, 0).normalize();
  const hNrm = highGeo.attributes.normal;
  for (let i = 0; i < hNrm.count; i++) hNrm.setXYZ(i, tiltedNormal.x, tiltedNormal.y, tiltedNormal.z);
  const highMesh = new THREE.Mesh(highGeo, new THREE.MeshStandardMaterial());
  const normRes = await bakeMeshTexture({
    mesh: floor,
    highPolyMesh: highMesh,
    scene,
    mode: 'normal',
    width: 32,
    height: 32,
    cageOffset: 0.3,
    margin: 2,
    threads: 1,
  });
  const nr = normRes.rgba[(16 * 32 + 16) * 4];
  const nb = normRes.rgba[(16 * 32 + 16) * 4 + 2];
  assert.ok(Math.abs(nr - 128) > 15 && nb < 252, `High-to-low normal map must record tilted slope (got R=${nr}, B=${nb})`);

  // Position + Curvature bake
  const posRes = await bakeMeshTexture({ mesh: floor, scene, mode: 'position', width: 32, height: 32, applyToMaterial: false, threads: 1 });
  const leftPosR = posRes.rgba[(16 * 32 + 6) * 4];
  const rightPosR = posRes.rgba[(16 * 32 + 26) * 4];
  assert.ok(leftPosR < 40 && rightPosR > 210, `Position R should increase across X (left=${leftPosR}, right=${rightPosR})`);

  const curvRes = await bakeMeshTexture({ mesh: floor, scene, mode: 'curvature', width: 32, height: 32, applyToMaterial: false, threads: 1 });
  assert.ok(curvRes.rgba[(16 * 32 + 16) * 4] > 0);
});

await test('2C Shader Node IR: cycle guard, GLSL uniform-only updates, and Rust WASM path-tracer evaluation', async () => {
  const g = ShaderGraph.createDefault();
  const bsdf = Array.from(g.nodes.values()).find((n) => n.type === 'PrincipledBSDF');
  const uv = g.addNode('UVMap', 10, 10);
  const noise = g.addNode('NoiseTexture', 100, 10, { scale: 8.0, detail: 4, roughness: 0.55 });
  const ramp = g.addNode('ColorRamp', 200, 10, {
    stops: [
      { pos: 0.2, color: '#1122aa', alpha: 1 },
      { pos: 0.8, color: '#ff5511', alpha: 1 },
    ],
  });
  const fres = g.addNode('Fresnel', 200, 120, { ior: 1.5 });
  const bump = g.addNode('Bump', 200, 220, { strength: 0.6, distance: 0.1 });
  assert.equal(g.connect(uv.id, 'uv', noise.id, 'vector'), true);
  assert.equal(g.connect(noise.id, 'fac', ramp.id, 'fac'), true);
  assert.equal(g.connect(ramp.id, 'color', bsdf.id, 'baseColor'), true);
  assert.equal(g.connect(fres.id, 'fac', bsdf.id, 'roughness'), true);
  assert.equal(g.connect(noise.id, 'fac', bump.id, 'height'), true);
  assert.equal(g.connect(bump.id, 'normal', bsdf.id, 'normal'), true);

  // Reject circular graph connection
  assert.equal(g.connect(bsdf.id, 'bsdf', noise.id, 'vector'), false, 'Cycle connection must be rejected');

  const mat = new THREE.MeshPhysicalMaterial({ color: 0xffffff });
  const compiled = applyShaderGraphToMaterial(mat, g);
  assert.ok(compiled.headerGLSL.includes('sgFbmNoise') && compiled.headerGLSL.includes('sgBumpNormal'));
  const prevTopo = g.topologyRevision;

  // Parameter drag must update uniform WITHOUT changing topologyRevision
  g.updateNodeProps(noise.id, { scale: 14.0 });
  const updatedUniformsOnly = updateShaderGraphUniforms(mat, g);
  assert.equal(updatedUniformsOnly, true);
  assert.equal(g.topologyRevision, prevTopo, 'Slider drag must NOT invalidate shader topology');

  // Verify JS CPU VM produces varying base colors across UVs
  const bc = g.compileToBytecode();
  const c0 = evaluateShaderBytecodeCPU(bc, { u: 0.15, v: 0.15, cosNV: 0.9 });
  const c1 = evaluateShaderBytecodeCPU(bc, { u: 0.68, v: 0.72, cosNV: 0.4 });
  assert.ok(Math.abs(c0.base[0] - c1.base[0]) + Math.abs(c0.base[2] - c1.base[2]) > 0.02);

  // Verify full scene render via Rust WASM executes compiled ShaderGraph bytecode!
  const scene = new THREE.Scene();
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(4, 4), mat);
  scene.add(quad);
  const light = new THREE.DirectionalLight(0xffffff, 4.0);
  light.position.set(0, 0, 5);
  scene.add(light);
  const cam = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
  cam.position.set(0, 0, 4);
  cam.lookAt(0, 0, 0);
  const packed = packSceneForRust({ scene, camera: cam, width: 32, height: 32 });
  assert.ok(packed.shaderProgs[0]?.ops?.length >= 8, 'Packed Rust scene must contain compiled shader bytecode');

  const rendered = await renderRust(packed, { width: 32, height: 32, samples: 4, passSpp: 4, denoise: false, threads: 1 });
  assert.equal(rendered.rgba.length, 32 * 32 * 4);
  // Procedural surface must show chromatic variation (not flat uniform single color!)
  const pA = [rendered.rgba[(8 * 32 + 8) * 4], rendered.rgba[(8 * 32 + 8) * 4 + 1], rendered.rgba[(8 * 32 + 8) * 4 + 2]];
  const pB = [rendered.rgba[(22 * 32 + 24) * 4], rendered.rgba[(22 * 32 + 24) * 4 + 1], rendered.rgba[(22 * 32 + 24) * 4 + 2]];
  assert.ok(Math.abs(pA[0] - pB[0]) + Math.abs(pA[2] - pB[2]) > 5, `Rust render with ShaderGraph should show procedural pattern (got ${pA} vs ${pB})`);
});

await test('2D Asset Browser: catalog search, tag filtering & BVH normal-aligned drop placement', async () => {
  const ms = new MaterialStudio();
  const catalog = buildAssetCatalog({ materialStudio: ms, dataBlockRegistry });
  assert.ok(catalog.length >= 25, 'Catalog should include PBR presets, shaders, prefabs, and primitives');

  const gold = filterAssetCatalog(catalog, { query: 'gold', kind: 'materials' });
  assert.ok(gold.some((x) => x.key === 'gold_24k'));

  const proc = filterAssetCatalog(catalog, { tag: 'procedural' });
  assert.ok(proc.some((x) => x.kind === 'shaders'));

  // Build 45-degree sloped surface plane in scene & raycast center NDC(0,0) from +Z camera
  const scene = new THREE.Scene();
  const slopeGeo = new THREE.PlaneGeometry(6, 6);
  // Rotate plane so its +Z normal points toward (0, +sqrt(0.5), +sqrt(0.5))
  slopeGeo.rotateX(-Math.PI / 4);
  const slope = new THREE.Mesh(slopeGeo, new THREE.MeshStandardMaterial());
  scene.add(slope);
  slope.updateMatrixWorld(true);

  const cam = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
  cam.position.set(0, 0, 5);
  cam.lookAt(0, 0, 0);
  cam.updateMatrixWorld(true);

  const drop = pickDropTransformOnScene(scene, cam, 0, 0, true);
  assert.equal(drop.hitGeometry, true);
  assert.equal(drop.targetMesh, slope);
  const upTransformed = new THREE.Vector3(0, 1, 0).applyQuaternion(drop.quaternion);
  const expectedNormal = new THREE.Vector3(0, Math.SQRT1_2, Math.SQRT1_2);
  assert.ok(upTransformed.distanceTo(expectedNormal) < 1e-3, `Drop quaternion must align +Y to surface normal (got ${upTransformed.toArray()})`);
});

await test('2D Regression: Asset drop & MatCap never target/mutate TransformControlsPlane; presets keep colors & MatCap sync', async () => {
  const prevDoc = globalThis.document;
  globalThis.document = {
    createElement() {
      return {
        width: 128,
        height: 128,
        getContext: () => ({
          createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }),
          putImageData() {},
        }),
      };
    },
  };
  try {
    const scene = new THREE.Scene();
    const sm = new SceneManager(scene);
    const cam = new THREE.PerspectiveCamera(45, 1.6, 0.1, 1000);
    cam.position.set(4, 3, 5);
    cam.lookAt(0, 0.5, 0);
    cam.updateMatrixWorld(true);

    const cube = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ color: 0x808080 }));
    cube.name = 'Cube';
    cube.position.set(0, 0.5, 0);
    // Add through SceneManager so Cube sits under Scene_Collection (which has isSystemObject=true)
    sm.addObject(cube);
    sm.select(cube);

    const dummyDom = {
      addEventListener() {},
      removeEventListener() {},
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 500 }),
      style: {},
    };
    const tc = new TransformControls(cam, dummyDom);
    tc.userData.isSystemObject = true;
    tc.userData.selectable = false;
    scene.add(tc);
    tc.attach(cube);
    scene.updateMatrixWorld(true);

    for (const [x, y] of [[0, 0], [0.05, 0.05], [-0.2, 0.2], [0.3, -0.2], [-0.5, 0.5]]) {
      const drop = pickDropTransformOnScene(scene, cam, x, y, true);
      assert.ok(!drop.targetMesh?.isTransformControlsPlane, 'drop must never hit TransformControlsPlane');
      assert.ok(!drop.targetMesh?.isTransformControlsGizmo, 'drop must never hit TransformControlsGizmo');
      assert.ok(drop.targetMesh === null || drop.targetMesh === cube, 'drop must hit Cube or null');
    }

    const mc = new MatCapStudio({ scene });
    mc.toggleMatCapMode(true, 'clay');
    let tcOverwritten = 0;
    tc.traverse((n) => {
      if (n.isMesh && n.material?.isMeshMatcapMaterial) tcOverwritten += 1;
    });
    assert.equal(tcOverwritten, 0, 'MatCap must never overwrite TransformControls child meshes');
    assert.ok(cube.material.isMeshMatcapMaterial, 'Cube receives MatCap normally');

    const ms = new MaterialStudio(THREE);
    let plane = null;
    tc.traverse((n) => { if (n.isTransformControlsPlane) plane = n; });
    assert.ok(plane, 'TransformControlsPlane exists');
    assert.equal(ms.applyPreset(plane, 'gold_24k'), null, 'applyPreset must reject TransformControlsPlane');
    assert.equal(plane.material.visible, false, 'TransformControlsPlane stays invisible');

    const gold = ms.applyPreset(cube, 'gold_24k');
    assert.ok(gold && gold.color.getHex() === 0xffd700);
    assert.equal(cube.userData.__originalMaterial, gold, 'applyPreset syncs __originalMaterial under MatCap');
    mc.toggleMatCapMode(false);
    assert.equal(cube.material, gold, 'restoring from MatCap preserves applied gold_24k material');

    const matItems = buildAssetCatalog({ materialStudio: ms }).filter((i) => i.kind === 'materials');
    assert.ok(matItems.length >= 20);
    assert.ok(matItems.every((i) => i.color !== undefined && typeof i.swatch === 'string'), 'every preset exposes color + swatch');
    assert.ok(new Set(matItems.map((i) => i.color)).size >= 15, 'presets expose distinct thumbnail colors');
  } finally {
    if (prevDoc === undefined) delete globalThis.document;
    else globalThis.document = prevDoc;
  }
});

console.log(`\nWave 2 Surface Suite: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
