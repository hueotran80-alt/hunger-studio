/**
 * Hunger 3D Studio — Serverless Cloud BFF, Billing & AI Proxy for Cloudflare Workers
 *
 * Runs 100% on Cloudflare Workers + R2 (`HUNGER_ASSETS`) + Supabase Postgres/Auth
 * with zero separate Python/VPS server required.
 *
 * Required Cloudflare Worker Secrets (set via `cf` / `wrangler secret put`):
 *   - SUPABASE_SERVICE_KEY  (server-only; never exposed to browser)
 * Optional Secrets:
 *   - GEMINI_API_KEY, MOTAPIS_API_KEY, OPENAI_API_KEY
 *   - SEPAY_WEBHOOK_SECRET, SEPAY_API_KEY, LEMONSQUEEZY_API_KEY, LEMONSQUEEZY_SIGNING_SECRET
 */

import { getBridgeConnectedCount } from './mcp-endpoint.js';

const COMMUNITY_CATEGORIES = Object.freeze([
  'environments', 'vegetation', 'materials', 'architecture', 'characters', 'props', 'scenes',
  'vehicles', 'nature', 'furniture', 'scifi', 'other',
]);
const AI_RATE_BUCKETS = new Map();

function checkEdgeRateLimit(request, env, scope = 'ai', user = null) {
  const limit = Math.max(1, parseIntEnv(env?.AI_RATE_LIMIT_PER_MIN, 30));
  const windowMs = 60_000;
  const now = Date.now();
  const ip = request.headers.get('cf-connecting-ip')
    || (request.headers.get('x-forwarded-for') || '').split(',')[0].trim()
    || 'anon';
  const key = `${scope}:${user?.id || ip}`;
  let bucket = AI_RATE_BUCKETS.get(key);
  if (!bucket || now - bucket.windowStart >= windowMs) {
    bucket = { windowStart: now, count: 0 };
  }
  bucket.count += 1;
  AI_RATE_BUCKETS.set(key, bucket);
  if (AI_RATE_BUCKETS.size > 4000) {
    for (const [k, b] of AI_RATE_BUCKETS) {
      if (now - b.windowStart >= windowMs) AI_RATE_BUCKETS.delete(k);
    }
  }
  if (bucket.count > limit) {
    const retryAfterSec = Math.max(1, Math.ceil((windowMs - (now - bucket.windowStart)) / 1000));
    throw new CloudError(
      'E_RATE_LIMIT',
      `Bạn đã vượt giới hạn ${limit} lượt/phút. Vui lòng thử lại sau ${retryAfterSec} giây.`,
      429,
      `Retry-After: ${retryAfterSec}s`
    );
  }
}
const FREE_TIER_MODELS = Object.freeze({
  motapis: [
    'claude-sonnet-4-6', 'claude-sonnet-5-5', 'gpt-6-luna', 'gpt-6-astra', 'gpt-5.6-sol',
    'deepseek-v4-flash', 'DeepSeek-V4-Flash-0731', 'deepseek-v4.1-flash-1017',
    'gemini-4-hydrogen', 'grok-4.5', 'glm-5.3-flash', 'minimax-m3', 'minimax-m2.7',
    'kimi-k3.1-pro', 'hy4-preview',
  ],
  gemini: [
    'gemini-3.5-flash-lite', 'gemini-3-flash-preview', 'gemini-3.1-flash-lite',
    'gemini-3.1-flash-lite-preview', 'gemini-3.8-flash', 'gemma-4-31b-it',
  ],
});
const DEFAULT_PLANS = Object.freeze([
  { id: 'starter', label: 'Starter', credits: 300, priceVnd: 69000 },
  { id: 'pro', label: 'Pro', credits: 1200, priceVnd: 199000 },
  { id: 'studio', label: 'Studio', credits: 4000, priceVnd: 499000 },
]);
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const ROUTE_PROJECT = /^\/api\/cloud\/projects\/([A-Za-z0-9_-]{8,64})(\/delete)?$/;
const ROUTE_ASSET = /^\/api\/cloud\/assets\/([A-Za-z0-9_-]{8,64})(\/delete|\/download)?$/;
const ROUTE_PUBLIC_ASSET = /^\/api\/cloud\/public\/assets\/([A-Za-z0-9_-]{8,64})$/;
const ROUTE_PUBLIC_THUMB = /^\/api\/cloud\/public\/thumbs\/([A-Za-z0-9_-]{8,64})$/;
const ROUTE_PAYMENT = /^\/api\/cloud\/payments\/(WBS[A-Z0-9]{8})$/;
const SEPAY_CODE_RE = /(WBS[A-Z0-9]{8})/i;
const SAFE_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const SAFE_BANK_RE = /^[A-Za-z0-9_-]{1,40}$/;
const SAFE_ACCOUNT_RE = /^[A-Za-z0-9]{4,40}$/;

class CloudError extends Error {
  constructor(code, message, status = 400, hint = '') {
    super(message);
    this.code = code;
    this.status = status;
    this.hint = hint;
  }
  toResponse() {
    return jsonResponse(
      { success: false, error: { code: this.code, message: this.message, hint: this.hint } },
      this.status,
      { 'Cache-Control': 'no-store' },
    );
  }
}

function jsonResponse(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
      ...extraHeaders,
    },
  });
}

function parseIntEnv(val, fallback) {
  if (val === undefined || val === null || val === '') return fallback;
  const n = Number.parseInt(String(val), 10);
  return Number.isFinite(n) ? n : fallback;
}

function getConfig(env = {}) {
  const supabaseUrl = String(env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
  const supabaseAnonKey = String(env.SUPABASE_ANON_KEY || '').trim();
  const supabaseServiceKey = String(env.SUPABASE_SERVICE_KEY || '').trim();
  const costs = {
    save_project: Math.max(0, parseIntEnv(env.COST_SAVE_PROJECT, 0)),
    upload_asset: Math.max(0, parseIntEnv(env.COST_UPLOAD_ASSET, 0)),
    ai_chat: Math.max(0, parseIntEnv(env.COST_AI_CHAT, 0)),
  };
  const sepayBank = String(env.SEPAY_BANK || '').trim();
  const sepayAccount = String(env.SEPAY_ACCOUNT || '').trim();
  const sepayHolder = String(env.SEPAY_HOLDER || '').trim();
  const sepayWebhookSecret = String(env.SEPAY_WEBHOOK_SECRET || '').trim();
  const sepayApiKey = String(env.SEPAY_API_KEY || '').trim();
  const lemonApiKey = String(env.LEMONSQUEEZY_API_KEY || '').trim();
  const lemonStoreId = String(env.LEMONSQUEEZY_STORE_ID || '').trim();
  const lemonSigningSecret = String(env.LEMONSQUEEZY_SIGNING_SECRET || '').trim();
  const lemonVariants = {
    starter: String(env.LEMONSQUEEZY_VARIANT_STARTER || '').trim(),
    pro: String(env.LEMONSQUEEZY_VARIANT_PRO || '').trim(),
    studio: String(env.LEMONSQUEEZY_VARIANT_STUDIO || '').trim(),
  };
  const sepayReady = Boolean(
    SAFE_BANK_RE.test(sepayBank) && SAFE_ACCOUNT_RE.test(sepayAccount) && (sepayWebhookSecret || sepayApiKey),
  );
  const lemonReady = Boolean(
    lemonApiKey && lemonStoreId && lemonSigningSecret && Object.values(lemonVariants).some(Boolean),
  );
  return {
    enabled: Boolean(supabaseUrl && supabaseAnonKey && supabaseServiceKey),
    supabaseUrl,
    supabaseAnonKey,
    supabaseServiceKey,
    assetBucket: String(env.SUPABASE_ASSET_BUCKET || 'shared-models').trim(),
    freeCredits: Math.max(0, parseIntEnv(env.FREE_CREDITS, 100)),
    maxProjectBytes: parseIntEnv(env.MAX_PROJECT_BYTES, 16 * 1024 * 1024),
    maxAssetBytes: parseIntEnv(env.MAX_ASSET_BYTES, 50 * 1024 * 1024),
    maxProjects: parseIntEnv(env.MAX_PROJECTS, 100),
    maxAssets: parseIntEnv(env.MAX_ASSETS, 500),
    maxTotalBytes: parseIntEnv(env.MAX_TOTAL_BYTES, 512 * 1024 * 1024),
    paymentTtlSeconds: parseIntEnv(env.PAYMENT_TTL_SECONDS, 1800),
    sessionTtlSeconds: parseIntEnv(env.SESSION_TTL_SECONDS, 7 * 24 * 3600),
    allowTestBilling: String(env.ALLOW_TEST_BILLING || '').toLowerCase() === 'true',
    costs,
    plans: DEFAULT_PLANS,
    sepay: { bank: sepayBank, account: sepayAccount, holder: sepayHolder, webhookSecret: sepayWebhookSecret, apiKey: sepayApiKey, qrTemplate: String(env.SEPAY_QR_TEMPLATE || 'compact2').trim(), ready: sepayReady },
    lemon: { apiKey: lemonApiKey, storeId: lemonStoreId, signingSecret: lemonSigningSecret, variants: lemonVariants, ready: lemonReady },
  };
}

function getCookie(request, name) {
  const raw = request.headers.get('cookie') || '';
  for (const part of raw.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const k = part.slice(0, idx).trim();
    if (k === name) return decodeURIComponent(part.slice(idx + 1).trim());
  }
  return '';
}

function isSecureRequest(request, url) {
  return url.protocol === 'https:' || (request.headers.get('x-forwarded-proto') || '').toLowerCase() === 'https';
}

function buildSessionCookie(token, maxAge, secure) {
  const parts = [`wbs_session=${encodeURIComponent(token)}`, `Max-Age=${maxAge}`, 'Path=/api/cloud', 'HttpOnly', 'SameSite=Lax'];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

function sameOriginCsrfOk(request, url) {
  const fetchSite = (request.headers.get('sec-fetch-site') || '').toLowerCase();
  if (fetchSite === 'same-origin' || fetchSite === 'none') return true;
  if (request.headers.get('x-requested-with')) return true;
  const origin = request.headers.get('origin') || '';
  if (origin) {
    try {
      return new URL(origin).host.toLowerCase() === url.host.toLowerCase();
    } catch {
      return false;
    }
  }
  return false;
}

function base64ToBytes(b64) {
  const clean = String(b64 || '').includes(',') ? String(b64).split(',', 2)[1] : String(b64 || '');
  const trimmed = clean.replace(/\s+/g, '');
  if (!trimmed || trimmed.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(trimmed)) {
    throw new CloudError('E_INVALID_ARG', 'Dữ liệu base64 không hợp lệ.', 400);
  }
  const binary = atob(trimmed);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

function validateGlbBytes(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 20) {
    throw new CloudError('E_UNSUPPORTED', 'Tệp GLB không hợp lệ.', 415);
  }
  if (bytes[0] !== 0x67 || bytes[1] !== 0x6c || bytes[2] !== 0x54 || bytes[3] !== 0x46) {
    throw new CloudError('E_UNSUPPORTED', 'Tệp không phải định dạng GLB (glTF binary).', 415);
  }
  return bytes;
}

function validatePngBytes(bytes) {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 24 || bytes.byteLength > 2 * 1024 * 1024) {
    throw new CloudError('E_INVALID_ARG', 'Ảnh thumbnail PNG không hợp lệ (tối đa 2 MB).', 400);
  }
  for (let i = 0; i < sig.length; i += 1) {
    if (bytes[i] !== sig[i]) throw new CloudError('E_INVALID_ARG', 'Thumbnail phải là ảnh PNG.', 400);
  }
  return bytes;
}

function safeName(raw, fallback = 'Untitled') {
  const clean = String(raw || '').replace(/[\x00-\x1f<>:"/\\|?*]+/g, ' ').trim().slice(0, 120);
  return clean || fallback;
}

function validateCategory(raw) {
  const c = String(raw || 'props').trim().toLowerCase();
  return COMMUNITY_CATEGORIES.includes(c) ? c : 'props';
}

function validateTags(raw) {
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.map((t) => String(t || '').trim().toLowerCase().slice(0, 24)).filter(Boolean))].slice(0, 10);
}

function authorDisplayName(email) {
  const local = String(email || '').split('@')[0] || 'Creator';
  return safeName(local, 'Creator').slice(0, 40);
}

function generatePaymentCode() {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  let out = 'WBS';
  for (let i = 0; i < 8; i += 1) out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return out;
}

function timingSafeEqualStr(a, b) {
  const sa = String(a || '');
  const sb = String(b || '');
  const enc = new TextEncoder();
  const ba = enc.encode(sa);
  const bb = enc.encode(sb);
  const maxLen = Math.max(ba.length, bb.length);
  let diff = ba.length ^ bb.length;
  for (let i = 0; i < maxLen; i += 1) {
    diff |= (ba[i] || 0) ^ (bb[i] || 0);
  }
  return diff === 0;
}

async function hmacSha256Hex(secret, rawBytes) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, rawBytes));
  return Array.from(sig, (b) => b.toString(16).padStart(2, '0')).join('');
}

