/**
 * File: js/ui/feedback-dialog.js
 * Lightweight, lazy-loaded Beta Feedback & Bug Report modal for Hunger Motion / Studio.
 * Sends PII-free feedback to same-origin `POST /api/telemetry/feedback` (stored in DO SQLite).
 */

import { telemetry } from '../core/telemetry.js';

const STYLE_ID = 'hunger-feedback-dialog-style';

function injectStyles() {
  if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    .fb-backdrop {
      position: fixed;
      inset: 0;
      z-index: 9500;
      background: rgba(10, 12, 16, 0.72);
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 16px;
    }
    .fb-backdrop[hidden] { display: none; }
    .fb-card {
      width: min(460px, 100%);
      background: #23262d;
      color: #e6e9ef;
      border: 1px solid #3c424f;
      border-radius: 10px;
      box-shadow: 0 20px 48px rgba(0, 0, 0, 0.55);
      font-family: inherit;
      font-size: 13px;
      overflow: hidden;
    }
    .fb-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 12px 16px;
      border-bottom: 1px solid #323743;
      background: #1d2026;
    }
    .fb-title {
      margin: 0;
      font-size: 14px;
      font-weight: 600;
    }
    .fb-close {
      background: transparent;
      border: 0;
      color: #9aa3b2;
      font-size: 18px;
      line-height: 1;
      cursor: pointer;
      padding: 2px 6px;
      border-radius: 4px;
    }
    .fb-close:hover { background: #303540; color: #fff; }
    .fb-body {
      padding: 14px 16px;
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    .fb-label {
      display: flex;
      flex-direction: column;
      gap: 5px;
      font-size: 12px;
      color: #b7c0ce;
    }
    .fb-select, .fb-textarea {
      background: #171a1f;
      color: #eef2f7;
      border: 1px solid #3b414e;
      border-radius: 6px;
      padding: 8px 10px;
      font: inherit;
      width: 100%;
      box-sizing: border-box;
    }
    .fb-textarea {
      min-height: 104px;
      resize: vertical;
      line-height: 1.45;
    }
    .fb-select:focus, .fb-textarea:focus {
      outline: none;
      border-color: #4d80d8;
    }
    .fb-rating-row {
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .fb-rate-btn {
      width: 30px;
      height: 28px;
      border-radius: 5px;
      border: 1px solid #3b414e;
      background: #171a1f;
      color: #cfd6e3;
      cursor: pointer;
      font-size: 12px;
      font-weight: 600;
    }
    .fb-rate-btn[aria-pressed="true"] {
      background: #4772b3;
      border-color: #6b97db;
      color: #fff;
    }
    .fb-meta {
      font-size: 11px;
      color: #8c96a7;
      line-height: 1.4;
    }
    .fb-status {
      font-size: 12px;
      min-height: 16px;
    }
    .fb-status.ok { color: #67d391; }
    .fb-status.err { color: #f07b7b; }
    .fb-foot {
      display: flex;
      justify-content: flex-end;
      gap: 8px;
      padding: 10px 16px 14px;
      border-top: 1px solid #323743;
      background: #1d2026;
    }
    .fb-btn {
      padding: 7px 14px;
      border-radius: 6px;
      border: 1px solid #3f4654;
      background: #2b303a;
      color: #e6e9ef;
      cursor: pointer;
      font-size: 12px;
      font-weight: 500;
    }
    .fb-btn:hover { background: #363c49; }
    .fb-btn.primary {
      background: #4772b3;
      border-color: #5a87cc;
      color: #fff;
    }
    .fb-btn.primary:hover { background: #5481c5; }
    .fb-btn:disabled { opacity: 0.55; cursor: not-allowed; }
  `;
  document.head.appendChild(style);
}

export class FeedbackDialog {
  constructor(app) {
    this.app = app;
    this.rating = null;
    this.busy = false;
    this._els = null;
    this._build();
  }

  _build() {
    injectStyles();
    const backdrop = document.createElement('div');
    backdrop.className = 'fb-backdrop';
    backdrop.id = 'hunger-feedback-backdrop';
    backdrop.hidden = true;
    backdrop.innerHTML = `
      <div class="fb-card" role="dialog" aria-modal="true" aria-labelledby="fb-dialog-title">
        <div class="fb-head">
          <h3 class="fb-title" id="fb-dialog-title">Beta Feedback &amp; Bug Report</h3>
          <button type="button" class="fb-close" id="fb-close" aria-label="Close">&times;</button>
        </div>
        <form id="fb-form">
          <div class="fb-body">
            <label class="fb-label">
              <span>Category</span>
              <select class="fb-select" id="fb-category">
                <option value="bug">Bug report</option>
                <option value="mocap">Mocap / Tracking</option>
                <option value="export">GLB / Export</option>
                <option value="performance">Performance / Load speed</option>
                <option value="feature">Feature request</option>
                <option value="other">Other</option>
              </select>
            </label>
            <div class="fb-label">
              <span>Experience rating (optional, 1 = poor, 5 = great)</span>
              <div class="fb-rating-row" id="fb-rating-row">
                <button type="button" class="fb-rate-btn" data-rating="1" aria-pressed="false">1</button>
                <button type="button" class="fb-rate-btn" data-rating="2" aria-pressed="false">2</button>
                <button type="button" class="fb-rate-btn" data-rating="3" aria-pressed="false">3</button>
                <button type="button" class="fb-rate-btn" data-rating="4" aria-pressed="false">4</button>
                <button type="button" class="fb-rate-btn" data-rating="5" aria-pressed="false">5</button>
              </div>
            </div>
            <label class="fb-label">
              <span>What happened or what should we improve?</span>
              <textarea class="fb-textarea" id="fb-message" maxlength="1500" required
                placeholder="Describe the steps, video format, rig, or suggestion..."></textarea>
            </label>
            <div class="fb-meta" id="fb-meta"></div>
            <div class="fb-status" id="fb-status" aria-live="polite"></div>
          </div>
          <div class="fb-foot">
            <button type="button" class="fb-btn" id="fb-cancel">Cancel</button>
            <button type="submit" class="fb-btn primary" id="fb-submit">Send Feedback</button>
          </div>
        </form>
      </div>
    `;
    document.body.appendChild(backdrop);

    this._els = {
      backdrop,
      form: backdrop.querySelector('#fb-form'),
      category: backdrop.querySelector('#fb-category'),
      ratingButtons: Array.from(backdrop.querySelectorAll('.fb-rate-btn')),
      message: backdrop.querySelector('#fb-message'),
      meta: backdrop.querySelector('#fb-meta'),
      status: backdrop.querySelector('#fb-status'),
      submit: backdrop.querySelector('#fb-submit'),
      cancel: backdrop.querySelector('#fb-cancel'),
      close: backdrop.querySelector('#fb-close'),
    };

    const close = () => this.close();
    this._els.close.addEventListener('click', close);
    this._els.cancel.addEventListener('click', close);
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) close();
    });
    this._onKeyDown = (e) => {
      if (!backdrop.hidden && e.key === 'Escape') close();
    };
    document.addEventListener('keydown', this._onKeyDown);

    for (const btn of this._els.ratingButtons) {
      btn.addEventListener('click', () => {
        const val = Number.parseInt(btn.dataset.rating || '', 10);
        this.rating = this.rating === val ? null : val;
        this._syncRatingButtons();
      });
    }

    this._els.form.addEventListener('submit', (e) => {
      e.preventDefault();
      this._submit();
    });
  }

  _syncRatingButtons() {
    for (const btn of this._els.ratingButtons) {
      const val = Number.parseInt(btn.dataset.rating || '', 10);
      btn.setAttribute('aria-pressed', this.rating === val ? 'true' : 'false');
    }
  }

  _getContext() {
    const workspace = String(this.app?.currentWorkspace || telemetry.workspace || 'motion');
    const templateId = String(this.app?.mocapUI?._activeTemplateId || '');
    const release = String(telemetry.release || 'hunger-motion@0.9.0-beta.2');
    const sessionId = String(telemetry.sessionId || '');
    return { workspace, templateId, release, sessionId };
  }

  open(defaultCategory = '') {
    if (defaultCategory && this._els.category) {
      this._els.category.value = defaultCategory;
    }
    const ctx = this._getContext();
    this._els.meta.textContent =
      `Context sent: workspace=${ctx.workspace}${ctx.templateId ? `, template=${ctx.templateId}` : ''}, release=${ctx.release}. No personal email or local files are uploaded.`;
    this._els.status.textContent = '';
    this._els.status.className = 'fb-status';
    this._els.backdrop.hidden = false;
    this._els.message.focus();
  }

  close() {
    if (this._els?.backdrop) this._els.backdrop.hidden = true;
  }

  async _submit() {
    if (this.busy) return;
    const message = String(this._els.message.value || '').trim();
    if (message.length < 3) {
      this._els.status.textContent = 'Please enter at least 3 characters.';
      this._els.status.className = 'fb-status err';
      return;
    }
    const category = String(this._els.category.value || 'bug');
    const ctx = this._getContext();
    this.busy = true;
    this._els.submit.disabled = true;
    this._els.status.textContent = 'Sending feedback...';
    this._els.status.className = 'fb-status';
    try {
      const resp = await fetch('/api/telemetry/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          category,
          rating: this.rating,
          message,
          workspace: ctx.workspace,
          templateId: ctx.templateId,
          release: ctx.release,
          sessionId: ctx.sessionId,
        }),
      });
      const json = await resp.json().catch(() => ({}));
      if (!resp.ok || !json.ok) {
        const errMsg = json?.error?.message || json?.error || `HTTP ${resp.status}`;
        throw new Error(errMsg);
      }
      telemetry.track('beta_feedback_submitted', { category, rating: this.rating });
      this._els.message.value = '';
      this.rating = null;
      this._syncRatingButtons();
      this._els.status.textContent = 'Thank you. Your feedback has been recorded.';
      this._els.status.className = 'fb-status ok';
      setTimeout(() => this.close(), 1100);
    } catch (err) {
      this._els.status.textContent = `Could not send feedback: ${err?.message || err}`;
      this._els.status.className = 'fb-status err';
    } finally {
      this.busy = false;
      this._els.submit.disabled = false;
    }
  }
}
