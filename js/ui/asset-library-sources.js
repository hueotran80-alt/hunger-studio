/**
 * Asset library sources:
 * - Legally redistributable online catalogs (Khronos CC0/CC-BY + Poly Haven CC0 studio library)
 * - Built-in studio library assets (`assets/characters/`, `assets/environments/`, `models/`)
 * - Categorized Fab / Quixel Megascans catalog as LINKS ONLY (Fab Standard License forbids
 *   standalone redistribution, so no Epic bytes are ever hosted or fetched by this app)
 * - Local-folder bridge for files the user acquired themselves.
 * File: js/ui/asset-library-sources.js
 */

export const FAB_LICENSE_NOTE =
  'Fab Standard License: dùng được mọi engine/công cụ, nhưng CẤM redistribute standalone. ' +
  'Mỗi người dùng phải tự acquire (free) trên Fab bằng account Epic của mình rồi import file vào Studio.';

export const STUDIO_CATEGORIES = [
  { id: 'all', label: 'Tất cả' },
  { id: 'materials', label: 'Chất liệu PBR' },
  { id: 'environments', label: 'Phong cảnh & HDRI' },
  { id: 'vegetation', label: 'Cây cỏ & Tự nhiên' },
  { id: 'architecture', label: 'Kiến trúc' },
  { id: 'characters', label: 'Nhân vật & Rig' },
  { id: 'props', label: 'Đồ vật & Props' },
];

// Only verified HTTP 200 landing/seller pages — never deep guessed product URLs.
export const FAB_CATALOG = [
  {
    id: 'fab_megascans',
    name: 'Quixel Megascans — All (~23.000 asset, free)',
    kind: 'fab',
    studioCategory: 'environments',
    productUrl: 'https://quixel.com/megascans',
    tags: ['megascans', 'scan', 'aaa', 'fab', 'epic', '23000'],
    license: 'Fab Standard License',
  },
  {
    id: 'fab_quixel_materials',
    name: 'Quixel Megascans — Chất liệu & Surfaces PBR',
    kind: 'fab',
    studioCategory: 'materials',
    productUrl: 'https://www.fab.com/sellers/Quixel%20Megascans?listing_types=material',
    tags: ['megascans', 'materials', 'surfaces', 'pbr', 'rock', 'wood', 'fab', 'epic'],
    license: 'Fab Standard License',
  },
  {
    id: 'fab_quixel_vegetation',
    name: 'Quixel Megascans — Cây cỏ, Thực vật & Địa hình 3D',
    kind: 'fab',
    studioCategory: 'vegetation',
    productUrl: 'https://www.fab.com/sellers/Quixel%20Megascans?listing_types=3d-model',
    tags: ['megascans', 'vegetation', 'plants', 'trees', 'nature', 'rocks', 'fab', 'epic'],
    license: 'Fab Standard License',
  },
  {
    id: 'fab_quixel_env',
    name: 'Quixel Megascans — Phong cảnh & Kiến trúc (Fab Store)',
    kind: 'fab',
    studioCategory: 'architecture',
    productUrl: 'https://www.fab.com/sellers/Quixel',
    tags: ['megascans', 'environments', 'architecture', 'rocks', 'fab', 'epic'],
    license: 'Fab Standard License',
  },
  {
    id: 'fab_free_content',
    name: 'Fab Free Content (Unreal & Community)',
    kind: 'fab',
    studioCategory: 'props',
    productUrl: 'https://www.fab.com/channels/unreal-engine',
    tags: ['fab', 'free', 'community', 'epic'],
    license: 'Fab Standard License',
  },
];

export const LOCAL_EXTENSIONS = [
  'glb', 'gltf', 'fbx', 'obj', 'vrm',
  '3ds', 'vox', 'usda', 'usd', 'usdz', 'dae', 'dxf', '3mf', 'off', 'stl', 'ply', 'zip',
];

const _polyhavenManifestCache = new Map();

export async function loadOnlineCatalog(url = '/assets/library/online-catalog.json') {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Catalog HTTP ${res.status}`);
  const json = await res.json();
  return (json.items || []).map((it) => ({
    studioCategory: it.category === 'Nature' ? 'vegetation' : 'props',
    ...it,
    kind: 'online',
  }));
}

export async function loadStudioCatalog(url = '/assets/library/studio-catalog.json') {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Studio catalog HTTP ${res.status}`);
  const json = await res.json();
  return (json.items || []).map((it) => ({
    ...it,
    kind: it.kind || 'online',
    studioCategory: it.studioCategory || 'props',
  }));
}

