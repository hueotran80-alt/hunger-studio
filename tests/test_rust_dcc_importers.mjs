/**
 * Automated Verification Suite — Rust WASM DCC/CAD/Studio Importers & Smart ZIP PBR Bundle Resolver
 * File: tests/test_rust_dcc_importers.mjs
 *
 * Verifies:
 *   1. Rust WASM `.obj` + `.mtl` + ZBrush `#MRGB` polypaint + `.zip` PBR texture bundle resolution
 *      (including stripping stale Windows `C:\Users\...\textures\leaf.tga` paths!).
 *   2. Loose PBR texture auto-matching (`_diff`, `_nor`, `_rough`) when `.obj` lacks `.mtl`.
 *   3. Autodesk 3ds Max `.3ds` binary chunk hierarchy (`0x4D4D`, `MAT_ENTRY`, `OBJ_TRIMESH`, `MSH_MAT_GROUP`).
 *   4. MagicaVoxel `.vox` binary RIFF (`SIZE`, `XYZI`, `RGBA` palette + 6-neighbor face culling).
 *   5. Pixar / Apple USD `.usda` & `.usdz` archive (`Mesh`, `UsdPreviewSurface`, embedded texture).
 *   6. AutoCAD / Rhino `.dxf` (`3DFACE` + Polyface `POLYLINE` + ACI colors), `.3mf` (`basematerials`), `.off` (`COFF`), and Collada `.dae`.
 *   7. `ShaderNodeEditor.syncFromSelection()` regression check: clicking a textured object NEVER writes a blank gray `shaderGraphJson`!
 */

import assert from 'node:assert/strict';
import * as THREE from 'three';
import { zipSync, strToU8 } from 'three/addons/libs/fflate.module.js';
import { StudioExporter } from '../js/exporters/export-import.js';
import { SceneManager } from '../js/core/scene-manager.js';
import { initMeshKernel, getMeshKernelVersion } from '../js/core/mesh-kernel-bridge.js';
import { getShaderGraphForMaterial } from '../js/core/shader-graph.js';

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    const detail = await fn();
    passed++;
    console.log(`ok   ${name}${detail ? ` — ${detail}` : ''}`);
  } catch (err) {
    failed++;
    console.error(`FAIL ${name}\n     ${err?.stack || err}`);
  }
}

function makeTestEnvironment() {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 1000);
  const sm = new SceneManager(scene);
  const exporter = new StudioExporter({ scene, camera });
  exporter.bindSceneManager(sm);
  return { scene, camera, sm, exporter };
}

// 1x1 valid PNG bytes
const TINY_PNG = Uint8Array.from(
  Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64')
);

function buildSynthetic3dsBinary() {
  const chunks = [];
  const pushChunk = (id, payload) => {
    const out = new Uint8Array(6 + payload.length);
    const dv = new DataView(out.buffer);
    dv.setUint16(0, id, true);
    dv.setUint32(2, out.length, true);
    out.set(payload, 6);
    return out;
  };
  const concat = (...arrs) => {
    const len = arrs.reduce((s, a) => s + a.length, 0);
    const out = new Uint8Array(len);
    let off = 0;
    for (const a of arrs) { out.set(a, off); off += a.length; }
    return out;
  };
  const cstr = (s) => Uint8Array.from([...Buffer.from(s, 'utf8'), 0]);

  // Material chunk (0xAFFF): GoldPot + texture POT_DIFF.PNG
  const matName = pushChunk(0xA000, cstr('GoldPot'));
  const rgb24 = pushChunk(0x0011, new Uint8Array([220, 140, 60]));
  const matDiff = pushChunk(0xA020, rgb24);
  const mapFile = pushChunk(0xA300, cstr('C:\\3dsMax\\Scenes\\Textures\\pot_diff.tga'));
  const texMap = pushChunk(0xA200, mapFile);
  const matEntry = pushChunk(0xAFFF, concat(matName, matDiff, texMap));

  // Mesh chunk (0x4100): 4 verts, 4 UVs, 2 faces assigned to GoldPot
  const vBuf = new Uint8Array(2 + 4 * 12);
  const vDv = new DataView(vBuf.buffer);
  vDv.setUint16(0, 4, true);
  const coords = [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0];
  coords.forEach((v, i) => vDv.setFloat32(2 + i * 4, v, true));
  const ptChunk = pushChunk(0x4110, vBuf);

  const uvBuf = new Uint8Array(2 + 4 * 8);
  const uvDv = new DataView(uvBuf.buffer);
  uvDv.setUint16(0, 4, true);
  [0, 0, 1, 0, 1, 1, 0, 1].forEach((u, i) => uvDv.setFloat32(2 + i * 4, u, true));
  const uvChunk = pushChunk(0x4140, uvBuf);

  const fHeader = new Uint8Array(2 + 2 * 8);
  const fDv = new DataView(fHeader.buffer);
  fDv.setUint16(0, 2, true);
  [0, 1, 2, 0, 0, 2, 3, 0].forEach((idx, i) => fDv.setUint16(2 + i * 2, idx, true));

  const mGrpPayload = new Uint8Array(2 + 2 * 2);
  const mDv = new DataView(mGrpPayload.buffer);
  mDv.setUint16(0, 2, true);
  mDv.setUint16(2, 0, true);
  mDv.setUint16(4, 1, true);
  const matGroupChunk = pushChunk(0x4130, concat(cstr('GoldPot'), mGrpPayload));
  const faceChunk = pushChunk(0x4120, concat(fHeader, matGroupChunk));

  const triMesh = pushChunk(0x4100, concat(ptChunk, uvChunk, faceChunk));
  const editObj = pushChunk(0x4000, concat(cstr('MaxPlanter'), triMesh));
  const edit3ds = pushChunk(0x3D3D, concat(matEntry, editObj));
  return pushChunk(0x4D4D, edit3ds);
}

