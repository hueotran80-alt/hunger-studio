/**
 * Unified Scene Budget & Commercial Performance Profiler
 * Single source of truth shared by RapidStudio (`studio.inspectSceneBudget()`),
 * Copilot Worker, Viewport Budget HUD, and Export Options Dialog.
 * File: js/core/scene-budget.js
 */

export const SCENE_BUDGET_TIERS = Object.freeze({
  mobile: Object.freeze({
    label: 'Mobile / AR',
    maxRenderedTris: 30_000,
    maxDrawCalls: 40,
    maxTextureVramMB: 32,
    maxGlbMB: 5,
  }),
  product: Object.freeze({
    label: 'Product / Web Share',
    maxRenderedTris: 50_000,
    maxDrawCalls: 60,
    maxTextureVramMB: 64,
    maxGlbMB: 8,
  }),
  architecture: Object.freeze({
    label: 'Architecture / Hero Scene',
    maxRenderedTris: 750_000,
    maxDrawCalls: 350,
    maxTextureVramMB: 96,
    maxGlbMB: 24,
  }),
});

const DATA_MAP_SLOTS = new Set([
  'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap',
  'clearcoatNormalMap', 'clearcoatRoughnessMap', 'clearcoatMap',
  'bumpMap', 'displacementMap', 'thicknessMap', 'transmissionMap',
  'specularIntensityMap', 'iridescenceMap', 'iridescenceThicknessMap',
  'anisotropyMap', 'sheenRoughnessMap',
]);
const COLOR_MAP_SLOTS = new Set([
  'map', 'emissiveMap', 'sheenColorMap', 'specularColorMap', 'alphaMap', 'lightMap',
]);
const ALL_MAP_SLOTS = [...COLOR_MAP_SLOTS, ...DATA_MAP_SLOTS];

/**
 * Inspects any THREE.Object3D / Scene and computes exact geometry byte sizes,
 * unique vs rendered triangles, draw calls, material/texture counts, GPU VRAM estimate
 * (including mipmap chains), estimated GLB export size, and commercial budget status.
 */
