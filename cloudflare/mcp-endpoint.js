/**
 * Hunger 3D Studio — Remote Streamable HTTP MCP Endpoint (`/mcp`) & CLI REST Bridge
 *
 * Implements:
 *  1. CLI & local `studio_mcp.py` REST endpoints backed by `StudioBridgeHub` Durable Object:
 *     - `/api/bridge/ws` (WebSocket upgrade from browser tab)
 *     - `/api/agent/call`, `/api/agent/allowlist`, `/api/execute`, `/api/generate`,
 *       `/api/scene`, `/api/screenshot`, `/api/export`, `/api/select`, `/api/clear`
 *  2. Remote Streamable HTTP MCP server (`POST /mcp` JSON-RPC 2.0):
 *     - `initialize`, `notifications/initialized`, `ping`, `tools/list`, `tools/call`
 *     - Exposes all 8 Hunger 3D Studio MCP tools directly over HTTPS!
 */

const SAFE_SESSION_RE = /^[A-Za-z0-9_-]{4,64}$/;
const PROXY_ALLOWLIST = new Set([
  'dl.polyhaven.org',
  'cdn.polyhaven.org',
  'cdn.polyhaven.com',
  'api.polyhaven.com',
  'raw.githubusercontent.com',
]);
const MOCAP_SAMPLES = Object.freeze([
  { id: 'shuffle', name: 'Shuffle Dance (shuffle_dance.mp4)', file: 'models/shuffle_dance.mp4', desc: 'Full-body shuffle dance routine (20s)' },
  { id: 'guitarist', name: 'Guitarist Motion (sample_human_motion.webm)', file: 'models/sample_human_motion.webm', desc: 'Upper body & guitar strumming motion (56s)' },
  { id: 'aerobics', name: 'Aerobics Workout (aerobics_exercise.webm)', file: 'models/aerobics_exercise.webm', desc: 'Full-body fitness squats and jumps (12s)' },
]);
const HUNYUAN_SAMPLES = Object.freeze([
  { id: 'man_portrait', name: 'Portrait (Nam)', file: 'models/man_face_portrait.jpg', desc: 'Sample male portrait' },
  { id: 'woman_portrait', name: 'Portrait (Nữ)', file: 'models/woman_face_portrait.jpg', desc: 'Sample female portrait' },
]);

export const MCP_TOOLS = Object.freeze([
  {
    name: 'studio_agent_call',
    description: 'Call a public window.agent method (e.g. scene.tree, object.create, camera.frame) with positional args.',
    inputSchema: {
      type: 'object',
      properties: {
        method: { type: 'string', description: 'Dotted agent method name, e.g. "scene.tree"' },
        args: { type: 'array', items: {}, description: 'Positional arguments array', default: [] },
      },
      required: ['method'],
    },
  },
  {
    name: 'studio_execute_dsl',
    description: 'Execute JavaScript 3D modeling DSL code in the live Hunger 3D Studio viewport.',
    inputSchema: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'JavaScript code using studio.* DSL and THREE' },
      },
      required: ['code'],
    },
  },
  {
    name: 'studio_generate_3d',
    description: 'Prompt Hunger AI Copilot to generate or modify a 3D scene from natural language.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Natural language 3D modeling instruction' },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'studio_get_scene',
    description: 'Inspect all active 3D meshes, hierarchy, polygon/vertex counts, materials, transforms, and selection.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'studio_capture_viewport',
    description: 'Capture a PNG screenshot of the live 3D viewport in Hunger 3D Studio.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'studio_export_model',
    description: 'Export the active 3D scene as GLB, GLTF, OBJ, STL, PLY, or JSON.',
    inputSchema: {
      type: 'object',
      properties: {
        format: { type: 'string', enum: ['glb', 'gltf', 'obj', 'stl', 'ply', 'json'], default: 'glb' },
      },
    },
  },
  {
    name: 'studio_select_object',
    description: 'Select a specific 3D object by its name or ID in the Hunger viewport.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Object name or UUID' },
      },
      required: ['name'],
    },
  },
  {
    name: 'studio_clear_scene',
    description: 'Clear all objects and reset the 3D scene in Hunger 3D Studio.',
    inputSchema: { type: 'object', properties: {} },
  },
]);

function extractSessionAndToken(request, url) {
  const rawSession = (
    url.searchParams.get('session') ||
    request.headers.get('x-studio-session') ||
    'default'
  ).trim();
  const sessionId = SAFE_SESSION_RE.test(rawSession) ? rawSession : 'default';
  const authHeader = request.headers.get('authorization') || '';
  const bearer = authHeader.toLowerCase().startsWith('bearer ') ? authHeader.slice(7).trim() : '';
  const token = (
    request.headers.get('x-studio-token') ||
    bearer ||
    url.searchParams.get('token') ||
    ''
  ).trim();
  return { sessionId, token };
}

