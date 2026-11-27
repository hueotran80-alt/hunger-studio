/**
 * AI Copilot ↔ Agent Tool Bridge (ADDITIVE — không sửa file nào của dự án).
 *
 * Vì `/api/ai/chat` hiện chỉ chuyển `model/messages/temperature` (không có
 * `tools`/`tool_calls`), cầu nối dùng **tool protocol bằng JSON** trong nội dung
 * trả về — tương thích mọi provider/model mà Copilot đang dùng:
 *
 *   1. Catalog 68 tool của `js/agent/agent-manifest.js` được nhét vào system prompt.
 *   2. Model trả về đúng một khối ```json {"tool":"scene.tree","args":[{}]} ```.
 *   3. Bridge gọi façade thật `window.agent.<namespace>.<method>(...args)`.
 *   4. Kết quả được gửi lại dưới dạng `TOOL_RESULT {...}` và lặp tới khi model
 *      trả lời cuối (có thể kèm ```javascript``` như Copilot vẫn xử lý).
 *
 * An toàn:
 *  - Chỉ gọi tool `agentCallable !== false`, bỏ tool `browserOnly`.
 *  - `exec` bị loại mặc định (opt-in bằng `allowExec: true`).
 *  - Tool phá huỷ (`scene.delete`, `scene.clear`, `assets.delete`) yêu cầu
 *    callback `approve()` trả true; nếu không -> `E_CONFIRM_REQUIRED`.
 *  - Timeout từng tool, giới hạn số bước, chặn args quá lớn.
 *
 * Gắn vào Copilot (runtime, không sửa code):
 *   const bridge = await import('./js/ai/agent-tool-bridge.js');
 *   await bridge.installToolCalling(window.aiCopilot, { agent: window.agent });
 *   // ... bridge.uninstallToolCalling(window.aiCopilot) để trả lại như cũ.
 */

import { stripThinkingTags } from './scene-digest.js';

export const DESTRUCTIVE_TOOLS = Object.freeze(['scene.delete', 'scene.clear', 'assets.delete']);
export const TOOL_RESULT_PREFIX = 'TOOL_RESULT';
const DEFAULT_MAX_ARGS_BYTES = 200_000;
const MAX_TOOL_RESULT_CHARS = 8000;

function serializeToolResult(result) {
  const payload = {
    tool: result.tool,
    ok: result.ok,
    data: result.data ?? null,
    error: result.error ?? null,
  };
  let json = '';
  try {
    json = JSON.stringify(payload);
  } catch (_) {
    json = JSON.stringify({ tool: result.tool, ok: result.ok, data: String(result.data ?? ''), error: result.error ?? null });
  }
  if (json.length <= MAX_TOOL_RESULT_CHARS) return json;
  const previewLen = Math.max(256, MAX_TOOL_RESULT_CHARS - 350);
  const rawData = typeof result.data === 'string' ? result.data : (() => { try { return JSON.stringify(result.data); } catch (_) { return String(result.data); } })();
  return JSON.stringify({
    tool: result.tool,
    ok: result.ok,
    data: {
      truncated: true,
      originalChars: rawData.length,
      preview: rawData.slice(0, previewLen),
    },
    error: result.error ?? null,
  });
}

/* -------------------------------------------------------------------------- */
/* Catalog                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Nạp định nghĩa tool thật (chỉ dùng trong trình duyệt / bundler).
 * Nếu manifest không import được (ví dụ chạy từ bản `dist/` chỉ có bundle),
 * fallback sang introspection façade `window.agent` — vẫn gọi được tool, chỉ
 * mất mô tả tham số chi tiết.
 */
export async function loadToolDefinitions(options = {}) {
  try {
    const mod = await import('../agent/agent-manifest.js');
    if (Array.isArray(mod.API_TOOL_DEFS) && mod.API_TOOL_DEFS.length) return mod.API_TOOL_DEFS;
  } catch (_) {}
  const scope = typeof window !== 'undefined' ? window : globalThis;
  return introspectAgentTools(options.agent || scope.agent || null);
}

/** Sinh catalog tối thiểu từ chính façade agent (không cần manifest). */
export function introspectAgentTools(agent) {
  const defs = [];
  if (!agent || typeof agent !== 'object') return defs;
  for (const [namespace, value] of Object.entries(agent)) {
    if (!value || typeof value !== 'object') continue;
    for (const [name, fn] of Object.entries(value)) {
      if (typeof fn !== 'function') continue;
      defs.push({
        id: `${namespace}.${name}`,
        description: `Agent tool ${namespace}.${name}`,
        argsSchema: { prefixItems: [], minItems: 0 },
        agentCallable: true
      });
    }
  }
  return defs;
}

