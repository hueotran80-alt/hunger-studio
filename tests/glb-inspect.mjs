/**
 * Web Blender Studio — GLB 2.0 inspector for the export tests (Giai đoạn 1.3)
 * File: tests/glb-inspect.mjs
 *
 * Không phụ thuộc Three.js / DOM nên dùng được cả trong Node lẫn trình duyệt.
 * Mục đích: đọc thẳng file .glb xuất ra (JSON chunk + BIN chunk) rồi giải mã
 * accessor của các animation sampler để chứng minh dữ liệu chuyển động **thật sự
 * nằm trong file**, chứ không chỉ có tên clip trong metadata.
 */

export const GLB_MAGIC = 0x46546c67; // 'glTF'
export const CHUNK_JSON = 0x4e4f534a; // 'JSON'
export const CHUNK_BIN = 0x004e4942; // 'BIN\0'

const COMPONENT = {
  5120: { read: 'getInt8', size: 1, normDiv: 127 },
  5121: { read: 'getUint8', size: 1, normDiv: 255 },
  5122: { read: 'getInt16', size: 2, normDiv: 32767 },
  5123: { read: 'getUint16', size: 2, normDiv: 65535 },
  5125: { read: 'getUint32', size: 4, normDiv: 1 },
  5126: { read: 'getFloat32', size: 4, normDiv: 1 },
};

const ITEM_SIZE = {
  SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16,
};

function toBytes(buffer) {
  // `instanceof` fails when the buffer comes from another realm (the export
  // happens inside the Studio iframe), so brand-check by tag instead.
  if (ArrayBuffer.isView(buffer)) {
    return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  }
  const tag = Object.prototype.toString.call(buffer);
  if (tag === '[object ArrayBuffer]' || tag === '[object SharedArrayBuffer]') {
    return new Uint8Array(buffer);
  }
  throw new Error(`GLB: cần ArrayBuffer / Uint8Array (nhận ${tag})`);
}

/**
 * Splits a .glb container into its header, JSON document and binary chunk.
 * @param {ArrayBuffer|Uint8Array} buffer
 * @returns {{version:number, length:number, json:Object, bin:Uint8Array|null, chunks:Array<{type:number,length:number}>}}
 */
export function parseGLB(buffer) {
  const bytes = toBytes(buffer);
  if (bytes.byteLength < 20) throw new Error(`GLB quá nhỏ: ${bytes.byteLength} byte`);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  const magic = dv.getUint32(0, true);
  if (magic !== GLB_MAGIC) throw new Error(`Sai magic 0x${magic.toString(16)} — không phải GLB`);
  const version = dv.getUint32(4, true);
  const length = dv.getUint32(8, true);
  if (version !== 2) throw new Error(`GLB version ${version}, chỉ hỗ trợ 2`);
  if (length !== bytes.byteLength) {
    throw new Error(`Header ghi ${length} byte nhưng file có ${bytes.byteLength} byte`);
  }

  let offset = 12;
  let json = null;
  let bin = null;
  const chunks = [];
  while (offset + 8 <= length) {
    const chunkLength = dv.getUint32(offset, true);
    const chunkType = dv.getUint32(offset + 4, true);
    const start = offset + 8;
    if (start + chunkLength > length) {
      throw new Error(`Chunk vượt quá cuối file (type 0x${chunkType.toString(16)})`);
    }
    const payload = bytes.subarray(start, start + chunkLength);
    chunks.push({ type: chunkType, length: chunkLength });
    if (chunkType === CHUNK_JSON) {
      if (json) throw new Error('GLB có nhiều hơn một JSON chunk');
      json = JSON.parse(new TextDecoder().decode(payload));
    } else if (chunkType === CHUNK_BIN) {
      bin = payload;
    }
    offset = start + chunkLength;
  }

  if (!json) throw new Error('GLB thiếu JSON chunk');
  return { version, length, json, bin, chunks };
}

/**
 * Decodes one accessor into a flat Float64Array (normalized integers are scaled).
 * Sparse accessors are rejected on purpose: GLTFExporter never writes them, so a
 * file that contains one means something unexpected happened.
 */
