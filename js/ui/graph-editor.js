/**
 * @file graph-editor.js
 * @description Interactive Blender-style Bezier F-Curve & Graph Editor.
 * Supports true cubic Bezier tangent handles (auto_clamped / aligned / free / vector),
 * per-curve extrapolation (constant / linear / cycle / cycle_offset), multi-channel filters,
 * pan/zoom viewport, marquee box selection, snapping, and Undo/Redo history integration.
 */

import {
  evaluateFCurve,
  HANDLE_TYPES,
  EXTRAPOLATION_MODES,
  normalizeHandleType,
  normalizeExtrapolation
} from '../core/fcurve-math.js';

const ALL_CHANNELS = [
  'position.x', 'position.y', 'position.z',
  'rotation.x', 'rotation.y', 'rotation.z',
  'scale.x', 'scale.y', 'scale.z'
];

const CHANNEL_COLORS = {
  'position.x': '#e74c3c',
  'position.y': '#2ecc71',
  'position.z': '#3498db',
  'rotation.x': '#e66767',
  'rotation.y': '#55efc4',
  'rotation.z': '#54a0ff',
  'scale.x': '#ff7979',
  'scale.y': '#badc58',
  'scale.z': '#7ed6df'
};

const HANDLE_COLORS = {
  auto_clamped: '#d4af37',
  aligned: '#e67e22',
  free: '#e84393',
  vector: '#00cec9'
};

const PAD = { left: 52, right: 18, top: 22, bottom: 26 };

function makeKeyId(channel, frame) {
  return `${channel}|${Number(frame).toFixed(3)}`;
}

function niceStep(range, targetTicks = 6) {
  const rough = Math.max(1e-6, range / Math.max(1, targetTicks));
  const pow10 = Math.pow(10, Math.floor(Math.log10(rough)));
  const frac = rough / pow10;
  let nice = 1;
  if (frac > 5) nice = 10;
  else if (frac > 2) nice = 5;
  else if (frac > 1) nice = 2;
  return nice * pow10;
}

export class GraphEditorUI {
  /**
   * @param {Object} options
   * @param {TimelineEngine} options.timelineEngine
   * @param {SceneManager} options.sceneManager
   */
  constructor(options = {}) {
    this.timelineEngine = options.timelineEngine || (typeof window !== 'undefined' ? window.timelineEngine : null);
    this.sceneManager = options.sceneManager || (typeof window !== 'undefined' ? window.sceneManager : null);

    const hasDoc = typeof document !== 'undefined';
    this.container = hasDoc ? document.getElementById('graph-editor') : null;
    this.canvas = hasDoc ? document.getElementById('graph-editor-canvas') : null;
    this.ctx = this.canvas ? this.canvas.getContext('2d') : null;
    this.boneSelect = hasDoc ? document.getElementById('graph-bone-select') : null;
    this.channelSelect = hasDoc ? document.getElementById('graph-channel-select') : null;
    this.filterSelect = hasDoc ? document.getElementById('graph-channel-filter') : null;
    this.keyframeSelect = hasDoc ? document.getElementById('graph-keyframe-select') : null;
    this.interpSelect = hasDoc ? document.getElementById('graph-interp-select') : null;
    this.handleSelect = hasDoc ? document.getElementById('graph-handle-select') : null;
    this.extrapSelect = hasDoc ? document.getElementById('graph-extrap-select') : null;
    this.btnApplyInterp = hasDoc ? document.getElementById('btn-graph-apply-interp') : null;
    this.btnSnap = hasDoc ? document.getElementById('btn-graph-snap') : null;
    this.btnFrameAll = hasDoc ? document.getElementById('btn-graph-frame-all') : null;
    this.btnInsertKey = hasDoc ? document.getElementById('btn-graph-insert-key') : null;
    this.btnDeleteKey = hasDoc ? document.getElementById('btn-graph-delete-key') : null;
    this.statusEl = hasDoc ? document.getElementById('graph-status') : null;

    this.activeChannel = 'rotation.y';
    this.channelFilter = 'all'; // 'all' | 'active' | 'position' | 'rotation' | 'scale'
    this.activeBoneName = 'auto';
    this.activeObject = null;
    this.snapEnabled = false;
    this.selectedKeys = new Set(); // Set of `${channel}|${frame.toFixed(3)}`

    this.width = 0;
    this.height = 0;

    // Independent zoom/pan viewport bounds
    const startF = this.timelineEngine ? this.timelineEngine.startFrame : 0;
    const endF = this.timelineEngine ? this.timelineEngine.endFrame : 120;
    this.viewMinF = startF - 5;
    this.viewMaxF = Math.max(startF + 30, endF + 5);
    this.viewMinV = -2;
    this.viewMaxV = 2;
    this._userViewportAdjusted = false;

    // Pointer interaction state
    this._dragState = null;
    this._hoverItem = null;

    this._init();
  }

  _init() {
    this._bindEvents();
    this.resize();
    this.updateBoneList();
    this.fitView();
    this.render();
  }

