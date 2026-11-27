/**
 * Hunger 3D Studio — Cloudflare Worker (100% Serverless: Static Assets + R2 CDN + Cloud BFF)
 *
 * Responsibilities:
 *  1. Handle `/healthz`, `/api/status`, `/api/config`, `/api/ai/chat`, and ALL `/api/cloud/*`
 *     natively at the Cloudflare edge using Supabase Postgres/Auth (`SUPABASE_SERVICE_KEY` secret)
 *     and Cloudflare R2 (`HUNGER_ASSETS`) — zero separate VPS/Docker required.
 *  2. Optionally proxy local-only heavy Python routes (`/api/import/blend`, `/api/hunyuan3d/*`,
 *     `/api/mocap/*`) to `env.API_ORIGIN` if an external GPU/Blender worker is attached.
 *  3. Serve heavy runtime assets (`/models/*`, `/vendor/mediapipe/*`, `/assets/characters/*`,
 *     `/assets/environments/*`) from Cloudflare R2 (`env.HUNGER_ASSETS`) with HTTP Range (206),
 *     ETag (304), and edge caching — falling back transparently to `env.ASSETS`.
 *  4. Enforce exact security & isolation headers matching server.py (COOP/COEP, Embed CSP,
 *     and strict isolated Worker CSP on `/assets/*-exec-worker-*.js`).
 */

import { handleCloudBff } from './cloud-bff.js';
import { handleBridgeRoute, handleMcpEndpoint } from './mcp-endpoint.js';
export { StudioBridgeHub } from './bridge-do.js';

const EXEC_WORKER_RE = /^\/(?:assets\/(?:agent|copilot)-exec-worker-[A-Za-z0-9_-]+\.js|js\/(?:agent\/agent|ai\/copilot)-exec-worker\.js)$/;
const R2_PREFIXES = ['/models/', '/vendor/mediapipe/', '/assets/characters/', '/assets/environments/'];
const NATIVE_API_PATHS = new Set(['/healthz', '/api/status', '/api/config', '/api/ai/chat', '/api/telemetry/event', '/api/telemetry/summary']);
const LANDING_PATHS = new Set(['/motion', '/motion/', '/motion.html', '/landing', '/landing/']);

const EXEC_WORKER_CSP =
  "default-src 'none'; script-src 'self' 'unsafe-eval'; connect-src 'none'; " +
  "worker-src 'none'; child-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";

const CONTENT_TYPES = {
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.bin': 'application/octet-stream',
  '.wasm': 'application/wasm',
  '.task': 'application/octet-stream',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.json': 'application/json; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
};

function guessContentType(key) {
  const dot = key.lastIndexOf('.');
  if (dot < 0) return 'application/octet-stream';
  return CONTENT_TYPES[key.slice(dot).toLowerCase()] || 'application/octet-stream';
}

function normalizeR2Key(pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes('\0') || decoded.includes('\\')) return null;
  const segments = decoded.replace(/^\/+/, '').split('/');
  if (!segments.length || segments.some((s) => !s || s === '.' || s === '..')) return null;
  return segments.join('/');
}

function isEmbedPath(pathname) {
  return pathname === '/embed.html' || pathname === '/embed' || pathname === '/embed/';
}

function buildHtmlCsp(pathname, env) {
  const extraOrigins = [];
  for (const raw of [env?.SUPABASE_URL, env?.R2_PUBLIC_URL]) {
    if (!raw) continue;
    try {
      const u = new URL(String(raw).trim());
      if (u.protocol === 'https:' || u.protocol === 'http:') extraOrigins.push(u.origin);
    } catch {
      // ignore invalid origin
    }
  }
  const extra = extraOrigins.length ? ' ' + extraOrigins.join(' ') : '';
  if (isEmbedPath(pathname)) {
    return (
      "default-src 'self'; " +
      "script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' blob:; " +
      "style-src 'self' 'unsafe-inline'; " +
      `img-src 'self' data: blob: https:${extra}; ` +
      "font-src 'self' data:; " +
      `media-src 'self' blob: data: https:${extra}; ` +
      "worker-src 'self' blob:; " +
      `connect-src 'self' blob: data: https:${extra}; ` +
      "object-src 'none'; base-uri 'self'; frame-ancestors *"
    );
  }
  return (
    "default-src 'self'; " +
    "script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' blob:; " +
    "style-src 'self' 'unsafe-inline'; " +
    `img-src 'self' data: blob: https://*.supabase.co https://img.vietqr.io https://dl.polyhaven.org https://cdn.polyhaven.com https://cdn.polyhaven.org https://raw.githubusercontent.com${extra}; ` +
    "font-src 'self' data:; " +
    `media-src 'self' blob: data:${extra}; ` +
    "worker-src 'self' blob:; " +
    `connect-src 'self' ws: wss: blob: data: https://*.supabase.co https://api.polyhaven.com https://dl.polyhaven.org https://cdn.polyhaven.com https://cdn.polyhaven.org https://raw.githubusercontent.com${extra}; ` +
    "object-src 'none'; base-uri 'self'; frame-ancestors 'self'"
  );
}