const NON_TEXTURE_MANIFEST_KEYS = new Set(['blend', 'gltf', 'glb', 'usd', 'fbx', 'mtlx', 'hdri', 'tonemapped', 'backplates']);

function pickImageUrl(files, key) {
  const entry = files?.[key];
  if (!entry || typeof entry !== 'object') return null;
  const bucket = entry['1k'] || entry['2k'] || entry['4k'] || null;
  if (!bucket || typeof bucket !== 'object') return null;
  return bucket.jpg?.url || bucket.png?.url || null;
}

function pickFirstChannel(files, exactKeys, regex = null) {
  for (const key of exactKeys) {
    const url = pickImageUrl(files, key);
    if (url) return { key, url };
  }
  if (regex && files && typeof files === 'object') {
    const candidates = Object.keys(files)
      .filter((k) => !NON_TEXTURE_MANIFEST_KEYS.has(k) && regex.test(k))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
    for (const key of candidates) {
      const url = pickImageUrl(files, key);
      if (url) return { key, url };
    }
  }
  return { key: null, url: null };
}

/**
 * Pure channel mapper for a Poly Haven `/files/{slug}` texture manifest.
 * Handles canonical (`Diffuse`, `nor_gl`, `Rough`, `Metal`, `AO`) as well as
 * variant channel names (`col_1`, `col_01`, `coll1`, `nor_dx`, `rough_ao`, `arm`).
 */
export function resolvePolyHavenTextureFiles(files = {}) {
  const diff = pickFirstChannel(
    files,
    ['Diffuse', 'diff', 'albedo', 'Color', 'color', 'base_color', 'BaseColor', 'col_1', 'col_01', 'col1', 'coll1'],
    /^(diff|diffuse|col|coll|albedo|base_?col)/i
  );
  const glNorm = pickFirstChannel(files, ['nor_gl', 'Normal', 'normal', 'nor']);
  const dxNorm = glNorm.url ? { key: null, url: null } : pickFirstChannel(files, ['nor_dx']);
  const normalUrl = glNorm.url || dxNorm.url || null;
  const normalFlipY = !glNorm.url && Boolean(dxNorm.url);

  const arm = pickFirstChannel(files, ['arm', 'ARM']);
  const rough = pickFirstChannel(files, ['Rough', 'rough', 'Roughness', 'roughness', 'rough_ao'], /^rough/i);
  const metal = pickFirstChannel(files, ['Metal', 'metal', 'Metallic', 'metallic', 'metalness'], /^metal/i);
  const ao = pickFirstChannel(files, ['AO', 'ao', 'AmbientOcclusion', 'rough_ao'], /^ao$/i);
  const bump = !normalUrl ? pickFirstChannel(files, ['Bump', 'bump', 'Displacement', 'disp']) : { key: null, url: null };

  const roughnessUrl = rough.url || arm.url || null;
  const metalnessUrl = metal.url || null;
  const aoUrl = ao.url || arm.url || null;

  return {
    phType: 'texture',
    diffuseUrl: diff.url || null,
    diffuseChannel: diff.key,
    normalUrl,
    normalFlipY,
    roughnessUrl,
    metalnessUrl,
    aoUrl,
    armUrl: arm.url || null,
    bumpUrl: bump.url || null,
  };
}

/**
 * Resolves exact download URLs (1k/2k GLTF, PBR texture maps, or HDRI) for a
 * Poly Haven CC0 asset from `https://api.polyhaven.com/files/{slug}`.
 */
