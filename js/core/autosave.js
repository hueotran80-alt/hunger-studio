/**
 * Web Blender Studio - Local Crash Recovery & Rolling Checkpoint Store (Wave 0)
 * File: js/core/autosave.js
 *
 * Persists rolling project checkpoints to IndexedDB + OPFS/IDB binary BlobStore
 * so a browser crash, tab close, or power loss never destroys hours of work.
 * Heavy buffers & embedded textures are dehydrated into deduplicated binary blobs
 * while keeping `saveDraft` / `loadDraft` / `clearDraft` / `startAutosave` 100%
 * compatible with existing Studio callers.
 */

import { blobStore as defaultBlobStore } from './blob-store.js';
import {
  collectProjectBlobRefs,
  dehydrateProjectBlobs,
  hydrateProjectBlobs,
} from './project-migrator.js';

const DB_NAME = 'web-blender-studio';
const DB_VERSION = 2;
const STORE = 'drafts';
const META_STORE = 'meta';
const DRAFT_KEY = 'current';
const RING_META_KEY = 'checkpoint_ring';
const SENTINEL_META_KEY = 'session_sentinel';
const LOCAL_SENTINEL_KEY = 'wbs:session_sentinel';
const MAX_CHECKPOINTS = 3;
const DEFAULT_DEHYDRATE_THRESHOLD = 48 * 1024; // 48 KB

function safeGetLocalStorage(customStorage = null) {
  if (customStorage) return customStorage;
  try {
    return typeof globalThis.localStorage !== 'undefined' ? globalThis.localStorage : null;
  } catch (_) {
    return null;
  }
}

