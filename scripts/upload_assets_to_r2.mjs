#!/usr/bin/env node
/**
 * Upload commercial-safe runtime assets (`models/`, `vendor/mediapipe/`,
 * and commercial-safe `assets/` library models) to Cloudflare R2 (`hunger-assets`)
 * using the official `cf` CLI (`cf r2 objects put`).
 *
 * Respects `assets/asset-ship-policy.json` so non-commercial / Mixamo / RPM /
 * `uploaded_mocap_*` files are never uploaded.
 *
 * Usage:
 *   node scripts/upload_assets_to_r2.mjs --dry-run
 *   node scripts/upload_assets_to_r2.mjs --bucket hunger-assets
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const POLICY_PATH = path.join(ROOT, 'assets/asset-ship-policy.json');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const bucketIdx = args.indexOf('--bucket');
const bucket = (bucketIdx >= 0 && args[bucketIdx + 1]) ? args[bucketIdx + 1] : (process.env.HUNGER_R2_BUCKET || 'hunger-assets');

const policy = fs.existsSync(POLICY_PATH)
  ? JSON.parse(fs.readFileSync(POLICY_PATH, 'utf8'))
  : { models: {}, library: {} };

const files = [];

function collectFiltered(baseDir, keyPrefix, { excludeDirs = [], excludeFiles = [], excludePrefixes = [] } = {}) {
  const skipFiles = new Set(['.DS_Store', 'Thumbs.db', ...excludeFiles]);
  const walk = (dir, rel) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (excludeDirs.includes(relPath)) continue;
        walk(path.join(dir, entry.name), relPath);
      } else {
        if (skipFiles.has(entry.name) || skipFiles.has(relPath)) continue;
        if (excludePrefixes.some((p) => entry.name.startsWith(p))) continue;
        const abs = path.join(dir, entry.name);
        files.push({ abs, key: `${keyPrefix}/${relPath}`, size: fs.statSync(abs).size });
      }
    }
  };
  walk(baseDir, '');
}

// 1. models/ (respecting ship policy exclusions + uploaded_mocap_ prefix)
collectFiltered(path.join(ROOT, 'models'), 'models', policy.models || {});

// 2. vendor/mediapipe/ (WASM vision bundle)
collectFiltered(path.join(ROOT, 'vendor/mediapipe'), 'vendor/mediapipe', {});

// 3. Commercial-safe studio assets from studio-catalog.json under assets/
const catalogPath = path.join(ROOT, 'assets/library/studio-catalog.json');
if (fs.existsSync(catalogPath)) {
  const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
  const libPolicy = policy.library || {};
  const maxBytes = Math.max(0, Number(libPolicy.maxAssetMB) || 0) * 1024 * 1024;
  const blocked = new Set((libPolicy.exclude || []).map((v) => String(v).replace(/^\/+/, '')));
  const forced = new Set((libPolicy.include || []).map((v) => String(v).replace(/^\/+/, '')));
  for (const item of catalog.items || []) {
    if (item.kind !== 'studio') continue;
    const rel = String(item.url || '').replace(/^\/+/, '');
    if (!rel.startsWith('assets/')) continue;
    const abs = path.join(ROOT, rel);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) continue;
    const size = fs.statSync(abs).size;
    if (blocked.has(rel)) continue;
    if (libPolicy.requireCommercialSafe && item.commercialSafe !== true) continue;
    if (!forced.has(rel) && maxBytes > 0 && size > maxBytes) continue;
    files.push({ abs, key: rel, size });
    const thumbRel = String(item.thumb || item.thumbnail || item.preview || '').replace(/^\/+/, '');
    if (thumbRel && thumbRel.startsWith('assets/')) {
      const thumbAbs = path.join(ROOT, thumbRel);
      if (fs.existsSync(thumbAbs) && fs.statSync(thumbAbs).isFile() && !files.some((f) => f.key === thumbRel)) {
        files.push({ abs: thumbAbs, key: thumbRel, size: fs.statSync(thumbAbs).size });
      }
    }
  }
}

const totalMB = (files.reduce((s, f) => s + f.size, 0) / (1024 * 1024)).toFixed(2);
console.log(`[r2-upload] Bucket: ${bucket} | Files: ${files.length} | Total: ${totalMB} MB${dryRun ? ' (DRY RUN)' : ''}`);

const CONTENT_TYPES = {
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.bin': 'application/octet-stream',
  '.wasm': 'application/wasm',
  '.task': 'application/octet-stream',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.json': 'application/json; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
};

function guessMime(filePath) {
  return CONTENT_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
}

const localCf = path.join(ROOT, 'node_modules', '.bin', 'cf');
const cfBin = fs.existsSync(localCf) ? localCf : 'cf';

// Fetch existing objects in R2 so interrupted uploads resume cleanly without re-uploading.
const existingSizes = new Map();
if (!dryRun) {
  try {
    const raw = execFileSync(cfBin, ['r2', 'objects', 'list', '--bucket-name', bucket, '-q'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const parsed = JSON.parse(raw);
    const items = Array.isArray(parsed) ? parsed : (parsed.objects || parsed.result || []);
    for (const it of items) {
      if (it && it.key) existingSizes.set(String(it.key), Number(it.size));
    }
    if (existingSizes.size) {
      console.log(`[r2-upload] Found ${existingSizes.size} existing objects in r2://${bucket} (skipping identical sizes)`);
    }
  } catch {
    // proceed with full upload if list fails
  }
}

let uploaded = 0;
let skipped = 0;
for (const file of files) {
  const mime = guessMime(file.abs);
  const target = `${bucket}/${file.key}`;
  if (dryRun) {
    console.log(`  [dry-run] ${file.key} (${(file.size / 1024).toFixed(1)} KB, ${mime}) -> r2://${target}`);
    continue;
  }
  if (existingSizes.get(file.key) === file.size) {
    console.log(`  [skip] ${file.key} (${(file.size / 1024).toFixed(1)} KB — already uploaded)`);
    skipped += 1;
    continue;
  }
  let ok = false;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      console.log(`  Uploading ${file.key} (${(file.size / 1024).toFixed(1)} KB)${attempt > 1 ? ` [retry ${attempt}/3]` : ''}...`);
      execFileSync(cfBin, [
        'r2', 'objects', 'put', file.key,
        '--bucket-name', bucket,
        '--file', file.abs,
        '--content-type', mime,
        '-q',
      ], { stdio: 'inherit' });
      ok = true;
      uploaded += 1;
      break;
    } catch (err) {
      if (attempt === 3) throw err;
      console.warn(`  ⚠ Upload failed for ${file.key} (attempt ${attempt}/3), retrying...`);
    }
  }
  if (!ok) throw new Error(`Failed to upload ${file.key}`);
}

console.log(`[r2-upload] Done (${uploaded} uploaded, ${skipped} skipped, ${files.length} total).`);
