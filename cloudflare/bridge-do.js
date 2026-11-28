/**
 * Hunger 3D Studio — Cloudflare Durable Object Bridge Hub (`StudioBridgeHub`)
 *
 * Sharded 1 DO per Bridge Session (`env.BRIDGE_HUB.getByName(sessionId)`).
 * Bridges live browser WebSocket tabs (`wss://.../api/bridge/ws`) with
 * CLI (`studio-cli.py`), local MCP (`studio_mcp.py`), and remote HTTP MCP (`/mcp`).
 *
 * Security:
 *  - Every session is bound to a secret token whose SHA-256 hash is persisted in SQLite.
 *  - Optional `STUDIO_BRIDGE_TOKEN` Worker secret also authorizes the owner's session.
 *  - Strangers cannot send commands to or hijack another user's session.
 */

const SAFE_SESSION_RE = /^[A-Za-z0-9_-]{4,64}$/;
const MAX_PENDING_COMMANDS = 32;
const TELEMETRY_MAX_ROWS = 20000;
const TELEMETRY_RETENTION_MS = 30 * 24 * 3600 * 1000;
const SYNTHETIC_SESSION_RE = /^(?:sentry-smoke|smoke-|ci-smoke|test-smoke)/i;

function percentile(sortedNums, p) {
  if (!sortedNums.length) return null;
  if (sortedNums.length === 1) return Number(sortedNums[0].toFixed(2));
  const idx = Math.min(sortedNums.length - 1, Math.max(0, Math.ceil((p / 100) * sortedNums.length) - 1));
  return Number(sortedNums[idx].toFixed(2));
}

function median(sortedNums) {
  if (!sortedNums.length) return null;
  const mid = Math.floor(sortedNums.length / 2);
  const val = sortedNums.length % 2 ? sortedNums[mid] : (sortedNums[mid - 1] + sortedNums[mid]) / 2;
  return Number(val.toFixed(2));
}

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(text || '')));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

function timingSafeEqual(a, b) {
  const ba = new TextEncoder().encode(String(a || ''));
  const bb = new TextEncoder().encode(String(b || ''));
  const len = Math.max(ba.length, bb.length);
  let diff = ba.length ^ bb.length;
  for (let i = 0; i < len; i += 1) diff |= (ba[i] || 0) ^ (bb[i] || 0);
  return diff === 0;
}

export class StudioBridgeHub {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.sockets = new Set();
    this.pending = new Map(); // id -> { resolve, reject, timer }
    this.nextId = 1;