/**
 * @param {object[]} definitions  API_TOOL_DEFS
 * @param {object} [options]
 * @param {string[]} [options.allow]   chỉ những tool này (whitelist)
 * @param {string[]} [options.exclude] tool cần bỏ
 * @param {boolean} [options.allowExec=false]
 * @param {number} [options.maxCatalogChars=12000]
 * @returns {{ids: string[], defs: Map<string, object>, text: string, excluded: string[]}}
 */
export function buildToolCatalog(definitions = [], options = {}) {
  const allow = Array.isArray(options.allow) && options.allow.length ? new Set(options.allow) : null;
  const excluded = new Set(options.exclude || []);
  if (!options.allowExec) excluded.add('exec');

  const defs = new Map();
  const excludedIds = [];
  const domainGroups = new Map([
    ['scene', []],
    ['geometry', []],
    ['material', []],
    ['animation', []],
    ['export', []],
    ['observe', []],
    ['other', []],
  ]);

  const classifyDomain = (id) => {
    const s = String(id).toLowerCase();
    if (/^(scene\.|object\.|select|transform|group|parent|clear|undo|redo)/.test(s)) return 'scene';
    if (/^(geom|mesh|cad|loft|curve|mod|bevel|subdiv|boolean|sculpt|edit)/.test(s)) return 'geometry';
    if (/^(mat|pbr|tex|light|env|sky|render|post|camera)/.test(s)) return 'material';
    if (/^(anim|rig|mocap|pose|timeline|keyframe|phys)/.test(s)) return 'animation';
    if (/^(export|import|load|save|share|embed|cloud|glb|gltf)/.test(s)) return 'export';
    if (/^(inspect|budget|obs|shot|screen|ui\.|view|get|list|search|status|info)/.test(s)) return 'observe';
    return 'other';
  };

  for (const def of definitions) {
    if (!def || !def.id) continue;
    if (def.agentCallable === false || def.browserOnly) continue;
    if (excluded.has(def.id)) {
      excludedIds.push(def.id);
      continue;
    }
    if (allow && !allow.has(def.id)) continue;

    defs.set(def.id, def);
    const args = def.argsSchema && Array.isArray(def.argsSchema.prefixItems)
      ? def.argsSchema.prefixItems
      : [];
    const signature = args
      .map((schema, index) => `${index}:${shortType(schema)}${args.length && index >= requiredCount(def) ? '?' : ''}`)
      .join(', ');
    const description = String(def.description || '').replace(/\s+/g, ' ').slice(0, 72);
    const line = `- ${def.id}(${signature}) — ${description}${def.requiresConfirm ? ' [DESTRUCTIVE: confirm]' : ''}`;
    domainGroups.get(classifyDomain(def.id)).push(line);
  }

  const maxChars = Number.isFinite(options.maxCatalogChars) ? options.maxCatalogChars : 12000;
  const sections = [];
  let charBudget = 0;
  for (const [domain, groupLines] of domainGroups) {
    if (!groupLines.length) continue;
    const header = `## ${domain}`;
    if (charBudget + header.length + 2 > maxChars) break;
    const kept = [header];
    charBudget += header.length + 1;
    for (const line of groupLines) {
      if (charBudget + line.length + 1 > maxChars - 2) {
        kept.push('…');
        charBudget = maxChars;
        break;
      }
      kept.push(line);
      charBudget += line.length + 1;
    }
    sections.push(kept.join('\n'));
    if (charBudget >= maxChars) break;
  }
  const text = sections.join('\n');

  return { ids: [...defs.keys()], defs, text, excluded: excludedIds };
}

function requiredCount(def) {
  const min = def?.argsSchema?.minItems;
  return Number.isFinite(min) ? min : 0;
}

function shortType(schema) {
  if (!schema) return 'any';
  if (schema.const) return JSON.stringify(schema.const);
  if (Array.isArray(schema.enum)) return schema.enum.slice(0, 4).map(String).join('|');
  if (schema.type === 'array') return 'array';
  if (schema.type === 'object') return 'object';
  if (Array.isArray(schema.anyOf)) return 'any';
  return schema.type || 'any';
}

