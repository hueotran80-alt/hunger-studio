/**
 * Web Blender Studio — Rust WASM Multi-Format DCC / CAD / Studio & ZIP Bundle Importer
 * File: js/exporters/dcc-bundle-importer.js
 *
 * Combines:
 *   1. High-speed Rust WASM geometry & material parsers (`crates/mesh_kernel/src/importers.rs`):
 *      - Wavefront `.obj` + `.mtl` + ZBrush `#MRGB` Polypaint & vertex-color OBJ
 *      - Autodesk 3ds Max `.3ds` (binary chunk hierarchy + material groups + Z-up -> Y-up)
 *      - MagicaVoxel `.vox` (RIFF binary voxels + RGBA palette + 6-neighbor hidden-face culling)
 *      - Pixar / Apple USD `.usda` & `.usdz` (`Mesh` prims + `UsdPreviewSurface` + embedded textures)
 *      - AutoCAD / Rhino `.dxf` (`3DFACE` & Polyface `POLYLINE` + ACI layer colors)
 *      - 3D Manufacturing `.3mf` (`3dmodel.model` XML + `<basematerials>` colors)
 *      - Geomview / CGAL / Houdini `.off` / `COFF`
 *      - Collada `.dae` (Maya / Cinema 4D / SketchUp XML geometry + materials + textures)
 *   2. Smart Virtual File System (VFS) for `.zip` archives, macOS Finder folder drag-and-drop,
 *      and multi-file selection (`.obj` + `.mtl` + `textures/*`, `.gltf` + `.bin` + `textures/*`,
 *      `.fbx` + `textures/*`), automatically stripping stale Windows/macOS absolute paths and
 *      auto-matching PBR texture channels (`basecolor/diff`, `normal`, `roughness`, `metallic`, `alpha`).
 */

import * as THREE from 'three';
import { unzipSync } from 'three/addons/libs/fflate.module.js';
import {
  initMeshKernel,
  isMeshKernelReady,
  parseDccModelInWasm,
  DCC_FORMAT_IDS,
} from '../core/mesh-kernel-bridge.js';

export const RUST_DCC_EXTENSIONS = new Set([
  'obj', '3ds', 'vox', 'usda', 'usd', 'usdz', 'dxf', '3mf', 'off', 'coff', 'dae',
]);

export const TEXTURE_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'avif', 'svg',
]);

export const MODEL_PRIORITY_EXTENSIONS = [
  'glb', 'gltf', 'vrm', 'fbx', 'obj', '3ds', 'dae', 'usda', 'usd', 'usdz', 'vox', '3mf', 'dxf', 'stl', 'ply', 'off', 'coff', 'blend',
];

function getExt(name) {
  const clean = String(name || '').split('?')[0].split('#')[0].replace(/\\/g, '/');
  const base = clean.split('/').pop() || '';
  const dot = base.lastIndexOf('.');
  return dot >= 0 ? base.slice(dot + 1).toLowerCase() : '';
}

function getStem(name) {
  const clean = String(name || '').split('?')[0].split('#')[0].replace(/\\/g, '/');
  const base = clean.split('/').pop() || '';
  const dot = base.lastIndexOf('.');
  return (dot >= 0 ? base.slice(0, dot) : base).toLowerCase();
}

