/**
 * Web Blender Studio - CLI & MCP Bridge Controller
 * File: js/core/studio-bridge.js
 * 
 * Connects the browser 3D studio directly to Python server.py via WebSocket (port 8082).
 * Enables the CLI (studio-cli.py) and MCP Server (studio_mcp.py) to:
 * - Execute Three.js / studio.* DSL code in real time
 * - Trigger AI Copilot 3D generation
 * - Query scene hierarchy, vertex/polygon counts, and active selection
 * - Capture high-res viewport screenshots
 * - Export models (OBJ, STL, JSON)
 */

export function safeJsonSerialize(value, maxDepth = 6) {
  const seen = new WeakSet();
  const sanitize = (val, depth) => {
    if (val === null || val === undefined) return val;
    const t = typeof val;
    if (t === 'number') return Number.isFinite(val) ? val : null;
    if (t === 'boolean' || t === 'string') return val;
    if (t === 'bigint') return val.toString();
    if (t === 'function') return `[Function ${val.name || 'anonymous'}]`;
    if (t !== 'object') return String(val);

    if (seen.has(val)) return '[Circular]';
    if (depth >= maxDepth) {
      if (val.isObject3D) return { type: val.type || 'Object3D', name: val.name || '', uuid: val.uuid };
      return Array.isArray(val) ? `[Array(${val.length})]` : `[Object ${val.constructor?.name || ''}]`;
    }

    seen.add(val);
    if (val.isObject3D) {
      const out = {
        type: val.type || 'Object3D',
        name: val.name || '',
        uuid: val.uuid,
        position: val.position ? [val.position.x, val.position.y, val.position.z] : undefined,
        rotation: val.rotation ? [val.rotation.x, val.rotation.y, val.rotation.z] : undefined,
        scale: val.scale ? [val.scale.x, val.scale.y, val.scale.z] : undefined,
      };
      if (val.isMesh && val.geometry?.attributes?.position) {
        out.vertices = val.geometry.attributes.position.count;
      }
      if (Array.isArray(val.children) && val.children.length) {
        out.childrenCount = val.children.length;
      }
      return out;
    }
    if (ArrayBuffer.isView(val)) {
      return `[${val.constructor?.name || 'TypedArray'}(${val.length})]`;
    }
    if (Array.isArray(val)) {
      const cap = Math.min(val.length, 200);
      const arr = [];
      for (let i = 0; i < cap; i += 1) arr.push(sanitize(val[i], depth + 1));
      if (val.length > cap) arr.push(`…(+${val.length - cap} more)`);
      return arr;
    }
    if (val instanceof Map) {
      return sanitize(Object.fromEntries(val.entries()), depth + 1);
    }
    if (val instanceof Set) {
      return sanitize(Array.from(val.values()), depth + 1);
    }
    const obj = {};
    const keys = Object.keys(val);
    const cap = Math.min(keys.length, 150);
    for (let i = 0; i < cap; i += 1) {
      const k = keys[i];
      obj[k] = sanitize(val[k], depth + 1);
    }
    return obj;
  };
  return JSON.stringify(sanitize(value, 0));
}

export class StudioBridge {
  constructor(options = {}) {
    this._explicitPort = Boolean(options.port);
    this.port = options.port || 8082;
    this._portResolved = this._explicitPort;
    this.wsPath = null;
    this.sessionId = 'default';
    this.bridgeToken = '';
    this.ws = null;
    this.isConnected = false;
    this.reconnectTimer = null;
    this.pingTimer = null;
    this.statusEl = null;
    this._popoverEl = null;

    this._initUI();
    this.connect();
  }