/* -------------------------------------------------------------------------- */
/* Parsing                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Trích tool call đầu tiên khỏi câu trả lời của model.
 * Hỗ trợ: ```json {...}```, JSON trần, {tool_calls:[...]}, {name, arguments}.
 * Trả null nếu đây là câu trả lời cuối (không có tool call).
 */
export function extractToolCall(text) {
  const raw = stripThinkingTags(text);
  if (!raw) return null;

  const fenced = [...raw.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].map((match) => match[1]);
  const candidates = [...fenced, raw];

  for (const candidate of candidates) {
    const parsed = parseJsonWithTool(candidate);
    if (parsed) return parsed;
    const embedded = findBalancedJson(candidate);
    if (embedded) {
      const nested = parseJsonWithTool(embedded);
      if (nested) return nested;
    }
  }
  return null;
}

function parseJsonWithTool(candidate) {
  const trimmed = String(candidate || '').trim();
  if (!trimmed.startsWith('{')) {
    const start = trimmed.indexOf('{');
    if (start === -1) return null;
    const balanced = findBalancedJson(trimmed.slice(start));
    if (!balanced) return null;
    return parseJsonWithTool(balanced);
  }
  let value;
  try {
    value = JSON.parse(trimmed);
  } catch (_) {
    const balanced = findBalancedJson(trimmed);
    if (!balanced || balanced === trimmed) return null;
    return parseJsonWithTool(balanced);
  }
  return normalizeToolCall(value);
}

function normalizeToolCall(value) {
  if (!value || typeof value !== 'object') return null;

  if (Array.isArray(value.tool_calls) && value.tool_calls.length) {
    for (const entry of value.tool_calls) {
      const call = normalizeToolCall(entry);
      if (call) return call;
    }
    return null;
  }

  const tool = value.tool || value.toolId || value.method || (typeof value.name === 'string' && !value.final ? value.name : null);
  if (!tool || typeof tool !== 'string') return null;

  let args = value.args ?? value.arguments ?? [];
  if (typeof args === 'string') {
    try {
      args = JSON.parse(args);
    } catch (_) {
      args = [];
    }
  }
  if (!Array.isArray(args)) args = [args];
  return { tool, args };
}

