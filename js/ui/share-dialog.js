/**
 * Share / Embed dialog.
 * Exports the scene to .glb, then produces either a self-contained link
 * (gzip+base64 in the URL fragment) or a ?glb= link for a hosted file.
 */
import {
  DEFAULT_OPTIONS,
  MAX_SHARE_BYTES,
  encodeSharePayload,
  serializeEmbedOptions,
  buildShareUrl,
  buildHostedEmbedUrl,
  buildIframeSnippet,
  shareSizeVerdict,
  payloadByteLength,
  utf8ByteLength
} from '../embed/embed-core.js';

const OPTION_ROWS = [
  ['autoplay', 'Autoplay', 'Play longest animation clip on open'],
  ['loop', 'Loop', 'Repeat infinitely instead of stopping at the end'],
  ['controls', 'Mouse Controls', 'Drag to orbit · scroll to zoom'],
  ['ui', 'Toolbar', 'Play, reset, and fullscreen buttons'],
  ['grid', 'Floor Grid', 'Show reference ground grid'],
  ['shadow', 'Shadows', 'Cast soft shadows onto the floor'],
  ['autorotate', 'Auto Rotate', 'Slowly orbit camera around the model'],
  ['transparent', 'Transparent Background', 'Transparent canvas for web embeds'],
  ['badge', 'Studio Badge', 'Show small Studio link in the corner']
];

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0']);

function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