  _bindEvents() {
    this.boneSelect?.addEventListener('change', (e) => {
      this.activeBoneName = e.target.value;
      this.selectedKeys.clear();
      this._userViewportAdjusted = false;
      this.fitView();
      this._syncToolbarFromSelection();
      this.render();
    });

    this.channelSelect?.addEventListener('change', (e) => {
      this.activeChannel = e.target.value;
      this._syncToolbarFromSelection();
      this.render();
    });

    this.filterSelect?.addEventListener('change', (e) => {
      this.channelFilter = e.target.value || 'all';
      this.fitView();
      this.render();
    });

    this.btnApplyInterp?.addEventListener('click', () => {
      const mode = this.interpSelect?.value || 'bezier';
      const targetKey = this.keyframeSelect?.value || 'selected';
      this.setInterpolation(mode, targetKey);
    });

    this.handleSelect?.addEventListener('change', (e) => {
      this.setSelectedHandleType(e.target.value);
    });

    this.extrapSelect?.addEventListener('change', (e) => {
      this.setActiveExtrapolation(e.target.value);
    });

    this.btnSnap?.addEventListener('click', () => {
      this.snapEnabled = !this.snapEnabled;
      this.btnSnap.setAttribute('aria-pressed', this.snapEnabled ? 'true' : 'false');
      this.btnSnap.style.background = this.snapEnabled ? '#4772b3' : '#333';
      this.btnSnap.style.color = this.snapEnabled ? '#fff' : '#ccc';
      this._setStatus(`Snap ${this.snapEnabled ? 'ON (1 frame / 0.1 val)' : 'OFF'}`);
    });

    this.btnFrameAll?.addEventListener('click', () => {
      this._userViewportAdjusted = false;
      this.fitView();
      this.render();
    });

    this.btnInsertKey?.addEventListener('click', () => {
      this.insertKeyAtCurrentFrame();
    });

    this.btnDeleteKey?.addEventListener('click', () => {
      this.deleteSelectedKeyframes();
    });

    if (this.canvas) {
      this.canvas.addEventListener('pointerdown', (e) => this._onPointerDown(e));
      this.canvas.addEventListener('pointermove', (e) => this._onPointerMove(e));
      this.canvas.addEventListener('pointerup', (e) => this._onPointerUp(e));
      this.canvas.addEventListener('pointercancel', (e) => this._onPointerUp(e));
      this.canvas.addEventListener('wheel', (e) => this._onWheel(e), { passive: false });
      this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    }

    this.container?.addEventListener('keydown', (e) => this._onKeyDown(e));

    if (this.timelineEngine) {
      this.timelineEngine.on('frameChanged', () => {
        if (this._isTabVisible()) {
          this.render();
        }
      });
      this.timelineEngine.on('tracksChanged', () => {
        this.updateBoneList();
        if (!this._userViewportAdjusted && !this._dragState) {
          this.fitView();
        }
        this._syncToolbarFromSelection();
        this.render();
      });
      this.timelineEngine.on('keyframeAdded', () => {
        if (!this._userViewportAdjusted) this.fitView();
        this.render();
      });
      this.timelineEngine.on('keyframeRemoved', () => {
        this.render();
      });
      this.timelineEngine.on('actionsChanged', () => {
        this.updateBoneList();
        if (!this._userViewportAdjusted && !this._dragState) {
          this.fitView();
        }
        this._syncToolbarFromSelection();
        this.render();
      });
      this.timelineEngine.on('nlaChanged', () => {
        this.render();
      });
    }

    if (this.sceneManager) {
      this.sceneManager.on('selectionChanged', ({ active }) => {
        this.activeObject = active;
        this.selectedKeys.clear();
        this._userViewportAdjusted = false;
        this.updateBoneList();
        this.fitView();
        this._syncToolbarFromSelection();
        this.render();
      });
    }

    if (typeof window !== 'undefined') {
      window.addEventListener('resize', () => {
        if (this._isTabVisible()) {
          this.resize();
          this.render();
        }
      });
    }

    if (typeof document !== 'undefined') {
      document.querySelectorAll('.dock-tab').forEach((tab) => {
        tab.addEventListener('click', () => {
          if (tab.dataset.pane === 'dock-graph-editor') {
            setTimeout(() => {
              this.resize();
              this.updateBoneList();
              if (!this._userViewportAdjusted) this.fitView();
              this._syncToolbarFromSelection();
              this.render();
            }, 30);
          }
        });
      });
    }
  }

  _isTabVisible() {
    if (typeof document === 'undefined') return false;
    const pane = document.getElementById('dock-graph-editor');
    return Boolean(pane && pane.classList.contains('active'));
  }

  _getTargetObject() {
    return this.activeObject || this.sceneManager?.getActiveObject?.() || null;
  }

  _setStatus(text) {
    if (this.statusEl) this.statusEl.textContent = text;
  }

  _notifySceneUpdated() {
    this.sceneManager?.requestRender?.();
    if (typeof window !== 'undefined' && window.engine?.render) {
      window.engine.render();
    }
  }

  _recordTrackUndo(description, object, beforeSnap) {
    if (!this.timelineEngine || !object || !beforeSnap) return;
    const afterSnap = this.timelineEngine.captureTrackSnapshot(object);
    if (JSON.stringify(beforeSnap) === JSON.stringify(afterSnap)) return;

    const tl = this.timelineEngine;
    const cmd = {
      name: description,
      description,
      execute: () => {
        tl.restoreTrackSnapshot(object, afterSnap);
        this._notifySceneUpdated();
        this.render();
      },
      undo: () => {
        tl.restoreTrackSnapshot(object, beforeSnap);
        this._notifySceneUpdated();
        this.render();
      }
    };
    if (typeof this.sceneManager?.recordExecutedCommand === 'function') {
      this.sceneManager.recordExecutedCommand(cmd);
    } else if (Array.isArray(this.sceneManager?.undoStack)) {
      this.sceneManager.undoStack.push(cmd);
      if (Array.isArray(this.sceneManager.redoStack)) this.sceneManager.redoStack.length = 0;
    }
  }