function normalizePath(p) {
  return String(p || '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^[a-zA-Z]:\//, '')
    .replace(/^(\.\/)+/, '')
    .replace(/^\/+/, '');
}

function guessMime(ext) {
  switch (ext) {
    case 'png': return 'image/png';
    case 'jpg':
    case 'jpeg': return 'image/jpeg';
    case 'webp': return 'image/webp';
    case 'gif': return 'image/gif';
    case 'bmp': return 'image/bmp';
    case 'svg': return 'image/svg+xml';
    case 'glb': return 'model/gltf-binary';
    case 'gltf': return 'model/gltf+json';
    default: return 'application/octet-stream';
  }
}

/**
 * Virtual File System indexing companion files (`.mtl`, `.bin`, textures) from a `.zip` or multi-file drop.
 */
export class VirtualAssetVFS {
  constructor() {
    /** @type {Array<{ path: string, lowerPath: string, base: string, stem: string, ext: string, bytes?: Uint8Array, file?: File }>} */
    this.entries = [];
    this._blobUrls = new Map();
  }

  addBytes(path, bytes) {
    const norm = normalizePath(path);
    if (!norm || norm.endsWith('/') || norm.includes('__MACOSX/') || norm.split('/').pop()?.startsWith('._')) {
      return;
    }
    const base = (norm.split('/').pop() || norm).toLowerCase();
    this.entries.push({
      path: norm,
      lowerPath: norm.toLowerCase(),
      base,
      stem: getStem(base),
      ext: getExt(base),
      bytes: bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes),
    });
  }

  addFile(file, relativePath = '') {
    const norm = normalizePath(relativePath || file.webkitRelativePath || file.name);
    if (!norm || norm.includes('__MACOSX/') || norm.split('/').pop()?.startsWith('._')) return;
    const base = (norm.split('/').pop() || norm).toLowerCase();
    this.entries.push({
      path: norm,
      lowerPath: norm.toLowerCase(),
      base,
      stem: getStem(base),
      ext: getExt(base),
      file,
    });
  }

  async getBytes(entry) {
    if (!entry) return null;
    if (entry.bytes) return entry.bytes;
    if (entry.file) {
      entry.bytes = new Uint8Array(await entry.file.arrayBuffer());
      return entry.bytes;
    }
    return null;
  }

  async getBlobUrl(entry) {
    if (!entry) return null;
    if (this._blobUrls.has(entry.lowerPath)) return this._blobUrls.get(entry.lowerPath);
    if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') return null;
    let blob;
    if (entry.file) {
      blob = entry.file;
    } else {
      const bytes = await this.getBytes(entry);
      if (!bytes) return null;
      blob = new Blob([bytes], { type: guessMime(entry.ext) });
    }
    const url = URL.createObjectURL(blob);
    this._blobUrls.set(entry.lowerPath, url);
    return url;
  }

  /**
   * Resolves a referenced path (even if it contains artist machine paths like `C:\Users\...\textures\leaf.tga`)
   * against VFS entries by exact path, suffix path, basename, or stem fallback across texture formats.
   */
  resolve(refPath, { allowTextureStemFallback = true } = {}) {
    if (!refPath) return null;
    let decoded = String(refPath);
    try { decoded = decodeURIComponent(decoded); } catch (_) {}
    const norm = normalizePath(decoded).toLowerCase();
    if (!norm) return null;
    const base = norm.split('/').pop() || norm;

    // 1. Exact path match
    const exact = this.entries.find((e) => e.lowerPath === norm);
    if (exact) return exact;

    // 2. Suffix path match
    const suffix = this.entries.find((e) => e.lowerPath.endsWith(`/${norm}`) || norm.endsWith(`/${e.lowerPath}`));
    if (suffix) return suffix;

    // 3. Basename match
    const byBase = this.entries.find((e) => e.base === base);
    if (byBase) return byBase;

    // 4. Stem match across image formats (e.g. `.tga` / `.tif` in `.mtl`/`.3ds` matched to `.png`/`.jpg`)
    if (allowTextureStemFallback) {
      const stem = getStem(base);
      if (stem) {
        const byStem = this.entries.find((e) => TEXTURE_EXTENSIONS.has(e.ext) && e.stem === stem);
        if (byStem) return byStem;
      }
    }
    return null;
  }

  findPrimaryModel() {
    for (const ext of MODEL_PRIORITY_EXTENSIONS) {
      const hit = this.entries.find((e) => e.ext === ext);
      if (hit) return hit;
    }
    return null;
  }

  findCompanionMtl(objEntry) {
    const mtls = this.entries.filter((e) => e.ext === 'mtl');
    if (mtls.length === 0) return null;
    if (objEntry) {
      const sameStem = mtls.find((m) => m.stem === objEntry.stem);
      if (sameStem) return sameStem;
    }
    return mtls[0];
  }

  textureEntries() {
    return this.entries.filter((e) => TEXTURE_EXTENSIONS.has(e.ext));
  }

  disposeBlobUrls() {
    if (typeof URL !== 'undefined' && typeof URL.revokeObjectURL === 'function') {
      for (const u of this._blobUrls.values()) {
        try { URL.revokeObjectURL(u); } catch (_) {}
      }
    }
    this._blobUrls.clear();
  }
}