export function readAccessor(gltf, bin, index) {
  const accessor = gltf.accessors?.[index];
  if (!accessor) throw new Error(`Accessor #${index} không tồn tại`);
  if (accessor.sparse) throw new Error(`Accessor #${index} dùng sparse — không hỗ trợ trong test`);

  const comp = COMPONENT[accessor.componentType];
  if (!comp) throw new Error(`componentType ${accessor.componentType} lạ`);
  const itemSize = ITEM_SIZE[accessor.type];
  if (!itemSize) throw new Error(`type ${accessor.type} lạ`);

  const count = accessor.count;
  const out = new Float64Array(count * itemSize);
  if (count === 0) return { count, itemSize, values: out, min: accessor.min, max: accessor.max };
  if (accessor.bufferView === undefined) {
    throw new Error(`Accessor #${index} không có bufferView (chưa hỗ trợ accessor mặc định)`);
  }
  if (!bin) throw new Error('GLB không có BIN chunk nhưng accessor cần dữ liệu nhị phân');

  const view = gltf.bufferViews[accessor.bufferView];
  const elementBytes = comp.size * itemSize;
  const stride = view.byteStride || elementBytes;
  const base = (view.byteOffset || 0) + (accessor.byteOffset || 0);
  const dv = new DataView(bin.buffer, bin.byteOffset, bin.byteLength);
  const scale = accessor.normalized ? 1 / comp.normDiv : 1;

  for (let i = 0; i < count; i++) {
    const itemBase = base + i * stride;
    for (let c = 0; c < itemSize; c++) {
      out[i * itemSize + c] = dv[comp.read](itemBase + c * comp.size, true) * scale;
    }
  }
  return { count, itemSize, values: out, min: accessor.min, max: accessor.max };
}

/**
 * Turns `animations[]` into plain JS objects with decoded keyframe times/values
 * and the *name* of the node each channel drives.
 */
export function inspectAnimations(gltf, bin) {
  return (gltf.animations || []).map((animation, index) => {
    const channels = (animation.channels || []).map((channel) => {
      const sampler = animation.samplers?.[channel.sampler];
      if (!sampler) throw new Error(`Animation #${index} thiếu sampler ${channel.sampler}`);
      const input = readAccessor(gltf, bin, sampler.input);
      const output = readAccessor(gltf, bin, sampler.output);
      const times = Array.from(input.values);
      const stride = output.itemSize;
      const values = [];
      for (let k = 0; k < output.count; k++) {
        values.push(Array.from(output.values.subarray(k * stride, (k + 1) * stride)));
      }
      const nodeIndex = channel.target?.node;
      const nodeName = nodeIndex === undefined ? '(thiếu node)' : (gltf.nodes?.[nodeIndex]?.name || `#${nodeIndex}`);
      return {
        node: nodeIndex,
        nodeName,
        path: channel.target?.path,
        interpolation: sampler.interpolation || 'LINEAR',
        times,
        values,
        keyCount: times.length,
      };
    });

    const times = channels.flatMap((c) => c.times);
    return {
      name: animation.name || '',
      channels,
      keys: times.length,
      start: times.length ? Math.min(...times) : 0,
      duration: times.length ? Math.max(...times) : 0,
      targets: channels.map((c) => `${c.nodeName}.${c.path}`),
    };
  });
}

/**
 * End-to-end structural verification of an animated .glb.
 * Returns a report instead of throwing so both suites can print *all* problems.
 *
 * @param {ArrayBuffer|Uint8Array} buffer
 * @param {Object} [expect]
 * @param {string} [expect.clipName]      Tên AnimationClip phải được giữ nguyên
 * @param {number} [expect.duration]      Độ dài clip (giây)
 * @param {string[]} [expect.bones]       Xương bắt buộc phải có channel
 * @param {number} [expect.minChannels]   Số channel tối thiểu
 * @param {number} [expect.tolerance]     Dung sai thời gian
 */
