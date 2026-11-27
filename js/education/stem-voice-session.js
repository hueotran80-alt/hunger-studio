/**
 * STEM Mode — Live Voice Session (hands-free 1:1 tutor loop).
 *
 * Vòng đời: listening -> thinking -> speaking -> listening (lặp liên tục).
 * Khác với mic một-lần của AI Copilot:
 *  - Nghe liên tục (continuous) và tự khởi động lại sau mỗi câu.
 *  - Tự gửi câu hỏi sau một khoảng lặng (silenceMs) — không cần bấm nút.
 *  - Barge-in: người học nói khi giáo viên đang giảng thì TTS dừng ngay
 *    (callback onBargeIn) và phiên quay lại trạng thái nghe.
 *  - Wake word tuỳ chọn ("thầy ơi"): câu không chứa wake word bị bỏ qua,
 *    wake word bị cắt khỏi câu gửi đi.
 *
 * Module thuần (không phụ thuộc DOM), nhận recognitionFactory + timer injection
 * để test được trong Node mà không cần trình duyệt.
 */

export const VOICE_SESSION_STATES = Object.freeze([
  'idle',
  'listening',
  'thinking',
  'speaking',
  'error'
]);

const EXPLICIT_WAKE_RE = /\b(?:thầy\s*ơi|cô\s*ơi|copilot\s*ơi|trợ\s*lý\s*ơi)\b/i;
const EXPLICIT_RESUME_RE = /\b(?:tiếp\s*tục|nói\s*tiếp|giảng\s*tiếp|làm\s*tiếp|hướng\s*dẫn\s*tiếp|chạy\s*tiếp|resume|continue)\b/i;
const EXPLICIT_INTERRUPT_RE = /\b(?:khoan|đợi\s*(?:chút|tí)|chờ\s*chút|dừng|ngừng|ngưng|thôi|tạm\s*(?:dừng|nghỉ|ngưng)|nghỉ\s*chút|im\s*(?:lặng|chút)|stop|pause)\b/i;
// STT có thể nghe “xem lại” thành “quay lại”; chặn nhóm điều hướng khi loa vừa đọc.
const NAVIGATION_ECHO_RE = /\b(?:quay\s*lại|lùi\s*lại|trở\s*lại|bước\s*trước|xem\s*lại|trước|bước\s*tiếp\s*theo|tiếp\s*theo|sang\s*bước\s*sau|tiếp)\b/i;

export class StemVoiceSession {
  constructor(options = {}) {
    this.lang = options.lang || 'vi-VN';
    this.continuous = options.continuous !== false;
    this.silenceMs = Number.isFinite(options.silenceMs) ? Math.max(0, options.silenceMs) : 950;
    this.restartDelayMs = Number.isFinite(options.restartDelayMs) ? Math.max(0, options.restartDelayMs) : 250;
    this.echoGuardMs = Number.isFinite(options.echoGuardMs) ? Math.max(0, options.echoGuardMs) : 1350;
    this.minChars = Number.isFinite(options.minChars) ? Math.max(1, options.minChars) : 2;
    this.maxChars = Number.isFinite(options.maxChars) ? Math.max(8, options.maxChars) : 400;
    this.activeWindowMs = Number.isFinite(options.activeWindowMs) ? Math.max(0, options.activeWindowMs) : 0;
    this.setWakeWords(options.wakeWords !== undefined ? options.wakeWords : options.wakeWord);

    this.recognitionFactory =
      typeof options.recognitionFactory === 'function'
        ? options.recognitionFactory
        : (lang) => {
            const scope = typeof window !== 'undefined' ? window : null;
            const Ctor = scope && (scope.SpeechRecognition || scope.webkitSpeechRecognition);
            if (!Ctor) return null;
            const recognition = new Ctor();
            recognition.lang = lang;
            recognition.continuous = true;
            recognition.interimResults = true;
            recognition.maxAlternatives = 1;
            return recognition;
          };

    const scope = typeof globalThis !== 'undefined' ? globalThis : {};
    this.setTimeout = options.setTimeout || scope.setTimeout.bind(scope);
    this.clearTimeout = options.clearTimeout || scope.clearTimeout.bind(scope);

    this.onTranscript = typeof options.onTranscript === 'function' ? options.onTranscript : null;
    this.onSubmit = typeof options.onSubmit === 'function' ? options.onSubmit : null;
    this.onWakeOnly = typeof options.onWakeOnly === 'function' ? options.onWakeOnly : null;
    this.onStateChange = typeof options.onStateChange === 'function' ? options.onStateChange : null;
    this.onBargeIn = typeof options.onBargeIn === 'function' ? options.onBargeIn : null;
    this.onError = typeof options.onError === 'function' ? options.onError : null;

    this.state = 'idle';
    this.isActive = false;
    this.isPaused = false;
    this.recognition = null;
    this.transcript = '';
    this.lastSubmitted = '';
    this.submitCount = 0;
    this.bargeInCount = 0;

    this._submitTimer = null;
    this._restartTimer = null;
    this._bargeInSent = false;
    this._awakeUntil = 0;
    this._assistantSpeechNormalized = '';
    this._echoGuardUntil = 0;
    this._consecutiveNetErrors = 0;
  }