function getHubStub(env, sessionId) {
  if (!env?.BRIDGE_HUB) return null;
  if (typeof env.BRIDGE_HUB.getByName === 'function') {
    return env.BRIDGE_HUB.getByName(sessionId);
  }
  const id = env.BRIDGE_HUB.idFromName(sessionId);
  return env.BRIDGE_HUB.get(id);
}

export async function getBridgeConnectedCount(env, sessionId = 'default') {
  const stub = getHubStub(env, sessionId);
  if (!stub) return 0;
  try {
    const resp = await stub.fetch(new Request('https://bridge.internal/status'));
    const data = await resp.json();
    return Number(data?.connectedBrowsers) || 0;
  } catch {
    return 0;
  }
}

async function dispatchBridgeCommand(env, sessionId, token, payload) {
  const stub = getHubStub(env, sessionId);
  if (!stub) {
    return {
      status: 503,
      data: {
        success: false,
        ok: false,
        error: { code: 'E_DISABLED', message: 'BRIDGE_HUB Durable Object is not configured.' },
      },
    };
  }
  const headers = { 'Content-Type': 'application/json', 'X-Studio-Session': sessionId };
  if (token) headers['X-Studio-Token'] = token;
  const resp = await stub.fetch(
    new Request(`https://bridge.internal/command?session=${encodeURIComponent(sessionId)}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    }),
  );
  const data = await resp.json().catch(() => ({ success: false, ok: false, error: 'Invalid bridge response' }));
  return { status: resp.status, data };
}

async function readJsonSafe(request) {
  try {
    const txt = await request.text();
    if (!txt.trim()) return {};
    const parsed = JSON.parse(txt);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export async function handleBridgeRoute(request, env, url) {
  const path = url.pathname;
  const method = request.method.toUpperCase();
  const { sessionId, token } = extractSessionAndToken(request, url);

  if (path === '/api/bridge/ws') {
    const stub = getHubStub(env, sessionId);
    if (!stub) return new Response('Bridge unavailable', { status: 503 });
    const qs = new URLSearchParams({ session: sessionId });
    if (token) qs.set('token', token);
    return stub.fetch(new Request(`https://bridge.internal/ws?${qs.toString()}`, request));
  }

  if (path === '/api/agent/allowlist' && method === 'GET') {
    return Response.json(
      { ok: true, success: true, hosts: [...PROXY_ALLOWLIST] },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  }

  if (path === '/api/agent/proxy' && (method === 'GET' || method === 'HEAD')) {
    const rawTarget = (url.searchParams.get('url') || '').trim();
    let target;
    try {
      target = new URL(rawTarget);
    } catch {
      return Response.json({ ok: false, success: false, error: 'Invalid proxy URL' }, { status: 400 });
    }
    if (target.protocol !== 'https:' || target.username || target.password || !PROXY_ALLOWLIST.has(target.hostname.toLowerCase())) {
      return Response.json({ ok: false, success: false, error: 'Host not in proxy allowlist' }, { status: 403 });
    }
    const upstream = await fetch(target.toString(), {
      method,
      headers: { 'User-Agent': 'HungerStudio/2.0' },
      redirect: 'follow',
    });
    // Re-check final URL after redirects against allowlist (SSRF protection)
    try {
      const finalUrl = new URL(upstream.url || target.toString());
      if (finalUrl.protocol !== 'https:' || !PROXY_ALLOWLIST.has(finalUrl.hostname.toLowerCase())) {
        return Response.json({ ok: false, success: false, error: 'Redirected host not allowed' }, { status: 403 });
      }
    } catch {
      return Response.json({ ok: false, success: false, error: 'Invalid redirect target' }, { status: 502 });
    }
    const headers = new Headers();
    const ct = upstream.headers.get('content-type');
    if (ct) headers.set('Content-Type', ct);
    const cl = upstream.headers.get('content-length');
    if (cl) headers.set('Content-Length', cl);
    headers.set('Cross-Origin-Resource-Policy', 'cross-origin');
    headers.set('Access-Control-Allow-Origin', '*');
    headers.set('Cache-Control', 'public, max-age=3600');
    headers.set('X-Content-Type-Options', 'nosniff');
    return new Response(method === 'HEAD' ? null : upstream.body, { status: upstream.status, headers });
  }

  // Native Edge responses for TTS, Browser-WASM Mocap, and Hunyuan3D status (zero 503 noise)
  if (path === '/api/tts') {
    return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });
  }
  if (path === '/api/mocap/samples' && method === 'GET') {
    return Response.json({ success: true, samples: MOCAP_SAMPLES }, { headers: { 'Cache-Control': 'public, max-age=300' } });
  }
  if (path === '/api/mocap/health' && method === 'GET') {
    return Response.json({
      success: true,
      available: false,
      browserWasm: true,
      model: 'pose_landmarker_full.task',
      error: 'Cloudflare Edge (Browser WASM Mode)',
      hint: 'Video-to-3D Mocap chạy trực tiếp bằng MediaPipe WASM trên trình duyệt (Zero-Server-GPU).',
    }, { headers: { 'Cache-Control': 'no-store' } });
  }
  if (path === '/api/mocap/progress' && method === 'GET') {
    return Response.json({ success: true, active: false, stage: 'idle', processed: 0, total: 0, percent: 0, fps: 0, etaSec: 0 }, { headers: { 'Cache-Control': 'no-store' } });
  }
  if (!env?.API_ORIGIN && path === '/api/hunyuan3d/status' && method === 'GET') {
    return Response.json({
      success: true,
      engineReady: false,
      mode: 'maintenance',
      message: 'Image-to-3D cần gắn GPU backend tùy chọn (API_ORIGIN). Các tính năng 3D, Mocap WASM, AI Copilot và Cloud chạy 100% trực tiếp trên Edge.',
    }, { headers: { 'Cache-Control': 'no-store' } });
  }
  if (!env?.API_ORIGIN && path === '/api/hunyuan3d/samples' && method === 'GET') {
    return Response.json({ success: true, samples: HUNYUAN_SAMPLES }, { headers: { 'Cache-Control': 'public, max-age=300' } });
  }
  if (!env?.API_ORIGIN && path === '/api/hunyuan3d/progress' && method === 'GET') {
    return Response.json({ success: true, active: false, stage: 'idle', percent: 0 }, { headers: { 'Cache-Control': 'no-store' } });
  }

  let commandPayload = null;
  if (path === '/api/agent/call' && method === 'POST') {
    const body = await readJsonSafe(request);
    commandPayload = { action: 'agent', method: body.method, args: Array.isArray(body.args) ? body.args : [] };
  } else if (path === '/api/execute' && method === 'POST') {
    const body = await readJsonSafe(request);
    commandPayload = {
      action: 'execute',
      code: String(body.code || ''),
      timeoutMs: (Number(body.timeout) || 90) * 1000,
    };
  } else if (path === '/api/generate' && method === 'POST') {
    const body = await readJsonSafe(request);
    commandPayload = { action: 'generate', prompt: String(body.prompt || ''), timeoutMs: 105000 };
  } else if (path === '/api/scene' && method === 'GET') {
    commandPayload = { action: 'get_scene' };
  } else if (path === '/api/screenshot' && method === 'GET') {
    commandPayload = { action: 'screenshot' };
  } else if (path === '/api/export' && method === 'POST') {
    const body = await readJsonSafe(request);
    commandPayload = { action: 'export', format: String(body.format || 'glb').toLowerCase() };
  } else if (path === '/api/select' && method === 'POST') {
    const body = await readJsonSafe(request);
    commandPayload = { action: 'select', name: String(body.name || '') };
  } else if (path === '/api/clear' && method === 'POST') {
    commandPayload = { action: 'clear' };
  }

  if (!commandPayload) return null;

  const { status, data } = await dispatchBridgeCommand(env, sessionId, token, commandPayload);
  return Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
}