export function verifyAnimatedGLB(buffer, expect = {}) {
  const tolerance = expect.tolerance ?? 1e-3;
  const problems = [];
  const checks = [];
  const check = (name, ok, detail = '') => {
    checks.push({ name, ok, detail });
    if (!ok) problems.push(`${name}${detail ? ` — ${detail}` : ''}`);
    return ok;
  };

  let parsed;
  try {
    parsed = parseGLB(buffer);
  } catch (err) {
    return { ok: false, problems: [`Không đọc được GLB: ${err.message}`], checks, animations: [], gltf: null, bin: null };
  }

  const { json, bin } = parsed;
  check('Chứa JSON chunk + BIN chunk', !!json && !!bin, `${json ? 'JSON ok' : 'thiếu JSON'} · ${bin ? `${bin.byteLength} byte BIN` : 'thiếu BIN'}`);
  check('asset.version = 2.0', json.asset?.version === '2.0', `version=${json.asset?.version}`);
  check('Có generator', typeof json.asset?.generator === 'string', json.asset?.generator || 'trống');

  const animations = inspectAnimations(json, bin);
  check('Có ít nhất 1 animation', animations.length >= 1, `${animations.length} animation`);

  const clip = expect.clipName ? animations.find((a) => a.name === expect.clipName) : animations[0];
  if (!clip) {
    check(`Có clip tên "${expect.clipName}"`, false, `đang có: ${animations.map((a) => `"${a.name}"`).join(', ') || '(trống)'}`);
  } else {
    check(`Clip "${clip.name}" có channel`, clip.channels.length > 0, `${clip.channels.length} channel · ${clip.keys} keyframe`);
    if (expect.minChannels !== undefined) {
      check('Đủ số channel', clip.channels.length >= expect.minChannels, `${clip.channels.length}/${expect.minChannels}`);
    }
    if (expect.duration !== undefined) {
      check('Độ dài clip', Math.abs(clip.duration - expect.duration) <= tolerance,
        `nhận ${clip.duration.toFixed(4)}s · mong đợi ${expect.duration.toFixed(4)}s`);
    }
    check('Keyframe bắt đầu ở 0', Math.abs(clip.start) <= tolerance, `start=${clip.start}`);

    for (const channel of clip.channels) {
      if (!channel.times.every((t, i) => i === 0 || t >= channel.times[i - 1])) {
        check(`Thời gian tăng dần (${channel.nodeName}.${channel.path})`, false);
        break;
      }
    }

    const names = new Set(clip.channels.map((c) => c.nodeName));
    for (const bone of expect.bones || []) {
      check(`Có track cho xương ${bone}`, names.has(bone), `thiếu (đang có: ${[...names].slice(0, 6).join(', ')}…)`);
    }

    const jointSet = new Set((json.skins || []).flatMap((s) => s.joints || []));
    const skinned = clip.channels.filter((c) => jointSet.has(c.node));
    if (jointSet.size > 0) {
      check('Channel trỏ vào xương của skin', skinned.length === clip.channels.length,
        `${skinned.length}/${clip.channels.length} channel là joint`);
    }

    for (const channel of clip.channels) {
      if (channel.path !== 'rotation') continue;
      const bad = channel.values.find((v) => Math.abs(Math.hypot(...v) - 1) > 1e-3);
      check(`Quaternion đơn vị (${channel.nodeName})`, !bad, bad ? `|q|=${Math.hypot(...bad).toFixed(4)}` : 'ok');
      break;
    }

    const raw = clip.channels.find((c) => c.path === 'translation');
    if (raw && expect.rootTranslation) {
      const last = raw.values[raw.values.length - 1];
      const delta = Math.hypot(...last.map((v, i) => v - expect.rootTranslation[i]));
      check('Track vị trí gốc khớp dữ liệu nguồn', delta <= (expect.translationTolerance ?? 1e-2),
        `lệch ${delta.toFixed(4)} m`);
    }
  }

  return {
    ok: problems.length === 0,
    problems,
    checks,
    animations,
    gltf: json,
    bin,
    summary: {
      bytes: parsed.length,
      animations: animations.length,
      clip: clip?.name || '',
      channels: clip?.channels.length || 0,
      keys: clip?.keys || 0,
      duration: clip?.duration || 0,
      nodes: json.nodes?.length || 0,
      skins: json.skins?.length || 0,
    },
  };
}

/** One-line human readable summary used by both suites. */
export function describeReport(report) {
  const s = report.summary || {};
  return `${(s.bytes / 1024).toFixed(1)} KB · ${s.animations} animation · clip "${s.clip}" · ${s.channels} channel · ${s.keys} keyframe · ${s.duration.toFixed(2)}s`;
}
