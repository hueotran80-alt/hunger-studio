/**
 * Cloud client — talks only to the same-origin /api/cloud/* BFF.
 * Supabase is used for password/magic-link auth only; project data and credits
 * always flow through the server so quotas and the ledger stay authoritative.
 */

const SESSION_KEY = 'wbs_cloud_session_v1';
const STATUS_TTL_MS = 30_000;
const REFRESH_AHEAD_MS = 60_000;
const OAUTH_PROVIDERS = new Set(['google', 'github']);

export class CloudApiError extends Error {
  constructor(message, { code = 'E_CLOUD', status = 0, hint = '' } = {}) {
    super(message);
    this.name = 'CloudApiError';
    this.code = code;
    this.status = status;
    this.hint = hint;
  }
}

function memoryStorage() {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key)
  };
}

function defaultStorage() {
  try {
    if (typeof localStorage !== 'undefined') {
      const probe = '__wbs_cloud_probe__';
      localStorage.setItem(probe, '1');
      localStorage.removeItem(probe);
      return localStorage;
    }
  } catch (_) { /* private mode / disabled storage */ }
  return memoryStorage();
}

function bytesToBase64(bytes) {
  const chunk = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function base64ToText(text) {
  const padded = text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4);
  return atob(padded);
}

/**
 * Reads display-only fields from a Supabase access token. Never used for
 * authorization decisions; the server validates the token itself.
 * @param {string} token
 */
export function decodeJwtPayload(token) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length < 2) return null;
  try {
    return JSON.parse(base64ToText(parts[1]));
  } catch (_) {
    return null;
  }
}

/**
 * Parses a Supabase implicit-flow redirect such as
 * `#access_token=...&refresh_token=...&expires_in=3600&type=magiclink`
 * or `#access_token=...&type=recovery` or OAuth callback hash.
 * @param {string} hash
 * @param {number} [nowMs]
 */
