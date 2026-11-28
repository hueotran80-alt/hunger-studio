/**
 * Hunger 3D Studio / Hunger Motion — Sentry-Compatible Crash Monitoring & Product Analytics
 * File: js/core/telemetry.js
 *
 * Tracks the 5 Beta release health KPIs with zero external SDK bloat:
 *   1. Crash-free session rate (>= 99%)
 *   2. Video -> GLB success rate (>= 90%)
 *   3. Time-to-first-animation (<= 10 min)
 *   4. Initial interactive load (<= 5 s on 4G)
 *   5. Motion workspace & template funnel conversion
 *
 * Delivers sanitized events to same-origin `POST /api/telemetry/event`, which logs
 * structured telemetry on Cloudflare Edge and forwards error events in standard
 * Sentry Envelope v7 format whenever `SENTRY_DSN` is configured server-side.
 */

export const TELEMETRY_RELEASE = 'hunger-motion@0.9.0-beta.2';
const MAX_QUEUED_EVENTS = 25;
const MAX_ERROR_STACK_CHARS = 1800;

function randomHex(bytes = 16) {
  const arr = new Uint8Array(bytes);
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(arr);
  } else {
    for (let i = 0; i < bytes; i++) arr[i] = Math.floor(Math.random() * 256);
  }
  return Array.from(arr, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function sanitizeTelemetryString(str, maxLen = 400) {
  let out = String(str ?? '');
  // Redact tokens, emails, and local user home directories
  out = out
    .replace(/([?&](?:token|key|apikey|access_token|secret)=)[^&\s]+/gi, '$1[REDACTED]')
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[EMAIL]')
    .replace(/\/Users\/[^/\s]+/g, '/Users/[USER]')
    .replace(/C:\\Users\\[^\\\s]+/gi, 'C:\\Users\\[USER]');
  return out.length > maxLen ? `${out.slice(0, maxLen)}…` : out;
}

export function buildSentryEventPayload(error, options = {}) {
  const errObj = error instanceof Error ? error : new Error(String(error ?? 'Unknown error'));
  const message = sanitizeTelemetryString(errObj.message || String(error || 'Unknown error'), 500);
  const stack = sanitizeTelemetryString(errObj.stack || '', MAX_ERROR_STACK_CHARS);
  const frames = stack
    .split('\n')
    .slice(1, 16)
    .map((line) => ({ function: sanitizeTelemetryString(line.trim(), 220) }));

  return {
    event_id: randomHex(16),
    timestamp: Math.floor(Date.now() / 1000),
    platform: 'javascript',
    level: options.fatal ? 'fatal' : (options.level || 'error'),
    release: options.release || TELEMETRY_RELEASE,
    environment: options.environment || detectEnvironment(),
    tags: {
      subsystem: String(options.subsystem || 'runtime').slice(0, 64),
      workspace: String(options.workspace || 'unknown').slice(0, 32),
      fatal: options.fatal ? 'true' : 'false',
    },
    exception: {
      values: [
        {
          type: sanitizeTelemetryString(errObj.name || 'Error', 80),
          value: message,
          stacktrace: frames.length ? { frames } : undefined,
        },
      ],
    },
    extra: sanitizeExtra(options.extra),
  };
}

function sanitizeExtra(extra) {
  if (!extra || typeof extra !== 'object') return {};
  const clean = {};
  const entries = Object.entries(extra).slice(0, 20);
  for (const [k, v] of entries) {
    const key = String(k).slice(0, 64);
    if (typeof v === 'number') clean[key] = Number.isFinite(v) ? v : null;
    else if (typeof v === 'boolean' || v === null) clean[key] = v;
    else if (typeof v === 'string') clean[key] = sanitizeTelemetryString(v, 240);
    else if (Array.isArray(v)) clean[key] = v.slice(0, 10).map((x) => sanitizeTelemetryString(x, 80));
  }
  return clean;
}

export function detectEnvironment() {
  if (typeof window === 'undefined' || !window.location) return 'node';
  const host = String(window.location.hostname || '').toLowerCase();
  if (host === 'localhost' || host === '127.0.0.1' || host.endsWith('.local')) return 'development';
  if (host.includes('staging')) return 'staging';
  return 'production';
}

function isDoNotTrackEnabled() {
  if (typeof navigator === 'undefined') return false;
  return navigator.doNotTrack === '1' || (typeof window !== 'undefined' && window.doNotTrack === '1');
}

export class HungerTelemetry {
  constructor(options = {}) {
    this.endpoint = options.endpoint || '/api/telemetry/event';
    this.release = options.release || TELEMETRY_RELEASE;
    this.environment = options.environment || detectEnvironment();
    this.sessionId = randomHex(8);
    this.sessionStartMs = typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
    this.workspace = options.workspace || 'layout';
    this.enabled = options.enabled !== false && !isDoNotTrackEnabled();
    this.fetchImpl = options.fetchImpl || (typeof fetch === 'function' ? fetch.bind(globalThis) : null);

    this._queue = [];
    this._flushing = false;
    this._installed = false;
    this._metrics = {
      sessionId: this.sessionId,
      release: this.release,
      environment: this.environment,
      initialInteractiveMs: null,
      timeToFirstAnimationSec: null,
      fatalErrorCount: 0,
      errorCount: 0,
      crashFree: true,
      videoToGlbAttempts: 0,
      videoToGlbSuccesses: 0,
      eventsCount: 0,
      activeTemplate: null,
    };
  }

  installGlobalHandlers() {
    if (this._installed || typeof window === 'undefined') return;
    this._installed = true;

    window.addEventListener('error', (event) => {
      const err = event?.error || new Error(event?.message || 'Uncaught window error');
      this.captureException(err, {
        subsystem: 'window.onerror',
        fatal: true,
        extra: {
          filename: sanitizeTelemetryString(event?.filename || '', 180),
          lineno: Number(event?.lineno || 0),
          colno: Number(event?.colno || 0),
        },
      });
    });

    window.addEventListener('unhandledrejection', (event) => {
      const reason = event?.reason instanceof Error
        ? event.reason
        : new Error(sanitizeTelemetryString(event?.reason || 'Unhandled promise rejection', 300));
      this.captureException(reason, {
        subsystem: 'unhandledrejection',
        fatal: false,
      });
    });

    window.addEventListener('studio:staleBundle', (event) => {
      this.track('stale_bundle_detected', {
        url: sanitizeTelemetryString(event?.detail?.url || '', 180),
        status: Number(event?.detail?.status || 404),
      });
    });

    window.addEventListener('pagehide', () => {
      this.track('session_end', {
        crashFree: this._metrics.crashFree,
        durationSec: Math.round(this._elapsedMs() / 1000),
        errorCount: this._metrics.errorCount,
        videoToGlbAttempts: this._metrics.videoToGlbAttempts,
        videoToGlbSuccesses: this._metrics.videoToGlbSuccesses,
      });
      this.flush({ beacon: true });
    });
  }

  _elapsedMs() {
    const now = typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
    return Math.max(0, Math.round(now - this.sessionStartMs));
  }

  setWorkspace(workspace) {
    const next = String(workspace || 'layout').slice(0, 32);
    if (this.workspace !== next) {
      const prev = this.workspace;
      this.workspace = next;
      this.track('workspace_switch', { from: prev, to: next });
    }
  }

  markInteractive(meta = {}) {
    if (this._metrics.initialInteractiveMs !== null) return this._metrics.initialInteractiveMs;
    const ms = Number.isFinite(meta.interactiveMs) ? Math.round(meta.interactiveMs) : this._elapsedMs();
    this._metrics.initialInteractiveMs = ms;
    const conn = typeof navigator !== 'undefined' ? navigator.connection : null;
    this.track('session_interactive', {
      initialInteractiveMs: ms,
      workspace: meta.workspace || this.workspace,
      template: meta.template || null,
      deferredPanels: Boolean(meta.deferredPanels),
      effectiveType: conn?.effectiveType || 'unknown',
      deviceMemoryGB: typeof navigator !== 'undefined' && Number.isFinite(navigator.deviceMemory) ? navigator.deviceMemory : null,
    });
    return ms;
  }

  markFirstAnimation(meta = {}) {
    if (this._metrics.timeToFirstAnimationSec !== null) return this._metrics.timeToFirstAnimationSec;
    const sec = Number((this._elapsedMs() / 1000).toFixed(2));
    this._metrics.timeToFirstAnimationSec = sec;
    this.track('first_animation_achieved', {
      timeToFirstAnimationSec: sec,
      templateId: meta.templateId || this._metrics.activeTemplate || null,
      tracks: Number(meta.tracks || 0),
      durationSec: Number(meta.durationSec || 0),
    });
    return sec;
  }

  recordVideoToGlbResult({ ok, sizeKB = 0, tracks = 0, durationSec = 0, templateId = null, error = '' } = {}) {
    this._metrics.videoToGlbAttempts += 1;
    if (ok) this._metrics.videoToGlbSuccesses += 1;
    this.track('mocap_export_glb', {
      ok: Boolean(ok),
      sizeKB: Number(sizeKB || 0),
      tracks: Number(tracks || 0),
      durationSec: Number(durationSec || 0),
      templateId: templateId || this._metrics.activeTemplate || null,
      error: ok ? '' : sanitizeTelemetryString(error, 200),
    });
  }

  track(name, props = {}) {
    const cleanName = String(name || '').trim().slice(0, 64);
    if (!cleanName) return null;
    if (cleanName === 'template_selected' && props.templateId) {
      this._metrics.activeTemplate = String(props.templateId);
    }
    this._metrics.eventsCount += 1;
    const event = {
      kind: 'analytics',
      name: cleanName,
      ts: new Date().toISOString(),
      sessionId: this.sessionId,
      release: this.release,
      environment: this.environment,
      workspace: this.workspace,
      props: sanitizeExtra(props),
    };
    this._enqueue(event);
    return event;
  }

  captureException(error, options = {}) {
    this._metrics.errorCount += 1;
    if (options.fatal) {
      this._metrics.fatalErrorCount += 1;
      this._metrics.crashFree = false;
    }
    const sentryEvent = buildSentryEventPayload(error, {
      ...options,
      release: this.release,
      environment: this.environment,
      workspace: this.workspace,
    });
    const envelope = {
      kind: 'error',
      ts: new Date().toISOString(),
      sessionId: this.sessionId,
      release: this.release,
      environment: this.environment,
      workspace: this.workspace,
      sentry: sentryEvent,
    };
    this._enqueue(envelope);
    if (options.fatal) this.flush({ beacon: true });
    return envelope;
  }

  getSessionMetrics() {
    const attempts = this._metrics.videoToGlbAttempts;
    return {
      ...this._metrics,
      videoToGlbSuccessRate: attempts > 0 ? Number(((this._metrics.videoToGlbSuccesses / attempts) * 100).toFixed(1)) : null,
      elapsedSec: Number((this._elapsedMs() / 1000).toFixed(2)),
    };
  }

  _enqueue(item) {
    if (!this.enabled) return;
    if (this._queue.length >= MAX_QUEUED_EVENTS) this._queue.shift();
    this._queue.push(item);
    if (item.kind === 'error' || this._queue.length >= 4) {
      this.flush();
    } else if (!this._flushTimer && typeof setTimeout === 'function') {
      this._flushTimer = setTimeout(() => {
        this._flushTimer = null;
        this.flush();
      }, 3000);
    }
  }

  async flush({ beacon = false } = {}) {
    if (!this.enabled || !this._queue.length) return false;
    const batch = this._queue.splice(0, this._queue.length);
    const body = JSON.stringify({
      release: this.release,
      environment: this.environment,
      sessionId: this.sessionId,
      events: batch,
    });

    if (beacon && typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
      try {
        const blob = new Blob([body], { type: 'application/json' });
        if (navigator.sendBeacon(this.endpoint, blob)) return true;
      } catch (_) {}
    }

    if (!this.fetchImpl || typeof window === 'undefined') return false;
    if (this._flushing && !beacon) return false;
    this._flushing = true;
    try {
      const res = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        keepalive: true,
      });
      return Boolean(res && res.ok);
    } catch (_) {
      return false;
    } finally {
      this._flushing = false;
    }
  }
}

export const telemetry = new HungerTelemetry();
