/**
 * Unified Voice Wake & Command Router for AI Copilot 3D + STEM Tutor 1-1.
 *
 * Solves two core UX gaps cleanly without hardware mic conflicts:
 *  1. Single shared `StemVoiceSession` owner (no competing SpeechRecognition instances).
 *  2. Hands-free Wake Word auto-activation ("Copilot ơi", "Thầy ơi", "Trợ lý ơi",
 *     "Hey Copilot", "Hey Studio", ...) + instant voice navigation commands +
 *     persistent active-gesture auto-arm across reloads.
 */

import { StemVoiceSession } from '../education/stem-voice-session.js';

export const VOICE_WAKE_STORAGE_KEY = 'wbs_voice_wake_enabled_v1';

export const COPILOT_WAKE_WORDS = Object.freeze([
  'ai copilot ơi',
  'copilot ơi',
  'co pilot ơi',
  'cô pilot ơi',
  'cô pai lốt ơi',
  'cô ba lốt ơi',
  'hey copilot',
  'trợ lý ơi',
  'ai ơi'
]);

export const STEM_WAKE_WORDS = Object.freeze([
  'giáo viên ơi',
  'thầy giáo ơi',
  'cô giáo ơi',
  'thầy ơi',
  'cô ơi',
  'này thầy',
  'stem ơi',
  'ét tem ơi',
  'hey tutor',
  'hey studio'
]);

export const ALL_WAKE_WORDS = Object.freeze([
  ...COPILOT_WAKE_WORDS,
  ...STEM_WAKE_WORDS
]);

const LEADING_CREATION_RE = /^(?:hãy\s+)?(?:tạo|vẽ|dựng|xây|thêm|làm\s+một|create|build|make|add|generate|design)\b/i;

const QUICK_COMMAND_RULES = [
  { command: 'pause_walk', re: /^(?:tạm\s+dừng|dừng\s+lại|ngừng\s+lại|ngưng\s+lại|dừng\s+hướng\s+dẫn|tạm\s+ngưng|tạm\s+nghỉ|nghỉ\s+chút|đợi\s+chút|đợi\s+tí|chờ\s+chút|khoan\s+đã|khoan|im\s+lặng|stop|pause)\b/i },
  { command: 'resume_walk', re: /^(?:tiếp\s+tục(?:\s+hướng\s+dẫn)?|nói\s+tiếp|giảng\s+tiếp|làm\s+tiếp|hướng\s+dẫn\s+tiếp|chạy\s+tiếp|resume|continue)\b/i },
  { command: 'auto_walk', re: /^(?:tự\s+chạy|tự\s+hướng\s+dẫn|hướng\s+dẫn\s+liên\s+tục|hướng\s+dẫn\s+hết|chạy\s+hết\s+(?:các\s+)?bước|auto\s+walk|play\s+steps)\b/i },
  { command: 'next_step', re: /^(?:bước\s+tiếp(?:\s+theo)?|tiếp\s+theo|sang\s+bước(?:\s+sau)?|bước\s+sau|next\s+step|next)\b/i },
  { command: 'prev_step', re: /^(?:quay\s+lại|bước\s+trước|lùi\s+lại|trở\s+lại|prev(?:ious)?\s+step|back)\b/i },
  { command: 'replay', re: /^(?:đọc\s+lại|nói\s+lại|nhắc\s+lại|nghe\s+lại|replay)\b/i },
  { command: 'demo', re: /^(?:làm\s+mẫu(?:\s+bài)?|chạy\s+mẫu|xem\s+mẫu|auto\s*demo)\b/i },
  { command: 'grade', re: /^(?:chấm\s+điểm|kiểm\s+tra\s+bài|đánh\s+giá\s+bài|grade(?:\s+model)?)\b/i },
  { command: 'open_copilot', re: /^(?:mở|bật|hiện|gọi)\s+(?:ai\s+)?copilot\b/i },
  { command: 'close_copilot', re: /^(?:đóng|ẩn|tắt)\s+(?:ai\s+)?copilot\b/i },
  { command: 'open_stem', re: /^(?:mở|bật|hiện|gọi)\s+(?:giáo\s+viên|stem|bài\s+học|hướng\s+dẫn)\b/i },
  { command: 'close_stem', re: /^(?:đóng|ẩn|tắt)\s+(?:giáo\s+viên|stem|hướng\s+dẫn)\b/i }
];