function injectStyles() {
  if (document.getElementById('studio-share-styles')) return;
  const style = document.createElement('style');
  style.id = 'studio-share-styles';
  style.textContent = `
    .ss-backdrop {
      position: fixed; inset: 0; z-index: 10060; display: flex; align-items: center; justify-content: center;
      background: rgba(0,0,0,.62); backdrop-filter: blur(3px); padding: 24px;
      font: 13px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; color: #e6e6e6;
    }
    .ss-backdrop[hidden] { display: none !important; }
    .ss-panel {
      width: min(1080px, 100%); max-height: calc(100vh - 48px); display: flex; flex-direction: column;
      background: #1f1f1f; border: 1px solid #3a3a3a; border-radius: 10px;
      box-shadow: 0 24px 70px rgba(0,0,0,.65); overflow: hidden;
    }
    .ss-head { display: flex; align-items: flex-start; gap: 12px; padding: 14px 16px; border-bottom: 1px solid #333; }
    .ss-head h2 { margin: 0; font-size: 15px; font-weight: 600; color: #fff; }
    .ss-head p { margin: 2px 0 0; color: #9aa0a6; font-size: 12px; }
    .ss-head button {
      margin-left: auto; width: 30px; height: 30px; border-radius: 6px; border: 1px solid #3d3d3d;
      background: #2a2a2a; color: #ddd; font-size: 18px; line-height: 1; cursor: pointer;
    }
    .ss-head button:hover { background: #383838; }
    .ss-body { display: grid; grid-template-columns: minmax(380px, 1fr) minmax(320px, 1.05fr); gap: 0; overflow: auto; }
    .ss-left { padding: 14px 16px; border-right: 1px solid #333; min-width: 0; }
    .ss-right { padding: 14px 16px; display: flex; flex-direction: column; gap: 8px; min-width: 0; }
    .ss-title { font-size: 11px; letter-spacing: .08em; text-transform: uppercase; color: #8b9096; margin: 4px 0 8px; }
    .ss-options { display: grid; grid-template-columns: 1fr 1fr; gap: 4px 12px; margin-bottom: 10px; }
    .ss-check { display: flex; align-items: flex-start; gap: 7px; padding: 3px 0; cursor: pointer; user-select: none; }
    .ss-check input { margin: 2px 0 0; accent-color: #f0a04b; }
    .ss-check small { display: block; color: #7f858b; font-size: 11px; line-height: 1.25; }
    .ss-check span { display: block; }
    .ss-color { display: flex; align-items: center; gap: 8px; color: #c8c8c8; margin: 2px 0 12px; font-size: 12px; }
    .ss-color input { width: 34px; height: 22px; border: 1px solid #444; border-radius: 4px; background: #2a2a2a; padding: 1px; }
    .ss-color input:disabled { opacity: .35; }
    .ss-field { display: block; font-size: 12px; color: #b9bec4; margin: 0 0 8px; }
    .ss-field textarea, .ss-hosted-row input {
      width: 100%; margin-top: 4px; background: #161616; color: #dcdcdc; border: 1px solid #3a3a3a;
      border-radius: 6px; padding: 7px 8px; font: 11px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace;
      resize: vertical;
    }
    .ss-field textarea:focus, .ss-hosted-row input:focus { outline: 1px solid #f0a04b; border-color: #f0a04b; }
    .ss-hosted-row { display: flex; gap: 6px; flex-wrap: wrap; }
    .ss-hosted-row input { margin-top: 4px; flex: 1 1 180px; min-width: 0; }
    .ss-hosted-row button {
      margin-top: 4px; padding: 0 12px; border-radius: 6px; border: 1px solid #4a4a4a; background: #2c2c2c; color: #eee; cursor: pointer;
    }
    .ss-hosted-row button:hover { background: #383838; }
    .ss-actions { display: flex; flex-wrap: wrap; gap: 6px; margin: 4px 0 10px; }
    .ss-actions button, .ss-open {
      padding: 6px 11px; border-radius: 6px; border: 1px solid #4a4a4a; background: #2c2c2c; color: #eee;
      cursor: pointer; font: inherit;
    }
    .ss-actions button:hover:not(:disabled), .ss-open:hover { background: #3a3a3a; border-color: #5d5d5d; }
    .ss-actions button.primary { background: #a8641f; border-color: #c88136; color: #fff; }
    .ss-actions button.primary:hover:not(:disabled) { background: #bd7526; }
    .ss-actions button:disabled { opacity: .45; cursor: default; }
    .ss-status { min-height: 18px; margin: 2px 0 0; color: #9aa0a6; font-size: 12px; white-space: pre-wrap; }
    .ss-status.ok { color: #8ef0b0; }
    .ss-status.err { color: #ff9b90; }
    .ss-warning {
      margin: 0 0 10px; padding: 8px 10px; border-radius: 6px; border: 1px solid #6a4b1f;
      background: #2a2113; color: #e7c48c; font-size: 12px;
    }
    .ss-warning.error { border-color: #6f2c27; background: #2a1614; color: #ffb4ab; }
    .ss-preview {
      position: relative; width: 100%; aspect-ratio: 16 / 9; min-height: 220px; border-radius: 8px;
      border: 1px solid #333; background: #141414; overflow: hidden;
    }
    .ss-preview iframe { width: 100%; height: 100%; border: 0; display: block; }
    .ss-preview-empty {
      position: absolute; inset: 0; display: grid; place-items: center; color: #777; text-align: center; padding: 20px;
    }
    .ss-meta { color: #8b9096; font-size: 11px; white-space: pre-wrap; }
    .ss-note { color: #8b9096; font-size: 11px; margin: 0; }
    @media (max-width: 820px) {
      .ss-backdrop { padding: 8px; }
      .ss-body { grid-template-columns: 1fr; }
      .ss-left { border-right: 0; border-bottom: 1px solid #333; }
      .ss-options { grid-template-columns: 1fr 1fr; gap: 2px 10px; }
      .ss-check small { display: none; }
      .ss-head p { display: none; }
    }
    @media (max-width: 480px) {
      .ss-options { grid-template-columns: 1fr; }
    }
  `;
  document.head.appendChild(style);
}

export class ShareDialog {
  /** @param {any} app BlenderApp instance */
  constructor(app) {
    this.app = app;
    this.overlay = null;
    this.options = { ...DEFAULT_OPTIONS };
    this.payload = '';
    this.glbBlob = null;
    this.hostedUrl = '';
    this.link = '';
    this.mode = 'none';
    this.busy = false;
    this._previewUrl = '';
    this._previewObjectUrl = '';
    this._openedBlobUrls = new Set();
    this._regenTimer = null;
    this._onKeyDown = (event) => {
      if (event.key === 'Escape' && this.overlay && !this.overlay.hidden) {
        event.preventDefault();
        this.close();
      }
    };
    document.addEventListener('keydown', this._onKeyDown);
  }