/**
 * Recursively extracts dropped files AND folders from a DragEvent `dataTransfer`.
 * @param {DataTransfer} dataTransfer
 * @returns {Promise<Array<{ file: File, path: string }>>}
 */
export async function extractDroppedItems(dataTransfer) {
  const out = [];
  if (!dataTransfer) return out;

  const readEntry = async (entry, prefix = '') => {
    if (!entry) return;
    if (entry.isFile) {
      const file = await new Promise((res) => entry.file(res, () => res(null)));
      if (file) {
        out.push({ file, path: prefix ? `${prefix}/${file.name}` : file.name });
      }
    } else if (entry.isDirectory && typeof entry.createReader === 'function') {
      const reader = entry.createReader();
      const children = [];
      while (true) {
        const batch = await new Promise((res) => reader.readEntries(res, () => res([])));
        if (!batch || batch.length === 0) break;
        children.push(...batch);
      }
      const nextPrefix = prefix ? `${prefix}/${entry.name}` : entry.name;
      for (const ch of children) {
        await readEntry(ch, nextPrefix);
      }
    }
  };

  if (dataTransfer.items && dataTransfer.items.length > 0) {
    const entries = [];
    for (let i = 0; i < dataTransfer.items.length; i++) {
      const item = dataTransfer.items[i];
      if (typeof item.webkitGetAsEntry === 'function') {
        const ent = item.webkitGetAsEntry();
        if (ent) entries.push(ent);
      }
    }
    if (entries.length > 0) {
      for (const ent of entries) {
        await readEntry(ent, '');
      }
      if (out.length > 0) return out;
    }
  }

  if (dataTransfer.files) {
    for (let i = 0; i < dataTransfer.files.length; i++) {
      const f = dataTransfer.files[i];
      out.push({ file: f, path: f.webkitRelativePath || f.name });
    }
  }
  return out;
}

/**
 * Loads a Three.js Texture from a VFS entry cleanly in both Browser (`HTMLImageElement`)
 * and headless Node (`DataTexture` placeholder with preserved name & metadata).
 */
