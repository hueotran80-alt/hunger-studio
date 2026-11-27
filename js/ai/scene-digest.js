/**
 * AI Copilot — Live Scene Digest.
 *
 * Mục tiêu: cho model biết **cảnh thật đang có gì** (hierarchy, poly count,
 * material, animation clip, selection) thay vì cờ boolean cố định.
 *
 * Thuần dữ liệu: không import three, không chạm DOM — nhận object kiểu Three.js
 * qua duck-typing nên test được bằng mock trong Node.
 *
 * Ngân sách: giới hạn số object + số ký tự để prompt không phình.
 */

const HELPER_TYPE = /(Helper|Gizmo|Grid|Axes|Outline|Beacon)/i;

function isHelper(object) {
  if (!object) return true;
  if (object.userData && (object.userData.isLightHelper || object.userData.isHelper || object.userData.excludeFromAgent)) {
    return true;
  }
  const type = String(object.type || '');
  if (HELPER_TYPE.test(type)) return true;
  return false;
}

function readTriangles(geometry) {
  if (!geometry) return 0;
  const index = geometry.index;
  if (index && Number.isFinite(index.count)) return Math.floor(index.count / 3);
  const position = geometry.attributes && geometry.attributes.position;
  if (position && Number.isFinite(position.count)) return Math.floor(position.count / 3);
  return 0;
}

function readVertices(geometry) {
  const position = geometry && geometry.attributes && geometry.attributes.position;
  return position && Number.isFinite(position.count) ? position.count : 0;
}

function readLocalSize(object) {
  const geom = object?.geometry;
  if (!geom) return null;
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  const bb = geom.boundingBox;
  if (bb && bb.min && bb.max) {
    minX = bb.min.x; minY = bb.min.y; minZ = bb.min.z;
    maxX = bb.max.x; maxY = bb.max.y; maxZ = bb.max.z;
  } else {
    const pos = geom.attributes?.position;
    const arr = pos?.array;
    const count = pos?.count || 0;
    if (!arr || count <= 0) return null;
    const step = Math.max(1, Math.floor(count / 512));
    for (let i = 0; i < count; i += step) {
      const o = i * 3;
      const x = arr[o], y = arr[o + 1], z = arr[o + 2];
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
    }
  }
  if (!Number.isFinite(minX)) return null;
  const sx = Math.abs(object.scale?.x ?? 1);
  const sy = Math.abs(object.scale?.y ?? 1);
  const sz = Math.abs(object.scale?.z ?? 1);
  return [round((maxX - minX) * sx), round((maxY - minY) * sy), round((maxZ - minZ) * sz)];
}

function materialNameList(material) {
  if (!material) return [];
  const list = Array.isArray(material) ? material : [material];
  return list
    .map((entry) => (entry && entry.name ? String(entry.name) : ''))
    .filter(Boolean);
}

function round(value, digits = 2) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  const factor = 10 ** digits;
  return Math.round(number * factor) / factor;
}

/**
 * @param {object|null} scene  Three.js Scene (hoặc mock tương đương)
 * @param {object} [options]
 * @param {string[]} [options.selection]  Tên object đang chọn
 * @param {number} [options.maxObjects]   Số object chi tiết tối đa (mặc định 24)
 * @param {number} [options.maxChars]     Giới hạn ký tự của prompt text (mặc định 1600)
 * @returns {object} digest
 */
