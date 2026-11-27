/**
 * Web Blender Studio - Content-Addressed Binary Blob Store (Wave 0)
 * File: js/core/blob-store.js
 *
 * Persists heavy binary assets (geometry typed arrays, images, baked textures,
 * mocap buffers) outside JSON manifests to avoid localStorage limits and huge
 * UTF-16 string allocations.
 *
 * Backend cascade:
 *   1. OPFS (Origin Private File System) when available & writable
 *   2. IndexedDB (`web-blender-studio-blobs` / store `blobs`)
 *   3. In-memory Map (headless Node / restricted private contexts)
 */

import { gzipSync, gunzipSync } from 'three/addons/libs/fflate.module.js';

const IDB_BLOB_DB = 'web-blender-studio-blobs';
const IDB_BLOB_VERSION = 1;
const IDB_BLOB_STORE = 'blobs';
const OPFS_DIR_NAME = 'wbs-blobs';

// 8-byte magic header ("WBSGZ1\0\0") identifying Gzip-compressed OPFS/IDB blobs
// while preserving 100% backward compatibility with legacy uncompressed blobs.
const GZIP_BLOB_MAGIC = new Uint8Array([0x57, 0x42, 0x53, 0x47, 0x5a, 0x31, 0x00, 0x00]);

const encoder = new TextEncoder();

function packBlobForDisk(bytes, meta = {}) {
  if (!bytes || bytes.byteLength < 256 || meta?.compress === false) {
    return { diskBytes: bytes, compressed: false };
  }
  const mime = String(meta?.mime || '').toLowerCase();
  if (mime === 'image/webp' || mime === 'image/jpeg' || mime === 'image/jpg' || mime === 'image/avif') {
    return { diskBytes: bytes, compressed: false };
  }
  try {
    const gz = gzipSync(bytes, { level: 5 });
    if (gz.byteLength + GZIP_BLOB_MAGIC.byteLength < bytes.byteLength * 0.94) {
      const wrapped = new Uint8Array(GZIP_BLOB_MAGIC.byteLength + gz.byteLength);
      wrapped.set(GZIP_BLOB_MAGIC, 0);
      wrapped.set(gz, GZIP_BLOB_MAGIC.byteLength);
      return { diskBytes: wrapped, compressed: true };
    }
  } catch (_) {
    // Fallback to raw bytes cleanly
  }
  return { diskBytes: bytes, compressed: false };
}

function unpackBlobFromDisk(raw) {
  if (!raw || raw.byteLength <= GZIP_BLOB_MAGIC.byteLength) return raw;
  for (let i = 0; i < GZIP_BLOB_MAGIC.byteLength; i += 1) {
    if (raw[i] !== GZIP_BLOB_MAGIC[i]) return raw;
  }
  return gunzipSync(raw.subarray(GZIP_BLOB_MAGIC.byteLength));
}

function toUint8Array(data) {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  if (typeof data === 'string') return encoder.encode(data);
  throw new TypeError('[BlobStore] Unsupported binary payload type.');
}

function sanitizeRef(ref) {
  const clean = String(ref || '').replace(/[^a-zA-Z0-9._-]/g, '_');
  if (!clean || clean === '.' || clean === '..') {
    throw new Error(`[BlobStore] Invalid blob ref: "${ref}"`);
  }
  return clean;
}

function bytesToHex(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i += 1) {
    out += bytes[i].toString(16).padStart(2, '0');
  }
  return out;
}

function fnv128Hex(bytes) {
  let h1 = 0x811c9dc5;
  let h2 = 0x9e3779b9;
  let h3 = 0x85ebca6b;
  let h4 = 0xc2b2ae35;
  for (let i = 0; i < bytes.length; i += 1) {
    const b = bytes[i];
    h1 = Math.imul(h1 ^ b, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ (b + i), 0x85ebca6b) >>> 0;
    h3 = Math.imul(h3 ^ (b ^ 0xa5), 0xc2b2ae35) >>> 0;
    h4 = Math.imul(h4 ^ ((b << 3) | (b >>> 5)), 0x27d4eb2f) >>> 0;
  }
  return [h1, h2, h3, h4].map((v) => v.toString(16).padStart(8, '0')).join('');
}

/**
 * Computes a deterministic content-addressed reference for binary bytes.
 * @param {Uint8Array|ArrayBuffer|ArrayBufferView|string} data
 * @returns {Promise<string>}
 */
