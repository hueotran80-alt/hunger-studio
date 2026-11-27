/**
 * Prefab Library — thư viện tài sản 3D `.glb` cho AI Copilot & DSL (Giai đoạn 2.2).
 * File: js/scripting/prefab-library.js
 *
 * Mục tiêu: Copilot **lắp ghép tài sản chất lượng cao** thay vì chỉ ghép khối
 * hộp (`addCube`). Module này:
 *  - Giữ **catalog** prefab: id, tên hiển thị, đường dẫn `.glb`, từ khoá tìm
 *    kiếm, chiều cao thế giới quy ước (m) để tự scale về kích thước thật.
 *  - `prefabs.place(id, opts)` (dùng trong DSL `studio.*`) tải (cache 1 bản
 *    clone-ready) và đặt vào cảnh với scale/rotation theo ý Copilot.
 *  - `prefabs.describeForAI()` sinh đoạn văn bản ngắn để nhúng vào system
 *    prompt — Copilot biết *những gì có sẵn* và *gọi bằng API nào*.
 *
 * Thuần dữ liệu + THREE; không phụ thuộc DOM.
 */

import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';

// Chiều cao "thật" quy ước (mét) dùng auto-scale: asset được normalize về
// chiều cao này khi `height` không chỉ định rõ.
const PREFAB_CATALOG = [
  {
    id: 'mannequin',
    name: 'Mannequin CC0 (Rigged Humanoid Character)',
    url: 'models/Mannequin_CC0.glb',
    keywords: ['human', 'person', 'woman', 'female', 'mannequin', 'michelle', 'character', 'nguoi', 'nhan vat', 'dan', 'con nguoi'],
    naturalHeight: 1.66,
    rigged: true,
  },
  {
    id: 'bot',
    name: 'Bot CC0 (Rigged Armored Character)',
    url: 'models/Bot_CC0.glb',
    keywords: ['soldier', 'warrior', 'bot', 'robot', 'army', 'military', 'linh', 'chiến binh', 'nhan vat'],
    naturalHeight: 1.8,
    rigged: true,
  },
  {
    id: 'head_scan',
    name: 'LeePerry-Smith (Laser-Scanned Human Head)',
    url: 'models/LeePerrySmith.glb',
    keywords: ['head', 'face', 'portrait', 'scan', 'dau', 'mat', 'chan dung'],
    naturalHeight: 0.24,
    rigged: false,
  },
];

const PREFAB_ALIASES = {
  michelle: 'mannequin',
  soldier: 'bot',
};

/** Tách dấu + lowercase để so khớp từ khoá không dấu/chữ hoa. */
function _normalize(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd');
}

export class PrefabLibrary {
  constructor(options = {}) {
    this._studio = options.studio || null; // RapidStudio để đặt vào cảnh
    this._cache = new Map(); // url -> THREE.Object3D template (clone-ready)
    this._catalog = [...PREFAB_CATALOG];
  }

  bindStudio(studio) {
    this._studio = studio;
    return this;
  }

  /** Đăng ký thêm prefab ngoài (người dùng tự thêm asset .glb). */
  register(entry) {
    if (!entry?.id || !entry?.url) return null;
    const item = {
      name: entry.name || entry.id,
      keywords: entry.keywords || [],
      naturalHeight: Number(entry.naturalHeight) || 1.0,
      rigged: !!entry.rigged,
      ...entry,
    };
    const idx = this._catalog.findIndex((p) => p.id === item.id);
    if (idx >= 0) this._catalog[idx] = item;
    else this._catalog.push(item);
    return item;
  }

  get(id) {
    const resolved = PREFAB_ALIASES[id] || id;
    return this._catalog.find((p) => p.id === id) || this._catalog.find((p) => p.id === resolved) || null;
  }

  list() {
    return this._catalog.slice();
  }

