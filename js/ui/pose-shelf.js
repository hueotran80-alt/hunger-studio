/**
 * Web Blender Studio - Pose & Rigging Shelf Component
 * Provides Pose Mode toggling, Two-Bone IK toggling, Weight Paint visualization,
 * Humanoid Pose Library (17+ Presets), Category Filters, Custom Pose Saving,
 * Mirroring, Rest Reset, and 1-Click Auto-Skinning.
 * File: js/ui/pose-shelf.js
 */

import { escapeHtml } from '../core/escape-html.js';

export class PoseShelf {
  constructor(container, options = {}) {
    this.container = typeof container === 'string' ? document.querySelector(container) : container;
    this.rigSystem = options.rigSystem || null;
    this.sceneManager = options.sceneManager || null;
    this.activePose = 'idle_natural';
    this.activeCategory = 'all';

    this._initUI();
  }

  _initUI() {
    if (!this.container) return;

    this.panel = document.createElement('div');
    this.panel.className = 'blender-pose-shelf';
    this.panel.id = 'blender-pose-shelf';
    this.panel.innerHTML = `
      <div class="shelf-header">
        <div class="shelf-title">
          <svg viewBox="0 0 24 24" class="shelf-icon"><path fill="currentColor" d="M12 2a2 2 0 1 0 2 2 2 2 0 0 0-2-2zm8 7h-5v13h-2v-6h-2v6H9V9H4V7h16z"/></svg>
          <span>Pose & Rigging Studio (17+ Presets, Two-Bone IK & Weight Paint)</span>
        </div>
        <div class="shelf-header-controls">
          <button class="shelf-tool-btn" id="btn-shelf-dance-trend" title="Play Dance Trend animation clip">
            💃 Dance Trend
          </button>
          <button class="shelf-tool-btn" id="btn-toggle-ik" title="Toggle Two-Bone IK (Inverse Kinematics) for natural limb posing">
            🦾 Two-Bone IK
          </button>
          <button class="shelf-tool-btn highlight" id="btn-toggle-pin-feet" title="Keep feet planted &amp; flat when moving Hips/Root with IK">
            📌 Pin Feet
          </button>
          <select id="sel-bone-display" title="Bone Viewport Display Style" style="background: var(--b-bg-input); color: var(--b-text-primary); border: 1px solid var(--b-border-dark); border-radius: 3px; padding: 2px 6px; font-size: 11px;">
            <option value="octahedral">Octa Bones</option>
            <option value="stick">Stick</option>
            <option value="hidden">Hide Bones</option>
          </select>
          <button class="shelf-tool-btn" id="btn-toggle-edit-bones" title="Toggle Edit Bone Mode (Add, Extrude [E], Delete [X], Symmetrize)">
            🧱 Edit Bones
          </button>
          <button class="shelf-tool-btn" id="btn-toggle-weight-paint" title="Toggle Weight Paint heatmap &amp; interactive brush">
            🎨 Weight Paint
          </button>
          <button class="shelf-tool-btn" id="btn-keyframe-pose" title="Insert Pose Keyframe on Timeline (I)">
            🔑 Key Pose (I)
          </button>
          <button class="shelf-tool-btn" id="btn-save-current-pose" title="Save current pose as a new preset">
            💾 Save Pose
          </button>
          <button class="shelf-tool-btn" id="btn-shelf-mirror" title="Mirror arm/leg pose L ➔ R">
            🪞 Mirror L➔R
          </button>
          <button class="shelf-tool-btn" id="btn-shelf-reset" title="Reset all bones to original Rest Pose">
            🔄 Reset Pose
          </button>
          <select id="sel-shelf-skin-mode" title="Automatic Skinning Weight Solver" style="background: var(--b-bg-input); color: var(--b-text-primary); border: 1px solid var(--b-border-dark); border-radius: 3px; padding: 2px 4px; font-size: 11px;">
            <option value="heat" selected>Bone Heat</option>
            <option value="geodesic">Geodesic</option>
            <option value="euclidean">Distance</option>
          </select>
          <button class="shelf-tool-btn highlight" id="btn-shelf-auto-skin" title="Automatically compute weights and bind armature to selected mesh">
            🔗 Auto-Skin
          </button>
          <button class="btn-toggle-pose-mode" id="btn-toggle-pose-mode" title="Toggle Pose Mode (Click bones to rotate)">
            <span class="mode-dot"></span>
            <span id="txt-pose-mode-label">Mode: Object Mode</span>
          </button>
          <button class="shelf-btn-minimize" id="btn-minimize-pose-shelf" title="Minimize/Expand">_</button>
        </div>
      </div>
      <div class="shelf-body" id="pose-shelf-body">
        <!-- Status / Guide Bar (Dynamically updated for IK or Weight Paint) -->
        <div id="pose-shelf-banner" style="display:none; padding: 4px 12px; font-size: 11px; background: rgba(39, 174, 96, 0.15); border-bottom: 1px solid rgba(39, 174, 96, 0.3); color: #2ecc71; align-items: center; justify-content: space-between;">
          <span id="pose-banner-text"></span>
          <button id="btn-close-banner" style="background:none; border:none; color:#aaa; cursor:pointer; font-size:12px;">✕</button>
        </div>

        <!-- Edit Bone Contextual Bar -->
        <div id="pose-edit-bones-bar" style="display:none; padding: 5px 12px; gap: 6px; align-items: center; flex-wrap: wrap; background: rgba(243, 156, 18, 0.12); border-bottom: 1px solid rgba(243, 156, 18, 0.3); font-size: 11px;">
          <span style="color:#f39c12; font-weight:600;">🧱 Edit Bones:</span>
          <span id="edit-bone-active-label" style="color:#fff; background:rgba(255,255,255,0.08); padding:2px 6px; border-radius:3px;">None</span>
          <button class="shelf-tool-btn" id="btn-edit-bone-extrude" title="Extrude child bone (E)">➕ Extrude (E)</button>
          <button class="shelf-tool-btn" id="btn-edit-bone-add" title="Add child bone">+ Bone</button>
          <button class="shelf-tool-btn" id="btn-edit-bone-delete" title="Delete selected bone &amp; remap weights (X)">🗑 Delete (X)</button>
          <button class="shelf-tool-btn" id="btn-edit-bone-sym" title="Symmetrize Left ➔ Right across X=0">🪞 Sym X</button>
          <button class="shelf-tool-btn highlight" id="btn-edit-bone-done" title="Exit Edit Bone Mode &amp; recompute bind inverses">✔ Apply</button>
        </div>

        <!-- Two-Bone IK / FK Blend Bar -->
        <div id="pose-ik-blend-bar" style="display:none; padding: 5px 12px; gap: 8px; align-items: center; flex-wrap: wrap; background: rgba(0, 206, 201, 0.10); border-bottom: 1px solid rgba(0, 206, 201, 0.3); font-size: 11px;">
          <span style="color:#00cec9; font-weight:600;">🦾 IK/FK:</span>
          <select id="sel-shelf-ik-chain" style="background: var(--b-bg-input); color: var(--b-text-primary); border: 1px solid var(--b-border-dark); border-radius: 3px; padding: 2px 6px; font-size: 11px;">
            <option value="leftArm">Left Arm</option>
            <option value="rightArm">Right Arm</option>
            <option value="leftLeg">Left Leg</option>
            <option value="rightLeg">Right Leg</option>
          </select>
          <label style="display:flex; align-items:center; gap:4px; color:var(--b-text-secondary);">
            IK Blend <input type="range" id="shelf-ik-blend" min="0" max="1" step="0.05" value="1" style="width:76px;">
            <span id="shelf-ik-blend-val" style="min-width:28px; font-family:monospace;">1.00</span>
          </label>
          <button class="shelf-tool-btn" id="btn-shelf-snap-ik-fk" title="Snap IK Handles to current FK Pose">IK &larr; FK</button>
          <button class="shelf-tool-btn" id="btn-shelf-snap-fk-ik" title="Bake/Snap FK Pose to current IK Result">FK &larr; IK</button>
        </div>

        <!-- Weight Paint Brush Contextual Bar -->
        <div id="pose-weight-brush-bar" style="display:none; padding: 5px 12px; gap: 8px; align-items: center; flex-wrap: wrap; background: rgba(231, 76, 60, 0.12); border-bottom: 1px solid rgba(231, 76, 60, 0.3); font-size: 11px;">
          <span style="color:#ff7675; font-weight:600;">🖌 Brush:</span>
          <select id="wp-brush-mode" style="background: var(--b-bg-input); color: var(--b-text-primary); border: 1px solid var(--b-border-dark); border-radius: 3px; padding: 2px 6px; font-size: 11px;">
            <option value="add">Add</option>
            <option value="subtract">Subtract</option>
            <option value="smooth">Smooth</option>
            <option value="replace">Replace</option>
          </select>
          <label style="display:flex; align-items:center; gap:4px; color:var(--b-text-secondary);">
            Radius <input type="range" id="wp-brush-radius" min="0.02" max="1.0" step="0.02" value="0.22" style="width:72px;">
            <span id="wp-radius-val" style="min-width:28px; font-family:monospace;">0.22</span>
          </label>
          <label style="display:flex; align-items:center; gap:4px; color:var(--b-text-secondary);">
            Strength <input type="range" id="wp-brush-strength" min="0.05" max="1.0" step="0.05" value="0.50" style="width:72px;">
            <span id="wp-strength-val" style="min-width:28px; font-family:monospace;">0.50</span>
          </label>
          <label style="display:flex; align-items:center; gap:4px; color:var(--b-text-primary); cursor:pointer;">
            <input type="checkbox" id="wp-brush-mirror" checked> Mirror X
          </label>
          <button class="shelf-tool-btn" id="btn-wp-smooth-all" title="Smooth vertex weights">🌫 Smooth</button>
          <button class="shelf-tool-btn" id="btn-wp-normalize" title="Normalize vertex weights to sum=1">⚖ Normalize</button>
          <button class="shelf-tool-btn" id="btn-wp-clean" title="Prune tiny weights (&lt;0.01) &amp; cap 4 influences">✂ Clean</button>
          <button class="shelf-tool-btn" id="btn-wp-mirror-x" title="Mirror Left vertex weights to Right across X=0">🪞 Mirror W</button>
          <button class="shelf-tool-btn" id="btn-wp-transfer" title="Transfer weights from rigged body onto selected cloth/prop mesh">👔 Transfer W</button>
        </div>

        <div class="pose-category-tabs" id="pose-category-tabs" style="display: flex; gap: 6px; padding: 6px 12px 2px 12px; border-bottom: 1px solid var(--b-border-dark);">
          <button class="pose-cat-btn active" data-cat="all">All (17+)</button>
          <button class="pose-cat-btn" data-cat="basic">Basic / Idle</button>
          <button class="pose-cat-btn" data-cat="action">Combat &amp; Action</button>
          <button class="pose-cat-btn" data-cat="locomotion">Locomotion &amp; Expression</button>
          <button class="pose-cat-btn" data-cat="custom">Custom Poses ⭐</button>
        </div>
        <div class="pose-presets-row" id="pose-presets-row" style="padding: 8px 12px; display: flex; gap: 8px; overflow-x: auto;"></div>
      </div>
    `;

    this.container.appendChild(this.panel);
    this.renderPoses();
    this._bindEvents();

    if (typeof window !== 'undefined') {
      window.addEventListener('blender:custom-pose-added', () => {
        this.renderPoses();
      });
      window.addEventListener('blender:mode-changed', (e) => {
        const isPose = e.detail?.mode === 'pose';
        const btnMode = this.panel.querySelector('#btn-toggle-pose-mode');
        const txtMode = this.panel.querySelector('#txt-pose-mode-label');
        if (btnMode) btnMode.classList.toggle('active', isPose);
        if (txtMode) txtMode.textContent = isPose ? 'Mode: Pose Mode (Bones)' : 'Mode: Object Mode';
      });
      window.addEventListener('blender:ik-mode-changed', (e) => {
        const isIK = !!e.detail?.isIKEnabled;
        const btnIK = this.panel.querySelector('#btn-toggle-ik');
        if (btnIK) {
          btnIK.classList.toggle('highlight', isIK);
          btnIK.style.borderColor = isIK ? '#00cec9' : '';
          btnIK.style.color = isIK ? '#00cec9' : '';
        }
        const ikBar = this.panel.querySelector('#pose-ik-blend-bar');
        if (ikBar) ikBar.style.display = isIK ? 'flex' : 'none';
        if (isIK && this.rigSystem) {
          const key = this.panel.querySelector('#sel-shelf-ik-chain')?.value || 'leftArm';
          const b = this.rigSystem.getChainIKBlend(key);
          const sl = this.panel.querySelector('#shelf-ik-blend');
          const lbl = this.panel.querySelector('#shelf-ik-blend-val');
          if (sl) sl.value = String(b);
          if (lbl) lbl.textContent = b.toFixed(2);
        }
        this._updateBanner();
      });
      window.addEventListener('blender:weight-paint-mode-changed', (e) => {
        const isWP = !!e.detail?.active;
        const btnWP = this.panel.querySelector('#btn-toggle-weight-paint');
        if (btnWP) {
          btnWP.classList.toggle('highlight', isWP);
          btnWP.style.borderColor = isWP ? '#e74c3c' : '';
          btnWP.style.color = isWP ? '#e74c3c' : '';
        }
        const wpBar = this.panel.querySelector('#pose-weight-brush-bar');
        if (wpBar) wpBar.style.display = isWP ? 'flex' : 'none';
        this._syncWeightBrushUI(e.detail?.brush);
        this._updateBanner(e.detail?.bone);
      });
      window.addEventListener('blender:weight-brush-changed', (e) => {
        this._syncWeightBrushUI(e.detail);
      });
      window.addEventListener('blender:edit-bone-mode-changed', (e) => {
        const isEdit = !!e.detail?.active;
        const btnEdit = this.panel.querySelector('#btn-toggle-edit-bones');
        if (btnEdit) {
          btnEdit.classList.toggle('highlight', isEdit);
          btnEdit.style.borderColor = isEdit ? '#f39c12' : '';
          btnEdit.style.color = isEdit ? '#f39c12' : '';
        }
        const editBar = this.panel.querySelector('#pose-edit-bones-bar');
        if (editBar) editBar.style.display = isEdit ? 'flex' : 'none';
        const lbl = this.panel.querySelector('#edit-bone-active-label');
        if (lbl) lbl.textContent = this.rigSystem?.activeBone?.name || 'None';
        this._updateBanner();
      });
      window.addEventListener('blender:edit-bone-updated', () => {
        const lbl = this.panel.querySelector('#edit-bone-active-label');
        if (lbl) lbl.textContent = this.rigSystem?.activeBone?.name || 'None';
      });
      window.addEventListener('blender:bone-selected', (e) => {
        const name = e.detail?.bone?.name || this.rigSystem?.activeBone?.name || 'None';
        const lbl = this.panel.querySelector('#edit-bone-active-label');
        if (lbl) lbl.textContent = name;
        if (this.rigSystem?.isWeightPaintMode) {
          this._updateBanner(name);
        }
      });
    }
  }