export async function computeBlobRef(data) {
  const bytes = toUint8Array(data);
  const subtle = globalThis.crypto?.subtle;
  if (subtle && typeof subtle.digest === 'function') {
    try {
      const digest = await subtle.digest('SHA-256', bytes);
      return `sha256-${bytesToHex(new Uint8Array(digest))}-${bytes.byteLength}`;
    } catch (_) {
      // Fall through to deterministic non-crypto digest in restricted contexts.
    }
  }
  return `fnv128-${fnv128Hex(bytes)}-${bytes.byteLength}`;
}

export class MemoryBlobBackend {
  constructor() {
    this.kind = 'memory';
    this.entries = new Map();
  }

  async has(ref) {
    return this.entries.has(sanitizeRef(ref));
  }

  async put(ref, bytes, meta = {}) {
    const key = sanitizeRef(ref);
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    const now = Date.now();
    this.entries.set(key, {
      ref: key,
      bytes: copy,
      byteLength: copy.byteLength,
      mime: meta.mime || 'application/octet-stream',
      createdAt: this.entries.get(key)?.createdAt || now,
      updatedAt: now,
    });
    return { ref: key, byteLength: copy.byteLength };
  }

  async get(ref) {
    const item = this.entries.get(sanitizeRef(ref));
    if (!item) return null;
    const copy = new Uint8Array(item.bytes.byteLength);
    copy.set(item.bytes);
    return copy;
  }

  async delete(ref) {
    return this.entries.delete(sanitizeRef(ref));
  }

  async listRefs() {
    return Array.from(this.entries.keys());
  }

  async clear() {
    this.entries.clear();
  }

  async stats() {
    let totalBytes = 0;
    for (const item of this.entries.values()) totalBytes += item.byteLength;
    return { backend: this.kind, blobCount: this.entries.size, totalBytes };
  }
}

export class IndexedDBBlobBackend {
  constructor(idbFactory = globalThis.indexedDB, dbName = IDB_BLOB_DB) {
    this.kind = 'indexeddb';
    this._idb = idbFactory;
    this._dbName = dbName;
    this._dbPromise = null;
  }

  static isSupported(idbFactory = globalThis.indexedDB) {
    return Boolean(idbFactory && typeof idbFactory.open === 'function');
  }

  _open() {
    if (this._dbPromise) return this._dbPromise;
    this._dbPromise = new Promise((resolve, reject) => {
      if (!IndexedDBBlobBackend.isSupported(this._idb)) {
        reject(new Error('IndexedDB is unavailable'));
        return;
      }
      const req = this._idb.open(this._dbName, IDB_BLOB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(IDB_BLOB_STORE)) {
          db.createObjectStore(IDB_BLOB_STORE, { keyPath: 'ref' });
        }
      };
      req.onsuccess = () => {
        const db = req.result;
        db.onversionchange = () => {
          db.close();
          this._dbPromise = null;
        };
        resolve(db);
      };
      req.onerror = () => {
        this._dbPromise = null;
        reject(req.error || new Error('Failed to open blob IndexedDB'));
      };
    });
    return this._dbPromise;
  }

  _tx(mode, fn) {
    return this._open().then((db) => new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_BLOB_STORE, mode);
      const store = tx.objectStore(IDB_BLOB_STORE);
      let reqOrVal;
      try {
        reqOrVal = fn(store);
      } catch (err) {
        reject(err);
        return;
      }
      tx.oncomplete = () => resolve(reqOrVal && reqOrVal.__req ? reqOrVal.__req.result : reqOrVal);
      tx.onerror = () => reject(tx.error || new Error('IndexedDB blob transaction error'));
      tx.onabort = () => reject(tx.error || new Error('IndexedDB blob transaction aborted'));
    }));
  }

  async has(ref) {
    const key = sanitizeRef(ref);
    const res = await this._tx('readonly', (store) => ({ __req: store.getKey(key) }));
    return res !== undefined;
  }

  async put(ref, bytes, meta = {}) {
    const key = sanitizeRef(ref);
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    const now = Date.now();
    await this._tx('readwrite', (store) => store.put({
      ref: key,
      bytes: copy,
      byteLength: copy.byteLength,
      mime: meta.mime || 'application/octet-stream',
      updatedAt: now,
    }));
    return { ref: key, byteLength: copy.byteLength };
  }

  async get(ref) {
    const key = sanitizeRef(ref);
    const record = await this._tx('readonly', (store) => ({ __req: store.get(key) }));
    if (!record || !record.bytes) return null;
    return toUint8Array(record.bytes);
  }

  async delete(ref) {
    const key = sanitizeRef(ref);
    await this._tx('readwrite', (store) => store.delete(key));
    return true;
  }

  async listRefs() {
    const keys = await this._tx('readonly', (store) => ({ __req: store.getAllKeys() }));
    return Array.isArray(keys) ? keys.map(String) : [];
  }

  async clear() {
    await this._tx('readwrite', (store) => store.clear());
  }

  async stats() {
    const records = await this._tx('readonly', (store) => ({ __req: store.getAll() }));
    let totalBytes = 0;
    const list = Array.isArray(records) ? records : [];
    for (const r of list) totalBytes += Number(r?.byteLength || r?.bytes?.byteLength || 0);
    return { backend: this.kind, blobCount: list.length, totalBytes };
  }
}