/**
 * Parse short, unambiguous voice control commands without hitting the Cloud LLM.
 * Returns null if the utterance looks like a modeling/tutoring question.
 */
export function parseQuickVoiceCommand(text) {
  const clean = String(text || '')
    .trim()
    .replace(/^[.,!?;:\s-]+|[.,!?;:\s-]+$/g, '');
  if (!clean || clean.length > 52) return null;
  if (LEADING_CREATION_RE.test(clean)) return null;

  for (const rule of QUICK_COMMAND_RULES) {
    if (rule.re.test(clean)) {
      return rule.command;
    }
  }
  return null;
}

/**
 * Match a bare leading trigger such as "copilot tạo chiếc xe" without requiring "ơi".
 */
function matchLeadingBarePrefix(text, prefixes) {
  const raw = String(text || '').trim();
  const lower = raw.toLowerCase();
  for (const p of prefixes) {
    if (lower === p) {
      return { matched: true, wakeWord: p, query: '', wakeOnly: true };
    }
    const re = new RegExp(`^${p}(?:[\\s,.:;!?-]+|$)`, 'i');
    const m = raw.match(re);
    if (m) {
      const rest = raw.slice(m[0].length).trim();
      return { matched: true, wakeWord: p, query: rest, wakeOnly: rest.length === 0 };
    }
  }
  return null;
}

/**
 * Route an utterance either from Wake Mode or direct live mic into Copilot / STEM / Command.
 */
export function routeVoiceUtterance(rawText, options = {}) {
  const raw = String(rawText || '').trim();
  if (!raw) {
    return { target: 'ignore', wakeOnly: false, query: '', wakeWord: '', command: null, raw };
  }

  const requireWakeWord = options.requireWakeWord !== false;
  const activeTarget = options.activeTarget === 'copilot' ? 'copilot' : 'stem';
  const inActiveWindow = Boolean(options.inActiveWindow);

  // 1. Explicit Copilot wake phrases anywhere ("Copilot ơi, ...", "Trợ lý ơi ...")
  const copilotMatch = StemVoiceSession.matchWakePhrase(raw, COPILOT_WAKE_WORDS)
    || matchLeadingBarePrefix(raw, ['copilot', 'ai copilot']);
  if (copilotMatch && copilotMatch.matched) {
    const cmd = copilotMatch.query ? parseQuickVoiceCommand(copilotMatch.query) : null;
    if (cmd) {
      return {
        target: 'command',
        command: cmd,
        preferredAssistant: 'copilot',
        wakeWord: copilotMatch.wakeWord,
        wakeOnly: false,
        query: copilotMatch.query,
        raw
      };
    }
    return {
      target: 'copilot',
      command: null,
      wakeWord: copilotMatch.wakeWord,
      wakeOnly: copilotMatch.wakeOnly,
      query: copilotMatch.query,
      raw
    };
  }

  // 2. Explicit STEM Tutor wake phrases anywhere ("Thầy ơi, ...", "STEM ơi ...")
  const stemMatch = StemVoiceSession.matchWakePhrase(raw, STEM_WAKE_WORDS)
    || matchLeadingBarePrefix(raw, ['stem']);
  if (stemMatch && stemMatch.matched) {
    const cmd = stemMatch.query ? parseQuickVoiceCommand(stemMatch.query) : null;
    if (cmd) {
      return {
        target: 'command',
        command: cmd,
        preferredAssistant: 'stem',
        wakeWord: stemMatch.wakeWord,
        wakeOnly: false,
        query: stemMatch.query,
        raw
      };
    }
    return {
      target: 'stem',
      command: null,
      wakeWord: stemMatch.wakeWord,
      wakeOnly: stemMatch.wakeOnly,
      query: stemMatch.query,
      raw
    };
  }

  // 3. Direct quick voice commands ("mở copilot", "dừng lại", "bước tiếp theo"...)
  const directCmd = parseQuickVoiceCommand(raw);
  if (directCmd) {
    const alwaysAllowed = directCmd.startsWith('open_')
      || directCmd.startsWith('close_')
      || directCmd === 'pause_walk'
      || directCmd === 'auto_walk';
    if (!requireWakeWord || inActiveWindow || alwaysAllowed) {
      return {
        target: 'command',
        command: directCmd,
        preferredAssistant: activeTarget,
        wakeWord: '',
        wakeOnly: false,
        query: raw,
        raw
      };
    }
  }

  // 4. Require wake word if gated and outside active conversation window
  if (requireWakeWord && !inActiveWindow) {
    return { target: 'ignore', command: null, wakeWord: '', wakeOnly: false, query: '', raw };
  }

  // 5. Route open dictation by explicit intent or active assistant
  const looksLikeTutorQuestion = /(?:hướng\s+dẫn|chỉ\s+(?:tôi|mình)|dạy\s+(?:tôi|mình)|cách\s+làm|từng\s+bước|extrude|inset|bevel|subdiv|modifier|bài\s+\d)/i.test(raw)
    && !LEADING_CREATION_RE.test(raw);
  const looksLikeBuildPrompt = LEADING_CREATION_RE.test(raw);

  let target = activeTarget;
  if (requireWakeWord === false) {
    target = activeTarget;
  } else if (looksLikeBuildPrompt && !looksLikeTutorQuestion) {
    target = 'copilot';
  } else if (looksLikeTutorQuestion) {
    target = 'stem';
  }

  return {
    target,
    command: null,
    wakeWord: '',
    wakeOnly: false,
    query: raw,
    raw
  };
}