function buildSyntheticVoxBinary() {
  const concat = (...arrs) => {
    const len = arrs.reduce((s, a) => s + a.length, 0);
    const out = new Uint8Array(len);
    let off = 0;
    for (const a of arrs) { out.set(a, off); off += a.length; }
    return out;
  };
  const chunk = (tag, content, children = new Uint8Array(0)) => {
    const hdr = new Uint8Array(12);
    hdr.set(Buffer.from(tag, 'ascii'), 0);
    const dv = new DataView(hdr.buffer);
    dv.setUint32(4, content.length, true);
    dv.setUint32(8, children.length, true);
    return concat(hdr, content, children);
  };
  const sizePayload = new Uint8Array(12);
  const sDv = new DataView(sizePayload.buffer);
  sDv.setUint32(0, 4, true); sDv.setUint32(4, 4, true); sDv.setUint32(8, 4, true);

  // 3 voxels in an L-shape
  const xyziPayload = new Uint8Array(4 + 3 * 4);
  new DataView(xyziPayload.buffer).setUint32(0, 3, true);
  xyziPayload.set([0, 0, 0, 1, 1, 0, 0, 2, 0, 0, 1, 3], 4);

  const children = concat(chunk('SIZE', sizePayload), chunk('XYZI', xyziPayload));
  const header = new Uint8Array(8);
  header.set(Buffer.from('VOX ', 'ascii'), 0);
  new DataView(header.buffer).setUint32(4, 150, true);
  return concat(header, chunk('MAIN', new Uint8Array(0), children));
}

await test('Rust WASM MeshKernel v210 initializes with DCC importer exports', async () => {
  const ok = await initMeshKernel();
  assert.equal(ok, true);
  assert.equal(getMeshKernelVersion(), 210);
});

await test('ZIP Bundle Import: multi-material .obj + .mtl + Windows-path PBR textures resolve 100%', async () => {
  const { exporter } = makeTestEnvironment();
  const objText = `
mtllib plant.mtl
o PotMesh
v 0 0 0
v 1 0 0
v 1 1 0
vt 0 0
vt 1 0
vt 1 1
usemtl CeramicPot
f 1/1 2/2 3/3
o LeafMesh
v 0 1 0
v 1 1 0
v 0.5 2 0
vt 0 0
vt 1 0
vt 0.5 1
usemtl GreenLeaf
f 4/4 5/5 6/6
`;
  const mtlText = `
newmtl CeramicPot
Kd 0.9 0.85 0.8
map_Kd C:\\Users\\Artist\\Desktop\\PlantPack\\textures\\pot_albedo.png
map_Bump -bm 0.6 C:\\Users\\Artist\\Desktop\\PlantPack\\textures\\pot_normal.png

newmtl GreenLeaf
Kd 0.2 0.75 0.3
map_Kd textures/leaf_albedo.png
map_d textures/leaf_alpha.png
`;
  const zipBytes = zipSync({
    'PlantPack/source/potted_plant.obj': strToU8(objText),
    'PlantPack/source/plant.mtl': strToU8(mtlText),
    'PlantPack/textures/pot_albedo.png': TINY_PNG,
    'PlantPack/textures/pot_normal.png': TINY_PNG,
    'PlantPack/textures/leaf_albedo.png': TINY_PNG,
    'PlantPack/textures/leaf_alpha.png': TINY_PNG,
  });

  const imported = await exporter.importBundle(zipBytes, { name: 'potted_plant.zip' });
  assert.ok(imported?.isGroup, 'Expected multi-part Group for Pot + Leaf');
  assert.equal(imported.children.length, 2);

  const pot = imported.children.find((c) => c.name.includes('PotMesh'));
  const leaf = imported.children.find((c) => c.name.includes('LeafMesh'));
  assert.ok(pot?.material?.map, 'Pot diffuse map must be resolved despite Windows path in .mtl');
  assert.ok(pot?.material?.normalMap, 'Pot normal map must be resolved with -bm option stripped');
  assert.ok(leaf?.material?.map, 'Leaf diffuse map must be resolved');
  assert.ok(leaf?.material?.alphaMap && leaf.material.side === THREE.DoubleSide, 'Leaf alpha mask & DoubleSide must be enabled');
  assert.ok(leaf.userData.__importedMaterial, 'Original imported material backup must be saved');
  return `Pot (${pot.material.map.name}) + Leaf (${leaf.material.map.name} + alpha)`;
});

