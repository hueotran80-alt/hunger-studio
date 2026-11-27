/**
 * Copilot Guard — chặn code do AI sinh ra khỏi mọi thứ thuộc "dự án":
 * không đọc/ghi storage, không gọi API backend, không đụng DOM khung app,
 * không điều hướng, không eval/Function/import động.
 *
 * Chỉ cho phép thao tác cảnh 3D qua scope được tiêm vào:
 *   studio, sceneManager, THREE, scene, camera, renderer, OrbitControls.
 *
 * Ba lớp bảo vệ:
 *  1. `scanGeneratedCode()` — quét tĩnh trước khi chạy, trả danh sách vi phạm.
 *  2. `createSandboxScope()` — chạy code trong `with (proxy)`; các global nguy hiểm
 *     bị `has/get` chặn nên `fetch`, `localStorage`, `window.location`… không tồn tại.
 *  3. `this` bị buộc về object rỗng, chặn đường thoát qua global object.
 */

/** Luật cấm: `raw: true` = quét trên code còn chuỗi (để bắt URL /api/). */
export const COPILOT_DENY_RULES = [
  { id: 'network.fetch', label: 'gọi mạng (fetch)', re: /\bfetch\s*\(/ },
  { id: 'network.xhr', label: 'XMLHttpRequest', re: /\bXMLHttpRequest\b/ },
  { id: 'network.websocket', label: 'WebSocket', re: /\bWebSocket\b/ },
  { id: 'network.webtransport', label: 'WebTransport', re: /\bWebTransport\b/ },
  { id: 'network.eventsource', label: 'EventSource', re: /\bEventSource\b/ },
  { id: 'network.beacon', label: 'sendBeacon', re: /\bsendBeacon\b/ },
  { id: 'storage.local', label: 'localStorage', re: /\blocalStorage\b/ },
  { id: 'storage.session', label: 'sessionStorage', re: /\bsessionStorage\b/ },
  { id: 'storage.idb', label: 'indexedDB', re: /\bindexedDB\b/ },
  { id: 'storage.caches', label: 'CacheStorage', re: /\bcaches\s*\./ },
  { id: 'storage.cookiestore', label: 'cookieStore', re: /\bcookieStore\b/ },
  { id: 'storage.opfs', label: 'OPFS / FileSystem / Worker', re: /\b(?:showDirectoryPicker|showOpenFilePicker|showSaveFilePicker|BroadcastChannel|MessageChannel|Worker|SharedWorker|ServiceWorker)\b|\.\s*storage\s*\.\s*getDirectory\b/ },
  { id: 'storage.cookie', label: 'document.cookie', re: /\bdocument\s*\.\s*cookie\b/ },
  { id: 'dom.write', label: 'document.write', re: /\bdocument\s*\.\s*(?:write|writeln)\b/ },
  { id: 'dom.body', label: 'sửa DOM khung app', re: /\bdocument\s*\.\s*(?:body|documentElement)\b/ },
  { id: 'dom.script', label: 'chèn script/iframe', re: /\bcreateElement\s*\(\s*['"](?:script|iframe|link)['"]/ },
  {
    id: 'window.danger',
    label: 'truy cập window nguy hiểm',
    re: /\bwindow\s*\.\s*(?:location|open|close|print|stop|history|postMessage|parent|top|opener|frames|localStorage|sessionStorage|indexedDB|fetch|document)\b/
  },
  { id: 'nav.location', label: 'điều hướng location', re: /\blocation\s*\.\s*(?:href|assign|replace|reload)\b/ },
  { id: 'nav.history', label: 'sửa history', re: /\bhistory\s*\.\s*(?:pushState|replaceState|go|back)\b/ },
  { id: 'nav.navigator', label: 'navigator.*', re: /\bnavigator\s*\./ },
  { id: 'code.eval', label: 'eval', re: /\beval\s*\(/ },
  { id: 'code.function', label: 'new Function', re: /\bnew\s+Function\b|\bFunction\s*\(\s*['"`]/ },
  { id: 'code.import', label: 'import động', re: /\bimport\s*\(|\bimportScripts\s*\(/ },
  { id: 'code.require', label: 'require()', re: /\brequire\s*\(/ },
  { id: 'code.ctor', label: 'truy cập .constructor', re: /\.\s*constructor\b/ },
  { id: 'code.proto', label: 'prototype / Proxy escape', re: /__proto__|\bnew\s+Proxy\b|\bObject\s*\.\s*(?:getPrototypeOf|setPrototypeOf|defineProperty)\b/ },
  { id: 'code.reflect', label: 'Reflect.*', re: /\bReflect\s*\./ },
  { id: 'api.endpoint', label: 'gọi API backend', re: /\/api\//, raw: true },
  { id: 'bridge.escape', label: 'thoát qua bridge nội bộ', re: /\b(?:studioBridge|bridgeHub|bridge_hub)\b/ }
];

/** Tên global bị chặn hoàn toàn trong scope của code AI. */
export const SANDBOX_DENIED_GLOBALS = Object.freeze([
  'fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'WebTransport', 'localStorage', 'sessionStorage',
  'indexedDB', 'caches', 'cookieStore', 'navigator', 'location', 'history', 'globalThis', 'self', 'top',
  'parent', 'opener', 'frames', 'Function', 'eval', 'require', 'module', 'process',
  'Worker', 'SharedWorker', 'ServiceWorker', 'BroadcastChannel', 'MessageChannel', 'MessagePort',
  'importScripts', 'postMessage', 'open', 'close', 'Reflect', 'Proxy', 'Blob', 'File', 'FileReader',
  'SharedArrayBuffer', 'Atomics', 'showDirectoryPicker', 'showOpenFilePicker', 'showSaveFilePicker'
]);

const DENIED = new Set(SANDBOX_DENIED_GLOBALS);

/** Bỏ comment, giữ nguyên chuỗi (dùng cho luật `raw`). */
export function stripComments(code) {
  return String(code || '')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:\\])\/\/[^\n]*/g, '$1 ');
}

/** Bỏ comment + thay nội dung chuỗi/template bằng rỗng (dùng cho luật định danh). */
export function stripStrings(code) {
  return stripComments(code)
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/`(?:[^`\\]|\\.)*`/g, '``');
}

/**
 * Quét code AI trước khi thực thi.
 * @returns {{ok: boolean, violations: Array<{id: string, label: string, match: string}>}}
 */
export function scanGeneratedCode(code) {
  const noComments = stripComments(code);
  const noStrings = stripStrings(code);
  const violations = [];
  for (const rule of COPILOT_DENY_RULES) {
    const target = rule.raw ? noComments : noStrings;
    const match = target.match(rule.re);
    if (match) {
      violations.push({ id: rule.id, label: rule.label, match: String(match[0]).trim().slice(0, 80) });
    }
  }
  return { ok: violations.length === 0, violations };
}

/** Câu thông báo thân thiện khi code bị chặn. */
export function describeViolations(violations = []) {
  const labels = [...new Set(violations.map((v) => v.label))];
  return labels.length ? labels.join(', ') : 'hành vi bị chặn';
}

/**
 * Scope an toàn cho code AI: `studio`, `THREE`… có thật; global nguy hiểm vắng mặt.
 * Dùng cùng `with (scope)` để mọi truy cập global đều đi qua proxy.
 */
export function createSandboxScope(ctx = {}) {
  const realWindow = typeof window !== 'undefined' ? window : null;
  const realDocument = typeof document !== 'undefined' ? document : null;
  const safePrint = typeof ctx.print === 'function'
    ? ctx.print
    : (...args) => { try { console.log('[Script]', ...args); } catch (_) {} };
  const resolvedModifiers = ctx.modifiers || (realWindow ? (realWindow.modifiers || realWindow.Modifiers) : null) || null;
  const resolvedModifiersUpper = ctx.Modifiers || resolvedModifiers || (realWindow ? realWindow.Modifiers : null) || null;
  const resolvedEditMode = ctx.editMode || (realWindow ? realWindow.editMode : null) || null;
  const resolvedSculptMode = ctx.sculptMode || (realWindow ? realWindow.sculptMode : null) || null;
  const resolvedSimManager = ctx.simulationManager || (realWindow ? realWindow.simulationManager : null) || null;
  const resolvedStemTutor = ctx.stemTutor || (realWindow ? realWindow.stemTutor : null) || null;
  const resolvedBpy = ctx.bpy || ctx.studio?.bpy || (realWindow ? realWindow.bpy : null) || null;
  const safeSetViewportMode = typeof ctx.setViewportMode === 'function'
    ? ctx.setViewportMode
    : (mode) => {
        if (!realDocument || !mode) return false;
        const sel = realDocument.getElementById('viewport-mode');
        if (sel) {
          sel.value = mode;
          sel.dispatchEvent(new Event('change', { bubbles: true }));
          return true;
        }
        return false;
      };
  const safeSetEditSelectionMode = typeof ctx.setEditSelectionMode === 'function'
    ? ctx.setEditSelectionMode
    : (selMode) => {
        if (resolvedEditMode && typeof resolvedEditMode.setMode === 'function') {
          resolvedEditMode.setMode(selMode);
        }
        if (realDocument && selMode) {
          realDocument.getElementById(`btn-mode-${selMode}`)?.click?.();
        }
        return Boolean(resolvedEditMode);
      };

  const windowFacade = Object.freeze({
    THREE: ctx.THREE || null,
    scene: ctx.scene || null,
    studio: ctx.studio || null,
    sceneManager: ctx.sceneManager || null,
    camera: ctx.camera || null,
    renderer: ctx.renderer || null,
    engine: ctx.engine || (realWindow ? realWindow.engine : null),
    editMode: resolvedEditMode,
    modifiers: resolvedModifiers,
    Modifiers: resolvedModifiersUpper,
    sculptMode: resolvedSculptMode,
    simulationManager: resolvedSimManager,
    stemTutor: resolvedStemTutor,
    bpy: resolvedBpy,
    print: safePrint,
    setViewportMode: safeSetViewportMode,
    setEditSelectionMode: safeSetEditSelectionMode
  });

  const documentFacade = Object.freeze({
    createElement: () => null,
    createElementNS: () => null,
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: () => {},
    removeEventListener: () => {}
  });

  const target = Object.assign(Object.create(null), {
    studio: ctx.studio || null,
    sceneManager: ctx.sceneManager || null,
    THREE: ctx.THREE || null,
    scene: ctx.scene || null,
    camera: ctx.camera || null,
    renderer: ctx.renderer || null,
    OrbitControls: ctx.OrbitControls || null,
    engine: ctx.engine || (realWindow ? realWindow.engine : null),
    editMode: resolvedEditMode,
    modifiers: resolvedModifiers,
    Modifiers: resolvedModifiersUpper,
    sculptMode: resolvedSculptMode,
    simulationManager: resolvedSimManager,
    stemTutor: resolvedStemTutor,
    bpy: resolvedBpy,
    print: safePrint,
    setViewportMode: safeSetViewportMode,
    setEditSelectionMode: safeSetEditSelectionMode,
    window: windowFacade,
    document: documentFacade,
    alert: () => {},
    prompt: () => null,
    confirm: () => false,
    console
  });

  return new Proxy(target, {
    has(store, key) {
      if (typeof key !== 'string') return false;
      if (key === '__proto__' || key === 'constructor') return true;
      if (DENIED.has(key)) return true; // chặn: has=true, get=undefined
      return key in store;
    },
    get(store, key) {
      if (typeof key !== 'string') return undefined;
      if (key === '__proto__' || key === 'constructor') return undefined;
      if (DENIED.has(key)) return undefined;
      return store[key];
    },
    set(store, key, value) {
      if (typeof key === 'string' && key !== '__proto__' && key !== 'constructor' && !DENIED.has(key)) {
        store[key] = value;
      }
      return true;
    }
  });
}

/**
 * Bọc code AI để chạy trong scope an toàn. `this` được buộc về object rỗng
 * (không phải global object) nên `this.fetch` cũng không dùng được.
 */
export function wrapInSandbox(code) {
  return `with (__copilotScope) {\n  return (async () => {\n${code}\n  })();\n}`;
}

/** Tạo hàm thực thi đã sandbox từ constructor AsyncFunction. */
export function compileSandboxed(AsyncFunction, code) {
  return new AsyncFunction('__copilotScope', wrapInSandbox(code));
}
