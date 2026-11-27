/**
 * Web Blender Studio - Project Schema Versioning, Migration & Blob Dehydration (Wave 0)
 * File: js/core/project-migrator.js
 *
 * Pure DOM-free module responsible for:
 *  - Detecting project schema versions (v1..v5+)
 *  - Migrating legacy projects cleanly to CURRENT_PROJECT_SCHEMA (v5)
 *  - Dehydrating heavy binary buffers & embedded images into content-addressed blobs
 *    for OPFS/IndexedDB autosave and `.wbs` ZIP project packages, and hydrating them back.
 */

export const CURRENT_PROJECT_SCHEMA = 5;
export const PROJECT_FORMAT_ID = 'web-blender-studio-project';

function clonePlain(value) {
  if (typeof structuredClone === 'function') {
    try {
      return structuredClone(value);
    } catch (_) {
      // Fallback for objects containing non-cloneable prototypes
    }
  }
  return JSON.parse(JSON.stringify(value));
}

function bytesToBase64(bytes) {
  if (typeof Buffer !== 'undefined' && typeof Buffer.from === 'function') {
    return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
  }
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function base64ToBytes(b64) {
  if (typeof Buffer !== 'undefined' && typeof Buffer.from === 'function') {
    const buf = Buffer.from(b64, 'base64');
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  }
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

function denseArrayToTyped(value, kind = 'f32') {
  const Ctor = kind === 'u32' ? Uint32Array : Float32Array;
  if (value instanceof Ctor) return value;
  if (ArrayBuffer.isView(value)) return new Ctor(value);
  if (Array.isArray(value)) return Ctor.from(value);
  if (value && typeof value === 'object') {
    if (value.__f32 && typeof value.data === 'string') {
      const raw = base64ToBytes(value.data);
      const count = Math.floor(raw.byteLength / 4);
      const aligned = raw.byteOffset % 4 === 0
        ? new Float32Array(raw.buffer, raw.byteOffset, count)
        : new Float32Array(raw.slice().buffer);
      return kind === 'f32' ? aligned : new Ctor(aligned);
    }
    let maxIdx = -1;
    for (const key in value) {
      const idx = Number(key);
      if (Number.isInteger(idx) && idx >= 0 && idx > maxIdx) maxIdx = idx;
    }
    if (maxIdx >= 0) {
      const out = new Ctor(maxIdx + 1);
      for (let i = 0; i <= maxIdx; i += 1) {
        const n = Number(value[i]);
        out[i] = Number.isFinite(n) ? n : 0;
      }
      return out;
    }
  }
  return null;
}

function typedToBytes(typed) {
  return new Uint8Array(typed.buffer, typed.byteOffset, typed.byteLength);
}

function bytesToFloat32Array(bytes) {
  const count = Math.floor(bytes.byteLength / 4);
  if (bytes.byteOffset % 4 === 0) {
    return new Float32Array(bytes.buffer, bytes.byteOffset, count);
  }
  return new Float32Array(bytes.slice().buffer, 0, count);
}

function bytesToUint32Array(bytes) {
  const count = Math.floor(bytes.byteLength / 4);
  if (bytes.byteOffset % 4 === 0) {
    return new Uint32Array(bytes.buffer, bytes.byteOffset, count);
  }
  return new Uint32Array(bytes.slice().buffer, 0, count);
}

function createEmptyDataBlocks() {
  return {
    version: 1,
    meshes: {},
    materials: {},
    images: {},
    actions: {},
    curves: {},
    collections: {},
  };
}

/**
 * Infers schema version from raw project JSON.
 * @param {Object} raw
 * @returns {number}
 */
export function detectProjectSchemaVersion(raw) {
  if (!raw || typeof raw !== 'object') return 0;
  const explicit = Number(raw?.meta?.schemaVersion);
  if (Number.isFinite(explicit) && explicit >= 1) {
    return Math.floor(explicit);
  }
  if (raw.modifierSources && typeof raw.modifierSources === 'object') return 4;
  if (raw.sceneGraph && typeof raw.sceneGraph === 'object') return 3;
  if (raw.meta?.format === PROJECT_FORMAT_ID) return 2;
  if (Number(raw.version) === 1 || Array.isArray(raw.objects)) return 1;
  return 2;
}

/**
 * Migrates any v1..v5 project JSON to CURRENT_PROJECT_SCHEMA (v5).
 * Preserves legacy `sceneGraph`-absent flat v2 objects and keeps camera fields
 * untouched so `_restoreViewportCamera` can validate/reject invalid camera values.
 *
 * @param {Object} raw
 * @returns {{ data: Object, sourceVersion: number, targetVersion: number, migrated: boolean, isNewerVersion: boolean, warnings: string[] }}
 */
export function migrateProjectData(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new TypeError('Project data must be a non-null JSON object.');
  }

  const data = clonePlain(raw);
  const warnings = [];
  const sourceVersion = detectProjectSchemaVersion(data);

  if (sourceVersion <= 0) {
    throw new Error('Unrecognized project schema version.');
  }

  if (sourceVersion > CURRENT_PROJECT_SCHEMA) {
    warnings.push(
      `Project schema v${sourceVersion} is newer than this build (v${CURRENT_PROJECT_SCHEMA}); importing best-effort.`
    );
    return {
      data,
      sourceVersion,
      targetVersion: sourceVersion,
      migrated: false,
      isNewerVersion: true,
      warnings,
    };
  }

  let ver = sourceVersion;

  // v1 -> v2: wrap bare { version: 1, objects: [...] } into canonical metadata envelope
  if (ver === 1) {
    if (!data.meta || typeof data.meta !== 'object') {
      data.meta = {};
    }
    data.meta.format = data.meta.format || PROJECT_FORMAT_ID;
    data.meta.version = data.meta.version || '1.0.0';
    data.meta.generator = data.meta.generator || 'Web Blender Studio Engine';
    if (!Array.isArray(data.objects)) data.objects = [];
    if (!Array.isArray(data.lights)) data.lights = [];
    if (!data.environment || typeof data.environment !== 'object') {
      data.environment = { backgroundColor: '#282828', fog: null };
    }
    delete data.version;
    ver = 2;
  }

  // v2 -> v3: normalize meta & timeline envelope without fabricating sceneGraph for flat v2 files
  if (ver === 2) {
    if (!data.meta || typeof data.meta !== 'object') data.meta = {};
    data.meta.format = data.meta.format || PROJECT_FORMAT_ID;
    data.meta.version = data.meta.version || '1.0.0';
    if (!Array.isArray(data.objects)) data.objects = [];
    if (!Array.isArray(data.lights)) data.lights = [];
    if (!data.environment || typeof data.environment !== 'object') {
      data.environment = { backgroundColor: '#282828', fog: null };
    }
    if (data.timeline !== undefined && !Array.isArray(data.timeline)) {
      warnings.push('Normalized non-array timeline field during v2 -> v3 migration.');
      data.timeline = [];
    }
    ver = 3;
  }

  // v3 -> v4: normalize modifierSources map if present
  if (ver === 3) {
    if (data.modifierSources !== undefined && (typeof data.modifierSources !== 'object' || data.modifierSources === null)) {
      warnings.push('Removed invalid modifierSources block during v3 -> v4 migration.');
      delete data.modifierSources;
    }
    ver = 4;
  }

  // v4 -> v5: introduce dataBlocks registry & packaging metadata
  if (ver === 4) {
    if (!data.dataBlocks || typeof data.dataBlocks !== 'object') {
      data.dataBlocks = createEmptyDataBlocks();
    } else {
      const empty = createEmptyDataBlocks();
      data.dataBlocks = {
        ...empty,
        ...data.dataBlocks,
        meshes: data.dataBlocks.meshes || {},
        materials: data.dataBlocks.materials || {},
        images: data.dataBlocks.images || {},
        actions: data.dataBlocks.actions || {},
        curves: data.dataBlocks.curves || {},
        collections: data.dataBlocks.collections || {},
      };
    }
    ver = 5;
  }

  if (!data.meta || typeof data.meta !== 'object') data.meta = {};
  data.meta.format = PROJECT_FORMAT_ID;
  data.meta.version = data.meta.version || '1.0.0';
  data.meta.schemaVersion = CURRENT_PROJECT_SCHEMA;
  if (sourceVersion < CURRENT_PROJECT_SCHEMA) {
    data.meta.migratedFrom = sourceVersion;
  }

  return {
    data,
    sourceVersion,
    targetVersion: CURRENT_PROJECT_SCHEMA,
    migrated: sourceVersion < CURRENT_PROJECT_SCHEMA,
    isNewerVersion: false,
    warnings,
  };
}

function parseDataUrl(url) {
  if (typeof url !== 'string' || !url.startsWith('data:')) return null;
  const comma = url.indexOf(',');
  if (comma === -1) return null;
  const header = url.slice(5, comma);
  const body = url.slice(comma + 1);
  const isBase64 = header.endsWith(';base64');
  const mime = (isBase64 ? header.slice(0, -7) : header) || 'application/octet-stream';
  if (!isBase64) {
    const text = decodeURIComponent(body);
    return { mime, bytes: new TextEncoder().encode(text), isBase64: false };
  }
  return { mime, bytes: base64ToBytes(body), isBase64: true };
}

/**
 * Extracts large typed buffers and embedded data-URL images from a project object
 * into binary blobs via `putBlobFn`, replacing them with `{ __blobRef, ... }` markers.
 *
 * @param {Object} projectData
 * @param {(bytes: Uint8Array, meta: Object) => Promise<{ref:string}>| {ref:string}} putBlobFn
 * @param {{ minBytes?: number }} [options]
 * @returns {Promise<{ manifest: Object, blobRefs: string[], dehydratedCount: number, totalBlobBytes: number }>}
 */
export async function dehydrateProjectBlobs(projectData, putBlobFn, options = {}) {
  if (!projectData || typeof projectData !== 'object') {
    throw new TypeError('dehydrateProjectBlobs requires a project object.');
  }
  if (typeof putBlobFn !== 'function') {
    throw new TypeError('dehydrateProjectBlobs requires a putBlobFn callback.');
  }

  const minBytes = Math.max(0, Number(options.minBytes ?? 512));
  const manifest = clonePlain(projectData);
  const refs = new Set();
  const seenRefSizes = new Map();
  let dehydratedCount = 0;
  let totalBlobBytes = 0;
  let totalStoredBytes = 0;

  const storeBytes = async (bytes, meta) => {
    const res = await putBlobFn(bytes, meta);
    const ref = typeof res === 'string' ? res : res?.ref;
    if (!ref) throw new Error('putBlobFn must return a blob ref');
    refs.add(ref);
    dehydratedCount += 1;
    totalBlobBytes += bytes.byteLength;
    const onDisk = Number.isFinite(res?.storedBytes) ? res.storedBytes : bytes.byteLength;
    if (!seenRefSizes.has(ref)) {
      seenRefSizes.set(ref, onDisk);
      totalStoredBytes += onDisk;
    }
    return ref;
  };

  const maybeDehydrateNumeric = async (val, kind = 'f32') => {
    if (val && val.__blobRef) {
      refs.add(val.__blobRef);
      return val;
    }
    const typed = denseArrayToTyped(val, kind);
    if (!typed) return val;
    const bytes = typedToBytes(typed);
    if (bytes.byteLength < minBytes) return val;
    const originalEncoding = val && val.__f32 ? 'f32_b64' : (Array.isArray(val) ? 'array' : 'typed');
    const ref = await storeBytes(bytes, { mime: 'application/octet-stream', kind });
    return {
      __blobRef: ref,
      kind,
      count: typed.length,
      originalEncoding,
    };
  };

  const graph = manifest.sceneGraph;
  if (graph && typeof graph === 'object') {
    for (const geometry of Object.values(graph.geometries || {})) {
      const gData = geometry?.data;
      if (!gData) continue;
      for (const attr of Object.values(gData.attributes || {})) {
        if (attr && attr.array !== undefined) {
          const kind = String(attr.type || '').toLowerCase().includes('uint32') ? 'u32' : 'f32';
          attr.array = await maybeDehydrateNumeric(attr.array, kind);
        }
      }
      if (gData.index && gData.index.array !== undefined) {
        const kind = String(gData.index.type || '').toLowerCase().includes('uint32') ? 'u32' : 'f32';
        gData.index.array = await maybeDehydrateNumeric(gData.index.array, kind);
      }
      for (const morphList of Object.values(gData.morphAttributes || {})) {
        if (!Array.isArray(morphList)) continue;
        for (const attr of morphList) {
          if (attr && attr.array !== undefined) {
            attr.array = await maybeDehydrateNumeric(attr.array, 'f32');
          }
        }
      }
    }

    for (const clip of graph.animations || []) {
      for (const track of clip.tracks || []) {
        if (track.times !== undefined) track.times = await maybeDehydrateNumeric(track.times, 'f32');
        if (track.values !== undefined) track.values = await maybeDehydrateNumeric(track.values, 'f32');
      }
    }

    for (const skeleton of graph.skeletons || []) {
      if (Array.isArray(skeleton.boneInverses)) {
        for (let i = 0; i < skeleton.boneInverses.length; i += 1) {
          skeleton.boneInverses[i] = await maybeDehydrateNumeric(skeleton.boneInverses[i], 'f32');
        }
      }
    }

    for (const img of Object.values(graph.images || {})) {
      if (!img) continue;
      if (img.url && typeof img.url === 'object' && img.url.__blobRef) {
        refs.add(img.url.__blobRef);
        continue;
      }
      const parsed = parseDataUrl(img.url);
      if (parsed && parsed.bytes.byteLength >= minBytes) {
        const ref = await storeBytes(parsed.bytes, { mime: parsed.mime, kind: 'image' });
        img.url = {
          __blobRef: ref,
          kind: 'image',
          mime: parsed.mime,
        };
      }
    }
  }

  if (manifest.modifierSources && typeof manifest.modifierSources === 'object') {
    for (const enc of Object.values(manifest.modifierSources)) {
      if (!enc || typeof enc !== 'object') continue;
      for (const attrKey of ['position', 'normal', 'uv', 'color']) {
        if (enc[attrKey] != null) {
          enc[attrKey] = await maybeDehydrateNumeric(enc[attrKey], 'f32');
        }
      }
      if (enc.index != null) {
        enc.index = await maybeDehydrateNumeric(enc.index, 'u32');
      }
    }
  }

  if (manifest.scatterGroups && typeof manifest.scatterGroups === 'object') {
    for (const sg of Object.values(manifest.scatterGroups)) {
      if (sg && sg.matrices != null) {
        sg.matrices = await maybeDehydrateNumeric(sg.matrices, 'f32');
      }
    }
  }

  if (manifest.paintStacks && typeof manifest.paintStacks === 'object') {
    for (const [matUuid, slotsObj] of Object.entries(manifest.paintStacks)) {
      if (!slotsObj || typeof slotsObj !== 'object') continue;
      for (const [slotKey, slotVal] of Object.entries(slotsObj)) {
        if (!slotVal || !Array.isArray(slotVal.layers)) continue;
        for (const layer of slotVal.layers) {
          const px = layer?.pixels;
          if (!px || typeof px !== 'object') continue;
          if (px.__blobRef) {
            refs.add(px.__blobRef);
          } else if (typeof px.b64 === 'string' && px.b64.length > 0) {
            const bytes = base64ToBytes(px.b64);
            if (bytes.byteLength >= minBytes) {
              const ref = await storeBytes(bytes, { mime: 'application/octet-stream', kind: `paint_${slotKey}` });
              layer.pixels = { __blobRef: ref, byteLength: bytes.byteLength };
            }
          }
        }
      }
    }
  }

  if (!manifest.meta || typeof manifest.meta !== 'object') manifest.meta = {};
  manifest.meta.blobRefs = Array.from(refs);

  return {
    manifest,
    blobRefs: manifest.meta.blobRefs,
    dehydratedCount,
    totalBlobBytes,
    totalStoredBytes,
  };
}

/**
 * Re-hydrates `{ __blobRef }` markers inside a project manifest back into
 * formats directly consumable by `StudioExporter.importProjectJSON` and `decodeGeometry`.
 *
 * @param {Object} projectData
 * @param {(ref: string) => Promise<Uint8Array|null>|Uint8Array|null} getBlobFn
 * @param {{ strict?: boolean, onMissingBlob?: (ref: string, path: string) => void }} [options]
 * @returns {Promise<{ data: Object, hydratedCount: number, missingRefs: string[] }>}
 */
export async function hydrateProjectBlobs(projectData, getBlobFn, options = {}) {
  if (!projectData || typeof projectData !== 'object') {
    throw new TypeError('hydrateProjectBlobs requires a project object.');
  }
  if (typeof getBlobFn !== 'function') {
    throw new TypeError('hydrateProjectBlobs requires a getBlobFn callback.');
  }

  const strict = options.strict !== false;
  const data = clonePlain(projectData);
  let hydratedCount = 0;
  const missingRefs = [];

  const loadRef = async (ref, path) => {
    const bytes = await getBlobFn(ref);
    if (!bytes) {
      missingRefs.push(ref);
      options.onMissingBlob?.(ref, path);
      if (strict) {
        throw new Error(`Missing binary blob "${ref}" required by ${path}`);
      }
      return null;
    }
    hydratedCount += 1;
    return bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  };

  const hydrateNumeric = async (val, path, forModifierSource = false) => {
    if (!val || typeof val !== 'object' || !val.__blobRef) return val;
    const bytes = await loadRef(val.__blobRef, path);
    if (!bytes) return null;

    if (forModifierSource) {
      return val.kind === 'u32' ? bytesToUint32Array(bytes) : bytesToFloat32Array(bytes);
    }

    // CRITICAL: Check `val.kind === 'u32'` BEFORE `val.originalEncoding === 'f32_b64'`!
    // Otherwise Uint32Array index buffers (used by InstancedScatterGroup & high-poly meshes)
    // get reinterpreted as IEEE-754 subnormal floats (1.4e-45 -> 0), making meshes 100% invisible!
    if (val.kind === 'u32') {
      const u32 = bytesToUint32Array(bytes);
      return Array.from(u32);
    }

    if (val.originalEncoding === 'f32_b64' || val.kind === 'f32') {
      const f32 = bytesToFloat32Array(bytes);
      if (val.originalEncoding === 'array') return Array.from(f32);
      return {
        __f32: true,
        count: val.count ?? f32.length,
        data: bytesToBase64(new Uint8Array(f32.buffer, f32.byteOffset, f32.byteLength)),
      };
    }

    const u32 = bytesToUint32Array(bytes);
    return Array.from(u32);
  };

  const graph = data.sceneGraph;
  if (graph && typeof graph === 'object') {
    for (const [gId, geometry] of Object.entries(graph.geometries || {})) {
      const gData = geometry?.data;
      if (!gData) continue;
      for (const [attrName, attr] of Object.entries(gData.attributes || {})) {
        if (attr && attr.array !== undefined) {
          attr.array = await hydrateNumeric(attr.array, `sceneGraph.geometries[${gId}].attributes.${attrName}`, false);
        }
      }
      if (gData.index && gData.index.array !== undefined) {
        gData.index.array = await hydrateNumeric(gData.index.array, `sceneGraph.geometries[${gId}].index`, false);
      }
      for (const [mName, morphList] of Object.entries(gData.morphAttributes || {})) {
        if (!Array.isArray(morphList)) continue;
        for (let i = 0; i < morphList.length; i += 1) {
          const attr = morphList[i];
          if (attr && attr.array !== undefined) {
            attr.array = await hydrateNumeric(attr.array, `sceneGraph.geometries[${gId}].morph.${mName}[${i}]`, false);
          }
        }
      }
    }

    for (let ci = 0; ci < (graph.animations || []).length; ci += 1) {
      const clip = graph.animations[ci];
      for (let ti = 0; ti < (clip.tracks || []).length; ti += 1) {
        const track = clip.tracks[ti];
        if (track.times !== undefined) track.times = await hydrateNumeric(track.times, `animations[${ci}].tracks[${ti}].times`, false);
        if (track.values !== undefined) track.values = await hydrateNumeric(track.values, `animations[${ci}].tracks[${ti}].values`, false);
      }
    }

    for (let si = 0; si < (graph.skeletons || []).length; si += 1) {
      const skeleton = graph.skeletons[si];
      if (Array.isArray(skeleton.boneInverses)) {
        for (let bi = 0; bi < skeleton.boneInverses.length; bi += 1) {
          skeleton.boneInverses[bi] = await hydrateNumeric(skeleton.boneInverses[bi], `skeletons[${si}].boneInverses[${bi}]`, false);
        }
      }
    }

    const imagesList = Array.isArray(graph.images)
      ? graph.images
      : Object.values(graph.images || {});
    for (let ii = 0; ii < imagesList.length; ii += 1) {
      const img = imagesList[ii];
      if (img?.url && typeof img.url === 'object' && img.url.__blobRef) {
        const bytes = await loadRef(img.url.__blobRef, `sceneGraph.images[${ii}]`);
        if (bytes) {
          const mime = img.url.mime || 'image/png';
          img.url = `data:${mime};base64,${bytesToBase64(bytes)}`;
        }
      }
    }
  }

  if (data.modifierSources && typeof data.modifierSources === 'object') {
    for (const [meshUuid, enc] of Object.entries(data.modifierSources)) {
      if (!enc || typeof enc !== 'object') continue;
      for (const attrKey of ['position', 'normal', 'uv', 'color', 'index']) {
        if (enc[attrKey] != null) {
          enc[attrKey] = await hydrateNumeric(enc[attrKey], `modifierSources[${meshUuid}].${attrKey}`, true);
        }
      }
    }
  }

  if (data.scatterGroups && typeof data.scatterGroups === 'object') {
    for (const [grpUuid, sg] of Object.entries(data.scatterGroups)) {
      if (sg && sg.matrices != null) {
        sg.matrices = await hydrateNumeric(sg.matrices, `scatterGroups[${grpUuid}].matrices`, false);
      }
    }
  }

  if (data.paintStacks && typeof data.paintStacks === 'object') {
    for (const [matUuid, slotsObj] of Object.entries(data.paintStacks)) {
      if (!slotsObj || typeof slotsObj !== 'object') continue;
      for (const [slotKey, slotVal] of Object.entries(slotsObj)) {
        if (!slotVal || !Array.isArray(slotVal.layers)) continue;
        for (let li = 0; li < slotVal.layers.length; li++) {
          const layer = slotVal.layers[li];
          const px = layer?.pixels;
          if (px && typeof px === 'object' && px.__blobRef) {
            const bytes = await loadRef(px.__blobRef, `paintStacks[${matUuid}].${slotKey}.layers[${li}]`);
            if (bytes) {
              layer.pixels = { b64: bytesToBase64(bytes) };
            }
          }
        }
      }
    }
  }

  if (data.meta && Array.isArray(data.meta.blobRefs)) {
    delete data.meta.blobRefs;
  }

  return { data, hydratedCount, missingRefs };
}

/**
 * Recursively collects all `__blobRef` strings referenced anywhere inside a project manifest.
 * @param {Object} projectData
 * @returns {Set<string>}
 */
export function collectProjectBlobRefs(projectData) {
  const refs = new Set();
  if (!projectData || typeof projectData !== 'object') return refs;
  if (Array.isArray(projectData.meta?.blobRefs)) {
    for (const r of projectData.meta.blobRefs) {
      if (typeof r === 'string' && r) refs.add(r);
    }
  }
  const seen = new WeakSet();
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (seen.has(node)) return;
    seen.add(node);
    if (typeof node.__blobRef === 'string' && node.__blobRef) {
      refs.add(node.__blobRef);
      return;
    }
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i += 1) walk(node[i]);
      return;
    }
    for (const val of Object.values(node)) walk(val);
  };
  walk(projectData);
  return refs;
}