/**
 * Shared coordinator managing one hardware microphone session across Copilot + STEM.
 */
export class VoiceWakeCoordinator {
  constructor(options = {}) {
    this.mode = 'off'; // 'off' | 'wake' | 'stem' | 'copilot'
    this.activeTarget = options.activeTarget || 'stem';
    this.wakeEnabled = this._loadWakePreference(options.defaultWakeEnabled);
    this.autoWakePendingGesture = false;
    this.lastTranscript = '';
    this._listeners = new Set();
    this._gestureHandler = null;
    this._handlers = {
      onCopilotQuery: options.onCopilotQuery || null,
      onCopilotWakeOnly: options.onCopilotWakeOnly || null,
      onStemQuery: options.onStemQuery || null,
      onStemWakeOnly: options.onStemWakeOnly || null,
      onCommand: options.onCommand || null,
      onBargeIn: options.onBargeIn || null,
      onTranscript: options.onTranscript || null,
      onError: options.onError || null
    };

    this.session = options.session || new StemVoiceSession({
      lang: options.lang || 'vi-VN',
      continuous: true,
      silenceMs: Number.isFinite(options.silenceMs) ? options.silenceMs : 1450,
      minChars: 2,
      maxChars: 400,
      activeWindowMs: Number.isFinite(options.activeWindowMs) ? options.activeWindowMs : 25000,
      recognitionFactory: options.recognitionFactory,
      onTranscript: (payload) => this._handleTranscript(payload),
      onSubmit: (payload) => this._handleSubmit(payload),
      onBargeIn: (payload) => this._handleBargeIn(payload),
      onStateChange: () => this._notify(),
      onError: (err) => this._handleError(err)
    });
  }

  setHandlers(handlers = {}) {
    Object.assign(this._handlers, handlers);
  }

  setLang(lang) {
    if (!lang) return;
    this.session.lang = lang;
    if (this.session.recognition) {
      this.session.recognition.lang = lang;
    }
  }