export class AutosaveManager {
  /**
   * @param {Object} [options]
   * @param {Object} [options.indexedDB]
   * @param {import('./blob-store.js').BlobStore} [options.blobStore]
   * @param {Object} [options.localStorage]
   * @param {number} [options.maxCheckpoints=3]
   * @param {number} [options.dehydrateThresholdBytes=49152]
   */
  constructor(options = {}) {
    this._idb = options.indexedDB !== undefined ? options.indexedDB : globalThis.indexedDB;
    this._blobStore = options.blobStore || defaultBlobStore;
    this._localStorage = options.localStorage || null;
    this._dbName = options.dbName || DB_NAME;
    this._maxCheckpoints = Math.max(1, Number(options.maxCheckpoints) || MAX_CHECKPOINTS);
    this._dehydrateThresholdBytes = Math.max(0, Number(options.dehydrateThresholdBytes ?? DEFAULT_DEHYDRATE_THRESHOLD));
    this._dbPromise = null;
    this._tabId = `tab_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
    this._previousCrashDetected = false;
    this._sessionStarted = false;
  }

  _openDb() {
    if (this._dbPromise) return this._dbPromise;
    this._dbPromise = new Promise((resolve, reject) => {
      if (!this._idb || typeof this._idb.open !== 'function') {
        reject(new Error('IndexedDB is not available'));
        return;
      }
      const request = this._idb.open(this._dbName, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains(META_STORE)) {
          db.createObjectStore(META_STORE, { keyPath: 'key' });
        }
      };
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => {
          db.close();
          this._dbPromise = null;
        };
        resolve(db);
      };
      request.onerror = () => {
        this._dbPromise = null;
        reject(request.error || new Error('IndexedDB open failed'));
      };
    });
    return this._dbPromise;
  }

  _withStore(storeName, mode, run) {
    return this._openDb().then((db) => new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, mode);
      const store = tx.objectStore(storeName);
      let result;
      try {
        result = run(store);
      } catch (error) {
        reject(error);
        return;
      }
      tx.oncomplete = () => resolve(result && result.__request ? result.__request.result : result);
      tx.onerror = () => reject(tx.error || new Error('IndexedDB transaction failed'));
      tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted'));
    }));
  }

  _readLocalSentinel() {
    const ls = safeGetLocalStorage(this._localStorage);
    if (!ls) return null;
    try {
      const raw = ls.getItem(LOCAL_SENTINEL_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (_) {
      return null;
    }
  }

  _writeLocalSentinel(payload) {
    const ls = safeGetLocalStorage(this._localStorage);
    if (!ls) return;
    try {
      ls.setItem(LOCAL_SENTINEL_KEY, JSON.stringify(payload));
    } catch (_) {
      // Ignore quota / private mode storage errors for tiny sentinel flag.
    }
  }

  /**
   * Starts session heartbeat & checks whether the previous session exited uncleanly.
   * @returns {Promise<{ crashDetected: boolean, previousSession: Object|null }>}
   */
  async beginSession() {
    if (this._sessionStarted && this._beginSessionResult) {
      return this._beginSessionResult;
    }
    if (this._beginSessionPromise) {
      return this._beginSessionPromise;
    }
    this._beginSessionPromise = (async () => {
      let previous = this._readLocalSentinel();
      if (!previous) {
        try {
          const rec = await this._withStore(META_STORE, 'readonly', (s) => ({ __request: s.get(SENTINEL_META_KEY) }));
          previous = rec?.value || null;
        } catch (_) {
          previous = null;
        }
      }

      const now = Date.now();
      const ageMs = previous?.lastHeartbeat ? now - Number(previous.lastHeartbeat) : Infinity;
      const crashDetected = Boolean(
        previous &&
        previous.active === true &&
        previous.cleanExit === false &&
        previous.tabId !== this._tabId &&
        ageMs >= 0 &&
        ageMs < 7 * 24 * 60 * 60 * 1000
      );

      this._previousCrashDetected = crashDetected;
      this._sessionStarted = true;

      const current = {
        tabId: this._tabId,
        startedAt: now,
        lastHeartbeat: now,
        active: true,
        cleanExit: false,
      };
      this._writeLocalSentinel(current);
      try {
        await this._withStore(META_STORE, 'readwrite', (s) => s.put({ key: SENTINEL_META_KEY, value: current }));
      } catch (_) {}

      const result = { crashDetected, previousSession: previous };
      this._beginSessionResult = result;
      return result;
    })();
    try {
      return await this._beginSessionPromise;
    } finally {
      this._beginSessionPromise = null;
    }
  }

  markCleanExit() {
    const payload = {
      tabId: this._tabId,
      startedAt: Date.now(),
      lastHeartbeat: Date.now(),
      active: false,
      cleanExit: true,
    };
    this._writeLocalSentinel(payload);
    // Best-effort async mirror to IDB
    this._withStore(META_STORE, 'readwrite', (s) => s.put({ key: SENTINEL_META_KEY, value: payload })).catch(() => {});
  }

  async _getRing() {
    try {
      const rec = await this._withStore(META_STORE, 'readonly', (s) => ({ __request: s.get(RING_META_KEY) }));
      return Array.isArray(rec?.slots) ? rec.slots : [];
    } catch (_) {
      return [];
    }
  }

  async _putRing(slots) {
    await this._withStore(META_STORE, 'readwrite', (s) => s.put({
      key: RING_META_KEY,
      slots,
      updatedAt: Date.now(),
    }));
  }

  async _collectAllLiveBlobRefs() {
    const keep = new Set();
    const ring = await this._getRing();
    for (const slot of ring) {
      for (const ref of slot?.blobRefs || []) keep.add(ref);
    }
    try {
      const cur = await this._withStore(STORE, 'readonly', (s) => ({ __request: s.get(DRAFT_KEY) }));
      for (const ref of cur?.blobRefs || []) keep.add(ref);
    } catch (_) {}
    return keep;
  }

  async _prepareRecord(input, meta = {}) {
    const isObj = input && typeof input === 'object' && !Array.isArray(input);
    if (!isObj && typeof input !== 'string') return null;
    if (typeof input === 'string' && !input) return null;

    let rawBytes = typeof input === 'string' ? input.length : 0;
    const shouldDehydrate = meta.dehydrate !== false && (
      meta.forceDehydrate === true ||
      isObj ||
      rawBytes >= this._dehydrateThresholdBytes
    );

    let storedJson = '';
    let dehydrated = false;
    let blobRefs = [];
    let storageBackend = 'indexeddb';
    let diskBytes = 0;
    let objectCount = Number.isFinite(meta.objectCount) ? meta.objectCount : null;
    let schemaVersion = Number.isFinite(meta.schemaVersion) ? meta.schemaVersion : null;

    if (shouldDehydrate) {
      let parsed = isObj ? input : null;
      if (!parsed) {
        try {
          parsed = JSON.parse(input);
        } catch (_) {
          parsed = null;
        }
      }
      if (parsed && typeof parsed === 'object') {
        if (objectCount === null && Array.isArray(parsed.objects)) {
          objectCount = parsed.objects.length;
        }
        if (schemaVersion === null && Number.isFinite(Number(parsed?.meta?.schemaVersion))) {
          schemaVersion = Number(parsed.meta.schemaVersion);
        }
        if (parsed.sceneGraph || parsed.modifierSources) {
          const res = await dehydrateProjectBlobs(
            parsed,
            (bytes, bMeta) => this._blobStore.put(bytes, bMeta),
            { minBytes: meta.minBlobBytes ?? 512 }
          );
          if (res.dehydratedCount > 0 || res.blobRefs.length > 0) {
            storedJson = JSON.stringify(res.manifest);
            dehydrated = true;
            blobRefs = res.blobRefs;
            storageBackend = this._blobStore.backendKind;
            diskBytes = storedJson.length + (res.totalStoredBytes || res.totalBlobBytes || 0);
            if (!rawBytes) {
              rawBytes = storedJson.length + (res.totalBlobBytes || 0);
            }
          }
        }
      }
    }

    if (!storedJson) {
      storedJson = typeof input === 'string' ? input : JSON.stringify(input);
      if (!storedJson) return null;
      if (!rawBytes) rawBytes = storedJson.length;
      if (!diskBytes) diskBytes = storedJson.length;
    }

    const savedAt = Number.isFinite(meta.savedAt) ? meta.savedAt : Date.now();
    return {
      savedAt,
      json: storedJson,
      dehydrated,
      blobRefs,
      storageBackend,
      rawBytes,
      diskBytes,
      manifestBytes: storedJson.length,
      objectCount,
      schemaVersion,
      crashDetected: this._previousCrashDetected,
    };
  }

  /**
   * Saves a rolling checkpoint + updates the `current` draft pointer.
   * Writes the rotating checkpoint slot first so crashes mid-write leave
   * older checkpoints intact.
   */
  async saveDraft(input, meta = {}) {
    const prepared = await this._prepareRecord(input, meta);
    if (!prepared) return false;

    const ring = await this._getRing();
    const usedIds = new Set(ring.map((r) => r.id));
    let slotId = 'checkpoint_0';
    for (let i = 0; i < this._maxCheckpoints; i += 1) {
      const candidate = `checkpoint_${i}`;
      if (!usedIds.has(candidate)) {
        slotId = candidate;
        break;
      }
    }
    if (usedIds.size >= this._maxCheckpoints && ring.length > 0) {
      // Overwrite the oldest slot in the ring
      slotId = ring[ring.length - 1].id;
    }

    const checkpointRecord = {
      ...meta,
      ...prepared,
      id: slotId,
    };
    const currentRecord = {
      ...meta,
      ...prepared,
      id: DRAFT_KEY,
      checkpointId: slotId,
    };

    // Step 1: Write checkpoint slot atomically
    await this._withStore(STORE, 'readwrite', (store) => store.put(checkpointRecord));

    // Step 2: Rotate ring metadata newest-first
    const nextRing = [
      {
        id: slotId,
        savedAt: prepared.savedAt,
        rawBytes: prepared.rawBytes,
        diskBytes: prepared.diskBytes,
        manifestBytes: prepared.manifestBytes,
        objectCount: prepared.objectCount,
        schemaVersion: prepared.schemaVersion,
        dehydrated: prepared.dehydrated,
        blobRefs: prepared.blobRefs,
        storageBackend: prepared.storageBackend,
      },
      ...ring.filter((entry) => entry && entry.id !== slotId),
    ].slice(0, this._maxCheckpoints);

    await this._putRing(nextRing);

    // Step 3: Update 'current' draft pointer & heartbeat (always use wall-clock time)
    await this._withStore(STORE, 'readwrite', (store) => store.put(currentRecord));
    this._writeLocalSentinel({
      tabId: this._tabId,
      lastHeartbeat: Date.now(),
      active: true,
      cleanExit: false,
    });

    // Step 4: Garbage-collect blobs no longer referenced by any surviving checkpoint
    try {
      const keep = await this._collectAllLiveBlobRefs();
      await this._blobStore.gc(keep);
    } catch (_) {
      // GC failure must never break autosave.
    }

    return true;
  }

  async _hydrateRecord(record) {
    if (!record || !record.json) return null;
    if (!record.dehydrated) {
      return {
        ...record,
        crashDetected: Boolean(record.crashDetected || this._previousCrashDetected),
      };
    }

    const manifest = JSON.parse(record.json);
    const { data } = await hydrateProjectBlobs(manifest, (ref) => this._blobStore.get(ref), { strict: true });
    return {
      ...record,
      json: JSON.stringify(data),
      manifest,
      crashDetected: Boolean(record.crashDetected || this._previousCrashDetected),
    };
  }

  /**
   * Lists rolling checkpoints (newest first), without hydrating heavy payloads.
   */
  async listCheckpoints() {
    const ring = await this._getRing();
    return ring.map((item) => ({ ...item }));
  }

  async loadCheckpoint(slotId) {
    try {
      const record = await this._withStore(STORE, 'readonly', (store) => ({
        __request: store.get(slotId),
      }));
      if (!record) return null;
      return await this._hydrateRecord(record);
    } catch (_) {
      return null;
    }
  }

  /**
   * Loads the `current` draft, automatically falling back across the rolling
   * checkpoint ring if `current` is missing, corrupt, or missing a blob.
   */
  async loadDraft({ hydrate = true } = {}) {
    const candidates = [DRAFT_KEY];
    const ring = await this._getRing();
    for (const slot of ring) {
      if (slot?.id && !candidates.includes(slot.id)) candidates.push(slot.id);
    }

    for (const id of candidates) {
      try {
        const record = await this._withStore(STORE, 'readonly', (store) => ({
          __request: store.get(id),
        }));
        if (!record || !record.json) continue;
        // Validate JSON syntax before hydrating
        JSON.parse(record.json);
        if (!hydrate) {
          return {
            ...record,
            checkpoints: ring,
            recoveredFromFallback: id !== DRAFT_KEY,
            crashDetected: Boolean(record.crashDetected || this._previousCrashDetected),
          };
        }
        const hydrated = await this._hydrateRecord(record);
        if (hydrated) {
          hydrated.checkpoints = ring;
          hydrated.recoveredFromFallback = id !== DRAFT_KEY;
          return hydrated;
        }
      } catch (_) {
        // Corrupt slot or missing blob: try next older checkpoint
      }
    }

    return null;
  }

  async clearDraft() {
    try {
      const ring = await this._getRing();
      await this._withStore(STORE, 'readwrite', (store) => {
        store.delete(DRAFT_KEY);
        for (const slot of ring) {
          if (slot?.id) store.delete(slot.id);
        }
        for (let i = 0; i < this._maxCheckpoints; i += 1) {
          store.delete(`checkpoint_${i}`);
        }
      });
      await this._putRing([]);
      await this._blobStore.gc([]);
      return true;
    } catch (_) {
      return false;
    }
  }

  /**
   * Starts periodic + visibility-change + clean-exit sentinel autosave.
   * Supports `isDirty()` gating and `requestIdleCallback` to avoid blocking interaction.
   */
  startAutosave(getJson, options = {}) {
    const intervalMs = Math.max(5000, options.intervalMs || 20000);
    const isDirty = typeof options.isDirty === 'function' ? options.isDirty : null;
    const getRevision = typeof options.getRevision === 'function' ? options.getRevision : null;
    let stopped = false;
    let inFlight = false;
    let lastSavedRevision = options.initialRevision ?? null;

    if (!this._sessionStarted) {
      this.beginSession().catch(() => {});
    }

    const runSave = async (force = false) => {
      if (stopped || inFlight) return false;
      const revBeforeSave = getRevision ? getRevision() : null;
      if (!force) {
        if (getRevision && revBeforeSave === lastSavedRevision) return false;
        if (isDirty && isDirty(lastSavedRevision) === false) return false;
      }
      inFlight = true;
      try {
        const payload = await getJson();
        if (!payload) return false;
        const ok = await this.saveDraft(payload, options.meta || {});
        if (ok && getRevision) {
          lastSavedRevision = revBeforeSave;
        }
        options.onSaved?.(ok);
        return ok;
      } catch (err) {
        options.onError?.(err);
        return false;
      } finally {
        inFlight = false;
      }
    };

    const tick = () => {
      if (stopped) return;
      if (typeof globalThis.requestIdleCallback === 'function') {
        globalThis.requestIdleCallback(() => { runSave(false).catch(() => {}); }, { timeout: 2500 });
      } else {
        runSave(false).catch(() => {});
      }
    };

    const timer = setInterval(tick, intervalMs);
    const onVisibility = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
        runSave(true).catch(() => {});
      }
    };
    const onPageHide = () => {
      this.markCleanExit();
    };

    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVisibility);
    }
    if (typeof window !== 'undefined') {
      window.addEventListener('pagehide', onPageHide);
    }

    return () => {
      stopped = true;
      clearInterval(timer);
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVisibility);
      }
      if (typeof window !== 'undefined') {
        window.removeEventListener('pagehide', onPageHide);
      }
    };
  }
}

export const defaultAutosaveManager = new AutosaveManager();

export async function saveDraft(json, meta = {}) {
  return defaultAutosaveManager.saveDraft(json, meta);
}

export async function loadDraft(options = {}) {
  return defaultAutosaveManager.loadDraft(options);
}

export async function clearDraft() {
  return defaultAutosaveManager.clearDraft();
}

export async function listCheckpoints() {
  return defaultAutosaveManager.listCheckpoints();
}

export async function loadCheckpoint(id) {
  return defaultAutosaveManager.loadCheckpoint(id);
}

export async function beginAutosaveSession() {
  return defaultAutosaveManager.beginSession();
}

export function markAutosaveCleanExit() {
  return defaultAutosaveManager.markCleanExit();
}

export function startAutosave(getJson, options = {}) {
  return defaultAutosaveManager.startAutosave(getJson, options);
}

export { collectProjectBlobRefs };