  resize() {
    if (!this.canvas || !this.canvas.parentElement) return;
    const rect = this.canvas.parentElement.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      const dpr = (typeof window !== 'undefined' ? window.devicePixelRatio : 1) || 1;
      this.canvas.width = Math.round(rect.width * dpr);
      this.canvas.height = Math.round(rect.height * dpr);
      if (this.ctx) {
        this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      }
      this.width = rect.width;
      this.height = rect.height;
    }
  }

  updateBoneList() {
    if (!this.boneSelect) return;
    const currentVal = this.boneSelect.value;
    const target = this._getTargetObject();
    const bones = [];

    if (target) {
      target.traverse((c) => {
        if (c.isBone && c.name && !bones.includes(c.name)) {
          bones.push(c.name);
        }
      });
    }

    this.boneSelect.innerHTML = '<option value="auto">Active Bone / Object</option>';
    for (const bName of bones) {
      const opt = document.createElement('option');
      opt.value = bName;
      opt.textContent = bName;
      this.boneSelect.appendChild(opt);
    }

    if (bones.includes(currentVal)) {
      this.boneSelect.value = currentVal;
      this.activeBoneName = currentVal;
    } else {
      this.activeBoneName = 'auto';
    }
  }

  getVisibleChannels() {
    const target = this._getTargetObject();
    const filter = this.channelFilter || 'all';
    if (filter === 'active') return [this.activeChannel];

    let candidates = ALL_CHANNELS;
    if (filter === 'position') candidates = ['position.x', 'position.y', 'position.z'];
    else if (filter === 'rotation') candidates = ['rotation.x', 'rotation.y', 'rotation.z'];
    else if (filter === 'scale') candidates = ['scale.x', 'scale.y', 'scale.z'];

    if (!this.timelineEngine || !target) {
      return candidates.includes(this.activeChannel) ? [this.activeChannel] : candidates.slice(0, 3);
    }

    const withKeys = candidates.filter((ch) => {
      const data = this.timelineEngine.getFCurvePoints(target, ch, this.activeBoneName);
      return data.points.length > 0 || ch === this.activeChannel;
    });
    return withKeys.length > 0 ? withKeys : [this.activeChannel];
  }

  _syncToolbarFromSelection() {
    const target = this._getTargetObject();
    if (!this.timelineEngine || !target) return;

    if (this.extrapSelect) {
      this.extrapSelect.value = this.timelineEngine.getFCurveExtrapolation(target, this.activeChannel, this.activeBoneName);
    }

    if (this.handleSelect) {
      const data = this.timelineEngine.getFCurvePoints(target, this.activeChannel, this.activeBoneName);
      let firstType = null;
      for (const pt of data.resolved) {
        if (this.selectedKeys.has(makeKeyId(this.activeChannel, pt.frame))) {
          firstType = pt.handleType;
          break;
        }
      }
      if (!firstType && data.resolved.length > 0) firstType = data.resolved[0].handleType;
      if (firstType) this.handleSelect.value = normalizeHandleType(firstType);
    }
  }

  fitView() {
    const target = this._getTargetObject();
    const channels = this.getVisibleChannels();
    let minF = Infinity;
    let maxF = -Infinity;
    let minV = Infinity;
    let maxV = -Infinity;

    if (this.timelineEngine && target) {
      for (const ch of channels) {
        const data = this.timelineEngine.getFCurvePoints(target, ch, this.activeBoneName);
        for (const p of data.resolved) {
          if (p.frame < minF) minF = p.frame;
          if (p.frame > maxF) maxF = p.frame;
          if (p.val < minV) minV = p.val;
          if (p.val > maxV) maxV = p.val;
          const hlV = p.val + (p.hl?.[1] || 0);
          const hrV = p.val + (p.hr?.[1] || 0);
          if (hlV < minV) minV = hlV;
          if (hlV > maxV) maxV = hlV;
          if (hrV < minV) minV = hrV;
          if (hrV > maxV) maxV = hrV;
        }
      }
    }

    if (!Number.isFinite(minF) || !Number.isFinite(maxF)) {
      const s = this.timelineEngine ? this.timelineEngine.startFrame : 0;
      const e = this.timelineEngine ? Math.max(s + 30, this.timelineEngine.endFrame) : 120;
      this.viewMinF = s - 5;
      this.viewMaxF = e + 5;
      this.viewMinV = -2;
      this.viewMaxV = 2;
      return;
    }

    const spanF = Math.max(10, maxF - minF);
    this.viewMinF = minF - spanF * 0.12;
    this.viewMaxF = maxF + spanF * 0.18;

    const spanV = maxV - minV;
    if (spanV < 1e-3) {
      this.viewMinV = minV - 1;
      this.viewMaxV = maxV + 1;
    } else {
      this.viewMinV = minV - spanV * 0.2;
      this.viewMaxV = maxV + spanV * 0.2;
    }
  }

  _plotRect() {
    const w = Math.max(120, this.width || 600);
    const h = Math.max(80, this.height || 240);
    return {
      left: PAD.left,
      top: PAD.top,
      width: Math.max(10, w - PAD.left - PAD.right),
      height: Math.max(10, h - PAD.top - PAD.bottom),
      totalW: w,
      totalH: h
    };
  }

  frameToX(f) {
    const p = this._plotRect();
    const span = Math.max(1e-4, this.viewMaxF - this.viewMinF);
    return p.left + ((f - this.viewMinF) / span) * p.width;
  }

  xToFrame(x) {
    const p = this._plotRect();
    return this.viewMinF + ((x - p.left) / p.width) * (this.viewMaxF - this.viewMinF);
  }

  valToY(v) {
    const p = this._plotRect();
    const span = Math.max(1e-6, this.viewMaxV - this.viewMinV);
    return p.top + p.height - ((v - this.viewMinV) / span) * p.height;
  }

  yToVal(y) {
    const p = this._plotRect();
    return this.viewMinV + ((p.top + p.height - y) / p.height) * (this.viewMaxV - this.viewMinV);
  }

  /**
   * Sets interpolation mode on selected or targeted keyframes (Undoable).
   */
  setInterpolation(mode = 'bezier', targetKey = 'all') {
    if (!this.timelineEngine) return 0;
    const target = this._getTargetObject();
    if (!target) {
      this._setStatus('No object selected to set interpolation');
      return 0;
    }

    const beforeSnap = this.timelineEngine.captureTrackSnapshot(target);
    const useSelected = (targetKey === 'selected') && this.selectedKeys.size > 0;
    const currentF = Math.round(this.timelineEngine.currentFrame);

    let updatedCount = 0;
    const channels = useSelected
      ? Array.from(new Set(Array.from(this.selectedKeys).map((id) => id.split('|')[0])))
      : [this.activeChannel];

    if (useSelected) {
      for (const keyId of this.selectedKeys) {
        const [ch, fStr] = keyId.split('|');
        const f = Number(fStr);
        if (this.timelineEngine.updateFCurveKeyframe(target, ch, f, { interpolation: mode }, this.activeBoneName)) {
          updatedCount++;
        }
      }
    } else {
      const track = this.timelineEngine.tracks.get(target.uuid);
      const matchesFrame = (f) => {
        if (targetKey === 'all' || targetKey === 'selected') return true;
        if (targetKey === 'current') return Math.abs(f - currentF) <= 1;
        return Math.abs(f - Number(targetKey)) < 1e-3;
      };
      if (track) {
        (track.keyframes || []).forEach((kf) => {
          if (matchesFrame(kf.frame)) {
            kf.interpolation = mode;
            updatedCount++;
          }
        });
        if (track.boneTracks) {
          for (const [bName, bData] of track.boneTracks.entries()) {
            if (this.activeBoneName !== 'auto' && this.activeBoneName !== bName) continue;
            (bData.rotationTrack || []).forEach((k) => {
              if (matchesFrame(k.frame)) { k.interpolation = mode; updatedCount++; }
            });
            (bData.positionTrack || []).forEach((k) => {
              if (matchesFrame(k.frame)) { k.interpolation = mode; updatedCount++; }
            });
          }
        }
      }
      this.timelineEngine.defaultInterpolation = mode;
      this.timelineEngine.emit('tracksChanged', { reason: 'interpolationUpdated', mode });
      this.timelineEngine.evaluate(this.timelineEngine.currentFrame);
    }

    this._recordTrackUndo(`F-Curve Interp (${mode})`, target, beforeSnap);
    this._notifySceneUpdated();
    this._setStatus(`Set ${mode.toUpperCase()} on ${updatedCount} key(s) (${channels.join(', ')})`);
    this.render();
    return updatedCount;
  }

  /**
   * Sets Bezier handle type on selected keyframes (or all keys of active channel if none selected).
   */
  setSelectedHandleType(handleType) {
    const type = normalizeHandleType(handleType);
    const target = this._getTargetObject();
    if (!this.timelineEngine || !target) return 0;

    const beforeSnap = this.timelineEngine.captureTrackSnapshot(target);
    let count = 0;

    if (this.selectedKeys.size > 0) {
      for (const id of this.selectedKeys) {
        const [ch, fStr] = id.split('|');
        const res = this.timelineEngine.updateFCurveKeyframe(target, ch, Number(fStr), { handleType: type }, this.activeBoneName);
        if (res) count++;
      }
    } else {
      const data = this.timelineEngine.getFCurvePoints(target, this.activeChannel, this.activeBoneName);
      for (const pt of data.points) {
        const res = this.timelineEngine.updateFCurveKeyframe(target, this.activeChannel, pt.frame, { handleType: type }, this.activeBoneName);
        if (res) count++;
      }
    }

    this._recordTrackUndo(`Set Handle Type (${type})`, target, beforeSnap);
    if (this.handleSelect) this.handleSelect.value = type;
    this._notifySceneUpdated();
    this._setStatus(`Handle: ${type} (${count} key(s))`);
    this.render();
    return count;
  }

  setActiveExtrapolation(extrapolation) {
    const mode = normalizeExtrapolation(extrapolation);
    const target = this._getTargetObject();
    if (!this.timelineEngine || !target) return false;

    const beforeSnap = this.timelineEngine.captureTrackSnapshot(target);
    const ok = this.timelineEngine.setFCurveExtrapolation(target, this.activeChannel, mode, this.activeBoneName);
    if (ok) {
      this._recordTrackUndo(`Extrapolation (${mode})`, target, beforeSnap);
      if (this.extrapSelect) this.extrapSelect.value = mode;
      this._notifySceneUpdated();
      this._setStatus(`${this.activeChannel} Extrapolation: ${mode}`);
      this.render();
    }
    return ok;
  }

  selectKeyframe(channel, frame, additive = false) {
    if (!additive) this.selectedKeys.clear();
    const id = makeKeyId(channel, frame);
    if (additive && this.selectedKeys.has(id)) this.selectedKeys.delete(id);
    else this.selectedKeys.add(id);
    this.activeChannel = channel;
    if (this.channelSelect) this.channelSelect.value = channel;
    this._syncToolbarFromSelection();
    this.render();
  }

  boxSelectFrames(minFrame, maxFrame, minVal, maxVal, additive = false) {
    const target = this._getTargetObject();
    if (!this.timelineEngine || !target) return 0;
    if (!additive) this.selectedKeys.clear();

    const loF = Math.min(minFrame, maxFrame);
    const hiF = Math.max(minFrame, maxFrame);
    const loV = Math.min(minVal, maxVal);
    const hiV = Math.max(minVal, maxVal);

    let count = 0;
    for (const ch of this.getVisibleChannels()) {
      const data = this.timelineEngine.getFCurvePoints(target, ch, this.activeBoneName);
      for (const pt of data.resolved) {
        if (pt.frame >= loF && pt.frame <= hiF && pt.val >= loV && pt.val <= hiV) {
          this.selectedKeys.add(makeKeyId(ch, pt.frame));
          count++;
        }
      }
    }
    this._syncToolbarFromSelection();
    this._setStatus(`Selected ${this.selectedKeys.size} keyframe(s)`);
    this.render();
    return count;
  }

  deleteSelectedKeyframes() {
    const target = this._getTargetObject();
    if (!this.timelineEngine || !target || this.selectedKeys.size === 0) return 0;

    const beforeSnap = this.timelineEngine.captureTrackSnapshot(target);
    let deleted = 0;
    for (const id of Array.from(this.selectedKeys)) {
      const [ch, fStr] = id.split('|');
      if (this.timelineEngine.deleteFCurveKeyframe(target, ch, Number(fStr), this.activeBoneName)) {
        deleted++;
      }
    }
    this.selectedKeys.clear();
    this._recordTrackUndo('Delete F-Curve Keys', target, beforeSnap);
    this._notifySceneUpdated();
    this._setStatus(`Deleted ${deleted} keyframe(s)`);
    this.render();
    return deleted;
  }

  insertKeyAtCurrentFrame() {
    const target = this._getTargetObject();
    if (!this.timelineEngine || !target) return null;

    const beforeSnap = this.timelineEngine.captureTrackSnapshot(target);
    const f = Math.round(this.timelineEngine.currentFrame);
    const [prop, axis] = this.activeChannel.split('.');
    let val = 0;
    if (this.activeBoneName && this.activeBoneName !== 'auto') {
      const bone = target.getObjectByName?.(this.activeBoneName);
      if (bone && bone[prop] && Number.isFinite(bone[prop][axis])) val = bone[prop][axis];
    } else if (target[prop] && Number.isFinite(target[prop][axis])) {
      val = target[prop][axis];
    }

    const kf = this.timelineEngine.insertFCurveKeyframe(target, this.activeChannel, f, val, this.activeBoneName);
    if (kf) {
      this.selectedKeys.clear();
      this.selectedKeys.add(makeKeyId(this.activeChannel, f));
      this._recordTrackUndo('Insert F-Curve Key', target, beforeSnap);
      this._notifySceneUpdated();
      this._setStatus(`Inserted ${this.activeChannel} key @ frame ${f}`);
      this.render();
    }
    return kf;
  }

  /**
   * Programmatic handle move (also used cleanly by tests and UI).
   */
  moveSelectedHandle(channel, keyFrame, side, df, dv) {
    const target = this._getTargetObject();
    if (!this.timelineEngine || !target) return false;
    const beforeSnap = this.timelineEngine.captureTrackSnapshot(target);
    const res = this.timelineEngine.updateFCurveKeyframe(
      target,
      channel,
      keyFrame,
      { editedSide: side, handleOffset: [df, dv] },
      this.activeBoneName
    );
    if (res) {
      this._recordTrackUndo('Edit Bezier Handle', target, beforeSnap);
      this._notifySceneUpdated();
      this.render();
      return true;
    }
    return false;
  }

  /**
   * Programmatic keyframe nudge (shifts all selected keys by dFrame, dVal, respecting snap).
   */
  nudgeSelectedKeyframes(dFrame, dVal) {
    const target = this._getTargetObject();
    if (!this.timelineEngine || !target || this.selectedKeys.size === 0) return false;
    const beforeSnap = this.timelineEngine.captureTrackSnapshot(target);

    const items = [];
    for (const id of this.selectedKeys) {
      const [ch, fStr] = id.split('|');
      const oldF = Number(fStr);
      const data = this.timelineEngine.getFCurvePoints(target, ch, this.activeBoneName);
      const pt = data.resolved.find((p) => Math.abs(p.frame - oldF) < 1e-3);
      if (pt) items.push({ ch, oldF, oldV: pt.rawVal });
    }
    if (items.length === 0) return false;

    this.selectedKeys.clear();
    for (const item of items) {
      let nextF = item.oldF + dFrame;
      let nextV = item.oldV + dVal;
      if (this.snapEnabled) {
        nextF = Math.round(nextF);
        nextV = Math.round(nextV * 10) / 10;
      }
      this.timelineEngine.updateFCurveKeyframe(
        target,
        item.ch,
        item.oldF,
        { frame: nextF, val: nextV },
        this.activeBoneName
      );
      this.selectedKeys.add(makeKeyId(item.ch, nextF));
    }

    this._recordTrackUndo('Move F-Curve Keys', target, beforeSnap);
    this._notifySceneUpdated();
    this.render();
    return true;
  }

  _hitTest(mx, my) {
    const target = this._getTargetObject();
    if (!this.timelineEngine || !target) return null;

    // 1. Selected keyframe handles first (highest picking priority)
    const channels = this.getVisibleChannels();
    for (const ch of [this.activeChannel, ...channels.filter((c) => c !== this.activeChannel)]) {
      const data = this.timelineEngine.getFCurvePoints(target, ch, this.activeBoneName);
      for (const pt of data.resolved) {
        const keyId = makeKeyId(ch, pt.frame);
        if (!this.selectedKeys.has(keyId)) continue;
        if (pt.interpolation === 'constant' || pt.interpolation === 'linear') continue;

        const hxL = this.frameToX(pt.frame + pt.hl[0]);
        const hyL = this.valToY(pt.val + pt.hl[1]);
        if (Math.hypot(mx - hxL, my - hyL) <= 9) {
          return { kind: 'handle', channel: ch, frame: pt.frame, val: pt.val, side: 'left', pt };
        }
        const hxR = this.frameToX(pt.frame + pt.hr[0]);
        const hyR = this.valToY(pt.val + pt.hr[1]);
        if (Math.hypot(mx - hxR, my - hyR) <= 9) {
          return { kind: 'handle', channel: ch, frame: pt.frame, val: pt.val, side: 'right', pt };
        }
      }
    }

    // 2. Keyframe diamonds across visible channels (prioritize active channel)
    const order = [this.activeChannel, ...channels.filter((c) => c !== this.activeChannel)];
    for (const ch of order) {
      const data = this.timelineEngine.getFCurvePoints(target, ch, this.activeBoneName);
      for (const pt of data.resolved) {
        const kx = this.frameToX(pt.frame);
        const ky = this.valToY(pt.val);
        if (Math.hypot(mx - kx, my - ky) <= 10) {
          return { kind: 'keyframe', channel: ch, frame: pt.frame, val: pt.rawVal, pt };
        }
      }
    }

    // 3. Top playhead ruler scrub zone
    const p = this._plotRect();
    if (my <= p.top + 14 && mx >= p.left && mx <= p.left + p.width) {
      return { kind: 'playhead' };
    }

    return null;
  }

  _canvasLocalPoint(e) {
    const rect = this.canvas.getBoundingClientRect();
    return { mx: e.clientX - rect.left, my: e.clientY - rect.top };
  }

  _onPointerDown(e) {
    if (!this.canvas) return;
    this.container?.focus?.({ preventScroll: true });
    const { mx, my } = this._canvasLocalPoint(e);

    // Pan with MMB or Alt+LMB
    if (e.button === 1 || (e.button === 0 && e.altKey)) {
      this._userViewportAdjusted = true;
      this._dragState = {
        mode: 'pan',
        startX: mx,
        startY: my,
        startMinF: this.viewMinF,
        startMaxF: this.viewMaxF,
        startMinV: this.viewMinV,
        startMaxV: this.viewMaxV
      };
      this.canvas.setPointerCapture?.(e.pointerId);
      return;
    }

    if (e.button !== 0) return;

    const hit = this._hitTest(mx, my);
    const target = this._getTargetObject();

    if (hit?.kind === 'playhead') {
      this._dragState = { mode: 'playhead' };
      const f = Math.round(this.xToFrame(mx));
      this.timelineEngine?.seekToFrame?.(f);
      this.canvas.setPointerCapture?.(e.pointerId);
      return;
    }

    if (hit?.kind === 'handle' && target) {
      this.activeChannel = hit.channel;
      if (this.channelSelect) this.channelSelect.value = hit.channel;
      this._dragState = {
        mode: 'handle',
        target,
        beforeSnap: this.timelineEngine.captureTrackSnapshot(target),
        channel: hit.channel,
        keyFrame: hit.frame,
        keyVal: hit.val,
        side: hit.side
      };
      this.canvas.setPointerCapture?.(e.pointerId);
      return;
    }

    if (hit?.kind === 'keyframe' && target) {
      const hitId = makeKeyId(hit.channel, hit.frame);
      if (e.shiftKey) {
        if (this.selectedKeys.has(hitId)) this.selectedKeys.delete(hitId);
        else this.selectedKeys.add(hitId);
      } else if (!this.selectedKeys.has(hitId)) {
        this.selectedKeys.clear();
        this.selectedKeys.add(hitId);
      }
      this.activeChannel = hit.channel;
      if (this.channelSelect) this.channelSelect.value = hit.channel;
      this._syncToolbarFromSelection();

      // Snapshot initial frame/val for every selected key so multi-key drags stay exact
      const dragItems = [];
      for (const id of this.selectedKeys) {
        const [ch, fStr] = id.split('|');
        const oldF = Number(fStr);
        const data = this.timelineEngine.getFCurvePoints(target, ch, this.activeBoneName);
        const pt = data.resolved.find((p) => Math.abs(p.frame - oldF) < 1e-3);
        if (pt) {
          dragItems.push({ ch, origF: pt.frame, currentF: pt.frame, origVal: pt.rawVal });
        }
      }

      this._dragState = {
        mode: 'keyframe',
        target,
        beforeSnap: this.timelineEngine.captureTrackSnapshot(target),
        startF: this.xToFrame(mx),
        startV: this.yToVal(my),
        items: dragItems
      };
      this.canvas.setPointerCapture?.(e.pointerId);
      this.render();
      return;
    }

    // Empty space -> Box Marquee selection
    this._dragState = {
      mode: 'box',
      startX: mx,
      startY: my,
      curX: mx,
      curY: my,
      additive: e.shiftKey
    };
    this.canvas.setPointerCapture?.(e.pointerId);
    this.render();
  }

  _onPointerMove(e) {
    if (!this.canvas) return;
    const { mx, my } = this._canvasLocalPoint(e);

    if (!this._dragState) {
      const hover = this._hitTest(mx, my);
      this._hoverItem = hover;
      this.canvas.style.cursor = hover ? (hover.kind === 'playhead' ? 'ew-resize' : 'grab') : 'crosshair';
      return;
    }

    const st = this._dragState;

    if (st.mode === 'pan') {
      const p = this._plotRect();
      const spanF = st.startMaxF - st.startMinF;
      const spanV = st.startMaxV - st.startMinV;
      const df = -((mx - st.startX) / p.width) * spanF;
      const dv = ((my - st.startY) / p.height) * spanV;
      this.viewMinF = st.startMinF + df;
      this.viewMaxF = st.startMaxF + df;
      this.viewMinV = st.startMinV + dv;
      this.viewMaxV = st.startMaxV + dv;
      this.render();
      return;
    }

    if (st.mode === 'playhead') {
      this.timelineEngine?.seekToFrame?.(Math.round(this.xToFrame(mx)));
      this.render();
      return;
    }

    if (st.mode === 'handle' && st.target) {
      const pointerF = this.xToFrame(mx);
      const pointerV = this.yToVal(my);
      let df = pointerF - st.keyFrame;
      let dv = pointerV - st.keyVal;
      if (st.side === 'left') df = Math.min(-0.05, df);
      else df = Math.max(0.05, df);

      if (this.snapEnabled) {
        dv = Math.round(dv * 20) / 20;
      }

      this.timelineEngine.updateFCurveKeyframe(
        st.target,
        st.channel,
        st.keyFrame,
        { editedSide: st.side, handleOffset: [df, dv] },
        this.activeBoneName
      );
      this._syncToolbarFromSelection();
      this._notifySceneUpdated();
      this._setStatus(`Handle (${st.side}) Δ(${df.toFixed(1)}f, ${dv.toFixed(2)})`);
      this.render();
      return;
    }

    if (st.mode === 'keyframe' && st.target) {
      let dF = this.xToFrame(mx) - st.startF;
      let dV = this.yToVal(my) - st.startV;
      if (e.shiftKey) {
        if (Math.abs(dF / Math.max(1, this.viewMaxF - this.viewMinF)) > Math.abs(dV / Math.max(1e-4, this.viewMaxV - this.viewMinV))) {
          dV = 0;
        } else {
          dF = 0;
        }
      }

      this.selectedKeys.clear();
      for (const item of st.items) {
        let nextF = item.origF + dF;
        let nextV = item.origVal + dV;
        if (this.snapEnabled) {
          nextF = Math.round(nextF);
          nextV = Math.round(nextV * 10) / 10;
        }
        const updated = this.timelineEngine.updateFCurveKeyframe(
          st.target,
          item.ch,
          item.currentF,
          { frame: nextF, val: nextV },
          this.activeBoneName
        );
        if (updated) {
          item.currentF = updated.frame;
        }
        this.selectedKeys.add(makeKeyId(item.ch, item.currentF));
      }

      this._notifySceneUpdated();
      this._setStatus(`Moved ${st.items.length} key(s) Δ(${dF.toFixed(1)}f, ${dV.toFixed(2)})`);
      this.render();
      return;
    }

    if (st.mode === 'box') {
      st.curX = mx;
      st.curY = my;
      this.render();
    }
  }

  _onPointerUp(e) {
    if (!this._dragState) return;
    const st = this._dragState;
    this._dragState = null;
    this.canvas?.releasePointerCapture?.(e.pointerId);

    if (st.mode === 'handle' && st.target) {
      this._recordTrackUndo('Edit Bezier Handle', st.target, st.beforeSnap);
    } else if (st.mode === 'keyframe' && st.target) {
      this._recordTrackUndo('Move F-Curve Keys', st.target, st.beforeSnap);
    } else if (st.mode === 'box') {
      const dist = Math.hypot(st.curX - st.startX, st.curY - st.startY);
      if (dist < 4) {
        if (!st.additive) {
          this.selectedKeys.clear();
          this.render();
        }
      } else {
        const f1 = this.xToFrame(st.startX);
        const f2 = this.xToFrame(st.curX);
        const v1 = this.yToVal(st.startY);
        const v2 = this.yToVal(st.curY);
        this.boxSelectFrames(f1, f2, v1, v2, st.additive);
      }
    }
  }

  _onWheel(e) {
    e.preventDefault();
    this._userViewportAdjusted = true;
    const { mx, my } = this._canvasLocalPoint(e);
    const pivotF = this.xToFrame(mx);
    const pivotV = this.yToVal(my);
    const zoomFactor = e.deltaY > 0 ? 1.14 : 1 / 1.14;

    if (!e.shiftKey) {
      const newMinF = pivotF - (pivotF - this.viewMinF) * zoomFactor;
      const newMaxF = pivotF + (this.viewMaxF - pivotF) * zoomFactor;
      if (newMaxF - newMinF >= 2 && newMaxF - newMinF <= 50000) {
        this.viewMinF = newMinF;
        this.viewMaxF = newMaxF;
      }
    }
    if (!e.ctrlKey && !e.metaKey) {
      const newMinV = pivotV - (pivotV - this.viewMinV) * zoomFactor;
      const newMaxV = pivotV + (this.viewMaxV - pivotV) * zoomFactor;
      if (newMaxV - newMinV >= 0.005 && newMaxV - newMinV <= 50000) {
        this.viewMinV = newMinV;
        this.viewMaxV = newMaxV;
      }
    }
    this.render();
  }

  _onKeyDown(e) {
    if (e.target && ['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target.tagName)) return;
    if (e.key === 'Home') {
      e.preventDefault();
      this._userViewportAdjusted = false;
      this.fitView();
      this.render();
    } else if (e.key === 'x' || e.key === 'X' || e.key === 'Delete' || e.key === 'Backspace') {
      if (this.selectedKeys.size > 0) {
        e.preventDefault();
        this.deleteSelectedKeyframes();
      }
    } else if ((e.key === 'i' || e.key === 'I') && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      this.insertKeyAtCurrentFrame();
    } else if ((e.key === 'v' || e.key === 'V') && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      const cur = normalizeHandleType(this.handleSelect?.value);
      const next = HANDLE_TYPES[(HANDLE_TYPES.indexOf(cur) + 1) % HANDLE_TYPES.length];
      this.setSelectedHandleType(next);
    } else if ((e.key === 'e' || e.key === 'E') && e.shiftKey) {
      e.preventDefault();
      const cur = normalizeExtrapolation(this.extrapSelect?.value);
      const next = EXTRAPOLATION_MODES[(EXTRAPOLATION_MODES.indexOf(cur) + 1) % EXTRAPOLATION_MODES.length];
      this.setActiveExtrapolation(next);
    }
  }

  // Backward-compatible single-channel point accessor
  _getPoints() {
    const target = this._getTargetObject();
    if (!this.timelineEngine || !target) return [];
    return this.timelineEngine.getFCurvePoints(target, this.activeChannel, this.activeBoneName).points;
  }

  render() {
    if (!this.ctx || !this.width || !this.height) {
      this.resize();
      if (!this.ctx || !this.width || !this.height) return;
    }

    const ctx = this.ctx;
    const p = this._plotRect();

    // Background
    ctx.fillStyle = '#191919';
    ctx.fillRect(0, 0, p.totalW, p.totalH);
    ctx.fillStyle = '#1f1f1f';
    ctx.fillRect(p.left, p.top, p.width, p.height);

    // Time grid
    const spanF = Math.max(1e-3, this.viewMaxF - this.viewMinF);
    const fStep = Math.max(1, Math.round(niceStep(spanF, Math.max(4, Math.floor(p.width / 70)))));
    const firstTickF = Math.ceil(this.viewMinF / fStep) * fStep;

    ctx.font = '10px monospace';
    for (let f = firstTickF; f <= this.viewMaxF; f += fStep) {
      const x = this.frameToX(f);
      ctx.strokeStyle = f % (fStep * 5) === 0 ? '#323232' : '#262626';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, p.top);
      ctx.lineTo(x, p.top + p.height);
      ctx.stroke();

      ctx.fillStyle = '#888';
      ctx.fillText(String(Math.round(f)), x - 6, p.totalH - 8);
    }

    // Value grid
    const spanV = Math.max(1e-6, this.viewMaxV - this.viewMinV);
    const vStep = niceStep(spanV, Math.max(3, Math.floor(p.height / 36)));
    const firstTickV = Math.ceil(this.viewMinV / vStep) * vStep;

    for (let v = firstTickV; v <= this.viewMaxV + vStep * 0.01; v += vStep) {
      const y = this.valToY(v);
      ctx.strokeStyle = Math.abs(v) < vStep * 0.01 ? '#4a4a4a' : '#282828';
      ctx.lineWidth = Math.abs(v) < vStep * 0.01 ? 1.5 : 1;
      ctx.beginPath();
      ctx.moveTo(p.left, y);
      ctx.lineTo(p.left + p.width, y);
      ctx.stroke();

      ctx.fillStyle = '#888';
      const label = Math.abs(v) < 1e-4 ? '0' : v.toFixed(vStep < 0.1 ? 2 : 1);
      ctx.fillText(label, 5, y + 3);
    }

    // Clip curves to plot box
    ctx.save();
    ctx.beginPath();
    ctx.rect(p.left, p.top, p.width, p.height);
    ctx.clip();

    const target = this._getTargetObject();
    const channels = this.getVisibleChannels();
    // Draw non-active channels first, active channel on top
    const drawOrder = [...channels.filter((c) => c !== this.activeChannel), ...(channels.includes(this.activeChannel) ? [this.activeChannel] : [])];

    if (this.timelineEngine && target) {
      const sampleCount = Math.min(800, Math.max(64, Math.floor(p.width)));

      for (const ch of drawOrder) {
        const isActive = ch === this.activeChannel;
        const color = CHANNEL_COLORS[ch] || '#e67e22';
        const data = this.timelineEngine.getFCurvePoints(target, ch, this.activeBoneName);
        if (!data.resolved || data.resolved.length === 0) continue;

        const firstF = data.resolved[0].frame;
        const lastF = data.resolved[data.resolved.length - 1].frame;
        const opts = {
          defaultInterpolation: this.timelineEngine.defaultInterpolation,
          extrapolation: data.extrapolation,
          unwrapAngles: ch.startsWith('rotation.')
        };

        // Extrapolation pre/post tails (dashed) & core curve (solid)
        const strokeSegment = (fStart, fEnd, dashed) => {
          if (fEnd <= fStart) return;
          ctx.save();
          ctx.strokeStyle = color;
          ctx.globalAlpha = isActive ? (dashed ? 0.65 : 1.0) : (dashed ? 0.25 : 0.42);
          ctx.lineWidth = isActive ? (dashed ? 1.6 : 2.3) : 1.3;
          ctx.setLineDash(dashed ? [5, 4] : []);
          ctx.beginPath();
          const steps = Math.max(12, Math.round(((fEnd - fStart) / spanF) * sampleCount));
          for (let i = 0; i <= steps; i++) {
            const f = fStart + (i / steps) * (fEnd - fStart);
            const v = evaluateFCurve(data.resolved, f, opts);
            const x = this.frameToX(f);
            const y = this.valToY(v);
            if (i === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
          }
          ctx.stroke();
          ctx.restore();
        };

        const preEnd = Math.min(this.viewMaxF, firstF);
        if (preEnd > this.viewMinF) strokeSegment(this.viewMinF, preEnd, true);

        const coreStart = Math.max(this.viewMinF, firstF);
        const coreEnd = Math.min(this.viewMaxF, lastF);
        if (coreEnd > coreStart) strokeSegment(coreStart, coreEnd, false);

        const postStart = Math.max(this.viewMinF, lastF);
        if (this.viewMaxF > postStart) strokeSegment(postStart, this.viewMaxF, true);

        // Keyframe diamonds & Bezier handles
        for (const pt of data.resolved) {
          const kx = this.frameToX(pt.frame);
          const ky = this.valToY(pt.val);
          const keyId = makeKeyId(ch, pt.frame);
          const isSel = this.selectedKeys.has(keyId);

          if ((isSel || isActive) && pt.interpolation !== 'constant' && pt.interpolation !== 'linear') {
            if (isSel) {
              const hCol = HANDLE_COLORS[pt.handleType] || '#e67e22';
              const hxL = this.frameToX(pt.frame + pt.hl[0]);
              const hyL = this.valToY(pt.val + pt.hl[1]);
              const hxR = this.frameToX(pt.frame + pt.hr[0]);
              const hyR = this.valToY(pt.val + pt.hr[1]);

              ctx.strokeStyle = hCol;
              ctx.lineWidth = 1.25;
              ctx.beginPath();
              ctx.moveTo(hxL, hyL);
              ctx.lineTo(kx, ky);
              ctx.lineTo(hxR, hyR);
              ctx.stroke();

              for (const [hx, hy] of [[hxL, hyL], [hxR, hyR]]) {
                ctx.fillStyle = hCol;
                ctx.strokeStyle = '#111';
                ctx.lineWidth = 1;
                ctx.beginPath();
                ctx.arc(hx, hy, 4, 0, Math.PI * 2);
                ctx.fill();
                ctx.stroke();
              }
            }
          }

          if (isActive || isSel) {
            const sz = isSel ? 5.5 : 4.2;
            ctx.fillStyle = isSel ? '#f39c12' : '#d5d5d5';
            ctx.strokeStyle = isSel ? '#ffffff' : '#181818';
            ctx.lineWidth = isSel ? 1.5 : 1.2;
            ctx.beginPath();
            ctx.moveTo(kx, ky - sz);
            ctx.lineTo(kx + sz, ky);
            ctx.lineTo(kx, ky + sz);
            ctx.lineTo(kx - sz, ky);
            ctx.closePath();
            ctx.fill();
            ctx.stroke();
          } else {
            ctx.save();
            ctx.globalAlpha = 0.65;
            ctx.fillStyle = color;
            ctx.beginPath();
            ctx.moveTo(kx, ky - 3);
            ctx.lineTo(kx + 3, ky);
            ctx.lineTo(kx, ky + 3);
            ctx.lineTo(kx - 3, ky);
            ctx.closePath();
            ctx.fill();
            ctx.restore();
          }
        }
      }
    }

    // Playhead vertical line
    if (this.timelineEngine) {
      const curX = this.frameToX(this.timelineEngine.currentFrame);
      ctx.strokeStyle = '#478bf9';
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.moveTo(curX, p.top);
      ctx.lineTo(curX, p.top + p.height);
      ctx.stroke();

      ctx.fillStyle = '#478bf9';
      ctx.beginPath();
      ctx.moveTo(curX - 6, p.top);
      ctx.lineTo(curX + 6, p.top);
      ctx.lineTo(curX, p.top + 8);
      ctx.closePath();
      ctx.fill();
    }

    // Box selection marquee
    if (this._dragState?.mode === 'box') {
      const s = this._dragState;
      const rx = Math.min(s.startX, s.curX);
      const ry = Math.min(s.startY, s.curY);
      const rw = Math.abs(s.curX - s.startX);
      const rh = Math.abs(s.curY - s.startY);
      ctx.fillStyle = 'rgba(71, 139, 249, 0.16)';
      ctx.fillRect(rx, ry, rw, rh);
      ctx.strokeStyle = 'rgba(130, 180, 255, 0.85)';
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 3]);
      ctx.strokeRect(rx, ry, rw, rh);
      ctx.setLineDash([]);
    }

    ctx.restore();

    // Active channel legend pill in top-left corner of plot
    ctx.font = '10px sans-serif';
    ctx.fillStyle = 'rgba(20, 20, 20, 0.72)';
    const legendText = `${target ? target.name : 'No Object'} · ${this.activeChannel}${this.activeBoneName !== 'auto' ? ` (${this.activeBoneName})` : ''}`;
    const lw = ctx.measureText(legendText).width + 14;
    ctx.fillRect(p.left + 6, p.top + 6, lw, 18);
    ctx.fillStyle = CHANNEL_COLORS[this.activeChannel] || '#e67e22';
    ctx.fillRect(p.left + 10, p.top + 11, 8, 8);
    ctx.fillStyle = '#e0e0e0';
    ctx.fillText(legendText, p.left + 22, p.top + 19);
  }
}