  _syncWeightBrushUI(brush = null) {
    const b = brush || this.rigSystem?.weightBrush;
    if (!b) return;
    const modeEl = this.panel.querySelector('#wp-brush-mode');
    const radEl = this.panel.querySelector('#wp-brush-radius');
    const radVal = this.panel.querySelector('#wp-radius-val');
    const strEl = this.panel.querySelector('#wp-brush-strength');
    const strVal = this.panel.querySelector('#wp-strength-val');
    const mirEl = this.panel.querySelector('#wp-brush-mirror');
    if (modeEl && document.activeElement !== modeEl) modeEl.value = b.mode;
    if (radEl && document.activeElement !== radEl) radEl.value = String(b.radius);
    if (radVal) radVal.textContent = Number(b.radius).toFixed(2);
    if (strEl && document.activeElement !== strEl) strEl.value = String(b.strength);
    if (strVal) strVal.textContent = Number(b.strength).toFixed(2);
    if (mirEl) mirEl.checked = !!b.symmetryX;
  }

  _updateBanner(activeBone = null) {
    const banner = this.panel.querySelector('#pose-shelf-banner');
    const txt = this.panel.querySelector('#pose-banner-text');
    if (!banner || !txt) return;

    if (this.rigSystem?.isEditBoneMode) {
      banner.style.display = 'flex';
      banner.style.background = 'rgba(243, 156, 18, 0.14)';
      banner.style.borderBottomColor = 'rgba(243, 156, 18, 0.35)';
      banner.style.color = '#f39c12';
      txt.innerHTML = `🧱 <b>Edit Bone Mode:</b> Drag joints to move rest pose, <b>[E]</b> Extrude, <b>[X]</b> Delete, or <b>Sym X</b> to mirror.`;
    } else if (this.rigSystem?.isWeightPaintMode) {
      banner.style.display = 'flex';
      banner.style.background = 'rgba(231, 76, 60, 0.15)';
      banner.style.borderBottomColor = 'rgba(231, 76, 60, 0.3)';
      banner.style.color = '#ff7675';
      const boneInfo = escapeHtml(activeBone || this.rigSystem.activeBone?.name || 'None');
      txt.innerHTML = `🎨 <b>Weight Paint Mode:</b> Bone [<b>${boneInfo}</b>] &nbsp;|&nbsp; Drag on mesh to paint, <b>[ / ]</b> Brush radius`;
    } else if (this.rigSystem?.isIKEnabled) {
      banner.style.display = 'flex';
      banner.style.background = 'rgba(0, 206, 201, 0.15)';
      banner.style.borderBottomColor = 'rgba(0, 206, 201, 0.3)';
      banner.style.color = '#00cec9';
      txt.innerHTML = `🦾 <b>Two-Bone IK Active:</b> Drag the cyan (Arms) or green (Legs) Target spheres in the Viewport to bend elbows and knees naturally!`;
    } else {
      banner.style.display = 'none';
    }
  }