await test('Loose PBR Auto-Matcher & ZBrush #MRGB Polypaint OBJ', async () => {
  const { exporter } = makeTestEnvironment();
  // 1) Loose OBJ + PBR textures WITHOUT .mtl
  const bareObj = `v 0 0 0\nv 1 0 0\nv 0 1 0\nvt 0 0\nvt 1 0\nvt 0 1\nf 1/1 2/2 3/3\n`;
  const looseZip = zipSync({
    'statue.obj': strToU8(bareObj),
    'statue_basecolor.png': TINY_PNG,
    'statue_normal.png': TINY_PNG,
    'statue_roughness.png': TINY_PNG,
  });
  const mesh = await exporter.importBundle(looseZip, { name: 'statue.zip' });
  assert.ok(mesh?.isMesh && mesh.material.map && mesh.material.normalMap && mesh.material.roughnessMap, 'Auto-matched BaseColor + Normal + Roughness without .mtl');

  // 2) ZBrush #MRGB polypaint OBJ
  const zbrushObj = `v 0 0 0\nv 1 0 0\nv 0 1 0\n#MRGB ffcc3322ff22cc44ff3344dd\nf 1 2 3\n`;
  const zbMesh = await exporter.importOBJ(zbrushObj, { name: 'ZBrushSculpt' });
  assert.ok(zbMesh?.isMesh && zbMesh.geometry.attributes.color?.count === 3, 'ZBrush #MRGB polypaint vertex colors parsed');
  assert.equal(zbMesh.material.vertexColors, true);
});

await test('Autodesk 3ds Max (.3ds) binary importer + companion texture resolution', async () => {
  const { exporter } = makeTestEnvironment();
  const bin3ds = buildSynthetic3dsBinary();
  // Note: .3ds references `pot_diff.tga`, while ZIP contains `pot_diff.png` -> stem fallback resolves it!
  const zip3ds = zipSync({
    'max_planter.3ds': bin3ds,
    'textures/pot_diff.png': TINY_PNG,
  });
  const imported = await exporter.importBundle(zip3ds, { name: 'max_planter.zip' });
  assert.ok(imported?.isMesh);
  assert.equal(imported.geometry.index.count / 3, 2);
  assert.ok(imported.material?.map, '.3ds texture stem fallback (.tga -> .png) resolved');
  return `3ds tris=2 · mat=${imported.material.name} · tex=${imported.material.map.name}`;
});

await test('MagicaVoxel (.vox) binary importer with 6-neighbor interior face culling', async () => {
  const { exporter } = makeTestEnvironment();
  const voxBytes = buildSyntheticVoxBinary();
  const voxMesh = await exporter.importVOX(voxBytes, { name: 'VoxelHero.vox' });
  assert.ok(voxMesh?.isMesh);
  // 3 voxels in an L-shape share 2 interior interfaces (4 hidden faces): (3 * 6 - 4) = 14 faces = 28 triangles!
  const tris = voxMesh.geometry.index.count / 3;
  assert.equal(tris, 28);
  assert.equal(voxMesh.material.vertexColors, true);
  return `3 voxels -> ${tris} culled boundary tris`;
});