export async function resolvePolyHavenAsset(slug, phType = 'model') {
  if (!slug) throw new Error('Thiếu mã asset Poly Haven.');
  const cacheKey = `${phType}:${slug}`;
  if (_polyhavenManifestCache.has(cacheKey)) {
    return _polyhavenManifestCache.get(cacheKey);
  }
  const res = await fetch(`https://api.polyhaven.com/files/${encodeURIComponent(slug)}`);
  if (!res.ok) throw new Error(`Poly Haven API HTTP ${res.status}`);
  const files = await res.json();

  let resolved;
  if (phType === 'hdri') {
    const bucket = files.hdri?.['1k'] || files.hdri?.['2k'] || {};
    const url = bucket.hdr?.url || bucket.exr?.url;
    if (!url) throw new Error(`Không tìm thấy HDRI .hdr cho "${slug}".`);
    resolved = { phType: 'hdri', hdrUrl: url };
  } else if (phType === 'texture') {
    resolved = resolvePolyHavenTextureFiles(files);
    if (!resolved.diffuseUrl && !resolved.normalUrl && !resolved.roughnessUrl && !resolved.metalnessUrl) {
      throw new Error(`Không tìm thấy texture PBR cho "${slug}".`);
    }
  } else {
    const gltfRes = files.gltf?.['1k'] || files.gltf?.['2k'] || {};
    const url = gltfRes.gltf?.url || gltfRes.glb?.url;
    if (!url) throw new Error(`Không tìm thấy file GLTF/GLB cho "${slug}".`);
    resolved = {
      phType: 'model',
      gltfUrl: url,
      gltfInclude: gltfRes.gltf?.include || gltfRes.glb?.include || {},
    };
  }

  _polyhavenManifestCache.set(cacheKey, resolved);
  return resolved;
}

export async function scanLocalDirectory(dirHandle, options = {}) {
  const maxDepth = Number.isFinite(options.maxDepth) ? Math.max(0, options.maxDepth) : 8;
  const out = [];
  const walk = async (handle, prefix, depth) => {
    for await (const entry of handle.values()) {
      const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.kind === 'directory') {
        if (depth < maxDepth && typeof entry.values === 'function') {
          await walk(entry, relPath, depth + 1);
        }
        continue;
      }
      if (entry.kind !== 'file') continue;
      const ext = (entry.name.split('.').pop() || '').toLowerCase();
      if (!LOCAL_EXTENSIONS.includes(ext)) continue;
      out.push({
        id: `local_${relPath}`,
        name: entry.name,
        relPath,
        kind: 'local',
        ext,
        handle: entry,
        tags: ['local', 'user-owned', ext],
        license: 'User-owned (Fab / tự tạo)',
      });
    }
  };
  await walk(dirHandle, '', 0);
  return out;
}

export function createLocalItemsFromFiles(fileList) {
  const out = [];
  const files = Array.from(fileList || []);
  for (let i = 0; i < files.length; i += 1) {
    const file = files[i];
    if (!file || !file.name) continue;
    const ext = (file.name.split('.').pop() || '').toLowerCase();
    if (!LOCAL_EXTENSIONS.includes(ext)) continue;
    const relPath = file.webkitRelativePath || `${i}_${file.name}`;
    out.push({
      id: `local_file_${relPath}`,
      name: file.name,
      relPath,
      kind: 'local',
      ext,
      file,
      tags: ['local', 'user-owned', ext],
      license: 'User-owned (Fab / tự tạo)',
    });
  }
  return out;
}

export async function importAssetFile(file, { exporter }) {
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  if (ext === 'glb' || ext === 'gltf' || ext === 'vrm') return exporter.importGLTF(file);
  if (ext === 'fbx') return exporter.importFBX(file);
  if (ext === 'obj') return exporter.importOBJ(file);
  if (ext === 'zip') return exporter.importBundle(file);
  if (LOCAL_EXTENSIONS.includes(ext) && typeof exporter.importUniversal === 'function') {
    return exporter.importUniversal(file);
  }
  throw new Error(`Định dạng .${ext} chưa hỗ trợ trong Asset Library`);
}

export function recordCredit(root, { id, name, author, license, source, url }) {
  if (!root) return null;
  if (!Array.isArray(root.userData.credits)) root.userData.credits = [];
  const existing = root.userData.credits.find((c) => c.id === id);
  if (existing) return existing;
  const credit = { id, name, author: author || 'Unknown', license, source, url: url || null };
  root.userData.credits.push(credit);
  return credit;
}

export function formatCredits(root) {
  const list = root?.userData?.credits || [];
  if (!list.length) return 'Chưa dùng asset bên thứ ba nào cần attribution.';
  return list.map((c) => `${c.name} — ${c.author} — ${c.license}${c.url ? ` — ${c.url}` : ''}`).join('\n');
}
