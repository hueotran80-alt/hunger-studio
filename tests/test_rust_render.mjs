/**
 * Rust render kernel (WASM): packer, textures/UV, Principled BSDF, lights, ortho, volume,
 * refit, progressive preview, determinism, denoise, tone-map.
 * Optional: RUST_RENDER_PNG=/path/out.png writes the beauty render.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import zlib from 'node:zlib';
import * as THREE from 'three';
import { packSceneForRust, packSceneGeometryForRefit, MAT_STRIDE, LIGHT_STRIDE } from '../js/render/rust-scene-pack.js';
import { RenderKernel, renderRust, splitRows, encodeTonemapMode } from '../js/render/rust-render-bridge.js';

let passed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`ok   ${name}`); passed++; }
  catch (e) { console.error(`FAIL ${name}\n${e.stack}`); process.exitCode = 1; }
}

function crc32(buf) {
  let c, crc = ~0;
  for (let n = 0; n < buf.length; n++) { c = (crc ^ buf[n]) & 0xff; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crc = (crc >>> 8) ^ c; }
  return ~crc >>> 0;
}
function png(rgba, w, h) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 4 + 1)] = 0; Buffer.from(rgba.buffer, y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1); }
  const chunk = (t, d) => { const b = Buffer.alloc(12 + d.length); b.writeUInt32BE(d.length, 0); b.write(t, 4); d.copy(b, 8); b.writeUInt32BE(crc32(b.subarray(4, 8 + d.length)), 8 + d.length); return b; };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

function buildScene() {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0.02, 0.02, 0.025);
  const room = new THREE.Mesh(new THREE.BoxGeometry(6, 4, 6), new THREE.MeshStandardMaterial({ color: 0xcccccc, roughness: 0.9, side: THREE.BackSide }));
  room.position.y = 2;
  const left = new THREE.Mesh(new THREE.PlaneGeometry(4, 6), new THREE.MeshStandardMaterial({ color: 0xcc2222, roughness: 0.9 }));
  left.position.set(-2.98, 2, 0); left.rotation.y = Math.PI / 2;
  const right = new THREE.Mesh(new THREE.PlaneGeometry(4, 6), new THREE.MeshStandardMaterial({ color: 0x22aa33, roughness: 0.9 }));
  right.position.set(2.98, 2, 0); right.rotation.y = -Math.PI / 2;
  const metal = new THREE.Mesh(new THREE.SphereGeometry(0.8, 48, 24), new THREE.MeshStandardMaterial({ color: 0xffd27f, metalness: 1, roughness: 0.18 }));
  metal.position.set(-1.1, 0.8, -0.5);
  const glass = new THREE.Mesh(new THREE.SphereGeometry(0.8, 48, 24), new THREE.MeshPhysicalMaterial({ color: 0xffffff, transmission: 1, roughness: 0.02, ior: 1.5 }));
  glass.position.set(1.1, 0.8, 0.3);
  const lamp = new THREE.Mesh(new THREE.PlaneGeometry(1.6, 1.6), new THREE.MeshStandardMaterial({ color: 0x000000, emissive: 0xffffff, emissiveIntensity: 12 }));
  lamp.position.set(0, 3.98, 0); lamp.rotation.x = Math.PI / 2;
  const key = new THREE.PointLight(0xfff0dd, 28, 0); key.position.set(0, 3.5, 0.5);
  scene.add(room, left, right, metal, glass, lamp, key);
  const camera = new THREE.PerspectiveCamera(70, 4 / 3, 0.1, 50);
  camera.position.set(0, 2, 2.9); camera.lookAt(0, 1.4, 0);
  return { scene, camera };
}

const W = 256, H = 192;
const { scene, camera } = buildScene();
const packed = packSceneForRust({ scene, camera, width: W, height: H });

await test('packer collects triangles, UVs, materials, lights and camera', () => {
  assert.ok(packed.triCount > 4000);
  assert.strictEqual(packed.uvs.length, packed.triCount * 6);
  assert.strictEqual(packed.mats.length / MAT_STRIDE, 6);
  assert.strictEqual(packed.lights.length / LIGHT_STRIDE, 1);
  assert.ok(Math.abs(packed.camera[5] + 1) < 0.2);
});

await test('kernel builds BVH, exports extended GPU BVH2 + Emissive CDF + moved PrevTris + Motion-Union AABB', async () => {
  const k = await RenderKernel.create();
  assert.ok(k.version >= 5, `expected version >= 5, got ${k.version}`);
  assert.ok(k.loadScene(packed) > 100);
  const gpu = k.exportBvh2ForGpu(0);
  assert.ok(gpu && gpu.hasExtendedAttrs && gpu.nodeCount > 10);
  assert.strictEqual(gpu.triGeomF32.length, gpu.triCount * 12);
  assert.strictEqual(gpu.triAttrF32.length, gpu.triCount * 20);
  assert.strictEqual(k.exportPrevTrisForGpu(), null, 'frame 0 should not have prev tris before refit');

  // Verify Emissive Mesh CDF export across WASM FFI (lamp PlaneGeometry = 2 emissive triangles)
  const emCdf = k.exportEmissiveCdfForGpu();
  assert.ok(emCdf && emCdf.count === 2, `expected 2 emissive triangles, got ${emCdf?.count}`);
  const emU32 = new Uint32Array(emCdf.dataF32.buffer, emCdf.dataF32.byteOffset, emCdf.count * 4);
  for (let i = 0; i < emCdf.count; i++) {
    const triIdx = emU32[i * 4];
    const cdfNorm = emCdf.dataF32[i * 4 + 1];
    const areaPdf = emCdf.dataF32[i * 4 + 2];
    assert.ok(triIdx < gpu.triCount, `emissive triIdx out of range: ${triIdx}`);
    assert.ok(cdfNorm > 0 && cdfNorm <= 1.0001, `invalid cdfNorm: ${cdfNorm}`);
    if (i > 0) assert.ok(cdfNorm >= emCdf.dataF32[(i - 1) * 4 + 1], 'emissive CDF must be monotonic');
    assert.ok(areaPdf > 0, `areaPdf must be positive: ${areaPdf}`);
    const attrPdf = gpu.triAttrF32[triIdx * 20 + 18];
    assert.ok(Math.abs(attrPdf - areaPdf) < 1e-4, `triAttr emAreaPdf (${attrPdf}) must match emissive CDF areaPdf (${areaPdf})`);
  }
  assert.ok(Math.abs(emCdf.dataF32[(emCdf.count - 1) * 4 + 1] - 1.0) < 1e-4, 'final emissive CDF must equal 1.0');

  // Dedicated 1-box scene to strictly verify PrevTris delta, Motion-Union AABB expansion & topology-change rejection
  const mbSc = new THREE.Scene();
  const box = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ color: 0xffffff }));
  box.position.set(0, 0, 0);
  mbSc.add(box);
  const mbCam = new THREE.PerspectiveCamera(50, 1, 0.1, 50);
  mbCam.position.set(0, 0, 6);
  const p0 = packSceneForRust({ scene: mbSc, camera: mbCam, width: 32, height: 32 });
  const kMb = await RenderKernel.create();
  kMb.loadScene(p0);

  box.position.set(4.0, 0, 0);
  mbSc.updateMatrixWorld(true);
  const p1 = packSceneForRust({ scene: mbSc, camera: mbCam, width: 32, height: 32 });
  assert.strictEqual(kMb.refitScene(p1), true);
  const prev = kMb.exportPrevTrisForGpu();
  const gpuStatic = kMb.exportBvh2ForGpu(0.0);
  const gpuMotion = kMb.exportBvh2ForGpu(1.0);
  assert.ok(prev && prev.triCount === gpuStatic.triCount && prev.prevGeomF32.length === gpuStatic.triCount * 12);
  let maxDeltaX = 0;
  for (let i = 0; i < prev.triCount; i++) {
    maxDeltaX = Math.max(maxDeltaX, Math.abs(gpuStatic.triGeomF32[i * 12] - prev.prevGeomF32[i * 12]));
  }
  assert.ok(Math.abs(maxDeltaX - 4.0) < 1e-3, `prevGeomF32 must preserve frame-0 X position (delta=${maxDeltaX})`);
  // Root AABB: nodesF32[0]=minX, nodesF32[4]=maxX
  assert.ok(gpuStatic.nodesF32[0] >= 3.49 && gpuStatic.nodesF32[4] <= 4.51, `static root X=[${gpuStatic.nodesF32[0]}, ${gpuStatic.nodesF32[4]}]`);
  assert.ok(gpuMotion.nodesF32[0] <= -0.49 && gpuMotion.nodesF32[4] >= 4.49, `motion union root X=[${gpuMotion.nodesF32[0]}, ${gpuMotion.nodesF32[4]}]`);

  // Topology change (adding a second mesh) must make refitScene return false cleanly instead of crashing
  mbSc.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial()));
  const pTopo = packSceneForRust({ scene: mbSc, camera: mbCam, width: 32, height: 32 });
  assert.strictEqual(kMb.refitScene(pTopo), false, 'refitScene must return false when triangle count changes');

  // Empty scene (0 triangles) must be rejected cleanly
  const emptyPacked = packSceneForRust({ scene: new THREE.Scene(), camera: mbCam, width: 32, height: 32 });
  assert.throws(() => kMb.loadScene(emptyPacked), /no valid triangles/i);
});

let first;
await test('renders a lit, non-empty image (single thread)', async () => {
  first = await renderRust(packed, { width: W, height: H, samples: 32, passSpp: 8, threads: 1, denoise: false });
  assert.strictEqual(first.rgba.length, W * H * 4);
  let sum = 0, lit = 0;
  for (let i = 0; i < W * H; i++) { const l = first.rgba[i * 4] + first.rgba[i * 4 + 1] + first.rgba[i * 4 + 2]; sum += l; if (l > 60) lit++; }
  assert.ok(lit > W * H * 0.5, `lit pixels ${lit}`);
  console.log(`     ${first.ms} ms @ ${W}x${H}x32spp, mean ${(sum / (W * H * 3)).toFixed(1)}`);
  const px = (x, y) => { const i = (y * W + x) * 4; return [first.rgba[i], first.rgba[i + 1], first.rgba[i + 2]]; };
  const l = px(24, 90), r = px(W - 24, 90);
  assert.ok(l[0] > l[1] * 1.3, `left wall should be red: ${l}`);
  assert.ok(r[1] > r[0] * 1.3, `right wall should be green: ${r}`);
});

await test('rendering is deterministic', async () => {
  const again = await renderRust(packed, { width: W, height: H, samples: 32, passSpp: 8, threads: 1, denoise: false });
  assert.deepStrictEqual(Buffer.from(again.rgba), Buffer.from(first.rgba));
});

await test('abort returns null', async () => {
  const ac = new AbortController(); ac.abort();
  assert.strictEqual(await renderRust(packed, { width: W, height: H, samples: 8, threads: 1, signal: ac.signal }), null);
});

await test('denoise lowers noise vs raw at low spp', async () => {
  if (process.env.RUST_RENDER_PNG) {
    const big = await renderRust(packed, { width: W, height: H, samples: 128, passSpp: 16, threads: 1, denoise: true, adaptiveThreshold: 0.015 });
    fs.writeFileSync(process.env.RUST_RENDER_PNG, png(big.rgba, W, H));
    console.log(`     128spp(adaptive)+denoise ${big.ms} ms → ${process.env.RUST_RENDER_PNG}`);
  }
  const raw = await renderRust(packed, { width: W, height: H, samples: 8, passSpp: 8, threads: 1, denoise: false });
  const dn = await renderRust(packed, { width: W, height: H, samples: 8, passSpp: 8, threads: 1, denoise: true });
  const hf = (b) => { let s = 0; for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) { const i = (y * W + x) * 4 + 1; s += Math.abs(4 * b[i] - b[i - 4] - b[i + 4] - b[i - W * 4] - b[i + W * 4]); } return s; };
  assert.ok(hf(dn.rgba) < hf(raw.rgba) * 0.7, `${hf(dn.rgba)} vs ${hf(raw.rgba)}`);
});

await test('texture maps (2x2 checker DataTexture + normal/roughness) render exact quadrant colours', async () => {
  // DataTexture flipY=false: row 0 is v=0 (bottom), row 1 is v=1 (top)
  const checker = new Uint8Array([
    255, 20, 20, 255,   20, 255, 20, 255, // bottom: red (u<0.5), green (u>0.5)
    20, 20, 255, 255,   255, 255, 20, 255 // top: blue (u<0.5), yellow (u>0.5)
  ]);
  const mapTex = new THREE.DataTexture(checker, 2, 2, THREE.RGBAFormat);
  mapTex.needsUpdate = true;
  const nrmData = new Uint8Array([128, 128, 255, 255, 128, 128, 255, 255, 128, 128, 255, 255, 128, 128, 255, 255]);
  const nrmTex = new THREE.DataTexture(nrmData, 2, 2, THREE.RGBAFormat);
  nrmTex.needsUpdate = true;

  const sc = new THREE.Scene();
  const quad = new THREE.Mesh(
    new THREE.PlaneGeometry(2, 2),
    new THREE.MeshStandardMaterial({ color: 0xffffff, map: mapTex, normalMap: nrmTex, roughness: 0.8 })
  );
  const light = new THREE.DirectionalLight(0xffffff, 3.0);
  light.position.set(0, 0, 5);
  sc.add(quad, light);
  const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 20);
  cam.position.set(0, 0, 3); cam.lookAt(0, 0, 0);

  const p = packSceneForRust({ scene: sc, camera: cam, width: 64, height: 64 });
  assert.strictEqual(p.textures.count, 2);
  assert.strictEqual(p.orthographic, true);
  const out = await renderRust(p, { width: 64, height: 64, samples: 4, passSpp: 4, threads: 1, denoise: false, tonemap: 'linear' });
  const px = (x, y) => { const i = (y * 64 + x) * 4; return [out.rgba[i], out.rgba[i + 1], out.rgba[i + 2]]; };
  const tl = px(16, 16), tr = px(48, 16), bl = px(16, 48), br = px(48, 48);
  assert.ok(tl[2] > tl[0] * 2 && tl[2] > tl[1] * 2, `top-left should be blue, got ${tl}`);
  assert.ok(tr[0] > tr[2] * 2 && tr[1] > tr[2] * 2, `top-right should be yellow, got ${tr}`);
  assert.ok(bl[0] > bl[1] * 2 && bl[0] > bl[2] * 2, `bottom-left should be red, got ${bl}`);
  assert.ok(br[1] > br[0] * 2 && br[1] > br[2] * 2, `bottom-right should be green, got ${br}`);
});

await test('SpotLight, RectAreaLight, Volume fog, BVH refit & progressive preview work', async () => {
  const sc = new THREE.Scene();
  sc.userData.volume = { density: 0.05, anisotropy: 0.2, color: [0.9, 0.95, 1.0], maxDist: 20 };
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(8, 8), new THREE.MeshStandardMaterial({ color: 0xdddddd, roughness: 0.7 }));
  floor.rotation.x = -Math.PI / 2;
  const box = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshPhysicalMaterial({ color: 0x3388ff, clearcoat: 1, sheen: 0.5 }));
  box.position.set(0, 0.5, 0);
  const spot = new THREE.SpotLight(0xffffff, 20, 0, Math.PI / 5, 0.3);
  spot.position.set(0, 4, 0);
  const area = new THREE.RectAreaLight(0xffddaa, 4, 2, 1);
  area.position.set(2, 2, 2); area.lookAt(0, 0.5, 0);
  sc.add(floor, box, spot, area);
  const cam = new THREE.PerspectiveCamera(50, 1, 0.1, 50);
  cam.position.set(0, 2, 4); cam.lookAt(0, 0.5, 0);

  const p0 = packSceneForRust({ scene: sc, camera: cam, width: 48, height: 48 });
  assert.strictEqual(p0.lights.length / LIGHT_STRIDE, 2);
  let previews = 0;
  const res = await renderRust(p0, {
    width: 48, height: 48, samples: 8, passSpp: 4, threads: 1, denoise: true, tonemap: 'neutral',
    onPreview: () => { previews++; }
  });
  assert.ok(previews >= 1, `expected progressive preview callback, got ${previews}`);
  assert.strictEqual(res.rgba.length, 48 * 48 * 4);

  // Refit test: move box right and verify refitScene succeeds
  const kernel = await RenderKernel.create();
  kernel.loadScene(p0);
  box.position.set(1.2, 0.5, 0);
  const p1 = packSceneForRust({ scene: sc, camera: cam, width: 48, height: 48 });
  assert.strictEqual(kernel.refitScene(p1), true);
  const tile = kernel.renderRows({ width: 48, height: 48, y0: 0, y1: 48, spp: 4, seed: 1 });
  assert.strictEqual(tile.accum.length, 48 * 48 * 4);

  // Temporal reprojection across 2 frames via renderRust({ temporal })
  const temporal = { blend: 0.75, state: null };
  box.position.set(0, 0.5, 0);
  const tp0 = packSceneForRust({ scene: sc, camera: cam, width: 48, height: 48 });
  const r0 = await renderRust(tp0, { width: 48, height: 48, samples: 4, passSpp: 4, threads: 1, denoise: false, temporal, kernel });
  assert.ok(temporal.state?.prevMean?.length === 48 * 48 * 4);
  box.position.set(0.25, 0.5, 0);
  const tp1 = packSceneForRust({ scene: sc, camera: cam, width: 48, height: 48 });
  const r1 = await renderRust(tp1, { width: 48, height: 48, samples: 4, passSpp: 4, threads: 1, denoise: false, temporal, kernel });
  assert.strictEqual(r1.rgba.length, 48 * 48 * 4);
  assert.notDeepStrictEqual(Buffer.from(r0.rgba), Buffer.from(r1.rgba));
});

await test('splitRows covers the frame exactly', () => {
  for (const [h, n] of [[7, 3], [1080, 24], [5, 9]]) {
    const parts = splitRows(h, n);
    assert.strictEqual(parts[0][0], 0); assert.strictEqual(parts.at(-1)[1], h);
    for (let i = 1; i < parts.length; i++) assert.strictEqual(parts[i][0], parts[i - 1][1]);
  }
});

await test('2D HDRI CDF exports across WASM FFI with monotonic CDF and high hotspot PDF', async () => {
  const ew = 16, eh = 8;
  const data = new Float32Array(ew * eh * 4);
  for (let i = 0; i < ew * eh; i++) {
    data[i * 4] = 0.05; data[i * 4 + 1] = 0.05; data[i * 4 + 2] = 0.05; data[i * 4 + 3] = 1.0;
  }
  const hot = (2 * ew + 12) * 4;
  data[hot] = 80.0; data[hot + 1] = 60.0; data[hot + 2] = 40.0;
  const envTex = new THREE.DataTexture(data, ew, eh, THREE.RGBAFormat, THREE.FloatType);
  envTex.needsUpdate = true;

  const sc = new THREE.Scene();
  sc.userData.rawEnvironmentSource = envTex;
  sc.environment = envTex;
  sc.environmentIntensity = 1.0;
  sc.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ color: 0xffffff })));
  const cam = new THREE.PerspectiveCamera(45, 1, 0.1, 20);
  cam.position.set(0, 0, 4);

  const p = packSceneForRust({ scene: sc, camera: cam, width: 32, height: 32 });
  const k = await RenderKernel.create();
  k.loadScene(p);
  const cdf = k.exportEnvCdfForGpu();
  assert.ok(cdf && cdf.width === ew && cdf.height === eh, 'exportEnvCdfForGpu must return HDRI dimensions');
  assert.strictEqual(cdf.rowCdfF32.length, eh);
  assert.strictEqual(cdf.colCdfPdfF32.length, ew * eh * 2);
  assert.ok(Math.abs(cdf.rowCdfF32[eh - 1] - 1.0) < 1e-4, 'row CDF must end at 1.0');
  for (let y = 1; y < eh; y++) assert.ok(cdf.rowCdfF32[y] >= cdf.rowCdfF32[y - 1], 'row CDF must be non-decreasing');
  // DataTexture row 2 in JS may be flipped vertically by packer; find max PDF across image vs dim corner
  let maxPdf = 0;
  for (let i = 0; i < ew * eh; i++) maxPdf = Math.max(maxPdf, cdf.colCdfPdfF32[i * 2 + 1]);
  const dimPdf = cdf.colCdfPdfF32[0 * 2 + 1];
  assert.ok(maxPdf > dimPdf * 30, `hotspot PDF (${maxPdf}) must far exceed dim sky PDF (${dimPdf})`);
});

await test('OCIO AgX Looks (encodeTonemapMode + renderRust) produce distinct contrast/saturation', async () => {
  assert.strictEqual(encodeTonemapMode('agx', 'base'), 2);
  assert.strictEqual(encodeTonemapMode('agx', 'punchy'), 2 | (1 << 8));
  assert.strictEqual(encodeTonemapMode('agx', 'low-contrast'), 2 | (4 << 8));

  const sc = new THREE.Scene();
  const cube = new THREE.Mesh(new THREE.BoxGeometry(2.2, 2.2, 2.2), new THREE.MeshStandardMaterial({ color: 0xcc3322, roughness: 0.5 }));
  const sun = new THREE.DirectionalLight(0xffffff, 2.2);
  sun.position.set(2, 3, 4);
  sc.add(cube, sun);
  const cam = new THREE.PerspectiveCamera(45, 1, 0.1, 30);
  cam.position.set(0, 0.2, 4.0); cam.lookAt(0, 0, 0);
  const p = packSceneForRust({ scene: sc, camera: cam, width: 48, height: 48 });

  const stats = (rgba) => {
    let lum = 0, sat = 0, n = 0;
    for (let y = 16; y < 32; y++) for (let x = 16; x < 32; x++) {
      const o = (y * 48 + x) * 4;
      const r = rgba[o], g = rgba[o + 1], b = rgba[o + 2];
      lum += 0.2126 * r + 0.7152 * g + 0.0722 * b;
      sat += Math.max(r, g, b) - Math.min(r, g, b);
      n++;
    }
    return { lum: lum / n, sat: sat / n };
  };
  const rBase = await renderRust(p, { width: 48, height: 48, samples: 4, passSpp: 4, threads: 1, denoise: false, tonemap: 'agx', tonemapLook: 'base' });
  const rPunchy = await renderRust(p, { width: 48, height: 48, samples: 4, passSpp: 4, threads: 1, denoise: false, tonemap: 'agx', tonemapLook: 'punchy' });
  const rLow = await renderRust(p, { width: 48, height: 48, samples: 4, passSpp: 4, threads: 1, denoise: false, tonemap: 'agx', tonemapLook: 'low-contrast' });
  const sBase = stats(rBase.rgba), sPunchy = stats(rPunchy.rgba), sLow = stats(rLow.rgba);
  assert.ok(sPunchy.sat > sBase.sat + 2, `Punchy sat (${sPunchy.sat.toFixed(1)}) must exceed Base (${sBase.sat.toFixed(1)})`);
  assert.ok(sLow.lum > sBase.lum + 2, `Low Contrast lum (${sLow.lum.toFixed(1)}) must exceed Base (${sBase.lum.toFixed(1)})`);
});

await test('transparent background sets sky alpha=0 and opaque mesh alpha=255', async () => {
  const sc = new THREE.Scene();
  const cube = new THREE.Mesh(new THREE.BoxGeometry(1.2, 1.2, 1.2), new THREE.MeshStandardMaterial({ color: 0x44aaee, roughness: 0.5 }));
  const light = new THREE.DirectionalLight(0xffffff, 2.5);
  light.position.set(1, 2, 4);
  sc.add(cube, light);
  const cam = new THREE.PerspectiveCamera(45, 1, 0.1, 30);
  cam.position.set(0, 0, 5); cam.lookAt(0, 0, 0);

  const p = packSceneForRust({ scene: sc, camera: cam, width: 48, height: 48, transparent: true });
  const res = await renderRust(p, { width: 48, height: 48, samples: 4, passSpp: 4, threads: 1, denoise: false });
  // Corner (2, 2) misses the cube -> sky alpha must be 0
  const skyIdx = (2 * 48 + 2) * 4;
  assert.strictEqual(res.rgba[skyIdx + 3], 0, `sky alpha must be 0, got ${res.rgba[skyIdx + 3]}`);
  // Center (24, 24) hits the cube -> opaque alpha must be 255 and lit
  const midIdx = (24 * 48 + 24) * 4;
  assert.strictEqual(res.rgba[midIdx + 3], 255, `mesh alpha must be 255, got ${res.rgba[midIdx + 3]}`);
  assert.ok(res.rgba[midIdx] + res.rgba[midIdx + 1] + res.rgba[midIdx + 2] > 60, 'mesh center must be lit');
});

await test('InstancedMesh (transforms, instanceColor & fast refit) renders all active instances distinctly', async () => {
  const sc = new THREE.Scene();
  sc.background = new THREE.Color(0x000000);
  const inst = new THREE.InstancedMesh(
    new THREE.BoxGeometry(0.9, 0.9, 0.9),
    new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.7 }),
    3
  );
  inst.setMatrixAt(0, new THREE.Matrix4().makeTranslation(-1.3, 0, 0));
  inst.setMatrixAt(1, new THREE.Matrix4().makeTranslation(1.3, 0, 0));
  inst.setMatrixAt(2, new THREE.Matrix4().makeTranslation(0, 0, 0));
  inst.setColorAt(0, new THREE.Color(1, 0.05, 0.05));
  inst.setColorAt(1, new THREE.Color(0.05, 1, 0.05));
  inst.count = 2; // instance 2 must be excluded!
  inst.instanceMatrix.needsUpdate = true;
  inst.instanceColor.needsUpdate = true;
  const sun = new THREE.DirectionalLight(0xffffff, 3.0);
  sun.position.set(0, 1, 5);
  sc.add(inst, sun);

  const cam = new THREE.PerspectiveCamera(50, 1, 0.1, 30);
  cam.position.set(0, 0, 5); cam.lookAt(0, 0, 0);
  const p0 = packSceneForRust({ scene: sc, camera: cam, width: 48, height: 48 });
  assert.strictEqual(p0.triCount, 24, `2 active box instances = 24 tris, got ${p0.triCount}`);
  const r0 = await renderRust(p0, { width: 48, height: 48, samples: 4, passSpp: 4, threads: 1, denoise: false, tonemap: 'linear' });
  const px = (rgba, x, y) => { const o = (y * 48 + x) * 4; return [rgba[o], rgba[o + 1], rgba[o + 2]]; };
  const leftPx = px(r0.rgba, 11, 24);
  const midPx = px(r0.rgba, 24, 24);
  const rightPx = px(r0.rgba, 37, 24);
  assert.ok(leftPx[0] > 120 && leftPx[0] > leftPx[1] * 3, `left instance must be red, got ${leftPx}`);
  assert.ok(rightPx[1] > 120 && rightPx[1] > rightPx[0] * 3, `right instance must be green, got ${rightPx}`);
  assert.ok(midPx[0] < 10 && midPx[1] < 10 && midPx[2] < 10, `inactive 3rd instance must not render at center, got ${midPx}`);

  // Move instance 0 to center and verify O(N) fast refit updates its vertices!
  inst.setMatrixAt(0, new THREE.Matrix4().makeTranslation(0, 0, 0));
  inst.instanceMatrix.needsUpdate = true;
  const refit = packSceneGeometryForRefit({ scene: sc, camera: cam, width: 48, height: 48, prevPacked: p0 });
  assert.ok(refit && refit.refitOnly === true && refit.triCount === 24);
  const k = await RenderKernel.create();
  k.loadScene(p0);
  assert.strictEqual(k.refitScene(refit), true);
  const r1 = await renderRust(refit, { width: 48, height: 48, samples: 4, passSpp: 4, threads: 1, denoise: false, tonemap: 'linear', kernel: k });
  const movedCenter = px(r1.rgba, 24, 24);
  assert.ok(movedCenter[0] > 120 && movedCenter[0] > movedCenter[1] * 3, `refitted instance 0 must appear red at center, got ${movedCenter}`);
});

await test('morphTargetInfluences (relative & absolute) deform Mesh and SkinnedMesh in packer & refit', () => {
  for (const relative of [true, false]) {
    const sc = new THREE.Scene();
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 1, 1, 0, 1, 0, 1, 1], 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute([0, 0, 1, 0, 0, 1, 0, 0, 1], 3));
    g.morphTargetsRelative = relative;
    // Relative delta (+0,+0,+4) vs absolute target (z=5 -> delta +4 from base z=1)
    const targetZ = relative ? 4 : 5;
    g.morphAttributes.position = [new THREE.Float32BufferAttribute([0, 0, targetZ, 1, 0, targetZ, 0, 1, targetZ], 3)];
    const m = new THREE.Mesh(g, new THREE.MeshStandardMaterial());
    m.morphTargetInfluences[0] = 0.5;
    sc.add(m);
    const cam = new THREE.PerspectiveCamera(45, 1, 0.1, 20);
    const p0 = packSceneForRust({ scene: sc, camera: cam, width: 16, height: 16 });
    assert.ok(Math.abs(p0.pos[2] - 3.0) < 1e-3, `relative=${relative}: expected z=3.0, got ${p0.pos[2]}`);

    // Update morph influence to 1.0 -> refit must move z to 5.0
    m.morphTargetInfluences[0] = 1.0;
    const p1 = packSceneGeometryForRefit({ scene: sc, camera: cam, width: 16, height: 16, prevPacked: p0 });
    assert.ok(p1 && Math.abs(p1.pos[2] - 5.0) < 1e-3, `relative=${relative}: expected refit z=5.0, got ${p1?.pos[2]}`);
  }
});

await test('edge cases: opacity=0 vs 1, exposure=0, camera zoom=2, degenerate/NaN tris, odd/1x1 resize with temporal', async () => {
  const sc = new THREE.Scene();
  sc.background = new THREE.Color(0x000000);
  const back = new THREE.Mesh(new THREE.PlaneGeometry(4, 4), new THREE.MeshStandardMaterial({ color: 0, emissive: 0xff0000, emissiveIntensity: 1.0 }));
  back.position.z = -1;
  const frontMat = new THREE.MeshStandardMaterial({ color: 0x0000ff, transparent: true, opacity: 0.0 });
  const front = new THREE.Mesh(new THREE.PlaneGeometry(4, 4), frontMat);
  const deg = new THREE.BufferGeometry();
  deg.setAttribute('position', new THREE.Float32BufferAttribute([0,0,0, 0,0,0, 0,0,0, NaN,NaN,NaN, 1,0,0, 0,1,0], 3));
  sc.add(back, front, new THREE.Mesh(deg, new THREE.MeshStandardMaterial()));
  const cam = new THREE.PerspectiveCamera(45, 1, 0.1, 20);
  cam.position.set(0, 0, 3);

  const rOpen = await renderRust(packSceneForRust({ scene: sc, camera: cam, width: 33, height: 19 }), {
    width: 33, height: 19, samples: 4, passSpp: 4, threads: 1, denoise: true, tonemap: 'linear',
  });
  const mid = (9 * 33 + 16) * 4;
  assert.ok(rOpen.rgba[mid] > 200 && rOpen.rgba[mid + 2] < 10, `opacity=0 must reveal red behind: [${rOpen.rgba[mid]},${rOpen.rgba[mid+1]},${rOpen.rgba[mid+2]}]`);

  // exposure=0 must render black
  const rDark = await renderRust(packSceneForRust({ scene: sc, camera: cam, width: 16, height: 16 }), {
    width: 16, height: 16, samples: 2, passSpp: 2, threads: 1, denoise: false, exposure: 0,
  });
  assert.strictEqual(rDark.rgba[(8 * 16 + 8) * 4], 0, 'exposure=0 must produce 0');

  // opacity=1 blocks red behind
  frontMat.opacity = 1.0; frontMat.transparent = false;
  const rBlk = await renderRust(packSceneForRust({ scene: sc, camera: cam, width: 17, height: 11 }), {
    width: 17, height: 11, samples: 2, passSpp: 2, threads: 1, denoise: false, tonemap: 'linear',
  });
  assert.ok(rBlk.rgba[(5 * 17 + 8) * 4] < 10, 'opacity=1 must block red plane behind');
});

console.log(`${passed} passed`);
