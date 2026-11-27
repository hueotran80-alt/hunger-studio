/**
 * Web Blender Studio - AI 3D Copilot Engine & Chat Interface 2.0
 * File: js/ai/ai-copilot.js
 * 
 * Version 2.0 Features:
 * - Multi-turn Conversational 3D Editing (Ghi nhớ ngữ cảnh hội thoại nhiều lượt):
 *   Remembers previously created models (e.g. house, car, castle, pool, robot).
 *   Distinguishes between "Create New Scene" vs "Add / Modify / Transform Existing Model":
 *   - "thêm một hồ bơi trước nhà" -> Adds modern pool without clearing existing house.
 *   - "làm mái nhà màu xanh dương" -> Modifies roof material color to blue.
 *   - "thêm 3 cây thông bên trái" -> Adds 3 trees on the left side of the house.
 *   - "xoay ngôi nhà 45 độ" -> Rotates the target model 45 degrees around Y-axis.
 *   - "phóng to nó gấp đôi" -> Scales target model by 2x.
 *   - "thu nhỏ một nửa", "di chuyển sang phải 5m", "đổi màu tường thành trắng", etc.
 * - Expanded High-End 3D Model Library with 8 Premium Domains:
 *   1. Xe hơi thể thao / Siêu xe viễn tưởng 3D (Sports Car / Sci-Fi Supercar)
 *   2. Lâu đài trung cổ / Pháo đài đá (Medieval Stone Castle / Fortress)
 *   3. Phi thuyền thám hiểm không gian (Deep Space Exploration Spaceship)
 *   4. Hồ bơi biệt thự hiện đại (Modern Luxury Villa Swimming Pool)
 *   5. Cây cầu treo nghệ thuật (Artistic Suspension Bridge)
 *   6. Nội thất phòng khách sang trọng (Modern Living Room Interior)
 *   7. Vòng năng lượng Cổng dịch chuyển Portal Stargate (Stargate Sci-Fi Portal)
 *   8. Cối xay gió cổ điển (Classic Dutch Windmill with real-time rotating sails)
 * - Web Speech API Integration:
 *   Microphone button 🎙️ supporting Vietnamese speech recognition ('vi-VN').
 *   Real-time voice-to-text transcript typing into textarea.
 * - Dual Engine: High-speed Offline Procedural NLP Parser + Optional Online Cloud LLM (Gemini 2.5 Flash / OpenAI GPT-4o).
 * - Blender 4.x-themed floating chat window, quick prompt chips, history log, code preview, and live execution.
 */

import { studio } from '../scripting/rapid-api.js';
import { prefabLibrary } from '../scripting/prefab-library.js';
import { buildSceneDigest, formatSceneDigestForPrompt, stripThinkingTags } from './scene-digest.js';
import { escapeHtml } from '../core/escape-html.js';
import {
  scanGeneratedCode,
  describeViolations
} from './copilot-guard.js';
import { CopilotRuntime } from './copilot-runtime.js';
import { createImageObject } from '../core/image-objects.js';
import { getSharedVoiceCoordinator, routeVoiceUtterance } from './voice-wake-router.js';
import {
  selectCopilotSkills,
  formatCopilotSkillsForPrompt,
  getCopilotSkillCatalog,
  resolveCopilotSkillId,
} from './copilot-skills.js';

const ALLOWED_COPILOT_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/gif']);
const SAFE_DATA_IMAGE_RE = /^data:image\/(?:png|jpe?g|webp|gif);base64,[A-Za-z0-9+/=]+$/i;

