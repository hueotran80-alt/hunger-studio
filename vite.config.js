/**
 * ADDITIVE production build for Web Blender Studio.
 *
 * - Dev flow is unchanged: `python server.py` (:8080) + the import maps in
 *   index.html / embed.html keep working. This config is only used by
 *   `npm run build` / `npm run preview`.
 * - No file under js/, vendor/, css/, tests/ or the HTML sources is modified.
 *   The two HTML import maps are stripped IN MEMORY for the build only,
 *   because every bare specifier is replicated below as resolve.alias.
 * - Rapier: vendor/rapier/rapier.mjs is the WASM-compat bundle (base64 WASM
 *   embedded, init() decodes it inline — no external .wasm fetch), so it is
 *   bundled as a lazy chunk via the dynamic import in rapier-loader.js.
 * - Runtime assets (models/, vendor/mediapipe WASM, draco decoder, worker
 *   vendor fetches) are copied verbatim into dist/ by copyRuntimeAssets.
 */
import { defineConfig } from 'vite';
import { cloudflare } from '@cloudflare/vite-plugin';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const vendor = (p) => path.resolve(root, 'vendor', p);

/**
 * Build-only rewrite of the ONE unanalyzable dynamic import in the codebase:
 *   js/exporters/export-import.js -> import(`three/addons/${subpath}`)
 * Rollup cannot bundle template-literal imports; left as-is it would need the
 * import map at runtime (and load a SECOND three instance from vendor/CDN).
 * We replace it in memory with static imports of every subpath actually used
 * by _loadAddon() call sites. Unknown subpaths still fall through to the
 * existing CDN fallback (the thrown error is caught by _loadAddon).
 */
const ADDON_SUBPATHS = [
  'exporters/GLTFExporter.js',
  'exporters/PLYExporter.js',
  'loaders/GLTFLoader.js',
  'loaders/DRACOLoader.js',
  'loaders/FBXLoader.js',
  'loaders/OBJLoader.js',
  'loaders/STLLoader.js',
  'loaders/PLYLoader.js',
  // NOTE: loaders/ColladaLoader.js is NOT vendored; it intentionally falls
  // through to the existing CDN fallback, exactly like the dev flow.
];

function bundleDynamicAddons() {
  const needle = 'return await import(`three/addons/${subpath}`);';
  const map =
    'const __VITE_BUNDLED_ADDONS__ = {\n' +
    ADDON_SUBPATHS.map(
      (s) => `  ${JSON.stringify(s)}: () => import(${JSON.stringify('three/addons/' + s)}),`
    ).join('\n') +
    '\n};\n';
  return {
    name: 'bundle-dynamic-addons',
    apply: 'build',
    enforce: 'pre',
    transform(code, id) {
      const file = id.replace(/\?.*$/, '');
      if (!file.endsWith('js/exporters/export-import.js')) return null;
      if (!code.includes(needle)) {
        this.error('export-import.js: expected dynamic addon import not found — review bundleDynamicAddons()');
      }
      let replaced = code.replace(
        needle,
        'const __addon = __VITE_BUNDLED_ADDONS__[subpath];' +
        ' if (__addon) return await __addon();' +
        " throw new Error('Addon not bundled: ' + subpath);"
      );
      // Keep the CDN fallbacks as runtime imports ( URLs with variables).
      replaced = replaced
        .replace('import(`https://cdn.jsdelivr.net/', 'import(/* @vite-ignore */ `https://cdn.jsdelivr.net/')
        .replace('import(`https://esm.sh/', 'import(/* @vite-ignore */ `https://esm.sh/');
      return { code: map + replaced, map: null };
    },
  };
}

/**
 * Build-only rewrite of js/core/geometry-worker.js so Rollup bundles MeshBVH,
 * three-bvh-csg and modifiers.js directly into the ES module worker chunk
 * (single unified THREE instance, zero runtime fetch/Blob URLs in dist/).
 * Dev mode (`python server.py`) continues using the in-memory rewrite untouched.
 */
