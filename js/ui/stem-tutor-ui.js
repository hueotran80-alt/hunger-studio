/**
 * Web Blender Studio — Giai đoạn 4.1 (Nâng cấp Toàn diện):
 * Giao diện Giáo trình Dựng hình 3D Thực chiến & Giáo viên AI Kèm 1-1 Không Chắn Giao diện
 *
 * Giải quyết triệt để 4 vấn đề cốt lõi:
 *  1. KHÔNG CHẮN GIAO DIỆN (Zero-Obstruction UI):
 *     - Con trỏ Giáo viên bay (#stem-avatar-host, 42x42px) tách rời hoàn toàn khỏi khung lời giảng,
 *       đặt ở rìa ngoài nút mục tiêu (diện tích đè lên nút = 0) và TỰ ĐỘNG NÉ CHUỘT (Cursor Evasion)
 *       khi chuột người dùng tiến lại gần trong bán kính 75px hoặc khi mở menu dropdown.
 *     - Thanh HUD Lời giảng & Hỏi AI (#stem-speech-bubble) neo gọn gàng ở sát mép dưới vùng trống
 *       khung nhìn 3D Viewport, có nút thu gọn thành viên thuốc (Pill) 1 dòng.
 *  2. MODEL AI CỦA NGƯỜI DÙNG ĐIỀU KHIỂN TRỰC TIẾP (askAICoach & executeAICommand):
 *     - Kết nối trực tiếp với `/api/ai/chat` (theo provider Motapis / Gemini / OpenAI đã cấu hình trong AICopilot)
 *       cùng dữ liệu hình học cảnh 3D thời gian thực (`inspectSceneGeometrySummary`).
 *     - Model AI có thể điều khiển con trỏ bay tới bất kỳ nút nào (`pointAt`), mở bảng (`openPanel`),
 *       chuyển chế độ (`setViewportMode`: Object/Edit/Sculpt), thực thi thao tác dựng mẫu (`demoCode`) và giảng giọng nói!
 *  3. GIỌNG NÓI TỰ NHIÊN & NHANH NHẸN (Neural TTS /api/tts + Pre-fetch Cache + Tốc độ 1.2x–1.4x):
 *     - Tự động tải trước (Pre-fetch) âm thanh các bước học để phát tức thì (< 10ms), tốc độ mặc định 1.2x
 *       (có nút chỉnh 1.0x / 1.2x / 1.4x ngay trên HUD).
 *  4. BÁM SÁT THỰC HÀNH DỰNG MÔ HÌNH 3D:
 *     - Tự động lắng nghe thao tác dựng hình thật của học viên trên Viewport (Add Mesh, Move/Scale,
 *       Edit Mode Tab, Extrude E, Inset I, Bevel B, Subdivide, Modifiers, Sculpt) và hiển thị thông số
 *       lưới đa giác trực tiếp (Số Đỉnh · Số Tam giác · Modifier · Chế độ).
 */

import {
  STEM_LESSONS,
  getStemLesson,
  gradeStemLesson,
  computeAvatarTargetPosition,
  inspectSceneGeometrySummary,
  TutorVoiceEngine
} from '../education/stem-curriculum.js';
import { getSharedVoiceCoordinator, routeVoiceUtterance } from '../ai/voice-wake-router.js';
import { stripThinkingTags } from '../ai/scene-digest.js';
import { escapeHtml } from '../core/escape-html.js';
import {
  scanGeneratedCode,
  describeViolations
} from '../ai/copilot-guard.js';
import { CopilotRuntime } from '../ai/copilot-runtime.js';
import {
  isEditableMesh,
  syncViewportModeOptions,
  switchViewportMode
} from '../core/mode-resolver.js';

const STORAGE_KEY = 'wbs_stem_progress_v1';

export class StemTutorUI {
  constructor(app = {}) {
    this.app = app;
    this.lessons = STEM_LESSONS;
    this.activeLesson = STEM_LESSONS[0];
    this.activeStepIndex = 0;
    this.levelFilter = 'all';
    this.lastGradeReport = null;
    this.progress = this._loadProgress();

    this.avatarPosition = {
      x: 0,
      y: 0,
      pointerDirection: 'none',
      bubbleSide: 'left',
      overlapsTarget: false
    };
    this.bubbleOpen = false;
    this.hudMinimized = false;
    this._targetEl = null;
    this._targetSelector = null;
    this._isDragging = false;
    this._dragMoved = false;
    this._lastCursorPos = { x: -999, y: -999 };
    this._aiCoachBusy = false;
    this._coachRequestToken = 0;
    this._coachAbortController = null;
    this._lastExecutedCode = '';
    this._stepDone = new Set();
    this._usedAutoDemoLessons = new Set();
    this.guidedActive = false;

    // Multi-step walkthrough state (không dừng ngang sau bước 1)
    this._walkthroughToken = 0;
    this._walkTimer = null;
    this._speechWaitResolver = null;
    this.isAutoWalking = false;
    this._pausedState = null;
    this.guidedSequence = null; // [{ title, speech, pointAt, ... }] khi đang hướng dẫn AI
    this.guidedSequenceIndex = 0;
    this.guidedSequenceTitle = '';

    this.voice = new TutorVoiceEngine({
      enabled: true,
      lang: 'vi-VN',
      rate: 1.2,
      onStateChange: (state) => this._onVoiceStateChange(state)
    });

    this.micBtn = null;
    this.micPauseBtn = null;
    this.wakeBtn = null;
    this.voiceCoordinator = getSharedVoiceCoordinator({ lang: 'vi-VN' });
    this.voiceSession = this.voiceCoordinator.session;
    this._unsubscribeVoice = this.voiceCoordinator.subscribe(() => {
      this._onVoiceSessionState(this.voiceSession?.state);
    });
    this.voiceCoordinator.setHandlers({
      onTranscript: (payload) => this._onVoiceTranscript(payload),
      onStemQuery: (decision) => this._onVoiceSubmit({ text: decision.query, raw: decision.raw }),
      onStemWakeOnly: () => this._onStemWakeOnly(),
      onCommand: (decision) => this._handleVoiceCommand(decision),
      onBargeIn: (payload) => this._onVoiceBargeIn(payload),
      onError: (payload) => this._onVoiceSessionError(payload)
    });

    this._voicesPrefetched = false;
    this.init();
    if (typeof window !== 'undefined' && this.voiceCoordinator?.wakeEnabled) {
      this.voiceCoordinator.armAutoStartOnGesture(window);
    }
  }

  onShow() {
    if (!this._voicesPrefetched) {
      this._voicesPrefetched = true;
      this._prefetchLessonVoices(this.activeLesson);
    }
  }

  init() {
    this._injectStyles();
    this._mountFloatingAvatar();
    this._mountDockPanel();
    this._bindHeaderTrigger();
    this._bindLiveModelingTrackers();
    this._bindVoiceSession();
    this.parkAvatar();
  }

  // ===========================================================================
  // PRE-FETCH GIỌNG NÓI CHO TOÀN BỘ BÀI HỌC ĐỂ PHÁT TỨC THÌ (0 ĐỘ TRỄ)
  // ===========================================================================

  _prefetchLessonVoices(lesson) {
    if (!lesson || !Array.isArray(lesson.steps)) return;
    for (const step of lesson.steps) {
      if (step?.voiceText) {
        this.voice.prefetch(step.voiceText);
      }
    }
  }

  // ===========================================================================
  // TIẾN ĐỘ HỌC TẬP (LOCAL STORAGE)
  // ===========================================================================