export class AICopilot {
  constructor(options = {}) {
    this.container = options.container || (typeof document !== 'undefined' ? document.body : null);
    this.studio = options.studio || (typeof window !== 'undefined' ? window.studio : null);
    
    // State
    this.history = [];
    this.isGenerating = false;
    this.isMinimized = false;
    this.isVisible = false;
    this.panel = null;
    this.fabBtn = null;
    this.micBtn = null;
    this.wakeBtn = null;
    this.imgBtn = null;
    this.fileInput = null;
    this.attachmentsTray = null;
    this.attachedImages = [];
    this._lastExecutionError = null;
    this._voicePromptActive = false;
    this.pinnedSkills = new Set();
    this.lastActiveSkills = [];

    // Multi-turn Conversational Context State (Copilot 2.0)
    this.conversationContext = {
      lastModelType: null,      // 'house' | 'car' | 'castle' | 'spaceship' | 'pool' | 'bridge' | 'livingroom' | 'portal' | 'windmill' | 'robot' | 'city'
      lastModelName: null,      // e.g. 'ModernHouse', 'Supercar_Group', 'Castle_Group'
      lastModelGroup: null,     // Three.js Group or mesh reference name
      createdObjects: [],       // Array of object names created across turns
      sceneState: {
        hasHouse: false,
        hasPool: false,
        hasCar: false,
        hasCastle: false,
        hasSpaceship: false,
        hasBridge: false,
        hasLivingRoom: false,
        hasPortal: false,
        hasWindmill: false,
        hasTrees: false,
        treeCount: 0
      },
      turns: []                 // Multi-turn transcript: array of { role, text, code, timestamp }
    };

    // Verified model allowlists (tested live against active endpoints)
    this._verifiedModels = {
      motapis: new Set([
        'claude-sonnet-4-6',
        'claude-sonnet-5-5',
        'gpt-6-luna',
        'gpt-6-astra',
        'gpt-5.6-sol',
        'deepseek-v4-flash',
        'DeepSeek-V4-Flash-0731',
        'deepseek-v4.1-flash-1017',
        'gemini-4-hydrogen',
        'grok-4.5',
        'glm-5.3-flash',
        'minimax-m3',
        'minimax-m2.7',
        'kimi-k3.1-pro',
        'hy4-preview',
      ]),
      gemini: new Set([
        'gemini-3.5-flash-lite',
        'gemini-3-flash-preview',
        'gemini-3.1-flash-lite',
        'gemini-3.1-flash-lite-preview',
        'gemini-3.8-flash',
        'gemma-4-31b-it',
      ]),
    };

    // Web Speech API State
    this.recognition = null;
    this.isListening = false;
    this._originalPlaceholder = '';

    // Settings (persisted as UI preferences in localStorage — keys never stored client-side)
    this.settings = {
      provider: 'motapis', // 'motapis' | 'gemini'
      customModel: 'claude-sonnet-4-6',
      geminiModel: 'gemini-3.5-flash-lite',
      openAiModel: 'gpt-4o-mini',
      voiceLang: 'vi-VN',
      autoRunCode: true,
      humanConstructionMode: true,
      visualCritique: true,
      constructionSpeed: 130
    };

    // Server-side provider availability state (never key material itself)
    this.serverCapabilities = { gemini: false, openai: false, custom: false };

    this._loadSettings();
    // Clear any legacy API keys from frontend localStorage
    if (typeof localStorage !== 'undefined') {
      try {
        localStorage.removeItem('motapis_key');
        localStorage.removeItem('custom_key');
      } catch (_) {}
    }

    if (typeof document !== 'undefined') {
      const initUI = () => {
        if (!this.container) this.container = document.body;
        if (this.container && !this.panel) {
          this._injectStyles();
          this._createDOM();
          this._bindEvents();
          this._initSpeechRecognition();
          this._addBotMessage(
            `Chào mừng bạn đến với **Hunger AI Copilot**! Trợ lý AI tạo hình 3D bằng **Cloud AI** theo thời gian thực, hỗ trợ **chỉnh sửa cảnh nhiều lượt**, **đọc ảnh tham chiếu 🖼️** và **nhập lệnh giọng nói 🎙️**.\n\n` +
            `Thử gõ hoặc chọn một gợi ý phía trên (ví dụ: *"Create a modern garden house"*, sau đó *"add a swimming pool in front"* hoặc *"đổi mái nhà sang màu xanh dương"*).`,
            null
          );
        }
      };

      if (!document.body || document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initUI);
      } else {
        initUI();
      }
    }
  }

  _normalizeProviderAndModels() {
    if (!['motapis', 'gemini'].includes(this.settings.provider)) {
      this.settings.provider = 'motapis';
    }
    if (!this._verifiedModels.motapis.has(this.settings.customModel)) {
      this.settings.customModel = 'claude-sonnet-4-6';
    }
    if (!this._verifiedModels.gemini.has(this.settings.geminiModel)) {
      this.settings.geminiModel = 'gemini-3.5-flash-lite';
    }
  }

  _syncServerModelsToDom() {
    const free = this.serverFreeModels;
    if (!free || !this.panel) return;
    const syncSelect = (selector, list) => {
      const selectEl = this.panel.querySelector(selector);
      if (!selectEl || !Array.isArray(list)) return;
      const existing = new Set([...selectEl.options].map((o) => o.value));
      const extras = list.filter((m) => typeof m === 'string' && m.trim() && !existing.has(m.trim()));
      if (!extras.length) return;
      let extraGroup = selectEl.querySelector('optgroup[data-server-extra="1"]');
      if (!extraGroup) {
        extraGroup = document.createElement('optgroup');
        extraGroup.dataset.serverExtra = '1';
        extraGroup.label = '🌐 Server Extra Models';
        selectEl.appendChild(extraGroup);
      }
      for (const m of extras) {
        const opt = document.createElement('option');
        opt.value = m.trim();
        opt.textContent = m.trim();
        opt.style.color = '#fff';
        extraGroup.appendChild(opt);
      }
    };
    syncSelect('#settings-motapis-model', free.motapis);
    syncSelect('#settings-gemini-model', free.gemini);
  }

  // =========================================================================
  // SETTINGS & STORAGE
  // =========================================================================

  _loadSettings() {
    try {
      if (typeof localStorage !== 'undefined') {
        const savedRaw = localStorage.getItem('blender_ai_copilot_settings');
        if (savedRaw) {
          try {
            const saved = JSON.parse(savedRaw);
            // Never resurrect credential material or custom endpoints from browser storage.
            ['geminiKey', 'openAiKey', 'customKey', 'customEndpoint'].forEach(k => delete saved[k]);
            this.settings = { ...this.settings, ...saved };
          } catch (_) {}
        }
        // One-time cleanup of legacy plaintext key storage.
        ['gemini_api_key', 'copilot_gemini_key', 'openai_api_key', 'copilot_openai_key',
         'motapis_api_key', 'custom_api_key'].forEach(k => {
          try { localStorage.removeItem(k); } catch (_) {}
        });
      }

      if (typeof window !== 'undefined' && window.location) {
        const params = new URLSearchParams(window.location.search);
        if (params.get('geminiModel')) this.settings.geminiModel = params.get('geminiModel');
        if (params.get('motapisModel') || params.get('customModel') || params.get('model')) {
          this.settings.customModel = params.get('motapisModel') || params.get('customModel') || params.get('model');
        }
        if (params.get('provider')) this.settings.provider = params.get('provider');
      }
      this._normalizeProviderAndModels();

      // The backend tells us which providers are configured; defer off initial critical boot path.
      if (typeof fetch === 'function') {
        const loadServerCfg = () => {
          fetch('/api/config')
            .then(res => res.ok ? res.json() : null)
            .then(cfg => {
              if (!cfg) return;
              this.serverCapabilities = {
                gemini: !!cfg.geminiConfigured,
                openai: !!cfg.openAiConfigured,
                custom: !!cfg.hasCustomKeys,
              };
              this.serverFreeModels = cfg.freeModels || null;
              if (Array.isArray(cfg.freeModels?.motapis)) {
                cfg.freeModels.motapis.forEach((m) => {
                  if (typeof m === 'string' && m.trim()) this._verifiedModels.motapis.add(m.trim());
                });
              }
              if (Array.isArray(cfg.freeModels?.gemini)) {
                cfg.freeModels.gemini.forEach((m) => {
                  if (typeof m === 'string' && m.trim()) this._verifiedModels.gemini.add(m.trim());
                });
              }
              if (cfg.customModel) {
                this._verifiedModels.motapis.add(cfg.customModel);
                this.settings.customModel = cfg.customModel;
              }
              if (cfg.geminiModel) {
                this._verifiedModels.gemini.add(cfg.geminiModel);
                this.settings.geminiModel = cfg.geminiModel;
              }
              if (cfg.provider && cfg.provider !== 'offline') this.settings.provider = cfg.provider;
              if (!this.settings.provider || this.settings.provider === 'offline' || this.settings.provider === 'openai') {
                this.settings.provider = cfg.hasCustomKeys ? 'motapis' : (cfg.geminiConfigured ? 'gemini' : 'motapis');
              }
              if (this.settings.provider === 'motapis' && !cfg.hasCustomKeys && cfg.geminiConfigured) {
                this.settings.provider = 'gemini';
              }
              this._normalizeProviderAndModels();
              this._syncServerModelsToDom();
              this._updateBadge();
            })
            .catch(() => {});
        };
        if (typeof requestIdleCallback === 'function') {
          requestIdleCallback(loadServerCfg, { timeout: 2500 });
        } else {
          setTimeout(loadServerCfg, 1500);
        }
      }
    } catch (e) {
      console.warn('[AICopilot] Failed to load settings:', e);
    }
  }

  _saveSettings() {
    try {
      this._normalizeProviderAndModels();
      if (typeof localStorage !== 'undefined') {
        const { geminiKey, openAiKey, customKey, customEndpoint, ...safe } = this.settings;
        localStorage.setItem('blender_ai_copilot_settings', JSON.stringify(safe));
      }
      if (typeof fetch === 'function') {
        const payload = {
          provider: this.settings.provider,
          customModel: this.settings.customModel,
          geminiModel: this.settings.geminiModel,
        };
        fetch('/api/config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        }).catch(() => {});
      }
    } catch (e) {
      console.warn('[AICopilot] Failed to save settings:', e);
    }
  }

  // =========================================================================
  // DOM CREATION & STYLING
  // =========================================================================

  _injectStyles() {
    if (document.getElementById('blender-copilot-styles')) return;

    const style = document.createElement('style');
    style.id = 'blender-copilot-styles';
    style.textContent = `
      /* AI Copilot 2.0 Floating Window */
      .blender-copilot-panel {
        position: fixed;
        bottom: 50px;
        left: 60px;
        right: auto;
        width: 440px;
        max-width: calc(100vw - 48px);
        height: 580px;
        max-height: calc(100vh - 120px);
        background-color: #242424;
        border: 1px solid #444444;
        border-radius: 8px;
        box-shadow: 0 16px 40px rgba(0, 0, 0, 0.65), 0 0 0 1px rgba(255, 255, 255, 0.05);
        display: flex;
        flex-direction: column;
        z-index: 10000;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
        color: #e0e0e0;
        overflow: hidden;
        transition: transform 0.2s cubic-bezier(0.16, 1, 0.3, 1), opacity 0.2s ease;
      }

      .blender-copilot-panel.minimized {
        height: 44px;
        overflow: hidden;
      }

      .blender-copilot-panel.hidden {
        display: none !important;
      }

      /* Header */
      .copilot-header {
        height: 44px;
        flex-shrink: 0;
        background: linear-gradient(180deg, #2f2f2f 0%, #282828 100%);
        border-bottom: 1px solid #3c3c3c;
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 0 12px;
        cursor: grab;
        user-select: none;
      }

      .copilot-title-group {
        display: flex;
        align-items: center;
        gap: 6px;
        min-width: 0;
        flex: 1;
        overflow: hidden;
      }

      .copilot-logo {
        width: 22px;
        height: 22px;
        flex-shrink: 0;
        border-radius: 5px;
        background: linear-gradient(135deg, #e67e22, #d35400);
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 13px;
        color: white;
        box-shadow: 0 2px 6px rgba(230, 126, 34, 0.4);
      }

      .copilot-title {
        font-size: 13px;
        font-weight: 600;
        color: #f1f2f6;
        white-space: nowrap;
        flex-shrink: 0;
      }

      .copilot-provider-badge {
        font-size: 10px;
        padding: 2px 6px;
        border-radius: 4px;
        font-weight: 500;
        background-color: #383838;
        color: #00cec9;
        border: 1px solid rgba(0, 206, 201, 0.3);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        max-width: 145px;
      }

      .copilot-provider-badge.cloud {
        color: #a29bfe;
        border-color: rgba(162, 155, 254, 0.3);
      }

      .copilot-context-pill {
        font-size: 9.5px;
        padding: 2px 6px;
        border-radius: 10px;
        background: rgba(230, 126, 34, 0.2);
        color: #f39c12;
        border: 1px solid rgba(230, 126, 34, 0.4);
        display: inline-flex;
        align-items: center;
        gap: 3px;
      }

      .copilot-actions {
        display: flex;
        align-items: center;
        gap: 4px;
      }

      .copilot-btn-icon {
        width: 26px;
        height: 26px;
        background: transparent;
        border: none;
        color: #999;
        border-radius: 4px;
        display: flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
        transition: all 0.15s ease;
      }

      .copilot-btn-icon:hover {
        background-color: #3e3e3e;
        color: #fff;
      }

      /* Quick Prompts Bar */
      .copilot-quick-prompts {
        display: flex;
        gap: 6px;
        padding: 8px 12px;
        overflow-x: auto;
        background-color: #1c1c1c;
        border-bottom: 1px solid #333333;
        scrollbar-width: thin;
        scrollbar-color: #444 #1c1c1c;
        flex-shrink: 0;
      }

      .quick-chip {
        white-space: nowrap;
        background-color: #2b2b2b;
        color: #b2bec3;
        font-size: 11px;
        padding: 4px 10px;
        border-radius: 12px;
        border: 1px solid #3c3c3c;
        cursor: pointer;
        transition: all 0.15s ease;
        flex-shrink: 0;
      }

      .quick-chip:hover {
        background-color: #3d3d3d;
        color: #fff;
        border-color: #e67e22;
        transform: translateY(-1px);
      }

      .quick-chip.chip-edit {
        border-color: rgba(0, 206, 201, 0.5);
        color: #81ecec;
      }

      .quick-chip.chip-edit:hover {
        background-color: #006266;
        color: #fff;
      }

      /* Chat Messages Scrollview */
      .copilot-messages {
        flex: 1 1 0px;
        min-height: 0;
        overflow-y: auto;
        padding: 12px;
        display: flex;
        flex-direction: column;
        gap: 12px;
        background-color: #1e1e1e;
      }

      .copilot-msg {
        display: flex;
        flex-direction: column;
        max-width: 90%;
        animation: copilotFadeIn 0.2s ease;
      }

      @keyframes copilotFadeIn {
        from { opacity: 0; transform: translateY(6px); }
        to { opacity: 1; transform: translateY(0); }
      }

      .copilot-msg.user {
        align-self: flex-end;
      }

      .copilot-msg.bot {
        align-self: flex-start;
      }

      .copilot-msg-bubble {
        padding: 10px 14px;
        border-radius: 8px;
        font-size: 12.5px;
        line-height: 1.5;
        word-break: break-word;
      }

      .copilot-msg.user .copilot-msg-bubble {
        background-color: #1e3799;
        color: #ffffff;
        border-bottom-right-radius: 2px;
      }

      .copilot-msg.bot .copilot-msg-bubble {
        background-color: #2c2c2c;
        color: #dfe6e9;
        border: 1px solid #3a3a3a;
        border-bottom-left-radius: 2px;
      }

      .copilot-msg-bubble blockquote {
        margin: 6px 0;
        padding: 6px 10px;
        border-left: 3px solid #54a0ff;
        background-color: rgba(255, 255, 255, 0.06);
        color: #e2e8f0;
        border-radius: 0 4px 4px 0;
        font-size: 12px;
      }

      /* Code Block in Bot Message */
      .copilot-code-block {
        margin-top: 8px;
        background-color: #141414;
        border: 1px solid #333333;
        border-radius: 6px;
        overflow: hidden;
      }

      .copilot-code-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 4px 8px;
        background-color: #1a1a1a;
        border-bottom: 1px solid #2a2a2a;
        font-size: 10px;
        color: #888888;
        font-family: monospace;
      }

      .copilot-code-actions {
        display: flex;
        gap: 4px;
      }

      .copilot-code-btn {
        background: transparent;
        border: 1px solid #3a3a3a;
        border-radius: 3px;
        color: #aaa;
        font-size: 10px;
        padding: 2px 6px;
        cursor: pointer;
        transition: all 0.15s;
      }

      .copilot-code-btn:hover {
        background: #333;
        color: #fff;
      }

      .copilot-code-btn.run-btn {
        background: #27ae60;
        color: white;
        border-color: #2ecc71;
      }

      .copilot-code-btn.run-btn:hover {
        background: #2ecc71;
      }

      .copilot-code-pre {
        margin: 0;
        padding: 8px;
        font-family: "JetBrains Mono", Consolas, monospace;
        font-size: 11px;
        color: #00d2d3;
        overflow-x: auto;
        max-height: 180px;
      }

      /* Shimmer Thinking Indicator */
      .copilot-thinking {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 8px 12px;
        color: #888;
        font-size: 12px;
        font-style: italic;
      }

      .thinking-dot {
        width: 6px;
        height: 6px;
        background-color: #e67e22;
        border-radius: 50%;
        animation: pulseDot 1.4s infinite ease-in-out both;
      }

      .thinking-dot:nth-child(1) { animation-delay: -0.32s; }
      .thinking-dot:nth-child(2) { animation-delay: -0.16s; }

      @keyframes pulseDot {
        0%, 80%, 100% { transform: scale(0); opacity: 0.3; }
        40% { transform: scale(1); opacity: 1; }
      }

      /* Input Bar */
      .copilot-input-area {
        padding: 8px 12px;
        background-color: #242424;
        border-top: 1px solid #333333;
        display: flex;
        gap: 8px;
        align-items: center;
        flex-shrink: 0;
      }

      .copilot-textarea {
        flex: 1;
        background-color: #181818;
        border: 1px solid #3a3a3a;
        border-radius: 6px;
        padding: 8px 10px;
        color: #ffffff;
        font-family: inherit;
        font-size: 12px;
        resize: none;
        height: 36px;
        min-height: 36px;
        max-height: 90px;
        line-height: 18px;
        box-sizing: border-box;
        outline: none;
        transition: border-color 0.2s;
      }

      .copilot-textarea:focus {
        border-color: #e67e22;
      }

      /* Image Upload & Attachment Tray */
      .copilot-img-btn {
        width: 34px;
        height: 34px;
        background-color: #2b2b2b;
        border: 1px solid #3e3e3e;
        border-radius: 6px;
        color: #e0e0e0;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 15px;
        transition: all 0.2s ease;
        flex-shrink: 0;
      }

      .copilot-img-btn:hover {
        background-color: #3d3d3d;
        border-color: #3498db;
        color: #fff;
        transform: scale(1.04);
      }

      .copilot-attachments-tray {
        display: flex;
        gap: 8px;
        padding: 6px 12px;
        background-color: #1a1a1a;
        border-top: 1px solid #333;
        overflow-x: auto;
        flex-shrink: 0;
        max-height: 60px;
      }

      .copilot-img-chip {
        display: flex;
        align-items: center;
        gap: 6px;
        background: #282828;
        border: 1px solid #444;
        border-radius: 6px;
        padding: 3px 8px 3px 4px;
        font-size: 11px;
        color: #ddd;
        position: relative;
        flex-shrink: 0;
      }

      .copilot-thumb-img {
        width: 28px;
        height: 28px;
        object-fit: cover;
        border-radius: 4px;
        border: 1px solid #555;
      }

      .copilot-thumb-name {
        max-width: 90px;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .copilot-thumb-remove {
        background: #444;
        border: none;
        color: #fff;
        width: 16px;
        height: 16px;
        border-radius: 50%;
        display: flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
        font-size: 10px;
        margin-left: 2px;
      }

      .copilot-thumb-remove:hover {
        background: #e74c3c;
      }

      .copilot-dropzone-active {
        border: 2px dashed #3498db !important;
        background-color: rgba(52, 152, 219, 0.08) !important;
      }

      /* In-chat Image Display */
      .copilot-msg-images {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        margin-bottom: 8px;
      }

      .copilot-msg-image-wrap {
        position: relative;
        border-radius: 6px;
        overflow: hidden;
        border: 1px solid #444;
        background: #111;
        max-width: 240px;
      }

      .copilot-chat-img {
        max-width: 100%;
        max-height: 180px;
        display: block;
        cursor: pointer;
        transition: transform 0.2s;
      }

      .copilot-chat-img:hover {
        transform: scale(1.02);
      }

      .copilot-btn-ref-plane {
        display: block;
        width: 100%;
        background: rgba(30, 30, 30, 0.95);
        border: none;
        border-top: 1px solid #444;
        color: #3498db;
        font-size: 10px;
        font-weight: 600;
        padding: 4px 6px;
        cursor: pointer;
        text-align: center;
        transition: all 0.15s ease;
      }

      .copilot-btn-ref-plane:hover {
        background: #2980b9;
        color: #fff;
      }

      /* Microphone Voice Button (Web Speech API) */
      .copilot-mic-btn {
        width: 34px;
        height: 34px;
        background-color: #2b2b2b;
        border: 1px solid #3e3e3e;
        border-radius: 6px;
        color: #e0e0e0;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 15px;
        transition: all 0.2s ease;
        flex-shrink: 0;
      }

      .copilot-mic-btn:hover {
        background-color: #3d3d3d;
        border-color: #e67e22;
        color: #fff;
      }

      .copilot-mic-btn.listening {
        background-color: #c0392b;
        border-color: #e74c3c;
        color: #ffffff;
        box-shadow: 0 0 12px rgba(231, 76, 60, 0.8);
        animation: micPulse 1.2s infinite alternate ease-in-out;
      }

      @keyframes micPulse {
        0% { transform: scale(1); box-shadow: 0 0 4px rgba(231, 76, 60, 0.4); }
        100% { transform: scale(1.08); box-shadow: 0 0 16px rgba(231, 76, 60, 0.9); }
      }

      .copilot-send-btn {
        width: 34px;
        height: 34px;
        background: linear-gradient(135deg, #e67e22, #d35400);
        border: none;
        border-radius: 6px;
        color: white;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        transition: all 0.15s ease;
        flex-shrink: 0;
      }

      .copilot-send-btn:hover {
        filter: brightness(1.15);
        transform: scale(1.04);
      }

      .copilot-send-btn:disabled {
        opacity: 0.4;
        cursor: not-allowed;
        transform: none;
      }

      /* Floating Open Pill Button (when Copilot is closed) */
      .copilot-fab-btn {
        position: absolute;
        bottom: 14px;
        left: 14px;
        right: auto;
        height: 32px;
        padding: 0 13px;
        background: linear-gradient(135deg, #e67e22, #d35400);
        color: white;
        border: 1px solid rgba(255, 255, 255, 0.25);
        border-radius: 16px;
        font-weight: 600;
        font-size: 11.5px;
        display: flex;
        align-items: center;
        gap: 6px;
        cursor: pointer;
        box-shadow: 0 6px 18px rgba(230, 126, 34, 0.35);
        z-index: 30;
        transition: all 0.2s ease;
      }

      .copilot-fab-btn:hover {
        transform: translateY(-2px);
        box-shadow: 0 12px 28px rgba(230, 126, 34, 0.6);
      }

      /* Settings Modal */
      .copilot-settings-modal {
        position: absolute;
        inset: 44px 0 0 0;
        background-color: #222222;
        padding: 16px;
        display: flex;
        flex-direction: column;
        gap: 12px;
        z-index: 10;
        overflow-y: auto;
      }

      .copilot-settings-modal.hidden {
        display: none;
      }

      .settings-title {
        font-size: 13px;
        font-weight: 600;
        color: #fff;
        border-bottom: 1px solid #333;
        padding-bottom: 6px;
      }

      .settings-row {
        display: flex;
        flex-direction: column;
        gap: 4px;
      }

      .settings-label {
        font-size: 11px;
        color: #aaa;
      }

      .settings-input, .settings-select {
        background-color: #161616;
        border: 1px solid #3a3a3a;
        color: #eee;
        padding: 6px 8px;
        border-radius: 4px;
        font-size: 12px;
      }

      .settings-group {
        display: flex;
        flex-direction: column;
        gap: 8px;
        background: #1c1c1c;
        padding: 10px;
        border-radius: 6px;
        border: 1px solid #333333;
      }

      .settings-hint {
        font-size: 10.5px;
        color: #888888;
        line-height: 1.35;
      }

      .settings-btn-test {
        background: #2c3e50;
        color: #ecf0f1;
        border: 1px solid #34495e;
        border-radius: 4px;
        padding: 5px 10px;
        font-size: 11px;
        cursor: pointer;
        font-weight: 500;
        transition: all 0.15s ease;
      }

      .settings-btn-test:hover {
        background: #34495e;
        color: #ffffff;
      }

      .settings-test-status {
        font-size: 11px;
        font-weight: 500;
      }

      .settings-footer {
        margin-top: auto;
        display: flex;
        justify-content: flex-end;
        gap: 8px;
      }

      .settings-btn {
        padding: 6px 14px;
        border-radius: 4px;
        font-size: 12px;
        cursor: pointer;
        border: 1px solid #444;
      }

      @keyframes spin {
        0% { transform: rotate(0deg); }
        100% { transform: rotate(360deg); }
      }

      .copilot-thinking-box {
        background: #1e222a;
        border: 1px solid #34495e;
        border-radius: 8px;
        padding: 12px 14px;
        margin: 8px 0;
        box-shadow: 0 4px 12px rgba(0,0,0,0.4);
      }

      .blender-construction-hud {
        position: absolute;
        top: 20px;
        left: 50%;
        transform: translateX(-50%);
        z-index: 1000;
        pointer-events: auto;
        display: flex;
        align-items: center;
        gap: 12px;
        background: rgba(18, 22, 28, 0.96);
        border: 1px solid rgba(0, 206, 201, 0.45);
        box-shadow: 0 10px 30px rgba(0, 0, 0, 0.6), 0 0 18px rgba(0, 206, 201, 0.25);
        border-radius: 30px;
        padding: 8px 18px 8px 14px;
        color: #fff;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        animation: hudFadeIn 0.3s cubic-bezier(0.16, 1, 0.3, 1);
        transition: opacity 0.35s ease, transform 0.35s ease;
      }

      .blender-construction-hud.hud-hidden {
        opacity: 0;
        transform: translate(-50%, -15px) scale(0.92);
        pointer-events: none;
      }

      @keyframes hudFadeIn {
        from { opacity: 0; transform: translate(-50%, -12px) scale(0.95); }
        to { opacity: 1; transform: translate(-50%, 0) scale(1); }
      }

      .hud-pulse-dot {
        width: 10px;
        height: 10px;
        background: #00cec9;
        border-radius: 50%;
        box-shadow: 0 0 8px #00cec9;
        animation: hudPulse 1.2s infinite ease-in-out;
      }

      @keyframes hudPulse {
        0%, 100% { transform: scale(0.85); opacity: 0.7; }
        50% { transform: scale(1.3); opacity: 1; box-shadow: 0 0 14px #00cec9; }
      }

      .hud-badge-tag {
        font-size: 10px;
        font-weight: 700;
        letter-spacing: 0.6px;
        color: #00cec9;
        text-transform: uppercase;
        background: rgba(0, 206, 201, 0.12);
        padding: 2px 7px;
        border-radius: 10px;
        border: 1px solid rgba(0, 206, 201, 0.3);
      }

      .hud-step-text {
        font-size: 12.5px;
        font-weight: 600;
        color: #ffffff;
        max-width: 320px;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .hud-sub-text {
        font-size: 11px;
        color: #a0aec0;
        margin-top: 1px;
        max-width: 320px;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .hud-skip-btn {
        background: rgba(255, 255, 255, 0.1);
        border: 1px solid rgba(255, 255, 255, 0.2);
        color: #e2e8f0;
        font-size: 11px;
        font-weight: 600;
        padding: 4px 10px;
        border-radius: 14px;
        cursor: pointer;
        transition: all 0.2s ease;
        margin-left: 4px;
      }

      .hud-skip-btn:hover {
        background: rgba(231, 76, 60, 0.85);
        border-color: #e74c3c;
        color: #fff;
      }

      .copilot-human-mode-toggle {
        background: rgba(0, 206, 201, 0.15);
        border: 1px solid #00cec9;
        color: #00cec9;
        font-size: 11px;
        font-weight: 600;
        padding: 2px 8px;
        border-radius: 12px;
        cursor: pointer;
        display: inline-flex;
        align-items: center;
        gap: 4px;
        white-space: nowrap;
        flex-shrink: 0;
        transition: all 0.2s ease;
      }

      .copilot-human-mode-toggle.disabled {
        background: #2a2a2a;
        border-color: #444;
        color: #888;
      }

      /* Modular Skill Router Bar */
      .copilot-skills-bar {
        display: flex;
        align-items: center;
        gap: 4px;
        padding: 5px 10px;
        background: #1b1d22;
        border-bottom: 1px solid #2e3138;
        overflow-x: auto;
        scrollbar-width: none;
        flex-shrink: 0;
      }
      .copilot-skills-bar::-webkit-scrollbar { display: none; }
      .copilot-skill-pill {
        background: #252830;
        border: 1px solid #383c46;
        color: #b7becb;
        font-size: 10.5px;
        font-weight: 500;
        padding: 2px 7px;
        border-radius: 11px;
        cursor: pointer;
        white-space: nowrap;
        flex-shrink: 0;
        transition: all 0.15s ease;
      }
      .copilot-skill-pill:hover {
        border-color: #e67e22;
        color: #fff;
      }
      .copilot-skill-pill.auto-active {
        background: rgba(52, 152, 219, 0.16);
        border-color: rgba(84, 160, 255, 0.65);
        color: #9ed0ff;
      }
      .copilot-skill-pill.pinned {
        background: rgba(230, 126, 34, 0.22);
        border-color: #e67e22;
        color: #ffd3a6;
        font-weight: 600;
      }

      .settings-btn.save {
        background-color: #27ae60;
        color: white;
        border-color: #2ecc71;
      }
    `;
    document.head.appendChild(style);
  }

  _createDOM() {
    // 1. Floating Toggle Button (FAB) — mounted inside 3D Viewport so it never overlaps Bottom Dock
    this.fabBtn = document.createElement('button');
    this.fabBtn.className = 'copilot-fab-btn';
    this.fabBtn.style.display = 'flex';
    this.fabBtn.innerHTML = `<span>✨</span><span>Hunger AI Copilot</span>`;
    const vpHost = document.getElementById('viewport-canvas-host') || this.container;
    vpHost.appendChild(this.fabBtn);

    // 2. Main Window Panel
    this.panel = document.createElement('div');
    this.panel.className = 'blender-copilot-panel hidden'; // Hidden by default so right sidebar is never blocked!
    this.panel.innerHTML = `
      <!-- Header -->
      <div class="copilot-header" id="copilot-drag-handle">
        <div class="copilot-title-group">
          <div class="copilot-logo">🤖</div>
          <span class="copilot-title">AI Copilot 3D</span>
          <span class="copilot-provider-badge cloud" id="copilot-badge">🚀 Cloud AI</span>
          <button class="copilot-human-mode-toggle" id="btn-toggle-vision-qa" title="2-Pass Vision Self-Critique: AI chụp lại ảnh 3D vừa dựng, tự soi lỗi & nâng cấp chi tiết">🔍 Vision QA: ON</button>
          <button class="copilot-human-mode-toggle" id="btn-toggle-human-mode" title="Toggle live visual build mode: AI sculpts and assembles objects step-by-step">🎬 Live Build: ON</button>
          <span class="copilot-context-pill" id="copilot-context-badge" title="Current model context" style="display:none;"></span>
        </div>
        <div class="copilot-actions">
          <button class="copilot-btn-icon" id="copilot-btn-undo" title="Hoàn tác thao tác 3D vừa dựng (Ctrl+Z)">↩</button>
          <button class="copilot-btn-icon" id="copilot-btn-clear-chat" title="Làm mới khung chat (giữ nguyên cảnh 3D)">🧹</button>
          <button class="copilot-btn-icon" id="copilot-btn-wake" title="Lệnh gọi tự khởi động (Alt+Shift+V): nói 'Copilot ơi...' hoặc 'Thầy ơi...'">🎧</button>
          <button class="copilot-btn-icon" id="copilot-btn-settings" title="AI Model &amp; Behavior Settings">⚙️</button>
          <button class="copilot-btn-icon" id="copilot-btn-minimize" title="Minimize">_</button>
          <button class="copilot-btn-icon" id="copilot-btn-close" title="Close">✕</button>
        </div>
      </div>

      <!-- Modular Skill Router Bar (Auto or User-Pinned Specialist Skills) -->
      <div class="copilot-skills-bar" id="copilot-skills-bar" title="Kỹ năng chuyên môn AI Copilot — Auto tự chọn theo yêu cầu hoặc bấm để ghim">
        <button class="copilot-skill-pill pinned" data-skill="auto" title="Tự động chọn 1–3 kỹ năng phù hợp theo prompt & ảnh">✨ Auto</button>
        ${getCopilotSkillCatalog().map((s) => `<button class="copilot-skill-pill" data-skill="${s.id}" title="${escapeHtml(s.title)} — ${escapeHtml(s.summary)}">${s.icon} ${escapeHtml(s.label)}</button>`).join('')}
      </div>

      <!-- Quick Prompts Bar -->
      <div class="copilot-quick-prompts">
        <button class="quick-chip" data-prompt="Create an aerodynamic red 3D sports supercar">🏎️ Sports Supercar</button>
        <button class="quick-chip" data-prompt="Build a stone medieval castle with watchtowers and gatehouse">🏰 Medieval Castle</button>
        <button class="quick-chip" data-prompt="Create a space exploration starship with plasma thrusters">🚀 Spaceship</button>
        <button class="quick-chip" data-prompt="Create a modern villa swimming pool with clear blue water">🏊 Modern Pool</button>
        <button class="quick-chip" data-prompt="Build a suspension bridge with twin towers and cables">🌉 Suspension Bridge</button>
        <button class="quick-chip" data-prompt="Design a luxury living room interior with leather sofa and coffee table">🛋️ Luxury Living Room</button>
        <button class="quick-chip" data-prompt="Create a modern garden house">🏡 Modern Garden House</button>
        <button class="quick-chip chip-edit" data-prompt="Add a swimming pool in front of the house">➕ Add Front Pool</button>
        <button class="quick-chip chip-edit" data-prompt="Make the roof blue">🎨 Blue Roof</button>
        <button class="quick-chip chip-edit" data-prompt="Add 3 pine trees on the left">🌲 Add 3 Pine Trees</button>
        <button class="quick-chip chip-edit" data-prompt="Rotate the selected object 45 degrees">🔄 Rotate 45°</button>
        <button class="quick-chip" data-prompt="Create a cyberpunk city with neon lights">🏙️ Cyberpunk City</button>
        <button class="quick-chip" data-prompt="Add a battle robot in the center">🤖 Battle Robot</button>
        <button class="quick-chip" data-action="clear-scene" data-prompt="Clear all objects in scene">🗑️ Clear Scene</button>
      </div>

      <!-- Messages View -->
      <div class="copilot-messages" id="copilot-message-list"></div>

      <!-- Attachments Preview Tray -->
      <div class="copilot-attachments-tray" id="copilot-attachments-tray" style="display:none;"></div>

      <!-- Input Area with Image Upload & Voice Microphone Button -->
      <div class="copilot-input-area" id="copilot-input-area">
        <input type="file" id="copilot-file-input" accept="image/png, image/jpeg, image/webp, image/gif" style="display:none;" multiple>
        <button class="copilot-img-btn" id="copilot-img-btn" title="Attach Reference / Concept Art / Blueprint (PNG, JPG, WebP) or Drag & Drop / Ctrl+V">🖼️</button>
        <button class="copilot-mic-btn" id="copilot-mic-btn" title="Voice Input (Web Speech API)">🎙️</button>
        <textarea class="copilot-textarea" id="copilot-input" rows="1" placeholder="Ask AI, attach an image 🖼️, or speak 🎙️..."></textarea>
        <button class="copilot-send-btn" id="copilot-send-btn" title="Send Request">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="22" y1="2" x2="11" y2="13"></line>
            <polygon points="22 2 15 22 11 13 2 9 22 2"></polygon>
          </svg>
        </button>
        <button class="copilot-send-btn" id="copilot-stop-btn" title="Stop AI Generation" hidden style="background:#991b1b;">■</button>
      </div>

      <!-- Settings Overlay Modal (End-User Safe: Verified Free-Tier Models & Behavior Only) -->
      <div class="copilot-settings-modal hidden" id="copilot-settings-modal">
        <div class="settings-title">AI Copilot 3D — Cài đặt Mô hình</div>
        <div class="settings-row">
          <label class="settings-label">Nguồn AI (Cloud Provider)</label>
          <select class="settings-select" id="settings-provider">
            <option value="motapis">🚀 Cloud Multi-Model (Claude / GPT / DeepSeek / Grok)</option>
            <option value="gemini">✨ Google Gemini (Nhanh &amp; Multimodal)</option>
          </select>
        </div>

        <!-- Multi-Model Verified List -->
        <div class="settings-group" id="group-motapis-settings">
          <div class="settings-row">
            <label class="settings-label" style="font-weight: 600; color: #2ecc71; display: flex; justify-content: space-between;">
              <span>🤖 Chọn Model Cloud (15 Model ổn định)</span>
              <span style="font-size: 11px; color: #888;">(Đã xác thực live)</span>
            </label>
            <select class="settings-input" id="settings-motapis-model" style="cursor: pointer; font-size: 13px; font-weight: 500; padding: 7px 8px; background: #26292b; color: #fff; border: 1px solid #3d4448;">
              <optgroup label="🌟 Khuyên dùng cho Three.js 3D" style="background: #1e2022; color: #f39c12; font-weight: bold;">
                <option value="claude-sonnet-4-6" selected style="color: #fff;">claude-sonnet-4-6 (Khuyên dùng — Chuẩn 3D nhất)</option>
                <option value="claude-sonnet-5-5" style="color: #fff;">claude-sonnet-5-5 (Claude 5.5 mới)</option>
              </optgroup>
              <optgroup label="⚡ OpenAI Series (Cloud Pool)" style="background: #1e2022; color: #1abc9c; font-weight: bold;">
                <option value="gpt-6-luna" style="color: #fff;">gpt-6-luna (Nhanh &amp; ổn định)</option>
                <option value="gpt-6-astra" style="color: #fff;">gpt-6-astra (Cân bằng)</option>
                <option value="gpt-5.6-sol" style="color: #fff;">gpt-5.6-sol (Suy luận sâu — chậm hơn)</option>
              </optgroup>
              <optgroup label="🚀 DeepSeek, GLM &amp; MiniMax (Tốc độ cao)" style="background: #1e2022; color: #3498db; font-weight: bold;">
                <option value="deepseek-v4-flash" style="color: #fff;">deepseek-v4-flash (DeepSeek Nhanh)</option>
                <option value="DeepSeek-V4-Flash-0731" style="color: #fff;">DeepSeek-V4-Flash-0731 (DeepSeek 0731)</option>
                <option value="deepseek-v4.1-flash-1017" style="color: #fff;">deepseek-v4.1-flash-1017 (DeepSeek 4.1 Flash)</option>
                <option value="glm-5.3-flash" style="color: #fff;">glm-5.3-flash (GLM 5.3 Flash)</option>
                <option value="minimax-m3" style="color: #fff;">minimax-m3 (MiniMax M3 — Cực nhanh)</option>
                <option value="minimax-m2.7" style="color: #fff;">minimax-m2.7 (MiniMax M2.7)</option>
              </optgroup>
              <optgroup label="🌐 Gemini / Grok / Kimi / Hunyuan" style="background: #1e2022; color: #9b59b6; font-weight: bold;">
                <option value="gemini-4-hydrogen" style="color: #fff;">gemini-4-hydrogen (Gemini 4 Hydrogen)</option>
                <option value="grok-4.5" style="color: #fff;">grok-4.5 (xAI Grok 4.5)</option>
                <option value="kimi-k3.1-pro" style="color: #fff;">kimi-k3.1-pro (Moonshot Kimi K3.1)</option>
                <option value="hy4-preview" style="color: #fff;">hy4-preview (Hunyuan 4 Reasoning)</option>
              </optgroup>
            </select>
            <div class="settings-hint">Các model được giữ lại sau khi kiểm tra live với endpoint Motapis.</div>
          </div>
        </div>

        <!-- Google Gemini Verified Free-Tier List -->
        <div class="settings-row" id="group-gemini-model">
          <label class="settings-label" style="font-weight: 600; color: #4285f4; display: flex; justify-content: space-between;">
            <span>✨ Chọn Model Gemini (6 Model Free Tier)</span>
            <span style="font-size: 11px; color: #888;">(Google AI)</span>
          </label>
          <select class="settings-input" id="settings-gemini-model" style="cursor: pointer; font-size: 13px; font-weight: 500; padding: 7px 8px; background: #26292b; color: #fff; border: 1px solid #3d4448;">
            <optgroup label="⚡ Nhanh &amp; Ổn định nhất (Free Tier)" style="background: #1e2022; color: #4285f4; font-weight: bold;">
              <option value="gemini-3.5-flash-lite" selected style="color: #fff;">gemini-3.5-flash-lite (Khuyên dùng — ~1s, ổn định nhất)</option>
              <option value="gemini-3-flash-preview" style="color: #fff;">gemini-3-flash-preview (Nhanh ~1.5s)</option>
              <option value="gemini-3.1-flash-lite" style="color: #fff;">gemini-3.1-flash-lite (Cân bằng ~5s)</option>
              <option value="gemini-3.1-flash-lite-preview" style="color: #fff;">gemini-3.1-flash-lite-preview (Flash-Lite Preview)</option>
            </optgroup>
            <optgroup label="🧠 Suy luận / Mở rộng (Free Tier)" style="background: #1e2022; color: #9b59b6; font-weight: bold;">
              <option value="gemini-3.8-flash" style="color: #fff;">gemini-3.8-flash (Thông minh — dễ bận giờ cao điểm)</option>
              <option value="gemma-4-31b-it" style="color: #fff;">gemma-4-31b-it (Gemma 4 31B Open Model)</option>
            </optgroup>
          </select>
          <div class="settings-hint">Đã lọc bỏ các model ngừng hỗ trợ hoặc yêu cầu gói trả phí.</div>
        </div>

        <div class="settings-row">
          <label class="settings-label">🎙️ Ngôn ngữ nhận diện giọng nói</label>
          <select class="settings-select" id="settings-voice-lang">
            <option value="vi-VN">🇻🇳 Tiếng Việt (vi-VN)</option>
            <option value="en-US">🇺🇸 English (en-US)</option>
          </select>
        </div>

        <div class="settings-row">
          <label class="settings-label" style="display: flex; align-items: center; gap: 6px; cursor: pointer;">
            <input type="checkbox" id="settings-autorun" checked />
            Tự động chạy mã tạo hình trong 3D Viewport
          </label>
        </div>
        <div class="settings-row">
          <label class="settings-label" style="display: flex; align-items: center; gap: 6px; cursor: pointer;">
            <input type="checkbox" id="settings-visual-critique" checked />
            🔍 Tự soi ảnh 3D &amp; nâng cấp chi tiết (2-Pass Vision QA)
          </label>
        </div>
        <div class="settings-row">
          <label class="settings-label" style="display: flex; align-items: center; gap: 6px; cursor: pointer;">
            <input type="checkbox" id="settings-human-mode" checked />
            🎬 Hiệu ứng dựng hình từng bước (Live Build)
          </label>
        </div>
        <div class="settings-row">
          <label class="settings-label" style="display: flex; align-items: center; gap: 6px; cursor: pointer;">
            <input type="checkbox" id="settings-wake-listen" />
            🎧 Lệnh gọi tự khởi động ("Copilot ơi..." / "Thầy ơi...")
          </label>
        </div>
        <div class="settings-row">
          <label class="settings-label">Tốc độ hiệu ứng dựng hình</label>
          <select class="settings-select" id="settings-construction-speed">
            <option value="200">Chậm (Chi tiết)</option>
            <option value="130" selected>Bình thường</option>
            <option value="55">Nhanh</option>
          </select>
        </div>
        <div class="settings-row">
          <label class="settings-label" for="settings-byok-key">🔑 BYOK API Key (tuỳ chọn — miễn trừ credit AI, chỉ giữ trong phiên hiện tại)</label>
          <input class="settings-input" id="settings-byok-key" type="password" autocomplete="off" placeholder="Để trống nếu dùng quota / credit của Studio..." />
        </div>
        <div class="settings-footer">
          <button class="settings-btn" id="settings-cancel">Cancel</button>
          <button class="settings-btn save" id="settings-save">Save Settings</button>
        </div>
      </div>
    `;

    this.container.appendChild(this.panel);

    // Cache DOM references
    this.messageList = this.panel.querySelector('#copilot-message-list');
    this.textarea = this.panel.querySelector('#copilot-input');
    this.sendBtn = this.panel.querySelector('#copilot-send-btn');
    this.stopBtn = this.panel.querySelector('#copilot-stop-btn');
    this.micBtn = this.panel.querySelector('#copilot-mic-btn');
    this.imgBtn = this.panel.querySelector('#copilot-img-btn');
    this.fileInput = this.panel.querySelector('#copilot-file-input');
    this.attachmentsTray = this.panel.querySelector('#copilot-attachments-tray');
    this.badge = this.panel.querySelector('#copilot-badge');
    this.contextBadge = this.panel.querySelector('#copilot-context-badge');
    this.settingsModal = this.panel.querySelector('#copilot-settings-modal');
    this.wakeBtn = this.panel.querySelector('#copilot-btn-wake');
    this.skillsBar = this.panel.querySelector('#copilot-skills-bar');

    this._updateBadge();
    this._updateContextBadge();
    this._syncSkillsBarUI();
  }

  // =========================================================================
  // EVENT BINDINGS & SPEECH RECOGNITION
  // =========================================================================

  _bindEvents() {
    // Send & Stop clicks
    this.sendBtn.addEventListener('click', () => this.handleUserSubmit());
    this.stopBtn?.addEventListener('click', () => this.stopGeneration());

    // Textarea Enter key (Shift+Enter for newline)
    this.textarea.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this.handleUserSubmit();
      }
    });

    // Auto-expand textarea
    this.textarea.addEventListener('input', () => {
      this.textarea.style.height = 'auto';
      this.textarea.style.height = Math.min(this.textarea.scrollHeight, 100) + 'px';
    });

    // Image upload button
    if (this.imgBtn && this.fileInput) {
      this.imgBtn.addEventListener('click', () => this.fileInput.click());
      this.fileInput.addEventListener('change', (e) => {
        const files = Array.from(e.target.files || []);
        files.forEach(f => this.addAttachedImage(f));
        this.fileInput.value = '';
      });
    }

    // Drag and Drop Image Support
    const dropArea = this.panel;
    if (dropArea) {
      ['dragenter', 'dragover'].forEach(eventName => {
        dropArea.addEventListener(eventName, (e) => {
          e.preventDefault();
          e.stopPropagation();
          dropArea.classList.add('copilot-dropzone-active');
        }, false);
      });

      ['dragleave', 'drop'].forEach(eventName => {
        dropArea.addEventListener(eventName, (e) => {
          e.preventDefault();
          e.stopPropagation();
          dropArea.classList.remove('copilot-dropzone-active');
        }, false);
      });

      dropArea.addEventListener('drop', (e) => {
        const dt = e.dataTransfer;
        const files = Array.from(dt?.files || []).filter(f => ALLOWED_COPILOT_IMAGE_TYPES.has((f.type || '').toLowerCase()));
        files.forEach(f => this.addAttachedImage(f));
      }, false);
    }

    // Clipboard Paste Image Support (Ctrl+V)
    if (this.textarea) {
      this.textarea.addEventListener('paste', (e) => {
        const items = Array.from(e.clipboardData?.items || []);
        items.forEach(item => {
          if (ALLOWED_COPILOT_IMAGE_TYPES.has((item.type || '').toLowerCase())) {
            const file = item.getAsFile();
            if (file) this.addAttachedImage(file);
          }
        });
      });
    }

    // Microphone speech recognition button + unified wake toggle
    if (this.micBtn) {
      this.micBtn.addEventListener('click', () => this._toggleSpeechRecognition());
    }
    if (this.wakeBtn) {
      this.wakeBtn.addEventListener('click', () => {
        const coord = this._getVoiceCoordinator();
        const enabled = coord.toggleWakeMode();
        this._syncVoiceUI();
        if (enabled) {
          this.show();
          this._addBotMessage('🎧 Đã bật **Lệnh gọi tự khởi động**! Bạn có thể nói *"Copilot ơi, tạo ngôi nhà"* hoặc *"Thầy ơi, hướng dẫn làm bàn"* bất kỳ lúc nào.');
        } else {
          this._addBotMessage('🔇 Đã tắt chế độ chờ lệnh gọi tự động.');
        }
      });
    }

    // Quick prompt chips
    this.panel.querySelectorAll('.quick-chip').forEach((btn) => {
      btn.addEventListener('click', () => {
        const action = btn.getAttribute('data-action');
        if (action === 'clear-scene') {
          this.clearSceneAndContext();
          return;
        }
        const text = btn.getAttribute('data-prompt');
        this.textarea.value = text;
        this.handleUserSubmit();
      });
    });

    // Minimize toggle
    const btnMin = this.panel.querySelector('#copilot-btn-minimize');
    btnMin.addEventListener('click', () => {
      this.isMinimized = !this.isMinimized;
      this.panel.classList.toggle('minimized', this.isMinimized);
      btnMin.textContent = this.isMinimized ? '▢' : '_';
    });

    // Close button (hides panel and shows FAB button)
    const btnClose = this.panel.querySelector('#copilot-btn-close');
    btnClose.addEventListener('click', () => this.toggleVisibility(false));

    const btnUndo = this.panel.querySelector('#copilot-btn-undo');
    if (btnUndo) {
      btnUndo.addEventListener('click', () => {
        const sm = typeof window !== 'undefined' ? window.sceneManager : null;
        if (sm?.canUndo?.()) {
          sm.undo();
          this._addBotMessage('↩ Đã hoàn tác thao tác 3D gần nhất.');
        } else {
          this._addBotMessage('ℹ️ Hiện chưa có thao tác nào trong lịch sử Undo.');
        }
      });
    }

    const btnClearChat = this.panel.querySelector('#copilot-btn-clear-chat');
    if (btnClearChat) {
      btnClearChat.addEventListener('click', () => this.clearConversationOnly());
    }

    // FAB open button
    this.fabBtn.addEventListener('click', () => this.toggleVisibility(true));

    // Settings modal open/close
    const btnSettings = this.panel.querySelector('#copilot-btn-settings');
    btnSettings.addEventListener('click', () => this._openSettingsModal());

    const btnToggleVision = this.panel.querySelector('#btn-toggle-vision-qa');
    if (btnToggleVision) {
      btnToggleVision.addEventListener('click', () => {
        this.settings.visualCritique = this.settings.visualCritique === false;
        this._updateVisionQaToggleBtn();
        this._saveSettings();
        const label = this.settings.visualCritique !== false
          ? 'ON (AI tự chụp viewport 3D sau Pass 1 để soi lỗi & nâng cấp chi tiết)'
          : 'OFF (1-Pass nhanh)';
        this._addBotMessage(`🔍 2-Pass Vision Self-Critique: **${label}**.`);
      });
      this._updateVisionQaToggleBtn();
    }

    const btnToggleHuman = this.panel.querySelector('#btn-toggle-human-mode');
    if (btnToggleHuman) {
      btnToggleHuman.addEventListener('click', () => {
        this.settings.humanConstructionMode = !this.settings.humanConstructionMode;
        this._updateHumanModeToggleBtn();
        this._saveSettings();
        const modeLabel = this.settings.humanConstructionMode ? 'ON (Simulate step-by-step 3D sculpting)' : 'OFF (Instant build)';
        this._addBotMessage(`🎬 Live visual construction mode: **${modeLabel}**.`);
      });
      this._updateHumanModeToggleBtn();
    }

    const btnCancel = this.panel.querySelector('#settings-cancel');
    btnCancel.addEventListener('click', () => this.settingsModal.classList.add('hidden'));

    const btnSave = this.panel.querySelector('#settings-save');
    btnSave.addEventListener('click', () => this._saveSettingsFromModal());

    // Modular Skill Pills toggle (Auto vs Pin up to 3 specialist skills)
    if (this.skillsBar) {
      this.skillsBar.addEventListener('click', (e) => {
        const pill = e.target.closest?.('.copilot-skill-pill');
        if (!pill) return;
        const skillId = pill.dataset.skill;
        if (skillId === 'auto') {
          this.setPinnedSkills([]);
        } else {
          const next = new Set(this.pinnedSkills);
          if (next.has(skillId)) next.delete(skillId);
          else {
            if (next.size >= 3) {
              const first = next.values().next().value;
              if (first) next.delete(first);
            }
            next.add(skillId);
          }
          this.setPinnedSkills([...next]);
        }
      });
    }
  }

  _updateVisionQaToggleBtn() {
    const btn = this.panel?.querySelector('#btn-toggle-vision-qa');
    if (!btn) return;
    const enabled = this.settings.visualCritique !== false;
    btn.textContent = enabled ? '🔍 Vision QA: ON' : '🔍 Vision QA: OFF';
    btn.classList.toggle('disabled', !enabled);
  }

  getSkills() {
    return getCopilotSkillCatalog();
  }

  setPinnedSkills(ids = []) {
    const resolved = [];
    for (const raw of Array.isArray(ids) ? ids : []) {
      const id = resolveCopilotSkillId(raw);
      if (id && !resolved.includes(id)) resolved.push(id);
      if (resolved.length >= 3) break;
    }
    this.pinnedSkills = new Set(resolved);
    this._syncSkillsBarUI();
    return [...this.pinnedSkills];
  }

  selectSkills(userPrompt = '', options = {}) {
    const selected = selectCopilotSkills(userPrompt, {
      images: options.images || [],
      liveScene: options.liveScene ?? this._describeLiveScene(),
      pinnedSkillIds: options.pinnedSkillIds ?? [...this.pinnedSkills],
      maxSkills: options.maxSkills || 3,
    });
    this.lastActiveSkills = selected;
    this._syncSkillsBarUI();
    return selected;
  }

  _syncSkillsBarUI() {
    if (!this.skillsBar) return;
    const pinned = this.pinnedSkills || new Set();
    const autoIds = new Set((this.lastActiveSkills || []).map((s) => s.id));
    this.skillsBar.querySelectorAll('.copilot-skill-pill').forEach((btn) => {
      const id = btn.dataset.skill;
      if (id === 'auto') {
        btn.classList.toggle('pinned', pinned.size === 0);
        btn.classList.remove('auto-active');
      } else {
        const isPinned = pinned.has(id);
        btn.classList.toggle('pinned', isPinned);
        btn.classList.toggle('auto-active', !isPinned && autoIds.has(id));
      }
    });
  }

  // Convenient visibility toggle aliases for studio integration
  show() { this.toggleVisibility(true); }
  hide() { this.toggleVisibility(false); }
  toggle() { this.toggleVisibility(); }

  clearSceneAndContext() {
    const studioInst = this.studio || (typeof window !== 'undefined' ? window.studio : null);
    if (studioInst && typeof studioInst.clearScene === 'function') {
      studioInst.clearScene();
    } else if (typeof window !== 'undefined' && window.sceneManager?.clearScene) {
      window.sceneManager.clearScene();
    }
    this.conversationContext.lastModelType = null;
    this.conversationContext.lastModelName = null;
    this.conversationContext.lastModelGroup = null;
    this.conversationContext.createdObjects = [];
    this.conversationContext.turns = [];
    this._updateContextBadge();
    this._addBotMessage('🧹 Đã xóa toàn bộ cảnh 3D và làm mới ngữ cảnh hội thoại.');
  }

  clearConversationOnly() {
    this.conversationContext.turns = [];
    this.attachedImages = [];
    this._renderAttachmentsTray();
    if (this.messageList) {
      this.messageList.innerHTML = '';
    }
    this._updateContextBadge();
    this._addBotMessage('🧹 Đã làm mới lịch sử trò chuyện Copilot (cảnh 3D vẫn được giữ nguyên).');
  }

  toggleVisibility(visible) {
    this.isVisible = visible !== undefined ? visible : !this.isVisible;
    this.panel.classList.toggle('hidden', !this.isVisible);
    this.fabBtn.style.display = this.isVisible ? 'none' : 'flex';
    if (this.isVisible && typeof window !== 'undefined') {
      this._getVoiceCoordinator().maybeAutoStartOnAssistantOpen?.(window);
    }
  }

  // =========================================================================
  // UNIFIED VOICE COORDINATOR & WAKE COMMANDS ("Copilot ơi...")
  // =========================================================================

  _getVoiceCoordinator() {
    if (!this.voiceCoordinator) {
      this.voiceCoordinator = getSharedVoiceCoordinator({ lang: this.settings.voiceLang || 'vi-VN' });
    }
    return this.voiceCoordinator;
  }

  _initSpeechRecognition() {
    const coord = this._getVoiceCoordinator();
    coord.setLang(this.settings.voiceLang || 'vi-VN');
    coord.setHandlers({
      onCopilotWakeOnly: () => {
        this.show();
        this._addBotMessage('👋 **Copilot đây!** Bạn muốn mình dựng mô hình gì hoặc sửa gì trong cảnh 3D?');
        const tutor = typeof window !== 'undefined' ? window.stemTutor : null;
        tutor?.speak?.('Copilot đang nghe, bạn muốn dựng mô hình gì nào?');
      },
      onCopilotQuery: async (decision) => {
        const prompt = String(decision?.query || '').trim();
        if (!prompt) return;
        this.show();
        this.isMinimized = false;
        this.panel?.classList.remove('minimized');
        this._voicePromptActive = true;
        try {
          await this.sendPrompt(prompt);
        } finally {
          this._voicePromptActive = false;
        }
      }
    });

    if (!this._unsubscribeVoice) {
      this._unsubscribeVoice = coord.subscribe((snap) => {
        if (snap.mode === 'copilot' && this.textarea && snap.lastTranscript) {
          this.textarea.value = snap.lastTranscript;
          this.textarea.style.height = 'auto';
          this.textarea.style.height = Math.min(this.textarea.scrollHeight, 100) + 'px';
        }
        this._syncVoiceUI(snap);
      });
    }
    this._syncVoiceUI(coord.getSnapshot());
    if (typeof window !== 'undefined' && coord.wakeEnabled) {
      coord.armAutoStartOnGesture(window);
    }
    return coord.session;
  }

  _syncVoiceUI(snap = this._getVoiceCoordinator().getSnapshot()) {
    const directCopilot = snap.mode === 'copilot' && snap.isActive;
    const wakeListening = snap.mode === 'wake' && snap.isActive;
    const wakeArmed = Boolean(snap.wakeEnabled && snap.autoWakePendingGesture && !snap.isActive);
    this.isListening = directCopilot;

    if (this.micBtn) {
      this.micBtn.classList.toggle('listening', directCopilot);
      this.micBtn.title = directCopilot
        ? 'Đang nghe lệnh Copilot (tự gửi sau khi ngưng nói) — Bấm để tắt'
        : 'Ra lệnh bằng giọng nói (tự gửi khi ngưng nói)';
    }
    if (this.textarea) {
      if (!this._originalPlaceholder) {
        this._originalPlaceholder = this.textarea.placeholder;
      }
      this.textarea.placeholder = directCopilot
        ? '🎙️ Đang nghe... nói yêu cầu 3D của bạn (sẽ tự gửi)!'
        : this._originalPlaceholder;
    }
    if (this.wakeBtn) {
      this.wakeBtn.style.color = wakeListening ? '#1dd1a1' : (wakeArmed ? '#54a0ff' : '');
      this.wakeBtn.title = wakeListening
        ? 'Đang chờ lệnh gọi "Copilot ơi" / "Thầy ơi" (Alt+Shift+V để tắt)'
        : (wakeArmed ? 'Sẵn sàng tự bật nghe khi bạn chạm chuột/phím' : 'Bật Lệnh gọi tự khởi động (Alt+Shift+V)');
    }
  }

  _toggleSpeechRecognition() {
    const coord = this._getVoiceCoordinator();
    coord.setLang(this.settings.voiceLang || 'vi-VN');
    const started = coord.toggleDirectMode('copilot');
    this._syncVoiceUI();
    if (!started && coord.session?.state === 'error') {
      this._addBotMessage('⚠️ Trình duyệt không hỗ trợ Web Speech API hoặc chưa cấp quyền micro. Hãy dùng Google Chrome / Microsoft Edge.');
    }
  }

  _stopSpeechRecognition() {
    const coord = this._getVoiceCoordinator();
    if (coord.mode === 'copilot') {
      coord.stopAll({ persistWakeOff: false });
    }
    this._syncVoiceUI();
  }

  // =========================================================================
  // CONTEXT BADGE & SETTINGS MODAL
  // =========================================================================

  _updateHumanModeToggleBtn() {
    const btn = this.panel ? this.panel.querySelector('#btn-toggle-human-mode') : null;
    if (!btn) return;
    if (this.settings.humanConstructionMode !== false) {
      btn.textContent = '🎬 Live Build: ON';
      btn.classList.remove('disabled');
      btn.style.background = 'rgba(0, 206, 201, 0.15)';
      btn.style.borderColor = '#00cec9';
      btn.style.color = '#00cec9';
    } else {
      btn.textContent = '⚡ Instant Build';
      btn.classList.add('disabled');
      btn.style.background = '#2a2a2a';
      btn.style.borderColor = '#555';
      btn.style.color = '#888';
    }
  }

  _updateBadge() {
    this._normalizeProviderAndModels();
    if (this.settings.provider === 'gemini') {
      const gModel = this.settings.geminiModel || 'gemini-3.5-flash-lite';
      this.badge.textContent = `✨ Gemini: ${gModel}`;
      this.badge.classList.add('cloud');
    } else {
      const model = this.settings.customModel || 'claude-sonnet-4-6';
      this.badge.textContent = `🚀 Cloud: ${model}`;
      this.badge.classList.add('cloud');
    }
  }

  _updateContextBadge() {
    if (!this.contextBadge) return;
    if (this.conversationContext.lastModelType) {
      const typeIcons = {
        house: '🏡 House',
        car: '🏎️ Car',
        castle: '🏰 Castle',
        spaceship: '🚀 Spaceship',
        pool: '🏊 Pool',
        bridge: '🌉 Suspension Bridge',
        livingroom: '🛋️ Living Room',
        portal: '🌀 Stargate',
        windmill: '🌾 Windmill',
        robot: '🤖 Robot',
        city: '🏙️ City'
      };
      const label = typeIcons[this.conversationContext.lastModelType] || this.conversationContext.lastModelType;
      this.contextBadge.textContent = `📍 ${label}`;
      this.contextBadge.style.display = 'inline-flex';
    } else {
      this.contextBadge.style.display = 'none';
    }
  }

  openSettings() {
    this.show();
    this._openSettingsModal();
  }

  _openSettingsModal() {
    this._normalizeProviderAndModels();
    this._syncServerModelsToDom();
    const selProvider = this.panel.querySelector('#settings-provider');
    const selMotapisModel = this.panel.querySelector('#settings-motapis-model');
    const selGeminiModel = this.panel.querySelector('#settings-gemini-model');
    const selVoiceLang = this.panel.querySelector('#settings-voice-lang');
    const chkAutoRun = this.panel.querySelector('#settings-autorun');
    const chkVision = this.panel.querySelector('#settings-visual-critique');
    const chkHumanMode = this.panel.querySelector('#settings-human-mode');
    const chkWakeListen = this.panel.querySelector('#settings-wake-listen');
    const selSpeed = this.panel.querySelector('#settings-construction-speed');

    if (selProvider) selProvider.value = this.settings.provider || 'motapis';
    if (selMotapisModel) selMotapisModel.value = this.settings.customModel || 'claude-sonnet-4-6';
    if (selGeminiModel) selGeminiModel.value = this.settings.geminiModel || 'gemini-3.5-flash-lite';
    if (selVoiceLang) selVoiceLang.value = this.settings.voiceLang || 'vi-VN';
    if (chkAutoRun) chkAutoRun.checked = this.settings.autoRunCode !== false;
    if (chkVision) chkVision.checked = this.settings.visualCritique !== false;
    if (chkHumanMode) chkHumanMode.checked = this.settings.humanConstructionMode !== false;
    if (chkWakeListen) chkWakeListen.checked = Boolean(this._getVoiceCoordinator().wakeEnabled);
    if (selSpeed) selSpeed.value = String(this.settings.constructionSpeed || 130);
    const inpByok = this.panel.querySelector('#settings-byok-key');
    if (inpByok) inpByok.value = this._getByokKey();

    const updateVisibility = () => {
      const p = selProvider?.value || 'motapis';
      const groupMotapis = this.panel.querySelector('#group-motapis-settings');
      const groupGeminiModel = this.panel.querySelector('#group-gemini-model');
      if (groupMotapis) groupMotapis.style.display = p === 'motapis' ? 'flex' : 'none';
      if (groupGeminiModel) groupGeminiModel.style.display = p === 'gemini' ? 'flex' : 'none';
    };

    if (selProvider) selProvider.onchange = updateVisibility;
    updateVisibility();
    this.settingsModal.classList.remove('hidden');
  }

  _saveSettingsFromModal() {
    const selProvider = this.panel.querySelector('#settings-provider');
    const selMotapisModel = this.panel.querySelector('#settings-motapis-model');
    const selGeminiModel = this.panel.querySelector('#settings-gemini-model');
    const selVoiceLang = this.panel.querySelector('#settings-voice-lang');
    const chkAutoRun = this.panel.querySelector('#settings-autorun');
    const chkVision = this.panel.querySelector('#settings-visual-critique');
    const chkHumanMode = this.panel.querySelector('#settings-human-mode');
    const chkWakeListen = this.panel.querySelector('#settings-wake-listen');
    const selSpeed = this.panel.querySelector('#settings-construction-speed');

    if (selProvider) this.settings.provider = selProvider.value || 'motapis';
    if (selMotapisModel) this.settings.customModel = selMotapisModel.value || 'claude-sonnet-4-6';
    if (selGeminiModel) this.settings.geminiModel = selGeminiModel.value || 'gemini-3.5-flash-lite';
    if (selVoiceLang) {
      this.settings.voiceLang = selVoiceLang.value || 'vi-VN';
      this._getVoiceCoordinator().setLang(this.settings.voiceLang);
    }
    if (chkAutoRun) this.settings.autoRunCode = chkAutoRun.checked;
    if (chkVision) this.settings.visualCritique = chkVision.checked;
    if (chkHumanMode) this.settings.humanConstructionMode = chkHumanMode.checked;
    if (chkWakeListen) {
      const coord = this._getVoiceCoordinator();
      if (chkWakeListen.checked && coord.mode !== 'wake') {
        coord.startWakeMode({ persist: true, silentError: false });
      } else if (!chkWakeListen.checked && coord.wakeEnabled) {
        coord.stopAll({ persistWakeOff: true });
      }
      this._syncVoiceUI();
    }
    if (selSpeed) this.settings.constructionSpeed = parseInt(selSpeed.value, 10) || 130;
    const inpByok = this.panel.querySelector('#settings-byok-key');
    if (inpByok) this._setByokKey(inpByok.value);

    this._normalizeProviderAndModels();
    this._updateVisionQaToggleBtn();
    this._updateHumanModeToggleBtn();
    this._saveSettings();
    this._updateBadge();
    this.settingsModal.classList.add('hidden');

    this._addBotMessage(`✓ Đã lưu cài đặt AI. Mô hình đang dùng: **${this.badge.textContent}**.`);
  }

  // =========================================================================
  // MESSAGE STREAM & RENDERING
  // =========================================================================

  addAttachedImage(file) {
    if (!file || !ALLOWED_COPILOT_IMAGE_TYPES.has((file.type || '').toLowerCase())) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      const dataUrl = String(e.target?.result || '');
      if (!SAFE_DATA_IMAGE_RE.test(dataUrl)) return;
      const imgObj = {
        id: 'img_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6),
        name: file.name || 'image.png',
        type: file.type || 'image/png',
        size: file.size || 0,
        dataUrl: dataUrl
      };
      this.attachedImages.push(imgObj);
      this._renderAttachmentsTray();
      if (this.textarea) this.textarea.focus();
    };
    reader.readAsDataURL(file);
  }

  _renderAttachmentsTray() {
    if (!this.attachmentsTray) return;
    if (this.attachedImages.length === 0) {
      this.attachmentsTray.style.display = 'none';
      this.attachmentsTray.innerHTML = '';
      return;
    }

    this.attachmentsTray.style.display = 'flex';
    this.attachmentsTray.innerHTML = this.attachedImages.map(img => {
      const safeName = this._escapeHTML(img.name);
      const safeSrc = SAFE_DATA_IMAGE_RE.test(String(img.dataUrl || '')) ? img.dataUrl : '';
      return `
      <div class="copilot-img-chip" data-id="${this._escapeHTML(img.id)}">
        ${safeSrc ? `<img src="${safeSrc}" class="copilot-thumb-img" alt="${safeName}" />` : ''}
        <span class="copilot-thumb-name" title="${safeName}">${safeName}</span>
        <button class="copilot-thumb-remove" data-id="${this._escapeHTML(img.id)}" title="Remove attached image">✕</button>
      </div>
    `;
    }).join('');

    this.attachmentsTray.querySelectorAll('.copilot-thumb-remove').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const id = e.currentTarget.getAttribute('data-id');
        this.attachedImages = this.attachedImages.filter(item => item.id !== id);
        this._renderAttachmentsTray();
      });
    });
  }

  async placeImageAsReferencePlane(dataUrl, width = 4) {
    if (typeof window === 'undefined') return null;
    const scene = window.scene || (window.engine ? window.engine.scene : null);
    if (!scene) return null;

    try {
      const mesh = await createImageObject({
        src: dataUrl,
        width,
        mode: 'reference',
        opacity: 0.88,
        align: 'view',
        camera: window.engine?.camera || null,
        sceneManager: window.sceneManager || null,
        scene,
      });
      this._addBotMessage(`📌 Placed image into 3D Viewport as a **Reference Image Plane** (\`${mesh.name}\`). Use Move (G), Rotate (R), Scale (S), or the Inspector Image Properties panel to adjust!`);
      return mesh;
    } catch (err) {
      this._addBotMessage(`⚠️ Could not place reference image: ${err.message}`);
      return null;
    }
  }

  _addUserMessage(text, attachedImages = []) {
    const msg = document.createElement('div');
    msg.className = 'copilot-msg user';

    let imagesHtml = '';
    if (attachedImages && attachedImages.length > 0) {
      imagesHtml = `<div class="copilot-msg-images">` + attachedImages.map(img => {
        const safeSrc = SAFE_DATA_IMAGE_RE.test(String(img.dataUrl || '')) ? img.dataUrl : '';
        return `
        <div class="copilot-msg-image-wrap">
          ${safeSrc ? `<img src="${safeSrc}" alt="${this._escapeHTML(img.name)}" class="copilot-chat-img" />` : ''}
          <button class="copilot-btn-ref-plane" data-src="${this._escapeHTML(img.id)}">📌 Place in 3D Viewport</button>
        </div>
      `;
      }).join('') + `</div>`;
    }

    msg.innerHTML = `
      <div class="copilot-msg-bubble">
        ${imagesHtml}
        ${this._escapeHTML(text)}
      </div>
    `;

    // Bind reference plane buttons in user message
    msg.querySelectorAll('.copilot-btn-ref-plane').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const id = e.currentTarget.getAttribute('data-src');
        const targetImg = attachedImages.find(i => i.id === id);
        if (targetImg) {
          this.placeImageAsReferencePlane(targetImg.dataUrl);
        }
      });
    });

    this.messageList.appendChild(msg);
    this._scrollToBottom();
  }

  _addBotMessage(text, code = null) {
    const msg = document.createElement('div');
    msg.className = 'copilot-msg bot';

    let html = `<div class="copilot-msg-bubble">${this._formatMarkdown(text)}`;

    if (code) {
      html += `
        <div class="copilot-code-block">
          <div class="copilot-code-header">
            <span>JavaScript (studio.* DSL)</span>
            <div class="copilot-code-actions">
              <button class="copilot-code-btn refine-btn" title="Chụp viewport 3D hiện tại và nhờ AI soi ảnh tự nâng cấp chi tiết (Vision Critique)">🎨 Vision Refine</button>
              <button class="copilot-code-btn copy-btn" title="Copy code">Copy</button>
              <button class="copilot-code-btn run-btn" title="Re-run code in 3D Viewport">▶ Run</button>
            </div>
          </div>
          <pre class="copilot-code-pre"><code>${this._escapeHTML(code)}</code></pre>
        </div>
      `;
    }

    html += `</div>`;
    msg.innerHTML = html;

    if (code) {
      const copyBtn = msg.querySelector('.copy-btn');
      copyBtn.addEventListener('click', () => {
        navigator.clipboard?.writeText?.(code)?.catch?.(() => {});
        copyBtn.textContent = 'Copied!';
        setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1500);
      });

      const refineBtn = msg.querySelector('.refine-btn');
      if (refineBtn) {
        refineBtn.addEventListener('click', async () => {
          if (this.isGenerating) return;
          const origPrompt = this._lastHeroPrompt || 'Nâng cấp độ chi tiết kiến trúc/hình khối, vật liệu PBR và ánh sáng của mô hình hiện tại';
          await this._runInteractiveVisionRefine(origPrompt, code);
        });
      }

      const runBtn = msg.querySelector('.run-btn');
      runBtn.addEventListener('click', async () => {
        await this.executeGeneratedCode(code);
      });
    }

    this.messageList.appendChild(msg);
    this._scrollToBottom();
  }

  _sanitizeHudHtml(raw) {
    return escapeHtml(String(raw ?? ''))
      .replace(/&lt;(\/?(?:b|strong|code|em))&gt;/gi, '<$1>')
      .replace(/&lt;br\s*\/?&gt;/gi, '<br>');
  }

  _showThinking(initialText = 'Connecting to AI...') {
    this._hideThinking();
    this.thinkingEl = document.createElement('div');
    this.thinkingEl.className = 'copilot-thinking-box';
    this.thinkingEl.innerHTML = `
      <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px;">
        <div style="display: flex; align-items: center; gap: 8px;">
          <div class="thinking-spinner" style="width: 14px; height: 14px; border: 2px solid #00cec9; border-top-color: transparent; border-radius: 50%; animation: spin 0.8s linear infinite;"></div>
          <span style="font-size: 12px; font-weight: 600; color: #00cec9;">AI Copilot Processing Live</span>
        </div>
        <span class="thinking-timer" style="font-size: 11px; color: #888; font-family: monospace;">0.0s</span>
      </div>
      <div class="thinking-status-text" style="font-size: 12px; color: #f1f2f6; line-height: 1.45; font-weight: 500;">
        ${this._sanitizeHudHtml(initialText)}
      </div>
      <div style="width: 100%; height: 4px; background: #14171c; border-radius: 2px; margin-top: 10px; overflow: hidden;">
        <div class="thinking-progress-bar" style="width: 25%; height: 100%; background: linear-gradient(90deg, #0984e3, #00cec9, #2ecc71); transition: width 0.3s ease;"></div>
      </div>
    `;
    this.messageList.appendChild(this.thinkingEl);
    this._scrollToBottom();

    this._thinkingStartTime = performance.now();
    if (this._thinkingTimerInterval) clearInterval(this._thinkingTimerInterval);
    this._thinkingTimerInterval = setInterval(() => {
      if (!this.thinkingEl) {
        clearInterval(this._thinkingTimerInterval);
        return;
      }
      const elapsed = ((performance.now() - this._thinkingStartTime) / 1000).toFixed(1);
      const timerEl = this.thinkingEl.querySelector('.thinking-timer');
      if (timerEl) timerEl.textContent = `${elapsed}s`;
    }, 100);
  }

  _updateThinkingStep(stepHtml, percent = null) {
    if (!this.thinkingEl) {
      this._showThinking(stepHtml);
      return;
    }
    const textEl = this.thinkingEl.querySelector('.thinking-status-text');
    if (textEl) {
      textEl.innerHTML = this._sanitizeHudHtml(stepHtml);
    }
    if (percent !== null) {
      const barEl = this.thinkingEl.querySelector('.thinking-progress-bar');
      if (barEl) barEl.style.width = `${Math.min(100, Math.max(5, percent))}%`;
    }
    this._scrollToBottom();
  }

  _hideThinking() {
    if (this._thinkingTimerInterval) {
      clearInterval(this._thinkingTimerInterval);
      this._thinkingTimerInterval = null;
    }
    if (this.thinkingEl && this.thinkingEl.parentNode) {
      this.thinkingEl.parentNode.removeChild(this.thinkingEl);
      this.thinkingEl = null;
    }
  }

  _scrollToBottom() {
    this.messageList.scrollTop = this.messageList.scrollHeight;
  }

  _escapeHTML(str) {
    return str.replace(/[&<>'"]/g, 
      tag => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[tag] || tag)
    );
  }

  _formatMarkdown(text) {
    let out = this._escapeHTML(String(text || ''));
    // Blockquotes (escaped `&gt;` at start of line)
    out = out.replace(/^&gt;\s?(.*)$/gm, '<blockquote>$1</blockquote>');
    // Headings
    out = out.replace(/^###\s+(.*)$/gm, '<strong style="color:#feca57;">$1</strong>');
    // Bold
    out = out.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
    // Italic
    out = out.replace(/\*(.*?)\*/g, '<em>$1</em>');
    // Inline code
    out = out.replace(/`([^`]+)`/g, '<code style="background:#16191d;padding:2px 5px;border-radius:3px;color:#74b9ff;border:1px solid rgba(255,255,255,0.08);">$1</code>');
    // Clean blockquote line joins & remaining newlines
    out = out.replace(/<\/blockquote>\n+/g, '</blockquote>');
    out = out.replace(/\n/g, '<br/>');
    return out;
  }

  // =========================================================================
  // SUBMISSION & CODE GENERATION
  // =========================================================================

  async sendPrompt(text) {
    if (this.textarea) {
      this.textarea.value = text;
      return await this.handleUserSubmit();
    }
    return { ok: false, error: 'AI Copilot input unavailable', explanation: null, code: null };
  }

  async handleUserSubmit() {
    const rawPrompt = this.textarea.value.trim();
    const currentImages = [...this.attachedImages];
    if ((!rawPrompt && currentImages.length === 0) || this.isGenerating) {
      return { ok: false, error: 'Empty prompt or generation already in progress', explanation: null, code: null };
    }

    const promptText = rawPrompt || (currentImages.length > 0 ? "Build a 3D model matching this attached reference image." : "");

    this.textarea.value = '';
    this.textarea.style.height = 'auto';
    this.attachedImages = [];
    this._renderAttachmentsTray();

    this._addUserMessage(promptText, currentImages);

    // 0. Lệnh nội bộ `/skill [list|auto|<id>]` để xem/ghim nhanh kỹ năng Copilot (0 tốn token)
    if (currentImages.length === 0 && /^\/skills?(?:\s|$)/i.test(promptText)) {
      const arg = promptText.replace(/^\/skills?\s*/i, '').trim();
      if (!arg || /^list$/i.test(arg)) {
        const pinnedList = [...this.pinnedSkills];
        const lines = this.getSkills().map((s) => {
          const mark = pinnedList.includes(s.id) ? ' **(pinned)**' : '';
          return `- ${s.icon} \`${s.id}\`${mark} — ${s.summary}`;
        });
        this._addBotMessage(
          `🧩 **Hunger Copilot Skills** (Chế độ: **${pinnedList.length ? `Ghim ${pinnedList.join(', ')}` : 'Auto'}**):\n${lines.join('\n')}\n\nGõ \`/skill cad-modeling\` để ghim hoặc \`/skill auto\` để về tự động.`
        );
        return { ok: true, explanation: 'Listed Copilot skills', code: null };
      }
      if (/^(auto|reset|clear)$/i.test(arg)) {
        this.setPinnedSkills([]);
        this._addBotMessage('✨ Đã chuyển kỹ năng Copilot về chế độ **Auto** (tự chọn theo yêu cầu & ảnh tham chiếu).');
        return { ok: true, explanation: 'Copilot skills set to Auto', code: null };
      }
      const tokens = arg.split(/[\s,]+/).filter(Boolean);
      const validIds = tokens.map((t) => resolveCopilotSkillId(t)).filter(Boolean);
      if (validIds.length === 0) {
        this._addBotMessage(`⚠️ Không tìm thấy kỹ năng \`${arg}\`. Gõ \`/skill list\` để xem danh sách.`);
        return { ok: false, error: 'Unknown skill', explanation: null, code: null };
      }
      const active = this.setPinnedSkills(validIds);
      this._addBotMessage(`📌 Đã ghim kỹ năng Copilot: **${active.join(', ')}** (gõ \`/skill auto\` để bỏ ghim).`);
      return { ok: true, explanation: `Pinned skills: ${active.join(', ')}`, code: null };
    }

    // 1. Kiểm tra lệnh gọi tự khởi động / điều hướng trợ lý qua chữ gõ ("Thầy ơi...", "Copilot ơi...", "tự chạy"...)
    if (currentImages.length === 0) {
      const wakeDecision = routeVoiceUtterance(promptText, { requireWakeWord: true });
      const tutorInst = typeof window !== 'undefined' ? window.stemTutor : null;
      if (wakeDecision.target === 'command' && tutorInst?._handleVoiceCommand) {
        await tutorInst._handleVoiceCommand(wakeDecision);
        this._addBotMessage(`⚡ Đã thực thi lệnh điều khiển: **${wakeDecision.query || wakeDecision.command}**.`);
        return { ok: true, explanation: wakeDecision.command, code: null };
      }
      if (wakeDecision.target === 'stem') {
        if (wakeDecision.wakeOnly && tutorInst?._onStemWakeOnly) {
          tutorInst._onStemWakeOnly();
          this._addBotMessage('🎓 Đã triệu hồi **Giáo viên AI 1-1**!');
          return { ok: true, explanation: 'Đã mở Giáo viên AI 1-1', code: null };
        }
        if (tutorInst?.askAICoach && wakeDecision.query) {
          const coachRes = await tutorInst.askAICoach(wakeDecision.query, { speak: true });
          this._addBotMessage(`🎓 Đã chuyển câu hỏi sang **Giáo viên AI 1-1** (${coachRes?.stepsCount || 1} bước tương tác).`);
          return { ok: true, explanation: 'Đã mở hướng dẫn STEM 1-1', code: null, routedTo: 'stem' };
        }
      }
      if (wakeDecision.target === 'copilot' && wakeDecision.wakeOnly) {
        this._addBotMessage('👋 **Copilot đây!** Hãy gõ hoặc nói yêu cầu dựng hình 3D của bạn.');
        return { ok: true, explanation: 'Copilot ready', code: null };
      }
    }

    const effectivePrompt = (() => {
      if (currentImages.length > 0) return promptText;
      const d = routeVoiceUtterance(promptText, { requireWakeWord: true });
      return (d.target === 'copilot' && d.query) ? d.query : promptText;
    })();

    // Record user turn in context history
    this.conversationContext.turns.push({
      role: 'user',
      text: rawPrompt,
      timestamp: Date.now()
    });

    this.isGenerating = true;
    this._userAborted = false;
    this._activeAbortController = typeof AbortController !== 'undefined' ? new AbortController() : null;
    this.sendBtn.disabled = true;
    if (this.stopBtn) this.stopBtn.hidden = false;

    this._normalizeProviderAndModels();
    const provName = this.settings.provider === 'gemini' ? 'Google Gemini' : 'Cloud AI';
    const modelTag = this._modelForProvider(this.settings.provider);
    const activeSkills = this.selectSkills(effectivePrompt, { images: currentImages });
    const skillTag = activeSkills.length
      ? ` · 🧩 ${activeSkills.map((s) => `${s.icon} ${s.label}`).join(', ')}`
      : '';
    this._showThinking(`📡 <b>Step 1/4</b>: Đang gửi yêu cầu tới ${this._escapeHTML(provName)} (<code>${this._escapeHTML(modelTag)}</code>${this._escapeHTML(skillTag)})...`);

    try {
      let result = await this._callWithFailover(this.settings.provider, effectivePrompt, currentImages);
      if (this._userAborted || this._activeAbortController?.signal?.aborted) {
        this._hideThinking();
        return { ok: false, aborted: true, explanation: null, code: null };
      }

      // If user explicitly asked to build/modify/clear 3D objects and LLM answered only prose with 0 code & 0 tool calls, ask once for executable code.
      const asksSceneMutation = /(tạo|thêm|dựng|vẽ|xây|xóa|xoá|dọn|clear|đổi\s*màu|di\s*chuyển|xoay|scale|create|build|add|delete|remove|clear)/i.test(effectivePrompt)
        && !/^(?:trong\s+scene|có\s+những|liệt\s+kê|đọc\s+scene|kiểm\s+tra|what|list|hướng\s+dẫn|tại\s+sao|là\s+gì)/i.test(effectivePrompt.trim());
      if (result && !result.code && !(result._toolCallsCount > 0) && asksSceneMutation && currentImages.length === 0) {
        this._updateThinkingStep(`🔁 Yêu cầu dựng/sửa 3D chưa có khối mã thực thi — đang yêu cầu AI trả về code chuẩn \`studio\`...`, 48);
        const fixPrompt =
          `Yêu cầu người dùng: "${effectivePrompt}"\n` +
          `Bạn vừa trả lời bằng chữ nhưng CHƯA có mã JavaScript hoặc JSON tool call nên màn hình chưa thay đổi.\n` +
          `Hãy trả về DUY NHẤT 1 khối \`\`\`javascript ... \`\`\` dùng API \`studio\` (ví dụ \`studio.addCube(...)\`, \`studio.clearScene()\`, \`window.scene.getObjectByName(...)\`). KHÔNG giải thích suông.`;
        const retryRes = await this._callWithFailover(this.settings.provider, fixPrompt, []);
        if (this._userAborted || this._activeAbortController?.signal?.aborted) {
          this._hideThinking();
          return { ok: false, aborted: true, explanation: null, code: null };
        }
        if (retryRes && (retryRes.code || retryRes._toolCallsCount > 0)) {
          result = retryRes;
        }
      }

      this._updateThinkingStep(`🧠 <b>Step 2/4</b>: Đã nhận phản hồi! Đang trích xuất mã Three.js DSL...`, 65);

      if (result && result.code) {
        this._updateThinkingStep(`⚡ <b>Step 3/4</b>: Đang biên dịch & dựng hình 3D trong Viewport...`, 85);

        let finalCode = result.code;
        let finalExplanation = result.explanation || 'Đã tạo kịch bản dựng hình 3D:';

        if (this.settings.autoRunCode) {
          let ran = await this.executeGeneratedCode(finalCode);
          if (this._userAborted || this._activeAbortController?.signal?.aborted) {
            this._hideThinking();
            return { ok: false, aborted: true, explanation: null, code: null };
          }
          // Tự sửa lỗi runtime 1 lượt nếu code không vi phạm bảo mật nhưng gặp lỗi JS/API
          if (!ran && this._lastExecutionError && !this._lastExecutionError.blocked) {
            this._updateThinkingStep(`🔧 <b>Auto-Repair</b>: Phát hiện lỗi (${this._escapeHTML(this._lastExecutionError.message)}). Đang nhờ AI tự sửa...`, 78);
            try {
              const errDetail = this._lastExecutionError.stack || this._lastExecutionError.message || 'Unknown error';
              const repairPrompt =
                `Đoạn mã JavaScript trước đó bị lỗi runtime.\n` +
                `Lỗi: "${errDetail}"\n` +
                `Đoạn mã gây lỗi:\n\`\`\`javascript\n${String(finalCode || '').slice(0, 6000)}\n\`\`\`\n` +
                `Yêu cầu gốc: "${effectivePrompt}"\nHãy sửa lỗi cụ thể dựa trên lỗi/code trên và trả về DUY NHẤT 1 khối \`\`\`javascript ... \`\`\` chạy hoàn chỉnh.`;
              const repaired = await this._callWithFailover(this.settings.provider, repairPrompt, []);
              if (this._userAborted || this._activeAbortController?.signal?.aborted) {
                this._hideThinking();
                return { ok: false, aborted: true, explanation: null, code: null };
              }
              if (repaired && repaired.code) {
                const retryOk = await this.executeGeneratedCode(repaired.code);
                if (retryOk) {
                  ran = true;
                  finalCode = repaired.code;
                  finalExplanation = (repaired.explanation || finalExplanation) + '\n\n*(✓ Đã tự động phát hiện và sửa lỗi thực thi cho bạn.)*';
                }
              }
            } catch (_) {}
          }

          // Auto-fit 4K shadow frustum for hero builds so architectural/medium scenes never suffer clipped shadows
          if (ran && typeof window !== 'undefined') {
            this._lastHeroPrompt = effectivePrompt;
            this._lastHeroImages = currentImages;
            try {
              const diagSnap = this._computeSceneDiagnostics();
              if (diagSnap && diagSnap.diag > 6 && typeof window.engine?.fitShadowFrustumToScene === 'function') {
                window.engine.fitShadowFrustumToScene();
              }
            } catch (_) {}

            // 2-Pass Vision Self-Critique: AI captures its own rendered 3D viewport, diagnoses flaws, and upgrades craftsmanship
            if (this._shouldRunAutoVisualCritique(effectivePrompt, finalCode, currentImages)) {
              this._updateThinkingStep(`🔍 <b>Vision QA (Pass 2/2)</b>: Đang chụp ảnh 3D vừa dựng để AI tự soi tỷ lệ, lỗi khối & nâng cấp chi tiết...`, 88);
              try {
                const refined = await this.refineCurrentSceneWithVision({
                  originalPrompt: effectivePrompt,
                  referenceImages: currentImages,
                  previousCode: finalCode,
                });
                if (this._userAborted || this._activeAbortController?.signal?.aborted) {
                  this._hideThinking();
                  return { ok: false, aborted: true, explanation: null, code: null };
                }
                if (refined?.ok && refined.code) {
                  finalCode = refined.code;
                  const metaLine = refined.metrics
                    ? ` *(🔍 Vision QA Pass 2: ${refined.metrics.width}×${refined.metrics.height}×${refined.metrics.depth}m · ${refined.metrics.renderedTris.toLocaleString()} tris · ${refined.metrics.drawCalls} draw calls)*`
                    : ' *(🔍 Đã tự soi ảnh 3D & nâng cấp chi tiết ở Pass 2)*';
                  finalExplanation = (refined.explanation || finalExplanation) + `\n\n${metaLine}`;
                }
              } catch (visErr) {
                console.warn('[AICopilot Vision QA] Pass 2 skipped cleanly; keeping Pass 1 result:', visErr?.message || visErr);
              }
            }
          }
        }

        if (result._usedModel && result._usedModel !== modelTag) {
          finalExplanation += `\n\n*(⚡ Lưu ý: model \`${modelTag}\` tạm bận nên hệ thống đã tự chuyển dự phòng sang \`${result._usedModel}\`.)*`;
        }

        if (this._userAborted || this._activeAbortController?.signal?.aborted) {
          this._hideThinking();
          return { ok: false, aborted: true, explanation: null, code: null };
        }

        // Bảo đảm nếu người dùng hỏi "hướng dẫn / từng bước" mà AI trả code dựng khối mà quên gọi studio.tutor.guideSteps -> tự chạy walkthrough
        const tutorInst = typeof window !== 'undefined' ? window.stemTutor : null;
        let launchedTutorWalkthrough = /studio\.tutor\.(?:guideSteps|command)/i.test(finalCode);
        if (
          tutorInst &&
          !launchedTutorWalkthrough &&
          /(hướng\s+dẫn|chỉ\s+(?:tôi|mình)|dạy\s+(?:tôi|mình)|từng\s+bước)/i.test(effectivePrompt)
        ) {
          const parsedFromExp = finalExplanation ? tutorInst._parseAICoachResponse?.(finalExplanation) : null;
          if (parsedFromExp && Array.isArray(parsedFromExp.steps) && parsedFromExp.steps.length > 1) {
            tutorInst.executeAICommand(parsedFromExp, { speak: true, autoAdvance: true, sourceBadge: 'Copilot 1:1' });
            launchedTutorWalkthrough = true;
          } else if (typeof tutorInst.askAICoach === 'function') {
            tutorInst.askAICoach(effectivePrompt, { speak: true, autoAdvance: true });
            launchedTutorWalkthrough = true;
          }
        }

        this._updateThinkingStep(`🎨 <b>Step 4/4</b>: Hoàn tất lưới, vật liệu PBR & đồng bộ Outliner!`, 100);
        await new Promise(r => setTimeout(r, 350));
        this._hideThinking();

        if (this._userAborted || this._activeAbortController?.signal?.aborted) {
          return { ok: false, aborted: true, explanation: null, code: null };
        }

        this._addBotMessage(finalExplanation, finalCode);

        // Nếu lệnh đến từ giọng nói và không có tutor walkthrough đang nói -> đọc tóm tắt ngắn
        if (
          this._voicePromptActive &&
          !launchedTutorWalkthrough &&
          tutorInst &&
          !tutorInst.isAutoWalking &&
          !tutorInst.guidedSequence?.length
        ) {
          const shortVoice = finalExplanation.replace(/```[\s\S]*?```/g, '').trim().slice(0, 160);
          if (shortVoice) tutorInst.speak(shortVoice);
        }

        // Record assistant turn in context history
        this.conversationContext.turns.push({
          role: 'assistant',
          text: finalExplanation || '',
          code: finalCode,
          timestamp: Date.now()
        });
        this._updateContextBadge();
        return { ok: true, explanation: finalExplanation, code: finalCode };
      }

      if (result && result.explanation) {
        this._hideThinking();
        const tutorInst = typeof window !== 'undefined' ? window.stemTutor : null;
        if (tutorInst && /(hướng\s+dẫn|chỉ\s+(?:tôi|mình)|dạy\s+(?:tôi|mình)|từng\s+bước)/i.test(effectivePrompt)) {
          const parsedPlan = tutorInst._parseAICoachResponse?.(result.explanation);
          if (parsedPlan) {
            tutorInst.executeAICommand(parsedPlan, { speak: true, autoAdvance: true, sourceBadge: 'Copilot 1:1' });
          }
        }
        this._addBotMessage(result.explanation);
        this.conversationContext.turns.push({
          role: 'assistant',
          text: result.explanation,
          code: null,
          timestamp: Date.now()
        });
        this._updateContextBadge();
        return { ok: true, explanation: result.explanation, code: null };
      }

      this._hideThinking();
      const emptyMsg = 'AI chưa tạo được mã cho yêu cầu này. Hãy thử mô tả chi tiết hơn.';
      this._addBotMessage(emptyMsg);
      this._updateContextBadge();
      return { ok: false, error: emptyMsg, explanation: emptyMsg, code: null };
    } catch (err) {
      if (this._userAborted || this._activeAbortController?.signal?.aborted) {
        this._hideThinking();
        this._addBotMessage('⏹ Đã dừng tạo phản hồi AI theo yêu cầu của bạn.');
        return { ok: false, aborted: true, error: 'Aborted by user', explanation: null, code: null };
      }
      // Fallback 1: Nếu là câu hỏi hướng dẫn -> tự động kích hoạt Giáo viên AI Nội bộ đa bước (không bao giờ chết ở 502)
      const tutorInst = typeof window !== 'undefined' ? window.stemTutor : null;
      if (tutorInst && /(hướng\s+dẫn|chỉ\s+(?:tôi|mình)|dạy\s+(?:tôi|mình)|từng\s+bước|cách\s+làm)/i.test(effectivePrompt)) {
        try {
          const localCoach = tutorInst._buildSmartLocalModelingCoachPlan?.(effectivePrompt, { meshCount: 0, totalVertices: 0, activeMode: 'object' });
          if (localCoach) {
            await tutorInst.executeAICommand(localCoach, { speak: true, autoAdvance: true, sourceBadge: 'AI Coach Dự phòng' });
            this._hideThinking();
            this._addBotMessage(
              `⚡ Cloud AI tạm bận (${err.message || 'timeout'}), mình đã tự kích hoạt **Giáo viên AI 1-1 Nội bộ** để hướng dẫn đầy đủ ${localCoach.steps?.length || 1} bước ngay trên màn hình!`
            );
            return { ok: true, fallback: 'stem-local', explanation: localCoach.title, code: null };
          }
        } catch (_) {}
      }

      // Fallback 2: Nếu là yêu cầu dựng hình 3D -> chạy bộ dựng hình Procedural nội bộ thay vì màn hình lỗi cụt
      const localPlan = this._buildLocalProceduralFallback(effectivePrompt);
      if (localPlan && localPlan.code) {
        const ranLocal = this.settings.autoRunCode ? await this.executeGeneratedCode(localPlan.code) : true;
        this._hideThinking();
        if (ranLocal) {
          this._addBotMessage(
            `⚡ Cloud AI tạm gián đoạn (${err.message || 'máy chủ bận'}), Copilot đã dùng **bộ dựng 3D nội bộ** cho bạn:\n\n${localPlan.explanation}`,
            localPlan.code
          );
          this._updateContextBadge();
          return { ok: true, fallback: 'local-3d', explanation: localPlan.explanation, code: localPlan.code };
        }
      }

      this._hideThinking();
      console.error('[AICopilot Error]', err);
      this._addBotMessage(
        `❌ **Không thể tạo phản hồi AI**:\n\n> \`${err.message || 'Lỗi kết nối máy chủ AI'}\`\n\n` +
        `💡 Hãy thử lại sau vài giây hoặc mở **⚙️ Cài đặt** để chuyển sang model nhanh/ổn định như **gemini-3.5-flash-lite** hoặc **claude-sonnet-4-6**.`
      );
      return { ok: false, error: err.message || 'AI request failed', explanation: null, code: null };
    } finally {
      this._activeAbortController = null;
      this.isGenerating = false;
      this.sendBtn.disabled = false;
      if (this.stopBtn) this.stopBtn.hidden = true;
      this.textarea.focus();
    }
  }

  _shouldRunAutoVisualCritique(promptText = '', code = '', images = []) {
    if (this.settings.visualCritique === false) return false;
    if (typeof window === 'undefined' || !window.engine?.renderer?.domElement) return false;
    if (!code || /studio\.tutor\.(?:guideSteps|command)/i.test(code)) return false;
    const stripped = String(code).replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '').trim();
    if (/^studio\.clearScene\s*\(\s*\)\s*;?$/i.test(stripped)) return false;
    if (Array.isArray(images) && images.length > 0) return true;
    const norm = String(promptText || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/đ/gi, 'd')
      .toLowerCase();
    // Skip minor incremental edits (recolor/move/rotate/scale/delete/clear/single primitive)
    if (/\b(clear|xoa|don|xoay|rotate|di chuyen|move|doi mau|recolor|scale|phong to|thu nho|add a cube|add cube|them khoi lap phuong|them hinh cau)\b/.test(norm) && !/\b(build|create|design|dung|xay|thiet ke)\b/.test(norm)) {
      return false;
    }
    return /\b(house|villa|castle|church|cathedral|temple|pagoda|palace|tower|bridge|building|skyscraper|city|village|monument|stadium|museum|interior|living\s*room|bedroom|kitchen|car|supercar|truck|train|plane|aircraft|ship|spaceship|starship|boat|yacht|robot|mech|gundam|drone|windmill|portal|pool|furniture|sofa|chair|table|lamp|valve|engine|machine|sword|weapon|shield|character|creature|dragon|nha|biet thu|lau dai|nha tho|den tho|chua|cung dien|thap|cau|toa nha|thanh pho|noi that|phong khach|sieu xe|o to|xe hoi|tau|phi thuyen|may bay|ro bot|coi xay gio|ho boi|ban ghe|co khi|kiem|vu khi)\b/.test(norm);
  }

  _computeSceneDiagnostics() {
    if (typeof window === 'undefined') return null;
    const THREE = window.THREE || this.studio?.THREE;
    const sm = window.sceneManager;
    const root = sm?.rootContainer || window.engine?.scene;
    if (!THREE || !root) return null;
    const box = new THREE.Box3();
    let meshCount = 0;
    root.updateMatrixWorld(true);
    root.traverse((obj) => {
      if (!obj.visible || obj.userData?.isSystemObject || obj.userData?.isHelper || obj.userData?.isGizmo) return;
      if (obj.isMesh || obj.isInstancedMesh) {
        // Ignore oversized flat ground/horizon planes when computing hero bounds
        const b = new THREE.Box3().setFromObject(obj);
        if (!b.isEmpty()) {
          const sz = b.getSize(new THREE.Vector3());
          if (!(sz.y < 0.25 && Math.max(sz.x, sz.z) > 80)) {
            box.union(b);
          }
          meshCount++;
        }
      }
    });
    if (box.isEmpty()) return null;
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const diag = Math.max(0.5, size.length());
    const budget = typeof this.studio?.inspectSceneBudget === 'function'
      ? this.studio.inspectSceneBudget(root, { tier: diag > 12 ? 'architecture' : 'product' })
      : null;
    return {
      meshCount,
      width: Number(size.x.toFixed(2)),
      height: Number(size.y.toFixed(2)),
      depth: Number(size.z.toFixed(2)),
      minY: Number(box.min.y.toFixed(3)),
      maxY: Number(box.max.y.toFixed(3)),
      center: [center.x, center.y, center.z],
      diag: Number(diag.toFixed(2)),
      renderedTris: budget?.renderedTris || 0,
      drawCalls: budget?.drawCalls || meshCount,
      uniqueMaterials: budget?.uniqueMaterials || 0,
      uniqueImages: budget?.uniqueImages || 0,
    };
  }

  /**
   * Captures a temporary 3/4 diagnostic JPEG of the hero bounding box and immediately
   * restores the user's exact camera & OrbitControls target (zero camera hijacking).
   */
  _captureDiagnosticSnapshot() {
    if (typeof window === 'undefined' || !window.engine?.renderer?.domElement || !window.engine?.camera) {
      return null;
    }
    const eng = window.engine;
    const metrics = this._computeSceneDiagnostics();
    if (!metrics) return null;

    const cam = eng.camera;
    const controls = eng.controls;
    const savedPos = cam.position.clone();
    const savedQuat = cam.quaternion.clone();
    const savedTarget = controls?.target ? controls.target.clone() : null;
    let dataUrl = null;
    try {
      const [cx, cy, cz] = metrics.center;
      const dist = Math.max(2.4, metrics.diag * 1.18);
      cam.position.set(cx + dist * 0.62, cy + dist * 0.36, cz + dist * 0.82);
      cam.lookAt(cx, cy, cz);
      if (controls?.target) {
        controls.target.set(cx, cy, cz);
        controls.update();
      }
      eng.renderer.render(eng.scene, cam);
      const glCanvas = eng.renderer.domElement;
      const maxDim = 896;
      const scale = Math.min(1, maxDim / Math.max(glCanvas.width || 1, glCanvas.height || 1));
      const outW = Math.max(64, Math.round((glCanvas.width || 640) * scale));
      const outH = Math.max(64, Math.round((glCanvas.height || 480) * scale));
      if (typeof document !== 'undefined') {
        const tmp = document.createElement('canvas');
        tmp.width = outW;
        tmp.height = outH;
        const ctx2d = tmp.getContext('2d');
        if (ctx2d) {
          ctx2d.drawImage(glCanvas, 0, 0, outW, outH);
          dataUrl = tmp.toDataURL('image/jpeg', 0.84);
        }
      }
      if (!dataUrl && typeof glCanvas.toDataURL === 'function') {
        dataUrl = glCanvas.toDataURL('image/jpeg', 0.84);
      }
    } catch (_) {
      dataUrl = null;
    } finally {
      cam.position.copy(savedPos);
      cam.quaternion.copy(savedQuat);
      if (controls?.target && savedTarget) {
        controls.target.copy(savedTarget);
        controls.update();
      }
      try { eng.renderer.render(eng.scene, cam); } catch (_) {}
    }
    return dataUrl ? { dataUrl, metrics } : null;
  }

  async refineCurrentSceneWithVision({ originalPrompt = '', referenceImages = [], previousCode = '' } = {}) {
    const snap = this._captureDiagnosticSnapshot();
    if (!snap?.dataUrl) return { ok: false, reason: 'Viewport snapshot unavailable' };
    const m = snap.metrics;
    const warnings = [];
    if (Math.abs(m.minY) > 0.08) warnings.push(`Grounding flaw: minY=${m.minY}m (base should rest cleanly on y=0.0).`);
    if (m.uniqueImages === 0) warnings.push('Zero procedural PBR textures applied — surfaces look like flat untextured clay; apply `await studio.applyProceduralPBR(...)` to primary architectural/hero materials.');
    if (m.renderedTris < 1800) warnings.push(`Low geometric richness (${m.renderedTris} tris) — add real architectural/mechanical sub-assemblies (recessed openings, cornices/sweeps, moldings, bevels, instanced micro-details).`);

    const visionImages = [
      ...(Array.isArray(referenceImages) ? referenceImages.slice(0, 2) : []),
      { id: 'viewport_qa', name: 'current_3d_viewport.jpg', type: 'image/jpeg', dataUrl: snap.dataUrl },
    ];
    const hasRef = Array.isArray(referenceImages) && referenceImages.length > 0;
    const critiquePrompt =
      `[VISION SELF-CRITIQUE PASS — ACT AS A SENIOR 3D ART DIRECTOR]\n` +
      `Original user request: "${originalPrompt}"\n` +
      `${hasRef ? 'First image(s) = target reference photo; LAST image = your actual current 3D render in Hunger Studio.' : 'Attached image = your actual current 3D render in Hunger Studio.'}\n` +
      `Measured 3D Scene Telemetry: bbox=${m.width}m(W) × ${m.height}m(H) × ${m.depth}m(D), minY=${m.minY}m, meshes=${m.meshCount}, tris=${m.renderedTris}, drawCalls=${m.drawCalls}, materials=${m.uniqueMaterials}, textures=${m.uniqueImages}.\n` +
      `${warnings.length ? 'Automated Diagnostics:\n- ' + warnings.join('\n- ') + '\n' : ''}` +
      `Current code snippet (Pass 1):\n\`\`\`javascript\n${String(previousCode || '').slice(0, 5000)}\n\`\`\`\n` +
      `Critique what looks blocky, misaligned, floating, untextured, or under-detailed in the attached 3D viewport render, then output ONE complete upgraded \`\`\`javascript ... \`\`\` script starting with \`studio.clearScene();\` that significantly elevates silhouette accuracy, CAD curvature/recesses (\`addExtrude\` with \`holes\`, \`addSweep\`, \`addLoft\`, \`addLathe\`, \`addInstancedMesh\`), procedural PBR (\`await studio.applyProceduralPBR(...)\`), grounding at \`y=0\`, and 4K lighting (\`studio.setupSunLight\`).`;

    const upgraded = await this._callWithFailover(this.settings.provider, critiquePrompt, visionImages);
    if (!upgraded?.code) return { ok: false, reason: 'No upgraded code returned' };
    const prevHuman = this.settings.humanConstructionMode;
    this.settings.humanConstructionMode = false; // Pass 2 applies instantaneously without replaying bounce animation
    let ok = false;
    try {
      ok = await this.executeGeneratedCode(upgraded.code);
    } finally {
      this.settings.humanConstructionMode = prevHuman;
    }
    if (!ok) return { ok: false, reason: this._lastExecutionError?.message || 'Pass 2 execution error' };
    try { window.engine?.fitShadowFrustumToScene?.(); } catch (_) {}
    const afterMetrics = this._computeSceneDiagnostics() || m;
    return {
      ok: true,
      code: upgraded.code,
      explanation: upgraded.explanation,
      metrics: afterMetrics,
      _usedModel: upgraded._usedModel,
    };
  }

  async _runInteractiveVisionRefine(originalPrompt, previousCode) {
    if (this.isGenerating) return;
    this.isGenerating = true;
    this._userAborted = false;
    this._activeAbortController = typeof AbortController !== 'undefined' ? new AbortController() : null;
    if (this.sendBtn) this.sendBtn.disabled = true;
    if (this.stopBtn) this.stopBtn.hidden = false;
    this._showThinking('🔍 <b>Vision Refine</b>: Đang chụp ảnh 3D hiện tại & gửi cho AI thẩm định nâng cấp chi tiết...');
    try {
      const res = await this.refineCurrentSceneWithVision({
        originalPrompt,
        referenceImages: this._lastHeroImages || [],
        previousCode,
      });
      this._hideThinking();
      if (res?.ok && res.code) {
        const m = res.metrics;
        const badge = m ? `\n\n*(🔍 Vision Refine: ${m.width}×${m.height}×${m.depth}m · ${m.renderedTris.toLocaleString()} tris · ${m.drawCalls} draw calls · ${m.uniqueImages} texture maps)*` : '';
        this._addBotMessage((res.explanation || '🎨 Đã nâng cấp chi tiết mô hình sau khi soi ảnh viewport 3D:') + badge, res.code);
      } else {
        this._addBotMessage(`⚠️ Chưa thể nâng cấp Vision Refine: ${res?.reason || 'Không nhận được mã nâng cấp'}. Mô hình cũ vẫn được giữ nguyên.`);
      }
    } catch (err) {
      this._hideThinking();
      this._addBotMessage(`⚠️ Vision Refine gặp lỗi: ${err?.message || err}`);
    } finally {
      this._activeAbortController = null;
      this.isGenerating = false;
      if (this.sendBtn) this.sendBtn.disabled = false;
      if (this.stopBtn) this.stopBtn.hidden = true;
    }
  }

  stopGeneration() {
    this._userAborted = true;
    this._buildAnimToken = (this._buildAnimToken || 0) + 1;
    try { this._activeAbortController?.abort(); } catch (_) {}
    this._hideThinking();
  }

  async _callWithFailover(primaryProvider, userPrompt, images = []) {
    const primary = primaryProvider === 'gemini' ? 'gemini' : 'motapis';
    try {
      return await this._callProxyAPI(primary, userPrompt, images);
    } catch (primaryErr) {
      const caps = this.serverCapabilities || {};
      const alt = primary === 'gemini'
        ? (caps.custom ? 'motapis' : null)
        : (caps.gemini ? 'gemini' : null);
      if (!alt) throw primaryErr;

      const altName = alt === 'gemini' ? 'Google Gemini dự phòng' : 'Cloud Multi-Model dự phòng';
      this._updateThinkingStep(`🔄 Nguồn chính tạm bận (${this._escapeHTML(primaryErr.message || '')}). Đang chuyển sang **${this._escapeHTML(altName)}**...`, 45);
      return await this._callProxyAPI(alt, userPrompt, images);
    }
  }

  _buildLocalProceduralFallback(promptText) {
    const q = String(promptText || '').toLowerCase();
    if (!q.trim()) return null;

    if (/(bàn|table)/i.test(q)) {
      return {
        explanation: 'Đã dựng một chiếc **bàn gỗ 4 chân** bằng bộ dựng 3D dự phòng.',
        code: `const grp = studio.addGroup("Ban_Go_Fallback");
const topMesh = studio.addCube({ name: "Mat_Ban", x: 0, y: 1.5, z: 0, width: 3.2, height: 0.22, depth: 2.0, color: 0xb87333, roughness: 0.55 });
grp.add(topMesh);
for (const [lx, lz] of [[-1.35, -0.75], [1.35, -0.75], [-1.35, 0.75], [1.35, 0.75]]) {
  const leg = studio.addCylinder({ name: "Chan_Ban", x: lx, y: 0.72, z: lz, radiusTop: 0.09, radiusBottom: 0.07, height: 1.44, color: 0x3b3b42, metalness: 0.4, roughness: 0.45 });
  grp.add(leg);
}`
      };
    }

    if (/(nhà|house|villa|building|tòa nhà)/i.test(q)) {
      return {
        explanation: 'Đã dựng một **ngôi nhà hiện đại kèm cây xanh** bằng bộ dựng 3D dự phòng.',
        code: `studio.createBuilding({ name: "Ngoi_Nha_Mau", x: 0, y: 0, z: 0, floors: 2, width: 4.5, depth: 3.8, floorHeight: 2.2, color: 0xf4f1ea, windowColor: 0x74b9ff, roofType: 'pitched' });
studio.createTree({ name: "Cay_San_Vuon", x: -3.8, y: 0, z: 2.4, style: 'lush' });
studio.addLight({ type: 'point', x: 4, y: 7, z: 5, intensity: 2.5 });`
      };
    }

    if (/(cây|tree|rừng|forest)/i.test(q)) {
      return {
        explanation: 'Đã dựng **cụm cây xanh 3D** bằng bộ dựng dự phòng.',
        code: `studio.createTree({ name: "Cay_Thong_1", x: 0, y: 0, z: 0, style: 'lowpoly' });
studio.createTree({ name: "Cay_La_2", x: 2.6, y: 0, z: -1.2, style: 'lush' });`
      };
    }

    if (/(cầu thang|stair)/i.test(q)) {
      return {
        explanation: 'Đã dựng **cầu thang 3D có lan can** bằng bộ dựng dự phòng.',
        code: `studio.createStaircase({ name: "Cau_Thang_3D", steps: 10, width: 2.2, withRailing: true });`
      };
    }

    if (/(đèn|ánh sáng|light|studio)/i.test(q)) {
      return {
        explanation: 'Đã thiết lập **hệ thống ánh sáng Studio 3 điểm** bằng bộ dựng dự phòng.',
        code: `studio.setupProStudio({ withBackdrop: false });`
      };
    }

    if (/(cầu|sphere|hành tinh|planet)/i.test(q)) {
      return {
        explanation: 'Đã tạo **khối cầu kim loại PBR** bằng bộ dựng dự phòng.',
        code: `studio.addSphere({ name: "Khoi_Cau_PBR", x: 0, y: 1.2, z: 0, radius: 1.2, color: 0x00cec9, metalness: 0.75, roughness: 0.2 });`
      };
    }

    if (/(hộp|khối|lập phương|cube|box)/i.test(q)) {
      return {
        explanation: 'Đã tạo **khối lập phương mẫu** bằng bộ dựng dự phòng.',
        code: `studio.addCube({ name: "Khoi_Hop_3D", x: 0, y: 1.0, z: 0, width: 2, height: 2, depth: 2, color: 0x54a0ff, roughness: 0.35 });`
      };
    }

    return null;
  }

  // =========================================================================
  // EXECUTION ENGINE
  // =========================================================================

  /**
   * Safely execute JavaScript code in the context of the studio engine
   */
    /**
   * Human-like Step-by-Step 3D Construction Animator
   * Plays the sequential creation of groups, blocks, and meshes with live viewport HUD & bounce-in.
   */
  async _playHumanConstructionSequence(newItems, sm, scene) {
    if (!newItems || newItems.length === 0) return;
    const animToken = (this._buildAnimToken = (this._buildAnimToken || 0) + 1);
    const isCancelled = () => animToken !== this._buildAnimToken || this._userAborted;

    // Filter into groups and visual meshes (bỏ qua helper/gizmo/system overlays)
    const groups = newItems.filter(o => o.isGroup && !o.userData?.isHelper && !o.userData?.isSystemObject && !o.userData?.isGizmo);
    const meshes = newItems.filter(o => (o.isMesh || o.isPoints || o.isLine) && !o.isHelper && !o.userData?.isHelper && !o.userData?.isSystemObject && !o.userData?.isGizmo);

    if (meshes.length === 0 && groups.length === 0) return;

    // 1. Create or get Viewport HUD
    let hud = document.getElementById('blender-construction-hud');
    if (!hud) {
      hud = document.createElement('div');
      hud.id = 'blender-construction-hud';
      hud.className = 'blender-construction-hud';
      hud.innerHTML = `
        <div class="hud-pulse-dot"></div>
        <div class="hud-badge-tag">AI Human Modeling</div>
        <div style="display:flex; flex-direction:column;">
          <div class="hud-step-text" id="hud-step-title">🔨 Preparing 3D geometry blocks...</div>
          <div class="hud-sub-text" id="hud-step-sub">Initializing coordinate system</div>
        </div>
        <button class="hud-skip-btn" id="hud-skip-btn" title="Skip build animation to view final result immediately">⚡ Skip</button>
      `;
      const host = document.getElementById('viewport-canvas-host') || document.querySelector('.viewport-canvas-host') || document.body;
      host.appendChild(hud);
    }

    hud.classList.remove('hud-hidden');
    const hudTitle = hud.querySelector('#hud-step-title');
    const hudSub = hud.querySelector('#hud-step-sub');
    const hudSkip = hud.querySelector('#hud-skip-btn');

    let skipRequested = false;
    if (hudSkip) {
      hudSkip.onclick = () => {
        skipRequested = true;
        if (hudTitle) hudTitle.textContent = '⚡ Completing immediately...';
      };
    }

    // 2. Snapshot original scales and hide meshes initially
    const originalScales = new Map();
    for (const m of meshes) {
      originalScales.set(m, m.scale.clone());
      m.scale.set(0.0001, 0.0001, 0.0001);
      m.visible = false;
    }

    const totalSteps = groups.length + meshes.length;
    let stepIndex = 0;
    const baseSpeed = Math.max(40, this.settings.constructionSpeed || 130);

    try {
      // 3. Step A: Announce and highlight Groups
      for (const grp of groups) {
        if (skipRequested || isCancelled()) break;
        stepIndex++;
        const grpName = grp.name || 'Object Group';
        if (hudTitle) hudTitle.textContent = `📦 [Group ${stepIndex}/${totalSteps}] Creating Group: "${grpName}"`;
        if (hudSub) hudSub.textContent = `Linking coordinate transform & hierarchy`;
        
        this._updateThinkingStep(`📦 <b>[Step ${stepIndex}/${totalSteps}]</b> Creating Group: <code>${this._escapeHTML(grpName)}</code>...`, Math.round((stepIndex / totalSteps) * 100));

        if (sm && typeof sm.select === 'function') {
          try { sm.select(grp, false); } catch (_) {}
        }

        await new Promise(r => setTimeout(r, Math.min(80, baseSpeed * 0.6)));
      }

      // 4. Step B: Sequentially create, position, and bounce-in each mesh block
      for (let i = 0; i < meshes.length; i++) {
        if (skipRequested || isCancelled()) break;
        stepIndex++;
        const mesh = meshes[i];
        const targetScale = originalScales.get(mesh) || new THREE.Vector3(1, 1, 1);

        // Extract descriptive name
        let blockName = mesh.name;
        if (!blockName || blockName === 'Mesh' || blockName.startsWith('Object_')) {
          const geomType = mesh.geometry ? mesh.geometry.type.replace('Geometry', '') : 'Block';
          blockName = `${geomType} #${i + 1}`;
        }

        // Material info description
        let matInfo = 'PBR Material';
        if (mesh.material) {
          const mat = mesh.material;
          if (mat.metalness > 0.6) matInfo = 'Metallic Titanium';
          else if (mat.roughness < 0.2) matInfo = 'Reflective Glossy Glass';
          else if (mat.emissive && typeof mat.emissive.getHex === 'function' && mat.emissive.getHex() > 0) matInfo = 'Emissive Neon Glow';
          else if (mat.wireframe) matInfo = 'Wireframe Mesh';
        }

        // Update HUD and Thinking Status
        if (hudTitle) hudTitle.textContent = `🔨 [Mesh ${i + 1}/${meshes.length}] Sculpting: "${blockName}"`;
        if (typeof window !== 'undefined') {
          if (!window.__hudHistory) window.__hudHistory = [];
          window.__hudHistory.push({
            step: i + 1,
            total: meshes.length,
            name: blockName,
            title: hudTitle ? hudTitle.textContent : '',
            sub: hudSub ? hudSub.textContent : ''
          });
        }
        if (hudSub) {
          const pos = mesh.position;
          hudSub.textContent = `Position: [${pos.x.toFixed(1)}, ${pos.y.toFixed(1)}, ${pos.z.toFixed(1)}] • ${matInfo}`;
        }

        this._updateThinkingStep(`🔨 <b>[${i + 1}/${meshes.length}]</b> Sculpting & aligning <code>${this._escapeHTML(blockName)}</code>...`, Math.round((stepIndex / totalSteps) * 100));

        // Visual selection highlight: Attach gizmo to current mesh being sculpted!
        if (sm && typeof sm.select === 'function') {
          try { sm.select(mesh, false); } catch (_) {}
        }

        // Reveal and animate spring pop-in
        mesh.visible = true;
        const startT = performance.now();
        const animDuration = baseSpeed;

        while (performance.now() - startT < animDuration && !skipRequested && !isCancelled()) {
          const t = Math.min(1.0, (performance.now() - startT) / animDuration);
          // Elastic overshoot spring easing: 1 + 2.7 * (t-1)^3 + 1.7 * (t-1)^2
          const s = t === 1.0 ? 1.0 : 1 + 2.70158 * Math.pow(t - 1, 3) + 1.70158 * Math.pow(t - 1, 2);
          mesh.scale.set(targetScale.x * s, targetScale.y * s, targetScale.z * s);
          if (window.renderer && window.scene && window.camera) {
            window.renderer.render(window.scene, window.camera);
          }
          await new Promise(r => requestAnimationFrame(r));
        }
        mesh.scale.copy(targetScale);

        if (isCancelled()) break;
        // Short breathing pause between components
        await new Promise(r => setTimeout(r, Math.min(45, baseSpeed * 0.3)));
      }
    } finally {
      // 5. Finalize: always restore original scales & visibility even if skipped or superseded
      for (const [m, s] of originalScales.entries()) {
        m.scale.copy(s);
        m.visible = true;
      }
    }

    if (isCancelled()) return;

    // Select top group if available
    const rootGroup = groups.length > 0 ? groups[0] : (meshes.length > 0 ? meshes[0] : null);
    if (sm && typeof sm.select === 'function' && rootGroup) {
      try { sm.select(rootGroup, false); } catch (_) {}
    }

    if (hudTitle) hudTitle.textContent = `✨ Modeling complete! Assembled ${meshes.length} components.`;
    if (hudSub) hudSub.textContent = `All objects synced to Scene & Outliner.`;

    // Fade out HUD
    setTimeout(() => {
      if (hud && animToken === this._buildAnimToken) hud.classList.add('hud-hidden');
    }, 2000);
  }

  async executeGeneratedCode(code) {
    this._lastExecutionError = null;
    try {
      const win = typeof window !== 'undefined' ? window : null;
      const studioInst = this.studio || win?.studio || null;
      const sm = win?.sceneManager || null;
      const scene = win?.scene || win?.engine?.scene || studioInst?.scene || null;
      const THREE = win?.THREE || studioInst?.THREE || null;
      if (!sm || !scene) throw new Error('SceneManager is not available.');

      if (win) {
        win.THREE = THREE;
        win.scene = scene;
        win.studio = studioInst;
        win.sceneManager = sm;
      }

      let cleanCode = (code || '').trim();
      cleanCode = cleanCode.replace(/^import\s+.*?;?\s*$/gm, '// [stripped import]');
      cleanCode = cleanCode.replace(/import\s+[\s\S]*?from\s+['"][^'"]+['"];?/g, '// [stripped import]');
      cleanCode = cleanCode.replace(/^export\s+(?:default\s+)?/gm, '// [stripped export] ');
      cleanCode = cleanCode
        .replace(/(?:const|let|var)\s+scene\s*=\s*new\s+THREE\.Scene\([^)]*\);?/g, '/* using active viewport scene */')
        .replace(/(?:const|let|var)\s+camera\s*=\s*new\s+THREE\.(?:Perspective|Orthographic)Camera\([^)]*\);?/g, '/* using active viewport camera */')
        .replace(/(?:const|let|var)\s+renderer\s*=\s*new\s+THREE\.WebGLRenderer\([^)]*\);?/g, '/* using active viewport renderer */')
        .replace(/(?:window\.)?engine\.camera\.position\.(?:set|copy|lerp|add)[^;]*;?/g, '/* [camera guard] preserve user camera */')
        .replace(/(?:window\.)?engine\.controls\.target\.(?:set|copy)[^;]*;?/g, '/* [camera guard] */')
        .replace(/(?:window\.)?engine\.controls\.enabled\s*=\s*(?:true|false)\s*;?/g, '/* [camera guard] */')
        .replace(/(?:window\.)?camera\.position\.(?:set|copy|lerp|add)[^;]*;?/g, '/* [camera guard] preserve user camera */')
        .replace(/camera\.lookAt\([^)]*\)\s*;?/g, '/* [camera guard] */')
        .replace(/withTurntable:\s*true/g, 'withTurntable: false /* [camera guard] disable auto-turntable */');

      const guardVerdict = scanGeneratedCode(cleanCode);
      if (!guardVerdict.ok) {
        const reason = describeViolations(guardVerdict.violations);
        this._lastExecutionError = { blocked: true, message: reason };
        console.warn('[AICopilot Guard] Đã chặn code AI:', guardVerdict.violations);
        this._addBotMessage(
          `🛡️ Đã chặn code AI vì ${reason}. Copilot chỉ được thao tác cảnh 3D — ` +
          'không được đọc/ghi dữ liệu dự án, gọi API backend hay sửa giao diện.'
        );
        return false;
      }

      this._copilotRuntime?.stop();
      const runtime = new CopilotRuntime({
        sceneManager: sm,
        studio: studioInst,
        THREE,
        scene,
        camera: win?.camera || studioInst?.camera || null,
        engine: win?.engine || null,
        editMode: win?.editMode || null,
        modifiers: win?.modifiers || win?.Modifiers || null,
        simulationManager: win?.simulationManager || null,
        sculptMode: win?.sculptMode || null,
        stemTutor: win?.stemTutor || null,
        setViewportMode: (mode) => win?.stemTutor?._switchModeSafely?.(mode) || false,
        setEditSelectionMode: (mode) => win?.editMode?.setMode?.(mode) || false,
      });
      this._copilotRuntime = runtime;
      const result = await runtime.execute(cleanCode, {
        onLog: (entry) => {
          const message = entry.args.map((value) => typeof value === 'string' ? value : JSON.stringify(value)).join(' ');
          win?.app?.codeEditor?.log?.(entry.level === 'error' ? 'error' : 'success', message);
          console.log('[Copilot Script]', message);
        },
      });

      const newCreatedObjects = result.newObjects || [];
      const isTutorOrInteractiveMode = /studio\.tutor\.(?:guideSteps|command)|window\.editMode\b/.test(cleanCode)
        || Boolean(win?.editMode?.isActive || win?.sculptMode?.isActive);
      if (this.settings.humanConstructionMode !== false && newCreatedObjects.length > 0 && !isTutorOrInteractiveMode) {
        await this._playHumanConstructionSequence(newCreatedObjects, sm, scene);
      } else if (newCreatedObjects.length > 0) {
        const firstRoot = newCreatedObjects.find((object) => object.parent === sm.rootContainer) || newCreatedObjects[0];
        try { sm.select(firstRoot, false); } catch (_) {}
      }
      result.resume();

      if (sm.objects) {
        this.conversationContext.createdObjects = Array.from(sm.objects.values()).map((object) => object?.name || 'Unnamed');
      }
      win?.dispatchEvent(new CustomEvent('blender:scene-updated'));
      if (win?.app?.outliner?.render) win.app.outliner.render();
      else if (win?.outliner?.render) win.outliner.render();
      else win?.outliner?.refresh?.();
      win?.inspector?.updateObjectProperties?.();

      console.log('[AICopilot 2.0] Code executed successfully.');
      return true;
    } catch (err) {
      this._lastExecutionError = {
        blocked: err?.code === 'E_PERMISSION',
        code: err?.code || null,
        message: err?.message || 'Runtime execution error',
        stack: err?.stack ? String(err.stack).slice(0, 600) : '',
      };
      console.error('[AICopilot 2.0] Execution failed:', err);
      this._addBotMessage(`⚠️ Code execution error: ${err.message}`);
      return false;
    }
  }

  // =========================================================================
  // ONLINE CLOUD LLM CALLERS WITH MULTI-TURN CONTEXT
  // =========================================================================

  /**
   * Tóm tắt cảnh thật (hierarchy, poly, material, clip, selection) để model biết
   * đang có gì trước khi dựng — thay cho cờ boolean cố định trong conversationContext.
   */
  _describeLiveScene() {
    try {
      const scope = typeof window !== 'undefined' ? window : null;
      const sm = scope?.sceneManager || null;
      const scene = scope?.scene || scope?.engine?.scene || sm?.scene || this.studio?.scene || null;
      let selection = [];
      let activeObj = null;
      try {
        activeObj = typeof sm?.getActiveObject === 'function' ? sm.getActiveObject() : null;
        if (activeObj?.name) selection = [activeObj.name];
      } catch (_) {}
      const digest = buildSceneDigest(scene, { selection, maxObjects: 24 });
      const parts = [formatSceneDigestForPrompt(digest, { maxChars: 1350 })];

      if (digest.isEmpty && sm?.objects?.size > 0) {
        const tracked = Array.from(sm.objects.values()).map((o) => o?.name || o?.type).slice(0, 24);
        parts[0] = `Scene tracked objects (${sm.objects.size}): ${tracked.join(', ')}`;
      }

      const app = scope?.app || null;
      const modeText = typeof document !== 'undefined' ? document.getElementById('viewport-mode')?.value : '';
      if (modeText) parts.push(`Viewport mode: ${modeText}`);
      if (activeObj?.userData?.modifierStack?.length) {
        const stack = activeObj.userData.modifierStack.map((m) => `${m.type}${m.enabled === false ? '(off)' : ''}`).join(', ');
        parts.push(`Active modifiers: [${stack}]`);
      }
      if (activeObj?.userData?.physics) {
        parts.push(`Active physics: ${JSON.stringify(activeObj.userData.physics)}`);
      }
      const sim = scope?.simulationManager || app?.simulationManager || null;
      if (sim && ((sim.bodies?.size || 0) || (sim.joints?.size || 0) || sim.isPlaying)) {
        parts.push(`Physics sim: ${sim.bodies?.size || 0} bodies, ${sim.joints?.size || 0} joints, playing=${Boolean(sim.isPlaying)}`);
      }
      return parts.join('\n').slice(0, 1650);
    } catch (_) {
      return 'Scene digest unavailable.';
    }
  }

  _getSystemPrompt({ userPrompt = '', images = [] } = {}) {
    const ctx = this.conversationContext;
    const prefabText = (typeof prefabLibrary !== 'undefined' && prefabLibrary)
      ? prefabLibrary.describeForAI()
      : '';
    const liveSceneText = this._describeLiveScene();
    const selectedSkills = this.selectSkills(userPrompt, {
      images,
      liveScene: liveSceneText,
    });
    const skillsSection = formatCopilotSkillsForPrompt(selectedSkills, { maxChars: 3400 });
    return `You are Hunger AI Copilot — a Principal 3D Technical Artist & Parametric CAD Engineer for Hunger 3D Studio (Three.js web-native 3D editor).

=== 1. LIVE SCENE & MULTI-TURN CONTEXT ===
${liveSceneText}
- Last generated: "${ctx.lastModelType || 'None'}" | Outliner objects: [${ctx.createdObjects.join(', ')}]
- To read/inspect the scene, use LIVE SCENE DIGEST above (or JSON tool scene.tree/scene.info if agentId/details are needed).
- When modifying/recoloring/adding to existing models, DO NOT call studio.clearScene() — target existing meshes via studio.getObject(nameOrUuid) or scene.getObjectByName(...) or sceneManager.getActiveObject().
- When asked to clear/empty the scene, output ONE \`\`\`javascript\`\`\` block calling \`studio.clearScene();\` (NEVER bare \`THREE.Scene.clear()\` if avoiding wrapper).

=== 2. 3D CRAFTSMANSHIP & QUALITY BAR (CRITICAL) ===
- NEVER build hero architecture, vehicles, products, furniture, or characters out of 5–15 stacked bare cubes/cones!
- For any new hero 3D creation, write a rich, modular, production-grade script (typically 120–280 lines with shared dimension constants & helper functions) that delivers:
  1. **Exact Math Grounding (\`y = 0\`)**: Compute every elevation from shared constants (\`const plinthH = ...; const wallY = plinthH;\`) so zero parts float, sink, or z-fight (offset layered trims/glass >= 0.005m). Orient front facade toward \`+Z\`.
  2. **Parametric CAD First**: Use \`studio.addExtrude\` (with pierced \`holes\` via \`sampleContour({ op: 'twoCenterArc' | 'roundedRect' | 'circle' | 'regularPolygon' | 'rosette', ... })\`), \`studio.addSweep\` (mitered cornices/moldings/pipes/frames), \`studio.addLoft\` (tapered/curved hulls & spires), \`studio.addLathe\` (domes, columns, balusters, vases), \`studio.addSurfaceGrid\` (vaults/canopies), and \`studio.addInstancedMesh\` / \`scatterOnCurve\` for >=4 repeated parts.
  3. **Layered Secondary & Micro Detail**: Include plinths, recessed doors/windows with mullions & frames, overhanging eaves/cornices, steps, railings, wheel arches/rims, trims, and interior volume when hollow.
  4. **Real PBR & Fitted 4K Lighting**: Share canonical materials, run \`await studio.applyProceduralPBR(target, { pattern, resolution: 1024, ... })\` on primary surfaces (avoid untextured plastic clay), call \`studio.setupSunLight({ elevation: 38, azimuth: 140, intensity: 2.2, shadowMapSize: 4096, withSky: true })\`, and set \`castShadow = false\` on large ground planes (>100m).

=== 3. RAPID STUDIO DSL & WORKER TOOLKIT ===
${prefabText}

Global \`studio\` & \`THREE\` inside isolated Worker (NO import/export, NO DOM/fetch/storage, NO new Scene/Camera/WebGLRenderer):
- Parametric CAD, Sweep, Loft, Curves, Boolean & GPU Instancing (USE THESE FIRST):
  studio.sampleContour({op:'twoCenterArc'|'roundedRect'|'rect'|'circle'|'regularPolygon'|'rosette', centerX, centerY, springY, baseY, width, height, radius, sides, lobes}, segments),
  studio.addExtrude({contour,holes,depth,bevelSize,bevelSegments,uvScale,creaseAngleDeg,x,y,z,parent,name,...mat}),
  studio.addSweep({profile,path,planeNormal,closedPath,miterLimit,scaleStart,scaleEnd,x,y,z,parent,name,...mat}),
  studio.addLathe({profile,segments,phiStart,phiLength,capEnds,creaseAngleDeg,x,y,z,parent,name,...mat}),
  studio.addLoft({sections:[{contour,x,y,z,scale,twist,plane}],samples,capStart,capEnd,creaseAngleDeg,x,y,z,parent,name,...mat}),
  studio.addSurfaceGrid({grid,thickness,creaseAngleDeg,x,y,z,parent,name,...mat}),
  studio.sampleCurve3D({type:'catenary'|'helix'|'scroll'|'arch'|'bezier'|'catmullrom',segments,...}),
  studio.scatterOnCurve(proto,curveOrOpts,{seed,alignTangent,scaleMin,scaleMax,removeSource:true,name}),
  studio.boolean('subtract'|'union'|'intersect',targetA,targetB),
  studio.mergeMeshes(parts,{removeSources:true,recomputeCreaseNormals:true,vertexAO:true,name,...mat}),
  studio.addInstancedMesh(protoMeshOrGeom,instances,{removeSource:true,name,...mat}) [instances accept {x,y,z,rx,ry,rz,sx,sy,sz} or {position,rotation,scale}],
  studio.boxProjectUV(target,{metersPerTile:2.0,worldSpace:true}), studio.computeCreaseNormals(target,32), studio.bakeVertexAO(target),
  studio.inspectSceneBudget(targetOrTier,{tier:'mobile'|'product'|'architecture'}),
  await studio.exportModel({binary:true,optimize:true,textureFormat:'auto',lossyDataMaps:false,maxTextureSize:1024,download:true}),
  studio.modifyGeometry(mesh,'mirror'|'array'|'solidify'|'taper'|'twist'|'crease_normals'|'box_uv'|'vertex_ao',params).
- Primitives & Groups (auto-synced to Viewport + Outliner; curved primitives default smooth):
  studio.addCube({x,y,z,width,height,depth,color,roughness,metalness,emissive,emissiveIntensity,transparent,opacity,parent,rotationX,rotationY,rotationZ,scale,name}),
  studio.addSphere, studio.addIcoSphere, studio.addCylinder, studio.addCone, studio.addTorus, studio.addPlane, studio.addGrid, studio.addCircle, studio.addCapsule,
  studio.addGroup(name,{parent,x,y,z}), studio.addLight({type:'point'|'directional'|'spot'|'ambient',x,y,z,color,intensity,distance,name}), studio.addCamera({name,x,y,z,targetX,targetY,targetZ,fov,focalLength}),
  studio.createStaircase(...), studio.createBuilding(...), studio.createTree(...), studio.repeatRadial(...), studio.repeatGrid(...), studio.clearScene().
- Characters (async — ALWAYS await): await studio.placePrefab(id,{x,y,z,height,scale,rotationY,name}), await studio.loadHumanWithAnimation({animation:'Walk'|'Idle'|'Run'|'TPose',showSkeleton:true,keepScene:true,x,y,z}), studio.playCharacterAnimation(model,clip), studio.createArticulatedActor({...}).
- PBR, 1K/2K Procedural Textures & Look-Dev: studio.createPBRMaterial(presetId,overrides), studio.applyMaterialPreset(target,preset), await studio.applyProceduralPBR(target,{pattern:'weathered_concrete'|'clay_roof_tiles'|'mullioned_glass'|'ashlar_stone'|'stucco_plaster'|'roof_slates'|'wood_grain'|'checkered_marble'|'stained_mosaic'|'brushed'|'carbon'|'noise'|'voronoi',resolution:1024,repeat:[u,v],normalScale:0.85,useDiffuseMap:true,useRoughnessMap:true,color1,color2,tint,slotIndex}), studio.setupSunLight({elevation:42,azimuth:138,intensity:2.2,shadowMapSize:4096,withSky:true}), studio.setRenderQuality('studio'|'cinematic'|'fast'), studio.setColor(mesh,color), studio.setEmissive(mesh,color,intensity), studio.setupProStudio({withBackdrop:false,withTurntable:false}), studio.setShadingMode('wireframe'|'solid'|'rendered'), studio.setMatCap(style), studio.restoreMaterials().
- Animation & Rig: studio.animate(mesh,(t,dt,mesh)=>{...}) [runs immediately], studio.insertKeyframe(obj,frame,channels), studio.playAnimation(), studio.pauseAnimation(), studio.seekFrame(f), studio.createHumanoidArmature/createRiggedMannequin/autoSkinMesh/setPose/setIKEnabled/applyMotionPreset.
- Edit Mode & Modifiers: studio.enterEditMode(mesh), studio.setEditSelectionMode('vertex'|'edge'|'face'), studio.selectFace(i), studio.selectEdge(i), extrude(d), inset(o), subdivide(), bevel(w), deleteSelection(), exitEditMode();
  studio.modifiers.add(type,params,mesh) / window.Modifiers.applyModifier(mesh, type, params) ['bevel','subdivision','solidify','displace','smooth','array','mirror','wireframe','decimate','screw','remesh','weld'], window.Modifiers.applyBoolean(a,b,'union'|'subtract'|'intersect').
- Physics & Video: window.simulationManager?.setConfig(mesh,{body:'dynamic'|'fixed'|'kinematic',collider:'auto'|'box'|'sphere'|'cylinder'|'capsule'|'convex',mass,friction,restitution}), await studio.renderVideo({fps,durationSec,width,height,preset}).
- 1-1 Tutor UI: await studio.tutor.guideSteps([{title,speech,pointAt,viewportMode,editSelectionMode,openPanel,demoCode},...],{speak:true,autoAdvance:true}) when user asks "hướng dẫn/dạy/từng bước".
- THREE helpers: THREE.CatmullRomCurve3, TubeGeometry, LatheGeometry, Shape+ExtrudeGeometry. Always use studio.add*(...) (or scene.add inside code block) so objects sync to Scene/Outliner.

=== 4. ACTIVE SPECIALIST SKILLS ===
${skillsSection}

=== CRITICAL CAMERA RULES (user MUST keep manual control) ===
- NEVER move the user's viewport camera (window.engine.camera.position, camera.position, controls.target, controls.enabled). Creating a camera object is fine; NEVER set withTurntable: true unless asked.

=== ANIMATION HONESTY RULES & CAPABILITY LIMITS ===
- Only claim animation exists when code calls studio.animate / loadHumanWithAnimation / playCharacterAnimation / applyMotionPreset / insertKeyframe.
- Sandbox blocks fetch, XMLHttpRequest, WebSocket, storage, import/export, document.body. Sculpt brush strokes (Clay/Grab/Flatten) are manual viewport mouse tools and cannot be scripted.

=== OUTPUT FORMAT ===
- NEVER include '<think>' tags.
- For any 3D creation/modification/clear request, reply with a concise Vietnamese/English summary AND ONE complete runnable \`\`\`javascript ... \`\`\` block (NEVER reply claiming "Đã thêm/xoá" without code or a JSON tool call).`;
  }

  _buildOpenAIMessages(userPrompt, images = []) {
    const messages = [{ role: 'system', content: this._getSystemPrompt({ userPrompt, images }) }];
    this.conversationContext.turns.slice(-6).forEach(turn => {
      messages.push({
        role: turn.role === 'assistant' ? 'assistant' : 'user',
        content: turn.role === 'assistant' && turn.code
          ? `${turn.text}\n\`\`\`javascript\n${turn.code}\n\`\`\``
          : turn.text
      });
    });
    if (images && images.length > 0) {
      const parts = images.map(img => ({
        type: 'image_url',
        image_url: { url: img.dataUrl, detail: 'high' }
      }));
      parts.push({ type: 'text', text: userPrompt });
      messages.push({ role: 'user', content: parts });
    } else {
      messages.push({ role: 'user', content: userPrompt });
    }
    return messages;
  }

  _modelForProvider(provider) {
    if (provider === 'gemini') return this.settings.geminiModel || 'gemini-3.5-flash-lite';
    return this.settings.customModel || 'claude-sonnet-4-6';
  }

  _getByokKey() {
    if (this._byokKey) return this._byokKey;
    try {
      if (typeof sessionStorage !== 'undefined') {
        return String(sessionStorage.getItem('wbs_ai_byok_key') || '').trim();
      }
    } catch (_) {}
    return '';
  }

  _setByokKey(value) {
    const clean = String(value || '').trim();
    this._byokKey = clean;
    try {
      if (typeof sessionStorage !== 'undefined') {
        if (clean) sessionStorage.setItem('wbs_ai_byok_key', clean);
        else sessionStorage.removeItem('wbs_ai_byok_key');
      }
    } catch (_) {}
  }

  /**
   * All cloud models go through the server proxy. Signed-in Cloud users use
   * /api/cloud/ai/chat (supporting credit metering + optional BYOK), while
   * local dev falls back to /api/ai/chat.
   */
  async _callProxyAPI(provider, userPrompt, images = []) {
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const parentSignal = this._activeAbortController?.signal || null;
    if (parentSignal?.aborted && controller) controller.abort();
    const onParentAbort = () => controller?.abort();
    parentSignal?.addEventListener?.('abort', onParentAbort, { once: true });
    const timer = controller ? setTimeout(() => controller.abort(), 150000) : null;
    const usedModel = this._modelForProvider(provider);
    const byokKey = this._getByokKey();
    const cloudClient = (typeof window !== 'undefined' && (window.app?.cloud || window.cloudClient)) || null;
    const useCloudRoute = Boolean(cloudClient?.isSignedIn?.());
    const url = useCloudRoute
      ? (cloudClient.absoluteUrl ? cloudClient.absoluteUrl('/api/cloud/ai/chat') : '/api/cloud/ai/chat')
      : '/api/ai/chat';
    let resp;
    try {
      if (useCloudRoute && typeof cloudClient._ensureFresh === 'function') {
        await cloudClient._ensureFresh();
      }
      const headers = { 'Content-Type': 'application/json' };
      if (useCloudRoute && cloudClient?.session?.accessToken) {
        headers.Authorization = `Bearer ${cloudClient.session.accessToken}`;
      }
      if (byokKey) {
        headers['X-AI-Provider-Key'] = byokKey;
      }
      resp = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          provider,
          model: usedModel,
          messages: this._buildOpenAIMessages(userPrompt, images),
          temperature: 0.35,
          max_tokens: 12288,
        }),
        signal: controller ? controller.signal : undefined
      });
    } catch (err) {
      if (err && err.name === 'AbortError') {
        if (this._userAborted || parentSignal?.aborted) {
          throw new Error('Đã dừng yêu cầu AI theo thao tác của bạn.');
        }
        throw new Error('AI không phản hồi sau 60 giây. Hãy thử lại hoặc chọn model khác.');
      }
      if (err && (err.name === 'TypeError' || /failed to fetch|networkerror|load failed/i.test(String(err.message || '')))) {
        throw new Error(`Không kết nối được backend AI (${url}). Hãy kiểm tra server đang chạy và tải lại trang.`);
      }
      throw err;
    } finally {
      if (timer) clearTimeout(timer);
      parentSignal?.removeEventListener?.('abort', onParentAbort);
    }

    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      const msg = err?.error?.message || (typeof err?.error === 'string' ? err.error : '') || `Dịch vụ AI tạm gián đoạn (HTTP ${resp.status}).`;
      const hint = err?.error?.hint ? ` ${err.error.hint}` : '';
      throw new Error(`${msg}${hint}`);
    }

    const data = await resp.json();
    const text = data?.choices?.[0]?.message?.content;
    if (!text) {
      throw new Error('Model AI trả về nội dung rỗng. Hãy thử lại hoặc chọn model khác.');
    }
    return {
      ...this._parseLLMResponse(text),
      _usedModel: data?.model || usedModel,
      _usedProvider: provider,
    };
  }

  _callMotapisAPI(userPrompt, images = []) {
    return this._callProxyAPI('motapis', userPrompt, images);
  }

  _callGeminiAPI(userPrompt, images = []) {
    return this._callProxyAPI('gemini', userPrompt, images);
  }

  _callOpenAIAPI(userPrompt, images = []) {
    return this._callProxyAPI('openai', userPrompt, images);
  }

  _extractExplanationAndCode(rawText) {
    return this._parseLLMResponse(rawText);
  }

  _parseLLMResponse(rawText) {
    const cleaned = stripThinkingTags(rawText);
    const codeMatch = cleaned.match(/```(?:javascript|js)?([\s\S]*?)```/i);
    let code = null;
    let explanation = cleaned;

    if (codeMatch) {
      code = codeMatch[1].trim();
      explanation = cleaned.replace(codeMatch[0], '').trim();
    }

    return { explanation, code };
  }
}

if (typeof window !== 'undefined') {
  window.AICopilot = AICopilot;
}

export default AICopilot;