  /** Cập nhật danh sách từ khóa đánh thức (wake words). */
  setWakeWords(wakeInput) {
    const list = Array.isArray(wakeInput)
      ? wakeInput
      : (typeof wakeInput === 'string' && wakeInput.trim() ? [wakeInput] : []);
    this.wakeWords = [...new Set(
      list.map((w) => String(w || '').trim().toLowerCase()).filter(Boolean)
    )].sort((a, b) => b.length - a.length);
    this.wakeWord = this.wakeWords[0] || '';
    return this.wakeWords;
  }

  /** Kiểm tra cửa sổ hội thoại chủ động sau khi đã gọi wake word. */
  isAwakeWindowActive(now = Date.now()) {
    return this.activeWindowMs > 0 && this._awakeUntil > now;
  }

  /** Kéo dài cửa sổ hội thoại không cần lặp lại wake word. */
  touchAwakeWindow(durationMs = this.activeWindowMs) {
    const dur = Number.isFinite(durationMs) ? Math.max(0, durationMs) : 0;
    this._awakeUntil = dur > 0 ? Date.now() + dur : 0;
  }

  /** Web Speech API chỉ có ở trình duyệt hỗ trợ (Chrome/Edge/Safari mới). */
  static isSupported(scope = typeof window !== 'undefined' ? window : globalThis) {
    return Boolean(scope && (scope.SpeechRecognition || scope.webkitSpeechRecognition));
  }

  get isListening() {
    return this.isActive && !this.isPaused && this.state === 'listening';
  }

  _setState(next) {
    if (!VOICE_SESSION_STATES.includes(next) || next === this.state) return;
    this.state = next;
    if (this.onStateChange) {
      try {
        this.onStateChange(next);
      } catch (_) {}
    }
  }

  _ensureRecognition() {
    if (this.recognition) return this.recognition;
    let recognition = null;
    try {
      recognition = this.recognitionFactory(this.lang);
    } catch (err) {
      recognition = null;
    }
    if (!recognition) return null;

    recognition.lang = recognition.lang || this.lang;
    recognition.continuous = this.continuous;
    recognition.interimResults = true;

    recognition.onstart = () => {
      this._consecutiveNetErrors = 0;
      if (this.isActive && !this.isPaused && this.state !== 'speaking') this._setState('listening');
    };
    recognition.onresult = (event) => this._handleResult(event);
    recognition.onerror = (event) => this._handleError(event);
    recognition.onend = () => this._handleEnd();

    this.recognition = recognition;
    return recognition;
  }

  /** Bắt đầu phiên rảnh tay. Trả về false nếu trình duyệt không hỗ trợ. */
  start() {
    if (this.isActive) {
      if (this.isPaused) return this.resume();
      return true;
    }
    const recognition = this._ensureRecognition();
    if (!recognition) {
      this._setState('error');
      this._emitError({
        code: 'E_UNSUPPORTED',
        message:
          'Trình duyệt này không hỗ trợ Web Speech API. Hãy dùng Chrome hoặc Microsoft Edge để nói chuyện trực tiếp với giáo viên.'
      });
      return false;
    }

    this.isActive = true;
    this.isPaused = false;
    this.transcript = '';
    this._bargeInSent = false;
    this._clearSubmitTimer();
    this._setState('listening');
    this._startRecognition();
    return true;
  }