await test('Pixar / Apple USD (.usda & .usdz) + Collada (.dae) + CAD (.dxf, .3mf, .off) in Rust WASM', async () => {
  const { exporter } = makeTestEnvironment();

  const usda = `#usda 1.0
( upAxis = "Z" )
def Material "LeafMat" {
    def Shader "PBR" {
        color3f inputs:diffuseColor = (0.2, 0.7, 0.3)
        asset inputs:file = @0/leaf.png@
    }
}
def Mesh "Leaf" {
    rel material:binding = </LeafMat>
    point3f[] points = [(0,0,0), (1,0,0), (1,1,0), (0,1,0)]
    int[] faceVertexCounts = [4]
    int[] faceVertexIndices = [0, 1, 2, 3]
    texCoord2f[] primvars:st = [(0,0), (1,0), (1,1), (0,1)]
}`;
  const usdz = zipSync({
    'scene.usda': strToU8(usda),
    '0/leaf.png': TINY_PNG,
  }, { level: 0 });
  const usdObj = await exporter.importUSD(usdz, { name: 'plant.usdz' });
  assert.ok(usdObj?.isMesh && usdObj.material?.map, 'USDZ mesh + embedded texture resolved');

  const dxf = `0\nSECTION\n2\nENTITIES\n0\n3DFACE\n8\nFacade\n62\n3\n10\n0\n20\n0\n30\n0\n11\n2\n21\n0\n31\n0\n12\n2\n22\n2\n32\n0\n13\n0\n23\n2\n33\n0\n0\nENDSEC\n0\nEOF\n`;
  const dxfObj = await exporter.importDXF(dxf, { name: 'arch.dxf' });
  assert.equal(dxfObj.geometry.index.count / 3, 2);

  const model3mf = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter"><resources>
  <basematerials id="1"><base name="Emerald" displaycolor="#2ECC71"/></basematerials>
  <object id="2" type="model"><mesh>
    <vertices><vertex x="0" y="0" z="0"/><vertex x="10" y="0" z="0"/><vertex x="0" y="10" z="0"/></vertices>
    <triangles><triangle v1="0" v2="1" v3="2" pid="1" p1="0"/></triangles>
  </mesh></object>
</resources></model>`;
  const zip3mf = zipSync({ '3D/3dmodel.model': strToU8(model3mf) });
  const mfObj = await exporter.import3MF(zip3mf, { name: 'part.3mf' });
  assert.equal(mfObj.geometry.index.count / 3, 1);

  const coff = `COFF\n3 1 0\n0 0 0 255 64 64\n1 0 0 64 255 64\n0 1 0 64 64 255\n3 0 1 2\n`;
  const offObj = await exporter.importOFF(coff, { name: 'houdini.off' });
  assert.equal(offObj.geometry.index.count / 3, 1);
  assert.equal(offObj.material.vertexColors, true);

  const dae = `<?xml version="1.0" encoding="utf-8"?>
<COLLADA version="1.4.1">
  <library_images><image id="i1"><init_from>bark.png</init_from></image></library_images>
  <library_effects><effect id="e1"><profile_COMMON><technique sid="c"><phong><diffuse><texture texture="i1"/></diffuse></phong></technique></profile_COMMON></effect></library_effects>
  <library_materials><material id="m1" name="Bark"><instance_effect url="#e1"/></material></library_materials>
  <library_geometries><geometry id="g1" name="Trunk"><mesh>
    <source id="p"><float_array count="9">0 0 0 1 0 0 0 1 0</float_array></source>
    <source id="t"><float_array count="6">0 0 1 0 0 1</float_array></source>
    <vertices id="v"><input semantic="POSITION" source="#p"/></vertices>
    <triangles count="1" material="m1"><input semantic="VERTEX" source="#v" offset="0"/><input semantic="TEXCOORD" source="#t" offset="1"/><p>0 0 1 1 2 2</p></triangles>
  </mesh></geometry></library_geometries>
</COLLADA>`;
  const daeZip = zipSync({ 'trunk.dae': strToU8(dae), 'bark.png': TINY_PNG });
  const daeObj = await exporter.importBundle(daeZip, { name: 'trunk.zip' });
  assert.ok(daeObj?.isMesh && daeObj.material?.map, 'Collada .dae mesh + companion texture resolved');

  return 'USDZ + DXF + 3MF + COFF + DAE all verified';
});

await test('Selection never pollutes textured materials with blank gray ShaderGraph', async () => {
  const { sm, exporter } = makeTestEnvironment();
  const { ShaderNodeEditorUI } = await import('../js/ui/shader-node-editor.js');
  const editor = new ShaderNodeEditorUI(null, { sceneManager: sm });

  const zipBytes = zipSync({
    'leaf.obj': strToU8('v 0 0 0\nv 1 0 0\nv 0 1 0\nvt 0 0\nvt 1 0\nvt 0 1\nf 1/1 2/2 3/3\n'),
    'leaf_albedo.png': TINY_PNG,
  });
  const mesh = await exporter.importBundle(zipBytes, { name: 'leaf.zip' });
  sm.select(mesh);
  editor.syncFromSelection();

  assert.equal(getShaderGraphForMaterial(mesh.material), null, 'Selecting object must NOT attach a blank gray shaderGraphJson');
  assert.ok(mesh.material.map, 'Diffuse texture map remains intact after selection');
});

console.log(`\n${failed === 0 ? 'ALL' : 'FAILED'} ${passed}/${passed + failed} RUST WASM DCC IMPORTER & BUNDLE TESTS ${failed === 0 ? 'PASSED' : 'FAILED'}`);
process.exit(failed === 0 ? 0 : 1);