  renderPoses() {
    if (!this.rigSystem) return;
    const row = this.panel.querySelector('#pose-presets-row');
    if (!row) return;

    row.innerHTML = '';
    const poses = this.rigSystem.getPosePresets();

    Object.entries(poses).forEach(([key, pose]) => {
      // Filter by category
      if (this.activeCategory !== 'all') {
        if (this.activeCategory === 'custom' && pose.category !== 'custom') return;
        if (this.activeCategory !== 'custom' && pose.category !== this.activeCategory) return;
      }

      const btn = document.createElement('button');
      btn.className = 'pose-chip-btn';
      if (this.activePose === key) btn.classList.add('active');
      btn.dataset.key = key;
      btn.title = `Apply Pose: ${pose.name}`;

      btn.innerHTML = `
        <span class="pose-icon">${escapeHtml(pose.icon || '🧍')}</span>
        <span class="pose-name">${escapeHtml(pose.name.split('(')[0].trim())}</span>
      `;

      btn.addEventListener('click', () => {
        this.applySelectedPose(key);
      });

      row.appendChild(btn);
    });

    if (row.children.length === 0) {
      row.innerHTML = `<div style="font-size: 11px; color: var(--b-text-muted); padding: 8px;">No poses found in this category.</div>`;
    }
  }