  pause() {
    if (!this.isActive || this.isPaused) return false;
    this.isPaused = true;
    this.transcript = '';
    this._clearSubmitTimer();
    this._clearRestartTimer();
    try {
      this.recognition?.abort?.();
    } catch (_) {}
    if (this.state === 'speaking') {
      this._setState('listening');
    } else if (this.onStateChange) {
      try { this.onStateChange(this.state); } catch (_) {}
    }
    this._emitTranscript({ text: '', isFinal: false, final: false });
    return true;
  }

  resume() {
    if (!this.isActive || !this.isPaused) return false;
    this.isPaused = false;
    this.transcript = '';
    this._clearSubmitTimer();
    this._setState('listening');
    if (this.onStateChange) {
      try { this.onStateChange(this.state); } catch (_) {}
    }
    this._startRecognition();
    return true;
  }

  stop() {
    this.isActive = false;
    this.isPaused = false;
    this.transcript = '';
    this._clearSubmitTimer();
    this._clearRestartTimer();
    try {
      this.recognition?.abort?.();
    } catch (_) {}
    this._setState('idle');
    this._emitTranscript({ text: '', isFinal: false, final: false });
    return true;
  }

  destroy() {
    this.stop();
    this.recognition = null;
  }

  /** TTS bắt đầu đọc: vào trạng thái speaking để bắt barge-in. */
  notifyAssistantSpeaking(spokenText = '') {
    if (!this.isActive || this.isPaused) return;
    this._bargeInSent = false;
    this._clearSubmitTimer();
    this.transcript = '';
    this._assistantSpeechNormalized = String(spokenText || '')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    this._echoGuardUntil = Date.now() + this.echoGuardMs;
    this._setState('speaking');
  }

  /** TTS đọc xong/bị dừng: quay lại nghe. */
  notifyAssistantIdle() {
    this._echoGuardUntil = Date.now() + this.echoGuardMs;
    this._clearSubmitTimer();
    this.transcript = '';
    if (!this.isActive || this.isPaused) return;
    if (this.state === 'speaking' || this.state === 'thinking') {
      this._setState('listening');
      this._ensureRecognitionRunning();
    }
  }

  // ---------------------------------------------------------------------------
  // Nội bộ
  // ---------------------------------------------------------------------------

  _startRecognition() {
    try {
      this.recognition?.start?.();
    } catch (err) {
      const name = String(err?.name || '');
      if (name === 'NotAllowedError' || name === 'SecurityError') {
        this._emitError({
          code: 'E_MIC_DENIED',
          message: 'Trình duyệt chưa được cấp quyền micro. Hãy cho phép micro rồi bật lại.'
        });
        this.stop();
      }
      // Chrome ném InvalidStateError nếu recognition đã chạy — bỏ qua.
    }
  }

  _ensureRecognitionRunning() {
    if (!this.isActive || this.isPaused) return;
    try {
      this.recognition?.start?.();
    } catch (_) {}
  }

