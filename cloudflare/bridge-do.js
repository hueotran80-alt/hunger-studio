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
    return new Response('Not Found', { status: 404 });
  }
}

export const __bridgeDoInternals = {
  SAFE_SESSION_RE,
  sha256Hex,
  timingSafeEqual,
};