export function inspectSceneBudget(root, options = {}) {
  const tierKey = SCENE_BUDGET_TIERS[options.tier] ? options.tier : 'architecture';
  const limits = SCENE_BUDGET_TIERS[tierKey];
  const renderer = options.renderer || null;

  let meshCount = 0;
  let instancedCount = 0;
  let totalInstances = 0;
  let estimatedDrawCalls = 0;
  let uniqueTris = 0;
  let renderedTris = 0;
  let uniqueGeomBytes = 0;
  let expandedGeomBytes = 0;
  let instanceDataBytes = 0;
  let indexedGeoms = 0;
  let nonIndexedGeoms = 0;

  const geomSet = new Set();
  const matSet = new Set();
  const texSet = new Set();
  const imgMeta = new Map(); // image -> { w, h, isData }

  if (root && typeof root.traverse === 'function') {
    root.traverse((obj) => {
      if (!(obj.isMesh || obj.isInstancedMesh)) return;
      if (obj.userData?.isSystemObject || obj.userData?.isHelper || obj.userData?.isGizmo) return;
      if (options.onlyVisible !== false && obj.visible === false) return;

      const g = obj.geometry;
      const count = obj.isInstancedMesh ? Math.max(0, Number(obj.count) || 0) : 1;
      const groupDraws = Array.isArray(obj.material) && g?.groups?.length ? g.groups.length : 1;
      if (obj.isInstancedMesh) {
        instancedCount++;
        totalInstances += count;
        estimatedDrawCalls += count > 0 ? groupDraws : 0;
        // Include per-instance TRS matrix (64 B) + optional instanceColor (12 B) for GLB estimate
        instanceDataBytes += count * 64 + (obj.instanceColor ? count * 12 : 0);
      } else {
        meshCount++;
        estimatedDrawCalls += groupDraws;
      }

      if (g?.isBufferGeometry && g.attributes?.position) {
        const refCount = g.index ? g.index.count : g.attributes.position.count;
        const tris = refCount / 3;
        renderedTris += tris * count;

        let gBytes = 0;
        const seenInterleaved = new Set();
        for (const key of Object.keys(g.attributes)) {
          const a = g.attributes[key];
          if (a?.isInterleavedBufferAttribute && a.data?.array?.byteLength) {
            if (!seenInterleaved.has(a.data)) {
              seenInterleaved.add(a.data);
              gBytes += a.data.array.byteLength;
            }
          } else if (a?.array?.byteLength) {
            gBytes += a.array.byteLength;
          }
        }
        if (g.index?.array?.byteLength) gBytes += g.index.array.byteLength;
        expandedGeomBytes += gBytes * count;

        if (!geomSet.has(g.uuid)) {
          geomSet.add(g.uuid);
          if (g.index) indexedGeoms++;
          else nonIndexedGeoms++;
          uniqueTris += tris;
          uniqueGeomBytes += gBytes;
        }
      }

      const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
      for (const m of mats) {
        if (!m) continue;
        matSet.add(m.uuid);
        for (const slot of ALL_MAP_SLOTS) {
          const tex = m[slot];
          if (!tex) continue;
          texSet.add(tex.uuid);
          const img = tex.image;
          if (img) {
            const w = Number(img.width || img.naturalWidth || 0);
            const h = Number(img.height || img.naturalHeight || 0);
            if (w > 0 && h > 0) {
              const prev = imgMeta.get(img);
              const isData = DATA_MAP_SLOTS.has(slot);
              if (!prev) imgMeta.set(img, { w, h, isData });
              else if (isData) prev.isData = true;
            }
          }
        }
      }
    });
  }

  let textureVramBytes = 0;
  let estColorImgBytes = 0;
  let estDataImgBytes = 0;
  let colorMapCount = 0;
  let dataMapCount = 0;

  for (const { w, h, isData } of imgMeta.values()) {
    // RGBA8 + mipmaps (~1.33x)
    textureVramBytes += Math.round(w * h * 4 * 1.33);
    if (isData) {
      dataMapCount++;
      // Lossless PNG data maps compress ~35-55% of raw RGB
      estDataImgBytes += Math.round(w * h * 1.15);
    } else {
      colorMapCount++;
      // JPEG q92 color maps average ~0.18-0.25 bytes/pixel
      estColorImgBytes += Math.round(w * h * 0.22);
    }
  }

  const drawCalls = renderer?.info?.render?.calls ?? estimatedDrawCalls;
  const uniqueGeomMB = +(uniqueGeomBytes / 1048576).toFixed(2);
  const expandedGeomMB = +(expandedGeomBytes / 1048576).toFixed(2);
  const textureVRAM_MB = +(textureVramBytes / 1048576).toFixed(2);
  const estimatedGlbMB = +((uniqueGeomBytes + instanceDataBytes + estColorImgBytes + estDataImgBytes + 65536) / 1048576).toFixed(2);
  const jsHeapMB = (typeof performance !== 'undefined' && performance.memory)
    ? +(performance.memory.usedJSHeapSize / 1048576).toFixed(1)
    : null;

  const warnings = [];
  if (renderedTris > limits.maxRenderedTris) {
    warnings.push(`Rendered tris (${Math.round(renderedTris).toLocaleString()}) exceed ${limits.label} budget (${limits.maxRenderedTris.toLocaleString()}).`);
  }
  if (drawCalls > limits.maxDrawCalls) {
    warnings.push(`Draw calls (${drawCalls}) exceed ${limits.label} budget (${limits.maxDrawCalls}).`);
  }
  if (textureVRAM_MB > limits.maxTextureVramMB) {
    warnings.push(`Texture VRAM (${textureVRAM_MB} MB) exceeds ${limits.label} budget (${limits.maxTextureVramMB} MB).`);
  }
  if (estimatedGlbMB > limits.maxGlbMB) {
    warnings.push(`Estimated GLB (${estimatedGlbMB} MB) exceeds ${limits.label} budget (${limits.maxGlbMB} MB).`);
  }
  if (nonIndexedGeoms > 0 && uniqueGeomMB > 8) {
    warnings.push(`${nonIndexedGeoms} non-indexed geometries detected; indexing can shrink geometry buffers ~50%.`);
  }

  let status = 'ok';
  if (
    renderedTris > limits.maxRenderedTris ||
    drawCalls > limits.maxDrawCalls ||
    textureVRAM_MB > limits.maxTextureVramMB ||
    estimatedGlbMB > limits.maxGlbMB
  ) {
    status = 'over';
  } else if (
    renderedTris > limits.maxRenderedTris * 0.8 ||
    drawCalls > limits.maxDrawCalls * 0.85 ||
    textureVRAM_MB > limits.maxTextureVramMB * 0.8 ||
    estimatedGlbMB > limits.maxGlbMB * 0.8
  ) {
    status = 'warn';
  }

  return {
    tier: tierKey,
    tierLabel: limits.label,
    status,
    limits,
    meshCount,
    instancedCount,
    totalInstances,
    drawCalls,
    uniqueGeoms: geomSet.size,
    indexedGeoms,
    nonIndexedGeoms,
    uniqueMaterials: matSet.size,
    uniqueTextures: texSet.size,
    uniqueImages: imgMeta.size,
    colorMapCount,
    dataMapCount,
    uniqueTris: Math.round(uniqueTris),
    renderedTris: Math.round(renderedTris),
    uniqueGeomMB,
    expandedGeomMB,
    textureVRAM_MB,
    estimatedGlbMB,
    jsHeapMB,
    warnings,
  };
}