  _isLikelyAssistantEcho(text) {
    if (!this._assistantSpeechNormalized) return false;
    const withinGuard = this.state === 'speaking' || Date.now() < this._echoGuardUntil;
    if (!withinGuard) return false;
    const clean = String(text || '')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!clean) return true;
    if (EXPLICIT_WAKE_RE.test(clean) && !this._assistantSpeechNormalized.includes(clean)) return false;
    if (EXPLICIT_RESUME_RE.test(clean) && !this._assistantSpeechNormalized.includes(clean)) return false;
    if (NAVIGATION_ECHO_RE.test(clean) && NAVIGATION_ECHO_RE.test(this._assistantSpeechNormalized)) {
      return true;
    }
    // Cho phép từ khóa ngắt lời tường minh của người dùng luôn đi qua.
    if (EXPLICIT_INTERRUPT_RE.test(clean)) return false;
    if (clean.length >= 6 && this._assistantSpeechNormalized.includes(clean)) {
      return true;
    }
    const tokens = clean.split(' ').filter((w) => w.length >= 2);
    if (tokens.length >= 2) {
      const hits = tokens.filter((w) => this._assistantSpeechNormalized.includes(w)).length;
      if (hits / tokens.length >= 0.65) return true;
    }
    return false;
  }

  _clearSubmitTimer() {
    if (this._submitTimer) {
      this.clearTimeout(this._submitTimer);
      this._submitTimer = null;
    }
  }

  _clearRestartTimer() {
    if (this._restartTimer) {
      this.clearTimeout(this._restartTimer);
      this._restartTimer = null;
    }
  }

  _emitTranscript(payload) {
    if (!this.onTranscript) return;
    try {
      this.onTranscript(payload);
    } catch (_) {}
  }

  _emitError(payload) {
    if (!this.onError) return;
    try {
      this.onError(payload);
    } catch (_) {}
  }

  _handleResult(event) {
    if (!this.isActive || this.isPaused) return;
    if (!event || !event.results) return;

    let finalText = '';
    let interimText = '';
    const start = Number.isInteger(event.resultIndex) ? event.resultIndex : 0;
    for (let i = start; i < event.results.length; i += 1) {
      const result = event.results[i];
      const alternative = result && result[0];
      const text = alternative && alternative.transcript ? String(alternative.transcript) : '';
      if (!text) continue;
      if (result.isFinal) finalText += text;
      else interimText += text;
    }

    const spokenSoFar = (interimText || finalText).trim();
    if (!spokenSoFar) return;
    this._consecutiveNetErrors = 0;

    // Chặn tiếng vọng từ loa AI quay lại micro khi đang giảng.
    if (this._isLikelyAssistantEcho(spokenSoFar)) {
      return;
    }

    // Barge-in: người học nói trong lúc giáo viên đang giảng.
    if (spokenSoFar && this.state === 'speaking' && !this._bargeInSent) {
      this._bargeInSent = true;
      this.bargeInCount += 1;
      this._setState('listening');
      if (this.onBargeIn) {
        try {
          this.onBargeIn({ text: spokenSoFar });
        } catch (_) {}
      }
    }

    if (finalText.trim()) {
      this.transcript = `${this.transcript} ${finalText}`.trim();
    }

    const shown = [this.transcript, interimText].filter(Boolean).join(' ').trim();
    this._emitTranscript({
      text: shown,
      isFinal: Boolean(finalText.trim()),
      final: Boolean(finalText.trim())
    });

    if (finalText.trim()) {
      this._scheduleSubmit();
    } else if (interimText.trim() && this._submitTimer) {
      // Người học vẫn đang nói dở -> lùi đồng hồ im lặng để không cắt ngang câu.
      this._scheduleSubmit();
    }
  }

  _scheduleSubmit() {
    this._clearSubmitTimer();
    this._submitTimer = this.setTimeout(() => {
      this._submitTimer = null;
      this._submit();
    }, this.silenceMs);
  }

  /**
   * Khớp danh sách wake word và trích phần lệnh phía sau.
   * Trả về { matched, wakeWord, query, wakeOnly }.
   */
  static matchWakePhrase(text, wakeWords = []) {
    const raw = String(text || '').trim();
    const list = (Array.isArray(wakeWords) ? wakeWords : [wakeWords])
      .map((w) => String(w || '').trim().toLowerCase())
      .filter(Boolean)
      .sort((a, b) => b.length - a.length);

    if (!list.length) {
      return { matched: false, wakeWord: '', query: raw, wakeOnly: false };
    }

    const normalized = raw.toLowerCase();
    for (const wake of list) {
      const idx = normalized.indexOf(wake);
      if (idx === -1) continue;
      // Kiểm tra ranh giới từ đơn giản để tránh khớp nhầm giữa một từ dài hơn.
      const prevChar = idx > 0 ? normalized[idx - 1] : ' ';
      const nextIdx = idx + wake.length;
      const nextChar = nextIdx < normalized.length ? normalized[nextIdx] : ' ';
      if (/[\p{L}\p{N}]/u.test(prevChar) || /[\p{L}\p{N}]/u.test(nextChar)) {
        continue;
      }
      const query = raw.slice(nextIdx).replace(/^[\s,.:;!?-]+/, '').trim();
      return {
        matched: true,
        wakeWord: wake,
        query,
        wakeOnly: query.length === 0
      };
    }

    return { matched: false, wakeWord: '', query: '', wakeOnly: false };
  }

  /** Cắt wake word; trả '' nếu câu không chứa wake word (khi bật wake word). */
  static extractQuery(text, wakeWord = '') {
    let query = String(text || '').trim();
    if (!wakeWord || (Array.isArray(wakeWord) && wakeWord.length === 0)) return query;
    const match = StemVoiceSession.matchWakePhrase(query, wakeWord);
    return match.matched ? match.query : '';
  }

  async _submit() {
    if (!this.isActive) return;
    const raw = this.transcript.trim();
    this.transcript = '';
    this._emitTranscript({ text: '', isFinal: true, final: true, submitted: true });

    if (!raw) {
      this._setState('listening');
      return;
    }

    const activeWakeList = this.wakeWords || [];
    let query = raw;
    let matchedWake = '';
    let fromActiveWindow = false;

    if (activeWakeList.length > 0) {
      const wakeMatch = StemVoiceSession.matchWakePhrase(raw, activeWakeList);
      if (wakeMatch.matched) {
        matchedWake = wakeMatch.wakeWord;
        query = wakeMatch.query;
        this.touchAwakeWindow();
        if (wakeMatch.wakeOnly) {
          if (this.onWakeOnly) {
            try {
              await this.onWakeOnly({ wakeWord: matchedWake, raw });
            } catch (err) {
              this._emitError({
                code: 'E_SUBMIT',
                message: err && err.message ? err.message : String(err),
                error: err
              });
            }
          }
          if (this.isActive) {
            this._setState('listening');
            this._ensureRecognitionRunning();
          }
          return;
        }
      } else if (this.isAwakeWindowActive()) {
        query = raw;
        fromActiveWindow = true;
        this.touchAwakeWindow();
      } else {
        // Câu không gọi từ khóa đánh thức: bỏ qua nhưng vẫn tiếp tục nghe.
        this._setState('listening');
        this._ensureRecognitionRunning();
        return;
      }
    }

    query = query.slice(0, this.maxChars).trim();
    if (query.length < this.minChars) {
      this._setState('listening');
      this._ensureRecognitionRunning();
      return;
    }

    this.lastSubmitted = query;
    this.submitCount += 1;
    this._setState('thinking');
    try {
      if (this.onSubmit) {
        await this.onSubmit({
          text: query,
          raw,
          wakeWord: matchedWake,
          fromActiveWindow
        });
      }
    } catch (err) {
      this._emitError({
        code: 'E_SUBMIT',
        message: err && err.message ? err.message : String(err),
        error: err
      });
    }
    if (this.isActive && this.state === 'thinking') {
      this._setState('listening');
      this._ensureRecognitionRunning();
    }
  }

  _handleError(event) {
    const code = event && event.error ? String(event.error) : 'unknown';
    // 'no-speech' / 'aborted' là chuyện bình thường trong chế độ nghe liên tục.
    if (code === 'no-speech' || code === 'aborted') return;

    if (code === 'not-allowed' || code === 'service-not-allowed') {
      this._emitError({
        code: 'E_MIC_DENIED',
        message: 'Trình duyệt chưa được cấp quyền micro. Hãy cho phép micro rồi bật lại chế độ nói chuyện.'
      });
      this.stop();
      return;
    }

    if (code === 'audio-capture') {
      this._emitError({
        code: 'E_AUDIO_CAPTURE',
        message: 'Không tìm thấy micro đang hoạt động trên thiết bị này. Hãy kiểm tra micro hoặc gõ lệnh trực tiếp.'
      });
      this.stop();
      return;
    }

    if (code === 'network') {
      this._consecutiveNetErrors += 1;
      if (this._consecutiveNetErrors < 2) return;
      this._emitError({
        code: 'E_NETWORK',
        message: 'Dịch vụ nhận giọng nói trình duyệt tạm không phản hồi (lỗi mạng Speech API). Đã tạm dừng micro để tránh lặp lỗi — bạn có thể bấm bật lại hoặc gõ trực tiếp.'
      });
      this.stop();
      return;
    }

    this._emitError({ code: `E_${code.toUpperCase()}`, message: `Lỗi nhận giọng nói: ${code}` });
  }

  _handleEnd() {
    if (!this.isActive || this.isPaused) return;
    if (!this.continuous) {
      this._setState('idle');
      return;
    }
    // Chrome tự kết thúc phiên sau vài giây im lặng — khởi động lại để giữ live.
    this._clearRestartTimer();
    this._restartTimer = this.setTimeout(() => {
      this._restartTimer = null;
      if (!this.isActive || this.isPaused) return;
      this._ensureRecognitionRunning();
      if (this.state !== 'speaking') this._setState('listening');
    }, this.restartDelayMs);
  }
}