async function sbFetch(cfg, method, path, { body, token, apiKey, prefer } = {}) {
  const headers = {
    apikey: apiKey || cfg.supabaseServiceKey,
    Authorization: `Bearer ${token || cfg.supabaseServiceKey}`,
    Accept: 'application/json',
  };
  if (prefer) headers.Prefer = prefer;
  const init = { method, headers };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const resp = await fetch(`${cfg.supabaseUrl}${path}`, init);
  const text = await resp.text();
  let parsed = null;
  if (text) {
    try { parsed = JSON.parse(text); } catch { parsed = text; }
  }
  if (!resp.ok) {
    const detail = (parsed && typeof parsed === 'object')
      ? (parsed.message || parsed.error_description || parsed.error || '')
      : String(parsed || '').slice(0, 200);
    if (String(detail).includes('insufficient_credits')) {
      throw new CloudError('E_INSUFFICIENT_CREDITS', 'Không đủ credit.', 402);
    }
    if (String(detail).includes('quota_max_assets')) {
      throw new CloudError('E_QUOTA', 'Đã đạt số tệp tối đa.', 413);
    }
    if (String(detail).includes('quota_max_bytes')) {
      throw new CloudError('E_QUOTA', 'Vượt hạn mức dung lượng Cloud.', 413);
    }
    if (String(detail).includes('payment_not_found')) {
      throw new CloudError('E_NOT_FOUND', 'Không tìm thấy giao dịch.', 404);
    }
    if (String(detail).includes('payment_provider_mismatch')) {
      throw new CloudError('E_INVALID_ARG', 'Provider không khớp giao dịch.', 400);
    }
    if (resp.status === 401 || resp.status === 403) {
      throw new CloudError('E_AUTH_INVALID', `Supabase HTTP ${resp.status}: ${String(detail).slice(0, 160)}`, 401);
    }
    if (resp.status === 404) {
      throw new CloudError('E_NOT_FOUND', 'Không tìm thấy tài nguyên.', 404);
    }
    throw new CloudError('E_PROVIDER', `Supabase HTTP ${resp.status}: ${String(detail).slice(0, 180)}`, 502);
  }
  return parsed;
}

async function sbRpc(cfg, name, args) {
  const res = await sbFetch(cfg, 'POST', `/rest/v1/rpc/${encodeURIComponent(name)}`, { body: args });
  return Array.isArray(res) && res.length === 1 ? res[0] : res;
}

async function sbStorageUpload(cfg, storagePath, bytes, contentType) {
  const encodedPath = storagePath.split('/').map(encodeURIComponent).join('/');
  const resp = await fetch(`${cfg.supabaseUrl}/storage/v1/object/${encodeURIComponent(cfg.assetBucket)}/${encodedPath}`, {
    method: 'POST',
    headers: {
      apikey: cfg.supabaseServiceKey,
      Authorization: `Bearer ${cfg.supabaseServiceKey}`,
      'Content-Type': contentType,
      'x-upsert': 'true',
    },
    body: bytes,
  });
  if (!resp.ok) {
    const txt = await resp.text().catch(() => '');
    throw new CloudError('E_PROVIDER', `Supabase Storage upload HTTP ${resp.status}: ${txt.slice(0, 160)}`, 502);
  }
}