/** Tìm object JSON cân bằng đầu tiên (tôn trọng chuỗi escape). */
function findBalancedJson(text) {
  const source = String(text || '');
  const start = source.indexOf('{');
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < source.length; i += 1) {
    const char = source[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* Executor                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * @param {object} agent  façade `window.agent`
 * @param {object} [options]
 * @param {(info:{tool:string,args:any[]})=>Promise<boolean>|boolean} [options.approve]
 * @param {number} [options.timeoutMs=20000]
 * @param {number} [options.maxArgBytes]
 * @returns {{execute:(call:{tool:string,args:any[]})=>Promise<object>}}
 */
export function createAgentExecutor(agent, options = {}) {
  const defs = options.defs instanceof Map ? options.defs : new Map();
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 20000;
  const maxArgBytes = Number.isFinite(options.maxArgBytes) ? options.maxArgBytes : DEFAULT_MAX_ARGS_BYTES;
  const approve = typeof options.approve === 'function' ? options.approve : null;
  const onConfirmedDestructive = typeof options.onConfirmedDestructive === 'function' ? options.onConfirmedDestructive : null;

  const resolve = (toolId) => {
    const parts = String(toolId || '').split('.');
    if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
    const namespace = agent ? agent[parts[0]] : null;
    const fn = namespace ? namespace[parts[1]] : null;
    return typeof fn === 'function' ? fn : null;
  };

  const execute = async ({ tool, args } = {}) => {
    const toolId = String(tool || '');
    const def = defs.get(toolId);
    if (defs.size > 0 && !def) {
      return fail(toolId, 'E_UNKNOWN_TOOL', `Tool '${toolId}' không có trong catalog.`);
    }
    if (def && (def.agentCallable === false || def.browserOnly)) {
      return fail(toolId, 'E_UNSUPPORTED', `Tool '${toolId}' không gọi được từ agent.`);
    }

    const fn = resolve(toolId);
    if (!fn) return fail(toolId, 'E_NOT_IMPLEMENTED', `Agent chưa cung cấp '${toolId}'.`);

    const callArgs = Array.isArray(args) ? args : [];
    if (callArgs.length > 6) return fail(toolId, 'E_INVALID_ARG', 'Quá nhiều tham số (tối đa 6).');
    let serialized = '';
    try {
      serialized = JSON.stringify(callArgs);
    } catch (_) {
      return fail(toolId, 'E_INVALID_ARG', 'args không serialize được.');
    }
    if (serialized.length > maxArgBytes) return fail(toolId, 'E_INVALID_ARG', 'args quá lớn.');

    const destructive = Boolean(def && def.requiresConfirm) || DESTRUCTIVE_TOOLS.includes(toolId);
    if (destructive) {
      if (!approve) {
        return fail(toolId, 'E_CONFIRM_REQUIRED', `'${toolId}' cần người dùng xác nhận.`);
      }
      let approved = false;
      try {
        approved = await approve({ tool: toolId, args: callArgs });
      } catch (_) {
        approved = false;
      }
      if (!approved) return fail(toolId, 'E_CONFIRM_REQUIRED', `Người dùng chưa xác nhận '${toolId}'.`);
    }

    let timer = null;
    try {
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error('timeout'), { code: 'E_TIMEOUT' })), timeoutMs);
      });
      const result = await Promise.race([Promise.resolve().then(() => fn(...callArgs)), timeout]);
      if (result && typeof result === 'object' && 'ok' in result) {
        if (!result.ok && destructive && result.error?.code === 'E_NEEDS_CONFIRM' && onConfirmedDestructive) {
          const fallbackData = await onConfirmedDestructive(toolId, callArgs);
          if (fallbackData) return { tool: toolId, ok: true, data: fallbackData };
        }
        return result.ok
          ? { tool: toolId, ok: true, data: result.data ?? result.value ?? null }
          : { tool: toolId, ok: false, error: result.error || { code: 'E_AGENT', message: 'Agent trả lỗi.' } };
      }
      return { tool: toolId, ok: true, data: result ?? null };
    } catch (err) {
      const code = err && err.code ? String(err.code) : 'E_TOOL';
      if (destructive && code === 'E_NEEDS_CONFIRM' && onConfirmedDestructive) {
        try {
          const fallbackData = await onConfirmedDestructive(toolId, callArgs);
          if (fallbackData) return { tool: toolId, ok: true, data: fallbackData };
        } catch (fbErr) {
          return fail(toolId, fbErr?.code || 'E_TOOL', fbErr?.message || String(fbErr));
        }
      }
      return fail(toolId, code, err && err.message ? err.message : String(err));
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  return { execute };
}

function fail(tool, code, message) {
  return { tool, ok: false, error: { code, message } };
}

/* -------------------------------------------------------------------------- */
/* Loop                                                                       */
/* -------------------------------------------------------------------------- */

export function buildToolProtocolPrompt(catalog, maxSteps = 6) {
  return [
    '',
    '=== 3. AGENT TOOL PROTOCOL (JSON tools — ONLY when needed) ===',
    '- Visible scene objects are already in LIVE SCENE DIGEST. Answer scene summary questions directly from it (use scene.tree / scene.info ONLY if agentId, bones, or material/UV details are needed).',
    '- To CREATE, EDIT, or CLEAR objects (`studio.addCube`, `studio.clearScene()`), prefer replying with ONE ```javascript``` block instead of JSON tools. NEVER say "Đã thêm/xoá" without a ```javascript``` block or JSON tool call.',
    '- When a tool call IS needed, output ONLY ONE ```json``` block (`maxSteps=' + maxSteps + '`), e.g.: ```json\n{"tool":"scene.tree","args":[{"compact":true}]}\n```',
    '',
    'Available tools:',
    catalog.text || '(none)'
  ].join('\n');
}

/**
 * Vòng lặp model ↔ tool. `chat(messages)` trả về text thô của model.
 * @returns {Promise<{text:string, steps:number, toolCalls:object[], observations:object[], error?:string}>}
 */