function mcpResult(id, result) {
  return Response.json(
    { jsonrpc: '2.0', id, result },
    {
      status: 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': '*',
      },
    },
  );
}

function mcpError(id, code, message, httpStatus = 200) {
  return Response.json(
    { jsonrpc: '2.0', id: id ?? null, error: { code, message } },
    {
      status: httpStatus,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': '*',
      },
    },
  );
}

function formatSceneText(scene = {}) {
  const objs = Array.isArray(scene.objects) ? scene.objects : [];
  const lines = [
    `=== Hunger 3D Scene Overview (${scene.totalObjects ?? objs.length} objects) ===`,
    `Active Object: ${scene.activeObject || 'None'}`,
    '',
  ];
  for (const o of objs) {
    const pos = o.position || [0, 0, 0];
    const g = o.geometry || {};
    const m = o.material || {};
    const sel = o.selected ? ' [SELECTED]' : '';
    lines.push(`- ${o.name} (${o.type})${sel}: Pos=${JSON.stringify(pos)}, Verts=${g.vertices || 0}, Faces=${g.faces || 0}, Color=${m.color || '-'}`);
  }
  return lines.join('\n');
}

export async function handleMcpEndpoint(request, env, url) {
  const method = request.method.toUpperCase();
  if (method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Studio-Token, X-Studio-Session, Mcp-Session-Id',
      },
    });
  }
  if (method === 'GET') {
    return Response.json(
      {
        name: 'hunger-3d-studio',
        protocol: 'mcp-streamable-http',
        endpoint: `${url.origin}/mcp`,
        tools: MCP_TOOLS.map((t) => t.name),
      },
      { headers: { 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' } },
    );
  }
  if (method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  let req;
  try {
    req = await request.json();
  } catch {
    return mcpError(null, -32700, 'Parse error: invalid JSON', 400);
  }
  if (!req || typeof req !== 'object' || req.jsonrpc !== '2.0') {
    return mcpError(req?.id ?? null, -32600, 'Invalid Request: expected JSON-RPC 2.0 object', 400);
  }

  const { id, method: rpcMethod, params = {} } = req;

  if (rpcMethod === 'initialize') {
    return mcpResult(id, {
      protocolVersion: params.protocolVersion || '2025-03-26',
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'hunger-3d-studio', version: '2.0.0' },
    });
  }
  if (rpcMethod === 'notifications/initialized') {
    return new Response(null, { status: 202, headers: { 'Access-Control-Allow-Origin': '*' } });
  }
  if (rpcMethod === 'ping') {
    return mcpResult(id, {});
  }
  if (rpcMethod === 'tools/list') {
    return mcpResult(id, { tools: MCP_TOOLS });
  }
  if (rpcMethod !== 'tools/call') {
    return mcpError(id, -32601, `Method not found: ${rpcMethod}`);
  }

  const toolName = String(params?.name || '');
  const args = params?.arguments && typeof params.arguments === 'object' ? params.arguments : {};
  const { sessionId, token } = extractSessionAndToken(request, url);

  let commandPayload;
  switch (toolName) {
    case 'studio_agent_call':
      commandPayload = { action: 'agent', method: String(args.method || ''), args: Array.isArray(args.args) ? args.args : [] };
      break;
    case 'studio_execute_dsl':
      commandPayload = { action: 'execute', code: String(args.code || ''), timeoutMs: 90000 };
      break;
    case 'studio_generate_3d':
      commandPayload = { action: 'generate', prompt: String(args.prompt || ''), timeoutMs: 105000 };
      break;
    case 'studio_get_scene':
      commandPayload = { action: 'get_scene' };
      break;
    case 'studio_capture_viewport':
      commandPayload = { action: 'screenshot' };
      break;
    case 'studio_export_model':
      commandPayload = { action: 'export', format: String(args.format || 'glb').toLowerCase() };
      break;
    case 'studio_select_object':
      commandPayload = { action: 'select', name: String(args.name || '') };
      break;
    case 'studio_clear_scene':
      commandPayload = { action: 'clear' };
      break;
    default:
      return mcpError(id, -32602, `Unknown tool: ${toolName}`);
  }

  const { status, data } = await dispatchBridgeCommand(env, sessionId, token, commandPayload);

  if (toolName === 'studio_agent_call') {
    return mcpResult(id, {
      content: [{ type: 'text', text: JSON.stringify(data) }],
      isError: data?.ok !== true,
    });
  }

  if (status >= 400 || data?.success === false) {
    const errText = typeof data?.error === 'object'
      ? `${data.error.message || 'Bridge error'}${data.error.hint ? ` (${data.error.hint})` : ''}`
      : String(data?.error || `HTTP ${status}`);
    return mcpResult(id, {
      content: [{ type: 'text', text: errText }],
      isError: true,
    });
  }

  if (toolName === 'studio_get_scene') {
    return mcpResult(id, { content: [{ type: 'text', text: formatSceneText(data.scene) }] });
  }
  if (toolName === 'studio_capture_viewport') {
    const rawUrl = String(data.dataUrl || '');
    const base64 = rawUrl.includes(',') ? rawUrl.split(',', 2)[1] : rawUrl;
    return mcpResult(id, {
      content: [
        { type: 'image', data: base64, mimeType: 'image/png' },
        { type: 'text', text: `Captured viewport (${data.width || 0}x${data.height || 0})` },
      ],
    });
  }
  if (toolName === 'studio_export_model') {
    const fmt = String(args.format || 'glb').toLowerCase();
    const content = String(data.content || '');
    const sizeKb = (data.isBase64 ? (content.length * 0.75) : content.length) / 1024;
    return mcpResult(id, {
      content: [{ type: 'text', text: JSON.stringify({ format: fmt, isBase64: Boolean(data.isBase64), sizeKb: Number(sizeKb.toFixed(1)), content }) }],
    });
  }

  return mcpResult(id, {
    content: [{ type: 'text', text: JSON.stringify(data) }],
  });
}