  _embedBaseUrl() {
    const url = new URL('embed.html', window.location.href);
    url.search = '';
    url.hash = '';
    return url.toString();
  }

  _buildDom() {
    injectStyles();
    const overlay = document.createElement('div');
    overlay.className = 'ss-backdrop';
    overlay.hidden = true;
    overlay.innerHTML = `
      <div class="ss-panel" role="dialog" aria-modal="true" aria-labelledby="ss-title">
        <div class="ss-head">
          <div>
            <h2 id="ss-title">Share &amp; Embed 3D Model</h2>
            <p id="ss-sub">Export the scene as .glb and generate a lightweight 3D viewer link.</p>
          </div>
          <button id="ss-close" type="button" aria-label="Close">×</button>
        </div>
        <div class="ss-body">
          <div class="ss-left">
            <div class="ss-title">Display Options</div>
            <div class="ss-options" id="ss-options"></div>
            <label class="ss-color">Background Color <input id="ss-bg" type="color" value="${DEFAULT_OPTIONS.bg}"></label>

            <div class="ss-title">Hosted Source</div>
            <label class="ss-field" for="ss-hosted">Public .glb URL (optional — for large models)
              <div class="ss-hosted-row">
                <input id="ss-hosted" type="url" placeholder="https://cdn.example.com/model.glb" autocomplete="off">
                <button id="ss-hosted-apply" type="button">Apply</button>
                <button id="ss-cloud-upload" type="button" title="Upload GLB to Cloud Studio for a short link">☁ Cloud</button>
              </div>
            </label>
            <div style="display:flex; gap:10px; align-items:center; flex-wrap:wrap; margin-bottom:8px;">
              <input id="ss-cloud-title" type="text" placeholder="Cloud Title (default: Shared 3D Scene)" autocomplete="off" style="flex:1 1 160px; background:#161616; color:#dcdcdc; border:1px solid #3a3a3a; border-radius:6px; padding:5px 8px; font-size:12px;">
              <label class="ss-check" style="margin:0;"><input id="ss-cloud-public" type="checkbox"><span>List publicly in community gallery (Unlisted by default)</span></label>
            </div>

            <div id="ss-warning" class="ss-warning" hidden></div>

            <div class="ss-actions">
              <button id="ss-copy-link" type="button" class="primary" disabled>Copy Link</button>
              <button id="ss-copy-iframe" type="button" disabled>Copy iframe</button>
              <button id="ss-open" type="button" disabled>Open New Tab</button>
              <button id="ss-download" type="button" disabled>Download .glb</button>
            </div>

            <label class="ss-field" for="ss-link">Share Link
              <textarea id="ss-link" rows="3" readonly placeholder="Preparing…"></textarea>
            </label>
            <label class="ss-field" for="ss-iframe">Embed Code
              <textarea id="ss-iframe" rows="3" readonly placeholder="Preparing…"></textarea>
            </label>
            <p id="ss-status" class="ss-status">Preparing…</p>
          </div>
          <div class="ss-right">
            <div class="ss-title">Preview</div>
            <div class="ss-preview" id="ss-preview">
              <div class="ss-preview-empty" id="ss-preview-empty">No preview yet</div>
            </div>
            <div class="ss-meta" id="ss-meta"></div>
            <p class="ss-note" id="ss-note"></p>
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    this.overlay = overlay;
    this._dom = {
      close: overlay.querySelector('#ss-close'),
      options: overlay.querySelector('#ss-options'),
      bg: overlay.querySelector('#ss-bg'),
      hosted: overlay.querySelector('#ss-hosted'),
      hostedApply: overlay.querySelector('#ss-hosted-apply'),
      cloudUpload: overlay.querySelector('#ss-cloud-upload'),
      cloudTitle: overlay.querySelector('#ss-cloud-title'),
      cloudPublic: overlay.querySelector('#ss-cloud-public'),
      warning: overlay.querySelector('#ss-warning'),
      copyLink: overlay.querySelector('#ss-copy-link'),
      copyIframe: overlay.querySelector('#ss-copy-iframe'),
      open: overlay.querySelector('#ss-open'),
      download: overlay.querySelector('#ss-download'),
      link: overlay.querySelector('#ss-link'),
      iframe: overlay.querySelector('#ss-iframe'),
      status: overlay.querySelector('#ss-status'),
      preview: overlay.querySelector('#ss-preview'),
      meta: overlay.querySelector('#ss-meta'),
      note: overlay.querySelector('#ss-note')
    };
    this._buildOptionRows();
    this._bindDom();
  }

  _buildOptionRows() {
    const fragment = document.createDocumentFragment();
    for (const [key, label, hint] of OPTION_ROWS) {
      const row = document.createElement('label');
      row.className = 'ss-check';
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.dataset.key = key;
      input.checked = !!this.options[key];
      input.addEventListener('change', () => {
        this.options[key] = input.checked;
        if (key === 'transparent') this._syncBgInput();
        this._scheduleRegenerate();
      });
      const text = document.createElement('span');
      text.textContent = label;
      const small = document.createElement('small');
      small.textContent = hint;
      text.appendChild(small);
      row.append(input, text);
      fragment.appendChild(row);
    }
    this._dom.options.appendChild(fragment);
    this._syncBgInput();
  }

  _syncBgInput() {
    if (!this._dom) return;
    this._dom.bg.disabled = !!this.options.transparent;
  }

  _bindDom() {
    this._dom.close.addEventListener('click', () => this.close());
    this.overlay.addEventListener('click', (event) => {
      if (event.target === this.overlay) this.close();
    });
    this._dom.bg.addEventListener('input', () => {
      this.options.bg = this._dom.bg.value;
      this._scheduleRegenerate();
    });
    this._dom.hostedApply.addEventListener('click', () => this._applyHostedUrl());
    this._dom.cloudUpload.addEventListener('click', () => this._uploadToCloud());
    this._dom.hosted.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        this._applyHostedUrl();
      }
    });
    this._dom.copyLink.addEventListener('click', () => this._copy(this.link, 'Link copied to clipboard.'));
    this._dom.copyIframe.addEventListener('click', () => {
      if (!this.link) return;
      this._copy(buildIframeSnippet(this.link, { title: '3D Model — Hunger' }), 'Embed snippet copied to clipboard.');
    });
    this._dom.open.addEventListener('click', () => {
      let target = this.link;
      if (!target && this.glbBlob) {
        const blobUrl = URL.createObjectURL(this.glbBlob);
        this._openedBlobUrls.add(blobUrl);
        const url = new URL(this._embedBaseUrl());
        url.searchParams.set('glb', blobUrl);
        for (const [key, value] of serializeEmbedOptions(this.options)) url.searchParams.set(key, value);
        target = url.toString();
      }
      if (target) window.open(target, '_blank', 'noopener');
    });
    this._dom.download.addEventListener('click', () => {
      if (!this.glbBlob) return;
      this.app.exporter?.triggerDownload(this.glbBlob, 'web-blender-share.glb');
    });
  }

  _applyHostedUrl() {
    const value = (this._dom.hosted.value || '').trim();
    if (!value) {
      this.hostedUrl = '';
      this._regenerate();
      return;
    }
    try {
      buildHostedEmbedUrl(this._embedBaseUrl(), value, this.options);
      this.hostedUrl = value;
      this._setStatus('Using public .glb URL.', 'ok');
      this._regenerate();
    } catch (_) {
      this.hostedUrl = '';
      this._setStatus('The .glb URL must be a public http:// or https:// address.', 'err');
    }
  }

  async _uploadToCloud() {
    if (this.busy || !this.glbBlob) return;
    const cloud = this.app.cloud;
    if (!cloud) {
      this._setStatus('CloudClient is not initialized.', 'err');
      return;
    }
    const button = this._dom.cloudUpload;
    this.busy = true;
    if (button) button.disabled = true;
    this._setStatus('Uploading GLB to Cloud…');
    try {
      const status = await cloud.status();
      if (!status.enabled) {
        this._setStatus('Cloud is not enabled on the server. See File → Cloud / Account….', 'err');
        return;
      }
      if (!cloud.isSignedIn()) {
        this._setStatus('Please sign in to Cloud (File → Cloud / Account…) before uploading.', 'err');
        return;
      }
      const limit = Number(status.limits?.maxAssetBytes) || 0;
      if (limit && this.glbBlob.size > limit) {
        this._setStatus(`GLB ${formatBytes(this.glbBlob.size)} exceeds Cloud limit ${formatBytes(limit)}.`, 'err');
        return;
      }
      const cloudTitle = (this._dom.cloudTitle?.value || '').trim() || 'Shared 3D Scene';
      const cloudPublic = Boolean(this._dom.cloudPublic?.checked);
      const result = await cloud.uploadAsset(this.glbBlob, 'web-blender-share.glb', {
        title: cloudTitle,
        category: 'scenes',
        public: cloudPublic
      });
      const asset = result.asset;
      if (!asset?.url) throw new Error('Cloud did not return an asset.');
      this.hostedUrl = cloud.absoluteUrl(asset.url);
      this._dom.hosted.value = this.hostedUrl;
      this._regenerate();
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('blender:communityUpdated'));
      }
      this._setStatus(
        `Uploaded to Cloud (${formatBytes(asset.sizeBytes)}). Short link ready.`,
        'ok'
      );
    } catch (error) {
      const hint = error?.hint ? ` ${error.hint}` : '';
      this._setStatus(`Cloud upload failed: ${error.message || error}${hint}`, 'err');
    } finally {
      this.busy = false;
      if (button) button.disabled = !this.glbBlob;
    }
  }

  _scheduleRegenerate() {
    clearTimeout(this._regenTimer);
    this._regenTimer = setTimeout(() => this._regenerate(), 180);
  }

  _setStatus(text, tone = '') {
    if (!this._dom) return;
    this._dom.status.textContent = text;
    this._dom.status.className = `ss-status${tone ? ` ${tone}` : ''}`;
  }

  _blobPreviewUrl(force = false) {
    if (this._previewUrl && !force) return this._previewUrl;
    if (!this.glbBlob) return '';
    this._revokePreviewBlob();
    this._previewObjectUrl = URL.createObjectURL(this.glbBlob);
    const url = new URL(this._embedBaseUrl());
    url.searchParams.set('glb', this._previewObjectUrl);
    for (const [key, value] of serializeEmbedOptions(this.options)) url.searchParams.set(key, value);
    this._previewUrl = url.toString();
    return this._previewUrl;
  }

  _revokePreviewBlob() {
    if (this._previewObjectUrl) {
      URL.revokeObjectURL(this._previewObjectUrl);
      this._previewObjectUrl = '';
    }
    this._previewUrl = '';
  }

  _preview() {
    if (!this._dom || !this.overlay || this.overlay.hidden) return;
    const preview = this._dom.preview;
    let src = '';
    if (this.link) src = this.link;
    else if (this.glbBlob && this.mode === 'too-large') src = this._blobPreviewUrl(true);
    if (!src) return;

    const existing = preview.querySelector('iframe');
    if (existing) {
      if (existing.src !== src) existing.src = src;
      return;
    }

    preview.innerHTML = '';
    const frame = document.createElement('iframe');
    frame.src = src;
    frame.title = 'Shared model preview';
    frame.loading = 'eager';
    frame.setAttribute('allow', 'autoplay; fullscreen');
    frame.setAttribute('allowfullscreen', '');
    preview.appendChild(frame);
  }

  _regenerate() {
    if (!this._dom) return;
    const base = this._embedBaseUrl();
    let link = '';
    let mode = 'none';
    let warning = '';
    let warningTone = '';

    if (this.hostedUrl) {
      try {
        link = buildHostedEmbedUrl(base, this.hostedUrl, this.options);
        mode = 'hosted';
      } catch (error) {
        warning = error.message || 'Invalid public .glb URL.';
        warningTone = 'error';
      }
    }

    const payloadBytes = payloadByteLength(this.payload);
    const verdict = shareSizeVerdict(payloadBytes);

    if (!link && this.payload) {
      if (verdict.level === 'too-large') {
        mode = 'too-large';
        warning = `Model is too large for an inline link (${formatBytes(payloadBytes)} compressed > ` +
          `${formatBytes(MAX_SHARE_BYTES)}). Download the .glb, upload to hosting/CDN, and paste the public URL above.`;
        warningTone = 'error';
      } else {
        link = buildShareUrl(base, this.payload, this.options);
        mode = 'inline';
        if (verdict.level === 'warn') {
          warning = `Link is ${formatBytes(utf8ByteLength(link))} long; some chat apps may truncate it. ` +
            'Use a public .glb URL for wider sharing.';
        }
      }
    }

    this.link = link;
    this.mode = mode;

    const hasLink = !!link;
    this._dom.link.value = link || '';
    this._dom.iframe.value = hasLink
      ? buildIframeSnippet(link, { title: '3D Model — Hunger' })
      : '';
    this._dom.copyLink.disabled = !hasLink;
    this._dom.copyIframe.disabled = !hasLink;
    this._dom.open.disabled = !hasLink && !this.glbBlob;
    this._dom.download.disabled = !this.glbBlob;
    this._dom.cloudUpload.disabled = !this.glbBlob || this.busy;

    if (warning) {
      this._dom.warning.hidden = false;
      this._dom.warning.className = `ss-warning${warningTone ? ` ${warningTone}` : ''}`;
      this._dom.warning.textContent = warning;
    } else {
      this._dom.warning.hidden = true;
    }

    this._preview();
    this._renderMeta();

    if ((mode === 'inline' || mode === 'hosted') && !this.busy) {
      const kind = mode === 'hosted' ? 'public URL' : 'self-contained link';
      this._setStatus(`Ready · ${kind} ${formatBytes(utf8ByteLength(link))}.`, 'ok');
    } else if (mode === 'too-large' && !this.busy) {
      this._setStatus(
        `Could not build self-contained link (${formatBytes(payloadBytes)} compressed > ${formatBytes(MAX_SHARE_BYTES)}). ` +
        'Download .glb or provide a public URL.',
        ''
      );
    }
  }

  _renderMeta() {
    if (!this._dom) return;
    const objects = this.app.sceneManager?.getSelectableObjects?.() || [];
    const meshes = objects.filter((object) => object.isMesh || object.isSkinnedMesh).length;
    const glbSize = this.glbBlob ? this.glbBlob.size : 0;
    const linkSize = this.link ? utf8ByteLength(this.link) : 0;
    const parts = [
      `${meshes} meshes`,
      glbSize ? `GLB ${formatBytes(glbSize)}` : 'GLB not exported',
      linkSize ? `link ${formatBytes(linkSize)}` : 'no link'
    ];
    this._dom.meta.textContent = parts.join(' · ');

    const local = LOCAL_HOSTS.has(window.location.hostname);
    if (local) {
      this._dom.note.textContent = 'Running on localhost — links work on this machine only. Once deployed to a domain, links are shareable.';
    } else if (this.mode === 'hosted') {
      this._dom.note.textContent = 'Model is loaded from the public .glb URL you provided.';
    } else if (this.mode === 'too-large') {
      this._dom.note.textContent = 'Model exceeds the inline link limit: upload .glb to hosting/CDN and paste its public URL.';
    } else {
      this._dom.note.textContent = 'Model is embedded in the URL fragment and never sent to a server. For large scenes, use a public .glb URL.';
    }
  }

  async _prepare() {
    this.busy = true;
    this.payload = '';
    this.link = '';
    this.hostedUrl = '';
    this.glbBlob = null;
    this._revokePreviewBlob();
    this._dom.hosted.value = '';
    this._dom.link.value = '';
    this._dom.iframe.value = '';
    this._dom.copyLink.disabled = true;
    this._dom.copyIframe.disabled = true;
    this._dom.download.disabled = true;
    this._dom.open.disabled = true;
    this._dom.cloudUpload.disabled = true;
    this._paintOptions();
    this._setStatus('Exporting scene as .glb…');

    const meshes = (this.app.sceneManager?.getSelectableObjects?.() || [])
      .filter((object) => object.isMesh || object.isSkinnedMesh);
    if (meshes.length === 0) {
      this.busy = false;
      this._setStatus('Scene has no meshes to share yet.', 'err');
      return;
    }

    const matcap = this.app.matcapStudio;
    const matcapWasOn = !!(matcap && matcap.isMatCapActive);
    const rigSystem = this.app.rigSystem || (typeof window !== 'undefined' ? window.rigSystem : null);
    const wpMesh = rigSystem?.isWeightPaintMode ? rigSystem.weightPaintMesh : null;
    const wpBone = rigSystem?.activeBone || null;
    const lodMgr = this.app.engine?.lodManager || null;
    let lodSaved = null;
    try {
      if (matcapWasOn) matcap.toggleMatCapMode(false);
      if (wpMesh) rigSystem.disableWeightPaintMode?.();
      if (lodMgr && typeof lodMgr.forceLOD0 === 'function') {
        lodSaved = lodMgr.forceLOD0();
      }
      const result = await this.app.exporter.exportGLTF(null, {
        binary: true,
        download: false,
        filename: 'web-blender-share.glb',
        onlyVisible: true,
        quiet: true
      });
      this.glbBlob = result.blob;
      const buffer = result.buffer instanceof ArrayBuffer
        ? new Uint8Array(result.buffer)
        : new Uint8Array(await result.blob.arrayBuffer());
      this._setStatus('Compressing model…');
      this.payload = await encodeSharePayload(buffer);
    } catch (error) {
      this._setStatus(`Failed to export .glb: ${error.message || error}`, 'err');
      return;
    } finally {
      if (lodSaved && lodMgr && typeof lodMgr.restoreLODs === 'function') {
        try { lodMgr.restoreLODs(lodSaved); } catch (_) {}
      }
      if (wpMesh) {
        try { rigSystem?.enableWeightPaintMode?.(wpMesh, wpBone); } catch (_) {}
      }
      if (matcapWasOn) {
        try { matcap.toggleMatCapMode(true); } catch (_) {}
      }
      this.busy = false;
    }

    this._regenerate();
  }

  _paintOptions() {
    if (!this._dom) return;
    for (const input of this._dom.options.querySelectorAll('input[data-key]')) {
      input.checked = !!this.options[input.dataset.key];
    }
    this._dom.bg.value = /^#[0-9a-f]{6}$/i.test(this.options.bg) ? this.options.bg : DEFAULT_OPTIONS.bg;
    this._syncBgInput();
  }

  async _copy(text, message) {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      this._setStatus(message, 'ok');
    } catch (_) {
      const area = document.createElement('textarea');
      area.value = text;
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      let copied = false;
      try { copied = document.execCommand('copy'); } catch (_) {}
      area.remove();
      this._setStatus(copied ? message : 'Copy failed — select the text and press Ctrl/Cmd+C.', copied ? 'ok' : 'err');
    }
  }

  open() {
    if (!this.overlay) this._buildDom();
    this._paintOptions();
    this.overlay.hidden = false;
    this.overlay.querySelector('#ss-close')?.focus?.();
    if (this.busy) return;
    this._prepare();
  }

  close() {
    if (!this.overlay) return;
    this.overlay.hidden = true;
    clearTimeout(this._regenTimer);
    const frame = this._dom?.preview?.querySelector('iframe');
    if (frame) frame.src = 'about:blank';
    if (this._dom?.preview) {
      this._dom.preview.innerHTML = '<div class="ss-preview-empty">No preview yet</div>';
    }
    this._revokePreviewBlob();
  }

  destroy() {
    this.close();
    if (this._openedBlobUrls) {
      for (const u of this._openedBlobUrls) {
        try { URL.revokeObjectURL(u); } catch (_) {}
      }
      this._openedBlobUrls.clear();
    }
    document.removeEventListener('keydown', this._onKeyDown);
    this.overlay?.remove();
    this.overlay = null;
  }
}
