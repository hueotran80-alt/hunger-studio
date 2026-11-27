/**
 * BVH accelerator helpers (Giai đoạn 2.1).
 * File: js/core/bvh-accelerator.js
 *
 * Bọc `three-mesh-bvh` (vendored tại `vendor/three-mesh-bvh/`) để:
 * - `ensureBVH(mesh)`: build/tái build `geometry.boundsTree` cho mesh (lazy,
 *   chỉ khi geometry đổi — so sánh `geometry.uuid` + `position.version`).
 * - `refitBVH(mesh)`: refit nhanh sau khi kéo đỉnh (rẻ hơn build lại).
 * - `disposeBVH(mesh)`: giải phóng khi xoá/exited.
 *
 * Raycast trong Edit Mode / Sculpt Mode sẽ tự đi qua boundsTree (three.js
 * Raycaster ưa chuộng `geometry.boundsTree` khi có mặt), giúp chọn
 * đỉnh/cạnh/mặt trên mesh hàng trăm nghìn đa giác không còn quét tuyến tính.
 */

import * as THREE from 'three';
import { MeshBVH, acceleratedRaycast } from 'three-mesh-bvh';
import {
  geometryWorkerAvailable, buildBVHInWorker, triangleCount, WORKER_BVH_MIN_TRIANGLES
} from './geometry-worker-client.js';

const _state = new WeakMap(); // geometry -> { uuid, version, bvh }
const _pending = new WeakSet(); // geometry đang build trong worker
const _disposedGen = new WeakMap(); // geometry -> monotonic dispose counter to reject stale async worker builds

function _geomVersion(geom) {
  const pos = geom.attributes?.position;
  const idx = geom.index;
  return `${geom.uuid}:${pos ? pos.version : -1}:${idx ? idx.version : -1}:${geom.drawRange.count}`;
}

function _topoVersion(geom) {
  const pos = geom.attributes?.position;
  const idx = geom.index;
  return `${geom.uuid}:${pos ? pos.count : -1}:${idx ? `${idx.version}:${idx.count}` : 'nonidx'}:${geom.drawRange.count}`;
}

/**
 * Đảm bảo geometry có boundsTree khớp trạng thái hiện tại.
 * Luôn dùng `indirect: true` để KHÔNG đảo thứ tự `geometry.index` in-place
 * (giữ nguyên ánh xạ `triangleToFaceMap`, UV/seam và Edit Mode topology).
 * Trả về MeshBVH hoặc null khi không build được.
 */
export function ensureBVH(mesh) {
  const geom = mesh?.geometry;
  if (!geom || !geom.attributes?.position || triangleCount(geom) < 1) {
    if (geom) geom.boundsTree = null;
    return null;
  }
  // Đang build trong worker: không build trùng trên main-thread (raycast tạm tuyến tính).
  if (_pending.has(geom)) return geom.boundsTree || null;
  const version = _geomVersion(geom);
  const prev = _state.get(geom);

  // Đã có boundsTree của chính geometry này (trong trường hợp module khác set trực tiếp)
  if (geom.boundsTree && prev && prev.uuid === version) return geom.boundsTree;

  if (prev && prev.uuid === version && prev.bvh) {
    geom.boundsTree = prev.bvh;
    return prev.bvh;
  }

  try {
    const bvh = new MeshBVH(geom, { maxLeafTris: 8, indirect: true });
    geom.boundsTree = bvh;
    _state.set(geom, { uuid: version, topo: _topoVersion(geom), bvh });
    return bvh;
  } catch (err) {
    console.warn('[BVH] build failed, fallback linear raycast:', err?.message);
    geom.boundsTree = null;
    return null;
  }
}

/**
 * Build BVH bất đồng bộ: mesh lớn đẩy sang Web Worker để không chặn UI; mesh nhỏ
 * hoặc không có Worker fallback về ensureBVH đồng bộ ngay. Trong lúc chờ, các lời
 * gọi ensureBVH đồng bộ trả null (raycast tuyến tính tạm) thay vì build trùng.
 */