  /**
   * Tìm prefab theo chuỗi mô tả tự nhiên ("một người lính đứng cạnh cây").
   * Trả về mảng prefab sắp xếp theo điểm khớp giảm dần.
   */
  search(query) {
    const q = _normalize(query);
    if (!q) return [];
    const scored = [];
    for (const p of this._catalog) {
      let score = 0;
      if (q.includes(_normalize(p.id))) score += 5;
      if (q.includes(_normalize(p.name))) score += 4;
      for (const kw of p.keywords) {
        if (q.includes(_normalize(kw))) score += 2;
      }
      if (score > 0) scored.push({ prefab: p, score });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.map((s) => s.prefab);
  }

  /** Nạp (và cache) template gốc của prefab; caller clone trước khi thêm cảnh. */
  async loadTemplate(prefabId) {
    const prefab = typeof prefabId === 'object' ? prefabId : this.get(prefabId);
    if (!prefab) throw new Error(`Prefab does not exist: ${prefabId}`);
    if (this._cache.has(prefab.url)) return this._cache.get(prefab.url);

    const studio = this._studio;
    if (!studio) throw new Error('PrefabLibrary not bound to studio (bindStudio())');

    const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
    const loader = new GLTFLoader();
    const gltf = await new Promise((resolve, reject) => {
      loader.load(prefab.url, resolve, undefined, reject);
    });
    const template = gltf.scene || gltf.scenes[0];
    // Chuẩn hoá: luôn normalize template về naturalHeight để clone không lệch scale
    if (prefab.naturalHeight > 0) {
      const box = new studio.THREE.Box3().setFromObject(template);
      const size = box.getSize(new studio.THREE.Vector3());
      if (size.y > 1e-6) {
        const s = prefab.naturalHeight / size.y;
        template.scale.setScalar(s);
      }
    }
    this._cache.set(prefab.url, template);
    return template;
  }

  /**
   * Đặt prefab vào cảnh (dùng trong DSL: `studio.placePrefab('soldier', {...})`).
   *
   * @param {string} prefabId
   * @param {{x?:number, y?:number, z?:number, height?:number, scale?:number,
   *          rotationY?:number, rotationX?:number, rotationZ?:number, name?:string}} opts
   * @returns {Promise<THREE.Object3D>}
   */
  async place(prefabId, opts = {}) {
    const prefab = this.get(prefabId);
    if (!prefab) throw new Error(`Prefab does not exist: ${prefabId}`);
    const template = await this.loadTemplate(prefab);
    const hasSkinned = Boolean(template?.traverse && (() => {
      let found = false;
      template.traverse((c) => { if (c.isSkinnedMesh) found = true; });
      return found;
    })());
    const clone = hasSkinned ? SkeletonUtils.clone(template) : template.clone(true);

    const THREE = this._studio.THREE;
    const name = opts.name || prefab.id;
    clone.name = name;
    clone.position.set(opts.x || 0, opts.y || 0, opts.z || 0);
    clone.rotation.set(opts.rotationX || 0, opts.rotationY || 0, opts.rotationZ || 0);

    // Scale: ưu tiên scale trực tiếp; nếu không thì height (m) mong muốn;
    // mặc định giữ naturalHeight (scale 1).
    let s = 1;
    if (opts.scale !== undefined) s = Number(opts.scale) || 1;
    else if (opts.height !== undefined && prefab.naturalHeight > 0) {
      s = (Number(opts.height) || prefab.naturalHeight) / prefab.naturalHeight;
    }
    clone.scale.multiplyScalar(s);

    // Soldier quay lưng camera trong file gốc — giữ quy ước như MocapUI
    if (/soldier/i.test(prefab.url)) clone.rotation.y += Math.PI;

    // Bóng đổ
    clone.traverse((child) => {
      if (child.isMesh) {
        child.castShadow = true;
        child.receiveShadow = true;
      }
    });

    this._studio._register(clone, name);
    return clone;
  }

  /**
   * Đoạn văn bản nhúng vào **system prompt của AI Copilot**: liệt kê prefab
   * có sẵn + cách gọi. Giữ ngắn để không ngốn token.
   */
  describeForAI() {
    const lines = this._catalog.map((p) => {
      const kw = (p.keywords || []).slice(0, 6).join(', ');
      return `  - id: "${p.id}" — ${p.name} · standard height ${p.naturalHeight}m${p.rigged ? ' · rigged' : ''} · keywords: ${kw}`;
    });
    return [
      'PREFAB LIBRARY (ALWAYS prefer using these before building from primitives):',
      ...lines,
      'Usage in code:',
      '  const char = await studio.placePrefab("mannequin", { x: 0, z: 0, height: 1.7, rotationY: 0.5 });',
      '  - `height` = desired height (meters) — auto-scaled; or pass `scale` directly.',
      '  - Whenever the user asks for a person/character, ALWAYS use placePrefab instead of building one from addCube/addSphere.',
    ].join('\n');
  }
}

/** Instance dùng chung toàn Studio (bind khi engine sẵn sàng). */
export const prefabLibrary = new PrefabLibrary();