async function sbStorageDelete(cfg, paths) {
  const prefixes = paths.filter(Boolean);
  if (!prefixes.length) return;
  try {
    await fetch(`${cfg.supabaseUrl}/storage/v1/object/${encodeURIComponent(cfg.assetBucket)}`, {
      method: 'DELETE',
      headers: {
        apikey: cfg.supabaseServiceKey,
        Authorization: `Bearer ${cfg.supabaseServiceKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ prefixes }),
    });
  } catch {
    // best-effort cleanup
  }
}

async function sbSignedUrl(cfg, storagePath, expiresIn = 300) {
  const ttl = Math.max(60, Math.min(3600, Math.round(expiresIn)));
  const encodedPath = storagePath.split('/').map(encodeURIComponent).join('/');
  const res = await sbFetch(cfg, 'POST', `/storage/v1/object/sign/${encodeURIComponent(cfg.assetBucket)}/${encodedPath}`, {
    body: { expiresIn: ttl },
  });
  let signedPath = res?.signedURL || '';
  if (signedPath.startsWith('/object/')) signedPath = `/storage/v1${signedPath}`;
  if (!signedPath.startsWith('/storage/v1/object/sign/')) {
    throw new CloudError('E_PROVIDER', 'Supabase trả signed URL không hợp lệ.', 502);
  }
  return `${cfg.supabaseUrl}${signedPath}`;
}

async function verifySupabaseToken(cfg, token) {
  if (!token) throw new CloudError('E_AUTH_REQUIRED', 'Cần đăng nhập Cloud.', 401);
  const user = await sbFetch(cfg, 'GET', '/auth/v1/user', { token, apiKey: cfg.supabaseAnonKey });
  if (!user || !user.id) throw new CloudError('E_AUTH_INVALID', 'Phiên đăng nhập không hợp lệ.', 401);
  return { id: String(user.id), email: String(user.email || '') };
}

async function authenticateRequest(request, url, cfg) {
  const authHeader = request.headers.get('authorization') || '';
  if (authHeader.toLowerCase().startsWith('bearer ')) {
    const token = authHeader.slice(7).trim();
    return verifySupabaseToken(cfg, token);
  }
  const cookieToken = getCookie(request, 'wbs_session');
  if (cookieToken) {
    const method = request.method.toUpperCase();
    if (method !== 'GET' && method !== 'HEAD' && !sameOriginCsrfOk(request, url)) {
      throw new CloudError('E_FORBIDDEN', 'CSRF verification failed for cookie session.', 403);
    }
    return verifySupabaseToken(cfg, cookieToken);
  }
  throw new CloudError('E_AUTH_REQUIRED', 'Cần đăng nhập Cloud.', 401);
}

async function ensureUser(cfg, identity) {
  const now = new Date().toISOString();
  await sbFetch(cfg, 'POST', '/rest/v1/cloud_users?on_conflict=id', {
    body: { id: identity.id, email: identity.email, created_at: now },
    prefer: 'resolution=merge-duplicates,return=minimal',
  });
  if (cfg.freeCredits > 0) {
    await sbRpc(cfg, 'cloud_grant_free', { p_user_id: identity.id, p_amount: cfg.freeCredits });
  }
  const rows = await sbFetch(cfg, 'GET', `/rest/v1/cloud_users?id=eq.${encodeURIComponent(identity.id)}&select=id,email,created_at&limit=1`);
  const row = Array.isArray(rows) && rows[0] ? rows[0] : { id: identity.id, email: identity.email, created_at: now };
  const credits = Number(await sbRpc(cfg, 'cloud_balance', { p_user_id: identity.id })) || 0;
  return { id: row.id, email: row.email || identity.email, createdAt: row.created_at, credits };
}

function mapAssetRow(row, viewerUserId = null, includePrivateUrl = false) {
  const isPublic = Boolean(row.public);
  const isOwner = Boolean(viewerUserId && row.user_id === viewerUserId);
  const thumbPath = row.thumb_path || '';
  let url = isPublic ? `/api/cloud/public/assets/${row.id}` : null;
  let thumbUrl = isPublic && thumbPath ? `/api/cloud/public/thumbs/${row.id}` : null;
  if (!isPublic && isOwner && includePrivateUrl) {
    url = `/api/cloud/assets/${row.id}/download`;
  }
  return {
    id: row.id,
    name: row.name || '',
    title: row.title || String(row.name || 'model').replace(/\.[^.]+$/, ''),
    category: row.category || 'props',
    tags: Array.isArray(row.tags) ? row.tags : [],
    description: row.description || '',
    authorName: row.author_name || 'Creator',
    contentType: row.content_type || 'model/gltf-binary',
    sizeBytes: Number(row.size_bytes) || 0,
    public: isPublic,
    createdAt: row.created_at,
    url,
    thumbUrl,
    isOwner,
  };
}

function mapPaymentRow(row) {
  return {
    id: row.id,
    code: row.code || '',
    provider: row.provider || '',
    planId: row.plan_id || '',
    amountVnd: Number(row.amount_vnd) || 0,
    credits: Number(row.credits) || 0,
    status: row.status || '',
    createdAt: row.created_at,
    expiresAt: row.expires_at || null,
    paidAt: row.paid_at || null,
  };
}

async function readJsonBody(request, maxBytes) {
  const contentLen = Number(request.headers.get('content-length') || 0);
  if (contentLen > maxBytes) throw new CloudError('E_TOO_LARGE', 'Request body vượt giới hạn dung lượng.', 413);
  const buf = new Uint8Array(await request.arrayBuffer());
  if (buf.byteLength > maxBytes) throw new CloudError('E_TOO_LARGE', 'Request body vượt giới hạn dung lượng.', 413);
  if (!buf.byteLength) return { raw: buf, data: {} };
  try {
    const data = JSON.parse(new TextDecoder().decode(buf));
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new CloudError('E_INVALID_ARG', 'Body phải là JSON object.', 400);
    }
    return { raw: buf, data };
  } catch (e) {
    if (e instanceof CloudError) throw e;
    throw new CloudError('E_INVALID_ARG', 'Body không phải JSON hợp lệ.', 400);
  }
}

async function handlePublicAssetOrThumb(assetId, kind, cfg, env) {
  const rows = await sbFetch(
    cfg,
    'GET',
    `/rest/v1/cloud_assets?id=eq.${encodeURIComponent(assetId)}&public=eq.true&select=id,name,content_type,storage_path,thumb_path&limit=1`,
  );
  const row = Array.isArray(rows) ? rows[0] : null;
  const key = kind === 'thumb' ? row?.thumb_path : row?.storage_path;
  if (!row || !key) throw new CloudError('E_NOT_FOUND', 'Không tìm thấy tệp.', 404);

  // 1. Prefer R2 zero-egress storage when object exists in HUNGER_ASSETS
  if (env?.HUNGER_ASSETS) {
    const r2Key = key.startsWith('user_uploads/') ? key : `user_uploads/${key}`;
    const obj = await env.HUNGER_ASSETS.get(r2Key);
    if (obj) {
      const headers = new Headers({
        'Content-Type': kind === 'thumb' ? 'image/png' : (row.content_type || 'model/gltf-binary'),
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; sandbox",
        'Access-Control-Allow-Origin': '*',
        'Cross-Origin-Resource-Policy': 'cross-origin',
        'Cache-Control': kind === 'thumb' ? 'public, max-age=300' : 'public, max-age=60',
      });
      if (kind === 'asset') {
        const fname = String(row.name || 'model.glb').replace(/["\\\r\n]/g, '_');
        headers.set('Content-Disposition', `inline; filename="${fname}"`);
      }
      return new Response(obj.body, { status: 200, headers });
    }
  }

  // 2. Fallback to short-lived Supabase Storage signed URL for legacy objects
  const signed = await sbSignedUrl(cfg, key, kind === 'thumb' ? 300 : 120);
  return Response.redirect(signed, 302);
}

function parseSecretKeyList(rawMulti, rawSingle = '') {
  const out = [];
  const push = (v) => {
    const s = String(v || '').trim();
    if (s && !s.startsWith('sk-DIEN_') && !out.includes(s)) out.push(s);
  };
  if (rawMulti) {
    const str = String(rawMulti).trim();
    if (str.startsWith('[')) {
      try {
        const arr = JSON.parse(str);
        if (Array.isArray(arr)) arr.forEach(push);
      } catch {
        str.split(/[\n,]+/).forEach(push);
      }
    } else {
      str.split(/[\n,]+/).forEach(push);
    }
  }
  push(rawSingle);
  return out;
}

function validateAiMessages(messages) {
  if (!Array.isArray(messages) || !messages.length || messages.length > 40) {
    throw new CloudError('E_INVALID_ARG', 'messages phải là mảng không rỗng (tối đa 40 phần tử).', 400);
  }
  const cleaned = [];
  for (const m of messages) {
    if (!m || typeof m !== 'object') throw new CloudError('E_INVALID_ARG', 'Mỗi message phải là object.', 400);
    if (!['system', 'user', 'assistant'].includes(m.role)) {
      throw new CloudError('E_INVALID_ARG', 'Role của message không hợp lệ.', 400);
    }
    if (typeof m.content !== 'string' && !Array.isArray(m.content)) {
      throw new CloudError('E_INVALID_ARG', 'Nội dung message không hợp lệ.', 400);
    }
    cleaned.push({ role: m.role, content: m.content });
  }
  return cleaned;
}

async function handleAiChat(request, env, cfg, user) {
  checkEdgeRateLimit(request, env, 'ai', user);
  const { data: body } = await readJsonBody(request, 2 * 1024 * 1024);
  if ('endpoint' in body) {
    throw new CloudError('E_INVALID_ARG', 'Không được ghi đè endpoint từ client.', 400);
  }
  let provider = String(body.provider || env.AI_PROVIDER || 'motapis').trim().toLowerCase();
  if (provider === 'custom') provider = 'motapis';
  if (!['motapis', 'gemini', 'openai'].includes(provider)) {
    throw new CloudError('E_INVALID_ARG', 'Nguồn AI không hợp lệ.', 400);
  }
  const messages = validateAiMessages(body.messages);
  const temperature = typeof body.temperature === 'number' && Number.isFinite(body.temperature)
    ? Math.max(0, Math.min(2, body.temperature))
    : 0.35;
  const maxTokens = typeof body.max_tokens === 'number' && Number.isFinite(body.max_tokens)
    ? Math.max(256, Math.min(16384, Math.round(body.max_tokens)))
    : 12288;

  const byokKey = String(request.headers.get('x-ai-provider-key') || '').trim();
  const aiCost = byokKey ? 0 : cfg.costs.ai_chat;
  let chargeKey = '';
  if (user && aiCost > 0) {
    chargeKey = `ai:${crypto.randomUUID()}`;
    await sbRpc(cfg, 'cloud_charge', {
      p_user_id: user.id,
      p_amount: aiCost,
      p_reason: 'ai_chat',
      p_ref: provider,
      p_key: chargeKey,
    });
  }

  try {
    let endpoint;
    let keys;
    let model;
    if (provider === 'gemini') {
      keys = byokKey ? [byokKey] : parseSecretKeyList(env.GEMINI_API_KEY);
      model = String(body.model || env.GEMINI_MODEL || 'gemini-3.5-flash-lite').trim().slice(0, 120);
      endpoint = 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions';
    } else if (provider === 'openai') {
      keys = byokKey ? [byokKey] : parseSecretKeyList(env.OPENAI_API_KEY);
      model = String(body.model || env.OPENAI_MODEL || 'gpt-4o-mini').trim().slice(0, 120);
      endpoint = 'https://api.openai.com/v1/chat/completions';
    } else {
      keys = byokKey ? [byokKey] : parseSecretKeyList(env.MOTAPIS_API_KEYS, env.MOTAPIS_API_KEY);
      model = String(body.model || env.MOTAPIS_MODEL || 'gpt-6-astra').trim().slice(0, 120);
      const base = String(env.MOTAPIS_ENDPOINT || 'https://motapis.com/v1').trim().replace(/\/+$/, '');
      endpoint = base.endsWith('/chat/completions') ? base : `${base}/chat/completions`;
    }
    if (!keys.length) {
      throw new CloudError('E_PROVIDER', `Chưa cấu hình API key cho provider "${provider}". Bạn có thể nhập BYOK key trong Cài đặt AI.`, 503);
    }

    const reqPayload = JSON.stringify({ model, messages, temperature, max_tokens: maxTokens });
    let primaryStatus = null;
    let primaryDetail = '';
    for (const apiKey of keys) {
      try {
        const upstream = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
            'User-Agent': 'HungerStudio/2.0',
          },
          body: reqPayload,
        });
        const text = await upstream.text();
        if (upstream.ok) {
          return new Response(text, {
            status: 200,
            headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
          });
        }
        if (primaryStatus === null) {
          primaryStatus = upstream.status;
          primaryDetail = text.slice(0, 300);
        }
        // Fail over to next key on auth/rate-limit/quota/5xx errors
        if (upstream.status === 400 || upstream.status === 404) break;
      } catch (fetchErr) {
        if (primaryStatus === null) {
          primaryStatus = 502;
          primaryDetail = String(fetchErr?.message || fetchErr).slice(0, 200);
        }
      }
    }

    const low = primaryDetail.toLowerCase();
    let friendly;
    if (primaryStatus === 404) {
      friendly = `Model '${model}' không còn khả dụng. Vui lòng chọn model khác trong Cài đặt AI.`;
    } else if (primaryStatus === 429 || low.includes('quota') || low.includes('rate') || low.includes('insufficient')) {
      friendly = `Model '${model}' đang chạm giới hạn hoặc hết hạn mức. Vui lòng thử lại sau hoặc đổi sang Gemini 3.5 Flash-Lite / Claude Sonnet 4.6.`;
    } else if (primaryStatus === 401 || primaryStatus === 403) {
      friendly = `Nguồn AI hiện tại chưa cấp quyền cho model '${model}'. Vui lòng đổi sang model hoặc nguồn AI khác.`;
    } else {
      friendly = `Máy chủ AI đang bận hoặc phản hồi lỗi (HTTP ${primaryStatus || 502}) cho model '${model}'. Vui lòng thử lại sau.`;
    }
    const outStatus = [400, 401, 403, 404, 429].includes(primaryStatus) ? primaryStatus : 502;
    throw new CloudError('E_PROVIDER', friendly, outStatus);
  } catch (err) {
    if (user && aiCost > 0 && chargeKey) {
      try {
        await sbRpc(cfg, 'cloud_credit', {
          p_user_id: user.id,
          p_amount: aiCost,
          p_reason: 'refund_ai_failed',
          p_ref: provider,
          p_key: `refund:${chargeKey}`,
        });
      } catch {
        // best effort refund
      }
    }
    throw err;
  }
}

const TELEMETRY_RING_MAX = 200;
const TELEMETRY_RING = [];
const TELEMETRY_COUNTERS = {
  sessions: 0,
  crashedSessions: 0,
  fatalErrors: 0,
  errors: 0,
  videoToGlbAttempts: 0,
  videoToGlbSuccesses: 0,
  interactiveSamplesMs: [],
  ttfaSamplesSec: [],
};

function parseSentryDsn(dsnRaw) {
  const dsn = String(dsnRaw || '').trim();
  if (!dsn) return null;
  try {
    const u = new URL(dsn);
    const projectId = u.pathname.replace(/^\/+|\/+$/g, '').split('/').pop();
    const publicKey = u.username;
    if (!projectId || !publicKey || (u.protocol !== 'https:' && u.protocol !== 'http:')) return null;
    return {
      dsn,
      envelopeUrl: `${u.protocol}//${u.host}/api/${projectId}/envelope/`,
      authHeader: `Sentry sentry_version=7, sentry_key=${publicKey}, sentry_client=hunger-edge/1.0`,
    };
  } catch {
    return null;
  }
}

async function forwardErrorToSentry(dsnRaw, sentryEvent) {
  const parsed = parseSentryDsn(dsnRaw);
  if (!parsed || !sentryEvent) return false;
  const header = JSON.stringify({
    event_id: sentryEvent.event_id,
    sent_at: new Date().toISOString(),
    dsn: parsed.dsn,
  });
  const itemHeader = JSON.stringify({ type: 'event', content_type: 'application/json' });
  const itemBody = JSON.stringify(sentryEvent);
  const envelope = `${header}\n${itemHeader}\n${itemBody}`;
  try {
    const resp = await fetch(parsed.envelopeUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-sentry-envelope',
        'X-Sentry-Auth': parsed.authHeader,
      },
      body: envelope,
    });
    return resp.ok;
  } catch {
    return false;
  }
}