function applySecurityHeaders(response, pathname, env) {
  const headers = new Headers(response.headers);
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  headers.set('Permissions-Policy', 'camera=(), geolocation=()');

  if (EXEC_WORKER_RE.test(pathname)) {
    headers.set('Content-Type', 'text/javascript; charset=utf-8');
    headers.set('Content-Security-Policy', EXEC_WORKER_CSP);
    headers.set('Cross-Origin-Resource-Policy', 'same-origin');
    headers.set('Cache-Control', 'no-cache');
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  }

  if (isEmbedPath(pathname)) {
    headers.delete('Cross-Origin-Opener-Policy');
    headers.delete('X-Frame-Options');
    headers.set('Cross-Origin-Embedder-Policy', 'credentialless');
    headers.set('Cross-Origin-Resource-Policy', 'cross-origin');
    headers.set('Content-Security-Policy', buildHtmlCsp(pathname, env));
    headers.set('Cache-Control', 'no-cache');
  } else {
    headers.set('Cross-Origin-Opener-Policy', 'same-origin');
    headers.set('Cross-Origin-Embedder-Policy', 'credentialless');
    headers.set('X-Frame-Options', 'SAMEORIGIN');
    if (pathname === '/' || pathname.endsWith('.html') || pathname.endsWith('.htm')) {
      headers.set('Content-Security-Policy', buildHtmlCsp(pathname, env));
      headers.set('Cache-Control', 'no-cache');
    } else if (pathname.startsWith('/assets/')) {
      headers.set('Cache-Control', 'public, max-age=31536000, immutable');
    }
  }

  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function parseSingleRange(rangeHeader, totalSize) {
  if (!rangeHeader || !rangeHeader.startsWith('bytes=')) return null;
  const spec = rangeHeader.slice(6).split(',')[0].trim();
  const [startRaw, endRaw] = spec.split('-');
  if (startRaw === '' && endRaw === '') return null;
  let start;
  let end;
  if (startRaw === '') {
    const suffix = Number.parseInt(endRaw, 10);
    if (!Number.isFinite(suffix) || suffix <= 0) return null;
    start = Math.max(0, totalSize - suffix);
    end = totalSize - 1;
  } else {
    start = Number.parseInt(startRaw, 10);
    end = endRaw ? Number.parseInt(endRaw, 10) : totalSize - 1;
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || start > end || start >= totalSize) {
      return { invalid: true };
    }
    end = Math.min(end, totalSize - 1);
  }
  return { offset: start, length: end - start + 1, start, end };
}

