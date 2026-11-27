/**
 * Web Blender Studio — embed/share protocol (no DOM, no Three.js).
 *
 * A share link carries the exported .glb either as a normal URL (`?glb=...`)
 * or compressed inside the URL fragment (`#z=...`). Fragments are never sent
 * to the server, so the model stays client-side.
 */

export const EMBED_PAGE = 'embed.html';
export const MAX_SHARE_BYTES = 96 * 1024;
export const WARN_SHARE_BYTES = 64 * 1024;

export const DEFAULT_OPTIONS = Object.freeze({
  autoplay: true,
  loop: true,
  controls: true,
  ui: true,
  grid: true,
  shadow: true,
  autorotate: false,
  transparent: false,
  bg: '#1b1b1b',
  badge: true,
  fit: true,
  dpr: 0,
  clip: ''
});

const URL_PARAM_ALIASES = ['glb', 'model', 'url', 'src'];
const MAX_SRC_LENGTH = 2048;
const MAX_CLIP_LENGTH = 128;

function parseBool(value, fallback) {
  if (value === null || value === undefined) return fallback;
  const v = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(v)) return true;
  if (['0', 'false', 'no', 'off'].includes(v)) return false;
  return fallback;
}

function clampNumber(value, min, max, fallback) {
  if (value === null || value === undefined || value === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/**
 * Normalizes a user-supplied model URL. Allows http(s), blob and same-origin
 * relative paths; rejects script-capable schemes.
 * @param {string|null|undefined} value
 * @returns {string|null}
 */
export function sanitizeModelUrl(value, options = {}) {
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  if (!raw || raw.length > MAX_SRC_LENGTH) return null;
  if (/[\u0000-\u001f\u007f]/.test(raw)) return null;
  // Block protocol-relative URLs (//host/...) to prevent scheme confusion & external origin leaks
  if (raw.startsWith('//')) return null;

  const lower = raw.toLowerCase();
  if (lower.startsWith('javascript:') || lower.startsWith('vbscript:') || lower.startsWith('data:text/html')) {
    return null;
  }
  const pageProtocol = options.pageProtocol ?? (typeof globalThis !== 'undefined' ? globalThis.location?.protocol : undefined);
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) {
    try {
      const parsed = new URL(raw);
      if (!['http:', 'https:', 'blob:'].includes(parsed.protocol)) return null;
      if (pageProtocol === 'https:' && parsed.protocol === 'http:') return null;
      return parsed.href;
    } catch (_) {
      return null;
    }
  }
  return raw;
}

/**
 * Parses a hex color (`#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`) into `{ hex: '#rrggbb', alpha: 0..1 }`,
 * because `THREE.Color` rejects 4- and 8-digit CSS hex strings with alpha channels.
 * @param {string|null|undefined} value
 * @returns {{ hex: string, alpha: number } | null}
 */
export function normalizeHexColor(value) {
  if (typeof value !== 'string') return null;
  const v = value.trim().toLowerCase();
  if (!v || v === 'transparent' || v === 'none') return null;
  const raw = v.startsWith('#') ? v.slice(1) : v;
  if (!/^(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/.test(raw)) return null;
  if (raw.length === 3 || raw.length === 4) {
    const r = raw[0] + raw[0];
    const g = raw[1] + raw[1];
    const b = raw[2] + raw[2];
    const alpha = raw.length === 4 ? parseInt(raw[3] + raw[3], 16) / 255 : 1;
    return { hex: `#${r}${g}${b}`, alpha };
  }
  const hex = `#${raw.slice(0, 6)}`;
  const alpha = raw.length === 8 ? parseInt(raw.slice(6, 8), 16) / 255 : 1;
  return { hex, alpha };
}

/**
 * @param {string|null|undefined} value
 * @returns {string|null} `#rrggbb`, `#rgb`, `#rrggbbaa` or `transparent`
 */
export function sanitizeBackground(value) {
  if (typeof value !== 'string') return null;
  const v = value.trim().toLowerCase();
  if (v === 'transparent' || v === 'none') return 'transparent';
  const hex = v.startsWith('#') ? v : `#${v}`;
  if (/^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/.test(hex)) return hex;
  return null;
}

function sanitizeClipName(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, MAX_CLIP_LENGTH);
}

/**
 * Reads viewer options from a URLSearchParams-like object.
 * @param {URLSearchParams} params
 * @param {Partial<typeof DEFAULT_OPTIONS>} [defaults]
 */
export function readEmbedOptions(params, defaults = DEFAULT_OPTIONS) {
  const base = { ...DEFAULT_OPTIONS, ...defaults };
  const bgRaw = params.get('bg');
  const bg = sanitizeBackground(bgRaw);
  const transparent = parseBool(params.get('transparent'), bg === 'transparent' || base.transparent);
  return {
    autoplay: parseBool(params.get('autoplay'), base.autoplay),
    loop: parseBool(params.get('loop'), base.loop),
    controls: parseBool(params.get('controls'), base.controls),
    ui: parseBool(params.get('ui'), base.ui),
    grid: parseBool(params.get('grid'), base.grid),
    shadow: parseBool(params.get('shadow'), base.shadow),
    autorotate: parseBool(params.get('autorotate'), base.autorotate),
    transparent,
    bg: transparent ? 'transparent' : (bg || base.bg),
    badge: parseBool(params.get('badge'), base.badge),
    fit: parseBool(params.get('fit'), base.fit),
    dpr: clampNumber(params.get('dpr'), 0.5, 2, base.dpr),
    clip: sanitizeClipName(params.get('clip'))
  };
}

/**
 * Parses a location's query + hash into a viewer configuration.
 * `src` wins over an inline payload only when both are present.
 * @param {string} search e.g. `?glb=/a.glb&grid=0`
 * @param {string} hash e.g. `#z=H4sIA...`
 */
export function parseEmbedLocation(search = '', hash = '') {
  const params = new URLSearchParams(search || '');
  let src = null;
  for (const key of URL_PARAM_ALIASES) {
    const candidate = sanitizeModelUrl(params.get(key));
    if (candidate) { src = candidate; break; }
  }

  const hashParams = new URLSearchParams(String(hash || '').replace(/^#/, ''));
  const payload = hashParams.get('z') || params.get('z') || params.get('data') || '';
  const options = readEmbedOptions(params);
  if (!src && !payload) {
    return { src: null, payload: '', options, error: 'missing-source' };
  }
  return { src, payload, options, error: null };
}

function bytesToBase64(bytes) {
  const chunk = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function base64ToBytes(text) {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function toBase64Url(text) {
  return text.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function fromBase64Url(text) {
  const padded = text.replace(/-/g, '+').replace(/_/g, '/');
  return padded + '='.repeat((4 - (padded.length % 4)) % 4);
}

async function transformBytes(bytes, transform) {
  const source = new Blob([bytes]).stream();
  const response = new Response(source.pipeThrough(transform));
  return new Uint8Array(await response.arrayBuffer());
}

/**
 * Encodes model bytes as `z<gzip-base64url>` (or `r<raw-base64url>` when
 * compression is unavailable or larger than the input).
 * @param {Uint8Array|ArrayBuffer} input
 * @returns {Promise<string>}
 */
export async function encodeSharePayload(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (!bytes.byteLength) throw new Error('Empty model payload');
  if (typeof CompressionStream === 'function') {
    try {
      const gz = await transformBytes(bytes, new CompressionStream('gzip'));
      if (gz.byteLength + 8 < bytes.byteLength) {
        return `z${toBase64Url(bytesToBase64(gz))}`;
      }
    } catch (_) {
      // Fall through to raw base64url.
    }
  }
  return `r${toBase64Url(bytesToBase64(bytes))}`;
}

/**
 * @param {string} payload
 * @param {{gunzip?: (bytes: Uint8Array) => Uint8Array}} [fallbacks]
 * @returns {Promise<Uint8Array>}
 */
export async function decodeSharePayload(payload, fallbacks = {}) {
  if (typeof payload !== 'string' || payload.length < 2) {
    throw new Error('Empty share payload');
  }
  const flag = payload[0];
  const body = payload.slice(1);
  if (!/^[A-Za-z0-9_-]+$/.test(body)) throw new Error('Invalid share payload');
  const bytes = base64ToBytes(fromBase64Url(body));
  if (flag === 'z') {
    if (typeof DecompressionStream === 'function') {
      return transformBytes(bytes, new DecompressionStream('gzip'));
    }
    if (typeof fallbacks.gunzip === 'function') {
      const out = fallbacks.gunzip(bytes);
      return out instanceof Uint8Array ? out : new Uint8Array(out);
    }
    throw new Error('gzip is not supported in this browser');
  }
  if (flag === 'r') return bytes;
  throw new Error('Unknown share payload format');
}

/**
 * Serializes only non-default options to keep links short.
 * @param {Partial<typeof DEFAULT_OPTIONS>} options
 * @returns {URLSearchParams}
 */
export function serializeEmbedOptions(options = {}) {
  const o = { ...DEFAULT_OPTIONS, ...options };
  const params = new URLSearchParams();
  if (o.autoplay === false) params.set('autoplay', '0');
  if (o.loop === false) params.set('loop', '0');
  if (o.controls === false) params.set('controls', '0');
  if (o.ui === false) params.set('ui', '0');
  if (o.grid === false) params.set('grid', '0');
  if (o.shadow === false) params.set('shadow', '0');
  if (o.autorotate === true) params.set('autorotate', '1');
  if (o.transparent === true) params.set('transparent', '1');
  if (o.badge === false) params.set('badge', '0');
  if (o.fit === false) params.set('fit', '0');
  if (Number(o.dpr) && Number(o.dpr) !== DEFAULT_OPTIONS.dpr) params.set('dpr', String(o.dpr));
  const bg = sanitizeBackground(o.bg);
  if (bg && bg !== 'transparent' && bg !== DEFAULT_OPTIONS.bg) params.set('bg', bg);
  const clip = sanitizeClipName(o.clip);
  if (clip) params.set('clip', clip);
  return params;
}

/**
 * Builds a viewer URL that points at a hosted model.
 * @param {string} baseUrl absolute URL of embed.html
 * @param {string} modelUrl http(s) URL of the .glb
 * @param {Partial<typeof DEFAULT_OPTIONS>} [options]
 */
export function buildHostedEmbedUrl(baseUrl, modelUrl, options) {
  const safeModel = sanitizeModelUrl(modelUrl);
  if (!safeModel || !/^https?:/i.test(safeModel)) {
    throw new Error('Model URL must be http(s)');
  }
  const url = new URL(baseUrl);
  url.hash = '';
  url.search = '';
  url.searchParams.set('glb', safeModel);
  for (const [key, value] of serializeEmbedOptions(options)) url.searchParams.set(key, value);
  return url.toString();
}

/**
 * Builds a viewer URL with the model compressed into the fragment.
 * @param {string} baseUrl absolute URL of embed.html
 * @param {string} payload output of encodeSharePayload()
 * @param {Partial<typeof DEFAULT_OPTIONS>} [options]
 */
export function buildShareUrl(baseUrl, payload, options) {
  if (typeof payload !== 'string' || !payload) throw new Error('Missing share payload');
  const url = new URL(baseUrl);
  const query = serializeEmbedOptions(options).toString();
  url.search = query ? `?${query}` : '';
  url.hash = `z=${payload}`;
  return url.toString();
}

/**
 * @param {string} url
 * @param {{title?:string,width?:number|string,height?:number|string}} [options]
 */
export function buildIframeSnippet(url, options = {}) {
  if (typeof url !== 'string' || !url) throw new Error('Missing embed URL');
  const title = String(options.title || 'Hunger 3D model').replace(/&/g, '&amp;').replace(/"/g, '&quot;');
  const width = String(options.width || '100%').replace(/"/g, '');
  const height = String(options.height || 480).replace(/"/g, '');
  const src = url.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
  return `<iframe src="${src}" width="${width}" height="${height}" title="${title}" ` +
    'frameborder="0" loading="lazy" allow="autoplay; fullscreen" allowfullscreen></iframe>';
}

/**
 * Approximate decoded byte length of a base64url payload body.
 * @param {string} payload
 */
export function payloadByteLength(payload) {
  if (typeof payload !== 'string' || payload.length < 2) return 0;
  return Math.floor(((payload.length - 1) * 3) / 4);
}

/**
 * Explains whether a payload fits inside a practical address-bar limit.
 * @param {number} bytes compressed payload byte length (approx)
 */
export function shareSizeVerdict(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return { level: 'ok', bytes: 0 };
  if (bytes > MAX_SHARE_BYTES) return { level: 'too-large', bytes };
  if (bytes > WARN_SHARE_BYTES) return { level: 'warn', bytes };
  return { level: 'ok', bytes };
}

export function utf8ByteLength(text) {
  if (typeof TextEncoder === 'function') return new TextEncoder().encode(String(text)).length;
  return String(text).length;
}

/**
 * True when index.html was opened with `?view=embed`, so it should hand off
 * to the light viewer instead of booting the full editor.
 * @param {string} search
 */
export function isEmbedRedirect(search = '') {
  const params = new URLSearchParams(search || '');
  const view = String(params.get('view') || '').toLowerCase();
  return view === 'embed' || view === 'viewer';
}

/**
 * Chooses an animation clip by exact name, then case-insensitive contains,
 * then the longest clip.
 * @param {Array<{name?:string,duration?:number}>} clips
 * @param {string} [wanted]
 */
export function pickAnimationClip(clips, wanted) {
  if (!Array.isArray(clips) || clips.length === 0) return null;
  const name = sanitizeClipName(wanted);
  if (name) {
    const exact = clips.find((clip) => clip && clip.name === name);
    if (exact) return exact;
    const lower = name.toLowerCase();
    const partial = clips.find((clip) => clip && String(clip.name || '').toLowerCase().includes(lower));
    if (partial) return partial;
  }
  return clips.reduce((best, clip) => (
    (clip && Number(clip.duration) || 0) > (best && Number(best.duration) || 0) ? clip : best
  ), clips[0]);
}