export async function runToolLoop({
  chat,
  messages = [],
  catalog,
  executor,
  maxSteps = 6,
  onEvent,
  signal = null
}) {
  if (typeof chat !== 'function') throw new Error('runToolLoop: chat() là bắt buộc.');
  if (!executor || typeof executor.execute !== 'function') throw new Error('runToolLoop: executor là bắt buộc.');

  const assertNotAborted = () => {
    if (signal?.aborted) {
      const abortErr = new Error('Đã dừng yêu cầu AI theo thao tác của bạn.');
      abortErr.name = 'AbortError';
      throw abortErr;
    }
  };

  const history = cloneMessages(messages);
  const protocol = buildToolProtocolPrompt(catalog || { text: '' }, maxSteps);
  if (history[0] && history[0].role === 'system') {
    history[0] = { ...history[0], content: `${history[0].content}\n${protocol}` };
  } else {
    history.unshift({ role: 'system', content: protocol.trim() });
  }

  const toolCalls = [];
  const observations = [];
  let text = '';
  let step = 0;

  while (step < maxSteps) {
    assertNotAborted();
    step += 1;
    text = String((await chat(history)) || '');
    assertNotAborted();
    emit(onEvent, { type: 'model', step, text });

    const call = extractToolCall(text);
    if (!call) {
      return { text, steps: step, toolCalls, observations };
    }

    history.push({ role: 'assistant', content: text });
    const result = await executor.execute(call);
    assertNotAborted();
    toolCalls.push(call);
    observations.push(result);
    emit(onEvent, { type: 'tool', step, call, result });

    history.push({
      role: 'user',
      content: `${TOOL_RESULT_PREFIX} ${serializeToolResult(result)}`
    });
  }

  return { text, steps: step, toolCalls, observations, error: 'E_MAX_STEPS' };
}

function emit(onEvent, payload) {
  if (typeof onEvent !== 'function') return;
  try {
    onEvent(payload);
  } catch (_) {}
}

function cloneMessages(messages) {
  return (Array.isArray(messages) ? messages : []).map((message) => ({ ...message }));
}

/* -------------------------------------------------------------------------- */
/* Copilot integration (runtime only)                                         */
/* -------------------------------------------------------------------------- */

/**
 * Gắn tool-calling vào một instance AICopilot có sẵn **mà không sửa file dự án**.
 * Giữ nguyên `{explanation, code}` mà Copilot mong đợi.
 *
 * @param {object} copilot  instance AICopilot (window.aiCopilot)
 * @param {object} [options]
 * @param {object} [options.agent]      mặc định window.agent
 * @param {object[]} [options.definitions] bỏ trống -> tự load manifest
 * @param {Function} [options.transport] (messages, provider) => text; mặc định POST /api/ai/chat
 * @param {Function} [options.approve]  xác nhận tool phá huỷ
 * @param {number} [options.maxSteps=6]
 * @param {(event:object)=>void} [options.onEvent]
 * @returns {Promise<{ids:string[], uninstall:Function, catalog:object}>}
 */
export async function installToolCalling(copilot, options = {}) {
  if (!copilot || typeof copilot._callProxyAPI !== 'function') {
    throw new Error('installToolCalling: cần instance AICopilot đã khởi tạo.');
  }
  if (copilot.__agentToolBridge) return copilot.__agentToolBridge.handle;

  const scope = typeof window !== 'undefined' ? window : globalThis;
  const agent = options.agent || scope.agent || null;
  if (!agent) throw new Error('installToolCalling: agent API chưa sẵn sàng (window.agent).');

  const definitions = options.definitions || (await loadToolDefinitions({ agent }));
  // Chế độ Copilot: không bao giờ mở `exec` (chạy JS tuỳ ý) và không cho phép
  // bật lại qua options — Copilot chỉ được thao tác cảnh, không chạm dự án.
  const catalog = buildToolCatalog(definitions, {
    ...options,
    allowExec: false,
    exclude: [...(options.exclude || []), 'exec']
  });
  const executor = options.executor || createAgentExecutor(agent, { ...options, defs: catalog.defs });
  const maxSteps = Number.isFinite(options.maxSteps) ? options.maxSteps : 6;
  const transport = typeof options.transport === 'function' ? options.transport : defaultTransport(copilot);

  // Giữ đúng tham chiếu gốc (không bind) để uninstall phục hồi y nguyên.
  const original = copilot._callProxyAPI;

  const patched = async function toolCallingProxy(provider, userPrompt, images = []) {
    const baseMessages = typeof copilot._buildOpenAIMessages === 'function'
      ? copilot._buildOpenAIMessages(userPrompt, images)
      : [{ role: 'system', content: '' }, { role: 'user', content: String(userPrompt) }];
    const signal = copilot._activeAbortController?.signal || null;

    const loop = await runToolLoop({
      chat: (messages) => transport(messages, provider),
      messages: baseMessages,
      catalog,
      executor,
      maxSteps,
      onEvent: options.onEvent,
      signal
    });

    if (loop.error === 'E_MAX_STEPS') {
      console.warn('[AgentToolBridge] đạt giới hạn số bước, trả lời phần đã có.');
    }
    const parsed = typeof copilot._parseLLMResponse === 'function'
      ? copilot._parseLLMResponse(loop.text)
      : { explanation: stripThinkingTags(loop.text), code: null };
    return {
      ...parsed,
      _toolCallsCount: loop.toolCalls.length,
      toolCalls: loop.toolCalls
    };
  };

  copilot._callProxyAPI = patched;
  const handle = {
    ids: catalog.ids,
    policy: 'copilot-scene-only',
    execBlocked: true,
    catalog,
    uninstall() {
      copilot._callProxyAPI = original;
      delete copilot.__agentToolBridge;
    }
  };
  copilot.__agentToolBridge = { handle, original };
  return handle;
}