async function handleTelemetryEvent(request, env) {
  checkEdgeRateLimit(request, env, 'telemetry', null);
  const { data } = await readJsonBody(request, 64 * 1024);
  const events = Array.isArray(data?.events) ? data.events.slice(0, 25) : [];
  if (!events.length) {
    return jsonResponse({ ok: true, accepted: 0 }, 202, { 'Cache-Control': 'no-store' });
  }
  const envName = String(env?.STUDIO_ENV || data?.environment || 'production').slice(0, 32);
  let sentryForwarded = 0;

  for (const ev of events) {
    if (!ev || typeof ev !== 'object') continue;
    const kind = ev.kind === 'error' ? 'error' : 'analytics';
    const record = {
      kind,
      name: String(ev.name || (kind === 'error' ? 'error_captured' : 'unknown')).slice(0, 64),
      ts: String(ev.ts || new Date().toISOString()).slice(0, 40),
      sessionId: String(ev.sessionId || data.sessionId || '').slice(0, 32),
      environment: envName,
      workspace: String(ev.workspace || 'unknown').slice(0, 32),
      props: ev.props && typeof ev.props === 'object' ? ev.props : undefined,
      errorMessage: kind === 'error' ? String(ev.sentry?.exception?.values?.[0]?.value || '').slice(0, 240) : undefined,
      fatal: kind === 'error' ? ev.sentry?.level === 'fatal' : undefined,
    };

    if (kind === 'error') {
      TELEMETRY_COUNTERS.errors += 1;
      if (record.fatal) TELEMETRY_COUNTERS.fatalErrors += 1;
      if (env?.SENTRY_DSN && ev.sentry) {
        const sent = await forwardErrorToSentry(env.SENTRY_DSN, { ...ev.sentry, environment: envName });
        if (sent) sentryForwarded += 1;
      }
    } else if (record.name === 'session_interactive') {
      TELEMETRY_COUNTERS.sessions += 1;
      const ms = Number(record.props?.initialInteractiveMs);
      if (Number.isFinite(ms) && ms >= 0 && ms < 120000) {
        TELEMETRY_COUNTERS.interactiveSamplesMs.push(ms);
        if (TELEMETRY_COUNTERS.interactiveSamplesMs.length > 200) TELEMETRY_COUNTERS.interactiveSamplesMs.shift();
      }
    } else if (record.name === 'session_end' && record.props?.crashFree === false) {
      TELEMETRY_COUNTERS.crashedSessions += 1;
    } else if (record.name === 'first_animation_achieved') {
      const sec = Number(record.props?.timeToFirstAnimationSec);
      if (Number.isFinite(sec) && sec >= 0 && sec < 86400) {
        TELEMETRY_COUNTERS.ttfaSamplesSec.push(sec);
        if (TELEMETRY_COUNTERS.ttfaSamplesSec.length > 200) TELEMETRY_COUNTERS.ttfaSamplesSec.shift();
      }
    } else if (record.name === 'mocap_export_glb') {
      TELEMETRY_COUNTERS.videoToGlbAttempts += 1;
      if (record.props?.ok === true) TELEMETRY_COUNTERS.videoToGlbSuccesses += 1;
    }

    TELEMETRY_RING.push(record);
    if (TELEMETRY_RING.length > TELEMETRY_RING_MAX) TELEMETRY_RING.shift();
    console.log(JSON.stringify({ telemetry: true, ...record }));
  }

  return jsonResponse({ ok: true, accepted: events.length, sentryForwarded }, 202, { 'Cache-Control': 'no-store' });
}

function medianOf(nums) {
  if (!nums.length) return null;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Number(((sorted[mid - 1] + sorted[mid]) / 2).toFixed(1));
}

function handleTelemetrySummary(env) {
  const s = TELEMETRY_COUNTERS.sessions;
  const crashFreePct = s > 0 ? Number((((s - TELEMETRY_COUNTERS.crashedSessions) / s) * 100).toFixed(2)) : 100;
  const v2gAttempts = TELEMETRY_COUNTERS.videoToGlbAttempts;
  const videoToGlbPct = v2gAttempts > 0
    ? Number(((TELEMETRY_COUNTERS.videoToGlbSuccesses / v2gAttempts) * 100).toFixed(2))
    : null;
  return jsonResponse({
    ok: true,
    environment: String(env?.STUDIO_ENV || 'production'),
    sentryConfigured: Boolean(parseSentryDsn(env?.SENTRY_DSN)),
    kpi: {
      sessions: s,
      crashFreePct,
      fatalErrors: TELEMETRY_COUNTERS.fatalErrors,
      errors: TELEMETRY_COUNTERS.errors,
      videoToGlbAttempts: v2gAttempts,
      videoToGlbSuccessPct: videoToGlbPct,
      medianInteractiveMs: medianOf(TELEMETRY_COUNTERS.interactiveSamplesMs),
      medianTimeToFirstAnimationSec: medianOf(TELEMETRY_COUNTERS.ttfaSamplesSec),
    },
    recentEvents: TELEMETRY_RING.slice(-20),
  }, 200, { 'Cache-Control': 'no-store' });
}