export async function ensureBVHAsync(mesh, { minTriangles = WORKER_BVH_MIN_TRIANGLES } = {}) {
  const geom = mesh?.geometry;
  if (!geom?.attributes?.position || triangleCount(geom) < 1) return ensureBVH(mesh);
  if (!geometryWorkerAvailable() || triangleCount(geom) < minTriangles) return ensureBVH(mesh);
  if (_pending.has(geom)) return geom.boundsTree || null;
  const capturedVersion = _geomVersion(geom);
  const capturedDisposeGen = _disposedGen.get(geom) || 0;
  _pending.add(geom);
  try {
    const data = await buildBVHInWorker(geom);
    if ((_disposedGen.get(geom) || 0) !== capturedDisposeGen) {
      return null;
    }
    if (mesh?.geometry !== geom || _geomVersion(geom) !== capturedVersion) {
      return ensureBVH(mesh);
    }
    const bvh = MeshBVH.deserialize(data, geom, { setIndex: false });
    geom.boundsTree = bvh;
    _state.set(geom, { uuid: capturedVersion, topo: _topoVersion(geom), bvh });
    return bvh;
  } catch (err) {
    if ((_disposedGen.get(geom) || 0) !== capturedDisposeGen) {
      return null;
    }
    console.warn('[BVH] worker build failed, fallback CPU:', err?.message);
    return ensureBVH(mesh);
  } finally {
    _pending.delete(geom);
  }
}

/**
 * Patches THREE.Mesh.prototype.raycast once so every Three.js Raycaster call
 * transparently uses O(log N) BVH traversal whenever `geometry.boundsTree` exists
 * and falls back safely for skinned/multi-material/morph/partial-drawRange meshes.
 */
const ORIG_MESH_RAYCAST = THREE.Mesh.prototype.raycast;
export function installBVHRaycast() {
  if (THREE.Mesh.prototype.raycast?._wbsBVHPatched) return false;
  const orig = ORIG_MESH_RAYCAST;
  function wbsBvhMeshRaycast(raycaster, intersects) {
    const geom = this.geometry;
    const fullDrawRange = !geom?.drawRange || (geom.drawRange.start === 0 && geom.drawRange.count === Infinity);
    if (
      geom?.boundsTree &&
      fullDrawRange &&
      !this.isSkinnedMesh &&
      !Array.isArray(this.material) &&
      !this.morphTargetInfluences
    ) {
      return acceleratedRaycast.call(this, raycaster, intersects);
    }
    return orig.call(this, raycaster, intersects);
  }
  wbsBvhMeshRaycast._wbsBVHPatched = true;
  THREE.Mesh.prototype.raycast = wbsBvhMeshRaycast;
  return true;
}
installBVHRaycast();

/**
 * Raycast một Mesh qua BVH khi an toàn, tự động fallback về
 * `raycaster.intersectObject(mesh, false)` cho multi-material, skinned hoặc drawRange hẹp.
 */
export function raycastMeshAccelerated(mesh, raycaster) {
  if (!mesh || !raycaster) return [];
  const geom = mesh.geometry;
  const bvh = ensureBVH(mesh);
  const fullDrawRange = !geom?.drawRange || (geom.drawRange.start === 0 && geom.drawRange.count === Infinity);
  if (
    bvh &&
    fullDrawRange &&
    !mesh.isSkinnedMesh &&
    !Array.isArray(mesh.material) &&
    !mesh.morphTargetInfluences
  ) {
    const hits = [];
    const prevFirst = raycaster.firstHitOnly;
    raycaster.firstHitOnly = true;
    try {
      acceleratedRaycast.call(mesh, raycaster, hits);
    } finally {
      raycaster.firstHitOnly = prevFirst;
    }
    hits.sort((a, b) => a.distance - b.distance);
    return hits;
  }
  return raycaster.intersectObject(mesh, false);
}

/**
 * Refit nhanh sau khi đỉnh dịch chuyển trong phạm vi topology không đổi
 * (kéo Gizmo, sculpt). Chỉ rebuild khi topology thực sự thay đổi.
 */
export function refitBVH(mesh) {
  const geom = mesh?.geometry;
  if (!geom?.boundsTree) return ensureBVH(mesh);
  const topo = _topoVersion(geom);
  const prev = _state.get(geom);
  if (prev && prev.topo && prev.topo !== topo) return ensureBVH(mesh);
  try {
    geom.boundsTree.refit();
    _state.set(geom, { uuid: _geomVersion(geom), topo, bvh: geom.boundsTree });
  } catch (_) {
    ensureBVH(mesh);
  }
  return geom.boundsTree;
}

/** Giải phóng boundsTree (gọi khi xoá mesh hoặc thoát chế độ chỉnh sửa). */
export function disposeBVH(mesh) {
  const geom = mesh?.geometry || (mesh?.isBufferGeometry ? mesh : null);
  if (!geom) return;
  _disposedGen.set(geom, (_disposedGen.get(geom) || 0) + 1);
  if (geom.boundsTree && typeof geom.boundsTree.dispose === 'function') {
    geom.boundsTree.dispose();
  }
  geom.boundsTree = null;
  _state.delete(geom);
  _pending.delete(geom);
}
