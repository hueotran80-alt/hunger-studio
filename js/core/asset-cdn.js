/**
 * Hunger 3D Studio / Hunger Motion — Runtime Asset CDN & Lazy Media Resolver
 * File: js/core/asset-cdn.js
 *
 * Resolves heavy runtime assets (`models/*`, `vendor/mediapipe/*`, `assets/characters/*`,
 * `assets/environments/*`) against an optional external CDN origin (e.g. Cloudflare R2
 * custom domain configured via `<meta name="hunger-cdn-base">` or `window.__HUNGER_CDN_BASE__`)
 * while seamlessly falling back to same-origin Edge R2 proxy routes (`/models/...`).
 */

const CDN_PREFIXES = [
  'models/',
  'vendor/mediapipe/',
  'assets/characters/',
  'assets/environments/',
];

let _cachedBase = null;

function readMetaCdnBase() {
  if (typeof document === 'undefined') return '';
  try {
    const meta = document.querySelector('meta[name="hunger-cdn-base"]');
    return String(meta?.getAttribute('content') || '').trim();
  } catch (_) {
    return '';
  }
}

export function getCdnBaseUrl() {
  if (_cachedBase !== null) return _cachedBase;
  const raw = (typeof window !== 'undefined' && window.__HUNGER_CDN_BASE__)
    ? String(window.__HUNGER_CDN_BASE__).trim()
    : readMetaCdnBase();
  if (!raw) {
    _cachedBase = '';
    return '';
  }
  try {
    const u = new URL(raw);
    if (u.protocol === 'https:' || u.protocol === 'http:') {
      _cachedBase = u.origin + u.pathname.replace(/\/+$/, '');
      return _cachedBase;
    }
  } catch (_) {}
  _cachedBase = '';
  return '';
}

export function setCdnBaseUrl(url) {
  if (!url) {
    _cachedBase = '';
    return '';
  }
  try {
    const u = new URL(String(url).trim());
    if (u.protocol === 'https:' || u.protocol === 'http:') {
      _cachedBase = u.origin + u.pathname.replace(/\/+$/, '');
      return _cachedBase;
    }
  } catch (_) {}
  _cachedBase = '';
  return '';
}

export function isCdnEligiblePath(assetPath) {
  const clean = String(assetPath || '').trim().replace(/^\/+/, '');
  return CDN_PREFIXES.some((prefix) => clean.startsWith(prefix));
}

export function resolveCdnAssetUrl(assetPath) {
  const raw = String(assetPath || '').trim();
  if (!raw || /^(?:https?:|blob:|data:)/i.test(raw)) return raw;
  const clean = raw.replace(/^\.\//, '').replace(/^\/+/, '');
  const base = getCdnBaseUrl();
  if (base && isCdnEligiblePath(clean)) {
    return `${base}/${clean}`;
  }
  return raw.startsWith('/') ? raw : `/${clean}`;
}

export function prefetchAssetHint(assetPath, asType = 'fetch') {
  if (typeof document === 'undefined' || !document.head) return null;
  const href = resolveCdnAssetUrl(assetPath);
  if (!href) return null;
  const existing = document.head.querySelector(`link[rel="prefetch"][href="${href}"]`);
  if (existing) return existing;
  const link = document.createElement('link');
  link.rel = 'prefetch';
  link.href = href;
  if (asType) link.as = asType;
  link.crossOrigin = 'anonymous';
  document.head.appendChild(link);
  return link;
}

export function getCdnConfig() {
  return {
    baseUrl: getCdnBaseUrl(),
    mode: getCdnBaseUrl() ? 'external-cdn' : 'edge-r2-origin',
    prefixes: [...CDN_PREFIXES],
  };
}