export function buildSceneDigest(scene, options = {}) {
  const maxObjects = Number.isFinite(options.maxObjects) ? Math.max(1, options.maxObjects) : 24;
  const selection = Array.isArray(options.selection) ? options.selection.filter(Boolean).map(String) : [];

  const counts = {
    objects: 0,
    meshes: 0,
    groups: 0,
    lights: 0,
    cameras: 0,
    skinned: 0,
    bones: 0,
    vertices: 0,
    triangles: 0
  };
  const objects = [];
  const materials = new Set();
  const clips = new Set();
  let anonymous = 0;
  // Object không có tên vẫn phải có nhãn ổn định, nếu không prompt đầy "(unnamed)".
  const labelFor = (object, kind) => {
    const name = String(object.name || '').trim();
    if (name) return name;
    anonymous += 1;
    return `${kind}#${anonymous}`;
  };

  const visit = (object) => {
    if (!object || isHelper(object)) return;
    if (object.userData?.isSystemObject) {
      // Traverse inside Scene_Collection without counting the system container itself,
      // while skipping Studio_Lighting / GridHelper / gizmo system subtrees completely.
      if (/^scene_collection$/i.test(String(object.name || '')) && Array.isArray(object.children)) {
        for (const child of object.children) visit(child);
      }
      return;
    }
    counts.objects += 1;

    if (object.isBone) counts.bones += 1;
    if (object.isLight) counts.lights += 1;
    if (object.isCamera) counts.cameras += 1;
    if (object.isGroup || object.type === 'Group' || object.type === 'Scene') counts.groups += 1;

    if (object.isMesh || object.isSkinnedMesh) {
      counts.meshes += 1;
      if (object.isSkinnedMesh) counts.skinned += 1;
      const vertices = readVertices(object.geometry);
      const triangles = readTriangles(object.geometry);
      counts.vertices += vertices;
      counts.triangles += triangles;
      const matNames = materialNameList(object.material);
      const mat = matNames.join(' + ');
      for (const name of matNames) materials.add(name);
      const meshKind = object.isSkinnedMesh ? 'SkinnedMesh' : 'Mesh';
      objects.push({
        name: labelFor(object, meshKind),
        type: meshKind,
        vertices,
        triangles,
        material: mat,
        position: object.position ? [round(object.position.x), round(object.position.y), round(object.position.z)] : [0, 0, 0],
        size: readLocalSize(object),
        skinned: Boolean(object.isSkinnedMesh),
        morphTargets: Array.isArray(object.morphTargetInfluences) ? object.morphTargetInfluences.length : 0
      });
    } else if (object.isGroup || object.type === 'Group') {
      objects.push({
        name: labelFor(object, 'Group'),
        type: 'Group',
        vertices: 0,
        triangles: 0,
        material: '',
        position: object.position ? [round(object.position.x), round(object.position.y), round(object.position.z)] : [0, 0, 0],
        skinned: false,
        morphTargets: 0
      });
    }

    const animations = object.animations || object.userData?.animations;
    if (Array.isArray(animations)) {
      for (const clip of animations) {
        if (clip && clip.name) clips.add(String(clip.name));
      }
    }

    const children = object.children;
    if (Array.isArray(children)) {
      for (const child of children) visit(child);
    }
  };

  if (scene) {
    const roots = Array.isArray(scene.children) ? scene.children : [];
    for (const root of roots) visit(root);
  }

  objects.sort((a, b) => b.triangles - a.triangles || b.vertices - a.vertices || a.name.localeCompare(b.name));
  const truncated = objects.length > maxObjects;

  return {
    isEmpty: counts.objects === 0,
    counts: {
      ...counts,
      materials: materials.size,
      clips: clips.size
    },
    objects: objects.slice(0, maxObjects),
    materials: Array.from(materials).sort().slice(0, 24),
    clips: Array.from(clips).sort().slice(0, 16),
    selection,
    truncated
  };
}

/**
 * Chuyển digest thành text ngắn gọn để nhét vào system prompt.
 * @param {object} digest  kết quả buildSceneDigest
 * @param {object} [options]
 * @param {number} [options.maxChars]  mặc định 1600
 */
export function formatSceneDigestForPrompt(digest, options = {}) {
  if (!digest) return 'Scene digest unavailable.';
  const maxChars = Number.isFinite(options.maxChars) ? Math.max(200, options.maxChars) : 1600;

  if (digest.isEmpty) {
    return 'The scene is EMPTY (no user objects). Build the requested asset from scratch.';
  }

  const c = digest.counts;
  const lines = [];
  lines.push(
    `Scene: ${c.objects} objects (${c.meshes} meshes, ${c.groups} groups, ${c.lights} lights, ${c.cameras} cameras), ` +
    `${c.triangles} triangles / ${c.vertices} vertices, ${c.skinned} skinned, ${c.bones} bones.`
  );

  if (digest.selection.length) lines.push(`Selection: ${digest.selection.join(', ')}`);

  const shown = digest.objects.map((object) => {
    const mat = object.material ? `, mat: ${object.material}` : '';
    const morph = object.morphTargets ? `, ${object.morphTargets} morphs` : '';
    const tris = object.type === 'Group' ? '' : `, ${object.triangles} tris`;
    const pos = Array.isArray(object.position) ? `, pos:[${object.position.join(',')}]` : '';
    const sz = Array.isArray(object.size) ? `, size:[${object.size.join(',')}]` : '';
    return `- ${object.name} [${object.type}${tris}${pos}${sz}${mat}${morph}]`;
  });
  if (shown.length) {
    lines.push('Objects (largest first):');
    lines.push(...shown);
  }

  if (digest.truncated) lines.push(`(${c.objects - digest.objects.length} smaller objects omitted)`);
  if (digest.materials.length) lines.push(`Materials: ${digest.materials.join(', ')}`);
  if (digest.clips.length) lines.push(`Animation clips: ${digest.clips.join(', ')}`);
  lines.push('Build ON these objects. Do not recreate what already exists unless the user asks.');

  let text = lines.join('\n');
  if (text.length > maxChars) {
    text = `${text.slice(0, maxChars - 1).trimEnd()}…`;
  }
  return text;
}

/**
 * Loại bỏ các khối suy luận nội bộ `<think>...</think>` (kể cả thẻ mở chưa đóng
 * khi reasoning model bị cắt ngang bởi `max_tokens`) trước khi parse code/JSON.
 * @param {string} rawText
 * @returns {string}
 */
export function stripThinkingTags(rawText) {
  return String(rawText || '')
    .replace(/<think\b[^>]*>[\s\S]*?(?:<\/think>|$)/gi, '')
    .trim();
}