export function parseAuthHash(hash, nowMs = Date.now()) {
  const raw = String(hash || '').replace(/^#/, '');
  if (!raw) return null;
  const params = new URLSearchParams(raw);
  const error = params.get('error_description') || params.get('error');
  const authType = String(params.get('type') || '').trim().toLowerCase();
  if (error) {
    return { error: String(error).replace(/\+/g, ' '), type: authType, session: null };
  }
  const accessToken = params.get('access_token');
  if (!accessToken) return null;
  const expiresIn = Number(params.get('expires_in')) || 3600;
  const payload = decodeJwtPayload(accessToken) || {};
  return {
    error: null,
    type: authType,
    session: {
      provider: 'supabase',
      authType,
      accessToken,
      refreshToken: params.get('refresh_token') || '',
      expiresAt: nowMs + Math.max(30, expiresIn) * 1000,
      user: {
        id: payload.sub || '',
        email: payload.email || ''
      }
    }
  };
}

/**
 * Parses OAuth/Auth error query parameters (`?error=...&error_description=...`).
 * @param {string} search
 */
export function parseAuthQueryError(search) {
  const raw = String(search || '').replace(/^\?/, '');
  if (!raw) return null;
  const params = new URLSearchParams(raw);
  const err = params.get('error_description') || params.get('error');
  if (!err) return null;
  return String(err).replace(/\+/g, ' ');
}

async function responseJson(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch (_) {
    return { error: text.slice(0, 300) };
  }
}

export class CloudClient {
  constructor({ fetchImpl, storage, location, origin, baseUrl, now } = {}) {
    this.fetchImpl = fetchImpl || (typeof fetch === 'function' ? fetch.bind(globalThis) : null);
    this.storage = storage || defaultStorage();
    this.location = location || (typeof globalThis !== 'undefined' ? globalThis.location : null) || null;
    const configuredBase = baseUrl || (typeof globalThis !== 'undefined' ? globalThis.__WBS_API_BASE__ : '') || '';
    this.origin = origin || String(configuredBase).replace(/\/+$/, '') || (this.location && this.location.origin) || '';
    this.now = now || (() => Date.now());
    this._status = null;
    this._statusAt = 0;
    this._refreshPromise = null;
    this._session = this._loadSession();
  }

  get session() {
    return this._session ? { ...this._session, user: { ...this._session.user } } : null;
  }

  isSignedIn() {
    const session = this._session;
    if (!session || !session.accessToken) return false;
    if (session.provider === 'supabase' && session.refreshToken) return true;
    return !session.expiresAt || session.expiresAt > this.now();
  }

  _loadSession() {
    try {
      const raw = this.storage.getItem(SESSION_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || !parsed.accessToken) return null;
      if (parsed.provider !== 'supabase' && parsed.expiresAt && parsed.expiresAt <= this.now()) {
        this.storage.removeItem(SESSION_KEY);
        return null;
      }
      return parsed;
    } catch (_) {
      return null;
    }
  }

  _saveSession(session) {
    this._session = session;
    try {
      this.storage.setItem(SESSION_KEY, JSON.stringify(session));
    } catch (_) { /* storage may be full or disabled */ }
    return session;
  }

  logout({ remote = false } = {}) {
    const session = this._session;
    this._session = null;
    try { this.storage.removeItem(SESSION_KEY); } catch (_) {}
    if (remote && session && session.provider === 'supabase' && this._status?.supabase?.url) {
      const url = `${this._status.supabase.url}/auth/v1/logout`;
      this.fetchImpl?.(url, {
        method: 'POST',
        headers: {
          apikey: this._status.supabase.anonKey,
          Authorization: `Bearer ${session.accessToken}`
        }
      }).catch(() => {});
    }
  }

  async status({ force = false } = {}) {
    if (!force && this._status && this.now() - this._statusAt < STATUS_TTL_MS) {
      return this._status;
    }
    try {
      const response = await this._fetch('/api/cloud/status', { method: 'GET' });
      const data = await responseJson(response);
      this._status = response.ok && data.success !== false
        ? data
        : { enabled: false, error: data.error?.message || data.error || 'Cloud unavailable' };
    } catch (error) {
      this._status = { enabled: false, error: error.message || 'Unable to connect to server' };
    }
    this._statusAt = this.now();
    return this._status;
  }

  _fetch(path, init) {
    if (!this.fetchImpl) {
      return Promise.reject(new CloudApiError('Fetch API is not available in this environment.'));
    }
    return this.fetchImpl(this.origin + path, init);
  }

  async _authHeaders(extra = {}) {
    const headers = { Accept: 'application/json', ...extra };
    if (this._session?.accessToken) {
      headers.Authorization = `Bearer ${this._session.accessToken}`;
    }
    return headers;
  }

  async _supabase(path, body) {
    const status = await this.status();
    if (!status.supabase?.url || !status.supabase?.anonKey) {
      throw new CloudApiError('Supabase Auth is not configured.', { code: 'E_PROVIDER' });
    }
    const response = await this.fetchImpl(`${status.supabase.url}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: status.supabase.anonKey
      },
      body: JSON.stringify(body)
    });
    const data = await responseJson(response);
    if (!response.ok) {
      throw new CloudApiError(
        data.error_description || data.msg || data.message || data.error || 'Sign-in failed.',
        { code: data.error_code || data.code || 'E_AUTH', status: response.status }
      );
    }
    return data;
  }

  _sessionFromSupabase(data) {
    if (!data || !data.access_token) return null;
    const expiresIn = Number(data.expires_in) || 3600;
    return {
      provider: 'supabase',
      accessToken: data.access_token,
      refreshToken: data.refresh_token || '',
      expiresAt: this.now() + Math.max(30, expiresIn) * 1000,
      user: {
        id: data.user?.id || decodeJwtPayload(data.access_token)?.sub || '',
        email: data.user?.email || decodeJwtPayload(data.access_token)?.email || ''
      }
    };
  }

  async devLogin(email) {
    const status = await this.status();
    if (!status.enabled) {
      throw new CloudApiError(status.error || 'Cloud is not enabled.', { code: 'E_CLOUD_DISABLED' });
    }
    if (!status.devLogin) {
      throw new CloudApiError('Dev login is not enabled.', { code: 'E_FORBIDDEN' });
    }
    const response = await this._fetch('/api/cloud/dev-login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email })
    });
    const data = await responseJson(response);
    if (!response.ok) throw this._errorFrom(response, data);
    return this._saveSession({
      provider: 'local',
      accessToken: data.session.token,
      refreshToken: '',
      expiresAt: Number(data.session.expiresAt) * 1000,
      user: { id: data.user.id, email: data.user.email }
    });
  }

  async supabaseSignIn(email, password) {
    const data = await this._supabase('/auth/v1/token?grant_type=password', { email, password });
    const session = this._sessionFromSupabase(data);
    if (!session) throw new CloudApiError('Supabase did not return a session.', { code: 'E_AUTH' });
    return this._saveSession(session);
  }

  async supabaseSignUp(email, password) {
    const data = await this._supabase('/auth/v1/signup', { email, password });
    const session = this._sessionFromSupabase(data);
    if (session) return { session: this._saveSession(session), needsConfirmation: false };
    return { session: null, needsConfirmation: true, user: data.user || null };
  }

  async supabaseMagicLink(email, redirectTo = '') {
    const target = this._safeRedirectTo(redirectTo);
    const query = target ? `?redirect_to=${encodeURIComponent(target)}` : '';
    return this._supabase(`/auth/v1/otp${query}`, {
      email,
      create_user: true,
      gotrue_meta_security: {}
    });
  }

  _safeRedirectTo(redirectTo = '') {
    const fallback = this.location ? this.location.origin + (this.location.pathname || '/') : '';
    const candidate = String(redirectTo || fallback || '').trim();
    if (!candidate) return '';
    try {
      const parsed = new URL(candidate, this.origin || fallback || undefined);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
      if (this.origin && parsed.origin !== new URL(this.origin).origin) return '';
      return parsed.origin + parsed.pathname;
    } catch (_) {
      return '';
    }
  }

  /**
   * Builds a Supabase GoTrue OAuth authorize URL for Google or GitHub sign-in.
   * @param {'google'|'github'} provider
   * @param {{ redirectTo?: string, scopes?: string }} [options]
   */
  async getOAuthUrl(provider, { redirectTo = '', scopes = '' } = {}) {
    const clean = String(provider || '').trim().toLowerCase();
    if (!OAUTH_PROVIDERS.has(clean)) {
      throw new CloudApiError(`Unsupported OAuth provider: ${clean || 'empty'}`, { code: 'E_INVALID_ARG', status: 400 });
    }
    const status = await this.status();
    if (!status.supabase?.url) {
      throw new CloudApiError('Supabase Auth is not configured.', { code: 'E_PROVIDER', status: 503 });
    }
    if (status.authProviders && status.authProviders[clean] === false) {
      throw new CloudApiError(`OAuth provider "${clean}" is disabled on this server.`, { code: 'E_FORBIDDEN', status: 403 });
    }
    const params = new URLSearchParams({ provider: clean });
    const target = this._safeRedirectTo(redirectTo);
    if (target) params.set('redirect_to', target);
    if (scopes) params.set('scopes', String(scopes).trim());
    return `${status.supabase.url}/auth/v1/authorize?${params.toString()}`;
  }

  /**
   * Starts OAuth sign-in by redirecting the current window to Supabase GoTrue.
   * @param {'google'|'github'} provider
   * @param {{ redirectTo?: string, scopes?: string }} [options]
   */
  async supabaseOAuthStart(provider, options = {}) {
    const url = await this.getOAuthUrl(provider, options);
    if (this.location && typeof this.location.assign === 'function') {
      this.location.assign(url);
    }
    return url;
  }

  /**
   * Sends a password recovery email via Supabase GoTrue (`/auth/v1/recover`).
   * @param {string} email
   * @param {string} [redirectTo]
   */
  async supabaseResetPassword(email, redirectTo = '') {
    const cleanEmail = String(email || '').trim();
    if (!cleanEmail || !cleanEmail.includes('@')) {
      throw new CloudApiError('Please enter a valid email address.', { code: 'E_INVALID_ARG', status: 400 });
    }
    const target = this._safeRedirectTo(redirectTo);
    const query = target ? `?redirect_to=${encodeURIComponent(target)}` : '';
    return this._supabase(`/auth/v1/recover${query}`, { email: cleanEmail });
  }

  /**
   * Updates the signed-in user's password via Supabase GoTrue (`PUT /auth/v1/user`).
   * Used both for `#type=recovery` password reset links and normal password updates.
   * @param {string} newPassword
   */
  async supabaseUpdatePassword(newPassword) {
    const pwd = String(newPassword || '');
    if (pwd.length < 6) {
      throw new CloudApiError('New password must be at least 6 characters.', { code: 'E_INVALID_ARG', status: 400 });
    }
    await this._ensureFresh();
    if (!this._session?.accessToken || this._session.provider !== 'supabase') {
      throw new CloudApiError('Sign in with your Supabase account or recovery link first.', { code: 'E_AUTH_REQUIRED', status: 401 });
    }
    const status = await this.status();
    if (!status.supabase?.url || !status.supabase?.anonKey) {
      throw new CloudApiError('Supabase Auth is not configured.', { code: 'E_PROVIDER', status: 503 });
    }
    const response = await this.fetchImpl(`${status.supabase.url}/auth/v1/user`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        apikey: status.supabase.anonKey,
        Authorization: `Bearer ${this._session.accessToken}`,
      },
      body: JSON.stringify({ password: pwd }),
    });
    const data = await responseJson(response);
    if (!response.ok) {
      throw new CloudApiError(
        data.error_description || data.msg || data.message || data.error || 'Password update failed.',
        { code: data.error_code || data.code || 'E_AUTH', status: response.status }
      );
    }
    return { updated: true, user: data };
  }

  async refreshSession() {
    if (this._refreshPromise) return this._refreshPromise;
    this._refreshPromise = (async () => {
      const session = this._session;
      if (!session || session.provider !== 'supabase' || !session.refreshToken) {
        throw new CloudApiError('Session has expired.', { code: 'E_AUTH_EXPIRED', status: 401 });
      }
      const data = await this._supabase('/auth/v1/token?grant_type=refresh_token', {
        refresh_token: session.refreshToken
      });
      const next = this._sessionFromSupabase(data);
      if (!next) throw new CloudApiError('Unable to refresh session.', { code: 'E_AUTH_EXPIRED', status: 401 });
      return this._saveSession(next);
    })();
    try {
      return await this._refreshPromise;
    } finally {
      this._refreshPromise = null;
    }
  }

  async handleAuthHash(hash) {
    const parsed = parseAuthHash(hash, this.now());
    if (!parsed) return null;
    if (parsed.error) {
      this._clearLocationHash();
      throw new CloudApiError(parsed.error, { code: 'E_AUTH' });
    }
    let session = parsed.session;
    if (session && this._status?.supabase?.url) {
      try {
        const response = await this.fetchImpl(`${this._status.supabase.url}/auth/v1/user`, {
          headers: {
            apikey: this._status.supabase.anonKey,
            Authorization: `Bearer ${session.accessToken}`
          }
        });
        const user = await responseJson(response);
        if (response.ok && user.id) {
          session = { ...session, user: { id: user.id, email: user.email || session.user.email } };
        }
      } catch (_) { /* token details are optional */ }
    }
    this._saveSession(session);
    this._clearLocationHash();
    return session;
  }

  _clearLocationHash() {
    try {
      if (this.location?.pathname && typeof history !== 'undefined') {
        history.replaceState(null, '', this.location.pathname + this.location.search);
      }
    } catch (_) {}
  }

  async _ensureFresh() {
    const session = this._session;
    if (!session) return;
    if (session.provider === 'supabase' && session.expiresAt && session.expiresAt - this.now() < REFRESH_AHEAD_MS && session.refreshToken) {
      await this.refreshSession();
      return;
    }
    if (session.provider !== 'supabase' && session.expiresAt && session.expiresAt <= this.now()) {
      this.logout();
      throw new CloudApiError('Session has expired.', { code: 'E_AUTH_EXPIRED', status: 401 });
    }
  }

  async api(path, { method = 'GET', body, headers: extraHeaders = {}, _retried = false } = {}) {
    await this._ensureFresh();
    const baseHeaders = body !== undefined ? { 'Content-Type': 'application/json' } : {};
    const headers = await this._authHeaders({ ...baseHeaders, ...extraHeaders });
    const response = await this._fetch(path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const data = await responseJson(response);
    if (response.status === 401 && !_retried && this._session?.provider === 'supabase' && this._session.refreshToken) {
      try {
        await this.refreshSession();
        return this.api(path, { method, body, headers: extraHeaders, _retried: true });
      } catch (_) {
        this.logout();
      }
    }
    if (!response.ok || data.success === false) {
      if (response.status === 401) this.logout();
      throw this._errorFrom(response, data);
    }
    return data;
  }

  _errorFrom(response, data) {
    const error = data?.error;
    if (error && typeof error === 'object') {
      return new CloudApiError(error.message || error.code || 'Cloud request failed', {
        code: error.code || 'E_CLOUD',
        status: response.status,
        hint: error.hint || ''
      });
    }
    return new CloudApiError(
      typeof error === 'string' ? error : (data?.message || `HTTP ${response.status}`),
      { code: 'E_CLOUD', status: response.status }
    );
  }

  me() { return this.api('/api/cloud/me'); }
  exportMyData() { return this.api('/api/cloud/me/export'); }
  async deleteMyAccount(confirm = 'DELETE') {
    const res = await this.api('/api/cloud/me/delete', { method: 'POST', body: { confirm } });
    this.logout({ remote: false });
    return res;
  }
  syncCookieSession() {
    if (!this._session?.accessToken) return Promise.resolve(null);
    return this.api('/api/cloud/session', { method: 'POST', body: { token: this._session.accessToken } }).catch(() => null);
  }
  clearCookieSession() {
    return this._fetch?.('/api/cloud/logout', { method: 'POST' })?.catch(() => null);
  }
  aiChat(payload, { byokKey = '' } = {}) {
    const headers = byokKey ? { 'X-AI-Provider-Key': String(byokKey).trim() } : {};
    return this.api('/api/cloud/ai/chat', { method: 'POST', body: payload, headers });
  }
  credits() { return this.api('/api/cloud/credits'); }
  listProjects() { return this.api('/api/cloud/projects'); }
  getProject(id) { return this.api(`/api/cloud/projects/${encodeURIComponent(id)}`); }
  deleteProject(id) { return this.api(`/api/cloud/projects/${encodeURIComponent(id)}/delete`, { method: 'POST', body: {} }); }
  saveProject(name, data, id = '') {
    return this.api('/api/cloud/projects', { method: 'POST', body: { id: id || undefined, name, data } });
  }
  listAssets() { return this.api('/api/cloud/assets'); }
  listCommunity({ category = 'all', q = '', limit = 48, offset = 0 } = {}) {
    const params = new URLSearchParams();
    if (category && category !== 'all') params.set('category', category);
    if (q) params.set('q', q);
    if (limit) params.set('limit', String(limit));
    if (offset) params.set('offset', String(offset));
    const qs = params.toString();
    return this.api(`/api/cloud/community${qs ? `?${qs}` : ''}`);
  }
  listPayments() { return this.api('/api/cloud/payments'); }
  deleteAsset(id) { return this.api(`/api/cloud/assets/${encodeURIComponent(id)}/delete`, { method: 'POST', body: {} }); }
  checkout(plan, provider = 'sepay') {
    return this.api('/api/cloud/checkout', { method: 'POST', body: { plan, provider } });
  }
  getPayment(code) { return this.api(`/api/cloud/payments/${encodeURIComponent(code)}`); }
  simulatePayment(code) {
    return this.api(`/api/cloud/payments/${encodeURIComponent(code)}/simulate`, { method: 'POST', body: {} });
  }

  async uploadAsset(blobOrBytes, fileName = 'model.glb', metadata = {}) {
    let bytes;
    if (blobOrBytes instanceof Uint8Array) {
      bytes = blobOrBytes;
    } else if (blobOrBytes instanceof ArrayBuffer) {
      bytes = new Uint8Array(blobOrBytes);
    } else if (blobOrBytes && typeof blobOrBytes.arrayBuffer === 'function') {
      bytes = new Uint8Array(await blobOrBytes.arrayBuffer());
    } else {
      throw new CloudApiError('Invalid GLB data.', { code: 'E_INVALID_ARG' });
    }
    const payload = {
      fileName,
      contentType: 'model/gltf-binary',
      dataBase64: bytesToBase64(bytes)
    };
    if (metadata && typeof metadata === 'object') {
      if (metadata.title) payload.title = String(metadata.title);
      if (metadata.category) payload.category = String(metadata.category);
      if (metadata.tags) payload.tags = metadata.tags;
      if (metadata.description) payload.description = String(metadata.description);
      if (metadata.authorName) payload.authorName = String(metadata.authorName);
      if (metadata.thumbnailBase64) payload.thumbnailBase64 = String(metadata.thumbnailBase64);
      if (typeof metadata.public === 'boolean') payload.public = metadata.public;
    }
    return this.api('/api/cloud/assets', {
      method: 'POST',
      body: payload
    });
  }

  absoluteUrl(path) {
    if (!path) return '';
    if (/^https?:\/\//i.test(path)) return path;
    return this.origin ? new URL(path, this.origin).toString() : path;
  }
}

const sessionStorageKey = SESSION_KEY;

export { bytesToBase64, sessionStorageKey };