    ctx.blockConcurrencyWhile(async () => {
      if (this.ctx?.storage?.sql) {
        this.ctx.storage.sql.exec(`
          CREATE TABLE IF NOT EXISTS bridge_meta (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
          )
        `);
        this.ctx.storage.sql.exec(`
          CREATE TABLE IF NOT EXISTS telemetry_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            ts TEXT NOT NULL,
            ts_ms INTEGER NOT NULL,
            kind TEXT NOT NULL,
            name TEXT NOT NULL,
            session_id TEXT NOT NULL,
            release TEXT NOT NULL DEFAULT '',
            environment TEXT NOT NULL DEFAULT '',
            workspace TEXT NOT NULL DEFAULT '',
            fatal INTEGER NOT NULL DEFAULT 0,
            is_synthetic INTEGER NOT NULL DEFAULT 0,
            interactive_ms REAL,
            ttfa_sec REAL,
            v2g_ok INTEGER,
            template_id TEXT NOT NULL DEFAULT '',
            effective_type TEXT NOT NULL DEFAULT '',
            error_message TEXT NOT NULL DEFAULT '',
            props_json TEXT NOT NULL DEFAULT '{}'
          )
        `);
        this.ctx.storage.sql.exec('CREATE INDEX IF NOT EXISTS idx_telemetry_ts_ms ON telemetry_events(ts_ms DESC)');
        this.ctx.storage.sql.exec('CREATE INDEX IF NOT EXISTS idx_telemetry_session ON telemetry_events(session_id, name)');
      }
    });
  }

  _getMeta(key) {
    if (!this.ctx?.storage?.sql) return null;
    const rows = this.ctx.storage.sql.exec('SELECT value FROM bridge_meta WHERE key = ?', key).toArray();
    return rows.length ? String(rows[0].value) : null;
  }

  _setMeta(key, value) {
    if (!this.ctx?.storage?.sql) return;
    this.ctx.storage.sql.exec(
      'INSERT INTO bridge_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      key,
      String(value),
    );
  }

  async _authorize(token, { allowRegister = false, sessionId = 'default' } = {}) {
    const clean = String(token || '').trim();
    if (!clean || clean.length < 12) return false;

    const ownerSecret = String(this.env?.STUDIO_BRIDGE_TOKEN || '').trim();
    if (ownerSecret && timingSafeEqual(clean, ownerSecret)) {
      return true;
    }

    // Reserve the 'default' session exclusively for STUDIO_BRIDGE_TOKEN when configured
    if (sessionId === 'default' && ownerSecret) {
      return false;
    }

    const hash = await sha256Hex(clean);
    const stored = this._getMeta('token_hash');
    if (!stored) {
      if (!allowRegister) return false;
      this._setMeta('token_hash', hash);
      return true;
    }
    return timingSafeEqual(hash, stored);
  }

  _pickBrowserSocket() {
    let chosen = null;
    for (const ws of this.sockets) {
      if (ws.readyState === 1) {
        chosen = ws;
      } else {
        this.sockets.delete(ws);
      }
    }
    return chosen;
  }

  _handleBrowserMessage(ws, raw) {
    let msg;
    try {
      msg = JSON.parse(typeof raw === 'string' ? raw : new TextDecoder().decode(raw));
    } catch {
      return;
    }
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'ping') {
      try { ws.send(JSON.stringify({ type: 'pong', ts: Date.now() })); } catch {}
      return;
    }
    if (msg.type === 'client_register') {
      try { ws.send(JSON.stringify({ type: 'registered', role: 'browser' })); } catch {}
      return;
    }
    const id = msg.id;
    if (id !== undefined && id !== null && this.pending.has(String(id))) {
      const entry = this.pending.get(String(id));
      this.pending.delete(String(id));
      clearTimeout(entry.timer);
      entry.resolve(msg);
    }
  }

  async _handleWsUpgrade(request, url) {
    const upgrade = (request.headers.get('upgrade') || '').toLowerCase();
    if (upgrade !== 'websocket') {
      return new Response('Expected WebSocket upgrade', { status: 426 });
    }
    const sessionId = (url.searchParams.get('session') || 'default').trim();
    if (!SAFE_SESSION_RE.test(sessionId)) {
      return new Response('Invalid session ID', { status: 400 });
    }
    const token = (url.searchParams.get('token') || request.headers.get('x-studio-token') || '').trim();
    const ok = await this._authorize(token, { allowRegister: true, sessionId });
    if (!ok) {
      return new Response('Unauthorized bridge token', { status: 401 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();
    this.sockets.add(server);

    server.addEventListener('message', (event) => {
      this._handleBrowserMessage(server, event.data);
    });
    const cleanup = () => {
      this.sockets.delete(server);
      if (this.sockets.size === 0) {
        for (const [id, entry] of this.pending.entries()) {
          clearTimeout(entry.timer);
          entry.resolve({
            id,
            success: false,
            ok: false,
            error: 'Browser disconnected while executing command.',
          });
        }
        this.pending.clear();
      }
    };
    server.addEventListener('close', cleanup);
    server.addEventListener('error', cleanup);

    return new Response(null, { status: 101, webSocket: client });
  }

  async _handleCommand(request, url) {
    const sessionId = (url.searchParams.get('session') || request.headers.get('x-studio-session') || 'default').trim();
    const authHeader = request.headers.get('authorization') || '';
    const bearer = authHeader.toLowerCase().startsWith('bearer ') ? authHeader.slice(7).trim() : '';
    const token = (request.headers.get('x-studio-token') || bearer || url.searchParams.get('token') || '').trim();
    const ok = await this._authorize(token, { allowRegister: false, sessionId });
    if (!ok) {
      return Response.json(
        {
          success: false,
          ok: false,
          error: {
            code: 'E_UNAUTHORIZED',
            message: 'Thiếu hoặc sai STUDIO_TOKEN cho phiên CLI/MCP.',
            hint: 'Mở Hunger trên trình duyệt, bấm vào nhãn CLI/MCP ở góc trên để lấy token/session hoặc truyền --token.',
          },
        },
        { status: 401, headers: { 'Cache-Control': 'no-store' } },
      );
    }

    const ws = this._pickBrowserSocket();
    if (!ws) {
      return Response.json(
        {
          success: false,
          ok: false,
          error: {
            code: 'E_NO_BROWSER',
            message: `Chưa có trình duyệt Hunger nào kết nối vào session "${sessionId}".`,
            hint: 'Hãy mở Hunger trên trình duyệt (kèm đúng ?token=... hoặc sao chép session/token từ nhãn CLI/MCP).',
          },
        },
        { status: 503, headers: { 'Cache-Control': 'no-store' } },
      );
    }

    if (this.pending.size >= MAX_PENDING_COMMANDS) {
      return Response.json(
        { success: false, ok: false, error: { code: 'E_BUSY', message: 'Bridge queue full, please retry.' } },
        { status: 429, headers: { 'Cache-Control': 'no-store' } },
      );
    }

    let payload;
    try {
      payload = await request.json();
    } catch {
      return Response.json({ success: false, ok: false, error: 'Invalid JSON payload' }, { status: 400 });
    }

    const id = String(this.nextId++);
    const timeoutMs = Math.max(2000, Math.min(110000, Number(payload?.timeoutMs) || 90000));
    const message = { ...payload, id };
    delete message.timeoutMs;

    const result = await new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({
          id,
          success: false,
          ok: false,
          error: `Command timed out after ${Math.round(timeoutMs / 1000)}s.`,
        });
      }, timeoutMs);
      this.pending.set(id, { resolve, timer });
      try {
        ws.send(JSON.stringify(message));
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        this.sockets.delete(ws);
        resolve({ id, success: false, ok: false, error: `WebSocket send failed: ${err?.message || err}` });
      }
    });

    const out = { ...result };
    delete out.id;
    const isOk = out.success === true || out.ok === true;
    return Response.json(out, {
      status: isOk ? 200 : (out.statusCode || 200),
      headers: { 'Cache-Control': 'no-store' },
    });
  }

  async _handleTelemetryIngest(request) {
    if (!this.ctx?.storage?.sql) {
      return Response.json({ ok: false, persisted: 0 }, { status: 501, headers: { 'Cache-Control': 'no-store' } });
    }
    let payload;
    try {
      payload = await request.json();
    } catch {
      return Response.json({ ok: false, error: 'Invalid JSON' }, { status: 400 });
    }
    const events = Array.isArray(payload?.events) ? payload.events.slice(0, 25) : [];
    const sql = this.ctx.storage.sql;
    let persisted = 0;
    const nowMs = Date.now();
    for (const ev of events) {
      if (!ev || typeof ev !== 'object') continue;
      const ts = String(ev.ts || new Date(nowMs).toISOString()).slice(0, 40);
      const parsedMs = Date.parse(ts);
      const tsMs = Number.isFinite(parsedMs) ? parsedMs : nowMs;
      const kind = ev.kind === 'error' ? 'error' : 'analytics';
      const name = String(ev.name || (kind === 'error' ? 'error_captured' : 'unknown')).slice(0, 64);
      const sessionId = String(ev.sessionId || '').slice(0, 64);
      const release = String(ev.release || '').slice(0, 64);
      const environment = String(ev.environment || '').slice(0, 32);
      const workspace = String(ev.workspace || 'unknown').slice(0, 32);
      const fatal = ev.fatal ? 1 : 0;
      const props = ev.props && typeof ev.props === 'object' ? ev.props : {};
      const isSynthetic = (SYNTHETIC_SESSION_RE.test(sessionId) || props.synthetic === true) ? 1 : 0;
      const interactiveMs = name === 'session_interactive' && Number.isFinite(Number(props.initialInteractiveMs))
        && Number(props.initialInteractiveMs) >= 0 && Number(props.initialInteractiveMs) < 120000
        ? Number(props.initialInteractiveMs) : null;
      const ttfaSec = name === 'first_animation_achieved' && Number.isFinite(Number(props.timeToFirstAnimationSec))
        && Number(props.timeToFirstAnimationSec) >= 0 && Number(props.timeToFirstAnimationSec) < 86400
        ? Number(props.timeToFirstAnimationSec) : null;
      const v2gOk = name === 'mocap_export_glb' ? (props.ok === true ? 1 : 0) : null;
      const templateId = String(props.templateId || props.template || '').slice(0, 48);
      const effectiveType = String(props.effectiveType || '').slice(0, 24);
      const errorMessage = String(ev.errorMessage || '').slice(0, 240);
      const propsJson = JSON.stringify(props).slice(0, 2000);
      sql.exec(
        `INSERT INTO telemetry_events
          (ts, ts_ms, kind, name, session_id, release, environment, workspace, fatal, is_synthetic,
           interactive_ms, ttfa_sec, v2g_ok, template_id, effective_type, error_message, props_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ts, tsMs, kind, name, sessionId, release, environment, workspace, fatal, isSynthetic,
        interactiveMs, ttfaSec, v2gOk, templateId, effectiveType, errorMessage, propsJson,
      );
      persisted += 1;
    }

    // Prune expired or excess rows to keep SQLite bounded
    const cutoff = nowMs - TELEMETRY_RETENTION_MS;
    sql.exec('DELETE FROM telemetry_events WHERE ts_ms < ?', cutoff);
    const countRows = sql.exec('SELECT COUNT(*) AS cnt FROM telemetry_events').toArray();
    const total = Number(countRows[0]?.cnt || 0);
    if (total > TELEMETRY_MAX_ROWS) {
      const excess = total - TELEMETRY_MAX_ROWS;
      sql.exec(
        'DELETE FROM telemetry_events WHERE id IN (SELECT id FROM telemetry_events ORDER BY id ASC LIMIT ?)',
        excess,
      );
    }

    return Response.json({ ok: true, persisted }, { headers: { 'Cache-Control': 'no-store' } });
  }

  async _handleTelemetrySummary(url) {
    if (!this.ctx?.storage?.sql) {
      return Response.json({ ok: false, error: 'SQLite unavailable' }, { status: 501 });
    }
    const sql = this.ctx.storage.sql;
    const rawHours = Number.parseInt(url.searchParams.get('hours') || '168', 10);
    const windowHours = Number.isFinite(rawHours) ? Math.max(1, Math.min(720, rawHours)) : 168;
    const releaseFilter = String(url.searchParams.get('release') || '').trim().slice(0, 64);
    const includeSmoke = url.searchParams.get('includeSmoke') === '1' || url.searchParams.get('includeSmoke') === 'true';
    const sinceMs = Date.now() - windowHours * 3600 * 1000;

    const clauses = ['ts_ms >= ?'];
    const params = [sinceMs];
    if (!includeSmoke) {
      clauses.push('is_synthetic = 0');
    }
    if (releaseFilter) {
      clauses.push('release = ?');
      params.push(releaseFilter);
    }
    const whereSql = clauses.join(' AND ');
    const rows = sql.exec(
      `SELECT id, ts, kind, name, session_id, release, environment, workspace, fatal, is_synthetic,
              interactive_ms, ttfa_sec, v2g_ok, template_id, effective_type, error_message, props_json
       FROM telemetry_events
       WHERE ${whereSql}
       ORDER BY id DESC
       LIMIT 5000`,
      ...params,
    ).toArray();

    const sessionIds = new Set();
    const motionSessionIds = new Set();
    const crashedSessionIds = new Set();
    let fatalErrors = 0;
    let errors = 0;
    let videoToGlbAttempts = 0;
    let videoToGlbSuccesses = 0;
    const interactiveSamples = [];
    const ttfaSamples = [];
    const byNetwork = {};
    const funnel = {
      landingVisits: 0,
      motionSessions: 0,
      templateSelections: 0,
      byTemplate: { unity_humanoid: 0, vrm_avatar: 0, tiktok_dance: 0 },
      firstAnimations: 0,
      glbExportsOk: 0,
      glbExportsFailed: 0,
      authSignIns: 0,
      oauthStarts: 0,
      passwordResets: 0,
      checkoutsStarted: 0,
      paymentsCompleted: 0,
    };

    for (const r of rows) {
      const sid = String(r.session_id || '');
      let props = {};
      try { props = r.props_json ? JSON.parse(r.props_json) : {}; } catch { props = {}; }
      if (r.kind === 'error') {
        errors += 1;
        if (r.fatal) {
          fatalErrors += 1;
          if (sid) crashedSessionIds.add(sid);
        }
        continue;
      }
      if (r.name === 'session_interactive') {
        if (sid) sessionIds.add(sid);
        if (r.workspace === 'motion' && sid) motionSessionIds.add(sid);
        if (r.interactive_ms !== null && Number.isFinite(Number(r.interactive_ms))) {
          const ms = Number(r.interactive_ms);
          interactiveSamples.push(ms);
          const netKey = String(r.effective_type || 'unknown') || 'unknown';
          if (!byNetwork[netKey]) byNetwork[netKey] = [];
          byNetwork[netKey].push(ms);
        }
      } else if (r.name === 'session_end') {
        if (sid) sessionIds.add(sid);
        if (props.crashFree === false && sid) crashedSessionIds.add(sid);
      } else if (r.name === 'landing_view' || r.name === 'motion_landing_view') {
        funnel.landingVisits += 1;
      } else if (r.name === 'template_selected') {
        funnel.templateSelections += 1;
        const tpl = String(r.template_id || '');
        if (tpl in funnel.byTemplate) funnel.byTemplate[tpl] += 1;
      } else if (r.name === 'first_animation_achieved') {
        funnel.firstAnimations += 1;
        if (r.ttfa_sec !== null && Number.isFinite(Number(r.ttfa_sec))) {
          ttfaSamples.push(Number(r.ttfa_sec));
        }
      } else if (r.name === 'mocap_export_glb') {
        videoToGlbAttempts += 1;
        if (r.v2g_ok === 1) {
          videoToGlbSuccesses += 1;
          funnel.glbExportsOk += 1;
        } else {
          funnel.glbExportsFailed += 1;
        }
      } else if (r.name === 'auth_signed_in') {
        funnel.authSignIns += 1;
      } else if (r.name === 'auth_oauth_started') {
        funnel.oauthStarts += 1;
      } else if (r.name === 'auth_password_reset_requested') {
        funnel.passwordResets += 1;
      } else if (r.name === 'checkout_started') {
        funnel.checkoutsStarted += 1;
      } else if (r.name === 'payment_completed') {
        funnel.paymentsCompleted += 1;
      }
    }

    funnel.motionSessions = motionSessionIds.size;
    interactiveSamples.sort((a, b) => a - b);
    ttfaSamples.sort((a, b) => a - b);

    const sessions = sessionIds.size;
    const crashedSessions = [...crashedSessionIds].filter((sid) => sessionIds.has(sid)).length || crashedSessionIds.size;
    const crashFreePct = sessions > 0
      ? Number((Math.max(0, sessions - crashedSessions) / sessions * 100).toFixed(2))
      : (crashedSessions > 0 ? 0 : 100);
    const videoToGlbSuccessPct = videoToGlbAttempts > 0
      ? Number(((videoToGlbSuccesses / videoToGlbAttempts) * 100).toFixed(2))
      : null;
    const medianInteractiveMs = median(interactiveSamples);
    const p95InteractiveMs = percentile(interactiveSamples, 95);
    const medianTimeToFirstAnimationSec = median(ttfaSamples);
    const p95TimeToFirstAnimationSec = percentile(ttfaSamples, 95);

    const networkBreakdown = {};
    for (const [netType, arr] of Object.entries(byNetwork)) {
      arr.sort((a, b) => a - b);
      networkBreakdown[netType] = {
        samples: arr.length,
        medianMs: median(arr),
        p95Ms: percentile(arr, 95),
      };
    }

    const recentEvents = rows.slice(0, 25).reverse().map((r) => {
      let props;
      try { props = r.props_json ? JSON.parse(r.props_json) : undefined; } catch { props = undefined; }
      return {
        kind: r.kind,
        name: r.name,
        ts: r.ts,
        sessionId: r.session_id,
        release: r.release,
        environment: r.environment,
        workspace: r.workspace,
        fatal: r.kind === 'error' ? Boolean(r.fatal) : undefined,
        errorMessage: r.error_message || undefined,
        props,
      };
    });

    return Response.json({
      ok: true,
      storage: 'durable-object-sqlite',
      windowHours,
      releaseFilter: releaseFilter || null,
      includeSmoke,
      kpi: {
        sessions,
        crashedSessions,
        crashFreePct,
        fatalErrors,
        errors,
        videoToGlbAttempts,
        videoToGlbSuccesses,
        videoToGlbSuccessPct,
        medianInteractiveMs,
        p95InteractiveMs,
        medianTimeToFirstAnimationSec,
        p95TimeToFirstAnimationSec,
      },
      targets: {
        crashFreeTargetPct: 99,
        crashFreePass: sessions > 0 ? crashFreePct >= 99 : null,
        videoToGlbTargetPct: 90,
        videoToGlbPass: videoToGlbSuccessPct !== null ? videoToGlbSuccessPct >= 90 : null,
        ttfaTargetSec: 600,
        ttfaPass: medianTimeToFirstAnimationSec !== null ? medianTimeToFirstAnimationSec <= 600 : null,
        interactiveTargetMs: 5000,
        interactivePass: medianInteractiveMs !== null ? medianInteractiveMs <= 5000 : null,
      },
      funnel,
      networkBreakdown,
      recentEvents,
    }, { headers: { 'Cache-Control': 'no-store' } });
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/ws') {
      return this._handleWsUpgrade(request, url);
    }
    if (url.pathname === '/status') {
      const active = this._pickBrowserSocket() ? this.sockets.size : 0;
      return Response.json({ connectedBrowsers: active }, { headers: { 'Cache-Control': 'no-store' } });
    }
    if (url.pathname === '/command' && request.method === 'POST') {
      return this._handleCommand(request, url);
    }
    if (url.pathname === '/telemetry/ingest' && request.method === 'POST') {
      return this._handleTelemetryIngest(request);
    }
    if (url.pathname === '/telemetry/summary' && request.method === 'GET') {
      return this._handleTelemetrySummary(url);
    }
    return new Response('Not Found', { status: 404 });
  }
}

export const __bridgeDoInternals = {
  SAFE_SESSION_RE,
  sha256Hex,
  timingSafeEqual,
};