function bundleGeometryWorker() {
  const startMarker = "const threeURL = new URL('../../vendor/three/three.module.js', import.meta.url).href;";
  const endMarker = '  return { MeshBVH, ...csg, modifiers };\n})();';
  return {
    name: 'bundle-geometry-worker',
    apply: 'build',
    enforce: 'pre',
    transform(code, id) {
      const file = id.replace(/\?.*$/, '').replace(/\\/g, '/');
      if (!file.endsWith('js/core/geometry-worker.js')) return null;
      const normalized = code.replace(/\r\n/g, '\n');
      const sIdx = normalized.indexOf(startMarker);
      const eIdx = normalized.indexOf(endMarker);
      if (sIdx === -1 || eIdx === -1) {
        this.error('geometry-worker.js: expected bootstrap markers not found — review bundleGeometryWorker()');
      }
      const replacement = [
        "import { MeshBVH as __MeshBVH } from 'three-mesh-bvh';",
        "import * as __csg from 'three-bvh-csg';",
        "import * as __modifiers from './modifiers.js';",
        'const ready = Promise.resolve({ MeshBVH: __MeshBVH, ...__csg, modifiers: __modifiers });',
      ].join('\n');
      const next = normalized.slice(0, sIdx) + replacement + normalized.slice(eIdx + endMarker.length);
      return { code: next, map: null };
    },
  };
}

/** Strip the inline import maps from the BUILT html only (sources untouched). */
function stripImportMaps() {
  return {
    name: 'strip-import-maps',
    apply: 'build',
    transformIndexHtml: {
      order: 'pre',
      handler(html) {
        return html.replace(/<script type="importmap">[\s\S]*?<\/script>\s*/g, '');
      },
    },
  };
}

const POLICY_PATH = path.resolve(root, 'assets/asset-ship-policy.json');
const DEFAULT_POLICY = {
  library: { maxAssetMB: 5, requireCommercialSafe: false, include: [], exclude: [] },
  models: { excludeDirs: [], excludeFiles: [] },
  vendor: { excludeDirs: [], excludeFiles: [] },
  host: { maxFileMB: 25 },
};

/** Read assets/asset-ship-policy.json (missing file -> defaults). */
function loadShipPolicy() {
  const policy = {
    library: { ...DEFAULT_POLICY.library },
    models: { ...DEFAULT_POLICY.models },
    vendor: { ...DEFAULT_POLICY.vendor },
    host: { ...DEFAULT_POLICY.host },
  };
  if (!fs.existsSync(POLICY_PATH)) return policy;
  const disk = JSON.parse(fs.readFileSync(POLICY_PATH, 'utf8'));
  for (const key of Object.keys(policy)) Object.assign(policy[key], disk[key] || {});
  return policy;
}

/** Recursive copy with per-name / per-relative-path / prefix exclusions. Returns stats. */
function copyTreeFiltered(srcDir, destDir, { excludeDirs = [], excludeFiles = [], excludePrefixes = [] } = {}) {
  const alwaysExcludeFiles = new Set(['.DS_Store', 'Thumbs.db', ...excludeFiles]);
  const skipped = [];
  let copied = 0;
  let bytes = 0;
  const walk = (from, to, rel) => {
    for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (excludeDirs.includes(relPath)) {
          skipped.push(relPath);
          continue;
        }
        walk(path.join(from, entry.name), path.join(to, entry.name), relPath);
      } else if (
        alwaysExcludeFiles.has(entry.name) ||
        alwaysExcludeFiles.has(relPath) ||
        excludePrefixes.some((prefix) => entry.name.startsWith(prefix))
      ) {
        skipped.push(relPath);
      } else {
        fs.mkdirSync(to, { recursive: true });
        const destFile = path.join(to, entry.name);
        fs.copyFileSync(path.join(from, entry.name), destFile);
        copied += 1;
        bytes += fs.statSync(destFile).size;
      }
    }
  };
  walk(srcDir, destDir, '');
  return { copied, bytes, skipped };
}