export class OPFSBlobBackend {
  constructor(storageObj = globalThis.navigator?.storage, dirName = OPFS_DIR_NAME) {
    this.kind = 'opfs';
    this._storage = storageObj;
    this._dirName = dirName;
    this._dirPromise = null;
  }

  static isSupported(storageObj = globalThis.navigator?.storage) {
    return Boolean(storageObj && typeof storageObj.getDirectory === 'function');
  }

  async _getDir() {
    if (this._dirPromise) return this._dirPromise;
    this._dirPromise = (async () => {
      const root = await this._storage.getDirectory();
      return await root.getDirectoryHandle(this._dirName, { create: true });
    })();
    return this._dirPromise;
  }

  async has(ref) {
    const key = sanitizeRef(ref);
    const dir = await this._getDir();
    try {
      await dir.getFileHandle(key, { create: false });
      return true;
    } catch (_) {
      return false;
    }
  }

  async put(ref, bytes) {
    const key = sanitizeRef(ref);
    const dir = await this._getDir();
    const handle = await dir.getFileHandle(key, { create: true });
    if (typeof handle.createWritable !== 'function') {
      throw new Error('OPFS FileSystemFileHandle.createWritable is unavailable');
    }
    const writable = await handle.createWritable();
    try {
      await writable.write(bytes);
      await writable.close();
    } catch (err) {
      try { await writable.abort?.(); } catch (_) {}
      throw err;
    }
    return { ref: key, byteLength: bytes.byteLength };
  }

  async get(ref) {
    const key = sanitizeRef(ref);
    const dir = await this._getDir();
    try {
      const handle = await dir.getFileHandle(key, { create: false });
      const file = await handle.getFile();
      return new Uint8Array(await file.arrayBuffer());
    } catch (_) {
      return null;
    }
  }

  async delete(ref) {
    const key = sanitizeRef(ref);
    const dir = await this._getDir();
    try {
      await dir.removeEntry(key);
      return true;
    } catch (_) {
      return false;
    }
  }

  async listRefs() {
    const dir = await this._getDir();
    const refs = [];
    for await (const [name, handle] of dir.entries()) {
      if (!handle || handle.kind === 'file') refs.push(name);
    }
    return refs;
  }

  async clear() {
    const refs = await this.listRefs();
    for (const ref of refs) await this.delete(ref);
  }

  async stats() {
    const dir = await this._getDir();
    let blobCount = 0;
    let totalBytes = 0;
    for await (const [, handle] of dir.entries()) {
      if (handle && handle.kind && handle.kind !== 'file') continue;
      blobCount += 1;
      try {
        const file = await handle.getFile();
        totalBytes += Number(file?.size || 0);
      } catch (_) {}
    }
    return { backend: this.kind, blobCount, totalBytes };
  }
}

export class BlobStore {
  /**
   * @param {Object} [options]
   * @param {Object} [options.backend] Explicit backend instance for testing
   * @param {Object} [options.storage] Custom navigator.storage implementation
   * @param {Object} [options.indexedDB] Custom IDBFactory implementation
   * @param {boolean} [options.preferOPFS=true]
   */
  constructor(options = {}) {
    this._explicitBackend = options.backend || null;
    this._storage = options.storage !== undefined ? options.storage : globalThis.navigator?.storage;
    this._indexedDB = options.indexedDB !== undefined ? options.indexedDB : globalThis.indexedDB;
    this._preferOPFS = options.preferOPFS !== false;
    this._backend = this._explicitBackend;
    this._initPromise = null;
  }