async function loadTextureFromVfsEntry(vfs, entry, { srgb = true } = {}) {
  if (!entry) return null;

  if (typeof document !== 'undefined' && typeof Image !== 'undefined') {
    const blobUrl = await vfs.getBlobUrl(entry);
    if (blobUrl) {
      try {
        const img = await new Promise((resolve, reject) => {
          const el = new Image();
          el.crossOrigin = 'anonymous';
          el.onload = () => resolve(el);
          el.onerror = () => reject(new Error(`Failed to decode image ${entry.path}`));
          el.src = blobUrl;
        });
        const tex = new THREE.Texture(img);
        tex.name = entry.base;
        tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
        tex.wrapS = THREE.RepeatWrapping;
        tex.wrapT = THREE.RepeatWrapping;
        tex.needsUpdate = true;
        return tex;
      } catch (err) {
        console.warn('[DCCImporter] Image decode warning:', err?.message || err);
      }
    }
  }

  // Headless Node fallback: construct 2x2 DataTexture so unit tests can verify map binding without DOM Image
  const data = new Uint8Array([
    220, 220, 220, 255,
    180, 220, 180, 255,
    180, 220, 180, 255,
    220, 220, 220, 255,
  ]);
  const tex = new THREE.DataTexture(data, 2, 2, THREE.RGBAFormat);
  tex.name = entry.base;
  tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Heuristic auto-matcher for loose PBR texture files when an `.obj`/`.3ds`/`.fbx` lacks `.mtl` map links.
 */
function autoMatchLoosePbrTextures(matSpec, submeshName, texEntries, totalMaterials) {
  if (!texEntries || texEntries.length === 0) return;
  const matHint = String(matSpec.name || '').toLowerCase().replace(/^mat_/, '');
  const meshHint = String(submeshName || '').toLowerCase();

  const candidates = texEntries.filter((e) => {
    if (totalMaterials <= 1) return true;
    return (matHint && e.stem.includes(matHint)) || (meshHint && e.stem.includes(meshHint));
  });
  const pool = candidates.length > 0 ? candidates : (totalMaterials <= 1 ? texEntries : []);
  if (pool.length === 0) return;

  for (const e of pool) {
    const s = e.stem;
    if (!matSpec.mapKd && /(diff|albedo|base_?color|col|diffuse|tex)/i.test(s) && !/(norm|rough|metal|spec|ao|occ|bump|disp|height|alpha|opac)/i.test(s)) {
      matSpec.mapKd = e.path;
    } else if (!matSpec.mapNormal && /(norm|nor_gl|nor_dx|_nrm|_nor|bump)/i.test(s)) {
      matSpec.mapNormal = e.path;
    } else if (!matSpec.mapRoughness && /(rough|_rgh)/i.test(s)) {
      matSpec.mapRoughness = e.path;
    } else if (!matSpec.mapMetallic && /(metal|_met)/i.test(s)) {
      matSpec.mapMetallic = e.path;
    } else if (!matSpec.mapAlpha && /(alpha|opac|mask)/i.test(s)) {
      matSpec.mapAlpha = e.path;
    }
  }

  // If there is exactly 1 image in a single-material bundle and still no mapKd, treat it as Base Color
  if (!matSpec.mapKd && totalMaterials <= 1 && pool.length === 1) {
    matSpec.mapKd = pool[0].path;
  }
}

/**
 * Builds a Three.js `Object3D` (`Mesh` or `Group`) from Rust WASM `parseDccModelInWasm` output + `VirtualAssetVFS`.
 */
export async function buildThreeObjectFromWasmImport(wasmRes, vfs, rootName = 'Imported_Model') {
  if (!wasmRes || wasmRes.triangleCount === 0) return null;
  const { positions, normals, uvs, colors, indices, meta } = wasmRes;
  const matSpecs = Array.isArray(meta?.materials) ? meta.materials : [];
  const subSpecs = Array.isArray(meta?.submeshes) ? meta.submeshes : [];
  const texEntries = vfs ? vfs.textureEntries() : [];

  // Ensure at least 1 material if textures exist in bundle
  if (matSpecs.length === 0 && texEntries.length > 0) {
    matSpecs.push({
      name: `${rootName}_Material`,
      color: [1, 1, 1],
      emissive: [0, 0, 0],
      roughness: 0.6,
      metalness: 0.05,
      opacity: 1.0,
      doubleSided: false,
      mapKd: '',
      mapNormal: '',
      mapRoughness: '',
      mapMetallic: '',
      mapEmissive: '',
      mapAlpha: '',
    });
    for (const sm of subSpecs) {
      if (sm.materialIndex < 0) sm.materialIndex = 0;
    }
  }

  const hasVertexColorsGlobal = colors.length === positions.length && colors.length > 0;
  const texCache = new Map();
  const getTex = async (refPath, srgb) => {
    if (!vfs || !refPath) return null;
    const entry = vfs.resolve(refPath);
    if (!entry) return null;
    const key = `${entry.lowerPath}:${srgb ? 1 : 0}`;
    if (!texCache.has(key)) {
      texCache.set(key, await loadTextureFromVfsEntry(vfs, entry, { srgb }));
    }
    return texCache.get(key);
  };

  // Build Three.js PBR materials
  const builtMaterials = [];
  for (let mi = 0; mi < matSpecs.length; mi++) {
    const spec = { ...matSpecs[mi] };
    const ownerSub = subSpecs.find((s) => s.materialIndex === mi);
    autoMatchLoosePbrTextures(spec, ownerSub?.name || rootName, texEntries, matSpecs.length);

    const [map, normalMap, roughnessMap, metalnessMap, emissiveMap, alphaMap] = await Promise.all([
      getTex(spec.mapKd, true),
      getTex(spec.mapNormal, false),
      getTex(spec.mapRoughness, false),
      getTex(spec.mapMetallic, false),
      getTex(spec.mapEmissive, true),
      getTex(spec.mapAlpha, false),
    ]);

    const colArr = Array.isArray(spec.color) ? spec.color : [0.85, 0.85, 0.85];
    // When a diffuse texture is bound and material color was pure black (common quirk in 3ds/OBJ exporters), lift to white
    const isZeroBlack = colArr[0] <= 0.001 && colArr[1] <= 0.001 && colArr[2] <= 0.001;
    const finalCol = map && isZeroBlack ? new THREE.Color(1, 1, 1) : new THREE.Color(colArr[0], colArr[1], colArr[2]);
    const emArr = Array.isArray(spec.emissive) ? spec.emissive : [0, 0, 0];
    const opacity = Number.isFinite(spec.opacity) ? spec.opacity : 1.0;

    const mat = new THREE.MeshStandardMaterial({
      name: spec.name || `Material_${mi}`,
      color: finalCol,
      emissive: new THREE.Color(emArr[0], emArr[1], emArr[2]),
      roughness: roughnessMap ? 1.0 : (Number.isFinite(spec.roughness) ? spec.roughness : 0.55),
      metalness: metalnessMap ? 1.0 : (Number.isFinite(spec.metalness) ? spec.metalness : 0.05),
      opacity,
      transparent: opacity < 0.999,
      alphaMap: alphaMap || null,
      alphaTest: alphaMap ? 0.4 : 0.0,
      map: map || null,
      normalMap: normalMap || null,
      roughnessMap: roughnessMap || null,
      metalnessMap: metalnessMap || null,
      emissiveMap: emissiveMap || null,
      vertexColors: hasVertexColorsGlobal && !map,
      side: (spec.doubleSided || alphaMap) ? THREE.DoubleSide : THREE.FrontSide,
    });
    builtMaterials.push(mat);
  }

  const fallbackMat = new THREE.MeshStandardMaterial({
    name: `${rootName}_Material`,
    color: hasVertexColorsGlobal ? 0xffffff : 0xd2d5da,
    roughness: 0.6,
    metalness: 0.05,
    vertexColors: hasVertexColorsGlobal,
  });

  const hasUvs = uvs.length === (positions.length / 3) * 2 && uvs.length > 0;
  const hasNormals = normals.length === positions.length && normals.length > 0;

  // Compact each submesh into its own clean BufferGeometry + Mesh so Outliner & per-part materials work like Blender!
  const buildSubMesh = (sub) => {
    const start = sub.indexStart >>> 0;
    const count = sub.indexCount >>> 0;
    const usedMap = new Map();
    const sPos = [];
    const sNorm = [];
    const sUv = [];
    const sCol = [];
    const sIdx = new Uint32Array(count);

    for (let i = 0; i < count; i++) {
      const oldVi = indices[start + i];
      let newVi = usedMap.get(oldVi);
      if (newVi === undefined) {
        newVi = sPos.length / 3;
        usedMap.set(oldVi, newVi);
        sPos.push(positions[oldVi * 3], positions[oldVi * 3 + 1], positions[oldVi * 3 + 2]);
        if (hasNormals) {
          sNorm.push(normals[oldVi * 3], normals[oldVi * 3 + 1], normals[oldVi * 3 + 2]);
        }
        if (hasUvs) {
          sUv.push(uvs[oldVi * 2], uvs[oldVi * 2 + 1]);
        }
        if (hasVertexColorsGlobal) {
          sCol.push(colors[oldVi * 3], colors[oldVi * 3 + 1], colors[oldVi * 3 + 2]);
        }
      }
      sIdx[i] = newVi;
    }

    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(sPos), 3));
    if (hasNormals) {
      geom.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(sNorm), 3));
    } else {
      geom.computeVertexNormals();
    }
    if (hasUvs) {
      geom.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(sUv), 2));
    }
    if (hasVertexColorsGlobal) {
      geom.setAttribute('color', new THREE.BufferAttribute(new Float32Array(sCol), 3));
    }
    geom.setIndex(new THREE.BufferAttribute(sIdx, 1));
    geom.computeBoundingBox();
    geom.computeBoundingSphere();

    const mat = (sub.materialIndex >= 0 && builtMaterials[sub.materialIndex])
      ? builtMaterials[sub.materialIndex]
      : fallbackMat.clone();
    const mesh = new THREE.Mesh(geom, mat);
    mesh.name = sub.name || rootName;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.userData.__importedMaterial = mat.clone();
    return mesh;
  };

  if (subSpecs.length === 1) {
    const single = buildSubMesh(subSpecs[0]);
    single.name = rootName;
    return single;
  }

  const group = new THREE.Group();
  group.name = rootName;
  for (const sub of subSpecs) {
    if (sub.indexCount >= 3) {
      group.add(buildSubMesh(sub));
    }
  }
  return group;
}

