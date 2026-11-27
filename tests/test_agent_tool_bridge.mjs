/**
 * Unit tests — Agent Tool Bridge (AI Copilot ↔ 68 tool của js/agent/*).
 * Không cần DOM: dùng definitions/agent/chat giả lập đúng hình dạng thật.
 */
import assert from 'node:assert/strict';
import {
  buildToolCatalog,
  extractToolCall,
  createAgentExecutor,
  runToolLoop,
  installToolCalling,
  uninstallToolCalling,
  introspectAgentTools,
  loadToolDefinitions
} from '../js/ai/agent-tool-bridge.js';

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  PASS  ${name}`);
    passed += 1;
  } catch (err) {
    console.error(`  FAIL  ${name}\n        ${err.message}`);
    failed += 1;
  }
}

async function testAsync(name, fn) {
  try {
    await fn();
    console.log(`  PASS  ${name}`);
    passed += 1;
  } catch (err) {
    console.error(`  FAIL  ${name}\n        ${err.message}`);
    failed += 1;
  }
}

const def = (id, extra = {}) => ({
  id,
  description: `Tool ${id} description`,
  argsSchema: { prefixItems: [{ type: 'object' }], minItems: 0 },
  agentCallable: true,
  ...extra
});

const DEFS = [
  def('scene.tree'),
  def('scene.find'),
  def('scene.delete', { argsSchema: { prefixItems: [{ type: 'string' }], minItems: 1 }, requiresConfirm: true }),
  def('scene.fail'),
  def('scene.boom'),
  def('scene.slow'),
  def('material.create', { argsSchema: { prefixItems: [{ type: 'string' }, { type: 'object' }], minItems: 1 } }),
  def('exec'),
  def('assets.pickFile', { browserOnly: true }),
  def('scene.get', { agentCallable: false })
];

function makeAgent() {
  const calls = [];
  const agent = {
    scene: {
      tree: async (options) => {
        calls.push(['scene.tree', options]);
        return { ok: true, data: [{ agentId: 'obj_1', name: 'Cube', type: 'Mesh' }] };
      },
      find: async (query) => {
        calls.push(['scene.find', query]);
        return { ok: true, data: [{ agentId: 'obj_1', name: query?.name || 'Cube' }] };
      },
      delete: async (agentId) => {
        calls.push(['scene.delete', agentId]);
        return { ok: true, data: { agentId, deleted: true } };
      },
      fail: async () => ({ ok: false, error: { code: 'E_NOT_FOUND', message: 'Object missing.' } }),
      boom: async () => {
        throw new Error('kaboom');
      },
      slow: () => new Promise((resolve) => setTimeout(() => resolve({ ok: true, data: 'late' }), 250))
    },
    material: {
      create: async (name, pbr) => {
        calls.push(['material.create', name, pbr]);
        return { ok: true, data: 'mat_1' };
      }
    }
  };
  return { agent, calls };
}

function makeCopilot() {
  return {
    _callProxyAPI: async () => ({ explanation: 'ORIGINAL', code: null }),
    _buildOpenAIMessages: (prompt) => [
      { role: 'system', content: 'BASE SYSTEM' },
      { role: 'user', content: prompt }
    ],
    _parseLLMResponse: (text) => {
      const match = text.match(/```(?:javascript|js)?([\s\S]*?)```/i);
      return {
        explanation: match ? text.replace(match[0], '').trim() : text.trim(),
        code: match ? match[1].trim() : null
      };
    },
    _modelForProvider: () => 'fake-model'
  };
}

console.log('\nAgent Tool Bridge suite');

/* -------------------------------- catalog -------------------------------- */

test('catalog bỏ exec/browserOnly/agentCallable:false và liệt kê đúng tool', () => {
  const catalog = buildToolCatalog(DEFS);
  assert.ok(catalog.ids.includes('scene.tree'));
  assert.ok(catalog.ids.includes('material.create'));
  assert.ok(!catalog.ids.includes('exec'), 'exec bị loại mặc định');
  assert.ok(!catalog.ids.includes('assets.pickFile'));
  assert.ok(!catalog.ids.includes('scene.get'));
  assert.equal(catalog.ids.length, 7);
  assert.match(catalog.text, /scene\.tree\(/);
  assert.match(catalog.text, /DESTRUCTIVE/);
});

test('allowExec + allow/exclude tuỳ chỉnh hoạt động', () => {
  assert.ok(buildToolCatalog(DEFS, { allowExec: true }).ids.includes('exec'));
  const only = buildToolCatalog(DEFS, { allow: ['scene.tree', 'scene.find'] });
  assert.deepEqual(only.ids.sort(), ['scene.find', 'scene.tree']);
  const excluded = buildToolCatalog(DEFS, { exclude: ['scene.error', 'scene.tree'] });
  assert.ok(!excluded.ids.includes('scene.tree'));
});

/* -------------------------------- parsing -------------------------------- */

test('extractToolCall đọc fenced json, JSON trần và tool_calls array', () => {
  const fenced = extractToolCall('```json\n{"tool":"scene.tree","args":[{"compact":true}]}\n```');
  assert.deepEqual(fenced, { tool: 'scene.tree', args: [{ compact: true }] });

  const bare = extractToolCall('{"tool":"scene.find","args":[{"name":"Cube"}]}');
  assert.deepEqual(bare, { tool: 'scene.find', args: [{ name: 'Cube' }] });

  const openai = extractToolCall('{"tool_calls":[{"name":"material.create","arguments":"[\\"Copper\\",{\\"metalness\\":1}]"}]}');
  assert.deepEqual(openai, { tool: 'material.create', args: ['Copper', { metalness: 1 }] });
});

test('extractToolCall chịu được object lồng trong args và chữ bao quanh', () => {
  const text = 'Mình sẽ kiểm tra cảnh.\n```json\n{"tool":"material.create","args":["Glass",{"baseColor":"#fff","ior":1.52}]}\n```\nRồi dựng tiếp.';
  const call = extractToolCall(text);
  assert.equal(call.tool, 'material.create');
  assert.deepEqual(call.args, ['Glass', { baseColor: '#fff', ior: 1.52 }]);
});

test('extractToolCall trả null cho câu trả lời cuối (kể cả {"final":...})', () => {
  assert.equal(extractToolCall('Đây là câu trả lời cuối.\n```javascript\nstudio.addCube({})\n```'), null);
  assert.equal(extractToolCall('{"final":"done"}'), null);
  assert.equal(extractToolCall(''), null);
  assert.equal(extractToolCall('{"broken": '), null);
});

/* -------------------------------- executor ------------------------------- */

await testAsync('executor gọi façade thật với tham số vị trí và trả {ok,data}', async () => {
  const { agent, calls } = makeAgent();
  const catalog = buildToolCatalog(DEFS);
  const executor = createAgentExecutor(agent, { defs: catalog.defs });
  const result = await executor.execute({ tool: 'scene.tree', args: [{ compact: true }] });
  assert.deepEqual(result, { tool: 'scene.tree', ok: true, data: [{ agentId: 'obj_1', name: 'Cube', type: 'Mesh' }] });
  assert.deepEqual(calls[0], ['scene.tree', { compact: true }]);
});

await testAsync('executor chuyển lỗi agent ({ok:false}) thành kết quả ok:false', async () => {
  const { agent } = makeAgent();
  const executor = createAgentExecutor(agent, { defs: buildToolCatalog(DEFS).defs });
  const result = await executor.execute({ tool: 'scene.fail', args: [] });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'E_NOT_FOUND');
});

await testAsync('executor bắt exception của agent thành E_TOOL', async () => {
  const { agent } = makeAgent();
  const executor = createAgentExecutor(agent, { defs: buildToolCatalog(DEFS).defs });
  const result = await executor.execute({ tool: 'scene.boom', args: [] });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'E_TOOL');
  assert.match(result.error.message, /kaboom/);
});

await testAsync('executor timeout tool chậm', async () => {
  const { agent } = makeAgent();
  const executor = createAgentExecutor(agent, { defs: buildToolCatalog(DEFS).defs, timeoutMs: 30 });
  const result = await executor.execute({ tool: 'scene.slow', args: [] });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'E_TIMEOUT');
});

await testAsync('tool phá huỷ bị chặn khi không có approve', async () => {
  const { agent, calls } = makeAgent();
  const executor = createAgentExecutor(agent, { defs: buildToolCatalog(DEFS).defs });
  const result = await executor.execute({ tool: 'scene.delete', args: ['obj_1'] });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'E_CONFIRM_REQUIRED');
  assert.equal(calls.length, 0, 'không được gọi agent khi chưa xác nhận');
});

await testAsync('tool phá huỷ chạy khi approve trả true', async () => {
  const { agent, calls } = makeAgent();
  const seen = [];
  const executor = createAgentExecutor(agent, {
    defs: buildToolCatalog(DEFS).defs,
    approve: async (info) => {
      seen.push(info);
      return true;
    }
  });
  const result = await executor.execute({ tool: 'scene.delete', args: ['obj_1'] });
  assert.equal(result.ok, true);
  assert.deepEqual(result.data, { agentId: 'obj_1', deleted: true });
  assert.equal(seen[0].tool, 'scene.delete');
  assert.deepEqual(seen[0].args, ['obj_1']);
  assert.equal(calls.length, 1);
});

await testAsync('tool không tồn tại -> E_UNKNOWN_TOOL; quá nhiều args -> E_INVALID_ARG', async () => {
  const { agent } = makeAgent();
  const executor = createAgentExecutor(agent, { defs: buildToolCatalog(DEFS).defs });
  const unknown = await executor.execute({ tool: 'scene.nope', args: [] });
  assert.equal(unknown.error.code, 'E_UNKNOWN_TOOL');

  const tooMany = await executor.execute({ tool: 'scene.tree', args: [1, 2, 3, 4, 5, 6, 7] });
  assert.equal(tooMany.error.code, 'E_INVALID_ARG');
});

/* ---------------------------------- loop --------------------------------- */

await testAsync('loop: tool call -> TOOL_RESULT -> câu trả lời cuối kèm code', async () => {
  const { agent, calls } = makeAgent();
  const catalog = buildToolCatalog(DEFS);
  const executor = createAgentExecutor(agent, { defs: catalog.defs });
  const seen = [];
  const replies = [
    '```json\n{"tool":"scene.tree","args":[{"compact":true}]}\n```',
    'Đã kiểm tra cảnh.\n```javascript\nstudio.addCube({ name: "RedCube", color: "#ff0000" })\n```'
  ];

  const loop = await runToolLoop({
    chat: async (messages) => {
      seen.push(messages);
      return replies.shift();
    },
    messages: [{ role: 'system', content: 'SYS' }, { role: 'user', content: 'kiểm tra cảnh' }],
    catalog,
    executor,
    maxSteps: 4
  });

  assert.equal(loop.steps, 2);
  assert.equal(loop.toolCalls.length, 1);
  assert.equal(loop.toolCalls[0].tool, 'scene.tree');
  assert.equal(loop.observations[0].ok, true);
  assert.match(loop.text, /studio\.addCube/);
  assert.equal(calls.length, 1);

  const protocolInjected = seen[0][0].content;
  assert.match(protocolInjected, /AGENT TOOL PROTOCOL/);
  assert.match(protocolInjected, /scene\.tree/);

  const toolResultMessage = seen[1].at(-1);
  assert.equal(toolResultMessage.role, 'user');
  assert.match(toolResultMessage.content, /^TOOL_RESULT /);
  const payload = JSON.parse(toolResultMessage.content.slice('TOOL_RESULT '.length));
  assert.equal(payload.tool, 'scene.tree');
  assert.equal(payload.ok, true);
});

await testAsync('loop dừng ở maxSteps và báo E_MAX_STEPS', async () => {
  const { agent } = makeAgent();
  const executor = createAgentExecutor(agent, { defs: buildToolCatalog(DEFS).defs });
  const loop = await runToolLoop({
    chat: async () => '```json\n{"tool":"scene.tree","args":[{}]}\n```',
    messages: [{ role: 'user', content: 'loop mãi' }],
    catalog: buildToolCatalog(DEFS),
    executor,
    maxSteps: 3
  });
  assert.equal(loop.steps, 3);
  assert.equal(loop.error, 'E_MAX_STEPS');
  assert.equal(loop.observations.length, 3);
});

await testAsync('loop vẫn chạy tiếp khi tool lỗi (observation ok:false)', async () => {
  const { agent } = makeAgent();
  const executor = createAgentExecutor(agent, { defs: buildToolCatalog(DEFS).defs });
  const replies = [
    '```json\n{"tool":"scene.fail","args":[]}\n```',
    'Không tìm thấy object, mình sẽ dùng scene.find.\n```javascript\nstudio.addCube({})\n```'
  ];
  const loop = await runToolLoop({
    chat: async () => replies.shift(),
    messages: [{ role: 'user', content: 'test' }],
    catalog: buildToolCatalog(DEFS),
    executor,
    maxSteps: 4
  });
  assert.equal(loop.observations[0].ok, false);
  assert.match(loop.text, /scene\.find/);
});

/* ------------------------------- install -------------------------------- */

await testAsync('installToolCalling: chạy tool thật rồi trả {explanation, code}; uninstall phục hồi', async () => {
  const { agent, calls } = makeAgent();
  const copilot = makeCopilot();
  const original = copilot._callProxyAPI;

  const handle = await installToolCalling(copilot, {
    agent,
    definitions: DEFS,
    maxSteps: 4,
    transport: async (messages) => {
      const hasResult = messages.some((m) => typeof m.content === 'string' && m.content.startsWith('TOOL_RESULT'));
      if (!hasResult) return '```json\n{"tool":"scene.tree","args":[{"compact":true}]}\n```';
      return 'Xong.\n```javascript\nstudio.addCube({ name: "BridgeCube" })\n```';
    }
  });

  assert.ok(handle.ids.includes('scene.tree'));
  const parsed = await copilot._callProxyAPI('motapis', 'kiểm tra cảnh rồi dựng cube');
  assert.match(parsed.explanation, /Xong/);
  assert.match(parsed.code, /studio\.addCube/);
  assert.equal(calls.length, 1, 'tool đã chạy qua agent thật');

  uninstallToolCalling(copilot);
  assert.equal(copilot._callProxyAPI, original);
  const restored = await copilot._callProxyAPI('motapis', 'x');
  assert.equal(restored.explanation, 'ORIGINAL');
});

await testAsync('installToolCalling: thiếu agent -> lỗi rõ ràng; gọi 2 lần trả cùng handle', async () => {
  const copilot = makeCopilot();
  await assert.rejects(
    () => installToolCalling(copilot, { agent: null, definitions: DEFS, transport: async () => 'x' }),
    /agent API chưa sẵn sàng/
  );

  const { agent } = makeAgent();
  const first = await installToolCalling(copilot, { agent, definitions: DEFS, transport: async () => 'ok' });
  const second = await installToolCalling(copilot, { agent, definitions: DEFS, transport: async () => 'ok' });
  assert.equal(first, second);
  uninstallToolCalling(copilot);
});

test('introspectAgentTools sinh catalog tối thiểu từ façade agent', () => {
  const { agent } = makeAgent();
  const defs = introspectAgentTools(agent);
  const ids = defs.map((entry) => entry.id).sort();
  assert.ok(ids.includes('scene.tree'));
  assert.ok(ids.includes('material.create'));
  assert.ok(!ids.includes('scene.calls'), 'chỉ lấy function');
  const catalog = buildToolCatalog(defs);
  assert.ok(catalog.ids.includes('scene.find'));
});

await testAsync('loadToolDefinitions fallback về introspection khi manifest không nạp được', async () => {
  const { agent } = makeAgent();
  const defs = await loadToolDefinitions({ agent });
  assert.ok(Array.isArray(defs) && defs.length > 0);
  assert.ok(defs.some((def) => def.id === 'scene.tree'));
});

await testAsync('installToolCalling: exec bị chặn tuyệt đối kể cả khi xin allowExec', async () => {
  const { agent } = makeAgent();
  const copilot = makeCopilot();
  const handle = await installToolCalling(copilot, {
    agent,
    definitions: DEFS,
    allowExec: true,
    transport: async () => 'ok'
  });
  assert.equal(handle.ids.includes('exec'), false, 'Copilot không được chạy JS tuỳ ý');
  assert.equal(handle.execBlocked, true);
  assert.equal(handle.policy, 'copilot-scene-only');
  uninstallToolCalling(copilot);
});

await testAsync('defaultTransport báo lỗi rõ khi fetch(/api/ai/chat) mất kết nối', async () => {
  const { agent } = makeAgent();
  const copilot = makeCopilot();
  const prevFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new TypeError('Failed to fetch');
  };
  try {
    await installToolCalling(copilot, { agent, definitions: DEFS });
    await assert.rejects(
      () => copilot._callProxyAPI('motapis', 'hi'),
      /\/api\/ai\/chat.*server\.py/
    );
  } finally {
    uninstallToolCalling(copilot);
    globalThis.fetch = prevFetch;
  }
});

await testAsync('extractToolCall bỏ thẻ <think> trước khi tìm JSON tool call', async () => {
  const raw = '<think>Mình cần xem cây cảnh trước\n```json\n{"tool":"fake"}\n```\n</think>\n```json\n{"tool":"scene.tree","args":[{"compact":true}]}\n```';
  const call = extractToolCall(raw);
  assert.deepEqual(call, { tool: 'scene.tree', args: [{ compact: true }] });
});

await testAsync('runToolLoop dừng ngay bằng AbortError khi AbortSignal bị huỷ', async () => {
  const { agent } = makeAgent();
  const catalog = buildToolCatalog(DEFS);
  const executor = createAgentExecutor(agent, { defs: catalog.defs });
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(
    () => runToolLoop({
      chat: async () => 'should not run',
      messages: [{ role: 'user', content: 'hi' }],
      catalog,
      executor,
      signal: ac.signal
    }),
    (err) => err?.name === 'AbortError'
  );
});

await testAsync('defaultTransport định tuyến qua /api/cloud/ai/chat + Bearer + BYOK khi đã đăng nhập Cloud', async () => {
  const { agent } = makeAgent();
  const copilot = makeCopilot();
  copilot._getByokKey = () => 'sk-test-byok';
  const prevWindow = globalThis.window;
  const prevFetch = globalThis.fetch;
  let capturedUrl = '';
  let capturedHeaders = {};
  globalThis.window = {
    cloudClient: {
      isSignedIn: () => true,
      _ensureFresh: async () => {},
      session: { accessToken: 'tok_cloud_123' },
      absoluteUrl: (p) => `http://127.0.0.1:8080${p}`
    }
  };
  globalThis.fetch = async (url, init) => {
    capturedUrl = url;
    capturedHeaders = init.headers;
    return {
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'Xong!' } }] })
    };
  };
  try {
    await installToolCalling(copilot, { agent, definitions: DEFS });
    const out = await copilot._callProxyAPI('motapis', 'hi');
    assert.equal(out.explanation, 'Xong!');
    assert.equal(capturedUrl, 'http://127.0.0.1:8080/api/cloud/ai/chat');
    assert.equal(capturedHeaders.Authorization, 'Bearer tok_cloud_123');
    assert.equal(capturedHeaders['X-AI-Provider-Key'], 'sk-test-byok');
  } finally {
    uninstallToolCalling(copilot);
    globalThis.fetch = prevFetch;
    if (prevWindow === undefined) delete globalThis.window;
    else globalThis.window = prevWindow;
  }
});

await testAsync('onConfirmedDestructive xử lý E_NEEDS_CONFIRM sau khi approve() đã trả true', async () => {
  const { agent } = makeAgent();
  agent.scene.clear = async () => ({
    ok: false,
    error: { code: 'E_NEEDS_CONFIRM', message: 'Clear scene' }
  });
  let fallbackCalls = 0;
  const executor = createAgentExecutor(agent, {
    defs: buildToolCatalog([def('scene.clear', { requiresConfirm: true })]).defs,
    approve: async () => true,
    onConfirmedDestructive: async (toolId) => {
      if (toolId === 'scene.clear') {
        fallbackCalls += 1;
        return { cleared: true };
      }
      return null;
    }
  });
  const res = await executor.execute({ tool: 'scene.clear', args: [] });
  assert.equal(res.ok, true);
  assert.deepEqual(res.data, { cleared: true });
  assert.equal(fallbackCalls, 1);
});

console.log(`\nSummary: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
