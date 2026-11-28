/**
 * Cloud Studio panel: account, project library and credit top-ups.
 * Talks to app.cloud (CloudClient); never sees the Supabase service key.
 */
import { CloudApiError } from '../cloud/cloud-client.js';
import { telemetry } from '../core/telemetry.js';

const STYLE_ID = 'studio-cloud-styles';
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0']);
const COST_LABELS = {
  save_project: 'save project',
  upload_asset: 'upload GLB to Cloud'
};
const COMMUNITY_CAT_LABELS = {
  all: 'Tất cả',
  materials: 'Chất liệu (Materials)',
  environments: 'Phong cảnh & Bối cảnh',
  vegetation: 'Cây cỏ & Tự nhiên',
  architecture: 'Kiến trúc & Công trình',
  characters: 'Nhân vật & Rig',
  props: 'Đồ vật (Props)',
  scenes: 'Toàn cảnh (Scenes)'
};

function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

function formatVnd(value) {
  try {
    return new Intl.NumberFormat('vi-VN').format(Number(value) || 0) + ' ₫';
  } catch (_) {
    return `${Number(value) || 0} VND`;
  }
}

function formatDate(value) {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString('vi-VN');
}

function injectStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    .cp-backdrop {
      position: fixed; inset: 0; z-index: 10070; display: flex; align-items: center; justify-content: center;
      background: rgba(0,0,0,.64); backdrop-filter: blur(3px); padding: 20px;
      font: 13px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; color: #e6e6e6;
    }
    .cp-backdrop[hidden] { display: none !important; }
    .cp-panel {
      width: min(880px, 100%); max-height: calc(100vh - 40px); display: flex; flex-direction: column;
      background: #1f1f1f; border: 1px solid #3a3a3a; border-radius: 10px;
      box-shadow: 0 24px 70px rgba(0,0,0,.65); overflow: hidden;
    }
    .cp-head { display: flex; align-items: center; gap: 10px; padding: 13px 16px; border-bottom: 1px solid #333; }
    .cp-head h2 { margin: 0; font-size: 15px; font-weight: 600; color: #fff; }
    .cp-chip {
      font-size: 10px; text-transform: uppercase; letter-spacing: .06em; padding: 2px 8px;
      border-radius: 999px; border: 1px solid #444; color: #bbb; background: #2a2a2a;
    }
    .cp-chip.on { border-color: #2ecc71; color: #8ef0b0; }
    .cp-head .cp-close {
      margin-left: auto; width: 30px; height: 30px; border-radius: 6px; border: 1px solid #3d3d3d;
      background: #2a2a2a; color: #ddd; font-size: 18px; line-height: 1; cursor: pointer;
    }
    .cp-head .cp-close:hover { background: #383838; }
    .cp-tabs { display: flex; gap: 4px; padding: 8px 16px 0; border-bottom: 1px solid #333; }
    .cp-tab {
      padding: 7px 12px; border: 0; border-bottom: 2px solid transparent; background: transparent;
      color: #9aa0a6; cursor: pointer; font: inherit;
    }
    .cp-tab.active { color: #fff; border-bottom-color: #f0a04b; }
    .cp-body { padding: 14px 16px; overflow: auto; }
    .cp-section-title { font-size: 11px; letter-spacing: .08em; text-transform: uppercase; color: #8b9096; margin: 4px 0 8px; }
    .cp-card { border: 1px solid #343434; border-radius: 8px; background: #242424; padding: 11px 12px; margin-bottom: 10px; }
    .cp-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    .cp-row.between { justify-content: space-between; }
    .cp-muted { color: #9aa0a6; font-size: 12px; }
    .cp-good { color: #8ef0b0; }
    .cp-warn { color: #e7c48c; }
    .cp-bad { color: #ff9b90; }
    .cp-actions { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 8px; }
    .cp-btn {
      padding: 6px 11px; border-radius: 6px; border: 1px solid #4a4a4a; background: #2c2c2c;
      color: #eee; cursor: pointer; font: inherit;
    }
    .cp-btn:hover:not(:disabled) { background: #3a3a3a; border-color: #5d5d5d; }
    .cp-btn.primary { background: #a8641f; border-color: #c88136; color: #fff; }
    .cp-btn.primary:hover:not(:disabled) { background: #bd7526; }
    .cp-btn.danger { border-color: #6f2c27; color: #ffb4ab; }
    .cp-btn:disabled { opacity: .45; cursor: default; }
    .cp-input {
      width: 100%; background: #161616; color: #ddd; border: 1px solid #3a3a3a; border-radius: 6px;
      padding: 7px 9px; font: inherit; margin-top: 4px;
    }
    .cp-input:focus { outline: 1px solid #f0a04b; border-color: #f0a04b; }
    .cp-field { display: block; font-size: 12px; color: #b9bec4; margin: 0 0 10px; }
    .cp-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 8px; }
    .cp-plan { border: 1px solid #3a3a3a; border-radius: 8px; padding: 11px; background: #242424; }
    .cp-plan h4 { margin: 0 0 2px; font-size: 13px; }
    .cp-plan .cp-price { font-size: 16px; color: #fff; margin: 4px 0; }
    .cp-badge { font-size: 10px; color: #f0a04b; border: 1px solid #6a4b1f; border-radius: 999px; padding: 1px 7px; }
    .cp-list { display: flex; flex-direction: column; gap: 6px; }
    .cp-item { border: 1px solid #333; border-radius: 7px; padding: 9px 10px; background: #212121; }
    .cp-item .cp-name { font-weight: 600; word-break: break-word; }
    .cp-item .cp-meta { color: #8b9096; font-size: 11px; margin-top: 2px; }
    .cp-empty { border: 1px dashed #3a3a3a; border-radius: 7px; padding: 16px; text-align: center; color: #888; }
    .cp-setup pre {
      background: #141414; border: 1px solid #333; border-radius: 6px; padding: 10px;
      color: #cfd8dc; font: 11px/1.55 ui-monospace, SFMono-Regular, Menlo, monospace;
      white-space: pre-wrap; word-break: break-word; margin: 0;
    }
    .cp-tag { display: inline-block; font-size: 10px; padding: 1px 6px; border-radius: 4px; background: #2d2d2d; color: #bbb; }
    .cp-qr { display: block; width: 190px; max-width: 100%; border-radius: 8px; background: #fff; padding: 6px; margin: 8px 0; }
    .cp-ledger { display: flex; flex-direction: column; gap: 3px; max-height: 180px; overflow: auto; }
    .cp-ledger-row { display: flex; justify-content: space-between; gap: 8px; font-size: 11px; color: #aaa; }
    .cp-ledger-row strong { color: #ddd; font-weight: 500; }
    .cp-pay { border: 1px solid #4b3b1d; background: #241d10; border-radius: 8px; padding: 11px; margin-top: 10px; }
    .cp-foot {
      display: flex; justify-content: space-between; gap: 10px; flex-wrap: wrap;
      padding: 9px 16px; border-top: 1px solid #333; color: #8b9096; font-size: 11px;
    }
    .cp-status.ok { color: #8ef0b0; }
    .cp-status.err { color: #ff9b90; }
    .cp-busy { opacity: .65; pointer-events: none; }
    .cp-comm-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(210px, 1fr)); gap: 10px; }
    .cp-comm-card { border: 1px solid #343434; border-radius: 8px; background: #212228; overflow: hidden; display: flex; flex-direction: column; }
    .cp-comm-thumb { width: 100%; aspect-ratio: 16 / 9; background: #14151a; object-fit: cover; display: block; border-bottom: 1px solid #2d2f36; }
    .cp-comm-thumb-empty { width: 100%; aspect-ratio: 16 / 9; background: #14151a; display: grid; place-items: center; color: #6e7681; font-size: 11px; border-bottom: 1px solid #2d2f36; border: 0; }
    .cp-comm-body { padding: 9px 10px; display: flex; flex-direction: column; gap: 4px; flex: 1; }
    .cp-row-inputs { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
    .cp-thumb-preview { width: 144px; height: 81px; border-radius: 6px; border: 1px solid #3a3a3a; background: #141414; object-fit: cover; }
    @media (max-width: 560px) {
      .cp-backdrop { padding: 8px; }
      .cp-head { padding: 11px 12px; }
      .cp-body { padding: 12px; }
      .cp-grid, .cp-row-inputs { grid-template-columns: 1fr; }
      .cp-tab { padding: 7px 8px; }
    }
  `;
  document.head.appendChild(style);
}

export class CloudPanel {
  constructor(app) {
    this.app = app;
    this.overlay = null;
    this.tab = 'account';
    this.status = null;
    this.me = null;
    this.projects = [];
    this.communityItems = [];
    this.ledger = [];
    this.payments = [];
    this.currentProjectId = '';
    this.pendingPaymentCode = '';
    this._pubThumbDataUrl = '';
    this._confirmDeleteKey = '';
    this.pollTimer = null;
    this.busy = false;
    this._onKeyDown = (event) => {
      if (event.key === 'Escape' && this.overlay && !this.overlay.hidden) {
        event.preventDefault();
        this.close();
      }
    };
    document.addEventListener('keydown', this._onKeyDown);
  }

  get client() {
    return this.app.cloud;
  }

  _buildDom() {
    injectStyles();
    const overlay = document.createElement('div');
    overlay.className = 'cp-backdrop';
    overlay.hidden = true;
    overlay.innerHTML = `
      <div class="cp-panel" role="dialog" aria-modal="true" aria-labelledby="cp-title">
        <div class="cp-head">
          <h2 id="cp-title">Cloud Studio</h2>
          <span class="cp-chip" id="cp-provider">…</span>
          <button class="cp-close" id="cp-close" type="button" aria-label="Close">×</button>
        </div>
        <div class="cp-tabs" role="tablist">
          <button class="cp-tab active" type="button" data-tab="account" role="tab">Account</button>
          <button class="cp-tab" type="button" data-tab="projects" role="tab">Projects</button>
          <button class="cp-tab" type="button" data-tab="community" role="tab">Community</button>
          <button class="cp-tab" type="button" data-tab="credits" role="tab">Credits</button>
        </div>
        <div class="cp-body">
          <section data-panel="account">
            <div id="cp-setup" class="cp-setup" hidden>
              <div class="cp-card">
                <div class="cp-row between"><strong>Cloud is not enabled</strong><span class="cp-tag">server-side</span></div>
                <p class="cp-muted" id="cp-setup-error"></p>
                <pre id="cp-setup-steps"></pre>
              </div>
            </div>
            <div id="cp-auth" hidden>
              <div class="cp-card" id="cp-auth-local" hidden>
                <div class="cp-section-title">Dev Sign In (local provider)</div>
                <label class="cp-field" for="cp-dev-email">Email
                  <input class="cp-input" id="cp-dev-email" type="email" autocomplete="email" placeholder="you@example.com">
                </label>
                <div class="cp-actions">
                  <button class="cp-btn primary" type="button" id="cp-dev-login">Sign In</button>
                </div>
              </div>
              <div class="cp-card" id="cp-auth-supabase" hidden>
                <div class="cp-section-title">Account Sign In</div>
                <div class="cp-actions" id="cp-oauth-row" style="margin-top:0;margin-bottom:10px">
                  <button class="cp-btn" type="button" id="cp-sb-oauth-google">Continue with Google</button>
                  <button class="cp-btn" type="button" id="cp-sb-oauth-github">Continue with GitHub</button>
                </div>
                <label class="cp-field" for="cp-sb-email">Email
                  <input class="cp-input" id="cp-sb-email" type="email" autocomplete="email">
                </label>
                <label class="cp-field" for="cp-sb-password">Password (min 6 characters)
                  <input class="cp-input" id="cp-sb-password" type="password" autocomplete="current-password">
                </label>
                <div class="cp-actions">
                  <button class="cp-btn primary" type="button" id="cp-sb-signin">Sign In</button>
                  <button class="cp-btn" type="button" id="cp-sb-signup">Sign Up</button>
                  <button class="cp-btn" type="button" id="cp-sb-magic">Send Magic Link</button>
                  <button class="cp-btn" type="button" id="cp-sb-reset">Forgot Password</button>
                </div>
                <p class="cp-muted" style="margin:8px 0 0">Sign in with Google, GitHub, email/password, or a magic link. Use Forgot Password to send a recovery link to your email.</p>
              </div>
              <p class="cp-muted" id="cp-auth-none" hidden>Server has enabled Cloud but no authentication method is configured.</p>
            </div>
            <div id="cp-account" hidden>
              <div class="cp-card">
                <div class="cp-row between">
                  <div>
                    <div class="cp-name" id="cp-account-email"></div>
                    <div class="cp-meta cp-muted" id="cp-account-provider"></div>
                  </div>
                  <div style="text-align:right">
                    <div style="font-size:20px;color:#fff" id="cp-account-credits">0</div>
                    <div class="cp-muted">credits</div>
                  </div>
                </div>
                <div class="cp-meta cp-muted" id="cp-account-usage"></div>
                <div class="cp-actions">
                  <button class="cp-btn" type="button" id="cp-refresh">Refresh</button>
                  <button class="cp-btn" type="button" id="cp-toggle-password">Change Password</button>
                  <button class="cp-btn" type="button" id="cp-export-data">Export Data</button>
                  <button class="cp-btn danger" type="button" id="cp-logout">Sign Out</button>
                  <button class="cp-btn danger" type="button" id="cp-delete-account">Delete Account</button>
                </div>
              </div>
              <div class="cp-card" id="cp-recovery-card" hidden>
                <div class="cp-section-title">Set New Password</div>
                <label class="cp-field" for="cp-new-password">New Password (min 6 characters)
                  <input class="cp-input" id="cp-new-password" type="password" autocomplete="new-password">
                </label>
                <label class="cp-field" for="cp-new-password-confirm">Confirm New Password
                  <input class="cp-input" id="cp-new-password-confirm" type="password" autocomplete="new-password">
                </label>
                <div class="cp-actions">
                  <button class="cp-btn primary" type="button" id="cp-save-password">Update Password</button>
                  <button class="cp-btn" type="button" id="cp-cancel-password">Cancel</button>
                </div>
              </div>
              <div id="cp-warnings"></div>
            </div>
          </section>

          <section data-panel="projects" hidden>
            <div class="cp-card">
              <div class="cp-section-title">Save Private Scene Project</div>
              <label class="cp-field" for="cp-project-name">Project Name
                <input class="cp-input" id="cp-project-name" type="text" maxlength="120" placeholder="Project Name">
              </label>
              <div class="cp-actions">
                <button class="cp-btn primary" type="button" id="cp-save">Save</button>
                <button class="cp-btn" type="button" id="cp-save-new">Save as New</button>
              </div>
              <p class="cp-muted" id="cp-save-hint" style="margin:8px 0 0"></p>
            </div>
            <div class="cp-section-title">Private Cloud Projects</div>
            <div class="cp-list" id="cp-projects"></div>
          </section>

          <section data-panel="community" hidden>
            <div class="cp-card" id="cp-publish-card">
              <div class="cp-row between" style="margin-bottom:6px">
                <div class="cp-section-title" style="margin:0">Đăng tải lên Cộng đồng Hunger 3D Studio</div>
                <span class="cp-tag">Cloudflare R2 + Supabase · Public GLB + Preview</span>
              </div>
              <div class="cp-row-inputs">
                <label class="cp-field" for="cp-pub-title">Tên tài sản / Bối cảnh
                  <input class="cp-input" id="cp-pub-title" type="text" maxlength="100" placeholder="VD: Cây phong cổ thụ / Phòng studio">
                </label>
                <label class="cp-field" for="cp-pub-category">Phân loại
                  <select class="cp-input" id="cp-pub-category">
                    <option value="environments">Phong cảnh & Bối cảnh</option>
                    <option value="vegetation">Cây cỏ & Tự nhiên</option>
                    <option value="materials">Chất liệu (Materials PBR)</option>
                    <option value="architecture">Kiến trúc & Công trình</option>
                    <option value="characters">Nhân vật & Rig</option>
                    <option value="props" selected>Đồ vật (Props)</option>
                    <option value="scenes">Toàn cảnh (Scenes)</option>
                  </select>
                </label>
              </div>
              <div class="cp-row-inputs">
                <label class="cp-field" for="cp-pub-tags">Thẻ tìm kiếm (cách nhau dấu phẩy)
                  <input class="cp-input" id="cp-pub-tags" type="text" maxlength="160" placeholder="phong canh, cay co, studio">
                </label>
                <label class="cp-field" for="cp-pub-scope">Phạm vi xuất bản
                  <select class="cp-input" id="cp-pub-scope">
                    <option value="scene">Toàn bộ cảnh hiện tại</option>
                    <option value="selection">Chỉ vật thể đang chọn</option>
                  </select>
                </label>
              </div>
              <label class="cp-field" for="cp-pub-desc">Mô tả ngắn
                <input class="cp-input" id="cp-pub-desc" type="text" maxlength="300" placeholder="Mô tả chất liệu, cách dùng hoặc nguồn cảm hứng…">
              </label>
              <div class="cp-row between" style="align-items:flex-end">
                <div class="cp-row">
                  <img id="cp-pub-thumb-preview" class="cp-thumb-preview" alt="Viewport preview" hidden>
                  <button class="cp-btn" type="button" id="cp-pub-capture">Chụp Viewport</button>
                </div>
                <button class="cp-btn primary" type="button" id="cp-pub-btn">Đăng lên Hunger Community</button>
              </div>
              <p class="cp-muted" id="cp-pub-hint" style="margin:8px 0 0"></p>
            </div>

            <div class="cp-row between" style="margin:10px 0 8px">
              <div class="cp-section-title" style="margin:0">Thư viện Cộng đồng Hunger 3D Studio</div>
              <div class="cp-row">
                <select class="cp-input" id="cp-comm-filter-cat" style="width:auto;margin:0;padding:4px 8px">
                  <option value="all">Tất cả phân loại</option>
                  <option value="environments">Phong cảnh & Bối cảnh</option>
                  <option value="vegetation">Cây cỏ & Tự nhiên</option>
                  <option value="materials">Chất liệu</option>
                  <option value="architecture">Kiến trúc</option>
                  <option value="characters">Nhân vật</option>
                  <option value="props">Đồ vật (Props)</option>
                  <option value="scenes">Toàn cảnh</option>
                </select>
                <input class="cp-input" id="cp-comm-search" type="search" placeholder="Tìm cộng đồng…" style="width:150px;margin:0;padding:4px 8px">
                <button class="cp-btn" type="button" id="cp-comm-refresh">↻</button>
              </div>
            </div>
            <div class="cp-comm-grid" id="cp-community-list"></div>
          </section>

          <section data-panel="credits" hidden>
            <div class="cp-card">
              <div class="cp-row between">
                <div><div class="cp-muted">Balance</div><div style="font-size:24px;color:#fff" id="cp-balance">0</div></div>
                <div class="cp-muted" id="cp-costs"></div>
              </div>
            </div>
            <div class="cp-section-title">Top Up Credits</div>
            <div class="cp-grid" id="cp-plans"></div>
            <div id="cp-payment"></div>
            <div class="cp-section-title" style="margin-top:14px">History</div>
            <div class="cp-ledger" id="cp-ledger"></div>
            <div class="cp-list" id="cp-payments" style="margin-top:8px"></div>
          </section>
        </div>
        <div class="cp-foot">
          <span id="cp-status" class="cp-status"></span>
          <span>Service key server-side · <a href="/TERMS.md" target="_blank" rel="noopener noreferrer" style="color:#9eb8d8">Terms</a> · <a href="/PRIVACY.md" target="_blank" rel="noopener noreferrer" style="color:#9eb8d8">Privacy</a> · <a href="/THIRD_PARTY_LICENSES.md" target="_blank" rel="noopener noreferrer" style="color:#9eb8d8">Licenses</a></span>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    this.overlay = overlay;
    this._els = {
      close: overlay.querySelector('#cp-close'),
      provider: overlay.querySelector('#cp-provider'),
      setup: overlay.querySelector('#cp-setup'),
      setupError: overlay.querySelector('#cp-setup-error'),
      setupSteps: overlay.querySelector('#cp-setup-steps'),
      auth: overlay.querySelector('#cp-auth'),
      authLocal: overlay.querySelector('#cp-auth-local'),
      authSupabase: overlay.querySelector('#cp-auth-supabase'),
      authNone: overlay.querySelector('#cp-auth-none'),
      account: overlay.querySelector('#cp-account'),
      accountEmail: overlay.querySelector('#cp-account-email'),
      accountProvider: overlay.querySelector('#cp-account-provider'),
      accountCredits: overlay.querySelector('#cp-account-credits'),
      accountUsage: overlay.querySelector('#cp-account-usage'),
      warnings: overlay.querySelector('#cp-warnings'),
      devEmail: overlay.querySelector('#cp-dev-email'),
      devLogin: overlay.querySelector('#cp-dev-login'),
      sbEmail: overlay.querySelector('#cp-sb-email'),
      sbPassword: overlay.querySelector('#cp-sb-password'),
      sbSignin: overlay.querySelector('#cp-sb-signin'),
      sbSignup: overlay.querySelector('#cp-sb-signup'),
      sbMagic: overlay.querySelector('#cp-sb-magic'),
      sbReset: overlay.querySelector('#cp-sb-reset'),
      oauthRow: overlay.querySelector('#cp-oauth-row'),
      sbOAuthGoogle: overlay.querySelector('#cp-sb-oauth-google'),
      sbOAuthGithub: overlay.querySelector('#cp-sb-oauth-github'),
      refresh: overlay.querySelector('#cp-refresh'),
      togglePassword: overlay.querySelector('#cp-toggle-password'),
      recoveryCard: overlay.querySelector('#cp-recovery-card'),
      newPassword: overlay.querySelector('#cp-new-password'),
      newPasswordConfirm: overlay.querySelector('#cp-new-password-confirm'),
      savePassword: overlay.querySelector('#cp-save-password'),
      cancelPassword: overlay.querySelector('#cp-cancel-password'),
      exportData: overlay.querySelector('#cp-export-data'),
      logout: overlay.querySelector('#cp-logout'),
      deleteAccount: overlay.querySelector('#cp-delete-account'),
      projectName: overlay.querySelector('#cp-project-name'),
      save: overlay.querySelector('#cp-save'),
      saveNew: overlay.querySelector('#cp-save-new'),
      saveHint: overlay.querySelector('#cp-save-hint'),
      projects: overlay.querySelector('#cp-projects'),
      balance: overlay.querySelector('#cp-balance'),
      costs: overlay.querySelector('#cp-costs'),
      plans: overlay.querySelector('#cp-plans'),
      payment: overlay.querySelector('#cp-payment'),
      ledger: overlay.querySelector('#cp-ledger'),
      payments: overlay.querySelector('#cp-payments'),
      pubTitle: overlay.querySelector('#cp-pub-title'),
      pubCategory: overlay.querySelector('#cp-pub-category'),
      pubTags: overlay.querySelector('#cp-pub-tags'),
      pubScope: overlay.querySelector('#cp-pub-scope'),
      pubDesc: overlay.querySelector('#cp-pub-desc'),
      pubThumbPreview: overlay.querySelector('#cp-pub-thumb-preview'),
      pubCapture: overlay.querySelector('#cp-pub-capture'),
      pubBtn: overlay.querySelector('#cp-pub-btn'),
      pubHint: overlay.querySelector('#cp-pub-hint'),
      commFilterCat: overlay.querySelector('#cp-comm-filter-cat'),
      commSearch: overlay.querySelector('#cp-comm-search'),
      commRefresh: overlay.querySelector('#cp-comm-refresh'),
      communityList: overlay.querySelector('#cp-community-list'),
      status: overlay.querySelector('#cp-status')
    };
    this._bindDom();
  }

  _bindDom() {
    const els = this._els;
    els.close.addEventListener('click', () => this.close());
    this.overlay.addEventListener('click', (event) => {
      if (event.target === this.overlay) this.close();
    });
    this.overlay.querySelectorAll('.cp-tab').forEach((tab) => {
      tab.addEventListener('click', () => this._setTab(tab.dataset.tab));
    });
    els.devLogin.addEventListener('click', () => this._run(() => this._devLogin()));
    els.sbSignin.addEventListener('click', () => this._run(() => this._supabaseAuth('signin')));
    els.sbSignup.addEventListener('click', () => this._run(() => this._supabaseAuth('signup')));
    els.sbMagic.addEventListener('click', () => this._run(() => this._supabaseAuth('magic')));
    els.sbReset.addEventListener('click', () => this._run(() => this._supabaseResetPassword()));
    els.sbOAuthGoogle.addEventListener('click', () => this._run(() => this._supabaseOAuth('google')));
    els.sbOAuthGithub.addEventListener('click', () => this._run(() => this._supabaseOAuth('github')));
    els.togglePassword.addEventListener('click', () => {
      if (els.recoveryCard) {
        els.recoveryCard.hidden = !els.recoveryCard.hidden;
        if (!els.recoveryCard.hidden) els.newPassword?.focus();
      }
    });
    els.cancelPassword.addEventListener('click', () => {
      if (els.recoveryCard) els.recoveryCard.hidden = true;
      if (els.newPassword) els.newPassword.value = '';
      if (els.newPasswordConfirm) els.newPasswordConfirm.value = '';
    });
    els.savePassword.addEventListener('click', () => this._run(() => this._updatePassword()));
    els.refresh.addEventListener('click', () => this._run(() => this.refreshAll()));
    els.exportData.addEventListener('click', () => this._run(() => this._exportAccountData()));
    els.deleteAccount.addEventListener('click', () => this._run(() => this._deleteAccount()));
    els.logout.addEventListener('click', () => {
      this.client.logout({ remote: true });
      this.client.clearCookieSession?.();
      this.currentProjectId = '';
      this._confirmDeleteAccount = false;
      this._stopPolling();
      this._showSignedOut();
      this._setStatus('Signed out.', 'ok');
    });
    els.save.addEventListener('click', () => this._run(() => this._saveProject(false)));
    els.saveNew.addEventListener('click', () => this._run(() => this._saveProject(true)));
    els.projects.addEventListener('click', (event) => {
      const open = event.target.closest('[data-project-open]');
      const remove = event.target.closest('[data-project-delete]');
      if (open) this._run(() => this._openProject(open.dataset.projectOpen));
      if (remove) this._run(() => this._deleteProject(remove.dataset.projectDelete));
    });
    els.plans.addEventListener('click', (event) => {
      const buy = event.target.closest('[data-buy-plan]');
      if (buy) this._run(() => this._buy(buy.dataset.buyPlan, buy.dataset.buyProvider));
    });
    els.pubCapture.addEventListener('click', () => this._captureViewportThumb());
    els.pubBtn.addEventListener('click', () => this._run(() => this._publishToCommunity()));
    els.commFilterCat.addEventListener('change', () => this._run(() => this._loadCommunity()));
    els.commRefresh.addEventListener('click', () => this._run(() => this._loadCommunity()));
    let commTimer = null;
    els.commSearch.addEventListener('input', () => {
      clearTimeout(commTimer);
      commTimer = setTimeout(() => { this._run(() => this._loadCommunity()); }, 220);
    });
    els.communityList.addEventListener('click', (event) => {
      const imp = event.target.closest('[data-comm-import]');
      const copy = event.target.closest('[data-comm-share]');
      const del = event.target.closest('[data-comm-delete]');
      if (imp) this._run(() => this._importCommunityAsset(imp.dataset.commImport));
      if (copy) this._copyShareUrl(copy.dataset.commShare);
      if (del) this._run(() => this._deleteCommunityAsset(del.dataset.commDelete));
    });
    els.payment.addEventListener('click', (event) => {
      const sim = event.target.closest('[data-simulate]');
      const copy = event.target.closest('[data-copy-payment]');
      if (sim) this._run(() => this._simulate(sim.dataset.simulate));
      if (copy) this._copyText(copy.dataset.copyPayment);
    });
    [els.devEmail, els.sbEmail, els.sbPassword, els.projectName].forEach((input) => {
      input.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter') return;
        event.preventDefault();
        if (input === els.projectName) this._run(() => this._saveProject(false));
        else if (input === els.sbPassword) this._run(() => this._supabaseAuth('signin'));
        else if (input === els.devEmail) this._run(() => this._devLogin());
        else this._run(() => this._supabaseAuth('signin'));
      });
    });
  }

  open(tab = 'account', options = {}) {
    if (!this.overlay) this._buildDom();
    this._confirmDeleteAccount = false;
    if (this._els?.deleteAccount) this._els.deleteAccount.textContent = 'Delete Account';
    this.overlay.hidden = false;
    this.pendingPaymentCode = options.paymentCode || '';
    this._recoveryMode = Boolean(options.recoveryMode);
    if (this._els?.recoveryCard) {
      this._els.recoveryCard.hidden = !this._recoveryMode;
    }
    this._setTab(tab || 'account');
    this._setStatus('');
    this.refreshAll();
  }

  notice(text, tone = '') {
    if (!this.overlay) this._buildDom();
    this._setStatus(text, tone);
  }

  close() {
    if (!this.overlay) return;
    this._confirmDeleteAccount = false;
    if (this._els?.deleteAccount) this._els.deleteAccount.textContent = 'Delete Account';
    this.overlay.hidden = true;
    this._stopPolling();
  }

  destroy() {
    this.close();
    document.removeEventListener('keydown', this._onKeyDown);
    this.overlay?.remove();
    this.overlay = null;
  }

  _setTab(tab) {
    this.tab = tab;
    this.overlay.querySelectorAll('.cp-tab').forEach((button) => {
      button.classList.toggle('active', button.dataset.tab === tab);
    });
    this.overlay.querySelectorAll('[data-panel]').forEach((panel) => {
      panel.hidden = panel.dataset.panel !== tab;
    });
  }

  _setStatus(text, tone = '') {
    if (!this._els) return;
    this._els.status.textContent = text || '';
    this._els.status.className = `cp-status${tone ? ` ${tone}` : ''}`;
  }

  _setBusy(busy) {
    this.busy = !!busy;
    if (!this.overlay) return;
    this.overlay.classList.toggle('cp-busy', this.busy);
  }

  async _run(action) {
    if (this.busy) return;
    this._setBusy(true);
    try {
      await action();
    } catch (error) {
      const message = error?.message || String(error);
      const hint = error instanceof CloudApiError && error.hint ? ` ${error.hint}` : '';
      this._setStatus(`${message}${hint}`, 'err');
    } finally {
      this._setBusy(false);
    }
  }

  _toast(text, type = 'success') {
    this._setStatus(text, type === 'error' ? 'err' : 'ok');
    try { this.app.exporter?.showToast?.(text, type); } catch (_) {}
  }

  async refreshAll() {
    if (!this.client) {
      this._setStatus('Missing CloudClient.', 'err');
      return;
    }
    this._setBusy(true);
    try {
      const status = await this.client.status();
      this.status = status;
      this._renderStatus();
      if (!status.enabled) {
        this._showSetup(status);
        return;
      }
      await this._loadCommunity();
      if (!this.client.isSignedIn()) {
        this._showSignedOut();
        return;
      }
      const [me, projects, credits] = await Promise.all([
        this.client.me(),
        this.client.listProjects(),
        this.client.credits()
      ]);
      this.me = me;
      this.projects = projects.projects || [];
      this.ledger = credits.ledger || [];
      await this._loadPaymentHistory();
      this._showSignedIn();
      this._renderAccount();
      this._renderProjects();
      this._renderCredits();
      this._renderPaymentHistory();
      this._syncCommunityPublishCard();
      if (this.pendingPaymentCode) {
        await this._resumePayment(this.pendingPaymentCode);
      }
    } catch (error) {
      if (error instanceof CloudApiError && (error.status === 401 || error.code === 'E_AUTH_REQUIRED')) {
        this.client.logout();
        this._showSignedOut();
        this._setStatus('Session expired.', 'err');
      } else {
        this._setStatus(error?.message || 'Failed to load Cloud.', 'err');
      }
    } finally {
      this._setBusy(false);
    }
  }

  _renderStatus() {
    const status = this.status || {};
    const provider = status.provider || 'disabled';
    this._els.provider.textContent = provider === 'local' ? 'Local · dev'
      : provider === 'supabase' ? 'Supabase' : 'Not configured';
    this._els.provider.classList.toggle('on', !!status.enabled);
  }

  _showSetup(status) {
    this._els.setup.hidden = false;
    this._els.auth.hidden = true;
    this._els.account.hidden = true;
    this._els.setupError.textContent = status.error || 'Cloud is disabled.';
    this._els.setupSteps.textContent = [
      '1) cp cloud_config.example.json cloud_config.json',
      '2) chmod 600 cloud_config.json',
      '3) Choose a provider:',
      '   • "local"    — instant start, SQLite + cloud_data/ directory (dev/self-host)',
      '   • "supabase" — production: fill in supabase.url/anon_key/service_key',
      '4) Supabase: run cloud/supabase_schema.sql in SQL Editor,',
      '   create public bucket "shared-models" (included in script)',
      '5) Configure billing.sepay or billing.lemonsqueezy for credit top-ups',
      '6) Restart the server',
      '',
      'Never expose the service key in client code or browser.'
    ].join('\n');
    const warnings = status.warnings || [];
    if (warnings.length) {
      this._els.setupSteps.textContent += '\n\nWarnings:\n- ' + warnings.join('\n- ');
    }
  }

  _showSignedOut() {
    this._els.setup.hidden = true;
    this._els.auth.hidden = false;
    this._els.account.hidden = true;
    const status = this.status || {};
    const local = !!status.devLogin;
    const supabase = !!status.supabase;
    this._els.authLocal.hidden = !local;
    this._els.authSupabase.hidden = !supabase;
    this._els.authNone.hidden = local || supabase;
    const authProviders = status.authProviders || {};
    const showGoogle = supabase && authProviders.google !== false;
    const showGithub = supabase && authProviders.github !== false;
    if (this._els.sbOAuthGoogle) this._els.sbOAuthGoogle.hidden = !showGoogle;
    if (this._els.sbOAuthGithub) this._els.sbOAuthGithub.hidden = !showGithub;
    if (this._els.oauthRow) this._els.oauthRow.hidden = !(showGoogle || showGithub);
    if (this._els.sbReset) this._els.sbReset.hidden = !(supabase && authProviders.passwordReset !== false);
    this._renderStatus();
    this._syncCommunityPublishCard();
  }

  _showSignedIn() {
    this._els.setup.hidden = true;
    this._els.auth.hidden = true;
    this._els.account.hidden = false;
    const isSupabase = this.client?.session?.provider === 'supabase';
    if (this._els.togglePassword) this._els.togglePassword.hidden = !isSupabase;
    if (this._els.recoveryCard) {
      this._els.recoveryCard.hidden = !(isSupabase && this._recoveryMode);
    }
    this._els.projectName.value = this._els.projectName.value
      || `Scene ${new Date().toLocaleString('en-US')}`;
  }

  _renderAccount() {
    const me = this.me || {};
    const user = me.user || {};
    this._els.accountEmail.textContent = user.email || '';
    this._els.accountProvider.textContent =
      `${me.provider || this.status?.provider || ''} · ${me.storage || 'local'} · ${user.id ? `ID ${String(user.id).slice(0, 8)}…` : ''}`;
    this._els.accountCredits.textContent = Number(user.credits || 0).toLocaleString('en-US');
    const stats = me.stats || {};
    this._els.accountUsage.textContent =
      `${stats.projects || 0} projects · ${stats.assets || 0} GLBs · ${formatBytes(stats.usedBytes)} / ${formatBytes(stats.maxTotalBytes)}`;
    this._els.warnings.innerHTML = '';
    const warnings = [...(this.status?.warnings || [])];
    if (LOCAL_HOSTS.has(location.hostname)) {
      warnings.push('Running on localhost: share links only work on this machine.');
    }
    if (warnings.length) {
      const card = document.createElement('div');
      card.className = 'cp-card cp-warn';
      card.textContent = warnings.join(' · ');
      this._els.warnings.appendChild(card);
    }
  }

  _renderProjects() {
    const list = this._els.projects;
    list.innerHTML = '';
    const saveCost = Number(this.status?.costs?.save_project ?? 1);
    const costText = saveCost === 0 ? 'miễn phí (chưa bật thanh toán)' : `tốn ${saveCost} credit`;
    if (!this.projects.length) {
      const empty = document.createElement('div');
      empty.className = 'cp-empty';
      empty.textContent = 'No Cloud projects yet.';
      list.appendChild(empty);
      this._els.saveHint.textContent = this.currentProjectId
        ? `Editing project ${this.currentProjectId.slice(0, 8)}… · lưu ${costText}`
        : `Mỗi lần lưu ${costText}.`;
      return;
    }
    for (const project of this.projects) {
      const item = document.createElement('div');
      item.className = 'cp-item';
      const row = document.createElement('div');
      row.className = 'cp-row between';
      const name = document.createElement('div');
      name.className = 'cp-name';
      name.textContent = project.name;
      const actions = document.createElement('div');
      actions.className = 'cp-row';
      const open = document.createElement('button');
      open.className = 'cp-btn';
      open.type = 'button';
      open.dataset.projectOpen = project.id;
      open.textContent = 'Open';
      const remove = document.createElement('button');
      remove.className = 'cp-btn danger';
      remove.type = 'button';
      remove.dataset.projectDelete = project.id;
      remove.textContent = this._confirmDeleteKey === `proj:${project.id}` ? 'Confirm Delete?' : 'Delete';
      actions.append(open, remove);
      row.append(name, actions);
      const meta = document.createElement('div');
      meta.className = 'cp-meta';
      meta.textContent = `${formatBytes(project.sizeBytes)} · updated ${formatDate(project.updatedAt)}`;
      item.append(row, meta);
      list.appendChild(item);
    }
    this._els.saveHint.textContent = this.currentProjectId
      ? `Editing project ${this.currentProjectId.slice(0, 8)}… · saves cost ${saveCost === 0 ? '0 (free)' : `${saveCost} credit`}`
      : (saveCost === 0 ? 'Lưu dự án riêng tư lên Cloud miễn phí.' : `Each save costs ${saveCost} credit.`);
  }

  _syncCommunityPublishCard() {
    if (!this._els) return;
    const signedIn = !!this.client?.isSignedIn();
    const uploadCost = Number(this.status?.costs?.upload_asset ?? 5);
    this._els.pubBtn.disabled = !signedIn;
    if (!signedIn) {
      this._els.pubHint.textContent = 'Đăng nhập ở tab Account để đăng tải cảnh / tài sản của bạn lên Môi trường Web Blender.';
    } else if (uploadCost === 0) {
      this._els.pubHint.textContent = 'Đăng tải miễn phí lên Cloud Storage (ai mở Hunger cũng có thể xem & đưa vào Viewport).';
    } else {
      this._els.pubHint.textContent = `Mỗi lần đăng tải tốn ${uploadCost} credit.`;
    }
  }

  _captureViewportThumb() {
    const srcCanvas = this.app?.engine?.renderer?.domElement;
    if (!srcCanvas) {
      this._setStatus('Chưa tìm thấy canvas Viewport để chụp preview.', 'err');
      return '';
    }
    try {
      this.app.engine?.render?.();
      const thumbCanvas = document.createElement('canvas');
      thumbCanvas.width = 256;
      thumbCanvas.height = 144;
      const ctx = thumbCanvas.getContext('2d');
      ctx.fillStyle = '#14161a';
      ctx.fillRect(0, 0, 256, 144);
      ctx.drawImage(srcCanvas, 0, 0, 256, 144);
      const dataUrl = thumbCanvas.toDataURL('image/png');
      this._pubThumbDataUrl = dataUrl;
      this._els.pubThumbPreview.src = dataUrl;
      this._els.pubThumbPreview.hidden = false;
      return dataUrl;
    } catch (_) {
      return '';
    }
  }

  async _publishToCommunity() {
    if (!this.client.isSignedIn()) {
      this._setTab('account');
      this._setStatus('Vui lòng đăng nhập Cloud trước khi đăng tải.', 'err');
      return;
    }
    if (!this.app?.exporter?.exportGLTF) {
      throw new Error('Exporter chưa sẵn sàng.');
    }
    const title = (this._els.pubTitle.value || '').trim() || 'Web Blender Scene';
    const category = this._els.pubCategory.value || 'props';
    const tags = (this._els.pubTags.value || '').split(',').map((s) => s.trim()).filter(Boolean);
    const description = (this._els.pubDesc.value || '').trim();
    const scope = this._els.pubScope.value || 'scene';
    const target = scope === 'selection'
      ? (this.app.sceneManager?.getActiveObject?.() || null)
      : null;
    if (scope === 'selection' && !target) {
      throw new Error('Chưa chọn vật thể nào trong Viewport để xuất bản.');
    }
    if (!this._pubThumbDataUrl) this._captureViewportThumb();

    this._setStatus('Đang xuất GLB và tải lên Supabase Storage…');
    const safeFile = title.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'scene';
    const glb = await this.app.exporter.exportGLTF(target, {
      binary: true,
      download: false,
      quiet: true,
      filename: `${safeFile}.glb`,
    });
    const res = await this.client.uploadAsset(glb.blob, `${safeFile}.glb`, {
      title,
      category,
      tags,
      description,
      thumbnailBase64: this._pubThumbDataUrl || undefined,
      public: true,
    });
    this._toast(`Đã đăng "${res.asset.title || title}" lên Môi trường Web Blender!`);
    this._els.pubDesc.value = '';
    await this._loadCommunity();
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('blender:communityUpdated'));
    }
  }

  async _loadCommunity() {
    if (!this.client || !this._els?.communityList) return;
    try {
      const res = await this.client.listCommunity({
        category: this._els.commFilterCat?.value || 'all',
        q: (this._els.commSearch?.value || '').trim(),
        limit: 48,
      });
      this.communityItems = res.items || [];
    } catch (error) {
      this.communityItems = [];
      this._setStatus(`Không tải được thư viện cộng đồng: ${error.message || error}`, 'err');
    }
    this._renderCommunity();
  }

  _renderCommunity() {
    const grid = this._els?.communityList;
    if (!grid) return;
    grid.innerHTML = '';
    if (!this.communityItems.length) {
      const empty = document.createElement('div');
      empty.className = 'cp-empty';
      empty.style.gridColumn = '1 / -1';
      empty.textContent = 'Chưa có tài sản nào được đăng lên Môi trường Web Blender.';
      grid.appendChild(empty);
      return;
    }
    for (const item of this.communityItems) {
      const card = document.createElement('div');
      card.className = 'cp-comm-card';
      if (item.thumbUrl) {
        const img = document.createElement('img');
        img.className = 'cp-comm-thumb';
        img.src = this.client.absoluteUrl(item.thumbUrl);
        img.alt = item.title || item.name;
        img.loading = 'lazy';
        card.appendChild(img);
      } else {
        const placeholder = document.createElement('div');
        placeholder.className = 'cp-comm-thumb-empty';
        placeholder.textContent = `3D · ${COMMUNITY_CAT_LABELS[item.category] || item.category || 'GLB'}`;
        card.appendChild(placeholder);
      }
      const body = document.createElement('div');
      body.className = 'cp-comm-body';
      const title = document.createElement('div');
      title.className = 'cp-name';
      title.textContent = item.title || item.name;
      const meta = document.createElement('div');
      meta.className = 'cp-meta';
      meta.textContent = `${COMMUNITY_CAT_LABELS[item.category] || item.category} · ${item.authorName || 'Creator'} · ${formatBytes(item.sizeBytes)}`;
      body.append(title, meta);
      if (item.description) {
        const desc = document.createElement('div');
        desc.className = 'cp-muted';
        desc.style.fontSize = '11px';
        desc.textContent = item.description;
        body.appendChild(desc);
      }
      const actions = document.createElement('div');
      actions.className = 'cp-actions';
      actions.style.marginTop = 'auto';
      const imp = document.createElement('button');
      imp.className = 'cp-btn primary';
      imp.type = 'button';
      imp.dataset.commImport = item.id;
      imp.textContent = 'Mở vào Viewport';
      actions.appendChild(imp);
      if (item.url) {
        const share = document.createElement('button');
        share.className = 'cp-btn';
        share.type = 'button';
        share.dataset.commShare = this.client.absoluteUrl(item.url);
        share.textContent = 'Link';
        actions.appendChild(share);
      }
      if (item.isOwner) {
        const del = document.createElement('button');
        del.className = 'cp-btn danger';
        del.type = 'button';
        del.dataset.commDelete = item.id;
        del.textContent = this._confirmDeleteKey === `comm:${item.id}` ? 'Confirm?' : 'Xoá';
        actions.appendChild(del);
      }
      body.appendChild(actions);
      card.appendChild(body);
      grid.appendChild(card);
    }
  }

  async _importCommunityAsset(assetId) {
    const item = this.communityItems.find((x) => x.id === assetId);
    if (!item || !item.url) throw new Error('Không tìm thấy liên kết GLB công cộng.');
    if (!this.app?.exporter?.importGLTF) throw new Error('Exporter chưa sẵn sàng.');
    this._setStatus(`Đang tải "${item.title || item.name}" vào Viewport…`);
    const url = this.client.absoluteUrl(item.url);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob = await res.blob();
    const file = new File([blob], item.name || `${item.id}.glb`, { type: 'model/gltf-binary' });
    await this.app.exporter.importGLTF(file);
    this._toast(`Đã nạp "${item.title || item.name}" vào Viewport!`);
    this.close();
  }

  async _deleteCommunityAsset(assetId) {
    const key = `comm:${assetId}`;
    if (this._confirmDeleteKey !== key) {
      this._confirmDeleteKey = key;
      this._renderCommunity();
      this._setStatus('Nhấn Confirm? một lần nữa để xoá tài sản khỏi Cộng đồng.', 'err');
      return;
    }
    this._confirmDeleteKey = '';
    await this.client.deleteAsset(assetId);
    this._toast('Đã xoá tài sản khỏi Cộng đồng.');
    await this._loadCommunity();
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('blender:communityUpdated'));
    }
  }

  _copyShareUrl(glbUrl) {
    const base = new URL('embed.html', window.location.href);
    base.search = `?glb=${encodeURIComponent(glbUrl)}`;
    base.hash = '';
    this._copyText(base.toString());
  }

  _renderCredits() {
    const credits = Number(this.me?.user?.credits || 0);
    const freeMode = !!this.status?.freeMode || (
      Number(this.status?.costs?.save_project ?? 1) === 0 &&
      Number(this.status?.costs?.upload_asset ?? 5) === 0
    );
    this._els.balance.textContent = freeMode ? 'Miễn phí' : credits.toLocaleString('en-US');
    const costs = this.status?.costs || {};
    this._els.costs.textContent = freeMode
      ? 'Lưu dự án & đăng cộng đồng miễn phí (SePay / LemonSqueezy chưa kích hoạt)'
      : Object.entries(costs).map(([key, value]) => `${COST_LABELS[key] || key}: ${value}`).join(' · ');
    const plans = this.status?.plans || [];
    const providers = this.status?.providers || this.status?.billing || {};
    this._els.plans.innerHTML = '';
    for (const plan of plans) {
      const card = document.createElement('div');
      card.className = 'cp-plan';
      const head = document.createElement('div');
      head.className = 'cp-row between';
      const title = document.createElement('h4');
      title.textContent = plan.label;
      head.appendChild(title);
      if (plan.badge) {
        const badge = document.createElement('span');
        badge.className = 'cp-badge';
        badge.textContent = plan.badge;
        head.appendChild(badge);
      }
      const price = document.createElement('div');
      price.className = 'cp-price';
      price.textContent = formatVnd(plan.priceVnd);
      const amount = document.createElement('div');
      amount.className = 'cp-muted';
      amount.textContent = `+${Number(plan.credits).toLocaleString('vi-VN')} credit`;
      const actions = document.createElement('div');
      actions.className = 'cp-actions';
      if (providers.sepay) {
        const button = document.createElement('button');
        button.className = 'cp-btn primary';
        button.type = 'button';
        button.dataset.buyPlan = plan.id;
        button.dataset.buyProvider = 'sepay';
        button.textContent = 'VietQR';
        actions.appendChild(button);
      }
      if (providers.lemonsqueezy) {
        const button = document.createElement('button');
        button.className = 'cp-btn';
        button.type = 'button';
        button.dataset.buyPlan = plan.id;
        button.dataset.buyProvider = 'lemonsqueezy';
        button.textContent = 'LemonSqueezy';
        actions.appendChild(button);
      }
      if (!actions.children.length) {
        const note = document.createElement('div');
        note.className = 'cp-muted';
        note.textContent = 'No payment gateway configured.';
        actions.appendChild(note);
      }
      card.append(head, price, amount, actions);
      this._els.plans.appendChild(card);
    }
    this._renderLedger();
  }

  _renderLedger() {
    this._els.ledger.innerHTML = '';
    if (!this.ledger.length) {
      const empty = document.createElement('div');
      empty.className = 'cp-empty';
      empty.textContent = 'No credit transactions yet.';
      this._els.ledger.appendChild(empty);
      return;
    }
    for (const row of this.ledger) {
      const line = document.createElement('div');
      line.className = 'cp-ledger-row';
      const left = document.createElement('span');
      left.textContent = `${row.reason} · ${formatDate(row.createdAt)}`;
      const right = document.createElement('strong');
      right.textContent = `${row.delta > 0 ? '+' : ''}${row.delta}`;
      right.className = row.delta > 0 ? 'cp-good' : '';
      line.append(left, right);
      this._els.ledger.appendChild(line);
    }
  }

  _renderPaymentHistory() {
    this._els.payments.innerHTML = '';
    if (!this.payments?.length) return;
    for (const payment of this.payments.slice(0, 5)) {
      const item = document.createElement('div');
      item.className = 'cp-item';
      const name = document.createElement('div');
      name.className = 'cp-name';
      name.textContent = `${payment.code} · ${payment.planId} · ${payment.status}`;
      const meta = document.createElement('div');
      meta.className = 'cp-meta';
      meta.textContent = `${formatVnd(payment.amountVnd)} · +${payment.credits} credits · ${formatDate(payment.createdAt)}`;
      item.append(name, meta);
      this._els.payments.appendChild(item);
    }
  }

  async _loadPaymentHistory() {
    try {
      const result = await this.client.listPayments();
      this.payments = result.payments || [];
    } catch (_) {
      this.payments = [];
    }
  }

  async _devLogin() {
    const email = this._els.devEmail.value.trim();
    if (!email) {
      this._setStatus('Enter email.', 'err');
      return;
    }
    this._setStatus('Signing in…');
    await this.client.devLogin(email);
    await this.client.syncCookieSession?.();
    this._setStatus('Signed in.', 'ok');
    await this.refreshAll();
  }

  async _supabaseAuth(mode) {
    const email = this._els.sbEmail.value.trim();
    const password = this._els.sbPassword.value;
    if (!email) {
      this._setStatus('Enter email.', 'err');
      return;
    }
    if (mode !== 'magic' && password.length < 6) {
      this._setStatus('Password must be at least 6 characters.', 'err');
      return;
    }
    this._setStatus('Processing…');
    if (mode === 'magic') {
      await this.client.supabaseMagicLink(email);
      telemetry.track('auth_magic_link_requested', { provider: 'supabase' });
      this._setStatus('Magic link sent — check your email.', 'ok');
      return;
    }
    if (mode === 'signup') {
      const result = await this.client.supabaseSignUp(email, password);
      telemetry.track('auth_signed_up', { provider: 'supabase', needsConfirmation: Boolean(result.needsConfirmation) });
      if (result.needsConfirmation) {
        this._setStatus('Account created — verify your email before signing in.', 'ok');
        return;
      }
    } else {
      await this.client.supabaseSignIn(email, password);
      telemetry.track('auth_signed_in', { method: 'password' });
    }
    await this.client.syncCookieSession?.();
    this._setStatus('Signed in.', 'ok');
    await this.refreshAll();
  }

  async _supabaseOAuth(provider) {
    this._setStatus(`Redirecting to ${provider === 'github' ? 'GitHub' : 'Google'} sign-in...`);
    telemetry.track('auth_oauth_started', { provider });
    await telemetry.flush?.();
    await this.client.supabaseOAuthStart(provider);
  }

  async _supabaseResetPassword() {
    const email = this._els.sbEmail.value.trim();
    if (!email || !email.includes('@')) {
      this._setStatus('Enter your account email first, then click Forgot Password.', 'err');
      this._els.sbEmail?.focus();
      return;
    }
    this._setStatus('Sending password recovery email...');
    await this.client.supabaseResetPassword(email);
    telemetry.track('auth_password_reset_requested', { provider: 'supabase' });
    this._setStatus('Password recovery email sent — open the link in your inbox to set a new password.', 'ok');
  }

  async _updatePassword() {
    const pwd = this._els.newPassword?.value || '';
    const confirm = this._els.newPasswordConfirm?.value || '';
    if (pwd.length < 6) {
      this._setStatus('New password must be at least 6 characters.', 'err');
      return;
    }
    if (pwd !== confirm) {
      this._setStatus('Password confirmation does not match.', 'err');
      return;
    }
    this._setStatus('Updating password...');
    await this.client.supabaseUpdatePassword(pwd);
    this._recoveryMode = false;
    if (this._els.newPassword) this._els.newPassword.value = '';
    if (this._els.newPasswordConfirm) this._els.newPasswordConfirm.value = '';
    if (this._els.recoveryCard) this._els.recoveryCard.hidden = true;
    telemetry.track('auth_password_updated', { provider: 'supabase' });
    this._toast('Password updated successfully.');
  }

  async _exportAccountData() {
    if (!this.client.isSignedIn()) {
      this._showSignedOut();
      this._setStatus('Please sign in to Cloud first.', 'err');
      return;
    }
    this._setStatus('Exporting account data…');
    const payload = await this.client.exportMyData();
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'web-blender-studio-data.json';
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    this._toast('Account archive downloaded.');
  }

  async _deleteAccount() {
    if (!this.client.isSignedIn()) {
      this._showSignedOut();
      return;
    }
    if (!this._confirmDeleteAccount) {
      this._confirmDeleteAccount = true;
      this._els.deleteAccount.textContent = 'Confirm Permanent Delete?';
      this._setStatus('Click "Confirm Permanent Delete?" again to erase your Cloud account & files.', 'err');
      return;
    }
    this._confirmDeleteAccount = false;
    this._els.deleteAccount.textContent = 'Delete Account';
    this._setStatus('Deleting Cloud account…');
    await this.client.deleteMyAccount('DELETE');
    this.currentProjectId = '';
    this.me = null;
    this.projects = [];
    this.ledger = [];
    this.payments = [];
    this._stopPolling();
    this._showSignedOut();
    this._setStatus('Cloud account and data deleted.', 'ok');
  }

  async _saveProject(forceNew) {
    if (!this.client.isSignedIn()) {
      this._showSignedOut();
      this._setStatus('Please sign in to Cloud first.', 'err');
      return;
    }
    const name = (this._els.projectName.value || '').trim() || 'Untitled Scene';
    this._setStatus('Saving project…');
    const json = this.app.exporter.exportProjectJSON({ download: false });
    const data = JSON.parse(json);
    const result = await this.client.saveProject(name, data, forceNew ? '' : this.currentProjectId);
    this.currentProjectId = result.project.id;
    const msg = this.status?.freeMode
      ? `Saved private project "${result.project.name}" to Supabase.`
      : `Saved "${result.project.name}" · ${result.project.credits} credits remaining.`;
    this._toast(msg);
    await this.refreshAll();
  }

  async _openProject(projectId) {
    this._setStatus('Opening project…');
    const result = await this.client.getProject(projectId);
    await this.app.exporter.importProjectJSON(result.project.data);
    this.currentProjectId = result.project.id;
    this._els.projectName.value = result.project.name;
    this._toast(`Opened "${result.project.name}".`);
    this.close();
  }

  async _deleteProject(projectId) {
    const key = `proj:${projectId}`;
    if (this._confirmDeleteKey !== key) {
      this._confirmDeleteKey = key;
      this._renderProjects();
      this._setStatus('Nhấn Confirm Delete? một lần nữa để xoá dự án vĩnh viễn.', 'err');
      return;
    }
    this._confirmDeleteKey = '';
    this._setStatus('Deleting…');
    await this.client.deleteProject(projectId);
    if (this.currentProjectId === projectId) this.currentProjectId = '';
    this._setStatus('Project deleted.', 'ok');
    await this.refreshAll();
  }

  async _buy(planId, provider) {
    this._setStatus('Creating payment…');
    telemetry.track('checkout_started', { planId, provider });
    const result = await this.client.checkout(planId, provider);
    this.pendingPaymentCode = result.payment.code;
    this._renderCheckout(result);
    this._setStatus('Awaiting payment…');
    this._startPolling(result.payment.code);
  }

  _renderCheckout(result) {
    const checkout = result.checkout || {};
    const payment = result.payment || {};
    const box = this._els.payment;
    box.innerHTML = '';
    const card = document.createElement('div');
    card.className = 'cp-pay';
    const title = document.createElement('div');
    title.className = 'cp-name';
    title.textContent = `Transaction ${payment.code} · ${formatVnd(payment.amountVnd)} · +${payment.credits} credits`;
    card.appendChild(title);

    if (checkout.type === 'vietqr') {
      const img = document.createElement('img');
      img.className = 'cp-qr';
      img.alt = 'VietQR Code';
      img.loading = 'lazy';
      img.referrerPolicy = 'no-referrer';
      img.src = checkout.qrUrl;
      card.appendChild(img);
      const details = document.createElement('div');
      details.className = 'cp-muted';
      const expiryNote = checkout.expiresAt ? `\nExpires at: ${formatDate(checkout.expiresAt)}` : '';
      details.textContent =
        `${checkout.bank} · ${checkout.account} · ${checkout.holder}\n` +
        `Amount: ${formatVnd(checkout.amountVnd)}\nReference: ${checkout.transferContent}${expiryNote}`;
      details.style.whiteSpace = 'pre-wrap';
      card.appendChild(details);
      const actions = document.createElement('div');
      actions.className = 'cp-actions';
      const copy = document.createElement('button');
      copy.className = 'cp-btn';
      copy.type = 'button';
      copy.dataset.copyPayment = checkout.transferContent;
      copy.textContent = 'Copy Reference';
      actions.appendChild(copy);
      card.appendChild(actions);
    } else if (checkout.type === 'checkout_url') {
      const actions = document.createElement('div');
      actions.className = 'cp-actions';
      const open = document.createElement('button');
      open.className = 'cp-btn primary';
      open.type = 'button';
      open.textContent = 'Open Checkout Page';
      open.addEventListener('click', () => window.open(checkout.checkoutUrl, '_blank', 'noopener'));
      actions.appendChild(open);
      card.appendChild(actions);
    } else {
      const note = document.createElement('div');
      note.className = 'cp-muted';
      note.textContent = 'No payment details available.';
      card.appendChild(note);
    }

    if (this.status?.devLogin) {
      const actions = document.createElement('div');
      actions.className = 'cp-actions';
      const simulate = document.createElement('button');
      simulate.className = 'cp-btn';
      simulate.type = 'button';
      simulate.dataset.simulate = payment.code;
      simulate.textContent = 'Simulate Payment (dev)';
      actions.appendChild(simulate);
      card.appendChild(actions);
    }
    box.appendChild(card);
  }

  _startPolling(code) {
    this._stopPolling();
    if (!code) return;
    this.pollTimer = setInterval(() => {
      this._pollPayment(code).catch(() => {});
    }, 3000);
  }

  _stopPolling() {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  async _pollPayment(code) {
    if (!this.client.isSignedIn()) return;
    const result = await this.client.getPayment(code);
    const payment = result.payment;
    if (payment.status === 'paid') {
      this._stopPolling();
      this.pendingPaymentCode = '';
      telemetry.track('payment_completed', {
        planId: payment.planId || '',
        provider: payment.provider || '',
        credits: Number(payment.credits || 0),
        amountVnd: Number(payment.amountVnd || 0),
      });
      this._setStatus(`Payment received · ${result.credits} credits.`, 'ok');
      await this.refreshAll();
    } else if (payment.status === 'expired') {
      this._stopPolling();
      this.pendingPaymentCode = '';
      telemetry.track('payment_expired', { planId: payment.planId || '', provider: payment.provider || '' });
      this._setStatus(`Transaction ${code} expired — select a plan above to create a new order.`, 'err');
    } else if (payment.status === 'refunded') {
      this._stopPolling();
      this.pendingPaymentCode = '';
      this._setStatus(`Transaction ${code} was refunded.`, 'err');
      await this.refreshAll();
    } else if (payment.status === 'underpaid') {
      this._stopPolling();
      this._setStatus('Underpaid transaction — please contact support.', 'err');
    }
  }

  async _simulate(code) {
    const result = await this.client.simulatePayment(code);
    this._setStatus(`Simulated payment · ${result.credits} credits.`, 'ok');
    this._stopPolling();
    this.pendingPaymentCode = '';
    await this.refreshAll();
  }

  async _resumePayment(code) {
    try {
      const result = await this.client.getPayment(code);
      const payment = result.payment;
      if (payment.status === 'paid') {
        this.pendingPaymentCode = '';
        this._setStatus(`Transaction ${code} is already paid.`, 'ok');
        await this.refreshAll();
        return;
      }
      if (payment.status === 'expired') {
        this.pendingPaymentCode = '';
        this._setStatus(`Transaction ${code} expired — create a new order to top up.`, 'err');
        return;
      }
      if (payment.status === 'refunded') {
        this.pendingPaymentCode = '';
        this._setStatus(`Transaction ${code} was refunded.`, 'err');
        return;
      }
      if (payment.status === 'underpaid') {
        this._setStatus(`Transaction ${code} was underpaid.`, 'err');
        return;
      }
      const box = this._els.payment;
      box.innerHTML = '';
      const card = document.createElement('div');
      card.className = 'cp-pay';
      const title = document.createElement('div');
      title.className = 'cp-name';
      title.textContent = `Awaiting payment ${payment.code} · ${formatVnd(payment.amountVnd)}`;
      card.appendChild(title);
      if (this.status?.devLogin) {
        const actions = document.createElement('div');
        actions.className = 'cp-actions';
        const simulate = document.createElement('button');
        simulate.className = 'cp-btn';
        simulate.type = 'button';
        simulate.dataset.simulate = payment.code;
        simulate.textContent = 'Simulate Payment (dev)';
        actions.appendChild(simulate);
        card.appendChild(actions);
      }
      box.appendChild(card);
      this._startPolling(code);
    } catch (error) {
      this._setStatus(error.message, 'err');
    }
  }

  async _copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      this._setStatus('Transfer reference copied.', 'ok');
    } catch (_) {
      this._setStatus(`Reference: ${text}`, '');
    }
  }
}