  applySelectedPose(poseKey) {
    if (!this.rigSystem) return;

    const btns = this.panel.querySelectorAll('.pose-chip-btn');
    btns.forEach(b => b.classList.toggle('active', b.dataset.key === poseKey));
    this.activePose = poseKey;

    let target = this.rigSystem.activeCharacter;
    if (!target && this.sceneManager) {
      target = this.sceneManager.getActiveObject();
    }
    if (!target && typeof window !== 'undefined' && window.scene) {
      window.scene.traverse((child) => {
        if (!target && (child.isSkinnedMesh || (child.userData && child.userData.skeleton) || child.name.includes('Human') || child.name.includes('Mannequin') || child.name.includes('Armature'))) {
          target = child;
        }
      });
    }

    if (!target) {
      if (typeof window !== 'undefined' && window.codeEditor) {
        window.codeEditor.log('warn', '⚠️ Please select a rigged character in the 3D Viewport before applying a pose!');
      }
      return;
    }

    const ok = this.rigSystem.applyPose(target, poseKey);
    if (ok && typeof window !== 'undefined' && window.codeEditor) {
      const poseInfo = this.rigSystem.getPosePresets()[poseKey];
      window.codeEditor.log('success', `✓ Applied pose [${poseInfo ? poseInfo.name : poseKey}] successfully!`);
    }
  }

