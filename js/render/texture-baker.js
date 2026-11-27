/**
 * GPU/WASM Scene Texture Baker using Rust BVH Kernel (`render_kernel`)
 * Bakes Ambient Occlusion, Tangent/World Normal (incl. High-to-Low cage),
 * Position, Curvature, and Combined Lightmaps with UV margin dilation.
 * File: js/render/texture-baker.js
 */

import * as THREE from 'three';
import { BAKE_MODE, RenderKernel, RenderPool, loadKernelBytes, splitRows } from './rust-render-bridge.js';
import { packSceneForRust } from './rust-scene-pack.js';
import { ensurePaintLayerStack } from '../core/paint-layers.js';
import { smartUVProjectGeometry, applyUVGeometryUpdate } from '../core/geometry/uv-unwrap.js';

export { BAKE_MODE };

const DEFAULT_SLOT_FOR_MODE = {
  ao: 'ao',
  normal: 'normal',
  worldNormal: 'normal',
  position: 'baseColor',
  curvature: 'roughness',
  combined: 'baseColor',
};

/**
 * Extracts world-space non-indexed target triangles for UV rasterization in Rust.
 */
export function packTargetMeshForBake(mesh, options = {}) {
  if (!mesh?.isMesh || !mesh.geometry?.attributes?.position) {
    throw new Error('Bake target must be a valid Mesh with geometry.');
  }
  mesh.updateMatrixWorld?.(true);
  let geo = mesh.geometry;
  if (!geo.attributes.uv) {
    if (options.autoUV !== false) {
      const projected = smartUVProjectGeometry(geo);
      geo = applyUVGeometryUpdate(mesh, projected) || mesh.geometry;
    } else {
      throw new Error(`Mesh "${mesh.name || 'Object'}" has no UV coordinates to bake into.`);
    }
  }
  const posAttr = geo.attributes.position;
  const uvAttr = geo.attributes.uv;
  if (!geo.attributes.normal) geo.computeVertexNormals();
  const nrmAttr = geo.attributes.normal;
  const idx = geo.index ? geo.index.array : null;
  const ntri = idx ? Math.floor(idx.length / 3) : Math.floor(posAttr.count / 3);
  if (ntri === 0) throw new Error('Target mesh has zero triangles.');

  const pos = new Float32Array(ntri * 9);
  const nrm = new Float32Array(ntri * 9);
  const uv = new Float32Array(ntri * 6);

  const v = new THREE.Vector3();
  const n = new THREE.Vector3();
  const nm = new THREE.Matrix3().getNormalMatrix(mesh.matrixWorld);
  const boundsLo = [Infinity, Infinity, Infinity];
  const boundsHi = [-Infinity, -Infinity, -Infinity];

  for (let t = 0; t < ntri; t++) {
    for (let k = 0; k < 3; k++) {
      const vi = idx ? idx[t * 3 + k] : t * 3 + k;
      v.fromBufferAttribute(posAttr, vi).applyMatrix4(mesh.matrixWorld);
      pos.set([v.x, v.y, v.z], t * 9 + k * 3);
      boundsLo[0] = Math.min(boundsLo[0], v.x);
      boundsLo[1] = Math.min(boundsLo[1], v.y);
      boundsLo[2] = Math.min(boundsLo[2], v.z);
      boundsHi[0] = Math.max(boundsHi[0], v.x);
      boundsHi[1] = Math.max(boundsHi[1], v.y);
      boundsHi[2] = Math.max(boundsHi[2], v.z);

      n.fromBufferAttribute(nrmAttr, vi).applyMatrix3(nm).normalize();
      nrm.set([n.x, n.y, n.z], t * 9 + k * 3);

      uv[t * 6 + k * 2] = uvAttr.getX(vi);
      uv[t * 6 + k * 2 + 1] = uvAttr.getY(vi);
    }
  }

  return {
    pos,
    nrm,
    uv,
    ntri,
    boundsLo: new Float32Array(boundsLo),
    boundsHi: new Float32Array(boundsHi),
  };
}

function buildHighPolyBakeScene(highPolyMesh, sourceScene) {
  const bakeScene = new THREE.Scene();
  if (sourceScene) {
    bakeScene.background = sourceScene.background;
    bakeScene.environment = sourceScene.environment;
    bakeScene.userData = { ...sourceScene.userData };
    sourceScene.traverseVisible?.((node) => {
      if (node.isLight) {
        const clone = node.clone();
        node.getWorldPosition(clone.position);
        node.getWorldQuaternion(clone.quaternion);
        bakeScene.add(clone);
      }
    });
  }
  const proxy = new THREE.Mesh(highPolyMesh.geometry, highPolyMesh.material);
  highPolyMesh.updateMatrixWorld?.(true);
  proxy.matrixAutoUpdate = false;
  proxy.matrix.copy(highPolyMesh.matrixWorld);
  proxy.matrixWorld.copy(highPolyMesh.matrixWorld);
  bakeScene.add(proxy);
  return bakeScene;
}