export async function handleCloudBff(request, env, url) {
  try {
    const cfg = getConfig(env);
    const method = request.method.toUpperCase();
    const path = url.pathname;
    const secure = isSecureRequest(request, url);

    if (method === 'GET' && path === '/healthz') {
      return jsonResponse({
        ok: true,
        service: 'hunger-studio',
        environment: String(env?.STUDIO_ENV || 'production'),
        release: 'hunger-motion@0.9.0-beta.1',
        runtime: 'cloudflare-worker',
        cloud: cfg.enabled,
        r2: Boolean(env?.HUNGER_ASSETS),
        telemetry: true,
        sentryConfigured: Boolean(parseSentryDsn(env?.SENTRY_DSN)),
      }, 200, { 'Cache-Control': 'no-store' });
    }
    if (method === 'POST' && path === '/api/telemetry/event') {
      return await handleTelemetryEvent(request, env);
    }
    if (method === 'GET' && path === '/api/telemetry/summary') {
      return handleTelemetrySummary(env);
    }
    if (method === 'GET' && path === '/api/status') {
      const sessionId = (url.searchParams.get('session') || request.headers.get('x-studio-session') || 'default').trim();
      const connectedBrowsers = await getBridgeConnectedCount(env, /^[A-Za-z0-9_-]{4,64}$/.test(sessionId) ? sessionId : 'default');
      const motapisKeys = parseSecretKeyList(env.MOTAPIS_API_KEYS, env.MOTAPIS_API_KEY);
      const activeProvider = env.AI_PROVIDER || (motapisKeys.length ? 'motapis' : (env.GEMINI_API_KEY ? 'gemini' : 'offline'));
      return jsonResponse({
        success: true,
        status: 'online',
        service: 'Hunger',
        runtime: 'cloudflare-worker',
        cloudEnabled: cfg.enabled,
        bridgeEnabled: Boolean(env?.BRIDGE_HUB),
        wsPath: env?.BRIDGE_HUB ? '/api/bridge/ws' : null,
        mcpEndpoint: '/mcp',
        connectedBrowsers,
        provider: activeProvider,
      }, 200, { 'Cache-Control': 'no-store' });
    }
    if (method === 'GET' && path === '/api/config') {
      const motapisKeys = parseSecretKeyList(env.MOTAPIS_API_KEYS, env.MOTAPIS_API_KEY);
      const hasGemini = Boolean(String(env.GEMINI_API_KEY || '').trim());
      const hasOpenAi = Boolean(String(env.OPENAI_API_KEY || '').trim());
      const configuredProvider = String(env.AI_PROVIDER || '').trim().toLowerCase();
      const provider = ['motapis', 'gemini', 'openai'].includes(configuredProvider)
        ? configuredProvider
        : (motapisKeys.length ? 'motapis' : (hasGemini ? 'gemini' : 'motapis'));
      return jsonResponse({
        provider,
        geminiModel: env.GEMINI_MODEL || 'gemini-3.5-flash-lite',
        customModel: env.MOTAPIS_MODEL || 'gpt-6-astra',
        openAiModel: env.OPENAI_MODEL || 'gpt-4o-mini',
        geminiConfigured: hasGemini,
        openAiConfigured: hasOpenAi,
        hasCustomKeys: motapisKeys.length > 0,
        customKeysCount: motapisKeys.length,
        freeModels: FREE_TIER_MODELS,
      }, 200, { 'Cache-Control': 'no-store' });
    }
    if (method === 'POST' && path === '/api/config') {
      return jsonResponse({ success: true }, 200, { 'Cache-Control': 'no-store' });
    }

    // Cloud status (public, no secrets)
    if (method === 'GET' && path === '/api/cloud/status') {
      const freeMode = cfg.costs.save_project === 0 && cfg.costs.upload_asset === 0 && cfg.costs.ai_chat === 0;
      return jsonResponse({
        success: true,
        enabled: cfg.enabled,
        configured: cfg.enabled,
        provider: cfg.enabled ? 'supabase' : 'disabled',
        storage: env?.HUNGER_ASSETS ? 'cloudflare-r2' : 'supabase',
        devLogin: false,
        supabase: cfg.enabled ? { url: cfg.supabaseUrl, anonKey: cfg.supabaseAnonKey } : null,
        costs: cfg.costs,
        plans: cfg.plans,
        providers: { sepay: cfg.sepay.ready, lemonsqueezy: cfg.lemon.ready },
        billingEnabled: cfg.sepay.ready || cfg.lemon.ready,
        freeMode,
        categories: COMMUNITY_CATEGORIES,
        limits: {
          maxProjectBytes: cfg.maxProjectBytes,
          maxAssetBytes: cfg.maxAssetBytes,
          maxProjects: cfg.maxProjects,
          maxAssets: cfg.maxAssets,
          maxTotalBytes: cfg.maxTotalBytes,
        },
      }, 200, { 'Cache-Control': 'no-store' });
    }

    // AI chat without Cloud sign-in (BYOK or server secret)
    if (method === 'POST' && path === '/api/ai/chat') {
      return await handleAiChat(request, env, cfg, null);
    }

    if (!cfg.enabled) {
      throw new CloudError('E_CLOUD_DISABLED', 'Cloud chưa được cấu hình (thiếu SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_KEY).', 503);
    }

    // Payment Webhooks (authenticated by HMAC signature, not user cookie)
    if (method === 'POST' && path === '/api/cloud/webhook/sepay') {
      const { raw, data } = await readJsonBody(request, 256 * 1024);
      if (cfg.sepay.webhookSecret) {
        let sig = (request.headers.get('x-sepay-signature') || request.headers.get('x-sepay-signature-256') || '').trim();
        if (!sig) throw new CloudError('E_SIGNATURE', 'Thiếu chữ ký SePay.', 401);
        if (sig.toLowerCase().startsWith('sha256=')) sig = sig.slice(7);
        const expected = await hmacSha256Hex(cfg.sepay.webhookSecret, raw);
        if (!timingSafeEqualStr(expected, sig.toLowerCase())) {
          throw new CloudError('E_SIGNATURE', 'Chữ ký SePay không hợp lệ.', 401);
        }
      } else if (cfg.sepay.apiKey) {
        const provided = request.headers.get('authorization') || '';
        if (!timingSafeEqualStr(provided, `Apikey ${cfg.sepay.apiKey}`)) {
          throw new CloudError('E_SIGNATURE', 'API key SePay không hợp lệ.', 401);
        }
      } else {
        throw new CloudError('E_PROVIDER', 'SePay webhook chưa được cấu hình.', 503);
      }
      const transferType = String(data.transferType || '').trim().toLowerCase();
      if (transferType !== 'in') return jsonResponse({ success: true, ignored: 'not_incoming' });
      const acct = String(data.accountNumber || data.subAccount || '').trim();
      if (cfg.sepay.account && acct && acct !== cfg.sepay.account) {
        return jsonResponse({ success: true, applied: false, ignored: 'account_mismatch' });
      }
      const text = [data.code, data.content, data.description].map((v) => String(v || '')).join(' ');
      const m = text.match(SEPAY_CODE_RE);
      const code = m ? m[1].toUpperCase() : '';
      if (!code) return jsonResponse({ success: true, ignored: 'no_payment_code' });
      const amount = Number.isFinite(Number(data.transferAmount)) && Number(data.transferAmount) >= 0
        ? Math.floor(Number(data.transferAmount)) : 0;
      const externalId = String(data.id || data.referenceCode || `${data.transactionDate || ''}:${acct}:${amount}`);
      try {
        const res = await sbRpc(cfg, 'cloud_mark_payment_paid', {
          p_code: code, p_external_id: externalId, p_paid_amount: amount, p_provider: 'sepay',
        });
        return jsonResponse({ success: true, applied: Boolean(res?.applied), reason: res?.reason || '', credits: Number(res?.credits) || 0 });
      } catch (e) {
        if (e instanceof CloudError && e.status === 404) return jsonResponse({ success: true, ignored: 'unknown_payment' });
        throw e;
      }
    }

    if (method === 'POST' && path === '/api/cloud/webhook/lemonsqueezy') {
      const { raw, data } = await readJsonBody(request, 256 * 1024);
      if (!cfg.lemon.signingSecret) throw new CloudError('E_PROVIDER', 'LemonSqueezy webhook chưa được cấu hình.', 503);
      const sig = (request.headers.get('x-signature') || '').trim().toLowerCase();
      if (!sig) throw new CloudError('E_SIGNATURE', 'Thiếu chữ ký LemonSqueezy.', 401);
      const expected = await hmacSha256Hex(cfg.lemon.signingSecret, raw);
      if (!timingSafeEqualStr(expected, sig)) throw new CloudError('E_SIGNATURE', 'Chữ ký LemonSqueezy không hợp lệ.', 401);

      const meta = data.meta || {};
      if (meta.test_mode && !cfg.allowTestBilling) {
        throw new CloudError('E_FORBIDDEN', 'Test mode webhook không được phép trên production.', 403);
      }
      const eventName = String(meta.event_name || '').trim();
      const code = String(meta.custom_data?.payment_code || '').trim().toUpperCase();
      const attrs = data.data?.attributes || {};
      const status = String(attrs.status || '').trim().toLowerCase();
      const externalId = String(data.data?.id || '');
      if (eventName === 'order_refunded' || status === 'refunded' || attrs.refunded) {
        try {
          const res = await sbRpc(cfg, 'cloud_refund_payment', { p_code: code, p_external_id: externalId, p_provider: 'lemonsqueezy' });
          return jsonResponse({ success: true, applied: Boolean(res?.applied), reason: res?.reason || '', credits: Number(res?.credits) || 0 });
        } catch (e) {
          if (e instanceof CloudError && e.status === 404) return jsonResponse({ success: true, ignored: 'unknown_payment' });
          throw e;
        }
      }
      if (eventName !== 'order_created') return jsonResponse({ success: true, ignored: eventName || 'event' });
      if (status !== 'paid') return jsonResponse({ success: true, applied: false, ignored: `status_${status || 'unknown'}` });
      if (!code) return jsonResponse({ success: true, ignored: 'no_payment_code' });
      const rows = await sbFetch(cfg, 'GET', `/rest/v1/cloud_payments?code=eq.${encodeURIComponent(code)}&select=*&limit=1`);
      const existing = Array.isArray(rows) ? rows[0] : null;
      if (!existing) return jsonResponse({ success: true, ignored: 'unknown_payment' });
      if (existing.provider && existing.provider !== 'lemonsqueezy') {
        throw new CloudError('E_INVALID_ARG', 'Provider không khớp giao dịch.', 400);
      }
      const expectedVariant = cfg.lemon.variants[existing.plan_id] || '';
      const gotVariant = String(attrs.first_order_item?.variant_id ?? attrs.variant_id ?? '').trim();
      if (expectedVariant && gotVariant !== expectedVariant) {
        const bal = Number(await sbRpc(cfg, 'cloud_balance', { p_user_id: existing.user_id })) || 0;
        return jsonResponse({ success: true, applied: false, reason: 'variant_mismatch', credits: bal });
      }
      const total = attrs.total !== undefined && attrs.total !== null ? Math.floor(Number(attrs.total)) : null;
      const currency = String(attrs.currency || '').trim().toUpperCase();
      if (Number(existing.amount_vnd) > 0 && total !== null && (!Number.isFinite(total) || total <= 0)) {
        const bal = Number(await sbRpc(cfg, 'cloud_balance', { p_user_id: existing.user_id })) || 0;
        return jsonResponse({ success: true, applied: false, reason: 'invalid_total', credits: bal });
      }
      const paidAmountVnd = currency === 'VND' && total !== null ? total : null;
      const res = await sbRpc(cfg, 'cloud_mark_payment_paid', {
        p_code: code, p_external_id: externalId, p_paid_amount: paidAmountVnd, p_provider: 'lemonsqueezy',
      });
      return jsonResponse({ success: true, applied: Boolean(res?.applied), reason: res?.reason || '', credits: Number(res?.credits) || 0 });
    }

    // Session cookie endpoints
    if (method === 'POST' && path === '/api/cloud/logout') {
      return jsonResponse({ success: true }, 200, { 'Set-Cookie': buildSessionCookie('', 0, secure) });
    }
    if (path === '/api/cloud/session') {
      if (method === 'DELETE') {
        return jsonResponse({ success: true }, 200, { 'Set-Cookie': buildSessionCookie('', 0, secure) });
      }
      if (method === 'POST') {
        const { data } = await readJsonBody(request, 64 * 1024);
        const authHeader = request.headers.get('authorization') || '';
        const token = authHeader.toLowerCase().startsWith('bearer ') ? authHeader.slice(7).trim() : String(data.token || '').trim();
        const identity = await verifySupabaseToken(cfg, token);
        const user = await ensureUser(cfg, identity);
        return jsonResponse({ success: true, user }, 200, {
          'Set-Cookie': buildSessionCookie(token, cfg.sessionTtlSeconds, secure),
          'Cache-Control': 'no-store',
        });
      }
      throw new CloudError('E_INVALID_ARG', 'Method không hỗ trợ.', 405);
    }

    // Public community & asset routes
    if (method === 'GET' && path === '/api/cloud/community') {
      const cat = (url.searchParams.get('category') || 'all').trim().toLowerCase();
      const q = (url.searchParams.get('q') || '').trim().toLowerCase();
      const limit = Math.max(1, Math.min(100, parseIntEnv(url.searchParams.get('limit'), 48)));
      const offset = Math.max(0, parseIntEnv(url.searchParams.get('offset'), 0));
      let viewerId = null;
      try { viewerId = (await authenticateRequest(request, url, cfg)).id; } catch { viewerId = null; }
      const params = new URLSearchParams({
        public: 'eq.true',
        select: 'id,user_id,name,title,category,tags,description,author_name,thumb_path,content_type,size_bytes,public,storage_path,created_at',
        order: 'created_at.desc',
        limit: String(q ? 200 : limit),
        offset: q ? '0' : String(offset),
      });
      if (cat && cat !== 'all') params.set('category', `eq.${validateCategory(cat)}`);
      const rows = await sbFetch(cfg, 'GET', `/rest/v1/cloud_assets?${params.toString()}`);
      let items = (Array.isArray(rows) ? rows : []).map((r) => mapAssetRow(r, viewerId, false));
      if (q) {
        items = items
          .filter((it) => `${it.title} ${it.name} ${it.description} ${it.authorName} ${it.tags.join(' ')}`.toLowerCase().includes(q))
          .slice(offset, offset + limit);
      }
      return jsonResponse({ success: true, items });
    }
    const pubAssetMatch = path.match(ROUTE_PUBLIC_ASSET);
    if (method === 'GET' && pubAssetMatch) {
      return await handlePublicAssetOrThumb(pubAssetMatch[1], 'asset', cfg, env);
    }
    const pubThumbMatch = path.match(ROUTE_PUBLIC_THUMB);
    if (method === 'GET' && pubThumbMatch) {
      return await handlePublicAssetOrThumb(pubThumbMatch[1], 'thumb', cfg, env);
    }

    // Authenticated routes below
    const identity = await authenticateRequest(request, url, cfg);
    const user = await ensureUser(cfg, identity);

    if (method === 'POST' && path === '/api/cloud/ai/chat') {
      return await handleAiChat(request, env, cfg, user);
    }
    if (method === 'GET' && path === '/api/cloud/me') {
      const statsRaw = (await sbRpc(cfg, 'cloud_stats', { p_user_id: user.id })) || {};
      return jsonResponse({
        success: true,
        user,
        provider: 'supabase',
        storage: env?.HUNGER_ASSETS ? 'cloudflare-r2' : 'supabase',
        limits: {
          maxProjectBytes: cfg.maxProjectBytes,
          maxAssetBytes: cfg.maxAssetBytes,
          maxProjects: cfg.maxProjects,
          maxAssets: cfg.maxAssets,
          maxTotalBytes: cfg.maxTotalBytes,
        },
        costs: cfg.costs,
        stats: {
          projects: Number(statsRaw.projects) || 0,
          assets: Number(statsRaw.assets) || 0,
          usedBytes: Number(statsRaw.used_bytes) || 0,
          maxTotalBytes: cfg.maxTotalBytes,
        },
        plans: cfg.plans,
      });
    }
    if (method === 'GET' && path === '/api/cloud/me/export') {
      const [statsRaw, projects, assets, ledger, payments] = await Promise.all([
        sbRpc(cfg, 'cloud_stats', { p_user_id: user.id }),
        sbFetch(cfg, 'GET', `/rest/v1/cloud_projects?user_id=eq.${encodeURIComponent(user.id)}&select=*&order=updated_at.desc&limit=500`),
        sbFetch(cfg, 'GET', `/rest/v1/cloud_assets?user_id=eq.${encodeURIComponent(user.id)}&select=id,name,title,category,description,size_bytes,public,created_at&order=created_at.desc&limit=500`),
        sbFetch(cfg, 'GET', `/rest/v1/cloud_ledger?user_id=eq.${encodeURIComponent(user.id)}&select=delta,reason,ref,balance_after,created_at&order=id.desc&limit=200`),
        sbFetch(cfg, 'GET', `/rest/v1/cloud_payments?user_id=eq.${encodeURIComponent(user.id)}&select=*&order=created_at.desc&limit=100`),
      ]);
      const archive = {
        exportedAt: new Date().toISOString(),
        user,
        stats: { projects: Number(statsRaw?.projects) || 0, assets: Number(statsRaw?.assets) || 0, usedBytes: Number(statsRaw?.used_bytes) || 0, maxTotalBytes: cfg.maxTotalBytes },
        projects: (projects || []).map((r) => ({ id: r.id, name: r.name, sizeBytes: Number(r.size_bytes) || 0, createdAt: r.created_at, updatedAt: r.updated_at, data: r.data })),
        assets: (assets || []).map((r) => ({ id: r.id, name: r.name, title: r.title, category: r.category, description: r.description, sizeBytes: Number(r.size_bytes) || 0, public: Boolean(r.public), createdAt: r.created_at })),
        ledger: (ledger || []).map((r) => ({ delta: Number(r.delta) || 0, reason: r.reason, ref: r.ref, balanceAfter: Number(r.balance_after) || 0, createdAt: r.created_at })),
        payments: (payments || []).map(mapPaymentRow),
      };
      return jsonResponse(archive, 200, {
        'Content-Disposition': 'attachment; filename="hunger-data.json"',
        'Cache-Control': 'no-store',
      });
    }
    if (method === 'POST' && path === '/api/cloud/me/delete') {
      const { data } = await readJsonBody(request, 16 * 1024);
      const confirm = String(data.confirm || '').trim();
      const email = String(data.email || '').trim().toLowerCase();
      if (confirm !== 'DELETE' && (!email || email !== String(user.email || '').toLowerCase())) {
        throw new CloudError('E_INVALID_ARG', 'Cần xác nhận xoá tài khoản (confirm="DELETE" hoặc nhập đúng email).', 400);
      }
      const assets = await sbFetch(cfg, 'GET', `/rest/v1/cloud_assets?user_id=eq.${encodeURIComponent(user.id)}&select=storage_path,thumb_path&limit=500`);
      if (Array.isArray(assets) && assets.length) {
        const sbPaths = [];
        for (const row of assets) {
          for (const k of [row.storage_path, row.thumb_path]) {
            if (!k) continue;
            if (env?.HUNGER_ASSETS) {
              try { await env.HUNGER_ASSETS.delete(k.startsWith('user_uploads/') ? k : `user_uploads/${k}`); } catch {}
            } else {
              sbPaths.push(k);
            }
          }
        }
        if (sbPaths.length) await sbStorageDelete(cfg, sbPaths);
      }
      await sbFetch(cfg, 'DELETE', `/rest/v1/cloud_users?id=eq.${encodeURIComponent(user.id)}`, { prefer: 'return=minimal' });
      try { await sbFetch(cfg, 'DELETE', `/auth/v1/admin/users/${encodeURIComponent(user.id)}`); } catch {}
      return jsonResponse({ success: true, deleted: true }, 200, {
        'Set-Cookie': buildSessionCookie('', 0, secure),
        'Cache-Control': 'no-store',
      });
    }
    if (method === 'GET' && path === '/api/cloud/credits') {
      const [credits, rows] = await Promise.all([
        sbRpc(cfg, 'cloud_balance', { p_user_id: user.id }),
        sbFetch(cfg, 'GET', `/rest/v1/cloud_ledger?user_id=eq.${encodeURIComponent(user.id)}&select=delta,reason,ref,balance_after,created_at&order=id.desc&limit=50`),
      ]);
      return jsonResponse({
        success: true,
        credits: Number(credits) || 0,
        ledger: (rows || []).map((r) => ({ delta: Number(r.delta) || 0, reason: r.reason || '', ref: r.ref || '', balanceAfter: Number(r.balance_after) || 0, createdAt: r.created_at })),
      });
    }
    if (method === 'GET' && path === '/api/cloud/plans') {
      return jsonResponse({ success: true, plans: cfg.plans, costs: cfg.costs, providers: { sepay: cfg.sepay.ready, lemonsqueezy: cfg.lemon.ready } });
    }
    if (method === 'GET' && path === '/api/cloud/projects') {
      const rows = await sbFetch(cfg, 'GET', `/rest/v1/cloud_projects?user_id=eq.${encodeURIComponent(user.id)}&select=id,name,size_bytes,created_at,updated_at&order=updated_at.desc`);
      return jsonResponse({
        success: true,
        projects: (rows || []).map((r) => ({ id: r.id, name: r.name || '', sizeBytes: Number(r.size_bytes) || 0, createdAt: r.created_at, updatedAt: r.updated_at })),
      });
    }
    if (method === 'POST' && path === '/api/cloud/projects') {
      const { data } = await readJsonBody(request, cfg.maxProjectBytes + 65536);
      if (!data.data || typeof data.data !== 'object') throw new CloudError('E_INVALID_ARG', 'Thiếu dữ liệu dự án.', 400);
      const serialized = JSON.stringify(data.data);
      const sizeBytes = new TextEncoder().encode(serialized).byteLength;
      if (sizeBytes > cfg.maxProjectBytes) throw new CloudError('E_TOO_LARGE', 'Dự án vượt giới hạn dung lượng.', 413);
      const projectId = data.id ? String(data.id).trim() : crypto.randomUUID();
      if (!SAFE_ID_RE.test(projectId)) throw new CloudError('E_INVALID_ARG', 'projectId không hợp lệ.', 400);
      const name = safeName(data.name, 'Dự án không tên');
      const existingRows = await sbFetch(cfg, 'GET', `/rest/v1/cloud_projects?id=eq.${encodeURIComponent(projectId)}&select=id,user_id,size_bytes,created_at&limit=1`);
      const existing = Array.isArray(existingRows) ? existingRows[0] : null;
      if (existing && existing.user_id !== user.id) throw new CloudError('E_NOT_FOUND', 'Không tìm thấy dự án.', 404);
      const statsRaw = (await sbRpc(cfg, 'cloud_stats', { p_user_id: user.id })) || {};
      const used = (Number(statsRaw.used_bytes) || 0) - (existing ? Number(existing.size_bytes) || 0 : 0);
      if (!existing && (Number(statsRaw.projects) || 0) >= cfg.maxProjects) throw new CloudError('E_QUOTA', 'Đã đạt số dự án tối đa.', 413);
      if (used + sizeBytes > cfg.maxTotalBytes) throw new CloudError('E_QUOTA', 'Vượt hạn mức dung lượng Cloud.', 413);
      const cost = cfg.costs.save_project;
      const chargeKey = `save:${projectId}:${crypto.randomUUID()}`;
      const balance = cost > 0
        ? Number(await sbRpc(cfg, 'cloud_charge', { p_user_id: user.id, p_amount: cost, p_reason: 'save_project', p_ref: projectId, p_key: chargeKey }))
        : Number(await sbRpc(cfg, 'cloud_balance', { p_user_id: user.id }));
      const now = new Date().toISOString();
      const row = { id: projectId, user_id: user.id, name, data: data.data, size_bytes: sizeBytes, updated_at: now };
      if (!existing) row.created_at = now;
      try {
        await sbFetch(cfg, 'POST', '/rest/v1/cloud_projects?on_conflict=id', { body: row, prefer: 'resolution=merge-duplicates,return=minimal' });
      } catch (err) {
        if (cost > 0) {
          try { await sbRpc(cfg, 'cloud_credit', { p_user_id: user.id, p_amount: cost, p_reason: 'refund_save_failed', p_ref: projectId, p_key: `refund:${chargeKey}` }); } catch {}
        }
        throw err;
      }
      return jsonResponse({
        success: true,
        project: { id: projectId, name, sizeBytes, createdAt: existing?.created_at || now, updatedAt: now, objectCount: Array.isArray(data.data.objects) ? data.data.objects.length : 0, credits: balance },
      });
    }
    const projMatch = path.match(ROUTE_PROJECT);
    if (projMatch) {
      const [, projectId, del] = projMatch;
      if (del) {
        if (method !== 'POST') throw new CloudError('E_INVALID_ARG', 'Method không hỗ trợ.', 405);
        await sbFetch(cfg, 'DELETE', `/rest/v1/cloud_projects?id=eq.${encodeURIComponent(projectId)}&user_id=eq.${encodeURIComponent(user.id)}`, { prefer: 'return=minimal' });
        return jsonResponse({ success: true });
      }
      if (method === 'GET') {
        const rows = await sbFetch(cfg, 'GET', `/rest/v1/cloud_projects?id=eq.${encodeURIComponent(projectId)}&user_id=eq.${encodeURIComponent(user.id)}&select=*&limit=1`);
        const row = Array.isArray(rows) ? rows[0] : null;
        if (!row) throw new CloudError('E_NOT_FOUND', 'Không tìm thấy dự án.', 404);
        return jsonResponse({ success: true, project: { id: row.id, name: row.name, sizeBytes: Number(row.size_bytes) || 0, createdAt: row.created_at, updatedAt: row.updated_at, data: row.data || {} } });
      }
      throw new CloudError('E_INVALID_ARG', 'Method không hỗ trợ.', 405);
    }

    if (method === 'GET' && path === '/api/cloud/assets') {
      const rows = await sbFetch(cfg, 'GET', `/rest/v1/cloud_assets?user_id=eq.${encodeURIComponent(user.id)}&select=id,user_id,name,title,category,tags,description,author_name,thumb_path,content_type,size_bytes,public,storage_path,created_at&order=created_at.desc`);
      return jsonResponse({ success: true, assets: (rows || []).map((r) => mapAssetRow(r, user.id, false)) });
    }
    if (method === 'POST' && path === '/api/cloud/assets') {
      const useR2 = Boolean(env?.HUNGER_ASSETS);
      const { data } = await readJsonBody(request, Math.ceil(cfg.maxAssetBytes * 1.38) + 65536);
      const glbBytes = validateGlbBytes(base64ToBytes(data.dataBase64 || data.fileData));
      if (glbBytes.byteLength > cfg.maxAssetBytes) throw new CloudError('E_TOO_LARGE', 'GLB vượt giới hạn dung lượng.', 413);
      const thumbBytes = data.thumbnailBase64 ? validatePngBytes(base64ToBytes(data.thumbnailBase64)) : null;

      let fileName = safeName(data.fileName, 'model.glb');
      if (!fileName.toLowerCase().endsWith('.glb')) fileName += '.glb';
      const assetId = crypto.randomUUID();
      const storagePath = useR2 ? `user_uploads/${user.id}/${assetId}.glb` : `${user.id}/${assetId}.glb`;
      const thumbPath = thumbBytes ? (useR2 ? `user_uploads/${user.id}/${assetId}.png` : `${user.id}/${assetId}.png`) : '';
      const isPublic = data.public !== false;
      const cost = cfg.costs.upload_asset;
      const chargeKey = `asset:${assetId}:${crypto.randomUUID()}`;

      // Atomic quota + credit + DB row reservation via Postgres RPC
      const reserved = await sbRpc(cfg, 'cloud_reserve_asset', {
        p_user_id: user.id,
        p_asset_id: assetId,
        p_name: fileName,
        p_title: safeName(data.title, fileName.replace(/\.glb$/i, '')),
        p_category: validateCategory(data.category),
        p_tags: validateTags(data.tags),
        p_description: String(data.description || '').trim().slice(0, 500),
        p_author_name: safeName(data.authorName, authorDisplayName(user.email)).slice(0, 40),
        p_thumb_path: thumbPath,
        p_content_type: 'model/gltf-binary',
        p_size_bytes: glbBytes.byteLength,
        p_storage_path: storagePath,
        p_public: isPublic,
        p_max_assets: cfg.maxAssets,
        p_max_total_bytes: cfg.maxTotalBytes,
        p_cost: cost,
        p_charge_key: chargeKey,
      });

      try {
        if (useR2) {
          await env.HUNGER_ASSETS.put(storagePath, glbBytes, { httpMetadata: { contentType: 'model/gltf-binary' } });
          if (thumbBytes && thumbPath) {
            await env.HUNGER_ASSETS.put(thumbPath, thumbBytes, { httpMetadata: { contentType: 'image/png' } });
          }
        } else {
          await sbStorageUpload(cfg, storagePath, glbBytes, 'model/gltf-binary');
          if (thumbBytes && thumbPath) {
            await sbStorageUpload(cfg, thumbPath, thumbBytes, 'image/png');
          }
        }
      } catch (err) {
        try { await sbFetch(cfg, 'DELETE', `/rest/v1/cloud_assets?id=eq.${encodeURIComponent(assetId)}&user_id=eq.${encodeURIComponent(user.id)}`, { prefer: 'return=minimal' }); } catch {}
        if (useR2) {
          try { await env.HUNGER_ASSETS.delete(storagePath); if (thumbPath) await env.HUNGER_ASSETS.delete(thumbPath); } catch {}
        } else {
          await sbStorageDelete(cfg, [storagePath, thumbPath]);
        }
        if (cost > 0) {
          try { await sbRpc(cfg, 'cloud_credit', { p_user_id: user.id, p_amount: cost, p_reason: 'refund_upload_failed', p_ref: assetId, p_key: `refund:${chargeKey}` }); } catch {}
        }
        throw new CloudError('E_PROVIDER', `Lưu tệp lên Storage thất bại: ${err?.message || err}`, 502);
      }

      const row = {
        id: assetId, user_id: user.id, name: fileName,
        title: safeName(data.title, fileName.replace(/\.glb$/i, '')),
        category: validateCategory(data.category), tags: validateTags(data.tags),
        description: String(data.description || '').trim().slice(0, 500),
        author_name: safeName(data.authorName, authorDisplayName(user.email)).slice(0, 40),
        thumb_path: thumbPath, content_type: 'model/gltf-binary', size_bytes: glbBytes.byteLength,
        storage_path: storagePath, public: isPublic, created_at: reserved?.created_at || new Date().toISOString(),
      };
      return jsonResponse({ success: true, asset: { ...mapAssetRow(row, user.id, true), credits: Number(reserved?.credits) || 0 } });
    }

    const assetMatch = path.match(ROUTE_ASSET);
    if (assetMatch) {
      const [, assetId, action] = assetMatch;
      const rows = await sbFetch(cfg, 'GET', `/rest/v1/cloud_assets?id=eq.${encodeURIComponent(assetId)}&user_id=eq.${encodeURIComponent(user.id)}&select=*&limit=1`);
      const row = Array.isArray(rows) ? rows[0] : null;
      if (!row) throw new CloudError('E_NOT_FOUND', 'Không tìm thấy tệp.', 404);
      if (action === '/delete') {
        if (method !== 'POST') throw new CloudError('E_INVALID_ARG', 'Method không hỗ trợ.', 405);
        await sbFetch(cfg, 'DELETE', `/rest/v1/cloud_assets?id=eq.${encodeURIComponent(assetId)}&user_id=eq.${encodeURIComponent(user.id)}`, { prefer: 'return=minimal' });
        if (env?.HUNGER_ASSETS) {
          for (const k of [row.storage_path, row.thumb_path]) {
            if (k) { try { await env.HUNGER_ASSETS.delete(k.startsWith('user_uploads/') ? k : `user_uploads/${k}`); } catch {} }
          }
        } else {
          await sbStorageDelete(cfg, [row.storage_path, row.thumb_path]);
        }
        return jsonResponse({ success: true });
      }
      if (action === '/download' && method === 'GET') {
        if (env?.HUNGER_ASSETS && row.storage_path) {
          const r2Key = row.storage_path.startsWith('user_uploads/') ? row.storage_path : `user_uploads/${row.storage_path}`;
          const obj = await env.HUNGER_ASSETS.get(r2Key);
          if (obj) {
            return new Response(obj.body, {
              status: 200,
              headers: {
                'Content-Type': row.content_type || 'model/gltf-binary',
                'X-Content-Type-Options': 'nosniff',
                'Cache-Control': 'private, no-store',
              },
            });
          }
        }
        const signed = await sbSignedUrl(cfg, row.storage_path, 120);
        return Response.redirect(signed, 302);
      }
      if (!action && method === 'GET') {
        return jsonResponse({ success: true, asset: mapAssetRow(row, user.id, true) });
      }
      throw new CloudError('E_INVALID_ARG', 'Method không hỗ trợ.', 405);
    }

    if (method === 'GET' && path === '/api/cloud/payments') {
      const rows = await sbFetch(cfg, 'GET', `/rest/v1/cloud_payments?user_id=eq.${encodeURIComponent(user.id)}&select=*&order=created_at.desc&limit=30`);
      return jsonResponse({ success: true, payments: (rows || []).map(mapPaymentRow) });
    }
    const payMatch = path.match(ROUTE_PAYMENT);
    if (method === 'GET' && payMatch) {
      const code = payMatch[1].toUpperCase();
      const rows = await sbFetch(cfg, 'GET', `/rest/v1/cloud_payments?code=eq.${encodeURIComponent(code)}&user_id=eq.${encodeURIComponent(user.id)}&select=*&limit=1`);
      const row = Array.isArray(rows) ? rows[0] : null;
      if (!row) throw new CloudError('E_NOT_FOUND', 'Không tìm thấy giao dịch.', 404);
      const credits = Number(await sbRpc(cfg, 'cloud_balance', { p_user_id: user.id })) || 0;
      return jsonResponse({ success: true, payment: mapPaymentRow(row), credits });
    }
    if (method === 'POST' && path === '/api/cloud/checkout') {
      const { data } = await readJsonBody(request, 16 * 1024);
      const plan = cfg.plans.find((p) => p.id === String(data.plan || '').trim().toLowerCase());
      if (!plan) throw new CloudError('E_INVALID_ARG', 'Gói credit không hợp lệ.', 400);
      const provider = String(data.provider || 'sepay').trim().toLowerCase();
      if (provider !== 'sepay' && provider !== 'lemonsqueezy') throw new CloudError('E_INVALID_ARG', 'Cổng thanh toán không hợp lệ.', 400);
      if (provider === 'sepay' && !cfg.sepay.ready) throw new CloudError('E_PROVIDER', 'SePay/VietQR chưa được cấu hình.', 503);
      if (provider === 'lemonsqueezy' && !cfg.lemon.ready) throw new CloudError('E_PROVIDER', 'LemonSqueezy chưa được cấu hình.', 503);

      const paymentId = crypto.randomUUID();
      const code = generatePaymentCode();
      const now = new Date().toISOString();
      const expiresAt = new Date(Date.now() + cfg.paymentTtlSeconds * 1000).toISOString();
      await sbFetch(cfg, 'POST', '/rest/v1/cloud_payments', {
        body: {
          id: paymentId, user_id: user.id, provider, plan_id: plan.id, code,
          amount_vnd: plan.priceVnd, credits: plan.credits, status: 'pending',
          meta: { email: user.email, label: plan.label }, created_at: now, expires_at: expiresAt,
        },
        prefer: 'return=minimal',
      });
      const payment = { id: paymentId, code, provider, planId: plan.id, amountVnd: plan.priceVnd, credits: plan.credits, status: 'pending', createdAt: now, expiresAt, paidAt: null };
      let checkout;
      if (provider === 'sepay') {
        const qs = new URLSearchParams({ amount: String(plan.priceVnd), addInfo: code, accountName: cfg.sepay.holder });
        const tpl = ['compact', 'compact2', 'qr_only', 'print'].includes(cfg.sepay.qrTemplate) ? cfg.sepay.qrTemplate : 'compact2';
        checkout = {
          type: 'vietqr', provider: 'sepay', code, amountVnd: plan.priceVnd, credits: plan.credits,
          bank: cfg.sepay.bank, account: cfg.sepay.account, holder: cfg.sepay.holder,
          transferContent: code,
          qrUrl: `https://img.vietqr.io/image/${encodeURIComponent(cfg.sepay.bank)}-${encodeURIComponent(cfg.sepay.account)}-${tpl}.png?${qs}`,
          expiresInSeconds: cfg.paymentTtlSeconds, expiresAt,
        };
      } else {
        const variant = cfg.lemon.variants[plan.id];
        if (!variant) throw new CloudError('E_PROVIDER', 'Chưa cấu hình variant LemonSqueezy cho gói này.', 503);
        const resp = await fetch('https://api.lemonsqueezy.com/v1/checkouts', {
          method: 'POST',
          headers: {
            Accept: 'application/vnd.api+json', 'Content-Type': 'application/vnd.api+json',
            Authorization: `Bearer ${cfg.lemon.apiKey}`, 'User-Agent': 'HungerStudio/2.0',
          },
          body: JSON.stringify({
            data: {
              type: 'checkouts',
              attributes: {
                checkout_data: { email: user.email, custom: { payment_code: code, user_id: user.id } },
                product_options: { name: `Hunger — ${plan.credits} credits`, redirect_url: `${url.origin}/?cloud=paid&code=${encodeURIComponent(code)}` },
              },
              relationships: {
                store: { data: { type: 'stores', id: cfg.lemon.storeId } },
                variant: { data: { type: 'variants', id: variant } },
              },
            },
          }),
        });
        const lsData = await resp.json().catch(() => null);
        const checkoutUrl = lsData?.data?.attributes?.url;
        if (!resp.ok || !String(checkoutUrl || '').startsWith('https://')) {
          throw new CloudError('E_PROVIDER', `LemonSqueezy trả HTTP ${resp.status}.`, 502);
        }
        checkout = { type: 'checkout_url', provider: 'lemonsqueezy', code, amountVnd: plan.priceVnd, credits: plan.credits, checkoutUrl };
      }
      return jsonResponse({ success: true, payment, checkout, providers: { sepay: cfg.sepay.ready, lemonsqueezy: cfg.lemon.ready } });
    }

    throw new CloudError('E_NOT_FOUND', 'Endpoint cloud không tồn tại.', 404);
  } catch (err) {
    if (err instanceof CloudError) return err.toResponse();
    return jsonResponse({ success: false, error: { code: 'E_INTERNAL', message: 'Cloud request failed.', hint: '' } }, 500, { 'Cache-Control': 'no-store' });
  }
}

export const __cloudBffInternals = {
  hmacSha256Hex,
  timingSafeEqualStr,
  validateGlbBytes,
  validatePngBytes,
};