  async _selectBackend() {
    if (this._backend) return this._backend;

    if (this._preferOPFS && OPFSBlobBackend.isSupported(this._storage)) {
      const opfs = new OPFSBlobBackend(this._storage);
      try {
        await opfs._getDir();
        this._backend = opfs;
        return this._backend;
      } catch (_) {
        // Fallback to IndexedDB below.
      }
    }

    if (IndexedDBBlobBackend.isSupported(this._indexedDB)) {
      const idb = new IndexedDBBlobBackend(this._indexedDB);
      try {
        await idb._open();
        this._backend = idb;
        return this._backend;
      } catch (_) {
        // Fallback to memory below.
      }
    }

    this._backend = new MemoryBlobBackend();
    return this._backend;
  }

  async init() {
    if (this._backend) return this._backend;
    if (!this._initPromise) {
      this._initPromise = this._selectBackend().finally(() => {
        this._initPromise = null;
      });
    }
    return this._initPromise;
  }

  get backendKind() {
    return this._backend?.kind || 'uninitialized';
  }

  async _demoteFromOpfsIfFailed(err, opFn) {
    if (this._explicitBackend || this._backend?.kind !== 'opfs') throw err;
    console.warn('[BlobStore] OPFS failed, falling back to IndexedDB/Memory:', err?.message || err);
    this._backend = null;
    this._preferOPFS = false;
    const next = await this.init();
    return opFn(next);
  }

  async put(data, meta = {}) {
    const bytes = toUint8Array(data);
    const ref = await computeBlobRef(bytes);
    let packed = null;
    const ensurePacked = () => packed || (packed = packBlobForDisk(bytes, meta));
    const writeToBackend = async (targetBackend) => {
      if (await targetBackend.has(ref)) {
        return {
          ref,
          byteLength: bytes.byteLength,
          storedBytes: bytes.byteLength,
          compressed: false,
          mime: meta.mime || 'application/octet-stream',
          deduplicated: true,
          backend: targetBackend.kind,
        };
      }
      const { diskBytes, compressed } = ensurePacked();
      await targetBackend.put(ref, diskBytes, meta);
      return {
        ref,
        byteLength: bytes.byteLength,
        storedBytes: diskBytes.byteLength,
        compressed,
        mime: meta.mime || 'application/octet-stream',
        deduplicated: false,
        backend: targetBackend.kind,
      };
    };
    const backend = await this.init();
    try {
      return await writeToBackend(backend);
    } catch (err) {
      return await this._demoteFromOpfsIfFailed(err, writeToBackend);
    }
  }

  async get(ref) {
    const backend = await this.init();
    const raw = await backend.get(ref);
    return raw ? unpackBlobFromDisk(raw) : null;
  }

  async has(ref) {
    const backend = await this.init();
    return await backend.has(ref);
  }

  async delete(ref) {
    const backend = await this.init();
    return await backend.delete(ref);
  }

  async listRefs() {
    const backend = await this.init();
    return await backend.listRefs();
  }

  async clear() {
    const backend = await this.init();
    await backend.clear();
  }

  /**
   * Removes blobs not in `keepRefs`.
   * @param {Iterable<string>} keepRefs
   * @returns {Promise<{removedCount:number, keptCount:number}>}
   */
  async gc(keepRefs = []) {
    const keep = new Set(Array.from(keepRefs || []).map(String));
    const existing = await this.listRefs();
    let removedCount = 0;
    let keptCount = 0;
    for (const ref of existing) {
      if (keep.has(ref)) {
        keptCount += 1;
      } else {
        const deleted = await this.delete(ref).catch(() => false);
        if (deleted) removedCount += 1;
      }
    }
    return { removedCount, keptCount };
  }

  async stats() {
    const backend = await this.init();
    const base = await backend.stats();
    let quota = null;
    let usage = null;
    if (this._storage && typeof this._storage.estimate === 'function') {
      try {
        const est = await this._storage.estimate();
        quota = Number.isFinite(est?.quota) ? est.quota : null;
        usage = Number.isFinite(est?.usage) ? est.usage : null;
      } catch (_) {}
    }
    return { ...base, quota, usage };
  }
}

export const blobStore = new BlobStore();

export default blobStore;