  _loadProgress() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
          return {
            completed: parsed.completed || {},
            bestScores: parsed.bestScores || {},
            totalXp: Number(parsed.totalXp) || 0
          };
        }
      }
    } catch (_) {}
    return { completed: {}, bestScores: {}, totalXp: 0 };
  }

  _saveProgress() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.progress));
    } catch (_) {}
  }

  _recordGrade(report) {
    if (!report) return;
    const prevBest = this.progress.bestScores[report.lessonId] || 0;
    if (report.score > prevBest) {
      this.progress.bestScores[report.lessonId] = report.score;
    }
    if (report.passed) {
      this.progress.completed[report.lessonId] = true;
    }
    let totalXp = 0;
    for (const lesson of this.lessons) {
      const best = this.progress.bestScores[lesson.id] || 0;
      if (best >= 70) {
        totalXp += Math.round(lesson.xp * (best / 100));
      }
    }
    this.progress.totalXp = totalXp;
    this._saveProgress();
  }

  // ===========================================================================
  // ĐIỀU KHIỂN CON TRỎ GIÁO VIÊN KHÔNG CHẮN GIAO DIỆN & GIỌNG NÓI 1-1
  // ===========================================================================

  /**
   * Đưa Icon Giáo viên về góc trực ban gọn gàng (góc trên bên phải khung nhìn 3D, không đè lên bảng hay menu).
   */
  parkAvatar() {
    const vw = typeof window !== 'undefined' ? window.innerWidth : 1280;
    const vh = typeof window !== 'undefined' ? window.innerHeight : 800;
    const pos = computeAvatarTargetPosition(null, { width: vw, height: vh }, 44);
    this._clearTargetBeacon();
    this._targetSelector = null;
    this.setAvatarPosition(pos.x, pos.y, { pointerDirection: 'none', bubbleSide: pos.bubbleSide });
    return this.avatarPosition;
  }

  /**
   * Đặt tọa độ (x, y) trực tiếp cho Con trỏ Giáo viên trên màn hình.
   */
  setAvatarPosition(x, y, opts = {}) {
    const vw = typeof window !== 'undefined' ? window.innerWidth : 1280;
    const vh = typeof window !== 'undefined' ? window.innerHeight : 800;
    const clampedX = Math.round(Math.max(10, Math.min(vw - 54, Number(x) || 0)));
    const clampedY = Math.round(Math.max(36, Math.min(vh - 54, Number(y) || 0)));
    const bubbleSide = opts.bubbleSide || (clampedX > vw - 390 ? 'left' : 'right');
    const pointerDirection = opts.pointerDirection || 'none';

    this.avatarPosition = {
      x: clampedX,
      y: clampedY,
      pointerDirection,
      bubbleSide,
      targetSelector: opts.targetSelector !== undefined ? opts.targetSelector : this._targetSelector,
      overlapsTarget: !!opts.overlapsTarget
    };

    if (this.avatarHost) {
      this.avatarHost.style.transform = `translate3d(${clampedX}px, ${clampedY}px, 0)`;
      this.avatarHost.dataset.pointer = pointerDirection;
      this.avatarHost.dataset.bubbleSide = bubbleSide;
      // Khi đang chỉ vào một nút điều khiển, cho phép click xuyên qua (pointer-events: none) để không bao giờ chắn chuột!
      this.avatarHost.classList.toggle('pass-through', pointerDirection !== 'none' && !this._isDragging);
    }
    return this.avatarPosition;
  }

  /**
   * Cho Con trỏ Giáo viên bay mượt mà tới một phần tử UI trên màn hình (theo CSS selector hoặc data-agent-id)
   * kèm hiệu ứng vòng sáng chỉ điểm (Target Beacon), đảm bảo KHÔNG ĐÈ LÊN NÚT.
   */
  moveToTarget(selectorOrId, opts = {}) {
    if (typeof document === 'undefined') {
      if (opts.speechText) {
        this.setBubbleContent({
          title: opts.title || this.activeLesson?.title || 'AI Tutor 1-1',
          stepBadge: opts.stepBadge || '',
          text: opts.speechText
        });
        if (opts.speak !== false) {
          this.speak(opts.speechText);
        }
      }
      return { ...this.avatarPosition, found: false, targetSelector: selectorOrId || null };
    }
    let el = null;
    if (typeof selectorOrId === 'string' && selectorOrId.trim()) {
      const rawSel = selectorOrId.trim();
      try {
        el = document.querySelector(rawSel);
      } catch (_) {}
      if (!el) {
        const cleanId = rawSel.replace(/^#/, '');
        el = document.getElementById(cleanId) ||
          document.querySelector(`[data-agent-id="${CSS.escape(cleanId)}"]`);
      }
      // If target lives inside a collapsed dock pane or closed property tab, expand it automatically
      if (el) {
        const dockPane = el.closest?.('[id^="dock-"]');
        if (dockPane?.id) {
          document.querySelector(`.dock-tab[data-pane="${CSS.escape(dockPane.id)}"]`)?.click?.();
        }
        const propTabPane = el.closest?.('[data-tab-pane]');
        if (propTabPane?.dataset?.tabPane) {
          document.querySelector(`.prop-tab-btn[data-tab="${CSS.escape(propTabPane.dataset.tabPane)}"]`)?.click?.();
        }
      }
    } else if (selectorOrId && selectorOrId.nodeType === 1) {
      el = selectorOrId;
    }

    let visibleEl = el;
    while (visibleEl && visibleEl !== document.body) {
      const rect = visibleEl.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) break;
      visibleEl = visibleEl.parentElement;
    }

    const vw = window.innerWidth || 1280;
    const vh = window.innerHeight || 800;

    if (!visibleEl || visibleEl === document.body) {
      const parked = this.parkAvatar();
      if (opts.speechText) {
        if (opts.openBubble !== false) this.setBubbleOpen(true);
        this.setBubbleContent({
          title: opts.title || this.activeLesson?.title || 'AI Tutor 1-1',
          stepBadge: opts.stepBadge || '',
          text: opts.speechText
        });
        if (opts.speak !== false) this.speak(opts.speechText);
      }
      return parked;
    }

    const rect = visibleEl.getBoundingClientRect();
    this._targetSelector = typeof selectorOrId === 'string' ? selectorOrId : (visibleEl.id ? `#${visibleEl.id}` : null);
    let pos;
    if (visibleEl.id === 'viewport-canvas-host' || (rect.width > vw * 0.55 && rect.height > vh * 0.45)) {
      pos = {
        x: Math.round(Math.max(12, Math.min(vw - 60, rect.left + 22))),
        y: Math.round(Math.max(48, Math.min(vh - 60, rect.top + 18))),
        pointerDirection: 'down',
        bubbleSide: 'right',
        overlapsTarget: false
      };
    } else {
      pos = computeAvatarTargetPosition(rect, { width: vw, height: vh }, 44, this._lastCursorPos);
    }
    this.setAvatarPosition(pos.x, pos.y, {
      pointerDirection: pos.pointerDirection,
      bubbleSide: pos.bubbleSide,
      targetSelector: this._targetSelector,
      overlapsTarget: pos.overlapsTarget
    });

    this._showTargetBeacon(visibleEl, rect);
    if (opts.openBubble !== false) {
      this.setBubbleOpen(true);
    }
    if (opts.speechText) {
      this.setBubbleContent({
        title: opts.title || this.activeLesson?.title || 'AI Tutor 1-1',
        stepBadge: opts.stepBadge || '',
        text: opts.speechText
      });
      if (opts.speak !== false) {
        this.speak(opts.speechText);
      }
    }

    return {
      ...this.avatarPosition,
      found: true,
      targetId: visibleEl.id || visibleEl.dataset?.agentId || visibleEl.tagName.toLowerCase()
    };
  }

  _showTargetBeacon(el, rect) {
    this._clearTargetBeacon();
    this._targetEl = el;
    el.classList.add('stem-tutor-target-highlight');
    if (this.beaconEl && rect) {
      // Nếu phần tử quá lớn (như cả khung Viewport), chỉ hiển thị viền nhẹ trong 2 giây rồi tắt để không vướng mắt
      const isLargeCanvas = rect.width > 360 && rect.height > 260;
      this.beaconEl.style.display = 'block';
      this.beaconEl.style.left = `${Math.round(rect.left - 3)}px`;
      this.beaconEl.style.top = `${Math.round(rect.top - 3)}px`;
      this.beaconEl.style.width = `${Math.round(rect.width + 6)}px`;
      this.beaconEl.style.height = `${Math.round(rect.height + 6)}px`;
      const timeoutMs = isLargeCanvas ? 1800 : 4500;
      this._beaconTimer = setTimeout(() => {
        if (this.beaconEl) this.beaconEl.style.display = 'none';
        if (this._targetEl) {
          this._targetEl.classList.remove('stem-tutor-target-highlight');
          this._targetEl = null;
        }
      }, timeoutMs);
    }
  }

  _clearTargetBeacon() {
    if (this._beaconTimer) {
      clearTimeout(this._beaconTimer);
      this._beaconTimer = null;
    }
    if (this.beaconEl) this.beaconEl.style.display = 'none';
    if (this._targetEl) {
      this._targetEl.classList.remove('stem-tutor-target-highlight');
      this._targetEl = null;
    }
  }

  /**
   * Phát giọng nói tiếng Việt tốc độ cao của Giáo viên kèm 1-1.
   */
  speak(text, opts = {}) {
    return this.voice.speak(text, opts);
  }

  stopSpeaking() {
    this.voice.stop();
    if (this._speechWaitResolver) {
      const resolve = this._speechWaitResolver;
      this._speechWaitResolver = null;
      resolve({ cancelled: true });
    }
  }

  _cancelPendingCoachRequest() {
    this._coachRequestToken += 1;
    this._aiCoachBusy = false;
    if (this._coachAbortController) {
      try { this._coachAbortController.abort(); } catch (_) {}
      this._coachAbortController = null;
    }
  }

  /**
   * Hủy chuỗi tự động dẫn từng bước hiện tại (không để bước cũ chạy đè).
   */
  stopWalkthrough({ stopVoice = true, keepPausedSnapshot = false } = {}) {
    this._walkthroughToken += 1;
    this.isAutoWalking = false;
    if (!keepPausedSnapshot) {
      this._pausedState = null;
    }
    if (this._walkTimer) {
      clearTimeout(this._walkTimer);
      this._walkTimer = null;
    }
    if (this._speechWaitResolver) {
      const resolve = this._speechWaitResolver;
      this._speechWaitResolver = null;
      resolve({ cancelled: true });
    }
    if (stopVoice) {
      this.voice.stop();
    }
    this._syncAutoWalkButtons();
  }

  /**
   * Tạm dừng hướng dẫn đúng ở bước hiện tại và giữ nguyên nội dung để học viên đọc / làm theo.
   */
  pauseWalkthrough() {
    this._cancelPendingCoachRequest();
    const kind = Array.isArray(this.guidedSequence) && this.guidedSequence.length > 0 ? 'guided' : 'lesson';
    const index = kind === 'guided' ? (this.guidedSequenceIndex || 0) : (this.activeStepIndex || 0);
    const hasSteps = kind === 'guided' || Boolean(this.activeLesson?.steps?.length);
    if (hasSteps) {
      this._pausedState = {
        kind,
        index,
        title: this.bubbleTitleEl?.textContent || this.guidedSequenceTitle || this.activeLesson?.title || 'Hướng dẫn 1-1',
        stepBadge: this.bubbleStepBadgeEl?.textContent || '',
        text: this.currentBubbleText || this.bubbleTextEl?.textContent || ''
      };
    }
    this.stopWalkthrough({ stopVoice: true, keepPausedSnapshot: true });
    if (this.bubbleStepBadgeEl) {
      this.bubbleStepBadgeEl.textContent = '⏸ Tạm dừng';
      this.bubbleStepBadgeEl.style.display = 'inline-flex';
    }
    this._syncAutoWalkButtons();
    return this._pausedState;
  }

  resumeWalkthrough({ speak = true } = {}) {
    const snap = this._pausedState;
    this._pausedState = null;
    if (this.voiceSession?.isActive && this.voiceSession?.isPaused) {
      this.voiceCoordinator?.resumeVoice?.();
    }
    if (snap?.kind === 'guided' && Array.isArray(this.guidedSequence) && this.guidedSequence.length > 0) {
      this.guideSteps(this.guidedSequence, {
        speak,
        autoAdvance: true,
        startIndex: snap.index,
        title: this.guidedSequenceTitle
      });
      return true;
    }
    if (this.activeLesson?.steps?.length) {
      const idx = Number.isInteger(snap?.index) ? snap.index : this.activeStepIndex;
      this.startLessonAutoWalk({ fromIndex: idx, speak });
      return true;
    }
    this._syncAutoWalkButtons();
    return false;
  }

  _syncAutoWalkButtons() {
    const isPaused = !this.isAutoWalking && Boolean(this._pausedState);
    const hudBtn = this.floatingRoot?.querySelector('#stem-bubble-autowalk');
    if (hudBtn) {
      hudBtn.textContent = this.isAutoWalking ? '⏸ Tạm dừng' : (isPaused ? '▶ Tiếp tục' : '▶ Tự chạy');
      hudBtn.classList.toggle('active', this.isAutoWalking || isPaused);
      hudBtn.title = this.isAutoWalking
        ? 'Tạm dừng đúng ở bước hiện tại (giữ nguyên lời giảng)'
        : (isPaused ? 'Tiếp tục hướng dẫn từ bước đang tạm dừng' : 'Tự động hướng dẫn lần lượt từ bước này tới hết');
    }
    const dockBtn = this.dockContainer?.querySelector('#stem-btn-autowalk');
    if (dockBtn) {
      dockBtn.textContent = this.isAutoWalking ? '⏸ Tạm dừng' : (isPaused ? '▶ Tiếp tục' : '▶ Dẫn hết bài');
      dockBtn.classList.toggle('active', this.isAutoWalking || isPaused);
    }
  }

  _sleepWalk(ms, token) {
    return new Promise((resolve) => {
      if (token !== this._walkthroughToken) {
        resolve(false);
        return;
      }
      this._walkTimer = setTimeout(() => {
        this._walkTimer = null;
        resolve(token === this._walkthroughToken);
      }, Math.max(0, ms));
    });
  }

  _speakAndWait(text, { speak = true, token } = {}) {
    const clean = TutorVoiceEngine.normalizeSpeechText(text);
    const shouldSpeak = speak && this.voice.enabled && clean.length > 0;
    const waitMs = shouldSpeak
      ? Math.max(2200, Math.min(20000, Math.round((clean.length * 68) / (this.voice.rate || 1.2))))
      : Math.max(1200, Math.min(3600, Math.round(clean.length * 24)));

    if (!shouldSpeak) {
      return this._sleepWalk(waitMs, token);
    }

    const minReadableMs = Math.max(1800, Math.min(4400, Math.round(clean.length * 36)));
    const startedAt = Date.now();

    return new Promise((resolve) => {
      if (token !== this._walkthroughToken) {
        resolve(false);
        return;
      }
      let settled = false;
      const done = (ok = true, status = null) => {
        if (settled) return;
        settled = true;
        if (this._walkTimer) {
          clearTimeout(this._walkTimer);
          this._walkTimer = null;
        }
        if (this._speechWaitResolver === onAbort) {
          this._speechWaitResolver = null;
        }
        if (status?.cancelled || !ok || token !== this._walkthroughToken) {
          resolve(false);
          return;
        }
        const elapsed = Date.now() - startedAt;
        if (status?.failed && elapsed < 400 && clean.length > 12) {
          const remaining = Math.max(200, minReadableMs - elapsed);
          this._sleepWalk(remaining, token).then((sleepOk) => resolve(sleepOk));
          return;
        }
        resolve(true);
      };
      const onAbort = () => done(false);
      this._speechWaitResolver = onAbort;

      const res = this.voice.speak(clean, {
        onEnd: (status) => done(true, status)
      });
      if (!res?.spoken) {
        this._walkTimer = setTimeout(() => done(true), waitMs);
        return;
      }
      this._walkTimer = setTimeout(() => done(true), waitMs + 1500);
    });
  }

  _ensureEditableMeshSelected(sm = null) {
    const mgr = sm || this.app?.sceneManager || (typeof window !== 'undefined' ? window.sceneManager : null);
    if (!mgr) return null;
    let active = mgr.getActiveObject?.();
    if (!isEditableMesh(active)) {
      const candidate = (mgr.getAllObjects?.() || []).find((o) => isEditableMesh(o));
      if (candidate && typeof mgr.select === 'function') {
        mgr.select(candidate, false);
        active = candidate;
      }
    }
    return isEditableMesh(active) ? active : null;
  }

  _switchModeSafely(wantedMode) {
    if (!wantedMode || typeof document === 'undefined') return false;
    const win = typeof window !== 'undefined' ? window : null;
    const sm = this.app?.sceneManager || win?.sceneManager || null;
    const editModeInst = this.app?.editMode || win?.editMode || null;
    const sculptModeInst = this.app?.sculptMode || win?.sculptMode || null;
    const paintModeInst = this.app?.paintMode || win?.paintMode || null;
    const rigInst = this.app?.rigSystem || win?.rigSystem || null;
    const modeSelect = document.getElementById('viewport-mode');
    if (wantedMode !== 'object' && sm) {
      const active = this._ensureEditableMeshSelected(sm);
      if (!active && !rigInst?.isRigObject?.(sm.getActiveObject?.())) return false;
      syncViewportModeOptions(sm.getActiveObject?.(), sm, rigInst);
    }
    if (modeSelect && modeSelect.value !== wantedMode) {
      if (editModeInst || sculptModeInst || paintModeInst) {
        return switchViewportMode(wantedMode, {
          sceneManager: sm,
          editMode: editModeInst,
          sculptMode: sculptModeInst,
          paintMode: paintModeInst,
          rigSystem: rigInst,
          modeSelect
        });
      }
      modeSelect.value = wantedMode;
      modeSelect.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }
    return false;
  }

  async _runSandboxedDemoCode(demoCode) {
    if (!demoCode || typeof demoCode !== 'string' || !demoCode.trim()) return false;
    const win = typeof window !== 'undefined' ? window : null;
    try {
      if (win?.aiCopilot && typeof win.aiCopilot.executeGeneratedCode === 'function') {
        return await win.aiCopilot.executeGeneratedCode(demoCode);
      }
      const guard = scanGeneratedCode(demoCode);
      if (!guard.ok) {
        console.warn('[StemTutorUI] Đã chặn demoCode không an toàn:', describeViolations(guard.violations));
        return false;
      }
      const studioInst = this.app?.studio || win?.studio || null;
      const sm = this.app?.sceneManager || win?.sceneManager || null;
      const engine = this.app?.engine || win?.engine || null;
      this._copilotRuntime?.stop();
      const runtime = new CopilotRuntime({
        sceneManager: sm,
        studio: studioInst,
        THREE: win?.THREE || studioInst?.THREE || null,
        camera: engine?.camera || win?.camera || null,
        engine,
        editMode: this.app?.editMode || win?.editMode || null,
        modifiers: win?.modifiers || win?.Modifiers || null,
        simulationManager: this.app?.simulationManager || win?.simulationManager || null,
        sculptMode: this.app?.sculptMode || win?.sculptMode || null,
        stemTutor: this,
        setViewportMode: (mode) => this._switchModeSafely(mode),
        setEditSelectionMode: (mode) => win?.editMode?.setMode?.(mode) || false,
      });
      this._copilotRuntime = runtime;
      const result = await runtime.execute(demoCode, {
        onLog: (entry) => {
          const message = entry.args.map((value) => typeof value === 'string' ? value : JSON.stringify(value)).join(' ');
          this.app?.codeEditor?.log?.(entry.level === 'error' ? 'error' : 'success', message);
          console.log('[STEM Demo]', message);
        },
      });
      result.resume();
      this._lastExecutedCode = demoCode;
      win?.dispatchEvent(new CustomEvent('blender:scene-updated'));
      return true;
    } catch (err) {
      console.warn('[StemTutorUI] Lỗi thực thi demoCode trong sandbox:', err);
      return false;
    }
  }

  setVoiceRate(rate) {
    const applied = this.voice.setRate(rate);
    this._syncVoiceButtons();
    return applied;
  }

  setVoiceEnabled(enabled) {
    const state = this.voice.setEnabled(enabled);
    this._syncVoiceButtons();
    return state;
  }

  toggleVoice() {
    const next = !this.voice.enabled;
    this.setVoiceEnabled(next);
    if (next && this.currentBubbleText) {
      this.speak(this.currentBubbleText);
    }
    return next;
  }

  setBubbleOpen(open) {
    this.bubbleOpen = !!open;
    if (this.bubbleEl) {
      this.bubbleEl.classList.toggle('open', this.bubbleOpen);
    }
  }

  setHudMinimized(minimized) {
    this.hudMinimized = !!minimized;
    if (this.bubbleEl) {
      this.bubbleEl.classList.toggle('minimized', this.hudMinimized);
    }
    const minBtn = this.floatingRoot?.querySelector('#stem-hud-minimize-btn');
    if (minBtn) {
      minBtn.textContent = this.hudMinimized ? '▢ Expand' : '— Collapse';
    }
    return this.hudMinimized;
  }

  setBubbleContent({ title, stepBadge, text, gradeBadge = null } = {}) {
    if (title !== undefined && this.bubbleTitleEl) {
      this.bubbleTitleEl.textContent = title;
    }
    if (stepBadge !== undefined && this.bubbleStepBadgeEl) {
      this.bubbleStepBadgeEl.textContent = stepBadge;
      this.bubbleStepBadgeEl.style.display = stepBadge ? 'inline-flex' : 'none';
    }
    if (text !== undefined && this.bubbleTextEl) {
      this.currentBubbleText = text;
      this.bubbleTextEl.textContent = text;
    }
    if (this.bubbleGradeBadgeEl) {
      if (gradeBadge) {
        this.bubbleGradeBadgeEl.textContent = gradeBadge.text;
        this.bubbleGradeBadgeEl.dataset.passed = gradeBadge.passed ? 'true' : 'false';
        this.bubbleGradeBadgeEl.style.display = 'inline-flex';
      } else {
        this.bubbleGradeBadgeEl.style.display = 'none';
      }
    }
  }

  // ===========================================================================
  // CẦU NỐI CHO PHÉP MODEL AI CỦA NGƯỜI DÙNG ĐIỀU KHIỂN TRỰC TIẾP GIAO DIỆN & TUTOR
  // ===========================================================================

  /**
   * Thực thi một lệnh điều khiển Giáo viên 1-1 từ Model AI của người dùng (AICopilot / MCP / studio.tutor).
   * @param {{
   *   speech?: string,
   *   title?: string,
   *   pointAt?: string,
   *   openPanel?: string,
   *   viewportMode?: 'object'|'edit'|'sculpt',
   *   editSelectionMode?: 'vertex'|'edge'|'face',
   *   clickSelector?: string,
   *   demoCode?: string,
   *   speak?: boolean
   * }} cmd
   */
  async executeAICommand(cmd = {}, opts = {}) {
    if (!cmd || typeof cmd !== 'object') return { ok: false, error: 'Invalid AI tutor command' };

    if (Array.isArray(cmd.steps) && cmd.steps.length > 0) {
      return await this.guideSteps(cmd.steps, {
        speak: opts.speak ?? (cmd.speak !== false),
        autoAdvance: opts.autoAdvance ?? cmd.autoAdvance,
        title: cmd.title,
        sourceBadge: opts.sourceBadge || cmd.sourceBadge || 'AI 1-1'
      });
    }

    if (!opts._keepWalkthrough) {
      this.stopWalkthrough({ stopVoice: false });
    }

    // 1. Thực thi đoạn mã dựng mẫu 3D TRƯỚC nếu AI gửi kèm `demoCode` (để tạo khối trước khi vào Edit/Sculpt Mode)
    if (cmd.demoCode && typeof cmd.demoCode === 'string' && cmd.demoCode.trim()) {
      await this._runSandboxedDemoCode(cmd.demoCode);
    }

    // Chuẩn hóa selector hay bị model AI viết ước lệ
    const rawTarget = cmd.pointAt || cmd.targetSelector || '#viewport-canvas-host';
    const TARGET_ALIASES = {
      '#viewport-center': '#viewport-canvas-host',
      '#viewport': '#viewport-canvas-host',
      '#canvas': '#viewport-canvas-host',
      'canvas': '#viewport-canvas-host',
      '#scene': '#viewport-canvas-host',
      '#btn-extrude': '#btn-edit-extrude',
      '#btn-inset': '#btn-edit-inset',
      '#btn-bevel': '#btn-edit-bevel',
      '#btn-subdivide': '#btn-edit-subdivide'
    };
    const target = TARGET_ALIASES[String(rawTarget).trim()] || rawTarget;

    // Suy diễn mode nếu AI chỉ vào công cụ Edit/Sculpt nhưng quên truyền viewportMode
    let wantedMode = cmd.viewportMode || null;
    if (!wantedMode && /^#(?:btn-mode-(?:vertex|edge|face)|(?:btn|tb)-edit-)/i.test(target)) {
      wantedMode = 'edit';
    } else if (!wantedMode && /^#btn-sculpt-/i.test(target)) {
      wantedMode = 'sculpt';
    }

    // 2. Chuyển chế độ Viewport (Object / Edit / Sculpt) thật qua mode-resolver
    const win = typeof window !== 'undefined' ? window : null;
    const editModeInst = this.app?.editMode || win?.editMode || null;
    let layoutChanged = false;

    if (wantedMode && typeof document !== 'undefined') {
      if (this._switchModeSafely(wantedMode)) {
        layoutChanged = true;
      }
    }

    // 3. Chuyển chế độ chọn Đỉnh/Cạnh/Mặt trong Edit Mode nếu AI yêu cầu
    let wantedSelMode = cmd.editSelectionMode || null;
    if (!wantedSelMode && /^#btn-mode-(vertex|edge|face)$/i.test(target)) {
      wantedSelMode = target.match(/^#btn-mode-(vertex|edge|face)$/i)[1];
    }
    if (wantedSelMode && editModeInst) {
      editModeInst.setMode?.(wantedSelMode);
      if (typeof document !== 'undefined') {
        const modeBtn = document.getElementById(`btn-mode-${wantedSelMode}`);
        modeBtn?.click?.();
      }
      layoutChanged = true;
    }

    // 4. Mở Panel hoặc Tab (Scripting, Materials, Pose, Timeline, Physics, Modifiers...)
    if (cmd.openPanel && typeof document !== 'undefined') {
      const p = String(cmd.openPanel).toLowerCase().trim().replace(/[^a-z0-9_-]/g, '');
      if (p) {
        const esc = typeof CSS !== 'undefined' && typeof CSS.escape === 'function' ? CSS.escape(p) : p;
        if (['modifier', 'material', 'object', 'world', 'armature', 'data', 'tool'].includes(p)) {
          const propTab = document.querySelector(`.prop-tab-btn[data-tab="${esc}"]`);
          propTab?.click();
        } else {
          const dockTab = document.querySelector(`.dock-tab[data-pane="dock-${esc}"]`) ||
            document.querySelector(`.dock-tab[data-pane="${esc}"]`);
          dockTab?.click();
        }
        layoutChanged = true;
      }
    }

    // 5. Click vào một nút công cụ cụ thể nếu AI yêu cầu (allowlisted UI controls only + CSS.escape)
    if (cmd.clickSelector && typeof document !== 'undefined') {
      const sel = String(cmd.clickSelector).trim();
      const SAFE_CLICK_SELECTOR_RE = /^#(?:btn-(?:mode|edit|sculpt|paint|focus|shading|toggle|timeline|add)-?[a-z0-9_-]*|tool-[a-z0-9_-]+|menu-[a-z0-9_-]+|phys-[a-z0-9_-]+|btn-shading-popover|btn-focus-object|btn-toggle-grid)$/i;
      if (SAFE_CLICK_SELECTOR_RE.test(sel)) {
        try {
          const btn = document.getElementById(sel.slice(1)) || document.querySelector(`#${CSS.escape(sel.slice(1))}`);
          btn?.click?.();
        } catch (_) {}
      }
    }

    // Đợi 1 frame DOM để toolbar ẩn (Edit/Sculpt/Dock) kịp hiện lên trước khi đo bounding rect
    if (layoutChanged && typeof requestAnimationFrame === 'function') {
      await new Promise((r) => requestAnimationFrame(() => r()));
    }

    // 6. Cho Con trỏ Giáo viên bay tới nút mục tiêu và phát lời giảng
    const speech = cmd.speech || cmd.text || '';
    const title = cmd.title || '🤖 Giáo viên AI 1-1';
    const stepBadge = cmd.stepBadge || opts.stepBadge || 'AI Coach 1:1';

    const moveRes = this.moveToTarget(target, {
      openBubble: true,
      title,
      stepBadge,
      speechText: speech,
      speak: !opts._deferSpeak && cmd.speak !== false && !!speech
    });

    this._refreshGeometryHudBadge();
    return {
      ok: true,
      target: moveRes.targetSelector || target,
      spoken: !!speech,
      speech,
      avatarPosition: { ...this.avatarPosition }
    };
  }

  /**
   * Chạy tuần tự chuỗi nhiều bước hướng dẫn (AI Coach hoặc studio.tutor.guideSteps).
   * Thực thi ngay Bước đầu tiên để UI & kết quả trả về có tọa độ tức thì,
   * sau đó tự động đọc & chuyển sang Bước 2 -> Bước 3 -> ... -> Bước cuối mà không bị dừng ngang!
   */
  async guideSteps(rawSteps = [], {
    speak = true,
    autoAdvance,
    startIndex = 0,
    title = '',
    sourceBadge = 'AI 1-1'
  } = {}) {
    const steps = (Array.isArray(rawSteps) ? rawSteps : [])
      .filter((s) => s && typeof s === 'object' && (s.speech || s.text || s.pointAt || s.targetSelector || s.demoCode))
      .map((s, idx) => ({
        title: s.title || title || `Bước ${idx + 1}`,
        speech: s.speech || s.text || s.actionHint || '',
        pointAt: s.pointAt || s.targetSelector || '#viewport-canvas-host',
        viewportMode: s.viewportMode || null,
        editSelectionMode: s.editSelectionMode || null,
        openPanel: s.openPanel || s.panel || null,
        clickSelector: s.clickSelector || null,
        demoCode: s.demoCode || null,
        delayMs: Number.isFinite(s.delayMs) ? Math.max(350, s.delayMs) : 950
      }));

    if (!steps.length) return { ok: false, error: 'Danh sách bước hướng dẫn trống.' };

    this.stopWalkthrough({ stopVoice: true });
    this.guidedSequence = steps;
    this.guidedSequenceTitle = title || steps[0].title;
    const clampedStart = Math.max(0, Math.min(steps.length - 1, Number(startIndex) || 0));
    this.guidedSequenceIndex = clampedStart;

    // Pre-fetch trước âm thanh toàn bộ chuỗi bước để chuyển bước 0ms độ trễ
    for (let i = clampedStart; i < steps.length; i += 1) {
      if (steps[i].speech) this.voice.prefetch(steps[i].speech);
    }

    const shouldAutoAdvance = (autoAdvance !== undefined) ? Boolean(autoAdvance) : (speak && steps.length > 1);
    const token = ++this._walkthroughToken;

    const first = steps[clampedStart];
    const firstBadge = `${sourceBadge} · Bước ${clampedStart + 1}/${steps.length}`;
    const firstRes = await this.executeAICommand(
      { ...first, stepBadge: firstBadge },
      { speak: false, _keepWalkthrough: true, _deferSpeak: true }
    );

    if (!shouldAutoAdvance || steps.length <= 1) {
      if (speak && first.speech) {
        this.speak(first.speech);
      }
      return {
        ...firstRes,
        stepsCount: steps.length,
        walkthroughActive: false
      };
    }

    this.isAutoWalking = true;
    this._syncAutoWalkButtons();

    // Chạy nền chuỗi Bước 1 -> Bước N để không chặn callers, đồng thời hỗ trợ barge-in & tạm dừng
    (async () => {
      try {
        for (let i = clampedStart; i < steps.length; i += 1) {
          if (token !== this._walkthroughToken) return;
          const step = steps[i];
          const stepBadge = `${sourceBadge} · Bước ${i + 1}/${steps.length}`;

          if (i > clampedStart) {
            await this.executeAICommand(
              { ...step, stepBadge },
              { speak: false, _keepWalkthrough: true, _deferSpeak: true }
            );
          }
          if (token !== this._walkthroughToken) return;
          this.guidedSequenceIndex = i;

          if (token !== this._walkthroughToken) return;
          const spokeOk = await this._speakAndWait(step.speech || step.title, { speak, token });
          if (!spokeOk || token !== this._walkthroughToken) return;

          if (i + 1 < steps.length) {
            const gapOk = await this._sleepWalk(step.delayMs, token);
            if (!gapOk || token !== this._walkthroughToken) return;
          }
        }

        if (token === this._walkthroughToken) {
          this.isAutoWalking = false;
          this._syncAutoWalkButtons();
          this.setBubbleContent({
            title: `✅ Hoàn tất ${steps.length}/${steps.length} bước hướng dẫn`,
            stepBadge: 'Xong chuỗi',
            text: `Bạn đã đi qua trọn bộ ${steps.length} bước. Có thể bấm ◀ Trước / Tiếp ▶ để xem lại từng bước hoặc hỏi thêm câu mới!`
          });
        }
      } catch (err) {
        if (token === this._walkthroughToken) {
          this.isAutoWalking = false;
          this._syncAutoWalkButtons();
        }
        console.warn('[StemTutorUI] guideSteps walkthrough warning:', err);
      }
    })();

    return {
      ...firstRes,
      stepsCount: steps.length,
      walkthroughActive: true
    };
  }

  /**
   * Student asks a direct question to the 1-1 AI Tutor.
   */
  async askAICoach(question, { speak = true, autoAdvance } = {}) {
    const q = String(question || '').trim();
    if (!q) return { ok: false, error: 'Câu hỏi đang trống.' };

    // Nếu người dùng gõ lệnh gọi Copilot ("Copilot ơi, dựng...") ngay trong ô hỏi giáo viên -> chuyển đúng trợ lý
    const routed = routeVoiceUtterance(q, { requireWakeWord: true });
    const winScope = typeof window !== 'undefined' ? window : null;
    if (routed.target === 'copilot' && routed.query && winScope?.aiCopilot?.sendPrompt) {
      this._aiCoachBusy = false;
      winScope.aiCopilot.show?.();
      return await winScope.aiCopilot.sendPrompt(routed.query);
    }
    const cleanQ = (routed.target === 'stem' && routed.query) ? routed.query : q;

    this._cancelPendingCoachRequest();
    this.stopWalkthrough({ stopVoice: true });
    const reqToken = ++this._coachRequestToken;
    const coachAbortController = typeof AbortController !== 'undefined' ? new AbortController() : null;
    this._coachAbortController = coachAbortController;
    this._aiCoachBusy = true;
    this.setBubbleOpen(true);
    this.setHudMinimized(false);
    this.setBubbleContent({
      title: '🤖 Giáo viên AI đang phân tích mô hình 3D...',
      stepBadge: 'Đang phân tích',
      text: `Câu hỏi: "${cleanQ}"\nĐang đọc thông số lưới & chuẩn bị lộ trình hướng dẫn từng bước...`
    });

    const win = typeof window !== 'undefined' ? window : null;
    const sceneSummary = inspectSceneGeometrySummary(
      this.app?.sceneManager || win?.sceneManager,
      this.app?.editMode || win?.editMode
    );

    const copilot = win?.aiCopilot || this.app?.aiCopilot;
    const provider = copilot?.settings?.provider || 'motapis';
    const model = copilot?._modelForProvider ? copilot._modelForProvider(provider) : 'claude-sonnet-4-6';

    const systemPrompt = `Bạn là Giáo viên Kèm 1-1 Tương tác Thực chiến trong Hunger.
Bạn điều khiển trực tiếp con trỏ Giáo viên trên màn hình, chuyển chế độ Object/Edit/Sculpt, mở tab công cụ, và dựng mẫu 3D.

QUAN TRỌNG: Đừng chỉ hướng dẫn đúng 1 bước rồi dừng! Với mọi câu hỏi cách làm / hướng dẫn / dựng mẫu, hãy trả về ĐẦY ĐỦ chuỗi 3–5 bước ("steps") từ lúc bắt đầu đến lúc hoàn thiện để học viên xem trọn quy trình.

Các CSS Selector chính xác trên giao diện Hunger dùng cho "pointAt":
- Menu Thêm Khối: "#menu-add", ".dropdown-item[data-spawn-prim=\"cube\"]", ".dropdown-item[data-spawn-prim=\"uv_sphere\"]", ".dropdown-item[data-spawn-prim=\"cylinder\"]"
- Công cụ Biến đổi Object Mode: "#tool-move" (G), "#tool-rotate" (R), "#tool-scale" (S)
- Vật lý Rapier 3D: "#phys-play", ".dock-tab[data-pane=\"dock-physics\"]"
- Chuyển chế độ (Object / Edit / Sculpt): "#viewport-mode" (Tab)
- Công cụ Edit Mode (Box Modeling): "#btn-mode-vertex" (1), "#btn-mode-edge" (2), "#btn-mode-face" (3), "#btn-edit-extrude" (Extrude E), "#btn-edit-inset" (Inset I), "#btn-edit-bevel" (Bevel Ctrl+B), "#btn-edit-subdivide" (Subdivide), "#btn-edit-delete-geometry" (X)
- Công cụ Sculpt Mode: "#btn-sculpt-draw", "#btn-sculpt-grab", "#btn-sculpt-smooth", "#btn-sculpt-symmetry"
- Bảng Properties / Modifiers / Outliner: ".prop-tab-btn[data-tab=\\"modifier\\"]", ".prop-tab-btn[data-tab=\\"material\\"]", "#outliner-panel", "#inspector-panel"
- Các tab Dock dưới: ".dock-tab[data-pane=\\"dock-materials\\"]", ".dock-tab[data-pane=\\"dock-pose\\"]", ".dock-tab[data-pane=\\"dock-timeline\\"]", ".dock-tab[data-pane=\\"dock-mocap\\"]", ".dock-tab[data-pane=\\"dock-physics\\"]", ".dock-tab[data-pane=\\"dock-uv-editor\\"]"
- File & Ánh sáng: "#menu-file", "#btn-shading-popover"

Tóm tắt cảnh 3D hiện tại:
${JSON.stringify(sceneSummary)}

Bài học hiện tại: "${this.activeLesson?.title || 'Dựng hình tự do'}"

API JavaScript hợp lệ cho "demoCode" (KHÔNG dùng studio.addPrimitive hay studio.executeCommand; chỉ đặt demoCode: null nếu học viên chỉ hỏi lý thuyết, còn khi yêu cầu "làm mẫu / dựng mẫu / demo" HÃY viết demoCode dựng khối thật trong Viewport!):
- Tạo khối: studio.addCube({ name, x, y, z, width, height, depth, color }), studio.addSphere({ ... }), studio.addCylinder({ ... }), studio.clearScene()
- Edit Mode thật: if (window.editMode) { window.editMode.enter(mesh); window.editMode.setMode('face'|'edge'|'vertex'); window.editMode.selectFace(2); window.editMode.inset(0.2); window.editMode.extrude(0.6); window.editMode.bevel(0.08, 2); }
- Modifiers thật: if (window.modifiers && mesh?.isMesh) { await window.modifiers.applyModifier(mesh, 'bevel'|'subdivide'|'mirror'|'array'|'solidify'|'displace'|'smooth', { width: 0.08, segments: 2 }); }
- Chuyển chế độ / chọn Đỉnh-Cạnh-Mặt: ưu tiên dùng field JSON "viewportMode", "editSelectionMode", "openPanel" thay vì viết hàm không tồn tại trong demoCode.

Trả về DUY NHẤT một khối JSON:
\`\`\`json
{
  "title": "Tiêu đề ngắn cho lộ trình hướng dẫn (tiếng Việt tự nhiên nếu câu hỏi tiếng Việt)",
  "steps": [
    {
      "title": "Bước 1: ...",
      "speech": "Lời giảng ngắn gọn tự nhiên (1-2 câu), nêu rõ nút bấm hoặc phím tắt",
      "pointAt": "#selector-muc-tieu",
      "viewportMode": "object | edit | sculpt | null",
      "editSelectionMode": "vertex | edge | face | null",
      "openPanel": "modifier | material | materials | pose | timeline | physics | null",
      "demoCode": null
    }
  ]
}
\`\`\``;

    let coachPlan = null;
    let fromCloud = false;
    const isCancelled = () => reqToken !== this._coachRequestToken || Boolean(coachAbortController?.signal?.aborted);

    try {
      // 1. Gọi Model AI trực tuyến (hỗ trợ cả /api/cloud/ai/chat + BYOK + Abort khi có câu hỏi mới)
      if (typeof window !== 'undefined' && typeof window.fetch === 'function') {
        const candidates = [{ provider, model }];
        const caps = copilot?.serverCapabilities;
        if (provider === 'gemini' && caps?.custom) {
          candidates.push({ provider: 'motapis', model: copilot?.settings?.customModel || 'claude-sonnet-4-6' });
        } else if (provider !== 'gemini' && caps?.gemini) {
          candidates.push({ provider: 'gemini', model: copilot?.settings?.geminiModel || 'gemini-3.5-flash-lite' });
        }

        const cloudClient = win?.app?.cloud || win?.cloudClient || null;
        const useCloudRoute = Boolean(cloudClient?.isSignedIn?.());
        const chatUrl = useCloudRoute
          ? (cloudClient.absoluteUrl ? cloudClient.absoluteUrl('/api/cloud/ai/chat') : '/api/cloud/ai/chat')
          : '/api/ai/chat';
        const byokKey = typeof copilot?._getByokKey === 'function' ? copilot._getByokKey() : '';

        for (const cand of candidates) {
          if (isCancelled()) break;
          try {
            if (useCloudRoute && typeof cloudClient._ensureFresh === 'function') {
              await cloudClient._ensureFresh();
              if (isCancelled()) break;
            }
            const reqController = typeof AbortController !== 'undefined' ? new AbortController() : null;
            const onCancelAbort = () => reqController?.abort();
            coachAbortController?.signal?.addEventListener?.('abort', onCancelAbort, { once: true });
            const timer = reqController ? setTimeout(() => reqController.abort(), 22000) : null;
            let resp;
            try {
              const headers = { 'Content-Type': 'application/json' };
              if (useCloudRoute && cloudClient?.session?.accessToken) {
                headers.Authorization = `Bearer ${cloudClient.session.accessToken}`;
              }
              if (byokKey) headers['X-AI-Provider-Key'] = byokKey;
              resp = await window.fetch(chatUrl, {
                method: 'POST',
                headers,
                body: JSON.stringify({
                  provider: cand.provider,
                  model: cand.model,
                  messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: cleanQ }
                  ],
                  temperature: 0.25
                }),
                signal: reqController ? reqController.signal : undefined
              });
            } finally {
              if (timer) clearTimeout(timer);
              coachAbortController?.signal?.removeEventListener?.('abort', onCancelAbort);
            }
            if (isCancelled()) break;
            if (resp.ok) {
              const data = await resp.json();
              if (isCancelled()) break;
              const rawContent = data?.choices?.[0]?.message?.content || '';
              coachPlan = this._parseAICoachResponse(rawContent);
              if (coachPlan) {
                fromCloud = true;
                break;
              }
            }
          } catch (_) {
            if (isCancelled()) break;
            // Thử provider dự phòng kế tiếp trước khi fallback nội bộ
          }
        }
      }

      if (isCancelled()) {
        return { ok: false, cancelled: true, reason: 'superseded' };
      }

      // 2. Fallback: Bộ Huấn luyện Dựng hình 3D Đa Bước tích hợp sẵn (tiếng Việt hoàn chỉnh)
      if (!coachPlan) {
        coachPlan = this._buildSmartLocalModelingCoachPlan(cleanQ, sceneSummary);
      }

      // Nếu người dùng yêu cầu "làm mẫu / demo" mà Cloud AI quên kèm demoCode -> bổ sung minh họa chuẩn tương ứng
      const wantsDemoBuild = /(làm mẫu|dựng mẫu|tạo giúp|demo|thực hành thử)/i.test(cleanQ);
      if (coachPlan && wantsDemoBuild && Array.isArray(coachPlan.steps) && !coachPlan.steps.some((s) => s?.demoCode)) {
        const localTemplate = this._buildSmartLocalModelingCoachPlan(cleanQ, sceneSummary);
        if (Array.isArray(localTemplate?.steps)) {
          const demos = localTemplate.steps.map((s) => s?.demoCode).filter(Boolean);
          if (demos.length > 0 && coachPlan.steps.length > 0) {
            coachPlan.steps[0].demoCode = demos[0];
            if (demos.length > 1) {
              const lastIdx = coachPlan.steps.length - 1;
              coachPlan.steps[lastIdx].demoCode = demos[demos.length - 1];
            }
          }
        }
      }

      if (isCancelled()) {
        return { ok: false, cancelled: true, reason: 'superseded' };
      }

      const sourceBadge = fromCloud ? 'Cloud AI 1:1' : 'AI Coach Nội bộ';
      const result = await this.executeAICommand(coachPlan, {
        speak,
        autoAdvance,
        sourceBadge
      });
      return {
        ...result,
        plan: coachPlan,
        fromCloud,
        sceneSummary
      };
    } finally {
      if (reqToken === this._coachRequestToken) {
        this._aiCoachBusy = false;
        this._coachAbortController = null;
      }
    }
  }

  _parseAICoachResponse(rawText) {
    if (!rawText || typeof rawText !== 'string') return null;
    const cleaned = stripThinkingTags(rawText);
    if (!cleaned) return null;
    try {
      const jsonMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/i);
      const candidate = jsonMatch ? jsonMatch[1].trim() : cleaned;
      const firstBrace = candidate.indexOf('{');
      const lastBrace = candidate.lastIndexOf('}');
      if (firstBrace !== -1 && lastBrace > firstBrace) {
        const parsed = JSON.parse(candidate.slice(firstBrace, lastBrace + 1));
        if (parsed && Array.isArray(parsed.steps) && parsed.steps.length > 0) {
          return {
            title: parsed.title || '🤖 Lộ trình Hướng dẫn AI 1-1',
            steps: parsed.steps,
            ...(parsed.forcePause ? { autoAdvance: false } : {})
          };
        }
        if (parsed && (parsed.speech || parsed.pointAt || parsed.demoCode)) {
          return parsed;
        }
      }
    } catch (_) {}

    // Nếu LLM trả về văn bản nhiều dòng / bước đánh số kèm code JS -> tự tách thành nhiều bước mượt mà
    const codeMatch = cleaned.match(/```(?:javascript|js)\s*([\s\S]*?)```/i);
    const plainText = cleaned.replace(/```[\s\S]*?```/g, '').trim();
    const numberedLines = plainText
      .split(/\n+/)
      .map((line) => line.replace(/^[\s*\-•]+/, '').trim())
      .filter((line) => line.length >= 12 && (/^(?:bước\s*\d+|\d+[.)])/i.test(line) || plainText.split(/\n+/).length >= 2));

    if (numberedLines.length >= 2) {
      const steps = numberedLines.slice(0, 6).map((line, i) => ({
        title: `Bước ${i + 1}`,
        speech: line.slice(0, 280),
        pointAt: i === 0 ? '#menu-add' : '#viewport-canvas-host',
        demoCode: i === numberedLines.slice(0, 6).length - 1 && codeMatch ? codeMatch[1].trim() : null
      }));
      return { title: '🤖 Hướng dẫn từng bước từ AI', steps };
    }

    return {
      title: '🤖 Hướng dẫn từ Model AI',
      speech: plainText.slice(0, 420) || 'Mình đã thực hiện minh họa thao tác bạn yêu cầu ngay trong Viewport 3D!',
      pointAt: '#viewport-canvas-host',
      demoCode: codeMatch ? codeMatch[1].trim() : null
    };
  }

  /**
   * Built-in 3D Modeling Trainer (hoạt động tức thì cả khi offline / chưa có API key).
   * Luôn trả về lộ trình ĐA BƯỚC (3-4 bước liên hoàn) bằng tiếng Việt tự nhiên để học viên không bị dừng sau 1 bước.
   */
  _buildSmartLocalModelingCoachPlan(question, sceneSummary) {
    const q = question.toLowerCase();
    const wantDemo = /(làm mẫu|dựng mẫu|tạo giúp|tạo hộ|dựng giúp|demo|vẽ giúp|làm cho tôi|tạo cho tôi|build|create|show me)/i.test(q);
    const hasMesh = sceneSummary.meshCount > 0;

    // 1. Extrude / Inset / Edit Mode (3 bước hoàn chỉnh)
    if (/(extrude|đùn|đẩy mặt|inset|thu mặt|edit mode|đa giác|mặt|cạnh|đỉnh|box modeling|face|edge|vertex)/i.test(q)) {
      return {
        title: '🛠️ Hướng dẫn Edit Mode: Inset (I) & Extrude (E)',
        steps: [
          {
            title: 'Bước 1: Chuyển sang Edit Mode (Tab)',
            speech: hasMesh
              ? 'Bước 1: Mình đã chuyển sang chế độ Edit Mode cho khối lưới hiện tại để bạn chỉnh sửa từng đỉnh, cạnh và mặt.'
              : 'Bước 1: Mình đã tạo một khối lập phương mẫu và bật Edit Mode cho bạn bắt đầu thực hành.',
            pointAt: '#viewport-mode',
            viewportMode: 'edit',
            demoCode: (!hasMesh || wantDemo)
              ? `const m = studio.addCube({ name: "Khoi_Thuc_Hanh_Edit", x: 0, y: 1, z: 0, width: 2, height: 2, depth: 2, color: 0x3498db });
if (window.editMode) { window.editMode.enter(m); window.editMode.setMode('face'); }`
              : null
          },
          {
            title: 'Bước 2: Chọn chế độ Mặt (Phím 3) & Thu mặt Inset (I)',
            speech: 'Bước 2: Bấm nút chọn Mặt hoặc nhấn phím số 3, click chọn mặt trên cùng của khối, sau đó nhấn Inset phím I để tạo viền khung bên trong.',
            pointAt: '#btn-mode-face',
            viewportMode: 'edit',
            editSelectionMode: 'face'
          },
          {
            title: 'Bước 3: Đùn khối Extrude (Phím E)',
            speech: 'Bước 3: Bấm nút Extrude ngay đây hoặc nhấn phím E rồi kéo chuột lên để đùn phần mặt vừa chọn tạo độ nổi khối 3D.',
            pointAt: '#btn-edit-extrude',
            viewportMode: 'edit',
            editSelectionMode: 'face',
            demoCode: wantDemo
              ? `if (window.editMode?.isActive) { window.editMode.selectFace?.(2); window.editMode.inset?.(0.2); window.editMode.extrude?.(0.6); }`
              : null
          }
        ]
      };
    }

    // 2. Bevel / Subdivision / Mirror / Array / Modifier (3 bước hoàn chỉnh)
    if (/(bevel|vát cạnh|bo góc|modifier|mirror|đối xứng|array|nhân bản|subdiv|làm mịn|boolean|khoét|cắt khối)/i.test(q)) {
      return {
        title: '🔧 Quy trình Modifier Stack (Bevel / Mirror / Subdiv)',
        steps: [
          {
            title: 'Bước 1: Chọn đối tượng cần gắn Modifier',
            speech: hasMesh
              ? 'Bước 1: Hãy chọn khối 3D trong khung nhìn hoặc bảng Outliner bên phải trước khi thêm bộ biến đổi.'
              : 'Bước 1: Mình tạo trước một khối lập phương mẫu để bạn thấy rõ hiệu ứng vát cạnh và làm mịn.',
            pointAt: '#outliner-panel',
            demoCode: (!hasMesh || wantDemo)
              ? `studio.addCube({ name: "Khoi_Modifier_Mau", x: 0, y: 1, z: 0, color: 0xfeca57 });`
              : null
          },
          {
            title: 'Bước 2: Mở tab Modifiers (Cờ lê)',
            speech: 'Bước 2: Bấm vào tab Modifiers hình cờ lê trong bảng Properties bên phải để mở danh sách Bevel, Mirror, Array và Subdivision.',
            pointAt: '.prop-tab-btn[data-tab="modifier"]',
            openPanel: 'modifier'
          },
          {
            title: 'Bước 3: Thêm Bevel hoặc Subdivision không phá huỷ',
            speech: 'Bước 3: Bấm Add Modifier rồi chọn Bevel để bo sáng các cạnh sắc, hoặc Subdivision để làm mịn lưới đa giác mà vẫn giữ nguyên khối gốc.',
            pointAt: '#inspector-panel',
            openPanel: 'modifier',
            demoCode: wantDemo
              ? `const m = window.sceneManager?.getActiveObject() || window.scene?.children?.find?.(o => o.isMesh);
if (window.modifiers && m?.isMesh) { await window.modifiers.applyModifier(m, 'bevel', { offset: 0.14, segments: 2 }); }`
              : null
          }
        ]
      };
    }

    // 3. Sculpt Mode (3 bước)
    if (/(sculpt|điêu khắc|nặn|cọ|draw|grab|smooth|symmetry)/i.test(q)) {
      return {
        title: '🎨 Hướng dẫn Điêu khắc 3D (Sculpt Mode)',
        steps: [
          {
            title: 'Bước 1: Chuẩn bị khối cầu lưới dày & vào Sculpt Mode',
            speech: 'Bước 1: Mình đã chuẩn bị khối đất sét mịn và chuyển khung nhìn sang Sculpt Mode để bạn bắt đầu nặn hình.',
            pointAt: '#viewport-mode',
            viewportMode: 'sculpt',
            demoCode: !hasMesh
              ? `studio.addSphere({ name: "Khoi_Dat_Set", x: 0, y: 1.3, z: 0, radius: 1.3, widthSegments: 32, heightSegments: 24, color: 0xe17055 });`
              : null
          },
          {
            title: 'Bước 2: Chọn cọ Draw / Grab để kéo nặn khối',
            speech: 'Bước 2: Dùng cọ Draw để đắp nổi bề mặt, hoặc cọ Grab để kéo chỉnh dáng tổng thể. Nhấn ngoặc vuông để chỉnh kích thước đầu cọ.',
            pointAt: '#btn-sculpt-draw',
            viewportMode: 'sculpt'
          },
          {
            title: 'Bước 3: Bật Đối xứng X & Làm mượt Smooth',
            speech: 'Bước 3: Bật Symmetry trục X để nặn cân hai bên, và giữ phím Shift hoặc dùng cọ Smooth để vuốt mịn bề mặt.',
            pointAt: '#btn-sculpt-smooth',
            viewportMode: 'sculpt'
          }
        ]
      };
    }

    // 4. Vật liệu PBR & Ánh sáng (3 bước)
    if (/(vật liệu|material|pbr|tô màu|màu sắc|kim loại|kính|bóng|nhám|đèn|ánh sáng|light|shading)/i.test(q)) {
      return {
        title: '✨ Cài đặt Vật liệu PBR & Ánh sáng Studio',
        steps: [
          {
            title: 'Bước 1: Chuyển chế độ hiển thị Material / Rendered',
            speech: 'Bước 1: Bấm vào nhóm Shading góc trên phải khung nhìn và chọn Material hoặc Rendered để thấy độ phản xạ kim loại và bóng đổ thật.',
            pointAt: '#btn-shading-popover'
          },
          {
            title: 'Bước 2: Mở kho vật liệu PBR ở thanh dưới',
            speech: 'Bước 2: Chọn vật thể trên màn hình, sau đó mở tab Materials ở thanh Dock dưới để chọn nhanh 24 chất liệu vàng, đồng, kính hay gỗ.',
            pointAt: '.dock-tab[data-pane="dock-materials"]',
            openPanel: 'materials'
          },
          {
            title: 'Bước 3: Tinh chỉnh Độ nhám & Kim loại trong Inspector',
            speech: 'Bước 3: Sang tab Material bên phải để kéo hai thanh Metalness và Roughness cho độ bóng đúng ý.',
            pointAt: '.prop-tab-btn[data-tab="material"]',
            openPanel: 'material',
            demoCode: wantDemo
              ? `studio.addLight({ type: 'point', x: 3, y: 5, z: 3, intensity: 3 });`
              : null
          }
        ]
      };
    }

    // 5. Lắp ghép Bàn / Ghế / Nhà / Đạo cụ (4 bước tuần tự — dựng thật từng phần nếu muốn demo!)
    if (/(bàn|ghế|nhà|cốc|ly|robot|xe|cây|tháp|lắp|scale|move|di chuyển|xoay|rotate|table|chair|house|cup)/i.test(q)) {
      return {
        title: '📐 Lắp ghép Mô hình 3D trong Object Mode (4 Bước)',
        steps: [
          {
            title: 'Bước 1: Mở Menu Add (Shift+A) tạo khối nền chính',
            speech: wantDemo
              ? 'Bước 1: Đầu tiên mình tạo phần mặt bàn bằng khối hộp dẹt nằm ngang làm khung chính.'
              : 'Bước 1: Bạn bấm vào menu Add hoặc nhấn Shift A, chọn Cube để tạo khối chính như mặt bàn hoặc thân vật thể.',
            pointAt: '#menu-add',
            viewportMode: 'object',
            demoCode: wantDemo
              ? `studio.clearScene();
studio.addCube({ name: "Mat_Ban_Go", x: 0, y: 1.5, z: 0, width: 3.2, height: 0.22, depth: 2.0, color: 0xd35400, roughness: 0.55 });`
              : null
          },
          {
            title: 'Bước 2: Co giãn tỷ lệ bằng Scale (Phím S)',
            speech: 'Bước 2: Chọn công cụ Scale phím S ngay bên trái để bóp dẹt thành mặt bàn hoặc kéo dài thành cột trụ đúng kích thước.',
            pointAt: '#tool-scale',
            viewportMode: 'object'
          },
          {
            title: 'Bước 3: Thêm & đặt các bộ phận phụ (Move phím G / Shift+D)',
            speech: wantDemo
              ? 'Bước 3: Bây giờ mình gắn 4 chân bàn đối xứng bên dưới bằng khối trụ và dùng Move phím G để căn chuẩn bốn góc.'
              : 'Bước 3: Dùng Move phím G và Shift D để nhân bản nhanh 4 chân bàn hoặc bộ phận đối xứng vào bốn góc.',
            pointAt: '#tool-move',
            viewportMode: 'object',
            demoCode: wantDemo
              ? `for (const [lx, lz] of [[-1.35, -0.75], [1.35, -0.75], [-1.35, 0.75], [1.35, 0.75]]) {
  studio.addCylinder({ name: "Chan_Ban", x: lx, y: 0.75, z: lz, radiusTop: 0.1, radiusBottom: 0.08, height: 1.5, color: 0x2c3e50 });
}`
              : null
          },
          {
            title: 'Bước 4: Kiểm tra cây đối tượng Outliner & hoàn thiện',
            speech: 'Bước 4: Kiểm tra lại danh sách các bộ phận bên bảng Outliner bên phải để đặt tên gọn gàng hoặc gom nhóm bằng Ctrl G!',
            pointAt: '#outliner-panel',
            viewportMode: 'object'
          }
        ]
      };
    }

    // 6. Rigging / Pose / Mocap / Animation (3 bước)
    if (/(xương|rig|pose|nhân vật|michelle|mocap|video|chuyển động|animation|keyframe|timeline)/i.test(q)) {
      return {
        title: '🦴 Gắn Xương Nhân vật, Tạo Dáng & Video Mocap AI',
        steps: [
          {
            title: 'Bước 1: Đưa nhân vật có xương vào cảnh (Add -> Mannequin CC0)',
            speech: 'Bước 1: Vào menu Add hoặc tab Asset Browser để thêm nhân vật Mannequin CC0 đã gắn sẵn bộ xương đầy đủ.',
            pointAt: '#menu-add'
          },
          {
            title: 'Bước 2: Tạo dáng khớp xương ở tab Pose & Rigging',
            speech: 'Bước 2: Mở tab Pose ở thanh Dock dưới cùng để bật Pose Mode, khóa bàn chân IK và lưu keyframe.',
            pointAt: '.dock-tab[data-pane="dock-pose"]',
            openPanel: 'pose'
          },
          {
            title: 'Bước 3: Lấy chuyển động tự động từ Video AI Mocap',
            speech: 'Bước 3: Hoặc mở tab Video Mocap ngay cạnh để trích xuất chuyển động 3D trực tiếp từ video ngay trên trình duyệt!',
            pointAt: '.dock-tab[data-pane="dock-mocap"]',
            openPanel: 'mocap'
          }
        ]
      };
    }

    // 7. Mặc định: chạy xuyên suốt các bước của bài học hiện tại (không dừng ở bước 1!)
    const lessonSteps = Array.isArray(this.activeLesson?.steps) ? this.activeLesson.steps : [];
    if (lessonSteps.length > 0) {
      const fromIdx = Math.max(0, Math.min(lessonSteps.length - 1, this.activeStepIndex || 0));
      return {
        title: `💡 Hướng dẫn: ${this.activeLesson.title}`,
        steps: lessonSteps.slice(fromIdx).map((st) => ({
          title: st.title,
          speech: st.voiceText,
          pointAt: st.targetSelector,
          openPanel: st.panel || null
        }))
      };
    }

    return {
      title: '💡 Lộ trình Làm quen Studio 3D (3 Bước)',
      steps: [
        {
          title: 'Bước 1: Thêm khối cơ bản (Add / Shift+A)',
          speech: `Cảnh hiện có ${sceneSummary.meshCount} khối (${sceneSummary.totalVertices} đỉnh) ở chế độ ${sceneSummary.activeMode}. Bước 1: Mở menu Add hoặc nhấn Shift A để thêm khối 3D.`,
          pointAt: '#menu-add'
        },
        {
          title: 'Bước 2: Di chuyển (G), Xoay (R), Co giãn (S)',
          speech: 'Bước 2: Dùng công cụ Move, Rotate, Scale bên thanh công cụ trái để bố trí vị trí và kích thước khối.',
          pointAt: '#tool-move'
        },
        {
          title: 'Bước 3: Sang Edit Mode (Tab) để đùn & vát cạnh',
          speech: 'Bước 3: Chuyển sang Edit Mode bằng phím Tab để chỉnh từng đỉnh, cạnh, mặt với Extrude E và Bevel Ctrl B!',
          pointAt: '#viewport-mode'
        }
      ]
    };
  }

  // ===========================================================================
  // THEO DÕI THAO TÁC DỰNG HÌNH 3D THỰC TẾ CỦA HỌC VIÊN TRÊN VIEWPORT
  // ===========================================================================

  _bindLiveModelingTrackers() {
    if (typeof window === 'undefined' || typeof document === 'undefined') return;

    const refreshHud = () => this._refreshGeometryHudBadge();

    // Đánh dấu khi học viên dùng các nút Edit Mode thực tế (Extrude, Inset, Bevel, Subdivide)
    const editButtons = ['btn-edit-extrude', 'btn-edit-inset', 'btn-edit-bevel', 'btn-edit-subdivide', 'btn-edit-poke'];
    for (const id of editButtons) {
      document.getElementById(id)?.addEventListener('click', () => {
        const activeMesh = window.editMode?.targetMesh || window.sceneManager?.getActiveObject?.();
        if (activeMesh) {
          activeMesh.userData = activeMesh.userData || {};
          activeMesh.userData.editedInEditMode = true;
        }
        setTimeout(refreshHud, 60);
      });
    }

    document.getElementById('viewport-mode')?.addEventListener('change', () => {
      setTimeout(refreshHud, 40);
    });

    window.addEventListener('blender:geometryChanged', (e) => {
      if (e.detail) {
        e.detail.userData = e.detail.userData || {};
        e.detail.userData.editedInEditMode = true;
      }
      refreshHud();
    });

    window.addEventListener('blender:objectSelected', refreshHud);
    window.addEventListener('blender:transformChanged', refreshHud);

    const sm = this.app?.sceneManager || window.sceneManager;
    if (sm && typeof sm.on === 'function') {
      sm.on('objectAdded', refreshHud);
      sm.on('objectRemoved', refreshHud);
      sm.on('selectionChanged', refreshHud);
      sm.on('transformChanged', refreshHud);
    }

    // Nhận diện thao tác thật của học viên để tick hoàn thành bước (expectedAction).
    const act = (action) => this._markStepAction(action);

    window.addEventListener('blender:scriptExecuted', (e) => {
      this._lastExecutedCode = e.detail?.code || '';
      const callbacks = window.studio?._animationCallbacks;
      if (Array.isArray(callbacks) && callbacks.length) act('animate_started');
      refreshHud();
    });

    const engine = this.app?.engine || window.engine || window.studioEngine;
    engine?.controls?.addEventListener?.('start', () => act('navigate_view'));

    if (sm && typeof sm.on === 'function') {
      sm.on('objectAdded', ({ object } = {}) => {
        if (object?.isMesh) act('add_mesh');
        if (object?.isLight) act('add_light');
        if (object?.userData?.physics?.enabled) act('physics_enabled');
      });
      sm.on('transformChanged', () => act('transform_mesh'));
      sm.on('materialChanged', () => act('assign_material'));
    }

    window.addEventListener('blender:mode-changed', (e) => {
      if (e.detail?.mode === 'edit') act('enter_edit_mode');
      if (e.detail?.mode === 'sculpt') act('sculpt_active');
    });
    document.getElementById('viewport-mode')?.addEventListener('change', (e) => {
      if (e.target.value === 'edit') act('enter_edit_mode');
      if (e.target.value === 'sculpt') act('sculpt_active');
    });

    window.addEventListener('blender:geometryChanged', (e) => {
      act('edit_topology');
      const mesh = e.detail;
      if ((Array.isArray(mesh?.userData?.modifierStack) && mesh.userData.modifierStack.length) || mesh?.userData?.booleanOp) {
        act('modifier_applied');
      }
    });

    const timeline = this.app?.timelineEngine || window.timelineEngine;
    timeline?.on?.('keyframeAdded', () => act('animate_started'));
    timeline?.on?.('clipAttached', () => act('animate_started'));

    document.addEventListener('click', (e) => {
      const target = e.target;
      if (!(target instanceof Element)) return;
      if (target.closest('#btn-timeline-play')) act('animate_started');
      if (target.closest('#btn-focus-object')) act('focus_view');
      if (target.closest('#phys-play, #phys-apply')) act('physics_enabled');
      if (target.closest('.prop-tab-btn[data-tab="modifier"]')) act('open_modifiers');
      const dockTab = target.closest('.dock-tab');
      const step = this.activeLesson?.steps?.[this.activeStepIndex];
      if (dockTab && step?.panel && dockTab.dataset.pane === `dock-${step.panel}`) act('open_panel');
    });

    // Tự động né chuột (Cursor Evasion): Nếu chuột tiến sát Con trỏ Giáo viên (< 70px) khi đang chỉ vào nút,
    // con trỏ tự động dịch sang hướng đối diện của nút đó để không bao giờ cản thao tác click!
    window.addEventListener('pointermove', (e) => {
      this._lastCursorPos = { x: e.clientX, y: e.clientY };
      if (this._isDragging || !this._targetSelector || this.avatarPosition.pointerDirection === 'none') return;
      const cx = this.avatarPosition.x + 22;
      const cy = this.avatarPosition.y + 22;
      const dist = Math.hypot(e.clientX - cx, e.clientY - cy);
      if (dist < 62) {
        const el = document.querySelector(this._targetSelector);
        if (el) {
          const rect = el.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0) {
            const nextPos = computeAvatarTargetPosition(
              rect,
              { width: window.innerWidth, height: window.innerHeight },
              44,
              this._lastCursorPos
            );
            this.setAvatarPosition(nextPos.x, nextPos.y, {
              pointerDirection: nextPos.pointerDirection,
              bubbleSide: nextPos.bubbleSide,
              targetSelector: this._targetSelector,
              overlapsTarget: nextPos.overlapsTarget
            });
          }
        }
      }
    }, { passive: true });
  }

  _markStepAction(action) {
    if (!this.guidedActive || !this.activeLesson) return false;
    const idx = this.activeStepIndex;
    const step = this.activeLesson.steps?.[idx];
    if (!step || this._stepDone.has(idx)) return false;
    const expected = step.expectedAction;
    const matches = Array.isArray(expected) ? expected.includes(action) : expected === action;
    const openPanel = action === 'open_panel' && !expected && !!step.panel;
    if (!matches && !openPanel) return false;

    this._stepDone.add(idx);
    this._renderDockLessonDetail();
    if (idx + 1 < this.activeLesson.steps.length) {
      this.goToStep(idx + 1, { speak: true });
    } else {
      this.setBubbleContent({
        title: `${this.activeLesson.title} — Ready to Grade`,
        stepBadge: `Completed ${this.activeLesson.steps.length}/${this.activeLesson.steps.length}`,
        text: 'You have finished all practice steps! Click "✅ Grade Model" to see your score and XP.'
      });
    }
    return true;
  }

  _refreshGeometryHudBadge() {
    if (!this.dockContainer) return;
    const badgeEl = this.dockContainer.querySelector('#stem-live-geometry-badge');
    if (!badgeEl) return;
    const win = typeof window !== 'undefined' ? window : null;
    const summary = inspectSceneGeometrySummary(
      this.app?.sceneManager || win?.sceneManager,
      this.app?.editMode || win?.editMode
    );
    badgeEl.textContent = `Meshes: ${summary.meshCount} · Verts: ${summary.totalVertices} · Tris: ${summary.totalTriangles} · Mode: ${summary.activeMode.toUpperCase()}`;
  }

  // ===========================================================================
  // STEP-BY-STEP 1-ON-1 TUTORING & AUTO-GRADING
  // ===========================================================================

  startLesson(lessonIdOrNumber, { loadStarter = true, speak = true, guided = true, autoAdvance } = {}) {
    this._cancelPendingCoachRequest();
    this.stopWalkthrough({ stopVoice: true });
    this.guidedSequence = null;

    const lesson = getStemLesson(lessonIdOrNumber) || this.lessons[0];
    this.activeLesson = lesson;
    this.activeStepIndex = 0;
    this.lastGradeReport = null;
    this._stepDone = new Set();
    this.guidedActive = !!guided;

    this._prefetchLessonVoices(lesson);

    if (loadStarter && this.app?.codeEditor) {
      this.app.codeEditor.setCode(lesson.starterCode);
    }

    this._renderDockLessonList();
    this._renderDockLessonDetail();
    this._renderDockGradeReport();
    this._refreshGeometryHudBadge();

    if (guided) {
      const shouldAuto = (autoAdvance !== undefined) ? Boolean(autoAdvance) : Boolean(speak);
      if (shouldAuto) {
        this.startLessonAutoWalk({ fromIndex: 0, speak: Boolean(speak) });
      } else {
        this.goToStep(0, { speak: Boolean(speak) });
      }
    }
    return {
      lessonId: lesson.id,
      title: lesson.title,
      stepCount: lesson.steps.length
    };
  }

  /**
   * Tự động dẫn liên tục qua từng bước của bài học hiện tại (từ Bước 1 đến hết bài).
   */
  async startLessonAutoWalk({ fromIndex = this.activeStepIndex, speak = true } = {}) {
    const lesson = this.activeLesson;
    if (!lesson || !lesson.steps?.length) return null;

    this.stopWalkthrough({ stopVoice: true });
    this.guidedSequence = null;
    this.guidedActive = true;
    this._prefetchLessonVoices(lesson);

    const token = ++this._walkthroughToken;
    const startIdx = Math.max(0, Math.min(lesson.steps.length - 1, Number(fromIndex) || 0));

    // Hiển thị bước đầu đồng bộ ngay để các thao tác UI & test đọc vị trí chuẩn tức thì
    const initialRes = this.goToStep(startIdx, { speak: false, _keepWalkthrough: true });
    this.isAutoWalking = true;
    this._syncAutoWalkButtons();

    (async () => {
      try {
        for (let i = startIdx; i < lesson.steps.length; i += 1) {
          if (token !== this._walkthroughToken || this.activeLesson?.id !== lesson.id) return;
          const step = lesson.steps[i];
          if (i > startIdx) {
            this.goToStep(i, { speak: false, _keepWalkthrough: true });
          }
          if (token !== this._walkthroughToken) return;

          const spokeOk = await this._speakAndWait(step.voiceText, { speak, token });
          if (!spokeOk || token !== this._walkthroughToken) return;

          if (i + 1 < lesson.steps.length) {
            const gapOk = await this._sleepWalk(950, token);
            if (!gapOk || token !== this._walkthroughToken) return;
          }
        }

        if (token === this._walkthroughToken) {
          this.isAutoWalking = false;
          this._syncAutoWalkButtons();
          const doneMsg = `Đã hướng dẫn xong ${lesson.steps.length}/${lesson.steps.length} bước của ${lesson.title}! Bạn hãy bấm ✨ Demo để xem dựng mẫu hoặc ✅ Chấm điểm nhé.`;
          this.setBubbleContent({
            title: `${lesson.title} — Sẵn sàng chấm điểm`,
            stepBadge: `Hoàn tất ${lesson.steps.length}/${lesson.steps.length}`,
            text: doneMsg
          });
          if (speak) this.speak(doneMsg);
        }
      } catch (err) {
        if (token === this._walkthroughToken) {
          this.isAutoWalking = false;
          this._syncAutoWalkButtons();
        }
        console.warn('[StemTutorUI] startLessonAutoWalk warning:', err);
      }
    })();

    return initialRes;
  }

  toggleAutoWalk() {
    if (this.isAutoWalking) {
      this.pauseWalkthrough();
      return false;
    }
    if (this._pausedState) {
      return this.resumeWalkthrough({ speak: true });
    }
    if (Array.isArray(this.guidedSequence) && this.guidedSequence.length > 0) {
      const nextIdx = this.guidedSequenceIndex < this.guidedSequence.length - 1 ? this.guidedSequenceIndex : 0;
      this.guideSteps(this.guidedSequence, {
        speak: true,
        autoAdvance: true,
        startIndex: nextIdx,
        title: this.guidedSequenceTitle
      });
      return true;
    }
    this.startLessonAutoWalk({ fromIndex: this.activeStepIndex, speak: true });
    return true;
  }

  goToStep(stepIndex, { speak = true, _keepWalkthrough = false } = {}) {
    if (!_keepWalkthrough) {
      this.stopWalkthrough({ stopVoice: false });
      if (Array.isArray(this.guidedSequence) && this.guidedSequence.length > 0 && !_keepWalkthrough) {
        this.guidedSequence = null;
      }
    }
    const lesson = this.activeLesson;
    if (!lesson || !lesson.steps.length) return null;
    const idx = Math.max(0, Math.min(lesson.steps.length - 1, Number(stepIndex) || 0));
    this.activeStepIndex = idx;
    const step = lesson.steps[idx];

    // Prefetch next step audio for zero-latency step transitions
    if (lesson.steps[idx + 1]?.voiceText) {
      this.voice.prefetch(lesson.steps[idx + 1].voiceText);
    }

    if (step.panel && step.panel !== 'stem') {
      const dockTab = document.querySelector(`.dock-tab[data-pane="dock-${step.panel}"]`);
      if (dockTab && !document.getElementById('dock-stem')?.classList.contains('active')) {
        dockTab.click();
      }
    }

    const stepBadge = `Bước ${idx + 1}/${lesson.steps.length}`;
    this.setBubbleOpen(true);
    this.setBubbleContent({
      title: `${lesson.title} — ${step.title}`,
      stepBadge,
      text: `${step.voiceText}\n👉 ${step.actionHint}`,
      gradeBadge: null
    });

    this.moveToTarget(step.targetSelector, { openBubble: true, speak: false });
    if (speak) {
      this.speak(step.voiceText);
    }

    this._highlightActiveStepInDock();
    return {
      lessonId: lesson.id,
      stepIndex: idx,
      stepTitle: step.title,
      targetSelector: step.targetSelector,
      avatarPosition: { ...this.avatarPosition }
    };
  }

  nextStep({ speak = true } = {}) {
    this._cancelPendingCoachRequest();
    this.stopWalkthrough({ stopVoice: true });
    if (Array.isArray(this.guidedSequence) && this.guidedSequence.length > 0) {
      if (this.guidedSequenceIndex + 1 < this.guidedSequence.length) {
        this.guidedSequenceIndex += 1;
        const step = this.guidedSequence[this.guidedSequenceIndex];
        return this.executeAICommand(
          { ...step, stepBadge: `Bước ${this.guidedSequenceIndex + 1}/${this.guidedSequence.length}` },
          { speak }
        );
      }
      const doneSeq = 'Đã đi hết toàn bộ các bước hướng dẫn AI! Bạn có thể hỏi tiếp bất kỳ thao tác nào.';
      this.setBubbleContent({
        title: this.guidedSequenceTitle || '✅ Hoàn thành hướng dẫn',
        stepBadge: `${this.guidedSequence.length}/${this.guidedSequence.length}`,
        text: doneSeq
      });
      if (speak) this.speak(doneSeq);
      return { completedSteps: true, stepIndex: this.guidedSequenceIndex };
    }

    const lesson = this.activeLesson;
    if (!lesson) return null;
    if (this.activeStepIndex + 1 < lesson.steps.length) {
      return this.goToStep(this.activeStepIndex + 1, { speak });
    }
    const doneMsg = 'Bạn đã hoàn thành toàn bộ các bước hướng dẫn! Hãy xoay xem mô hình 3D hoặc bấm Chấm điểm.';
    this.setBubbleContent({
      title: `${lesson.title} — Sẵn sàng chấm điểm`,
      stepBadge: `Hoàn tất ${lesson.steps.length}/${lesson.steps.length}`,
      text: doneMsg
    });
    if (speak) this.speak(doneMsg);
    return {
      lessonId: lesson.id,
      stepIndex: this.activeStepIndex,
      completedSteps: true
    };
  }

  prevStep({ speak = true } = {}) {
    this._cancelPendingCoachRequest();
    this.stopWalkthrough({ stopVoice: true });
    if (Array.isArray(this.guidedSequence) && this.guidedSequence.length > 0) {
      this.guidedSequenceIndex = Math.max(0, this.guidedSequenceIndex - 1);
      const step = this.guidedSequence[this.guidedSequenceIndex];
      return this.executeAICommand(
        { ...step, stepBadge: `Bước ${this.guidedSequenceIndex + 1}/${this.guidedSequence.length}` },
        { speak }
      );
    }
    return this.goToStep(Math.max(0, this.activeStepIndex - 1), { speak });
  }

  async runLessonDemo({ speak = true, stepThrough } = {}) {
    this._cancelPendingCoachRequest();
    this.stopWalkthrough({ stopVoice: true });
    const demoToken = this._walkthroughToken;
    const lesson = this.activeLesson;
    if (!lesson) return null;
    this._usedAutoDemoLessons?.add(lesson.id);

    const interactiveWalk = stepThrough !== undefined ? Boolean(stepThrough) : Boolean(speak);

    // Chế độ tự động test/nhanh (speak: false): chạy solutionCode ngay lập tức
    if (!interactiveWalk || !lesson.steps?.length) {
      if (this.app?.codeEditor) {
        this.app.codeEditor.setCode(lesson.solutionCode);
        await this.app.codeEditor.execute();
      } else if (window.studio) {
        const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
        const fn = new AsyncFunction('studio', 'bpy', 'print', 'console', lesson.solutionCode);
        await fn(window.studio, window.studio.bpy, () => {}, console);
        this._lastExecutedCode = lesson.solutionCode;
      }

      if (demoToken !== this._walkthroughToken || this.activeLesson?.id !== lesson.id) {
        return { lessonId: lesson.id, demoExecuted: false, cancelled: true };
      }

      this._refreshGeometryHudBadge();
      const demoMsg = `Đã dựng xong mẫu ${lesson.title} ngay trong 3D Viewport! Bạn hãy xoay quan sát lưới rồi bấm Chấm điểm.`;
      this.moveToTarget('#viewport-canvas-host', {
        openBubble: true,
        title: `✨ Mẫu: ${lesson.title}`,
        stepBadge: 'Demo 1:1',
        speechText: demoMsg,
        speak
      });
      return {
        lessonId: lesson.id,
        demoExecuted: true
      };
    }

    // Chế độ Làm mẫu Tương tác từng bước: đi qua từng bước hướng dẫn rồi dựng hoàn thiện solutionCode
    const demoSteps = lesson.steps.map((st, idx) => {
      const isLast = idx === lesson.steps.length - 1;
      return {
        title: `✨ Mẫu · ${st.title}`,
        speech: st.voiceText,
        pointAt: st.targetSelector,
        openPanel: st.panel || null,
        demoCode: isLast ? lesson.solutionCode : null,
        delayMs: 850
      };
    });
    const res = await this.guideSteps(demoSteps, {
      speak,
      autoAdvance: true,
      title: `✨ Làm mẫu: ${lesson.title}`,
      sourceBadge: 'Auto-Demo'
    });
    return {
      ...res,
      lessonId: lesson.id,
      demoExecuted: true
    };
  }

  gradeCurrentLesson({ speak = true } = {}) {
    const lesson = this.activeLesson;
    if (!lesson) return null;

    // Chỉ chấm trên mã ĐÃ thực thi, không chấm chữ gõ dở trong editor.
    const code = this._lastExecutedCode || '';
    this.guidedActive = false;
    const win = typeof window !== 'undefined' ? window : null;
    const report = gradeStemLesson(lesson.id, {
      sceneManager: this.app?.sceneManager || win?.sceneManager,
      studio: win?.studio || this.app?.studio,
      timelineEngine: this.app?.timelineEngine || win?.timelineEngine,
      simulationManager: this.app?.simulationManager || win?.simulationManager,
      code
    });

    this.lastGradeReport = {
      ...report,
      usedAutoDemo: Boolean(this._usedAutoDemoLessons?.has(lesson.id)),
    };
    this._recordGrade(this.lastGradeReport);
    this._renderDockLessonList();
    this._renderDockGradeReport();
    this._refreshGeometryHudBadge();

    this.setBubbleOpen(true);
    this.setBubbleContent({
      title: `Result: ${lesson.title}`,
      stepBadge: `${report.passedCount}/${report.totalCriteria} criteria`,
      text: report.teacherVoiceSummary,
      gradeBadge: {
        text: `${report.score}/100 pts · ${report.gradeLetter}${this.lastGradeReport.usedAutoDemo ? ' · Auto-Demo' : ''}`,
        passed: report.passed
      }
    });

    if (speak) {
      this.speak(report.teacherVoiceSummary);
    }

    return report;
  }

  // ===========================================================================
  // COMPACT FLOATING TUTOR CURSOR (42px) & NON-INTRUSIVE HUD BAR
  // ===========================================================================

  _mountFloatingAvatar() {
    if (typeof document === 'undefined') return;
    const existing = document.getElementById('stem-agent-avatar-root');
    if (existing) existing.remove();

    const root = document.createElement('div');
    root.id = 'stem-agent-avatar-root';
    root.className = 'agent-ui-root stem-tutor-floating-root';

    root.innerHTML = `
      <!-- Target beacon highlight ring (100% pointer-events passthrough) -->
      <div class="stem-target-beacon" id="stem-target-beacon" style="display: none;"></div>

      <!-- Compact AI Tutor cursor (42x42px, separate from text bar so it never blocks UI) -->
      <div class="stem-avatar-host" id="stem-avatar-host" data-pointer="none" data-bubble-side="left">
        <div class="stem-avatar-pointer" aria-hidden="true">➤</div>
        <button type="button" class="stem-avatar-btn" id="stem-avatar-btn" title="1:1 AI Tutor Cursor (Drag to move · Click to toggle guide HUD)">
          <span class="stem-avatar-wave-ring ring-1"></span>
          <span class="stem-avatar-wave-ring ring-2"></span>
          <svg class="stem-avatar-svg" viewBox="0 0 64 64" width="28" height="28" aria-hidden="true">
            <defs>
              <linearGradient id="stemBotGrad" x1="0%" y1="0%" x2="100%" y2="100%">
                <stop offset="0%" stop-color="#00d2d3"/>
                <stop offset="100%" stop-color="#2e86de"/>
              </linearGradient>
            </defs>
            <polygon points="32,4 54,13 32,21 10,13" fill="#1e272e" stroke="#feca57" stroke-width="2.2"/>
            <rect x="13" y="19" width="38" height="31" rx="11" fill="url(#stemBotGrad)" stroke="#dff9fb" stroke-width="2"/>
            <rect x="18" y="24" width="28" height="19" rx="7" fill="#131922"/>
            <circle class="stem-bot-eye" cx="25.5" cy="32" r="3.2" fill="#48dbfb"/>
            <circle class="stem-bot-eye" cx="38.5" cy="32" r="3.2" fill="#48dbfb"/>
            <rect class="stem-bot-mouth" x="27" y="38" width="10" height="2.6" rx="1.3" fill="#1dd1a1"/>
          </svg>
          <span class="stem-avatar-badge">1:1</span>
        </button>
      </div>

      <!-- Compact 1:1 Tutor HUD Bar -->
      <div class="stem-speech-bubble" id="stem-speech-bubble" role="region" aria-label="1:1 AI Tutor Bar">
        <div class="stem-bubble-header">
          <div class="stem-bubble-title-wrap">
            <span class="stem-voice-indicator" id="stem-voice-indicator" title="Neural TTS Voice Status">
              <i class="bar b1"></i><i class="bar b2"></i><i class="bar b3"></i>
            </span>
            <span class="stem-bubble-title" id="stem-bubble-title">Giáo viên AI 1-1</span>
          </div>
          <div class="stem-bubble-header-right">
            <span class="stem-bubble-step-badge" id="stem-bubble-step-badge">Bước 1/4</span>
            <select id="stem-voice-rate-select" class="stem-rate-select" title="Tốc độ giọng nói Giáo viên">
              <option value="1.0">1.0x</option>
              <option value="1.2" selected>1.2x (Nhanh)</option>
              <option value="1.35">1.35x</option>
              <option value="1.5">1.5x</option>
            </select>
            <button type="button" class="stem-bubble-icon-btn" id="stem-bubble-mute-btn" title="Bật / Tắt giọng đọc">🔊</button>
            <button type="button" class="stem-bubble-icon-btn" id="stem-hud-minimize-btn" title="Thu gọn thanh hướng dẫn để nhìn rộng 3D">— Thu gọn</button>
            <button type="button" class="stem-bubble-icon-btn" id="stem-bubble-close-btn" title="Ẩn thanh hướng dẫn">✕</button>
          </div>
        </div>

        <div class="stem-hud-collapsible-body">
          <div class="stem-bubble-grade-badge" id="stem-bubble-grade-badge" style="display: none;"></div>
          <div class="stem-bubble-text" id="stem-bubble-text">
            Chào bạn! Hãy chọn bài học, hỏi trực tiếp ô bên dưới (ví dụ: "Hướng dẫn làm bàn 3D" hoặc "Cách dùng Extrude"), hoặc bật "🎧 Tự gọi" rồi nói "Thầy ơi..." / "Copilot ơi..."!
          </div>

          <!-- Ask AI Tutor Input Row -->
          <div class="stem-ai-ask-row">
            <input
              type="text"
              id="stem-ai-ask-input"
              class="stem-ai-ask-input"
              placeholder="💬 Hỏi Giáo viên AI (vd: Hướng dẫn Extrude, Vát cạnh Bevel, Làm cái bàn...)"
              autocomplete="off"
            />
            <button type="button" class="stem-b-btn stem-wake-btn" id="stem-wake-btn" title="Lệnh gọi tự khởi động (Alt+Shift+V): bật để gọi 'Thầy ơi...' hoặc 'Copilot ơi...' bất kỳ lúc nào">🎧 Tự gọi</button>
            <button type="button" class="stem-b-btn stem-mic-btn" id="stem-mic-btn" title="Nói chuyện trực tiếp (hands-free) với giáo viên AI">🎙 Live</button>
            <button type="button" class="stem-b-btn stem-mic-pause-btn" id="stem-mic-pause-btn" hidden title="Tạm ngắt hoặc bật lại mic trực tiếp theo nhịp của bạn">⏸ Ngắt mic</button>
            <button type="button" class="stem-b-btn ai-send" id="stem-ai-ask-btn" title="Gửi câu hỏi để Giáo viên AI chỉ từng bước trên màn hình">🤖 Hỏi AI</button>
          </div>

          <div class="stem-bubble-actions">
            <button type="button" class="stem-b-btn" id="stem-bubble-prev" title="Bước trước">◀ Trước</button>
            <button type="button" class="stem-b-btn primary" id="stem-bubble-next" title="Bước tiếp theo">Tiếp ▶</button>
            <button type="button" class="stem-b-btn autowalk" id="stem-bubble-autowalk" title="Tự động hướng dẫn lần lượt toàn bộ các bước không dừng ngang">▶ Tự chạy</button>
            <button type="button" class="stem-b-btn" id="stem-bubble-replay" title="Đọc lại bước hiện tại">🔊 Đọc lại</button>
            <button type="button" class="stem-b-btn demo" id="stem-bubble-demo" title="Giáo viên dựng mẫu từng bước ngay trên 3D Viewport">✨ Demo</button>
            <button type="button" class="stem-b-btn grade" id="stem-bubble-grade" title="Chấm điểm mô hình 3D hiện tại">✅ Chấm điểm</button>
            <button type="button" class="stem-b-btn" id="stem-bubble-open-dock" title="Mở bảng Giáo trình 3D">📚 Bài học</button>
          </div>
        </div>
      </div>
    `;

    document.body.appendChild(root);

    this.floatingRoot = root;
    this.beaconEl = root.querySelector('#stem-target-beacon');
    this.avatarHost = root.querySelector('#stem-avatar-host');
    this.avatarBtn = root.querySelector('#stem-avatar-btn');
    this.bubbleEl = root.querySelector('#stem-speech-bubble');
    this.bubbleTitleEl = root.querySelector('#stem-bubble-title');
    this.bubbleStepBadgeEl = root.querySelector('#stem-bubble-step-badge');
    this.bubbleGradeBadgeEl = root.querySelector('#stem-bubble-grade-badge');
    this.bubbleTextEl = root.querySelector('#stem-bubble-text');
    this.bubbleMuteBtn = root.querySelector('#stem-bubble-mute-btn');
    this.voiceRateSelect = root.querySelector('#stem-voice-rate-select');
    this.aiAskInput = root.querySelector('#stem-ai-ask-input');
    this.aiAskBtn = root.querySelector('#stem-ai-ask-btn');

    this._bindAvatarDragAndActions();
  }

  _bindAvatarDragAndActions() {
    if (!this.avatarBtn) return;

    let startX = 0;
    let startY = 0;
    let originX = 0;
    let originY = 0;

    const onPointerMove = (e) => {
      if (!this._isDragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      if (Math.hypot(dx, dy) > 5) {
        this._dragMoved = true;
        this.avatarHost?.classList.add('dragging');
      }
      if (this._dragMoved) {
        this._targetSelector = null;
        this.setAvatarPosition(originX + dx, originY + dy, { pointerDirection: 'none' });
      }
    };

    const onPointerUp = () => {
      if (!this._isDragging) return;
      this._isDragging = false;
      this.avatarHost?.classList.remove('dragging');
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
    };

    this.avatarBtn.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 && e.pointerType === 'mouse') return;
      this._isDragging = true;
      this._dragMoved = false;
      startX = e.clientX;
      startY = e.clientY;
      originX = this.avatarPosition.x;
      originY = this.avatarPosition.y;
      window.addEventListener('pointermove', onPointerMove);
      window.addEventListener('pointerup', onPointerUp);
    });

    this.avatarBtn.addEventListener('click', () => {
      if (this._dragMoved) {
        this._dragMoved = false;
        return;
      }
      if (!this.bubbleOpen) {
        this.setBubbleOpen(true);
        this.setHudMinimized(false);
      } else {
        this.setHudMinimized(!this.hudMinimized);
      }
    });

    this.floatingRoot.querySelector('#stem-hud-minimize-btn')?.addEventListener('click', () => {
      this.setHudMinimized(!this.hudMinimized);
    });

    this.floatingRoot.querySelector('#stem-bubble-close-btn')?.addEventListener('click', () => {
      this._cancelPendingCoachRequest();
      this.stopWalkthrough({ stopVoice: true });
      this.setBubbleOpen(false);
      this.parkAvatar();
    });

    this.floatingRoot.querySelector('#stem-bubble-autowalk')?.addEventListener('click', () => {
      this.toggleAutoWalk();
    });

    this.bubbleMuteBtn?.addEventListener('click', () => {
      this.toggleVoice();
    });

    this.voiceRateSelect?.addEventListener('change', (e) => {
      this.setVoiceRate(Number(e.target.value) || 1.2);
    });

    const submitAIQuestion = () => {
      const q = this.aiAskInput?.value?.trim();
      if (!q || this._aiCoachBusy) return;
      this.aiAskInput.value = '';
      this.askAICoach(q, { speak: true });
    };

    this.aiAskBtn?.addEventListener('click', submitAIQuestion);
    this.aiAskInput?.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        e.preventDefault();
        submitAIQuestion();
      }
    });

    this.floatingRoot.querySelector('#stem-bubble-prev')?.addEventListener('click', () => {
      this.prevStep({ speak: true });
    });

    this.floatingRoot.querySelector('#stem-bubble-next')?.addEventListener('click', () => {
      this.nextStep({ speak: true });
    });

    this.floatingRoot.querySelector('#stem-bubble-replay')?.addEventListener('click', () => {
      const seqStep = Array.isArray(this.guidedSequence) ? this.guidedSequence[this.guidedSequenceIndex] : null;
      const lessonStep = this.activeLesson?.steps?.[this.activeStepIndex];
      const text = this.currentBubbleText || seqStep?.speech || lessonStep?.voiceText || 'Xin chào! Hãy chọn một bước hoặc đặt câu hỏi cho mình.';
      this.speak(text, { force: true });
    });

    this.floatingRoot.querySelector('#stem-bubble-demo')?.addEventListener('click', () => {
      this.runLessonDemo({ speak: true, stepThrough: true });
    });

    this.floatingRoot.querySelector('#stem-bubble-grade')?.addEventListener('click', () => {
      this.gradeCurrentLesson({ speak: true });
    });

    this.floatingRoot.querySelector('#stem-bubble-open-dock')?.addEventListener('click', () => {
      this.openStemDock();
    });

    window.addEventListener('resize', () => {
      this.setAvatarPosition(this.avatarPosition.x, this.avatarPosition.y, {
        pointerDirection: this.avatarPosition.pointerDirection
      });
    });
  }

  _onVoiceStateChange({ isSpeaking, text }) {
    if (this.avatarHost) {
      this.avatarHost.classList.toggle('speaking', !!isSpeaking);
    }
    if (this.bubbleEl) {
      this.bubbleEl.classList.toggle('speaking', !!isSpeaking);
    }
    // Live voice: giáo viên bắt đầu đọc -> bật chế độ bắt barge-in + chống vọng loa;
    // đọc xong -> quay lại nghe nếu phiên vẫn đang mở.
    if (this.voiceSession) {
      if (isSpeaking) this.voiceSession.notifyAssistantSpeaking(text);
      else this.voiceSession.notifyAssistantIdle();
    }
    this._syncVoiceButtons();
  }

  _syncVoiceButtons() {
    const enabled = this.voice.enabled;
    if (this.bubbleMuteBtn) {
      this.bubbleMuteBtn.textContent = enabled ? '🔊' : '🔇';
      this.bubbleMuteBtn.title = enabled ? 'Đang bật giọng nói (Click để tắt tiếng)' : 'Đang tắt tiếng (Click để bật)';
    }
    if (this.dockVoiceBtn) {
      this.dockVoiceBtn.textContent = enabled ? `🔊 Giọng: ${this.voice.rate}x` : '🔇 Giọng: TẮT';
      this.dockVoiceBtn.classList.toggle('active', enabled);
    }
    if (this.voiceRateSelect && String(this.voice.rate) !== this.voiceRateSelect.value) {
      this.voiceRateSelect.value = String(this.voice.rate);
    }
  }

  // ===========================================================================
  // LIVE VOICE (HANDS-FREE 1-1): micro liên tục, tự gửi câu hỏi, ngắt lời TTS
  // ===========================================================================

  toggleLiveVoice() {
    if (!this.voiceCoordinator) return false;
    const isDirectStem = this.voiceCoordinator.mode === 'stem' && this.voiceSession?.isActive;
    if (isDirectStem) {
      this.voiceCoordinator.toggleDirectMode('stem');
      this._syncMicButton();
      this.setBubbleContent({
        title: this.voiceCoordinator.wakeEnabled ? '🎧 Đang chuyển về chế độ chờ lệnh gọi' : '🎙 Đã tắt micro trực tiếp',
        stepBadge: this.voiceCoordinator.wakeEnabled ? 'Wake' : 'Voice off',
        text: this.voiceCoordinator.wakeEnabled
          ? 'Đã tắt micro nói liên tục; bạn vẫn có thể gọi "Thầy ơi..." hoặc "Copilot ơi..." bất kỳ lúc nào.'
          : 'Bật lại bằng nút 🎙 Live hoặc 🎧 Tự gọi (Alt+Shift+V).'
      });
      return false;
    }

    const started = this.voiceCoordinator.startDirectMode('stem');
    this._syncMicButton();
    if (started) {
      this.voice.stop();
      this.setBubbleOpen(true);
      this.setHudMinimized(false);
      this.setBubbleContent({
        title: '🎙 Đang nghe trực tiếp (chờ bạn nói)',
        stepBadge: 'Live',
        text: 'Mình đang giữ im lặng lắng nghe. Hãy nói câu hỏi của bạn (hoặc bấm ⏸ Ngắt mic / 🎙 để tắt); nói chen bất kỳ lúc nào khi muốn ngắt lời.'
      });
    }
    return started;
  }

  toggleVoicePause() {
    if (!this.voiceCoordinator || !this.voiceSession?.isActive) return false;
    const active = this.voiceCoordinator.togglePauseVoice();
    if (this.voiceSession.isPaused) {
      this.voice.stop();
      this.setBubbleContent({
        title: '⏸ Đã tạm ngắt micro trực tiếp',
        stepBadge: 'Mic tạm ngắt',
        text: 'Micro đang tạm nghỉ để bạn thao tác. Bấm ▶ Nghe tiếp bất kỳ lúc nào để nói tiếp.'
      });
    } else {
      this.setBubbleContent({
        title: '🎙 Đã bật lại micro trực tiếp',
        stepBadge: 'Live',
        text: 'Mình đang nghe câu hỏi tiếp theo của bạn.'
      });
    }
    this._syncMicButton();
    return active;
  }

  toggleWakeListening() {
    if (!this.voiceCoordinator) return false;
    const enabled = this.voiceCoordinator.toggleWakeMode();
    this._syncMicButton();
    if (enabled) {
      this.setBubbleOpen(true);
      this.setHudMinimized(false);
      this.setBubbleContent({
        title: '🎧 Đã bật Lệnh Gọi Tự Khởi Động (Hands-Free)',
        stepBadge: 'Wake ON',
        text: 'Hãy gọi "Thầy ơi..." để nhờ Giáo viên hướng dẫn từng bước, hoặc gọi "Copilot ơi..." để AI tự mở và dựng mô hình 3D!'
      });
      this.speak('Đã bật chế độ chờ lệnh gọi. Bạn có thể gọi Thầy ơi hoặc Copilot ơi bất kỳ lúc nào.');
    } else {
      this.setBubbleContent({
        title: '🔇 Đã tắt chế độ chờ lệnh gọi',
        stepBadge: 'Wake OFF',
        text: 'Bấm 🎧 Tự gọi hoặc nhấn Alt+Shift+V bất kỳ lúc nào để bật lại.'
      });
    }
    return enabled;
  }

  _onStemWakeOnly() {
    this.setBubbleOpen(true);
    this.setHudMinimized(false);
    this.setBubbleContent({
      title: '👋 Dạ mình đang nghe đây!',
      stepBadge: 'Đã gọi',
      text: 'Bạn muốn học bài nào hoặc hỏi thao tác nào (ví dụ: "Hướng dẫn dùng Extrude" hoặc "Tự chạy bài học")?'
    });
    this.speak('Dạ mình đang nghe, bạn muốn hướng dẫn phần nào?');
  }

  async _handleVoiceCommand(decision) {
    const cmd = decision?.command;
    if (!cmd) return;
    if (cmd === 'next_step') {
      this.nextStep({ speak: true });
    } else if (cmd === 'prev_step') {
      this.prevStep({ speak: true });
    } else if (cmd === 'auto_walk') {
      this.setBubbleOpen(true);
      if (this._pausedState) this.resumeWalkthrough({ speak: true });
      else this.toggleAutoWalk();
    } else if (cmd === 'resume_walk') {
      this.setBubbleOpen(true);
      if (!this.resumeWalkthrough({ speak: true })) {
        this.toggleAutoWalk();
      }
    } else if (cmd === 'pause_walk') {
      this.pauseWalkthrough();
    } else if (cmd === 'replay') {
      const step = this.activeLesson?.steps?.[this.activeStepIndex];
      const text = this.currentBubbleText || (step ? step.voiceText : 'Xin chào!');
      this.speak(text, { force: true });
    } else if (cmd === 'demo') {
      await this.runLessonDemo({ speak: true, stepThrough: true });
    } else if (cmd === 'grade') {
      this.gradeCurrentLesson({ speak: true });
    } else if (cmd === 'open_stem') {
      this.openStemDock();
      this.setBubbleOpen(true);
      this.setHudMinimized(false);
      this.speak('Đã mở giáo trình và giáo viên AI.');
    } else if (cmd === 'close_stem') {
      this.stopWalkthrough({ stopVoice: true });
      this.setBubbleOpen(false);
      this.parkAvatar();
    } else if (cmd === 'open_copilot') {
      const cop = window.aiCopilot || this.app?.aiCopilot;
      cop?.show?.();
      this.speak('Đã mở AI Copilot 3D.');
    } else if (cmd === 'close_copilot') {
      const cop = window.aiCopilot || this.app?.aiCopilot;
      cop?.hide?.();
    }
  }

  _bindVoiceSession() {
    if (typeof document === 'undefined') return;
    this._injectVoiceSessionStyles();
    this.micBtn = this.floatingRoot?.querySelector('#stem-mic-btn') || null;
    this.micPauseBtn = this.floatingRoot?.querySelector('#stem-mic-pause-btn') || null;
    this.wakeBtn = this.floatingRoot?.querySelector('#stem-wake-btn') || null;
    if (this.micBtn) {
      this.micBtn.addEventListener('click', () => this.toggleLiveVoice());
    }
    if (this.micPauseBtn) {
      this.micPauseBtn.addEventListener('click', () => this.toggleVoicePause());
    }
    if (this.wakeBtn) {
      this.wakeBtn.addEventListener('click', () => this.toggleWakeListening());
    }
    this._syncMicButton();
  }

  _injectVoiceSessionStyles() {
    if (document.getElementById('stem-voice-session-styles')) return;
    const style = document.createElement('style');
    style.id = 'stem-voice-session-styles';
    style.textContent = `
      .stem-mic-btn, .stem-wake-btn, .stem-mic-pause-btn { background: #2b2f36; border: 1px solid #4a5058; color: #e6edf3; white-space: nowrap; }
      .stem-mic-btn:hover, .stem-wake-btn:hover, .stem-mic-pause-btn:hover { background: #3a4048; }
      .stem-mic-btn.active { background: #c0392b; border-color: #ff7675; color: #fff; animation: stemMicPulse 1.3s ease-in-out infinite; }
      .stem-mic-btn.paused { background: #57606f; border-color: #a4b0be; color: #fff; animation: none; }
      .stem-mic-pause-btn.active { background: #2f3640; border-color: #1dd1a1; color: #1dd1a1; }
      .stem-mic-btn.thinking { background: #8e6e1f; border-color: #feca57; color: #fff; }
      .stem-wake-btn.active { background: #0d7a5f; border-color: #1dd1a1; color: #fff; animation: stemWakePulse 2.2s ease-in-out infinite; }
      .stem-wake-btn.armed { background: #1e3a5f; border-color: #54a0ff; color: #dff9fb; }
      .stem-b-btn.autowalk.active, .stem-action-btn.autowalk.active { background: #d35400; border-color: #ff9f43; color: #fff; font-weight: 600; }
      @keyframes stemMicPulse { 0%,100% { box-shadow: 0 0 0 0 rgba(255,118,117,.55); } 50% { box-shadow: 0 0 0 7px rgba(255,118,117,0); } }
      @keyframes stemWakePulse { 0%,100% { box-shadow: 0 0 0 0 rgba(29,209,161,.45); } 50% { box-shadow: 0 0 0 6px rgba(29,209,161,0); } }
      .stem-speech-bubble.listening .stem-bubble-text { border-left: 3px solid #ff7675; padding-left: 8px; }
    `;
    document.head.appendChild(style);
  }

  _syncMicButton(state = this.voiceSession?.state) {
    const snap = this.voiceCoordinator?.getSnapshot?.() || {};
    if (this.wakeBtn) {
      const wakeListening = snap.mode === 'wake' && snap.isActive;
      const wakeArmed = Boolean(snap.wakeEnabled && snap.autoWakePendingGesture && !snap.isActive);
      this.wakeBtn.classList.toggle('active', wakeListening);
      this.wakeBtn.classList.toggle('armed', wakeArmed);
      if (wakeListening) {
        this.wakeBtn.textContent = '🎧 Đang chờ gọi';
        this.wakeBtn.title = 'Đang nghe lệnh gọi "Thầy ơi" / "Copilot ơi" (Alt+Shift+V để tắt)';
      } else if (wakeArmed) {
        this.wakeBtn.textContent = '🎧 Chờ chạm…';
        this.wakeBtn.title = 'Tự động bật nghe lệnh gọi ngay khi bạn click/chạm vào ứng dụng (hoặc bấm trực tiếp)';
      } else {
        this.wakeBtn.textContent = '🎧 Tự gọi';
        this.wakeBtn.title = 'Bật Lệnh gọi tự khởi động (Alt+Shift+V): gọi "Thầy ơi..." hoặc "Copilot ơi..." bất kỳ lúc nào';
      }
    }

    if (this.micPauseBtn) {
      this.micPauseBtn.hidden = !snap.isActive;
      this.micPauseBtn.classList.toggle('active', Boolean(snap.isPaused));
      this.micPauseBtn.textContent = snap.isPaused ? '▶ Nghe tiếp' : '⏸ Ngắt mic';
      this.micPauseBtn.title = snap.isPaused ? 'Bật lại micro trực tiếp' : 'Tạm ngắt micro trực tiếp (không cần nói câu dài)';
    }

    if (!this.micBtn) return;
    const isDirectStem = snap.mode === 'stem' && snap.isActive;
    const active = Boolean(this.voiceSession?.isActive) && (isDirectStem || snap.mode === 'wake');
    this.micBtn.classList.toggle('active', isDirectStem && !snap.isPaused);
    this.micBtn.classList.toggle('paused', Boolean(snap.isActive && snap.isPaused));
    this.micBtn.classList.toggle('thinking', state === 'thinking');
    if (snap.isActive && snap.isPaused) {
      this.micBtn.textContent = '⏸ Mic tạm ngắt';
      this.micBtn.title = 'Micro đang tạm ngắt — bấm để tắt hẳn hoặc bấm ▶ Nghe tiếp';
      return;
    }
    if (!isDirectStem && !active) {
      this.micBtn.textContent = '🎙 Live';
      this.micBtn.title = 'Bật chế độ nói chuyện trực tiếp (hands-free) với giáo viên AI';
      return;
    }
    if (state === 'thinking') {
      this.micBtn.textContent = '🤔 Đang xử lý…';
      this.micBtn.title = 'Đang gửi câu hỏi tới giáo viên AI';
    } else if (state === 'speaking') {
      this.micBtn.textContent = '🔊 Đang giảng (nói để ngắt)';
      this.micBtn.title = 'Giáo viên đang giảng — nói chen vào để ngắt lời';
    } else if (isDirectStem) {
      this.micBtn.textContent = '🎙 Đang nghe…';
      this.micBtn.title = 'Đang nghe trực tiếp — bấm để tắt';
    } else {
      this.micBtn.textContent = '🎙 Live';
      this.micBtn.title = 'Chuyển sang nói chuyện liên tục với giáo viên AI (không cần lặp từ khóa gọi)';
    }
  }

  _onVoiceTranscript({ text, mode } = {}) {
    if (!this.aiAskInput || mode === 'copilot') return;
    this.aiAskInput.value = text ? text : '';
  }

  async _onVoiceSubmit({ text } = {}) {
    const question = String(text || '').trim();
    if (!question) return;
    this.setBubbleOpen(true);
    this.setHudMinimized(false);
    if (this.aiAskInput) this.aiAskInput.value = question;
    try {
      await this.askAICoach(question, { speak: true });
    } catch (err) {
      console.warn('[StemTutorUI] voice submit failed:', err);
      this._onVoiceSessionError({ code: 'E_SUBMIT', message: 'Không lấy được câu trả lời từ giáo viên AI. Hãy thử lại.' });
    } finally {
      // Nếu TTS đang tắt, không có state 'speaking' nên phiên vẫn ở 'thinking'.
      if (this.voiceSession?.state === 'thinking') this.voiceSession.notifyAssistantIdle();
      this._syncMicButton();
    }
  }

  _onVoiceBargeIn({ mode } = {}) {
    if (mode === 'copilot') return;
    this._cancelPendingCoachRequest();
    this.stopWalkthrough({ stopVoice: true });
    this.setBubbleContent({
      title: '🎙 Mình đang nghe bạn…',
      stepBadge: 'Live',
      text: 'Giáo viên đã dừng giảng để nghe câu hỏi mới của bạn.'
    });
    this._syncMicButton('listening');
  }

  _onVoiceSessionState(state) {
    if (this.bubbleEl) {
      this.bubbleEl.classList.toggle('listening', state === 'listening' && Boolean(this.voiceSession?.isActive));
    }
    this._syncMicButton(state);
  }

  _onVoiceSessionError({ code, message } = {}) {
    const text = message || 'Không dùng được micro trên trình duyệt này.';
    this.setBubbleContent({ title: '⚠️ Lỗi micro', stepBadge: code || 'Voice error', text });
    this.setBubbleOpen(true);
    this._syncMicButton();
  }

  // ===========================================================================
  // DỰNG BẢNG GIÁO TRÌNH DỰNG HÌNH 3D (#dock-stem)
  // ===========================================================================

  openStemDock() {
    if (typeof document === 'undefined') return;
    const tab = document.querySelector('.dock-tab[data-pane="dock-stem"]');
    if (tab) {
      tab.click();
      const dock = document.getElementById('bottom-dock');
      if (dock && dock.getBoundingClientRect().height < 340) {
        dock.style.height = '380px';
        this.app?.engine?.onResize?.();
      }
    }
  }

  _bindHeaderTrigger() {
    if (typeof document === 'undefined') return;
    const btn = document.getElementById('btn-help-stem-tutor');
    btn?.addEventListener('click', () => {
      this.voiceCoordinator?.maybeAutoStartOnAssistantOpen?.(window);
      this.openStemDock();
      this.startLesson(this.activeLesson?.id || 'lesson-01-primitives', { loadStarter: false, speak: true, guided: true });
    });
  }

  _mountDockPanel() {
    if (typeof document === 'undefined') return;
    const container = document.getElementById('dock-stem');
    if (!container) return;

    container.innerHTML = `
      <div class="stem-dock-layout">
        <!-- Column 1: 6 3D Modeling Lessons & XP Progress -->
        <aside class="stem-sidebar">
          <div class="stem-sidebar-header">
            <div>
              <div class="stem-sidebar-title">🎓 Interactive 3D Modeling Curriculum (1-1)</div>
              <div class="stem-sidebar-sub" id="stem-xp-summary">0 XP · 0/6 lessons completed</div>
            </div>
            <select id="stem-filter-level" class="stem-level-select" title="Filter lessons by level">
              <option value="all">All Levels (6 lessons)</option>
              <option value="Cơ bản">Beginner (Object & Edit Mode)</option>
              <option value="Trung cấp">Intermediate (Modifiers & Sculpt)</option>
              <option value="Nâng cao">Advanced (Rig, Mocap & Physics)</option>
            </select>
          </div>
          <div class="stem-lesson-list" id="stem-lesson-list"></div>
        </aside>

        <!-- Column 2: Lesson Details, Ask AI Tutor & Interactive Steps -->
        <section class="stem-main-panel">
          <div class="stem-lesson-toolbar">
            <div class="stem-lesson-heading">
              <span class="stem-level-pill" id="stem-detail-level">Beginner</span>
              <h3 class="stem-detail-title" id="stem-detail-title">Lesson 1</h3>
              <span class="stem-geometry-pill" id="stem-live-geometry-badge" title="Real-time geometry statistics in the 3D scene">Objects: 0 · Vertices: 0</span>
            </div>
            <div class="stem-toolbar-actions">
              <button type="button" class="stem-action-btn" id="stem-btn-voice-toggle" title="Bật / Tắt giọng đọc Giáo viên">🔊 Giọng: 1.2x</button>
              <button type="button" class="stem-action-btn autowalk" id="stem-btn-autowalk" title="Tự động hướng dẫn liên tục hết các bước">▶ Dẫn hết bài</button>
              <button type="button" class="stem-action-btn" id="stem-btn-summon-avatar" title="Triệu hồi con trỏ Giáo viên chỉ vào bước hiện tại">🤖 Chỉ bước này</button>
              <button type="button" class="stem-action-btn" id="stem-btn-load-starter" title="Nạp khung code mẫu của bài">📝 Nạp khung</button>
              <button type="button" class="stem-action-btn demo" id="stem-btn-run-demo" title="Giáo viên AI vừa giảng từng bước vừa dựng mẫu 3D">✨ Auto-Demo</button>
              <button type="button" class="stem-action-btn grade" id="stem-btn-grade" title="Chấm điểm lưới 3D, modifier, vật liệu PBR & hoạt cảnh">✅ Chấm điểm</button>
            </div>
          </div>

          <div class="stem-detail-body">
            <!-- Ask AI Tutor inline bar (driven directly by your active AI model) -->
            <div class="stem-dock-ai-coach-bar">
              <input
                type="text"
                id="stem-dock-ai-input"
                class="stem-ai-ask-input"
                placeholder="🤖 Ask AI Tutor directly (e.g., 'How to extrude a house', 'How to bevel edges', 'Demo a 3D chair')..."
                autocomplete="off"
              />
              <button type="button" class="stem-action-btn ai-coach" id="stem-dock-ai-btn">🚀 Ask AI &amp; Demo</button>
            </div>

            <p class="stem-detail-summary" id="stem-detail-summary"></p>
            <div class="stem-objectives-box">
              <div class="stem-box-label">🎯 Target 3D Modeling Skills:</div>
              <ul class="stem-objectives-list" id="stem-objectives-list"></ul>
            </div>

            <div class="stem-steps-box">
              <div class="stem-box-label">🧭 Interactive UI Steps (Click any step so the AI Tutor cursor points to the button and explains):</div>
              <div class="stem-steps-list" id="stem-steps-list"></div>
            </div>
          </div>
        </section>

        <!-- Column 3: Automatic 3D Geometry & Topology Grader -->
        <aside class="stem-grader-panel">
          <div class="stem-grader-header">
            <span>📊 3D Geometry Evaluation</span>
            <span class="stem-score-pill" id="stem-grader-score-pill">Not graded</span>
          </div>
          <div class="stem-grader-body" id="stem-grader-body"></div>
        </aside>
      </div>
    `;

    this.dockContainer = container;
    this.dockLessonListEl = container.querySelector('#stem-lesson-list');
    this.dockXpSummaryEl = container.querySelector('#stem-xp-summary');
    this.dockLevelSelect = container.querySelector('#stem-filter-level');
    this.dockVoiceBtn = container.querySelector('#stem-btn-voice-toggle');
    this.dockAiInput = container.querySelector('#stem-dock-ai-input');
    this.dockAiBtn = container.querySelector('#stem-dock-ai-btn');

    this.dockLevelSelect?.addEventListener('change', (e) => {
      this.levelFilter = e.target.value;
      this._renderDockLessonList();
    });

    this.dockVoiceBtn?.addEventListener('click', () => {
      this.toggleVoice();
    });

    const submitDockAI = () => {
      const q = this.dockAiInput?.value?.trim();
      if (!q || this._aiCoachBusy) return;
      this.dockAiInput.value = '';
      this.askAICoach(q, { speak: true });
    };
    this.dockAiBtn?.addEventListener('click', submitDockAI);
    this.dockAiInput?.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        e.preventDefault();
        submitDockAI();
      }
    });

    container.querySelector('#stem-btn-autowalk')?.addEventListener('click', () => {
      this.toggleAutoWalk();
    });

    container.querySelector('#stem-btn-summon-avatar')?.addEventListener('click', () => {
      this.goToStep(this.activeStepIndex, { speak: true });
    });

    container.querySelector('#stem-btn-load-starter')?.addEventListener('click', () => {
      if (this.activeLesson && this.app?.codeEditor) {
        this.app.codeEditor.setCode(this.activeLesson.starterCode);
        document.querySelector('.dock-tab[data-pane="dock-scripting"]')?.click();
        this.moveToTarget('#dock-scripting', {
          openBubble: true,
          title: this.activeLesson.title,
          stepBadge: 'Starter',
          speechText: 'Starter template loaded. You can edit directly with Viewport tools or click Run!',
          speak: true
        });
      }
    });

    container.querySelector('#stem-btn-run-demo')?.addEventListener('click', () => {
      this.runLessonDemo({ speak: true, stepThrough: true });
    });

    container.querySelector('#stem-btn-grade')?.addEventListener('click', () => {
      this.gradeCurrentLesson({ speak: true });
    });

    this._renderDockLessonList();
    this._renderDockLessonDetail();
    this._renderDockGradeReport();
    this._syncVoiceButtons();
    this._refreshGeometryHudBadge();
  }

  _renderDockLessonList() {
    if (!this.dockLessonListEl) return;
    const completedCount = this.lessons.filter(l => this.progress.completed[l.id]).length;
    if (this.dockXpSummaryEl) {
      this.dockXpSummaryEl.textContent = `${this.progress.totalXp} XP · ${completedCount}/${this.lessons.length} lessons completed`;
    }

    const filtered = this.lessons.filter(l =>
      this.levelFilter === 'all' || String(l.level).toLowerCase().startsWith(this.levelFilter.toLowerCase())
    );
    this.dockLessonListEl.innerHTML = '';

    for (const lesson of filtered) {
      const isSelected = this.activeLesson?.id === lesson.id;
      const isDone = !!this.progress.completed[lesson.id];
      const best = this.progress.bestScores[lesson.id];

      const card = document.createElement('div');
      card.className = `stem-lesson-card ${isSelected ? 'active' : ''} ${isDone ? 'completed' : ''}`;
      card.dataset.lessonId = lesson.id;
      card.innerHTML = `
        <div class="stem-card-top">
          <span class="stem-card-level">${escapeHtml({ 'Cơ bản': 'Beginner', 'Trung cấp': 'Intermediate', 'Nâng cao': 'Advanced' }[lesson.level] || lesson.level)}</span>
          <span class="stem-card-status">${isDone ? `✅ ${escapeHtml(best)}/100` : (best !== undefined ? `${escapeHtml(best)}/100` : `+${escapeHtml(lesson.xp)} XP`)}</span>
        </div>
        <div class="stem-card-title">${escapeHtml(lesson.title)}</div>
      `;
      card.addEventListener('click', () => {
        this.startLesson(lesson.id, { loadStarter: true, speak: true, guided: true });
      });
      this.dockLessonListEl.appendChild(card);
    }
  }

  _renderDockLessonDetail() {
    if (!this.dockContainer || !this.activeLesson) return;
    const lesson = this.activeLesson;

    const levelEl = this.dockContainer.querySelector('#stem-detail-level');
    const titleEl = this.dockContainer.querySelector('#stem-detail-title');
    const summaryEl = this.dockContainer.querySelector('#stem-detail-summary');
    const objListEl = this.dockContainer.querySelector('#stem-objectives-list');
    const stepsListEl = this.dockContainer.querySelector('#stem-steps-list');

    if (levelEl) levelEl.textContent = `${({ 'Cơ bản': 'Beginner', 'Trung cấp': 'Intermediate', 'Nâng cao': 'Advanced' }[lesson.level] || lesson.level)} · ${lesson.durationMinutes}m · ${lesson.xp} XP`;
    if (titleEl) titleEl.textContent = lesson.title;
    if (summaryEl) summaryEl.textContent = lesson.summary;

    if (objListEl) {
      objListEl.innerHTML = lesson.objectives.map(o => `<li>${escapeHtml(o)}</li>`).join('');
    }

    if (stepsListEl) {
      stepsListEl.innerHTML = '';
      lesson.steps.forEach((step, idx) => {
        const row = document.createElement('div');
        const done = this._stepDone.has(idx);
        row.className = `stem-step-item ${idx === this.activeStepIndex ? 'active' : ''} ${done ? 'done' : ''}`;
        row.dataset.stepIndex = String(idx);
        row.innerHTML = `
          <div class="stem-step-num">${done ? '✓' : idx + 1}</div>
          <div class="stem-step-info">
            <div class="stem-step-title">${escapeHtml(step.title)} <span class="stem-step-target-tag">${escapeHtml(step.targetSelector)}</span></div>
            <div class="stem-step-voice">"${escapeHtml(step.voiceText)}"</div>
            <div class="stem-step-hint">👉 ${escapeHtml(step.actionHint)}</div>
          </div>
        `;
        row.addEventListener('click', () => {
          this.goToStep(idx, { speak: true });
        });
        stepsListEl.appendChild(row);
      });
    }
  }

  _highlightActiveStepInDock() {
    if (!this.dockContainer) return;
    this.dockContainer.querySelectorAll('.stem-step-item').forEach((el) => {
      el.classList.toggle('active', Number(el.dataset.stepIndex) === this.activeStepIndex);
    });
  }

  _renderDockGradeReport() {
    if (!this.dockContainer || !this.activeLesson) return;
    const scorePill = this.dockContainer.querySelector('#stem-grader-score-pill');
    const body = this.dockContainer.querySelector('#stem-grader-body');
    if (!body) return;

    const report = this.lastGradeReport;
    if (!report || report.lessonId !== this.activeLesson.id) {
      if (scorePill) {
        scorePill.textContent = 'Not graded';
        scorePill.className = 'stem-score-pill';
      }
      body.innerHTML = `
        <div class="stem-grader-empty">
          <p>3D geometry evaluation criteria for <strong>${escapeHtml(this.activeLesson.title)}</strong> (100-point scale):</p>
          <ul class="stem-rubric-preview">
            ${this.activeLesson.rubric.map(r => `
              <li>
                <span class="stem-rubric-pts">${escapeHtml(r.points)} pts</span>
                <span>${escapeHtml(r.label)}</span>
              </li>
            `).join('')}
          </ul>
          <p class="stem-grader-tip">💡 Build directly in the 3D Viewport (Add, Move/Scale, Edit Mode Extrude/Inset, Modifiers, Sculpt) or click <strong>"✨ Auto-Demo"</strong>, then click <strong>"✅ Grade Model"</strong>!</p>
        </div>
      `;
      return;
    }

    if (scorePill) {
      scorePill.textContent = `${report.score}/100 · ${report.gradeLetter}`;
      scorePill.className = `stem-score-pill ${report.passed ? 'passed' : 'failed'}`;
    }

    body.innerHTML = `
      <div class="stem-grade-summary ${report.passed ? 'passed' : 'failed'}">
        <div class="stem-grade-big">${escapeHtml(report.score)}<span>/100</span></div>
        <div class="stem-grade-meta">
          <strong>${escapeHtml(report.gradeLetter)}</strong>
          <span>Passed ${escapeHtml(report.passedCount)}/${escapeHtml(report.totalCriteria)} criteria · +${escapeHtml(report.xpAwarded)} XP</span>
        </div>
      </div>
      <div class="stem-criteria-list">
        ${report.criteria.map(c => `
          <div class="stem-criterion-row ${c.passed ? 'pass' : 'fail'}">
            <div class="stem-criterion-top">
              <span>${c.passed ? '✅' : '❌'} ${escapeHtml(c.label)}</span>
              <strong>${escapeHtml(c.earned)}/${escapeHtml(c.points)} pts</strong>
            </div>
            <div class="stem-criterion-fb">${escapeHtml(c.feedback)}</div>
          </div>
        `).join('')}
      </div>
    `;
  }

  // ===========================================================================
  // CSS CHO CON TRỎ NHỎ GỌN (42px) & THANH HUD KHÔNG CHẮN GIAO DIỆN
  // ===========================================================================

  _injectStyles() {
    if (typeof document === 'undefined' || document.getElementById('stem-tutor-styles')) return;
    const style = document.createElement('style');
    style.id = 'stem-tutor-styles';
    style.textContent = `
      .stem-tutor-floating-root {
        position: fixed;
        inset: 0;
        pointer-events: none;
        z-index: 2000;
      }
      .stem-target-beacon {
        position: fixed;
        border: 2px solid #00d2d3;
        border-radius: 6px;
        box-shadow: 0 0 0 3px rgba(0, 210, 211, 0.25), 0 0 14px rgba(0, 210, 211, 0.7);
        pointer-events: none !important;
        transition: all 0.35s cubic-bezier(0.22, 1, 0.36, 1);
        animation: stemBeaconPulse 1.1s ease-in-out infinite;
      }
      @keyframes stemBeaconPulse {
        0%, 100% { transform: scale(1); opacity: 1; }
        50% { transform: scale(1.02); opacity: 0.75; }
      }
      .stem-tutor-target-highlight {
        outline: 2px solid #00d2d3 !important;
        outline-offset: 2px !important;
      }
      /* Con trỏ Giáo viên 42x42px nhỏ gọn, không kèm bong bóng to, tự động cho click xuyên qua khi đang chỉ nút */
      .stem-avatar-host {
        position: fixed;
        left: 0;
        top: 0;
        width: 42px;
        height: 42px;
        pointer-events: auto;
        transition: transform 0.38s cubic-bezier(0.22, 1, 0.36, 1), opacity 0.2s;
        will-change: transform;
        user-select: none;
      }
      .stem-avatar-host.pass-through {
        pointer-events: none !important;
        opacity: 0.92;
      }
      .stem-avatar-host.dragging {
        transition: none !important;
        pointer-events: auto !important;
      }
      .stem-avatar-btn {
        position: relative;
        width: 42px;
        height: 42px;
        border-radius: 50%;
        border: 2px solid #48dbfb;
        background: radial-gradient(circle at 30% 30%, #1e293b, #0f172a);
        box-shadow: 0 4px 14px rgba(0, 0, 0, 0.5), 0 0 10px rgba(72, 219, 251, 0.4);
        cursor: grab;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 0;
        transition: transform 0.2s, border-color 0.2s;
      }
      .stem-avatar-btn:hover {
        transform: scale(1.06);
        border-color: #feca57;
      }
      .stem-avatar-badge {
        position: absolute;
        right: -3px;
        bottom: -2px;
        background: #feca57;
        color: #111;
        font: 800 8px/1 system-ui, sans-serif;
        padding: 2px 4px;
        border-radius: 6px;
        border: 1px solid #111;
        pointer-events: none;
      }
      .stem-avatar-wave-ring {
        position: absolute;
        inset: -4px;
        border-radius: 50%;
        border: 2px solid #1dd1a1;
        opacity: 0;
        pointer-events: none;
      }
      .stem-avatar-host.speaking .stem-avatar-wave-ring.ring-1 {
        animation: stemWaveOut 1.1s ease-out infinite;
      }
      .stem-avatar-host.speaking .stem-avatar-wave-ring.ring-2 {
        animation: stemWaveOut 1.1s ease-out 0.55s infinite;
      }
      .stem-avatar-host.speaking .stem-bot-mouth {
        animation: stemMouthTalk 0.22s ease-in-out infinite alternate;
      }
      @keyframes stemWaveOut {
        0% { transform: scale(0.95); opacity: 0.85; }
        100% { transform: scale(1.45); opacity: 0; }
      }
      @keyframes stemMouthTalk {
        0% { transform: scaleY(0.7); }
        100% { transform: scaleY(2.2); }
      }
      .stem-avatar-pointer {
        position: absolute;
        color: #feca57;
        font-size: 16px;
        text-shadow: 0 2px 6px rgba(0,0,0,0.85);
        pointer-events: none !important;
        opacity: 0;
        transition: opacity 0.18s;
      }
      .stem-avatar-host[data-pointer="left"] .stem-avatar-pointer {
        opacity: 1;
        left: -17px;
        top: 11px;
        transform: rotate(180deg);
      }
      .stem-avatar-host[data-pointer="right"] .stem-avatar-pointer {
        opacity: 1;
        right: -17px;
        top: 11px;
      }
      .stem-avatar-host[data-pointer="up"] .stem-avatar-pointer {
        opacity: 1;
        left: 13px;
        top: -18px;
        transform: rotate(-90deg);
      }
      .stem-avatar-host[data-pointer="down"] .stem-avatar-pointer {
        opacity: 1;
        left: 13px;
        bottom: -18px;
        transform: rotate(90deg);
      }

      /* Thanh HUD Lời giảng & Hỏi AI neo gọn ở cạnh trên-giữa Viewport (dưới thanh Viewport Header),
         tách rời khỏi con trỏ nên KHÔNG BAO GIỜ che Menu, Outliner, Inspector hay Dock! */
      .stem-speech-bubble {
        position: fixed;
        left: 50%;
        top: 72px;
        transform: translateX(-50%) translateY(-6px);
        width: min(560px, calc(100vw - 380px));
        min-width: 310px;
        background: rgba(17, 22, 31, 0.95);
        color: #ecf0f1;
        border: 1px solid rgba(0, 210, 211, 0.65);
        border-radius: 10px;
        padding: 8px 12px;
        box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5);
        font: 12px/1.4 system-ui, -apple-system, sans-serif;
        opacity: 0;
        pointer-events: none;
        transition: opacity 0.2s, transform 0.2s, width 0.2s;
      }
      .stem-speech-bubble.open {
        opacity: 1;
        pointer-events: auto;
        transform: translateX(-50%) translateY(0);
      }
      .stem-speech-bubble.minimized {
        width: auto;
        min-width: 260px;
        padding: 5px 10px;
      }
      .stem-speech-bubble.minimized .stem-hud-collapsible-body {
        display: none;
      }
      .stem-speech-bubble.minimized .stem-bubble-header {
        margin-bottom: 0;
        border-bottom: none;
        padding-bottom: 0;
      }
      .stem-bubble-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 6px;
        margin-bottom: 6px;
        border-bottom: 1px solid rgba(255,255,255,0.09);
        padding-bottom: 4px;
      }
      .stem-bubble-title-wrap {
        display: flex;
        align-items: center;
        gap: 6px;
        min-width: 0;
      }
      .stem-bubble-title {
        font-weight: 700;
        color: #48dbfb;
        font-size: 12px;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .stem-bubble-header-right {
        display: flex;
        align-items: center;
        gap: 4px;
        flex-shrink: 0;
      }
      .stem-rate-select {
        background: #1e2736;
        color: #7ed6df;
        border: 1px solid rgba(72, 219, 251, 0.35);
        border-radius: 4px;
        font-size: 10px;
        padding: 1px 4px;
        cursor: pointer;
      }
      .stem-bubble-step-badge {
        background: rgba(72, 219, 251, 0.16);
        color: #7ed6df;
        padding: 2px 6px;
        border-radius: 6px;
        font-size: 10px;
        font-weight: 600;
      }
      .stem-bubble-icon-btn {
        background: rgba(255,255,255,0.05);
        border: 1px solid rgba(255,255,255,0.15);
        color: #ddd;
        border-radius: 4px;
        padding: 1px 6px;
        font-size: 10.5px;
        cursor: pointer;
      }
      .stem-bubble-icon-btn:hover {
        background: rgba(255,255,255,0.14);
      }
      .stem-voice-indicator {
        display: inline-flex;
        align-items: flex-end;
        gap: 2px;
        height: 12px;
      }
      .stem-voice-indicator .bar {
        width: 2.5px;
        height: 4px;
        background: #1dd1a1;
        border-radius: 1px;
      }
      .stem-speech-bubble.speaking .stem-voice-indicator .bar.b1 { animation: stemEq 0.32s infinite alternate; }
      .stem-speech-bubble.speaking .stem-voice-indicator .bar.b2 { animation: stemEq 0.22s infinite alternate 0.08s; }
      .stem-speech-bubble.speaking .stem-voice-indicator .bar.b3 { animation: stemEq 0.36s infinite alternate 0.16s; }
      @keyframes stemEq {
        0% { height: 3px; }
        100% { height: 12px; }
      }
      .stem-bubble-grade-badge {
        margin-bottom: 5px;
        padding: 2px 8px;
        border-radius: 5px;
        font-weight: 700;
        font-size: 11px;
      }
      .stem-bubble-grade-badge[data-passed="true"] {
        background: rgba(29, 209, 161, 0.18);
        color: #1dd1a1;
        border: 1px solid rgba(29, 209, 161, 0.4);
      }
      .stem-bubble-grade-badge[data-passed="false"] {
        background: rgba(255, 107, 107, 0.18);
        color: #ff6b6b;
        border: 1px solid rgba(255, 107, 107, 0.4);
      }
      .stem-bubble-text {
        white-space: pre-wrap;
        color: #e2e8f0;
        margin-bottom: 6px;
        max-height: 76px;
        overflow-y: auto;
        font-size: 11.5px;
      }
      .stem-ai-ask-row {
        display: flex;
        gap: 5px;
        margin-bottom: 6px;
      }
      .stem-ai-ask-input {
        flex: 1;
        background: rgba(15, 23, 42, 0.9);
        color: #f8fafc;
        border: 1px solid #334155;
        border-radius: 5px;
        padding: 4px 8px;
        font-size: 11px;
        outline: none;
      }
      .stem-ai-ask-input:focus {
        border-color: #00d2d3;
      }
      .stem-bubble-actions {
        display: flex;
        flex-wrap: wrap;
        gap: 4px;
      }
      .stem-b-btn {
        background: #2b3240;
        color: #e2e8f0;
        border: 1px solid #455065;
        border-radius: 5px;
        padding: 3px 7px;
        font-size: 11px;
        cursor: pointer;
      }
      .stem-b-btn:hover { background: #374151; }
      .stem-b-btn.primary { background: #0984e3; border-color: #74b9ff; color: #fff; font-weight: 600; }
      .stem-b-btn.ai-send { background: #00a8ff; border-color: #48dbfb; color: #fff; font-weight: 700; }
      .stem-b-btn.demo { background: #6c5ce7; border-color: #a29bfe; color: #fff; }
      .stem-b-btn.grade { background: #10ac84; border-color: #1dd1a1; color: #fff; font-weight: 600; }

      /* Bảng Dock Giáo trình Dựng hình 3D (#dock-stem) */
      .stem-dock-layout {
        display: grid;
        grid-template-columns: 250px 1fr 290px;
        width: 100%;
        height: 100%;
        background: #1b1e24;
        color: #e2e8f0;
        font-size: 12px;
        overflow: hidden;
      }
      .stem-sidebar {
        border-right: 1px solid #2f3542;
        display: flex;
        flex-direction: column;
        overflow: hidden;
        background: #16191e;
      }
      .stem-sidebar-header {
        padding: 8px 10px;
        border-bottom: 1px solid #2f3542;
        display: flex;
        flex-direction: column;
        gap: 6px;
      }
      .stem-sidebar-title { font-weight: 700; color: #48dbfb; font-size: 12px; }
      .stem-sidebar-sub { font-size: 11px; color: #feca57; font-weight: 600; }
      .stem-level-select {
        background: #262b33;
        color: #eee;
        border: 1px solid #3d4452;
        border-radius: 4px;
        padding: 3px 6px;
        font-size: 11px;
      }
      .stem-lesson-list {
        flex: 1;
        overflow-y: auto;
        padding: 6px;
        display: flex;
        flex-direction: column;
        gap: 5px;
      }
      .stem-lesson-card {
        padding: 7px 9px;
        border-radius: 6px;
        background: #222730;
        border: 1px solid #323946;
        cursor: pointer;
        transition: border-color 0.15s, background 0.15s;
      }
      .stem-lesson-card:hover { border-color: #48dbfb; }
      .stem-lesson-card.active {
        background: #1e3148;
        border-color: #00d2d3;
      }
      .stem-lesson-card.completed {
        border-left: 3px solid #1dd1a1;
      }
      .stem-card-top {
        display: flex;
        justify-content: space-between;
        font-size: 10px;
        color: #94a3b8;
        margin-bottom: 3px;
      }
      .stem-card-status { color: #feca57; font-weight: 600; }
      .stem-card-title { font-weight: 600; font-size: 11.5px; color: #f1f5f9; }
      .stem-main-panel {
        display: flex;
        flex-direction: column;
        overflow: hidden;
      }
      .stem-lesson-toolbar {
        padding: 8px 12px;
        background: #222730;
        border-bottom: 1px solid #2f3542;
        display: flex;
        align-items: center;
        justify-content: space-between;
        flex-wrap: wrap;
        gap: 8px;
      }
      .stem-lesson-heading { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
      .stem-level-pill {
        background: rgba(0, 210, 211, 0.15);
        color: #00d2d3;
        padding: 2px 7px;
        border-radius: 4px;
        font-size: 10.5px;
        font-weight: 600;
      }
      .stem-geometry-pill {
        background: rgba(254, 202, 87, 0.14);
        color: #feca57;
        border: 1px solid rgba(254, 202, 87, 0.35);
        padding: 2px 7px;
        border-radius: 4px;
        font-size: 10.5px;
        font-family: monospace;
      }
      .stem-detail-title { margin: 0; font-size: 13px; color: #fff; }
      .stem-toolbar-actions { display: flex; flex-wrap: wrap; gap: 5px; }
      .stem-action-btn {
        background: #2f3640;
        color: #eee;
        border: 1px solid #4b5563;
        border-radius: 4px;
        padding: 4px 8px;
        font-size: 11px;
        cursor: pointer;
      }
      .stem-action-btn:hover { background: #3d4654; }
      .stem-action-btn.ai-coach { background: #0984e3; border-color: #48dbfb; color: #fff; font-weight: 600; }
      .stem-action-btn.demo { background: #5f27cd; border-color: #8c7ae6; color: #fff; }
      .stem-action-btn.grade { background: #10ac84; border-color: #1dd1a1; color: #fff; font-weight: 600; }
      .stem-dock-ai-coach-bar {
        display: flex;
        gap: 6px;
        background: #161b24;
        padding: 6px 8px;
        border-radius: 6px;
        border: 1px solid rgba(72, 219, 251, 0.3);
      }
      .stem-detail-body {
        flex: 1;
        overflow-y: auto;
        padding: 10px 14px;
        display: flex;
        flex-direction: column;
        gap: 10px;
      }
      .stem-detail-summary { margin: 0; color: #cbd5e1; line-height: 1.45; }
      .stem-box-label { font-weight: 700; color: #feca57; margin-bottom: 5px; font-size: 11.5px; }
      .stem-objectives-list { margin: 0; padding-left: 18px; color: #dbeafe; }
      .stem-steps-list { display: flex; flex-direction: column; gap: 6px; }
      .stem-step-item {
        display: flex;
        gap: 8px;
        padding: 7px 10px;
        background: #232832;
        border: 1px solid #343b48;
        border-radius: 6px;
        cursor: pointer;
      }
      .stem-step-item:hover { border-color: #48dbfb; }
      .stem-step-item.active {
        background: #1c3144;
        border-color: #00d2d3;
      }
      .stem-step-item.done .stem-step-num {
        background: #2ecc71;
        color: #08131a;
      }
      .stem-step-num {
        width: 22px;
        height: 22px;
        border-radius: 50%;
        background: #00d2d3;
        color: #111;
        font-weight: 700;
        display: flex;
        align-items: center;
        justify-content: center;
        flex-shrink: 0;
      }
      .stem-step-title { font-weight: 600; color: #fff; margin-bottom: 2px; }
      .stem-step-target-tag {
        font-family: monospace;
        font-size: 10px;
        color: #7ed6df;
        background: rgba(0, 210, 211, 0.12);
        padding: 1px 5px;
        border-radius: 4px;
        margin-left: 4px;
      }
      .stem-step-voice { color: #cbd5e1; font-style: italic; font-size: 11.5px; margin-bottom: 2px; }
      .stem-step-hint { color: #feca57; font-size: 11px; }
      .stem-grader-panel {
        border-left: 1px solid #2f3542;
        background: #16191e;
        display: flex;
        flex-direction: column;
        overflow: hidden;
      }
      .stem-grader-header {
        padding: 8px 10px;
        border-bottom: 1px solid #2f3542;
        display: flex;
        justify-content: space-between;
        align-items: center;
        font-weight: 700;
      }
      .stem-score-pill {
        font-size: 10.5px;
        padding: 2px 7px;
        border-radius: 10px;
        background: #2f3542;
        color: #cbd5e1;
      }
      .stem-score-pill.passed { background: rgba(29,209,161,0.2); color: #1dd1a1; }
      .stem-score-pill.failed { background: rgba(255,107,107,0.2); color: #ff6b6b; }
      .stem-grader-body {
        flex: 1;
        overflow-y: auto;
        padding: 10px;
      }
      .stem-rubric-preview {
        list-style: none;
        padding: 0;
        margin: 8px 0;
        display: flex;
        flex-direction: column;
        gap: 6px;
      }
      .stem-rubric-preview li {
        display: flex;
        gap: 6px;
        align-items: center;
        background: #222730;
        padding: 6px 8px;
        border-radius: 5px;
      }
      .stem-rubric-pts {
        background: #0984e3;
        color: #fff;
        font-weight: 700;
        font-size: 10px;
        padding: 2px 5px;
        border-radius: 4px;
        flex-shrink: 0;
      }
      .stem-grade-summary {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 8px 10px;
        border-radius: 6px;
        margin-bottom: 8px;
      }
      .stem-grade-summary.passed { background: rgba(29,209,161,0.14); border: 1px solid rgba(29,209,161,0.4); }
      .stem-grade-summary.failed { background: rgba(255,107,107,0.14); border: 1px solid rgba(255,107,107,0.4); }
      .stem-grade-big { font-size: 24px; font-weight: 800; color: #fff; }
      .stem-grade-big span { font-size: 12px; color: #94a3b8; }
      .stem-grade-meta { display: flex; flex-direction: column; font-size: 11px; }
      .stem-criteria-list { display: flex; flex-direction: column; gap: 6px; }
      .stem-criterion-row {
        padding: 6px 8px;
        border-radius: 5px;
        background: #222730;
        border-left: 3px solid #64748b;
      }
      .stem-criterion-row.pass { border-left-color: #1dd1a1; }
      .stem-criterion-row.fail { border-left-color: #ff6b6b; }
      .stem-criterion-top {
        display: flex;
        justify-content: space-between;
        font-weight: 600;
        margin-bottom: 3px;
      }
      .stem-criterion-fb { font-size: 11px; color: #94a3b8; }
    `;
    document.head.appendChild(style);
  }
}