/**
 * Bakes a mesh map (`ao` | `normal` | `worldNormal` | `position` | `curvature` | `combined`)
 * using the Rust BVH kernel and optional multi-threaded Worker pool.
 */
export async function bakeMeshTexture({
  mesh,
  scene,
  highPolyMesh = null,
  mode = 'ao',
  width = 512,
  height = 512,
  samples = 32,
  maxDist = 0,
  cageOffset = 0,
  margin = 4,
  applyToMaterial = true,
  targetSlot = null,
  layerName = null,
  threads = 0,
  wasmSource = null,
  kernel: externalKernel = null,
  pool: externalPool = null,
  onProgress = null,
} = {}) {
  if (!mesh) throw new Error('bakeMeshTexture requires a target mesh.');
  const modeCode = typeof mode === 'number' ? mode : (BAKE_MODE[mode] ?? BAKE_MODE.ao);
  const w = Math.max(16, Math.min(2048, width | 0));
  const h = Math.max(16, Math.min(2048, height | 0));
  const started = Date.now();

  const targetPacked = packTargetMeshForBake(mesh);
  const bvhScene = highPolyMesh ? buildHighPolyBakeScene(highPolyMesh, scene) : (scene || (() => {
    const tmp = new THREE.Scene();
    const proxy = new THREE.Mesh(mesh.geometry, mesh.material);
    mesh.updateMatrixWorld?.(true);
    proxy.matrixAutoUpdate = false;
    proxy.matrix.copy(mesh.matrixWorld);
    proxy.matrixWorld.copy(mesh.matrixWorld);
    tmp.add(proxy);
    return tmp;
  })());

  const dummyCam = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
  dummyCam.position.set(0, 0, 5);
  const packedScene = packSceneForRust({ scene: bvhScene, camera: dummyCam, width: w, height: h });

  const bytes = externalKernel ? null : await loadKernelBytes(wasmSource);
  const main = externalKernel || await RenderKernel.create(bytes);
  main.loadScene(packedScene);

  const effectiveCage = highPolyMesh && !(cageOffset > 0) ? 0.25 : cageOffset;
  let ownedPool = null;
  const useThreads = threads !== 1 && !externalKernel && RenderPool.supported();
  let activePool = externalPool;

  try {
    if (useThreads) {
      if (activePool && activePool.workers.length > 0) {
        await activePool.updateScene(packedScene);
      } else if (activePool) {
        await activePool.init(bytes || await loadKernelBytes(wasmSource), packedScene);
      } else {
        ownedPool = new RenderPool(threads > 0 ? threads : undefined);
        await ownedPool.init(bytes, packedScene);
        activePool = ownedPool;
      }
    }

    const chunks = splitRows(h, activePool ? activePool.size * 2 : 1);
    const tasks = chunks.map(([y0, y1]) => ({
      pos: targetPacked.pos,
      nrm: targetPacked.nrm,
      uv: targetPacked.uv,
      ntri: targetPacked.ntri,
      width: w,
      height: h,
      y0,
      y1,
      mode: modeCode,
      samples,
      maxDist,
      cageOffset: effectiveCage,
      boundsLo: targetPacked.boundsLo,
      boundsHi: targetPacked.boundsHi,
    }));

    const parts = activePool ? await activePool.run(tasks, 'bake') : tasks.map((t) => main.bakeRows(t));
    const rgba = new Uint8ClampedArray(w * h * 4);
    const cov = new Uint8Array(w * h);
    for (const p of parts) {
      rgba.set(p.rgba, p.y0 * w * 4);
      cov.set(p.cov, p.y0 * w);
    }

    if (margin > 0) {
      main.dilateBakeMargin(rgba, cov, w, h, margin);
    }

    onProgress?.(1.0);

    let appliedSlot = null;
    if (applyToMaterial) {
      const slotKey = targetSlot || DEFAULT_SLOT_FOR_MODE[mode] || 'baseColor';
      if (!mesh.material || (Array.isArray(mesh.material) && !mesh.material[0])) {
        mesh.material = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.6 });
      }
      const mat = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
      const stack = ensurePaintLayerStack(mat);
      stack.applyRawRgbaToSlot(slotKey, rgba, w, h, layerName || `Baked ${mode}`);
      appliedSlot = slotKey;
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('blender:textureUpdated', { detail: { mesh, slot: slotKey } }));
      }
    }

    return {
      rgba,
      cov,
      width: w,
      height: h,
      mode,
      appliedSlot,
      ms: Date.now() - started,
    };
  } finally {
    ownedPool?.dispose();
  }
}

export default { BAKE_MODE, packTargetMeshForBake, bakeMeshTexture };