async function serveFromR2(request, env, pathname) {
  if (!env?.HUNGER_ASSETS) return null;
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('Method Not Allowed', { status: 405 });
  }
  const key = normalizeR2Key(pathname);
  if (!key) return new Response('Bad Request', { status: 400 });

  const rangeHeader = request.headers.get('Range');
  let object;
  let rangeInfo = null;

  if (rangeHeader) {
    const head = await env.HUNGER_ASSETS.head(key);
    if (!head) return null;
    rangeInfo = parseSingleRange(rangeHeader, head.size);
    if (rangeInfo?.invalid) {
      return new Response(null, {
        status: 416,
        headers: { 'Content-Range': `bytes */${head.size}` },
      });
    }
    object = rangeInfo
      ? await env.HUNGER_ASSETS.get(key, { range: { offset: rangeInfo.offset, length: rangeInfo.length } })
      : await env.HUNGER_ASSETS.get(key);
  } else {
    object = request.method === 'HEAD'
      ? await env.HUNGER_ASSETS.head(key)
      : await env.HUNGER_ASSETS.get(key);
  }

  if (!object) return null;

  const headers = new Headers();
  if (typeof object.writeHttpMetadata === 'function') object.writeHttpMetadata(headers);
  if (!headers.has('Content-Type')) headers.set('Content-Type', guessContentType(key));
  headers.set('Accept-Ranges', 'bytes');
  headers.set('Cache-Control', 'public, max-age=86400, stale-while-revalidate=604800');
  headers.set('Cross-Origin-Resource-Policy', 'cross-origin');
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('X-Asset-Source', 'cloudflare-r2');
  if (object.httpEtag) headers.set('ETag', object.httpEtag);

  const ifNoneMatch = request.headers.get('If-None-Match');
  if (ifNoneMatch && object.httpEtag && ifNoneMatch.replace(/^W\//, '') === object.httpEtag.replace(/^W\//, '')) {
    return new Response(null, { status: 304, headers });
  }

  if (rangeInfo && !rangeInfo.invalid) {
    headers.set('Content-Range', `bytes ${rangeInfo.start}-${rangeInfo.end}/${object.size}`);
    headers.set('Content-Length', String(rangeInfo.length));
    return new Response(request.method === 'HEAD' ? null : object.body, { status: 206, headers });
  }

  if (Number.isFinite(object.size)) headers.set('Content-Length', String(object.size));
  return new Response(request.method === 'HEAD' ? null : object.body, { status: 200, headers });
}

async function proxyToApiOrigin(request, env, url) {
  const originRaw = String(env?.API_ORIGIN || '').trim().replace(/\/+$/, '');
  if (!originRaw) {
    return new Response(
      JSON.stringify({
        ok: false,
        error: {
          code: 'E_BACKEND_UNCONFIGURED',
          message: 'API_ORIGIN is not configured on the Cloudflare Worker.',
        },
      }),
      { status: 503, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } }
    );
  }
  const target = new URL(url.pathname + url.search, originRaw);
  const fwdHeaders = new Headers(request.headers);
  fwdHeaders.set('X-Forwarded-Host', url.host);
  fwdHeaders.set('X-Forwarded-Proto', url.protocol.replace(':', ''));
  const init = {
    method: request.method,
    headers: fwdHeaders,
    redirect: 'manual',
  };
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    init.body = request.body;
  }
  return fetch(target.toString(), init);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const pathname = url.pathname;

    if (pathname === '/mcp') {
      return handleMcpEndpoint(request, env, url);
    }

    if (pathname.startsWith('/api/cloud/') || NATIVE_API_PATHS.has(pathname)) {
      return handleCloudBff(request, env, url);
    }

    if (pathname.startsWith('/api/')) {
      const bridgeRes = await handleBridgeRoute(request, env, url);
      if (bridgeRes) return bridgeRes;
      return proxyToApiOrigin(request, env, url);
    }

    if (R2_PREFIXES.some((prefix) => pathname.startsWith(prefix))) {
      const r2Response = await serveFromR2(request, env, pathname);
      if (r2Response) return r2Response;
    }

    if (!env?.ASSETS) {
      return new Response('Static ASSETS binding is not configured.', { status: 500 });
    }
    if (LANDING_PATHS.has(pathname)) {
      // Cloudflare Static Assets maps `/motion` -> `motion.html` cleanly without 307 redirect loops.
      // Fallback to `/motion.html` if an ASSETS mock (e.g. unit tests) serves exact filenames only.
      let landingResp = await env.ASSETS.fetch(new Request(new URL('/motion', url.origin).toString(), request));
      if (landingResp.status === 404 || (landingResp.status >= 300 && landingResp.status < 400)) {
        landingResp = await env.ASSETS.fetch(new Request(new URL('/motion.html', url.origin).toString(), request));
      }
      return applySecurityHeaders(landingResp, '/motion.html', env);
    }
    const assetResponse = await env.ASSETS.fetch(request);
    return applySecurityHeaders(assetResponse, pathname, env);
  },
};

export const __cloudflareWorkerInternals = {
  EXEC_WORKER_RE,
  EXEC_WORKER_CSP,
  normalizeR2Key,
  parseSingleRange,
  buildHtmlCsp,
  applySecurityHeaders,
};