/** Trả Copilot về đúng phương thức gốc. */
export function uninstallToolCalling(copilot) {
  if (!copilot || !copilot.__agentToolBridge) return false;
  copilot._callProxyAPI = copilot.__agentToolBridge.original;
  delete copilot.__agentToolBridge;
  return true;
}

function defaultTransport(copilot) {
  return async (messages, provider) => {
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const parentSignal = copilot._activeAbortController?.signal || null;
    if (parentSignal?.aborted && controller) controller.abort();
    const onParentAbort = () => controller?.abort();
    parentSignal?.addEventListener?.('abort', onParentAbort, { once: true });
    const timer = controller ? setTimeout(() => controller.abort(), 150000) : null;
    const byokKey = typeof copilot._getByokKey === 'function' ? copilot._getByokKey() : '';
    const cloudClient = (typeof window !== 'undefined' && (window.app?.cloud || window.cloudClient)) || null;
    const useCloudRoute = Boolean(cloudClient?.isSignedIn?.());
    const url = useCloudRoute
      ? (cloudClient.absoluteUrl ? cloudClient.absoluteUrl('/api/cloud/ai/chat') : '/api/cloud/ai/chat')
      : '/api/ai/chat';
    let resp;
    try {
      if (useCloudRoute && typeof cloudClient._ensureFresh === 'function') {
        await cloudClient._ensureFresh();
      }
      const headers = { 'Content-Type': 'application/json' };
      if (useCloudRoute && cloudClient?.session?.accessToken) {
        headers.Authorization = `Bearer ${cloudClient.session.accessToken}`;
      }
      if (byokKey) {
        headers['X-AI-Provider-Key'] = byokKey;
      }
      resp = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          provider,
          model: typeof copilot._modelForProvider === 'function' ? copilot._modelForProvider(provider) : undefined,
          messages,
          temperature: 0.35,
          max_tokens: 12288,
        }),
        signal: controller ? controller.signal : undefined
      });
    } catch (err) {
      if (err && err.name === 'AbortError') {
        if (copilot._userAborted || parentSignal?.aborted) {
          throw new Error('Đã dừng yêu cầu AI theo thao tác của bạn.');
        }
        throw new Error('AI không phản hồi sau 60 giây. Hãy thử lại hoặc chọn model khác.');
      }
      if (err && (err.name === 'TypeError' || /failed to fetch|networkerror|load failed/i.test(String(err.message || '')))) {
        throw new Error(`Không kết nối được backend AI (${url}). Hãy kiểm tra server.py đang chạy trên cổng 8080 và tải lại trang.`);
      }
      throw err;
    } finally {
      if (timer) clearTimeout(timer);
      parentSignal?.removeEventListener?.('abort', onParentAbort);
    }
    if (!resp.ok) {
      const error = await resp.json().catch(() => ({}));
      const msg = error?.error?.message || (typeof error?.error === 'string' ? error.error : '') || `Dịch vụ AI tạm gián đoạn (HTTP ${resp.status}).`;
      const hint = error?.error?.hint ? ` ${error.error.hint}` : '';
      throw new Error(`${msg}${hint}`);
    }
    const data = await resp.json();
    const text = data?.choices?.[0]?.message?.content;
    if (!text) throw new Error('Model AI trả về nội dung rỗng.');
    return text;
  };
}

if (typeof window !== 'undefined') {
  window.AgentToolBridge = {
    buildToolCatalog,
    extractToolCall,
    createAgentExecutor,
    runToolLoop,
    installToolCalling,
    uninstallToolCalling,
    loadToolDefinitions,
    introspectAgentTools
  };
}