  _bindEvents() {
    const btnMode = this.panel.querySelector('#btn-toggle-pose-mode');
    const txtMode = this.panel.querySelector('#txt-pose-mode-label');
    const btnMin = this.panel.querySelector('#btn-minimize-pose-shelf');
    const body = this.panel.querySelector('#pose-shelf-body');
    const catBtns = this.panel.querySelectorAll('.pose-cat-btn');

    catBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        catBtns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this.activeCategory = btn.dataset.cat;
        this.renderPoses();
      });
    });

    if (btnMode && this.rigSystem) {
      btnMode.addEventListener('click', () => {
        const newMode = !this.rigSystem.isPoseMode;
        this.rigSystem.setPoseMode(newMode);
        btnMode.classList.toggle('active', newMode);
        if (txtMode) {
          txtMode.textContent = newMode ? 'Mode: Pose Mode (Bones)' : 'Mode: Object Mode';
        }
      });
    }

    this.panel.querySelector('#btn-shelf-dance-trend')?.addEventListener('click', () => {
      const tl = window.timelineEngine;
      if (tl) {
        tl.play();
        const tlTab = document.querySelector('.dock-tab[data-pane="dock-timeline"]');
        if (tlTab) tlTab.click();
      } else if (typeof window !== 'undefined' && window.danceTrendEngine) {
      }
    });

    // Toggle Two-Bone IK
    this.panel.querySelector('#btn-toggle-ik')?.addEventListener('click', () => {
      if (this.rigSystem) {
        let target = this.rigSystem.activeCharacter || (this.sceneManager ? this.sceneManager.getActiveObject() : null);
        if (target) this.rigSystem.activeCharacter = target;
        const isEnabled = !this.rigSystem.isIKEnabled;
        this.rigSystem.setIKEnabled(isEnabled);
        if (window.codeEditor) {
          window.codeEditor.log(
            'info',
            isEnabled
              ? '🦾 Two-Bone IK ENABLED: Drag the cyan/green target handles to pose limbs!'
              : '🦾 Two-Bone IK DISABLED.'
          );
        }
      }
    });

    // Toggle Pin Feet IK during Hips/Root transforms
    const btnPinFeet = this.panel.querySelector('#btn-toggle-pin-feet');
    if (btnPinFeet) {
      btnPinFeet.addEventListener('click', () => {
        if (!this.rigSystem) return;
        const next = this.rigSystem.setPinFeetIK(!this.rigSystem.pinFeetIK);
        btnPinFeet.classList.toggle('highlight', next);
        if (window.codeEditor) {
          window.codeEditor.log('info', next ? '📌 Foot-Pinning IK ON (Feet stay planted when moving Hips).' : '📌 Foot-Pinning IK OFF.');
        }
      });
    }

    // Bone Viewport Display Mode
    this.panel.querySelector('#sel-bone-display')?.addEventListener('change', (e) => {
      this.rigSystem?.setBoneDisplayMode(e.target.value);
    });

    // Keyframe Pose Shortcut Button
    this.panel.querySelector('#btn-keyframe-pose')?.addEventListener('click', (e) => {
      if (!this.rigSystem) return;
      const target = this.rigSystem.activeCharacter || (this.sceneManager ? this.sceneManager.getActiveObject() : null);
      const boneArg = e.shiftKey ? 'all' : (this.rigSystem.activeBone || 'all');
      const res = this.rigSystem.keyframePoseToTimeline(target, boneArg);
      if (window.codeEditor) {
        window.codeEditor.log('success', `🔑 Keyframed ${res.count} bone(s) at frame ${res.frame}`);
      }
    });

    // Toggle Edit Bone Mode
    this.panel.querySelector('#btn-toggle-edit-bones')?.addEventListener('click', () => {
      if (this.rigSystem) {
        if (this.rigSystem.isEditBoneMode) {
          this.rigSystem.exitEditBoneMode();
        } else {
          const target = this.rigSystem.activeCharacter || (this.sceneManager ? this.sceneManager.getActiveObject() : null);
          this.rigSystem.enterEditBoneMode(target);
        }
      }
    });

    this.panel.querySelector('#btn-edit-bone-extrude')?.addEventListener('click', () => {
      this.rigSystem?.extrudeBone();
    });
    this.panel.querySelector('#btn-edit-bone-add')?.addEventListener('click', () => {
      this.rigSystem?.addBone(this.rigSystem.activeBone);
    });
    this.panel.querySelector('#btn-edit-bone-delete')?.addEventListener('click', () => {
      this.rigSystem?.deleteBone();
    });
    this.panel.querySelector('#btn-edit-bone-sym')?.addEventListener('click', () => {
      this.rigSystem?.symmetrizeBones('left_to_right');
    });
    this.panel.querySelector('#btn-edit-bone-done')?.addEventListener('click', () => {
      this.rigSystem?.exitEditBoneMode();
    });

    this.panel.querySelector('#sel-shelf-ik-chain')?.addEventListener('change', (e) => {
      if (!this.rigSystem) return;
      const b = this.rigSystem.getChainIKBlend(e.target.value);
      const sl = this.panel.querySelector('#shelf-ik-blend');
      const lbl = this.panel.querySelector('#shelf-ik-blend-val');
      if (sl) sl.value = String(b);
      if (lbl) lbl.textContent = b.toFixed(2);
    });
    this.panel.querySelector('#shelf-ik-blend')?.addEventListener('input', (e) => {
      if (!this.rigSystem) return;
      const key = this.panel.querySelector('#sel-shelf-ik-chain')?.value || 'leftArm';
      const val = parseFloat(e.target.value);
      const lbl = this.panel.querySelector('#shelf-ik-blend-val');
      if (lbl) lbl.textContent = val.toFixed(2);
      this.rigSystem.setChainIKBlend(key, val);
    });
    this.panel.querySelector('#btn-shelf-snap-ik-fk')?.addEventListener('click', () => {
      if (!this.rigSystem) return;
      const key = this.panel.querySelector('#sel-shelf-ik-chain')?.value || 'leftArm';
      this.rigSystem.snapIKToFK(key);
      const sl = this.panel.querySelector('#shelf-ik-blend');
      const lbl = this.panel.querySelector('#shelf-ik-blend-val');
      if (sl) sl.value = '1';
      if (lbl) lbl.textContent = '1.00';
    });
    this.panel.querySelector('#btn-shelf-snap-fk-ik')?.addEventListener('click', () => {
      if (!this.rigSystem) return;
      const key = this.panel.querySelector('#sel-shelf-ik-chain')?.value || 'leftArm';
      this.rigSystem.snapFKToIK(key);
      const sl = this.panel.querySelector('#shelf-ik-blend');
      const lbl = this.panel.querySelector('#shelf-ik-blend-val');
      if (sl) sl.value = '0';
      if (lbl) lbl.textContent = '0.00';
    });

    // Toggle Weight Paint
    this.panel.querySelector('#btn-toggle-weight-paint')?.addEventListener('click', () => {
      if (this.rigSystem) {
        let target = this.rigSystem.activeCharacter || (this.sceneManager ? this.sceneManager.getActiveObject() : null);
        const active = this.rigSystem.toggleWeightPaintMode(target);
        if (window.codeEditor) {
          window.codeEditor.log(
            'info',
            active
              ? '🎨 Weight Paint ENABLED: Drag on mesh to paint weights, click bones to switch!'
              : '🎨 Weight Paint DISABLED.'
          );
        }
      }
    });

    this.panel.querySelector('#wp-brush-mode')?.addEventListener('change', (e) => {
      this.rigSystem?.setWeightBrush({ mode: e.target.value });
    });
    this.panel.querySelector('#wp-brush-radius')?.addEventListener('input', (e) => {
      this.rigSystem?.setWeightBrush({ radius: parseFloat(e.target.value) });
    });
    this.panel.querySelector('#wp-brush-strength')?.addEventListener('input', (e) => {
      this.rigSystem?.setWeightBrush({ strength: parseFloat(e.target.value) });
    });
    this.panel.querySelector('#wp-brush-mirror')?.addEventListener('change', (e) => {
      this.rigSystem?.setWeightBrush({ symmetryX: !!e.target.checked });
    });
    this.panel.querySelector('#btn-wp-smooth-all')?.addEventListener('click', () => {
      this.rigSystem?.smoothWeights(this.rigSystem.weightPaintMesh, this.rigSystem.activeBone, 1, 0.5, true);
    });
    this.panel.querySelector('#btn-wp-normalize')?.addEventListener('click', () => {
      this.rigSystem?.normalizeWeights(this.rigSystem.weightPaintMesh, true);
    });
    this.panel.querySelector('#btn-wp-clean')?.addEventListener('click', () => {
      const res = this.rigSystem?.cleanWeights(this.rigSystem.weightPaintMesh, 0.01, 4, true);
      if (res && window.codeEditor) {
        window.codeEditor.log('info', `✂ Cleaned weights: ${res.cleanedVertices} vertices updated, ${res.removedSlots} tiny slots pruned.`);
      }
    });
    this.panel.querySelector('#btn-wp-mirror-x')?.addEventListener('click', () => {
      this.rigSystem?.mirrorWeightsX(this.rigSystem.weightPaintMesh, 'left', null, true);
    });
    this.panel.querySelector('#btn-wp-transfer')?.addEventListener('click', () => {
      if (!this.rigSystem) return;
      const targetMesh = this.sceneManager ? this.sceneManager.getActiveObject() : null;
      let sourceChar = this.rigSystem.activeCharacter;
      if (targetMesh && !targetMesh.isSkinnedMesh && targetMesh.isMesh && sourceChar) {
        const res = this.rigSystem.transferWeights(sourceChar, targetMesh, { recordUndo: true });
        if (res && this.sceneManager) this.sceneManager.select(res);
      } else if (window.codeEditor) {
        window.codeEditor.log('warn', '👔 Select an unrigged cloth/accessory Mesh (with an active rigged character) to transfer weights.');
      }
    });

    // Close Banner button
    this.panel.querySelector('#btn-close-banner')?.addEventListener('click', () => {
      const banner = this.panel.querySelector('#pose-shelf-banner');
      if (banner) banner.style.display = 'none';
    });

    // Save Custom Pose
    this.panel.querySelector('#btn-save-current-pose')?.addEventListener('click', () => {
      const name = prompt('Enter name for new character pose:', 'My Warrior Pose');
      if (name && this.rigSystem) {
        let target = this.rigSystem.activeCharacter || (this.sceneManager ? this.sceneManager.getActiveObject() : null);
        const key = this.rigSystem.saveCustomPose(name, target);
        if (key && window.codeEditor) {
          window.codeEditor.log('success', `✓ Saved new pose [${name}] to Pose Library!`);
        }
      }
    });

    // Mirror L ➔ R
    this.panel.querySelector('#btn-shelf-mirror')?.addEventListener('click', () => {
      if (this.rigSystem) {
        let target = this.rigSystem.activeCharacter || (this.sceneManager ? this.sceneManager.getActiveObject() : null);
        this.rigSystem.mirrorPose(target, 'left_to_right');
        if (window.codeEditor) {
          window.codeEditor.log('info', '🪞 Mirrored pose from Left to Right!');
        }
      }
    });

    // Reset Pose
    this.panel.querySelector('#btn-shelf-reset')?.addEventListener('click', () => {
      if (this.rigSystem) {
        let target = this.rigSystem.activeCharacter || (this.sceneManager ? this.sceneManager.getActiveObject() : null);
        this.rigSystem.resetPose(target, null);
        if (window.codeEditor) {
          window.codeEditor.log('info', '🔄 Reset all bone joints to Rest Pose!');
        }
      }
    });

    // Auto-Skinning
    this.panel.querySelector('#btn-shelf-auto-skin')?.addEventListener('click', () => {
      if (this.rigSystem) {
        let target = this.sceneManager ? this.sceneManager.getActiveObject() : null;
        if (!target || !target.isMesh) {
          if (window.codeEditor) {
            window.codeEditor.log('warn', '⚠️ Select a Mesh object in the scene before running Auto-Skin!');
          }
          return;
        }
        let sceneArmature = null;
        if (window.scene) {
          window.scene.traverse(o => {
            if (!sceneArmature && (o.userData?.isArmature || o.userData?.skeleton || o.isSkeleton)) {
              sceneArmature = o;
            }
          });
        }
        const mode = this.panel.querySelector('#sel-shelf-skin-mode')?.value || 'heat';
        const skinned = this.rigSystem.autoSkinMesh(target, sceneArmature, { mode });
        if (skinned && this.sceneManager) {
          this.sceneManager.select(skinned);
        }
      }
    });

    if (btnMin && body) {
      btnMin.addEventListener('click', () => {
        const isCollapsed = body.classList.toggle('collapsed');
        btnMin.textContent = isCollapsed ? '▲' : '_';
      });
    }
  }
}

export default PoseShelf;