const mb = (bytes) => `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

/**
 * Copy runtime-resolved assets into dist/, preserving their URL paths:
 *  - vendor/  (mediapipe WASM + vision_bundle.mjs imported at runtime via
 *              '/vendor/mediapipe/vision_bundle.mjs'; draco decoder at
 *              './vendor/three/addons/libs/draco/gltf/'; geometry-worker
 *              fetches vendor bvh/csg sources relative to the page root)
 *  - models/  (GLB characters, pose_landmarker_full.task, videos, textures —
 *              loaded via '/models/...' and 'models/...' at runtime)
 *  - assets/  (only the Studio library entries allowed by
 *              assets/asset-ship-policy.json, so the public bundle stays
 *              deployable; the source assets are never deleted)
 *
 * The Studio catalog written to dist/ is filtered to the assets that actually
 * shipped, so the Asset Library never lists a file the host cannot serve.
 * STUDIO_SHIP_ALL=1 ships every asset (self-host / LAN use).
 */
function shipRuntimeAssets() {
  let outDir = path.resolve(root, 'dist');
  return {
    name: 'ship-runtime-assets',
    apply: 'build',
    configResolved(config) {
      outDir = path.resolve(config.root, config.build.outDir);
    },
    closeBundle() {
      // When building with @cloudflare/vite-plugin, only ship client static assets once for the client environment.
      if (this.environment?.name && this.environment.name !== 'client') return;
      const shipAll = process.env.STUDIO_SHIP_ALL === '1';
      const r2Cdn = process.env.STUDIO_R2_CDN === '1';
      const policy = loadShipPolicy();
      if (shipAll) console.log('[ship-assets] STUDIO_SHIP_ALL=1 — shipping every asset (no policy filter)');
      if (r2Cdn) console.log('[ship-assets] STUDIO_R2_CDN=1 — offloading models/, vendor/mediapipe/ & studio GLBs to Cloudflare R2');

      const cfHeadersSrc = path.resolve(root, 'cloudflare/_headers');
      if (fs.existsSync(cfHeadersSrc)) {
        fs.copyFileSync(cfHeadersSrc, path.join(outDir, '_headers'));
      }

      for (const dir of ['vendor', 'models']) {
        if (r2Cdn && dir === 'models') {
          console.log('[ship-assets] models/: skipped (served from Cloudflare R2)');
          continue;
        }
        const src = path.resolve(root, dir);
        if (!fs.existsSync(src)) continue;
        const dirPolicy = shipAll ? {} : { ...(policy[dir] || {}) };
        if (r2Cdn && dir === 'vendor') {
          dirPolicy.excludeDirs = [...(dirPolicy.excludeDirs || []), 'mediapipe'];
        }
        const stats = copyTreeFiltered(src, path.resolve(outDir, dir), dirPolicy);
        const skipped = stats.skipped.length ? `, skipped ${stats.skipped.length} (${stats.skipped.slice(0, 4).join(', ')}${stats.skipped.length > 4 ? ', …' : ''})` : '';
        console.log(`[ship-assets] ${dir}/: ${stats.copied} files, ${mb(stats.bytes)}${skipped}`);
      }

      const animDir = path.resolve(root, 'assets/animations');
      if (shipAll && fs.existsSync(animDir)) {
        const stats = copyTreeFiltered(animDir, path.resolve(outDir, 'assets/animations'));
        console.log(`[ship-assets] assets/animations/: ${stats.copied} files, ${mb(stats.bytes)}`);
      }

      const catalogSrc = path.resolve(root, 'assets/library/studio-catalog.json');
      const onlineSrc = path.resolve(root, 'assets/library/online-catalog.json');
      const libraryOut = path.resolve(outDir, 'assets/library');
      fs.mkdirSync(libraryOut, { recursive: true });
      if (fs.existsSync(onlineSrc)) fs.copyFileSync(onlineSrc, path.join(libraryOut, 'online-catalog.json'));

      if (!fs.existsSync(catalogSrc)) {
        console.warn('[ship-assets] assets/library/studio-catalog.json missing — Asset Library will be empty');
        return;
      }

      const catalog = JSON.parse(fs.readFileSync(catalogSrc, 'utf8'));
      const maxAssetBytes = Math.max(0, Number(policy.library.maxAssetMB) || 0) * 1024 * 1024;
      const requireCommercialSafe = Boolean(policy.library?.requireCommercialSafe);
      const expandSet = (list) => {
        const s = new Set();
        for (const v of list || []) {
          const raw = String(v || '').trim();
          if (!raw) continue;
          const stripped = raw.replace(/^\/+/, '');
          s.add(raw);
          s.add(stripped);
          s.add('/' + stripped);
        }
        return s;
      };
      const forced = expandSet(policy.library.include);
      const blocked = expandSet(policy.library.exclude);
      const kept = new Set();
      let shippedBytes = 0;
      let localTotal = 0;

      for (const item of catalog.items || []) {
        if (item.kind !== 'studio') continue;
        localTotal += 1;
        const rel = String(item.url || '').replace(/^\/+/, '');
        if (!rel) continue;
        const abs = path.resolve(root, rel);
        if (!abs.startsWith(root + path.sep) || !fs.existsSync(abs) || !fs.statSync(abs).isFile()) continue;

        const name = path.basename(rel);
        const isForced = forced.has(rel) || forced.has('/' + rel) || forced.has(name);
        const isBlocked = blocked.has(rel) || blocked.has('/' + rel) || blocked.has(name);
        const isSafe = item.commercialSafe === true;
        const size = fs.statSync(abs).size;
        const dest = path.join(outDir, rel);

        if (!shipAll) {
          if (isBlocked || (requireCommercialSafe && !isSafe) || (!isForced && maxAssetBytes > 0 && size > maxAssetBytes)) {
            // Ensure excluded/non-commercial models copied via models/ dir do not leak into dist/
            if (fs.existsSync(dest)) fs.rmSync(dest, { force: true });
            continue;
          }
        }

        if (!r2Cdn && (!fs.existsSync(dest) || fs.statSync(dest).size !== size)) {
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          fs.copyFileSync(abs, dest);
          shippedBytes += size;
        }
        const thumbRel = String(item.thumb || item.thumbnail || item.preview || '').replace(/^\/+/, '');
        if (!r2Cdn && thumbRel && thumbRel.startsWith('assets/')) {
          const thumbAbs = path.resolve(root, thumbRel);
          if (thumbAbs.startsWith(root + path.sep) && fs.existsSync(thumbAbs) && fs.statSync(thumbAbs).isFile()) {
            const thumbDest = path.join(outDir, thumbRel);
            fs.mkdirSync(path.dirname(thumbDest), { recursive: true });
            fs.copyFileSync(thumbAbs, thumbDest);
          }
        }
        kept.add(item.url);
      }

      const items = (catalog.items || []).filter((it) => it.kind !== 'studio' || kept.has(it.url));
      const byCategory = {};
      for (const it of items) {
        const c = it.studioCategory || 'props';
        byCategory[c] = (byCategory[c] || 0) + 1;
      }
      const localStudio = items.filter((it) => it.kind === 'studio').length;
      const payload = {
        ...catalog,
        note: `${catalog.note || 'Studio catalog'} | Public build ships ${localStudio}/${localTotal} local studio assets (assets/asset-ship-policy.json, max ${policy.library.maxAssetMB} MB each).`,
        counts: {
          localStudio,
          polyhavenCC0: items.filter((it) => it.kind === 'online').length,
          total: items.length,
          byCategory,
        },
        items,
      };
      fs.writeFileSync(path.join(libraryOut, 'studio-catalog.json'), JSON.stringify(payload));
      console.log(`[ship-assets] assets/library: ${localStudio}/${localTotal} studio assets shipped (${mb(shippedBytes)}), catalog items ${items.length}`);

      // Copy public legal & attribution files so /LICENSE, /PRIVACY.md, /TERMS.md, /THIRD_PARTY_LICENSES.md resolve on static/--dist hosts.
      for (const legalDoc of ['LICENSE', 'PRIVACY.md', 'TERMS.md', 'THIRD_PARTY_LICENSES.md']) {
        const docSrc = path.resolve(root, legalDoc);
        if (fs.existsSync(docSrc)) {
          fs.copyFileSync(docSrc, path.join(outDir, legalDoc));
        }
      }

      // Report the final footprint + any file that a 25 MB-per-file host refuses.
      const limit = Math.max(0, Number(policy.host?.maxFileMB) || 0) * 1024 * 1024;
      const files = [];
      const walkOut = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const p = path.join(dir, entry.name);
          if (entry.isDirectory()) walkOut(p);
          else files.push({ p, size: fs.statSync(p).size });
        }
      };
      walkOut(outDir);
      const total = files.reduce((sum, f) => sum + f.size, 0);
      const heavy = files.filter((f) => limit > 0 && f.size > limit).sort((a, b) => b.size - a.size);
      console.log(`[ship-assets] dist total: ${mb(total)} in ${files.length} files`);
      if (heavy.length) {
        for (const f of heavy) {
          console.warn(`[ship-assets] ⚠ ${mb(f.size)} ${path.relative(outDir, f.p)} exceeds the ${policy.host.maxFileMB} MB per-file host limit`);
        }
      }
    },
  };
}

const useCloudflarePlugin =
  process.env.CLOUDFLARE_VITE_FORCE_BUILD_OUTPUT === 'true' || process.env.STUDIO_CF_BUILD === '1';

const clientRollupOptions = {
  input: {
    index: path.resolve(root, 'index.html'),
    embed: path.resolve(root, 'embed.html'),
    motion: path.resolve(root, 'motion.html'),
  },
  output: {
    manualChunks(id) {
      if (id.includes('/vendor/three/three.module.js')) return 'three-core';
      return undefined;
    },
  },
};

export default defineConfig({
  // Runtime code uses root-absolute URLs (/models, /vendor) -> serve at root.
  base: '/',
  publicDir: false, // assets are copied explicitly by copyRuntimeAssets
  resolve: {
    // Mirrors the browser import map in index.html (order matters).
    alias: [
      { find: 'three/addons/', replacement: vendor('three/addons') + '/' },
      { find: 'three/examples/jsm/', replacement: vendor('three/addons') + '/' },
      { find: 'three-mesh-bvh', replacement: vendor('three-mesh-bvh/index.module.js') },
      { find: 'three-bvh-csg', replacement: vendor('three-bvh-csg/index.module.js') },
      { find: 'three-gpu-pathtracer', replacement: vendor('three-gpu-pathtracer/index.module.js') },
      { find: 'rapier', replacement: vendor('rapier/rapier.mjs') },
      { find: 'mp4-muxer', replacement: vendor('mp4-muxer/mp4-muxer.mjs') },
      { find: /^three$/, replacement: vendor('three/three.module.js') },
    ],
  },
  plugins: [
    ...(useCloudflarePlugin ? [cloudflare()] : []),
    bundleDynamicAddons(),
    bundleGeometryWorker(),
    stripImportMaps(),
    shipRuntimeAssets(),
  ],
  ...(useCloudflarePlugin
    ? {
        environments: {
          client: {
            build: {
              rollupOptions: clientRollupOptions,
            },
          },
        },
      }
    : {}),
  build: {
    outDir: 'dist',
    target: 'es2022', // geometry-worker.js uses top-level await
    ...(useCloudflarePlugin ? {} : { rollupOptions: clientRollupOptions }),
    chunkSizeWarningLimit: 5000, // rapier compat chunk is ~4 MB by design
  },
  worker: {
    format: 'es', // module workers + top-level await in geometry-worker.js
    plugins: () => [bundleGeometryWorker()],
  },
});