  subscribe(fn) {
    if (typeof fn !== 'function') return () => {};
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  _notify() {
    const snap = this.getSnapshot();
    for (const fn of this._listeners) {
      try {
        fn(snap);
      } catch (_) {}
    }
  }

  getSnapshot() {
    return {
      mode: this.mode,
      activeTarget: this.activeTarget,
      wakeEnabled: this.wakeEnabled,
      autoWakePendingGesture: this.autoWakePendingGesture,
      isActive: Boolean(this.session?.isActive),
      isPaused: Boolean(this.session?.isPaused),
      sessionState: this.session?.state || 'idle',
      inActiveWindow: Boolean(this.session?.isAwakeWindowActive?.()),
      lastTranscript: this.lastTranscript
    };
  }

  _loadWakePreference(fallback = false) {
    try {
      if (typeof localStorage === 'undefined') return Boolean(fallback);
      const raw = localStorage.getItem(VOICE_WAKE_STORAGE_KEY);
      if (raw === null) return Boolean(fallback);
      return raw === '1' || raw === 'true';
    } catch (_) {
      return Boolean(fallback);
    }
  }

  _saveWakePreference(enabled) {
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(VOICE_WAKE_STORAGE_KEY, enabled ? '1' : '0');
      }
    } catch (_) {}
  }

  /**
   * Arm auto-wake on first user interaction when saved preference is enabled.
   * Browsers block mic access before a user gesture; attaching to the first
   * pointerdown/keydown turns Wake Listening on seamlessly on first click.
   */
  async armAutoStartOnGesture(scope = typeof window !== 'undefined' ? window : null) {
    if (this.session?.isActive) return false;
    if (!StemVoiceSession.isSupported(scope || undefined)) return false;

    // Strictly opt-in: only arm wake-on-gesture when wakeEnabled is explicitly turned on.
    if (!this.wakeEnabled || this.session?.isActive) return false;

    this.autoWakePendingGesture = true;
    this._notify();

    if (!scope || typeof scope.addEventListener !== 'function' || this._gestureHandler) {
      return true;
    }

    this._gestureHandler = () => {
      this._clearGestureListener(scope);
      this.autoWakePendingGesture = false;
      if (this.wakeEnabled && !this.session.isActive) {
        this.startWakeMode({ persist: false, silentError: true });
      } else {
        this._notify();
      }
    };

    scope.addEventListener('pointerdown', this._gestureHandler, { once: true, passive: true });
    scope.addEventListener('keydown', this._gestureHandler, { once: true, passive: true });
    return true;
  }

  _clearGestureListener(scope = typeof window !== 'undefined' ? window : null) {
    if (!this._gestureHandler || !scope || typeof scope.removeEventListener !== 'function') return;
    scope.removeEventListener('pointerdown', this._gestureHandler);
    scope.removeEventListener('keydown', this._gestureHandler);
    this._gestureHandler = null;
  }

  /**
   * Tự động bật nghe lệnh gọi trong thao tác mở Copilot / STEM (chỉ khi người dùng đã bật Wake Mode trước đó).
   */
  maybeAutoStartOnAssistantOpen(scope = typeof window !== 'undefined' ? window : null) {
    if (!this.wakeEnabled) return false;
    if (this.session?.isActive || this._autoOpenedOnce) return false;
    if (!StemVoiceSession.isSupported(scope || undefined)) return false;
    if (scope?.navigator?.webdriver) return false;
    try {
      if (typeof localStorage !== 'undefined' && localStorage.getItem(VOICE_WAKE_STORAGE_KEY) === '0') {
        return false;
      }
    } catch (_) {}
    this._autoOpenedOnce = true;
    return this.startWakeMode({ persist: false, silentError: true });
  }

  startWakeMode({ persist = true, silentError = false } = {}) {
    this._clearGestureListener();
    this.autoWakePendingGesture = false;
    this.mode = 'wake';
    if (persist) {
      this.wakeEnabled = true;
      this._saveWakePreference(true);
    }
    this._silentNextError = Boolean(silentError);
    // Do NOT lock StemVoiceSession wakeWords here because we route both wake phrases & active window + quick commands cleanly in _handleSubmit!
    this.session.setWakeWords([]);
    const ok = this.session.start();
    if (!ok) {
      this.mode = 'off';
    }
    this._notify();
    return ok;
  }

  stopAll({ persistWakeOff = false } = {}) {
    this._clearGestureListener();
    this.autoWakePendingGesture = false;
    this.mode = 'off';
    this.lastTranscript = '';
    if (persistWakeOff) {
      this.wakeEnabled = false;
      this._saveWakePreference(false);
    }
    this.session.stop();
    this._notify();
    return false;
  }

  toggleWakeMode() {
    if (this.mode === 'wake' && this.session.isActive) {
      this.stopAll({ persistWakeOff: true });
      return false;
    }
    return this.startWakeMode({ persist: true, silentError: false });
  }

  startDirectMode(target = 'stem') {
    this._clearGestureListener();
    this.autoWakePendingGesture = false;
    this.activeTarget = target === 'copilot' ? 'copilot' : 'stem';
    this.mode = this.activeTarget;
    this.session.setWakeWords([]);
    this.session.touchAwakeWindow(this.session.activeWindowMs || 25000);
    const ok = this.session.start();
    if (!ok) {
      this.mode = 'off';
    }
    this._notify();
    return ok;
  }

  toggleDirectMode(target = 'stem') {
    const cleanTarget = target === 'copilot' ? 'copilot' : 'stem';
    if (this.session.isActive && this.mode === cleanTarget) {
      if (this.wakeEnabled) {
        return this.startWakeMode({ persist: false, silentError: false });
      }
      this.stopAll({ persistWakeOff: false });
      return false;
    }
    return this.startDirectMode(cleanTarget);
  }

  pauseVoice() {
    const ok = Boolean(this.session?.pause?.());
    this._notify();
    return ok;
  }

  resumeVoice() {
    const ok = Boolean(this.session?.resume?.());
    this._notify();
    return ok;
  }

  togglePauseVoice() {
    if (!this.session?.isActive) return false;
    return this.session.isPaused ? this.resumeVoice() : this.pauseVoice();
  }

  notifyAssistantSpeaking(spokenText = '') {
    this.session.notifyAssistantSpeaking(spokenText);
    this._notify();
  }

  notifyAssistantIdle() {
    this.session.notifyAssistantIdle();
    this._notify();
  }

  _handleTranscript(payload) {
    this.lastTranscript = payload?.text || '';
    this._handlers.onTranscript?.({ ...payload, mode: this.mode, activeTarget: this.activeTarget });
    this._notify();
  }

  _handleBargeIn(payload) {
    this._handlers.onBargeIn?.({ ...payload, mode: this.mode, activeTarget: this.activeTarget });
    this._notify();
  }

  _handleError(err) {
    const isSilentStartupErr = this._silentNextError && (
      err?.code === 'E_MIC_DENIED' ||
      err?.code === 'E_AUDIO_CAPTURE' ||
      err?.code === 'E_NETWORK'
    );
    if (isSilentStartupErr) {
      this._silentNextError = false;
      this.mode = 'off';
      this.autoWakePendingGesture = false;
      this._notify();
      return;
    }
    this._silentNextError = false;
    if (err?.code === 'E_MIC_DENIED' || err?.code === 'E_UNSUPPORTED' || err?.code === 'E_AUDIO_CAPTURE' || err?.code === 'E_NETWORK') {
      this.mode = 'off';
      if (err?.code === 'E_MIC_DENIED' || err?.code === 'E_UNSUPPORTED') {
        this.wakeEnabled = false;
        this._saveWakePreference(false);
      }
    }
    this._handlers.onError?.(err);
    this._notify();
  }

  async _handleSubmit({ text, raw } = {}) {
    this._silentNextError = false;
    const isWakeMode = this.mode === 'wake';
    const decision = routeVoiceUtterance(raw || text, {
      requireWakeWord: isWakeMode,
      activeTarget: this.activeTarget,
      inActiveWindow: this.session.isAwakeWindowActive()
    });

    if (decision.target === 'ignore') {
      return;
    }

    if (decision.target === 'command') {
      if (decision.preferredAssistant) {
        this.activeTarget = decision.preferredAssistant;
      }
      this.session.touchAwakeWindow();
      await this._handlers.onCommand?.(decision);
      this._notify();
      return;
    }

    if (decision.target === 'copilot') {
      this.activeTarget = 'copilot';
      this.session.touchAwakeWindow();
      if (decision.wakeOnly) {
        await this._handlers.onCopilotWakeOnly?.(decision);
      } else {
        await this._handlers.onCopilotQuery?.(decision);
      }
      this._notify();
      return;
    }

    if (decision.target === 'stem') {
      this.activeTarget = 'stem';
      this.session.touchAwakeWindow();
      if (decision.wakeOnly) {
        await this._handlers.onStemWakeOnly?.(decision);
      } else {
        await this._handlers.onStemQuery?.(decision);
      }
      this._notify();
    }
  }
}

export function getSharedVoiceCoordinator(options = {}) {
  const scope = typeof window !== 'undefined' ? window : globalThis;
  if (!scope.__wbsVoiceCoordinator) {
    scope.__wbsVoiceCoordinator = new VoiceWakeCoordinator(options);
  }
  return scope.__wbsVoiceCoordinator;
}