/**
 * Parses a single Rust-supported DCC / CAD / Studio file (or ZIP/USDZ/3MF archive) via WASM.
 */
export async function importDccWithRustWasm(mainEntry, vfs, rootName = 'Imported_Model') {
  if (!isMeshKernelReady()) {
    await initMeshKernel();
  }
  const ext = mainEntry.ext;
  const bytes = await vfs.getBytes(mainEntry);
  if (!bytes || bytes.byteLength === 0) {
    throw new Error(`Empty file: ${mainEntry.path}`);
  }

  if (ext === 'usdz') {
    const entries = unzipSync(bytes);
    for (const [entryPath, entryBytes] of Object.entries(entries)) {
      vfs.addBytes(entryPath, entryBytes);
    }
    const usdaEntry = vfs.entries.find((e) => e.ext === 'usda' || (e.ext === 'usd' && ! isUsdcCrate(e.bytes)));
    if (!usdaEntry) {
      const hasCrate = vfs.entries.some((e) => isUsdcCrate(e.bytes));
      if (hasCrate) {
        throw new Error('This .usdz contains Apple binary Crate (.usdc) instead of ASCII .usda. Please export as .glb or .usda.');
      }
      throw new Error('No readable .usda scene found inside .usdz archive.');
    }
    const usdaBytes = await vfs.getBytes(usdaEntry);
    const wasmRes = parseDccModelInWasm('usda', usdaBytes, null);
    return await buildThreeObjectFromWasmImport(wasmRes, vfs, rootName);
  }

  if (ext === '3mf') {
    // `.3mf` can be either a ZIP OPC package (`3D/3dmodel.model`) or raw XML
    const isZip = bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b;
    let xmlBytes = bytes;
    if (isZip) {
      const entries = unzipSync(bytes);
      const modelKey = Object.keys(entries).find((k) => k.toLowerCase().endsWith('.model'));
      if (!modelKey) throw new Error('Invalid .3mf archive: missing 3D/*.model XML.');
      xmlBytes = entries[modelKey];
    }
    const wasmRes = parseDccModelInWasm('3mf', xmlBytes, null);
    return await buildThreeObjectFromWasmImport(wasmRes, vfs, rootName);
  }

  if (ext === 'usd' && isUsdcCrate(bytes)) {
    throw new Error('Binary Crate (.usdc) detected; use ASCII .usda or .glb for direct browser import.');
  }

  let auxBytes = null;
  if (ext === 'obj') {
    // Check `mtllib` inside OBJ or matching `.mtl` in VFS
    const mtlEntry = vfs.findCompanionMtl(mainEntry);
    if (mtlEntry) {
      auxBytes = await vfs.getBytes(mtlEntry);
    }
  }

  const fmtKey = DCC_FORMAT_IDS[ext] ? ext : null;
  if (!fmtKey) {
    throw new Error(`Unsupported Rust DCC format: .${ext}`);
  }

  const wasmRes = parseDccModelInWasm(fmtKey, bytes, auxBytes);
  if (!wasmRes || wasmRes.triangleCount === 0) {
    throw new Error(`No valid 3D mesh geometry found in "${mainEntry.path}".`);
  }
  return await buildThreeObjectFromWasmImport(wasmRes, vfs, rootName);
}

function isUsdcCrate(bytes) {
  return Boolean(
    bytes &&
    bytes.length >= 8 &&
    bytes[0] === 0x50 && bytes[1] === 0x58 && bytes[2] === 0x52 && bytes[3] === 0x2d &&
    bytes[4] === 0x55 && bytes[5] === 0x53 && bytes[6] === 0x44 && bytes[7] === 0x43
  );
}