  _initUI() {
    // Add bridge indicator to header
    const tryMountBadge = () => {
      const header = document.querySelector('.header-left') || document.querySelector('.blender-header');
      if (header && !document.getElementById('mcp-bridge-badge')) {
        this.statusEl = document.createElement('div');
        this.statusEl.id = 'mcp-bridge-badge';
        this.statusEl.className = 'bridge-badge disconnected';
        this.statusEl.innerHTML = `<span class="badge-dot"></span><span class="badge-text">CLI/MCP: Offline</span>`;
        this.statusEl.title = 'Click to view Hunger CLI & MCP connection details';
        this.statusEl.addEventListener('click', (e) => {
          e.stopPropagation();
          this._toggleConnectionPopover();
        });
        header.appendChild(this.statusEl);

        const style = document.createElement('style');
        style.textContent = `
          .bridge-badge {
            display: inline-flex;
            align-items: center;
            gap: 6px;
            padding: 2px 8px;
            border-radius: 12px;
            font-size: 11px;
            font-weight: 500;
            margin-left: 10px;
            background: #2a2a2a;
            border: 1px solid #3d3d3d;
            color: #888;
            cursor: pointer;
            user-select: none;
            transition: all 0.25s ease;
          }
          .bridge-badge .badge-dot {
            width: 7px;
            height: 7px;
            border-radius: 50%;
            background: #e74c3c;
          }
          .bridge-badge.connected {
            background: rgba(46, 204, 113, 0.12);
            border-color: rgba(46, 204, 113, 0.4);
            color: #2ecc71;
          }
          .bridge-badge.connected .badge-dot {
            background: #2ecc71;
            box-shadow: 0 0 6px #2ecc71;
          }
          .bridge-popover {
            position: fixed;
            top: 38px;
            left: 180px;
            z-index: 100001;
            width: 440px;
            max-width: calc(100vw - 24px);
            background: #1e2024;
            border: 1px solid #3c4048;
            border-radius: 8px;
            box-shadow: 0 12px 32px rgba(0, 0, 0, 0.55);
            padding: 12px 14px;
            color: #e4e7ec;
            font-family: system-ui, -apple-system, sans-serif;
            font-size: 12px;
          }
          .bridge-popover h4 { margin: 0 0 8px; font-size: 13px; color: #fff; display: flex; justify-content: space-between; align-items: center; }
          .bridge-popover pre {
            margin: 4px 0 8px;
            padding: 8px;
            background: #121417;
            border: 1px solid #2f333a;
            border-radius: 6px;
            overflow-x: auto;
            font-size: 11px;
            color: #9cdcfe;
            user-select: all;
          }
          .bridge-popover .bp-row { display: flex; gap: 6px; margin-bottom: 8px; flex-wrap: wrap; }
          .bridge-popover button {
            background: #2d323b;
            color: #f2f4f8;
            border: 1px solid #454c59;
            border-radius: 5px;
            padding: 4px 9px;
            font-size: 11px;
            cursor: pointer;
          }
          .bridge-popover button:hover { background: #3b4250; }
        `;
        document.head.appendChild(style);
      }
    };

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', tryMountBadge);
    } else {
      tryMountBadge();
    }
  }

  _toggleConnectionPopover() {
    if (this._popoverEl) {
      this._popoverEl.remove();
      this._popoverEl = null;
      return;
    }
    const origin = window.location.origin;
    const sid = this.sessionId || 'default';
    const tok = this.bridgeToken || this._studioToken();
    const cliCmd = tok
      ? `python studio-cli.py --server ${origin} --session ${sid} --token ${tok} scene`
      : `python studio-cli.py --server ${origin} scene`;
    const mcpCfg = JSON.stringify({
      mcpServers: {
        hunger: {
          url: `${origin}/mcp?session=${encodeURIComponent(sid)}`,
          headers: tok ? { Authorization: `Bearer ${tok}` } : {},
        },
      },
    }, null, 2);

    const el = document.createElement('div');
    el.className = 'bridge-popover';
    const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    el.innerHTML = `
      <h4>
        <span>Hunger CLI &amp; MCP Bridge (${this.isConnected ? 'Online' : 'Offline'})</span>
        <button type="button" data-bp-close>✕</button>
      </h4>
      <div style="color:#a0a8b8;margin-bottom:8px;">
        Session: <code style="color:#fff">${esc(sid)}</code> · Endpoint: <code style="color:#fff">${esc(origin)}/mcp</code>
      </div>
      <div style="font-weight:600;margin-bottom:2px;">CLI Command</div>
      <pre>${esc(cliCmd)}</pre>
      <div class="bp-row">
        <button type="button" data-bp-copy="cli">Copy CLI</button>
        <button type="button" data-bp-copy="mcp">Copy Remote MCP JSON</button>
      </div>
      <div style="font-weight:600;margin-bottom:2px;">Remote MCP Config (Claude / Cursor / Antigravity)</div>
      <pre>${esc(mcpCfg)}</pre>
    `;
    el.querySelector('[data-bp-close]')?.addEventListener('click', () => this._toggleConnectionPopover());
    el.querySelector('[data-bp-copy="cli"]')?.addEventListener('click', async (ev) => {
      try { await navigator.clipboard.writeText(cliCmd); ev.target.textContent = 'Copied CLI ✓'; } catch {}
    });
    el.querySelector('[data-bp-copy="mcp"]')?.addEventListener('click', async (ev) => {
      try { await navigator.clipboard.writeText(mcpCfg); ev.target.textContent = 'Copied MCP ✓'; } catch {}
    });
    document.body.appendChild(el);
    this._popoverEl = el;
    const onDocClick = (ev) => {
      if (this._popoverEl && !this._popoverEl.contains(ev.target) && ev.target !== this.statusEl && !this.statusEl?.contains(ev.target)) {
        this._popoverEl.remove();
        this._popoverEl = null;
        document.removeEventListener('click', onDocClick);
      }
    };
    setTimeout(() => document.addEventListener('click', onDocClick), 0);
  }

  _updateBadge(connected) {
    this.isConnected = connected;
    if (this.statusEl) {
      this.statusEl.className = `bridge-badge ${connected ? 'connected' : 'disconnected'}`;
      const textEl = this.statusEl.querySelector('.badge-text');
      if (textEl) {
        textEl.textContent = connected ? 'CLI/MCP: Online' : 'CLI/MCP: Offline';
      }
    }
  }

  _ensureEdgeCredentials() {
    try {
      const qs = new URLSearchParams(window.location.search);
      const qSession = (qs.get('session') || qs.get('bridge') || '').trim();
      const qToken = this._studioToken();
      if (qToken) {
        this.bridgeToken = qToken;
        this.sessionId = /^[A-Za-z0-9_-]{4,64}$/.test(qSession) ? qSession : (sessionStorage.getItem('hunger_bridge_session') || 'default');
        sessionStorage.setItem('hunger_bridge_session', this.sessionId);
        return;
      }
      let sid = sessionStorage.getItem('hunger_bridge_session') || '';
      let tok = sessionStorage.getItem('hunger_bridge_token') || '';
      if (!/^[A-Za-z0-9_-]{4,64}$/.test(sid)) {
        const b = new Uint8Array(6);
        crypto.getRandomValues(b);
        sid = 'hg_' + Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
        sessionStorage.setItem('hunger_bridge_session', sid);
      }
      if (!tok || tok.length < 16) {
        const b = new Uint8Array(24);
        crypto.getRandomValues(b);
        tok = 'hgt_' + Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
        sessionStorage.setItem('hunger_bridge_token', tok);
      }
      this.sessionId = sid;
      this.bridgeToken = tok;
    } catch {
      this.sessionId = 'default';
      this.bridgeToken = this._studioToken();
    }
  }

  async connect() {
    if (!this._portResolved && typeof fetch === 'function') {
      try {
        const token = this._studioToken();
        const res = await fetch('/api/status', {
          headers: token ? { 'X-Studio-Token': token } : {},
        });
        if (res.ok) {
          const st = await res.json();
          if (typeof st?.wsPath === 'string' && st.wsPath.startsWith('/')) {
            this.wsPath = st.wsPath;
          } else if (Number.isInteger(st?.wsPort) && st.wsPort > 0) {
            this.port = st.wsPort;
          }
        }
      } catch (_) {
        // Static hosting without backend falls back cleanly
      } finally {
        this._portResolved = true;
      }
    }

    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    if (this.ws) {
      try { this.ws.close(); } catch (_) {}
    }

    let wsUrl;
    if (this.wsPath) {
      this._ensureEdgeCredentials();
      const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const qs = new URLSearchParams({ session: this.sessionId });
      if (this.bridgeToken) qs.set('token', this.bridgeToken);
      wsUrl = `${proto}//${window.location.host}${this.wsPath}?${qs.toString()}`;
    } else {
      const host = (window.location.hostname === 'localhost' || !window.location.hostname) ? '127.0.0.1' : window.location.hostname;
      const token = this._studioToken();
      wsUrl = `ws://${host}:${this.port}${token ? `?token=${encodeURIComponent(token)}` : ''}`;
    }

    try {
      this.ws = new WebSocket(wsUrl);

      this.ws.onopen = () => {
        console.log(`[StudioBridge] Connected to CLI/MCP WebSocket (${this.wsPath ? `session=${this.sessionId}` : wsUrl})`);
        this._updateBadge(true);
        // Identify browser client
        this.ws.send(JSON.stringify({ type: 'client_register', role: 'browser', client: 'hunger-studio', session: this.sessionId }));
        if (this.wsPath) {
          this.pingTimer = setInterval(() => {
            if (this.ws && this.ws.readyState === WebSocket.OPEN) {
              try { this.ws.send(JSON.stringify({ type: 'ping' })); } catch (_) {}
            }
          }, 25000);
        }
      };

      this.ws.onmessage = async (event) => {
        let reqId = null;
        try {
          const req = JSON.parse(event.data);
          if (req?.type === 'pong' || req?.type === 'registered') return;
          reqId = req?.id ?? null;
          const response = await this.handleRequest(req);
          if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(safeJsonSerialize({ id: reqId, ...response }));
          }
        } catch (err) {
          console.error('[StudioBridge] Error processing message:', err);
          if (reqId !== null && this.ws && this.ws.readyState === WebSocket.OPEN) {
            try {
              this.ws.send(safeJsonSerialize({ id: reqId, success: false, ok: false, error: err?.message || 'Bridge serialization error' }));
            } catch (_) {}
          }
        }
      };

      this.ws.onclose = () => {
        if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; }
        this._updateBadge(false);
        this._scheduleReconnect();
      };

      this.ws.onerror = () => {
        this._updateBadge(false);
      };
    } catch (e) {
      this._updateBadge(false);
      this._scheduleReconnect();
    }
  }

  _studioToken() {
    try {
      const fromQuery = new URLSearchParams(window.location.search).get('token');
      if (fromQuery) {
        try { sessionStorage.setItem('studio_token', fromQuery); } catch (_) {}
        return fromQuery;
      }
      const stored = sessionStorage.getItem('studio_token');
      if (stored) return stored;
      const match = document.cookie.match(/(?:^|;\s*)studio_token=([^;]+)/);
      return match ? decodeURIComponent(match[1]) : '';
    } catch (_) {
      return '';
    }
  }

  _scheduleReconnect() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      this.connect();
    }, 2500);
  }

  /**
   * Handles commands from Python server/CLI/MCP
   */
  async handleRequest(req) {
    const { action } = req;

    switch (action) {
      case 'agent': {
        let toolId = null;
        const fail = (code, message, hint = '') =>
          ({ ok: false, error: { code, message, hint, toolId } });
        try {
          if (typeof req.method !== 'string' || req.method.length > 256 ||
              (req.args !== undefined && !Array.isArray(req.args))) {
            return fail('E_INVALID_ARG', 'Provide a public method path and an args array.');
          }
          const method = req.method.replace(/^agent\./, '');
          const parts = method.split('.');
          const forbidden = new Set(['prototype', 'constructor', 'token', 'private', 'caller', 'callee', 'arguments']);
          if (parts.some(part => !/^[A-Za-z][A-Za-z0-9_]*$/.test(part) || forbidden.has(part.toLowerCase()))) {
            return fail('E_PERMISSION', 'Only public agent method paths are callable.');
          }
          toolId = method;
          // Read data descriptors only: no inherited members or accessor side effects.
          const root = Object.getOwnPropertyDescriptor(window, 'agent');
          let owner = root && Object.hasOwn(root, 'value') ? root.value : null;
          if (!owner || typeof owner !== 'object') {
            return fail('E_DISABLED', 'Agent API is not initialized.', 'Open a studio with window.agent enabled.');
          }
          let callable;
          for (let i = 0; i < parts.length; i++) {
            const descriptor = Object.getOwnPropertyDescriptor(owner, parts[i]);
            if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
              return fail('E_NOT_FOUND', 'Public agent method was not found.');
            }
            if (i === parts.length - 1) {
              callable = descriptor.value;
            } else {
              owner = descriptor.value;
              if (!owner || typeof owner !== 'object') {
                return fail('E_PERMISSION', 'Method traversal must stay within public agent objects.');
              }
            }
          }
          if (typeof callable !== 'function') {
            return fail('E_NOT_FOUND', 'Agent path is not callable.');
          }
          // Root exec is intentionally allowed: its trusted agent implementation owns
          // worker isolation. Never route it through the legacy execute/eval action.
          let timer;
          const timeoutMs = Number.isFinite(req.timeoutMs) ? Math.max(1, Math.min(120000, req.timeoutMs)) : 20000;
          const callArgs = Array.isArray(req.args) ? [...req.args] : [];
          // Align agent.exec worker timeout to never outlive the bridge call deadline
          if (req.method === 'exec' && callArgs.length >= 1) {
            const execOpts = (callArgs[1] && typeof callArgs[1] === 'object') ? { ...callArgs[1] } : {};
            const reqExecTimeout = Number.isFinite(Number(execOpts.timeout)) ? Number(execOpts.timeout) : timeoutMs;
            execOpts.timeout = Math.max(1, Math.min(timeoutMs, reqExecTimeout));
            callArgs[1] = execOpts;
          }
          try {
            let result;
            if (req.method === 'exec') {
              // agent.exec owns its own hard Worker timeout + busy lifecycle; await it directly so bridge never unlocks early
              result = await Promise.resolve().then(() => Reflect.apply(callable, owner, callArgs));
            } else {
              result = await Promise.race([
                Promise.resolve().then(() => Reflect.apply(callable, owner, callArgs)),
                new Promise(resolve => {
                  timer = setTimeout(() => resolve(fail('E_TIMEOUT', 'Agent browser call timed out.')), timeoutMs);
                })
              ]);
            }
            const response = result && typeof result === 'object' && typeof result.ok === 'boolean'
              ? result : { ok: true, data: result === undefined ? null : result };
            // Fail here (with the agent contract), not later in WebSocket serialization.
            JSON.stringify(response);
            return response;
          } finally {
            clearTimeout(timer);
          }
        } catch (err) {
          const codes = new Set(['E_PERMISSION', 'E_NOT_FOUND', 'E_INVALID_ARG', 'E_DISABLED', 'E_TIMEOUT',
            'E_CORS', 'E_TOO_LARGE', 'E_UNSUPPORTED', 'E_NEEDS_CONFIRM', 'E_TX_CONFLICT']);
          if (typeof err?.toolId === 'string') toolId = err.toolId;
          return fail(codes.has(err?.code) ? err.code : 'E_INVALID_ARG',
            err?.message || 'Agent method failed.', typeof err?.hint === 'string' ? err.hint : '');
        }
      }

      // 1. EXECUTE DSL SCRIPT
      case 'execute': {
        const code = req.code;
        if (!code) return { success: false, error: 'No code provided' };

        // Default to isolated Worker + transaction path; never silently bypass into main-realm AsyncFunction
        const usePrivileged = Boolean(req.privileged === true);
        if (!usePrivileged) {
          if (!window.agent || typeof window.agent.exec !== 'function') {
            return {
              success: false,
              isolated: true,
              code: 'E_UNAVAILABLE',
              error: 'Isolated agent.exec Worker is not ready yet; refusing silent main-realm fallback.',
            };
          }
          try {
            const rawTimeout = req.timeout ?? req.timeoutMs;
            const timeout = Number.isFinite(Number(rawTimeout))
              ? Math.max(1000, Math.min(120000, Math.round(Number(rawTimeout))))
              : 30000;
            const res = await window.agent.exec(code, { timeout });
            if (res && res.ok === false) {
              return {
                success: false,
                isolated: true,
                code: res.error?.code || 'E_EXEC_FAILED',
                error: res.error?.message || String(res.error || 'Isolated script execution failed'),
                result: res,
              };
            }
            window.engine?.markShadowDirty?.();
            window.engine?.requestRender?.();
            return {
              success: true,
              isolated: true,
              message: 'Script executed in isolated agent.exec Worker',
              result: res?.data !== undefined ? res.data : (res !== undefined ? res : null),
            };
          } catch (err) {
            return { success: false, isolated: true, code: err?.code || 'E_EXEC_FAILED', error: err?.message || String(err) };
          }
        }

        try {
          console.warn('[StudioBridge] Executing DSL in privileged main-realm mode (explicit opt-in).');
          const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;
          const body = code.trim();
          let ret;
          try {
            const exprFn = new AsyncFunction('studio', 'sceneManager', `"use strict";\nreturn (${body});`);
            ret = await exprFn(window.studio, window.sceneManager);
          } catch (syntaxErr) {
            const runFn = new AsyncFunction('studio', 'sceneManager', `"use strict";\n${body}`);
            ret = await runFn(window.studio, window.sceneManager);
          }
          window.engine?.markShadowDirty?.();
          window.engine?.requestRender?.();
          return { success: true, isolated: false, message: 'Script executed in privileged mode', result: ret !== undefined ? ret : null };
        } catch (err) {
          return { success: false, isolated: false, error: err.message, stack: err.stack };
        }
      }

      // 2. TRIGGER AI 3D GENERATION
      case 'generate': {
        const prompt = req.prompt;
        if (!prompt) return { success: false, error: 'No prompt provided' };

        try {
          if (!window.aiCopilot) throw new Error('AI Copilot module not initialized in browser');
          const result = await window.aiCopilot.sendPrompt(prompt);
          if (!result || result.ok === false) {
            return {
              success: false,
              error: result?.error || 'AI generation failed',
              explanation: result?.explanation || null,
              code: null,
              objectsCount: window.sceneManager ? window.sceneManager.objects.size : 0
            };
          }
          return {
            success: true,
            explanation: result.explanation || 'Generated 3D asset',
            code: result.code || null,
            objectsCount: window.sceneManager ? window.sceneManager.objects.size : 0
          };
        } catch (err) {
          return { success: false, error: err.message };
        }
      }

      // 3. GET SCENE OBJECTS & HIERARCHY
      case 'get_scene': {
        try {
          const sm = window.sceneManager;
          const objects = [];
          if (sm && sm.objects) {
            sm.objects.forEach((obj, uuid) => {
              let geomInfo = { vertices: 0, faces: 0, type: obj.isInstancedMesh ? 'InstancedMesh' : obj.type, instances: obj.isInstancedMesh ? obj.count : 1 };
              if (obj.geometry) {
                geomInfo.vertices = obj.geometry.attributes?.position?.count || 0;
                geomInfo.faces = obj.geometry.index ? Math.floor(obj.geometry.index.count / 3) : Math.floor(geomInfo.vertices / 3);
              }
              let matInfo = null;
              if (obj.material) {
                const m = Array.isArray(obj.material) ? obj.material[0] : obj.material;
                matInfo = {
                  color: m.color ? '#' + m.color.getHexString() : null,
                  roughness: m.roughness,
                  metalness: m.metalness,
                  wireframe: !!m.wireframe
                };
              }
              objects.push({
                id: obj.userData?.id || uuid,
                name: obj.name || 'Unnamed',
                type: obj.type,
                visible: obj.visible,
                position: [Number(obj.position.x.toFixed(3)), Number(obj.position.y.toFixed(3)), Number(obj.position.z.toFixed(3))],
                rotation: [Number(obj.rotation.x.toFixed(3)), Number(obj.rotation.y.toFixed(3)), Number(obj.rotation.z.toFixed(3))],
                scale: [Number(obj.scale.x.toFixed(3)), Number(obj.scale.y.toFixed(3)), Number(obj.scale.z.toFixed(3))],
                geometry: geomInfo,
                material: matInfo,
                selected: sm.isSelected ? sm.isSelected(obj) : (sm.getActiveObject() === obj)
              });
            });
          }

          const active = sm ? sm.getActiveObject() : null;
          return {
            success: true,
            scene: {
              totalObjects: objects.length,
              activeObject: active ? active.name : null,
              objects: objects
            }
          };
        } catch (err) {
          return { success: false, error: err.message };
        }
      }

      // 4. CAPTURE VIEWPORT SCREENSHOT
      case 'screenshot': {
        try {
          if (!window.exporter) throw new Error('Exporter module not available');
          const exp = window.exporter;
          const shotFn = (exp.captureViewport || exp.captureRenderPNG).bind(exp);
          const shot = await shotFn({ scale: req.scale || 1, download: false });
          return {
            success: true,
            dataUrl: shot.dataUrl,
            width: shot.width,
            height: shot.height
          };
        } catch (err) {
          return { success: false, error: err.message };
        }
      }

      // 5. EXPORT 3D MODEL
      case 'export': {
        try {
          const format = (req.format || 'obj').toLowerCase();
          const exp = window.exporter;
          if (!exp) throw new Error('Exporter module not available');

          let content;
          let isBase64 = false;

          if (format === 'glb') {
            const res = await exp.exportGLTF(null, { binary: true, download: false });
            let binaryStr = '';
            const bytes = new Uint8Array(res.buffer);
            const chunk = 8192;
            for (let i = 0; i < bytes.byteLength; i += chunk) {
              const sub = bytes.subarray(i, i + chunk);
              binaryStr += String.fromCharCode.apply(null, sub);
            }
            content = btoa(binaryStr);
            isBase64 = true;
          } else if (format === 'gltf') {
            const res = await exp.exportGLTF(null, { binary: false, download: false });
            content = res.json;
          } else if (format === 'ply') {
            const res = await exp.exportPLY(null, { binary: false, download: false });
            content = typeof res.result === 'string' ? res.result : safeJsonSerialize(res.result);
          } else if (format === 'stl') {
            content = exp.exportSTL(null, { binary: false, download: false });
          } else if (format === 'json') {
            content = safeJsonSerialize(exp.serializeProject(), 10);
          } else {
            content = exp.generateOBJString();
          }

          return { success: true, format, content, isBase64 };
        } catch (err) {
          return { success: false, error: err.message };
        }
      }

      // 6. SELECT OBJECT
      case 'select': {
        try {
          const sm = window.sceneManager;
          if (!sm) throw new Error('SceneManager not available');
          const target = sm.resolveObject(req.name);
          if (target) {
            sm.select(target);
            return { success: true, selected: target.name };
          }
          return { success: false, error: `Object '${req.name}' not found` };
        } catch (err) {
          return { success: false, error: err.message };
        }
      }

      // 7. CLEAR SCENE
      case 'clear': {
        try {
          if (window.studio && typeof window.studio.clearScene === 'function') {
            window.studio.clearScene();
          }
          return { success: true, message: 'Scene cleared' };
        } catch (err) {
          return { success: false, error: err.message };
        }
      }

      default:
        return { success: false, error: `Unknown bridge action: ${action}` };
    }
  }
}

// Expose the class for tooling, but never auto-connect: app.js owns the single
// StudioBridge instance. Auto-connecting here created a second WebSocket per
// tab, which made bridge targeting ambiguous and doubled server clients.
if (typeof window !== 'undefined') {
  window.StudioBridge = StudioBridge;
}
